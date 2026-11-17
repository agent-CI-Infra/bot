import { Store } from '../dist/storage/database.js';
import { ResultSession } from '../dist/agent/tool-results.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolResultGuard} from '../runner/repository-context.mjs';

// The runner's limit: estimated tokens of the serialized request + 8192 output tokens (+ reserve) must stay within 128k.
const limit=4*(128000-8192);
const tooLarge=(raw,reserve=0)=>Math.ceil(raw.length/4)+8192+reserve>128000;
function session(t,{system='System prompt.',history=[]}={}){
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const files=new ResultSession(store,store.trajectories.scopeOf({id:'turn',conversation_id:'chat'}),()=> 'computer',()=>{});
  const messages=[{role:'system',content:system},...history];
  const guard=createToolResultGuard({getMessages:()=>messages,renderRequest:async projected=>JSON.stringify(projected),tooLarge,preserve:async(name,value)=>files.preserve(value,name)});
  // One assistant turn that calls the given tools; Pi records the results only after the whole batch.
  const turn=ids=>{messages.push({role:'assistant',content:ids.map(id=>({type:'toolCall',id,name:'tool',arguments:{}}))});guard.reset();};
  return {messages,guard,turn,files};
}
const output=size=>({exit_code:0,signal:null,output:'x'.repeat(size),timed_out:false,truncated:false});

test('a command output that cannot fit even after compaction is saved but keeps the command status',async t=>{
  const {guard,turn}=session(t);turn(['1']);
  const result=await guard('1','run_command',output(limit));
  assert.ok(result.file);assert.equal(result.exit_code,0);assert.equal(result.signal,null);assert.equal(result.timed_out,false);assert.equal(result.truncated,true);
  assert.ok(result.bytes>limit);assert.match(result.notice,/read_tool_result/);assert.equal(result.output,undefined);
});

test('a result that fits alone stays unchanged even when the whole history would not fit, so Pi can compact',async t=>{
  const history=[{role:'user',content:'h'.repeat(Math.floor(limit*0.6))}];
  const {guard,turn}=session(t,{history});turn(['1']);
  const value=output(Math.floor(limit*0.6));
  assert.deepEqual(await guard('1','run_command',value),value);
  // A GitHub read of the same size is still checked against the whole next request.
  turn(['2']);
  assert.ok((await guard('2','github_read',{content:'x'.repeat(Math.floor(limit*0.6))})).file);
});

test('sibling results, the system prompt and the compaction summary reserve count toward the kept request',async t=>{
  {
    const {guard,turn}=session(t);turn(['1','2']);
    const first=output(Math.floor(limit*0.55));
    assert.deepEqual(await guard('1','read_file',first),first);
    const second=await guard('2','read_file',{content:'y'.repeat(Math.floor(limit*0.55))});
    assert.ok(second.file);assert.match(second.notice,/read_tool_result/);
  }
  {
    const {guard,turn}=session(t,{system:'s'.repeat(Math.floor(limit*0.5))});turn(['1']);
    assert.ok((await guard('1','run_command',output(Math.floor(limit*0.55)))).file);
  }
  {
    // Fits the output allowance, but not once two compaction summaries of 8192 tokens are reserved.
    const {guard,turn}=session(t);turn(['1']);
    assert.ok((await guard('1','run_command',output(limit-4*8192))).file);
  }
});
