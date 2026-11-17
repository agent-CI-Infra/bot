import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { switchConsoleProject } from './console-scope-picker.mjs';

async function fixture() {
  const h = await harness();
  const { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  return { h, admin, password };
}
async function login(page, h, password, hash = '#/projects', username = 'administrator') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.locator('#access-submit').click();
  await expect(page.locator('#access')).toBeHidden();
}
const trigger = page => page.locator(page.viewportSize().width <= 767 ? '#console-mobile-project' : '#console-project');
const address = (page, id = '') => id ? `#/projects/${id}/${page}` : '#/' + page;
function queries(page, pathname, scope) {
  const seen = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === pathname) seen.push(scope(url, request));
  });
  return seen;
}
const boardScope = url => JSON.parse(url.searchParams.get('filters') || '[]').filter(row => row.field === 'repository_id').map(row => String(row.value)).join(',');
async function ready(page, name, id) {
  await expect(page.locator(page.viewportSize().width <= 767 ? '#console-project' : '#console-mobile-project')).toBeHidden();
  await expect(trigger(page)).toHaveAttribute('data-project-id', id);
  if (name === 'board') {
    await expect(page.locator('#board-columns')).toBeVisible();
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
  } else if (name === 'costs') await expect(page.locator('#cost-body').getByRole('heading', { name: '项目占比', exact: true })).toBeVisible();
  else if (name === 'inbox') {
    await expect(page.locator('.console-inbox')).toBeVisible();
    await expect(page.locator('.console-inbox')).not.toHaveAttribute('aria-busy', 'true');
  } else if (name === 'management') await expect(page.locator('.management-scope-name')).toHaveText(id ? `fixture/project-${id}` : '全部项目');
  else if (id) await expect(page.locator('#console-page h1')).toHaveText(`在 fixture/project-${id} 新建任务`);
  else await expect(page.getByRole('button', { name: '任务项目（必填）', exact: true })).toBeVisible();
}

for (const width of [1440, 390]) test(`地址是唯一范围，各工作页面无重复选择器（${width}）`, async ({ page }) => {
  test.setTimeout(90000);
  const { h, password } = await fixture(), errors = [];
  const boards = queries(page, '/api/board/cards', boardScope), costs = queries(page, '/api/costs', url => url.searchParams.get('repository_id') || '');
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/project-scope-routes', { recursive: true });
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await login(page, h, password);
    for (const id of ['', '101']) for (const name of ['board', 'costs', 'inbox', 'management', 'new-task']) {
      await page.goto(h.admin + '/' + address(name, id)); await ready(page, name, id);
      await expect(page.getByLabel('仓库', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('统计项目', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('当前管理作用域', { exact: true })).toHaveCount(0);
      await expect(page.locator('#console-page select[aria-label="任务项目"]')).toHaveCount(0);
      await expect(page.locator('#board-scope, #costs-scope, #management-scope-note')).toHaveCount(0);
      if (name === 'board') {
        expect(boards.at(-1)).toBe(id);
        await expect(page.locator('#board-create-task')).toHaveAttribute('href', address('new-task', id));
        await expect(page.locator('#board-grouping option[value=repository]')).toHaveCount(id ? 0 : 1);
      }
      if (name === 'costs') expect(costs.at(-1)).toBe(id);
      await page.screenshot({ path: `.tmp/project-scope-routes/${name}-${id || 'all'}-${width}.png` });
      await page.reload(); await ready(page, name, id);
    }
    await page.goto(h.admin + '/#/projects');
    await expect(page.locator('#repository-filter')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('切换器为每类工作页面生成单项目和全部项目地址', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await login(page, h, password, '#/board');
    for (const name of ['board', 'costs', 'inbox', 'management', 'new-task']) {
      await page.goto(h.admin + '/#/' + name); await ready(page, name, '');
      await switchConsoleProject(page, '101');
      await expect(page).toHaveURL(h.admin + '/' + address(name, '101')); await ready(page, name, '101');
      await switchConsoleProject(page, '202');
      await expect(page).toHaveURL(h.admin + '/' + address(name, '202')); await ready(page, name, '202');
      await switchConsoleProject(page, '');
      await expect(page).toHaveURL(h.admin + '/' + address(name)); await ready(page, name, '');
    }
  } finally { await h.stop(); }
});

test('旧待处理和新建地址原地重定向，后退不会再进入旧地址', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await login(page, h, password);
    for (const [old, next] of [['#/inbox/101', '#/projects/101/inbox'], ['#/inbox/101/50', '#/projects/101/inbox/50'], ['#/new-task/101', '#/projects/101/new-task']]) {
      await page.goto(h.admin + '/#/board');
      await page.evaluate(hash => { location.hash = hash; }, old);
      await expect(page).toHaveURL(h.admin + '/' + next);
      await page.goBack(); await expect(page).toHaveURL(h.admin + '/#/board');
    }
    await page.goto(h.admin + '/#/inbox/all/50'); await expect(trigger(page)).toHaveAttribute('data-project-id', '');
    await page.goto(h.admin + '/#/settings/projects/101'); await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
  } finally { await h.stop(); }
});

test('根地址恢复最后范围，明确深链覆盖记忆，个人设置保持当前范围', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await login(page, h, password, '#/projects/101/board'); await ready(page, 'board', '101');
    await page.evaluate(() => { location.hash = '#/identity'; }); await expect(trigger(page)).toHaveAttribute('data-project-id', '101');
    await page.locator('#logout').click(); await expect(page.locator('#access')).toBeVisible();
    await login(page, h, password, ''); await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await page.goto(h.admin + '/#/board'); await ready(page, 'board', '');
    await page.locator('#logout').click(); await expect(page.locator('#access')).toBeVisible();
    await login(page, h, password, '#/'); await expect(page).toHaveURL(h.admin + '/#/projects');
  } finally { await h.stop(); }
});

test('失效记忆降级到全部项目，账号之间不继承范围', async ({ page }) => {
  const { h, admin, password } = await fixture();
  const memberPassword = testPassword();
  const member = (await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: ['101', '202'] })).value.user;
  try {
    await login(page, h, password, '#/projects/101/board'); await ready(page, 'board', '101');
    await page.locator('#logout').click(); await expect(page.locator('#access')).toBeVisible();
    await login(page, h, memberPassword, '', 'member'); await expect(page).toHaveURL(h.admin + '/#/projects');
    await page.goto(h.admin + '/#/projects/202/costs'); await ready(page, 'costs', '202');
    await page.locator('#logout').click(); await expect(page.locator('#access')).toBeVisible();
    await admin('/api/project-admin-assignments', 'PUT', { user_id: member.id, repository_ids: ['101'] });
    await login(page, h, memberPassword, '', 'member'); await expect(page).toHaveURL(h.admin + '/#/projects');
    expect(await page.evaluate(id => localStorage.getItem('console-last-scope:' + id), member.id)).toBe('all');
    await page.locator('#logout').click(); await expect(page.locator('#access')).toBeVisible();
    await login(page, h, password, ''); await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
  } finally { await h.stop(); }
});

test('新地址沿用项目拒绝状态，不查询或泄露无权项目的数据', async ({ page }) => {
  const { h, admin } = await fixture(), password = testPassword();
  await admin('/api/users', 'POST', { username: 'member', password, role: 'project_admin', repository_ids: ['101'] });
  try {
    await login(page, h, password, '#/projects', 'member');
    const forbiddenReads = queries(page, '/api/board/cards', boardScope);
    for (const name of ['board', 'costs', 'inbox', 'management', 'new-task']) {
      await page.goto(h.admin + '/' + address(name, '202'));
      await expect(page.locator('[data-project-unavailable=forbidden]')).toBeVisible();
      await expect(page.locator('#workspace')).not.toContainText('fixture/project-202');
    }
    expect(forbiddenReads).toEqual([]);
  } finally { await h.stop(); }
});

test('已保存仓库条件在全部项目下可移除，单项目忽略，保存不带入地址范围', async ({ page }) => {
  const { h, admin, password } = await fixture();
  const view = (await admin('/api/board/views', 'POST', { name: '旧仓库视图', group_by: 'repository', filters: [{ field: 'repository_id', value: '202' }], hidden_columns: [] })).value.view;
  const boards = queries(page, '/api/board/cards', boardScope);
  try {
    await login(page, h, password, '#/board'); await ready(page, 'board', '');
    await page.locator('#board-view-select').selectOption(view.id);
    await expect.poll(() => boards.at(-1)).toBe('202');
    await expect(page.locator('#board-chips')).toContainText('仓库：fixture/project-202');
    await switchConsoleProject(page, '101'); await ready(page, 'board', '101');
    await expect.poll(() => boards.at(-1)).toBe('101');
    await expect(page.locator('.board-view-scope-note')).toHaveText('此视图的仓库条件在单项目范围内不生效');
    await expect(page.locator('#board-chips')).not.toContainText('仓库');
    await page.getByLabel('搜索编号或标题', { exact: true }).fill('blocked');
    await expect(page.locator('#board-save')).toBeVisible();
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/api/board/views/' + view.id));
    await page.locator('#board-save').click(); await saved;
    const actual = (await admin('/api/board')).value.views.find(row => row.id === view.id);
    expect(actual.filters).toContainEqual({ field: 'repository_id', value: '202' });
    expect(actual.filters).not.toContainEqual({ field: 'repository_id', value: '101' });
    await switchConsoleProject(page, ''); await ready(page, 'board', '');
    await page.getByRole('button', { name: '移除筛选 仓库：fixture/project-202', exact: true }).click();
    await expect.poll(() => boards.at(-1)).toBe('');
  } finally { await h.stop(); }
});

test('管理助手三种范围的会话独立，悬浮窗口跟随地址且不出现组织范围', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await login(page, h, password, '#/management'); await ready(page, 'management', '');
    const ids = {};
    for (const scope of ['', '101', '202', '101', '']) {
      if (scope) await switchConsoleProject(page, scope); else if ((await trigger(page).getAttribute('data-project-id')) !== '') await switchConsoleProject(page, '');
      await ready(page, 'management', scope);
      await expect(page.getByLabel('持久会话', { exact: true })).not.toHaveValue('');
      const id = await page.getByLabel('持久会话', { exact: true }).inputValue();
      if (ids[scope]) expect(id).toBe(ids[scope]); else ids[scope] = id;
    }
    expect(new Set(Object.values(ids)).size).toBe(3);
    await page.locator('#management-chat').getByRole('button', { name: '切换为悬浮窗口', exact: true }).click();
    await page.locator('#management-chat').getByRole('button', { name: '收起管理助手', exact: true }).click();
    await page.evaluate(() => { location.hash = '#/projects/202/board'; }); await ready(page, 'board', '202');
    await page.locator('#management-launcher').click();
    await expect(page.locator('.management-scope-name')).toHaveText('fixture/project-202');
    await expect(page.getByLabel('当前管理作用域', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('持久会话', { exact: true })).toHaveValue(ids['202']);
  } finally { await page.goto('about:blank'); await h.stop(); }
});

test('全部项目的新建任务使用搜索选择，项目草稿各自保留', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await login(page, h, password, '#/new-task');
    await page.getByRole('button', { name: '任务项目（必填）', exact: true }).click();
    await page.locator('#console-scope-search').fill('project-202');
    await page.locator('#console-scope-projects [data-project-id="202"]').click();
    await expect(page).toHaveURL(/#\/projects\/202\/new-task$/);
    const request = page.locator('.task-create-form [name=request]');
    await expect(request).toBeEnabled(); await request.fill('project 202 draft');
    await switchConsoleProject(page, '101'); await expect(request).toHaveValue('');
    await switchConsoleProject(page, '202'); await expect(request).toHaveValue('project 202 draft');
    await expect(page.getByLabel('任务项目', { exact: true })).toHaveCount(0);
  } finally { await h.stop(); }
});

test('任务详情读取成功后使用所属项目并记住范围', async ({ page }) => {
  const { h, password } = await fixture();
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,phase) VALUES('scope-detail','202','review.issue','failed','范围详情','model')");
  try {
    await login(page, h, password, '#/tasks/scope-detail');
    await expect(page.locator('#task-view')).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('data-project-id', '202');
    await page.evaluate(() => { location.hash = '#/identity'; });
    await expect(trigger(page)).toHaveAttribute('data-project-id', '202');
    await page.locator('#logout').click(); await expect(page.locator('#access')).toBeVisible();
    await login(page, h, password, ''); await expect(page).toHaveURL(/#\/projects\/202\/overview$/);
  } finally { await h.stop(); }
});

test('助手连接完成较晚时使用最新地址范围', async ({ page }) => {
  const { h, password } = await fixture();
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/management/query', async route => {
    if (held || route.request().postDataJSON().operation !== 'list_projects') return route.continue();
    held = true; const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
  });
  try {
    await login(page, h, password, '#/management'); await arrived;
    await switchConsoleProject(page, '202');
    await expect(page).toHaveURL(/#\/projects\/202\/management$/);
    release(); await ready(page, 'management', '202');
    await expect(page.getByLabel('持久会话', { exact: true })).not.toHaveValue('');
    await switchConsoleProject(page, ''); await ready(page, 'management', '');
    await expect(page.getByLabel('持久会话', { exact: true })).not.toHaveValue('');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await page.goto('about:blank'); await h.stop(); }
});
