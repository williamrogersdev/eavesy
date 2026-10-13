import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './test/ux',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: 'line',
  use: {
    baseURL,
    channel: 'chrome',
    colorScheme: 'dark',
    viewport: { width: 390, height: 844 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bunx wrangler d1 migrations apply eavesy --local && CHOKIDAR_USEPOLLING=1 EAVESY_LOCAL_TEST=1 bun run dev --host 127.0.0.1 --port 4173',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
