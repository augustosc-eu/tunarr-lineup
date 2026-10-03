import { defineConfig, devices } from '@playwright/test';

// End-to-end suite: the built companion (npm run build:local) in front of a
// fake Tunarr (e2e/fake-tunarr.mjs). Set PLAYWRIGHT_CHANNEL=chrome to use a
// locally installed Chrome instead of Playwright's bundled Chromium.
const FAKE_TUNARR_PORT = 18000;
const APP_PORT = 13000;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    viewport: { width: 1920, height: 1080 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'tv-1080p', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, channel: process.env.PLAYWRIGHT_CHANNEL || undefined } }],
  webServer: [
    {
      command: 'node e2e/fake-tunarr.mjs',
      url: `http://127.0.0.1:${FAKE_TUNARR_PORT}/api/channels`,
      env: { FAKE_TUNARR_PORT: String(FAKE_TUNARR_PORT) },
      reuseExistingServer: false,
    },
    {
      command: 'node dist-server/main.js',
      url: `http://127.0.0.1:${APP_PORT}/healthz`,
      env: { PORT: String(APP_PORT), HOST: '127.0.0.1', TUNARR_URL: `http://127.0.0.1:${FAKE_TUNARR_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
