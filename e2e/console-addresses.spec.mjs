import { consoleNavigate } from './console-navigation.mjs';
import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

test('每个页面都有地址，旧任务地址进入看板类别；全局设置按类别打开', async ({ page, browser }) => {
  const h = await harness(), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    for (let i = 1; i <= 4; i++) h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,phase,head_sha,attempt) VALUES(?,?,?,?,?,?,?,?,1)",
      't' + i, '101', 'review.issue', i === 1 ? 'running' : 'succeeded', 'Task ' + i, i, i === 1 ? 'model' : 'done', 'a'.repeat(40));
    await page.goto(h.admin); await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // Navigation and reload must wait until the login response has installed the session cookie.
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    // Accounts, users, review and development no longer have top-level tabs.
    for (const gone of ['机器人账号', '用户', '检视', '开发', '接入向导', '消息渠道']) await expect(page.locator('#tabs').getByRole('button', { name: gone, exact: true })).toHaveCount(0);
    const tab = name => ({ click: () => consoleNavigate(page, name) }), current = () => page.locator('#tabs [aria-current=page]');
    for (const [name, address] of [['看板', '#/board'], ['统计', '#/costs'], ['Webhook 投递', '#/events'], ['外部执行端', '#/external'], ['管理对话', '#/management'], ['项目', '#/projects']]) {
      await tab(name).click(); await expect(page).toHaveURL(new RegExp(address.replace(/[#/]/g, '\\$&') + '$'));
      await page.reload(); await expect(current()).toHaveText(name === '外部执行端' ? '个人设置' : name);
      if (name === '外部执行端') await expect(page.locator('#console-secondary-nav .project-nav [aria-current=page]')).toHaveText('外部执行端');
    }
    for (const [address, category] of [['#/reviews', 'review'], ['#/developments', 'development']]) {
      await page.goto(h.admin + '/' + address); await expect(current()).toHaveText('看板'); await expect(page.getByRole('group',{name:'工作类型',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value',category);
      await expect(page).toHaveURL(/#\/board$/); await page.reload(); await expect(current()).toHaveText('看板'); await expect(page.getByRole('group',{name:'工作类型',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','');
    }
    // Global settings: one category at a time, each with its own address; a reload keeps it.
    await tab('全局设置').click(); await expect(page).toHaveURL(/#\/settings$/);
    const nav = page.locator('.project-nav'), cards = () => page.locator('#settings-panel h3').allInnerTexts();
    await expect(nav.getByRole('link')).toHaveText(['工作电脑', '模型', '服务角色', '助手电脑', '存储', '接入向导', '公网接入', '外部执行', '机器人账号', '安装档案', '飞书连接', '项目管理', '用户']);
    for (const [caption, key, shown] of [['工作电脑', 'work-computers', ['同时运行的任务', '默认资源', '当前运行版本']], ['飞书连接', 'feishu', ['飞书应用连接']], ['公网接入', 'access', ['公网 HTTPS 地址', 'Cloudflare Tunnel', 'GitHub 登录（只读）']],
      ['机器人账号', 'accounts', ['接入向导使用的 GitHub App', '已登记的账号', 'GitHub 请求额度']], ['安装档案', 'installations', ['GitHub App 安装档案']],
      ['模型', 'models', ['默认共享模型', '部署共享模型']], ['存储', 'storage', ['存储', '数据盘', '可回收与最近清理', '按天数清理', '数据库与磁盘', '历史数据迁移', '按项目', '项目电脑']], ['用户', 'users', ['用户']]]) {
      await expect(nav.getByRole('link', { name: caption, exact: true })).toHaveAttribute('href', `#/settings/${key}`);
      await nav.getByRole('link', { name: caption, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`#/settings/${key}$`));
      await expect(nav.locator('[aria-current=page]')).toHaveText(caption); await expect.poll(cards).toEqual(shown);
    }
    // Controls of the projects list stay with it.
    await expect(page.locator('#hidden-filter-label')).toBeHidden(); await expect(page.locator('#sync')).toBeHidden();
    await page.reload(); await expect(nav.locator('[aria-current=page]')).toHaveText('用户'); await expect(page.locator('#settings-panel')).toContainText('administrator');
    // The old addresses of the two removed tabs open their settings category.
    await page.goto(h.admin + '/#/accounts'); await expect(page).toHaveURL(/#\/settings\/accounts$/); await expect(page.locator('#settings-panel')).toContainText('Test account');
    mkdirSync('.tmp/console-addresses', { recursive: true }); await page.screenshot({ path: '.tmp/console-addresses/settings-accounts-desktop.png', fullPage: true });
    // A changed task is picked up by the board's quiet refresh without leaving the selected category.
    await page.goto(h.admin + '/#/reviews'); await expect(page.locator('.board-card')).toHaveCount(4);
    h.store.run("UPDATE tasks SET status='succeeded',phase='done' WHERE id='t1'");
    await page.evaluate(() => boardPoll()); await expect(page.locator('[data-card-key="101/issue/1"]')).toContainText('检视 Issue 已完成');
    await expect(page.getByRole('group',{name:'工作类型',exact:true}).locator('button[aria-pressed=true]')).toHaveAttribute('data-value','review');
    // A project administrator has no global settings; its address falls back to the projects page.
    const memberPassword = testPassword(); await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: ['101'] });
    const context = await browser.newContext(), member = await context.newPage(); await member.goto(h.admin + '/#/settings/users');
    await member.getByLabel('用户名', { exact: true }).fill('member'); await member.getByLabel('密码', { exact: true }).fill(memberPassword); await member.getByRole('button', { name: '登录', exact: true }).click();
    await expect(member.locator('#tabs [aria-current=page]')).toHaveText('项目'); await expect(member.locator('#settings-panel')).toBeHidden();
    // #549: 存储 leaves the project administrator's sidebar; the address still opens (permissions unchanged).
    await expect(member.locator('#tabs').getByRole('button', { name: '全局设置', exact: true })).toBeHidden();
    await expect(member.locator('#tabs').getByRole('button', { name: '存储', exact: true })).toBeHidden();
    await member.goto(h.admin + '/#/settings/storage'); await expect(member.locator('#settings-panel')).toBeVisible();
    await expect(member.locator('.project-nav').getByRole('link')).toHaveText(['存储']);
    // A project administrator sees its projects' trajectories and computers, nothing of the host (#671).
    await expect.poll(() => member.locator('#settings-panel h3').allInnerTexts()).toEqual(['存储', '按项目', '项目电脑']);
    await expect(member.locator('#settings-panel')).toContainText('fixture/project-101'); await context.close();
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(h.admin + '/#/settings/users'); await expect(page.locator('#settings-panel')).toContainText('administrator');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: '.tmp/console-addresses/settings-users-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
