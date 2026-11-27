import test from 'node:test';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {once} from 'node:events';
import ssh2 from 'ssh2';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { configuredRedactor } from '../../../../dist/core/redaction.js';
import { ResultSession, commandResult } from '../../../../dist/agent/tool-results.js';

test('SSH inventory seals credentials, scopes global bindings, pins updates, and redacts paginated output', async t => {
  const h = await harness(t), {admin} = await setup(h), acc = await account(admin);
  for (const id of ['101','202']) await repository(admin,acc.id,id);
  const pool = '/api/ssh-targets', project = '/api/repositories/101/ssh-targets';
  const spec = {alias:'board',host:'board.invalid',username:'tester',host_key_sha256:'SHA256:'+'A'.repeat(43),
    auth:'password',password:'p!4z',allowed_roles:['qa']};
  // A one-to-three character password would be redacted out of ordinary text: four is the minimum (short is fine).
  assert.equal((await admin(pool,'POST',{...spec,password:'p!4'})).status,400);
  const created = await admin(pool,'POST',spec);
  assert.equal(created.status,201);
  const id = created.value.id, binding = project+'/'+id+'/binding';
  const poolBefore = (await admin(pool)).value.targets;
  assert.equal(poolBefore.length,1);
  assert.deepEqual(poolBefore[0].bound_projects,[]);
  assert.deepEqual((await admin(project)).value.targets,[]);
  assert.equal((await admin(binding,'PUT',{})).status,200);
  assert.deepEqual((await admin(pool)).value.targets[0].bound_projects,[{id:'101',full_name:'fixture/project-101'}]);
  assert.equal((await admin('/api/repositories/202/ssh-targets/'+id+'/binding','PUT',{})).status,200);
  assert.deepEqual((await admin(pool)).value.targets[0].bound_projects,[
    {id:'101',full_name:'fixture/project-101'},
    {id:'202',full_name:'fixture/project-202'},
  ]);
  assert.equal((await admin('/api/repositories/202/ssh-targets/'+id+'/binding','DELETE',{})).status,200);
  assert.deepEqual((await admin(pool)).value.targets[0].bound_projects,[{id:'101',full_name:'fixture/project-101'}]);
  const dump = (await admin(project)).value.targets;
  assert.deepEqual(dump.map(row=>[row.alias,row.allow_untrusted_pr]),[['board',false]]);
  for (const field of ['password','private_key','sealed','bound_projects']) assert.ok(!Object.hasOwn(dump[0],field));
  assert.deepEqual((await admin('/api/repositories/202/ssh-targets')).value.targets,[]);
  const sealed = h.store.get('SELECT sealed FROM ssh_targets WHERE id=?',id).sealed;
  assert.deepEqual(h.store.secrets.open(sealed,'ssh-target:'+id),{password:spec.password});
  assert.throws(()=>h.store.secrets.open(sealed,'ssh-target:another'));
  assert.equal((await admin(pool+'/'+id,'PUT',{host:'elsewhere.invalid'})).status,400);
  assert.equal((await admin(project,'POST',spec)).status,409);
  assert.equal((await admin(project,'POST',{...spec,alias:'bad-jump',route:'proxy_jump',jump_id:'unknown'})).status,400);
  const jump = await admin(project,'POST',{...spec,alias:'behind',route:'proxy_jump',jump_id:id});
  assert.equal(jump.status,201);
  assert.equal((await admin(pool+'/'+id,'DELETE',{})).status,409);
  const projectUser = h.client();
  await admin('/api/users','POST',{username:'padmin',password:'project-admin-password-123',role:'project_admin',repository_ids:['101']});
  await projectUser('/api/auth/login','POST',{username:'padmin',password:'project-admin-password-123'});
  assert.equal((await projectUser(project)).status,200);
  assert.equal((await projectUser(pool)).status,403);
  assert.equal((await projectUser('/api/repositories/202/ssh-targets')).status,403);
  assert.equal((await projectUser(binding,'DELETE',{})).status,403);
  assert.equal(configuredRedactor(h.store,'101').text('got p!4z'),'got [REDACTED]');
  assert.equal(configuredRedactor(h.store,'202').text('got p!4z'),'got p!4z');
  const scope = h.store.trajectories.scopeOf({id:'turn',repository_id:'101',conversation_id:'chat'});
  const session = new ResultSession(h.store,scope,()=>'owner',()=>{});
  const parts = ['got p','!','4z.'];
  let offset = 0;
  const ref = await commandResult({output:'got p!4z.',truncated:true,output_file:'journal'},'command',async pos=>{
    assert.equal(pos,offset);
    const part = parts.shift(); offset += Buffer.byteLength(part);
    return {data:part,offset,size:9};
  },session);
  assert.equal(ref.output,'got [REDACTED].');
  assert.equal((await session.read({file:ref.file})).content,ref.output);
  assert.equal((await admin(project+'/'+jump.value.id,'DELETE',{})).status,200);
  assert.equal((await admin(binding,'DELETE',{})).status,200);
  assert.deepEqual((await admin(pool)).value.targets[0].bound_projects,[]);
  assert.deepEqual((await admin(project)).value.targets,[]);
  assert.equal((await admin(pool+'/'+id,'DELETE',{})).status,200);
  assert.ok(!JSON.stringify(h.store.all("SELECT * FROM audit WHERE action LIKE 'ssh_target.%'")).includes(spec.password));
});

test('console authentication checks verify the registered host and credential, then close without a session', async t => {
  const h = await harness(t), {admin} = await setup(h), acc = await account(admin);
  await repository(admin,acc.id,'101');
  const makeKey = () => generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs1'});
  const hostKey = makeKey(), userKey = makeKey(), verifier = ssh2.utils.parseKey(userKey);
  let sessions = 0;
  const auth = [];
  const server = new ssh2.Server({hostKeys:[hostKey]},client => {
    client.on('error',()=>{});
    client.on('authentication',ctx=>{
      auth.push(ctx.method);
      if (ctx.username === 'tester') {
        if (ctx.method === 'password' && ctx.password === 'p!4z') return ctx.accept();
        if (ctx.method === 'publickey' && ctx.key.data.equals(verifier.getPublicSSH()) &&
            (!ctx.signature || verifier.verify(ctx.blob,ctx.signature,ctx.hashAlgo) === true)) return ctx.accept();
      }
      ctx.reject();
    });
    client.on('session',(_accept,reject)=>{sessions++;reject();});
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const pool='/api/ssh-targets', projects='/api/repositories/101/ssh-targets';
  const config={alias:'probe',username:'tester',auth:'password',password:'p!4z',host:'127.0.0.1',port:server.address().port,
    host_key_sha256:'SHA256:'+createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/,'')};
  const {id}=(await admin(pool,'POST',config)).value;
  const probe = async (path,body={})=>(await admin(path+'/'+id+'/test','POST',body)).value;
  assert.equal((await probe(projects)).error,'ssh_target_not_found');
  await admin(projects+'/'+id+'/binding','PUT',{});
  assert.equal((await probe(projects,{host:'unregistered.invalid'})).error,'unknown_field');
  assert.deepEqual(await probe(projects),{ok:true});
  assert.deepEqual(auth,['password']);
  const change=async body=>assert.equal((await admin(pool+'/'+id,'PUT',body)).status,200);
  await change({password:'invalid'});
  assert.deepEqual(await probe(pool),{ok:false,error:'ssh_auth_failed'});
  const count=auth.length;
  await change({host_key_sha256:'SHA256:'+'A'.repeat(43), password:'p!4z'});
  assert.deepEqual(await probe(pool),{ok:false,error:'ssh_host_key_mismatch'});
  assert.equal(auth.length,count);
  await change({host_key_sha256:config.host_key_sha256,auth:'key',private_key:userKey});
  assert.deepEqual(await probe(pool),{ok:true});
  assert.equal(auth.at(-1),'publickey');
  assert.equal(sessions,0);
  const audit=h.store.all("SELECT action,resource_id FROM audit WHERE action LIKE 'ssh_target.test.%'");
  assert.ok(audit.every(row=>row.resource_id===id));
  assert.ok(audit.some(row=>row.action==='ssh_target.test.ssh_host_key_mismatch'));
});
