import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskRecords, validateVerdict } from '../dist/tasks/service.js';
import { playbooks } from '../dist/tasks/playbooks.js';

function fixture(t,path=':memory:',key=randomBytes(32)) {
 const store=new Store(path,key);t.after(()=>{try{store.close();}catch{}});
 store.run("INSERT OR IGNORE INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
 store.run("INSERT OR IGNORE INTO repositories VALUES('r','fixture/project','o','a')");
 const records=new TaskRecords(store);
 const create=(id,kind='task.request')=>store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,'r',?,'queued','A real bounded goal')",id,kind);
 return {store,records,create,key};
}
const contract={goal:'Deliver a report',scope:['report'],criteria:['contains verified observations'],endpoint:'report',source:{type:'request'},completeness:'explicit'};
const pass={outcome:'pass',reason:'Observed requested result',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
const submit=(records,id,version='v1')=>records.submit(id,[{kind:'report',reference:'report.md',version,content:'observations'}],[{source:'command',version,verified:true,result:{exit_code:0}}],{summary:'executor claim'});

test('all task kinds acquire structured records and real transition history, without invented legacy acceptance',t=>{
 const {store,records,create}=fixture(t);
 for(const [i,kind] of ['review.issue','review.pr','development.issue','workflow.issue','release.observe','release.notes','actions.failures','gate.onboarding','task.request','custom.analysis'].entries()){
  const id=String(i);create(id,kind);const initial=records.get(id);assert.equal(initial.contract.completeness,'unspecified');assert.equal(initial.acceptance,null);
  store.run("UPDATE tasks SET status='running',phase='model',attempt=2,error_code='prior_fault' WHERE id=?",id);
  assert.equal(records.get(id).progress.attempt,2);assert.equal(store.get("SELECT count(*) n FROM task_history WHERE task_id=?",id).n,2);
  assert.equal(records.get(id).progress.waiting_reason,null);
  store.run("UPDATE tasks SET status='retry_wait' WHERE id=?",id);assert.equal(records.get(id).progress.waiting_reason,'prior_fault');
 }
});
test('contract revision invalidates previous candidate; no old verdict can complete a new revision or artifact',t=>{
 const {records,create}=fixture(t);create('a');records.contract('a',contract);let c=submit(records,'a');
 records.progress('a',['Old goal-specific claim'],'Old next action');
 records.contract('a',{...contract,criteria:['new requirement']},2);assert.deepEqual(records.get('a').progress.completed,[]);assert.equal(records.get('a').progress.next_action,null);
 assert.throws(()=>records.decide('a',c.id,2,pass),/stale_acceptance/);
 c=submit(records,'a');const replacement=submit(records,'a','v2');
 assert.throws(()=>records.decide('a',c.id,c.revision,pass),/stale_acceptance/);
 assert.equal(records.decide('a',replacement.id,replacement.revision,pass).outcome,'pass');
 assert.throws(()=>records.contract('a',contract,1),/task_revision_changed/);
});
test('single, multiple and zero playbooks are advisory, versioned, and cannot mutate goals',t=>{
 const {records,create}=fixture(t);create('a');const original=records.get('a').contract;
 assert.equal(records.tool('a','read_playbook',{}).length,playbooks.length);
 for(const count of [1,3,0]){
  for(const p of playbooks.slice(0,count))records.tool('a','read_playbook',{id:p.id});
  const selected=playbooks.slice(0,count).map(p=>({id:p.id,version:p.version,purpose:'Relevant to current work'}));
  assert.deepEqual(records.tool('a','select_playbooks',{selections:selected}),{ok:true});assert.equal(records.get('a').selections.length,count);
 }
 assert.equal(records.tool('a','select_playbooks',{selections:[{id:'research',version:'old',purpose:'test'}]}).error,'invalid_playbook_selection');
 assert.deepEqual(records.get('a').contract,original);
});
test('all five decisions map to explicit task states, for code and non-code artifacts',t=>{
 const {store,records,create}=fixture(t);
 for(const [i,outcome] of ['pass','return','insufficient_evidence','needs_human'].entries()){
  const id=String(i);create(id);records.contract(id,contract);const c=submit(records,id);
  const verdict={...pass,outcome,...(outcome==='pass'?{}:{gaps:['A specific missing observation'],core_complete:false})};
  records.decide(id,c.id,c.revision,verdict);
  assert.equal(store.get('SELECT status FROM tasks WHERE id=?',id).status,outcome==='pass'?'completed':outcome==='needs_human'?'needs_replan':'queued');
 }
});
const residual={key:'accessibility',description:'Missing accessible label in optional export panel',evidence:'Browser inspection at export button',impact:'Keyboard discoverability',nonblocking_reason:'Core requested flow is complete; export polish is independent',goal:'Label the export button',criteria:['Accessible name exposed in browser']};
test('pass with issues retains observations without scheduling work, and replay is idempotent',t=>{
 const {store,records,create}=fixture(t);create('a');records.contract('a',contract);const c=submit(records,'a');
 const verdict={...pass,outcome:'pass_with_issues',residuals:[residual,{...residual,key:'docs',goal:'Document export'}]};
 const result=records.decide('a',c.id,c.revision,verdict);assert.deepEqual(result.followups,[]);
 assert.equal(store.get("SELECT status FROM tasks WHERE id='a'").status,'completed');
 assert.deepEqual(records.get('a').acceptance.residuals,verdict.residuals);
 assert.equal(store.get('SELECT count(*) n FROM task_followups').n,0);
 assert.deepEqual(records.decide('a',c.id,c.revision,verdict),result);assert.equal(store.get('SELECT count(*) n FROM tasks').n,1);
});
test('a history fault rolls back completion and observations; retry persists both exactly once',t=>{
 const {store,records,create}=fixture(t);create('a');const c=submit(records,'a');
 store.db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON task_history WHEN NEW.type='acceptance' BEGIN SELECT RAISE(ABORT,'injected crash'); END");
 assert.throws(()=>records.decide('a',c.id,c.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]}),/injected crash/);
 assert.equal(store.get('SELECT count(*) n FROM tasks').n,1);assert.equal(records.get('a').acceptance,null);
 assert.equal(store.get("SELECT status FROM tasks WHERE id='a'").status,'queued');
 store.db.exec('DROP TRIGGER inject_failure');records.decide('a',c.id,c.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]});assert.equal(store.get('SELECT count(*) n FROM tasks').n,1);
 assert.deepEqual(records.get('a').acceptance.residuals,[residual]);
 assert.equal(store.get("SELECT count(*) n FROM task_history WHERE type='acceptance'").n,1);
});
test('core gaps, missing mandatory evidence and unacceptable risk cannot pass with issues',()=>{
 for(const field of ['core_complete','required_evidence_complete','acceptable_risk'])assert.throws(()=>validateVerdict({...pass,outcome:'pass_with_issues',residuals:[residual],[field]:false}),/core_incomplete/);
 assert.throws(()=>validateVerdict({...pass,outcome:'pass_with_issues'}),/residual_mismatch/);
 assert.throws(()=>validateVerdict({...pass,outcome:'return',gaps:[]}),/gap_required/);
});
test('no-progress and bounded remediation stop explicitly while unrelated tasks remain runnable',t=>{
 const {store,records,create}=fixture(t);create('a');create('other');
 const verdict={...pass,outcome:'return',core_complete:false,gaps:['Requirement missing']};
 for(let i=0;i<3;i++){const c=submit(records,'a','v'+i);const a=records.decide('a',c.id,c.revision,verdict);assert.equal(a.exhausted,i===2);}
 assert.equal(store.get("SELECT error_code FROM tasks WHERE id='a'").error_code,'acceptance_no_progress');assert.equal(store.get("SELECT status FROM tasks WHERE id='other'").status,'queued');
});
test('repeated identical rejected candidate has a finite exit',t=>{
 const {store,records,create}=fixture(t);create('a');const c=submit(records,'a');const v={...pass,outcome:'insufficient_evidence',required_evidence_complete:false,gaps:['missing raw output']};
 records.decide('a',c.id,c.revision,v);assert.equal(records.decide('a',c.id,c.revision,v).exhausted,true);assert.equal(store.get("SELECT status FROM tasks WHERE id='a'").status,'needs_replan');
});
test('restart persists task contract, candidate, project facts, progress, acceptance and residual identity',t=>{
 const dir=mkdtempSync(join(tmpdir(),'bot-task-record-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'state.sqlite'),first=fixture(t,path),{records,create,key}=first;create('a');records.contract('a',contract);
 records.progress('a',['Read actual code'],'Verify browser');records.setProject('r',[{source:'repository:abc',fact:'Browser tests run with npm run test:e2e'}],0);
 const c=submit(records,'a');const accepted=records.decide('a',c.id,c.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]});first.store.close();
 const second=fixture(t,path,key);const restored=second.records.get('a');assert.equal(restored.acceptance.candidate_id,c.id);assert.deepEqual(restored.acceptance.followups,accepted.followups);assert.equal(restored.project.context.revision,1);assert.deepEqual(restored.progress.completed,['Read actual code']);
 assert.deepEqual(restored.acceptance.residuals,[residual]);
 second.records.decide('a',c.id,c.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]});assert.equal(second.store.get('SELECT count(*) n FROM tasks').n,1);
});
test('cancellation fences late acceptance without losing history',t=>{
 const {store,records,create}=fixture(t);create('a');const c=submit(records,'a');store.run("UPDATE tasks SET status='cancelled' WHERE id='a'");assert.throws(()=>records.decide('a',c.id,c.revision,pass),/task_cancelled/);
});

test('late decisions with an obsolete execution claim cannot complete a reclaimed task or create residuals',t=>{
 const {store,records,create}=fixture(t);create('a');const c=submit(records,'a');
 store.run("UPDATE tasks SET status='running',claim_token='new-owner' WHERE id='a'");store.run("INSERT INTO task_claims VALUES('a','r','new-owner','now')");
 assert.throws(()=>records.decide('a',c.id,c.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]},'completed',true,'old-owner'),{code:'task_claim_revoked'});
 assert.equal(store.get('SELECT count(*) n FROM task_followups').n,0);assert.equal(records.get('a').acceptance,null);
});
test('a new verdict on the same candidate can pass after missing evidence is independently recovered',t=>{
 const {records,create}=fixture(t);create('a');const c=submit(records,'a');
 records.decide('a',c.id,c.revision,{...pass,outcome:'insufficient_evidence',required_evidence_complete:false,gaps:['Read the actual artifact']});
 assert.equal(records.decide('a',c.id,c.revision,pass).outcome,'pass');assert.equal(records.get('a').progress.status,'completed');
 assert.throws(()=>submit(records,'a','different-delivery'),/task_already_delivered/);
});

test('large evidence stays addressable by digest and cannot read another task’s observations',async t=>{
 const {observation,readEvidence}=await import('../dist/tasks/evidence.js');
 const {store,records,create}=fixture(t);create('a');create('b');
 const raw=JSON.stringify({execution:'one',version:'tree-one',result:{exit_code:0,output:'meaningful observation '.repeat(2000)}});
 records.history('a','execution_evidence',JSON.parse(raw));const row=store.get("SELECT id,data FROM task_history WHERE task_id='a' AND type='execution_evidence'");
 const e=observation('task_history:'+row.id,'tree-one',row.data);assert.ok(JSON.stringify(e).length<6000);
 const c={id:'c',revision:1,artifacts:[],evidence:[e],claims:{},created_at:'now'};
 const historical=readEvidence(store,'a',{...c,evidence:[]},{source:e.source});assert.equal(historical.historical,true);assert.equal(historical.version,'tree-one');
 const page=readEvidence(store,'a',c,{source:e.source,offset:0,length:8000});assert.equal(page.chunk,row.data.slice(0,8000));assert.equal(page.total,row.data.length);
 assert.equal(readEvidence(store,'b',c,{source:e.source}).error,'raw_evidence_unavailable');
 store.run('UPDATE task_history SET data=? WHERE id=?',JSON.stringify({tampered:true}),row.id);
 assert.equal(readEvidence(store,'a',c,{source:e.source}).error,'evidence_digest_changed');
});

test('legacy related draft artifacts remain readable without peer approval or cross-family access',async t=>{
 const {relatedDeliveries,readRelatedArtifact}=await import('../dist/tasks/related.js');
 const {Workspace}=await import('../dist/agent/workspace.js');const {Redactor}=await import('../dist/agent/common.js');
 const {store,records,create}=fixture(t);create('root');const parent=submit(records,'root');
 records.decide('root',parent.id,parent.revision,pass);
 // Existing installations may already have related work created under the earlier policy.
 const [first,peer,second]=['first','peer','reader'];
 for(const id of [first,peer,second]){
  create(id);store.run("UPDATE tasks SET source_task_id='root' WHERE id=?",id);
  store.run("INSERT INTO task_followups VALUES('root',?,?,?)",parent.id,id,id);
 }
 store.run("UPDATE tasks SET workspace_id=?,generation=1,status='retry_wait',phase='acceptance' WHERE id=?",'1'.repeat(48),first);
 records.submit(first,[{kind:'files',reference:'draft-report',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40),files:[{path:'report.md',sha:'d'.repeat(40)}]}}],[],{summary:'Submitted, not yet accepted'});
 store.run("UPDATE tasks SET workspace_id=?,generation=1,status='retry_wait',phase='acceptance' WHERE id=?",'3'.repeat(48),peer);
 const same=records.get(first).candidate;const peerCandidate=records.submit(peer,same.artifacts,[],same.claims);assert.equal(peerCandidate.id,same.id);
 store.run("UPDATE tasks SET workspace_id=?,generation=2,status='running' WHERE id=?",'2'.repeat(48),second);
 const task=store.get('SELECT * FROM tasks WHERE id=?',second),source=relatedDeliveries(store,task).find(d=>d.row.id===first);
 assert.equal(source.description.relationship,'submitted_sibling');assert.equal(source.description.accepted,false);assert.equal(source.description.acceptance_outcome,null);
 const calls=[],manager={call:async(_m,_p,body)=>{calls.push(body);return {ok:true,result:{content:'Observed draft',version:'c'.repeat(40)}};}};
 const workspace=new Workspace(store,manager,task,new Redactor(),async()=>{},()=>{});
 const result=await readRelatedArtifact(store,task,workspace,{task_id:first,path:'report.md'});
 assert.equal(result.content,'Observed draft');assert.equal(result.candidate_id,source.candidate.id);assert.equal(result.blob_sha,'d'.repeat(40));
 assert.equal(calls[0].generation,2);assert.equal(calls[0].request.workspace_id,'1'.repeat(48));assert.equal(calls[0].request.sha,'c'.repeat(40));
 assert.equal(store.get('SELECT task_id FROM task_tools').task_id,second);
 const again=await readRelatedArtifact(store,task,workspace,{task_id:peer,path:'report.md'});assert.equal(again.candidate_id,result.candidate_id);assert.equal(calls.length,2);assert.equal(store.get('SELECT count(*) n FROM task_tools').n,2);
 assert.equal((await readRelatedArtifact(store,task,workspace,{task_id:'unrelated',path:'report.md'})).error,'related_delivery_not_available');
 assert.equal(store.get('SELECT status FROM tasks WHERE id=?',first).status,'retry_wait');assert.equal(records.get(second).acceptance,null);
 assert.equal(store.get('SELECT count(*) n FROM tasks').n,4);
});

test('an existing residual task can complete with observations without extending its chain',t=>{
 const {store,records,create}=fixture(t);create('root');const parent=submit(records,'root');records.decide('root',parent.id,parent.revision,pass);
 create('legacy');store.run("UPDATE tasks SET source_task_id='root',input=? WHERE id='legacy'",JSON.stringify({parent_task:'root',residual}));
 store.run("INSERT INTO task_followups VALUES('root',?,'old-residual','legacy')",parent.id);
 const candidate=submit(records,'legacy');
 const verdict={...pass,outcome:'pass_with_issues',residuals:[{...residual,key:'another-report-note'}]};
 const decision=records.decide('legacy',candidate.id,candidate.revision,verdict);
 assert.equal(records.get('legacy').progress.status,'completed');assert.deepEqual(decision.residuals,verdict.residuals);
 assert.deepEqual(decision.followups,[]);assert.equal(store.get('SELECT count(*) n FROM tasks').n,2);
 assert.equal(store.get('SELECT count(*) n FROM task_followups').n,1);
});

test('history reconstruction starts with recent facts, pages older observations and excludes private/foreign data',t=>{
 const {records,store,create}=fixture(t);create('a');create('b');
 store.run("UPDATE tasks SET messages=? WHERE id='a'",JSON.stringify([{content:'PRIVATE_MODEL_MESSAGES'}]));
 for(let i=0;i<25;i++)records.history('a','execution_evidence',{result:{output:'fact-'+i}});
 records.history('a','private_internal',{content:'PRIVATE_INTERNAL'});records.history('b','execution_evidence',{result:'FOREIGN_TASK'});
 const latest=records.tool('a','read_task_history',{});assert.equal(latest.total,25);assert.equal(latest.next_offset,10);
 assert.deepEqual(latest.observations.map(r=>r.data.result.output),Array.from({length:10},(_,i)=>'fact-'+(15+i)));
 const older=records.tool('a','read_task_history',{offset:20,limit:10});assert.equal(older.next_offset,null);assert.equal(older.observations.length,5);
 assert.ok(!JSON.stringify(latest).includes('PRIVATE'));assert.ok(!JSON.stringify(latest).includes('FOREIGN_TASK'));
});
