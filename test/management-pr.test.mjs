import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness,setup,account,repository } from './helpers.mjs';
import { command } from './management-fixture.mjs';
import { blobSha } from '../dist/agent/common.js';

test('configuration PR uses a scoped installation token, discloses pending merge and reconciles an unknown response exactly once',async t=>{
  const prs=[],branches=new Map([['main','a'.repeat(40)]]),writes=[],tokens=[];let drop=false;
  const gh=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture'),path=url.pathname;let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):{};
    const send=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    if(path==='/repos/agent-test-zone/admin-config/installation')return send({id:77,account:{id:10},permissions:{contents:'write',pull_requests:'write'}});
    if(path==='/app/installations/77/access_tokens'){tokens.push(body);return send({token:'fixture-installation-write-token',permissions:body.permissions});}
    if(path==='/repositories/101')return send({id:101,full_name:'agent-test-zone/admin-config',owner:{id:10},default_branch:'main'});
    if(path==='/installation/token'&&req.method==='DELETE')return send({});
    if(path.endsWith('/pulls')&&req.method==='GET')return send(prs);
    if(path.includes('/git/ref/heads/')){const branch=decodeURIComponent(path.split('/heads/')[1]);return branches.has(branch)?send({object:{sha:branches.get(branch)}}):send({},404);}
    if(path.endsWith('/git/refs')){branches.set(body.ref.slice(11),body.sha);writes.push({method:req.method,path,body});return send({object:{sha:body.sha}});}
    if(path.includes('/contents/')&&req.method==='GET')return send({sha:'b'.repeat(40),content:Buffer.from('Original prompt').toString('base64')});
    if(path.includes('/contents/')&&req.method==='PUT'){writes.push({method:req.method,path,body});return send({commit:{sha:'c'.repeat(40)},content:{sha:blobSha(Buffer.from(body.content,'base64'))}});}
    if(path.endsWith('/pulls')&&req.method==='POST'){
      assert.equal(req.headers.authorization,'Bearer fixture-installation-write-token');
      const pr={number:prs.length+1,html_url:'https://github.com/agent-test-zone/admin-config/pull/'+(prs.length+1),head:{ref:body.head},body:body.body};prs.push(pr);writes.push({method:req.method,path,body});
      if(drop){req.socket.destroy();return;}return send(pr,201);
    }
    send({},404);
  });
  gh.listen(0,'127.0.0.1');await once(gh,'listening');t.after(()=>new Promise(r=>{gh.close(r);gh.closeAllConnections();}));
  const h=await harness(t,undefined,{githubUrl:`http://127.0.0.1:${gh.address().port}`}),{admin}=await setup(h);
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const a=await account(admin,{type:'github_app',token:undefined,app_id:'123',private_key:privateKey});await repository(admin,a.id,'101');h.store.run("UPDATE repositories SET full_name='agent-test-zone/admin-config' WHERE id='101'");
  h.store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)','101','a'.repeat(40),JSON.stringify({'.bot/rules/issue-review.md':'Original prompt'}),'now');
  const target={project_id:'101'},args={path:'.bot/rules/issue-review.md',content:'Revised prompt'};
  const created=await command(admin,'configuration.pr',target,args,'first-pr');assert.equal(created.value.state,'succeeded');assert.equal(created.value.result.state,'pending_merge');assert.equal(created.value.result.effective,false);assert.equal(prs.length,1);
  assert.deepEqual(tokens[0].repository_ids,[101]);assert.deepEqual(tokens[0].permissions,{contents:'write',pull_requests:'write'});
  assert.deepEqual((await command(admin,'configuration.pr',target,args,'first-pr',created.value.expected_revision)).value,created.value);assert.equal(prs.length,1);
  drop=true;
  const unknown=await command(admin,'configuration.pr',target,args,'unknown-pr');assert.equal(unknown.value.state,'unknown');assert.equal(prs.length,2);
  const reconciled=await admin('/api/management/commands/'+unknown.value.id+'/resume','POST',{});assert.equal(reconciled.value.state,'succeeded');assert.equal(reconciled.value.result.pr_number,2);assert.equal(prs.length,2);assert.equal(writes.filter(w=>w.path.endsWith('/pulls')).length,2);
  const unsafe=await command(admin,'configuration.pr',target,{path:'.github/workflows/injected.yml',content:'unsafe'},'unsafe');assert.notEqual(unsafe.value.state,'succeeded');assert.equal(prs.length,2);
});
