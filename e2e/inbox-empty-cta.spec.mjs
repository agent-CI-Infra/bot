import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

async function login(page, url, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('待处理为空时给出查看看板和新建任务的下一步（#690）', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    mkdirSync('.tmp/inbox-empty-690', { recursive: true });
    await login(page, h.admin + '/#/inbox', password);
    const empty = page.locator('.console-inbox [data-testid=console-state-empty]');
    await expect(empty.getByRole('heading', { name: '当前范围没有待处理任务', exact: true })).toBeVisible();
    const next = page.locator('.console-inbox-next');
    await expect(next.getByRole('link', { name: '查看任务看板', exact: true })).toHaveAttribute('href', '#/board');
    await expect(next.getByRole('link', { name: '新建任务', exact: true })).toHaveAttribute('href', '#/new-task');
    for (const [width, height, name] of [[390, 844, 'empty-390'], [1440, 900, 'empty-1440']]) {
      await page.setViewportSize({ width, height });
      await expect(next.getByRole('link', { name: '查看任务看板', exact: true })).toBeInViewport();
      await expect(next.getByRole('link', { name: '新建任务', exact: true })).toBeInViewport();
      await page.screenshot({ path: `.tmp/inbox-empty-690/${name}.png` });
    }
    await page.locator('.console-inbox-filters select').selectOption('101');
    await expect(page).toHaveURL(/#\/inbox\/101$/);
    await expect(empty.getByRole('heading', { name: '当前范围没有待处理任务', exact: true })).toBeVisible();
    await expect(page.locator('.console-inbox-next').getByRole('link', { name: '新建任务', exact: true })).toHaveAttribute('href', '#/new-task/101');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('待处理有事项时不出现空状态下一步（#690）', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const time = new Date().toISOString();
    h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,priority,created_at,updated_at)
      VALUES('fail-0','101','review.issue','failed','任务失败',1,'P0',?,?)`, time, time);
    await login(page, h.admin + '/#/inbox', password);
    await expect(page.locator('.console-inbox [data-task-id="fail-0"]')).toBeVisible();
    await expect(page.locator('.console-inbox-next')).toHaveCount(0);
    await expect(page.locator('.console-inbox [data-testid=console-state-empty]')).toHaveCount(0);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
