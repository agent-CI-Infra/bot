import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../dist/storage/database.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { queueWebhook } from '../dist/review/queue.js';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { authorize, invalidate } from '../dist/identity/authorization.js';
import { taskTraceAccess } from '../dist/memory/access.js';
import { roleConfiguration } from '../dist/roles/definition.js';
import { defaultPermissions, migratePermissions, permissionTools, updatePermissions } from '../dist/roles/permissions.js';
import { assertManagedExecution, assertTaskRole, assertTaskExternalEffect, roleTaskCaller, taskToolAllowed, taskManagementTools } from '../dist/tasks/management.js';
import { runRole } from '../dist/roles/run.js';
import { taskGithubWrite } from '../dist/tasks/github-write.js';
import { Redactor } from '../dist/agent/common.js';
import { recordEvent, applyDecision } from '../dist/dispatch/store.js';

function fixture(t) {
  const s = new Store(':memory:', Buffer.alloc(32, 2)); t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')", s.secrets.seal({ token: 'fixture-bot-token' }, 'account:a'));
  for (const id of ['r', 'other']) {
    s.run('INSERT INTO repositories VALUES(?,?,?,?)', id, 'fixture/' + id, '10', 'a');
    s.run('INSERT INTO policies(repository_id,enabled,review_enabled,development_enabled) VALUES(?,1,1,1)', id);
  }
  const config = roleConfiguration(s, 'r'); config.enabled = true;
  const save = (role, permissions, extra = {}) => {
    const def = config.roles.find(r => r.role_id === role); Object.assign(def, extra); def.permissions = updatePermissions(def.permissions,permissions);
    s.run("INSERT INTO settings VALUES('roles:r',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(config));
  };
  save('reviewer', { computer: 'deny', github_issues:'read',github_pull_requests:'read', task_management: 'write', delegation: 'deny', github: 'read' }, { harness_ref: { id: 'native', version: config.roles.find(r => r.role_id === 'reviewer').harness_ref.version } });
  const commands = new TaskCommands(s), caller = (source = {}) => roleTaskCaller(s, 'r', 'reviewer', { conversation_id: 'chat-a', source_message: 'message-a', guard() {}, ...source });
  const create = (c = caller(), request = 'Inspect the logs', extra = {}) => commands.tool(c, 'create_task', { request, criteria: ['Report actual observations'], ...extra });
  return { s, config, save, commands, caller, create };
}

test('own-task operations are always available; dispatching another role still requires delegation', t => {
  const { s, save, caller, commands, create } = fixture(t);
  for (const mode of ['none','read','write']) {
    save('reviewer',{task_management:mode,delegation:'deny'});
    const source=caller(),{id}=create(source,'Own task '+mode,{execute:false});
    assert.equal(s.get('SELECT executor_role FROM task_origins WHERE task_id=?',id).executor_role,'reviewer');
    assert.ok(commands.tool(source,'list_managed_tasks',{}).tasks.some(task=>task.id===id));
    commands.tool(source,'manage_task',{task_id:id,action:'retry'});
    assert.throws(()=>create(source,'Borrow dev',{executor_role:'dev'}),{code:'task_delegation_forbidden'});
  }
  assert.ok(permissionTools({task_management:'none'}).includes('create_task'));
});

test('delegation is independent of removed task toggles; explicit targets must exist and remain enabled',t=>{
  const {s,save,caller,create}=fixture(t);
  save('reviewer',{task_management:'none',delegation:'allow'});
  const source=caller(),task=create(source,'Delegate explicitly',{executor_role:'dev'});
  assert.equal(s.get('SELECT executor_role FROM task_origins WHERE task_id=?',task.id).executor_role,'dev');
  assert.throws(()=>create(source,'Missing',{executor_role:'invented'}),{code:'task_executor_unavailable'});
  save('dev',{}, {enabled:false});
  assert.throws(()=>assertManagedExecution(s,s.get('SELECT * FROM tasks WHERE id=?',task.id)),{code:'task_executor_unavailable'});
});

test('caller objects cannot be serialized/forged; models cannot choose owners, principals, scopes or source roles', t => {
  const { s, caller, commands, create } = fixture(t), source = caller();
  assert.throws(() => create(JSON.parse(JSON.stringify(source))), { code: 'task_caller_untrusted' });
  for (const field of ['owner_key', 'principal_id', 'project_id', 'source_role', 'conversation_id', 'permissions']) {
    assert.throws(() => commands.tool(source, 'create_task', { request: 'Injected', criteria: ['Proof'], [field]: 'forged' }), { code: 'unknown_field' });
  }
  assert.equal(s.get('SELECT count(*) n FROM tasks').n, 0);
});

test('task ownership separates conversations and projects; task write cannot modify another caller’s item', t => {
  const { s, caller, commands, create } = fixture(t), source = caller(), task = create(source);
  const foreign = caller({ conversation_id: 'chat-b' });
  assert.throws(() => commands.tool(foreign, 'read_managed_task', { task_id: task.id }), { code: 'task_not_owned' });
  assert.throws(() => commands.tool(foreign, 'manage_task', { task_id: task.id, action: 'cancel' }), { code: 'task_not_owned' });
  assert.equal(commands.tool(foreign, 'list_managed_tasks', {}).tasks.length, 0);
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('foreign-project','other','task.request','queued','foreign')");
  assert.throws(() => commands.tool(source, 'read_managed_task', { task_id: 'foreign-project' }), { code: 'task_not_found' });
  commands.tool(caller({ source_message: 'later-message' }), 'manage_task', { task_id: task.id, action: 'instructions', instruction: 'Continue from the retained observations.' });
  assert.ok(s.get("SELECT 1 FROM task_history WHERE task_id=? AND type='supplemental_instruction'", task.id));
});

test('replayed task intent reuses one task, while new goals create related independent records', t => {
  const { s, caller, commands, create } = fixture(t), source = caller();
  const one = create(source), replay = create(caller());
  assert.equal(replay.id, one.id); assert.equal(replay.replayed, true);
  assert.notEqual(create(source, 'A new goal').id, one.id);
  commands.tool(source, 'manage_task', { task_id: one.id, action: 'cancel' });
  assert.throws(() => commands.tool(source, 'manage_task', { task_id: one.id, action: 'retry' }), { code: 'task_not_retryable' });
  assert.equal(s.get('SELECT count(*) n FROM task_origins').n, 2);
});

test('live revocation and pinned ceilings survive recovery; granting a newer permission cannot widen an old caller', t => {
  const { s, save, caller, create } = fixture(t);
  save('reviewer', { delegation: 'deny' }); const old = caller();
  save('reviewer', { task_management: 'write', delegation: 'allow' });
  assert.throws(() => create(old,'Delegated work',{executor_role:'dev'}), { code: 'task_delegation_forbidden' });
  const id = create(caller(), 'Delegated work', { executor_role: 'dev' }).id, task = s.get('SELECT * FROM tasks WHERE id=?', id);
  assertManagedExecution(s, task); save('reviewer', { delegation: 'deny' });
  assert.throws(() => assertManagedExecution(s, task), { code: 'task_delegation_forbidden' });
  save('reviewer', { delegation: 'allow', task_management: 'none' });
  assert.doesNotThrow(() => assertManagedExecution(s, task));
  let valid = true; const guarded = caller({ guard() { if (!valid) throw Error('source_revoked'); } });
  valid = false; assert.throws(() => create(guarded), /source_revoked/);
});

test('a source role cannot lend GitHub writes, commands, subagents or another role through its own task', t => {
  const { s, caller, create, save } = fixture(t);
  save('reviewer', { task_management: 'write', computer: 'deny', subagents: 'deny', issues: 'deny' });
  const task = s.get('SELECT * FROM tasks WHERE id=?', create(caller()).id);
  assert.equal(taskToolAllowed(s, task, 'reviewer', 'write_file'), false);
  assert.equal(taskToolAllowed(s,task,'reviewer','start_agent'),true);
  for (const name of ['github_write', 'run_command', 'delegate_role']) assert.equal(taskToolAllowed(s, task, 'reviewer', name), false, name);
  assert.throws(() => assertTaskRole(s, task, 'manager'), { code: 'task_delegation_forbidden' });
  // A PR is a framework delivery (#381): the project's work type decides, and this task's work type has no PR write.
  assert.throws(() => assertTaskExternalEffect(s, task, 'pull_request'), { code: 'task_external_write_forbidden' });
  assertTaskRole(s, task, 'qa'); assert.equal(taskToolAllowed(s, task, 'qa', 'submit_acceptance'), true);
  save('reviewer', { github_issues: 'write' });
  assert.equal(taskToolAllowed(s, task, 'reviewer', 'github_write'), false, 'old request ceiling is retained');
});

test('a persisted principal ceiling cannot acquire later knowledge grants through recovery or a derived task', t => {
  const { s, caller, create } = fixture(t);
  const actor = knowledgeActor(s, 'scoped', 'r', ['tasks.read', 'tasks.manage_own', 'knowledge.read']);
  const id = create(caller({ actor })).id;
  const before = s.get('SELECT principal_capabilities FROM task_origins WHERE task_id=?', id).principal_capabilities;
  s.run("UPDATE scoped_grants SET capabilities=? WHERE id='scoped:r'", JSON.stringify(['tasks.read', 'tasks.manage_own', 'knowledge.read', 'knowledge.write']));
  invalidate(s, 'scoped', 'test_additional_grant');
  const task = s.get('SELECT * FROM tasks WHERE id=?', id);
  assert.throws(() => authorize(taskTraceAccess(s, task).actor, 'knowledge.write', { project_id: 'r' }), { code: 'capability_forbidden' });
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,source_task_id) VALUES('derived','r','task.request','paused','follow-up',?)", id);
  assert.equal(s.get("SELECT principal_capabilities FROM task_origins WHERE task_id='derived'").principal_capabilities, before);
  assert.throws(() => authorize(taskTraceAccess(s, s.get("SELECT * FROM tasks WHERE id='derived'")).actor, 'knowledge.write', { project_id: 'r' }), { code: 'capability_forbidden' });
});

test('a delegated role cannot escape a live ancestor permission ceiling by creating another task', t => {
  const { s, caller, create, save, commands } = fixture(t);
  save('reviewer', { delegation: 'allow', issues: 'deny' }); save('dev', { task_management: 'write', delegation: 'allow', issues: 'allow' });
  const parent = create(caller(), 'Root delegated task', { executor_role: 'dev' }).id;
  const childCaller = roleTaskCaller(s, 'r', 'dev', { source_task_id: parent, guard() {} });
  const child = commands.tool(childCaller, 'create_task', { request: 'Nested task', criteria: ['Keep root authority'] }).id;
  const task = s.get('SELECT * FROM tasks WHERE id=?', child);
  assertManagedExecution(s, task); assert.equal(taskToolAllowed(s, task, 'dev', 'github_write'), false);
  save('reviewer', { delegation: 'deny' });
  assert.throws(() => assertManagedExecution(s, task), { code: 'task_delegation_forbidden' });
  save('reviewer', { delegation: 'allow', task_management: 'none' });
  assert.doesNotThrow(() => assertManagedExecution(s, task));
});

test('event Manager and role callers use the same task-management boundary and independent delegation check', t => {
  const { s, save } = fixture(t);
  const input = { repositoryId: 'r', key: 'event-1', type: 'issue.opened', source: 'fixture', summary: 'Review', facts: {},
    options: [{ id: 'review', work: 'review.issue', title: 'Inspect', spec: { type: 'object', kind: 'review.issue', number: 1, head: null, input: {}, delivery: null } }] };
  recordEvent(s, input);
  const event = s.get('SELECT * FROM dispatch_events'), decision = { decision: 'create', option_ids: ['review'], reason: 'Inspect eligible issue' };
  save('manager', { task_management: 'read' });
  save('manager',{delegation:'deny'});
  assert.throws(() => applyDecision(s, event, decision, null), { code: 'task_delegation_forbidden', state: 'waiting_configuration' });
  save('manager', { task_management: 'write', delegation: 'deny' });
  assert.throws(() => applyDecision(s, event, decision, null), { code: 'task_delegation_forbidden', state: 'waiting_configuration' });
  save('manager', { delegation: 'allow' });
  const result = applyDecision(s, event, decision, null);
  assert.equal(result.created.length, 1);
  const origin = s.get('SELECT * FROM task_origins WHERE task_id=?', result.created[0]);
  assert.equal(origin.source_kind, 'event'); assert.equal(origin.source_role, 'manager'); assert.equal(origin.executor_role, 'dev');
});

test('human project API retains explicit operator authority without synthesizing a role', t => {
  const { s, commands } = fixture(t), user = { id: 'operator', role: 'project_admin', repositories: ['r'] };
  const result = commands.api(user, 'POST', new URL('http://local/api/tasks'), { repository_id: 'r', request: 'Human task', contract: { goal: 'Human task', scope: ['r'], criteria: ['Proof'], endpoint: 'report' } });
  assert.equal(s.get('SELECT source_kind FROM task_origins WHERE task_id=?', result.id).source_kind, 'operator');
  assert.equal(s.get('SELECT executor_role FROM task_origins WHERE task_id=?', result.id).executor_role, null);
  assert.throws(() => commands.api({ ...user, repositories: [] }, 'POST', new URL('http://local/api/tasks/' + result.id + '/cancel'), {}), { code: 'repository_forbidden' });
});

test('real model role tools create the same durable task with a pinned caller, without exposing authority fields', async t => {
  const { s, save, config } = fixture(t); let calls = 0; const offered = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); offered.push(body.tools.map(t => t.function.name));
    const name = ++calls === 1 ? 'create_task' : 'finish';
    const args = name === 'create_task' ? { request: 'Read old records', criteria: ['Return sources'], execute: false } : { summary: 'Recorded task' };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r',?,'fixture',?,'now')", 'http://127.0.0.1:' + server.address().port + '/v1', s.secrets.seal({ value: 'fixture-provider-key' }, 'model:m'));
  s.run("UPDATE policies SET model_id='m' WHERE repository_id='r'");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('parent','r','task.request','running','parent')");
  save('reviewer', {}, { harness_ref: { id: 'native', version: '1' } });
  const task = s.get("SELECT * FROM tasks WHERE id='parent'");
  await runRole({ store: s, task, redactor: new Redactor(), guard: async () => {}, system: 'Inspect', prompt: '{}', maxTurns: 3,
    tools: [{ type: 'function', function: { name: 'finish', parameters: { type: 'object' } } }], finish: { name: 'finish', validate: v => v } }, 'reviewer', undefined, 'native');
  const child = s.get("SELECT * FROM task_origins WHERE source_task_id='parent'");
  assert.equal(child.source_role, 'reviewer'); assert.equal(child.executor_role, 'reviewer'); assert.ok(child.source_run_id);
  assert.equal(s.get('SELECT status FROM tasks WHERE id=?', child.task_id).status, 'paused');
  assert.ok(offered.every(names => names.includes('create_task') && !names.includes('delegate_role')));
  assert.ok(taskManagementTools.every(t => t.function.parameters.additionalProperties === false));
});

test('github_write from a task files an Issue once per key, escapes mentions, redacts secrets and follows the live role', async t => {
  const { s, save, caller, create } = fixture(t); let writes = 0, failOnce = true; const issues = [], requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : null;
    const path = new URL(req.url, 'http://fixture').pathname; requests.push({ method: req.method, path, body });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/repositories/r') return send({ id: 'r', owner: { id: '10' }, full_name: 'fixture/r', default_branch: 'main' });
    if (path === '/repos/fixture/r/issues' && req.method === 'POST') {
      writes++; const issue = { ...body, number: writes, state: 'open', html_url: 'https://example.invalid/issues/' + writes, user: { id: 9 } }; issues.push(issue);
      if (failOnce) { failOnce = false; req.socket.destroy(); return; } return send(issue, 201);
    }
    send({ message: 'Not Found' }, 404);
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  save('reviewer', { github_issues: 'write' });
  const task = s.get('SELECT * FROM tasks WHERE id=?', create(caller(), 'Report Issue').id), url = 'http://127.0.0.1:' + server.address().port;
  const write = taskGithubWrite(s, task, new Redactor(), async () => {}, url), body = { title: 'Observed\ndefect', body: 'Report to @maintainer; seen with fixture-bot-token.' };
  // An answer that never arrived: the key is held as unknown and never sent again.
  const lost = await write({ method: 'POST', path: '/issues', key: 'report-1', body });
  assert.equal(lost.error, 'github_response_unknown'); assert.match(lost.instruction, /new key/);
  assert.equal((await write({ method: 'POST', path: '/issues', key: 'report-1', body })).error, 'github_write_unknown'); assert.equal(writes, 1);
  const filed = await write({ method: 'POST', path: '/issues', key: 'report-2', body });
  assert.deepEqual([filed.number, filed.html_url, filed.status, filed.replayed], [2, 'https://example.invalid/issues/2', 201, undefined]);
  assert.deepEqual(await write({ method: 'POST', path: '/issues', key: 'report-2', body }), { ...filed, replayed: true }); assert.equal(writes, 2);
  // People's text: mentions escaped, the title on one line; every known credential redacted.
  assert.equal(issues[1].title, 'Observed defect'); assert.match(issues[1].body, /^Report to &#64;maintainer; seen with \[REDACTED\]\.\n\n<!-- dept-bot-write:[a-f0-9]{24} -->$/);
  assert.equal(queueWebhook(s, 'r', 'issues', { action: 'opened', issue: { ...issues[1], state: 'open' }, sender: { id: 9, type: 'User', login: 'fixture-bot' } }, 'echo'), 0);
  assert.equal((await write({ method: 'POST', path: '/issues', key: 'report-2', body: { ...body, title: 'Changed intent' } })).error, 'github_write_key_conflict');
  // Who, where and what, for every call.
  const ledger = s.all('SELECT * FROM github_writes WHERE scope=? ORDER BY rowid', 'task:' + task.id);
  assert.deepEqual(ledger.map(row => [row.key, row.state, row.status]), [['report-1', 'unknown', null], ['report-2', 'sent', 201]]);
  assert.deepEqual(JSON.parse(ledger[1].actor), { kind: 'task', role: 'reviewer', task_id: task.id });
  assert.ok(ledger.every(row => row.repository_id === 'r' && row.method === 'POST' && row.path === '/issues' && /^[a-f0-9]{64}$/.test(row.request_digest)));
  assert.deepEqual(s.all("SELECT action FROM audit WHERE action LIKE 'github.write.%' ORDER BY rowid").map(row => row.action), ['github.write.unknown', 'github.write.sent']);
  // Unsupported routes and other resources are refused before anything reaches GitHub; so is a revoked permission.
  const before = requests.length;
  assert.equal((await write({ method: 'POST', path: '/releases', key: 'release', body: { tag_name: 'v1' } })).error, 'github_write_route_unsupported');
  assert.equal((await write({ method: 'PUT', path: '/contents/a.md', key: 'file', body: { message: 'm', content: 'YQ==' } })).error, 'github_resource_forbidden');
  for (const path of ['/issues?x=1', '/../repos/other/issues', 'https://api.github.com/repos/other/x/issues', '/issues/%2e%2e/1'])
    assert.equal((await write({ method: 'POST', path, key: 'bad', body })).error, 'invalid_arguments', path);
  save('reviewer', { github_issues: 'read' });
  assert.equal((await write({ method: 'POST', path: '/issues', key: 'report-3', body })).error, 'github_resource_forbidden');
  assert.equal(requests.length, before);
  assert.equal(s.get("SELECT count(*) n FROM github_writes WHERE state='refused'").n, 3);
});

test('software request endpoint is explicit, defaults off and intersects fixed source, executor and project writes',async t=>{
  const {s,save,commands,caller,create}=fixture(t),{assertRequestPullRequest,publishRequestPullRequest}=await import('../dist/tasks/pull-request.js');
  const before=s.get('SELECT count(*) n FROM tasks').n;
  const old=caller();assert.throws(()=>create(old,'Deliver a PR',{endpoint:'reviewable_pull_request'}),{code:'task_pull_request_forbidden'});
  assert.equal(s.get('SELECT count(*) n FROM tasks').n,before,'rejected admission rolls back task/origin/config records');
  s.run("UPDATE policies SET work_settings=? WHERE repository_id='r'",JSON.stringify({'task.request':{writes:['code','pull_request']}}));
  assert.throws(()=>create(caller(),'Deliver a PR',{endpoint:'reviewable_pull_request'}),{code:'task_pull_request_forbidden'});
  save('reviewer',{repository:'write',pull_request:'allow'});
  assert.throws(()=>create(old,'An older caller cannot gain new authority',{endpoint:'reviewable_pull_request'}),{code:'task_pull_request_forbidden'});
  const id=create(caller(),'Deliver an explicitly authorized PR',{endpoint:'reviewable_pull_request',execute:false}).id;
  const task=s.get('SELECT * FROM tasks WHERE id=?',id);assert.equal(JSON.parse(task.input).contract.endpoint,'reviewable_pull_request');assertRequestPullRequest(s,task);
  await assert.rejects(publishRequestPullRequest(s,task,new Redactor(),async()=>{},()=>{},'http://127.0.0.1:1'),{code:'acceptance_required'});
  assert.equal(s.get('SELECT executor_role FROM task_origins WHERE task_id=?',id).executor_role,'reviewer');
  // The PR is a framework delivery (#381): revoking the executor's PR permission changes nothing, losing code edits does.
  save('reviewer',{pull_request:'deny',delegation:'allow'});assertRequestPullRequest(s,task);
  save('reviewer',{repository:'none'});
  assert.throws(()=>assertRequestPullRequest(s,task),{code:'task_pull_request_forbidden'});
  assert.throws(()=>create(caller(),'Delegation cannot lend PR authority',{endpoint:'reviewable_pull_request',executor_role:'dev'}),{code:'task_pull_request_forbidden'});
  const report=create(caller(),'A report still does not ask for publication',{execute:false}).id;
  assert.equal(JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',report).input).contract.endpoint,'report');
  const record=new TaskRecords(s).get(report);
  assert.throws(()=>commands.api({id:'operator',role:'project_admin',repositories:['r']},'PATCH',new URL('http://local/api/tasks/'+report+'/contract'),{expected_revision:record.revision,contract:{...record.contract,endpoint:'reviewable_pull_request'}},caller()),{code:'task_pull_request_forbidden'});
  assert.equal(new TaskRecords(s).get(report).contract.endpoint,'report');
  assert.throws(()=>commands.tool(caller(),'create_task',{request:'Unknown endpoint',criteria:['Valid result'],endpoint:'merge'}),{code:'invalid_task_endpoint'});
});


test('managed-task context keeps large candidate bodies as references and reads scoped originals in bounded chunks',async t=>{
  const {s,commands,caller,create}=fixture(t),source=caller(),id=create(source).id,records=new TaskRecords(s),{observation}=await import('../dist/tasks/evidence.js');
  const raw=JSON.stringify({execution:'bounded-context',name:'read_file',version:'v1',result:{content:'raw-evidence-marker'.repeat(20000)}});
  records.history(id,'execution_evidence',JSON.parse(raw));const history=s.get('SELECT id FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 1',id).id;
  records.submit(id,[{kind:'report',reference:'task:'+id+':report',version:'v1',content:{body:'artifact-body-marker'.repeat(20000)}}],[observation('task_history:'+history,'v1',raw)],{summary:'The retained result is available by reference'});
  const context=commands.tool(source,'read_managed_task',{task_id:id});const text=JSON.stringify(context);
  assert.ok(!text.includes('raw-evidence-marker'));assert.ok(!text.includes('artifact-body-marker'));assert.equal(context.task.candidate.evidence[0].source,'task_history:'+history);
  const original=commands.tool(source,'read_managed_task',{task_id:id,source:'task_history:'+history,offset:raw.indexOf('raw-evidence-marker'),length:96}).evidence;
  assert.equal(original.chunk.length,96);assert.ok(original.chunk.startsWith('raw-evidence-marker'));assert.equal(original.total,raw.length);
  const other=create(source,'A separate item').id;
  assert.equal(commands.tool(source,'read_managed_task',{task_id:other,source:'task_history:'+history}).evidence.error,'evidence_not_offered');
  assert.throws(()=>commands.tool(source,'read_managed_task',{task_id:id,offset:1}),{code:'evidence_source_required'});
  assert.ok(JSON.stringify(records.get(id)).includes('artifact-body-marker'),'original task audit is preserved');
});
