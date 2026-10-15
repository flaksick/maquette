// Prod release assembly (PLT-3, invariant 8), shared by deploy.mjs and the e2e trees, so tests
// serve exactly what ships. Layout of the prod root:
//   sw.js                 the stable service worker (one URL forever, no version inside)
//   index.html            boot page for a first visit: the current version's entry.html
//   versions.json         { schema, current, versions: [{ id, date, files, bytes }] } newest first
//   manifest.webmanifest, icons/   install metadata (Add to Home Screen reads them at the root)
//   v/<id>/               immutable version folders (the newest KEEP; the rest are deleted)
//     entry.html          the page, with its asset URLs pointing into v/<id>/
//     precache.json       every file of the version with its SHA-256 (the worker verifies each)
// The P1a flat files at the root (assets/, precache.json) are removed: installed P1a workers serve
// their own cached copies, and the new worker adopts that cache as the fallback version.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const KEEP = 3;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The precache list of a build directory, computed like vite.shared.ts does at build time. */
export function precacheFor(dir) {
  const files = walk(dir)
    .map((f) => relative(dir, f).split('\\').join('/'))
    .filter((f) => f !== 'sw.js' && f !== 'precache.json')
    .sort()
    .map((url) => {
      const bytes = readFileSync(join(dir, url));
      return { url, bytes: bytes.length, sha256: sha(bytes) };
    });
  const version = sha(files.map((e) => `${e.url}:${e.sha256}`).join('\n')).slice(0, 12);
  return { version, files };
}

/** Rewrites a build's precache.json after its files were changed (tests make v2/v3 this way). */
export function restamp(dir) {
  const pc = precacheFor(dir);
  writeFileSync(join(dir, 'precache.json'), JSON.stringify(pc, null, 1));
  return pc.version;
}

/** Adds a prod build as the current version of the tree at `root`. Returns what it did. */
export function assembleProd({ dist = 'dist/app-prod', root, keep = KEEP }) {
  const pc = JSON.parse(readFileSync(join(dist, 'precache.json'), 'utf8'));
  const id = pc.version;
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error(`bad version id ${id}`);
  const vdir = join(root, 'v', id);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  // The page is served at the scope root, so its own assets are addressed inside v/<id>/; the
  // manifest and icons stay at the root (one install identity for every version).
  const entry = html.replace(/(src|href)="\.\/assets\//g, `$1="./v/${id}/assets/`);
  if (entry === html) throw new Error('index.html has no ./assets/ references to rewrite');
  if (existsSync(vdir)) {
    const have = JSON.parse(readFileSync(join(vdir, 'precache.json'), 'utf8'));
    if (have.version !== id) throw new Error(`${vdir} exists with a different version`);
  } else {
    mkdirSync(vdir, { recursive: true });
    for (const name of readdirSync(dist)) if (name !== 'sw.js' && name !== 'precache.json') cpSync(join(dist, name), join(vdir, name), { recursive: true });
    writeFileSync(join(vdir, 'entry.html'), entry);
    const files = [...pc.files, { url: 'entry.html', bytes: Buffer.byteLength(entry), sha256: sha(entry) }].sort((a, b) => a.url.localeCompare(b.url));
    writeFileSync(join(vdir, 'precache.json'), JSON.stringify({ version: id, entry: 'entry.html', files }, null, 1));
  }
  const vfiles = JSON.parse(readFileSync(join(vdir, 'precache.json'), 'utf8')).files;
  const prev = existsSync(join(root, 'versions.json')) ? JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8')).versions ?? [] : [];
  const versions = [{ id, date: new Date().toISOString(), files: vfiles.length, bytes: vfiles.reduce((n, f) => n + f.bytes, 0) }, ...prev.filter((v) => v.id !== id)].slice(0, keep);
  // Old version folders beyond KEEP go; the root keeps only the stable files.
  if (existsSync(join(root, 'v'))) for (const d of readdirSync(join(root, 'v'))) if (!versions.some((v) => v.id === d)) rmSync(join(root, 'v', d), { recursive: true, force: true });
  rmSync(join(root, 'assets'), { recursive: true, force: true });
  rmSync(join(root, 'precache.json'), { force: true });
  const oldSw = existsSync(join(root, 'sw.js')) ? readFileSync(join(root, 'sw.js'), 'utf8') : null;
  const newSw = readFileSync(join(dist, 'sw.js'), 'utf8');
  writeFileSync(join(root, 'sw.js'), newSw);
  writeFileSync(join(root, 'index.html'), readFileSync(join(vdir, 'entry.html')));
  cpSync(join(dist, 'manifest.webmanifest'), join(root, 'manifest.webmanifest'));
  cpSync(join(dist, 'icons'), join(root, 'icons'), { recursive: true });
  writeFileSync(join(root, 'versions.json'), JSON.stringify({ schema: 1, current: id, versions }, null, 1));
  const swChanged = oldSw !== null && oldSw !== newSw;
  return {
    version: id,
    versions: versions.map((v) => v.id),
    swChanged,
    describe: `v/${id}/ current, ${versions.length} kept; sw.js ${oldSw === null ? 'new' : swChanged ? 'CHANGED' : 'unchanged'}`,
  };
}
