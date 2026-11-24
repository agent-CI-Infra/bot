import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { roleConfiguration, saveConfiguration, resolveRole, roleAuthority } from '../../../../dist/roles/definition.js';
import { roleConfig, controlled } from '../../../../dist/roles/run.js';
import { captureTaskConfiguration, taskConfiguration } from '../../../../dist/tasks/configuration.js';
import { eventFilters, saveManager } from '../../../../dist/dispatch/settings.js';

const entries = ['development', 'request', 'review', 'actions'];
function fixture(t) {
  const s = new Store(':memory:', randomBytes(32)); t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/project','o','a')");
  s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r','http://127.0.0.1:9/v1','fixture',?,'now')",s.secrets.seal({value:'fixture-key'},'model:m'));
  s.run("INSERT INTO policies(repository_id,enabled,model_id,actions_failures_enabled,event_filters) VALUES('r',1,'m',0,?)",JSON.stringify({'issue.mention':false,'pull_request.synchronize':false}));
  return s;
}
function task(s,id,kind) {
  s.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,\'r\',?,\'queued\',\'fixture\',\'{}\')',id,kind);
  captureTaskConfiguration(s,id);return s.get('SELECT * FROM tasks WHERE id=?',id);
}
for (const format of ['default','legacy','v2']) test(`${format} projects use Manager for new work without changing event sources or saved authority`,t=>{
  const s=fixture(t);
  let original;
  if(format==='legacy') original={enabled:false,harnesses:{manager:'process',dev:'process'},roles:[]};
  if(format==='v2') {
    original=saveConfiguration(s,'r',{expected_revision:0,roles:[{role_id:'manager',permissions:{github_issues:'read',github_contents:'none'}},{role_id:'dev',budget_policy_ref:{id:'bounded',max_turns:6,max_output_tokens:512}}]},'owner');
    original={...original,enabled:false,controller:{role:'manager',entries:Object.fromEntries(entries.map(e=>[e,false]))}};
  }
  if(original)s.run("INSERT INTO settings VALUES('roles:r',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(original));
  const before=s.get("SELECT * FROM policies WHERE repository_id='r'"),raw=s.get("SELECT value FROM settings WHERE key='roles:r'")?.value;
  const current=roleConfiguration(s,'r');
  assert.equal(current.enabled,true);assert.ok(entries.every(entry=>current.controller.entries[entry]));
  for(const [i,kind] of ['development.issue','task.request','review.pr','actions.failures'].entries()) {
    const row=task(s,'new-'+i,kind);
    assert.equal(controlled(s,row,entries[i]),true);assert.equal(roleConfig(s,row).enabled,true);
  }
  assert.equal(s.get("SELECT value FROM settings WHERE key='roles:r'")?.value,raw,'reading/capturing must not rewrite old revisions');
  assert.deepEqual(s.get("SELECT * FROM policies WHERE repository_id='r'"),before);
  if(original?.schema===2) {
    assert.deepEqual(current.roles.map(r=>r.permissions),original.roles.map(r=>r.permissions));
    assert.deepEqual(current.roles.map(r=>r.budget_policy_ref),original.roles.map(r=>r.budget_policy_ref));
  }
  // Old clients can echo the retired values, but cannot disable Manager or erase an event's decision.
  const saved=saveConfiguration(s,'r',{expected_revision:current.revision,enabled:false,controller:{entries:{review:false,actions:false}},roles:[]},'owner');
  assert.equal(saved.enabled,true);assert.ok(entries.every(entry=>saved.controller.entries[entry]));
  assert.deepEqual(s.get("SELECT * FROM policies WHERE repository_id='r'"),before);
  assert.equal(roleConfiguration(s,'r').revision,saved.revision);
});

test('historical execution snapshots retain their routes while current project defaults ignore retired switches',t=>{
  const s=fixture(t),row=task(s,'old','review.pr'),fixed=taskConfiguration(s,row);
  fixed.roles.enabled=false;fixed.roles.controller.entries.review=false;
  s.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?',JSON.stringify(fixed),row.id);
  const bytes=s.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?',row.id).snapshot;
  saveConfiguration(s,'r',{expected_revision:0,roles:[]},'owner');
  assert.equal(controlled(s,row,'review'),false);assert.equal(roleConfig(s,row).enabled,false);
  assert.equal(controlled(s,task(s,'new','review.pr'),'review'),true);
  assert.equal(s.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?',row.id).snapshot,bytes);
});

test('event edits round-trip independently of role and prompt saves; live role permissions still revoke authority',t=>{
  const s=fixture(t),before=eventFilters(s,'r');let starts=0;
  saveManager(s,'r',{expected_revision:0,prompt:'Handle useful events.'},'owner');
  assert.deepEqual(eventFilters(s,'r'),before);
  saveManager(s,'r',{expected_revision:1,events:{'actions.run_failed':true}},'owner','console',()=>starts++);
  assert.equal(eventFilters(s,'r')['actions.run_failed'],true);assert.equal(starts,1);
  saveConfiguration(s,'r',{expected_revision:0,roles:[]},'owner');
  saveManager(s,'r',{expected_revision:2,prompt:'Preserve current event choices.'},'owner');
  assert.equal(eventFilters(s,'r')['actions.run_failed'],true);
  saveManager(s,'r',{expected_revision:3,events:{'actions.run_failed':false}},'owner');
  assert.equal(eventFilters(s,'r')['actions.run_failed'],false);assert.equal(starts,1);
  assert.equal(eventFilters(s,'r')['issue.mention'],false);
  const snapshot=resolveRole(s,'r','manager','actions.failures').snapshot;
  saveConfiguration(s,'r',{expected_revision:1,roles:[{role_id:'manager',permissions:{github_issues:'none'}}]},'owner');
  assert.equal(roleAuthority(s,'r',snapshot),'capability_revoked');
});
