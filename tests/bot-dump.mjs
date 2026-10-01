#!/usr/bin/env node
'use strict';
// Prints every bot screen and lead-flow prompt: text with HTML tags shown
// as-is, keyboard rows as [label -> data] or [label -> url]. No network, no
// server.js — pure function calls only, so this is safe to run any time.
//
//   node tests/bot-dump.mjs
//   node tests/bot-dump.mjs > screens.txt

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);
const botUi = require(path.join(REPO_ROOT, 'bot-ui.js'));
const C = require(path.join(REPO_ROOT, 'bot-content.js'));

// Representative ctx: a sample contacts object (shaped like assets/contacts.js)
// and a sample Telegram `from`, so every screen renders instead of bailing
// out on a missing optional field.
const ctx = {
  contacts: {
    phones: [
      { region: 'Самарская область', display: '8 902 749-28-01', max: 'https://max.ru/u/sample1', short: 'Самара' },
      { region: 'Республика Башкортостан', display: '8 917 769-61-19', max: 'https://max.ru/u/sample2', short: 'Башкирия' },
    ],
    email: 'baymurzin.86@bk.ru',
  },
  from: { id: 123456, first_name: 'Имя', username: 'username' },
  isOwner: false,
};

function fmtKeyboard(kb) {
  if (!kb || !kb.inline_keyboard || !kb.inline_keyboard.length) return '  (no keyboard)';
  return kb.inline_keyboard
    .map((row) => '  [' + row.map((b) => b.text + ' -> ' + (b.url || b.callback_data)).join('] [') + ']')
    .join('\n');
}

function dump(name, s) {
  console.log('=== ' + name + ' ===');
  if (!s) { console.log('(null — route does not resolve to a screen)\n'); return; }
  console.log(s.text);
  console.log('--- keyboard ---');
  console.log(fmtKeyboard(s.keyboard));
  if (s.linkPreview) console.log('--- link_preview_options: ' + JSON.stringify(s.linkPreview) + ' ---');
  console.log('');
}

const SERVICE_IDS = C.serviceOrder;

// ---- navigation screens ----
dump('m (menu)', botUi.screen({ type: 'menu' }, ctx));
dump('s (services)', botUi.screen({ type: 'services' }, ctx));
for (const id of SERVICE_IDS) {
  dump('s:' + id, botUi.screen({ type: 'service', id }, ctx));
  dump('s:' + id + ':w (steps)', botUi.screen({ type: 'serviceSteps', id }, ctx));
  dump('s:' + id + ':f (faq list)', botUi.screen({ type: 'serviceFaqList', id }, ctx));
  const svc = C.services[id];
  (svc.faq || []).forEach((_, n) => dump('s:' + id + ':q' + n, botUi.screen({ type: 'serviceFaqAnswer', id, n }, ctx)));
}
dump('p (prices)', botUi.screen({ type: 'prices' }, ctx));
dump('h (how)', botUi.screen({ type: 'how' }, ctx));
dump('h:d (what you get)', botUi.screen({ type: 'howDocs' }, ctx));
dump('a (about)', botUi.screen({ type: 'about' }, ctx));
dump('a:p (projects)', botUi.screen({ type: 'projects' }, ctx));
dump('a:d (documents nav message)', botUi.screen({ type: 'documents' }, ctx));
dump('r (reviews)', botUi.screen({ type: 'reviews' }, ctx));
dump('f (faq list)', botUi.screen({ type: 'faqList' }, ctx));
C.faq.forEach((_, n) => dump('q' + n, botUi.screen({ type: 'faqAnswer', n }, ctx)));
dump('c (contacts)', botUi.screen({ type: 'contacts' }, ctx));
dump('c (contacts, contacts.js unavailable)', botUi.screen({ type: 'contacts' }, { contacts: null }));

console.log('=== a:d media group (sendMediaGroup items, section 3) ===');
for (const m of botUi.documentsMedia()) {
  console.log('[' + m.type + '] ' + m.media);
  console.log('  caption: ' + m.caption);
}
console.log('');
dump('a:d fallback (when sendMediaGroup fails)', botUi.documentsFallback());

// ---- lead flow prompts (section 4) ----
const LF = botUi.leadFlow;
dump('l (service picker)', LF.servicePickerPrompt());
dump('name prompt (from.first_name present)', LF.namePrompt({ from: { first_name: 'Имя' }, service: LF.leadServiceLabel(0) }));
dump('name prompt (no first_name, "Другое")', LF.namePrompt({ from: {}, service: LF.leadServiceLabel(6) }));
dump('name prompt (re-ask after an unreadable name)', LF.namePrompt({ from: { first_name: 'Имя' }, service: LF.leadServiceLabel(0) }, { retry: true }));

console.log('=== phone prompt (reply keyboard, not inline) ===');
const pp = LF.phonePrompt();
console.log(pp.text);
console.log('--- reply keyboard ---');
console.log(JSON.stringify(pp.replyKeyboard));
console.log('');

dump('comment prompt', LF.commentPrompt());
dump('comment prompt (re-ask, over 1000 characters)', LF.commentPrompt({ tooLong: true }));

const sampleState = {
  service: LF.leadServiceLabel(0),
  name: 'Имя Фамилия',
  phone: '+7 900 000-00-00',
  comment: 'Пример комментария',
};
dump('confirm prompt', LF.confirmPrompt(sampleState));
dump('l:e (what to change)', LF.editMenuPrompt());
dump('busy reply (l:ok refused by the shared hourly cap)', LF.busyScreen());
dump('chat cap reply (l:ok refused by the chat cap, 5 leads in 10 minutes)', LF.chatCapScreen());
dump('lead undelivered (Telegram took no copy of the lead)', botUi.leadUndeliveredScreen(ctx.contacts));
dump('sent text (client)', LF.sentText(sampleState));
dump('owner sent text (test mode)', LF.ownerSentText(sampleState));

console.log('=== other lead-flow microcopy (section 5) ===');
console.log('PHONE_INVALID_TEXT: ' + LF.PHONE_INVALID_TEXT);
console.log('COMMENT_TOO_LONG_TEXT: ' + LF.COMMENT_TOO_LONG_TEXT);
console.log('NAME_INVALID_TEXT: ' + LF.NAME_INVALID_TEXT);
console.log('phone echo (plain text, remove_keyboard): ' + LF.phoneSetText('+7 900 000-00-00'));
console.log('CANCELLED_TEXT (toast on l:x; message with remove_keyboard on typed cancel): ' + LF.CANCELLED_TEXT);
console.log('RESTART_TEXT (message with remove_keyboard): ' + LF.RESTART_TEXT);
console.log('STALE_TEXT (toast on a flow button in a message the flow does not own, then the menu in place): ' + LF.STALE_TEXT);
console.log('ALREADY_SENT_TEXT (toast on a flow button but l, l:<id>, l:x once the lead is sent; the screen stays): ' + LF.ALREADY_SENT_TEXT);
console.log('engineer copy, after the Telegram: line: ' + LF.CONSENT_LEAD_LINE);
console.log('');

const ack = LF.forwardAck(false);
dump('reply to a forwarded message (text, photo, file)', { text: ack.text, keyboard: ack.replyMarkup });
console.log('=== reply to a forwarded shared contact ===');
console.log(LF.forwardAck(true).text);
console.log('--- reply_markup: ' + JSON.stringify(LF.forwardAck(true).replyMarkup) + ' ---');
console.log('');
dump('forward undelivered (Telegram took no copy of the message)', botUi.forwardUndeliveredScreen(ctx.contacts));
dump('forward undelivered (contacts.js unavailable)', botUi.forwardUndeliveredScreen(null));

console.log('=== Telegram: line (engineer copy of a lead; header of a forwarded message) ===');
console.log('with username: ' + LF.telegramUserLine(ctx.from));
console.log('no username: ' + LF.telegramUserLine({ id: 123456, first_name: 'Имя', last_name: 'Фамилия' }));
console.log('id not numeric (no link): ' + LF.telegramUserLine({ id: 'abc', first_name: 'Имя' }));
