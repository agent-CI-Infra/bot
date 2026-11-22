import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../../../dist/storage/database.js';
import {TaskRecords} from '../../../../dist/tasks/service.js';
import {waitForCoordinatedTasks,coordinationContext,resumeCoordinatedTasks,coordinationApi,readProjectTask,readCoordinationEvidence} from '../../../../dist/tasks/coordination.js';
import {runTeam} from '../../../../dist/roles/team.js';
import {TaskEngine} from '../../../../dist/agent/engine.js';
import {Redactor} from '../../../../dist/agent/common.js';

const call=(name,a,id='c')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(a)}}]});
const verdict={outcome:'pass',reason:'Fixed candidate independently verified',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};

async function setup(t,handler){
 const dir=mkdtempSync(join(tmpdir(),'coordination-')),key=randomBytes(32),path=join(dir,'db');let s=new Store(path,key);
 s.run("INSERT INTO accounts VALUES('acc','acc','github_app','1','{}','now')");for(const repo of ['r','other'])s.run('INSERT INTO repositories VALUES(?,?,?,?)',repo,'fixture/'+repo,'o','acc');
 for(const [id,repo] of [['a','r'],['b','r'],['independent','r'],['foreign','other']]){s.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input) VALUES(?,?,'task.request','running','model',?,'{}')",id,repo,id);new TaskRecords(s).contract(id,{goal:'Preserve '+id,scope:['planned.ts'],criteria:['No data loss'],endpoint:'artifact'});}
 s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify({enabled:true,harnesses:{manager:'native'}}));
 const server=createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const message=await handler(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));}catch(e){console.error(e.stack);res.writeHead(500);res.end(JSON.stringify({error:String(e)}));}});server.listen(0,'127.0.0.1');await once(server,'listening');
 s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','r','http://127.0.0.1:'+server.address().port+'/v1','fixture',s.secrets.seal({value:'test'},'model:m'),'now');s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
 t.after(()=>{s.close();server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});});
 return {path,key,get s(){return s;},records:()=>new TaskRecords(s),reopen(){s.close();s=new Store(path,key);return s;}};
}

test('Manager exposes list_project_tasks, read_project_task, and wait_for_tasks without retired advisory coordination tools',async t=>{
 let turn=0;
 const f=await setup(t,body=>{
  const names=body.tools.map(x=>x.function.name);
  assert.ok(names.includes('list_project_tasks'));
  assert.ok(names.includes('read_project_task'));
  assert.ok(names.includes('wait_for_tasks'));
  for(const retired of ['request_task_coordination','submit_coordination','read_coordination','acknowledge_coordination','decide_coordination']){
   assert.ok(!names.includes(retired),`retired tool ${retired} must not be offered`);
  }
  assert.ok(!names.includes('run_command'));
  turn++;
  if(turn===1)return call('list_project_tasks',{});
  if(turn===2)return call('read_project_task',{task_id:'b'});
  if(turn===3)return call('read_project_task',{task_id:'foreign'});
  const observations=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
  assert.equal(observations[1].task.id,'b');
  assert.equal(observations[2].error,'coordination_task_out_of_scope');
  return call('wait_for_tasks',{task_ids:['b'],condition:'delivered',reason:'Wait for b to deliver before continuing'});
 });
 const task=f.s.get("SELECT * FROM tasks WHERE id='a'");
 await assert.rejects(runTeam({store:f.s,task,redactor:new Redactor(),guard:async()=>{},system:'fixture',prompt:'{}',tools:[],validate:x=>x},{prepare:async()=>{}}),e=>e.code==='task_coordination_requested'&&e.state==='waiting_coordination');
 assert.equal(turn,4);
 assert.equal(coordinationContext(f.s,'a').waiting_dependencies.length,1);
 assert.equal(coordinationContext(f.s,'a').waiting_dependencies[0].task_id,'b');
});

test('declared dependency waits release the source, reject cycles and resume on delivery, merge, or an actionable blocker',async t=>{
 const f=await setup(t,()=>call('finish_coordination',{action:'continue',reason:'unused'}));const source=f.s.get("SELECT * FROM tasks WHERE id='a'");
 assert.deepEqual(waitForCoordinatedTasks(f.s,source,{task_ids:['b'],condition:'delivered',reason:'Export reader must be delivered before roundtrip'}),{waiting:true});
 assert.equal(waitForCoordinatedTasks(f.s,source,{task_ids:['foreign'],condition:'delivered',reason:'cross-project forbidden'}).error,'coordination_task_out_of_scope');
 f.s.run("UPDATE tasks SET status='waiting_coordination' WHERE id='a'");
 resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'waiting_coordination');
 assert.equal(waitForCoordinatedTasks(f.s,f.s.get("SELECT * FROM tasks WHERE id='b'"),{task_ids:['a'],condition:'delivered',reason:'would form a cycle'}).error,'coordination_dependency_cycle');
 const c=f.records().submit('b',[{kind:'report',reference:'reader',version:'tree'}],[],{});f.records().decide('b',c.id,c.revision,verdict);
 resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'queued');
 waitForCoordinatedTasks(f.s,source,{task_ids:['independent'],condition:'delivered',reason:'Check prerequisite'});f.s.run("UPDATE tasks SET status='waiting_coordination' WHERE id='a'");f.s.run("UPDATE tasks SET status='failed' WHERE id='independent'");
 resumeCoordinatedTasks(f.s,()=>false);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'queued');
 assert.ok(JSON.parse(f.s.get("SELECT input FROM tasks WHERE id='a'").input).coordination_dependency_result[0].blocked);
});

test('read_project_task discovers same-project tasks and exposes bounded paged evidence with project isolation',async t=>{
 const f=await setup(t,()=>call('finish_coordination',{action:'continue',reason:'unused'}));
 f.records().history('b','large_observation',{text:'x'.repeat(60000)});
 const evidence=f.s.get("SELECT id FROM task_history WHERE task_id='b' AND type='large_observation'");
 const index=readProjectTask(f.s,'r',{});
 assert.ok(index.tasks.some(task=>task.id==='independent'));
 assert.ok(!index.tasks.some(task=>task.id==='foreign'));
 const page=readProjectTask(f.s,'r',{task_id:'b',ref:'task_history:'+evidence.id});
 assert.equal(page.content.length,8000);assert.equal(page.next_offset,8000);
 assert.equal(readProjectTask(f.s,'r',{task_id:'foreign',ref:'task_history:'+evidence.id}).error,'coordination_task_out_of_scope');
 assert.equal(readCoordinationEvidence(f.s,['a'],{task_id:'b',ref:'task_history:'+evidence.id}).error,'coordination_task_out_of_scope');
});

test('historical coordination tables remain read-only compatible; retry API returns 410 and legacy parked tasks resume cleanly',async t=>{
 const f=await setup(t,()=>call('finish_coordination',{action:'continue',reason:'unused'}));
 const now=new Date().toISOString();
 f.s.run("INSERT INTO task_coordinations(id,repository_id,source_task_id,request_key,request,state,created_at,updated_at) VALUES('c1','r','a','k1',?,'awaiting_feedback',?,?)",JSON.stringify({key:'k1',problem:'old',proposal:'old',task_ids:['a','b'],refs:[]}),now,now);
 f.s.run("INSERT INTO coordination_notices(coordination_id,task_id,message,action,state,task_revision,candidate_id,updated_at) VALUES('c1','a','historical advice','review','pending',1,NULL,?)",now);
 const ctx=coordinationApi(f.s,{id:'admin',role:'project_admin',repositories:['r']},'GET',new URL('http://local/api/tasks/a/coordination'),{});
 assert.equal(ctx.requests.length,1);assert.equal(ctx.notices.length,1);
 assert.throws(()=>coordinationApi(f.s,{id:'other',role:'project_admin',repositories:['other']},'GET',new URL('http://local/api/tasks/a/coordination'),{}),e=>e.code==='task_not_found');
 assert.throws(()=>coordinationApi(f.s,{id:'admin',role:'project_admin',repositories:['r']},'POST',new URL('http://local/api/tasks/a/coordination/c1/retry'),{}),e=>e.status===410&&e.code==='coordination_retired');
 // A pre-#1218 task still parked in waiting_coordination without wait_for_tasks dependencies is woken under Manager.
 f.s.run("UPDATE tasks SET status='waiting_coordination',error_code='task_coordination_requested' WHERE id='a'");
 resumeCoordinatedTasks(f.s,()=>false);
 assert.equal(f.s.get("SELECT status FROM tasks WHERE id='a'").status,'queued');
 // TaskEngine no longer instantiates a background TaskCoordinator worker.
 const engine=new TaskEngine(f.s,{call:async()=>{return null;}});
 assert.equal('coordinator' in engine,false);
 await engine.close();
});
