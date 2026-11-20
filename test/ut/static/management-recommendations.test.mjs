import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConsole } from '../../fixtures/console-page.mjs';

function loadManagement() {
  return loadConsole([
    'static/app.js',
    'static/views.js',
    'static/project.js',
    'static/management.js',
  ], () => [200, {}]);
}

const clone = value => JSON.parse(JSON.stringify(value));

test('managementRecommendations tailors fixed prompts to project scope, single-repo platform scope, and multi-repo platform scope', () => {
  const page = loadManagement();
  const projectScoped = clone(page.run(`managementRecommendations({
    scope: 'project:101',
    project: { id: '101', full_name: 'acme/alpha' },
    projects: [{ id: '101', full_name: 'acme/alpha' }, { id: '102', full_name: 'acme/beta' }],
    pendingRepositories: [{ id: '103', full_name: 'acme/gamma' }],
  })`));
  assert.deepEqual(projectScoped.map(item => item.id), ['onboarding', 'gates', 'actions', 'issue']);
  assert.deepEqual(projectScoped.map(item => item.title), ['运行仓库接入助手', '优化门禁', '分析 Actions 运行', '分析 Issue']);
  assert.match(projectScoped[0].prompt, /^请帮我核对并优化仓库 acme\/alpha 的接入配置：/);
  assert.match(projectScoped[1].prompt, /评估并优化仓库 acme\/alpha 的 CI 门禁.*layered-ci-gates/);
  assert.match(projectScoped[2].prompt, /分析仓库 acme\/alpha 的 GitHub Actions 运行/);
  assert.match(projectScoped[3].prompt, /分析仓库 acme\/alpha 的 Issue #/);

  const singlePending = clone(page.run(`managementRecommendations({
    scope: 'platform',
    projects: [],
    pendingRepositories: [{ id: '103', full_name: 'acme/gamma' }],
  })`));
  assert.match(singlePending[0].prompt, /^请帮我接入已安装仓库 acme\/gamma：/);
  assert.match(singlePending[1].prompt, /仓库 acme\/gamma 的 CI 门禁/);
  assert.match(singlePending[2].prompt, /仓库 acme\/gamma 的 GitHub Actions 运行/);
  assert.match(singlePending[3].prompt, /仓库 acme\/gamma 的 Issue #/);

  const singleStarted = clone(page.run(`managementRecommendations({
    scope: 'platform',
    projects: [{ id: '101', full_name: 'acme/alpha' }],
    pendingRepositories: [],
  })`));
  assert.match(singleStarted[0].prompt, /^请帮我核对并优化仓库 acme\/alpha 的接入配置：/);
  assert.match(singleStarted[1].prompt, /仓库 acme\/alpha 的 CI 门禁/);

  // Mixed started + pending repositories in platform scope must not silently pick one repository as target for gates/actions/issue.
  const mixedPlatform = clone(page.run(`managementRecommendations({
    scope: 'platform',
    projects: [{ id: '101', full_name: 'acme/alpha' }, { id: '102', full_name: 'acme/beta' }],
    pendingRepositories: [{ id: '103', full_name: 'acme/gamma' }],
  })`));
  assert.match(mixedPlatform[0].prompt, /acme\/gamma/);
  for (const item of mixedPlatform.slice(1)) {
    assert.doesNotMatch(item.prompt, /acme\/(alpha|beta|gamma)/);
  }

  const multiStarted = clone(page.run(`managementRecommendations({
    scope: 'platform',
    projects: [{ id: '101', full_name: 'acme/alpha' }, { id: '102', full_name: 'acme/beta' }],
    pendingRepositories: [],
  })`));
  assert.match(multiStarted[0].prompt, /请先列出我当前可管理的仓库与待接入仓库/);
  for (const item of multiStarted) {
    assert.doesNotMatch(item.prompt, /acme\/(alpha|beta)/);
  }
});

test('project basic settings source no longer embeds a duplicate repository onboarding entry', () => {
  const basic = readFileSync(new URL('../../../static/project/basic.js', import.meta.url), 'utf8');
  assert.equal(basic.includes('openRepositoryOnboarding'), false);
  assert.equal(basic.includes('仓库接入'), false);
});
