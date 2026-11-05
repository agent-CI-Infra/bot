import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

test('项目运行状态展示执行和排队任务，自动刷新并保留项目权限', async ({ page, browser }) => {
  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    for (const id of ['101', '202']) await repository(admin, a.id, id);
    const seed = (id, repo, number, status, time) => h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at)
      VALUES(?,?,'review.issue',?,'Review fixture',?,?,?)`, id, repo, status, number, time, time);
    const claim = id => h.store.run("INSERT INTO task_claims VALUES(?,'101','fixture-claim','2026-11-05T00:00:00Z')", id);
    seed('active', '101', 1, 'running', '2026-11-05T00:00:00Z'); claim('active');
    for (let i = 2; i <= 4; i++) seed('queued-' + i, '101', i, 'queued', `2026-11-05T00:00:0${i}Z`);
    seed('foreign', '202', 999, 'queued', '2026-11-05T00:00:00Z');
    // All queued tasks predate the recent-history window; the queue must not be derived from that window.
    for (let i = 0; i < 20; i++) seed('done-' + i, '101', 100 + i, 'succeeded', `2026-11-05T00:01:${String(i).padStart(2, '0')}Z`);
    h.store.run('INSERT INTO task_logs(id,task_id,content) VALUES(?,?,?)', 'command', 'active', JSON.stringify({ type: 'command', command: 'echo COMMAND_HISTORY_ONLY', exit_code: 0 }));
    const login = async (target, username, secret) => {
      await target.goto(h.admin + '/#/projects/101/activity');
      await target.getByLabel('用户名', { exact: true }).fill(username); await target.getByLabel('密码', { exact: true }).fill(secret);
      await target.getByRole('button', { name: '登录', exact: true }).click();
      await expect(target.locator('.project-nav [aria-current=page]')).toHaveText('运行状态');
    };
    await login(page, 'administrator', password);
    const panel = page.locator('#activity-status'), card = title => panel.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(panel.getByRole('heading')).toHaveText(['正在执行 1／1', '排队任务 3', '最近任务']);
    await expect(card('排队任务 3').getByRole('button')).toHaveText(['检视 Issue #2', '检视 Issue #3', '检视 Issue #4']);
    await expect(panel).not.toContainText('最近在虚拟电脑上执行的命令'); await expect(panel).not.toContainText('COMMAND_HISTORY_ONLY');
    await expect(card('最近任务').getByRole('button')).toHaveCount(20);
    await card('排队任务 3').getByRole('button', { name: '检视 Issue #2', exact: true }).click();
    await expect(page.locator('#task-view')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('#task-view')).toBeHidden();
    // Keep the visual evidence compact after checking the full recent-history window above.
    h.store.run("DELETE FROM tasks WHERE id LIKE 'done-%' AND object_number<116"); await page.reload();
    await expect(card('最近任务').getByRole('button')).toHaveCount(8); // Four completed plus four active/queued tasks.
    mkdirSync('.tmp/project-activity', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    const workBox = await card('正在执行 1／1').boundingBox(), queueBox = await card('排队任务 3').boundingBox(), historyBox = await card('最近任务').boundingBox();
    expect(queueBox.x).toBeGreaterThan(workBox.x + workBox.width); expect(historyBox.width).toBeGreaterThan(workBox.width * 1.9);
    expect(historyBox.y).toBeGreaterThan(queueBox.y + queueBox.height);
    await page.screenshot({ path: '.tmp/project-activity/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.project-nav').getByRole('link', { name: '运行状态', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/project-activity/mobile.png', fullPage: true });
    h.store.run("UPDATE tasks SET status='succeeded' WHERE id='active'"); h.store.run("DELETE FROM task_claims WHERE task_id='active'");
    h.store.run("UPDATE tasks SET status='running' WHERE id='queued-2'"); claim('queued-2');
    await expect(panel.getByRole('heading', { name: '排队任务 2', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(card('正在执行 1／1')).toContainText('检视 Issue #2'); await expect(card('排队任务 2')).not.toContainText('检视 Issue #2');
    await page.reload(); await expect(panel.getByRole('heading', { name: '排队任务 2', exact: true })).toBeVisible();
    const memberPassword = testPassword(); await admin('/api/users', 'POST', { username: 'member', password: memberPassword, repository_ids: ['101'] });
    const context = await browser.newContext(), member = await context.newPage();
    try {
      await login(member, 'member', memberPassword); await expect(member.locator('#activity-status')).not.toContainText('#999');
      expect(await member.evaluate(async () => (await fetch('/api/environments/202')).status)).toBe(403);
    } finally { await context.close(); }
    h.store.run("DELETE FROM task_claims WHERE repository_id='101'"); h.store.run("UPDATE tasks SET status='succeeded' WHERE repository_id='101'");
    await expect(panel).toContainText('暂无正在执行的任务。', { timeout: 10000 }); await expect(panel).toContainText('暂无排队任务。');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
