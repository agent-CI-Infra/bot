import { randomUUID } from 'node:crypto';
import type { ModelInterfaceType } from '../models/catalog.js';

export type DownstreamEndpoint = 'messages' | 'responses' | 'chat_completions';

export interface CanonicalUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
}

export interface PassthroughToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface PassthroughResponseSummary {
  id: string;
  model: string;
  content: string;
  thinking: string;
  tool_calls: PassthroughToolCall[];
  stop_reason: string | null;
  usage: CanonicalUsage;
}

const nonNegInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function endpointToFormat(endpoint: DownstreamEndpoint): ModelInterfaceType {
  if (endpoint === 'messages') return 'anthropic-messages';
  if (endpoint === 'responses') return 'openai-responses';
  return 'openai-chat-completions';
}

export function formatToEndpoint(format: ModelInterfaceType): DownstreamEndpoint {
  if (format === 'anthropic-messages') return 'messages';
  if (format === 'openai-responses') return 'responses';
  return 'chat_completions';
}

export function accountingUsagePayload(usage: CanonicalUsage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(usage.cached_input_tokens !== null
      ? { input_tokens_details: { cached_tokens: usage.cached_input_tokens } }
      : {}),
  };
}

export function formatErrorPayload(
  endpoint: DownstreamEndpoint | 'models',
  code: string,
  message = code,
): string {
  if (endpoint === 'messages') {
    return JSON.stringify({ type: 'error', error: { type: code, message } });
  }
  return JSON.stringify({ error: { message, type: code, code } });
}

export function formatSseErrorEvent(
  endpoint: DownstreamEndpoint,
  code: string,
  message = code,
): string {
  if (endpoint === 'messages') {
    return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: code, message } })}\n\n`;
  }
  if (endpoint === 'responses') {
    return `event: error\ndata: ${JSON.stringify({ type: 'error', code, message, param: null })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { message, type: code, code } })}\n\n`;
}

function toolDefinitionName(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return '';
  const entry = tool as Record<string, any>;
  if (typeof entry.name === 'string') return entry.name;
  if (entry.function && typeof entry.function.name === 'string') return entry.function.name;
  return '';
}

function filterAllowedTools(
  body: Record<string, any>,
  allowedTools: ReadonlySet<string>,
): void {
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter(tool => allowedTools.has(toolDefinitionName(tool)));
    if (!body.tools.length) {
      delete body.tools;
      delete body.tool_choice;
    }
  }
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const choiceName = body.tool_choice.name ?? body.tool_choice.function?.name;
    if (typeof choiceName === 'string' && !allowedTools.has(choiceName)) {
      delete body.tool_choice;
    }
  }
}

/**
 * Minimal transparent passthrough patching:
 * - replaces top-level `model` with the control-plane target model name
 * - clamps output token ceiling to the configured budget
 * - enables `stream_options.include_usage` on streaming Chat Completions
 * - optionally filters `tools` / `tool_choice` to a trusted allowlist (e.g. WorkSwarm MCP tools)
 * All other fields, extensions, reasoning parameters, and content blocks pass through verbatim.
 */
export function patchPassthroughRequest(
  format: ModelInterfaceType,
  body: Record<string, any>,
  targetModel: string,
  maxOutputTokens?: number,
  options?: { allowedTools?: ReadonlySet<string> },
): Record<string, any> {
  const patched: Record<string, any> = { ...body, model: targetModel };
  if (options?.allowedTools) filterAllowedTools(patched, options.allowedTools);
  if (format === 'openai-chat-completions') {
    if (patched.stream === true) {
      patched.stream_options = {
        ...(patched.stream_options && typeof patched.stream_options === 'object' ? patched.stream_options : {}),
        include_usage: true,
      };
    }
    if (maxOutputTokens !== undefined) {
      const key = 'max_tokens' in patched && !('max_completion_tokens' in patched)
        ? 'max_tokens'
        : 'max_completion_tokens';
      if (key === 'max_completion_tokens') delete patched.max_tokens;
      const current = nonNegInt(patched[key]);
      if (!current || current > maxOutputTokens) patched[key] = maxOutputTokens;
    }
  } else if (format === 'anthropic-messages' && maxOutputTokens !== undefined) {
    const current = nonNegInt(patched.max_tokens);
    if (!current || current > maxOutputTokens) patched.max_tokens = maxOutputTokens;
  } else if (format === 'openai-responses' && maxOutputTokens !== undefined) {
    const current = nonNegInt(patched.max_output_tokens);
    if (current && current > maxOutputTokens) patched.max_output_tokens = maxOutputTokens;
  }
  return patched;
}

function extractAnthropicUsage(u: any, prev: CanonicalUsage): CanonicalUsage {
  if (!u || typeof u !== 'object') return prev;
  const baseIn = nonNegInt(u.input_tokens);
  const cacheRead = nonNegInt(u.cache_read_input_tokens);
  const cacheCreate = nonNegInt(u.cache_creation_input_tokens);
  const out = nonNegInt(u.output_tokens);
  const totalIn = baseIn !== null ? baseIn + (cacheRead ?? 0) + (cacheCreate ?? 0) : prev.input_tokens;
  const cached = cacheRead !== null
    ? cacheRead
    : baseIn !== null && prev.cached_input_tokens === null
      ? 0
      : prev.cached_input_tokens;
  return {
    input_tokens: totalIn !== null ? Math.max(prev.input_tokens ?? 0, totalIn) : prev.input_tokens,
    output_tokens: out !== null ? Math.max(prev.output_tokens ?? 0, out) : prev.output_tokens,
    cached_input_tokens: cached,
  };
}

function extractOpenAiUsage(u: any, prev: CanonicalUsage): CanonicalUsage {
  if (!u || typeof u !== 'object') return prev;
  const inp = nonNegInt(u.prompt_tokens ?? u.input_tokens);
  const out = nonNegInt(u.completion_tokens ?? u.output_tokens);
  const cached = nonNegInt(
    u.prompt_tokens_details?.cached_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.prompt_cache_hit_tokens,
  );
  return {
    input_tokens: inp ?? prev.input_tokens,
    output_tokens: out ?? prev.output_tokens,
    cached_input_tokens: cached !== null ? cached : prev.cached_input_tokens,
  };
}

/**
 * Sideband observer for passthrough model responses (SSE or JSON).
 * Extracts usage accounting, incremental text deltas, tool calls for inspection,
 * and a bounded trajectory snapshot without rewriting or blocking the wire stream.
 * Unknown/new provider event types are ignored safely.
 */
export class PassthroughTap {
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private pending = '';
  private json = '';
  private text = '';
  private thinking = '';
  private stopReason: string | null = null;
  private toolMap = new Map<string | number, PassthroughToolCall>();
  private orderedTools: PassthroughToolCall[] = [];
  private maxCapturedChars = 512 * 1024;
  usage: CanonicalUsage = { input_tokens: null, output_tokens: null, cached_input_tokens: null };
  completed = false;
  responseId = 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
  model: string;

  constructor(
    private readonly format: ModelInterfaceType,
    private readonly sse: boolean,
    fallbackModel: string,
    private readonly onTextDelta?: (delta: string) => void,
  ) {
    this.model = fallbackModel;
  }

  push(chunk: Uint8Array): void {
    const decoded = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (this.json.length < 8 * 1024 * 1024) this.json += decoded;
      return;
    }
    this.pending += decoded;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.consumeSseFrame(frame);
    }
    if (this.pending.length > 4 * 1024 * 1024) {
      // Sideband tap must never fail a healthy passthrough stream on oversized SSE frames.
      this.pending = '';
    }
  }

  end(): PassthroughResponseSummary {
    const tail = this.decoder.decode();
    if (!this.sse) {
      const raw = (this.json + tail).trim();
      if (raw) {
        try {
          this.consumeJsonBody(JSON.parse(raw));
        } catch {
          // Non-JSON or truncated body: leave usage null so accounting records unknown usage.
        }
      }
    } else {
      const rest = (this.pending + tail).trim();
      if (rest) this.consumeSseFrame(rest);
    }
    return this.summary();
  }

  summary(): PassthroughResponseSummary {
    return {
      id: this.responseId,
      model: this.model,
      content: this.text,
      thinking: this.thinking,
      tool_calls: this.orderedTools.map(t => ({ ...t })),
      stop_reason: this.stopReason,
      usage: { ...this.usage },
    };
  }

  /** Normalized assistant message shape for Pi's control-plane denied-tool-call inspection. */
  assistantMessage(): {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  } {
    const toolCalls = this.orderedTools.map(t => ({
      id: t.id,
      type: 'function' as const,
      function: { name: t.name, arguments: t.arguments },
    }));
    return {
      role: 'assistant',
      content: this.text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
  }

  private appendText(delta: string) {
    if (!delta) return;
    if (this.text.length < this.maxCapturedChars) {
      this.text += delta.slice(0, this.maxCapturedChars - this.text.length);
    }
    if (this.sse) this.onTextDelta?.(delta);
  }

  private appendThinking(delta: string) {
    if (!delta) return;
    if (this.thinking.length < this.maxCapturedChars) {
      this.thinking += delta.slice(0, this.maxCapturedChars - this.thinking.length);
    }
  }

  private registerTool(key: string | number, id: string, name: string, args = ''): PassthroughToolCall {
    let call = this.toolMap.get(key);
    if (!call) {
      call = { id: id || 'call_' + this.orderedTools.length, name: name || 'tool', arguments: '' };
      this.toolMap.set(key, call);
      this.orderedTools.push(call);
    } else {
      if (id && !call.id) call.id = id;
      if (name && call.name === 'tool') call.name = name;
    }
    if (args && call.arguments.length < this.maxCapturedChars) {
      call.arguments += args.slice(0, this.maxCapturedChars - call.arguments.length);
    }
    return call;
  }

  private appendToolArgs(key: string | number, delta: string) {
    if (!delta) return;
    const call = this.toolMap.get(key);
    if (call && call.arguments.length < this.maxCapturedChars) {
      call.arguments += delta.slice(0, this.maxCapturedChars - call.arguments.length);
    }
  }

  private consumeSseFrame(frame: string) {
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n').trim();
    if (!data) return;
    if (data === '[DONE]') {
      this.completed = true;
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    if (this.format === 'anthropic-messages') this.consumeAnthropicEvent(eventName || payload.type, payload);
    else if (this.format === 'openai-responses') this.consumeResponsesEvent(eventName || payload.type, payload);
    else this.consumeChatChunk(payload);
  }

  private consumeAnthropicEvent(type: string, payload: any) {
    if (type === 'message_start') {
      const m = payload.message ?? {};
      if (typeof m.id === 'string' && m.id) this.responseId = m.id;
      if (typeof m.model === 'string' && m.model) this.model = m.model;
      if (m.usage) this.usage = extractAnthropicUsage(m.usage, this.usage);
      return;
    }
    if (type === 'content_block_start') {
      const idx = Number(payload.index ?? this.orderedTools.length);
      const block = payload.content_block ?? {};
      if (block.type === 'tool_use') {
        this.registerTool(idx, String(block.id || 'call_' + idx), String(block.name || 'tool'));
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        this.appendText(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        this.appendThinking(block.thinking);
      }
      return;
    }
    if (type === 'content_block_delta') {
      const idx = Number(payload.index ?? 0);
      const d = payload.delta ?? {};
      if (d.type === 'text_delta' && typeof d.text === 'string') this.appendText(d.text);
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') this.appendThinking(d.thinking);
      else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') this.appendToolArgs(idx, d.partial_json);
      return;
    }
    if (type === 'message_delta') {
      if (payload.usage) this.usage = extractAnthropicUsage(payload.usage, this.usage);
      if (typeof payload.delta?.stop_reason === 'string') this.stopReason = payload.delta.stop_reason;
      return;
    }
    if (type === 'message_stop') {
      this.completed = true;
    }
  }

  private consumeResponsesEvent(type: string, payload: any) {
    if (type === 'response.created' || type === 'response.in_progress') {
      const r = payload.response ?? {};
      if (typeof r.id === 'string' && r.id) this.responseId = r.id;
      if (typeof r.model === 'string' && r.model) this.model = r.model;
      return;
    }
    if (type === 'response.output_item.added') {
      const item = payload.item ?? {};
      const outIdx = Number(payload.output_index ?? this.orderedTools.length);
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const key = item.id ?? outIdx;
        this.registerTool(key, String(item.call_id || item.id || 'call_' + outIdx), String(item.name || 'tool'));
      }
      return;
    }
    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      this.appendText(payload.delta);
      return;
    }
    if (type === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string') {
      this.appendThinking(payload.delta);
      return;
    }
    if (
      (type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta') &&
      typeof payload.delta === 'string'
    ) {
      const key = payload.item_id ?? Number(payload.output_index ?? 0);
      this.appendToolArgs(key, payload.delta);
      return;
    }
    if (type === 'response.output_item.done') {
      const item = payload.item ?? {};
      if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.id) {
        const call = this.toolMap.get(item.id);
        if (call && !call.arguments) {
          call.arguments = item.type === 'custom_tool_call'
            ? JSON.stringify({ input: item.input ?? '' })
            : String(item.arguments ?? '');
        }
      }
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.done') {
      this.completed = true;
      const r = payload.response ?? {};
      if (typeof r.id === 'string' && r.id) this.responseId = r.id;
      if (typeof r.model === 'string' && r.model) this.model = r.model;
      if (r.usage) this.usage = extractOpenAiUsage(r.usage, this.usage);
      if (Array.isArray(r.output) && !this.text && !this.orderedTools.length) {
        this.consumeResponsesOutputItems(r.output);
      }
      this.stopReason = type === 'response.incomplete' || r.status === 'incomplete'
        ? 'max_tokens'
        : this.orderedTools.length
          ? 'tool_use'
          : 'completed';
    }
  }

  private consumeResponsesOutputItems(output: any[]) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        const text = item.summary.map((s: any) => (typeof s?.text === 'string' ? s.text : '')).filter(Boolean).join('\n');
        if (text) this.appendThinking(text);
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        const text = item.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
        if (text) this.appendText(text);
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const idx = this.orderedTools.length;
        const args = item.type === 'custom_tool_call'
          ? JSON.stringify({ input: item.input ?? '' })
          : String(item.arguments ?? '{}');
        this.registerTool(item.id ?? idx, String(item.call_id || item.id || 'call_' + idx), String(item.name || 'tool'), args);
      }
    }
  }

  private consumeChatChunk(payload: any) {
    if (typeof payload.id === 'string' && payload.id) this.responseId = payload.id;
    if (typeof payload.model === 'string' && payload.model) this.model = payload.model;
    if (payload.usage) this.usage = extractOpenAiUsage(payload.usage, this.usage);
    const choice = payload.choices?.[0];
    if (!choice || typeof choice !== 'object') return;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      this.appendThinking(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      this.appendText(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        const key = Number(tc.index ?? 0);
        const call = this.registerTool(
          key,
          typeof tc.id === 'string' && tc.id ? tc.id : '',
          typeof tc.function?.name === 'string' ? tc.function.name : '',
        );
        if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
          this.appendToolArgs(key, tc.function.arguments);
        } else if (!call.id) {
          call.id = 'call_' + key;
        }
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      this.stopReason = choice.finish_reason;
    }
  }

  private consumeJsonBody(body: any) {
    if (!body || typeof body !== 'object') return;
    if (typeof body.id === 'string' && body.id) this.responseId = body.id;
    if (typeof body.model === 'string' && body.model) this.model = body.model;
    if (this.format === 'anthropic-messages') {
      if (body.usage) this.usage = extractAnthropicUsage(body.usage, this.usage);
      for (const block of Array.isArray(body.content) ? body.content : []) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string') this.appendThinking(block.thinking);
        else if (block?.type === 'text' && typeof block.text === 'string') this.appendText(block.text);
        else if (block?.type === 'tool_use') {
          const idx = this.orderedTools.length;
          this.registerTool(
            idx,
            String(block.id || 'call_' + idx),
            String(block.name || 'tool'),
            JSON.stringify(block.input ?? {}),
          );
        }
      }
      if (typeof body.stop_reason === 'string') this.stopReason = body.stop_reason;
      return;
    }
    if (this.format === 'openai-responses') {
      if (body.usage) this.usage = extractOpenAiUsage(body.usage, this.usage);
      if (Array.isArray(body.output)) this.consumeResponsesOutputItems(body.output);
      else if (typeof body.output_text === 'string' && body.output_text) this.appendText(body.output_text);
      this.stopReason = body.status === 'incomplete' ? 'max_tokens' : this.orderedTools.length ? 'tool_use' : 'completed';
      return;
    }
    if (body.usage) this.usage = extractOpenAiUsage(body.usage, this.usage);
    const choice = body.choices?.[0];
    const msg = choice?.message ?? {};
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) this.appendThinking(msg.reasoning_content);
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : '';
    if (text) this.appendText(text);
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const idx = this.orderedTools.length;
        const args = typeof tc?.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc?.function?.arguments ?? {});
        this.registerTool(idx, String(tc?.id || 'call_' + idx), String(tc?.function?.name || 'tool'), args);
      }
    }
    if (typeof choice?.finish_reason === 'string') this.stopReason = choice.finish_reason;
  }
}
