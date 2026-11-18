// GitHub collaborators use the bot from a Feishu private chat with the authority their repository permission gives (#847).
// GitHub, Feishu and the model are local protocol fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { githubChannelFixture, scriptedModel } from '../../../fixtures/channel-fixture.mjs';

const contract = { goal: 'Fix the flaky sign-in test', scope: ['test/'], criteria: ['The sign-in test passes ten times in a row'], endpoint: 'reviewable_pull_request' };
// The management assistant lists the project's tasks, reads the project's revision, then creates a development task.
const createSteps = [
  ['management_query', { operation: 'list_tasks', target: { project_id: '101' }, arguments: {} }],
  ['management_query', { operation: 'get_effective_config', target: { project_id: '101' }, arguments: {} }],
  done => ['management_command', { operation: 'task.create', target: { project_id: '101' }, arguments: { request: 'Fix the flaky sign-in test', intent: 'development', contract },
    expected_revision: done[1].revision }],
  done => `共 ${done[0].tasks.length} 个任务；已创建开发任务 ${done[2].result?.id}。`,
];

test('a Write collaborator lists tasks and creates a development task from a private chat; a Read collaborator may only ask (#847)', async t => {
  const f = await githubChannelFixture(t), { h } = f;
  // Development tasks need the project to allow development; that is the project's setting, not the person's authority.
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { development_enabled: true })).status, 200);
  Object.assign(f.github.state, { owner: false, permission: 'write' }); await f.person(60, 'writer', 'ou_writer');
  scriptedModel(f, createSteps);
  const before = h.store.get('SELECT count(*) n FROM tasks').n;
  const written = await f.privately('ou_writer', '看看 101 的任务，然后建一个修复登录测试的开发任务');
  assert.equal(written.state, 'completed', written.error);
  await f.sent('已创建开发任务');
  const created = h.store.get('SELECT * FROM tasks ORDER BY rowid DESC LIMIT 1');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, before + 1); assert.equal(created.repository_id, '101');
  assert.equal(h.store.get("SELECT state FROM management_commands WHERE operation='task.create' ORDER BY rowid DESC LIMIT 1").state, 'succeeded');

  // A Read collaborator sees the same tasks, and the same request is refused before anything is created.
  Object.assign(f.github.state, { permission: 'read' }); await f.person(61, 'reader', 'ou_reader');
  scriptedModel(f, createSteps);
  const read = await f.privately('ou_reader', '看看 101 的任务，然后建一个修复登录测试的开发任务');
  assert.equal(read.state, 'failed');
  // A refused command ends the assistant's turn as failed, by design; the person is told it lacks the permission.
  const message = h.store.get('SELECT * FROM management_messages WHERE id=?', read.message_id);
  assert.equal(message.state, 'failed');
  assert.equal(h.store.all("SELECT 1 FROM management_events WHERE message_id=? AND type='tool_result'", message.id).length, 2, 'listing tasks and reading the project worked');
  await f.sent('没有访问此对象或执行此操作的权限');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, before + 1);
  assert.ok(!JSON.stringify(f.wire.sent).includes('当前账户没有可访问的项目'));
});
