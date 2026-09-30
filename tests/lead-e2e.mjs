#!/usr/bin/env node
'use strict';
// Zero-dependency E2E test for the lead API (POST /api/lead) and the
// Telegram webhook (POST /tg/<secret>) in server.js.
//
// Spins up a mock Telegram Bot API on a random port and one or two copies
// of server.js (this repo's own file, as a child process) pointed at the
// mock via TG_API_BASE, then drives both over plain fetch().
//
//   node tests/lead-e2e.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const SERVER_JS = path.join(REPO_ROOT, 'server.js');

const MAIN_PORT = 4171;
const NOCONF_PORT = 4172;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
function assertTrue(name, cond, detail) {
  report(name, !!cond, detail);
}

// ---------------------------------------------------------------------------
// Mock Telegram Bot API
// ---------------------------------------------------------------------------

let mockFail = false;
let mockCalls = [];

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        // URL shape: /bot<token>/<method>
        const m = /^\/bot([^/]+)\/([^/?]+)/.exec(req.url);
        mockCalls.push({ token: m ? m[1] : null, method: m ? m[2] : null, body });
        if (mockFail) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: mock failure' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { message_id: mockCalls.length, chat: { id: 1 } } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------------------------------------------------------------------
// server.js child processes
// ---------------------------------------------------------------------------

function startServer(env, port, baseEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      env: Object.assign({}, baseEnv || process.env, env, { PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdoutBuf = '';
    child.stderrBuf = '';
    child.stdout.on('data', (d) => { child.stdoutBuf += d.toString('utf8'); });
    child.stderr.on('data', (d) => { child.stderrBuf += d.toString('utf8'); });
    child.on('error', reject);
    // Poll until it answers.
    (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/robots.txt`);
          if (res.status) { resolve(child); return; }
        } catch {}
        await sleep(150);
      }
      reject(new Error('server.js did not start on :' + port));
    })();
  });
}

function stopServer(child) {
  if (!child) return;
  try { child.kill(); } catch {}
}

// ---------------------------------------------------------------------------

const mock = await startMock();
const MOCK_BASE = `http://127.0.0.1:${mock.address().port}`;

const mainEnv = {
  TG_API_BASE: MOCK_BASE,
  TG_BOT_TOKEN: 'TEST_MOCK_TOKEN',
  TG_LEAD_CHAT_IDS: '111,222',
  TG_WEBHOOK_SECRET: 'whsecret123',
  TG_OWNER_CODE: 'owner777',
  LEAD_RELAY_SECRET: 'relaysecret-test-0123' + String.fromCharCode(10), // trailing newline as if pasted; server.js must trim it
};
const main = await startServer(mainEnv, MAIN_PORT);
const MAIN = `http://127.0.0.1:${MAIN_PORT}`;

// Base env for the "not configured" instance: start from the real process
// env (need PATH/SystemRoot etc. to spawn node at all) but strip any bot
// token/chat ids that might happen to be set on the host, so this instance
// is guaranteed to hit the not_configured path regardless of the machine.
const noConfEnv = Object.assign({}, process.env);
delete noConfEnv.TG_BOT_TOKEN;
delete noConfEnv.TG_LEAD_CHAT_IDS;
delete noConfEnv.TG_WEBHOOK_SECRET;
delete noConfEnv.TG_OWNER_CODE;
delete noConfEnv.LEAD_RELAY_SECRET;
const noConf = await startServer({ TG_API_BASE: MOCK_BASE }, NOCONF_PORT, noConfEnv);
const NOCONF = `http://127.0.0.1:${NOCONF_PORT}`;

function validPayload(overrides) {
  return Object.assign({
    name: 'Иван Тестов',
    phone: '+7 999 123-45-67',
    service: 'Межевание земельных участков',
    message: 'Нужна консультация по границам участка.',
    page: '/',
    consent: true,
    website: '',
  }, overrides || {});
}

async function postLead(payload, extraHeaders) {
  try {
    const res = await fetch(MAIN + '/api/lead', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
      body: JSON.stringify(payload),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: res.headers };
  } catch (e) {
    return { status: 0, json: null, headers: new Map(), error: e && e.message };
  }
}

const callsBefore = () => mockCalls.length;

try {
  // ---------------- Happy path + HTML escaping ----------------
  {
    const before = callsBefore();
    const payload = validPayload({ name: 'Иван <script>alert(1)</script> "Кавычки"', phone: '+7 (999) 123-45-67' });
    const r = await postLead(payload, { 'X-Forwarded-For': '10.0.0.1' });
    assertTrue('happy path returns 200 ok:true with id', r.status === 200 && r.json && r.json.ok === true && !!r.json.id, JSON.stringify(r.json));
    const newCalls = mockCalls.slice(before);
    assertTrue('happy path sends sendMessage to both lead chats', newCalls.length === 2 && newCalls.every((c) => c.method === 'sendMessage'), 'got ' + newCalls.length);
    const chatIdsHit = newCalls.map((c) => String(c.body && c.body.chat_id)).sort();
    assertTrue('happy path hits chat 111 and 222', chatIdsHit[0] === '111' && chatIdsHit[1] === '222', JSON.stringify(chatIdsHit));
    const text = newCalls[0] && newCalls[0].body && newCalls[0].body.text;
    assertTrue('message HTML-escapes the name (no raw <script>)', typeof text === 'string' && !text.includes('<script>') && text.includes('&lt;script&gt;'), text);
    assertTrue('message HTML-escapes quotes', typeof text === 'string' && text.includes('&quot;Кавычки&quot;'), text);
    assertTrue('message includes tel: link for phone', typeof text === 'string' && text.includes('tel:+79991234567'), text);
    assertTrue('message uses HTML parse_mode', newCalls.every((c) => c.body && c.body.parse_mode === 'HTML'));
  }

  // ---------------- Validation failures ----------------
  {
    const before = callsBefore();
    const cases = [
      ['no phone', validPayload({ phone: '' })],
      ['no consent', validPayload({ consent: false })],
      ['garbage phone', validPayload({ phone: 'позвоните мне пожалуйста' })],
      ['name too long', validPayload({ name: 'ы'.repeat(81) })],
      ['phone too long', validPayload({ phone: '+7' + '9'.repeat(30) })],
    ];
    for (const [label, payload] of cases) {
      const r = await postLead(payload, { 'X-Forwarded-For': '10.0.0.2' });
      assertTrue(`validation: ${label} -> 400`, r.status === 400 && r.json && r.json.ok === false, JSON.stringify(r.json));
    }
    assertTrue('validation failures send nothing to Telegram', callsBefore() === before, `before=${before} after=${callsBefore()}`);
  }

  // ---------------- >8KB body ----------------
  {
    const before = callsBefore();
    const payload = validPayload({ note: 'x'.repeat(9000) });
    const r = await postLead(payload, { 'X-Forwarded-For': '10.0.0.3' });
    assertTrue('body >8KB -> 400 too_large', r.status === 400 && r.json && r.json.reason === 'too_large', JSON.stringify(r.json));
    assertTrue('>8KB sends nothing to Telegram', callsBefore() === before);
  }

  // ---------------- Honeypot ----------------
  {
    const before = callsBefore();
    const payload = validPayload({ website: 'http://spam.example/buy-now' });
    const r = await postLead(payload, { 'X-Forwarded-For': '10.0.0.4' });
    assertTrue('honeypot -> 200 ok:true', r.status === 200 && r.json && r.json.ok === true, JSON.stringify(r.json));
    assertTrue('honeypot sends nothing to Telegram', callsBefore() === before);
  }

  // ---------------- CORS ----------------
  {
    const allowed = await fetch(MAIN + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://kadastrhelp.ru', 'X-Forwarded-For': '10.0.0.5' },
      body: JSON.stringify(validPayload()),
    });
    assertTrue('allowed origin gets Access-Control-Allow-Origin', allowed.headers.get('access-control-allow-origin') === 'https://kadastrhelp.ru', allowed.headers.get('access-control-allow-origin'));

    const disallowed = await fetch(MAIN + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-Forwarded-For': '10.0.0.5' },
      body: JSON.stringify(validPayload()),
    });
    assertTrue('disallowed origin gets no CORS header', !disallowed.headers.get('access-control-allow-origin'), disallowed.headers.get('access-control-allow-origin'));

    const preflight = await fetch(MAIN + '/api/lead', {
      method: 'OPTIONS',
      headers: { Origin: 'https://downmeansoff.github.io', 'Access-Control-Request-Method': 'POST' },
    });
    assertTrue('OPTIONS preflight -> 204 with CORS headers', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === 'https://downmeansoff.github.io' && !!preflight.headers.get('access-control-allow-methods'), preflight.status);
  }

  // ---------------- Rate limit (isolated IP) ----------------
  {
    const ip = '10.0.0.9';
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const r = await postLead(validPayload(), { 'X-Forwarded-For': ip });
      lastStatus = r.status;
      if (i < 5) assertTrue(`rate limit: request ${i + 1}/5 succeeds`, r.status === 200, JSON.stringify(r.json));
    }
    assertTrue('rate limit: 6th request -> 429', lastStatus === 429, 'got ' + lastStatus);
  }

  // ---------------- not_configured (503) ----------------
  {
    const res = await fetch(NOCONF + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });
    const json = await res.json();
    assertTrue('not_configured -> 503', res.status === 503 && json.reason === 'not_configured', JSON.stringify(json));
    await sleep(150);
    assertTrue('not_configured logs LEAD_UNDELIVERED', noConf.stdoutBuf.includes('LEAD_UNDELIVERED'), noConf.stdoutBuf.slice(-300));
  }

  // ---------------- Telegram failure (502) ----------------
  {
    mockFail = true;
    const r = await postLead(validPayload(), { 'X-Forwarded-For': '10.0.0.6' });
    mockFail = false;
    assertTrue('telegram failure -> 502', r.status === 502 && r.json && r.json.reason === 'telegram', JSON.stringify(r.json));
    await sleep(150);
    assertTrue('telegram failure logs LEAD_UNDELIVERED', main.stdoutBuf.includes('LEAD_UNDELIVERED'), main.stdoutBuf.slice(-300));
  }

  // ---------------- Webhook: wrong secret ----------------
  {
    const r1 = await fetch(MAIN + '/tg/wrongsecret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'whsecret123' },
      body: JSON.stringify({ update_id: 1 }),
    });
    assertTrue('webhook wrong path secret -> 404', r1.status === 404, r1.status);

    const r2 = await fetch(MAIN + '/tg/whsecret123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no header token
      body: JSON.stringify({ update_id: 1 }),
    });
    assertTrue('webhook missing header token -> 404', r2.status === 404, r2.status);
  }

  const webhookHeaders = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'whsecret123' };
  async function postWebhook(update) {
    return fetch(MAIN + '/tg/whsecret123', { method: 'POST', headers: webhookHeaders, body: JSON.stringify(update) });
  }

  // ---------------- Webhook: /start <code> -> owner register ----------------
  {
    const before = callsBefore();
    const r = await postWebhook({
      update_id: 10,
      message: { message_id: 1, date: 0, chat: { id: 999, type: 'private' }, from: { id: 999, first_name: 'Owner' }, text: '/start owner777' },
    });
    assertTrue('webhook /start <code> -> 200', r.status === 200, r.status);
    await sleep(150);
    const newCalls = mockCalls.slice(before);
    assertTrue('owner register sends confirmation to that chat', newCalls.length === 1 && String(newCalls[0].body.chat_id) === '999' && newCalls[0].body.text === 'Готово. Сюда будут приходить заявки с сайта.', JSON.stringify(newCalls));
    assertTrue('owner register logged', main.stdoutBuf.includes('OWNER_REGISTER chat=999'), main.stdoutBuf.slice(-300));
  }

  // ---------------- Webhook: bare /start from client -> greeting only ----------------
  {
    const before = callsBefore();
    const r = await postWebhook({
      update_id: 11,
      message: { message_id: 2, date: 0, chat: { id: 777, type: 'private' }, from: { id: 777, first_name: 'Client' }, text: '/start' },
    });
    assertTrue('webhook bare /start -> 200', r.status === 200);
    await sleep(150);
    const newCalls = mockCalls.slice(before);
    assertTrue('bare /start sends only the greeting, no forward', newCalls.length === 1 && String(newCalls[0].body.chat_id) === '777' && /Здравствуйте/.test(newCalls[0].body.text), JSON.stringify(newCalls));
  }

  // ---------------- Webhook: client text -> forwarded to all lead chats + reply ----------------
  {
    const before = callsBefore();
    const r = await postWebhook({
      update_id: 12,
      message: { message_id: 3, date: 0, chat: { id: 555, type: 'private' }, from: { id: 555, first_name: 'Иван', username: 'ivan123' }, text: 'Здравствуйте, сколько стоит межевание?' },
    });
    assertTrue('webhook client text -> 200', r.status === 200);
    await sleep(150);
    const newCalls = mockCalls.slice(before);
    const toLeadChats = newCalls.filter((c) => c.body && ['111', '222'].includes(String(c.body.chat_id)));
    const toClient = newCalls.filter((c) => c.body && String(c.body.chat_id) === '555');
    assertTrue('client text forwarded to both lead chats', toLeadChats.length === 2, JSON.stringify(newCalls));
    assertTrue('forwarded text includes name/username/message', toLeadChats.every((c) => /Иван/.test(c.body.text) && /ivan123/.test(c.body.text) && /межевание/.test(c.body.text)), JSON.stringify(toLeadChats.map((c) => c.body.text)));
    assertTrue('client gets thank-you reply', toClient.length === 1 && /Спасибо/.test(toClient[0].body.text), JSON.stringify(toClient));
  }

  // ---------------- Webhook: message from an owner chat -> not forwarded ----------------
  {
    const before = callsBefore();
    const r = await postWebhook({
      update_id: 13,
      message: { message_id: 4, date: 0, chat: { id: 111, type: 'private' }, from: { id: 111, first_name: 'Owner' }, text: 'просто чат владельца, не заявка' },
    });
    assertTrue('webhook owner-chat message -> 200', r.status === 200);
    await sleep(150);
    assertTrue('owner-chat message is not forwarded anywhere', callsBefore() === before, `before=${before} after=${callsBefore()}`);
  }

  // ---------------- Webhook: non-private chat (group) -> ignored ----------------
  {
    const before = callsBefore();
    const r = await postWebhook({
      update_id: 14,
      message: { message_id: 5, date: 0, chat: { id: -10099, type: 'group' }, from: { id: 321, first_name: 'Кто-то' }, text: 'Привет всем в группе' },
    });
    assertTrue('webhook group message -> 200', r.status === 200);
    await sleep(150);
    assertTrue('group message is not treated as a lead (no forward, no reply)', callsBefore() === before, `before=${before} after=${callsBefore()}`);
  }

  // ---------------- Bot: greeting carries the menu buttons ----------------
  {
    const before = callsBefore();
    await postWebhook({
      update_id: 20,
      message: { message_id: 20, date: 0, chat: { id: 7101, type: 'private' }, from: { id: 7101, first_name: 'Client' }, text: '/start' },
    });
    await sleep(150);
    const c = mockCalls.slice(before);
    const kb = c[0] && c[0].body.reply_markup && c[0].body.reply_markup.inline_keyboard;
    const flat = kb ? kb.flat() : [];
    assertTrue('greeting is HTML with services/contacts/site buttons',
      c.length === 1 && c[0].body.parse_mode === 'HTML'
        && flat.some((b) => b.callback_data === 'services') && flat.some((b) => b.callback_data === 'contacts')
        && flat.some((b) => b.url === 'https://kadastrhelp.ru/'),
      JSON.stringify(c));
  }

  // ---------------- Bot: /services and /contacts answer, never forwarded ----------------
  {
    const before = callsBefore();
    await postWebhook({
      update_id: 21,
      message: { message_id: 21, date: 0, chat: { id: 7102, type: 'private' }, from: { id: 7102, first_name: 'Client' }, text: '/services' },
    });
    await sleep(150);
    let c = mockCalls.slice(before);
    assertTrue('/services lists the three service pages, no forward',
      c.length === 1 && String(c[0].body.chat_id) === '7102'
        && ['/mezhevanie', '/tehplan', '/razdel-obedinenie'].every((s) => c[0].body.text.includes('kadastrhelp.ru' + s)),
      JSON.stringify(c));

    const before2 = callsBefore();
    await postWebhook({
      update_id: 22,
      message: { message_id: 22, date: 0, chat: { id: 7102, type: 'private' }, from: { id: 7102, first_name: 'Client' }, text: '/contacts@kadastricom_bot' },
    });
    await sleep(150);
    c = mockCalls.slice(before2);
    // Numbers must come from assets/contacts.js, printed in the tappable +7 form.
    assertTrue('/contacts (with @botname) prints both phones from contacts.js and the email',
      c.length === 1 && c[0].body.text.includes('+7 902 749-28-01') && c[0].body.text.includes('+7 917 769-61-19')
        && c[0].body.text.includes('baymurzin.86@bk.ru') && c[0].body.text.includes('https://max.ru/u/'),
      JSON.stringify(c));
  }

  // ---------------- Bot: unknown command -> greeting, not a lead ----------------
  {
    const before = callsBefore();
    await postWebhook({
      update_id: 23,
      message: { message_id: 23, date: 0, chat: { id: 7103, type: 'private' }, from: { id: 7103, first_name: 'Client' }, text: '/help' },
    });
    await sleep(150);
    const c = mockCalls.slice(before);
    assertTrue('/help gets the greeting and is not forwarded to lead chats',
      c.length === 1 && String(c[0].body.chat_id) === '7103' && /Здравствуйте/.test(c[0].body.text),
      JSON.stringify(c));
  }

  // ---------------- Bot: inline buttons (callback_query) ----------------
  {
    const before = callsBefore();
    await postWebhook({
      update_id: 24,
      callback_query: { id: 'cq1', from: { id: 7104, first_name: 'Client' }, data: 'contacts', message: { message_id: 30, date: 0, chat: { id: 7104, type: 'private' } } },
    });
    await sleep(150);
    const c = mockCalls.slice(before);
    const ack = c.filter((x) => x.method === 'answerCallbackQuery');
    const msg = c.filter((x) => x.method === 'sendMessage');
    assertTrue('button press is acknowledged and answered with contacts',
      ack.length === 1 && ack[0].body.callback_query_id === 'cq1'
        && msg.length === 1 && String(msg[0].body.chat_id) === '7104' && /Контакты/.test(msg[0].body.text),
      JSON.stringify(c));

    const before2 = callsBefore();
    await postWebhook({
      update_id: 25,
      callback_query: { id: 'cq2', from: { id: 321, first_name: 'Кто-то' }, data: 'services', message: { message_id: 31, date: 0, chat: { id: -10099, type: 'group' } } },
    });
    await sleep(150);
    const c2 = mockCalls.slice(before2);
    assertTrue('button press in a group is only acknowledged, nothing posted',
      c2.length === 1 && c2[0].method === 'answerCallbackQuery', JSON.stringify(c2));
  }

  // ---------------- Server: a NUL byte in the path must not kill the process ----------------
  {
    try {
      const codes = [];
      for (const p of ['/assets/%00', '/%00.html', '/assets/a%00b.png']) codes.push((await fetch(MAIN + p)).status);
      const alive = await fetch(MAIN + '/');
      assertTrue('NUL byte in the path -> 400, server keeps serving', codes.every((s) => s === 400) && alive.status === 200, JSON.stringify(codes) + ' alive=' + alive.status);
    } catch (e) {
      assertTrue('NUL byte in the path -> 400, server keeps serving', false, String(e));
    }
  }

  // ---------------- Bot: browsing the menu does not use up the lead-message allowance ----------------
  {
    const before = callsBefore();
    for (let i = 0; i < 6; i++) {
      await postWebhook({ update_id: 200 + i, message: { message_id: 200 + i, date: 0, chat: { id: 7201, type: 'private' }, from: { id: 7201, first_name: 'Menu' }, text: '/services' } });
      await sleep(40);
    }
    await postWebhook({ update_id: 210, message: { message_id: 210, date: 0, chat: { id: 7201, type: 'private' }, from: { id: 7201, first_name: 'Menu' }, text: 'Нужно межевание, тел. 8 927 000-00-00' } });
    await sleep(400);
    const c = mockCalls.slice(before);
    const menuReplies = c.filter((x) => x.body && String(x.body.chat_id) === '7201' && /Услуги/.test(x.body.text || ''));
    const toLead = c.filter((x) => x.body && ['111', '222'].includes(String(x.body.chat_id)));
    assertTrue('6 menu commands do not throttle the visitor\'s next real message', menuReplies.length === 6 && toLead.length === 2, `menu=${menuReplies.length} lead=${toLead.length}`);
  }

  // ---------------- Bot: an album goes through whole, with a single thank-you ----------------
  {
    const before = callsBefore();
    for (let i = 0; i < 8; i++) {
      await postWebhook({ update_id: 220 + i, message: { message_id: 220 + i, date: 0, chat: { id: 7202, type: 'private' }, from: { id: 7202, first_name: 'Album' }, media_group_id: 'grp1', photo: [{ file_id: 'f' + i, file_unique_id: 'u' + i, width: 90, height: 90 }] } });
      await sleep(40);
    }
    await sleep(400);
    const c = mockCalls.slice(before);
    const fwd = c.filter((x) => x.method === 'forwardMessage');
    const thanks = c.filter((x) => x.body && String(x.body.chat_id) === '7202' && /Спасибо/.test(x.body.text || ''));
    assertTrue('8-photo album: every photo forwarded to both lead chats, client thanked once', fwd.length === 16 && thanks.length === 1, `forwards=${fwd.length} thanks=${thanks.length}`);
  }

  // ---------------- Bot: when Telegram refuses the forward, the text lands in the log ----------------
  {
    mockFail = true;
    await postWebhook({ update_id: 230, message: { message_id: 230, date: 0, chat: { id: 7203, type: 'private' }, from: { id: 7203, first_name: 'Log', username: 'logger' }, text: 'Нужен тех план, тел. 8 927 123-45-67' } });
    await sleep(400);
    mockFail = false;
    assertTrue('failed forward is logged as BOT_UNDELIVERED together with the text', main.stdoutBuf.includes('BOT_UNDELIVERED') && main.stdoutBuf.includes('8 927 123-45-67'), main.stdoutBuf.slice(-300));
  }

  // ---------------- Bot: a near-limit client message is cut to fit, not dropped ----------------
  {
    const before = callsBefore();
    const long = 'Очень длинное описание участка. '.repeat(140).slice(0, 4090);
    await postWebhook({ update_id: 240, message: { message_id: 240, date: 0, chat: { id: 7204, type: 'private' }, from: { id: 7204, first_name: 'Длинный', username: 'long_user_name' }, text: long } });
    await sleep(400);
    const toLead = mockCalls.slice(before).filter((x) => x.body && ['111', '222'].includes(String(x.body.chat_id)));
    assertTrue('4090-char client message reaches both lead chats within the 4096 limit', toLead.length === 2 && toLead.every((x) => x.body.text.length <= 4096), toLead.map((x) => x.body.text.length).join(','));
  }

  // ---------------- Webhook: per-sender rate limit ----------------
  {
    const before = callsBefore();
    let calls6 = 0;
    for (let i = 0; i < 6; i++) {
      await postWebhook({
        update_id: 100 + i,
        message: { message_id: 10 + i, date: 0, chat: { id: 6060, type: 'private' }, from: { id: 6060, first_name: 'Flood' }, text: 'сообщение номер ' + i },
      });
      await sleep(60);
    }
    const newCalls = mockCalls.slice(before);
    // Each accepted message produces 2 lead-chat forwards + 1 thank-you reply = 3 calls.
    const thankYous = newCalls.filter((c) => c.body && String(c.body.chat_id) === '6060' && /Спасибо/.test(c.body.text));
    assertTrue('webhook per-sender flood is throttled (5 replies for 6 messages, 6th dropped)', thankYous.length === 5, 'got ' + thankYous.length);
  }

  // ---------------- Webhook: IP spoofing on /api/lead no longer bypasses the per-IP limit ----------------
  {
    // Simulate a request that passed through exactly one trusted proxy hop
    // (this server's model): attacker-controlled first entry + proxy-appended
    // real address as the last entry. Rotating the forged first entry must
    // NOT reset the counter — the limiter has to key off the last entry only.
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const r = await postLead(validPayload(), { 'X-Forwarded-For': `9.9.9.${i}, 10.0.0.42` });
      lastStatus = r.status;
    }
    assertTrue('rotating forged first XFF hop still hits the per-IP limit (6th -> 429)', lastStatus === 429, 'got ' + lastStatus);

    // A genuinely different trusted (last-hop) address is a different client
    // and gets its own budget.
    const rOther = await postLead(validPayload(), { 'X-Forwarded-For': '9.9.9.9, 10.0.0.43' });
    assertTrue('a different last-hop address is rate-limited independently', rOther.status === 200, JSON.stringify(rOther.json));
  }

  // ---------------- Telegram 4096-char limit: long message doesn't fail the whole lead ----------------
  {
    const before = callsBefore();
    const payload = validPayload({ message: '&'.repeat(1000), phone: '+7 999 111-22-33' });
    const r = await postLead(payload, { 'X-Forwarded-For': '10.0.0.50' });
    assertTrue('message full of escapable chars still delivers (200, not 502)', r.status === 200 && r.json && r.json.ok === true, JSON.stringify(r.json));
    const newCalls = mockCalls.slice(before);
    assertTrue('composed Telegram text stays within the 4096 limit', newCalls.length > 0 && newCalls.every((c) => c.body && typeof c.body.text === 'string' && c.body.text.length <= 4096), newCalls.map((c) => c.body && c.body.text.length));
    assertTrue('truncated text has no dangling unterminated entity', newCalls.every((c) => !/&(?:amp|lt|gt|quot|#39)?$/.test(c.body.text.replace(/…$/, ''))), newCalls.map((c) => c.body && c.body.text.slice(-10)));
  }

  // ---------------- Relay (kadastrhelp.ru api/lead.php): visitor IP from X-Lead-Client-IP ----------------
  {
    const relay = (clientIp, secret) => ({ 'X-Forwarded-For': '10.0.0.70', 'X-Lead-Relay': secret, 'X-Lead-Client-IP': clientIp });
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await postLead(validPayload(), relay('172.16.0.1', 'relaysecret-test-0123'));
      last = r.status;
      if (i < 5) assertTrue(`relay: visitor request ${i + 1}/5 succeeds`, r.status === 200, JSON.stringify(r.json));
    }
    assertTrue('relay: 6th request from the same visitor -> 429', last === 429, 'got ' + last);
    const other = await postLead(validPayload(), relay('172.16.0.2', 'relaysecret-test-0123'));
    assertTrue('relay: another visitor behind the same hosting IP is not limited', other.status === 200, JSON.stringify(other.json));
    let spoofLast = 0;
    for (let i = 0; i < 6; i++) {
      const r = await postLead(validPayload(), { 'X-Forwarded-For': '10.0.0.71', 'X-Lead-Relay': 'wrong-secret-000000000', 'X-Lead-Client-IP': `172.16.1.${i}` });
      spoofLast = r.status;
    }
    assertTrue('relay: wrong secret -> X-Lead-Client-IP ignored, limited by proxy hop', spoofLast === 429, 'got ' + spoofLast);
  }

  // ---------------- Static file allowlist: internal files are never served ----------------
  {
    const forbidden = ['/server.js', '/package.json', '/pack-hosting.mjs', '/tests/lead-e2e.mjs', '/CLAUDE.md', '/DEPLOY.bat', '/.git/HEAD', '/.git/config'];
    for (const p of forbidden) {
      const r = await fetch(MAIN + p);
      assertTrue(`static allowlist blocks ${p} -> 404`, r.status === 404, r.status);
    }
    const allowed = ['/', '/mezhevanie', '/tehplan', '/razdel-obedinenie', '/politika', '/Header.dc.html', '/robots.txt', '/favicon.ico', '/support.js', '/image-slot.js', '/.image-slots.state.json'];
    for (const p of allowed) {
      const r = await fetch(MAIN + p, { redirect: 'manual' });
      assertTrue(`static allowlist still serves ${p} -> 200`, r.status === 200, r.status);
    }
  }

  // ---------------- Clean page addresses: old file names answer 301 ----------------
  {
    const home = await (await fetch(MAIN + '/')).text();
    assertTrue('"/" serves the home page itself', home.includes('https://kadastrhelp.ru/"') && home.includes('support.js'), home.slice(0, 80));
    const mezh = await (await fetch(MAIN + '/mezhevanie')).text();
    assertTrue('"/mezhevanie" serves mezhevanie.dc.html', mezh.includes('https://kadastrhelp.ru/mezhevanie"'), mezh.slice(0, 80));
    const redirects = [
      ['/index.dc.html', '/'], ['/index.html', '/'], ['/index.dc.html?review=1', '/?review=1'],
      ['/mezhevanie.dc.html', '/mezhevanie'], ['/tehplan.dc.html?x=1', '/tehplan?x=1'],
      ['/razdel-obedinenie.dc.html', '/razdel-obedinenie'], ['/politika.dc.html', '/politika'],
      ['/politika/', '/politika'], ['/tehplan.html', '/tehplan'],
    ];
    for (const [from, to] of redirects) {
      const r = await fetch(MAIN + from, { redirect: 'manual' });
      assertTrue(`${from} -> 301 ${to}`, r.status === 301 && r.headers.get('location') === to, `${r.status} ${r.headers.get('location')}`);
    }
    const r404 = await fetch(MAIN + '/nope', { redirect: 'manual' });
    assertTrue('unknown address -> 404', r404.status === 404, r404.status);
  }
} finally {
  stopServer(main);
  stopServer(noConf);
  await new Promise((r) => mock.close(r));
}

const failed = results.filter((r) => !r.pass);
console.log('\n=== SUMMARY ===');
console.log(`${results.length} checks, ${failed.length} failed`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(` - ${f.name}: ${f.detail || ''}`);
}
process.exit(failed.length ? 1 : 0);
