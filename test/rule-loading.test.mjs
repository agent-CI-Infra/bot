import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{once}from'node:events';import{createHash}from'node:crypto';import{rmSync}from'node:fs';
import{harness,setup,account,repository}from'./helpers.mjs';import{TaskEngine}from'../dist/agent/engine.js';import{blobSha}from'../dist/agent/common.js';
import{RuleService,resolveRules,developmentLabel}from'../dist/rules/service.js';

const id=value=>createHash('sha1').update(JSON.stringify(value)).digest('hex');
// A fake GitHub repository whose branches point at commits built from {path: text | {data, mode}}, and a manager whose
// review agent finishes at once. stopModel ends a task right after preparation, before the model runs.
async function repositoryFixture(t,{stopModel=false}={}){
  const blobs=new Map(),trees=new Map(),commits=new Map(),heads={},comments=[],labels=[];let engine;
  const issue={id:1,number:1,state:'open',title:'Fix the parser',body:'Please fix the parser.',labels:[{name:'bot-develop'}],assignee:null,assignees:[]};
  const fixture={heads,comments,labels,issue,pr:null,
    commit(files){
      const entries=Object.entries(files).map(([path,value])=>{const data=Buffer.from(typeof value==='string'?value:value.data),sha=blobSha(data);blobs.set(sha,data);return{path,type:'blob',mode:value.mode||'100644',sha,size:data.length};});
      const tree=id(entries);trees.set(tree,entries);const sha=id([tree,commits.size]);commits.set(sha,tree);return sha;
    }};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{},path=decodeURIComponent(new URL(req.url,'http://fixture').pathname);
    const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const repo='/repos/fixture/project-101',rest=path.startsWith(repo)?path.slice(repo.length):path;
    if(path==='/user')return send({id:999,login:'fixture-bot'});
    if(path==='/repositories/101')return send({id:101,owner:{id:10},full_name:'fixture/project-101',default_branch:'main'});
    if(rest.startsWith('/git/ref/heads/'))return heads[rest.slice(15)]?send({object:{sha:heads[rest.slice(15)]}}):send({message:'Not Found'},404);
    if(rest.startsWith('/git/commits/'))return send({sha:rest.slice(13),tree:{sha:commits.get(rest.slice(13))}});
    if(rest.startsWith('/git/trees/'))return send({sha:rest.slice(11),tree:trees.get(rest.slice(11)),truncated:false});
    if(rest.startsWith('/git/blobs/'))return send({sha:rest.slice(11),content:blobs.get(rest.slice(11)).toString('base64'),encoding:'base64'});
    if(rest==='/issues/1')return send(issue);
    if(rest==='/pulls/7')return send(fixture.pr);
    if(rest==='/issues/1/comments'){
      if(req.method==='POST'){const value={id:comments.length+1,body:body.body,user:{id:999},html_url:'https://github.invalid/comment/1'};comments.push(value);return send(value,201);}
      return send(comments);
    }
    if(rest==='/issues/1/labels'){labels.push(...body.labels);return send(body.labels.map(name=>({name})));}
    if(rest==='/labels'||rest==='/issues/1/events')return send([]);
    return send({message:'Not Found'},404);
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const githubUrl='http://127.0.0.1:'+server.address().port;
  const manager={call:async(method,path,body)=>{
    if(!path.endsWith('/execute'))return{repository_id:'101',state:'ready',generation:1,desired:'ready',revision:1};
    const type=body.request.type;
    if(type==='workspace_snapshot')return{ok:true,result:{tree_sha:body.request.tree_sha}};
    if(type==='workspace_agent_config'&&stopModel)return{ok:false,error:'fixture_stop'};
    if(type==='workspace_agent_poll')return{ok:true,result:{state:'completed',result:{summary:'Reviewed.',findings:[],requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:''}}};
    return{ok:true,result:{}};
  }};
  const h=await harness(undefined,manager,store=>({engine:engine=new TaskEngine(store,manager,githubUrl)})),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:'https://model.invalid/v1',api_key:'fixture-key',model_name:'fixture-model'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,development_enabled:true,model_id:model.id});
  Object.assign(fixture,{...h,admin,account:a,
    async run(taskId){h.store.run('UPDATE tasks SET next_run_at=0 WHERE id=?',taskId);engine.tick();await Promise.all(engine.active.values());return h.store.get('SELECT * FROM tasks WHERE id=?',taskId);},
    logs:taskId=>h.store.all('SELECT content FROM task_logs WHERE task_id=? ORDER BY rowid',taskId).map(row=>JSON.parse(row.content))});
  t.after(async()=>{await engine.close();await h.stop();await new Promise(resolve=>server.close(resolve));rmSync(h.directory,{recursive:true,force:true});});
  return fixture;
}

test('a label line ends with its line: an empty value is an empty label, never the next line',()=>{
  const rules=files=>resolveRules({},files);
  assert.equal(rules({'.bot/rules/issue-development.md':'development_label:\n# Issue development\n'}).development_label,'bot-develop');
  assert.equal(rules({'.bot/rules/labels.md':'review_label:\n# Labeling\n'}).review_label,'');
  assert.equal(rules({'.bot/rules/labels.md':'review_label: \t\r\n\nshort\n'}).review_label,'');
  assert.equal(rules({'.bot/rules/labels.md':'review_label: ""\n# Labeling'}).review_label,'');
  assert.equal(rules({'.bot/rules/issue-development.md':'development_label: ""\n'}).development_label,'bot-develop');
  assert.equal(rules({'.bot/rules/labels.md':'review_label:\tteam reviewed \r\nreview_label: second'}).review_label,'team reviewed');
  // The first line wins even when it is empty; JSON keeps exact characters and the existing checks still apply.
  assert.equal(rules({'.bot/rules/labels.md':'review_label:\nreview_label: later'}).review_label,'');
  assert.equal(rules({'.bot/rules/labels.md':'review_label: "a\\u00e9"'}).review_label,'aé');
  for(const value of ['" padded"','x'.repeat(51),'"tab\\there"'])assert.throws(()=>rules({'.bot/rules/labels.md':'review_label: '+value}),{code:'invalid_bot_label'});
});

test('repository rules with NUL are rejected wherever they come from, and the console limit counts UTF-8 bytes',async t=>{
  for(const path of ['.bot/guide.md','.bot/rules/labels.md','.agents/skills/check/SKILL.md'])assert.throws(()=>resolveRules({},{[path]:'text\0more'}),{code:'invalid_rule_content'});
  // Binary files under .bot/ that are not rule files are not rules.
  assert.equal(resolveRules({},{'.bot/logo.png':'\0PNG'}).review_label,'bot-reviewed');
  const github={path:suffix=>suffix,request:async(_method,path)=>path.startsWith('/git/commits/')?{tree:{sha:'tree'}}:path.startsWith('/git/trees/')
    ?{tree:[{path:'.bot/guide.md',type:'blob',mode:'100644',sha:'guide',size:9}],truncated:false}:{content:Buffer.from('text\0more').toString('base64')}};
  const h=await harness(t,undefined,{maxBodyBytes:200000}),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');const rules=new RuleService(h.store);
  await assert.rejects(rules.fetch(github,'a'.repeat(40)),{code:'invalid_rule_content'});
  // Content an older version cached with NUL fails the next resolution instead of being read as missing.
  rules.cache('101','a'.repeat(40),{'.bot/rules/issue-development.md':'development_label: ship\0it'});
  assert.equal((await admin('/api/repositories/101/rules')).value.error,'invalid_rule_content');assert.throws(()=>developmentLabel(h.store,'101'),{code:'invalid_rule_content'});
  rules.cache('101','b'.repeat(40),{});
  const put=content=>admin('/api/repositories/101/rules','PUT',{path:'.bot/guide.md',content});
  const wide='规'.repeat(16384);assert.ok(Buffer.byteLength(wide)>16384);
  const rejected=await put(wide);assert.equal(rejected.status,400);assert.equal(rejected.value.error,'invalid_rule_content');
  assert.equal((await put('规'.repeat(5461))).status,200);assert.equal((await put('x'.repeat(16384))).status,200);assert.equal((await put('x'.repeat(16385))).status,400);
  assert.equal((await admin('/api/repositories/101/rules')).value.rules.files.find(f=>f.path==='.bot/guide.md').effective,'x'.repeat(16384));
});

test('a bad rule file stops the task before publishing with its own code, and the same task completes once the file is fixed',async t=>{
  const f=await repositoryFixture(t);
  f.heads.main=f.commit({'src/app.js':'export {};\n','.bot/guide.md':'x'.repeat(16385)});
  await f.hook(f.account.path,f.account.secret,'opened',{repository:{id:101},action:'opened',issue:f.issue});
  const taskId=f.store.get("SELECT id FROM tasks WHERE kind='review.issue'").id;
  const bad={
    bot_rule_too_large:{'.bot/guide.md':'x'.repeat(16385)},
    invalid_bot_label:{'.bot/rules/labels.md':'review_label: '+'y'.repeat(51)},
    invalid_bot_computer:{'.bot/computer.yaml':'docker_socket: /var/run/docker.sock\n'},
    invalid_rule_content:{'.bot/guide.md':'guide\0'},
    too_many_bot_skills:Object.fromEntries(Array.from({length:33},(_,i)=>[`.agents/skills/s${i}/SKILL.md`,'Skill.'])),
    invalid_bot_rule_file:{'.bot/guide.md':{data:'../../etc/passwd',mode:'120000'}}};
  for(const [code,files] of Object.entries(bad)){
    f.heads.main=f.commit({'src/app.js':'export {};\n',...files});
    for(let i=0;i<2;i++){
      const task=await f.run(taskId);
      assert.equal(task.error_code,code);assert.equal(task.status,'waiting_configuration');assert.equal(task.phase,'prepare');assert.equal(f.comments.length,0);
    }
    // Waiting again for the same file does not repeat the entry.
    assert.equal(f.logs(taskId).filter(log=>log.type==='fault'&&log.code===code).length,1);
  }
  assert.ok(!f.logs(taskId).some(log=>log.type==='runtime_fault'));
  // Fixed on the default branch: the waiting task prepares the new commit and publishes. `review_label:` alone means no label.
  f.heads.main=f.commit({'src/app.js':'export {};\n','.bot/rules/labels.md':'review_label:\n# Labeling\n'});
  const task=await f.run(taskId);
  assert.equal(task.status,'succeeded');assert.equal(task.error_code,null);assert.equal(JSON.parse(task.input).snapshot_sha,f.heads.main);
  assert.equal(f.comments.length,1);assert.deepEqual(f.labels,[]);
});

test('an Issue development that continues the bot PR checks out its head and reads rules from its base branch',async t=>{
  const f=await repositoryFixture(t,{stopModel:true});
  f.heads.main=f.commit({'src/app.js':'export {};\n','.bot/guide.md':'Main guide'});
  f.heads.release=f.commit({'src/app.js':'export {};\n','.bot/guide.md':'Release guide'});
  const head=f.commit({'src/app.js':'export const fixed = true;\n','.bot/guide.md':'Guide written by the PR'});
  f.pr={id:55,number:7,state:'open',draft:false,user:{id:999},head:{sha:head,ref:'bot/issue-1-original',repo:{id:101}},base:{ref:'release'}};
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,phase) VALUES('original','101','development.issue','pr_opened','original','{}',1,'done')");
  f.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-original',?,'original',0)",head);
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at) VALUES('next','101','development.issue','queued','next',?,1,'2026-10-27T00:00:00Z')",JSON.stringify({review:{implementation_goal:'Fix the parser',requires_code_change:true}}));
  await f.run('next');
  const input=JSON.parse(f.store.get("SELECT input FROM tasks WHERE id='next'").input);
  assert.equal(input.snapshot_sha,head);assert.equal(f.logs('next').find(log=>log.type==='prepared').sha,head);
  assert.equal(f.store.get("SELECT sha FROM repository_rule_sources WHERE repository_id='101'").sha,f.heads.release);
  assert.equal(input.context.effective_rules.files.find(row=>row.path==='.bot/guide.md').effective,'Release guide');
});
