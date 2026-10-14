// Maquette service worker (PLT-1/2/3 basic).
// - Precaches every file in precache.json and verifies each SHA-256 before reporting
//   "ready offline". A file that fails verification fails the install: the old version keeps
//   working (invariant 8).
// - Never calls skipWaiting: a new version waits until Maquette is closed and activates on the
//   next launch, so an update can't swap the app mid-sculpt.
// - The prod scope (/maquette/) never handles /maquette/dev/: the dev channel has its own worker.
// - It only ever fetches the app's own files (invariant 0).
const VERSION = '261b5060fb43';
const CHANNEL = 'dev';
const PREFIX = `maquette-${CHANNEL}-`;
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
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;
  if (!url.pathname.startsWith(scope.pathname)) return;
  let rel = url.pathname.slice(scope.pathname.length);
  if (CHANNEL === 'prod' && rel.startsWith('dev/')) return;
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(rel);
      if (hit) return hit;
      try {
        return await fetch(event.request);
      } catch {
        return new Response('Offline, and this file is not part of Maquette.', { status: 503 });
      }
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
        if (event.ports[0]) event.ports[0].postMessage({ version: VERSION, verified: !!info, ...(info || {}) });
      })(),
    );
  }
});
