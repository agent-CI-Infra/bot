import { pinLegacyTaskConfiguration } from '../../../fixtures/helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { HttpError } from '../../../../dist/core/security.js';
import { runAgent, configureModelRetry, modelRetryDelay } from '../../../../dist/agent/runtime.js';
import { agentLoop } from '../../../../dist/agent/loop.js';
import { modelSnapshot } from '../../../../dist/storage/payloads.js';

// Retry waits are 1, 3, 9, 27 and 60 seconds in production; here the same schedule runs in milliseconds.
configureModelRetry({ baseMs: 1 });

async function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}',?)", new Date().toISOString());
  store.run("INSERT INTO repositories VALUES('r','fixture/repo','o','a')");
  const requests = []; let respond = () => ({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const reply = await respond(body);
    if (reply.drop) { res.socket.destroy(); return; }
    if (reply.sse) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(reply.sse); return; }
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply.body ?? reply));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r',?,?,?,?)",
    `http://127.0.0.1:${server.address().port}`, 'fixture', store.secrets.seal({ value: 'secret-model-key' }, 'model:m'), new Date().toISOString());
  store.run("INSERT INTO policies(repository_id,model_id,capability_ceiling) VALUES('r','m','develop')");
  const spec = { store, task: { id: 'domain-run', repository_id: 'r', kind: 'custom.analysis' }, redactor: new Redactor(), guard: async () => {}, system: 'Analyze only.', prompt: 'input' };
  return { store, spec, requests, respond(fn) { respond = fn; } };
}
const tool = { type: 'function', function: { name: 'inspect', description: 'Read only.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
// runAgent needs a transport (#1257): these tests of its gateway and lifecycle send one request and answer its text.
const ask = spec => ({ adapter: async services => (await services.request({ messages: [{ role: 'system', content: spec.system }, { role: 'user', content: spec.prompt }] }, 'turn:0')).value?.choices?.[0]?.message?.content, ...spec });

test('generic agent records repository usage and does not require a synthetic tasks row', async t => {
  const f = await fixture(t);
  assert.equal(await runAgent(ask(f.spec)), 'done');
  const row = f.store.get('SELECT * FROM model_requests');
  assert.equal(row.task_id, null); assert.equal(row.repository_id, 'r'); assert.match(row.request_id, /custom.analysis:domain-run/);
  assert.equal(row.input_tokens, 5); assert.equal(row.output_tokens, 2); assert.equal(row.state, 'received');
  assert.equal(f.requests[0].stream, true);
  assert.equal(Object.hasOwn(f.requests[0], 'temperature'), false);
});
test('adapter cannot expand tool set and models stay fixed throughout an invocation', async t => {
  const f = await fixture(t);
  await assert.rejects(runAgent({ ...f.spec, tools: [tool], adapter: services => services.request({ messages: [], tools: [{ type: 'function', function: { name: 'merge' } }] }, 'bad') }), error => error.code === 'agent_tool_not_allowed');
  assert.equal(f.requests.length, 0);
  await assert.rejects(runAgent({ ...f.spec, adapter: async services => {
    await services.request({ messages: [] }, 'first');
    f.store.run("UPDATE models SET model_name='changed' WHERE id='m'");
    return services.request({ messages: [] }, 'second');
  } }), error => error.code === 'model_configuration_changed');
  assert.equal(f.requests.length, 1);
});
test('revoked model access stops a pinned run before the next provider request', async t => {
  const f = await fixture(t);
  await assert.rejects(runAgent({ ...f.spec, adapter: async services => {
    // A shared model restricted to r (#850): removing r from its list revokes it.
    f.store.run("UPDATE models SET repository_id=NULL,restricted=1 WHERE id='m'");
    f.store.run("INSERT INTO model_projects(model_id,repository_id) VALUES('m','r')");
    await services.request({ messages: [] }, 'authorized');
    f.store.run("DELETE FROM model_projects WHERE model_id='m'");
    return services.request({ messages: [] }, 'revoked');
  } }), error => error.code === 'model_not_available');
  assert.equal(f.requests.length, 1);
});
test('a provider failure is recorded without the model key', async t => {
  const f = await fixture(t);
  f.respond(() => ({ status: 503, body: { message: 'secret-model-key unavailable' } }));
  await assert.rejects(runAgent(ask({ ...f.spec, modelAttempts: 1 })), error => error.code === 'model_http_503' && !error.detail.includes('secret-model-key'));
  assert.equal(f.store.get("SELECT count(*) n FROM model_requests WHERE state='http_error'").n, 1);
});

test('SSE guard failures retain cancellation and changed-attempt semantics', async t => {
  for (const code of ['release_attempt_changed', 'release_cancelled']) {
    const f = await fixture(t); let streamed = false;
    const failure = new HttpError(409, code);
    f.respond(() => { streamed = true; return { sse: 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] }) + '\n\ndata: [DONE]\n\n' }; });
    await assert.rejects(runAgent(ask({ ...f.spec, guard: async () => { if (streamed) throw failure; } })), error => error === failure);
    assert.equal(f.store.get('SELECT state FROM model_requests').state, 'guard_failed');
  }
});

const streamContent = count => ({ sse: Array.from({ length: count }, () =>
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] }) + '\n\n').join('') + 'data: [DONE]\n\n' });

test('SSE bursts throttle full guards while retaining request boundaries and every progress callback', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let streaming = false, tokens = 0;
  const guards = { before: 0, stream: 0, after: 0 };
  f.respond(() => { streaming = true; return streamContent(50); });
  const value = await runAgent({ ...f.spec,
    guard: async () => { guards[streaming ? 'stream' : tokens ? 'after' : 'before']++; },
    adapter: async services => (await services.request({ messages: [] }, 'burst', async () => {
      if (++tokens === 50) streaming = false;
    })).value
  });
  assert.equal(value.choices[0].message.content, 'x'.repeat(50));
  assert.equal(tokens, 50);
  // The completed response is guarded before its snapshot is retained as well as before acceptance.
  assert.deepEqual(guards, { before: 2, stream: 1, after: 3 });
  assert.equal(f.store.get('SELECT state FROM model_requests').state, 'received');
});

test('SSE streams recheck the full guard once a second without throttling progress', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let streaming = false, tokens = 0;
  const checks = [];
  f.respond(() => { streaming = true; return streamContent(10); });
  await runAgent({ ...f.spec,
    guard: async () => { if (streaming) checks.push(Date.now()); },
    adapter: services => services.request({ messages: [] }, 'paced', async () => {
      t.mock.timers.tick(400);
      if (++tokens === 10) streaming = false;
    })
  });
  assert.equal(tokens, 10);
  assert.deepEqual(checks, [1000000, 1001200, 1002400, 1003600]);
});

test('a later throttled SSE guard preserves the original lease failure and stops progress', async t => {
  const f = await fixture(t), failure = new HttpError(409, 'release_attempt_changed');
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let streaming = false, tokens = 0;
  f.respond(() => { streaming = true; return streamContent(10); });
  await assert.rejects(runAgent({ ...f.spec,
    guard: async () => { if (streaming && Date.now() >= 1001000) throw failure; },
    adapter: services => services.request({ messages: [] }, 'cancelled', async () => {
      tokens++; t.mock.timers.tick(400);
    })
  }), error => error === failure);
  assert.equal(tokens, 3);
  assert.equal(f.store.get('SELECT state FROM model_requests').state, 'guard_failed');
});

test('concurrent role models isolate messages and bill the actual models at their own prices', async t => {
  const { selectedModel } = await import('../../../../dist/agent/model.js');
  const { saveConfiguration, roleConfiguration } = await import('../../../../dist/roles/definition.js');
  const f = await fixture(t);
  f.store.run(`INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at)
    SELECT 'coding','r',api_url,'coding-model',?,updated_at FROM models WHERE id='m'`, f.store.secrets.seal({value:'coding-secret-key'}, 'model:coding'));
  f.store.run("INSERT INTO model_pricing VALUES('m','USD',1,2,1)");
  f.store.run("INSERT INTO model_pricing VALUES('coding','CNY',10,20,10)");
  saveConfiguration(f.store, 'r', { expected_revision: roleConfiguration(f.store, 'r').revision, enabled: true, roles: [{ role_id: 'dev', model_profile_ref: { model_id: 'coding' } }] }, 'fixture');
  let release; const bothStarted = new Promise(resolve => { release = resolve; });
  f.respond(async body => {
    if (f.requests.length === 2) release();
    await bothStarted;
    return {choices:[{message:{content:body.model}}],usage:{prompt_tokens:5,completion_tokens:2}};
  });
  const result = await Promise.all([['reviewer', 'review.pr'], ['dev', 'development.issue']].map(([role, label]) => runAgent(ask({
    ...f.spec, model: selectedModel(f.store, 'r', role), task:{...f.spec.task,id:label,kind:'task.request'}, redactor:new Redactor(), prompt:label
  }))));
  assert.deepEqual(result,['fixture','coding-model']);
  for (const request of f.requests) {
    assert.equal(request.messages.length,2);
    assert.equal(request.messages[1].content,request.model==='fixture'?'review.pr':'development.issue');
  }
  const rows = f.store.all('SELECT model_id,currency,cost FROM model_requests ORDER BY model_id').map(row => ({...row}));
  assert.deepEqual(rows,[{model_id:'coding',currency:'CNY',cost:0.00009},{model_id:'m',currency:'USD',cost:0.000009}]);
});

test('mapping changes affect future runs while a pinned run rechecks credential revocation', async t => {
  const f = await fixture(t);
  await assert.rejects(runAgent({...f.spec,adapter:async services => {
    await services.request({messages:[]},'first');
    f.store.run('UPDATE policies SET task_models=?',JSON.stringify({'custom.analysis':'unavailable'}));
    await services.request({messages:[]},'still-pinned');
    f.store.run("UPDATE models SET api_key=NULL WHERE id='m'");
    return services.request({messages:[]},'revoked');
  }}),{code:'model_not_configured'});
  assert.equal(f.requests.length,2);
  assert.ok(f.requests.every(request=>request.model==='fixture'));
  await assert.rejects(runAgent(ask(f.spec)),{code:'model_not_configured'});
  assert.equal(f.requests.length,2);
});

test('workspace review conversations leave history to the Pi session and tell its start boundary how it began', async t => {
  for (const changeModel of [false, true]) await t.test(changeModel ? 'changed model stops the next request' : 'ready round keeps no history copy', async t => {
    const f = await fixture(t), task = {id:'review',repository_id:'r',kind:'review.pr',workspace_id:'workspace'};
    f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('review','r','review.pr','running','Review')");
    const configBytes = [], stages = [], operations = [];
    const ready = {summary:'Reviewed',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
    let config, boundaryDone = false, replies = 0;
    const workspace = { log() {}, async call(_key, request) {
      operations.push(request.type);
      if (request.type === 'workspace_agent_poll') assert.fail('Conversation polls must use deliver, not the old cached path');
      if (request.type === 'workspace_agent_config') {
        configBytes.push(Buffer.from(request.base64,'base64'));
        if (request.final) config = JSON.parse(Buffer.concat(configBytes));
      }
      if (request.type === 'workspace_agent_boundary' && request.final) boundaryDone = true;
      if (request.type === 'workspace_agent_reply' && request.final) {
        replies++;
        if (changeModel && replies === 1) f.store.run("UPDATE models SET version=version+1,model_name='changed' WHERE id='m'");
      }
      return {};
    }, async deliver(request) {
      operations.push(request.type);
      if (request.type === 'workspace_agent_poll') {
        if (!boundaryDone) return {state:'running',boundary:{id:'b'.repeat(48),stage:'start',recovery:'native_resume'}};
        if (!replies || changeModel && replies === 1) return {state:'running',request:{id:(replies?'d':'c').repeat(48),body:{messages:[{role:'user',content:'Current review'}],tools:config.tools}}};
        return {state:'review_ready',offset:12,result:ready};
      }
      return {};
    }};
    const conversation = {boundary:async (stage, recovery) => {stages.push([stage, recovery]);return {prompt:'Current discussion'};}};
    pinLegacyTaskConfiguration(f.store,task.id);
    const running = agentLoop(f.store,task,workspace,f.spec.redactor,f.spec.guard,{},undefined,undefined,conversation);
    if (changeModel) await assert.rejects(running,{code:'model_configuration_changed'});
    else {
      assert.equal((await running).summary,'Reviewed');
      // The conversation stays in Pi's session file (#1040): the control plane neither sends nor collects a copy of it.
      assert.equal(f.store.get("SELECT messages FROM tasks WHERE id='review'").messages,null);
      assert.equal(conversation.offset,12);
    }
    assert.ok(!operations.some(type => ['workspace_agent_history','workspace_agent_session'].includes(type)), operations.join());
    assert.equal(config.review_session,true); assert.equal(config.capabilities.workspace.write,false);
    assert.ok(!config.tools.some(tool=>tool.function.name==='create_pull_request'));
    assert.deepEqual(stages,[['start','native_resume']]);
    assert.equal(f.requests.length,1);
    assert.equal(f.store.get("SELECT model_started FROM tasks WHERE id='review'").model_started,1);
    assert.match(f.store.get('SELECT request_id FROM model_requests').request_id,/^review\.pr:review:/);
  });
});

test('workspace development keeps publication tools and write capabilities after session integration', async t => {
  const f = await fixture(t), configBytes = []; let config, published = false;
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('domain-run','r','development.issue','running','fixture','{}')");
  pinLegacyTaskConfiguration(f.store, 'domain-run');
  const workspace = {log(){},async call(_key,request){
    if (request.type === 'workspace_agent_config') {
      configBytes.push(Buffer.from(request.base64,'base64'));
      if (request.final) config = JSON.parse(Buffer.concat(configBytes));
    }
    if (request.type === 'workspace_agent_poll') return published ? {state:'completed'} : {state:'running',tool_requests:[{id:'a'.repeat(48),kind:'pull_request',name:'create_pull_request',arguments:{summary:'Fixed',test_command:'npm test'}}]};
    return {};
  }};
  const result = await agentLoop(f.store,{...f.spec.task,kind:'development.issue'},workspace,f.spec.redactor,f.spec.guard,{},undefined,async()=>{published=true;return {pr:{number:1}};});
  assert.equal(result.pr.number,1); assert.equal(config.review_session,false);
  assert.equal(config.capabilities.workspace.write,true); assert.equal(config.capabilities.github.publication,'pull_request');
  assert.ok(config.tools.some(tool=>tool.function.name==='create_pull_request'));
  assert.ok(!config.tools.some(tool=>tool.function.name==='finish_review'));
});

for (const status of [429, 503]) test('container-default model transport recovers HTTP '+status+' within a trusted finite budget', async t => {
  const f = await fixture(t); let attempts = 0;
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('domain-run','r','custom.analysis','running','retry test')");
  f.respond(() => ++attempts < 3 ? { status, body: { error: 'transient' } } : { choices: [{ message: { content: 'recovered' } }] });
  assert.equal(await runAgent(ask(f.spec)), 'recovered');
  assert.equal(attempts, 3);
  assert.equal(f.store.get("SELECT count(*) n FROM task_logs WHERE json_extract(content,'$.type')='model_retry'").n, 2);
});
test('transport retry budget is bounded and permanent errors are never retried', async t => {
  const f = await fixture(t);
  for (const modelAttempts of [0, 7, 1.5]) await assert.rejects(runAgent(ask({ ...f.spec, modelAttempts })), e => e.code === 'agent_limits_invalid');
  assert.equal(f.requests.length, 0);
  f.respond(() => ({ status: 503, body: { error: 'transient' } }));
  await assert.rejects(runAgent(ask({ ...f.spec, modelAttempts: 2 })), e => e.code === 'model_http_503' && e.detail.endsWith('（已自动重试 1 次仍失败）'));
  assert.equal(f.requests.length, 2);
  f.respond(() => ({ status: 401, body: { error: 'unauthorized' } }));
  await assert.rejects(runAgent(ask(f.spec)), e => e.code === 'model_authentication_failed');
  assert.equal(f.requests.length, 3);
});

test('trace retains actual sanitized model I/O and immutable run configuration without private reasoning', async t => {
  const f=await fixture(t);f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('domain-run','r','task.request','running','trace input')");
  f.respond(()=>({choices:[{message:{content:'public result',reasoning_content:'PRIVATE_REASONING_SENTINEL'}}],usage:{prompt_tokens:5,completion_tokens:2}}));
  assert.equal(await runAgent(ask({...f.spec,prompt:'source input',requestPrefix:'acceptance:trace:'})), 'public result');
  const run=f.store.get('SELECT * FROM task_runs'),request=f.store.get('SELECT * FROM model_requests');assert.equal(run.kind,'acceptance');assert.equal(run.status,'succeeded');assert.equal(request.run_id,run.id);
  assert.equal(request.request_snapshot,null);const input=JSON.parse(modelSnapshot(f.store,request,'request')),output=JSON.parse(modelSnapshot(f.store,request,'response'));assert.ok(input.complete&&output.complete);assert.equal(input.data.messages[1].content,'source input');assert.equal(output.data.choices[0].message.content,'public result');assert.doesNotMatch(JSON.stringify(output),/PRIVATE_REASONING_SENTINEL/);
  f.store.run("UPDATE models SET model_name='later-config' WHERE id='m'");assert.equal(JSON.parse(run.config_snapshot).data.model.name,'fixture');assert.doesNotMatch(run.config_snapshot,/secret-model-key/);
});

test('a model request that gets no response is retried five times by default, with growing waits, before the run fails', async t => {
  const f = await fixture(t); let sent = 0; const retries = [];
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('domain-run','r','custom.analysis','running','retry test')");
  assert.deepEqual([1, 2, 3, 4, 5].map(modelRetryDelay), [1, 3, 9, 27, 60]);
  // The connection drops without a response five times; the sixth request answers.
  f.respond(() => ++sent <= 5 ? { drop: true } : { choices: [{ message: { content: 'recovered after five retries' } }] });
  assert.equal(await runAgent(ask({ ...f.spec, onModelRetry: retry => { retries.push(retry); } })), 'recovered after five retries');
  assert.equal(f.requests.length, 6);
  assert.deepEqual(retries.map(r => [r.retry, r.retries, r.code, r.delay_ms]), [1, 2, 3, 4, 5].map(n => [n, 5, 'model_unavailable', modelRetryDelay(n)]));
  assert.match(retries[0].detail, /请求失败：/);
  const logged = f.store.all("SELECT content FROM task_logs WHERE json_extract(content,'$.type')='model_retry'").map(row => JSON.parse(row.content));
  assert.deepEqual(logged.map(l => l.retry), [1, 2, 3, 4, 5]); assert.ok(logged.every(l => l.detail && l.delay_ms));
  // Each failed request keeps its reason in its own record, so it can be explained after the process is gone.
  const failed = f.store.all("SELECT * FROM model_requests WHERE state='transport_error' ORDER BY requested_at");
  assert.equal(failed.length, 5);
  for (const row of failed) assert.match(JSON.parse(modelSnapshot(f.store, row, 'response')).data.detail, /网络错误|连接/);
  // Six failures in a row end the run, and the failure says it was retried.
  sent = 0; f.respond(() => ({ drop: true }));
  await assert.rejects(runAgent(ask(f.spec)), e => e.code === 'model_unavailable' && e.state === 'retry_wait' && e.detail.endsWith('（已自动重试 5 次仍失败）'));
  assert.equal(f.requests.length, 12);
});

test('a stopped run does not wait out a retry delay', async t => {
  const f = await fixture(t), controller = new AbortController();
  configureModelRetry({ baseMs: 60000 }); t.after(() => configureModelRetry({ baseMs: 1 }));
  f.respond(() => ({ status: 503, body: { error: 'busy' } }));
  const started = Date.now();
  // The stop arrives while the first retry would wait a minute; the wait ends at once and the guard reports the stop.
  await assert.rejects(runAgent(ask({ ...f.spec, executionSignal: controller.signal, onModelRetry: () => { controller.abort(); },
    guard: async () => { if (controller.signal.aborted) throw Object.assign(new Error('stopped'), { code: 'run_stopped' }); } })), e => e.code === 'run_stopped');
  assert.ok(Date.now() - started < 5000); assert.equal(f.requests.length, 1);
});
