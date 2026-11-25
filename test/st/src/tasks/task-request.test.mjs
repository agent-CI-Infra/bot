import { pinLegacyTaskConfiguration } from '../../../fixtures/helpers.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { server as github } from '../../../fixtures/agent-server.mjs';
import { configureModelRetry } from '../../../../dist/agent/runtime.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { replyChatCompletion } from '../../../fixtures/openai-sse.mjs';

const pass={outcome:'pass',reason:'Read the actual submitted report from its pinned Git object',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
const call=(name,args,id)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('historical ordinary tasks omit retired guidance, correct invalid paths, and resume only fresh acceptance after an outage',async t=>{
 configureModelRetry({baseMs:1});t.after(()=>configureModelRetry(null));
 const root=mkdtempSync(join(tmpdir(),'bot-request-flow-')),store=new Store(':memory:',randomBytes(32)),records=new TaskRecords(store),manager=new LocalManager('101',root);
 t.after(async()=>{await manager.recover();store.close();rmSync(root,{recursive:true,force:true});});
 github.listen(0,'127.0.0.1');await once(github,'listening');t.after(()=>new Promise(r=>{github.close(r);github.closeAllConnections();}));
 const gh='http://127.0.0.1:'+github.address().port;
 await fetch(gh+'/fixture/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({github_token:'fixture-github-token'})});
 // Outages last six requests: longer than the transport's five retries, so the attempt itself fails.
 let executionCalls=0,acceptanceCalls=0,firstOutage=6,invalidPathObserved=false,acceptedDeliveries=0,inheritedRead=false,siblingRead=false,writeOutage=0,restoredLateWrite=false,inheritedContextRead=false,legacyParent;
 const remediations=new Map();
 const model=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw),messages=body.messages;
  const accepting=messages[0].content.includes('independent delivery acceptance evaluator');
  const send=message=>replyChatCompletion(res,message,{stream:Boolean(body.stream)});
  const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls||[]),names=calls.map(c=>c.function.name);
  if(accepting){
   acceptanceCalls++;
   if(firstOutage>0){firstOutage--;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'temporary outage'}}));return;}
   if(!names.includes('read_file'))return send(call('read_file',{path:'report.md'},'accept-read'));
   assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('Observed repository fact')));
   const pack=JSON.parse(messages[1].content),mode=pack.contract.goal.split(' ').at(-1);
   if(pack.contract.source?.residual==='follow-report-2')assert.ok(pack.related_deliveries.some(d=>d.relationship==='accepted_sibling'));
   if(['return','insufficient_evidence'].includes(mode)){
    const round=(remediations.get(mode)||0)+1;remediations.set(mode,round);
    if(round===1)return send({role:'assistant',content:JSON.stringify({...pass,outcome:mode,core_complete:mode!=='return',required_evidence_complete:false,gaps:['Add the omitted observation and its source to the report']})});
    assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('Recovered observation with source calc.mjs')));
   }
   acceptedDeliveries++;
   const verdict=acceptedDeliveries===2?{...pass,outcome:'pass_with_issues',residuals:[{key:'follow-report',description:'Independent report extension',evidence:'The requested report is complete',impact:'Extra documentation',nonblocking_reason:'The extension is independent of the completed report',goal:'Write follow-up from the inherited report',criteria:['Read the original report and deliver the extension']},{key:'follow-report-2',description:'Independent second extension',evidence:'Original report is complete',impact:'Documentation',nonblocking_reason:'A separate addition',goal:'Extend the accepted sibling report',criteria:['Read the accepted sibling artifact and preserve its extension']}]}:pass;
   return send({role:'assistant',content:JSON.stringify(verdict)});
  }
  if(body.tools?.some(t=>t.function.name==='submit_followup_plan')){const context=JSON.parse(messages[1].content);return send(call('submit_followup_plan',{items:context.qa.residuals.map(r=>({key:r.key,priority:'P3',reason:'Independent optional report extension; core report verified',evidence_refs:[r.evidence],action:'new',needs:[]}))},'followup-plan'));}
  // #1256: a task frozen with the Manager switch off runs under the Manager team. It hands the work to dev, reads the
  // dev result and nominates it.
  if(body.tools?.some(t=>t.function.name==='delegate_role')){
   assert.ok(!/playbook_catalog|playbook_request|select_playbooks/.test(JSON.stringify(messages.slice(0,2))));
   const turn=messages.slice(messages.findLastIndex(m=>m.role==='user')),input=messages.filter(m=>m.role==='user').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).findLast(v=>v?.task_ref);
   const ref=turn.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return {};}}).find(r=>r.result_ref)?.result_ref;
   const read=turn.some(m=>m.tool_calls?.some(c=>c.function.name==='read_task_record'));
   return send(!ref?call('delegate_role',{role:'dev',purpose:'Write the requested report',refs:[input.task_ref]},'delegate'):!read?call('read_task_record',{ref},'read-result'):call('nominate_delivery',{result_ref:ref},'nominate'));
  }
  executionCalls++;
  // dev works from the Manager's delegation, the latest one when its session continues: the task contract and the
  // previous acceptance (#1256).
  const context=messages.filter(m=>m.role==='user').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).findLast(v=>v?.contract),contract=context.contract,multi=contract.goal.includes('multiple');
  if(multi&&!names.includes('search_project_memory'))return send(call('search_project_memory',{query:'memory'},'memory-search'));
  if(multi&&!names.includes('read_project_memory'))return send(call('read_project_memory',{id:memorySeed.id,revision:memorySeed.revision},'memory-read'));
  if(contract.source?.parent_task&&!names.includes('read_file'))return send(call('read_file',{path:'report.md'},'inherited-read'));
  if(contract.source?.parent_task&&!calls.some(c=>c.function.name==='read_file'&&JSON.parse(c.function.arguments).path==='../context/parent-proof.txt'))return send(call('read_file',{path:'../context/parent-proof.txt'},'parent-context-read'));
  if(contract.source?.parent_task)inheritedContextRead||=messages.some(m=>m.role==='tool'&&m.content.includes('PARENT_AUTHORIZED_CONTEXT'));
  if(contract.source?.parent_task)inheritedRead||=messages.some(m=>m.role==='tool'&&m.content.includes('Observed repository fact'));
  if(contract.source?.residual==='follow-report-2'){
   const relatedCalls=calls.filter(c=>c.function.name==='read_related_artifact');
   if(!relatedCalls.length)return send(call('read_related_artifact',{},'related-discover'));
   const offered=messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(v=>v?.deliveries);
   const sibling=offered.deliveries.find(d=>d.relationship==='accepted_sibling');assert.ok(sibling);
   if(relatedCalls.length===1)return send(call('read_related_artifact',{task_id:'not-in-family',path:'report.md'},'foreign-reject'));
   if(relatedCalls.length===2){assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('related_delivery_not_available')));return send(call('read_related_artifact',{task_id:sibling.task_id,path:'../report.md'},'path-reject'));}
   if(relatedCalls.length===3){assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('invalid_artifact_path')));return send(call('read_related_artifact',{task_id:sibling.task_id,path:'report.md'},'sibling-read'));}
   siblingRead||=messages.some(m=>m.role==='tool'&&m.content.includes('SIBLING_ACCEPTED_EXTENSION'));
  }
  if(contract.goal.includes('write-outage')&&writeOutage===6&&!names.includes('read_file'))return send(call('read_file',{path:'report.md'},'read-restored-late-write'));
  if(contract.goal.includes('write-outage')&&writeOutage===6)restoredLateWrite||=messages.some(m=>m.role==='tool'&&m.content.includes('Observed repository fact'));
  assert.ok(!body.tools.some(t=>['read_playbook','select_playbooks'].includes(t.function.name)));
  assert.ok(!/playbook_catalog|playbook_request|select_playbooks/.test(JSON.stringify(messages.slice(0,2))));
  const writes=calls.filter(c=>c.function.name==='write_file');
  if(!writes.length)return send(call('write_file',{path:'/etc/forbidden-report.md',content:'bad target'},'invalid-path'));
  // A continuing dev session already holds its first report: a returned delivery adds the recovered observation.
  const recovering=context.previous_acceptance?.gaps?.length&&!writes.some(c=>c.function.arguments.includes('Recovered observation'));
  if(writes.length===1||recovering){invalidPathObserved||=messages.some(m=>m.role==='tool'&&m.content.includes('invalid_artifact_path'));return send(call('write_file',{path:'report.md',content:'Observed repository fact: calc.mjs contains the arithmetic implementation.'+(contract.source?.residual==='follow-report'?' SIBLING_ACCEPTED_EXTENSION':'')+(context.previous_acceptance?.gaps?.length?' Recovered observation with source calc.mjs.':'')},'write-report'));}
  if(contract.goal.includes('write-outage')&&writeOutage<6){writeOutage++;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Outage after saving artifact, before progress'}}));return;}
  if(!names.includes('record_progress'))return send(call('record_progress',{completed:['Wrote observed report'],next_action:'Submit for independent acceptance'},'checkpoint'));
  return send(call('submit_delivery',{summary:'Reported observed code',artifacts:[{path:'report.md',description:'Observed repository fact'}],evidence:[],unknowns:[]},'submit-delivery'));
 });
 model.listen(0,'127.0.0.1');await once(model,'listening');t.after(()=>new Promise(r=>{model.close(r);model.closeAllConnections();}));
 store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)','a','fixture','bot_account',null,store.secrets.seal({token:'fixture-github-token'},'account:a'),'now');
 store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  // These historical tasks and the follow-ups they create run in process, as they did before #1068.
  scriptedRoles(store,'101');
 store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','101','http://127.0.0.1:'+model.address().port+'/v1','fixture',store.secrets.seal({value:'fixture-model-token'},'model:m'),'now');
 store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
 const memorySeed=await manager.call('POST','/v1/projects/101/file-tree',{path:'memory/reuse.md',content:'Inspect calc.mjs and actual observations before reporting. fixture-model-token',actor:'user:owner',create_parents:true});
 const engine=new TaskEngine(store,manager,gh+'/github');
 const runLegacy = (id, token) => { pinLegacyTaskConfiguration(store, id); return engine.run(id, token); };
 for(const mode of ['single','multiple','return','insufficient_evidence','write-outage']){
  const id=randomBytes(24).toString('hex'),contract={goal:'Write an observed report '+mode,scope:['report'],criteria:['Report a concrete repository observation'],endpoint:'report',source:'request'};
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,claim_token) VALUES(?,'101','task.request','running',?,?,'claim')",id,mode,JSON.stringify({request:mode+' guide report',contract,...(mode==='multiple'?{context_files:{'parent-proof.txt':'PARENT_AUTHORIZED_CONTEXT'}}:{})}));
  authorizeKnowledgeTask(store,id);store.run("INSERT INTO task_claims VALUES(?,'101','claim','now')",id);
  records.history(id,'execution_evidence',{execution:'old-execution',name:'run_command',version:'old-tree',result:{exit_code:0,output:'STALE_EVIDENCE_SENTINEL'}});
  await runLegacy(id,'claim');
  if(mode==='single'){
   let row=store.get('SELECT * FROM tasks WHERE id=?',id);assert.equal(row.status,'retry_wait',JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=?',id)));assert.equal(row.phase,'acceptance');
   const callsBefore=executionCalls;await runLegacy(id,'claim');assert.equal(executionCalls,callsBefore,'restart must not repeat successful execution');
  }
  if(mode==='write-outage'){
   const row=store.get('SELECT * FROM tasks WHERE id=?',id);assert.equal(row.status,'retry_wait');assert.equal(row.phase,'model');assert.ok(JSON.parse(row.input).recovery);
   store.run("UPDATE tasks SET status='running',workspace_id=NULL,generation=NULL,attempt=attempt+1 WHERE id=?",id);await runLegacy(id,'claim');
   assert.ok(restoredLateWrite);assert.ok(store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='checkpoint_restored'",id));
  }
  if(store.get('SELECT status FROM tasks WHERE id=?',id).status==='queued')await runLegacy(id,'claim');
  const result=records.get(id);assert.equal(result.progress.status,'completed',JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=?',id)));
  assert.equal(result.selections.length,0);assert.equal(result.acceptance.outcome,mode==='multiple'?'pass_with_issues':'pass');
  if(['return','insufficient_evidence'].includes(mode)){
   assert.equal(remediations.get(mode),2);
   const decisions=store.all("SELECT data FROM task_history WHERE task_id=? AND type='acceptance' ORDER BY id",id).map(r=>JSON.parse(r.data).outcome);
   assert.deepEqual(decisions,[mode,'pass']);
  }
  if(mode==='multiple'){legacyParent=id;assert.equal(result.acceptance.followups.length,0,'lightweight QA does not auto-run assessFollowups');assert.equal(result.acceptance.residuals.length,2);assert.ok(!store.all("SELECT data FROM task_history WHERE task_id=? AND type='execution_evidence'",id).some(r=>r.data.includes('fixture-model-token')));const observed=store.get("SELECT id FROM task_history WHERE task_id=? AND type='execution_evidence' AND json_extract(data,'$.name')='read_project_memory'",id);assert.ok(observed);assert.ok(result.candidate.evidence.some(e=>e.source==='task_history:'+observed.id),'actual memory reads are offered to independent acceptance');
   for(const r of result.acceptance.residuals){const child=randomBytes(24).toString('hex'),now=new Date().toISOString(),input={request:r.goal,contract:{goal:r.goal,scope:result.contract.scope,criteria:r.criteria,endpoint:'artifact',completeness:'inherited',source:{parent_task:id,parent_revision:result.revision,candidate_id:result.candidate.id,residual:r.key}},parent_task:id,residual:r,authorization:'inherited; no additional publication or merge rights'};store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,source_task_id,created_at,updated_at,priority) VALUES(?,'101','task.request','queued',?,?,?,?,?,?,'P3')",child,r.goal,`residual:${id}:${result.candidate.id}:${r.key}`,JSON.stringify(input),id,now,now);store.run('UPDATE task_records SET contract=? WHERE task_id=?',JSON.stringify(input.contract),child);store.run('INSERT INTO task_followups VALUES(?,?,?,?)',id,result.candidate.id,r.key,child);}}
  assert.ok(!JSON.stringify(result.candidate.evidence).includes('STALE_EVIDENCE_SENTINEL'));
  assert.equal(new Set(result.candidate.evidence.map(e=>e.result.execution)).size,1);
  assert.ok(store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='artifact_checkpoint'",id));
  // #1256: a task frozen with the Manager switch off runs under the Manager team, which delegates to dev; no execution
  // runs outside a role.
  assert.deepEqual(store.all('SELECT DISTINCT role FROM task_runs WHERE task_id=? AND role IS NOT NULL ORDER BY role',id).map(r=>r.role),['dev','manager','qa']);
  assert.equal(store.get("SELECT count(*) n FROM task_runs WHERE task_id=? AND kind='execution' AND role IS NULL",id).n,0);
 }
 assert.equal(store.get('SELECT count(*) n FROM task_followups').n,2);
 // The explicit post-QA Manager plan, not QA alone, creates these children.
 const children=store.all("SELECT t.* FROM tasks t JOIN task_followups f ON f.task_id=t.id WHERE t.source_task_id IS NOT NULL AND t.kind='task.request' ORDER BY f.issue_key");assert.equal(children.length,2);
 for(const child of children){
 store.run("UPDATE tasks SET status='running',claim_token='child-claim' WHERE id=?",child.id);authorizeKnowledgeTask(store,child.id);store.run("INSERT INTO task_claims VALUES(?,'101','child-claim','now')",child.id);
 await runLegacy(child.id,'child-claim');assert.equal(records.get(child.id).progress.status,'completed',JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=?',child.id)));
 assert.ok(inheritedRead);assert.ok(store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='inherited_artifact'",child.id));
 if(JSON.parse(child.input).contract.source.residual==='follow-report')writeFileSync(join(root,'tasks',store.get('SELECT workspace_id FROM tasks WHERE id=?',child.id).workspace_id,'repo','report.md'),'MUTATED_AFTER_ACCEPTANCE');
 }
 assert.ok(siblingRead);assert.ok(inheritedContextRead);
 assert.equal(store.get('SELECT count(*) n FROM task_followups').n,2,'legacy related work must not grow a new chain');
 assert.ok(invalidPathObserved);assert.ok(acceptanceCalls>=5);
 assert.equal(firstOutage,0);assert.equal(writeOutage,6,'all six requests fail before the saved work is restored');
});

test('default and saved-disabled projects execute an ordinary request with Manager, Dev and fresh QA',async t=>{
 // Without a configuration the roles run the recommended Pi backend (#1068); its sessions reach this fixture model
 // through the control plane's unified passthrough model gateway.
 for(const saved of [false,true])await t.test(saved?'saved disabled coordination':'no role configuration',async t=>{
  const root=mkdtempSync(join(tmpdir(),'manager-default-')),store=new Store(':memory:',randomBytes(32)),manager=new LocalManager('101',root);
  github.listen(0,'127.0.0.1');await once(github,'listening');
  const gh='http://127.0.0.1:'+github.address().port;
  await fetch(gh+'/fixture/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({github_token:'manager-fixture-token'})});
  const model=createServer(async(req,res)=>{
   let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw),messages=body.messages;
   const toolResults=messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return {};}});
   const names=messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls||[]).map(c=>c.function.name);
   let message;
   // The scripted driver sends text content; a Pi session sends content parts (the default backend since #1068).
   const text=content=>typeof content==='string'?content:Array.isArray(content)?content.map(part=>part?.text??'').join(''):'';
   if(body.tools?.some(tool=>tool.function.name==='delegate_role')){
    const ref=toolResults.find(result=>result.result_ref)?.result_ref,input=messages.filter(m=>m.role==='user').map(m=>{try{return JSON.parse(text(m.content));}catch{return null;}}).find(value=>value?.task_ref);
    message=!ref?call('delegate_role',{role:'dev',purpose:'Write the requested report',refs:[input.task_ref]},'delegate')
     :!names.includes('read_task_record')?call('read_task_record',{ref},'read-result'):call('nominate_delivery',{result_ref:ref},'nominate');
   }else if(text(messages[0].content).includes('independent delivery acceptance evaluator')){
    // A Pi session submits through the offered tool; the scripted driver also takes the verdict as text.
    const tools=(body.tools??[]).map(tool=>tool.function.name);
    message=!names.includes('read_file')?call('read_file',{path:'report.md'},'qa-read'):tools.includes('submit_acceptance')?call('submit_acceptance',pass,'qa-verdict'):{role:'assistant',content:JSON.stringify(pass)};
   }else{
    // Pi writes with its own file tool, the scripted driver with write_file.
    const write=(body.tools??[]).some(tool=>tool.function.name==='write_file')?'write_file':'write';
    message=!names.includes(write)?call(write,{path:'report.md',content:'Observed repository fact: calc.mjs contains arithmetic.'},'write')
     :call('submit_delivery',{summary:'Observed report',artifacts:[{path:'report.md',description:'Observed report'}],evidence:[],unknowns:[]},'submit');
   }
   replyChatCompletion(res,message,{stream:Boolean(body.stream)});
  });
  model.listen(0,'127.0.0.1');await once(model,'listening');
  const engine=new TaskEngine(store,manager,gh+'/github');
  t.after(async()=>{await engine.close();await manager.recover();await new Promise(resolve=>{model.close(resolve);model.closeAllConnections();});await new Promise(resolve=>{github.close(resolve);github.closeAllConnections();});store.close();rmSync(root,{recursive:true,force:true});});
  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)','a','fixture','bot_account',null,store.secrets.seal({token:'manager-fixture-token'},'account:a'),'now');
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','101','http://127.0.0.1:'+model.address().port+'/v1','fixture',store.secrets.seal({value:'manager-model-token'},'model:m'),'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('101','m',1)");
  if(saved)scriptedRoles(store,'101');
  const contract={goal:'Write an observed report',scope:['report'],criteria:['Report an observed repository fact'],endpoint:'report'};
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,claim_token) VALUES('request','101','task.request','running','report',?,'claim')",JSON.stringify({request:'Write an observed report',contract}));
  authorizeKnowledgeTask(store,'request');store.run("INSERT INTO task_claims VALUES('request','101','claim','now')");
  await engine.run('request','claim');
  assert.equal(new TaskRecords(store).get('request').progress.status,'completed',JSON.stringify(store.all("SELECT content FROM task_logs WHERE task_id='request'")));
  assert.deepEqual(store.all("SELECT DISTINCT role FROM task_runs WHERE task_id='request' AND role IS NOT NULL ORDER BY role").map(row=>row.role),['dev','manager','qa']);
  // The defaults run every role on the recommended backend; the saved legacy configuration names the scripted driver.
  assert.deepEqual(store.all("SELECT DISTINCT role,harness FROM task_runs WHERE task_id='request' AND role IS NOT NULL ORDER BY role").map(row=>row.role+':'+row.harness),['dev','manager','qa'].map(role=>role+':'+(saved?'scripted':'pi')));
  assert.equal(new TaskRecords(store).get('request').acceptance.outcome,'pass');
  assert.equal(store.get("SELECT actions_failures_enabled FROM policies WHERE repository_id='101'").actions_failures_enabled,0);
 });
});
