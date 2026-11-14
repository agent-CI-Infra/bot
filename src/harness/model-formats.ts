import { randomUUID } from 'node:crypto';
import type { ModelInterfaceType } from '../models/catalog.js';

export type DownstreamEndpoint = 'messages' | 'responses' | 'chat_completions';

export interface CanonicalUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
}

export type CanonicalUserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data?: string; url?: string }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean };

export type CanonicalAssistantPart =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; callId: string; name: string; argumentsJson: string; custom?: boolean };

export type CanonicalTurn =
  | { role: 'user'; parts: CanonicalUserPart[] }
  | { role: 'assistant'; parts: CanonicalAssistantPart[] };

export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, any>;
  strict?: boolean;
  custom?: boolean;
}

export interface CanonicalModelRequest {
  model: string;
  system: string[];
  turns: CanonicalTurn[];
  tools: CanonicalTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; name: string };
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream: boolean;
}

export type CanonicalStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'content_filter';

export type CanonicalStreamEvent =
  | { type: 'start'; id: string; model: string }
  | { type: 'thinking_delta'; index: number; delta: string }
  | { type: 'text_delta'; index: number; delta: string }
  | { type: 'tool_call_start'; index: number; callId: string; name: string }
  | { type: 'tool_call_delta'; index: number; delta: string }
  | { type: 'usage'; usage: CanonicalUsage }
  | { type: 'finish'; stopReason: CanonicalStopReason };

const nonNegInt = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const sanitizeAnthropicId = (id: string) => (id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)) || 'call_' + randomUUID().replace(/-/g, '').slice(0, 16);

export function endpointToFormat(endpoint: DownstreamEndpoint): ModelInterfaceType {
  if (endpoint === 'messages') return 'anthropic-messages';
  if (endpoint === 'responses') return 'openai-responses';
  return 'openai-chat-completions';
}

export function accountingUsagePayload(usage: CanonicalUsage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(usage.cached_input_tokens !== null ? { input_tokens_details: { cached_tokens: usage.cached_input_tokens } } : {}),
  };
}

function parseDataUrl(url: string): { mediaType: string; data?: string; url?: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (match) return { mediaType: match[1]!, data: match[2]! };
  return { mediaType: 'image/png', url };
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as any).text === 'string') return (part as any).text;
      return JSON.stringify(part);
    });
    return texts.join('\n');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

function pushUserPart(turns: CanonicalTurn[], part: CanonicalUserPart) {
  const last = turns.at(-1);
  if (last?.role === 'user') last.parts.push(part);
  else turns.push({ role: 'user', parts: [part] });
}

function pushAssistantPart(turns: CanonicalTurn[], part: CanonicalAssistantPart) {
  const last = turns.at(-1);
  if (last?.role === 'assistant') last.parts.push(part);
  else turns.push({ role: 'assistant', parts: [part] });
}

export function parseDownstreamRequest(format: ModelInterfaceType, body: Record<string, any>): CanonicalModelRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_request_body');
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) throw new Error('missing_model');
  const stream = body.stream === true;
  const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined;
  const topP = typeof body.top_p === 'number' && Number.isFinite(body.top_p) ? body.top_p : undefined;

  if (format === 'anthropic-messages') {
    const system: string[] = [];
    if (typeof body.system === 'string' && body.system) system.push(body.system);
    else if (Array.isArray(body.system)) {
      for (const item of body.system) if (typeof item === 'string') system.push(item);
      else if (item?.type === 'text' && typeof item.text === 'string') system.push(item.text);
    }
    if (!Array.isArray(body.messages)) throw new Error('missing_messages');
    const turns: CanonicalTurn[] = [];
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') pushUserPart(turns, { type: 'text', text: msg.content });
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof block.text === 'string') pushUserPart(turns, { type: 'text', text: block.text });
            else if (block.type === 'image' && block.source) {
              if (block.source.type === 'base64' && typeof block.source.data === 'string')
                pushUserPart(turns, { type: 'image', mediaType: String(block.source.media_type || 'image/png'), data: block.source.data });
              else if (block.source.type === 'url' && typeof block.source.url === 'string')
                pushUserPart(turns, { type: 'image', mediaType: 'image/png', url: block.source.url });
            } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              pushUserPart(turns, { type: 'tool_result', callId: block.tool_use_id, content: stringifyToolContent(block.content), isError: block.is_error === true });
            }
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') pushAssistantPart(turns, { type: 'text', text: msg.content });
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'thinking' && typeof block.thinking === 'string') pushAssistantPart(turns, { type: 'thinking', text: block.thinking });
            else if (block.type === 'text' && typeof block.text === 'string') pushAssistantPart(turns, { type: 'text', text: block.text });
            else if (block.type === 'tool_use' && typeof block.name === 'string') {
              const callId = typeof block.id === 'string' && block.id ? block.id : 'call_' + randomUUID().replace(/-/g, '').slice(0, 16);
              pushAssistantPart(turns, { type: 'tool_call', callId, name: block.name, argumentsJson: JSON.stringify(block.input ?? {}) });
            }
          }
        }
      }
    }
    const tools: CanonicalTool[] = Array.isArray(body.tools) ? body.tools.filter((t: any) => t && typeof t.name === 'string').map((t: any) => ({
      name: String(t.name),
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      inputSchema: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} },
    })) : [];
    const tc = body.tool_choice;
    const toolChoice: CanonicalModelRequest['toolChoice'] = tc?.type === 'auto' ? 'auto'
      : tc?.type === 'any' ? 'required'
      : tc?.type === 'none' ? 'none'
      : tc?.type === 'tool' && typeof tc.name === 'string' ? { type: 'tool', name: tc.name }
      : undefined;
    const maxOutputTokens = nonNegInt(body.max_tokens) && body.max_tokens > 0 ? Number(body.max_tokens) : undefined;
    const stopSequences = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s: unknown): s is string => typeof s === 'string') : undefined;
    return { model, system, turns, tools, toolChoice, maxOutputTokens, temperature, topP, stopSequences, stream };
  }

  if (format === 'openai-responses') {
    const system: string[] = [];
    if (typeof body.instructions === 'string' && body.instructions) system.push(body.instructions);
    const turns: CanonicalTurn[] = [];
    const rawInput = body.input;
    if (typeof rawInput === 'string') {
      pushUserPart(turns, { type: 'text', text: rawInput });
    } else if (Array.isArray(rawInput)) {
      for (const item of rawInput) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'function_call') {
          const callId = String(item.call_id || item.id || 'call_' + randomUUID().replace(/-/g, '').slice(0, 16));
          const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
          pushAssistantPart(turns, { type: 'tool_call', callId, name: String(item.name || 'tool'), argumentsJson: args });
          continue;
        }
        if (item.type === 'custom_tool_call') {
          const callId = String(item.call_id || item.id || 'call_' + randomUUID().replace(/-/g, '').slice(0, 16));
          const args = JSON.stringify({ input: typeof item.input === 'string' ? item.input : String(item.input ?? '') });
          pushAssistantPart(turns, { type: 'tool_call', callId, name: String(item.name || 'tool'), argumentsJson: args, custom: true });
          continue;
        }
        if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
          pushUserPart(turns, { type: 'tool_result', callId: String(item.call_id || ''), content: stringifyToolContent(item.output) });
          continue;
        }
        if (item.type === 'reasoning') {
          const summary = Array.isArray(item.summary) ? item.summary.map((s: any) => typeof s?.text === 'string' ? s.text : '').filter(Boolean).join('\n') : '';
          if (summary) pushAssistantPart(turns, { type: 'thinking', text: summary });
          continue;
        }
        const role = item.role;
        if (role === 'system' || role === 'developer') {
          const text = extractResponsesText(item.content);
          if (!text) continue;
          if (!turns.length) system.push(text);
          else pushUserPart(turns, { type: 'text', text: `<developer_instructions>\n${text}\n</developer_instructions>` });
        } else if (role === 'user') {
          if (typeof item.content === 'string') pushUserPart(turns, { type: 'text', text: item.content });
          else if (Array.isArray(item.content)) {
            for (const part of item.content) {
              if (!part || typeof part !== 'object') continue;
              if ((part.type === 'input_text' || part.type === 'text') && typeof part.text === 'string') pushUserPart(turns, { type: 'text', text: part.text });
              else if (part.type === 'input_image' || part.type === 'image_url') {
                const rawUrl = typeof part.image_url === 'string' ? part.image_url : typeof part.image_url?.url === 'string' ? part.image_url.url : '';
                if (rawUrl) pushUserPart(turns, { type: 'image', ...parseDataUrl(rawUrl) });
              }
            }
          }
        } else if (role === 'assistant') {
          if (typeof item.content === 'string') pushAssistantPart(turns, { type: 'text', text: item.content });
          else if (Array.isArray(item.content)) {
            for (const part of item.content) {
              if (!part || typeof part !== 'object') continue;
              if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') pushAssistantPart(turns, { type: 'text', text: part.text });
              else if (part.type === 'refusal' && typeof part.refusal === 'string') pushAssistantPart(turns, { type: 'text', text: part.refusal });
            }
          }
        }
      }
    } else if (rawInput !== undefined) {
      throw new Error('invalid_input');
    }
    const tools: CanonicalTool[] = [];
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (!tool || typeof tool !== 'object') continue;
        if (tool.type === 'custom' && typeof tool.name === 'string') {
          tools.push({
            name: tool.name,
            ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
            inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
            custom: true,
          });
        } else {
          const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
          if (typeof fn.name === 'string') {
            tools.push({
              name: fn.name,
              ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
              inputSchema: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
              ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
            });
          }
        }
      }
    }
    const tc = body.tool_choice;
    const toolChoice: CanonicalModelRequest['toolChoice'] = tc === 'auto' || tc === 'none' || tc === 'required' ? tc
      : tc?.type === 'function' && typeof (tc.name ?? tc.function?.name) === 'string' ? { type: 'tool', name: String(tc.name ?? tc.function.name) }
      : undefined;
    const maxOutputTokens = nonNegInt(body.max_output_tokens) && body.max_output_tokens > 0 ? Number(body.max_output_tokens) : undefined;
    return { model, system, turns, tools, toolChoice, maxOutputTokens, temperature, topP, stream };
  }

  // openai-chat-completions
  if (!Array.isArray(body.messages)) throw new Error('missing_messages');
  const system: string[] = [];
  const turns: CanonicalTurn[] = [];
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = extractResponsesText(msg.content);
      if (!text) continue;
      if (!turns.length) system.push(text);
      else pushUserPart(turns, { type: 'text', text: `<developer_instructions>\n${text}\n</developer_instructions>` });
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') pushUserPart(turns, { type: 'text', text: msg.content });
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && typeof part.text === 'string') pushUserPart(turns, { type: 'text', text: part.text });
          else if (part.type === 'image_url') {
            const rawUrl = typeof part.image_url === 'string' ? part.image_url : typeof part.image_url?.url === 'string' ? part.image_url.url : '';
            if (rawUrl) pushUserPart(turns, { type: 'image', ...parseDataUrl(rawUrl) });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) pushAssistantPart(turns, { type: 'thinking', text: msg.reasoning_content });
      if (typeof msg.content === 'string' && msg.content) pushAssistantPart(turns, { type: 'text', text: msg.content });
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) if (part?.type === 'text' && typeof part.text === 'string') pushAssistantPart(turns, { type: 'text', text: part.text });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call?.function?.name) continue;
          pushAssistantPart(turns, {
            type: 'tool_call',
            callId: typeof call.id === 'string' && call.id ? call.id : 'call_' + randomUUID().replace(/-/g, '').slice(0, 16),
            name: String(call.function.name),
            argumentsJson: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
          });
        }
      }
    } else if (msg.role === 'tool') {
      pushUserPart(turns, { type: 'tool_result', callId: String(msg.tool_call_id || ''), content: stringifyToolContent(msg.content) });
    }
  }
  const tools: CanonicalTool[] = Array.isArray(body.tools) ? body.tools.filter((t: any) => t?.function?.name).map((t: any) => ({
    name: String(t.function.name),
    ...(typeof t.function.description === 'string' ? { description: t.function.description } : {}),
    inputSchema: t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} },
    ...(typeof t.function.strict === 'boolean' ? { strict: t.function.strict } : {}),
  })) : [];
  const tc = body.tool_choice;
  const toolChoice: CanonicalModelRequest['toolChoice'] = tc === 'auto' || tc === 'none' || tc === 'required' ? tc
    : tc?.type === 'function' && typeof tc.function?.name === 'string' ? { type: 'tool', name: tc.function.name }
    : undefined;
  const maxRaw = body.max_completion_tokens ?? body.max_tokens;
  const maxOutputTokens = nonNegInt(maxRaw) && maxRaw > 0 ? Number(maxRaw) : undefined;
  const stopSequences = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s: unknown): s is string => typeof s === 'string') : undefined;
  return { model, system, turns, tools, toolChoice, maxOutputTokens, temperature, topP, stopSequences, stream };
}

function extractResponsesText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

export function serializeUpstreamRequest(format: ModelInterfaceType, ir: CanonicalModelRequest, targetModel: string, defaultMaxTokens = 8192): Record<string, any> {
  const maxTokens = ir.maxOutputTokens ?? defaultMaxTokens;
  if (format === 'anthropic-messages') {
    const idMap = new Map<string, string>();
    const mapId = (raw: string) => {
      let mapped = idMap.get(raw);
      if (!mapped) { mapped = sanitizeAnthropicId(raw); idMap.set(raw, mapped); }
      return mapped;
    };
    const messages: Record<string, any>[] = [];
    for (const turn of ir.turns) {
      if (turn.role === 'user') {
        const toolResults: any[] = [], rest: any[] = [];
        for (const part of turn.parts) {
          if (part.type === 'tool_result') {
            toolResults.push({ type: 'tool_result', tool_use_id: mapId(part.callId), content: part.content, ...(part.isError ? { is_error: true } : {}) });
          } else if (part.type === 'text') {
            if (part.text) rest.push({ type: 'text', text: part.text });
          } else if (part.type === 'image') {
            if (part.data) rest.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } });
            else if (part.url) rest.push({ type: 'image', source: { type: 'url', url: part.url } });
          }
        }
        const content = [...toolResults, ...rest];
        if (content.length) messages.push({ role: 'user', content });
      } else {
        const content: any[] = [];
        for (const part of turn.parts) {
          if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text });
          else if (part.type === 'tool_call') {
            let input: Record<string, any> = {};
            try {
              const parsed = JSON.parse(part.argumentsJson || '{}');
              input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
            } catch { input = {}; }
            content.push({ type: 'tool_use', id: mapId(part.callId), name: part.name, input });
          }
        }
        if (content.length) messages.push({ role: 'assistant', content });
      }
    }
    if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: '.' }] });
    const out: Record<string, any> = {
      model: targetModel,
      max_tokens: maxTokens,
      messages,
      stream: ir.stream,
    };
    if (ir.system.length) out.system = ir.system.join('\n\n');
    if (ir.tools.length) {
      out.tools = ir.tools.map(t => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.inputSchema }));
    }
    if (ir.toolChoice) {
      out.tool_choice = ir.toolChoice === 'auto' ? { type: 'auto' }
        : ir.toolChoice === 'required' ? { type: 'any' }
        : ir.toolChoice === 'none' ? { type: 'none' }
        : { type: 'tool', name: ir.toolChoice.name };
    }
    if (ir.temperature !== undefined) out.temperature = ir.temperature;
    if (ir.topP !== undefined) out.top_p = ir.topP;
    if (ir.stopSequences?.length) out.stop_sequences = ir.stopSequences;
    return out;
  }

  if (format === 'openai-responses') {
    const input: any[] = [];
    for (const turn of ir.turns) {
      if (turn.role === 'user') {
        let userContent: any[] = [];
        const flushUser = () => { if (userContent.length) { input.push({ role: 'user', content: userContent }); userContent = []; } };
        for (const part of turn.parts) {
          if (part.type === 'tool_result') {
            flushUser();
            input.push({ type: 'function_call_output', call_id: part.callId, output: part.content });
          } else if (part.type === 'text') {
            userContent.push({ type: 'input_text', text: part.text });
          } else if (part.type === 'image') {
            const imageUrl = part.data ? `data:${part.mediaType};base64,${part.data}` : part.url!;
            userContent.push({ type: 'input_image', image_url: imageUrl });
          }
        }
        flushUser();
      } else {
        let assistantContent: any[] = [];
        const flushAssistant = () => { if (assistantContent.length) { input.push({ type: 'message', role: 'assistant', content: assistantContent }); assistantContent = []; } };
        for (const part of turn.parts) {
          if (part.type === 'text' && part.text) {
            assistantContent.push({ type: 'output_text', text: part.text });
          } else if (part.type === 'tool_call') {
            flushAssistant();
            input.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: part.argumentsJson || '{}' });
          }
        }
        flushAssistant();
      }
    }
    const out: Record<string, any> = {
      model: targetModel,
      input,
      max_output_tokens: maxTokens,
      stream: ir.stream,
    };
    if (ir.system.length) out.instructions = ir.system.join('\n\n');
    if (ir.tools.length) {
      out.tools = ir.tools.map(t => ({
        type: 'function',
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      }));
    }
    if (ir.toolChoice) {
      out.tool_choice = typeof ir.toolChoice === 'string' ? ir.toolChoice : { type: 'function', name: ir.toolChoice.name };
    }
    if (ir.temperature !== undefined) out.temperature = ir.temperature;
    if (ir.topP !== undefined) out.top_p = ir.topP;
    return out;
  }

  // openai-chat-completions
  const messages: Record<string, any>[] = [];
  if (ir.system.length) messages.push({ role: 'system', content: ir.system.join('\n\n') });
  for (const turn of ir.turns) {
    if (turn.role === 'user') {
      let userParts: any[] = [];
      const flushUser = () => {
        if (!userParts.length) return;
        if (userParts.length === 1 && userParts[0].type === 'text') messages.push({ role: 'user', content: userParts[0].text });
        else messages.push({ role: 'user', content: userParts });
        userParts = [];
      };
      for (const part of turn.parts) {
        if (part.type === 'tool_result') {
          flushUser();
          messages.push({ role: 'tool', tool_call_id: part.callId, content: part.content });
        } else if (part.type === 'text') {
          userParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          const url = part.data ? `data:${part.mediaType};base64,${part.data}` : part.url!;
          userParts.push({ type: 'image_url', image_url: { url } });
        }
      }
      flushUser();
    } else {
      const texts: string[] = [], toolCalls: any[] = [];
      for (const part of turn.parts) {
        if (part.type === 'text' && part.text) texts.push(part.text);
        else if (part.type === 'tool_call') {
          toolCalls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: part.argumentsJson || '{}' } });
        }
      }
      const msg: Record<string, any> = { role: 'assistant', content: texts.length ? texts.join('') : null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (msg.content !== null || toolCalls.length) messages.push(msg);
    }
  }
  const out: Record<string, any> = {
    model: targetModel,
    messages,
    max_completion_tokens: maxTokens,
    stream: ir.stream,
    ...(ir.stream ? { stream_options: { include_usage: true } } : {}),
  };
  if (ir.tools.length) {
    out.tools = ir.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
  }
  if (ir.toolChoice) {
    out.tool_choice = typeof ir.toolChoice === 'string' ? ir.toolChoice : { type: 'function', function: { name: ir.toolChoice.name } };
  }
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.stopSequences?.length) out.stop = ir.stopSequences;
  return out;
}

export function patchPassthroughRequest(format: ModelInterfaceType, body: Record<string, any>, targetModel: string, maxOutputTokens?: number): Record<string, any> {
  const patched: Record<string, any> = { ...body, model: targetModel };
  if (format === 'openai-chat-completions') {
    if (patched.stream === true) patched.stream_options = { ...(patched.stream_options && typeof patched.stream_options === 'object' ? patched.stream_options : {}), include_usage: true };
    if (maxOutputTokens !== undefined) {
      const key = 'max_tokens' in patched && !('max_completion_tokens' in patched) ? 'max_tokens' : 'max_completion_tokens';
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

function mapChatStopReason(reason: unknown, hasToolCalls: boolean): CanonicalStopReason {
  if (reason === 'tool_calls' || reason === 'function_call' || (hasToolCalls && reason === 'stop')) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'content_filter';
  return 'end_turn';
}

function mapAnthropicStopReason(reason: unknown): CanonicalStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

function extractAnthropicUsage(u: any, prev: CanonicalUsage): CanonicalUsage {
  if (!u || typeof u !== 'object') return prev;
  const baseIn = nonNegInt(u.input_tokens);
  const cacheRead = nonNegInt(u.cache_read_input_tokens);
  const cacheCreate = nonNegInt(u.cache_creation_input_tokens);
  const out = nonNegInt(u.output_tokens);
  const totalIn = baseIn !== null ? baseIn + (cacheRead ?? 0) + (cacheCreate ?? 0) : prev.input_tokens;
  const cached = cacheRead !== null ? cacheRead : baseIn !== null && prev.cached_input_tokens === null ? 0 : prev.cached_input_tokens;
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
  const cached = nonNegInt(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens);
  return {
    input_tokens: inp ?? prev.input_tokens,
    output_tokens: out ?? prev.output_tokens,
    cached_input_tokens: cached !== null ? cached : prev.cached_input_tokens,
  };
}

export class UpstreamStreamDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private json = '';
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private textBlockIndex: number | null = null;
  private thinkingBlockIndex: number | null = null;
  private toolIndices = new Map<string | number, number>();
  private hasToolCalls = false;
  usage: CanonicalUsage = { input_tokens: null, output_tokens: null, cached_input_tokens: null };
  responseId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
  model: string;

  constructor(
    private readonly format: ModelInterfaceType,
    private readonly sse: boolean,
    fallbackModel: string,
  ) {
    this.model = fallbackModel;
  }

  push(chunk: Uint8Array): CanonicalStreamEvent[] {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      this.json += text;
      return [];
    }
    this.pending += text;
    const events: CanonicalStreamEvent[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.consumeSseFrame(frame, events);
    }
    if (Buffer.byteLength(this.pending) > 4 * 1024 * 1024) throw new Error('provider_frame_limit');
    return events;
  }

  end(): CanonicalStreamEvent[] {
    const tail = this.decoder.decode();
    const events: CanonicalStreamEvent[] = [];
    if (!this.sse) {
      const raw = (this.json + tail).trim();
      if (!raw) throw new Error('provider_empty_response');
      this.consumeJsonBody(JSON.parse(raw), events);
      return events;
    }
    const rest = (this.pending + tail).trim();
    if (rest) this.consumeSseFrame(rest, events);
    if (!this.finished && this.started) {
      this.finished = true;
      events.push({ type: 'finish', stopReason: this.hasToolCalls ? 'tool_use' : 'end_turn' });
    }
    return events;
  }

  private ensureStarted(events: CanonicalStreamEvent[], id?: unknown, model?: unknown) {
    if (typeof id === 'string' && id) this.responseId = id;
    if (typeof model === 'string' && model) this.model = model;
    if (!this.started) {
      this.started = true;
      events.push({ type: 'start', id: this.responseId, model: this.model });
    }
  }

  private consumeSseFrame(frame: string, events: CanonicalStreamEvent[]) {
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') return;
    const payload = JSON.parse(data);
    if (this.format === 'anthropic-messages') this.consumeAnthropicEvent(eventName || payload?.type, payload, events);
    else if (this.format === 'openai-responses') this.consumeResponsesEvent(eventName || payload?.type, payload, events);
    else this.consumeChatChunk(payload, events);
  }

  private consumeAnthropicEvent(type: string, payload: any, events: CanonicalStreamEvent[]) {
    if (type === 'error' || payload?.type === 'error') {
      throw new Error(String(payload?.error?.message || payload?.error?.type || 'upstream_stream_error'));
    }
    if (type === 'message_start') {
      const m = payload.message ?? {};
      this.ensureStarted(events, m.id, m.model);
      if (m.usage) { this.usage = extractAnthropicUsage(m.usage, this.usage); events.push({ type: 'usage', usage: { ...this.usage } }); }
      return;
    }
    this.ensureStarted(events);
    if (type === 'content_block_start') {
      const idx = Number(payload.index ?? this.nextIndex++);
      this.nextIndex = Math.max(this.nextIndex, idx + 1);
      const block = payload.content_block ?? {};
      if (block.type === 'tool_use') {
        this.hasToolCalls = true;
        this.toolIndices.set(idx, idx);
        events.push({ type: 'tool_call_start', index: idx, callId: String(block.id || 'call_' + idx), name: String(block.name || 'tool') });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        events.push({ type: 'text_delta', index: idx, delta: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        events.push({ type: 'thinking_delta', index: idx, delta: block.thinking });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const idx = Number(payload.index ?? 0), d = payload.delta ?? {};
      if (d.type === 'text_delta' && typeof d.text === 'string') events.push({ type: 'text_delta', index: idx, delta: d.text });
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') events.push({ type: 'thinking_delta', index: idx, delta: d.thinking });
      else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') events.push({ type: 'tool_call_delta', index: idx, delta: d.partial_json });
      return;
    }
    if (type === 'message_delta') {
      if (payload.usage) { this.usage = extractAnthropicUsage(payload.usage, this.usage); events.push({ type: 'usage', usage: { ...this.usage } }); }
      if (payload.delta?.stop_reason && !this.finished) {
        this.finished = true;
        events.push({ type: 'finish', stopReason: mapAnthropicStopReason(payload.delta.stop_reason) });
      }
      return;
    }
    if (type === 'message_stop' && !this.finished) {
      this.finished = true;
      events.push({ type: 'finish', stopReason: this.hasToolCalls ? 'tool_use' : 'end_turn' });
    }
  }

  private consumeResponsesEvent(type: string, payload: any, events: CanonicalStreamEvent[]) {
    if (type === 'error' || type === 'response.failed') {
      throw new Error(String(payload?.error?.message || payload?.response?.error?.message || 'upstream_stream_error'));
    }
    if (type === 'response.created' || type === 'response.in_progress') {
      const r = payload.response ?? {};
      this.ensureStarted(events, r.id, r.model);
      return;
    }
    this.ensureStarted(events);
    if (type === 'response.output_item.added') {
      const item = payload.item ?? {}, outIdx = Number(payload.output_index ?? this.nextIndex++);
      this.nextIndex = Math.max(this.nextIndex, outIdx + 1);
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        this.hasToolCalls = true;
        const key = item.id ?? outIdx;
        this.toolIndices.set(key, outIdx);
        events.push({ type: 'tool_call_start', index: outIdx, callId: String(item.call_id || item.id || 'call_' + outIdx), name: String(item.name || 'tool') });
      }
      return;
    }
    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      const idx = Number(payload.output_index ?? 0);
      this.nextIndex = Math.max(this.nextIndex, idx + 1);
      events.push({ type: 'text_delta', index: idx, delta: payload.delta });
      return;
    }
    if (type === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string') {
      const idx = Number(payload.output_index ?? 0);
      this.nextIndex = Math.max(this.nextIndex, idx + 1);
      events.push({ type: 'thinking_delta', index: idx, delta: payload.delta });
      return;
    }
    if ((type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta') && typeof payload.delta === 'string') {
      const idx = this.toolIndices.get(payload.item_id) ?? Number(payload.output_index ?? 0);
      events.push({ type: 'tool_call_delta', index: idx, delta: payload.delta });
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const r = payload.response ?? {};
      if (r.usage) { this.usage = extractOpenAiUsage(r.usage, this.usage); events.push({ type: 'usage', usage: { ...this.usage } }); }
      // Some Responses servers omit deltas and populate r.output only on response.completed.
      if (Array.isArray(r.output) && this.nextIndex === 0) {
        this.emitResponsesOutputItems(r.output, events);
      }
      if (!this.finished) {
        this.finished = true;
        const reason: CanonicalStopReason = type === 'response.incomplete' || r.status === 'incomplete' ? 'max_tokens' : this.hasToolCalls ? 'tool_use' : 'end_turn';
        events.push({ type: 'finish', stopReason: reason });
      }
    }
  }

  private consumeChatChunk(payload: any, events: CanonicalStreamEvent[]) {
    if (payload?.error) throw new Error(String(payload.error.message || payload.error || 'upstream_stream_error'));
    this.ensureStarted(events, payload.id, payload.model);
    if (payload.usage) {
      this.usage = extractOpenAiUsage(payload.usage, this.usage);
      events.push({ type: 'usage', usage: { ...this.usage } });
    }
    const choice = payload.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (this.thinkingBlockIndex === null) this.thinkingBlockIndex = this.nextIndex++;
      events.push({ type: 'thinking_delta', index: this.thinkingBlockIndex, delta: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (this.textBlockIndex === null) this.textBlockIndex = this.nextIndex++;
      events.push({ type: 'text_delta', index: this.textBlockIndex, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = Number(tc.index ?? 0);
        let blockIdx = this.toolIndices.get(key);
        if (blockIdx === undefined) {
          blockIdx = this.nextIndex++;
          this.toolIndices.set(key, blockIdx);
          this.hasToolCalls = true;
          events.push({
            type: 'tool_call_start',
            index: blockIdx,
            callId: typeof tc.id === 'string' && tc.id ? tc.id : 'call_' + randomUUID().replace(/-/g, '').slice(0, 16),
            name: String(tc.function?.name || 'tool'),
          });
        }
        if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
          events.push({ type: 'tool_call_delta', index: blockIdx, delta: tc.function.arguments });
        }
      }
    }
    if (choice.finish_reason && !this.finished) {
      this.finished = true;
      events.push({ type: 'finish', stopReason: mapChatStopReason(choice.finish_reason, this.hasToolCalls) });
    }
  }

  private emitResponsesOutputItems(output: any[], events: CanonicalStreamEvent[]) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        const text = item.summary.map((s: any) => typeof s?.text === 'string' ? s.text : '').filter(Boolean).join('\n');
        if (text) events.push({ type: 'thinking_delta', index: this.nextIndex++, delta: text });
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        const text = item.content.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('');
        if (text) events.push({ type: 'text_delta', index: this.nextIndex++, delta: text });
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const idx = this.nextIndex++;
        this.hasToolCalls = true;
        const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input ?? '' }) : String(item.arguments ?? '{}');
        events.push({ type: 'tool_call_start', index: idx, callId: String(item.call_id || item.id || 'call_' + idx), name: String(item.name || 'tool') });
        if (args) events.push({ type: 'tool_call_delta', index: idx, delta: args });
      }
    }
  }

  private consumeJsonBody(body: any, events: CanonicalStreamEvent[]) {
    if (this.format === 'anthropic-messages') {
      this.ensureStarted(events, body.id, body.model);
      if (body.usage) { this.usage = extractAnthropicUsage(body.usage, this.usage); events.push({ type: 'usage', usage: { ...this.usage } }); }
      for (const block of Array.isArray(body.content) ? body.content : []) {
        const idx = this.nextIndex++;
        if (block?.type === 'thinking' && typeof block.thinking === 'string') events.push({ type: 'thinking_delta', index: idx, delta: block.thinking });
        else if (block?.type === 'text' && typeof block.text === 'string') events.push({ type: 'text_delta', index: idx, delta: block.text });
        else if (block?.type === 'tool_use') {
          this.hasToolCalls = true;
          events.push({ type: 'tool_call_start', index: idx, callId: String(block.id || 'call_' + idx), name: String(block.name || 'tool') });
          events.push({ type: 'tool_call_delta', index: idx, delta: JSON.stringify(block.input ?? {}) });
        }
      }
      this.finished = true;
      events.push({ type: 'finish', stopReason: mapAnthropicStopReason(body.stop_reason) });
      return;
    }
    if (this.format === 'openai-responses') {
      this.ensureStarted(events, body.id, body.model);
      if (body.usage) { this.usage = extractOpenAiUsage(body.usage, this.usage); events.push({ type: 'usage', usage: { ...this.usage } }); }
      if (Array.isArray(body.output)) this.emitResponsesOutputItems(body.output, events);
      else if (typeof body.output_text === 'string' && body.output_text) events.push({ type: 'text_delta', index: this.nextIndex++, delta: body.output_text });
      this.finished = true;
      events.push({ type: 'finish', stopReason: body.status === 'incomplete' ? 'max_tokens' : this.hasToolCalls ? 'tool_use' : 'end_turn' });
      return;
    }
    this.ensureStarted(events, body.id, body.model);
    if (body.usage) { this.usage = extractOpenAiUsage(body.usage, this.usage); events.push({ type: 'usage', usage: { ...this.usage } }); }
    const choice = body.choices?.[0], msg = choice?.message ?? {};
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) events.push({ type: 'thinking_delta', index: this.nextIndex++, delta: msg.reasoning_content });
    const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('') : '';
    if (text) events.push({ type: 'text_delta', index: this.nextIndex++, delta: text });
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const idx = this.nextIndex++;
        this.hasToolCalls = true;
        events.push({ type: 'tool_call_start', index: idx, callId: String(tc.id || 'call_' + idx), name: String(tc.function?.name || 'tool') });
        events.push({ type: 'tool_call_delta', index: idx, delta: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}) });
      }
    }
    this.finished = true;
    events.push({ type: 'finish', stopReason: mapChatStopReason(choice?.finish_reason, this.hasToolCalls) });
  }
}

interface BlockAccum {
  kind: 'thinking' | 'text' | 'tool';
  text: string;
  callId?: string;
  name?: string;
  itemId: string;
  outputIndex: number;
  opened: boolean;
  closed: boolean;
}

export class DownstreamResponseBuilder {
  private id = 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
  private createdAt = Math.floor(Date.now() / 1000);
  private started = false;
  private finished = false;
  private seq = 0;
  private blocks = new Map<number, BlockAccum>();
  private orderedBlocks: BlockAccum[] = [];
  private activeAnthropicBlock: number | null = null;
  private anthropicOutIndex = 0;
  private anthropicIndexMap = new Map<number, number>();
  private chatToolIndexMap = new Map<number, number>();
  private nextChatToolIndex = 0;
  private stopReason: CanonicalStopReason = 'end_turn';
  usage: CanonicalUsage = { input_tokens: null, output_tokens: null, cached_input_tokens: null };

  constructor(
    private readonly format: ModelInterfaceType,
    private readonly stream: boolean,
    private model: string,
    private readonly customToolNames: ReadonlySet<string> = new Set(),
  ) {}

  push(events: CanonicalStreamEvent[]): string {
    let out = '';
    for (const ev of events) {
      if (ev.type === 'start') {
        if (ev.id) this.id = ev.id;
        if (ev.model) this.model = ev.model;
        if (this.stream) out += this.emitStart();
      } else if (ev.type === 'usage') {
        this.usage = ev.usage;
      } else if (ev.type === 'thinking_delta') {
        const b = this.getOrCreateBlock(ev.index, 'thinking');
        b.text += ev.delta;
        if (this.stream) out += this.emitThinkingDelta(ev.index, b, ev.delta);
      } else if (ev.type === 'text_delta') {
        const b = this.getOrCreateBlock(ev.index, 'text');
        b.text += ev.delta;
        if (this.stream) out += this.emitTextDelta(ev.index, b, ev.delta);
      } else if (ev.type === 'tool_call_start') {
        const b = this.getOrCreateBlock(ev.index, 'tool', ev.callId, ev.name);
        if (this.stream) out += this.emitToolStart(ev.index, b);
      } else if (ev.type === 'tool_call_delta') {
        const b = this.getOrCreateBlock(ev.index, 'tool');
        b.text += ev.delta;
        if (this.stream) out += this.emitToolDelta(ev.index, b, ev.delta);
      } else if (ev.type === 'finish') {
        this.stopReason = ev.stopReason;
        if (this.stream && !this.finished) out += this.emitFinish();
      }
    }
    return out;
  }

  finalize(): { body: string; jsonSnapshot: Record<string, any> } {
    let tail = '';
    if (this.stream && !this.finished) tail = this.emitFinish();
    const snapshot = this.buildJson();
    return { body: this.stream ? tail : JSON.stringify(snapshot), jsonSnapshot: snapshot };
  }

  private getOrCreateBlock(index: number, kind: BlockAccum['kind'], callId?: string, name?: string): BlockAccum {
    let b = this.blocks.get(index);
    if (!b) {
      const prefix = kind === 'tool' ? 'fc_' : kind === 'thinking' ? 'rs_' : 'msg_';
      b = {
        kind,
        text: '',
        ...(callId ? { callId } : {}),
        ...(name ? { name } : {}),
        itemId: prefix + randomUUID().replace(/-/g, '').slice(0, 20),
        outputIndex: this.orderedBlocks.length,
        opened: false,
        closed: false,
      };
      this.blocks.set(index, b);
      this.orderedBlocks.push(b);
    } else {
      if (callId && !b.callId) b.callId = callId;
      if (name && !b.name) b.name = name;
    }
    return b;
  }

  private sseEvent(event: string, data: Record<string, any>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitStart(): string {
    if (this.started) return '';
    this.started = true;
    if (this.format === 'anthropic-messages') {
      const msgId = this.id.startsWith('msg_') ? this.id : 'msg_' + this.id.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
      return this.sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: msgId, type: 'message', role: 'assistant', model: this.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: this.usage.input_tokens ?? 0, output_tokens: 0 },
        },
      });
    }
    if (this.format === 'openai-responses') {
      const respId = this.id.startsWith('resp_') ? this.id : 'resp_' + this.id.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
      const base = { id: respId, object: 'response', created_at: this.createdAt, status: 'in_progress', model: this.model, output: [] };
      return this.sseEvent('response.created', { type: 'response.created', sequence_number: this.seq++, response: base })
        + this.sseEvent('response.in_progress', { type: 'response.in_progress', sequence_number: this.seq++, response: base });
    }
    return `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.createdAt, model: this.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`;
  }

  private openAnthropicBlock(srcIndex: number, contentBlock: Record<string, any>): string {
    let out = this.emitStart();
    if (this.activeAnthropicBlock !== null && this.activeAnthropicBlock !== srcIndex) {
      const prevOut = this.anthropicIndexMap.get(this.activeAnthropicBlock)!;
      out += this.sseEvent('content_block_stop', { type: 'content_block_stop', index: prevOut });
      this.activeAnthropicBlock = null;
    }
    if (!this.anthropicIndexMap.has(srcIndex)) {
      const outIdx = this.anthropicOutIndex++;
      this.anthropicIndexMap.set(srcIndex, outIdx);
      this.activeAnthropicBlock = srcIndex;
      out += this.sseEvent('content_block_start', { type: 'content_block_start', index: outIdx, content_block: contentBlock });
    }
    return out;
  }

  private closeOpenResponsesBlocks(except?: BlockAccum): string {
    let out = '';
    for (const b of this.orderedBlocks) {
      if (b === except || !b.opened || b.closed) continue;
      b.closed = true;
      if (b.kind === 'text') {
        out += this.sseEvent('response.output_text.done', { type: 'response.output_text.done', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, content_index: 0, text: b.text });
        out += this.sseEvent('response.content_part.done', { type: 'response.content_part.done', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, content_index: 0, part: { type: 'output_text', text: b.text, annotations: [] } });
        out += this.sseEvent('response.output_item.done', { type: 'response.output_item.done', sequence_number: this.seq++, output_index: b.outputIndex, item: { id: b.itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: b.text, annotations: [] }] } });
      } else if (b.kind === 'thinking') {
        out += this.sseEvent('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, summary_index: 0, text: b.text });
        out += this.sseEvent('response.output_item.done', { type: 'response.output_item.done', sequence_number: this.seq++, output_index: b.outputIndex, item: { id: b.itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: b.text }] } });
      } else if (b.kind === 'tool') {
        const isCustom = !!(b.name && this.customToolNames.has(b.name));
        if (isCustom) {
          const customInput = extractCustomInput(b.text);
          out += this.sseEvent('response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, input: customInput });
          out += this.sseEvent('response.output_item.done', { type: 'response.output_item.done', sequence_number: this.seq++, output_index: b.outputIndex, item: { id: b.itemId, type: 'custom_tool_call', status: 'completed', call_id: b.callId || b.itemId, name: b.name || 'tool', input: customInput } });
        } else {
          const args = b.text || '{}';
          out += this.sseEvent('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, name: b.name || 'tool', arguments: args });
          out += this.sseEvent('response.output_item.done', { type: 'response.output_item.done', sequence_number: this.seq++, output_index: b.outputIndex, item: { id: b.itemId, type: 'function_call', status: 'completed', call_id: b.callId || b.itemId, name: b.name || 'tool', arguments: args } });
        }
      }
    }
    return out;
  }

  private emitThinkingDelta(srcIndex: number, b: BlockAccum, delta: string): string {
    if (!delta) return '';
    if (this.format === 'anthropic-messages') {
      // Omit unsigned thinking blocks on Anthropic downstream unless needed? No, Claude Code accepts streaming thinking_delta; only resubmitted history needs signature if echoed. Actually Claude Code stores assistant blocks in its session file and replays them on the next turn! If a thinking block has no signature, Anthropic / OpenAI next turn: on OpenAI upstream we strip signatures anyway, and on Anthropic upstream passthrough preserves real signatures! Still, emitting signature: '' can fail if switched back to Anthropic later, so omit synthetic thinking blocks on anthropic-messages downstream unless non-empty? Wait: Claude Code requires `signature_delta` on `thinking` blocks! Omitting synthetic thinking_delta on anthropic-messages downstream avoids invalid signature errors!
      return this.emitStart();
    }
    if (this.format === 'openai-responses') {
      let out = this.emitStart() + this.closeOpenResponsesBlocks(b);
      if (!b.opened) {
        b.opened = true;
        out += this.sseEvent('response.output_item.added', { type: 'response.output_item.added', sequence_number: this.seq++, output_index: b.outputIndex, item: { id: b.itemId, type: 'reasoning', summary: [] } });
      }
      out += this.sseEvent('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, summary_index: 0, delta });
      return out;
    }
    return this.emitStart() + `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.createdAt, model: this.model, choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] })}\n\n`;
  }

  private emitTextDelta(srcIndex: number, b: BlockAccum, delta: string): string {
    if (!delta) return '';
    if (this.format === 'anthropic-messages') {
      const pre = this.openAnthropicBlock(srcIndex, { type: 'text', text: '' });
      const outIdx = this.anthropicIndexMap.get(srcIndex)!;
      return pre + this.sseEvent('content_block_delta', { type: 'content_block_delta', index: outIdx, delta: { type: 'text_delta', text: delta } });
    }
    if (this.format === 'openai-responses') {
      let out = this.emitStart() + this.closeOpenResponsesBlocks(b);
      if (!b.opened) {
        b.opened = true;
        out += this.sseEvent('response.output_item.added', { type: 'response.output_item.added', sequence_number: this.seq++, output_index: b.outputIndex, item: { id: b.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        out += this.sseEvent('response.content_part.added', { type: 'response.content_part.added', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      out += this.sseEvent('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, content_index: 0, delta });
      return out;
    }
    return this.emitStart() + `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.createdAt, model: this.model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`;
  }

  private emitToolStart(srcIndex: number, b: BlockAccum): string {
    const callId = sanitizeAnthropicId(b.callId || 'call_' + srcIndex);
    b.callId = b.callId || callId;
    if (this.format === 'anthropic-messages') {
      return this.openAnthropicBlock(srcIndex, { type: 'tool_use', id: callId, name: b.name || 'tool', input: {} });
    }
    if (this.format === 'openai-responses') {
      let out = this.emitStart() + this.closeOpenResponsesBlocks(b);
      if (!b.opened) {
        b.opened = true;
        const isCustom = !!(b.name && this.customToolNames.has(b.name));
        out += this.sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          sequence_number: this.seq++,
          output_index: b.outputIndex,
          item: isCustom
            ? { id: b.itemId, type: 'custom_tool_call', status: 'in_progress', call_id: b.callId, name: b.name || 'tool', input: '' }
            : { id: b.itemId, type: 'function_call', status: 'in_progress', call_id: b.callId, name: b.name || 'tool', arguments: '' },
        });
      }
      return out;
    }
    let out = this.emitStart();
    if (!this.chatToolIndexMap.has(srcIndex)) {
      const idx = this.nextChatToolIndex++;
      this.chatToolIndexMap.set(srcIndex, idx);
      out += `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.createdAt, model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: b.callId, type: 'function', function: { name: b.name || 'tool', arguments: '' } }] }, finish_reason: null }] })}\n\n`;
    }
    return out;
  }

  private emitToolDelta(srcIndex: number, b: BlockAccum, delta: string): string {
    if (!delta) return '';
    if (this.format === 'anthropic-messages') {
      const pre = this.emitToolStart(srcIndex, b);
      const outIdx = this.anthropicIndexMap.get(srcIndex)!;
      return pre + this.sseEvent('content_block_delta', { type: 'content_block_delta', index: outIdx, delta: { type: 'input_json_delta', partial_json: delta } });
    }
    if (this.format === 'openai-responses') {
      const pre = this.emitToolStart(srcIndex, b);
      const isCustom = !!(b.name && this.customToolNames.has(b.name));
      if (isCustom) return pre; // Custom tool input is emitted normalized on done
      return pre + this.sseEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', sequence_number: this.seq++, item_id: b.itemId, output_index: b.outputIndex, delta });
    }
    const pre = this.emitToolStart(srcIndex, b);
    const idx = this.chatToolIndexMap.get(srcIndex)!;
    return pre + `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.createdAt, model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: delta } }] }, finish_reason: null }] })}\n\n`;
  }

  private emitFinish(): string {
    this.finished = true;
    let out = this.emitStart();
    if (this.format === 'anthropic-messages') {
      if (this.activeAnthropicBlock !== null) {
        const prevOut = this.anthropicIndexMap.get(this.activeAnthropicBlock)!;
        out += this.sseEvent('content_block_stop', { type: 'content_block_stop', index: prevOut });
        this.activeAnthropicBlock = null;
      }
      const stop = this.stopReason === 'tool_use' ? 'tool_use' : this.stopReason === 'max_tokens' ? 'max_tokens' : this.stopReason === 'stop_sequence' ? 'stop_sequence' : 'end_turn';
      const inTok = Math.max(0, (this.usage.input_tokens ?? 0) - (this.usage.cached_input_tokens ?? 0));
      out += this.sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: {
          input_tokens: inTok,
          output_tokens: this.usage.output_tokens ?? 0,
          ...(this.usage.cached_input_tokens ? { cache_read_input_tokens: this.usage.cached_input_tokens } : {}),
        },
      });
      out += this.sseEvent('message_stop', { type: 'message_stop' });
      return out;
    }
    if (this.format === 'openai-responses') {
      out += this.closeOpenResponsesBlocks();
      const responseObj = this.buildResponsesObject();
      const eventType = responseObj.status === 'incomplete' ? 'response.incomplete' : 'response.completed';
      out += this.sseEvent(eventType, { type: eventType, sequence_number: this.seq++, response: responseObj });
      return out;
    }
    const finish = this.stopReason === 'tool_use' ? 'tool_calls' : this.stopReason === 'max_tokens' ? 'length' : this.stopReason === 'content_filter' ? 'content_filter' : 'stop';
    out += `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.createdAt, model: this.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`;
    if (this.usage.input_tokens !== null || this.usage.output_tokens !== null) {
      const inTok = this.usage.input_tokens ?? 0, outTok = this.usage.output_tokens ?? 0;
      out += `data: ${JSON.stringify({
        id: this.id, object: 'chat.completion.chunk', created: this.createdAt, model: this.model, choices: [],
        usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok, ...(this.usage.cached_input_tokens !== null ? { prompt_tokens_details: { cached_tokens: this.usage.cached_input_tokens } } : {}) },
      })}\n\n`;
    }
    out += 'data: [DONE]\n\n';
    return out;
  }

  private buildResponsesObject(): Record<string, any> {
    const respId = this.id.startsWith('resp_') ? this.id : 'resp_' + this.id.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
    const output: any[] = [];
    const texts: string[] = [];
    for (const b of this.orderedBlocks) {
      if (b.kind === 'thinking' && b.text) {
        output.push({ id: b.itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: b.text }] });
      } else if (b.kind === 'text') {
        texts.push(b.text);
        output.push({ id: b.itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: b.text, annotations: [] }] });
      } else if (b.kind === 'tool') {
        const isCustom = !!(b.name && this.customToolNames.has(b.name));
        if (isCustom) {
          output.push({ id: b.itemId, type: 'custom_tool_call', status: 'completed', call_id: b.callId || b.itemId, name: b.name || 'tool', input: extractCustomInput(b.text) });
        } else {
          output.push({ id: b.itemId, type: 'function_call', status: 'completed', call_id: b.callId || b.itemId, name: b.name || 'tool', arguments: b.text || '{}' });
        }
      }
    }
    const inTok = this.usage.input_tokens ?? 0, outTok = this.usage.output_tokens ?? 0;
    const incomplete = this.stopReason === 'max_tokens';
    return {
      id: respId,
      object: 'response',
      created_at: this.createdAt,
      status: incomplete ? 'incomplete' : 'completed',
      ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      model: this.model,
      output,
      output_text: texts.join(''),
      usage: {
        input_tokens: inTok,
        output_tokens: outTok,
        total_tokens: inTok + outTok,
        input_tokens_details: { cached_tokens: this.usage.cached_input_tokens ?? 0 },
      },
    };
  }

  private buildJson(): Record<string, any> {
    if (this.format === 'anthropic-messages') {
      const msgId = this.id.startsWith('msg_') ? this.id : 'msg_' + this.id.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
      const content: any[] = [];
      for (const b of this.orderedBlocks) {
        if (b.kind === 'text') content.push({ type: 'text', text: b.text });
        else if (b.kind === 'tool') {
          let input: Record<string, any> = {};
          try { const p = JSON.parse(b.text || '{}'); input = p && typeof p === 'object' && !Array.isArray(p) ? p : { value: p }; } catch {}
          content.push({ type: 'tool_use', id: sanitizeAnthropicId(b.callId || b.itemId), name: b.name || 'tool', input });
        }
      }
      const stop = this.stopReason === 'tool_use' ? 'tool_use' : this.stopReason === 'max_tokens' ? 'max_tokens' : this.stopReason === 'stop_sequence' ? 'stop_sequence' : 'end_turn';
      const inTok = Math.max(0, (this.usage.input_tokens ?? 0) - (this.usage.cached_input_tokens ?? 0));
      return {
        id: msgId, type: 'message', role: 'assistant', model: this.model, content, stop_reason: stop, stop_sequence: null,
        usage: {
          input_tokens: inTok,
          output_tokens: this.usage.output_tokens ?? 0,
          ...(this.usage.cached_input_tokens ? { cache_read_input_tokens: this.usage.cached_input_tokens } : {}),
        },
      };
    }
    if (this.format === 'openai-responses') return this.buildResponsesObject();
    const texts: string[] = [], thinking: string[] = [], toolCalls: any[] = [];
    for (const b of this.orderedBlocks) {
      if (b.kind === 'thinking' && b.text) thinking.push(b.text);
      else if (b.kind === 'text' && b.text) texts.push(b.text);
      else if (b.kind === 'tool') toolCalls.push({ id: b.callId || b.itemId, type: 'function', function: { name: b.name || 'tool', arguments: b.text || '{}' } });
    }
    const finish = this.stopReason === 'tool_use' ? 'tool_calls' : this.stopReason === 'max_tokens' ? 'length' : this.stopReason === 'content_filter' ? 'content_filter' : 'stop';
    const inTok = this.usage.input_tokens ?? 0, outTok = this.usage.output_tokens ?? 0;
    return {
      id: this.id, object: 'chat.completion', created: this.createdAt, model: this.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: texts.length ? texts.join('') : null,
          ...(thinking.length ? { reasoning_content: thinking.join('') } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      }],
      usage: {
        prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok,
        ...(this.usage.cached_input_tokens !== null ? { prompt_tokens_details: { cached_tokens: this.usage.cached_input_tokens } } : {}),
      },
    };
  }
}

function extractCustomInput(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed.input === 'string') return parsed.input;
  } catch {}
  return raw;
}
