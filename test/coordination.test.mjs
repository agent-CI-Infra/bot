import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {CoordinationWorker,waitForCoordinatedTasks,requestCoordination,coordinationContext,acknowledgeCoordination,assertCoordinationCurrent,resumeCoordinatedTasks,coordinationApi} from '../dist/tasks/coordination.js';
import {runTeam} from '../dist/roles/team.js';
import {TaskEngine} from '../dist/agent/engine.js';
import {Redactor} from '../dist/agent/common.js';
const call=(name,a,id='c')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(a)}}]});
const request={key:'storage-contract',problem:'Import needs a shared atomic store; export also reads it',proposal:'Adapt shared readers preserving current export semantics',task_ids:['a','b'],refs:['task:a','task:b']};
const verdict={outcome:'pass',reason:'Fixed candidate independently verified',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
async function setup(t,handler){
 const dir=mkdtempSync(join(tmpdir(),'coordinator-')),key=randomBytes(32),path=join(dir,'db');let s=new Store(path,key);
 s.run("INSERT INTO accounts VALUES('acc','acc','github_app','1','{}','now')");for(const repo of ['r','other'])s.run('INSERT INTO repositories VALUES(?,?,?,?)',repo,'fixture/'+repo,'o','acc');
 for(const [id,repo] of [['a','r'],['b','r'],['independent','r'],['foreign','other']]){s.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input) VALUES(?,?,'task.request','running','model',?,'{}')",id,repo,id);new TaskRecords(s).contract(id,{goal:'Preserve '+id,scope:['planned.ts'],criteria:['No data loss'],endpoint:'artifact'});}
 s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify({enabled:true,harnesses:{manager:'native',coordinator:'native'}}));
 const server=createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const message=await handler(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));}catch(e){console.error(e.stack);res.writeHead(500);res.end(JSON.stringify({error:String(e)}));}});server.listen(0,'127.0.0.1');await once(server,'listening');
 s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','r','http://127.0.0.1:'+server.address().port+'/v1','fixture',s.secrets.seal({value:'test'},'model:m'),'now');s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
 t.after(()=>{s.close();server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});});
 return {path,key,get s(){return s;},records:()=>new TaskRecords(s),reopen(){s.close();s=new Store(path,key);return s;}};
}
const notices=()=>({summary:'Preserve goal; migrate shared store with compatibility checks',outcome:'notices',notices:[{task_id:'a',message:'Implement atomic store; explain affected readers and verify migration',action:'rework'},{task_id:'b',message:'Check export against the shared authority; preserve snapshot schema',action:'review'}]});
async function drain(worker){worker.tick();await Promise.all([...worker.active.values()]);}
test('Task Manager requests concrete coordination through offered tool and yields without product or merge authority',async t=>{
 const f=await setup(t,body=>{const names=body.tools.map(x=>x.function.name);assert.ok(names.includes('request_task_coordination'));assert.ok(!names.includes('run_command'));return call('request_task_coordination',request);});
 const task=f.s.get("SELECT * FROM tasks WHERE id='a'");await assert.rejects(runTeam({store:f.s,task,redactor:new Redactor(),guard:async()=>{},system:'fixture',prompt:'{}',tools:[],validate:x=>x},{prepare:async()=>{}}),e=>e.code==='task_coordination_requested'&&e.state==='waiting_coordination');
 assert.equal(f.s.get('SELECT count(*) n FROM task_coordinations').n,1);assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='coordination_requested'").n,1);
});
test('queued and interrupted coordination survive SQLite reopen; notices preserve running/QA candidates and old QA cannot certify new context',async t=>{
 let calls=0;const f=await setup(t,body=>{calls++;assert.deepEqual(body.tools.map(x=>x.function.name).sort(),['read_project_task','submit_coordination']);return call('submit_coordination',notices());});
 const r=f.records(),old=r.submit('b',[{kind:'report',reference:'fixed',version:'tree'}],[],{});r.stage('b',old.id,old.revision,verdict);
 const req=requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request);assert.equal(requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request).coordination_id,req.coordination_id);
 f.s.run("UPDATE tasks SET status='waiting_coordination' WHERE id='a'");f.s.run("UPDATE task_coordinations SET state='running',claim_token='lost-process' WHERE id=?",req.coordination_id);
 f.reopen();const worker=new CoordinationWorker(f.s);worker.recover();await drain(worker);assert.equal(calls,1);
 assert.equal(f.s.get("SELECT status FROM tasks WHERE id='b'").status,'running');assert.equal(f.records().get('b').candidate.id,old.id);assert.equal(f.records().get('b').pending.candidate_id,old.id);
 assert.throws(()=>f.records().decide('b',old.id,old.revision,verdict),e=>e.code==='task_coordination_pending');
 assert.equal(coordinationContext(f.s,'independent').notices.length,0);resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'queued');
 for(const id of ['a','b']){const n=coordinationContext(f.s,id).notices[0];const ack={notice_id:n.id,disposition:'adopted',reason:'Will verify shared storage and preserve original criteria'};assert.deepEqual(acknowledgeCoordination(f.s,id,ack),{ok:true});assert.deepEqual(acknowledgeCoordination(f.s,id,ack),{ok:true});}
 assert.throws(()=>assertCoordinationCurrent(f.s,'b',old),e=>e.code==='task_coordination_pending');
 const next=f.records().submit('b',old.artifacts,[],{});assert.notEqual(next.id,old.id);assert.equal(f.records().get('b').acceptance,null);f.records().decide('b',next.id,next.revision,verdict);assert.equal(f.records().get('b').acceptance.outcome,'pass');
 assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?',req.coordination_id).state,'resolved');assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='coordination_notice'").n,2);await worker.close();
});
test('QA retains needs_human verdict but explicit cross-task request is coordinated before human wait; genuine decisions remain human',async t=>{
 const f=await setup(t,()=>call('submit_coordination',{summary:'User must decide conflicting explicit retention requirements',outcome:'needs_human',notices:[]}));
 const r=f.records(),c=r.submit('a',[{kind:'report',reference:'fixture',version:'v'}],[],{}),human={...verdict,outcome:'needs_human',core_complete:false,gaps:['Cross-task storage contract conflict'],coordination:request};
 const result=r.decide('a',c.id,c.revision,human);assert.ok(result.coordination_requested);assert.equal(r.get('a').acceptance.outcome,'needs_human');assert.equal(r.get('a').progress.status,'waiting_coordination');
 const worker=new CoordinationWorker(f.s);await drain(worker);resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT error_code FROM tasks WHERE id='a'").error_code,'coordination_needs_human');
 const b=r.submit('b',[{kind:'report',reference:'fixture',version:'v'}],[],{});r.decide('b',b.id,b.revision,{...human,coordination:undefined});assert.equal(r.get('b').progress.status,'needs_replan');assert.equal(f.s.get('SELECT count(*) n FROM task_coordinations').n,1);await worker.close();
});
test('project isolation, conflicting idempotency keys, objections and bounded failures are explicit',async t=>{
 const f=await setup(t,()=>call('submit_coordination',{...notices(),notices:[{task_id:'foreign',message:'not allowed',action:'rework'}]}));
 const source=f.s.get("SELECT * FROM tasks WHERE id='a'");assert.throws(()=>requestCoordination(f.s,source,{...request,task_ids:['foreign']}),/out_of_scope/);assert.equal(f.s.get('SELECT count(*) n FROM task_coordinations').n,0);
 const req=requestCoordination(f.s,source,request);assert.throws(()=>requestCoordination(f.s,source,{...request,problem:'different'}),/key_conflict/);
 assert.throws(()=>coordinationApi(f.s,{id:'other',role:'project_admin',repositories:['other']},'GET',new URL('http://local/api/tasks/a/coordination'),{}),e=>e.code==='task_not_found');
 const worker=new CoordinationWorker(f.s);for(let i=0;i<3;i++){f.s.run('UPDATE task_coordinations SET next_run_at=0');await drain(worker);}
 assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?',req.coordination_id).state,'failed');assert.equal(coordinationContext(f.s,'foreign').notices.length,0);assert.equal(f.s.get("SELECT count(*) n FROM github_effects").n,0);await worker.close();
});
test('coordinator uses a separate execution slot while ordinary independent tasks can dispatch',async t=>{
 let release;const gate=new Promise(r=>{release=r;});const f=await setup(t,async()=>{await gate;return call('submit_coordination',notices());});
 requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request);f.s.run("UPDATE tasks SET status='waiting_coordination' WHERE id='a'");f.s.run("UPDATE tasks SET status='queued' WHERE id='independent'");
 const engine=new TaskEngine(f.s,{call:async()=>{throw Error('Coordinator must not ask for a project computer');}});const started=[];engine.run=async id=>{started.push(id);};engine.tick();await new Promise(r=>setTimeout(r,30));assert.ok(started.includes('independent'));assert.equal(engine.coordinator.active.size,1);release();await engine.close();
});

test('real coordinator process is killed during a model request and resumes once from persisted state', {timeout:20000},async t=>{
 let entered,release;const began=new Promise(r=>{entered=r;});let first=true;
 const f=await setup(t,async()=>{if(first){first=false;entered();await new Promise(r=>{release=r;});}return call('submit_coordination',notices());});
 const req=requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request);
 const script=`import {Store} from './dist/storage/database.js';import {CoordinationWorker} from './dist/tasks/coordination.js';const s=new Store(process.argv[1],Buffer.from(process.argv[2],'hex'));const w=new CoordinationWorker(s);w.tick();setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,f.path,f.key.toString('hex')],{cwd:new URL('..',import.meta.url),stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',b=>{errors+=b;});t.after(()=>{child.kill('SIGKILL');release?.();});
 await Promise.race([began,once(child,'exit').then(()=>{throw Error(errors||'child exited before request');})]);const exited=once(child,'exit');child.kill('SIGKILL');await exited;release();
 assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?',req.coordination_id).state,'running');
 f.reopen();const worker=new CoordinationWorker(f.s);worker.recover();await drain(worker);
 assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?',req.coordination_id).state,'awaiting_feedback');assert.equal(f.s.get("SELECT count(*) n FROM coordination_notices").n,2);
 assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='coordinator' AND stop_reason='coordination_process_restart'").n,1);assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='coordinator' AND status='running'").n,0);await worker.close();
});

test('objections are retained and re-evaluated, advice updates cannot reuse prior candidate context',async t=>{
 const f=await setup(t,()=>call('submit_coordination',notices()));const req=requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request);const worker=new CoordinationWorker(f.s);await drain(worker);
 let n=coordinationContext(f.s,'a').notices[0];assert.deepEqual(acknowledgeCoordination(f.s,'a',{notice_id:n.id,disposition:'disputed',reason:'Advice needs to preserve legacy export readers too'}),{ok:true});await drain(worker);
 n=coordinationContext(f.s,'a').notices[0];assert.equal(n.state,'pending');assert.equal(f.s.get('SELECT attempts FROM task_coordinations WHERE id=?',req.coordination_id).attempts,2);
 assert.ok(f.s.get("SELECT count(*) n FROM task_history WHERE type='coordination_acknowledged'").n>0);await worker.close();
});

test('declared dependency waits release the source, reject cycles and resume on delivery or an actionable blocker',async t=>{
 const f=await setup(t,()=>call('submit_coordination',notices()));const source=f.s.get("SELECT * FROM tasks WHERE id='a'");
 assert.deepEqual(waitForCoordinatedTasks(f.s,source,{task_ids:['b'],condition:'delivered',reason:'Export reader must be delivered before roundtrip'}),{waiting:true});f.s.run("UPDATE tasks SET status='waiting_coordination' WHERE id='a'");
 resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'waiting_coordination');
 assert.equal(waitForCoordinatedTasks(f.s,f.s.get("SELECT * FROM tasks WHERE id='b'"),{task_ids:['a'],condition:'delivered',reason:'would form a cycle'}).error,'coordination_dependency_cycle');
 const c=f.records().submit('b',[{kind:'report',reference:'reader',version:'tree'}],[],{});f.records().decide('b',c.id,c.revision,verdict);resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'queued');
 waitForCoordinatedTasks(f.s,source,{task_ids:['independent'],condition:'delivered',reason:'Check prerequisite'});f.s.run("UPDATE tasks SET status='waiting_coordination' WHERE id='a'");f.s.run("UPDATE tasks SET status='failed' WHERE id='independent'");resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'queued');
 assert.ok(JSON.parse(f.s.get("SELECT input FROM tasks WHERE id='a'").input).coordination_dependency_result[0].blocked);
});

test('coordination rebuilds bounded context on retry and exposes scoped evidence pages',async t=>{
 const {readCoordinationEvidence}=await import('../dist/tasks/coordination.js');let bodies=[];
 const f=await setup(t,body=>{bodies.push(body);return call('submit_coordination',notices());});
 f.records().history('b','large_observation',{text:'x'.repeat(60000)});
 const evidence=f.s.get("SELECT id FROM task_history WHERE task_id='b' AND type='large_observation'");
 const page=readCoordinationEvidence(f.s,['a','b'],{task_id:'b',ref:'task_history:'+evidence.id});
 assert.equal(page.content.length,8000);assert.equal(page.next_offset,8000);
 assert.equal(readCoordinationEvidence(f.s,['a'],{task_id:'b',ref:'task_history:'+evidence.id}).error,'coordination_task_out_of_scope');
 const req=requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request);const worker=new CoordinationWorker(f.s);await drain(worker);
 const notice=coordinationContext(f.s,'a').notices[0];acknowledgeCoordination(f.s,'a',{notice_id:notice.id,disposition:'disputed',reason:'Need another bounded evaluation'});await drain(worker);
 assert.equal(bodies.length,2);for(const body of bodies){assert.ok(JSON.stringify(body.messages).length<20000);assert.ok(!JSON.stringify(body.messages).includes('x'.repeat(1000)));}
 assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?',req.coordination_id).state,'awaiting_feedback');await worker.close();
});


test('coordinator repairs an omitted source-task notice without repeating evidence collection',async t=>{
 let calls=0;const f=await setup(t,body=>{calls++;const result=notices();if(calls===1)result.notices=result.notices.filter(n=>n.task_id!=='a');else assert.ok(JSON.stringify(body.messages).includes('requesting task a'));return call('submit_coordination',result);});
 const req=requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request);const worker=new CoordinationWorker(f.s);await drain(worker);
 assert.equal(calls,2);assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?',req.coordination_id).state,'awaiting_feedback');await worker.close();
});

test('coordinator discovers omitted same-project owners without expanding cross-project access',async t=>{
 let turn=0;const f=await setup(t,body=>{
  turn++;if(turn===1)return call('read_project_task',{});
  const observations=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
  if(turn===2){const index=observations.at(-1);assert.ok(index.tasks.some(t=>t.id==='independent'));assert.ok(!index.tasks.some(t=>t.id==='foreign'));return call('read_project_task',{task_id:'independent'});}
  if(turn===3){assert.equal(observations.at(-1).task.id,'independent');return call('read_project_task',{task_id:'foreign'});}
  assert.equal(observations.at(-1).error,'coordination_task_out_of_scope');return call('submit_coordination',notices());
 });
 const req=requestCoordination(f.s,f.s.get("SELECT * FROM tasks WHERE id='a'"),request);const worker=new CoordinationWorker(f.s);await drain(worker);
 assert.equal(f.s.get('SELECT state FROM task_coordinations WHERE id=?',req.coordination_id).state,'awaiting_feedback');await worker.close();
});
