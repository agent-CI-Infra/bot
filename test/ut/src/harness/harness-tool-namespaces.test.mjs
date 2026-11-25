import test from 'node:test';
import assert from 'node:assert/strict';
import { patchPassthroughRequest, PassthroughTap } from '../../../../dist/harness/model-formats.js';

test('Responses passthrough preserves namespace tools and function_call history verbatim without conversion', () => {
  const inputBody = {
    model: 'client-model',
    stream: true,
    max_output_tokens: 32000,
    input: [
      { type: 'function_call', namespace: 'mcp__bot', name: 'read_task_record', call_id: 'c1', arguments: '{"ref":"task:t"}' },
      { type: 'function_call_output', call_id: 'c1', output: '{}' },
    ],
    tools: [
      {
        type: 'namespace',
        name: 'mcp__bot',
        description: 'Bot collaboration',
        tools: [{ type: 'function', name: 'read_task_record', parameters: { type: 'object', properties: { ref: { type: 'string' } } } }],
      },
    ],
  };
  const patched = patchPassthroughRequest('openai-responses', inputBody, 'gpt-5-codex', 8192);
  assert.equal(patched.model, 'gpt-5-codex');
  assert.equal(patched.max_output_tokens, 8192);
  assert.deepEqual(patched.tools, inputBody.tools);
  assert.deepEqual(patched.input, inputBody.input);

  // Sideband tap extracts namespaced tool call and usage from Responses SSE without mutating the wire stream.
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'r1', model: 'gpt-5-codex', status: 'in_progress' } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', namespace: 'mcp__bot', name: 'read_task_record', call_id: 'c2', arguments: '{"ref":"task:t"}' } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', model: 'gpt-5-codex', status: 'completed', output: [{ type: 'function_call', namespace: 'mcp__bot', name: 'read_task_record', call_id: 'c2', arguments: '{"ref":"task:t"}' }], usage: { input_tokens: 20, output_tokens: 8 } } })}\n\n`,
  ].join('');
  const tap = new PassthroughTap('openai-responses', true, 'gpt-5-codex');
  tap.push(Buffer.from(sse, 'utf8'));
  const summary = tap.end();
  assert.equal(summary.id, 'r1');
  assert.deepEqual(summary.usage, { input_tokens: 20, output_tokens: 8, cached_input_tokens: null });
  assert.deepEqual(summary.tool_calls, [{ id: 'c2', name: 'read_task_record', arguments: '{"ref":"task:t"}' }]);
});
