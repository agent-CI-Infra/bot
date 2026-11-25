import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { managementFixture, settled as managementSettled } from '../../../fixtures/management-fixture.mjs';
import { channelFixture, repositoryAssistant, boundGroup, inGroup, post, until } from '../../../fixtures/channel-fixture.mjs';
import { fixture as dispatchFixture, toolCall as dispatchToolCall, alice, head } from '../dispatch/dispatch-fixture.mjs';
import { managerFixture } from '../../../fixtures/project-manager-fixture.mjs';
import { Store } from '../../../../dist/storage/database.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { configureDispatch } from '../../../../dist/dispatch/worker.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { runRole } from '../../../../dist/roles/run.js';
import { RoleConversations } from '../../../../dist/roles/conversation.js';
import { roleTaskCaller } from '../../../../dist/tasks/management.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { knowledgeActor } from '../../../fixtures/knowledge-fixture.mjs';
import {
  getFeedbackEntry,
  listFeedbackEntries,
  readFeedbackPayload,
  saveFeedbackSettings,
} from '../../../../dist/feedback/storage.js';
import { SUBMIT_FEEDBACK_TOOL_NAME } from '../../../../dist/feedback/tool.js';
import { StorageReport } from '../../../../dist/app/storage.js';
import '../../../fixtures/scripted-driver.mjs';

const fnTool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const mkCall = (name, args, id = 'call-' + name + '-' + Math.random().toString(36).slice(2, 6)) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

const fbArgs = (title, extra = {}) => ({
  title,
  category: 'workflow',
  severity: 'medium',
  context: 'Automated integration test exercising submit_feedback.',
  problem: 'Observed reproducible platform friction during execution.',
  suggestion: 'Improve platform ergonomics and documentation.',
  ...extra,
});

function assertNoReadFeedbackTools(tools) {
  const names = (tools || []).map(t => t?.function?.name).filter(Boolean);
  for (const name of names) {
    if (name.includes('feedback')) {
      assert.equal(name, SUBMIT_FEEDBACK_TOOL_NAME, `unexpected non-write feedback tool offered: ${name}`);
    }
  }
  return names;
}

test('Entry 1 (project_role): runRole injects submit_feedback, captures authoritative role/env snapshot and untrusted_context, respects toggle', async t => {
  const s = new Store(':memory:', Buffer.alloc(32, 3));
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/OpenToday','o','a')");
  scriptedRoles(s, 'r');
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t','r','task.request','running','Review external PR',?,1,1)", JSON.stringify({ target: { type: 'pr', number: 12 } }));
  new TaskRecords(s).contract('t', { goal: 'Review external PR', scope: ['fixture'], criteria: ['Done'], endpoint: 'artifact' });

  const seenToolNames = [];
  let turn = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seenToolNames.push(assertNoReadFeedbackTools(body.tools));
    turn++;
    let msg;
    if (turn === 1) msg = mkCall('read_task_record', { ref: 'task:t' });
    else if (turn === 2) msg = mkCall(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs('PR role feedback', { category: 'skill', severity: 'high', target_ref: '.agents/skills/review/SKILL.md', idempotency_key: 'pr-1' }));
    else msg = mkCall('finish', { summary: 'completed normally' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 50, completion_tokens: 15 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  s.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)',
    'm', 'r', `http://127.0.0.1:${server.address().port}/v1`, 'fixture-dev',
    s.secrets.seal({ value: 'sk-project-role-secret-123456' }, 'model:m'), 'now',
  );
  s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
  t.after(() => new Promise(resolve => { s.close(); server.close(resolve); server.closeAllConnections(); }));

  const task = s.get("SELECT * FROM tasks WHERE id='t'");
  const spec = { store: s, task, redactor: new Redactor(), guard: async () => {}, system: 'Task execution', prompt: '{}', tools: [fnTool('read_task_record'), fnTool('finish')], finish: { name: 'finish', validate: v => v }, maxTurns: 8 };
  const result = await runRole(spec, 'dev');
  assert.equal(result.result.summary, 'completed normally');
  assert.ok(seenToolNames[0].includes(SUBMIT_FEEDBACK_TOOL_NAME));

  const listed = listFeedbackEntries(s);
  assert.equal(listed.entries.length, 1);
  const entry = listed.entries[0];
  assert.equal(entry.source_kind, 'project_role');
  assert.equal(entry.untrusted_context, true);
  assert.equal(entry.repository_id, 'r');
  assert.equal(entry.repository_full_name, 'fixture/OpenToday');
  assert.equal(entry.role_id, 'dev');
  assert.equal(entry.task_id, 't');
  assert.ok(entry.run_id);

  const payload = readFeedbackPayload(s, entry.id, entry.payload_sha256);
  const snap = payload.environment_snapshot;
  assert.equal(snap.source_kind, 'project_role');
  assert.equal(snap.untrusted_context, true);
  assert.ok(snap.platform.launchpad_version);
  assert.equal(snap.role_config.role_id, 'dev');
  assert.ok(snap.role_config.system_prompt.includes('submit_feedback'));
  assert.match(snap.role_config.system_prompt_sha256, /^[a-f0-9]{64}$/);
  assert.ok(snap.role_config.permissions && typeof snap.role_config.permissions === 'object');
  assert.ok(snap.role_config.offered_tools.includes(SUBMIT_FEEDBACK_TOOL_NAME));
  assert.equal(snap.model.name, 'fixture-dev');
  assert.equal(snap.execution.task_id, 't');
  assert.ok(Array.isArray(snap.execution.recent_tools));
  assert.ok(!JSON.stringify(payload).includes('sk-project-role-secret-123456'));

  // When globally disabled, submit_feedback is NOT offered to the model
  saveFeedbackSettings(s, 'admin', { enabled: false });
  seenToolNames.length = 0;
  turn = 2; // jump straight to finish on turn 3
  await runRole(spec, 'dev');
  assert.equal(seenToolNames[0].includes(SUBMIT_FEEDBACK_TOOL_NAME), false);
});

test('Entry 2 (dispatch_manager): object Manager can submit_feedback on PR event without aborting dispatch', async t => {
  configureDispatch(null);
  const f = await dispatchFixture(t);
  let calls = 0;
  f.state.message = body => {
    const names = assertNoReadFeedbackTools(body.tools);
    assert.ok(names.includes(SUBMIT_FEEDBACK_TOOL_NAME));
    calls++;
    if (calls === 1) {
      return dispatchToolCall(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs('Dispatch prompt ambiguity', { category: 'prompt' }), 'fb-call');
    }
    return dispatchToolCall('ignore_event', { reason: 'no work needed' }, 'ignore-call');
  };
  queueWebhook(f.h.store, '101', 'pull_request', {
    action: 'opened',
    sender: alice,
    repository: { id: 101, full_name: 'fixture/project-101' },
    pull_request: {
      number: 7, state: 'open', draft: false, title: 'External PR', body: 'Hello',
      user: alice, labels: [],
      head: { sha: head, ref: 'feature', repo: { id: 999, full_name: 'fork/project-101' } },
      base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 101, full_name: 'fixture/project-101' } },
    },
  }, 'pr-fb');
  await f.run();

  const entries = listFeedbackEntries(f.h.store).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source_kind, 'dispatch_manager');
  assert.equal(entries[0].untrusted_context, true);
  assert.equal(entries[0].role_id, 'manager');
  const payload = readFeedbackPayload(f.h.store, entries[0].id, entries[0].payload_sha256);
  assert.ok(payload.environment_snapshot.execution.dispatch_event_id);
  assert.ok(payload.environment_snapshot.execution.dispatch_thread_key);
  assert.ok(payload.environment_snapshot.role_config.system_prompt.includes('## Platform Feedback'));
});

test('Entry 3 (role_conversation): RoleConversations exposes submit_feedback and attaches conversation/turn snapshot', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 8));
  const root = mkdtempSync(join(tmpdir(), 'fb-role-conv-'));
  const manager = new LocalManager('101', root);
  let turn = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const names = assertNoReadFeedbackTools(body.tools);
    assert.ok(names.includes(SUBMIT_FEEDBACK_TOOL_NAME));
    turn++;
    const message = turn === 1
      ? mkCall(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs('Conversation tool feedback', { category: 'tool' }))
      : mkCall('finish', { message: 'Conversation answered cleanly' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await manager.recover();
    await new Promise(r => { server.close(r); server.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101',?,'fixture',?,'now')", `http://127.0.0.1:${server.address().port}/v1`, store.secrets.seal({ value: 'secret-conv-key-1234' }, 'model:m'));
  store.run("INSERT INTO policies(repository_id,enabled,model_id) VALUES('101',1,'m')");
  roleApi(store, { id: 'operator', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), {
    expected_revision: 0, enabled: false,
    roles: [{ role_id: 'reviewer', harness_ref: { id: 'scripted' }, permissions: { task_management: 'none', conversation_history: 'read' } }],
  });
  const actor = knowledgeActor(store, 'reader', '101', ['tasks.read', 'knowledge.read']);
  const caller = roleTaskCaller(store, '101', 'reviewer', { actor, conversation_id: 'conv-fb-1', source_message: 'msg-1', guard() {} });
  const conversations = new RoleConversations(store, new TaskCommands(store), manager);
  const res = await conversations.run({
    id: 'conv-fb-1', source_message: 'msg-1', caller, request: 'Check status', guard() {}, fence: () => 'v1',
    context: () => ({ messages: [{ content: 'Hi' }] }), query: () => ({ messages: [] }), summary: () => ({ state: 'none' }),
  });
  assert.equal(res.message, 'Conversation answered cleanly');

  const entries = listFeedbackEntries(store).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source_kind, 'role_conversation');
  assert.equal(entries[0].conversation_id, 'conv-fb-1');
  const payload = readFeedbackPayload(store, entries[0].id, entries[0].payload_sha256);
  assert.equal(payload.environment_snapshot.execution.conversation_id, 'conv-fb-1');
  assert.ok(payload.environment_snapshot.execution.turn_id);
  assert.ok(payload.environment_snapshot.role_config.system_prompt.includes('## Platform Feedback'));
});

test('Entry 4 (management_assistant): personal management assistant and start_own_task both support submit_feedback', async t => {
  const f = await managementFixture(t);
  let mainStep = 0;
  let ownStep = 0;
  f.modelState.respond = async (body, res) => {
    const names = assertNoReadFeedbackTools(body.tools);
    assert.ok(names.includes(SUBMIT_FEEDBACK_TOOL_NAME));
    const userMsg = body.messages.find(m => m.role === 'user')?.content || '';
    const isOwn = typeof userMsg === 'string' && userMsg.includes('Own feedback subtask');
    let message;
    if (isOwn) {
      ownStep++;
      message = ownStep === 1
        ? mkCall(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs('Management own-task feedback', { category: 'environment' }))
        : { role: 'assistant', content: 'Own task finished cleanly.' };
    } else {
      mainStep++;
      if (mainStep === 1) message = mkCall(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs('Management assistant direct feedback', { category: 'tool' }));
      else if (mainStep === 2) message = mkCall('start_own_task', { title: 'Own feedback subtask', instruction: 'Own feedback subtask: verify feedback inside own task' });
      else message = { role: 'assistant', content: 'Done handling request.' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 15, completion_tokens: 6 } }));
  };

  const conv = (await f.admin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const msg = (await f.admin(`/api/management/conversations/${conv}/messages`, 'POST', { source_message: 'fb-mgmt-1', content: 'Check platform' })).value;
  await managementSettled(f.admin, conv, msg.id);

  const entries = listFeedbackEntries(f.h.store).entries;
  assert.equal(entries.length, 2, JSON.stringify(entries));
  assert.ok(entries.every(e => e.source_kind === 'management_assistant'));
  const payloads = entries.map(e => readFeedbackPayload(f.h.store, e.id, e.payload_sha256));
  const ownPayload = payloads.find(p => p.feedback.title === 'Management own-task feedback');
  const directPayload = payloads.find(p => p.feedback.title === 'Management assistant direct feedback');
  assert.ok(directPayload);
  assert.ok(ownPayload);
  assert.ok(ownPayload.environment_snapshot.execution.own_task_id, 'own_task_id must be recorded in snapshot');
  assert.equal(directPayload.environment_snapshot.execution.own_task_id, null);
});

test('Entry 5 (group_assistant): Feishu group chat assistant and start_own_task both support submit_feedback', async t => {
  const f = await channelFixture(t);
  await repositoryAssistant(f);
  const chat = await boundGroup(f);
  let mainStep = 0;
  let ownStep = 0;
  f.modelState.respond = async (body, res) => {
    const names = assertNoReadFeedbackTools(body.tools);
    assert.ok(names.includes(SUBMIT_FEEDBACK_TOOL_NAME));
    const userMsg = body.messages.find(m => m.role === 'user')?.content || '';
    const isOwn = typeof userMsg === 'string' && userMsg.includes('Group own subtask');
    let message;
    if (isOwn) {
      ownStep++;
      message = ownStep === 1
        ? mkCall(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs('Group own-task feedback', { category: 'other' }))
        : { role: 'assistant', content: 'Group own task done.' };
    } else {
      mainStep++;
      if (mainStep === 1) message = mkCall(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs('Group assistant direct feedback', { category: 'workflow' }));
      else if (mainStep === 2) message = mkCall('start_own_task', { title: 'Group own subtask', instruction: 'Group own subtask: submit feedback' });
      else message = { role: 'assistant', content: '群内已处理完毕。' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 15, completion_tokens: 6 } }));
  };

  const receipt = await post(f.h, f.id, inGroup('@bot 排查问题'));
  await until(() => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id), r => ['completed', 'failed'].includes(r?.state), 30000);

  const entries = listFeedbackEntries(f.h.store).entries;
  assert.equal(entries.length, 2, JSON.stringify(entries));
  assert.ok(entries.every(e => e.source_kind === 'group_assistant'));
  const payloads = entries.map(e => readFeedbackPayload(f.h.store, e.id, e.payload_sha256));
  const direct = payloads.find(p => p.feedback.title === 'Group assistant direct feedback');
  const own = payloads.find(p => p.feedback.title === 'Group own-task feedback');
  assert.ok(direct && own);
  assert.ok(direct.environment_snapshot.role_config.binding_id);
  assert.ok(own.environment_snapshot.execution.own_task_id);
  assert.equal(direct.environment_snapshot.scope_summary.chat_id, chat.id);
});

test('Entry 6 (memory_consolidation): all three scopes (project, group, personal) support submit_feedback', async t => {
  const homesDir = mkdtempSync(join(tmpdir(), 'fb-mc-homes-'));
  const mf = await managerFixture({ after: fn => t.after(fn) });
  t.after(() => rmSync(homesDir, { recursive: true, force: true }));

  const clockMs = Date.parse('2026-06-15T19:00:00Z');
  let consolidation;
  const h = await harness(t, mf.manager, {
    assistantHomes: homesDir,
    consolidation: {
      automatic: false,
      clock: () => clockMs,
      runner: async ctx => {
        const names = assertNoReadFeedbackTools(ctx.tools);
        assert.ok(names.includes(SUBMIT_FEEDBACK_TOOL_NAME), `${ctx.scope_kind} must offer submit_feedback`);
        const obs = await ctx.execute(SUBMIT_FEEDBACK_TOOL_NAME, fbArgs(`Consolidation feedback for ${ctx.scope_kind}`, { category: 'prompt' }));
        assert.equal(obs.accepted, true, JSON.stringify(obs));
        return { summary: `Done ${ctx.scope_kind}` };
      },
    },
    onConsolidation: svc => { consolidation = svc; },
  });

  const { admin } = await setup(h);
  const acc = await account(admin);
  await repository(admin, acc.id, '101');
  const shared = (await admin('/api/models', 'POST', {
    provider_name: 'Fixture', api_url: 'http://127.0.0.1:9999/v1', model_name: 'shared-nightly', api_key: 'sk-shared-key-123456',
  })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: shared.id });
  const roleRow = h.store.get("SELECT revision FROM service_roles WHERE id='management-assistant'");
  await admin('/api/service-roles/management-assistant', 'PATCH', {
    name: '管理助手', responsibility: 'test', prompt: '', model_id: shared.id, expected_revision: roleRow.revision,
  });

  // Seed one Feishu group binding so all 3 tracks run
  const adminPrincipal = h.store.get("SELECT id FROM principals WHERE kind='human' LIMIT 1").id;
  const connId = 'a'.repeat(48), credId = 'b'.repeat(48), chatId = 'c'.repeat(48), bindingId = 'd'.repeat(48);
  const now = Date.now();
  h.store.run('INSERT INTO channel_credentials VALUES(?,?)', credId, h.store.secrets.seal({ app_secret: 'sec' }, 'channel-credential:' + credId));
  h.store.run("INSERT INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at,owner_tenant,created_by) VALUES(?,'feishu','cli_app','tenant_1','ou_bot','enterprise','websocket',?,1,1,?,'',?)", connId, credId, now, adminPrincipal);
  h.store.run("INSERT INTO channel_chats(id,connector_id,provider,app_id,installation_tenant,chat_id,chat_type,state,display_name,context_revision,revision,retained_after,created_at,last_received_at) VALUES(?,?,'feishu','cli_app','tenant_1','oc_group_1','group','active','研发群',1,1,0,?,?)", chatId, connId, now, now);
  h.store.run("INSERT INTO principals(id,kind,active,authorization_revision,maintenance) VALUES('p-grp-fb','service',1,1,?)", 'channel-binding:' + chatId);
  const tenantId = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'")?.tenant_id || 't1';
  h.store.run("INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,participation,permissions,model_id,prompt,harness,enabled,revision,created_at,updated_at) VALUES(?,?,'group-assistant','repositories','p-grp-fb',?,?,'mentions',?,?,?,'pi',1,1,?,?)",
    bindingId, chatId, adminPrincipal, adminPrincipal, JSON.stringify({ project_memory: 'read', project_tasks: 'read' }), shared.id, '', now, now);
  h.store.run("INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at) VALUES('g-fb','p-grp-fb',?,'101','project','service',?,'explicit_delegation',?,'channel_service_binding',?,?)",
    tenantId, JSON.stringify(['tasks.read', 'knowledge.read']), adminPrincipal, 'channel:' + chatId, now);

  await admin('/api/memory/consolidation/settings', 'PUT', { max_concurrency: 4 });
  const tick = await consolidation.tick();
  assert.equal(tick.launched, 3);
  await Promise.allSettled([...consolidation.active.values()].map(e => e.promise));

  const entries = listFeedbackEntries(h.store).entries;
  assert.equal(entries.length, 3);
  assert.ok(entries.every(e => e.source_kind === 'memory_consolidation'));
  const scopes = entries.map(e => readFeedbackPayload(h.store, e.id, e.payload_sha256).environment_snapshot.execution.consolidation_scope_kind).sort();
  assert.deepEqual(scopes, ['group_assistant', 'personal_assistant', 'project']);
  assert.equal(entries.find(e => e.title.includes('project')).repository_id, '101');
  assert.equal(entries.find(e => e.title.includes('group_assistant')).repository_id, '101');
  assert.equal(entries.find(e => e.title.includes('personal_assistant')).repository_id, null);
});

test('Super-admin API CRUD, filters, audit, 409 corrupt recovery, project_admin 403 on every route, and StorageReport integration', async t => {
  const h = await harness(t);
  const { admin } = await setup(h);
  const acc = await account(admin);
  await repository(admin, acc.id, '101');

  const password = testPassword();
  await admin('/api/users', 'POST', { username: 'projadmin', password, role: 'project_admin', repository_ids: ['101'] });
  const projAdmin = h.client();
  await projAdmin('/api/auth/login', 'POST', { username: 'projadmin', password });

  // Seed 2 entries via executeSubmitFeedback
  const { executeSubmitFeedback } = await import('../../../../dist/feedback/tool.js');
  const f1 = executeSubmitFeedback({
    store: h.store,
    idempotencyScope: 'api:1',
    snapshot: () => ({
      source_kind: 'project_role', untrusted_context: true, repository_id: '101', repository_full_name: 'fixture/project-101',
      role: { role_id: 'reviewer', system_prompt: 'sys', offered_tools: ['submit_feedback'] }, harness: { id: 'pi' }, model: { name: 'm1' },
    }),
  }, fbArgs('Untrusted PR skill gap', { category: 'skill', severity: 'high', target_ref: 'review-skill' }));
  const f2 = executeSubmitFeedback({
    store: h.store,
    idempotencyScope: 'api:2',
    snapshot: () => ({
      source_kind: 'management_assistant', untrusted_context: false, repository_id: null,
      role: { role_id: 'management-assistant', system_prompt: 'sys', offered_tools: ['submit_feedback'] }, harness: { id: 'pi' }, model: { name: 'm2' },
    }),
  }, fbArgs('Management assistant tool friction', { category: 'tool', severity: 'low' }));
  assert.equal(f1.accepted, true);
  assert.equal(f2.accepted, true);

  // project_admin is denied (403) on EVERY feedback route
  for (const [method, path, body] of [
    ['GET', '/api/feedback', undefined],
    ['GET', `/api/feedback/${f1.feedback_id}`, undefined],
    ['PATCH', `/api/feedback/${f1.feedback_id}`, { status: 'triaged' }],
    ['DELETE', `/api/feedback/${f1.feedback_id}`, {}],
    ['GET', '/api/feedback/settings', undefined],
    ['PUT', '/api/feedback/settings', { enabled: false }],
  ]) {
    const res = await projAdmin(path, method, body);
    assert.equal(res.status, 403, `project_admin must get 403 on ${method} ${path}, got ${res.status}`);
  }

  // Super admin filters & counts
  const all = await admin('/api/feedback');
  assert.equal(all.status, 200);
  assert.equal(all.value.counts.all, 2);
  assert.equal(all.value.counts.open, 2);
  assert.equal((await admin('/api/feedback?untrusted=1')).value.entries.length, 1);
  assert.equal((await admin('/api/feedback?category=tool&severity=low&source_kind=management_assistant')).value.entries.length, 1);
  assert.equal((await admin('/api/feedback?repository_id=__none__')).value.entries.length, 1);
  assert.equal((await admin('/api/feedback?q=review-skill')).value.entries[0].id, f1.feedback_id);

  // Super admin reads detail + updates triage (audited)
  const detail = await admin(`/api/feedback/${f1.feedback_id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.value.payload.feedback.title, 'Untrusted PR skill gap');
  const triaged = await admin(`/api/feedback/${f1.feedback_id}`, 'PATCH', { status: 'triaged', triage_note: 'Tracked in backlog' });
  assert.equal(triaged.status, 200);
  assert.equal(triaged.value.entry.status, 'triaged');
  assert.equal(triaged.value.entry.triage_note, 'Tracked in backlog');
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='feedback.triaged' AND resource_id=?", f1.feedback_id));

  // Settings GET/PUT (audited)
  const settingsPut = await admin('/api/feedback/settings', 'PUT', { enabled: true, max_per_run: 5 });
  assert.equal(settingsPut.status, 200);
  assert.deepEqual(settingsPut.value.settings, { enabled: true, max_per_run: 5 });
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='feedback.settings.updated'"));

  // StorageReport includes feedback directory bytes
  const report = new StorageReport(h.store, undefined, { automatic: false });
  await report.refresh();
  const snap = report.view({ role: 'super_admin', repositories: [] });
  assert.ok(snap.host.known.feedback > 0, `expected host.known.feedback > 0, got ${snap.host.known.feedback}`);

  // Corrupt payload returns 409 feedback_payload_corrupt, and DELETE still removes index row cleanly
  const row2 = getFeedbackEntry(h.store, f2.feedback_id);
  writeFileSync(join(h.store.feedbackDir, row2.payload_relpath), Buffer.from('corrupted-bytes'));
  const corruptRes = await admin(`/api/feedback/${f2.feedback_id}`);
  assert.equal(corruptRes.status, 409);
  assert.equal(corruptRes.value.error, 'feedback_payload_corrupt');
  const delCorrupt = await admin(`/api/feedback/${f2.feedback_id}`, 'DELETE', {});
  assert.equal(delCorrupt.status, 200);
  assert.equal(existsSync(join(h.store.feedbackDir, row2.payload_relpath)), false);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='feedback.deleted' AND resource_id=?", f2.feedback_id));
});
