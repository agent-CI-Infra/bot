import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {agentOperation} from '../../../runner/agent.mjs';
import {workspaceProfile} from '../../../dist/agent/profiles.js';
import {randomWorkspaceId} from '../../fixtures/helpers.mjs';

async function until(read){
  for(const end=Date.now()+10000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,20))){const value=await read();if(value)return value;}
  assert.fail('Timed out waiting for runner event');
}
test('Pi writes ordered, redacted tool starts before a blocked command returns and retains results',async t=>{
  const base=await mkdtemp(join(tmpdir(),'pi-events-')),id=randomWorkspaceId(),root=join(base,id),dir=join(root,'agent');
  await mkdir(dir,{recursive:true});await mkdir(join(root,'repo'));t.after(()=>rm(base,{recursive:true,force:true}));
  const token='runner-private-token',command=`printf '${token}'; while [ ! -f release ]; do sleep 0.05; done`;
  const calls=[{name:'github_read_token',args:{}},{name:'write_file',args:{path:'file.txt',content:'private body excluded from start'}},
    {name:'write_file',args:{path:'../notes/repository.md',content:'x'.repeat(131072)}},
    {name:'write_file',args:{path:'../notes/secret.md',content:'secret '+token}},
    {name:'read_file',args:{path:'file.txt'}},{name:'run_command',args:{command}},
    {name:'create_pull_request',args:{summary:'Ready',test_command:'true'}},{name:'finish_review',args:{summary:'Done'}}];
  await writeFile(join(dir,'input.json'),JSON.stringify({model_transport:'gateway',workspace_id:id,system:'fixture',capabilities:workspaceProfile('development.issue',{}).capabilities,prompt:JSON.stringify(calls),tools:calls.map(({name})=>({function:{name,parameters:{type:'object'}}}))}));
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href;
  const hook=join(base,'hooks.mjs');await writeFile(hook,`import {registerHooks} from 'node:module';\nregisterHooks({resolve(specifier,context,next){if(specifier==='@earendil-works/pi-coding-agent'||context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  const child=spawn(process.execPath,['--import',hook,'runner/pi-entry.mjs',root],{env:{...process.env,BOT_RUNNER_TEST_ROOT:base},stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  let output='';child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>output+=chunk);
  t.after(async()=>{child.kill('SIGKILL');await closed;});
  const events=async()=>{
    const all=[];let page,offset=0;
    do{page=await agentOperation({type:'workspace_agent_poll',offset},root);all.push(...page.events);offset=page.offset;}while(page.has_more);
    return all;
  };
  const request=await until(async()=>{const names=await readdir(join(dir,'token-requests')).catch(()=>[]);const file=names.find(n=>n.endsWith('.json'));return file&&JSON.parse(await readFile(join(dir,'token-requests',file),'utf8'));});
  await mkdir(join(dir,'token-replies'),{recursive:true});
  await writeFile(join(dir,'token-replies',`${request.id}.json`),JSON.stringify({token,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'read'},repository:'fixture/repo'}));
  await until(async()=>(await events()).find(event=>event.type==='tool_start'&&event.name==='run_command'));
  const pending=await events(),start=pending.find(event=>event.type==='tool_start'&&event.name==='run_command');
  assert.equal(start.command,command.replaceAll(token,'[REDACTED]'));assert.ok(!JSON.stringify(pending).includes(token));
  assert.ok(!pending.some(event=>event.type==='tool'&&event.name==='run_command'),'result does not exist while command waits');
  const writeStart=pending.find(event=>event.type==='tool_start'&&event.name==='write_file');assert.equal(writeStart.path,'file.txt');assert.ok(!JSON.stringify(writeStart).includes('private body'));
  assert.equal(pending.find(event=>event.type==='tool_start'&&event.name==='read_file').path,'file.txt');
  await writeFile(join(root,'repo','release'),'');
  const publication=await until(async()=>{const names=await readdir(join(dir,'tool-requests')).catch(()=>[]);const file=names.find(n=>n.endsWith('.json'));return file&&JSON.parse(await readFile(join(dir,'tool-requests',file),'utf8'));});
  const publishing=await events();assert.ok(publishing.some(event=>event.type==='tool_start'&&event.name==='create_pull_request'));
  assert.ok(!publishing.some(event=>event.type==='tool'&&event.name==='create_pull_request'));
  await mkdir(join(dir,'tool-replies'),{recursive:true});
  await writeFile(join(dir,'tool-replies',`${publication.id}.json`),JSON.stringify({pr:{number:1,html_url:'https://github.invalid/pull/1'}}));
  const [code]=await closed;assert.equal(code,0,output);assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).state,'completed',output);
  const all=await events();assert.ok(!JSON.stringify(all).includes(token));
  assert.equal((await readFile(join(base,'project-notes/repository.md'))).length,131072);
  assert.equal(await readFile(join(base,'project-notes/secret.md'),'utf8'),'secret '+token);
  assert.equal(all.find(event=>event.type==='tool'&&event.arguments?.path==='../notes/secret.md').result.written,true);
  // Every session binds first: the session and file the control plane keeps so the next run opens them again (#1040). Then
  // the session event identifies its runtime and exact tool list.
  const [bound,session]=all.splice(0,2);
  assert.deepEqual([bound.type,bound.session_id,bound.recoveryMode,bound.transcript],['session_bound','fixture-session','new_session',join(root,'cli-state/pi/session/sessions/fixture-session.jsonl')]);
  assert.deepEqual([session.type,session.agent,session.native,session.recovery],['pi_session','pi',false,'new_session']);
  for(const [i,call] of calls.entries())assert.deepEqual(all.slice(i*3,i*3+3).map(event=>event.type),['model','tool_start','tool'],call.name);
  assert.equal(all.find(event=>event.type==='tool'&&event.name==='run_command').result.output,'[REDACTED]');
  assert.equal(all.at(-2).name,'finish_review');
});

test('poll exposes event pagination so completed and failed agents can drain all remaining logs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'event-pages-')),dir=join(root,'agent');
  await mkdir(dir);t.after(()=>rm(root,{recursive:true,force:true}));
  const events=Array.from({length:45},(_,step)=>({type:'tool_start',name:'read_file',path:`src/${step}.js`}));
  await writeFile(join(dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));
  for(const state of ['completed','failed']){
    await writeFile(join(dir,'state.json'),JSON.stringify({state}));
    const collected=[];let offset=0,page;
    do{page=await agentOperation({type:'workspace_agent_poll',offset},root);collected.push(...page.events);offset=page.offset;}while(page.has_more);
    assert.deepEqual(collected,events);assert.equal(offset,45);
  }
});

test('poll retains an incomplete event across pages until its newline is appended',async t=>{
  const root=await mkdtemp(join(tmpdir(),'event-tail-')),dir=join(root,'agent');
  await mkdir(dir);t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(dir,'state.json'),JSON.stringify({state:'running'}));
  const prefix=Array.from({length:21},(_,step)=>({type:'tool_start',name:'read_file',path:`src/${step}.js`}));
  const last={type:'tool',name:'write_file',arguments:{content:'测'.repeat(131072)}},line=Buffer.from(JSON.stringify(last)+'\n'),cut=65536;
  await writeFile(join(dir,'events.jsonl'),Buffer.concat([Buffer.from(prefix.map(event=>JSON.stringify(event)+'\n').join('')),line.subarray(0,cut)]));
  const first=await agentOperation({type:'workspace_agent_poll'},root);assert.deepEqual(first.events,prefix.slice(0,20));assert.equal(first.offset,20);assert.equal(first.has_more,true);
  const second=await agentOperation({type:'workspace_agent_poll',offset:first.offset},root);assert.deepEqual(second.events,prefix.slice(20));assert.equal(second.offset,21);assert.equal(second.has_more,false);
  const pending=await agentOperation({type:'workspace_agent_poll',offset:second.offset},root);assert.deepEqual(pending.events,[]);assert.equal(pending.offset,21);
  await appendFile(join(dir,'events.jsonl'),line.subarray(cut,-1));
  assert.deepEqual((await agentOperation({type:'workspace_agent_poll',offset:21},root)).events,[],'even valid JSON waits for its record delimiter');
  await appendFile(join(dir,'events.jsonl'),'\n');
  const complete=await agentOperation({type:'workspace_agent_poll',offset:21},root);assert.deepEqual(complete.events,[last]);assert.equal(complete.offset,22);assert.equal(complete.has_more,false);
  assert.deepEqual((await agentOperation({type:'workspace_agent_poll',offset:complete.offset},root)).events,[]);
  await appendFile(join(dir,'events.jsonl'),'{"broken":\n');
  await assert.rejects(()=>agentOperation({type:'workspace_agent_poll',offset:22},root),SyntaxError,'a malformed complete record is still an error');
});

test('review file tools can update project notes but refuse repository writes',async t=>{
  const base=await mkdtemp(join(tmpdir(),'pi-notes-')),id=randomWorkspaceId(),root=join(base,id),dir=join(root,'agent');
  await mkdir(dir,{recursive:true});await mkdir(join(root,'repo'));t.after(()=>rm(base,{recursive:true,force:true}));
  const calls=[{name:'write_file',args:{path:'../notes/repository.md',content:'Review experience'}},
    {name:'write_file',args:{path:'tracked.md',content:'forbidden'}},{name:'finish_review',args:{summary:'Done'}}];
  await writeFile(join(dir,'input.json'),JSON.stringify({model_transport:'gateway',workspace_id:id,system:'Review fixture',capabilities:workspaceProfile('review.issue',{}).capabilities,prompt:JSON.stringify(calls),tools:['write_file','finish_review'].map(name=>({function:{name,parameters:{type:'object'}}}))}));
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href,hook=join(base,'hooks.mjs');
  await writeFile(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='@earendil-works/pi-coding-agent'||context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  const child=spawn(process.execPath,['--import',hook,'runner/pi-entry.mjs',root],{env:{...process.env,BOT_RUNNER_TEST_ROOT:base},stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  t.after(async()=>{child.kill('SIGKILL');await closed;});
  assert.equal((await closed)[0],0);
  assert.equal(await readFile(join(base,'project-notes/repository.md'),'utf8'),'Review experience');
  await assert.rejects(readFile(join(root,'repo/tracked.md')),/ENOENT/);
  const events=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(e=>e.type==='tool'&&e.arguments?.path==='tracked.md').result.error,'review_repository_write_forbidden');
});

// A model turn can end without the finishing call (an empty or failed reply, or prose). The runner asks the same session
// to continue, keeping its work, and fails with agent_finish_missing only after a bounded number of tries.
async function finishRun(t,{calls,env}){
  const base=await mkdtemp(join(tmpdir(),'pi-finish-')),id=randomWorkspaceId(),root=join(base,id),dir=join(root,'agent');
  await mkdir(dir,{recursive:true});await mkdir(join(root,'repo'));t.after(()=>rm(base,{recursive:true,force:true}));
  await writeFile(join(dir,'input.json'),JSON.stringify({model_transport:'gateway',workspace_id:id,system:'Review fixture',capabilities:workspaceProfile('review.issue',{}).capabilities,prompt:JSON.stringify(calls),
    tools:['read_file','finish_review'].map(name=>({function:{name,parameters:{type:'object'}}}))}));
  await writeFile(join(root,'repo','README.md'),'fixture');
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href,hook=join(base,'hooks.mjs');
  await writeFile(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='@earendil-works/pi-coding-agent'||context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  const child=spawn(process.execPath,['--import',hook,'runner/pi-entry.mjs',root],{env:{...process.env,BOT_RUNNER_TEST_ROOT:base,...env},stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  t.after(async()=>{child.kill('SIGKILL');await closed;});
  assert.equal((await closed)[0],0);
  return {state:JSON.parse(await readFile(join(dir,'state.json'),'utf8')),events:(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)};
}

test('a turn that ends without the finishing call continues in the same session and then finishes',async t=>{
  // The first turn reads a file and stops with an empty answer; the continuation calls finish_review.
  const {state,events}=await finishRun(t,{calls:[{name:'read_file',args:{path:'README.md'}}],
    env:{BOT_FIXTURE_LAST_TEXT:'',BOT_FIXTURE_CONTINUE:JSON.stringify([[{name:'finish_review',args:{summary:'Finished after continuing'}}]])}});
  assert.equal(state.state,'completed');assert.equal(state.result.summary,'Finished after continuing');
  const nudges=events.filter(e=>e.type==='agent_nudge');
  assert.equal(nudges.length,1);assert.deepEqual(nudges[0].finishing_tools,['finish_review']);
  // The work of the first turn stayed in the session: the read ran once, before the continuation.
  assert.deepEqual(events.filter(e=>e.type==='tool').map(e=>e.name),['read_file','finish_review']);
});

test('a session that never finishes fails with agent_finish_missing instead of a TypeError',async t=>{
  const {state,events}=await finishRun(t,{calls:[{name:'read_file',args:{path:'README.md'}}],env:{BOT_FIXTURE_LAST_TEXT:''}});
  assert.equal(state.state,'failed');assert.equal(state.error,'agent_finish_missing');
  assert.match(state.detail,/ended 4 turns without calling finish_review/);
  assert.equal(events.filter(e=>e.type==='agent_nudge').length,3);
});

// #1040: Pi owns compaction. Only a retry that still does not fit after Pi compacted the session is
// agent_context_too_large; a compaction that failed on its own keeps Pi's message under its own code.
for(const [message,code] of [['Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.','agent_context_too_large'],
  // The compaction's own summary request did not fit: reopening the session would fail the same way.
  ['Context overflow recovery failed: Turn prefix summarization failed: 413: {"type":"invalid_request_error","code":"context_length_exceeded"}','agent_context_too_large'],
  ['Context overflow recovery failed: 503 temporarily unavailable','agent_compaction_failed']])test(`a failed overflow recovery ends the session as ${code} with Pi's reason`,async t=>{
  const {state,events}=await finishRun(t,{calls:[{event:{type:'compaction_end',reason:'overflow',aborted:false,willRetry:false,errorMessage:message}}],env:{BOT_FIXTURE_LAST_TEXT:''}});
  assert.deepEqual([state.state,state.error,state.detail],['failed',code,message]);
  assert.equal(events.filter(e=>e.type==='agent_nudge').length,0,'a session that cannot continue is not asked to');
});

test('a session that never finishes after a failed model reply names that error',async t=>{
  const failed={type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'429 rate limit reached',content:[]}};
  const {state}=await finishRun(t,{calls:[{event:failed}],env:{BOT_FIXTURE_LAST_TEXT:''}});
  assert.equal(state.error,'agent_finish_missing');assert.match(state.detail,/ended 4 turns without calling finish_review\. Last model error: 429 rate limit reached/);
});

test('a JSON answer written as text still finishes the session without asking it to continue',async t=>{
  const {state,events}=await finishRun(t,{calls:[{name:'read_file',args:{path:'README.md'}}],env:{BOT_FIXTURE_LAST_TEXT:'```json\n{"summary":"Text result"}\n```'}});
  assert.equal(state.state,'completed');assert.equal(state.result.summary,'Text result');
  assert.equal(events.filter(e=>e.type==='agent_nudge').length,0);
});

// #769: a task gets its worktree when it first needs one. A file tool that finds no checkout asks the control plane through
// the mailbox (kind workspace, not a model tool) and runs again with the answer; ../context/ needs no checkout at all.
test('a file tool without a checkout asks the control plane for the task worktree once, then runs; a refusal is the tool result',async t=>{
  const base=await mkdtemp(join(tmpdir(),'pi-workspace-')),id=randomWorkspaceId(),root=join(base,id),dir=join(root,'agent');
  await mkdir(dir,{recursive:true});await mkdir(join(root,'context'));await writeFile(join(root,'context','object.json'),'{"title":"Fix"}');t.after(()=>rm(base,{recursive:true,force:true}));
  const calls=[{name:'read_file',args:{path:'../context/object.json'}},{name:'read_file',args:{path:'README.md'}},{name:'run_command',args:{command:'cat README.md'}},{name:'finish_review',args:{summary:'Done'}}];
  await writeFile(join(dir,'input.json'),JSON.stringify({model_transport:'gateway',workspace_id:id,system:'Review fixture',capabilities:workspaceProfile('review.issue',{}).capabilities,prompt:JSON.stringify(calls),
    tools:['read_file','run_command','finish_review'].map(name=>({function:{name,parameters:{type:'object'}}}))}));
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href,hook=join(base,'hooks.mjs');
  await writeFile(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='@earendil-works/pi-coding-agent'||context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  const child=spawn(process.execPath,['--import',hook,resolve('runner/pi-entry.mjs'),root],{cwd:root,env:{...process.env,BOT_RUNNER_TEST_ROOT:base},stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  let output='';child.stderr.on('data',chunk=>output+=chunk);t.after(async()=>{child.kill('SIGKILL');await closed;});
  // The control plane binds the worktree (here: a checkout directory appears) and answers.
  const request=await until(async()=>{const names=await readdir(join(dir,'tool-requests')).catch(()=>[]);const file=names.find(n=>n.endsWith('.json'));return file&&JSON.parse(await readFile(join(dir,'tool-requests',file),'utf8'));});
  assert.deepEqual([request.name,request.kind,request.arguments],['ensure_workspace','workspace',{}]);
  await mkdir(join(root,'repo'));await writeFile(join(root,'repo','README.md'),'fixture readme\n');
  await mkdir(join(dir,'tool-replies'),{recursive:true});await writeFile(join(dir,'tool-replies',`${request.id}.json`),JSON.stringify({worktree:{id:'x',mode:'read',reused:false}}));
  assert.equal((await closed)[0],0,output);
  const events=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),results=events.filter(e=>e.type==='tool').map(e=>e.result);
  assert.deepEqual([results[0].content,results[1].content,results[2].output],['{"title":"Fix"}','fixture readme\n','fixture readme\n']);
  assert.deepEqual(await readdir(join(dir,'tool-requests')),[],'one request, for the first repository read');
});

test('a task whose worktree cannot be made answers its file tools with the control plane\'s reason',async t=>{
  const base=await mkdtemp(join(tmpdir(),'pi-workspace-')),id=randomWorkspaceId(),root=join(base,id),dir=join(root,'agent');
  await mkdir(dir,{recursive:true});t.after(()=>rm(base,{recursive:true,force:true}));
  const calls=[{name:'read_file',args:{path:'README.md'}},{name:'finish_review',args:{summary:'Done'}}];
  await writeFile(join(dir,'input.json'),JSON.stringify({model_transport:'gateway',workspace_id:id,system:'Review fixture',capabilities:workspaceProfile('review.issue',{}).capabilities,prompt:JSON.stringify(calls),
    tools:['read_file','finish_review'].map(name=>({function:{name,parameters:{type:'object'}}}))}));
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href,hook=join(base,'hooks.mjs');
  await writeFile(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='@earendil-works/pi-coding-agent'||context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  const child=spawn(process.execPath,['--import',hook,resolve('runner/pi-entry.mjs'),root],{cwd:root,env:{...process.env,BOT_RUNNER_TEST_ROOT:base},stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  t.after(async()=>{child.kill('SIGKILL');await closed;});
  const request=await until(async()=>{const names=await readdir(join(dir,'tool-requests')).catch(()=>[]);const file=names.find(n=>n.endsWith('.json'));return file&&JSON.parse(await readFile(join(dir,'tool-requests',file),'utf8'));});
  await mkdir(join(dir,'tool-replies'),{recursive:true});
  await writeFile(join(dir,'tool-replies',`${request.id}.json`),JSON.stringify({error:'workspace_unavailable',message:'No worktree could be made for this task on the project computer.'}));
  assert.equal((await closed)[0],0);
  const events=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.find(e=>e.type==='tool'&&e.name==='read_file').result,{error:'workspace_unavailable',message:'No worktree could be made for this task on the project computer.'});
});

// #1087: a command can print a token nobody registered, such as gh auth status with its masked tail. The model receives
// the result without the token's form, ordinary code included as it is; the event log also applies the context rules.
test('a token a command prints leaves the model-facing result and the events by its form; code the model edits stays',async t=>{
  const base=await mkdtemp(join(tmpdir(),'pi-shapes-')),id=randomWorkspaceId(),root=join(base,id),dir=join(root,'agent');
  await mkdir(dir,{recursive:true});await mkdir(join(root,'repo'));t.after(()=>rm(base,{recursive:true,force:true}));
  // Constructed values: <prefix><id>_<JWT> with the tail gh masks after the token's last underscore.
  const header=Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url'),payload=Buffer.from('{"iss":"fixture-app","installation_id":424242}').toString('base64url');
  const printed=`ghs_424242_${header}.${payload}.fixture_${'*'.repeat(40)}`,code='const token = callOptions.token;\n';
  await writeFile(join(root,'repo','status.txt'),`github.com\n  - Token: ${printed}\n`);await writeFile(join(root,'repo','code.js'),code);
  const calls=[{name:'run_command',args:{command:'cat status.txt'}},{name:'read_file',args:{path:'code.js'}},{name:'finish_review',args:{summary:'Done'}}];
  await writeFile(join(dir,'input.json'),JSON.stringify({model_transport:'gateway',workspace_id:id,system:'Review fixture',capabilities:workspaceProfile('review.issue',{}).capabilities,prompt:JSON.stringify(calls),
    tools:['read_file','run_command','finish_review'].map(name=>({function:{name,parameters:{type:'object'}}}))}));
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href,hook=join(base,'hooks.mjs'),seen=join(base,'model-results.jsonl');
  await writeFile(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='@earendil-works/pi-coding-agent'||context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  const child=spawn(process.execPath,['--import',hook,'runner/pi-entry.mjs',root],{env:{...process.env,BOT_RUNNER_TEST_ROOT:base,BOT_FIXTURE_RESULTS:seen},stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  let output='';child.stderr.on('data',chunk=>output+=chunk);t.after(async()=>{child.kill('SIGKILL');await closed;});
  assert.equal((await closed)[0],0,output);
  const results=Object.fromEntries((await readFile(seen,'utf8')).trim().split('\n').map(JSON.parse).map(({name,result})=>[name,JSON.parse(result.content[0].text)]));
  const events=await readFile(join(dir,'events.jsonl'),'utf8');
  for(const text of [JSON.stringify(results),events])for(const piece of ['424242_',header,payload,'fixture_*'])assert.ok(!text.includes(piece),piece);
  assert.equal(results.run_command.output,'github.com\n  - Token: [REDACTED]\n');
  assert.equal(results.read_file.content,code,'the model reads the code it may edit as it is');
  const logged=events.trim().split('\n').map(JSON.parse).filter(e=>e.type==='tool');
  assert.equal(logged.find(e=>e.name==='read_file').result.content,'const token = [REDACTED];\n','the event log applies every credential rule');
});
