import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {Workspace} from '../dist/agent/workspace.js';
import {operationId,Redactor,TaskError} from '../dist/agent/common.js';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';

function workspaceFixture(t){
  const store=new Store(':memory:',Buffer.alloc(32));t.after(()=>store.close());
  store.run("INSERT INTO accounts VALUES('account','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project','10','account')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('task','101','review.issue','running','Fixture')");
  const calls=[],manager={async call(...args){calls.push(args);return {ok:true,result:{written:true}};}};
  const task={id:'task',repository_id:'101',attempt:1,generation:1,workspace_id:'workspace-a'},redactor=new Redactor();
  return {store,task,redactor,calls,workspace:new Workspace(store,manager,task,redactor,async()=>{},()=>{})};
}

test('same-key workspace conflicts name the changed fields without exposing request contents',async t=>{
  const cases=[
    ['workspace_id',{}, {workspace_id:'workspace-b'}],
    ['generation',{}, {generation:2}],
    ['path',{path:'other.txt'}],
    ['command',{command:'another command'}],
    ['offset',{offset:30000}],
    ['path、offset',{path:'other.txt',offset:30000}],
    ['请求内容不同',{base64:Buffer.from('changed secret content').toString('base64')}],
    ['请求内容不同',{type:'workspace_agent_config'}],
  ];
  for(const [index,[difference,change,taskChange]] of cases.entries())await t.test(`${index+1}: ${difference}`,async t=>{
    const f=workspaceFixture(t),key='prepare:file:0',secret='fixture-api-key',token='fixture-access-token';f.redactor.add(secret);
    const request={type:'workspace_write',path:'private-file.txt',command:'private command',offset:0,
      base64:Buffer.from(secret).toString('base64'),token,api_key:secret};
    await f.workspace.call(key,request);Object.assign(f.task,taskChange);
    await assert.rejects(f.workspace.call(key,{...request,...change}),error=>{
      assert.ok(error instanceof TaskError);assert.equal(error.code,'tool_operation_conflict');assert.equal(error.state,'failed');
      assert.ok(error.detail.includes(key));assert.ok(error.detail.includes('type='+(change.type||request.type)));
      assert.ok(error.detail.includes(difference));
      for(const field of ['generation','workspace_id','path','command','offset'])assert.equal(error.detail.includes(field),difference.includes(field),field);
      for(const value of ['base64',request.base64,secret,token,request.path,request.command,'changed secret content'])assert.ok(!error.detail.includes(value),value);
      return true;
    });
    assert.equal(f.calls.length,1,'a conflict never sends a second runner request');
  });
});

test('identical requests replay normally and pending conflicts redact secrets in operation keys',async t=>{
  const f=workspaceFixture(t),secret='fixture-secret-key',key='config:'+secret,request={type:'workspace_agent_config',base64:'c2VjcmV0',offset:0};
  f.redactor.add(secret);
  assert.deepEqual(await f.workspace.call(key,request),{written:true});
  assert.deepEqual(await f.workspace.call(key,request),{written:true});assert.equal(f.calls.length,1);
  f.store.run("UPDATE task_tools SET state='pending',result=NULL");f.task.workspace_id='replacement';
  await assert.rejects(f.workspace.call(key,request),error=>{
    assert.equal(error.code,'tool_operation_conflict');assert.match(error.detail,/workspace_id/);
    assert.ok(error.detail.includes('key=config:[REDACTED]'));assert.ok(!error.detail.includes(secret));assert.ok(!error.detail.includes(request.base64));return true;
  });
  assert.equal(f.calls.length,1);
});

test('workspace conflicts reach fault logs and the task detail through the existing API',async t=>{
  const h=await emptyRepositoryFixture(t);h.setBranch('ready');
  const key='prepare:init',task=h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId),id=operationId(`${task.id}:${task.attempt}:${key}`);
  h.store.run('UPDATE tasks SET workspace_id=? WHERE id=?','workspace-b',task.id);
  h.store.run("INSERT INTO task_tools VALUES(?,?,?,NULL,'pending')",id,task.id,JSON.stringify({operation_id:id,generation:1,
    request:{type:'workspace_init',author_email:'999+fixture-bot@users.noreply.github.com',workspace_id:'workspace-a'}}));
  const result=await h.run();assert.equal(result.status,'failed');assert.equal(result.error_code,'tool_operation_conflict');
  const detail=(await h.admin('/api/tasks/'+task.id)).value.task.error_detail;
  assert.match(detail,/key=prepare:init/);assert.match(detail,/type=workspace_init/);assert.match(detail,/workspace_id 不同/);
  const logs=(await h.admin('/api/tasks/'+task.id+'/logs')).value.logs.map(row=>JSON.parse(row.content));
  assert.equal(logs.find(log=>log.type==='fault').detail,detail);assert.ok(!detail.includes('base64'));
  assert.ok(!h.operations.includes('workspace_init'));
});

test('missing model configuration records a Chinese reason while existing fault logs stay unchanged',async t=>{
  const h=await emptyRepositoryFixture(t),old=JSON.stringify({type:'fault',state:'failed',code:'tool_operation_conflict'});
  h.store.run('UPDATE policies SET model_id=NULL WHERE repository_id=?','101');
  h.store.run("INSERT INTO task_logs(id,task_id,content) VALUES('old-fault',?,?)",h.taskId,old);
  const task=await h.run();assert.equal(task.status,'waiting_configuration');assert.equal(task.error_code,'model_not_configured');
  const detail=(await h.admin('/api/tasks/'+h.taskId)).value.task.error_detail;
  assert.match(detail,/仓库 101/);assert.match(detail,/未配置/);
  assert.equal(h.store.get("SELECT content FROM task_logs WHERE id='old-fault'").content,old);
});
