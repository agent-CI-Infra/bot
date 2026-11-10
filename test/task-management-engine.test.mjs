import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { roleTaskCaller } from '../dist/tasks/management.js';
import { roleApi } from '../dist/roles/api.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { server as github } from './fixtures/agent-server.mjs';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { authorize } from '../dist/identity/authorization.js';
import { taskTraceAccess } from '../dist/memory/access.js';

const pass = { outcome: 'pass', reason: 'Controlled fixture: inspected the supplied report candidate', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };

test('own tasks use the existing engine, executor role, runs, claims and independent QA even when team coordination is disabled', async t => {
  const root = mkdtempSync(join(tmpdir(), 'own-role-task-')), store = new Store(':memory:', Buffer.alloc(32, 3)), manager = new LocalManager('101', root);
  t.after(async () => { await manager.recover(); store.close(); rmSync(root, { recursive: true, force: true }); });
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  t.after(() => new Promise(r => { github.close(r); github.closeAllConnections(); }));
  const gh = 'http://127.0.0.1:' + github.address().port;
  await fetch(gh + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'fixture-task-token' }) });
  const requests = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    const accepting = body.tools.some(t => t.function.name === 'submit_acceptance');
    const name = accepting ? 'submit_acceptance' : 'submit_delivery', args = accepting ? pass : { summary: 'Scoped report produced by the same configured role', artifacts: [], evidence: [], unknowns: [] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'finish-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  }); model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(() => new Promise(r => { model.close(r); model.closeAllConnections(); }));
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-task-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101',?,'fixture',?,'now')", 'http://127.0.0.1:' + model.address().port + '/v1', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'));
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,0)");
  roleApi(store, { id: 'operator', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), {
    expected_revision: 0, enabled: false, roles: [
      { role_id: 'reviewer', harness_ref: { id: 'native' }, permissions: { task_management: 'write', delegation: 'deny', commands: 'deny' } },
      { role_id: 'qa', harness_ref: { id: 'native' } }
    ]
  });
  const commands = new TaskCommands(store), engine = new TaskEngine(store, manager, gh + '/github');
  const actors = [undefined, knowledgeActor(store, 'maintainer', '101'),
    knowledgeActor(store, 'restricted', '101', ['tasks.read', 'tasks.manage_own', 'knowledge.read'])];
  assert.throws(() => authorize(actors[2], 'tasks.write', { project_id: '101' }), { code: 'capability_forbidden' });
  let source;
  for (const actor of actors) {
  source = roleTaskCaller(store, '101', 'reviewer', { actor, conversation_id: 'persistent-chat', source_message: 'incoming-1', guard() {} });
  const { id } = commands.tool(source, 'create_task', { request: 'Produce a bounded report', criteria: ['Return the report with explicit uncertainty'] });
  if (actor) assert.equal(taskTraceAccess(store, store.get('SELECT * FROM tasks WHERE id=?', id)).actor.principal_id, actor.principal_id);
  store.run("UPDATE tasks SET status='running',claim_token='claim' WHERE id=?", id);
  store.run("INSERT INTO task_claims VALUES(?,'101','claim','now')", id);
  await engine.run(id, 'claim');
  const task = store.get('SELECT * FROM tasks WHERE id=?', id);
  assert.equal(task.status, 'completed', JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=?', id)));
  assert.deepEqual(store.all('SELECT DISTINCT role FROM role_instances WHERE task_id=? ORDER BY role', id).map(r => r.role), ['qa', 'reviewer']);
  assert.equal(store.get('SELECT count(*) n FROM task_runs WHERE task_id=? AND role=?', id, 'reviewer').n, 1);
  assert.equal(store.get('SELECT executor_role FROM task_origins WHERE task_id=?', id).executor_role, 'reviewer');
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(body => !body.tools.some(t => ['delegate_role', 'delegate_roles', 'run_command', 'create_issue', 'create_pull_request'].includes(t.function.name))));
  assert.equal(store.get('SELECT count(*) n FROM github_effects WHERE task_id=?', id).n, 0);
  }
  commands.tool(source, 'create_task', { request: 'Second report', criteria: ['Return a separate result'], execute: false });
  assert.equal(store.get('SELECT count(*) n FROM tasks').n, 4);
});
