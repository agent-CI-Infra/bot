import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../dist/storage/database.js';
import { normalizePermissions, permissionTools, permitsManagement, resourceAllowed, updatePermissions, fullPermissions, defaultPermissions, githubWriteAllowed, narrowPermissions } from '../dist/roles/permissions.js';
import { OwnTasks } from '../dist/service-roles/own-tasks.js';
import { serviceMemory } from '../dist/service-roles/resources.js';
import { roleConfiguration, resetBuiltinRolePermissions } from '../dist/roles/definition.js';
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

test('framework deliveries follow the work type, not the executing role\'s GitHub write (#381)',t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')",s.secrets.seal({token:'fixture'},'account:a'));
  s.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('t','r','review.pr','queued','Inspect')");
  const config=roleConfiguration(s,'r'),dev=config.roles.find(r=>r.role_id==='dev');
  const save=permissions=>{dev.permissions=updatePermissions(dev.permissions,permissions);s.run("INSERT INTO settings VALUES('roles:r',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(config));};
  const task=s.get("SELECT * FROM tasks WHERE id='t'");
  // The built-in executor reads only, yet its review comment, labels and a tested PR are still delivered.
  for(const resource of ['issues','pull_requests','contents'])assert.equal(dev.permissions['github_'+resource],'read');
  for(const kind of ['comment','label','review','pull_request','branch','resolve'])assert.doesNotThrow(()=>assertTaskExternalEffect(s,task,kind),kind);
  save({github_issues:'none',github_pull_requests:'none',github_contents:'none'});
  assert.doesNotThrow(()=>assertTaskExternalEffect(s,task,'comment'),'no GitHub permission at all still delivers the framework result');
});

test('only the Manager writes by default; write offers github_write on its resource and narrowing keeps the ceiling (#381)',()=>{
  const manager=defaultPermissions('manager','controller');
  assert.deepEqual(['issues','pull_requests','contents','actions','checks','statuses'].map(r=>manager['github_'+r]),['write','write','write','read','read','read']);
  for(const [id,kind] of [['coordinator','controller'],['dev','writer'],['test','observer'],['reviewer','observer'],['ux','observer'],['qa','evaluator'],['custom','observer']]){
    const p=defaultPermissions(id,kind);
    assert.ok(['issues','pull_requests','contents','actions','checks','statuses'].every(r=>p['github_'+r]==='read'),id);
    assert.ok(!permissionTools(p).includes('github_write'),id);
    // Deliveries need no GitHub write of the role.
    for(const tool of ['create_pull_request','report_failure','rerun_failed_run','finish_review'])assert.ok(permissionTools(p).includes(tool),id+' '+tool);
  }
  assert.ok(permissionTools(manager).includes('github_write'));
  const issuesOnly=updatePermissions(manager,{github_pull_requests:'read',github_contents:'read'});
  assert.deepEqual(['issues','pull_requests','contents'].map(r=>githubWriteAllowed(issuesOnly,r)),[true,false,false]);
  // A legacy subset honors only its matching routes: creating Issues, not editing them.
  const legacy=normalizePermissions({github:'read',issues:'allow'});
  assert.deepEqual([githubWriteAllowed(legacy,'issues','create'),githubWriteAllowed(legacy,'issues'),githubWriteAllowed(legacy,'issues','reply')],[true,false,false]);
  // A delegated run without github_write loses every write; with it, keeps exactly the source's.
  assert.ok(!githubWriteAllowed(narrowPermissions(manager,['github_read']),'issues'));
  assert.deepEqual(['issues','contents'].map(r=>githubWriteAllowed(narrowPermissions(issuesOnly,['github_read','github_write']),r)),[true,false]);
});

test('saved built-in roles take the new default permissions once; settings and custom roles stay (#381)',t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')",s.secrets.seal({token:'fixture'},'account:a'));
  s.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  const config=roleConfiguration(s,'r');delete config.legacy;config.revision=4;
  const role=id=>config.roles.find(r=>r.role_id===id);
  role('dev').permissions=updatePermissions(role('dev').permissions,{github_issues:'write',github_contents:'write'});role('dev').harness_ref={id:'native',version:'pinned'};role('dev').persona_prompt='Keep my persona.';
  role('manager').permissions=updatePermissions(role('manager').permissions,{github_issues:'none',delegation:'deny'});
  config.roles.push({...role('reviewer'),role_id:'auditor',permissions:updatePermissions(role('reviewer').permissions,{github_issues:'write'})});
  s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify(config));
  // A database upgraded with this change runs the reset at start-up; this one already did (empty), so run it again.
  s.run("DELETE FROM settings WHERE key='migration:381:builtin-role-permissions'");
  resetBuiltinRolePermissions(s);
  const after=roleConfiguration(s,'r'),find=id=>after.roles.find(r=>r.role_id===id);
  assert.equal(after.revision,5);assert.equal(after.updated_by,'migration:381');
  assert.deepEqual(find('dev').permissions,defaultPermissions('dev','writer'));assert.deepEqual(find('manager').permissions,defaultPermissions('manager','controller'));
  assert.deepEqual([find('dev').harness_ref,find('dev').persona_prompt],[{id:'native',version:'pinned'},'Keep my persona.']);
  assert.equal(find('dev').revision,role('dev').revision+1);
  assert.equal(find('auditor').permissions.github_issues,'write','a custom role keeps its saved permissions');
  assert.equal(s.get("SELECT actor FROM role_config_revisions WHERE repository_id='r' AND revision=5").actor,'migration:381');
  // Once: a later change by an administrator is never reset again.
  const saved=JSON.parse(s.get("SELECT value FROM settings WHERE key='roles:r'").value);saved.roles.find(r=>r.role_id==='dev').permissions.github_issues='write';
  s.run("UPDATE settings SET value=? WHERE key='roles:r'",JSON.stringify(saved));resetBuiltinRolePermissions(s);
  assert.equal(roleConfiguration(s,'r').roles.find(r=>r.role_id==='dev').permissions.github_issues,'write');
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
