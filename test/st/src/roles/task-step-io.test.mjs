import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';

const longOutput = 'A'.repeat(6990) + 'LONG-END';

async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,phase,created_at,updated_at) VALUES('t-io','101','development.issue','running','#1207 step input and output','model','2026-11-24T08:00:00Z','2026-11-24T08:10:00Z')",
  );
  h.store.run(
    "INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,ended_at,status,context_snapshot,config_snapshot,role,harness) VALUES('run-io','t-io','execution',1,1,'2026-11-24T08:00:05Z','2026-11-24T08:09:00Z','succeeded','{}','{}','dev','pi')",
  );
  h.store.run(
    `INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,finished_at,http_status,state,request_snapshot,response_snapshot)
     VALUES('mr-1','t-io','101','req-1','model-1','gpt-5.4','2026-11-24T08:01:00Z','2026-11-24T08:01:05Z',200,'received',?,?)`,
    JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'system', content: '你是开发。' }, { role: 'user', content: '请修复登录按钮。' }] }),
    JSON.stringify({ choices: [{ message: { content: '已完成修复。' } }] }),
  );
  const insHist = h.store.db.prepare('INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES(?,?,?,?,?,?)');
  insHist.run('t-io', 'tool_started', JSON.stringify({ call_id: 'c1', name: 'read_file', arguments: { path: 'src/login.ts' } }), '2026-11-24T08:00:30Z', 'run-io', 'agent');
  insHist.run('t-io', 'tool_observation', JSON.stringify({ call_id: 'c1', observation: { data: { content: 'first file body' } } }), '2026-11-24T08:00:31Z', 'run-io', 'agent');
  insHist.run('t-io', 'tool_started', JSON.stringify({ call_id: 'c2', name: 'read_file', arguments: { path: 'src/login.ts' } }), '2026-11-24T08:00:40Z', 'run-io', 'agent');
  insHist.run('t-io', 'tool_observation', JSON.stringify({ call_id: 'c2', observation: { data: { content: 'second file body' } } }), '2026-11-24T08:00:41Z', 'run-io', 'agent');
  insHist.run('t-io', 'model_request', JSON.stringify({
    request_id: 'mr-1', state: 'received', http_status: 200,
    request_source: 'model_requests:mr-1:request', response_source: 'model_requests:mr-1:response',
  }), '2026-11-24T08:01:05Z', 'run-io', 'framework');
  insHist.run('t-io', 'role_run_event', JSON.stringify({ type: 'message', data: { text: longOutput } }), '2026-11-24T08:02:00Z', 'run-io', 'agent');
  return { admin, h };
}

test('#1207: a recorded model request is its own step with separate input and output sources', async t => {
  const { admin } = await fixture(t);
  const detail = await admin('/api/tasks/t-io');
  assert.equal(detail.status, 200);
  const run = detail.value.role_runs.find(item => item.run_id === 'run-io');
  assert.ok(run, 'the run is listed');

  const request = run.history_steps.find(step => step.kind === 'model' && step.input_source);
  assert.ok(request, 'a model_request step is present');
  assert.equal(request.input_source, 'model_requests:mr-1:request');
  assert.equal(request.output_source, 'model_requests:mr-1:response');
  assert.equal(request.model, 'gpt-5.4');

  const input = await admin('/api/tasks/t-io/source?ref=model_requests:mr-1:request');
  assert.equal(input.status, 200);
  assert.equal(input.value.source.messages[1].content, '请修复登录按钮。');
  const output = await admin('/api/tasks/t-io/source?ref=model_requests:mr-1:response');
  assert.equal(output.status, 200);
  assert.equal(output.value.source.choices[0].message.content, '已完成修复。');
});

test('#1207: model messages survive native tool rows and keep the whole text readable through their source', async t => {
  const { admin } = await fixture(t);
  const detail = await admin('/api/tasks/t-io');
  const run = detail.value.role_runs.find(item => item.run_id === 'run-io');
  const message = run.history_steps.find(step => step.kind === 'model' && !step.input_source);
  assert.ok(message, 'the model message is still a step when tool_started rows exist');
  assert.equal(message.input_missing, true);
  assert.equal(message.output.length, 6000);
  assert.equal(message.output_truncated, true);
  assert.match(message.output_source, /^task_history:\d+$/);

  const full = await admin(`/api/tasks/t-io/source?ref=${encodeURIComponent(message.output_source)}`);
  assert.equal(full.status, 200);
  assert.equal(full.value.source.data.data.text, longOutput);
});

test('#1207: two steps with the same tool name keep their own input and output', async t => {
  const { admin } = await fixture(t);
  const detail = await admin('/api/tasks/t-io');
  const run = detail.value.role_runs.find(item => item.run_id === 'run-io');
  const reads = run.history_steps.filter(step => step.kind === 'tool' && step.tool === 'read_file');
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0].id, reads[1].id);
  assert.notEqual(reads[0].input_source, reads[1].input_source);
  assert.notEqual(reads[0].output_source, reads[1].output_source);
  assert.equal(reads[0].output.content, 'first file body');
  assert.equal(reads[1].output.content, 'second file body');
  for (const step of reads) {
    const own = await admin(`/api/tasks/t-io/source?ref=${encodeURIComponent(step.output_source)}`);
    assert.equal(own.status, 200);
    const expected = step.output.content;
    assert.equal(own.value.source.data.observation.data.content, expected);
  }
});
