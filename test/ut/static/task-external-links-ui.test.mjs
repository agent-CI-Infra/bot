import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

const scripts = [
  'static/app/states.js',
  'static/app/state.js',
  'static/app/boot.js',
  'static/app/api.js',
  'static/app/addresses.js',
  'static/views/status-text.js',
  'static/views/widgets.js',
  'static/views/task-session.js',
  'static/views/task-records.js',
  'static/workspace.js',
];

function collectText(node) {
  if (!node) return '';
  const parts = [];
  if (node.textContent) parts.push(node.textContent);
  for (const child of node.children || []) parts.push(collectText(child));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

test('isPrTask, objectLabel, and githubUrl use lightweight target without confusing task.request PRs with Issues', () => {
  const page = loadConsole(scripts, async () => [200, {}]);

  // task.request targeting a PR whose summary does not match legacy "PR #..." regex
  const prReq = {
    id: 't-pr-req',
    kind: 'task.request',
    full_name: 'agent-CI-Infra/bot',
    object_number: 1325,
    target: { type: 'pr', number: 1325 },
    summary: 'Fix failing test on workspace sync',
  };
  assert.equal(page.run(`isPrTask(${JSON.stringify(prReq)})`), true);
  assert.equal(page.run(`objectLabel(${JSON.stringify(prReq)})`), 'PR #1325');
  assert.equal(page.run(`githubUrl(${JSON.stringify(prReq)})`), 'https://github.com/agent-CI-Infra/bot/pull/1325');

  // task.request targeting an Issue whose summary mentions "PR #999" must NOT be misclassified as a PR
  const issueReq = {
    id: 't-issue-req',
    kind: 'task.request',
    full_name: 'agent-CI-Infra/bot',
    object_number: 1237,
    target: { type: 'issue', number: 1237 },
    summary: 'PR #999 follow-up issue',
  };
  assert.equal(page.run(`isPrTask(${JSON.stringify(issueReq)})`), false);
  assert.equal(page.run(`objectLabel(${JSON.stringify(issueReq)})`), 'Issue #1237');
  assert.equal(page.run(`githubUrl(${JSON.stringify(issueReq)})`), 'https://github.com/agent-CI-Infra/bot/issues/1237');

  // task.request with target.number even when object_number is null
  const noObjNumPr = {
    id: 't-pr-no-obj',
    kind: 'task.request',
    full_name: 'agent-CI-Infra/bot',
    object_number: null,
    target: { type: 'pr', number: 1400 },
    summary: 'Inspect changes',
  };
  assert.equal(page.run(`isPrTask(${JSON.stringify(noObjNumPr)})`), true);
  assert.equal(page.run(`objectLabel(${JSON.stringify(noObjNumPr)})`), 'PR #1400');
  assert.equal(page.run(`githubUrl(${JSON.stringify(noObjNumPr)})`), 'https://github.com/agent-CI-Infra/bot/pull/1400');

  // Legacy kinds keep exact classification
  assert.equal(page.run(`isPrTask({ kind: 'review.pr', object_number: 12, summary: 'Check' })`), true);
  assert.equal(page.run(`isPrTask({ kind: 'development.pr', object_number: 12, summary: 'Check' })`), true);
  assert.equal(page.run(`isPrTask({ kind: 'development.issue', object_number: 12, summary: 'PR #99 regression' })`), false);
});

test('task detail external bar renders bot PR + root Issue, non-bot PR without Issue, and PR fallback via isPrTask', () => {
  const page = loadConsole(scripts, async () => [200, {}]);
  const sha = 'a'.repeat(40);

  // 1. Running task.request on bot PR #1325 with resolved root Issue #1237 and Actions checks
  const botPrTask = {
    id: 't-bot-pr',
    repository_id: '101',
    full_name: 'agent-CI-Infra/bot',
    kind: 'task.request',
    status: 'running',
    object_number: 1325,
    target: { type: 'pr', number: 1325, ref: sha },
    summary: 'Address review feedback',
    external: {
      issue: { number: 1237, title: 'Support incremental sync', state: 'open', url: 'https://github.com/agent-CI-Infra/bot/issues/1237' },
      pull_request: { number: 1325, title: 'fix(#1237)', state: 'open', draft: false, branch: 'bot/issue-1237', head_sha: sha, url: 'https://github.com/agent-CI-Infra/bot/pull/1325' },
      actions: { status: 'running', head_sha: sha, total: 1, passed: 0, running: 1, failed: 0, checks: [{ name: 'unit', status: 'in_progress', conclusion: null, details_url: 'https://github.com/agent-CI-Infra/bot/runs/1' }], url: 'https://github.com/agent-CI-Infra/bot/pull/1325/checks' },
    },
  };
  page.run(`renderTaskHeader(${JSON.stringify(botPrTask)}, {}); renderTaskSummaryBody(${JSON.stringify(botPrTask)}, {})`);
  assert.equal(page.$('task-title').textContent, 'PR #1325 · Address review feedback');
  const bar1 = page.$('task-external-bar');
  const issueText1 = collectText(bar1.children[0]);
  const prText1 = collectText(bar1.children[1]);
  const actText1 = collectText(bar1.children[2]);
  assert.match(issueText1, /#1237 · Support incremental sync/);
  assert.doesNotMatch(issueText1, /#1325/);
  assert.match(prText1, /PR #1325 \(bot\/issue-1237\)/);
  assert.doesNotMatch(prText1, /尚未创建 PR/);
  assert.match(actText1, /unit ● 运行中/);
  assert.match(actText1, /同步检查/);

  // 2. Non-bot external PR #1400 with ext.issue = null must show "未关联 Issue" (never #1400)
  const extPrTask = {
    id: 't-ext-pr',
    repository_id: '101',
    full_name: 'agent-CI-Infra/bot',
    kind: 'task.request',
    status: 'running',
    object_number: 1400,
    target: { type: 'pr', number: 1400 },
    summary: 'Inspect dependency bump',
    external: {
      issue: null,
      pull_request: { number: 1400, title: 'chore: bump deps', state: 'open', draft: false, branch: 'chore/deps', head_sha: sha, url: 'https://github.com/agent-CI-Infra/bot/pull/1400' },
      actions: { status: 'none', head_sha: sha, total: 0, passed: 0, running: 0, failed: 0, checks: [], url: 'https://github.com/agent-CI-Infra/bot/pull/1400/checks' },
    },
  };
  page.run(`renderTaskHeader(${JSON.stringify(extPrTask)}, {}); renderTaskSummaryBody(${JSON.stringify(extPrTask)}, {})`);
  assert.equal(page.$('task-title').textContent, 'PR #1400 · Inspect dependency bump');
  const bar2 = page.$('task-external-bar');
  assert.match(collectText(bar2.children[0]), /未关联 Issue/);
  assert.doesNotMatch(collectText(bar2.children[0]), /#1400/);
  assert.match(collectText(bar2.children[1]), /PR #1400 \(chore\/deps\)/);

  // 3. Fallback when external is omitted on a PR-targeted task.request must still route to PR, never Issue or "尚未创建 PR"
  const fallbackPrTask = {
    id: 't-fb-pr',
    repository_id: '101',
    full_name: 'agent-CI-Infra/bot',
    kind: 'task.request',
    status: 'queued',
    object_number: 1325,
    target: { type: 'pr', number: 1325 },
    summary: 'Queued revision',
  };
  page.run(`renderTaskSummaryBody(${JSON.stringify(fallbackPrTask)}, {})`);
  const bar3 = page.$('task-external-bar');
  assert.match(collectText(bar3.children[0]), /未关联 Issue/);
  assert.doesNotMatch(collectText(bar3.children[0]), /#1325/);
  assert.match(collectText(bar3.children[1]), /PR #1325/);
  assert.doesNotMatch(collectText(bar3.children[1]), /尚未创建 PR/);
  const prLink3 = bar3.children[1].querySelector('a');
  assert.equal(prLink3.href, 'https://github.com/agent-CI-Infra/bot/pull/1325');

  // 4. Fallback when external is omitted on an Issue-targeted task.request keeps Issue link and "尚未创建 PR"
  const fallbackIssueTask = {
    id: 't-fb-issue',
    repository_id: '101',
    full_name: 'agent-CI-Infra/bot',
    kind: 'task.request',
    status: 'queued',
    object_number: 1237,
    target: { type: 'issue', number: 1237 },
    summary: 'Implement feature',
  };
  page.run(`renderTaskSummaryBody(${JSON.stringify(fallbackIssueTask)}, {})`);
  const bar4 = page.$('task-external-bar');
  assert.match(collectText(bar4.children[0]), /#1237/);
  assert.equal(bar4.children[0].querySelector('a').href, 'https://github.com/agent-CI-Infra/bot/issues/1237');
  assert.match(collectText(bar4.children[1]), /尚未创建 PR/);
});

test('workspace task list row and role board chip label classify task.request PRs accurately', () => {
  const page = loadConsole(scripts, async () => [200, {}]);

  // Bot PR row: shows both root Issue #1237 and PR #1325
  const botPrRow = {
    id: 't-row-bot',
    kind: 'task.request',
    status: 'running',
    priority: 'P1',
    object_number: 1325,
    target: { type: 'pr', number: 1325 },
    summary: 'Revise bot PR',
    external: {
      issue: { number: 1237 },
      pull_request: { number: 1325, state: 'open', draft: false },
    },
    updated_at: '2026-11-24T09:00:00Z',
  };
  const elBot = page.run(`renderWorkbenchTaskRow(${JSON.stringify(botPrRow)})`);
  const botTags = elBot.querySelectorAll('.task-assoc-tag').map(n => n.textContent);
  assert.deepEqual(botTags, ['Issue #1237', 'PR #1325']);

  // Non-bot PR row (ext.issue is null): shows PR #1400 ONLY (never Issue #1400)
  const extPrRow = {
    id: 't-row-ext',
    kind: 'task.request',
    status: 'running',
    priority: 'P2',
    object_number: 1400,
    target: { type: 'pr', number: 1400 },
    summary: 'Review changes',
    external: {
      issue: null,
      pull_request: { number: 1400, state: 'open', draft: false },
    },
    updated_at: '2026-11-24T09:00:00Z',
  };
  const elExt = page.run(`renderWorkbenchTaskRow(${JSON.stringify(extPrRow)})`);
  const extTags = elExt.querySelectorAll('.task-assoc-tag').map(n => n.textContent);
  assert.deepEqual(extTags, ['PR #1400']);

  // Fallback without external on a PR task.request shows PR #1325 ONLY
  const fbRow = {
    id: 't-row-fb',
    kind: 'task.request',
    status: 'queued',
    priority: 'P2',
    object_number: 1325,
    target: { type: 'pr', number: 1325 },
    summary: 'Queued PR revision',
    updated_at: '2026-11-24T09:00:00Z',
  };
  const elFb = page.run(`renderWorkbenchTaskRow(${JSON.stringify(fbRow)})`);
  assert.deepEqual(elFb.querySelectorAll('.task-assoc-tag').map(n => n.textContent), ['PR #1325']);

  // Role board chip labels
  assert.equal(page.run(`roleTaskRefLabel({ task_id: 't1', kind: 'task.request', object_number: 1325, target: { type: 'pr', number: 1325 }, summary: 'Fix' })`), 'PR#1325');
  assert.equal(page.run(`roleTaskRefLabel({ task_id: 't2', kind: 'task.request', object_number: 1237, target: { type: 'issue', number: 1237 }, summary: 'PR #99 follow-up' })`), '#1237');
});
