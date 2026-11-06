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
 assert.deepEqual(f.requests[0].tools.map(t=>t.function.name),['read_evidence','read_file']);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_evidence'").n,1);
 assert.equal(f.h.store.get('SELECT count(*) n FROM model_requests WHERE task_id=?',f.task.id).n,2);
});
test('an evaluator outage is recoverable infrastructure failure, does not reject or complete the candidate',async t=>{
 const f=await fixture(t,(_b,n)=>n===1?{status:503}:{role:'assistant',content:JSON.stringify(pass)});
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
