import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { runRequest } from '../../../../dist/tasks/request.js';
import { createManagedTask, eventTaskCaller } from '../../../../dist/tasks/management.js';
import { server as github } from '../../../fixtures/agent-server.mjs';
import '../../../fixtures/scripted-driver.mjs';

// #1072: a project scheduled task (a report request whose contract names the schedule) starts a workflow on time. The run
// link GitHub returns lands in the task record, and the task's context carries the late-schedule recommendation.
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const receipts = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')));
const offers = (body, name) => body.tools.some(t => t.function.name === name);
const pass = { outcome: 'pass', reason: 'The run was started and reported', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };
const dispatch = call('github_write', { method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'nightly', body: { ref: 'main' } });
const contract = { goal: 'Start Nightly on main', scope: ['Start nightly.yml on main'], criteria: ['Report the started run'], endpoint: 'report', source: { type: 'schedule', event_id: 'e1' }, completeness: 'explicit' };

// A project computer, a scripted model, the GitHub fixture and the project's roles; `respond(body)` answers each model call.
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
async function fixture(t, respond, app = false) {
  const root = mkdtempSync(join(tmpdir(), 'bot-scheduled-dispatch-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root);
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: respond(JSON.parse(raw)) }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  t.after(async () => {
    await manager.recover();
    for (const server of [model, github]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + github.address().port;
  await fetch(url + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'fixture-github-token' }) });
  // The GitHub fixture lives for the whole file: count only what this test starts.
  const before = (await (await fetch(url + '/fixture/state')).json()).workflowRuns.length;
  // Read tokens are minted only for a GitHub App installation; a bot account writes with its own token.
  if (app) store.run("INSERT INTO accounts VALUES('a','a','github_app','123',?,'now')", store.secrets.seal({ private_key: key }, 'account:a'));
  else store.run("INSERT INTO accounts VALUES('a','a','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-github-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'), 'now');
  // The comment ceiling is enough to start a workflow.
  store.run("INSERT INTO policies(repository_id,model_id,enabled,capability_ceiling) VALUES('101','m',1,'comment')");
  roleApi(store, { id: 'owner', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), { expected_revision: 0, enabled: true,
    controller: { entries: { review: true, development: true, request: true } }, roles: ['manager', 'dev', 'qa'].map(role_id => ({ role_id, harness_ref: { id: 'scripted' } })) });
  const environment = await manager.call('PUT', '/v1/projects/101');
  const insert = () => {
    store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id,claim_token,head_sha) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 't', '101', 'task.request', 'running', 'Start Nightly',
      JSON.stringify({ request: 'Start nightly.yml on main; first check that no run of it is queued or in progress.', contract }), 1, environment.generation, randomBytes(24).toString('hex'), 'claim', 'a'.repeat(40));
    store.run("INSERT INTO task_claims VALUES('t','101','claim','now')");
    new TaskRecords(store).contract('t', contract);
    return 't';
  };
  const run = async () => {
    const task = store.get("SELECT * FROM tasks WHERE id='t'"), redactor = new Redactor(), guard = async () => {};
    const workspace = new Workspace(store, manager, task, redactor, guard, () => {});
    await workspace.call('init', { type: 'workspace_init' });
    await workspace.write('seed-write', 'README.md', Buffer.from('fixture'));
    assert.equal((await workspace.call('seed-commit', { type: 'workspace_command', command: 'git init -q && git add README.md && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm baseline', timeout_ms: 10000 })).exit_code, 0);
    await runRequest(store, manager, task, redactor, guard, () => {}, url + '/github');
    const state = await (await fetch(url + '/fixture/state')).json();
    return { ...state, started: state.workflowRuns.slice(before), first: before };
  };
  return { store, insert, run };
}
// The run GitHub started is in the task's execution evidence and in the write ledger, written as the Manager.
function assertRecorded(store, state) {
  assert.equal(store.get("SELECT status FROM tasks WHERE id='t'").status, 'completed');
  assert.deepEqual(state.started.map(run => [run.repository_id, run.workflow, run.body]), [[101, 'nightly.yml', { ref: 'main', return_run_details: true }]]);
  const link = 'https://github.com/fixture/project-101/actions/runs/' + (9000 + state.first);
  const evidence = store.all("SELECT data FROM task_history WHERE task_id='t' AND type='execution_evidence'").map(row => JSON.parse(row.data)).find(e => e.name === 'github_write');
  assert.equal(evidence.result.html_url, link); assert.equal(evidence.result.status, 200);
  const ledger = store.get("SELECT * FROM github_writes WHERE scope LIKE 'task:%'");
  assert.deepEqual([ledger.state, ledger.html_url, JSON.parse(ledger.actor).role], ['sent', link, 'manager']);
}

test('a due check the Manager executes reads the workflow runs first, starts the workflow and keeps the run link in its record (#1072)', { timeout: 90000 }, async t => {
  const bodies = [];
  const f = await fixture(t, body => {
    if (offers(body, 'submit_acceptance')) return call('submit_acceptance', pass);
    bodies.push(body);
    const results = receipts(body), runs = results.find(r => JSON.stringify(r).includes('workflow_runs')), started = results.find(r => r.workflow_run_id);
    return !runs ? call('github_read', { path: '/actions/workflows/nightly.yml/runs?status=in_progress' })
      : !started ? dispatch
      : call('submit_delivery', { summary: 'Started Nightly on main: ' + started.html_url, artifacts: [], evidence: [], unknowns: [] });
  }, true);
  // As dispatch creates a due check (src/dispatch/store.ts): an event caller of the Manager, which then executes it.
  assert.equal(createManagedTask(f.store, eventTaskCaller(f.store, '101', 'e1'), undefined, f.insert), 't');
  assert.equal(f.store.get("SELECT executor_role FROM task_origins WHERE task_id='t'").executor_role, 'manager');
  const state = await f.run();
  // The Manager reads GitHub with a read-only token before writing, and its context carries the late-schedule guide.
  assert.ok(offers(bodies[0], 'github_read') && offers(bodies[0], 'read_job_log') && offers(bodies[0], 'github_write'));
  assert.match(JSON.stringify(bodies[0].messages), /late_scheduled_runs.*Late scheduled workflow runs/);
  assert.ok(state.requests.some(r => r.method === 'GET' && r.path === '/repos/fixture/project-101/actions/workflows/nightly.yml/runs'));
  assert.ok(receipts(bodies.at(-1)).some(r => JSON.stringify(r).includes('workflow_runs')), 'the runs came back to the Manager');
  assertRecorded(f.store, state);
});

test('a report request the project team runs keeps the Manager\'s github_write; a worker that only reads is not offered it (#1072)', { timeout: 90000 }, async t => {
  const bodies = { manager: [], dev: [] };
  const f = await fixture(t, body => {
    if (offers(body, 'submit_acceptance')) return call('submit_acceptance', pass);
    const results = receipts(body);
    if (offers(body, 'nominate_delivery')) {
      bodies.manager.push(body);
      const started = results.find(r => r.workflow_run_id), ref = results.find(r => r.result_ref)?.result_ref;
      return !started ? dispatch : !ref ? call('delegate_role', { role: 'dev', purpose: 'Write the report of the started Nightly run: ' + started.html_url, refs: [] }) : call('nominate_delivery', { result_ref: ref });
    }
    bodies.dev.push(body);
    return !body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'write_file'))
      ? call('write_file', { path: 'report.md', content: 'Started Nightly on main.' })
      : call('submit_delivery', { summary: 'Started Nightly on main', artifacts: [{ path: 'report.md', description: 'The started run' }], evidence: [], unknowns: [] });
  });
  // Without an executor role (an operator's request, for example) the request entry runs the team.
  f.insert();
  const state = await f.run();
  assert.ok(offers(bodies.manager[0], 'github_write'));
  assert.match(JSON.stringify(bodies.manager[0].messages), /late_scheduled_runs.*Late scheduled workflow runs/);
  assert.ok(bodies.dev.length && bodies.dev.every(body => !offers(body, 'github_write') && offers(body, 'github_read')));
  assertRecorded(f.store, state);
});
