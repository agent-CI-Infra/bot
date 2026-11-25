import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeResponseFraming} from '../../../../dist/harness/response-framing.js';
import {PassthroughTap} from '../../../../dist/harness/model-formats.js';

for (const chunks of [['event: response.created\ndata: {}\n\n'], ['\ufeff\n', 'e', 'ven', 't:', ' response.created\ndata: {}\n\n'], [': heartbeat\n\n', 'data: {}\n\n'], ['da','ta: {}\n\n']]) {
  test('corrects mislabeled SSE without losing bytes: '+JSON.stringify(chunks),async()=>{
    const response=new Response(new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(Buffer.from(chunk));c.close();}}),{headers:{'content-type':'application/json'}});
    const normalized=await normalizeResponseFraming(response);
    assert.match(normalized.headers.get('content-type'),/text\/event-stream/);
    assert.equal(Buffer.from(await normalized.arrayBuffer()).toString(),chunks.join(''));
  });
}

test('a streaming request answered with actual JSON stays JSON',async()=>{
  const text='  {"output":[],"status":"completed"}';
  const normalized=await normalizeResponseFraming(new Response(text,{headers:{'content-type':'application/json'}}));
  assert.equal(normalized.headers.get('content-type'),'application/json');
  assert.equal(await normalized.text(),text);
});

test('does not wait for the completed SSE body and propagates client cancellation',async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('event: response.created\ndata: {}\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});
  const normalized=await normalizeResponseFraming(response);
  const reader=normalized.body.getReader();
  assert.ok((await reader.read()).value.length);
  await reader.cancel();assert.equal(cancelled,true);
});

test('inspection is bounded for unrecognized prefixes',async()=>{
  const text=' '.repeat(2048)+'{}';
  const normalized=await normalizeResponseFraming(new Response(text,{headers:{'content-type':'application/json'}}));
  assert.equal(normalized.headers.get('content-type'),'application/json');
  assert.equal(await normalized.text(),text);
});

test('correctly typed SSE and HTTP error responses are untouched',async()=>{
  for(const response of [new Response('data: {}\n\n',{headers:{'content-type':'text/event-stream'}}),new Response('{"error":"unauthorized"}',{status:401})])assert.equal(await normalizeResponseFraming(response),response);
});

test('actual Responses SSE decodes when the header advertised JSON',async()=>{
  const response={id:'resp_framing',model:'gpt-fixture',status:'completed',output:[{type:'message',id:'msg_1',role:'assistant',content:[{type:'output_text',text:'READY',annotations:[]}]}],usage:{input_tokens:4,output_tokens:2}};
  const body=`event: response.created\ndata: ${JSON.stringify({type:'response.created',response:{...response,status:'in_progress',output:[]}})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:'response.completed',response})}\n\n`;
  const normalized=await normalizeResponseFraming(new Response(body,{headers:{'content-type':'application/json'}}));
  const tap=new PassthroughTap('openai-responses',normalized.headers.get('content-type').includes('text/event-stream'),'gpt-fixture');
  tap.push(new Uint8Array(await normalized.arrayBuffer()));
  const summary=tap.end();
  assert.equal(summary.stop_reason,'completed');assert.equal(summary.usage.input_tokens,4);assert.equal(summary.content,'READY');
});
