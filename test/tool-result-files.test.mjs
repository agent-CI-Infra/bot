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
