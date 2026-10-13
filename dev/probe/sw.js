// Maquette probe service worker.
// 1. Offline: precaches every file listed in precache.json and verifies each SHA-256 before
//    reporting "ready offline" (PLT-1, invariant 8).
// 2. Cross-origin isolation for spike S4: GitHub Pages can't send COOP/COEP, so this worker adds
//    them to every response it serves.
// VERSION is stamped at build time; dev builds keep the placeholder and simply fail to install.
const VERSION = 'f214fcf689e9';
const PREFIX = 'maquette-probe-';
const CACHE = PREFIX + VERSION;

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const manifest = await (await fetch('precache.json', { cache: 'no-store' })).json();
      if (manifest.version !== VERSION) throw new Error('precache.json does not match this service worker');
      const cache = await caches.open(CACHE);
      for (const f of manifest.files) {
        const r = await fetch(f.url, { cache: 'no-store' });
        if (!r.ok) throw new Error(`fetch ${f.url}: ${r.status}`);
        const body = await r.arrayBuffer();
        if ((await sha256Hex(body)) !== f.sha256) throw new Error(`hash mismatch: ${f.url}`);
        await cache.put(f.url, new Response(body, { headers: r.headers }));
      }
      const info = { version: VERSION, files: manifest.files.length, verifiedAt: new Date().toISOString() };
      await cache.put('__verified__', new Response(JSON.stringify(info)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only this channel's caches are ever deleted.
      for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

function isolate(res) {
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;
  if (!url.pathname.startsWith(scope.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      let rel = url.pathname.slice(scope.pathname.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      let res = await cache.match(rel);
      if (!res) {
        try {
          res = await fetch(event.request);
        } catch {
          return new Response('offline and not cached', { status: 503 });
        }
      }
      return isolate(res);
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'status') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE);
        const v = await cache.match('__verified__');
        const info = v ? await v.json() : null;
        event.ports[0] && event.ports[0].postMessage({ version: VERSION, verified: !!info, ...(info || {}) });
      })(),
    );
  }
});
