import { defineConfig } from '@playwright/test';

// End-to-end tests against the production build (run `npm run build` first).
// Locally they use the installed Microsoft Edge. In CI: `npx playwright install chromium` and PW_CHANNEL=chromium.
const channel = process.env.PW_CHANNEL ?? 'msedge';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:44577',
    ...(channel === 'chromium' ? {} : { channel }),
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
  },
});
