import test from 'node:test';import assert from 'node:assert/strict';import{generateKeyPairSync,randomBytes}from'node:crypto';import{readFileSync,statSync}from'node:fs';
import{harness,setup,account,repository,testPassword}from'./helpers.mjs';
import{Onboarding}from'../dist/onboarding/service.js';import{publicOrigin,deploymentOrigin}from'../dist/onboarding/public-url.js';import{RuleService,resolveRules,defaults,computerRequest}from'../dist/rules/service.js';

test('completion uses current installation and model records, rejects skipped setup and loses readiness after revocation',async t=>{
 let onboarding;const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store)})),{admin}=await setup(h);
 const finish=()=>admin('/api/onboarding/complete','POST',{}),view=async()=>(await admin('/api/onboarding')).value;
 assert.equal((await finish()).value.error,'onboarding_incomplete');assert.equal(onboarding.saved('complete'),null);
 const a=await account(admin,{type:'github_app',app_id:'123',token:undefined,private_key:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'})});
 const model=(await admin('/api/models','POST',{repository_id:null,api_url:'https://model.invalid/v1',model_name:'fixture',api_key:testPassword()})).value.model;
 onboarding.save('public',{origin:'https://hooks.invalid',checked_at:new Date().toISOString()});
 onboarding.save('app',{account_id:a.id,app_id:'123',slug:'fixture',installations:99});onboarding.save('model',model.id);
 // A historical count from GitHub is not proof that an installation is currently usable.
 assert.equal((await view()).readiness.installation,false);assert.equal((await finish()).status,409);
 h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,status,completeness,scope_pending,updated_at)
   VALUES('github.com/123/77','github.com','123','77',?,'active','complete',0,?)`,a.id,new Date().toISOString());
 await admin('/api/onboarding/installation','POST',{skip:true});assert.equal((await finish()).status,409);
 await admin('/api/onboarding/installation','POST',{skip:false});
 assert.equal((await view()).readiness.can_complete,true);assert.equal((await finish()).status,201);assert.equal((await view()).complete,true);
 for(const patch of ["status='suspended'","status='deleted'","completeness='stale'","scope_pending=1"]){
  h.store.run('UPDATE github_installations SET '+patch);assert.equal((await finish()).status,409);assert.equal((await view()).complete,false);
  h.store.run("UPDATE github_installations SET status='active',completeness='complete',scope_pending=0");
 }
 const sealed=h.store.get('SELECT api_key FROM models WHERE id=?',model.id).api_key;
 h.store.run('UPDATE models SET api_key=NULL WHERE id=?',model.id);assert.equal((await view()).readiness.model,false);assert.equal((await finish()).status,409);
 h.store.run('UPDATE models SET api_key=? WHERE id=?',sealed,model.id);assert.equal((await view()).readiness.can_complete,true);
 onboarding.save('app',{account_id:a.id,app_id:'999',installations:99});assert.equal((await view()).readiness.app,false);assert.equal((await finish()).status,409);
 assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='onboarding.completed'").n,1);
});

test('a public origin passes when this instance answers on it, console included, and fails for another instance, a forged proof or a redirect',async t=>{
 const other=await harness(t);let onboarding,h;
 // A fake network sends each host name to a real listener: this instance, another instance, a forger or a redirecting proxy.
 const routes={'same.invalid':()=>h.admin,'other.invalid':()=>other.admin};
 h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{probe:async raw=>{const url=new URL(raw);
   if(url.hostname==='redirect.invalid')return{status:302,body:''};
   if(url.hostname==='forged.invalid')return{status:200,body:JSON.stringify({proof:'0'.repeat(48)})};
   const r=await fetch(routes[url.hostname]()+url.pathname+url.search,{redirect:'manual'});return{status:r.status,body:await r.text()};}})}));const{admin}=await setup(h);
 for(const value of ['http://hooks.invalid','https://u:p@hooks.invalid','https://hooks.invalid/path','https://hooks.invalid?q=1'])assert.throws(()=>publicOrigin(value));
 // The same listener serves the console; the former rule that a public address must hide it is gone.
 for(const path of ['/','/app.js','/api/setup'])assert.equal((await fetch(h.admin+path)).status,200);
 assert.equal((await admin('/api/onboarding/address','POST',{origin:'https://same.invalid'})).status,201);
 for(const origin of ['https://other.invalid','https://forged.invalid','https://redirect.invalid']){const r=await admin('/api/onboarding/address','POST',{origin});assert.equal(r.status,400);assert.equal(r.value.error,'webhook_probe_failed');}
 assert.equal((await admin('/api/onboarding')).value.public_address.origin,'https://same.invalid');assert.throws(()=>onboarding.probe('not-issued'));
});
test('the address check never connects to loopback, private or link-local targets',async t=>{
 const h=await harness(t),{admin}=await setup(h);
 for(const origin of ['https://127.0.0.1','https://10.1.2.3','https://169.254.169.254']){const r=await admin('/api/onboarding/address','POST',{origin});assert.equal(r.status,400);assert.equal(r.value.error,'public_address_required');}
 assert.equal((await admin('/api/onboarding')).value.public_address,null);
});
test('BOT_PUBLIC_ORIGIN replaces BOT_ADMIN_ORIGIN, and a conflict or a malformed value stops startup',()=>{
 const warnings=[],resolve=env=>deploymentOrigin(env,message=>warnings.push(message));
 assert.equal(resolve({}),undefined);assert.equal(resolve({BOT_PUBLIC_ORIGIN:'',BOT_ADMIN_ORIGIN:' '}),undefined);
 assert.equal(resolve({BOT_PUBLIC_ORIGIN:'https://bot.invalid/'}),'https://bot.invalid');assert.deepEqual(warnings,[]);
 // The deprecated name still works and says so; the same value under both names is not a conflict.
 assert.equal(resolve({BOT_ADMIN_ORIGIN:'https://bot.invalid'}),'https://bot.invalid');assert.equal(warnings.length,1);assert.match(warnings[0],/BOT_PUBLIC_ORIGIN/);
 assert.equal(resolve({BOT_PUBLIC_ORIGIN:'https://bot.invalid',BOT_ADMIN_ORIGIN:'https://bot.invalid/'}),'https://bot.invalid');
 assert.throws(()=>resolve({BOT_PUBLIC_ORIGIN:'https://bot.invalid',BOT_ADMIN_ORIGIN:'https://console.invalid'}),/differ/);
 for(const value of ['http://lan.invalid','https://bot.invalid/path','https://u:p@bot.invalid','https://bot.invalid?q=1','not a url'])assert.throws(()=>resolve({BOT_PUBLIC_ORIGIN:value}),/BOT_PUBLIC_ORIGIN/);
 assert.throws(()=>resolve({BOT_ADMIN_ORIGIN:'http://192.168.1.5:8792'}),/BOT_ADMIN_ORIGIN/);
 for(const value of ['http://127.0.0.1:8791','http://localhost:8791'])assert.equal(resolve({BOT_PUBLIC_ORIGIN:value}),value);
});
test('manifest creates fixed permissions and events, converts once without a PAT, and never returns credentials',async t=>{
 const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}),secret=randomBytes(32).toString('hex');let onboarding,calls=[];
 const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({id:123,slug:'fixture-app',name:'Fixture',owner:{login:'fixture',type:'Organization'},html_url:'https://github.com/apps/fixture-app',pem,webhook_secret:secret,client_secret:'discard-this'}));}})}));const{admin}=await setup(h);
 assert.equal((await admin('/api/onboarding/manifest','POST',{organization:'fixture',name:'Fixture'})).status,409);onboarding.save('public',{origin:'https://hooks.invalid'});
 const prepared=(await admin('/api/onboarding/manifest','POST',{organization:'fixture',name:'Fixture'})).value;
 assert.deepEqual(prepared.manifest.default_events,['issues','pull_request','issue_comment','pull_request_review','pull_request_review_comment','organization']);assert.deepEqual(prepared.manifest.default_permissions,{contents:'write',issues:'write',pull_requests:'write',statuses:'write',actions:'write',checks:'write',metadata:'read',members:'read'});assert.equal(prepared.manifest.hook_attributes.active,true);assert.match(prepared.manifest.hook_attributes.url,/^https:\/\/hooks.invalid\/hooks\/github\//);
 // What GitHub keeps in the App lives on the verified entry; redirect_url only returns this browser once, to its console.
 assert.equal(prepared.manifest.url,'https://hooks.invalid');assert.equal(prepared.manifest.setup_url,'https://hooks.invalid/onboarding/github/setup');assert.equal(prepared.manifest.callback_urls,undefined);
 assert.equal(prepared.manifest.redirect_url,h.admin+'/onboarding/github/callback');
 assert.equal((await admin('/api/onboarding/manifest','POST',{organization:'fixture',name:'Fixture'},{Origin:'https://hooks.invalid'})).value.manifest.redirect_url,'https://hooks.invalid/onboarding/github/callback');
 const state=new URL(prepared.create_url).searchParams.get('state'),returned=await fetch(`${h.admin}/onboarding/github/callback?code=manifest-fixture-code&state=${state}`,{redirect:'manual'});
 assert.equal(returned.status,303);assert.equal(returned.headers.get('location'),'/#/settings/onboarding/2');
 // The App's owner gives the login step a direct link to its settings page.
 const app=(await admin('/api/onboarding')).value.app;assert.equal(app.owner,'fixture');assert.equal(app.owner_type,'Organization');assert.equal(app.settings_url,'https://github.com/organizations/fixture/settings/apps/fixture-app');await assert.rejects(onboarding.callback('manifest-fixture-code',state));assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Authorization,undefined);
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
test('legacy selected App metadata is refreshed in place without changing login, credentials, webhook or installation state',async t=>{
 const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}),secret=testPassword(),calls=[];
 let onboarding,owner={login:'fixture-org',type:'Organization'};
 const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async(url,options)=>{
  calls.push({url,method:options.method||'GET'});return new Response(JSON.stringify({id:123,slug:'fixture-app',owner,html_url:'https://github.com/apps/fixture-app',client_secret:secret,pem}));
 }})})),{admin}=await setup(h),a=await account(admin,{type:'github_app',app_id:'123',private_key:pem,token:undefined});
 const original={account_id:a.id,app_id:'123',slug:'fixture-app',installations:3,webhook_url:'https://hooks.invalid/existing',install_url:'https://github.com/apps/fixture-app/installations/new'};
 onboarding.save('app',original);onboarding.save('installation_skipped',true);
 await admin('/api/onboarding/github-login','PUT',{enabled:true,client_id:'Ov23.existing',client_secret:secret});
 const credentials=h.store.get('SELECT credentials FROM accounts WHERE id=?',a.id).credentials,login=h.store.get("SELECT value FROM settings WHERE key='identity.github_login'").value;
 assert.equal((await admin('/api/onboarding')).value.app.settings_url,undefined);assert.equal(calls.length,0);
 const refresh=()=>admin('/api/onboarding/app/refresh','POST',{account_id:a.id});
 let result=await refresh();assert.equal(result.status,201);
 assert.deepEqual(result.value.app,{...original,owner:'fixture-org',owner_type:'Organization',settings_url:'https://github.com/organizations/fixture-org/settings/apps/fixture-app'});
 assert.ok(!JSON.stringify(result.value).includes(secret)&&!JSON.stringify(result.value).includes(pem));
 owner={login:'fixture-user',type:'User'};result=await refresh();assert.equal(result.value.app.settings_url,'https://github.com/settings/apps/fixture-app');
 assert.equal((await admin('/api/onboarding')).value.app.owner,'fixture-user');assert.equal(onboarding.saved('installation_skipped'),true);
 assert.equal(h.store.get('SELECT credentials FROM accounts WHERE id=?',a.id).credentials,credentials);
 assert.equal(h.store.get("SELECT value FROM settings WHERE key='identity.github_login'").value,login);
 assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/app','/app']);assert.ok(calls.every(c=>c.method==='GET'));
 for(const invalid of [null,{id:999,slug:'wrong-app',owner},{id:123,slug:'fixture-app'},{id:123,slug:'fixture-app',owner:{login:'',type:'Organization'}}]){
  const before=onboarding.saved('app');onboarding.options.fetcher=async()=>new Response(JSON.stringify(invalid));
  assert.equal((await refresh()).value.error,'github_app_metadata_unavailable');assert.deepEqual(onboarding.saved('app'),before);
 }
 onboarding.options.fetcher=async()=>new Response('{}',{status:503});assert.equal((await refresh()).status,502);
 assert.equal((await refresh()).value.error,'github_app_metadata_unavailable');
 assert.equal((await admin('/api/onboarding/app/refresh','POST',{account_id:a.id,client_secret:secret})).status,400);
 await repository(admin,a.id,'101');const password=testPassword();
 assert.equal((await admin('/api/users','POST',{username:'member',password,organization_ids:['10']})).status,201);
 const member=h.client();assert.equal((await member('/api/auth/login','POST',{username:'member',password})).status,200);
 for(const client of [h.client(),member])assert.equal((await client('/api/onboarding/app/refresh','POST',{account_id:a.id})).status,client===member?403:401);
 assert.equal((await admin('/api/onboarding/app/refresh','POST',{account_id:a.id},{'X-CSRF-Token':''})).status,403);
 assert.equal((await admin('/api/onboarding/app/refresh','POST',{account_id:a.id},{Origin:'https://other.invalid'})).status,403);
});
test('a slow App metadata lookup preserves newer installation fields and cannot restore another tab\'s old App selection',async t=>{
 const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});let onboarding,release,started;
 const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async()=>{
  started();await new Promise(resolve=>{release=resolve;});return new Response(JSON.stringify({id:123,slug:'fixture-app',owner:{login:'fixture',type:'Organization'}}));
 }})})),{admin}=await setup(h),a=await account(admin,{type:'github_app',app_id:'123',private_key:pem,token:undefined});
 const original={account_id:a.id,app_id:'123',slug:'fixture-app',installations:0};onboarding.save('app',original);
 for(const changed of [{...original,installations:5,webhook_url:'https://new.invalid/hook'},{account_id:'another-app',app_id:'456',slug:'another-app'}]){
  const ready=new Promise(resolve=>{started=resolve;}),pending=admin('/api/onboarding/app/refresh','POST',{account_id:a.id});await ready;
  onboarding.save('app',changed);release();const result=await pending;
  if(changed.account_id===a.id){assert.equal(result.status,201);assert.equal(onboarding.saved('app').installations,5);assert.equal(onboarding.saved('app').webhook_url,changed.webhook_url);}
  else{assert.equal(result.status,409);assert.equal(result.value.error,'github_app_changed');assert.deepEqual(onboarding.saved('app'),changed);}
 }
 assert.equal((await admin('/api/onboarding/app/refresh','POST',{account_id:a.id})).status,409);
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
test('the built-in scenario rules are the docs/prompts files, and saved overrides still win',()=>{
 const names=['labels.md','issue-review.md','pr-review.md','issue-development.md'],plain=resolveRules({},{});
 for(const name of names){
  const text=readFileSync(new URL('../docs/prompts/'+name,import.meta.url),'utf8'),row=plain.files.find(r=>r.path==='.bot/rules/'+name);
  assert.equal(defaults['.bot/rules/'+name],text);assert.ok(Buffer.byteLength(text)<=16384);
  assert.deepEqual(row.layers.map(l=>l.source),['builtin']);assert.equal(row.effective,text);
 }
 assert.equal(plain.review_label,'bot-reviewed');assert.equal(plain.development_label,'bot-develop');
 // A development rule without the label line keeps the requirement with the built-in name.
 assert.equal(resolveRules({rule_overrides:JSON.stringify({'.bot/rules/issue-development.md':'Develop carefully.'})},{}).development_label,'bot-develop');
 assert.equal(resolveRules({},{'.bot/rules/issue-development.md':'development_label: "team go"\n'}).development_label,'team go');
 assert.throws(()=>resolveRules({},{'.bot/rules/issue-development.md':'development_label: '+'x'.repeat(51)}));
 // Only PR review forbids touching the working tree; the guide applies to development too. No organization is built in.
 assert.match(defaults['.bot/rules/pr-review.md'],/never modify the working tree while reviewing a PR/);assert.match(defaults['.bot/rules/pr-review.md'],/Review event is COMMENT only/);
 assert.doesNotMatch(defaults['.bot/guide.md']+defaults['.bot/rules/issue-development.md'],/modify the working tree/i);
 assert.doesNotMatch(names.map(name=>defaults['.bot/rules/'+name]).join('\n'),/PPMA|ScienceDiscovery|agent-CI-Infra/i);
 const layered=resolveRules({rule_overrides:JSON.stringify({'.bot/rules/issue-development.md':'Console development','.bot/rules/labels.md':'review_label: console-label'})},{'.bot/rules/pr-review.md':'Repository review'});
 const row=path=>layered.files.find(r=>r.path===path);
 assert.deepEqual(row('.bot/rules/issue-development.md').layers.map(l=>l.source),['builtin','console']);assert.equal(row('.bot/rules/issue-development.md').effective,'Console development');
 assert.equal(row('.bot/rules/pr-review.md').source,'repository');assert.equal(row('.bot/rules/pr-review.md').layers[0].content,defaults['.bot/rules/pr-review.md']);
 assert.equal(layered.review_label,'console-label');
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
test('a resource removed from .bot/computer.yaml after it was applied follows the global default again',async t=>{
 // The manager reports which resources follow the default (inherited); cpus is the project's own, set by an earlier file.
 const requests=[];let live={cpus:4,memory_mb:4096,pids:1024,tmp_mb:1024,egress:true,packages:[],inherited:['memory_mb','pids','tmp_mb']};
 const manager={call:async(method,path,body)=>{if(method==='POST'){requests.push(body.request);return{computer:live};}return{generation:1,computer:live};}};
 const h=await harness(t,manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const rules=new RuleService(h.store,manager);rules.rememberComputer('101',{...live,cpus:2,inherited:['cpus','memory_mb','pids','tmp_mb']});rules.cache('101','a'.repeat(40),{});
 assert.equal((await admin('/api/repositories/101/rules/apply-computer','POST',{})).status,201);
 assert.equal(requests.at(-1).cpus,null);assert.equal(requests.at(-1).memory_mb,undefined);
 // A file that still sets it keeps it; a computer whose resources all follow the default needs no change.
 assert.deepEqual(computerRequest({cpus:4,egress:true},live),null);
 assert.deepEqual(computerRequest({egress:true},{...live,cpus:2,inherited:['cpus','memory_mb','pids','tmp_mb']}),null);
 // A manager that does not say what is inherited is never asked to clear anything.
 assert.equal(computerRequest({egress:true},{cpus:4,egress:true}),null);
});
test('removing a repository computer override restores the saved console spec instead of treating the override as console input',async t=>{
 const computer={cpus:2,memory_mb:2048,packages:[]},manager={call:async()=>({computer})};const h=await harness(t,manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');const rules=new RuleService(h.store,manager);rules.rememberComputer('101',{cpus:2,memory_mb:4096,packages:[]});rules.cache('101','a'.repeat(40),{'.bot/computer.yaml':'memory_mb: 2048'});assert.equal((await rules.view('101')).computer.memory_mb,2048);rules.cache('101','b'.repeat(40),{});assert.equal((await rules.view('101')).computer.memory_mb,4096);
});
