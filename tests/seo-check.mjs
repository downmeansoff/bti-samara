#!/usr/bin/env node
'use strict';
// SEO guard: sitemap, canonical, structured data, routing lists and landing prices
// must agree with each other.   node tests/seo-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LANDINGS } from '../landings-data.mjs';
import { extractConst } from '../seo-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let checks = 0, failed = 0;
function ok(name, cond, extra = '') {
  checks++;
  if (!cond) { failed++; console.error('FAIL', name, extra); }
}

const sitemap = read('sitemap.xml');
const slugs = [...sitemap.matchAll(/<loc>https:\/\/kadastrhelp\.ru\/([^<]*)<\/loc>/g)].map(m => m[1]);
ok('sitemap has pages', slugs.length >= 7, slugs.length);
const serverSlugs = new Set([...read('server.js').match(/const PAGE_SLUGS = new Set\(\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
const packSrc = read('pack-hosting.mjs');
const notFound = read('404.html');

for (const slug of slugs) {
  const file = (slug || 'index') + '.dc.html';
  ok(`${file} exists`, fs.existsSync(path.join(ROOT, file)));
  const html = read(file);
  ok(`${file}: canonical = sitemap url`, html.includes(`<link rel="canonical" href="https://kadastrhelp.ru/${slug}" />`));
  ok(`${file}: og:url = canonical`, html.includes(`<meta property="og:url" content="https://kadastrhelp.ru/${slug}" />`));
  ok(`${file}: exactly one <h1>`, (html.match(/<h1[\s>]/g) || []).length === 1);
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
  const desc = (/<meta name="description" content="([^"]*)"/.exec(html) || [])[1] || '';
  ok(`${file}: title 20..95 chars`, title.length >= 20 && title.length <= 95, title.length);
  ok(`${file}: description 60..230 chars`, desc.length >= 60 && desc.length <= 230, desc.length);
  // structured data is valid JSON
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed = null;
    try { parsed = JSON.parse(m[1]); } catch (e) { /* reported below */ }
    ok(`${file}: JSON-LD parses`, !!parsed);
  }
  // These are the owner's visible starting prices, including the two different
  // technical-plan tariffs. A broken HTML matcher must not silently omit them.
  const expectedPrices = {
    mezhevanie: [7000],
    tehplan: [7500, 5000],
    'razdel-obedinenie': [8500],
  }[slug];
  if (expectedPrices) {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]));
    const service = blocks.flatMap(b => b['@graph'] || [b]).find(n => n['@type'] === 'Service');
    const prices = (service?.offers || []).map(o => o.priceSpecification?.minPrice);
    ok(`${slug}: structured prices match the visible tariffs`,
      JSON.stringify(prices) === JSON.stringify(expectedPrices), JSON.stringify(prices));
  }
  if (slug) {
    ok(`${slug}: server.js PAGE_SLUGS`, serverSlugs.has(slug));
    const inList = new RegExp('[(|]' + slug + '[|)]', 'g');
    ok(`${slug}: pack-hosting rewrite lists`, (packSrc.match(inList) || []).length >= 3, (packSrc.match(inList) || []).length);
    ok(`${slug}: 404.html redirect list`, inList.test(notFound));
  }
}

ok('PAGE_SLUGS has no page missing from the sitemap (politika excepted)', [...serverSlugs].every(s => s === 'politika' || slugs.includes(s)));

// every landing: price is the owner's price from the home price list
const home = read('index.dc.html');
const homeGraph = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .flatMap(m => { const node = JSON.parse(m[1]); return node['@graph'] || [node]; });
const websites = homeGraph.filter(n => n['@type'] === 'WebSite');
ok('home has one WebSite name declaration', websites.length === 1);
ok('WebSite uses canonical home URL', websites[0]?.url === 'https://kadastrhelp.ru/');
ok('WebSite name matches the existing site name', websites[0]?.name === /<meta property="og:site_name" content="([^"]*)"/.exec(home)?.[1]);
const priceRows = extractConst(home.slice(home.indexOf('data-dc-script')), 'PRICE_ROWS');
for (const l of LANDINGS) {
  for (const p of l.prices) {
    ok(`${l.slug}: price "${p.num}" is in the owner's price list`, priceRows.some(r => r.price === p.num), p.num);
  }
  ok(`${l.slug}: no day counts in the text`, !/\d+\s*[–-]\s*\d+\s*(рабоч|дн)/i.test(JSON.stringify(l)));
  ok(`${l.slug}: in the footer menu`, read('Footer.dc.html').includes(`slug: '${l.slug}'`));
  ok(`${l.slug}: in the header menu`, read('Header.dc.html').includes(`slug: '${l.slug}'`));
}

// generated parts are in sync
for (const [script] of [['gen-landings.mjs'], ['seo-markup.mjs']]) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), '--check'], { encoding: 'utf8' });
  ok(`${script} --check`, r.status === 0, (r.stderr || '').trim());
}

console.log(`\n=== SEO SUMMARY ===\n${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
