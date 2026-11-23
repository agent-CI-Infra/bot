import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../../../dist/storage/database.js';
import {Publisher} from '../../../../dist/github/publisher.js';
import {TaskError,operationId} from '../../../../dist/agent/common.js';
import {publicationContext,publicationDecision} from '../../../../dist/tasks/publication.js';
import {traceSource} from '../../../../dist/tasks/trace.js';
import {TaskRecords} from '../../../../dist/tasks/service.js';
const sha=c=>c.repeat(40);
function fixture(t){
 const s=new Store(':memory:',Buffer.alloc(32,3));t.after(()=>s.close());
 s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/repo','1','a')");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('t','r','development.issue','running','fixture','{}',1)");
 const branch='bot/issue-1-t';s.run("INSERT INTO bot_branches VALUES('r',?,'t')",branch);
 const task=s.get("SELECT * FROM tasks WHERE id='t'"),writes=[];let head=null,tree,commits=0,fail=false;
 const github={defaultBranch:'main',path:p=>p,authorEmail:()=> 'fixture@example.com',ref:async()=>head?{object:{sha:head}}:null,
  request:async(method,path,body)=>{writes.push({method,path,body});if(path==='/git/trees'){tree=body.tree[0]?.sha??sha('c');return {sha:tree};}if(path==='/git/commits')return {sha:sha(String(++commits)),tree:{sha:body.tree}};
   if(path.startsWith('/git/refs')){head=body.sha;if(fail){fail=false;throw new TaskError('github_response_unknown','retry_wait','Lost response');}return {object:{sha:head}};}throw Error(path);}};
 // Tree responses are controlled identities; publication logic, persistence and retry dispatch are real.
 const candidate=(tree,expected=null)=>({files:[{path:'x',mode:'100644',sha:tree}],tree_sha:tree,branch,owner_task_id:'t',base_sha:sha('a'),expected_sha:expected,publication_key:'qa-revision:2',date:'2026-11-12T00:00:00Z',summary:'fixture',change_title:'fixture',validation:{command:'true',exit_code:0}});
 const save=c=>s.run("INSERT INTO development_candidates VALUES('t',?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",JSON.stringify(c));
 return {s,task,writes,github,candidate,save,publisher:new Publisher(s,github,task,async()=>{}),head:v=>{head=v;},loseResponse:()=>{fail=true;}};
}
test('new candidate with the same QA key updates the branch; exact retries reuse one confirmed operation',async t=>{
 const f=fixture(t),first=f.candidate(sha('c'));f.save(first);const old=await f.publisher.branch(first);
 const next=f.candidate(sha('d'),old);f.save(next);const target=await f.publisher.branch(next);assert.notEqual(target,old);
 assert.equal(f.writes.filter(w=>w.method==='PATCH').length,1);assert.equal(next.remote_sha,target);assert.equal(next.branch_confirmed.sha,target);
 assert.equal(await f.publisher.branch(next),target);assert.equal(f.writes.filter(w=>w.path==='/git/commits').length,2);
 const ctx=await publicationContext(f.s,f.task,{},async()=>f.github);assert.equal(ctx.remote.observed_sha,target);assert.equal(ctx.branch_effects.length,2);
 assert.ok(ctx.attempts.some(x=>x.event==='commit_created'));assert.ok(ctx.attempts.some(x=>x.event==='branch_confirmed'));
 assert.equal(traceSource(f.s,'t',ctx.branch_effects[0].ref).data.state,'sent');
});
test('a lost update response retains created commit without claiming publication; retry confirms remote and sends no duplicate update',async t=>{
 const f=fixture(t),c=f.candidate(sha('c'));f.save(c);f.loseResponse();await assert.rejects(f.publisher.branch(c),{code:'github_response_unknown'});
 let saved=JSON.parse(f.s.get("SELECT data FROM development_candidates WHERE task_id='t'").data);assert.ok(saved.created_commit_sha);assert.equal(saved.remote_sha,undefined);assert.equal(saved.branch_confirmed,undefined);
 let ctx=await publicationContext(f.s,f.task);assert.equal(ctx.branch_effects[0].state,'unknown');assert.equal(ctx.remote.availability,'not_requested');
 const target=await f.publisher.branch(saved);assert.equal(saved.branch_confirmed.sha,target);assert.equal(f.writes.filter(w=>w.path==='/git/commits').length,1);assert.equal(f.writes.filter(w=>w.path.startsWith('/git/refs')).length,1);
});
test('legacy poisoned remote_sha and receipt do not suppress a new candidate update',async t=>{
 const f=fixture(t),old=sha('8'),c=f.candidate(sha('c'),old);c.remote_sha=sha('9');f.head(old);f.save(c);
 f.s.run("INSERT INTO github_effects VALUES(?, 't','branch',?,'sent',?,'legacy')",operationId('t:branch:qa-revision:2'),JSON.stringify({sha:old}),JSON.stringify({object:{sha:old}}));
 const result=await f.publisher.branch(c);assert.notEqual(result,old);assert.equal(f.writes.filter(w=>w.method==='PATCH').length,1);
});
test('external branch change provides facts and returns control instead of superseding; mismatched receipts never count as success',async t=>{
 const f=fixture(t),c=f.candidate(sha('c'));f.save(c);await f.publisher.branch(c);f.head(sha('f'));
 await assert.rejects(f.publisher.branch(c),{code:'branch_head_changed',state:'needs_replan'});assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,'running');
 const ctx=await publicationContext(f.s,f.task,{},async()=>f.github);assert.equal(ctx.remote.observed_sha,sha('f'));assert.ok(ctx.remote.ref);assert.equal(ctx.candidate.branch_confirmation.sha,c.created_commit_sha);
 await assert.rejects(f.publisher.effect('mismatch','branch',{sha:'new'},async()=>({}),async()=>null,true).then(async()=>f.publisher.effect('mismatch','branch',{sha:'other'},async()=>assert.fail(),async()=>null,true)),{code:'publication_receipt_mismatch'});
});

test('publish, defer and next-round decisions stay auditable with coverage, carried updates and safe paging',async t=>{
 const f=fixture(t);
 f.s.run("UPDATE tasks SET kind='review.issue' WHERE id='t'");
 const add=data=>Number(f.s.run("INSERT INTO review_updates(task_id,event_key,data) VALUES('t',?,?)",'fixture:'+Math.random(),JSON.stringify(data)).lastInsertRowid);
 const covered=add({reason:'comment',actor:'maintainer',url:'https://github.invalid/1'}),carriedA=add({reason:'comment',actor:'maintainer',url:'https://github.invalid/2'}),carriedB=add({reason:'pushed',after:sha('e')});
 f.s.run('UPDATE tasks SET review_update_cursor=? WHERE id=?',covered,'t');
 const task=f.s.get("SELECT * FROM tasks WHERE id='t'");
 publicationDecision(f.s,task,'publish',{reason:'accepted_result_publishes_by_default',covered_through:covered,carried:[carriedA,carriedB],reasons:['comment','pushed']});
 publicationDecision(f.s,task,'defer',{reason:'Manager wants a design answer first',manager_action:'wait',covered_through:covered,pending_update_ids:[carriedA,carriedB]});
 publicationDecision(f.s,task,'next_round',{reason:'published_result_has_uncovered_updates',round:2,covered_through:covered,pending_update_ids:[carriedA,carriedB]});
 const history=f.s.all("SELECT id,data FROM task_history WHERE task_id='t' AND type='publication_decision' ORDER BY id").map(row=>({id:Number(row.id),...JSON.parse(row.data)}));
 assert.deepEqual(history.map(value=>[value.decision,value.covered_through,value.carried,value.carried_updates]),[
  ['publish',covered,[carriedA,carriedB],2],['defer',covered,[carriedA,carriedB],2],['next_round',covered,[carriedA,carriedB],2]]);
 assert.deepEqual([history[1].manager_action,history[1].reason,history[2].round],['wait','Manager wants a design answer first',2]);
 assert.ok(history.every(value=>value.at));
 // publicationContext used to return only publication_state attempts; decisions make all three choices visible without changing attempts.
 const context=await publicationContext(f.s,task);
 assert.deepEqual(context.attempts,[]);
 assert.deepEqual(context.decisions.map(value=>value.decision),['publish','defer','next_round']);
 assert.equal(context.latest_decision.decision,'next_round');
 assert.deepEqual(context.decisions.map(value=>value.ref),history.map(value=>'task_history:'+value.id));
 // read_task_history exposes the same decisions on the ordinary task timeline.
 const timeline=new TaskRecords(f.s).tool('t','read_task_history',{limit:20});
 assert.deepEqual(timeline.observations.filter(value=>value.type==='publication_decision').map(value=>value.data.decision),['publish','defer','next_round']);
 // Decisions keep their own cursor: `before` pages attempts only and never drops decisions from the page.
 const older=await publicationContext(f.s,task,{decisions_before:history[1].id});
 assert.deepEqual(older.decisions.map(value=>value.decision),['publish']);
 assert.equal(older.latest_decision.decision,'publish');
 assert.deepEqual((await publicationContext(f.s,task,{before:history[1].id})).decisions.map(value=>value.decision),['publish','defer','next_round']);
 assert.equal((await publicationContext(f.s,task,{before:0})).error,'invalid_publication_cursor');
 assert.equal((await publicationContext(f.s,task,{decisions_before:0})).error,'invalid_decisions_cursor');
});

test('defer decisions page through their own returned cursor and truncation marker without publication attempts',async t=>{
 const f=fixture(t);
 f.s.run("UPDATE tasks SET kind='review.issue' WHERE id='t'");
 const task=f.s.get("SELECT * FROM tasks WHERE id='t'"),ids=[];
 // The stuck-review shape: many defers and not a single publication attempt.
 for(let n=1;n<=25;n++)ids.push(Number(String(publicationDecision(f.s,task,'defer',{reason:'manager deferred '+n,manager_action:'wait'})).split(':')[1]));
 const first=await publicationContext(f.s,task);
 assert.deepEqual(first.attempts,[]);
 assert.equal(first.decisions.length,20);
 assert.equal(first.decisions_truncated,true);
 assert.equal(first.latest_decision.reason,'manager deferred 25');
 // The returned cursor reaches the older decisions; the two pages together are the whole history, without repeats.
 const second=await publicationContext(f.s,task,{decisions_before:first.decisions_next_before});
 assert.deepEqual(second.decisions.map(value=>Number(value.ref.split(':')[1])),ids.slice(0,5));
 assert.equal(second.decisions_truncated,false);
 assert.equal(second.decisions_next_before,null);
 assert.deepEqual([...second.decisions,...first.decisions].map(value=>Number(value.ref.split(':')[1])),ids);
});

test('a defer whose coverage cannot be read records unknown coverage instead of a real zero',async t=>{
 const f=fixture(t);
 f.s.run("UPDATE tasks SET kind='review.issue' WHERE id='t'");
 f.s.run("INSERT INTO review_updates(task_id,event_key,data) VALUES('t','fixture:broken','{not json')");
 const task=f.s.get("SELECT * FROM tasks WHERE id='t'");
 publicationDecision(f.s,task,'defer',{reason:'Manager is unsure',manager_action:'wait'});
 const [row]=f.s.all("SELECT data FROM task_history WHERE task_id='t' AND type='publication_decision'").map(value=>JSON.parse(value.data));
 assert.deepEqual([row.coverage,row.covered_through,row.pending_updates,row.carried_updates],['unavailable',null,null,null]);
 // Explicit facts from the caller are still recorded, even when the task's own facts cannot be read.
 publicationDecision(f.s,task,'defer',{reason:'Manager has facts',manager_action:'continue',covered_through:4,pending_update_ids:[7,8]});
 const [,explicit]=f.s.all("SELECT data FROM task_history WHERE task_id='t' AND type='publication_decision' ORDER BY id").map(value=>JSON.parse(value.data));
 assert.deepEqual([explicit.coverage,explicit.covered_through,explicit.pending_updates,explicit.carried_updates],['unavailable',4,2,2]);
});
