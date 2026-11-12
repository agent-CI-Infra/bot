import { randomId } from '../core/security.js';
import { stop, TaskError, type Redactor } from './common.js';
import type { AgentServices } from './runtime.js';
import type { Workspace } from './workspace.js';
import type { AgentModel } from './gateway.js';
import type { Store } from '../storage/database.js';

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
  control?: (name: string, args: any) => Promise<{ result: any; finish?: boolean }>;
  /** The session ended: turn the runner's final state, and a publication answered during it, into the run result. */
  complete: (state: any, publication: any) => T | Promise<T>;
  /** Reattach to the session already living in this workspace (native resume) instead of starting one. */
  resume?: boolean;
  /** Prefix of this session's runner operation keys; distinct sessions of one task attempt need distinct prefixes. */
  key?: string;
  /** At most this many model requests (a role budget). Pi itself has no turn limit. */
  maxRequests?: number;
  /** Sees each model message before it is relayed, for example to record a denied tool call. */
  inspect?: (message: any) => void;
  /** A safe checkpoint: Pi waits for a model reply, so every tool result is already in its history. */
  checkpoint?: () => Promise<void>;
  /** Check the runner's actual Pi runtime against the pinned harness version before the session starts. */
  runtime?: { version: string; report: (runtime: any) => void };
  /** The managed session's cancellation: an abort ends the control plane's wait with harness_cancelled. */
  signal?: AbortSignal;
}

const chunks = (bytes: Buffer, size = 30000) => { const parts: [number, Buffer][] = []; for (let at = 0; at < bytes.length || at === 0; at += size) parts.push([at, bytes.subarray(at, at + size)]); return parts; };

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
  return async ({ request, model }: AgentServices): Promise<T> => {
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
    // No deadline: the task runs until the agent finishes. Disabling the project or stopping its computer ends it
    // (guard() and the interrupted poll below). A request stays visible until the agent picks up its reply; answering it
    // twice would call the model twice.
    let offset = conversation?.offset || 0, publication: any, requests = 0; const answered = new Set<string>();
    for (;;) {
      await guard();
      const state = conversation ? await workspace.deliver({ type: 'workspace_agent_poll', offset })
        : await workspace.call(key + ':poll:' + randomId(), { type: 'workspace_agent_poll', offset });
      if (conversation) await guard();
      for (const event of state.events || []) workspace.log(redactor.clean(Object.fromEntries(Object.entries(event).filter(([name]) => !/^(reasoning.*|thinking.*|analysis)$/i.test(name))))); offset = state.offset || offset;
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
      if (state.error || ['interrupted', 'missing'].includes(state.state)) stop('execution_interrupted', 'waiting_environment', state.state === 'failed'
        ? `任务执行进程失败：${redactor.text(String(state.detail || '没有返回原因')).replace(/\s+/g, ' ').slice(0, 300)}。`
        : `轮询任务执行进程时中断，状态=${state.state || '未知'}，offset=${offset}。`);
      if (state.state === 'failed') stop('pi_execution_failed', undefined, `任务执行进程返回 failed 状态${state.detail ? '：' + redactor.text(String(state.detail)).replace(/\s+/g, ' ').slice(0, 300) : ''}，请查看此前的执行日志。`);
      if (state.control_tool && !answered.has('control:' + state.control_tool.id)) {
        const { id, name, arguments: args } = state.control_tool;
        if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid');
        // Only tools this session offered and the control plane runs itself; the runner cannot add one by naming it.
        const allowed = session.control && session.offered(name) && (config.control_tools || []).includes(name);
        const reply = allowed ? await abortable(session.control!(name, args)) : { result: { error: 'tool_not_allowed' } };
        const body = Buffer.from(JSON.stringify(redactor.clean({ result: reply.result, ...(reply.finish ? { finish: true } : {}) })));
        for (const [at, part] of chunks(body)) {
          const sent = await workspace.call(`${key}:control:${id}:${at}`, { type: 'workspace_agent_control_tool', request_id: id, base64: part.toString('base64'), offset: at, final: at + 30000 >= body.length });
          if (sent.error === 'agent_request_changed' || (sent.error === 'runner_operation_failed' && sent.detail === 'workspace_agent_control_tool: agent_request_changed')) break;
          if (sent.error) stop('execution_interrupted', 'waiting_environment', '发送控制面工具结果时中断。');
        }
        answered.add('control:' + id); continue;
      }
      if (state.pull_request && !answered.has('pr:' + state.pull_request.id)) {
        if (session.publication !== 'pull_request' || !session.createPullRequest) stop('create_pull_request_not_allowed', undefined, '当前任务不允许调用 create_pull_request。');
        const id = String(state.pull_request.id), args = redactor.clean(state.pull_request.arguments);
        if (!/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid', undefined, 'create_pull_request 请求 ID 格式无效，应为 48 位十六进制字符。');
        let reply: any;
        if (args?.change_title !== undefined && (typeof args.change_title !== 'string' || !args.change_title.trim() || args.change_title.length > 500 || /[\r\n]/.test(args.change_title))) reply = { error: 'model_change_title_invalid' };
        else if (!args || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 2000 || typeof args.test_command !== 'string' || !args.test_command.trim() || args.test_command.length > 2048) reply = { error: 'model_development_invalid' };
        else reply = await session.createPullRequest!(id, args);
        reply = redactor.clean(reply);
        const bytes = Buffer.from(JSON.stringify(reply));
        for (let at = 0; at < bytes.length; at += 30000) {
          const sent = await workspace.call(`${key}:pr-reply:${id}:${at}`, { type: 'workspace_agent_pull_request', request_id: id, base64: bytes.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= bytes.length });
          if (sent.error) stop('execution_interrupted', 'waiting_environment', `发送 PR 发布结果时中断，offset=${at}。`);
        }
        if (reply.pr || reply.status === 'no_changes') publication = { ...args, ...reply };
        answered.add('pr:' + id); continue;
      }
      if (state.token_request && !answered.has('token:' + state.token_request.id)) {
        const id = String(state.token_request.id);
        let reply: any;
        try { if (!session.token) stop('github_read_token_unavailable', undefined, '当前任务未配置 GitHub 只读令牌服务。'); reply = await session.token!(); }
        // The agent gets the reason and carries on without the token; a stopped or revoked task still stops here.
        catch (error) { await guard(); reply = { error: error instanceof TaskError ? error.code : 'github_read_token_unavailable' }; }
        // If the agent stopped waiting, the answer has nowhere to go; it can ask again, and the token is revoked at the end anyway.
        const sent = await workspace.deliver({ type: 'workspace_agent_token', request_id: id, base64: Buffer.from(JSON.stringify(reply)).toString('base64') });
        workspace.log({ type: 'github_read_token', ...(reply.error ? { error: reply.error } : { expires_at: reply.expires_at, permissions: reply.permissions }), ...(sent.error ? { delivered: false } : {}) });
        answered.add('token:' + id); continue;
      }
      if (state.repository_tool && !answered.has('repository:' + state.repository_tool.id)) {
        const { id, name, arguments: args } = state.repository_tool;
        if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid');
        const offered = session.offered(name);
        let result: any;
        // A write tool the workflow allows is performed by the control plane; its answer goes back like a repository read.
        if (session.platform && Object.hasOwn(session.platform, name)) result = offered ? await session.platform[name]!(id, args) : { error: 'write_not_allowed' };
        else result = !offered || !session.repository ? { error: 'tool_not_allowed' } : await session.repository(name, args);
        const reply = Buffer.from(JSON.stringify(redactor.clean(result)));
        for (let at = 0; at < reply.length; at += 30000) {
          const sent = await workspace.deliver({ type: 'workspace_agent_repository_tool', request_id: id, base64: reply.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= reply.length });
          // The caller may have timed out or been cancelled; the runner wraps the original error in detail.
          if (sent.error === 'agent_request_changed' || (sent.error === 'runner_operation_failed' && sent.detail === 'workspace_agent_repository_tool: agent_request_changed')) break;
          if (sent.error) stop('execution_interrupted', 'waiting_environment', '发送仓库读取结果时中断。');
        }
        answered.add('repository:' + id); continue;
      }
      if (state.request && !answered.has(state.request.id)) {
        const body = state.request.body;
        if (!body || !Array.isArray(body.messages) || Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) stop('model_request_invalid', undefined, '模型请求缺少 messages 数组，或请求内容超过 2 MiB 上限。');
        // A runner surviving an upgrade may still advertise the retired protocol. Recreate the workspace from
        // existing checkpoints instead of forwarding that session's old catalog/tools to the model.
        if(body.tools?.some((tool:any)=>['read_playbook','select_playbooks'].includes(tool.function?.name))) stop('execution_interrupted','waiting_environment','旧执行会话仍包含已退役指南工具；保留任务记录并在新工作区恢复。');
        await session.checkpoint?.();
        if (session.maxRequests !== undefined && ++requests > session.maxRequests) stop('agent_turn_limit', 'failed', `Pi 会话达到 ${session.maxRequests} 次模型请求上限。`);
        store.run('UPDATE tasks SET model_started=1 WHERE id=?', taskId);
        let lastProgress = -Infinity, sequence = 0;
        const { value, status, model: used } = await abortable(request(body, String(state.request.id), async () => {
          if (Date.now() - lastProgress < 1000) return;
          lastProgress = Date.now();
          const sent = await workspace.deliver({ type: 'workspace_agent_progress', request_id: state.request.id, sequence: ++sequence });
          if (sent.error) stop('execution_interrupted', 'waiting_environment', '向任务执行进程发送模型 token 活动通知时中断。');
        }));
        session.inspect?.(value?.choices?.[0]?.message);
        const cleaned = redactor.clean(value);
        // Note contents are user data: preserve write payloads while keeping the existing redaction of other model output.
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
        // The agent continues as soon as it has the reply; poll again right away instead of waiting.
        answered.add(state.request.id); continue;
      }
      await pause(500);
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
