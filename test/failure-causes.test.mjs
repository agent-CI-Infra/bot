import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {GitHub} from '../dist/github/client.js';
import {Redactor,networkReason} from '../dist/agent/common.js';
import {classifiedCodes,explainFailure,failureCause} from '../dist/agent/failures.js';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';
import {loadConsole} from './console-page.mjs';

const sources=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(join(dir,entry.name)):entry.name.endsWith('.ts')?[join(dir,entry.name)]:[]);
const faults=h=>h.store.all('SELECT content FROM task_logs WHERE task_id=?',h.taskId).map(row=>JSON.parse(row.content)).filter(log=>log.type==='fault');

test('every stop code in the source has an explicit cause, and only engine-polled states continue on their own',()=>{
  const codes=new Set();
  for(const file of sources('src')){
    const text=readFileSync(file,'utf8');
    for(const match of text.matchAll(/(?:stop|new TaskError)\(\s*'([a-z0-9_]+)'\s*[,)]/g))codes.add(match[1]);
    for(const match of text.matchAll(/stop\(method === 'GET' \? '([a-z_]+)' : '([a-z_]+)'/g))codes.add(match[1]).add(match[2]);
  }
  assert.ok(codes.size>70,`found only ${codes.size} codes`);
  // Prefixes followed by a status are classified by family; everything else must be listed by name.
  const missing=[...codes].filter(code=>!classifiedCodes.has(code)&&code!=='task_runtime_failure');
  assert.deepEqual(missing,[]);
  const polled=/status IN \(([^)]*)\) AND next_run_at<=\?/.exec(readFileSync('src/agent/engine.ts','utf8'))[1].match(/'([a-z_]+)'/g).map(s=>s.slice(1,-1)).filter(s=>s!=='queued');
  for(const state of ['retry_wait','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','waiting_pr_head','needs_replan','failed'])
    assert.equal(explainFailure('github_unavailable',state).automatic,polled.includes(state),state);
});

test('causes separate outages, GitHub settings, GitHub refusals, the model, the computer and the bot itself',()=>{
  const cases=[['github_response_unknown','retry_wait','external'],['github_unavailable','retry_wait','external'],['github_rate_limited','retry_wait','external'],
    ['github_http_502','retry_wait','external'],['model_http_503','retry_wait','external'],['model_http_429','retry_wait','external'],['model_unavailable','retry_wait','external'],
    ['github_permission_403','waiting_permission','github_access'],['github_permission_404','waiting_permission','github_access'],['github_credentials_missing','waiting_configuration','github_access'],
    ['github_http_422','failed','github_rejected'],['github_http_409','failed','github_rejected'],
    ['model_http_400','failed','model'],['model_authentication_failed','waiting_configuration','model'],['model_review_invalid','failed','model'],
    ['execution_interrupted','waiting_environment','environment'],['task_runtime_failure','waiting_environment','environment'],
    ['credential_in_repository','failed','repository'],['base_branch_changed','needs_replan','task_changed'],['github_publication_unknown','waiting_publication','publication'],
    ['task_runtime_failure','failed','bot'],['tool_operation_conflict','failed','bot'],['github_tree_mismatch','failed','bot'],['a_code_from_an_older_version','failed','bot']];
  for(const [code,state,cause] of cases)assert.equal(failureCause(code,state),cause,code+' '+state);
  assert.equal(explainFailure(null),null);
  const waiting=explainFailure('github_response_unknown','retry_wait'),gaveUp=explainFailure('github_response_unknown','failed');
  assert.deepEqual([waiting.label,waiting.automatic],['外部服务或网络波动',true]);assert.match(waiting.action,/自动重试/);assert.match(gaveUp.action,/点「重试」/);
  assert.match(explainFailure('github_permission_403','waiting_permission').action,/GitHub App/);
  assert.match(explainFailure('github_publication_unknown','waiting_publication').action,/先再查一次，确实没有才重新发送/);
  assert.match(explainFailure('tool_operation_conflict','failed').action,/反馈给 bot 维护者/);
  assert.match(explainFailure('pull_request_head_changed','superseded').action,/无需处理/);
});

test('network failures say whether it was a timeout, DNS, a reset, TLS or a refused connection',async t=>{
  const failed=(code,extra={})=>Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('socket'),{code,...extra})});
  assert.equal(networkReason(Object.assign(new Error('aborted'),{name:'TimeoutError'}),30000),'30 秒内没有响应');
  assert.equal(networkReason(failed('ECONNRESET'),30000),'连接被重置（ECONNRESET）');
  assert.equal(networkReason(failed('ENOTFOUND'),30000),'域名解析失败（ENOTFOUND）');
  assert.equal(networkReason(failed('UND_ERR_CONNECT_TIMEOUT'),30000),'建立连接超时（UND_ERR_CONNECT_TIMEOUT）');
  assert.equal(networkReason(failed('CERT_HAS_EXPIRED'),30000),'TLS 证书校验失败（CERT_HAS_EXPIRED）');
  assert.equal(networkReason(Object.assign(new TypeError('fetch failed'),{cause:new Error('redirect mode is set to error')}),30000),'服务返回了重定向，已拒绝跟随');
  // A real refused connection, through the GitHub client: reads wait for retry, writes also say their result is unknown.
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const github=new GitHub(null,{},new Redactor(),async()=>{},'http://127.0.0.1:'+port);github.token='ghs_fixture';github.fullName='octo/repo';
  await assert.rejects(github.request('GET',github.path('/pulls/1')),error=>{
    assert.deepEqual([error.code,error.state,error.detail],['github_unavailable','retry_wait','GitHub 请求 GET /repos/octo/repo/pulls/1 失败：连接被拒绝（ECONNREFUSED）。']);return true;});
  await assert.rejects(github.request('POST',github.path('/pulls'),{}),error=>{
    assert.equal(error.code,'github_response_unknown');assert.match(error.detail,/连接被拒绝（ECONNREFUSED），写入结果尚未确认。$/);return true;});
});

test('a write GitHub answered with 500 pauses as unconfirmed, and 重试 sends it once GitHub still has no trace of it',async t=>{
  let fail=true;
  const h=await emptyRepositoryFixture(t,{github(path,send,res){
    if(!fail||!path.endsWith('/issues/1/comments')||res.req.method!=='POST')return false;
    fail=false;res.setHeader('X-GitHub-Request-Id','C5D4:3A2B:1');send({message:'Server Error'},500);return true;
  }});h.setBranch('ready');
  let task=await h.run();assert.deepEqual([task.status,task.error_code],['retry_wait','github_response_unknown']);
  let detail=(await h.admin('/api/tasks/'+h.taskId)).value.task;
  assert.deepEqual([detail.error_cause.cause,detail.error_cause.label,detail.error_cause.automatic,detail.retry_count],['external','外部服务或网络波动',true,1]);
  h.due();task=await h.run();assert.deepEqual([task.status,task.error_code,h.comments.length],['waiting_publication','github_publication_unknown',0]);
  detail=(await h.admin('/api/tasks/'+h.taskId)).value.task;
  assert.deepEqual([detail.error_cause.cause,detail.error_cause.automatic],['publication',false]);
  assert.match(detail.error_detail,/^GitHub 发布操作 discussion（comment）上次请求没有得到确定结果（状态=unknown），在 GitHub 上也没找到这次写入/);
  // Old and new faults are explained when read, each by the state it was written in.
  const logs=(await h.admin('/api/tasks/'+h.taskId+'/logs')).value.logs.filter(log=>log.cause);
  assert.deepEqual(logs.map(log=>log.cause.cause),['external','publication']);
  assert.equal((await h.admin('/api/tasks/'+h.taskId+'/retry','POST',{})).status,201);
  await Promise.all(h.engine.active.values());task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);
  assert.deepEqual([task.status,h.comments.length],['succeeded',1]);
  assert.equal(h.store.get("SELECT state FROM github_effects WHERE task_id=? AND kind='comment'",h.taskId).state,'sent');
});

test('a write that landed despite a 500 is found on retry and never sent twice',async t=>{
  let fail=true;
  const h=await emptyRepositoryFixture(t,{github(path,send,res,body){
    if(!fail||!path.endsWith('/issues/1/comments')||res.req.method!=='POST')return false;
    // Store the comment the way the default route would, then answer 500.
    fail=false;h.comments.push({id:1,body:body.body,user:{id:999},html_url:'https://github.invalid/comment/1'});send({message:'Server Error'},500);return true;
  }});h.setBranch('ready');
  assert.equal((await h.run()).status,'retry_wait');
  h.due();const task=await h.run();assert.deepEqual([task.status,h.comments.length],['succeeded',1]);
});

test('the retry that gives up is logged as its own 失败 entry with the next step',async t=>{
  const h=await emptyRepositoryFixture(t,{github(path,send){if(path!=='/user')return false;send({message:'Server Error'},502);return true;}});
  for(let attempt=1;attempt<=5;attempt++){h.due();await h.run();}
  const task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);assert.deepEqual([task.status,task.error_code,task.retry_count],['failed','github_http_502',5]);
  assert.deepEqual(faults(h).map(log=>log.state),['retry_wait','failed']);
  assert.equal(faults(h)[1].detail,'GitHub 请求 GET /user 返回 HTTP 502：Server Error');
  const detail=(await h.admin('/api/tasks/'+h.taskId)).value.task;assert.equal(detail.error_cause.cause,'external');assert.match(detail.error_cause.action,/已自动重试多次仍失败/);
});

test('model failures name the model, its host and the provider explanation without the key',async t=>{
  let reply;const model=createServer(async(req,res)=>{for await(const _ of req);res.writeHead(reply.status,{'Content-Type':'application/json'});res.end(JSON.stringify(reply.body));});
  model.listen(0,'127.0.0.1');await once(model,'listening');t.after(()=>new Promise(resolve=>model.close(resolve)));
  const host='127.0.0.1:'+model.address().port;
  const h=await emptyRepositoryFixture(t,{execute(request){
    if(request.type==='workspace_agent_poll')return {ok:true,result:{state:'running',request:{id:'model-1',body:{messages:[{role:'user',content:'Review this.'}]}}}};
  }});h.setBranch('ready');h.store.run('UPDATE models SET api_url=?','http://'+host+'/v1');
  reply={status:400,body:{error:{message:"This model's maximum context length is 8192 tokens; key fixture-key was rejected"}}};
  let task=await h.run();assert.deepEqual([task.status,task.error_code],['failed','model_http_400']);
  assert.equal(faults(h).at(-1).detail,`模型 fixture-model（${host}）返回 HTTP 400：This model's maximum context length is 8192 tokens; key [REDACTED] was rejected`);
  reply={status:401,body:{error:'invalid api key'}};h.store.run("UPDATE tasks SET status='queued',next_run_at=0,phase='prepare' WHERE id=?",h.taskId);
  task=await h.run();assert.deepEqual([task.status,task.error_code],['waiting_configuration','model_authentication_failed']);
  assert.equal(faults(h).at(-1).detail,`模型 fixture-model（${host}）拒绝认证或访问，HTTP 401：invalid api key。请检查模型 API Key 和权限。`);
});

test('a needs_replan retry starts over only while nothing was written to GitHub',async t=>{
  const h=await emptyRepositoryFixture(t);
  const retry=async()=>{
    // Hold the repository's only slot so the retried task stays queued and its reset can be read.
    h.store.run("INSERT OR REPLACE INTO tasks(id,repository_id,kind,status,summary) VALUES('busy','101','review.issue','queued','busy')");
    const run=h.engine.run.bind(h.engine);let release;h.engine.run=async(id,token)=>id==='busy'?new Promise(resolve=>{release=resolve;}):run(id,token);
    h.engine.tick();
    try{assert.equal((await h.admin('/api/tasks/'+h.taskId+'/retry','POST',{})).status,201);return h.store.get('SELECT phase,attempt,status FROM tasks WHERE id=?',h.taskId);}
    finally{release();await Promise.all(h.engine.active.values());h.engine.run=run;h.store.run("DELETE FROM tasks WHERE id='busy'");}
  };
  h.store.run("UPDATE tasks SET status='needs_replan',phase='publish',error_code='base_branch_changed',next_run_at=9999999999999 WHERE id=?",h.taskId);
  assert.deepEqual({...await retry()},{phase:'prepare',attempt:2,status:'queued'});
  h.store.run("UPDATE tasks SET status='needs_replan',phase='publish',error_code='development_not_approved',next_run_at=9999999999999 WHERE id=?",h.taskId);
  h.store.run("INSERT INTO github_effects VALUES('pushed',?,'branch','{}','sent','{}','marker')",h.taskId);
  assert.deepEqual({...await retry()},{phase:'publish',attempt:2,status:'queued'});
});

test('the console names the cause and the next step in the timeline, the live line and the task facts',()=>{
  const page=loadConsole(['static/app.js','static/views.js'],()=>[404,{}]);
  const cause={cause:'external',label:'外部服务或网络波动',action:'不是配置问题，bot 会自动重试，一般无需处理。',automatic:true};
  const text=code=>page.run(`(() => { const visible=node=>[node.textContent,...node.children.map(visible)].filter(Boolean).join('\\n'); return visible(${code}); })()`);
  const fault=JSON.stringify({type:'fault',state:'retry_wait',code:'github_response_unknown',detail:'GitHub 请求 POST /repos/o/r/pulls 返回 HTTP 500，写入结果尚未确认：Server Error'});
  const shown=text(`step({id:'1',created_at:'2026-10-27T16:37:20Z',content:${JSON.stringify(fault)},cause:${JSON.stringify(cause)}})`);
  for(const part of ['暂停或失败 · 外部服务或网络波动','等待重试','HTTP 500，写入结果尚未确认：Server Error','处理：不是配置问题，bot 会自动重试','错误码 github_response_unknown'])assert.ok(shown.includes(part),part+'\n'+shown);
  // A log read from an older server has no cause and keeps the previous rendering.
  assert.match(text(`step({id:'2',content:${JSON.stringify(fault)}})`),/任务暂停或失败[\s\S]*github_response_unknown/);
  const task={id:'t',kind:'development.issue',object_number:1,status:'retry_wait',phase:'publish',error_code:'github_response_unknown',error_cause:cause,retry_count:2};
  assert.equal(page.run(`liveText(${JSON.stringify(task)})`),'已暂停：等待重试 · 外部服务或网络波动（github_response_unknown）。已连续失败 2 次，满 5 次转为失败。不是配置问题，bot 会自动重试，一般无需处理。');
  const replan={...task,status:'needs_replan',error_code:'base_branch_changed',error_cause:{cause:'task_changed',label:'任务条件已变化',action:'点「重试」会基于最新的基础分支重新规划。'}};
  assert.equal(page.run(`liveText(${JSON.stringify(replan)})`),'已暂停：需重新规划 · 任务条件已变化（base_branch_changed）。点「重试」会基于最新的基础分支重新规划。');
  assert.equal(page.run(`faultSummary('github_permission_403',{label:'GitHub 权限或配置'})`),'GitHub 权限或配置（github_permission_403）');
});
