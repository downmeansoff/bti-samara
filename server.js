'use strict';
// Zero-dependency static server for the dc-runtime landing page.
// Serves .dc.html, the .image-slots.state.json sidecar (a dotfile), and
// redirects "/" to index.dc.html (internal nav links point at *.dc.html).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function contentType(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (urlPath === '/' || urlPath === '') {
    res.writeHead(302, { Location: '/index.dc.html' }).end();
    return;
  }

  // Resolve safely inside ROOT (block path traversal).
  const target = path.normalize(path.join(ROOT, urlPath));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset=utf-8><h1>404</h1><a href="/index.dc.html">На главную</a>');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isAsset = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg', '.ico', '.woff2'].includes(ext);
    res.writeHead(200, {
      'Content-Type': contentType(target),
      // Images/fonts cache for a day; HTML/JS/JSON always revalidate so edits show immediately.
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache, must-revalidate',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, () => console.log('bti-samara static server on :' + PORT));
