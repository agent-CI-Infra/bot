import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #749: the console's confirmation dialog named itself (`aria-labelledby="confirm-title"`) but never described itself, so a
// screen reader announced the title and the buttons and dropped the body — including the list of what a delete stops or
// removes. The body container now has a fixed id, the dialog points `aria-describedby` at it when there is a body, and the
// attribute is removed when there is none (an input's own label keeps naming the field either way).
test('#749: the confirmation dialog describes its body, and leaves no dangling description without one', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  try {
    await page.goto(h.admin + '/#/projects/101/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible({ timeout: 15000 });

    // A real product confirmation: deleting the fixture account carries three paragraphs, all of them body.
    await page.goto(h.admin + '/#/settings/accounts');
    const dialog = page.locator('dialog.confirm-dialog');
    await page.locator('.row.has-actions').filter({ hasText: 'Test account' })
      .getByRole('button', { name: '删除', exact: true }).first().click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/删除.*Test account/);
    await expect(dialog).toHaveAccessibleDescription(/只从本系统移除/);
    await expect(dialog).toHaveAccessibleDescription(/不会在 GitHub 上卸载 App/);
    await expect(dialog).toHaveAccessibleDescription(/还有项目使用这个账号时不能删除/);
    // The description is the one body container: a fixed id, never a second one, never an empty reference.
    expect(await dialog.getAttribute('aria-describedby')).toBe('confirm-description');
    expect(await page.locator('#confirm-description').count()).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Body items are paragraphs; an array item is a bulleted list. The same component the product calls, so the list
    // branch (what a delete stops or removes) is described item by item instead of being dropped.
    await page.evaluate(() => { void confirmDialog({ title: '删除项目 fixture/project-101？', action: '删除', danger: true,
      body: ['删除前会当场向 GitHub 核对：仍能访问时记录保留。', ['这个项目从项目列表消失', '正在执行的任务会停止', '操作审计保留']] }); });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName('删除项目 fixture/project-101？');
    await expect(dialog).toHaveAccessibleDescription(/删除前会当场向 GitHub 核对/);
    await expect(dialog).toHaveAccessibleDescription(/这个项目从项目列表消失/);
    await expect(dialog).toHaveAccessibleDescription(/正在执行的任务会停止/);
    await expect(dialog).toHaveAccessibleDescription(/操作审计保留/);
    expect(await page.locator('#confirm-description').count()).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // A body-less request (with an input, the case that keeps its own label) must not leave a dangling description.
    await page.evaluate(() => { void confirmDialog({ title: '没有正文的确认', action: '知道了', input: { label: '新名称' } }); });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName('没有正文的确认');
    expect(await dialog.getAttribute('aria-describedby')).toBeNull();
    await expect(dialog).toHaveAccessibleDescription('');
    await expect(dialog.getByLabel('新名称', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
