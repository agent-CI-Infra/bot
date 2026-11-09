import { TextDecoder } from 'node:util';
import { TaskError } from '../agent/common.js';

/** Wire contract checked against the pinned native CLI, not the rolling documentation. */
export const claudeCodeRuntime = { package: '@anthropic-ai/claude-code', version: '2.1.319', protocol: 'claude-code/2.1.319/stream-json' } as const;
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const incompatible = (): never => { throw new TaskError('claude_protocol_incompatible', 'waiting_configuration'); };
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const count = (v: any) => Number.isSafeInteger(v) && v >= 0;
export interface ClaudeUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
export function wireUsage(v: any): ClaudeUsage | null {
  if (v === undefined || v === null) return null;
  if (!object(v) || !count(v.input_tokens) || !count(v.output_tokens)) return incompatible();
  for (const k of ['cache_read_input_tokens', 'cache_creation_input_tokens']) if (v[k] !== undefined && !count(v[k])) return incompatible();
  return { input_tokens: v.input_tokens, output_tokens: v.output_tokens, cache_read_input_tokens: v.cache_read_input_tokens, cache_creation_input_tokens: v.cache_creation_input_tokens };
}
function fault(value: any) {
  const declared: Record<string,string> = { authentication_failed: 'authentication', billing_error: 'authentication', rate_limit: 'rate_limit', invalid_request: 'model', server_error: 'transport', api_error: 'transport' };
  if (value.error && value.error !== 'api_error' && declared[value.error]) return declared[value.error];
  const description = [value.error, ...(Array.isArray(value.errors) ? value.errors : []), ...(value.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text)].filter(v => typeof v === 'string').join(' ');
  if (/authentication|unauthorized|invalid.api.key|\b40[13]\b/i.test(description)) return 'authentication';
  if (/rate.limit|\b429\b/i.test(description)) return 'rate_limit';
  if (/model.*(?:not.found|unavailable|not.supported)|\b404\b/i.test(description)) return 'model';
  if (/api.error|server.error|overloaded|connection|network|\b5\d\d\b/i.test(description)) return 'transport';
  return 'execution';
}
/** Pick only public fields; thinking, signatures, debug data and unknown vendor extensions never enter trace. */
export function claudeMessage(v: any): any {
  if (!object(v) || typeof v.type !== 'string') return incompatible();
  if (['system', 'assistant', 'user', 'result'].includes(v.type) && (typeof v.session_id !== 'string' || !uuidPattern.test(v.session_id))) return incompatible();
  if (v.type === 'system') {
    if (typeof v.subtype !== 'string') return incompatible();
    if (v.subtype === 'api_retry') return { type: 'api_retry', error: fault(v), attempt: count(v.attempt) ? v.attempt : null };
    if (v.subtype !== 'init') return { type: 'ignored' };
    if (typeof v.model !== 'string' || !Array.isArray(v.tools) || v.tools.some((t: any) => typeof t !== 'string')) return incompatible();
    return { type: 'init', session_id: v.session_id, model: v.model, tools: v.tools, mcp_servers: v.mcp_servers };
  }
  if (v.type === 'assistant' || v.type === 'user') {
    if (!object(v.message) || !Array.isArray(v.message.content)) return incompatible();
    const content = v.message.content.flatMap((c: any) => {
      if (!object(c)) return incompatible();
      if (c.type === 'text' && typeof c.text === 'string') return [{ type: 'text', text: c.text }];
      if (c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string' && object(c.input)) return [{ type: 'tool_use', id: c.id, name: c.name }];
      // Raw observations already live at the broker, with original request, exit status and candidate version.
      if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') return [{ type: 'tool_result', id: c.tool_use_id, is_error: c.is_error === true }];
      if (['thinking', 'redacted_thinking'].includes(c.type)) return [];
      return incompatible();
    });
    return { type: v.type, session_id: v.session_id, id: v.message.id, content, usage: v.type === 'assistant' ? wireUsage(v.message.usage) : null, error: v.error ? fault(v) : null };
  }
  if (v.type === 'result') {
    if (!['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'].includes(v.subtype) || typeof v.is_error !== 'boolean' || !count(v.num_turns)) return incompatible();
    return { type: 'result', session_id: v.session_id, subtype: v.subtype, is_error: v.is_error, num_turns: v.num_turns, usage: wireUsage(v.usage), fault: v.is_error ? fault(v) : null };
  }
  if (v.type === 'control_request') {
    if (typeof v.request_id !== 'string' || !object(v.request)) return incompatible();
    return { type: v.type, request_id: v.request_id, subtype: v.request.subtype };
  }
  if (v.type === 'control_response' || v.type === 'rate_limit_event') return { type: 'ignored' };
  // Partial messages are deliberately not requested. A changed wire protocol fails closed.
  return incompatible();
}

/** Fatal UTF-8, bounded lines and total stream; Buffer splits may fall inside a multibyte code point. */
export class ClaudeJsonStream {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = ''; private bytes = 0;
  constructor(private readonly accept: (v: any, cursor: number) => void, private readonly maxLine = 2 * 1024 * 1024, private readonly maxStream = 32 * 1024 * 1024) {}
  cursor = 0;
  push(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxStream) throw new TaskError('claude_output_limit', 'retry_wait');
    try { this.pending += this.decoder.decode(chunk, { stream: true }); } catch { return incompatible(); }
    this.drain(false);
  }
  end() { try { this.pending += this.decoder.decode(); } catch { return incompatible(); } this.drain(true); }
  private drain(final: boolean) {
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) { const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1); this.line(line); }
    if (Buffer.byteLength(this.pending) > this.maxLine) throw new TaskError('claude_output_limit', 'retry_wait');
    if (final && this.pending.trim()) throw new TaskError('claude_stream_truncated', 'retry_wait');
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLine) throw new TaskError('claude_output_limit', 'retry_wait');
    if (!line.trim()) return;
    let value: any; try { value = JSON.parse(line); } catch { return incompatible(); }
    this.accept(claudeMessage(value), ++this.cursor);
  }
}
export const claudeUserMessage = (prompt: string, sessionId: string) => ({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
