import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

const out = '.tmp/primary-nav-549';

async function login(page, h, username, password, hash = '#/projects') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

async function visiblePrimaryCaptions(page) {
  return page.locator('#console-sidebar').evaluate(root => {
    const nodes = [...root.querySelectorAll('.console-primary-nav [data-tab], .console-primary-nav a, .console-settings-nav [data-tab]')]
      .filter(node => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && !node.hidden && node.getClientRects().length;
      });
    return nodes.map(node => (node.textContent || '').trim()).filter(Boolean);
  });
}

test('#549 项目管理员桌面侧栏含可见的更多功能，个人设置可从主导航进入，更多不重复且 1440/768/390 无横向溢出', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  mkdirSync(out, { recursive: true });
  try {
    const { admin } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const password = testPassword();
    const created = await admin('/api/users', 'POST', { username: 'nav-member', password, repository_ids: ['101'] });
    expect(created.status).toBe(201);

    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, 'nav-member', password);
    const desktop = await visiblePrimaryCaptions(page);
    expect(desktop).toEqual(['项目', '管理对话', '看板', '待处理', '更多功能']);
    for (const name of ['统计', 'Webhook 投递', '个人设置', '存储', '全局设置']) {
      await expect(page.locator('#console-sidebar').getByRole('button', { name, exact: true })).toBeHidden();
    }
    await expect(page.locator('#console-sidebar').getByRole('link', { name: '更多功能', exact: true })).toBeVisible();
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(1440);
    await page.screenshot({ path: `${out}/nav-member-1440.png`, fullPage: true });

    await page.locator('#console-sidebar').getByRole('link', { name: '更多功能', exact: true }).click();
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    await page.locator('.console-group a').filter({ hasText: '个人设置' }).first().click();
    await expect(page).toHaveURL(/#\/preferences/);
    await page.locator('#console-sidebar').getByRole('link', { name: '更多功能', exact: true }).click();
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    const headings = await page.locator('.console-group h2').allInnerTexts();
    expect(headings).toEqual(['设置', '管理']);
    const settings = (await page.locator('.console-group').filter({ has: page.getByRole('heading', { name: '设置', exact: true }) }).locator('a > span').allInnerTexts()).map(t => t.trim());
    expect(settings).toEqual(['个人设置', '飞书绑定', '身份与权限', '飞书会话']);
    const management = (await page.getByTestId('console-admin-group').locator('a > span').allInnerTexts()).map(t => t.trim());
    expect(management).toEqual(['用量与成本', 'Webhook 投递', '外部执行端', '存储']);
    for (const duplicate of ['项目', '任务', '待处理', '助手', '全部项目', '任务看板', '管理对话', '看板', '全局设置', '接入向导', '安装档案', '机器人账号']) {
      expect([...settings, ...management]).not.toContain(duplicate);
    }
    await page.screenshot({ path: `${out}/more-member-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.locator('#console-sidebar')).toBeVisible();
    expect(await visiblePrimaryCaptions(page)).toEqual(['项目', '管理对话', '看板', '待处理', '更多功能']);
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(768);
    await page.screenshot({ path: `${out}/nav-member-768.png`, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#console-sidebar')).toBeHidden();
    await expect(page.locator('#console-mobile-nav')).toBeVisible();
    await expect(page.locator('#console-mobile-nav a')).toHaveText(['项目', '任务', '待处理', '助手', '更多']);
    const boxes = await page.locator('#console-mobile-nav a').evaluateAll(nodes =>
      nodes.map(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height })));
    expect(boxes.every(b => b.width >= 44 && b.height >= 44)).toBe(true);
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.locator('#console-mobile-nav').getByRole('link', { name: '更多', exact: true }).click();
    await expect(page.getByRole('heading', { name: '更多功能', exact: true })).toBeVisible();
    expect(await page.locator('.console-group h2').allInnerTexts()).toEqual(['设置', '管理']);
    expect((await page.locator('.console-group').filter({ has: page.getByRole('heading', { name: '设置', exact: true }) }).locator('a > span').allInnerTexts()).map(t => t.trim())).toEqual(['个人设置', '飞书绑定', '身份与权限', '飞书会话']);
    await expect(page.getByTestId('console-admin-group')).toBeVisible();
    await expect(page.locator('#console-page')).not.toContainText('全局设置');
    await expect(page.locator('#console-page')).not.toContainText('接入向导');
    await page.screenshot({ path: `${out}/nav-member-390.png`, fullPage: true });

  } finally { await h.stop(); }
});
