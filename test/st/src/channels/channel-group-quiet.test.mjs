// #1123: the bot never posts into a group on its own when the binding changes, and it has no fixed capability card: it speaks in
// a group only when someone there addresses it, and answers 「你能干什么」 like any other question, from the tools it really has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, scriptedModel, post, inGroup, finished, until } from '../../../fixtures/channel-fixture.mjs';

test('binding a group, changing its level or its repositories posts nothing into the group', async t => {
  const f = await channelFixture(t), { h, admin } = f;
  await repositoryAssistant(f);
  const chat = await boundGroup(f, ['101']);
  for (const change of [{ level: 'dispatch' }, { level: 'dispatch', scope: { kind: 'repositories', repositories: ['101', '102'] } }, { level: 'read', participation: 'questions' }]) {
    const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat.id);
    const result = await admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: binding.revision, ...change });
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

test('asking a group what the bot can do gets the assistant\'s own answer, with no fixed capability tool or template', async t => {
  const f = await channelFixture(t), { h } = f;
  await repositoryAssistant(f);
  await boundGroup(f, ['101']);
  scriptedModel(f, [['list_projects', {}], () => '本群可以问 agent-test-zone/admin-fixture-101 的代码和讨论。']);
  const asked = await post(h, f.id, inGroup('你能干什么？', 'ou_bob')); await finished(h, asked.value.operation_id);
  const request = f.requests.find(body => (body.tools ?? []).some(tool => tool.function?.name === 'list_projects'));
  assert.ok(request, 'the group assistant was asked');
  assert.ok(!request.tools.some(tool => tool.function?.name === 'describe_capabilities'), request.tools.map(tool => tool.function?.name).join(','));
  assert.doesNotMatch(request.messages[0].content, /describe_capabilities|three requests from its examples/);
  // The group gets the model's own words, not a card built from settings.
  await until(() => f.wire.sent.find(sent => JSON.stringify(sent.content).includes('本群可以问 agent-test-zone/admin-fixture-101 的代码和讨论。')));
});
