import {digest} from '../dist/core/security.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {TaskCommands} from '../dist/tasks/commands.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {roleTaskCaller,taskToolAllowed} from '../dist/tasks/management.js';
import {assertRequestPullRequest} from '../dist/tasks/pull-request.js';
import {taskPermissions} from '../dist/tasks/configuration.js';
import {TaskError} from '../dist/agent/common.js';
import {roleConfiguration} from '../dist/roles/definition.js';
function fixture(t){
 const s=new Store(':memory:',Buffer.alloc(32,7));t.after(()=>s.close());
 s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");
 s.run("INSERT INTO policies(repository_id,enabled,development_enabled) VALUES('r',1,1)");
 const cfg=roleConfiguration(s,'r');cfg.enabled=true;s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify(cfg));
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('parent','r','development.issue','running','Full roadmap','{}')");
 new TaskRecords(s).contract('parent',{goal:'Full roadmap',scope:['Full roadmap'],criteria:['Both capabilities and integration'],endpoint:'reviewable_pull_request'});
 const caller=roleTaskCaller(s,'r','manager',{source_task_id:'parent',guard(){if(s.get("SELECT status FROM tasks WHERE id='parent'").status==='cancelled')throw new TaskError('task_claim_revoked','cancelled');}});
 return {s,caller,commands:new TaskCommands(s),args:{request:'Deliver an independent capability',criteria:['Executable tests and working capability'],endpoint:'reviewable_pull_request'}};
}
test('D admission uses ordinary development authority, with identical independent and child execution',t=>{
 const {s,caller,commands,args}=fixture(t);assert.equal(s.get('SELECT work_settings FROM policies').work_settings,'{}');
 const plain=commands.tool(caller,'create_task',args),child=commands.tool(caller,'create_task',{...args,as_child:true});
 assert.ok(plain.id);assert.ok(child.id);assert.notEqual(plain.id,child.id);
 for(const result of [plain,child]){const task=s.get('SELECT * FROM tasks WHERE id=?',result.id);assert.equal(task.kind,'task.development');assert.equal(task.object_number,null);assertRequestPullRequest(s,task);assert.deepEqual(taskPermissions(s,task).writes,['code','pull_request']);assert.equal(s.get('SELECT executor_role FROM task_origins WHERE task_id=?',task.id).executor_role,null);assert.equal(taskToolAllowed(s,task,'dev','write_file'),true);assert.equal(commands.tool(caller,'create_task',{...args,...(result===child?{as_child:true}:{})}).id,result.id);}
 assert.equal(s.get('SELECT count(*) n FROM task_children').n,1);
 const report=commands.tool(caller,'create_task',{request:'Observe repository facts',criteria:['Factual report']});assert.equal(s.get('SELECT kind FROM tasks WHERE id=?',report.id).kind,'task.request');assert.deepEqual(taskPermissions(s,s.get('SELECT * FROM tasks WHERE id=?',report.id)).writes,[]);
});
test('refused development creation returns useful feedback, leaves no task and allows a different decision',t=>{
 const {s,caller,commands,args}=fixture(t);s.run('UPDATE policies SET development_enabled=0');const before=s.get('SELECT count(*) n FROM tasks').n;
 const refused=commands.tool(caller,'create_task',{...args,as_child:true});assert.equal(refused.error,'task_software_disabled');assert.equal(refused.created,false);assert.match(refused.instruction,/Project development/);assert.equal(s.get('SELECT count(*) n FROM tasks').n,before);assert.equal(s.get('SELECT count(*) n FROM task_children').n,0);
 assert.ok(commands.tool(caller,'create_task',{request:'Report missing development setup',criteria:['Name missing setup']}).id);
});
test('development intent and parent linkage cannot turn an ordinary report into source write authority',t=>{
 const {s,commands,args}=fixture(t);s.run("UPDATE tasks SET kind='task.request' WHERE id='parent'");
 const caller=roleTaskCaller(s,'r','manager',{source_task_id:'parent',guard(){}});
 for(const as_child of [false,true])assert.equal(commands.tool(caller,'create_task',{...args,as_child}).error,'task_external_write_forbidden');
 assert.equal(s.get('SELECT count(*) n FROM tasks').n,1);
});
test('task creation feedback never swallows live cancellation; ordinary development can be revoked',t=>{
 const {s,caller,commands,args}=fixture(t);const {id}=commands.tool(caller,'create_task',args);s.run('UPDATE policies SET development_enabled=0');assert.throws(()=>assertRequestPullRequest(s,s.get('SELECT * FROM tasks WHERE id=?',id)),{code:'task_software_disabled'});
 s.run("UPDATE tasks SET status='cancelled' WHERE id='parent'");assert.throws(()=>commands.tool(caller,'create_task',args),{code:'task_claim_revoked'});
});

test('an upgraded create retry reuses a legacy software request instead of duplicating it',t=>{
 const {s,caller,commands,args}=fixture(t);const first=commands.tool(caller,'create_task',args);
 const contract={goal:args.request,criteria:args.criteria,scope:[args.request],endpoint:args.endpoint};
 const revision=s.get("SELECT revision FROM task_records WHERE task_id='parent'").revision;
 const key='managed:'+digest(JSON.stringify([caller.owner_key,caller.source_message,caller.source_task_id,revision,args.request,contract,caller.role]));
 s.run("UPDATE tasks SET kind='task.request',unique_key=? WHERE id=?",key,first.id);
 const retry=commands.tool(caller,'create_task',args);assert.equal(retry.id,first.id);assert.equal(retry.replayed,true);assert.equal(s.get('SELECT count(*) n FROM tasks').n,2);
});
