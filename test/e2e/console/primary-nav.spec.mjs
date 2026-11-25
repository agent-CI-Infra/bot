import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';


async function login(page, h, username, password, hash = '#/projects') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

async function visiblePrimaryCaptions(page) {
  return page.locator('#console-sidebar').evaluate(root => {
    const nodes = [...root.querySelectorAll('.console-primary-nav [data-tab], .console-primary-nav a, .console-settings-nav a')]
      .filter(node => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && !node.hidden && node.getClientRects().length;
      });
    return nodes.map(node => (node.textContent || '').trim()).filter(Boolean);
  });
}

// #549, #1369: a project administrator's navigation is a super administrator's without 全局设置. Every page the retired
// 更多功能 directory used to hold has a visible entry: 用量与成本 in the sidebar and the phone bar, 存储 under 个人设置.
test('#549 #1369 项目管理员侧栏没有更多功能，用量与成本和存储有可见入口，1440/768/390 无横向溢出', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness();
  try {
    const { admin } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const password = testPassword();
    const created = await admin('/api/users', 'POST', { username: 'nav-member', password, repository_ids: ['101'] });
    expect(created.status).toBe(201);
    // 组织飞书应用 depends on a capability, not the role, so it is left out of the comparison.
    const personal = ['身份与权限', '飞书绑定', '飞书会话', '外部执行端', '存储'], withoutApps = names => names.filter(name => name !== '组织飞书应用');

    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, 'nav-member', password);
    expect(await visiblePrimaryCaptions(page)).toEqual(['项目', '待处理', '管理助手', '用量与成本', '个人设置']);
    for (const name of ['更多功能', '存储', '全局设置']) await expect(page.locator('#console-sidebar').getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(page.locator('#console-sidebar').getByRole('button', { name: '仓库事件', exact: true })).toHaveCount(0);
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(1440);

    const sidebar = page.locator('#console-sidebar');
    await sidebar.getByRole('link', { name: '用量与成本', exact: true }).click();
    await expect(page).toHaveURL(/#\/costs$/);
    await expect(page.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: '用量与成本', exact: true })).toHaveAttribute('aria-current', 'page');
    // #615: 个人设置 opens #/identity; its category bar now ends with 存储, the projects this administrator holds.
    await sidebar.getByRole('link', { name: '个人设置', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity$/);
    const categories = page.getByRole('navigation', { name: '个人设置类别' });
    await expect(categories.getByRole('link', { name: '存储', exact: true })).toBeVisible();
    expect(withoutApps(await categories.getByRole('link').allInnerTexts())).toEqual(personal);
    await categories.getByRole('link', { name: '存储', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/storage$/);
    await expect(page.locator('#settings-panel')).toContainText('这里统计');
    // The page stays inside 个人设置: same pinned entry, same category bar, and no second bar inside the page.
    await expect(categories.getByRole('link', { name: '存储', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByRole('link', { name: '个人设置', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#settings-panel nav')).toHaveCount(0);
    await expect(page.locator('#console-area')).toHaveText('个人设置');

    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.locator('#console-sidebar')).toBeVisible();
    expect(await visiblePrimaryCaptions(page)).toEqual(['项目', '待处理', '管理助手', '用量与成本', '个人设置']);
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(768);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await expect(page.locator('#console-sidebar')).toBeHidden();
    await expect(page.locator('#console-mobile-nav')).toBeVisible();
    await expect(page.locator('#console-mobile-nav a')).toHaveText(['项目', '待处理', '助手', '用量与成本']);
    const boxes = await page.locator('#console-mobile-nav a').evaluateAll(nodes =>
      nodes.map(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height })));
    expect(boxes.every(b => b.width >= 44 && b.height >= 44)).toBe(true);
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await page.locator('#console-mobile-nav').getByRole('link', { name: '用量与成本', exact: true }).click();
    await expect(page.getByRole('heading', { name: '用量与成本', exact: true })).toBeVisible();
    // The phone reaches 个人设置 from the account menu, and 存储 from its page picker.
    await page.locator('#console-account').click();
    await page.locator('#console-account-menu').getByRole('link', { name: '个人设置', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity$/);
    const picker = page.getByLabel('当前页面', { exact: true });
    await expect(picker.locator('option[value="#/settings/storage"]')).toHaveText('存储');
    expect(withoutApps(await picker.locator('option').allInnerTexts())).toEqual(personal);
    await picker.selectOption('#/settings/storage');
    await expect(page.locator('#settings-panel')).toContainText('这里统计');
    await expect(picker).toHaveValue('#/settings/storage');
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
  } finally { await h.stop(); }
});
