import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { harness, setup, account, repository } from './helpers.mjs';
import { FailureLog } from '../dist/core/log.js';
import { fail } from '../dist/core/security.js';
import { agentLoop } from '../dist/agent/loop.js';
import { Redactor } from '../dist/agent/common.js';
import { Docker } from '../manager/docker.mjs';
import { Projects } from '../manager/projects.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { loadConsole } from './console-page.mjs';

// Lines written to stderr while a test runs.
const stderr = t => { const lines = []; t.mock.method(console, 'error', (...args) => lines.push(args.map(String).join(' '))); return lines; };

test('a repeating background failure is logged once, again when it changes, and once when it works again', t => {
  const lines = stderr(t), log = new FailureLog('projects');
  log.report('project 101', new Error('manager_unavailable')); log.report('project 101', new Error('manager_unavailable'));
  log.report('project 101', new Error('approved_image_missing')); log.clear('project 101'); log.clear('project 101');
  assert.deepEqual(lines, ['[projects] project 101: manager_unavailable', '[projects] project 101: approved_image_missing', '[projects] project 101: works again']);
});

test('an agent that fails keeps its reason in the task log and the stop message, and is still retried in a fresh workspace', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  // The agent fails before it asks the model anything, so the model is never called.
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'agent-fixture-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token) VALUES('agent','101','review.pr','running','pr',4,'claim')");
  const redactor = new Redactor(), secret = 'ghs_' + 'x'.repeat(36); redactor.add(secret);
  const logs = [], workspace = { log: entry => logs.push(entry), call: async (_key, input) => input.type === 'workspace_agent_poll'
    ? { state: 'failed', error: 'pi_execution_failed', detail: `final answer is not JSON: Unexpected token 'S' (token ${secret})`, events: [], offset: 0 } : { written: true, started: true } };
  await assert.rejects(agentLoop(h.store, h.store.get("SELECT * FROM tasks WHERE id='agent'"), workspace, redactor, async () => {}, { mode: 'review' }), error => {
    assert.deepEqual([error.code, error.state], ['execution_interrupted', 'waiting_environment']);
    assert.match(error.detail, /^任务执行进程失败：final answer is not JSON: Unexpected token 'S'/); assert.ok(!error.detail.includes(secret)); return true;
  });
  const failure = logs.find(entry => entry.type === 'agent_failure');
  assert.equal(failure.error, 'pi_execution_failed'); assert.match(failure.detail, /Unexpected token/); assert.ok(!JSON.stringify(logs).includes(secret));
});

test('the manager logs why Docker refused an operation and why a computer stopped', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'diagnostics-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Docker explains a refusal in its JSON body; the code stays docker_operation_failed and the reason travels as detail.
  // Relative to the checkout: a unix socket path is limited to 107 bytes, which a deep checkout's absolute path exceeds.
  const socket = join(relative(process.cwd(), directory), 'docker.sock'), daemon = createServer((_req, res) => { res.statusCode = 400; res.end(JSON.stringify({ message: 'Range of CPUs is from 0.01 to 8.00, as there are only 8 CPUs available' })); });
  daemon.listen(socket); await once(daemon, 'listening'); t.after(() => new Promise(done => daemon.close(done)));
  await assert.rejects(new Docker(socket).request('POST', '/containers/create?name=dbot-x', {}), error => {
    assert.equal(error.message, 'docker_operation_failed');
    assert.equal(error.detail, 'POST /containers/create → HTTP 400: Range of CPUs is from 0.01 to 8.00, as there are only 8 CPUs available'); return true;
  });
  // A computer that cannot be created says so in the manager's log.
  const lines = stderr(t), docker = new FakeDocker(); docker.failNetwork = true;
  const projects = new Projects({ database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' }); t.after(() => projects.db.close());
  await assert.rejects(projects.register('101'), /injected_network_failure/);
  assert.deepEqual(lines, ['[manager] project 101 first provision failed: injected_network_failure']);
});

test('reconciliation shows the code a manager answered with, and only an unreachable manager as unavailable', async t => {
  // A stopped computer whose start fails: the manager answers with its code and records the computer as failed.
  let reachable = true, failed = false, fixed = false;
  const manager = { call: async method => {
    if (!reachable) fail(503, 'manager_unavailable');
    if (fixed) return { repository_id: '101', generation: 1, state: 'ready', desired: 'ready', error: null, revision: 3 };
    if (method === 'POST') { failed = true; fail(503, 'approved_image_missing'); }
    return { repository_id: '101', generation: 1, state: failed ? 'failed' : 'stopped', desired: failed ? 'ready' : 'stopped', error: failed ? 'approved_image_missing' : null, revision: failed ? 2 : 1 };
  } };
  const lines = stderr(t), h = await harness(t, manager), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const environment = () => { const row = h.store.get("SELECT state,error FROM project_environments WHERE repository_id='101'"); return [row.state, row.error]; };
  await h.projects.reconcile();
  assert.deepEqual(environment(), ['failed', 'approved_image_missing']);
  await h.projects.reconcile(); assert.deepEqual(environment(), ['failed', 'approved_image_missing']);
  reachable = false; await h.projects.reconcile(); await h.projects.reconcile();
  assert.deepEqual(environment(), ['unavailable', 'manager_unavailable']);
  reachable = true; fixed = true; await h.projects.reconcile(); await h.projects.reconcile();
  // One line when a failure appears or changes and one when the computer works again, however often it runs: a pass that
  // only reads a computer the manager still reports as failed is no recovery.
  assert.deepEqual(lines.filter(line => line.startsWith('[projects] project 101')),
    ['[projects] project 101: approved_image_missing', '[projects] project 101: manager_unavailable', '[projects] project 101: works again']);
});

test('a saved computer operation the manager refused is logged once as given up and not kept as a failure', async t => {
  const manager = { call: async method => {
    if (method === 'POST') fail(400, 'invalid_spec');
    return { repository_id: '101', generation: 1, state: 'ready', desired: 'ready', error: null, revision: 1 };
  } };
  const lines = stderr(t), h = await harness(t, manager), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  h.store.run("INSERT INTO environment_operations VALUES('op-1','101','configure',?,'pending',NULL)", JSON.stringify({ operation_id: 'op-1', generation: 1, request: {} }));
  await h.projects.reconcile(); await h.projects.reconcile();
  assert.equal(h.store.get("SELECT state FROM environment_operations WHERE id='op-1'").state, 'failed');
  assert.deepEqual(lines.filter(line => line.includes('op-1')), ['[projects] operation configure op-1 of 101: invalid_spec (given up, not retried)']);
  assert.equal(h.projects.failures.last.size, 0);
});

test('the machine page explains a computer fault code and where its cause is logged', () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], () => [200, {}]);
  assert.equal(page.run("environmentFault('docker_operation_failed')"), 'Docker 拒绝了操作（docker_operation_failed）。原因见日志：docker compose -p bot logs manager bot');
  assert.equal(page.run("environmentFault('something_new')"), '未归类的故障（something_new）。原因见日志：docker compose -p bot logs manager bot');
  // Codes the manager does not log point to where their cause is.
  assert.equal(page.run("environmentFault('manager_unavailable')"), '连不上虚拟电脑管理服务（manager）（manager_unavailable）。原因见控制面日志：docker compose -p bot logs bot');
  assert.match(page.run("environmentFault('unauthorized')"), /内部令牌不一致.*manager\.token/);
  assert.equal(page.run('environmentFault(null)'), null);
});
