// Opt-in real model validation; GitHub transport is controlled and Git/runner/SQLite are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './integration-engine.test.mjs';
import {Store} from '../dist/storage/database.js';
import {evaluateDelivery} from '../dist/tasks/acceptance.js';
import {acceptanceFixture} from './acceptance-fixture.mjs';
import {TaskRecords} from '../dist/tasks/service.js';

test('live C replay: published PR QA return resumes real Manager/Dev and passes fresh QA',{
 skip:!process.env.BOT_C_REPLAY_RUNTIME,timeout:Number(process.env.BOT_C_REPLAY_TIMEOUT_MS)||600000
},async t=>{
 const root=process.env.BOT_C_REPLAY_RUNTIME;mkdirSync(root,{recursive:true});
 const raw=readFileSync(process.env.BOT_C_REPLAY_KEY),key=raw.length===32?raw:Buffer.from(raw.toString().trim(),'hex');
 const source=new Store(process.env.BOT_C_REPLAY_MODEL_DB,key),model=source.get("SELECT * FROM models WHERE id='manager-model'");
 const credential=source.secrets.open(model.api_key,'model:'+model.id).value;source.close();
 const h=await fixture(t,'clean',{
  respond:async body=>{
   const response=await fetch(model.api_url+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify({...body,model:model.model_name,stream:false}),signal:AbortSignal.timeout(120000)});
   if(!response.ok)throw Error('live_model_http_'+response.status);return (await response.json()).choices[0].message;
  },
  // Seed the already published, historically accepted PR; every subsequent QA is the real evaluator.
  evaluate:async(n,...args)=>n===1?acceptanceFixture(...args):evaluateDelivery(...args)
 });
 const snapshot=()=>{try{h.s.db.exec('PRAGMA wal_checkpoint(FULL)');copyFileSync(join(h.root,'control.sqlite'),join(root,'control.sqlite'));chmodSync(join(root,'control.sqlite'),0o600);writeFileSync(join(root,'progress.json'),JSON.stringify({at:new Date().toISOString(),tasks:h.s.all('SELECT status,phase,error_code FROM tasks'),runs:h.s.all('SELECT role,status FROM task_runs'),requests:h.counts()}));}catch{}};
 const timer=setInterval(snapshot,30000);t.after(()=>{clearInterval(timer);snapshot();});
 new TaskRecords(h.s).contract('t',{goal:'Return the product of a.txt and b.txt clamped to [0,2], preserving unrelated features.',scope:['calc.cjs and relevant tests'],criteria:['Any numeric inputs produce Math.max(0, Math.min(2, a*b)); include negative and above-limit cases','Preserve unrelated files and pass node check.cjs'],endpoint:'reviewable_pull_request',source:{kind:'request'},completeness:'explicit'});
 try{
  h.engine.tick();await Promise.all(h.engine.active.values());let task=h.s.get("SELECT * FROM tasks WHERE id='t'");assert.equal(task.status,'pr_opened',JSON.stringify(task));const first=JSON.parse(task.result);
  await h.engine.api({id:'operator',role:'super_admin',repositories:[]},'POST',new URL('http://local/api/tasks/t/merge'),{expected_sha:first.sha,merge_method:'merge'});
  for(let attempt=0;attempt<5;attempt++){
   h.s.run("UPDATE tasks SET next_run_at=0 WHERE id='t'");h.engine.tick();await Promise.all(h.engine.active.values());task=h.s.get("SELECT * FROM tasks WHERE id='t'");
   if(['completed','pr_opened'].includes(task.status))break;
   assert.equal(task.status,'queued',JSON.stringify(task));
  }
  assert.ok(['completed','pr_opened'].includes(task.status),JSON.stringify(task));assert.equal(JSON.parse(task.result).pr_number,first.pr_number);
  const verdicts=h.s.all("SELECT data FROM task_history WHERE type='acceptance_evaluated'").map(r=>JSON.parse(r.data).verdict);
  assert.ok(verdicts.some(v=>v.outcome==='return'),'actual QA must discover the seeded clamping defect');assert.equal(verdicts.at(-1).outcome,'pass');
  assert.ok(h.s.get("SELECT count(*) n FROM task_runs WHERE role='manager'").n>0);assert.ok(h.s.get("SELECT count(*) n FROM task_runs WHERE role='dev'").n>0);
  h.s.run('UPDATE task_merge_requests SET next_run_at=0');h.engine.tick();await Promise.all(h.engine.merging.values());assert.equal(h.counts().puts,1);
  assert.equal(h.git(['show',h.main+':other.txt']),'independent feature');
  writeFileSync(join(root,'result.json'),JSON.stringify({valid:true,model:model.model_name,counts:h.counts(),verdicts,notice:'Initial published candidate/acceptance seeded; QA return and repair use real Native Manager, Dev and QA. Controlled GitHub transport; no real GitHub PR modified.'},null,2));
 }finally{
  h.s.db.exec('PRAGMA wal_checkpoint(FULL)');copyFileSync(join(h.root,'control.sqlite'),join(root,'control.sqlite'));chmodSync(join(root,'control.sqlite'),0o600);
 }
});
