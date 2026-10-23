import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { harness, setup, account, repository } from './helpers.mjs';
import { agentLoop } from '../dist/agent/loop.js';
import { Redactor } from '../dist/agent/common.js';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function proxyWorkspace(logs=[]) {
  let configBytes=[],config,replyBytes=[],replied=false;
  return {log:value=>logs.push(value),call:async(_key,request)=>{
    if(request.type==='workspace_agent_config'){configBytes.push(Buffer.from(request.base64,'base64'));if(request.final)config=JSON.parse(Buffer.concat(configBytes));return {written:true};}
    if(request.type==='workspace_agent_start')return {started:true};
    if(request.type==='workspace_agent_reply'){replyBytes.push(Buffer.from(request.base64,'base64'));if(request.final)replied=true;return {written:true};}
    if(request.type==='workspace_agent_poll'){
      if(!replied)return {state:'running',request:{id:'a'.repeat(48),body:{stream:true,messages:[{role:'system',content:config.system},{role:'user',content:config.prompt}]}},events:[],offset:0};
      const reply=JSON.parse(Buffer.concat(replyBytes)),chunk=JSON.parse(reply.body.split('\n')[0].slice(6)),call=chunk.choices[0].delta.tool_calls[0];
      return {state:'completed',result:JSON.parse(call.function.arguments),events:[{type:'model',content:'Pi finished',tool_calls:[{name:call.function.name}]}],offset:1};
    }
    throw new Error('unexpected runner request');
  }};
}
test('the control plane relays Pi model requests with the configured model and keeps its key out of the runner', async t => {
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const received=[],finish={summary:'Short summary.',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
  const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;received.push({authorization:req.headers.authorization,body:JSON.parse(raw)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[call('f','finish_review',finish)]}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'process-fixture-key',model_name:'fixture'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id,review_enabled:true});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token) VALUES('process','101','review.pr','running','pr',4,'claim')");
  const logs=[],workspace=proxyWorkspace(logs),requests=[],original=workspace.call;workspace.call=async(...args)=>{requests.push(args[1]);return original(...args);};
  const result=await agentLoop(h.store,h.store.get("SELECT * FROM tasks WHERE id='process'"),workspace,new Redactor(),async()=>{},{mode:'review',materials:[{path:'a.js',content:'code'}]});
  assert.equal(result.summary,'Short summary.');assert.equal(received[0].authorization,'Bearer process-fixture-key');assert.equal(received[0].body.model,'fixture');assert.ok(!JSON.stringify(requests).includes('process-fixture-key'));assert.equal(logs[0].tool_calls[0].name,'finish_review');
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

test('only super administrators change the computer spec, which is forwarded to the manager without disabling the repository', async t => {
  const calls = [], manager = { call: async (method, path, input) => { calls.push([method, path, input]);
    return path.endsWith('/configure') ? { repository_id: '101', generation: 1, state: 'ready', desired: 'ready', revision: 3 } : { repository_id: '101', generation: 1, state: 'ready', desired: 'ready', revision: 2 }; } };
  const h = await harness(t, manager), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const member = h.client(), memberPassword = randomBytes(16).toString('hex');
  await admin('/api/users', 'POST', { username: 'member', password: memberPassword, repository_ids: ['101'] });
  await member('/api/auth/login', 'POST', { username: 'member', password: memberPassword });
  const op = () => randomBytes(24).toString('hex'), spec = { memory_mb: 1024, egress: false };
  assert.equal((await member('/api/environments/101/configure', 'POST', { operation_id: op(), generation: 1, spec })).status, 403);
  assert.equal((await admin('/api/environments/101/configure', 'POST', { operation_id: op(), generation: 1, spec: 'big' })).status, 400);
  assert.equal((await admin('/api/environments/101/start', 'POST', { operation_id: op(), generation: 1, spec })).status, 400);
  assert.equal((await admin('/api/environments/101/configure', 'POST', { operation_id: op(), generation: 1, spec })).status, 201);
  const sent = calls.find(c => c[1] === '/v1/projects/101/configure');
  assert.deepEqual([sent[2].generation, sent[2].request], [1, spec]);
  assert.equal(h.store.get("SELECT enabled FROM policies WHERE repository_id='101'").enabled, 1);
});

test('a super administrator choosing a shared model grants it to the repository; a project administrator cannot', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const shared = (await admin('/api/models', 'POST', { repository_id: null, api_url: 'https://model.invalid/v1', api_key: randomBytes(12).toString('hex'), model_name: 'shared' })).value.model;
  const member = h.client(), memberPassword = randomBytes(16).toString('hex');
  await admin('/api/users', 'POST', { username: 'member', password: memberPassword, repository_ids: ['101'] });
  await member('/api/auth/login', 'POST', { username: 'member', password: memberPassword });
  assert.equal((await member('/api/repositories/101/policy', 'PATCH', { model_id: shared.id })).status, 400);
  assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { model_id: shared.id, test_command: 'npm test', max_revisions: 2 })).value.policy.model_id, shared.id);
  assert.ok(h.store.get('SELECT 1 FROM model_projects WHERE model_id=? AND repository_id=?', shared.id, '101'));
  assert.equal((await member('/api/repositories/101/policy', 'PATCH', { review_label: 'bot-reviewed' })).value.policy.review_label, 'bot-reviewed');
});

test('review rules choose the triggers, and the comment language and only the effective file text reaches the model, with language as a separate setting', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  for (const body of [{ review_issues: 'yes' }, { review_language: 'fr' }, { review_language: ['zh'] }, { review_instructions: 'x'.repeat(8001) }])
    assert.equal((await admin('/api/repositories/101/policy', 'PATCH', body)).status, 400);
  const saved = (await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, review_issues: false, review_pr_updates: false, review_language: 'zh', review_instructions: 'Focus on API compatibility.' })).value.policy;
  assert.deepEqual([saved.review_issues, saved.review_pull_requests, saved.review_pr_updates, saved.review_language], [0, 1, 0, 'zh']);
  const pr = (action, sha) => ({ repository: { id: 101 }, action, pull_request: { number: 7, draft: false, state: 'open', head: { sha } } });
  assert.equal((await h.hook(a.path, a.secret, 'issue', { repository: { id: 101 }, action: 'opened', issue: { number: 1, title: 'x', body: 'x' } })).value.tasks_created, 0);
  assert.equal((await h.hook(a.path, a.secret, 'pr-open', pr('opened', 'a'.repeat(40)), { 'X-GitHub-Event': 'pull_request' })).value.tasks_created, 1);
  assert.equal((await h.hook(a.path, a.secret, 'pr-push', pr('synchronize', 'b'.repeat(40)), { 'X-GitHub-Event': 'pull_request' })).value.tasks_created, 0);
  const prompts = [], requestTexts=[], reply = { role: 'assistant', content: null, tool_calls: [call('f', 'finish_review', { summary: 's', requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '', findings: [] })] };
  const server = createServer(async (req, res) => { let raw = ''; for await (const b of req) raw += b; requestTexts.push(raw);prompts.push(JSON.parse(raw).messages[0].content); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: reply }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: 'rules-fixture-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  let workspace = proxyWorkspace(); const rules = { language: 'zh', instructions: 'Focus on API compatibility.' };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token) VALUES('r','101','review.pr','running','pr',7,'c'),('d','101','development.issue','running','dev',1,'c')");
  await agentLoop(h.store, h.store.get("SELECT * FROM tasks WHERE id='r'"), workspace, new Redactor(), async () => {}, { mode: 'review', review_rules: rules, effective_rules:{files:[{path:'.bot/rules/pr-review.md',source:'repository',effective:'Repository review content.'}]} });
  assert.match(prompts[0], /Simplified Chinese/); assert.doesNotMatch(prompts[0], /Administrator review guidance|Focus on API compatibility/);assert.match(prompts[0],/Repository review content\./);assert.doesNotMatch(requestTexts[0],/Focus on API compatibility|Administrator review guidance/);
  reply.tool_calls = [call('g', 'finish_development', { summary: 'done', test_command: 'true' })]; workspace=proxyWorkspace();
  await agentLoop(h.store, h.store.get("SELECT * FROM tasks WHERE id='d'"), workspace, new Redactor(), async () => {}, { mode: 'development', review_rules: rules });
  assert.doesNotMatch(prompts[1], /Focus on API compatibility/);
});
