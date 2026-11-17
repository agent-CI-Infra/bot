// These legacy protocol fixtures exercise the explicitly enabled gateway transport.
process.env.BOT_HARNESS_MODEL_TRANSPORT='gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {roleApi} from '../dist/roles/api.js';
import {runTeam} from '../dist/roles/team.js';
import {controllerWorkspace} from '../dist/roles/workspace.js';
import {Workspace} from '../dist/agent/workspace.js';
import {Redactor} from '../dist/agent/common.js';
import {LocalManager} from '../dist/projects/local-manager.js';
import {managedSession} from '../dist/harness/session.js';
import {harnessAccess,checkHarnessAccess} from '../dist/harness/access.js';
import {defaultPermissions} from '../dist/roles/permissions.js';
const call=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:randomBytes(8).toString('hex'),type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('a session can accept a later turn and cancellation does not poison its next turn',async()=>{
 const events=[];const session=managedSession(async(signal,message)=>{if(message==='wait')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return message??'first';},e=>events.push(e));
 assert.equal(await session.run(),'first');assert.equal(await session.send('second'),'second');
 const pending=session.send('wait');await session.cancel();await assert.rejects(pending,{code:'harness_cancelled'});
 assert.equal(await session.send('third'),'third');await session.close();await assert.rejects(session.send('fourth'),/unavailable/);
 assert.deepEqual(events.map(e=>e.status),['completed','completed','cancelled','completed']);
});

test('every backend may be selected for the controller without changing its role',()=>{
 const s=new Store(':memory:',randomBytes(32));try{
 s.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('101','fixture/probe','o','a')");s.run("INSERT INTO policies(repository_id,enabled) VALUES('101',1)");
 for(const backend of ['pi','codex','claude_code']){
  const current=roleApi(s,{id:'admin',role:'project_admin',repositories:['101']},'GET',new URL('http://local/api/repositories/101/roles'),{});
  const saved=roleApi(s,{id:'admin',role:'project_admin',repositories:['101']},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:current.configuration.revision,enabled:true,roles:[{role_id:'manager',harness_ref:{id:backend}}]});
  assert.equal(saved.configuration.roles.find(r=>r.role_id==='manager').harness_ref.id,backend);
 }
 }finally{s.close();}
});

test('real Pi Manager uses native shell, repository instructions and project Skills without a dedicated investigation tool',{timeout:90000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'bot-native-pi-')),s=new Store(':memory:',randomBytes(32)),manager=new LocalManager('101',root),requests=[],logs=[];
 const model=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  const names=body.tools.map(t=>t.function.name);assert.ok(names.includes('bash'));assert.ok(names.includes('read'));assert.ok(names.includes('write'));assert.ok(!names.includes('read_ci_evidence'));
  assert.match(JSON.stringify(body.messages),/PROJECT_INSTRUCTION_834/);assert.match(JSON.stringify(body.messages),/triage834/);
  const message=requests.length===1?call('bash',{command:'cat evidence.txt; printf "native-result" > native-result.txt'}):call('finish_coordination',{action:'wait',reason:'Read actual evidence: fixture-ci-infrastructure-unavailable',resume_condition:'CI service is restored'});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:20,completion_tokens:20}}));
 });model.listen(0,'127.0.0.1');await once(model,'listening');
 t.after(async()=>{await manager.recover();model.closeAllConnections();await new Promise(r=>model.close(r));s.close();rmSync(root,{recursive:true,force:true});});
 s.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('101','fixture/probe','o','a')");
 s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101',?,'fixture',?,'now')",'http://127.0.0.1:'+model.address().port+'/v1',s.secrets.seal({value:'fixture'},'model:m'));
 s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('101','m',1)");
 const environment=await manager.call('PUT','/v1/projects/101');
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t','101','task.request','running','inspect evidence','{}',1,?,?)",environment.generation,randomBytes(24).toString('hex'));
 new TaskRecords(s).contract('t',{goal:'Inspect CI evidence',scope:['report'],criteria:['Use actual evidence'],endpoint:'report'});
 roleApi(s,{id:'admin',role:'project_admin',repositories:['101']},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:0,enabled:true,roles:[{role_id:'manager',harness_ref:{id:'pi'}}]});
 const task=s.get("SELECT * FROM tasks WHERE id='t'"),workspace=new Workspace(s,manager,task,new Redactor(),async()=>{},e=>logs.push(e));
 await workspace.call('init',{type:'workspace_init'});
 const repo=join(root,'tasks',task.workspace_id,'repo');mkdirSync(join(repo,'.pi/skills/triage834'),{recursive:true});
 writeFileSync(join(repo,'AGENTS.md'),'PROJECT_INSTRUCTION_834: inspect evidence before making claims.');
 writeFileSync(join(repo,'.pi/skills/triage834/SKILL.md'),'---\nname: triage834\ndescription: Inspect CI evidence without guessing.\n---\nRead evidence.txt.');
 writeFileSync(join(repo,'evidence.txt'),'fixture-ci-infrastructure-unavailable');
 await assert.rejects(runTeam({store:s,task,redactor:new Redactor(),guard:async()=>{},system:'Task',prompt:'{}',tools:[]},{prepare:async()=>{},controller:controllerWorkspace(workspace)}),{code:'manager_deferred',state:'retry_wait'});
 assert.equal(readFileSync(join(repo,'native-result.txt'),'utf8'),'native-result');
 assert.equal(requests.length,2);assert.match(JSON.stringify(requests[1].messages),/fixture-ci-infrastructure-unavailable/);
 const bound=logs.find(e=>e.type==='session_bound');assert.ok(bound.session_id);assert.ok(bound.transcript);assert.ok(bound.resources.skills.includes('triage834'));
});

test('effective access is prepared from one permission definition',()=>{
 const access=harnessAccess(defaultPermissions('manager','controller'),true,'owner/repo');assert.equal(access.commands,true);assert.equal(access.workspace,'write');assert.equal(access.github.repository,'owner/repo');
 const denied=harnessAccess({computer:'deny'},false,null);assert.equal(denied.commands,false);assert.equal(denied.workspace,'none');assert.deepEqual(denied.github.scopes,[]);
});

 test('unsupported read-only shell access is reported before Pi/Claude start, without claiming enforcement',()=>{
  const access={workspace:'read',commands:true,network:false,github:{repository:null,scopes:[]}};
  for(const backend of ['pi','claude_code'])assert.throws(()=>checkHarnessAccess(backend,access),{code:'harness_permission_mismatch',state:'waiting_configuration'});
  assert.doesNotThrow(()=>checkHarnessAccess('codex',access));
  assert.doesNotThrow(()=>checkHarnessAccess('pi',{...access,commands:false}));
 });

test('public driver sessions keep updated native bindings between sends and reject an already-cancelled run',async()=>{
 const {roleHarness,registerRoleHarness}=await import('../dist/roles/harness.js');
 registerRoleHarness({...roleHarness('native'),id:'binding_probe'},spec=>async()=>{await spec.guard();const turn=(spec.harnessState.value.turn??0)+1;spec.harnessState.save({turn});return turn;});
 const s=new Store(':memory:',randomBytes(32));try{
 s.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('101','fixture/probe','o','a')");s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','101','task.request','running','session probe','{}')");
 const spec={store:s,task:s.get("SELECT * FROM tasks WHERE id='t'"),redactor:new Redactor(),guard:async()=>{},system:'test',prompt:'test'};
 const services={guard:spec.guard};const session=roleHarness('binding_probe').createSession(spec,services);
 assert.equal(await session.run(),1);assert.equal(await session.send('next'),2);await session.close();
 const controller=new AbortController();controller.abort(new Error('already cancelled'));
 const stopped=roleHarness('binding_probe').createSession({...spec,cancelSignal:controller.signal},services);
 await assert.rejects(stopped.run(),/already cancelled/);await stopped.close();
 }finally{s.close();}
});
