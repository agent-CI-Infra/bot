
// Request and tool-result bounds shared by the drivers and the control-plane tools (#333). How many tools the model calls in
// one message is its own choice (one call per repository across ten repositories is normal); what stays bounded is each
// result and each request.

/** The gateway refuses a text-only model request over 2 MiB (model_request_invalid). */
export const requestLimit = 2 * 1024 * 1024;
/** Requests carrying inline image_url data URLs have a separate total ceiling while keeping the 2 MiB text ceiling. */
export const imageRequestLimit = 20 * 1024 * 1024;
export const requestBytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body));
export const isInlineImagePart = (part: unknown): boolean =>
  !!part && typeof part === 'object' && (part as any).type === 'image_url' && typeof (part as any).image_url?.url === 'string' && (part as any).image_url.url.startsWith('data:image/');
export function hasImageContent(body: unknown): boolean {
  const messages = (body as any)?.messages;
  return Array.isArray(messages) && messages.some((message: any) => Array.isArray(message?.content) && message.content.some(isInlineImagePart));
}
/** Serialized byte size excluding inline image_url base64 payloads so images never crowd out text context budgets. */
export function textRequestBytes(body: unknown): number {
  if (!body || typeof body !== 'object') return requestBytes(body);
  const messages = (body as any).messages;
  if (!Array.isArray(messages) || !hasImageContent(body)) return requestBytes(body);
  const stripped = messages.map((message: any) => !Array.isArray(message?.content) || !message.content.some(isInlineImagePart)
    ? message
    : { ...message, content: message.content.map((part: any) => isInlineImagePart(part) ? { type: 'image_url', image_url: { url: '[image]' } } : part) });
  return requestBytes({ ...(body as Record<string, any>), messages: stripped });
}
/** Every built-in loop reserves the same final turns for a bounded submission. */
export const finalizationReserve = (maxTurns: number) => Math.min(8, Math.max(2, Math.ceil(maxTurns / 4)));
/** Messages merged into a running service assistant turn take at most about 100k tokens of JSON, within the window the
 * project assumes for Pi (128k). */
export const chatContextBytes = 384 * 1024;
/** One tool result's budget: a single large result without paging (a project's effective configuration is about 240 KB)
 * still fits whole; anything larger is saved as a result file with a preview. */
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
