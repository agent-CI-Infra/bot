// Screenshot evidence for #237 T3-min (公网接入 shows the GitHub login configuration read-only). Not a test:
// Playwright only collects *.spec.mjs. Run on the base SHA and the tip, then compare the two folders:
//
//   git checkout <base> -- static/settings.js && node e2e/public-access.evidence.mjs docs/verification/237/public-access/before
//   git checkout <tip>  -- static/settings.js && node e2e/public-access.evidence.mjs docs/verification/237/public-access/after
//   git restore --staged --worktree static/settings.js
//
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, testPassword } from '../test/helpers.mjs';

const out = resolve(process.argv[2] || '.tmp/public-access-evidence');
mkdirSync(out, { recursive: true });
const h = await harness();
try {
  const { admin, password } = await setup(h), secret = testPassword();
  // A deployment that already has its public entry verified and an independent OAuth App enabled: the page then has
  // something to state in every card, so before/after differ only by the read-only login card.
  h.store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://bot.example.com', checked_at: new Date().toISOString() }));
  await admin('/api/onboarding/github-login', 'PUT', { enabled: true, client_id: 'Ov23.login', client_secret: secret });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' }), page = await context.newPage();
    await page.goto(h.admin + '/#/settings/access');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(h.admin + '/#/settings/access');
    await page.locator('#settings-panel').getByRole('heading').first().waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 });
      await page.locator('#settings-panel').getByRole('heading', { name: '公网 HTTPS 地址', exact: true }).waitFor();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/access-${width}.png`, fullPage: true });
    }
  } finally { await browser.close(); }
} finally { await h.stop(); }
