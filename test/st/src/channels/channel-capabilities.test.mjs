// #1123: a Feishu group learns what it can use by asking. 「你能干什么」 is answered from describe_capabilities, which narrows each
// project's capabilities by the group's own level. The bot never posts into a group on its own when the binding changes: it speaks
// in a group only when someone there addresses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, scriptedModel, post, inGroup, finished, until } from '../../../fixtures/channel-fixture.mjs';

test('binding a group, changing its level or its repositories posts nothing into the group', async t => {
  const f = await channelFixture(t), { h, admin } = f;
  await repositoryAssistant(f);
  const chat = await boundGroup(f, ['101']);
  for (const change of [{ level: 'dispatch' }, { level: 'dispatch', scope: { kind: 'repositories', repositories: ['101', '102'] } }, { level: 'read', participation: 'questions' }]) {
    const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat.id);
    const result = await admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: binding.revision, ...change });
    assert.equal(result.status, 200, JSON.stringify(result.value));
  }
  await f.service.drain();
  assert.equal(f.wire.sent.length, 0, JSON.stringify(f.wire.sent.map(s => s.content)));
  assert.equal(h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'binding-notice:%'").n, 0);
});

// A card queued under the old behaviour (before this change) is refused at delivery and never reaches the group (#1165 review).
test('a capability card still queued from before is dropped at delivery, not sent', async t => {
  const f = await channelFixture(t), { h } = f;
  await repositoryAssistant(f);
  const chat = await boundGroup(f, ['101']), binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat.id);
  const id = f.service.post(chat, '本群已接入 bot，档位：只读问答。', `binding-notice:${binding.id}:${binding.revision}`, `binding-notice:${binding.id}`,
    { kind: 'service_binding_notice', chat_id: chat.id, binding_id: binding.id, binding_revision: binding.revision });
  const row = await until(() => h.store.get('SELECT * FROM channel_outbox WHERE id=?', id), r => r?.state === 'failed');
  assert.equal(row.last_error, 'conversation_source_changed');
  assert.equal(f.wire.sent.length, 0);
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
