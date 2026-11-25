import test from 'node:test';
import assert from 'node:assert/strict';
import {
  endpointToFormat,
  formatToEndpoint,
  patchPassthroughRequest,
  PassthroughTap,
} from '../../../../dist/harness/model-formats.js';
import {
  startModelBridge,
  resolveModelBridgeTarget,
  DEFAULT_MODEL_GATEWAY_SOCKET,
} from '../../../../runner/model-relay.mjs';

test('passthrough gateway maps endpoints strictly 1:1 with model protocols (no cross-protocol conversion)', () => {
  assert.equal(endpointToFormat('chat_completions'), 'openai-chat-completions');
  assert.equal(endpointToFormat('responses'), 'openai-responses');
  assert.equal(endpointToFormat('messages'), 'anthropic-messages');
  assert.equal(formatToEndpoint('openai-chat-completions'), 'chat_completions');
  assert.equal(formatToEndpoint('openai-responses'), 'responses');
  assert.equal(formatToEndpoint('anthropic-messages'), 'messages');
});

test('patchPassthroughRequest rewrites only model, output ceiling, streaming usage and trusted allowedTools', () => {
  const chat = patchPassthroughRequest('openai-chat-completions', {
    model: 'client-alias',
    stream: true,
    max_tokens: 64000,
    max_completion_tokens: 64000,
    temperature: 0.2,
    extra_vendor_flag: { nested: true },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'allowed_tool' } },
      { type: 'function', function: { name: 'denied_tool' } },
    ],
    tool_choice: { type: 'function', function: { name: 'denied_tool' } },
  }, 'real-model', 8192, { allowedTools: new Set(['allowed_tool']) });
  assert.equal(chat.model, 'real-model');
  assert.equal(chat.max_completion_tokens, 8192);
  assert.equal('max_tokens' in chat, false);
  assert.deepEqual(chat.stream_options, { include_usage: true });
  assert.deepEqual(chat.extra_vendor_flag, { nested: true });
  assert.deepEqual(chat.tools, [{ type: 'function', function: { name: 'allowed_tool' } }]);
  assert.equal('tool_choice' in chat, false);

  const emptyTools = patchPassthroughRequest('openai-chat-completions', {
    model: 'alias',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'denied_tool' } }],
    tool_choice: 'required',
  }, 'real-model', 8192, { allowedTools: new Set(['allowed_tool']) });
  assert.equal('tools' in emptyTools, false);
  assert.equal('tool_choice' in emptyTools, false);

  const anthropic = patchPassthroughRequest('anthropic-messages', {
    model: 'alias',
    max_tokens: 99999,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'user', content: 'hi' }],
  }, 'claude-real', 4096);
  assert.equal(anthropic.model, 'claude-real');
  assert.equal(anthropic.max_tokens, 4096);
  assert.deepEqual(anthropic.thinking, { type: 'enabled', budget_tokens: 2048 });
});

test('PassthroughTap tolerates unknown provider events and extracts usage and text deltas', () => {
  const deltas = [];
  const tap = new PassthroughTap('openai-chat-completions', true, 'gpt-real', d => deltas.push(d));
  tap.push(Buffer.from('data: {"vendor_custom":true,"nested":[1,2,3]}\n\n'));
  tap.push(Buffer.from('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n'));
  tap.push(Buffer.from('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}}\n\ndata: [DONE]\n\n'));
  const summary = tap.end();
  assert.deepEqual(deltas, ['hel', 'lo']);
  assert.equal(summary.content, 'hello');
  assert.deepEqual(summary.usage, { input_tokens: 12, output_tokens: 4, cached_input_tokens: 3 });
});

test('runner model bridge pins container mode to fixed UDS socket and rejects non-loopback local targets', async t => {
  assert.equal(DEFAULT_MODEL_GATEWAY_SOCKET, '/run/model-gateway/gateway.sock');
  // Container mode strictly ignores arbitrary targetUrl/socketPath and pins to /run/model-gateway/gateway.sock.
  assert.deepEqual(
    resolveModelBridgeTarget({ targetUrl: 'http://127.0.0.1:9999', socketPath: '/tmp/evil.sock' }, false),
    { kind: 'uds', path: DEFAULT_MODEL_GATEWAY_SOCKET },
  );
  // Local mode rejects non-loopback URLs and accepts loopback TCP or absolute UDS paths.
  assert.throws(() => resolveModelBridgeTarget({ targetUrl: 'http://example.com:8791' }, true), /model_gateway_url_invalid/);
  assert.throws(() => resolveModelBridgeTarget({ targetUrl: 'https://127.0.0.1:8791' }, true), /model_gateway_url_invalid/);
  assert.deepEqual(
    resolveModelBridgeTarget({ targetUrl: 'http://127.0.0.1:18791' }, true),
    { kind: 'tcp', host: '127.0.0.1', port: 18791 },
  );
  assert.deepEqual(
    resolveModelBridgeTarget({ socketPath: '/tmp/test.sock' }, true),
    { kind: 'uds', path: '/tmp/test.sock' },
  );
  const bridge = await startModelBridge({ targetUrl: 'http://127.0.0.1:9', socketPath: '/tmp/ignored.sock' });
  t.after(() => bridge.close());
  assert.deepEqual(bridge.target, { kind: 'uds', path: DEFAULT_MODEL_GATEWAY_SOCKET });
});
