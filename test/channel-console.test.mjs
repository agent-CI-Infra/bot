import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, privateChat, bindFixture, repositoryAssistant, scriptedModel, inGroup, envelope, post, finished, until } from './channel-fixture.mjs';
import { testPassword } from './helpers.mjs';
import { ledgerStorage } from '../dist/channels/ledger.js';

test('group names migrate, fill existing views and refresh without changing chat or assistant revisions', async t => {
  const f = await channelFixture(t), chat = await boundGroup(f), path = `/api/channels/chats/${chat.id}/name`;
  f.h.store.run("UPDATE channel_connectors SET tenant_name='Fixture enterprise' WHERE id=?", f.id);
  const before = { ...f.h.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id) };
  f.h.store.db.exec('ALTER TABLE channel_chats DROP COLUMN display_name'); ledgerStorage(f.h.store); ledgerStorage(f.h.store);
  assert.equal(f.h.store.get('SELECT display_name FROM channel_chats WHERE id=?', chat.id).display_name, '');
  const list = await f.admin('/api/channels/conversations');
  assert.equal(list.value.conversations[0].display_name, ''); assert.equal(f.wire.state.chatRequests.length, 0, 'listing reads only local metadata');
  f.wire.state.chatName = '  研发讨论群  ';
  const named = await f.admin(path, 'POST', {}); assert.equal(named.status, 201, JSON.stringify(named.value));
  assert.equal(named.value.display_name, '研发讨论群'); assert.equal(named.value.tenant_name, 'Fixture enterprise');
  assert.deepEqual({ ...f.h.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id) }, { ...before, display_name: '研发讨论群' });
  assert.equal(f.service.serviceBindings.get(chat.id).revision, 1);
  assert.equal((await f.admin('/api/channels/conversations')).value.conversations[0].display_name, '研发讨论群');
  const bindings = (await f.admin('/api/channels/service-bindings')).value;
  assert.equal(bindings.bindings[0].chat.display_name, '研发讨论群'); assert.equal(bindings.chats[0].display_name, '研发讨论群');
  assert.equal((await f.admin(`/api/channels/chats/${chat.id}/timeline`)).value.chat.display_name, '研发讨论群');
  assert.doesNotMatch(JSON.stringify(named.value), /description|fixture-only-access-token/);
  for (const [code, name] of [[99991672, 'ignored'], [0, ''], [999, 'ignored']]) {
    f.wire.state.chatCode = code; f.wire.state.chatName = name;
    assert.ok((await f.admin(path, 'POST', {})).status >= 400);
    assert.equal(f.h.store.get('SELECT display_name FROM channel_chats WHERE id=?', chat.id).display_name, '研发讨论群');
  }
});

test('group name refresh checks group visibility before provider access and again after asynchronous lookup', async t => {
  const f = await channelFixture(t), chat = await boundGroup(f), reader = await f.member('name-reader', {});
  const route = `/api/channels/chats/${chat.id}/name`;
  assert.equal((await reader.client(route, 'POST', {})).status, 403); assert.equal(f.wire.state.chatRequests.length, 0);
  bindFixture(f.h, f.id, reader.id, 'ou_name_reader');
  const quiet = inGroup('pick this group', 'ou_name_reader'); quiet.event.message.mentions = []; await post(f.h, f.id, quiet);
  let release; f.wire.state.chatGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const pending = reader.client(route, 'POST', {}); await until(() => f.wire.state.chatRequests.length === 1);
  f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=?", reader.id); release();
  assert.equal((await pending).status, 403);
  assert.equal(f.h.store.get('SELECT display_name FROM channel_chats WHERE id=?', chat.id).display_name, '');
  f.wire.state.chatGate = new Promise(resolve => { release = resolve; });
  const changed = f.admin(route, 'POST', {}); await until(() => f.wire.state.chatRequests.length === 2);
  f.h.store.run('UPDATE channel_connectors SET revision=revision+1 WHERE id=?', f.id); release();
  assert.equal((await changed).status, 409);
  assert.equal(f.h.store.get('SELECT display_name FROM channel_chats WHERE id=?', chat.id).display_name, '');
});

test('private conversation names require the exact active owner binding and keep the robot enterprise distinct', async t => {
  const f = await channelFixture(t), chat = await privateChat(f);
  f.h.store.run("UPDATE channel_connectors SET tenant_name='Fixture enterprise' WHERE id=?", f.id);
  f.h.store.run("UPDATE external_identities SET display_name='张小明' WHERE principal_id=?", f.principal);
  const read = async () => (await f.admin('/api/channels/employees')).value.personal_chats[0];
  assert.equal((await read()).display_name, '张小明'); assert.equal((await read()).tenant_name, 'Fixture enterprise');
  assert.equal((await read()).can_refresh_name, false, 'an external member cannot be queried with this installation token');
  f.h.store.run('UPDATE channel_personal_owners SET actor_tenant=? WHERE chat_id=?', 'install-tenant', chat.id);
  assert.equal((await read()).display_name, '', 'a name from a different tenant cannot label this chat');
  bindFixture(f.h, f.id, f.principal, 'ou_alice', 'install-tenant');
  const identity = f.h.store.get("SELECT id FROM external_identities WHERE external_tenant='install-tenant'");
  assert.equal((await read()).can_refresh_name, true);
  assert.equal((await f.admin('/api/channels/bindings/' + identity.id + '/name', 'POST', {})).status, 201);
  assert.equal((await read()).display_name, '张小明');
  assert.equal((await f.admin('/api/channels/conversations')).value.conversations[0].display_name, '张小明');
  f.h.store.run('UPDATE external_identities SET expires_at=0 WHERE id=?', identity.id);
  assert.equal((await read()).display_name, ''); assert.equal((await read()).can_refresh_name, false);
  assert.equal((await f.admin('/api/channels/bindings/' + identity.id + '/name', 'POST', {})).status, 404);
});

test('conversation console filters history authority before pagination and excludes other people’s private chats', async t => {
  const f = await channelFixture(t), group = await boundGroup(f, ['101', '102']), mine = await privateChat(f);
  const password = testPassword(), created = await f.admin('/api/users', 'POST', { username: 'console-member', password, repository_ids: ['101'] });
  assert.equal(created.status, 201);
  const member = f.h.client(); assert.equal((await member('/api/auth/login', 'POST', { username: 'console-member', password })).status, 200);
  const principal = (await member('/api/auth/me')).value.id;
  bindFixture(f.h, f.id, principal, 'ou_member');
  const theirs = await privateChat(f, 'ou_member', principal, 'oc_member');
  const adminList = await f.admin('/api/channels/conversations');
  assert.equal(adminList.status, 200); assert.deepEqual(new Set(adminList.value.conversations.map(c => c.id)), new Set([mine.id, group.id]));
  const list = await member('/api/channels/conversations'); assert.equal(list.status, 200);
  assert.deepEqual(list.value.conversations.map(c => c.id), [theirs.id]);
  for (const section of ['timeline', 'tasks']) assert.equal((await member(`/api/channels/chats/${group.id}/${section}`)).status, 403);
  assert.equal((await f.admin(`/api/channels/chats/${theirs.id}/timeline`)).status, 403);
  assert.equal((await member('/api/channels/conversations?offset=NaN')).status, 400);
  f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=? AND provider='feishu'", principal);
  const revoked = await member('/api/channels/conversations'); assert.equal(revoked.status, 200, JSON.stringify(revoked.value)); assert.deepEqual(revoked.value.conversations, []);
  f.h.store.run("UPDATE external_identities SET status='active' WHERE principal_id=? AND provider='feishu'", principal);
  f.h.store.run('UPDATE channel_connectors SET enabled=0 WHERE id=?', f.id);
  const inactive = await member('/api/channels/conversations'); assert.equal(inactive.status, 200); assert.deepEqual(inactive.value.conversations, []);
});

test('timeline pages newest messages without duplication and keeps tombstones, sensitive text and stale derived output hidden', async t => {
  const f = await channelFixture(t), chat = await boundGroup(f), now = Date.now() - 20000;
  f.h.store.run("UPDATE external_identities SET display_name='张小明' WHERE principal_id=? AND provider='feishu'", f.principal);
  for (let i = 0; i < 110; i++) f.service.ledger.merge(chat, { message_id: 'page-' + String(i).padStart(3, '0'), sender_id: 'ou_member', sender_tenant: 'actor-tenant', sender_type: 'user', message_type: 'text',
    created_at: now, updated_at: now, content: 'discussion ' + i, raw_content: '{}', parent_id: '', root_id: '', thread_id: '', deleted: i === 100 }, 'history');
  f.service.ledger.merge(chat, { message_id: 'sensitive', sender_id: 'ou_member', sender_tenant: 'actor-tenant', sender_type: 'user', message_type: 'text',
    created_at: now + 1, updated_at: now + 1, content: 'password=never-expose-this', raw_content: 'password=never-expose-this', parent_id: '', root_id: '', thread_id: '', deleted: false }, 'history');
  let cursor = '', ids = [], pages = [];
  do {
    const result = await f.admin(`/api/channels/chats/${chat.id}/timeline${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`);
    assert.equal(result.status, 200, JSON.stringify(result.value)); pages.push(result.value);
    ids.push(...result.value.messages.map(m => m.message_id)); cursor = result.value.next_cursor;
  } while (cursor);
  assert.equal(new Set(ids).size, ids.length); assert.equal(ids.filter(id => id.startsWith('page-')).length, 110);
  assert.ok(pages[0].messages.find(m => m.message_id === 'sensitive'));
  assert.ok(!JSON.stringify(pages).includes('never-expose-this'));
  assert.equal(pages.flatMap(p => p.messages).find(m => m.sender_id === 'ou_alice').sender_name, '张小明');
  assert.equal(pages.flatMap(p => p.messages).find(m => m.message_id === 'page-100').content, '[消息已撤回]');
  const other = await boundGroup(f, ['101'], 'oc_other');
  assert.equal((await f.admin(`/api/channels/chats/${other.id}/timeline?cursor=${encodeURIComponent(pages[0].next_cursor)}`)).status, 400);
});

test('assistant steps are real metadata, paginated, fenced and erased with local history', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  scriptedModel(f, [['send_message', { text: '正在核对当前项目。' }], ['list_projects', {}], '当前项目已核对。']);
  const receipt = await post(f.h, f.id, inGroup('查看项目范围', 'ou_bob'));
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  await until(() => f.h.store.get("SELECT state FROM channel_outbox WHERE idempotency_key LIKE '%:stage:1'"), row => row?.state === 'sent');
  const timeline = await f.admin(`/api/channels/chats/${chat.id}/timeline`), turn = timeline.value.conversation.turns[0];
  assert.equal(turn.messages[0].text, '正在核对当前项目。'); assert.equal(turn.messages[0].delivery.state, 'sent');
  const steps = await f.admin(`/api/channels/chats/${chat.id}/turns/${turn.id}`);
  assert.equal(steps.status, 200); assert.ok(steps.value.events.some(e => e.type === 'tool_call' && e.name === 'list_projects'));
  assert.ok(steps.value.events.some(e => e.type === 'tool_result')); assert.equal(steps.value.events.at(-1).type, 'done');
  assert.ok(steps.value.events.every(e => !e.arguments && !e.result && !e.reasoning));
  for (let i = 0; i < 105; i++) f.h.store.run("INSERT INTO channel_service_events(turn_id,type,name,created_at) VALUES(?,'tool_result','list_projects',?)", turn.id, Date.now());
  const page1 = (await f.admin(`/api/channels/chats/${chat.id}/turns/${turn.id}`)).value;
  const page2 = (await f.admin(`/api/channels/chats/${chat.id}/turns/${turn.id}?after=${page1.next_after}`)).value;
  assert.equal(page1.events.length, 100); assert.ok(page1.has_more); assert.ok(page2.events.length > 0);
  assert.ok(page2.events[0].sequence > page1.events.at(-1).sequence);
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
  const stale = (await f.admin(`/api/channels/chats/${chat.id}/turns/${turn.id}`)).value;
  assert.deepEqual(stale.events, []); assert.equal(stale.stale_source, true);
  f.service.ledger.cleanup(chat.id, Date.now(), f.h.store.get('SELECT revision FROM channel_chats WHERE id=?', chat.id).revision);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_events WHERE turn_id=?', turn.id).n, 0);
});

test('conversation own tasks are visible only under the current service binding fence', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  const binding = f.service.serviceBindings.get(chat.id), id = 'a'.repeat(48);
  f.h.store.run(`INSERT INTO service_role_own_tasks(id,service_role_id,owner_kind,owner_id,principal_id,fence,title,state,history,created_at,updated_at)
    VALUES(?,'repository-assistant','channel',?,?,?,'核对文档','completed',?,?,?)`, id, binding.id, binding.principal_id, f.service.serviceBindings.fence(chat.id),
    f.h.store.secrets.seal({ rounds: [{ instruction: '核对', conclusion: '证据已找到。', at: Date.now() }] }, 'own-task:' + id), Date.now(), Date.now());
  let result = await f.admin(`/api/channels/chats/${chat.id}/tasks`); assert.equal(result.status, 200);
  assert.equal(result.value.own_tasks[0].last_conclusion, '证据已找到。');
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
  result = await f.admin(`/api/channels/chats/${chat.id}/tasks`); assert.deepEqual(result.value.own_tasks, []);
});

test('a project task delegated by the group is linked to its conversation and disappears when its source changes', async t => {
  const f = await channelFixture(t);
  await repositoryAssistant(f, { conversation_history: 'read', github: 'read', project_tasks: 'read', delegation: 'allow' });
  const chat = await boundGroup(f);
  scriptedModel(f, [['create_project_task', { repository: 'agent-test-zone/admin-fixture-101', request: '核对群助手的页面入口并给出报告',
    contract: { goal: '核对群助手的入口', scope: ['static/channels.js'], criteria: ['报告包含实际路径'], endpoint: '提交核对报告' } }], '任务已交给项目团队。']);
  const receipt = await post(f.h, f.id, inGroup('请创建项目任务核对页面入口', 'ou_bob'));
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  const related = await f.admin(`/api/channels/chats/${chat.id}/tasks`);
  assert.equal(related.status, 200, JSON.stringify(related.value)); assert.equal(related.value.tasks.length, 1);
  const task = related.value.tasks[0]; assert.equal(task.project_id, '101'); assert.match(task.summary, /核对群助手/);
  assert.equal((await f.admin('/api/tasks/' + task.id)).status, 200);
  assert.equal(related.value.next_offset, null);
  const member = await f.member('conversation-owner', { repository_ids: ['101', '201'] });
  const principal = (await member.client('/api/auth/me')).value.id;
  const transfer = await f.admin(`/api/channels/chats/${chat.id}/service-binding/owner`, 'PUT', { owner_id: principal, expected_revision: 1 });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.value));
  assert.equal((await member.client(`/api/channels/chats/${chat.id}/tasks`)).value.tasks.length, 1);
  const tenant = f.h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='201'").tenant_id;
  assert.equal((await member.client('/api/identity/tenant', 'POST', { tenant_id: tenant })).status, 201);
  const narrowed = await member.client(`/api/channels/chats/${chat.id}/tasks`);
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.value)); assert.deepEqual(narrowed.value.tasks, []);
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
  assert.deepEqual((await f.admin(`/api/channels/chats/${chat.id}/tasks`)).value.tasks, []);
});

test('private turns show actual delivery facts and cannot restore own tasks after the local source changes', async t => {
  const f = await channelFixture(t); scriptedModel(f, [['send_message', { text: '正在读取本人私聊的项目。' }], '私聊中核对当前项目。']);
  const receipt = await post(f.h, f.id, envelope('请核对当前项目'));
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  await until(() => f.h.store.get("SELECT state FROM channel_outbox WHERE idempotency_key=?", receipt.value.operation_id + ':result'), row => row?.state === 'sent');
  const chat = f.h.store.get("SELECT * FROM channel_chats WHERE chat_type='p2p'");
  const timeline = (await f.admin(`/api/channels/chats/${chat.id}/timeline`)).value, conversation = timeline.conversation;
  assert.equal(conversation.turns[0].messages[0].text, '正在读取本人私聊的项目。');
  assert.equal(conversation.turns[0].messages[0].delivery.state, 'sent');
  assert.equal(conversation.turns[0].state, 'completed'); assert.equal(conversation.mode, 'management'); assert.equal(conversation.turns[0].delivery.state, 'sent');
  const id = 'b'.repeat(48);
  f.h.store.run(`INSERT INTO service_role_own_tasks(id,service_role_id,owner_kind,owner_id,principal_id,fence,title,state,history,created_at,updated_at)
    VALUES(?,'management-assistant','management',?,?,?,'私聊独立任务','completed',?,?,?)`, id, conversation.management_conversation_id, f.principal,
    String((await f.admin('/api/identity')).value.actor.authorization_revision), f.h.store.secrets.seal({ rounds: [] }, 'own-task:' + id), Date.now(), Date.now());
  assert.equal((await f.admin(`/api/channels/chats/${chat.id}/tasks`)).value.own_tasks.length, 1);
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
  const stale = (await f.admin(`/api/channels/chats/${chat.id}/timeline`)).value;
  assert.equal(stale.conversation.management_conversation_id, null); assert.deepEqual(stale.conversation.turns, []);
  assert.deepEqual((await f.admin(`/api/channels/chats/${chat.id}/tasks`)).value.own_tasks, []);
});
