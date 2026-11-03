import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository,testPassword} from './helpers.mjs';

const snapshot=rows=>rows.map(m=>({id:m.id,version:m.version}));
const secret=(h,m)=>h.store.secrets.open(h.store.get('SELECT api_key FROM models WHERE id=?',m.id).api_key,'model:'+m.id).value;
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
