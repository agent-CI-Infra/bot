import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', workers: 1, fullyParallel: false, timeout: 30000,
  outputDir: '.tmp/e2e-results', reporter: 'list', use: { browserName: 'chromium', headless: true } });
