import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from './helpers.mjs';
import { agentLoop } from '../dist/agent/loop.js';
import { Redactor } from '../dist/agent/common.js';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('the agent loop records each model decision and tool result as a visible process step', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const replies = [
    { role: 'assistant', content: 'Inspect the helper first.', reasoning_content: 'The PR adds one file; read it and run it.', tool_calls: [call('c1', 'read_file', { path: 'src/stats.js' }), call('c2', 'run_command', { command: 'node -e 1' })] },
    { role: 'assistant', content: null, tool_calls: [call('c3', 'finish_review', { summary: 'Short summary.', requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '', findings: [] })] }];
  const server = createServer(async (req, res) => { for await (const _ of req); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: replies.shift() }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: 'process-fixture-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id, review_enabled: true });
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token) VALUES('process','101','review.pr','running','pr',4,'claim')");
  const logs = [], workspace = { log: value => logs.push(value), write: async () => {},
    call: async (_key, request) => request.type === 'workspace_read' ? { content: 'export const x = 1;\n' } : { exit_code: 0, output: 'ok\n', timed_out: false, truncated: false } };
  const result = await agentLoop(h.store, h.store.get("SELECT * FROM tasks WHERE id='process'"), workspace, new Redactor(), async () => {}, { mode: 'review' });
  assert.equal(result.summary, 'Short summary.');
  assert.deepEqual(logs.map(l => l.type + (l.name ? ':' + l.name : '')), ['model', 'tool:read_file', 'tool:run_command', 'model']);
  assert.equal(logs[0].reasoning, 'The PR adds one file; read it and run it.');
  assert.deepEqual(logs[0].tool_calls.map(c => c.name), ['read_file', 'run_command']);
  assert.equal(logs[1].result.bytes, 20);
  assert.deepEqual([logs[2].arguments.command, logs[2].result.exit_code], ['node -e 1', 0]);
  assert.equal(logs[3].tool_calls[0].name, 'finish_review');
});

test('task lists split review and development work, and logs carry their time', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  for (const [id, kind] of [['r1', 'review.issue'], ['r2', 'review.pr'], ['d1', 'development.issue']])
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at) VALUES(?,?,?,?,?,?,?)", id, '101', kind, 'queued', id, 1, id);
  h.store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES('l1','r1','{\"type\":\"prepared\"}','2026-10-22T12:00:00.000Z')");
  const reviews = (await admin('/api/tasks?kind=review')).value.tasks, developments = (await admin('/api/tasks?kind=development')).value.tasks;
  assert.deepEqual(reviews.map(r => r.id).sort(), ['r1', 'r2']); assert.deepEqual(developments.map(r => r.id), ['d1']);
  assert.equal(reviews[0].full_name, 'fixture/project-101');
  assert.equal((await admin('/api/tasks?kind=other')).status, 400);
  assert.deepEqual((await admin('/api/tasks/r1/logs')).value.logs.map(l => l.created_at), ['2026-10-22T12:00:00.000Z']);
});

test('environment detail shows the project computer, the task holding it and recent commands', async t => {
  const computer = { container: 'dbot-x-101-g1', volume: 'dbot-x-101-g1-work', network: 'dbot-x-101-g1-net', memory_mb: 512, cpus: 1, pids: 128 };
  const manager = { call: async (_method, path) => path === '/v1/projects/101' ? { repository_id: '101', generation: 1, state: 'busy', desired: 'ready', revision: 1, computer } : null };
  const h = await harness(t, manager), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,generation) VALUES('t1','101','review.pr','running','pr',4,1)");
  h.store.run("INSERT INTO task_locks(repository_id,task_id,token) VALUES('101','t1','claim')");
  h.store.run(`INSERT INTO task_logs(id,task_id,content,created_at) VALUES('c1','t1',?,'2026-10-22T12:00:01.000Z'),('c2','t1',?,'2026-10-22T12:00:02.000Z')`,
    JSON.stringify({ type: 'tool', name: 'run_command', arguments: { command: 'node --test' }, result: { exit_code: 1, output: 'fail' } }), JSON.stringify({ type: 'model', step: 1 }));
  await h.projects.reconcile();
  const detail = (await admin('/api/environments/101')).value;
  assert.deepEqual(detail.environment.computer, computer);
  assert.equal(detail.environment.full_name, 'fixture/project-101');
  assert.equal(detail.current_task.id, 't1');
  assert.deepEqual(detail.commands.map(c => [c.command, c.exit_code, c.object_number]), [['node --test', 1, 4]]);
  assert.equal((await admin('/api/environments?repository_id=101')).value.environments[0].current_task_id, 't1');
});
