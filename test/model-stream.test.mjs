import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {setImmediate as turn} from 'node:timers/promises';
import {harness,setup,account,repository} from './helpers.mjs';
import {agentLoop} from '../dist/agent/loop.js';
import {Redactor} from '../dist/agent/common.js';
import {readModelResponse} from '../dist/agent/model-stream.js';
import {agentOperation} from '../runner/agent.mjs';
import {waitModelReply,modelReplyIdleMs} from '../runner/model-reply.mjs';

const requestId='a'.repeat(48),key='stream-fixture-credential',finish={summary:'Done',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
const sse=(delta,extra={})=>'data: '+JSON.stringify({choices:[{index:0,delta,...extra}]})+'\n\n';
const flush=async()=>{for(let i=0;i<5;i++)await turn();};
async function until(check){for(let i=0;i<2000;i++){if(check())return;await turn();}assert.fail('fixture did not reach the expected state');}

async function fixture(t,{stream=true,failDelivery=false}={}){
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:'http://model.invalid/v1',api_key:key,model_name:'fixture'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('stream','101','review.pr','running','fixture')");
  const root=h.directory+'/runner',dir=root+'/agent';await mkdir(dir,{recursive:true});
  await writeFile(dir+'/request.json',JSON.stringify({id:requestId}));
  const requests=[],progress=[],replies=[];let replied=false,source,signal;
  const work={log:()=>{},deliver:async input=>{
    requests.push(input);const result=await agentOperation(input,root);progress.push(input);return result;
  },call:async(_key,input)=>{
    requests.push(input);
    if(input.type==='workspace_agent_poll')return replied?{state:'completed',result:finish}:{state:'running',request:{id:requestId,body:{stream,messages:[{role:'user',content:'review'}]}}};
    if(input.type==='workspace_agent_reply'){
      assert.equal(h.store.get('SELECT state FROM model_requests').state,'received','usage must be persisted before any reply bytes');
      if(failDelivery)return {error:'fixture-disconnected'};
      replies.push(Buffer.from(input.base64,'base64'));await agentOperation(input,root);replied=input.final;
    }
    return {};
  }};
  const fetchMock=t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'http://model.invalid/v1/chat/completions');
    const body=JSON.parse(options.body);assert.equal(body.stream,true);assert.deepEqual(body.stream_options,{include_usage:true});
    assert.equal(body.max_completion_tokens,8192);assert.ok(!('max_tokens' in body));
    signal=options.signal;
    return new Response(new ReadableStream({start(controller){source=controller;signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
  });
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000000});
  const running=agentLoop(h.store,h.store.get("SELECT * FROM tasks WHERE id='stream'"),work,new Redactor(),async()=>{},{});
  // Attach an error handler now: advancing a fake clock may reject before the assertion awaits it.
  running.catch(()=>{});await until(()=>source);
  return {h,admin,root,dir,running,requests,progress,replies,signal,
    send:async text=>{source.enqueue(Buffer.from(text));await flush();},
    restore:()=>{t.mock.timers.reset();fetchMock.mock.restore();},
  };
}

test('90 seconds without tokens fails even with comments, role, empty content and tool metadata; the UI names token inactivity',async t=>{
  const f=await fixture(t);let ended=false;f.running.finally(()=>{ended=true;}).catch(()=>{});
  await f.send(sse({role:'assistant'}));
  t.mock.timers.tick(45000);await f.send(': keep-alive\n\n');
  t.mock.timers.tick(44000);await f.send('\n'+sse({content:'',tool_calls:[{index:0,id:'call',function:{name:'write_file',arguments:''}}]}));
  t.mock.timers.tick(999);await flush();assert.equal(ended,false);
  t.mock.timers.tick(1);
  let failure;await assert.rejects(f.running,error=>{failure=error;return error.code==='model_unavailable'&&error.state==='retry_wait'&&/连续 90 秒没有 token 输出/.test(error.detail);});
  assert.equal(f.signal.aborted,true);assert.equal(f.progress.length,0);assert.equal(f.replies.length,0);
  assert.equal(f.h.store.get('SELECT state FROM model_requests').state,'transport_error');
  f.restore();
  f.h.store.run("UPDATE tasks SET status='retry_wait',error_code='model_unavailable' WHERE id='stream'");
  f.h.store.run('INSERT INTO task_logs(id,task_id,content) VALUES(?,?,?)','idle','stream',JSON.stringify({type:'fault',code:failure.code,state:failure.state,detail:failure.detail}));
  const detail=(await f.admin('/api/tasks/stream')).value.task,list=(await f.admin('/api/tasks')).value.tasks[0],log=(await f.admin('/api/tasks/stream/logs')).value.logs[0];
  for(const cause of [detail.error_cause,list.error_cause,log.cause]){
    assert.equal(cause.cause,'external','other model_unavailable causes retain their classification');
    assert.match(cause.label,/连续 90 秒没有 token 输出/);assert.match(cause.action,/自动重试/);
    assert.doesNotMatch(cause.label+cause.action,/外部服务或网络波动|不是配置问题/);
  }
});

test('text, reasoning and tool arguments keep both mailboxes alive beyond 120 seconds, with usage before the reply',async t=>{
  const f=await fixture(t);
  const waiting=waitModelReply(f.dir,requestId);waiting.catch(()=>{});
  await f.send(sse({content:'可见文本'}));await until(()=>f.progress.length===1);
  t.mock.timers.tick(60000);await flush();
  await f.send(sse({reasoning_content:'推理文本'}));await until(()=>f.progress.length===2);
  t.mock.timers.tick(100);await flush();
  t.mock.timers.tick(59900);await flush();
  await f.send(sse({tool_calls:[{index:0,id:'tool',type:'function',function:{name:'write_',arguments:'{"path":"../notes/repository.md",'}}]}));await until(()=>f.progress.length===3);
  t.mock.timers.tick(100);await flush();
  t.mock.timers.tick(59900);await flush();
  await f.send(sse({tool_calls:[{index:0,function:{name:'file',arguments:'"content":"safe note"}'}}]}));await until(()=>f.progress.length===4);
  await f.send(sse({},{finish_reason:'tool_calls'})+'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:200,prompt_tokens_details:{cached_tokens:750}}})+'\n\ndata: [DONE]\n\n');
  await f.running;t.mock.timers.tick(100);const runnerReply=await waiting;
  assert.ok(Date.now()>=1180000,'the complete request ran for 180 seconds');
  const reply=JSON.parse(Buffer.concat(f.replies));assert.deepEqual(reply,runnerReply);
  const chunk=JSON.parse(reply.body.split('\n')[0].slice(6)),delta=chunk.choices[0].delta;
  assert.equal(delta.content,'可见文本');assert.equal(delta.reasoning_content,'推理文本');
  assert.equal(delta.tool_calls[0].function.name,'write_file');
  assert.deepEqual(JSON.parse(delta.tool_calls[0].function.arguments),{path:'../notes/repository.md',content:'safe note'});
  const usage=f.h.store.get('SELECT * FROM model_requests');assert.deepEqual([usage.state,usage.input_tokens,usage.output_tokens,usage.cached_input_tokens],['received',1000,200,750]);
  assert.ok(f.progress.every(p=>Object.keys(p).sort().join(',')==='request_id,sequence,type'),'activity carries no model output');
});

test('the 90-second deadline resets on a token, then expires after the last token even if comments continue',async t=>{
  const f=await fixture(t);t.mock.timers.tick(80000);await f.send(sse({reasoning:'thinking'}));await until(()=>f.progress.length===1);
  t.mock.timers.tick(80000);await f.send(': alive\n\n');assert.equal(f.signal.aborted,false);
  t.mock.timers.tick(9999);await flush();assert.equal(f.signal.aborted,false);
  t.mock.timers.tick(1);await assert.rejects(f.running,error=>error.code==='model_unavailable'&&/连续 90 秒没有 token 输出/.test(error.detail));
});

test('fragmented credentials reach note writes verbatim while text and reasoning remain masked',async t=>{
  const f=await fixture(t,{stream:false});
  const args=JSON.stringify({path:'../notes/secret.md',content:key}),at=args.indexOf(key)+8;
  await f.send(sse({content:key.slice(0,8),reasoning_content:key.slice(0,8),tool_calls:[{index:0,id:'note',function:{name:'write_file',arguments:args.slice(0,at)}}]}));
  await f.send(sse({content:key.slice(8),reasoning_content:key.slice(8),tool_calls:[{index:0,function:{arguments:args.slice(at)}}]}));
  await f.send(sse({},{finish_reason:'tool_calls'})+'data: [DONE]\n\n');await f.running;
  const reply=JSON.parse(Buffer.concat(f.replies)),message=JSON.parse(reply.body).choices[0].message;
  assert.ok(!('rejected_note_calls' in reply));assert.equal(JSON.parse(message.tool_calls[0].function.arguments).content,key);
  assert.equal(message.content,'[REDACTED]');assert.equal(message.reasoning_content,'[REDACTED]');
  assert.ok(!JSON.stringify(f.requests).includes(key));
});

test('a disconnected runner does not undo provider usage already recorded from the stream',async t=>{
  const f=await fixture(t,{failDelivery:true});
  await f.send(sse({content:'done'},{finish_reason:'stop'})+'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
  await assert.rejects(f.running,error=>error.code==='execution_interrupted');
  assert.deepEqual({...f.h.store.get('SELECT state,input_tokens,output_tokens FROM model_requests')},{state:'received',input_tokens:12,output_tokens:4});
});

test('the runner fails only after 95 seconds idle, and duplicate activity cannot keep it alive',async t=>{
  const f=await fixture(t);let polls=0;
  const schedule=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{if(delay===100)polls++;return schedule(callback,delay,...args);});
  const waiting=waitModelReply(f.dir,requestId);waiting.catch(()=>{});await until(()=>polls===1);
  await agentOperation({type:'workspace_agent_progress',request_id:requestId,sequence:1},f.root);
  t.mock.timers.tick(100);await until(()=>polls===2);
  for(let n=0;n<2;n++){
    await agentOperation({type:'workspace_agent_progress',request_id:requestId,sequence:1},f.root);
    t.mock.timers.tick(45000);await until(()=>polls===n+3);
  }
  assert.equal(modelReplyIdleMs,95000);
  t.mock.timers.tick(4999);await until(()=>polls===5);
  t.mock.timers.tick(100);await assert.rejects(waiting,/model_proxy_timeout/);
  // The control plane has also reached its own 90-second idle deadline.
  await assert.rejects(f.running,error=>error.code==='model_unavailable');
  await assert.rejects(agentOperation({type:'workspace_agent_progress',request_id:'b'.repeat(48),sequence:2},f.root),/agent_request_changed/);
  await assert.rejects(agentOperation({type:'workspace_agent_progress',request_id:requestId,sequence:0},f.root),/invalid_agent_progress/);
});

test('the runner treats advancing reply bytes as activity while waiting for the atomic final reply',async t=>{
  const f=await fixture(t);let polls=0;const schedule=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{if(delay===100)polls++;return schedule(callback,delay,...args);});
  const waiting=waitModelReply(f.dir,requestId);waiting.catch(()=>{});await until(()=>polls===1);
  const reply=Buffer.from(JSON.stringify({status:200,content_type:'application/json',body:'done'}));
  await agentOperation({type:'workspace_agent_reply',request_id:requestId,offset:0,base64:reply.subarray(0,20).toString('base64'),final:false},f.root);
  t.mock.timers.tick(60000);await until(()=>polls===2);
  await agentOperation({type:'workspace_agent_reply',request_id:requestId,offset:20,base64:reply.subarray(20,40).toString('base64'),final:false},f.root);
  t.mock.timers.tick(60000);await until(()=>polls===3);
  await agentOperation({type:'workspace_agent_reply',request_id:requestId,offset:40,base64:reply.subarray(40).toString('base64'),final:true},f.root);
  t.mock.timers.tick(100);assert.deepEqual(await waiting,JSON.parse(reply));
  await assert.rejects(f.running,error=>error.code==='model_unavailable');
});

test('SSE parsing handles split UTF-8, CRLF and multi-line data, orders parallel tools, and preserves reasoning variants',async()=>{
  const raw=': comment\r\n\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中文","reasoning_text":"why","tool_calls":[{"index":1,"id":"second","function":{"name":"two","arguments":"{}"}},{"index":0,"id":"first","function":{"name":"one","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes=Buffer.from(raw);let tokens=0;
  const response=new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
  const result=await readModelResponse(response,async()=>{tokens++;});
  assert.equal(result.choices[0].message.content,'中文');assert.equal(result.choices[0].message.reasoning_text,'why');
  assert.deepEqual(result.choices[0].message.tool_calls.map(c=>c.id),['first','second']);assert.equal(tokens,1);
});

test('a truncated or malformed stream never forwards a partial tool call, and the response byte limit is enforced while reading',async t=>{
  for(const raw of [sse({tool_calls:[{index:0,function:{arguments:'{"unfinished":'}}]}),'data: {invalid}\n\n','data: {"error":{"message":"provider failed"}}\n\n','x'.repeat(2*1024*1024+1)]){
    await t.test(raw.length>100?'oversized or partial stream':raw.trim(),async()=>{
      const response=new Response(new ReadableStream({start(c){c.enqueue(Buffer.from(raw));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
      await assert.rejects(readModelResponse(response,async()=>{}),error=>['model_response_invalid','model_response_too_large'].includes(error.code));
    });
  }
});
