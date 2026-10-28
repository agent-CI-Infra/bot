import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

test('每个页面都有地址，刷新后停在原页面；全局设置按类别打开；任务列表后台刷新不清空', async ({ page, browser }) => {
  const h = await harness(), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    for (let i = 1; i <= 4; i++) h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,head_sha,attempt) VALUES(?,?,?,?,?,?,?,?,1)",
      't' + i, '101', 'review.issue', i === 1 ? 'running' : 'succeeded', 'Task ' + i, i, i === 1 ? 'model' : 'done', 'a'.repeat(40));
    await page.goto(h.admin); await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // Accounts and users are no longer tabs of their own.
    for (const gone of ['机器人账号', '用户']) await expect(page.locator('#tabs').getByRole('button', { name: gone, exact: true })).toHaveCount(0);
    const tab = name => page.locator('#tabs').getByRole('button', { name, exact: true }), current = () => page.locator('#tabs [aria-current=page]');
    for (const [name, address] of [['看板', '#/board'], ['成本', '#/costs'], ['检视', '#/reviews'], ['开发', '#/developments'], ['Webhook 投递', '#/events'], ['外部执行端', '#/external'], ['项目', '#/projects']]) {
      await tab(name).click(); await expect(page).toHaveURL(new RegExp(address.replace(/[#/]/g, '\\$&') + '$'));
      await page.reload(); await expect(current()).toHaveText(name);
    }
    // Global settings: one category at a time, each with its own address; a reload keeps it.
    await tab('全局设置').click(); await expect(page).toHaveURL(/#\/settings$/);
    const nav = page.locator('.project-nav'), cards = () => page.locator('#settings-panel h3').allInnerTexts();
    await expect(nav.getByRole('link')).toHaveText(['常规', '公网接入', '机器人账号', '模型', '用户']);
    for (const [caption, key, shown] of [['常规', 'general', ['当前运行版本', '同时运行的任务']], ['公网接入', 'access', ['公网 HTTPS 地址', 'Cloudflare Tunnel']],
      ['机器人账号', 'accounts', ['接入向导使用的 GitHub App', '已登记的账号']], ['模型', 'models', ['默认共享模型', '部署共享模型']], ['用户', 'users', ['用户']]]) {
      await nav.getByRole('link', { name: caption, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`#/settings/${key}$`));
      await expect(nav.locator('[aria-current=page]')).toHaveText(caption); await expect.poll(cards).toEqual(shown);
    }
    await page.reload(); await expect(nav.locator('[aria-current=page]')).toHaveText('用户'); await expect(page.locator('#settings-panel')).toContainText('administrator');
    // The old addresses of the two removed tabs open their settings category.
    await page.goto(h.admin + '/#/accounts'); await expect(page).toHaveURL(/#\/settings\/accounts$/); await expect(page.locator('#settings-panel')).toContainText('Test account');
    mkdirSync('.tmp/console-addresses', { recursive: true }); await page.screenshot({ path: '.tmp/console-addresses/settings-accounts-desktop.png', fullPage: true });
    // The task list refreshes in the background without being emptied; finished rows stay the same nodes, and a row whose task
    // changed is replaced in place.
    await tab('检视').click(); await expect(page.locator('#rows > .row')).toHaveCount(4);
    await page.evaluate(() => { window.kept = new Map([...document.querySelectorAll('#rows > .row')].map(node => [node.dataset.key, node])); window.emptied = 0;
      new MutationObserver(() => { if (!document.getElementById('rows').childElementCount) window.emptied++; }).observe(document.getElementById('rows'), { childList: true }); });
    h.store.run("UPDATE tasks SET status='succeeded',phase='done' WHERE id='t1'");
    await expect(page.locator('#rows > .row[data-key=t1] .row-state')).toHaveText('已完成', { timeout: 12000 });
    expect(await page.evaluate(() => [window.emptied, ['t2', 't3', 't4'].every(key => window.kept.get(key) === document.querySelector(`#rows > .row[data-key=${key}]`))])).toEqual([0, true]);
    await expect(page.locator('#count')).not.toHaveText('正在加载…');
    // A project administrator has no global settings; its address falls back to the projects page.
    const memberPassword = testPassword(); await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: ['101'] });
    const context = await browser.newContext(), member = await context.newPage(); await member.goto(h.admin + '/#/settings/users');
    await member.getByLabel('用户名', { exact: true }).fill('member'); await member.getByLabel('密码', { exact: true }).fill(memberPassword); await member.getByRole('button', { name: '登录', exact: true }).click();
    await expect(member.locator('#tabs [aria-current=page]')).toHaveText('项目'); await expect(member.locator('#settings-panel')).toBeHidden(); await context.close();
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(h.admin + '/#/settings/users'); await expect(page.locator('#settings-panel')).toContainText('administrator');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: '.tmp/console-addresses/settings-users-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
