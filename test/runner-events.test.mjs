import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {agentOperation} from '../runner/agent.mjs';
import {workspaceProfile} from '../dist/agent/profiles.js';
import {randomWorkspaceId} from './helpers.mjs';

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
  await writeFile(join(dir,'input.json'),JSON.stringify({workspace_id:id,system:'fixture',capabilities:workspaceProfile('development.issue',{}).capabilities,prompt:JSON.stringify(calls),tools:calls.map(({name})=>({function:{name,parameters:{type:'object'}}}))}));
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
  const request=await until(()=>readFile(join(dir,'token-request.json'),'utf8').then(JSON.parse).catch(()=>null));
  await writeFile(join(dir,`token-reply-${request.id}.json`),JSON.stringify({token,expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'read'},repository:'fixture/repo'}));
  await until(async()=>(await events()).find(event=>event.type==='tool_start'&&event.name==='run_command'));
  const pending=await events(),start=pending.find(event=>event.type==='tool_start'&&event.name==='run_command');
  assert.equal(start.command,command.replaceAll(token,'[REDACTED]'));assert.ok(!JSON.stringify(pending).includes(token));
  assert.ok(!pending.some(event=>event.type==='tool'&&event.name==='run_command'),'result does not exist while command waits');
  const writeStart=pending.find(event=>event.type==='tool_start'&&event.name==='write_file');assert.equal(writeStart.path,'file.txt');assert.ok(!JSON.stringify(writeStart).includes('private body'));
  assert.equal(pending.find(event=>event.type==='tool_start'&&event.name==='read_file').path,'file.txt');
  await writeFile(join(root,'repo','release'),'');
  const publication=await until(()=>readFile(join(dir,'pr-request.json'),'utf8').then(JSON.parse).catch(()=>null));
  const publishing=await events();assert.ok(publishing.some(event=>event.type==='tool_start'&&event.name==='create_pull_request'));
  assert.ok(!publishing.some(event=>event.type==='tool'&&event.name==='create_pull_request'));
  await writeFile(join(dir,`pr-reply-${publication.id}.json`),JSON.stringify({pr:{number:1,html_url:'https://github.invalid/pull/1'}}));
  const [code]=await closed;assert.equal(code,0,output);assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).state,'completed',output);
  const all=await events();assert.ok(!JSON.stringify(all).includes(token));
  assert.equal((await readFile(join(base,'project-notes/repository.md'))).length,131072);
  assert.equal(await readFile(join(base,'project-notes/secret.md'),'utf8'),'secret '+token);
  assert.equal(all.find(event=>event.type==='tool'&&event.arguments?.path==='../notes/secret.md').result.written,true);
  // The session event comes first: the runtime and the exact tools, with no extensions, skills or context files mixed in.
  const session=all.shift();assert.deepEqual([session.type,session.agent,session.extensions,session.skills,session.context_files],['pi_session','pi',0,0,0]);
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
  await writeFile(join(dir,'input.json'),JSON.stringify({workspace_id:id,system:'Review fixture',capabilities:workspaceProfile('review.issue',{}).capabilities,prompt:JSON.stringify(calls),tools:['write_file','finish_review'].map(name=>({function:{name,parameters:{type:'object'}}}))}));
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
