import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository,testPassword} from '../../fixtures/helpers.mjs';
import {loadConsole} from '../../fixtures/console-page.mjs';

for (const view of ['project_admin', 'super_admin', 'hidden']) {
  test(`${view} project list groups by owner id in first-seen order, with login and name fallbacks`, async () => {
    const row = (id, owner_id, full_name, owner_login = '') => ({id, owner_id, full_name, owner_login, registered: true, enabled: true, running_tasks: 0, queued_tasks: 0});
    let rows = [row('1', '20', 'old-name/first'), row('2', '10', 'alpha/second'), row('3', '20', 'new-name/third', 'renamed-owner'),
      row('4', '30', 'no-slash'), row('5', '40', 'alpha/fourth'), row('6', '10', 'alpha/last')];
    const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
      if (path.startsWith('/api/integrations')) return [200, {integrations: []}];
      return [200, {repositories: rows, syncs: []}];
    });
    page.run(`var projectRoute = () => null; me = {role: '${view === 'hidden' ? 'super_admin' : view}'}; tab = 'projects';`);
    page.$('hidden-filter').checked = view === 'hidden';
    await page.run('render()');
    const groups = page.$('rows').querySelectorAll('.project-owner-group');
    assert.deepEqual(groups.map(group => group.dataset.ownerId), ['20', '10', '30', '40']);
    assert.deepEqual(groups.map(group => group.querySelector('.project-owner-toggle').textContent), ['renamed-owner', 'alpha', '所有者 30', 'alpha']);
    assert.deepEqual(groups.map(group => group.querySelectorAll('.row').map(line => line.dataset.key)), [['1', '3'], ['2', '6'], ['4'], ['5']]);
    assert.equal(page.$('rows').querySelectorAll('.row').length, rows.length, 'every project remains exactly once');
    rows = [rows[0]]; await page.run('render()');
    assert.deepEqual(page.$('rows').querySelectorAll('.project-owner-toggle').map(title => title.textContent), ['old-name']);
    assert.equal(page.$('rows').querySelectorAll('.row').length, 1);
    rows = []; await page.run('render()');
    assert.equal(page.$('rows').querySelectorAll('.project-owner-group').length, 0, 'an empty page has no empty owner groups');
    assert.equal(page.$('rows').querySelectorAll('.row').length, 0, 'access guidance does not invent project rows');
    if (view === 'project_admin') {
      assert.equal(page.$('rows').childElementCount, 1);
      const guidance = page.$('rows').querySelector('.console-state');
      assert.equal(guidance.querySelector('h2').textContent, '已登录，尚无可管理的项目');
      assert.equal(guidance.querySelector('a').href, '#/identity');
      assert.equal(guidance.getAttribute('data-testid'), 'console-state-empty');
      assert.equal(guidance.getAttribute('role'), 'status');
    } else {
      assert.equal(page.$('rows').childElementCount, 1);
      const empty = page.$('rows').querySelector('.console-state');
      assert.equal(empty.querySelector('h2').textContent, view === 'hidden' ? '没有已隐藏的仓库' : '还没有仓库');
      assert.equal(empty.getAttribute('data-testid'), 'console-state-empty');
      assert.equal(empty.getAttribute('role'), 'status');
      assert.match(empty.querySelector('p').textContent, /不是读取失败/);
    }
  });
}

test('the table names the permission state and keeps the gate, permission and board cells refreshable', async () => {
  const base = {registered: true, enabled: true, installed: true, running_tasks: 0, queued_tasks: 0, review_enabled: true,
    development_enabled: false, model_id: 'm', board_enabled: false, board_state: 'none'};
  let rows = [
    { ...base, id: '101', owner_id: '10', full_name: 'fixture/healthy', access_gaps: [] },
    { ...base, id: '102', owner_id: '10', full_name: 'fixture/unchecked', access_gaps: null },
    { ...base, id: '103', owner_id: '10', full_name: 'fixture/stale', access_gaps: [], permissions_stale: true },
  ];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: rows, syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'super_admin'}; tab = 'projects';`);
  await page.run('render()');
  const line = id => page.$('rows').querySelectorAll('.project-list-row').find(row => row.dataset.repositoryId === id);
  const cell = (id, label) => [...line(id).children].find(child => child.dataset.label === label);
  const permission = id => cell(id, 'access').querySelector('[data-permission]');

  // Every row says what was checked: a read with no gap is 正常, an unread or stale one is 未检查 — never a blank column.
  assert.equal(permission('101').textContent, '正常');
  assert.equal(permission('102').textContent, '未检查');
  assert.equal(permission('103').textContent, '未检查');
  // The gate cell keeps the shared chip, so the first background check can replace it in place.
  const gateChip = cell('101', 'gates').querySelector('[data-integration]');
  assert.ok(gateChip, 'the gate cell carries data-integration even before a check runs');
  assert.equal(gateChip.textContent, '发布检查未完成');
  page.run("updateIntegrationChips([{repository_id:'101',gate_state:'live'}])");
  assert.equal(cell('101', 'gates').querySelector('[data-integration]').textContent, '门禁已生效');
  // A permission read replaces the same cell.
  rows = rows.map(row => row.id === '102' ? { ...row, access_gaps: [] } : row);
  page.run('updatePermissionBadges(' + JSON.stringify(rows) + ')');
  assert.equal(permission('102').textContent, '正常');
  // The board chip follows a backend change without a manual reload: the same poll that refreshes the task count.
  rows = rows.map(row => row.id === '101' ? { ...row, board_enabled: true, board_state: 'published' } : row);
  await page.run('refreshProjectActivity()');
  assert.equal(cell('101', 'board').querySelector('[data-board-status]').textContent, '查看看板');
});

// #869: the permission check runs in the background and used to swallow its failure. The column keeps the reading it
// already showed, and the list says which check failed, that the badges are the previous reading, when it was taken, and
// offers the one read that can replace it; that read succeeds and takes the statement away.
test('a failed permission check is stated above the rows and cleared by its one manual read', async () => {
  const base = { owner_id: '10', full_name: 'fixture/project-101', registered: true, enabled: true, installed: true, running_tasks: 0, queued_tasks: 0,
    review_enabled: true, development_enabled: false, model_id: 'm', board_enabled: false, board_state: 'none', access_gaps: [] };
  const stale = { ...base, id: '101', permissions_stale: true, permissions_checked_at: '2026-01-01T00:00:00.000Z' };
  let rows = [stale], check = () => [503, { error: 'github_unavailable' }];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    if (method === 'POST' && path === '/api/installations/permissions/check') return check();
    return [200, { repositories: rows, syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'super_admin'}; tab = 'projects';`);
  const settle = () => new Promise(r => setTimeout(r, 50));
  await page.run('render()'); await settle();
  const chip = () => page.$('rows').querySelectorAll('.project-list-row')[0].querySelector('[data-permission]');
  assert.equal(chip().textContent, '未检查', 'the failed check leaves the reading the column already had');
  const status = page.$('rows').querySelector('[data-testid=project-check-status]');
  assert.ok(status, 'the failed permission check is stated on the list');
  assert.equal(status.dataset.check, 'permissions');
  assert.match(status.textContent, /安装权限检查读取失败（503 · github_unavailable）/);
  // #869 review F3: the permission column shows 未检查 while its reading is stale, so the statement cannot claim the
  // badges are the previous reading; it names the column's own state instead.
  assert.match(status.textContent, /需要重新检查的权限徽章显示「未检查」/);
  assert.doesNotMatch(status.textContent, /还是上次读到的结果/);
  assert.match(status.querySelector('span').textContent, /^上次成功读取：2026-01-01 \d{2}:00:00$/);
  const button = status.querySelector('button');
  assert.equal(button.textContent, '重新检查权限');
  // One request, and nothing scheduled behind the reader's back.
  assert.deepEqual(page.requests.filter(req => req === 'POST /api/installations/permissions/check'), ['POST /api/installations/permissions/check']);
  await settle();
  assert.equal(page.requests.filter(req => req === 'POST /api/installations/permissions/check').length, 1);
  // The manual read replaces the reading and removes the statement together.
  check = () => [200, { repositories: [{ ...base, id: '101', permissions_stale: false, permissions_checked_at: '2026-01-02T00:00:00.000Z' }] }];
  button.listeners.click[0](); await settle();
  assert.equal(page.$('rows').querySelector('[data-testid=project-check-status]'), null);
  assert.equal(chip().textContent, '正常');
  // A check outlives the page that started it: its statement is not drawn onto whatever list is on screen now, and it is
  // still there when the project list comes back.
  check = () => [503, { error: 'github_unavailable' }];
  page.run("tab = 'tasks'"); await page.run('refreshStalePermissions()'); await settle();
  assert.equal(page.$('rows').querySelector('[data-testid=project-check-status]'), null);
  page.run("tab = 'projects'; drawProjectCheckStatus()");
  assert.ok(page.$('rows').querySelector('[data-testid=project-check-status]'), 'the statement belongs to the project list');
});

// #869 review F2: the cached read can itself prove a failed check has since run — every gate record fresh, or every row
// carrying a permission reading and none stale. The statement then goes on its own, instead of staying up until someone
// presses its button, which is also what the top-bar refresh and the onboarding hook go through.
test('a failed gate check is withdrawn when the cache proves the check has since run', async () => {
  const record = { repository_id: '101', gate_state: 'configured', gate_detail: '', dashboard_state: 'none', dashboard_detail: '',
    checked_at: '2026-01-01T00:00:00.000Z', stale: true };
  let integrations = [record];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path === '/api/integrations/check') return [503, { error: 'github_unavailable' }];
    if (path.startsWith('/api/integrations')) return [200, { integrations }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run("var projectRoute = () => null; me = { role: 'super_admin' }; tab = 'projects';");
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  await page.run('render()'); await settle();
  assert.ok(page.$('rows').querySelector('[data-testid=project-check-status]'), 'the failed check is stated first');
  // Nothing else touches the console; the next read is the cache, and it now reports the check as current.
  integrations = [{ ...record, gate_state: 'live', checked_at: '2026-01-02T00:00:00.000Z', stale: false }];
  await page.run('render()'); await settle();
  assert.equal(page.$('rows').querySelector('[data-testid=project-check-status]'), null, 'a cache with nothing stale withdraws the statement');
  assert.equal(page.run('projectCheckFailures.size'), 0);
});

test('a failed permission check is withdrawn when the list proves the check has since run', async () => {
  const base = { owner_id: '10', full_name: 'fixture/project-101', registered: true, enabled: true, installed: true, running_tasks: 0,
    queued_tasks: 0, review_enabled: true, development_enabled: false, model_id: 'm', board_enabled: false, board_state: 'none' };
  let rows = [{ ...base, id: '101', access_gaps: [], permissions_stale: true, permissions_checked_at: '2026-01-01T00:00:00.000Z' }];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, { integrations: [{ repository_id: '101', gate_state: 'live', gate_detail: '',
      dashboard_state: 'none', dashboard_detail: '', checked_at: '2026-01-01T00:00:00.000Z', stale: false }] }];
    if (method === 'POST' && path === '/api/installations/permissions/check') return [503, { error: 'github_unavailable' }];
    return [200, { repositories: rows, syncs: [] }];
  });
  page.run("var projectRoute = () => null; me = { role: 'super_admin' }; tab = 'projects';");
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  await page.run('render()'); await settle();
  assert.ok(page.$('rows').querySelector('[data-testid=project-check-status]'), 'the failed check is stated first');
  // A list that carries a permission reading for every row and calls none of them stale has been checked since.
  rows = [{ ...base, id: '101', access_gaps: [], permissions_stale: false, permissions_checked_at: '2026-01-02T00:00:00.000Z' }];
  await page.run('render()'); await settle();
  assert.equal(page.$('rows').querySelector('[data-testid=project-check-status]'), null, 'a fresh permission reading withdraws the statement');
  assert.equal(page.run('projectCheckFailures.size'), 0);
});

// #869 review F3: with no successful reading there is no old badge to point at, and no time to state either. The
// statement has to say the check never read anything rather than claim a badge is showing a previous reading.
test('a failed gate check that never read anything says so, and invents no time', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path === '/api/integrations/check') return [503, { error: 'github_unavailable' }];
    return [200, { integrations: [], repositories: [], syncs: [] }];
  });
  page.run("var projectRoute = () => null; me = { role: 'super_admin' }; tab = 'projects';");
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  await page.run('render()'); await settle();
  const status = page.$('rows').querySelector('[data-testid=project-check-status]');
  assert.ok(status, 'the cold-start failure is stated');
  assert.match(status.textContent, /还没有成功读取过/);
  assert.doesNotMatch(status.textContent, /还是上次读到的结果/);
  assert.equal(status.querySelector('span'), null, 'no reading time is invented when there is none');
});

// #823: the project-admin list comes from GET /api/repositories, which omits access_gaps / permissions_stale.
// That missing reading is not "never checked"; the column keeps its place with an explained placeholder.
test('the project-admin list does not call an omitted permission reading 未检查', async () => {
  const rows = [
    { id: '101', owner_id: '10', full_name: 'fixture/started', registered: true, enabled: true, running_tasks: 0, queued_tasks: 0,
      review_enabled: true, development_enabled: false, model_id: 'm' },
  ];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    if (path.startsWith('/api/identity')) return [200, { github_connection: { pending_repositories: [] } }];
    if (path.startsWith('/api/installations')) return [403, { error: 'forbidden' }];
    return [200, { repositories: rows, syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects';`);
  await page.run('render()');
  await new Promise(r => setTimeout(r, 20));
  const line = page.$('rows').querySelector('.project-list-row');
  const cell = [...line.children].find(child => child.dataset.label === 'access');
  const chip = cell.querySelector('[data-permission]');
  assert.equal(chip.textContent, '—');
  assert.equal(chip.getAttribute('aria-label'), '仓库安装权限由管理员在安装列表中核对');
  assert.equal(chip.title, '仓库安装权限由管理员在安装列表中核对');
  assert.ok(chip.classList.contains('project-empty'));
  assert.equal(page.$('rows').textContent.includes('未检查'), false);
  assert.equal(page.requests.some(req => req.includes('/api/installations/permissions/check')), false);
  // An installations row that explicitly sends access_gaps: null is still 未检查, even if rendered by the same cell helper.
  page.run(`document.body.append(permissionCell(${JSON.stringify({ id: '202', access_gaps: null })}))`);
  const unread = page.run(`document.body.querySelectorAll('[data-permission]')`);
  assert.equal(unread[unread.length - 1].textContent, '未检查');
});

test('project list read failure is an error state, not an empty list', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, {integrations: []}];
    return [500, { error: 'upstream failed' }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'super_admin'}; tab = 'projects';`);
  await page.run('render()');
  const state = page.$('rows').querySelector('.console-state');
  assert.equal(state.getAttribute('data-testid'), 'console-state-error');
  assert.equal(state.getAttribute('role'), 'alert');
  assert.equal(state.querySelector('h2').textContent, '项目列表未能读取');
  assert.match(state.querySelector('p').textContent, /这不是空列表/);
  assert.equal(page.$('rows').querySelectorAll('.row').length, 0);
  assert.ok(state.querySelector('[data-testid=console-state-retry]'));
  assert.equal(page.$('count').textContent, '读取失败');
});


test('project administrators see installed-but-not-started repositories with one entry into the onboarding wizard (#934)', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [200, { github_connection: { pending_repositories: [{ id: '101', full_name: 'fixture/project-101' }] } }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  await page.run('render()');
  assert.equal(page.$('rows').querySelector('.console-state'), null, 'pending installations are not the empty-project guidance');
  assert.equal(page.$('rows').querySelector('h2').textContent, '待接入的仓库');
  assert.equal(page.$('rows').querySelector('.project-pending-intro').textContent, '这些仓库已装好 GitHub App。点「开始接入」，助手先只读分析仓库、问几个问题并给出方案；你确认后启动，所属组织未受信任的由超级管理员同意后启动。启动后它们出现在上面的项目列表里。');
  assert.equal(page.$('rows').querySelector('strong').textContent, 'fixture/project-101');
  assert.ok([...page.$('rows').querySelectorAll('span')].some(el => el.textContent === '启动需超级管理员同意'));
  assert.equal(page.$('rows').querySelector('.project-pending-row p'), null, '#979: the group intro says it once; the row does not repeat it');
  assert.equal(page.$('rows').querySelector('[data-testid=pending-repo-fold]'), null, 'a short pending list stays open');
  assert.equal(page.$('rows').querySelector('.project-pending-row button'), null, 'no 启动 or 复制提醒: the wizard is the entry');
  const links = [...page.$('rows').querySelectorAll('a')];
  assert.ok(links.every(a => a.href !== '#/projects/101/overview'), 'an unstarted repository has no project page');
  assert.equal(page.$('count').textContent, '0 个项目，1 个待接入');
  assert.deepEqual(links.map(a => a.href), ['#/onboarding/101', '#/identity']);
  assert.equal(links[0].textContent, '开始接入'); assert.equal(links[0].getAttribute('aria-label'), '开始接入 fixture/project-101');
  assert.equal(links[1].querySelector('span').textContent, '查看身份与权限');
});


// #979: dozens of pending repositories fold behind one summary line, and a long list gains a name filter.
test('a long pending-activation list folds behind a count and filters by name', async () => {
  const pending = Array.from({ length: 12 }, (_, i) => ({ id: String(200 + i), full_name: `fixture/repo-${i}` }));
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [200, { github_connection: { pending_repositories: pending } }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  await page.run('render()');
  const fold = page.$('rows').querySelector('[data-testid=pending-repo-fold]');
  assert.ok(fold, 'more than five pending repositories fold');
  assert.equal(fold.tagName, 'DETAILS');
  assert.ok(!fold.open, 'the fold starts closed');
  assert.equal(fold.querySelector('summary').textContent, '查看 12 个待接入仓库');
  assert.equal(fold.querySelectorAll('.project-pending-row').length, 12);
  assert.equal(page.$('count').textContent, '0 个项目，12 个待接入');
  const input = fold.querySelector('[data-testid=pending-repo-search]');
  assert.ok(input, 'more than ten pending repositories get a name filter');
  input.value = 'REPO-1'; input.listeners.input[0]();
  const shown = fold.querySelectorAll('.project-pending-row').filter(row => !row.hidden).map(row => row.dataset.name);
  assert.deepEqual(shown, ['fixture/repo-1', 'fixture/repo-10', 'fixture/repo-11']);
  assert.ok(fold.querySelector('.pending-repo-empty').hidden);
  input.value = 'nothing'; input.listeners.input[0]();
  assert.equal(fold.querySelectorAll('.project-pending-row').filter(row => !row.hidden).length, 0);
  assert.equal(fold.querySelector('.pending-repo-empty').textContent, '没有名称包含「nothing」的待接入仓库');
  assert.ok(!fold.querySelector('.pending-repo-empty').hidden);
});

test('a pending list of six folds without a name filter; the fold and filter survive a redraw', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], () => [200, {}]);
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}`);
  const six = Array.from({ length: 6 }, (_, i) => ({ id: String(i), full_name: 'fixture/six-' + i }));
  const group = page.run(`pendingActivationGroup(${JSON.stringify(six)})`);
  const fold = group.querySelector('[data-testid=pending-repo-fold]');
  assert.equal(fold.querySelector('summary').textContent, '查看 6 个待接入仓库');
  assert.equal(fold.querySelector('[data-testid=pending-repo-search]'), null);
  fold.open = true; fold.listeners.toggle[0]();
  assert.ok(page.run(`pendingActivationGroup(${JSON.stringify(six)})`).querySelector('[data-testid=pending-repo-fold]').open, 'an opened fold stays open after a redraw');
  const many = Array.from({ length: 11 }, (_, i) => ({ id: String(i), full_name: 'fixture/many-' + i }));
  const first = page.run(`pendingActivationGroup(${JSON.stringify(many)})`).querySelector('[data-testid=pending-repo-search]');
  first.value = 'many-10'; first.listeners.input[0]();
  const again = page.run(`pendingActivationGroup(${JSON.stringify(many)})`);
  assert.equal(again.querySelector('[data-testid=pending-repo-search]').value, 'many-10');
  assert.deepEqual(again.querySelectorAll('.project-pending-row').filter(row => !row.hidden).map(row => row.dataset.name), ['fixture/many-10']);
});

test('changing the signed-in account clears the pending fold and filter', async () => {
  const pending = Array.from({ length: 12 }, (_, i) => ({ id: String(200 + i), full_name: `fixture/private-${i}` }));
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [200, { github_connection: { pending_repositories: pending } }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {id: 'a', role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  await page.run('render()');
  const fold = page.$('rows').querySelector('[data-testid=pending-repo-fold]');
  fold.open = true; fold.listeners.toggle[0]();
  const input = fold.querySelector('[data-testid=pending-repo-search]');
  input.value = 'private-1'; input.listeners.input[0]();
  assert.equal(fold.querySelectorAll('.project-pending-row').filter(row => !row.hidden).length, 3);
  page.run(`me = {id: 'b', role: 'project_admin'}`);
  await page.run('render()');
  const again = page.$('rows').querySelector('[data-testid=pending-repo-fold]');
  assert.ok(!again.open, 'the fold is closed after the account changes');
  assert.equal(again.querySelector('[data-testid=pending-repo-search]').value, '');
  assert.equal(again.querySelectorAll('.project-pending-row').filter(row => !row.hidden).length, 12, 'every pending row is visible again');
});

test('a mixed pending group names who starts each repository and gives every row the onboarding entry', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], () => [200, {}]);
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}`);
  const group = page.run(`pendingActivationGroup(${JSON.stringify([
    { id: '1', full_name: 'trusted/repo', self_start: true },
    { id: '2', full_name: 'other/repo', self_start: false },
  ])})`);
  assert.equal(group.querySelector('h2').textContent, '待接入的仓库');
  assert.equal(group.querySelector('.project-pending-intro').textContent, '这些仓库已装好 GitHub App。点「开始接入」，助手先只读分析仓库、问几个问题并给出方案；你确认后启动，所属组织未受信任的由超级管理员同意后启动。启动后它们出现在上面的项目列表里。');
  const rows = [...group.querySelectorAll('.project-pending-row')];
  assert.equal(rows[0].querySelector('.status').textContent, '可自行启动');
  assert.equal(rows[0].querySelector('a').href, '#/onboarding/1');
  assert.equal(rows[1].querySelector('.status').textContent, '启动需超级管理员同意');
  assert.equal(rows[1].querySelector('a').href, '#/onboarding/2');
  assert.ok(rows.every(row => !row.querySelector('button')), 'neither 启动 nor 复制提醒 is left on a row');
  // Only trusted organizations: the intro does not mention a super administrator.
  const trusted = page.run(`pendingActivationGroup(${JSON.stringify([{ id: '1', full_name: 'trusted/repo', self_start: true }])})`);
  assert.equal(trusted.querySelector('.project-pending-intro').textContent, '这些仓库已装好 GitHub App。点「开始接入」，助手先只读分析仓库、问几个问题并给出方案；你确认后启动。启动后它们出现在上面的项目列表里。');
});

test('a failed identity read is a retryable error, not an empty project list', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [500, { error: 'identity_unavailable' }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  await page.run('render()');
  const state = page.$('rows').querySelector('.console-state');
  assert.equal(state.querySelector('h2').textContent, '等待启动的仓库暂时无法读取');
  assert.ok([...state.querySelectorAll('button')].some(el => el.textContent === '重新加载'));
  assert.ok(![...page.$('rows').querySelectorAll('h2')].some(h => h.textContent === '已登录，尚无可管理的项目'));
  assert.match(page.$('count').textContent, /等待启动的仓库暂时无法读取/);
});

test('the pending-activation group is hidden while a project list filter is set', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [200, { github_connection: { pending_repositories: [{ id: '101', full_name: 'fixture/project-101' }] } }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  page.$('owner-filter').value = '10';
  await page.run('render()');
  assert.equal(page.$('rows').querySelector('.project-pending-group'), null);
  assert.equal(page.$('count').textContent, '0 个项目');
  page.$('owner-filter').value = '';
  await page.run('render()');
  assert.equal(page.$('rows').querySelector('.project-pending-group h2').textContent, '待接入的仓库');
  assert.equal(page.$('count').textContent, '0 个项目，1 个待接入');
});

test('project list endpoints filter before taking 50 rows and never expand administrator scope', async t => {
  const h = await harness(t), {admin} = await setup(h), a = await account(admin);
  for (let i = 0; i < 53; i++) {
    const id = String(1000 + i), owner = i % 2 ? '20' : '10', name = `fixture/project-${id}`;
    h.store.run('INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES(?,?,?,?)', id, name, owner, a.id);
    h.store.run('INSERT INTO policies(repository_id) VALUES(?)', id);
    h.store.run('INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,installed,synced_at) VALUES(?,?,?,?,1,?)', a.id, id, name, owner, new Date().toISOString());
  }
  const ids = result => result.value.repositories.map(row => row.id);
  for (const endpoint of ['/api/repositories', '/api/installations']) {
    const all = ids(await admin(endpoint));
    assert.equal(ids(await admin(endpoint + '?limit=50&offset=0')).length, 50);
    assert.deepEqual(ids(await admin(endpoint + '?limit=50&offset=50')), all.slice(50));
    const owned = (await admin(endpoint + '?owner_id=20&limit=50&offset=0')).value.repositories;
    assert.equal(owned.length, 26); assert.ok(owned.every(row => row.owner_id === '20'));
    assert.deepEqual(ids(await admin(endpoint + '?repository_id=1002&limit=50')), ['1002']);
    assert.deepEqual(ids(await admin(endpoint + '?account_id=unknown&limit=50')), []);
    assert.equal((await admin(endpoint + '?limit=1.5')).status, 400);
  }
  const password = testPassword();
  await admin('/api/users', 'POST', {username: 'scoped', password, repository_ids: ['1000', '1001']});
  const member = h.client(); await member('/api/auth/login', 'POST', {username: 'scoped', password});
  assert.deepEqual(ids(await member('/api/repositories?limit=50&offset=0')), ['1000', '1001']);
  assert.deepEqual(ids(await member('/api/repositories?owner_id=20&limit=50')), ['1001']);
  assert.deepEqual(ids(await member('/api/repositories?repository_id=1002&limit=50')), []);
  assert.equal((await member('/api/installations?limit=50')).status, 403);
  h.store.run('UPDATE installed_repositories SET hidden=1');
  const hidden = '/api/installations/hidden';
  assert.equal(ids(await admin(hidden + '?limit=50&offset=0')).length, 50);
  assert.deepEqual(ids(await admin(hidden + '?limit=50&offset=50')), ['1050', '1051', '1052']);
  assert.equal(ids(await admin(hidden + '?owner_id=20&limit=50')).length, 26);
  assert.deepEqual(ids(await admin(hidden + '?repository_id=1002&limit=50')), ['1002']);
  assert.equal((await member(hidden + '?limit=50')).status, 403);
});

test('project lists count all executing and queued tasks without including waiting or finished work, within administrator scope',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  const insert=(id,repo,status)=>h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,?,?,?,?)',id,repo,'review.issue',status,'fixture task');
  insert('running','101','running');insert('other','202','running');
  for(let i=0;i<65;i++)insert('queued-'+i,'101','queued');
  for(const status of ['waiting_configuration','waiting_environment','waiting_pr_head','retry_wait','failed','succeeded','completed','cancelled','superseded'])insert(status,'101',status);
  const counts=rows=>rows.map(r=>[r.id,r.running_tasks,r.queued_tasks]);
  assert.deepEqual(counts((await admin('/api/repositories')).value.repositories),[['101',1,65],['202',1,0]]);
  assert.deepEqual(counts((await admin('/api/installations')).value.repositories),[['101',1,65],['202',1,0]]);
  for(const status of ['preparing','implementing','validating','publishing','result_ready']){
    h.store.run('UPDATE tasks SET status=? WHERE id=?',status,'running');
    assert.equal((await admin('/api/repositories')).value.repositories[0].running_tasks,1);
  }
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id='running'");
  h.store.run("UPDATE tasks SET status='running' WHERE id='queued-0'");
  assert.deepEqual(counts((await admin('/api/repositories')).value.repositories),[['101',1,64],['202',1,0]]);
  const password=testPassword();await admin('/api/users','POST',{username:'member',password,repository_ids:['101']});
  const member=h.client();await member('/api/auth/login','POST',{username:'member',password});
  assert.deepEqual(counts((await member('/api/repositories')).value.repositories),[['101',1,64]]);
  assert.equal((await member('/api/installations')).status,403);
  assert.equal((await member('/api/repositories/202/policy','PATCH',{review_enabled:true})).status,403);
  assert.equal((await member('/api/repositories/101/policy','PATCH',{development_enabled:true})).status,200);
  assert.equal((await member('/api/repositories/101/policy','PATCH',{review_enabled:true})).status,200);
  const policy=(await admin('/api/repositories/101')).value.policy;
  assert.equal(policy.review_enabled,1);assert.equal(policy.development_enabled,1);
  assert.equal((await admin('/api/repositories/202')).value.policy.review_enabled,0);
  await admin('/api/project-admin-assignments','PUT',{user_id:(await admin('/api/users')).value.users.find(u=>u.username==='member').id,repository_ids:[]});
  assert.deepEqual((await member('/api/repositories')).value.repositories,[]);
});
