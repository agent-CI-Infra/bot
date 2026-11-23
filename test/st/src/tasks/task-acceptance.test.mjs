import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { nativeRoles } from '../../../fixtures/native-roles.mjs';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { evaluateDelivery, acceptanceContextFiles, shouldRunQa } from '../../../../dist/tasks/acceptance.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
const pass={outcome:'pass',reason:'Raw artifact meets the requested contract',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
async function fixture(t,respond){
 const requests=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);const result=respond(body,requests.length);res.writeHead(result.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(result.status?{error:{message:'temporary outage'}}:{choices:[{message:result}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 // These cases drive QA in process against stub checkouts; the default Pi backend has its own coverage.
 nativeRoles(h.store,'101');
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
 assert.deepEqual(f.requests[0].tools.map(t=>t.function.name),['read_evidence','read_task_history','read_file','submit_acceptance','read_tool_result']);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_evidence'").n,1);
 assert.equal(f.h.store.get('SELECT count(*) n FROM model_requests WHERE task_id=?',f.task.id).n,2);
});
test('QA receives the actual Issue source path and reads the original behind a derived summary',async t=>{
 const f=await fixture(t,(body,n)=>{
  const input=JSON.parse(body.messages[1].content);
  assert.deepEqual(input.context_files,['../context/object.json','../context/comments.json']);
  assert.match(input.requirements_instruction,/condensed summary/);
  return n===1?{role:'assistant',content:null,tool_calls:[{id:'source',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:input.context_files[0]})}}]}:{role:'assistant',content:JSON.stringify({...pass,outcome:'return',reason:'Original FR3 requires normalized bounds',gaps:['min>max must yield the minimum depth'],core_complete:false})};
 });
 f.h.store.run("UPDATE tasks SET input=? WHERE id=?",JSON.stringify({context:{context_files:[{path:'../context/object.json',content:'Full original request'},{path:'../context/comments.json',content:'Comments'}]}}),f.task.id);
 f.task.input=f.h.store.get('SELECT input FROM tasks WHERE id=?',f.task.id).input;
 f.h.store.run('UPDATE task_records SET contract=? WHERE task_id=?',JSON.stringify({...f.records.get(f.task.id).contract,completeness:'derived_from_source'}),f.task.id);
 const paths=[];
 const result=await evaluateDelivery(f.h.store,f.task,{call:async(_key,r)=>{paths.push(r.path);return {content:JSON.stringify({body:'FR3: min>max yields [min,min]'})};}},new Redactor(),async()=>{},false);
 assert.equal(result.outcome,'return');assert.deepEqual(paths,['../context/object.json']);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_evidence' AND json_extract(data,'$.arguments.path')='../context/object.json'").n,1);
});
test('QA source paths support existing nested indexes and legacy/parent file maps without numeric filenames',()=>{
 assert.deepEqual(acceptanceContextFiles({context_files:{'request.md':'original'},context:{context_files:[{path:'../context/object.json'},'../context/comments.json']}},{context_files:{'parent.md':'source','object.json':'duplicate'}}),['../context/request.md','../context/object.json','../context/comments.json','../context/parent.md']);
 assert.deepEqual(acceptanceContextFiles({},null),[]);
});
test('the evaluator gets a bounded candidate: a workspace file list and old evidence previews stay out, sources stay readable',async t=>{
 // Production: a files artifact listing 9,500 files (1.5 MB) put the evaluator's first request over 2 MiB.
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 const evidence=Array.from({length:109},(_,i)=>({source:'task_log:'+i,version:'v'+i,verified:true,result:{type:'tool',name:'run_command',output:'command output '.repeat(200)}}));
 f.records.submit('delivery',[{kind:'report',reference:'report.md',version:'v2',content:'Executor claims verified'},
   {kind:'files',reference:'workspace:w',version:'t1',content:{files:Array.from({length:12000},(_,i)=>({path:'src/file-'+i+'.ts',sha:'a'.repeat(40),size:i})),local_sha:'b'.repeat(40),base_sha:'c'.repeat(40)}}],evidence,{summary:'claim'});
 const verdict=await evaluateDelivery(f.h.store,f.task,{call:async()=>({content:'Actual observed artifact'})},new Redactor(),async()=>{},false);
 assert.equal(verdict.outcome,'pass');
 assert.ok(Buffer.byteLength(JSON.stringify(f.requests[0]))<512*1024,'the first request stays small: '+JSON.stringify(f.requests[0]).length);
 const candidate=JSON.parse(f.requests[0].messages[1].content).candidate,[report,files]=candidate.artifacts;
 assert.equal(report.content,'Executor claims verified','small artifact content is kept');
 assert.equal(files.content.files.omitted,true);assert.ok(files.content.files.characters>1000000);assert.equal(files.content.local_sha,'b'.repeat(40));
 assert.equal(candidate.evidence.length,109);assert.deepEqual(candidate.evidence[108],evidence[108],'the newest previews are kept');
 assert.equal(candidate.evidence[0].source,'task_log:0');assert.equal(candidate.evidence[0].result.omitted,true,'older previews become sources for read_evidence');
});
test('an evaluator outage is recoverable infrastructure failure, does not reject or complete the candidate',async t=>{
 // An outage that outlasts the transport's five retries (six requests).
 const f=await fixture(t,(_b,n)=>n<=6?{status:503}:{role:'assistant',content:JSON.stringify(pass)});
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
 f.h.store.run("UPDATE tasks SET workspace_id=?,generation=1,input=? WHERE id=?",'a'.repeat(48),JSON.stringify({snapshot_tree:'b'.repeat(40)}),f.task.id);
 const task=f.h.store.get('SELECT * FROM tasks WHERE id=?',f.task.id);
 f.records.submit(f.task.id,[{kind:'report',reference:'candidate',version:'v1',content:'claim'}],[],{summary:'claim'});
 const workspace={task,call:async()=>({error:'injected snapshot failure'}),log:()=>{}};
 await assert.rejects(evaluateDelivery(f.h.store,task,workspace,new Redactor(),async()=>{}),{code:'acceptance_snapshot_unavailable'});
 assert.equal(f.records.get(f.task.id).acceptance,null);
});

test('only a trusted runtime budget can raise provider output tokens; model request fields remain bounded',async t=>{
 const {runAgent}=await import('../../../../dist/agent/runtime.js');
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 await runAgent({store:f.h.store,task:f.task,redactor:new Redactor(),guard:async()=>{},system:'Return JSON',prompt:'Return the result',maxOutputTokens:16384});
 assert.equal(f.requests.at(-1).max_completion_tokens,16384);
 await assert.rejects(runAgent({store:f.h.store,task:f.task,redactor:new Redactor(),guard:async()=>{},system:'Return JSON',prompt:'Return result',maxOutputTokens:32769}),{code:'agent_limits_invalid'});
});

test('a missing current policy proof runs deterministic verification and returns a real failed check without model approval',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 f.h.store.run("UPDATE policies SET test_command='required-check' WHERE repository_id='101'");f.task.workspace_id='a'.repeat(48);f.task.generation=1;
 f.records.submit(f.task.id,[{kind:'code',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40)}}],[],{});
 const calls=[],workspace={task:f.task,call:async(_k,request)=>{calls.push(request);return request.type==='workspace_command'?{exit_code:1,output:'A real mandatory check failed'}:{tree_sha:'b'.repeat(40)};},log:()=>{}};
 const result=await evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{});
 assert.equal(result.outcome,'return');assert.equal(result.pass,false);assert.ok(result.gaps[0].includes('mandatory check failed'));assert.equal(f.requests.length,0);assert.ok(calls.some(r=>r.command==='required-check'));
 const c=f.records.get(f.task.id).candidate;f.records.decide(f.task.id,c.id,c.revision,result);const final=f.h.store.get("SELECT run_id,caused_by FROM task_history WHERE task_id=? AND type='acceptance' ORDER BY id DESC LIMIT 1",f.task.id);const verification=f.h.store.get("SELECT id FROM task_runs WHERE task_id=? AND kind='verification' ORDER BY rowid DESC LIMIT 1",f.task.id);assert.equal(final.run_id,verification.id);assert.equal(JSON.parse(final.caused_by).length,1);
});

// #1121 review: the project check runs in the shared workspace, so it certifies the candidate only while the workspace still holds
// the candidate's tree. A changed workspace returns the candidate instead of attributing another tree's result to it.
test('a workspace that changed after the submission returns the candidate without running the project check against it',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 f.h.store.run("UPDATE policies SET test_command='required-check' WHERE repository_id='101'");f.task.workspace_id='a'.repeat(48);f.task.generation=1;
 f.records.submit(f.task.id,[{kind:'code',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40),tree_sha:'b'.repeat(40)}}],[],{});
 const calls=[],workspace={task:f.task,call:async(_k,request)=>{calls.push(request);return request.type==='workspace_tree'?{tree_sha:'d'.repeat(40)}:request.type==='workspace_command'?{exit_code:0,output:'passes on another tree'}:{tree_sha:'b'.repeat(40)};},log:()=>{}};
 const result=await evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{});
 assert.equal(result.outcome,'return');assert.equal(result.pass,false);
 assert.match(result.gaps[0],/workspace changed after this candidate was submitted \(candidate tree bbbbbbbbbbbb, workspace tree dddddddddddd\)/);
 assert.ok(!calls.some(r=>r.type==='workspace_command'),'the check never ran against the other tree');assert.equal(f.requests.length,0);
 const evidence=f.h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='acceptance_evidence'",f.task.id).map(r=>JSON.parse(r.data));
 assert.deepEqual(evidence.map(e=>[e.version,e.candidate_version,e.skipped]),[['d'.repeat(40),'b'.repeat(40),'workspace_changed']]);
 // The same workspace still holding the candidate's tree runs the check and records the tree it tested.
 const again=await fixture(t,()=>({role:'assistant',content:JSON.stringify(pass)}));
 again.h.store.run("UPDATE policies SET test_command='required-check' WHERE repository_id='101'");again.task.workspace_id='a'.repeat(48);again.task.generation=1;
 again.records.submit(again.task.id,[{kind:'code',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40),tree_sha:'b'.repeat(40)}}],[],{});
 const same={task:again.task,call:async(_k,request)=>request.type==='workspace_command'?{exit_code:1,output:'A real mandatory check failed'}:{tree_sha:'b'.repeat(40)},log:()=>{}};
 assert.ok((await evaluateDelivery(again.h.store,again.task,same,new Redactor(),async()=>{})).gaps[0].includes('mandatory check failed'));
 const tested=again.h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='acceptance_evidence'",again.task.id).map(r=>JSON.parse(r.data));
 assert.deepEqual(tested.map(e=>[e.version,e.tested_tree]),[['b'.repeat(40),'b'.repeat(40)]]);
});

test('lightweight QA runs verification commands in-place inside the shared task workspace without executor_workspace_reference',async t=>{
 const source='a'.repeat(48),calls=[];
 const f=await fixture(t,(_body,n)=>n===1?{role:'assistant',content:null,tool_calls:[{id:'command1',type:'function',function:{name:'run_command',arguments:JSON.stringify({command:'cat /workspace/tasks/'+source+'/repo/report.md'})}}]}:{role:'assistant',content:null,tool_calls:[{id:'done',type:'function',function:{name:'submit_acceptance',arguments:JSON.stringify({pass:true,issues:[]})}}]});
 f.task.workspace_id=source;f.task.generation=1;
 f.records.submit(f.task.id,[{kind:'files',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40)}}],[],{});
 const workspace={task:f.task,store:f.h.store,call:async(_k,request)=>{calls.push({...request,workspace_id:source});return request.type==='workspace_command'?{exit_code:0,output:'shared report'}:{tree_sha:'b'.repeat(40)};},log:()=>{}};
 const verdict=await evaluateDelivery(f.h.store,f.task,workspace,new Redactor(),async()=>{});
 assert.equal(verdict.outcome,'pass');assert.equal(verdict.pass,true);
 const commands=calls.filter(r=>r.type==='workspace_command');assert.equal(commands.length,1);assert.equal(commands[0].workspace_id,source);
 assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('executor_workspace_reference'));
});

test('verdict format repair keeps fresh inspection evidence and does not rerun successful reads',async t=>{
 const f=await fixture(t,(body,n)=>{
  if(n===1)return {role:'assistant',content:null,tool_calls:[{id:'inspect',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'report.md'})}}]};
  if(n===2)return {role:'assistant',content:JSON.stringify({pass:true})};
  assert.ok(body.messages.at(-1).content.includes('submit_acceptance'));
  return {role:'assistant',content:JSON.stringify({pass:true,issues:[]})};
 });
 let reads=0;const result=await evaluateDelivery(f.h.store,f.task,{call:async()=>{reads++;return {content:'Actual report'};}},new Redactor(),async()=>{});
 assert.equal(result.outcome,'pass');assert.equal(reads,1);assert.equal(f.requests.length,3);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_format_error'").n,1);
 assert.equal(f.h.store.get("SELECT count(*) n FROM task_history WHERE type='acceptance_fault'").n,0);
 assert.equal(f.records.get(f.task.id).acceptance,null,'format repair cannot finalize delivery');
});
test('format feedback can correct an invalid pass into a truthful return instead of relaxing core conditions',async t=>{
 const f=await fixture(t,(_body,n)=>({role:'assistant',content:JSON.stringify(n===1?{pass:true,issues:['Missing test']}:{pass:false,issues:['A required behavior is absent']})}));
 const result=await evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{});
 assert.equal(result.outcome,'return');assert.equal(result.pass,false);assert.deepEqual(result.issues,['A required behavior is absent']);assert.equal(f.requests.length,2);assert.equal(f.records.get(f.task.id).acceptance,null);
});
test('text without a structured verdict exhausts each lightweight QA 6-turn budget and reports repeated faults',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:'{}'}));
 for(let i=0;i<3;i++)await assert.rejects(evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{}),{code:i===2?'acceptance_unavailable':'acceptance_output_invalid'});
 assert.equal(f.requests.length,18);assert.equal(f.records.get(f.task.id).rounds,0);assert.equal(f.records.get(f.task.id).acceptance,null);
});

test('typed acceptance submission repairs schema errors while preserving a real core gap',async t=>{
 const f=await fixture(t,(_body,n)=>({role:'assistant',content:null,tool_calls:[{id:'verdict'+n,type:'function',function:{name:'submit_acceptance',arguments:JSON.stringify(n===1?{...pass,core_complete:false}:{...pass,outcome:'return',core_complete:false,gaps:['Required behavior is absent']})}}]}));
 const verdict=await evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{});
 assert.equal(verdict.outcome,'return');assert.equal(verdict.core_complete,false);assert.equal(f.requests.length,2);
 assert.ok(f.requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('invalid_submission')));
 assert.equal(f.records.get(f.task.id).acceptance,null);
});
test('a fresh evaluation reuses hash-addressed raw verification only for the same candidate and revision',async t=>{
 const {readEvidence,previousVerificationEvidence}=await import('../../../../dist/tasks/evidence.js');
 const f=await fixture(t,(body,n)=>{
  if(n===1)return {role:'assistant',content:null,tool_calls:[{id:'raw-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'report.md'})}}]};
  // The outage outlasts the transport's five retries of the second request.
  if(n>=2&&n<=7)return {status:503};
  if(n===8){const p=JSON.parse(body.messages[1].content);assert.equal(p.previous_verification_evidence.length,1);return {role:'assistant',content:null,tool_calls:[{id:'prior-proof',type:'function',function:{name:'read_evidence',arguments:JSON.stringify({source:p.previous_verification_evidence[0].source})}}]};}
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
test('#769/#1121 QA of a report pins the report\'s source in place without cloning workspace_acceptance',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify({pass:true,issues:[]})}));
 f.h.store.run("UPDATE tasks SET workspace_id=?,input=? WHERE id='delivery'",'c'.repeat(48),JSON.stringify({snapshot_tree:'b'.repeat(40)}));
 const task=f.h.store.get("SELECT * FROM tasks WHERE id='delivery'"),calls=[];
 const workspace=state=>({task,store:f.h.store,plannedWorktree:()=>({state}),log:()=>{},call:async(_key,request)=>{calls.push([state,request.type]);return request.type==='workspace_source'?{local_sha:'a'.repeat(40),tree_sha:'b'.repeat(40)}:{tree_sha:'b'.repeat(40)};}});
 assert.equal((await evaluateDelivery(f.h.store,task,workspace('planned'),new Redactor(),async()=>{},false)).outcome,'pass');
 assert.deepEqual(calls,[['planned','workspace_source']]);
});

test('#1121 deterministic preflight rejects .env files, merge conflict markers and leaked credentials with zero model calls, and shouldRunQa skips pure Q&A',async t=>{
 const f=await fixture(t,()=>({role:'assistant',content:JSON.stringify({pass:true,issues:[]})}));
 const redactor=new Redactor();redactor.add('ghp_SECRETTOKEN12345678901234567890');
 f.records.submit(f.task.id,[{kind:'code',reference:'candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40),snapshot_files:[{path:'src/a.js',sha:'1'.repeat(40)}],files:[{path:'.env.production',sha:'2'.repeat(40),size:20},{path:'src/a.js',sha:'3'.repeat(40),size:60}]}}],[],{summary:'clean summary'});
 const workspace={task:f.task,store:f.h.store,call:async(_k,req)=>req.path==='src/a.js'?{content:'<<<<<<< HEAD\nconst a=1;\n=======\nconst a=2;\n>>>>>>> branch\n'}:{content:'API=1'},log:()=>{}};
 const preflight=await evaluateDelivery(f.h.store,f.task,workspace,redactor,async()=>{},false);
 assert.equal(preflight.pass,false);assert.equal(preflight.outcome,'return');assert.equal(f.requests.length,0,'deterministic preflight uses zero model calls');
 assert.ok(preflight.issues.some(i=>i.includes('.env.production')));
 assert.ok(preflight.issues.some(i=>i.includes('conflict markers')));
 // Tiered trigger: pure Q&A skips QA; PRs and formal reviews run QA.
 assert.equal(shouldRunQa(f.h.store,{id:f.task.id,kind:'task.request',repository_id:'101',input:JSON.stringify({generic:true,delivery:'report'})},{artifacts:[{kind:'report',reference:'r',version:'v1'}]}),false);
 assert.equal(shouldRunQa(f.h.store,{id:f.task.id,kind:'workflow.issue_reply',repository_id:'101',input:'{}'},{artifacts:[{kind:'report',reference:'r',version:'v1'}]}),false);
 assert.equal(shouldRunQa(f.h.store,{id:f.task.id,kind:'review.pr',repository_id:'101',input:'{}'},{artifacts:[{kind:'report',reference:'r',version:'v1'}]}),true);
 assert.equal(shouldRunQa(f.h.store,{id:f.task.id,kind:'development.issue',repository_id:'101',input:'{}'},preflight),true);
});
test('QA receives compact related indexes rather than repeated repository manifests',async t=>{
 const f=await fixture(t,body=>{
  const input=JSON.parse(body.messages[1].content);
  assert.equal(input.related_deliveries.length,5);
  assert.equal(input.related_deliveries_page.total,6);
  assert.equal(input.related_deliveries_page.next_offset,5);
  assert.ok(input.related_deliveries.every(d=>d.file_count===2200&&!('files' in d)));
  assert.ok(body.messages[1].content.length<40000);
  assert.ok(body.tools.some(t=>t.function.name==='read_related_artifact'));
  return {role:'assistant',content:JSON.stringify(pass)};
 });
 for(let i=0;i<6;i++){
  const id='qa-child-'+i;
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,'101','task.request','running','Related delivery','{}')",id);
  f.records.contract(id,{goal:'Complete related behavior',scope:['behavior'],criteria:['regression checks'],endpoint:'artifact'});
  f.h.store.run("INSERT INTO task_children VALUES('delivery',?,'now')",id);
  const revision=f.records.get(id).revision;
  const candidate={id:'c-'+i,revision,artifacts:[{kind:'code',reference:'task:'+id,version:'tree',content:{local_sha:'a'.repeat(40),files:Array.from({length:2200},(_,n)=>({path:'src/file-'+n,sha:'b'.repeat(40)}))}}]};
  f.h.store.run('UPDATE task_records SET candidate=? WHERE task_id=?',JSON.stringify(candidate),id);
 }
 const result=await evaluateDelivery(f.h.store,f.task,{call:async()=>({})},new Redactor(),async()=>{},false);
 assert.equal(result.outcome,'pass');
});
test('QA sees which roles produced results for the candidate and the Manager\'s note, as facts beside its checklist (#1250)',async t=>{
 const {traceEvent}=await import('../../../../dist/tasks/trace.js');
 const seen=[];const f=await fixture(t,body=>{seen.push(JSON.parse(body.messages[1].content));return {role:'assistant',content:JSON.stringify(pass)};});
 const dev=traceEvent(f.h.store,'delivery','role_result',{role:'dev',result:{summary:'implemented'}});
 traceEvent(f.h.store,'delivery','delivery_nominated',{result_ref:dev,candidate_participation:{candidate_ref:dev,dev_results:1,inspected_by:[],earlier_candidates_only:[],summary:'dev only: no independent role inspected this candidate'},checks_note:'Wording-only change.'});
 await evaluateDelivery(f.h.store,f.task,{call:async()=>({content:'Actual observed artifact'})},new Redactor(),async()=>{},false);
 assert.deepEqual(seen[0].candidate_participation,{candidate_ref:dev,dev_results:1,inspected_by:[],earlier_candidates_only:[],summary:'dev only: no independent role inspected this candidate',checks_note:'Wording-only change.'});
 assert.equal(seen[0].checklist.length,3,'the facts add no checklist item');
});
