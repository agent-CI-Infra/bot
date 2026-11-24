import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository,testPassword} from '../../../fixtures/helpers.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {runAgent} from '../../../../dist/agent/runtime.js';
import {Redactor} from '../../../../dist/agent/common.js';
import {executionModel} from '../../../../dist/tasks/configuration.js';
import {resolveRole} from '../../../../dist/roles/definition.js';
import {modelRevision} from '../../../../dist/roles/role-run.js';
import {TaskCommands} from '../../../../dist/tasks/commands.js';
import {providerStorage} from '../../../../dist/models/providers.js';
import {modelProtocol} from '../../../../dist/models/catalog.js';

const snapshot=rows=>rows.map(m=>({id:m.id,version:m.version}));
const secret=(h,m)=>h.store.secrets.open(h.store.get('SELECT api_key FROM models WHERE id=?',m.id).api_key,'model:'+m.id).value;

test('published tasks survive provider key rotation, sibling additions and revocation without changing their model contract',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const received=[],server=createServer(async(req,res)=>{for await(const _ of req){}received.push(req.headers.authorization);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'done'}}],usage:{prompt_tokens:5,completion_tokens:2}}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const endpoint=`http://127.0.0.1:${server.address().port}/v1`,key=testPassword(),rotated=testPassword();
 let group=(await admin('/api/models/provider','POST',{repository_id:'101',name:'relay',api_url:endpoint,api_key:key,model_names:['alpha','beta']})).value.models;
 const id=group[0].id;await admin('/api/repositories/101/policy','PATCH',{model_id:id});
 h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt) VALUES('t','101','review.issue','running','Continue the published PR','{}',1)");
 h.store.run("INSERT INTO github_effects VALUES('sent-pr','t','pull_request','{}','sent','{\"number\":7}','fixture-marker')");
 const task=h.store.get("SELECT * FROM tasks WHERE id='t'"),pinned=executionModel(h.store,task),revision=modelRevision(resolveRole(h.store,'101','dev','review.issue').snapshot),snapshotBefore=h.store.get("SELECT snapshot FROM task_execution_configs WHERE task_id='t'").snapshot;
 const result=await runAgent({store:h.store,task,model:pinned,redactor:new Redactor(),guard:async()=>{},system:'Inspect',prompt:'Continue',adapter:async services=>{
   await services.request({messages:[]},'before-rotation');
   const changed=await admin(`/api/models/${id}/provider`,'PATCH',{versions:snapshot(group),api_key:rotated});assert.equal(changed.status,200);group=changed.value.models;assert.ok(group.every(model=>model.version===1));
   assert.equal(executionModel(h.store,task).key,rotated);
   await services.request({messages:[]},'after-rotation');
   const added=await admin(`/api/models/${id}/provider`,'PATCH',{versions:snapshot(group),model_names:['gamma']});assert.equal(added.status,200);group=added.value.models;assert.ok(group.every(model=>model.version===1));
   await services.request({messages:[]},'after-sibling');
   assert.equal((await admin(`/api/models/${id}/credentials/revoke`,'POST',{})).status,201);
   assert.throws(()=>executionModel(h.store,task),{code:'model_not_configured'});
   await assert.rejects(services.request({messages:[]},'while-revoked'),{code:'model_not_configured'});
   assert.equal(h.store.get('SELECT version FROM models WHERE id=?',id).version,1);
   const restored=await admin(`/api/models/${id}`,'PATCH',{version:1,api_key:key});assert.equal(restored.status,200);assert.equal(restored.value.model.version,1);
   assert.equal(modelRevision(resolveRole(h.store,'101','dev','review.issue').snapshot),revision);
   await services.request({messages:[]},'after-restore');return 'continued';
 }});
 assert.equal(result,'continued');assert.deepEqual(received,['Bearer '+key,'Bearer '+rotated,'Bearer '+rotated,'Bearer '+key]);
 assert.equal(h.store.get("SELECT snapshot FROM task_execution_configs WHERE task_id='t'").snapshot,snapshotBefore);
 assert.equal(h.store.get("SELECT status FROM tasks WHERE id='t'").status,'running');
 h.store.run("UPDATE tasks SET status='paused' WHERE id='t'");
 assert.throws(()=>new TaskCommands(h.store).api({id:'owner',role:'super_admin',repositories:[]},'POST',new URL('http://local/api/tasks/t/adopt-config'),{}),{code:'task_config_after_publication'});
});

for(const field of ['model_name','api_url'])test(`changing ${field} increments the model contracts it belongs to and stops the pinned task`,async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const group=(await admin('/api/models/provider','POST',{repository_id:'101',name:'relay',api_url:'https://models.invalid/v1',api_key:testPassword(),model_names:['alpha','beta']})).value.models,id=group[0].id;
 await admin('/api/repositories/101/policy','PATCH',{model_id:id});h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','101','review.issue','running','Pinned report','{}')");
 const task=h.store.get("SELECT * FROM tasks WHERE id='t'");executionModel(h.store,task);
 // A name belongs to one model; an address to its whole provider (#1332).
 const change=field==='model_name'?await admin(`/api/models/${id}`,'PATCH',{version:1,model_name:'renamed'}):await admin(`/api/models/${id}/provider`,'PATCH',{versions:snapshot(group),api_url:'https://changed.invalid/v1'});
 assert.equal(change.status,200);assert.deepEqual(group.map(m=>h.store.get('SELECT version FROM models WHERE id=?',m.id).version),field==='model_name'?[2,1]:[2,2]);
 assert.throws(()=>executionModel(h.store,task),{code:'model_configuration_changed'});
});
test('provider creation and edits apply atomically to one scope while preserving model IDs, pricing and selection',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const key=testPassword(),next=testPassword(),created=await admin('/api/models/provider','POST',{repository_id:null,name:'relay',api_url:'https://models.invalid/v1',api_key:key,model_names:['alpha','beta']});
 assert.equal(created.status,201);let group=created.value.models;assert.ok(!JSON.stringify(created.value).includes(key));
 const own=(await admin('/api/models','POST',{repository_id:'101',api_url:'https://models.invalid/v1',api_key:key,model_name:'own'})).value.model;
 await admin('/api/repositories/101/policy','PATCH',{model_id:group[0].id});
 const first=group[0].id;
 h.store.run('INSERT INTO model_pricing VALUES(?,?,?,?,?)',first,'USD',2,10,0.2);
 let response=await admin('/api/models/'+first+'/provider','PATCH',{versions:snapshot(group),api_url:'https://models.invalid/v2',api_key:'',model_names:['gamma']});
 assert.equal(response.status,200);group=response.value.models;assert.equal(group.length,3);assert.deepEqual(group.find(m=>m.id===first).pricing,{currency:'USD',input_per_million:2,output_per_million:10,cache_per_million:0.2});assert.ok(group.every(m=>m.api_url==='https://models.invalid/v2'&&secret(h,m)===key));
 assert.equal((await admin('/api/repositories/101')).value.policy.model_id,first);assert.equal((await admin('/api/models/'+own.id)).value.model.api_url,'https://models.invalid/v1');
 response=await admin('/api/models/'+first+'/provider','PATCH',{versions:snapshot(group),api_key:next});assert.equal(response.status,200);group=response.value.models;
 assert.ok(group.every(m=>secret(h,m)===next));assert.ok(!JSON.stringify(response.value).includes(next));assert.equal(secret(h,own),key);
 response=await admin('/api/models/'+first+'/provider','PATCH',{versions:snapshot(group),revoke_key:true});assert.equal(response.status,200);assert.ok(response.value.models.every(m=>!m.key_configured));
 assert.equal((await admin('/api/repositories/101')).value.policy.model_id,first);assert.ok((await admin('/api/models/'+own.id)).value.model.key_configured);
 // Providers are told apart by name, not address (#1332): the same name in the same scope is refused, whatever its case.
 const conflict=await admin('/api/models/provider','POST',{repository_id:null,name:'RELAY',api_url:'https://other.invalid/v1',api_key:key,model_names:['four']});assert.deepEqual([conflict.status,conflict.value],[409,{error:'provider_name_taken'}]);
});
test('provider membership and versions prevent partial updates, name collisions and concurrent edits',async t=>{
 const h=await harness(t),{admin}=await setup(h),key=testPassword();
 let group=(await admin('/api/models/provider','POST',{name:'relay',api_url:'https://models.invalid/v1',api_key:key,model_names:['alpha','beta']})).value.models;
 const id=group[0].id,old=snapshot(group);await admin('/api/models/'+group[1].id,'PATCH',{version:1,model_name:'renamed'});
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:old,api_url:'https://new.invalid/v1',api_key:testPassword()})).status,409);
 assert.equal((await admin('/api/models/'+id)).value.model.api_url,'https://models.invalid/v1');assert.equal(secret(h,group[0]),key);
 group=(await admin('/api/models')).value.models;await admin('/api/models','POST',{key_from:id,model_name:'third'});
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),revoke_key:true})).status,409);
 group=(await admin('/api/models')).value.models;
 await admin('/api/models/provider','POST',{name:'other',api_url:'https://other.invalid/v1',api_key:key,model_names:['other']});
 assert.deepEqual((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),name:'Other'})).value,{error:'provider_name_taken'});
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),revoke_key:true,api_key:key})).status,400);
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),model_names:['alpha']})).status,409);
 assert.ok(group.every(m=>(h.store.get('SELECT version FROM models WHERE id=?',m.id).version===m.version)));
});
test('project administrators may edit only their own provider, never shared credentials or another project',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');
 const create=async repo=>(await admin('/api/models/provider','POST',{repository_id:repo,name:'relay',api_url:'https://models.invalid/v1',api_key:testPassword(),model_names:['alpha','beta']})).value.models;
 const own=await create('101'),other=await create('202'),shared=await create(null),password=testPassword();await admin('/api/users','POST',{username:'member',password,repository_ids:['101']});
 await admin('/api/repositories/101/policy','PATCH',{model_id:shared[0].id});const member=h.client();await member('/api/auth/login','POST',{username:'member',password});
 assert.equal((await member('/api/models/'+own[0].id+'/provider','PATCH',{versions:snapshot(own),api_key:testPassword()})).status,200);
 assert.equal((await member('/api/models/'+other[0].id+'/provider','PATCH',{versions:snapshot(other),revoke_key:true})).status,404);
 assert.equal((await member('/api/models/'+shared[0].id+'/provider','PATCH',{versions:snapshot(shared),revoke_key:true})).status,403);
 assert.equal((await member('/api/models/provider','POST',{api_url:'https://new.invalid/v1',api_key:testPassword(),model_names:['x']})).status,403);
 assert.equal((await member('/api/models/provider','POST',{repository_id:'202',api_url:'https://new.invalid/v1',api_key:testPassword(),model_names:['x']})).status,403);
});

test('an audit failure rolls back all provider URLs, keys, versions and additions',async t=>{
 const h=await harness(t),{admin}=await setup(h),key=testPassword();
 const group=(await admin('/api/models/provider','POST',{name:'relay',api_url:'https://models.invalid/v1',api_key:key,model_names:['alpha','beta']})).value.models;
 h.store.db.exec("CREATE TRIGGER fail_provider_audit BEFORE INSERT ON audit WHEN NEW.action='model.provider_updated' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
 const result=await admin('/api/models/'+group[0].id+'/provider','PATCH',{versions:snapshot(group),name:'renamed',interface_type:'openai-responses',api_url:'https://changed.invalid/v1',api_key:testPassword(),model_names:['gamma']});
 assert.ok([500,503].includes(result.status));
 const after=(await admin('/api/models')).value.models;assert.equal(after.length,2);
 for(const model of after){assert.equal(model.api_url,'https://models.invalid/v1');assert.equal(model.version,1);assert.equal(secret(h,model),key);assert.equal(model.provider_name,'relay');assert.equal(model.protocol.override.interface_type,null);}
});

test('one address serves several named providers, each with one interface its models share and inherit (#1332)',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const url='https://gateway.invalid/v1',key=testPassword(),create=body=>admin('/api/models/provider','POST',{api_url:url,api_key:key,model_names:['flash'],...body});
 const chat=(await create({name:'gateway'})).value.models,responses=await create({name:'gateway-responses',interface_type:'openai-responses'});
 assert.equal(responses.status,201);const [flash]=responses.value.models;
 // The Responses provider's model says which interface it uses and why, and where its requests really go.
 let model=(await admin('/api/models/'+flash.id)).value.model;
 assert.deepEqual([model.provider_name,model.protocol.interface_type,model.protocol.source,model.endpoints.chat_url],['gateway-responses','openai-responses','manual',url+'/responses']);
 assert.deepEqual(model.protocol.inferred,{interface_type:'openai-chat-completions',source:'default'});
 model=(await admin('/api/models/'+chat[0].id)).value.model;
 assert.deepEqual([model.provider_name,model.protocol.interface_type,model.protocol.source,model.endpoints.chat_url],['gateway','openai-chat-completions','default',url+'/chat/completions']);
 // Names are unique per scope, compared without case; another scope may reuse one.
 assert.deepEqual((await create({name:'Gateway'})).value,{error:'provider_name_taken'});
 assert.equal((await create({name:'gateway',repository_id:'101'})).status,201);
 for(const name of ['','  ','line\nbreak','x'.repeat(101),undefined])assert.deepEqual((await create({name})).value,{error:'invalid_provider_name'},String(name));
 assert.deepEqual((await create({name:'grpc',interface_type:'grpc'})).value,{error:'invalid_model_interface'});
 // Models added later inherit the provider's interface; changing it changes every member and no model contract.
 let group=(await admin('/api/models/'+flash.id+'/provider','PATCH',{versions:snapshot(responses.value.models),model_names:['flash-2']})).value.models;
 assert.deepEqual(group.map(m=>[m.model_name,m.provider_name,m.protocol.interface_type,m.protocol.source]),[['flash','gateway-responses','openai-responses','manual'],['flash-2','gateway-responses','openai-responses','manual']]);
 group=(await admin('/api/models/'+flash.id+'/provider','PATCH',{versions:snapshot(group),interface_type:'anthropic-messages',name:'gateway-messages'})).value.models;
 assert.deepEqual(group.map(m=>[m.provider_name,m.protocol.interface_type,m.version,m.endpoints.chat_url]),[['gateway-messages','anthropic-messages',1,url+'/messages'],['gateway-messages','anthropic-messages',1,url+'/messages']]);
 group=(await admin('/api/models/'+flash.id+'/provider','PATCH',{versions:snapshot(group),interface_type:'auto'})).value.models;
 assert.ok(group.every(m=>m.protocol.source==='default'&&m.protocol.override.interface_type===null));
 assert.equal((await admin('/api/models/'+chat[0].id)).value.model.protocol.source,'default');
 // The interface and address are provider settings: one model cannot leave its provider's.
 for(const change of [{interface_type:'openai-responses'},{api_url:'https://elsewhere.invalid/v1'}])assert.deepEqual((await admin('/api/models/'+flash.id,'PATCH',{version:1,...change})).value,{error:'unknown_field'});
 // Moving a provider onto an address another provider already uses is allowed too.
 const moved=await create({name:'elsewhere',api_url:'https://elsewhere.invalid/v1'});
 assert.equal((await admin('/api/models/'+moved.value.models[0].id+'/provider','PATCH',{versions:snapshot(moved.value.models),api_url:url})).status,200);
 // A model created alone is a provider of its own: named by the caller, or after its host when that name is free.
 const named=await admin('/api/models','POST',{api_url:url,api_key:key,model_name:'solo',provider_name:'solo',interface_type:'openai-responses'});
 assert.deepEqual([named.value.model.provider_name,named.value.model.protocol.interface_type],['solo','openai-responses']);
 assert.deepEqual((await admin('/api/models','POST',{api_url:url,api_key:key,model_name:'solo',provider_name:'SOLO'})).value,{error:'provider_name_taken'});
 const unnamed=[];for(let i=0;i<2;i++)unnamed.push((await admin('/api/models','POST',{api_url:url,api_key:key,model_name:'auto'})).value.model.provider_name);
 assert.deepEqual(unnamed,['gateway.invalid','gateway.invalid-2']);
 assert.equal((await admin('/api/models','POST',{repository_id:'101',api_url:url,api_key:key,model_name:'own'})).value.model.provider_name,'gateway.invalid');
});

test('naming existing providers keeps their address groups and every model protocol (#1332)',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const add=(id,repo,url,type)=>{h.store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES(?,?,?,?,NULL,1,?)',id,repo,url,id,new Date().toISOString());
  if(type)h.store.run('INSERT INTO model_catalog_overrides(model_id,interface_type) VALUES(?,?)',id,type);};
 // Before #1332 a provider was the models of one scope with one request address: m1 and m2 were one, m3 another.
 add('m1',null,'https://relay.example/v1');add('m2',null,'https://relay.example/v1/chat/completions/');add('m3',null,'https://relay.example/v2');
 // m4 shares m1's address but was given its own interface through the API: it becomes a provider of its own.
 add('m4',null,'https://relay.example/v1','openai-responses');add('m5','101','https://relay.example/v1');
 const protocols=()=>Object.fromEntries(['m1','m2','m3','m4','m5'].map(id=>{const p=modelProtocol(h.store,h.store.get('SELECT * FROM models WHERE id=?',id));return [id,p.interface_type+':'+p.source];}));
 const before=protocols(),names=()=>Object.fromEntries(h.store.all("SELECT id,provider_name FROM models WHERE id LIKE 'm_' ORDER BY id").map(r=>[r.id,r.provider_name]));
 // As on an upgraded database: the column does not exist yet.
 h.store.db.exec('ALTER TABLE models DROP COLUMN provider_name');providerStorage(h.store);
 const expected={m1:'relay.example',m2:'relay.example',m3:'relay.example-3',m4:'relay.example-2',m5:'relay.example'};
 assert.deepEqual(names(),expected);assert.deepEqual(protocols(),before);
 // A second start finds nothing to name and changes nothing.
 providerStorage(h.store);assert.deepEqual(names(),expected);
 const groups=(await admin('/api/models')).value.models.reduce((all,m)=>({...all,[m.provider_name+'@'+m.repository_id]:[...(all[m.provider_name+'@'+m.repository_id]||[]),m.id].sort()}),{});
 assert.deepEqual(groups,{'relay.example@null':['m1','m2'],'relay.example-3@null':['m3'],'relay.example-2@null':['m4'],'relay.example@101':['m5']});
});
