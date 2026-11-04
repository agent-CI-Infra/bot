import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {TaskEngine} from '../dist/agent/engine.js';
import {sha,operationId} from '../dist/agent/common.js';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';

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
    h.setBranch('ready');h.store.run('UPDATE models SET api_url=?','http://127.0.0.1:'+model.address().port+'/v1');
    h.store.run("UPDATE policies SET development_enabled=1 WHERE repository_id='101'");
    h.store.run('UPDATE tasks SET kind=?,attempt=3 WHERE id=?',kind,h.taskId);
    for(let failure=1;failure<=5;failure++){
      h.due();const before=Date.now(),task=await h.run();
      assert.deepEqual([task.status,task.phase,task.workspace_id,task.attempt,task.retry_count],[fault==='transport'?'retry_wait':'waiting_environment','prepare',null,3+failure,failure]);
      assert.equal(starts.length,failure);assert.ok([...processes.values()].every(process=>!process.alive));
      if(failure===5)assert.ok(task.next_run_at>=before+cycleMs&&task.next_run_at<=Date.now()+cycleMs);
    }
    const saved=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId),receipts=h.store.all("SELECT id,request FROM task_tools WHERE task_id=? AND json_extract(request,'$.request.type')='workspace_agent_start'",h.taskId);
    assert.equal(new Set(receipts.map(row=>row.id)).size,5);
    assert.equal(new Set(receipts.map(row=>JSON.parse(row.request).request.workspace_id)).size,5);
    assert.equal(requests,fault==='transport'?5:0);
    // Recreate the engine: the slow schedule belongs to the task, not a timer in this process.
    await h.engine.close();const engine=new TaskEngine(h.store,h.engine.manager,h.githubUrl);t.after(()=>engine.close());
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
  ['label','development.issue','needs_replan','development_not_approved'],
  ['assignee','development.issue','needs_replan','development_not_approved'],
  ['base','development.issue','needs_replan','base_branch_changed'],
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
    if(condition==='assignee')object.assignees=[{id:42}];
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
