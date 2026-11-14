import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { boardFixtures } from '../test/board-fixtures.mjs';

async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); boardFixtures(h.store);
  return { h, admin, password };
}
async function login(page, url, password) {
  await page.goto(url); await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('#tabs').getByRole('button', { name: '看板', exact: true }).click();
  await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
}

// #482, one slice: the view selector, its unsaved state and the save action stay in the toolbar. Reading them must never
// require opening the `⋯` menu, which keeps only the secondary view operations.
test('视图选择器与未保存状态常驻可见，不展开「更多视图操作」也读得到', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    const more = page.getByRole('button', { name: '更多视图操作', exact: true });
    const view = page.getByLabel('视图', { exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#board-view-menu .board-menu-panel')).toBeHidden();
    await expect(view).toBeVisible();
    await expect(view).toHaveValue('default');
    await expect(view.locator('option:checked')).toHaveText('默认看板');
    // Editing a filter marks the view unsaved; the marker and the save action appear next to the selector, menu closed.
    await page.getByLabel('工作类型', { exact: true }).selectOption('review.issue');
    const state = page.locator('#board-view-state');
    await expect(state).toBeVisible();
    await expect(state).toHaveText('未保存');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#board-view-menu .board-menu-panel')).toBeHidden();
    const save = page.getByRole('button', { name: '保存视图', exact: true });
    await expect(save).toBeVisible();
    await save.click();
    await expect(state).toBeHidden();
    await expect(save).toBeHidden();
    // The secondary view operations stay in the menu.
    await more.click();
    await expect(page.getByRole('button', { name: '切换为列表', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '另存视图', exact: true })).toBeVisible();
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('390 下视图名与未保存状态同样在工具栏里，筛选面板关着也看得见', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await login(page, h.admin, password);
    await page.setViewportSize({ width: 390, height: 844 });
    const more = page.getByRole('button', { name: '更多视图操作', exact: true });
    const view = page.getByLabel('视图', { exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(view).toBeVisible();
    await expect(view.locator('option:checked')).toHaveText('默认看板');
    await page.locator('.board-filter-details > summary').click();
    await page.getByLabel('工作类型', { exact: true }).selectOption('review.issue');
    await page.locator('.board-filter-details > summary').click();
    await expect(page.locator('#board-view-state')).toHaveText('未保存');
    await expect(page.locator('#board-view-state')).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
