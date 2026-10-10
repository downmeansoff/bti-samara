#!/usr/bin/env node
'use strict';
// Structured data (JSON-LD) for the pages written by hand: Service + BreadcrumbList +
// FAQPage on the three service pages, FAQPage on the home page. Everything is read
// from the page itself (h1, meta description, hero prices, FAQ_BASE), so the markup
// always repeats the visible text. The landing pages get theirs from gen-landings.mjs.
//
//   node seo-markup.mjs           rewrite the marked blocks
//   node seo-markup.mjs --check   fail if a block is out of date
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, read, extractConst, heroPrices, jsonLdBlock, injectBlock, serviceNode, breadcrumbNode, faqNode } from './seo-lib.mjs';

const CHECK = process.argv.includes('--check');
const text = (html, re, what) => {
  const m = re.exec(html);
  if (!m) throw new Error('not found: ' + what);
  return m[1].replace(/&amp;/g, '&');
};

function serviceNodes(slug) {
  const html = read(slug + '.dc.html');
  let faq = null;
  try { faq = extractConst(html.slice(html.indexOf('data-dc-script')), 'FAQ_BASE'); } catch (e) { /* the page has no FAQ */ }
  return [
    serviceNode({
      name: text(html, /<h1 class="hero-title[^"]*"[^>]*>([^<]*)<\/h1>/, slug + ' h1'),
      slug,
      description: text(html, /<meta name="description" content="([^"]*)" \/>/, slug + ' description'),
      prices: heroPrices(html),
    }),
    breadcrumbNode(text(html, /<span aria-current="page">([^<]*)<\/span>/, slug + ' crumb'), slug),
    ...(faq ? [faqNode(faq)] : []),
  ];
}

const JOBS = [
  { file: 'mezhevanie.dc.html', nodes: () => serviceNodes('mezhevanie') },
  { file: 'tehplan.dc.html', nodes: () => serviceNodes('tehplan') },
  { file: 'razdel-obedinenie.dc.html', nodes: () => serviceNodes('razdel-obedinenie') },
  { file: 'index.dc.html', nodes: () => {
    const html = read('index.dc.html');
    return [
      {
        '@type': 'WebSite',
        '@id': SITE + '#website',
        url: SITE,
        name: text(html, /<meta property="og:site_name" content="([^"]*)"/, 'site name'),
        alternateName: ['Кадастр Хелп', 'kadastrhelp.ru'],
        inLanguage: 'ru-RU',
      },
      faqNode(extractConst(html.slice(html.indexOf('data-dc-script')), 'FAQ_BASE')),
    ];
  } },
];

let bad = 0;
for (const job of JOBS) {
  const target = path.join(ROOT, job.file);
  const prev = fs.readFileSync(target, 'utf8');
  const next = injectBlock(prev, jsonLdBlock(job.nodes()));
  if (prev === next) continue;
  if (CHECK) { console.error(`seo-markup --check: ${job.file} is out of date (run node seo-markup.mjs)`); bad++; }
  else { fs.writeFileSync(target, next); console.log('seo-markup: wrote', job.file); }
}
if (CHECK) {
  if (bad) process.exit(1);
  console.log('seo-markup --check: structured data is up to date.');
}
