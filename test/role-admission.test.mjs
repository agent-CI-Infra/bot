import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { runRole } from '../dist/roles/run.js';
import { registerRoleHarness } from '../dist/roles/harness.js';
import { Redactor } from '../dist/agent/common.js';
import { isAttemptFailure } from '../dist/agent/failures.js';

// #283 (part of #228, slice 2/2): a per-role limit is an admission gate, not a display number. Every test here runs the
// real role-run path; the harness blocks inside the run so more than one run is genuinely running at once.

const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const gates = [];
const blocked = () => new Promise(resolve => gates.push(resolve));
registerRoleHarness({ id: 'capacity-fixture', version: '1', session: 'task_records', events: 'run_events', kinds: ['writer', 'observer'],
  capabilities: { cancel: 'protocol_then_kill', version_binding: true, output_validation: true, raw_evidence: 'control_plane_tools', fresh_context: true } },
spec => async () => { await blocked(); return spec.finish.validate({ summary: 'ok' }); });

/** One project with `count` runnable tasks, a project model, and the default role configuration. */
async function fixture(t, { count = 3, project = 'r', name = 'fixture/project' } = {}) {
  const s = new Store(':memory:', randomBytes(32));
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run('INSERT INTO repositories VALUES(?,?,?,?)', project, name, 'o', 'a');
  const records = new TaskRecords(s), tasks = [];
  for (let i = 1; i <= count; i++) {
    const id = project + '-t' + i;
    s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES(?,?,'task.request','running','implement fixture','{}',1,1)", id, project);
    records.contract(id, { goal: 'implement fixture', scope: ['fixture'], criteria: ['Actual result'], endpoint: 'artifact' });
    tasks.push(s.get('SELECT * FROM tasks WHERE id=?', id));
  }
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', project, 'http://127.0.0.1:9/v1', 'fixture', s.secrets.seal({ value: 'fixture-model-key-283' }, 'model:m'), 'now');
  s.run('INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES(?,?,1,1)', project, 'm');
  t.after(() => s.close());
  const spec = task => ({ store: s, task, redactor: new Redactor(), guard: async () => {}, system: 'Task execution', prompt: '{}', tools: [tool('read_task_record'), tool('finish')], finish: { name: 'finish', validate: v => v }, maxTurns: 8 });
  const limit = (limits, id = project) => s.run('UPDATE policies SET role_concurrency=? WHERE repository_id=?', JSON.stringify(limits), id);
  const running = (role, id = project) => Number(s.get("SELECT count(*) n FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.repository_id=? AND r.role=? AND r.status='running'", id, role).n);
  const settle = () => { while (gates.length) gates.shift()(); };
  const waitRunning = async (role, n) => { for (let i = 0; i < 300; i++) { if (running(role) >= n) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(`no ${n} running ${role} runs`); };
  return { s, records, spec, tasks, limit, running, settle, waitRunning };
}

const outcome = run => run.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
/** The run's refusal, or a `timeout` marker when this build admitted it and it is still running. */
const refusal = async (run, ms = 1500) => await Promise.race([outcome(run), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), ms))]);

test('角色上限是准入闸门：第 3 个并发运行排队重试，运行行与尝试次数都不增加', async t => {
  const f = await fixture(t, { count: 3 });
  f.limit({ dev: 2 });
  const first = runRole(f.spec(f.tasks[0]), 'dev', 'assign-a', 'capacity-fixture');
  const second = runRole(f.spec(f.tasks[1]), 'dev', 'assign-b', 'capacity-fixture');
  await f.waitRunning('dev', 2);
  // Nothing starts the third run: the refusal comes from admission, before any task_runs row or model request.
  const third = runRole(f.spec(f.tasks[2]), 'dev', 'assign-c', 'capacity-fixture');
  const refused = await refusal(third);
  assert.equal(refused.timeout, undefined, 'a third run was admitted instead of waiting for a free slot');
  assert.equal(refused.error.code, 'role_capacity');
  assert.equal(refused.error.state, 'retry_wait');
  assert.equal(f.running('dev'), 2);
  assert.equal(Number(f.s.get('SELECT count(*) n FROM task_runs WHERE task_id=?', f.tasks[2].id).n), 0);
  assert.equal(f.s.get('SELECT attempt FROM tasks WHERE id=?', f.tasks[2].id).attempt, 1);
  // A capacity wait is not an attempt failure: it must not consume the retry burst either.
  assert.equal(isAttemptFailure('role_capacity', 'retry_wait'), false);
  const admission = JSON.parse(f.s.get("SELECT data FROM task_history WHERE type='role_run_admission' ORDER BY id DESC LIMIT 1").data);
  assert.deepEqual(admission.capacity, { limit: 2, running: 2 });
  // Releasing a slot admits the queued task; the runs that did start still collect their own results.
  f.settle();
  await Promise.all([first, second]);
  assert.equal(f.running('dev'), 0);
  const again = runRole(f.spec(f.tasks[2]), 'dev', 'assign-c', 'capacity-fixture');
  await f.waitRunning('dev', 1);
  f.settle();
  assert.equal((await again).result.summary, 'ok');
});

test('并发提交同一角色不会超过上限（事务内重计数）', async t => {
  const f = await fixture(t, { count: 5 });
  f.limit({ dev: 2 });
  // Every submission is recorded as it settles; the admitted runs stay blocked, so nothing awaits them here.
  const results = [];
  const runs = f.tasks.map((task, index) => runRole(f.spec(task), 'dev', 'assign-' + index, 'capacity-fixture')
    .then(value => { results.push({ ok: true }); return value; }, error => { results.push({ ok: false, code: error.code }); return null; }));
  await f.waitRunning('dev', 2);
  for (let i = 0; i < 200 && results.filter(result => !result.ok).length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.running('dev'), 2, 'never more running runs than the limit');
  const refused = results.filter(result => !result.ok);
  assert.equal(refused.length, 3, JSON.stringify(results));
  for (const result of refused) assert.equal(result.code, 'role_capacity');
  f.settle();
  await Promise.all(runs);
  assert.equal(results.filter(result => result.ok).length, 2);
});

test('只读 observer 不占角色容量，超额也不拒绝', async t => {
  const f = await fixture(t, { count: 2 });
  f.limit({ reviewer: 1 });
  const first = runRole(f.spec(f.tasks[0]), 'reviewer', 'assign-a', 'capacity-fixture');
  const second = runRole(f.spec(f.tasks[1]), 'reviewer', 'assign-b', 'capacity-fixture');
  await f.waitRunning('reviewer', 2);
  assert.equal(f.running('reviewer'), 2);
  const admission = JSON.parse(f.s.get("SELECT data FROM task_history WHERE type='role_run_admission' ORDER BY id DESC LIMIT 1").data);
  assert.equal(admission.capacity, undefined);
  f.settle();
  await Promise.all([first, second]);
});

test('未配置上限的项目走原路径：不计数运行行、不写容量字段、不产生新停止原因', async t => {
  const f = await fixture(t, { count: 1, project: 'other', name: 'fixture/other' });
  const run = runRole(f.spec(f.tasks[0]), 'dev', 'assign-a', 'capacity-fixture');
  await f.waitRunning('dev', 1);
  f.settle();
  assert.equal((await run).result.summary, 'ok');
  const admission = JSON.parse(f.s.get("SELECT data FROM task_history WHERE type='role_run_admission' ORDER BY id DESC LIMIT 1").data);
  // The admission record is byte-for-byte the pre-admission shape: no capacity key, no limit, no invented default.
  assert.deepEqual(Object.keys(admission).sort(), ['admitted', 'environment', 'harness', 'kind', 'missing', 'protocol', 'provided', 'required', 'role']);
  assert.deepEqual(f.s.get('SELECT role_concurrency FROM policies WHERE repository_id=?', 'other').role_concurrency, '{}');
});

test('上限只在已配置的角色上生效，未配置的角色与删除后的陈旧键都不拦', async t => {
  const f = await fixture(t, { count: 2 });
  f.limit({ dev: 1, ghost: 1 });
  const first = runRole(f.spec(f.tasks[0]), 'dev', 'assign-a', 'capacity-fixture');
  await f.waitRunning('dev', 1);
  // `ghost` is not a role of this project, so its stored number cannot block the reviewer role.
  const observer = runRole(f.spec(f.tasks[1]), 'reviewer', 'assign-b', 'capacity-fixture');
  await f.waitRunning('reviewer', 1);
  f.settle();
  await Promise.all([first, observer]);
});
