import test from 'node:test';
import assert from 'node:assert/strict';
import { pullRequestLabels } from '../../../../dist/review/labels.js';
import { applyPullRequestLabels, checkPullRequestLabels } from '../../../../dist/github/pull-request-labels.js';
import { TaskError } from '../../../../dist/agent/common.js';
import { tools } from '../../../../dist/agent/model.js';

// #845: pull request labels follow the classification label rules; no repository is special.
const available = [{ name: 'release:fix' }, { name: 'release:feature' }, { name: 'type/bug' }, { name: 'agent/ok' }, { name: 'priority/critical' }, { name: 'blocker' }, { name: 'bot-develop' }];
function github({ labels = available, current = [], denied = false, readDenied = false } = {}) {
  const state = { posts: [], current: current.map(name => ({ name })) };
  return { state, path: path => path, pages: async path => {
    if (path === '/labels') { if (readDenied) throw new TaskError('github_permission_issues'); return labels; }
    return state.current;
  }, request: async (method, path, body) => {
    if (denied) throw new TaskError('github_http_403');
    state.posts.push({ method, path, body }); for (const name of body.labels) if (!state.current.some(l => l.name === name)) state.current.push({ name });
    return state.current;
  } };
}

test('pull request labels must exist in the repository and be neither reserved nor the bot\'s own', () => {
  assert.deepEqual(pullRequestLabels(['Release:Fix', 'type/bug', 'release:fix'], available, ['bot-develop']), { labels: ['release:fix', 'type/bug'], refused: [] });
  assert.deepEqual(pullRequestLabels(['release:made-up', 'agent/ok', 'priority/critical', 'blocker', 'bot-develop'], available, ['bot-develop']).refused,
    [{ name: 'release:made-up', reason: 'not_in_repository' }, { name: 'agent/ok', reason: 'reserved' }, { name: 'priority/critical', reason: 'reserved' },
      { name: 'blocker', reason: 'reserved' }, { name: 'bot-develop', reason: 'reserved' }]);
  const many = Array.from({ length: 10 }, (_, i) => ({ name: 'area/' + i }));
  assert.deepEqual(pullRequestLabels(many.map(l => l.name), many, []).refused.map(r => r.reason), ['too_many', 'too_many']);
});

test('checking labels returns a correctable tool error and never fails the task for an unreadable label list', async () => {
  assert.deepEqual(await checkPullRequestLabels(github(), undefined, []), { labels: [] });
  assert.deepEqual(await checkPullRequestLabels(github(), ['RELEASE:FEATURE'], []), { labels: ['release:feature'] });
  const refused = await checkPullRequestLabels(github(), ['release:other'], []);
  assert.equal(refused.error, 'pull_request_labels_refused'); assert.deepEqual(refused.refused, [{ name: 'release:other', reason: 'not_in_repository' }]);
  const unreadable = await checkPullRequestLabels(github({ readDenied: true }), ['release:fix'], []);
  assert.equal(unreadable.error, 'pull_request_labels_refused'); assert.match(unreadable.message, /without labels/);
});

test('labels go on the pull request once, keep a person\'s choice on the same axis, and a GitHub refusal does not stop publication', async () => {
  const logs = [], g = github({ current: ['type/feature'] });
  assert.deepEqual(await applyPullRequestLabels(g, 7, ['release:fix', 'type/bug'], value => logs.push(value)), ['release:fix']);
  assert.deepEqual(await applyPullRequestLabels(g, 7, ['release:fix', 'type/bug'], value => logs.push(value)), []);
  assert.deepEqual(g.state.posts, [{ method: 'POST', path: '/issues/7/labels', body: { labels: ['release:fix'] } }]);
  assert.deepEqual(await applyPullRequestLabels(github({ denied: true }), 7, ['release:fix'], value => logs.push(value)), []);
  assert.equal(logs.at(-1).error_code, 'github_http_403');
  assert.deepEqual(await applyPullRequestLabels(g, 7, undefined, value => logs.push(value)), []);
});

test('create_pull_request offers labels without naming any repository', () => {
  const create = tools({ workspaceWrite: true, completion: 'publication' }).find(tool => tool.function.name === 'create_pull_request');
  const { labels, ...rest } = create.function.parameters.properties;
  assert.equal(labels.type, 'array'); assert.ok(!create.function.parameters.required.includes('labels'));
  assert.ok(!('release_label' in rest));
  assert.doesNotMatch(JSON.stringify(create), /sciencediscovery/i);
});
