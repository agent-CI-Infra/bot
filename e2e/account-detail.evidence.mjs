// Screenshot evidence for #237 T2-A (one account at its own address). Not a test: Playwright only collects *.spec.mjs.
// Run it on the base SHA and on the tip, then compare the two folders:
//
//   git checkout 82aa4014 -- static/settings.js static/views.css
//   node e2e/account-detail.evidence.mjs docs/verification/237/t2a/before
//   git checkout <tip> -- static/settings.js static/views.css && git restore --staged --worktree static/settings.js static/views.css
//   node e2e/account-detail.evidence.mjs docs/verification/237/t2a/after
//
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

const out = resolve(process.argv[2] || '.tmp/account-detail-evidence');
mkdirSync(out, { recursive: true });
const f = await identityFixture();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' }), page = await context.newPage();
  await page.goto(f.h.admin + '/#/settings/accounts/' + encodeURIComponent(f.a.id));
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const panel = page.locator('#settings-panel');
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 });
    await page.goto(f.h.admin + '/#/settings/accounts/' + encodeURIComponent(f.a.id));
    await panel.getByRole('heading').first().waitFor();
    await page.screenshot({ path: `${out}/account-${width}.png`, fullPage: true });
  }
} finally { await browser.close(); await f.close(); }
