import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {assessFollowups} from '../dist/tasks/followups.js';
import {Redactor} from '../dist/agent/common.js';
const call=(name,args)=>({role:'assistant',tool_calls:[{id:'tool',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const residual={key:'e2e-documentation',description:'A stale E2E absence claim remains',evidence:'docs/known-issues.md versus package.json',impact:'Documentation ambiguity only',conditions:'Reading the inherited known-issues header',workaround:'Use package.json as the tooling authority',delivery_impact:'Does not block delivered functionality',nonblocking_reason:'All required product behavior and tests pass',goal:'Fix this specific stale E2E claim',criteria:['The absence claim agrees with actual scripts']};
const verdict={outcome:'pass_with_issues',reason:'Core is verified',gaps:[],residuals:[residual],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
async function fixture(t,respond){
 const s=new Store(':memory:',Buffer.alloc(32,5));t.after(()=>s.close());s.run("INSERT INTO accounts VALUES('a','test','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/repo','o','a')");
 for(const id of ['parent','existing'])s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,'r','task.request','queued',?,'{}')",id,id);
 s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify({enabled:true,harnesses:{manager:'native'}}));
 const requests=[];const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);requests.push(body);try{const message=await respond(body,requests.length);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:200,completion_tokens:80}}));}catch(e){res.writeHead(502);res.end('{}');}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r',?,'fixture',?,'now')",'http://127.0.0.1:'+server.address().port+'/v1',s.secrets.seal({value:'test'},'model:m'));s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('r','m',1)");
 const records=new TaskRecords(s);records.contract('parent',{goal:'Verified delivery',scope:['docs'],criteria:['Evidence checked'],endpoint:'artifact',source:{}});const candidate=records.submit('parent',[{kind:'report',reference:'report.md',version:'v1'}],[],{});
 const task=s.get("SELECT * FROM tasks WHERE id='parent'");return {s,records,candidate,task,requests,workspace:{store:s,task,guard:async()=>{},redactor:new Redactor(),log:()=>{}}};
}
test('real Native Manager tool loop consumes objective QA impact, searches existing work and ranks/links without changing QA',async t=>{
 const f=await fixture(t,(body,n)=>{
 if(n===1){assert.ok(body.messages[0].content.includes('P0:'));assert.ok(body.messages[0].content.includes('not QA'));return call('read_task_record',{query:'existing'});}
 return call('submit_followup_plan',{items:[{key:residual.key,priority:'P3',reason:'Only stale documentation; package.json is a workaround, no delivery blocked',evidence_refs:[residual.evidence],action:'supplement',task_id:'existing'}]});});
 const original=JSON.stringify(verdict);await assessFollowups(f.s,f.task,f.candidate,verdict,f.workspace,async()=>{},new Redactor());assert.equal(JSON.stringify(verdict),original);
 const row=f.s.get('SELECT * FROM task_followup_plans');assert.ok(row,JSON.stringify(f.s.all("SELECT type,data FROM task_history WHERE type='followup_plan_deferred'")));assert.equal(JSON.parse(row.plan)[0].priority,'P3');assert.equal(f.requests.length,2);
 const accepted=f.records.decide('parent',f.candidate.id,f.candidate.revision,verdict);assert.deepEqual(accepted.followups,['existing']);assert.equal(accepted.outcome,'pass_with_issues');assert.equal(f.s.get('SELECT count(*) n FROM tasks').n,2);
});
test('Manager infrastructure failure does not invalidate an independent pass or stop residual queue admission',async t=>{
 const f=await fixture(t,()=>{throw Error('provider unavailable');});await assessFollowups(f.s,f.task,f.candidate,verdict,f.workspace,async()=>{},new Redactor());assert.equal(f.s.get('SELECT manager_ref FROM task_followup_plans').manager_ref,'framework:default-P2');
 const accepted=f.records.decide('parent',f.candidate.id,f.candidate.revision,verdict);const child=f.s.get('SELECT * FROM tasks WHERE id=?',accepted.followups[0]);assert.equal(child.status,'queued');assert.equal(child.priority,'P2');assert.ok(f.s.get("SELECT id FROM task_history WHERE type='followup_plan_deferred'"));
});

test('QA impact → Manager related-work plan → queued Coordinator → advice/ack → eligible FIFO task',async t=>{
 const {CoordinationWorker,resumeCoordinatedTasks,acknowledgeCoordination}=await import('../dist/tasks/coordination.js');
 const f=await fixture(t,body=>{
  if(body.tools.some(t=>t.function.name==='submit_coordination')){
   const user=body.messages.find(m=>m.role==='user'&&m.content.includes('coordination_id'));const pack=JSON.parse(user.content);
   return call('submit_coordination',{summary:'Existing writer keeps its candidate; new task checks only the independent docs discrepancy',outcome:'notices',notices:[{task_id:pack.request.task_ids[0],message:'Read existing evidence and handle only the distinct documentation claim, then obtain fresh QA.',action:'review'},{task_id:'existing',message:'Continue owned implementation; linked docs work is independent.',action:'review'}]});
  }
  return call('submit_followup_plan',{items:[{key:residual.key,priority:'P3',reason:'Distinct docs defect on a shared surface, core delivery is complete',evidence_refs:[residual.evidence],action:'related',task_id:'existing'}]});
 });
 f.s.run("UPDATE tasks SET status='running' WHERE id='existing'");await assessFollowups(f.s,f.task,f.candidate,verdict,f.workspace,async()=>{},new Redactor());
 const accepted=f.records.decide('parent',f.candidate.id,f.candidate.revision,verdict),child=accepted.followups[0];assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',child).status,'waiting_coordination');
 const worker=new CoordinationWorker(f.s);worker.tick();await Promise.all(worker.active.values());assert.equal(f.s.get('SELECT state FROM task_coordinations').state,'awaiting_feedback');
 resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?',child).status,'queued');
 const notice=f.s.get('SELECT id FROM coordination_notices WHERE task_id=?',child);assert.deepEqual(acknowledgeCoordination(f.s,child,{notice_id:notice.id,disposition:'adopted',reason:'Adopt bounded documentation scope and reuse evidence only at its recorded version'}),{ok:true});
 assert.equal(f.records.get(child).acceptance,null);assert.equal(f.records.get(child).priority.level,'P3');await worker.close();
});

test('Pi Manager planning uses the same post-QA decision protocol through the control mailbox',async t=>{
 const {fakeRunner}=await import('./pi-mailbox.mjs'),{Workspace}=await import('../dist/agent/workspace.js');
 const f=await fixture(t,()=>call('submit_followup_plan',{items:[{key:residual.key,priority:'P3',reason:'Only optional docs, no core delivery blocked',evidence_refs:[residual.evidence],action:'new'}]}));
 f.s.run("UPDATE settings SET value=? WHERE key='roles:r'",JSON.stringify({enabled:true,harnesses:{manager:'pi'}}));f.task.generation=1;
 const runner=fakeRunner(),workspace=new Workspace(f.s,runner.manager,f.task,new Redactor(),async()=>{},()=>{});
 await assessFollowups(f.s,f.task,f.candidate,verdict,workspace,async()=>{},new Redactor());
 assert.equal(JSON.parse(f.s.get('SELECT plan FROM task_followup_plans')?.plan??'[]')[0]?.priority,'P3',JSON.stringify(f.s.all("SELECT data FROM task_history WHERE type='followup_plan_deferred'")));
 assert.ok(runner.operations.some(o=>o.type==='workspace_agent_start'));assert.equal(f.s.get("SELECT harness FROM task_runs WHERE role='manager' ORDER BY started_at DESC LIMIT 1").harness,'pi');
});
