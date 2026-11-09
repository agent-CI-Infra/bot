import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AgentSpec, ExternalUsage } from '../agent/runtime.js';
import type { RunContext } from '../roles/protocol.js';
import { TaskError } from '../agent/common.js';

export interface ClaudeProvider { baseUrl: string; credentialFile: string }
interface RequestUsage {
  ref: string; providerId: string | null; started: string; input: number | null; output: number | null;
  complete: boolean; finalOutput: boolean; reason: string;
}
/** Decode only usage from the upstream wire; text, tool arguments and private thinking never enter the ledger. */
class ProviderUsageStream {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = ''; private json = '';
  constructor(private readonly sse: boolean, private readonly update: (v: any) => void) {}
  push(chunk: Uint8Array) {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) { this.json += text; return; }
    this.pending += text;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, match.index); this.pending = this.pending.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') this.update(JSON.parse(data));
    }
    if (Buffer.byteLength(this.pending) > 2 * 1024 * 1024) throw new Error('provider_frame_limit');
  }
  end() { const tail = this.decoder.decode(); if (!this.sse) this.update(JSON.parse(this.json + tail)); else if ((this.pending + tail).trim()) throw new Error('provider_stream_truncated'); }
}
/**
 * The only supported model gateway is in-process: every request checks the current run capability and lease.
 * The provider key stays here. Usage is counted per forwarded HTTP request, not per CLI assistant block.
 */
export async function claudeModelGateway<T>(spec: AgentSpec<T>, provider: ClaudeProvider, ctx: RunContext, signal: AbortSignal,
  timing = { firstByteMs: 120_000, idleMs: 120_000 }) {
  if (!spec.runAccess) throw new TaskError('claude_run_context_required', 'waiting_configuration');
  let key: string;
  try {
    const stat = lstatSync(provider.credentialFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error();
    key = readFileSync(provider.credentialFile, 'utf8').trim(); if (key.length < 16 || /\s/.test(key)) throw new Error();
  } catch { throw new TaskError('claude_provider_credential_unavailable', 'waiting_configuration'); }
  spec.redactor.add(key);
  const abort = new AbortController(), transportSignal = AbortSignal.any([signal, abort.signal]);
  let active = true; const handlers = new Set<symbol>(); let drained: (() => void) | undefined;
  const requests: RequestUsage[] = [];
  const usage = (): ExternalUsage => ({ model_requests: requests.length, input_tokens: requests.reduce((n, r) => n + (r.input ?? 0), 0),
    output_tokens: requests.reduce((n, r) => n + (r.output ?? 0), 0), unknown_requests: requests.filter(r => !r.complete).length,
    semantics: requests.some(r => !r.complete) ? 'lower_bound' : 'exact', cost: 'unknown', accounting_source: 'provider_requests',
    unresolved_requests: requests.filter(r => !r.complete).map(r => ({ request_ref: r.ref, provider_request_id: r.providerId, started_at: r.started, reason: r.reason })),
    reconciliation: 'Match request_ref / provider_request_id and started_at to provider records; retain unknown if no final usage is available. Retryable errors may retry within known cumulative limits.' });
  const publish = () => spec.onExternalUsage?.(usage());
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
  const offered = new Set((spec.tools ?? []).map(t => 'mcp__bot__' + t.function.name)); offered.add('EndConversation');
  const server = createServer(async (req, res) => {
    const handler = Symbol(); handlers.add(handler);
    const deny = (status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: code, message: code } })); };
    const requestAbort = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined, receipt: RequestUsage | undefined;
    const arm = (ms: number) => { if (timeout) clearTimeout(timeout); timeout = setTimeout(() => requestAbort.abort(new Error('provider_timeout')), ms); timeout.unref(); };
    try {
      if (!active || transportSignal.aborted) return deny(401, 'run_token_revoked');
      spec.runAccess?.check(req.headers['x-api-key']); await spec.guard();
      const models = req.method === 'GET' && req.url === '/v1/models', messages = req.method === 'POST' && /^\/v1\/messages(?:\?beta=true)?$/.test(req.url ?? '');
      if (!models && !messages) return deny(403, 'endpoint_not_allowed');
      let body: any;
      if (messages) {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) return deny(413, 'request_too_large'); chunks.push(chunk); }
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return deny(400, 'invalid_request_error'); }
        const model = (spec.harnessPreparation as { config: { model: string } }).config.model;
        if (body.model !== model || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > (spec.maxOutputTokens ?? 8192) || body.mcp_servers !== undefined || body.container !== undefined ||
          !Array.isArray(body.tools) || body.tools.some((t: any) => !offered.has(t?.name) || t.type !== undefined && t.type !== 'custom') ||
          body.tool_choice?.type === 'tool' && !offered.has(body.tool_choice.name)) return deny(403, 'model_or_tools_not_allowed');
      }
      spec.runAccess?.check(req.headers['x-api-key']); await spec.guard();
      const headers: Record<string, string> = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
      const requestId = messages ? randomUUID() : null;
      if (requestId) headers['x-client-request-id'] = requestId;
      if (typeof req.headers['anthropic-beta'] === 'string' && req.headers['anthropic-beta'].length < 4096) headers['anthropic-beta'] = req.headers['anthropic-beta'];
      arm(timing.firstByteMs);
      const pending = fetch(provider.baseUrl.replace(/\/$/, '') + (models ? '/v1/models?limit=1000' : '/v1/messages'), {
        method: models ? 'GET' : 'POST', headers, ...(messages ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.any([transportSignal, requestAbort.signal])
      });
      // A budget callback may interrupt before awaiting headers; observe and abort that transport in finally too.
      void pending.catch(() => {});
      // Nothing is unknown merely because a CLI process started. Only an initiated provider request can incur use.
      if (messages) { receipt = { ref: 'provider_request:' + requestId, providerId: null, started: new Date().toISOString(), input: null, output: null, complete: false, finalOutput: false, reason: 'awaiting_provider_usage' }; requests.push(receipt); publish(); }
      const upstream = await pending;
      arm(timing.idleMs);
      if (receipt) {
        const id = upstream.headers.get('request-id'); if (id && /^[\w.-]{1,160}$/.test(id)) receipt.providerId = id;
        // A completed client/rate-limit rejection did not generate a model response. It is not an unresolved bill.
        if (upstream.status >= 400 && upstream.status < 500) { receipt.input = receipt.output = 0; receipt.complete = true; receipt.reason = 'provider_rejected_request'; }
        publish();
      }
      const parser = receipt && upstream.ok ? new ProviderUsageStream((upstream.headers.get('content-type') ?? '').includes('text/event-stream'), event => {
        const u = event.type === 'message_start' ? event.message?.usage : event.usage;
        let changed = false;
        if (u) {
          if (count(u.input_tokens)) { receipt!.input = Math.max(receipt!.input ?? 0, u.input_tokens + (count(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0) + (count(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0)); changed = true; }
          if (count(u.output_tokens)) { receipt!.output = Math.max(receipt!.output ?? 0, u.output_tokens); if (event.type === 'message_delta' || event.type === 'message') receipt!.finalOutput = true; changed = true; }
        }
        if (event.type === 'message_delta' || event.type === 'message_stop' || event.type === 'message') { receipt!.complete = receipt!.input !== null && receipt!.finalOutput; receipt!.reason = receipt!.complete ? 'final_provider_usage' : 'provider_usage_missing'; changed = true; }
        if (changed) publish();
      }) : null;
      spec.runAccess?.check(req.headers['x-api-key']); await spec.guard();
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      if (models && upstream.ok) { res.setHeader('x-bot-run-id', ctx.run_id); res.setHeader('x-bot-lease-epoch', String(ctx.lease_epoch)); }
      res.writeHead(upstream.status);
      let bytes = 0;
      if (upstream.body) for await (const chunk of Readable.fromWeb(upstream.body as any)) {
        arm(timing.idleMs); bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('response_limit');
        if (transportSignal.aborted) throw transportSignal.reason;
        spec.runAccess?.check(req.headers['x-api-key']); await spec.guard(); parser?.push(chunk);
        if (!res.write(chunk)) await once(res, 'drain', { signal: transportSignal });
      }
      parser?.end(); res.end();
    } catch (error) {
      if (receipt && !receipt.complete) receipt.reason = 'forwarded_without_final_usage';
      if (!res.headersSent) deny(error instanceof TaskError ? 401 : 502, error instanceof TaskError ? 'authentication_error' : 'api_error'); else res.destroy();
    } finally {
      if (timeout) clearTimeout(timeout); requestAbort.abort();
      // Also persists transport failures before any assistant message. Preserve measured lower bounds, never zero them.
      if (receipt) { try { publish(); } catch {} }
      handlers.delete(handler); if (!handlers.size) drained?.();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, usage,
    async close() { active = false; abort.abort(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); if (handlers.size) await new Promise<void>(done => { drained = done; }); } };
}
