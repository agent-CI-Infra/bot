import { acceptanceFixture } from './acceptance-fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{once}from'node:events';import{createHash}from'node:crypto';import{rmSync}from'node:fs';
import{harness,setup,account,repository,pinLegacyTaskConfiguration}from'./helpers.mjs';import{TaskEngine}from'../dist/agent/engine.js';import{blobSha}from'../dist/agent/common.js';
import{RuleService,resolveRules,developmentLabel,skillIndex,behaviorPath,projectLabels}from'../dist/rules/service.js';import{explainFailure}from'../dist/agent/failures.js';
import{managerPrompt,managerSection,saveManager,withSection}from'../dist/work/settings.js';

const id=value=>createHash('sha1').update(JSON.stringify(value)).digest('hex');
// A fake GitHub repository whose branches point at commits built from {path: text | {data, mode}}, and a manager whose
// review agent finishes at once. stopModel ends a task right after preparation, before the model runs.
async function repositoryFixture(t,{stopModel=false}={}){
  const blobs=new Map(),trees=new Map(),commits=new Map(),heads={},comments=[],labels=[],chunks=[];let engine;
  const issue={id:1,number:1,state:'open',title:'Fix the parser',body:'Please fix the parser.',labels:[{name:'bot-develop'}],assignee:null,assignees:[]};
  const fixture={heads,comments,labels,issue,pr:null,context:{},
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
    // The agent configuration arrives in chunks; the last one completes it. Task context files are kept by path.
    if(type==='workspace_agent_config'){chunks.push(Buffer.from(body.request.base64,'base64'));if(body.request.final){fixture.config=JSON.parse(Buffer.concat(chunks).toString());chunks.length=0;}}
    if(type==='workspace_context'){fixture.context[body.request.path]=(body.request.offset?fixture.context[body.request.path]:'')+Buffer.from(body.request.base64,'base64').toString();}
    if(type==='workspace_agent_config'&&stopModel)return{ok:false,error:'fixture_stop'};
    if(type==='workspace_agent_poll')return{ok:true,result:{state:'completed',result:{summary:'Reviewed.',findings:[],requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:''}}};
    return{ok:true,result:{}};
  }};
  const h=await harness(undefined,manager,store=>({engine:engine=new TaskEngine(store,manager,githubUrl, undefined, acceptanceFixture)})),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:'https://model.invalid/v1',api_key:'fixture-key',model_name:'fixture-model'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,development_enabled:true,model_id:model.id});
  Object.assign(fixture,{...h,admin,account:a,
    async run(taskId){h.store.run('UPDATE tasks SET next_run_at=0 WHERE id=?',taskId);pinLegacyTaskConfiguration(h.store);engine.tick();await Promise.all(engine.active.values());return h.store.get('SELECT * FROM tasks WHERE id=?',taskId);},
    logs:taskId=>h.store.all('SELECT content FROM task_logs WHERE task_id=? ORDER BY rowid',taskId).map(row=>JSON.parse(row.content))});
  t.after(async()=>{await engine.close();await h.stop();await new Promise(resolve=>server.close(resolve));rmSync(h.directory,{recursive:true,force:true});});
  return fixture;
}

// The project computer is the console layer only: a repository's .bot/computer.yaml is listed by name, never read (#935).
test('the computer and its field sources are the project console spec; .bot/ files are names only',()=>{
  const consoleSpec={cpus:3,memory_mb:4096,egress:true,env:{MODE:'test'}};
  const rules=resolveRules({}, {'.bot/computer.yaml':'','.bot/guide.md':''}, consoleSpec);
  assert.deepEqual(rules.computer,consoleSpec);
  assert.deepEqual(rules.computer_sources,{cpus:'console',memory_mb:'console',egress:'console',env:'console'});
  assert.deepEqual(rules.retired_files,['.bot/computer.yaml','.bot/guide.md']);
  assert.deepEqual(resolveRules({},{}).computer_sources,{});
  // Content an older cache or snapshot still holds for a .bot/ file is not a rule either.
  assert.equal(resolveRules({},{'.bot/guide.md':'Repository guide'}).files.find(f=>f.path==='.bot/guide.md').effective,resolveRules({},{}).files.find(f=>f.path==='.bot/guide.md').effective);
  assert.equal(resolveRules({},{'.bot/rules/labels.md':'review_label: other'}).review_label,'bot-reviewed');
  // A pull request that changes .bot/ no longer changes how the bot works; one that changes a skill does.
  assert.equal(behaviorPath('.bot/guide.md'),false);assert.equal(behaviorPath('.bot'),false);
  assert.equal(behaviorPath('.agents/skills/ci/SKILL.md'),true);assert.equal(behaviorPath('.agents/skills'),true);
});

test('a project added after the upgrade reads its skills and lists its .bot/ files without importing them',async t=>{
  const f=await repositoryFixture(t);
  f.store.run('INSERT INTO computer_console_specs VALUES(?,?)','101',JSON.stringify({cpus:2}));
  const sha=f.heads.main=f.commit({'.bot/computer.yaml':'cpus: 1.5\n','.bot/rules/labels.md':'review_label: repo-label\n','.agents/skills/ci/SKILL.md':'# CI\n'});
  const unread=(await f.admin('/api/repositories/101/rules')).value.rules;
  assert.equal(unread.needs_refresh,true);assert.equal(unread.sha,null);assert.equal(unread.imported,null);
  const refreshed=await f.admin('/api/repositories/101/rules/refresh','POST',{});
  assert.equal(refreshed.status,201,refreshed.value.error);
  const read=refreshed.value.rules;
  assert.equal(read.needs_refresh,false);assert.equal(read.sha,sha);assert.equal(read.imported,null);
  assert.equal(read.computer_sources.cpus,'console');assert.equal(read.computer.cpus,2);assert.equal(read.review_label,'bot-reviewed');
  assert.deepEqual(read.retired_files,['.bot/computer.yaml','.bot/rules/labels.md']);
  assert.equal(read.files.find(file=>file.path==='.agents/skills/ci/SKILL.md').effective,'# CI\n');
  assert.deepEqual(JSON.parse(f.store.get("SELECT files FROM repository_rule_sources WHERE repository_id='101'").files)['.bot/rules/labels.md'],'');
});

test('the labels are project settings: an empty review label means none, the development label cannot be empty',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const policy=async()=>(await admin('/api/repositories/101/policy')).value.policy;
  assert.deepEqual([(await policy()).review_label,(await policy()).development_label],['bot-reviewed','bot-develop']);
  const patch=values=>admin('/api/repositories/101/policy','PATCH',values);
  assert.equal((await patch({review_label:'',development_label:'team go'})).status,200);
  assert.deepEqual(projectLabels(h.store,'101'),{review_label:'',development_label:'team go'});
  assert.equal(developmentLabel(h.store,'101'),'team go');
  for(const values of [{development_label:''},{review_label:' padded'},{review_label:'x'.repeat(51)},{development_label:'tab\there'}]){
    const refused=await patch(values);assert.equal(refused.status,400,JSON.stringify(values));assert.equal(refused.value.error,'invalid_label');
  }
  assert.deepEqual(projectLabels(h.store,'101'),{review_label:'',development_label:'team go'});
  // The rules view reads the same settings.
  assert.equal((await admin('/api/repositories/101/rules')).value.rules.review_label,'');
});

test('skills with NUL are rejected; .bot/ contents are never read, and the console override editor answers 410',async t=>{
  for(const path of ['.agents/skills/check/SKILL.md'])assert.throws(()=>resolveRules({},{[path]:'text\0more'}),{code:'invalid_rule_content'});
  assert.equal(resolveRules({},{'.bot/guide.md':'text\0more'}).review_label,'bot-reviewed');
  const blobs={guide:'text\0more',skill:'# Skill\0'},tree=[{path:'.bot/guide.md',type:'blob',mode:'100644',sha:'guide',size:9}],requested=[];
  const github={path:suffix=>suffix,request:async(_method,path)=>{requested.push(path);return path.startsWith('/git/commits/')?{tree:{sha:'tree'}}:path.startsWith('/git/trees/')
    ?{tree,truncated:false}:{content:Buffer.from(blobs[path.slice(11)]).toString('base64')};}};
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');const rules=new RuleService(h.store);
  assert.deepEqual(await rules.fetch(github,'a'.repeat(40),undefined,'101'),{'.bot/guide.md':''});
  assert.ok(!requested.some(path=>path.startsWith('/git/blobs/')),'no .bot/ blob is read');
  tree.push({path:'.agents/skills/check/SKILL.md',type:'blob',mode:'100644',sha:'skill',size:8});
  await assert.rejects(rules.fetch(github,'a'.repeat(40)),{code:'invalid_rule_content'});
  rules.cache('101','b'.repeat(40),{});
  const put=await admin('/api/repositories/101/rules','PUT',{path:'.bot/guide.md',content:'Console guide'});
  assert.equal(put.status,410);assert.equal(put.value.error,'rules_update_removed');assert.match(put.value.detail,/manager\.update/);assert.match(put.value.detail,/roles\.update/);
  const apply=await admin('/api/repositories/101/rules/apply-computer','POST',{});assert.equal(apply.status,410);assert.equal(apply.value.error,'rules_update_removed');
  assert.equal(explainFailure('invalid_bot_label','waiting_configuration').label,'仓库内容或规则');
  assert.match(explainFailure('invalid_bot_computer','waiting_configuration').action,/已不再读取/);
});

test('a bad skill stops the task before publishing with its own code; bad .bot/ files no longer do',async t=>{
  const f=await repositoryFixture(t);
  f.heads.main=f.commit({'src/app.js':'export {};\n','.agents/skills/a/SKILL.md':'skill\0'});
  await f.hook(f.account.path,f.account.secret,'opened',{repository:{id:101},action:'opened',issue:f.issue});
  const taskId=f.store.get("SELECT id FROM tasks WHERE kind='review.issue'").id;
  const bad={
    invalid_rule_content:{'.agents/skills/a/SKILL.md':'skill\0'},
    too_many_bot_skills:Object.fromEntries(Array.from({length:33},(_,i)=>[`.agents/skills/s${i}/SKILL.md`,'Skill.'])),
    invalid_skill_file:{'.agents/skills/a/SKILL.md':{data:'../../etc/passwd',mode:'120000'}}};
  for(const [code,files] of Object.entries(bad)){
    f.heads.main=f.commit({'src/app.js':'export {};\n',...files});
    for(let i=0;i<2;i++){
      const task=await f.run(taskId);
      assert.equal(task.error_code,code);assert.equal(task.status,'waiting_configuration');assert.equal(task.phase,'prepare');assert.equal(f.comments.length,0);
    }
    // Waiting again for the same file does not repeat the entry; the entry names the file.
    assert.equal(f.logs(taskId).filter(log=>log.type==='fault'&&log.code===code).length,1);
    if(code==='invalid_rule_content')assert.match(f.logs(taskId).find(log=>log.type==='fault'&&log.code===code).detail,/^加载仓库 skill 失败（invalid_rule_content）：\.agents\/skills\/a\/SKILL\.md 不是文本文件（含 NUL 字节），/);
  }
  assert.ok(!f.logs(taskId).some(log=>log.type==='runtime_fault'));
  // Every .bot/ file that used to stop a task is only a name now: the waiting task prepares the new commit and publishes
  // with the project's labels.
  f.heads.main=f.commit({'src/app.js':'export {};\n','.bot/rules/labels.md':'review_label: '+'y'.repeat(51),'.bot/computer.yaml':'docker_socket: /var/run/docker.sock\n',
    '.bot/guide.md':{data:'../../etc/passwd',mode:'120000'},'.bot/rules/issue-review.md':'review\0'});
  const task=await f.run(taskId);
  assert.equal(task.status,'succeeded',task.error_code);assert.equal(task.error_code,null);assert.equal(JSON.parse(task.input).snapshot_sha,f.heads.main);
  assert.equal(f.comments.length,1);assert.deepEqual(f.labels,['bot-reviewed']);
});

test('an Issue development that continues the bot PR checks out its head and reads skills from its base branch',async t=>{
  const f=await repositoryFixture(t,{stopModel:true});
  f.heads.main=f.commit({'src/app.js':'export {};\n','.agents/skills/ci/SKILL.md':'Main skill'});
  f.heads.release=f.commit({'src/app.js':'export {};\n','.agents/skills/ci/SKILL.md':'Release skill'});
  const head=f.commit({'src/app.js':'export const fixed = true;\n','.agents/skills/ci/SKILL.md':'Skill written by the PR'});
  f.pr={id:55,number:7,state:'open',draft:false,user:{id:999},head:{sha:head,ref:'bot/issue-1-original',repo:{id:101}},base:{ref:'release'}};
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,phase) VALUES('original','101','development.issue','pr_opened','original','{}',1,'done')");
  f.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-original',?,'original',0)",head);
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at) VALUES('next','101','development.issue','queued','next',?,1,'2026-10-27T00:00:00Z')",JSON.stringify({review:{implementation_goal:'Fix the parser',requires_code_change:true}}));
  await f.run('next');
  const input=JSON.parse(f.store.get("SELECT input FROM tasks WHERE id='next'").input);
  assert.equal(input.snapshot_sha,head);assert.equal(f.logs('next').find(log=>log.type==='prepared').sha,head);
  assert.equal(f.store.get("SELECT sha FROM repository_rule_sources WHERE repository_id='101'").sha,f.heads.release);
  assert.equal(input.context.effective_rules.files.find(row=>row.path==='.agents/skills/ci/SKILL.md').effective,'Release skill');
});

// A project that had nothing cached at the upgrade imports its .bot/ files at its first task. That task, created before
// the import, works with the repository texts it would have read before the upgrade, and with the imported labels (#935).
test('a project waiting for its .bot/ import imports at its first task, which already uses those rules',async t=>{
  const f=await repositoryFixture(t);
  f.store.run("INSERT INTO rule_imports VALUES('101',NULL,NULL,1,'{}',NULL) ON CONFLICT(repository_id) DO UPDATE SET sha=NULL,pending=1");
  f.heads.main=f.commit({'src/app.js':'export {};\n','.bot/guide.md':'Imported guide.\n','.bot/rules/labels.md':'review_label: team-reviewed\n\n# Our labels\n'});
  await f.hook(f.account.path,f.account.secret,'opened',{repository:{id:101},action:'opened',issue:f.issue});
  const taskId=f.store.get("SELECT id FROM tasks WHERE kind='review.issue'").id,task=await f.run(taskId);
  assert.equal(task.status,'succeeded',task.error_code);
  assert.ok(f.config.system.includes('## Behavior guide (Manager section `guide`, console)\nImported guide.'));
  assert.ok(f.config.system.includes('## Labeling (Manager section `labels`, console)\nreview_label: team-reviewed\n\n# Our labels'));
  // The project's sections hold the imported texts for the tasks after it.
  const short=f.heads.main.slice(0,7);
  assert.equal(managerSection(f.store,'101','guide'),`由 \`.bot/guide.md\` 导入（提交 ${short}）。\n\nImported guide.`);
  assert.deepEqual(f.labels,['team-reviewed']);
  assert.equal(f.store.get("SELECT pending,sha FROM rule_imports WHERE repository_id='101'").sha,f.heads.main);
});

// The project's guide is its Manager section; the console text of a section is written through the Manager prompt.
const writeSection=(store,id,section,text)=>{const current=managerPrompt(store,id);saveManager(store,id,{expected_revision:current.revision,content:withSection(current.content,section,text)},null,'test');};

test('long rule sections and skills are sent whole',async t=>{
  const f=await repositoryFixture(t),skill=(name,bytes)=>[`.agents/skills/${name}/SKILL.md`,`# ${name}\n`+'s'.repeat(bytes-name.length-3)];
  // A real repository's skills (37 KB and more), well past the former 16 KiB limit, and a long behavior guide.
  writeSection(f.store,'101','guide','g'.repeat(40000));
  f.heads.main=f.commit({'src/app.js':'export {};\n',...Object.fromEntries([skill('a',37204),skill('b',70000),skill('c',200000)])});
  await f.hook(f.account.path,f.account.secret,'opened',{repository:{id:101},action:'opened',issue:f.issue});
  const taskId=f.store.get("SELECT id FROM tasks WHERE kind='review.issue'").id,task=await f.run(taskId);
  assert.equal(task.status,'succeeded',task.error_code);
  assert.ok(f.config.system.includes('## Behavior guide (Manager section `guide`, console)\n'+'g'.repeat(40000)));
  for(const [name,bytes] of [['a',37204],['b',70000],['c',200000]])assert.equal(Buffer.byteLength(f.context[`skills/${name}/SKILL.md`]),bytes,name);
  assert.equal(explainFailure('invalid_rule_content','waiting_configuration').label,'仓库内容或规则');
  assert.equal(explainFailure('bot_rule_too_large','waiting_configuration').action,explainFailure('invalid_bot_label','waiting_configuration').action);
});

test('the agent gets the rules and an index of the skills; the skills, the Issue and its discussion are files it reads when it needs them',async t=>{
  const f=await repositoryFixture(t),ci='---\nname: ci\ndescription: Read, diagnose and change the CI pipeline.\n---\n# CI\n'+'Run the checks. '.repeat(500);
  writeSection(f.store,'101','guide','Be brief.');
  f.heads.main=f.commit({'src/app.js':'export {};\n','.bot/guide.md':'Repository guide, no longer read.\n','.agents/skills/ci/SKILL.md':ci,'.agents/skills/deploy/SKILL.md':'# Deploy the stack\nSteps.\n'});
  await f.hook(f.account.path,f.account.secret,'opened',{repository:{id:101},action:'opened',issue:f.issue});
  const taskId=f.store.get("SELECT id FROM tasks WHERE kind='review.issue'").id,task=await f.run(taskId);
  assert.equal(task.status,'succeeded',task.error_code);
  // The behavior guide is in the system prompt; a skill only by name, with what it is for and where to read it.
  assert.ok(f.config.system.includes('## Behavior guide (Manager section `guide`, console)\nBe brief.'));assert.ok(!f.config.system.includes('Run the checks.'));
  assert.ok(!f.config.system.includes('Repository guide'));
  // The labels section carries the label the control plane applies, which its first line used to declare.
  assert.ok(f.config.system.includes('## Labeling (Manager section `labels`, builtin)\nreview_label: bot-reviewed\n\n# Labeling'));
  const prompt=JSON.parse(f.config.prompt);
  assert.deepEqual(prompt.skills,[{name:'ci',description:'Read, diagnose and change the CI pipeline.',path:'../context/skills/ci/SKILL.md'},{name:'deploy',description:'Deploy the stack',path:'../context/skills/deploy/SKILL.md'}]);
  assert.deepEqual(prompt.context_files.map(file=>file.path),['../context/object.json','../context/comments.json']);
  assert.deepEqual([prompt.object.title,prompt.object.body_excerpt,prompt.comments,prompt.files,prompt.materials,prompt.pull_request],['Fix the parser','Please fix the parser.',undefined,undefined,undefined,undefined]);
  // The files hold everything, the skills in full.
  assert.equal(f.context['skills/ci/SKILL.md'],ci);assert.equal(JSON.parse(f.context['object.json']).body,'Please fix the parser.');assert.deepEqual(JSON.parse(f.context['comments.json']),[]);
});

test('a skill is indexed by its front matter description, or else its first line',()=>{
  assert.deepEqual(skillIndex([{path:'.agents/skills/a/b/SKILL.md',source:'repository',effective:'---\ndescription: "Nested skill: does b"\n---\nBody'},
    {path:'.agents/skills/plain/SKILL.md',source:'repository',effective:'\n## Plain heading\nmore'},{path:'.bot/guide.md',source:'builtin',effective:'guide'}]).map(({name,description,path})=>[name,description,path]),
    [['a/b','Nested skill: does b','../context/skills/a/b/SKILL.md'],['plain','Plain heading','../context/skills/plain/SKILL.md']]);
});
