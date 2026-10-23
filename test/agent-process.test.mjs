import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { harness, setup, account, repository } from './helpers.mjs';
import { agentLoop } from '../dist/agent/loop.js';
import { Workspace } from '../dist/agent/workspace.js';
import { resolveRules } from '../dist/rules/service.js';
import { Redactor } from '../dist/agent/common.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { Publisher } from '../dist/github/publisher.js';
import { server as githubFixture } from './fixtures/agent-server.mjs';
import { agentOperation, waitingAgent } from '../runner/agent.mjs';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function proxyWorkspace(logs=[]) {
  let configBytes=[],config,replyBytes=[],replied=false,publication;
  return {log:value=>logs.push(value),call:async(_key,request)=>{
    if(request.type==='workspace_agent_config'){configBytes.push(Buffer.from(request.base64,'base64'));if(request.final)config=JSON.parse(Buffer.concat(configBytes));return {written:true};}
    if(request.type==='workspace_agent_start')return {started:true};
    if(request.type==='workspace_agent_reply'){replyBytes.push(Buffer.from(request.base64,'base64'));if(request.final)replied=true;return {written:true};}
    if(request.type==='workspace_agent_pull_request'){if(request.final)publication=true;return {written:true};}
    if(request.type==='workspace_agent_poll'){
      if(!replied)return {state:'running',request:{id:'a'.repeat(48),body:{stream:true,messages:[{role:'system',content:config.system},{role:'user',content:config.prompt}]}},events:[],offset:0};
      const reply=JSON.parse(Buffer.concat(replyBytes)),chunk=JSON.parse(reply.body.split('\n')[0].slice(6)),call=chunk.choices[0].delta.tool_calls[0];
      if(call.function.name==='create_pull_request'&&!publication)return {state:'running',pull_request:{id:'b'.repeat(48),arguments:JSON.parse(call.function.arguments)}};
      return {state:'completed',result:JSON.parse(call.function.arguments),events:[{type:'model',content:'Pi finished',tool_calls:[{name:call.function.name}]}],offset:1};
    }
    throw new Error('unexpected runner request');
  }};
}
test('the control plane relays Pi model requests with the configured model and keeps its key out of the runner', async t => {
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const received=[],finish={summary:'Short summary.',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
  const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;received.push({authorization:req.headers.authorization,body:JSON.parse(raw)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage:{prompt_tokens:1000,completion_tokens:200,prompt_tokens_details:{cached_tokens:750}},choices:[{message:{role:'assistant',content:null,tool_calls:[call('f','finish_review',finish)]}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'process-fixture-key',model_name:'fixture',pricing:{currency:'USD',input_per_million:2,output_per_million:10,cache_per_million:0.2}})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id,review_enabled:true});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token) VALUES('process','101','review.pr','running','pr',4,'claim')");
  const logs=[],workspace=proxyWorkspace(logs),requests=[],original=workspace.call;workspace.call=async(...args)=>{requests.push(args[1]);return original(...args);};
  const result=await agentLoop(h.store,h.store.get("SELECT * FROM tasks WHERE id='process'"),workspace,new Redactor(),async()=>{},{mode:'review',materials:[{path:'a.js',content:'code'}]});
  assert.equal(result.summary,'Short summary.');assert.equal(received[0].authorization,'Bearer process-fixture-key');assert.equal(received[0].body.model,'fixture');assert.ok(!JSON.stringify(requests).includes('process-fixture-key'));assert.equal(logs[0].tool_calls[0].name,'finish_review');
  const usage=h.store.get('SELECT * FROM model_requests');assert.equal(usage.task_id,'process');assert.equal(usage.state,'received');assert.equal(usage.input_tokens,1000);assert.equal(usage.cached_input_tokens,750);assert.equal(usage.cost,0.00265);
});

test('a task may make any number of model requests, and a request still visible after its reply is not sent twice', async t => {
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const finish={summary:'Done after many steps.',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
  let received=0;const server=createServer(async(req,res)=>{for await(const _ of req);received++;res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[call('c'+received,'finish_review',finish)]}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'budget-fixture-key',model_name:'fixture'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token) VALUES('many','101','review.pr','running','pr',4,'claim')");
  // 40 model requests, more than the former limit of 32. After every tenth reply the same request is still visible once, as can happen in the container.
  let step=0,stale=false;const total=40,request=n=>({id:String(n).padStart(48,'0'),body:{messages:[{role:'user',content:'step '+n}]}});
  const workspace={log:()=>{},call:async(_key,input)=>{
    if(input.type==='workspace_agent_poll'){
      if(stale){stale=false;return {state:'running',request:request(step),events:[],offset:0};}
      return step<total?{state:'running',request:request(++step),events:[],offset:0}:{state:'completed',result:finish,events:[],offset:0};
    }
    if(input.type==='workspace_agent_reply'){stale=step%10===0;return {written:true};}
    return {written:true,started:true};
  }};
  const started=Date.now(),result=await agentLoop(h.store,h.store.get("SELECT * FROM tasks WHERE id='many'"),workspace,new Redactor(),async()=>{},{mode:'review'});
  assert.equal(result.summary,'Done after many steps.');assert.equal(received,total);
  assert.equal(h.store.get('SELECT count(*) n FROM model_requests').n,total,'stale polls do not create extra usage entries');
  // Answered requests are followed by an immediate poll, so 40 steps do not wait 40 polling intervals.
  assert.ok(Date.now()-started<total*500,'polls right after a reply');
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
  assert.equal((await member('/api/repositories/101/policy', 'PATCH', { review_pr_updates: false })).value.policy.review_pr_updates, 0);
});

test('review rules choose the triggers, and the comment language and only the effective file text reaches the model, with language as a separate setting', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  // Review guidance and the label are rule files now, so the policy no longer accepts them.
  for (const body of [{ review_issues: 'yes' }, { review_language: 'fr' }, { review_language: ['zh'] }, { review_instructions: 'x' }, { review_label: 'x' }])
    assert.equal((await admin('/api/repositories/101/policy', 'PATCH', body)).status, 400);
  const saved = (await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, review_issues: false, review_pr_updates: false, review_language: 'zh' })).value.policy;
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
  reply.tool_calls = [call('g', 'create_pull_request', { summary: 'done', test_command: 'true' })]; workspace=proxyWorkspace();
  await agentLoop(h.store, h.store.get("SELECT * FROM tasks WHERE id='d'"), workspace, new Redactor(), async () => {}, { mode: 'development', review_rules: rules }, undefined, async()=>({status:'no_changes'}));
  assert.doesNotMatch(prompts[1], /Focus on API compatibility/);
  // With no console layer or repository file, the system prompt carries each docs/prompts file in full.
  workspace=proxyWorkspace();
  await agentLoop(h.store, h.store.get("SELECT * FROM tasks WHERE id='d'"), workspace, new Redactor(), async () => {}, { mode: 'development', effective_rules: resolveRules({}, {}) }, undefined, async()=>({status:'no_changes'}));
  for (const name of ['labels.md', 'issue-review.md', 'pr-review.md', 'issue-development.md'])
    assert.ok(prompts[2].includes(`## .bot/rules/${name} (builtin)\n` + readFileSync(new URL('../docs/prompts/' + name, import.meta.url), 'utf8')), name);
});

test('the agent exchanges a read-only GitHub token that is not stored, never reaches the provider and is revoked at the end', async t => {
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const finish={summary:'Read the checks.',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]},bodies=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;bodies.push(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[call('f','finish_review',finish)]}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'token-fixture-key',model_name:'fixture'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token,generation,workspace_id) VALUES('tok','101','review.pr','running','pr',4,'claim',1,?),('none','101','review.pr','running','pr',5,'claim',1,?)",'d'.repeat(48),'e'.repeat(48));
  const token='ghs_'+randomBytes(18).toString('hex');
  // The manager plays the runner: the agent asks for a token, then a command echoes it into the next model request.
  const runner=()=>{const delivered=[];let phase='token';return {delivered,manager:{call:async(_method,_path,input)=>{const r=input.request;
    if(r.type==='workspace_agent_token'){delivered.push(JSON.parse(Buffer.from(r.base64,'base64')));phase='model';return {ok:true,result:{written:true}};}
    if(r.type==='workspace_agent_poll'){
      if(phase==='token')return {ok:true,result:{state:'running',token_request:{id:'b'.repeat(48)},events:[],offset:0}};
      if(phase==='model')return {ok:true,result:{state:'running',request:{id:'c'.repeat(48),body:{messages:[{role:'tool',content:'GH_TOKEN='+token}]}},events:[],offset:0}};
      return {ok:true,result:{state:'completed',result:finish,events:[],offset:0}};
    }
    if(r.type==='workspace_agent_reply')phase='done';
    return {ok:true,result:{written:true,started:true}};
  }}};};
  const redactor=new Redactor(),logs=[];let revoked=0;
  const tokens={issue:async()=>{redactor.add(token);return {token,expires_at:'2099-01-01T00:00:00Z',permissions:{contents:'read',actions:'read'},repository:'fixture/project-101'};},revoke:async()=>{revoked++;}};
  let task=h.store.get("SELECT * FROM tasks WHERE id='tok'"),fake=runner();
  const result=await agentLoop(h.store,task,new Workspace(h.store,fake.manager,task,redactor,async()=>{},value=>logs.push(value)),redactor,async()=>{},{mode:'review'},tokens);
  assert.equal(result.summary,'Read the checks.');assert.equal(fake.delivered[0].token,token);assert.equal(revoked,1);
  assert.ok(!JSON.stringify(h.store.all('SELECT * FROM task_tools')).includes('workspace_agent_token'),'the delivery is not recorded');
  assert.ok(!bodies[0].includes(token)&&bodies[0].includes('[REDACTED]'),'the provider never sees the token');
  assert.ok(!JSON.stringify(logs).includes(token));assert.deepEqual(logs.find(l=>l.type==='github_read_token').permissions,{contents:'read',actions:'read'});
  // Without a token issuer the agent gets the reason and the task carries on.
  task=h.store.get("SELECT * FROM tasks WHERE id='none'");fake=runner();
  await agentLoop(h.store,task,new Workspace(h.store,fake.manager,task,new Redactor(),async()=>{},()=>{}),new Redactor(),async()=>{},{mode:'review'});
  assert.deepEqual(fake.delivered,[{error:'github_read_token_unavailable'}]);
});

// Run the control-plane publication path against real Git objects and a local GitHub fixture.
// The manager substitutes for the project computer; no deployment or external API is used.
async function developmentHarness(t, { policy = '', change = true, validationResult, repair = true } = {}) {
  githubFixture.listen(0, '127.0.0.1'); await once(githubFixture, 'listening');
  t.after(() => new Promise(resolve => { githubFixture.close(resolve); githubFixture.closeAllConnections(); }));
  const endpoint = 'http://127.0.0.1:' + githubFixture.address().port;
  let repoDirectory, step = 0, started = false, terminal, bytes = [], snapshots = 0, revision = 0;
  const replies = [], commands = [], requests = [], ids = [], manifests = [];
  const gitBytes = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (...args) => gitBytes(...args).toString().trim();
  const write = (path, content) => { mkdirSync(dirname(join(repoDirectory, path)), { recursive: true }); writeFileSync(join(repoDirectory, path), content); };
  const args = { summary: 'Fix requested addition', change_title: 'Fix requested addition', test_command: 'agent-already-ran-tests' };
  const manager = { call: async (_method, path, input) => {
    if (!path.endsWith('/execute')) return { state: 'ready', generation: 1, computer: resolveRules({}, {}).computer };
    const r = input.request; requests.push(r); let value = {};
    if (r.type === 'workspace_init') git('init', '--initial-branch=bot-local');
    else if (r.type === 'workspace_write') write(r.path, Buffer.from(r.base64, 'base64'));
    else if (r.type === 'workspace_snapshot') { git('add', '--all'); value = { tree_sha: git('write-tree') }; }
    else if (r.type === 'workspace_agent_config' || r.type === 'workspace_agent_start') value = { written: true, started: true };
    else if (r.type === 'workspace_agent_poll') {
      if (terminal) value = { state: 'completed', result: { ...args, ...terminal } };
      else {
        if (!started) { started = true; if (change) write('calc.mjs', revision ? 'export const add = (a, b) => Number(a) + Number(b);\n' : 'export const add = (a, b) => a + b;\n'); }
        ids[step] ||= randomBytes(24).toString('hex');
        value = { state: 'running', pull_request: { id: ids[step], arguments: args } };
      }
    } else if (r.type === 'workspace_finalize') {
      snapshots++; git('add', '--all'); const tree_sha = git('write-tree');
      const files = git('ls-tree', '-r', tree_sha).split('\n').filter(Boolean).map(line => {
        const [metadata, path] = line.split('\t'), [mode, , sha] = metadata.split(' ');
        return { path, mode, sha, size: Number(git('cat-file', '-s', sha)) };
      });
      manifests.push(files); value = { tree_sha, local_sha: tree_sha, files };
    } else if (r.type === 'workspace_blob') value = { base64: gitBytes('cat-file', 'blob', r.sha).subarray(r.offset, r.offset + 30000).toString('base64') };
    else if (r.type === 'workspace_command') {
      commands.push(r.command);
      try { value = { exit_code: 0, output: execFileSync('/bin/sh', ['-c', r.command], { cwd: repoDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), timed_out: false, truncated: false }; }
      catch (error) { value = { exit_code: error.status, output: String(error.stdout) + String(error.stderr), timed_out: false, truncated: false }; }
      if (validationResult) value = { ...value, ...validationResult };
    } else if (r.type === 'workspace_agent_pull_request') {
      bytes.push(Buffer.from(r.base64, 'base64'));
      if (r.final) {
        const reply = JSON.parse(Buffer.concat(bytes)); bytes = []; replies.push(reply);
        if (reply.error === 'validation_failed') {
          assert.equal(h.store.get('SELECT count(*) n FROM development_candidates').n, 0);
          assert.equal(h.store.get('SELECT count(*) n FROM github_effects').n, 0);
        }
        if (reply.pr || reply.status === 'no_changes') terminal = reply;
        else if (repair) { assert.equal(reply.error, 'validation_failed'); write('ready', 'fixed\n'); write('calc.mjs', 'export const add = (a, b) => Number(a) + Number(b);\n'); step++; }
        else value = { error: 'fixture_stopped_after_reply' };
      }
    } else if (r.type !== 'reap') throw new Error('Unexpected fixture operation ' + r.type);
    return { ok: true, result: value };
  } };
  const h = await harness(t, manager), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  repoDirectory = join(h.directory, 'repo'); mkdirSync(repoDirectory);
  await fetch(endpoint + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: a.token }) });
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'publication-fixture-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id, development_enabled: true, test_command: policy });
  const taskId = randomBytes(24).toString('hex'), input = { review: { implementation_goal: 'Fix requested addition' } };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token,input,created_at) VALUES(?,'101','development.issue','running','dev',1,'claim',?,?)", taskId, JSON.stringify(input), new Date().toISOString());
  h.store.run("INSERT INTO task_locks(repository_id,task_id,token) VALUES('101',?,'claim')", taskId);
  const engine = new TaskEngine(h.store, manager, endpoint + '/github');
  await engine.run(taskId, 'claim');
  const task = h.store.get('SELECT * FROM tasks WHERE id=?', taskId), saved = h.store.get('SELECT data FROM development_candidates WHERE task_id=?', taskId);
  const continueIssue = async () => {
    revision++; repoDirectory = join(h.directory, 'revision-' + revision); mkdirSync(repoDirectory);
    started = false; terminal = undefined; step = 0; ids.length = 0;
    const nextId = randomBytes(24).toString('hex');
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token,input,created_at) VALUES(?,'101','development.issue','running','dev',1,'claim',?,?)", nextId, JSON.stringify(input), new Date().toISOString());
    h.store.run("UPDATE task_locks SET task_id=? WHERE repository_id='101'", nextId);
    await engine.run(nextId, 'claim');
    return { task: h.store.get('SELECT * FROM tasks WHERE id=?', nextId), candidate: JSON.parse(h.store.get('SELECT data FROM development_candidates WHERE task_id=?', nextId)?.data || 'null') };
  };
  return { h, task, candidate: saved && JSON.parse(saved.data), replies, commands, requests, snapshots, manifests, repoDirectory, endpoint, engine, git, continueIssue };
}

test('create_pull_request with empty policy never reruns agent evidence and returns the published call-time tree', async t => {
  const d = await developmentHarness(t);
  assert.equal(d.task.status, 'pr_opened', JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.deepEqual(d.commands, []); assert.equal(d.snapshots, 1);
  assert.equal(d.candidate.test_command, 'agent-already-ran-tests');
  assert.deepEqual(d.replies, [{ pr: { number: JSON.parse(d.task.result).pr_number, html_url: JSON.parse(d.task.result).pr_url, sha: d.candidate.remote_sha } }]);
  assert.equal(d.candidate.tree_sha, JSON.parse(d.task.result).tree_sha);
  const state = await fetch(d.endpoint + '/fixture/state').then(r => r.json());
  assert.match(state.prs.at(-1).body, /Tests: agent-already-ran-tests/);
  assert.match(state.prs.at(-1).body, /not rerun by the control plane/); assert.doesNotMatch(state.prs.at(-1).body, /Exit code:/);
});

test('a later call for the same Issue appends to the same bot branch and PR', async t => {
  const d = await developmentHarness(t), first = JSON.parse(d.task.result), next = await d.continueIssue();
  assert.equal(next.task.status, 'completed', JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  const result = JSON.parse(next.task.result);
  assert.equal(result.pr_number, first.pr_number); assert.equal(result.branch, first.branch); assert.notEqual(result.sha, first.sha);
  assert.equal(next.candidate.base_sha, first.sha); assert.equal(next.candidate.expected_sha, first.sha);
  assert.equal(d.h.store.get('SELECT count(*) n FROM bot_pull_requests').n, 1);
  assert.equal(d.h.store.get('SELECT count(*) n FROM bot_branches').n, 1);
  const state = await fetch(d.endpoint + '/fixture/state').then(r => r.json()), writes = state.refWrites.filter(w => w.branch === first.branch);
  assert.deepEqual(writes.map(w => w.method), ['POST', 'PATCH']); assert.equal(writes[1].force, false);
});

test('policy-generated untracked files and tracked edits stay outside the published snapshot', async t => {
  const policy = `node -e "const fs=require('node:fs');fs.mkdirSync('__pycache__');fs.writeFileSync('__pycache__/test.pyc','generated');fs.writeFileSync('calc.mjs','changed by policy');console.log('OK')"`;
  const d = await developmentHarness(t, { policy });
  assert.equal(d.task.status, 'pr_opened'); assert.deepEqual(d.commands, [policy]); assert.equal(d.snapshots, 1);
  assert.ok(existsSync(join(d.repoDirectory, '__pycache__/test.pyc')));
  assert.ok(!d.candidate.files.some(f => f.path.startsWith('__pycache__/')));
  assert.match(Buffer.from(d.candidate.files.find(f => f.path === 'calc.mjs').base64, 'base64').toString(), /a \+ b/);
  assert.equal(readFileSync(join(d.repoDirectory, 'calc.mjs'), 'utf8'), 'changed by policy');
});

test('policy failure returns output without publication and the same agent can repair and call again', async t => {
  const policy = `node -e "if(!require('node:fs').existsSync('ready')){console.log('not ready');process.exit(1)}console.log('OK')"`;
  const d = await developmentHarness(t, { policy });
  assert.equal(d.task.status, 'pr_opened'); assert.equal(d.snapshots, 2); assert.equal(d.commands.length, 2);
  assert.equal(d.replies[0].error, 'validation_failed'); assert.equal(d.replies[0].exit_code, 1); assert.match(d.replies[0].output, /not ready/);
  assert.ok(d.replies[1].pr); assert.ok(d.candidate.files.some(f => f.path === 'ready'));
  assert.equal(d.h.store.get("SELECT count(*) n FROM github_effects WHERE kind='branch'").n, 1);
});

for (const failure of [{ exit_code: 1 }, { timed_out: true }, { truncated: true }]) test('invalid policy result blocks publication: ' + JSON.stringify(failure), async t => {
  const d = await developmentHarness(t, { policy: 'true', validationResult: failure, repair: false });
  assert.equal(d.replies[0].error, 'validation_failed'); assert.equal(d.candidate, undefined);
  assert.equal(d.h.store.get('SELECT count(*) n FROM github_effects').n, 0);
  assert.ok(!d.replies.some(reply => reply.pr));
});

test('an unchanged workspace ends development normally without tests, a candidate or a PR', async t => {
  const d = await developmentHarness(t, { change: false, policy: 'exit 99' });
  assert.equal(d.task.status, 'completed'); assert.equal(d.task.error_code, null); assert.equal(d.snapshots, 1);
  assert.equal(d.replies[0].status, 'no_changes'); assert.deepEqual(d.commands, []); assert.equal(d.candidate, undefined);
  assert.equal(d.h.store.get('SELECT count(*) n FROM github_effects').n, 0);
});

test('publication still rejects a registered branch outside bot/issue-', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('owner','101','development.issue','running','dev',1)");
  h.store.run("INSERT INTO bot_branches VALUES('101','contributor','owner')");
  const publisher = new Publisher(h.store, { defaultBranch: 'main' }, h.store.get("SELECT * FROM tasks WHERE id='owner'"), async () => assert.fail('must reject before network access'));
  await assert.rejects(publisher.branch({ branch: 'contributor', owner_task_id: 'owner' }), error => error.code === 'branch_not_owned');
});

test('the runner mailbox waits for publication replies and preserves only the exact waiting Pi process', async t => {
  const h = await harness(t), root = join(h.directory, 'workspace'), dir = join(root, 'agent'); mkdirSync(dir, { recursive: true });
  const id = 'a'.repeat(48), args = { summary: 'Ready', test_command: 'true' };
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ state: 'running', pid: 123 }));
  writeFileSync(join(dir, 'pr-request.json'), JSON.stringify({ id, arguments: args }));
  const value = { pr: { number: 70, html_url: 'https://github.invalid/pull/70', sha: 'b'.repeat(40) } }, reply = Buffer.from(JSON.stringify(value));
  const pending = await agentOperation({ type: 'workspace_agent_poll' }, root);
  assert.deepEqual(pending.pull_request, { id, arguments: args });
  assert.ok(!existsSync(join(dir, 'pr-reply-' + id + '.json')));
  for (let offset = 0; offset < reply.length; offset += 20) await agentOperation({ type: 'workspace_agent_pull_request', request_id: id, base64: reply.subarray(offset, offset + 20).toString('base64'), offset, final: offset + 20 >= reply.length }, root);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pr-reply-' + id + '.json'))), value);
  const processes = [{ pid: 123, cmdline: 'node /opt/runner/pi-entry.mjs ' + root }, { pid: 124, cmdline: 'test child' }];
  assert.equal(await waitingAgent(root, processes), 123);
  assert.equal(await waitingAgent(root, [{ pid: 123, cmdline: 'another process' }]), null);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ state: 'completed', pid: 123 }));
  assert.equal(await waitingAgent(root, processes), null);
});
