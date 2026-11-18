// Controlled provider fixtures exercise the explicit gateway transport.
process.env.BOT_HARNESS_MODEL_TRANSPORT = 'gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
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
import { server as github } from '../../../fixtures/agent-server.mjs';

// #1072: a project scheduled task (a report request from a schedule, run by the project team) starts a workflow on time.
// The Manager keeps the github_write its role allows, the run link GitHub returns lands in the task record, and the task's
// context carries the late-schedule recommendation. Workers that only read GitHub are not offered the tool.
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const receipts = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')));
const offers = (body, name) => body.tools.some(t => t.function.name === name);
const pass = { outcome: 'pass', reason: 'The run was started and reported', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };

test('a project scheduled task run by the team starts a workflow as the Manager and keeps the run link in its record (#1072)', { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-scheduled-dispatch-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root), bodies = { manager: [], dev: [], qa: [] };
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), results = receipts(body);
    let message;
    if (offers(body, 'submit_acceptance')) { bodies.qa.push(body); message = call('submit_acceptance', pass); }
    else if (offers(body, 'nominate_delivery')) {
      bodies.manager.push(body);
      const started = results.find(r => r.workflow_run_id), ref = results.find(r => r.result_ref)?.result_ref;
      message = !started ? call('github_write', { method: 'POST', path: '/actions/workflows/nightly.yml/dispatches', key: 'nightly', body: { ref: 'main' } })
        : !ref ? call('delegate_role', { role: 'dev', purpose: 'Write the report of the started Nightly run: ' + started.html_url, refs: [] })
        : call('nominate_delivery', { result_ref: ref });
    } else {
      bodies.dev.push(body);
      message = !body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'write_file'))
        ? call('write_file', { path: 'report.md', content: 'Started Nightly on main.' })
        : call('submit_delivery', { summary: 'Started Nightly on main', artifacts: [{ path: 'report.md', description: 'The started run' }], evidence: [], unknowns: [] });
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
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
  store.run("INSERT INTO accounts VALUES('a','a','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-github-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'), 'now');
  // The comment ceiling is enough to start a workflow.
  store.run("INSERT INTO policies(repository_id,model_id,enabled,capability_ceiling) VALUES('101','m',1,'comment')");
  roleApi(store, { id: 'owner', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), { expected_revision: 0, enabled: true,
    controller: { entries: { review: true, development: true, request: true } }, roles: ['manager', 'dev', 'qa'].map(role_id => ({ role_id, harness_ref: { id: 'native' } })) });
  const environment = await manager.call('PUT', '/v1/projects/101');
  // As dispatch creates a due check (src/dispatch/store.ts): a report request whose contract names the schedule as its source.
  const contract = { goal: 'Start Nightly on main', scope: ['Start nightly.yml on main'], criteria: ['Report the started run'], endpoint: 'report', source: { type: 'schedule', event_id: 'e1' }, completeness: 'explicit' };
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id,claim_token,head_sha) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 't', '101', 'task.request', 'running', 'Start Nightly',
    JSON.stringify({ request: 'Start nightly.yml on main; first check that no run of it is queued or in progress.', contract }), 1, environment.generation, randomBytes(24).toString('hex'), 'claim', 'a'.repeat(40));
  store.run("INSERT INTO task_claims VALUES('t','101','claim','now')");
  const records = new TaskRecords(store); records.contract('t', contract);
  const task = store.get("SELECT * FROM tasks WHERE id='t'"), redactor = new Redactor(), guard = async () => {};
  const workspace = new Workspace(store, manager, task, redactor, guard, () => {});
  await workspace.call('init', { type: 'workspace_init' });
  await workspace.write('seed-write', 'README.md', Buffer.from('fixture'));
  assert.equal((await workspace.call('seed-commit', { type: 'workspace_command', command: 'git init -q && git add README.md && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm baseline', timeout_ms: 10000 })).exit_code, 0);

  await runRequest(store, manager, task, redactor, guard, () => {}, url + '/github');
  assert.equal(store.get("SELECT status FROM tasks WHERE id='t'").status, 'completed');
  // The Manager was offered github_write and the scheduled context; the reading worker was not offered the write.
  assert.ok(offers(bodies.manager[0], 'github_write'));
  assert.match(JSON.stringify(bodies.manager[0].messages), /late_scheduled_runs.*Late scheduled workflow runs/);
  assert.ok(bodies.dev.length && bodies.dev.every(body => !offers(body, 'github_write')));
  // GitHub was asked once, for the run it started; the run link is in the task record and the write ledger.
  const state = await (await fetch(url + '/fixture/state')).json();
  assert.deepEqual(state.workflowRuns.map(run => [run.repository_id, run.workflow, run.body]), [[101, 'nightly.yml', { ref: 'main', return_run_details: true }]]);
  const link = 'https://github.com/fixture/project-101/actions/runs/' + (9000 + state.workflowRuns.length - 1);
  const evidence = store.all("SELECT data FROM task_history WHERE task_id='t' AND type='execution_evidence'").map(row => JSON.parse(row.data)).find(e => e.name === 'github_write');
  assert.equal(evidence.result.html_url, link); assert.equal(evidence.result.status, 200);
  const ledger = store.get("SELECT * FROM github_writes WHERE scope LIKE 'task:%'");
  assert.deepEqual([ledger.state, ledger.html_url, JSON.parse(ledger.actor).role], ['sent', link, 'manager']);
});
