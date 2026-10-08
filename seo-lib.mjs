// Shared helpers for the SEO tooling: structured data (JSON-LD) built from the SAME
// arrays the pages render (FAQ_BASE, hero prices), so markup can never drift from
// the visible text. Used by gen-landings.mjs and seo-markup.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SITE = 'https://kadastrhelp.ru/';
export const PROVIDER = {
  '@type': 'ProfessionalService',
  name: 'ИП Баймурзин Азат Ринатович',
  url: SITE,
  telephone: '+7 902 749-28-01',
};
export const AREA_SERVED = [
  { '@type': 'City', name: 'Самара' },
  { '@type': 'AdministrativeArea', name: 'Самарская область' },
  { '@type': 'AdministrativeArea', name: 'Республика Башкортостан' },
];

export const MARK_OPEN = '<!-- seo:jsonld -->';
export const MARK_CLOSE = '<!-- /seo:jsonld -->';

export function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Evaluate `const NAME = [ ... ];` out of a page's data-dc-script (pure literals only). */
export function extractConst(src, name) {
  const m = new RegExp('^const ' + name + ' = (\\[[\\s\\S]*?^\\]);', 'm').exec(src);
  if (!m) throw new Error('const ' + name + ' not found');
  return vm.runInNewContext('(' + m[1] + ')', {}, { timeout: 1000 });
}

/** «от 7 000 ₽» -> 7000 */
export function priceNumber(text) {
  const m = /(\d[\d\s\u00a0]*)/.exec(text);
  if (!m) return null;
  return Number(m[1].replace(/[\s\u00a0]/g, ''));
}

/** [{cap, num}] from the page's hero price block. */
export function heroPrices(html) {
  const out = [];
  const re = /<(span|div) class="hero-price-cap">([^<]*)<\/\1>\s*<(span|div) class="hero-price-num">([^<]*)<\/\3>/g;
  let m;
  while ((m = re.exec(html))) out.push({ cap: m[2], num: m[4] });
  return out;
}

function ld(obj) {
  // </script> and U+2028 safe
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function faqNode(faq) {
  return {
    '@type': 'FAQPage',
    mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

export function breadcrumbNode(crumbName, slug) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Услуги', item: SITE + '#services' },
      { '@type': 'ListItem', position: 3, name: crumbName, item: SITE + slug },
    ],
  };
}

export function serviceNode({ name, slug, description, prices }) {
  const node = {
    '@type': 'Service',
    name,
    serviceType: name,
    url: SITE + slug,
    provider: PROVIDER,
    areaServed: AREA_SERVED,
  };
  if (description) node.description = description;
  const offers = prices
    .map(p => ({ cap: p.cap, n: priceNumber(p.num) }))
    .filter(p => p.n)
    .map(p => ({
      '@type': 'Offer',
      name: p.cap === 'Стоимость' ? name : p.cap,
      priceCurrency: 'RUB',
      priceSpecification: { '@type': 'PriceSpecification', minPrice: p.n, priceCurrency: 'RUB' },
    }));
  if (offers.length) node.offers = offers;
  return node;
}

/** The whole marked block, ready to be placed in <head>. */
export function jsonLdBlock(nodes) {
  const graph = { '@context': 'https://schema.org', '@graph': nodes };
  return MARK_OPEN + '\n<script type="application/ld+json">' + ld(graph) + '</script>\n' + MARK_CLOSE;
}

/** Put (or replace) the marked block right before the contacts.js <script>. */
export function injectBlock(html, block) {
  const a = html.indexOf(MARK_OPEN);
  if (a !== -1) {
    const b = html.indexOf(MARK_CLOSE, a);
    if (b === -1) throw new Error('unterminated seo:jsonld block');
    return html.slice(0, a) + block + html.slice(b + MARK_CLOSE.length);
  }
  const anchor = '<script src="assets/contacts.js';
  const i = html.indexOf(anchor);
  if (i === -1) throw new Error('contacts.js anchor not found');
  return html.slice(0, i) + block + '\n' + html.slice(i);
}
