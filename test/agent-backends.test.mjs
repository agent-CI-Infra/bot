import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { roleApi } from '../dist/roles/api.js';
import { roleWorkspaces } from '../dist/roles/workspace.js';
import { runTeam } from '../dist/roles/team.js';
import { roleExecutionModel } from '../dist/roles/run.js';
import { evaluateDelivery } from '../dist/tasks/acceptance.js';
import { requestCoordination, CoordinationWorker } from '../dist/tasks/coordination.js';
import { Workspace } from '../dist/agent/workspace.js';
import { Redactor } from '../dist/agent/common.js';
import { LocalManager } from '../dist/projects/local-manager.js';

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
  return { s, manager, requests, task, redactor, guard, workspace, put, view: () => roleApi(s, admin, 'GET', url, {}) };
}

test('new role configurations default to Pi; all registered backends are selectable by every role without changing authority', async t => {
  const f = await fixture(t, () => call('finish', {}));
  const config = f.put({ roles: [{ role_id: 'security' }] });
  assert.ok(config.roles.every(r => r.harness_ref.id === 'pi'));
  for (const backend of ['native', 'process', 'acp', 'pi']) {
    const saved = f.put({ roles: config.roles.map(r => ({ role_id: r.role_id, harness_ref: { id: backend } })) });
    assert.ok(saved.roles.every(r => r.harness_ref.id === backend));
    assert.equal(saved.roles.find(r => r.role_id === 'manager').capability_policy_ref.id, 'controller-coordination');
    assert.equal(saved.roles.find(r => r.role_id === 'qa').output_schema_ref.id, 'acceptance-verdict');
  }
  for (const backend of ['codex', 'claude_code', 'opencode']) {
    const view = f.view(), entry = view.backends.find(b => b.id === backend);
    assert.equal(entry.available, false); assert.ok(entry.integration_issue);
    assert.throws(() => f.put({ roles: [{ role_id: 'dev', harness_ref: { id: backend } }] }), e => e.code === 'agent_backend_unavailable' && e.field === 'roles.dev.harness_ref.id');
    assert.equal(f.view().revision, view.revision);
  }
  assert.equal(f.view().recommended_backend, 'pi');
});

test('external role models and an explicit QA model do not require an unrelated project default', async t => {
  const f = await fixture(t, () => call('submit_acceptance', verdict));
  f.put({ roles: [{ role_id: 'manager', harness_ref: { id: 'acp' } }, { role_id: 'qa', harness_ref: { id: 'native' }, model_profile_ref: { model_id: 'm' } }] });
  f.s.run("UPDATE policies SET model_id=NULL WHERE repository_id='101'");
  assert.equal(roleExecutionModel(f.s, f.task, 'manager').id, 'acp');
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

test('a Coordinator configured with Pi gets its own real SDK session and restricted tools', { skip, timeout: 120000 }, async t => {
  const f = await fixture(t, body => {
    assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['read_project_task', 'submit_coordination']);
    return call('submit_coordination', { summary: 'Align the shared report', outcome: 'notices', notices: [{ task_id: 't', message: 'Recheck the shared report and obtain fresh QA', action: 'review' }] });
  });
  f.put({ roles: [{ role_id: 'coordinator', harness_ref: { id: 'pi' } }] });
  const request = requestCoordination(f.s, f.task, { key: 'shared-report', problem: 'Two reports share a convention', proposal: 'Inspect current evidence', task_ids: ['other'], refs: ['task:t'] });
  const worker = new CoordinationWorker(f.s, f.manager); worker.tick(); await Promise.all([...worker.active.values()]);
  assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?', request.coordination_id).state, 'awaiting_feedback');
  assert.deepEqual(f.s.all("SELECT harness,recovery_mode FROM task_runs WHERE role='coordinator'").map(r => [r.harness, r.recovery_mode]), [['pi', 'rebuilt_from_task_records']]);
});
