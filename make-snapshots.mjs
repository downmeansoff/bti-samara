#!/usr/bin/env node
'use strict';
// Prerendered copies of the pages for search-engine robots.
//
// The pages are React templates that fill in their lists (services, steps, prices,
// FAQ) in the browser, so a robot that does not run JavaScript sees an almost empty
// page. pack-hosting.mjs calls this after copying the site: it starts server.js,
// opens every page of sitemap.xml in headless Chrome/Edge (?seo-snapshot=1 opens
// every FAQ answer), takes the finished DOM and stores it as <dest>/_snap/<page>.html.
// The generated .htaccess serves those files, at the normal address, ONLY to known
// search-engine user agents; visitors get the live page exactly as before.
//
//   node make-snapshots.mjs <destDir>     (stand-alone, no version stamping)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4391;
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

export function pagesFromSitemap() {
  const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>https:\/\/kadastrhelp\.ru\/([^<]*)<\/loc>/g)].map(m => m[1]);
}

// What the robot must see even if the reveal-on-scroll script never ran.
const SNAP_STYLE = '<style>.reveal{opacity:1!important;transform:none!important}</style>';

export function cleanDom(dom) {
  let html = dom.trim();
  if (!/^<!doctype/i.test(html)) html = '<!DOCTYPE html>\n' + html;
  // no scripts: the copy is static (structured data stays)
  html = html.replace(/<script\b(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<x-dc\b[\s\S]*?<\/x-dc>/gi, '');
  html = html.replace('</head>', SNAP_STYLE + '</head>');
  return html;
}

async function waitUp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

export async function makeSnapshots({ dest, stamp = h => h }) {
  const browser = BROWSERS.find(p => fs.existsSync(p));
  if (!browser) { console.warn('make-snapshots: no Chrome/Edge found — skipped (the site is served without prerendered copies)'); return 0; }
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bti-snap-'));
  let made = 0;
  try {
    if (!(await waitUp(`http://127.0.0.1:${PORT}/`, 15000))) throw new Error('server.js did not start');
    const out = path.join(dest, '_snap');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const slug of pagesFromSitemap()) {
      const name = slug === '' ? 'index' : slug;
      const url = `http://127.0.0.1:${PORT}/${slug}?seo-snapshot=1`;
      const r = spawnSync(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + profile, '--virtual-time-budget=15000', '--dump-dom', url,
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
      const dom = r.stdout || '';
      if (r.status !== 0 || dom.length < 5000) throw new Error(`snapshot of /${slug} failed (status ${r.status}, ${dom.length} chars)`);
      const html = stamp(cleanDom(dom));
      if (!/<h1[\s>]/.test(html)) throw new Error(`snapshot of /${slug} has no <h1>`);
      fs.writeFileSync(path.join(out, name + '.html'), html);
      made++;
      console.log(`make-snapshots: /${slug} -> _snap/${name}.html (${html.length} B)`);
    }
  } finally {
    server.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return made;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dest = process.argv[2];
  if (!dest) { console.error('usage: node make-snapshots.mjs <destDir>'); process.exit(2); }
  const n = await makeSnapshots({ dest });
  process.exit(n > 0 ? 0 : 1);
}
