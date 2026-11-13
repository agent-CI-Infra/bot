import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository,testPassword} from './helpers.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {runAgent} from '../dist/agent/runtime.js';
import {Redactor} from '../dist/agent/common.js';
import {executionModel} from '../dist/tasks/configuration.js';
import {resolveRole} from '../dist/roles/definition.js';
import {modelRevision} from '../dist/roles/role-run.js';
import {TaskCommands} from '../dist/tasks/commands.js';

const snapshot=rows=>rows.map(m=>({id:m.id,version:m.version}));
const secret=(h,m)=>h.store.secrets.open(h.store.get('SELECT api_key FROM models WHERE id=?',m.id).api_key,'model:'+m.id).value;

test('published tasks survive provider key rotation, sibling additions and revocation without changing their model contract',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const received=[],server=createServer(async(req,res)=>{for await(const _ of req){}received.push(req.headers.authorization);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'done'}}],usage:{prompt_tokens:5,completion_tokens:2}}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const endpoint=`http://127.0.0.1:${server.address().port}/v1`,key=testPassword(),rotated=testPassword();
 let group=(await admin('/api/models/provider','POST',{repository_id:'101',api_url:endpoint,api_key:key,model_names:['alpha','beta']})).value.models;
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

for(const field of ['model_name','api_url'])test(`changing ${field} increments only that model contract and stops its pinned task`,async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const group=(await admin('/api/models/provider','POST',{repository_id:'101',api_url:'https://models.invalid/v1',api_key:testPassword(),model_names:['alpha','beta']})).value.models,id=group[0].id;
 await admin('/api/repositories/101/policy','PATCH',{model_id:id});h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','101','review.issue','running','Pinned report','{}')");
 const task=h.store.get("SELECT * FROM tasks WHERE id='t'");executionModel(h.store,task);
 const change=await admin(`/api/models/${id}`,'PATCH',{version:1,[field]:field==='model_name'?'renamed':'https://changed.invalid/v1'});
 assert.equal(change.status,200);assert.equal(change.value.model.version,2);assert.equal(h.store.get('SELECT version FROM models WHERE id=?',group[1].id).version,1);
 assert.throws(()=>executionModel(h.store,task),{code:'model_configuration_changed'});
});
test('provider creation and edits apply atomically to one scope while preserving model IDs, pricing and selection',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const key=testPassword(),next=testPassword(),created=await admin('/api/models/provider','POST',{repository_id:null,api_url:'https://models.invalid/v1',api_key:key,model_names:['alpha','beta']});
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
 const conflict=await admin('/api/models/provider','POST',{repository_id:null,api_url:'https://models.invalid/v2/chat/completions',api_key:key,model_names:['four']});assert.equal(conflict.status,409);
});
test('provider membership and versions prevent partial updates, URL collisions and concurrent edits',async t=>{
 const h=await harness(t),{admin}=await setup(h),key=testPassword();
 let group=(await admin('/api/models/provider','POST',{api_url:'https://models.invalid/v1',api_key:key,model_names:['alpha','beta']})).value.models;
 const id=group[0].id,old=snapshot(group);await admin('/api/models/'+group[1].id,'PATCH',{version:1,model_name:'renamed'});
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:old,api_url:'https://new.invalid/v1',api_key:testPassword()})).status,409);
 assert.equal((await admin('/api/models/'+id)).value.model.api_url,'https://models.invalid/v1');assert.equal(secret(h,group[0]),key);
 group=(await admin('/api/models')).value.models;await admin('/api/models','POST',{key_from:id,model_name:'third'});
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),revoke_key:true})).status,409);
 group=(await admin('/api/models')).value.models;
 await admin('/api/models/provider','POST',{api_url:'https://other.invalid/v1',api_key:key,model_names:['other']});
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),api_url:'https://other.invalid/v1'})).status,409);
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),revoke_key:true,api_key:key})).status,400);
 assert.equal((await admin('/api/models/'+id+'/provider','PATCH',{versions:snapshot(group),model_names:['alpha']})).status,409);
 assert.ok(group.every(m=>(h.store.get('SELECT version FROM models WHERE id=?',m.id).version===m.version)));
});
test('project administrators may edit only their own provider, never shared credentials or another project',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');
 const create=async repo=>(await admin('/api/models/provider','POST',{repository_id:repo,api_url:'https://models.invalid/v1',api_key:testPassword(),model_names:['alpha','beta']})).value.models;
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
 const group=(await admin('/api/models/provider','POST',{api_url:'https://models.invalid/v1',api_key:key,model_names:['alpha','beta']})).value.models;
 h.store.db.exec("CREATE TRIGGER fail_provider_audit BEFORE INSERT ON audit WHEN NEW.action='model.provider_updated' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
 const result=await admin('/api/models/'+group[0].id+'/provider','PATCH',{versions:snapshot(group),api_url:'https://changed.invalid/v1',api_key:testPassword(),model_names:['gamma']});
 assert.ok([500,503].includes(result.status));
 const after=(await admin('/api/models')).value.models;assert.equal(after.length,2);
 for(const model of after){assert.equal(model.api_url,'https://models.invalid/v1');assert.equal(model.version,1);assert.equal(secret(h,model),key);}
});
