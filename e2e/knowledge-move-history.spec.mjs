import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { managerFixture } from '../test/project-manager-fixture.mjs';

// #232: a rename/move creates a history entry. The entry must still name the file's previous path, so an older version
// stays findable and restorable after the file no longer exists under its old name.
async function fixture(page) {
  const cleanup = [], f = await managerFixture({ after: fn => cleanup.push(fn) }), h = await harness(undefined, f.manager);
  const { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  return { h, admin, password, errors, async login() {
    await page.goto(h.admin + '/#/projects/101/knowledge');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.knowledge-workspace')).toBeVisible();
  }, async close() { await h.stop(); await rm(h.directory, { recursive: true, force: true }); for (const fn of cleanup.reverse()) await fn(); } };
}
const exact = (page, name) => page.getByRole('button', { name, exact: true });
const panel = page => page.locator('.knowledge-main');

test('a moved file keeps the old path in its history and that version stays restorable', async ({ page }) => {
  test.setTimeout(90000);
  const f = await fixture(page);
  try {
    await f.admin('/api/repositories/101/knowledge-directories', 'POST', { path: '手册' });
    await f.login();
    await exact(page, '新建文件').click();
    await page.getByLabel('文件名', { exact: true }).fill('草稿.md');
    await page.getByLabel('内容', { exact: true }).fill('# 第一版\n\n移动前的正文。');
    await exact(page, '保存文件').click();
    await expect(panel(page).getByRole('heading', { name: '草稿.md', exact: true })).toBeVisible();

    // A second version before the move, so the history has content older than the rename itself.
    await exact(page, '编辑文件').click();
    await page.getByLabel('内容', { exact: true }).fill('# 第二版\n\n移动后仍要能回到这里。');
    await exact(page, '保存文件').click();
    await expect(page.locator('.knowledge-editor')).toHaveCount(0);

    await page.getByText('更多操作', { exact: true }).click();
    await exact(page, '重命名或移动').click();
    await page.getByRole('dialog').getByLabel('目标路径', { exact: true }).fill('手册/草稿.md');
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(panel(page).getByRole('heading', { name: '草稿.md', exact: true })).toBeVisible();

    await exact(page, '历史版本').click();
    const history = page.getByRole('complementary', { name: '文件历史' });
    const move = history.locator('.knowledge-history-row').filter({ hasText: '移动' });
    await expect(move).toHaveCount(1);
    await expect(move).toContainText('自 草稿.md');

    // The move row is real history, not a replacement for the content: both older versions remain openable.
    await exact(page, 'v1').click();
    await expect(page.getByText(/正在查看 v1 · 只读，当前仍为 v3/)).toBeVisible();
    await expect(page.locator('.knowledge-content')).toContainText('移动前的正文');
    await exact(page, '恢复此版本').click();
    await page.getByRole('dialog').getByRole('button', { name: '恢复版本', exact: true }).click();
    await expect(page.getByText(/^v4 ·/)).toBeVisible();
    const moved = (await f.admin('/api/repositories/101/knowledge-files?directory=' + encodeURIComponent('手册'))).value.files
      .find(file => file.path === '手册/草稿.md');
    expect((await f.admin('/api/repositories/101/knowledge-files/' + encodeURIComponent(moved.id))).value.file.content).toContain('移动前的正文');

    const measure = () => page.evaluate(() => {
      const row = [...document.querySelectorAll('.knowledge-history-row')].find(node => node.textContent.includes('移动'));
      if (!row) return null;
      row.scrollIntoView({ block: 'center' });
      const box = row.getBoundingClientRect(), hit = document.elementFromPoint(box.left + 8, box.top + box.height / 2);
      return { top: box.top, bottom: box.bottom, width: box.width, hit: !!hit && row.contains(hit),
        scrollWidth: document.documentElement.scrollWidth, innerWidth };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await exact(page, '历史版本').click();
    await expect(move).toContainText('自 草稿.md');
    const desktop = await measure();
    expect(desktop.hit).toBe(true); expect(desktop.top).toBeGreaterThanOrEqual(0); expect(desktop.bottom).toBeLessThanOrEqual(900);
    expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.innerWidth);
    await page.screenshot({ path: '.tmp/knowledge-move-history/1440.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(move).toContainText('自 草稿.md');
    const mobile = await measure();
    expect(mobile.hit).toBe(true); expect(mobile.top).toBeGreaterThanOrEqual(0); expect(mobile.bottom).toBeLessThanOrEqual(844);
    expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.innerWidth);
    await page.screenshot({ path: '.tmp/knowledge-move-history/390.png' });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
