import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #527 slice: the project list itself. Its columns already come from the dictionary (project-columns-i18n.spec.mjs),
// but the page around them — the title, the count, the filter fold, the row's state badge, the 检视/开发 switches, the
// running/queued preview, the row buttons and the pager — is still hardcoded Chinese (static/views/project-list.js).
// An English console must show none of it. The check runs at all three layouts the list has, because the row collapses
// two different ways below 1280 and a reading taken at the default 1280x720 width says nothing about 390.
const viewports = [[1440, 900], [768, 1024], [390, 844]];
const han = /[\u4e00-\u9fff]/;
// The list is one card: title and count, the filter fold, the rows and the pager all live under #workspace .list-panel.
// The console shell around it (sidebar, header) is a different slice, so the CJK reading is scoped to the card.
const panel = page => page.locator('#workspace .list-panel');

async function openProjects(page, h) {
  const { admin, password } = await setup(h), a = await account(admin);
  // The third repository has no owner login and a name without an owner prefix, so its group heading is the
  // owner-id fallback rather than a login: the one owner title an English read must also translate.
  for (const [id, owner, name, login] of [['101', '20', 'alpha/one', 'org-20'], ['202', '10', 'beta/two', 'org-10'], ['303', '30', 'gamma', '']]) {
    await repository(admin, a.id, id);
    h.store.run('UPDATE repositories SET full_name=?,owner_id=? WHERE id=?', name, owner, id);
    h.store.run('UPDATE installed_repositories SET full_name=?,owner_id=?,owner_login=?,permissions_at=? WHERE repository_id=?', name, owner, login, new Date().toISOString(), id);
    h.store.run('INSERT INTO public_board_settings(repository_id,enabled) VALUES(?,0) ON CONFLICT(repository_id) DO UPDATE SET enabled=0', id);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(h.admin + '/#/projects');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}

test('English 界面：项目列表整页不再出现中文，三个视口都不溢出', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openProjects(page, h);
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#rows .row')).toHaveCount(3);

    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`).toBe(true);
      const left = (await panel(page).innerText()).match(/[^\s]*[\u4e00-\u9fff][^\s]*/g) || [];
      expect(left, `Chinese text left in the project list at ${width}px`).toEqual([]);
      expect(await panel(page).innerText(), `raw dictionary key at ${width}px`).not.toContain('projects.list.');
    }

    // The words a reader lands on: the page names itself, the header names the Review and Develop columns, and the
    // row says its state, its permission reading and its board in English rather than leaving the migrated columns
    // surrounded by Chinese.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    const head = page.locator('#rows .project-table-head');
    await expect(head).toContainText('Review');
    await expect(head).toContainText('Develop');
    const row = page.locator('#rows .row[data-key="101"]');
    await expect(row).toContainText('Enabled');
    await expect(row).toContainText('Unchecked');
    await expect(row).toContainText('Board off');
    await expect(row.locator('[data-label="review"]')).toContainText('Off');
    // The owner bar around the rows is translated too: its heading falls back to the owner id and its count names the
    // page, so neither can stay Chinese while the rows read English.
    await expect(panel(page)).toContainText('Owner 30');
    await expect(panel(page)).toContainText('Projects on this page: 1');
    // Switching back restores the Chinese words rather than showing a raw key on either language.
    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('#rows .row[data-key="101"]')).toContainText('已启用');
    await expect(panel(page)).toContainText('所有者 30');
    await expect(panel(page)).not.toContainText('projects.list.');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
