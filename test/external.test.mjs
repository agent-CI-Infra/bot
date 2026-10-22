import test from 'node:test';import assert from 'node:assert/strict';
import{createServer}from'node:http';import{once}from'node:events';import{createHmac}from'node:crypto';
import{SignJWT,generateKeyPair,exportJWK,createLocalJWKSet}from'jose';
import{externalFixture,random}from'./external-helpers.mjs';import{testPassword}from'./helpers.mjs';
import{actionsIssuer}from'../dist/external/identity.js';import{publicAddress,sendWebhook}from'../dist/external/target.js';
import{createAssertion,exchangeToken}from'../scripts/external-token.mjs';
import{digest}from'../dist/core/security.js';
import{generateKeyPairSync}from'node:crypto';import{writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';import{join}from'node:path';

const filters={events:['pull_request'],actions:['opened','ready_for_review','synchronize'],exclude_drafts:true};
async function subscription(h,client,url='https://receiver.invalid/hook',filter=filters){const r=await h.admin('/api/external/subscriptions','POST',{client_id:client.id,name:'PR review',url,filters:filter});assert.equal(r.status,201);return r.value;}
const payload=(id=101,draft=false)=>({repository:{id},action:'opened',pull_request:{number:1,draft,head:{sha:'a'.repeat(40)}}});

test('external token exchange uses the registered App identity, one repository and least permissions; credentials never read back',async t=>{
 const h=await externalFixture(t),created=await h.client(),client=created.client;
 const privatePem=created.privateKey.export({type:'pkcs8',format:'pem'});const read=await h.admin('/api/external/clients/'+client.id);assert.ok(!JSON.stringify(read).includes(privatePem));assert.equal(read.value.client.auth_type,'private_key_jwt');assert.equal(read.value.client.key_configured,true);assert.equal(read.value.client_secret,undefined);assert.ok(!('secret_hash'in read.value.client));
 const requestId=random(),result=await h.exchange(client.id,created.privateKey,{request_id:requestId});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
 assert.deepEqual(h.github.grants[0],{repository_ids:[101],permissions:{contents:'read',issues:'write',pull_requests:'write'}});assert.equal(result.value.repository_id,'101');
 const posted=await fetch(h.github.url+'/repos/fixture/project-101/issues/1/comments',{method:'POST',headers:{Authorization:'Bearer '+result.value.token,'Content-Type':'application/json'},body:JSON.stringify({body:'Review complete'})});assert.equal(posted.status,201);assert.equal((await posted.json()).user.login,'fixture-app[bot]');
 assert.equal((await fetch(h.github.url+'/repos/fixture/project-202/issues/1/comments',{method:'POST',headers:{Authorization:'Bearer '+result.value.token,'Content-Type':'application/json'},body:'{}'})).status,403);
 await h.restart();assert.equal((await h.exchange(client.id,created.privateKey,{request_id:requestId})).status,409);assert.equal((await h.exchange(client.id,'wrong')).status,401);
 assert.equal((await h.exchange(client.id,created.privateKey,{repository_id:'202'})).status,400);
 assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n,0);const records=JSON.stringify(h.store.all('SELECT * FROM external_grants'));assert.ok(!records.includes(result.value.token));assert.ok(!records.includes(privatePem));
 assert.equal((await h.admin('/api/external/grants')).value.grants[0].state,'issued');
 const revoke=await fetch(h.webhook+'/external/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_id:result.value.grant_id,token:result.value.token})});assert.equal(revoke.status,200);assert.equal(h.github.tokens.get(result.value.token).revoked,true);
});

test('revocation, rotation, quota and failed upstream issuance fail closed without reusing a request',async t=>{
 const h=await externalFixture(t),c=await h.client(),id=c.client.id;
 const replacement=await h.client();const rotated=await h.admin('/api/external/clients/'+id,'PATCH',{public_key:replacement.publicKey});assert.equal(rotated.status,200);assert.equal((await h.exchange(id,c.privateKey)).status,401);
 const secret=replacement.privateKey;await h.admin('/api/external/clients/'+id,'PATCH',{enabled:false});assert.equal((await h.exchange(id,secret)).status,401);await h.admin('/api/external/clients/'+id,'PATCH',{enabled:true});
 h.github.setFail(true);const rid=random();assert.equal((await h.exchange(id,secret,{request_id:rid})).status,502);assert.equal((await h.exchange(id,secret,{request_id:rid})).status,409);h.github.setFail(false);
 for(let i=0;i<19;i++)h.store.run("INSERT INTO external_grants(id,client_id,request_id,created_at,state) VALUES(?,?,?,?,'failed')",random(),id,random(),Date.now());assert.equal((await h.exchange(id,secret)).status,429);
});

test('OIDC verifies signatures, issuer, audience, immutable IDs, workflow and freshness, and persists replay rejection',async t=>{
 const key=await generateKeyPair('RS256'),jwk=await exportJWK(key.publicKey);jwk.kid='fixture';
 const h=await externalFixture(t,{oidcKeys:createLocalJWKSet({keys:[jwk]})});
 const trust={audience:'department-bot-fixture',subject:'repo:fixture/workflows:ref:refs/heads/main',repository:'fixture/workflows',repository_id:'900',owner_id:'10',workflow_ref:'fixture/workflows/.github/workflows/review.yml@refs/heads/main',ref:'refs/heads/main'};
 const c=await h.client('101',{auth_type:'github_actions_oidc',trust});assert.ok(!c.privateKey);
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
 assert.equal((await h.exchange(b.client.id,b.privateKey)).status,200);await h.hook(h.a.path,h.a.secret,'other-delivery',payload(202),{'X-GitHub-Event':'pull_request'});
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
 assert.equal((await h.exchange(c.client.id,c.privateKey,{permissions:{contents:'write'}})).status,400);
});

test('private-key proofs bind client, audience, time, algorithm and request ID; replay remains blocked after restart',async t=>{
 const h=await externalFixture(t),c=await h.client(),other=await h.client('202'),now=Math.floor(Date.now()/1000);
 async function signed(changes={},header={},key=c.privateKey){const request=random(),token=await new SignJWT({iss:c.client.id,sub:c.client.id,aud:h.audience,iat:now,exp:now+120,jti:request,...changes}).setProtectedHeader({alg:'RS256',typ:'JWT',...header}).sign(key);return {request,token};}
 for(const changes of [{iss:other.client.id},{sub:other.client.id},{aud:'https://other.invalid/external/token'},{aud:[h.audience,'https://other.invalid/external/token']},{iat:now+60,exp:now+120},{iat:now-100,exp:now-10},{exp:now+121},{exp:now},{jti:'short'}]){
  const p=await signed(changes);assert.equal((await h.exchange(c.client.id,p.token,{request_id:p.request})).status,401,JSON.stringify(changes));
 }
 for(const header of [{typ:'not-a-client-proof'},{jku:'https://attacker.invalid/keys'},{jwk:{kty:'RSA',n:'invalid',e:'AQAB'}}]){const p=await signed({},header);assert.equal((await h.exchange(c.client.id,p.token,{request_id:p.request})).status,401);}
 const wrongKey=await signed({}, {},other.privateKey);assert.equal((await h.exchange(c.client.id,wrongKey.token,{request_id:wrongKey.request})).status,401);
 const mac=await signed({}, {alg:'HS256'},Buffer.from(c.publicKey));assert.equal((await h.exchange(c.client.id,mac.token,{request_id:mac.request})).status,401);
 assert.equal(h.github.grants.length,0);
 const p=await signed();assert.equal((await h.exchange(c.client.id,p.token,{request_id:random()})).status,401);
 const outcomes=await Promise.all([h.exchange(c.client.id,p.token,{request_id:p.request}),h.exchange(c.client.id,p.token,{request_id:p.request})]);assert.deepEqual(outcomes.map(v=>v.status).sort(),[200,409]);assert.equal(h.github.grants.length,1);
 await h.restart();assert.equal((await h.exchange(c.client.id,p.token,{request_id:p.request})).status,409);
 await h.admin('/api/external/clients/'+c.client.id,'PATCH',{public_key:other.publicKey});const stale=await signed();assert.equal((await h.exchange(c.client.id,stale.token,{request_id:stale.request})).status,401);
 assert.equal((await h.exchange(c.client.id,other.privateKey)).status,200);
});

test('legacy credentials are removed on migration while client IDs, subscriptions and history remain',async t=>{
 const h=await externalFixture(t),c=await h.client(),sub=await subscription(h,c.client),legacy=random();
 h.store.run("UPDATE external_clients SET auth_type='client_secret',secret_hash=?,public_key=NULL WHERE id=?",digest(legacy),c.client.id);await h.restart();
 const row=(await h.admin('/api/external/clients/'+c.client.id)).value.client;assert.equal(row.auth_type,'private_key_jwt');assert.equal(row.key_configured,false);assert.equal(row.id,c.client.id);
 assert.equal(h.store.get('SELECT secret_hash FROM external_clients WHERE id=?',c.client.id).secret_hash,null);assert.equal((await h.exchange(c.client.id,legacy)).status,401);assert.equal((await h.exchange(c.client.id,c.privateKey)).status,401);
 assert.equal((await h.admin('/api/external/subscriptions')).value.subscriptions[0].id,sub.subscription.id);
 assert.equal((await h.admin('/api/external/clients/'+c.client.id,'PATCH',{public_key:c.publicKey})).status,200);assert.equal((await h.exchange(c.client.id,c.privateKey)).status,200);
 const before=(await h.admin('/api/external/clients/'+c.client.id)).value.client;await h.restart();assert.equal((await h.admin('/api/external/clients/'+c.client.id)).value.client.version,before.version);
 assert.equal((await h.admin('/api/external/clients','POST',{name:'Legacy',repository_id:'101',auth_type:'client_secret'})).status,400);
 assert.equal((await h.admin('/api/external/clients/'+c.client.id,'PATCH',{rotate_secret:true})).status,400);
});

test('public-key registration rejects private/weak keys and project administrators cannot change the deployment audience',async t=>{
 const h=await externalFixture(t),c=await h.client(),foreign=await h.client('202'),pem=c.privateKey.export({type:'pkcs8',format:'pem'});
 const weak=generateKeyPairSync('rsa',{modulusLength:1024}).publicKey.export({type:'spki',format:'pem'}),wrongType=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
 for(const key of [pem,weak,wrongType,'not a key']){const r=await h.admin('/api/external/clients','POST',{name:'Invalid key',repository_id:'101',auth_type:'private_key_jwt',public_key:key});assert.equal(r.status,400);assert.ok(!JSON.stringify(r).includes(pem));}
 assert.ok(!JSON.stringify(h.store.all('SELECT * FROM external_clients')).includes(pem));
 h.store.run("DELETE FROM settings WHERE key='external_token_audience'");assert.equal((await h.exchange(c.client.id,c.privateKey)).status,503);
 for(const value of ['http://bot.invalid/external/token','https://bot.invalid/external/token?x=1','https://user:pass@bot.invalid/external/token','https://bot.invalid/other'])assert.equal((await h.admin('/api/external/settings','PUT',{token_audience:value})).status,400);
 await h.admin('/api/external/settings','PUT',{token_audience:h.audience});
 const password=testPassword();await h.admin('/api/users','POST',{username:'key-member',password,repository_ids:['101']});const member=h.managementClient();await member('/api/auth/login','POST',{username:'key-member',password});
 assert.equal((await member('/api/external/settings')).value.settings.token_audience,h.audience);assert.equal((await member('/api/external/settings','PUT',{token_audience:h.audience})).status,403);
 assert.equal((await member('/api/external/clients/'+foreign.client.id,'PATCH',{public_key:c.publicKey})).status,404);
 assert.equal((await member('/api/external/clients/'+c.client.id,'PATCH',{public_key:c.publicKey})).status,200);
});

test('the laptop helper signs without uploading its private key and requires private file permissions',async t=>{
 const h=await externalFixture(t),c=await h.client(),pem=c.privateKey.export({type:'pkcs8',format:'pem'});let sent;
 const grant=await exchangeToken(h.audience,c.client.id,pem,async(url,options)=>{assert.equal(url,h.audience);sent=options;assert.ok(!JSON.stringify(options).includes(pem));return fetch(h.webhook+'/external/token',options);});
 assert.ok(grant.token);assert.equal(grant.repository_id,'101');const payload=JSON.parse(Buffer.from(sent.headers.Authorization.split('.')[1],'base64url'));assert.equal(payload.jti,JSON.parse(sent.body).request_id);assert.equal(payload.exp-payload.iat,120);
 const proof=createAssertion(c.client.id,h.audience,c.privateKey);assert.ok(!proof.assertion.includes('PRIVATE KEY'));
 const filename=join(h.directory,'unsafe-client.pem');writeFileSync(filename,pem,{mode:0o644});const r=spawnSync(process.execPath,['scripts/external-token.mjs','--url',h.audience,'--client-id',c.client.id,'--key',filename],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/0600/);assert.ok(!r.stderr.includes(pem));
});

test('key or audience changes during upstream issuance prevent returning the token and revoke it',async t=>{
 const h=await externalFixture(t),c=await h.client(),replacement=await h.client();
 h.github.onMint(()=>h.admin('/api/external/clients/'+c.client.id,'PATCH',{public_key:replacement.publicKey}));
 const rotated=await h.exchange(c.client.id,c.privateKey);assert.equal(rotated.status,502);assert.equal(rotated.value.token,undefined);assert.ok([...h.github.tokens.values()].every(t=>t.revoked));
 h.github.onMint(()=>h.admin('/api/external/settings','PUT',{token_audience:'https://changed.invalid/external/token'}));
 const changed=await h.exchange(c.client.id,replacement.privateKey);assert.equal(changed.status,502);assert.equal(changed.value.token,undefined);assert.ok([...h.github.tokens.values()].every(t=>t.revoked));
 assert.ok(h.store.all('SELECT state FROM external_grants').every(g=>g.state==='failed'));
});
