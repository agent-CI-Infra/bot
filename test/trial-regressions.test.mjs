import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{once}from'node:events';
import{harness,setup,account,repository}from'./helpers.mjs';import{TaskEngine}from'../dist/agent/engine.js';import{Publisher,assertOwnedPR}from'../dist/github/publisher.js';import{shortTitle,reviewText}from'../dist/github/text.js';import{blobSha,Redactor}from'../dist/agent/common.js';import{GitHub}from'../dist/github/client.js';

test('titles truncate at word boundaries; findings are routed once without selection reasons',()=>{
 const title=shortTitle('Implement #5: '+('Useful complete words ').repeat(20));assert.ok(title.length<=160);assert.match(title,/words…$|complete…$|Useful…$/);
 assert.equal(shortTitle('Short title'),'Short title');assert.ok(shortTitle('x'.repeat(300)).length<=160);
 const findings=[{id:'a',body:'An exact inline finding.'},{id:'b',body:'A discussion finding.'},{id:'c',body:'A discussion finding.'}];
 const text=reviewText('Scope.\n\nAn exact inline finding.\n\nA discussion finding.',findings,new Set(['a']));
 assert.doesNotMatch(text.overview,/exact inline/);assert.deepEqual(text.discussion,[]);assert.equal(text.findings.length,2);
});

test('pushed bot PR waits for its delayed head, completes automatically, pushes once and updates current description',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const old='a'.repeat(40),next='b'.repeat(40),tree='c'.repeat(40),data=Buffer.from('export const fix = true;\n');
 const pr={id:55,number:7,state:'open',draft:false,user:{id:999},head:{sha:old,ref:'bot/issue-1-original',repo:{id:101}},html_url:'https://github.invalid/pull/7',title:'Old title',body:'Old tests 9'};
 let writes=0,readsAfterPush=0,createdAuthor,commitMessage;const requests=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):{},path=decodeURIComponent(new URL(req.url,'http://fake').pathname);requests.push(req.method+' '+path);res.setHeader('Content-Type','application/json');
  const send=value=>res.end(JSON.stringify(value));
  if(path==='/user')return send({id:999,login:'fixture-bot'});
  if(path==='/repositories/101')return send({id:101,owner:{id:10},full_name:'fixture/project-101',default_branch:'main'});
  if(path.endsWith('/pulls/7')){if(req.method==='PATCH'){Object.assign(pr,body);return send(pr);}if(writes&&++readsAfterPush>=4)pr.head.sha=next;return send(pr);}
  if(path.includes('/git/ref/heads/'))return send({object:{sha:writes?next:old}});
  if(path.endsWith('/git/blobs'))return send({sha:blobSha(data)});
  if(path.endsWith('/git/trees'))return send({sha:tree});
  if(path.endsWith('/git/commits')){createdAuthor=body.author;commitMessage=body.message;return send({sha:next,tree:{sha:tree}});}
  if(path.includes('/git/refs/heads/')){writes++;return send({object:{sha:next}});}
  if(path.endsWith('/issues/7/comments'))return send(req.method==='GET'?[]:{id:1,body:body.body,html_url:'https://github.invalid/comment/1'});
  res.statusCode=404;send({});
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const model=(await admin('/api/models','POST',{repository_id:'101',api_url:'https://model.invalid/v1',api_key:'fixture-only-key',model_name:'fake'})).value.model;
 await admin('/api/repositories/101/policy','PATCH',{model_id:model.id,review_enabled:true,development_enabled:true});
 h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,phase,head_sha) VALUES('original','101','development.issue','pr_opened','original',?,1,'done',?)",JSON.stringify({review:{implementation_goal:'Implement the requested fix'}}),old);
 h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,phase,head_sha,claim_token,result) VALUES('revision','101','development.pr','running','revision',?,7,'publish',?,'claim','{}')",JSON.stringify({object:pr}),old);
 h.store.run("INSERT INTO task_locks(repository_id,task_id,token) VALUES('101','revision','claim')");
 h.store.run("INSERT INTO bot_branches VALUES('101','bot/issue-1-original','original')");
 h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-original',?,'original',0)",old);
 const candidate={files:[{path:'fix.js',sha:blobSha(data),base64:data.toString('base64'),mode:'100644'}],tree_sha:tree,branch:pr.head.ref,owner_task_id:'original',expected_sha:old,base_sha:old,base_branch:'main',pr_number:7,date:'2026-10-23T00:00:00Z',summary:'Updated the implementation and ran ten tests.',change_title:'Fix requested behavior',validation:{command:'node --test',exit_code:0}};
 h.store.run("INSERT INTO development_candidates VALUES('revision',?)",JSON.stringify(candidate));
 const manager={call:async()=>({state:'ready',generation:1})},engine=new TaskEngine(h.store,manager,'http://127.0.0.1:'+server.address().port);
 await engine.run('revision','claim');
 assert.equal(h.store.get("SELECT status FROM tasks WHERE id='revision'").status,'completed');assert.equal(writes,1);assert.ok(readsAfterPush>=4);
 assert.equal(h.store.get("SELECT revisions FROM bot_pull_requests WHERE number=7").revisions,1);
 assert.match(pr.body,/ten tests/);assert.doesNotMatch(pr.body,/tests 9/);assert.equal(pr.title,'Fix requested behavior');
 assert.equal(createdAuthor.email,'999+fixture-bot@users.noreply.github.com');assert.equal(commitMessage,'Fix requested behavior');assert.notEqual(createdAuthor.email,'bot@users.noreply.github.com');
 // Re-entering the publication phase retains the candidate and outbox; no second ref push or revision increment.
 h.store.run("UPDATE tasks SET status='running',phase='publish' WHERE id='revision'");await engine.run('revision','claim');assert.equal(writes,1);assert.equal(h.store.get("SELECT revisions FROM bot_pull_requests WHERE number=7").revisions,1);
});

test('head timeout is an auto-resumable wait, leaves revision count unchanged, and ownership changes explain the field',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const old='a'.repeat(40),next='b'.repeat(40),pr={id:55,number:7,user:{id:999},head:{sha:old,ref:'bot/issue-1-original',repo:{id:101}}};
 h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('owner','101','development.issue','succeeded','owner',1),('t','101','development.pr','publishing','revision',7)");
 h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-original',?,'owner',0)",old);
 const github={actorId:'999',object:async()=>pr,path:x=>x,request:async(_m,_p,body)=>({...pr,...body})};let validations=0;
 const publisher=new Publisher(h.store,github,h.store.get("SELECT * FROM tasks WHERE id='t'"),async()=>{validations++;},[0,0]);
 await assert.rejects(publisher.pullRequest({pr_number:7,summary:'Fix',change_title:'Fix requested behavior',validation:{command:'true',exit_code:0}},next),e=>e.code==='pr_head_pending'&&e.state==='waiting_pr_head');
 assert.equal(h.store.get('SELECT revisions FROM bot_pull_requests WHERE number=7').revisions,0);assert.equal(validations,2);
 const owned=h.store.get('SELECT * FROM bot_pull_requests');
 for(const [field,value,code]of [['user',{id:33},'author'],['head',{...pr.head,repo:{id:202}},'head_repository'],['head',{...pr.head,ref:'other'},'branch']])assert.throws(()=>assertOwnedPR(owned,{...pr,[field]:value},'999','101'),e=>e.code===`bot_pr_${code}_changed`);
});

test('revision scopes retain the original goal and exclude human decisions and unspecified changes',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,development_enabled:true});
 const sha='a'.repeat(40),pr={id:77,number:7,user:{id:999},head:{sha,ref:'bot/issue-1-owner',repo:{id:101}}};
 h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('owner','101','development.issue','pr_opened','owner',?,1),('r','101','review.pr','succeeded','r','{}',7)",JSON.stringify({review:{implementation_goal:'Add clamp and requested tests'}}));
 h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'77','999','101','bot/issue-1-owner',?,'owner',0)",sha);
 const engine=new TaskEngine(h.store,{}),task={...h.store.get("SELECT * FROM tasks WHERE id='r'"),head_sha:sha},result={requires_code_change:true,clarification_required:false,implementation_goal:'Add unrequested TypeErrors',findings:[{body:'Optional TypeError',actionable:true,within_goal:false,requires_human_decision:true}]};
 engine.queueDevelopment({actorId:'999'},task,{object:pr},result);assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.pr'").n,0);
 result.findings.push({body:'Fix a failing requested boundary case',actionable:true,within_goal:true,requires_human_decision:false});result.clarification_required=true;engine.queueDevelopment({actorId:'999'},task,{object:pr},result);assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.pr'").n,0);
 result.clarification_required=false;engine.queueDevelopment({actorId:'999'},task,{object:pr},result);const input=JSON.parse(h.store.get("SELECT input FROM tasks WHERE kind='development.pr'").input);assert.equal(input.review.implementation_goal,'Add clamp and requested tests');assert.equal(input.review.findings.length,1);assert.match(input.review.findings[0].body,/failing/);
});

test('the label has one console layer, the labels.md file, and delivery outcomes link tasks without exposing JSON',async t=>{
 const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await admin('/api/repositories/101/policy','PATCH',{review_enabled:true});
 await admin('/api/repositories/101/rules','PUT',{path:'.bot/rules/labels.md',content:'review_label: second-label\nUse after review.'});assert.equal((await admin('/api/repositories/101/rules')).value.rules.review_label,'second-label');
 assert.equal((await admin('/api/repositories/101/policy','PATCH',{review_label:'third-label'})).status,400);assert.match((await admin('/api/repositories/101/rules')).value.rules.files.find(f=>f.path==='.bot/rules/labels.md').effective,/second-label/);
 const opened={repository:{id:101,full_name:'fixture/project-101'},action:'opened',issue:{number:1,title:'Review'}};await h.hook(a.path,a.secret,'opened',opened);await h.hook(a.path,a.secret,'logical-duplicate',opened);await h.hook(a.path,a.secret,'draft',{repository:{id:101},action:'opened',pull_request:{number:2,draft:true,head:{sha:'a'.repeat(40)}}},{'X-GitHub-Event':'pull_request'});
 const rows=(await admin('/api/events')).value.events,first=rows.find(r=>r.delivery_id==='opened'),duplicate=rows.find(r=>r.delivery_id==='logical-duplicate');assert.equal(first.processing_result,'tasks_created');assert.equal(first.full_name,'fixture/project-101');assert.equal(first.tasks.length,1);assert.equal(first.payload,undefined);assert.equal(rows.find(r=>r.delivery_id==='draft').processing_result,'draft');assert.equal(duplicate.processing_result,'duplicate');assert.equal(duplicate.tasks[0].id,first.tasks[0].id);
});
