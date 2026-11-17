import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
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

test('a failing removal deletes the rows first, so a leftover file is unreferenced and no row loses its content',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const files=store.trajectories.results,scope=store.trajectories.scopeOf({id:'turn',repository_id:'101',conversation_id:'chat'});
  const kept=await files.save('role-a',store.trajectories.scopeOf({id:'turn-2',repository_id:'101',conversation_id:'other'}),'kept',chunks('kept'),()=>{});
  const ref=await files.save('role-a',scope,'removed',chunks('removed'),()=>{});
  const target=files.path(ref.file.slice(7),'role-a');
  // The rows go before the files: making the file step fail leaves no row whose content is missing.
  rmSync(target);mkdirSync(target);writeFileSync(join(target,'leftover'),'x');
  assert.throws(()=>files.remove('conversation_id','chat'),/EISDIR/);
  assert.equal(store.get("SELECT count(*) n FROM tool_result_files WHERE conversation_id='chat'").n,0,'the row is already gone');
  assert.equal(existsSync(target),true,'the leftover file remains for a later sweep');
  assert.equal(files.read('role-a',ref.file).error,'tool_result_not_found','no row refers to the removed result');
  for(const row of store.all('SELECT file FROM tool_result_files'))assert.equal(existsSync(files.path(row.file,'role-a')),true,'every remaining row still has its content');
  assert.equal(files.read('role-a',kept.file).content,'kept');
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

test('editing and recalling source messages preserves results while authorization is still checked',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  store.run("INSERT INTO channel_chats(id,provider,app_id,installation_tenant,chat_id,chat_type,connector_id,created_at,last_received_at) VALUES('chat','feishu','app','tenant','chat','group','connector',1,1)");
  store.run("INSERT INTO channel_messages VALUES('chat','old','user','tenant','user','text',1,1,1,'event','','','',0,0,'original')");
  const scope=store.trajectories.scopeOf({id:'turn',conversation_id:'chat'}),session=new ResultSession(store,scope,()=> 'same-conversation',()=>{},[]);
  const save=key=>session.execute('run_command',{},()=>commandResult({truncated:true,output_file:'/runner',head:'h',tail:'t'},key,async()=>({data:'complete',offset:8,size:8})));
  const original=await save('old');
  store.run("INSERT INTO channel_messages VALUES('chat','new','user','tenant','user','text',2,2,2,'event','','','',0,0,'later')");store.run("UPDATE channel_messages SET deleted=1 WHERE message_id='new'");
  assert.equal((await session.read({file:original.file})).content,'complete','a later message was never an input of this result');
  store.run("UPDATE channel_messages SET deleted=1,updated_at=3 WHERE message_id='old'");
  assert.equal((await session.read({file:original.file})).content,'complete');
  const current=await save('new');assert.equal((await session.read({file:current.file})).content,'complete');
});

test('non-command JSON keeps its tail and can be restored after batch compression and later elision',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const scope=store.trajectories.scopeOf({id:'turn',repository_id:'101',conversation_id:'chat'});
  const session=new ResultSession(store,scope,()=> 'project-a',()=>{},['secret-with-"quotes']);
  const value={issues:Array.from({length:10000},(_,i)=>({number:i,body:'中😀 secret-with-"quotes'})),last_error:'ERROR_AT_END'};
  const [small,large]=boundedBatch([{ok:true},value],20000,session.preserve);
  assert.deepEqual(small,{ok:true});assert.match(large.tail,/ERROR_AT_END/);assert.equal(large.encoding,'utf-8');assert.ok(large.expires_at);
  assert.equal(store.get('SELECT count(*) n FROM tool_result_files').n,1);
  let content='',position=0;
  for(;;){const page=await session.read({file:large.file,position,length:32767});content+=page.content;if(page.eof)break;position=page.next_position;}
  assert.deepEqual(JSON.parse(content),JSON.parse(JSON.stringify(value).replaceAll('secret-with-\\"quotes','[REDACTED]')));
  const messages=[{role:'tool',content:JSON.stringify({later:'x'.repeat(100000)})},{role:'assistant',content:'next'}];
  new ToolTranscript(messages,1000,session.preserve).fit({messages});
  const folded=JSON.parse(messages[0].content);assert.equal(folded.elided,true);assert.ok(folded.file);
  assert.match((await session.read({file:folded.file,length:32})).content,/later/);
});

test('result expiry removes bytes, returns expired and preserves computer ownership across scopes',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const files=store.trajectories.results,scope=store.trajectories.scopeOf({id:'turn',conversation_id:'chat'});
  const ref=files.saveText('computer-a',scope,'github_read:operation','中😀');
  const otherTurn=new ResultSession(store,store.trajectories.scopeOf({id:'turn-2',conversation_id:'other'}),()=> 'computer-a',()=>{});
  assert.equal((await otherTurn.read({file:ref.file})).content,'中😀');
  assert.equal(files.read('computer-b',ref.file).error,'tool_result_not_found');
  store.run('UPDATE tool_result_files SET expires_at=? WHERE file=?',new Date(Date.now()-1).toISOString(),ref.file.slice(7));files.sweep();
  assert.equal(existsSync(files.path(ref.file.slice(7),'computer-a')),false);
  assert.equal(files.read('computer-a',ref.file).error,'tool_result_expired');
  assert.equal(files.read('computer-b',ref.file).error,'tool_result_not_found');
});

test('a storage failure returns no usable handle',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const session=new ResultSession(store,store.trajectories.scopeOf({id:'turn',conversation_id:'chat'}),()=> 'computer',()=>{});
  store.trajectories.results.saveText=()=>{throw new Error('disk full');};
  const result=await session.execute('github_read',{},async()=>({body:'x'.repeat(300000)}));
  assert.equal(result.error,'tool_result_storage_failed');assert.equal(result.file,undefined);
});


test('upgrading legacy command results preserves handles and moves them to the project computer',async t=>{
  const root=mkdtempSync(join(tmpdir(),'legacy-results-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const key=Buffer.alloc(32,1),path=join(root,'control.sqlite');let store=new Store(path,key);
  const scope=store.trajectories.scopeOf({id:'turn',repository_id:'101',conversation_id:'chat'}),files=store.trajectories.results;
  const ref=files.saveText('old-role-owner',scope,'old-operation','original 中😀');
  mkdirSync(join(store.trajectories.root,'results'),{recursive:true});
  const legacy=join(store.trajectories.root,'results',ref.file.slice(7)+'.utf8');
  writeFileSync(legacy,'original 中😀');rmSync(files.path(ref.file.slice(7),'old-role-owner'));store.close();
  store=new Store(path,key);t.after(()=>store.close());
  const owner=projectResultOwner('101');assert.equal(store.trajectories.results.read(owner,ref.file).content,'original 中😀');
  assert.equal(existsSync(legacy),false);assert.ok(existsSync(store.trajectories.results.path(ref.file.slice(7),owner)));
});

import { projectResultOwner, assistantResultOwner } from '../dist/agent/tool-results.js';
import { ownerId } from '../dist/service-roles/assistant-computers.js';
test('recent results are bounded, expire and are shared by the same assistant computer across conversations',async t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const owner=assistantResultOwner(ownerId({kind:'person',tenant:'organization',subject:'user'}));
  const first=new ResultSession(store,store.trajectories.scopeOf({id:'turn-1',conversation_id:'private-chat'}),()=>owner,()=>{});
  for(let i=0;i<15;i++)first.preserve({content:'result-'+i},'github_read');
  const next=new ResultSession(store,store.trajectories.scopeOf({id:'turn-2',conversation_id:'console-chat'}),()=>owner,()=>{});
  const recent=next.recent();assert.equal(recent.length,10);assert.ok(Buffer.byteLength(JSON.stringify(recent))<=2048);assert.ok(recent.every(row=>row.tool==='github_read'));
  assert.match((await next.read({file:recent[0].file})).content,/result-/);
  assert.equal(new ResultSession(store,first.scope,()=>assistantResultOwner(ownerId({kind:'group',tenant:'organization',subject:'group'})),()=>{}).recent().length,0);
  store.run('UPDATE tool_result_files SET expires_at=?',new Date(Date.now()-1).toISOString());assert.deepEqual(next.recent(),[]);
});
