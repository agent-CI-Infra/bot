import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from './helpers.mjs';
import { TaskRecords } from '../dist/tasks/service.js';
import { evaluateDelivery } from '../dist/tasks/acceptance.js';
import { Redactor } from '../dist/agent/common.js';
import { TaskEngine } from '../dist/agent/engine.js';
const pass={outcome:'pass',reason:'Raw artifact meets the requested contract',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
async function fixture(t,respond){
 const requests=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);const result=respond(body,requests.length);res.writeHead(result.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(result.status?{error:{message:'temporary outage'}}:{choices:[{message:result}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const m=(await admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,model_name:'fixture',api_key:'fixture-model-credential'})).value.model;
 await admin('/api/repositories/101/policy','PATCH',{model_id:m.id});
 h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,messages) VALUES('delivery','101','review.issue','running','Report actual observations',?)",JSON.stringify([{role:'assistant',content:'PRIVATE_EXECUTOR_CONVERSATION_SENTINEL'}]));
 const records=new TaskRecords(h.store);records.contract('delivery',{goal:'Report actual observations',scope:['report'],criteria:['Read artifact and verify its observed contents'],endpoint:'report',source:'request'});
 records.submit('delivery',[{kind:'report',reference:'report.md',version:'v1',content:'Executor claims verified'}],[{source:'executor',version:'v1',verified:false,result:'self-reported success'}],{summary:'claim'});
 const task=h.store.get("SELECT * FROM tasks WHERE id='delivery'");return {h,admin,records,task,requests};
}
test('real evaluator starts fresh, can inspect raw artifacts, records separate model cost and exposes no publication tools',async t=>{
 const f=await fixture(t,(body,n)=>n===1?{role:'assistant',content:null,tool_calls:[{id:'read1',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'report.md'})}}]}:{role:'assistant',content:JSON.stringify(pass)});
 const reads=[];const workspace={call:async(_key,r)=>{reads.push(r);return {content:'Actual observed artifact'};}};
 const verdict=await evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{},false);
 assert.equal(verdict.outcome,'pass');assert.equal(reads[0].path,'report.md');
 assert.equal(f.requests[0].messages.length,2);assert.ok(!JSON.stringify(f.requests).includes('PRIVATE_EXECUTOR_CONVERSATION_SENTINEL'));
 assert.deepEqual(f.requests[0].tools.map(t=>t.function.name),['read_evidence','read_task_history','read_file','submit_acceptance']);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_evidence'").n,1);
 assert.equal(f.h.store.get('SELECT count(*) n FROM model_requests WHERE task_id=?',f.task.id).n,2);
});
test('an evaluator outage is recoverable infrastructure failure, does not reject or complete the candidate',async t=>{
 const f=await fixture(t,(_b,n)=>n<=3?{status:503}:{role:'assistant',content:JSON.stringify(pass)});
 await assert.rejects(evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{}),{code:'model_http_503',state:'retry_wait'});
 assert.equal(f.records.get(f.task.id).acceptance,null);assert.equal(f.records.get(f.task.id).rounds,0);
 const verdict=await evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{});const c=f.records.get(f.task.id).candidate;f.records.decide(f.task.id,c.id,c.revision,verdict);
 assert.equal(f.records.get(f.task.id).progress.status,'completed');
});
test('a self report without required raw evidence is insufficient, and malformed passing verdict is rejected',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify({...pass,outcome:'insufficient_evidence',required_evidence_complete:false,gaps:['Read raw artifact before accepting']})}));
 const verdict=await evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{});assert.equal(verdict.outcome,'insufficient_evidence');
});
test('ordinary request API validates contracts, creates structured tasks and enforces repository grants',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 const engine=new TaskEngine(f.h.store,{call:async()=>null});engine.tick=()=>{};
 const user={id:'u',role:'project_admin',repositories:['101'],username:'u',csrf:'csrf'};
 const body={repository_id:'101',request:'Inspect the current code',contract:{goal:'Inspect current code',scope:['report'],criteria:['Cite actual paths'],endpoint:'report'}};
 const result=await engine.api(user,'POST',new URL('http://local/api/tasks'),body);
 assert.equal(new TaskRecords(f.h.store).get(result.id).contract.completeness,'explicit');
 await assert.rejects(engine.api({...user,repositories:[]},'POST',new URL('http://local/api/tasks'),body),{code:'repository_forbidden'});
 await assert.rejects(engine.api(user,'POST',new URL('http://local/api/tasks'),{...body,contract:{goal:'Missing criteria'}}),{code:'invalid_task_contract'});
 assert.equal(f.h.store.get('SELECT count(*) n FROM tasks').n,2);
});

test('human contract revision resumes a paused task, preserves history and rejects stale or published rewrites',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 const engine=new TaskEngine(f.h.store,{call:async()=>null});engine.tick=()=>{};
 const user={id:'u',role:'project_admin',repositories:['101'],username:'u',csrf:'csrf'};
 const c=f.records.get('delivery').candidate;
 f.records.decide('delivery',c.id,c.revision,{...pass,outcome:'needs_human',core_complete:false,gaps:['Decide report scope']});
 const contract={goal:'Use the clarified scope',scope:['report'],criteria:['Cite the decided source'],endpoint:'report'};
 const url=new URL('http://local/api/tasks/delivery/contract');
 const result=await engine.api(user,'PATCH',url,{expected_revision:c.revision,contract});
 assert.equal(result.task.progress.status,'queued');assert.equal(result.task.contract.goal,contract.goal);assert.equal(result.task.candidate,null);
 assert.ok(f.h.store.get("SELECT 1 FROM task_history WHERE task_id='delivery' AND type='acceptance'"));
 await assert.rejects(engine.api(user,'PATCH',url,{expected_revision:c.revision,contract}),{code:'task_revision_changed'});
 f.h.store.run("INSERT INTO github_effects VALUES('effect','delivery','comment','{}','sent','{}','marker')");
 await assert.rejects(engine.api(user,'PATCH',url,{expected_revision:result.task.revision,contract}),{code:'task_contract_after_publication'});
});
test('project context API persists sourced facts, rejects lost updates and checks access',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)})),engine=new TaskEngine(f.h.store,{call:async()=>null});
 const user={id:'u',role:'project_admin',repositories:['101'],username:'u',csrf:'csrf'},url=new URL('http://local/api/repositories/101/context');
 const body={expected_revision:0,facts:[{source:'repo:commit',fact:'Tests run with npm test'}]};
 const result=await engine.api(user,'PATCH',url,body);assert.equal(result.context.revision,1);
 await assert.rejects(engine.api(user,'PATCH',url,body),{code:'project_revision_changed'});
 await assert.rejects(engine.api({...user,repositories:[]},'GET',url,{}),{code:'repository_forbidden'});
});

test('failed verifier preparation is released and leaves no passing decision',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 f.task.workspace_id='a'.repeat(48);f.task.generation=1;
 f.records.submit(f.task.id,[{kind:'code',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40)}}],[],{summary:'claim'});
 const calls=[],workspace={manager:{call:async(_m,_p,input)=>{calls.push(input.request);return {ok:false,error:'injected snapshot failure'};}},log:()=>{}};
 await assert.rejects(evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{}),{code:'acceptance_snapshot_unavailable'});
 assert.equal(calls.filter(r=>r.type==='reap').length,1);assert.equal(f.records.get(f.task.id).acceptance,null);
});

test('only a trusted runtime budget can raise provider output tokens; model request fields remain bounded',async t=>{
 const {runAgent}=await import('../dist/agent/runtime.js');
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 await runAgent({store:f.h.store,task:f.task,redactor:new Redactor(),guard:async()=>{},system:'Return JSON',prompt:'Return the result',maxOutputTokens:16384});
 assert.equal(f.requests.at(-1).max_completion_tokens,16384);
 await assert.rejects(runAgent({store:f.h.store,task:f.task,redactor:new Redactor(),guard:async()=>{},system:'Return JSON',prompt:'Return result',maxOutputTokens:32769}),{code:'agent_limits_invalid'});
});

test('a missing current policy proof runs deterministic verification and returns a real failed check without model approval',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 f.h.store.run("UPDATE policies SET test_command='required-check' WHERE repository_id='101'");f.task.workspace_id='a'.repeat(48);f.task.generation=1;
 f.records.submit(f.task.id,[{kind:'code',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40)}}],[],{});
 const calls=[],workspace={manager:{call:async(_m,_p,input)=>{calls.push(input.request);return {ok:true,result:input.request.type==='workspace_command'?{exit_code:1,output:'A real mandatory check failed'}:{tree_sha:'b'.repeat(40)}};}},log:()=>{}};
 const result=await evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{});
 assert.equal(result.outcome,'return');assert.ok(result.gaps[0].includes('mandatory check failed'));assert.equal(f.requests.length,0);assert.ok(calls.some(r=>r.command==='required-check'));
});

test('verification commands reject copied executor paths and recover in the pinned candidate checkout',async t=>{
 const source='a'.repeat(48),calls=[];
 const f=await fixture(t,(_body,n)=>n<3?{role:'assistant',content:null,tool_calls:[{id:'command'+n,type:'function',function:{name:'run_command',arguments:JSON.stringify({command:n===1?'cat /tasks/'+source+'/repo/report.md':'cat report.md'})}}]}:{role:'assistant',content:JSON.stringify(pass)});
 f.task.workspace_id=source;f.task.generation=1;
 f.records.submit(f.task.id,[{kind:'files',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40)}}],[],{});
 const workspace={manager:{call:async(_m,_p,input)=>{calls.push(input.request);return {ok:true,result:input.request.type==='workspace_command'?{exit_code:0,output:'pinned report'}:{tree_sha:'b'.repeat(40)}};}},log:()=>{}};
 assert.equal((await evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{})).outcome,'pass');
 const commands=calls.filter(r=>r.type==='workspace_command');assert.equal(commands.length,1);assert.equal(commands[0].command,'cat report.md');assert.notEqual(commands[0].workspace_id,source);
 assert.ok(JSON.stringify(f.requests[1].messages).includes('executor_workspace_reference'));
});

test('verdict format repair keeps fresh inspection evidence and does not rerun successful reads',async t=>{
 const f=await fixture(t,(body,n)=>{
  if(n===1)return {role:'assistant',content:null,tool_calls:[{id:'inspect',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'report.md'})}}]};
  if(n===2)return {role:'assistant',content:JSON.stringify({outcome:'pass',reason:'Read the artifact but omitted fields'})};
  assert.ok(body.messages.at(-1).content.includes('do not repeat verification'));
  return {role:'assistant',content:JSON.stringify(pass)};
 });
 let reads=0;const result=await evaluateDelivery(f.h.store,f.task,{call:async()=>{reads++;return {content:'Actual report'};}},new Redactor(),async()=>{});
 assert.equal(result.outcome,'pass');assert.equal(reads,1);assert.equal(f.requests.length,3);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_format_error'").n,1);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_fault'").n,0);
 assert.equal(f.records.get(f.task.id).acceptance,null,'format repair cannot finalize delivery');
});
test('format feedback can correct an invalid pass into a truthful return instead of relaxing core conditions',async t=>{
 const f=await fixture(t,(_body,n)=>({role:'assistant',content:JSON.stringify(n===1?{...pass,core_complete:false}:{...pass,outcome:'return',core_complete:false,gaps:['A required behavior is absent']})}));
 const result=await evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{});
 assert.equal(result.outcome,'return');assert.equal(result.core_complete,false);assert.equal(f.requests.length,2);assert.equal(f.records.get(f.task.id).acceptance,null);
});
test('unrepairable verdicts have two format corrections and a finite evaluation-fault exit',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:'{}'}));
 for(let i=0;i<3;i++)await assert.rejects(evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{}),{code:i===2?'acceptance_unavailable':'acceptance_output_invalid'});
 assert.equal(f.requests.length,9);assert.equal(f.records.get(f.task.id).rounds,0);assert.equal(f.records.get(f.task.id).acceptance,null);
});

test('typed acceptance submission repairs schema errors while preserving a real core gap',async t=>{
 const f=await fixture(t,(_body,n)=>({role:'assistant',content:null,tool_calls:[{id:'verdict'+n,type:'function',function:{name:'submit_acceptance',arguments:JSON.stringify(n===1?{...pass,core_complete:false}:{...pass,outcome:'return',core_complete:false,gaps:['Required behavior is absent']})}}]}));
 const verdict=await evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{});
 assert.equal(verdict.outcome,'return');assert.equal(verdict.core_complete,false);assert.equal(f.requests.length,2);
 assert.ok(f.requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('invalid_submission')));
 assert.equal(f.records.get(f.task.id).acceptance,null);
});
test('a fresh evaluation reuses hash-addressed raw verification only for the same candidate and revision',async t=>{
 const {readEvidence,previousVerificationEvidence}=await import('../dist/tasks/evidence.js');
 const f=await fixture(t,(body,n)=>{
  if(n===1)return {role:'assistant',content:null,tool_calls:[{id:'raw-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'report.md'})}}]};
  if(n>=2&&n<=4)return {status:503};
  if(n===5){const p=JSON.parse(body.messages[1].content);assert.equal(p.previous_verification_evidence.length,1);return {role:'assistant',content:null,tool_calls:[{id:'prior-proof',type:'function',function:{name:'read_evidence',arguments:JSON.stringify({source:p.previous_verification_evidence[0].source})}}]};}
  assert.ok(body.messages.some(m=>m.role==='tool'&&m.content.includes('Raw previously observed report')));return {role:'assistant',content:JSON.stringify(pass)};
 });
 let reads=0;const workspace={call:async()=>{reads++;return {content:'Raw previously observed report',version:'report-v1'};}};
 await assert.rejects(evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{}),{code:'model_http_503'});
 assert.equal((await evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{})).outcome,'pass');assert.equal(reads,1);
 const candidate=f.records.get(f.task.id).candidate,prior=previousVerificationEvidence(f.h.store,f.task.id,candidate);assert.equal(prior.length,1);
 const raw=readEvidence(f.h.store,f.task.id,candidate,{source:prior[0].source});assert.equal(raw.verification_candidate,candidate.id);assert.equal(raw.historical,true);assert.equal(raw.version,'report-v1');
 const next=f.records.submit(f.task.id,[{kind:'report',reference:'report.md',version:'v2',content:'New candidate'}],[],{});
 assert.equal(previousVerificationEvidence(f.h.store,f.task.id,next).length,0);assert.equal(readEvidence(f.h.store,f.task.id,next,{source:prior[0].source}).error,'evidence_not_offered');
});
test('an unfinished evaluation is an infrastructure fault, never evidence insufficiency or a business rejection',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:null,tool_calls:[{id:'unfinished',type:'function',function:{name:'submit_acceptance',arguments:JSON.stringify({...pass,outcome:'evaluation_incomplete',reason:'Verification budget cannot finish the judgment',core_complete:false})}}]}));
 for(let i=0;i<3;i++)await assert.rejects(evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{}),{code:i===2?'acceptance_unavailable':'acceptance_budget_exhausted'});
 assert.equal(f.requests.length,3);assert.equal(f.records.get(f.task.id).rounds,0);assert.equal(f.records.get(f.task.id).acceptance,null);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_fault'").n,3);
});
