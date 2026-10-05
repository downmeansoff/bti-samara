#!/usr/bin/env node
'use strict';
// Builds the SEO landing pages (landings-data.mjs) from the design of the existing
// service page mezhevanie.dc.html, so they share its layout, header, footer, lead modal
// and mobile behaviour. Generated files are committed (the site is served as-is);
// the head carries Service / BreadcrumbList / FAQPage structured data built from the
// same arrays the page renders.
//
//   node gen-landings.mjs           rewrite the pages
//   node gen-landings.mjs --check   fail if a page differs from what the data produces
import fs from 'node:fs';
import path from 'node:path';
import { LANDINGS, EXISTING } from './landings-data.mjs';
import { ROOT, SITE, read, jsonLdBlock, injectBlock, serviceNode, breadcrumbNode, faqNode } from './seo-lib.mjs';

const CHECK = process.argv.includes('--check');
const base = read('mezhevanie.dc.html');
if (base.includes('\r')) throw new Error('mezhevanie.dc.html has CRLF');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = s => esc(s).replace(/"/g, '&quot;');
const js = s => JSON.stringify(s).replace(/</g, '\\u003c');

function once(s, from, to) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`template anchor found ${n}× (expected 1): ${from.slice(0, 70)}`);
  return s.replace(from, () => to);
}

function replaceBlock(s, re, to) {
  if (!re.test(s)) throw new Error('template block not found: ' + re);
  return s.replace(re, () => to);
}

function arrayConst(name, items) {
  return `const ${name} = [\n` + items.map(i => '  ' + i + ',').join('\n') + '\n];';
}

function relatedOf(slug) {
  const entry = slug => {
    if (EXISTING[slug]) return { slug, ...EXISTING[slug] };
    const l = LANDINGS.find(x => x.slug === slug);
    if (!l) throw new Error('unknown related slug ' + slug);
    return { slug, title: l.service, blurb: l.blurb, icon: l.icon };
  };
  return entry(slug);
}

function build(l) {
  let s = base;
  const url = SITE + l.slug;

  // ---- head
  s = replaceBlock(s, /<title>[^<]*<\/title>/, `<title>${esc(l.title)}</title>`);
  s = replaceBlock(s, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${attr(l.description)}" />`);
  s = replaceBlock(s, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${attr(l.title)}" />`);
  s = replaceBlock(s, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${attr(l.description)}" />`);
  s = replaceBlock(s, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`);
  s = replaceBlock(s, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`);
  s = replaceBlock(s, /<link rel="preload" as="image" href="assets\/photos\/hero-mezhevanie-v2\.webp" fetchpriority="high" \/>\n/, '');

  // ---- hero
  s = once(s, '<span aria-current="page">Межевание</span>', `<span aria-current="page">${esc(l.crumb)}</span>`);
  s = replaceBlock(s, /<h1 class="hero-title hero-title--mezh">[^<]*<\/h1>/, `<h1 class="hero-title ${l.h1Class}">${esc(l.h1)}</h1>`);
  s = replaceBlock(s, /<div class="hero-tagline">[^<]*<\/div>/, `<div class="hero-tagline">${esc(l.tagline)}</div>`);
  s = replaceBlock(s, /<p class="hero-desc">[^<]*<\/p>/, `<p class="hero-desc">${esc(l.heroDesc)}</p>`);
  const rows = l.prices.map(p =>
    `        <div class="hero-price-row">\n          <span class="hero-price-cap">${esc(p.cap)}</span>\n          <span class="hero-price-num">${esc(p.num)}</span>\n        </div>\n`).join('');
  s = replaceBlock(s, /      <div class="hero-price hero-price--rows">[\s\S]*?\n      <\/div>\n/, `      <div class="hero-price hero-price--rows">\n${rows}      </div>\n`);
  s = s.split('service="Межевание земельных участков"').join(`service="${attr(l.service)}"`);
  s = replaceBlock(s, /<img id="hero-mezhevanie" src="assets\/photos\/hero-mezhevanie-v2\.webp" alt="[^"]*" fetchpriority="high" \/>/, `<img src="${l.drawing}" alt="" />`);

  // ---- prose section (static text: it is the part the search engines read first)
  const prose = `<div class="on-paper section" style="padding-top:72px;padding-bottom:48px">
  <div class="section-inner section-inner--narrow">
    <h2 class="section-title reveal">${esc(l.proseTitle)}</h2>
${l.prose.map(p => `    <p class="about-lead reveal" style="margin-bottom:20px">${esc(p)}</p>`).join('\n')}
  </div>
</div>

`;
  const h2 = '<h2 class="section-title reveal" style="margin-bottom:48px">Как проходит работа</h2>';
  const at = s.indexOf(h2);
  if (at === -1) throw new Error('process heading not found');
  const sec = s.lastIndexOf('<div class="on-paper section"', at);
  s = s.slice(0, sec) + prose + s.slice(sec);

  // ---- closing call to action
  s = once(s, '<div class="kicker">Точность, которая защищает вашу землю</div>', '<div class="kicker">Работаем в Самаре, Самарской области и Башкортостане</div>');
  s = once(s, '<h2 class="cta-title">Готовы обсудить межевание?</h2>', `<h2 class="cta-title">Готовы обсудить ${esc(l.service.charAt(0).toLowerCase() + l.service.slice(1))}?</h2>`);

  // ---- data
  s = replaceBlock(s, /^const WHEN_ITEMS = \[[\s\S]*?^\];/m, arrayConst('WHEN_ITEMS', l.when.map(t => `{ text: ${js(t)} }`)));
  s = replaceBlock(s, /^const CHECKLIST = \[[\s\S]*?^\];/m, arrayConst('CHECKLIST', l.checklist.map(t => `{ text: ${js(t)} }`)));
  s = replaceBlock(s, /^const PROCESS_STEPS = \[[\s\S]*?^\];/m, arrayConst('PROCESS_STEPS', l.steps.map((st, i) =>
    `{ n: '${String(i + 1).padStart(2, '0')}', title: ${js(st.title)}, desc: ${js(st.desc)} }`)));
  s = replaceBlock(s, /^const FAQ_BASE = \[[\s\S]*?^\];/m, arrayConst('FAQ_BASE', l.faq.map(f => `{ q: ${js(f.q)}, a: ${js(f.a)} }`)));
  s = replaceBlock(s, /^const RELATED = \[[\s\S]*?^\];/m, arrayConst('RELATED', l.related.map(slug => {
    const r = relatedOf(slug);
    return `{ title: ${js(r.title)}, href: ${js(r.slug)}, blurb: ${js(r.blurb)}, icon: ${js(r.icon)} }`;
  })));

  // ---- structured data
  s = injectBlock(s, jsonLdBlock([
    serviceNode({ name: l.service, slug: l.slug, description: l.description, prices: l.prices }),
    breadcrumbNode(l.crumb, l.slug),
    faqNode(l.faq),
  ]));
  return s;
}

let bad = 0;
for (const l of LANDINGS) {
  const file = l.slug + '.dc.html';
  const next = build(l);
  const target = path.join(ROOT, file);
  const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (CHECK) {
    if (prev !== next) { console.error(`gen-landings --check: ${file} is out of date (run node gen-landings.mjs)`); bad++; }
  } else if (prev !== next) {
    fs.writeFileSync(target, next);
    console.log('gen-landings: wrote', file);
  }
}
if (CHECK) {
  if (bad) process.exit(1);
  console.log('gen-landings --check: landing pages are up to date.');
}
