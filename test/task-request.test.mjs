import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { server as github } from './fixtures/agent-server.mjs';

const pass={outcome:'pass',reason:'Read the actual submitted report from its pinned Git object',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
const call=(name,args,id)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('ordinary tasks run single/multiple guides, correct invalid paths, and resume only fresh acceptance after an outage',async t=>{
 const root=mkdtempSync(join(tmpdir(),'bot-request-flow-')),store=new Store(':memory:',randomBytes(32)),records=new TaskRecords(store),manager=new LocalManager('101',root);
 t.after(async()=>{await manager.recover();store.close();rmSync(root,{recursive:true,force:true});});
 github.listen(0,'127.0.0.1');await once(github,'listening');t.after(()=>new Promise(r=>{github.close(r);github.closeAllConnections();}));
 const gh='http://127.0.0.1:'+github.address().port;
 await fetch(gh+'/fixture/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({github_token:'fixture-github-token'})});
 let executionCalls=0,acceptanceCalls=0,firstOutage=true,invalidPathObserved=false,acceptedDeliveries=0,inheritedRead=false;
 const model=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw),messages=body.messages;
  const accepting=messages[0].content.includes('independent delivery acceptance evaluator');
  const send=message=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}]}));};
  const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls||[]),names=calls.map(c=>c.function.name);
  if(accepting){
   acceptanceCalls++;
   if(firstOutage){firstOutage=false;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'temporary outage'}}));return;}
   if(!names.includes('read_file'))return send(call('read_file',{path:'report.md'},'accept-read'));
   assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('Observed repository fact')));
   acceptedDeliveries++;
   const verdict=acceptedDeliveries===2?{...pass,outcome:'pass_with_issues',residuals:[{key:'follow-report',description:'Independent report extension',evidence:'The requested report is complete',impact:'Extra documentation',nonblocking_reason:'The extension is independent of the completed report',goal:'Write follow-up from the inherited report',criteria:['Read the original report and deliver the extension']}]}:pass;
   return send({role:'assistant',content:JSON.stringify(verdict)});
  }
  executionCalls++;
  const context=JSON.parse(messages[1].content),multi=context.request.includes('multiple'),wanted=multi?['research','persistence']:['research'];
  if(context.task.contract.source?.parent_task&&!names.includes('read_file'))return send(call('read_file',{path:'report.md'},'inherited-read'));
  if(context.task.contract.source?.parent_task)inheritedRead||=messages.some(m=>m.role==='tool'&&m.content.includes('Observed repository fact'));
  const read=calls.filter(c=>c.function.name==='read_playbook').map(c=>JSON.parse(c.function.arguments).id);
  const next=wanted.find(id=>!read.includes(id));if(next)return send(call('read_playbook',{id:next},'read-'+next));
  if(!names.includes('select_playbooks')){
   const guides=messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).filter(v=>v?.version&&v?.id);
   return send(call('select_playbooks',{selections:guides.map(g=>({id:g.id,version:g.version,purpose:'Relevant to this bounded report'}))},'select'));
  }
  const writes=calls.filter(c=>c.function.name==='write_file');
  if(!writes.length)return send(call('write_file',{path:'/tmp/forbidden-report.md',content:'bad target'},'invalid-path'));
  if(writes.length===1){invalidPathObserved||=messages.some(m=>m.role==='tool'&&m.content.includes('invalid_artifact_path'));return send(call('write_file',{path:'report.md',content:'Observed repository fact: calc.mjs contains the arithmetic implementation.'},'write-report'));}
  if(!names.includes('record_progress'))return send(call('record_progress',{completed:['Read guides and wrote observed report'],next_action:'Submit for independent acceptance'},'checkpoint'));
  return send({role:'assistant',content:JSON.stringify({summary:'Reported observed code',artifacts:[{path:'report.md',description:'Observed repository fact'}],evidence:[],unknowns:[]})});
 });
 model.listen(0,'127.0.0.1');await once(model,'listening');t.after(()=>new Promise(r=>{model.close(r);model.closeAllConnections();}));
 store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)','a','fixture','bot_account',null,store.secrets.seal({token:'fixture-github-token'},'account:a'),'now');
 store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
 store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','101','http://127.0.0.1:'+model.address().port+'/v1','fixture',store.secrets.seal({value:'fixture-model-token'},'model:m'),'now');
 store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
 const engine=new TaskEngine(store,manager,gh+'/github');
 for(const mode of ['single','multiple']){
  const id=randomBytes(24).toString('hex'),contract={goal:'Write an observed report',scope:['report'],criteria:['Report a concrete repository observation'],endpoint:'report',source:'request'};
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,claim_token) VALUES(?,'101','task.request','running',?,?,'claim')",id,mode,JSON.stringify({request:mode+' guide report',contract}));
  store.run("INSERT INTO task_claims VALUES(?,'101','claim','now')",id);
  records.history(id,'execution_evidence',{execution:'old-execution',name:'run_command',version:'old-tree',result:{exit_code:0,output:'STALE_EVIDENCE_SENTINEL'}});
  await engine.run(id,'claim');
  if(mode==='single'){
   let row=store.get('SELECT * FROM tasks WHERE id=?',id);assert.equal(row.status,'retry_wait',JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=?',id)));assert.equal(row.phase,'acceptance');
   const callsBefore=executionCalls;await engine.run(id,'claim');assert.equal(executionCalls,callsBefore,'restart must not repeat successful execution');
  }
  const result=records.get(id);assert.equal(result.progress.status,'completed',JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=?',id)));
  assert.equal(result.selections.length,mode==='single'?1:2);assert.equal(result.acceptance.outcome,mode==='multiple'?'pass_with_issues':'pass');
  assert.ok(!JSON.stringify(result.candidate.evidence).includes('STALE_EVIDENCE_SENTINEL'));
  assert.equal(new Set(result.candidate.evidence.map(e=>e.result.execution)).size,1);
  assert.ok(store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='artifact_checkpoint'",id));
 }
 const child=store.get("SELECT * FROM tasks WHERE source_task_id IS NOT NULL AND kind='task.request'");assert.ok(child);
 store.run("UPDATE tasks SET status='running',claim_token='child-claim' WHERE id=?",child.id);store.run("INSERT INTO task_claims VALUES(?,'101','child-claim','now')",child.id);
 await engine.run(child.id,'child-claim');assert.equal(records.get(child.id).progress.status,'completed',JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=?',child.id)));
 assert.ok(inheritedRead);assert.ok(store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='inherited_artifact'",child.id));
 assert.ok(invalidPathObserved);assert.ok(acceptanceCalls>=5);
});
