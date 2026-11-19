import { pinLegacyTaskConfiguration } from '../../../fixtures/helpers.mjs';
import { acceptanceFixture } from '../../../fixtures/acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {TaskEngine} from '../../../../dist/agent/engine.js';
import {sha,operationId,TaskError} from '../../../../dist/agent/common.js';
import {emptyRepositoryFixture} from '../../../fixtures/empty-repository-helpers.mjs';
import {loadConsole} from '../../../fixtures/console-page.mjs';

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
  h.store.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES(?,?,?,?,'completed')",id,h.taskId,JSON.stringify(request),JSON.stringify({started:true}));
  let task=await h.run();assert.deepEqual([task.status,task.phase,task.attempt],['waiting_environment','prepare',4]);assert.deepEqual(starts,['dead']);
  h.due();task=await h.run();assert.equal(task.status,'succeeded');assert.equal(starts.length,2);assert.notEqual(starts[1],'dead');
});

for(const kind of ['review.issue','development.issue'])for(const fault of ['transport','interrupted']){
  test(`${kind}: ${fault} after attempt 3 reaps the process and restarts with a fresh receipt, including eight-hour retries`,async t=>{
    let failing=true,requests=0;const starts=[],processes=new Map();
    const model=createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
      if(body.tools?.some(t=>t.function.name==='submit_retry_decision')){
        res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'continue_retry',type:'function',function:{name:'submit_retry_decision',arguments:JSON.stringify({action:'continue_retry',reason:'Preserve this transport recovery test; keep retrying'})}}]}}]}));return;
      }
      requests++;req.socket.destroy();
    });
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
          if(kind.startsWith('development.')&&!process.published){process.published=true;return {ok:true,result:{state:'running',tool_requests:[{id:'d'.repeat(48),kind:'pull_request',name:'create_pull_request',arguments:{summary:'No changes needed.',test_command:'node --test'}}]}};}
          return {ok:true,result:{state:'completed',result:review}};
        }
        if(request.type==='workspace_finalize')return {ok:true,result:{tree_sha:'b'.repeat(40),files:[]}};
      },
    });
    h.setBranch('ready');
    h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");
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
    // Five failed task attempts each exhaust the shared transport budget: one request and five retries.
    assert.equal(requests,fault==='transport'?30:0);
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
  // A new head no longer supersedes (#770): the review prepares it afresh (this fixture has no Git cache to move the worktree
  // in place) and the development stops to prepare it with its work saved.
  ['head','review.pr','queued','pull_request_head_changed'],
  ['head','development.pr','retry_wait','pull_request_head_changed'],
  ['policy','review.issue','cancelled','repository_policy_disabled'],
  ['policy','development.issue','cancelled','repository_policy_disabled'],
  // An edit of the Issue no longer stops its development (#815): see 'an Issue edited during its development' below.
  // Who is assigned is the Manager's judgement when it starts development, not a recheck (except for Actions reports).
  ['label','development.issue','waiting_permission','development_not_approved'],
  ['owner','development.pr','waiting_permission','bot_pr_author_changed'],
  ['bot_pr_closed','development.issue','cancelled','object_closed_or_draft'],
];
for(const phase of ['model','publish'])for(const [condition,kind,status,code] of conditions){
  test(`eight-hour ${kind} retry in ${phase} rechecks ${condition} before any model or publication`,async t=>{
    const object=structuredClone(kind.endsWith('.pr')?pull:issue),botPR=structuredClone(pull);
    if(condition==='closed')object.state='closed';
    if(condition==='draft')object.draft=true;
    if(condition==='head')object.head.sha='f'.repeat(40);
    if(condition==='label')object.labels=[];
    if(condition==='owner')object.user.id=42;
    if(condition==='bot_pr_closed')botPR.state='closed';
    let writes=0;
    const h=await emptyRepositoryFixture(t,{github(path,send,res){
      if(res.req.method!=='GET')writes++;
      if(path.endsWith('/issues/1')||path.endsWith('/pulls/1')){send(condition==='bot_pr_closed'&&path.endsWith('/pulls/1')?botPR:object);return true;}
    }});h.setBranch('ready');
    h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1,enabled=? WHERE repository_id='101'",condition==='policy'?0:1);
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
    // A review whose accepted result is already publishing finishes that publication on the head it reviewed; the new head
    // is an update for its next round, not a reason to abandon the accepted publication.
    const publishOnReviewedHead=phase==='publish'&&condition==='head'&&kind==='review.pr';
    if(publishOnReviewedHead){
      // The accepted result finished on the old head and was published; the new head is already the update of round 2.
      assert.equal(task.error_code,null);assert.deepEqual([task.phase,task.attempt,JSON.parse(task.input).round],['prepare',2,2]);
      assert.equal(writes,1);assert.equal(h.operations.includes('workspace_agent_start'),false);assert.equal(h.store.get('SELECT count(*) n FROM model_requests').n,0);
      const updates=h.store.all('SELECT data FROM review_updates WHERE task_id=?',h.taskId).map(row=>JSON.parse(row.data));
      assert.deepEqual(updates.map(update=>[update.reason,update.previous_head,update.current_head]),[['pull_request_head_changed',pull.head.sha,object.head.sha]]);
      h.due();await h.run();
      assert.equal(h.store.get('SELECT head_sha FROM tasks WHERE id=?',h.taskId).head_sha,object.head.sha);
      return;
    }
    assert.deepEqual([task.status,task.error_code],[status,code]);
    assert.equal(task.retry_cycle_started_at,null);assert.equal(writes,0);
    assert.equal(h.operations.includes('workspace_agent_start'),false);assert.equal(h.store.get('SELECT count(*) n FROM model_requests').n,0);
    // The task starts its next attempt on the new head, told why; a development's work is saved first.
    if(condition==='head'){
      assert.equal(task.phase,'prepare');
      if(kind==='development.pr'){assert.equal(JSON.parse(task.input).manager_feedback.code,code);assert.deepEqual([task.retry_count,task.retry_error_code],[0,null]);
        if(phase==='model')assert.ok(h.store.get("SELECT 1 FROM task_history WHERE task_id=? AND type IN ('artifact_checkpoint','checkpoint_fault')",h.taskId));}
    }
    // Cancelled, superseded and replan/permission tasks never become eligible just because another slot passed.
    const attempt=task.attempt;h.due();await h.run();assert.equal(h.store.get('SELECT attempt FROM tasks WHERE id=?',h.taskId).attempt,attempt);
    // A review prepares the new head at once; a development first has the Manager decide how it continues (manager_feedback).
    if(condition==='head'&&kind==='review.pr')assert.equal(h.store.get('SELECT head_sha FROM tasks WHERE id=?',h.taskId).head_sha,object.head.sha);
  });
}

// #815: an edit of the Issue is an update of its development, not a stop. The development keeps the current text and the
// edit is kept with its updates, which later role assignments read in their task facts.
test('an Issue edited during its development is an update of the task, not a stop',async t=>{
  const edited={...structuredClone(issue),body:'A different goal.',html_url:'https://github.invalid/issues/1'};
  const h=await emptyRepositoryFixture(t,{github(path,send){if(path.endsWith('/issues/1')){send(edited);return true;}}});h.setBranch('ready');
  h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");
  const input={object:issue,object_hash:sha(JSON.stringify([issue.title,issue.body])),context:{mode:'development',object:{title:issue.title,body_excerpt:issue.body}},files:[]};
  h.store.run("UPDATE tasks SET kind='development.issue',status='retry_wait',phase='model',input=?,workspace_id='old',generation=1,next_run_at=? WHERE id=?",JSON.stringify(input),Date.now()-1,h.taskId);
  const task=await h.run();
  assert.notEqual(task.error_code,'issue_needs_replan');assert.notEqual(task.status,'needs_replan');
  const saved=JSON.parse(task.input);
  assert.equal(saved.object_hash,sha(JSON.stringify([edited.title,edited.body])));assert.equal(saved.context.object.body_excerpt,'A different goal.');
  const [update]=h.store.all('SELECT data FROM review_updates WHERE task_id=?',h.taskId).map(row=>JSON.parse(row.data));
  assert.deepEqual([update.reason,update.changed,update.object.body],['issue_edited',['body'],'A different goal.']);
  assert.ok(h.store.all('SELECT content FROM task_logs WHERE task_id=?',h.taskId).some(row=>JSON.parse(row.content).type==='issue_updated'));
  // Role assignments that start later read it in the task facts.
  const {TaskRecords}=await import('../../../../dist/tasks/service.js');
  assert.deepEqual(new TaskRecords(h.store).facts(h.taskId).updates.map(u=>[u.reason,u.body_excerpt]),[['issue_edited','A different goal.']]);
  // Seeing the same text again adds nothing.
  h.store.run("UPDATE tasks SET status='retry_wait',phase='model',next_run_at=? WHERE id=?",Date.now()-1,h.taskId);await h.run();
  assert.equal(h.store.get('SELECT count(*) n FROM review_updates WHERE task_id=?',h.taskId).n,1);
});

// #815: a development stopped because the development label was removed goes back to the Manager to answer the person; a
// person adding the label again lets the Manager continue it, which resumes the task.
test('a development stopped by a removed label goes to the Manager, and resumes when the label is added again',async t=>{
  const unlabeled={...structuredClone(issue),labels:[]};let current=unlabeled;
  const h=await emptyRepositoryFixture(t,{github(path,send){if(path.endsWith('/issues/1')){send(current);return true;}}});h.setBranch('ready');
  h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");
  const input={object:issue,object_hash:sha(JSON.stringify([issue.title,issue.body])),context:{mode:'development'},files:[]};
  h.store.run("UPDATE tasks SET kind='development.issue',status='retry_wait',phase='model',input=?,workspace_id='old',generation=1,next_run_at=? WHERE id=?",JSON.stringify(input),Date.now()-1,h.taskId);
  const task=await h.run();
  assert.deepEqual([task.status,task.error_code],['waiting_permission','development_not_approved']);
  const stopped=h.store.get("SELECT * FROM dispatch_events WHERE type='development.stopped'");
  assert.ok(stopped,'the stop is an event for the Manager');
  assert.equal(JSON.parse(stopped.facts).development.task_id,h.taskId);assert.deepEqual(JSON.parse(stopped.options).map(o=>o.work),['review.issue']);
  // The label is added again: the labeling offers the waiting development to continue, and continuing resumes it.
  current=issue;
  const {queueWebhook}=await import('../../../../dist/review/queue.js'),{dispatchContext,applyDecision}=await import('../../../../dist/dispatch/store.js');
  // The Manager decides here (not the rule decider of the other tests), so the labeling waits for its decision.
  const {configureDispatch,ruleDecider}=await import('../../../../dist/dispatch/worker.js');configureDispatch(null);t.after(()=>configureDispatch(ruleDecider));
  queueWebhook(h.store,'101','issues',{action:'labeled',label:{name:'bot-develop'},issue,sender:{type:'User',login:'maintainer',id:7}},'relabel');
  const event=h.store.get("SELECT * FROM dispatch_events WHERE type='issue.labeled'"),context=dispatchContext(h.store,event);
  assert.deepEqual(context.continuations.map(c=>[c.task_id,c.status]),[[h.taskId,'waiting_permission']]);
  h.store.run("UPDATE dispatch_events SET state='dispatching',lease='l',attempts=1 WHERE id=?",event.id);
  applyDecision(h.store,h.store.get('SELECT * FROM dispatch_events WHERE id=?',event.id),{decision:'continue',option_ids:['continue:'+h.taskId],reason:'标签重新加上了，继续开发',model:'fixture',seen:context.continuations.map(c=>c.id)},'l');
  assert.deepEqual(Object.values(h.store.get('SELECT status,error_code FROM tasks WHERE id=?',h.taskId)),['queued',null]);
  assert.ok(h.store.all('SELECT content FROM task_logs WHERE task_id=?',h.taskId).some(row=>JSON.parse(row.content).type==='resumed'));
});

// #1100: an update arriving just before the first write used to fence the publication, delete its effects and return to the
// model without telling the Manager. The accepted result now publishes, and the update carries into the next round.
test('an update arriving at the first publication write does not fence an accepted review',async t=>{
  let inserted=false;
  const h=await emptyRepositoryFixture(t,{github(path,send){
    if(!path.endsWith('/pulls/1'))return false;
    const phase=h.store.get('SELECT phase FROM tasks WHERE id=?',h.taskId).phase;
    if(!inserted&&phase==='publish'){
      h.store.run('INSERT INTO review_updates(task_id,event_key,data) VALUES(?,?,?)',h.taskId,'before-publication',JSON.stringify({reason:'comment',actor:'alice',url:'https://github.invalid/c/1'}));
      inserted=true;
    }
    send(structuredClone(pull));return true;
  }});
  const input={object:pull,context:{mode:'review'},files:[],coverage:[]};
  h.store.run("UPDATE tasks SET kind='review.pr',phase='model',workspace_id='existing',generation=1,head_sha=?,input=? WHERE id=?",pull.head.sha,JSON.stringify(input),h.taskId);
  const task=await h.run();
  assert.equal(inserted,true);
  assert.equal(task.error_code,null,'the accepted result publishes; the update does not abort it');
  assert.equal(h.comments.length,1);
  assert.equal(h.store.get("SELECT count(*) n FROM github_effects WHERE task_id=? AND state<>'sent'",h.taskId).n,0);
  // The update was not covered by the published result, so the same task starts its next round with that update.
  const nextInput=JSON.parse(task.input);
  assert.deepEqual([task.attempt,nextInput.round],[2,2]);
  assert.deepEqual([nextInput.trigger.reason,nextInput.trigger.actor],['comment','alice']);
  assert.deepEqual(nextInput.merged_updates,[]);
  // Both the publication and the carry are on the timeline for read_publication_context.
  const decisions=h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='publication_decision' ORDER BY id",h.taskId).map(row=>JSON.parse(row.data));
  assert.deepEqual(decisions.slice(0,2).map(decision=>decision.decision),['publish','next_round']);
  assert.ok(decisions.slice(1).every(decision=>decision.decision==='next_round'));
  assert.deepEqual([decisions[1].carried_updates,decisions[1].pending_updates],[1,1]);
});

test('an update delivered after the result still starts the next round instead of being swallowed by the cursor',async t=>{
  let inserted=false,newer=0;
  const h=await emptyRepositoryFixture(t,{github(path,send){
    if(!path.endsWith('/pulls/1'))return false;
    const phase=h.store.get('SELECT phase FROM tasks WHERE id=?',h.taskId).phase;
    if(!inserted&&phase==='publish'){
      // A turn boundary delivers an update after this task's result was produced. The accepted result is nevertheless
      // reused (as in #1094): its coverage mark stays on the two updates it actually saw.
      h.store.run('INSERT INTO review_updates(task_id,event_key,data) VALUES(?,?,?)',h.taskId,'after-result',JSON.stringify({reason:'comment',actor:'alice',comment:{body:'Arrived after the result.'}}));
      newer=Number(h.store.get('SELECT max(id) m FROM review_updates').m);
      h.store.run('UPDATE tasks SET review_update_cursor=? WHERE id=?',newer,h.taskId);
      inserted=true;
    }
    send(structuredClone(pull));return true;
  }});
  for(const body of ['Covered first.','Covered second.'])h.store.run('INSERT INTO review_updates(task_id,event_key,data) VALUES(?,?,?)',h.taskId,'covered-'+body,JSON.stringify({reason:'comment',actor:'alice',comment:{body}}));
  const covered=Number(h.store.get('SELECT max(id) m FROM review_updates').m);
  const input={object:pull,context:{mode:'review'},files:[],coverage:[],heads:[pull.head.sha]};
  h.store.run("UPDATE tasks SET kind='review.pr',phase='model',workspace_id='existing',generation=1,head_sha=?,input=?,review_update_cursor=?,review_covered_update=?,review_seen_update=? WHERE id=?",
    pull.head.sha,JSON.stringify(input),covered,covered,covered,h.taskId);
  const task=await h.run();
  assert.equal(inserted,true);assert.equal(task.error_code,null);assert.equal(h.comments.length,1);
  const nextInput=JSON.parse(task.input);
  assert.deepEqual([task.attempt,nextInput.round],[2,2]);
  assert.deepEqual([nextInput.trigger.reason,nextInput.trigger.actor,nextInput.comment.body],['comment','alice','Arrived after the result.']);
  assert.deepEqual([task.review_covered_update,nextInput.round_update_cursor],[covered,newer]);
  const decisions=h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='publication_decision' ORDER BY id",h.taskId).map(row=>JSON.parse(row.data));
  assert.equal(decisions[0].decision,'publish');
  const carried=decisions.find(decision=>decision.decision==='next_round');
  assert.deepEqual([carried.carried_updates,carried.pending_updates,carried.pending_update_ids],[1,1,[newer]]);
});

test('a late push of a head the review already read is answered, with no false next-round audit',async t=>{
  let inserted=false;const head=pull.head.sha;
  const h=await emptyRepositoryFixture(t,{github(path,send){
    if(!path.endsWith('/pulls/1'))return false;
    const phase=h.store.get('SELECT phase FROM tasks WHERE id=?',h.taskId).phase;
    if(!inserted&&phase==='publish'){
      h.store.run('INSERT INTO review_updates(task_id,event_key,data) VALUES(?,?,?)',h.taskId,'late-read-head',JSON.stringify({reason:'pushed',before:head,after:head}));
      inserted=true;
    }
    send(structuredClone(pull));return true;
  }});
  // One accepted result already covered an earlier update. The late push is of the head that result read.
  h.store.run('INSERT INTO review_updates(task_id,event_key,data) VALUES(?,?,?)',h.taskId,'already-accepted',JSON.stringify({reason:'comment',actor:'alice',comment:{body:'Earlier update.'}}));
  const covered=Number(h.store.get('SELECT max(id) m FROM review_updates').m);
  const input={object:pull,context:{mode:'review'},files:[],coverage:[],heads:[head]};
  h.store.run("UPDATE tasks SET kind='review.pr',phase='model',workspace_id='existing',generation=1,head_sha=?,input=?,review_update_cursor=?,review_covered_update=?,review_seen_update=? WHERE id=?",
    head,JSON.stringify(input),covered,covered,covered,h.taskId);
  const task=await h.run();
  assert.equal(inserted,true);assert.equal(task.error_code,null);assert.equal(task.attempt,1);
  assert.equal(Number(JSON.parse(task.input).round||1),1,'an answered push does not start another round');
  // The publication decision is audited once; the answered push is not carried as a next round.
  const decisions=h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='publication_decision' ORDER BY id",h.taskId).map(row=>JSON.parse(row.data));
  assert.deepEqual(decisions.map(decision=>decision.decision),['publish']);
  const saved=h.store.get('SELECT review_update_cursor,review_covered_update FROM tasks WHERE id=?',h.taskId);
  assert.deepEqual(Object.values(saved),[Number(h.store.get('SELECT max(id) m FROM review_updates').m),Number(h.store.get('SELECT max(id) m FROM review_updates').m)]);
});

for(const change of ['closed','draft'])test(`a review that becomes ${change} before its first publication write stops without a write`,async t=>{
  let changed=false,writes=0;const object=structuredClone(pull);
  const h=await emptyRepositoryFixture(t,{github(path,send,res){
    if(res.req.method!=='GET')writes++;
    if(!path.endsWith('/pulls/1'))return false;
    if(!changed&&h.store.get('SELECT phase FROM tasks WHERE id=?',h.taskId).phase==='publish'){
      if(change==='closed')object.state='closed';else object.draft=true;
      changed=true;
    }
    send(structuredClone(object));return true;
  }});
  const input={object:pull,context:{mode:'review'},files:[],coverage:[]};
  h.store.run("UPDATE tasks SET kind='review.pr',phase='model',workspace_id='existing',generation=1,head_sha=?,input=? WHERE id=?",pull.head.sha,JSON.stringify(input),h.taskId);
  const task=await h.run();
  assert.equal(changed,true,'the object changed before the first publication write');
  assert.deepEqual([task.status,task.error_code],['cancelled','object_closed_or_draft']);
  assert.equal(writes,0,'a closed or draft object is not written to');
  assert.equal(h.comments.length,0);
});

test('different transient failures reset the consecutive count, and entering the cycle does not synchronize tasks',async t=>{
  let code=502;const h=await emptyRepositoryFixture(t,{github(path,send){if(path==='/user'){send({message:'Server Error'},code);return true;}}});
  for(let i=0;i<4;i++){h.due();await h.run();}
  code=503;h.due();let task=await h.run();assert.equal(task.retry_count,1);assert.equal(task.retry_cycle_started_at,null);
  for(let i=0;i<4;i++){h.due();task=await h.run();}
  const first=task.retry_cycle_started_at;
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('later','101','review.issue','queued','later')");
  let now=Date.now()+123456;t.mock.method(Date,'now',()=>now);
  for(let i=0;i<5;i++){h.store.run("UPDATE tasks SET next_run_at=0 WHERE id='later'");pinLegacyTaskConfiguration(h.store);h.engine.tick();await Promise.all(h.engine.active.values());}
  const later=h.store.get("SELECT * FROM tasks WHERE id='later'");assert.equal(later.next_run_at,later.retry_cycle_started_at+cycleMs);assert.ok(later.retry_cycle_started_at-first>=123456);
  // A new transient cause inside the cycle keeps the task in that cycle instead of resetting to five fast retries.
  code=502;now=task.next_run_at;pinLegacyTaskConfiguration(h.store);h.engine.tick();await Promise.all(h.engine.active.values());task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId);
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
  const {queueWebhook}=await import('../../../../dist/review/queue.js');
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

// #815: only a development that started on the label needs it to stay; one started on a maintainer's request does not.
test('a development started on a maintainer\'s request does not stop when the Issue has no development label', async t => {
  const object = { ...structuredClone(issue), labels: [] };
  const h = await emptyRepositoryFixture(t, { github(path, send) { if (path.endsWith('/issues/1')) { send(object); return true; } } }); h.setBranch('ready');
  h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1,enabled=1 WHERE repository_id='101'");
  const input = { object: issue, object_hash: sha(JSON.stringify([issue.title, issue.body])), context: { mode: 'development' }, files: [] };
  h.store.run("UPDATE tasks SET kind='development.issue',status='retry_wait',phase='model',input=?,head_sha=?,workspace_id='old',generation=1,next_run_at=? WHERE id=?", JSON.stringify(input), pull.head.sha, Date.now() - 1, h.taskId);
  h.store.run("INSERT INTO task_development_basis VALUES(?,?,?,?)", h.taskId, 'maintainer_request', JSON.stringify({ kind: 'maintainer_request', comment_id: '7', author: 'maria', permission: 'triage', url: null, excerpt: 'Please fix.' }), new Date().toISOString());
  const task = await h.run();
  assert.notEqual(task.error_code, 'development_not_approved', JSON.stringify([task.status, task.error_code]));
  assert.notEqual(task.status, 'waiting_permission');
});
