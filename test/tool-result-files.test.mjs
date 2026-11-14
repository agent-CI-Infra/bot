import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../dist/storage/database.js';

async function* chunks(value){const bytes=Buffer.from(value);for(let offset=0;offset<bytes.length;offset+=10001)yield bytes.subarray(offset,offset+10001);}

test('immutable result files page UTF-8 without re-running their source and isolate owners',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const files=store.trajectories.results,scope=store.trajectories.scopeOf({id:'turn',repository_id:'101',conversation_id:'chat'}),text=('中😀abc\n').repeat(25000);
  const ref=await files.save('role-a',scope,'operation',chunks(text),()=>{});
  assert.equal(ref.bytes,Buffer.byteLength(text));assert.ok(!ref.file.includes('/'));
  let position=0,restored='';
  do{const page=files.read('role-a',ref.file,position,32767);assert.equal(page.error,undefined);assert.ok(!page.content.includes('\ufffd'));restored+=page.content;position=page.next_position;if(page.eof)break;}while(position<ref.bytes);
  assert.equal(restored,text);assert.equal(position,ref.bytes);
  assert.deepEqual(files.read('role-b',ref.file),{error:'tool_result_not_found'});
  assert.equal(files.read('role-a',ref.file,-1).error,'tool_result_range_invalid');assert.equal(files.read('role-a',ref.file,1).error,'tool_result_range_invalid');
  assert.equal(files.read('role-a',ref.file,0,1).error,'tool_result_range_invalid');assert.equal(files.read('role-a',ref.file,ref.bytes).eof,true);
  assert.equal((await files.save('role-a',scope,'operation',(async function*(){assert.fail('replay must not fetch the source again');})(),()=>{})).file,ref.file);
  store.trajectories.remove({conversation_id:'chat'});assert.equal(files.read('role-a',ref.file).error,'tool_result_not_found');
});

test('revocation while a result streams leaves no readable file or metadata',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  let current=true;const files=store.trajectories.results,scope=store.trajectories.scopeOf({id:'turn',repository_id:'101',conversation_id:'chat'});
  await assert.rejects(files.save('role-a',scope,'operation',(async function*(){yield 'first';current=false;yield 'later';})(),()=>{if(!current)throw new Error('revoked');}),/revoked/);
  assert.equal(store.get('SELECT count(*) n FROM tool_result_files').n,0);
});

import { ResultSession, commandResult, resultOwner } from '../dist/agent/tool-results.js';
import { boundedBatch, ToolTranscript } from '../dist/agent/tool-context.js';

for (const running of [false,true]) test(`${running?'background startup snapshots':'command files'} survive context folding, replay without source reads, and retain a bounded head and tail`,async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const scope=store.trajectories.scopeOf({id:'turn',repository_id:'101',conversation_id:'chat'});
  let authorized=true,owner='role-a',reads=0;
  const secrets=['sensitive-split-secret'];
  const session=new ResultSession(store,scope,()=>owner,()=>{if(!authorized)throw new Error('revoked');},secrets);
  const text='HEAD\n'+('中😀data\n'.repeat(70000))+'sensitive-split-secret\nERROR_AT_END\n';
  const data=Buffer.from(text),preview={exit_code:running?null:1,running,timed_out:false,truncated:true,output_file:'/private/runner/output',...(running?{log_path:'/runner/live-output'}:{}),head:text.slice(0,300000),tail:text.slice(-300000),output:text};
  const page=async offset=>{reads++;let end=Math.min(offset+65536,data.length);while(end<data.length&&(data[end]&0xc0)===0x80)end--;return {data:data.subarray(offset,end).toString('utf8'),offset:end,size:data.length};};
  const result=await session.execute('run_command',{},()=>commandResult(preview,'op',page));
  assert.equal(result.error,undefined);assert.equal(result.output_file,undefined);assert.equal(result.exit_code,running?null:1);
  if(running){assert.match(result.notice,/startup snapshot/);assert.equal(result.log_path,preview.log_path);}
  const count=reads;
  assert.equal((await session.execute('run_command',{},()=>commandResult(preview,'op',()=>assert.fail('must replay')))).file,result.file);
  const [small]=boundedBatch([result],8192);assert.equal(small.file,result.file);assert.match(small.tail,/ERROR_AT_END/);assert.match(small.head,/HEAD/);assert.ok(Buffer.byteLength(JSON.stringify(small))<=8192);
  const messages=[{role:'tool',content:JSON.stringify(small)},{role:'assistant',content:'later'}];new ToolTranscript(messages,1).fit({messages});
  const folded=JSON.parse(messages[0].content);assert.equal(folded.elided,true);assert.equal(folded.file,result.file);assert.match(folded.notice,/read_tool_result/);
  if(running)assert.match(folded.notice,/startup snapshot/);
  let position=0,restored='';
  for(;;){const part=await session.execute('read_tool_result',{file:result.file,position,length:65536},()=>assert.fail('must not execute'));restored+=part.content;if(part.eof)break;position=part.next_position;}
  assert.equal(restored,text.replaceAll(secrets[0],'[REDACTED]'));assert.equal(reads,count);
  owner='role-b';assert.equal((await session.read({file:result.file})).error,'tool_result_not_found');owner='role-a';
  authorized=false;await assert.rejects(session.read({file:result.file}),/revoked/);
});

test('nested own tasks and roles keep their own result owners',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const scope=store.trajectories.scopeOf({id:'turn',conversation_id:'chat'}),host=new ResultSession(store,scope,()=>resultOwner('host'),()=>{}),child=new ResultSession(store,scope,()=>resultOwner('child'),()=>{});
  const value={truncated:true,output_file:'/private',head:'head',tail:'tail'};
  const reference=await host.run(async()=>child.run(async()=>host.run(async()=>
    commandResult(value,'operation',async()=>({data:'complete',offset:8,size:8}))),true));
  assert.equal((await host.read({file:reference.file})).error,'tool_result_not_found');assert.equal((await child.read({file:reference.file})).content,'complete');
});

import { messageResultSources } from '../dist/storage/tool-results.js';
test('source changes invalidate only files that depended on those messages and preserve the conversation owner',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  store.run("INSERT INTO channel_chats(id,provider,app_id,installation_tenant,chat_id,chat_type,connector_id,created_at,last_received_at) VALUES('chat','feishu','app','tenant','chat','group','connector',1,1)");
  store.run("INSERT INTO channel_messages VALUES('chat','old','user','tenant','user','text',1,1,1,'event','','','',0,0,'original')");
  const scope=store.trajectories.scopeOf({id:'turn',conversation_id:'chat'}),session=new ResultSession(store,scope,()=> 'same-conversation',()=>{},[],()=>messageResultSources(store.db,['chat']));
  const save=key=>session.execute('run_command',{},()=>commandResult({truncated:true,output_file:'/runner',head:'h',tail:'t'},key,async()=>({data:'complete',offset:8,size:8})));
  const original=await save('old');
  store.run("INSERT INTO channel_messages VALUES('chat','new','user','tenant','user','text',2,2,2,'event','','','',0,0,'later')");store.run("UPDATE channel_messages SET deleted=1 WHERE message_id='new'");
  assert.equal((await session.read({file:original.file})).content,'complete','a later message was never an input of this result');
  store.run("UPDATE channel_messages SET deleted=1,updated_at=3 WHERE message_id='old'");
  assert.equal((await session.read({file:original.file})).error,'tool_result_source_changed');
  const current=await save('new');assert.equal((await session.read({file:current.file})).content,'complete');
});
