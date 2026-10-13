import { defineConfig, devices } from '@playwright/test';

// Parallel agents each use their own port (MAQUETTE_PORT) and deploy tree (MAQUETTE_DEPLOY).
const PORT = process.env.MAQUETTE_PORT ?? '8787';

// WebKit only: the closest engine to iPad Safari that runs on the Mac (spike S9 measures how
// close). The server mimics GitHub Pages: no isolation headers, /maquette/ base path.
export default defineConfig({
  testDir: 'tests',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Safari'], baseURL: `http://localhost:${PORT}` },
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: {
    command: `node scripts/serve.mjs ${process.env.MAQUETTE_DEPLOY ?? 'deploy'} ${PORT}`,
    url: `http://localhost:${PORT}/maquette/dev/probe/`,
    reuseExistingServer: !process.env.MAQUETTE_DEPLOY,
  },
});
