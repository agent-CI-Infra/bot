import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, privateChat, boundGroup, scriptedModel, repositoryAssistant, until, bindFixture, envelope, inGroup, post, finished } from './channel-fixture.mjs';

// Prompt-driven timers on a Feishu chat (#330). Model and Feishu traffic go to local protocol fixtures.
const timer = (client, chat, input = {}) => client('/api/channels/chats/' + chat.id + '/schedules', 'POST',
  { name: '每日汇总', prompt: '汇总我可读的所有项目里失败的任务；没有异常就简短告知一切正常。', timezone: 'Asia/Shanghai', cron: '0 9 * * *', ...input });
const runs = (f, id) => f.h.store.all('SELECT * FROM channel_schedule_runs WHERE schedule_id=? ORDER BY created_at,rowid', id);
const settled = (f, id, key) => until(() => runs(f, id).filter(r => !key || r.logical_key === key).at(-1), run => run && run.state !== 'running');
const cards = (f, chat) => f.wire.sent.filter(s => s.receive_id === chat.chat_id).map(s => JSON.stringify(s.content));
const due = (f, id, at) => f.h.store.run('UPDATE channel_schedules SET next_at=? WHERE id=?', at, id);

test('a private chat owner runs a prompt timer through the management assistant across projects; nobody else may manage it (#330)', async t => {
  const f = await channelFixture(t), chat = await privateChat(f);
  let request;
  scriptedModel(f, [(done, context) => { request = context.request; return ['management_query', { operation: 'list_projects', target: {}, arguments: {} }]; },
    done => `共 ${done[0].projects.length} 个项目，没有失败的任务。`]);
  const created = await timer(f.admin, chat); assert.equal(created.status, 201, JSON.stringify(created.value));
  const s = created.value.schedule;
  assert.equal(s.kind, 'personal'); assert.equal(s.state, 'active'); assert.equal(s.future.length, 3); assert.equal(s.future[0], s.next_at);
  assert.equal(new Date(s.next_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }), '09:00');
  assert.ok(!JSON.stringify(f.h.store.get('SELECT prompt FROM channel_schedules')).includes('汇总'), 'the prompt is sealed at rest');
  // Only the bound owner manages a private chat's timers; another member with the same projects cannot even read them.
  const member = await f.member('timer-member', { repository_ids: ['101'] }); bindFixture(f.h, f.id, member.id, 'ou_member');
  assert.equal((await timer(member.client, chat)).value.error, 'channel_schedule_forbidden');
  assert.equal((await member.client('/api/channels/chats/' + chat.id + '/schedules')).value.error, 'channel_schedule_forbidden');
  assert.equal((await member.client('/api/channels/schedules/' + s.id + '/run', 'POST', {})).value.error, 'channel_schedule_forbidden');
  assert.equal((await timer(f.admin, chat, { interval_minutes: 1, cron: undefined })).value.error, 'channel_schedule_interval_invalid');
  assert.equal((await timer(f.admin, chat, { interval_minutes: 60 })).value.error, 'channel_schedule_recurrence_required');
  // Run once now: the owner's management assistant answers in a conversation of this timer; the result returns to the chat.
  assert.equal((await f.admin('/api/channels/schedules/' + s.id + '/run', 'POST', {})).status, 201);
  const run = await settled(f, s.id); assert.equal(run.state, 'completed', run.error); assert.equal(run.trigger, 'manual');
  await until(() => cards(f, chat).find(c => c.includes('定时任务「每日汇总」') && c.includes('共 3 个项目，没有失败的任务')));
  assert.match(request, /定时任务「每日汇总」/); assert.match(request, /汇总我可读的所有项目里失败的任务/);
  const message = f.h.store.get('SELECT * FROM management_messages WHERE id=?', run.message_id);
  assert.equal(message.source_message, 'schedule:' + run.id); assert.equal(message.state, 'completed');
  assert.deepEqual(f.h.store.all('SELECT DISTINCT repository_id,service_role_id FROM model_requests WHERE conversation_id=?', message.conversation_id).map(r => ({ ...r })),
    [{ repository_id: null, service_role_id: 'management-assistant' }], 'usage belongs to the management assistant');
  // A prompt that allows silence and finds nothing to report sends no empty card.
  scriptedModel(f, ['']); const quiet = cards(f, chat).length;
  await f.admin('/api/channels/schedules/' + s.id + '/run', 'POST', {});
  assert.equal((await settled(f, s.id)).state, 'silent'); await f.service.tick(); assert.equal(cards(f, chat).length, quiet);
  // The timer: one run per logical occurrence, even when two workers tick; a missed occurrence is skipped, not run late.
  scriptedModel(f, ['定时汇报：一切正常。']);
  const at = Date.now() - 1000; due(f, s.id, at);
  await Promise.all([f.service.schedules.tick(), f.service.schedules.tick()]);
  const timed = await settled(f, s.id, 'timer:' + at);
  assert.equal(runs(f, s.id).filter(r => r.logical_key === 'timer:' + at).length, 1); assert.equal(timed.state, 'completed', timed.error); assert.equal(timed.trigger, 'timer');
  assert.ok(f.h.store.get('SELECT next_at FROM channel_schedules WHERE id=?', s.id).next_at > Date.now());
  const missed = Date.now() - 20 * 60000; due(f, s.id, missed); await f.service.schedules.tick();
  assert.deepEqual({ ...f.h.store.get('SELECT state,error FROM channel_schedule_runs WHERE logical_key=?', 'timer:' + missed) }, { state: 'skipped', error: 'channel_schedule_missed' });
  // Pausing stops the timer; editing keeps its id and bumps its revision; a stale revision is refused.
  const paused = (await f.admin('/api/channels/schedules/' + s.id, 'PATCH', { expected_revision: s.revision, enabled: false })).value.schedule;
  assert.equal(paused.state, 'paused'); assert.equal(paused.reason, 'user_paused'); assert.equal(paused.next_at, null);
  assert.equal((await f.admin('/api/channels/schedules/' + s.id, 'PATCH', { expected_revision: s.revision, enabled: true })).value.error, 'channel_schedule_revision_conflict');
  const edited = (await f.admin('/api/channels/schedules/' + s.id, 'PATCH', { expected_revision: paused.revision, name: '工作日汇总', prompt: '只汇总失败的 CI。', timezone: 'UTC', interval_minutes: 30, enabled: true })).value.schedule;
  assert.equal(edited.state, 'active'); assert.equal(edited.interval_minutes, 30); assert.equal(edited.cron, null); assert.equal(edited.prompt, '只汇总失败的 CI。');
  // The owner unbinds Feishu: the next occurrence fails its check and pauses the timer with the reason; nothing is sent.
  f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=?", f.principal);
  const sent = cards(f, chat).length, later = Date.now() - 1000; due(f, s.id, later); await f.service.schedules.tick();
  const blocked = await settled(f, s.id, 'timer:' + later);
  assert.equal(blocked.state, 'failed'); assert.equal(blocked.error, 'external_binding_required');
  assert.deepEqual({ ...f.h.store.get('SELECT state,reason FROM channel_schedules WHERE id=?', s.id) }, { state: 'paused', reason: 'external_binding_required' });
  await f.service.tick(); assert.equal(cards(f, chat).length, sent);
  assert.deepEqual(f.h.store.all("SELECT action FROM audit WHERE action LIKE 'channel.schedule.%' ORDER BY created_at").map(a => a.action),
    ['channel.schedule.created', 'channel.schedule.paused', 'channel.schedule.updated']);
});

test('a group timer runs the bound service role within the group scope and its tools; a disabled binding pauses it (#330)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f);
  const group = await boundGroup(f, ['101']);
  let request;
  scriptedModel(f, [(done, context) => { request = context.request; return ['list_projects', {}]; },
    () => ['list_project_tasks', { repository: 'agent-test-zone/admin-fixture-101' }],
    done => `本群范围：${done[0].projects.map(p => p.repository).join('、')}；任务工具：${done[1].error}`]);
  const created = await timer(f.admin, group, { name: '群巡检', prompt: '检查本群仓库今天新开的 bug 和未合入的 PR，整理成简报。', cron: undefined, interval_minutes: 60 });
  assert.equal(created.status, 201, JSON.stringify(created.value)); const s = created.value.schedule;
  assert.equal(s.kind, 'group'); assert.equal(s.interval_minutes, 60);
  // Managing a group's timers needs the right to manage its assistant binding.
  const member = await f.member('group-member', {});
  assert.equal((await timer(member.client, group)).value.error, 'channel_schedule_forbidden');
  assert.equal((await f.admin('/api/channels/schedules/' + s.id + '/run', 'POST', {})).status, 201);
  const run = await settled(f, s.id); assert.equal(run.state, 'completed', run.error);
  // The role sees only the bound repository and cannot use a tool its permissions do not offer, whatever the prompt asks.
  const card = await until(() => cards(f, group).find(c => c.includes('定时任务「群巡检」')));
  assert.match(card, /本群范围：agent-test-zone\/admin-fixture-101；任务工具：tool_not_allowed/);
  assert.match(request, /检查本群仓库今天新开的 bug/);
  const turn = f.h.store.get('SELECT * FROM channel_service_turns WHERE id=?', run.turn_id);
  assert.equal(turn.source_message, 'schedule:' + run.id); assert.equal(turn.service_role_id, 'repository-assistant'); assert.equal(turn.state, 'completed');
  const system = f.requests.at(-1).messages[0].content;
  // Only the timer branch is appended, never the one for a group message without an @ (both turns allow silence).
  assert.match(system, /started by one of this group's timers/); assert.doesNotMatch(system, /This message did not mention you\./);
  // Billed to the role; the group is scoped to one repository, so its usage also counts in that project (#849).
  assert.ok(f.h.store.all('SELECT * FROM model_requests WHERE conversation_id=?', group.id).every(r => r.repository_id === '101' && r.service_role_id === 'repository-assistant'));
  // The report joins the group's own context under the binding, like the assistant's answers.
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', group.id);
  await until(() => f.h.store.get('SELECT 1 FROM channel_message_scopes WHERE chat_id=? AND project_id=?', group.id, 'binding:' + binding.id));
  // Disabling the group's assistant pauses its timer at the next occurrence, with the reason.
  assert.equal((await f.admin('/api/channels/chats/' + group.id + '/service-binding', 'PUT', { enabled: false, expected_revision: binding.revision })).status, 200);
  const at = Date.now() - 1000; due(f, s.id, at); await f.service.schedules.tick();
  const blocked = await settled(f, s.id, 'timer:' + at);
  assert.equal(blocked.state, 'failed'); assert.equal(blocked.error, 'channel_service_binding_disabled');
  assert.deepEqual({ ...f.h.store.get('SELECT state,reason FROM channel_schedules WHERE id=?', s.id) }, { state: 'paused', reason: 'channel_service_binding_disabled' });
  // A platform manager still sees the timer, but nobody may run it until the group has an assistant again.
  const listed = (await f.admin('/api/channels/chats/' + group.id + '/schedules')).value;
  assert.equal(listed.can_manage, false); assert.equal(listed.schedules[0].reason, 'channel_service_binding_disabled');
  assert.equal((await f.admin('/api/channels/schedules/' + s.id + '/run', 'POST', {})).value.error, 'channel_schedule_forbidden');
});

const offeredTools = f => (f.requests.at(-1).tools ?? []).map(tool => tool.function.name);

test('the management assistant manages its private chat\'s timers for the owner, from the conversation (#851)', async t => {
  const f = await channelFixture(t), chat = await privateChat(f);
  const ask = { action: 'create', name: '每日检查', prompt: '检查 main 的 CI 和新 Issue；有失败时提 Issue 并告诉我，没有就保持沉默。', cron: '0 9 * * *' };
  scriptedModel(f, [['conversation_schedules', ask], done => ['conversation_schedules', { action: 'update', id: done[0].schedule.id, cron: '30 8 * * *' }],
    done => ['conversation_schedules', { action: 'list' }], done => `已设置，下次运行 ${new Date(done[1].schedule.next_at).toISOString()}`]);
  const row = await finished(f.h, (await post(f.h, f.id, envelope('每天早上检查 main 的 CI，有问题提 Issue 告诉我'))).value.operation_id);
  assert.equal(row.state, 'completed', row.error);
  assert.ok(offeredTools(f).includes('conversation_schedules'));
  const saved = f.h.store.get("SELECT * FROM channel_schedules WHERE state<>'deleted'");
  // A personal timer of this chat, owned by the person: the same timer the console shows them, at the default time zone.
  assert.deepEqual({ kind: saved.kind, chat: saved.chat_id, owner: saved.owner_id, by: saved.created_by, timezone: saved.timezone, cron: saved.cron, revision: saved.revision },
    { kind: 'personal', chat: chat.id, owner: f.principal, by: f.principal, timezone: 'Asia/Shanghai', cron: '30 8 * * *', revision: 2 });
  const listed = (await f.admin('/api/channels/chats/' + chat.id + '/schedules')).value.schedules;
  assert.equal(listed.length, 1); assert.equal(listed[0].prompt, ask.prompt); assert.equal(listed[0].name, ask.name);
  assert.equal(new Date(listed[0].next_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }), '08:30');
  assert.deepEqual(f.h.store.all("SELECT action,user_id FROM audit WHERE action LIKE 'channel.schedule.%' ORDER BY rowid").map(r => [r.action, r.user_id]),
    [['channel.schedule.created', f.principal], ['channel.schedule.updated', f.principal]]);
});

test('any member of a group at the comment level manages its timers through the assistant; below it the tool is not there (#851)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f);
  const group = await boundGroup(f, ['101']), binding = () => f.h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', group.id);
  const level = async value => assert.equal((await f.admin('/api/channels/chats/' + group.id + '/service-binding', 'PUT',
    { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, level: value, expected_revision: binding().revision })).status, 200);
  const ask = { action: 'create', name: '群巡检', prompt: '每天检查 main 的 CI；有失败就提 Issue 并在群里说明，没有异常就保持沉默。', cron: '0 9 * * *' };
  // At read the group cannot change anything on GitHub, and its timers stay with the people who manage its binding.
  await level('read');
  scriptedModel(f, [['conversation_schedules', ask], done => `结果：${done[0].error}`]);
  let row = await finished(f.h, (await post(f.h, f.id, inGroup('每天九点检查一下 CI', 'ou_bob'))).value.operation_id);
  assert.equal(row.state, 'completed', row.error);
  assert.ok(!offeredTools(f).includes('conversation_schedules'));
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('结果：tool_not_allowed')));
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_schedules').n, 0);
  // At comment anyone in the group may ask, whoever they are; the binding's principal is recorded as the author.
  await level('comment');
  scriptedModel(f, [['conversation_schedules', ask], done => ['conversation_schedules', { action: 'pause', id: done[0].schedule.id }],
    done => `已创建「${done[1].schedule.name}」，状态 ${done[1].schedule.state}`]);
  row = await finished(f.h, (await post(f.h, f.id, inGroup('每天九点检查一下 CI', 'ou_stranger'))).value.operation_id);
  assert.equal(row.state, 'completed', row.error);
  assert.ok(offeredTools(f).includes('conversation_schedules'));
  assert.match(f.requests.at(-1).messages[0].content, /conversation_schedules manages this group's timers/);
  const saved = f.h.store.get('SELECT * FROM channel_schedules');
  assert.deepEqual({ kind: saved.kind, chat: saved.chat_id, owner: saved.owner_id, by: saved.created_by, state: saved.state, reason: saved.reason },
    { kind: 'group', chat: group.id, owner: null, by: binding().principal_id, state: 'paused', reason: 'user_paused' });
  // The console shows it to the binding's managers like any group timer; another chat's timer is out of reach.
  assert.equal((await f.admin('/api/channels/chats/' + group.id + '/schedules')).value.schedules[0].name, '群巡检');
  assert.throws(() => f.service.schedules.conversation(group.id, { binding: 'another-binding' }, { action: 'list' }), { code: 'channel_schedule_forbidden' });
});

test('a group timer holds the chat while its grantors are re-verified; a group message arriving meanwhile joins the timer\'s turn (#857, #851)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f);
  const group = await boundGroup(f, ['101']);
  let request;
  scriptedModel(f, [(done, context) => { request = context.request; return '定时巡检结果'; }]);
  const s = (await timer(f.admin, group, { name: '群巡检', prompt: '群巡检任务：汇总本群仓库的情况。' })).value.schedule;
  // Re-verifying the grantors' GitHub proofs (#846) takes a while: the timer already holds the chat.
  const renewal = f.service.renewal.bind(f.service); let release, renewing = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.service.renewal = async (...args) => { renewing++; await gate; return renewal(...args); };
  assert.equal((await f.admin('/api/channels/schedules/' + s.id + '/run', 'POST', {})).status, 201);
  await until(() => renewing, n => n >= 1);
  const receipt = await post(f.h, f.id, inGroup('现在情况怎么样？', 'ou_bob'));
  // The message does not take the chat from the timer: no turn starts while the timer's renewal runs.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns WHERE chat_id=?', group.id).n, 0);
  assert.equal(f.h.store.get('SELECT state FROM channel_inbox WHERE id=?', receipt.value.operation_id).state, 'queued');
  release();
  const run = await settled(f, s.id); assert.equal(run.state, 'completed', run.error);
  // When the timer's turn opens it takes in the message already waiting for the chat (#458): one turn answers both, in order.
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  const turns = f.h.store.all('SELECT id,source_message FROM channel_service_turns WHERE chat_id=?', group.id);
  assert.deepEqual(turns.map(turn => turn.source_message.startsWith('schedule:')), [true]);
  assert.ok(f.h.store.get('SELECT 1 FROM channel_turn_inputs WHERE turn_id=? AND source_event=?', turns[0].id, receipt.value.operation_id), 'the message joined the timer turn');
  assert.match(request, /群巡检任务/);
  await until(() => cards(f, group).find(c => c.includes('定时巡检结果')));
});
