import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: real browsers (Chromium with fake camera/microphone) sign in,
 * call each other through Asterisk and assert that audio and video actually flow.
 *
 *   BASE_URL     web phone URL (default https://localhost:8443)
 *   USERS_FILE   users.json with the test accounts (default ../users.json)
 *   CDP_URL      optional: drive an already running Chrome (e.g. on the Windows host)
 */
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://localhost:8443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
