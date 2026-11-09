import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { runTeam } from '../dist/roles/team.js';
import { captureTaskConfiguration } from '../dist/tasks/configuration.js';
import { runRole, roleInstance, roleRuns } from '../dist/roles/run.js';
import { roleApi } from '../dist/roles/api.js';
import { saveConfiguration } from '../dist/roles/definition.js';
import { Redactor } from '../dist/agent/common.js';
import { traceEvent } from '../dist/tasks/trace.js';
import { planTask, reconcileAssignments, bindStageAssignment, recordStageResult, latestRoleCandidate, evaluateRequiredStages, candidateKey, deliveryCandidate } from '../dist/roles/schedule.js';

const tool = name => ({type:'function',function:{name,description:name,parameters:{type:'object',properties:{},additionalProperties:true}}});
const call = (name,args) => ({role:'assistant',content:null,tool_calls:[{id:randomBytes(4).toString('hex'),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const tree = c => c.repeat(40);
const stage = (stage_id, {writer=false,deps=[],types=['code'],capabilities=[],budget={},attempts=4}={}) => ({stage_id,depends_on:deps,delivery_types:types,role_constraints:{kinds:[writer?'writer':'observer'],role_ids:[writer?'dev':stage_id],capabilities:['version_binding','output_validation','raw_evidence',...(writer?[]:['fresh_context','fixed_candidate_read']),...capabilities],independent:!writer},required:true,completion:{evidence_types:[writer?'role_result':'tool_observation'],min_evidence:1,no_findings:!writer},retry:{max_attempts:attempts},budget});
async function fixture(t,{stages=[],roles=[],file=':memory:',handler}={}) {
  const key=randomBytes(32);let s=new Store(file,key),calls=[];
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/stages','o','a')");
  s.run("INSERT INTO repositories VALUES('other','fixture/other','o','a')");
  const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);const system=body.messages[0].content;
    const message=handler?await handler(body):system.includes('QA verified')?call('finish',{outcome:'pass',reason:'verified',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true}):system.includes('Inspect fixed')?(body.messages.at(-1).role==='tool'?call('submit_role_result',{summary:'checked',findings:[],inspected_scope:['fixture'],unknowns:[]}):call('read_file',{path:'fixture'})):call('finish',{summary:'implemented'});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:10,completion_tokens:5}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','r',`http://127.0.0.1:${server.address().port}/v1`,'fixture',s.secrets.seal({value:'fixture-stages-key'},'model:m'),'now');
  s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt) VALUES('t','r','development.issue','running','stages','{}',1)");
  const records=new TaskRecords(s);records.contract('t',{goal:'stages',scope:['fixture'],criteria:['verified'],endpoint:'code'});
  const native=['manager','dev','test','reviewer','ux','qa','coordinator'].map(role_id=>({role_id,harness_ref:{id:'native'},...roles.find(r=>r.role_id===role_id)}));
  saveConfiguration(s,'r',{expected_revision:0,enabled:true,roles:native,required_stages:stages},'owner');
  captureTaskConfiguration(s,'t');
  const spec=()=>({store:s,task:s.get("SELECT * FROM tasks WHERE id='t'"),redactor:new Redactor(),guard:async()=>{},system:'Execution',prompt:'{}',tools:[tool('finish')],finish:{name:'finish',validate:v=>v},maxTurns:4});
  t.after(()=>new Promise(r=>{s.close();server.close(r);server.closeAllConnections();}));
  return {get s(){return s;},records,calls,spec,reopen(){s.close();s=new Store(file,key);},retry(){s.run("UPDATE tasks SET status='paused' WHERE id='t'");new TaskCommands(s).api({id:'owner',role:'project_admin',repositories:['r']},'POST',new URL('http://local/api/tasks/t/retry'),{});},plan:()=>planTask(s,'t',records.get('t').revision),assign(role,id,stage_id){const instance=roleInstance(s,spec().task,role);s.run('INSERT INTO role_assignments VALUES(?,?,?,?,?,?,?,?)',id,'t',instance.id,records.get('t').revision,null,'running',id,null);bindStageAssignment(s,'t',id,role,stage_id);return id;},async writer(id='dev-1',sha='a',hash='b'){this.assign('dev',id,'dev');return runRole(spec(),'dev',id,undefined,{snapshot:async()=>({local_sha:tree(sha),tree_sha:tree(hash)})});},async observer(role,id=role+'-1'){this.assign(role,id,role);const candidate=latestRoleCandidate(s,'t');if(candidate.kind==='code')traceEvent(s,'t','role_candidate',{role,sha:candidate.commit_sha,version:candidate.tree_hash,workspace_id:'readonly-'+id});const v=await runRole({...spec(),maxTurns:8,system:'Inspect fixed',tools:[tool('read_file'),tool('submit_role_result')],finish:{name:'submit_role_result',validate:v=>v},execute:async()=>({content:'actual source'})},role,id);s.run("UPDATE role_assignments SET status='completed',result_ref=? WHERE id=?",v.reference,id);return v;}};
}

test('stage plans preserve required policy, reject invalid DAGs and use optimistic versions',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']}),stage('test',{deps:['reviewer']})]});
  const p=f.plan();assert.equal(f.plan().revision,p.revision);assert.deepEqual(reconcileAssignments(f.s,'t').next,['dev']);
  assert.throws(()=>planTask(f.s,'t',1),/task_revision_changed/);
  assert.throws(()=>planTask(f.s,'t',f.records.get('t').revision,[],p.revision),/required_stage_immutable/);
  const optional={...stage('ux',{deps:['dev']}),required:false};
  assert.equal(planTask(f.s,'t',f.records.get('t').revision,[...JSON.parse(p.stages),optional],p.revision).revision,p.revision+1);
  assert.throws(()=>planTask(f.s,'t',f.records.get('t').revision,undefined,p.revision),/stage_plan_revision_changed/);
  for(const broken of [[stage('reviewer',{deps:['test']}),stage('test',{deps:['reviewer']})],[stage('reviewer',{deps:['missing']})],[stage('reviewer',{types:['code']}),stage('test',{deps:['reviewer'],types:['artifact']})],[stage('manager')],[stage('dev',{writer:true,capabilities:['unknown']})]]) {
    assert.throws(()=>saveConfiguration(f.s,'r',{expected_revision:1,enabled:true,roles:[],required_stages:broken},'owner'),{code:'invalid_stage_policy'});
  }
});

test('plan_task accepts reordered required definitions and a read_stage_schedule round trip',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']})]});const first=f.plan();
  const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
  const stages=reorder(reconcileAssignments(f.s,'t').stages),optional={...stage('ux',{deps:['dev']}),required:false};
  const second=planTask(f.s,'t',f.records.get('t').revision,[...stages,optional],first.revision);
  assert.equal(second.revision,first.revision+1);
  assert.equal(planTask(f.s,'t',f.records.get('t').revision,reorder(reconcileAssignments(f.s,'t').stages),second.revision).revision,second.revision);
  const changed=JSON.parse(second.stages);changed[0].retry.max_attempts++;
  assert.throws(()=>planTask(f.s,'t',f.records.get('t').revision,changed,second.revision),/required_stage_immutable/);
});

test('a repair round can delegate the same passed writer without a stage_id',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']})]});f.plan();await f.writer();
  const instance=f.s.get("SELECT role_instance_id FROM task_runs WHERE role='dev'").role_instance_id;
  f.assign('dev','repair');await runRole(f.spec(),'dev','repair',undefined,{snapshot:async()=>({local_sha:tree('c'),tree_sha:tree('d')})});
  assert.equal(f.s.get("SELECT stage_id FROM task_stage_assignments WHERE assignment_id='repair'").stage_id,'dev');
  assert.equal(f.s.get("SELECT role_instance_id FROM task_runs WHERE assignment_id='repair'").role_instance_id,instance);
  assert.deepEqual(reconcileAssignments(f.s,'t').next,['reviewer']);
});

test('runTeam preserves permanent gate codes and the engine waits for an explicit human operation',async t=>{
  const scenarios={
    stage_retry_exhausted:async f=>{await f.writer();await f.observer('reviewer');},
    stage_policy_changed:async f=>f.s.run("UPDATE policies SET test_command='changed' WHERE repository_id='r'"),
    stage_plan_stale:async f=>f.records.contract('t',{...f.records.get('t').contract,criteria:['changed']}),
    repository_policy_disabled:async f=>f.s.run("UPDATE policies SET enabled=0 WHERE repository_id='r'"),
    paused:async f=>f.s.run("UPDATE tasks SET status='paused' WHERE id='t'"),
    cancelled:async f=>f.s.run("UPDATE tasks SET status='cancelled' WHERE id='t'")
  };
  for(const [reason,change] of Object.entries(scenarios))await t.test(reason,async t=>{
    const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev'],attempts:1})],handler:body=>body.tools.some(t=>t.function.name==='submit_role_result')?call('submit_role_result',{summary:'No proof yet',findings:[],unknowns:[],inspected_scope:['fixture']}):call('finish',{summary:'implemented'})});f.plan();await change(f);
    const expected=['paused','cancelled'].includes(reason)?'task_claim_revoked':reason,state=['cancelled','repository_policy_disabled'].includes(reason)?'cancelled':'paused',before=f.calls.length;
    const team=()=>runTeam(f.spec(),{prepare:async()=>{}});
    await assert.rejects(team(),{code:expected,state});assert.equal(f.calls.length,before,'a hard preflight wait must not start a manager');
    if(['paused','cancelled'].includes(reason))return;
    // Exercise the actual engine failure handler around runTeam, before opening a GitHub transport.
    const engine=new TaskEngine(f.s,{call:async()=>null});t.after(()=>engine.close());engine.share=team;
    f.s.run("UPDATE tasks SET claim_token='claim',retry_count=4,retry_cycle_started_at=1 WHERE id='t'");f.s.run("INSERT INTO task_claims VALUES('t','r','claim','now')");
    await engine.run('t','claim');const row=f.s.get("SELECT * FROM tasks WHERE id='t'");
    assert.equal(row.status,state);assert.equal(row.error_code,expected);assert.equal(row.retry_count,0);assert.equal(row.retry_cycle_started_at,null);
    if(state==='paused')assert.equal(f.records.get('t').progress.waiting_reason,expected);
    f.s.run("UPDATE tasks SET next_run_at=0 WHERE id='t'");engine.tick();await Promise.all(engine.active.values());
    assert.equal(f.calls.length,before);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,state);
    if(state==='paused'){f.retry();assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,'queued');}
  });
});

test('runTeam stops a newly added applicable required policy even when its snapshot had no stages',async t=>{
  const f=await fixture(t);saveConfiguration(f.s,'r',{expected_revision:1,enabled:true,roles:[],required_stages:[stage('dev',{writer:true})]},'owner');
  await assert.rejects(runTeam(f.spec(),{prepare:async()=>{}}),{code:'stage_policy_changed',state:'paused'});
  assert.equal(f.calls.length,0);assert.equal(reconcileAssignments(f.s,'t').waiting[0].reason,'stage_policy_changed');
  assert.equal(reconcileAssignments(f.s,'t').plan_revision,0);
  f.s.run("UPDATE tasks SET status='paused' WHERE id='t'");new TaskCommands(f.s).api({id:'owner',role:'project_admin',repositories:['r']},'POST',new URL('http://local/api/tasks/t/adopt-config'),{});
  captureTaskConfiguration(f.s,'t');assert.equal(f.plan().revision,1);
});

test('a stage exhausting its last attempt inside runTeam is not converted to a tool error or nomination failure',async t=>{
  let ref;const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev'],attempts:1})],handler:body=>{
    if(body.tools.some(t=>t.function.name==='nominate_delivery')){
      const done=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));ref??=done.find(r=>r.result_ref)?.result_ref;
      return ref?call('delegate_role',{role:'reviewer',purpose:'Inspect',refs:[ref]}):call('delegate_role',{role:'dev',purpose:'Deliver',refs:['task:t']});
    }
    return body.tools.some(t=>t.function.name==='submit_role_result')?call('submit_role_result',{summary:'Need actual evidence',findings:[],unknowns:[],inspected_scope:['fixture']}):call('finish',{summary:'implemented'});
  }});
  await assert.rejects(runTeam(f.spec(),{prepare:async role=>{if(role!=='dev')traceEvent(f.s,'t','role_candidate',{role,sha:tree('a'),version:tree('b'),workspace_id:'readonly'});},snapshot:async()=>({local_sha:tree('a'),tree_sha:tree('b')})}),{code:'stage_retry_exhausted',state:'paused'});
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='reviewer'").n,1);
  assert.equal(f.s.get("SELECT stop_reason FROM task_runs WHERE role='manager'").stop_reason,'stage_retry_exhausted');
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='delivery_nominated'").n,0);
});

test('runTeam lets the manager repair missing evidence and dependencies while attempts remain',async t=>{
  let step=0,review=0,ref;const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']})],handler:body=>{
    if(body.tools.some(t=>t.function.name==='nominate_delivery')){
      const done=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));ref??=done.find(r=>r.result_ref)?.result_ref;
      return [()=>call('delegate_role',{role:'dev',purpose:'Deliver',refs:['task:t']}),()=>call('delegate_role',{role:'reviewer',purpose:'First inspection',refs:[ref]}),()=>call('read_stage_schedule',{}),()=>call('delegate_role',{role:'reviewer',purpose:'Supply actual evidence',refs:[ref]}),()=>call('nominate_delivery',{result_ref:ref})][step++]();
    }
    if(body.tools.some(t=>t.function.name==='submit_role_result'))return review++===1?call('read_task_record',{ref}):call('submit_role_result',{summary:'Inspected',findings:[],unknowns:[],inspected_scope:['fixture']});
    return call('finish',{summary:'implemented'});
  }});
  const result=await runTeam(f.spec(),{prepare:async role=>{if(role!=='dev')traceEvent(f.s,'t','role_candidate',{role,sha:tree('a'),version:tree('b'),workspace_id:'readonly'});},snapshot:async()=>({local_sha:tree('a'),tree_sha:tree('b')})});
  assert.equal(result.summary,'implemented');assert.equal(evaluateRequiredStages(f.s,'t',latestRoleCandidate(f.s,'t')).satisfied,true);
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='reviewer'").n,2);assert.equal(step,5);
});

test('a past explicit retry does not authorize a later policy change',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true})]});f.plan();f.retry();f.plan();
  f.s.run("UPDATE policies SET test_command='later change' WHERE repository_id='r'");
  assert.throws(()=>f.plan(),{code:'stage_policy_changed',state:'paused'});f.retry();assert.equal(f.plan().revision,2);
});

test('serial dev → reviewer → test binds evidence to exact candidate and still requires framework QA',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']}),stage('test',{deps:['reviewer']})]});f.plan();
  assert.throws(()=>f.assign('test','early','test'),/stage_not_runnable/);
  await f.writer();assert.deepEqual(reconcileAssignments(f.s,'t').next,['reviewer']);
  await f.observer('reviewer');assert.deepEqual(reconcileAssignments(f.s,'t').next,['test']);
  assert.equal(evaluateRequiredStages(f.s,'t',latestRoleCandidate(f.s,'t')).satisfied,false);
  await f.observer('test');const candidate=latestRoleCandidate(f.s,'t');assert.equal(evaluateRequiredStages(f.s,'t',candidate).satisfied,true);
  assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,'running');
  const results=f.s.all('SELECT result FROM task_stage_results').map(r=>JSON.parse(r.result));assert.equal(results.length,3);
  for(const result of results){assert.ok(result.run_id&&result.assignment_id&&result.role_revision&&result.policy_hash&&result.snapshot_ref&&result.evidence.length);assert.equal(candidateKey(result.candidate_ref),candidateKey(candidate));}
  const submitted=f.records.submit('t',[{kind:'code',reference:'workspace:t',version:tree('b'),content:{local_sha:tree('a')}}],[],{});
  assert.equal(candidateKey(deliveryCandidate(submitted)),candidateKey(candidate));
  const verdict={outcome:'pass',reason:'verified',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
  assert.throws(()=>f.records.stage('t',submitted.id,submitted.revision,verdict),{code:'acceptance_required'});
  traceEvent(f.s,'t','acceptance_started',{candidate_id:submitted.id,source_tree:tree('b'),context:'fresh'});
  await runRole({...f.spec(),system:'QA verified'},'qa');f.records.stage('t',submitted.id,submitted.revision,verdict);
  assert.equal(f.records.get('t').pending.outcome,'pass');
  const api=roleApi(f.s,{id:'owner',role:'project_admin',repositories:['r']},'GET',new URL('http://local/api/tasks/t/roles'),{});assert.equal(api.stage_schedule.stages.filter(s=>s.status==='passed').length,3);
  assert.throws(()=>roleApi(f.s,{id:'outsider',role:'project_admin',repositories:['other']},'GET',new URL('http://local/api/tasks/t/roles'),{}),/task_not_found/);
  await f.writer('dev-2','c','d');assert.equal(evaluateRequiredStages(f.s,'t',latestRoleCandidate(f.s,'t')).satisfied,false);assert.deepEqual(reconcileAssignments(f.s,'t').next,['reviewer']);
});

test('read-only stages really overlap on the same candidate and cannot race a writer',async t=>{
  let release,started=0;const barrier=new Promise(r=>release=r);
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']}),stage('test',{deps:['dev']})],handler:async body=>{if(!body.messages[0].content.includes('Inspect fixed'))return call('finish',{summary:'implemented'});if(body.messages.at(-1).role==='tool')return call('submit_role_result',{summary:'checked',findings:[],unknowns:[],inspected_scope:['fixture']});if(++started===2)release();await barrier;return call('read_file',{path:'fixture'});}});f.plan();await f.writer();
  assert.deepEqual(reconcileAssignments(f.s,'t').next,['reviewer','test']);
  const checks=[f.observer('reviewer'),f.observer('test')];await barrier;
  await assert.rejects(f.writer('concurrent-writer','c','d'),{code:'candidate_writer_busy'});
  await Promise.all(checks);assert.equal(evaluateRequiredStages(f.s,'t',latestRoleCandidate(f.s,'t')).satisfied,true);
  const runs=f.s.all("SELECT started_at,ended_at,run_context FROM task_runs WHERE role IN ('reviewer','test')");assert.equal(runs.length,2);assert.ok(runs[0].started_at<=runs[1].ended_at&&runs[1].started_at<=runs[0].ended_at);
  assert.equal(candidateKey(JSON.parse(runs[0].run_context).candidate_ref),candidateKey(JSON.parse(runs[1].run_context).candidate_ref));
});

test('policy/contract changes, revoked project and unsupported capabilities cannot certify a gate',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev'],capabilities:['run_isolation']})]});f.plan();await f.writer();
  await assert.rejects(f.observer('reviewer'),{code:'unsupported_capability'});
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='reviewer'").n,0);
  f.s.run("UPDATE policies SET test_command='new check' WHERE repository_id='r'");assert.equal(evaluateRequiredStages(f.s,'t',latestRoleCandidate(f.s,'t')).satisfied,false);
  assert.ok(reconcileAssignments(f.s,'t').waiting.some(w=>w.reason==='stage_policy_changed'));
  f.s.run("UPDATE policies SET enabled=0 WHERE repository_id='r'");assert.throws(()=>f.assign('dev','revoked','dev'),{code:'repository_policy_disabled'});
});

test('reopen reconstructs the timeline; resumed run retains assignment/instance and rejects old epochs and conflicting replay',async t=>{
  mkdirSync('.tmp/168-tests',{recursive:true});const root=mkdtempSync(resolve('.tmp/168-tests/reopen-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const f=await fixture(t,{stages:[stage('dev',{writer:true})],file:resolve(root,'db')});f.plan();const first=await f.writer();
  const run=f.s.get("SELECT * FROM task_runs WHERE assignment_id='dev-1'");
  const refs={result_ref:first.reference,candidate_ref:first.candidate_ref};assert.equal(recordStageResult(f.s,'dev-1',run.id,run.lease_epoch,refs).run_id,run.id);
  assert.throws(()=>recordStageResult(f.s,'dev-1',run.id,run.lease_epoch,{...refs,candidate_ref:{...first.candidate_ref,tree_hash:tree('f')}}),/stage_result_conflict/);
  f.reopen();assert.equal(reconcileAssignments(f.s,'t').stages[0].status,'passed');
  const spec=f.spec(),prepared=await roleRuns.prepare(spec,'dev','dev-1',undefined,{snapshot:async()=>({local_sha:tree('a'),tree_sha:tree('b')}),recover:{previous_run_id:run.id}}),handle=await roleRuns.start(prepared);
  await roleRuns.collect(handle);const next=f.s.get("SELECT * FROM task_runs WHERE assignment_id='dev-1' ORDER BY rowid DESC LIMIT 1");
  assert.notEqual(next.id,run.id);assert.equal(next.resume_from_run_id,run.id);assert.equal(next.role_instance_id,run.role_instance_id);assert.ok(next.lease_epoch>run.lease_epoch);
  assert.throws(()=>recordStageResult(f.s,'dev-1',run.id,run.lease_epoch,refs),{code:'lease_epoch_stale'});
  assert.equal(f.s.get('SELECT count(*) n FROM tasks').n,1);assert.equal(f.s.get('SELECT count(*) n FROM role_assignments').n,1);
});

test('absent stages preserve minimal teams; code gates do not apply to artifact or no_changes deliveries',async t=>{
  const f=await fixture(t);assert.equal(f.plan(),null);assert.equal(evaluateRequiredStages(f.s,'t',null).satisfied,true);
  saveConfiguration(f.s,'r',{expected_revision:1,enabled:true,roles:[],required_stages:[stage('reviewer')]},'owner');
  f.s.run('DELETE FROM task_execution_configs');captureTaskConfiguration(f.s,'t');f.plan();
  assert.equal(evaluateRequiredStages(f.s,'t',{kind:'no_changes',ref:'result:none',source_ref:'commit:'+tree('a'),record_hash:'b'.repeat(64)}).satisfied,true);
  f.s.run("UPDATE tasks SET kind='task.request' WHERE id='t'");f.records.contract('t',{...f.records.get('t').contract,endpoint:'artifact'});
  assert.equal(evaluateRequiredStages(f.s,'t',null).satisfied,true);
});

test('stage budgets and retries survive optional replanning and do not open a new execution allowance',async t=>{
  for(const harness of ['native','process'])await t.test(harness,async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev'],budget:{max_tool_calls:1},attempts:1})],roles:[{role_id:'reviewer',harness_ref:{id:harness}}],handler:body=>!body.messages[0].content.includes('Inspect fixed')?call('finish',{summary:'implemented'}):body.messages.filter(m=>m.role==='tool').length<2?call('read_file',{path:'fixture'}):call('submit_role_result',{summary:'inspected',findings:[],unknowns:[],inspected_scope:['fixture']})});const plan=f.plan();await f.writer();
  await assert.rejects(f.observer('reviewer'),{code:'stage_budget_exhausted'});
  assert.equal(reconcileAssignments(f.s,'t').stages.find(s=>s.stage_id==='reviewer').waiting_reason,'stage_retry_exhausted');
  const optional={...stage('ux',{deps:['dev']}),required:false};planTask(f.s,'t',f.records.get('t').revision,[...JSON.parse(plan.stages),optional],plan.revision);
  assert.equal(reconcileAssignments(f.s,'t').stages.find(s=>s.stage_id==='dev').status,'passed');
  assert.throws(()=>f.assign('reviewer','retry-again','reviewer'),{code:'stage_retry_exhausted'});
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='reviewer'").n,1);
  });
});

test('contract changes and cancellation preserve history but reject new certification',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']})]});f.plan();await f.writer();await f.observer('reviewer');const old=latestRoleCandidate(f.s,'t');
  f.records.contract('t',{...f.records.get('t').contract,criteria:['new contract requirement']});assert.equal(evaluateRequiredStages(f.s,'t',old).satisfied,false);
  assert.ok(reconcileAssignments(f.s,'t').waiting.some(w=>w.reason==='stage_plan_stale'));assert.throws(()=>f.plan(),{code:'stage_plan_stale',state:'paused'});f.retry();f.plan();assert.equal(latestRoleCandidate(f.s,'t'),null);
  f.s.run("UPDATE tasks SET status='cancelled' WHERE id='t'");assert.throws(()=>f.assign('dev','after-cancel','dev'),{code:'task_claim_revoked'});
  assert.equal(f.s.get('SELECT count(*) n FROM task_stage_results').n,2);
});

test('later snapshot operations keep the collected commit for unchanged files, but changed trees create new inputs',async t=>{
  const {Workspace}=await import('../dist/agent/workspace.js');const f=await fixture(t,{stages:[stage('dev',{writer:true})]});f.plan();await f.writer();
  let version=tree('b');const manager={call:async()=>({ok:true,result:{local_sha:tree('c'),tree_sha:version,files:[]}})},workspace=new Workspace(f.s,manager,f.spec().task,new Redactor(),async()=>{},()=>{});
  assert.equal((await workspace.artifact('later-observer')).local_sha,tree('a'));
  version=tree('d');assert.equal((await workspace.artifact('changed-source')).local_sha,tree('c'));
});

test('failed, truncated or irrelevant observations do not satisfy required execution evidence',async t=>{
  const review=stage('reviewer',{deps:['dev']});review.completion.tools=['run_command'];
  const f=await fixture(t,{stages:[stage('dev',{writer:true}),review],handler:body=>body.messages[0].content.includes('Inspect fixed')?(body.messages.at(-1).role==='tool'?call('submit_role_result',{summary:'claimed pass',findings:[],unknowns:[],inspected_scope:['fixture']}):call('run_command',{command:'npm test'})):call('finish',{summary:'implemented'})});f.plan();await f.writer();f.assign('reviewer','bad-proof','reviewer');
  const current=latestRoleCandidate(f.s,'t');traceEvent(f.s,'t','role_candidate',{role:'reviewer',sha:current.commit_sha,version:current.tree_hash,workspace_id:'readonly'});
  await runRole({...f.spec(),system:'Inspect fixed',tools:[tool('run_command'),tool('submit_role_result')],finish:{name:'submit_role_result',validate:v=>v},execute:async()=>({exit_code:1,output:'assertion failed'})},'reviewer','bad-proof');
  const result=JSON.parse(f.s.get("SELECT result FROM task_stage_results WHERE stage_id='reviewer'").result);
  assert.equal(result.passed,false);assert.deepEqual(result.evidence,[]);assert.equal(result.reason,'insufficient_evidence');assert.equal(evaluateRequiredStages(f.s,'t',current).satisfied,false);
});

test('wall budget cancels an in-flight backend without turning budget exhaustion into task cancellation',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true,budget:{max_wall_seconds:1}})],handler:async()=>{await new Promise(r=>setTimeout(r,1200));return call('finish',{summary:'late result'});}});f.plan();
  await assert.rejects(f.writer(),error=>error.code==='stage_budget_exhausted'&&error.state==='paused');
  assert.equal(f.s.get('SELECT count(*) n FROM task_stage_results').n,0);assert.ok(f.s.get("SELECT id FROM task_history WHERE type='role_run_checkpoint' AND json_extract(data,'$.reason') LIKE 'stage_budget_exhausted:%'"));
  assert.equal(f.s.get('SELECT count(*) n FROM role_run_tokens WHERE revoked_at IS NULL').n,0);
});

test('new gate policy invalidates old QA even after stages are rerun, and Publisher cannot send before fresh QA',async t=>{
  const {Publisher}=await import('../dist/github/publisher.js');const f=await fixture(t,{stages:[stage('dev',{writer:true})]});f.plan();await f.writer();
  const candidate=f.records.submit('t',[{kind:'code',reference:'source',version:tree('b'),content:{local_sha:tree('a')}}],[],{}),verdict={outcome:'pass',reason:'verified',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
  traceEvent(f.s,'t','acceptance_started',{candidate_id:candidate.id,source_tree:tree('b'),context:'fresh'});await runRole({...f.spec(),system:'QA verified'},'qa');f.records.stage('t',candidate.id,candidate.revision,verdict);
  f.s.run("UPDATE policies SET test_command='changed check' WHERE repository_id='r'");assert.throws(()=>f.plan(),{code:'stage_policy_changed',state:'paused'});f.retry();f.plan();await f.writer('dev-recheck');assert.equal(evaluateRequiredStages(f.s,'t',latestRoleCandidate(f.s,'t')).satisfied,true);
  assert.throws(()=>f.records.stage('t',candidate.id,candidate.revision,verdict),{code:'acceptance_required'});
  let sends=0;const github={},publisher=new Publisher(f.s,github,f.spec().task,async()=>{});const send=async()=>{github.beforeWrite?.();sends++;return {ok:true};};
  await assert.rejects(publisher.effect('publish','fixture',{},send,async()=>null),{code:'acceptance_required'});assert.equal(sends,0);
  assert.equal(f.s.get("SELECT state FROM github_effects").state,'pending');assert.equal(f.s.get('SELECT count(*) n FROM task_followups').n,0);
  await runRole({...f.spec(),system:'QA verified'},'qa');f.records.stage('t',candidate.id,candidate.revision,verdict);
  await publisher.effect('publish','fixture',{},send,async()=>null);await publisher.effect('publish','fixture',{},send,async()=>null);assert.equal(sends,1);
});

test('an operator can dequeue an accepted PR after stage or test-command policy changes',async t=>{
  for(const change of ['stages','test_command'])await t.test(change,async t=>{
    const {mergeApi}=await import('../dist/roles/merge.js'),{authorizeMerge}=await import('../dist/tasks/integration.js');
    const f=await fixture(t,{stages:[stage('dev',{writer:true})]});f.plan();await f.writer();
    const candidate=f.records.submit('t',[{kind:'code',reference:'source',version:tree('b'),content:{local_sha:tree('a')}}],[],{}),verdict={outcome:'pass',reason:'verified',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
    traceEvent(f.s,'t','acceptance_started',{candidate_id:candidate.id,source_tree:tree('b'),context:'fresh'});await runRole({...f.spec(),system:'QA verified'},'qa');f.records.decide('t',candidate.id,candidate.revision,verdict,'pr_opened');
    f.s.run("UPDATE tasks SET result=? WHERE id='t'",JSON.stringify({pr_number:1,sha:tree('a')}));
    f.s.run("UPDATE accounts SET type='bot_account',credentials=? WHERE id='a'",f.s.secrets.seal({token:'fixture-queue-token'},'account:a'));
    const user={id:'owner',role:'project_admin',repositories:['r']};authorizeMerge(f.s,f.spec().task,user,tree('a'),'squash');
    f.s.run("UPDATE task_merge_requests SET state='queued' WHERE task_id='t'");
    f.s.run("INSERT INTO github_effects VALUES('enqueued','t','merge_queue','{}','sent','{}','fixture')");
    if(change==='stages')saveConfiguration(f.s,'r',{expected_revision:1,enabled:true,roles:[],required_stages:[stage('dev',{writer:true}),stage('reviewer',{deps:['dev']})]},'owner');
    else f.s.run("UPDATE policies SET test_command='new check' WHERE repository_id='r'");
    let dequeues=0;const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{},path=new URL(req.url,'http://fixture').pathname;
      const value=path==='/repositories/r'?{id:'r',full_name:'fixture/stages',owner:{id:'o'},default_branch:'main'}:path.endsWith('/pulls/1')?{node_id:'PR_fixture',number:1,state:'open',merged:false,head:{sha:tree('a')}}:path==='/graphql'?body.query.includes('dequeuePullRequest')?(dequeues++,{data:{dequeuePullRequest:{clientMutationId:null}}}):{data:{repository:{pullRequest:{id:'PR_fixture',mergeQueueEntry:{id:'entry'}}}}}:{};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
    });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
    const response=await mergeApi(f.s,user,'DELETE',new URL('http://local/api/tasks/t/merge'),{},'http://127.0.0.1:'+server.address().port);
    assert.equal(response.cancelled,true);assert.equal(dequeues,1);assert.equal(f.s.get("SELECT state FROM task_merge_requests WHERE task_id='t'").state,'cancelled');
    assert.equal(f.s.get("SELECT state FROM github_effects WHERE kind='dequeue'").state,'sent');
  });
});

test('simultaneous writer starts cannot pass the pre-bind race or reuse a handle belonging to another assignment',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true})]});f.plan();f.assign('dev','race-one','dev');f.assign('dev','race-two','dev');
  const outcomes=await Promise.allSettled(['race-one','race-two'].map(id=>runRole(f.spec(),'dev',id,undefined,{snapshot:async()=>({local_sha:tree('a'),tree_sha:tree('b')})})));
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
  assert.ok(['role_run_already_active','candidate_writer_busy'].includes(outcomes.find(o=>o.status==='rejected').reason.code));assert.equal(f.calls.length,1);assert.equal(f.s.get('SELECT count(*) n FROM task_stage_results').n,1);
});

test('artifact gates bind report content as well as file tree, so changed prose cannot inherit an old pass',async t=>{
  const f=await fixture(t,{stages:[stage('dev',{writer:true,types:['artifact']}),stage('reviewer',{deps:['dev'],types:['artifact']})]});
  f.s.run("UPDATE tasks SET kind='task.request' WHERE id='t'");f.records.contract('t',{...f.records.get('t').contract,endpoint:'artifact'});f.plan();
  const delivered=await f.writer();assert.equal(delivered.candidate_ref.kind,'artifact');await f.observer('reviewer');
  const artifacts=[{kind:'report',reference:'report:t',version:'v1',content:delivered.result},{kind:'files',reference:'files:t',version:tree('b'),content:{local_sha:tree('a')}}];
  const original=f.records.submit('t',artifacts,[],delivered.result);assert.equal(candidateKey(deliveryCandidate(original)),candidateKey(delivered.candidate_ref));assert.equal(evaluateRequiredStages(f.s,'t',deliveryCandidate(original)).satisfied,true);
  const changed=f.records.submit('t',[{...artifacts[0],version:'v2',content:{summary:'changed report prose'}},artifacts[1]],[],{summary:'changed report prose'});
  assert.equal(evaluateRequiredStages(f.s,'t',deliveryCandidate(changed)).satisfied,false);
});
