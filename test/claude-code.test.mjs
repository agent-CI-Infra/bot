import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { Redactor, TaskError } from '../dist/agent/common.js';
import { runRole, roleRuns } from '../dist/roles/run.js';
import { roleApi } from '../dist/roles/api.js';
import { resolveRole, roleConfiguration, saveConfiguration } from '../dist/roles/definition.js';
import { instanceUsage, revokeRunTokens } from '../dist/roles/role-run.js';
import { claudeCodeRuntime, ClaudeJsonStream } from '../dist/harness/claude-code-protocol.js';
import { claudeBinary } from '../dist/harness/claude-code.js';
import { contentHash } from '../dist/roles/protocol.js';

const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const model = 'claude-sonnet-4-5-20250929';
export async function claudeFixture(t, { mode = 'normal', native = false, respond, gatewayStatus = 200, wrongModel = false } = {}) {
  mkdirSync('.tmp/claude-tests', { recursive: true }); const root = mkdtempSync(resolve('.tmp/claude-tests/run-'));
  const s = new Store(join(root, 'db'), randomBytes(32));
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/OpenToday','o','a')");
  s.run("INSERT INTO repositories VALUES('other','private/other','o','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt) VALUES('t','r','task.request','running','Claude protocol fixture','{}',1)");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('o','other','task.request','running','Secret other task','{}')");
  const records = new TaskRecords(s); records.contract('t', { goal: 'read a random fact ' + randomBytes(16).toString('hex'), scope: ['fixture'], criteria: ['Read via broker'], endpoint: 'report' });
  let modelCalls = 0;
  const server = createServer(async (req, res) => {
    try {
      const token = req.headers['x-api-key'];
      assert.equal(token, 'service-key-fixture-170');
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(gatewayStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: wrongModel ? 'unavailable' : model }] })); return;
      }
      modelCalls++; if (respond) { await respond(req, res, modelCalls, s); return; }
      res.writeHead(mode === 'rate_error' ? 429 : 503); res.end('{}');
    } catch (e) { res.writeHead(401); res.end('{}'); }
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const file = join(root, 'config.json'), config = { command: native ? claudeBinary() : resolve('test/fixtures/claude-code.mjs'), version: claudeCodeRuntime.version, stateDirectory: join(root, 'sessions'), model, timeoutMs: native ? 30_000 : 5000 };
  const credentialFile = join(root, 'service.key'); writeFileSync(credentialFile, 'service-key-fixture-170', { mode: 0o600 }); config.provider = { baseUrl: 'http://127.0.0.1:' + server.address().port, credentialFile };
  writeFileSync(file, JSON.stringify(config)); const old = process.env.BOT_CLAUDE_CODE_CONFIG; process.env.BOT_CLAUDE_CODE_CONFIG = file;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); s.close(); if (old === undefined) delete process.env.BOT_CLAUDE_CODE_CONFIG; else process.env.BOT_CLAUDE_CODE_CONFIG = old; rmSync(root, { recursive: true, force: true }); });
  const spec = { store: s, task: s.get("SELECT * FROM tasks WHERE id='t'"), redactor: new Redactor(), guard: async () => {}, system: 'Execute only the assigned protocol probe.', prompt: JSON.stringify({ task_ref: 'task:t', fixture_mode: mode }), maxTurns: 8,
    tools: [tool('read_task_record'), tool('finish')], finish: { name: 'finish', validate: v => { if (!v?.summary) throw new TaskError('role_result_invalid', 'retry_wait'); return v; } } };
  return { s, spec, root, config, file, get modelCalls() { return modelCalls; }, state() { return JSON.parse(s.get("SELECT harness_state FROM role_instances WHERE role='dev'").harness_state); } };
}

test('Claude Code protocol fixture: seven RoleRun operations, gateway receipts, exact resume and cumulative usage', async t => {
  const f = await claudeFixture(t), prepared = await roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code');
  assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, 0, 'prepare never starts the agent');
  const handle = await roleRuns.start(prepared); assert.equal(await roleRuns.start(prepared), handle);
  const result = await roleRuns.collect(handle), state = f.state(); assert.equal(result.result.summary, 'read through gateway');
  const page = roleRuns.events(f.s, handle.run_id); assert.ok(page.ended); assert.ok(page.events.some(e => e.type === 'session_bound'));
  assert.equal(page.events.at(-1).data.candidate_ref.kind, 'artifact');
  const first = f.s.get('SELECT * FROM task_runs ORDER BY rowid DESC LIMIT 1');
  // Session paths and persisted fingerprints must keep the pre-stage-scheduler JSON hashing contract.
  const legacyHash=value=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex'),ctx=JSON.parse(first.run_context);
  assert.equal(dirname(state.directory),join(f.config.stateDirectory,legacyHash(state.scope)));
  assert.equal(state.configurationHash,legacyHash({...prepared.wrapped.harnessPreparation.config,command:prepared.wrapped.harnessPreparation.command,protocol:claudeCodeRuntime.protocol}));
  assert.equal(state.inputHash,legacyHash({source:ctx.source_ref,contract:ctx.contract_revision,candidate:ctx.candidate_ref,role:ctx.role_revision,policy:ctx.policy_revision,skills:ctx.skill_revisions,model:ctx.model_revision}));
  const recovered = await roleRuns.recover(f.spec, 'dev', undefined, first.id, null, 'claude_code');
  await roleRuns.collect(recovered.handle); assert.equal(f.state().sessionId, state.sessionId); assert.equal(f.state().recoveryMode, 'native_resume');
  assert.notEqual(recovered.handle.run_id, first.id); assert.ok(recovered.handle.lease_epoch > first.lease_epoch);
  assert.equal(f.s.get('SELECT protocol_recovery FROM task_runs WHERE id=?', recovered.handle.run_id).protocol_recovery, 'native_resume');
  const usage = instanceUsage(f.s, result.instance_id); assert.equal(usage.model_requests, 4); assert.equal(usage.output_tokens, 28); assert.equal(usage.unpriced_requests, 4);
  assert.equal(f.s.get('SELECT count(*) n FROM model_requests').n, 0); assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status, 'running');
  const trace = JSON.stringify(f.s.all('SELECT * FROM task_history')); assert.ok(!trace.includes('PRIVATE_FIXTURE_REASONING')); assert.ok(!trace.includes('PRIVATE_RAW_OBSERVATION')); assert.ok(!trace.includes('rrt_'));
  const launch = JSON.parse(readFileSync(join(state.directory, 'home', 'launch.json')));
  assert.ok(launch.args.includes('--bare')); assert.ok(launch.args.includes('--restricted')); assert.ok(!launch.args.includes('--dangerously-skip-permissions')); assert.ok(!launch.env_names.includes('NODE_OPTIONS')); assert.ok(!launch.env_names.includes('GH_TOKEN'));
});

test('Claude Code protocol fixture: reviewers and QA use fresh contexts; missing native session rebuilds honestly', async t => {
  const f = await claudeFixture(t); await runRole(f.spec, 'dev', undefined, 'claude_code'); const dev = f.state();
  await runRole(f.spec, 'reviewer', undefined, 'claude_code'); await runRole(f.spec, 'qa', undefined, 'claude_code'); await runRole(f.spec, 'qa');
  const sessions = f.s.all('SELECT role,harness_state FROM role_instances').map(r => ({ role: r.role, state: JSON.parse(r.harness_state) }));
  assert.equal(new Set(sessions.map(r => r.state.sessionId)).size, 3); assert.equal(sessions.find(r => r.role === 'qa').state.recoveryMode, 'fresh_evaluation');
  rmSync(join(dev.directory, 'home', '.claude', 'projects'), { recursive: true }); await runRole(f.spec, 'dev');
  assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records'); assert.notEqual(f.state().sessionId, dev.sessionId);
});

test('Claude Code protocol fixture: cross-task session binding is refused before resuming; changed contract rebuilds', async t => {
  const f = await claudeFixture(t); await runRole(f.spec, 'dev', undefined, 'claude_code'); const state = f.state();
  f.s.run("UPDATE role_instances SET harness_state=? WHERE role='dev'", JSON.stringify({ ...state, scope: { ...state.scope, task_id: 'o' } }));
  await assert.rejects(runRole(f.spec, 'dev'), { code: 'claude_session_scope_mismatch' });
  f.s.run("UPDATE role_instances SET harness_state=? WHERE role='dev'", JSON.stringify(state));
  f.s.run("UPDATE task_records SET revision=revision+1 WHERE task_id='t'"); await runRole(f.spec, 'dev');
  assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records');
  const prior = f.state().sessionId; f.s.run("UPDATE tasks SET head_sha=? WHERE id='t'", 'a'.repeat(40)); f.spec.task.head_sha = 'a'.repeat(40);
  await runRole(f.spec, 'dev'); assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records'); assert.notEqual(f.state().sessionId, prior);
  const legacy = f.state(); delete legacy.scope; legacy.version = 'other-backend';
  f.s.run("UPDATE role_instances SET harness_state=? WHERE role='dev'", JSON.stringify(legacy));
  await runRole(f.spec, 'dev'); assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records'); assert.notEqual(f.state().sessionId, legacy.sessionId);
});

for (const [mode, code] of Object.entries({ malformed: 'claude_protocol_incompatible', invalid_utf8: 'claude_protocol_incompatible', truncated: 'claude_stream_truncated', exit: 'claude_process_exit', no_result: 'claude_result_missing', no_submit: 'claude_submission_required', bad_report: 'claude_submission_required', extra_tool: 'claude_capability_mismatch', budget: 'claude_budget_exhausted', after_result: 'claude_protocol_incompatible', auth_error: 'claude_authentication_failed', model_error: 'claude_model_unavailable', rate_error: 'claude_rate_limited', transport_error: 'claude_transport_error' })) test('Claude Code protocol fixture refuses ' + mode, async t => {
  const f = await claudeFixture(t, { mode }); await assert.rejects(runRole(f.spec, 'dev', undefined, 'claude_code'), { code });
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0);
  assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status, 'running');
});

for (const [options, code] of [[{ gatewayStatus: 401 }, 'claude_authentication_failed'], [{ gatewayStatus: 429 }, 'claude_rate_limited'], [{ wrongModel: true }, 'claude_model_unavailable']]) test('Claude Code pre-start gateway validation: ' + code, async t => {
  const f = await claudeFixture(t, options); await assert.rejects(runRole(f.spec, 'dev', undefined, 'claude_code'), { code }); assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='harness_event' AND json_extract(data,'$.type')='session_bound'").n, 0);
});

test('Claude Code protocol fixture: bounded text, fragmented UTF-8, denied prompts and foreign task refs', async t => {
  for (const mode of ['fragmented', 'long_text', 'permission', 'wrong_ref']) await t.test(mode, async t => {
    const f = await claudeFixture(t, { mode }); await runRole(f.spec, 'dev', undefined, 'claude_code');
    const trace = JSON.stringify(f.s.all('SELECT data FROM task_history'));
    assert.ok(!trace.includes('Secret other task'));
    if (mode === 'fragmented') assert.ok(trace.includes('核对通过'));
    if (mode === 'long_text') assert.ok(trace.includes('output_truncated'));
    if (mode === 'permission') assert.ok(f.s.all("SELECT data FROM task_history WHERE type='harness_event'").map(r => JSON.parse(r.data)).some(e => e.type === 'permission' && e.decision === 'deny'));
    if (mode === 'wrong_ref') assert.ok(trace.includes('task_record_not_found'));
  });
});

test('Claude Code protocol fixture: checkpoint, cancellation reaps descendants and rejects late submission', async t => {
  const f = await claudeFixture(t, { mode: 'wait' }), p = await roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code'), h = await roleRuns.start(p);
  for (let i = 0; i < 100 && !f.s.get("SELECT harness_state FROM role_instances WHERE harness_state<>'{}'"); i++) await new Promise(r => setTimeout(r, 20));
  const state = f.state(), checkpoint = await roleRuns.checkpoint(h); assert.equal(checkpoint.session.external_session.session_id, state.sessionId); assert.ok(checkpoint.session.external_session.sha256);
  const pid = Number(readFileSync(join(state.directory, 'home', 'child.pid')));
  const receipt = await roleRuns.cancel(h, 'test'); assert.ok(receipt.settled); await assert.rejects(roleRuns.collect(h), { code: 'harness_cancelled' });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0);
});

test('Claude Code protocol fixture: revoke a live lease and the driver stops without collecting', async t => {
  const f = await claudeFixture(t, { mode: 'late' }), p = await roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code'), h = await roleRuns.start(p);
  revokeRunTokens(f.s, h.run_id, 'test'); await assert.rejects(roleRuns.collect(h), e => ['run_token_revoked', 'claude_authentication_failed'].includes(e.code));
});

test('Claude Code rejects invalid/personal config, model aliases, version drift and unsupported isolated profile', async t => {
  const f = await claudeFixture(t);
  for (const change of [{ version: 'latest' }, { model: 'sonnet' }, { env: { ANTHROPIC_API_KEY: 'personal' } }, { gatewayUrl: 'https://api.anthropic.com' }]) {
    writeFileSync(f.file, JSON.stringify({ ...f.config, ...change })); await assert.rejects(roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code'), e => ['claude_configuration_invalid', 'claude_restricted_gateway_required'].includes(e.code));
  }
  const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] }, url = new URL('http://local/api/repositories/r/roles'), revision = roleApi(f.s, admin, 'GET', url, {}).revision;
  assert.throws(() => roleApi(f.s, admin, 'PUT', url, { expected_revision: revision, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, environment_profile_ref: { id: 'isolated-workspace' } }] }), { code: 'unsupported_capability' });
});

test('wire parser rejects oversized and unterminated records without retaining private fields', () => {
  assert.throws(() => new ClaudeJsonStream(() => {}, 8).push(Buffer.from('xxxxxxxxx')), { code: 'claude_output_limit' });
  const stream = new ClaudeJsonStream(() => {}); stream.push(Buffer.from('{"type":')); assert.throws(() => stream.end(), { code: 'claude_stream_truncated' });
});

test('Claude Code rejects model/config drift during recovery and accounts metered limits across runs', async t => {
  await t.test('model drift', async t => {
    const f = await claudeFixture(t); await runRole(f.spec, 'dev', undefined, 'claude_code');
    writeFileSync(f.file, JSON.stringify({ ...f.config, model: 'claude-opus-4-1-20250805' }));
    await assert.rejects(runRole(f.spec, 'dev'), { code: 'model_revision_changed' });
  });
  await t.test('cumulative requests', async t => {
    const f = await claudeFixture(t), admin = { id: 'admin', role: 'project_admin', repositories: ['r'] }, url = new URL('http://local/api/repositories/r/roles');
    roleApi(f.s, admin, 'PUT', url, { expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_model_requests: 3 } }] });
    await runRole(f.spec, 'dev'); await assert.rejects(runRole(f.spec, 'dev'), { code: 'role_budget_exhausted' });
    assert.equal(instanceUsage(f.s, f.s.get("SELECT id FROM role_instances WHERE role='dev'").id).model_requests, 3);
    const count = f.s.get('SELECT count(*) n FROM task_runs').n; await assert.rejects(runRole(f.spec, 'dev'), { code: 'role_budget_exhausted' }); assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, count);
  });
  await t.test('unknown monetary ledger', async t => {
    const f = await claudeFixture(t), admin = { id: 'admin', role: 'project_admin', repositories: ['r'] }, url = new URL('http://local/api/repositories/r/roles');
    roleApi(f.s, admin, 'PUT', url, { expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_cost: { amount: 1, currency: 'USD' } } }] });
    await assert.rejects(runRole(f.spec, 'dev'), { code: 'claude_cost_budget_unsupported' }); assert.equal(f.modelCalls, 0);
  });
  await t.test('missing CLI result usage remains unknown but does not permanently block retry', async t => {
    const f = await claudeFixture(t, { mode: 'unknown_usage' }), first = await runRole(f.spec, 'dev', undefined, 'claude_code');
    assert.equal(instanceUsage(f.s, first.instance_id).unknown_requests, 2); assert.equal(instanceUsage(f.s, first.instance_id).semantics, 'lower_bound');
    const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] }, url = new URL('http://local/api/repositories/r/roles');
    roleApi(f.s, admin, 'PUT', url, { expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_total_tokens: 1000 } }] });
    f.spec.prompt = JSON.stringify({ task_ref: 'task:t', fixture_mode: 'normal' });
    await runRole(f.spec, 'dev'); assert.equal(instanceUsage(f.s, first.instance_id).unknown_requests, 2);
  });
});

// Synthetic Anthropic SSE; the native CLI, not this helper, produces the harness NDJSON events.
function providerReply(res, { id, content, args = {}, input = 5, output = 777, textBlock = false }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': id });
  const event = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
  event('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } });
  let index = 0;
  if (textBlock) { event('content_block_start', { index, content_block: { type: 'text', text: '' } }); event('content_block_delta', { index, delta: { type: 'text_delta', text: 'Public preparation.' } }); event('content_block_stop', { index }); index++; }
  event('content_block_start', { index, content_block: content });
  if (content.type === 'tool_use') event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
  event('content_block_stop', { index });
  event('message_delta', { delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: output } }); event('message_stop', {}); res.end();
}

// Real pinned native executable + synthetic Anthropic wire server. This proves CLI/MCP compatibility, never live-model QA.
test('pinned native Claude Code binary uses stream-json, bare restrictions and real broker calls (synthetic provider)', async t => {
  let nativeToolCalls = 0, nativeRequests = 0;
  const f = await claudeFixture(t, { native: true, provider: true, respond: async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    assert.equal(body.model, model);
    const observing = body.system.some(c => c.text?.includes('INDEPENDENT_REVIEW_PROBE'));
    if (observing) assert.ok(!raw.includes('DEV_PRIVATE_MARKER_170'));
    assert.ok(!raw.includes('MALICIOUS_AUTOLOADED_CONTEXT'));
    const names = body.tools.map(t => t.name); assert.ok(names.includes('mcp__bot__read_task_record')); assert.ok(!names.includes('Bash')); assert.ok(!names.includes('Read')); assert.ok(!names.includes('Agent'));
    const start = body.messages.findLastIndex(m => m.role === 'user' && (typeof m.content === 'string' ? m.content.includes('fixture_mode') : m.content?.some(c => c.type === 'text' && c.text.includes('fixture_mode'))));
    const current = body.messages.slice(Math.max(0, start));
    const alreadyRead = current.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use' && c.name === 'mcp__bot__read_task_record'));
    const submitted = current.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use' && c.name === 'mcp__bot__finish'));
    const called = name => current.some(m => m.role === 'assistant' && m.content?.some(c => c.type === 'tool_use' && c.name === name));
    const name = !alreadyRead ? 'mcp__bot__read_task_record' : !observing && !called('mcp__bot__write_file') ? 'mcp__bot__write_file' : !called('mcp__bot__run_command') ? 'mcp__bot__run_command' : 'mcp__bot__finish';
    const args = { mcp__bot__read_task_record: { ref: 'task:t' }, mcp__bot__write_file: { path: 'add.mjs', content: 'export const add = (a, b) => a + b;\n' }, mcp__bot__run_command: { command: 'node --test add.test.mjs' }, mcp__bot__finish: observing ? { summary: 'Preseeded defect detected', findings: [{ description: 'add returns one too many', evidence: ['node --test add.test.mjs exited 1'] }], inspected_scope: ['add.mjs'], unknowns: [] } : { summary: 'Real CLI read the broker' } }[name];
    const content = submitted ? { type: 'text', text: 'Submitted.' } : { type: 'tool_use', id: 'toolu_native_' + (++nativeToolCalls), name, input: {} };
    providerReply(res, { id: 'msg_native_' + (++nativeRequests), content, args, textBlock: !submitted });
  } });
  const code = join(f.root, 'candidate'); mkdirSync(code); let active = code;
  writeFileSync(join(code, 'add.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(code, 'add.test.mjs'), 'import {add} from "./add.mjs"; import assert from "node:assert/strict"; assert.equal(add(2,3),5);\n');
  const commandOptions = { cwd: code, encoding: 'utf8', timeout: 5000, env: { LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] };
  assert.throws(() => execFileSync(process.execPath, ['--test', 'add.test.mjs'], commandOptions), e => e.status === 1);
  let writes = 0, observation;
  saveConfiguration(f.s, 'r', { expected_revision: 0, enabled: true, roles: [{ role_id: 'dev', harness_ref: {id:'claude_code'}, persona_prompt: 'DEV_PRIVATE_MARKER_170' }] }, 'fixture');
  f.spec.tools.push(tool('write_file'), tool('run_command'));
  f.spec.execute = async (name, args) => {
    if (name === 'write_file') { assert.equal(args.path, 'add.mjs'); if (readFileSync(join(code, args.path), 'utf8') !== args.content) { writeFileSync(join(code, args.path), args.content); writes++; } return { written: true }; }
    assert.equal(name, 'run_command'); assert.equal(args.command, 'node --test add.test.mjs');
    // NODE_TEST_CONTEXT from the outer runner would make the nested node --test silently skip its files.
    let stdout, exit_code = 0; try { stdout = execFileSync(process.execPath, ['--test', 'add.test.mjs'], { ...commandOptions, cwd: active }); assert.match(stdout, /# pass 1/); } catch (e) { exit_code = e.status; stdout = String(e.stdout); }
    observation = { command: args.command, exit_code, stdout, candidate_hash: contentHash(readFileSync(join(active, 'add.mjs'), 'utf8')) }; return observation;
  };
  f.spec.finish.validate = v => { assert.equal(observation.exit_code, 0); assert.equal(contentHash(readFileSync(join(code, 'add.mjs'), 'utf8')), observation.candidate_hash); return { ...v, evidence: observation }; };
  const output = await runRole(f.spec, 'dev', undefined, 'claude_code');
  assert.equal(output.result.summary, 'Real CLI read the broker'); assert.ok(f.modelCalls >= 2);
  let measured = instanceUsage(f.s, output.instance_id); assert.equal(measured.model_requests, nativeRequests); assert.equal(measured.output_tokens, nativeRequests * 777); assert.equal(measured.unknown_requests, 0);
  const reconciled = f.s.all("SELECT data FROM task_history WHERE type='harness_event' AND json_extract(data,'$.stage')='usage_reconciliation'").map(r => JSON.parse(r.data)); assert.ok(reconciled.some(r => r.cli_result_usage.output_tokens === measured.output_tokens && r.matches));
  assert.equal(f.state().version, '2.1.319'); assert.ok(f.s.get("SELECT 1 FROM task_history WHERE type='gateway_call'"));
  const state = f.state(), poison = join(f.root, 'hook-ran');
  mkdirSync(join(state.cwd, '.claude'), { recursive: true });
  writeFileSync(join(state.cwd, 'CLAUDE.md'), 'MALICIOUS_AUTOLOADED_CONTEXT');
  writeFileSync(join(state.cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch ' + poison }] }] } }));
  writeFileSync(join(state.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { poison: { command: 'touch', args: [poison] } } }));
  await runRole(f.spec, 'dev'); assert.equal(f.state().recoveryMode, 'native_resume'); assert.ok(!existsSync(poison)); assert.equal(writes, 1); measured = instanceUsage(f.s, output.instance_id); assert.equal(measured.model_requests, nativeRequests); assert.equal(measured.output_tokens, nativeRequests * 777); assert.equal(measured.unknown_requests, 0);
  active = join(f.root, 'review-candidate'); mkdirSync(active);
  writeFileSync(join(active, 'add.mjs'), 'export const add = (a, b) => a + b + 1;\n'); writeFileSync(join(active, 'add.test.mjs'), readFileSync(join(code, 'add.test.mjs')));
  const fixedHash = contentHash(readFileSync(join(active, 'add.mjs'), 'utf8'));
  const candidate = new TaskRecords(f.s).submit('t', [{ kind: 'file', reference: 'artifact:seeded-arithmetic', version: fixedHash, content: { path: 'add.mjs', content_hash: fixedHash } }], [], { fixture: true });
  saveConfiguration(f.s, 'r', { expected_revision: 1, enabled: true, roles: [{ role_id: 'reviewer', harness_ref: {id:'claude_code'}, persona_prompt: 'INDEPENDENT_REVIEW_PROBE' }] }, 'fixture');
  const review = await runRole({ ...f.spec, tools: f.spec.tools.filter(t => t.function.name !== 'write_file'), finish: { name: 'finish', validate: value => { assert.equal(observation.exit_code, 1); assert.equal(observation.candidate_hash, fixedHash); assert.ok(value.findings.length); return { ...value, candidate_hash: fixedHash, test: observation }; } } }, 'reviewer', undefined, 'claude_code');
  assert.ok(review.result.findings.length); assert.notEqual(JSON.parse(f.s.get("SELECT harness_state FROM role_instances WHERE role='reviewer'").harness_state).sessionId, state.sessionId);
  const reviewRun = f.s.get("SELECT id FROM task_runs WHERE role='reviewer' ORDER BY rowid DESC LIMIT 1"); assert.equal(roleRuns.events(f.s, reviewRun.id).events.at(-1).data.input_candidate_ref.ref, 'candidate:' + candidate.id);
  assert.ok(!JSON.stringify(f.s.all('SELECT data FROM task_history')).includes('service-key-fixture-170'));
});

test('Claude collect uses the trusted workspace snapshot and fails closed if the snapshot is unavailable', async t => {
  await t.test('framework snapshot', async t => {
    const f = await claudeFixture(t), snapshot = { tree_sha: 'a'.repeat(40), local_sha: 'b'.repeat(40) };
    const p = await roleRuns.prepare({ ...f.spec, candidateSnapshot: async () => snapshot }, 'dev', undefined, 'claude_code'), result = await roleRuns.collect(await roleRuns.start(p));
    assert.equal(result.candidate_ref.kind, 'code'); assert.equal(result.candidate_ref.tree_hash, snapshot.tree_sha); assert.equal(result.candidate_ref.commit_sha, snapshot.local_sha);
  });
  await t.test('snapshot failure', async t => {
    const f = await claudeFixture(t), p = await roleRuns.prepare({ ...f.spec, candidateSnapshot: async () => null }, 'dev', undefined, 'claude_code');
    await assert.rejects(roleRuns.collect(await roleRuns.start(p)), { code: 'role_snapshot_unavailable' });
    assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0); assert.equal(f.s.get('SELECT count(*) n FROM role_run_tokens WHERE revoked_at IS NULL').n, 0);
  });
});

test('pinned native CLI + synthetic provider: max-turns result exits 1 and is a non-retryable budget stop', async t => {
  const f = await claudeFixture(t, { native: true, respond: async (req, res, n) => {
    for await (const chunk of req) {}
    providerReply(res, { id: 'msg_budget_' + n, content: { type: 'tool_use', id: 'toolu_budget_' + n, name: 'mcp__bot__read_task_record', input: {} }, args: { ref: 'task:t' } });
  } });
  await assert.rejects(runRole({ ...f.spec, maxTurns: 1 }, 'dev', undefined, 'claude_code'), e => e.code === 'claude_budget_exhausted' && e.state === 'needs_replan');
  const events = f.s.all("SELECT data FROM task_history WHERE type='harness_event'").map(r => JSON.parse(r.data));
  assert.ok(events.some(e => e.stage === 'process_exit' && e.result_subtype === 'error_max_turns' && e.exit_code === 1));
  const run = f.s.get('SELECT * FROM task_runs ORDER BY rowid DESC LIMIT 1'); assert.equal(run.stop_reason, 'claude_budget_exhausted');
  const { explainFailure } = await import('../dist/agent/failures.js'); assert.equal(explainFailure('claude_budget_exhausted', 'needs_replan').automatic, false);
  const measured = instanceUsage(f.s, run.role_instance_id); assert.equal(measured.output_tokens, 777); assert.equal(measured.model_requests, 1); assert.equal(measured.unknown_requests, 0);
});

test('Claude protocol fixture + synthetic provider: a metered 429 rejection can retry the same role instance', async t => {
  const f = await claudeFixture(t, { mode: 'rate_error', respond: async (req, res) => { for await (const chunk of req) {} res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Synthetic rate limit' } })); } });
  const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] }, url = new URL('http://local/api/repositories/r/roles');
  roleApi(f.s, admin, 'PUT', url, { expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_total_tokens: 100000 } }] });
  await assert.rejects(runRole(f.spec, 'dev'), e => e.code === 'claude_rate_limited' && e.state === 'retry_wait');
  const id = f.s.get("SELECT id FROM role_instances WHERE role='dev'").id;
  assert.equal(f.modelCalls, 1); assert.equal(instanceUsage(f.s, id).unknown_requests, 0); assert.equal(instanceUsage(f.s, id).model_requests, 1);
  f.spec.prompt = JSON.stringify({ task_ref: 'task:t', fixture_mode: 'normal' });
  const next = await runRole(f.spec, 'dev'); assert.equal(next.instance_id, id); assert.equal(next.result.summary, 'read through gateway'); assert.equal(instanceUsage(f.s, id).unknown_requests, 0);
});

test('Claude configuration refuses external gateway profiles and controller roles before CLI startup', async t => {
  const f = await claudeFixture(t), { provider, ...external } = f.config;
  writeFileSync(f.file, JSON.stringify({ ...external, gatewayUrl: provider.baseUrl }));
  await assert.rejects(roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code'), { code: 'claude_configuration_invalid' });
  writeFileSync(f.file, JSON.stringify(f.config));
  const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] }, url = new URL('http://local/api/repositories/r/roles');
  for (const role of ['coordinator', 'manager']) {
    assert.throws(() => roleApi(f.s, admin, 'PUT', url, { expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision, enabled: true, roles: [{ role_id: role, harness_ref: { id: 'claude_code' } }] }), { code: 'harness_role_unsupported' });
    await assert.rejects(runRole(f.spec, role, undefined, 'claude_code'), { code: 'harness_role_unsupported' });
  }
  const { runClaudeCode } = await import('../dist/harness/claude-code.js');
  await assert.rejects(runClaudeCode({ ...f.spec, harnessPreparation: { config: f.config }, runContext: () => ({ execution_context: { kind: 'controller' } }), runAccess: { token: 'unusable-capability', check() {} } }, {}, new AbortController().signal, () => {}), { code: 'harness_role_unsupported' });
  assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, 0);
});

test('Claude admission refuses legacy and stored V2 controllers, including explicit and pinned backend overrides', async t => {
  const f = await claudeFixture(t), legacy = { enabled: true, harnesses: { coordinator: 'claude_code', manager: 'claude_code', dev: 'claude_code' } };
  const v2 = { ...roleConfiguration(f.s, 'r', legacy), revision: 1 }; delete v2.legacy;
  for (const config of [legacy, v2]) {
    f.s.run("INSERT OR REPLACE INTO settings VALUES('roles:r',?)", JSON.stringify(config));
    for (const role of ['coordinator', 'manager']) {
      for (const options of [{}, { harness: 'claude_code' }, { harness: 'claude_code', pinned: true }])
        assert.throws(() => resolveRole(f.s, 'r', role, 'task.request', { ...options, persist: false }), { code: 'harness_role_unsupported' });
      await assert.rejects(runRole(f.spec, role), { code: 'harness_role_unsupported' });
      await assert.rejects(runRole(f.spec, role, undefined, 'claude_code'), { code: 'harness_role_unsupported' });
    }
  }
  assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, 0, 'no controller run is started');
});

test('Claude protocol fixture: an explicitly saved dev backend is retained by configurable entry executors', async t => {
  const f = await claudeFixture(t), admin = { id: 'admin', role: 'project_admin', repositories: ['r'] }, url = new URL('http://local/api/repositories/r/roles');
  const saved = roleApi(f.s, admin, 'PUT', url, { expected_revision: 0, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' } }] }).configuration;
  assert.equal(saved.roles.find(r => r.role_id === 'dev').entry_harness_source, 'role');
  const resolved = resolveRole(f.s, 'r', 'dev', 'task.request', { entryExecutor: true, persist: false });
  assert.deepEqual([resolved.snapshot.kind, resolved.snapshot.harness.id, resolved.snapshot.model.source], ['writer', 'claude_code', 'external_harness']);
  const result = await runRole(f.spec, 'dev', undefined, undefined, { entryExecutor: true });
  assert.equal(result.result.summary, 'read through gateway');
  assert.equal(f.s.get("SELECT harness FROM task_runs WHERE role='dev' ORDER BY rowid DESC LIMIT 1").harness, 'claude_code');
});

test('Claude smoke probe requires an explicit public launch profile', t => {
  mkdirSync('.tmp/claude-smoke-env', { recursive: true }); const root = resolve('.tmp/claude-smoke-env');
  assert.throws(() => execFileSync(process.execPath, ['scripts/claude-code-smoke.mjs', join(root, 'must-not-create')], { env: { LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] }), e => e.status === 1 && String(e.stderr).includes('BOT_CLAUDE_CODE_CONFIG'));
  assert.equal(existsSync(join(root, 'must-not-create')), false);
});
