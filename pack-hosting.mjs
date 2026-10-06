#!/usr/bin/env node
'use strict';
// Zero-dependency packager for the reg.ru static hosting target
// (Apache behind nginx, .htaccess works, PHP available but the backend lives
// on Railway — see server.js). Copies only the public site files into
// hosting-dist/ next to a generated .htaccess, ready to zip and upload.
//
//   node pack-hosting.mjs
//
// Explicitly NOT copied: CLAUDE.md, DEPLOY.bat, server.js, package.json,
// pack-hosting.mjs itself, .git*, node_modules, and every dotfile except
// .image-slots.state.json — that one holds the hero and about photos that
// image-slot.js fills in at runtime, so the pages are missing them without it.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSnapshots, pagesFromSitemap } from './make-snapshots.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const DEST = 'C:/Users/glebo/bti-lab/hosting-dist';

const TOP_LEVEL_FILES = ['support.js', 'image-slot.js', '.image-slots.state.json', 'favicon.ico', 'robots.txt', 'sitemap.xml'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(rel) {
  const srcPath = path.join(SRC, rel);
  const destPath = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}

function copyDir(relDir) {
  const srcDir = path.join(SRC, relDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const relPath = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(relPath);
    } else if (entry.isFile()) {
      copyFile(relPath);
    }
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// The redirects replace the http -> https rule reg.ru writes when it issues
// the free certificate (this file overwrites theirs), plus www -> bare domain
// so there is one address, matching canonical/og:url.
const BOT_UA = 'YandexBot|YandexMobileBot|YandexImages|YandexAccessibilityBot|Googlebot|Google-InspectionTool|AdsBot-Google|bingbot|DuckDuckBot|Applebot|Mail\\.RU_Bot|SputnikBot';

// Search-engine robots get a prerendered copy of the same page (_snap/, made by
// make-snapshots.mjs); visitors get the live page. Written only when the copies exist.
function snapRules(pages) {
  const slugs = pages.filter(x => x !== '');
  return `  # Robots: prerendered copy of the same page. The /_snap/ address itself is closed
  # from outside (THE_REQUEST is the original request, so the internal rewrites still work).
  RewriteCond %{THE_REQUEST} \\s/+_snap/ [NC]
  RewriteRule ^ - [F,L]
  RewriteCond %{HTTP_USER_AGENT} (${BOT_UA}) [NC]
  RewriteCond %{DOCUMENT_ROOT}/_snap/$1.html -f
  RewriteRule ^(${slugs.join('|')})$ /_snap/$1.html [L,E=SEO_SNAP:1]
  RewriteCond %{HTTP_USER_AGENT} (${BOT_UA}) [NC]
  RewriteCond %{DOCUMENT_ROOT}/_snap/index.html -f
  RewriteRule ^$ /_snap/index.html [L,E=SEO_SNAP:1]

`;
}

const rootHtaccess = (snap) => `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]
  RewriteRule .* https://%1%{REQUEST_URI} [R=301,L]
  RewriteCond %{SERVER_PORT} !^443$
  RewriteRule .* https://%{SERVER_NAME}%{REQUEST_URI} [R=301,L]

${snap}  # Clean page addresses. The old file-name ones (what the visitor typed, hence
  # THE_REQUEST — internal rewrites below must not loop back here) answer 301,
  # so bookmarks and the search index follow; the query string carries over.
  RewriteCond %{THE_REQUEST} \\s/+index(?:\\.dc)?\\.html[\\s?] [NC]
  RewriteRule ^ / [R=301,L]
  RewriteCond %{THE_REQUEST} \\s/+(mezhevanie|tehplan|razdel-obedinenie|vynos-tochek|akt-obsledovaniya|akt-osmotra|politika)(?:\\.dc)?\\.html[\\s?] [NC]
  RewriteRule ^ /%1 [R=301,L]
  # A trailing slash would make the pages' relative asset links resolve
  # under /mezhevanie/.
  RewriteRule ^(mezhevanie|tehplan|razdel-obedinenie|vynos-tochek|akt-obsledovaniya|akt-osmotra|politika)/$ /$1 [R=301,L]
  RewriteRule ^(mezhevanie|tehplan|razdel-obedinenie|vynos-tochek|akt-obsledovaniya|akt-osmotra|politika)$ /$1.dc.html [L]
</IfModule>

DirectoryIndex index.dc.html
ErrorDocument 404 /404.html
AddDefaultCharset utf-8

<IfModule mod_mime.c>
  AddType font/woff2 .woff2
</IfModule>

<IfModule mod_headers.c>
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
  Header append Vary User-Agent env=SEO_SNAP
  Header append Vary User-Agent env=REDIRECT_SEO_SNAP
</IfModule>

# Hide .htaccess and any other dotfile (works on both Apache 2.2 and 2.4),
# except the photo sidecar image-slot.js fetches.
<FilesMatch "^\\.(?!image-slots\\.state\\.json$)">
  <IfModule mod_authz_core.c>
    Require all denied
  </IfModule>
  <IfModule !mod_authz_core.c>
    Order allow,deny
    Deny from all
  </IfModule>
</FilesMatch>
`;

const ASSETS_HTACCESS = `# Images/fonts/CSS/JS under assets/ cache for 7 days; the HTML pages above
# (no-cache, see the root .htaccess) always revalidate so edits show up.
<IfModule mod_headers.c>
  Header set Cache-Control "public, max-age=604800"
</IfModule>
`;

// ---------------------------------------------------------------------------

rmrf(DEST);
fs.mkdirSync(DEST, { recursive: true });

// index.html is only the GitHub Pages root stub (redirect to index.dc.html);
// here DirectoryIndex serves the home page at "/" directly.
for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.html') && entry.name !== 'index.html' && entry.name !== 'seo-verification.html') {
    copyFile(entry.name);
  }
}
copyDir('assets');
// hosting/ holds files only the reg.ru host runs (api/lead.php, the lead
// relay); they land at the site root, hosting/api/x -> api/x.
for (const rel of listFiles(path.join(SRC, 'hosting'))) {
  const destPath = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'hosting', rel), destPath);
}
for (const rel of TOP_LEVEL_FILES) {
  if (fs.existsSync(path.join(SRC, rel))) {
    copyFile(rel);
  } else {
    console.warn(`pack-hosting: expected file missing, skipped: ${rel}`);
  }
}

// reg.ru's nginx serves .css/.js itself with a 45-day max-age that .htaccess
// cannot override, so an edited site.css would reach returning visitors only
// weeks later, next to fresh HTML. Stamp the page-level CSS/JS links with a
// content hash so every change is a new URL. image-slot.js and review.js are
// left alone: the first is an x-import component URL, the second owner-only.
const VERSIONED = ['assets/site.css', 'assets/fonts/fonts.css', 'support.js', 'assets/contacts.js', 'assets/analytics.js'];
const versionOf = {};
for (const rel of VERSIONED) {
  const p = path.join(DEST, rel);
  if (fs.existsSync(p)) versionOf[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 10);
}
const stampHtml = (html) => html.replace(/(\s(?:href|src)=")((?:\.\/)?)([^"?#]+)(\?[^"]*)?"/g, (m, attr, dot, rel) =>
  versionOf[rel] ? `${attr}${dot}${rel}?v=${versionOf[rel]}"` : m);
for (const name of fs.readdirSync(DEST)) {
  if (!name.endsWith('.html')) continue;
  const p = path.join(DEST, name);
  fs.writeFileSync(p, stampHtml(fs.readFileSync(p, 'utf8')));
}

// Prerendered copies for search-engine robots (see make-snapshots.mjs). Without
// Chrome/Edge on this machine they are skipped and the .htaccess has no robot rules.
// Webmaster verification tags (Yandex, Google): paste the <meta> lines into
// seo-verification.html next to this file and they go into the <head> of every page of
// the sitemap, the robots' prerendered copies included (a verification robot arrives
// with a search-engine user agent). File-based verification needs nothing here: drop the
// yandex_*.html / google*.html file the service gives into the repository root.
const SEO_PAGES = pagesFromSitemap();
const verifyFile = path.join(SRC, 'seo-verification.html');
const verifyTags = fs.existsSync(verifyFile) ? fs.readFileSync(verifyFile, 'utf8').trim() : '';
const addVerify = (html) => (verifyTags && !html.includes(verifyTags) ? html.replace('</head>', verifyTags + '\n</head>') : html);
if (verifyTags) {
  for (const slug of SEO_PAGES) {
    const p = path.join(DEST, (slug || 'index') + '.dc.html');
    fs.writeFileSync(p, addVerify(fs.readFileSync(p, 'utf8')));
  }
}

const snapCount = await makeSnapshots({ dest: DEST, stamp: (html) => addVerify(stampHtml(html)) });

// sitemap.xml with <lastmod> = date of the last commit that touched the page file.
const lastmod = (slug) => {
  try { return execFileSync('git', ['log', '-1', '--format=%cs', '--', (slug || 'index') + '.dc.html'], { cwd: SRC, encoding: 'utf8' }).trim(); } catch { return ''; }
};
fs.writeFileSync(path.join(DEST, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  SEO_PAGES.map((slug) => {
    const d = lastmod(slug);
    return '  <url>\n    <loc>https://kadastrhelp.ru/' + slug + '</loc>\n' + (d ? '    <lastmod>' + d + '</lastmod>\n' : '') + '  </url>\n';
  }).join('') +
  '</urlset>\n');

// 404.html is served at whatever path was missing, so its links are absolute.
// GitHub Pages hosts the site under /bti-samara/, the domain at the root.
const notFound = path.join(DEST, '404.html');
if (fs.existsSync(notFound)) {
  fs.writeFileSync(notFound, fs.readFileSync(notFound, 'utf8').split('/bti-samara/').join('/'));
}

fs.writeFileSync(path.join(DEST, '.htaccess'), rootHtaccess(snapCount > 0 ? snapRules(SEO_PAGES) : ''));
fs.writeFileSync(path.join(DEST, 'assets', '.htaccess'), ASSETS_HTACCESS);

const files = listFiles(DEST).sort();
let totalBytes = 0;
console.log('Файлы в', DEST, ':');
for (const rel of files) {
  const size = fs.statSync(path.join(DEST, rel)).size;
  totalBytes += size;
  console.log(`  ${rel}  (${size} B)`);
}
console.log(`\n${files.length} файлов, ${totalBytes} B (${(totalBytes / 1024).toFixed(1)} KB)`);
