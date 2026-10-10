#!/usr/bin/env node
'use strict';
// Analytics guard: assets/analytics.js switches on only on the real domain,
// respects opt-outs, and the privacy policy wording matches the counter state in both modes.
//   node tests/analytics-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let checks = 0, failed = 0;
function ok(name, cond, extra = '') {
  checks++;
  if (!cond) { failed++; console.error('FAIL', name, extra); }
}

const SRC = read('assets/analytics.js');

// ---- wiring ----
const slugs = [...read('sitemap.xml').matchAll(/<loc>https:\/\/kadastrhelp\.ru\/([^<]*)<\/loc>/g)].map(m => m[1]);
for (const file of [...slugs.map(s => (s || 'index') + '.dc.html'), 'politika.dc.html']) {
  const html = read(file);
  const c = html.indexOf('<script src="assets/contacts.js');
  const a = html.indexOf('<script src="assets/analytics.js');
  ok(`${file}: loads analytics.js after contacts.js`, c > 0 && a > c, `contacts@${c} analytics@${a}`);
}
ok('pack-hosting versions analytics.js', /VERSIONED = \[[^\]]*'assets\/analytics\.js'/.test(read('pack-hosting.mjs')));
ok('LeadModal reports lead_open and lead_sent', /btiGoal\('lead_open'\)/.test(read('LeadModal.dc.html')) && /btiGoal\('lead_sent'\)/.test(read('LeadModal.dc.html')));
ok('no Webvisor', !/webvisor:\s*true/.test(SRC));
ok('no goal parameters (form data never reaches the counter)', !/reachGoal'\s*,[^)]*,[^)]*,/.test(SRC));

// ---- behaviour of analytics.js in a fake browser ----
function run({ id, host = 'kadastrhelp.ru', search = '', dnt, gpc, webdriver, storage = {} } = {}) {
  const log = { inserted: [], ym: [], clickHandlers: [] };
  const store = { ...storage };
  const sandbox = {
    location: { search, hostname: host },
    navigator: { doNotTrack: dnt, globalPrivacyControl: gpc, webdriver },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    document: {
      createElement: () => ({}),
      getElementsByTagName: () => [{ parentNode: { insertBefore: el => log.inserted.push(el.src) } }],
      addEventListener: (type, fn) => { if (type === 'click') log.clickHandlers.push(fn); },
    },
    Date,
  };
  sandbox.window = sandbox;
  const counterPattern = /\bmetrika:\s*\d+,/g;
  if (id !== undefined && [...SRC.matchAll(counterPattern)].length !== 1) {
    throw new Error('exactly one metrika configuration is required in analytics.js');
  }
  const code = id === undefined ? SRC : SRC.replace(counterPattern, `metrika: ${id},`);
  vm.runInNewContext(code, sandbox);
  // after the loader, window.ym is the queue stub; record calls the way the real tag would see them
  if (sandbox.ym) log.ym = (sandbox.ym.a || []).map(a => Array.from(a));
  const click = href => {
    const a = { getAttribute: () => href };
    for (const h of log.clickHandlers) h({ target: { closest: () => a } });
    return (sandbox.ym && sandbox.ym.a || []).map(x => Array.from(x)).filter(x => x[1] === 'reachGoal').map(x => x[2]);
  };
  return { log, sandbox, store, click };
}

const configured = run();
const cfg = configured.sandbox.BTI_ANALYTICS;
ok('configured counter is a nonnegative safe integer', Number.isSafeInteger(cfg.metrika) && cfg.metrika >= 0);
ok('configured counter state controls tag loading', configured.log.inserted.length === (cfg.metrika ? 1 : 0));
if (cfg.metrika) {
  const actualInit = configured.log.ym.find(a => a[1] === 'init');
  ok('configured counter initializes its real number without Webvisor', !!actualInit && actualInit[0] === cfg.metrika && actualInit[2].webvisor === false);
  configured.sandbox.btiGoal('lead_open');
  configured.sandbox.btiGoal('lead_sent');
  const leadEvents = configured.sandbox.ym.a.map(a => Array.from(a)).filter(a => a[1] === 'reachGoal');
  ok('configured lead events contain only counter, command and event name', leadEvents.length === 2 && leadEvents.every(a => a.length === 3 && a[0] === cfg.metrika) && leadEvents.map(a => a[2]).join() === 'lead_open,lead_sent');
}

const off = run({ id: 0 });
ok('off: counter number is 0', off.sandbox.BTI_ANALYTICS.metrika === 0);
ok('off: no tag injected', off.log.inserted.length === 0 && !off.sandbox.ym);
ok('off: btiGoal is a safe no-op', typeof off.sandbox.btiGoal === 'function' && (off.sandbox.btiGoal('x'), true));

const on = run({ id: 12345 });
ok('on: tag loaded from mc.yandex.ru', on.log.inserted.length === 1 && on.log.inserted[0] === 'https://mc.yandex.ru/metrika/tag.js', on.log.inserted.join());
const init = on.log.ym.find(a => a[1] === 'init');
ok('on: init with the counter number', !!init && init[0] === 12345);
ok('on: Webvisor off, clickmap on', !!init && init[2].webvisor === false && init[2].clickmap === true);
ok('on: www host counted', run({ id: 12345, host: 'www.kadastrhelp.ru' }).log.inserted.length === 1);

const goals = href => run({ id: 12345 }).click(href);
ok('goal: phone', goals('tel:+79027492801').join() === 'click_phone', goals('tel:+79027492801').join());
ok('goal: telegram', goals('https://t.me/kadastricom_bot').join() === 'click_telegram');
ok('goal: max', goals('https://max.ru/u/abc').join() === 'click_max');
ok('goal: email', goals('mailto:baymurzin.86@bk.ru').join() === 'click_email');
ok('goal: ordinary link counts nothing', goals('/mezhevanie').length === 0 && goals('https://example.com/t.me/').length === 0);

const skipped = (name, opts) => ok(`skip: ${name}`, run({ id: 12345, ...opts }).log.inserted.length === 0);
skipped('localhost', { host: 'localhost' });
skipped('Railway mirror', { host: 'bti-samara-landing-production.up.railway.app' });
skipped('GitHub Pages mirror', { host: 'downmeansoff.github.io' });
skipped('Do Not Track', { dnt: '1' });
skipped('Global Privacy Control', { gpc: true });
skipped('automated browser', { webdriver: true });
skipped('robots prerendered copy', { search: '?seo-snapshot=1' });
skipped('owner review mode', { search: '?review=1' });
skipped('stored opt-out', { storage: { btiNoStat: '1' } });
const nostat = run({ id: 12345, search: '?nostat=1' });
ok('?nostat=1 stores the opt-out and skips the counter', nostat.store.btiNoStat === '1' && nostat.log.inserted.length === 0);
const undo = run({ id: 12345, search: '?nostat=0', storage: { btiNoStat: '1' } });
ok('?nostat=0 clears the opt-out', !('btiNoStat' in undo.store) && undo.log.inserted.length === 1);

// ---- the privacy policy follows the counter ----
ok('a counter number requires a policy date', !cfg.metrika || (typeof cfg.policyDate === 'string' && cfg.policyDate.length > 5), 'metrika is set but policyDate is empty');

const polHtml = read('politika.dc.html');
const polScript = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(polHtml)[1];
function policy(analytics) {
  const sb = { window: { BTI_ANALYTICS: analytics }, DCLogic: class {} };
  sb.window.window = sb.window;
  const out = vm.runInNewContext(polScript + '\n;({ SECTIONS, Component })', sb);
  const vals = new out.Component().renderVals();
  return { text: vals.sections.flatMap(s => s.paras.map(p => p.text)).join('\n'), date: vals.policyDate };
}
const pOff = policy({ metrika: 0, policyDate: '' });
ok('policy, counter off: says there is no analytics', pOff.text.includes('не использует системы веб-аналитики') && !pOff.text.includes('Яндекс Метрика'));
ok('policy, counter off: original date kept', pOff.date === '29 июля 2026 года', pOff.date);
const pOn = policy({ metrika: 12345, policyDate: '10 октября 2026 года' });
ok('policy, counter on: describes Yandex Metrica and cookies', pOn.text.includes('«Яндекс Метрика»') && pOn.text.includes('файлы cookie'));
ok('policy, counter on: no longer claims "no analytics" or "no cookies"', !pOn.text.includes('не использует системы веб-аналитики') && !pOn.text.includes('не устанавливаются'));
ok('policy, counter on: tells how to opt out', pOn.text.includes('Global Privacy Control'));
ok('policy, counter on: states no Webvisor and no form data', pOn.text.includes('вебвизор') && pOn.text.includes('имя и телефон'));
ok('policy, counter on: new date shown', pOn.date === '10 октября 2026 года', pOn.date);
const pConfigured = policy(cfg);
ok('policy follows the deployed counter state and date', cfg.metrika ? pConfigured.text.includes('«Яндекс Метрика»') && pConfigured.date === cfg.policyDate : pConfigured.text.includes('не использует системы веб-аналитики'));

console.log(`\n=== ANALYTICS SUMMARY ===\n${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
