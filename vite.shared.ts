// Shared build plugin: writes precache.json (every shipped file with its SHA-256) and stamps the
// version (and channel) into sw.js, so the service worker can verify the whole app before it
// reports "ready offline" (PLT-1, invariant 8).
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function precacheManifest(outDir: string, stamps: Record<string, string> = {}): Plugin {
  return {
    name: 'maquette-precache-manifest',
    apply: 'build',
    closeBundle() {
      const skip = new Set(['sw.js', 'precache.json']);
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split('\\').join('/'))
        .filter((f) => !skip.has(f))
        .sort();
      const entries = files.map((url) => {
        const bytes = readFileSync(join(outDir, url));
        return { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      const version = createHash('sha256')
        .update(entries.map((e) => `${e.url}:${e.sha256}`).join('\n'))
        .digest('hex')
        .slice(0, 12);
      writeFileSync(join(outDir, 'precache.json'), JSON.stringify({ version, files: entries }, null, 1));
      const swPath = join(outDir, 'sw.js');
      let sw = readFileSync(swPath, 'utf8');
      for (const [k, v] of Object.entries({ __PRECACHE_VERSION__: version, ...stamps })) {
        if (!sw.includes(k)) throw new Error(`sw.js lost its ${k} placeholder`);
        sw = sw.split(k).join(v);
      }
      writeFileSync(swPath, sw);
    },
  };
}
