import {traceEvent} from '../dist/tasks/trace.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {attachChild} from '../dist/tasks/children.js';
import {nominationSource} from '../dist/roles/nomination.js';
import {SubmissionError} from '../dist/roles/submission-error.js';
import {createTaskToolDispatcher} from '../dist/roles/task-tools.js';
import {Redactor,TaskError} from '../dist/agent/common.js';
function fixture(t){
 const s=new Store(':memory:',Buffer.alloc(32,8));t.after(()=>s.close());
 s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");s.run("INSERT INTO policies(repository_id,enabled) VALUES('r',1)");
 for(const id of ['parent','child','stranger'])s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,'r','task.development','running',?,'{}')",id,id);
 attachChild(s,'parent','child');const records=new TaskRecords(s);for(const id of ['parent','child'])records.contract(id,{goal:id,scope:[id],criteria:['all required behavior'],endpoint:'reviewable_pull_request'});
 const revision=records.get('child').revision;s.run("UPDATE tasks SET status='pr_opened',result=? WHERE id='child'",JSON.stringify({summary:'child complete',change_title:'Child capability'}));s.run("UPDATE task_records SET candidate=?,acceptance=? WHERE task_id='child'",JSON.stringify({id:'child-candidate',revision,artifacts:[{kind:'code',reference:'task:child:candidate',version:'c'.repeat(40)}]}),JSON.stringify({outcome:'pass',revision,candidate_id:'child-candidate'}));
 return {s,records,task:s.get("SELECT * FROM tasks WHERE id='parent'")};
}
test('accepted child results are reusable without fabricating a parent Dev run or accepting the parent',t=>{
 const f=fixture(t),source=nominationSource(f.s,f.task,'task:child');assert.equal(source.own,false);assert.equal(source.result.summary,'child complete');assert.equal(f.records.get('parent').acceptance,null);assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE task_id='parent' AND role='dev'").n,0);
 f.s.run("UPDATE task_records SET revision=revision+1 WHERE task_id='child'");
 assert.throws(()=>nominationSource(f.s,f.task,'task:child'),e=>e instanceof SubmissionError&&e.clues.reason==='child_contract_revision_mismatch');
});
test('rejections distinguish record type, role, stale results and inaccessible refs without leaking another task',t=>{
 const f=fixture(t);const record=(task,type,data)=>traceEvent(f.s,task,type,data);
 const version=record('child','version_reference',{purpose:'workspace_head'});
 assert.throws(()=>nominationSource(f.s,f.task,version),e=>e.clues.reason==='record_type_mismatch'&&e.clues.observed.record_type==='version_reference');
 const review=record('parent','role_result',{role:'reviewer'});assert.throws(()=>nominationSource(f.s,f.task,review),e=>e.clues.reason==='role_mismatch');
 const secret=record('stranger','role_result',{role:'dev',secret:'not accessible'});assert.throws(()=>nominationSource(f.s,f.task,secret),e=>e.clues.reason==='reference_not_found_or_inaccessible'&&!JSON.stringify(e.clues).includes('stranger'));
 const revision=f.records.get('parent').revision;const a=record('parent','role_result',{role:'dev',contract_revision:revision,result:{summary:'older'}}),b=record('parent','role_result',{role:'dev',contract_revision:revision,result:{summary:'latest'}});
 assert.throws(()=>nominationSource(f.s,f.task,a),e=>e.code==='role_nomination_stale'&&e.clues.available_result_refs.includes(b));assert.equal(nominationSource(f.s,f.task,b).result.summary,'latest');
 assert.throws(()=>nominationSource(f.s,f.task,'not-a-ref'),e=>e.clues.reason==='invalid_reference_format');
});
for(const transport of ['mailbox','http'])test(`${transport}: repeated bad submissions retain clues and report at 3/6 across dispatcher recovery; then child nomination succeeds`,async t=>{
 const f=fixture(t),redactor=new Redactor();let cancelled=false;
 const spec={store:f.s,task:f.task,redactor,guard:async()=>{if(cancelled)throw new TaskError('task_claim_revoked','cancelled');},tools:[{type:'function',function:{name:'nominate_delivery'}}],finish:{name:'nominate_delivery',validate:args=>nominationSource(f.s,f.task,args.result_ref).result}};
 let dispatcher=createTaskToolDispatcher(spec,{maxRepairs:2});
 const call=async ref=>{
  if(transport==='mailbox')return (await dispatcher.call(dispatcher.token,{id:'call',name:'nominate_delivery',arguments:{result_ref:ref},transport})).observation;
  const rpc=await dispatcher.rpc(dispatcher.token,{id:'rpc',method:'tools/call',params:{name:'nominate_delivery',arguments:{result_ref:ref}}});return JSON.parse(rpc.result.content[0].text);
 };
 for(let i=1;i<=7;i++){
  const result=await call('task_history:999999');assert.equal(result.code,'role_nomination_invalid');assert.equal(result.reason,'reference_not_found_or_inaccessible');assert.equal(result.attempts,i);assert.equal(!!result.manager_notice,i===3||i===6);assert.equal(dispatcher.submitted,false);
  if(i===3){await dispatcher.close();dispatcher=createTaskToolDispatcher(spec,{maxRepairs:2});}
 }
 assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='submission_retry_report'").n,2);assert.equal(f.records.context('parent').submission_reports.length,2);
 const ok=await call('task:child');assert.equal(ok.submitted,true);assert.equal(dispatcher.result.summary,'child complete');await dispatcher.close();
 dispatcher=createTaskToolDispatcher(spec);cancelled=true;await assert.rejects(call('bad'),{code:'task_claim_revoked'});await dispatcher.close();
});
for(const kind of ['review.issue','workflow.issue'])test(`${kind}: accepted development child must satisfy the parent result contract`,async t=>{
 const {validateNominationResult}=await import('../dist/roles/nomination.js');const f=fixture(t);f.task.kind=kind;
 const source=nominationSource(f.s,f.task,'task:child');
 const spec={finish:{name:'finish_review',validate:value=>{if(!Array.isArray(value?.findings))throw new TaskError('model_review_invalid','retry_wait','findings required');return value;}}};
 await assert.rejects(validateNominationResult(spec,source.result),e=>e instanceof SubmissionError&&e.clues.reason==='parent_result_contract_mismatch'&&e.clues.validation_code==='model_review_invalid');
 assert.equal(f.records.get('parent').acceptance,null);
 const compatible={summary:'Reviewed the parent goal',findings:[]};assert.deepEqual(await validateNominationResult(spec,compatible),compatible);
});
test('dispatch submission feedback retains evidence without a fabricated zero-count Manager notice',async t=>{
 const {submissionFeedback}=await import('../dist/roles/submission-feedback.js');const {recordEvent}=await import('../dist/dispatch/store.js');const f=fixture(t);
 recordEvent(f.s,{repositoryId:'r',key:'feedback-event',type:'probe',source:'fixture',summary:'Probe',facts:{},options:[]});
 const event=f.s.get('SELECT id FROM dispatch_events'),spec={store:f.s,task:{id:'dispatch:'+event.id+':1',repository_id:'r'},redactor:new Redactor()};
 for(let i=0;i<4;i++){const result=submissionFeedback(spec,new SubmissionError('role_nomination_invalid',{reason:'invalid_reference'}));assert.ok(result.evidence_ref);assert.equal(result.manager_notice,undefined);assert.equal(result.attempts,undefined);}
 assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='submission_retry_report'").n,0);
});
