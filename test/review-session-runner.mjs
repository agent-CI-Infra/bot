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
import {saveManager} from './helpers.mjs';
import {queueWebhook} from '../dist/review/queue.js';
import {releasePrCi} from './review-ci-helpers.mjs';
import {workspace} from '../runner/workspace.mjs';
import {listTaskDirectories,removeTaskDirectories} from '../runner/task-dirs.mjs';
import {estimateTokens} from '../runner/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {subagentSystem} from '../dist/agent/runtime.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {roleConfiguration,saveConfiguration} from '../dist/roles/definition.js';

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
  const pushHead=sha=>{object={...object,head:{...object.head,sha}};queueWebhook(h.store,'101','pull_request',{action:'synchronize',pull_request:object,sender:actor},'head-'+sha);return releasePrCi(h.store).created;};
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
  // The task pins its model configuration when it is queued, so the fixture model must already point at this server.
  h=await emptyRepositoryFixture(t,{files:[],modelUrl:`http://127.0.0.1:${server.address().port}/v1`,github:async(path,send,res,body)=>{
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
    const calls=n===1?[call('github_read_token',{}),call('github_read_token',{})]:n===2?[
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
  assert.equal(d.operations.filter(o=>o.type==='workspace_agent_token').length,2,'both uncached token calls finish through the single mailbox');
  assert.ok(grants.some(g=>g.permissions.contents==='read'&&g.permissions.issues==='read'&&Object.values(g.permissions).every(v=>v==='read')));
  assert.ok(d.h.comments.some(c=>c.body.includes('Issue #42')));
});

for(const siblings of [false,true])test(`real Pi checks repository results against the actual next model request, siblings=${siblings}`,async t=>{
  let content;
  const fits=request=>estimateTokens({role:'user',content:JSON.stringify(request),timestamp:Date.now()})+8192<=128000;
  const d=await live(t,{github:async(path,send)=>{
    if(path.endsWith('/app')){send({slug:'fixture-app'});return true;}
    if(path.endsWith('/users/fixture-app%5Bbot%5D')){send({id:999,login:'fixture-app[bot]'});return true;}
    if(path.endsWith('/installation')){send({id:55,account:{id:10},permissions:{contents:'read',issues:'write',pull_requests:'write',actions:'read',metadata:'read'}});return true;}
    if(path.endsWith('/access_tokens')){send({token:'context-read-token',expires_at:'2099-01-01T00:00:00Z',permissions:{contents:'read',issues:'read',pull_requests:'read',actions:'read',metadata:'read'}});return true;}
    if(path==='/installation/token'){send({});return true;}
    if(/\/git\/trees\/(?:0{40}|1{40})$/.test(path)){send({content});return true;}
  },model:async(request,n)=>{
    assert.ok(fits(request),'every actual provider request stays inside the existing context limit');
    if(n===2){
      const available=4*(128000-8192)-JSON.stringify(request).length;
      content='x'.repeat(siblings?Math.floor(available*0.6):4*128000);
      assert.ok(Buffer.byteLength(JSON.stringify({content}))<2*1024*1024,'the mailbox accepts the result');
    }
    if(n===3){
      const replies=request.messages.filter(message=>message.role==='tool').slice(1).map(message=>JSON.parse(message.content));
      if(siblings)assert.deepEqual(replies[0],{content},'a result that fits is returned unchanged');
      const rejected=replies.at(-1);assert.equal(rejected.error,'repository_result_too_large');assert.match(rejected.detail,/path.*recursive.*page/);
      const expanded=structuredClone(request);expanded.messages.findLast(message=>message.role==='tool').content=JSON.stringify({content});
      assert.equal(fits(expanded),false,'restoring the rejected result really exceeds estimateTokens + 8192 > 128000');
    }
    const calls=n===1?[call('github_read_token',{})]:n===2?Array.from({length:siblings?2:1},(_,i)=>call('github_read',{path:'/git/trees/'+String(i).repeat(40)+'?recursive=1'})):[call('finish_review',result('Continued after the context tool error.'))];
    return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:calls}}]}};
  }});
  const pem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}),repo=d.h.store.get("SELECT * FROM repositories WHERE id='101'");
  d.h.store.run("UPDATE accounts SET type='github_app',app_id='123',credentials=? WHERE id=?",d.h.store.secrets.seal({private_key:pem},'account:'+repo.account_id),repo.account_id);
  const [task]=await d.run();assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.equal(d.requests.length,3);assert.ok(!d.requests.some(request=>JSON.stringify(request).includes('context-read-token')));
});

const fitsRequest=request=>estimateTokens({role:'user',content:JSON.stringify(request),timestamp:Date.now()})+8192<=128000;
const toolReplies=request=>request.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(text(message)));
// A command printing one character size times, without newlines that JSON would escape.
const printChars=(character,size)=>`head -c ${size} /dev/zero | tr '\\0' ${character}`;

test('real Pi withholds a command output that no compaction can fit, keeps its status and continues the review',async t=>{
  // Without the check, Pi compacts (a summary request) and the kept output still fails the task with agent_context_too_large.
  let summaries=0;
  const d=await live(t,{model:async(request,n)=>{
    assert.ok(fitsRequest(request),'every actual provider request stays inside the existing context limit');
    if(!request.tools?.length){summaries++;return {body:{choices:[{message:{role:'assistant',content:'Summary of the review so far.'}}]}};}
    if(n===2){
      const reply=toolReplies(request).at(-1);
      assert.equal(reply.error,'tool_result_too_large');assert.equal(reply.exit_code,0);assert.equal(reply.timed_out,false);
      assert.ok(reply.result_characters>600000);assert.match(reply.detail,/command ran.*head, tail, grep or wc/);
      assert.ok(!JSON.stringify(request).includes('n'.repeat(1000)),'the output never reaches the provider');
    }
    const calls=n===1?[call('run_command',{command:printChars('n',600000)})]:[call('finish_review',result('Continued after narrowing the command output.'))];
    return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:calls}}]}};
  }});
  const [task]=await d.run();assert.equal(task.status,'succeeded',task.error_code);
  assert.equal(summaries,0,'the withheld output leaves nothing to compact');assert.equal(d.requests.length,2);
});

test('real Pi keeps a large command output that fits after compaction and compacts the earlier output away',async t=>{
  let summaries=0;
  const d=await live(t,{model:async(request,n)=>{
    assert.ok(fitsRequest(request),'every actual provider request stays inside the existing context limit');
    if(!request.tools?.length){summaries++;return {body:{choices:[{message:{role:'assistant',content:'Summary: the first command printed a long run of a.'}}]}};}
    const replies=toolReplies(request),raw=JSON.stringify(request),turn=n-summaries;
    if(turn===2)assert.ok(raw.includes('a'.repeat(300000)),'the first output fits and is returned unchanged');
    if(turn===3){
      assert.ok(raw.includes('b'.repeat(300000)),'the second output fits alone, so it is kept although the whole history would not fit');
      assert.ok(!raw.includes('a'.repeat(1000)),'compaction removed the first output');assert.ok(!replies.some(reply=>reply.error));
    }
    const calls=turn===1?[call('run_command',{command:printChars('a',300000)})]:turn===2?[call('run_command',{command:printChars('b',300000)})]
      :[call('finish_review',result('Checked both outputs.'))];
    return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:calls}}]}};
  }});
  const [task]=await d.run();assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.ok(summaries>0,'Pi compacted before the third turn');
});

test('real Pi compacts and retries a request over the limit when provider usage kept it under the compaction threshold',async t=>{
  // Pi starts threshold compaction from the provider's reported usage plus newer messages, while the runner limit
  // estimates the whole raw request. A provider counting fewer tokens than chars/4 leaves Pi below its threshold with
  // the third request over the limit; that request must lead to compaction, not fail the task.
  let summaries=0;const turns=[];
  const d=await live(t,{model:async(request,n)=>{
    assert.ok(fitsRequest(request),'every actual provider request stays inside the existing context limit');
    const raw=JSON.stringify(request),usage={prompt_tokens:Math.ceil(raw.length/8),completion_tokens:20};
    if(!request.tools?.length){summaries++;return {body:{choices:[{message:{role:'assistant',content:'Summary: the first command printed a long run of a.'}}],usage}};}
    const turn=n-summaries;turns.push(turn);
    if(turn===3){
      assert.ok(raw.includes('b'.repeat(240000)),'the latest output is kept');
      assert.ok(!raw.includes('a'.repeat(1000)),'compaction removed the first output');
    }
    const calls=turn===1?[call('run_command',{command:printChars('a',240000)})]:turn===2?[call('run_command',{command:printChars('b',240000)})]
      :[call('finish_review',result('Checked both outputs.'))];
    return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:calls}}],usage}};
  }});
  const [task]=await d.run();assert.equal(task.status,'succeeded',task.error_code);
  assert.equal(summaries,1,'one compaction');assert.deepEqual(turns,[1,2,3],'the turn over the limit never reached the provider');
});

test('real Pi fails with agent_context_too_large when compaction cannot fit the next request',async t=>{
  // Compaction keeps the latest messages, so a person's update this large still does not fit after it.
  let summaries=0;
  const d=await live(t,{model:async(request,n,{update})=>{
    assert.ok(fitsRequest(request),'every actual provider request stays inside the existing context limit');
    if(!request.tools?.length){summaries++;return {body:{choices:[{message:{role:'assistant',content:'Summary of the review so far.'}}]}};}
    assert.equal(n,1,'the turn over the limit never reaches the provider');
    assert.equal(update('y'.repeat(600000)),0);
    return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:[call('run_command',{command:'printf checked'})]}}]}};
  }});
  const [task]=await d.run();assert.equal(task.status,'failed');assert.equal(task.error_code,'agent_context_too_large');
  assert.equal(summaries,1,'Pi tried one compaction before giving up');
  const events=d.h.store.all('SELECT content FROM task_logs WHERE task_id=?',task.id).map(row=>JSON.parse(row.content));
  assert.ok(!events.some(event=>event.type==='agent_nudge'),'a session that cannot fit is not asked to continue');
});

test('real Pi fails with agent_context_too_large when the first request is over the limit and there is nothing to compact',async t=>{
  // The start prompt carries the waiting update in full; a session of one message gives compaction nothing to cut.
  const d=await live(t,{model:async()=>assert.fail('no request reaches the provider')});
  assert.equal(d.update('z'.repeat(600000)),0);
  const [task]=await d.run();assert.equal(task.status,'failed');assert.equal(task.error_code,'agent_context_too_large');
  const events=d.h.store.all('SELECT content FROM task_logs WHERE task_id=?',task.id).map(row=>JSON.parse(row.content));
  assert.ok(!events.some(event=>event.type==='agent_nudge'),'a session that cannot fit is not asked to continue');
});

test('real Pi starts a review whose earlier attempt left a candidate with references to its command logs, not the logs',async t=>{
  const d=await live(t,{model:async(request,n)=>{
    if(n===1){
      const candidate=JSON.parse(text(request.messages.at(-1))).structured_task.candidate;
      assert.deepEqual(candidate.evidence[108],{source:'task_log:108',version:'v108',verified:true});
      assert.ok(!JSON.stringify(request).includes('command output'),'command logs stay out of the request');
    }
  }});
  // After a long attempt (109 commands) is interrupted, the next attempt of the same review starts from this record.
  const records=new TaskRecords(d.h.store);
  records.contract(d.h.taskId,{goal:'Review the Issue.',scope:['review.issue'],criteria:['A review'],endpoint:'report',source:{kind:'review.issue'},completeness:'explicit'});
  records.submit(d.h.taskId,[{kind:'report',reference:'report',version:'r1',content:'report body'}],
    Array.from({length:109},(_,i)=>({source:'task_log:'+i,version:'v'+i,verified:true,result:{type:'tool',name:'run_command',output:'command output '.repeat(300)}})),{summary:'Earlier attempt.'});
  const [task]=await d.run();assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.ok(d.requests.length>=1);
});

test('real Pi starts a sub-agent as a new session that sees only its own instructions and a narrowed tool set',async t=>{
  const seen=[];
  const d=await live(t,{model:async(request,n)=>{
    seen.push(request);
    const system=text(request.messages[0]);
    if(system.startsWith(subagentSystem)){
      // The sub-agent's first and only request: its own system prompt and task, nothing of the main conversation.
      return {body:{choices:[{message:{role:'assistant',content:'README is consistent with the code.'}}]}};
    }
    if(!request.messages.some(message=>message.role==='tool'))return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:[call('start_agent',{name:'reader',instructions:'Check README only.',task:'Read README and report problems.',permissions:{run_commands:false,write_notes:false}})]}}]}};
    return {body:{choices:[{message:{role:'assistant',content:null,tool_calls:[call('finish_review',result('Checked with an independent reader.'))]}}]}};
  }});
  // Every workflow may start agents without configuration; the main agent narrows what this one gets.
  const [task]=await d.run();
  assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  const child=seen.filter(request=>text(request.messages[0]).startsWith(subagentSystem)),main=seen.filter(request=>!text(request.messages[0]).startsWith(subagentSystem));
  assert.equal(child.length,1);assert.equal(main.length,2);
  assert.deepEqual(child[0].messages.map(message=>message.role),['system','user']);
  // Pi appends the working directory to every system prompt; the rest is the sub-agent's own frame and instructions.
  assert.ok(text(child[0].messages[0]).startsWith(subagentSystem+'\n\nCheck README only.'));assert.doesNotMatch(text(child[0].messages[0]),/review mode|## \.bot\//);assert.equal(text(child[0].messages[1]),'Read README and report problems.');
  assert.doesNotMatch(JSON.stringify(child[0].messages),/First issue|context_files|finish_review/);
  const tools=child[0].tools.map(tool=>tool.function.name).sort();
  for(const name of ['finish_review','start_agent','run_command','write_file','create_pull_request'])assert.ok(!tools.includes(name),name);
  assert.ok(tools.includes('read_file')&&tools.includes('github_read_token'));
  // The main agent continues its own conversation and gets the sub-agent's answer as a tool result.
  assert.match(JSON.stringify(main[1].messages),/README is consistent with the code\./);assert.match(JSON.stringify(main[1].messages),/First issue/);
  const events=d.h.store.all('SELECT content FROM task_logs').map(row=>JSON.parse(row.content));
  assert.ok(events.some(event=>event.type==='agent_start'&&event.capabilities.workspace.shell===false&&event.capabilities.agents===false));
  assert.ok(events.some(event=>event.type==='model'&&event.agent));
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
  // The workspace cleanup removing the checkout affects only the computer; the control-plane conversation survives.
  const listed=(await listTaskDirectories(d.base)).entries;assert.equal(listed.length,1);
  assert.equal((await removeTaskDirectories(listed,d.base,join(d.base,'git'))).removed.length,1);
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
  // The provider stays unavailable for the whole attempt: a single 503 is retried within the attempt and would succeed.
  let failing=false,failures=0;
  const d=await live(t,{model:async(_request,_n,{update})=>{
    if(failing){if(!failures++)update('latest after failure');return {status:503,body:{error:{message:'temporarily unavailable'}}};}
  }});
  assert.equal((await d.run())[0].status,'succeeded');failing=true;d.update('start failed follow-up');
  let task=(await d.run()).at(-1);assert.equal(task.status,'retry_wait');assert.equal(task.phase,'prepare');assert.equal(task.messages,null);
  assert.ok(failures>1,'the attempt retried the request before giving up');
  assert.match(JSON.stringify(d.requests[1].messages),/Done 1/);
  failing=false;d.update('latest before retry');d.h.store.run('UPDATE tasks SET next_run_at=0 WHERE id=?',task.id);
  const retried=d.requests.length;task=(await d.run()).at(-1);assert.equal(task.status,'succeeded');
  const messages=d.requests[retried].messages;assert.deepEqual(messages.map(m=>m.role),['system','user']);
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
  assert.equal(d.requests.length,1,'oversized requests never reach the provider');
  // A manual retry queues the task again, so the next update joins it instead of starting another review of the object.
  const retry=await d.h.admin('/api/tasks/'+task.id+'/retry','POST',{});assert.equal(retry.status,201);
  const tasks=d.h.store.get('SELECT count(*) n FROM tasks').n;d.update('latest discussion after oversized failure');await d.run();
  task=d.h.store.get('SELECT * FROM tasks WHERE id=?',task.id);assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs WHERE task_id=?',task.id)));
  assert.equal(d.h.store.get('SELECT count(*) n FROM tasks').n,tasks,'the update joined the retried review');
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

test('real Pi forwards github_write to the control plane: a role with Issues write files one Issue and the review still finishes',async t=>{
  const filed=[];
  const d=await live(t,{model:async(request,n)=>n===1?{body:{choices:[{message:{role:'assistant',content:null,tool_calls:[call('github_write',{method:'POST',path:'/issues',key:'docs-follow-up',body:{title:'Follow-up for @alice',body:'Track the docs; ping @alice.'}})]}}]}}:undefined,
    github:async(path,send,_res,body)=>{if(path.endsWith('/issues')&&body?.title){filed.push(body);send({number:77,html_url:'https://github.invalid/issues/77',user:{id:999}},201);return true;}return false;}});
  // Direct writes follow the executing role's GitHub permissions (#381); the built-in dev role only reads until it is given Issues write.
  saveConfiguration(d.h.store,'101',{expected_revision:roleConfiguration(d.h.store,'101').revision,enabled:false,roles:[{role_id:'dev',permissions:{github_issues:'write'}}]},'fixture');
  d.h.store.run('DELETE FROM task_execution_configs WHERE task_id=?',d.h.taskId);
  const [task]=await d.run();
  assert.equal(task.status,'succeeded',JSON.stringify(d.h.store.all('SELECT content FROM task_logs')));
  assert.equal(filed.length,1);assert.match(filed[0].body,/ping &#64;alice/);assert.doesNotMatch(filed[0].title,/@/);
  // Pi received the control plane's answer as the tool result, then finished the review as usual.
  assert.match(JSON.stringify(d.requests[1].messages),/"number\\":77/);
  assert.ok(d.requests[0].tools.some(tool=>tool.function.name==='github_write'));
  assert.equal(d.h.store.get("SELECT count(*) n FROM github_writes WHERE state='sent'").n,1);
});
