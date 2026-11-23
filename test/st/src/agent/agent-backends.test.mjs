// These fixtures model the control-plane model boundary, so explicitly select gateway mode.
process.env.BOT_HARNESS_MODEL_TRANSPORT='gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { roleApi, roleProbeApi } from '../../../../dist/roles/api.js';
import { agentBackends } from '../../../../dist/roles/backends.js';
import { explainFailure } from '../../../../dist/agent/failures.js';
import { roleWorkspaces, controllerWorkspace } from '../../../../dist/roles/workspace.js';
import { runTeam } from '../../../../dist/roles/team.js';
import { roleExecutionModel, runRole } from '../../../../dist/roles/run.js';
import { evaluateDelivery } from '../../../../dist/tasks/acceptance.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { writeICodeProduct } from '../../../fixtures/icode-product.mjs';

const tool = (name, properties = {}, required = []) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const text = value => typeof value === 'string' ? value : (value ?? []).map(v => v.text ?? '').join('');
const observations = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(text(m.content)));
const called = (body, name) => body.messages.some(m => m.tool_calls?.some(c => c.function.name === name));
const sdk = existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json');
const skip = !sdk && process.env.BOT_REQUIRE_PI !== '1' ? 'Pi SDK is not installed' : false;
const verdict = { outcome: 'pass', reason: 'The fixed candidate contains the requested report.', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };

async function fixture(t, respond) {
  const root = mkdtempSync(join(tmpdir(), 'agent-backends-')), s = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root), requests = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: await respond(body) }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await manager.recover(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); s.close(); rmSync(root, { recursive: true, force: true }); });
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('101','fixture/backends','o','a')");
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${server.address().port}/v1`, 'fixture', s.secrets.seal({ value: 'fixture-key' }, 'model:m'), 'now');
  s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  const env = await manager.call('PUT', '/v1/projects/101');
  for (const id of ['t', 'other']) {
    s.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)', id, '101', 'task.request', 'running', 'Report', '{}', 1, env.generation, randomBytes(24).toString('hex'));
    new TaskRecords(s).contract(id, { goal: 'Write and inspect the report', scope: ['report.md'], criteria: ['Report contains baseline'], endpoint: 'artifact' });
  }
  const admin = { id: 'admin', role: 'project_admin', repositories: ['101'] }, url = new URL('http://local/api/repositories/101/roles');
  const put = body => roleApi(s, admin, 'PUT', url, { enabled: true, expected_revision: roleApi(s, admin, 'GET', url, {}).revision, ...body }).configuration;
  const task = s.get("SELECT * FROM tasks WHERE id='t'"), redactor = new Redactor(), guard = async () => {};
  const workspace = new Workspace(s, manager, task, redactor, guard, () => {});
  return { root, s, manager, requests, task, redactor, guard, workspace, put, view: () => roleApi(s, admin, 'GET', url, {}) };
}

test('new roles default to Pi; general backends preserve role authority and container backends also support controllers', async t => {
  const f = await fixture(t, () => call('finish', {}));
  const config = f.put({ roles: [{ role_id: 'security' }] });
  assert.ok(config.roles.every(r => r.harness_ref.id === 'pi'));
  for (const backend of ['native', 'process', 'pi']) {
    const saved = f.put({ roles: config.roles.map(r => ({ role_id: r.role_id, harness_ref: { id: backend } })) });
    assert.ok(saved.roles.every(r => r.harness_ref.id === backend));
    assert.equal(saved.roles.find(r => r.role_id === 'manager').permissions.delegation, 'allow');
    assert.equal(saved.roles.find(r => r.role_id === 'qa').output_schema_ref.id, 'acceptance-verdict');
  }
  const claude = f.view().backends.find(b => b.id === 'claude_code');
  assert.equal(claude.available, true);
  assert.deepEqual(claude.kinds, ['controller', 'writer', 'observer', 'evaluator']);
  assert.deepEqual(claude.supported_model_sources, ['gateway', 'local_config']);
  assert.ok(claude.runtime_status && typeof claude.runtime_status.compatible_range === 'string');
  const saved = f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' } }] });
  assert.equal(saved.roles.find(r => r.role_id === 'dev').harness_ref.id, 'claude_code');
  assert.equal(f.put({ roles: [{ role_id: 'manager', harness_ref: { id: 'claude_code' } }] }).roles.find(r => r.role_id === 'manager').harness_ref.id, 'claude_code');
  // Codex App Server (#171 / #705) is a container worker backend like Claude Code.
  const codex = f.view().backends.find(b => b.id === 'codex');
  assert.deepEqual([codex.available, codex.kinds, codex.model_source, codex.supported_model_sources, codex.integration_issue], [true, ['controller', 'writer', 'observer', 'evaluator'], 'project', ['gateway', 'local_config'], null]);
  assert.equal(f.put({ roles: [{ role_id: 'dev', harness_ref: { id: 'codex' } }] }).roles.find(r => r.role_id === 'dev').harness_ref.id, 'codex');
  assert.equal(f.put({ roles: [{ role_id: 'manager', harness_ref: { id: 'codex' } }] }).roles.find(r => r.role_id === 'manager').harness_ref.id, 'codex');
  for (const backend of ['acp', 'opencode']) {
    const view = f.view();
    assert.equal(view.backends.find(b => b.id === backend), undefined);
    assert.throws(() => f.put({ roles: [{ role_id: 'dev', harness_ref: { id: backend } }] }), e => e.code === 'unknown_role_harness' && e.field === 'roles.dev.harness_ref.id');
    assert.equal(f.view().revision, view.revision);
  }
  assert.equal(f.view().recommended_backend, 'pi');
});

test('non-entry Pi reserves four of sixteen requests and refuses closed exploration calls', {skip,timeout:90000}, async t => {
  let requests=0;
  const f=await fixture(t,body=>{
    const turn=++requests,names=body.tools.map(t=>t.function.name);
    if(turn<=12){assert.ok(names.includes('read_file'));return call('read_file',{path:'report.md'});}
    assert.deepEqual(names,['finish']);
    assert.ok(body.messages.some(message=>text(message.content).includes(`${17-turn} turns left`)));
    if(turn===13)return call('read_file',{path:'report.md'});
    assert.ok(observations(body).some(result=>result.error==='tool_not_allowed'));
    return call('finish',{summary:'submitted within the reserved requests'});
  });
  t.after(()=>{if(requests!==14)t.diagnostic(`Expected 14 provider requests, observed ${requests}`);});
  f.put({roles:[{role_id:'dev',harness_ref:{id:'pi'},budget_policy_ref:{id:'bounded',max_turns:16}}]});
  const result=await runRole({store:f.s,task:f.task,redactor:f.redactor,guard:f.guard,cancelSignal:t.signal,system:'Inspect the retained report',prompt:'Read the task, then submit',
    tools:[tool('read_file',{path:{type:'string'}},['path']),tool('finish',{summary:{type:'string'}},['summary'])],execute:async()=>({content:'retained report'}),finish:{name:'finish',validate:value=>value},finalizationTools:['finish'],maxTurns:16},
    'dev',undefined,'pi',{prepare:controllerWorkspace(f.workspace)});
  assert.equal(requests,14);assert.equal(result.result.summary,'submitted within the reserved requests');
  assert.equal(f.s.get("SELECT status FROM task_runs WHERE role='dev'").status,'succeeded');
});

test('explicit role models on active roles do not require an unrelated project default', async t => {
  const f = await fixture(t, () => call('submit_acceptance', verdict));
  f.put({ roles: [{ role_id: 'manager', harness_ref: { id: 'native' }, model_profile_ref: { model_id: 'm' } }, { role_id: 'qa', harness_ref: { id: 'native' }, model_profile_ref: { model_id: 'm' } }] });
  f.s.run("UPDATE policies SET model_id=NULL WHERE repository_id='101'");
  assert.equal(roleExecutionModel(f.s, f.task, 'manager').id, 'm');
  assert.equal(roleExecutionModel(f.s, f.task, 'qa').id, 'm');
  new TaskRecords(f.s).submit('t', [{ kind: 'report', reference: 'report', version: 'v1', content: 'baseline' }], [], {});
  assert.equal((await evaluateDelivery(f.s, f.task, f.workspace, f.redactor, f.guard)).outcome, 'pass');
  assert.deepEqual(f.s.all("SELECT role,harness FROM task_runs WHERE role IS NOT NULL").map(r => [r.role, r.harness]), [['qa', 'native']]);
});

test('real Pi workers and fresh QA use controlled tools and a fixed candidate under a Native Manager', { skip, timeout: 180000 }, async t => {
  let devRef;
  const f = await fixture(t, body => {
    const system = text(body.messages[0].content), names = (body.tools ?? []).map(t => t.function.name), done = observations(body);
    if (system.includes('Coordinate only.')) {
      if (!called(body, 'write_file')) return call('write_file', { path: 'forbidden.md', content: 'denied' });
      const refs = done.filter(o => o.result_ref).map(o => o.result_ref);
      if (refs.length < 3) return call('delegate_role', { role: ['dev', 'reviewer', 'test'][refs.length], purpose: 'Inspect the actual report', refs: ['task:t'] });
      devRef = refs[0]; return call('nominate_delivery', { result_ref: devRef });
    }
    if (names.includes('submit_acceptance')) {
      if (!called(body, 'read_file')) return call('read_file', { path: 'report.md' });
      assert.ok(JSON.stringify(done).includes('baseline'));
      assert.ok(!JSON.stringify(body.messages).includes('UNACCEPTED_EDIT'));
      return call('submit_acceptance', verdict);
    }
    if (names.includes('submit_role_result')) {
      if (!called(body, 'read_file')) return call('read_file', { path: 'report.md' });
      return call('submit_role_result', { summary: 'Inspected fixed report', findings: [], inspected_scope: ['report.md'], unknowns: [] });
    }
    if (!called(body, 'write_file')) return call('write_file', { path: 'report.md', content: 'baseline\n' });
    if (!called(body, 'run_command')) return call('run_command', { command: "node -e \"if(require('fs').readFileSync('report.md','utf8').trim()!=='baseline')process.exit(1)\"" });
    return call('finish', { summary: 'Report implemented' });
  });
  f.put({ roles: [{ role_id: 'manager', harness_ref: { id: 'native' } }] });
  await f.workspace.call('init', { type: 'workspace_init' });
  const init = await f.workspace.call('git-init', { type: 'workspace_command', command: 'git init -q && git config user.name Fixture && git config user.email fixture@example.invalid && git commit --allow-empty -qm baseline' });
  assert.equal(init.exit_code, 0);
  const spaces = roleWorkspaces(f.workspace);
  const tools = [tool('read_file', { path: { type: 'string' } }, ['path']), tool('write_file', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']), tool('run_command', { command: { type: 'string' } }, ['command']), tool('finish', { summary: { type: 'string' } }, ['summary'])];
  const result = await runTeam({ store: f.s, task: f.task, redactor: f.redactor, guard: f.guard, system: 'Writer task', prompt: 'WRITER_PRIVATE_CONTEXT', tools, finish: { name: 'finish', validate: v => v }, maxTurns: 12,
    execute: async (name, args) => {
      const space = spaces.current, key = randomBytes(12).toString('hex');
      if (name === 'write_file') { await space.write(key, args.path, Buffer.from(args.content)); return { written: true }; }
      return space.call(key, name === 'read_file' ? { type: 'workspace_read', path: args.path } : { type: 'workspace_command', command: args.command });
    } }, { ...spaces });
  assert.equal(result.summary, 'Report implemented'); assert.ok(devRef);
  assert.deepEqual(f.s.all('SELECT role,harness FROM role_instances ORDER BY role').map(r => [r.role, r.harness]), [['dev', 'pi'], ['manager', 'native'], ['reviewer', 'pi'], ['test', 'pi']]);
  const snapshot = await f.workspace.artifact('candidate');
  const records = new TaskRecords(f.s);
  records.submit('t', [{ kind: 'files', reference: 'report', version: snapshot.tree_sha, content: snapshot }], [], { summary: result.summary });
  await f.workspace.write('later-edit', 'report.md', Buffer.from('UNACCEPTED_EDIT'));
  for (let i = 0; i < 2; i++) assert.equal((await evaluateDelivery(f.s, f.task, f.workspace, f.redactor, f.guard)).outcome, 'pass');
  const qaRuns = f.s.all("SELECT harness,recovery_mode FROM task_runs WHERE role='qa'");
  assert.equal(qaRuns.length, 2); assert.ok(qaRuns.every(r => r.harness === 'pi' && r.recovery_mode === 'fresh_evaluation'));
  const qaRequests = f.requests.filter(b => text(b.messages[0].content).includes('independent delivery acceptance evaluator'));
  assert.ok(qaRequests.length >= 4); assert.ok(qaRequests.every(b => !JSON.stringify(b.messages).includes('WRITER_PRIVATE_CONTEXT')));
  assert.ok(f.s.get("SELECT 1 FROM task_history WHERE type='capability_denied' AND json_extract(data,'$.role')='manager' AND json_extract(data,'$.tool')='write_file'"));
  const qaSessions = f.s.all("SELECT data FROM task_history WHERE type='harness_started' AND json_extract(data,'$.role')='qa'").map(r => JSON.parse(r.data).workspace_id);
  assert.equal(new Set(qaSessions).size, 2);
});

test('startup migration retires ACP bindings across role settings, role_instances, and frozen task_execution_configs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-migration-')), dbPath = join(dir, 'bot.sqlite'), secret = randomBytes(32);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Store(dbPath, secret);
  first.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  first.run("INSERT INTO repositories VALUES('101','fixture/acp','o','a')");
  first.run("INSERT INTO repositories VALUES('102','fixture/legacy','o','a')");
  const v2Roles = {
    schema: 2,
    revision: 2,
    enabled: true,
    controller: { role: 'manager', entries: { development: true, request: true, review: false, actions: false } },
    roles: [{ role_id: 'dev', kind: 'writer', enabled: true, name: 'dev', responsibility: '', persona_prompt: '', revision: 1, model_profile_ref: null, skill_bundle_ref: null, harness_ref: { id: 'acp', version: '1' }, permissions: { computer: 'allow' }, environment_profile_ref: { id: 'task-workspace', version: '1' }, budget_policy_ref: { id: 'entry-default', version: '1' }, output_schema_ref: { id: 'entry-delivery', version: '1' } }],
    skills: [],
  };
  first.run("INSERT INTO settings VALUES('roles:101',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(v2Roles));
  first.run("INSERT INTO settings VALUES('roles:102',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ enabled: true, harnesses: { dev: 'acp', reviewer: 'codex' } }));
  first.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t-frozen','101','task.request','running','Frozen','{}',1,1,'ws1')");
  first.run("INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at,snapshot_id,config_revision,role_revision) VALUES('ri-1','t-frozen','dev','{\"id\":\"dev\",\"prompt\":\"p\",\"version\":\"v\"}','acp','now','snap-acp',2,1)");
  first.run(
    "INSERT INTO task_execution_configs(task_id,revision,snapshot,created_at) VALUES('t-frozen',1,?,'now')",
    JSON.stringify({ roles: { schema: 2, revision: 2, enabled: true, controller: { role: 'manager', entries: { development: true, request: true, review: false, actions: false } }, skills: [], roles: [{ role_id: 'dev', kind: 'writer', enabled: true, name: 'dev', responsibility: '', persona_prompt: '', revision: 1, model_profile_ref: null, skill_bundle_ref: null, harness_ref: { id: 'acp', version: '1' }, permissions: { computer: 'allow' }, environment_profile_ref: { id: 'task-workspace', version: '1' }, budget_policy_ref: { id: 'entry-default', version: '1' }, output_schema_ref: { id: 'entry-delivery', version: '1' } }, { role_id: 'reviewer', kind: 'observer', enabled: true, name: 'reviewer', responsibility: '', persona_prompt: '', revision: 1, model_profile_ref: null, skill_bundle_ref: null, harness_ref: { id: 'codex', version: '1' }, permissions: { computer: 'deny' }, environment_profile_ref: { id: 'candidate-checkout', version: '1' }, budget_policy_ref: { id: 'entry-default', version: '1' }, output_schema_ref: { id: 'role-findings', version: '1' } }] } }),
  );
  first.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t-legacy','102','task.request','running','Legacy','{}',1,1,'ws2')");
  first.run(
    "INSERT INTO task_execution_configs(task_id,revision,snapshot,created_at) VALUES('t-legacy',1,?,'now')",
    JSON.stringify({ roles: { enabled: true, harnesses: { dev: 'acp', qa: 'native' } } }),
  );
  // Simulate pre-migration upgraded DB where retire-acp-backend may or may not have run yet.
  first.run("DELETE FROM settings WHERE key IN ('migration:705:retire-acp-backend','migration:705:retire-acp-task-configs')");
  first.close();

  const reopened = new Store(dbPath, secret);
  t.after(() => reopened.close());
  const migratedRoles = JSON.parse(reopened.get("SELECT value FROM settings WHERE key='roles:101'").value);
  assert.equal(migratedRoles.roles.find(r => r.role_id === 'dev').harness_ref.id, 'pi');
  const migratedLegacy = JSON.parse(reopened.get("SELECT value FROM settings WHERE key='roles:102'").value);
  assert.deepEqual(migratedLegacy.harnesses, { dev: 'pi', reviewer: 'codex' });
  assert.equal(reopened.get("SELECT harness FROM role_instances WHERE id='ri-1'").harness, 'pi');
  const frozenV2 = JSON.parse(reopened.get("SELECT snapshot FROM task_execution_configs WHERE task_id='t-frozen'").snapshot);
  assert.equal(frozenV2.roles.roles.find(r => r.role_id === 'dev').harness_ref.id, 'pi');
  assert.equal(frozenV2.roles.roles.find(r => r.role_id === 'reviewer').harness_ref.id, 'codex');
  assert.ok(frozenV2.roles.revision >= migratedRoles.revision);
  const frozenLegacy = JSON.parse(reopened.get("SELECT snapshot FROM task_execution_configs WHERE task_id='t-legacy'").snapshot);
  assert.deepEqual(frozenLegacy.roles.harnesses, { dev: 'pi', qa: 'native' });
  assert.match(explainFailure('cli_not_installed', 'waiting_environment').action, /POST \/api\/agent-tools\/install/);
});

test('container backend runtime_status checks resolved model selection and reports real upstream probe state', async t => {
  let probeStatus = 200;
  const f = await fixture(t, () => ({ content: 'pong' }));
  const probeServer = createServer((_req, res) => {
    res.writeHead(probeStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(probeStatus === 200 ? { id: 'cmpl-1', choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } : { error: { message: 'bad upstream key' } }));
  });
  probeServer.listen(0, '127.0.0.1'); await once(probeServer, 'listening');
  t.after(() => new Promise(r => { probeServer.close(r); probeServer.closeAllConnections(); }));
  f.s.run('UPDATE models SET api_url=? WHERE id=?', `http://127.0.0.1:${probeServer.address().port}/v1`, 'm');

  const toolsRoot = mkdtempSync(join(tmpdir(), 'tools-vol-'));
  t.after(() => rmSync(toolsRoot, { recursive: true, force: true }));
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  mkdirSync(join(toolsRoot, 'codex', '0.166.0', 'bin'), { recursive: true });
  writeFileSync(join(toolsRoot, 'codex', '0.166.0', 'bin', 'codex'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(toolsRoot, 'codex', '0.166.0', 'bin', 'codex'), 0o755);
  writeFileSync(join(toolsRoot, 'codex', '0.166.0', 'manifest.json'), JSON.stringify({
    schema: 'bot.agent-tools/1',
    cli: 'codex',
    version: '0.166.0',
    arch,
    installed_at: '2026-11-15T00:00:00Z',
    container_executable: '/opt/agent-tools/codex/0.166.0/bin/codex',
    container_node_executable: null,
    node_version: null,
    artifacts: [{ role: 'static_binary', source_url: 'https://example.invalid/codex.tar.gz', sha256: 'a'.repeat(64), bytes: 32 }],
  }));

  // 1. Model exists in `models` (model_count === 1), but policies.model_id is unset and no role model is bound -> NOT ready!
  f.s.run("UPDATE policies SET model_id=NULL WHERE repository_id='101'");
  let codex = agentBackends(f.s, '101', toolsRoot).find(b => b.id === 'codex');
  assert.equal(codex.runtime_status.model_count, 1);
  assert.equal(codex.runtime_status.model_relay_ready, false);
  assert.equal(codex.runtime_status.ready, false);
  assert.equal(codex.runtime_status.reason_code, 'model_not_configured');
  assert.match(codex.runtime_status.reason, /已有 1 个带密钥模型/);

  // 2. Selecting default model makes configuration ready, while connectivity starts honestly as 'untested'.
  f.s.run("UPDATE policies SET model_id='m' WHERE repository_id='101'");
  codex = agentBackends(f.s, '101', toolsRoot).find(b => b.id === 'codex');
  assert.equal(codex.runtime_status.ready, true);
  assert.equal(codex.runtime_status.model_relay_ready, true);
  assert.deepEqual(codex.runtime_status.resolved_model, { id: 'm', name: 'fixture', source: 'project' });
  assert.equal(codex.runtime_status.connectivity.state, 'untested');

  // 3. Explicit probe endpoint tests real upstream connectivity and persists 'ok' / 'failed'.
  const admin = { id: 'admin', role: 'project_admin', repositories: ['101'] };
  const probeUrl = new URL('http://local/api/repositories/101/roles/probe-model');
  const okProbe = await roleProbeApi(f.s, admin, 'POST', probeUrl, { role: 'reviewer' });
  assert.equal(okProbe.connectivity.state, 'ok');
  assert.equal(okProbe.connectivity.http_status, 200);
  codex = agentBackends(f.s, '101', toolsRoot).find(b => b.id === 'codex');
  assert.equal(codex.runtime_status.connectivity.state, 'ok');

  probeStatus = 401;
  const failProbe = await roleProbeApi(f.s, admin, 'POST', probeUrl, { role: 'reviewer' });
  assert.equal(failProbe.connectivity.state, 'failed');
  assert.equal(failProbe.connectivity.http_status, 401);
  codex = agentBackends(f.s, '101', toolsRoot).find(b => b.id === 'codex');
  assert.equal(codex.runtime_status.connectivity.state, 'failed');
  assert.match(codex.runtime_status.connectivity.detail, /401/);
});

test('iCode runtime status distinguishes an absent volume, installation, selection and model', async t => {
  const f = await fixture(t, () => ({ content: 'pong' }));
  const toolsRoot = join(f.root, 'tools');
  const status = () => agentBackends(f.s, '101', toolsRoot).find(b => b.id === 'icode').runtime_status;
  assert.equal(status().reason_code, 'agent_tools_volume_missing');
  mkdirSync(toolsRoot);
  assert.equal(status().reason_code, 'acp_product_not_installed');
  assert.equal(status().cli_installed, false);

  const { product, directory, manifest } = writeICodeProduct(toolsRoot);
  const selected = join(product, 'selected');
  unlinkSync(selected);
  assert.equal(status().reason_code, 'acp_product_not_selected');
  assert.deepEqual(status().installed_versions, [manifest.version]);
  assert.equal(status().selected_version, null);

  writeFileSync(selected, manifest.version + '\n');
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, sourceSha256: '0'.repeat(64) }));
  assert.equal(status().reason_code, 'acp_product_invalid');
  assert.deepEqual(status().installed_versions, []);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  f.s.run("UPDATE policies SET model_id=NULL WHERE repository_id='101'");
  assert.equal(status().reason_code, 'model_not_configured');
  assert.equal(status().selected_version, manifest.version);
  f.s.run("UPDATE policies SET model_id='m' WHERE repository_id='101'");
  const ready = status();
  assert.equal(ready.ready, true);
  assert.equal(ready.reason_code, null);
  assert.deepEqual(ready.resolved_model, { id: 'm', name: 'fixture', source: 'project' });
});

// #1042: readiness follows the driver's own declaration. A driver that declares it runs in the workspace with task
// tools used to get no readiness row at all, because the page was fed by a two-id list; from here it reports its
// declared environment, and Pi (a control-plane-tools driver) stays as it was.
test('a newly registered workspace driver reports readiness from its declaration', async t => {
  const { registerRoleHarness } = await import('../../../../dist/roles/harness.js');
  registerRoleHarness({ id: 'declared_workspace_fixture', version: '1', session: 'external_session', events: 'acp_session_events',
    kinds: ['writer', 'observer'], model_api: ['openai-chat-completions'], environment: 'workspace', runtime: { package: 'fixture-product', version: '1' },
    capabilities: { raw_evidence: 'task_tools', cancel: 'protocol_then_kill', isolation: 'none', version_binding: true, output_validation: true, fresh_context: true, recovery: ['rebuilt_from_task_records'] } },
    () => async () => ({ summary: 'declared fixture, not a real driver' }));
  const f = await fixture(t, () => call('finish', {}));
  const view = f.view();
  const declared = view.backends.find(b => b.id === 'declared_workspace_fixture');
  assert.ok(declared, 'the registered driver is listed');
  assert.ok(declared.runtime_status, 'it carries a readiness row instead of nothing');
  assert.equal(declared.runtime_status.ready, true);
  assert.equal(declared.runtime_status.source, 'declaration');
  assert.equal(declared.runtime_status.compatible_range, '');
  // The two tool-volume CLIs keep the inspected status, and Pi keeps no row at all.
  assert.equal(view.backends.find(b => b.id === 'claude_code').runtime_status.source, 'tool_volume');
  assert.equal(view.backends.find(b => b.id === 'pi').runtime_status, null);
});

// #1192 review F2: task tools alone do not place a driver in the project computer. The declaration row belongs to a
// driver that declares `environment: 'workspace'`; a task-tools driver on the control plane keeps no row.
test('a task-tools driver that does not declare the workspace gets no project-computer row', async t => {
  const { registerRoleHarness } = await import('../../../../dist/roles/harness.js');
  registerRoleHarness({ id: 'declared_control_plane_fixture', version: '1', session: 'external_session', events: 'acp_session_events',
    kinds: ['writer'], model_api: ['openai-chat-completions'], environment: 'control_plane', runtime: null,
    capabilities: { raw_evidence: 'task_tools', cancel: 'protocol_then_kill', isolation: 'none', version_binding: true, output_validation: true, fresh_context: true, recovery: ['rebuilt_from_task_records'] } },
    () => async () => ({ summary: 'control-plane fixture, not a real driver' }));
  const f = await fixture(t, () => call('finish', {}));
  const controlPlane = f.view().backends.find(b => b.id === 'declared_control_plane_fixture');
  assert.ok(controlPlane, 'the registered driver is listed');
  assert.equal(controlPlane.runtime_status, null, 'task tools on the control plane are not a workspace declaration');
});

// #1256 review: the test-only scripted driver stays registered for the whole process, and a Playwright worker runs many
// specs in one process. Registered as unlisted, it runs where a configuration names it, but no backend listing offers it.
test('an unlisted driver runs where configured but no backend listing offers it', async t => {
  const { scriptedHarness } = await import('../../../fixtures/scripted-driver.mjs');
  const { roleHarness } = await import('../../../../dist/roles/harness.js');
  assert.equal(roleHarness(scriptedHarness).id, scriptedHarness, 'a configuration naming it resolves the driver');
  const f = await fixture(t, () => call('finish', {}));
  const view = f.view();
  assert.ok(view.harnesses.some(h => h.id === 'pi') && !view.harnesses.some(h => h.id === scriptedHarness));
  assert.ok(view.backends.some(b => b.id === 'pi') && !view.backends.some(b => b.id === scriptedHarness));
  assert.ok(!agentBackends().some(b => b.id === scriptedHarness));
});
