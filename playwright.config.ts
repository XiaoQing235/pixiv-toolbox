import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 90000, workers: 1,
  outputDir: 'test-results', reporter: 'list',
  use: { channel: 'msedge', headless: true, baseURL: 'http://127.0.0.1:4178' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --config vite.test.config.ts', url: 'http://127.0.0.1:4178/tests/browser/fixture.html', timeout: 60000, reuseExistingServer: false },
});
