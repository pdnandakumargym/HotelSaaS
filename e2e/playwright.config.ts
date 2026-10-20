import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests against a running StaySync (dev: `npm run dev -w @staysync/api` + `npm start -w @staysync/web`,
 * or a staging server). They only read pages; they never connect channels or change inventory.
 *
 *   E2E_BASE_URL=http://localhost:4200 E2E_OWNER_EMAIL=... E2E_OWNER_PASSWORD=... npm run e2e
 * Use a test account without 2FA (or a staging account) — never production credentials.
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4200',
    trace: 'retain-on-failure',
    ...(process.env.E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
