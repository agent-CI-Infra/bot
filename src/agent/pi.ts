import { ResultSession, projectResultOwner, resultScope, commandResult } from './tool-results.js';
import { randomId } from '../core/security.js';
import { stop, TaskError, type Redactor } from './common.js';
import type { AgentServices, ToolImageBlock } from './runtime.js';
import type { Workspace } from './workspace.js';
import type { AgentModel } from './gateway.js';
import type { Store } from '../storage/database.js';
import { finalizationReserve, hasImageContent, imageRequestLimit, requestLimit, textRequestBytes } from './tool-context.js';
import { deliverMailboxToolReply } from '../roles/task-tools.js';
import { modelTransport, nativeModelConnection } from '../harness/model-connection.js';
import { consumePendingTaskUpdates } from '../review/bot-pr-wake.js';

/** The Pi SDK the project computer image installs (runner/package.json). scripts/check-runtime.mjs keeps the two equal. */
export const piRuntime = { agent: 'pi', package: '@earendil-works/pi-coding-agent', version: '1.4.0' } as const;

/**
 * A review's conversation with its Pi session. The session itself lives in Pi's session files (#1040); the control plane
 * answers its boundaries: the start prompt (given how the session began: `recovery` is native_resume when it holds the
 * earlier round), and the updates between turns. resume continues the session still waiting in this workspace.
 */
export interface PiConversation { resume?: boolean; offset?: number; model?: AgentModel; boundary(stage: string, recovery?: string): Promise<{prompt?: string, messages?: string[]}> }
/**
 * A service assistant's turn (#1253): the control plane's side of what the native loop does around each model request.
 * `steer` gives the messages to send after the prompt, read just before the session starts; `boundary` answers each turn
 * boundary between tool batches with more of them. `text` hears the answer as it is written (from the gateway's stream, or
 * from the runner with a direct connection), `responded` each model response ending, with or without tool calls, and
 * `retry` each retry Pi makes itself over a direct connection.
 */
export interface PiServiceTurn {
  steer(): string[];
  boundary(): Promise<{ messages?: string[] }>;
  text(delta: string): Promise<void>;
  responded(toolCalls: boolean): void;
  retry(retry: { retry: number; retries: number; delay_ms: number; error: string }): Promise<void>;
}
/**
 * One Pi session in a task workspace, driven through the runner mailbox. The control plane keeps the provider boundary
 * for explicit gateway mode, the tool allowlist and every platform write; direct mode lets the native SDK connect to its provider. The runner process runs
 * the Pi SDK loop with the tools named in config.
 */
export interface PiSession<T> {
  store: Store;
  results?: ResultSession;
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
}

export function piAdapter<T>(session: PiSession<T>) {
  const { store, taskId, guard, workspace, redactor, config, conversation, signal, service } = session, key = session.key ?? 'pi';
  const task=store.get('SELECT * FROM tasks WHERE id=?',taskId)??{id:taskId};
  const resultFiles=session.results??new ResultSession(store,resultScope(store,task),()=>projectResultOwner(task.repository_id),guard,redactor.values,()=>true);
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
  return async ({ request, model, outputTokens }: AgentServices): Promise<T> => {
    config.model_transport = modelTransport(config.model_transport);
    if(config.model_transport==='direct'){
      config.native_model={...nativeModelConnection(model),model:model.model};
      redactor.add(model.key);
    }
    config.model = model.capabilities
      ? { context_window: model.capabilities.context_window, max_output_tokens: model.capabilities.max_output_tokens, reasoning: model.capabilities.reasoning, image_input: model.capabilities.image_input !== false }
      : { context_window: 128000, max_output_tokens: 8192, reasoning: false, image_input: true };
    config.output_tokens = outputTokens ?? config.model.max_output_tokens;
    const finishingNames=new Set(session.finalizationTools??config.finish_tools??[]);
    if(session.maxRequests!==undefined&&finishingNames.size&&session.maxRequests<=finalizationReserve(session.maxRequests))
      stop('role_budget_exhausted','waiting_configuration','剩余请求不足以保留至少一轮工作和收尾，Pi 会话尚未启动。');
    // Revising an unpublished result continues this execution; later tasks choose a fresh model.
    if (conversation) conversation.model = model;
    if (session.runtime) {
      const runtime = await deliver(key + ':runtime', { type: 'workspace_agent_runtime' });
      if (runtime.error === 'runner_operation_failed') stop('execution_interrupted', 'waiting_environment', '查询 Pi 运行时信息时中断。');
      if (runtime.error || runtime.agent !== 'pi') stop('pi_runtime_unavailable', 'waiting_environment', '项目电脑的 runner 不支持 Pi 运行时查询，请升级项目电脑镜像。');
      session.runtime.report(runtime);
      if (runtime.version !== session.runtime.version) stop('harness_version_mismatch', 'waiting_configuration', `项目电脑的 Pi 版本是 ${runtime.version}，角色配置固定的是 ${session.runtime.version}；不会换用其他版本。`);
    }
    // Messages that arrived before the session starts join right after its prompt, as they would before a first native request.
    if (service) { config.service_turn = true; config.steer = service.steer(); }
    // The private runner bootstrap carries a native provider credential, never a tool result or prompt.
    const wireConfig=redactor.clean(config);if(config.model_transport==='direct')wireConfig.native_model=config.native_model;
    const bytes = Buffer.from(JSON.stringify(wireConfig)); if (bytes.length > 2 * 1024 * 1024) stop('agent_context_too_large', 'waiting_configuration', `执行上下文大小 ${bytes.length} 字节，超过 2 MiB 上限。`);
    if (!conversation?.resume && !session.resume) {
      for (let offset = 0; offset < bytes.length; offset += 30000) {
        const saved = await workspace.call(key + ':config:' + offset, { type: 'workspace_agent_config', base64: bytes.subarray(offset, offset + 30000).toString('base64'), offset, final: offset + 30000 >= bytes.length });
        if (saved.error) stop('execution_interrupted', 'waiting_environment', `写入执行配置时中断，offset=${offset}。`);
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
        // Read-only liveness/event polls are safe to repeat; deliver() avoids flooding task_tools and task_history (#1266).
        const state = await deliver(`${key}:poll:${randomId()}`, { type: 'workspace_agent_poll', offset });
        await guard();
        if (backgroundError !== null) throw backgroundError;
        for (const event of state.events || []) {
          // A service turn's streamed text goes to its conversation, not the log: the model event that ends it has it all.
          if (service && event.type === 'text_delta') { if (event.text) await service.text(redactor.text(String(event.text))); continue; }
          if (service && event.type === 'model_retry') await service.retry({ retry: Number(event.retry) || 1, retries: Number(event.retries) || 1, delay_ms: Number(event.delay_ms) || 0, error: redactor.text(String(event.error ?? '')) });
          if (service && event.type === 'model' && !event.agent) service.responded(Array.isArray(event.tool_calls) && event.tool_calls.length > 0);
          workspace.log(redactor.clean(Object.fromEntries(Object.entries(event).filter(([name]) => !/^(reasoning.*|thinking.*|analysis)$/i.test(name)))));
        }
        offset = state.offset || offset;
        if (conversation) conversation.offset = offset;
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
          for (let at = 0; at < reply.length; at += 30000) {
            const sent = await workspace.call(`${key}:boundary:${id}:${at}`, { type: 'workspace_agent_boundary', request_id: id, base64: reply.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= reply.length });
            if (sent.error) stop('execution_interrupted', 'waiting_environment');
          }
          answered.add('boundary:' + id); answered.add('resumed'); continue;
        }
        if (state.state === 'completed' || state.state === 'review_ready') {
          if (inFlight.size) await Promise.allSettled([...inFlight.values()]);
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
            // Not a model tool: the runner asks for the task's worktree before a file tool or command can run (#769).
            if (kind === 'workspace') {
              const reply = session.ensureWorkspace ? await abortable(session.ensureWorkspace()) : { error: 'workspace_unavailable' };
              await deliverMailboxToolReply(redactor.clean(reply), id, chunk => workspace.deliver(chunk), '发送工作区结果时中断。');
              return;
            }
            if (kind === 'repository' && ['store_command_result','store_tool_result','read_tool_result'].includes(name)) {
              await guard();
              let result: any = {error:'tool_not_allowed'};
              if (name === 'read_tool_result' && session.offered(name)) result = await resultFiles.read(args);
              else if (name === 'store_tool_result' && session.offered(args?.name)) result = resultFiles.preserve(args.value,args.name);
              else if (name === 'store_command_result' && session.offered('run_command') && /^[a-f0-9]{48}$/.test(args?.output_id ?? '')) {
                result=await resultFiles.run(()=>commandResult({...args.preview,truncated:true,output_file:'journal'},'pi:'+args.output_id,
                  offset=>workspace.deliver({type:'workspace_agent_result',request_id:args.output_id,offset})),true);
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
            else result = !offered || !session.repository ? { error: 'tool_not_allowed' } : await resultFiles.execute(name,args,()=>abortable(session.repository!(name,args)));
            await deliverMailboxToolReply(redactor.clean(result), id, chunk => workspace.deliver(chunk), '发送仓库读取结果时中断。');
          });
        }

        if (state.request && !answered.has(state.request.id)) {
          if (inFlight.size) await Promise.allSettled([...inFlight.values()]);
          if (backgroundError !== null) throw backgroundError;
          let fullRequest = state.request;
          if (state.request.chunked) {
            const parts: Buffer[] = [];
            let readAt = 0;
            for (;;) {
              const chunkRes = await workspace.deliver({ type: 'workspace_agent_request', request_id: state.request.id, offset: readAt });
              if (chunkRes?.error === 'agent_request_changed' || (chunkRes?.error === 'runner_operation_failed' && typeof chunkRes?.detail === 'string' && chunkRes.detail.includes('agent_request_changed'))) {
                fullRequest = null;
                break;
              }
              if (chunkRes?.error) stop('execution_interrupted', 'waiting_environment', `读取大型模型请求时中断：${String(chunkRes.detail || chunkRes.error)}。`);
              const buf = Buffer.from(String(chunkRes.base64 || ''), 'base64');
              parts.push(buf);
              readAt += buf.length;
              if (readAt > imageRequestLimit + 256 * 1024) stop('model_request_invalid', undefined, `含图模型请求超过 ${Math.round(imageRequestLimit / (1024 * 1024))} MiB 上限。`);
              if (!buf.length || readAt >= Number(chunkRes.size || 0)) break;
            }
            if (!fullRequest) continue;
            fullRequest = JSON.parse(Buffer.concat(parts).toString('utf8'));
          }
          const sendModelReply = async (replyStatus: number, replyContentType: string, replyBody: string) => {
            const replyBuf = Buffer.from(JSON.stringify({ status: replyStatus, content_type: replyContentType, body: replyBody }));
            for (let at = 0; at < replyBuf.length; at += 30000) {
              const wrote = await workspace.call(`${key}:reply:${state.request.id}:${at}`, { type: 'workspace_agent_reply', request_id: state.request.id, base64: replyBuf.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= replyBuf.length });
              if (wrote.error) stop('execution_interrupted', 'waiting_environment', `向任务执行进程发送模型响应时中断，offset=${at}。`);
            }
            answered.add(state.request.id);
          };
          const body = fullRequest.body;
          const hasImages = hasImageContent(body);
          const maxBytes = hasImages ? imageRequestLimit : requestLimit;
          if (!body || !Array.isArray(body.messages) || Buffer.byteLength(JSON.stringify(body)) > maxBytes || (hasImages && textRequestBytes(body) > requestLimit)) {
            if (hasImages) {
              const message = `Model request exceeded limits (2 MiB text ceiling or ${Math.round(imageRequestLimit / (1024 * 1024))} MiB image request ceiling).`;
              await sendModelReply(413, 'application/json', JSON.stringify({ error: { type: 'invalid_request_error', code: 'request_too_large', message } }));
              continue;
            }
            stop('model_request_invalid', undefined, '模型请求缺少 messages 数组，或请求内容超过 2 MiB 上限。');
          }
          if(body.tools?.some((tool:any)=>['read_playbook','select_playbooks'].includes(tool.function?.name))) stop('execution_interrupted','waiting_environment','旧执行会话仍包含已退役指南工具；保留任务记录并在新工作区恢复。');
          if(body.tools?.some((tool:any)=>['create_task','manage_task','list_managed_tasks'].includes(tool.function?.name)&&!session.offered(tool.function.name))) stop('execution_interrupted','waiting_environment','旧执行会话仍包含不再获准的任务管理工具；保留任务记录并在新工作区恢复。');
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
          if (!conversation && turn > 0 && taskId) {
            const continuedUpdates = consumePendingTaskUpdates(store, taskId);
            if (continuedUpdates.length) {
              body.messages.push({
                role: 'user',
                content: 'New events continued into this task while it was running; incorporate these facts before finishing (recorded contract and authority remain binding):\n' + JSON.stringify(redactor.clean(continuedUpdates)),
              });
            }
          }
          store.run('UPDATE tasks SET model_started=1 WHERE id=?', taskId);
          let lastProgress = -Infinity, sequence = 0, heartbeat: ReturnType<typeof setInterval> | undefined;
          const ping = async () => {
            const sent = await workspace.deliver({ type: 'workspace_agent_progress', request_id: state.request.id, sequence: ++sequence });
            if (sent.error) stop('execution_interrupted', 'waiting_environment', '向任务执行进程发送模型 token 活动通知时中断。');
          };
          const onRetry = async () => { await ping(); heartbeat ??= setInterval(() => { void ping().catch(() => {}); }, 30000); };
          let modelResult: Awaited<ReturnType<typeof request>>;
          try {
            modelResult = await abortable(request(body, String(state.request.id), async delta => {
              if (service && typeof delta?.content === 'string' && delta.content) await service.text(redactor.text(delta.content));
              if (Date.now() - lastProgress < 1000) return;
              lastProgress = Date.now();
              await ping();
            }, undefined, { onRetry })).finally(() => clearInterval(heartbeat));
          } catch (error) {
            const recoverableImageRejection = hasImages && error instanceof TaskError
              && (error.code === 'model_request_invalid' || /^model_http_(400|413|415|422)$/.test(error.code));
            if (!recoverableImageRejection) throw error;
            const match = /^model_http_(\d+)$/.exec(error.code);
            const httpStatus = match ? Number(match[1]) : 413;
            const detail = redactor.text(String(error.detail || error.code)).slice(0, 500);
            await sendModelReply(httpStatus, 'application/json', JSON.stringify({ error: { type: 'invalid_request_error', code: error.code, message: `${error.code}: ${detail}` } }));
            continue;
          }
          const { value, status, model: used } = modelResult;
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
          await sendModelReply(status, contentType, responseBody);
          continue;
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
  service?: PiServiceTurn;
}
