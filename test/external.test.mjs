import test from 'node:test';import assert from 'node:assert/strict';
import{createServer}from'node:http';import{once}from'node:events';import{createHmac}from'node:crypto';
import{SignJWT,generateKeyPair,exportJWK,createLocalJWKSet}from'jose';
import{externalFixture,random}from'./external-helpers.mjs';import{testPassword}from'./helpers.mjs';
import{actionsIssuer}from'../dist/external/identity.js';import{publicAddress,sendWebhook}from'../dist/external/target.js';

const filters={events:['pull_request'],actions:['opened','ready_for_review','synchronize'],exclude_drafts:true};
async function subscription(h,client,url='https://receiver.invalid/hook',filter=filters){const r=await h.admin('/api/external/subscriptions','POST',{client_id:client.id,name:'PR review',url,filters:filter});assert.equal(r.status,201);return r.value;}
const payload=(id=101,draft=false)=>({repository:{id},action:'opened',pull_request:{number:1,draft,head:{sha:'a'.repeat(40)}}});

test('external token exchange uses the registered App identity, one repository and least permissions; credentials never read back',async t=>{
 const h=await externalFixture(t),created=await h.client(),client=created.client;
 const read=await h.admin('/api/external/clients/'+client.id);assert.ok(!JSON.stringify(read).includes(created.client_secret));assert.ok(!('secret_hash'in read.value.client));
 const requestId=random(),result=await h.exchange(client.id,created.client_secret,{request_id:requestId});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
 assert.deepEqual(h.github.grants[0],{repository_ids:[101],permissions:{contents:'read',issues:'write',pull_requests:'write'}});assert.equal(result.value.repository_id,'101');
 const posted=await fetch(h.github.url+'/repos/fixture/project-101/issues/1/comments',{method:'POST',headers:{Authorization:'Bearer '+result.value.token,'Content-Type':'application/json'},body:JSON.stringify({body:'Review complete'})});assert.equal(posted.status,201);assert.equal((await posted.json()).user.login,'fixture-app[bot]');
 assert.equal((await fetch(h.github.url+'/repos/fixture/project-202/issues/1/comments',{method:'POST',headers:{Authorization:'Bearer '+result.value.token,'Content-Type':'application/json'},body:'{}'})).status,403);
 await h.restart();assert.equal((await h.exchange(client.id,created.client_secret,{request_id:requestId})).status,409);assert.equal((await h.exchange(client.id,'wrong')).status,401);
 assert.equal((await h.exchange(client.id,created.client_secret,{repository_id:'202'})).status,400);
 assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n,0);const records=JSON.stringify(h.store.all('SELECT * FROM external_grants'));assert.ok(!records.includes(result.value.token));assert.ok(!records.includes(created.client_secret));
 assert.equal((await h.admin('/api/external/grants')).value.grants[0].state,'issued');
 const revoke=await fetch(h.webhook+'/external/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_id:result.value.grant_id,token:result.value.token})});assert.equal(revoke.status,200);assert.equal(h.github.tokens.get(result.value.token).revoked,true);
});

test('revocation, rotation, quota and failed upstream issuance fail closed without reusing a request',async t=>{
 const h=await externalFixture(t),c=await h.client(),id=c.client.id;
 const rotated=await h.admin('/api/external/clients/'+id,'PATCH',{rotate_secret:true});assert.equal((await h.exchange(id,c.client_secret)).status,401);
 const secret=rotated.value.client_secret;await h.admin('/api/external/clients/'+id,'PATCH',{enabled:false});assert.equal((await h.exchange(id,secret)).status,401);await h.admin('/api/external/clients/'+id,'PATCH',{enabled:true});
 h.github.setFail(true);const rid=random();assert.equal((await h.exchange(id,secret,{request_id:rid})).status,502);assert.equal((await h.exchange(id,secret,{request_id:rid})).status,409);h.github.setFail(false);
 for(let i=0;i<19;i++)h.store.run("INSERT INTO external_grants(id,client_id,request_id,created_at,state) VALUES(?,?,?,?,'failed')",random(),id,random(),Date.now());assert.equal((await h.exchange(id,secret)).status,429);
});

test('OIDC verifies signatures, issuer, audience, immutable IDs, workflow and freshness, and persists replay rejection',async t=>{
 const key=await generateKeyPair('RS256'),jwk=await exportJWK(key.publicKey);jwk.kid='fixture';
 const h=await externalFixture(t,{oidcKeys:createLocalJWKSet({keys:[jwk]})});
 const trust={audience:'department-bot-fixture',subject:'repo:fixture/workflows:ref:refs/heads/main',repository:'fixture/workflows',repository_id:'900',owner_id:'10',workflow_ref:'fixture/workflows/.github/workflows/review.yml@refs/heads/main',ref:'refs/heads/main'};
 const c=await h.client('101',{auth_type:'github_actions_oidc',trust});assert.ok(!c.client_secret);
 const claims={repository:trust.repository,repository_id:'900',repository_owner_id:'10',workflow_ref:trust.workflow_ref,ref:trust.ref,ref_type:'branch',event_name:'workflow_dispatch',run_id:'7',run_attempt:'1'};
 async function jwt(extra={},signKey=key.privateKey,options={}){const now=Math.floor(Date.now()/1000);return new SignJWT({...claims,...extra}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(options.issuer||actionsIssuer).setAudience(options.audience||trust.audience).setSubject(trust.subject).setIssuedAt(now).setNotBefore(now-1).setExpirationTime(now+300).setJti(random()).sign(signKey);}
 const valid=await jwt();assert.equal((await h.exchange(c.client.id,valid)).status,200);assert.equal((await h.exchange(c.client.id,valid)).status,409);
 for(const extra of [{event_name:'pull_request_target'},{repository_id:'901'},{repository_owner_id:'11'},{workflow_ref:'fixture/evil/.github/workflows/review.yml@refs/heads/main'},{ref:'refs/heads/feature'},{job_workflow_ref:'fixture/evil@main'}])assert.equal((await h.exchange(c.client.id,await jwt(extra))).status,403);
 for(const options of [{issuer:'https://untrusted.invalid'},{audience:'wrong'}])assert.equal((await h.exchange(c.client.id,await jwt({},key.privateKey,options))).status,401);
 const other=await generateKeyPair('RS256');assert.equal((await h.exchange(c.client.id,await jwt({},other.privateKey))).status,401);
 const expired=await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(actionsIssuer).setAudience('wrong').setSubject(trust.subject).setIssuedAt(1).setNotBefore(1).setExpirationTime(2).setJti(random()).sign(key.privateKey);assert.equal((await h.exchange(c.client.id,expired)).status,401);
});

test('only matching verified non-draft events enqueue once, in the archive transaction',async t=>{
 const h=await externalFixture(t),c=(await h.client()).client,s=await subscription(h,c);
 let result=await h.hook(h.a.path,h.a.secret,'pr-valid',payload(),{'X-GitHub-Event':'pull_request'});assert.equal(result.value.forwards_created,1);assert.equal(result.value.tasks_created,0);
 assert.equal((await h.hook(h.a.path,h.a.secret,'pr-valid',payload(),{'X-GitHub-Event':'pull_request'})).value.duplicate,true);
 await h.hook(h.a.path,'incorrect','bad',payload(),{'X-GitHub-Event':'pull_request'});await h.hook(h.a.path,h.a.secret,'draft',payload(101,true),{'X-GitHub-Event':'pull_request'});await h.hook(h.a.path,h.a.secret,'other',payload(202),{'X-GitHub-Event':'pull_request'});await h.hook(h.a.path,h.a.secret,'edited',{...payload(),action:'edited'},{'X-GitHub-Event':'pull_request'});
 assert.equal(h.store.get('SELECT count(*) n FROM external_deliveries').n,1);
 h.store.db.exec("CREATE TRIGGER fail_forward BEFORE INSERT ON external_deliveries BEGIN SELECT RAISE(ABORT,'injected forwarding failure'); END");
 const before=h.store.get('SELECT count(*) n FROM deliveries').n;assert.equal((await h.hook(h.a.path,h.a.secret,'rollback',payload(),{'X-GitHub-Event':'pull_request'})).status,503);assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n,before);
 h.store.db.exec('DROP TRIGGER fail_forward');assert.equal((await h.hook(h.a.path,h.a.secret,'rollback',payload(),{'X-GitHub-Event':'pull_request'})).status,200);
 assert.ok(!JSON.stringify((await h.admin('/api/external/subscriptions')).value).includes(s.signing_secret));
});

test('signed forwarding retries after response failure with a stable ID and sends no upstream credentials',async t=>{
 const h=await externalFixture(t),c=(await h.client()).client,received=[];let failure=true;
 const receiver=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;received.push({raw,headers:req.headers});res.writeHead(failure?500:204);res.end();});receiver.listen(0,'127.0.0.1');await once(receiver,'listening');t.after(()=>new Promise(resolve=>receiver.close(resolve)));
 const s=await subscription(h,c,'http://127.0.0.1:'+receiver.address().port+'/review');await h.hook(h.a.path,h.a.secret,'forward',payload(),{'X-GitHub-Event':'pull_request'});
 let row=h.store.get('SELECT * FROM external_deliveries');await h.external.forwarder.deliver(row);assert.equal(h.store.get('SELECT state FROM external_deliveries').state,'retry');failure=false;
 row=h.store.get('SELECT * FROM external_deliveries');await h.external.forwarder.deliver(row);assert.equal(h.store.get('SELECT state FROM external_deliveries').state,'succeeded');
 assert.equal(received.length,2);assert.equal(received[0].headers['x-bot-delivery'],received[1].headers['x-bot-delivery']);
 assert.equal(received[0].headers['x-bot-signature-256'],'sha256='+createHmac('sha256',s.signing_secret).update(received[0].raw).digest('hex'));
 for(const r of received){assert.ok(!r.raw.includes(h.a.secret));assert.ok(!r.raw.includes(h.github.privateKey));assert.equal(r.headers.authorization,undefined);assert.equal(JSON.parse(r.raw).client_id,c.id);}
});

test('project admins cannot see or mutate another repository integration, delivery or grant',async t=>{
 const h=await externalFixture(t),a=await h.client('101'),b=await h.client('202');await subscription(h,a.client);const sb=await subscription(h,b.client);
 assert.equal((await h.exchange(b.client.id,b.client_secret)).status,200);await h.hook(h.a.path,h.a.secret,'other-delivery',payload(202),{'X-GitHub-Event':'pull_request'});
 const password=testPassword();await h.admin('/api/users','POST',{username:'member',password,repository_ids:['101']});
 const actorClient=h.managementClient();await actorClient('/api/auth/login','POST',{username:'member',password});
 assert.deepEqual((await actorClient('/api/external/clients')).value.clients.map(c=>c.repository_id),['101']);
 assert.equal((await actorClient('/api/external/clients/'+b.client.id)).status,404);assert.equal((await actorClient('/api/external/clients/'+b.client.id,'PATCH',{enabled:false})).status,404);
 assert.equal((await actorClient('/api/external/subscriptions/'+sb.subscription.id,'PATCH',{enabled:false})).status,404);assert.equal((await actorClient('/api/external/grants')).value.grants.length,0);assert.equal((await actorClient('/api/external/deliveries')).value.deliveries.length,0);
});

test('forward destinations reject private addresses and redirects unless explicitly approved',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','169.254.169.254','100.100.100.200','::1','::ffff:8.8.8.8','fc00::1','fe80::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 await assert.rejects(sendWebhook('https://127.0.0.1/path',Buffer.from('{}'),{},[]));
 await assert.rejects(sendWebhook('http://127.0.0.1/path',Buffer.from('{}'),{},[]));
});

test('restart recovers an unacknowledged delivery and cancellation prevents queued sends',async t=>{
 const h=await externalFixture(t),c=(await h.client()).client,seen=[];
 const receiver=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;seen.push(req.headers['x-bot-delivery']);res.writeHead(204);res.end();});receiver.listen(0,'127.0.0.1');await once(receiver,'listening');t.after(()=>new Promise(resolve=>receiver.close(resolve)));
 const sub=await subscription(h,c,'http://127.0.0.1:'+receiver.address().port+'/');await h.hook(h.a.path,h.a.secret,'restart',payload(),{'X-GitHub-Event':'pull_request'});
 const row=h.store.get('SELECT * FROM external_deliveries');h.store.run("UPDATE external_deliveries SET state='sending',attempts=1 WHERE id=?",row.id);
 await h.restart();h.external.forwarder.start();
 const end=Date.now()+5000;while(h.store.get('SELECT state FROM external_deliveries WHERE id=?',row.id).state!=='succeeded'&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(h.store.get('SELECT state FROM external_deliveries WHERE id=?',row.id).state,'succeeded');assert.deepEqual(seen,[row.id]);
 await h.hook(h.a.path,h.a.secret,'cancel',payload(),{'X-GitHub-Event':'pull_request'});await h.admin('/api/external/subscriptions/'+sub.subscription.id,'PATCH',{enabled:false});
 const cancelled=h.store.get("SELECT * FROM external_deliveries WHERE source_id<>(SELECT source_id FROM external_deliveries WHERE id=?)",row.id);await h.external.forwarder.deliver(cancelled);assert.equal(h.store.get('SELECT state FROM external_deliveries WHERE id=?',cancelled.id).state,'cancelled');assert.equal(seen.length,1);
});

test('forwarding never follows a redirect or sends to a newly resolved private target',async t=>{
 let hits=0;const receiver=createServer((req,res)=>{hits++;res.writeHead(302,{Location:'/redirected'});res.end();});receiver.listen(0,'127.0.0.1');await once(receiver,'listening');t.after(()=>new Promise(resolve=>receiver.close(resolve)));
 assert.equal(await sendWebhook('http://127.0.0.1:'+receiver.address().port+'/',Buffer.from('{}'),{},['127.0.0.1']),302);assert.equal(hits,1);
 const h=await externalFixture(t),c=await h.client();assert.equal((await fetch(h.webhook+'/api/external/clients')).status,404);assert.equal((await fetch(h.adminBase+'/external/token',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
 assert.equal((await h.exchange(c.client.id,c.client_secret,{permissions:{contents:'write'}})).status,400);
});
