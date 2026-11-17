import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/storage/database.js';
import {Workspace} from '../dist/agent/workspace.js';
import {Redactor} from '../dist/agent/common.js';
import {operationRequestText} from '../dist/storage/payloads.js';
import {sanitizeTrajectoryInput} from '../manager/projects.mjs';
test('private runner configs retain only a digest and redacted body, including durable trajectory replay',async t=>{
 const root=mkdtempSync(join(tmpdir(),'private-runner-')),s=new Store(join(root,'control.sqlite'),Buffer.alloc(32,7));t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
 s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/repo','1','a')");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,workspace_id) VALUES('t','r','task.request','running','private config','{}','workspace')");
 const secret='fixture-native-provider-secret',base64=Buffer.from(JSON.stringify({native_model:{key:secret}})).toString('base64');let deliveries=0;
 const manager={call:async(_m,_p,body)=>{assert.equal(body.request.base64,base64);deliveries++;return {ok:true,result:{saved:true}};}};
 for(const trace_run_id of [undefined,'private-run']){
  const workspace=new Workspace(s,manager,{...s.get("SELECT * FROM tasks WHERE id='t'"),trace_run_id},new Redactor(),async()=>{},()=>{});
  for(const type of ['workspace_agent_config','workspace_harness_config','workspace_agent_token']){
   const key=String(trace_run_id)+type,input={type,base64,offset:0,final:true};
   await workspace.call(key,input);await workspace.call(key,input);
   const row=s.get('SELECT * FROM task_tools ORDER BY rowid DESC LIMIT 1'),recorded=operationRequestText(s,'task_tools',row);
   assert.ok(row.request_sha256);assert.equal(recorded.includes(secret),false);assert.equal(recorded.includes(base64),false);assert.equal(JSON.parse(recorded).request.base64,'[redacted]');
   const ledger=JSON.stringify(sanitizeTrajectoryInput({request:input}));assert.equal(ledger.includes(base64),false);assert.equal(ledger.includes(secret),false);
   await assert.rejects(workspace.call(key,{...input,base64:Buffer.from('different credential').toString('base64')}),{code:'tool_operation_conflict'});
  }
 }
 assert.equal(deliveries,6,'cached receipt replays without sending private config again');
});
