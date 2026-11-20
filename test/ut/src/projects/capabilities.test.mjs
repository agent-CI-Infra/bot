// #1123: the overview's 「我们能干什么」 card projects six scenario states from settings that already exist. These cases pin
// what each state means, so a lower ceiling, a switched-off event or a disabled role shows the right state and the right
// place to change it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityStates, chatCapabilities, chatExamplesFor, groupCapabilityNotice, groupGatesOf, groupVenue } from '../../../../dist/projects/capabilities.js';
import { levelPermissions } from '../../../../dist/channels/service-bindings.js';

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

// The chat capability card (#1123): a Feishu group's level narrows what the project allows; a GitHub thread reaches the Manager.
const chat = (venue, change = {}) => Object.fromEntries(chatCapabilities({ ...base, ...change, events: { ...allEvents, ...change.events } }, venue).map(c => [c.id, c.state]));
const readGroup = { kind: 'feishu_group', issues: false, pulls: false, dispatch: false }, commentGroup = { kind: 'feishu_group', issues: true, pulls: true, dispatch: false }, dispatchGroup = { kind: 'feishu_group', issues: true, pulls: true, dispatch: true };

test('a read-only group answers questions and reads CI, and cannot ask for writes or work', () => {
  assert.deepEqual(chat(readGroup), { qa: 'ready', triage: 'level_limited', review: 'level_limited', development: 'level_limited', testing: 'level_limited', ci: 'ready' });
  assert.deepEqual(chat(commentGroup), { qa: 'ready', triage: 'ready', review: 'level_limited', development: 'level_limited', testing: 'level_limited', ci: 'ready' });
  assert.deepEqual(chat(dispatchGroup), { qa: 'ready', triage: 'ready', review: 'ready', development: 'ready', testing: 'ready', ci: 'ready' });
});

test('the project still decides: its ceiling, its roles and a stopped project narrow every chat', () => {
  // A dispatching group of a comment-level project cannot get development; tests report back to the group at any ceiling.
  assert.deepEqual(chat(dispatchGroup, { ceiling: 'comment' }), { qa: 'ready', triage: 'ready', review: 'ready', development: 'ceiling_limited', testing: 'ready', ci: 'ready' });
  assert.deepEqual(chat(dispatchGroup, { ceiling: 'read' }), { qa: 'ready', triage: 'ceiling_limited', review: 'ceiling_limited', development: 'ceiling_limited', testing: 'ready', ci: 'ready' });
  assert.equal(chat(dispatchGroup, { roles: ['manager', 'reviewer', 'test'] }).development, 'off');
  assert.deepEqual(Object.values(chat(dispatchGroup, { enabled: false })), ['off', 'off', 'off', 'off', 'off', 'off']);
  // On GitHub every answer is a comment, so a read ceiling holds questions back too.
  assert.deepEqual(chat({ kind: 'github' }, { ceiling: 'read' }), { qa: 'ceiling_limited', triage: 'ceiling_limited', review: 'ceiling_limited', development: 'ceiling_limited', testing: 'ceiling_limited', ci: 'ceiling_limited' });
  assert.equal(chat({ kind: 'github' }, { events: { 'actions.run_failed': false } }).ci, 'off');
});

test('examples come only from what the chat can use, different kinds of work first', () => {
  const read = chatExamplesFor(chatCapabilities(base, readGroup), 'acme/app');
  assert.equal(read.length, 3);
  assert.ok(read.every(example => example.includes('acme/app') && !/开发|检视|跑一下测试|标签/.test(example)), read.join(' | '));
  const all = chatExamplesFor(chatCapabilities(base, dispatchGroup), 'acme/app');
  assert.deepEqual(all.map(example => example.match(/README|测试|检视/)?.[0]), ['README', '测试', '检视']);
  assert.ok(chatExamplesFor(chatCapabilities({ ...base, ceiling: 'read' }, { kind: 'github' }), '').length === 0);
});

test('the group notice says the level, what each repository allows and three requests to try', () => {
  const text = groupCapabilityNotice('只读问答', [{ full_name: 'acme/app', inputs: { ...base, ceiling: 'comment' } }], readGroup);
  assert.match(text, /^本群已接入 bot，档位：只读问答。/);
  assert.match(text, /acme\/app（项目能力上限：可评论和打标签）\n- 可以：代码仓问答与调研、CI 失败与定时主动发现/);
  assert.match(text, /- 暂不可以：Issue\/PR 日常管理（本群档位不支持）/);
  assert.match(text, /试试：\n1\. @bot acme\/app[^\n]+\n2\. [^\n]+\n3\. [^\n]+$/);
  assert.match(groupCapabilityNotice('可派活', [], dispatchGroup), /没有可用的仓库/);
});

// Review of #1157: a custom binding's items are separate gates, and the group is not told the project watches CI when it does not.
test('a custom binding is described by its own items: PR write alone, dispatch without writes', () => {
  const prOnly = groupVenue({ github_issues: 'read', github_pull_requests: 'write', delegation: 'deny' });
  assert.deepEqual(prOnly, { kind: 'feishu_group', issues: false, pulls: true, dispatch: false });
  const list = chatCapabilities(base, prOnly), triage = list.find(c => c.id === 'triage'), ci = list.find(c => c.id === 'ci');
  assert.equal(triage.state, 'ready'); assert.match(triage.how, /只有 PR 写入，Issue 不能整理/);
  assert.ok(triage.examples.every(example => example.includes('PR #34')), triage.examples.join(' | '));
  assert.doesNotMatch(ci.how, /需要时提报 Issue/);
  // Dispatch without GitHub writes: work can be handed over, triage cannot, and the reason names the missing item, not a level.
  const dispatchOnly = chatCapabilities(base, groupVenue({ github_issues: 'read', github_pull_requests: 'read', delegation: 'allow' }));
  assert.equal(dispatchOnly.find(c => c.id === 'development').state, 'ready');
  assert.match(dispatchOnly.find(c => c.id === 'triage').how, /^本群没有 Issue\/PR 写入/);
});

test('a group is told CI failures are investigated on request, and found automatically only when the project watches them', () => {
  const quiet = { ...base, events: { ...allEvents, 'actions.run_failed': false }, schedules: 0 };
  const ci = chatCapabilities(quiet, readGroup).find(c => c.id === 'ci');
  assert.equal(ci.state, 'ready'); assert.equal(ci.title, 'CI 失败原因排查（按需）'); assert.match(ci.how, /不会自动发现/);
  assert.doesNotMatch(groupCapabilityNotice('只读问答', [{ full_name: 'acme/app', inputs: quiet }], readGroup), /定时主动发现/);
  assert.equal(chatCapabilities(base, readGroup).find(c => c.id === 'ci').title, 'CI 失败与定时主动发现');
  // The switch or a scheduled check is what makes the project watch CI, whatever the ceiling; a read ceiling only stops it
  // from rerunning or reporting what it finds (review of #1157, second round).
  for (const watching of [{ events: { ...allEvents, 'actions.run_failed': true }, schedules: 0 }, { events: { ...allEvents, 'actions.run_failed': false }, schedules: 2 }]) {
    const atRead = chatCapabilities({ ...base, ceiling: 'read', ...watching }, dispatchGroup).find(c => c.id === 'ci');
    assert.equal(atRead.title, 'CI 失败与定时主动发现');
    assert.doesNotMatch(atRead.how, /没有打开 Actions 失败事件/);
    assert.match(atRead.how, /会自动排查失败的 Actions 运行或按定时检查发现问题，但项目能力上限是「只读问答」，这项需要「可评论和打标签」，不会重跑或提报 Issue/);
  }
});

// Review of #1156: groups count by what their items allow, and a published Issue review starts development however it began.
test('custom groups count by their items: no reads, no writes or no task creation are not counted for them', () => {
  const noMentions = { 'issue.mention': false, 'pull_request.mention': false };
  // A custom binding with Contents write only: it reads, but cannot comment or label, and cannot create tasks.
  const contents = states({ events: noMentions, groups: { custom: 1 }, groupGates: { questions: 1, write: 0, dispatch: 0 } });
  assert.deepEqual([contents.qa, contents.triage, contents.testing], ['ready', 'off', 'off']);
  // Without groupGates (a caller with level counts only), a custom group stands for no item at all.
  assert.deepEqual([states({ events: noMentions, groups: { custom: 1 } }).qa, states({ events: noMentions, groups: { custom: 1 } }).triage], ['off', 'off']);
  assert.equal(states({ events: noMentions, groups: { custom: 1 }, groupGates: { questions: 1, write: 1, dispatch: 1 } }).testing, 'ready');
});

test('a published Issue review starts development under the project rule even with Issue-opened off', () => {
  const development = scenario('development', { events: { 'issue.opened': false, 'issue.development_label': false } });
  assert.equal(development.state, 'ready'); assert.match(development.detail, /检视结论为可开发/);
});

test('a group counts for questions only with reads that answer them: Checks or Commit Status alone do not', () => {
  // Items as a binding stores them: the read level's, with resources taken away or added.
  const read = levelPermissions('read'), none = { ...read, github_contents: 'none', github_issues: 'none', github_pull_requests: 'none', github_actions: 'none', github_checks: 'none', github_statuses: 'none' };
  assert.deepEqual(groupGatesOf({ ...none, github_checks: 'read', github_statuses: 'read' }), { questions: false, write: false, dispatch: false });
  assert.deepEqual(groupGatesOf({ ...none, github_contents: 'read' }), { questions: true, write: false, dispatch: false });
  assert.deepEqual(groupGatesOf({ ...read, github_contents: 'write' }), { questions: true, write: false, dispatch: false });
  assert.deepEqual(groupGatesOf(levelPermissions('dispatch')), { questions: true, write: true, dispatch: true });
});
