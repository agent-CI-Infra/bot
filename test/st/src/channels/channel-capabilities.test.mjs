// #1123: a Feishu group learns what it can use. Binding the group (or changing its level or repositories) sends it a notice
// built from the same projection as the overview card, and 「你能干什么」 is answered from describe_capabilities, which
// narrows each project's capabilities by the group's own level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, scriptedModel, post, inGroup, finished, until } from '../../../fixtures/channel-fixture.mjs';

const notices = f => f.wire.sent.map(s => JSON.stringify(s.content)).filter(text => text.includes('本群已接入 bot'));

test('binding a group, raising its level or changing its repositories tells it what it can use; other saves stay quiet', async t => {
  const f = await channelFixture(t, { capabilityNotices: true }), { h, admin } = f;
  await repositoryAssistant(f);
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' });
  const chat = await boundGroup(f, ['101']);
  await until(() => notices(f).length === 1 || null);
  assert.match(notices(f)[0], /档位：只读问答/);
  assert.match(notices(f)[0], /admin-fixture-101（项目能力上限：可开发并开 PR）/);
  // The project does not watch Actions failures, so the group is offered on-demand investigation, not automatic discovery.
  assert.match(notices(f)[0], /可以：代码仓问答与调研、CI 失败原因排查（按需）/);
  assert.match(notices(f)[0], /特性开发与缺陷修复（本群档位不支持）/);
  assert.match(notices(f)[0], /试试：/);
  // The card's delivery is recorded like any group message (#1157 review F1): sent, with its remote id, in the binding's scope
  // and the fence of the revision it describes.
  const first = await until(() => h.store.get("SELECT * FROM channel_outbox WHERE idempotency_key LIKE 'binding-notice:%'"), row => row?.state === 'sent');
  assert.ok(first.remote_message_id);
  const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat.id);
  const scope = h.store.get('SELECT * FROM channel_message_scopes WHERE chat_id=? AND message_id=?', chat.id, first.remote_message_id);
  assert.equal(scope.project_id, 'binding:' + binding.id); assert.equal(scope.fence, f.service.serviceBindings.fence(chat.id));
  assert.equal(h.store.get('SELECT last_error FROM channel_connectors WHERE id=?', f.id).last_error, null);

  const save = async change => {
    const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat.id);
    const result = await admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: binding.revision, ...change });
    assert.equal(result.status, 200, JSON.stringify(result.value));
  };
  // A new level: a new notice with what dispatching adds.
  await save({ level: 'dispatch' });
  await until(() => notices(f).length === 2 || null);
  // A new revision has a new fence: the first card no longer belongs to what the group reads as context.
  assert.notEqual(f.service.serviceBindings.fence(chat.id), scope.fence);
  assert.match(notices(f)[1], /档位：可派活/);
  assert.match(notices(f)[1], /可以：[^\\]*特性开发与缺陷修复/);
  // The same level and repositories, another participation mode: no notice.
  await save({ level: 'dispatch', participation: 'questions' });
  await save({ level: 'dispatch', scope: { kind: 'repositories', repositories: ['101', '102'] } });
  await until(() => notices(f).length === 3 || null);
  assert.match(notices(f)[2], /admin-fixture-102/);
  await until(() => h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'binding-notice:%' AND state='sent'").n === 3 || null);
  assert.equal(h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'binding-notice:%'").n, 3);
});

test('describe_capabilities answers for this group: its level narrows the project, and examples are only what it can use', async t => {
  const f = await channelFixture(t), { h } = f;
  await repositoryAssistant(f);
  await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' });
  await boundGroup(f, ['101']);
  let seen = null;
  scriptedModel(f, [['describe_capabilities', {}], done => { seen = done[0]; return '本群可以问答和查 CI。'; }]);
  const asked = await post(h, f.id, inGroup('你能干什么？', 'ou_bob')); await finished(h, asked.value.operation_id);
  assert.ok(seen, 'the tool ran');
  assert.equal(seen.group_level, 'read'); assert.equal(seen.group_level_title, '只读问答');
  const repo = seen.repositories.find(r => r.repository === 'agent-test-zone/admin-fixture-101');
  assert.equal(repo.ceiling, 'develop');
  assert.deepEqual(Object.fromEntries(repo.capabilities.map(c => [c.id, c.state])),
    { qa: 'ready', triage: 'level_limited', review: 'level_limited', development: 'level_limited', testing: 'level_limited', ci: 'ready' });
  assert.equal(repo.examples.length, 3);
  assert.ok(repo.examples.every(example => !/开发|检视|跑一下测试/.test(example)), repo.examples.join(' | '));
  // The group assistant is told to read it before saying what it can do.
  const system = f.requests.find(body => JSON.stringify(body.tools ?? []).includes('describe_capabilities'))?.messages[0].content ?? '';
  assert.match(system, /what you can do, how you work or how to work with you, call describe_capabilities first/);
});
