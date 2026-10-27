import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {agentOperation} from '../runner/agent.mjs';

async function until(read){
  for(const end=Date.now()+10000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,20))){const value=await read();if(value)return value;}
  assert.fail('Timed out waiting for runner event');
}
test('Pi writes ordered, redacted tool starts before a blocked command returns and retains results',async t=>{
  await mkdir('.tmp',{recursive:true});const base=await mkdtemp(resolve('.tmp/pi-events-')),root=join(base,'a'.repeat(48)),dir=join(root,'agent');
  await mkdir(dir,{recursive:true});await mkdir(join(root,'repo'));t.after(()=>rm(base,{recursive:true,force:true}));
  const token='runner-private-token',command=`printf '${token}'; while [ ! -f release ]; do sleep 0.05; done`;
  const calls=[{name:'github_read_token',args:{}},{name:'write_file',args:{path:'file.txt',content:'private body excluded from start'}},
    {name:'read_file',args:{path:'file.txt'}},{name:'run_command',args:{command}},
    {name:'create_pull_request',args:{summary:'Ready',test_command:'true'}},{name:'finish_review',args:{summary:'Done'}}];
  await writeFile(join(dir,'input.json'),JSON.stringify({workspace_id:'a'.repeat(48),system:'fixture',prompt:JSON.stringify(calls),tools:calls.map(({name})=>({function:{name,parameters:{type:'object'}}}))}));
  const entry=pathToFileURL(resolve('runner/pi-entry.mjs')).href,fixture=pathToFileURL(resolve('test/fixtures/pi-session.mjs')).href;
  const hook=join(base,'hooks.mjs');await writeFile(hook,`import {registerHooks} from 'node:module';\nregisterHooks({resolve(specifier,context,next){if(specifier==='@earendil-works/pi-coding-agent'||context.parentURL===${JSON.stringify(entry)}&&specifier==='./workspace.mjs')return {url:${JSON.stringify(fixture)},shortCircuit:true};return next(specifier,context);}});`);
  const child=spawn(process.execPath,['--import',hook,'runner/pi-entry.mjs',root],{env:{...process.env,BOT_RUNNER_TEST_ROOT:base},stdio:['ignore','pipe','pipe']}),closed=once(child,'close');
  let output='';child.stderr.on('data',chunk=>output+=chunk);child.stdout.on('data',chunk=>output+=chunk);
  t.after(async()=>{child.kill('SIGKILL');await closed;});
  const events=async()=>JSON.parse('['+(await readFile(join(dir,'events.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).join(',')+']');
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
  for(const [i,call] of calls.entries())assert.deepEqual(all.slice(i*3,i*3+3).map(event=>event.type),['model','tool_start','tool'],call.name);
  assert.equal(all.find(event=>event.type==='tool'&&event.name==='run_command').result.output,'[REDACTED]');
  assert.equal(all.at(-2).name,'finish_review');
});

test('poll exposes event pagination so completed and failed agents can drain all remaining logs',async t=>{
  await mkdir('.tmp',{recursive:true});const root=await mkdtemp(resolve('.tmp/event-pages-')),dir=join(root,'agent');
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
