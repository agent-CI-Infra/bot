import { stop } from './common.js';

// Shared by every control-plane tool loop: the default runTools loop, the management assistant, group service roles and
// their own tasks (#333). How many tools the model calls in one message is its own choice (one call per repository across
// ten repositories is normal); what stays bounded is the request each loop sends next.

/** The gateway refuses a model request over 2 MiB (model_request_invalid). */
export const requestLimit = 2 * 1024 * 1024;
export const requestBytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body));
/** Every built-in loop reserves the same final turns for a bounded submission. */
export const finalizationReserve = (maxTurns: number) => Math.min(8, Math.max(2, Math.ceil(maxTurns / 4)));
/** Chat assistants answer inside a model's context window, which is usually far below 2 MiB: older tool results are folded
 * once a request passes about 100k tokens of JSON, the window the project already assumes for Pi (128k). */
export const chatContextBytes = 384 * 1024;
/** One batch of tool results shares one budget, so a call per repository cannot flood the context, while a single large
 * result without paging (a project's effective configuration is about 240 KB) still fits whole. */
export const batchBytes = 256 * 1024;
const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value) ?? 'null'));
export type PreserveResult = (value: unknown, name?: string) => any;

/** Structural check of the tool calls in one model message, without any count limit. Returns what is wrong, or null.
 * Ids must be unique because every result answers its call by id in the next request. */
export function toolCallsProblem(calls: unknown): string | null {
  if (!Array.isArray(calls)) return 'tool_calls_not_array';
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call || typeof call !== 'object' || call.type !== 'function') return 'tool_call_type';
    // Providers differ (call_x, toolu_x, functions.name:0); printable ASCII keeps every known form and nothing else.
    if (typeof call.id !== 'string' || !/^[!-~]{1,128}$/.test(call.id)) return 'tool_call_id';
    if (ids.has(call.id)) return 'tool_call_id_duplicate';
    ids.add(call.id);
    const args = call.function?.arguments;
    if (typeof call.function?.name !== 'string' || !call.function.name || args !== undefined && typeof args !== 'string') return 'tool_call_function';
  }
  return null;
}

/** Parsed arguments of a structurally valid call; null when they are not JSON, which the loop reports to the model.
 * Some providers send no arguments, or an empty string, for a call without parameters. */
export function toolArguments(call: { function: { arguments?: string } }): unknown {
  const raw = call.function.arguments ?? '';
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

/** Small results stay whole; larger results share the remaining serialized batch budget. */
export function boundedBatch(results: unknown[], budget = batchBytes, preserve?: PreserveResult, names?: string[]): unknown[] {
  const sizes = results.map(result => resultBytes(result)), shares: number[] = [];
  let left = budget;
  sizes.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]!).forEach((i, k) => {
    const share = Math.max(0, Math.floor(left / (sizes.length - k)));
    shares[i] = share; left -= Math.min(sizes[i]!, share);
  });
  return results.map((result, i) => boundedResult(result, shares[i]!, preserve && (value => preserve(value,names?.[i]))));
}

/** Save a result before replacing it with a preview. Count JSON escaping in the actual tool-message string. */
export function boundedResult(value: unknown, bytes: number, preserve?: PreserveResult): any {
  if (resultBytes(value) <= bytes) return value;
  const v: any = value && typeof value === 'object' && String((value as any).file).startsWith('result:') ? value : preserve?.(value);
  if (!v?.file) return { error: 'tool_result_storage_failed', notice: 'The complete result could not be saved. Inspect result storage before querying the source again.' };
  const status = { ...v.fields, ...Object.fromEntries(['file','path','bytes','encoding','expires_at','notice','exit_code','signal','timed_out','error','output_bytes','log_path','running','position','next_position','eof','fields'].filter(k => Object.hasOwn(v,k)).map(k => [k,v[k]])) };
  let head = String(v.head ?? v.content ?? v.output ?? ''), tail = String(v.tail ?? '');
  const make = () => ({ ...status, truncated: true, head, tail });
  while (resultBytes(make()) > bytes && head.length + tail.length) {
    head = head.slice(0, Math.floor(head.length * .75)); tail = tail.slice(Math.max(0, tail.length - Math.floor(tail.length * .75)));
  }
  return make();
}

/** Preserve a complete result before replacing the model-facing body. */
export function withheldResult(name: string, value: any, preserve?: PreserveResult) {
  const result = value?.file ? value : preserve?.(value, name);
  return boundedResult(result ?? { error: 'tool_result_storage_failed' }, 8192, preserve);
}
const elidedResult = (characters: number, content?: string, preserve?: PreserveResult, name?: string) => {
  let value: any; try { value = JSON.parse(content ?? 'null'); } catch { value = content; }
  const reference = value?.file ? value : preserve?.(value, name);
  return JSON.stringify({ elided: true, ...boundedResult(reference ?? { error: 'tool_result_storage_failed' }, 4096, preserve),
    result_characters: characters, detail: 'Read this file with read_tool_result; do not repeat its original operation.' });
};

/** The messages of one tool loop and the folding that keeps its requests within budget. */
export class ToolTranscript {
  private readonly elided = new WeakSet<object>();
  /** fold: the request size above which the oldest tool results are elided; requestLimit stays the hard bound. */
  constructor(readonly messages: any[], readonly fold = requestLimit, readonly preserve?: PreserveResult) {}
  /** Before each request: over the fold size, the oldest tool results the model has already seen are elided first (it can
   * read them again). Results of the latest batch, not seen yet, go only when the request is still over the gateway limit;
   * a request over it even then stops the run instead of failing at the gateway. */
  fit(body: Record<string, any>): void {
    let bytes = requestBytes(body);
    const unseen = this.messages.findLastIndex(message => message.role === 'assistant');
    const elide = (limit: number, last: number) => {
      for (const [index, message] of this.messages.entries()) {
        if (bytes <= limit || index > last) return;
        // A restored session may already carry markers.
        if (message.role !== 'tool' || this.elided.has(message) || typeof message.content !== 'string' || message.content.startsWith('{"elided":true')) continue;
        const before = Buffer.byteLength(JSON.stringify(message.content));
        message.content = elidedResult(message.content.length, message.content, this.preserve, this.messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === message.tool_call_id)?.function?.name); this.elided.add(message);
        bytes -= before - Buffer.byteLength(JSON.stringify(message.content));
      }
    };
    elide(this.fold, unseen); elide(requestLimit, this.messages.length);
    if (bytes > requestLimit) stop('agent_context_too_large', 'failed', 'Agent 请求省略较早的工具结果后仍超过 2 MiB 上限。');
  }
  /** Preserve a result before admitting its bounded preview to the next request. */
  admit(name: string, result: unknown, tools: any[]): string {
    const content = JSON.stringify(boundedResult(result, batchBytes, this.preserve && (value => this.preserve!(value, name)))), base = requestBytes({ tools, messages: this.messages.map(message => message.role === 'tool' && !this.elided.has(message) ? { ...message, content: JSON.stringify({elided:true,file:'result:'+ '0'.repeat(48),head:'',tail:'',notice:'read_tool_result'}) } : message) });
    // The content is a string inside the request, so it is escaped once more there.
    return base + Buffer.byteLength(JSON.stringify(content)) + 64 > requestLimit ? JSON.stringify(withheldResult(name, result, this.preserve)) : content;
  }
}
