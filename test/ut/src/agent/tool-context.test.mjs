import { Store } from '../../../../dist/storage/database.js';
import { ResultSession } from '../../../../dist/agent/tool-results.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchBytes, boundedBatch, boundedResult, chatContextBytes, hasImageContent, imageRequestLimit, requestBytes, requestLimit, textRequestBytes, toolArguments, toolCallsProblem, ToolTranscript } from '../../../../dist/agent/tool-context.js';
import { managementFailure, serviceFailure } from '../../../../dist/management/presentation.js';

// #333: tool loops check only the structure of tool calls and keep their requests bounded, whatever the number of calls.
const call = (id, name = 'github_search', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });

test('any number of structurally valid tool calls is accepted; malformed, duplicate or nameless calls are not', () => {
  const many = Array.from({ length: 50 }, (_, i) => call('call_' + i));
  assert.equal(toolCallsProblem(many), null);
  assert.equal(toolCallsProblem([]), null);
  // Provider id styles seen in practice.
  assert.equal(toolCallsProblem([call('toolu_01AbC'), call('functions.list_projects:0'), call('call-7')]), null);
  assert.equal(toolCallsProblem({}), 'tool_calls_not_array');
  assert.equal(toolCallsProblem([{ ...call('a'), type: 'code' }]), 'tool_call_type');
  assert.equal(toolCallsProblem([call('')]), 'tool_call_id');
  assert.equal(toolCallsProblem([call('has space')]), 'tool_call_id');
  assert.equal(toolCallsProblem([call('x'.repeat(129))]), 'tool_call_id');
  assert.equal(toolCallsProblem([call('a'), call('a')]), 'tool_call_id_duplicate');
  assert.equal(toolCallsProblem([call('a', '')]), 'tool_call_function');
  assert.equal(toolCallsProblem([{ ...call('a'), function: { name: 'x', arguments: { q: 1 } } }]), 'tool_call_function');
  // A call without parameters may omit its arguments or send an empty string.
  assert.equal(toolCallsProblem([{ id: 'a', type: 'function', function: { name: 'list_projects' } }]), null);
  assert.deepEqual(toolArguments({ function: {} }), {});
  assert.deepEqual(toolArguments({ function: { arguments: ' ' } }), {});
  assert.deepEqual(toolArguments({ function: { arguments: '{"q":1}' } }), { q: 1 });
  assert.equal(toolArguments({ function: { arguments: '{broken' } }), null);
});

test('a batch keeps small results whole and saves large results within its total budget',t=>{
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const files=new ResultSession(store,store.trajectories.scopeOf({id:'turn',conversation_id:'chat'}),()=> 'computer',()=>{});
  const config={revision:'r1',workflows:'w'.repeat(230*1024)};
  assert.equal(boundedBatch([config],undefined,files.preserve)[0],config);
  assert.equal(store.get('SELECT count(*) n FROM tool_result_files').n,0);
  const listing={projects:['a','b']},large={items:'中😀"'.repeat(100000),last:'ERROR_AT_END'};
  const result=boundedBatch([listing,...Array.from({length:100},()=>large)],undefined,files.preserve);
  assert.equal(result[0],listing);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=batchBytes+102,'all previews share the total budget');
  for(const value of result.slice(1)){assert.ok(value.file);assert.match(value.notice,/read_tool_result/);assert.match(value.tail,/ERROR_AT_END/);}
  const quoted=boundedResult(large,20000,files.preserve);assert.ok(Buffer.byteLength(JSON.stringify(quoted))<=20000);
});

test('the transcript folds the oldest tool results first and stops only when nothing is left to fold', t => {
  const store=new Store(':memory:',Buffer.alloc(32,1));t.after(()=>store.close());
  const files=new ResultSession(store,store.trajectories.scopeOf({id:'turn',conversation_id:'chat'}),()=> 'computer',()=>{});
  const big = 'x'.repeat(100 * 1024);
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', content: null, tool_calls: [call('c' + i)] }, { role: 'tool', tool_call_id: 'c' + i, content: big });
  const transcript = new ToolTranscript(messages, chatContextBytes, files.preserve), body = { messages, tools: [] };
  transcript.fit(body);
  assert.ok(requestBytes(body) <= chatContextBytes);
  const tools = messages.filter(m => m.role === 'tool');
  assert.deepEqual(tools.map(m => JSON.parse(m.content.startsWith('{')?m.content:'{}').elided===true), [true, true, true, false, false, false], 'the newest results stay');
  assert.equal(JSON.parse(tools[0].content).result_characters, big.length);
  // A latest batch the model has not seen yet is kept over the fold size; it goes only past the gateway limit.
  const batch = [{ role: 'user', content: 'u' }, { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'a'.repeat(300 * 1024) }, { role: 'tool', tool_call_id: 'b', content: 'b'.repeat(300 * 1024) }];
  new ToolTranscript(batch, chatContextBytes, files.preserve).fit({ messages: batch });
  assert.ok(batch.slice(2).every(m => !JSON.parse(m.content.startsWith('{')?m.content:'{}').elided===true));
  batch.push({ role: 'tool', tool_call_id: 'c', content: 'c'.repeat(1700 * 1024) });
  new ToolTranscript(batch, chatContextBytes, files.preserve).fit({ messages: batch });
  assert.deepEqual(batch.slice(2).map(m => JSON.parse(m.content.startsWith('{')?m.content:'{}').elided===true), [true, false, false]);
  // Only tool results fold: a request over the gateway limit without any left stops the run with a clear code.
  const huge = [{ role: 'user', content: 'y'.repeat(requestLimit) }];
  assert.throws(() => new ToolTranscript(huge, chatContextBytes).fit({ messages: huge }), error => error.code === 'agent_context_too_large');
});

test('inline image data URLs are decoupled from text context folding and admit budgets', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 1)); t.after(() => store.close());
  const files = new ResultSession(store, store.trajectories.scopeOf({ id: 'turn', conversation_id: 'chat' }), () => 'computer', () => {});
  const largeBase64 = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'inspect this image' },
    { role: 'assistant', content: null, tool_calls: [call('c0', 'read_message_text')] },
    { role: 'tool', tool_call_id: 'c0', content: JSON.stringify({ text: 'important historical text '.repeat(2000) }) },
    { role: 'user', content: [{ type: 'text', text: 'Untrusted image' }, { type: 'image_url', image_url: { url: largeBase64 } }] },
  ];
  const body = { messages, tools: [] };
  assert.equal(hasImageContent(body), true);
  assert.ok(requestBytes(body) > requestLimit, 'total payload exceeds 2 MiB text ceiling');
  assert.ok(requestBytes(body) < imageRequestLimit, 'total payload stays within image ceiling');
  assert.ok(textRequestBytes(body) < chatContextBytes, 'text-only size stays below fold threshold');

  const transcript = new ToolTranscript(messages, chatContextBytes, files.preserve);
  transcript.fit(body);
  const historyTool = messages.find(m => m.role === 'tool');
  assert.equal(JSON.parse(historyTool.content).elided, undefined, 'inline image bytes must not trigger text folding');

  // Admitting a normal tool result also ignores inline image bytes.
  const admitted = JSON.parse(transcript.admit('github_read', { ok: true, data: 'hello' }, []));
  assert.equal(admitted.ok, true);
  assert.equal(admitted.truncated, undefined);

  // Text-only overflow still folds and enforces the 2 MiB text ceiling even when an image is present.
  const textHuge = [...messages, { role: 'user', content: 'z'.repeat(requestLimit) }];
  assert.throws(() => new ToolTranscript(textHuge, chatContextBytes, files.preserve).fit({ messages: textHuge, tools: [] }),
    error => error.code === 'agent_context_too_large');
});

test('only gateway faults read as an unavailable model; unusable output, oversized context and a console stop say what happened', () => {
  for (const code of ['model_unavailable', 'model_http_503', 'model_authentication_failed', 'model_not_available']) {
    assert.match(managementFailure(code), /模型配置或服务暂不可用/, code);
    assert.match(serviceFailure(code, '仓库问答助手'), /模型服务暂不可用/, code);
  }
  for (const code of ['management_model_invalid', 'service_model_invalid', 'model_response_invalid']) {
    assert.doesNotMatch(managementFailure(code), /暂不可用/, code); assert.match(managementFailure(code), /无法处理的结果/, code);
    assert.doesNotMatch(serviceFailure(code, '仓库问答助手'), /暂不可用/, code); assert.match(serviceFailure(code, '仓库问答助手'), /无法处理的结果/, code);
  }
  for (const code of ['agent_context_too_large', 'model_request_invalid']) {
    assert.match(managementFailure(code), /上下文超过模型请求上限/, code); assert.match(serviceFailure(code, '仓库问答助手'), /上下文超过/, code);
  }
  // Assistant turns have no step limit (#435); a group answer stopped in the console says so instead of a generic failure.
  assert.match(serviceFailure('conversation_stopped', '仓库问答助手'), /控制台停止.*进展消息保留/);
  for (const code of ['service_role_unavailable', 'service_role_not_bindable']) {
    const msg = serviceFailure(code, '仓库问答助手');
    assert.match(msg, /个人设置 → 飞书绑定.*配置仓库与权限/, code);
    assert.doesNotMatch(msg, /群助手设置/, code);
  }
});
