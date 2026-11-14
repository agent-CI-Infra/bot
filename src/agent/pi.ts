import { randomId } from '../core/security.js';
import { stop, TaskError, type Redactor } from './common.js';
import type { AgentServices } from './runtime.js';
import type { Workspace } from './workspace.js';
import type { AgentModel } from './gateway.js';
import type { Store } from '../storage/database.js';
import { finalizationReserve } from './tool-context.js';
import { deliverMailboxToolReply } from '../roles/task-tools.js';

/** The Pi SDK the project computer image installs (runner/package.json). scripts/check-runtime.mjs keeps the two equal. */
export const piRuntime = { agent: 'pi', package: '@earendil-works/pi-coding-agent', version: '1.4.0' } as const;

export interface PiConversation { history?: any[]; resume?: boolean; offset?: number; model?: AgentModel; boundary(stage: string): Promise<{prompt?: string, messages?: string[]}> }
/**
 * One Pi session in a task workspace, driven through the runner mailbox. The control plane keeps the provider boundary
 * (every model request goes through services.request), the tool allowlist and every write; the runner process only runs
 * the Pi SDK loop with the tools named in config.
 */
export interface PiSession<T> {
  store: Store;
  taskId: string;
  /** The task lifecycle guard, checked before every mailbox exchange. */
  guard: () => Promise<void>;
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
  /** The answer to github_read_token: a short-lived read token, or the reason there is none. */
  token?: () => Promise<any>;
  createPullRequest?: (id: string, args: any) => Promise<any>;
  /** capabilities.github.publication: only 'pull_request' may answer create_pull_request. */
  publication?: string;
  /** Control-plane tools named in config.control_tools. The runner waits for them without a deadline. */
  control?: (name: string, args: any, meta?: { id: string; token?: unknown }) => Promise<{ result: any; finish?: boolean }>;
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
}

export function piAdapter<T>(session: PiSession<T>) {
  const { store, taskId, guard, workspace, redactor, config, conversation, signal } = session, key = session.key ?? 'pi';
  // Every wait of the control plane ends as soon as the session is cancelled. A cancelled session is never reported as a
  // resumable interruption: the caller releases its workspace, and the next run starts from task records.
  const cancelled = () => signal?.reason ?? new TaskError('harness_cancelled', 'cancelled');
  const abortable = <V>(work: Promise<V>): Promise<V> => !signal ? work : signal.aborted ? Promise.reject(cancelled()) : new Promise<V>((resolve, reject) => {
    const abort = () => reject(cancelled()); signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  const pause = (ms: number) => abortable(new Promise(resolve => setTimeout(resolve, ms)));
  return async ({ request, model, outputTokens }: AgentServices): Promise<T> => {
    config.model = model.capabilities ? {context_window:model.capabilities.context_window,max_output_tokens:model.capabilities.max_output_tokens,reasoning:model.capabilities.reasoning} : {context_window:128000,max_output_tokens:8192,reasoning:false};
    config.output_tokens = outputTokens ?? config.model.max_output_tokens;
    const finishingNames=new Set(session.finalizationTools??config.finish_tools??[]);
    if(session.maxRequests!==undefined&&finishingNames.size&&session.maxRequests<=finalizationReserve(session.maxRequests))
      stop('role_budget_exhausted','waiting_configuration','剩余请求不足以保留至少一轮工作和收尾，Pi 会话尚未启动。');
    // Revising an unpublished result continues this execution; later tasks choose a fresh model.
    if (conversation) conversation.model = model;
    if (session.runtime) {
      const runtime = await workspace.call(key + ':runtime:' + randomId(), { type: 'workspace_agent_runtime' });
      if (runtime.error || runtime.agent !== 'pi') stop('pi_runtime_unavailable', 'waiting_environment', '项目电脑的 runner 不支持 Pi 运行时查询，请升级项目电脑镜像。');
      session.runtime.report(runtime);
      if (runtime.version !== session.runtime.version) stop('harness_version_mismatch', 'waiting_configuration', `项目电脑的 Pi 版本是 ${runtime.version}，角色配置固定的是 ${session.runtime.version}；不会换用其他版本。`);
    }
    const bytes = Buffer.from(JSON.stringify(redactor.clean(config))); if (bytes.length > 2 * 1024 * 1024) stop('agent_context_too_large', 'waiting_configuration', `执行上下文大小 ${bytes.length} 字节，超过 2 MiB 上限。`);
    if (!conversation?.resume && !session.resume) {
      for (let offset = 0; offset < bytes.length; offset += 30000) {
        const saved = await workspace.call(key + ':config:' + offset, { type: 'workspace_agent_config', base64: bytes.subarray(offset, offset + 30000).toString('base64'), offset, final: offset + 30000 >= bytes.length });
        if (saved.error) stop('execution_interrupted', 'waiting_environment', `写入执行配置时中断，offset=${offset}。`);
      }
      if (conversation?.history?.length) {
        const history = Buffer.from(JSON.stringify(redactor.clean(conversation.history)));
        if (history.length > 32 * 1024 * 1024) stop('agent_context_too_large');
        for (let offset = 0; offset < history.length; offset += 30000) {
          const saved = await workspace.deliver({ type: 'workspace_agent_history', base64: history.subarray(offset, offset + 30000).toString('base64'), offset, final: offset + 30000 >= history.length });
          if (saved.error) stop('execution_interrupted', 'waiting_environment');
        }
      }
    }
    // A stored started receipt is not evidence that its PID still exists. Ask the runner again on every entry;
    // it checks the saved process before returning started, including after a control-plane restart.
    const started = await workspace.call(key + ':' + (conversation?.resume ? 'continue:' : 'start:') + randomId(), { type: conversation?.resume ? 'workspace_agent_continue' : 'workspace_agent_start' });
    if (started.error) stop('execution_interrupted', 'waiting_environment', '启动任务执行进程时中断。');

    let offset = conversation?.offset || 0, publication: any, requests = 0, finalizing = false;
    const answered = new Set<string>(), inFlight = new Map<string, Promise<void>>();
    let backgroundError: unknown = null, wakePoll: (() => void) | null = null, wakePending = false;
    const notifyWake = () => {
      if (wakePoll) { const fn = wakePoll; wakePoll = null; fn(); }
      else wakePending = true;
    };
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
      const run = work().then(() => { answered.add(idKey); }, error => { backgroundError ??= error; })
        .finally(() => { inFlight.delete(idKey); notifyWake(); });
      inFlight.set(idKey, run);
    };

    try {
      for (;;) {
        if (backgroundError !== null) throw backgroundError;
        await guard();
        wakePending = false;
        const state = conversation ? await workspace.deliver({ type: 'workspace_agent_poll', offset })
          : await workspace.call(key + ':poll:' + randomId(), { type: 'workspace_agent_poll', offset });
        if (conversation) await guard();
        if (backgroundError !== null) throw backgroundError;
        for (const event of state.events || []) workspace.log(redactor.clean(Object.fromEntries(Object.entries(event).filter(([name]) => !/^(reasoning.*|thinking.*|analysis)$/i.test(name)))));
        offset = state.offset || offset;
        if (conversation) conversation.offset = offset;
        // A finished agent can leave more than one page of events; retain the tail before exiting.
        if (state.has_more && ['completed', 'review_ready', 'failed', 'interrupted'].includes(state.state)) continue;
        if (conversation?.resume && state.state === 'review_ready' && !answered.has('resumed')) {
          // The continue command can be visible before the runner leaves its ready state.
          await pause(50); continue;
        }
        if (state.boundary && conversation && !answered.has('boundary:' + state.boundary.id)) {
          const id = String(state.boundary.id);
          if (!/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid');
          const reply = Buffer.from(JSON.stringify(redactor.clean(await conversation.boundary(state.boundary.stage))));
          if (reply.length > 32 * 1024 * 1024) stop('agent_context_too_large');
          for (let at = 0; at < reply.length; at += 30000) {
            const sent = await workspace.call(`${key}:boundary:${id}:${at}`, { type: 'workspace_agent_boundary', request_id: id, base64: reply.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= reply.length });
            if (sent.error) stop('execution_interrupted', 'waiting_environment');
          }
          answered.add('boundary:' + id); answered.add('resumed'); continue;
        }
        if (state.state === 'completed' || state.state === 'review_ready') {
          if (inFlight.size) await Promise.allSettled([...inFlight.values()]);
          if (backgroundError !== null) throw backgroundError;
          if (state.state === 'review_ready') {
            const parts: Buffer[] = []; let size = 1;
            for (let at = 0; at < size; at += 45000) {
              const part = await workspace.deliver({ type: 'workspace_agent_session', offset: at });
              if (part.error || !Number.isSafeInteger(part.size) || part.size > 32 * 1024 * 1024 || typeof part.base64 !== 'string') stop('agent_context_too_large');
              size = part.size; parts.push(Buffer.from(part.base64, 'base64'));
            }
            const messages = JSON.stringify(redactor.clean(JSON.parse(Buffer.concat(parts).toString('utf8'))));
            store.run('UPDATE tasks SET messages=? WHERE id=?', messages, taskId);
          }
          return session.complete({ ...state, result: redactor.clean(state.result) }, publication);
        }
        // A failed agent carries error as well, so it takes this path and is retried in a fresh workspace; its reason is kept.
        if (state.error === 'agent_context_too_large') stop('agent_context_too_large', 'failed', '会话压缩后仍超过 2 MiB 或 128k 上下文上限；重试将使用空会话。');
        if (state.state === 'failed') workspace.log({ type: 'agent_failure', error: state.error || null, detail: redactor.text(String(state.detail || '')).slice(0, 1000) || null });
        if (state.error === 'disk_full') stop('disk_full', 'waiting_environment', `项目电脑的工作卷空间不足，任务执行进程已停止${state.detail ? '：' + redactor.text(String(state.detail)).replace(/\s+/g, ' ').slice(0, 300) : ''}。`);
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
              reply = await session.token!();
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
            if (kind === 'control' || (config.control_tools || []).includes(name)) {
              const allowed = session.control && session.offered(name) && (config.control_tools || []).includes(name) && (!finalizing || finishingNames.has(name));
              const reply = allowed ? await abortable(session.control!(name, args, { id, token: toolRequest?.token })) : { result: { error: 'tool_not_allowed' } };
              await deliverMailboxToolReply(redactor.clean({ result: reply.result, ...(reply.finish ? { finish: true } : {}) }), id,
                chunk => workspace.call(`${key}:control:${id}:${chunk.offset}`, chunk), '发送控制面工具结果时中断。');
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
            else result = !offered || !session.repository ? { error: 'tool_not_allowed' } : await abortable(session.repository(name, args));
            await deliverMailboxToolReply(redactor.clean(result), id, chunk => workspace.deliver(chunk), '发送仓库读取结果时中断。');
          });
        }

        if (state.request && !answered.has(state.request.id)) {
          if (inFlight.size) await Promise.allSettled([...inFlight.values()]);
          if (backgroundError !== null) throw backgroundError;
          const body = state.request.body;
          if (!body || !Array.isArray(body.messages) || Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) stop('model_request_invalid', undefined, '模型请求缺少 messages 数组，或请求内容超过 2 MiB 上限。');
          if(body.tools?.some((tool:any)=>['read_playbook','select_playbooks'].includes(tool.function?.name))) stop('execution_interrupted','waiting_environment','旧执行会话仍包含已退役指南工具；保留任务记录并在新工作区恢复。');
          await session.checkpoint?.();
          const turn=requests++;
          if (session.maxRequests !== undefined) {
            if(turn>=session.maxRequests)stop('agent_turn_limit', 'failed', `Pi 会话达到 ${session.maxRequests} 次模型请求上限。`);
            const reserve=finalizationReserve(session.maxRequests);
            finalizing=finishingNames.size>0&&turn>=session.maxRequests-reserve;
            if(finalizing){
              body.tools=(body.tools??[]).filter((tool:any)=>finishingNames.has(tool.function?.name));
              body.messages.push({role:'user',content:`Execution has ${session.maxRequests-turn} turns left. ${session.finalizationMessage??'Save the bounded artifact and submit the honest current result using the finish tool. Exploration tools are closed.'}`});
              if(turn===session.maxRequests-1){const names=(body.tools as any[]).map(tool=>tool.function.name);body.tool_choice=names.length===1?{type:'function',function:{name:names[0]}}:'required';}
            }
          }
          store.run('UPDATE tasks SET model_started=1 WHERE id=?', taskId);
          let lastProgress = -Infinity, sequence = 0, heartbeat: ReturnType<typeof setInterval> | undefined;
          const ping = async () => {
            const sent = await workspace.deliver({ type: 'workspace_agent_progress', request_id: state.request.id, sequence: ++sequence });
            if (sent.error) stop('execution_interrupted', 'waiting_environment', '向任务执行进程发送模型 token 活动通知时中断。');
          };
          const onRetry = async () => { await ping(); heartbeat ??= setInterval(() => { void ping().catch(() => {}); }, 30000); };
          const { value, status, model: used } = await abortable(request(body, String(state.request.id), async () => {
            if (Date.now() - lastProgress < 1000) return;
            lastProgress = Date.now();
            await ping();
          }, undefined, { onRetry })).finally(() => clearInterval(heartbeat));
          session.inspect?.(value?.choices?.[0]?.message);
          const cleaned = redactor.clean(value);
          for (const [index, call] of (value.choices?.[0]?.message?.tool_calls || []).entries()) {
            if (call.function?.name !== 'write_file') continue;
            let args; try { args = JSON.parse(call.function.arguments); } catch { continue; }
            if (typeof args.path === 'string' && args.path.startsWith('../notes/') && typeof args.content === 'string') {
              cleaned.choices[0].message.tool_calls[index].function.arguments = JSON.stringify({ ...redactor.clean(args), content: args.content });
            }
          }
          let responseBody = JSON.stringify(cleaned), contentType = 'application/json';
          if (body.stream) {
            const value = JSON.parse(responseBody), message = value.choices?.[0]?.message; if (!message) stop('model_response_invalid', undefined, '转换模型流式响应时缺少 choices[0].message。');
            const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call: any, index: number) => ({ ...call, index })) } : {}) };
            const chunk = (part: any, finish: any = null) => JSON.stringify({ id: value.id || state.request.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: used.model, choices: [{ index: 0, delta: part, finish_reason: finish }], usage: value.usage });
            responseBody = 'data: ' + chunk(delta) + '\n\ndata: ' + chunk({}, message.tool_calls?.length ? 'tool_calls' : 'stop') + '\n\ndata: [DONE]\n\n'; contentType = 'text/event-stream';
          }
          const reply = Buffer.from(JSON.stringify({ status, content_type: contentType, body: responseBody }));
          for (let at = 0; at < reply.length; at += 30000) {
            const wrote = await workspace.call(`${key}:reply:${state.request.id}:${at}`, { type: 'workspace_agent_reply', request_id: state.request.id, base64: reply.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= reply.length });
            if (wrote.error) stop('execution_interrupted', 'waiting_environment', `向任务执行进程发送模型响应时中断，offset=${at}。`);
          }
          answered.add(state.request.id); continue;
        }
        await waitNextPoll(500);
      }
    } finally {
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
}
