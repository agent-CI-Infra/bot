import { defineConfig } from '@playwright/test';
import { availableParallelism } from 'node:os';
// A spec file is one test set: its tests stay in order, while independent files share the local worker pool.
export default defineConfig({ testDir: './e2e', workers: availableParallelism(), fullyParallel: false, timeout: 30000,
  outputDir: '.tmp/e2e-results',
  // PLAYWRIGHT_JUNIT: a JUnit report as well, which Nightly uploads for the public board's scheduled-run charts (#938).
  reporter: process.env.PLAYWRIGHT_JUNIT ? [['list'], ['junit', { outputFile: process.env.PLAYWRIGHT_JUNIT }]] : 'list',
  use: { browserName: 'chromium', headless: true, locale: 'zh-CN' } });
