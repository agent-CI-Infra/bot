import { modelEndpoints } from '../agent/model.js';
import { type Json } from '../core/security.js';

// Listing and testing call the upstream from the management page, so they end within this time instead of holding it.
const timeout = 15_000, listLimit = 200, testOutputTokens = 32;
const bodyLimit = { list: 8 * 1024 * 1024, test: 1024 * 1024 };
export const testPrompt = 'Reply with the single word ok.';

// The key must never come back, whatever the upstream echoes: every string of a result is scrubbed, a short key included.
function scrub<T>(value: T, key: string): T {
  if (typeof value === 'string') return (key ? value.split(key).join('[REDACTED]') : value) as T;
  if (Array.isArray(value)) return value.map(item => scrub(item, key)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, key)])) as T;
  return value;
}
const short = (value: string, limit = 300) => { const text = value.replace(/\s+/g, ' ').trim(); return text.length > limit ? text.slice(0, limit) + '…' : text; };
// The upstream's own short explanation: an OpenAI-style error.message, a plain error/message/detail string, or a page title.
function explanation(raw: string): string | null {
  try {
    const value = JSON.parse(raw), error = value?.error;
    const found = [error?.message, error, value?.message, value?.detail, value?.msg].find(item => typeof item === 'string' && item.trim());
    if (found) return short(found);
  } catch { /* Not JSON: fall back to the text itself. */ }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1];
  if (title?.trim()) return short(title);
  return raw.trim() && !raw.trimStart().startsWith('<') ? short(raw) : null;
}
// Reads at most `limit` bytes, so an endless or huge body is reported rather than buffered.
async function read(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
type Reply = { ok: true; status: number; raw: string; json: any } | { ok: false; failure: Json };
// One upstream request. Failures carry the HTTP status (null when no response arrived), a stable code and a short message.
async function send(url: string, key: string, init: RequestInit, limit: number): Promise<Reply> {
  const failure = (status: number | null, error: string, message: string | null = null): Reply => ({ ok: false, failure: { ok: false, status, error, message } });
  const transport = (error: unknown) => (error as Error)?.name === 'TimeoutError' ? failure(null, 'upstream_timeout')
    : failure(null, 'upstream_unreachable', typeof (error as any)?.cause?.code === 'string' ? (error as any).cause.code : null);
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', ...init.headers as Record<string, string> } }); }
  catch (error) { return transport(error); }
  // A redirect usually means the address is not the final one; say where it points instead of following it with the key.
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); return failure(response.status, 'upstream_redirect', short(response.headers.get('location') || '', 300) || null); }
  let raw: string | null;
  try { raw = await read(response, limit); } catch (error) { return transport(error); }
  if (raw === null) return failure(response.status, 'upstream_response_too_large');
  if (!response.ok) return failure(response.status, 'upstream_http_error', explanation(raw));
  let json: any; try { json = JSON.parse(raw); } catch { return failure(response.status, 'upstream_response_invalid', explanation(raw)); }
  return { ok: true, status: response.status, raw, json };
}

// GET <base>/models with the given key. Returns at most listLimit ids, sorted, and says when the upstream had more.
export async function listUpstreamModels(apiUrl: string, key: string): Promise<Json> {
  const { models_url } = modelEndpoints(apiUrl), reply = await send(models_url, key, { method: 'GET' }, bodyLimit.list);
  if (!reply.ok) return scrub({ models_url, ...reply.failure }, key);
  // OpenAI-compatible servers answer {data:[{id}]}; a few answer {models:[...]} or a bare array, with ids or names.
  const items = [reply.json?.data, reply.json?.models, reply.json].find(Array.isArray);
  if (!items) return scrub({ models_url, ok: false, status: reply.status, error: 'upstream_response_invalid', message: explanation(reply.raw) }, key);
  const ids = [...new Set(items.map((item: any) => typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : item?.name)
    .filter((id: unknown): id is string => typeof id === 'string' && !!id.trim() && id.length <= 256))].sort();
  return scrub({ models_url, ok: true, status: reply.status, total: ids.length, truncated: ids.length > listLimit, models: ids.slice(0, listLimit) }, key);
}

// One minimal Chat Completions request: a fixed prompt without project data and a single small output limit.
export async function testUpstreamModel(apiUrl: string, key: string, model: string): Promise<Json> {
  const { chat_url } = modelEndpoints(apiUrl), started = Date.now();
  const body = { model, messages: [{ role: 'user', content: testPrompt }], max_completion_tokens: testOutputTokens, stream: false };
  const reply = await send(chat_url, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, bodyLimit.test);
  if (!reply.ok) return scrub({ chat_url, ...reply.failure }, key);
  const choice = reply.json?.choices?.[0];
  if (!choice) return scrub({ chat_url, ok: false, status: reply.status, error: 'upstream_response_invalid', message: explanation(reply.raw) }, key);
  const content = choice.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('') : '';
  return scrub({ chat_url, ok: true, status: reply.status, model: typeof reply.json.model === 'string' ? short(reply.json.model, 200) : null,
    reply: short(text, 200), finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null, elapsed_ms: Date.now() - started }, key);
}
