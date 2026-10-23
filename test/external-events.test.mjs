import test from 'node:test';
import assert from 'node:assert/strict';
import {ServerResponse} from 'node:http';
import {externalFixture,random} from './external-helpers.mjs';
import {testPassword} from './helpers.mjs';

const payload=(repository=101,number=7)=>({repository:{id:repository},action:'opened',issue:{number,title:'Work item'}});
async function poll(h,token,path='/external/events'){
  const response=await fetch(h.webhook+path,{headers:{Authorization:'Bearer '+token}});
  return {status:response.status,value:await response.json(),headers:response.headers};
}
async function grant(h,client){const result=await h.exchange(client.client.id,client.privateKey);assert.equal(result.status,200);return result.value;}

test('the same GitHub token polls archived events once per client, independently of subscriptions and exchange quota',async t=>{
  const h=await externalFixture(t),a=await h.client(),b=await h.client(),other=await h.client('202');
  const ga=await grant(h,a),gb=await grant(h,b),go=await grant(h,other);
  await h.hook(h.a.path,h.a.secret,'issue-event',payload());
  await h.hook(h.a.path,h.a.secret,'issue-event',payload());
  const pr={repository:{id:101},number:8,action:'synchronize',pull_request:{number:8,draft:true}};
  await h.hook(h.a.path,h.a.secret,'pr-event',pr,{'X-GitHub-Event':'pull_request'});
  await h.hook(h.a.path,h.a.secret,'foreign-event',payload(202));
  await h.hook(h.a.path,'invalid','unverified-event',payload());
  await h.hook(h.a.path,h.a.secret,'push-event',{repository:{id:101}},{'X-GitHub-Event':'push'});
  const first=await poll(h,ga.token);assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
  assert.deepEqual(first.value.events.map(e=>e.delivery_id),['issue-event','pr-event']);
  assert.deepEqual(first.value.events.map(e=>[e.event,e.action,e.repository_id,e.object_number]),[['issues','opened','101',7],['pull_request','synchronize','101',8]]);
  assert.deepEqual(first.value.events[0].payload,payload());assert.deepEqual(first.value.events[1].payload,pr);
  assert.equal((await poll(h,ga.token)).value.events.length,0);
  assert.deepEqual((await poll(h,gb.token)).value.events,first.value.events);
  assert.deepEqual((await poll(h,go.token)).value.events.map(e=>e.delivery_id),['foreign-event']);
  const renewed=await grant(h,a);assert.deepEqual((await poll(h,renewed.token)).value,{events:[]});
  for(let i=0;i<18;i++)h.store.run("INSERT INTO external_grants(id,client_id,request_id,created_at,state) VALUES(?,?,?,?,'failed')",random(),a.client.id,random(),Date.now());
  assert.equal((await h.exchange(a.client.id,a.privateKey)).status,429);
  assert.equal((await poll(h,ga.token)).status,200);assert.equal(h.store.get('SELECT count(*) n FROM external_grants WHERE client_id=?',a.client.id).n,20);
  const comment=await fetch(h.github.url+'/repos/fixture/project-101/issues/7/comments',{method:'POST',headers:{Authorization:'Bearer '+ga.token,'Content-Type':'application/json'},body:JSON.stringify({body:'Polled work complete'})});assert.equal(comment.status,201);
  const responseText=JSON.stringify(first.value);for(const secret of [ga.token,h.a.secret,h.github.privateKey])assert.ok(!responseText.includes(secret));
  await h.restart();assert.deepEqual((await poll(h,ga.token)).value,{events:[]});
  await h.hook(h.a.path,h.a.secret,'after-restart',payload(101,9));assert.equal((await poll(h,ga.token)).value.events[0].object_number,9);
});

test('24-hour expiry and deduplication preserve the full archive and existing webhook forwarding',async t=>{
  const h=await externalFixture(t),a=await h.client(),b=await h.client(),ga=await grant(h,a),gb=await grant(h,b);
  const sub=await h.admin('/api/repositories/101/external/subscriptions','POST',{client_id:a.client.id,name:'Issues',url:'https://receiver.invalid/hook',filters:{events:['issues'],actions:[],exclude_drafts:false}});assert.equal(sub.status,201);
  await h.hook(h.a.path,h.a.secret,'expired',payload());
  const old=new Date(Date.now()-86400001).toISOString();h.store.run('UPDATE external_events SET received_at=?',old);h.store.run('UPDATE deliveries SET received_at=?',old);
  // GitHub can redeliver the same delivery through another configured endpoint.
  const endpoint=random();h.store.run('INSERT INTO endpoints VALUES(?,?,?)',endpoint,h.a.id,h.store.secrets.seal({value:h.a.secret},'endpoint:'+endpoint));
  await h.hook('/hooks/github/'+h.a.id+'/'+endpoint,h.a.secret,'expired',payload());
  await h.hook(h.a.path,h.a.secret,'recent',payload(101,9));
  await h.hook('/hooks/github/'+h.a.id+'/'+endpoint,h.a.secret,'recent',payload(101,9));
  for(const g of [ga,gb])assert.deepEqual((await poll(h,g.token)).value.events.map(e=>e.delivery_id),['recent']);
  assert.equal(h.store.get('SELECT count(*) n FROM external_events').n,1);
  assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n,4);
  assert.ok(h.store.get("SELECT 1 FROM external_deliveries d JOIN deliveries s ON s.id=d.source_id WHERE s.delivery_id='expired'"));
  // Migration makes recent pre-upgrade archives available and never resurrects old events.
  h.store.run('DELETE FROM external_events');h.store.run('DELETE FROM external_event_cursors');await h.restart();
  assert.deepEqual((await poll(h,ga.token)).value.events.map(e=>e.delivery_id),['recent']);
  assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n,4);
});

test('unknown, expired, revoked and disabled grants cannot poll, and repository selectors are rejected',async t=>{
  const h=await externalFixture(t),a=await h.client(),g=await grant(h,a);
  assert.equal((await poll(h,'unknown-secret')).status,401);
  assert.equal((await fetch(h.webhook+'/external/events')).status,401);
  assert.equal((await poll(h,g.token,'/external/events?repository_id=202')).status,400);
  assert.equal((await fetch(h.adminBase+'/external/events',{headers:{Authorization:'Bearer '+g.token}})).status,404);
  assert.equal((await poll(h,a.privateKey.export({type:'pkcs8',format:'pem'}).replaceAll('\n',''))).status,401);
  h.store.run('UPDATE external_grants SET expires_at=? WHERE id=?',new Date(Date.now()-1).toISOString(),g.grant_id);assert.equal((await poll(h,g.token)).status,401);
  h.store.run('UPDATE external_grants SET expires_at=? WHERE id=?',new Date(Date.now()+3600000).toISOString(),g.grant_id);
  await h.admin('/api/repositories/101/external/clients/'+a.client.id,'PATCH',{enabled:false});assert.equal((await poll(h,g.token)).status,401);
  await h.admin('/api/repositories/101/external/clients/'+a.client.id,'PATCH',{enabled:true});
  await fetch(h.webhook+'/external/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_id:g.grant_id,token:g.token})});
  assert.equal((await poll(h,g.token)).status,401);
  assert.ok(!JSON.stringify((await poll(h,g.token)).value).includes(g.token));
});

test('concurrent polls serialize per client; an HTTP response that fails before finish does not consume events',async t=>{
  const h=await externalFixture(t),a=await h.client(),g=await grant(h,a);await h.hook(h.a.path,h.a.secret,'pending',payload());
  const original=ServerResponse.prototype.end;let failed=false;
  ServerResponse.prototype.end=function(data,...args){
    if(!failed&&typeof data==='string'&&data.startsWith('{"events":')){failed=true;this.destroy();return this;}
    return original.call(this,data,...args);
  };
  try{await assert.rejects(poll(h,g.token));}finally{ServerResponse.prototype.end=original;}
  assert.equal(failed,true);assert.equal(h.store.get('SELECT count(*) n FROM external_event_cursors').n,0);
  const responses=await Promise.all([poll(h,g.token),poll(h,g.token)]);
  assert.deepEqual(responses.map(r=>r.value.events.length).sort(),[0,1]);
  assert.equal(h.store.get('SELECT count(*) n FROM external_event_cursors').n,1);
});

test('polling drains batches of 100 without skipping the next batch',async t=>{
  const h=await externalFixture(t),a=await h.client(),g=await grant(h,a);
  for(let i=1;i<=101;i++)await h.hook(h.a.path,h.a.secret,'event-'+i,payload(101,i));
  assert.equal((await poll(h,g.token)).value.events.length,100);
  assert.deepEqual((await poll(h,g.token)).value.events.map(e=>e.object_number),[101]);
  assert.deepEqual((await poll(h,g.token)).value,{events:[]});
});

test('project routes reject foreign resources for super admins and hide all foreign data from project admins',async t=>{
  const h=await externalFixture(t),a=await h.client(),b=await h.client('202');
  const sub=await h.admin('/api/repositories/202/external/subscriptions','POST',{client_id:b.client.id,name:'Foreign subscription',url:'https://receiver.invalid/hook',filters:{events:['issues'],actions:[],exclude_drafts:false}});
  await grant(h,b);await h.hook(h.a.path,h.a.secret,'foreign',payload(202));const delivery=h.store.get('SELECT id FROM external_deliveries');h.store.run("UPDATE external_deliveries SET state='failed'");
  const base='/api/repositories/101/external';
  assert.equal((await h.admin(base+'/clients','POST',{repository_id:'202',name:'Mismatch',auth_type:'private_key_jwt',public_key:a.publicKey})).status,400);
  assert.equal((await h.admin(base+'/clients/'+b.client.id,'PATCH',{enabled:false})).status,404);
  assert.equal((await h.admin(base+'/subscriptions','POST',{client_id:b.client.id,name:'Mismatch',url:'https://receiver.invalid/hook',filters:{events:['issues'],actions:[],exclude_drafts:false}})).status,404);
  assert.equal((await h.admin(base+'/subscriptions/'+sub.value.subscription.id,'PATCH',{enabled:false})).status,404);
  assert.equal((await h.admin(base+'/deliveries/'+delivery.id+'/retry','POST',{})).status,404);
  assert.equal((await h.admin(base+'/clients?repository_id=202')).status,400);
  assert.equal((await h.admin(base+'/clients/'+a.client.id,'PATCH',{repository_id:'202'})).status,400);
  const created=await h.admin(base+'/clients','POST',{name:'Current project',auth_type:'private_key_jwt',public_key:a.publicKey});assert.equal(created.status,201);assert.equal(created.value.client.repository_id,'101');
  const password=testPassword();await h.admin('/api/users','POST',{username:'scoped-member',password,repository_ids:['101']});
  const member=h.managementClient();await member('/api/auth/login','POST',{username:'scoped-member',password});
  for(const resource of ['clients','subscriptions','deliveries','grants']){
    assert.equal((await member('/api/repositories/202/external/'+resource)).status,403);
    const list=(await member(base+'/'+resource)).value[resource];assert.ok(list.every(row=>row.repository_id==='101'));
  }
  assert.equal((await member(base+'/clients/'+b.client.id)).status,404);
  assert.equal((await member('/api/external/settings','PUT',{token_audience:h.audience})).status,403);
});
