import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';

test('overview totals cover the authorized records before pagination and match each task drill-down', async t => {
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  for(let i=0;i<75;i++) h.store.run('INSERT INTO tasks(id,repository_id,kind,status,priority,summary) VALUES(?,?,?,?,?,?)',`old-${i}`,'101','review.issue','succeeded','P2','历史任务');
  for(const [id,status,priority] of [['active','validating','P1'],['publish','result_ready','P2'],['queued','queued','P2'],['blocked','waiting_configuration','P1'],['failed','failed','P2'],['automatic','retry_wait','P2']])
    h.store.run('INSERT INTO tasks(id,repository_id,kind,status,priority,summary) VALUES(?,?,?,?,?,?)',id,'101','development.issue',status,priority,id);
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('foreign','202','review.issue','failed','private foreign content')");
  const password=testPassword();await admin('/api/users','POST',{username:'overview-member',password,repository_ids:['101']});
  const member=h.client();await member('/api/auth/login','POST',{username:'overview-member',password});
  const audit=h.store.get('SELECT COUNT(*) AS n FROM audit').n;
  for(const [group,expected] of [['active',['active','publish']],['queued',['queued']],['attention',['blocked','failed']]]) {
    const result=await member('/api/tasks?summary=1&group='+group+'&limit=1');assert.equal(result.status,200);
    const {summary,tasks}=result.value;
    assert.deepEqual({...summary,sampled_at:null},{all:81,active:2,queued:1,attention:2,sampled_at:null});
    assert.ok(!Number.isNaN(Date.parse(summary.sampled_at)));assert.equal(tasks.length,1);
    const second=await member('/api/tasks?summary=1&group='+group+'&limit=1&offset=1');
    assert.deepEqual([...tasks,...second.value.tasks].map(row=>row.id).sort(),expected.sort());
    assert.ok(!JSON.stringify(result.value).includes('private foreign content'));
  }
  const priority=(await member('/api/tasks?summary=1&group=all&repository_id=101&priority=P1')).value;
  assert.equal(priority.summary.all,2);assert.equal(priority.summary.active,1);assert.equal(priority.summary.attention,1);
  assert.deepEqual((await member('/api/tasks?attention=1')).value.tasks.map(row=>row.id).sort(),['blocked','failed']);
  assert.equal((await member('/api/tasks?summary=1&repository_id=202')).status,403);
  assert.equal((await member('/api/tasks?group=unknown')).status,400);
  assert.equal((await member('/api/tasks?summary=true')).status,400);
  assert.equal((await member('/api/tasks?group=active&attention=1')).status,400);
  assert.equal((await member('/api/tasks?summary=1&offset=0.5')).status,400);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM audit').n,audit);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks').n,82);
  const user=h.store.get("SELECT id FROM users WHERE username='overview-member'");
  await admin('/api/project-admin-assignments','PUT',{user_id:user.id,repository_ids:[]});
  const empty=(await member('/api/tasks?summary=1&group=all')).value;
  assert.deepEqual({...empty.summary,sampled_at:null},{all:0,active:0,queued:0,attention:0,sampled_at:null});assert.deepEqual(empty.tasks,[]);
  assert.equal((await member('/api/tasks?summary=1&repository_id=101')).status,403);
});
