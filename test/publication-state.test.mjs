import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {Publisher} from '../dist/github/publisher.js';
import {TaskError,operationId} from '../dist/agent/common.js';
import {publicationContext} from '../dist/tasks/publication.js';
import {traceSource} from '../dist/tasks/trace.js';
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
