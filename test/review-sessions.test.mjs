import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository} from './helpers.mjs';
import {enqueue,queueWebhook} from '../dist/review/queue.js';
import {ReviewUpdated,latestReviewSession,saveReviewSession,reviewObjectState,pruneReviewSessions,pendingReviewUpdates} from '../dist/review/sessions.js';
import {deleteProjectRecords} from '../dist/projects/removal.js';
import {GitHub} from '../dist/github/client.js';
import {Publisher} from '../dist/github/publisher.js';
import {Redactor} from '../dist/agent/common.js';

const user={id:5,login:'alice',type:'User'},issue={number:1,state:'open',user};
async function fixture(t){
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,development_enabled:true});return {...h,admin};
}
for(const status of ['queued','retry_wait','waiting_configuration','waiting_environment','running'])test(`26 updates including mentions stay on one ${status} review without truncation`,async t=>{
  const h=await fixture(t),id=enqueue(h.store,'101','review.issue',1,null,{issue});
  h.store.run('UPDATE tasks SET status=?,phase=? WHERE id=?',status,status==='running'?'prepare':'model',id);
  enqueue(h.store,'101','development.issue',1,null,{review:{}});
  for(let n=0;n<26;n++)assert.equal(queueWebhook(h.store,'101','issue_comment',{action:'created',issue,sender:user,comment:{id:n+1,body:n%2?'plain '+n:'@bot update '+n}},'update-'+n),0);
  const task=h.store.get('SELECT * FROM tasks WHERE id=?',id);
  assert.equal(task.status,status);assert.equal(JSON.parse(task.input).merged_updates.length,26);
  assert.equal(pendingReviewUpdates(h.store,task).length,26);
  assert.match(JSON.parse(pendingReviewUpdates(h.store,task).at(-1).data).comment.body,/25/);
  assert.equal(h.store.all("SELECT * FROM tasks WHERE kind LIKE 'review.%'").length,1);
  assert.equal(h.store.get("SELECT status FROM tasks WHERE kind='development.issue'").status,'queued');
  const count=h.store.get('SELECT count(*) n FROM review_updates').n;
  queueWebhook(h.store,'101','issue_comment',{action:'created',issue,sender:user,comment:{id:27,body:'@bot done <!-- dept-bot:marker -->'}},'own-comment');
  assert.equal(h.store.get('SELECT count(*) n FROM review_updates').n,count);
});

test('parallel reviews receive updates on the most recently claimed task and a fenced publication defers them',async t=>{
  const h=await fixture(t),old=enqueue(h.store,'101','review.issue',1,null,{},null,null,null,'older'),recent=enqueue(h.store,'101','review.issue',1,null,{},null,null,null,'recent');
  h.store.run("UPDATE tasks SET status='running'");h.store.run("INSERT INTO task_claims VALUES(?,'101','old','2026-11-01T00:00:00Z')",old);
  h.store.run("INSERT INTO task_claims VALUES(?,'101','recent','2026-11-01T01:00:00Z')",recent);
  const send=n=>queueWebhook(h.store,'101','issue_comment',{action:'created',issue,sender:user,comment:{id:n,body:'@bot update '+n}},'update-'+n);
  assert.equal(send(1),0);assert.equal(h.store.get('SELECT task_id FROM review_updates').task_id,recent);
  h.store.run('UPDATE tasks SET publication_started=1 WHERE id=?',recent);
  assert.equal(send(2),1);assert.equal(send(3),0);
  const next=h.store.get("SELECT * FROM tasks WHERE status='queued'");assert.equal(JSON.parse(next.input).wait_for_review,recent);
  assert.equal(pendingReviewUpdates(h.store,{id:old}).length,0);
  assert.deepEqual(h.store.all("SELECT status FROM tasks WHERE id IN (?,?)",old,recent).map(t=>t.status),['running','running']);
});

test('sessions are scoped by repository, kind and number, survive reopening/restart, expire after 15 days and delete with the project',async t=>{
  // Restart the Store without constructing another environment or reading container files.
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'102');
  const id=enqueue(h.store,'101','review.issue',1,null,{}),task=h.store.get('SELECT * FROM tasks WHERE id=?',id);
  h.store.run("UPDATE tasks SET status='succeeded',messages=? WHERE id=?",JSON.stringify([{role:'user',content:'earlier history',timestamp:1}]),id);
  saveReviewSession(h.store,task);
  assert.equal(latestReviewSession(h.store,task).task_id,id);
  for(const other of [{...task,kind:'review.pr'},{...task,object_number:2},{...task,repository_id:'102'}])assert.equal(latestReviewSession(h.store,other),undefined);
  for(const status of ['failed','cancelled','superseded','running']){
    h.store.run('UPDATE tasks SET status=? WHERE id=?',status,id);assert.equal(latestReviewSession(h.store,task),undefined);
  }
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id=?",id);
  await h.stop();await h.start();assert.equal(latestReviewSession(h.store,task).task_id,id);
  const now=Date.now();reviewObjectState(h.store,'101','review.issue',1,true,now-14*86400000);
  reviewObjectState(h.store,'101','review.issue',1,false,now);assert.ok(latestReviewSession(h.store,task));
  reviewObjectState(h.store,'101','review.issue',1,true,now-16*86400000);reviewObjectState(h.store,'101','review.issue',1,false,now);
  assert.equal(latestReviewSession(h.store,task),undefined);
  h.store.run('UPDATE tasks SET messages=? WHERE id=?','[]',id);saveReviewSession(h.store,task);
  reviewObjectState(h.store,'101','review.issue',1,true,now-16*86400000);pruneReviewSessions(h.store,now);
  assert.equal(h.store.get('SELECT count(*) n FROM review_sessions').n,0);
  h.store.run('UPDATE tasks SET messages=? WHERE id=?','[]',id);saveReviewSession(h.store,task);
  deleteProjectRecords(h.store,'101');assert.equal(h.store.get('SELECT count(*) n FROM review_sessions').n,0);assert.equal(h.store.get('SELECT count(*) n FROM review_objects').n,0);
});

test('PR new heads queue separately without injecting into the older workspace; close and draft cancellation remain',async t=>{
  const h=await fixture(t),oldHead='a'.repeat(40),head='b'.repeat(40),pr={...issue,draft:false,head:{sha:head}};
  const old=enqueue(h.store,'101','review.pr',1,oldHead,{pull_request:{...pr,head:{sha:oldHead}}});h.store.run("UPDATE tasks SET status='running' WHERE id=?",old);
  assert.equal(queueWebhook(h.store,'101','pull_request',{action:'synchronize',pull_request:pr,sender:user},'push'),1);
  const current=h.store.get('SELECT * FROM tasks WHERE id<>?',old);
  assert.equal(queueWebhook(h.store,'101','pull_request_review',{action:'submitted',pull_request:pr,sender:user,review:{body:'New head discussion',author_association:'MEMBER'}},'discussion'),0);
  assert.equal(pendingReviewUpdates(h.store,{id:old}).length,0);assert.equal(pendingReviewUpdates(h.store,current).length,1);
  queueWebhook(h.store,'101','pull_request',{action:'converted_to_draft',pull_request:{...pr,draft:true},sender:user},'draft');
  assert.deepEqual(h.store.all('SELECT status,error_code FROM tasks').map(t=>[t.status,t.error_code]),[['cancelled','object_closed_or_draft'],['cancelled','object_closed_or_draft']]);
  const dev=enqueue(h.store,'101','development.issue',1,null,{});queueWebhook(h.store,'101','issues',{action:'closed',issue:{...issue,state:'closed'},sender:user},'close');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?',dev).status,'cancelled');
});


test('the publication fence sees updates arriving during the final GitHub request guard',async t=>{
  const h=await fixture(t),id=enqueue(h.store,'101','review.issue',1,null,{}),task=h.store.get('SELECT * FROM tasks WHERE id=?',id);
  const github=new GitHub(h.store,h.store.get("SELECT * FROM repositories WHERE id='101'"),new Redactor(),async()=>{
    assert.equal(queueWebhook(h.store,'101','issue_comment',{action:'created',issue,sender:user,comment:{id:99,body:'@bot before HTTP'}},'before-write'),0);
  },'http://127.0.0.1:9');github.fullName='fixture/project-101';
  const publisher=new Publisher(h.store,github,task,async()=>{},undefined,undefined,()=>{
    assert.equal(pendingReviewUpdates(h.store,task).length,1);throw new ReviewUpdated();
  });
  await assert.rejects(publisher.discussion('discussion','Draft result'),ReviewUpdated);
  assert.equal(h.store.get('SELECT state FROM github_effects WHERE task_id=?',id).state,'pending');
  assert.equal(h.store.get('SELECT publication_started FROM tasks WHERE id=?',id).publication_started,0);
});
