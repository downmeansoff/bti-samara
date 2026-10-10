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

import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const SERVER_JS = path.join(REPO_ROOT, 'server.js');
const require = createRequire(import.meta.url);
const botUi = require(path.join(REPO_ROOT, 'bot-ui.js'));

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
// Per-method canned responses, consumed in order before falling back to
// mockFail / the default ok:true — e.g. queueMock('sendMessage', 429, {...})
// to fail just the next send with a specific status/body, N times.
const mockQueue = {};
function queueMock(method, status, body, times) {
  mockQueue[method] = mockQueue[method] || [];
  for (let i = 0; i < (times || 1); i++) mockQueue[method].push({ status, body });
}
// Per-method response delay in ms (the call is recorded on arrival, answered
// later) — for ordering tests against a slow Telegram API.
const mockDelay = {};

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        // URL shape: /bot<token>/<method>
        const m = /^\/bot([^/]+)\/([^/?]+)/.exec(req.url);
        const method = m ? m[2] : null;
        mockCalls.push({ token: m ? m[1] : null, method, body });
        const resultId = mockCalls.length;
        if (method && mockDelay[method]) await sleep(mockDelay[method]);
        const queued = method && mockQueue[method] && mockQueue[method].length ? mockQueue[method].shift() : null;
        if (queued) {
          res.writeHead(queued.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(queued.body));
        } else if (mockFail) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: mock failure' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { message_id: resultId, chat: { id: 1 } } }));
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
  RAILWAY_PUBLIC_DOMAIN: '', // the bot's cover/album origin: tests that need it set it themselves
  BOT_ASSET_ORIGIN: '',
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
    const startKb = newCalls[0] && newCalls[0].body.reply_markup && newCalls[0].body.reply_markup.inline_keyboard;
    const startFlat = startKb ? startKb.flat() : [];
    assertTrue('bare /start sends only the menu screen, no forward', newCalls.length === 1 && String(newCalls[0].body.chat_id) === '777'
      && startFlat.some((b) => b.callback_data === 'l') && startFlat.length === 9
      && newCalls[0].body.link_preview_options && /bot-cover-v2.jpg$/.test(newCalls[0].body.link_preview_options.url || ''),
      JSON.stringify(newCalls));
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
    const thankKb = toClient[0] && toClient[0].body.reply_markup && toClient[0].body.reply_markup.inline_keyboard;
    const thankFlat = thankKb ? thankKb.flat() : [];
    assertTrue('client gets thank-you reply', toClient.length === 1 && /Сообщение передано/.test(toClient[0].body.text)
      && thankFlat.some((b) => b.callback_data === 'l') && thankFlat.some((b) => b.callback_data === 'm'),
      JSON.stringify(toClient));
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
        && flat.some((b) => b.callback_data === 's') && flat.some((b) => b.callback_data === 'c')
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
    const svcKb = c[0] && c[0].body.reply_markup && c[0].body.reply_markup.inline_keyboard;
    const svcFlat = svcKb ? svcKb.flat() : [];
    assertTrue('/services lists the six services as buttons, no forward',
      c.length === 1 && String(c[0].body.chat_id) === '7102'
        && ['s:mezh', 's:tehplan', 's:razdel', 's:obsl', 's:osmotr', 's:vynos'].every((d) => svcFlat.some((b) => b.callback_data === d)),
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
    const helpKb = c[0] && c[0].body.reply_markup && c[0].body.reply_markup.inline_keyboard;
    assertTrue('/help gets the menu screen and is not forwarded to lead chats',
      c.length === 1 && String(c[0].body.chat_id) === '7103' && (helpKb ? helpKb.flat() : []).some((b) => b.callback_data === 'l'),
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
    const edit = c.filter((x) => x.method === 'editMessageText');
    assertTrue('button press is acknowledged and answered with contacts in place',
      ack.length === 1 && ack[0].body.callback_query_id === 'cq1' && !ack[0].body.text
        && edit.length === 1 && String(edit[0].body.chat_id) === '7104' && edit[0].body.message_id === 30 && /Контакты/.test(edit[0].body.text),
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
    const menuReplies = c.filter((x) => x.body && String(x.body.chat_id) === '7201'
      && x.body.reply_markup && (x.body.reply_markup.inline_keyboard || []).flat().some((b) => b.callback_data === 's:mezh'));
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
    const thanks = c.filter((x) => x.body && String(x.body.chat_id) === '7202' && /^Сообщение передано\. Кадастровый инженер свяжется с вами\./.test(x.body.text || ''));
    assertTrue('8-photo album: every photo forwarded to both lead chats, one reply to the client', fwd.length === 16 && thanks.length === 1, `forwards=${fwd.length} thanks=${thanks.length}`);
  }

  // ---------------- Bot: a refused first photo does not open a way in for the rest of its album ----------------
  {
    for (let i = 0; i < 5; i++) {
      await postWebhook({ update_id: 250 + i, message: { message_id: 250 + i, date: 0, chat: { id: 7205, type: 'private' }, from: { id: 7205, first_name: 'Burst' }, text: 'Заявка номер ' + i } });
      await sleep(30);
    }
    await sleep(300);
    const before = callsBefore();
    for (let i = 0; i < 3; i++) {
      await postWebhook({ update_id: 260 + i, message: { message_id: 260 + i, date: 0, chat: { id: 7205, type: 'private' }, from: { id: 7205, first_name: 'Burst' }, media_group_id: 'grpA', photo: [{ file_id: 'a' + i, file_unique_id: 'ua' + i, width: 90, height: 90 }] } });
      await sleep(30);
    }
    await sleep(300);
    const c = mockCalls.slice(before);
    assertTrue('album sent after the allowance is used up: nothing forwarded, no reply', c.length === 0, JSON.stringify(c.map((x) => x.method)));
  }

  // ---------------- Bot: rotating album ids does not multiply the allowance ----------------
  {
    const before = callsBefore();
    let id = 300;
    for (let g = 0; g < 8; g++) {
      for (let i = 0; i < 10; i++, id++) {
        await postWebhook({ update_id: id, message: { message_id: id, date: 0, chat: { id: 7206, type: 'private' }, from: { id: 7206, first_name: 'Rotate' }, media_group_id: 'rot' + g, photo: [{ file_id: 'r' + id, file_unique_id: 'ur' + id, width: 90, height: 90 }] } });
      }
    }
    await sleep(600);
    const fwd = mockCalls.slice(before).filter((x) => x.method === 'forwardMessage');
    // 5 photos admitted by the lead bucket + at most 20 riders, each forwarded to 2 lead chats.
    assertTrue('8 albums x 10 photos within a minute: no more than 5 + 20 photos forwarded', fwd.length >= 20 && fwd.length <= 2 * 25, `forwards=${fwd.length}`);
  }

  // ---------------- Bot: when Telegram refuses the forward, the text lands in the log ----------------
  {
    mockFail = true;
    await postWebhook({ update_id: 230, message: { message_id: 230, date: 0, chat: { id: 7203, type: 'private' }, from: { id: 7203, first_name: 'Log', username: 'logger' }, text: 'Нужен тех план, тел. 8 927 123-45-67' } });
    await sleep(400);
    mockFail = false;
    assertTrue('failed forward is logged as BOT_UNDELIVERED together with the text', main.stdoutBuf.includes('BOT_UNDELIVERED') && main.stdoutBuf.includes('8 927 123-45-67'), main.stdoutBuf.slice(-300));
  }

  // ---------------- Bot: a refused photo leaves its caption and file id in the log ----------------
  {
    mockFail = true;
    await postWebhook({ update_id: 400, message: { message_id: 400, date: 0, chat: { id: 7207, type: 'private' }, from: { id: 7207, first_name: 'Photo' }, caption: 'Выписка ЕГРН, тел 8 927 555-66-77', photo: [{ file_id: 'small1', file_unique_id: 'us1', width: 90, height: 90 }, { file_id: 'big1', file_unique_id: 'ub1', width: 800, height: 800 }] } });
    await sleep(400);
    mockFail = false;
    assertTrue('failed photo forward is logged with its caption and the largest file id', main.stdoutBuf.includes('8 927 555-66-77') && main.stdoutBuf.includes('"file_id":"big1"'), main.stdoutBuf.slice(-300));
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
    const thankYous = newCalls.filter((c) => c.body && String(c.body.chat_id) === '6060' && /Сообщение передано/.test(c.body.text));
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
    const forbidden = ['/server.js', '/package.json', '/pack-hosting.mjs', '/tests/lead-e2e.mjs', '/CLAUDE.md', '/DEPLOY.bat', '/.git/HEAD', '/.git/config', '/indexnow-config.json', '/notify-indexnow.mjs'];
    for (const p of forbidden) {
      const r = await fetch(MAIN + p);
      assertTrue(`static allowlist blocks ${p} -> 404`, r.status === 404, r.status);
    }
    const allowed = ['/', '/mezhevanie', '/tehplan', '/razdel-obedinenie', '/vynos-tochek', '/akt-obsledovaniya', '/akt-osmotra', '/politika', '/Header.dc.html', '/robots.txt', '/favicon.ico', '/services-feed.xml', '/support.js', '/image-slot.js', '/.image-slots.state.json'];
    for (const p of allowed) {
      const r = await fetch(MAIN + p, { redirect: 'manual' });
      assertTrue(`static allowlist still serves ${p} -> 200`, r.status === 200, r.status);
    }
    const indexNow = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'indexnow-config.json'), 'utf8'));
    const key = await fetch(MAIN + '/' + indexNow.keyFile);
    assertTrue('IndexNow verification file is served as UTF-8 text', key.status === 200 && /text\/plain; charset=utf-8/.test(key.headers.get('content-type') || ''));
    assertTrue('IndexNow verification file contains only the expected key', (await key.text()).trim() + '.txt' === indexNow.keyFile);
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
      ['/vynos-tochek.dc.html', '/vynos-tochek'], ['/akt-obsledovaniya/', '/akt-obsledovaniya'], ['/akt-osmotra.html', '/akt-osmotra'],
      ['/politika/', '/politika'], ['/tehplan.html', '/tehplan'],
    ];
    for (const [from, to] of redirects) {
      const r = await fetch(MAIN + from, { redirect: 'manual' });
      assertTrue(`${from} -> 301 ${to}`, r.status === 301 && r.headers.get('location') === to, `${r.status} ${r.headers.get('location')}`);
    }
    const r404 = await fetch(MAIN + '/nope', { redirect: 'manual' });
    assertTrue('unknown address -> 404', r404.status === 404, r404.status);
  }

  // ---------------- Bot: new-architecture source files are never publicly servable ----------------
  {
    for (const p of ['/bot-ui.js', '/bot-content.js', '/gen-bot-content.mjs', '/bot.js']) {
      const r = await fetch(MAIN + p);
      assertTrue(`static allowlist blocks ${p} -> 404`, r.status === 404, r.status);
    }
  }

  // ---------------- Bot: /start screen (title, 9 buttons, cover preview) ----------------
  {
    const before = callsBefore();
    await postWebhook({ update_id: 9000, message: { message_id: 9000, date: 0, chat: { id: 8101, type: 'private' }, from: { id: 8101, first_name: 'Client' }, text: '/start' } });
    await sleep(150);
    const c = mockCalls.slice(before);
    const kb = c[0] && c[0].body.reply_markup && c[0].body.reply_markup.inline_keyboard;
    const flat = kb ? kb.flat() : [];
    const expectedData = ['l', 's', 'p', 'h', 'a', 'r', 'f', 'c'];
    assertTrue('/start: one HTML message with the home title',
      c.length === 1 && c[0].body.parse_mode === 'HTML' && /Кадастровые документы без лишних нервов и задержек/.test(c[0].body.text),
      JSON.stringify(c));
    assertTrue('/start: 9 buttons across 5 rows, exact callback set',
      flat.length === 9 && kb.length === 5 && expectedData.every((d) => flat.some((b) => b.callback_data === d)) && flat.some((b) => b.url === 'https://kadastrhelp.ru/'),
      JSON.stringify(flat));
    assertTrue('/start: cover photo shown large, above the text',
      c[0].body.link_preview_options && c[0].body.link_preview_options.url === 'https://kadastrhelp.ru/assets/bot-cover-v2.jpg'
        && c[0].body.link_preview_options.prefer_large_media === true && c[0].body.link_preview_options.show_above_text === true,
      JSON.stringify(c[0].body.link_preview_options));
  }

  // ---------------- Bot: callback "s" edits in place, no sendMessage ----------------
  {
    const before = callsBefore();
    await postWebhook({ update_id: 9001, callback_query: { id: 'cqs1', from: { id: 8102, first_name: 'C' }, data: 's', message: { message_id: 61, date: 0, chat: { id: 8102, type: 'private' } } } });
    await sleep(150);
    const c = mockCalls.slice(before);
    const edit = c.filter((x) => x.method === 'editMessageText');
    const send = c.filter((x) => x.method === 'sendMessage');
    assertTrue('callback s edits the callback message in place, no sendMessage',
      edit.length === 1 && String(edit[0].body.chat_id) === '8102' && edit[0].body.message_id === 61 && send.length === 0,
      JSON.stringify(c.map((x) => x.method)));
  }

  // ---------------- Bot: s:mezh price and service-scoped request button ----------------
  {
    const before = callsBefore();
    await postWebhook({ update_id: 9002, callback_query: { id: 'cqs2', from: { id: 8103, first_name: 'C' }, data: 's:mezh', message: { message_id: 62, date: 0, chat: { id: 8103, type: 'private' } } } });
    await sleep(150);
    const edit = mockCalls.slice(before).find((x) => x.method === 'editMessageText');
    const flat = edit && edit.body.reply_markup.inline_keyboard.flat();
    assertTrue('s:mezh shows the starting price and a service-scoped request button',
      edit && edit.body.text.replace(/\u00A0/g, ' ').includes('от 7 000 ₽') && flat.some((b) => b.callback_data === 'l:mezh'),
      JSON.stringify(edit && edit.body));
  }

  // ---------------- Bot: prices screen has all 7 rows, the note, never the forbidden phrase ----------------
  {
    const before = callsBefore();
    await postWebhook({ update_id: 9003, callback_query: { id: 'cqp1', from: { id: 8104, first_name: 'C' }, data: 'p', message: { message_id: 63, date: 0, chat: { id: 8104, type: 'private' } } } });
    await sleep(150);
    const edit = mockCalls.slice(before).find((x) => x.method === 'editMessageText');
    const text = edit ? edit.body.text.replace(/\u00A0/g, ' ') : '';
    assertTrue('p screen lists all 7 price rows, the pricing note, and never the forbidden phrase',
      ['от 7 000 ₽', 'от 8 500 ₽', 'от 7 500 ₽', 'от 5 000 ₽', 'от 4 500 ₽', 'от 750 ₽'].every((p) => text.includes(p))
        && text.includes('Цены указаны «от» и зависят от площади, региона и срочности')
        && !text.includes('в течение часа'),
      text);
  }

  // ---------------- Bot: FAQ answer ----------------
  {
    const before = callsBefore();
    await postWebhook({ update_id: 9004, callback_query: { id: 'cqf1', from: { id: 8105, first_name: 'C' }, data: 'q0', message: { message_id: 64, date: 0, chat: { id: 8105, type: 'private' } } } });
    await sleep(150);
    const edit = mockCalls.slice(before).find((x) => x.method === 'editMessageText');
    assertTrue('FAQ answer q0 shows the question and the answer',
      edit && edit.body.text.includes('Сколько по времени занимает межевание или технический план?')
        && edit.body.text.includes('В среднем от 5 до 15 рабочих дней'),
      edit && edit.body.text);
  }

  // ---------------- Bot: a:d sends a 5-photo media group + nav message, falls back to text on failure ----------------
  {
    const before = callsBefore();
    await postWebhook({ update_id: 9005, callback_query: { id: 'cqd1', from: { id: 8106, first_name: 'C' }, data: 'a:d', message: { message_id: 65, date: 0, chat: { id: 8106, type: 'private' } } } });
    await sleep(150);
    const c = mockCalls.slice(before);
    const ack = c.filter((x) => x.method === 'answerCallbackQuery');
    const media = c.filter((x) => x.method === 'sendMediaGroup');
    const nav = c.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '8106');
    assertTrue('a:d answers, sends a 5-photo media group with captions, then a nav message',
      ack.length === 1 && media.length === 1 && media[0].body.media.length === 5
        && media[0].body.media.every((m) => m.type === 'photo' && /^https:\/\//.test(m.media) && m.caption && m.parse_mode === 'HTML')
        && nav.length === 1 && /Квалификация, подтверждённая официально/.test(nav[0].body.text),
      JSON.stringify(c.map((x) => x.method)));
  }
  {
    queueMock('sendMediaGroup', 400, { ok: false, error_code: 400, description: 'Bad Request: mock failure' });
    const before = callsBefore();
    await postWebhook({ update_id: 9006, callback_query: { id: 'cqd2', from: { id: 8107, first_name: 'C' }, data: 'a:d', message: { message_id: 66, date: 0, chat: { id: 8107, type: 'private' } } } });
    await sleep(150);
    const fallback = mockCalls.slice(before).find((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '8107');
    assertTrue('a:d falls back to a text listing when sendMediaGroup fails',
      fallback && /Квалификация, подтверждённая официально/.test(fallback.body.text) && fallback.body.text.includes('<a href="https://'),
      JSON.stringify(fallback));
  }

  // ---------------- Bot: legacy "services"/"contacts" callback_data still resolve ----------------
  {
    const before = callsBefore();
    await postWebhook({ update_id: 9007, callback_query: { id: 'cql1', from: { id: 8108, first_name: 'C' }, data: 'services', message: { message_id: 67, date: 0, chat: { id: 8108, type: 'private' } } } });
    await postWebhook({ update_id: 9008, callback_query: { id: 'cql2', from: { id: 8108, first_name: 'C' }, data: 'contacts', message: { message_id: 68, date: 0, chat: { id: 8108, type: 'private' } } } });
    await sleep(150);
    // The webhook responds and processes fire-and-forget (see server.js), so
    // two back-to-back posts are not guaranteed to reach the mock in order —
    // correlate by message_id, not array position.
    const edits = mockCalls.slice(before).filter((x) => x.method === 'editMessageText');
    const edit67 = edits.find((x) => x.body.message_id === 67);
    const edit68 = edits.find((x) => x.body.message_id === 68);
    assertTrue('legacy "services" callback_data resolves to the services screen',
      edit67 && (edit67.body.reply_markup.inline_keyboard || []).flat().some((b) => b.callback_data === 's:mezh'),
      JSON.stringify(edit67 && edit67.body));
    assertTrue('legacy "contacts" callback_data resolves to the contacts screen',
      edit68 && /Контакты/.test(edit68.body.text),
      JSON.stringify(edit68 && edit68.body));
  }

  // ---------------- Bot: edit failure falls back to a new message; "not modified" does not duplicate ----------------
  {
    queueMock('editMessageText', 400, { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });
    const before = callsBefore();
    await postWebhook({ update_id: 9009, callback_query: { id: 'cqe1', from: { id: 8109, first_name: 'C' }, data: 'm', message: { message_id: 69, date: 0, chat: { id: 8109, type: 'private' } } } });
    await sleep(150);
    const c = mockCalls.slice(before);
    assertTrue('edit failure (not "not modified") falls back to a new message',
      c.filter((x) => x.method === 'editMessageText').length === 1 && c.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '8109').length === 1,
      JSON.stringify(c.map((x) => x.method)));
  }
  {
    queueMock('editMessageText', 400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified' });
    const before = callsBefore();
    await postWebhook({ update_id: 9010, callback_query: { id: 'cqe2', from: { id: 8110, first_name: 'C' }, data: 'm', message: { message_id: 70, date: 0, chat: { id: 8110, type: 'private' } } } });
    await sleep(150);
    const c = mockCalls.slice(before);
    assertTrue('"message is not modified" is left alone, no duplicate send',
      c.filter((x) => x.method === 'editMessageText').length === 1 && c.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '8110').length === 0,
      JSON.stringify(c.map((x) => x.method)));
    assertTrue('"message is not modified" is not logged as BOT_TG_ERR',
      !main.stdoutBuf.includes('BOT_TG_ERR editMessageText 400 Bad Request: message is not modified'), 'checked');
  }

  // ---------------- Bot: menu rate limit toast after 40 button taps in a minute ----------------
  {
    const chat = 8111;
    for (let i = 0; i < 40; i++) {
      await postWebhook({ update_id: 9100 + i, callback_query: { id: 'cqr' + i, from: { id: chat, first_name: 'R' }, data: 'm', message: { message_id: 1000 + i, date: 0, chat: { id: chat, type: 'private' } } } });
    }
    await sleep(500);
    const before = callsBefore();
    await postWebhook({ update_id: 9200, callback_query: { id: 'cqr40', from: { id: chat, first_name: 'R' }, data: 'm', message: { message_id: 2000, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);
    const c = mockCalls.slice(before);
    assertTrue('the 41st button tap in a minute gets the rate-limit toast and nothing else',
      c.length === 1 && c[0].method === 'answerCallbackQuery' && c[0].body.text === 'Слишком часто. Подождите минуту.',
      JSON.stringify(c));
  }

  // ---------------- Bot: full happy-path lead flow (button service pick, "Меня зовут", contact share, typed comment, submit, double-submit guard) ----------------
  {
    const flowChat = 8120;
    let before = callsBefore();
    await postWebhook({ update_id: 9300, callback_query: { id: 'fl1', from: { id: flowChat, first_name: 'Иван' }, data: 'l', message: { message_id: 71, date: 0, chat: { id: flowChat, type: 'private' } } } });
    await sleep(150);
    let c = mockCalls.slice(before);
    let edit = c.find((x) => x.method === 'editMessageText');
    let flat = edit && edit.body.reply_markup.inline_keyboard.flat();
    assertTrue('l starts the flow: 7-option service picker + cancel, edited in place',
      edit && edit.body.message_id === 71 && flat.length === 8 && flat.some((b) => b.callback_data === 'l:o0') && flat.some((b) => b.callback_data === 'l:x'),
      JSON.stringify(edit && edit.body));

    before = callsBefore();
    await postWebhook({ update_id: 9301, callback_query: { id: 'fl2', from: { id: flowChat, first_name: 'Иван' }, data: 'l:o0', message: { message_id: 71, date: 0, chat: { id: flowChat, type: 'private' } } } });
    await sleep(150);
    c = mockCalls.slice(before);
    edit = c.find((x) => x.method === 'editMessageText');
    flat = edit && edit.body.reply_markup.inline_keyboard.flat();
    assertTrue('l:o0 advances to the name step with a "Меня зовут" shortcut',
      edit && flat.some((b) => b.callback_data === 'l:me' && b.text === 'Меня зовут Иван'),
      JSON.stringify(edit && edit.body));

    before = callsBefore();
    await postWebhook({ update_id: 9302, callback_query: { id: 'fl3', from: { id: flowChat, first_name: 'Иван' }, data: 'l:me', message: { message_id: 71, date: 0, chat: { id: flowChat, type: 'private' } } } });
    await sleep(150);
    c = mockCalls.slice(before);
    const clearKb = c.find((x) => x.method === 'editMessageReplyMarkup');
    const phoneMsg = c.find((x) => x.method === 'sendMessage' && x.body.reply_markup && x.body.reply_markup.keyboard);
    assertTrue('l:me clears the old inline keyboard and sends the phone step with a reply keyboard',
      clearKb && clearKb.body.message_id === 71 && phoneMsg && phoneMsg.body.reply_markup.keyboard[0][0].request_contact === true,
      JSON.stringify(c.map((x) => x.method)));

    before = callsBefore();
    await postWebhook({ update_id: 9303, message: { message_id: 9303, date: 0, chat: { id: flowChat, type: 'private' }, from: { id: flowChat, first_name: 'Иван' }, contact: { phone_number: '+79271112233', first_name: 'Иван' } } });
    await sleep(150);
    c = mockCalls.slice(before);
    const phoneSet = c.find((x) => x.body && /^Телефон: /.test(x.body.text || ''));
    const commentPromptMsg = c.find((x) => x.body && x.body.reply_markup && x.body.reply_markup.inline_keyboard && /необязательно/.test(x.body.text || ''));
    assertTrue('shared contact sets and normalizes the phone, clears the reply keyboard, asks for a comment',
      phoneSet && phoneSet.body.text === 'Телефон: +7 927 111-22-33' && phoneSet.body.reply_markup.remove_keyboard === true && commentPromptMsg,
      JSON.stringify(c.map((x) => ({ m: x.method, t: x.body && x.body.text }))));

    before = callsBefore();
    await postWebhook({ update_id: 9304, message: { message_id: 9304, date: 0, chat: { id: flowChat, type: 'private' }, from: { id: flowChat, first_name: 'Иван' }, text: 'Нужно размежевать два участка' } });
    await sleep(150);
    c = mockCalls.slice(before);
    const confirmMsg = c.find((x) => x.body && /Проверьте заявку/.test(x.body.text || ''));
    assertTrue('typed comment advances to the confirm screen with the full summary',
      confirmMsg && /Имя: Иван/.test(confirmMsg.body.text) && /Телефон: \+7 927 111-22-33/.test(confirmMsg.body.text)
        && /Услуга: Межевание земельных участков/.test(confirmMsg.body.text) && /Комментарий: Нужно размежевать два участка/.test(confirmMsg.body.text)
        && /политику конфиденциальности/.test(confirmMsg.body.text),
      JSON.stringify(confirmMsg && confirmMsg.body));
    const confirmMessageId = mockCalls.indexOf(confirmMsg) + 1;

    before = callsBefore();
    await postWebhook({ update_id: 9305, callback_query: { id: 'fl4', from: { id: flowChat, first_name: 'Иван', username: 'ivan_test' }, data: 'l:ok', message: { message_id: confirmMessageId, date: 0, chat: { id: flowChat, type: 'private' } } } });
    await sleep(150);
    c = mockCalls.slice(before);
    const toLead = c.filter((x) => x.method === 'sendMessage' && ['111', '222'].includes(String(x.body.chat_id)));
    const sentEdit = c.find((x) => x.method === 'editMessageText');
    assertTrue('l:ok delivers to both lead chats with the bot title, Telegram link, no Страница line',
      toLead.length === 2 && toLead.every((x) => x.body.text.includes('Заявка из бота') && x.body.text.includes('Имя: Иван')
        && x.body.text.includes('Услуга: Межевание земельных участков') && x.body.text.includes('Сообщение: Нужно размежевать два участка')
        && x.body.text.includes('tg://user?id=' + flowChat) && x.body.text.includes('@ivan_test') && !x.body.text.includes('Страница:')),
      JSON.stringify(toLead.map((x) => x.body.text)));
    assertTrue('l:ok edits the confirm message to the sent screen',
      sentEdit && sentEdit.body.message_id === confirmMessageId && /Заявка отправлена/.test(sentEdit.body.text)
        && /Если нужно, опишите задачу подробнее — напишите сюда же\./.test(sentEdit.body.text),
      JSON.stringify(sentEdit && sentEdit.body));
    assertTrue('lead delivery is logged as BOT_LEAD_OK', main.stdoutBuf.includes('BOT_LEAD_OK'), 'checked');

    before = callsBefore();
    await postWebhook({ update_id: 9306, callback_query: { id: 'fl5', from: { id: flowChat, first_name: 'Иван' }, data: 'l:ok', message: { message_id: confirmMessageId, date: 0, chat: { id: flowChat, type: 'private' } } } });
    await sleep(150);
    c = mockCalls.slice(before);
    assertTrue('a second l:ok tap on the same message gets the "already sent" toast and sends nothing else',
      c.length === 1 && c[0].method === 'answerCallbackQuery' && c[0].body.text === 'Заявка уже отправлена.',
      JSON.stringify(c));
  }

  // ---------------- Bot: typed name + typed phone path (no buttons past the service pick) ----------------
  {
    const chat = 8130;
    let before = callsBefore();
    await postWebhook({ update_id: 9310, message: { message_id: 9310, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'T' }, text: '/request' } });
    await sleep(150);
    let c = mockCalls.slice(before);
    const pickerMsg = c.find((x) => x.method === 'sendMessage');
    assertTrue('/request starts the flow with a fresh service-picker message', pickerMsg && /Выберите услугу/.test(pickerMsg.body.text), JSON.stringify(c));
    const pickerId = mockCalls.indexOf(pickerMsg) + 1;

    await postWebhook({ update_id: 9311, callback_query: { id: 'tp1', from: { id: chat, first_name: 'T' }, data: 'l:o1', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);

    before = callsBefore();
    await postWebhook({ update_id: 9312, message: { message_id: 9312, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'T' }, text: 'Пётр Петров' } });
    await sleep(150);
    c = mockCalls.slice(before);
    const phoneStep = c.find((x) => x.body && x.body.reply_markup && x.body.reply_markup.keyboard);
    assertTrue('typed name advances straight to the phone step with a reply keyboard',
      phoneStep && /Оставьте номер телефона/.test(phoneStep.body.text), JSON.stringify(c.map((x) => x.method)));

    before = callsBefore();
    await postWebhook({ update_id: 9313, message: { message_id: 9313, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'T' }, text: '8 927 444-55-66' } });
    await sleep(150);
    c = mockCalls.slice(before);
    const phoneSet = c.find((x) => x.body && /^Телефон: /.test(x.body.text || ''));
    assertTrue('typed phone text is normalized the same way as a shared contact',
      phoneSet && phoneSet.body.text === 'Телефон: +7 927 444-55-66', JSON.stringify(c.map((x) => x.body && x.body.text)));
  }

  // ---------------- Bot: invalid typed phone re-asks instead of advancing ----------------
  {
    const chat = 8131;
    await postWebhook({ update_id: 9320, message: { message_id: 9320, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'N' }, text: '/request' } });
    await sleep(120);
    const pickerId = mockCalls.length;
    await postWebhook({ update_id: 9321, callback_query: { id: 'ip1', from: { id: chat, first_name: 'N' }, data: 'l:o0', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(120);
    await postWebhook({ update_id: 9322, message: { message_id: 9322, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'N' }, text: 'Надежда' } });
    await sleep(120);

    let before = callsBefore();
    await postWebhook({ update_id: 9323, message: { message_id: 9323, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'N' }, text: 'позвоните мне как-нибудь' } });
    await sleep(150);
    let c = mockCalls.slice(before);
    assertTrue('an unparseable phone re-asks instead of advancing',
      c.length === 1 && c[0].body.text === botUi.leadFlow.PHONE_INVALID_TEXT, JSON.stringify(c));

    // ---- comment skip (l:skip), continuing the same chat with a valid phone ----
    before = callsBefore();
    await postWebhook({ update_id: 9324, message: { message_id: 9324, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'N' }, text: '+7 927 777-88-99' } });
    await sleep(150);
    c = mockCalls.slice(before);
    const commentMsg = c.find((x) => x.body && /необязательно/.test(x.body.text || ''));
    assertTrue('a valid typed phone (after an invalid one) advances to the comment step', !!commentMsg, JSON.stringify(c.map((x) => x.method)));
    const commentId = mockCalls.indexOf(commentMsg) + 1;

    before = callsBefore();
    await postWebhook({ update_id: 9325, callback_query: { id: 'sk1', from: { id: chat, first_name: 'N' }, data: 'l:skip', message: { message_id: commentId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);
    const edit = mockCalls.slice(before).find((x) => x.method === 'editMessageText');
    assertTrue('l:skip edits straight to confirm with no Комментарий line',
      edit && edit.body.message_id === commentId && /Проверьте заявку/.test(edit.body.text) && !edit.body.text.includes('Комментарий:'),
      JSON.stringify(edit && edit.body));
  }

  // ---------------- Bot: cancel by button (l:x), typed "Отмена" during the phone step, and /start mid-flow ----------------
  {
    const chat = 8140;
    await postWebhook({ update_id: 9330, message: { message_id: 9330, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'X' }, text: '/request' } });
    await sleep(120);
    const pickerId = mockCalls.length;
    const before = callsBefore();
    await postWebhook({ update_id: 9331, callback_query: { id: 'cx1', from: { id: chat, first_name: 'X' }, data: 'l:x', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);
    const c = mockCalls.slice(before);
    const edit = c.find((x) => x.method === 'editMessageText');
    const toast = c.find((x) => x.method === 'answerCallbackQuery');
    assertTrue('l:x cancels: toast "Заявка отменена." and the tapped message turns into the menu',
      toast && toast.body.text === botUi.leadFlow.CANCELLED_TEXT && edit && edit.body.message_id === pickerId
        && edit.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'l'),
      JSON.stringify(c.map((x) => [x.method, x.body && x.body.text && x.body.text.slice(0, 30)])));
  }
  {
    const chat = 8141;
    await postWebhook({ update_id: 9332, message: { message_id: 9332, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'Y' }, text: '/request' } });
    await sleep(120);
    const pickerId = mockCalls.length;
    await postWebhook({ update_id: 9333, callback_query: { id: 'cx2', from: { id: chat, first_name: 'Y' }, data: 'l:o0', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(120);
    await postWebhook({ update_id: 9334, message: { message_id: 9334, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'Y' }, text: 'Яна' } });
    await sleep(120); // now on the phone step, reply keyboard shown

    const before = callsBefore();
    await postWebhook({ update_id: 9335, message: { message_id: 9335, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'Y' }, text: 'Отмена' } });
    await sleep(150);
    const c = mockCalls.slice(before);
    assertTrue('typed "Отмена" during the phone step cancels, removes the reply keyboard, then shows the menu',
      c.length === 2 && c[0].body.text === botUi.leadFlow.CANCELLED_TEXT && c[0].body.reply_markup.remove_keyboard === true
        && c[1].method === 'sendMessage' && c[1].body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'l'),
      JSON.stringify(c));
  }
  {
    const chat = 8142;
    await postWebhook({ update_id: 9336, message: { message_id: 9336, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'Z' }, text: '/request' } });
    await sleep(120);
    const pickerId = mockCalls.length;
    await postWebhook({ update_id: 9337, callback_query: { id: 'cx3', from: { id: chat, first_name: 'Z' }, data: 'l:o0', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(120); // now on the name step: inline keyboard only, no reply keyboard

    const before = callsBefore();
    await postWebhook({ update_id: 9338, message: { message_id: 9338, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'Z' }, text: '/start' } });
    await sleep(150);
    const c = mockCalls.slice(before);
    assertTrue('/start mid-flow cancels silently (no "cancelled" text) and shows the menu',
      c.length === 1 && !/отменена/.test(c[0].body.text) && c[0].body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'l'),
      JSON.stringify(c));
  }

  // ---------------- Bot: flow expiry (BOT_FLOW_TTL_MS) ----------------
  {
    const TTL_PORT = 4173;
    const ttlEnv = Object.assign({}, mainEnv, { BOT_FLOW_TTL_MS: '300' });
    const ttl = await startServer(ttlEnv, TTL_PORT, undefined);
    const TTL = `http://127.0.0.1:${TTL_PORT}`;
    const postTtlWebhook = (update) => fetch(TTL + '/tg/whsecret123', { method: 'POST', headers: webhookHeaders, body: JSON.stringify(update) });
    try {
      const chat = 8150;
      await postTtlWebhook({ update_id: 1, callback_query: { id: 'ttl1', from: { id: chat, first_name: 'E' }, data: 'l', message: { message_id: 90, date: 0, chat: { id: chat, type: 'private' } } } });
      await sleep(150);
      await sleep(500); // past the 300ms TTL
      const before = mockCalls.length;
      await postTtlWebhook({ update_id: 2, callback_query: { id: 'ttl2', from: { id: chat, first_name: 'E' }, data: 'l:o0', message: { message_id: 90, date: 0, chat: { id: chat, type: 'private' } } } });
      await sleep(150);
      const c = mockCalls.slice(before);
      assertTrue('an expired flow treats l:o0 as a stale button: toast, and the tapped message turns into the menu',
        c.length === 2 && c[0].method === 'answerCallbackQuery' && c[0].body.text === 'Заявка устарела — начните заново.'
          && c[1].method === 'editMessageText' && c[1].body.message_id === 90 && c[1].body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'l'),
        JSON.stringify(c));
    } finally {
      stopServer(ttl);
    }
  }

  // ---------------- Bot: owner-chat test mode (goes only to the owner chat, test header) ----------------
  {
    const chat = 222; // one of TG_LEAD_CHAT_IDS
    const ownerFrom = { id: 999111, first_name: 'Owner' };
    await postWebhook({ update_id: 9340, message: { message_id: 9340, date: 0, chat: { id: chat, type: 'private' }, from: ownerFrom, text: '/request' } });
    await sleep(120);
    const pickerId = mockCalls.length;
    await postWebhook({ update_id: 9341, callback_query: { id: 'ow1', from: ownerFrom, data: 'l:o0', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(120);
    await postWebhook({ update_id: 9342, message: { message_id: 9342, date: 0, chat: { id: chat, type: 'private' }, from: ownerFrom, text: 'Тест Тестович' } });
    await sleep(120);

    let before = callsBefore();
    await postWebhook({ update_id: 9343, message: { message_id: 9343, date: 0, chat: { id: chat, type: 'private' }, from: ownerFrom, text: '+7 900 111-22-33' } });
    await sleep(150);
    const commentPromptMsg = mockCalls.slice(before).find((x) => x.body && /необязательно/.test(x.body.text || ''));
    const commentId = mockCalls.indexOf(commentPromptMsg) + 1;

    await postWebhook({ update_id: 9344, callback_query: { id: 'ow2', from: ownerFrom, data: 'l:skip', message: { message_id: commentId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);

    before = callsBefore();
    await postWebhook({ update_id: 9345, callback_query: { id: 'ow3', from: ownerFrom, data: 'l:ok', message: { message_id: commentId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);
    const c = mockCalls.slice(before);
    const toLeadChats = c.filter((x) => x.method === 'sendMessage' && ['111', '222'].includes(String(x.body.chat_id)));
    const edit = c.find((x) => x.method === 'editMessageText');
    assertTrue('owner test submit goes only to the owner chat itself, with the test header',
      toLeadChats.length === 1 && String(toLeadChats[0].body.chat_id) === '222'
        && toLeadChats[0].body.text.includes('🧪') && toLeadChats[0].body.text.includes('Тестовая заявка из бота'),
      JSON.stringify(toLeadChats.map((x) => x.body.text)));
    assertTrue('owner test submit edits to the test-mode sent screen',
      edit && /Тестовая заявка отправлена/.test(edit.body.text) && /не уйдёт/.test(edit.body.text),
      JSON.stringify(edit && edit.body));
  }

  // ---------------- Bot: undelivered lead (mock failure) logs LEAD_UNDELIVERED source=bot, client told to call ----------------
  {
    const chat = 8160;
    await postWebhook({ update_id: 9350, message: { message_id: 9350, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'U' }, text: '/request' } });
    await sleep(120);
    const pickerId = mockCalls.length;
    await postWebhook({ update_id: 9351, callback_query: { id: 'ud1', from: { id: chat, first_name: 'U' }, data: 'l:o0', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(120);
    await postWebhook({ update_id: 9352, message: { message_id: 9352, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'U' }, text: 'Уля' } });
    await sleep(120);

    let before = callsBefore();
    await postWebhook({ update_id: 9353, message: { message_id: 9353, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'U' }, text: '+7 900 222-33-44' } });
    await sleep(150);
    const commentPromptMsg = mockCalls.slice(before).find((x) => x.body && /необязательно/.test(x.body.text || ''));
    const commentId = mockCalls.indexOf(commentPromptMsg) + 1;
    await postWebhook({ update_id: 9354, callback_query: { id: 'ud2', from: { id: chat, first_name: 'U' }, data: 'l:skip', message: { message_id: commentId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);

    mockFail = true;
    before = callsBefore();
    await postWebhook({ update_id: 9355, callback_query: { id: 'ud3', from: { id: chat, first_name: 'U' }, data: 'l:ok', message: { message_id: commentId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);
    mockFail = false;
    const edit = mockCalls.slice(before).find((x) => x.method === 'editMessageText');
    assertTrue('undelivered bot lead is logged with source=bot',
      main.stdoutBuf.includes('LEAD_UNDELIVERED') && main.stdoutBuf.includes('"source":"bot"'), 'checked log');
    assertTrue('undelivered bot lead edits to a call-us message with contacts',
      edit && /Не получилось передать заявку инженеру/.test(edit.body.text), JSON.stringify(edit && edit.body));
  }

  // ---------------- Bot: a 429 on one lead-chat send retries once, still delivers exactly once per chat ----------------
  {
    const chat = 8170;
    await postWebhook({ update_id: 9360, message: { message_id: 9360, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'R' }, text: '/request' } });
    await sleep(120);
    const pickerId = mockCalls.length;
    await postWebhook({ update_id: 9361, callback_query: { id: 'rt1', from: { id: chat, first_name: 'R' }, data: 'l:o0', message: { message_id: pickerId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(120);
    await postWebhook({ update_id: 9362, message: { message_id: 9362, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'R' }, text: 'Рома' } });
    await sleep(120);

    let before = callsBefore();
    await postWebhook({ update_id: 9363, message: { message_id: 9363, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'R' }, text: '+7 900 333-44-55' } });
    await sleep(150);
    const commentPromptMsg = mockCalls.slice(before).find((x) => x.body && /необязательно/.test(x.body.text || ''));
    const commentId = mockCalls.indexOf(commentPromptMsg) + 1;
    await postWebhook({ update_id: 9364, callback_query: { id: 'rt2', from: { id: chat, first_name: 'R' }, data: 'l:skip', message: { message_id: commentId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(150);

    queueMock('sendMessage', 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry later', parameters: { retry_after: 1 } }, 1);
    before = callsBefore();
    await postWebhook({ update_id: 9365, callback_query: { id: 'rt3', from: { id: chat, first_name: 'R' }, data: 'l:ok', message: { message_id: commentId, date: 0, chat: { id: chat, type: 'private' } } } });
    await sleep(2500); // past the retry's ~1s wait
    const toLeadChats = mockCalls.slice(before).filter((x) => x.method === 'sendMessage' && ['111', '222'].includes(String(x.body.chat_id)));
    const by111 = toLeadChats.filter((x) => String(x.body.chat_id) === '111').length;
    const by222 = toLeadChats.filter((x) => String(x.body.chat_id) === '222').length;
    assertTrue('a 429 on one lead-chat send retries once and still delivers exactly once per chat',
      toLeadChats.length === 3 && by111 >= 1 && by222 >= 1 && by111 + by222 === 3,
      JSON.stringify(toLeadChats.map((x) => x.body.chat_id)));
  }

  // =====================================================================
  // Second pass (bti-lab/bot-ux/FIXES.md, section A). Every block below
  // reproduces a reviewer finding and failed on the pre-fix code.
  // =====================================================================

  let tMid = 60000;
  const tFrom = (chat, extra) => Object.assign({ id: chat, first_name: 'Тест' }, extra || {});
  function tMsg(chat, text, extra) {
    tMid += 1;
    const e = extra || {};
    const m = Object.assign({ message_id: tMid, date: 0, chat: { id: chat, type: 'private' } }, e, { from: tFrom(chat, e.from) });
    if (text !== null && text !== undefined) m.text = text;
    return { update_id: tMid, message: m };
  }
  function tCb(chat, data, messageId, extra) {
    tMid += 1;
    const e = extra || {};
    return { update_id: tMid, callback_query: { id: 'tcb' + tMid, from: tFrom(chat, e.from), data, message: { message_id: messageId, date: 0, chat: { id: chat, type: 'private' } } } };
  }
  const msgIdOf = (call) => mockCalls.indexOf(call) + 1;
  const toLeadChats = (calls) => calls.filter((x) => x.body && ['111', '222'].includes(String(x.body.chat_id)));
  const sentTo = (calls, chat) => calls.filter((x) => x.method === 'sendMessage' && String(x.body && x.body.chat_id) === String(chat));
  const hasRemoveKb = (x) => !!(x && x.body && x.body.reply_markup && x.body.reply_markup.remove_keyboard === true);
  const hasReplyKb = (x) => !!(x && x.body && x.body.reply_markup && x.body.reply_markup.keyboard);
  const kbData = (x) => ((x && x.body && x.body.reply_markup && x.body.reply_markup.inline_keyboard) || []).flat().map((b) => b.callback_data || b.url);
  const isMenu = (x) => !!x && ['l', 's', 'p', 'c'].every((d) => kbData(x).includes(d));
  const toasts = (calls) => calls.filter((x) => x.method === 'answerCallbackQuery');
  const STALE = 'Заявка устарела — начните заново.';
  const CANCELLED = 'Заявка отменена.';
  const FORWARD_ACK = 'Сообщение передано. Кадастровый инженер свяжется с вами.\nЕсли не указали телефон — напишите его сюда же.';

  // Drives one chat through the lead flow up to the named step; returns the
  // message ids of the prompts it saw (the mock's message_id = call index + 1).
  function driverFor(post) {
    async function hit(update, wait) {
      const before = callsBefore();
      await post(update);
      await sleep(wait || 150);
      return mockCalls.slice(before);
    }
    async function driveFlow(chat, upTo, opts) {
      const o = opts || {};
      const ex = o.from ? { from: o.from } : undefined;
      const ids = {};
      let c = await hit(tMsg(chat, '/request', ex));
      ids.picker = msgIdOf(c.find((x) => x.method === 'sendMessage' && /Выберите услугу/.test(x.body.text || '')));
      if (upTo === 'service') return ids;
      await hit(tCb(chat, 'l:o' + (o.option || 0), ids.picker, ex));
      if (upTo === 'name') return ids;
      c = await hit(tMsg(chat, o.name || 'Иван', ex));
      ids.phone = msgIdOf(c.find(hasReplyKb));
      if (upTo === 'phone') return ids;
      c = await hit(tMsg(chat, o.phone || '+7 927 000-11-22', ex));
      ids.comment = msgIdOf(c.find((x) => /необязательно/.test((x.body && x.body.text) || '')));
      if (upTo === 'comment') return ids;
      c = await hit(tMsg(chat, o.comment || 'Комментарий к заявке', ex));
      ids.confirm = msgIdOf(c.find((x) => /Проверьте заявку/.test((x.body && x.body.text) || '')));
      return ids;
    }
    return { hit, driveFlow };
  }
  const D = driverFor(postWebhook);

  async function withServer(extraEnv, port, fn) {
    const srv = await startServer(Object.assign({}, mainEnv, extraEnv), port, undefined);
    const base = `http://127.0.0.1:${port}`;
    const post = (update) => fetch(base + '/tg/whsecret123', { method: 'POST', headers: webhookHeaders, body: JSON.stringify(update) });
    try { await fn({ srv, base, post }); } finally { stopServer(srv); }
  }

  // ---------------- A1: what the flow step doesn't take goes the out-of-flow way (lead bucket, albums, one reply) ----------------
  {
    const chat = 8301;
    await D.driveFlow(chat, 'service');
    const before = callsBefore();
    for (let i = 0; i < 60; i++) await postWebhook(tMsg(chat, 'текст на шаге выбора услуги ' + i));
    await sleep(900);
    const c = mockCalls.slice(before);
    const by111 = c.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '111').length;
    const by222 = c.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '222').length;
    assertTrue('A1: 60 texts at the button-only service step reach each lead chat at most 5 times', by111 >= 1 && by111 <= 5 && by222 >= 1 && by222 <= 5, `111=${by111} 222=${by222}`);
  }
  {
    const chat = 8302;
    await D.driveFlow(chat, 'comment');
    const before = callsBefore();
    for (let i = 0; i < 3; i++) await postWebhook(tMsg(chat, null, { media_group_id: 'A1G', photo: [{ file_id: 'a1p' + i, file_unique_id: 'a1u' + i, width: 90, height: 90 }] }));
    await sleep(500);
    const c = mockCalls.slice(before);
    const fwd = c.filter((x) => x.method === 'forwardMessage').length;
    const replies = sentTo(c, chat).length;
    assertTrue('A1: a 3-photo album at the comment step: 6 forwards and exactly 1 reply', fwd === 6 && replies === 1, `forwards=${fwd} replies=${replies}`);
    const c2 = await D.hit(tMsg(chat, 'Комментарий после альбома'));
    assertTrue('A1: the album neither resets nor advances the flow (a typed comment still reaches the confirm screen)',
      c2.some((x) => /Проверьте заявку/.test((x.body && x.body.text) || '') && /Комментарий после альбома/.test(x.body.text)), JSON.stringify(c2.map((x) => x.method)));
  }

  // ---------------- A2: the documents album has its own 3-a-minute window ----------------
  {
    const chat = 8303;
    const before = callsBefore();
    for (let i = 0; i < 5; i++) { await postWebhook(tCb(chat, 'a:d', 500 + i)); await sleep(80); }
    await sleep(300);
    const c = mockCalls.slice(before);
    const albumsSent = c.filter((x) => x.method === 'sendMediaGroup').length;
    const limited = toasts(c).filter((x) => x.body.text === 'Слишком часто. Подождите минуту.').length;
    assertTrue('A2: 5 a:d taps in a minute: 3 albums, the other 2 get the rate toast', albumsSent === 3 && limited === 2, `albums=${albumsSent} toasts=${limited}`);
  }

  // ---------------- A3: reply keyboard lifecycle, typed "Отмена" everywhere ----------------
  {
    const chat = 8304;
    await D.driveFlow(chat, 'phone');
    const c = await D.hit(tCb(chat, 'l', 9001));
    const mine = sentTo(c, chat);
    const notice = mine.find((x) => x.body.text === 'Начинаем заново.' && hasRemoveKb(x));
    const picker = mine.find((x) => /Выберите услугу/.test(x.body.text || ''));
    assertTrue('A3: restart (l) at the phone step: "Начинаем заново." with remove_keyboard, then a fresh picker below it',
      notice && picker && mine.indexOf(notice) < mine.indexOf(picker), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }
  {
    const chat = 8305;
    await D.driveFlow(chat, 'phone');
    const c = await D.hit(tCb(chat, 'l:x', 9002));
    assertTrue('A3: l:x while the reply keyboard is up removes it with "Заявка отменена."',
      sentTo(c, chat).some((x) => x.body.text === CANCELLED && hasRemoveKb(x)), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }
  {
    const chat = 8306;
    const ids = await D.driveFlow(chat, 'confirm');
    const c = await D.hit(tMsg(chat, 'отмена.'));
    assertTrue('A3: typed "отмена." on the confirm step cancels (not forwarded), then the menu',
      toLeadChats(c).length === 0 && sentTo(c, chat).some((x) => x.body.text === CANCELLED && hasRemoveKb(x)) && sentTo(c, chat).some(isMenu),
      JSON.stringify(c.map((x) => [x.method, x.body && x.body.chat_id, x.body && x.body.text && x.body.text.slice(0, 30)])));
    const c2 = await D.hit(tCb(chat, 'l:ok', ids.confirm), 300);
    assertTrue('A3: after the typed cancel the old "send" button sends nothing', toLeadChats(c2).length === 0 && toasts(c2).some((x) => x.body.text === STALE), JSON.stringify(c2.map((x) => x.method)));
  }
  {
    const chat = 8307;
    await D.driveFlow(chat, 'service');
    const c = await D.hit(tMsg(chat, 'Отмена'));
    assertTrue('A3: typed "Отмена" on the service step cancels (not forwarded)',
      toLeadChats(c).length === 0 && sentTo(c, chat).some((x) => x.body.text === CANCELLED), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }
  await withServer({ BOT_FLOW_TTL_MS: '300' }, 4175, async ({ post }) => {
    const d = driverFor(post);
    const chat = 8308;
    await d.driveFlow(chat, 'phone');
    await sleep(500); // the flow expires; the client still sees the reply keyboard
    let c = await d.hit(tMsg(chat, 'Отмена'));
    assertTrue('A3: "Отмена" from a reply keyboard whose flow expired is not forwarded; keyboard removed, then the menu',
      toLeadChats(c).length === 0 && sentTo(c, chat).some((x) => x.body.text === CANCELLED && hasRemoveKb(x)) && sentTo(c, chat).some(isMenu),
      JSON.stringify(c.map((x) => [x.method, x.body && x.body.chat_id, x.body && x.body.text && x.body.text.slice(0, 30)])));
    await d.driveFlow(chat + 1, 'phone');
    await sleep(500);
    c = await d.hit(tMsg(chat + 1, null, { contact: { phone_number: '79271112233', first_name: 'Тест', user_id: chat + 1 } }));
    const ack = sentTo(c, chat + 1)[0];
    assertTrue('A3: a contact with no live flow is forwarded as a lead; the reply text removes the reply keyboard',
      c.filter((x) => x.method === 'forwardMessage').length === 2 && ack && ack.body.text === FORWARD_ACK && hasRemoveKb(ack),
      JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  });

  // ---------------- A4: the shared hourly cap refuses a bot lead -> logged, client told, flow kept ----------------
  await withServer({}, 4174, async ({ srv, base, post }) => {
    const d = driverFor(post);
    let accepted = 0;
    for (let i = 0; i < 62; i++) {
      const r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.' + (i + 1) }, body: JSON.stringify(validPayload()) });
      if (r.status === 200) accepted++;
    }
    const chat = 8310;
    const ids = await d.driveFlow(chat, 'confirm', { phone: '+7 927 555-00-11' });
    const c = await d.hit(tCb(chat, 'l:ok', ids.confirm), 300);
    const busy = sentTo(c, chat).find((x) => x.body.text === 'Сейчас много обращений. Попробуйте позже или свяжитесь по контактам.');
    const logLine = srv.stdoutBuf.split('\n').find((l) => l.startsWith('LEAD_UNDELIVERED') && l.includes('"reason":"rate_limited"'));
    assertTrue('A4: a bot lead refused by the hourly cap is logged as LEAD_UNDELIVERED rate_limited source=bot with its data',
      accepted === 60 && logLine && logLine.includes('"source":"bot"') && logLine.includes('+7 927 555-00-11'), `accepted=${accepted} ${logLine || srv.stdoutBuf.slice(-300)}`);
    assertTrue('A4: the client gets the busy text with [Контакты] and [← Меню], nothing reaches the lead chats',
      busy && JSON.stringify(kbData(busy)) === JSON.stringify(['c', 'm']) && toLeadChats(c).length === 0, JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
    const c2 = await d.hit(tCb(chat, 'l:ok', ids.confirm), 300);
    assertTrue('A4: the flow stays on confirm: a repeat tap is refused the same way, not "already sent"/stale',
      sentTo(c2, chat).some((x) => x.body.text === (busy && busy.body.text)) && !toasts(c2).some((x) => x.body.text === STALE || x.body.text === 'Заявка уже отправлена.'),
      JSON.stringify(c2.map((x) => [x.method, x.body && x.body.text])));
    const lastBusy = sentTo(c2, chat).find((x) => x.body.text === (busy && busy.body.text));
    const c3 = await d.hit(tCb(chat, 'c', msgIdOf(lastBusy)));
    const c4 = await d.hit(tCb(chat, 'l:ok', ids.confirm), 300);
    assertTrue('A4: [Контакты] on the busy reply shows the contacts and keeps the request for a retry',
      !!lastBusy && c3.some((x) => x.method === 'editMessageText' && x.body.message_id === msgIdOf(lastBusy) && x.body.text.indexOf('<b>Контакты</b>') === 0)
        && sentTo(c4, chat).some((x) => x.body.text === busy.body.text) && !toasts(c4).some((x) => x.body.text === STALE),
      JSON.stringify(c4.map((x) => [x.method, x.body && x.body.text])));
  });

  // ---------------- A5: contact phone through the shared check, names cleaned ----------------
  {
    const variants = [
      ['+375 29 123-45-67 (мама)', {}],
      ['8 800 FLOWERS', {}],
      ['+7 (902) 749-28-01, +7 (917) 769-61-19, +7 (999) 000-00-00', {}],
      ['79271234567', { user_id: 424242 }], // someone else's contact
    ];
    let n = 0;
    for (const [phone, extra] of variants) {
      const chat = 8320 + n++;
      await D.driveFlow(chat, 'phone');
      const c = await D.hit(tMsg(chat, null, { contact: Object.assign({ phone_number: phone, first_name: 'X' }, extra) }));
      const mine = sentTo(c, chat);
      assertTrue(`A5: contact ${JSON.stringify(phone)}${extra.user_id ? ' of another user' : ''} is refused with the phone re-ask, keyboard kept`,
        mine.length === 1 && mine[0].body.text === botUi.leadFlow.PHONE_INVALID_TEXT && !hasRemoveKb(mine[0]), JSON.stringify(mine.map((x) => x.body.text)));
    }
    for (const [label, name] of [['two zero-width spaces', String.fromCharCode(0x200B, 0x200B)], ['digits only', '12345']]) {
      const chat = 8320 + n++;
      await D.driveFlow(chat, 'name');
      const c = await D.hit(tMsg(chat, name));
      const mine = sentTo(c, chat);
      assertTrue(`A5: a name of ${label} is refused, the name step stays`,
        mine.length === 1 && /^Не получилось распознать имя\. Напишите, как к вам обращаться\./.test(mine[0].body.text) && !c.some(hasReplyKb), JSON.stringify(mine.map((x) => x.body.text)));
    }
  }

  // ---------------- A6: per-chat queue — state changes apply in arrival order ----------------
  {
    const chat = 8330;
    await D.driveFlow(chat, 'name');
    mockDelay.editMessageReplyMarkup = 700;
    const before = callsBefore();
    await postWebhook(tMsg(chat, 'Иван')); // name -> clears the picker keyboard (slow) -> phone prompt
    await sleep(150);
    await postWebhook(tMsg(chat, '/cancel'));
    await sleep(1500);
    mockDelay.editMessageReplyMarkup = 0;
    const c = mockCalls.slice(before);
    const phoneAt = c.findIndex(hasReplyKb);
    const cancelAt = c.findIndex((x) => x.method === 'sendMessage' && x.body.text === CANCELLED && hasRemoveKb(x));
    assertTrue('A6: /cancel typed while the name step still waits on Telegram is applied after it (keyboard removed)',
      phoneAt !== -1 && cancelAt > phoneAt, JSON.stringify(c.map((x) => [x.method, x.body && x.body.text && x.body.text.slice(0, 25)])));
    const c2 = await D.hit(tMsg(chat, 'просто текст после отмены'), 300);
    assertTrue('A6: ...and the flow stays cancelled (the next text is forwarded, not read as a phone)',
      toLeadChats(c2).length === 2 && !sentTo(c2, chat).some((x) => x.body.text === botUi.leadFlow.PHONE_INVALID_TEXT), JSON.stringify(c2.map((x) => [x.method, x.body && x.body.text])));
  }
  {
    const chat = 8331;
    const ids = await D.driveFlow(chat, 'name');
    const before = callsBefore();
    await Promise.all([postWebhook(tCb(chat, 'l:me', ids.picker)), postWebhook(tCb(chat, 'l:me', ids.picker))]);
    await sleep(500);
    const c = mockCalls.slice(before);
    assertTrue('A6: a double tap on "Меня зовут": one phone prompt, both taps answered, no stale toast',
      c.filter(hasReplyKb).length === 1 && toasts(c).length === 2 && !toasts(c).some((x) => x.body.text), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }
  {
    const chat = 8332;
    const ids = await D.driveFlow(chat, 'service');
    const before = callsBefore();
    await Promise.all([postWebhook(tCb(chat, 'l:o0', ids.picker)), postWebhook(tCb(chat, 'l:o0', ids.picker))]);
    await sleep(400);
    const c = mockCalls.slice(before);
    const edits = c.filter((x) => x.method === 'editMessageText' && /Как к вам обращаться/.test(x.body.text || ''));
    assertTrue('A6: a double tap on a service option: one name prompt, no stale toast',
      edits.length === 1 && toasts(c).length === 2 && !toasts(c).some((x) => x.body.text), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }
  {
    const chat = 8333;
    const ids = await D.driveFlow(chat, 'comment');
    const before = callsBefore();
    await Promise.all([postWebhook(tCb(chat, 'l:skip', ids.comment)), postWebhook(tCb(chat, 'l:skip', ids.comment))]);
    await sleep(400);
    const c = mockCalls.slice(before);
    const edits = c.filter((x) => x.method === 'editMessageText' && /Проверьте заявку/.test(x.body.text || ''));
    assertTrue('A6: a double tap on "Пропустить": one confirm screen, no stale toast',
      edits.length === 1 && toasts(c).length === 2 && !toasts(c).some((x) => x.body.text), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }
  {
    const chat = 8334;
    const ids = await D.driveFlow(chat, 'service');
    queueMock('editMessageText', 400, { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });
    const c = await D.hit(tCb(chat, 'l:o0', ids.picker));
    const fallback = sentTo(c, chat).find((x) => /Как к вам обращаться/.test(x.body.text || ''));
    const c2 = await D.hit(tMsg(chat, 'Иван'));
    const clear = c2.find((x) => x.method === 'editMessageReplyMarkup');
    assertTrue('A6: after a failed edit the fallback message is the live prompt (its buttons are cleared next, not the dead one)',
      fallback && clear && clear.body.message_id === msgIdOf(fallback), `fallback=${fallback && msgIdOf(fallback)} cleared=${clear && clear.body.message_id} picker=${ids.picker}`);
  }

  // ---------------- A7: callback ids are looked up as own keys only ----------------
  {
    const chat = 8340;
    const errBefore = main.stderrBuf.length;
    let c = await D.hit(tCb(chat, 's:constructor', 700));
    assertTrue('A7: s:constructor is answered as an unknown button, no exception',
      toasts(c).length === 1 && toasts(c)[0].body.text === 'Кнопка устарела. Откройте меню: /start', JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
    c = await D.hit(tCb(chat, 's:__proto__:w', 701));
    assertTrue('A7: s:__proto__:w is answered as an unknown button',
      toasts(c).length === 1 && toasts(c)[0].body.text === 'Кнопка устарела. Откройте меню: /start', JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
    c = await D.hit(tCb(chat, 'l:constructor', 702));
    assertTrue('A7: l:constructor -> stale toast and the menu, no flow',
      toasts(c).length === 1 && toasts(c)[0].body.text === STALE && c.some((x) => x.method === 'editMessageText' && isMenu(x)), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
    c = await D.hit(tMsg(chat, 'Иван Иванов'));
    assertTrue('A7: ...no flow with an empty service was created (the next text is forwarded, not read as a name)', toLeadChats(c).length === 2, JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
    c = await D.hit(tCb(chat, 'l:toString', 703));
    assertTrue('A7: l:toString -> stale toast and the menu',
      toasts(c).length === 1 && toasts(c)[0].body.text === STALE && c.some((x) => x.method === 'editMessageText' && isMenu(x)), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
    assertTrue('A7: no handler exception logged', !main.stderrBuf.slice(errBefore).includes('processUpdate error'), main.stderrBuf.slice(errBefore, errBefore + 300));
  }

  // ---------------- A8: "Меня зовут …" label cut by code points ----------------
  {
    const chat = 8341;
    const emojiName = '\u{1F600}'.repeat(32);
    const ids = await D.driveFlow(chat, 'service', { from: { first_name: emojiName } });
    const c = await D.hit(tCb(chat, 'l:o0', ids.picker, { from: { first_name: emojiName } }));
    const edit = c.find((x) => x.method === 'editMessageText');
    const btn = edit && edit.body.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 'l:me');
    const lone = !!btn && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(btn.text);
    assertTrue('A8: a 32-emoji first name gives a 40-code-point label with no half emoji', btn && !lone && Array.from(btn.text).length === 40, btn && JSON.stringify(btn.text));
  }

  // ---------------- A9: the drift guard catches what it used to miss ----------------
  {
    const GEN_FILES = ['gen-bot-content.mjs', 'bot-content.js', 'index.dc.html', 'mezhevanie.dc.html', 'tehplan.dc.html', 'razdel-obedinenie.dc.html', 'Footer.dc.html', 'LeadModal.dc.html'];
    const genIn = (mutate, args) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bti-gen-'));
      try {
        for (const f of GEN_FILES) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(dir, f));
        mutate(dir);
        return spawnSync(process.execPath, [path.join(dir, 'gen-bot-content.mjs')].concat(args), { cwd: dir, encoding: 'utf8' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const editFile = (dir, file, from, to) => {
      const p = path.join(dir, file);
      const s = fs.readFileSync(p, 'utf8');
      if (!s.includes(from)) throw new Error('mutation anchor missing in ' + file + ': ' + from);
      fs.writeFileSync(p, s.replace(from, to));
    };
    const out = (r) => ((r.stderr || '') + (r.stdout || '')).trim().slice(0, 200);
    let r = genIn((dir) => { const p = path.join(dir, 'bot-content.js'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('\n').join('\r\n')); }, ['--check']);
    assertTrue('A9: --check accepts a CRLF working copy of bot-content.js (core.autocrlf)', r.status === 0, out(r));
    r = genIn((dir) => editFile(dir, 'mezhevanie.dc.html', 'const FAQ_BASE = [', 'const FAQ_BASE_X = ['), []);
    assertTrue('A9: a renamed service FAQ_BASE fails the plain generate run', r.status !== 0, out(r));
    r = genIn((dir) => editFile(dir, 'tehplan.dc.html', 'от 5 000 ₽</span>', 'от 5 000 ₽ за помещение</span>'), ['--check']);
    assertTrue('A9: an extended hero price ("от 5 000 ₽ за помещение") fails --check', r.status !== 0, out(r));
    r = genIn((dir) => editFile(dir, 'index.dc.html', 'const REVIEWS = [', 'const REVIEWS = [] ; const REVIEWS_OLD = ['), []);
    assertTrue('A9: an emptied required block (REVIEWS) fails the plain generate run', r.status !== 0, out(r));
  }

  // =====================================================================
  // Second pass, section B (FIXES.md U-items): behaviour seen from Telegram.
  // =====================================================================
  const rowsData = (x) => ((x && x.body && x.body.reply_markup && x.body.reply_markup.inline_keyboard) || []).map((row) => row.map((b) => b.callback_data || b.url));
  const editIn = (calls) => calls.find((x) => x.method === 'editMessageText');

  // ---------------- U1: consent on the confirm screen and in the engineer's copy ----------------
  {
    const chat = 8401;
    const ids = await D.driveFlow(chat, 'confirm');
    const confirm = mockCalls[ids.confirm - 1];
    assertTrue('U1: the confirm screen ends with the site consent sentence and its policy link; the send button is "Согласен, отправить"',
      confirm && confirm.body.text.endsWith('Я согласен на обработку персональных данных и принимаю <a href="https://kadastrhelp.ru/politika">политику конфиденциальности</a>')
        && JSON.stringify(confirm.body.reply_markup.inline_keyboard[0]) === JSON.stringify([{ text: 'Согласен, отправить', callback_data: 'l:ok' }]),
      confirm && confirm.body.text.slice(-180));
    const c = await D.hit(tCb(chat, 'l:ok', ids.confirm), 300);
    const leads = toLeadChats(c).filter((x) => x.method === 'sendMessage');
    const lines = leads.length ? leads[0].body.text.split('\n') : [];
    const tgAt = lines.findIndex((l) => l.indexOf('Telegram: ') === 0);
    assertTrue('U1: the engineer copy has the consent line right after the Telegram: line',
      leads.length === 2 && tgAt !== -1 && lines[tgAt + 1] === 'Согласие на обработку персональных данных: дано в боте', JSON.stringify(lines));
    // The site leads sent earlier in this run (the hourly cap is spent by now).
    const site = mockCalls.filter((x) => x.method === 'sendMessage' && ((x.body && x.body.text) || '').indexOf('🆕 <b>Заявка с сайта</b>') === 0);
    assertTrue('U1: site leads carry no bot consent line',
      site.length >= 2 && site.every((x) => !x.body.text.includes('Согласие на обработку')), site.length + ' site leads');
  }

  // ---------------- A6: four concurrent "send" taps deliver once ----------------
  {
    const chat = 8409;
    const ids = await D.driveFlow(chat, 'confirm');
    const before = callsBefore();
    await Promise.all([0, 1, 2, 3].map(() => postWebhook(tCb(chat, 'l:ok', ids.confirm))));
    await sleep(500);
    const c = mockCalls.slice(before);
    const leads = toLeadChats(c).filter((x) => x.method === 'sendMessage');
    const already = toasts(c).filter((x) => x.body.text === 'Заявка уже отправлена.').length;
    assertTrue('A6: 4 concurrent l:ok taps: one lead per lead chat, the other 3 taps told "already sent"',
      leads.length === 2 && already === 3 && toasts(c).length === 4, `leads=${leads.length} already=${already}`);
  }

  // ---------------- U13: the name prompt names the service ----------------
  {
    const chat = 8402;
    const ids = await D.driveFlow(chat, 'service');
    let c = await D.hit(tCb(chat, 'l:o6', ids.picker));
    let e = editIn(c);
    assertTrue('U13: name prompt after "Другое / не знаю точно"', e && e.body.text === 'Услуга: Другое / не знаю точно\n\nКак к вам обращаться?', JSON.stringify(e && e.body.text));
    c = await D.hit(tCb(chat, 'l:mezh', 9101));
    e = editIn(c);
    assertTrue('U13: l:<id> opens the name step with its service named', e && e.body.text.indexOf('Услуга: Межевание земельных участков\n\nКак к вам обращаться?') === 0, JSON.stringify(e && e.body.text));
    // A service without a page of its own (owner, 04.10.2026) starts the same way.
    c = await D.hit(tCb(chat, 'l:vynos', 9102));
    e = editIn(c);
    assertTrue('U13: l:vynos (no page of its own) opens the name step with "Вынос точек в натуру"', e && e.body.text.indexOf('Услуга: Вынос точек в натуру\n\nКак к вам обращаться?') === 0, JSON.stringify(e && e.body.text));
  }

  // ---------------- U4: "Изменить" changes one field and comes back ----------------
  {
    const chat = 8403;
    const ids = await D.driveFlow(chat, 'confirm', { name: 'Олег', phone: '+7 927 000-00-0', comment: 'Межевание дачи' });
    let c = await D.hit(tCb(chat, 'l:e', ids.confirm));
    let e = editIn(c);
    assertTrue('U4: l:e turns the confirm message into "Что изменить?" with the four fields and "← К заявке"',
      e && e.body.message_id === ids.confirm && e.body.text === '<b>Что изменить?</b>'
        && JSON.stringify(rowsData(e)) === JSON.stringify([['l:e:s', 'l:e:n'], ['l:e:p', 'l:e:c'], ['l:b']]),
      JSON.stringify(e && [e.body.text, rowsData(e)]));
    c = await D.hit(tCb(chat, 'l:e:p', ids.confirm));
    assertTrue('U4: l:e:p asks for the phone again with the reply keyboard', c.some(hasReplyKb), JSON.stringify(c.map((x) => x.method)));
    c = await D.hit(tMsg(chat, '8 927 000-00-01'));
    const echo = sentTo(c, chat).find((x) => /^Телефон: /.test(x.body.text || ''));
    const confirm2 = sentTo(c, chat).find((x) => /Проверьте заявку/.test(x.body.text || ''));
    assertTrue('U4: the corrected phone goes straight back to the confirm screen, the other fields kept',
      echo && hasRemoveKb(echo) && confirm2 && confirm2.body.text.includes('Телефон: +7 927 000-00-01') && confirm2.body.text.includes('Имя: Олег')
        && confirm2.body.text.includes('Комментарий: Межевание дачи') && confirm2.body.text.includes('Услуга: Межевание земельных участков')
        && !sentTo(c, chat).some((x) => /необязательно/.test(x.body.text || '')),
      JSON.stringify(sentTo(c, chat).map((x) => x.body.text)));
    const confirm2Id = msgIdOf(confirm2);

    await D.hit(tCb(chat, 'l:e', confirm2Id));
    c = await D.hit(tCb(chat, 'l:e:s', confirm2Id));
    e = editIn(c);
    assertTrue('U4: l:e:s shows the service picker in place', e && e.body.message_id === confirm2Id && /Выберите услугу/.test(e.body.text), JSON.stringify(e && e.body.text));
    c = await D.hit(tCb(chat, 'l:o1', confirm2Id));
    e = editIn(c);
    assertTrue('U4: the new service returns to the confirm screen, the other fields kept',
      e && /Проверьте заявку/.test(e.body.text) && e.body.text.includes('Услуга: Технический план объекта недвижимости')
        && e.body.text.includes('Телефон: +7 927 000-00-01') && e.body.text.includes('Имя: Олег') && e.body.text.includes('Комментарий: Межевание дачи'),
      JSON.stringify(e && e.body.text));

    let before = callsBefore();
    await Promise.all([postWebhook(tCb(chat, 'l:e', confirm2Id)), postWebhook(tCb(chat, 'l:e', confirm2Id))]);
    await sleep(400);
    const dbl = mockCalls.slice(before);
    assertTrue('U4: a double tap on "Изменить": one "Что изменить?" screen, both taps answered without a toast',
      dbl.filter((x) => x.method === 'editMessageText').length === 1 && toasts(dbl).length === 2 && !toasts(dbl).some((x) => x.body.text),
      JSON.stringify(dbl.map((x) => [x.method, x.body && x.body.text])));
    c = await D.hit(tCb(chat, 'l:b', confirm2Id));
    e = editIn(c);
    assertTrue('U4: l:b goes back to the unchanged confirm screen', e && /Проверьте заявку/.test(e.body.text) && e.body.text.includes('Имя: Олег'), JSON.stringify(e && e.body.text));

    await D.hit(tCb(chat, 'l:e', confirm2Id));
    await D.hit(tCb(chat, 'l:e:n', confirm2Id));
    c = await D.hit(tMsg(chat, 'Олег Петров'));
    const confirm3 = sentTo(c, chat).find((x) => /Проверьте заявку/.test(x.body.text || ''));
    assertTrue('U4: a typed new name goes straight back to the confirm screen (no phone step again)',
      confirm3 && confirm3.body.text.includes('Имя: Олег Петров') && !c.some(hasReplyKb), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));

    c = await D.hit(tCb(chat, 'l:ok', msgIdOf(confirm3)), 300);
    const leads = toLeadChats(c).filter((x) => x.method === 'sendMessage');
    assertTrue('U4: the sent lead has the corrected phone, service and name and the kept comment',
      leads.length === 2 && leads[0].body.text.includes('>+7 927 000-00-01</a>') && leads[0].body.text.includes('Услуга: Технический план объекта недвижимости')
        && leads[0].body.text.includes('Имя: Олег Петров') && leads[0].body.text.includes('Сообщение: Межевание дачи'),
      JSON.stringify(leads.map((x) => x.body.text)));
    c = await D.hit(tCb(chat, 'l:e:p', confirm2Id));
    // Third pass, G2: once sent, a flow button only says so (was: stale toast and the menu in place).
    assertTrue('U4: an edit button left from before the send only gets the "already sent" toast, nothing is redrawn',
      c.length === 1 && toasts(c).length === 1 && toasts(c)[0].body.text === 'Заявка уже отправлена.' && !c.some(hasReplyKb),
      JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }
  {
    const chat = 8404;
    const ids = await D.driveFlow(chat, 'confirm', { comment: 'Этот комментарий уберу' });
    await D.hit(tCb(chat, 'l:e', ids.confirm));
    let c = await D.hit(tCb(chat, 'l:e:c', ids.confirm));
    let e = editIn(c);
    assertTrue('U4: l:e:c shows the comment prompt in place', e && /необязательно/.test(e.body.text) && kbData(e).includes('l:skip'), JSON.stringify(e && e.body.text));
    c = await D.hit(tCb(chat, 'l:skip', ids.confirm));
    e = editIn(c);
    assertTrue('U4: "Пропустить" while changing the comment means no comment', e && /Проверьте заявку/.test(e.body.text) && !e.body.text.includes('Комментарий:'), JSON.stringify(e && e.body.text));
    c = await D.hit(tCb(chat, 'l:skip', ids.confirm));
    assertTrue('U4: a repeated "Пропустить" on the same message changes nothing and shows no toast',
      toasts(c).length === 1 && !toasts(c)[0].body.text && !c.some((x) => x.method === 'editMessageText'), JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
  }

  // ---------------- U15: a foreign contact number without "+" ----------------
  {
    const chat = 8405;
    await D.driveFlow(chat, 'phone');
    const c = await D.hit(tMsg(chat, null, { contact: { phone_number: '375291234567', first_name: 'Тест', user_id: chat } }));
    const echo = sentTo(c, chat).find((x) => /^Телефон: /.test(x.body.text || ''));
    assertTrue('U15: the sender\'s own foreign contact is taken with "+", echoed as plain text',
      echo && echo.body.text === 'Телефон: +375291234567' && !echo.body.parse_mode && hasRemoveKb(echo), JSON.stringify(echo && echo.body));
  }

  // ---------------- U6 / U2 / U5 / U12: navigation screens ----------------
  {
    const chat = 8406;
    let c = await D.hit(tCb(chat, 'h', 9201));
    let e = editIn(c);
    assertTrue('U6: h ends with [Что вы получите на руки -> h:d] and [Оставить заявку][← Меню]',
      e && JSON.stringify(rowsData(e)) === JSON.stringify([['h:d'], ['l', 'm']]) && e.body.reply_markup.inline_keyboard[0][0].text === 'Что вы получите на руки',
      JSON.stringify(e && rowsData(e)));
    c = await D.hit(tCb(chat, 'h:d', 9201));
    e = editIn(c);
    assertTrue('U6: h:d shows what the client gets, then [Оставить заявку] and [← Как мы работаем][← Меню]',
      e && e.body.text.indexOf('<b>Что вы получите на руки</b>') === 0 && JSON.stringify(rowsData(e)) === JSON.stringify([['l'], ['h', 'm']]),
      JSON.stringify(e && [e.body.text.slice(0, 60), rowsData(e)]));
    c = await D.hit(tCb(chat, 'f', 9202));
    e = editIn(c);
    const fRows = rowsData(e);
    assertTrue('U5: f lists the questions numbered in the text, number buttons three to a row, then [Оставить заявку][← Меню]',
      e && e.body.text.includes('\n1. ') && JSON.stringify(fRows[0]) === JSON.stringify(['q0', 'q1', 'q2']) && JSON.stringify(fRows[fRows.length - 1]) === JSON.stringify(['l', 'm'])
        && e.body.reply_markup.inline_keyboard[0][0].text === '1',
      JSON.stringify(fRows));
    c = await D.hit(tCb(chat, 'q0', 9202));
    e = editIn(c);
    assertTrue('U2: a FAQ answer has [Оставить заявку] and [← Вопросы][← Меню]', e && JSON.stringify(rowsData(e)) === JSON.stringify([['l'], ['f', 'm']]), JSON.stringify(rowsData(e)));
    c = await D.hit(tCb(chat, 's:mezh:w', 9203));
    e = editIn(c);
    assertTrue('U2: s:<id>:w has [Оставить заявку -> l:<id>] and [← Услуга][← Меню]', e && JSON.stringify(rowsData(e)) === JSON.stringify([['l:mezh'], ['s:mezh', 'm']]), JSON.stringify(rowsData(e)));
    c = await D.hit(tCb(chat, 'c', 9204));
    e = editIn(c);
    assertTrue('U12: contacts show the ОГРНИП/ИНН line and the policy button on its own row',
      e && e.body.text.includes('ОГРНИП 322028000178258 · ИНН 026802515953')
        && e.body.reply_markup.inline_keyboard.some((row) => row.length === 1 && row[0].url === 'https://kadastrhelp.ru/politika' && row[0].text === 'Политика конфиденциальности ↗'),
      JSON.stringify(e && rowsData(e)));
  }

  // =====================================================================
  // Third pass (final review, items G1-G9). Every block below failed on
  // the code before it (bti-lab/bot-ux/snapshot-pass2).
  // =====================================================================
  const ALREADY_SENT = 'Заявка уже отправлена.';
  const CHAT_CAP_TEXT = 'Слишком много заявок подряд. Попробуйте позже или свяжитесь по контактам.';
  const NAME_INVALID_RE = /^Не получилось распознать имя\. Напишите, как к вам обращаться\./;
  const TG_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'tg-spoiler', 'blockquote']);
  // Telegram's parse_mode=HTML rules: allowed tags only, balanced, <a> with
  // just href, every "&" an entity, no stray "<" or ">".
  function tgHtmlOk(text) {
    const stack = [];
    for (let i = 0; i < text.length;) {
      const ch = text[i];
      if (ch === '&') {
        const m = /^&(?:amp|lt|gt|quot|#39|#\d+);/.exec(text.slice(i));
        if (!m) return false;
        i += m[0].length;
      } else if (ch === '<') {
        const end = text.indexOf('>', i);
        if (end === -1) return false;
        const inner = text.slice(i + 1, end);
        const closing = inner[0] === '/';
        const name = (closing ? inner.slice(1) : inner).split(' ')[0].toLowerCase();
        if (!TG_TAGS.has(name)) return false;
        if (closing) {
          if (stack.pop() !== name) return false;
        } else {
          if (name === 'a' && !/^a href="[^"<>]*"$/.test(inner)) return false;
          stack.push(name);
        }
        i = end + 1;
      } else if (ch === '>') {
        return false;
      } else {
        i += 1;
      }
    }
    return stack.length === 0;
  }
  const loneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(s || ''));
  // What the client reads: entities decoded only when the message is HTML.
  const visibleText = (x) => {
    const t = (x && x.body && x.body.text) || '';
    if (x.body.parse_mode !== 'HTML') return t;
    return t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  };
  const leadSendsIn = (calls) => toLeadChats(calls).filter((x) => x.method === 'sendMessage');

  // ---------------- G1: "send" on the confirm screen of a flow that was replaced sends nothing ----------------
  await withServer({}, 4176, async ({ srv, post }) => {
    const d = driverFor(post);
    const chat = 8501;
    const first = await d.driveFlow(chat, 'confirm', { option: 0, name: 'Иван', phone: '+7 902 123-45-67', comment: 'Межевание дачи' });
    // Restart from an older message's "Оставить заявку": flow 1's confirm screen keeps its buttons.
    await d.hit(tCb(chat, 'l', 95001));
    await d.hit(tCb(chat, 'l:o3', 95001));
    await d.hit(tMsg(chat, 'Пётр'));
    let c = await d.hit(tMsg(chat, '+7 917 000-00-00'));
    const secondConfirm = msgIdOf(c.find((x) => /необязательно/.test((x.body && x.body.text) || '')));
    await d.hit(tCb(chat, 'l:skip', secondConfirm));
    c = await d.hit(tCb(chat, 'l:ok', first.confirm), 300);
    const staleEdit = editIn(c);
    assertTrue('G1: "Согласен, отправить" on the replaced flow\'s confirm screen sends nothing to the lead chats',
      leadSendsIn(c).length === 0 && !srv.stdoutBuf.includes('BOT_LEAD_OK'), JSON.stringify(leadSendsIn(c).map((x) => x.body.text)));
    assertTrue('G1: ...it gets the stale toast and that old confirm screen turns into the menu',
      toasts(c).length === 1 && toasts(c)[0].body.text === STALE && staleEdit && staleEdit.body.message_id === first.confirm && isMenu(staleEdit),
      JSON.stringify(c.map((x) => [x.method, x.body && x.body.message_id, x.body && x.body.text && x.body.text.slice(0, 40)])));
    c = await d.hit(tCb(chat, 'l:ok', secondConfirm), 300);
    const leads = leadSendsIn(c);
    const sentEdit = editIn(c);
    assertTrue('G1: the current flow goes on: its own confirm screen sends Пётр\'s request once per lead chat',
      leads.length === 2 && leads.every((x) => x.body.text.includes('Имя: Пётр') && x.body.text.includes('Услуга: Акт обследования') && !x.body.text.includes('Иван'))
        && sentEdit && sentEdit.body.message_id === secondConfirm && /Заявка отправлена/.test(sentEdit.body.text) && sentEdit.body.text.includes('Имя: Пётр'),
      JSON.stringify(leads.map((x) => x.body.text)));
  });

  // ---------------- G1: on every step, step buttons act only on messages of the current flow ----------------
  {
    const cases = [
      ['service', 'l:o0', 'picker', (c) => !!editIn(c) && /Как к вам обращаться/.test(editIn(c).body.text)],
      ['name', 'l:me', 'picker', (c) => c.some(hasReplyKb)],
      ['comment', 'l:skip', 'comment', (c) => !!editIn(c) && /Проверьте заявку/.test(editIn(c).body.text)],
      ['confirm', 'l:e', 'confirm', (c) => !!editIn(c) && editIn(c).body.text === '<b>Что изменить?</b>'],
      ['edit', 'l:b', 'confirm', (c) => !!editIn(c) && /Проверьте заявку/.test(editIn(c).body.text)],
      ['edit', 'l:e:n', 'confirm', (c) => !!editIn(c) && /Как к вам обращаться/.test(editIn(c).body.text)],
    ];
    let n = 0;
    for (const [step, data, own, works] of cases) {
      const chat = 8510 + n;
      const foreign = 95100 + n;
      n += 1;
      const ids = await D.driveFlow(chat, step === 'edit' ? 'confirm' : step);
      if (step === 'edit') await D.hit(tCb(chat, 'l:e', ids.confirm));
      let c = await D.hit(tCb(chat, data, foreign));
      const e = editIn(c);
      const stale = toasts(c).length === 1 && toasts(c)[0].body.text === STALE && !!e && e.body.message_id === foreign && isMenu(e) && !c.some(hasReplyKb);
      const staleSeen = JSON.stringify(c.map((x) => [x.method, x.body && x.body.message_id, x.body && x.body.text && x.body.text.slice(0, 30)]));
      c = await D.hit(tCb(chat, data, ids[own]));
      assertTrue(`G1: ${data} at the ${step} step on a message this flow never showed: stale toast, that message becomes the menu, the flow stays (the same button on its own prompt still works)`,
        stale && works(c) && !toasts(c).some((x) => x.body.text), staleSeen + ' then ' + JSON.stringify(c.map((x) => [x.method, x.body && x.body.text && x.body.text.slice(0, 30)])));
    }
  }

  // ---------------- G2: after the send every other flow button only says "already sent" ----------------
  await withServer({}, 4177, async ({ srv, post }) => {
    const d = driverFor(post);
    let n = 0;
    for (const second of ['l:e', 'l:b', 'l:skip', 'l:e:p', 'l:me', 'l:o1']) {
      const chat = 8520 + n++;
      const ids = await d.driveFlow(chat, 'confirm');
      const before = callsBefore();
      await post(tCb(chat, 'l:ok', ids.confirm));
      await sleep(30);
      await post(tCb(chat, second, ids.confirm));
      await sleep(600);
      const c = mockCalls.slice(before);
      const leads = leadSendsIn(c);
      const edits = c.filter((x) => x.method === 'editMessageText');
      const t = toasts(c);
      assertTrue(`G2: "Согласен, отправить", then ${second} on the same message: one lead per lead chat, the sent screen stays, the second tap is told "already sent"`,
        leads.length === 2 && new Set(leads.map((x) => String(x.body.chat_id))).size === 2
          && edits.length === 1 && /Заявка отправлена/.test(edits[0].body.text)
          && t.length === 2 && !t[0].body.text && t[1].body.text === ALREADY_SENT
          && sentTo(c, chat).length === 0 && !c.some((x) => x.method === 'editMessageReplyMarkup'),
        JSON.stringify(c.map((x) => [x.method, x.body && x.body.chat_id, x.body && x.body.text && x.body.text.slice(0, 30)])));
    }
    {
      const chat = 8530;
      const ids = await d.driveFlow(chat, 'confirm');
      await d.hit(tCb(chat, 'l:ok', ids.confirm), 300);
      const c = await d.hit(tCb(chat, 'l', ids.confirm));
      const e = editIn(c);
      assertTrue('G2: "Оставить заявку" after the send still starts a new request in place',
        e && e.body.message_id === ids.confirm && /Выберите услугу/.test(e.body.text) && !toasts(c).some((x) => x.body.text), JSON.stringify(c.map((x) => x.method)));
    }
    {
      const chat = 8531;
      const ids = await d.driveFlow(chat, 'confirm', { phone: '+7 927 531-00-00' });
      queueMock('sendMessage', 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 2);
      const before = callsBefore();
      await post(tCb(chat, 'l:ok', ids.confirm));
      await sleep(30);
      await post(tCb(chat, 'l:ok', ids.confirm));
      await post(tCb(chat, 'l:e', ids.confirm));
      await sleep(600);
      const c = mockCalls.slice(before);
      const edits = c.filter((x) => x.method === 'editMessageText');
      const logged = srv.stdoutBuf.split('\n').filter((l) => l.startsWith('LEAD_UNDELIVERED') && l.includes('+7 927 531-00-00'));
      assertTrue('G2: a lead both lead chats refused is not sent again by repeated taps (one attempt per chat, one LEAD_UNDELIVERED)',
        leadSendsIn(c).length === 2 && logged.length === 1, `sends=${leadSendsIn(c).length} logs=${logged.length}`);
      assertTrue('G2: ...the "could not pass it on" screen stays and no tap is told "already sent"',
        edits.length === 1 && /Не получилось передать заявку инженеру/.test(edits[0].body.text)
          && toasts(c).length === 3 && !toasts(c).some((x) => x.body.text),
        JSON.stringify(c.map((x) => [x.method, x.body && x.body.text && x.body.text.slice(0, 30)])));
      const c2 = await d.hit(tMsg(chat, 'Отмена'));
      assertTrue('G2: typed "Отмена" after a failed delivery answers "Заявка отменена.", not "already sent"',
        sentTo(c2, chat).some((x) => x.body.text === CANCELLED && hasRemoveKb(x)) && !sentTo(c2, chat).some((x) => x.body.text === ALREADY_SENT),
        JSON.stringify(c2.map((x) => [x.method, x.body && x.body.text])));
    }
  });

  // ---------------- G3: every forward names its sender with the bot lead's "Telegram:" line ----------------
  {
    for (const [label, chat, from, tgLine] of [
      ['with a username', 8540, { first_name: 'Иван', last_name: 'Петров', username: 'ivan_p' }, 'Telegram: <a href="tg://user?id=8540">@ivan_p</a>'],
      ['without a username', 8541, { first_name: 'Иван', last_name: 'Петров' }, 'Telegram: <a href="tg://user?id=8541">Иван Петров</a>'],
    ]) {
      const leads = toLeadChats(await D.hit(tMsg(chat, 'Сколько стоит межевание?', { from })));
      assertTrue(`G3: a client text (${label}) reaches the engineer as "Сообщение в боте", Имя, the Telegram: line with a tg://user link, then the text`,
        leads.length === 2 && leads.every((x) => x.method === 'sendMessage' && x.body.parse_mode === 'HTML' && tgHtmlOk(x.body.text)
          && x.body.text === ['💬 <b>Сообщение в боте</b>', 'Имя: Иван Петров', tgLine, 'Сколько стоит межевание?'].join('\n')),
        JSON.stringify(leads.map((x) => x.body.text)));
    }
    {
      const chat = 8542;
      const leads = toLeadChats(await D.hit(tMsg(chat, 'hi <b>&amp;', { from: { first_name: '<b>A&B</b>', last_name: '"x\' <i>', username: 'u<x>' } })));
      assertTrue('G3: hostile profile fields are escaped in the header and the HTML stays valid',
        leads.length === 2 && leads.every((x) => tgHtmlOk(x.body.text) && x.body.text.split('\n')[2] === 'Telegram: <a href="tg://user?id=8542">@u&lt;x&gt;</a>'),
        JSON.stringify(leads.map((x) => x.body.text)));
    }
    {
      const chat = 8543;
      const leads = toLeadChats(await D.hit(tMsg(chat, 'Нужен техплан', { from: { id: 'x8543', username: 'no_id_user' } })));
      assertTrue('G3: a sender id that is not a number gets no tg:// link, only the plain Telegram: line',
        leads.length === 2 && leads.every((x) => !x.body.text.includes('tg://') && x.body.text.split('\n').includes('Telegram: @no_id_user') && tgHtmlOk(x.body.text)),
        JSON.stringify(leads.map((x) => x.body.text)));
    }
    const perChat = (calls, cid) => calls.filter((x) => x.body && String(x.body.chat_id) === cid).map((x) => x.method + (x.method === 'sendMessage' ? ':' + x.body.text : ''));
    const headerFor = (chat, name, label) => ['💬 <b>Сообщение в боте</b>', 'Имя: ' + name, 'Telegram: <a href="tg://user?id=' + chat + '">' + label + '</a>'].join('\n');
    {
      const chat = 8544;
      const c = await D.hit(tMsg(chat, null, { from: { first_name: 'Ольга' }, caption: 'План дома', photo: [{ file_id: 'g3p', file_unique_id: 'g3u', width: 90, height: 90 }] }));
      const expect = ['sendMessage:' + headerFor(chat, 'Ольга', 'Ольга'), 'forwardMessage'];
      assertTrue('G3: a photo reaches each lead chat as the same header (one HTML message), then the forward',
        ['111', '222'].every((cid) => JSON.stringify(perChat(c, cid)) === JSON.stringify(expect)) && leadSendsIn(c).every((x) => x.body.parse_mode === 'HTML'),
        JSON.stringify(c.map((x) => [x.method, x.body && x.body.chat_id, x.body && x.body.text])));
    }
    {
      const chat = 8545;
      const c = await D.hit(tMsg(chat, null, { from: { first_name: 'Ольга', username: 'olga_s' }, contact: { phone_number: '79270000045', first_name: 'Ольга', user_id: chat } }));
      const expect = ['sendMessage:' + headerFor(chat, 'Ольга', '@olga_s'), 'forwardMessage'];
      assertTrue('G3: a contact outside the request flow gets the same header before the forward',
        ['111', '222'].every((cid) => JSON.stringify(perChat(c, cid)) === JSON.stringify(expect)), JSON.stringify(c.map((x) => [x.method, x.body && x.body.chat_id])));
    }
    {
      const chat = 8546;
      const before = callsBefore();
      for (let i = 0; i < 3; i++) await postWebhook(tMsg(chat, null, { media_group_id: 'G3ALB', photo: [{ file_id: 'g3a' + i, file_unique_id: 'g3au' + i, width: 90, height: 90 }] }));
      await sleep(500);
      const c = mockCalls.slice(before);
      const expect = ['sendMessage:' + headerFor(chat, 'Тест', 'Тест'), 'forwardMessage', 'forwardMessage', 'forwardMessage'];
      assertTrue('G3: a 3-photo album: one header per lead chat, before its three forwards',
        ['111', '222'].every((cid) => JSON.stringify(perChat(c, cid)) === JSON.stringify(expect)), JSON.stringify(['111', '222'].map((cid) => perChat(c, cid))));
    }
  }

  // ---------------- G4: service messages and blank text are not client messages ----------------
  {
    const chat = 8550;
    for (const [label, extra] of [
      ['auto-delete timer changed', { message_auto_delete_timer_changed: { message_auto_delete_time: 86400 } }],
      ['pinned message', { pinned_message: { message_id: 7, date: 0, chat: { id: chat, type: 'private' }, text: 'x' } }],
      ['new chat title', { new_chat_title: 'Новое название' }],
      ['chat background set', { chat_background_set: { type: { type: 'fill' } } }],
    ]) {
      const c = await D.hit(tMsg(chat, null, extra));
      assertTrue(`G4: a "${label}" service message is ignored: nothing forwarded, no reply`, c.length === 0, JSON.stringify(c.map((x) => [x.method, x.body && x.body.chat_id])));
    }
    for (const [label, text] of [['spaces only', '   '], ['empty', ''], ['newlines and tabs', '\n\t \n']]) {
      const c = await D.hit(tMsg(chat, text));
      assertTrue(`G4: a text of ${label} is ignored`, c.length === 0, JSON.stringify(c.map((x) => x.method)));
    }
    const before = callsBefore();
    for (let i = 0; i < 5; i++) await postWebhook(tMsg(chat, 'настоящее сообщение ' + i));
    await sleep(600);
    const c = mockCalls.slice(before);
    const acks = sentTo(c, chat).filter((x) => x.body.text === FORWARD_ACK).length;
    assertTrue('G4: ...and none of them spent the lead allowance: 5 real messages after the 7 ignored ones are all forwarded and answered',
      toLeadChats(c).length === 10 && acks === 5, `lead=${toLeadChats(c).length} acks=${acks}`);
  }

  // ---------------- G5: blank "letters" do not make a name ----------------
  {
    let n = 0;
    for (const [label, name] of [
      ['U+3164 x2', '\u3164\u3164'], ['U+115F x2', '\u115F\u115F'], ['U+1160', '\u1160'], ['U+FFA0 x2', '\uFFA0\uFFA0'],
      ['all eight blank characters', '\u3164\u115F\u1160\uFFA0\u2800\u17B4\u17B5\u180E'],
    ]) {
      const chat = 8560 + n++;
      await D.driveFlow(chat, 'name');
      const c = await D.hit(tMsg(chat, name));
      const mine = sentTo(c, chat);
      assertTrue(`G5: a name of ${label} is refused with the name re-ask, the step stays`,
        mine.length === 1 && NAME_INVALID_RE.test(mine[0].body.text) && !c.some(hasReplyKb), JSON.stringify(mine.map((x) => x.body.text)));
    }
    const ids = await D.driveFlow(8569, 'confirm', { name: '\u3164Анна\u2800' });
    const confirm = mockCalls[ids.confirm - 1];
    assertTrue('G5: the blank characters are cut from a real name ("\\u3164Анна\\u2800" -> "Анна")',
      confirm && confirm.body.text.split('\n').includes('Имя: Анна'), JSON.stringify(confirm && confirm.body.text.split('\n').slice(0, 3)));
  }

  // ---------------- G6: the "could not pass it on" reply has the way to the menu and real HTML ----------------
  {
    const chat = 8570;
    mockFail = true;
    const c = await D.hit(tMsg(chat, 'Перезвоните мне, 8 927 570-00-00'), 400);
    mockFail = false;
    const reply = sentTo(c, chat).find((x) => /^Не получилось передать сообщение инженеру/.test(x.body.text || ''));
    assertTrue('G6: a failed forward is answered with [← Меню] in HTML parse mode, the contacts with no visible "&amp;"/"&lt;"',
      reply && reply.body.parse_mode === 'HTML' && JSON.stringify(rowsData(reply)) === JSON.stringify([['m']]) && tgHtmlOk(reply.body.text)
        && !/&amp;|&lt;|&gt;|&quot;/.test(visibleText(reply)) && visibleText(reply).includes('Почта: '),
      JSON.stringify(reply && reply.body));
  }

  // ---------------- G7: a cut message never splits an emoji (bot lead, site lead, forward) ----------------
  await withServer({}, 4178, async ({ base, post }) => {
    const d = driverFor(post);
    const longText = (pad) => 'x'.repeat(pad) + '"'.repeat(600) + '\u{1F600}'.repeat((400 - pad) >> 1);
    for (const pad of [0, 1]) {
      const chat = 8580 + pad;
      const ids = await d.driveFlow(chat, 'confirm', { comment: longText(pad) });
      const leads = leadSendsIn(await d.hit(tCb(chat, 'l:ok', ids.confirm), 400));
      assertTrue(`G7: a bot lead whose comment is cut (offset ${pad}) keeps whole emoji, ends with "…" and fits 4096`,
        leads.length === 2 && leads.every((x) => !loneSurrogate(x.body.text) && x.body.text.length <= 4096 && x.body.text.includes('…')),
        leads.map((x) => x.body.text.length + ':' + loneSurrogate(x.body.text)).join(','));
    }
    for (const pad of [0, 1]) {
      const before = callsBefore();
      const r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.' + (70 + pad) }, body: JSON.stringify(validPayload({ message: longText(pad) })) });
      await sleep(100);
      const sends = mockCalls.slice(before).filter((x) => x.method === 'sendMessage');
      assertTrue(`G7: a site lead whose message is cut (offset ${pad}) keeps whole emoji, ends with "…" and fits 4096`,
        r.status === 200 && sends.length === 2 && sends.every((x) => !loneSurrogate(x.body.text) && x.body.text.length <= 4096 && x.body.text.includes('…')),
        r.status + ' ' + sends.map((x) => x.body.text.length + ':' + loneSurrogate(x.body.text)).join(','));
    }
    for (const pad of [0, 1]) {
      const chat = 8582 + pad;
      const text = 'x'.repeat(pad) + 'а'.repeat(3700) + '\u{1F600}'.repeat((396 - pad) >> 1);
      const leads = toLeadChats(await d.hit(tMsg(chat, text), 300));
      assertTrue(`G7: a forwarded client text cut to fit (offset ${pad}) keeps whole emoji`,
        leads.length === 2 && leads.every((x) => !loneSurrogate(x.body.text) && x.body.text.length <= 4096 && x.body.text.endsWith('…')),
        leads.map((x) => x.body.text.length + ':' + loneSurrogate(x.body.text)).join(','));
    }
  });

  // ---------------- G8: the per-chat cap names its wait; the hourly cap logs a request once ----------------
  await withServer({}, 4179, async ({ srv, post }) => {
    const d = driverFor(post);
    const chat = 8590;
    for (let i = 0; i < 5; i++) {
      const ids = await d.driveFlow(chat, 'confirm', { phone: '+7 927 590-00-0' + i });
      await d.hit(tCb(chat, 'l:ok', ids.confirm), 250);
    }
    const ids = await d.driveFlow(chat, 'confirm', { phone: '+7 927 590-00-09' });
    const c = await d.hit(tCb(chat, 'l:ok', ids.confirm), 300);
    const capReply = sentTo(c, chat).find((x) => x.body.text === CHAT_CAP_TEXT);
    const delivered = (srv.stdoutBuf.match(/BOT_LEAD_OK /g) || []).length;
    assertTrue('G8: the 6th request from one chat within 10 minutes: "Слишком много заявок подряд…" with [Контакты] / [← Меню], not "wait a minute", nothing sent',
      delivered === 5 && capReply && JSON.stringify(rowsData(capReply)) === JSON.stringify([['c'], ['m']]) && leadSendsIn(c).length === 0
        && !sentTo(c, chat).some((x) => x.body.text === 'Слишком часто. Подождите минуту.'),
      'delivered=' + delivered + ' ' + JSON.stringify(c.map((x) => [x.method, x.body && x.body.text])));
    const c2 = capReply ? await d.hit(tCb(chat, 'c', msgIdOf(capReply))) : [];
    const c3 = await d.hit(tCb(chat, 'l:ok', ids.confirm), 300);
    assertTrue('G8: ...the request stays: [Контакты] on that reply shows the contacts in place, a repeat tap is refused the same way, not stale',
      c2.some((x) => x.method === 'editMessageText' && x.body.message_id === msgIdOf(capReply) && x.body.text.indexOf('<b>Контакты</b>') === 0)
        && sentTo(c3, chat).some((x) => x.body.text === CHAT_CAP_TEXT) && !toasts(c3).some((x) => x.body.text) && leadSendsIn(c3).length === 0,
      JSON.stringify(c3.map((x) => [x.method, x.body && x.body.text])));
  });
  await withServer({}, 4180, async ({ srv, base, post }) => {
    const d = driverFor(post);
    let accepted = 0;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.' + (i + 1) }, body: JSON.stringify(validPayload()) });
      if (r.status === 200) accepted++;
    }
    const chat = 8595;
    const ids = await d.driveFlow(chat, 'confirm', { phone: '+7 927 595-00-00' });
    for (let i = 0; i < 3; i++) await d.hit(tCb(chat, 'l:ok', ids.confirm), 250);
    const capLines = () => srv.stdoutBuf.split('\n').filter((l) => l.startsWith('LEAD_UNDELIVERED') && l.includes('"reason":"rate_limited"'));
    assertTrue('G8: three taps refused by the hourly cap write one LEAD_UNDELIVERED rate_limited line for the request',
      accepted === 60 && capLines().length === 1 && capLines()[0].includes('+7 927 595-00-00'), `accepted=${accepted} lines=${capLines().length}`);
    await d.hit(tCb(chat, 'l:e', ids.confirm));
    await d.hit(tCb(chat, 'l:e:p', ids.confirm));
    const c = await d.hit(tMsg(chat, '+7 927 595-00-01'));
    const confirm2 = sentTo(c, chat).find((x) => /Проверьте заявку/.test(x.body.text || ''));
    await d.hit(tCb(chat, 'l:ok', msgIdOf(confirm2)), 250);
    await d.hit(tCb(chat, 'l:ok', msgIdOf(confirm2)), 250);
    assertTrue('G8: ...after the client corrects the phone, the corrected request is logged once more (and only once)',
      capLines().length === 2 && capLines()[1].includes('+7 927 595-00-01'), capLines().map((l) => l.slice(0, 120)).join(' | '));
  });

  // ---------------- Cover and album photos come from the bot server, not from the shared hosting ----------------
  // Live test 02.10: Telegram's own fetch of kadastrhelp.ru/assets/... failed for most files ("failed to get HTTP URL
  // content", WEBPAGE_CURL_FAILED), while the same files from the Railway host loaded every time.
  const assetRun = async (extraEnv, port, chat) => {
    let out = null;
    await withServer(extraEnv, port, async ({ post }) => {
      const before = callsBefore();
      await post(tMsg(chat, '/start'));
      await sleep(300);
      await post(tCb(chat, 'a:d', 1));
      await sleep(400);
      const c = mockCalls.slice(before);
      out = {
        menu: c.find((x) => x.method === 'sendMessage' && /Кадастровые документы без лишних нервов/.test((x.body && x.body.text) || '')),
        album: c.find((x) => x.method === 'sendMediaGroup'),
      };
    });
    return out;
  };
  {
    const r = await assetRun({ RAILWAY_PUBLIC_DOMAIN: 'bot.example.up.railway.app', BOT_ASSET_ORIGIN: '' }, 4181, 8601);
    assertTrue('asset origin: with RAILWAY_PUBLIC_DOMAIN the menu cover is fetched from the bot server',
      !!r.menu && r.menu.body.link_preview_options.url === 'https://bot.example.up.railway.app/assets/bot-cover-v2.jpg', JSON.stringify(r.menu && r.menu.body.link_preview_options));
    assertTrue('asset origin: ...and so are the five album photos',
      !!r.album && r.album.body.media.length === 5 && r.album.body.media.every((m) => m.media.indexOf('https://bot.example.up.railway.app/assets/docs/') === 0),
      JSON.stringify(r.album && r.album.body.media.map((m) => m.media)));
  }
  {
    const r = await assetRun({ RAILWAY_PUBLIC_DOMAIN: 'bot.example.up.railway.app', BOT_ASSET_ORIGIN: 'https://assets.example/' }, 4182, 8602);
    assertTrue('asset origin: BOT_ASSET_ORIGIN wins over RAILWAY_PUBLIC_DOMAIN (cover and album)',
      !!r.menu && r.menu.body.link_preview_options.url === 'https://assets.example/assets/bot-cover-v2.jpg'
        && !!r.album && r.album.body.media.every((m) => m.media.indexOf('https://assets.example/assets/docs/') === 0),
      JSON.stringify([r.menu && r.menu.body.link_preview_options, r.album && r.album.body.media.map((m) => m.media)]));
  }
  {
    const r = await assetRun({ RAILWAY_PUBLIC_DOMAIN: '', BOT_ASSET_ORIGIN: 'http://not-https.example/' }, 4183, 8603);
    assertTrue('asset origin: neither variable (or a non-https origin) falls back to the site URL',
      !!r.menu && r.menu.body.link_preview_options.url === 'https://kadastrhelp.ru/assets/bot-cover-v2.jpg'
        && !!r.album && r.album.body.media.every((m) => m.media.indexOf('https://kadastrhelp.ru/assets/docs/') === 0),
      JSON.stringify([r.menu && r.menu.body.link_preview_options, r.album && r.album.body.media.map((m) => m.media)]));
  }

  // ---------------- G9: bot-ui-check notices LM_SERVICES entries trading places on the site ----------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bti-uicheck-'));
    try {
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.mkdirSync(path.join(dir, 'tests'));
      for (const f of ['bot-ui.js', 'bot-content.js', 'server.js', 'index.dc.html', 'mezhevanie.dc.html', 'tehplan.dc.html', 'razdel-obedinenie.dc.html',
        'Footer.dc.html', 'Header.dc.html', path.join('assets', 'contacts.js'), path.join('tests', 'bot-ui-check.mjs')]) {
        fs.copyFileSync(path.join(REPO_ROOT, f), path.join(dir, f));
      }
      const p = path.join(dir, 'bot-content.js');
      const src = fs.readFileSync(p, 'utf8');
      const start = src.indexOf('"leadServices": [');
      const end = src.indexOf(']', start);
      const a = '"Акт обследования (снятие с кадастрового учёта и прекращение права собственности)"';
      const b = '"Акт осмотра объекта (отнесение к признакам объекта капитального строительства)"';
      const block = src.slice(start, end);
      if (start === -1 || !block.includes(a) || !block.includes(b)) throw new Error('G9: leadServices mutation anchors missing');
      fs.writeFileSync(p, src.slice(0, start) + block.replace(a, '@@A@@').replace(b, a).replace('@@A@@', b) + src.slice(end));
      const r = spawnSync(process.execPath, [path.join(dir, 'tests', 'bot-ui-check.mjs')], { cwd: dir, encoding: 'utf8' });
      const fails = (r.stdout || '').split('\n').filter((l) => l.indexOf('[FAIL]') === 0);
      assertTrue('G9: bot-ui-check fails when LM_SERVICES items 3 and 4 trade places on the site (the picker would file requests under the wrong service)',
        r.status !== 0 && fails.length > 0 && fails.every((l) => l.includes('LM_SERVICES')), fails.join(' | ').slice(0, 400) || 'status=' + r.status);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------------- Bot: content generator and bot-ui-check stay green ----------------
  {
    try {
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'gen-bot-content.mjs'), '--check'], { stdio: 'pipe' });
      assertTrue('gen-bot-content.mjs --check exits 0', true);
    } catch (e) {
      assertTrue('gen-bot-content.mjs --check exits 0', false, String((e && e.stdout) || (e && e.message)));
    }
    try {
      execFileSync(process.execPath, [path.join(HERE, 'bot-ui-check.mjs')], { stdio: 'pipe' });
      assertTrue('tests/bot-ui-check.mjs passes as a subprocess', true);
    } catch (e) {
      assertTrue('tests/bot-ui-check.mjs passes as a subprocess', false, String((e && e.stdout) || (e && e.message)));
    }
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
