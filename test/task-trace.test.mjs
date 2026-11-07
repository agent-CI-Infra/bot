import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { beginRun,endRun,interruptRuns,taskTrace,traceSource,traceSnapshot,traceEvent } from '../dist/tasks/trace.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { queries } from '../dist/app/queries.js';
function seed(s){s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','a/OpenToday','o','a')");s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','OpenToday release report','{}')");}
const url=(q='')=>new URL('http://local/api/tasks/t/events'+q);
test('run snapshots survive reopen and input/config changes; interrupted run and recovery have stable ancestry',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bot155-')),path=join(dir,'db');let s=new Store(path,Buffer.alloc(32));try{seed(s);
 const run=beginRun(s,{id:'t'},'execution',{model:'fixed',prompt:'original',api_key:'secret'});
 s.run("INSERT INTO task_tools VALUES('op','t',?,NULL,'pending')",JSON.stringify({type:'workspace_command',command:'npm test',token:'SECRET'}));
 s.run("UPDATE task_tools SET state='completed',result=? WHERE id='op'",JSON.stringify({exit_code:0,output:'actual observed result'}));
 s.run("UPDATE tasks SET input=? WHERE id='t'",JSON.stringify({request:'changed later'}));s.close();s=new Store(path,Buffer.alloc(32));interruptRuns(s);
 const next=beginRun(s,{id:'t'},'execution',{prompt:'resumed'});assert.equal(s.get('SELECT previous_run_id FROM task_runs WHERE id=?',next.id).previous_run_id,run.id);
 const first=taskTrace(s,'t',url(),'runs').runs[0];assert.equal(first.status,'interrupted');assert.equal(first.context_snapshot.data.input.request,undefined);assert.equal(first.config_snapshot.data.prompt,'original');assert.equal(first.config_snapshot.data.api_key,undefined);
 const ops=taskTrace(s,'t',url('?type=operation'),'events').events;assert.equal(ops.length,2);assert.equal(ops[0].run_id,run.id);assert.match(JSON.stringify(ops[1]),/actual observed result/);assert.doesNotMatch(JSON.stringify(ops),/SECRET/);
 assert.ok(traceSource(s,'t',ops[1].event_id).complete);assert.throws(()=>traceSource(s,'foreign',ops[1].event_id));
 endRun(s,next,'succeeded');endRun(s,next,'succeeded');assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='run_ended' AND run_id=?",next.id).n,1);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('events are transaction-bound, paginated, filterable and authorized without invented legacy runs',()=>{
 const s=new Store(':memory:',Buffer.alloc(32));try{seed(s);assert.equal(taskTrace(s,'t',url(),'runs').runs.length,0);
 const before=s.get('SELECT count(*) n FROM task_history').n;assert.throws(()=>s.transaction(()=>{s.run("INSERT INTO task_tools VALUES('rollback','t','{}',NULL,'pending')");throw Error('fault');}));assert.equal(s.get('SELECT count(*) n FROM task_history').n,before);
 for(let i=0;i<3;i++)traceEvent(s,'t','intervention',{i},null,'user:owner');
 const first=taskTrace(s,'t',url('?type=intervention&limit=2'),'events');assert.equal(first.events.length,2);const second=taskTrace(s,'t',url('?type=intervention&limit=2&after='+first.next_after),'events');assert.equal(second.events.length,1);assert.equal(second.events[0].actor,'user:owner');assert.throws(()=>taskTrace(s,'t',url('?limit=-1'),'events'));
 assert.throws(()=>queries(s,{id:'outsider',role:'project_admin',repositories:[]},url()),/task_not_found/);
 }finally{s.close();}
});
test('followups resolve exact acceptance event through child and grandchild; replay creates no duplicate',()=>{
 const s=new Store(':memory:',Buffer.alloc(32));try{seed(s);const r=new TaskRecords(s),c=r.submit('t',[{kind:'report',reference:'report.md',version:'v1',content:'core report'}],[],{});
 const verdict={outcome:'pass_with_issues',reason:'Core complete; citation fix separate',gaps:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true,residuals:[{key:'citation',description:'Fix citation',evidence:'specific bad key',impact:'citation accuracy',nonblocking_reason:'does not invalidate core report',goal:'Fix cited key',criteria:['key exists']}]};
 const a=r.decide('t',c.id,c.revision,verdict);assert.deepEqual(r.decide('t',c.id,c.revision,verdict),a);const child=a.followups[0];const links=taskTrace(s,child,url(),'lineage');assert.equal(links.parents[0].parent_id,'t');assert.ok(links.parents[0].acceptance_event_id);
 const cc=r.submit(child,[{kind:'report',reference:'report.md',version:'v2',content:'corrected key'}],[],{}),b=r.decide(child,cc.id,cc.revision,{...verdict,residuals:[{...verdict.residuals[0],key:'fence',goal:'Fix code fence'}]});assert.equal(taskTrace(s,b.followups[0],url(),'lineage').parents[0].parent_id,child);
 }finally{s.close();}
});
test('bounded capture marks missing content and removes private reasoning and credentials',()=>{
 const captured=JSON.parse(traceSnapshot({api_key:'private',nested:JSON.stringify({authorization:'secret',content:'public'}),reasoning_content:'private thought',content:'public output'}));assert.equal(captured.complete,true);assert.doesNotMatch(JSON.stringify(captured),/private|secret/);
 const large=JSON.parse(traceSnapshot({text:'x'.repeat(3*1024*1024)}));assert.equal(large.complete,false);assert.equal(large.missing_reason,'capture_limit_exceeded');assert.ok(large.sha256);
});
