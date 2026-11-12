import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {scopeInstructions} from '../dist/tasks/scope.js';
import {taskTools} from '../dist/tasks/record-tools.js';
import {runRole} from '../dist/roles/run.js';
import {evaluateDelivery} from '../dist/tasks/acceptance.js';
import {Redactor} from '../dist/agent/common.js';
const unpack=v=>typeof v==='string'?(()=>{try{return unpack(JSON.parse(v));}catch{return v;}})():Array.isArray(v)?v.map(unpack).join(' '):v&&typeof v==='object'?Object.entries(v).map(([k,x])=>k+' '+unpack(x)).join(' '):String(v);
const call=(name,a,id='c')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(a)}}]});
async function setup(t,handler){
 const s=new Store(':memory:',randomBytes(32));s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/repo','o','a')");s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','import atomically','{}')");
 const records=new TaskRecords(s);records.contract('t',{goal:'Import without partial writes',scope:['one','two','three','four','five'],criteria:['Failure preserves existing data'],endpoint:'artifact'});
 const server=createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const message=await handler(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));}catch(e){res.writeHead(500);res.end(JSON.stringify({error:String(e)}));}});server.listen(0,'127.0.0.1');await once(server,'listening');
 s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','r','http://127.0.0.1:'+server.address().port+'/v1','fixture',s.secrets.seal({value:'test-key'},'model:m'),'now');s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
 t.after(()=>{s.close();server.closeAllConnections();server.close();});return {s,records,task:s.get("SELECT * FROM tasks WHERE id='t'")};
}
const note={source_version:'tree-new',paths:['src/shared/storage.ts'],necessity:'Atomic memory/review commit requires a shared authority',goal_relation:'Preserve data on import failure',impact:'Adapt readers and legacy migration; regression tests required',verification_refs:['task_history:1']};
test('range explanations are durable task facts, deduplicated and do not revise authority or contract',async t=>{
 const {s,records}=await setup(t,()=>call('unused',{}));const before=records.get('t');
 const a=records.tool('t','record_scope_difference',note);assert.equal(records.tool('t','record_scope_difference',note).ref,a.ref);
 assert.equal(records.get('t').revision,before.revision);assert.deepEqual(records.get('t').contract,before.contract);assert.equal(records.get('t').scope_differences.length,1);
 assert.equal(records.tool('t','record_scope_difference',{...note,grant_permissions:true}).error,'invalid_scope_difference');
 assert.ok(records.tool('t','read_task_history',{}).observations.some(r=>r.type==='scope_difference'));assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='scope_difference'").n,1);
});
test('same Dev records sixth-file rationale, Reviewer reads it and fresh QA accepts exact candidate without contract editing',async t=>{
 let stage='dev',devCalls=0,reviewRead=false;
 const f=await setup(t,body=>{
  const text=unpack(body.messages);assert.ok(text.includes('not a file allowlist'));
  if(stage==='dev')return ++devCalls===1?call('record_scope_difference',note):call('finish',{summary:'Atomic storage implemented'},'done');
  if(stage==='review'){
   if(!body.messages.some(m=>m.role==='tool'&&m.content?.includes('scope_difference')))return call('read_task_history',{});
   reviewRead=true;return call('finish',{summary:'Shared storage change necessary; regression evidence applies'},'reviewed');
  }
  if(stage==='dev-fix')return call('finish',{summary:'Addressed migration review in same Dev'},'fixed');
  assert.equal(body.messages.length,2);assert.ok(text.includes('version_matches_candidate true'));assert.ok(text.includes('Failure preserves existing data'));
  return call('submit_acceptance',{outcome:'pass',reason:'Reasoned expansion serves original goal; exact candidate verified',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true});
 });
 const spec={store:f.s,task:f.task,redactor:new Redactor(),guard:async()=>{},system:scopeInstructions,prompt:'Implement import',tools:[...taskTools,{type:'function',function:{name:'finish',description:'finish',parameters:{type:'object',properties:{summary:{type:'string'}}}}}],finish:{name:'finish',validate:v=>v},execute:(n,a)=>f.records.tool('t',n,a),maxTurns:4};
 const dev=await runRole(spec,'dev');stage='review';await runRole(spec,'reviewer');assert.equal(reviewRead,true);stage='dev-fix';const fix=await runRole(spec,'dev');assert.equal(fix.instance_id,dev.instance_id);
 const candidate=f.records.submit('t',[{kind:'report',reference:'fixture',version:'tree-new'}],[],fix.result);stage='qa';
 const verdict=await evaluateDelivery(f.s,f.task,{call:async()=>({})},new Redactor(),async()=>{},false);f.records.decide('t',candidate.id,candidate.revision,verdict);
 assert.equal(f.records.get('t').acceptance.outcome,'pass');assert.equal(f.records.get('t').revision,2);assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='intervention'").n,0);
});
test('fresh QA sees old scope notes as historical; explicit prohibitions and unexplained expansion can still fail',async t=>{
 for(const outcome of ['return','needs_human'])await t.test(outcome,async t=>{
  const f=await setup(t,body=>{const x=unpack(body.messages);assert.ok(x.includes('version_matches_candidate false'));assert.ok(x.includes('Explicit user prohibitions'));return call('submit_acceptance',{outcome,reason:outcome==='return'?'Unexplained unrelated expansion':'Explicit user prohibition requires a decision',gaps:['Specific unclosed gap'],residuals:[],core_complete:false,required_evidence_complete:true,acceptable_risk:false});});
  f.records.tool('t','record_scope_difference',note);f.records.submit('t',[{kind:'report',reference:'fixture',version:'different-tree'}],[],{});
  const verdict=await evaluateDelivery(f.s,f.task,{call:async()=>({})},new Redactor(),async()=>{},false);assert.equal(verdict.outcome,outcome);
 });
});
