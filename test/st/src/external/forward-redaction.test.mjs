import test from 'node:test';import assert from 'node:assert/strict';
import{createServer}from'node:http';import{once}from'node:events';
import{externalFixture}from'../../../fixtures/external-helpers.mjs';

const filters={events:['pull_request'],actions:['opened','ready_for_review','synchronize'],exclude_drafts:true};
async function subscription(h,client,url){const r=await h.admin('/api/external/subscriptions','POST',{client_id:client.id,name:'PR review',url,filters});assert.equal(r.status,201);return r.value;}

// #238 asks that no credential leaves the control plane in a delivery body. The console exit already drops a
// credential-named field; the outbound subscriber copy is the same accepted body leaving the server, so it carries the
// same rule: a key named token/secret/password/authorization/cookie/private_key (case-insensitive, at any depth) has its
// value replaced with [redacted], and every other field keeps the exact value that was accepted. Nothing is inferred
// from a value's shape, so a value that merely looks like a credential under another key is forwarded unchanged.
test('a forwarded delivery replaces credential-named fields and leaves every other field as accepted',async t=>{
 const h=await externalFixture(t),c=(await h.client()).client,received=[];
 const receiver=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;received.push(raw);res.writeHead(204);res.end();});receiver.listen(0,'127.0.0.1');await once(receiver,'listening');t.after(()=>new Promise(resolve=>receiver.close(resolve)));
 await subscription(h,c,'http://127.0.0.1:'+receiver.address().port+'/review');
 await h.hook(h.a.path,h.a.secret,'forward-redaction',{repository:{id:101},action:'opened',
   pull_request:{number:1,draft:false,head:{sha:'a'.repeat(40)},title:'keep this title'},
   token:'ghp_fixture_never_forwarded',AUTHORIZATION:'Bearer fixture-never-forwarded',
   nested:{secret:'fixture-nested-secret',keep:'visible value'},
   items:[{password:'fixture-array-password'},'plain item'],
   pasted:'ghp_fixture_shape_is_not_guessed'},{'X-GitHub-Event':'pull_request'});
 const row=h.store.get('SELECT * FROM external_deliveries');await h.external.forwarder.deliver(row);
 assert.equal(h.store.get('SELECT state FROM external_deliveries WHERE id=?',row.id).state,'succeeded');
 assert.equal(received.length,1);
 const body=JSON.parse(received[0]),payload=body.payload;
 assert.equal(body.event,'pull_request');
 assert.equal(payload.repository.id,101);
 assert.equal(payload.pull_request.title,'keep this title');
 assert.equal(payload.token,'[redacted]');
 assert.equal(payload.AUTHORIZATION,'[redacted]');
 assert.equal(payload.nested.secret,'[redacted]');
 assert.equal(payload.nested.keep,'visible value');
 assert.equal(payload.items[0].password,'[redacted]');
 assert.equal(payload.items[1],'plain item');
 assert.equal(payload.pasted,'ghp_fixture_shape_is_not_guessed');
 assert.ok(!received[0].includes('ghp_fixture_never_forwarded'));
 assert.ok(!received[0].includes('fixture-nested-secret'));
 assert.ok(!received[0].includes('fixture-array-password'));
 assert.ok(!received[0].includes('fixture-never-forwarded'));
});
