// Static server that behaves like GitHub Pages for this repo: serves ./deploy at /maquette/,
// sends NO cross-origin-isolation headers (Pages can't), redirects directories to a trailing
// slash, and uses Pages' 10-minute cache header. Usage: node scripts/serve.mjs [root] [port]
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'deploy');
const port = Number(process.argv[3] ?? 8787);
const base = '/maquette/';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(base)) {
      res.writeHead(404).end('not found');
      return;
    }
    const rel = decodeURIComponent(url.pathname.slice(base.length));
    let p = resolve(join(root, rel));
    if (!p.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(p) && statSync(p).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: url.pathname + '/' }).end();
        return;
      }
      p = join(p, 'index.html');
    }
    if (!existsSync(p)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[extname(p)] ?? 'application/octet-stream',
      'Cache-Control': 'max-age=600',
    });
    createReadStream(p).pipe(res);
  })
  .listen(port, () => console.log(`serving ${root} at http://localhost:${port}${base}`));
