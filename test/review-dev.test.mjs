import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,setup,account,repository } from './helpers.mjs';
import { inlineLocation,validateReview } from '../dist/review/findings.js';
import { Redactor } from '../dist/agent/common.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { GitHub } from '../dist/github/client.js';
import { Publisher } from '../dist/github/publisher.js';
import { generateKeyPairSync,createVerify,randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('review queue is atomic with archive and deduplicates logical events across deliveries',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true});
  const payload={repository:{id:101},action:'opened',issue:{number:1,title:'Fix the bug',body:'Fix the bug'}};
  h.store.db.exec("CREATE TRIGGER fail_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'injected enqueue failure'); END");
  assert.equal((await h.hook(a.path,a.secret,'queue-atomic',payload)).status,503);
  assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n,0);assert.equal(h.store.get('SELECT count(*) n FROM processed_deliveries').n,0);
  h.store.db.exec('DROP TRIGGER fail_task');
  assert.equal((await h.hook(a.path,a.secret,'queue-atomic',payload)).value.tasks_created,1);
  assert.equal((await h.hook(a.path,a.secret,'other-delivery',payload)).value.tasks_created,0);
  assert.equal((await h.hook(a.path,a.secret,'edit',{...payload,action:'edited'})).value.tasks_created,0);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,1);
  const pull={number:42,draft:true,state:'open',head:{sha:'a'.repeat(40)}};
  assert.equal((await h.hook(a.path,a.secret,'draft',{repository:{id:101},action:'opened',pull_request:pull},{'X-GitHub-Event':'pull_request'})).value.tasks_created,0);
  const opened={repository:{id:101},action:'ready_for_review',pull_request:{...pull,draft:false}};
  assert.equal((await h.hook(a.path,a.secret,'ready',opened,{'X-GitHub-Event':'pull_request'})).value.tasks_created,1);
  assert.equal((await h.hook(a.path,a.secret,'same-head',{...opened,action:'synchronize'},{'X-GitHub-Event':'pull_request'})).value.tasks_created,0);
  assert.equal((await h.hook(a.path,a.secret,'new-head',{...opened,action:'synchronize',pull_request:{...pull,draft:false,head:{sha:'b'.repeat(40)}}},{'X-GitHub-Event':'pull_request'})).value.tasks_created,1);
});
test('inline positions use real hunk lines and models cannot choose approval events',()=>{
  const files=[{filename:'a.js',patch:'@@ -10,2 +10,2 @@\n-old\n+new\n context'}];
  assert.deepEqual(inlineLocation({path:'a.js',line:10,side:'RIGHT'},files),{path:'a.js',line:10,side:'RIGHT'});
  assert.equal(inlineLocation({path:'a.js',line:999,side:'RIGHT'},files),null);
  assert.equal(inlineLocation({path:'missing',line:10,side:'RIGHT'},files),null);
  assert.equal(inlineLocation({path:'a.js',line:11,start_line:1,start_side:'RIGHT',side:'RIGHT'},files),null);
  assert.throws(()=>validateReview({summary:'x',findings:[],requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',event:'APPROVE'}),/model_review_invalid/);
});
test('recovery preserves terminal tasks and never treats a running container as a finished task',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  for(const [id,status,phase]of [['done','pr_opened','done'],['cancelled','cancelled','model'],['running','running','model']])h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,phase,next_run_at) VALUES(?,?,?,?,?,?,?)',id,'101','development.issue',status,id,phase,Date.now()+100000);
  const engine=new TaskEngine(h.store,{call:async()=>({state:'ready',generation:1})});engine.start();await engine.close();
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id='done'").status,'pr_opened');assert.equal(h.store.get("SELECT status FROM tasks WHERE id='cancelled'").status,'cancelled');assert.equal(h.store.get("SELECT status FROM tasks WHERE id='running'").status,'queued');
});
test('credential redaction covers structured model output including multiline secrets',()=>{
  const redactor=new Redactor();redactor.add('model-key-fixture');redactor.add('private\nkey\nfixture');
  const result=redactor.clean({a:'model-key-fixture',nested:[{body:'private\nkey\nfixture'}]});
  assert.equal(JSON.stringify(result),' {"a":"[REDACTED]","nested":[{"body":"[REDACTED]"}]}'.trim());
});
test('GitHub App tokens are signed in the control plane and restricted to the configured repository',async t=>{
  const h=await harness(t),{admin}=await setup(h),keys=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'});
  const a=await account(admin,{type:'github_app',app_id:'123',private_key:privateKey,token:undefined});await repository(admin,a.id,'101');
  const installationToken=randomBytes(24).toString('hex');let tokenRequest;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const b of req)raw+=b;const path=decodeURIComponent(new URL(req.url,'http://fake').pathname),authorization=req.headers.authorization?.slice(7);
    res.setHeader('Content-Type','application/json');
    if(path==='/app'||path.includes('/installation')||path.includes('/access_tokens')){
      const [head,payload,signature]=authorization.split('.');const verifier=createVerify('RSA-SHA256').update(head+'.'+payload);assert.ok(verifier.verify(keys.publicKey,Buffer.from(signature,'base64url')));
      const claims=JSON.parse(Buffer.from(payload,'base64url'));assert.equal(claims.iss,'123');assert.ok(claims.exp>claims.iat);
    }else assert.ok(authorization===installationToken);
    if(path==='/app')res.end(JSON.stringify({slug:'fixture-app'}));
    else if(path.endsWith('/installation'))res.end(JSON.stringify({id:7,account:{id:10},permissions:{contents:'write',issues:'write',pull_requests:'write'}}));
    else if(path.endsWith('/access_tokens')){tokenRequest=JSON.parse(raw);res.end(JSON.stringify({token:installationToken}));}
    else if(path.startsWith('/users/'))res.end(JSON.stringify({id:999}));
    else if(path==='/repositories/101')res.end(JSON.stringify({id:101,full_name:'fixture/project-101',owner:{id:10},default_branch:'trunk'}));
    else{res.statusCode=404;res.end('{}');}
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const redactor=new Redactor(),github=new GitHub(h.store,h.store.get("SELECT * FROM repositories WHERE id='101'"),redactor,async()=>{},'http://127.0.0.1:'+server.address().port);
  await github.connect(false);assert.deepEqual(tokenRequest.repository_ids,[101]);assert.equal(tokenRequest.permissions.contents,'read');assert.equal(github.actorId,'999');
  assert.equal(redactor.text(installationToken),'[REDACTED]');assert.equal(redactor.text(privateKey.trim()),'[REDACTED]');
});
test('review_label is an optional validated policy string',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  assert.equal((await admin('/api/repositories/101')).value.policy.review_label,'');
  for(const review_label of [' padded','x'.repeat(51),'tab\tlabel',7])assert.equal((await admin('/api/repositories/101/policy','PATCH',{review_label})).status,400);
  assert.equal((await admin('/api/repositories/101/policy','PATCH',{review_label:'bot-reviewed'})).value.policy.review_label,'bot-reviewed');
  assert.equal((await admin('/api/repositories/101/policy','PATCH',{review_enabled:true})).value.policy.review_label,'bot-reviewed');
  assert.equal((await admin('/api/repositories/101/policy','PATCH',{review_label:''})).value.policy.review_label,'');
});
test('reviews always publish one summary comment and the policy label is applied once',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha) VALUES('label-task','101','review.pr','publishing','pr',7,?)",'c'.repeat(40));
  const requests=[],comments=[],reviews=[];let labels=[],dropLabel=true;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const b of req)raw+=b;const path=new URL(req.url,'http://fake').pathname,body=raw?JSON.parse(raw):{};requests.push(req.method+' '+path);
    res.setHeader('Content-Type','application/json');
    if(path.endsWith('/issues/7/comments')){if(req.method==='POST'){const c={id:comments.length+1,body:body.body,user:{id:999}};comments.push(c);return res.end(JSON.stringify(c));}return res.end(JSON.stringify(comments));}
    if(path.endsWith('/pulls/7/reviews')){if(req.method==='POST'){const r={id:reviews.length+1,...body,user:{id:999}};reviews.push(r);return res.end(JSON.stringify(r));}return res.end(JSON.stringify(reviews));}
    if(path.endsWith('/comments'))return res.end('[]');
    if(path.endsWith('/issues/7/labels')){
      // The first POST is lost before GitHub applies it; an idempotent label may be sent again.
      if(req.method==='POST'){if(dropLabel){dropLabel=false;return req.socket.destroy();}labels=[...new Set([...labels,...body.labels])];}
      return res.end(JSON.stringify(labels.map(name=>({name}))));
    }
    res.statusCode=404;res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const github=new GitHub(h.store,h.store.get("SELECT * FROM repositories WHERE id='101'"),new Redactor(),async()=>{},'http://127.0.0.1:'+server.address().port);
  Object.assign(github,{token:'fixture-token',actorId:'999',fullName:'fixture/project-101'});
  const publisher=new Publisher(h.store,github,h.store.get("SELECT * FROM tasks WHERE id='label-task'"),async()=>{});
  const files=[{filename:'a.js',patch:'@@ -1 +1 @@\n-old\n+new'}];
  const result={summary:'Short summary.',reviewed_sha:'c'.repeat(40),coverage:['Snapshot'],findings:[{id:'f1',body:'Inline note',format:'inline',selection_reason:'On the changed line',path:'a.js',line:1,side:'RIGHT'}]};
  await publisher.review(result,files);await publisher.review(result,files);
  assert.equal(reviews.length,1);assert.equal(reviews[0].event,'COMMENT');
  assert.equal(comments.length,1);assert.ok(comments[0].body.startsWith('Short summary.'));
  await assert.rejects(publisher.label('bot-reviewed'),/github_response_unknown/);
  assert.deepEqual((await publisher.label('bot-reviewed')).map(l=>l.name),['bot-reviewed']);
  assert.deepEqual((await publisher.label('bot-reviewed')).map(l=>l.name),['bot-reviewed']);
  assert.equal(requests.filter(r=>r==='POST /repos/fixture/project-101/issues/7/labels').length,2);
  assert.equal(h.store.get("SELECT state FROM github_effects WHERE kind='label'").state,'sent');
});
