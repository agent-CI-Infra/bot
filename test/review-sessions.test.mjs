import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository} from './helpers.mjs';
import {enqueue,queueWebhook} from '../dist/review/queue.js';
import {ReviewUpdated,reviewObjectState,pendingReviewUpdates} from '../dist/review/sessions.js';
import {deleteProjectRecords} from '../dist/projects/removal.js';
import {continueFinishedReview,resumeFinishedReviews} from '../dist/review/continuation.js';
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

test('parallel reviews receive updates on the most recently claimed task, which answers those after its publication in its next round',async t=>{
  const h=await fixture(t),old=enqueue(h.store,'101','review.issue',1,null,{},null,null,null,'older'),recent=enqueue(h.store,'101','review.issue',1,null,{},null,null,null,'recent');
  h.store.run("UPDATE tasks SET status='running'");h.store.run("INSERT INTO task_claims VALUES(?,'101','old','2026-11-01T00:00:00Z')",old);
  h.store.run("INSERT INTO task_claims VALUES(?,'101','recent','2026-11-01T01:00:00Z')",recent);
  const send=n=>queueWebhook(h.store,'101','issue_comment',{action:'created',issue,sender:user,comment:{id:n,body:'@bot update '+n}},'update-'+n);
  assert.equal(send(1),0);assert.equal(h.store.get('SELECT task_id FROM review_updates').task_id,recent);
  // The agent took the first update; then the review started publishing. It finishes that publication, and what comes
  // meanwhile still joins it (#770) instead of queueing another review.
  h.store.run('UPDATE tasks SET publication_started=1,review_update_cursor=(SELECT max(id) FROM review_updates) WHERE id=?',recent);
  assert.equal(send(2),0);assert.equal(send(3),0);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,2);
  assert.equal(pendingReviewUpdates(h.store,{id:recent}).length,2);assert.equal(pendingReviewUpdates(h.store,{id:old}).length,0);
  // The publication succeeded, but its run still holds the claim: the next round starts when the engine lets go.
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id=?",recent);
  assert.equal(continueFinishedReview(h.store,recent),false);
  h.store.run('DELETE FROM task_claims WHERE task_id=?',recent);assert.equal(continueFinishedReview(h.store,recent),true);
  const next=h.store.get('SELECT * FROM tasks WHERE id=?',recent),input=JSON.parse(next.input);
  assert.deepEqual([next.status,next.phase,next.attempt,input.round],['queued','prepare',2,2]);
  // Shaped like a review those updates would have created: the latest comment is the trigger, the earlier one is merged.
  assert.equal(input.comment.id,3);assert.equal(input.trigger.source.id,3);assert.deepEqual(input.merged_updates.map(update=>update.source.id),[2]);
  assert.equal(continueFinishedReview(h.store,recent),false);
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?',old).status,'running');
});

test('a finished review takes the next update as its next round, once; a push of a head it read needs none',async t=>{
  const h=await fixture(t),head='a'.repeat(40),pr={...issue,draft:false,head:{sha:head}};
  const id=enqueue(h.store,'101','review.pr',1,head,{pull_request:pr});
  h.store.run("UPDATE tasks SET status='succeeded',phase='done',result=?,input=json_set(input,'$.heads',json_array(?)) WHERE id=?",
    JSON.stringify({summary:'One finding.',reviewed_sha:head,findings:[{body:'Off by one.',format:'inline',path:'a.js',line:3}],outputs:[{html_url:'https://github.invalid/c/1'}]}),head,id);
  // A push of the head the review already published on (the webhook came late): answered, no round, and not asked again.
  h.store.run("INSERT INTO review_updates(task_id,event_key,data) VALUES(?,'late',?)",id,JSON.stringify({reason:'pushed',after:head}));
  assert.equal(continueFinishedReview(h.store,id),false);
  assert.equal(h.store.get('SELECT review_update_cursor c FROM tasks WHERE id=?',id).c,h.store.get('SELECT max(id) m FROM review_updates').m);
  // The Manager is offered the finished review to continue, and no new review of the push.
  const next='b'.repeat(40);
  assert.equal(queueWebhook(h.store,'101','pull_request',{action:'synchronize',before:head,pull_request:{...pr,head:{sha:next}},sender:user},'push'),0);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,1);
  const task=h.store.get('SELECT * FROM tasks WHERE id=?',id),input=JSON.parse(task.input);
  assert.deepEqual([task.status,task.attempt,input.round],['queued',2,2]);
  // A push asks nobody's question: no trigger, the push is the update; the earlier result is summarized for a fresh session.
  assert.equal(input.trigger,undefined);assert.deepEqual(input.merged_updates.map(update=>[update.reason,update.after]),[['pushed',next]]);
  const {finished_at,...previous}=input.previous_result;assert.ok(finished_at);
  assert.deepEqual(previous,{round:1,reviewed_sha:head,summary:'One finding.',findings:[{body:'Off by one.',format:'inline',path:'a.js',line:3}],published:['https://github.invalid/c/1']});
  const log=h.store.all('SELECT content FROM task_logs WHERE task_id=?',id).map(row=>JSON.parse(row.content)).find(value=>value.type==='continued');
  assert.deepEqual([log.round,log.updates,log.reasons],[2,1,['pushed']]);
  // While the round waits, the next push joins it as an ordinary update.
  assert.equal(queueWebhook(h.store,'101','pull_request',{action:'synchronize',before:next,pull_request:{...pr,head:{sha:'c'.repeat(40)}},sender:user},'push-2'),0);
  assert.equal(JSON.parse(h.store.get('SELECT input FROM tasks WHERE id=?',id).input).round,2);
  // After a restart, a finished review whose round was due (its run ended as the process stopped) starts it.
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id=?",id);
  resumeFinishedReviews(h.store);
  assert.deepEqual(Object.values(h.store.get('SELECT status,attempt FROM tasks WHERE id=?',id)),['queued',3]);
});

test('a next round keeps each role instance\'s Pi session binding, clears other backends and keeps no conversation copy',async t=>{
  const h=await fixture(t),id=enqueue(h.store,'101','review.issue',1,null,{issue});
  h.store.run("UPDATE tasks SET status='succeeded',phase='done',result=? WHERE id=?",JSON.stringify({summary:'Reviewed.',findings:[]}),id);
  // Bindings as the harnesses save them: Pi's session and file (src/roles/harness.ts), and a Codex thread.
  const pi={harness:'pi',sessionId:'s1',transcript:'/workspace/tasks/'+'c'.repeat(48)+'/cli-state/pi/dev-instance/sessions/a_s1.jsonl'};
  for(const [role,harness,state] of [['dev','pi',pi],['manager','codex',{sessionId:'thread-1'}]])
    h.store.run('INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at,harness_state,session) VALUES(?,?,?,?,?,?,?,?)',role+'-instance',id,role,'{}',harness,'now',JSON.stringify(state),'[{"role":"user","content":"x"}]');
  h.store.run("INSERT INTO review_updates(task_id,event_key,data) VALUES(?,'next',?)",id,JSON.stringify({reason:'commented',actor:'alice'}));
  assert.equal(continueFinishedReview(h.store,id),true);
  // #1040: the next round reopens the Pi session it had; other backends start again as before.
  assert.deepEqual(h.store.all('SELECT role,harness_state,session FROM role_instances ORDER BY role').map(r=>[r.role,JSON.parse(r.harness_state),r.session]),[['dev',pi,'[]'],['manager',{},'[]']]);
  // The conversation lives in the session file only: the control plane keeps no copy, and project removal still works.
  assert.equal(h.store.get("SELECT count(*) n FROM sqlite_master WHERE name='review_sessions'").n,0);
  reviewObjectState(h.store,'101','review.issue',1,true);
  deleteProjectRecords(h.store,'101');assert.equal(h.store.get('SELECT count(*) n FROM review_objects').n,0);assert.equal(h.store.get('SELECT count(*) n FROM role_instances').n,0);
});

test('a new PR head joins the running review as an update, like discussion of any head; close and draft cancellation remain',async t=>{
  const h=await fixture(t),oldHead='a'.repeat(40),head='b'.repeat(40),pr={...issue,draft:false,head:{sha:head}};
  const old=enqueue(h.store,'101','review.pr',1,oldHead,{pull_request:{...pr,head:{sha:oldHead}}});h.store.run("UPDATE tasks SET status='running' WHERE id=?",old);
  assert.equal(queueWebhook(h.store,'101','pull_request',{action:'synchronize',before:oldHead,pull_request:pr,sender:user},'push'),0);
  assert.equal(queueWebhook(h.store,'101','pull_request_review',{action:'submitted',pull_request:pr,sender:user,review:{body:'New head discussion',author_association:'MEMBER'}},'discussion'),0);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,1);
  assert.deepEqual(pendingReviewUpdates(h.store,{id:old}).map(row=>JSON.parse(row.data)).map(({reason,before,after})=>({reason,before,after})),
    [{reason:'pushed',before:oldHead,after:head},{reason:'review_submitted',before:undefined,after:undefined}]);
  assert.deepEqual(JSON.parse(h.store.get('SELECT input FROM tasks WHERE id=?',old).input).merged_updates.map(update=>update.reason),['pushed','review_submitted']);
  // A review that has started publishing finishes on the head it reviewed; a push meanwhile still joins it, for its next round.
  h.store.run('UPDATE tasks SET publication_started=1 WHERE id=?',old);
  assert.equal(queueWebhook(h.store,'101','pull_request',{action:'synchronize',pull_request:{...pr,head:{sha:'c'.repeat(40)}},sender:user},'push-2'),0);
  assert.equal(JSON.parse(pendingReviewUpdates(h.store,{id:old}).at(-1).data).after,'c'.repeat(40));
  queueWebhook(h.store,'101','pull_request',{action:'converted_to_draft',pull_request:{...pr,draft:true},sender:user},'draft');
  assert.deepEqual(h.store.all('SELECT status,error_code FROM tasks').map(t=>[t.status,t.error_code]),[['cancelled','object_closed_or_draft']]);
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
