import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';

// #756: both static dialogs had a visible `<h2>` but no `aria-labelledby`, so a screen reader announced only "对话框" and
// the reader lost the one thing that says what the dialog is for. The name must come from that same heading — the title
// the page already shows — without touching showModal(), Escape or focus restoration.
test('#756: #editor and #detail take their accessible name from their visible titles', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await h.hook(a.path, a.secret, 'dialog-name-1', { repository: { id: 101, full_name: 'fixture/project-101' }, action: 'opened', issue: { number: 1, title: 'Review' } });
  const event = h.store.get("SELECT id FROM deliveries WHERE delivery_id='dialog-name-1'");
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,source_delivery_id,created_at,updated_at) VALUES('dialog-task','101','review.issue','failed','Review from webhook',1,'complete',?, '2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z')", event.id);
  try {
    await page.goto(h.admin + '/#/projects/101/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible({ timeout: 15000 });

    // The credential/user editor's title is written per kind and per row; here it is the fixed "新增用户" heading.
    await page.getByRole('link', { name: '全局设置', exact: true }).click();
    await page.locator('.project-nav').getByRole('link', { name: '用户', exact: true }).click();
    await page.getByRole('button', { name: '新增用户', exact: true }).click();
    const editor = page.locator('#editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('heading', { name: '新增用户', exact: true })).toBeVisible();
    await expect(editor).toHaveAccessibleName('新增用户');
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();

    // The delivery dialog names itself after the heading the reader sees: 投递详情. The task page opens that same dialog.
    await page.goto(h.admin + '/#/projects/101/inbox');
    await page.locator('[data-task-id="dialog-task"]').getByRole('button', { name: '查看任务', exact: true }).click();
    await page.locator('#task-external-bar').getByRole('button', { name: '查看投递', exact: true }).click();
    const detail = page.locator('#detail');
    await expect(detail.getByRole('heading', { name: '投递详情', exact: true })).toBeVisible();
    await expect(detail).toHaveAccessibleName('投递详情');
    // Escape still closes it as before; no focus or open/close behaviour is changed by the labelling.
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
  } finally { await h.stop(); }
});
