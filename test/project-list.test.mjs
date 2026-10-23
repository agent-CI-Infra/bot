import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository,testPassword} from './helpers.mjs';

test('project lists count all executing and queued tasks without including waiting or finished work, within administrator scope',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  const insert=(id,repo,status)=>h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,?,?,?,?)',id,repo,'review.issue',status,'fixture task');
  insert('running','101','running');insert('other','202','running');
  for(let i=0;i<65;i++)insert('queued-'+i,'101','queued');
  for(const status of ['waiting_configuration','waiting_environment','waiting_pr_head','retry_wait','failed','succeeded','completed','cancelled','superseded'])insert(status,'101',status);
  const counts=rows=>rows.map(r=>[r.id,r.running_tasks,r.queued_tasks]);
  assert.deepEqual(counts((await admin('/api/repositories')).value.repositories),[['101',1,65],['202',1,0]]);
  assert.deepEqual(counts((await admin('/api/installations')).value.repositories),[['101',1,65],['202',1,0]]);
  for(const status of ['preparing','implementing','validating','publishing','result_ready']){
    h.store.run('UPDATE tasks SET status=? WHERE id=?',status,'running');
    assert.equal((await admin('/api/repositories')).value.repositories[0].running_tasks,1);
  }
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id='running'");
  h.store.run("UPDATE tasks SET status='running' WHERE id='queued-0'");
  assert.deepEqual(counts((await admin('/api/repositories')).value.repositories),[['101',1,64],['202',1,0]]);
  const password=testPassword();await admin('/api/users','POST',{username:'member',password,repository_ids:['101']});
  const member=h.client();await member('/api/auth/login','POST',{username:'member',password});
  assert.deepEqual(counts((await member('/api/repositories')).value.repositories),[['101',1,64]]);
  assert.equal((await member('/api/installations')).status,403);
  assert.equal((await member('/api/repositories/202/policy','PATCH',{review_enabled:true})).status,403);
  assert.equal((await member('/api/repositories/101/policy','PATCH',{development_enabled:true})).status,200);
  assert.equal((await member('/api/repositories/101/policy','PATCH',{review_enabled:true})).status,200);
  const policy=(await admin('/api/repositories/101')).value.policy;
  assert.equal(policy.review_enabled,1);assert.equal(policy.development_enabled,1);
  assert.equal((await admin('/api/repositories/202')).value.policy.review_enabled,0);
  await admin('/api/project-admin-assignments','PUT',{user_id:(await admin('/api/users')).value.users.find(u=>u.username==='member').id,repository_ids:[]});
  assert.deepEqual((await member('/api/repositories')).value.repositories,[]);
});
