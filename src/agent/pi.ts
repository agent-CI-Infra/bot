import { ResultSession, projectResultOwner, resultScope, commandResult } from './tool-results.js';
import { randomId } from '../core/security.js';
import { stop, TaskError, type Redactor } from './common.js';
import type { AgentServices, AgentSpec, ToolImageBlock } from './runtime.js';
import type { Workspace } from './workspace.js';
import type { AgentModel } from './gateway.js';
import type { Row, Store } from '../storage/database.js';
import { finalizationReserve, hasImageContent, imageRequestLimit, requestLimit, textRequestBytes } from './tool-context.js';
import { deliverMailboxToolReply } from '../roles/task-tools.js';
import { sshAccess } from '../projects/ssh-access.js';
import { registerModelGatewaySession } from '../harness/model-gateway.js';
import type { ModelInterfaceType } from '../models/catalog.js';
import { consumePendingTaskUpdates } from '../review/bot-pr-wake.js';
import { RUNNER_TRANSFER_CHUNK_BYTES } from '../../runner/command-policy.mjs';

/** The Pi SDK the project computer image installs (runner/package.json). scripts/check-runtime.mjs keeps the two equal. */
export const piRuntime = { agent: 'pi', package: '@earendil-works/pi-coding-agent', version: '1.4.0' } as const;
/**
 * How long the runner may hold a poll of a Pi session (#1277). runner/agent.mjs (agentPollWaitLimit) and
 * manager/project-runner-calls.mjs allow the same 3 s; their tests pin the three together.
 */
const pollWait = 3000;

/**
 * A review's conversation with its Pi session. The session itself lives in Pi's session files (#1040); the control plane
 * answers its boundaries: the start prompt (given how the session began: `recovery` is native_resume when it holds the
 * earlier round), and the updates between turns. resume continues the session still waiting in this workspace.
 */
export interface PiConversation { resume?: boolean; offset?: number; model?: AgentModel; boundary(stage: string, recovery?: string): Promise<{prompt?: string, messages?: string[]}> }
/**
 * A service assistant's turn (#1253): the control plane's side of the conversation around each model request.
 * `steer` gives the messages to send after the prompt, read just before the session starts; `boundary` answers each turn
 * boundary between tool batches with more of them. `text` hears the answer as it is written (tapped directly from the
 * control-plane passthrough gateway stream), `responded` each model response ending, with or without tool calls, and
 * `retry` each retry Pi makes itself.
 */
export interface PiServiceTurn {
  steer(): string[];
  boundary(): Promise<{ messages?: string[] }>;
  text(delta: string): Promise<void>;
  responded(toolCalls: boolean): void;
  retry(retry: { retry: number; retries: number; delay_ms: number; error: string }): Promise<void>;
}
/**
 * One Pi session in a task workspace, driven through the runner mailbox for lifecycle/tools and the control-plane
 * passthrough model gateway for model requests. Credentials stay inside the control plane.
 */
export interface PiSession<T> {
  store: Store;
  results?: ResultSession;
  taskId: string;
  /** Live task/service-turn context (service_role_id, conversation_id, consolidation_scope, trace_run_id, ...). */
  task?: Row;
  /** The task lifecycle guard, checked before every mailbox exchange and model request. */
  guard: () => Promise<void>;
  /** Shared budget gate before billable model requests. */
  beforeModel?: () => Promise<void>;
  /** Run capability token & live verifier when invoked via RoleRun. */
  runAccess?: AgentSpec<any>['runAccess'];
  leaseEpoch?: number;
  /** The runner mailbox of one task workspace; only call, deliver and log are used. */
  workspace: Pick<Workspace, 'call' | 'deliver' | 'log'>;
  redactor: Redactor;
  /** The runner input (system, prompt, tools, capabilities, finish_tools, control_tools, ...). */
  config: Record<string, any>;
  conversation?: PiConversation;
  /** Whether a tool was offered to this session; platform writes and repository reads check it again here. */
  offered: (name: string) => boolean;
  platform?: Record<string, (id: string, args: any) => Promise<any>>;
  /** Repository exploration through the control plane (github_read, github_search, read_job_log). */
  repository?: (name: string, args: any) => Promise<any>;
  /** The answer to github_read_token or container git/gh credential helpers: a short-lived read token, or the reason there is none. */
  token?: (request?: { purpose?: 'git' | 'gh'; repository?: string; token?: unknown }) => Promise<any>;
  createPullRequest?: (id: string, args: any) => Promise<any>;
  /** capabilities.github.publication: only 'pull_request' may answer create_pull_request. */
  publication?: string;
  /** Binds the task's worktree when a file tool or command of the session finds none (#769): the choice made, or the system's. */
  ensureWorkspace?: () => Promise<{ error?: string; message?: string } & Record<string, unknown>>;
  /** Control-plane tools named in config.control_tools. The runner waits for them without a deadline. */
  control?: (name: string, args: any, meta?: { id: string; token?: unknown }) => Promise<{ result: any; finish?: boolean; images?: ToolImageBlock[] }>;
  /** The session ended: turn the runner's final state, and a publication answered during it, into the run result. */
  complete: (state: any, publication: any) => T | Promise<T>;
  /** Reattach to the session already living in this workspace (native resume) instead of starting one. */
  resume?: boolean;
  /** Prefix of this session's runner operation keys; distinct sessions of one task attempt need distinct prefixes. */
  key?: string;
  /** At most this many model requests (a role budget). Pi itself has no turn limit. */
  maxRequests?: number;
  /** Tools retained in the reserved final requests; the control mailbox enforces the same restriction. */
  finalizationTools?: string[];
  finalizationMessage?: string;
  /** Sees each model message before it is relayed, for example to record a denied tool call. */
  inspect?: (message: any) => void;
  /** A safe checkpoint: Pi waits for a model reply, so every tool result is already in its history. */
  checkpoint?: () => Promise<void>;
  /** Check the runner's actual Pi runtime against the pinned harness version before the session starts. */
  runtime?: { version: string; report: (runtime: any) => void };
  /** The managed session's cancellation: an abort ends the control plane's wait with harness_cancelled. */
  signal?: AbortSignal;
  /** Runs the session as one service assistant turn (#1253). */
  service?: PiServiceTurn;
  /** The SSH context (#1379): role, whether the checkout was trusted at the start, and how long the run lives (the run
   * token when absent). */
  ssh?: { role: string; trusted: boolean; live?: () => boolean };
}

function toolNameOf(tool: any): string {
  if (!tool || typeof tool !== 'object') return '';
  if (typeof tool.name === 'string') return tool.name;
  if (tool.function && typeof tool.function.name === 'string') return tool.function.name;
  return '';
}

function appendUserMessageNative(format: ModelInterfaceType, body: Record<string, any>, text: string) {
  if (format === 'openai-responses') {
    if (!Array.isArray(body.input)) body.input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : [];
    body.input.push({ role: 'user', content: [{ type: 'input_text', text }] });
    return;
  }
  if (!Array.isArray(body.messages)) body.messages = [];
  body.messages.push({ role: 'user', content: text });
}

function forceToolChoiceNative(format: ModelInterfaceType, body: Record<string, any>, names: string[]) {
  if (format === 'anthropic-messages') {
    body.tool_choice = names.length === 1 ? { type: 'tool', name: names[0] } : { type: 'any' };
  } else if (format === 'openai-responses') {
    body.tool_choice = names.length === 1 ? { type: 'function', name: names[0] } : 'required';
  } else {
    body.tool_choice = names.length === 1 ? { type: 'function', function: { name: names[0] } } : 'required';
  }
}

export function piAdapter<T>(session: PiSession<T>) {
  const { store, taskId, guard, workspace, redactor, config, conversation, signal, service } = session, key = session.key ?? 'pi';
  const task = session.task ?? store.get('SELECT * FROM tasks WHERE id=?', taskId) ?? { id: taskId };
  const resultFiles = session.results ?? new ResultSession(store, resultScope(store, task), () => projectResultOwner(task.repository_id), guard, redactor.values, () => true);
  // Every wait of the control plane ends as soon as the session is cancelled. A cancelled session is never reported as a
  // resumable interruption: the caller releases its workspace, and the next run starts from task records.
  const cancelled = () => signal?.reason ?? new TaskError('harness_cancelled', 'cancelled');
  const abortable = <V>(work: Promise<V>): Promise<V> => !signal ? work : signal.aborted ? Promise.reject(cancelled()) : new Promise<V>((resolve, reject) => {
    const abort = () => reject(cancelled()); signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  const deliver = (fallbackKey: string, request: any) => typeof (workspace as any).deliver === 'function'
    ? workspace.deliver(request)
    : workspace.call(fallbackKey, request);
  const pause = (ms: number) => abortable(new Promise(resolve => setTimeout(resolve, ms)));
  return async ({ model, outputTokens }: AgentServices): Promise<T> => {
    redactor.add(model.key);
    config.model = model.capabilities
      ? { context_window: model.capabilities.context_window, max_output_tokens: model.capabilities.max_output_tokens, reasoning: model.capabilities.reasoning, image_input: model.capabilities.image_input !== false }
      : { context_window: 128000, max_output_tokens: 8192, reasoning: false, image_input: true };
    config.model_name = model.model;
    config.model_interface_type = model.protocol?.interface_type ?? 'openai-chat-completions';
    config.output_tokens = outputTokens ?? config.model.max_output_tokens;
    const finishingNames = new Set(session.finalizationTools ?? config.finish_tools ?? []);
    if (session.maxRequests !== undefined && finishingNames.size && session.maxRequests <= finalizationReserve(session.maxRequests)) {
      stop('role_budget_exhausted', 'waiting_configuration', '剩余请求不足以保留至少一轮工作和收尾，Pi 会话尚未启动。');
    }
    // Revising an unpublished result continues this execution; later tasks choose a fresh model.
    if (conversation) conversation.model = model;
    const checkRuntime = (runtime: any) => {
      if (runtime.error === 'runner_operation_failed') stop('execution_interrupted', 'waiting_environment', '查询 Pi 运行时信息时中断。');
      if (runtime.error || runtime.agent !== 'pi') stop('pi_runtime_unavailable', 'waiting_environment', '项目电脑的 runner 不支持 Pi 运行时查询，请升级项目电脑镜像。');
      session.runtime!.report(runtime);
      if (runtime.version !== session.runtime!.version) stop('harness_version_mismatch', 'waiting_configuration', `项目电脑的 Pi 版本是 ${runtime.version}，角色配置固定的是 ${session.runtime!.version}；不会换用其他版本。`);
    };

    const runToken = typeof config.run_token === 'string' && config.run_token
      ? config.run_token
      : session.runAccess?.token || ('pi_gw_' + randomId());
    redactor.add(runToken);
    delete config.run_token;
    const runAccess = session.runAccess ?? {
      token: runToken,
      check: (presented: unknown) => {
        if (presented !== runToken) stop('run_token_invalid', 'failed');
      },
    };

    let offset = conversation?.offset || 0, publication: any, requests = 0, finalizing = false;
    const answered = new Set<string>(), inFlight = new Map<string, Promise<void>>();
    let backgroundError: unknown = null, wakePoll: (() => void) | null = null, wakePending = false, pollFailed: ((error: unknown) => void) | null = null;
    const notifyWake = () => {
      if (wakePoll) { const fn = wakePoll; wakePoll = null; fn(); }
      else wakePending = true;
    };
    const failSession = (error: unknown) => {
      backgroundError ??= error;
      pollFailed?.(backgroundError);
      notifyWake();
    };
    const emitPollEvents = async (state: any) => {
      const list = Array.isArray(state?.events) ? state.events : [];
      const hasOffset = Number.isSafeInteger(state?.offset);
      const nextOffset = hasOffset ? Number(state.offset) : offset + list.length;
      const start = hasOffset ? Math.max(0, nextOffset - list.length) : offset;
      for (let i = 0; i < list.length; i++) {
        const idx = start + i;
        if (idx < offset) continue;
        offset = idx + 1;
        const event = list[i];
        // Streamed text comes directly from the control-plane model gateway; ignore any legacy text_delta events.
        if (event.type === 'text_delta') continue;
        if (service && event.type === 'model_retry') await service.retry({ retry: Number(event.retry) || 1, retries: Number(event.retries) || 1, delay_ms: Number(event.delay_ms) || 0, error: redactor.text(String(event.error ?? '')) });
        if (service && event.type === 'model' && !event.agent) service.responded(Array.isArray(event.tool_calls) && event.tool_calls.length > 0);
        workspace.log(redactor.clean(Object.fromEntries(Object.entries(event).filter(([name]) => !/^(reasoning.*|thinking.*|analysis)$/i.test(name)))));
      }
      if (nextOffset > offset) offset = nextOffset;
      if (conversation) conversation.offset = offset;
    };
    let drainingEvents: Promise<void> | null = null;
    const drainRunnerEvents = async () => {
      if (drainingEvents) return drainingEvents;
      drainingEvents = (async () => {
        for (let page = 0; page < 8; page++) {
          const snap = await deliver(`${key}:drain:${randomId()}`, { type: 'workspace_agent_poll', offset });
          await emitPollEvents(snap);
          if (!snap?.has_more) break;
        }
      })().finally(() => { drainingEvents = null; });
      return drainingEvents;
    };

    const maxImageBytes = Number.isSafeInteger(config.image_request_limit) && config.image_request_limit > 0
      ? config.image_request_limit
      : imageRequestLimit;
    const gatewayFailure: { current: { code: string; state: 'failed' | 'retry_wait' | 'waiting_configuration'; detail: string } | null } = { current: null };
    const modelTarget = `模型 ${model.model}（${(() => { try { return new URL(model.url).host; } catch { return '地址无效'; } })()}）`;
    const modelGateway = await registerModelGatewaySession({
      store,
      task,
      runId: String(task.trace_run_id ?? taskId),
      leaseEpoch: session.leaseEpoch ?? 0,
      runAccess,
      redactor,
      primaryModel: model,
      allowVisibleModels: false,
      guard,
      beforeModel: session.beforeModel,
      maxRequestBytes: maxImageBytes,
      maxOutputTokens: outputTokens ?? config.model.max_output_tokens,
      signal,
      beforeRequest: async ({ format, body, rawBytes, isSubagent }) => {
        const hasImages = hasImageContent(body);
        const maxBytes = hasImages ? maxImageBytes : requestLimit;
        if (rawBytes > maxBytes || (hasImages && textRequestBytes(body) > requestLimit)) {
          if (hasImages) {
            return {
              status: 413,
              code: 'request_too_large',
              message: `Model request exceeded limits (2 MiB text ceiling or ${Math.round(maxImageBytes / (1024 * 1024))} MiB image request ceiling).`,
            };
          }
          return {
            status: 413,
            code: 'context_length_exceeded',
            message: `Request exceeds the 2 MiB text request limit (${rawBytes} bytes).`,
          };
        }
        if (Array.isArray(body.tools) && body.tools.some((tool: any) => ['read_playbook', 'select_playbooks'].includes(toolNameOf(tool)))) {
          stop('execution_interrupted', 'waiting_environment', '旧执行会话仍包含已退役指南工具；保留任务记录并在新工作区恢复。');
        }
        if (Array.isArray(body.tools) && body.tools.some((tool: any) => {
          const name = toolNameOf(tool);
          return ['create_task', 'manage_task', 'list_managed_tasks'].includes(name) && !session.offered(name);
        })) {
          stop('execution_interrupted', 'waiting_environment', '旧执行会话仍包含不再获准的任务管理工具；保留任务记录并在新工作区恢复。');
        }
        await session.checkpoint?.();
        const turn = requests++;
        if (session.maxRequests !== undefined) {
          if (turn >= session.maxRequests) stop('agent_turn_limit', 'failed', `Pi 会话达到 ${session.maxRequests} 次模型请求上限。`);
          const reserve = finalizationReserve(session.maxRequests);
          finalizing = finishingNames.size > 0 && turn >= session.maxRequests - reserve;
          if (finalizing) {
            body.tools = (Array.isArray(body.tools) ? body.tools : []).filter((tool: any) => finishingNames.has(toolNameOf(tool)));
            appendUserMessageNative(
              format,
              body,
              `Execution has ${session.maxRequests - turn} turns left. ${session.finalizationMessage ?? 'Save the bounded artifact and submit the honest current result using the finish tool. Exploration tools are closed.'}`,
            );
            if (turn === session.maxRequests - 1) {
              const names = (body.tools as any[]).map(toolNameOf).filter(Boolean);
              if (names.length) forceToolChoiceNative(format, body, names);
            }
          }
        }
        if (!conversation && turn > 0 && taskId) {
          const continuedUpdates = consumePendingTaskUpdates(store, taskId);
          if (continuedUpdates.length) {
            appendUserMessageNative(
              format,
              body,
              'New events continued into this task while it was running; incorporate these facts before finishing (recorded contract and authority remain binding):\n' + JSON.stringify(redactor.clean(continuedUpdates)),
            );
          }
        }
        if (service && !isSubagent) await drainRunnerEvents().catch(() => {});
        store.run('UPDATE tasks SET model_started=1 WHERE id=?', taskId);
      },
      onTextDelta: service ? async delta => { await service.text(delta); } : undefined,
      onResponseComplete: (_summary, tap, isSubagent) => {
        gatewayFailure.current = null;
        const msg = tap.assistantMessage();
        session.inspect?.(msg);
        if (service && !isSubagent) service.responded(Boolean(msg.tool_calls?.length));
      },
      onUpstreamHttpError: (status, detail) => {
        const said = detail ? '：' + redactor.text(detail).replace(/\s+/g, ' ').trim().slice(0, 320) : '';
        if (status === 401 || status === 403) {
          failSession(new TaskError(
            'model_authentication_failed',
            'waiting_configuration',
            `${modelTarget}拒绝认证或访问，HTTP ${status}${said}。请检查模型 API Key 和权限。`,
          ));
          return;
        }
        gatewayFailure.current = {
          code: 'model_http_' + status,
          state: status === 408 || status === 429 || status >= 500 ? 'retry_wait' : 'failed',
          detail: `${modelTarget}返回 HTTP ${status}${said}`,
        };
      },
      onUpstreamTransportError: reason => {
        gatewayFailure.current = {
          code: 'model_unavailable',
          state: 'retry_wait',
          detail: redactor.text(`${modelTarget}请求失败：${reason}。`),
        };
      },
      onSessionFault: err => failSession(err),
    });

    // The SSH grant lives as long as the run: commands of the Pi process (#1379) may use the targets this role may use,
    // until the run ends, is cancelled or a target is revoked. The call that starts, reattaches or continues the process
    // carries it; the daemon moves a session it started earlier to the new grant.
    const sshLive = session.ssh?.live ?? (session.runAccess ? () => { runAccess.check(runAccess.token); return true; } : null);
    const sshGrant = session.ssh && sshLive && task.repository_id ? sshAccess.issue({
      store, repository: String(task.repository_id), task: String(task.id), role: session.ssh.role, trusted: session.ssh.trusted, live: sshLive,
    }) : null;
    const starting = sshGrant ? { ssh: sshGrant.payload } : {};
    try {
      const fresh = !conversation?.resume && !session.resume;
      // Deliver the ephemeral gateway connection (short-lived run_token + UDS/loopback address) out-of-band before
      // starting or resuming the Pi process so workspace_agent_config stays deterministic across retries/restarts
      // and run_token never enters persisted tool_operations.
      if (!fresh && session.runtime) checkRuntime(await deliver(key + ':runtime', { type: 'workspace_agent_runtime' }));
      const gwUpdate = {
        run_token: runToken,
        ...(modelGateway.gatewayUrl ? { model_gateway_url: modelGateway.gatewayUrl } : {}),
        ...(modelGateway.socketPath ? { model_gateway_socket: modelGateway.socketPath } : {}),
      };
      await deliver(key + ':gateway:' + randomId(), {
        type: 'workspace_agent_gateway',
        base64: Buffer.from(JSON.stringify(gwUpdate)).toString('base64'),
      });
      // Messages that arrived before the session starts join right after its prompt, as they would before a first native request.
      if (service) { config.service_turn = true; config.steer = service.steer(); }
      const wireConfig = redactor.clean(config);
      const bytes = Buffer.from(JSON.stringify(wireConfig));
      if (bytes.length > 2 * 1024 * 1024) stop('agent_context_too_large', 'waiting_configuration', `执行上下文大小 ${bytes.length} 字节，超过 2 MiB 上限。`);
      // The last piece of a new session's configuration also starts it (#1277), checking the pinned Pi version before the
      // process runs. A runner older than that ignores start: its answer has no runtime, and the runtime query and the start
      // call follow as before.
      let launched: any = null;
      if (fresh) {
        for (let offset = 0; offset < bytes.length; offset += RUNNER_TRANSFER_CHUNK_BYTES) {
          const final = offset + RUNNER_TRANSFER_CHUNK_BYTES >= bytes.length;
          const saved = await workspace.call(key + ':config:' + offset, {
            type: 'workspace_agent_config',
            base64: bytes.subarray(offset, offset + RUNNER_TRANSFER_CHUNK_BYTES).toString('base64'),
            offset,
            final,
            ...(final ? { start: true, ...(session.runtime ? { runtime_version: session.runtime.version } : {}) } : {}),
          }, final ? starting : {});
          if (saved.error) stop('execution_interrupted', 'waiting_environment', `写入执行配置时中断，offset=${offset}。`);
          if (final && saved.runtime && typeof saved.runtime === 'object') launched = saved;
        }
      }
      if (session.runtime && fresh) checkRuntime(launched ? launched.runtime : await deliver(key + ':runtime', { type: 'workspace_agent_runtime' }));
      // A stored started receipt is not evidence that its PID still exists. Ask the runner again on every entry;
      // it checks the saved process before returning started, including after a control-plane restart. A start that rode
      // with the configuration can be such a receipt too: the first poll checks the saved process the same way.
      const started = launched ?? await workspace.call(key + ':' + (conversation?.resume ? 'continue:' : 'start:') + randomId(), { type: conversation?.resume ? 'workspace_agent_continue' : 'workspace_agent_start' }, starting);
      if (started.error || launched && started.started !== true) stop('execution_interrupted', 'waiting_environment', '启动任务执行进程时中断。');

      // What the last poll showed that this loop already handles, so a long poll waits past it (#1277): tool and token
      // requests answered or still running in the background, and the turn boundary already answered.
      let last: any = null;
      const handled = (list: unknown, prefix: string) => (Array.isArray(list) ? list : []).map(item => String(item?.id ?? ''))
        .filter(id => /^[a-f0-9]{48}$/.test(id) && (answered.has(prefix + id) || inFlight.has(prefix + id))).slice(0, 512);
      const seenIds = () => {
        const boundary = String(last?.boundary?.id ?? ''), ids: Record<string, string[]> = {
          known_tool_ids: handled(last?.tool_requests, 'tool:'),
          known_token_ids: handled(last?.token_requests, 'token:'),
          known_boundary_ids: /^[a-f0-9]{48}$/.test(boundary) && (answered.has('boundary:' + boundary) || !(conversation || service)) ? [boundary] : [],
        };
        return Object.fromEntries(Object.entries(ids).filter(([, value]) => value.length));
      };
      // A long poll ends early when the session is cancelled or background work fails; its answer is then dropped.
      const polled = <V>(work: Promise<V>) => abortable(new Promise<V>((resolve, reject) => {
        pollFailed = reject;
        work.then(resolve, reject).finally(() => { if (pollFailed === reject) pollFailed = null; });
        if (backgroundError !== null) reject(backgroundError);
      }));
      const waitNextPoll = (ms: number) => {
        if (wakePending) { wakePending = false; return abortable(Promise.resolve()); }
        return abortable(new Promise<void>(resolve => {
          const timer = setTimeout(() => { if (wakePoll === done) wakePoll = null; resolve(); }, ms);
          const done = () => { clearTimeout(timer); resolve(); };
          wakePoll = done;
        }));
      };
      const startBackground = (idKey: string, work: () => Promise<void>) => {
        if (answered.has(idKey) || inFlight.has(idKey)) return;
        const run = work().then(() => { answered.add(idKey); }, error => { failSession(error); })
          .finally(() => { inFlight.delete(idKey); notifyWake(); });
        inFlight.set(idKey, run);
      };

      for (;;) {
        if (backgroundError !== null) throw backgroundError;
        await guard();
        wakePending = false;
        // Read-only liveness/event polls are safe to repeat; deliver() avoids flooding task_tools and task_history (#1266).
        // The runner holds the poll up to pollWait until something new appears (#1277).
        const state = await polled(deliver(`${key}:poll:${randomId()}`, { type: 'workspace_agent_poll', offset, wait_ms: pollWait, ...seenIds() }));
        last = state;
        await guard();
        if (backgroundError !== null) throw backgroundError;
        await emitPollEvents(state);
        // A finished agent can leave more than one page of events; retain the tail before exiting.
        if (state.has_more && ['completed', 'review_ready', 'failed', 'interrupted'].includes(state.state)) continue;
        if (conversation?.resume && state.state === 'review_ready' && !answered.has('resumed')) {
          // The continue command can be visible before the runner leaves its ready state.
          await pause(50); continue;
        }
        if (state.boundary && (conversation || service) && !answered.has('boundary:' + state.boundary.id)) {
          const id = String(state.boundary.id);
          if (!/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid');
          const recovery = typeof state.boundary.recovery === 'string' ? state.boundary.recovery : undefined;
          const reply = Buffer.from(JSON.stringify(redactor.clean(conversation ? await conversation.boundary(state.boundary.stage, recovery) : await service!.boundary())));
          if (reply.length > 32 * 1024 * 1024) stop('agent_context_too_large');
          for (let at = 0; at < reply.length; at += RUNNER_TRANSFER_CHUNK_BYTES) {
            const sent = await workspace.call(`${key}:boundary:${id}:${at}`, { type: 'workspace_agent_boundary', request_id: id, base64: reply.subarray(at, at + RUNNER_TRANSFER_CHUNK_BYTES).toString('base64'), offset: at, final: at + RUNNER_TRANSFER_CHUNK_BYTES >= reply.length });
            if (sent.error) stop('execution_interrupted', 'waiting_environment');
          }
          answered.add('boundary:' + id); answered.add('resumed'); continue;
        }
        if (state.state === 'completed' || state.state === 'review_ready') {
          if (inFlight.size) await Promise.allSettled([...inFlight.values()]);
          await modelGateway.drain();
          if (backgroundError !== null) throw backgroundError;
          return session.complete({ ...state, result: redactor.clean(state.result) }, publication);
        }
        // The runner's reason goes into the task log before any stop, and the fault names it too (#1040).
        if (state.state === 'failed') workspace.log({ type: 'agent_failure', error: state.error || null, detail: redactor.text(String(state.detail || '')).slice(0, 1000) || null });
        const reason = state.detail ? '：' + redactor.text(String(state.detail)).replace(/\s+/g, ' ').slice(0, 300) : '';
        // The session no longer fits after Pi compacted it and retried; the next run does not reopen it (src/roles/harness.ts).
        if (state.error === 'agent_context_too_large') stop('agent_context_too_large', 'failed', `Pi 压缩会话并重试后，请求仍超过模型上下文${reason}。重试时不再续接这个会话，按任务记录重新开始。`);
        // Pi's compaction itself failed, usually its summary request; the session is kept and the retry reopens it.
        if (state.error === 'agent_compaction_failed') stop('agent_compaction_failed', 'retry_wait', `Pi 压缩会话失败${reason}。`);
        // A failed agent carries error as well, so it takes this path and is retried in a fresh workspace; its reason is kept.
        if (state.error === 'disk_full') stop('disk_full', 'waiting_environment', `项目电脑的工作卷空间不足，任务执行进程已停止${reason}。`);
        if (state.state === 'failed' && gatewayFailure.current) stop(gatewayFailure.current.code, gatewayFailure.current.state, gatewayFailure.current.detail);
        if (state.error || ['interrupted', 'missing'].includes(state.state)) stop('execution_interrupted', 'waiting_environment', state.state === 'failed'
          ? `任务执行进程失败：${redactor.text(String(state.detail || '没有返回原因')).replace(/\s+/g, ' ').slice(0, 300)}。`
          : `轮询任务执行进程时中断，状态=${state.state || '未知'}，offset=${offset}。`);
        if (state.state === 'failed') stop('pi_execution_failed', undefined, `任务执行进程返回 failed 状态${state.detail ? '：' + redactor.text(String(state.detail)).replace(/\s+/g, ' ').slice(0, 300) : ''}，请查看此前的执行日志。`);

        for (const tokenRequest of state.token_requests ?? []) {
          const id = String(tokenRequest?.id ?? '');
          startBackground('token:' + id, async () => {
            if (!/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid');
            let reply: any;
            try {
              if (!session.token) stop('github_read_token_unavailable', undefined, '当前任务未配置 GitHub 只读令牌服务。');
              const purpose = tokenRequest?.purpose === 'git' ? 'git' : tokenRequest?.purpose === 'gh' ? 'gh' : undefined;
              const repository = typeof tokenRequest?.repository === 'string' && tokenRequest.repository.trim() ? tokenRequest.repository.trim() : undefined;
              reply = await session.token!({ ...(purpose ? { purpose } : {}), ...(repository ? { repository } : {}), ...(tokenRequest?.token !== undefined ? { token: tokenRequest.token } : {}) });
            } catch (error) {
              await guard();
              reply = { error: error instanceof TaskError ? error.code : 'github_read_token_unavailable' };
            }
            const sent = await workspace.deliver({ type: 'workspace_agent_token', request_id: id, base64: Buffer.from(JSON.stringify(reply)).toString('base64') });
            workspace.log({ type: 'github_read_token', ...(reply.error ? { error: reply.error } : { expires_at: reply.expires_at, permissions: reply.permissions }), ...(sent.error ? { delivered: false } : {}) });
          });
        }

        for (const toolRequest of state.tool_requests ?? []) {
          const id = String(toolRequest?.id ?? ''), name = String(toolRequest?.name ?? ''), args = toolRequest?.arguments, kind = toolRequest?.kind;
          startBackground('tool:' + id, async () => {
            if (!/^[a-f0-9]{48}$/.test(id)) {
              if (kind === 'pull_request' || (name === 'create_pull_request' && !(config.control_tools || []).includes(name)))
                stop('model_request_invalid', undefined, 'create_pull_request 请求 ID 格式无效，应为 48 位十六进制字符。');
              stop('model_request_invalid');
            }
            // Not a model tool: the runner asks for the task's worktree before a file tool or command can run (#769).
            if (kind === 'workspace') {
              const reply = session.ensureWorkspace ? await abortable(session.ensureWorkspace()) : { error: 'workspace_unavailable' };
              await deliverMailboxToolReply(redactor.clean(reply), id, chunk => workspace.deliver(chunk), '发送工作区结果时中断。');
              return;
            }
            if (kind === 'repository' && ['store_command_result', 'store_tool_result', 'read_tool_result'].includes(name)) {
              await guard();
              let result: any = { error: 'tool_not_allowed' };
              if (name === 'read_tool_result' && session.offered(name)) result = await resultFiles.read(args);
              else if (name === 'store_tool_result' && session.offered(args?.name)) result = resultFiles.preserve(args.value, args.name);
              else if (name === 'store_command_result' && session.offered('run_command') && /^[a-f0-9]{48}$/.test(args?.output_id ?? '')) {
                result = await resultFiles.run(() => commandResult({ ...args.preview, truncated: true, output_file: 'journal' }, 'pi:' + args.output_id,
                  offset => workspace.deliver({ type: 'workspace_agent_result', request_id: args.output_id, offset })), true);
              }
              await guard();
              await deliverMailboxToolReply(redactor.clean(result), id, chunk => workspace.deliver(chunk), '发送完整工具结果时中断。');
              return;
            }
            if (kind === 'control' || (config.control_tools || []).includes(name)) {
              const allowed = session.control && session.offered(name) && (config.control_tools || []).includes(name) && (!finalizing || finishingNames.has(name));
              const reply = allowed ? await abortable(session.control!(name, args, { id, token: toolRequest?.token })) : { result: { error: 'tool_not_allowed' } };
              const hasImages = Array.isArray(reply.images) && reply.images.length > 0;
              const payload = hasImages
                ? {
                    result: redactor.clean(reply.result),
                    ...(reply.finish ? { finish: true } : {}),
                    images: reply.images!.map(img => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
                  }
                : redactor.clean({ result: reply.result, ...(reply.finish ? { finish: true } : {}) });
              // Keep image bytes out of persisted operation logs/trajectories by using deliver() when images are attached.
              await deliverMailboxToolReply(payload, id,
                chunk => hasImages ? workspace.deliver(chunk) : workspace.call(`${key}:control:${id}:${chunk.offset}`, chunk), '发送控制面工具结果时中断。');
              return;
            }
            if (kind === 'pull_request' || name === 'create_pull_request') {
              if (session.publication !== 'pull_request' || !session.createPullRequest) stop('create_pull_request_not_allowed', undefined, '当前任务不允许调用 create_pull_request。');
              const cleanedArgs = redactor.clean(args);
              let reply: any;
              if (cleanedArgs?.change_title !== undefined && (typeof cleanedArgs.change_title !== 'string' || !cleanedArgs.change_title.trim() || cleanedArgs.change_title.length > 500 || /[\r\n]/.test(cleanedArgs.change_title))) reply = { error: 'model_change_title_invalid' };
              else if (!cleanedArgs || typeof cleanedArgs.summary !== 'string' || !cleanedArgs.summary.trim() || cleanedArgs.summary.length > 2000 || typeof cleanedArgs.test_command !== 'string' || !cleanedArgs.test_command.trim() || cleanedArgs.test_command.length > 2048) reply = { error: 'model_development_invalid' };
              else reply = await abortable(session.createPullRequest!(id, cleanedArgs));
              reply = redactor.clean(reply);
              await deliverMailboxToolReply(reply, id, chunk => workspace.call(`${key}:pr-reply:${id}:${chunk.offset}`, chunk), '发送 PR 发布结果时中断。');
              if (reply.pr || reply.status === 'no_changes') publication = { ...cleanedArgs, ...reply };
              return;
            }
            const offered = session.offered(name);
            let result: any;
            if (session.platform && Object.hasOwn(session.platform, name)) result = offered ? await abortable(session.platform[name]!(id, args)) : { error: 'write_not_allowed' };
            else result = !offered || !session.repository ? { error: 'tool_not_allowed' } : await resultFiles.execute(name, args, () => abortable(session.repository!(name, args)));
            await deliverMailboxToolReply(redactor.clean(result), id, chunk => workspace.deliver(chunk), '发送仓库读取结果时中断。');
          });
        }

        // A runner that held the poll already waited; one that answered at once (an older image, a test double) gets the
        // 500 ms pause it always had.
        if (state.long_poll !== true) await waitNextPoll(500);
      }
    } finally {
      sshGrant?.close();
      await modelGateway.close();
      if (inFlight.size) await Promise.allSettled([...inFlight.values()]);
    }
  };
}

/** What a role run on the Pi harness needs: the workspace its session lives in and, for an entry executor, the workflow's
 * own Pi tool profile. resume reattaches to the session already living there. */
export interface PiRoleEnvironment {
  workspace: Workspace;
  session?: Pick<PiSession<any>, 'config' | 'conversation' | 'platform' | 'repository' | 'token' | 'createPullRequest' | 'publication' | 'complete'>;
  resume?: boolean;
  key?: string;
  runtime?: PiSession<any>['runtime'];
  service?: PiServiceTurn;
}
