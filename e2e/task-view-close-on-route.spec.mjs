import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #936: a task detail opened from 待处理 or the board is a dialog of that page. When the address moves to another page,
// route() has to close it - otherwise the reader lands on the target page with the old dialog still on top and has to
// close it by hand. A repaint of the same address (a list refresh or a poll) is not a page change and must keep it.
async function fixture() {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase) VALUES('route-task','101','review.pr','failed','Route task',7,'model')");
  for (let i = 0; i < 5; i++) h.store.run("INSERT INTO task_logs(id,task_id,content) VALUES(?,?,?)", 'route-line-' + i, 'route-task',
    JSON.stringify({ type: 'model', step: i + 1, content: 'Public output ' + i }));
  return { h, admin, password, close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); } };
}
async function login(page, f) {
  await page.goto(f.h.admin + '/#/inbox/101');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('[data-task-id="route-task"]')).toBeVisible();
}
const taskView = page => page.locator('#task-view');
const openTask = page => page.locator('[data-task-id="route-task"]').getByRole('button', { name: '查看任务', exact: true }).click();
const setAddress = (page, hash) => page.evaluate(next => { location.hash = next; }, hash);

test('changing the address closes the task detail at 390 and at desktop width', async ({ page }) => {
  const f = await fixture(), errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await login(page, f);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openTask(page);
      await expect(taskView(page)).toBeVisible();
      await expect(page.locator('#task-title')).toContainText('PR #7');
      await setAddress(page, '#/inbox');
      // The target page is drawn and the dialog of the page that was left is gone.
      await expect(page.locator('#console-page')).toBeVisible();
      await expect(taskView(page)).toBeHidden();
      // Usable, not merely visible: the list that arrived still opens a task of its own.
      await expect(page.getByRole('button', { name: '查看任务', exact: true })).toBeVisible();
      await page.locator('[data-task-id="route-task"]').getByRole('button', { name: '查看任务', exact: true }).click();
      await expect(taskView(page)).toBeVisible();
      await page.getByRole('button', { name: '关闭', exact: true }).first().click();
      await expect(taskView(page)).toBeHidden();
      await setAddress(page, '#/inbox/101');
      await expect(page.locator('[data-task-id="route-task"]')).toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('a repaint of the same address keeps the task detail open', async ({ page }) => {
  const f = await fixture(), errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await login(page, f);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openTask(page);
      await expect(taskView(page)).toBeVisible();
      // The same route the poll and the list refresh take: the address did not move, so the dialog stays.
      await page.evaluate(() => route());
      await expect(taskView(page)).toBeVisible();
      await expect(page.locator('#task-title')).toContainText('PR #7');
      await expect(page.locator('#timeline .step')).not.toHaveCount(0);
      await page.getByRole('button', { name: '关闭', exact: true }).first().click();
      await expect(taskView(page)).toBeHidden();
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('changing the address closes an open delivery detail as well', async ({ page }) => {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await h.hook(a.path, a.secret, 'delivery-route', { repository: { id: 101, full_name: 'fixture/project-101' }, action: 'opened', issue: { number: 1, title: 'Review' } });
  const event = h.store.get("SELECT id FROM deliveries WHERE delivery_id='delivery-route'");
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,source_delivery_id,created_at,updated_at) VALUES('delivery-task','101','review.issue','failed','Review from webhook',1,'complete',?,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z')", event.id);
  const errors = []; page.on('pageerror', err => errors.push(err.message));
  try {
    await page.goto(h.admin + '/#/inbox/101');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('[data-task-id="delivery-task"]').getByRole('button', { name: '查看任务', exact: true }).click();
    await expect(taskView(page)).toBeVisible();
    const source = page.locator('#task-side [data-source-delivery]');
    await expect(source).toBeVisible();
    await source.getByRole('button', { name: '查看投递', exact: true }).click();
    await expect(page.locator('#detail')).toBeVisible();
    await setAddress(page, '#/inbox');
    await expect(page.locator('#detail')).toBeHidden();
    await expect(taskView(page)).toBeHidden();
    await expect(page.locator('#console-page')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
