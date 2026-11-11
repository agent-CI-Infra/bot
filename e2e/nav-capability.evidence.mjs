import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// Captures the real shared navigation for docs/verification/224/slice3. Run twice: EVIDENCE_DIR=before on the base tree
// and EVIDENCE_DIR=after on the branch tip; the same fixture and viewport list keeps the pair comparable.
const out = (process.env.EVIDENCE_DIR === 'before' ? 'docs/verification/224/slice3/before' : 'docs/verification/224/slice3/after');

test('evidence: shared navigation grouped by organization with the project permission state', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
    for (const [id, full, owner] of [['101', 'alpha/project-101', 'alpha'], ['102', 'beta/project-102', 'beta']]) {
      h.store.run('UPDATE repositories SET full_name=? WHERE id=?', full, id);
      h.store.run('UPDATE installed_repositories SET full_name=?, owner_login=? WHERE repository_id=?', full, owner, id);
    }
    h.store.run('UPDATE installed_repositories SET permissions=? WHERE repository_id=?', JSON.stringify({ pull: true }), '101');
    await page.goto(h.admin + '/#/projects/101/overview');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#console-context')).toContainText('project-101');
    mkdirSync(out, { recursive: true });
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(h.admin + '/#/projects/101/overview');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/nav-${width}.png`, fullPage: true });
    }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
