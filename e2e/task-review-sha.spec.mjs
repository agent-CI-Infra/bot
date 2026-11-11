import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// The commit a review task inspected is recorded in the task's stored input; the page must name it, and a task of any
// other kind must not grow the row. The sha is a fixture value: nothing here reads GitHub.
const REVIEWED = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,input) VALUES(?,'101','review.pr','failed',?,7,'publish',?)",
    'review-sha', 'Reviewed pull request 7', JSON.stringify({ context: { mode: 'review', repository: 'example/one', reviewed_sha: REVIEWED } }));
  // A development task records reviewed_sha too (the base it started from); its page must not present it as a review.
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,input) VALUES(?,'101','development.pr','failed',?,8,'publish',?)",
    'dev-sha', 'Developed pull request 8', JSON.stringify({ context: { mode: 'development', repository: 'example/one', reviewed_sha: REVIEWED } }));
  return { h, password, close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); } };
}
async function login(page, f) {
  await page.goto(f.h.admin + '/#/inbox/101');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
const open = (page, id) => page.locator(`[data-task-id="${id}"]`).getByRole('button', { name: '查看任务', exact: true }).click();

test('a review task names the commit it inspected, and another kind does not', async ({ page }) => {
  const f = await fixture(), errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    await login(page, f); await open(page, 'review-sha');
    const row = page.locator(`#task-side [data-reviewed-sha]`);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-reviewed-sha', REVIEWED);
    await expect(row).toContainText('检视提交');
    await expect(row).toContainText(REVIEWED);
    await expect(row.locator(`a[href$="/commit/${REVIEWED}"]`)).toHaveCount(1);
    await page.keyboard.press('Escape'); await open(page, 'dev-sha');
    await expect(page.locator('#task-title')).toContainText('PR #8');
    await expect(page.locator('#task-side [data-reviewed-sha]')).toHaveCount(0);
    await expect(page.locator('#task-side')).not.toContainText('检视提交');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
