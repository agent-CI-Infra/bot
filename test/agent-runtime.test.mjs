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
  await assert.rejects(runAgent({ ...f.spec, modelAttempts: 1 }), error => error.code === 'model_http_503' && !error.detail.includes('secret-model-key'));
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
  assert.deepEqual(guards, { before: 2, stream: 1, after: 2 });
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

test('bounded delivery execution reserves turns to save and submit without claiming acceptance',async t=>{
 const f=await fixture(t);let saved=false;
 const submit={type:'function',function:{name:'submit_delivery',description:'Hand a report to acceptance',parameters:{type:'object',properties:{},additionalProperties:false}}};
 f.respond(body=>{
  const deadline=body.messages.some(m=>m.role==='user'&&m.content.includes('turns left in this attempt'));
  return {choices:[{message:{tool_calls:[call(deadline&&saved?'submit_delivery':'inspect')]}}]};
 });
 const result=await runAgent({...f.spec,tools:[tool,submit],maxTurns:4,finish:{name:'submit_delivery',validate:()=>({submitted:true})},execute:async()=>{
  if(f.requests.at(-1).messages.some(m=>m.role==='user'&&m.content.includes('turns left in this attempt')))saved=true;
  return {artifact_saved:saved};
 }});
 assert.deepEqual(result,{submitted:true});assert.ok(saved);assert.equal(f.requests.length,4);
 assert.equal(f.requests[0].messages.length,2);assert.equal(f.store.get('SELECT count(*) n FROM tasks').n,0);
 assert.ok(f.requests.at(-1).messages.some(m=>m.role==='user'&&m.content.includes('independent acceptance')));
});

test('delivery finalization closes exploration and requests an honest structured handoff within the existing budget',async t=>{
 const f=await fixture(t);let invoked=0;
 const submit={type:'function',function:{name:'submit_delivery',description:'Submit remaining gaps',parameters:{type:'object',properties:{},additionalProperties:false}}};
 f.respond(body=>({choices:[{message:{tool_calls:[call(body.tool_choice?.function?.name||'inspect')]}}]}));
 const value=await runAgent({...f.spec,tools:[tool,submit],maxTurns:4,finish:{name:'submit_delivery',validate:()=>({submitted:true,gaps:['Execution budget reached; independent acceptance must assess completeness']})},finalizationTools:['submit_delivery'],execute:async()=>{invoked++;return {observed:true};}});
 assert.equal(invoked,2);assert.equal(f.requests.length,4);assert.deepEqual(f.requests[2].tools.map(t=>t.function.name),['submit_delivery']);
 assert.ok(f.requests[3].messages.some(m=>m.role==='tool'&&m.content.includes('tool_not_allowed')));
 assert.equal(f.requests[3].tool_choice.function.name,'submit_delivery');assert.equal(value.submitted,true);assert.equal(value.gaps.length,1);assert.equal(f.store.get('SELECT count(*) n FROM tasks').n,0);
});

for (const status of [429, 503]) test('container-default model transport recovers HTTP '+status+' within a trusted finite budget', async t => {
  const f = await fixture(t); let attempts = 0;
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('domain-run','r','custom.analysis','running','retry test')");
  f.respond(() => ++attempts < 3 ? { status, body: { error: 'transient' } } : { choices: [{ message: { content: 'recovered' } }] });
  assert.equal(await runAgent(f.spec), 'recovered');
  assert.equal(attempts, 3);
  assert.equal(f.store.get("SELECT count(*) n FROM task_logs WHERE json_extract(content,'$.type')='model_retry'").n, 2);
});
test('transport retry budget is bounded and permanent errors are never retried', async t => {
  const f = await fixture(t);
  for (const modelAttempts of [0, 4, 1.5]) await assert.rejects(runAgent({ ...f.spec, modelAttempts }), e => e.code === 'agent_limits_invalid');
  assert.equal(f.requests.length, 0);
  f.respond(() => ({ status: 503, body: { error: 'transient' } }));
  await assert.rejects(runAgent({ ...f.spec, modelAttempts: 2 }), e => e.code === 'model_http_503');
  assert.equal(f.requests.length, 2);
  f.respond(() => ({ status: 401, body: { error: 'unauthorized' } }));
  await assert.rejects(runAgent(f.spec), e => e.code === 'model_authentication_failed');
  assert.equal(f.requests.length, 3);
});

test('trace retains actual sanitized model I/O and immutable run configuration without private reasoning', async t => {
  const f=await fixture(t);f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('domain-run','r','task.request','running','trace input')");
  f.respond(()=>({choices:[{message:{content:'public result',reasoning_content:'PRIVATE_REASONING_SENTINEL'}}],usage:{prompt_tokens:5,completion_tokens:2}}));
  assert.equal(await runAgent({...f.spec,prompt:'source input',requestPrefix:'acceptance:trace:'}), 'public result');
  const run=f.store.get('SELECT * FROM task_runs'),request=f.store.get('SELECT * FROM model_requests');assert.equal(run.kind,'acceptance');assert.equal(run.status,'succeeded');assert.equal(request.run_id,run.id);
  const input=JSON.parse(request.request_snapshot),output=JSON.parse(request.response_snapshot);assert.ok(input.complete&&output.complete);assert.equal(input.data.messages[1].content,'source input');assert.equal(output.data.choices[0].message.content,'public result');assert.doesNotMatch(JSON.stringify(output),/PRIVATE_REASONING_SENTINEL/);
  f.store.run("UPDATE models SET model_name='later-config' WHERE id='m'");assert.equal(JSON.parse(run.config_snapshot).data.model.name,'fixture');assert.doesNotMatch(run.config_snapshot,/secret-model-key/);
});

test('mandatory finish rejects plain text bypass and accepts the subsequent structured submission',async t=>{
 const f=await fixture(t);let turn=0;
 f.respond(()=>({choices:[{message:++turn===1?{content:''}:{tool_calls:[call('submit')]}}]}));
 const submit={...tool,function:{...tool.function,name:'submit'}};
 const result=await runAgent({...f.spec,tools:[submit],maxTurns:3,finish:{name:'submit',validate:a=>({ok:true})}});
 assert.deepEqual(result,{ok:true});assert.equal(f.requests.length,2);
});
test('output budget exhaustion is explicit and never becomes a successful empty result',async t=>{
 const f=await fixture(t);f.respond(()=>({choices:[{message:{content:''},finish_reason:'length'}]}));
 await assert.rejects(runAgent({...f.spec,tools:[{...tool,function:{...tool.function,name:'submit'}}],finish:{name:'submit',validate:a=>a}}),e=>e.code==='agent_output_budget_exhausted');
});
// The gateway's request limit; the control-plane loop applies no 128k context estimate.
const fitsGateway=body=>Buffer.byteLength(JSON.stringify(body))<=2*1024*1024;
const toolReplies=body=>body.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
test('a tool result no request can hold is withheld as a tool error and the agent continues',async t=>{
  // Production: one read_file of a 1.87 MB context file made the next request exceed 2 MiB and failed the task.
  const f=await fixture(t);let turn=0;
  f.respond(()=>({choices:[{message:++turn===1?{tool_calls:[call('inspect')]}:{content:'done'}}]}));
  const result=await runAgent({...f.spec,tools:[tool],execute:async()=>({content:'x'.repeat(2200000)})});
  assert.equal(result,'done');assert.equal(f.requests.length,2);
  const [reply]=toolReplies(f.requests[1]);
  assert.equal(reply.error,'tool_result_too_large');assert.ok(reply.result_characters>2200000);assert.match(reply.detail,/smaller part/);
  assert.ok(f.requests.every(fitsGateway));
});
test('earlier tool results are elided, oldest first, when the conversation outgrows the request limits',async t=>{
  // Each result fits on its own; eight of them are 2.4 MB, which the gateway would refuse.
  const f=await fixture(t);let turn=0;
  f.respond(()=>({choices:[{message:++turn<=8?{tool_calls:[{...call('inspect'),id:'call'+turn}]}:{content:'done'}}]}));
  let n=0;const result=await runAgent({...f.spec,tools:[tool],maxTurns:12,execute:async()=>({content:String(++n).repeat(300000)})});
  assert.equal(result,'done');assert.equal(f.requests.length,9);
  assert.ok(f.requests.every(fitsGateway),'every request fits the gateway');
  const replies=toolReplies(f.requests.at(-1)),elided=replies.findIndex(reply=>!reply.elided);
  assert.equal(replies.length,8);assert.ok(elided>=1,'the oldest results are elided');
  assert.ok(replies.slice(0,elided).every(reply=>reply.result_characters>300000)&&replies.slice(elided).every(reply=>!reply.elided),'only a prefix of the oldest results is elided');
  assert.equal(replies.at(-1).content,'8'.repeat(300000),'the latest result is kept');
});
test('a request still over 2 MiB without any tool result to elide stops as agent_context_too_large before reaching the gateway',async t=>{
  const f=await fixture(t);
  await assert.rejects(runAgent({...f.spec,prompt:'p'.repeat(2200000)}),error=>error.code==='agent_context_too_large');
  assert.equal(f.requests.length,0);
});
test('a prompt and results within 2 MiB are sent unchanged, for models with a window over 128k',async t=>{
  const f=await fixture(t);
  assert.equal(await runAgent({...f.spec,prompt:'p'.repeat(600000)}),'done');assert.equal(f.requests.length,1);
});
