import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #614: a project address this account cannot open says so in plain words, clears 正在读取项目… from the scope bar and
// offers a next step, at desktop and phone widths, while the API keeps answering repository_forbidden (#595).
async function signIn(browser, h, width, username, password) {
  const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(h.admin + '/#/projects'); await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#rows')).toContainText('fixture/project-101');
  return { context, page, errors };
}

test('#614 无权限的项目地址：人话说明、面包屑「无法打开项目」、返回项目列表与身份页入口', async ({ browser }) => {
  const h = await harness();
  try {
    const { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
    const password = testPassword(); await admin('/api/users', 'POST', { username: 'member', password, role: 'project_admin', repository_ids: ['101'] });
    mkdirSync('.tmp/project-unavailable', { recursive: true });
    for (const width of [1440, 390]) {
      const { context, page, errors } = await signIn(browser, h, width, 'member', password);
      // The authorization contract is unchanged: a project that exists and one that does not answer the same way.
      for (const id of ['202', '99999']) expect(await page.evaluate(async id => { try { await api('/api/repositories/' + id); return null; } catch (err) { return { status: err.status, code: err.code }; } }, id))
        .toEqual({ status: 403, code: 'repository_forbidden' });
      for (const address of ['#/projects/202', '#/projects/99999/overview']) {
        await page.goto(h.admin + '/' + address);
        const state = page.locator('#project-page [data-project-unavailable="forbidden"]');
        await expect(state.getByRole('heading', { name: '没有权限打开这个项目', exact: true })).toBeVisible();
        await expect(state).toContainText('当前账号看不到这个项目');
        await expect(page.locator('#console-context')).toHaveText('无法打开项目');
        await expect(page.getByText('403 · repository_forbidden', { exact: true })).toBeHidden();
        await expect(page.getByText('正在读取项目…')).toHaveCount(0); await expect(page.getByText('正在加载…')).toHaveCount(0);
        await expect(state.getByRole('link', { name: '查看身份与权限', exact: true })).toHaveAttribute('href', '#/identity');
        const back = state.getByRole('link', { name: '返回项目列表', exact: true });
        await expect(back).toBeVisible(); await expect(back).toHaveAttribute('href', '#/projects');
        const box = await back.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      // The raw code is still there for support, folded under 详细信息.
      await page.locator('#project-page summary', { hasText: '详细信息' }).click();
      await expect(page.locator('#project-page .console-state-details code')).toHaveText('403 · repository_forbidden');
      await page.screenshot({ path: `.tmp/project-unavailable/forbidden-${width}.png`, fullPage: true });
      await page.locator('#project-page').getByRole('link', { name: '返回项目列表', exact: true }).click();
      await expect(page).toHaveURL(/#\/projects$/); await expect(page.locator('#rows')).toContainText('fixture/project-101');
      expect(errors).toEqual([]); await context.close();
    }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('#614 项目读取失败（非权限问题）时给出重试，重试后正常打开', async ({ browser }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const { context, page, errors } = await signIn(browser, h, 1440, 'administrator', password);
    let fail = true; await page.route('**/api/repositories/101', route => fail ? route.fulfill({ status: 500, json: { error: 'internal_error' } }) : route.continue());
    await page.goto(h.admin + '/#/projects/101/overview');
    const state = page.locator('#project-page [data-project-unavailable="failed"]');
    await expect(state.getByRole('heading', { name: '暂时打不开这个项目', exact: true })).toBeVisible();
    // A project already in the list keeps its name in the scope bar; only an unknown one reads 无法打开项目.
    await expect(page.locator('#console-context')).toHaveText('fixture · project-101');
    await expect(state.getByRole('link', { name: '返回项目列表', exact: true })).toHaveAttribute('href', '#/projects');
    await expect(page.getByText('500 · internal_error', { exact: true })).toBeHidden();
    fail = false; await state.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('#project-page .project-head h1')).toHaveText('fixture/project-101');
    await expect(page.locator('#console-context')).toHaveText('fixture · project-101');
    expect(errors).toEqual([]); await context.close();
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
