// Maquette service worker (PLT-1/2/3, invariant 8). One URL forever (/maquette/sw.js and
// /maquette/dev/sw.js) and no version inside: its bytes change only when its own logic changes
// (Safari 27 drops a registration whose script is missing).
//
// Versions. Prod releases live in immutable folders v/<id>/ listed by versions.json; the dev channel
// and the P1a deploys are "flat" (precache.json at the scope root). A version is used only after
// every file is downloaded and its SHA-256 verified into the version's own cache.
// Switching. A verified new version waits ("pending") for a clean cold launch: a navigation while no
// Maquette window is open. A session never changes version (its files are content-hashed, so a
// page only ever asks for its own version's files).
// Boot health. A version is good once it opens a project (the app posts boot-ok). An unproven
// version launched twice without that is marked bad and the previous good version is served again.
// Migration. Over the P1a worker, the installed P1a version's cache (maquette-<channel>-<id>) is
// adopted as a good version: if the new version fails to start, Maquette goes back to exactly what
// was installed. Nothing here touches projects (OPFS).
// It only ever fetches the app's own files (invariant 0).
const CHANNEL = 'prod';
const P = `mq-${CHANNEL}-`; // the P1a worker deletes maquette-<channel>-* when it activates: not ours
const META = P + 'meta';
const LEGACY = `maquette-${CHANNEL}-`;
const KEEP = 3;

const scope = () => self.registration.scope;
const abs = (rel) => new URL(rel, scope()).href;

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- state (Cache Storage; read fresh every time: an installing and an active worker can
// both be alive) ----------
const EMPTY = { schema: 1, current: null, pending: null, good: [], bad: [], boots: {}, versions: {}, reverted: null, migrated: false };
async function load() {
  const m = await (await caches.open(META)).match('state');
  return m ? { ...EMPTY, ...(await m.json()) } : structuredClone(EMPTY);
}
async function save(st) {
  await (await caches.open(META)).put('state', new Response(JSON.stringify(st), { headers: { 'content-type': 'application/json' } }));
}
let lock = Promise.resolve();
function locked(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}
async function usable(st, id) {
  return !!(id && st.versions[id] && (await caches.has(st.versions[id].cache)));
}

// ---------- versions ----------
async function fetchJson(rel) {
  const r = await fetch(abs(rel), { cache: 'no-store' });
  return r.ok ? r.json() : null;
}

/** The newest deployed version: versions.json (version folders) or precache.json (flat). */
async function latest() {
  const vs = await fetchJson('versions.json');
  if (vs && vs.current) {
    const base = `v/${vs.current}/`;
    const pc = await fetchJson(base + 'precache.json');
    if (!pc || pc.version !== vs.current) throw new Error(`versions.json names ${vs.current}, but its precache.json disagrees`);
    return { id: vs.current, base, entry: base + (pc.entry || 'entry.html'), files: pc.files.map((f) => ({ ...f, url: base + f.url })) };
  }
  const flat = await fetchJson('precache.json');
  if (flat && flat.version) return { id: flat.version, base: '', entry: 'index.html', files: flat.files };
  return null;
}

const downloads = new Map();
/** Downloads every file of a version and verifies each SHA-256; any failure leaves nothing behind. */
function download(man) {
  if (!downloads.has(man.id)) {
    const job = (async () => {
      const name = P + 'v-' + man.id;
      await caches.delete(name);
      const cache = await caches.open(name);
      try {
        let bytes = 0;
        for (const f of man.files) {
          const r = await fetch(abs(f.url), { cache: 'no-store' });
          if (!r.ok) throw new Error(`fetch ${f.url}: ${r.status}`);
          const body = await r.arrayBuffer();
          if ((await sha256Hex(body)) !== f.sha256) throw new Error(`hash mismatch: ${f.url}`);
          bytes += body.byteLength;
          await cache.put(abs(f.url), new Response(body, { headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' } }));
        }
        return { id: man.id, base: man.base, entry: man.entry, cache: name, files: man.files.length, bytes, verifiedAt: new Date().toISOString() };
      } catch (e) {
        await caches.delete(name);
        throw e;
      }
    })();
    downloads.set(man.id, job);
    job.finally(() => downloads.delete(man.id)).catch(() => {});
  }
  return downloads.get(man.id);
}

/** The P1a worker's installed version: asked directly, else the oldest verified P1a cache (a newer
 *  one can only be a worker that was waiting, never one that ran). */
async function findLegacy() {
  let version = null;
  const active = self.registration.active;
  if (active) {
    version = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), 3000);
      ch.port1.onmessage = (e) => {
        clearTimeout(t);
        resolve(e.data && e.data.verified && typeof e.data.version === 'string' && !e.data.layout ? e.data.version : null);
      };
      try {
        active.postMessage({ type: 'status' }, [ch.port2]);
      } catch {
        resolve(null);
      }
    });
  }
  const found = [];
  for (const k of await caches.keys()) {
    if (!k.startsWith(LEGACY) || !/^[0-9a-f]{12}$/.test(k.slice(LEGACY.length))) continue;
    const c = await caches.open(k);
    const v = await c.match('__verified__');
    const info = v ? await v.json() : null;
    if (!info || !(await c.match('index.html'))) continue;
    found.push({ id: k.slice(LEGACY.length), cache: k, files: info.files, verifiedAt: info.verifiedAt });
  }
  found.sort((a, b) => String(a.verifiedAt).localeCompare(String(b.verifiedAt)));
  const pick = found.find((f) => f.id === version) ?? found[0];
  return pick ? { id: pick.id, base: '', entry: 'index.html', cache: pick.cache, files: pick.files, verifiedAt: pick.verifiedAt, legacy: true } : null;
}

/** Keeps the current and pending versions plus the newest good ones (KEEP in all); deletes the rest. */
async function prune(st) {
  const keep = [];
  for (const id of [st.current, st.pending, ...st.good.slice().reverse()]) if (id && st.versions[id] && !keep.includes(id) && keep.length < KEEP) keep.push(id);
  for (const id of Object.keys(st.versions)) if (!keep.includes(id)) delete st.versions[id];
  st.good = st.good.filter((id) => keep.includes(id));
  const used = new Set(keep.map((id) => st.versions[id].cache));
  for (const k of await caches.keys()) if ((k.startsWith(P + 'v-') || k.startsWith(LEGACY)) && !used.has(k)) await caches.delete(k);
}

// ---------- lifecycle ----------
self.addEventListener('install', (event) => {
  // Never skipWaiting: a new worker takes over only when no Maquette window is open.
  event.waitUntil(
    (async () => {
      const st = await locked(async () => {
        const s = await load();
        if (!s.migrated) {
          const legacy = await findLegacy();
          if (legacy) {
            s.versions[legacy.id] = legacy;
            if (!s.good.includes(legacy.id)) s.good.push(legacy.id);
            if (!s.current) s.current = legacy.id;
          }
          s.migrated = true;
          await save(s);
        }
        return s;
      });
      // The newest version must be on the device and verified, or this install fails and the
      // worker in charge keeps serving what it has.
      const man = await latest().catch(() => null);
      if (man && !st.bad.includes(man.id) && !(await usable(st, man.id))) {
        const rec = await download(man);
        await locked(async () => {
          const s = await load();
          s.versions[man.id] = rec;
          if (s.current && s.current !== man.id) s.pending = man.id;
          else s.current = man.id;
          await save(s);
        });
      } else if (!(await usable(await load(), (await load()).current))) {
        throw new Error('no verified version available (offline?)');
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------- serving ----------
function maquetteWindows(all) {
  const base = new URL(scope()).pathname;
  return all.filter((c) => {
    const p = new URL(c.url).pathname;
    return p.startsWith(base) && !(CHANNEL === 'prod' && p.slice(base.length).startsWith('dev/'));
  });
}

/** Which version this launch gets: pending activates only on a clean cold launch; an unproven
 *  version gets two boots, then the previous good version comes back. */
async function chooseVersion() {
  const cold = maquetteWindows(await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).length === 0;
  return locked(async () => {
    const st = await load();
    const before = JSON.stringify(st);
    if (cold && st.pending && !st.bad.includes(st.pending) && (await usable(st, st.pending))) {
      st.current = st.pending;
      st.pending = null;
    }
    let id = st.current;
    if (id && !st.good.includes(id)) {
      const n = st.boots[id] || 0;
      const back = st.good.slice().reverse().find((g) => g !== id && st.versions[g]);
      if (n >= 2 && back) {
        st.bad.push(id);
        delete st.boots[id];
        st.reverted = { from: id, to: back, t: new Date().toISOString() };
        st.current = id = back;
      } else st.boots[id] = n + 1;
    }
    if (JSON.stringify(st) !== before) await save(st); // a launch of a good version writes nothing
    return id ? st.versions[id] : null;
  });
}

async function fromCaches(st, href) {
  const order = [st.current, st.pending, ...st.good.slice().reverse()].filter((id, i, a) => id && a.indexOf(id) === i && st.versions[id]);
  for (const id of order) {
    const hit = await (await caches.open(st.versions[id].cache)).match(href);
    if (hit) return hit;
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const base = new URL(scope()).pathname;
  if (url.origin !== location.origin || req.method !== 'GET' || !url.pathname.startsWith(base)) return;
  const rel = url.pathname.slice(base.length);
  if (CHANNEL === 'prod' && rel.startsWith('dev/')) return;
  if (rel === 'sw.js' || rel === 'versions.json') return;
  const page = req.mode === 'navigate' && (rel === '' || rel === 'index.html');
  event.respondWith(
    (async () => {
      if (page) {
        const v = await chooseVersion();
        const hit = v && (await (await caches.open(v.cache)).match(abs(v.entry)));
        if (hit) return hit;
      } else {
        const hit = await fromCaches(await load(), abs(rel) + url.search);
        if (hit) return hit;
      }
      try {
        return await fetch(req);
      } catch {
        return new Response('Offline, and this file is not part of Maquette.', { status: 503 });
      }
    })(),
  );
});

// ---------- messages from the app ----------
async function status() {
  const st = await load();
  const v = st.versions[st.current];
  // The first three fields are what the P1a app reads (it keeps working if Maquette reverts to it).
  return {
    version: st.current,
    verified: !!v && (await usable(st, st.current)),
    files: v ? v.files : 0,
    verifiedAt: v ? v.verifiedAt : null,
    layout: v ? (v.base ? 'versioned' : v.legacy ? 'p1a' : 'flat') : null,
    pending: st.pending,
    good: st.good,
    bad: st.bad,
    reverted: st.reverted,
  };
}

async function checkUpdate() {
  const st = await load();
  const t0 = Date.now();
  const man = await latest();
  if (!man) return { status: 'unreachable' };
  if (man.id === st.current && (await usable(st, man.id))) return { status: 'latest', id: man.id };
  if (st.bad.includes(man.id)) return { status: 'bad', id: man.id };
  if (man.id === st.pending && (await usable(st, man.id))) return { status: 'pending', id: man.id };
  const rec = await download(man);
  await locked(async () => {
    const s = await load();
    s.versions[man.id] = rec;
    if (man.id !== s.current) s.pending = man.id; // (the current version's files were evicted: re-downloaded in place)
    await save(s);
  });
  return { status: man.id === st.current ? 'repaired' : 'pending', id: man.id, ms: Date.now() - t0, files: rec.files, bytes: rec.bytes };
}

async function bootOk(entry) {
  return locked(async () => {
    const st = await load();
    let id = null;
    for (const [vid, v] of Object.entries(st.versions)) {
      if (await (await caches.open(v.cache)).match(entry)) {
        id = vid;
        break;
      }
    }
    if (!id) return { good: false };
    st.good = [...st.good.filter((g) => g !== id), id];
    delete st.boots[id];
    if (st.reverted && st.reverted.to !== id) st.reverted = null;
    await prune(st);
    await save(st);
    return { good: true, id };
  });
}

self.addEventListener('message', (event) => {
  const d = event.data || {};
  const reply = (m) => (event.ports && event.ports[0] ? event.ports[0].postMessage(m) : event.source && event.source.postMessage(m));
  const fail = (e) => reply({ error: String((e && e.message) || e) });
  if (d.type === 'status') event.waitUntil(status().then(reply, fail));
  else if (d.type === 'check-update') event.waitUntil(checkUpdate().then(reply, fail));
  else if (d.type === 'boot-ok') event.waitUntil(bootOk(String(d.entry)).then(reply, fail));
});
