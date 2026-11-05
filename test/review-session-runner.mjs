// Run with: npm ci --prefix runner && node --test test/review-session-runner.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';
import {queueWebhook} from '../dist/review/queue.js';
import {workspace} from '../runner/workspace.mjs';
import {pruneTasks} from '../runner/store.mjs';

const text=message=>typeof message.content==='string'?message.content:message.content.map(block=>block.text||'').join('');
const actor={type:'User',login:'alice',id:5};
const result=summary=>({summary,findings:[],requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:''});
const call=(name,args)=>({id:'call-'+Math.random().toString(16).slice(2),type:'function',function:{name,arguments:JSON.stringify(args)}});
async function until(read){
  for(const end=Date.now()+15000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,20))){const value=await read();if(value)return value;}
  assert.fail('Timed out waiting for runner');
}
async function live(t,options={}){
  await mkdir('.tmp',{recursive:true});const base=await mkdtemp(resolve('.tmp/review-session-')),children=new Map(),requests=[],operations=[];
  t.after(()=>rm(base,{recursive:true,force:true}));
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href,hook=join(base,'hooks.mjs');
  await writeFile(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  let h,sequence=0,object={number:1,state:'open',title:'First issue',body:'Please review this project.',user:{id:5,login:'alice'},labels:[]};
  if(options.pr)object={...object,draft:false,base:{ref:'main',sha:'a'.repeat(40)},head:{ref:'change',sha:'a'.repeat(40)}};
  const pushHead=sha=>{object={...object,head:{...object.head,sha}};return queueWebhook(h.store,'101','pull_request',{action:'synchronize',pull_request:object,sender:actor},'head-'+sha);};
  const update=(text,mention=false)=>{
    object={...object,title:'Latest title '+text,body:'Latest body '+text};
    const comment={id:++sequence,body:(mention?'@bot ':'')+text,user:actor,author_association:'MEMBER'};h.comments.push(comment);
    return queueWebhook(h.store,'101','issue_comment',{action:'created',issue:options.pr?{...object,pull_request:{}}:object,comment,sender:actor},'update-'+sequence,options.pr?object:undefined);
  };
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);requests.push(request);
    const response=await options.model?.(request,requests.length,{update,pushHead,base,h});
    res.writeHead(response?.status||200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(response?.body||{choices:[{message:{role:'assistant',content:null,tool_calls:[call('finish_review',result('Done '+requests.length))]}}],usage:{prompt_tokens:options.inputTokens||100,completion_tokens:20}}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  h=await emptyRepositoryFixture(t,{files:[],github:async(path,send,res,body)=>{
    if(options.pr&&/\/pulls\/1\/(files|reviews|comments)$/.test(path)){send([]);return true;}
    if(options.pr&&path.includes('/git/commits/')&&!path.endsWith('a'.repeat(40))){send({tree:{sha:'4b825dc642cb6eb9a060e54bf8d69288fbee4904'}});return true;}
    if(path.endsWith(options.pr?'/pulls/1':'/issues/1')){await options.objectRead?.({h,update,object});send(object);return true;}
    return options.github?.(path,send,res,body,{h,update});
  },execute:async request=>{
    operations.push(request);const root=join(base,request.workspace_id||''),dir=join(root,'agent');
    await options.execute?.(request,{h,update,base});
    if(request.type==='workspace_agent_start'){
      await writeFile(join(dir,'state.json'),JSON.stringify({state:'starting'}));
      const child=spawn(process.execPath,['--import',hook,'runner/pi-entry.mjs',root],{env:{...process.env,BOT_RUNNER_TEST_ROOT:base},stdio:['ignore','pipe','pipe']});
      let output='';child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>output+=chunk);
      const closed=once(child,'close');children.set(request.workspace_id,{child,closed,output:()=>output});return {ok:true,result:{started:true}};
    }
    if(request.type==='reap'){
      const process=children.get(request.workspace_id);if(process){process.child.kill('SIGKILL');await process.closed;children.delete(request.workspace_id);}return {ok:true,result:{reaped:true}};
    }
    try{return {ok:true,result:await workspace(request,base,join(base,'git'),join(base,'project-notes'))};}
    catch(error){return {ok:false,error:error.message};}
  }});
  t.after(async()=>{for(const {child,closed} of children.values()){child.kill('SIGKILL');await closed;}});
  h.setBranch('ready');
  if(options.pr)h.store.run("UPDATE tasks SET kind='review.pr',head_sha=?,unique_key=?,input=? WHERE id=?",object.head.sha,'101:review.pr:1:'+object.head.sha,JSON.stringify({pull_request:object}),h.taskId);
  const model=(await h.admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'session-fixture-key',model_name:'fixture'})).value.model;
  await h.admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  const run=async()=>{h.engine.tick();await Promise.all(h.engine.active.values());return h.store.all('SELECT * FROM tasks ORDER BY rowid');};
  return {h,base,requests,operations,update,pushHead,run,until,root:id=>join(base,id),object:()=>object};
}

test('real Pi completes concurrent repository tools, keeps local reads parallel and recovers from oversized results',async t=>{
  let d,checkedParallel=false;const grants=[];
  d=await live(t,{execute:async(request,{base})=>{
    if(request.type==='workspace_agent_repository_tool'&&!checkedParallel){
      // The first repository reply waits for read_file: making all Pi tools sequential would deadlock here.
      await until(async()=>{const events=await readFile(join(base,request.workspace_id,'agent/events.jsonl'),'utf8');return events.split('\n').filter(Boolean).map(JSON.parse).some(event=>event.type==='tool'&&event.name==='read_file');});
      checkedParallel=true;
    }
  },github:async(path,send,_res,body)=>{
    if(path==='/app'){send({slug:'fixture-app'});return true;}
    if(path==='/users/fixture-app%5Bbot%5D'){send({id:999,login:'fixture-app[bot]'});return true;}
    if(path.endsWith('/installation')){send({id:55,account:{id:10},permissions:{contents:'read',issues:'write',pull_requests:'write',actions:'read',metadata:'read'}});return true;}
    if(path.endsWith('/access_tokens')){grants.push(body);send({token:'exploration-token-'+grants.length,expires_at:'2099-01-01T00:00:00Z',permissions:body.permissions});return true;}
    if(path==='/installation/token'){send({});return true;}
    if(path.endsWith('/contents/package.json')){send({encoding:'base64',content:Buffer.from('{"scripts":{"build":"compiler"}}').toString('base64')});return true;}
    if(path.endsWith('/issues/42/comments')){send([{body:'Related dependency discussion'}]);return true;}
    if(path.endsWith('/pulls/9/files')){send([{filename:'package.json',patch:'- compiler'}]);return true;}
    if(path.endsWith('/git/trees/'+'c'.repeat(40))){send({tree:[{path:'x'.repeat(2*1024*1024)}]});return true;}
  },model:async(request,n)=>{
    const history=JSON.stringify(request.messages);assert.ok(!history.includes('exploration-token-'));
    if(n===3){assert.match(history,/compiler/);assert.match(history,/Related dependency discussion/);assert.match(history,/- compiler/);}
    if(n===4)assert.match(history,/repository_result_too_large/);
    const calls=n===1?[call('github_read_token',{})]:n===2?[
      call('github_read',{path:'/contents/package.json'}),call('github_read',{path:'/issues/42/comments'}),call('github_read',{path:'/pulls/9/files'}),call('read_file',{path:'../context/object.json'})
    ]:n===3?[call('github_read',{path:'/git/trees/'+'c'.repeat(40)+'?recursive=1'})]:[call('finish_review',result('Checked the related source, Issue #42 and PR #9.'))];
    return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:calls}}]}};
  }});
  const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const repo=d.h.store.get("SELECT * FROM repositories WHERE id='101'");
  d.h.store.run("UPDATE accounts SET type='github_app',app_id='123',credentials=? WHERE id=?",d.h.store.secrets.seal({private_key:pem},'account:'+repo.account_id),repo.account_id);
  const [task]=await d.run();
  assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.equal(d.requests.length,4);assert.ok(checkedParallel);assert.ok(d.operations.some(o=>o.type==='workspace_agent_repository_tool'));
  assert.ok(grants.some(g=>g.permissions.contents==='read'&&g.permissions.issues==='read'&&Object.values(g.permissions).every(v=>v==='read')));
  assert.ok(d.h.comments.some(c=>c.body.includes('Issue #42')));
});

test('real Pi keeps 26 waiting updates, injects after a model request and tool results, then restores only successful history',async t=>{
  let releaseRequest,requestStarted,releaseTool;
  const requestGate=new Promise(resolve=>releaseRequest=resolve),requestSeen=new Promise(resolve=>requestStarted=resolve);
  const d=await live(t,{model:async(request,n,{base,h,update})=>{
    if(n===1){requestStarted();await requestGate;return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:[call('run_command',{command:'while [ ! -f release ]; do sleep 0.02; done; printf tool-finished'})]}}]}};}
    if(n===2){
      const last=request.messages.slice(-4);assert.deepEqual(last.map(m=>m.role),['tool','user','user','user']);
      assert.match(text(last[0]),/tool-finished/);assert.match(text(last[1]),/during HTTP/);assert.match(text(last[2]),/second during HTTP/);assert.match(text(last[3]),/during tool/);
      const task=h.store.get("SELECT * FROM tasks WHERE status='running'");
      assert.match(await readFile(join(base,task.workspace_id,'context/comments.json'),'utf8'),/during tool/);
      return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:[call('write_file',{path:'../notes/repository.md',content:'Stable project note'})]}}]}};
    }
  }});
  for(let i=0;i<26;i++)assert.equal(d.update('waiting '+i,i%2===0),0);
  const work=d.run();await requestSeen;
  assert.match(text(d.requests[0].messages.at(-1)),/Latest title waiting 25/);
  assert.equal(JSON.parse(text(d.requests[0].messages.at(-1))).merged_updates.length,26);
  assert.equal(d.update('during HTTP'),0);assert.equal(d.update('second during HTTP',true),0);releaseRequest();
  await until(async()=>{
    const task=d.h.store.get("SELECT * FROM tasks WHERE status='running'");
    const events=await readFile(join(d.base,task.workspace_id,'agent/events.jsonl'),'utf8').catch(()=>'');
    if(!events.includes('"name":"run_command"'))return false;
    releaseTool=()=>writeFile(join(d.base,task.workspace_id,'repo/release'),'');return true;
  });
  assert.equal(d.update('during tool'),0);await releaseTool();
  const [first]=await work;assert.equal(first.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.equal(d.h.store.all('SELECT * FROM tasks').length,1);assert.equal(d.h.store.all('SELECT * FROM model_requests').length,3);
  const saved=d.h.store.get('SELECT * FROM review_sessions');assert.ok(JSON.parse(saved.messages).some(m=>m.role==='toolResult'));assert.equal(first.messages,null);
  // A clean cache is reused. Notes advance independently of the model history.
  await rm(join(d.base,first.workspace_id,'repo/release'));
  assert.equal(d.update('next successful review'),1);const tasks=await d.run();assert.equal(tasks.at(-1).status,'succeeded');
  assert.equal(tasks.at(-1).workspace_id,first.workspace_id);
  assert.match(JSON.stringify(d.requests.at(-1).messages),/during tool/);
  assert.match(JSON.stringify(d.requests.at(-1).messages.at(-1)),/Historical code conclusions/);
  assert.equal(await readFile(join(d.base,'project-notes/repository.md'),'utf8'),'Stable project note');
  // Three-day pruning affects only the checkout; the control-plane conversation survives.
  assert.equal((await pruneTasks(d.base+'/',undefined,Date.now()+4*86400000,join(d.base,'git'))).removed,1);
  assert.equal(d.update('after container cache loss'),1);const third=(await d.run()).at(-1);
  assert.equal(third.status,'succeeded');assert.notEqual(third.workspace_id,first.workspace_id);
  assert.match(JSON.stringify(d.requests.at(-1).messages),/next successful review/);
  d.h.setGeneration(2);d.update('after container rebuild');const rebuilt=(await d.run()).at(-1);
  assert.equal(rebuilt.status,'succeeded');assert.equal(rebuilt.generation,2);assert.notEqual(rebuilt.workspace_id,third.workspace_id);
  assert.match(JSON.stringify(d.requests.at(-1).messages),/after container cache loss/);
});

test('finish_review can be revised until the first GitHub write, and only the final result is posted',async t=>{
  let inserted=false;
  const d=await live(t,{objectRead:({h,update})=>{
    if(!h||inserted||!h.store.get("SELECT 1 FROM tasks WHERE phase='publish' AND publication_started=0"))return;
    inserted=true;assert.equal(update('revise before writing',true),0);
  }});
  const [task]=await d.run();assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.equal(d.requests.length,2);assert.match(JSON.stringify(d.requests[1].messages.at(-1)),/revise before writing/);
  const published=d.h.comments.filter(comment=>comment.body.includes('dept-bot:'));
  assert.equal(published.length,1);assert.match(published[0].body,/Done 2/);assert.doesNotMatch(published[0].body,/Done 1/);
  const events=d.h.store.all('SELECT content FROM task_logs').map(row=>JSON.parse(row.content));
  assert.equal(events.filter(event=>event.type==='tool_start'&&event.name==='finish_review').length,2,'resuming does not replay prior events');
  assert.ok(events.some(event=>event.type==='review_update'&&event.actor==='alice'));
});

test('resuming an unpublished review retains its pinned model configuration',async t=>{
  let inserted=false;
  const d=await live(t,{objectRead:({h,update})=>{
    if(!h||inserted||!h.store.get("SELECT 1 FROM tasks WHERE phase='publish' AND publication_started=0"))return;
    inserted=true;
    h.store.run("UPDATE models SET version=version+1,model_name='changed' WHERE repository_id='101'");
    assert.equal(update('revise after model configuration changed',true),0);
  }});
  const [task]=await d.run();
  assert.equal(task.status,'waiting_configuration');assert.equal(task.error_code,'model_configuration_changed');
  assert.equal(d.requests.length,1,'the resumed turn must not call a new model configuration');
  assert.equal(d.h.comments.filter(comment=>comment.body.includes('dept-bot:')).length,0);
});

test('an update during publication waits for completion and restores that successful conversation',async t=>{
  let inserted=false;
  const d=await live(t,{github:(path,send,res,body,{h,update})=>{
    if(!path.endsWith('/issues/1/comments')||!body.body||inserted)return false;
    inserted=true;assert.equal(update('arrived during GitHub write'),1);
    h.engine.tick();assert.equal(h.engine.active.size,1);
    const comment={id:100,body:body.body,user:{id:999},html_url:'https://github.invalid/comment/100'};h.comments.push(comment);send(comment,201);return true;
  }});
  await d.h.admin('/api/repositories/101/policy','PATCH',{task_concurrency:2});
  const tasks=await d.run();assert.equal(tasks[0].status,'succeeded');assert.equal(tasks[1].status,'queued');assert.equal(d.requests.length,1);
  const final=(await d.run()).at(-1);assert.equal(final.status,'succeeded');
  assert.match(JSON.stringify(d.requests[1].messages),/Done 1/);assert.match(JSON.stringify(d.requests[1].messages),/arrived during GitHub write/);
});

test('a failed model attempt retries with an empty history and the latest complete discussion',async t=>{
  let failing=false;
  const d=await live(t,{model:async(_request,n,{update})=>{
    if(failing&&n===2){update('latest after failure');return {status:503,body:{error:{message:'temporarily unavailable'}}};}
  }});
  assert.equal((await d.run())[0].status,'succeeded');failing=true;d.update('start failed follow-up');
  let task=(await d.run()).at(-1);assert.equal(task.status,'retry_wait');assert.equal(task.phase,'prepare');assert.equal(task.messages,null);
  assert.match(JSON.stringify(d.requests[1].messages),/Done 1/);
  d.update('latest before retry');d.h.store.run('UPDATE tasks SET next_run_at=0 WHERE id=?',task.id);
  task=(await d.run()).at(-1);assert.equal(task.status,'succeeded');
  const messages=d.requests[2].messages;assert.deepEqual(messages.map(m=>m.role),['system','user']);
  assert.match(text(messages[1]),/latest before retry/);assert.doesNotMatch(text(messages[1]),/Done 1/);
});

test('a new PR head supersedes the running review and resumes the last successful history in a new checkout',async t=>{
  const head='b'.repeat(40);
  const d=await live(t,{pr:true,model:async(request,n,{pushHead})=>{
    if(n===2){assert.equal(pushHead(head),1);return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:[call('read_file',{path:'../context/object.json'})]}}]}};}
  }});
  const [first]=await d.run();assert.equal(first.status,'succeeded');d.update('old head follow-up');
  const tasks=await d.run(),superseded=tasks[1];assert.equal(superseded.status,'superseded');assert.equal(superseded.error_code,'pull_request_head_changed');
  assert.equal(tasks[2].status,'queued');assert.equal(d.h.store.get('SELECT task_id FROM review_sessions').task_id,first.id);
  const current=(await d.run()).at(-1);assert.equal(current.status,'succeeded');assert.equal(current.head_sha,head);assert.notEqual(current.workspace_id,first.workspace_id);
  assert.match(text(d.requests.at(-1).messages.at(-1)),new RegExp('Current checkout/head: '+head));
  assert.match(JSON.stringify(d.requests.at(-1).messages),/Done 1/);
  assert.equal(d.h.store.get('SELECT count(*) n FROM review_updates WHERE task_id=?',superseded.id).n,0);
});

test('real Pi compacts restored history, uses current rules, and charges compaction to the new review',async t=>{
  let summaries=0;
  const d=await live(t,{model:async(request)=>{
    if(!request.tools?.length){summaries++;return {body:{choices:[{message:{role:'assistant',content:'A compact history summary of prior discussion.'}}],usage:{prompt_tokens:50000,completion_tokens:20}}};}
  }});
  assert.equal((await d.run())[0].status,'succeeded');
  const saved=d.h.store.get('SELECT * FROM review_sessions'),history=JSON.parse(saved.messages),assistant=history.find(m=>m.role==='assistant');
  const messages=Array.from({length:16},(_,i)=>[
    {role:'user',content:[{type:'text',text:'prior discussion '+i+' '+('context '.repeat(1500))}],timestamp:i*2},
    {...assistant,content:[{type:'text',text:'Earlier response '+i}],stopReason:'stop',usage:{...assistant.usage,input:110000,totalTokens:110020},timestamp:i*2+1}
  ]).flat();
  d.h.store.run('UPDATE review_sessions SET messages=?',JSON.stringify(messages));
  await d.h.admin('/api/repositories/101/policy','PATCH',{review_language:'en'});d.update('continue after compression');
  const current=(await d.run()).at(-1);assert.equal(current.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.ok(summaries>0);assert.ok(d.h.store.get('SELECT count(*) n FROM model_requests WHERE task_id=?',current.id).n>=2);
  assert.match(text(d.requests.at(-1).messages[0]),/Write the summary and every finding in English/);
  const projection=d.h.store.get('SELECT messages FROM review_sessions').messages;
  assert.match(projection,/compact history summary/);assert.ok(projection.length<JSON.stringify(messages).length);
  assert.ok(!d.h.store.all('SELECT request,result FROM task_tools').some(row=>JSON.stringify(row).includes('prior discussion 0')),'history transport does not leave another persistent copy in task tools');
  for(const request of d.requests){assert.ok(Buffer.byteLength(JSON.stringify(request))<=2*1024*1024);assert.ok(JSON.stringify(request).length/4+8192<=128000);}
});

for(const size of [520000,2200000])test(`an oversized ${size}-character history fails and manual retry starts empty`,async t=>{
  const d=await live(t);assert.equal((await d.run())[0].status,'succeeded');
  const saved=JSON.parse(d.h.store.get('SELECT messages FROM review_sessions').messages),assistant=saved.find(m=>m.role==='assistant');
  const messages=[{role:'user',content:'oversized history '+('x'.repeat(size)),timestamp:1},{...assistant,content:[{type:'text',text:'Earlier answer'}],stopReason:'stop',usage:{...assistant.usage,input:1,totalTokens:1},timestamp:2}];
  d.h.store.run('UPDATE review_sessions SET messages=?',JSON.stringify(messages));d.update('try oversized history');
  let task=(await d.run()).at(-1);assert.equal(task.status,'failed');assert.equal(task.error_code,'agent_context_too_large');assert.equal(task.messages,null);
  assert.equal(d.requests.length,1,'oversized requests never reach the provider');d.update('latest discussion after oversized failure');
  const retry=await d.h.admin('/api/tasks/'+task.id+'/retry','POST',{});assert.equal(retry.status,201);await Promise.all(d.h.engine.active.values());
  task=d.h.store.get('SELECT * FROM tasks WHERE id=?',task.id);assert.equal(task.status,'succeeded');
  assert.deepEqual(d.requests.at(-1).messages.map(m=>m.role),['system','user']);
  assert.match(text(d.requests.at(-1).messages.at(-1)),/latest discussion after oversized failure/);
});


test('an update arriving after prepare but before the first request refreshes both the prompt and discussion files',async t=>{
  let inserted=false;
  const d=await live(t,{execute:(request,{update})=>{
    if(request.type==='workspace_agent_config'&&request.final&&!inserted){inserted=true;assert.equal(update('during prepare snapshot',true),0);}
  },model:async(request,_n,{base,h})=>{
    assert.match(text(request.messages.at(-1)),/Latest title during prepare snapshot/);
    const task=h.store.get("SELECT * FROM tasks WHERE status='running'");
    assert.match(await readFile(join(base,task.workspace_id,'context/comments.json'),'utf8'),/during prepare snapshot/);
    assert.match(await readFile(join(base,task.workspace_id,'context/object.json'),'utf8'),/Latest body during prepare snapshot/);
  }});
  const [task]=await d.run();assert.equal(task.status,'succeeded');assert.equal(d.requests.length,1);
  assert.equal(d.h.store.get('SELECT count(*) n FROM tasks').n,1);
});
