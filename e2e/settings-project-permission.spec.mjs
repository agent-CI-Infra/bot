import { test, expect } from '@playwright/test';
import { harness, setup } from '../test/helpers.mjs';

// #977: 设置页的「权限」列用只画缺口的 permissionBadge 覆盖了会命名状态的单元格，无缺口的项目整格是空的
// （DOM 里只剩一个 hidden 的空 span[data-permission]），与 #/projects 的「未检查」对不上；390 下 axe 还把这
// 三个空单元格报成 aria-prohibited-attr（serious）—— 一个用 aria-labelledby 命名的 generic 单元格里没有可读内容。
// 这里用一个固定读数覆盖三种状态：从未读取（未检查）、刚读到的空结果（正常）、读到的缺口（可点徽章）。
const rows = [
  { id: 101, full_name: 'fixture/never-read', owner_id: 10, owner_login: 'fixture', private: true, registered: true, enabled: true,
    review_enabled: true, development_enabled: false, board_enabled: false, installed: true, model_id: 1, account_name: 'fixture',
    access_gaps: null, permissions_stale: false, running_tasks: 0, queued_tasks: 0 },
  { id: 202, full_name: 'fixture/fresh', owner_id: 10, owner_login: 'fixture', private: true, registered: true, enabled: true,
    review_enabled: true, development_enabled: false, board_enabled: false, installed: true, model_id: 1, account_name: 'fixture',
    access_gaps: [], permissions_stale: false, running_tasks: 0, queued_tasks: 0 },
  { id: 303, full_name: 'fixture/gap', owner_id: 10, owner_login: 'fixture', private: true, registered: true, enabled: true,
    review_enabled: true, development_enabled: true, board_enabled: false, installed: true, model_id: 1, account_name: 'fixture',
    access_gaps: [{ kind: 'permission', name: 'contents', required: 'write', current: 'read', features: ['development'] }],
    permissions_stale: false, running_tasks: 0, queued_tasks: 0 },
];
const expects = { 101: '未检查', 202: '正常', 303: '权限不足' };
// Each row's 权限 cell text, keyed by repository id; both pages draw that cell as the row's own direct child.
const permissionTexts = (page, rowSelector) => page.evaluate(selector => Object.fromEntries([...document.querySelectorAll(selector)].map(row => {
  const cell = [...row.children].find(child => child.dataset.label === '权限');
  return [row.dataset.repositoryId, cell ? cell.innerText.trim() : '(missing)'];
})), rowSelector);

test('#977 设置页项目管理的权限列写出三种状态，并与项目列表逐行一致（1440 与 390）', async ({ page }) => {
  test.setTimeout(180000);
  const h = await harness();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const { password } = await setup(h);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('body.console-ready')).toHaveCount(1);

    // A fixed installation reading: the cache read and the by-hand check both answer empty so no background result
    // rewrites these three cells while the test compares them.
    await page.route(url => url.pathname === '/api/installations' && url.search.includes('limit=51'),
      route => route.fulfill({ json: { repositories: rows } }));
    await page.route(url => url.pathname === '/api/integrations', route => route.fulfill({ json: { integrations: [] } }));
    await page.route(url => url.pathname === '/api/integrations/check', route => route.fulfill({ json: { integrations: [] } }));
    await page.route(url => url.pathname === '/api/trusted-organizations', route => route.fulfill({ json: { organizations: [], candidates: [] } }));
    await page.route(url => url.pathname === '/api/models', route => route.fulfill({ json: { models: [] } }));

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(h.admin + '/#/projects');
      await expect(page.locator('.project-list-row')).toHaveCount(3);
      const projects = await permissionTexts(page, '.project-list-row');
      await page.goto(h.admin + '/#/settings/projects');
      await expect(page.locator('.global-project-row')).toHaveCount(3);
      const settings = await permissionTexts(page, '.global-project-row');
      expect(projects).toEqual(expects);
      expect(settings).toEqual(expects);
      // Every cell keeps the [data-permission] node the background check replaces in place.
      await expect(page.locator('.global-project-row [data-label="权限"] [data-permission]')).toHaveCount(3);
      // The shape axe reported at 390: a labelled generic cell with nothing readable inside it.
      expect(await page.evaluate(() => [...document.querySelectorAll('.global-project-row [data-label="权限"]')]
        .filter(cell => !cell.innerText.trim()).map(cell => cell.closest('[data-repository-id]').dataset.repositoryId))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
