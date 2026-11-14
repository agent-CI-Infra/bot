import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #697: switching to another page of the same project shows that page's loading state at once, and the 当前页面 picker
// follows the address. The previous page must not stay on screen under the new address while the project is re-read.
const out = '.tmp/project-subpage-loading-697';
const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };

async function holdProject(page) {
  const gate = { held: false, release: () => {} };
  await page.route(/\/api\/repositories\/101$/, async route => {
    if (!gate.held) return route.continue();
    await new Promise(resolve => { gate.release = resolve; });
    await route.continue();
  });
  return gate;
}

test('同一项目内切换子页面立即显示新页面的加载态，「当前页面」同步，同页刷新不闪', async ({ page }) => {
  test.setTimeout(120000);
  const h = await harness(undefined, manager), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await h.projects.reconcile();
    const password = testPassword();
    expect((await admin('/api/users', 'POST', { username: 'member', password, role: 'project_admin', repository_ids: ['101'] })).status).toBe(201);
    await page.setViewportSize({ width: 390, height: 844 });
    const gate = await holdProject(page);
    await page.goto(h.admin + '/#/projects/101/members');
    await page.getByLabel('用户名', { exact: true }).fill('member');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const body = page.locator('#project-page');
    await expect(body.getByText('项目成员与授权来源', { exact: true })).toBeVisible();
    const picker = page.getByRole('combobox', { name: '当前页面', exact: true });
    await expect(picker).toHaveValue('#/projects/101/members');

    // 390: choose 发版本 from the picker while the project read is held.
    gate.held = true;
    await picker.selectOption('#/projects/101/release');
    await expect(page).toHaveURL(/#\/projects\/101\/release$/);
    const loading = body.getByTestId('console-state-loading');
    await expect(loading).toBeVisible();
    await expect(loading.getByRole('heading', { name: '正在打开「发版本」', exact: true })).toBeVisible();
    await expect(body.getByText('项目成员与授权来源', { exact: true })).toHaveCount(0);
    await expect(picker).toHaveValue('#/projects/101/release');
    await expect(body.getByRole('heading', { name: 'fixture/project-101', exact: true })).toBeVisible();
    await page.screenshot({ path: `${out}/switch-loading-390.png` });
    gate.held = false; gate.release();
    await expect(body.getByRole('heading', { name: '准备新版本', exact: true })).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(picker).toHaveValue('#/projects/101/release');
    await page.screenshot({ path: `${out}/switch-done-390.png` });

    // 1440: the same through the address (sidebar breadcrumb instead of the picker).
    await page.setViewportSize({ width: 1440, height: 900 });
    gate.held = true;
    await page.evaluate(() => { location.hash = '#/projects/101/roles'; });
    await expect(loading.getByRole('heading', { name: '正在打开「角色」', exact: true })).toBeVisible();
    await expect(body.getByRole('heading', { name: '准备新版本', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '项目入口' }).locator('[aria-current=page]')).toHaveText('角色');
    await page.screenshot({ path: `${out}/switch-loading-1440.png` });
    gate.held = false; gate.release();
    await expect(loading).toHaveCount(0);
    await expect(body.getByText('正在打开「角色」', { exact: true })).toHaveCount(0);

    // A re-render of the page already on screen keeps it while the read is out (no flash to a loading state).
    await page.evaluate(() => { location.hash = '#/projects/101/release'; });
    await expect(body.getByRole('heading', { name: '准备新版本', exact: true })).toBeVisible();
    gate.held = true;
    const again = page.evaluate(() => renderProject({ id: '101', section: 'release' }));
    await page.waitForTimeout(300);
    await expect(loading).toHaveCount(0);
    await expect(body.getByRole('heading', { name: '准备新版本', exact: true })).toBeVisible();
    gate.held = false; gate.release(); await again;
    await expect(body.getByRole('heading', { name: '准备新版本', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
