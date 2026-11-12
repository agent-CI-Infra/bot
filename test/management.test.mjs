import test from 'node:test';
import assert from 'node:assert/strict';
import { managementFixture, query, command, settled } from './management-fixture.mjs';
import { managerSection, repository } from './helpers.mjs';
import { resolveActor, resolvePrincipalActor } from '../dist/identity/authorization.js';
import { ManagementService } from '../dist/management/service.js';
import { ManagementAgent } from '../dist/management/agent.js';
import { RuleService } from '../dist/rules/service.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { executionModel, taskConfiguration } from '../dist/tasks/configuration.js';
import { roleApi } from '../dist/roles/api.js';
import { managementStorage } from '../dist/management/storage.js';
const project={project_id:'101'},workflow={...project,workflow_id:'review.issue'},task={...project,task_id:'blocked'};
const service=h=>new ManagementService(h.store,new RuleService(h.store),new TaskCommands(h.store));

test('scoped facts, original logs and revisions agree with legacy API; forged actors and unknown fields never confer authority',async t=>{
  const {h,admin,member}=await managementFixture(t),single=await member('single',{repository_ids:['101']}),whole=await member('whole',{organization_ids:['10']}),ordinary=await member('ordinary',{});
  assert.deepEqual((await query(single.client,'list_projects')).value.projects.map(p=>p.id),['101']);
  assert.deepEqual((await query(whole.client,'list_projects')).value.projects.map(p=>p.id).sort(),['101','102']);
  assert.deepEqual((await query(ordinary.client,'list_projects')).value.projects,[]);
  assert.equal((await query(admin,'list_projects')).value.projects.length,3);
  for(const client of [single.client,whole.client,ordinary.client])assert.equal((await query(client,'get_task',{project_id:'201',task_id:'foreign'})).status,403);
  const read=(await query(single.client,'get_task',task)).value,legacy=(await single.client('/api/tasks/blocked')).value;
  assert.equal(read.task.status,legacy.task.status);assert.equal(read.task.error_code,'environment_not_ready');assert.ok(read.runs_url);assert.ok(read.allowed_next_steps.includes('task.retry'));
  const logs=(await query(single.client,'get_task',task,{section:'logs',limit:1})).value;
  assert.equal(logs.logs[0].source_ref,'task_logs:log-blocked');assert.ok(logs.logs[0].content.includes('Project computer is stopped'));
  assert.equal((await query(single.client,'get_task',task,{section:'source',source:'project_memories:foreign:1'})).status,404);
  assert.equal((await single.client('/api/management/query','POST',{operation:'list_projects',target:{},arguments:{},actor:{capabilities:['*'],tenant_id:'other'}})).status,400);
  assert.equal((await command(admin,'project.update',task,{review_enabled:true},'wrong-revision-resource',read.revision)).value.error,'invalid_management_target');
  const actor=resolveActor(h.store,single.client.cookie().slice('bot_session='.length));
  await assert.rejects(()=>service(h).query({...actor},{operation:'list_projects',target:{},arguments:{}}),{code:'untrusted_actor'});
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,2);
});

test('configuration commands execute normally, conflict without overwrite, replay the same result and disclose overridden console layers',async t=>{
  const {h,admin}=await managementFixture(t),before=(await query(admin,'get_effective_config',project)).value;
  const result=await command(admin,'workflow.update',workflow,{prompt:'New default'},'save-one',before.revision);
  assert.equal(result.status,201);assert.equal(result.value.state,'succeeded');assert.equal(result.value.channel,'api');assert.equal(result.value.result.diff.after.prompt,'New default');assert.equal(result.value.result.effect,'future_tasks');
  assert.deepEqual((await command(admin,'workflow.update',workflow,{prompt:'New default'},'save-one',before.revision)).value,result.value);
  const conflicting=await command(admin,'workflow.update',workflow,{prompt:'Stale value'},'stale',before.revision);assert.equal(conflicting.status,409);assert.equal(conflicting.value.error,'management_revision_conflict');
  assert.equal((await managerSection(admin,'101','review.issue')),'New default');
  assert.equal((await command(admin,'workflow.update',workflow,{prompt:'Different payload'},'save-one',before.revision)).value.error,'idempotency_conflict');
  h.store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)','101','a'.repeat(40),JSON.stringify({'.bot/rules/issue-review.md':'Repository rule'}),'now');
  const overridden=await command(admin,'workflow.update',workflow,{prompt:'Console shadow'});
  assert.equal(overridden.value.result.effect,'console_overridden');assert.equal(overridden.value.result.effective,false);
  const effective=(await query(admin,'get_effective_config',project)).value.workflows.find(w=>w.id==='review.issue');assert.equal(effective.prompt.source,'repository');assert.equal(effective.prompt.version,'a'.repeat(40));assert.equal(effective.prompt.effective,'Repository rule');
  assert.equal(h.store.get("SELECT count(*) n FROM management_approvals").n,0);
  assert.equal((await query(admin,'list_audit',project)).value.audit.filter(r=>r.state==='succeeded'&&r.operation==='workflow.update').length,2);
});

test('disabled projects save review and development defaults without enabling execution',async t=>{
  const {h,admin,member}=await managementFixture(t),single=await member('project-admin',{repository_ids:['101']});
  assert.equal((await single.client('/api/repositories/101/policy','PATCH',{enabled:false})).status,200);
  const count=h.store.get('SELECT count(*) n FROM tasks').n;
  assert.deepEqual((await query(single.client,'get_effective_config',project)).value.task_creation,{allowed:false,reason:'project_disabled'});
  for(const key of ['development_enabled','review_enabled']){
    h.store.run(`UPDATE policies SET ${key}=0 WHERE repository_id='101'`);
    const saved=await single.client('/api/repositories/101/policy','PATCH',{[key]:true});
    assert.equal(saved.status,200,JSON.stringify(saved.value));assert.equal(saved.value.policy[key],1);assert.equal(saved.value.policy.enabled,0);
    assert.equal(saved.value.management.state,'succeeded');
    assert.equal(h.store.get("SELECT * FROM policies WHERE repository_id='101'")[key],1);
    const managed=await command(single.client,'project.update',project,{[key]:false});
    assert.equal(managed.value.state,'succeeded');assert.equal(managed.value.result.policy.enabled,0);assert.equal(managed.value.result.policy[key],0);
  }
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,count,'saving defaults does not create work');
  const create=await command(single.client,'task.create',project,{request:'Inspect facts',contract:{goal:'Inspect facts',scope:['project'],criteria:['Cite records'],endpoint:'report'}});
  assert.equal(create.status,409);assert.equal(create.value.error,'project_disabled');
  const retry=await single.client('/api/tasks/blocked/retry','POST',{});assert.equal(retry.status,409);assert.equal(retry.value.error,'project_disabled');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='blocked'").status,'waiting_environment');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,count);
  assert.equal((await admin('/api/repositories/101/policy','PATCH',{enabled:true})).value.policy.enabled,1);
  assert.deepEqual((await query(admin,'get_effective_config',project)).value.task_creation,{allowed:true,reason:null});
  assert.equal((await admin('/api/repositories/101/policy','PATCH',{enabled:false})).value.policy.enabled,0);
});

test('concurrent writes commit one revision; task commands create only one business task, append instructions and invalidate obsolete acceptance explicitly',async t=>{
  const {h,admin}=await managementFixture(t),rev=(await query(admin,'get_effective_config',project)).value.revision;
  const writes=await Promise.all(['a','b'].map(text=>command(admin,'workflow.update',workflow,{prompt:text},text,rev)));
  assert.deepEqual(writes.map(r=>r.status).sort(),[201,409]);
  const args={request:'Write a bounded report',contract:{goal:'Inspect current state',scope:['project 101'],criteria:['Cite original facts'],endpoint:'report'}};
  const first=await command(admin,'task.create',project,args,'new-work');assert.equal(first.value.state,'succeeded');
  const replay=await command(admin,'task.create',project,args,'new-work',first.value.expected_revision);assert.deepEqual(replay.value,first.value);assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,3);
  const id=first.value.result.id;assert.equal(h.store.get('SELECT kind FROM tasks WHERE id=?',id).kind,'task.request');assert.ok(h.store.get('SELECT * FROM task_authorizations WHERE task_id=?',id));
  const record=new TaskRecords(h.store),snapshot=JSON.stringify(record.get(id).contract);
  assert.equal((await command(admin,'task.instructions',{...project,task_id:id},{instruction:'Cite the raw log link'})).value.state,'succeeded');
  assert.equal(JSON.stringify(record.get(id).contract),snapshot);assert.equal(h.store.get("SELECT count(*) n FROM task_history WHERE task_id=? AND type='supplemental_instruction'",id).n,1);
  const candidate=record.submit(id,[{kind:'report',reference:'report',version:'v1'}],[],{});const previous=record.get(id).revision;
  const changed=await command(admin,'task.contract',{...project,task_id:id},{contract:{...args.contract,goal:'A revised goal'}});assert.equal(changed.value.state,'succeeded');assert.equal(record.get(id).revision,previous+1);assert.equal(record.get(id).candidate,null);assert.equal(record.get(id).acceptance,null);
  assert.throws(()=>record.decide(id,candidate.id,previous,{outcome:'pass',reason:'Old',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true}),/stale_acceptance/);
  for(const operation of ['task.pause','task.retry','task.cancel'])assert.equal((await command(admin,operation,task)).value.state,'succeeded');
  assert.equal((await query(admin,'get_task',task)).value.task.status,'cancelled');
});

test('run configuration stays pinned; explicit adoption ends the old run and uses a new execution revision',async t=>{
  const {h,admin}=await managementFixture(t),row=h.store.get("SELECT * FROM tasks WHERE id='blocked'");
  const original=executionModel(h.store,row);const before=taskConfiguration(h.store,row);
  await command(admin,'workflow.update',workflow,{prompt:'Future default',model_id:null});
  assert.deepEqual(executionModel(h.store,row),original);assert.deepEqual(taskConfiguration(h.store,row),before);
  await command(admin,'task.pause',task);const adopted=await command(admin,'task.adopt-config',task);assert.equal(adopted.value.state,'succeeded');
  executionModel(h.store,h.store.get("SELECT * FROM tasks WHERE id='blocked'"));
  assert.equal(h.store.get("SELECT revision FROM task_execution_configs WHERE task_id='blocked'").revision,2);
  assert.notDeepEqual(taskConfiguration(h.store,row),before);
});

test('changing defaults affects newly created tasks while a queued task retains its captured console defaults',async t=>{
  const {h,admin}=await managementFixture(t),args={request:'Inspect facts',contract:{goal:'Inspect facts',scope:['project'],criteria:['Cite original records'],endpoint:'report'}};
  const first=(await command(admin,'task.create',project,args,'before-default-change')).value.result.id;
  const before=taskConfiguration(h.store,h.store.get('SELECT * FROM tasks WHERE id=?',first));assert.ok(before);
  await command(admin,'workflow.update',workflow,{prompt:'A new default for future tasks'});
  const second=(await command(admin,'task.create',project,args,'after-default-change')).value.result.id;
  assert.deepEqual(taskConfiguration(h.store,h.store.get('SELECT * FROM tasks WHERE id=?',first)),before);
  const next=taskConfiguration(h.store,h.store.get('SELECT * FROM tasks WHERE id=?',second));assert.equal(JSON.parse(next.policy.rule_overrides)['.bot/rules/issue-review.md'],'A new default for future tasks');
  const records=new TaskRecords(h.store),candidate=records.submit(first,[{kind:'report',reference:'r',version:'tree'}],[],{});
  await command(admin,'task.pause',{...project,task_id:first});await command(admin,'task.adopt-config',{...project,task_id:first});
  const revised=records.submit(first,[{kind:'report',reference:'r',version:'tree'}],[],{});assert.notEqual(candidate.id,revised.id);
});

test('commands execute directly: a leftover approval policy holds nothing back, the approval endpoint is gone and a waiting command never runs',async t=>{
  const {h,admin,member}=await managementFixture(t),single=await member('single',{repository_ids:['101']});
  // A policy written by an older version is no longer read: the authorized operator's command runs at once.
  h.store.run("INSERT INTO management_policies(tenant_id,approval_operations) VALUES('github.com:10','[\"workflow.update\",\"tasks.write\"]')");
  const direct=await command(single.client,'workflow.update',workflow,{prompt:'Saved without approval'},'direct');
  assert.equal(direct.value.state,'succeeded',JSON.stringify(direct.value));assert.equal(await managerSection(admin,'101','review.issue'),'Saved without approval');
  assert.equal(h.store.get('SELECT count(*) n FROM management_approvals').n,0);
  assert.equal((await admin('/api/management/commands/'+direct.value.id+'/approval','POST',{parameter_hash:direct.value.parameter_hash,expected_revision:direct.value.expected_revision,decision:'approve'})).status,404);
  // Authorization is still the operator's own: a deactivated user cannot submit.
  await admin('/api/users/'+single.id,'PATCH',{active:false});
  const denied=await command(single.client,'workflow.update',workflow,{prompt:'Must not save'},'revoked',direct.value.after_revision);
  assert.ok(denied.status>=400||denied.value.state==='failed');assert.equal(await managerSection(admin,'101','review.issue'),'Saved without approval');
  // A command left waiting for approval by an older version ends as failed on startup and is never executed.
  const before=h.store.get("SELECT status FROM tasks WHERE id='blocked'").status;
  h.store.run(`INSERT INTO management_commands(id,principal_id,tenant_id,project_id,channel,operation,target,arguments,expected_revision,idempotency_key,parameter_hash,authorization_revision,execution_fence,source_conversation,source_message,state,before_revision,created_at,updated_at)
    VALUES('legacy-waiting',?,'github.com:10','101','web','task.pause',?,'{}','r','legacy-key','h',1,'f','fixture','legacy','awaiting_approval','r','2026-01-01','2026-01-01')`,direct.value.principal_id,JSON.stringify(task));
  managementStorage(h.store);
  const retired=h.store.get("SELECT * FROM management_commands WHERE id='legacy-waiting'");
  assert.equal(retired.state,'failed');assert.equal(JSON.parse(retired.result).error,'approval_retired');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='blocked'").status,before);
  assert.ok(h.store.all('SELECT * FROM audit').some(row=>Object.values(row).includes('management.failed')&&Object.values(row).includes('legacy-waiting')));
});

test('pending commands stop on project, installation, credentials, budget or authorization changes; unknown effects reconcile without repeating creation',async t=>{
  const {h,admin}=await managementFixture(t),svc=service(h),actor=resolveActor(h.store,admin.cookie().slice('bot_session='.length));
  let sent=0,found=null;
  svc.register('knowledge.revise',{execute:async()=>{sent++;throw new Error('connection dropped after write');},reconcile:async()=>found});
  const rev=svc.revision(project),input={operation:'knowledge.revise',target:project,arguments:{id:'fixture-entry',revision:1,body:'Updated knowledge'},expected_revision:rev,idempotency_key:'uncertain',source_conversation:'fixture',source_message:'uncertain'};
  const unknown=await svc.submit(actor,input);assert.equal(unknown.state,'unknown');assert.equal(sent,1);
  assert.equal((await svc.submit(actor,input)).state,'unknown');assert.equal(sent,1);
  assert.equal((await svc.resume(actor,unknown.id)).state,'unknown');assert.equal(sent,1);
  h.store.run("UPDATE management_commands SET state='executing' WHERE id=?",unknown.id);
  found={registered:true,external_id:'schedule-1'};assert.equal((await svc.resume(actor,unknown.id)).state,'succeeded');assert.equal(sent,1);
  for(const mutation of [()=>h.store.run("UPDATE policies SET enabled=0 WHERE repository_id='101'"),()=>h.store.run("UPDATE installed_repositories SET installed=0 WHERE repository_id='101'"),()=>h.store.run('INSERT INTO management_budgets VALUES(?,?,?)','101','USD',0)]){
    mutation();await assert.rejects(()=>svc.submit(actor,{...input,idempotency_key:'deny-'+Math.random()}));
    h.store.run("UPDATE policies SET enabled=1 WHERE repository_id='101'");h.store.run("UPDATE installed_repositories SET installed=1 WHERE repository_id='101'");h.store.run('DELETE FROM management_budgets');
  }
  assert.equal((await command(admin,'knowledge.revise',project,{id:'entry',revision:1,body:'Updated'})).value.result.error,'memory_not_found');
});

test('persistent conversations execute actual model tools, replay messages and survive reconnect without a second write',async t=>{
  const {h,admin,requests,member}=await managementFixture(t),created=await admin('/api/management/conversations','POST',{scope:'project:101'}),conversation=created.value.conversation.id;
  const body={source_message:'message-1',content:'更新任务默认提示词'};
  const sent=await admin('/api/management/conversations/'+conversation+'/messages','POST',body);assert.equal(sent.status,201);
  const result=await settled(admin,conversation,sent.value.id);assert.equal(result.messages[0].state,'completed');assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE source_conversation=?",conversation).n,1);
  assert.equal((await admin('/api/management/conversations/'+conversation+'/messages','POST',body)).value.id,sent.value.id);
  assert.equal(h.store.get("SELECT count(*) n FROM management_commands WHERE source_conversation=?",conversation).n,1);assert.ok(result.events.some(e=>e.type==='tool_result'&&e.data.result.state==='succeeded'));
  assert.ok(!JSON.stringify(requests).includes('fixture-provider-key'));
  const starts=result.events.filter(e=>e.type==='model_start');assert.deepEqual(starts.map(e=>e.data.turn),[0,1,2]);
  for(const call of result.events.filter(e=>e.type==='tool_call')){
    assert.ok(call.data.call_id);
    const receipt=result.events.find(e=>e.type==='tool_result'&&e.data.call_id===call.data.call_id);
    assert.ok(receipt);assert.ok(receipt.sequence>call.sequence);
  }
  const other=await member('other',{repository_ids:['101']});assert.equal((await other.client('/api/management/conversations/'+conversation)).status,404);
  const last=result.next_after;assert.deepEqual((await admin('/api/management/conversations/'+conversation+'/events?after='+last)).value.events,[]);
});

test('stopping a stream before a tool call prevents writes; model faults are explicit and durable',async t=>{
  const {h,admin,requests,modelState}=await managementFixture(t);
  const conversation=(await admin('/api/management/conversations','POST',{scope:'project:101'})).value.conversation.id;
  let release;modelState.gate=new Promise(r=>release=r);
  const sent=(await admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'stop-before-tool',content:'更新任务默认提示词'})).value;
  for(let i=0;i<100&&!requests.length;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await admin('/api/management/conversations/'+conversation+'/messages/'+sent.id+'/stop','POST',{})).value.state,'stopped');
  release();modelState.gate=null;await new Promise(r=>setTimeout(r,50));
  assert.equal(h.store.get('SELECT count(*) n FROM management_commands WHERE source_conversation=?',conversation).n,0);
  modelState.failure=503;
  const failure=(await admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'provider-failed',content:'任务为什么没继续'})).value;
  const events=await settled(admin,conversation,failure.id);assert.equal(events.messages.find(m=>m.id===failure.id).state,'failed');assert.ok(events.events.some(e=>e.type==='error'&&e.data.error==='model_http_503'));
});

test('read-only grants cannot write through either API or agent, and revocation hides old conversation facts',async t=>{
  const {h,admin,member}=await managementFixture(t),reader=await member('reader',{repository_ids:['101']});
  h.store.run("UPDATE scoped_grants SET capabilities='[\"tasks.read\"]' WHERE principal_id=?",reader.id);
  assert.equal((await query(reader.client,'get_task',task)).status,201);
  assert.deepEqual((await query(reader.client,'get_effective_config',project)).value.task_creation,{allowed:false,reason:'capability_forbidden'});
  assert.equal((await command(reader.client,'task.pause',task)).status,403);
  assert.equal((await reader.client('/api/tasks/blocked/pause','POST',{})).status,403);
  const conversation=(await reader.client('/api/management/conversations','POST',{scope:'project:101'})).value.conversation.id;
  const sent=(await reader.client('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'read-only',command:{operation:'task.pause',target:task,arguments:{},expected_revision:(await query(reader.client,'get_task',task)).value.revision}})).value;
  const history=await settled(reader.client,conversation,sent.id);assert.equal(history.messages[0].state,'failed');assert.ok(history.events.some(e=>e.type==='tool_error'&&e.data.error==='capability_forbidden'));
  await admin('/api/project-admin-assignments','PUT',{user_id:reader.id,repository_ids:['201']});
  assert.equal((await reader.client('/api/management/conversations/'+conversation)).status,403);
});

test('direct commands recheck credentials, budgets and withdrawn grants before executing',async t=>{
  const {h,admin,a,member}=await managementFixture(t),operator=await member('operator',{repository_ids:['101']});
  const credentials=h.store.get('SELECT credentials FROM accounts WHERE id=?',a.id).credentials;
  const mutations=[
    {expected:'account_credentials_revoked',apply:()=>h.store.run('UPDATE accounts SET credentials=? WHERE id=?',h.store.secrets.seal({},'account:'+a.id),a.id),restore:()=>h.store.run('UPDATE accounts SET credentials=? WHERE id=?',credentials,a.id)},
    // An installation change before submission is simply the context the command runs in; the execution fence still stops a
    // reconciliation whose context changed after submission (see the pending-command test above).
    {expected:'budget_exhausted',apply:()=>h.store.run("INSERT INTO management_budgets VALUES('101','USD',0)"),restore:()=>h.store.run('DELETE FROM management_budgets')},
  ];
  const code=result=>result.value?.result?.error??result.value?.error;
  for(const [i,mutation] of mutations.entries()){
    // Without an approval step the same fences stop the command when it executes; nothing runs and the task is unchanged.
    const revision=(await query(operator.client,'get_task',task)).value.revision;
    mutation.apply();
    const result=await command(operator.client,'task.retry',task,{},'direct-'+i,revision);
    assert.ok(result.status>=400||result.value.state==='failed',JSON.stringify(result.value));assert.equal(code(result),mutation.expected,JSON.stringify(result.value));
    assert.equal(h.store.get("SELECT status FROM tasks WHERE id='blocked'").status,'waiting_environment');mutation.restore();
  }
  await admin('/api/project-admin-assignments','PUT',{user_id:operator.id,repository_ids:[]});
  const denied=await command(operator.client,'task.retry',task,{},'withdrawn','stale');
  assert.ok(denied.status>=400||denied.value.state==='failed');assert.equal(h.store.get("SELECT status FROM tasks WHERE id='blocked'").status,'waiting_environment');
});

test('management and the roles console share V2 configuration, revision errors and field diagnostics',async t=>{
  const {admin}=await managementFixture(t,s=>({engine:{active:new Map(),tick(){},api:(user,method,url,body)=>roleApi(s,user,method,url,body)}}));
  const initial=(await admin('/api/repositories/101/roles')).value;
  const saved=await command(admin,'roles.update',project,{expected_revision:initial.revision,enabled:true,roles:[{role_id:'reviewer',persona_prompt:'V2 through management.'}]},'v2-roles');
  assert.equal(saved.value.state,'succeeded');
  const current=(await admin('/api/repositories/101/roles')).value;
  assert.equal(current.configuration.roles.find(r=>r.role_id==='reviewer').persona_prompt,'V2 through management.');
  assert.equal((await query(admin,'get_effective_config',project)).value.roles.configuration.revision,current.revision);
  const stale=await admin('/api/repositories/101/roles','PUT',{expected_revision:initial.revision,enabled:true});
  assert.equal(stale.status,409);assert.equal(stale.value.error,'role_configuration_conflict');assert.equal(stale.value.field,'expected_revision');
  const invalid=await admin('/api/repositories/101/roles','PUT',{expected_revision:current.revision,enabled:true,roles:[{role_id:'manager',harness_ref:{id:'unregistered'}}]});
  assert.equal(invalid.status,400);assert.equal(invalid.value.error,'unknown_role_harness');assert.equal(invalid.value.field,'roles.manager.harness_ref.id');
});

test('one model message may query ten projects at once; unknown tools and malformed arguments come back to the model and large results stay bounded (#333)',async t=>{
  const {h,admin,a,requests,modelState}=await managementFixture(t);
  for(const id of ['103','104','105','106','107','108','109'])await repository(admin,a.id,id);
  const projects=h.store.all('SELECT id FROM repositories ORDER BY id').map(r=>r.id),time=new Date().toISOString();assert.equal(projects.length,10);
  // Twenty failed tasks with long Chinese summaries per project: every list_tasks result is larger than its share.
  for(const project of projects)for(let n=0;n<20;n++)h.store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,error_code,created_at,updated_at) VALUES(?,?,'task.request','failed','prepare',?,'environment_not_ready',?,?)",
    project+'-'+n,project,'项目电脑没有启动，任务等待环境'.repeat(40),time,time);
  const conversation=(await admin('/api/management/conversations','POST',{scope:'platform'})).value.conversation.id;
  modelState.respond=async(body,res)=>{
    const message=body.messages.some(m=>m.role==='tool')?{role:'assistant',content:'10 个项目都有失败的任务，主要原因是项目电脑没有启动。'}
      :{role:'assistant',content:null,tool_calls:[...projects.map(id=>({id:'call-'+id,type:'function',function:{name:'management_query',arguments:JSON.stringify({operation:'list_tasks',target:{project_id:id},arguments:{limit:20}})}})),
        {id:'call-unknown',type:'function',function:{name:'drop_everything',arguments:'{}'}},{id:'call-broken',type:'function',function:{name:'management_query',arguments:'{broken'}},
        {id:'call-invalid',type:'function',function:{name:'management_query',arguments:JSON.stringify({operation:'no_such_query',target:{},arguments:{}})}}]};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:12,completion_tokens:6}}));
  };
  const sent=(await admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'many-projects',content:'汇总我所有项目里失败的任务'})).value;
  const result=await settled(admin,conversation,sent.id);
  assert.equal(result.messages.find(m=>m.id===sent.id).state,'completed',JSON.stringify(result.events.filter(e=>e.type==='error')));
  assert.ok(result.events.some(e=>e.type==='reply'&&/10 个项目/.test(e.data.text)));
  assert.equal(result.events.filter(e=>e.type==='tool_result').length,10,'every project was queried');
  // The second request answers all thirteen calls: the model can correct unknown tools and malformed arguments.
  const second=requests.at(-1),tools=second.messages.filter(m=>m.role==='tool'),seen=Object.fromEntries(tools.map(m=>[m.tool_call_id,JSON.parse(m.content)]));
  assert.equal(tools.length,13);
  assert.equal(seen['call-unknown'].error,'tool_not_allowed');assert.equal(seen['call-broken'].error,'invalid_arguments');assert.equal(seen['call-invalid'].error,'invalid_management_arguments');
  for(const id of projects){assert.equal(seen['call-'+id].truncated,true,id);assert.ok(Buffer.byteLength(tools.find(m=>m.tool_call_id==='call-'+id).content)<=256*1024/10+512,id);}
  assert.ok(tools.reduce((sum,m)=>sum+Buffer.byteLength(m.content),0)<=256*1024+13*512,'the batch stays within its budget');
  assert.ok(Buffer.byteLength(JSON.stringify(second))<384*1024,'the follow-up request stays well inside the model context');
});

test('long earlier answers stay bounded in the history the management assistant continues from (#333)',async t=>{
  const {h,admin,requests,modelState}=await managementFixture(t);
  const conversation=(await admin('/api/management/conversations','POST',{scope:'platform'})).value.conversation.id;
  let answer='很长的回答'.repeat(4000);
  modelState.respond=async(body,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:answer}}],usage:{prompt_tokens:12,completion_tokens:6}}));};
  for(let n=0;n<20;n++){const sent=(await admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'long-'+n,content:'说明一下第 '+n+' 个问题'})).value;await settled(admin,conversation,sent.id);}
  answer='好的。';
  const sent=(await admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'after-long',content:'继续'})).value;await settled(admin,conversation,sent.id);
  const context=JSON.parse(requests.at(-1).messages[1].content);
  assert.ok(context.history.length>=1&&context.history.length<20);assert.ok(context.earlier_rounds_omitted>0);
  assert.equal(context.history.at(-1).request.content,'说明一下第 19 个问题','the latest rounds stay');
  assert.ok(context.history.every(m=>m.reply.length===4000&&m.reply_truncated===true));
  assert.ok(Buffer.byteLength(JSON.stringify(context.history))<=96*1024);
  assert.equal(h.store.get("SELECT count(*) n FROM management_messages WHERE conversation_id=? AND state='completed'",conversation).n,21);
});

test('public task creation accepts development intent and PR endpoint inference through the management boundary',async t=>{
 const {h,admin}=await managementFixture(t);await admin('/api/repositories/101/policy','PATCH',{development_enabled:true});
 for(const intent of ['development',undefined,'report']){
  const software=intent!=='report',contract={goal:'Observable delivery '+String(intent),scope:['project'],criteria:['Executable result'],endpoint:software?'reviewable_pull_request':'report'};
  const response=await admin('/api/tasks','POST',{repository_id:'101',request:contract.goal,contract,...(intent?{intent}:{})});
  assert.equal(response.status,200,JSON.stringify(response.value));assert.ok(response.value.id);
  const task=h.store.get('SELECT * FROM tasks WHERE id=?',response.value.id);assert.equal(task.kind,software?'task.development':'task.request');assert.equal(task.object_number,null);
 }
 const before=h.store.get('SELECT count(*) n FROM tasks').n;await admin('/api/repositories/101/policy','PATCH',{development_enabled:false});
 const refused=await admin('/api/tasks','POST',{repository_id:'101',request:'No grant',intent:'development',contract:{goal:'No grant',scope:['project'],criteria:['result'],endpoint:'reviewable_pull_request'}});
 assert.equal(refused.status,403);assert.equal(refused.value.error,'task_software_disabled');assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,before);
});
