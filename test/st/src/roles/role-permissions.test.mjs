import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { normalizePermissions, permissionItems, permissionTools, permitsManagement, permitsTool, resourceAllowed, updatePermissions, fullPermissions, defaultPermissions, githubWriteAllowed, narrowPermissions } from '../../../../dist/roles/permissions.js';
import { OwnTasks } from '../../../../dist/service-roles/own-tasks.js';
import { roleConfiguration, resetBuiltinRolePermissions, actionsWriteFollowsIssues } from '../../../../dist/roles/definition.js';
import { assertTaskExternalEffect, taskReadScopes, withTaskPermissions } from '../../../../dist/tasks/management.js';

test('legacy GitHub and coordination subsets survive reads and identical saves without gaining resource actions; computer is always allowed (#1206)',()=>{
  const policy=normalizePermissions({repository:'read',commands:'deny',github:'none',issues:'allow',pull_request:'deny',submission:'deny',coordination:'write',project_tasks:'none'});
  assert.equal(policy.computer,undefined);
  assert.ok(permissionTools(policy).includes('read_file'));assert.ok(permissionTools(policy).includes('run_command'));
  assert.equal(resourceAllowed(policy,'issues','create'),true);assert.equal(resourceAllowed(policy,'issues','read'),false);
  assert.equal(resourceAllowed(policy,'issues','reply'),false);assert.equal(resourceAllowed(policy,'pull_requests','create'),false);
  assert.ok(permissionTools(policy).includes('wait_for_tasks'));assert.ok(!permissionTools(policy).includes('manage_project_task'));
  assert.equal(permitsManagement(policy,'task.cancel',true),false);
  assert.deepEqual(updatePermissions(policy,policy),policy);
  const changed=updatePermissions(policy,{github_issues:'read'});
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
  // Actions write (starting workflows, #1072) follows Issues write.
  assert.deepEqual(['issues','pull_requests','contents','actions','checks','statuses'].map(r=>manager['github_'+r]),['write','write','write','write','read','read']);
  for(const [id,kind] of [['dev','writer'],['test','observer'],['reviewer','observer'],['ux','observer'],['qa','evaluator'],['custom','observer']]){
    const p=defaultPermissions(id,kind);
    assert.ok(['issues','pull_requests','contents','actions','checks','statuses'].every(r=>p['github_'+r]==='read'),id);
    assert.ok(!permissionTools(p).includes('github_write'),id);
    // Deliveries need no GitHub write of the role.
    for(const tool of ['create_pull_request','rerun_failed_run','finish_review'])assert.ok(permissionTools(p).includes(tool),id+' '+tool);
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
  role('dev').permissions=updatePermissions(role('dev').permissions,{github_issues:'write',github_contents:'write'});role('dev').harness_ref={id:'process',version:'pinned'};role('dev').persona_prompt='Keep my persona.';
  role('manager').permissions=updatePermissions(role('manager').permissions,{github_issues:'none',delegation:'deny'});
  config.roles.push({...role('reviewer'),role_id:'auditor',permissions:updatePermissions(role('reviewer').permissions,{github_issues:'write'})});
  s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify(config));
  // A database upgraded with this change runs the reset at start-up; this one already did (empty), so run it again.
  s.run("DELETE FROM settings WHERE key='migration:381:builtin-role-permissions'");
  resetBuiltinRolePermissions(s);
  const after=roleConfiguration(s,'r'),find=id=>after.roles.find(r=>r.role_id===id);
  assert.equal(after.revision,5);assert.equal(after.updated_by,'migration:381');
  assert.deepEqual(find('dev').permissions,defaultPermissions('dev','writer'));assert.deepEqual(find('manager').permissions,defaultPermissions('manager','controller'));
  assert.deepEqual([find('dev').harness_ref,find('dev').persona_prompt],[{id:'process',version:'pinned'},'Keep my persona.']);
  assert.equal(find('dev').revision,role('dev').revision+1);
  assert.equal(find('auditor').permissions.github_issues,'write','a custom role keeps its saved permissions');
  assert.equal(s.get("SELECT actor FROM role_config_revisions WHERE repository_id='r' AND revision=5").actor,'migration:381');
  // Once: a later change by an administrator is never reset again.
  const saved=JSON.parse(s.get("SELECT value FROM settings WHERE key='roles:r'").value);saved.roles.find(r=>r.role_id==='dev').permissions.github_issues='write';
  s.run("UPDATE settings SET value=? WHERE key='roles:r'",JSON.stringify(saved));resetBuiltinRolePermissions(s);
  assert.equal(roleConfiguration(s,'r').roles.find(r=>r.role_id==='dev').permissions.github_issues,'write');
});

test('saved roles that write Issues and read Actions take Actions write once; the others keep theirs (#1072)',t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')",s.secrets.seal({token:'fixture'},'account:a'));
  s.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  const config=roleConfiguration(s,'r');delete config.legacy;config.revision=7;
  const role=id=>config.roles.find(r=>r.role_id===id);
  // As saved before #1072: Actions had no write mode.
  role('manager').permissions=updatePermissions(role('manager').permissions,{github_actions:'read'});
  role('dev').permissions=updatePermissions(role('dev').permissions,{github_issues:'write'});
  config.roles.push({...role('reviewer'),role_id:'auditor',permissions:updatePermissions(role('reviewer').permissions,{github_issues:'write',github_actions:'none'})});
  s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify(config));
  s.run("DELETE FROM settings WHERE key='migration:1072:actions-write'");
  actionsWriteFollowsIssues(s);
  const after=roleConfiguration(s,'r'),find=id=>after.roles.find(r=>r.role_id===id);
  assert.deepEqual([after.revision,after.updated_by],[8,'migration:1072']);
  assert.deepEqual(['manager','dev','reviewer','auditor'].map(id=>find(id).permissions.github_actions),['write','write','read','none']);
  assert.deepEqual(['manager','reviewer'].map(id=>find(id).revision-role(id).revision),[1,0]);
  assert.equal(s.get("SELECT actor FROM role_config_revisions WHERE repository_id='r' AND revision=8").actor,'migration:1072');
  // Once: an administrator who sets it back to read keeps that.
  const saved=JSON.parse(s.get("SELECT value FROM settings WHERE key='roles:r'").value);saved.roles.find(r=>r.role_id==='manager').permissions.github_actions='read';
  s.run("UPDATE settings SET value=? WHERE key='roles:r'",JSON.stringify(saved));actionsWriteFollowsIssues(s);
  assert.equal(roleConfiguration(s,'r').roles.find(r=>r.role_id==='manager').permissions.github_actions,'read');
});

test('own-task controls are isolated by conversation, principal and authorization fence; retired read_role_memory is not permitted',async t=>{
  const s=new Store(':memory:',Buffer.alloc(32,2));t.after(()=>s.close());
  const tasks=new OwnTasks(s),owner={service_role_id:'repository-assistant',kind:'channel',owner_id:'chat-a',principal_id:'binding-a',fence:'v1'};
  assert.equal(permitsTool(fullPermissions(),'read_role_memory'),false);
  const host={owner,system:'Scope',tools:()=>[],check(){},redact:v=>v,execute(){throw Error('Unexpected tool');},run:async()=>'Verified conclusion'};
  const own=await tasks.invoke('start_own_task',{title:'Own question',instruction:'Think it through'},host);
  assert.equal((await tasks.invoke('read_own_task',{task_id:own.task_id},host)).history[0].conclusion,'Verified conclusion');
  for(const changed of [{owner_id:'chat-b'},{principal_id:'binding-b'},{fence:'v2'}]){
    const other={...owner,...changed};
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

test('a project role editor offers no item that does nothing for project roles, and lists each role\'s defaults (#850)', async t => {
  const { harness, setup, account, repository } = await import('../../../fixtures/helpers.mjs');
  const { projectCapabilities } = await import('../../../../dist/identity/storage.js');
  const { TaskEngine } = await import('../../../../dist/agent/engine.js');
  // The roles routes are served with a task engine.
  const h = await harness(t, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const response = await admin('/api/repositories/101/roles'), view = response.value; assert.equal(response.status, 200, JSON.stringify(view));
  const ids = view.permission_items.map(item => item.id);
  // The management tools these items govern exist only for assistants; computer and browser are built-in and omitted everywhere (#1206).
  for (const id of ['computer', 'browser', 'project_configuration', 'schedules']) assert.ok(!ids.includes(id), id);
  assert.ok(ids.includes('project_tasks') && ids.includes('project_memory') && ids.includes('github_contents'));
  assert.ok((await admin('/api/service-roles')).value.permission_items.some(item => item.id === 'schedules'));
  assert.ok(!(await admin('/api/service-roles')).value.permission_items.some(item => ['computer', 'browser'].includes(item.id)));
  // Built-in roles read their defaults from role_defaults; permission_defaults adds only the project's own roles.
  for (const role of view.configuration.roles) assert.deepEqual(view.role_defaults[role.role_id].permissions, defaultPermissions(role.role_id, role.kind), role.role_id);
  assert.deepEqual(view.permission_defaults, {});
  // roles.publish was never checked anywhere.
  assert.ok(!projectCapabilities.includes('roles.publish'));
});

test('computer tools are built-in and always permitted while the retired browser tool is no longer permitted (#1206, #1214)', () => {
  assert.ok(!permissionItems.some(item => ['computer', 'browser'].includes(item.id)));
  for (const raw of [{ computer: 'deny', browser: 'deny' }, { computer: 'allow', browser: 'deny' }, { repository: 'none', commands: 'deny' }, defaultPermissions('manager', 'controller'), defaultPermissions('dev', 'writer'), fullPermissions()]) {
    const p = normalizePermissions(raw);
    assert.equal(p.computer, undefined);
    assert.equal(p.browser, undefined);
    for (const tool of ['read_file', 'write_file', 'run_command']) assert.equal(permitsTool(p, tool), true, tool);
    assert.equal(permitsTool(p, 'browser'), false, 'retired browser tool must not be permitted');
  }
});

test('fetch_github_media is granted by any of issues, pull_requests or contents read scope and preserved by narrowPermissions', () => {
  const none = updatePermissions(fullPermissions(), {
    github_issues: 'none', github_pull_requests: 'none', github_contents: 'none',
    github_actions: 'read', github_checks: 'read', github_statuses: 'read',
  });
  assert.equal(permitsTool(none, 'fetch_github_media'), false, 'actions/checks/statuses alone must not grant fetch_github_media');
  for (const field of ['github_issues', 'github_pull_requests', 'github_contents']) {
    const one = updatePermissions(none, { [field]: 'read' });
    assert.equal(permitsTool(one, 'fetch_github_media'), true, `${field}:read grants fetch_github_media`);
    const narrowed = narrowPermissions(one, ['fetch_github_media']);
    assert.equal(permitsTool(narrowed, 'fetch_github_media'), true, `narrowPermissions retains fetch_github_media for ${field}`);
  }
});
