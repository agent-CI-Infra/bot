// Real Git + runner + SQLite + engine/publication; GitHub and the repair model are controlled transports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../dist/storage/database.js';
import {LocalManager} from '../dist/projects/local-manager.js';
import {TaskEngine} from '../dist/agent/engine.js';
import {Workspace} from '../dist/agent/workspace.js';
import {GitHub} from '../dist/github/client.js';
import {Redactor} from '../dist/agent/common.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {roleInstance} from '../dist/roles/run.js';
import {checkpoint} from '../dist/tasks/checkpoint.js';
import {candidateKey,deliveryCandidate,latestRoleCandidate} from '../dist/roles/schedule.js';
import {acceptanceFixture} from './acceptance-fixture.mjs';
import {randomWorkspaceId} from './helpers.mjs';

const toolCall=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:randomBytes(8).toString('hex'),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
export async function fixture(t,mode='clean',options={}){
 const root=mkdtempSync(join(tmpdir(),'bot-integration-engine-')),gitDir=join(root,'remote.git'),computer=join(root,'computer'),key=randomBytes(32);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(args,input,env={})=>execFileSync('git',['--git-dir='+gitDir,...args],{input,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',...env},stdio:['pipe','pipe','pipe']}).trim();
 execFileSync('git',['init','--bare',gitDir],{stdio:'ignore'});
 const makeTree=(files,base=null)=>{const index=join(root,'index-'+randomBytes(8).toString('hex')),env={GIT_INDEX_FILE:index};if(base)git(['read-tree',base],undefined,env);for(const [path,value] of Object.entries(files)){if(value===null)git(['update-index','--force-remove','--',path],undefined,env);else{const blob=git(['hash-object','-w','--stdin'],value);git(['update-index','--add','--cacheinfo','100644',blob,path],undefined,env);}}return git(['write-tree'],undefined,env);};
 const files={'a.txt':'1','b.txt':'1','calc.cjs':"const fs=require('fs');module.exports=Number(fs.readFileSync('a.txt'))*Number(fs.readFileSync('b.txt'));",'check.cjs':"if(require('./calc.cjs')>2)process.exit(1);"};
 const treeA=makeTree(files),base=git(['commit-tree',treeA], 'base\n');git(['update-ref','refs/heads/main',base]);
 let main=base,pr=null,puts=0,branchWrites=0,modelCalls=0,devStep=0,managerStep=0,knownRef=null,factsWait=null,factsEntered=false,staleBase=false,failedChecks=options.failedChecks??0;
 const server=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{},url=new URL(req.url,'http://fixture'),p=url.pathname;
  const send=(v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
  if(p==='/v1/chat/completions'){
   modelCalls++;let message;
   if(options.respond)message=await options.respond(body);
   else if(body.tools.some(t=>t.function.name==='submit_retry_decision'))message=toolCall('submit_retry_decision',{action:options.retryDecision??'continue_retry',reason:'Read the repeated CI failures; choose the next action'});
   else if(body.tools.some(t=>t.function.name==='delegate_role')){
    if(mode==='qa-return')assert.match(JSON.stringify(body.messages),/QA_REPAIR_REQUIRED/,'Manager receives the returned QA finding');
    if(managerStep++===0)message=toolCall('delegate_role',{role:'dev',purpose:'Repair the retained integrated candidate using current failure/conflict evidence; preserve both features.',refs:['task:t']});
    else {const last=body.messages.at(-1);knownRef=JSON.parse(last.content).result_ref;message=toolCall('nominate_delivery',{result_ref:knownRef});}
   }else if(body.tools.some(t=>t.function.name==='submit_delivery')){
    if(mode==='unchanged')message=toolCall('submit_delivery',{summary:'The recovered tree already satisfies the goal',test_command:'node check.cjs'});
    else if(mode==='qa-return')message=devStep++===0?toolCall('write_file',{path:'regression.cjs',content:'module.exports=1;'}):toolCall('submit_delivery',{summary:'Removed the conflict markers from the existing PR',test_command:'node check.cjs'});
    else if(devStep++===0)message=mode==='conflict'?toolCall('write_file',{path:'a.txt',content:'2'}):toolCall('write_file',{path:'calc.cjs',content:"const fs=require('fs');module.exports=Math.min(2,Number(fs.readFileSync('a.txt'))*Number(fs.readFileSync('b.txt')));"});
    else message=toolCall('submit_delivery',{summary:'Reconciled combined behavior',test_command:'node check.cjs'});
   }else throw Error('Unexpected model execution');
   return send({choices:[{message}]});
  }
  if(p==='/user')return send({id:999,login:'fixture-bot'});
  if(p==='/repositories/101')return send({id:101,owner:{id:10},full_name:'fixture/project',default_branch:'main'});
  if(p.endsWith('/rules/branches/main')){if(factsWait){factsEntered=true;await factsWait;}return send([]);}
  if(p.endsWith('/branches/main'))return send({protected:false});
  if(p.endsWith('/issues/7'))return send({number:7,state:'open',title:'Implement fixture feature',body:'Keep bounded totals and preserve all features.',labels:[{name:'bot-develop'}],assignees:[]});
  if(p.endsWith('/labels'))return send(req.method==='POST'?(body.labels||[]).map(name=>({name})):[]);
  if(p.endsWith('/comments'))return send(req.method==='POST'?{id:1,html_url:'https://github.invalid/comment',body:body.body,user:{id:999}}:[]);
  if(p.includes('/git/ref/heads/')){const name=decodeURIComponent(p.split('/git/ref/heads/')[1]);try{return send({object:{sha:git(['rev-parse','refs/heads/'+name])}});}catch{return send({},404);}}
  if(p.endsWith('/git/refs')||p.includes('/git/refs/heads/')){
   const ref=body.ref||'refs/heads/'+decodeURIComponent(p.split('/git/refs/heads/')[1]);
   if(req.method==='PATCH'&&body.force===false){try{git(['merge-base','--is-ancestor',git(['rev-parse',ref]),body.sha]);}catch{return send({message:'non fast forward'},422);}}
   git(['update-ref',ref,body.sha]);branchWrites++;return send({ref,object:{sha:body.sha}});
  }
  if(p.endsWith('/git/blobs')&&req.method==='POST')return send({sha:git(['hash-object','-w','--stdin'],Buffer.from(body.content,body.encoding==='base64'?'base64':'utf8'))});
  if(p.includes('/git/blobs/'))return send({encoding:'base64',content:Buffer.from(git(['cat-file','blob',p.split('/').at(-1)])).toString('base64')});
  if(p.endsWith('/git/trees')&&req.method==='POST'){
   const index=join(root,'index-'+randomBytes(8).toString('hex')),env={GIT_INDEX_FILE:index};if(body.base_tree)git(['read-tree',body.base_tree],undefined,env);
   for(const f of body.tree){if(f.sha===null)git(['update-index','--force-remove','--',f.path],undefined,env);else git(['update-index','--add','--cacheinfo',f.mode,f.sha,f.path],undefined,env);}
   return send({sha:git(['write-tree'],undefined,env)});
  }
  if(p.includes('/git/trees/')){const tree=p.split('/').at(-1);const entries=git(['ls-tree','-rl',tree]).split('\n').filter(Boolean).map(line=>{const [metadata,path]=line.split('\t'),[mode,type,sha,size]=metadata.split(/\s+/);return {path,mode,type,sha,size:Number(size)};});return send({sha:tree,tree:entries,truncated:false});}
  if(p.endsWith('/git/commits')&&req.method==='POST'){const commit=git(['commit-tree',body.tree,...body.parents.flatMap(p=>['-p',p])],body.message+'\n');return send({sha:commit,tree:{sha:body.tree}});}
  if(p.includes('/git/commits/')){const commit=p.split('/').at(-1);return send({sha:commit,tree:{sha:git(['rev-parse',commit+'^{tree}'])}});}
  const currentPR=()=>({...pr,head:{sha:git(['rev-parse','refs/heads/'+pr.head.ref]),ref:pr.head.ref,repo:{id:101}},base:{ref:'main',sha:staleBase?base:main}});
  if(p.endsWith('/pulls')&&req.method==='POST'){pr={id:1,node_id:'PR_fixture',number:1,state:'open',draft:false,user:{id:999},head:{ref:body.head},title:body.title,body:body.body,html_url:'https://github.invalid/pull/1'};return send(currentPR());}
  if(p.endsWith('/pulls/1')){if(req.method==='PATCH')Object.assign(pr,body);return send(currentPR());}
  if(p.endsWith('/check-runs'))return send({check_runs:failedChecks-->0?[{id:99,name:'Install packages',status:'completed',conclusion:'failure'}]:[]});
  if(p.endsWith('/status'))return send({state:'pending',statuses:[]});
  if(p.endsWith('/pulls/1/merge')&&req.method==='PUT'){
   assert.equal(body.sha,currentPR().head.sha);const tree=git(['rev-parse',body.sha+'^{tree}']);
   main=git(['commit-tree',tree,'-p',main,'-p',body.sha],'merge\n');git(['update-ref','refs/heads/main',main]);pr.merged=true;pr.state='closed';pr.merge_commit_sha=main;puts++;return send({merged:true,sha:main});
  }
  return send({},404);
 }catch(e){res.writeHead(500);res.end(JSON.stringify({message:e.message}));}});server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint='http://127.0.0.1:'+server.address().port;
 const s=new Store(join(root,'control.sqlite'),key);t.after(()=>{s.close();server.closeAllConnections();server.close();});
 s.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)','account','fixture','bot_account',null,s.secrets.seal({token:'fixture-token-for-GitHub'},'account:account'),'');s.run("INSERT INTO repositories VALUES('101','fixture/project','10','account')");
 s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','101',endpoint+'/v1','fixture',s.secrets.seal({value:'fixture-model-key'},'model:m'),'');
 s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,test_command) VALUES('101','m',1,1,'node check.cjs')");
 s.run("INSERT INTO settings VALUES('roles:101',?)",JSON.stringify({enabled:true,harnesses:{},roles:[]}));
 const workspaceId=randomWorkspaceId(),input={object_hash:null,base_branch:'main',snapshot_sha:base,snapshot_tree:treeA,source_tree:treeA,context:{implementation_goal:'Keep bounded totals and preserve all features.'}};
 s.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,phase,summary,input,workspace_id,generation,head_sha,created_at) VALUES('t','101','development.issue',7,'queued','publish','fixture',?,?,1,?,?)",JSON.stringify(input),workspaceId,base,new Date().toISOString());
 const records=new TaskRecords(s);records.contract('t',{goal:'Keep bounded totals and preserve all features.',scope:['fixture'],criteria:['No feature lost; bounded total'],endpoint:'reviewable_pull_request'});
 const manager=new LocalManager('101',computer);await manager.call('PUT','/v1/projects/101');
 const task=s.get("SELECT * FROM tasks WHERE id='t'"),space=new Workspace(s,manager,task,new Redactor(),async()=>{},()=>{}),gh=new GitHub(s,s.get("SELECT * FROM repositories WHERE id='101'"),new Redactor(),async()=>{},endpoint);await gh.connect(true);
 const snapshot=await space.prepare(gh,base);await space.write('change-a','a.txt',Buffer.from('2'));
 if(mode==='qa-return')await space.write('conflict-marker','regression.cjs',Buffer.from('<<<<<<< ours\nmodule.exports=1;\n=======\nmodule.exports=2;\n>>>>>>> theirs\n'));
 const candidate=await space.artifact('original-candidate');
 s.run("INSERT INTO bot_branches VALUES('101','bot/issue-7-t','t')");s.run('INSERT INTO development_candidates VALUES(?,?)','t',JSON.stringify({...candidate,files:await space.contents(candidate.files,snapshot.files),source_tree:treeA,snapshot_files:snapshot.files,skipped_files:[],base_sha:base,base_branch:'main',branch:'bot/issue-7-t',owner_task_id:'t',expected_sha:null,pr_number:null,date:new Date().toISOString(),summary:'feature a',test_command:'node check.cjs',validation:{source:'policy',exit_code:0,command:'node check.cjs'}}));
 const instance=roleInstance(s,task,'dev');s.run('UPDATE role_instances SET sequence=1 WHERE id=?',instance.id);
 // Another PR advances main before this task publishes. The old fence rejected even this PR creation.
 const changes=['clean','qa-return'].includes(mode)?{'other.txt':'independent feature'}:mode==='conflict'?{'a.txt':'3'}:{'b.txt':'2'};
 const treeB=makeTree(changes,treeA);main=git(['commit-tree',treeB,'-p',base],'other feature\n');git(['update-ref','refs/heads/main',main]);
 let qaCalls=0;const engine=new TaskEngine(s,manager,endpoint,undefined,async(...args)=>{qaCalls++;if(options.evaluate)return options.evaluate(qaCalls,...args);if(mode==='qa-return'&&qaCalls===2){const raw=await args[2].call('fixture-conflict-read',{type:'workspace_read',path:'regression.cjs'});assert.match(raw.content,/<<<<<<< ours/);return {outcome:'return',reason:'QA_REPAIR_REQUIRED: regression.cjs contains conflict markers',gaps:['Remove the conflict markers and validate the existing PR'],residuals:[],core_complete:false,required_evidence_complete:true,acceptable_risk:false};}return acceptanceFixture(...args);});t.after(()=>engine.close());
 return {root,s,engine,key,manager,endpoint,space,pauseFacts(){let release;factsWait=new Promise(r=>release=r);return ()=>{factsWait=null;release();};},get factsEntered(){return factsEntered;},set stalePRBase(value){staleBase=value;},dev:instance.id,get main(){return main;},git,counts:()=>({puts,branchWrites,modelCalls,qaCalls})};
}

test('a model-phase restart with a pending integration uses one no_changes source identity',async t=>{
 const h=await fixture(t,'unchanged'),task=h.s.get("SELECT * FROM tasks WHERE id='t'"),snapshot=await h.space.artifact('before-crash');
 const input={...JSON.parse(task.input),snapshot_sha:h.main,snapshot_tree:snapshot.tree_sha,source_tree:snapshot.tree_sha,integration:{id:'fixture',state:'applied',target_base:h.main}};
 h.s.run("UPDATE tasks SET phase='model',input=? WHERE id='t'",JSON.stringify(input));
 // A checkpoint changes the persisted integration to pending. A process restart retains phase=model.
 await checkpoint(h.s,{...task,input:JSON.stringify(input)},h.space);
 assert.equal(JSON.parse(h.s.get("SELECT input FROM tasks WHERE id='t'").input).integration.state,'pending');
 assert.notEqual(task.head_sha,h.main);h.engine.tick();await Promise.all(h.engine.active.values());
 const result=h.s.get("SELECT * FROM tasks WHERE id='t'");assert.equal(result.status,'completed',JSON.stringify(result));
 const role=latestRoleCandidate(h.s,'t'),delivery=deliveryCandidate(new TaskRecords(h.s).get('t').candidate);
 assert.equal(role.kind,'no_changes');assert.equal(role.source_ref,'commit:'+task.head_sha);
 assert.equal(delivery.source_ref,role.source_ref);assert.equal(candidateKey(delivery),candidateKey(role));
 assert.equal(h.counts().branchWrites,0);assert.equal(h.counts().qaCalls,1);
});
for(const mode of ['clean','conflict','semantic'])test(`full engine ${mode}: stale-base publication, integration, fresh QA and authorized merge`,async t=>{
 const h=await fixture(t,mode);h.engine.tick();await Promise.all(h.engine.active.values());
 let task=h.s.get("SELECT * FROM tasks WHERE id='t'");assert.equal(task.status,'pr_opened',JSON.stringify(task));assert.equal(h.counts().puts,0);
 h.stalePRBase=true; // GitHub PR metadata deliberately lags the live default-branch ref.
 const before=h.counts().modelCalls,result=await h.engine.api({id:'operator',role:'super_admin',repositories:[]},'POST',new URL('http://local/api/tasks/t/merge'),{expected_sha:JSON.parse(task.result).sha,merge_method:'squash'});
 assert.equal(result.status,'integrating');assert.equal(result.merged,false);
 h.s.run("UPDATE tasks SET next_run_at=0 WHERE id='t'");h.engine.tick();await Promise.all(h.engine.active.values());
 task=h.s.get("SELECT * FROM tasks WHERE id='t'");assert.ok(['completed','pr_opened'].includes(task.status),JSON.stringify(task));
 if(process.env.DEBUG_INTEGRATION)console.error(mode,h.counts(),h.s.all("SELECT data FROM task_history WHERE type IN ('integration_result','integration_validation')").map(r=>JSON.parse(r.data)),h.s.all('SELECT id,role,sequence FROM role_instances'));
 if(mode==='clean')assert.equal(h.counts().modelCalls,before,'clean integration should not ask the developer to reimplement');
 else{assert.equal(h.s.get('SELECT sequence FROM role_instances WHERE id=?',h.dev).sequence,2);assert.ok(h.counts().modelCalls>before);}
 assert.equal(h.counts().qaCalls,2,'new integrated candidate needs fresh QA');
 h.s.run('UPDATE task_merge_requests SET next_run_at=0');h.engine.tick();await Promise.all(h.engine.merging?.values()||[]);
 assert.equal(h.counts().puts,1);assert.equal(h.s.get("SELECT count(*) n FROM task_history WHERE type='repository_evolved'").n,1);
 if(process.env.DEBUG_INTEGRATION)console.error(mode,h.counts(),h.s.all("SELECT data FROM task_history WHERE type IN ('integration_result','integration_validation')").map(r=>JSON.parse(r.data)),h.s.all('SELECT id,role,sequence FROM role_instances'));
 if(mode==='clean')assert.equal(h.git(['show',h.main+':other.txt']),'independent feature');
 if(mode==='semantic')assert.equal(h.git(['show',h.main+':b.txt']),'2');
 assert.equal(h.s.get("SELECT state FROM task_merge_requests WHERE task_id='t'").state,'merged');
});

test('QA return after an existing PR resumes Manager/Dev and updates that PR before merging',async t=>{
 const h=await fixture(t,'qa-return');h.engine.tick();await Promise.all(h.engine.active.values());
 const original=h.s.get("SELECT * FROM tasks WHERE id='t'"),first=JSON.parse(original.result);
 await h.engine.api({id:'operator',role:'super_admin',repositories:[]},'POST',new URL('http://local/api/tasks/t/merge'),{expected_sha:first.sha,merge_method:'merge'});
 h.s.run("UPDATE tasks SET next_run_at=0 WHERE id='t'");h.engine.tick();await Promise.all(h.engine.active.values());
 const returned=h.s.get("SELECT * FROM tasks WHERE id='t'");
 assert.equal(returned.status,'queued');assert.notEqual(returned.error_code,'acceptance_publication_changed');assert.equal(h.counts().puts,0);
 h.s.run("UPDATE tasks SET next_run_at=0 WHERE id='t'");h.engine.tick();await Promise.all(h.engine.active.values());
 const repaired=h.s.get("SELECT * FROM tasks WHERE id='t'");assert.ok(['completed','pr_opened'].includes(repaired.status),JSON.stringify(repaired));
 assert.equal(JSON.parse(repaired.result).pr_number,first.pr_number);assert.notEqual(JSON.parse(repaired.result).sha,first.sha);
 assert.equal(h.counts().qaCalls,3);assert.ok(h.counts().modelCalls>0);assert.equal(h.s.get('SELECT count(*) n FROM bot_pull_requests').n,1);
 h.s.run('UPDATE task_merge_requests SET next_run_at=0');h.engine.tick();await Promise.all(h.engine.merging.values());
 assert.equal(h.counts().puts,1);assert.equal(h.git(['show',h.main+':other.txt']),'independent feature');
 assert.equal(h.git(['show',h.main+':regression.cjs']),'module.exports=1;');
});

for(const decision of ['continue_retry','investigate'])test(`three failed CI integrations notify Manager, which can ${decision}`,async t=>{
 const h=await fixture(t,'clean',{failedChecks:3,retryDecision:decision});h.engine.tick();await Promise.all(h.engine.active.values());
 // The first integration is for the already advanced main, followed by three actual failed-CI attempts.
 for(let attempt=0;attempt<=3;attempt++){
  const task=h.s.get("SELECT * FROM tasks WHERE id='t'");
  const result=await h.engine.api({id:'operator',role:'super_admin',repositories:[]},'POST',new URL('http://local/api/tasks/t/merge'),{expected_sha:JSON.parse(task.result).sha,merge_method:'merge'});
  assert.equal(result.status,'integrating');h.s.run("UPDATE tasks SET next_run_at=0 WHERE id='t'");h.engine.tick();await Promise.all(h.engine.active.values());
 }
 const reports=h.s.all("SELECT data FROM task_history WHERE type='retry_report'").map(r=>JSON.parse(r.data));assert.deepEqual(reports.map(r=>r.count),[3]);
 const decided=h.s.get("SELECT data FROM task_history WHERE type='retry_decision'");assert.equal(JSON.parse(decided.data).action,decision);
 const task=h.s.get("SELECT * FROM tasks WHERE id='t'");assert.ok(['completed','pr_opened'].includes(task.status),JSON.stringify(task));
 assert.equal(h.s.get("SELECT sequence FROM role_instances WHERE id=?",h.dev).sequence,decision==='investigate'?2:1);
 h.s.run('UPDATE task_merge_requests SET next_run_at=0');h.engine.tick();await Promise.all(h.engine.merging.values());assert.equal(h.counts().puts,1);
});


test('an overlapping background merge poll cannot replace or block an integration already requested',async t=>{
 const h=await fixture(t,'clean');h.engine.tick();await Promise.all(h.engine.active.values());
 const task=h.s.get("SELECT * FROM tasks WHERE id='t'"),resume=h.pauseFacts();
 const initial=h.engine.api({id:'operator',role:'super_admin',repositories:[]},'POST',new URL('http://local/api/tasks/t/merge'),{expected_sha:JSON.parse(task.result).sha,merge_method:'squash'});
 for(let n=0;n<100&&!h.factsEntered;n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(h.factsEntered,true);h.s.run('UPDATE task_merge_requests SET next_run_at=0');h.engine.tick();
 assert.equal(h.engine.merging.size,1);resume();assert.equal((await initial).status,'integrating');await Promise.all(h.engine.merging.values());
 assert.equal(h.s.get("SELECT count(*) n FROM task_history WHERE type='integration_requested'").n,1);
 assert.equal(h.s.get("SELECT state FROM task_merge_requests WHERE task_id='t'").state,'integrating');
 assert.equal(h.s.get("SELECT attempt FROM tasks WHERE id='t'").attempt,2);
});

for(const revoked of [false,true])test(`persisted scoped merge intent refreshes current task-write grants (revoked=${revoked})`,async t=>{
 const {identityProjection}=await import('../dist/identity/storage.js');
 const h=await fixture(t,'clean');h.engine.tick();await Promise.all(h.engine.active.values());
 h.s.run("INSERT INTO users VALUES('member','member','fixture-password-hash','project_admin',1)");identityProjection(h.s);
 h.s.run("INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at) VALUES('grant','member','github.com:10','101','project','project_admin',?,'explicit','manual','fixture',?)",JSON.stringify(['tasks.read','tasks.write']),Date.now());
 const operator={id:'member',role:'project_admin',repositories:['101'],context:{principal_id:'member',tenant_id:null}},task=h.s.get("SELECT * FROM tasks WHERE id='t'");
 await h.engine.api(operator,'POST',new URL('http://local/api/tasks/t/merge'),{expected_sha:JSON.parse(task.result).sha,merge_method:'squash'});
 h.s.run("UPDATE tasks SET next_run_at=0 WHERE id='t'");h.engine.tick();await Promise.all(h.engine.active.values());
 if(revoked)h.s.run("UPDATE scoped_grants SET revoked_at=? WHERE id='grant'",Date.now());
 h.s.run('UPDATE task_merge_requests SET next_run_at=0');h.engine.tick();await Promise.all(h.engine.merging.values());
 assert.equal(h.counts().puts,revoked?0:1);
 assert.equal(h.s.get("SELECT state FROM task_merge_requests WHERE task_id='t'").state,revoked?'blocked':'merged');
});
