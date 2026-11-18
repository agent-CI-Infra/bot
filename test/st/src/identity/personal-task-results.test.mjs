import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, envelope, post, finished, until, bindFixture, scriptedModel } from '../../../fixtures/channel-fixture.mjs';
import { settled } from '../../../fixtures/management-fixture.mjs';
import { revokeIdentity } from '../../../../dist/identity/bindings.js';

// #844: a task the management assistant creates during a private-chat turn reports its result back to that chat.
const contract = { goal: '修复卡片链接', scope: ['project'], criteria: ['链接可以点击'], endpoint: 'report' };
const createTask = request => [['management_query', { operation: 'get_effective_config', target: { project_id: '101' }, arguments: {} }],
  done => ['management_command', { operation: 'task.create', target: { project_id: '101' }, arguments: { request, contract }, expected_revision: done[0].revision }], '已创建任务。'];
async function privateTask(f, request, sender) {
  scriptedModel(f, createTask(request));
  const event = envelope(request, sender), receipt = await post(f.h, f.id, event), row = await finished(f.h, receipt.value.operation_id);
  assert.equal(row.state, 'completed', row.error);
  const command = f.h.store.get("SELECT * FROM management_commands WHERE operation='task.create' AND source_message=?", 'feishu:' + receipt.value.operation_id);
  assert.equal(command.state, 'succeeded', command.result);
  return { id: JSON.parse(command.result).id, source: receipt.value.operation_id };
}
const finish = (f, task, status, result, error = null) => f.h.store.run('UPDATE tasks SET status=?,result=?,error_code=? WHERE id=?', status, JSON.stringify(result), error, task);
const deliveries = (f, task) => f.h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='channel_result_delivery' ORDER BY id", task).map(r => JSON.parse(r.data));
const sentWith = (f, text) => f.wire.sent.filter(s => JSON.stringify(s.content).includes(text));

test('a task created in a private chat reports its PR, failure and cancellation to that chat; a console task sends nothing', async t => {
  const f = await channelFixture(t), member = await f.member('private-results', { repository_ids: ['101'] });
  bindFixture(f.h, f.id, member.id, 'ou_member');
  const sender = { sender: { sender_id: { open_id: 'ou_member' } }, message: { chat_id: 'oc_member' } };
  const task = await privateTask(f, '修复卡片链接', sender), chat = f.h.store.get("SELECT id FROM channel_chats WHERE chat_id='oc_member'");
  assert.deepEqual({ ...f.h.store.get('SELECT chat_id,principal_id,source_message FROM channel_personal_tasks WHERE task_id=?', task.id) },
    { chat_id: chat.id, principal_id: member.id, source_message: task.source });
  // The chat is where results go, not a source of authority: the task keeps the origin of a console request.
  const origin = f.h.store.get('SELECT source_kind,conversation_id,principal_id FROM task_origins WHERE task_id=?', task.id);
  assert.deepEqual({ ...origin }, { source_kind: 'operator', conversation_id: null, principal_id: member.id });

  finish(f, task.id, 'pr_opened', { summary: 'PRIVATE_PR_OPENED', pr_url: 'https://github.example.test/agent-test-zone/admin-fixture-101/pull/7' });
  const opened = await until(() => sentWith(f, 'PRIVATE_PR_OPENED')[0]);
  assert.equal(opened.receive_id, 'oc_member'); assert.match(opened.url, /receive_id_type=chat_id/);
  const text = JSON.stringify(opened.content);
  assert.match(text, /admin-fixture-101 的任务「修复卡片链接」已提交 PR/); assert.match(text, /PR：\[https:\/\/github\.example\.test\/agent-test-zone\/admin-fixture-101\/pull\/7\]/);
  const delivered = await until(() => deliveries(f, task.id).find(d => d.state === 'delivered'));
  assert.equal(delivered.channel, chat.id); assert.equal(delivered.message, '结果已发送到飞书私聊');
  // The result is a personal reply: it joins no group's message context.
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_message_scopes WHERE chat_id=?', chat.id).n, 0);

  finish(f, task.id, 'failed', { summary: 'PRIVATE_FAILED' }, 'validation_failed');
  assert.match(JSON.stringify((await until(() => sentWith(f, 'PRIVATE_FAILED')[0])).content), /失败.*原因：validation_failed/s);
  finish(f, task.id, 'cancelled', { summary: 'PRIVATE_CANCELLED' });
  assert.match(JSON.stringify((await until(() => sentWith(f, 'PRIVATE_CANCELLED')[0])).content), /已取消/);
  await until(() => deliveries(f, task.id).filter(d => d.state === 'delivered').length === 3);
  assert.equal(sentWith(f, 'PRIVATE_PR_OPENED').length, 1);

  // The same request from a console conversation has no chat to report to.
  scriptedModel(f, createTask('控制台里建的任务'));
  const conversation = (await member.client('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const message = (await member.client('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'console-request', content: '控制台里建的任务' })).value;
  assert.equal((await settled(member.client, conversation, message.id)).messages.find(m => m.id === message.id).state, 'completed');
  const consoleTask = JSON.parse(f.h.store.get("SELECT result FROM management_commands WHERE operation='task.create' AND source_message='console-request'").result).id;
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_personal_tasks WHERE task_id=?', consoleTask).n, 0);
  finish(f, consoleTask, 'completed', { summary: 'CONSOLE_ONLY_RESULT' });
  await f.service.tick(); await f.service.tick();
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_task_results WHERE task_id=?', consoleTask).n, 0);
  assert.equal(sentWith(f, 'CONSOLE_ONLY_RESULT').length, 0);
});

test('a private-chat result is withheld once its creator unbinds Feishu or loses read access, and the timeline says why', async t => {
  const f = await channelFixture(t);
  const people = [];
  for (const name of ['unbound', 'reader']) {
    const member = await f.member('private-' + name, { repository_ids: ['101'] }); bindFixture(f.h, f.id, member.id, 'ou_' + name);
    people.push({ member, task: await privateTask(f, name + ' 的任务', { sender: { sender_id: { open_id: 'ou_' + name } }, message: { chat_id: 'oc_' + name } }) });
  }
  const [unbound, reader] = people;
  revokeIdentity(f.h.store, unbound.member.id, f.h.store.get("SELECT id FROM external_identities WHERE principal_id=? AND provider='feishu'", unbound.member.id).id);
  await f.admin('/api/project-admin-assignments', 'PUT', { user_id: reader.member.id, repository_ids: [] });
  for (const { task } of people) finish(f, task.id, 'pr_opened', { summary: 'WITHHELD_' + task.id });
  const reason = async (task, code, message) => {
    const entry = await until(() => deliveries(f, task.id).find(d => d.state === 'suppressed'));
    assert.equal(entry.error_code, code); assert.equal(entry.message, message);
  };
  await reason(unbound.task, 'external_binding_required', '结果未投递：创建者的飞书绑定已解除或失效');
  await reason(reader.task, 'capability_forbidden', '结果未投递：创建者已没有该仓库的读取权限');
  for (const { task } of people) assert.equal(sentWith(f, 'WITHHELD_' + task.id).length, 0);
});

test('a private-chat result queued before the creator lost access is not sent', async t => {
  const f = await channelFixture(t), member = await f.member('private-late', { repository_ids: ['101'] });
  bindFixture(f.h, f.id, member.id, 'ou_late');
  const task = await privateTask(f, '稍后失去权限', { sender: { sender_id: { open_id: 'ou_late' } }, message: { chat_id: 'oc_late' } });
  // Queue the result while Feishu delivery fails, then take the person's access away before the retry.
  f.wire.state.sendHandler = (_url, _init, request) => request.content.includes('LATE_RESULT') ? Response.json({ code: 999, msg: 'retry later' }, { status: 503 }) : undefined;
  finish(f, task.id, 'completed', { summary: 'LATE_RESULT' });
  const outbox = await until(() => f.h.store.get("SELECT * FROM channel_outbox WHERE idempotency_key LIKE 'personal-task-result:%' AND state='retry'"));
  await f.admin('/api/project-admin-assignments', 'PUT', { user_id: member.id, repository_ids: [] });
  f.wire.state.sendHandler = null; f.h.store.run('UPDATE channel_outbox SET next_attempt=0 WHERE id=?', outbox.id);
  assert.equal((await until(() => f.h.store.get('SELECT * FROM channel_outbox WHERE id=?', outbox.id), r => r.state === 'failed')).last_error, 'capability_forbidden');
  assert.equal(sentWith(f, 'LATE_RESULT').length, 0);
  const entry = await until(() => deliveries(f, task.id).find(d => d.state === 'suppressed'));
  assert.equal(entry.phase, 'delivery'); assert.equal(entry.message, '结果未投递：创建者已没有该仓库的读取权限');
});
