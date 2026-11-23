import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { channelFixture, envelope, inGroup, post, until, bindFixture, shareAssistantModel } from '../../../fixtures/channel-fixture.mjs';
import { repository } from '../../../fixtures/helpers.mjs';
import { knowledgeActor } from '../../../fixtures/knowledge-fixture.mjs';
import { authorize, invalidate, resolvePrincipalActor, revision } from '../../../../dist/identity/authorization.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { serviceMemory } from '../../../../dist/service-roles/resources.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { assertManagedExecution } from '../../../../dist/tasks/management.js';
import { serviceRole } from '../../../../dist/service-roles/roles.js';
import { digest } from '../../../../dist/core/security.js';
import { ChannelServiceBindings } from '../../../../dist/channels/service-bindings.js';
import { serviceRolesApi } from '../../../../dist/service-roles/api.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';

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
      permissions: { contents: 'read', issues: 'write', pull_requests: 'read', actions: 'write', checks: 'read', statuses: 'read', metadata: 'read' } });
    if (path === '/app/installations/55/access_tokens') return send({ token: 'fixture-read-token-' + state.requests.length, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: body.permissions }, 201);
    const issuePath = '/repos/agent-test-zone/admin-fixture-101/issues/12';
    if (path === issuePath && req.method === 'GET') return send({ number: 12, user: { login: 'outside-author' }, state: 'open' });
    if (req.method === 'POST' && [issuePath + '/labels', issuePath + '/assignees'].includes(path)) return send(body);
    if (path === '/installation/token') return send({});
    if ((match = /^\/repositories\/(\d+)$/.exec(path))) return send({ id: Number(match[1]), full_name: 'agent-test-zone/admin-fixture-' + match[1], owner: { id: match[1] === '201' ? 20 : 10 }, default_branch: 'main' });
    if ((match = /^\/repos\/agent-test-zone\/(admin-fixture-\d+)\/pulls$/.exec(path))) return send(state.pulls[match[1]] ?? []);
    if ((match = /^\/repos\/agent-test-zone\/(admin-fixture-\d+)\/issues$/.exec(path)) && req.method === 'POST') return send({ id: 4400, number: 44, title: body.title, body: body.body, state: 'open', html_url: `https://github.com/agent-test-zone/${match[1]}/issues/44` }, 201);
    if ((match = /^\/repos\/agent-test-zone\/(admin-fixture-\d+)\/actions\/workflows\/nightly\.yml\/dispatches$/.exec(path)) && req.method === 'POST')
      return send({ workflow_run_id: 9001, run_url: `https://api.github.com/repos/agent-test-zone/${match[1]}/actions/runs/9001`, html_url: `https://github.com/agent-test-zone/${match[1]}/actions/runs/9001` });
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
  await shareAssistantModel(f);
  const discovery = groupMessage('Group discussion before binding', 'ou_alice'); discovery.event.message.mentions = []; await post(h, f.id, discovery);
  const chat = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
  const bind = (input = {}, chatId = chat.id) => f.admin('/api/channels/chats/' + chatId + '/service-binding', 'PUT', {
    model_id: f.assistantModel.id,
    scope: { kind: 'repositories', repositories: ['101', '102'] }, participation: 'mentions', enabled: true, expected_revision: 0, ...input });
  /** Change what the group may do (#849, #1249): a level name, or individual items as the advanced editor sends them. */
  const setLevel = async (value, chatId = chat.id) => {
    const current = (await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === chatId);
    const scope = current.scope.organization ? { kind: 'organization', organization: current.scope.organization.id } : { kind: 'repositories', repositories: current.scope.repositories.map(r => r.id) };
    const result = await f.admin('/api/channels/chats/' + chatId + '/service-binding', 'PUT', { scope, participation: current.participation,
      enabled: true, expected_revision: current.revision, ...(typeof value === 'string' ? { level: value } : { permissions: value }) });
    assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value;
  };
  return { ...f, gh, chat, bind, setLevel };
}
/** A platform user with config.write (and task access) on the given projects, resolved without a session tenant. */
function maintainer(f, name, projects, open_id) {
  for (const project of projects) knowledgeActor(f.h.store, name, project, ['config.write', 'tasks.read', 'tasks.write']);
  if (open_id) { bindFixture(f.h, f.id, name, open_id); f.wire.state.members.push({ member_id_type: 'open_id', member_id: open_id, tenant_key: 'actor-tenant' }); }
  return resolvePrincipalActor(f.h.store, name, null);
}

/** A platform user with config.write over a whole organization (an organization admin), outside every group. */
function organizationAdmin(f, name, tenant = 'github.com:10') {
  f.h.store.run("INSERT OR IGNORE INTO users(id,username,password_hash,role) VALUES(?,?,?,'project_admin')", name, name, 'fixture-unused-password');
  f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at)
    VALUES(?,?,?,NULL,'tenant','org_admin',?,'explicit_delegation','fixture','explicit fixture grant',0)`, name + ':org', name, tenant, JSON.stringify(['config.write', 'tasks.read', 'tasks.write']));
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
  assert.equal(answer.msg_type, 'post', 'a group answer is native rich text');
  assert.ok(!JSON.stringify(answer.content).includes('登录后台查看'));
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
  // Billing: every request belongs to the group assistant and this conversation, none to a project when spanning multiple repos; the speaker never needed a binding.
  const requests = f.h.store.all('SELECT * FROM model_requests WHERE conversation_id=?', f.chat.id);
  assert.equal(requests.length, 5); assert.ok(requests.every(r => r.repository_id === null && r.service_role_id === 'group-assistant' && r.task_id === null));
  assert.equal(f.h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_bob'").n, 0);
  assert.equal(f.h.store.get('SELECT count(*) n FROM tasks').n, baseline);
  const view = (await f.admin('/api/channels/chats/' + f.chat.id + '/conversation')).value;
  assert.equal(view.mode, 'service'); assert.equal(view.turns[0].role_id, '群聊助手'); assert.match(view.turns[0].reply, /#7/); assert.equal(view.usage.requests, 5);
  const bindingView = (await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === f.chat.id);
  assert.equal(bindingView.usage.requests, 5);
  // A repeated delivery of the same event is deduplicated: no second model turn.
  assert.equal((await post(f.h, f.id, message)).value.duplicate, true);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns').n, 1); assert.equal(f.requests.length, 5);
});

test('binding needs a Feishu-bound maintainer in the group with config.write over every repository or the organization', async t => {
  const f = await fixture(t), { h, chat } = f, bindings = f.service.serviceBindings;
  const input = { model_id: f.assistantModel.id, scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: 0 };
  await assert.rejects(bindings.configure(maintainer(f, 'unbound-maintainer', ['101']), chat.id, input), { code: 'external_binding_required' });
  knowledgeActor(h.store, 'reader', '101', ['tasks.read']); bindFixture(h, f.id, 'reader', 'ou_bob');
  await assert.rejects(bindings.configure(resolvePrincipalActor(h.store, 'reader', null), chat.id, input), { code: 'capability_forbidden' });
  const outsider = maintainer(f, 'outsider', ['101']); bindFixture(h, f.id, 'outsider', 'ou_outsider');
  await assert.rejects(bindings.configure(outsider, chat.id, input), { code: 'channel_employee_member_required' });
  const actor = maintainer(f, 'maintainer', ['101'], 'ou_maintainer'), tenant = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, scope: { kind: 'repositories', repositories: ['101', '201'] } }), { code: 'capability_forbidden' });
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, scope: { kind: 'organization', organization: tenant } }), { code: 'capability_forbidden' });
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, harness: 'container_acp' }), { code: 'unknown_role_harness' });
  await assert.rejects(bindings.configure(actor, chat.id, { ...input, scope: { kind: 'repositories', repositories: [] } }), { code: 'channel_service_scope_invalid' });
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_bindings').n, 0);
  const bound = await bindings.configure(actor, chat.id, input);
  assert.equal(bound.state, 'active'); assert.deepEqual(bound.reachable, [repo(101)]); assert.equal(bound.configured_by, 'maintainer');
  await assert.rejects(bindings.configure(actor, chat.id, input), { code: 'channel_revision_conflict' });
  const binding = h.store.get('SELECT * FROM channel_service_bindings'), principal = h.store.get('SELECT * FROM principals WHERE id=?', binding.principal_id);
  assert.equal(principal.kind, 'service'); assert.equal(principal.project_id, null);
  assert.deepEqual(h.store.all('SELECT project_id,grantor_id,capabilities FROM scoped_grants WHERE principal_id=?', binding.principal_id)
    .map(g => [g.project_id, g.grantor_id, JSON.parse(g.capabilities)]), [['101', 'maintainer', ['tasks.read', 'knowledge.read']]]);
  // The binding principal never holds configuration, grant, knowledge write or schedule authority, nor any project outside its scope.
  const scoped = resolvePrincipalActor(h.store, binding.principal_id, null, '101');
  for (const capability of ['config.write', 'grants.manage', 'knowledge.write', 'schedules.manage', 'roles.edit']) assert.throws(() => authorize(scoped, capability, { project_id: '101' }), { code: 'capability_forbidden' });
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
  assert.ok(listed.models.some(m => m.id === f.assistantModel.id));
  assert.ok(typeof listed.default_prompt === 'string' && listed.default_prompt.length > 0);
  assert.ok(listed.organizations.some(o => o.id === tenant));
  // A legacy employee can no longer be enabled; disabling one stays possible.
  assert.equal((await f.admin('/api/channels/chats/' + chat.id + '/employee', 'PUT', { project_id: '101', role_id: 'reviewer', capabilities: ['tasks.read'], enabled: true, expected_revision: 0 })).value.error, 'channel_employee_retired');
});

test('a group binding has an owner: other repository admins in the group cannot take it over; owner, organization and platform administrators change it; ownership transfers (#424)', async t => {
  const f = await fixture(t), { h, chat } = f, bindings = f.service.serviceBindings;
  const input = (revision, repositories = ['101'], extra = {}) => ({ model_id: f.assistantModel.id, scope: { kind: 'repositories', repositories }, enabled: true, expected_revision: revision, ...extra });
  const state = () => ({ ...h.store.get('SELECT owner_id,configured_by,revision,participation,enabled FROM channel_service_bindings WHERE chat_id=?', chat.id) });
  const owner = maintainer(f, 'owner', ['101'], 'ou_owner');
  const bound = await bindings.configure(owner, chat.id, input(0));
  assert.deepEqual([bound.owner, bound.configured_by], ['owner', 'owner']);
  // Admins of another repository, or of the same one, in the group: no re-scope, change, disable or transfer.
  const intruder = maintainer(f, 'intruder', ['102'], 'ou_intruder'), peer = maintainer(f, 'peer', ['101'], 'ou_peer');
  for (const [actor, repositories] of [[intruder, ['102']], [peer, ['101']]]) {
    await assert.rejects(bindings.configure(actor, chat.id, input(1, repositories, { participation: 'all' })), { code: 'channel_service_binding_forbidden' });
    await assert.rejects(bindings.configure(actor, chat.id, { enabled: false, expected_revision: 1 }), { code: 'channel_service_binding_forbidden' });
    assert.throws(() => bindings.transfer(actor, chat.id, { owner_id: actor.principal_id, expected_revision: 1 }), { code: 'channel_service_binding_forbidden' });
  }
  assert.deepEqual(state(), { owner_id: 'owner', configured_by: 'owner', revision: 1, participation: 'mentions', enabled: 1 });
  const spoken = groupMessage('Just chatting', 'ou_intruder'); spoken.event.message.mentions = []; await post(h, f.id, spoken);
  const intruderView = (await bindings.list(intruder)).bindings.find(b => b.chat_id === chat.id);
  assert.deepEqual([intruderView.can_manage, intruderView.can_view, intruderView.can_transfer, intruderView.owner_candidates], [false, false, false, undefined]);
  const peerSpoken = groupMessage('Checking repo 101', 'ou_peer'); peerSpoken.event.message.mentions = []; await post(h, f.id, peerSpoken);
  const peerView = (await bindings.list(peer)).bindings.find(b => b.chat_id === chat.id);
  assert.deepEqual([peerView.can_manage, peerView.can_view, peerView.can_transfer], [false, true, false]);
  // The owner edits from inside the group, never beyond their own repositories.
  await assert.rejects(bindings.configure(owner, chat.id, input(1, ['101', '102'])), { code: 'capability_forbidden' });
  assert.equal((await bindings.configure(owner, chat.id, input(1, ['101'], { participation: 'questions' }))).participation, 'questions');
  // An organization admin changes it from outside the group; the owner stays.
  const org = organizationAdmin(f, 'org-admin');
  const widened = await bindings.configure(org, chat.id, input(2, ['101', '102']));
  assert.deepEqual([widened.owner, widened.configured_by, widened.reachable], ['owner', 'org-admin', [repo(101), repo(102)]]);
  // Ownership goes from an administrator to someone who could configure the whole current scope; the revision stays.
  const both = maintainer(f, 'both', ['101', '102'], 'ou_both');
  const listed = (await bindings.list(org)).bindings.find(b => b.chat_id === chat.id);
  assert.deepEqual([listed.can_manage, listed.can_transfer], [true, true]);
  const candidates = listed.owner_candidates.map(c => c.username);
  assert.ok(candidates.includes('both') && candidates.includes('org-admin')); assert.ok(!['owner', 'peer', 'intruder'].some(name => candidates.includes(name)));
  assert.throws(() => bindings.transfer(owner, chat.id, { owner_id: 'both', expected_revision: 3 }), { code: 'channel_service_binding_forbidden' });
  assert.throws(() => bindings.transfer(org, chat.id, { owner_id: 'peer', expected_revision: 3 }), { code: 'channel_service_owner_ineligible' });
  assert.throws(() => bindings.transfer(org, chat.id, { owner_id: 'both', expected_revision: 2 }), { code: 'channel_revision_conflict' });
  const transferred = bindings.transfer(org, chat.id, { owner_id: 'both', expected_revision: 3 });
  assert.deepEqual([transferred.owner, transferred.revision], ['both', 3]);
  assert.equal((await f.admin('/api/channels/chats/' + chat.id + '/service-binding/owner', 'PUT', { owner_id: 'owner', expected_revision: 3 })).value.error, 'channel_service_owner_ineligible');
  await assert.rejects(bindings.configure(owner, chat.id, input(3)), { code: 'channel_service_binding_forbidden' });
  // An organization admin governs only bindings inside their organizations; a platform administrator governs every one.
  const platform = resolvePrincipalActor(h.store, f.principal, null);
  assert.equal((await bindings.configure(platform, chat.id, input(3, ['101', '201']))).owner, 'both');
  await assert.rejects(bindings.configure(org, chat.id, input(4)), { code: 'channel_service_binding_forbidden' });
  // A disabled binding keeps its owner: only the owner and its governors enable it again.
  assert.equal((await bindings.configure(platform, chat.id, { enabled: false, expected_revision: 4 })).state, 'disabled');
  await assert.rejects(bindings.configure(intruder, chat.id, input(5, ['102'])), { code: 'channel_service_binding_forbidden' });
  const restored = await bindings.configure(both, chat.id, input(5, ['101', '102']));
  assert.deepEqual([restored.state, restored.owner, restored.configured_by], ['active', 'both', 'both']);
  // Bindings from before owners existed are owned by their configurer.
  h.store.run("UPDATE channel_service_bindings SET owner_id=''");
  await h.stop(); await h.start();
  assert.equal(state().owner_id, 'both');
});

test('a group reached through an organization app can only be scoped to that organization (#424)', async t => {
  const f = await fixture(t), { h } = f;
  h.store.run("UPDATE channel_connectors SET owner_tenant='github.com:10' WHERE id=?", f.id);
  for (const scope of [{ kind: 'repositories', repositories: ['101', '201'] }, { kind: 'organization', organization: 'github.com:20' }])
    assert.equal((await f.bind({ scope })).value.error, 'channel_service_scope_outside_organization');
  assert.equal(h.store.get('SELECT count(*) n FROM channel_service_bindings').n, 0);
  const bound = await f.bind({ scope: { kind: 'organization', organization: 'github.com:10' } });
  assert.equal(bound.status, 200, JSON.stringify(bound.value)); assert.equal(bound.value.chat.organization, 'github.com:10');
  const listed = (await f.admin('/api/channels/service-bindings')).value;
  assert.deepEqual(listed.chats.map(c => c.organization), ['github.com:10']);
  assert.deepEqual(listed.projects.map(p => [p.id, p.organization]), [['101', 'github.com:10'], ['102', 'github.com:10'], ['201', 'github.com:20']]);
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

test('other roles\' tasks follow the binding\'s items: read lists progress, write pauses through the management service, revocation refuses the next call', async t => {
  const f = await fixture(t); assert.equal((await f.bind({ scope: { kind: 'repositories', repositories: ['101'] } })).status, 200);
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings');
  let script, tools;
  f.modelState.respond = async (body, res) => { tools = body.tools.map(tool => tool.function.name); return script(body, res, observations(body)); };
  // none: no task tools are offered, and a call to one is refused.
  script = (body, res, seen) => seen.length ? say(res, '无法查看任务。') : call(res, 'list_project_tasks', { repository: repo(101) });
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('blocked 任务进展如何？')))).state, 'completed');
  assert.ok(!tools.includes('list_project_tasks')); assert.equal(observations(f.requests.at(-1))[0].error, 'tool_not_allowed');
  // read: list and read progress, no write tool.
  await f.setLevel({ project_tasks: 'read' });
  script = (body, res, seen) => !seen.length ? call(res, 'list_project_tasks', { repository: repo(101) }) : seen.length === 1 ? call(res, 'read_project_task', { repository: repo(101), task_id: 'blocked' }) : say(res, '任务在等待项目电脑。');
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('blocked 任务进展如何？')))).state, 'completed');
  assert.ok(tools.includes('list_project_tasks') && tools.includes('read_project_task') && !tools.includes('create_project_task') && !tools.includes('manage_project_task'));
  const [listed, detail] = observations(f.requests.at(-1));
  const task = listed.tasks.find(item => item.task_id === 'blocked'); assert.equal(task.status, 'waiting_environment'); assert.ok(task.revision);
  assert.ok(!listed.tasks.some(item => item.task_id === 'foreign'), 'another organization\'s task is not listed');
  assert.equal(detail.task.id, 'blocked'); assert.equal(detail.revision, task.revision);
  // write: pause through ManagementService, with the same receipt the console shows.
  await f.setLevel({ project_tasks: 'write' });
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
  await f.setLevel({ project_tasks: 'none' }); release();
  const failed = await done(f, slow); assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'conversation_source_changed');
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('配置或来源消息刚刚变化')));
  assert.ok(!JSON.stringify(f.wire.sent).includes('This late reply must be withheld'));
  // Approval or a later resume cannot use a revoked permission either: it is checked against the binding as it is now.
  assert.throws(() => f.service.serviceBindings.guardCommand(f.h.store.get('SELECT * FROM channel_service_bindings'), command, f.h.store.secrets.open(f.h.store.get('SELECT payload FROM channel_inbox WHERE id=?', pause.value.operation_id).payload, 'channel-event:' + pause.value.operation_id)),
    { code: 'channel_service_permission_revoked' });
});

test('two groups on the same role keep separate scopes; a grantor losing a repository pauses only that repository', async t => {
  const f = await fixture(t), { h } = f;
  const second = groupMessage('Second group discussion', 'ou_alice', 'oc_group_2'); second.event.message.mentions = []; await post(h, f.id, second);
  const chat2 = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group_2'");
  const actor = maintainer(f, 'maintainer', ['101', '102'], 'ou_maintainer');
  await f.service.serviceBindings.configure(actor, f.chat.id, { model_id: f.assistantModel.id, scope: { kind: 'repositories', repositories: ['101', '102'] }, enabled: true, expected_revision: 0 });
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
  // Upgrade: the migration runs once at startup, adopting the deployment default shared model when configured.
  assert.equal((await f.admin('/api/onboarding/model', 'POST', { model_id: f.assistantModel.id })).status, 201);
  h.store.run("DELETE FROM settings WHERE key='channel_service_bindings_migrated'");
  await h.stop(); await h.start();
  const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat.id);
  assert.equal(binding.service_role_id, 'group-assistant'); assert.equal(binding.scope, 'repositories'); assert.equal(binding.participation, 'questions');
  assert.equal(binding.model_id, f.assistantModel.id); assert.ok(binding.prompt.length > 0);
  assert.equal(binding.migrated_from, 'channel_employee'); assert.equal(binding.configured_by, f.principal); assert.equal(binding.owner_id, f.principal);
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

test('a disabled binding stops answering and history import; a binding without a model stops without borrowing another (#1249)', async t => {
  const f = await fixture(t), { h, chat } = f;
  assert.equal((await f.bind({ model_id: null })).status, 200);
  const noModel = await post(h, f.id, groupMessage('还在吗？'));
  const failed = await done(f, noModel);
  assert.deepEqual([failed.state, failed.error], ['failed', 'channel_service_model_not_configured']);
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('尚未配置模型') && JSON.stringify(s.content).includes('个人设置 → 飞书绑定')));
  const disabled = await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { enabled: false, expected_revision: 1 });
  assert.equal(disabled.value.state, 'disabled');
  const binding = h.store.get('SELECT * FROM channel_service_bindings');
  assert.equal(h.store.get('SELECT active FROM principals WHERE id=?', binding.principal_id).active, 0);
  assert.throws(() => f.service.syncGuard(h.store.get('SELECT * FROM channel_chats WHERE id=?', chat.id)), { code: 'channel_service_binding_disabled' });
  const before = f.requests.length, unbound = await post(h, f.id, groupMessage('你好'));
  assert.equal((await done(f, unbound)).state, 'completed'); assert.equal(f.requests.length, before);
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('本群尚未绑定群聊助手') && JSON.stringify(s.content).includes('个人设置 → 飞书绑定')));
});

const contract = { goal: '群聊卡片的“登录后台查看”链接可以点击', scope: ['static/channels.js'], criteria: ['链接在桌面和手机上都能打开'], endpoint: '合入修复 PR' };
test('the dispatch level hands work to a project only through its Manager: create, change and cancel tasks, never steer a role; results return to the group', async t => {
  const f = await fixture(t); assert.equal((await f.bind({ scope: { kind: 'repositories', repositories: ['101'] } })).status, 200);
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings');
  let script, tools, system;
  f.modelState.respond = async (body, res) => { tools = body.tools.map(tool => tool.function.name); system = body.messages[0].content; return script(body, res, observations(body)); };
  // read (a new binding's level): no task tools, and the prompt says so.
  script = (body, res, seen) => seen.length ? say(res, '不能派活。') : call(res, 'create_project_task', { repository: repo(101), request: '修复卡片链接', contract });
  await done(f, await post(f.h, f.id, groupMessage('帮忙建个任务修复卡片链接')));
  assert.ok(!tools.includes('create_project_task')); assert.equal(observations(f.requests.at(-1))[0].error, 'tool_not_allowed');
  assert.match(system, /cannot create, delegate or assign work/);
  // dispatch: a new task goes to the project team through the management service, as the binding principal.
  assert.equal((await f.setLevel('dispatch')).level, 'dispatch');
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
  // A dispatch group can add an instruction and cancel this task, but only write can change its contract.
  script = (body, res, seen) => !seen.length ? call(res, 'read_project_task', { repository: repo(101), task_id: task.id })
    : seen.length === 1 ? call(res, 'manage_project_task', { repository: repo(101), task_id: task.id, operation: 'instructions', instruction: '优先修手机端', expected_revision: seen[0].revision }) : say(res, '已补充说明。');
  await done(f, await post(f.h, f.id, groupMessage('补充：优先修手机端')));
  const [, instruction] = observations(f.requests.at(-1));
  assert.equal(instruction.state, 'succeeded', JSON.stringify(instruction)); assert.equal(instruction.operation, 'task.instructions');
  script = (body, res, seen) => !seen.length ? call(res, 'read_project_task', { repository: repo(101), task_id: task.id })
    : seen.length === 1 ? call(res, 'manage_project_task', { repository: repo(101), task_id: task.id, operation: 'contract', contract: { ...contract, criteria: ['链接在桌面和手机上都能打开', '有回归测试'] }, expected_revision: seen[0].revision })
    : seen.length === 2 ? call(res, 'read_project_task', { repository: repo(101), task_id: task.id })
    : seen.length === 3 ? call(res, 'manage_project_task', { repository: repo(101), task_id: task.id, operation: 'cancel', expected_revision: seen[2].revision })
    : say(res, '已取消。');
  await done(f, await post(f.h, f.id, groupMessage('加上回归测试的要求，然后取消吧')));
  const [, changed, , cancelled] = observations(f.requests.at(-1));
  assert.equal(changed.error, 'operation_not_allowed');
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
  f.service.serviceBindings.guardCommand(f.h.store.get('SELECT * FROM channel_service_bindings'), command, event);
  assert.doesNotThrow(() => assertManagedExecution(f.h.store, f.h.store.get('SELECT * FROM tasks WHERE id=?', task.id)));
  assert.equal((await f.setLevel({ delegation: 'deny' })).level, 'custom');
  assert.throws(() => f.service.serviceBindings.guardCommand(f.h.store.get('SELECT * FROM channel_service_bindings'), command, event), { code: 'channel_service_permission_revoked' });
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
  // A group scoped to one repository bills group-assistant and that project (#849, #1249).
  const roleRequests = () => f.h.store.get("SELECT count(*) n FROM model_requests WHERE service_role_id='group-assistant' AND repository_id='101'").n;
  const billed = roleRequests();
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('有哪些未关闭的 PR？')))).state, 'completed');
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('整理好了') && JSON.stringify(s.content).includes('#7')));
  // The own task had the turn's tools minus its own-task tools, and a context of its own.
  const inner = ownBodies[0];
  assert.ok(inner.tools.some(t => t.function.name === 'github_read'));
  assert.ok(!inner.tools.some(t => ['start_own_task', 'continue_own_task', 'list_own_tasks', 'send_message'].includes(t.function.name)));
  assert.equal(JSON.parse(inner.messages[1].content).instruction, '列出 bot 仓库未关闭的 PR');
  const row = f.h.store.get('SELECT * FROM service_role_own_tasks');
  assert.equal(row.owner_kind, 'channel'); assert.equal(row.owner_id, binding.id); assert.equal(row.principal_id, binding.principal_id);
  assert.equal(row.state, 'completed'); assert.equal(row.rounds, 1); assert.ok(!row.history.includes('#7'), 'history is sealed');
  // Billed like the turn itself: main turn requests plus the own task's two.
  assert.ok(roleRequests() >= billed + 4);
  // Roster changes retain the exact stored owner key, including its pre-existing context revision.
  const beforeFence=f.service.serviceBindings.fence(f.chat.id),memoryOwner={service_role_id:binding.service_role_id,kind:'channel',owner_id:f.chat.id,principal_id:binding.principal_id,fence:beforeFence};
  serviceMemory(f.h.store,memoryOwner,'remember_role_memory',{key:'stable',content:'saved before source updates'});
  const source=f.service.turnMessages.event(f.h.store.get("SELECT * FROM channel_inbox WHERE chat_ref=? AND dedup_key LIKE 'message:%' LIMIT 1",f.chat.id));
  f.service.ledger.accept({...source,kind:'audience_changed'});
  assert.equal(f.service.serviceBindings.fence(f.chat.id),beforeFence);
  assert.equal(serviceMemory(f.h.store,{...memoryOwner,fence:f.service.serviceBindings.fence(f.chat.id)},'read_role_memory',{key:'stable'}).content,'saved before source updates');
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
  // A changed level changes the group's fence: the old own task is no longer visible or continuable.
  await f.setLevel({ project_tasks: 'read' });
  main = (body, res, seen) => !seen.length ? call(res, 'list_own_tasks', {}) : seen.length === 1 ? call(res, 'continue_own_task', { task_id: row.id, instruction: '继续' }) : say(res, '没有可继续的独立任务。');
  assert.equal((await done(f, await post(f.h, f.id, groupMessage('继续刚才的独立任务')))).state, 'completed');
  const [hidden, refused] = observations(f.requests.at(-1));
  assert.deepEqual(hidden.own_tasks, []); assert.equal(refused.error, 'own_task_not_found');
});

test('a group assistant reads ten repositories with one tool call each in a single step; large results share one bounded budget (#333)', async t => {
  const f = await fixture(t), ids = ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110'];
  for (const id of ids.slice(2)) await repository(f.admin, f.a.id, id);
  f.h.store.run("UPDATE repositories SET full_name='agent-test-zone/admin-fixture-'||id,owner_id='10' WHERE id<>'201'");
  await shareAssistantModel(f);
  const bound = await f.bind({ scope: { kind: 'repositories', repositories: ids } }); assert.equal(bound.status, 200, JSON.stringify(bound.value));
  assert.equal(bound.value.reachable.length, 10);
  // Every repository has many open PRs with long Chinese titles: each result alone is larger than its share.
  for (const id of ids) f.gh.state.pulls['admin-fixture-' + id] = Array.from({ length: 60 }, (_, n) => ({ number: n + 1, title: '修复跨仓库并发查询时的上下文膨胀问题'.repeat(8), state: 'open' }));
  const bodies = [];
  f.modelState.respond = async (body, res) => {
    bodies.push(body);
    // The first answer asks for everything at once: eleven calls, more than the old limit of eight.
    if (!observations(body).length) return reply(res, { role: 'assistant', content: null, tool_calls: [
      { id: 'call-projects', type: 'function', function: { name: 'list_projects', arguments: '' } },
      ...ids.map(id => ({ id: 'call-pulls-' + id, type: 'function', function: { name: 'github_read', arguments: JSON.stringify({ repository: repo(id), path: '/pulls?state=open' }) } }))] });
    return say(res, '10 个仓库各有 60 个未关闭的 PR。');
  };
  const row = await done(f, await post(f.h, f.id, groupMessage('这 10 个仓库现在一共有多少未关闭的 PR？')));
  assert.equal(row.state, 'completed', row.error);
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('各有 60 个未关闭的 PR')));
  const turn = f.h.store.get('SELECT * FROM channel_service_turns ORDER BY created_at DESC LIMIT 1');
  assert.equal(turn.state, 'completed'); assert.equal(turn.tool_calls, 11);
  // Every repository was read once; the second request answers all eleven calls, each within the shared budget.
  for (const id of ids) assert.ok(f.gh.state.requests.some(r => r.path === `/repos/${repo(id)}/pulls`), id);
  const second = bodies[1], tools = second.messages.filter(m => m.role === 'tool');
  assert.deepEqual(tools.map(m => m.tool_call_id), ['call-projects', ...ids.map(id => 'call-pulls-' + id)]);
  assert.equal(JSON.parse(tools[0].content).projects.length, 10);
  for (const message of tools.slice(1)) {
    const result = JSON.parse(message.content);
    assert.equal(result.truncated, true); assert.match(result.notice, /read_tool_result/); assert.ok(result.file); assert.match(result.fields.repository, /admin-fixture-1\d\d$/);
    assert.ok(Buffer.byteLength(message.content) <= 256 * 1024 / 10 + 512, 'each large result gets an equal share of the batch');
  }
  assert.ok(tools.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0) <= 256 * 1024 + 11 * 512, 'the batch stays within its budget');
  assert.ok(Buffer.byteLength(JSON.stringify(second)) < 384 * 1024, 'the follow-up request stays well inside the model context');
});

test('a group timer hands work to the Manager like a message would; the task is linked to the group and its result returns there (#330)', async t => {
  const f = await fixture(t); assert.equal((await f.bind({ level: 'dispatch' })).status, 200);
  f.modelState.respond = async (body, res) => observations(body).length ? say(res, '已交给 Manager。') : call(res, 'create_project_task', { repository: repo(101), request: '修复群聊卡片链接无法点击的问题', contract });
  const created = await f.admin('/api/channels/chats/' + f.chat.id + '/schedules', 'POST', { name: '每周派活', prompt: '把群聊卡片链接的修复交给 bot 仓库的项目团队。', timezone: 'Asia/Shanghai', cron: '0 10 * * 1' });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const before = f.h.store.get('SELECT count(*) n FROM tasks').n;
  assert.equal((await f.admin('/api/channels/schedules/' + created.value.schedule.id + '/run', 'POST', {})).status, 201);
  const run = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs'), r => r && r.state !== 'running');
  assert.equal(run.state, 'completed', run.error);
  // The timer run is the command's source, as a message would be: same binding principal, idempotency and receipt.
  const receipt = observations(f.requests.at(-1))[0];
  assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt)); assert.equal(f.h.store.get('SELECT count(*) n FROM tasks').n, before + 1);
  const command = f.h.store.get('SELECT * FROM management_commands WHERE id=?', receipt.id), binding = f.h.store.get('SELECT * FROM channel_service_bindings');
  assert.equal(command.source_message, 'feishu:schedule:' + run.id); assert.equal(command.source_conversation, f.chat.id); assert.equal(command.principal_id, binding.principal_id);
  assert.equal(f.h.store.get('SELECT chat_id FROM channel_service_tasks WHERE task_id=?', receipt.result.id).chat_id, f.chat.id);
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('定时任务「每周派活」') && JSON.stringify(s.content).includes('已交给 Manager')));
  // The finished task reports back to the group although no message started it.
  const task = receipt.result.id, current = (await f.admin('/api/management/query', 'POST', { operation: 'get_task', target: { project_id: '101', task_id: task }, arguments: {} })).value;
  const cancel = await f.admin('/api/management/commands', 'POST', { operation: 'task.cancel', target: { project_id: '101', task_id: task }, arguments: {}, expected_revision: current.revision,
    idempotency_key: 'cancel-scheduled-task', source_conversation: 'web', source_message: 'cancel-scheduled-task' });
  assert.equal(cancel.value.state, 'succeeded', JSON.stringify(cancel.value));
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('已取消') && JSON.stringify(s.content).includes(repo(101))));
});

test('an existing dispatch or mixed binding keeps its original task scope until a new tier is selected', async t => {
  const f = await fixture(t);
  const bound = await f.bind({ level: 'dispatch' });
  const table = f.service.serviceBindings, current = () => table.get(f.chat.id);
  const view = async () => (await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === f.chat.id);
  for (const [project_tasks, delegation, mode] of [['write', 'allow', 'write'], ['write', 'deny', 'custom'], ['read', 'allow', 'custom']]) {
    const previous = { ...bound.value.permissions, project_tasks, delegation };
    f.h.store.run('UPDATE channel_service_bindings SET permissions=? WHERE chat_id=?', JSON.stringify(previous), f.chat.id);
    const shown = await view();
    assert.equal(shown.task_mode, mode);
    assert.deepEqual((await f.setLevel(shown.permissions)).permissions, previous, 'round-tripping the old grant is lossless');
    if (delegation === 'deny') assert.throws(() => table.checkOperation(current(), 'task.create', true), { code: 'operation_not_allowed' });
    else assert.doesNotThrow(() => table.checkOperation(current(), 'task.create', true));
    if (project_tasks === 'read') assert.throws(() => table.checkOperation(current(), 'task.cancel', true, 'blocked'), { code: 'operation_not_allowed' });
  }
  assert.equal((await f.setLevel({ project_tasks: 'none' })).task_mode, 'none');
  assert.throws(() => table.checkOperation(current(), 'task.create', true), { code: 'operation_not_allowed' });
});

test('four groups in one project enforce task scope in both tool interfaces and on command replay', async t => {
  const f = await fixture(t), repoName = repo(101), scope = { kind: 'repositories', repositories: ['101'] };
  const groups = {};
  for (const mode of ['none', 'read', 'create', 'write']) {
    const chat = 'oc_' + mode, arrival = groupMessage('discovery', 'ou_alice', chat);
    arrival.event.message.mentions = []; await post(f.h, f.id, arrival);
    const local = f.h.store.get('SELECT id FROM channel_chats WHERE chat_id=?', chat).id;
    const bound = await f.bind({ scope, permissions: { project_tasks: mode } }, local);
    assert.equal(bound.value.task_mode, mode);
    groups[mode] = { chat, binding: f.service.serviceBindings.get(local) };
  }
  async function invoke(mode, name, args) {
    let tools;
    f.modelState.respond = async (body, res) => {
      tools = body.tools.map(tool => tool.function.name);
      return observations(body).length ? say(res, '已核对。') : call(res, name, args);
    };
    const row = await done(f, await post(f.h, f.id, groupMessage(name, 'ou_bob', groups[mode].chat)));
    assert.equal(row.state, 'completed', row.error);
    return { result: observations(f.requests.at(-1))[0], tools };
  }
  const fresh = { repository: repoName, request: '核对项目文档', contract };
  for (const mode of ['none', 'read']) {
    const { result, tools } = await invoke(mode, 'create_project_task', fresh);
    assert.equal(result.error, 'tool_not_allowed');
    assert.equal(tools.includes('list_project_tasks'), mode === 'read');
    assert.equal(tools.includes('read_project_task'), mode === 'read');
    assert.ok(!tools.includes('manage_project_task'));
  }
  const created = await invoke('write', 'create_project_task', fresh);
  assert.equal(created.result.state, 'succeeded');
  const foreign = created.result.result.id;
  for (const task_id of ['blocked', foreign]) {
    const detail = await invoke('create', 'read_project_task', { repository: repoName, task_id });
    const expected_revision = detail.result.revision;
    const dedicated = await invoke('create', 'manage_project_task', { repository: repoName, task_id, operation: 'cancel', expected_revision });
    assert.equal(dedicated.result.error, 'channel_service_task_not_owned');
    const generic = await invoke('create', 'management_command', { operation: 'task.instructions', target: { project_id: '101', task_id },
      arguments: { instruction: '修改验收' }, expected_revision });
    assert.equal(generic.result.error, 'channel_service_task_not_owned');
    const binding = groups.create.binding;
    assert.throws(() => f.service.serviceBindings.guardCommand(binding, { source_conversation: binding.chat_id, project_id: '101',
      operation: 'task.cancel', target: JSON.stringify({ project_id: '101', task_id }) }), { code: 'channel_service_task_not_owned' });
  }
  for (const operation of ['contract', 'pause', 'retry', 'cancel']) {
    const task_id = 'blocked';
    const { result: detail } = await invoke('write', 'read_project_task', { repository: repoName, task_id });
    const changed = await invoke('write', 'manage_project_task', { repository: repoName, task_id, operation,
      ...(operation === 'contract' ? { contract } : {}), expected_revision: detail.revision });
    assert.equal(changed.result.state, 'succeeded', JSON.stringify(changed.result));
  }
});

test('explicit group and private requests change another author’s Issue metadata with an audited source', async t => {
  const f = await fixture(t);
  assert.equal((await f.bind({ level: 'comment' })).status, 200);
  f.h.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='101'");
  for (const [kind, issueEvent] of [['service', groupMessage], ['management', envelope]]) {
    let system;
    f.modelState.respond = async (body, res) => {
      system = body.messages[0].content;
      const count = observations(body).length;
      const action = ['labels', 'assignees'][count];
      return action ? call(res, 'github_write', { repository: repo(101), method: 'POST', path: '/issues/12/' + action,
        body: { [action]: [count === 0 ? 'bug' : 'alice'] }, key: action }) : say(res, '已更新 #12。');
    };
    const row = await done(f, await post(f.h, f.id, issueEvent('给 #12 加 bug 标签，指派给 alice')));
    assert.equal(row.state, 'completed', row.error);
    assert.match(system, /explicit request in this (group|Feishu private chat or console conversation)/i);
    const writes = f.h.store.all("SELECT path,actor FROM github_writes WHERE state='sent' ORDER BY path")
      .filter(w => JSON.parse(w.actor).kind === kind);
    assert.deepEqual(writes.map(w => w.path), ['/issues/12/assignees', '/issues/12/labels']);
    for (const w of writes) assert.ok(JSON.parse(w.actor).source_message);
  }
});

test('a group whose level writes Issues files one in a repository in scope with github_write; with read the tool is not offered and a forced call is refused (#381)', async t => {
  const f = await fixture(t), offered = [];
  assert.equal((await f.bind()).status, 200);
  await f.setLevel({ github_issues: 'write' });
  // The project's capability ceiling (#850) is the top of the group's level: Issues need comment.
  f.h.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='101'");
  const write = (repository, key) => ['github_write', { repository, method: 'POST', path: '/issues', key, body: { title: 'Parser drops the last line', body: 'Reported in the group by @carol.' } }];
  f.modelState.respond = async (body, res) => {
    offered.push(body.tools.map(tool => tool.function.name));
    const seen = observations(body);
    if (seen.length === 0) return call(res, ...write(repo(101), 'group-report'));
    if (seen.length === 1) return call(res, ...write(repo(201), 'elsewhere'));
    return say(res, '已提报 Issue #44。');
  };
  const row = await done(f, await post(f.h, f.id, groupMessage('bot 帮我把这个问题提报成 Issue')));
  assert.equal(row.state, 'completed', row.error);
  const seen = observations(f.requests.at(-1));
  assert.equal(seen[0].repository, repo(101), JSON.stringify(seen[0])); assert.deepEqual([seen[0].result.number, seen[0].result.status], [44, 201]);
  assert.equal(seen[1].error, 'repository_out_of_scope');
  assert.ok(offered[0].includes('github_write'));
  // #1170: the group's prompt states each repository's auto-merge policy as it is now, not a fixed ban.
  const system = f.requests.find(body => body.tools?.some(tool => tool.function.name === 'github_write')).messages[0].content;
  assert.ok(system.includes(`${repo(101)}: disallow`), system); assert.match(system, /disallow: never merge a pull request on your own/);
  // The write token carries exactly Issues write for this repository, and is revoked after the call.
  const posted = f.gh.state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/issues'));
  assert.equal(posted.length, 1); assert.equal(posted[0].path, '/repos/agent-test-zone/admin-fixture-101/issues');
  assert.match(posted[0].body.body, /^Reported in the group by @carol\.\n\n<!-- dept-bot-write:[a-f0-9]{24} -->$/);
  const minted = f.gh.state.requests.filter(r => r.path.endsWith('/access_tokens')).map(r => r.body.permissions);
  assert.ok(minted.some(p => JSON.stringify(p) === JSON.stringify({ issues: 'write', metadata: 'read' })));
  assert.ok(minted.every(p => Object.entries(p).every(([name, level]) => level === 'read' || name === 'issues')));
  const ledger = f.h.store.get("SELECT * FROM github_writes WHERE state='sent'"), actor = JSON.parse(ledger.actor);
  assert.deepEqual([ledger.repository_id, ledger.method, ledger.path, ledger.status, ledger.html_url], ['101', 'POST', '/issues', 201, 'https://github.com/agent-test-zone/admin-fixture-101/issues/44']);
  assert.deepEqual([actor.kind, actor.service_role_id, actor.conversation_id], ['service', 'group-assistant', f.chat.id]); assert.ok(actor.grantor_id);
  // With Issues read only, the tool is not offered and a call the model makes anyway is refused before GitHub.
  await f.setLevel('read'); offered.length = 0;
  f.modelState.respond = async (body, res) => { offered.push(body.tools.map(tool => tool.function.name)); return observations(body).length ? say(res, '不能提报。') : call(res, ...write(repo(101), 'again')); };
  const second = await done(f, await post(f.h, f.id, groupMessage('bot 再提报一个')));
  assert.equal(second.state, 'completed', second.error);
  assert.ok(!offered[0].includes('github_write'));
  assert.equal(observations(f.requests.at(-1))[0].error, 'tool_not_allowed');
  assert.equal(f.gh.state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/issues')).length, 1);
});

test('a comment group starts a workflow someone asks for and gets its run link; bindings saved before take Actions write once and keep their fence (#1072)', async t => {
  const f = await fixture(t), { h } = f;
  assert.equal((await f.bind()).status, 200);
  const level = await f.setLevel('comment');
  assert.deepEqual([level.level, level.permissions.github_actions], ['comment', 'write']);
  h.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='101'");
  const nightly = ['github_write', { repository: repo(101), method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'nightly', body: { ref: 'main' } }];
  f.modelState.respond = async (body, res) => observations(body).length ? say(res, '已触发 Nightly。') : call(res, ...nightly);
  const row = await done(f, await post(h, f.id, groupMessage('bot 跑一下 Nightly')));
  assert.equal(row.state, 'completed', row.error);
  const seen = observations(f.requests.at(-1))[0];
  assert.deepEqual([seen.repository, seen.result.workflow_run_id, seen.result.html_url, seen.result.status], [repo(101), 9001, 'https://github.com/agent-test-zone/admin-fixture-101/actions/runs/9001', 200]);
  // A group that reads Actions is told to recommend bot scheduling when it sees scheduled runs start late.
  assert.match(f.requests.at(-1).messages[0].content, /# Late scheduled workflow runs[\s\S]*Recommend once per repository/);
  // GitHub is asked for the run it started, with a token that holds Actions write only.
  const sent = f.gh.state.requests.filter(r => r.method === 'POST' && r.path.endsWith('/dispatches'));
  assert.deepEqual(sent.map(r => r.body), [{ ref: 'main', return_run_details: true }]);
  assert.ok(f.gh.state.requests.filter(r => r.path.endsWith('/access_tokens')).some(r => JSON.stringify(r.body.permissions) === JSON.stringify({ actions: 'write', metadata: 'read' })));
  assert.equal(h.store.get("SELECT html_url FROM github_writes WHERE state='sent' AND path LIKE '/actions/%'").html_url, 'https://github.com/agent-test-zone/admin-fixture-101/actions/runs/9001');
  // A comment binding saved before #1072 read Actions: on its own it now reads as custom. The upgrade gives it Actions write
  // once, so it reads as comment again, without a new revision or fence: the group's history and computer stay.
  const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', f.chat.id);
  h.store.run('UPDATE channel_service_bindings SET permissions=? WHERE id=?', JSON.stringify({ ...JSON.parse(binding.permissions), github_actions: 'read' }), binding.id);
  const view = async () => (await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === f.chat.id);
  assert.equal((await view()).level, 'custom');
  const fence = new ChannelServiceBindings(h.store, undefined).fence(f.chat.id);
  h.store.run("DELETE FROM settings WHERE key='channel_service_binding_actions_write_migrated'");
  await h.stop(); await h.start();
  const upgraded = await view();
  assert.deepEqual([upgraded.level, upgraded.permissions.github_actions, upgraded.revision], ['comment', 'write', binding.revision]);
  assert.equal(new ChannelServiceBindings(h.store, undefined).fence(f.chat.id), fence);
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='channel.service_binding.actions_write_migrated'").n, 1);
});

test('a project administrator binds one group at read and another at dispatch; every member of the dispatch group creates tasks, nobody in the read group writes (#849)', async t => {
  const f = await fixture(t), { h } = f, bindings = f.service.serviceBindings;
  const second = groupMessage('Second group discussion', 'ou_alice', 'oc_group_2'); second.event.message.mentions = []; await post(h, f.id, second);
  const chatB = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group_2'");
  // A project administrator of 101 only, no super administrator involved.
  const admin = maintainer(f, 'project-admin', ['101'], 'ou_project_admin');
  const scope = { kind: 'repositories', repositories: ['101'] };
  const a = await bindings.configure(admin, f.chat.id, { model_id: f.assistantModel.id, scope, level: 'read', enabled: true, expected_revision: 0 });
  const b = await bindings.configure(admin, chatB.id, { model_id: f.assistantModel.id, scope, level: 'dispatch', enabled: true, expected_revision: 0 });
  assert.deepEqual([a.level, b.level, a.owner, b.owner], ['read', 'dispatch', 'project-admin', 'project-admin']);
  assert.equal(b.permissions.github_contents, 'read', 'dispatch never includes Contents write');
  const grants = chat => JSON.parse(h.store.get("SELECT g.capabilities FROM scoped_grants g JOIN channel_service_bindings b ON b.principal_id=g.principal_id WHERE b.chat_id=?", chat).capabilities);
  assert.deepEqual([grants(f.chat.id), grants(chatB.id)], [['tasks.read', 'knowledge.read'], ['tasks.read', 'tasks.write', 'knowledge.read']]);
  let offered;
  const create = (seen, res, request) => seen.length ? say(res, '已处理。') : call(res, 'create_project_task', { repository: repo(101), request, contract });
  // Group B: a member without a platform account and one with only read access both hand work to the Manager.
  knowledgeActor(h.store, 'reader', '101', ['tasks.read']); bindFixture(h, f.id, 'reader', 'ou_reader');
  for (const [speaker, request] of [['ou_stranger', '外部成员请求修复卡片链接'], ['ou_reader', '只读成员请求补充回归测试']]) {
    f.modelState.respond = async (body, res) => { offered = body.tools.map(tool => tool.function.name); return create(observations(body), res, request); };
    assert.equal((await done(f, await post(h, f.id, groupMessage(request, speaker, 'oc_group_2')))).state, 'completed');
    const receipt = observations(f.requests.at(-1))[0];
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
    assert.equal(h.store.get('SELECT chat_id FROM channel_service_tasks WHERE task_id=?', receipt.result.id).chat_id, chatB.id);
    assert.ok(offered.includes('create_project_task') && offered.includes('manage_project_task') && offered.includes('github_write'));
  }
  assert.equal(h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_stranger'").n, 0, 'the speaker never needed an account');
  // Group A: neither a task nor a GitHub write, whoever asks, and a forced call is refused before anything is sent.
  const tasks = h.store.get('SELECT count(*) n FROM tasks').n;
  for (const [name, args] of [['create_project_task', { repository: repo(101), request: '不该创建', contract }],
    ['github_write', { repository: repo(101), method: 'POST', path: '/issues', key: 'read-group', body: { title: 'No' } }]]) {
    f.modelState.respond = async (body, res) => { offered = body.tools.map(tool => tool.function.name); return observations(body).length ? say(res, '本群只读。') : call(res, name, args); };
    assert.equal((await done(f, await post(h, f.id, groupMessage('帮忙写一下', 'ou_project_admin')))).state, 'completed');
    assert.equal(observations(f.requests.at(-1))[0].error, 'tool_not_allowed');
    for (const tool of ['create_project_task', 'manage_project_task', 'github_write']) assert.ok(!offered.includes(tool), tool);
  }
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, tasks);
  assert.ok(!f.gh.state.requests.some(r => r.method === 'POST' && r.path.endsWith('/issues')));
});

test('a binding takes a level or individual items; levels are exact sets and Contents write is only an individual item (#849)', async t => {
  const f = await fixture(t);
  for (const [input, error] of [[{ level: 'admin' }, 'channel_service_level_invalid'], [{ level: 'read', permissions: { delegation: 'allow' } }, 'channel_service_level_conflict'],
    [{ permissions: { github: 'read' } }, 'channel_service_permission_invalid'], [{ permissions: { delegation: 'write' } }, 'channel_service_permission_invalid'],
    [{ permissions: { project_tasks: 'custom' } }, 'channel_service_permission_invalid']]) {
    const refused = await f.bind(input); assert.equal(refused.status, 400); assert.equal(refused.value.error, error, JSON.stringify(input));
  }
  // Without a level a new binding starts at read; a level stays until it is changed.
  const bound = await f.bind(); assert.equal(bound.value.level, 'read');
  assert.equal((await f.setLevel('comment')).level, 'comment');
  assert.equal((await f.bind({ participation: 'questions', expected_revision: 2 })).value.level, 'comment');
  const merging = await f.setLevel({ github_contents: 'write' });
  assert.deepEqual([merging.level, merging.permissions.github_contents, merging.permissions.github_issues], ['custom', 'write', 'write']);
  // Choosing items that equal a level reads as that level again.
  assert.equal((await f.setLevel({ github_contents: 'read' })).level, 'comment');
  const listed = (await f.admin('/api/channels/service-bindings')).value;
  assert.deepEqual(listed.levels.map(l => l.id), ['read', 'comment', 'dispatch']);
  assert.ok(listed.levels.every(l => l.permissions.github_contents === 'read'));
  assert.ok(listed.permission_items.some(item => item.id === 'github_contents' && item.group === 'github'));
  assert.equal('service_roles' in listed, false, 'group bindings no longer depend on separate service role templates');
});

test('upgrading from pre-#1249 migrates role permissions, model, prompt and harness onto each binding while preserving its exact fence (#849, #1249)', async t => {
  const f = await fixture(t), { h } = f;
  // Seed pre-#1249 legacy service_roles rows directly, as an existing deployment before upgrade holds them.
  const now = new Date().toISOString();
  h.store.run(`INSERT INTO service_roles(id,builtin,enabled,name,responsibility,prompt,model_id,permissions,budget,revision,created_at,updated_at,harness)
    VALUES('custom-legacy',0,1,'派活助手','负责协助派活','先说结论。',?,?,NULL,1,?,?,'pi')`,
    f.assistantModel.id, JSON.stringify({ conversation_history: 'read', github: 'read', project_tasks: 'none', delegation: 'allow' }), now, now);
  h.store.run(`INSERT OR REPLACE INTO service_roles(id,builtin,enabled,name,responsibility,prompt,model_id,permissions,budget,revision,created_at,updated_at,harness)
    VALUES('repository-assistant',1,1,'仓库问答助手','群聊默认推荐的助手：查询 GitHub Issue 和 PR、解释代码仓，不给工作角色派活。','',?,?,NULL,1,?,?,'native')`,
    f.assistantModel.id, JSON.stringify({ github: 'read' }), now, now);
  const second = groupMessage('Second group discussion', 'ou_alice', 'oc_group_2'); second.event.message.mentions = []; await post(h, f.id, second);
  const chatB = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group_2'");
  assert.equal((await f.bind({ scope: { kind: 'repositories', repositories: ['101'] } })).status, 200);
  assert.equal((await f.bind({}, chatB.id)).status, 200);
  // Rewind both bindings to their pre-#849 / pre-#1249 on-disk shape: legacy service_role_id, NULL permissions/model_id/prompt.
  h.store.run("UPDATE channel_service_bindings SET service_role_id='custom-legacy',permissions=NULL,model_id=NULL,prompt=NULL,harness='native' WHERE chat_id=?", f.chat.id);
  h.store.run("UPDATE channel_service_bindings SET service_role_id='repository-assistant',permissions=NULL,model_id=NULL,prompt=NULL,harness='native' WHERE chat_id=?", chatB.id);
  const previousFence = chat => {
    const binding = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat), role = serviceRole(h.store, binding.service_role_id);
    return digest(JSON.stringify({ context: h.store.get('SELECT context_revision FROM channel_chats WHERE id=?', chat).context_revision,
      binding: [binding.id, binding.revision, binding.enabled, revision(h.store, binding.principal_id)], role: [role.id, role.enabled, role.permissions],
      grants: h.store.all("SELECT * FROM scoped_grants WHERE principal_id=? AND policy='channel_service_binding' AND revoked_at IS NULL ORDER BY scope,tenant_id,project_id", binding.principal_id)
        .map(g => [g.id, revision(h.store, g.grantor_id)]) }));
  };
  const fences = [previousFence(f.chat.id), previousFence(chatB.id)], revisions = h.store.all('SELECT revision FROM channel_service_bindings ORDER BY chat_id').map(r => r.revision);
  await h.stop(); await h.start();
  // The restarted store has migrated permissions + inline assistant fields without incrementing revision or rotating fences.
  const restarted = new ChannelServiceBindings(h.store, undefined);
  assert.deepEqual([restarted.fence(f.chat.id), restarted.fence(chatB.id)], fences);
  assert.deepEqual(h.store.all('SELECT revision FROM channel_service_bindings ORDER BY chat_id').map(r => r.revision), revisions);
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='channel.service_binding.level_migrated'").n, 2);
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='channel.service_binding.assistant_migrated'").n, 2);
  const views = (await f.admin('/api/channels/service-bindings')).value.bindings, view = chat => views.find(b => b.chat_id === chat);
  assert.deepEqual([view(chatB.id).github_level, view(chatB.id).task_mode, view(chatB.id).permissions.project_memory], ['read', 'none', 'none']);
  assert.match(view(chatB.id).prompt, /由本群的权限档位决定/);
  assert.deepEqual([view(f.chat.id).level, view(f.chat.id).model_id, view(f.chat.id).harness, view(f.chat.id).permissions.legacy_delegation_controls],
    ['custom', f.assistantModel.id, 'pi', 'allow']);
  assert.equal(view(f.chat.id).prompt, '负责协助派活\n\n先说结论。');
  // Mutating the retired service_roles row no longer affects the migrated binding's model, prompt or permissions.
  h.store.run("UPDATE service_roles SET permissions=?,prompt='已被废弃',model_id=NULL WHERE id='custom-legacy'", JSON.stringify({ github: 'none', delegation: 'deny' }));
  // Reset harness to native for native scripted model verification.
  h.store.run("UPDATE channel_service_bindings SET harness='native' WHERE chat_id=?", f.chat.id);
  let system;
  f.modelState.respond = async (body, res) => {
    system = body.messages[0].content; const seen = observations(body);
    if (!seen.length) return call(res, 'create_project_task', { repository: repo(101), request: '迁移后仍可派活', contract });
    if (seen.length === 1) return call(res, 'manage_project_task', { repository: repo(101), task_id: seen[0].result.id, operation: 'pause', expected_revision: 'x' });
    return say(res, '已派活。');
  };
  assert.equal((await done(f, await post(h, f.id, groupMessage('迁移后派个活')))).state, 'completed');
  const [created, paused] = observations(f.requests.at(-1));
  assert.equal(created.state, 'succeeded', JSON.stringify(created)); assert.equal(paused.error, 'operation_not_allowed', 'pausing was never part of the old set');
  assert.match(system, /负责协助派活[^]*先说结论/);
  assert.doesNotMatch(system, /已被废弃/);
});

/** A project administrator as the console sees one: a platform account with config.write on the given projects. */
function projectAdmin(f, name, projects, open_id) {
  const context = maintainer(f, name, projects, open_id);
  return { context, user: { id: name, username: name, role: 'project_admin', csrf: '', repositories: projects, context } };
}
const roles = (f, user, method, path, body = {}) => { try { return { status: 200, value: serviceRolesApi(f.h.store, user, method, path, body) }; } catch (error) { return { status: error.status, value: { error: error.code, detail: error.detail } }; } };

test('a project administrator configures a group directly with a project model or shared model and custom prompt, including multi-repo groups (#849, #1249)', async t => {
  const f = await fixture(t), { h } = f, bindings = f.service.serviceBindings;
  const second = groupMessage('Second group discussion', 'ou_alice', 'oc_group_2'); second.event.message.mentions = []; await post(h, f.id, second);
  const chatB = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group_2'");
  const pa = projectAdmin(f, 'project-admin', ['101', '102'], 'ou_project_admin');
  const own = (await f.admin('/api/models', 'POST', { repository_id: '101', model_name: 'Project 101 model', api_url: f.assistantModel.api_url, api_key: 'fixture-provider-key' })).value.model;
  // Project admins cannot access /api/service-roles; group models and prompts are set directly on each binding.
  assert.deepEqual(roles(f, pa.user, 'GET', '/api/service-roles').value.service_roles, []);
  assert.equal(roles(f, pa.user, 'POST', '/api/service-roles', { project_id: '101', name: 'x' }).value.error, 'super_admin_required');
  // Single-repo group with project 101's own model and custom prompt: succeeds and bills project 101.
  const bound = await bindings.configure(pa.context, f.chat.id, { model_id: own.id, prompt: '先给结论。', scope: { kind: 'repositories', repositories: ['101'] }, enabled: true, expected_revision: 0 });
  assert.deepEqual([bound.state, bound.model_id, bound.model.project_id, bound.prompt], ['active', own.id, '101', '先给结论。']);
  // Project 101's own model cannot cover a 2-repo group; refusal names project 102.
  await assert.rejects(bindings.configure(pa.context, chatB.id, { model_id: own.id, prompt: '跨仓问答。', scope: { kind: 'repositories', repositories: ['101', '102'] }, enabled: true, expected_revision: 0 }),
    error => error.code === 'channel_service_model_unavailable' && JSON.stringify(error.detail) === JSON.stringify({ projects: [repo(102)] }));
  // With a shared model covering both repos, the project admin configures a multi-repo group with a custom prompt without needing a super admin!
  const multi = await bindings.configure(pa.context, chatB.id, { model_id: f.assistantModel.id, prompt: '先汇总双仓差异。', scope: { kind: 'repositories', repositories: ['101', '102'] }, enabled: true, expected_revision: 0 });
  assert.deepEqual([multi.state, multi.model_id, multi.prompt], ['active', f.assistantModel.id, '先汇总双仓差异。']);
  // Organization scope refuses a project-owned model.
  const tenant = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  await assert.rejects(bindings.configure(resolvePrincipalActor(h.store, f.principal, null), f.chat.id, { model_id: own.id, scope: { kind: 'organization', organization: tenant }, enabled: true, expected_revision: 1 }),
    { code: 'shared_model_required' });
  // Listed models for project-admin expose 101's own model and authorized shared model, never 201's.
  const listedModels = (await bindings.list(pa.context)).models;
  assert.ok(listedModels.some(m => m.id === own.id && m.project_id === '101'));
  assert.ok(listedModels.some(m => m.id === f.assistantModel.id && m.project_id === null));
  // Turns use the binding's model and custom prompt, and single-repo group bills project 101.
  f.modelState.respond = async (body, res) => say(res, '项目专属助手已回答。');
  assert.equal((await done(f, await post(h, f.id, groupMessage('你好')))).state, 'completed');
  const billed = h.store.all('SELECT repository_id,service_role_id,model_id FROM model_requests WHERE conversation_id=?', f.chat.id).map(r => ({ ...r }));
  assert.ok(billed.length && billed.every(r => r.repository_id === '101' && r.service_role_id === 'group-assistant' && r.model_id === own.id), JSON.stringify(billed));
  assert.match(f.requests.at(-1).messages[0].content, /maintainers of this group assistant[^]*先给结论/);
});

test('a group may only use a model every project in its scope has: saves and each turn refuse otherwise, naming the projects (#849, #1249)', async t => {
  const f = await fixture(t), { h } = f;
  const share = repositories => f.admin('/api/models/' + f.assistantModel.id + '/projects', 'PUT', { repository_ids: repositories });
  // The shared model is authorized to 101 only: a group over 101 and 102 is refused, naming 102.
  await share(['101']);
  const refused = await f.bind();
  assert.deepEqual([refused.status, refused.value.error, refused.value.detail], [409, 'channel_service_model_unavailable', { projects: [repo(102)] }]);
  const bound = await f.bind({ scope: { kind: 'repositories', repositories: ['101'] } }); assert.equal(bound.status, 200, JSON.stringify(bound.value));
  // A group over one repository bills it; its model is checked against that repository per request too.
  f.modelState.respond = async (body, res) => say(res, '已回答。');
  assert.equal((await done(f, await post(h, f.id, groupMessage('第一次提问')))).state, 'completed');
  assert.ok(h.store.all('SELECT repository_id FROM model_requests WHERE conversation_id=?', f.chat.id).every(r => r.repository_id === '101'));
  // Changing the binding to a model the group's project lacks is refused, naming the project.
  const lacking = (await f.admin('/api/models', 'POST', { model_name: 'Unshared', api_url: f.assistantModel.api_url, api_key: 'fixture-provider-key' })).value.model;
  await f.admin('/api/models/' + lacking.id + '/projects', 'PUT', { repository_ids: [] });
  const change = await f.bind({ scope: { kind: 'repositories', repositories: ['101'] }, model_id: lacking.id, expected_revision: 1 });
  assert.deepEqual([change.status, change.value.error, change.value.detail], [409, 'channel_service_model_unavailable', { projects: [repo(101)] }]);
  // Withdrawn later: the next turn answers that the model is unavailable, names the project and sends no model request.
  await share([]);
  const before = f.requests.length;
  const row = await done(f, await post(h, f.id, groupMessage('第二次提问')));
  assert.deepEqual([row.state, row.error], ['failed', 'channel_service_model_unavailable']);
  assert.equal(f.requests.length, before, 'never another model');
  await until(() => f.wire.sent.find(s => JSON.stringify(s.content).includes('模型不可用') && JSON.stringify(s.content).includes(repo(101))));
  const view = (await f.admin('/api/channels/service-bindings')).value.bindings[0];
  assert.deepEqual([view.state, view.error, view.model_gaps], ['paused', 'channel_service_model_unavailable', [repo(101)]]);
});

test('upgrading authorizes each enabled group\'s shared model to the projects it already read, so no group stops (#849)', async t => {
  const f = await fixture(t), { h } = f;
  assert.equal((await f.bind()).status, 200);
  // Before the model rule a group's model needed no authorization to its projects.
  h.store.run('DELETE FROM model_projects WHERE model_id=?', f.assistantModel.id);
  h.store.run("DELETE FROM settings WHERE key='channel_service_binding_models_migrated'");
  await h.stop(); await h.start();
  assert.deepEqual(h.store.all('SELECT repository_id FROM model_projects WHERE model_id=? ORDER BY repository_id', f.assistantModel.id).map(r => r.repository_id), ['101', '102']);
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='model.sharing_migrated'").n, 2);
  assert.deepEqual((await f.admin('/api/channels/service-bindings')).value.bindings[0].model_gaps, []);
});

test('removing a project clears group bindings referencing that project\'s own model while leaving shared models intact (#849, #1249)', async t => {
  const f = await fixture(t), { h } = f;
  const second = groupMessage('Second group discussion', 'ou_alice', 'oc_group_2'); second.event.message.mentions = []; await post(h, f.id, second);
  const chatB = h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group_2'");
  const own = (await f.admin('/api/models', 'POST', { repository_id: '101', model_name: 'Project 101 model', api_url: f.assistantModel.api_url, api_key: 'fixture-provider-key' })).value.model;
  assert.equal((await f.bind({ model_id: own.id, scope: { kind: 'repositories', repositories: ['101'] } })).status, 200);
  assert.equal((await f.bind({ model_id: f.assistantModel.id, scope: { kind: 'repositories', repositories: ['102'] } }, chatB.id)).status, 200);
  h.store.transaction(() => deleteProjectRecords(h.store, '101'));
  assert.equal(h.store.get('SELECT model_id FROM channel_service_bindings WHERE chat_id=?', f.chat.id).model_id, null);
  assert.equal(h.store.get('SELECT model_id FROM channel_service_bindings WHERE chat_id=?', chatB.id).model_id, f.assistantModel.id);
});

test('decoupled group permissions default project_memory to read, preserve stored none, allow orthogonal read+dispatch, and always permit computer/browser (#1206)', async t => {
  const f = await fixture(t), { h } = f;
  const bound = await f.bind();
  assert.equal(bound.status, 200, JSON.stringify(bound.value));
  assert.deepEqual([bound.value.github_level, bound.value.task_mode, bound.value.permissions.project_memory, bound.value.permissions.project_configuration, bound.value.permissions.schedules],
    ['read', 'none', 'read', 'none', 'none']);
  assert.equal(bound.value.permissions.computer, undefined);
  assert.equal(bound.value.permissions.browser, undefined);
  const listed = (await f.admin('/api/channels/service-bindings')).value;
  assert.deepEqual(listed.github_levels.map(l => l.id), ['read', 'comment']);
  assert.equal(listed.default_permissions.project_memory, 'read');
  assert.ok(!listed.permission_items.some(item => ['computer', 'browser', 'delegation'].includes(item.id)));

  // Existing stored bindings keep project_memory=none while legacy computer/browser deny normalize to always allowed.
  const bindingRow = h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', f.chat.id);
  h.store.run('UPDATE channel_service_bindings SET permissions=? WHERE id=?',
    JSON.stringify({ ...JSON.parse(bindingRow.permissions), computer: 'deny', browser: 'deny', project_memory: 'none' }), bindingRow.id);
  const preserved = (await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === f.chat.id);
  assert.deepEqual([preserved.github_level, preserved.task_mode, preserved.permissions.project_memory], ['read', 'none', 'none']);
  assert.equal(preserved.permissions.computer, undefined);
  assert.equal(preserved.permissions.browser, undefined);
  // An unrelated edit keeps stored project_memory=none unchanged.
  const reedit = await f.bind({ participation: 'questions', expected_revision: preserved.revision });
  assert.equal(reedit.status, 200, JSON.stringify(reedit.value));
  assert.equal(reedit.value.permissions.project_memory, 'none');

  // Orthogonal combination: GitHub read + tasks create + project_memory read (no GitHub write, no project schedules).
  const ortho = await f.setLevel({ github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read', project_tasks: 'create', project_memory: 'read', schedules: 'none' });
  assert.deepEqual([ortho.github_level, ortho.task_mode, ortho.permissions.project_memory], ['read', 'create', 'read']);
  let offered;
  f.modelState.respond = async (body, res) => {
    offered = body.tools.map(tool => tool.function.name);
    const seen = observations(body);
    if (!seen.length) return call(res, 'management_query', { operation: 'search_knowledge', target: { project_id: repo(101) }, arguments: { query: 'bot' } });
    if (seen.length === 1) return call(res, 'create_project_task', { repository: repo(101), request: '只读加派活测试', contract });
    if (seen.length === 2) return call(res, 'github_write', { repository: repo(101), method: 'POST', path: '/issues', key: 'no-write', body: { title: 'Denied' } });
    return say(res, '完成验证。');
  };
  const row = await done(f, await post(h, f.id, groupMessage('查一下知识并派活')));
  assert.equal(row.state, 'completed', row.error);
  assert.ok(offered.includes('create_project_task') && offered.includes('management_query') && offered.includes('conversation_schedules'));
  assert.ok(!offered.includes('github_write'));
  const [knowledgeRes, createdRes, writeRes] = observations(f.requests.at(-1));
  assert.ok(!knowledgeRes.error, JSON.stringify(knowledgeRes));
  assert.equal(createdRes.state, 'succeeded', JSON.stringify(createdRes));
  assert.equal(writeRes.error, 'tool_not_allowed');
});

test('upgrading to #1206 preserves the exact authorization fence of pre-#1206 bindings carrying computer/browser/legacy keys', async t => {
  const f = await fixture(t), { h } = f;
  assert.equal((await f.bind()).status, 200);
  const bindings = new ChannelServiceBindings(h.store, undefined);
  const bindingRow = () => h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', f.chat.id);
  const expectedFence = slotJson => digest(JSON.stringify({
    context: h.store.get('SELECT context_revision FROM channel_chats WHERE id=?', f.chat.id).context_revision,
    binding: [bindingRow().id, bindingRow().revision, bindingRow().enabled, revision(h.store, bindingRow().principal_id)],
    role: ['group-assistant', 1, slotJson],
    grants: h.store.all("SELECT * FROM scoped_grants WHERE principal_id=? AND policy='channel_service_binding' AND revoked_at IS NULL ORDER BY scope,tenant_id,project_id", bindingRow().principal_id)
      .map(g => [g.id, revision(h.store, g.grantor_id)]),
  }));
  const cases = [
    // Standard pre-#1206 read binding (computer: deny, browser: deny, project_memory: none).
    {
      raw: { computer: 'deny', browser: 'deny', delegation: 'deny', project_tasks: 'none', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read' },
      expected: { computer: 'deny', browser: 'deny', delegation: 'deny', project_tasks: 'none', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read' },
    },
    // Pre-#1206 comment binding with computer/browser allow and Actions write (Actions write masks to read in fence per #1072).
    {
      raw: { computer: 'allow', browser: 'allow', delegation: 'deny', project_tasks: 'none', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'write', github_pull_requests: 'write', github_actions: 'write', github_contents: 'read', github_checks: 'read', github_statuses: 'read' },
      expected: { computer: 'allow', browser: 'allow', delegation: 'deny', project_tasks: 'none', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'write', github_pull_requests: 'write', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read' },
    },
    // Pre-browser binding (stored computer: allow without browser key; pre-#1206 normalized browser to allow).
    {
      raw: { computer: 'allow', delegation: 'deny', project_tasks: 'none', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read' },
      expected: { computer: 'allow', browser: 'allow', delegation: 'deny', project_tasks: 'none', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read' },
    },
    // Pre-#1206 custom computer + legacy task masks in original key order.
    {
      raw: { computer: 'custom', browser: 'allow', delegation: 'allow', project_tasks: 'custom', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read', legacy_repository: 'read', legacy_commands: 'allow', legacy_project_tasks: 'none', legacy_delegation_controls: 'allow' },
      expected: { computer: 'custom', browser: 'allow', delegation: 'allow', project_tasks: 'custom', project_memory: 'none', project_configuration: 'none', schedules: 'none', github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read', legacy_repository: 'read', legacy_commands: 'allow', legacy_project_tasks: 'none', legacy_delegation_controls: 'allow' },
    },
  ];
  for (const { raw, expected } of cases) {
    h.store.run('UPDATE channel_service_bindings SET permissions=? WHERE id=?', JSON.stringify(raw), bindingRow().id);
    assert.equal(bindings.fence(f.chat.id), expectedFence(JSON.stringify(expected)));
    const listed = (await f.admin('/api/channels/service-bindings')).value.bindings.find(b => b.chat_id === f.chat.id);
    assert.equal(listed.permissions.computer, undefined);
    assert.equal(listed.permissions.browser, undefined);
    assert.equal(listed.permissions.legacy_repository, undefined);
    assert.equal(listed.permissions.legacy_commands, undefined);
  }
  // Explicitly saving the binding after #1206 increments revision, drops retired keys from storage, and rotates the fence.
  const beforeFence = bindings.fence(f.chat.id);
  const updated = await f.bind({ participation: 'questions', expected_revision: bindingRow().revision });
  assert.equal(updated.status, 200, JSON.stringify(updated.value));
  assert.notEqual(bindings.fence(f.chat.id), beforeFence);
  const savedRaw = JSON.parse(bindingRow().permissions);
  assert.equal(Object.hasOwn(savedRaw, 'computer'), false);
  assert.equal(Object.hasOwn(savedRaw, 'browser'), false);
});
