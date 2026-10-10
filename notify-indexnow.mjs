#!/usr/bin/env node
// Run AFTER publication. Default mode verifies the live site without sending.
// --submit notifies Yandex only about changed sitemap pages; accepted hashes are
// saved locally so rerunning the deployment doesn't send the same pages again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = ['assets/site.css', 'assets/fonts/fonts.css', 'support.js', 'assets/contacts.js', 'assets/analytics.js'];
const COMPONENTS = ['Header.dc.html', 'Footer.dc.html', 'ServiceCard.dc.html', 'LeadModal.dc.html', 'image-slot.js', '.image-slots.state.json'];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const body = html => {
  const match = /<body\b[^>]*>[\s\S]*/i.exec(html);
  if (!match) throw new Error('page has no body');
  return match[0].replace(/\r\n/g, '\n').replace(/((?:assets\/(?:site\.css|fonts\/fonts\.css|contacts\.js|analytics\.js)|support\.js))\?v=[^"\s]+/g, '$1');
};
const metadata = html => ({
  title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
  description: /<meta name="description" content="([^"]*)"/.exec(html)?.[1],
  canonical: /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1],
  ogTitle: /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1],
  ogDescription: /<meta property="og:description" content="([^"]*)"/.exec(html)?.[1],
  ogSiteName: /<meta property="og:site_name" content="([^"]*)"/.exec(html)?.[1],
  ogImage: /<meta property="og:image" content="([^"]*)"/.exec(html)?.[1],
  jsonld: [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1])),
});

export async function notifyIndexNow({ root = ROOT, stateFile = path.join(root, '.indexnow-state.json'), submit = false, fetchImpl = fetch } = {}) {
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  const config = JSON.parse(read('indexnow-config.json'));
  if (config.host !== 'kadastrhelp.ru' || config.endpoint !== 'https://yandex.com/indexnow' || !/^[a-f0-9]{32}\.txt$/.test(config.keyFile)) {
    throw new Error('unexpected IndexNow host, endpoint or key file');
  }
  const key = read(config.keyFile).trim();
  if (config.keyFile !== key + '.txt') throw new Error('IndexNow key does not match its file name');
  const origin = 'https://' + config.host;
  const request = async (url, options = {}) => {
    const res = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (res.status !== 200) throw new Error(`preflight failed: ${url} returned ${res.status}`);
    return res;
  };
  const keyLocation = origin + '/' + config.keyFile;
  if ((await (await request(keyLocation)).text()).trim() !== key) throw new Error('live IndexNow key differs from source');
  const urls = [...read('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  if (!urls.length || new Set(urls).size !== urls.length || urls.some(url => {
    const parsed = new URL(url);
    return parsed.origin !== origin || parsed.search || parsed.hash || !/^\/(?:[a-z-]+)?$/.test(parsed.pathname);
  })) throw new Error('invalid canonical sitemap URL list');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { host: config.host, pages: {} };
  if (state.host !== config.host || !state.pages || typeof state.pages !== 'object') throw new Error('invalid IndexNow state');
  const assetHashes = ASSETS.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]);
  const componentHashes = COMPONENTS.map(file => [file, hash(read(file).replace(/\r\n/g, '\n'))]);
  const signatures = {};
  // Finish every preflight before POST: don't report a partially published site.
  for (const url of urls) {
    const slug = new URL(url).pathname.slice(1);
    const source = read((slug || 'index') + '.dc.html');
    const res = await request(url, { headers: { 'User-Agent': 'BTI-IndexNow-Deploy/1.0' } });
    const live = await res.text();
    const sourceMeta = metadata(source);
    if (sourceMeta.canonical !== url || JSON.stringify(metadata(live)) !== JSON.stringify(sourceMeta) || body(live) !== body(source)) {
      throw new Error(`live page differs from source: ${url}`);
    }
    if (/\bnoindex\b/i.test(res.headers.get('x-robots-tag') || '') || /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(live)) {
      throw new Error(`page cannot be indexed: ${url}`);
    }
    for (const [file, digest] of assetHashes) {
      if (!live.includes(`${file}?v=${digest.slice(0, 10)}`)) throw new Error(`stale live asset reference: ${url} ${file}`);
    }
    signatures[url] = hash(JSON.stringify([source.replace(/\r\n/g, '\n'), assetHashes, componentHashes]));
  }
  const changed = urls.filter(url => state.pages[url] !== signatures[url]);
  if (!submit || !changed.length) return { sent: false, checked: urls.length, changed };
  const res = await fetchImpl(config.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: config.host, key, keyLocation, urlList: changed }),
  });
  if (res.status !== 200 && res.status !== 202) throw new Error(`IndexNow submission failed: HTTP ${res.status}`);
  const receipt = { host: config.host, pages: signatures, receivedAt: new Date().toISOString(), status: res.status, urls: changed };
  fs.writeFileSync(stateFile, JSON.stringify(receipt, null, 2) + '\n');
  return { sent: true, checked: urls.length, status: res.status, changed, keyValidationPending: res.status === 202 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await notifyIndexNow({ submit: process.argv.includes('--submit') });
    console.log(JSON.stringify(result, null, 2));
    console.log('An accepted request is a crawl notification, not proof of indexing or ranking.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
