// Build for the P0 probe (spikes S1–S9). Output: dist/probe, deployed to /maquette/dev/probe/.
import { defineConfig } from 'vite';
import { precacheManifest } from './vite.shared.ts';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const OUT = 'dist/probe';

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
  plugins: [precacheManifest(OUT)],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
