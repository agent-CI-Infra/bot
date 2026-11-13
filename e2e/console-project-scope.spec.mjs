import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// The shell project picker is the console-wide default project scope (#480). Every surface below reads it unless the
// page itself names a scope, in which case that override has to be visible and must not change the default.

async function login(page, h, password, hash = '#/projects', username = 'administrator') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

async function fixture() {
  const h = await harness();
  const { admin, password } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');
  return { h, admin, password };
}

const boardScopes = page => {
  const seen = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname !== '/api/board/cards') return;
    let filters = [];
    try { filters = JSON.parse(url.searchParams.get('filters') || '[]'); } catch { /* a malformed call is not a scope */ }
    seen.push(filters.filter(filter => filter.field === 'repository_id').map(filter => String(filter.value)).join(','));
  });
  return seen;
};

const costScopes = page => {
  const seen = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/costs') seen.push(url.searchParams.get('repository_id') || '');
  });
  return seen;
};

// Clearing or changing the picker re-reads the page asynchronously, so each assertion waits for the read it names instead
// of trusting whichever request happened to be recorded last when the assertion ran.
const boardScopeRequest = (page, expected) => page.waitForRequest(request => {
  const url = new URL(request.url());
  if (url.pathname !== '/api/board/cards') return false;
  let filters = [];
  try { filters = JSON.parse(url.searchParams.get('filters') || '[]'); } catch { return false; }
  return filters.filter(filter => filter.field === 'repository_id').map(filter => String(filter.value)).join(',') === expected;
});
const costScopeRequest = (page, expected) => page.waitForRequest(request => {
  const url = new URL(request.url());
  return url.pathname === '/api/costs' && (url.searchParams.get('repository_id') || '') === expected;
});
// The assistant opens a conversation for its scope, so a scope that really changed asks for a new one.
const conversationScopeRequest = (page, scope) => page.waitForRequest(request => {
  const url = new URL(request.url());
  if (url.pathname !== '/api/management/conversations' || request.method() !== 'POST') return false;
  try { return JSON.parse(request.postData() || '{}').scope === scope; } catch { return false; }
});

test('选择项目后看板、用量和管理助手都以它为默认范围，「全部项目」清掉默认', async ({ page }) => {
  const { h, password } = await fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    const boards = boardScopes(page), costs = costScopes(page);

    // Choosing a project inside a project route keeps the reader in that project.
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);

    // The board takes the shell project as its effective scope, and says so next to its controls.
    let board = boardScopeRequest(page, '101');
    await page.goto(h.admin + '/#/board');
    await board;
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    expect(boards.at(-1)).toBe('101');
    await expect(page.locator('#board-panel')).toContainText('project-101');
    await expect(page.getByRole('link', { name: '新建任务', exact: true })).toHaveAttribute('href', '#/new-task/101');

    // Costs start on the same project instead of all projects.
    const cost101 = costScopeRequest(page, '101');
    await page.goto(h.admin + '/#/costs');
    await cost101;
    await expect(page.getByLabel('统计项目', { exact: true })).toHaveValue('101');
    expect(costs.at(-1)).toBe('101');

    // The management assistant opens on that project rather than on the platform scope.
    await page.goto(h.admin + '/#/management');
    await expect(page.getByLabel('当前管理作用域', { exact: true })).toHaveValue('project:101');

    // 「全部项目」 is the explicit all-project scope: it clears the default without navigating away.
    board = boardScopeRequest(page, '');
    await page.goto(h.admin + '/#/board');
    await page.locator('#console-project').selectOption('');
    await expect(page).toHaveURL(/#\/board$/);
    await board;
    expect(boards.at(-1)).toBe('');
    const costAll = costScopeRequest(page, '');
    await page.goto(h.admin + '/#/costs');
    await costAll;
    await expect(page.getByLabel('统计项目', { exact: true })).toHaveValue('');
    expect(costs.at(-1)).toBe('');
    await page.goto(h.admin + '/#/management');
    await expect(page.getByLabel('当前管理作用域', { exact: true })).toHaveValue('platform');
    await page.goto(h.admin + '/#/management');
    await expect(page.getByLabel('当前管理作用域', { exact: true })).toHaveValue('platform');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('页面自己的临时过滤保持可见，与顶栏默认区分且不改写默认', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    const boards = boardScopes(page), costs = costScopes(page);
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);

    await page.goto(h.admin + '/#/board');
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    let board202 = boardScopeRequest(page, '202');
    await page.getByRole('group', { name: '仓库', exact: true }).locator('button[data-value="202"]').click();
    await board202;
    expect(boards.at(-1)).toBe('202');
    // The override is named as an override, and it still says what the shared default is.
    await expect(page.locator('#board-scope')).toContainText('本页覆盖');
    await expect(page.locator('#board-scope')).toContainText('project-202');
    await expect(page.locator('#board-scope')).toContainText('project-101');
    // The shell default itself is unchanged: the next surface still starts on 101.
    const cost101 = costScopeRequest(page, '101');
    await page.goto(h.admin + '/#/costs');
    await cost101;
    await expect(page.getByLabel('统计项目', { exact: true })).toHaveValue('101');
    await page.getByLabel('统计项目', { exact: true }).selectOption('202');
    const cost202 = costScopeRequest(page, '202');
    await page.getByRole('button', { name: '查看统计', exact: true }).click();
    await cost202;
    expect(costs.at(-1)).toBe('202');
    await expect(page.locator('#costs-scope')).toContainText('本页覆盖');
    await expect(page.locator('#costs-scope')).toContainText('project-202');
    await expect(page.locator('#costs-scope')).toContainText('project-101');
    // Returning to the board keeps the page's own unsaved filter, and it still names the shared default it overrides.
    board202 = boardScopeRequest(page, '202');
    await page.goto(h.admin + '/#/board');
    await board202;
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    expect(boards.at(-1)).toBe('202');
    await expect(page.locator('#board-scope')).toContainText('本页覆盖');
    await expect(page.locator('#console-project')).toHaveValue('101');
  } finally { await h.stop(); }
});

test('桌面侧栏不额外提供新建任务一级入口，项目与导航范围保持不变', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await expect(page.locator('#console-new-task')).toHaveCount(0);
    await expect(page.locator('#console-sidebar').getByRole('link', { name: '＋ 新建任务', exact: true })).toHaveCount(0);
    await expect(page.locator('#console-project')).toHaveValue('101');
    await page.screenshot({ path: '.tmp/console-project-scope/no-primary-task-1440.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 360 });
    await expect(page.locator('#console-project')).toBeVisible();
    await expect(page.locator('#tabs [data-tab=settings]')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/board');
    await expect(page.locator('#console-sidebar')).toBeHidden();
    await expect(page.locator('#console-new-task')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/console-project-scope/no-primary-task-390.png', fullPage: true });
  } finally { await h.stop(); }
});

test('统计页选「所有有权访问的项目」是本页覆盖，不再声称顶栏默认', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    const first = costScopeRequest(page, '101');
    await page.goto(h.admin + '/#/costs');
    await first;
    await expect(page.locator('#costs-scope')).toContainText('顶栏默认');
    // Widening the page's own scope is an override: the request loses its repository and the sentence has to say both that
    // this is a page choice and what the shared default still is.
    const widened = costScopeRequest(page, '');
    await page.getByLabel('统计项目', { exact: true }).selectOption('');
    await page.getByRole('button', { name: '查看统计', exact: true }).click();
    await widened;
    await expect(page.locator('#costs-scope')).toContainText('所有有权访问的项目');
    await expect(page.locator('#costs-scope')).toContainText('本页覆盖');
    await expect(page.locator('#costs-scope')).toContainText('顶栏默认：fixture/project-101');
    await expect(page.locator('#console-project')).toHaveValue('101');
  } finally { await h.stop(); }
});

test('旧的项目全局设置地址落到唯一的项目基本设置页，批量清单仍在', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/settings/projects/101');
    await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
    await expect(page.locator('#project-page')).toBeVisible();
    // The duplicate editor is gone, so the global list still carries the batch operations.
    await page.goto(h.admin + '/#/settings/projects');
    await expect(page.getByRole('button', { name: '同步安装列表', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '全局管理此项目', exact: false }).first())
      .toHaveAttribute('href', '#/projects/101/basic');
  } finally { await h.stop(); }
});

test('浏览器里留下的管理范围不再决定打开范围，换用户清空共享默认', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    // A stale per-user preference must not override the shell choice.
    await page.evaluate(() => localStorage.setItem('management-scope:administrator', 'project:202'));
    await page.goto(h.admin + '/#/management');
    await expect(page.getByLabel('当前管理作用域', { exact: true })).toHaveValue('project:101');
    // Signing out clears the shared default for the next user.
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.locator('#console-sidebar')).toBeHidden();
    await expect(page.locator('#console-project')).toHaveValue('');
    await login(page, h, password, '#/board');
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#console-project')).toHaveValue('');
    await expect(page.locator('#board-panel')).toContainText('全部仓库');
  } finally { await h.stop(); }
});

test('保存看板视图只存页面自己的筛选，顶栏默认不进视图', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    const boards = boardScopes(page);
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    const board101 = boardScopeRequest(page, '101');
    await page.goto(h.admin + '/#/board');
    await board101;
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    expect(boards.at(-1)).toBe('101');
    // A page filter makes the view dirty; saving it must store that filter only.
    await page.getByLabel('搜索编号或标题', { exact: true }).fill('blocked');
    await expect(page.locator('#board-save')).toBeHidden();
    await page.getByRole('button', { name: '更多视图操作', exact: true }).click();
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH'
      && response.url().includes('/api/board/views/'));
    await page.locator('#board-save').click();
    await saved;
    const views = (await admin('/api/board')).value.views;
    const view = views.find(item => item.id === 'default') || views[0];
    expect(JSON.stringify(view.filters)).not.toContain('repository_id');
    expect(JSON.stringify(view.filters)).toContain('blocked');
    // Clearing the shell default returns the same view to all projects.
    const cleared = boardScopeRequest(page, '');
    await page.locator('#console-project').selectOption('');
    await expect(page).toHaveURL(/#\/board$/);
    await cleared;
    await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
    expect(boards.at(-1)).toBe('');
    await expect(page.locator('#board-scope')).toContainText('顶栏未选项目');
  } finally { await h.stop(); }
});

test('跟随顶栏默认时，管理助手的作用域与会话一起真的换过去', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/management');
    const scope = page.getByLabel('当前管理作用域', { exact: true });
    await expect(scope).toHaveValue('platform');
    await expect(page.locator('#management-scope-note')).toContainText('顶栏未选项目');
    // With no page override the assistant follows the shell default: the control, the sentence and the conversation move
    // together, so the answer can never belong to the project the header no longer names.
    let reopened = conversationScopeRequest(page, 'project:101');
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/management$/);
    await reopened;
    await expect(scope).toHaveValue('project:101');
    await expect(page.locator('#management-scope-note')).toContainText('project-101');
    await expect(page.locator('#management-scope-note')).toContainText('顶栏默认');
    // Still following, not an override: the next picker change is followed again.
    reopened = conversationScopeRequest(page, 'project:202');
    await page.locator('#console-project').selectOption('202');
    await reopened;
    await expect(scope).toHaveValue('project:202');
    await expect(page.locator('#management-scope-note')).toContainText('project-202');
  } finally { await h.stop(); }
});

test('页内显式管理范围不被顶栏切换冲掉，跟随默认的那种才跟着走', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/management');
    const scope = page.getByLabel('当前管理作用域', { exact: true });
    await expect(scope).toHaveValue('platform');
    // A scope chosen in the page is explicit: the shell picker must not replace it.
    await scope.selectOption('project:202');
    await expect(page.locator('#management-scope-note')).toContainText('本页覆盖');
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/management$/);
    await expect(scope).toHaveValue('project:202');
    await expect(page.locator('#management-scope-note')).toContainText('本页覆盖');
    // The address names the project the assistant opens on. Because that address also becomes the shell default, the two
    // agree, and one scope gets one wording: it is reported as the default it is, not as an override it is not.
    await page.goto(h.admin + '/#/projects/101/overview');
    await page.locator('#tabs').getByRole('button', { name: '管理对话', exact: true }).click();
    await expect(scope).toHaveValue('project:101');
    await expect(page.locator('#console-project')).toHaveValue('101');
    await expect(page.locator('#management-scope-note')).toContainText('顶栏默认');
    await expect(page.locator('#management-scope-note')).not.toContainText('本页覆盖');
  } finally { await h.stop(); }
});

// #493: a page-local override keeps the assistant on the scope the reader chose, but the shell picker can still change.
// The sentence beside the control has to name the new default in the same frame; the control and the conversation stay.
test('窄屏 390：页内覆盖时顶栏切换在同一帧刷新范围说明，控制与会话不动', async ({ page }) => {
  const { h, password } = await fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/management');
    const scope = page.getByLabel('当前管理作用域', { exact: true });
    await expect(scope).toHaveValue('platform');
    await expect(page.locator('#management-scope-note')).toContainText('顶栏未选项目');
    await scope.selectOption('project:202');
    await expect(page.locator('#management-scope-note')).toContainText('本页覆盖；顶栏未选项目');
    // The sidebar picker is not reachable at this width, so the shell's own change event stands in for the picker change:
    // the value is written and exactly the event the picker dispatches is dispatched on it.
    const note = await page.evaluate(() => {
      const picker = document.getElementById('console-project');
      picker.value = '101';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      // Same frame: read back before any awaited work can repaint the sentence.
      return document.getElementById('management-scope-note')?.textContent || '';
    });
    expect(note).toContain('本页覆盖');
    expect(note).toContain('顶栏默认：fixture/project-101');
    expect(note).not.toContain('顶栏未选项目');
    await expect(scope).toHaveValue('project:202');
    await expect(page).toHaveURL(/#\/management$/);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('桌面 1440：页内覆盖时顶栏切换在同一帧刷新范围说明，控制与会话不动', async ({ page }) => {
  const { h, password } = await fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/management');
    const scope = page.getByLabel('当前管理作用域', { exact: true });
    const note = page.locator('#management-scope-note');
    await expect(scope).toHaveValue('platform');
    await scope.selectOption('project:202');
    await expect(note).toContainText('本页覆盖；顶栏未选项目');
    // The override outlives the picker change: the conversation stays on 202 and the control keeps showing it.
    const opened = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname !== '/api/management/conversations' || request.method() !== 'POST') return;
      try { opened.push(JSON.parse(request.postData() || '{}').scope); } catch { /* a body without a scope is not one */ }
    });
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/management$/);
    // Read straight after the change, before any awaited work: the sentence already names 101 as the shell default.
    const shown = await page.evaluate(() => document.getElementById('management-scope-note')?.textContent || '');
    expect(shown).toContain('本页覆盖');
    expect(shown).toContain('顶栏默认：fixture/project-101');
    expect(shown).not.toContain('顶栏未选项目');
    await expect(scope).toHaveValue('project:202');
    expect(opened).not.toContain('project:101');
    // Back to the default through the page's own control: a scope equal to the shell default is not an override. A route
    // round-trip cannot stand in for this — the chat surface survives navigation, so the panel and its flag are kept.
    await scope.selectOption('project:101');
    await expect(scope).toHaveValue('project:101');
    await expect(note).toContainText('fixture/project-101');
    await expect(note).toContainText('（顶栏默认）');
    await expect(note).not.toContainText('本页覆盖');
    // With no override left the picker moves everything again: one wording, and the conversation the assistant shows is
    // the one it keeps for 202. That conversation already exists from the override above, so following it opens it
    // instead of creating a second one; the switch is read from the session the panel remembers for that scope.
    const sessions = page.getByLabel('持久会话');
    const sessionOf = name => page.evaluate(suffix => {
      const key = Object.keys(localStorage).find(item => item.startsWith('management-conversation:') && item.endsWith(':' + suffix));
      return key ? localStorage.getItem(key) : null;
    }, name);
    const conversationOf202 = await sessionOf('project:202');
    expect(conversationOf202).toBeTruthy();
    await page.locator('#console-project').selectOption('202');
    await expect(scope).toHaveValue('project:202');
    await expect(note).toContainText('fixture/project-202');
    await expect(note).toContainText('（顶栏默认）');
    await expect(note).not.toContainText('本页覆盖');
    await expect(sessions).toHaveValue(conversationOf202);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// #493, negative case: with no page-local override the note keeps its single wording and the conversation really moves
// with the picker, so only the sentence was ever at stake.
test('桌面 1440：无页内覆盖时范围说明仍是顶栏默认，会话随顶栏换', async ({ page }) => {
  const { h, password } = await fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/management');
    const scope = page.getByLabel('当前管理作用域', { exact: true });
    const note = page.locator('#management-scope-note');
    await expect(scope).toHaveValue('platform');
    await expect(note).toContainText('顶栏未选项目');
    // The picker names a project: the sentence names it as the default it is, and the conversation is opened for it.
    const openedOn101 = conversationScopeRequest(page, 'project:101');
    await page.locator('#console-project').selectOption('101');
    // Same frame: the sentence already names 101 as the default, read back before the conversation request is awaited.
    const shownOn101 = await page.evaluate(() => document.getElementById('management-scope-note')?.textContent || '');
    expect(shownOn101).toContain('fixture/project-101');
    expect(shownOn101).toContain('（顶栏默认）');
    await openedOn101;
    await expect(scope).toHaveValue('project:101');
    await expect(note).toContainText('project-101');
    await expect(note).toContainText('顶栏默认');
    await expect(note).not.toContainText('本页覆盖');
    // A second picker change moves everything again: still one wording, and 202 gets its own conversation.
    const openedOn202 = conversationScopeRequest(page, 'project:202');
    await page.locator('#console-project').selectOption('202');
    const shownOn202 = await page.evaluate(() => document.getElementById('management-scope-note')?.textContent || '');
    expect(shownOn202).toContain('fixture/project-202');
    expect(shownOn202).toContain('（顶栏默认）');
    await openedOn202;
    await expect(scope).toHaveValue('project:202');
    await expect(note).toContainText('project-202');
    await expect(note).toContainText('顶栏默认');
    await expect(note).not.toContainText('本页覆盖');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// #493 review: the sentence and the scope control must agree once the picker lands on the project the page override
// names. That scope is the default now, so the next picker change has to move the control and the conversation again.
test('桌面 1440：页内覆盖被顶栏选成默认后，下一次顶栏切换重新跟随', async ({ page }) => {
  const { h, password } = await fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/management');
    const scope = page.getByLabel('当前管理作用域', { exact: true });
    const note = page.locator('#management-scope-note');
    await expect(scope).toHaveValue('platform');
    await scope.selectOption('project:202');
    await expect(note).toContainText('本页覆盖；顶栏未选项目');
    // The picker names the project the page already shows: one scope, one wording, and the control keeps 202.
    await page.locator('#console-project').selectOption('202');
    await expect(scope).toHaveValue('project:202');
    await expect(note).toContainText('fixture/project-202');
    await expect(note).toContainText('（顶栏默认）');
    await expect(note).not.toContainText('本页覆盖');
    // With the override gone, the next picker change really moves the scope and opens 101's conversation.
    const openedOn101 = conversationScopeRequest(page, 'project:101');
    await page.locator('#console-project').selectOption('101');
    await openedOn101;
    await expect(scope).toHaveValue('project:101');
    await expect(note).toContainText('fixture/project-101');
    await expect(note).toContainText('（顶栏默认）');
    await expect(note).not.toContainText('本页覆盖');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// #494 item 1: the single-project editor inside global settings is gone (#480 redirects numeric ids to the project
// workspace). An id that is neither a numeric project nor a list offset must land on the batch list instead of a load
// that never answers.
test('非项目也非清单页的设置地址回落到批量清单，数字项目地址的跳转不变', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    for (const id of ['abc', '0']) {
      await page.goto(h.admin + '/#/settings/projects/' + id);
      await expect(page.getByRole('button', { name: '同步安装列表', exact: true })).toBeVisible();
      await expect(page.locator('#settings-panel')).not.toContainText('正在加载…');
      await expect(page.locator('.global-project-row[data-key="101"]')).toBeVisible();
    }
    // The numeric address still belongs to the project workspace, not to this list.
    await page.goto(h.admin + '/#/settings/projects/101');
    await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
    await expect(page.locator('#project-page')).toBeVisible();
  } finally { await h.stop(); }
});

// #494 item 2: the picker now also runs on #/management, where the page does not re-render. The inbox link carries the
// current project, so it has to follow the same value the assistant followed. (#531 removed the console's own 新建任务
// link from the shell, so this case names the one link that still exists.)
test('管理对话页切换顶栏项目时，带项目的收件箱导航链接跟着切换', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    await page.goto(h.admin + '/#/management');
    await expect(page.locator('#console-project')).toHaveValue('');
    await expect(page.locator('#console-inbox-link')).toHaveAttribute('href', '#/inbox');
    const opened = conversationScopeRequest(page, 'project:101');
    await page.locator('#console-project').selectOption('101');
    await opened;
    await expect(page.locator('#console-inbox-link')).toHaveAttribute('href', '#/inbox/101');
    // Clearing the choice must not leave the link naming the project it just left.
    await page.locator('#console-project').selectOption('');
    await expect(page.locator('#console-inbox-link')).toHaveAttribute('href', '#/inbox');
  } finally { await h.stop(); }
});

// #623: the assistant needs a client before it can follow the picker, and building that client takes one round trip.
// A picker change that lands inside that round trip used to be dropped, leaving the page's scope and the inbox link
// describing two different projects. The first conversation read is held open until the picker has already moved, so
// this case names the window instead of hoping to hit it.
test('管理面板还在连接时切换顶栏项目，作用域与对话也跟上', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    let openRead = true, release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/management/conversations', async route => {
      if (openRead && route.request().method() === 'GET') { openRead = false; await held; }
      await route.continue();
    });
    await login(page, h, password);
    const firstRead = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/management/conversations' && request.method() === 'GET';
    });
    await page.goto(h.admin + '/#/management');
    await firstRead;
    // The panel is drawn and waiting for its first answer, but it has no client yet: this is the change that got lost.
    await page.locator('#console-project').selectOption('101');
    const created = conversationScopeRequest(page, 'project:101');
    release();
    await expect(page.locator('select[aria-label="当前管理作用域"]')).toHaveValue('project:101');
    await expect(page.locator('#console-inbox-link')).toHaveAttribute('href', '#/inbox/101');
    await created;
  } finally { await h.stop(); }
});

// #494 item 3: 「全部项目」 in the picker means one value for the board, usage and the assistant. Visiting the inbox with
// no project clears the shared default as well, instead of only clearing the picker.
test('#/inbox 的「全部项目」同时清掉共享默认，看板与用量读同一个值', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, h, password);
    const boards = boardScopes(page);
    await page.locator('#console-project').selectOption('101');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await page.goto(h.admin + '/#/inbox');
    await expect(page.locator('#console-project')).toHaveValue('');
    // The board no longer reads the project the inbox left behind.
    const boardAll = boardScopeRequest(page, '');
    await page.goto(h.admin + '/#/board');
    await boardAll;
    expect(boards.at(-1)).toBe('');
    await expect(page.locator('#board-scope')).toContainText('顶栏未选项目');
    await expect(page.locator('#board-scope')).not.toContainText('project-101');
    // Costs read the same value, and a later picker choice is a new default again.
    const costAll = costScopeRequest(page, '');
    await page.goto(h.admin + '/#/costs');
    await costAll;
    await expect(page.getByLabel('统计项目', { exact: true })).toHaveValue('');
    await expect(page.locator('#costs-scope')).toContainText('顶栏未选项目');
    // The usage page re-reads in place for a new default; the inbox then clears it again.
    const cost202 = costScopeRequest(page, '202');
    await page.locator('#console-project').selectOption('202');
    await cost202;
    await expect(page).toHaveURL(/#\/costs$/);
    await page.goto(h.admin + '/#/inbox/all');
    await expect(page.locator('#console-project')).toHaveValue('');
  } finally { await h.stop(); }
});
