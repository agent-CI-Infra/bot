import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, lstatSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { AgentSpec } from '../agent/runtime.js';
import type { RunContext } from '../roles/protocol.js';
import { TaskError } from '../agent/common.js';

export interface ClaudeProvider { baseUrl: string; credentialFile: string }
/**
 * A run-local Anthropic gateway. The provider service key stays in the control plane; the CLI receives only the opaque
 * RoleRun capability. This is a transport for the real CLI, not an alternative model execution loop.
 */
export async function claudeModelGateway<T>(spec: AgentSpec<T>, provider: ClaudeProvider, ctx: RunContext, signal: AbortSignal) {
  if (!spec.runAccess) throw new TaskError('claude_run_context_required', 'waiting_configuration');
  let key: string;
  try {
    const stat = lstatSync(provider.credentialFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error();
    key = readFileSync(provider.credentialFile, 'utf8').trim(); if (key.length < 16 || /\s/.test(key)) throw new Error();
  } catch { throw new TaskError('claude_provider_credential_unavailable', 'waiting_configuration'); }
  spec.redactor.add(key);
  const abort = new AbortController(), transportSignal = AbortSignal.any([signal, abort.signal]);
  let active = true;
  const offered = new Set((spec.tools ?? []).map(t => 'mcp__bot__' + t.function.name));
  offered.add('EndConversation');
  const server = createServer(async (req, res) => {
    const deny = (status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: code, message: code } })); };
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
      // Recheck after reading a queued body. An in-flight request is aborted when the run ends or loses its lease.
      spec.runAccess?.check(req.headers['x-api-key']); await spec.guard();
      const headers: Record<string, string> = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
      if (typeof req.headers['anthropic-beta'] === 'string' && req.headers['anthropic-beta'].length < 4096) headers['anthropic-beta'] = req.headers['anthropic-beta'];
      const upstream = await fetch(provider.baseUrl.replace(/\/$/, '') + (models ? '/v1/models?limit=1000' : '/v1/messages'), {
        method: models ? 'GET' : 'POST', headers, ...(messages ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.any([transportSignal, AbortSignal.timeout(120_000)])
      });
      spec.runAccess?.check(req.headers['x-api-key']); await spec.guard();
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      if (models && upstream.ok) { res.setHeader('x-bot-run-id', ctx.run_id); res.setHeader('x-bot-lease-epoch', String(ctx.lease_epoch)); }
      res.writeHead(upstream.status);
      let bytes = 0;
      if (upstream.body) for await (const chunk of Readable.fromWeb(upstream.body as any)) {
        bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('response_limit');
        if (transportSignal.aborted) throw transportSignal.reason;
        spec.runAccess?.check(req.headers['x-api-key']); await spec.guard();
        if (!res.write(chunk)) await once(res, 'drain', { signal: transportSignal });
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) deny(error instanceof TaskError ? 401 : 502, error instanceof TaskError ? 'authentication_error' : 'api_error');
      else res.destroy();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, async close() { active = false; abort.abort(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
