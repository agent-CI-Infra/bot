import { consoleNavigate } from './console-navigation.mjs';
import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #756: both static dialogs had a visible `<h2>` but no `aria-labelledby`, so a screen reader announced only "对话框" and
// the reader lost the one thing that says what the dialog is for. The name must come from that same heading — the title
// the page already shows — without touching showModal(), Escape or focus restoration.
test('#756: #editor and #detail take their accessible name from their visible titles', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  try {
    await page.goto(h.admin + '/#/inbox/101');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible({ timeout: 15000 });

    // The credential/user editor's title is written per kind and per row; here it is the fixed "新增用户" heading.
    await page.getByRole('button', { name: '全局设置', exact: true }).click();
    await page.locator('.project-nav').getByRole('link', { name: '用户', exact: true }).click();
    await page.getByRole('button', { name: '新增用户', exact: true }).click();
    const editor = page.locator('#editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('heading', { name: '新增用户', exact: true })).toBeVisible();
    await expect(editor).toHaveAccessibleName('新增用户');
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();

    // The delivery dialog names itself after the heading the reader sees: 投递详情.
    await h.hook(a.path, a.secret, 'dialog-name-1', { repository: { id: 101 }, action: 'opened', issue: { number: 1 } });
    await consoleNavigate(page, '仓库事件');
    await expect(page.getByText('本页 1 条事件')).toBeVisible();
    await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
    const detail = page.locator('#detail');
    await expect(detail.getByRole('heading', { name: '投递详情', exact: true })).toBeVisible();
    await expect(detail).toHaveAccessibleName('投递详情');
    // Escape still closes it as before; no focus or open/close behaviour is changed by the labelling.
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
  } finally { await h.stop(); }
});
