import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';
import {GitHub} from '../dist/github/client.js';
import {Redactor} from '../dist/agent/common.js';

test('empty repository waits once and automatic retry completes the same review after the first commit',async t=>{
  const h=await emptyRepositoryFixture(t);let task=await h.run();
  assert.equal(task.status,'waiting_configuration');assert.equal(task.error_code,'repository_has_no_commit');assert.equal(task.phase,'prepare');assert.equal(task.retry_count,0);
  assert.ok(task.next_run_at>Date.now());assert.equal(h.comments.length,0);assert.equal(h.operations.includes('workspace_init'),false);
  const logs=()=>h.store.all('SELECT content FROM task_logs WHERE task_id=?',h.taskId).map(row=>JSON.parse(row.content));
  assert.deepEqual(logs().filter(log=>log.type==='fault'),[{type:'fault',state:'waiting_configuration',code:'repository_has_no_commit'}]);
  for(let i=0;i<3;i++){h.due();await h.run();}
  assert.equal(logs().filter(log=>log.type==='fault').length,1);
  h.setBranch('ready');h.due();task=await h.run();
  assert.equal(task.id,h.taskId);assert.equal(task.status,'succeeded');assert.equal(task.phase,'done');assert.equal(task.error_code,null);
  assert.equal(JSON.parse(task.input).snapshot_sha,h.commit);assert.ok(h.operations.includes('workspace_init'));assert.equal(h.comments.length,1);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,1);assert.ok(!JSON.stringify(logs()).includes('github_http_409'));
  h.due();await h.run();assert.equal(h.comments.length,1);
});

test('other ref conflicts still fail, and an empty-repository message does not suppress write conflicts',async t=>{
  const h=await emptyRepositoryFixture(t);h.setBranch('conflict');const task=await h.run();
  assert.equal(task.status,'failed');assert.equal(task.error_code,'github_http_409');assert.equal(h.comments.length,0);
  const github=new GitHub(h.store,h.store.get("SELECT * FROM repositories WHERE id='101'"),new Redactor(),async()=>{},h.githubUrl);
  github.fullName='fixture/project-101';github.token='fixture-only-token';
  await assert.rejects(github.request('PATCH',github.path('/git/refs/heads/main'),{sha:h.commit}),error=>error.code==='github_http_409'&&error.state==='failed');
});
