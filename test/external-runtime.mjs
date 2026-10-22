import assert from 'node:assert/strict';import{createServer}from'node:http';import{once}from'node:events';import{symlinkSync,mkdirSync}from'node:fs';
import{externalFixture}from'./external-helpers.mjs';import{verifySignature}from'../dist/core/security.js';
process.chdir('/data');mkdirSync('.tmp',{recursive:true});symlinkSync('/app/static','static');
const h=await externalFixture(),seen=new Set();let delivered=0,signedSecret,created;
const receiver=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;assert.ok(verifySignature(Buffer.from(raw),signedSecret,req.headers['x-bot-signature-256']));const event=JSON.parse(raw);
 if(!seen.has(event.id)){const grant=await h.exchange(created.client.id,created.client_secret,{request_id:event.id});assert.equal(grant.status,200);const reply=await fetch(h.github.url+'/repos/fixture/project-101/issues/1/comments',{method:'POST',headers:{Authorization:'Bearer '+grant.value.token,'Content-Type':'application/json'},body:JSON.stringify({body:'External review completed'})});assert.equal(reply.status,201);seen.add(event.id);delivered++;}
 res.writeHead(204);res.end();}catch{res.writeHead(500);res.end();}});
receiver.listen(0,'127.0.0.1');await once(receiver,'listening');
try{
 created=await h.client();const sub=await h.admin('/api/external/subscriptions','POST',{name:'Container receiver',client_id:created.client.id,url:'http://127.0.0.1:'+receiver.address().port+'/',filters:{events:['pull_request'],actions:['opened'],exclude_drafts:true}});assert.equal(sub.status,201);signedSecret=sub.value.signing_secret;
 const payload={repository:{id:101},action:'opened',pull_request:{number:1,draft:false,head:{sha:'a'.repeat(40)}}};
 h.external.forwarder.start();const result=await h.hook(h.a.path,h.a.secret,'runtime-flow',payload,{'X-GitHub-Event':'pull_request'});assert.equal(result.value.forwards_created,1);
 const end=Date.now()+15000;while(h.store.get('SELECT state FROM external_deliveries')?.state!=='succeeded'&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(h.store.get('SELECT state FROM external_deliveries').state,'succeeded');assert.equal(delivered,1);assert.equal(h.github.comments[0].user.login,'fixture-app[bot]');
 const duplicate=await h.hook(h.a.path,h.a.secret,'runtime-flow',payload,{'X-GitHub-Event':'pull_request'});assert.equal(duplicate.value.duplicate,true);assert.equal(h.store.get('SELECT count(*) n FROM external_deliveries').n,1);
 assert.equal((await h.exchange(created.client.id,'incorrect')).status,401);assert.equal(h.github.grants.length,1);
 console.log('PASS Docker image: signed event -> external receiver -> scoped token -> bot-authored comment; duplicate and invalid authentication blocked');
}finally{await h.stop();await new Promise(resolve=>receiver.close(resolve));await new Promise(resolve=>h.github.server.close(resolve));}
