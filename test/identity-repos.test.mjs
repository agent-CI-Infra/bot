// #825: the connected identity overview lists started, openable repositories by name, and keeps
// pending installations in a separate list so "可在项目列表中打开这些仓库" is not attached to them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

const identityPayload = (connection) => ({
  scopes: [],
  tenants: [],
  identities: [],
  actor: { tenant_id: null, authorization_revision: 1 },
  github_connection: connection,
});

function load(connection) {
  const data = identityPayload(connection);
  return loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/identity.js'], (method, path) => {
    if (path === '/api/identity') return [200, data];
    return [200, {}];
  });
}

async function draw(page) {
  page.run(`var projectRoute = () => null; me = { role: 'project_admin', github_verification: null }; tab = 'identity'; location.hash = '#/identity';`);
  await page.run('render()');
  return page.$('identity-panel');
}

test('connected identity lists started repositories and separates pending ones', async () => {
  const page = load({
    state: 'connected',
    repository_count: 1,
    repositories: [{ id: '101', full_name: 'open-x-agents/Douya' }],
    pending_repositories: [{ id: '202', full_name: 'ThinkFlowLab/FlyBot' }],
  });
  const panel = await draw(page);
  assert.equal(panel.querySelector('.identity-connection-status').textContent, '已连接 GitHub，可访问 1 个仓库');
  const next = [...panel.querySelectorAll('p, .note, .muted')].map(node => node.textContent).join('\n');
  assert.match(next, /可在项目列表中打开这些仓库/);
  assert.match(next, /另有 1 个仓库已安装，等待超级管理员启动/);
  const openable = panel.querySelector('.identity-openable-repos a');
  assert.equal(openable.textContent, 'open-x-agents/Douya');
  assert.equal(openable.href, '#/projects/101/overview');
  const pending = panel.querySelector('.identity-pending-repos');
  assert.equal(pending.querySelector('strong').textContent, 'ThinkFlowLab/FlyBot');
  assert.equal(pending.querySelector('.status').textContent, '启动需超级管理员同意');
  // #934: each pending repository opens its onboarding wizard.
  assert.equal(pending.querySelector('a').href, '#/onboarding/202');
  assert.equal(pending.querySelector('a').textContent, '开始接入');
  assert.equal(panel.querySelector('.identity-openable-repos .status'), null);
});

test('pending-only identity keeps pending_activation copy and does not say the repos are openable', async () => {
  const page = load({
    state: 'pending_activation',
    repository_count: 0,
    repositories: [],
    pending_repositories: [{ id: '202', full_name: 'ThinkFlowLab/FlyBot' }],
  });
  const panel = await draw(page);
  assert.match(panel.querySelector('.identity-connection-status').textContent, /已安装但还没有被超级管理员启动/);
  const texts = [...panel.querySelectorAll('p, .note, .muted, li, .status')].map(node => node.textContent).join('\n');
  assert.equal(texts.includes('可在项目列表中打开这些仓库'), false);
  assert.equal(panel.querySelector('.identity-openable-repos'), null);
  assert.equal(panel.querySelector('.identity-pending-repos strong').textContent, 'ThinkFlowLab/FlyBot');
  assert.equal(panel.querySelector('.identity-pending-repos .status').textContent, '启动需超级管理员同意');
});

test('disconnected identity does not list started repositories even when the payload still carries them', async () => {
  const page = load({
    state: 'disconnected',
    repository_count: 1,
    repositories: [{ id: '101', full_name: 'open-x-agents/Douya' }],
    pending_repositories: [{ id: '202', full_name: 'ThinkFlowLab/FlyBot' }],
  });
  const panel = await draw(page);
  assert.equal(panel.querySelector('.identity-openable-repos'), null);
  const texts = [...panel.querySelectorAll('p, .note, .muted, li, a')].map(node => node.textContent).join('\n');
  assert.equal(texts.includes('另有'), false);
  assert.equal(texts.includes('open-x-agents/Douya'), false);
});

// #979: dozens of pending installations fold behind a count so the identity actions below stay in view.
test('a long pending list on the identity page folds behind a count with a name filter', async () => {
  const page = load({
    state: 'pending_activation',
    repository_count: 0,
    repositories: [],
    pending_repositories: Array.from({ length: 11 }, (_, i) => ({ id: String(300 + i), full_name: `fixture/pending-${i}` })),
  });
  const panel = await draw(page);
  const fold = panel.querySelector('[data-testid=pending-repo-fold]');
  assert.ok(fold);
  assert.ok(!fold.open);
  assert.equal(fold.querySelector('summary').textContent, '查看 11 个待接入仓库');
  assert.equal(fold.querySelectorAll('.identity-pending-repos li').length, 11);
  const input = fold.querySelector('[data-testid=pending-repo-search]');
  input.value = 'pending-10'; input.listeners.input[0]();
  assert.deepEqual(fold.querySelectorAll('.identity-pending-repos li').filter(item => !item.hidden).map(item => item.dataset.name), ['fixture/pending-10']);
});

test('a short pending list on the identity page stays open', async () => {
  const page = load({ state: 'pending_activation', repository_count: 0, repositories: [], pending_repositories: [{ id: '202', full_name: 'ThinkFlowLab/FlyBot' }] });
  const panel = await draw(page);
  assert.equal(panel.querySelector('[data-testid=pending-repo-fold]'), null);
  assert.equal(panel.querySelector('.identity-pending-repos strong').textContent, 'ThinkFlowLab/FlyBot');
});
