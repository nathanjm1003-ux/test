// Minimal static file server for the app in public/.
//
// Serving over http://localhost counts as a secure context, which the app needs
// for crypto.subtle (SHA-1 info hashes / piece verification) and AudioWorklet.
// Opening public/index.html via file:// will not work.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve a URL path to a file inside ROOT, or null if it escapes the root. */
function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, relative);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }

  let path = resolvePath(req.url === '/' ? '/index.html' : req.url);
  if (!path) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    let info = await stat(path);
    if (info.isDirectory()) {
      path = join(path, 'index.html');
      info = await stat(path);
    }
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      // The app is entirely client-side; never let a stale worklet or module linger.
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    } else {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('server error');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`torrent-audio-speed running at http://${HOST}:${PORT}`);
});
