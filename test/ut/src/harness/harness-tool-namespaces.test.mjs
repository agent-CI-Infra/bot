import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDownstreamRequest,serializeUpstreamRequest,DownstreamResponseBuilder} from '../../../../dist/harness/model-formats.js';

test('Responses namespace members survive translation to chat and back, including the next-turn call history',()=>{
 const request=parseDownstreamRequest('openai-responses',{model:'fixture',input:[{type:'function_call',namespace:'mcp__bot',name:'read_task_record',call_id:'c1',arguments:'{"ref":"task:t"}'},{type:'function_call_output',call_id:'c1',output:'{}'}],tools:[{type:'namespace',name:'mcp__bot',description:'Bot collaboration',tools:[{type:'function',name:'read_task_record',parameters:{type:'object',properties:{ref:{type:'string'}}}}]}]});
 const chat=serializeUpstreamRequest('openai-chat-completions',request,'fixture');
 assert.equal(chat.tools.length,1);assert.equal(chat.tools[0].function.name,'mcp__bot__read_task_record');assert.ok(chat.tools[0].function.parameters.properties.ref);
 assert.equal(chat.messages.find(m=>m.tool_calls)?.tool_calls[0].function.name,'mcp__bot__read_task_record');
 const names=new Map(request.tools.map(t=>[t.name,{namespace:t.namespace,name:t.localName}]));
 for(const stream of [false,true]){
  const builder=new DownstreamResponseBuilder('openai-responses',stream,'fixture',new Set(),names);
  const wire=builder.push([{type:'start',id:'r1',model:'fixture'},{type:'tool_call_start',index:0,callId:'c2',name:'mcp__bot__read_task_record'},{type:'tool_call_delta',index:0,delta:'{"ref":"task:t"}'},{type:'finish',stopReason:'tool_use'}]);
  const final=builder.finalize();
  const output=final.jsonSnapshot.output.find(item=>item.type==='function_call');
  assert.equal(output.namespace,'mcp__bot');assert.equal(output.name,'read_task_record');
  if(stream){assert.match(wire,/"namespace":"mcp__bot"/);assert.ok(!wire.includes('"name":"mcp__bot__read_task_record"'));}
 }
});
