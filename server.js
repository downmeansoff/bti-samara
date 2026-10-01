'use strict';
// Zero-dependency static server for the dc-runtime landing page.
// Serves .dc.html, the .image-slots.state.json sidecar (a dotfile), and the
// pages at clean addresses ("/", "/mezhevanie"; old *.dc.html ones 301 there).
//
// Also serves the lead API (POST /api/lead) and the Telegram bot webhook
// (POST /tg/<TG_WEBHOOK_SECRET>) so requests from the lead form actually
// reach the cadastral engineer in Telegram. Both are additive — the static
// serving below is untouched.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const botUi = require('./bot-ui.js');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function contentType(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// Explicit allowlist of what this server will hand out over HTTP — mirrors
// the public file set pack-hosting.mjs copies for the reg.ru bundle, plus
// the .image-slots.state.json sidecar it deliberately leaves out of that
// bundle but that this server needs at runtime to render the current image
// slots. Anything else under ROOT (server.js, package.json, tests/,
// pack-hosting.mjs, CLAUDE.md, DEPLOY.bat, .git/, any other dotfile) must
// never be reachable — without this, the generic "serve any existing file"
// path below would hand all of that out to anonymous visitors too.
const PUBLIC_TOP_FILES = new Set([
  'support.js', 'image-slot.js', 'favicon.ico', 'robots.txt', 'sitemap.xml',
  '.image-slots.state.json',
]);

// Pages reachable at a clean address (/mezhevanie -> mezhevanie.dc.html);
// the home page is "/".
const PAGE_SLUGS = new Set(['mezhevanie', 'tehplan', 'razdel-obedinenie', 'politika']);

function isPubliclyServable(relPath) {
  const parts = relPath.split(path.sep).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) {
    const name = parts[0];
    if (name.toLowerCase().endsWith('.html')) return true;
    return PUBLIC_TOP_FILES.has(name);
  }
  return parts[0] === 'assets';
}

// ---------------------------------------------------------------------------
// Lead API + Telegram webhook
// ---------------------------------------------------------------------------

const LEAD_MAX_BODY_BYTES = 8 * 1024;
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024; // Telegram updates (captions, etc.) can be bigger than a lead.
const TG_REQUEST_TIMEOUT_MS = 10000;

const RATE_IP_MAX = 5;
const RATE_IP_WINDOW_MS = 10 * 60 * 1000;
const RATE_GLOBAL_MAX = 60;
const RATE_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

// Browser origins allowed to call /api/lead cross-origin: the future primary
// domain, the GitHub Pages mirror and the Railway fallback (which also serves
// itself, so it calls the relative path instead — see LeadModal.dc.html), plus
// localhost for local dev of the static pages against this server.
const ALLOWED_ORIGINS = new Set([
  'https://kadastrhelp.ru',
  'https://www.kadastrhelp.ru',
  'https://downmeansoff.github.io',
  'https://bti-samara-landing-production.up.railway.app',
  'http://localhost:3999',
  'http://127.0.0.1:3999',
]);

function corsHeaders(origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  return {};
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error('too_large'));
        // Don't destroy() here: req/res share one socket, and killing it while
        // the client is still mid-write turns into an ECONNRESET on their end
        // instead of the 400 we're about to send. Just stop buffering and let
        // the rest of the body drain; the response below closes the connection.
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function isTrustedRelay(req) {
  // The same-origin relay on kadastrhelp.ru (hosting/api/lead.php) posts from
  // the hosting server's one IP, so the visitor's address travels in
  // X-Lead-Client-IP. Honour it only next to the shared secret; without
  // LEAD_RELAY_SECRET set the headers are ignored entirely.
  // Trimmed like the PHP side trims ~/lead-relay.secret: a pasted trailing
  // newline must not silently turn every relayed lead into the hosting's IP.
  const secret = (process.env.LEAD_RELAY_SECRET || '').trim();
  const given = req.headers['x-lead-relay'];
  if (!secret || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getClientIp(req) {
  if (isTrustedRelay(req)) {
    const relayed = req.headers['x-lead-client-ip'];
    if (typeof relayed === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(relayed)) return relayed;
  }
  // Trust exactly one upstream hop: the platform's own edge proxy (Railway).
  // A reverse proxy APPENDS the address it actually saw on the TCP socket as
  // the LAST entry of X-Forwarded-For; every entry before that is whatever
  // the client chose to send and is not trustworthy. Taking the first entry
  // (as before) let anyone bypass the per-IP limiter just by sending a fresh
  // fake value on every request. Take the last entry instead — only the
  // proxy can write that position. No proxy in front (local dev) means no
  // XFF header at all, so fall back to the raw socket address.
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    // Loose IPv4/IPv6 sanity check so a malformed header can't smuggle an
    // arbitrary string in as the rate-limit key.
    if (last && /^[0-9a-fA-F:.]+$/.test(last)) return last;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const ipHits = new Map();
let globalHits = [];

function checkRateLimit(ip) {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < RATE_GLOBAL_WINDOW_MS);
  let hits = (ipHits.get(ip) || []).filter((t) => now - t < RATE_IP_WINDOW_MS);
  if (hits.length >= RATE_IP_MAX || globalHits.length >= RATE_GLOBAL_MAX) {
    // Don't leave a permanent entry for an IP that never actually got a hit
    // recorded (e.g. it was only ever rejected by the global cap) — that
    // would let the Map grow by one entry per distinct incoming IP forever.
    if (hits.length === 0) ipHits.delete(ip);
    else ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  globalHits.push(now);
  ipHits.set(ip, hits);
  return true;
}

// Belt-and-braces sweep: evict any IP whose hit window has fully expired, so
// the Map can't creep upward over a long-running process even under steady
// legitimate traffic from many distinct visitors.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) {
    const fresh = hits.filter((t) => now - t < RATE_IP_WINDOW_MS);
    if (fresh.length === 0) ipHits.delete(ip);
    else if (fresh.length !== hits.length) ipHits.set(ip, fresh);
  }
}, RATE_IP_WINDOW_MS).unref();

// The shared hourly cap alone (no IP hit recorded): the bot asks this before
// spending a lead, to tell "busy" (logged, client offered the contacts) from
// a per-chat refusal.
function globalCapReached() {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < RATE_GLOBAL_WINDOW_MS);
  return globalHits.length >= RATE_GLOBAL_MAX;
}

// One key's own 5-in-10-minutes window alone (nothing recorded): the bot asks
// it first, so a chat over that cap is told so rather than to wait a minute.
function keyCapReached(key) {
  const now = Date.now();
  return (ipHits.get(key) || []).filter((t) => now - t < RATE_IP_WINDOW_MS).length >= RATE_IP_MAX;
}

// The phone rule for every lead: the site form (validateLead) and the bot's
// phone step (typed or shared contact) both call this one function.
function phoneOk(raw) {
  const phone = typeof raw === 'string' ? raw.trim() : '';
  if (!phone || phone.length < 5 || phone.length > 25) return false;
  if (!/^[0-9+()\-\s]+$/.test(phone)) return false;
  return (phone.match(/\d/g) || []).length >= 5;
}

function validateLead(data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (name.length > 80) return { ok: false, reason: 'name' };

  const phone = typeof data.phone === 'string' ? data.phone.trim() : '';
  if (!phoneOk(phone)) return { ok: false, reason: 'phone' };

  const service = typeof data.service === 'string' ? data.service.trim() : '';
  if (service.length > 120) return { ok: false, reason: 'service' };

  const message = typeof data.message === 'string' ? data.message.trim() : '';
  if (message.length > 1000) return { ok: false, reason: 'message' };

  const page = typeof data.page === 'string' ? data.page.trim() : '';
  if (page.length > 200) return { ok: false, reason: 'page' };

  if (data.consent !== true) return { ok: false, reason: 'consent' };

  return { ok: true, lead: { name, phone, service, message, page } };
}

let leadCounter = 0;
function makeLeadId() {
  leadCounter += 1;
  return 'L' + Date.now().toString(36) + leadCounter.toString(36);
}

function phoneTelHref(phone) {
  const digits = phone.replace(/[^\d+]/g, '');
  return 'tel:' + digits;
}

function moscowTime() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date()) + ' МСК';
}

const TG_TEXT_LIMIT = 4096; // Telegram sendMessage hard cap; over this the whole call is rejected with 400.

// Already-escaped HTML cut to at most `budget` UTF-16 units, then "…" (text
// that fits is returned as is). The cut never ends inside an entity ("…&am")
// or between the halves of a surrogate pair (half an emoji): parse_mode=HTML
// rejects the whole message for either. The one cutter for leads and forwards.
function fitEscaped(escaped, budget) {
  if (escaped.length <= budget) return escaped;
  let out = escaped.slice(0, budget);
  const amp = out.lastIndexOf('&');
  if (amp !== -1 && out.indexOf(';', amp) === -1) out = out.slice(0, amp);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out + '…';
}

function buildLeadMessage(lead, opts) {
  opts = opts || {};
  const head = [(opts.emoji || '🆕') + ' <b>' + escapeHtml(opts.title || 'Заявка с сайта') + '</b>'];
  head.push('Имя: ' + (lead.name ? escapeHtml(lead.name) : '—'));
  head.push('Телефон: <a href="' + phoneTelHref(lead.phone) + '">' + escapeHtml(lead.phone) + '</a>');
  if (lead.service) head.push('Услуга: ' + escapeHtml(lead.service));

  const tail = [];
  if (lead.page && !opts.omitPage) tail.push('Страница: ' + escapeHtml(lead.page));
  if (opts.extra) for (const line of opts.extra) tail.push(line);
  tail.push('Время: ' + moscowTime());

  // A field that passed the (unescaped) length check in validateLead can
  // still blow past Telegram's 4096-char limit once HTML-escaped (e.g. a
  // message full of "&" expands 5x) — that would fail the entire send, not
  // just this field. Budget space for everything else first, then fit the
  // escaped message into what's left, truncating rather than failing.
  let messageLine = '';
  if (lead.message) {
    const withoutMessage = head.concat(['Сообщение: '], tail).join('\n').length;
    const budget = Math.max(0, TG_TEXT_LIMIT - withoutMessage - 1); // -1 margin for the ellipsis char
    messageLine = 'Сообщение: ' + fitEscaped(escapeHtml(lead.message), budget);
  }

  const lines = head.slice();
  if (messageLine) lines.push(messageLine);
  lines.push(...tail);
  return lines.join('\n');
}

function parseChatIds(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function telegramCall(method, payload) {
  const base = process.env.TG_API_BASE || 'https://api.telegram.org';
  const token = process.env.TG_BOT_TOKEN;
  const url = base + '/bot' + token + '/' + method;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body = null;
    try { body = await res.json(); } catch {}
    return { ok: res.ok && !!(body && body.ok), status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e && e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sendToChats(chatIds, text) {
  const results = await Promise.all(
    chatIds.map((chatId) => telegramCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }))
  );
  return { anyOk: results.some((r) => r.ok), results };
}

function logUndelivered(id, lead, reason, source) {
  const meta = { id, reason, time: new Date().toISOString() };
  if (source) meta.source = source;
  console.log('LEAD_UNDELIVERED ' + JSON.stringify(Object.assign(meta, lead)));
}

function sendJson(res, status, headers, obj) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
  res.end(JSON.stringify(obj));
}

async function handleLeadRoute(req, res) {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    }, cors));
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, cors, { ok: false, reason: 'method_not_allowed' });
    return;
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength && declaredLength > LEAD_MAX_BODY_BYTES) {
    // Don't destroy the socket while the client may still be writing the body
    // (see readBody below) — respond normally and let Node close the
    // connection after flushing instead of resetting it out from under them.
    sendJson(res, 400, Object.assign({ Connection: 'close' }, cors), { ok: false, reason: 'too_large' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req, LEAD_MAX_BODY_BYTES);
  } catch {
    sendJson(res, 400, Object.assign({ Connection: 'close' }, cors), { ok: false, reason: 'too_large' });
    return;
  }

  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, cors, { ok: false, reason: 'invalid_json' });
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    sendJson(res, 400, cors, { ok: false, reason: 'invalid_json' });
    return;
  }

  // Honeypot: real visitors never fill this hidden field. Pretend success,
  // send nothing, don't even bother validating the rest.
  if (typeof data.website === 'string' && data.website.trim() !== '') {
    sendJson(res, 200, cors, { ok: true });
    return;
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    sendJson(res, 429, cors, { ok: false, reason: 'rate_limited' });
    return;
  }

  const validated = validateLead(data);
  if (!validated.ok) {
    sendJson(res, 400, cors, { ok: false, reason: validated.reason });
    return;
  }

  const lead = validated.lead;
  const id = makeLeadId();
  const token = process.env.TG_BOT_TOKEN;
  const chatIds = parseChatIds(process.env.TG_LEAD_CHAT_IDS);
  if (!token || !chatIds.length) {
    logUndelivered(id, lead, 'not_configured');
    sendJson(res, 503, cors, { ok: false, reason: 'not_configured' });
    return;
  }

  const text = buildLeadMessage(lead);
  const delivery = await sendToChats(chatIds, text);
  if (delivery.anyOk) {
    console.log('LEAD_OK ' + id);
    sendJson(res, 200, cors, { ok: true, id });
  } else {
    logUndelivered(id, lead, 'telegram');
    sendJson(res, 502, cors, { ok: false, reason: 'telegram' });
  }
}

// Per-sender throttle for the webhook relay path, mirroring checkRateLimit()
// for /api/lead. Keyed by the Telegram chat id, which Telegram itself
// authenticates (unlike an HTTP header) so it can't be spoofed by rotating a
// request header the way X-Forwarded-For could.
const WEBHOOK_SENDER_MAX = 5;
const WEBHOOK_MENU_MAX = 40; // commands, button taps and in-flow typed replies: answered from memory, never forwarded (the final lead submit uses the stricter lead bucket below)
const WEBHOOK_SENDER_WINDOW_MS = 60 * 1000;
const DOCS_ALBUM_MAX = 3; // a:d albums per chat per minute: each makes Telegram fetch five photos from the site
const webhookSenderHits = new Map();
const webhookMenuHits = new Map();
const docsAlbumHits = new Map();

// Menu taps have their own bucket, so browsing /services and /contacts can't
// use up the few lead messages a visitor is allowed per minute.
function checkWebhookRateLimit(chatId, hitsByChat = webhookSenderHits, max = WEBHOOK_SENDER_MAX) {
  const now = Date.now();
  const key = String(chatId);
  let hits = (hitsByChat.get(key) || []).filter((t) => now - t < WEBHOOK_SENDER_WINDOW_MS);
  if (hits.length >= max) {
    if (hits.length === 0) hitsByChat.delete(key);
    else hitsByChat.set(key, hits);
    return false;
  }
  hits.push(now);
  hitsByChat.set(key, hits);
  return true;
}

function checkMenuRateLimit(chatId) {
  return checkWebhookRateLimit(chatId, webhookMenuHits, WEBHOOK_MENU_MAX);
}

function checkDocsAlbumLimit(chatId) {
  return checkWebhookRateLimit(chatId, docsAlbumHits, DOCS_ALBUM_MAX);
}

// Photos sent as one album arrive as separate updates sharing media_group_id.
// The first item spends a lead-bucket slot; up to nine more within two minutes
// ride along on it, and only the first gets the reply.
const ALBUM_MAX_ITEMS = 10;
const ALBUM_TTL_MS = 2 * 60 * 1000;
const ALBUM_FOLLOW_MAX = 20; // riders per chat per minute over all albums: rotating group ids can't multiply the allowance
const albums = new Map(); // "chat:group" -> { t, n }
const albumFollowHits = new Map();

// Only an album whose first item the lead bucket admitted (openAlbum) has riders:
// a refused first item leaves nothing behind, so the rest of its album is refused too.
function isAlbumFollowUp(chatId, groupId) {
  if (!groupId) return false;
  const a = albums.get(chatId + ':' + groupId);
  if (!a || Date.now() - a.t >= ALBUM_TTL_MS || a.n >= ALBUM_MAX_ITEMS) return false;
  if (!checkWebhookRateLimit(chatId, albumFollowHits, ALBUM_FOLLOW_MAX)) return false;
  a.n += 1;
  return true;
}

function openAlbum(chatId, groupId) {
  if (groupId) albums.set(chatId + ':' + groupId, { t: Date.now(), n: 1 });
}

// Of a photo the largest size, else the document / video / voice / ...: what getFile needs.
function mediaFileId(m) {
  const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null;
  const f = photo || m.document || m.video || m.voice || m.audio || m.video_note || m.animation || m.sticker;
  return f && f.file_id ? f.file_id : undefined;
}

// Something the client wrote or sent: text that is not just blanks, a caption,
// media, a contact, a place. Service messages (auto-delete timer, pinned
// message, chat title, background, ...) carry none of it and are ignored
// without a word: no forward, no reply, no rate-limit slot (FIXES G4).
const CLIENT_CONTENT_KEYS = ['photo', 'document', 'video', 'voice', 'audio', 'animation', 'video_note', 'sticker', 'contact', 'location', 'venue'];
function hasClientContent(m) {
  if (typeof m.text === 'string' && m.text.trim() !== '') return true;
  if (typeof m.caption === 'string' && m.caption.trim() !== '') return true;
  return CLIENT_CONTENT_KEYS.some((k) => m[k] !== undefined && m[k] !== null);
}

setInterval(() => {
  const now = Date.now();
  for (const hitsByChat of [webhookSenderHits, webhookMenuHits, albumFollowHits, docsAlbumHits]) {
    for (const [key, hits] of hitsByChat) {
      const fresh = hits.filter((t) => now - t < WEBHOOK_SENDER_WINDOW_MS);
      if (fresh.length === 0) hitsByChat.delete(key);
      else if (fresh.length !== hits.length) hitsByChat.set(key, fresh);
    }
  }
  for (const [key, a] of albums) if (now - a.t >= ALBUM_TTL_MS) albums.delete(key);
  for (const [key, state] of flowState) if (now - state.t >= BOT_FLOW_TTL_MS) flowState.delete(key);
}, WEBHOOK_SENDER_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// What a visitor sees in the bot: greeting with buttons, /services, /contacts.
// Phones, MAX links and email come from assets/contacts.js — the same file the
// pages read — so the bot can't drift from the site.
// ---------------------------------------------------------------------------

const SITE_URL = 'https://kadastrhelp.ru/';

function loadContacts() {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'assets', 'contacts.js'), 'utf8'), sandbox, { timeout: 1000 });
    return sandbox.window.BTI_CONTACTS || null;
  } catch (e) {
    console.error('contacts.js load failed:', e && e.message);
    return null;
  }
}
const CONTACTS = loadContacts();

// ---------------------------------------------------------------------------
// Bot I/O helpers: logging wrapper, retry wrapper, screen send/edit.
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Every bot-path Telegram call goes through here so failures get one log
// line (no payload, no token) without changing telegramCall's own semantics.
async function botCall(method, payload) {
  const r = await telegramCall(method, payload);
  if (!r.ok) {
    const desc = (r.body && r.body.description) || '';
    if (!desc.includes('message is not modified')) {
      console.log('BOT_TG_ERR ' + method + ' ' + r.status + ' ' + (desc || (r.error || '')));
    }
  }
  return r;
}

// Lead deliveries and forwards get one retry on 429 (honouring retry_after,
// capped at 3s) or a network error. Nothing else in the bot path retries.
async function botCallRetrying(method, payload) {
  let r = await botCall(method, payload);
  if (!r.ok && (r.status === 429 || r.status === 0)) {
    const retryAfter = r.body && r.body.parameters && r.body.parameters.retry_after;
    await sleep(Math.min(3000, Number(retryAfter || 1) * 1000));
    r = await botCall(method, payload);
  }
  return r;
}

function isOwnerChatId(chatId) {
  return parseChatIds(process.env.TG_LEAD_CHAT_IDS).includes(String(chatId));
}

// Telegram fetches the menu cover and the documents album photos by URL. The
// site's own host (shared hosting) refuses most of those fetches (live test
// 02.10), so they are served from this server: BOT_ASSET_ORIGIN, else the
// Railway public domain, else bot-ui.js falls back to the site URL.
const BOT_ASSET_ORIGIN = process.env.BOT_ASSET_ORIGIN
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/' : '');

function botCtx(chatId) {
  return { contacts: CONTACTS, isOwner: isOwnerChatId(chatId), assetOrigin: BOT_ASSET_ORIGIN };
}

function screenPayload(chatId, s) {
  const payload = { chat_id: chatId, text: s.text, parse_mode: 'HTML' };
  if (s.keyboard) payload.reply_markup = s.keyboard;
  if (s.linkPreview) payload.link_preview_options = s.linkPreview;
  return payload;
}

function sentMessageId(r) {
  return (r && r.ok && r.body && r.body.result && r.body.result.message_id) || null;
}

// A screen object as a new message; the new message's id, or null.
async function sendScreenObj(chatId, s) {
  return sentMessageId(await botCall('sendMessage', screenPayload(chatId, s)));
}

// Commands always send a new message (never edit one that may not exist).
async function sendScreen(chatId, route) {
  const s = botUi.screen(route, botCtx(chatId));
  if (s) await sendScreenObj(chatId, s);
}

// Button taps render in place. "message is not modified" (identical content,
// e.g. re-tapping the screen you're already on) is left alone; any other
// edit failure falls back to a new message. Returns the id of the message
// that shows the screen now (the edited one or the new one), or null.
async function editOrSend(chatId, messageId, s) {
  if (messageId) {
    const r = await botCall('editMessageText', Object.assign(screenPayload(chatId, s), { message_id: messageId }));
    if (r.ok) return messageId;
    const desc = (r.body && r.body.description) || '';
    if (desc.includes('message is not modified')) return messageId;
  }
  return sendScreenObj(chatId, s);
}

async function ack(cq, text) {
  const payload = { callback_query_id: cq.id };
  if (text) payload.text = text;
  await botCall('answerCallbackQuery', payload);
}

// Telegram takes a reply keyboard down only with a message that carries
// remove_keyboard — and such a message cannot carry inline buttons too.
async function dropReplyKeyboard(chatId, text) {
  await botCall('sendMessage', { chat_id: chatId, text, reply_markup: { remove_keyboard: true } });
}

async function handleDocumentsCallback(chatId) {
  const r = await botCall('sendMediaGroup', { chat_id: chatId, media: botUi.documentsMedia(BOT_ASSET_ORIGIN) });
  if (r.ok) await sendScreen(chatId, { type: 'documents' });
  else await sendScreenObj(chatId, botUi.documentsFallback());
}

// ---------------------------------------------------------------------------
// Lead-flow state: Map<chatId(string), {step, service, name, phone, comment,
// kb, back, promptId, oldPrompts, busyIds, failed, capLogged, t}>, swept by
// the rate-limit interval above.
//  step: service | name | phone | comment | confirm | edit | done
//  kb: the phone step's reply keyboard is on the client's screen. Whatever
//      ends the phone step or the flow takes it down (dropReplyKeyboard).
//  back: a field is being changed from the confirm screen ("Изменить"): the
//      accepted value returns to confirm instead of going to the next step.
//  promptId: the message showing the current step's prompt (its buttons are
//      cleared when the step moves on to a new message);
//  oldPrompts: this flow's earlier prompts (a tap there is a double tap).
//      Flow buttons act only on promptId / oldPrompts: on any other message
//      (a replaced flow's screen) they are stale.
//  busyIds: replies to submits the hourly cap or the chat's own cap refused;
//      their buttons do not end the flow (the confirm screen above stays usable).
//  failed: step done, but no lead chat took the lead (the client was shown
//      the contacts): nothing may claim it was sent.
//  capLogged: the lead last written to the log as refused by the hourly cap
//      (JSON): repeated taps on the same data add no new LEAD_UNDELIVERED line.
// One chat's updates are handled one at a time (enqueueUpdate below); every
// handler still writes the state before its first await.
// ---------------------------------------------------------------------------

const BOT_FLOW_TTL_MS = Number(process.env.BOT_FLOW_TTL_MS) || 30 * 60 * 1000; // env override is for tests only
const flowState = new Map();

// Lazy TTL: expire on read so BOT_FLOW_TTL_MS takes effect immediately
// (tests use a short override) instead of waiting for the periodic sweep,
// which still runs separately to clean up chats that never come back.
function getFlow(chatId) {
  const key = String(chatId);
  const state = flowState.get(key);
  if (state && Date.now() - state.t >= BOT_FLOW_TTL_MS) {
    flowState.delete(key);
    return undefined;
  }
  return state;
}

function newFlow(chatId, fields) {
  const state = Object.assign(
    { step: 'service', service: '', name: '', phone: '', comment: '', kb: false, back: false, promptId: null, oldPrompts: [], busyIds: [], failed: false, capLogged: '' },
    fields,
    { t: Date.now() }
  );
  flowState.set(String(chatId), state);
  return state;
}

// Changes a live flow in place; a flow that is gone stays gone.
function patchFlow(chatId, fields) {
  const state = getFlow(chatId);
  if (state) Object.assign(state, fields, { t: Date.now() });
  return state;
}

function endFlow(chatId) {
  const state = getFlow(chatId);
  flowState.delete(String(chatId));
  return state;
}

function setPrompt(chatId, messageId) {
  const state = getFlow(chatId);
  if (!state || !messageId || state.promptId === messageId) return;
  if (state.promptId) {
    state.oldPrompts.push(state.promptId);
    if (state.oldPrompts.length > 10) state.oldPrompts.shift();
  }
  state.promptId = messageId;
}

function ownsMessage(state, messageId) {
  return !!state && !!messageId && (state.promptId === messageId || state.oldPrompts.includes(messageId));
}

// The lead went out to at least one lead chat (a failed delivery is done too,
// but "already sent" would be a lie there).
function leadWasSent(state) {
  return !!state && state.step === 'done' && !state.failed;
}

// Best-effort clean-up when a step advances — ignore failures.
async function clearPromptKeyboard(chatId, messageId) {
  if (!messageId) return;
  await botCall('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

// A step prompt as a new message (typed input leaves no tapped message to
// edit); the buttons of the prompt it replaces are cleared first.
async function sendFlowPrompt(chatId, prompt, prevId) {
  await clearPromptKeyboard(chatId, prevId);
  setPrompt(chatId, await sendScreenObj(chatId, prompt));
}

// A step prompt in place of the tapped message (a new message when the edit
// fails — then that one is the prompt).
async function showFlowPrompt(chatId, messageId, prompt) {
  setPrompt(chatId, await editOrSend(chatId, messageId, prompt));
}

// The phone step needs a reply keyboard, which editMessageText cannot attach:
// clear the previous prompt's inline buttons, then send the phone prompt.
async function sendPhonePrompt(chatId, prevId) {
  await clearPromptKeyboard(chatId, prevId);
  const prompt = botUi.leadFlow.phonePrompt();
  const r = await botCall('sendMessage', {
    chat_id: chatId,
    text: prompt.text,
    parse_mode: 'HTML',
    reply_markup: prompt.replyKeyboard,
    link_preview_options: { is_disabled: true },
  });
  setPrompt(chatId, sentMessageId(r));
}

// Navigation and commands end an open flow without a word — unless the
// phone step's reply keyboard is up: then "Заявка отменена." takes it down.
// Split in two so a handler can end the flow before its first await.
async function afterFlowEnded(chatId, ended) {
  if (ended && ended.kb) await dropReplyKeyboard(chatId, botUi.leadFlow.CANCELLED_TEXT);
}

async function cancelActiveFlow(chatId) {
  await afterFlowEnded(chatId, endFlow(chatId));
}

// Typed "Отмена" / /cancel, on any step, and also with no flow left (expired
// or lost on a restart while its reply keyboard is still on screen): never
// forwarded; the keyboard is taken down and the menu follows.
async function cancelTyped(chatId) {
  const lf = botUi.leadFlow;
  const state = endFlow(chatId);
  const done = !!state && state.step === 'done';
  if (state && !state.kb && !done) await clearPromptKeyboard(chatId, state.promptId);
  await dropReplyKeyboard(chatId, leadWasSent(state) ? lf.ALREADY_SENT_TEXT : lf.CANCELLED_TEXT);
  await sendScreen(chatId, { type: 'menu' });
}

// l, l:<id>, /request, /start request: a new flow replaces whatever was open.
// With the phone step's reply keyboard up, "Начинаем заново." takes it down
// first and the new flow starts in a new message under it; otherwise the
// tapped message turns into the first prompt.
// beginLeadFlow switches the state (no await); showLeadStart draws it.
function beginLeadFlow(chatId, from, svcIdx) {
  const lf = botUi.leadFlow;
  const prev = endFlow(chatId);
  const withService = typeof svcIdx === 'number';
  const state = newFlow(chatId, withService ? { step: 'name', service: lf.leadServiceLabel(svcIdx) } : { step: 'service' });
  return {
    restartKb: !!(prev && prev.kb),
    prompt: withService ? lf.namePrompt({ from, service: state.service }) : lf.servicePickerPrompt(),
  };
}

async function showLeadStart(chatId, start, messageId) {
  if (start.restartKb) await dropReplyKeyboard(chatId, botUi.leadFlow.RESTART_TEXT);
  if (messageId && !start.restartKb) await showFlowPrompt(chatId, messageId, start.prompt);
  else await sendFlowPrompt(chatId, start.prompt, null);
}

async function startLeadFlow(chatId, from, svcIdx, messageId) {
  await showLeadStart(chatId, beginLeadFlow(chatId, from, svcIdx), messageId);
}

// The phone step's value: the sender's own shared contact or a typed number,
// normalized, then the same phoneOk() check /api/lead applies. null when it
// does not pass (someone else's contact included).
function acceptPhone(message, from) {
  const lf = botUi.leadFlow;
  const contact = message.contact;
  let phone;
  if (contact && contact.phone_number) {
    const fromId = from && from.id;
    if (contact.user_id !== undefined && contact.user_id !== null && String(contact.user_id) !== String(fromId)) return null;
    phone = lf.contactPhone(String(contact.phone_number));
  } else {
    phone = lf.normalizePhone(typeof message.text === 'string' ? message.text : '');
  }
  return phoneOk(phone) ? phone : null;
}

// What the current step takes from a message: text on the name / phone /
// comment steps, a shared contact on the phone step. Everything else (text
// on the button-only steps, photos, files, a contact elsewhere) is not flow
// input: it goes the ordinary forward way and the flow stays where it is.
function stepTakesMessage(state, message) {
  const hasText = typeof message.text === 'string' && message.text.trim() !== '';
  if (state.step === 'name' || state.step === 'comment') return hasText;
  if (state.step === 'phone') return hasText || !!(message.contact && message.contact.phone_number);
  return false;
}

async function handleFlowMessage(chatId, message, state, from) {
  const lf = botUi.leadFlow;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const prevId = state.promptId;

  if (state.step === 'name') {
    const v = lf.validateName(text);
    if (!v.ok) {
      await sendFlowPrompt(chatId, lf.namePrompt({ from, service: state.service }, { retry: true }), prevId);
      return;
    }
    if (state.back) {
      patchFlow(chatId, { name: v.value, step: 'confirm', back: false });
      await sendFlowPrompt(chatId, lf.confirmPrompt(state), prevId);
      return;
    }
    patchFlow(chatId, { name: v.value, step: 'phone', kb: true });
    await sendPhonePrompt(chatId, prevId);
    return;
  }

  if (state.step === 'phone') {
    const phone = acceptPhone(message, from);
    if (!phone) {
      // The step stays, and so does its reply keyboard.
      await botCall('sendMessage', { chat_id: chatId, text: lf.PHONE_INVALID_TEXT });
      return;
    }
    const back = state.back;
    patchFlow(chatId, { phone, kb: false, step: back ? 'confirm' : 'comment', back: false });
    await botCall('sendMessage', { chat_id: chatId, text: lf.phoneSetText(phone), reply_markup: { remove_keyboard: true } });
    await sendFlowPrompt(chatId, back ? lf.confirmPrompt(state) : lf.commentPrompt(), null);
    return;
  }

  if (state.step === 'comment') {
    const v = lf.validateComment(text);
    if (!v.ok) {
      await sendFlowPrompt(chatId, lf.commentPrompt({ tooLong: true }), prevId);
      return;
    }
    patchFlow(chatId, { comment: v.value, step: 'confirm', back: false });
    await sendFlowPrompt(chatId, lf.confirmPrompt(state), prevId);
  }
}

// A refusal's reply (hourly cap, the chat's own cap): its buttons do not end
// the flow — the confirm screen above it stays usable for a later retry.
async function sendRefusalScreen(chatId, s) {
  const id = await sendScreenObj(chatId, s);
  const live = id ? getFlow(chatId) : null;
  if (live) {
    live.busyIds.push(id);
    if (live.busyIds.length > 5) live.busyIds.shift();
  }
}

// l:ok — the only flow step with a side effect. Refusals keep the confirm
// step (a later tap is a real retry); a send marks the flow done before the
// first await (the double-tap guard).
async function handleLeadSubmit(cq, chatId, messageId, state) {
  const lf = botUi.leadFlow;
  const snapshot = { service: state.service, name: state.name, phone: state.phone, comment: state.comment };
  const payload = lf.buildLeadPayload(snapshot);
  const isOwnerChat = isOwnerChatId(chatId);

  // The chat's own cap (5 leads in 10 minutes) is looked at first: when it
  // binds, waiting a minute would not help, and the minute bucket is spared.
  let refusal = null;
  if (!isOwnerChat) {
    if (keyCapReached('tg:' + chatId)) refusal = 'chatCap';
    else if (!checkWebhookRateLimit(chatId)) refusal = 'minute';
    else if (globalCapReached()) refusal = 'busy';
    else if (!checkRateLimit('tg:' + chatId)) refusal = 'chatCap';
  }
  if (refusal === 'busy') {
    // The hourly cap shared with the site form is full: the lead goes to the
    // log like any other undelivered one — once per flow, and once more only
    // if the client changed it since — and the client gets another way in.
    const v = validateLead(Object.assign({}, payload, { consent: true }));
    const lead = v.ok ? v.lead : payload;
    const key = JSON.stringify(lead);
    if (state.capLogged !== key) {
      patchFlow(chatId, { capLogged: key });
      logUndelivered(makeLeadId(), lead, 'rate_limited', 'bot');
    }
    await ack(cq);
    await sendRefusalScreen(chatId, lf.busyScreen());
    return;
  }
  if (refusal === 'chatCap') {
    await ack(cq);
    await sendRefusalScreen(chatId, lf.chatCapScreen());
    return;
  }
  if (refusal) {
    await ack(cq);
    await botCall('sendMessage', { chat_id: chatId, text: 'Слишком часто. Подождите минуту.' });
    return;
  }

  patchFlow(chatId, { step: 'done' });
  await ack(cq);

  // consent: true is set here only: the confirm screen's consent button is
  // the one way a bot lead is sent.
  const validated = validateLead(Object.assign({}, payload, { consent: true }));
  const id = makeLeadId();
  const targetChatIds = isOwnerChat ? [String(chatId)] : parseChatIds(process.env.TG_LEAD_CHAT_IDS);

  let anyOk = false;
  if (validated.ok && targetChatIds.length) {
    const extra = [lf.telegramUserLine(cq.from), lf.CONSENT_LEAD_LINE];
    const opts = isOwnerChat
      ? { emoji: '🧪', title: 'Тестовая заявка из бота', extra, omitPage: true }
      : { title: 'Заявка из бота', extra, omitPage: true };
    const text = buildLeadMessage(validated.lead, opts);
    const sends = await Promise.all(targetChatIds.map((cid) => botCallRetrying('sendMessage', { chat_id: cid, text, parse_mode: 'HTML' })));
    anyOk = sends.some((r) => r.ok);
  }

  if (anyOk) {
    console.log('BOT_LEAD_OK ' + id);
    const doneScreen = isOwnerChat ? lf.ownerSentText(snapshot) : lf.sentText(snapshot);
    setPrompt(chatId, await editOrSend(chatId, messageId, doneScreen));
  } else {
    // Still done (no second attempt: a send that timed out may have arrived
    // after all), but marked so no later tap or cancel says "already sent".
    patchFlow(chatId, { failed: true });
    const reason = !validated.ok ? 'validation' : (targetChatIds.length ? 'telegram' : 'not_configured');
    logUndelivered(id, validated.ok ? validated.lead : payload, reason, 'bot');
    await editOrSend(chatId, messageId, botUi.leadUndeliveredScreen(CONTACTS));
  }
}

// Whether a flow button fits the step the flow is on.
function routeFitsStep(r, state, from) {
  switch (r.type) {
    case 'leadOption': return state.step === 'service';
    case 'leadUseName': return state.step === 'name' && botUi.leadFlow.telegramName(from) !== '';
    case 'leadSkip': return state.step === 'comment';
    case 'leadConfirm':
    case 'leadEditMenu': return state.step === 'confirm';
    case 'leadEditField':
    case 'leadBack': return state.step === 'edit';
    default: return false; // leadUnknown
  }
}

// Routes starting with "l" (SPEC section 4, FIXES U4/U13, G1/G2). Start,
// restart and cancel always work. Once the lead is sent, every other flow
// button only answers "already sent". Before that a button acts only on a
// message this flow showed (promptId / oldPrompts) and only on its own step:
// on any other message it is stale (toast plus the menu in place of the
// tapped message) — what that screen shows is not the data in the flow;
// on this flow's message but not its step it is a double tap (acknowledged
// silently).
async function handleFlowCallback(cq, chatId, messageId, r) {
  const lf = botUi.leadFlow;
  const from = cq.from || {};

  if (r.type === 'leadStart' || r.type === 'leadStartService') {
    const svcIdx = r.type === 'leadStartService' ? lf.SERVICE_ID_TO_LM_INDEX[r.id] : undefined;
    const start = beginLeadFlow(chatId, from, svcIdx);
    await ack(cq);
    await showLeadStart(chatId, start, messageId);
    return;
  }

  if (r.type === 'leadCancel') {
    const state = endFlow(chatId);
    await ack(cq, leadWasSent(state) ? lf.ALREADY_SENT_TEXT : lf.CANCELLED_TEXT);
    if (state && state.kb) await dropReplyKeyboard(chatId, lf.CANCELLED_TEXT);
    await editOrSend(chatId, messageId, botUi.screen({ type: 'menu' }, botCtx(chatId)));
    return;
  }

  const state = getFlow(chatId);
  if (state && state.step === 'done') {
    // The screen that says where the lead went stays as it is. After a
    // failed delivery that screen already gives the contacts: no toast.
    await ack(cq, state.failed ? undefined : lf.ALREADY_SENT_TEXT);
    return;
  }
  if (!ownsMessage(state, messageId)) {
    await ack(cq, lf.STALE_TEXT);
    await editOrSend(chatId, messageId, botUi.screen({ type: 'menu' }, botCtx(chatId)));
    return;
  }
  if (!routeFitsStep(r, state, from)) {
    await ack(cq);
    if (messageId !== state.promptId) await clearPromptKeyboard(chatId, messageId);
    return;
  }

  switch (r.type) {
    case 'leadOption': {
      const back = state.back;
      patchFlow(chatId, { service: lf.leadServiceLabel(r.n), step: back ? 'confirm' : 'name', back: false });
      await ack(cq);
      await showFlowPrompt(chatId, messageId, back ? lf.confirmPrompt(state) : lf.namePrompt({ from, service: state.service }));
      return;
    }
    case 'leadUseName': {
      const name = lf.telegramName(from);
      if (state.back) {
        patchFlow(chatId, { name, step: 'confirm', back: false });
        await ack(cq);
        await showFlowPrompt(chatId, messageId, lf.confirmPrompt(state));
        return;
      }
      patchFlow(chatId, { name, step: 'phone', kb: true });
      await ack(cq);
      await sendPhonePrompt(chatId, messageId);
      return;
    }
    case 'leadSkip': // in the edit mode too: "Пропустить" means no comment
      patchFlow(chatId, { comment: '', step: 'confirm', back: false });
      await ack(cq);
      await showFlowPrompt(chatId, messageId, lf.confirmPrompt(state));
      return;
    case 'leadConfirm':
      await handleLeadSubmit(cq, chatId, messageId, state);
      return;
    case 'leadEditMenu':
      patchFlow(chatId, { step: 'edit' });
      await ack(cq);
      await showFlowPrompt(chatId, messageId, lf.editMenuPrompt());
      return;
    case 'leadBack':
      patchFlow(chatId, { step: 'confirm' });
      await ack(cq);
      await showFlowPrompt(chatId, messageId, lf.confirmPrompt(state));
      return;
    case 'leadEditField':
      if (r.field === 'phone') {
        patchFlow(chatId, { step: 'phone', back: true, kb: true });
        await ack(cq);
        await sendPhonePrompt(chatId, messageId);
        return;
      }
      if (r.field === 'service') patchFlow(chatId, { step: 'service', back: true });
      else if (r.field === 'name') patchFlow(chatId, { step: 'name', back: true });
      else patchFlow(chatId, { step: 'comment', back: true });
      await ack(cq);
      await showFlowPrompt(chatId, messageId,
        r.field === 'service' ? lf.servicePickerPrompt()
          : r.field === 'name' ? lf.namePrompt({ from, service: state.service })
            : lf.commentPrompt());
      return;
    default:
      await ack(cq);
  }
}

// Navigation ends an open flow (no await here), except from the buttons of
// a "busy" reply to a refused submit: the confirm screen above it stays usable.
function endFlowForNavigation(chatId, messageId) {
  const state = getFlow(chatId);
  if (!state || state.busyIds.includes(messageId)) return null;
  return endFlow(chatId);
}

// Chat checks and the menu bucket already ran on arrival (dispatchUpdate).
async function processCallback(cq, chatId) {
  const messageId = cq.message.message_id;
  const r = botUi.route(String(cq.data || ''));

  if (botUi.isFlowRoute(r)) {
    await handleFlowCallback(cq, chatId, messageId, r);
    return;
  }
  if (r && r.type === 'documents') {
    if (!checkDocsAlbumLimit(chatId)) {
      await ack(cq, 'Слишком часто. Подождите минуту.');
      return;
    }
    const ended = endFlowForNavigation(chatId, messageId);
    await ack(cq);
    await afterFlowEnded(chatId, ended);
    await handleDocumentsCallback(chatId);
    return;
  }

  const s = r ? botUi.screen(r, botCtx(chatId)) : null;
  if (!s) {
    await ack(cq, 'Кнопка устарела. Откройте меню: /start');
    return;
  }
  const ended = endFlowForNavigation(chatId, messageId);
  await ack(cq);
  await afterFlowEnded(chatId, ended);
  await editOrSend(chatId, messageId, s);
}

// The header of a client message forwarded to the lead chats: the profile
// name, then the bot lead's own "Telegram:" line (tg://user link, @username).
function forwardHeaderLines(from) {
  const f = from && typeof from === 'object' ? from : {};
  const fullName = [f.first_name, f.last_name].filter(Boolean).join(' ');
  const lines = ['💬 <b>Сообщение в боте</b>'];
  if (fullName) lines.push('Имя: ' + escapeHtml(fullName));
  lines.push(botUi.leadFlow.telegramUserLine(f));
  return lines;
}

async function processMessage(message, chatId) {
  const lf = botUi.leadFlow;
  const leadChatIds = parseChatIds(process.env.TG_LEAD_CHAT_IDS);
  const isOwnerChat = leadChatIds.includes(String(chatId));
  const text = typeof message.text === 'string' ? message.text : '';
  const from = message.from || {};
  const isCommand = text.charAt(0) === '/';
  const cancelWord = !isCommand && lf.isCancelText(text);
  const state = getFlow(chatId);
  const flowInput = !isCommand && !cancelWord && !!state && state.step !== 'done' && stepTakesMessage(state, message);

  // Commands, the cancel word and flow input are answered from memory and
  // draw on the menu bucket. Anything else may reach the engineer: the
  // stricter lead bucket, the rest of an album riding on its first item —
  // whether a flow is open or not (it neither ends nor advances).
  const cheap = isCommand || cancelWord || flowInput;
  const albumRest = !cheap && !isOwnerChat && isAlbumFollowUp(chatId, message.media_group_id);
  if (!isOwnerChat && !albumRest) {
    if (!(cheap ? checkMenuRateLimit(chatId) : checkWebhookRateLimit(chatId))) return;
    if (!cheap) openAlbum(chatId, message.media_group_id);
  }

  if (text === '/start' || text.indexOf('/start ') === 0) {
    const payload = text.length > 6 ? text.slice(6).trim() : '';
    const ownerCode = process.env.TG_OWNER_CODE;
    if (payload && ownerCode && payload === ownerCode) {
      await telegramCall('sendMessage', { chat_id: chatId, text: 'Готово. Сюда будут приходить заявки с сайта.' });
      console.log('OWNER_REGISTER chat=' + chatId);
      return;
    }
    if (isOwnerChat) {
      await cancelActiveFlow(chatId);
      await botCall('sendMessage', {
        chat_id: chatId,
        text: 'Сюда уже приходят заявки с сайта и из бота. Чтобы увидеть бота глазами клиента, нажмите «Оставить заявку» — тестовая заявка придёт только вам.',
      });
      await sendScreen(chatId, { type: 'menu' });
      return;
    }
    const r = payload ? botUi.startPayloadRoute(payload) : { type: 'menu' };
    if (r.type === 'leadStart') { await startLeadFlow(chatId, from, undefined, null); return; }
    await cancelActiveFlow(chatId);
    await sendScreen(chatId, r);
    return;
  }

  if (isCommand) {
    const command = text.slice(1).split(/\s/)[0].split('@')[0].toLowerCase();
    if (command === 'cancel') { await cancelTyped(chatId); return; }
    if (command === 'request') { await startLeadFlow(chatId, from, undefined, null); return; }
    await cancelActiveFlow(chatId);
    await sendScreen(chatId, botUi.commandRoute(command));
    return;
  }

  if (cancelWord) { await cancelTyped(chatId); return; }
  if (flowInput) { await handleFlowMessage(chatId, message, state, from); return; }

  // Chats already collecting leads (the owner) chatting with the bot outside
  // a flow — never loop their own messages back into the lead chats.
  if (isOwnerChat) return;

  // Who wrote it, on every forward: the same "Telegram:" line a bot lead has,
  // so a client with no username who left no phone can still be reached.
  // Text travels in one message under this header; a photo, file or contact
  // is forwarded right after it (the rest of an album rides on its first item,
  // without a header of its own).
  const header = forwardHeaderLines(from);
  let results = []; // empty when no lead chat is registered yet: handled as undelivered below
  if (text) {
    // Header + text must stay under Telegram's cap once escaped, or the whole
    // send is rejected and the lead is lost — fit the text into what is left.
    const budget = Math.max(0, TG_TEXT_LIMIT - header.join('\n').length - 2);
    const forwardText = header.concat([fitEscaped(escapeHtml(text), budget)]).join('\n');
    results = await Promise.all(leadChatIds.map((cid) => botCallRetrying('sendMessage', { chat_id: cid, text: forwardText, parse_mode: 'HTML' })));
  } else {
    const headerText = albumRest ? '' : header.join('\n');
    results = await Promise.all(leadChatIds.map(async (cid) => {
      if (headerText) await botCallRetrying('sendMessage', { chat_id: cid, text: headerText, parse_mode: 'HTML' });
      return botCallRetrying('forwardMessage', { chat_id: cid, from_chat_id: chatId, message_id: message.message_id });
    }));
  }

  if (!results.some((r) => r.ok)) {
    // Same safety net as the site form: what the visitor sent lands in the log (for media the
    // caption and file id, enough to fetch it with the Bot API), and the visitor is told to
    // reach the engineer directly instead of being told it went through.
    console.log('BOT_UNDELIVERED ' + JSON.stringify({
      chat: chatId,
      username: message.from && message.from.username,
      text: text || message.caption || '(non-text message)',
      message_id: message.message_id,
      media_group_id: message.media_group_id,
      file_id: mediaFileId(message),
      time: new Date().toISOString(),
    }));
    if (!albumRest) await sendScreenObj(chatId, botUi.forwardUndeliveredScreen(CONTACTS));
    return;
  }

  if (albumRest) return;
  // Text, photo, file or contact: one reply. A shared contact most likely
  // came from the phone step's reply keyboard after its flow was gone, so
  // its reply takes that keyboard down instead of carrying buttons.
  const reply = lf.forwardAck(!!message.contact);
  await botCall('sendMessage', { chat_id: chatId, text: reply.text, reply_markup: reply.replyMarkup, link_preview_options: { is_disabled: true } });
}

// ---------------------------------------------------------------------------
// One chat's updates run one at a time, in arrival order, so a slow Telegram
// answer cannot let a later tap or "/cancel" act on half-changed state. At
// most CHAT_QUEUE_MAX wait per chat; more are dropped without a word (the
// same silence as the rate limits). A failed update does not stop the ones
// queued after it. Updates without a chat are handled directly, as before.
// ---------------------------------------------------------------------------

const CHAT_QUEUE_MAX = 20;
const chatQueues = new Map(); // chatId -> { tail, waiting }

function logUpdateError(e) {
  console.error('webhook processUpdate error:', e);
}

function enqueueForChat(chatId, job) {
  const key = String(chatId);
  let q = chatQueues.get(key);
  if (!q) {
    q = { tail: Promise.resolve(), waiting: 0 };
    chatQueues.set(key, q);
  }
  if (q.waiting >= CHAT_QUEUE_MAX) return q.tail;
  q.waiting += 1;
  const run = q.tail
    .then(() => { q.waiting -= 1; return job(); })
    .catch(logUpdateError)
    .then(() => { if (q.tail === run && chatQueues.get(key) === q) chatQueues.delete(key); });
  q.tail = run;
  return run;
}

function dispatchUpdate(update) {
  const cq = update && update.callback_query;
  if (cq) {
    const chat = cq.message && cq.message.chat;
    if (!chat || chat.id === undefined || chat.id === null || (chat.type && chat.type !== 'private')) {
      return ack(cq).catch(logUpdateError);
    }
    // The menu bucket counts taps as they arrive, queued or not.
    if (!isOwnerChatId(chat.id) && !checkMenuRateLimit(chat.id)) {
      return ack(cq, 'Слишком часто. Подождите минуту.').catch(logUpdateError);
    }
    return enqueueForChat(chat.id, () => processCallback(cq, chat.id));
  }
  const message = update && update.message;
  if (!message || !message.chat || message.chat.id === undefined || message.chat.id === null) return Promise.resolve();
  // Only relay/react to 1:1 chats with the bot. Group/supergroup/channel
  // updates (bot added to a group, privacy mode off, etc.) are never leads —
  // don't forward ordinary group chatter into the owner's lead chats or
  // reply into the group as if it were a customer conversation.
  if (message.chat.type && message.chat.type !== 'private') return Promise.resolve();
  if (!hasClientContent(message)) return Promise.resolve();
  return enqueueForChat(message.chat.id, () => processMessage(message, message.chat.id));
}

async function handleWebhookRoute(req, res, secretFromPath) {
  const expectedSecret = process.env.TG_WEBHOOK_SECRET;
  const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (req.method !== 'POST' || !expectedSecret || secretFromPath !== expectedSecret || headerSecret !== expectedSecret) {
    res.writeHead(404).end();
    return;
  }

  let raw;
  try {
    raw = await readBody(req, WEBHOOK_MAX_BODY_BYTES);
  } catch {
    res.writeHead(200).end('ok');
    return;
  }

  let update;
  try {
    update = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(200).end('ok');
    return;
  }

  // Respond to Telegram immediately: the spec requires a fast 200, and
  // Telegram retries the same update if the response is slow, which without
  // update_id de-duplication would relay/reply twice for one message.
  // Process the update fire-and-forget instead of awaiting it here.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ok');
  try {
    dispatchUpdate(update);
  } catch (e) {
    logUpdateError(e);
  }
}

// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let urlPath, search;
  try {
    const u = new URL(req.url, 'http://x');
    urlPath = decodeURIComponent(u.pathname);
    search = u.search;
    // A decoded NUL makes fs.stat() throw synchronously, outside any handler: process exit.
    if (urlPath.indexOf('\0') !== -1) throw new Error('NUL in path');
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (urlPath === '/api/lead') {
    handleLeadRoute(req, res).catch((e) => {
      console.error('lead route error:', e);
      if (!res.headersSent) sendJson(res, 500, {}, { ok: false, reason: 'server_error' });
    });
    return;
  }

  if (urlPath.indexOf('/tg/') === 0) {
    handleWebhookRoute(req, res, urlPath.slice(4)).catch((e) => {
      console.error('webhook route error:', e);
      if (!res.headersSent) res.writeHead(200).end('ok');
    });
    return;
  }

  // Clean page addresses: "/" and "/mezhevanie" serve the page files; the old
  // file-name addresses (and a trailing slash) answer 301 to them, so bookmarks
  // and the search index follow. Same rules as the reg.ru .htaccess written by
  // pack-hosting.mjs.
  const oldPage = /^\/(index|mezhevanie|tehplan|razdel-obedinenie|politika)(?:\.dc)?\.html$/.exec(urlPath)
    || /^\/(mezhevanie|tehplan|razdel-obedinenie|politika)\/$/.exec(urlPath);
  if (oldPage) {
    res.writeHead(301, { Location: (oldPage[1] === 'index' ? '/' : '/' + oldPage[1]) + search }).end();
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.dc.html';
  else if (PAGE_SLUGS.has(urlPath.slice(1))) urlPath += '.dc.html';

  // Resolve safely inside ROOT (block path traversal).
  const target = path.normalize(path.join(ROOT, urlPath));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!isPubliclyServable(path.relative(ROOT, target))) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<!doctype html><meta charset=utf-8><h1>404</h1><a href="/">На главную</a>');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset=utf-8><h1>404</h1><a href="/">На главную</a>');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isAsset = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg', '.ico', '.woff2'].includes(ext);
    res.writeHead(200, {
      'Content-Type': contentType(target),
      // Images/fonts cache for a day; HTML/JS/JSON always revalidate so edits show immediately.
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache, must-revalidate',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, () => console.log('bti-samara static server on :' + PORT));
