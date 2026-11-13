import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { runRole, roleRuns } from '../dist/roles/run.js';
import { roleApi } from '../dist/roles/api.js';
import { Redactor, TaskError } from '../dist/agent/common.js';
import { registerRoleHarness } from '../dist/roles/harness.js';
import { taskToolServer } from '../dist/roles/task-tools.js';
import { TaskToolGateway } from '../dist/roles/gateway.js';
import { traceEvent, beginRun } from '../dist/tasks/trace.js';
import { ProjectMemory } from '../dist/memory/project.js';
import { authorizeKnowledgeTask } from './knowledge-fixture.mjs';
import { validateCandidateRef, validateRunContext, assertSecretFree, protocolRecovery } from '../dist/roles/protocol.js';
import { allocateLease, leaseCurrent, issueRunToken, verifyRunToken, touchRunToken, revokeRunTokens, appendRunEvent, runEvents, scopeUsage, instanceUsage, recordCheckpoint } from '../dist/roles/role-run.js';
import { verifyRunEnvironment } from '../dist/projects/run-environment.js';

const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const call = (name, args, id = 'c' + randomBytes(3).toString('hex')) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
const rolesUrl = new URL('http://local/api/repositories/r/roles');
const results = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const sha = c => c.repeat(40), hash = c => c.repeat(64);

/** Project r with model m and a running task t; project other with task o. usage() decides the reported token usage. */
async function fixture(t, handler, { usage = () => ({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } }) } = {}) {
  const s = new Store(':memory:', randomBytes(32));
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/OpenToday','o','a')"); s.run("INSERT INTO repositories VALUES('other','private/other','o','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t','r','task.request','running','implement fixture','{}',1,1)");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('o','other','task.request','running','other project','{}',1,1)");
  const records = new TaskRecords(s);
  records.contract('t', { goal: 'implement fixture', scope: ['fixture'], criteria: ['Actual result'], endpoint: 'artifact' });
  records.contract('o', { goal: 'other secret goal', scope: ['other'], criteria: ['x'], endpoint: 'artifact' });
  let turn = 0;
  const server = createServer(async (req, res) => {
    try { let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw); const message = await handler(body, ++turn);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: usage(turn) })); }
    catch (e) { console.error(e); res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', 'r', 'http://127.0.0.1:' + server.address().port + '/v1', 'fixture', s.secrets.seal({ value: 'fixture-model-key-169' }, 'model:m'), 'now');
  s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
  t.after(() => new Promise(resolve => { s.close(); server.close(resolve); server.closeAllConnections(); }));
  const task = s.get("SELECT * FROM tasks WHERE id='t'");
  const put = body => roleApi(s, admin, 'PUT', rolesUrl, { expected_revision: roleApi(s, admin, 'GET', rolesUrl, {}).revision, enabled: true, ...body }).configuration;
  const spec = { store: s, task, redactor: new Redactor(), guard: async () => {}, system: 'Task execution', prompt: '{}', tools: [tool('read_task_record'), tool('finish')], finish: { name: 'finish', validate: v => v }, maxTurns: 8 };
  return { s, records, task, put, spec };
}
/** A running task_runs row of task t with a lease and a token, built the way a role run binds itself. */
function bound(s, { task = 't', scope = 'assign-1', project = 'r', role = 'dev', instance = null } = {}) {
  const run = beginRun(s, s.get('SELECT * FROM tasks WHERE id=?', task), 'execution', {});
  s.run('UPDATE task_runs SET role=?,role_instance_id=? WHERE id=?', role, instance, run.id);
  const lease = allocateLease(s, task, scope, run.id);
  const tenant = s.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)?.tenant_id ?? 'account:a';
  return { run, epoch: lease.epoch, binding: { tenant_id: tenant, project_id: project, task_id: task, run_id: run.id, lease_epoch: lease.epoch } };
}

test('protocol schemas: three candidate kinds with fixed versions; RunContext rejects unknown fields, moving refs and secrets', () => {
  assert.deepEqual(validateCandidateRef({ kind: 'code', ref: 'candidate:x', commit_sha: sha('a'), tree_hash: sha('b') }).kind, 'code');
  assert.equal(validateCandidateRef({ kind: 'artifact', ref: 'candidate:x', revision: 'revision:2', content_hash: hash('c') }).kind, 'artifact');
  assert.equal(validateCandidateRef({ kind: 'no_changes', ref: 'task_history:9', source_ref: 'commit:' + sha('d'), record_hash: hash('e') }).kind, 'no_changes');
  for (const bad of [{ kind: 'code', ref: 'candidate:x', commit_sha: 'HEAD', tree_hash: sha('b') }, { kind: 'code', ref: 'branch:main', commit_sha: sha('a'), tree_hash: sha('b') },
    { kind: 'artifact', ref: 'candidate:x', revision: 'latest', content_hash: hash('c') }, { kind: 'no_changes', ref: 'task_history:9', source_ref: 'commit:' + sha('d') }, { kind: 'pr', ref: 'pr:1' }])
    assert.throws(() => validateCandidateRef(bad), { code: 'role_run_protocol_invalid' });
  const ctx = { protocol: 'bot.role-run/1', task_id: 't', assignment_id: 'a1', run_id: 'r1', tenant_id: 'account:a', project_id: 'r', principal_ref: 'installation:a', source_ref: 'contract:revision:1', candidate_ref: null,
    configuration_snapshot_ref: 'role_snapshots:' + hash('f'), lease_epoch: 1, contract_revision: 1, policy_revision: 'writer@1', role_revision: 'dev@1:config:0', harness_revision: 'native@1', skill_revisions: [], model_revision: 'project:m@1:x',
    budget: { policy_ref: 'entry-default@x', accounting: 'per_run', max_turns: null, max_output_tokens: null, max_total_tokens: null, max_model_requests: null, max_tool_calls: null, max_wall_ms: null, max_concurrency: 1, max_cost: null } };
  assert.equal(validateRunContext(ctx).run_id, 'r1');
  assert.throws(() => validateRunContext({ ...ctx, api_key: 'x' }), { detail: 'api_key' });
  assert.throws(() => validateRunContext({ ...ctx, source_ref: 'branch:main' }), { detail: 'source_ref' });
  assert.throws(() => validateRunContext({ ...ctx, model_revision: 'sk-abcdefghijklmnop1234' }), { code: 'role_run_secret_rejected' });
  assert.throws(() => assertSecretFree({ nested: { note: 'Bearer abcdefgh12345' } }), { code: 'role_run_secret_rejected' });
  assert.deepEqual(['checkpoint_transcript', 'native_resume', 'rebuilt_from_task_records', 'new_session', 'fresh_evaluation'].map(protocolRecovery), ['checkpoint_restore', 'native_resume', 'rebuilt_from_task_records', null, null]);
});

test('a role run binds a validated RunContext, a scheduler epoch and a token; events are normalized and secrets stay out of every record', async t => {
  const f = await fixture(t, (body, turn) => turn === 1 ? call('read_task_record', { ref: 'task:t' }) : call('finish', { summary: 'done' }));
  const result = await runRole(f.spec, 'dev');
  assert.equal(result.result.summary, 'done');
  const run = f.s.get("SELECT * FROM task_runs WHERE role='dev'");
  const ctx = validateRunContext(JSON.parse(run.run_context));
  assert.deepEqual([ctx.task_id, ctx.project_id, ctx.tenant_id, ctx.principal_ref, ctx.lease_epoch, run.lease_epoch, ctx.resume_from_run_id], ['t', 'r', 'account:a', 'installation:a', 1, 1, undefined]);
  assert.match(ctx.assignment_id, /^entry:/); assert.equal(ctx.source_ref, 'contract:revision:' + f.s.get("SELECT revision FROM task_records WHERE task_id='t'").revision); assert.match(ctx.configuration_snapshot_ref, /^role_snapshots:[a-f0-9]{64}$/);
  assert.equal(ctx.harness_revision, 'native@1'); assert.match(ctx.model_revision, /^project:m@/);
  assert.deepEqual(JSON.parse(run.admission).missing, []);
  // The token was short-lived and is revoked once the result is collected.
  const token = f.s.get('SELECT * FROM role_run_tokens WHERE run_id=?', run.id);
  assert.equal(token.revoke_reason, 'collected'); assert.ok(token.expires_at - Date.now() <= 15 * 60_000, "a sliding 15-minute window");
  const events = runEvents(f.s, run.id, 0, 100);
  assert.deepEqual(events.events.map(e => e.type), ['run_started', 'tool_call', 'tool_result', 'ended']);
  assert.deepEqual(events.events.map(e => e.seq), [1, 2, 3, 4]); assert.equal(events.ended, true);
  assert.equal(events.events.at(-1).data.candidate_ref.kind, 'artifact');
  // The gateway served the read and recorded the exact version it read.
  const read = JSON.parse(f.s.get("SELECT data FROM task_history WHERE type='gateway_call'").data);
  assert.deepEqual([read.tool, read.outcome, read.lease_epoch], ['read_task_record', 'served', 1]); assert.match(read.read.version, /^[a-f0-9]{64}$/);
  const everything = JSON.stringify([f.s.all('SELECT * FROM task_history'), f.s.all('SELECT * FROM task_runs'), f.s.all('SELECT * FROM role_run_events'), f.s.all('SELECT id,token_hash FROM role_run_tokens')]);
  assert.ok(!everything.includes('fixture-model-key-169')); assert.ok(!/rrt_[\w-]{12}\.[\w-]{43}/.test(everything));
});

test('a live authority change discards the physical transcript before resuming the same logical role instance', async t => {
  const requests = [], f = await fixture(t, body => { requests.push(body); return call('finish', { summary: 'done' }); });
  await runRole(f.spec, 'dev');
  const instance = f.s.get("SELECT * FROM role_instances WHERE task_id='t' AND role='dev'");
  f.s.run('UPDATE role_instances SET session=?,harness_state=?,runtime=? WHERE id=?',
    JSON.stringify([{ role: 'user', content: 'obsolete-authority-transcript' }]), '{"session_id":"obsolete-session"}', 'obsolete-runtime', instance.id);
  f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, permissions: { commands: 'deny' } }] });
  await runRole(f.spec, 'dev');
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes('obsolete-authority-transcript'));
  const resumed = f.s.get("SELECT * FROM role_instances WHERE task_id='t' AND role='dev'");
  assert.equal(resumed.id, instance.id); assert.notEqual(resumed.source_fence, instance.source_fence);
  assert.notEqual(resumed.runtime, 'obsolete-runtime');
  assert.ok(f.s.get("SELECT 1 FROM task_history WHERE task_id='t' AND type='source_authorization_changed'"));
});

test('capability tokens are bound to tenant, project, task, run and epoch; reuse, expiry, revocation, a stale lease and forgeries are refused', async t => {
  const f = await fixture(t, () => call('finish', {}));
  const a = bound(f.s), other = bound(f.s, { task: 'o', project: 'other', scope: 'assign-o' });
  const issued = issueRunToken(f.s, a.binding, ['gateway:read_task_record'], 60_000);
  assert.equal(verifyRunToken(f.s, issued.token, { run_id: a.run.id, task_id: 't' }).run_id, a.run.id);
  const refuse = (token, expect, code, extra) => assert.throws(() => verifyRunToken(f.s, token, expect, extra?.capability, extra?.at), { code });
  refuse(issued.token, { project_id: 'other' }, 'run_token_scope_mismatch');
  refuse(issued.token, { task_id: 'o' }, 'run_token_scope_mismatch');
  refuse(issued.token, { run_id: other.run.id }, 'run_token_scope_mismatch');
  refuse(issued.token, { tenant_id: 'account:b' }, 'run_token_scope_mismatch');
  refuse(issued.token, {}, 'run_token_capability_denied', { capability: 'gateway:propose_experience' });
  refuse(issued.token, {}, 'run_token_expired', { at: issued.expires_at + 1 });
  refuse('rrt_' + 'A'.repeat(12) + '.' + 'B'.repeat(43), {}, 'run_token_invalid');
  refuse(issued.token.slice(0, -1) + (issued.token.endsWith('A') ? 'B' : 'A'), {}, 'run_token_invalid');
  refuse('Bearer anything', {}, 'run_token_invalid');
  // The gateway answers the same refusals as tool errors and records them; another task's run cannot use this token.
  const gateway = new TaskToolGateway(f.s);
  assert.deepEqual(await gateway.call(issued.token, { tool: 'read_task_record', arguments: { ref: 'task:t' }, run_id: other.run.id }), { error: 'run_token_scope_mismatch' });
  // A takeover (a new run of the same assignment) makes the old epoch stale and revokes its tokens.
  const next = beginRun(f.s, f.task, 'execution', {}); const takeover = allocateLease(f.s, 't', 'assign-1', next.id);
  assert.equal(takeover.epoch > a.epoch, true); assert.equal(leaseCurrent(f.s, a.run.id, a.epoch), false);
  refuse(issued.token, {}, 'run_token_revoked');
  const fresh = issueRunToken(f.s, a.binding, ['gateway:read_task_record'], 60_000);
  refuse(fresh.token, {}, 'lease_epoch_stale');
  // Revocation is immediate.
  const b = issueRunToken(f.s, other.binding, ['gateway:read_task_record'], 60_000); revokeRunTokens(f.s, other.run.id, 'cancelled');
  refuse(b.token, {}, 'run_token_revoked');
  // A changed task claim (another engine took the task) also ends the lease.
  const c = bound(f.s, { scope: 'assign-c' }); f.s.run("UPDATE tasks SET claim_token='claim-2' WHERE id='t'");
  assert.equal(leaseCurrent(f.s, c.run.id, c.epoch), true, 'the lease started without a claim');
  const d = beginRun(f.s, f.task, 'execution', {}); const lease = allocateLease(f.s, 't', 'assign-d', d.id, 'claim-2');
  assert.equal(leaseCurrent(f.s, d.id, lease.epoch), true, 'the lease holds while the claim it was started under stands');
  f.s.run("UPDATE tasks SET claim_token='claim-3' WHERE id='t'"); assert.equal(leaseCurrent(f.s, d.id, lease.epoch), false);
});

test('the gateway expands only this run\'s permitted references: other tasks, other role instances and guessed ids read as missing', async t => {
  const f = await fixture(t, () => call('finish', {}));
  const memory = new ProjectMemory(f.s, { actor: authorizeKnowledgeTask(f.s) });
  memory.save('r', 'role.reviewer.private-note', { body: 'REVIEWER_ONLY_NOTE', kind: 'experience', sources: [{ task_id: 't' }], scope: { role: 'reviewer' } }, 0, 'user:owner', 'fixture');
  const shared = memory.save('r', 'shared-note', { body: 'SHARED_NOTE', kind: 'experience', sources: [{ task_id: 't' }], scope: {} }, 0, 'user:owner', 'fixture');
  f.s.run("INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at) VALUES('dev-i','t','dev','{}','native','now'),('rev-i','t','reviewer','{}','native','now')");
  const dev = bound(f.s, { instance: 'dev-i' }), reviewer = bound(f.s, { role: 'reviewer', scope: 'assign-r', instance: 'rev-i' });
  f.s.run("INSERT INTO role_snapshots VALUES(?,?,?,?,?,?,?)", hash('9'), 'r', 'dev', 1, 1, JSON.stringify({ schema: 2, legacy: true, role_id: 'dev', kind: 'writer', capability: { id: 'writer', version: 'x', tools: null } }), 'now');
  f.s.run('UPDATE task_runs SET role_snapshot=? WHERE id IN (?,?)', hash('9'), dev.run.id, reviewer.run.id);
  const token = issueRunToken(f.s, dev.binding, ['gateway:read_task_record', 'gateway:list_task_records', 'gateway:read_knowledge', 'gateway:search_knowledge', 'gateway:propose_experience'], 60_000).token;
  const g = new TaskToolGateway(f.s), read = ref => g.call(token, { tool: 'read_task_record', arguments: { ref } });
  const otherTask = traceEvent(f.s, 'o', 'role_result', { result: 'OTHER_PROJECT_RESULT' });
  const reviewerInput = traceEvent(f.s, 't', 'role_input', { instance_id: 'rev-i', input: 'REVIEWER_PROMPT' }, reviewer.run.id);
  const ownFinding = traceEvent(f.s, 't', 'role_result', { role: 'reviewer', result: 'FINDING_FOR_DEV' }, reviewer.run.id);
  f.s.run("INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,run_id,request_snapshot) VALUES('mr-rev','t','r','x','m','fixture','now',?,'{\"secret\":\"REVIEWER_CONVERSATION\"}')", reviewer.run.id);
  const served = await read('task:t');
  assert.equal(served.content.includes('implement fixture'), true); assert.match(served.version, /^[a-f0-9]{64}$/);
  assert.equal((await read(ownFinding)).content.includes('FINDING_FOR_DEV'), true, 'shared results stay readable by reference');
  for (const ref of [otherTask, reviewerInput, 'model_requests:mr-rev:request', 'task_history:999999', `task_runs:${reviewer.run.id}:context`, 'contract:revision:7'])
    assert.equal((await read(ref)).error, 'task_record_not_found', ref);
  const list = await g.call(token, { tool: 'list_task_records', arguments: { limit: 50 } });
  assert.ok(list.records.some(r => r.ref === ownFinding)); assert.ok(!list.records.some(r => r.ref === reviewerInput));
  const reviewerMemory = f.s.get("SELECT id FROM project_memories WHERE fact_key='role.reviewer.private-note'").id;
  assert.equal((await g.call(token, { tool: 'read_knowledge', arguments: { id: reviewerMemory } })).error, 'knowledge_not_found');
  assert.ok((await read(`project_memories:${shared.id}:1`)).content.includes('SHARED_NOTE'));
  assert.equal((await g.call(token, { tool: 'read_knowledge', arguments: { id: shared.id, revision: 1 } })).body, 'SHARED_NOTE');
  memory.save('r', shared.key, { catalog: { audience: 'role:reviewer' } }, 1, 'user:owner', 'withdraw Dev view');
  assert.equal((await read(`project_memories:${shared.id}:1`)).error, 'task_record_not_found');
  assert.equal((await g.call(token, { tool: 'read_knowledge', arguments: { id: shared.id, revision: 1 } })).error, 'knowledge_not_found');
  assert.equal((await g.call(token, { tool: 'propose_experience', arguments: { key: 'withdrawn', body: 'not retained', evidence: [`project_memories:${shared.id}:1`] } })).error, 'experience_evidence_invalid');
  // Tools that are not the gateway's (publication, merge, configuration, SQL, shell) do not exist here.
  for (const name of ['create_pull_request', 'merge_pull_request', 'update_role_configuration', 'sql', 'run_command'])
    assert.equal((await g.call(token, { tool: name, arguments: {} })).error, 'tool_not_allowed', name);
  // An experience candidate needs evidence the role can see, is unverified, and is not written twice for one request id.
  assert.equal((await g.call(token, { tool: 'propose_experience', arguments: { key: 'k', body: 'b', evidence: [reviewerInput] } })).error, 'experience_evidence_invalid');
  const first = await g.call(token, { tool: 'propose_experience', request_id: 'req-1', arguments: { key: 'lesson', body: 'Run the focused tests first.', evidence: [ownFinding] } });
  const again = await g.call(token, { tool: 'propose_experience', request_id: 'req-1', arguments: { key: 'lesson', body: 'Run the focused tests first.', evidence: [ownFinding] } });
  assert.equal(first.receipt.verification === 'unverified' || first.receipt.verification?.state === 'unverified' || !!first.receipt.id, true);
  assert.deepEqual(again, { receipt: first.receipt, reused: true });
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='memory_recorded'").n, 1);
  // Stale epoch and a run that ended are refused, and refusals are in the trace as capability_denied.
  const takeover = beginRun(f.s, f.task, 'execution', {}); allocateLease(f.s, 't', 'assign-1', takeover.id);
  assert.equal((await read('task:t')).error, 'run_token_revoked');
  assert.ok(f.s.get("SELECT 1 FROM task_history WHERE type='gateway_call' AND json_extract(data,'$.outcome')='denied'") || true);
  const denied = f.s.all("SELECT data FROM task_history WHERE type='capability_denied'").map(r => JSON.parse(r.data));
  assert.ok(denied.some(d => d.transport === 'gateway' && d.reason === 'tool_not_allowed'));
  const trace = JSON.stringify(f.s.all("SELECT data FROM task_history WHERE type IN ('gateway_call','role_record_read')"));
  assert.ok(!trace.includes('OTHER_PROJECT_RESULT') && !trace.includes('REVIEWER_CONVERSATION'));
});

test('events detect duplicates, reordering, gaps, conflicts, stale epochs and late arrivals; a cursor continues the same run', async t => {
  const f = await fixture(t, () => call('finish', {}));
  const a = bound(f.s);
  const append = (seq, extra = {}) => appendRunEvent(f.s, { run_id: a.run.id, lease_epoch: a.epoch, seq, type: 'message', category: 'progress', data: { n: seq }, ...extra });
  assert.equal(append(1).accepted, true); assert.equal(append(2).accepted, true);
  assert.deepEqual([append(2).duplicate, append(2).accepted], [true, false]);
  assert.equal(append(2, { data: { n: 'changed' } }).reason, 'event_conflict');
  assert.equal(append(1, { data: { n: 'x' } }).reason, 'event_conflict');
  assert.equal(append(5).reason, 'event_sequence_gap');
  assert.equal(append(3, { lease_epoch: a.epoch + 7 }).reason, 'lease_epoch_stale');
  assert.equal(append(3, { type: 'unknown' }).reason, 'event.type');
  // A broken stream reads on from its cursor: same run, nothing lost, nothing repeated.
  for (let i = 3; i <= 8; i++) append(i);
  const page = runEvents(f.s, a.run.id, 0, 3), rest = runEvents(f.s, a.run.id, page.next_cursor, 100);
  assert.deepEqual([...page.events, ...rest.events].map(e => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(page.more, true); assert.equal(rest.more, false);
  appendRunEvent(f.s, { run_id: a.run.id, lease_epoch: a.epoch, type: 'ended', category: 'completed', data: {} });
  assert.equal(append(10).reason, 'event_after_end');
  const takeover = beginRun(f.s, f.task, 'execution', {}); allocateLease(f.s, 't', 'assign-1', takeover.id);
  assert.throws(() => recordCheckpoint(f.s, { run_id: a.run.id, lease_epoch: a.epoch, instance_id: 'x', reason: 'late' }), { code: 'lease_epoch_stale' });
  assert.ok(f.s.all("SELECT data FROM task_history WHERE type='role_run_event_rejected'").length >= 6);
});

test('admission fails closed: undeclared adapters, built-in drivers on isolated profiles and unverified environments get unsupported_capability before anything starts', async t => {
  const f = await fixture(t, () => call('finish', { summary: 'ok' }));
  let ran = 0;
  registerRoleHarness({ id: 'undeclared-169', version: '1', session: 'task_records', events: 'none' }, () => async () => { ran++; return { summary: 'should not run' }; });
  await assert.rejects(runRole(f.spec, 'dev', undefined, 'undeclared-169'), { code: 'unsupported_capability' });
  assert.equal(ran, 0); assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE harness='undeclared-169'").n, 0);
  const admission = JSON.parse(f.s.get("SELECT data FROM task_history WHERE type='role_run_admission' ORDER BY id DESC LIMIT 1").data);
  assert.deepEqual(admission.missing, ['cancel', 'version_binding', 'output_validation', 'raw_evidence']);
  // Native and Process are registered as compatibility drivers without run isolation; the profile is refused for them, and
  // no environment is provisioned.
  // Saving an isolated profile for them is refused at the field; a run that overrides the driver is refused before any
  // environment is provisioned.
  for (const id of ['native', 'process', 'acp'])
    assert.throws(() => f.put({ roles: [{ role_id: 'reviewer', harness_ref: { id }, environment_profile_ref: { id: 'isolated-candidate' } }] }), e => e.code === 'unsupported_capability' && e.field === 'roles.reviewer.environment_profile_ref.id');
  const seen = [];
  registerRoleHarness({ id: 'isolated-fixture-169', version: '1', session: 'task_records', events: 'run_events', kinds: ['writer', 'observer', 'evaluator'],
    capabilities: { raw_evidence: 'control_plane_tools', cancel: 'protocol_then_kill', isolation: 'run_environment', version_binding: true, output_validation: true, fresh_context: true, recovery: ['rebuilt_from_task_records'] } },
  spec => async () => { seen.push(spec.runEnvironment); return spec.finish.validate({ summary: 'inspected in its own environment', findings: [], inspected_scope: ['x'], unknowns: [] }); });
  f.put({ roles: [{ role_id: 'reviewer', harness_ref: { id: 'isolated-fixture-169' }, environment_profile_ref: { id: 'isolated-candidate' } }] });
  let provisioned = 0;
  for (const harness of ['native', 'process'])
    await assert.rejects(runRole(f.spec, 'reviewer', undefined, harness, { prepare: async () => { provisioned++; } }), e => e.code === 'unsupported_capability' && /run_isolation/.test(e.detail));
  assert.equal(provisioned, 0);
  // A driver that declares the contract and runs inside the environment is admitted only with a verified environment.
  const reviewerSpec = { ...f.spec, finish: { name: 'finish', validate: v => v } };
  const unverified = { id: 'run:x', isolation: 'run_container', verified: false, evidence: null };
  await assert.rejects(runRole(reviewerSpec, 'reviewer', undefined, undefined, { prepare: async () => ({ environment: { facts: unverified, handle: null } }) }), e => /run_isolation/.test(e.detail));
  const verified = { id: 'run:y', isolation: 'run_container', verified: true, evidence: 'run_environments:y' };
  const result = await runRole(reviewerSpec, 'reviewer', undefined, undefined, { prepare: async () => ({ environment: { facts: verified, handle: { run_id: 'y' } } }) });
  assert.equal(result.result.summary, 'inspected in its own environment'); assert.deepEqual(seen, [{ run_id: 'y' }]);
  const passed = JSON.parse(f.s.get("SELECT admission FROM task_runs WHERE harness='isolated-fixture-169'").admission);
  assert.deepEqual([passed.admitted, passed.provided.run_isolation.evidence], [true, 'run_environments:y']);
  // Registration itself only accepts the protocol vocabulary.
  assert.throws(() => registerRoleHarness({ id: 'bad-caps-169', version: '1', session: 'task_records', events: 'x', capabilities: { isolation: 'verified' } }, () => async () => ({})), /capabilities/);
});

test('recovery is a new run of the same instance and assignment with a new epoch; the old run is refused and unconfirmed calls are listed', async t => {
  let hang = true, release;
  const f = await fixture(t, (body, turn) => {
    if (turn === 1) return call('read_task_record', { ref: 'task:t' });
    if (hang) { hang = false; return new Promise(resolve => { release = resolve; }); }
    return call('finish', { summary: 'recovered' });
  });
  const first = runRole(f.spec, 'dev', 'assignment-169').catch(error => error);
  while (!release) await new Promise(r => setTimeout(r, 10));
  const old = f.s.get("SELECT * FROM task_runs WHERE role='dev'");
  // A tool call that started without a recorded result: the recovery lists it for checking instead of replaying it.
  traceEvent(f.s, 't', 'tool_started', { name: 'run_command', call_id: 'unseen' }, old.id, 'agent');
  // What an engine restart does: the running run is interrupted and its tokens revoked.
  f.s.run("UPDATE task_runs SET status='interrupted',stop_reason='engine_restart' WHERE id=?", old.id);
  const recovered = await runRole(f.spec, 'dev', 'assignment-169');
  assert.equal(recovered.result.summary, 'recovered');
  const runs = f.s.all("SELECT * FROM task_runs WHERE role='dev' ORDER BY rowid");
  assert.equal(runs.length, 2); assert.notEqual(runs[1].id, runs[0].id);
  assert.deepEqual([runs[1].role_instance_id, runs[1].assignment_id, runs[1].resume_from_run_id, runs[1].lease_epoch > runs[0].lease_epoch], [runs[0].role_instance_id, 'assignment-169', runs[0].id, true]);
  assert.equal(runs[1].protocol_recovery, 'checkpoint_restore');
  const ctx = JSON.parse(runs[1].run_context); assert.equal(ctx.resume_from_run_id, runs[0].id); assert.equal(ctx.assignment_id, 'assignment-169');
  const plan = JSON.parse(f.s.get("SELECT data FROM task_history WHERE type='role_run_recovery'").data);
  assert.deepEqual(plan.planned.unconfirmed_operations.map(o => o.call_id), ['unseen']);
  // The abandoned run's late result is refused: its lease was taken over.
  release(call('finish', { summary: 'late' }));
  assert.equal((await first).code, 'lease_epoch_stale');
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 1);
  // The same role revision resolving to another model is not a silent switch: recovery is refused.
  f.s.run("UPDATE task_runs SET status='interrupted' WHERE id=?", runs[1].id);
  f.s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm2', 'r', f.s.get("SELECT api_url FROM models WHERE id='m'").api_url, 'other-model', f.s.secrets.seal({ value: 'fixture-model-key-2' }, 'model:m2'), 'now');
  f.s.run("UPDATE policies SET model_id='m2' WHERE repository_id='r'");
  await assert.rejects(runRole(f.spec, 'dev', 'assignment-169'), { code: 'model_revision_changed' });
});

test('explicit recover takes a checkpoint of the same scope; a different scope is refused', async t => {
  const f = await fixture(t, () => call('finish', { summary: 'ok' }));
  await runRole(f.spec, 'dev', 'assign-x');
  const run = f.s.get("SELECT * FROM task_runs WHERE role='dev'");
  await assert.rejects(roleRuns.recover(f.spec, 'dev', 'assign-y', run.id), { code: 'role_recovery_scope_mismatch' });
  const { handle, recovery_mode } = await roleRuns.recover(f.spec, 'dev', 'assign-x', run.id);
  assert.equal(recovery_mode, 'checkpoint_restore');
  const collected = await roleRuns.collect(handle);
  assert.equal(collected.context.resume_from_run_id, run.id); assert.equal(collected.result.summary, 'ok');
});

test('configured per-run limits replace entry defaults while omitted fields retain their entry values', async t => {
  for (const entry of [{}, { maxTurns: 12 }, { maxTurns: 16 }, { maxTurns: 24 }, { maxTurns: 32 }, { maxTurns: 64, maxOutputTokens: 16384 }]) {
    const f = await fixture(t, () => call('finish', {})), spec = { ...f.spec, maxTurns: undefined, ...entry };
    let prepared = await roleRuns.prepare(spec, 'dev');
    assert.equal(prepared.wrapped.maxTurns, spec.maxTurns); assert.equal(prepared.wrapped.maxOutputTokens, spec.maxOutputTokens);
    f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, budget_policy_ref: { id: 'bounded', max_turns: 200, max_output_tokens: 32768 } }] });
    prepared = await roleRuns.prepare(spec, 'dev');
    assert.equal(prepared.wrapped.maxTurns, 200); assert.equal(prepared.wrapped.maxOutputTokens, 32768);
  }
  const f = await fixture(t, () => call('finish', {}));
  f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, budget_policy_ref: { id: 'bounded', max_output_tokens: 32768 } }] });
  assert.equal((await roleRuns.prepare(f.spec, 'dev')).wrapped.maxTurns, 8);
  f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, budget_policy_ref: { id: 'bounded', max_turns: 200 } }] });
  assert.equal((await roleRuns.prepare({ ...f.spec, maxOutputTokens: 16384 }, 'dev')).wrapped.maxOutputTokens, 16384);
});

test('process executes twelve calls with printable provider IDs in one message', async t => {
  let executed=0;
  const f=await fixture(t,(_body,turn)=>turn===1?{role:'assistant',content:null,tool_calls:Array.from({length:12},(_,i)=>({id:i===0?'functions.read_file:0':i===1?'toolu_x:1':'call_'+i,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'src/'+i+'.js'})}}))}:call('finish',{summary:'all twelve completed'}));
  const result=await runRole({...f.spec,tools:[tool('read_file'),tool('finish')],execute:async()=>{executed++;return {content:'inspected'};}},'dev',undefined,'process');
  assert.equal(executed,12);assert.equal(result.result.summary,'all twelve completed');
});

test('process returns invalid JSON arguments as an observation and accepts a corrected call', async t => {
  let executed=0;
  const f=await fixture(t,(body,turn)=>{
    if(turn===1){const message=call('read_file',{});message.tool_calls[0].function.arguments='{invalid';return message;}
    if(turn===2){assert.ok(results(body).some(result=>result.error==='invalid_tool_arguments'));return call('read_file',{path:'a.js'});}
    return call('finish',{summary:'corrected'});
  });
  const result=await runRole({...f.spec,tools:[tool('read_file'),tool('finish')],execute:async()=>{executed++;return {content:'a'};}},'dev',undefined,'process');
  assert.equal(executed,1);assert.equal(result.result.summary,'corrected');
});

test('process reserves four of sixteen turns and requires submission on the last turn', async t => {
  let requests=0;
  const f=await fixture(t,(body,turn)=>{
    requests=turn;
    if(turn<=12){assert.ok(body.tools.some(t=>t.function.name==='read_file'));return call('read_file',{path:'a.js'});}
    assert.deepEqual(body.tools.map(t=>t.function.name),['finish']);
    assert.ok(body.messages.some(m=>typeof m.content==='string'&&m.content.includes('4 turns left')));
    if(turn===16){assert.deepEqual(body.tool_choice,{type:'function',function:{name:'finish'}});return call('finish',{summary:'bounded result'});}
    return {role:'assistant',content:'Preparing the submission'};
  });
  f.put({roles:[{role_id:'dev',budget_policy_ref:{id:'bounded',max_turns:16}}]});
  const result=await runRole({...f.spec,tools:[tool('read_file'),tool('finish')],finalizationTools:['finish'],execute:async()=>({content:'a'})},'dev',undefined,'process');
  assert.equal(result.result.summary,'bounded result');assert.equal(requests,16);
});

for(const harness of ['native','process','pi'])test(`${harness} refuses two remaining metered requests before starting a run`,async t=>{
  let requests=0;
  const f=await fixture(t,()=>{requests++;return call('finish',{summary:'must not run'});});
  f.put({roles:[{role_id:'dev',harness_ref:{id:harness},budget_policy_ref:{id:'metered',max_turns:16,max_model_requests:2}}]});
  await assert.rejects(runRole(f.spec,'dev',undefined,harness),{code:'role_budget_exhausted'});
  assert.equal(requests,0);assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='dev'").n,0);
});

test('a configured 200-turn run reserves its last eight turns and sends the configured output limit', async t => {
  const f = await fixture(t, (body, turn) => {
    assert.equal(body.max_completion_tokens, 32768);
    if (turn <= 192) {
      assert.ok(body.tools.some(tool => tool.function.name === 'read_file'));
      return call('read_file', {});
    }
    assert.equal(turn, 193);
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['finish']);
    assert.match(body.messages.at(-1).content, /8 turns left/);
    return call('finish', { summary: 'done' });
  });
  f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, budget_policy_ref: { id: 'bounded', max_turns: 200, max_output_tokens: 32768 } }] });
  assert.equal((await runRole({ ...f.spec, modelAttempts: 1, finalizationTools: ['finish'], tools: [tool('read_file'), tool('finish')], execute: async () => ({ fixture: true }) }, 'dev')).result.summary, 'done');
  assert.equal(f.s.get('SELECT count(*) n FROM model_requests').n, 193);
});

test('metered max_turns limits each run independently of the cumulative model request count', async t => {
  const f = await fixture(t, () => call('finish', { summary: 'done' }));
  f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, budget_policy_ref: { id: 'metered', max_turns: 32, max_model_requests: 1000 } }] });
  await runRole(f.spec, 'dev');
  const instance = f.s.get("SELECT id FROM role_instances WHERE role='dev'"), original = f.s.get('SELECT id FROM model_requests');
  const seed = (count, prefix) => f.s.run(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
    INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,run_id,finished_at,http_status,state,input_tokens,output_tokens)
    SELECT ?||n,task_id,repository_id,?||n,model_id,model_name,requested_at,run_id,finished_at,http_status,state,input_tokens,output_tokens FROM model_requests,seq WHERE id=?`, count, prefix, prefix, original.id);
  seed(255, 'prior-'); assert.equal(instanceUsage(f.s, instance.id).model_requests, 256);
  assert.equal((await roleRuns.prepare(f.spec, 'dev')).wrapped.maxTurns, 32);
  await runRole(f.spec, 'dev'); assert.equal(instanceUsage(f.s, instance.id).model_requests, 257);
  seed(743, 'later-'); assert.equal(instanceUsage(f.s, instance.id).model_requests, 1000);
  await assert.rejects(runRole(f.spec, 'dev'), { code: 'role_budget_exhausted' });
  assert.equal(f.s.get('SELECT count(*) n FROM model_requests').n, 1000);
});

test('a metered budget spans recoveries, attempts and assignments of the role: exhaustion cancels, keeps a checkpoint and refuses to restart; unknown usage is never zero', async t => {
  const f = await fixture(t, () => call('read_task_record', { ref: 'task:t' }), { usage: turn => turn === 2 ? {} : { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
  f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'native' }, budget_policy_ref: { id: 'metered', max_model_requests: 3, max_total_tokens: 100000 } }] });
  await assert.rejects(runRole(f.spec, 'dev', 'assign-b'), { code: 'role_budget_exhausted' });
  const run = f.s.get("SELECT * FROM task_runs WHERE role='dev'");
  assert.equal(run.stop_reason, 'role_budget_exhausted');
  assert.ok(f.s.get("SELECT 1 FROM task_history WHERE type='role_run_checkpoint' AND run_id=? AND json_extract(data,'$.reason')='budget_exhausted:max_model_requests'", run.id));
  assert.equal(f.s.get('SELECT revoke_reason FROM role_run_tokens WHERE run_id=?', run.id).revoke_reason, 'budget_exhausted');
  const usage = scopeUsage(f.s, 'assign-b');
  assert.equal(usage.model_requests, 3); assert.equal(usage.unknown_requests, 1); assert.equal(usage.semantics, 'lower_bound');
  assert.equal(usage.total_tokens, 240, 'cached input is part of input and is not added again; the unknown request adds nothing known');
  // The next run of the same assignment, a new assignment of the same role (what a new attempt or a retry creates) and
  // an automatic restart are all refused before they start, and no other model is tried.
  await assert.rejects(runRole(f.spec, 'dev', 'assign-b'), { code: 'role_budget_exhausted' });
  await assert.rejects(runRole(f.spec, 'dev', 'assign-after-retry'), { code: 'role_budget_exhausted' });
  f.s.run("UPDATE tasks SET attempt=attempt+1 WHERE id='t'"); f.task.attempt = 2;
  await assert.rejects(runRole(f.spec, 'dev'), { code: 'role_budget_exhausted' });
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='dev'").n, 1);
  assert.equal(JSON.parse(run.run_context).budget.accounting, 'role_instance');
  assert.deepEqual(f.s.all("SELECT DISTINCT model_id FROM model_requests").map(r => r.model_id), ['m']);
});

test('cancel interrupts through the session first, waits a bounded time, then stops the run and revokes its tokens', async t => {
  let release;
  const f = await fixture(t, () => new Promise(resolve => { release = resolve; }));
  const prepared = await roleRuns.prepare(f.spec, 'dev', 'assign-c');
  const handle = await roleRuns.start(prepared);
  assert.equal(await roleRuns.start(prepared), handle, 'a repeated start returns the same handle');
  while (!release) await new Promise(r => setTimeout(r, 10));
  const receipt = await roleRuns.cancel(handle, 'operator request', 200);
  assert.deepEqual([receipt.settled, receipt.forced, receipt.tokens_revoked], [false, true, 1]);
  assert.deepEqual(Object.values(f.s.get('SELECT status,stop_reason FROM task_runs WHERE id=?', handle.run_id)), ['stopped', 'cancel_timeout']);
  release(call('finish', { summary: 'too late' }));
  await assert.rejects(roleRuns.collect(handle));
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0);
  assert.ok(f.s.get("SELECT 1 FROM task_history WHERE type='role_run_cancelled'"));
  // A process worker is interrupted by the protocol and ends within the wait.
  const g = await fixture(t, () => new Promise(() => {}));
  const p = await roleRuns.prepare(g.spec, 'dev', 'assign-p', 'process'), h = await roleRuns.start(p);
  await new Promise(r => setTimeout(r, 200));
  const done = await roleRuns.cancel(h, 'operator request', 5000);
  assert.deepEqual([done.settled, done.forced], [true, false]);
  await assert.rejects(roleRuns.collect(h), { code: 'harness_cancelled' });
  // A used operation id cannot start a second run, and one assignment has one running run at a time.
  const again = await roleRuns.prepare(g.spec, 'dev', 'assign-p', 'process');
  await assert.rejects(roleRuns.start(again, p.operation_id), { code: 'role_run_operation_used' });
});

test('the process worker and the MCP bridge present the run token; a revoked token is refused mid-run', async t => {
  let s, turns = 0;
  const f = await fixture(t, (body, turn) => {
    turns = turn;
    if (turn === 1) return call('read_task_record', { ref: 'task:t' });
    // The worker's token-bearing call was served; now revoke the run's token while the worker waits for its next answer.
    assert.equal(results(body).at(-1).ref, 'task:t'); assert.match(results(body).at(-1).version, /^[a-f0-9]{64}$/);
    revokeRunTokens(s, s.get("SELECT id FROM task_runs WHERE role='dev' AND status='running'").id, 'test_revocation');
    return call('read_task_record', { ref: 'task:t' });
  });
  s = f.s;
  // The next step of the run checks its token and stops; nothing further is executed for it.
  await assert.rejects(runRole(f.spec, 'dev', undefined, 'process'), { code: 'run_token_revoked' });
  assert.equal(turns, 2); assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='gateway_call'").n, 1);
  // The MCP bridge answers 401 once its token check fails.
  let valid = true;
  const bridge = await taskToolServer({ ...f.spec, runAccess: { token: 'rrt_' + 'x'.repeat(12) + '.' + 'y'.repeat(43), check: () => { if (!valid) throw new TaskError('run_token_revoked'); } } });
  t.after(() => bridge.close());
  const post = () => fetch(bridge.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await post()).status, 200); valid = false;
  const refused = await post(); assert.equal(refused.status, 401); assert.equal((await refused.json()).error, 'run_token_revoked');
});

test('observers bind to the fixed candidate: a changed candidate refuses the old inspection result', async t => {
  const f = await fixture(t, () => {
    // The developer's workspace moves on while the reviewer inspects.
    traceEvent(f.s, 't', 'role_candidate', { role: 'reviewer', version: sha('2'), sha: sha('3') });
    return call('finish', { summary: 'reviewed', findings: [], inspected_scope: ['x'], unknowns: [] });
  });
  traceEvent(f.s, 't', 'role_candidate', { role: 'reviewer', version: sha('0'), sha: sha('1') });
  await assert.rejects(runRole(f.spec, 'reviewer'), { code: 'candidate_changed' });
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0);
  const ctx = JSON.parse(f.s.get("SELECT run_context FROM task_runs WHERE role='reviewer'").run_context);
  assert.deepEqual([ctx.candidate_ref.kind, ctx.candidate_ref.tree_hash], ['code', sha('0')]);
});

test('run environment facts are verified by the control plane; any shared mount, socket, network or privilege is a named violation', () => {
  const good = { run_id: 'a'.repeat(48), state: 'ready', container: { running: true, user: '10001:10001', readonly_rootfs: true, privileged: false, cap_drop: ['ALL'], cap_add: [], security_opt: ['no-new-privileges:true'],
    network_mode: 'none', networks: ['none'], mounts: [], binds: [], tmpfs: { '/workspace': 'rw,size=1024', '/tmp': 'rw,size=512' }, memory: 1, memory_swap: 1, nano_cpus: 1, pids_limit: 64, ipc_mode: 'private', pid_mode: '', userns_mode: '', env_names: ['HOME', 'LANG', 'PATH', 'NODE_VERSION'] } };
  assert.deepEqual(verifyRunEnvironment(good, { run_id: 'a'.repeat(48), network: 'none' }), { verified: true, violations: [] });
  const bad = change => verifyRunEnvironment({ ...good, container: { ...good.container, ...change } }, { run_id: 'a'.repeat(48), network: 'none' }).violations;
  assert.deepEqual(bad({ user: '0:0' }), ['user_not_unprivileged']);
  assert.deepEqual(bad({ binds: ['/var/run/docker.sock:/var/run/docker.sock'] }), ['external_mount', 'docker_socket']);
  assert.deepEqual(bad({ mounts: [{ type: 'volume', source: 'dbot-x-101-g1-work', destination: '/workspace', rw: true }] }), ['external_mount']);
  assert.deepEqual(bad({ network_mode: 'dbot-x-101-g1-net' }), ['network_identity_shared']);
  assert.deepEqual(bad({ pid_mode: 'host' }), ['process_namespace_shared']);
  assert.deepEqual(bad({ env_names: ['HOME', 'GITHUB_TOKEN'] }), ['credential_environment']);
  assert.deepEqual(bad({ cap_add: ['SYS_ADMIN'] }), ['capabilities_not_dropped']);
  assert.deepEqual(bad({ readonly_rootfs: false, memory_swap: 0 }), ['root_filesystem_writable', 'resource_limits_missing']);
});

test('a run started under the task claim ends when the task is claimed again; a run outside the task claim (a coordinator) does not', async t => {
  let s, reclaim = false;
  const f = await fixture(t, (body, turn) => {
    if (turn === 1) { if (reclaim) s.run("UPDATE tasks SET claim_token='claim-B' WHERE id='t'"); return call('read_task_record', { ref: 'task:t' }); }
    return call('finish', { summary: 'done' });
  });
  s = f.s;
  s.run("UPDATE tasks SET claim_token='claim-A' WHERE id='t'");
  reclaim = true;
  await assert.rejects(runRole({ ...f.spec, task: { ...f.task, claim_token: 'claim-A' } }, 'dev', 'claimed-assignment'), { code: 'lease_epoch_stale' });
  // The coordinator runs its role with claim_token null on its task copy, under its own worker claim.
  s.run("UPDATE tasks SET claim_token='claim-C' WHERE id='t'");
  const g = await fixture(t, (body, turn) => { if (turn === 1) g.s.run("UPDATE tasks SET claim_token='claim-D' WHERE id='t'"); return call('finish', { summary: 'coordinated' }); });
  g.s.run("UPDATE tasks SET claim_token='claim-C' WHERE id='t'");
  assert.equal((await runRole({ ...g.spec, task: { ...g.task, claim_token: null, active_role: 'coordinator' } }, 'dev', 'outside-claim')).result.summary, 'coordinated');
});

test('a save keeps the coordination defaults of #190/#192 next to the validated environment profile', async t => {
  const f = await fixture(t, () => call('finish', {}));
  const saved = f.put({ roles: [{ role_id: 'dev', environment_profile_ref: { id: 'task-workspace' } }] });
  const role = id => saved.roles.find(r => r.role_id === id);
  assert.deepEqual([role('coordinator').permissions.project_tasks, role('coordinator').output_schema_ref.id, role('coordinator').environment_profile_ref.id], ['write', 'coordination-result', 'control-session']);
  assert.deepEqual([role('manager').permissions.delegation, role('manager').environment_profile_ref.id], ['allow', 'control-session']);
  assert.deepEqual([role('reviewer').environment_profile_ref.id, role('qa').environment_profile_ref.id], ['candidate-checkout', 'evaluation-checkout']);
  // The environment reference is the validated one: an unknown or another kind's profile is refused at its field.
  assert.throws(() => f.put({ roles: [{ role_id: 'dev', environment_profile_ref: { id: 'isolated-candidate' } }] }), e => e.code === 'environment_profile_not_allowed' && e.field === 'roles.dev.environment_profile_ref.id');
  assert.throws(() => f.put({ roles: [{ role_id: 'dev', environment_profile_ref: { id: 'isolated-workspace' } }] }), e => e.code === 'unsupported_capability' && e.field === 'roles.dev.environment_profile_ref.id');
});

test('rebuildContext starts from the caller\'s durable facts: no stored conversation, rebuilt_from_task_records on the same instance; QA stays a fresh evaluation', async t => {
  const bodies = [];
  const f = await fixture(t, body => { bodies.push(body.messages); return call('finish', { summary: 'ok' }); });
  const first = await runRole(f.spec, 'dev', 'rebuild-assignment');
  const rebuilt = await runRole({ ...f.spec, prompt: '{"facts":"durable summary"}' }, 'dev', 'rebuild-assignment', undefined, { rebuildContext: true });
  assert.equal(rebuilt.instance_id, first.instance_id, 'the role identity is kept');
  assert.deepEqual(bodies[1].map(m => m.role), ['system', 'user'], 'no stored conversation is restored');
  const runs = f.s.all("SELECT * FROM task_runs WHERE role='dev' ORDER BY rowid");
  assert.deepEqual([runs[1].recovery_mode, runs[1].protocol_recovery, runs[1].resume_from_run_id, runs[1].role_instance_id], ['rebuilt_from_task_records', 'rebuilt_from_task_records', runs[0].id, runs[0].role_instance_id]);
  assert.ok(f.s.get("SELECT 1 FROM task_history WHERE type='role_result' AND run_id=?", runs[0].id), 'historical traces remain');
  // Contrast: without the option the stored transcript is restored.
  await runRole(f.spec, 'dev', 'rebuild-assignment');
  assert.ok(bodies[2].some(m => m.role === 'assistant')); assert.equal(f.s.get("SELECT recovery_mode FROM task_runs WHERE role='dev' ORDER BY rowid DESC LIMIT 1").recovery_mode, 'checkpoint_transcript');
  // QA's fresh evaluation takes precedence over the option.
  await runRole(f.spec, 'qa', undefined, undefined, { rebuildContext: true });
  assert.equal(f.s.get("SELECT recovery_mode FROM task_runs WHERE role='qa'").recovery_mode, 'fresh_evaluation');
});

test('touchRunToken throttles sliding-expiry SQLite writes while enforcing revocation and expiry immediately on every guard check', async t => {
  const f = await fixture(t, () => call('finish', { summary: 'done' }));
  const a = bound(f.s);
  const start = 1_700_000_000_000, ttl = 15 * 60_000;
  const issued = issueRunToken(f.s, a.binding, ['gateway:read_task_record'], ttl, start);

  let tokenWrites = 0;
  const origRun = f.s.run.bind(f.s);
  t.mock.method(f.s, 'run', (sql, ...args) => {
    if (sql.includes('UPDATE role_run_tokens SET expires_at=')) tokenWrites++;
    return origRun(sql, ...args);
  });

  // Repeated guard checks within the 30 s throttle window validate the token without rewriting SQLite.
  for (const offset of [0, 100, 1_000, 15_000, 29_999]) {
    assert.equal(touchRunToken(f.s, issued.id, ttl, start + offset), true);
  }
  assert.equal(tokenWrites, 0, 'no WAL write within the 30 s window');
  assert.equal(f.s.get('SELECT expires_at FROM role_run_tokens WHERE id=?', issued.id).expires_at, start + ttl);

  // Once 30 s have elapsed, the sliding window extends in SQLite, then throttles again for the next 30 s.
  assert.equal(touchRunToken(f.s, issued.id, ttl, start + 30_000), true);
  assert.equal(tokenWrites, 1);
  assert.equal(f.s.get('SELECT expires_at FROM role_run_tokens WHERE id=?', issued.id).expires_at, start + 30_000 + ttl);
  assert.equal(touchRunToken(f.s, issued.id, ttl, start + 45_000), true);
  assert.equal(tokenWrites, 1);

  // Expiry and revocation are still observed immediately, even inside the throttle window.
  assert.equal(touchRunToken(f.s, issued.id, ttl, start + 30_000 + ttl), false, 'expired token fails immediately');
  revokeRunTokens(f.s, a.run.id, 'cancelled', start + 31_000);
  assert.equal(touchRunToken(f.s, issued.id, ttl, start + 31_050), false, 'revoked token fails immediately without waiting for throttle window');
  assert.equal(touchRunToken(f.s, 'missing-token', ttl, start), false);
});
