import { stop } from './common.js';

export const modelIdleMs = 90000;
const responseLimit = 2 * 1024 * 1024;

/** What one streamed chunk added: text, reasoning, or part of a tool call. */
export interface ModelDelta { content?: string; reasoning?: string; tool?: { index: number; name: string; arguments: string } }
// Keep provider output in the control plane until usage accounting and response redaction finish. onToken receives each
// chunk's additions, for callers that show the answer while it is written.
export async function readModelResponse(response: Response, onToken: (delta: ModelDelta) => Promise<void>, onFinish?: (reason: string) => Promise<void>): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return stop('model_response_invalid', undefined, '模型响应没有正文。');
  const streaming = response.headers.get('content-type')?.includes('text/event-stream');
  const decoder = new TextDecoder();
  let bytes = 0, payloadBytes = 0, pending = '', data: string[] = [], done = false, sawChoice = false, finished = false;
  const value: any = { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: null }] };
  const payload=(text:string)=>{payloadBytes+=Buffer.byteLength(text);if(payloadBytes>responseLimit)stop('model_response_too_large',undefined,'模型响应内容超过 2 MiB 上限。');};
  const choice = value.choices[0], message = choice.message, calls = new Map<number, any>();
  const invalid = (): never => stop('model_response_invalid', undefined, '模型流式响应格式无效或在完成前中断。');
  const event = async () => {
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') { done = true; return; }
    let chunk: any; try { chunk = JSON.parse(raw); } catch { return invalid(); }
    if (!chunk || chunk.error || !Array.isArray(chunk.choices)) return invalid();
    for (const key of ['id', 'created', 'model']) if (chunk[key] !== undefined) value[key] = chunk[key];
    if (chunk.usage != null) value.usage = chunk.usage;
    let token = false; const added: ModelDelta = {};
    for (const part of chunk.choices) {
      if (!part || typeof part !== 'object') return invalid();
      if (part.index !== 0) continue;
      sawChoice = true;
      const delta = part.delta;
      if (!delta || typeof delta !== 'object') return invalid();
      for (const key of ['content', 'reasoning_content', 'reasoning', 'reasoning_text']) {
        if (delta[key] == null) continue;
        if (typeof delta[key] !== 'string') return invalid();
        payload(delta[key]);message[key] = (message[key] || '') + delta[key];
        if (delta[key].length) { token = true; if (key === 'content') added.content = (added.content || '') + delta[key]; else added.reasoning = (added.reasoning || '') + delta[key]; }
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) return invalid();
        for (const part of delta.tool_calls) {
          if (!part || typeof part !== 'object') return invalid();
          if (!Number.isSafeInteger(part.index) || part.index < 0) return invalid();
          let call = calls.get(part.index);
          if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(part.index, call); }
          if (typeof part.id === 'string') {payload(part.id);call.id += part.id;}
          if (typeof part.function?.name === 'string') {payload(part.function.name);call.function.name += part.function.name;}
          if (part.function?.arguments !== undefined) {
            if (typeof part.function.arguments !== 'string') return invalid();
            payload(part.function.arguments);call.function.arguments += part.function.arguments;
            if (part.function.arguments.length) token = true;
          }
          if (typeof part.function?.name === 'string' || part.function?.arguments) {
            added.tool = { index: part.index, name: call.function.name, arguments: typeof part.function?.arguments === 'string' ? part.function.arguments : '' };
          }
        }
      }
      if (part.finish_reason != null) {
        choice.finish_reason = part.finish_reason; finished = true;
        // Model completion precedes usage trailers and platform bookkeeping; it is not token activity.
        await onFinish?.(String(part.finish_reason));
      }
    }
    // Role-only chunks, usage, SSE comments and blank lines never extend the token deadline.
    if (token) await onToken(added);
  };
  const line = async (text: string) => {
    if (!text) await event();
    else if (text === 'data' || text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
  };
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > responseLimit * (streaming ? 16 : 1)) stop('model_response_too_large', undefined, '模型响应超过 2 MiB 上限。');
      pending += decoder.decode(next.value, { stream: true });
      if (!streaming) continue; // Some compatible providers still return a complete JSON response.
      let end: number;
      while (!done && (end = pending.search(/[\r\n]/)) >= 0) {
        // A CRLF delimiter may be split across network reads.
        if (pending[end] === '\r' && end === pending.length - 1) break;
        const text = pending.slice(0, end), width = pending.slice(end, end + 2) === '\r\n' ? 2 : 1;
        pending = pending.slice(end + width); await line(text);
      }
    }
    pending += decoder.decode();
    if (!streaming) {
      let parsed: any;
      try { parsed = JSON.parse(pending); } catch { return invalid(); }
      if (!parsed?.choices?.[0]?.message) return invalid();
      await onFinish?.(parsed.choices[0].message.tool_calls?.length ? 'tool_calls' : String(parsed.choices[0].finish_reason ?? 'stop'));
      return parsed;
    }
    if (!done) {
      for (const text of pending.split(/\r\n|[\r\n]/)) { await line(text); if (done) break; }
      if (!done) await event();
    }
    if (!sawChoice || !(done || finished)) return invalid();
    if (calls.size) message.tool_calls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
    return value;
  } finally { await reader.cancel().catch(() => {}); }
}
