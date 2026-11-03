import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {GitHub} from '../dist/github/client.js';
import {Redactor,blobSha} from '../dist/agent/common.js';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';

// Let tick claim a different task normally, then hold its execution to exercise the concurrency gate.
async function withBusyComputer(h,check){
  const run=h.engine.run.bind(h.engine);let release;
  const held=new Promise(resolve=>{release=resolve;});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('other-task','101','review.issue','queued','other task')");
  h.engine.run=async(id,token)=>{
    if(id!=='other-task')return run(id,token);
    await held;h.store.run("UPDATE tasks SET status='succeeded' WHERE id=?",id);
  };
  h.engine.tick();const work=h.engine.active.get('other-task');
  try{assert.ok(work);await check();}finally{release();await work;h.engine.run=run;}
}

test('GitHub distinguishes rate limits from permissions and retains only a short, redacted message',async t=>{
  let reply;const token='ghs_fixture_secret_token',otherToken='github_pat_other_secret',redactor=new Redactor();redactor.add('fixture-model-key');
  const server=createServer((_req,res)=>{res.writeHead(reply.status,{'Content-Type':'application/json',...reply.headers});res.end(JSON.stringify(reply.body));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const github=new GitHub(null,{},redactor,async()=>{},'http://127.0.0.1:'+server.address().port);github.token=token;
  const cases=[
    // Without a time from GitHub there is no delay here: the engine backs off on its own (a minute, then doubling).
    {status:403,body:{message:'You have exceeded a secondary rate limit.'},code:'github_rate_limited'},
    {status:403,body:{message:'API rate limit exceeded'},headers:{'Retry-After':'90'},code:'github_rate_limited',delay:90000},
    {status:403,body:{message:'Forbidden'},headers:{'X-RateLimit-Remaining':'0'},code:'github_rate_limited'},
    {status:403,body:{message:'You have triggered an abuse detection mechanism.'},headers:{'Retry-After':'900'},code:'github_rate_limited',delay:900000},
    // GitHub's own wait is honored however long it is; an unreadable one counts as none.
    {status:429,body:{message:'Rate limit exceeded'},headers:{'Retry-After':'901'},code:'github_rate_limited',delay:901000},
    {status:429,body:{message:'Slow down'},headers:{'Retry-After':'invalid'},code:'github_rate_limited'},
    {status:403,body:{message:'Resource not accessible by integration'},code:'github_permission_403'},
    {status:401,body:{message:'Bad credentials'},code:'github_permission_401'},
    {status:404,body:{message:'Not Found'},code:'github_permission_404'},
  ];
  for(const item of cases){reply=item;await assert.rejects(github.snapshotBlob('a'.repeat(40)),error=>{
    assert.equal(error.code,item.code);assert.equal(error.state,item.code==='github_rate_limited'?'retry_wait':'waiting_permission');assert.ok(error.detail.includes(item.body.message));assert.equal(error.retryAfterMs,item.delay);return true;
  });}
  reply={status:403,body:{message:`Resource not accessible by integration ${token} ${otherToken} fixture-model-key\nAuthorization: Bearer unexpected-secret`,extra:'whole-response-must-not-be-logged'}};
  await assert.rejects(github.snapshotBlob('a'.repeat(40)),error=>{
    assert.ok(error.detail.includes('Resource not accessible by integration'));
    for(const secret of [token,otherToken,'fixture-model-key','Authorization','unexpected-secret','whole-response-must-not-be-logged'])assert.ok(!error.detail.includes(secret),secret);
    // The request line is ours; only GitHub's message is capped.
    const prefix=`GitHub 请求 GET /repos//git/blobs/${'a'.repeat(40)} 返回 HTTP 403：`;
    assert.ok(error.detail.startsWith(prefix));assert.ok(error.detail.length-prefix.length<=320);return true;
  });
  reply={status:403,body:{message:'Blob is too large',errors:[{code:'too_large'}],size:110*1024*1024}};
  assert.deepEqual(await github.snapshotBlob('a'.repeat(40)),{skipped:true,status:403,size:110*1024*1024,message:'Blob is too large'});
});

test('GitHub server errors name the request, status and GitHub request ID',async t=>{
  let reply;const server=createServer((_req,res)=>{res.writeHead(reply.status,{'Content-Type':reply.type||'application/json',...reply.headers});res.end(reply.raw??JSON.stringify(reply.body));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const github=new GitHub(null,{},new Redactor(),async()=>{},'http://127.0.0.1:'+server.address().port);github.token='ghs_fixture';github.fullName='octo/repo';
  const id='C5D4:3A2B:1234567:2345678:65F0A1B2',cases=[
    {method:'POST',status:500,body:{message:'Server Error'},headers:{'X-GitHub-Request-Id':id},code:'github_response_unknown',
      detail:`GitHub 请求 POST /repos/octo/repo/issues/12/comments 返回 HTTP 500，写入结果尚未确认：Server Error（GitHub 请求 ID：${id}）`},
    // An HTML gateway page has no message, and a request ID that is not GitHub's format is dropped.
    {method:'GET',status:502,raw:'<html>Bad Gateway</html>',type:'text/html',headers:{'X-GitHub-Request-Id':'not an id'},code:'github_http_502',
      detail:'GitHub 请求 GET /repos/octo/repo/issues/12/comments 返回 HTTP 502'},
    {method:'POST',status:422,body:{message:'Validation Failed'},headers:{'X-GitHub-Request-Id':id},code:'github_http_422',state:'failed',
      detail:'GitHub 请求 POST /repos/octo/repo/issues/12/comments 返回 HTTP 422：Validation Failed'},
  ];
  for(const item of cases){reply=item;await assert.rejects(github.request(item.method,github.path('/issues/12/comments'),item.method==='POST'?{body:'x'}:undefined),error=>{
    assert.deepEqual([error.code,error.state,error.detail],[item.code,item.state||'retry_wait',item.detail]);return true;
  });}
});

test('a review comment that GitHub answers with a server error waits for retry and logs the request',async t=>{
  const h=await emptyRepositoryFixture(t,{github(path,send,res){
    if(!path.endsWith('/issues/1/comments')||res.req.method!=='POST')return false;
    res.setHeader('X-GitHub-Request-Id','C5D4:3A2B:1');send({message:'Server Error'},500);return true;
  }});h.setBranch('ready');
  const task=await h.run();assert.equal(task.status,'retry_wait');assert.equal(task.error_code,'github_response_unknown');
  const detail=(await h.admin('/api/tasks/'+h.taskId)).value.task.error_detail;
  assert.equal(detail,'GitHub 请求 POST /repos/fixture/project-101/issues/1/comments 返回 HTTP 500，写入结果尚未确认：Server Error（GitHub 请求 ID：C5D4:3A2B:1）');
  assert.equal(h.store.get("SELECT state FROM github_effects WHERE task_id=? AND kind='comment'",h.taskId).state,'unknown');
});

test('rate limits are waited out without using up retries, as long as GitHub asks, and nothing is sent before the pause ends',async t=>{
  let retryAfter,blobReads=0;const data=Buffer.from('test'),file={path:'file.txt',type:'blob',mode:'100644',sha:blobSha(data),size:data.length};
  const h=await emptyRepositoryFixture(t,{files:[file],github(path,send,res){
    if(!path.includes('/git/blobs/'))return false;
    blobReads++;if(retryAfter)res.setHeader('Retry-After',retryAfter);
    send({message:'You have exceeded a secondary rate limit.'},403);return true;
  }});h.setBranch('ready');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,error_code,summary) VALUES('old-pause','101','review.issue','waiting_permission','github_permission_403','old')");
  // The pause GitHub asked for has passed (the test does not wait for it).
  const elapse=()=>h.store.run('UPDATE github_rate_limits SET limited_until=NULL');
  const attempt=async(least,most)=>{
    h.due();const before=Date.now(),task=await h.run(),after=Date.now();
    assert.deepEqual([task.status,task.error_code,task.retry_count],['retry_wait','github_rate_limited',0]);
    assert.ok(task.next_run_at>=before+least&&task.next_run_at<=after+most,String(task.next_run_at-before));
    return (await h.admin('/api/tasks/'+h.taskId)).value.task.error_detail;
  };
  assert.match(await attempt(60000,65000),/secondary rate limit/);
  // Retried early (as after a restart), nothing is sent: the task waits out the rest of the pause.
  const reads=blobReads;assert.match(await attempt(50000,65000),/未发送/);assert.equal(blobReads,reads);
  elapse();retryAfter='120';await attempt(120000,125000);
  elapse();retryAfter='901';await attempt(901000,906000);
  // However often it happens, a rate limit never fails the task. Without a time from GitHub the wait doubles from a minute;
  // after four stops in a row it is at its 15-minute cap.
  for(let more=0;more<3;more++){elapse();retryAfter=undefined;assert.match(await attempt(900000,905000),/GitHub 未给出恢复时间/);}
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='old-pause'").status,'waiting_permission');
  await withBusyComputer(h,async()=>{
    assert.equal((await h.admin('/api/tasks/'+h.taskId+'/retry','POST',{})).status,201);
    const queued=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);assert.equal(queued.status,'queued');assert.equal(queued.error_code,null);assert.equal(queued.retry_count,0);assert.equal(queued.next_run_at,0);
  });
});

test('a permission failure remains paused and its task detail contains the safe GitHub explanation',async t=>{
  const h=await emptyRepositoryFixture(t,{github(path,send){if(path!=='/user')return false;send({message:'Resource not accessible by integration fixture-key',extra:'not-for-the-log'},403);return true;}});
  const task=await h.run();assert.equal(task.status,'waiting_permission');assert.equal(task.error_code,'github_permission_403');
  const detail=(await h.admin('/api/tasks/'+h.taskId)).value.task.error_detail;
  assert.match(detail,/Resource not accessible by integration/);assert.ok(!detail.includes('fixture-key'));assert.ok(!detail.includes('not-for-the-log'));
});

test('retry queues behind another task in the same repository and rejects only the task already queued or running',async t=>{
  const h=await emptyRepositoryFixture(t);h.setBranch('ready');
  h.store.run("UPDATE tasks SET status='failed',error_code='github_unavailable',next_run_at=9999999999999 WHERE id=?",h.taskId);
  const retry=()=>h.admin('/api/tasks/'+h.taskId+'/retry','POST',{});
  // A failed status can be visible before the same execution has finished releasing its computer.
  h.engine.active.set(h.taskId,Promise.resolve());
  try{const result=await retry();assert.equal(result.status,409);assert.equal(result.value.error,'task_already_running');}
  finally{h.engine.active.delete(h.taskId);}
  await withBusyComputer(h,async()=>{
    assert.equal((await retry()).status,201);const task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);
    assert.equal(task.status,'queued');assert.equal(task.error_code,null);assert.equal(task.next_run_at,0);assert.equal(h.operations.length,0);
    h.engine.tick();assert.equal(h.operations.length,0);
    for(const status of ['queued','running']){h.store.run('UPDATE tasks SET status=? WHERE id=?',status,h.taskId);assert.deepEqual((await retry()).value,{error:'task_already_running'});assert.equal((await retry()).status,409);}
    for(const status of ['succeeded','completed','pr_opened','cancelled','superseded']){h.store.run('UPDATE tasks SET status=? WHERE id=?',status,h.taskId);const result=await retry();assert.equal(result.status,409);assert.equal(result.value.error,'task_not_retryable');}
    h.store.run("UPDATE tasks SET status='waiting_pr_head' WHERE id=?",h.taskId);assert.equal((await retry()).status,201);
  });
  const task=await h.run();assert.equal(task.status,'succeeded');assert.equal(h.comments.length,1);
});

test('retry starts alongside another task when the repository concurrency has room',async t=>{
  const h=await emptyRepositoryFixture(t);h.setBranch('ready');h.store.run("UPDATE tasks SET status='failed' WHERE id=?",h.taskId);
  await h.admin('/api/repositories/101/policy','PATCH',{task_concurrency:2});
  await withBusyComputer(h,async()=>{
    assert.equal((await h.admin('/api/tasks/'+h.taskId+'/retry','POST',{})).status,201);
    const work=h.engine.active.get(h.taskId);assert.ok(work);assert.equal(h.engine.active.size,2);await work;
    assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?',h.taskId).status,'succeeded');assert.ok(h.engine.active.has('other-task'));
  });
});
