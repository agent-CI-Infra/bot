import test from 'node:test';
import assert from 'node:assert/strict';
import { batchBytes, boundedBatch, boundedResult, chatContextBytes, requestBytes, requestLimit, toolArguments, toolCallsProblem, ToolTranscript } from '../dist/agent/tool-context.js';
import { managementFailure, serviceFailure } from '../dist/management/presentation.js';

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

test('a batch of results shares one budget: small results stay whole and large ones split the rest', () => {
  const size = value => Buffer.byteLength(JSON.stringify(value));
  // A single large result without paging (a project's effective configuration is about 240 KB) fits whole.
  const config = { revision: 'r1', workflows: 'w'.repeat(230 * 1024) };
  assert.equal(boundedBatch([config])[0], config);
  // Eleven calls: the small listing stays whole, ten large results share what is left equally.
  const listing = { projects: Array.from({ length: 10 }, (_, n) => ({ repository: 'org/repo-' + n })) };
  const large = Array.from({ length: 10 }, (_, n) => ({ repository: 'org/repo-' + n, next_offset: 60, items: Array.from({ length: 60 }, () => ({ title: '失败的检查'.repeat(60) })) }));
  const [kept, ...cut] = boundedBatch([listing, ...large]);
  assert.equal(kept, listing);
  const total = size(listing) + cut.reduce((sum, result) => sum + size(result), 0);
  assert.ok(total <= batchBytes + 11 * 512, 'the batch stays within its budget');
  for (const result of cut) {
    assert.equal(result.truncated, true); assert.match(result.notice, /Narrow it/);
    assert.ok(size(result) >= (batchBytes - size(listing)) / 10 - 512, 'every large result gets an equal share');
    // Small top-level fields survive the cut: the next step usually needs them.
    assert.equal(result.fields.next_offset, 60); assert.match(result.fields.repository, /^org\/repo-/);
  }
  // Very many calls still give every result a useful minimum.
  assert.ok(boundedBatch(Array.from({ length: 100 }, () => large[0])).every(result => size(result) >= 8 * 1024 - 512));
  // Quote-heavy JSON grows when it becomes a string inside the tool message; the cut accounts for it.
  const quoted = boundedResult({ items: Array.from({ length: 4000 }, () => ({ a: '"', b: '' })) }, 20000);
  assert.ok(Buffer.byteLength(JSON.stringify(quoted.content)) <= 20000);
});

test('the transcript folds the oldest tool results first and stops only when nothing is left to fold', () => {
  const big = 'x'.repeat(100 * 1024);
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', content: null, tool_calls: [call('c' + i)] }, { role: 'tool', tool_call_id: 'c' + i, content: big });
  const transcript = new ToolTranscript(messages, chatContextBytes), body = { messages, tools: [] };
  transcript.fit(body);
  assert.ok(requestBytes(body) <= chatContextBytes);
  const tools = messages.filter(m => m.role === 'tool');
  assert.deepEqual(tools.map(m => m.content.startsWith('{"elided":true')), [true, true, true, false, false, false], 'the newest results stay');
  assert.equal(JSON.parse(tools[0].content).result_characters, big.length);
  // A latest batch the model has not seen yet is kept over the fold size; it goes only past the gateway limit.
  const batch = [{ role: 'user', content: 'u' }, { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'a'.repeat(300 * 1024) }, { role: 'tool', tool_call_id: 'b', content: 'b'.repeat(300 * 1024) }];
  new ToolTranscript(batch, chatContextBytes).fit({ messages: batch });
  assert.ok(batch.slice(2).every(m => !m.content.startsWith('{"elided"')));
  batch.push({ role: 'tool', tool_call_id: 'c', content: 'c'.repeat(1700 * 1024) });
  new ToolTranscript(batch, chatContextBytes).fit({ messages: batch });
  assert.deepEqual(batch.slice(2).map(m => m.content.startsWith('{"elided"')), [true, false, false]);
  // Only tool results fold: a request over the gateway limit without any left stops the run with a clear code.
  const huge = [{ role: 'user', content: 'y'.repeat(requestLimit) }];
  assert.throws(() => new ToolTranscript(huge, chatContextBytes).fit({ messages: huge }), error => error.code === 'agent_context_too_large');
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
