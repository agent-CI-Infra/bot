import test from 'node:test';
import assert from 'node:assert/strict';
import { harness,setup,account,repository } from './helpers.mjs';
import { inlineLocation,validateReview } from '../dist/review/findings.js';
import { Redactor } from '../dist/agent/common.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { developmentReady, enqueue, queueWebhook } from '../dist/review/queue.js';
import { emptyRepositoryFixture } from './empty-repository-helpers.mjs';
import { classificationLabels, repositoryLabels } from '../dist/review/labels.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { GitHub } from '../dist/github/client.js';
import { Publisher } from '../dist/github/publisher.js';
import { generateKeyPairSync,createVerify,randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

function mentionNames(t,value) {
  const previous=process.env.BOT_MENTION_NAMES;
  t.after(()=>{if(previous===undefined)delete process.env.BOT_MENTION_NAMES;else process.env.BOT_MENTION_NAMES=previous;});
  if(value===undefined)delete process.env.BOT_MENTION_NAMES;else process.env.BOT_MENTION_NAMES=value;
}

test('Issue comment mentions queue independently of opened events and deduplicate comments and deliveries',async t=>{
  mentionNames(t,undefined);
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,development_enabled:true});
  const issue={number:1,state:'open',title:'Fix the bug',body:'Fix the bug',labels:[{name:'bot-develop'}],assignees:[]};
  const opened={repository:{id:101},action:'opened',issue};
  assert.equal((await h.hook(a.path,a.secret,'opened',opened)).value.tasks_created,1);
  const comment={id:123,body:'@bot please review this change.',html_url:'https://github.invalid/issue/1#issuecomment-123'};
  const payload={repository:{id:101},action:'created',sender:{type:'User'},issue,comment};
  const send=(delivery,value=payload,event='issue_comment')=>h.hook(a.path,a.secret,delivery,value,{'X-GitHub-Event':event});
  assert.equal((await send('comment')).value.tasks_created,1);
  const task=h.store.get("SELECT * FROM tasks WHERE unique_key='101:review.issue:1:comment:123'");
  assert.equal(task.kind,'review.issue');assert.equal(task.head_sha,null);assert.deepEqual(JSON.parse(task.input).comment,comment);
  const replay=(await send('comment')).value;assert.equal(replay.duplicate,true);assert.equal(replay.tasks_created,0);
  assert.equal((await send('same-comment-new-delivery')).value.tasks_created,0);
  assert.equal((await send('another-comment',{...payload,comment:{...comment,id:124,body:'Please, @Agent-CI-Infra-Bot!'}})).value.tasks_created,1);
  assert.ok(h.store.get("SELECT id FROM tasks WHERE unique_key='101:review.issue:1:comment:124'"));
  assert.ok(h.store.get("SELECT id FROM tasks WHERE unique_key='101:review.issue:1:opened'"));
  assert.equal((await h.hook(a.path,a.secret,'opened-again',opened)).value.tasks_created,0);
  for(const [index,body] of ['No mention here','user@bot','1@bot','@bot-extra','@bot2','@botany','@agent-ci-infra-bot-extra'].entries())
    assert.equal((await send('text-'+index,{...payload,comment:{...comment,id:200+index,body}})).value.tasks_created,0,body);
  for(const [index,change] of [{sender:{type:'Bot'}},{issue:{...issue,state:'closed'}},{action:'edited'},{action:'deleted'},{action:'reopened'},
    {comment:{...comment,id:'invalid'}},{comment:{...comment,id:0}},{comment:{...comment,id:Number.MAX_SAFE_INTEGER+1}}].entries())
    assert.equal((await send('ignored-'+index,{...payload,...change})).value.tasks_created,0);
  for(const event of ['pull_request_review','pull_request_review_comment'])assert.equal((await send(event,payload,event)).value.tasks_created,0);
  await admin('/api/repositories/101/policy','PATCH',{review_issues:false});assert.equal((await send('issue-disabled')).value.tasks_created,0);
  assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.issue'").n,0);
  // Comment deliveries do not start an external event's 24-hour authorization window.
  assert.equal(h.store.get('SELECT count(*) n FROM external_events').n,2);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,3);
});

test('mention configuration can disable comments or replace default names, with literal case-insensitive boundaries',async t=>{
  mentionNames(t,'off');
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true});
  let id=300;const send=body=>h.hook(a.path,a.secret,'config-'+(++id),{repository:{id:101},action:'created',sender:{type:'User'},
    issue:{number:3,state:'open'},comment:{id,body}},{'X-GitHub-Event':'issue_comment'});
  for(const off of ['off',' OFF ']){process.env.BOT_MENTION_NAMES=off;assert.equal((await send('@bot @agent-ci-infra-bot')).value.tasks_created,0);}
  process.env.BOT_MENTION_NAMES='  Custom-Reviewer , Robot.v2 , ';
  for(const body of ['@bot','@agent-ci-infra-bot','@custom-reviewer-extra','mail@custom-reviewer','@robotXv2'])assert.equal((await send(body)).value.tasks_created,0,body);
  for(const body of ['@CUSTOM-reviewer please','(@Robot.v2)','_@custom-reviewer','-@custom-reviewer'])assert.equal((await send(body)).value.tasks_created,1,body);
  process.env.BOT_MENTION_NAMES='';assert.equal((await send('@bot')).value.tasks_created,0);
});

test('PR conversation mentions read the current head with read-only permissions, without looking up users',async t=>{
  mentionNames(t,undefined);
  const requests=[],tokens=[];let pull={number:7,state:'open',draft:false,head:{sha:'b'.repeat(40)}},failRead=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const path=new URL(req.url,'http://fixture').pathname;requests.push(req.method+' '+path);res.setHeader('Content-Type','application/json');
    if(path.endsWith('/installation'))return res.end(JSON.stringify({id:9,account:{id:10},permissions:{pull_requests:'write',contents:'write',workflows:'write',administration:'write'}}));
    if(path.endsWith('/access_tokens')){tokens.push(JSON.parse(raw));return res.end(JSON.stringify({token:'comment-read-token'}));}
    if(path==='/repositories/101')return res.end(JSON.stringify({id:101,owner:{id:10},full_name:'fixture/project-101',default_branch:'main'}));
    if(path.endsWith('/pulls/7')){res.statusCode=failRead?500:200;return res.end(JSON.stringify(failRead?{message:'Unavailable'}:pull));}
    res.statusCode=404;res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const h=await harness(t,undefined,{githubUrl:'http://127.0.0.1:'+server.address().port}),{admin}=await setup(h);
  const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const a=await account(admin,{type:'github_app',app_id:'1',private_key:pem,token:undefined});await repository(admin,a.id,'101');
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true});
  const payload={repository:{id:101},action:'created',sender:{type:'User'},issue:{number:7,state:'open',pull_request:{url:'https://api.github.invalid/repos/fixture/project-101/pulls/7'}},
    comment:{id:400,body:'@Agent-CI-Infra-Bot please recheck',html_url:'https://github.invalid/issue/7#issuecomment-400'}};
  const send=(delivery,value=payload)=>h.hook(a.path,a.secret,delivery,value,{'X-GitHub-Event':'issue_comment'});
  assert.equal((await h.hook(a.path,a.secret,'pr-opened',{repository:{id:101},action:'opened',pull_request:{...pull,head:{sha:'a'.repeat(40)}}},{'X-GitHub-Event':'pull_request'})).value.tasks_created,1);
  assert.equal((await send('pr-comment')).value.tasks_created,1);
  const task=h.store.get("SELECT * FROM tasks WHERE unique_key='101:review.pr:7:comment:400'");
  assert.equal(task.head_sha,pull.head.sha);assert.deepEqual(JSON.parse(task.input).pull_request,pull);assert.deepEqual(JSON.parse(task.input).comment,payload.comment);
  const count=requests.length;assert.equal((await send('pr-comment')).value.tasks_created,0);assert.equal(requests.length,count);
  assert.equal((await send('another-pr-comment',{...payload,comment:{...payload.comment,id:'401'}})).value.tasks_created,1);
  for(const [id,change] of [[402,{draft:true}],[403,{state:'closed'}],[404,{head:{sha:'bad'}}]]){
    const previous=pull;pull={...pull,...change};assert.equal((await send('skip-'+id,{...payload,comment:{...payload.comment,id}})).value.tasks_created,0);pull=previous;
  }
  const before=h.store.get('SELECT count(*) n FROM deliveries').n;failRead=true;
  assert.equal((await send('retryable-read',{...payload,comment:{...payload.comment,id:405}})).status,503);
  assert.equal(h.store.get('SELECT count(*) n FROM deliveries').n,before);
  failRead=false;assert.equal((await send('retryable-read',{...payload,comment:{...payload.comment,id:405}})).value.tasks_created,1);
  const concurrent=await Promise.all([send('concurrent',{...payload,comment:{...payload.comment,id:406}}),send('concurrent',{...payload,comment:{...payload.comment,id:406}})]);
  assert.equal(concurrent.reduce((sum,response)=>sum+response.value.tasks_created,0),1);
  assert.equal(concurrent.filter(response=>response.value.duplicate).length,1);
  const reads=requests.length;
  for(const change of [{sender:{type:'Bot'}},{action:'edited'},{comment:{...payload.comment,body:'No mention'}},{issue:{...payload.issue,state:'closed'}}])assert.equal((await send('no-read-'+requests.length+JSON.stringify(change),{...payload,...change})).value.tasks_created,0);
  await admin('/api/repositories/101/policy','PATCH',{review_pull_requests:false});assert.equal((await send('pr-disabled')).value.tasks_created,0);
  assert.equal(requests.length,reads);assert.ok(requests.every(request=>!request.includes('/users/')&&!request.endsWith('/user')));
  assert.ok(tokens.length>0);for(const body of tokens)assert.deepEqual(body,{repository_ids:[101],permissions:{pull_requests:'read'}});
  assert.doesNotMatch(JSON.stringify(h.store.all('SELECT input FROM tasks')),/comment-read-token|PRIVATE KEY/);
});

test('comment Issue reviews publish with trigger context before starting authorized development',async t=>{
  mentionNames(t,undefined);
  const issue={id:1,number:1,state:'open',title:'Fix the bug.',body:'Please fix.',labels:[{name:'bot-develop'}],assignees:[]};
  const review={summary:'A code fix is requested.',findings:[],requires_code_change:true,issue_requests_code:true,clarification_required:false,implementation_goal:'Fix the bug.',request_quote:'Fix the bug.'};
  const config=[];let failPublication=true;
  const h=await emptyRepositoryFixture(t,{
    github:(path,send,res)=>{
      if(path.endsWith('/issues/1')){send(issue);return true;}
      if(path.endsWith('/issues/1/events')){send([{event:'labeled',label:{name:'bot-develop'},actor:{type:'User'}}]);return true;}
      if(path.endsWith('/issues/1/comments')&&res.req.method==='GET'){send(Array.from({length:55},(_,id)=>({id,body:'Later discussion'})));return true;}
      if(path.endsWith('/issues/1/comments')&&res.req.method==='POST'&&failPublication){send({message:'Permission denied'},403);return true;}
    },
    execute:request=>{
      if(request.type==='workspace_agent_config')config.push(Buffer.from(request.base64,'base64'));
      if(request.type==='workspace_agent_poll')return {ok:true,result:{state:'completed',result:review}};
    }
  });
  h.setBranch('ready');h.store.run("UPDATE tasks SET status='succeeded' WHERE id=?",h.taskId);
  await h.admin('/api/repositories/101/policy','PATCH',{development_enabled:true});
  const comment={id:500,body:'@bot review the updated requirements',html_url:'https://github.invalid/issue/1#issuecomment-500'};
  assert.equal(queueWebhook(h.store,'101','issue_comment',{repository:{id:101},action:'created',sender:{type:'User'},issue,comment},h.store.get('SELECT source_delivery_id FROM tasks WHERE id=?',h.taskId).source_delivery_id),1);
  const task=h.store.get("SELECT id FROM tasks WHERE unique_key='101:review.issue:1:comment:500'");
  assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.issue'").n,0);
  h.engine.tick();await Promise.all(h.engine.active.values());
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?',task.id).status,'waiting_permission');
  assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.issue'").n,0);assert.equal(h.comments.length,0);
  const prompt=JSON.parse(JSON.parse(Buffer.concat(config).toString()).prompt);
  assert.deepEqual(prompt.trigger_comment,comment);assert.equal(prompt.comments.length,50);
  failPublication=false;assert.equal((await h.admin('/api/tasks/'+task.id+'/retry','POST',{})).status,201);
  await Promise.all(h.engine.active.values());
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?',task.id).status,'succeeded');assert.equal(h.comments.length,1);
  const development=h.store.get("SELECT * FROM tasks WHERE kind='development.issue'");
  assert.equal(development.source_task_id,task.id);assert.equal(development.status,'queued');assert.equal(development.unique_key,'101:development.issue:1:opened');
});

test('active Issue development blocks another task and PR comment reviews never start revisions',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,development_enabled:true});
  for(const status of ['queued','retry_wait','waiting_configuration','waiting_environment','waiting_permission','waiting_pr_head','waiting_publication','running','preparing','implementing','validating','publishing','result_ready']){
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES(?,'101','development.issue',?,'existing',9)",status,status);
    assert.equal(enqueue(h.store,'101','development.issue',9,null,{}),null,status);
    h.store.run('DELETE FROM tasks WHERE id=?',status);
  }
  const engine=new TaskEngine(h.store,{}),result={requires_code_change:true,clarification_required:false,findings:[{actionable:true,within_goal:true,requires_human_decision:false}]};
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('source','101','development.issue','succeeded','source',?)",JSON.stringify({review:{implementation_goal:'Fix the bug'}}));
  let ownershipChecks=0;engine.owned=()=>{ownershipChecks++;return {source_task_id:'source',revisions:0};};
  const task={id:'review',repository_id:'101',kind:'review.pr',object_number:7,head_sha:'c'.repeat(40),source_delivery_id:null};
  engine.queueDevelopment({},task,{object:{},comment:{id:501,body:'@bot'}},result,true);
  assert.equal(ownershipChecks,0);assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.pr'").n,0);
  engine.queueDevelopment({},task,{object:{}},result,true);
  assert.equal(ownershipChecks,1);assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.pr'").n,1);
});

test('a stale PR comment review cannot become a head-triggered task that starts development',async t=>{
  const current={number:1,state:'open',draft:false,head:{sha:'d'.repeat(40)}};
  const h=await emptyRepositoryFixture(t,{github:(path,send)=>{if(path.endsWith('/pulls/1')){send(current);return true;}}});
  h.store.run("UPDATE tasks SET kind='review.pr',head_sha=?,unique_key='101:review.pr:1:comment:502',input=? WHERE id=?",'c'.repeat(40),JSON.stringify({comment:{id:502,body:'@bot review this PR'}}),h.taskId);
  const task=await h.run();assert.equal(task.status,'superseded');assert.equal(task.error_code,'pull_request_head_changed');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,1);assert.equal(h.comments.length,0);
});

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
test('the review label is declared in labels.md and validated when the console layer is saved',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const label=async()=>(await admin('/api/repositories/101/rules')).value.rules.review_label,put=content=>admin('/api/repositories/101/rules','PUT',{path:'.bot/rules/labels.md',content});
  assert.equal(await label(),'bot-reviewed');assert.equal((await admin('/api/repositories/101/policy','PATCH',{review_label:'other'})).status,400);
  for(const name of ['x'.repeat(51),'"tab\\tlabel"','" padded"'])assert.equal((await put('review_label: '+name)).status,400);
  assert.equal((await put('review_label: project-reviewed')).status,200);assert.equal(await label(),'project-reviewed');
  assert.equal((await put(null)).status,200);assert.equal(await label(),'bot-reviewed');
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
  assert.equal(comments.length,1);assert.ok(comments[0].body.startsWith('Short summary.'));assert.doesNotMatch(JSON.stringify([...comments,...reviews]),/Selection:|On the changed line/);
  await assert.rejects(publisher.label('bot-reviewed'),/github_response_unknown/);
  assert.deepEqual((await publisher.label('bot-reviewed')).map(l=>l.name),['bot-reviewed']);
  assert.deepEqual((await publisher.label('bot-reviewed')).map(l=>l.name),['bot-reviewed']);
  assert.equal(requests.filter(r=>r==='POST /repos/fixture/project-101/issues/7/labels').length,2);
  assert.equal(h.store.get("SELECT state FROM github_effects WHERE kind='label'").state,'sent');
});
test('development needs the development label from a person and no assignee, whether the label comes before or after the review',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,development_enabled:true});
  const review={summary:'s',requires_code_change:true,issue_requests_code:true,clarification_required:false,implementation_goal:'Fix add',request_quote:'Fix add.',findings:[],object_hash:'h'},now=new Date().toISOString();
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)",JSON.stringify(review),now,now);
  const issue=(labels,assignees=[])=>({number:5,title:'Fix add.',body:'Please fix.',state:'open',labels:labels.map(name=>({name})),assignees});
  const labeled=async(delivery,name,type,labels,assignees)=>(await h.hook(a.path,a.secret,delivery,{repository:{id:101},action:'labeled',label:{name},sender:{id:5,type},issue:issue(labels,assignees)})).value.tasks_created;
  const count=()=>h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.issue'").n;
  // Another label, a label added by an app, or an Issue someone already took starts nothing.
  assert.equal(await labeled('l1','bug','User',['bug']),0);
  assert.equal(await labeled('l2','bot-develop','Bot',['bot-develop']),0);
  assert.equal(await labeled('l3','bot-develop','User',['bot-develop'],[{login:'someone'}]),0);
  // The label name comes from the first line of the development rule.
  await admin('/api/repositories/101/rules','PUT',{path:'.bot/rules/issue-development.md',content:'development_label: ship-it\n\nRules.'});
  assert.equal((await admin('/api/repositories/101/rules')).value.rules.development_label,'ship-it');
  assert.equal(await labeled('l4','bot-develop','User',['bot-develop']),0);
  await admin('/api/repositories/101/rules','PUT',{path:'.bot/rules/issue-development.md',content:null});
  await admin('/api/repositories/101/policy','PATCH',{development_enabled:false});assert.equal(await labeled('l5','bot-develop','User',['bot-develop']),0);
  await admin('/api/repositories/101/policy','PATCH',{development_enabled:true});assert.equal(count(),0);
  // A person's label after the review starts the development the review found requested, once.
  assert.equal(await labeled('l6','BOT-develop','User',['bot-develop']),1);assert.equal(await labeled('l7','bot-develop','User',['bot-develop']),0);
  assert.equal(h.store.get("SELECT count(*) n FROM task_logs l JOIN tasks t ON t.id=l.task_id WHERE t.kind='development.issue' AND json_extract(l.content,'$.type')='queued'").n,1);
  const input=JSON.parse(h.store.get("SELECT input FROM tasks WHERE kind='development.issue'").input);assert.deepEqual([input.review.request_quote,input.object_hash],['Fix add.','h']);
  // A label already on the Issue when the review is published is accepted only if a user account added it last.
  const engine=new TaskEngine(h.store,{}),task=h.store.get("SELECT * FROM tasks WHERE id='rv'"),user={event:'labeled',label:{name:'bot-develop'},actor:{type:'User'}};
  const github=(object,events)=>({object:async()=>object,pages:async()=>events,path:p=>p});
  assert.equal(await engine.developmentApproved(github(issue(['bot-develop']),[{event:'labeled',label:{name:'bug'},actor:{type:'User'}},user]),task),true);
  assert.equal(await engine.developmentApproved(github(issue(['bot-develop']),[user,{...user,actor:{type:'Bot'}}]),task),false);
  assert.equal(await engine.developmentApproved(github(issue(['bot-develop'],[{login:'x'}]),[user]),task),false);
  assert.equal(await engine.developmentApproved(github(issue([]),[user]),task),false);
  h.store.run("DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE kind='development.issue')");
  h.store.run("DELETE FROM tasks WHERE kind='development.issue'");
  engine.queueDevelopment({},task,{object:issue(['bot-develop']),object_hash:'h'},review,false);assert.equal(count(),0);
  engine.queueDevelopment({},task,{object:issue(['bot-develop']),object_hash:'h'},review,true);assert.equal(count(),1);
  // The same predicate guards every validation of the development task until publication.
  assert.equal(developmentReady({labels:['Bot-Develop'],assignees:[]},'bot-develop'),true);
  assert.equal(developmentReady({labels:[{name:'bot-develop'}],assignee:{login:'x'}},'bot-develop'),false);
});
test('task read tokens cover one repository with read permissions only, need a GitHub App and are revoked',async t=>{
  const h=await harness(t),{admin}=await setup(h),keys=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'});
  const app=await account(admin,{type:'github_app',app_id:'123',private_key:privateKey,token:undefined});await repository(admin,app.id,'101');
  const bot=await account(admin);await repository(admin,bot.id,'202');
  const minted=[],tokenRequests=[],deleted=[];let granted=null;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const b of req)raw+=b;const path=new URL(req.url,'http://fake').pathname,authorization=req.headers.authorization?.slice(7);res.setHeader('Content-Type','application/json');
    if(path==='/app')res.end(JSON.stringify({slug:'fixture-app'}));
    // The installation may write, and has a permission the agent never asks for.
    else if(path.endsWith('/installation'))res.end(JSON.stringify({id:7,account:{id:10},permissions:{metadata:'read',contents:'write',issues:'write',pull_requests:'write',actions:'read',administration:'write'}}));
    else if(path.endsWith('/access_tokens')){const body=JSON.parse(raw);tokenRequests.push(body);const token=randomBytes(24).toString('hex');minted.push(token);res.end(JSON.stringify({token,expires_at:'2099-01-01T00:00:00Z',permissions:granted||body.permissions}));}
    else if(path==='/installation/token'&&req.method==='DELETE'){deleted.push(authorization);res.statusCode=204;res.end();}
    else if(path.startsWith('/users/'))res.end(JSON.stringify({id:999}));
    else if(path==='/repositories/101')res.end(JSON.stringify({id:101,full_name:'fixture/project-101',owner:{id:10},default_branch:'trunk'}));
    else{res.statusCode=404;res.end('{}');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`,redactor=new Redactor(),repo=id=>h.store.get('SELECT * FROM repositories WHERE id=?',id);
  const tokens=new ReadTokens(h.store,repo('101'),redactor,async()=>{},url);
  const grant=await tokens.issue();
  assert.deepEqual(tokenRequests[0],{repository_ids:[101],permissions:{metadata:'read',contents:'read',issues:'read',pull_requests:'read',actions:'read'}});
  assert.deepEqual([grant.token,grant.repository,grant.permissions.contents],[minted[0],'fixture/project-101','read']);assert.equal(redactor.text(grant.token),'[REDACTED]');
  // A grant that could write anything is refused, and still revoked with the rest.
  granted={contents:'write'};await assert.rejects(tokens.issue(),/github_read_token_not_read_only/);
  await tokens.revoke();assert.deepEqual(deleted,minted);
  await assert.rejects(new ReadTokens(h.store,repo('202'),new Redactor(),async()=>{},url).issue(),/github_app_required/);
});
test('classification labels come only from the repository, skip reserved labels and decided axes, and go on with the review label',async t=>{
  const available=[{name:'type/bug'},{name:'type/feature'},{name:'Priority/High'},{name:'priority/low'},{name:'priority/critical'},{name:'area/inventory'},{name:'agent/ok'},{name:'blocker'},{name:'bot-develop'},{name:'bot-reviewed'},{name:'size/s'}];
  const own=['bot-reviewed','bot-develop'];
  // Names are matched case-insensitively and returned as the repository spells them; unknown names are dropped.
  assert.deepEqual(classificationLabels(['type/bug','priority/high','area/inventory','type/made-up'],available,[],own),['type/bug','Priority/High','area/inventory']);
  // Reserved labels never go on, whatever the model says.
  assert.deepEqual(classificationLabels(['agent/ok','blocker','priority/critical','bot-develop','bot-reviewed','size/s'],available,[],own),['size/s']);
  // A value a person already chose on an axis stays; only one priority is added.
  assert.deepEqual(classificationLabels(['type/feature','priority/low','size/s'],available,[{name:'type/bug'}],own),['priority/low','size/s']);
  assert.deepEqual(classificationLabels(['priority/high','priority/low'],available,[],own),['Priority/High']);
  assert.deepEqual(classificationLabels(undefined,available,[],own),[]);assert.deepEqual(classificationLabels(['type/bug'],[],[],own),[]);
  assert.deepEqual(repositoryLabels([{name:'type/bug',description:'A defect'},{name:''},{id:3}]),[{name:'type/bug',description:'A defect'}]);
  const review={summary:'s',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
  assert.deepEqual(validateReview({...review,labels:['type/bug']}).labels,['type/bug']);
  for(const labels of ['type/bug',[1],['x'.repeat(51)],Array(21).fill('a')])assert.throws(()=>validateReview({...review,labels}),/model_review_invalid/);
  // The review label and the classification labels go on in one idempotent call.
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('labels-task','101','review.issue','publishing','issue',9)");
  let labels=[];const posts=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;res.setHeader('Content-Type','application/json');
    if(new URL(req.url,'http://fake').pathname.endsWith('/issues/9/labels')){if(req.method==='POST'){posts.push(JSON.parse(raw).labels);labels=[...new Set([...labels,...JSON.parse(raw).labels])];}return res.end(JSON.stringify(labels.map(name=>({name}))));}
    res.statusCode=404;res.end('{}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const github=new GitHub(h.store,h.store.get("SELECT * FROM repositories WHERE id='101'"),new Redactor(),async()=>{},'http://127.0.0.1:'+server.address().port);
  Object.assign(github,{token:'fixture-token',actorId:'999',fullName:'fixture/project-101'});
  const publisher=new Publisher(h.store,github,h.store.get("SELECT * FROM tasks WHERE id='labels-task'"),async()=>{});
  assert.deepEqual((await publisher.labels(['bot-reviewed','type/bug','priority/high'])).map(l=>l.name),['bot-reviewed','type/bug','priority/high']);
  await publisher.labels(['bot-reviewed','type/bug','priority/high']);assert.deepEqual(posts,[['bot-reviewed','type/bug','priority/high']]);
});
