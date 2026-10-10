// Network-free checks: never notify a real search engine from tests or CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { notifyIndexNow } from '../notify-indexnow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const config = JSON.parse(read('indexnow-config.json'));
const urls = [...read('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
const assets = ['assets/site.css', 'assets/fonts/fonts.css', 'support.js', 'assets/contacts.js', 'assets/analytics.js'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bti-indexnow-'));
const stateFile = path.join(dir, 'state.json');
let posts = [], status = 202, stale = false, noindex = false, wrongKey = false;
const mockFetch = async (url, options = {}) => {
  if (url === config.endpoint) {
    posts.push(JSON.parse(options.body));
    return new Response('', { status });
  }
  if (url.endsWith('/' + config.keyFile)) return new Response(wrongKey ? 'wrong-key' : read(config.keyFile));
  assert.ok(urls.includes(url), 'preflight only visits canonical sitemap URLs');
  const slug = new URL(url).pathname.slice(1);
  let html = read((slug || 'index') + '.dc.html');
  for (const asset of assets) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset))).digest('hex').slice(0, 10);
    html = html.replace(new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\?[^"\\s]*)?(?=")', 'g'), asset + '?v=' + digest);
  }
  if (stale) html = html.replace(/<title>[^<]*<\/title>/, '<title>Old deployment</title>');
  return new Response(html, { headers: noindex ? { 'X-Robots-Tag': 'noindex' } : {} });
};
const run = submit => notifyIndexNow({ root, stateFile, submit, fetchImpl: mockFetch });
try {
  const dry = await run(false);
  assert.equal(dry.changed.length, 7);
  assert.equal(posts.length, 0, 'dry run must not submit');
  assert.equal(fs.existsSync(stateFile), false);
  const accepted = await run(true);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.keyValidationPending, true);
  assert.deepEqual(posts[0].urlList, urls);
  assert.equal(posts[0].keyLocation, 'https://kadastrhelp.ru/' + config.keyFile);
  assert.equal(posts[0].key, read(config.keyFile).trim());
  assert.equal((await run(true)).sent, false, 'same published pages must not be sent twice');
  assert.equal(posts.length, 1);
  const before = fs.readFileSync(stateFile, 'utf8');
  stale = true;
  await assert.rejects(run(true), /differs from source/);
  stale = false; noindex = true;
  await assert.rejects(run(true), /cannot be indexed/);
  noindex = false; wrongKey = true;
  await assert.rejects(run(true), /key differs/);
  wrongKey = false;
  assert.equal(posts.length, 1, 'failed preflights must not notify');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  const saved = JSON.parse(before);
  delete saved.pages[urls[0]];
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  status = 429;
  await assert.rejects(run(true), /HTTP 429/);
  assert.deepEqual(posts.at(-1).urlList, [urls[0]], 'only changed pages are submitted');
  assert.equal(JSON.parse(readState()).pages[urls[0]], undefined, 'rejected notification remains retryable');
  status = 200;
  assert.equal((await run(true)).keyValidationPending, false);
  assert.equal((await run(true)).sent, false);
  console.log('PASS: IndexNow preflights, dry run, 200/202 receipts, duplicate prevention, partial changes and rejected submissions; no real network requests.');
} finally {
  // This exact directory was just created by mkdtemp under the OS temp folder.
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dir).startsWith('bti-indexnow-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
function readState() { return fs.readFileSync(stateFile, 'utf8'); }
