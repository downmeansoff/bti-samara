#!/usr/bin/env node
'use strict';
// Static checks for bot-ui.js screens and flow prompts: no network, no
// server.js — pure function calls only.
//
//   node tests/bot-ui-check.mjs
//
// Also spawned by tests/lead-e2e.mjs (section 8 of bot-ux SPEC.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);
const botUi = require(path.join(REPO_ROOT, 'bot-ui.js'));
const C = require(path.join(REPO_ROOT, 'bot-content.js'));
const lf = botUi.leadFlow;

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
function assertTrue(name, cond, detail) {
  report(name, !!cond, detail);
}
const cp = (s) => Array.from(String(s)).length; // length in code points, as Telegram counts it
const NBSP = '\u00A0';

// ---------------------------------------------------------------------------
// HTML well-formedness: only the tags Telegram's HTML parse mode allows
// (SPEC.md section 7), unescaped "&"/"<" are errors, code/pre cannot nest.
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'tg-spoiler', 'blockquote']);
const NO_NESTING_INSIDE = new Set(['code', 'pre']);
const TAG_RE = /^<(\/?)([a-zA-Z0-9-]+)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*"(?:[^"\\]|\\.)*")?)*)\s*(\/?)>/;
const ENTITY_RE = /^&(amp|lt|gt|quot|#39|#\d+);/;

function validateHtml(text) {
  let i = 0;
  const stack = [];
  while (i < text.length) {
    const ch = text[i];
    if (ch === '&') {
      const m = ENTITY_RE.exec(text.slice(i));
      if (!m) return { ok: false, error: `unescaped "&" at offset ${i}` };
      i += m[0].length;
      continue;
    }
    if (ch === '<') {
      const m = TAG_RE.exec(text.slice(i));
      if (!m) return { ok: false, error: `malformed/unescaped "<" at offset ${i}: ${JSON.stringify(text.slice(i, i + 24))}` };
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      const selfClose = m[4] === '/';
      if (!ALLOWED_TAGS.has(tag)) return { ok: false, error: `disallowed tag <${tag}>` };
      if (stack.length && NO_NESTING_INSIDE.has(stack[stack.length - 1])) {
        return { ok: false, error: `<${tag}> nested inside <${stack[stack.length - 1]}>` };
      }
      if (closing) {
        if (!stack.length || stack[stack.length - 1] !== tag) return { ok: false, error: `mismatched closing </${tag}>` };
        stack.pop();
      } else if (!selfClose) {
        stack.push(tag);
      }
      i += m[0].length;
      continue;
    }
    if (ch === '>') return { ok: false, error: `stray ">" at offset ${i}` };
    i++;
  }
  if (stack.length) return { ok: false, error: `unclosed tag(s): ${stack.join(',')}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Collect every screen (route) and every flow message as {name, msg, kind}:
//  kind 'nav'    — navigation screens (site facts are traced to the sources);
//  kind 'prompt' — flow step prompts (their way out is the Отмена button);
//  kind 'reply'  — other bot messages that must not be dead ends.
// msg = { text, keyboard? (inline_keyboard) }.
// ---------------------------------------------------------------------------

const SERVICE_IDS = C.serviceOrder;
const ctx = {
  contacts: {
    phones: [
      { region: 'Самарская область', short: 'Самара', display: '8 902 749-28-01', tel: 'tel:+79027492801', max: 'https://max.ru/u/aaa' },
      { region: 'Республика Башкортостан', short: 'Башкирия', display: '8 917 769-61-19', tel: 'tel:+79177696119', max: 'https://max.ru/u/bbb' },
    ],
    telegram: { handle: '@kadastricom_bot', url: 'https://t.me/kadastricom_bot' },
    email: 'baymurzin.86@bk.ru',
    leadApi: 'https://example.invalid/api/lead',
  },
  from: { id: 42, first_name: 'Тест', username: 'test_user' },
};

const LEGACY_ALIASES = new Set(['services', 'contacts']);
const routeStrings = ['m', 's', 'p', 'h', 'h:d', 'a', 'a:p', 'a:d', 'r', 'f', 'c', 'services', 'contacts'];
for (const id of SERVICE_IDS) {
  routeStrings.push('s:' + id, 's:' + id + ':w');
  if (C.services[id].faq.length) {
    routeStrings.push('s:' + id + ':f');
    C.services[id].faq.forEach((_, n) => routeStrings.push('s:' + id + ':q' + n));
  }
}
C.faq.forEach((_, n) => routeStrings.push('q' + n));

const screens = []; // { name, data?, msg, kind }
const screenByData = new Map();
for (const data of routeStrings) {
  const r = botUi.route(data);
  assertTrue(`route(${JSON.stringify(data)}) resolves`, !!r, JSON.stringify(r));
  if (!r) continue;
  const msg = botUi.screen(r, ctx);
  assertTrue(`screen for "${data}" renders`, !!msg, JSON.stringify(r));
  if (!msg) continue;
  screenByData.set(data, msg);
  if (!LEGACY_ALIASES.has(data)) screens.push({ name: 'screen ' + data, data, msg, kind: 'nav' });
}
assertTrue('route(contacts) legacy equals route(c)', JSON.stringify(botUi.route('contacts')) === JSON.stringify(botUi.route('c')));
assertTrue('route(services) legacy equals route(s)', JSON.stringify(botUi.route('services')) === JSON.stringify(botUi.route('s')));
assertTrue('route(unknown garbage) -> null', botUi.route('not-a-real-route') === null);
assertTrue('screen(null, ctx) -> null', botUi.screen(null, ctx) === null);
assertTrue('screen for "c" without contacts.js still renders', !!botUi.screen({ type: 'contacts' }, { contacts: null }));
screens.push({ name: 'screen c (contacts.js missing)', msg: botUi.screen({ type: 'contacts' }, { contacts: null }), kind: 'nav' });

// Callback ids are looked up as own keys only (FIXES A7).
for (const [data, expect] of [
  ['s:constructor', null], ['s:__proto__:w', null], ['s:toString', null], ['s:hasOwnProperty:f', null], ['q99', null], ['s:mezh:q99', null],
  ['l:constructor', 'leadUnknown'], ['l:toString', 'leadUnknown'], ['l:__proto__', 'leadUnknown'], ['l:edit', 'leadUnknown'], ['l:o7', 'leadUnknown'], ['l:zzz', 'leadUnknown'],
  ['h:d', 'howDocs'], ['l:e', 'leadEditMenu'], ['l:b', 'leadBack'], ['l:e:s', 'leadEditField'], ['l:e:n', 'leadEditField'], ['l:e:p', 'leadEditField'], ['l:e:c', 'leadEditField'],
  ['l:mezh', 'leadStartService'], ['l:o6', 'leadOption'],
]) {
  const r = botUi.route(data);
  assertTrue(`route(${JSON.stringify(data)}) -> ${expect === null ? 'null' : expect}`, expect === null ? r === null : !!r && r.type === expect, JSON.stringify(r));
}
assertTrue('route(l:e:p) names the phone field', botUi.route('l:e:p').field === 'phone');
assertTrue('screen() never renders a flow route', botUi.screen(botUi.route('l:e'), ctx) === null);

// a:d is answered specially (media group + nav message), not an edit — check
// its three pure parts directly.
{
  const media = botUi.documentsMedia();
  assertTrue('documentsMedia returns one item per AWARDS entry', media.length === C.awards.items.length, media.length);
  for (const item of media) {
    assertTrue(`media caption <= 1024: ${item.media}`, item.caption.length <= 1024, item.caption.length);
    const v = validateHtml(item.caption);
    assertTrue(`media caption HTML well-formed: ${item.media}`, v.ok, v.error);
    assertTrue(`media is an absolute https URL: ${item.media}`, /^https:\/\//.test(item.media));
  }
  const fallback = botUi.documentsFallback();
  for (const a of C.awards.items) {
    assertTrue(`documentsFallback lists ${a.title}`, fallback.text.includes(botUi.escapeHtml(a.title)));
  }
  screens.push({ name: 'a:d fallback (sendMediaGroup failed)', msg: fallback, kind: 'reply' });
  const nav = screenByData.get('a:d');
  C.awards.items.forEach((a, n) => {
    const line = (n + 1) + '. ' + botUi.escapeHtml(a.title) + ' — ' + botUi.escapeHtml(a.sub);
    assertTrue(`a:d nav message lists album item ${n + 1} as "N. title — sub"`, !!nav && nav.text.split('\n').includes(line), line);
  });
}

// Flow messages.
const sampleState = { name: 'Иван Петров', phone: '+7 927 123-45-67', service: C.leadServices[0], comment: 'Нужна консультация.' };
screens.push({ name: 'flow servicePicker', msg: lf.servicePickerPrompt(), kind: 'prompt' });
screens.push({ name: 'flow namePrompt (with first_name)', msg: lf.namePrompt({ from: { first_name: 'Иван' }, service: C.leadServices[6] }), kind: 'prompt' });
screens.push({ name: 'flow namePrompt (no from)', msg: lf.namePrompt({}), kind: 'prompt' });
screens.push({ name: 'flow namePrompt (retry)', msg: lf.namePrompt({ from: { first_name: 'Иван' }, service: C.leadServices[0] }, { retry: true }), kind: 'prompt' });
screens.push({ name: 'flow commentPrompt', msg: lf.commentPrompt(), kind: 'prompt' });
screens.push({ name: 'flow commentPrompt (too long)', msg: lf.commentPrompt({ tooLong: true }), kind: 'prompt' });
screens.push({ name: 'flow confirmPrompt', msg: lf.confirmPrompt(sampleState), kind: 'prompt' });
screens.push({ name: 'flow confirmPrompt (empty comment)', msg: lf.confirmPrompt({ name: 'Иван', phone: '+7 999 000-00-00' }), kind: 'prompt' });
screens.push({ name: 'flow editMenuPrompt', msg: lf.editMenuPrompt(), kind: 'prompt' });
screens.push({ name: 'flow sentText', msg: lf.sentText(sampleState), kind: 'reply' });
screens.push({ name: 'flow ownerSentText', msg: lf.ownerSentText(sampleState), kind: 'reply' });
screens.push({ name: 'flow busyScreen', msg: lf.busyScreen(), kind: 'reply' });
screens.push({ name: 'flow chatCapScreen', msg: lf.chatCapScreen(), kind: 'reply' });
assertTrue('chat-cap reply (FIXES G8): its own text, the busy reply\'s buttons',
  lf.chatCapScreen().text === 'Слишком много заявок подряд. Попробуйте позже или свяжитесь по контактам.'
    && JSON.stringify(lf.chatCapScreen().keyboard) === JSON.stringify(lf.busyScreen().keyboard));
screens.push({ name: 'lead undelivered', msg: botUi.leadUndeliveredScreen(ctx.contacts), kind: 'reply' });
screens.push({ name: 'forward undelivered', msg: botUi.forwardUndeliveredScreen(ctx.contacts), kind: 'reply' });
screens.push({ name: 'forward undelivered (contacts.js missing)', msg: botUi.forwardUndeliveredScreen(null), kind: 'reply' });
{
  // FIXES G6: the undelivered replies are HTML (the contacts block is escaped) with the way to the menu.
  const s = botUi.forwardUndeliveredScreen(ctx.contacts);
  assertTrue('forward undelivered reply: the headline, then the contacts block',
    s.text === botUi.escapeHtml(botUi.FORWARD_UNDELIVERED_TEXT) + '\n\n' + botUi.contactsBlock(ctx.contacts), JSON.stringify(s.text));
  assertTrue('lead undelivered reply: the headline, then the contacts block',
    botUi.leadUndeliveredScreen(ctx.contacts).text === botUi.escapeHtml(botUi.LEAD_UNDELIVERED_TEXT) + '\n\n' + botUi.contactsBlock(ctx.contacts));
  assertTrue('undelivered reply without contacts.js is the headline alone', botUi.forwardUndeliveredScreen(null).text === botUi.escapeHtml(botUi.FORWARD_UNDELIVERED_TEXT));
}
{
  const ackMsg = lf.forwardAck(false);
  screens.push({ name: 'forward reply', msg: { text: ackMsg.text, keyboard: ackMsg.replyMarkup }, kind: 'reply' });
  const contactAck = lf.forwardAck(true);
  assertTrue('forward reply to a shared contact removes the reply keyboard instead of carrying buttons',
    contactAck.text === ackMsg.text && contactAck.replyMarkup.remove_keyboard === true && !contactAck.replyMarkup.inline_keyboard);
}

// phonePrompt has a reply keyboard, not an inline one — checked separately.
{
  const pp = lf.phonePrompt();
  const v = validateHtml(pp.text);
  assertTrue('flow phonePrompt HTML well-formed', v.ok, v.error);
  assertTrue('flow phonePrompt <= 4096', pp.text.length <= 4096);
  assertTrue('flow phonePrompt reply keyboard has Отмена', pp.replyKeyboard.keyboard.some((row) => row.some((b) => b.text === 'Отмена')));
  assertTrue('flow phonePrompt reply keyboard has request_contact button', pp.replyKeyboard.keyboard.some((row) => row.some((b) => b.request_contact === true)));
  assertTrue('the reply keyboard\'s own "Отмена" is read as the cancel word', lf.isCancelText('Отмена'));
}

// ---------------------------------------------------------------------------
// Per-screen checks.
// ---------------------------------------------------------------------------

// Button text allowed past 40 chars only when it IS verbatim site content:
// the full service titles on the services list. FAQ questions are listed in
// the screen text with number buttons (FIXES U5), so they get no exception.
const LONG_LABEL_EXCEPTIONS = new Set();
for (const id of SERVICE_IDS) LONG_LABEL_EXCEPTIONS.add(C.services[id].title);

const PAIR_MAX = 17; // FIXES B: two buttons share a row only when both labels are this short
const isNavLabel = (t) => t.indexOf('←') === 0;
const isDigitLabel = (t) => /^\d{1,2}$/.test(t);

// Every "от N ₽" token on the site, spaces normalized (NBSP and &nbsp; -> " ").
const siteFiles = ['index.dc.html', 'mezhevanie.dc.html', 'tehplan.dc.html', 'razdel-obedinenie.dc.html', 'Footer.dc.html', 'Header.dc.html', 'assets/contacts.js'];
const siteHaystack = siteFiles.map((f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).join('\n');
const PRICE_TOKEN_RE = /от[\s\u00A0]\d[\d\s\u00A0]*₽/g;
const normSpaces = (s) => s.replace(/&nbsp;/g, ' ').replace(/[\s\u00A0]+/g, ' ');
const sitePriceTokens = new Set((normSpaces(siteHaystack).match(PRICE_TOKEN_RE) || []).map((t) => t.trim()));
assertTrue('site price tokens found for tracing', sitePriceTokens.size >= 5, [...sitePriceTokens].join(' | '));

const reachableFromMenu = new Set();
{
  const queue = ['m'];
  while (queue.length) {
    const data = queue.shift();
    if (reachableFromMenu.has(data)) continue;
    reachableFromMenu.add(data);
    const msg = screenByData.get(data);
    const rows = (msg && msg.keyboard && msg.keyboard.inline_keyboard) || [];
    for (const row of rows) {
      for (const button of row) {
        if (button.callback_data === undefined) continue;
        const r = botUi.route(button.callback_data);
        if (r && !botUi.isFlowRoute(r) && screenByData.has(button.callback_data)) queue.push(button.callback_data);
      }
    }
  }
}
for (const data of routeStrings) {
  if (LEGACY_ALIASES.has(data)) continue;
  assertTrue(`screen "${data}" is reachable from the menu by buttons (no orphan)`, reachableFromMenu.has(data));
}

for (const { name, data, msg, kind } of screens) {
  const v = validateHtml(msg.text);
  assertTrue(`${name}: HTML well-formed`, v.ok, v.error);
  assertTrue(`${name}: text <= 4096`, msg.text.length <= 4096, msg.text.length);

  const rows = (msg.keyboard && msg.keyboard.inline_keyboard) || [];
  const seenTexts = new Set();
  const seenData = new Set();
  for (const row of rows) {
    for (const button of row) {
      assertTrue(`${name}: button "${button.text}" has either url or callback_data`, !!button.url !== !!button.callback_data);
      if (button.callback_data !== undefined) {
        const bytes = Buffer.byteLength(button.callback_data, 'utf8');
        assertTrue(`${name}: callback_data "${button.callback_data}" <= 64 bytes`, bytes <= 64, bytes);
        const r = botUi.route(button.callback_data);
        assertTrue(`${name}: callback_data "${button.callback_data}" resolves to a known route/flow action`, !!r && r.type !== 'leadUnknown', button.callback_data);
        if (r && !botUi.isFlowRoute(r)) {
          const target = botUi.screen(r, ctx);
          assertTrue(`${name}: callback_data "${button.callback_data}" targets a live screen`, !!target, button.callback_data);
        }
        assertTrue(`${name}: duplicate callback_data "${button.callback_data}"`, !seenData.has(button.callback_data));
        seenData.add(button.callback_data);
      }
      if (button.url !== undefined) {
        assertTrue(`${name}: url "${button.url}" is absolute https`, /^https:\/\//.test(button.url));
      }
      const labelOk = cp(button.text) <= 40 || LONG_LABEL_EXCEPTIONS.has(button.text);
      assertTrue(`${name}: button label "${button.text}" <= 40 chars (or a verbatim service title)`, labelOk, cp(button.text));
      assertTrue(`${name}: duplicate button label "${button.text}"`, !seenTexts.has(button.text));
      seenTexts.add(button.text);
    }
    // FIXES B: a pair only when both labels are short, or both are "← …"
    // navigation; number buttons for a numbered list go three to a row.
    if (row.length > 1) {
      const labels = row.map((b) => b.text);
      const digits = labels.every(isDigitLabel) && row.length <= 3;
      const pairOk = row.length === 2 && (labels.every((t) => cp(t) <= PAIR_MAX) || labels.every(isNavLabel));
      assertTrue(`${name}: row [${labels.join('][')}] follows the pair rule`, digits || pairOk, labels.map(cp).join(','));
    }
  }

  // FIXES B: no dead ends. Every screen but the menu itself and the flow
  // step prompts ends with a row holding "← Меню" (callback m).
  if (kind !== 'prompt' && data !== 'm') {
    const last = rows.length ? rows[rows.length - 1] : [];
    assertTrue(`${name}: last button row leads to the menu`, last.some((b) => b.callback_data === 'm'), JSON.stringify(last.map((b) => b.text)));
  }
  if (kind === 'prompt') {
    const flat = rows.flat();
    assertTrue(`${name}: a step prompt offers a way out (Отмена or back to the request)`, flat.some((b) => b.callback_data === 'l:x' || b.callback_data === 'l:b'));
  }

  // Prices: each "от N ₽" token is glued with NBSP (FIXES B / U11) and, on
  // navigation screens, equals a token on the site once NBSP is read as a
  // space (an exact token, not just the same digits).
  const tokens = msg.text.match(PRICE_TOKEN_RE) || [];
  for (const t of tokens) {
    assertTrue(`${name}: price "${t.replace(/\u00A0/g, '·')}" has no breakable space`, !/[ \t\n]/.test(t), JSON.stringify(t));
    if (kind === 'nav') {
      assertTrue(`${name}: price "${normSpaces(t)}" traced to the site sources`, sitePriceTokens.has(normSpaces(t)), normSpaces(t));
    }
  }
  // Every "+7 XXX XXX-XX-XX" office phone on a navigation screen must match
  // a "8 XXX XXX-XX-XX" (or +7) phone in the site sources, compared by digits.
  if (kind === 'nav') {
    const phoneMatches = msg.text.match(/\+7\s\d{3}\s\d{3}-\d{2}-\d{2}/g) || [];
    for (const ph of phoneMatches) {
      const digits = ph.replace(/\D/g, '');
      const found = siteHaystack.replace(/\D/g, '').includes(digits.slice(1)); // compare the 10 national digits
      assertTrue(`${name}: phone "${ph}" traced to the site sources`, found, ph);
    }
  }
}

// The price screens themselves (FIXES U11).
{
  const p = screenByData.get('p');
  for (const r of C.priceRows) {
    assertTrue(`p lists "${r.label}" at its site price`, p.text.includes(botUi.escapeHtml(r.label) + ' — <b>' + botUi.nbspPrice(r.price) + '</b>'), r.price);
  }
  assertTrue('nbspPrice glues only the "от … ₽" part', botUi.nbspPrice('от 750 ₽ / точка') === 'от' + NBSP + '750' + NBSP + '₽ / точка');
  const razdel = screenByData.get('s:razdel');
  const priceBlock = razdel.text.slice(razdel.text.indexOf('<b>Стоимость</b>'));
  assertTrue('s:razdel shows the price alone under "Стоимость" (no "Стоимость — …" repeat)',
    priceBlock === '<b>Стоимость</b>\n<b>' + botUi.nbspPrice(C.services.razdel.prices[0].price) + '</b>', JSON.stringify(priceBlock));
}

// Service/home titles shown anywhere must be literal site content (cheap
// confirmation on top of gen-bot-content.mjs's own asserts).
for (const id of SERVICE_IDS) {
  assertTrue(`service title "${C.services[id].title}" appears in the site sources`, siteHaystack.includes(C.services[id].title));
}
assertTrue(`home title "${C.home.title}" appears in the site sources`, siteHaystack.includes(C.home.title));

// FIXES U12: requisites and the policy link on the contacts screen, with or
// without contacts.js.
for (const [label, c] of [['with contacts.js', ctx.contacts], ['without contacts.js', null]]) {
  const s = botUi.screen({ type: 'contacts' }, { contacts: c });
  assertTrue(`contacts (${label}) shows the ОГРНИП/ИНН line`, s.text.split('\n').includes(botUi.escapeHtml(C.legalLine)), C.legalLine);
  assertTrue(`contacts (${label}) has the policy button on its own row`,
    s.keyboard.inline_keyboard.some((row) => row.length === 1 && row[0].url === C.policyUrl && row[0].text === 'Политика конфиденциальности ↗'));
}
assertTrue('legalLine came from the site footer (tags stripped)', siteHaystack.replace(/<[^>]+>/g, '').includes(C.legalLine));

// FIXES U1: the site's consent checkbox label, word for word, on the confirm screen.
{
  const s = lf.confirmPrompt(sampleState);
  assertTrue('confirm screen carries the site consent sentence with the policy link',
    s.text.endsWith('Я согласен на обработку персональных данных и принимаю <a href="https://kadastrhelp.ru/politika">политику конфиденциальности</a>'), s.text.slice(-160));
  assertTrue('confirm screen send button is "Согласен, отправить" -> l:ok',
    s.keyboard.inline_keyboard[0].length === 1 && s.keyboard.inline_keyboard[0][0].text === 'Согласен, отправить' && s.keyboard.inline_keyboard[0][0].callback_data === 'l:ok');
  assertTrue('engineer-side consent line text', lf.CONSENT_LEAD_LINE === 'Согласие на обработку персональных данных: дано в боте');
}

// ---------------------------------------------------------------------------
// LEAD_SERVICES mapping.
// ---------------------------------------------------------------------------

assertTrue(
  'LEAD_SERVICES short-label mapping length equals LM_SERVICES length',
  lf.LEAD_SERVICES.length === C.leadServices.length,
  `${lf.LEAD_SERVICES.length} vs ${C.leadServices.length}`
);
// FIXES G9: the picker's short label n must name the site's LM_SERVICES[n]
// (the lead is filed under that full label): every word of the short label
// is a word of that entry and of no other one — a reorder or a renamed
// service on the site fails here. The last option stays the catch-all on
// both sides.
{
  const words = (s) => String(s).toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const fits = (label, entry) => { const w = new Set(words(entry)); return words(label).every((x) => w.has(x)); };
  const CATCH_ALL = 'Другое / не знаю точно';
  const last = C.leadServices.length - 1;
  assertTrue(`LM_SERVICES and the picker both end with the catch-all "${CATCH_ALL}"`,
    C.leadServices[last] === CATCH_ALL && lf.LEAD_SERVICES[lf.LEAD_SERVICES.length - 1] === CATCH_ALL,
    JSON.stringify([C.leadServices[last], lf.LEAD_SERVICES[lf.LEAD_SERVICES.length - 1]]));
  for (let n = 0; n < lf.LEAD_SERVICES.length - 1; n++) {
    const label = lf.LEAD_SERVICES[n];
    const hits = C.leadServices.map((entry, k) => (fits(label, entry) ? k : -1)).filter((k) => k >= 0);
    assertTrue(`picker option ${n} "${label}" names LM_SERVICES[${n}] and no other entry`,
      hits.length === 1 && hits[0] === n, `matches ${JSON.stringify(hits)}; LM_SERVICES[${n}] = ${JSON.stringify(C.leadServices[n])}`);
  }
}
for (const id of SERVICE_IDS) {
  const n = lf.SERVICE_ID_TO_LM_INDEX[id];
  assertTrue(`SERVICE_ID_TO_LM_INDEX.${id} points at the matching LM_SERVICES label`, lf.leadServiceLabel(n) === C.services[id].title, n);
}

// ---------------------------------------------------------------------------
// normalizePhone / validators / labels — direct unit checks.
// ---------------------------------------------------------------------------

assertTrue('normalizePhone 8-prefixed 11 digits', lf.normalizePhone('8 927 123 45 67') === '+7 927 123-45-67');
assertTrue('normalizePhone 7-prefixed 11 digits', lf.normalizePhone('+7(927)123-45-67') === '+7 927 123-45-67');
assertTrue('normalizePhone bare 10 digits starting 9', lf.normalizePhone('9271234567') === '+7 927 123-45-67');
assertTrue('normalizePhone non-Russian-shaped input kept as trimmed original', lf.normalizePhone('  +1 555 0100  ') === '+1 555 0100');
assertTrue('contactPhone: Russian number without "+" is formatted', lf.contactPhone('79271234567') === '+7 927 123-45-67');
assertTrue('contactPhone: a foreign number without "+" gets one (U15)', lf.contactPhone('375291234567') === '+375291234567');
assertTrue('contactPhone: a number with "+" is kept', lf.contactPhone('+375291234567') === '+375291234567');
assertTrue('phoneSetText: plain text, no HTML escaping (sent without parse_mode)', lf.phoneSetText('+7 927 123-45-67') === 'Телефон: +7 927 123-45-67' && lf.phoneSetText('1 & 2') === 'Телефон: 1 & 2');
assertTrue('validateName rejects empty', lf.validateName('   ').ok === false);
assertTrue('validateName rejects >80 chars', lf.validateName('ы'.repeat(81)).ok === false);
assertTrue('validateName accepts and trims', lf.validateName('  Иван  ').value === 'Иван');
assertTrue('validateName rejects zero-width-only input', lf.validateName('\u200B\u200B').ok === false);
assertTrue('validateName rejects a name without letters', lf.validateName('12345').ok === false);
assertTrue('validateName strips invisible characters', lf.validateName('\u2060Ан\u00ADна\uFEFF').value === 'Анна');
assertTrue('validateName turns control characters into a space', lf.validateName('Анна\nМария').value === 'Анна Мария');
// FIXES G5: blank "letters" (Hangul fillers and the like) are cut before the letter check.
for (const code of [0x3164, 0x115F, 0x1160, 0xFFA0, 0x2800, 0x17B4, 0x17B5, 0x180E]) {
  const ch = String.fromCharCode(code);
  const hex = 'U+' + code.toString(16).toUpperCase();
  assertTrue(`validateName rejects a name of ${hex} only`, lf.validateName(ch + ch).ok === false);
  assertTrue(`validateName cuts ${hex} out of a real name`, lf.validateName(ch + 'Анна' + ch).value === 'Анна');
}
assertTrue('a first name of Hangul fillers only gives no "Меня зовут" button',
  !lf.namePrompt({ from: { first_name: String.fromCharCode(0x3164, 0x3164) } }).keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'l:me'));
// FIXES G3: the "Telegram:" line of bot leads and forwarded messages.
assertTrue('telegramUserLine: a numeric id and a username', lf.telegramUserLine({ id: 42, username: 'test_user', first_name: 'Тест' }) === 'Telegram: <a href="tg://user?id=42">@test_user</a>');
assertTrue('telegramUserLine: no username, the profile name labels the link', lf.telegramUserLine({ id: 42, first_name: 'Иван', last_name: 'Петров' }) === 'Telegram: <a href="tg://user?id=42">Иван Петров</a>');
assertTrue('telegramUserLine: a digit-string id still links', lf.telegramUserLine({ id: '123', first_name: 'A' }) === 'Telegram: <a href="tg://user?id=123">A</a>');
for (const [label, id] of [['missing', undefined], ['text', 'abc'], ['zero', 0], ['negative', -5], ['fractional', 12.5], ['object', { toString: () => '1' }], ['quote-carrying', '1" x="']]) {
  const line = lf.telegramUserLine({ id, username: 'u' });
  assertTrue(`telegramUserLine: a ${label} id builds no link`, line === 'Telegram: @u', line);
}
{
  const line = lf.telegramUserLine({ id: 7, first_name: '<b>A&B</b>', last_name: '"x' });
  const v = validateHtml(line);
  assertTrue('telegramUserLine: hostile profile names are escaped, the HTML stays valid', v.ok && line === 'Telegram: <a href="tg://user?id=7">&lt;b&gt;A&amp;B&lt;/b&gt; &quot;x</a>', v.error || line);
  assertTrue('telegramUserLine: no from at all', lf.telegramUserLine(undefined) === 'Telegram: пользователь');
}
assertTrue('validateComment rejects >1000 chars', lf.validateComment('x'.repeat(1001)).ok === false);
assertTrue('validateComment accepts empty (optional)', lf.validateComment('').ok === true);
for (const t of ['Отмена', 'отмена', ' ОТМЕНА ', 'Отмена.']) assertTrue(`isCancelText(${JSON.stringify(t)})`, lf.isCancelText(t) === true);
for (const t of ['Отменить', 'Отмена заявки', 'отмена..', '']) assertTrue(`!isCancelText(${JSON.stringify(t)})`, lf.isCancelText(t) === false);
{
  const emojiName = '\u{1F600}'.repeat(32);
  const btn = lf.namePrompt({ from: { first_name: emojiName } }).keyboard.inline_keyboard[0][0];
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(btn.text);
  assertTrue('"Меня зовут …" label is cut by code points (40, no half emoji)', btn.callback_data === 'l:me' && cp(btn.text) === 40 && !lone, JSON.stringify(btn.text));
  assertTrue('a first name of invisible characters only gives no "Меня зовут" button',
    !lf.namePrompt({ from: { first_name: '\u200B\u200B' } }).keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'l:me'));
}
assertTrue('name prompt names the chosen service (U13)', lf.namePrompt({ service: C.leadServices[6] }).text === botUi.escapeHtml('Услуга: ' + C.leadServices[6]) + '\n\n' + 'Как к вам обращаться?');
assertTrue('sent screen ends with the U7 line', lf.sentText(sampleState).text.endsWith('Если нужно, опишите задачу подробнее — напишите сюда же.'));

// Owner tone rules for the bot's own words: no "!", no "Спасибо", no
// gendered "он свяжется" — in bot-ui.js / server.js string literals that
// carry Cyrillic text (site-sourced content is checked by the generator).
for (const file of ['bot-ui.js', 'server.js']) {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const literals = [];
  for (const line of src.split('\n')) {
    if (line.trim().indexOf('//') === 0) continue;
    for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (/[А-Яа-яЁё]/.test(m[1])) literals.push(m[1]);
  }
  const bad = literals.filter((t) => /!|Спасибо|он свяжется/.test(t.replace(/<!doctype html>/gi, '')));
  assertTrue(`${file}: client-facing literals have no "!", "Спасибо" or "он свяжется"`, literals.length > 10 && bad.length === 0, bad.join(' | ') || literals.length + ' literals');
}

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
console.log('\n=== SUMMARY ===');
console.log(`${results.length} checks, ${failed.length} failed`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(` - ${f.name}: ${f.detail || ''}`);
}
process.exit(failed.length ? 1 : 0);
