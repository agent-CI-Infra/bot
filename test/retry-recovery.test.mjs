import { acceptanceFixture } from './acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {TaskEngine} from '../dist/agent/engine.js';
import {sha,operationId,TaskError} from '../dist/agent/common.js';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';
import {loadConsole} from './console-page.mjs';

const cycleMs=8*60*60*1000;
const review={summary:'Reviewed.',findings:[],requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:''};
const issue={number:1,state:'open',title:'First issue',body:'Please review this project.',labels:[{name:'bot-develop'}],assignees:[]};
const pull={...issue,id:123,draft:false,user:{id:999},head:{sha:'a'.repeat(40),ref:'bot/fix',repo:{id:101}},base:{ref:'main'}};

test('a cached started receipt left by an older run cannot bypass the runner liveness check',async t=>{
  const starts=[];
  const h=await emptyRepositoryFixture(t,{execute(request){
    if(request.type==='workspace_agent_start'){
      starts.push(request.workspace_id);
      return {ok:true,result:request.workspace_id==='dead'?{error:'agent_interrupted'}:{started:true}};
    }
    if(request.type==='workspace_agent_poll')assert.notEqual(request.workspace_id,'dead','the dead PID must not be polled');
  }});h.setBranch('ready');
  h.store.run("UPDATE tasks SET phase='model',workspace_id='dead',generation=1,attempt=3,input=? WHERE id=?",JSON.stringify({context:{mode:'review'}}),h.taskId);
  const id=operationId(`${h.taskId}:3:pi:start`),request={operation_id:id,generation:1,request:{type:'workspace_agent_start',workspace_id:'dead'}};
  h.store.run("INSERT INTO task_tools VALUES(?,?,?,?,'completed')",id,h.taskId,JSON.stringify(request),JSON.stringify({started:true}));
  let task=await h.run();assert.deepEqual([task.status,task.phase,task.attempt],['waiting_environment','prepare',4]);assert.deepEqual(starts,['dead']);
  h.due();task=await h.run();assert.equal(task.status,'succeeded');assert.equal(starts.length,2);assert.notEqual(starts[1],'dead');
});

for(const kind of ['review.issue','development.issue'])for(const fault of ['transport','interrupted']){
  test(`${kind}: ${fault} after attempt 3 reaps the process and restarts with a fresh receipt, including eight-hour retries`,async t=>{
    let failing=true,requests=0;const starts=[],processes=new Map();
    const model=createServer(async(req)=>{for await(const _ of req);requests++;req.socket.destroy();});
    model.listen(0,'127.0.0.1');await once(model,'listening');t.after(()=>new Promise(resolve=>model.close(resolve)));
    const h=await emptyRepositoryFixture(t,{
      modelUrl:'http://127.0.0.1:'+model.address().port+'/v1',
      taskKind:kind,
      github(path,send){if(path.endsWith('/issues/1')){send(issue);return true;}},
      execute(request){
        const id=request.workspace_id;
        if(request.type==='workspace_agent_start'){
          assert.equal(processes.has(id),false,'a retry must not reuse the workspace of the reaped process');
          starts.push(id);processes.set(id,{alive:true,published:false});return {ok:true,result:{started:true}};
        }
        if(request.type==='reap'){if(processes.has(id))processes.get(id).alive=false;return {ok:true,result:{killed:1,remaining:0}};}
        if(request.type==='workspace_agent_poll'){
          const process=processes.get(id);assert.equal(process?.alive,true,'must start a new process instead of polling a dead PID');
          if(failing)return {ok:true,result:fault==='interrupted'?{state:'interrupted',offset:45}:{state:'running',request:{id:'c'.repeat(48),body:{messages:[{role:'user',content:'Review.'}]}}}};
          if(kind.startsWith('development.')&&!process.published){process.published=true;return {ok:true,result:{state:'running',pull_request:{id:'d'.repeat(48),arguments:{summary:'No changes needed.',test_command:'node --test'}}}};}
          return {ok:true,result:{state:'completed',result:review}};
        }
        if(request.type==='workspace_finalize')return {ok:true,result:{tree_sha:'b'.repeat(40),files:[]}};
      },
    });
    h.setBranch('ready');
    h.store.run("UPDATE policies SET development_enabled=1 WHERE repository_id='101'");
    h.store.run('UPDATE tasks SET attempt=3 WHERE id=?',h.taskId);
    for(let failure=1;failure<=5;failure++){
      h.due();const before=Date.now(),task=await h.run();
      assert.deepEqual([task.status,task.phase,task.workspace_id,task.attempt,task.retry_count],[fault==='transport'?'retry_wait':'waiting_environment','prepare',null,3+failure,failure]);
      assert.equal(starts.length,failure);assert.ok([...processes.values()].every(process=>!process.alive));
      const delay=failure===5?cycleMs:5000*(fault==='transport'?3:2)**(failure-1);
      assert.ok(task.next_run_at>=before+delay&&task.next_run_at<=Date.now()+delay);
    }
    const saved=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId),receipts=h.store.all("SELECT id,request FROM task_tools WHERE task_id=? AND json_extract(request,'$.request.type')='workspace_agent_start'",h.taskId);
    assert.equal(new Set(receipts.map(row=>row.id)).size,5);
    assert.equal(new Set(receipts.map(row=>JSON.parse(row.request).request.workspace_id)).size,5);
    // Five failed task attempts each exhaust the shared three-request transport budget.
    assert.equal(requests,fault==='transport'?15:0);
    // Recreate the engine: the slow schedule belongs to the task, not a timer in this process.
    await h.engine.close();const engine=new TaskEngine(h.store,h.engine.manager,h.githubUrl, undefined, acceptanceFixture);t.after(()=>engine.close());
    let now=saved.next_run_at-1;t.mock.method(Date,'now',()=>now);
    engine.tick();assert.equal(engine.active.size,0);assert.equal(starts.length,5);
    now=saved.next_run_at;engine.tick();await Promise.all(engine.active.values());
    let task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);
    assert.equal(starts.length,6);assert.equal(task.retry_cycle_started_at,saved.retry_cycle_started_at);
    assert.equal(task.next_run_at,saved.next_run_at+cycleMs);
    failing=false;now=task.next_run_at;engine.tick();await Promise.all(engine.active.values());
    task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);
    assert.equal(starts.length,7);assert.ok(['succeeded','completed'].includes(task.status),task.status);
    assert.equal(task.retry_cycle_started_at,null);assert.equal(task.retry_count,0);
  });
}

const conditions=[
  ['closed','review.issue','cancelled','object_closed_or_draft'],
  ['closed','development.issue','cancelled','object_closed_or_draft'],
  ['draft','review.pr','cancelled','object_closed_or_draft'],
  ['draft','development.pr','cancelled','object_closed_or_draft'],
  ['head','review.pr','superseded','pull_request_head_changed'],
  ['head','development.pr','superseded','pull_request_head_changed'],
  ['policy','review.issue','cancelled','repository_policy_disabled'],
  ['policy','development.issue','cancelled','repository_policy_disabled'],
  ['goal','development.issue','needs_replan','issue_needs_replan'],
  // Who is assigned is the Manager's judgement when it starts development, not a recheck (except for Actions reports).
  ['label','development.issue','needs_replan','development_not_approved'],
  ['owner','development.pr','waiting_permission','bot_pr_author_changed'],
  ['bot_pr_closed','development.issue','cancelled','object_closed_or_draft'],
];
for(const phase of ['model','publish'])for(const [condition,kind,status,code] of conditions){
  test(`eight-hour ${kind} retry in ${phase} rechecks ${condition} before any model or publication`,async t=>{
    const object=structuredClone(kind.endsWith('.pr')?pull:issue),botPR=structuredClone(pull);
    if(condition==='closed')object.state='closed';
    if(condition==='draft')object.draft=true;
    if(condition==='head')object.head.sha='f'.repeat(40);
    if(condition==='goal')object.body='A different goal.';
    if(condition==='label')object.labels=[];
    if(condition==='owner')object.user.id=42;
    if(condition==='bot_pr_closed')botPR.state='closed';
    let writes=0;
    const h=await emptyRepositoryFixture(t,{github(path,send,res){
      if(res.req.method!=='GET')writes++;
      if(path.endsWith('/issues/1')||path.endsWith('/pulls/1')){send(condition==='bot_pr_closed'&&path.endsWith('/pulls/1')?botPR:object);return true;}
    }});h.setBranch('ready');
    h.store.run("UPDATE policies SET development_enabled=1,enabled=? WHERE repository_id='101'",condition==='policy'?0:1);
    const input={object:issue,object_hash:sha(JSON.stringify([issue.title,issue.body])),context:{mode:kind.startsWith('development.')?'development':'review'},files:[],...(condition==='bot_pr_closed'?{bot_pr:pull}:{})};
    const entered=Date.now()-cycleMs;
    h.store.run("UPDATE tasks SET kind=?,status='retry_wait',phase=?,input=?,head_sha=?,workspace_id='old',generation=1,retry_count=5,retry_error_code='model_unavailable',retry_cycle_started_at=?,next_run_at=? WHERE id=?",
      kind,phase,JSON.stringify(input),pull.head.sha,entered,Date.now()-1,h.taskId);
    if(kind==='development.pr'||condition==='bot_pr_closed')h.store.run("INSERT INTO bot_pull_requests VALUES('101',1,'123','999','101','bot/fix',?,?,0)",pull.head.sha,h.taskId);
    if(condition==='base')h.store.run('INSERT INTO development_candidates VALUES(?,?)',h.taskId,JSON.stringify({base_branch:'main',base_sha:'e'.repeat(40)}));
    if(phase==='publish'){
      h.store.run('UPDATE tasks SET result=? WHERE id=?',JSON.stringify({...review,coverage:[],reviewed_sha:pull.head.sha}),h.taskId);
      if(kind.startsWith('development.')&&condition!=='base')h.store.run('INSERT INTO development_candidates VALUES(?,?)',h.taskId,JSON.stringify({base_branch:'main',base_sha:pull.head.sha,files:[]}));
    }
    const task=await h.run();
    assert.deepEqual([task.status,task.error_code],[status,code]);
    assert.equal(task.retry_cycle_started_at,null);assert.equal(writes,0);
    assert.equal(h.operations.includes('workspace_agent_start'),false);assert.equal(h.store.get('SELECT count(*) n FROM model_requests').n,0);
    // Cancelled, superseded and replan/permission tasks never become eligible just because another slot passed.
    const attempt=task.attempt;h.due();await h.run();assert.equal(h.store.get('SELECT attempt FROM tasks WHERE id=?',h.taskId).attempt,attempt);
  });
}

for(const [change,status,code] of [['closed','cancelled','object_closed_or_draft'],['draft','cancelled','object_closed_or_draft'],['head','superseded','pull_request_head_changed']]){
  test(`ReviewUpdated rechecks ${change} before continuing the model in the same run`,async t=>{
    let h,inserted=false,resumeChecks=0;const object=structuredClone(pull);
    h=await emptyRepositoryFixture(t,{github(path,send){
      if(!path.endsWith('/pulls/1'))return false;
      const phase=h.store.get('SELECT phase FROM tasks WHERE id=?',h.taskId).phase,response=structuredClone(object);
      if(inserted&&phase==='model')resumeChecks++;
      if(!inserted&&phase==='publish'){
        // The object read for the pending write is open, then new discussion invalidates that result. The object
        // changes before ReviewUpdated returns to the model, so that entry must read it again before continue.
        h.store.run('INSERT INTO review_updates(task_id,event_key,data) VALUES(?,?,?)',h.taskId,'before-publication',JSON.stringify({reason:'comment',actor:'alice'}));
        inserted=true;
        if(change==='closed')object.state='closed';
        if(change==='draft')object.draft=true;
        if(change==='head')object.head.sha='f'.repeat(40);
      }
      send(response);return true;
    }});
    const input={object:pull,context:{mode:'review'},files:[],coverage:[]};
    h.store.run("UPDATE tasks SET kind='review.pr',phase='model',workspace_id='existing',generation=1,head_sha=?,input=? WHERE id=?",pull.head.sha,JSON.stringify(input),h.taskId);
    const task=await h.run();
    assert.equal(inserted,true);assert.equal(resumeChecks,1);assert.deepEqual([task.status,task.error_code],[status,code]);
    assert.equal(h.operations.filter(type=>type==='workspace_agent_start').length,1);
    assert.equal(h.operations.includes('workspace_agent_continue'),false);assert.equal(h.comments.length,0);
  });
}

test('different transient failures reset the consecutive count, and entering the cycle does not synchronize tasks',async t=>{
  let code=502;const h=await emptyRepositoryFixture(t,{github(path,send){if(path==='/user'){send({message:'Server Error'},code);return true;}}});
  for(let i=0;i<4;i++){h.due();await h.run();}
  code=503;h.due();let task=await h.run();assert.equal(task.retry_count,1);assert.equal(task.retry_cycle_started_at,null);
  for(let i=0;i<4;i++){h.due();task=await h.run();}
  const first=task.retry_cycle_started_at;
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('later','101','review.issue','queued','later')");
  let now=Date.now()+123456;t.mock.method(Date,'now',()=>now);
  for(let i=0;i<5;i++){h.store.run("UPDATE tasks SET next_run_at=0 WHERE id='later'");h.engine.tick();await Promise.all(h.engine.active.values());}
  const later=h.store.get("SELECT * FROM tasks WHERE id='later'");assert.equal(later.next_run_at,later.retry_cycle_started_at+cycleMs);assert.ok(later.retry_cycle_started_at-first>=123456);
  // A new transient cause inside the cycle keeps the task in that cycle instead of resetting to five fast retries.
  code=502;now=task.next_run_at;h.engine.tick();await Promise.all(h.engine.active.values());task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);
  assert.equal(task.retry_count,1);assert.equal(task.retry_cycle_started_at,first);assert.equal(task.next_run_at,first+2*cycleMs);
});

test('GitHub rate limits keep their own window without consuming or resetting the consecutive failure count',async t=>{
  let limited=false;
  const h=await emptyRepositoryFixture(t,{github(path,send,res){
    if(path!=='/user')return false;
    if(limited){res.setHeader('Retry-After','60');send({message:'secondary rate limit'},429);}
    else send({message:'Server Error'},502);
    return true;
  }});
  // The response and retry scheduling share one instant; processing time is not retry jitter.
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  for(let i=0;i<4;i++){h.due();await h.run();}
  limited=true;
  for(let i=0;i<6;i++){
    h.due();const task=await h.run();assert.equal(task.retry_count,4);assert.equal(task.retry_cycle_started_at,null);
    const until=h.store.get('SELECT max(limited_until) until FROM github_rate_limits').until;
    assert.ok(until>Date.now());assert.ok(task.next_run_at>=until&&task.next_run_at<=until+5000);
  }
  limited=false;h.store.run('UPDATE github_rate_limits SET limited_until=NULL');h.due();let task=await h.run();
  assert.equal(task.retry_count,5);assert.ok(task.retry_cycle_started_at);const entered=task.retry_cycle_started_at;
  limited=true;h.due();task=await h.run();assert.equal(task.retry_count,5);assert.equal(task.retry_cycle_started_at,entered);
  assert.ok(task.next_run_at<Date.now()+65000,'the GitHub window still applies inside the slow cycle');
});

test('manual retries and close webhooks leave the eight-hour cycle',async t=>{
  const h=await emptyRepositoryFixture(t);h.setBranch('ready');
  h.store.run("UPDATE tasks SET status='retry_wait',retry_count=5,retry_error_code='model_unavailable',retry_cycle_started_at=?,next_run_at=? WHERE id=?",Date.now(),Date.now()+cycleMs,h.taskId);
  assert.equal((await h.admin('/api/tasks/'+h.taskId+'/retry','POST',{})).status,201);await Promise.all(h.engine.active.values());
  let task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);assert.equal(task.status,'succeeded');assert.equal(task.retry_cycle_started_at,null);
  h.store.run("UPDATE tasks SET status='retry_wait',retry_count=5,retry_cycle_started_at=?,next_run_at=? WHERE id=?",Date.now(),Date.now()+cycleMs,h.taskId);
  // Dispatch the same close event that the GitHub webhook path uses, without invoking any live repository.
  const {queueWebhook}=await import('../dist/review/queue.js');
  queueWebhook(h.store,'101','issues',{action:'closed',issue:{...issue,state:'closed'}},null);
  task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);assert.equal(task.status,'cancelled');assert.equal(task.retry_cycle_started_at,null);
  h.due();await h.run();assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?',h.taskId).status,'cancelled');
});

test('an unexpected error retries on its own after 5 s, 15 s, 45 s and 135 s, then every eight hours',async t=>{
  // Before, any error that was not a known task stop ended the task as failed until someone pressed 重试.
  const h=await emptyRepositoryFixture(t);h.setBranch('ready');t.mock.method(console,'error',()=>{});
  const call=h.engine.manager.call.bind(h.engine.manager);
  h.engine.manager.call=async(method,path,body)=>{if(method==='GET'&&path==='/v1/projects/101')throw new Error('unexpected failure');return call(method,path,body);};
  for(const [i,delay] of [5000,15000,45000,135000].entries()){
    h.due();const before=Date.now(),task=await h.run(),after=Date.now();
    assert.deepEqual([task.status,task.error_code,task.retry_count,task.retry_cycle_started_at],['retry_wait','task_runtime_failure',i+1,null]);
    assert.ok(task.next_run_at>=before+delay&&task.next_run_at<=after+delay,`retry ${i+1}: ${task.next_run_at-before} ms`);
  }
  h.due();const before=Date.now(),task=await h.run();
  assert.deepEqual([task.status,task.retry_count],['retry_wait',5]);assert.ok(task.retry_cycle_started_at>=before);
  assert.ok(Math.abs(task.next_run_at-(task.retry_cycle_started_at+8*60*60*1000))<1000,'then once every eight hours');
  // Once the cause is gone the next retry continues the task.
  h.engine.manager.call=call;h.due();assert.notEqual((await h.run()).error_code,'task_runtime_failure');
});

const waits=[
  ['environment_not_ready','waiting_environment',5000,300000],
  ['environment_generation_changed','waiting_environment',5000,300000],
  ['repository_has_no_commit','waiting_configuration',30000,1800000],
  ['pr_head_pending','waiting_pr_head',5000,300000],
  ['task_runtime_failure','waiting_environment',5000,300000],
  ['model_authentication_failed','waiting_configuration',30000,1800000],
];
for(const [code,state,base,cap] of waits)for(const inCycle of [false,true]){
  test(`${code} keeps capped condition polling after five waits, with ${inCycle?'an existing':'no'} eight-hour cycle`,async t=>{
    const h=await emptyRepositoryFixture(t);if(code!=='repository_has_no_commit')h.setBranch('ready');
    const call=h.engine.manager.call.bind(h.engine.manager);
    h.engine.manager.call=async(method,path,body)=>{
      if(method==='GET'&&path==='/v1/projects/101'){
        if(code==='environment_not_ready')return {...await call(method,path,body),state:'failed'};
        if(code==='task_runtime_failure')throw new Error('manager temporarily unavailable');
        if(!['repository_has_no_commit','environment_generation_changed'].includes(code))throw new TaskError(code,state,'Condition is not ready.');
      }
      return call(method,path,body);
    };
    if(code==='task_runtime_failure')t.mock.method(console,'error',()=>{});
    const entered=inCycle?Date.now()-60000:null;
    h.store.run("UPDATE tasks SET retry_count=4,retry_error_code='model_unavailable',retry_cycle_started_at=?,generation=? WHERE id=?",entered,code==='environment_generation_changed'?99:null,h.taskId);
    for(let i=0;i<10;i++){
      h.due();const before=Date.now(),task=await h.run(),after=Date.now(),delay=Math.min(base*2**i,cap);
      assert.deepEqual([task.status,task.error_code,task.retry_count,task.retry_error_code,task.retry_cycle_started_at],[state,code,4,'model_unavailable',entered]);
      assert.ok(task.next_run_at>=before+delay&&task.next_run_at<=after+delay,`${code} wait ${i+1}: ${task.next_run_at-before} ms`);
    }
    const detail=(await h.admin('/api/tasks/'+h.taskId)).value.task;
    assert.equal(detail.retry_cycle_started_at,entered);assert.ok(!detail.error_cause.retry_cycle);assert.doesNotMatch(detail.error_cause.action,/8 小时/);
    const page=loadConsole(['static/app.js','static/views.js'],()=>[404,{}]);
    const shown=page.run(`liveText(${JSON.stringify(detail)})`);
    assert.doesNotMatch(shown,/8 小时|满 5 次|下次重试/);assert.equal(detail.error_cause.attempt_retry,false);
    if(code==='repository_has_no_commit')assert.equal(shown,'仓库还没有提交；默认分支出现提交后会自动继续。');
    if(code==='pr_head_pending')assert.equal(shown,'PR 尚未指向刚推送的提交 （读取中）；正在自动重读 PR head，匹配后继续更新 PR 描述。不会重复推送或增加修订轮数。');
    const logs=(await h.admin('/api/tasks/'+h.taskId+'/logs')).value.logs.filter(log=>log.cause);
    assert.equal(logs.length,1,'unchanged conditions are logged once even while a cycle is retained');
    assert.doesNotMatch(logs[0].cause.action,/8 小时/);
  });
}

for(const code of ['workspace_init_failed','workspace_write_failed','workspace_snapshot_mismatch','candidate_unavailable','candidate_blob_unavailable']){
  test(`${code} still enters an eight-hour cycle on its fifth failed attempt`,async t=>{
    const h=await emptyRepositoryFixture(t),call=h.engine.manager.call.bind(h.engine.manager);
    h.engine.manager.call=async(method,path,body)=>{
      if(method==='GET'&&path==='/v1/projects/101')throw new TaskError(code,'waiting_environment','Attempt failed.');
      return call(method,path,body);
    };
    for(let i=0;i<6;i++){
      h.due();const before=Date.now(),task=await h.run(),after=Date.now();
      assert.equal(task.retry_count,i+1);
      if(i<4){const delay=5000*2**i;assert.equal(task.retry_cycle_started_at,null);assert.ok(task.next_run_at>=before+delay&&task.next_run_at<=after+delay);}
      else {assert.ok(task.retry_cycle_started_at);assert.equal(task.next_run_at,task.retry_cycle_started_at+cycleMs);assert.ok(task.next_run_at>=before+cycleMs-1000);}
    }
  });
}

for(const code of ['execution_interrupted','github_http_502'])for(const inCycle of [false,true]){
  test(`an environment wait preserves ${code} ${inCycle?'inside the cycle':'before the fifth failure'}`,async t=>{
    let waiting=false;
    const h=await emptyRepositoryFixture(t,{
      github(path,send){if(code==='github_http_502'&&path==='/user'){send({message:'Server Error'},502);return true;}},
      execute(request){if(request.type==='workspace_agent_poll')return {ok:true,result:{state:'interrupted'}};},
    });h.setBranch('ready');
    const call=h.engine.manager.call.bind(h.engine.manager);
    h.engine.manager.call=async(method,path,body)=>{
      const result=await call(method,path,body);
      return waiting&&method==='GET'&&path==='/v1/projects/101'?{...result,state:'failed'}:result;
    };
    const failures=inCycle?5:4;
    for(let i=0;i<failures;i++){h.due();await h.run();}
    const saved=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);
    waiting=true;h.due();const before=Date.now(),condition=await h.run();
    assert.deepEqual([condition.error_code,condition.retry_count,condition.retry_error_code,condition.retry_cycle_started_at],['environment_not_ready',failures,code,saved.retry_cycle_started_at]);
    assert.ok(condition.next_run_at>=before+5000&&condition.next_run_at<=Date.now()+5000);
    waiting=false;h.due();const resumedAt=Date.now(),task=await h.run();
    assert.deepEqual([task.error_code,task.retry_count,task.retry_error_code],[code,failures+1,code]);
    if(inCycle){assert.equal(task.retry_cycle_started_at,saved.retry_cycle_started_at);assert.equal(task.next_run_at,saved.next_run_at);}
    else assert.ok(task.next_run_at>=resumedAt+cycleMs&&task.next_run_at<=Date.now()+cycleMs);
  });
}
