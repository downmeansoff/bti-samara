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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT_HTACCESS = `DirectoryIndex index.html
ErrorDocument 404 /404.html
AddDefaultCharset utf-8

<IfModule mod_mime.c>
  AddType font/woff2 .woff2
</IfModule>

<IfModule mod_headers.c>
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
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

for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
    copyFile(entry.name);
  }
}
copyDir('assets');
for (const rel of TOP_LEVEL_FILES) {
  if (fs.existsSync(path.join(SRC, rel))) {
    copyFile(rel);
  } else {
    console.warn(`pack-hosting: expected file missing, skipped: ${rel}`);
  }
}

fs.writeFileSync(path.join(DEST, '.htaccess'), ROOT_HTACCESS);
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
