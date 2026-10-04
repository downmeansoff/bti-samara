#!/usr/bin/env node
'use strict';
// GENERATOR — reads the site sources (the .dc.html pages) and writes
// bot-content.js: the single source of client-facing text/prices/facts the
// Telegram bot screens render (bot-ui.js). Run after ANY change to site
// texts or prices:
//   node gen-bot-content.mjs
// Verify the committed bot-content.js is still in sync with the sources
// (used by tests/lead-e2e.mjs and worth running before a commit):
//   node gen-bot-content.mjs --check
//
// Design (bot-ux SPEC.md section 2): every fact in a bot screen must come
// from the site, verbatim — nothing invented. Two kinds of content are read
// from the sources:
//  - named array/string consts (PRICE_ROWS, FAQ_BASE, CHECKLIST, LM_SERVICES,
//    YANDEX_REVIEWS_URL, ...; the pages' WHEN_ITEMS are not read since the
//    bot dropped that block): extracted by bracket-matching the literal text
//    at "const NAME = [" and evaluating it as JS.
//  - sentences that live in plain markup, not in a const (hero paragraphs,
//    section headings, the footer's hours/area/company lines, ...): typed
//    out below as literals and ASSERTED to still occur in the named source
//    file (whitespace-collapsed, entity-decoded; case-insensitive only for
//    the hero taglines, which the site renders upper-cased via CSS and this
//    generator stores in sentence case for a calmer bot tone). A future
//    owner edit to the site text then breaks this generator loudly instead
//    of letting the bot drift from the site.
// Prices are compared whole, not as substrings: the hero price elements of
// the service pages must equal the generator's values exactly (PRICE_ROWS is
// read straight from its const). Every block a screen is built from must be
// non-empty, so a renamed const or a missing page fails the run instead of
// shipping an empty screen.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'bot-content.js');
const CHECK = process.argv.includes('--check');

let failed = false;
function fail(msg) {
  console.error('gen-bot-content: ' + msg);
  failed = true;
}

const srcCache = new Map();
function readSrc(file) {
  if (!srcCache.has(file)) {
    let src = '';
    try {
      src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch (e) {
      fail(`cannot read source ${file}: ${e.code || e.message}`);
    }
    srcCache.set(file, src);
  }
  return srcCache.get(file);
}

// ---------------------------------------------------------------------------
// Const extraction: "find `const NAME = [` at line start, bracket-match to
// the closing `];` (respect quotes/escapes), evaluate the literal."
// ---------------------------------------------------------------------------

function matchBracket(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let escaped = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function extractArray(file, name, optional) {
  const src = readSrc(file);
  const re = new RegExp('^const ' + name + ' = \\[', 'm');
  const m = re.exec(src);
  if (!m) {
    if (optional) return [];
    fail(`const ${name} not found in ${file}`);
    return [];
  }
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchBracket(src, openIdx);
  if (closeIdx === -1) { fail(`unterminated ${name} array literal in ${file}`); return []; }
  const literal = src.slice(openIdx, closeIdx + 1);
  try {
    return vm.runInNewContext('(' + literal + ')', {}, { timeout: 1000 });
  } catch (e) {
    fail(`failed to evaluate ${name} in ${file}: ${e.message}`);
    return [];
  }
}

function extractStringConst(file, name) {
  const src = readSrc(file);
  const re = new RegExp("^const " + name + " = '([^']*)';", 'm');
  const m = re.exec(src);
  if (!m) { fail(`const ${name} not found in ${file}`); return ''; }
  return m[1];
}

function extractHref(file, prefix) {
  const src = readSrc(file);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('href="(' + escaped + '[^"]*)"');
  const m = re.exec(src);
  if (!m) { fail(`href starting with ${prefix} not found in ${file}`); return ''; }
  return m[1];
}

// ---------------------------------------------------------------------------
// Literal assertion: a string the generator authored by hand (not pulled
// verbatim out of a const) must still occur in the named source file.
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function normalize(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function lit(value, file, ci) {
  const hay = normalize(readSrc(file));
  const needle = normalize(value);
  const ok = ci ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle);
  if (!ok) fail(`literal not found in ${file}: ${JSON.stringify(value)}`);
  return value;
}

// Same as lit(), for a line the page splits over several inline elements
// (the footer's "ОГРНИП … · ИНН …" is two nowrap spans): tags stripped first.
function litText(value, file) {
  const hay = normalize(readSrc(file).replace(/<[^>]*>/g, ''));
  if (!hay.includes(normalize(value))) fail(`text not found in ${file}: ${JSON.stringify(value)}`);
  return value;
}

// Blocks a bot screen is built from. A renamed const, an emptied array or a
// missing page must stop the generator, not ship an empty screen.
function required(name, value) {
  const empty = Array.isArray(value) ? value.length === 0 : !String(value || '').trim();
  if (empty) fail(`required block is empty: ${name}`);
  return value;
}

// Hero price rows of a service page: each caption/number pair, read whole.
// lit() only proves a substring, so "от 5 000 ₽ за помещение" on the page
// would still "contain" the bot's "от 5 000 ₽" — here the element text has
// to equal the generator's value exactly.
function heroPrices(file) {
  const src = readSrc(file);
  const re = /<(span|div) class="hero-price-cap">([^<]*)<\/\1>\s*<(span|div) class="hero-price-num">([^<]*)<\/\3>/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push({ caption: normalize(m[2]), price: normalize(m[4]) });
  return out;
}

// ---------------------------------------------------------------------------
// Home page (index.dc.html)
// ---------------------------------------------------------------------------

const IDX = 'index.dc.html';

const homeEyebrow = lit('Кадастровый инженер · Самара и Башкортостан', IDX);
const homeTitle = lit('Кадастровые документы без лишних нервов и задержек', IDX);
// Site renders the tagline upper-cased via CSS (text-transform); the bot
// uses sentence case for a calmer tone, matched case-insensitively.
const homeTagline = lit('Быстро. Точно. Надёжно.', IDX, true);
const homeLead = lit(
  'Межевание, технические планы, перераспределение, раздел и объединение участков. Аттестованный кадастровый инженер с опытом более 12 лет — более 1000 объектов поставлено на кадастровый учёт.',
  IDX
);
// Hero chip, reused in the menu screen next to the tagline.
const consultFree = lit('Консультация — бесплатно', IDX);
// #faq section heading, reused as the bold title of the bot's FAQ-list screen.
const faqHeading = lit('Частые вопросы', IDX);

const servicesHeading = lit('Все кадастровые вопросы — в одном месте', IDX);
const servicesLead = lit('От межевания до сопровождения в Росреестре — выберите нужную задачу и оставьте заявку.', IDX);

const priceKicker = lit('Стоимость', IDX);
const priceHeading = lit('Цена зависит от объекта', IDX);
// NOT the #pricing section-desc (it contains the forbidden "обычно в течение
// часа" response-time promise) — the pricing-note paragraph instead.
const priceNote = lit('Цены указаны «от» и зависят от площади, региона и срочности. Точную стоимость назовём на бесплатной консультации.', IDX);
const priceCtaLabel = lit('Рассчитать стоимость', IDX);

const processKicker = lit('Как мы работаем', IDX);
const processHeading = lit('Четыре шага до готового документа', IDX);
const homeProcessSteps = required('index.dc.html PROCESS_STEPS', extractArray(IDX, 'PROCESS_STEPS'));

const casesHeading = lit('Что вы получите на руки', IDX);
const casesLead = lit('Официальные документы, готовые к подаче и принимаемые Росреестром без вопросов.', IDX);
const docs = required('index.dc.html DOCS', extractArray(IDX, 'DOCS'));

const aboutKicker = lit('О компании', IDX);
const aboutHeading = lit('Кадастровый инженер с опытом более 12 лет', IDX);
const aboutP1 = lit(
  'ИП Баймурзин Азат Ринатович — практикующий кадастровый инженер с квалификационным аттестатом с 2013 года и общим профессиональным стажем 17 лет, из них 13 лет — на руководящей должности в БТИ. Беру на себя все технические и юридические сложности: от выезда и замеров до получения готовых документов в Росреестре.',
  IDX
);
const aboutP2 = lit('Образование и наличие соответствующих лицензий или сертификатов подтверждают квалификацию и право на выполнение кадастровых работ.', IDX);
const aboutPoints = required('index.dc.html ABOUT_POINTS', extractArray(IDX, 'ABOUT_POINTS'));

const projectsHeading = lit('Значимые объекты', IDX);
const projectsLead = lit('После перехода на индивидуальное предпринимательство оформлен и поставлен на государственный кадастровый учёт ряд значимых объектов на территории Республики Башкортостан.', IDX);
const projects = required('index.dc.html PROJECTS', extractArray(IDX, 'PROJECTS'));

const awardsKicker = lit('Документы и награды', IDX);
const awardsHeading = lit('Квалификация, подтверждённая официально', IDX);
const awardsLead = lit('Действующий квалификационный аттестат, членство в СРО и награды за профессиональную работу. Нажмите на документ, чтобы открыть его целиком.', IDX);
const awards = required('index.dc.html AWARDS', extractArray(IDX, 'AWARDS'));

const reviewsHeading = lit('Что пишут клиенты на Яндекс Картах', IDX);
const reviewsAllLink = lit('Все отзывы на Яндекс Картах', IDX);
const reviewsRaw = required('index.dc.html REVIEWS', extractArray(IDX, 'REVIEWS'));
const yandexReviewsUrl = extractStringConst(IDX, 'YANDEX_REVIEWS_URL');

const priceRows = required('index.dc.html PRICE_ROWS', extractArray(IDX, 'PRICE_ROWS'));
for (const r of priceRows) { required('PRICE_ROWS label', r && r.label); required('PRICE_ROWS price', r && r.price); }
const homeFaq = required('index.dc.html FAQ_BASE', extractArray(IDX, 'FAQ_BASE'));

const sroUrl = extractHref(IDX, 'https://www.ski-pk.ru/sro/members/');

// Footer.dc.html: hours / area / company lines (same on every page).
const FTR = 'Footer.dc.html';
const hours = lit('Пн–Пт: 9:00–18:00 · Сб–Вс — по договорённости', FTR);
const areaLine = lit('Работаем по Самаре, Самарской области и Республике Башкортостан', FTR);
const companyLine = lit('ИП Баймурзин А.Р. Кадастровые и геодезические работы, оформление недвижимости под ключ.', FTR);
const legalLine = litText('ОГРНИП 322028000178258 · ИНН 026802515953', FTR);

// LeadModal.dc.html: the services picklist and the sent-confirmation headline.
const LM = 'LeadModal.dc.html';
const leadServices = required('LeadModal.dc.html LM_SERVICES', extractArray(LM, 'LM_SERVICES'));
const leadSentHeadline = lit('Заявка отправлена. Кадастровый инженер свяжется с вами.', LM);

// The consent checkbox label, read whole: the bot's confirm screen repeats it
// word for word, with the page-relative policy link made absolute.
function consentLabel(file) {
  const m = /<label class="lead-consent">[\s\S]*?<span>([^<]*)<a href="([^"]*)"[^>]*>([^<]*)<\/a>([^<]*)<\/span>/.exec(readSrc(file));
  if (!m) { fail(`consent checkbox label not found in ${file}`); return { text: '', link: '', tail: '', href: '' }; }
  return { text: normalize(m[1]), link: normalize(m[3]), tail: normalize(m[4]), href: m[2] };
}
const consentRaw = consentLabel(LM);
const consent = { text: required('consent text', consentRaw.text), link: required('consent link text', consentRaw.link), tail: consentRaw.tail };
if (!/^[a-z0-9-]+$/.test(consentRaw.href)) fail(`unexpected policy link in ${LM}: ${JSON.stringify(consentRaw.href)}`);
const policyUrl = 'https://kadastrhelp.ru/' + consentRaw.href;

// ---------------------------------------------------------------------------
// Service pages
// ---------------------------------------------------------------------------

const SERVICE_DEFS = [
  {
    id: 'mezh', file: 'mezhevanie.dc.html', homeSlug: 'mezhevanie',
    faq: true,
    tagline: 'Границы — это деньги. Мы делаем их точными.',
    intro: 'Соседи уже «подвинули» забор? Продаёте участок, а границы «гуляют» в документах? Пока нет межевания — ваша земля юридически не защищена.',
    prices: [{ caption: 'Межевой план на уточнение границ земельного участка', price: 'от 7 000 ₽' }],
  },
  {
    id: 'tehplan', file: 'tehplan.dc.html', homeSlug: 'tehplan',
    faq: true,
    tagline: 'Документ, без которого объект не поставить на учёт',
    intro: 'Построили дом, а он нигде не зарегистрирован? Сделали перепланировку в квартире, и она не узаконена? Без технического плана Росреестр откажет в постановке на учёт.',
    prices: [{ caption: 'ИЖС и нежилые строения', price: 'от 7 500 ₽' }, { caption: 'Помещения', price: 'от 5 000 ₽' }],
  },
  {
    id: 'razdel', file: 'razdel-obedinenie.dc.html', homeSlug: 'razdel-obedinenie',
    faq: false, // the page has no FAQ block; picked up automatically if one appears
    tagline: 'Один участок стал двумя. Или два — одним.',
    intro: 'Хотите разделить участок между детьми? Объединить два соседних участка в один? Без правильно оформленных документов Росреестр откажет.',
    prices: [{ caption: 'Стоимость', price: 'от 8 500 ₽' }],
  },
];

const homeServices = required('index.dc.html HOME_SERVICES', extractArray(IDX, 'HOME_SERVICES'));

const services = {};
for (const def of SERVICE_DEFS) {
  const homeEntry = homeServices.find((s) => s.href === def.homeSlug || s.slug === def.homeSlug);
  if (!homeEntry) { fail(`HOME_SERVICES has no entry for slug ${def.homeSlug}`); continue; }
  lit(def.tagline, def.file, true); // CSS-uppercased on the service hero too
  lit(def.intro, def.file);
  const onPage = heroPrices(def.file);
  const samePrices = onPage.length === def.prices.length
    && onPage.every((p, n) => p.caption === def.prices[n].caption && p.price === def.prices[n].price);
  if (!samePrices) fail(`hero prices on ${def.file} differ from the generator: page ${JSON.stringify(onPage)}, generator ${JSON.stringify(def.prices)}`);
  const faq = extractArray(def.file, 'FAQ_BASE', /* optional */ !def.faq);
  services[def.id] = {
    slug: def.homeSlug,
    title: required(def.id + ' title (HOME_SERVICES)', homeEntry.title),
    blurb: required(def.id + ' blurb (HOME_SERVICES)', homeEntry.blurb),
    tagline: def.tagline,
    intro: def.intro,
    includes: required(def.file + ' CHECKLIST', extractArray(def.file, 'CHECKLIST')),
    steps: required(def.file + ' PROCESS_STEPS', extractArray(def.file, 'PROCESS_STEPS')),
    faq: def.faq ? required(def.file + ' FAQ_BASE', faq) : faq,
    prices: def.prices,
  };
}

// ---------------------------------------------------------------------------
// Services without a page of their own (owner, 04.10.2026: list them among the
// bot's services too). On the site each one is a single LM_SERVICES entry with
// the same label as its PRICE_ROWS row, so that label and that price are all
// the bot may show: the title, the note in brackets, the price.
// ---------------------------------------------------------------------------

const EXTRA_SERVICE_DEFS = [
  { id: 'obsl', lmIndex: 3, title: 'Акт обследования' },
  { id: 'osmotr', lmIndex: 4, title: 'Акт осмотра объекта' },
  { id: 'vynos', lmIndex: 5, title: 'Вынос точек в натуру' },
];

const extraServices = [];
for (const def of EXTRA_SERVICE_DEFS) {
  const label = leadServices[def.lmIndex];
  // The index ties the service to the site's request form; the title check
  // catches a reordered LM_SERVICES before the bot offers the wrong service.
  if (typeof label !== 'string' || (label !== def.title && label.indexOf(def.title + ' (') !== 0)) {
    fail(`LM_SERVICES[${def.lmIndex}] is ${JSON.stringify(label)}, expected the service "${def.title}"`);
    continue;
  }
  const row = priceRows.find((r) => r.label === label);
  if (!row) { fail(`PRICE_ROWS has no row labelled exactly like LM_SERVICES[${def.lmIndex}]: ${JSON.stringify(label)}`); continue; }
  const note = label === def.title ? '' : label.slice(def.title.length + 2, -1);
  extraServices.push({ id: def.id, lmIndex: def.lmIndex, title: def.title, note, price: row.price });
}

// ---------------------------------------------------------------------------
// Assemble (stable key order — this *is* the serialized order) and write.
// ---------------------------------------------------------------------------

const data = {
  siteUrl: 'https://kadastrhelp.ru/',
  sroUrl,
  yandexReviewsUrl,
  home: { eyebrow: homeEyebrow, title: homeTitle, tagline: homeTagline, lead: homeLead, consultFree },
  faqHeading,
  servicesSection: { heading: servicesHeading, lead: servicesLead },
  priceSection: { kicker: priceKicker, heading: priceHeading, note: priceNote, ctaLabel: priceCtaLabel },
  process: { kicker: processKicker, heading: processHeading, steps: homeProcessSteps },
  cases: { heading: casesHeading, lead: casesLead, docs },
  about: { kicker: aboutKicker, heading: aboutHeading, paragraph1: aboutP1, paragraph2: aboutP2, points: aboutPoints },
  projects: { heading: projectsHeading, lead: projectsLead, items: projects },
  awards: { kicker: awardsKicker, heading: awardsHeading, lead: awardsLead, items: awards },
  reviews: {
    heading: reviewsHeading,
    allLink: reviewsAllLink,
    items: reviewsRaw.map((r) => ({ text: r.text, author: r.author, date: r.date })),
  },
  priceRows,
  faq: homeFaq,
  hours,
  areaLine,
  companyLine,
  legalLine,
  leadSentHeadline,
  consent,
  policyUrl,
  leadServices,
  serviceOrder: SERVICE_DEFS.map((d) => d.id),
  services,
  extraServices,
};

if (failed) {
  console.error('gen-bot-content: aborting, ' + 'assertions failed (see above).');
  process.exit(1);
}

const banner = [
  "'use strict';",
  '// GENERATED FILE — do not edit by hand.',
  '// Produced by gen-bot-content.mjs from the site sources. After ANY change',
  '// to site texts or prices, regenerate: node gen-bot-content.mjs',
  'module.exports = ',
].join('\n');
const output = banner + JSON.stringify(data, null, 2) + ';\n';

// Belt and braces: the owner has an open question about response-time
// promises, so this sentence must never reach the bot by any path.
if (/в течение часа/i.test(output)) {
  fail('forbidden "в течение часа" response-time phrase ended up in bot-content.js');
  process.exit(1);
}

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  // With core.autocrlf=true the working copy is CRLF: compare content, not line ends.
  const lf = (s) => s.replace(/\r\n/g, '\n');
  if (current === null || lf(current) !== lf(output)) {
    console.error('gen-bot-content --check: bot-content.js is out of date — run `node gen-bot-content.mjs`.');
    process.exit(1);
  }
  console.log('gen-bot-content --check: bot-content.js is up to date.');
  process.exit(0);
} else {
  fs.writeFileSync(OUT, output);
  console.log('gen-bot-content: wrote ' + path.relative(ROOT, OUT));
}
