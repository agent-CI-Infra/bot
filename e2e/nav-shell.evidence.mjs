import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// Captures the real page a shared project-chat address opens, for docs/verification/224. Run with EVIDENCE_DIR=before on
// the base tree and EVIDENCE_DIR=after on the branch tip; same fixture, same viewports.
const out = process.env.EVIDENCE_DIR === 'before' ? 'docs/verification/224/before' : 'docs/verification/224/after';

test('evidence: a shared project chat address', async ({ page }) => {
  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(undefined, manager);
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await page.goto(h.admin + '/#/projects/101/management');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForTimeout(2500);
    console.log('HASH', new URL(page.url()).hash, 'CURRENT', (await page.locator('.project-nav [aria-current=page]').allTextContents()).join(','));
    mkdirSync(out, { recursive: true });
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/chat-link-${width}.png`, fullPage: true });
    }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
