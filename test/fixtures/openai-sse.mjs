/**
 * Respond to a mock OpenAI Chat Completions HTTP request with SSE (`text/event-stream`) when
 * `stream` is true (as the real Pi / OpenAI SDK sends over the unified passthrough gateway),
 * or plain JSON otherwise.
 */
export function replyChatCompletion(res, message, { stream = true, usage = { prompt_tokens: 10, completion_tokens: 5 }, model = 'fixture' } = {}) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { role: message?.role || 'assistant' };
  if (message?.content != null) delta.content = message.content;
  if (message?.reasoning_content != null) delta.reasoning_content = message.reasoning_content;
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    delta.tool_calls = message.tool_calls.map((tc, index) => ({
      index,
      id: tc.id,
      type: tc.type || 'function',
      function: { name: tc.function?.name || '', arguments: tc.function?.arguments ?? '' },
    }));
  }
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  const finishReason = Array.isArray(message?.tool_calls) && message.tool_calls.length ? 'tool_calls' : 'stop';
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}
