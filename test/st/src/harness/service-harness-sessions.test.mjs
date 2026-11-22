// Legacy conversation fixtures verify gateway accounting and use a synthetic non-streaming provider.
process.env.BOT_HARNESS_MODEL_TRANSPORT='gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../../../../dist/storage/database.js';
import {Workspace} from '../../../../dist/agent/workspace.js';
import {LocalManager} from '../../../../dist/projects/local-manager.js';
import {Redactor} from '../../../../dist/agent/common.js';
import {runAgent} from '../../../../dist/agent/runtime.js';
import {serviceHarnessTurn} from '../../../../dist/harness/service-session.js';
import {serviceRolesApi} from '../../../../dist/service-roles/api.js';
import {serviceRole,serviceRoleModel,managementAssistant,updateServiceRole} from '../../../../dist/service-roles/roles.js';

for(const backend of ['pi','codex','claude_code'])test(`a non-project service assistant uses ${backend} through the shared session driver`,{timeout:60000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'bot-service-session-')),s=new Store(':memory:',randomBytes(32)),manager=new LocalManager('101',root),redactor=new Redactor();
 const model=createServer(async(req,res)=>{if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'claude-sonnet-4-5-20250929'}]}));return;}let raw='';for await(const part of req)raw+=part;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Service native session completed'}}],usage:{prompt_tokens:20,completion_tokens:20}}));});model.listen(0,'127.0.0.1');await once(model,'listening');
 t.after(async()=>{await manager.recover();model.closeAllConnections();await new Promise(r=>model.close(r));s.close();rmSync(root,{recursive:true,force:true});});
 s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m',NULL,?,'fixture',?,'now')",'http://127.0.0.1:'+model.address().port+'/v1',s.secrets.seal({value:'fixture-key'},'model:m'));
 const before=serviceRole(s,managementAssistant);const saved=updateServiceRole(s,'admin',managementAssistant,{expected_revision:before.revision,harness:backend,model_id:'m'});assert.equal(saved.harness,backend);
 const role=serviceRole(s,managementAssistant);await manager.call('PUT','/v1/projects/101');
 const configName=backend==='codex'?'BOT_CODEX_CONFIG':backend==='claude_code'?'BOT_CLAUDE_CODE_CONFIG':null;
 if(configName){
  const old=process.env[configName],file=join(root,'cli.json'),state=join(root,'state');mkdirSync(state,{mode:0o700});
  const config=backend==='codex'?{command:process.execPath,args:[resolve('test/fixtures/codex-app-server.mjs'),'app-server'],env:{FIXTURE_CONVERSATION:'true',CODEX_HOME:join(root,'codex-home')},stateDirectory:state,version:'0.166.0',timeoutMs:8000,cancelGraceMs:400,toolStartupMs:3000}:{command:resolve('test/fixtures/claude-code.mjs'),version:'2.1.319',model:'claude-sonnet-4-5-20250929',stateDirectory:state,timeoutMs:8000};
  if(backend==='claude_code'){const keyFile=join(root,'provider.key');writeFileSync(keyFile,'fixture-key');config.provider={baseUrl:'http://127.0.0.1:'+model.address().port,credentialFile:keyFile};}
  writeFileSync(file,JSON.stringify(config));process.env[configName]=file;t.after(()=>{if(old===undefined)delete process.env[configName];else process.env[configName]=old;});
 }
 const computer={async sessionWorkspace(task,workspaceId,redactor,log){const workspace=new Workspace(s,manager,{...task,repository_id:'101',workspace_id:workspaceId,generation:1},redactor,async()=>{},log,'service_role_operations');await workspace.call('init',{type:'workspace_init'});return workspace;}};
 const spec={store:s,task:{id:randomBytes(24).toString('hex'),kind:'management.agent',repository_id:null,service_role_id:role.id,conversation_id:'service-owner',source_message:'one'},redactor,guard:async()=>{},system:'Answer the service conversation.',prompt:JSON.stringify({fixture_mode:'conversation',request:'Respond with a brief factual answer.'}),model:serviceRoleModel(s,role.id),tools:[],execute:async()=>({error:'tool_not_allowed'})};
 const answer=await runAgent({...spec,adapter:services=>serviceHarnessTurn(spec,services,role,computer,'owner:one')});
 assert.equal(typeof answer,'string');assert.ok(answer.length>0);
 assert.equal(s.get('SELECT count(*) n FROM tasks').n,0,'no fake business project or task was created');
 const firstSession=JSON.parse(s.get('SELECT state FROM service_harness_sessions').state).sessionId;assert.ok(firstSession);
 const resumed=await runAgent({...spec,adapter:services=>serviceHarnessTurn(spec,services,role,computer,'owner:one')});
 assert.equal(typeof resumed,'string');assert.ok(resumed.length>0);
 const binding=s.get('SELECT id,state FROM service_harness_sessions');assert.equal(JSON.parse(binding.state).sessionId,firstSession);
 const principal={id:'admin',role:'super_admin',repositories:[]};
 const records=serviceRolesApi(s,principal,'GET',`/api/service-roles/${role.id}/sessions/${binding.id}/events`,{});assert.ok(records.events.length>0);
 assert.throws(()=>serviceRolesApi(s,{...principal,role:'member'},'GET',`/api/service-roles/${role.id}/sessions/${binding.id}/events`,{}));
 assert.equal(s.get('SELECT count(*) n FROM service_harness_sessions').n,1);assert.ok(s.get('SELECT count(*) n FROM service_harness_events').n>0);
 const sessionEvent=records.events.find(e=>e.type==='harness_session');
 assert.equal(sessionEvent.data.access.network,true,'assistant computer egress defaults to enabled in service harness sessions');
});

test('serviceHarnessTurn propagates assistant computer egress=false into harnessAccess.network', { timeout: 60000 }, async t => {
 const root=mkdtempSync(join(tmpdir(),'bot-service-session-egress-')),s=new Store(':memory:',randomBytes(32)),manager=new LocalManager('101',root),redactor=new Redactor();
 const model=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Offline answer'}}],usage:{prompt_tokens:10,completion_tokens:10}}));});model.listen(0,'127.0.0.1');await once(model,'listening');
 t.after(async()=>{await manager.recover();model.closeAllConnections();await new Promise(r=>model.close(r));s.close();rmSync(root,{recursive:true,force:true});});
 s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m',NULL,?,'fixture',?,'now')",'http://127.0.0.1:'+model.address().port+'/v1',s.secrets.seal({value:'fixture-key'},'model:m'));
 const before=serviceRole(s,managementAssistant);updateServiceRole(s,'admin',managementAssistant,{expected_revision:before.revision,harness:'pi',model_id:'m'});
 const role=serviceRole(s,managementAssistant);await manager.call('PUT','/v1/projects/101');
 const computer={egress:false,async sessionWorkspace(task,workspaceId,redactor,log){const workspace=new Workspace(s,manager,{...task,repository_id:'101',workspace_id:workspaceId,generation:1},redactor,async()=>{},log,'service_role_operations');await workspace.call('init',{type:'workspace_init'});return workspace;}};
 const spec={store:s,task:{id:randomBytes(24).toString('hex'),kind:'management.agent',repository_id:null,service_role_id:role.id,conversation_id:'service-owner-offline',source_message:'one'},redactor,guard:async()=>{},system:'Answer the service conversation.',prompt:JSON.stringify({fixture_mode:'conversation',request:'Respond offline.'}),model:serviceRoleModel(s,role.id),tools:[],execute:async()=>({error:'tool_not_allowed'})};
 const answer=await runAgent({...spec,adapter:services=>serviceHarnessTurn(spec,services,role,computer,'owner:offline')});
 assert.equal(typeof answer,'string');assert.ok(answer.length>0);
 const binding=s.get('SELECT id FROM service_harness_sessions');
 const principal={id:'admin',role:'super_admin',repositories:[]};
 const records=serviceRolesApi(s,principal,'GET',`/api/service-roles/${role.id}/sessions/${binding.id}/events`,{});
 const sessionEvent=records.events.find(e=>e.type==='harness_session');
 assert.equal(sessionEvent.data.access.network,false,'disabling assistant computer egress disables harnessAccess.network');
});
