import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, inGroup, post, bindFixture, envelope } from './channel-fixture.mjs';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { resolvePrincipalActor, authorize, invalidate } from '../dist/identity/authorization.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { assertManagedExecution } from '../dist/tasks/management.js';
import { roleApi } from '../dist/roles/api.js';

const config = { project_id: '101', role_id: 'reviewer', capabilities: ['tasks.read', 'tasks.manage_own', 'knowledge.read'], enabled: true, expected_revision: 0 };
async function fixture(t) {
  const f = await channelFixture(t);
  const incoming = await post(f.h, f.id, inGroup('local discussion', 'ou_bob'));
  const chat = f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
  const actor = resolvePrincipalActor(f.h.store, f.principal, null, '101');
  const commands = new TaskCommands(f.h.store);
  // The role permission belongs to the project editor, never to transport-specific rules.
  roleApi(f.h.store, { id: f.principal, role: 'super_admin', repositories: [] }, 'PUT', new URL('http://local/api/repositories/101/roles'),
    { expected_revision: 0, enabled: false, roles: [{ role_id: 'reviewer', permissions: { task_management: 'write' } }] });
  return { ...f, chat, actor, commands, source: incoming.value.operation_id };
}

test('a bound qualified maintainer enables a narrow durable principal; an ordinary unbound member uses the same task service', async t => {
  const f = await fixture(t), { h, service, chat, actor, commands } = f;
  const enabled = await service.employees.configure(actor, chat.id, config);
  const principal = h.store.get('SELECT * FROM principals WHERE id=?', enabled.principal_id);
  assert.equal(principal.kind, 'service'); assert.equal(principal.maintenance, 'channel:' + chat.id);
  const scoped = resolvePrincipalActor(h.store, enabled.principal_id, null, '101');
  authorize(scoped, 'tasks.manage_own', { project_id: '101' });
  for (const capability of ['tasks.write', 'config.write', 'roles.edit', 'grants.manage', 'schedules.manage']) assert.throws(() => authorize(scoped, capability, { project_id: '101' }), { code: 'capability_forbidden' });
  const caller = service.employees.caller(chat.id, '101', f.source);
  const created = commands.tool(caller, 'create_task', { request: 'Report discussion', criteria: ['Use local sources'], execute: false });
  assert.equal(h.store.get('SELECT executor_role FROM task_origins WHERE task_id=?', created.id).executor_role, 'reviewer');
  assertManagedExecution(h.store, h.store.get('SELECT * FROM tasks WHERE id=?', created.id));
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_bob'").n, 0);
  assert.equal(commands.tool(caller, 'create_task', { request: 'Borrow Dev', criteria: ['x'], executor_role: 'dev' }).error, 'task_delegation_forbidden');
  assert.equal(service.employees.list(actor).employees[0].conversation_id, chat.id);
  const snapshot = h.store.get('SELECT * FROM channel_employee_grants');
  assert.equal(snapshot.enabled, 1); assert.ok(!JSON.stringify(snapshot).includes('fixture-feishu-app-secret'));
});

test('configuration requires both a personal binding and current project authority, rejects widening and a non-member maintainer', async t => {
  const f = await fixture(t), { h, service, actor, chat } = f;
  const unbound = knowledgeActor(h.store, 'unbound', '101', ['config.write', 'tasks.read', 'tasks.write', 'knowledge.read']);
  await assert.rejects(service.employees.configure(unbound, chat.id, config), { code: 'external_binding_required' });
  const reader = knowledgeActor(h.store, 'reader', '101', ['tasks.read']); bindFixture(h, f.id, 'reader', 'ou_bob');
  await assert.rejects(service.employees.configure(reader, chat.id, config), { code: 'capability_forbidden' });
  await assert.rejects(service.employees.configure(actor, chat.id, { ...config, capabilities: ['tasks.read', 'config.write'] }), { code: 'channel_employee_capabilities_invalid' });
  f.wire.state.members = f.wire.state.members.filter(m => m.member_id !== 'ou_alice');
  await assert.rejects(service.employees.configure(actor, chat.id, config), { code: 'channel_employee_member_required' });
  assert.equal(h.store.get('SELECT count(*) n FROM channel_employee_grants').n, 0);
});

test('audience changes fence old callers, recovered tasks and local history until automatic verification succeeds', async t => {
  const f = await fixture(t), { h, service, actor, chat, commands } = f;
  await service.employees.configure(actor, chat.id, config);
  const caller = service.employees.caller(chat.id, '101', f.source), task = commands.tool(caller, 'create_task', { request: 'Pending task', criteria: ['x'], execute: false });
  const current = h.store.get('SELECT * FROM tasks WHERE id=?', task.id);
  service.employees.invalidate(chat.id, 'audience_changed');
  assert.throws(() => service.employees.guardSync(chat), { code: 'channel_employee_sync_paused' });
  assert.throws(() => commands.tool(caller, 'list_managed_tasks', {}), { code: 'channel_employee_revalidation_required' });
  assert.throws(() => assertManagedExecution(h.store, current), { code: 'channel_employee_revalidation_required' });
  h.store.run('UPDATE channel_audiences SET checked_at=0'); await service.employees.tick();
  service.employees.guardSync(chat);
  assertManagedExecution(h.store, current);
  f.wire.state.members = f.wire.state.members.filter(m => m.member_id !== 'ou_alice');
  service.employees.invalidate(chat.id, 'audience_changed'); await service.employees.verify(chat.id, true);
  assert.throws(() => assertManagedExecution(h.store, current), { code: 'channel_employee_member_required' });
  assert.equal(service.employees.list(actor).employees[0].state, 'paused');
});

test('membership paging checks the bot separately and rejects incomplete, cyclic or in-flight invalidated audiences', async t => {
  const f = await fixture(t), { service, actor, chat } = f; let count = 0;
  f.wire.state.audience = async url => {
    if (url.pathname.endsWith('/is_in_chat')) return Response.json({ code: 0, data: { is_in_chat: true } });
    assert.equal(url.searchParams.get('page_size'), '100'); count++;
    return Response.json({ code: 0, data: count === 1 ? { items: [], has_more: true, page_token: 'page-2' } : { items: f.wire.state.members, has_more: false } });
  };
  await service.employees.configure(actor, chat.id, config); assert.equal(count, 2);
  f.wire.state.audience = async url => Response.json({ code: 0, data: url.pathname.endsWith('/is_in_chat') ? { is_in_chat: true } : { items: [], has_more: true, page_token: 'same' } });
  await assert.rejects(service.employees.verify(chat.id, true), { code: 'channel_audience_cursor_stalled' });
  f.wire.state.audience = async url => Response.json({ code: 0, data: url.pathname.endsWith('/is_in_chat') ? { is_in_chat: true } : { items: [], has_more: false, trigger_security_conf_limit: true } });
  await assert.rejects(service.employees.verify(chat.id, true), { code: 'channel_audience_unverified' });
  let release, requested; const started = new Promise(r => { requested = r; }), response = new Promise(r => { release = r; });
  f.wire.state.audience = async url => {
    if (url.pathname.endsWith('/is_in_chat')) return Response.json({ code: 0, data: { is_in_chat: true } });
    requested(); await response; return Response.json({ code: 0, data: { items: f.wire.state.members, has_more: false } });
  };
  const checking = service.employees.verify(chat.id, true); await started; service.employees.invalidate(chat.id, 'changed_during_http'); release();
  await assert.rejects(checking, { code: 'channel_employee_audience_changed' });
  assert.equal(f.h.store.get('SELECT verified_until FROM channel_audiences').verified_until, 0);
});

test('unbinding, revoking the maintainer project grant, disabled projects, bot removal and explicit disable stop protected actions without deleting the chat', async t => {
  const f = await fixture(t), { h, service, actor, chat } = f;
  const configured = await service.employees.configure(actor, chat.id, config);
  const origin = { principal_id: configured.principal_id, conversation_id: chat.id, project_id: '101', source_role: 'reviewer', source_message: f.source };
  const binding = h.store.get('SELECT binding_id FROM channel_employee_grants').binding_id;
  h.store.run("UPDATE external_identities SET status='revoked' WHERE id=?", binding);
  assert.throws(() => service.employees.guardOrigin(origin), { code: 'external_binding_required' });
  h.store.run("UPDATE external_identities SET status='active' WHERE id=?", binding);
  h.store.run("UPDATE policies SET enabled=0 WHERE repository_id='101'");
  assert.throws(() => service.employees.guardOrigin(origin), { code: 'channel_employee_project_inactive' });
  h.store.run("UPDATE policies SET enabled=1 WHERE repository_id='101'");
  await service.employees.configure(actor, chat.id, { ...config, enabled: false, expected_revision: 1 });
  assert.throws(() => service.employees.guardSync(chat), { code: 'channel_employee_sync_paused' });
  assert.throws(() => service.employees.guardOrigin(origin), { code: 'channel_employee_disabled' });
  assert.equal(h.store.get('SELECT id FROM channel_chats WHERE id=?', chat.id).id, chat.id);
  assert.equal(h.store.get('SELECT active FROM principals WHERE id=?', configured.principal_id).active, 0);
});

test('revoking a maintainer grant and verified bot-removal events invalidate subsequent task execution', async t => {
  const f = await fixture(t), { h, service, chat } = f;
  const actor = knowledgeActor(h.store, 'maintainer', '101', ['config.write', 'tasks.read', 'tasks.manage_own', 'knowledge.read']);
  bindFixture(h, f.id, 'maintainer', 'ou_maintainer');
  f.wire.state.members.push({ member_id_type: 'open_id', member_id: 'ou_maintainer', tenant_key: 'actor-tenant' });
  const configured = await service.employees.configure(actor, chat.id, config);
  const origin = { principal_id: configured.principal_id, conversation_id: chat.id, project_id: '101', source_role: 'reviewer', source_message: f.source };
  h.store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id='maintainer'", Date.now()); invalidate(h.store, 'maintainer', 'test_revocation');
  assert.throws(() => service.employees.guardOrigin(origin), { code: 'capability_forbidden' });
  h.store.run("UPDATE scoped_grants SET revoked_at=NULL WHERE principal_id='maintainer'"); invalidate(h.store, 'maintainer', 'test_restore');
  const event = envelope(); event.header.event_type = 'im.chat.member.bot.deleted_v1'; event.event = { chat_id: 'oc_group' };
  await post(h, f.id, event);
  assert.equal(h.store.get('SELECT verified_until FROM channel_audiences').verified_until, 0);
  assert.throws(() => service.employees.guardOrigin(origin), { code: 'channel_employee_source_inactive' });
});

test('local history for a maintained group makes no provider requests and rejects other projects, people and private chats', async t => {
  const f = await fixture(t), { h, service, chat } = f;
  const actor = knowledgeActor(h.store, 'history-maintainer', '101', ['config.write', 'tasks.read', 'tasks.manage_own', 'knowledge.read']);
  bindFixture(h, f.id, 'history-maintainer', 'ou_history'); f.wire.state.members.push({ member_id_type: 'open_id', member_id: 'ou_history', tenant_key: 'actor-tenant' });
  await service.employees.configure(actor, chat.id, config);
  const before = f.wire.state.audienceRequests.length + f.wire.state.historyRequests.length;
  service.employees.authorizeHistory(actor, chat.id); assert.ok(service.ledger.query(chat.id).messages.length);
  assert.equal(f.wire.state.audienceRequests.length + f.wire.state.historyRequests.length, before);
  const reader = knowledgeActor(h.store, 'other-reader', '101');
  assert.throws(() => service.employees.authorizeHistory(reader, chat.id), { code: 'channel_history_forbidden' });
  assert.throws(() => service.employees.caller(chat.id, '201', f.source), { code: 'channel_employee_project_required' });
  const incoming = await post(h, f.id, envelope('private'));
  assert.throws(() => service.employees.caller(chat.id, '101', incoming.value.operation_id), { code: 'channel_employee_source_mismatch' });
});
