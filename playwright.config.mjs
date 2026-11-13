import { defineConfig } from '@playwright/test';
import { availableParallelism } from 'node:os';
// A spec file is one test set: its tests stay in order, while independent files share the local worker pool.
export default defineConfig({ testDir: './e2e', workers: availableParallelism(), fullyParallel: false, timeout: 30000,
  outputDir: '.tmp/e2e-results', reporter: 'list', use: { browserName: 'chromium', headless: true, locale: 'zh-CN' } });
