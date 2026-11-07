import { checkpoint } from '../tasks/checkpoint.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTools, playbookInstructions, playbooks } from '../tasks/playbooks.js';
import { type Store, type Row } from '../storage/database.js';
import { type Workspace } from './workspace.js';
import { workspaceProfile } from './profiles.js';
import { runAgent, type AgentSpec } from './runtime.js';
import { type Redactor, stop, TaskError } from './common.js';
import { validateReview, validateReply } from '../review/findings.js';
import { taskWorkflow, workflowPermissions, savedWorkflow } from '../workflows/resolve.js';
import { randomId } from '../core/security.js';
import { type ReadTokens } from './read-token.js';
import type { AgentModel } from './gateway.js';
import { RepositoryExplorer, repositoryTools } from './exploration.js';

export interface ReviewConversation { history?: any[]; resume?: boolean; offset?: number; model?: AgentModel; boundary(stage: string): Promise<{prompt?: string, messages?: string[]}> }
/** The platform's write tools for this task, by tool name: the control plane performs the write and answers the agent. */
export type PlatformTools = Record<string, (id: string, args: any) => Promise<any>>;

export async function agentLoop(store: Store, task: Row, workspace: Workspace, redactor: Redactor, guard: () => Promise<void>, context: any, tokens?: ReadTokens, createPullRequest?: (id: string, result: any) => Promise<any>, conversation?: ReviewConversation, platform: PlatformTools = {}, limits: Pick<AgentSpec<unknown>, 'modelAttempts'> = {}) {
  try { return await run(store, task, workspace, redactor, guard, context, tokens, createPullRequest, conversation, platform, limits); }
  // A token the agent exchanged is useless after the model phase; revoke it however the phase ends.
  finally { await tokens?.revoke(); }
}
async function run(store: Store, task: Row, workspace: Workspace, redactor: Redactor, guard: () => Promise<void>, context: any, tokens?: ReadTokens, createPullRequest?: (id: string, result: any) => Promise<any>, conversation?: ReviewConversation, platform: PlatformTools = {}, limits: Pick<AgentSpec<unknown>, 'modelAttempts'> = {}) {
  // Permissions and a custom workflow's prompt are read from trusted storage here, for every caller and every attempt.
  const workflowId = taskWorkflow(task as any), saved = String(task.kind).startsWith('workflow.') ? savedWorkflow(store, task.repository_id, workflowId) : undefined;
  if (String(task.kind).startsWith('workflow.') && !saved) stop('workflow_not_found', 'cancelled', `工作流 ${workflowId} 已删除。`);
  const profile = workspaceProfile(String(task.kind), context, workflowPermissions(store, task.repository_id, workflowId), saved ? { id: workflowId, name: String(saved.name), prompt: String(saved.prompt ?? '') } : undefined);
  const explorer = tokens && Object.keys(profile.capabilities.github.permissions).length ? new RepositoryExplorer(tokens, redactor, guard) : null;
  const records = new TaskRecords(store);
  for(const tool of taskTools) {
    profile.tools.push(tool as any);
    platform[tool.function.name]=async(_id,args)=>{
      const result=records.tool(task.id,tool.function.name,redactor.clean(args));
      if(!('error' in result)&&tool.function.name==='record_progress'&&profile.capabilities.workspace.write)await checkpoint(store,task,workspace);
      return result;
    };
  }
  const system = profile.system + '\n' + playbookInstructions;
  context={...context,playbook_request:JSON.parse(task.input||'{}').playbook_request||null,playbook_catalog:playbooks.map(({content,...p})=>p),structured_task:store.get('SELECT 1 FROM tasks WHERE id=?',task.id)?records.get(task.id):null};
  // Only development ends with its pull request; any other workflow that may open one carries on to its own finish.
  const config = { system, prompt: JSON.stringify({ ...context, effective_rules: undefined, review_rules: undefined }), tools: profile.tools, capabilities: profile.capabilities, workspace_id: task.workspace_id, review_session: !!conversation,
    finish_on_pull_request: profile.completion === 'publication', finish_tools: profile.finishTools,
    ...(profile.subagentSystem ? { subagent_system: profile.subagentSystem } : {}) };
  return runAgent({ store, task, redactor, guard, system, modelAttempts: limits.modelAttempts, prompt: config.prompt, tools: profile.tools, model: conversation?.model, adapter: async ({ request, model }) => {
    // Revising an unpublished result continues this execution; later tasks choose a fresh model.
    if (conversation) conversation.model = model;
    const bytes = Buffer.from(JSON.stringify(redactor.clean(config))); if (bytes.length > 2 * 1024 * 1024) stop('agent_context_too_large', 'waiting_configuration', `执行上下文大小 ${bytes.length} 字节，超过 2 MiB 上限。`);
    if (!conversation?.resume) {
      for (let offset = 0; offset < bytes.length; offset += 30000) {
        const saved = await workspace.call('pi:config:' + offset, { type: 'workspace_agent_config', base64: bytes.subarray(offset, offset + 30000).toString('base64'), offset, final: offset + 30000 >= bytes.length });
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
    const started = await workspace.call('pi:' + (conversation?.resume ? 'continue:' : 'start:') + randomId(), { type: conversation?.resume ? 'workspace_agent_continue' : 'workspace_agent_start' });
    if (started.error) stop('execution_interrupted', 'waiting_environment', '启动任务执行进程时中断。');
    // No deadline and no model request budget: the task runs until the agent finishes. Disabling the project or
    // stopping its computer ends it (guard() and the interrupted poll below).
    // A request stays visible until the agent picks up its reply; answering it twice would call the model twice.
    let offset = conversation?.offset || 0, publication: any; const answered = new Set<string>();
    for (;;) {
      await guard();
      const state = conversation ? await workspace.deliver({ type: 'workspace_agent_poll', offset })
        : await workspace.call('pi:poll:' + randomId(), { type: 'workspace_agent_poll', offset });
      if(conversation)await guard();
      for (const event of state.events || []) workspace.log(redactor.clean(event)); offset = state.offset || offset;
      if(conversation)conversation.offset=offset;
      // A finished agent can leave more than one page of events; retain the tail before exiting.
      if (state.has_more && ['completed','review_ready','failed','interrupted'].includes(state.state)) continue;
      if (conversation?.resume && state.state === 'review_ready' && !answered.has('resumed')) {
        // The continue command can be visible before the runner leaves its ready state.
        await new Promise(resolve => setTimeout(resolve, 50)); continue;
      }
      if (state.boundary && conversation && !answered.has('boundary:' + state.boundary.id)) {
        const id = String(state.boundary.id);
        if (!/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid');
        const reply = Buffer.from(JSON.stringify(redactor.clean(await conversation.boundary(state.boundary.stage))));
        if (reply.length > 32 * 1024 * 1024) stop('agent_context_too_large');
        for (let at = 0; at < reply.length; at += 30000) {
          const sent = await workspace.call(`pi:boundary:${id}:${at}`, { type: 'workspace_agent_boundary', request_id: id, base64: reply.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= reply.length });
          if (sent.error) stop('execution_interrupted', 'waiting_environment');
        }
        answered.add('boundary:' + id); answered.add('resumed'); continue;
      }
      if (state.state === 'completed' || state.state === 'review_ready') {
        if (state.state === 'review_ready') {
          const chunks: Buffer[] = []; let size = 1;
          for (let at = 0; at < size; at += 45000) {
            const part = await workspace.deliver({ type: 'workspace_agent_session', offset: at });
            if (part.error || !Number.isSafeInteger(part.size) || part.size > 32 * 1024 * 1024 || typeof part.base64 !== 'string') stop('agent_context_too_large');
            size = part.size; chunks.push(Buffer.from(part.base64, 'base64'));
          }
          const messages = JSON.stringify(redactor.clean(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          store.run('UPDATE tasks SET messages=? WHERE id=?', messages, task.id);
        }
        const result = redactor.clean(state.result);
        if (profile.completion === 'review') return validateReview(result);
        if (profile.completion === 'reply') return validateReply(result);
        // An event workflow's result is checked by its own module; the log windows the agent read go with it.
        if (profile.completion !== 'publication') return { ...result, read_logs: redactor.clean(explorer?.logs ?? []) };
        if (!publication) stop('create_pull_request_required', undefined, '开发执行已结束，但没有通过 create_pull_request 创建或更新 PR。');
        return publication;
      }
      // A failed agent carries error as well, so it takes this path and is retried in a fresh workspace; its reason is kept.
      if (state.error === 'agent_context_too_large') stop('agent_context_too_large', 'failed', '会话压缩后仍超过 2 MiB 或 128k 上下文上限；重试将使用空会话。');
      if (state.state === 'failed') workspace.log({ type: 'agent_failure', error: state.error || null, detail: redactor.text(String(state.detail || '')).slice(0, 1000) || null });
      if (state.error || ['interrupted', 'missing'].includes(state.state)) stop('execution_interrupted', 'waiting_environment', state.state === 'failed'
        ? `任务执行进程失败：${redactor.text(String(state.detail || '没有返回原因')).replace(/\s+/g, ' ').slice(0, 300)}。`
        : `轮询任务执行进程时中断，状态=${state.state||'未知'}，offset=${offset}。`);
      if (state.state === 'failed') stop('pi_execution_failed', undefined, `任务执行进程返回 failed 状态${state.detail ? '：' + redactor.text(String(state.detail)).replace(/\s+/g, ' ').slice(0, 300) : ''}，请查看此前的执行日志。`);
      if (state.pull_request && !answered.has('pr:' + state.pull_request.id)) {
        if (profile.capabilities.github.publication !== 'pull_request' || !createPullRequest) stop('create_pull_request_not_allowed', undefined, '当前任务不允许调用 create_pull_request。');
        const id = String(state.pull_request.id), args = redactor.clean(state.pull_request.arguments);
        if (!/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid', undefined, 'create_pull_request 请求 ID 格式无效，应为 48 位十六进制字符。');
        let reply: any;
        if (args?.change_title!==undefined && (typeof args.change_title!=='string'||!args.change_title.trim()||args.change_title.length>500||/[\r\n]/.test(args.change_title))) reply = { error: 'model_change_title_invalid' };
        else if (!args || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 2000 || typeof args.test_command !== 'string' || !args.test_command.trim() || args.test_command.length > 2048) reply = { error: 'model_development_invalid' };
        else reply = await createPullRequest!(id, args);
        reply = redactor.clean(reply);
        const bytes = Buffer.from(JSON.stringify(reply));
        for (let at = 0; at < bytes.length; at += 30000) {
          const sent = await workspace.call(`pi:pr-reply:${id}:${at}`, { type: 'workspace_agent_pull_request', request_id: id, base64: bytes.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= bytes.length });
          if (sent.error) stop('execution_interrupted', 'waiting_environment', `发送 PR 发布结果时中断，offset=${at}。`);
        }
        if (profile.completion === 'publication' && (reply.pr || reply.status === 'no_changes')) publication = { ...args, ...reply };
        answered.add('pr:' + id); continue;
      }
      if (state.token_request && !answered.has('token:' + state.token_request.id)) {
        const id = String(state.token_request.id);
        let reply: any;
        try {
          if (!Object.keys(profile.capabilities.github.permissions).length) stop('github_read_token_not_allowed', undefined, '这条工作流没有 GitHub 读取权限。');
          if (!tokens || !explorer) stop('github_read_token_unavailable', undefined, '当前任务未配置 GitHub 只读令牌服务。');
          const client = await explorer!.connect();
          reply = { token: client.token, repository: client.fullName, permissions: client.permissions, expires_at: client.expiresAt };
        }
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
        const offered = profile.tools.some(tool => tool.function.name === name);
        let result: any;
        // A write tool the workflow allows is performed by the control plane; its answer goes back like a repository read.
        if (Object.hasOwn(platform, name)) result = offered ? await platform[name]!(id, args) : { error: 'write_not_allowed' };
        else {
          const allowed = repositoryTools.some(tool => tool.function.name === name) && offered;
          // A living Pi may retain its read token across a control-plane restart; establish this executor's client too.
          const access = allowed && explorer ? await explorer.execute('github_read_token', {}) : null;
          result = !allowed ? { error: 'tool_not_allowed' } : !explorer ? { error: 'github_read_token_unavailable' } : access?.error ? access : await explorer.execute(name, args);
        }
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
        store.run('UPDATE tasks SET model_started=1 WHERE id=?', task.id);
        let lastProgress = -Infinity, sequence = 0;
        const { value, status, model } = await request(body, String(state.request.id), async () => {
          if (Date.now() - lastProgress < 1000) return;
          lastProgress = Date.now();
          const sent = await workspace.deliver({ type: 'workspace_agent_progress', request_id: state.request.id, sequence: ++sequence });
          if (sent.error) stop('execution_interrupted', 'waiting_environment', '向任务执行进程发送模型 token 活动通知时中断。');
        });
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
          const chunk = (part: any, finish: any = null) => JSON.stringify({ id: value.id || state.request.id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: model.model, choices: [{ index: 0, delta: part, finish_reason: finish }], usage: value.usage });
          responseBody = 'data: ' + chunk(delta) + '\n\ndata: ' + chunk({}, message.tool_calls?.length ? 'tool_calls' : 'stop') + '\n\ndata: [DONE]\n\n'; contentType = 'text/event-stream';
        }
        const reply = Buffer.from(JSON.stringify({ status, content_type: contentType, body: responseBody }));
        for (let at = 0; at < reply.length; at += 30000) {
          const wrote = await workspace.call(`pi:reply:${state.request.id}:${at}`, { type: 'workspace_agent_reply', request_id: state.request.id, base64: reply.subarray(at, at + 30000).toString('base64'), offset: at, final: at + 30000 >= reply.length });
          if (wrote.error) stop('execution_interrupted', 'waiting_environment', `向任务执行进程发送模型响应时中断，offset=${at}。`);
        }
        // The agent continues as soon as it has the reply; poll again right away instead of waiting.
        answered.add(state.request.id); continue;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }});
}
