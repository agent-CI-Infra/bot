import test from 'node:test';import assert from 'node:assert/strict';import{generateKeyPairSync,randomBytes}from'node:crypto';import{readFileSync,statSync}from'node:fs';
import{harness,setup,account,repository,testPassword}from'./helpers.mjs';
import{Onboarding}from'../dist/onboarding/service.js';import{publicOrigin}from'../dist/onboarding/public-url.js';import{RuleService,resolveRules,defaults}from'../dist/rules/service.js';

test('a public origin must prove this webhook listener and cannot expose the console or redirect',async t=>{
 let onboarding,mode='webhook';const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{probe:async raw=>{const url=new URL(raw);if(url.pathname.includes('probe'))return{status:mode==='redirect'?302:200,body:JSON.stringify(onboarding.probe(url.searchParams.get('nonce'),mode==='console'?'admin':'webhook'))};return{status:mode==='split'&&url.pathname==='/api/setup'?200:404,body:'{}'};}})}));const{admin}=await setup(h);
 for(const value of ['http://hooks.invalid','https://u:p@hooks.invalid','https://hooks.invalid/path','https://hooks.invalid?q=1'])assert.throws(()=>publicOrigin(value));
 assert.equal((await admin('/api/onboarding/address','POST',{origin:'https://hooks.invalid'})).status,201);
 for(mode of ['console','split','redirect'])assert.equal((await admin('/api/onboarding/address','POST',{origin:'https://other.invalid'})).status,400);
 assert.equal((await admin('/api/onboarding')).value.public_address.origin,'https://hooks.invalid');assert.throws(()=>onboarding.probe('not-issued','webhook'));
});
test('manifest creates fixed permissions and events, converts once without a PAT, and never returns credentials',async t=>{
 const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}),secret=randomBytes(32).toString('hex');let onboarding,calls=[];
 const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({id:123,slug:'fixture-app',name:'Fixture',pem,webhook_secret:secret,client_secret:'discard-this'}));}})}));const{admin}=await setup(h);
 assert.equal((await admin('/api/onboarding/manifest','POST',{organization:'fixture',name:'Fixture'})).status,409);onboarding.save('public',{origin:'https://hooks.invalid'});
 const prepared=(await admin('/api/onboarding/manifest','POST',{organization:'fixture',name:'Fixture'})).value;
 assert.deepEqual(prepared.manifest.default_events,['issues','pull_request']);assert.deepEqual(prepared.manifest.default_permissions,{contents:'write',issues:'write',pull_requests:'write',metadata:'read'});assert.equal(prepared.manifest.hook_attributes.active,true);assert.match(prepared.manifest.hook_attributes.url,/^https:\/\/hooks.invalid\/hooks\/github\//);
 const state=new URL(prepared.create_url).searchParams.get('state');await onboarding.callback('manifest-fixture-code',state);await assert.rejects(onboarding.callback('manifest-fixture-code',state));assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Authorization,undefined);
 const view=JSON.stringify((await admin('/api/accounts')).value);assert.ok(!view.includes(secret)&&!view.includes(pem));assert.ok(!JSON.stringify((await admin('/api/onboarding')).value).includes(secret));assert.ok(!JSON.stringify(h.store.all('SELECT * FROM accounts')).includes(pem));
});
test('tunnel token is private and write-only; skip installation does not enable review; project admins cannot change onboarding',async t=>{
 let onboarding;const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{tunnelFile:store===null?'':undefined})}));onboarding.options.tunnelFile=h.directory+'/tunnel/token';const{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const token=Buffer.from(JSON.stringify({a:'fixture-account',t:'fixture-tunnel',s:randomBytes(32).toString('hex')})).toString('base64');assert.equal((await admin('/api/onboarding/tunnel','POST',{token})).status,201);assert.equal(readFileSync(onboarding.options.tunnelFile,'utf8'),token);assert.equal(statSync(onboarding.options.tunnelFile).mode&0o777,0o600);
 assert.ok(!JSON.stringify((await admin('/api/onboarding')).value).includes(token));assert.ok(!h.store.get("SELECT value FROM settings WHERE key='onboarding.tunnel'").value.includes(token));
 assert.equal((await admin('/api/onboarding/installation','POST',{skip:true})).status,201);assert.equal(h.store.get("SELECT review_enabled FROM policies WHERE repository_id='101'").review_enabled,0);
 const password=testPassword();await admin('/api/users','POST',{username:'member',password,repository_ids:['101']});const member=h.client();await member('/api/auth/login','POST',{username:'member',password});assert.equal((await member('/api/onboarding')).status,403);
 await admin('/api/onboarding/tunnel','POST',{revoke:true});assert.equal((await admin('/api/onboarding')).value.tunnel.token_configured,false);
});
test('rules show per-file precedence and skills; computer overlays the existing manager spec',()=>{
 const policy={rule_overrides:JSON.stringify({'.bot/guide.md':'Console guide','.bot/rules/labels.md':'review_label: "console-label"'})};
 const result=resolveRules(policy,{'.bot/guide.md':'Repository guide','.bot/rules/pr-review.md':'Repository PR rule','.bot/computer.yaml':'memory_mb: 2048\npackages: [jq]','.agents/skills/review/SKILL.md':'Repository skill'},{cpus:2,memory_mb:4096,packages:[],max_command_minutes:60});
 // max_command_minutes was removed: an old console spec or repository file that still sets it is ignored rather than rejected.
 assert.equal(result.computer.max_command_minutes,undefined);
 assert.deepEqual(resolveRules(policy,{'.bot/computer.yaml':'cpus: 1\nmax_command_minutes: 15'}).computer,{cpus:1});
 const guide=result.files.find(row=>row.path==='.bot/guide.md');assert.deepEqual(guide.layers.map(l=>l.source),['builtin','console','repository']);assert.equal(guide.effective,'Repository guide');assert.equal(result.files.find(row=>row.path==='.bot/rules/pr-review.md').effective,'Repository PR rule');assert.equal(result.review_label,'console-label');assert.equal(result.computer.memory_mb,2048);assert.equal(result.computer.cpus,2);assert.equal(result.files.at(-1).path,'.agents/skills/review/SKILL.md');
 assert.throws(()=>resolveRules(policy,{'.bot/computer.yaml':'docker_socket: /var/run/docker.sock'}));
});
test('rule editing and effective configuration APIs preserve repository administrator scope',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');const rules=new RuleService(h.store);rules.cache('101','a'.repeat(40),{'.bot/guide.md':'Repository behavior'});
 const password=testPassword();await admin('/api/users','POST',{username:'member',password,repository_ids:['101']});const member=h.client();await member('/api/auth/login','POST',{username:'member',password});
 assert.equal((await member('/api/repositories/101/rules','PUT',{path:'.bot/guide.md',content:'Console change'})).status,200);assert.equal((await member('/api/repositories/101/rules')).value.rules.files[0].effective,'Repository behavior');assert.equal((await member('/api/repositories/202/rules')).status,403);assert.equal((await member('/api/repositories/101/rules','PUT',{path:'constructor',content:'bad'})).status,400);assert.equal((await member('/api/repositories/101/rules/apply-computer','POST',{})).status,403);
  // The label is declared only in .bot/rules/labels.md; a console file without a review_label line turns labeling off.
  assert.equal((await member('/api/repositories/101/rules')).value.rules.review_label,'bot-reviewed');assert.equal((await member('/api/repositories/101/policy','PATCH',{review_label:''})).status,400);
  await member('/api/repositories/101/rules','PUT',{path:'.bot/rules/labels.md',content:'Do not label reviews.'});assert.equal((await member('/api/repositories/101/rules')).value.rules.review_label,'');
});
test('review guidance and the label saved as policy fields by earlier versions move into the rule files once',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 h.store.run("UPDATE policies SET review_instructions='Focus on API compatibility.',review_label='legacy-label',rule_overrides=? WHERE repository_id='101'",JSON.stringify({'.bot/rules/pr-review.md':'Explicit PR rule'}));
 new RuleService(h.store);new RuleService(h.store);
 const {rules}=(await admin('/api/repositories/101/rules')).value,file=path=>rules.files.find(f=>f.path===path);
 assert.equal(file('.bot/rules/issue-review.md').effective,defaults['.bot/rules/issue-review.md']+'\n\nFocus on API compatibility.');
 assert.equal(file('.bot/rules/pr-review.md').effective,'Explicit PR rule');assert.equal(rules.review_label,'legacy-label');
 const policy=h.store.get("SELECT * FROM policies WHERE repository_id='101'");assert.deepEqual([policy.review_instructions,policy.review_label],['','']);
 assert.equal(Object.keys(JSON.parse(policy.rule_overrides)).length,3);
});
test('removing a repository computer override restores the saved console spec instead of treating the override as console input',async t=>{
 const computer={cpus:2,memory_mb:2048,packages:[]},manager={call:async()=>({computer})};const h=await harness(t,manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');const rules=new RuleService(h.store,manager);rules.rememberComputer('101',{cpus:2,memory_mb:4096,packages:[]});rules.cache('101','a'.repeat(40),{'.bot/computer.yaml':'memory_mb: 2048'});assert.equal((await rules.view('101')).computer.memory_mb,2048);rules.cache('101','b'.repeat(40),{});assert.equal((await rules.view('101')).computer.memory_mb,4096);
});
