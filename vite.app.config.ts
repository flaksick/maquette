// The app. `vite build --config vite.app.config.ts --mode prod|dev` -> dist/app-<mode>.
// The channel namespaces storage and caches: dev builds can never touch real projects.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { precacheManifest } from './vite.shared.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => {
  const channel = mode === 'prod' ? 'prod' : 'dev';
  const outDir = `dist/app-${channel}`;
  return {
    root: 'app',
    base: './',
    publicDir: 'public',
    build: {
      outDir: here(`./${outDir}`),
      emptyOutDir: true,
      target: 'safari16',
      assetsInlineLimit: 0,
      rollupOptions: { input: { index: here('./app/index.html') } },
    },
    worker: { format: 'es' },
    define: { __CHANNEL__: JSON.stringify(channel) },
    plugins: [precacheManifest(outDir, { __CHANNEL__: channel }, { stampVersion: false })],
  };
});
