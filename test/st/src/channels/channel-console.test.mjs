import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, privateChat, bindFixture, repositoryAssistant, scriptedModel, inGroup, envelope, post, finished, until, credentials } from '../../../fixtures/channel-fixture.mjs';
import { testPassword } from '../../../fixtures/helpers.mjs';
import { loadConsole } from '../../../fixtures/console-page.mjs';
import { ledgerStorage } from '../../../../dist/channels/ledger.js';

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

test('conversation console authorizes whole chats before pagination and platform managers see every private chat', async t => {
  const f = await channelFixture(t), group = await boundGroup(f, ['101', '102']), mine = await privateChat(f);
  const password = testPassword(), created = await f.admin('/api/users', 'POST', { username: 'console-member', password, repository_ids: ['101'] });
  assert.equal(created.status, 201);
  const member = f.h.client(); assert.equal((await member('/api/auth/login', 'POST', { username: 'console-member', password })).status, 200);
  const principal = (await member('/api/auth/me')).value.id;
  bindFixture(f.h, f.id, principal, 'ou_member');
  const theirs = await privateChat(f, 'ou_member', principal, 'oc_member');
  const adminList = await f.admin('/api/channels/conversations');
  assert.equal(adminList.status, 200); assert.deepEqual(new Set(adminList.value.conversations.map(c => c.id)), new Set([mine.id, group.id, theirs.id]));
  const list = await member('/api/channels/conversations'); assert.equal(list.status, 200);
  assert.deepEqual(list.value.conversations.map(c => c.id), [theirs.id]);
  for (const section of ['timeline', 'tasks']) assert.equal((await member(`/api/channels/chats/${group.id}/${section}`)).status, 403);
  for (const section of ['timeline', 'tasks', 'conversation', 'messages']) assert.equal((await f.admin(`/api/channels/chats/${theirs.id}/${section}`)).status, 200);
  assert.equal((await member(`/api/channels/chats/${mine.id}/timeline`)).status, 403);
  assert.equal((await member('/api/channels/conversations?offset=NaN')).status, 400);
  f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=? AND provider='feishu'", principal);
  const revoked = await member('/api/channels/conversations'); assert.equal(revoked.status, 200, JSON.stringify(revoked.value)); assert.deepEqual(revoked.value.conversations, []);
  f.h.store.run("UPDATE external_identities SET status='active' WHERE principal_id=? AND provider='feishu'", principal);
  f.h.store.run('UPDATE channel_connectors SET enabled=0 WHERE id=?', f.id);
  const inactive = await member('/api/channels/conversations'); assert.equal(inactive.status, 200); assert.deepEqual(inactive.value.conversations, []);
});

test('timeline pages newest messages without duplication and keeps tombstones and sensitive text redacted', async t => {
  const f = await channelFixture(t), chat = await boundGroup(f), now = Date.now() - 20000;
  f.h.store.run("UPDATE external_identities SET display_name='张小明' WHERE principal_id=? AND provider='feishu'", f.principal);
  for (let i = 0; i < 110; i++) f.service.ledger.merge(chat, { message_id: 'page-' + String(i).padStart(3, '0'), sender_id: 'ou_member', sender_tenant: 'actor-tenant', sender_type: 'user', message_type: 'text',
    created_at: now, updated_at: now, content: 'discussion ' + i, raw_content: '{}', parent_id: '', root_id: '', thread_id: '', deleted: i === 100 }, 'history');
  f.service.ledger.merge(chat, { message_id: 'sensitive', sender_id: 'ou_member', sender_tenant: 'actor-tenant', sender_type: 'user', message_type: 'text',
    created_at: now + 1, updated_at: now + 1, content: '/confirm never-expose-this', raw_content: '/confirm never-expose-this', parent_id: '', root_id: '', thread_id: '', deleted: false }, 'history');
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

test('assistant steps stay linked to their chat, paginated and erased with local history', async t => {
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
  assert.ok(stale.events.length > 0); assert.equal(stale.stale_source, undefined);
  const otherChat = await boundGroup(f, ['101'], 'oc_other_steps');
  assert.equal((await f.admin(`/api/channels/chats/${otherChat.id}/turns/${turn.id}`)).status, 404);
  f.service.ledger.cleanup(chat.id, Date.now(), f.h.store.get('SELECT revision FROM channel_chats WHERE id=?', chat.id).revision);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_events WHERE turn_id=?', turn.id).n, 0);
});

test('conversation own task history remains visible across service binding source changes', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  const binding = f.service.serviceBindings.get(chat.id), id = 'a'.repeat(48);
  f.h.store.run(`INSERT INTO service_role_own_tasks(id,service_role_id,owner_kind,owner_id,principal_id,fence,title,state,history,created_at,updated_at)
    VALUES(?,'repository-assistant','channel',?,?,?,'核对文档','completed',?,?,?)`, id, binding.id, binding.principal_id, f.service.serviceBindings.fence(chat.id),
    f.h.store.secrets.seal({ rounds: [{ instruction: '核对', conclusion: '证据已找到。', at: Date.now() }] }, 'own-task:' + id), Date.now(), Date.now());
  let result = await f.admin(`/api/channels/chats/${chat.id}/tasks`); assert.equal(result.status, 200);
  assert.equal(result.value.own_tasks[0].last_conclusion, '证据已找到。');
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
  result = await f.admin(`/api/channels/chats/${chat.id}/tasks`); assert.equal(result.value.own_tasks[0].last_conclusion, '证据已找到。');
});

test('a project task delegated by the group is linked to its conversation and disappears when its source changes', async t => {
  const f = await channelFixture(t);
  await repositoryAssistant(f, { project_tasks: 'create' });
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
  assert.equal((await f.admin(`/api/channels/chats/${chat.id}/tasks`)).value.tasks.length, 1);
});

test('private turns keep delivery facts and own task history after the local source changes', async t => {
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
  assert.equal(stale.conversation.management_conversation_id, conversation.management_conversation_id);
  assert.equal(stale.conversation.turns[0].reply, '私聊中核对当前项目。');
  assert.equal(stale.conversation.turns[0].messages[0].text, '正在读取本人私聊的项目。');
  assert.equal((await f.admin(`/api/channels/chats/${chat.id}/tasks`)).value.own_tasks.length, 1);
});


test('whole-chat access keeps historical group replies and steps visible after a scope change while model input stays fenced', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f, ['101']);
  scriptedModel(f, [['send_message', { text: '旧范围的执行进展。' }], ['list_projects', {}], '旧范围的完整历史回答。']);
  const first = await post(f.h, f.id, inGroup('核对原范围')); assert.equal((await finished(f.h, first.value.operation_id)).state, 'completed');
  await until(() => f.h.store.get('SELECT state FROM channel_outbox WHERE idempotency_key=?', first.value.operation_id + ':business-result'), row => row?.state === 'sent');
  const old = await f.member('old-scope-viewer', { repository_ids: ['101'] }), next = await f.member('new-scope-viewer', { repository_ids: ['102'] });
  assert.equal((await old.client(`/api/channels/chats/${chat.id}/timeline`)).status, 200);
  const binding = f.service.serviceBindings.get(chat.id);
  assert.equal((await f.admin(`/api/channels/chats/${chat.id}/service-binding`, 'PUT', { scope: { kind: 'repositories', repositories: ['102'] }, enabled: true, expected_revision: binding.revision })).status, 200);
  assert.equal((await old.client(`/api/channels/chats/${chat.id}/timeline`)).status, 403);
  assert.ok(!(await old.client('/api/channels/conversations')).value.conversations.some(c => c.id === chat.id));
  const timeline = await next.client(`/api/channels/chats/${chat.id}/timeline`); assert.equal(timeline.status, 200, JSON.stringify(timeline.value));
  const turn = timeline.value.conversation.turns[0];
  assert.equal(turn.reply, '旧范围的完整历史回答。'); assert.equal(turn.messages[0].text, '旧范围的执行进展。'); assert.equal(turn.stale_source, undefined);
  assert.ok(timeline.value.messages.some(m => m.content.includes('旧范围的完整历史回答')));
  assert.ok((await next.client(`/api/channels/chats/${chat.id}/messages`)).value.messages.some(m => m.content.includes('旧范围的完整历史回答')));
  assert.ok((await next.client(`/api/channels/chats/${chat.id}/turns/${turn.id}`)).value.events.some(e => e.type === 'tool_call'));
  f.modelState.respond = async (body, res) => {
    assert.ok(!JSON.stringify(body).includes('旧范围的完整历史回答。'), 'console access does not widen the assistant runtime history');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '按当前范围继续。' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  };
  assert.equal((await finished(f.h, (await post(f.h, f.id, inGroup('按新范围继续'))).value.operation_id)).state, 'completed');
});

test('platform managers read another owner’s complete private history across authorization changes and session rotation without acting as the owner', async t => {
  const f = await channelFixture(t), owner = await f.member('private-history-owner', { repository_ids: ['101'] });
  bindFixture(f.h, f.id, owner.id, 'ou_history_owner');
  const send = content => post(f.h, f.id, envelope(content, { sender: { sender_id: { open_id: 'ou_history_owner' } }, message: { chat_id: 'oc_history_owner' } }));
  scriptedModel(f, [['send_message', { text: '第一轮的进展。' }], '第一轮的回答。']);
  const first = await send('第一轮的问题'); assert.equal((await finished(f.h, first.value.operation_id)).state, 'completed');
  const chat = f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_history_owner'");
  const firstView = (await owner.client(`/api/channels/chats/${chat.id}/conversation`)).value;
  f.h.store.run('UPDATE principals SET authorization_revision=authorization_revision+1 WHERE id=?', owner.id);
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
  scriptedModel(f, ['会话轮换后的回答。']);
  const second = await send('第二轮的问题'); assert.equal((await finished(f.h, second.value.operation_id)).state, 'completed');
  scriptedModel(f, ['管理员自己的回答。']);
  assert.equal((await finished(f.h, (await post(f.h, f.id, envelope('另一个私聊的请求'))).value.operation_id)).state, 'completed');
  const actual = (await f.admin(`/api/channels/chats/${chat.id}/timeline`)).value;
  assert.equal(actual.conversation.turns.length, 2, JSON.stringify(actual));
  assert.deepEqual(new Set(actual.conversation.turns.map(t => t.reply)), new Set(['第一轮的回答。', '会话轮换后的回答。']));
  assert.equal(actual.conversation.can_continue, false); assert.equal(actual.chat.can_refresh_name, false); assert.equal(actual.chat.binding_id, null);
  assert.notEqual(actual.conversation.management_conversation_id, firstView.management_conversation_id);
  const firstTurn = actual.conversation.turns.find(t => t.reply === '第一轮的回答。'); assert.equal(firstTurn.messages[0].text, '第一轮的进展。');
  assert.ok((await f.admin(`/api/channels/chats/${chat.id}/turns/${firstTurn.id}`)).value.events.length > 0);
  const own = (await owner.client(`/api/channels/chats/${chat.id}/conversation`)).value; assert.equal(own.turns.length, 2); assert.equal(own.can_continue, true);
  const stranger = await f.member('private-history-stranger', { repository_ids: ['101'] });
  for (const part of ['timeline', 'conversation', 'messages', 'tasks']) assert.equal((await stranger.client(`/api/channels/chats/${chat.id}/${part}`)).status, 403);
  assert.equal((await f.admin('/api/management/conversations/' + actual.conversation.management_conversation_id)).status, 404);
  f.h.store.run('UPDATE channel_connectors SET enabled=0 WHERE id=?', f.id);
  assert.equal((await f.admin(`/api/channels/chats/${chat.id}/timeline`)).value.conversation.turns.length, 2);
  assert.ok((await f.admin('/api/channels/conversations')).value.conversations.some(c => c.id === chat.id));
});

// #870: a missing Feishu name used to be looked up again on every draw, because the only state the console kept was the
// render it started in. The page is driven here as the browser runs it (`static/channels.js` in the console sandbox), so
// the number that counts is the provider-side one: each POST the page starts reaches the fixture's Feishu transport.
// What the page decides, counted on the page's own side: a slow fixture cannot hide a lookup it started, and a redraw
// that starts none leaves the number where it was.
const nameLookups = page => page.run('globalThis.__nameLookups.length');
const settle = async page => {
  let last = -1, quiet = 0;
  while (quiet < 5) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const now = nameLookups(page);
    if (now === last) quiet += 1; else { quiet = 0; last = now; }
  }
  return last;
};
const consoleAgainst = f => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/channels.js'],
    async (method, path, body) => { const response = await f.admin(path, method, body); return [response.status, response.value]; });
  page.run('globalThis.__nameLookups = []; const countedNameRequest = channelNameRequest; channelNameRequest = route => { globalThis.__nameLookups.push(route); return countedNameRequest(route); };');
  return page;
};
// The reader of a console page: the fixture's own session, as the console script's `api()` asks it.
const signInSandbox = page => page.run("me = { role: 'super_admin', csrf_token: 'fixture-csrf' }; renderVersion = 0;");

test('a refused name lookup is tried once per chat, not on every redraw, and the button still retries it (#870)', async t => {
  const f = await channelFixture(t), chat = await boundGroup(f);
  assert.equal(chat.display_name, '', 'the fixture chat starts without a name');
  f.wire.state.chatCode = 99991672; // the app is missing the contact scope, so the provider refuses every lookup
  const page = consoleAgainst(f), profile = JSON.stringify({ ...chat, can_refresh_name: true });
  signInSandbox(page);
  page.run(`var chat = ${profile};`);
  const draw = async () => { page.run('renderVersion++; var box = channelProfileDetails(chat)'); await settle(page); };
  await draw();
  assert.equal(nameLookups(page), 1, 'the first draw reads the missing name once');
  await until(() => f.wire.state.chatRequests.length, count => count >= 1);
  await draw(); await draw();
  assert.equal(nameLookups(page), 1, 'redrawing the same chat does not ask the provider again');
  const refresh = page.run('box.children.find(node => node.tagName === "BUTTON")');
  assert.ok(refresh, 'the details still offer the reader a retry');
  refresh.listeners.click[0]();
  await settle(page);
  assert.equal(nameLookups(page), 2, 'the reader can still retry by hand');
  await until(() => f.wire.state.chatRequests.length, count => count >= 2);
  await draw();
  assert.equal(nameLookups(page), 2, 'and that failed retry is remembered too');
});

test('the group bindings section does not name every group again on each redraw (#870)', async t => {
  const f = await channelFixture(t), chat = await boundGroup(f);
  assert.equal(chat.display_name, '', 'the fixture chat starts without a name');
  f.wire.state.chatCode = 99991672;
  const page = consoleAgainst(f), data = (await f.admin('/api/channels/service-bindings')).value;
  signInSandbox(page);
  page.run(`var groupData = ${JSON.stringify(data)};`);
  await page.run('buildGroupBindingEditor(groupData)');
  await settle(page);
  const attempts = nameLookups(page);
  assert.ok(attempts > 0, 'the group editor reads the missing name');
  await until(() => f.wire.state.chatRequests.length, count => count >= 1);
  const requests = f.wire.state.chatRequests.length;
  page.run('renderVersion++; buildGroupBindingEditor(groupData); buildGroupBindingsList(groupData)');
  await settle(page);
  assert.equal(nameLookups(page), attempts, 'and a redraw of the editor or list does not read any name again');
  assert.equal(f.wire.state.chatRequests.length, requests, 'so the provider is not asked again either');
});

// #870: the personal binding row on the Feishu page is a third automatic entry: it enqueues its own refresh when the
// name is missing, and that entry has to remember a refusal as well.
test('the personal Feishu binding row reads a refused name once, not on every redraw (#870)', async t => {
  const f = await channelFixture(t);
  // Only a binding in the robot's own enterprise reads names (`can_read_name`); console tests bind there too.
  f.h.store.run("UPDATE external_identities SET external_tenant='install-tenant' WHERE connector LIKE ?", f.id + ':%');
  f.wire.state.profileCode = 99991672; // the app is missing the contact scope, so the provider refuses every lookup
  const page = consoleAgainst(f);
  signInSandbox(page);
  const draw = async () => { page.run('renderVersion++; renderFeishuBindingsPage(document.getElementById("identity-feishu"), () => true)'); await settle(page); };
  await draw();
  assert.equal(nameLookups(page), 1, 'the first draw reads the missing personal name once');
  await until(() => f.wire.state.profileRequests.length, count => count >= 1);
  await draw();
  assert.equal(nameLookups(page), 1, 'redrawing the page does not look the refused name up again');
  assert.equal(f.wire.state.profileRequests.length, 1, 'and the provider is not asked a second time');
});

test('conversations list filters by connector_id with authorization isolation and timeline exposes sync/retention capabilities (#1228)', async t => {
  const f = await channelFixture(t), { admin, h, member, id } = f;
  const second = await admin('/api/channels/connectors', 'POST', {
    app_id: 'cli_second_console', application_type: 'enterprise', transport: 'http', enabled: true,
    credentials, expected_revision: 0,
  });
  assert.equal(second.status, 201, JSON.stringify(second.value));
  const secondId = second.value.connector_id;
  h.store.run("UPDATE channel_connectors SET app_name='应用一',tenant_name='企业一' WHERE id=?", id);
  h.store.run("UPDATE channel_connectors SET app_name='应用二',tenant_name='企业二' WHERE id=?", secondId);
  const chat1Post = await post(h, id, envelope('chat in app 1', { message: { chat_id: 'oc_app1', chat_type: 'group' } }));
  assert.equal(chat1Post.status, 200, JSON.stringify(chat1Post.value));
  await finished(h, chat1Post.value.operation_id);
  const chat2Post = await post(h, secondId, envelope('chat in app 2', { header: { app_id: 'cli_second_console' }, message: { chat_id: 'oc_app2', chat_type: 'group' } }));
  assert.equal(chat2Post.status, 200, JSON.stringify(chat2Post.value));
  await finished(h, chat2Post.value.operation_id);
  const chat1 = h.store.get("SELECT * FROM channel_chats WHERE connector_id=? AND chat_id='oc_app1'", id);
  const chat2 = h.store.get("SELECT * FROM channel_chats WHERE connector_id=? AND chat_id='oc_app2'", secondId);

  const filtered1 = await admin('/api/channels/conversations?connector_id=' + id);
  assert.equal(filtered1.status, 200);
  assert.deepEqual(filtered1.value.conversations.map(c => c.id), [chat1.id]);
  assert.equal(filtered1.value.conversations[0].connector_id, id);
  assert.deepEqual(filtered1.value.connector, { id, app_name: '应用一', tenant_name: '企业一' });

  const filtered2 = await admin('/api/channels/conversations?connector_id=' + secondId);
  assert.deepEqual(filtered2.value.conversations.map(c => c.id), [chat2.id]);
  assert.deepEqual(filtered2.value.connector, { id: secondId, app_name: '应用二', tenant_name: '企业二' });

  // An ordinary member with no chats in connector 2 cannot discover its name via connector_id filtering.
  const ordinary = await member('conv-filter-ordinary', { repository_ids: ['101'] });
  const ordinaryFiltered = await ordinary.client('/api/channels/conversations?connector_id=' + secondId);
  assert.equal(ordinaryFiltered.status, 200);
  assert.deepEqual(ordinaryFiltered.value.conversations, []);
  assert.equal(ordinaryFiltered.value.connector, null);

  // Timeline exposes revision, connector_id, can_sync, can_manage_retention and can_view_schedules accurately per role.
  const adminTimeline = await admin(`/api/channels/chats/${chat1.id}/timeline`);
  assert.equal(adminTimeline.status, 200);
  assert.equal(adminTimeline.value.chat.connector_id, id);
  assert.equal(adminTimeline.value.chat.revision, chat1.revision);
  assert.equal(adminTimeline.value.chat.can_sync, true);
  assert.equal(adminTimeline.value.chat.can_manage_retention, true);
  assert.equal(adminTimeline.value.chat.can_view_schedules, true);

  // Retention PUT/DELETE return the bumped revision for subsequent optimistic updates.
  const retained = await admin(`/api/channels/chats/${chat1.id}/retention`, 'PUT', { days: 15, expected_revision: adminTimeline.value.chat.revision });
  assert.equal(retained.status, 200);
  assert.equal(retained.value.retention.days, 15);
  assert.equal(retained.value.revision, chat1.revision + 1);

  // Personal chat owner can view, sync and manage schedules on their own active chat, but cannot manage retention.
  bindFixture(h, id, ordinary.id, 'ou_ordinary_p2p');
  const p2pPost = await post(h, id, envelope('hello', { sender: { sender_id: { open_id: 'ou_ordinary_p2p' } }, message: { chat_id: 'oc_ordinary_p2p', chat_type: 'p2p' } }));
  await finished(h, p2pPost.value.operation_id);
  const p2pChat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_ordinary_p2p'");
  const ownerTimeline = await ordinary.client(`/api/channels/chats/${p2pChat.id}/timeline`);
  assert.equal(ownerTimeline.status, 200);
  assert.equal(ownerTimeline.value.chat.can_sync, true);
  assert.equal(ownerTimeline.value.chat.can_manage_retention, false);
  assert.equal(ownerTimeline.value.chat.can_view_schedules, true);

  // Disabling the connector turns can_sync off on timeline.
  h.store.run('UPDATE channel_connectors SET enabled=0 WHERE id=?', id);
  assert.equal((await admin(`/api/channels/chats/${chat1.id}/timeline`)).value.chat.can_sync, false);
  // Super admins keep read-only diagnostic schedule visibility even on inactive chats.
  assert.equal((await admin(`/api/channels/chats/${chat1.id}/timeline`)).value.chat.can_view_schedules, true);
});


