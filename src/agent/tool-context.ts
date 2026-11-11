import { stop } from './common.js';

// Shared by every control-plane tool loop: the default runTools loop, the management assistant, group service roles and
// their own tasks (#333). How many tools the model calls in one message is its own choice (one call per repository across
// ten repositories is normal); what stays bounded is the request each loop sends next.

/** The gateway refuses a model request over 2 MiB (model_request_invalid). */
export const requestLimit = 2 * 1024 * 1024;
export const requestBytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body));
/** Chat assistants answer inside a model's context window, which is usually far below 2 MiB: older tool results are folded
 * once a request passes about 100k tokens of JSON, the window the project already assumes for Pi (128k). */
export const chatContextBytes = 384 * 1024;
/** One batch of tool results shares one budget, so a call per repository cannot flood the context, while a single large
 * result without paging (a project's effective configuration is about 240 KB) still fits whole. */
export const batchBytes = 256 * 1024;
const minShare = 8 * 1024;

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

/** Bounds every result of one batch within the batch budget: results under an equal share stay whole and leave the rest
 * to the larger ones, which share it equally (every result keeps at least minShare). */
export function boundedBatch(results: unknown[], budget = batchBytes): unknown[] {
  const sizes = results.map(result => Buffer.byteLength(JSON.stringify(result) ?? 'null')), shares: number[] = [];
  let left = budget;
  sizes.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]!).forEach((i, k) => {
    const share = Math.max(minShare, Math.floor(left / (sizes.length - k)));
    shares[i] = share; left -= Math.min(sizes[i]!, share);
  });
  return results.map((result, i) => boundedResult(result, shares[i]!));
}

/** A result over its share is cut, with what the model needs to read the rest in parts. Small top-level fields (revision,
 * next_offset, ids, states) stay whole because the next step usually needs them. The cut is measured as it is sent: the
 * JSON text becomes a string inside the tool message, so its quotes are escaped once more. */
export function boundedResult(value: unknown, bytes: number): unknown {
  const json = JSON.stringify(value) ?? 'null', size = Buffer.byteLength(json), sent = (text: string) => Buffer.byteLength(JSON.stringify(text));
  if (size <= bytes) return value;
  const fields = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v === null || typeof v !== 'object' && Buffer.byteLength(JSON.stringify(v) ?? '') <= 256)) : {};
  const room = Math.max(1024, bytes - Buffer.byteLength(JSON.stringify(fields)));
  let content = json.slice(0, room);
  for (let over = sent(content); over > room; over = sent(content)) content = content.slice(0, Math.floor(content.length * room / over) - 1);
  return { truncated: true, result_bytes: size, notice: 'This result exceeds its share of the context and was cut. Narrow it (a smaller limit, page, path or section) to read the rest.',
    ...(Object.keys(fields).length ? { fields } : {}), content };
}

/** What the model gets instead of a result that cannot fit any request. A command has already run, so its status stays. */
export function withheldResult(name: string, value: any) {
  const status = name === 'run_command' && value && typeof value === 'object' ? Object.fromEntries(['exit_code', 'signal', 'timed_out', 'truncated'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : {};
  return { error: 'tool_result_too_large', ...status, result_characters: JSON.stringify(value)?.length ?? 0, detail: name === 'run_command'
    ? 'The command ran, but its output alone exceeds the model request limit and was not returned. Do not print it again in full: pipe it through head, tail, grep or wc, or redirect it to a file and read only the parts you need.'
    : 'This result alone exceeds the model request limit and was not returned. Read a smaller part instead, for example one file at a time or a line range.' };
}
const elidedResult = (characters: number) => JSON.stringify({ elided: true, result_characters: characters, detail: 'This earlier tool result was removed to keep the request within the model limit. Run or read it again, narrowed, if you still need it.' });

/** The messages of one tool loop and the folding that keeps its requests within budget. */
export class ToolTranscript {
  private readonly elided = new WeakSet<object>();
  /** fold: the request size above which the oldest tool results are elided; requestLimit stays the hard bound. */
  constructor(readonly messages: any[], readonly fold = requestLimit) {}
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
        message.content = elidedResult(message.content.length); this.elided.add(message);
        bytes -= before - Buffer.byteLength(JSON.stringify(message.content));
      }
    };
    elide(this.fold, unseen); elide(requestLimit, this.messages.length);
    if (bytes > requestLimit) stop('agent_context_too_large', 'failed', 'Agent 请求省略较早的工具结果后仍超过 2 MiB 上限。');
  }
  /** A result that would not fit even with every earlier tool result elided never enters the conversation: the model gets
   * tool_result_too_large and reads a smaller part, instead of the next request failing the run. */
  admit(name: string, result: unknown, tools: any[]): string {
    const content = JSON.stringify(result), base = requestBytes({ tools, messages: this.messages.map(message => message.role === 'tool' && !this.elided.has(message) ? { ...message, content: elidedResult(0) } : message) });
    // The content is a string inside the request, so it is escaped once more there.
    return base + Buffer.byteLength(JSON.stringify(content)) + 64 > requestLimit ? JSON.stringify(withheldResult(name, result)) : content;
  }
}
