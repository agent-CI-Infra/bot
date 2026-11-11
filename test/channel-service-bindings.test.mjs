import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { channelFixture, inGroup, post, until, bindFixture } from './channel-fixture.mjs';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { authorize, invalidate, resolvePrincipalActor } from '../dist/identity/authorization.js';
import { roleApi } from '../dist/roles/api.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { assertManagedExecution } from '../dist/tasks/management.js';

// Groups bind one service role and one project scope (#312). All GitHub and Feishu traffic goes to local protocol fixtures.
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
async function github(t) {
  const state = { requests: [], pulls: { 'admin-fixture-101': [{ number: 7, title: 'Bind group assistants', state: 'open' }], 'admin-fixture-201': [{ number: 9, title: 'Foreign PR', state: 'open' }] } };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://local'), path = decodeURIComponent(url.pathname), body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method, path, body });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    let match;
    if ((match = /^\/repos\/agent-test-zone\/(admin-fixture-\d+)\/installation$/.exec(path))) return send({ id: 55, account: { id: match[1].endsWith('201') ? 20 : 10, login: 'agent-test-zone' },
      permissions: { contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read', metadata: 'read' } });
    if (path === '/app/installations/55/access_tokens') return send({ token: 'fixture-read-token-' + state.requests.length, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: body.permissions }, 201);
    if (path === '/installation/token') return send({});
    if ((match = /^\/repositories\/(\d+)$/.exec(path))) return send({ id: Number(match[1]), full_name: 'agent-test-zone/admin-fixture-' + match[1], owner: { id: match[1] === '201' ? 20 : 10 }, default_branch: 'main' });
    if ((match = /^\/repos\/agent-test-zone\/(admin-fixture-\d+)\/pulls$/.exec(path))) return send(state.pulls[match[1]] ?? []);
    if (path === '/repos/agent-test-zone/admin-fixture-101/contents/src/channels/service.ts') return send({ type: 'file', encoding: 'base64', content: Buffer.from('export class ChannelService {}').toString('base64') });
    send({ message: 'unexpected fixture request ' + path }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}
const reply = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const call = (res, name, args) => reply(res, { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (res, content) => reply(res, { role: 'assistant', content });
const observations = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const done = (f, receipt) => until(() => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id), r => r && ['completed', 'failed'].includes(r.state));
const repo = id => 'agent-test-zone/admin-fixture-' + id;
function groupMessage(text, actor = 'ou_bob', chat = 'oc_group') { const e = inGroup(text, actor); e.event.message.chat_id = chat; return e; }
async function fixture(t) {
  const gh = await github(t), f = await channelFixture(t, { githubUrl: gh.url }), { h } = f;
  // Read tokens are minted only for a GitHub App installation.
  const account = h.store.get('SELECT * FROM accounts WHERE id=?', f.a.id), secrets = h.store.secrets.open(account.credentials, 'account:' + account.id);
  h.store.run("UPDATE accounts SET type='github_app',app_id='123',credentials=? WHERE id=?", h.store.secrets.seal({ ...secrets, token: undefined, private_key: key }, 'account:' + account.id), account.id);
  const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant');
  assert.equal((await f.admin('/api/service-roles/repository-assistant', 'PATCH', { expected_revision: role.revision, model_id: f.assistantModel.id })).status, 200);
  const discovery = groupMessage('Group discussion before binding', 'ou_alice'); discovery.event.message.mentions = []; await post(h, f.id, discovery);
  const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
  const bind = (input = {}, chatId = chat.id) => f.admin('/api/channels/chats/' + chatId + '/service-binding', 'PUT', { service_role_id: 'repository-assistant',
    scope: { kind: 'repositories', repositories: ['101', '102'] }, participation: 'mentions', enabled: true, expected_revision: 0, ...input });
  const setRole = async (input, id = 'repository-assistant') => {
    const current = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === id);
    const result = await f.admin('/api/service-roles/' + id, 'PATCH', { expected_revision: current.revision, ...input }); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.service_role;
  };
  return { ...f, gh, chat, bind, setRole };
}
/** A platform user with config.write (and task access) on the given projects, resolved without a session tenant. */
function maintainer(f, name, projects, open_id) {
  for (const project of projects) knowledgeActor(f.h.store, name, project, ['config.write', 'tasks.read', 'tasks.write']);
  if (open_id) { bindFixture(f.h, f.id, name, open_id); f.wire.state.members.push({ member_id_type: 'open_id', member_id: open_id, tenant_key: 'actor-tenant' }); }
  return resolvePrincipalActor(f.h.store, name, null);
}

test('the repository assistant answers any member across its repositories without choosing a project and refuses the rest', async t => {
  const f = await fixture(t), baseline = f.h.store.get('SELECT count(*) n FROM tasks').n, offered = [];
  const bound = await f.bind(); assert.equal(bound.status, 200, JSON.stringify(bound.value));
  assert.deepEqual(bound.value.reachable, [repo(101), repo(102)]);
  f.modelState.respond = async (body, res) => {
    offered.push(body.tools.map(tool => tool.function.name));
    const seen = observations(body);
    if (seen.length === 0) return call(res, 'list_projects', {});
    if (seen.length === 1) return call(res, 'github_read', { repository: repo(101), path: '/pulls?state=open' });
    if (seen.length === 2) return call(res, 'github_read', { repository: repo(201), path: '/pulls?state=open' });
    if (seen.length === 3) return call(res, 'github_read', { repository: repo(101), path: '/contents/src/channels/service.ts' });
    return say(res, 'admin-fixture-101 有 1 个未关闭的 PR：#7 Bind group assistants。admin-fixture-201 不在本群范围内。');
  };
  const message = groupMessage('bot 仓库最近有哪些未关闭的 PR？顺便解释一下 src/channels/service.ts 的作用'), receipt = await post(f.h, f.id, message);
  const row = await done(f, receipt); assert.equal(row.state, 'completed', row.error);
  const answer = await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('#7 Bind group assistants')));
  assert.equal(answer.content.elements.length, 1, 'a group answer carries no console login button');
  const last = f.requests.at(-1), seen = observations(last);
  assert.deepEqual(seen[0].projects.map(p => p.repository), [repo(101), repo(102)]);
  assert.ok(seen[0].projects.every(p => !('id' in p) && p.url === 'https://github.com/' + p.repository));
  assert.equal(seen[1].repository, repo(101)); assert.equal(seen[1].result[0].number, 7);
  assert.equal(seen[2].error, 'repository_out_of_scope');
  assert.match(seen[3].result.content, /class ChannelService/);
  assert.ok(!f.gh.state.requests.some(r => r.path.includes('admin-fixture-201')), 'an out-of-scope repository is never requested');
  const minted = f.gh.state.requests.filter(r => r.path.endsWith('/access_tokens'));
  assert.equal(minted.length, 1); assert.ok(Object.values(minted[0].body.permissions).every(v => v === 'read')); assert.deepEqual(minted[0].body.repository_ids, [101]);
  assert.ok(f.gh.state.requests.some(r => r.method === 'DELETE' && r.path === '/installation/token'), 'read tokens are revoked after the turn');
  const tools = offered[0];
  for (const name of ['list_projects', 'github_read', 'github_search', 'read_job_log', 'search_conversation_history']) assert.ok(tools.includes(name), name);
  for (const name of ['list_project_tasks', 'manage_project_task', 'create_task', 'delegate_role', 'github_read_token']) assert.ok(!tools.includes(name), name);
  const system = last.messages[0].content, input = JSON.parse(last.messages[1].content);
  assert.match(system, /cannot create, delegate or assign work/); assert.ok(!JSON.stringify(input).includes('"101"'), 'no internal project IDs in the prompt');
  assert.deepEqual(input.context.scope.repositories, [repo(101), repo(102)]);
  // Billing: every request belongs to the service role, none to a project; the speaker never needed a binding.
  const requests = f.h.store.all('SELECT * FROM model_requests WHERE conversation_id=?', f.chat.id);
  assert.equal(requests.length, 5); assert.ok(requests.every(r => r.repository_id === null && r.service_role_id === 'repository-assistant' && r.task_id === null));
  assert.equal(f.h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_bob'").n, 0);
  assert.equal(f.h.store.get('SELECT count(*) n FROM tasks').n, baseline);
  const view = (await f.admin('/api/channels/chats/' + f.chat.id + '/conversation')).value;
  assert.equal(view.mode, 'service'); assert.equal(view.turns[0].role_id, '仓库问答助手'); assert.match(view.turns[0].reply, /#7/); assert.equal(view.usage.requests, 5);
  const usage = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant').usage;
  assert.equal(usage.requests, 5);
  // A repeated delivery of the same event is deduplicated: no second model turn.
  assert.equal((await post(f.h, f.id, message)).value.duplicate, true);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1); assert.equal(f.requests.length, 5);
});

test('binding needs a Feishu-bound maintainer in the group with config.write over every repository or the organization', async t => {
  const f = await fixture(t), { h, chat } = f, bindings = f.service.serviceBindings;
  const input = { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: 0 };
  await assert.rejects(bindings.configure(maintainer(f, 'unbound-maintainer', ['101']), chat.id, input), { code: 'external_binding_required' });
  knowledgeActor(h.store, 'reader', '101', ['tasks.read']); bindFixture(h, f.id, 'reader', 'ou_bob');
  await assert.rejects(bindings.configure(resolvePrincipalActor(h.store, 'reader', null), chat.id, input), { code: 'capability_forbidden' });
  const outsider = maintainer(f, 'outsider', ['101']); bindFixture(h, f.id, 'outsider', 'ou_outsider');
  await assert.rejects(bindings.configure(outsider, chat.id, input), { code: 'channel_employee_member_required' });
  const actor = maintainer(f, 'maintainer', ['101'], 'ou_maintainer'), tenant = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, scope: { kind: 'repositories', repositories: ['101', '201'] } }), { code: 'capability_forbidden' });
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, scope: { kind: 'organization', organization: tenant } }), { code: 'capability_forbidden' });
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, service_role_id: 'management-assistant' }), { code: 'service_role_not_bindable' });
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, scope: { kind: 'repositories', repositories: [] } }), { code: 'channel_service_scope_invalid' });
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_bindings').n, 0);
  const bound = await bindings.configure(actor, chat.id, input);
  assert.equal(bound.state, 'active'); assert.deepEqual(bound.reachable, [repo(101)]); assert.equal(bound.configured_by, 'maintainer');
  await assert.rejects(bindings.configure(actor, chat.id, input), { code: 'channel_revision_conflict' });
  const binding = h.store.get('SELECT * FROM channel_service_bindings'), principal = h.store.get('SELECT * FROM principals WHERE id=?', binding.principal_id);
  assert.equal(principal.kind, 'service'); assert.equal(principal.project_id, null);
  assert.deepEqual(h.store.all('SELECT project_id,grantor_id,capabilities FROM scoped_grants WHERE principal_id=?', binding.principal_id)
    .map(g => [g.project_id, g.grantor_id, JSON.parse(g.capabilities)]), [['101', 'maintainer', ['tasks.read', 'tasks.write']]]);
  // The binding principal never holds configuration, grant, knowledge or schedule authority, nor any project outside its scope.
  const scoped = resolvePrincipalActor(h.store, binding.principal_id, null, '101');
  for (const capability of ['config.write', 'grants.manage', 'knowledge.read', 'schedules.manage', 'roles.edit']) assert.throws(() => authorize(scoped, capability, { project_id: '101' }), { code: 'capability_forbidden' });
  assert.throws(() => authorize(resolvePrincipalActor(h.store, binding.principal_id, null, '201'), 'tasks.read', { project_id: '201' }), { code: 'capability_forbidden' });
  // Someone else may not disable it unless they hold config.write over its whole scope.
  const other = maintainer(f, 'other-maintainer', ['102'], 'ou_other');
  await assert.rejects(bindings.configure(other, chat.id, { enabled: false, expected_revision: 1 }), { code: 'channel_service_binding_forbidden' });
  // An organization binding needs organization-level config.write: a super administrator has it.
  const organization = await bindings.configure(resolvePrincipalActor(h.store, f.principal, null), chat.id, { ...input, scope: { kind: 'organization', organization: tenant }, expected_revision: 1 });
  assert.deepEqual(organization.reachable, [repo(101), repo(102)]); assert.equal(organization.scope.organization.id, tenant);
  assert.equal(h.store.get('SELECT count(*) n FROM scoped_grants WHERE principal_id=?', binding.principal_id).n, 1);
  assert.deepEqual(h.store.all("SELECT action FROM audit WHERE action LIKE 'channel.service_binding.%' ORDER BY created_at").map(a => a.action), ['channel.service_binding.configured', 'channel.service_binding.configured']);
  const listed = (await f.admin('/api/channels/service-bindings')).value;
  assert.equal(listed.bindings[0].scope.organization.name, 'agent-test-zone');
  assert.deepEqual(listed.service_roles.map(r => r.id), ['repository-assistant']); assert.equal(listed.service_roles[0].recommended, true);
  assert.ok(listed.organizations.some(o => o.id === tenant));
  // A legacy employee can no longer be enabled; disabling one stays possible.
  assert.equal((await f.admin('/api/channels/chats/' + chat.id + '/employee', 'PUT', { project_id: '101', role_id: 'reviewer', capabilities: ['tasks.read'], enabled: true, expected_revision: 0 })).value.error, 'channel_employee_retired');
});

test('an app without a member-reading scope refuses the binding with an actionable 4xx code; other Feishu rejections stay upstream failures', async t => {
  const f = await fixture(t), { h, chat } = f;
  // Feishu answers HTTP 400 code 99991672 when the app holds none of the scopes that can read a chat's members.
  f.wire.state.audience = () => Response.json({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:chat.members:read].' }, { status: 400 });
  const refused = await f.bind();
  assert.deepEqual([refused.status, refused.value], [403, { error: 'channel_audience_permission_required' }]);
  assert.equal(h.store.get('SELECT last_error FROM channel_audiences WHERE chat_id=?', chat.id).last_error, 'channel_audience_permission_required');
  f.wire.state.audience = () => Response.json({ code: 232011, msg: 'fixture rejection' }, { status: 400 });
  const rejected = await f.bind();
  assert.deepEqual([rejected.status, rejected.value], [502, { error: 'channel_delivery_rejected' }]);
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_bindings').n, 0);
  // Once the administrator grants the scope, the same save succeeds.
  f.wire.state.audience = null;
  const bound = await f.bind();
  assert.equal(bound.status, 200, JSON.stringify(bound.value)); assert.equal(bound.value.state, 'active');
});

test('other roles\' tasks follow the role permission: read lists progress, write pauses through the management service, revocation refuses the next call', async t => {
  const f = await fixture(t); assert.equal((await f.bind({ scope: { kind: 'repositories', repositories: ['101'] } })).status, 200);
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings');
  let script, tools;
  f.modelState.respond = async (body, res) => { tools = body.tools.map(tool => tool.function.name); return script(body, res, observations(body)); };
  // none: no task tools are offered, and a call to one is refused.
  script = (body, res, seen) => seen.length ? say(res, '无法查看任务。') : call(res, 'list_project_tasks', { repository: repo(101) });
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('blocked 任务进展如何？')))).state, 'completed');
  assert.ok(!tools.includes('list_project_tasks')); assert.equal(observations(f.requests.at(-1))[0].error, 'tool_not_allowed');
  // read: list and read progress, no write tool.
  await f.setRole({ permissions: { project_tasks: 'read' } });
  script = (body, res, seen) => !seen.length ? call(res, 'list_project_tasks', { repository: repo(101) }) : seen.length === 1 ? call(res, 'read_project_task', { repository: repo(101), task_id: 'blocked' }) : say(res, '任务在等待项目电脑。');
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('blocked 任务进展如何？')))).state, 'completed');
  assert.ok(tools.includes('list_project_tasks') && tools.includes('read_project_task') && !tools.includes('manage_project_task'));
  const [listed, detail] = observations(f.requests.at(-1));
  const task = listed.tasks.find(item => item.task_id === 'blocked'); assert.equal(task.status, 'waiting_environment'); assert.ok(task.revision);
  assert.ok(!listed.tasks.some(item => item.task_id === 'foreign'), 'another organization\'s task is not listed');
  assert.equal(detail.task.id, 'blocked'); assert.equal(detail.revision, task.revision);
  // write: pause through ManagementService, with the same receipt the console shows.
  await f.setRole({ permissions: { project_tasks: 'write' } });
  script = (body, res, seen) => !seen.length ? call(res, 'read_project_task', { repository: repo(101), task_id: 'blocked' })
    : seen.length === 1 ? call(res, 'manage_project_task', { repository: repo(101), task_id: 'blocked', operation: 'pause', expected_revision: seen[0].revision }) : say(res, '已暂停 blocked 任务。');
  const pause = await post(f.h, f.id, groupMessage('暂停 blocked 任务'));
  assert.equal((await done(f, pause)).state, 'completed');
  const receipt = observations(f.requests.at(-1))[1]; assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
  assert.equal(f.h.store.get("SELECT status FROM tasks WHERE id='blocked'").status, 'paused');
  const command = f.h.store.get('SELECT * FROM management_commands WHERE id=?', receipt.id);
  assert.equal(command.principal_id, binding.principal_id); assert.equal(command.channel, 'im'); assert.equal(command.source_conversation, f.chat.id);
  assert.equal(command.source_message, 'feishu:' + pause.value.operation_id);
  assert.equal((await f.admin('/api/management/commands/' + receipt.id)).value.state, 'succeeded');
  // The foreign task is out of scope even with write access.
  script = (body, res, seen) => !seen.length ? call(res, 'manage_project_task', { repository: repo(201), task_id: 'foreign', operation: 'cancel', expected_revision: 'x' }) : say(res, '不在范围内。');
  await done(f, await post(f.h, f.id, groupMessage('取消 foreign 任务')));
  assert.equal(observations(f.requests.at(-1))[0].error, 'repository_out_of_scope');
  // Revoking the permission while a turn runs ends that turn; its reply is never delivered.
  let release, started; const gate = new Promise(r => { release = r; }), seen = new Promise(r => { started = r; });
  script = async (body, res, observed) => { if (!observed.length) { started(); await gate; return call(res, 'list_project_tasks', { repository: repo(101) }); } return say(res, 'This late reply must be withheld'); };
  const slow = await post(f.h, f.id, groupMessage('列出任务')); await seen;
  await f.setRole({ permissions: { project_tasks: 'none' } }); release();
  const failed = await done(f, slow); assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'conversation_source_changed');
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('配置或来源消息刚刚变化')));
  assert.ok(!JSON.stringify(f.wire.sent).includes('This late reply must be withheld'));
  // Approval or a later resume cannot use a revoked permission either.
  assert.throws(() => f.service.serviceBindings.guardCommand(binding, command, f.h.store.secrets.open(f.h.store.get('SELECT payload FROM channel_inbox WHERE id=?', pause.value.operation_id).payload, 'channel-event:' + pause.value.operation_id)),
    { code: 'channel_service_permission_revoked' });
});

test('two groups on the same role keep separate scopes; a grantor losing a repository pauses only that repository', async t => {
  const f = await fixture(t), { h } = f;
  const second = groupMessage('Second group discussion', 'ou_alice', 'oc_group_2'); second.event.message.mentions = []; await post(h, f.id, second);
  const chat2 = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group_2'");
  const actor = maintainer(f, 'maintainer', ['101', '102'], 'ou_maintainer');
  await f.service.serviceBindings.configure(actor, f.chat.id, { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101', '102'] }, enabled: true, expected_revision: 0 });
  assert.equal((await f.bind({ scope: { kind: 'repositories', repositories: ['201'] } }, chat2.id)).status, 200);
  let target;
  f.modelState.respond = async (body, res) => { const seen = observations(body); return !seen.length ? call(res, 'list_projects', {}) : seen.length === 1 ? call(res, 'github_read', { repository: target, path: '/pulls' }) : say(res, 'done ' + target); };
  const ask = async (repository, chat) => { target = repository; const row = await done(f, await post(h, f.id, groupMessage('看看 PR', 'ou_bob', chat))); assert.equal(row.state, 'completed', row.error); return observations(f.requests.at(-1)); };
  let [projects, read] = await ask(repo(201), 'oc_group');
  assert.deepEqual(projects.projects.map(p => p.repository), [repo(101), repo(102)]); assert.equal(read.error, 'repository_out_of_scope');
  [projects, read] = await ask(repo(101), 'oc_group_2');
  assert.deepEqual(projects.projects.map(p => p.repository), [repo(201)]); assert.equal(read.error, 'repository_out_of_scope');
  [projects, read] = await ask(repo(201), 'oc_group_2'); assert.equal(read.result[0].number, 9);
  // Each group's replies are scoped to its own binding in the local ledger.
  await until(() => h.store.get("SELECT count(*) n FROM channel_message_scopes WHERE project_id LIKE 'binding:%'").n >= 3);
  const scopes = h.store.all('SELECT s.chat_id,s.project_id FROM channel_message_scopes s'), b1 = h.store.get('SELECT id FROM channel_service_bindings WHERE chat_id=?', f.chat.id).id;
  assert.ok(scopes.filter(s => s.chat_id === f.chat.id).every(s => s.project_id === 'binding:' + b1));
  // The maintainer loses 102: only 102 pauses in the first group, and the console says why.
  h.store.run("UPDATE scoped_grants SET revoked_at=? WHERE id='maintainer:102'", Date.now()); invalidate(h.store, 'maintainer', 'fixture_revocation');
  [projects, read] = await ask(repo(102), 'oc_group');
  assert.deepEqual(projects.projects.map(p => p.repository), [repo(101)]); assert.equal(projects.paused_repositories, 1); assert.equal(read.error, 'repository_out_of_scope');
  const view = (await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === f.chat.id);
  assert.equal(view.state, 'active'); assert.deepEqual(view.paused, [repo(102)]); assert.deepEqual(view.reachable, [repo(101)]);
  // Losing the last repository pauses the whole binding.
  h.store.run("UPDATE scoped_grants SET revoked_at=? WHERE id='maintainer:101'", Date.now()); invalidate(h.store, 'maintainer', 'fixture_revocation');
  assert.equal((await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === f.chat.id).state, 'paused');
});

test('legacy group employees migrate once to a repository assistant binding; their tasks keep the original authority', async t => {
  const f = await fixture(t), { h, chat } = f, admin = resolvePrincipalActor(h.store, f.principal, null, '101');
  roleApi(h.store, { id: f.principal, role: 'super_admin', repositories: [] }, 'PUT', new URL('http://local/api/repositories/101/roles'),
    { expected_revision: 0, enabled: false, roles: [{ role_id: 'reviewer', permissions: { task_management: 'write' } }] });
  const legacy = await f.service.employees.configure(admin, chat.id, { project_id: '101', role_id: 'reviewer', capabilities: ['tasks.read', 'tasks.manage_own'], participation: 'questions', enabled: true, expected_revision: 0 });
  const source = await post(h, f.id, groupMessage('A request handled before the upgrade'));
  const caller = f.service.employees.caller(chat.id, '101', source.value.operation_id);
  const created = new TaskCommands(h.store).tool(caller, 'create_task', { request: 'Report from before the upgrade', criteria: ['Keep the source'], execute: false });
  // Upgrade: the migration runs once at startup.
  h.store.run("DELETE FROM settings WHERE key='channel_service_bindings_migrated'");
  await h.stop(); await h.start();
  const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat.id);
  assert.equal(binding.service_role_id, 'repository-assistant'); assert.equal(binding.scope, 'repositories'); assert.equal(binding.participation, 'questions');
  assert.equal(binding.migrated_from, 'channel_employee'); assert.equal(binding.configured_by, f.principal);
  assert.deepEqual(h.store.all('SELECT project_id,grantor_id FROM scoped_grants WHERE principal_id=?', binding.principal_id).map(g => [g.project_id, g.grantor_id]), [['101', f.principal]]);
  assert.equal(h.store.get('SELECT enabled FROM channel_employee_grants WHERE id=?', legacy.id).enabled, 1);
  assertManagedExecution(h.store, h.store.get('SELECT * FROM tasks WHERE id=?', created.id));
  // New messages go to the binding, not the legacy employee.
  f.modelState.respond = async (body, res) => say(res, body.tools.some(tool => tool.function.name === 'list_projects') ? 'Served by the binding' : 'unexpected');
  const after = await post(h, f.id, groupMessage('Who answers now?'));
  assert.equal((await done(f, after)).state, 'completed');
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('Served by the binding')));
  assert.equal(h.store.get('SELECT count(*) n FROM role_conversation_turns').n, 0);
  await h.stop(); await h.start();
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_bindings').n, 1);
  const listed = (await f.admin('/api/channels/service-bindings')).value;
  assert.equal(listed.bindings[0].migrated, true); assert.equal(listed.legacy_employees[0].open_tasks, 1);
});

test('a disabled binding stops answering and history import; a bound service role cannot be deleted', async t => {
  const f = await fixture(t), { h, chat } = f;
  const custom = (await f.admin('/api/service-roles', 'POST', { name: '可信 committer 助手', model_id: f.assistantModel.id, permissions: { project_tasks: 'write' } })).value.service_role;
  assert.equal((await f.bind({ service_role_id: custom.id })).status, 200);
  assert.equal((await f.admin('/api/service-roles/' + custom.id, 'DELETE', { expected_revision: custom.revision })).value.error, 'service_role_in_use');
  // Disabling the role pauses the group with an explanation instead of switching roles.
  await f.setRole({ enabled: false }, custom.id);
  const paused = await post(h, f.id, groupMessage('还在吗？'));
  assert.equal((await done(f, paused)).state, 'failed');
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('可信 committer 助手」已停用')));
  await f.setRole({ enabled: true }, custom.id);
  const disabled = await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { enabled: false, expected_revision: 1 });
  assert.equal(disabled.value.state, 'disabled');
  const binding = h.store.get('SELECT * FROM channel_service_bindings');
  assert.equal(h.store.get('SELECT active FROM principals WHERE id=?', binding.principal_id).active, 0);
  assert.throws(() => f.service.syncGuard(h.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id)), { code: 'channel_service_binding_disabled' });
  const before = f.requests.length, unbound = await post(h, f.id, groupMessage('你好'));
  assert.equal((await done(f, unbound)).state, 'completed'); assert.equal(f.requests.length, before);
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('本群尚未绑定群聊助手')));
  const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === custom.id);
  assert.equal((await f.admin('/api/service-roles/' + custom.id, 'DELETE', { expected_revision: role.revision })).status, 200);
  assert.equal((await f.admin('/api/channels/service-bindings')).value.bindings[0].service_role.name, null);
});

const contract = { goal: '群聊卡片的“登录后台查看”链接可以点击', scope: ['static/channels.js'], criteria: ['链接在桌面和手机上都能打开'], endpoint: '合入修复 PR' };
test('delegation hands work to a project only through its Manager: create, change and cancel tasks, never steer a role; results return to the group', async t => {
  const f = await fixture(t); assert.equal((await f.bind({ scope: { kind: 'repositories', repositories: ['101'] } })).status, 200);
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings');
  let script, tools, system;
  f.modelState.respond = async (body, res) => { tools = body.tools.map(tool => tool.function.name); system = body.messages[0].content; return script(body, res, observations(body)); };
  // deny (the repository assistant's default): no task tools, and the prompt says so.
  script = (body, res, seen) => seen.length ? say(res, '不能派活。') : call(res, 'create_project_task', { repository: repo(101), request: '修复卡片链接', contract });
  await done(f, await post(f.h, f.id, groupMessage('帮忙建个任务修复卡片链接')));
  assert.ok(!tools.includes('create_project_task')); assert.equal(observations(f.requests.at(-1))[0].error, 'tool_not_allowed');
  assert.match(system, /cannot create, delegate or assign work/);
  // allow: a new task goes to the project team through the management service, as the binding principal.
  await f.setRole({ permissions: { conversation_history: 'read', github: 'read', project_tasks: 'none', delegation: 'allow' } });
  const before = f.h.store.get('SELECT count(*) n FROM tasks').n;
  script = (body, res, seen) => seen.length ? say(res, '已交给 Manager。') : call(res, 'create_project_task', { repository: repo(101), request: '修复群聊卡片链接无法点击的问题', contract });
  const created = await post(f.h, f.id, groupMessage('帮忙建个任务修复卡片链接'));
  assert.equal((await done(f, created)).state, 'completed');
  for (const name of ['create_project_task', 'list_project_tasks', 'read_project_task', 'manage_project_task', 'start_own_task']) assert.ok(tools.includes(name), name);
  for (const name of ['delegate_role', 'delegate_roles', 'create_task']) assert.ok(!tools.includes(name), name);
  assert.match(system, /only through its Manager/); assert.match(system, /never choose which role executes/);
  const receipt = observations(f.requests.at(-1))[0];
  assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt)); assert.equal(receipt.repository, repo(101));
  assert.equal(f.h.store.get('SELECT count(*) n FROM tasks').n, before + 1);
  const command = f.h.store.get('SELECT * FROM management_commands WHERE id=?', receipt.id), task = f.h.store.get('SELECT * FROM tasks WHERE id=?', receipt.result.id);
  assert.equal(command.operation, 'task.create'); assert.equal(command.principal_id, binding.principal_id); assert.equal(command.channel, 'im');
  assert.equal(command.source_message, 'feishu:' + created.value.operation_id);
  assert.equal(task.repository_id, '101');
  // No executor was chosen: the task is the project's own work, linked back to this group.
  assert.equal(f.h.store.get('SELECT source_kind FROM task_origins WHERE task_id=?', task.id).source_kind, 'operator');
  assert.ok(!f.h.store.get('SELECT executor_role FROM task_origins WHERE task_id=?', task.id).executor_role);
  assert.deepEqual({ ...f.h.store.get('SELECT binding_id,chat_id,source_message FROM channel_service_tasks WHERE task_id=?', task.id) },
    { binding_id: binding.id, chat_id: f.chat.id, source_message: created.value.operation_id });
  // Change the task as a whole: an instruction and a new contract are allowed; pausing needs project_tasks write.
  script = (body, res, seen) => !seen.length ? call(res, 'read_project_task', { repository: repo(101), task_id: task.id })
    : seen.length === 1 ? call(res, 'manage_project_task', { repository: repo(101), task_id: task.id, operation: 'instructions', instruction: '优先修手机端', expected_revision: seen[0].revision })
    : seen.length === 2 ? call(res, 'manage_project_task', { repository: repo(101), task_id: task.id, operation: 'pause', expected_revision: seen[0].revision }) : say(res, '已补充说明。');
  await done(f, await post(f.h, f.id, groupMessage('补充：优先修手机端，然后先暂停')));
  const [, instruction, pause] = observations(f.requests.at(-1));
  assert.equal(instruction.state, 'succeeded', JSON.stringify(instruction)); assert.equal(instruction.operation, 'task.instructions');
  assert.equal(pause.error, 'operation_not_allowed'); assert.notEqual(f.h.store.get('SELECT status FROM tasks WHERE id=?', task.id).status, 'paused');
  script = (body, res, seen) => !seen.length ? call(res, 'read_project_task', { repository: repo(101), task_id: task.id })
    : seen.length === 1 ? call(res, 'manage_project_task', { repository: repo(101), task_id: task.id, operation: 'contract', contract: { ...contract, criteria: ['链接在桌面和手机上都能打开', '有回归测试'] }, expected_revision: seen[0].revision })
    : seen.length === 2 ? call(res, 'read_project_task', { repository: repo(101), task_id: task.id })
    : seen.length === 3 ? call(res, 'manage_project_task', { repository: repo(101), task_id: task.id, operation: 'cancel', expected_revision: seen[2].revision })
    : say(res, '已修改验收条件并取消。');
  await done(f, await post(f.h, f.id, groupMessage('加上回归测试的要求，然后取消吧')));
  const [, changed, , cancelled] = observations(f.requests.at(-1));
  assert.equal(changed.state, 'succeeded', JSON.stringify(changed)); assert.equal(changed.operation, 'task.contract');
  assert.equal(cancelled.state, 'succeeded', JSON.stringify(cancelled)); assert.equal(cancelled.operation, 'task.cancel');
  assert.equal(f.h.store.get('SELECT status FROM tasks WHERE id=?', task.id).status, 'cancelled');
  // The finished task reports back to the group that created it, and that report joins only this binding's context.
  const report = await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('已取消') && JSON.stringify(s.content).includes(repo(101))));
  assert.match(JSON.stringify(report.content), /修复群聊卡片链接|卡片/);
  // The local Feishu fixture names each sent message remote-<position>; read the scope of this report, not of earlier replies.
  const remote = 'remote-' + (f.wire.sent.indexOf(report) + 1);
  const scoped = await until(() => f.h.store.get('SELECT * FROM channel_message_scopes WHERE chat_id=? AND message_id=?', f.chat.id, remote));
  assert.equal(scoped.project_id, 'binding:' + binding.id); assert.equal(scoped.fence, f.service.serviceBindings.fence(f.chat.id));
  // A group without delegation can no longer create or resume the work it delegated, and its tasks stop at the next source check.
  const event = f.h.store.secrets.open(f.h.store.get('SELECT payload FROM channel_inbox WHERE id=?', created.value.operation_id).payload, 'channel-event:' + created.value.operation_id);
  f.service.serviceBindings.guardCommand(binding, command, event);
  assert.doesNotThrow(() => assertManagedExecution(f.h.store, f.h.store.get('SELECT * FROM tasks WHERE id=?', task.id)));
  await f.setRole({ permissions: { conversation_history: 'read', github: 'read', project_tasks: 'write', delegation: 'deny' } });
  assert.throws(() => f.service.serviceBindings.guardCommand(binding, command, event), { code: 'channel_service_permission_revoked' });
  assert.throws(() => assertManagedExecution(f.h.store, f.h.store.get('SELECT * FROM tasks WHERE id=?', task.id)), { code: 'channel_service_delegation_revoked' });
});

test('a group assistant works a side question in its own task with the same tools; only the conclusion returns and a changed scope hides it', async t => {
  const f = await fixture(t); assert.equal((await f.bind({ scope: { kind: 'repositories', repositories: ['101'] } })).status, 200);
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings');
  const own = body => body.messages[0].content.includes('one of your own independent tasks');
  const ownBodies = [];
  let main;
  f.modelState.respond = async (body, res) => {
    const seen = observations(body);
    if (own(body)) {
      ownBodies.push(body);
      return seen.length ? say(res, 'admin-fixture-101 有 1 个未关闭的 PR：#7 Bind group assistants。') : call(res, 'github_read', { repository: repo(101), path: '/pulls?state=open' });
    }
    return main(body, res, seen);
  };
  main = (body, res, seen) => !seen.length ? call(res, 'start_own_task', { title: '整理未关闭的 PR', instruction: '列出 bot 仓库未关闭的 PR' }) : say(res, '整理好了：' + seen[0].conclusion);
  const roleRequests = () => f.h.store.get("SELECT count(*) n FROM model_requests WHERE service_role_id='repository-assistant' AND repository_id IS NULL").n;
  const billed = roleRequests();
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('有哪些未关闭的 PR？')))).state, 'completed');
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('整理好了') && JSON.stringify(s.content).includes('#7')));
  // The own task had the turn's tools minus its own-task tools, and a context of its own.
  const inner = ownBodies[0];
  assert.ok(inner.tools.some(t => t.function.name === 'github_read'));
  assert.ok(!inner.tools.some(t => ['start_own_task', 'continue_own_task', 'list_own_tasks'].includes(t.function.name)));
  assert.equal(JSON.parse(inner.messages[1].content).instruction, '列出 bot 仓库未关闭的 PR');
  const row = f.h.store.get('SELECT * FROM service_role_own_tasks');
  assert.equal(row.owner_kind, 'channel'); assert.equal(row.owner_id, binding.id); assert.equal(row.principal_id, binding.principal_id);
  assert.equal(row.state, 'completed'); assert.equal(row.rounds, 1); assert.ok(!row.history.includes('#7'), 'history is sealed');
  // Billed to the service role like the turn itself: main turn requests plus the own task's two.
  assert.ok(roleRequests() >= billed + 4);
  // Continue it later: it sees its earlier round; listing shows the latest conclusion.
  main = (body, res, seen) => !seen.length ? call(res, 'list_own_tasks', {}) : seen.length === 1 ? call(res, 'continue_own_task', { task_id: seen[0].own_tasks[0].task_id, instruction: '再看看有没有草稿 PR' })
    : say(res, '补充：' + seen[1].conclusion);
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('再看看有没有草稿？')))).state, 'completed');
  const [listed, continued] = observations(f.requests.at(-1));
  assert.equal(listed.own_tasks[0].title, '整理未关闭的 PR'); assert.match(listed.own_tasks[0].last_conclusion, /#7/);
  assert.equal(continued.round, 2);
  const second = ownBodies.at(-1);
  assert.match(JSON.parse(second.messages[1].content).own_task.previous_rounds[0].conclusion, /#7/);
  assert.equal(f.h.store.get('SELECT rounds FROM service_role_own_tasks').rounds, 2);
  // A changed role permission changes the group's fence: the old own task is no longer visible or continuable.
  await f.setRole({ permissions: { conversation_history: 'read', github: 'read', project_tasks: 'read', delegation: 'deny' } });
  main = (body, res, seen) => !seen.length ? call(res, 'list_own_tasks', {}) : seen.length === 1 ? call(res, 'continue_own_task', { task_id: row.id, instruction: '继续' }) : say(res, '没有可继续的独立任务。');
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('继续刚才的独立任务')))).state, 'completed');
  const [hidden, refused] = observations(f.requests.at(-1));
  assert.deepEqual(hidden.own_tasks, []); assert.equal(refused.error, 'own_task_not_found');
});
