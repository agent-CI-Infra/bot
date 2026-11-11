import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../dist/storage/database.js';
import { normalizePermissions, permissionTools, permitsManagement, resourceAllowed, updatePermissions, fullPermissions } from '../dist/roles/permissions.js';
import { OwnTasks } from '../dist/service-roles/own-tasks.js';
import { Redactor } from '../dist/agent/common.js';
import { ServiceComputers, serviceMemory } from '../dist/service-roles/resources.js';
import { roleConfiguration } from '../dist/roles/definition.js';
import { assertTaskExternalEffect, taskReadScopes, withTaskPermissions } from '../dist/tasks/management.js';

test('legacy computer and GitHub subsets survive reads and identical saves without gaining resource actions',()=>{
  const policy=normalizePermissions({repository:'read',commands:'deny',github:'none',issues:'allow',pull_request:'deny',submission:'deny',coordination:'write',project_tasks:'none'});
  assert.equal(policy.computer,'custom');
  assert.ok(permissionTools(policy).includes('read_file'));assert.ok(!permissionTools(policy).includes('run_command'));
  assert.equal(resourceAllowed(policy,'issues','create'),true);assert.equal(resourceAllowed(policy,'issues','read'),false);
  assert.equal(resourceAllowed(policy,'issues','reply'),false);assert.equal(resourceAllowed(policy,'pull_requests','create'),false);
  assert.ok(permissionTools(policy).includes('request_task_coordination'));assert.ok(!permissionTools(policy).includes('manage_project_task'));
  assert.equal(permitsManagement(policy,'task.cancel',true),false);
  assert.deepEqual(updatePermissions(policy,policy),policy);
  const changed=updatePermissions(policy,{computer:'allow',github_issues:'read'});
  assert.ok(permissionTools(changed).includes('run_command'));assert.equal(resourceAllowed(changed,'issues','create'),false);
  assert.equal(changed.legacy_repository,undefined);assert.equal(changed.legacy_issues_create,undefined);
  const oldClient=updatePermissions(fullPermissions(),{github:'none',issues:'deny',pull_request:'deny'});
  assert.equal(resourceAllowed(oldClient,'issues','read'),false);assert.equal(resourceAllowed(oldClient,'issues','create'),false);
  assert.equal(resourceAllowed(oldClient,'issues','reply'),true);assert.equal(resourceAllowed(oldClient,'contents','publish'),false);
  assert.equal(resourceAllowed(oldClient,'pull_requests','reply'),true);
});

test('framework comments, labels and PR creation check the actual GitHub resource even through a finish result',t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')",s.secrets.seal({token:'fixture'},'account:a'));
  s.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('t','r','review.pr','queued','Inspect')");
  const config=roleConfiguration(s,'r'),dev=config.roles.find(r=>r.role_id==='dev');
  const save=permissions=>{dev.permissions=updatePermissions(dev.permissions,permissions);s.run("INSERT INTO settings VALUES('roles:r',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(config));};
  const task=s.get("SELECT * FROM tasks WHERE id='t'");
  save({github_issues:'write',github_pull_requests:'read',github_contents:'write'});
  assert.throws(()=>assertTaskExternalEffect(s,task,'comment'),{code:'task_external_write_forbidden'});
  assert.throws(()=>assertTaskExternalEffect(s,task,'label'),{code:'task_external_write_forbidden'});
  assert.throws(()=>assertTaskExternalEffect(s,task,'pull_request'),{code:'task_external_write_forbidden'});
  save({github_pull_requests:'write',github_contents:'none'});
  assert.doesNotThrow(()=>assertTaskExternalEffect(s,task,'comment'));
  assert.throws(()=>assertTaskExternalEffect(s,task,'branch'),{code:'task_external_write_forbidden'});
  save({github_pull_requests:'none'});
  assert.throws(()=>assertTaskExternalEffect(s,task,'comment'),{code:'task_external_write_forbidden'});
  save({github_pull_requests:'write',github_contents:'write'});
  const frozen=updatePermissions(fullPermissions(),{github_pull_requests:'read'});
  s.run("INSERT INTO role_snapshots VALUES('snapshot','r','dev',1,1,?,'now')",JSON.stringify({capability:{permissions:frozen}}));
  s.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role,role_snapshot) VALUES('run','t','model',1,1,'now','succeeded','{}','{}','dev','snapshot')");
  assert.throws(()=>assertTaskExternalEffect(s,task,'comment'),{code:'task_external_write_forbidden'},'a later grant cannot turn a read-only completed result into a write');
});

test('private memory and own-task controls are isolated by conversation, principal and authorization fence',async t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  const tasks=new OwnTasks(s),owner={service_role_id:'repository-assistant',kind:'channel',owner_id:'chat-a',principal_id:'binding-a',fence:'v1'};
  serviceMemory(s,owner,'remember_role_memory',{key:'decision',content:'Private decision'});
  const host={owner,system:'Scope',tools:()=>[],check(){},redact:v=>v,clean:v=>v,execute(){throw Error('Unexpected tool');},request:async()=>({value:{choices:[{message:{content:'Verified conclusion'}}]}})};
  const own=await tasks.invoke('start_own_task',{title:'Own question',instruction:'Think it through'},host);
  assert.equal((await tasks.invoke('read_own_task',{task_id:own.task_id},host)).history[0].conclusion,'Verified conclusion');
  for(const changed of [{owner_id:'chat-b'},{principal_id:'binding-b'},{fence:'v2'}]){
    const other={...owner,...changed};
    assert.deepEqual(serviceMemory(s,other,'read_role_memory',{key:'decision'}),{error:'memory_not_found'});
    assert.equal((await tasks.invoke('manage_own_task',{task_id:own.task_id,operation:'cancel'},{...host,owner:other})).error,'own_task_not_found');
  }
  assert.equal((await tasks.invoke('manage_own_task',{task_id:own.task_id,operation:'pause'},host)).state,'paused');
  assert.equal((await tasks.invoke('continue_own_task',{task_id:own.task_id,instruction:'Continue'},host)).conclusion,'Verified conclusion');
  await tasks.invoke('manage_own_task',{task_id:own.task_id,operation:'cancel'},host);
  assert.equal((await tasks.invoke('continue_own_task',{task_id:own.task_id,instruction:'Retry'},host)).error,'own_task_cancelled');
  assert.equal(s.get('SELECT count(*) n FROM tasks').n,0);
  assert.equal(permitsManagement(fullPermissions(),'task.create',true),true);
});


test('service computers use private sealed operation rows and refuse cross-scope or changed generations',async t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  let generation=1,enabled=true;const requests=[];
  const manager={async call(method,path,input){
    if(method==='GET')return {generation,state:'ready'};
    requests.push({path,...input});return {ok:true,result:input.request.type==='workspace_read'?{content:'private-file'}:{written:true}};
  }};
  const resolve=selected=>{if(!enabled)throw Error('scope_revoked');if(selected!=='fixture/repo')throw Error('repository_out_of_scope');return {id:'r',full_name:selected};};
  const a=new ServiceComputers(s,manager,'turn-a','chat-a',new Redactor(),async()=>{},resolve);
  const b=new ServiceComputers(s,manager,'turn-b','chat-b',new Redactor(),async()=>{},resolve);
  await a.execute('write_file',{repository:'fixture/repo',path:'note.txt',content:''});
  assert.equal((await b.execute('read_file',{repository:'fixture/repo',path:'note.txt'})).content,'private-file');
  assert.equal(new Set(requests.filter(r=>r.request.type==='workspace_init').map(r=>r.request.workspace_id)).size,2);
  assert.equal(s.get('SELECT count(*) n FROM task_tools').n,0);assert.equal(s.get('SELECT count(*) n FROM role_conversation_operations').n,0);
  const rows=s.all('SELECT * FROM service_role_operations');assert.ok(rows.length>=4);assert.ok(rows.every(r=>!r.request.includes('note.txt')));
  let before=requests.length;
  await assert.rejects(a.execute('read_file',{repository:'other/repo',path:'note.txt'}),/repository_out_of_scope/);
  assert.equal(requests.length,before);
  generation=2;await assert.rejects(a.execute('run_command',{repository:'fixture/repo',command:'true'}),{code:'environment_generation_changed'});
  assert.equal(requests.length,before);
  enabled=false;await assert.rejects(b.execute('read_file',{repository:'fixture/repo',path:'note.txt'}),/scope_revoked/);
  await a.close();await b.close();assert.equal(requests.filter(r=>r.request.type==='reap').length,2);
});


test('a resource grant cannot widen a running snapshot, including two concurrent role contexts',async t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('t','r','review.issue','running','Inspect')");
  const task=s.get("SELECT * FROM tasks WHERE id='t'"),config=roleConfiguration(s,'r');
  const onlyIssue=updatePermissions(fullPermissions(),{github_pull_requests:'none',github_actions:'none',github_checks:'none',github_statuses:'none',github_contents:'none'});
  const onlyPr=updatePermissions(onlyIssue,{github_issues:'none',github_pull_requests:'read'});
  let ready=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const scopes=await Promise.all([onlyIssue,onlyPr].map(p=>withTaskPermissions(s,task,'dev',[p],async()=>{
    if(++ready===2)release();await gate;
    config.roles.find(r=>r.role_id==='dev').permissions=fullPermissions();
    s.run("INSERT INTO settings VALUES('roles:r',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(config));
    await Promise.resolve();return taskReadScopes(s,task).filter(scope=>scope!=='metadata');
  })));
  assert.deepEqual(scopes,[['issues'],['pull_requests']]);
  assert.ok(taskReadScopes(s,task).includes('pull_requests'),'a later independent run may use the new grant');
});
