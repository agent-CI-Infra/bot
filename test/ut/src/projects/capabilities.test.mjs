// #1123: the overview's 「我们能干什么」 card projects six scenario states from settings that already exist. These cases pin
// what each state means, so a lower ceiling, a switched-off event or a disabled role shows the right state and the right
// place to change it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityStates } from '../../../../dist/projects/capabilities.js';

const allEvents = {
  'issue.opened': true, 'issue.updated': true, 'issue.mention': true, 'issue.labels': [], 'issue.development_label': true,
  'pull_request.opened': true, 'pull_request.synchronize': true, 'pull_request.updated': true, 'pull_request.mention': true, 'pull_request.labels': [],
  'review.published.issue': true, 'review.published.pr': true, 'actions.run_failed': true,
};
const base = { enabled: true, ceiling: 'develop', events: allEvents, mentions: true, roles: ['manager', 'reviewer', 'dev', 'test', 'qa'], groups: {}, schedules: 0 };
const states = (change = {}) => Object.fromEntries(capabilityStates({ ...base, ...change, events: { ...allEvents, ...change.events } }).map(c => [c.id, c.state]));
const scenario = (id, change = {}) => capabilityStates({ ...base, ...change, events: { ...allEvents, ...change.events } }).find(c => c.id === id);

test('every scenario is ready at develop with its events on and its roles enabled, each linking to its flow', () => {
  const all = capabilityStates(base);
  assert.deepEqual(all.map(c => c.id), ['qa', 'triage', 'review', 'development', 'testing', 'ci']);
  assert.deepEqual(all.map(c => c.state), ['ready', 'ready', 'ready', 'ready', 'ready', 'ready']);
  assert.deepEqual(all.map(c => c.needs), ['comment', 'comment', 'comment', 'develop', 'comment', 'comment']);
  for (const c of all) assert.equal(c.settings.at(-1), 'manager', c.id);
  assert.match(scenario('development').detail, /不自行合并/);
});

test('the ceiling holds back what needs more, and says which level it needs', () => {
  assert.deepEqual(states({ ceiling: 'comment' }), { qa: 'ready', triage: 'ready', review: 'ready', development: 'ceiling_limited', testing: 'ready', ci: 'ready' });
  assert.deepEqual(states({ ceiling: 'read' }), { qa: 'ceiling_limited', triage: 'ceiling_limited', review: 'ceiling_limited', development: 'ceiling_limited', testing: 'ceiling_limited', ci: 'ceiling_limited' });
  const development = scenario('development', { ceiling: 'comment' });
  assert.match(development.detail, /「可评论和打标签」.*「可开发并开 PR」/);
  assert.equal(development.settings[0], 'triggers');
});

test('a bound Feishu group keeps questions answered below comment, and its level decides what it can ask for', () => {
  assert.equal(states({ ceiling: 'read', groups: { read: 1 } }).qa, 'ready');
  // A read-only group cannot ask for triage or tests; a dispatching one can.
  assert.equal(states({ events: { 'issue.mention': false, 'pull_request.mention': false }, groups: { read: 2 } }).triage, 'off');
  assert.equal(states({ events: { 'issue.mention': false, 'pull_request.mention': false }, groups: { comment: 1 } }).triage, 'ready');
  assert.equal(states({ events: { 'pull_request.mention': false }, groups: { comment: 1 } }).testing, 'off');
  assert.equal(states({ ceiling: 'read', events: { 'pull_request.mention': false }, groups: { dispatch: 1 } }).testing, 'ready');
  assert.match(scenario('qa', { groups: { read: 1, dispatch: 1 } }).detail, /2 个飞书群/);
});

test('without their automatic events, review and development only start on a mention', () => {
  const off = { 'issue.opened': false, 'pull_request.opened': false, 'issue.development_label': false, 'review.published.issue': false };
  assert.equal(states({ events: off }).review, 'mention_only');
  assert.equal(states({ events: off }).development, 'mention_only');
  assert.equal(states({ events: { ...off, 'issue.mention': false, 'pull_request.mention': false } }).review, 'off');
  // BOT_MENTION_NAMES=off: no mention reaches the bot, so nothing is left to start them.
  assert.equal(states({ mentions: false, events: off }).development, 'off');
  // The development label alone keeps development ready.
  assert.equal(states({ events: { ...off, 'issue.development_label': true } }).development, 'ready');
});

test('a disabled role turns its scenario off and points to the roles page', () => {
  for (const [role, id] of [['reviewer', 'review'], ['dev', 'development'], ['test', 'testing']]) {
    const c = scenario(id, { roles: base.roles.filter(r => r !== role) });
    assert.equal(c.state, 'off', id); assert.equal(c.settings[0], 'roles', id);
  }
});

test('CI failures need the Actions switch or a scheduled check, and a stopped project turns everything off', () => {
  assert.equal(states({ events: { 'actions.run_failed': false } }).ci, 'off');
  assert.equal(states({ events: { 'actions.run_failed': false }, schedules: 2 }).ci, 'ready');
  assert.match(scenario('ci', { events: { 'actions.run_failed': false }, schedules: 2 }).detail, /2 个定时检查/);
  assert.deepEqual(Object.values(states({ enabled: false })), ['off', 'off', 'off', 'off', 'off', 'off']);
});
