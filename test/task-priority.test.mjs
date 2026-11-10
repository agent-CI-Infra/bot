import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {claimQueuedTask,setTaskPriority} from '../dist/tasks/priority.js';
import {validateFollowupPlan,relateTasks} from '../dist/tasks/followups.js';
import {TaskCommands} from '../dist/tasks/commands.js';
const kind="kind='task.request'";
const pass={outcome:'pass',reason:'Actual goal complete',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
const residual={key:'docs',description:'Stale E2E tooling description',evidence:'docs/known-issues.md says E2E is absent although package.json has test:e2e',impact:'Reader confusion',nonblocking_reason:'Core delivery and required journeys are verified',goal:'Correct only stale E2E tooling description',criteria:['Tooling description agrees with package.json']};
function fixture(t,path=':memory:'){
 const key=Buffer.alloc(32,7),s=new Store(path,key);t.after(()=>{try{s.close();}catch{}});
 s.run("INSERT OR IGNORE INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT OR IGNORE INTO repositories VALUES('r','fixture/repo','o','a')");s.run("INSERT OR IGNORE INTO policies(repository_id,enabled,task_concurrency) VALUES('r',1,2)");
 const create=(id,priority='P2',status='queued')=>{s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,priority,created_at,updated_at) VALUES(?,'r','task.request',?,?,'{}',?,?,?)",id,status,id,priority,new Date().toISOString(),new Date().toISOString());return s.get('SELECT * FROM tasks WHERE id=?',id);};
 return {s,key,create,records:new TaskRecords(s)};
}
function release(s,id,status='completed'){s.run('DELETE FROM task_claims WHERE task_id=?',id);s.run('UPDATE tasks SET status=? WHERE id=?',status,id);}
function stage(f,id){f.records.contract(id,{goal:'Deliver bounded verified work',scope:['docs'],criteria:['Actual evidence'],endpoint:'artifact',source:{},completeness:'explicit'});return f.records.submit(id,[{kind:'report',reference:'report.md',version:'tree-'+id}],[],{summary:'Observed evidence'});}
function plan(f,id,candidate,items){f.s.run('INSERT INTO task_followup_plans VALUES(?,?,?,?,?,?)',id,candidate.id,candidate.revision,JSON.stringify(validateFollowupPlan(f.s,f.s.get('SELECT * FROM tasks WHERE id=?',id),candidate,items.map(i=>({...residual,key:i.key})),{items})),'manager:actual-decision','now');}
const decision=(key,priority='P3',action='new',task_id)=>({key,priority,action,...(task_id?{task_id}:{}),reason:'Only optional documentation; no core flow or delivery blocked',evidence_refs:[residual.evidence]});

test('P0-P3, FIFO and nonpreemption use persistent tickets and not task IDs or creation timestamps',t=>{
 const f=fixture(t);f.create('z-first','P2');f.create('a-second','P2');f.create('low','P3');f.create('critical','P0');
 const a=claimQueuedTask(f.s,'r',kind,2),b=claimQueuedTask(f.s,'r',kind,2);assert.deepEqual([a.id,b.id],['critical','z-first']);assert.equal(claimQueuedTask(f.s,'r',kind,2),undefined);
 f.create('urgent','P1');assert.equal(f.s.get("SELECT status FROM tasks WHERE id='z-first'").status,'running');release(f.s,a.id);assert.equal(claimQueuedTask(f.s,'r',kind,2).id,'urgent');release(f.s,b.id);assert.equal(claimQueuedTask(f.s,'r',kind,2).id,'a-second');
});
test('changing priority joins the target tail; no-op changes preserve position; retries cannot monopolize the head',t=>{
 const f=fixture(t);f.create('one');f.create('two');f.create('three','P3');const old=f.s.get("SELECT queue_seq FROM tasks WHERE id='two'").queue_seq;
 setTaskPriority(f.s,'two','P2','No change','user:owner');assert.equal(f.s.get("SELECT queue_seq FROM tasks WHERE id='two'").queue_seq,old);
 setTaskPriority(f.s,'three','P2','Now normal scope','role:manager');assert.equal(claimQueuedTask(f.s,'r',kind,1).id,'one');release(f.s,'one','retry_wait');f.s.run("UPDATE tasks SET next_run_at=? WHERE id='one'",Date.now()+60000);
 assert.equal(claimQueuedTask(f.s,'r',kind,1).id,'two');release(f.s,'two');assert.equal(claimQueuedTask(f.s,'r',kind,1).id,'three');
});
test('unready dependencies do not hold the queue, and restart plus competing SQLite claimants preserve FIFO/capacity',t=>{
 const dir=mkdtempSync(join(tmpdir(),'priority-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state.sqlite'),f=fixture(t,path);
 f.create('dependency','P3','paused');f.create('waiting','P0');f.s.run("UPDATE tasks SET input=? WHERE id='waiting'",JSON.stringify({wait_for_review:'dependency'}));f.create('missing','P0');f.s.run("UPDATE tasks SET input=? WHERE id='missing'",JSON.stringify({wait_for_review:'not-created'}));f.create('first');f.create('second');const sequence=f.s.get("SELECT queue_seq FROM tasks WHERE id='first'").queue_seq;
 const other=new Store(path,f.key);t.after(()=>other.close());assert.equal(other.get("SELECT queue_seq FROM tasks WHERE id='first'").queue_seq,sequence);
 assert.equal(claimQueuedTask(f.s,'r',kind,2).id,'first');assert.equal(claimQueuedTask(other,'r',kind,2).id,'second');assert.equal(claimQueuedTask(other,'r',kind,2),undefined);
});
test('QA cannot schedule urgency; residuals enter the normal queue and Manager plans may choose P3',t=>{
 const f=fixture(t);f.create('parent');const c=stage(f,'parent');const v={...pass,outcome:'pass_with_issues',residuals:[{...residual,priority:'P0'}]};const result=f.records.decide('parent',c.id,c.revision,v);assert.deepEqual(result.followups,[]);assert.equal(f.s.get("SELECT priority FROM tasks WHERE id='parent'").priority,'P2');
 f.create('second');const b=stage(f,'second');plan(f,'second',b,[decision('docs')]);const r=f.records.decide('second',b.id,b.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]});assert.equal(f.s.get('SELECT priority FROM tasks WHERE id=?',r.followups[0]).priority,'P3');
 f.create('final-integration');assert.equal(claimQueuedTask(f.s,'r',kind,1).priority,'P2');
});
test('different parents/keys can supplement one issue with complete multi-source evidence and replay idempotence',t=>{
 const f=fixture(t);f.create('existing','P3');for(const [id,key] of [['parent-a','doc-claim'],['parent-b','different-wording']]){
 f.create(id);const c=stage(f,id);const d={...decision(key,'P3','supplement','existing'),issue_url:'https://github.com/fixture/repo/issues/42'};plan(f,id,c,[d]);const verdict={...pass,outcome:'pass_with_issues',residuals:[{...residual,key}]};const a=f.records.decide(id,c.id,c.revision,verdict);assert.deepEqual(a.followups,['existing']);assert.deepEqual(f.records.decide(id,c.id,c.revision,verdict).followups,['existing']);}
 assert.equal(f.s.get('SELECT count(*) n FROM tasks').n,3);assert.equal(f.s.get("SELECT count(*) n FROM task_relations WHERE target_task_id='existing'").n,2);
});
test('new connected work is held for Coordinator when similar work is running; supplementation also coordinates',t=>{
 const f=fixture(t);f.create('active','P2','running');f.create('parent');const c=stage(f,'parent');plan(f,'parent',c,[decision('docs','P3','related','active')]);const result=f.records.decide('parent',c.id,c.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]});assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',result.followups[0]).status,'waiting_coordination');assert.equal(f.s.get('SELECT count(*) n FROM task_coordinations').n,1);
 f.create('another');const b=stage(f,'another');plan(f,'another',b,[decision('docs','P3','supplement','active')]);assert.deepEqual(f.records.decide('another',b.id,b.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]}).followups,['active']);assert.equal(f.s.get('SELECT count(*) n FROM task_coordinations').n,2);assert.equal(f.s.get("SELECT priority FROM tasks WHERE id='active'").priority,'P2');const activeCandidate=stage(f,'active');assert.throws(()=>f.records.decide('active',activeCandidate.id,activeCandidate.revision,pass),e=>e.code==='task_coordination_pending');
});
test('distinct causes with the same title stay separate, and a solved issue recurs without rewriting its historical acceptance',t=>{
 const f=fixture(t);f.create('solved');const accepted=stage(f,'solved');f.records.decide('solved',accepted.id,accepted.revision,pass);f.create('parent');const c=stage(f,'parent');plan(f,'parent',c,[decision('docs','P2','supplement','solved')]);const result=f.records.decide('parent',c.id,c.revision,{...pass,outcome:'pass_with_issues',residuals:[residual]});assert.notEqual(result.followups[0],'solved');assert.equal(f.records.get('solved').acceptance.outcome,'pass');assert.equal(f.s.get("SELECT relationship FROM task_relations WHERE source_task_id=? AND target_task_id='solved'",result.followups[0]).relationship,'recurrence');
});
test('management priority/association APIs enforce project scope and retain reasons',t=>{
 const f=fixture(t);f.create('a');f.create('b');const commands=new TaskCommands(f.s),owner={id:'u',username:'u',role:'super_admin',repositories:[]};
 commands.api(owner,'POST',new URL('http://local/api/tasks/a/priority'),{priority:'P1',reason:'Core export blocks required delivery, no workaround'});assert.equal(f.records.get('a').priority.level,'P1');assert.throws(()=>commands.api(owner,'POST',new URL('http://local/api/tasks/a/priority'),{priority:'P9',reason:'urgent'}),e=>e.code==='invalid_task_priority');
 const args={key:'same-report',task_id:'b',relationship:'related',reason:'Different cause, related surface',evidence:'Observed separate failure'};assert.equal(relateTasks(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),args).target_task_id,'b');assert.equal(relateTasks(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),args).reused,true);
});

test('two real worker processes claim FIFO exactly once under the shared project capacity',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const dir=mkdtempSync(join(tmpdir(),'priority-workers-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db'),f=fixture(t,path);f.create('z-first');f.create('a-second');f.create('third');
 const database=new URL('../dist/storage/database.js',import.meta.url).href,priority=new URL('../dist/tasks/priority.js',import.meta.url).href;
 const script=`import {Store} from ${JSON.stringify(database)};import {claimQueuedTask} from ${JSON.stringify(priority)};const s=new Store(process.argv[1],Buffer.alloc(32,7));const row=claimQueuedTask(s,'r',"kind='task.request'",2);console.log(JSON.stringify(row?.id??null));s.close();`;
 const outputs=await Promise.all([1,2].map(()=>promisify(execFile)(process.execPath,['--input-type=module','-e',script,path])));
 assert.deepEqual(outputs.map(r=>JSON.parse(r.stdout)).sort(),['a-second','z-first']);assert.deepEqual(f.s.all("SELECT task_id FROM task_history WHERE type='queue_claimed' ORDER BY id").map(r=>r.task_id),['z-first','a-second']);assert.equal(claimQueuedTask(f.s,'r',kind,2),undefined);
});
