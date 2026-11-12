import {digest} from '../dist/core/security.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {TaskCommands} from '../dist/tasks/commands.js';
import {taskToolAllowed,roleTaskCaller} from '../dist/tasks/management.js';
import {attachChild,childTaskContext,waitForChildren,resumeParentTasks} from '../dist/tasks/children.js';
import {roleConfiguration} from '../dist/roles/definition.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'children-'));let s=new Store(join(dir,'state.sqlite'),Buffer.alloc(32,5));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");s.run("INSERT INTO policies(repository_id,enabled) VALUES('r',1)");const config=roleConfiguration(s,'r');config.enabled=true;s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify(config));
 const add=id=>s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,'r','task.request','queued',?,'{}')",id,id);add('parent');
 return {get s(){return s;},add,reopen(){s.close();s=new Store(join(dir,'state.sqlite'),Buffer.alloc(32,5));},parent(){return s.get("SELECT * FROM tasks WHERE id='parent'");},park(after=0){const result=waitForChildren(s,this.parent(),{after_event_id:after,reason:'Await work'});if(result.waiting)s.run("UPDATE tasks SET status='waiting_coordination',error_code='task_children_pending' WHERE id='parent'");return result;}};}
test('authorized explicit children are durable, idempotent, and distinct from ordinary task origins',t=>{const f=fixture(t),s=f.s;const caller=roleTaskCaller(s,'r','manager',{source_task_id:'parent',guard(){}}),cmd=new TaskCommands(s);
 const args={request:'Independent capability',criteria:['observable result'],as_child:true,execute:false};const a=cmd.tool(caller,'create_task',args),b=cmd.tool(caller,'create_task',args);assert.equal(a.id,b.id);assert.equal(childTaskContext(s,'parent').children.length,1);assert.equal(childTaskContext(s,'parent').events.length,0);const child=s.get('SELECT * FROM tasks WHERE id=?',a.id);assert.equal(s.get('SELECT executor_role FROM task_origins WHERE task_id=?',a.id).executor_role,null);assert.equal(taskToolAllowed(s,child,'dev','write_file'),true);assert.equal(taskToolAllowed(s,child,'dev','run_command'),true);
 cmd.tool(caller,'create_task',{request:'Separate report',criteria:['report']});assert.equal(childTaskContext(s,'parent').children.length,1);
 assert.throws(()=>cmd.tool(roleTaskCaller(s,'r','dev',{source_task_id:'parent',guard(){}}),'create_task',args),{code:'child_task_manager_required'});
});
for(const status of ['completed','failed','cancelled','superseded','needs_help'])test(`any ${status} child wakes the parent while its sibling continues`,t=>{const f=fixture(t);for(const id of ['a','b']){f.add(id);attachChild(f.s,'parent',id);f.s.run("UPDATE tasks SET status='running' WHERE id=?",id);}assert.equal(f.park().waiting,true);f.s.run('UPDATE tasks SET status=? WHERE id=?',status,'a');f.reopen();resumeParentTasks(f.s,()=>false);assert.equal(f.parent().status,'queued');assert.equal(f.s.get("SELECT status FROM tasks WHERE id='b'").status,'running');const ctx=childTaskContext(f.s,'parent');assert.equal(ctx.events.length,1);assert.equal(new TaskRecords(f.s).get('parent').children.events.length,1);assert.equal(f.park(ctx.after_event_id).waiting,true);resumeParentTasks(f.s,()=>false);assert.equal(f.parent().status,'waiting_coordination');});
test('early results, concurrent returns, active Manager and cancelled parent do not lose or replay wakes',t=>{const f=fixture(t);for(const id of ['a','b']){f.add(id);attachChild(f.s,'parent',id);}f.s.run("UPDATE tasks SET status='completed' WHERE id='a'");assert.equal(f.park().waiting,false);const first=childTaskContext(f.s,'parent').after_event_id;assert.equal(f.park(first).waiting,true);f.s.run("UPDATE tasks SET status='needs_help' WHERE id='b'");resumeParentTasks(f.s,()=>true);assert.equal(f.parent().status,'waiting_coordination');resumeParentTasks(f.s,()=>false);assert.equal(f.parent().status,'queued');const last=childTaskContext(f.s,'parent').after_event_id;assert.equal(f.park(last).waiting,false);assert.match(f.park(last).instruction,/No child/);f.s.run("UPDATE tasks SET status='cancelled' WHERE id='parent'");resumeParentTasks(f.s,()=>false);assert.equal(f.parent().status,'cancelled');});
test('internal retries do not wake; cursors cannot acknowledge another parent or unobserved future',t=>{const f=fixture(t);f.add('a');attachChild(f.s,'parent','a');assert.equal(f.park().waiting,true);for(const status of ['running','retry_wait','queued','running'])f.s.run('UPDATE tasks SET status=? WHERE id=?',status,'a');resumeParentTasks(f.s,()=>false);assert.equal(f.parent().status,'waiting_coordination');assert.equal(childTaskContext(f.s,'parent').events.length,0);assert.equal(f.park(10000).error,'invalid_child_cursor');});

test('dependency decisions remain with parent: failure does not start successors, ready work keeps FIFO',t=>{
 const f=fixture(t),cmd=new TaskCommands(f.s),caller=roleTaskCaller(f.s,'r','manager',{source_task_id:'parent',guard(){}});
 const make=(name,execute)=>cmd.tool(caller,'create_task',{request:name,criteria:['Accept '+name],as_child:true,execute}).id;
 const a=make('A independent',true),b=make('B independent',true),c=make('C requires A',false),d=make('D requires B and C',false);
 assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',c).status,'paused');assert.equal(f.park().waiting,true);
 f.s.run("UPDATE tasks SET status='failed' WHERE id=?",a);resumeParentTasks(f.s,()=>false);assert.equal(f.parent().status,'queued');assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',c).status,'paused');
 cmd.tool(caller,'manage_task',{task_id:a,action:'retry'});f.s.run("UPDATE tasks SET status='completed' WHERE id=?",a);cmd.tool(caller,'manage_task',{task_id:c,action:'retry'});
 assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',c).status,'queued');assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',d).status,'paused');
 assert.ok(f.s.get('SELECT queue_seq FROM tasks WHERE id=?',b).queue_seq<f.s.get('SELECT queue_seq FROM tasks WHERE id=?',c).queue_seq);
 f.s.run("UPDATE tasks SET status='completed' WHERE id IN (?,?)",b,c);cmd.tool(caller,'manage_task',{task_id:d,action:'retry'});assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',d).status,'queued');assert.notEqual(f.parent().status,'completed');
});

test('an assigned child can read its parent contract but cannot acquire unrelated task or parent write access',t=>{
 const f=fixture(t),cmd=new TaskCommands(f.s),manager=roleTaskCaller(f.s,'r','manager',{source_task_id:'parent',guard(){}});
 const {id}=cmd.tool(manager,'create_task',{request:'Independent child',criteria:['Deliver evidence'],as_child:true});
 f.s.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,role,context_snapshot,config_snapshot) VALUES('child-run',?,'execution',1,1,'now','running','dev','{}','{}')",id);
 const child=roleTaskCaller(f.s,'r','dev',{source_task_id:id,source_run_id:'child-run',guard(){}});
 assert.ok(cmd.tool(child,'read_managed_task',{task_id:'parent'}).task.contract);
 const sibling=cmd.tool(manager,'create_task',{request:'Sibling capability',criteria:['Deliver sibling evidence'],as_child:true}).id;
 assert.ok(cmd.tool(child,'read_managed_task',{task_id:sibling}).task.contract);
 assert.throws(()=>cmd.tool(child,'manage_task',{task_id:sibling,action:'pause'}),{code:'task_not_owned'});
 f.s.run("UPDATE task_runs SET status='succeeded' WHERE id='child-run'");
 assert.throws(()=>cmd.tool(child,'read_managed_task',{task_id:sibling}),{code:'task_not_owned'});
 f.s.run("UPDATE task_runs SET status='running' WHERE id='child-run'");
 assert.throws(()=>cmd.tool(child,'manage_task',{task_id:'parent',action:'pause'}),{code:'task_not_owned'});
 f.add('unrelated');assert.throws(()=>cmd.tool(child,'read_managed_task',{task_id:'unrelated'}),{code:'task_not_owned'});
});


test('ordinary create_task retries retain their pre-child-feature idempotency key across upgrade',t=>{
 const f=fixture(t),cmd=new TaskCommands(f.s),caller=roleTaskCaller(f.s,'r','manager',{source_task_id:'parent',guard(){}});
 const request='Existing ordinary report',criteria=['Report facts'];const first=cmd.tool(caller,'create_task',{request,criteria});
 const contract={goal:request,criteria,scope:[request],endpoint:'report'},revision=f.s.get("SELECT revision FROM task_records WHERE task_id='parent'").revision;
 const legacy='managed:'+digest(JSON.stringify([caller.owner_key,caller.source_message,caller.source_task_id,revision,request,contract,caller.role]));
 f.s.run('UPDATE tasks SET unique_key=? WHERE id=?',legacy,first.id);
 const retried=cmd.tool(caller,'create_task',{request,criteria});assert.equal(retried.id,first.id);assert.equal(retried.replayed,true);
});

test('accepted children do not satisfy a missing parent integration criterion or override parent QA',t=>{
 const f=fixture(t),records=new TaskRecords(f.s);
 records.contract('parent',{goal:'Deliver both products and their integrated journey',scope:['suite'],criteria:['A works','B works','Integrated journey invokes A and B'],endpoint:'report'});
 const pass={outcome:'pass',reason:'Verified child capability',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
 for(const id of ['a','b']){f.add(id);attachChild(f.s,'parent',id);const c=records.submit(id,[{kind:'report',reference:id+'.md',version:'v1',content:'Verified product'}],[],{summary:'Child delivered'});records.decide(id,c.id,c.revision,pass);}
 assert.equal(f.s.get("SELECT count(*) n FROM tasks WHERE id IN ('a','b') AND status='completed'").n,2);
 assert.notEqual(f.parent().status,'completed');
 const c=records.submit('parent',[{kind:'report',reference:'suite.md',version:'v1',content:'A and B delivered, no integration'}],[],{summary:'Both children accepted'});
 records.decide('parent',c.id,c.revision,{...pass,outcome:'return',reason:'Parent integrated journey is missing',gaps:['No runnable journey invokes both real products'],core_complete:false,required_evidence_complete:false});
 assert.notEqual(f.parent().status,'completed');assert.equal(records.get('parent').acceptance.outcome,'return');
 assert.equal(childTaskContext(f.s,'parent').children.every(c=>c.acceptance.outcome==='pass'),true);
});
