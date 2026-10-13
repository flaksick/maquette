import { defineConfig, devices } from '@playwright/test';

// WebKit only: the closest engine to iPad Safari that runs on the Mac (spike S9 measures how
// close). The server mimics GitHub Pages: no isolation headers, /maquette/ base path.
export default defineConfig({
  testDir: 'tests',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Safari'], baseURL: 'http://localhost:8787' },
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: {
    command: `node scripts/serve.mjs ${process.env.MAQUETTE_DEPLOY ?? 'deploy'} 8787`,
    url: 'http://localhost:8787/maquette/dev/probe/',
    reuseExistingServer: !process.env.MAQUETTE_DEPLOY,
  },
});
