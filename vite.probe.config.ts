// Build for the P0 probe (spikes S1–S9). Output: dist/probe, deployed to /maquette/dev/probe/.
import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const OUT = 'dist/probe';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Writes precache.json: every shipped file with its SHA-256, so the service worker can
 *  verify the whole app before it reports "Ready offline" (PLT-1, invariant 8). */
function precacheManifest(): Plugin {
  return {
    name: 'maquette-precache-manifest',
    apply: 'build',
    closeBundle() {
      const skip = new Set(['sw.js', 'precache.json']);
      const files = walk(OUT)
        .map((f) => relative(OUT, f).split('\\').join('/'))
        .filter((f) => !skip.has(f))
        .sort();
      const entries = files.map((url) => {
        const bytes = readFileSync(join(OUT, url));
        return { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      const version = createHash('sha256')
        .update(entries.map((e) => `${e.url}:${e.sha256}`).join('\n'))
        .digest('hex')
        .slice(0, 12);
      writeFileSync(join(OUT, 'precache.json'), JSON.stringify({ version, files: entries }, null, 1));
      // Stamp the version into sw.js so every content change is a byte change the browser sees.
      const swPath = join(OUT, 'sw.js');
      const sw = readFileSync(swPath, 'utf8');
      if (!sw.includes('__PRECACHE_VERSION__')) throw new Error('sw.js lost its version placeholder');
      writeFileSync(swPath, sw.replace('__PRECACHE_VERSION__', version));
    },
  };
}

const BUILD_ID = new Date().toISOString().slice(0, 16).replace('T', ' ');

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: 'probe',
  base: './',
  publicDir: 'public',
  build: {
    outDir: '../' + OUT,
    emptyOutDir: true,
    target: 'safari16',
    assetsInlineLimit: 0,
    rollupOptions: { input: { index: here('./probe/index.html'), dummy: here('./probe/dummy.html') } },
  },
  worker: { format: 'es' },
  define: { __PROBE_BUILD__: JSON.stringify(BUILD_ID) },
  plugins: [precacheManifest()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
