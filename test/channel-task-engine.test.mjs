import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { channelFixture, inGroup, post, until } from './channel-fixture.mjs';
import { server as github } from './fixtures/agent-server.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { roleApi } from '../dist/roles/api.js';
import { roleConfiguration } from '../dist/roles/definition.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { resolvePrincipalActor } from '../dist/identity/authorization.js';

const pass={outcome:'pass',reason:'Read the actual fixed candidate and its policy evidence',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
// A task a legacy group employee created before #312 keeps its scheduler, QA, publication and group notification.
for(const scenario of ['report','reviewable_pull_request','revoked_after_qa','policy_changed_after_qa'])test('a legacy group employee task uses the real scheduler/role/QA and returns '+scenario+' once (local protocol fixtures)',{timeout:180000},async t=>{
  const endpoint=scenario==='report'?'report':'reviewable_pull_request',software=endpoint!=='report',revoked=scenario==='revoked_after_qa',changed=scenario==='policy_changed_after_qa',role=software?'dev':'reviewer',root=mkdtempSync(join(tmpdir(),'channel-engine-')),manager=new LocalManager('101',root);
  let engine,f,release;const gate=new Promise(r=>release=r);let executing=false,qaReads=0,deliveryTask,modelError;
  github.listen(0,'127.0.0.1');await once(github,'listening');const gh='http://127.0.0.1:'+github.address().port;
  try{
    f=await channelFixture(undefined,store=>({engine:engine=new TaskEngine(store,manager,gh+'/github')}));
    await fetch(gh+'/fixture/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({github_token:f.a.token})});
    f.h.store.run("UPDATE repositories SET full_name='fixture/project-101' WHERE id='101'");
    f.h.store.run("UPDATE tasks SET status='cancelled'");
    f.h.store.run("UPDATE policies SET development_enabled=?,test_command=?,work_settings=? WHERE repository_id='101'",software?1:0,software?'node --input-type=module -e "import { verified } from \'./feature.mjs\'; if(verified!==true)process.exit(1)"':'',JSON.stringify({'task.request':{writes:software?['code','pull_request']:[]}}));
    roleApi(f.h.store,{id:f.principal,role:'super_admin',repositories:[]},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:0,enabled:false,roles:[
      {role_id:role,harness_ref:{id:'native'},permissions:{task_management:'write',delegation:'deny',...(software?{}:{commands:'deny'})}},
      {role_id:'qa',harness_ref:{id:'native'}}]});
    const discovery=inGroup('Discover for actual execution');discovery.event.message.mentions=[];await post(f.h,f.id,discovery);
    const chat=f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
    await f.service.employees.configure(resolvePrincipalActor(f.h.store,f.principal,null,'101'),chat.id,{project_id:'101',role_id:role,capabilities:['tasks.read','tasks.manage_own','knowledge.read'],enabled:true,expected_revision:0});
    const initial=await (await fetch(gh+'/fixture/state')).json(),before=initial.prs.length,writesBefore=initial.requests.filter(r=>r.method!=='GET'&&r.path.includes('/git/')).length;
    if(software&&!revoked&&!changed)await fetch(gh+'/fixture/faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pull_request_server_errors:1})});
    f.modelState.respond=async(body,res)=>{try{
      const names=body.messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls??[]).map(c=>c.function.name),tools=body.tools.map(t=>t.function.name);
      const send=(name,args)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'step-'+f.requests.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:8,completion_tokens:4}}));};
      if(tools.includes('submit_acceptance')){
        if(!names.includes('read_file'))return send('read_file',{path:software?'feature.mjs':'calc.mjs'});
        assert.ok(body.messages.some(m=>m.role==='tool'&&m.content.includes(software?'verified = true':'export const add')));qaReads++;
        assert.equal((await (await fetch(gh+'/fixture/state')).json()).prs.length,before,'no publication before independent acceptance');
        if(revoked)roleApi(f.h.store,{id:f.principal,role:'super_admin',repositories:[]},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:roleConfiguration(f.h.store,'101').revision,enabled:false,roles:[{role_id:role,permissions:{pull_request:'deny'}}]});
        if(changed&&qaReads===1)f.h.store.run("UPDATE policies SET test_command=? WHERE repository_id='101'",'node -e "process.exit(0)"');
        return send('submit_acceptance',pass);
      }
      if(tools.includes('submit_delivery')){
        executing=true;await gate;
        if(!names.includes('read_file'))return send('read_file',{path:'calc.mjs'});
        if(software&&!names.includes('write_file'))return send('write_file',{path:'feature.mjs',content:'export const verified = true;\n'});
        return send('submit_delivery',{summary:software?'Verified software delivered from the group':'Verified report delivered from the group',artifacts:software?[{path:'feature.mjs',description:'Verified module'}]:[],evidence:[],unknowns:[],...(software?{change_title:'feat: add verified module',release_label:'release:patch',test_command:'Project policy check'}:{})});
      }
      throw new Error('unexpected model request: '+tools.join(','));
    }catch(error){modelError=error;if(!res.writableEnded){res.statusCode=500;res.end(JSON.stringify({error:{message:'Local fixture assertion failed'}}));}}};
    // The legacy employee's caller is what its conversation used to create the task; the source is an unbound member's message.
    const commands=f.service.management.service.tasks,quiet=async text=>{const e=inGroup(text,'ou_bob');e.event.message.mentions=[];const r=await post(f.h,f.id,e);
      await until(()=>f.h.store.get('SELECT * FROM channel_inbox WHERE id=?',r.value.operation_id),row=>row&&['completed','failed'].includes(row.state));return {event:e,receipt:r};};
    const {event:source,receipt}=await quiet('Start tracked work from an unbound member'),caller=id=>f.service.employees.caller(chat.id,'101',id);
    commands.tool(caller(receipt.value.operation_id),'create_task',{request:'Independently deliver '+endpoint,criteria:['Return verified work to this group'],endpoint});
    const retryFrom=async text=>{const {receipt:r}=await quiet(text);commands.tool(caller(r.value.operation_id),'manage_task',{task_id:deliveryTask,action:'retry'});};
    const origin=f.h.store.get('SELECT * FROM task_origins WHERE conversation_id=?',chat.id);assert.ok(origin);deliveryTask=origin.task_id;assert.equal(origin.executor_role,role);
    await until(()=>executing||f.h.store.get('SELECT error_code FROM tasks WHERE id=?',origin.task_id)?.error_code,v=>!!v,120000);
    assert.ok(executing,JSON.stringify(f.h.store.all('SELECT content FROM task_logs WHERE task_id=?',origin.task_id)));
    const continued=await post(f.h,f.id,inGroup('Continue while the independent task is running','ou_alice'));
    assert.equal((await until(()=>f.h.store.get('SELECT * FROM channel_inbox WHERE id=?',continued.value.operation_id),r=>r&&['completed','failed'].includes(r.state),120000)).state,'completed');
    assert.equal(f.h.store.get('SELECT status FROM tasks WHERE id=?',origin.task_id).status,'running');
    release();
    let ended=await until(()=>f.h.store.get('SELECT * FROM tasks WHERE id=?',origin.task_id),r=>r&&(['completed','pr_opened','failed','waiting_permission','waiting_configuration','retry_wait','needs_replan'].includes(r.status)),120000);
    assert.ifError(modelError);
    if(revoked){
      assert.equal(ended.status,'waiting_permission',ended.error_code);assert.equal(qaReads,1);
      const state=await (await fetch(gh+'/fixture/state')).json();assert.equal(state.prs.length,before);assert.equal(state.requests.filter(r=>r.method!=='GET'&&r.path.includes('/git/')).length,writesBefore);return;
    }
    if(changed){
      assert.equal(ended.status,'retry_wait',ended.error_code);assert.equal(ended.error_code,'acceptance_context_changed');
      const state=await (await fetch(gh+'/fixture/state')).json();assert.equal(state.requests.filter(r=>r.method!=='GET'&&r.path.includes('/git/')).length,writesBefore);
      await retryFrom('Retry publication after the policy changed');
      ended=await until(()=>f.h.store.get('SELECT * FROM tasks WHERE id=?',origin.task_id),r=>['pr_opened','failed','waiting_permission','waiting_configuration','needs_replan'].includes(r.status),120000);
      assert.equal(JSON.parse(ended.result).validation.command,'node -e "process.exit(0)"');
    }
    if(software&&!changed){
      assert.equal(ended.status,'retry_wait',JSON.stringify({task:ended,logs:f.h.store.all('SELECT content FROM task_logs WHERE task_id=?',origin.task_id)}));assert.equal(ended.phase,'publish');assert.equal(qaReads,1);
      const executionCount=f.h.store.get('SELECT count(*) n FROM task_runs WHERE task_id=? AND role=?',origin.task_id,role).n;
      for(const [n,status] of [[1,'waiting_publication'],[2,'pr_opened']]){
        await retryFrom('Retry publication '+n);
        ended=await until(()=>f.h.store.get('SELECT * FROM tasks WHERE id=?',origin.task_id),r=>r.status===status||['failed','waiting_permission','waiting_configuration','needs_replan'].includes(r.status),120000);
        assert.equal(ended.status,status,JSON.stringify(f.h.store.all('SELECT content FROM task_logs WHERE task_id=?',origin.task_id)));
      }
      assert.equal(qaReads,1,'recovery reuses the accepted fixed candidate');assert.equal(f.h.store.get('SELECT count(*) n FROM task_runs WHERE task_id=? AND role=?',origin.task_id,role).n,executionCount);
    }
    assert.ifError(modelError);
    assert.equal(ended.status,software?'pr_opened':'completed',JSON.stringify(f.h.store.all('SELECT content FROM task_logs WHERE task_id=?',origin.task_id)));
    assert.equal(new TaskRecords(f.h.store).get(origin.task_id).acceptance.outcome,'pass');assert.equal(qaReads,changed?2:1);
    assert.deepEqual(f.h.store.all('SELECT role FROM role_instances WHERE task_id=? ORDER BY role',origin.task_id).map(r=>r.role),[role,'qa'].sort());
    assert.equal(f.h.store.get('SELECT count(*) n FROM task_runs WHERE task_id=? AND role=?',origin.task_id,role).n,1);
    assert.equal(f.h.store.get('SELECT count(*) n FROM external_identities WHERE external_actor=?','ou_bob').n,0);
    await until(()=>f.wire.sent.find(s=>JSON.stringify(s.content).includes('Verified '+(software?'software':'report')+' delivered from the group')),v=>!!v,120000);
    await f.service.tick();await post(f.h,f.id,source);await f.service.tick();
    assert.equal(f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'task-result:%'").n,1);
    const state=await (await fetch(gh+'/fixture/state')).json();assert.equal(state.prs.length,before+(software?1:0));
    if(software){const pr=state.prs.at(-1);assert.equal(pr.head.ref,'bot/task-'+origin.task_id);assert.ok(!/Closes #(?:0|null|undefined)/.test(pr.body));assert.equal(f.h.store.get('SELECT count(*) n FROM github_effects WHERE task_id=?',origin.task_id).n,2);}
  }finally{
    release?.();await engine?.close();await manager.recover();if(f){await f.close();rmSync(f.h.directory,{recursive:true,force:true});}await new Promise(r=>{github.close(r);github.closeAllConnections();});rmSync(root,{recursive:true,force:true});
  }
});
