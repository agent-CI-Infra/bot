import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomId } from '../core/security.js';
import { stop, TaskError, type Redactor } from '../agent/common.js';
import type { AgentSpec } from '../agent/runtime.js';
import { traceEvent } from '../tasks/trace.js';

export interface TaskToolCallInput {
  id: string;
  name: string;
  arguments: Record<string, any>;
  transport: 'http' | 'mailbox';
}

export interface TaskToolDispatcherOptions {
  maxRepairs?: number;
  includeSubmissionDetails?: boolean;
  skipScreen?: boolean;
}

export interface TaskToolDispatcher<T> {
  readonly token: string;
  readonly active: boolean;
  readonly submitted: boolean;
  readonly result: T | undefined;
  checkToken(presented: unknown): void;
  call(presented: unknown, input: TaskToolCallInput): Promise<{ observation: any; isError: boolean; submitted: boolean }>;
  rpc(presented: unknown, request: any, transport?: 'http' | 'mailbox'): Promise<any>;
  halt(): void;
  close(): Promise<void>;
}

/**
 * Transport-agnostic platform tool handler shared by HTTP (`taskToolServer`) and container mailbox transports.
 * Enforces offered-tool allowlists, run token & lease verification, live project enabled checks, single-submission
 * semantics (while allowing non-submission tools to run in parallel), and linked trajectory recording.
 */
export function createTaskToolDispatcher<T>(spec: AgentSpec<T>, options: TaskToolDispatcherOptions = {}): TaskToolDispatcher<T> {
  const fallbackToken = randomId();
  const currentToken = () => spec.runAccess?.token ?? fallbackToken;
  let submitted = false, result: T | undefined, active = true, repairs = 0;
  let submissionInFlight: Promise<void> | null = null;
  const inFlight = new Set<Promise<unknown>>(), nonFinishInFlight = new Set<Promise<unknown>>();

  const deny = (tool: string | null, reason: string) => {
    if (spec.onDenied) spec.onDenied(tool ?? '', reason);
    else if (spec.task?.id) traceEvent(spec.store, String(spec.task.id), 'capability_denied', { tool, reason }, spec.task.trace_run_id, 'framework');
  };

  const assertProjectEnabled = (tool: string | null = null) => {
    const policy = spec.task?.repository_id ? spec.store.get('SELECT enabled FROM policies WHERE repository_id=?', spec.task.repository_id) : undefined;
    if (policy && !policy.enabled) {
      deny(tool, 'repository_policy_disabled');
      stop('repository_policy_disabled', 'cancelled', '项目已停用，平台工具调用已被拒绝。');
    }
  };

  const checkToken = (presented: unknown) => {
    if (typeof presented !== 'string' || !presented || presented !== currentToken()) throw new TaskError('run_token_invalid', 'failed');
    spec.runAccess?.check(presented);
  };

  const isFinishTool = (name: string) => !!spec.finish && (spec.finish.names ?? [spec.finish.name]).includes(name);

  const track = <V>(work: Promise<V>): Promise<V> => {
    inFlight.add(work);
    return work.finally(() => { inFlight.delete(work); });
  };

  const call = (presented: unknown, input: TaskToolCallInput) => {
    const name = String(input.name ?? ''), finishCall = isFinishTool(name);
    return track((async () => {
      if (!active) throw new TaskError('harness_run_closed', 'cancelled');
      try { checkToken(presented); }
      catch (error) {
        const code = String((error as any)?.code ?? 'run_token_invalid');
        deny(name || null, code);
        throw error instanceof TaskError ? error : new TaskError(code, 'failed');
      }
      await spec.guard();
      assertProjectEnabled(name || null);
      if (!active) throw new TaskError('harness_run_closed', 'cancelled');
      checkToken(presented);

      const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments) ? input.arguments : {};
      const offered = (spec.tools ?? []).some(t => t.function.name === name);
      if (!offered) {
        deny(name, 'not_offered');
        return { observation: { error: 'tool_not_allowed' }, isError: true, submitted: false };
      }

      while (submissionInFlight !== null) await submissionInFlight;
      if (!active) throw new TaskError('harness_run_closed', 'cancelled');
      checkToken(presented);
      assertProjectEnabled(name);
      if (submitted) return { observation: { error: 'execution_already_submitted' }, isError: true, submitted: false };

      if (finishCall) {
        let releaseSubmission!: () => void;
        submissionInFlight = new Promise<void>(resolve => { releaseSubmission = resolve; });
        try {
          if (nonFinishInFlight.size) {
            await Promise.allSettled([...nonFinishInFlight]);
            await spec.guard();
            assertProjectEnabled(name);
            if (!active) throw new TaskError('harness_run_closed', 'cancelled');
            checkToken(presented);
          }
          if (!options.skipScreen) spec.screen?.(name, args);
          const started = traceEvent(spec.store, String(spec.task.id), 'tool_started', {
            name,
            call_id: String(input.id),
            arguments: spec.redactor.clean(args),
            transport: input.transport === 'http' ? 'mcp' : 'mailbox'
          }, spec.task.trace_run_id, 'harness');
          let observation: any, didSubmit = false;
          try {
            const validated = await spec.finish!.validate(args, name);
            await spec.guard();
            assertProjectEnabled(name);
            checkToken(presented);
            if (!active) throw new TaskError('harness_run_closed', 'cancelled');
            result = validated;
            submitted = true;
            didSubmit = true;
            observation = options.includeSubmissionDetails ? { submitted: true, submission: args, submission_name: name } : { submitted: true };
          } catch (error) {
            const feedback = spec.repairInvalid?.(error);
            if (!feedback || (options.maxRepairs !== undefined && repairs++ >= options.maxRepairs)) throw error;
            observation = { error: 'invalid_submission', message: spec.redactor.text(feedback) };
          }
          const clean = spec.redactor.clean(observation ?? null);
          traceEvent(spec.store, String(spec.task.id), 'tool_observation', { name, call_id: String(input.id), observation: clean }, spec.task.trace_run_id, 'tool', [started]);
          return { observation: clean, isError: !!(clean && typeof clean === 'object' && 'error' in clean && clean.error), submitted: didSubmit };
        } finally {
          submissionInFlight = null;
          releaseSubmission();
        }
      }

      const work = (async () => {
        if (!options.skipScreen) spec.screen?.(name, args);
        const started = traceEvent(spec.store, String(spec.task.id), 'tool_started', {
          name,
          call_id: String(input.id),
          arguments: spec.redactor.clean(args),
          transport: input.transport === 'http' ? 'mcp' : 'mailbox'
        }, spec.task.trace_run_id, 'harness');
        let observation: any;
        try {
          observation = spec.execute ? await spec.execute(name, args) : { error: 'tool_not_allowed' };
        } catch (error) {
          const feedback = spec.repairInvalid?.(error);
          if (!feedback || (options.maxRepairs !== undefined && repairs++ >= options.maxRepairs)) throw error;
          observation = { error: 'invalid_submission', message: spec.redactor.text(feedback) };
        }
        const clean = spec.redactor.clean(observation ?? null);
        traceEvent(spec.store, String(spec.task.id), 'tool_observation', { name, call_id: String(input.id), observation: clean }, spec.task.trace_run_id, 'tool', [started]);
        return { observation: clean, isError: !!(clean && typeof clean === 'object' && 'error' in clean && clean.error), submitted: false };
      })();
      nonFinishInFlight.add(work);
      return work.finally(() => { nonFinishInFlight.delete(work); });
    })());
  };

  const rpc = async (presented: unknown, request: any, transport: 'http' | 'mailbox' = 'http') => {
    if (!active) throw new TaskError('harness_run_closed', 'cancelled');
    checkToken(presented);
    assertProjectEnabled(request?.params?.name ? String(request.params.name) : null);
    const { id, method, params } = request ?? {};
    if (id === undefined) return null;
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bot', version: '1' } } };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: (spec.tools ?? []).map(t => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })) } };
    }
    if (method === 'tools/call') {
      const out = await call(presented, { id: String(id), name: String(params?.name ?? ''), arguments: params?.arguments ?? {}, transport });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out.observation) }], isError: out.isError } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_found' } };
  };

  return {
    get token() { return currentToken(); },
    get active() { return active; },
    get submitted() { return submitted; },
    get result() { return result; },
    checkToken,
    call,
    rpc,
    halt() { active = false; },
    async close() { active = false; if (inFlight.size) await Promise.allSettled([...inFlight]); }
  };
}

export const abandonedToolReply = (sent: { error?: string; detail?: string } | null | undefined) =>
  sent?.error === 'agent_request_changed' || (sent?.error === 'runner_operation_failed' && sent?.detail === 'workspace_agent_tool: agent_request_changed');

export async function deliverMailboxToolReply(
  value: unknown,
  requestId: string,
  sendChunk: (chunk: { type: 'workspace_agent_tool'; request_id: string; base64: string; offset: number; final: boolean }) => Promise<{ error?: string; detail?: string }>,
  failureDetail = '发送工具结果时中断。'
): Promise<boolean> {
  const bytes = Buffer.from(JSON.stringify(value ?? null));
  for (let at = 0; at < bytes.length || at === 0; at += 30000) {
    const part = bytes.subarray(at, at + 30000);
    const sent = await sendChunk({ type: 'workspace_agent_tool', request_id: requestId, base64: part.toString('base64'), offset: at, final: at + 30000 >= bytes.length });
    if (abandonedToolReply(sent)) return false;
    if (sent?.error) stop('execution_interrupted', 'waiting_environment', failureDetail);
    if (bytes.length === 0) break;
  }
  return true;
}

export async function handleMailboxToolRequest<T>(
  dispatcher: TaskToolDispatcher<T>,
  redactor: Redactor,
  request: { id: string; name: string; arguments?: any; token?: unknown },
  sendChunk: (chunk: { type: 'workspace_agent_tool'; request_id: string; base64: string; offset: number; final: boolean }) => Promise<{ error?: string; detail?: string }>
): Promise<{ delivered: boolean; observation: any; submitted: boolean }> {
  if (typeof request?.id !== 'string' || !/^[a-f0-9]{48}$/.test(request.id)) stop('model_request_invalid');
  try {
    const out = await dispatcher.call(request.token, { id: request.id, name: String(request.name ?? ''), arguments: request.arguments ?? {}, transport: 'mailbox' });
    const delivered = await deliverMailboxToolReply(redactor.clean(out.observation), request.id, sendChunk);
    return { delivered, observation: out.observation, submitted: out.submitted };
  } catch (error) {
    const code = String((error as any)?.code ?? '');
    if (/^(?:run_token_|lease_epoch_stale$)/.test(code)) {
      const observation = { error: code };
      const delivered = await deliverMailboxToolReply(observation, request.id, sendChunk).catch(() => false);
      if (request.token === dispatcher.token) throw error;
      return { delivered, observation, submitted: false };
    }
    throw error;
  }
}

/**
 * Run-local loopback HTTP MCP bridge over `createTaskToolDispatcher`.
 * Only a loopback endpoint is given to the external agent, never model or GitHub credentials.
 */
export async function taskToolServer<T>(spec: AgentSpec<T>) {
  const dispatcher = createTaskToolDispatcher(spec);
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/' + dispatcher.token || !dispatcher.active) { res.writeHead(404); res.end('{}'); return; }
    try { dispatcher.checkToken(dispatcher.token); }
    catch (error) { res.writeHead(401); res.end(JSON.stringify({ error: (error as any).code ?? 'run_token_invalid' })); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end('{}'); return; }
    let requestId: unknown = null;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('mcp_input_too_large'); chunks.push(chunk); }
      const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      requestId = request?.id ?? null;
      const reply = await dispatcher.rpc(dispatcher.token, request, 'http');
      if (reply === null) { res.writeHead(202); res.end(); return; }
      res.end(JSON.stringify(reply));
    } catch (error) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code: -32603, message: spec.redactor.text(String((error as any).code ?? 'task_tool_error')) } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/${dispatcher.token}`,
    get submitted() { return dispatcher.submitted; },
    get result() { return dispatcher.result as T; },
    halt() { dispatcher.halt(); },
    async close() {
      dispatcher.halt();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await dispatcher.close();
    }
  };
}
