import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {harness,setup,account,testPassword} from './helpers.mjs';
import {Onboarding} from '../dist/onboarding/service.js';
import {installationOrganization} from '../dist/onboarding/installation-target.js';

test('installation target accepts organization, repository, issue, PR, team and clone references without fetching them',()=>{
  for(const value of ['Fixture','@Fixture','Fixture/repo','https://github.com/Fixture','https://github.com/Fixture/repo.git','github.com/Fixture/repo',
    'https://www.github.com/Fixture/repo/tree/main/src?tab=readme#top','https://github.com/Fixture/repo/issues/1','https://github.com/Fixture/repo/pull/1',
    'https://github.com/orgs/Fixture/teams/reviewers','https://github.com/organizations/Fixture/settings','git@github.com:Fixture/repo.git','ssh://git@github.com/Fixture/repo.git'])assert.equal(installationOrganization('  '+value+'  '),'Fixture');
  for(const value of ['',null,{},'two words','https://github.com.evil.invalid/Fixture','https://evil.invalid/Fixture','https://github.com@evil.invalid/Fixture',
    'https://user:password@github.com/Fixture','https://github.com:9999/Fixture','https://github.com/%2Ffixture','https://github.com/%XX','https://github.com/','git@evil.invalid:Fixture/repo.git','javascript:alert(1)','-invalid','x'.repeat(40)])assert.throws(()=>installationOrganization(value),error=>error.code==='invalid_installation_target');
});

test('organization lookup produces a scoped GitHub installation link, handles existing installations and rejects invalid accounts',async t=>{
  let onboarding,installed=false,mismatch=false;const requests=[];
  const h=await harness(t,undefined,store=>({onboarding:onboarding=new Onboarding(store,{fetcher:async(raw,options)=>{
    const url=new URL(raw);requests.push({url,options});const send=(value,status=200)=>new Response(JSON.stringify(value),{status});
    if(url.pathname==='/users/personal')return send({id:20,login:'personal',type:'User'});
    if(url.pathname==='/users/missing')return send({},404);
    if(url.pathname==='/users/limited')return send({},403);
    if(url.pathname.startsWith('/users/'))return send({id:10,login:'fixture',type:'Organization'});
    if(url.pathname==='/orgs/fixture/installation')return installed?send({id:77,app_id:123,account:{id:mismatch?99:10}}):send({},404);
    return send({},404);
  }})})),{admin}=await setup(h);
  assert.equal((await admin('/api/onboarding/installation-target','POST',{target:'fixture'})).status,409);assert.equal(requests.length,0);
  const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}),a=await account(admin,{type:'github_app',app_id:'123',private_key:pem,token:undefined});
  const app={account_id:a.id,app_id:'123',slug:'fixture-app',installations:0};onboarding.save('app',app);
  const result=await admin('/api/onboarding/installation-target','POST',{target:'https://github.com/Fixture/private-repo/pull/1'});
  assert.equal(result.status,201);assert.deepEqual(result.value.organization,{id:'10',login:'fixture',html_url:'https://github.com/fixture'});assert.equal(result.value.installed,false);
  assert.equal(result.value.install_url,'https://github.com/apps/fixture-app/installations/new/permissions?suggested_target_id=10');
  assert.equal(requests[0].options.headers.Authorization,undefined);assert.match(requests[1].options.headers.Authorization,/^Bearer /);assert.ok(requests.every(r=>r.url.origin==='https://api.github.com'&&r.options.redirect==='error'));
  assert.deepEqual(onboarding.saved('app'),app);assert.equal(h.store.get('SELECT count(*) n FROM repositories').n,0);assert.ok(!JSON.stringify(result.value).includes(pem));
  installed=true;const existing=await admin('/api/onboarding/installation-target','POST',{target:'fixture'});assert.equal(existing.value.installed,true);assert.equal(existing.value.install_url,'https://github.com/organizations/fixture/settings/installations/77');
  mismatch=true;assert.equal((await admin('/api/onboarding/installation-target','POST',{target:'fixture'})).status,502);mismatch=false;
  for(const [target,status,code]of [['personal',400,'installation_target_not_organization'],['missing',404,'installation_target_not_found'],['limited',503,'installation_target_lookup_failed']]){
    const response=await admin('/api/onboarding/installation-target','POST',{target});assert.equal(response.status,status);assert.equal(response.value.error,code);
  }
  const count=requests.length;assert.equal((await admin('/api/onboarding/installation-target','POST',{target:'https://127.0.0.1/fixture'})).status,400);assert.equal(requests.length,count);
  const password=testPassword();await admin('/api/users','POST',{username:'member',password,repository_ids:[]});const member=h.client();await member('/api/auth/login','POST',{username:'member',password});assert.equal((await member('/api/onboarding/installation-target','POST',{target:'fixture'})).status,403);assert.equal(requests.length,count);
});
