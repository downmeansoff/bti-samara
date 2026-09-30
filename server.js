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

function validateLead(data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (name.length > 80) return { ok: false, reason: 'name' };

  const phone = typeof data.phone === 'string' ? data.phone.trim() : '';
  if (!phone || phone.length < 5 || phone.length > 25) return { ok: false, reason: 'phone' };
  if (!/^[0-9+()\-\s]+$/.test(phone)) return { ok: false, reason: 'phone' };
  const digitCount = (phone.match(/\d/g) || []).length;
  if (digitCount < 5) return { ok: false, reason: 'phone' };

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

function buildLeadMessage(lead) {
  const head = ['🆕 <b>Заявка с сайта</b>'];
  head.push('Имя: ' + (lead.name ? escapeHtml(lead.name) : '—'));
  head.push('Телефон: <a href="' + phoneTelHref(lead.phone) + '">' + escapeHtml(lead.phone) + '</a>');
  if (lead.service) head.push('Услуга: ' + escapeHtml(lead.service));

  const tail = [];
  if (lead.page) tail.push('Страница: ' + escapeHtml(lead.page));
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
    let text = escapeHtml(lead.message);
    if (text.length > budget) {
      text = text.slice(0, budget);
      // Don't leave a truncated, unterminated HTML entity (e.g. "...&am") —
      // parse_mode=HTML would reject the whole message for that too.
      const amp = text.lastIndexOf('&');
      if (amp !== -1 && text.indexOf(';', amp) === -1) text = text.slice(0, amp);
      text += '…';
    }
    messageLine = 'Сообщение: ' + text;
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

function logUndelivered(id, lead, reason) {
  console.log('LEAD_UNDELIVERED ' + JSON.stringify(Object.assign({ id, reason, time: new Date().toISOString() }, lead)));
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
const WEBHOOK_MENU_MAX = 20; // commands and button taps: answered from memory, never forwarded
const WEBHOOK_SENDER_WINDOW_MS = 60 * 1000;
const webhookSenderHits = new Map();
const webhookMenuHits = new Map();

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

// Photos sent as one album arrive as separate updates sharing media_group_id.
// The first item spends a lead-bucket slot; up to nine more within two minutes
// ride along on it, and only the first gets the thank-you reply.
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

setInterval(() => {
  const now = Date.now();
  for (const hitsByChat of [webhookSenderHits, webhookMenuHits, albumFollowHits]) {
    for (const [key, hits] of hitsByChat) {
      const fresh = hits.filter((t) => now - t < WEBHOOK_SENDER_WINDOW_MS);
      if (fresh.length === 0) hitsByChat.delete(key);
      else if (fresh.length !== hits.length) hitsByChat.set(key, fresh);
    }
  }
  for (const [key, a] of albums) if (now - a.t >= ALBUM_TTL_MS) albums.delete(key);
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

const BOT_MENU = {
  inline_keyboard: [
    [{ text: 'Услуги и цены', callback_data: 'services' }, { text: 'Контакты', callback_data: 'contacts' }],
    [{ text: 'Открыть сайт', url: SITE_URL }],
  ],
};

const BOT_GREETING = [
  '<b>Здравствуйте!</b> Это бот кадастрового инженера Баймурзина Азата Ринатовича — межевание, технические планы, раздел и объединение участков в Самарской области и Республике Башкортостан.',
  '',
  'Напишите здесь, что нужно сделать, и оставьте номер телефона — сообщение сразу получит инженер и свяжется с вами. Можно приложить фото документов или выписку из ЕГРН.',
  '',
  'Консультация — бесплатно.',
].join('\n');

const BOT_SERVICES = [
  '<b>Услуги</b>',
  '',
  '• <a href="' + SITE_URL + 'mezhevanie">Межевание земельных участков</a>',
  '• <a href="' + SITE_URL + 'tehplan">Технический план объекта недвижимости</a>',
  '• <a href="' + SITE_URL + 'razdel-obedinenie">Перераспределение, раздел и объединение участков</a>',
  '',
  'Площадь, регион и срочность задачи влияют на стоимость. Точную цену назовём на бесплатной консультации.',
  '<a href="' + SITE_URL + '#pricing">Цены на сайте</a>',
  '',
  'Чтобы оставить заявку, напишите задачу и телефон прямо сюда.',
].join('\n');

function botContactsText() {
  const lines = ['<b>Контакты</b>'];
  const c = CONTACTS || {};
  for (const ph of c.phones || []) {
    // "8 902 749-28-01" -> "+7 902 749-28-01": Telegram makes the +7 form tappable.
    const num = escapeHtml(String(ph.display || '').replace(/^8\s/, '+7 '));
    const max = ph.max ? ' · <a href="' + escapeHtml(ph.max) + '">MAX</a>' : '';
    lines.push('', escapeHtml(ph.region || ''), num + max);
  }
  lines.push('');
  if (c.email) lines.push('Почта: ' + escapeHtml(c.email));
  lines.push('Сайт: <a href="' + SITE_URL + '">kadastrhelp.ru</a>');
  return lines.join('\n');
}

function sendBotText(chatId, text, withMenu) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (withMenu) payload.reply_markup = BOT_MENU;
  return telegramCall('sendMessage', payload);
}

// /services, /contacts (typed or from the command menu) and the greeting's
// buttons. Returns true when the input was one of ours — never a lead.
async function answerBotCommand(chatId, command) {
  if (command === 'services') { await sendBotText(chatId, BOT_SERVICES, false); return true; }
  if (command === 'contacts') { await sendBotText(chatId, botContactsText(), false); return true; }
  return false;
}

async function processCallback(cq) {
  const chat = cq.message && cq.message.chat;
  // Stop the button's loading spinner whatever happens next.
  await telegramCall('answerCallbackQuery', { callback_query_id: cq.id });
  if (!chat || chat.id === undefined || chat.id === null) return;
  if (chat.type && chat.type !== 'private') return;
  const isOwnerChat = parseChatIds(process.env.TG_LEAD_CHAT_IDS).includes(String(chat.id));
  if (!isOwnerChat && !checkMenuRateLimit(chat.id)) return;
  await answerBotCommand(chat.id, String(cq.data || ''));
}

async function processUpdate(update) {
  if (update && update.callback_query) return processCallback(update.callback_query);
  const message = update && update.message;
  if (!message) return;
  const chatId = message.chat && message.chat.id;
  if (chatId === undefined || chatId === null) return;

  const leadChatIds = parseChatIds(process.env.TG_LEAD_CHAT_IDS);
  const isOwnerChat = leadChatIds.includes(String(chatId));
  const text = typeof message.text === 'string' ? message.text : '';

  // Only relay/react to 1:1 chats with the bot. Group/supergroup/channel
  // updates (bot added to a group, privacy mode off, etc.) are never leads —
  // don't forward ordinary group chatter into the owner's lead chats or
  // reply into the group as if it were a customer conversation.
  if (message.chat && message.chat.type && message.chat.type !== 'private') return;

  // Commands (/start, /services, /contacts, ...) draw on the menu bucket, real
  // messages on the stricter lead bucket; the rest of an album rides on its first item.
  const isCommand = text.charAt(0) === '/';
  const albumRest = !isCommand && !isOwnerChat && isAlbumFollowUp(chatId, message.media_group_id);
  if (!isOwnerChat && !albumRest) {
    if (!(isCommand ? checkMenuRateLimit(chatId) : checkWebhookRateLimit(chatId))) return;
    if (!isCommand) openAlbum(chatId, message.media_group_id);
  }

  if (text === '/start' || text.indexOf('/start ') === 0) {
    const code = text.length > 6 ? text.slice(6).trim() : '';
    const ownerCode = process.env.TG_OWNER_CODE;
    if (code && ownerCode && code === ownerCode) {
      await telegramCall('sendMessage', { chat_id: chatId, text: 'Готово. Сюда будут приходить заявки с сайта.' });
      console.log('OWNER_REGISTER chat=' + chatId);
      return;
    }
    if (isOwnerChat) {
      await telegramCall('sendMessage', { chat_id: chatId, text: 'Сюда уже приходят заявки с сайта.' });
      return;
    }
    await sendBotText(chatId, BOT_GREETING, true);
    return;
  }

  // Other commands: /services and /contacts answer; anything else (/help,
  // a mistyped command) gets the greeting. Commands are never leads.
  if (text.charAt(0) === '/') {
    const command = text.slice(1).split(/\s/)[0].split('@')[0].toLowerCase();
    if (!(await answerBotCommand(chatId, command))) await sendBotText(chatId, BOT_GREETING, true);
    return;
  }

  // Chats already collecting leads (the owner) chatting with the bot — never
  // loop their own messages back into the lead chats.
  if (isOwnerChat) return;

  let results = []; // empty when no lead chat is registered yet: handled as undelivered below
  if (text) {
    const from = message.from || {};
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ');
    const lines = ['💬 <b>Сообщение в боте</b>'];
    if (fullName) lines.push('Имя: ' + escapeHtml(fullName));
    if (from.username) lines.push('Username: @' + escapeHtml(from.username));
    // Header + text must stay under Telegram's cap once escaped, or the whole
    // send is rejected and the lead is lost — fit the text into what is left.
    const budget = Math.max(0, TG_TEXT_LIMIT - lines.join('\n').length - 2);
    let body = escapeHtml(text);
    if (body.length > budget) {
      body = body.slice(0, budget);
      const amp = body.lastIndexOf('&');
      if (amp !== -1 && body.indexOf(';', amp) === -1) body = body.slice(0, amp);
      if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
      body += '…';
    }
    lines.push(body);
    const forwardText = lines.join('\n');
    results = await Promise.all(leadChatIds.map((cid) => telegramCall('sendMessage', { chat_id: cid, text: forwardText, parse_mode: 'HTML' })));
  } else {
    results = await Promise.all(leadChatIds.map((cid) => telegramCall('forwardMessage', { chat_id: cid, from_chat_id: chatId, message_id: message.message_id })));
  }

  if (!results.some((r) => r.ok)) {
    // Same safety net as the site form: what the visitor sent lands in the log (for media the
    // caption and file id, enough to fetch it with the Bot API), and the visitor is told to
    // reach the engineer directly instead of being thanked.
    console.log('BOT_UNDELIVERED ' + JSON.stringify({
      chat: chatId,
      username: message.from && message.from.username,
      text: text || message.caption || '(non-text message)',
      message_id: message.message_id,
      media_group_id: message.media_group_id,
      file_id: mediaFileId(message),
      time: new Date().toISOString(),
    }));
    if (!albumRest) await sendBotText(chatId, 'Не получилось передать сообщение инженеру — позвоните или напишите напрямую.\n\n' + botContactsText(), false);
    return;
  }

  if (albumRest) return;
  await telegramCall('sendMessage', {
    chat_id: chatId,
    text: 'Спасибо! Сообщение передано кадастровому инженеру, он свяжется с вами. Если не указали телефон — напишите его здесь.',
  });
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
  processUpdate(update).catch((e) => {
    console.error('webhook processUpdate error:', e);
  });
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
