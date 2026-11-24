import test from 'node:test';
import assert from 'node:assert/strict';
import { hasImageContent, imageRequestLimit, requestBytes, requestLimit, textRequestBytes, toolArguments, toolCallsProblem } from '../../../../dist/agent/tool-context.js';
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

test('inline image data URLs do not count toward the text request limit', () => {
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
  assert.ok(textRequestBytes(body) < requestLimit, 'inline image bytes do not count toward the 2 MiB text limit');
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
  for (const code of ['service_role_unavailable', 'service_role_not_bindable', 'channel_service_model_not_configured']) {
    const msg = serviceFailure(code, '群聊助手');
    assert.match(msg, /个人设置 → 飞书绑定.*配置群聊助手/, code);
    assert.doesNotMatch(msg, /群助手设置/, code);
  }
});
