import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { HttpError } from '../dist/core/security.js';
import { runAgent } from '../dist/agent/runtime.js';
import { agentLoop } from '../dist/agent/loop.js';

async function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}',?)", new Date().toISOString());
  store.run("INSERT INTO repositories VALUES('r','fixture/repo','o','a')");
  const requests = []; let respond = () => ({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const reply = await respond(body);
    if (reply.sse) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(reply.sse); return; }
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply.body ?? reply));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r',?,?,?,?)",
    `http://127.0.0.1:${server.address().port}`, 'fixture', store.secrets.seal({ value: 'secret-model-key' }, 'model:m'), new Date().toISOString());
  store.run("INSERT INTO policies(repository_id,model_id) VALUES('r','m')");
  const spec = { store, task: { id: 'domain-run', repository_id: 'r', kind: 'custom.analysis' }, redactor: new Redactor(), guard: async () => {}, system: 'Analyze only.', prompt: 'input' };
  return { store, spec, requests, respond(fn) { respond = fn; } };
}
const tool = { type: 'function', function: { name: 'inspect', description: 'Read only.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
const call = name => ({ id: 'call', type: 'function', function: { name, arguments: '{}' } });

test('generic agent records repository usage and does not require a synthetic tasks row', async t => {
  const f = await fixture(t);
  assert.equal(await runAgent(f.spec), 'done');
  const row = f.store.get('SELECT * FROM model_requests');
  assert.equal(row.task_id, null); assert.equal(row.repository_id, 'r'); assert.match(row.request_id, /custom.analysis:domain-run/);
  assert.equal(row.input_tokens, 5); assert.equal(row.output_tokens, 2); assert.equal(row.state, 'received');
  assert.equal(f.requests[0].stream, true);
  assert.equal(Object.hasOwn(f.requests[0], 'temperature'), false);
});
test('generic agent allowlist denies invented tools, redacts tool output and validates results', async t => {
  const f = await fixture(t); let turn = 0, invoked = 0;
  f.respond(() => ({ choices: [{ message: ++turn === 1 ? { tool_calls: [call('publish_release')] } : turn === 2 ? { tool_calls: [call('inspect')] } : { content: '{"ok":true}' } }] }));
  const result = await runAgent({ ...f.spec, tools: [tool], execute: async () => { invoked++; return { text: 'secret-model-key' }; }, validate: content => JSON.parse(content) });
  assert.deepEqual(result, { ok: true }); assert.equal(invoked, 1);
  const messages = f.requests[2].messages;
  assert.ok(messages.some(message => message.role === 'tool' && message.content.includes('tool_not_allowed')));
  assert.ok(messages.some(message => message.role === 'tool' && message.content.includes('REDACTED')));
  assert.ok(!JSON.stringify(f.requests).includes('secret-model-key'));
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
    f.store.run("UPDATE models SET repository_id=NULL WHERE id='m'");
    f.store.run("INSERT INTO model_projects(model_id,repository_id) VALUES('m','r')");
    await services.request({ messages: [] }, 'authorized');
    f.store.run("DELETE FROM model_projects WHERE model_id='m'");
    return services.request({ messages: [] }, 'revoked');
  } }), error => error.code === 'model_not_available');
  assert.equal(f.requests.length, 1);
});
test('generic loop has a turn limit and records provider failures', async t => {
  const f = await fixture(t);
  f.respond(() => ({ choices: [{ message: { tool_calls: [call('inspect')] } }] }));
  await assert.rejects(runAgent({ ...f.spec, tools: [tool], maxTurns: 1, execute: async () => ({ ok: true }) }), error => error.code === 'agent_turn_limit');
  f.respond(() => ({ status: 503, body: { message: 'secret-model-key unavailable' } }));
  await assert.rejects(runAgent(f.spec), error => error.code === 'model_http_503' && !error.detail.includes('secret-model-key'));
  assert.equal(f.store.get("SELECT count(*) n FROM model_requests WHERE state='http_error'").n, 1);
});

test('SSE guard failures retain cancellation and changed-attempt semantics', async t => {
  for (const code of ['release_attempt_changed', 'release_cancelled']) {
    const f = await fixture(t); let streamed = false;
    const failure = new HttpError(409, code);
    f.respond(() => { streamed = true; return { sse: 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] }) + '\n\ndata: [DONE]\n\n' }; });
    await assert.rejects(runAgent({ ...f.spec, guard: async () => { if (streamed) throw failure; } }), error => error === failure);
    assert.equal(f.store.get('SELECT state FROM model_requests').state, 'guard_failed');
  }
});

test('concurrent task overrides isolate messages and bill the actual models at their own prices', async t => {
  const f = await fixture(t);
  f.store.run(`INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at)
    SELECT 'coding','r',api_url,'coding-model',?,updated_at FROM models WHERE id='m'`, f.store.secrets.seal({value:'coding-secret-key'}, 'model:coding'));
  f.store.run("INSERT INTO model_pricing VALUES('m','USD',1,2,1)");
  f.store.run("INSERT INTO model_pricing VALUES('coding','CNY',10,20,10)");
  f.store.run('UPDATE policies SET task_models=?', JSON.stringify({'review.pr':'m','development.issue':'coding'}));
  let release; const bothStarted = new Promise(resolve => { release = resolve; });
  f.respond(async body => {
    if (f.requests.length === 2) release();
    await bothStarted;
    return {choices:[{message:{content:body.model}}],usage:{prompt_tokens:5,completion_tokens:2}};
  });
  const result = await Promise.all(['review.pr','development.issue'].map(kind => runAgent({
    ...f.spec, task:{...f.spec.task,id:kind,kind}, redactor:new Redactor(), prompt:kind
  })));
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
  }}),{code:'model_not_available'});
  assert.equal(f.requests.length,2);
  assert.ok(f.requests.every(request=>request.model==='fixture'));
  await assert.rejects(runAgent(f.spec),{code:'model_not_configured'});
  assert.equal(f.requests.length,2);
});

test('workspace review conversations retain history and boundaries while using the pinned gateway', async t => {
  for (const changeModel of [false, true]) await t.test(changeModel ? 'changed model stops the next request' : 'ready history is persisted', async t => {
    const f = await fixture(t), task = {id:'review',repository_id:'r',kind:'review.pr',workspace_id:'workspace'};
    f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('review','r','review.pr','running','Review')");
    const history = [{role:'user',content:'Earlier discussion secret-model-key'}], configBytes = [], restoreBytes = [], stages = [];
    const ready = {summary:'Reviewed',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
    let config, boundaryDone = false, replies = 0;
    const workspace = { log() {}, async call(_key, request) {
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
      if (request.type === 'workspace_agent_history') restoreBytes.push(Buffer.from(request.base64,'base64'));
      if (request.type === 'workspace_agent_session') {
        const bytes = Buffer.from(JSON.stringify(history)); return {size:bytes.length,base64:bytes.toString('base64')};
      }
      if (request.type === 'workspace_agent_poll') {
        if (!boundaryDone) return {state:'running',boundary:{id:'b'.repeat(48),stage:'start'}};
        if (!replies || changeModel && replies === 1) return {state:'running',request:{id:(replies?'d':'c').repeat(48),body:{messages:[{role:'user',content:'Current review'}],tools:config.tools}}};
        return {state:'review_ready',offset:12,result:ready};
      }
      return {};
    }};
    const conversation = {history,boundary:async stage => {stages.push(stage);return {prompt:'Current discussion'};}};
    const running = agentLoop(f.store,task,workspace,f.spec.redactor,f.spec.guard,{},undefined,undefined,conversation);
    if (changeModel) await assert.rejects(running,{code:'model_configuration_changed'});
    else {
      assert.equal((await running).summary,'Reviewed');
      assert.deepEqual(JSON.parse(f.store.get("SELECT messages FROM tasks WHERE id='review'").messages),[{role:'user',content:'Earlier discussion [REDACTED]'}]);
      assert.equal(conversation.offset,12);
    }
    assert.equal(config.review_session,true); assert.equal(config.capabilities.workspace.write,false);
    assert.ok(!config.tools.some(tool=>tool.function.name==='create_pull_request'));
    assert.deepEqual(stages,['start']);
    assert.deepEqual(JSON.parse(Buffer.concat(restoreBytes)),[{role:'user',content:'Earlier discussion [REDACTED]'}]);
    assert.equal(f.requests.length,1);
    assert.equal(f.store.get("SELECT model_started FROM tasks WHERE id='review'").model_started,1);
    assert.match(f.store.get('SELECT request_id FROM model_requests').request_id,/^review\.pr:review:/);
  });
});

test('workspace development keeps publication tools and write capabilities after session integration', async t => {
  const f = await fixture(t), configBytes = []; let config, published = false;
  const workspace = {log(){},async call(_key,request){
    if (request.type === 'workspace_agent_config') {
      configBytes.push(Buffer.from(request.base64,'base64'));
      if (request.final) config = JSON.parse(Buffer.concat(configBytes));
    }
    if (request.type === 'workspace_agent_poll') return published ? {state:'completed'} : {state:'running',pull_request:{id:'a'.repeat(48),arguments:{summary:'Fixed',test_command:'npm test'}}};
    return {};
  }};
  const result = await agentLoop(f.store,{...f.spec.task,kind:'development.issue'},workspace,f.spec.redactor,f.spec.guard,{},undefined,async()=>{published=true;return {pr:{number:1}};});
  assert.equal(result.pr.number,1); assert.equal(config.review_session,false);
  assert.equal(config.capabilities.workspace.write,true); assert.equal(config.capabilities.github.publication,'pull_request');
  assert.ok(config.tools.some(tool=>tool.function.name==='create_pull_request'));
  assert.ok(!config.tools.some(tool=>tool.function.name==='finish_review'));
});
