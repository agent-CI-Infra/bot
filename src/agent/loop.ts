import { taskTraceAccess } from '../memory/access.js';
import { taskConfiguration } from '../tasks/configuration.js';
import { developmentTeam } from '../roles/development.js';
import { controlled } from '../roles/run.js';
import { runTeam } from '../roles/team.js';
import { roleWorkspaces, executorWorkspace } from '../roles/workspace.js';
import { ProjectMemory,memoryTools,memoryTool } from '../memory/project.js';
import { checkpoint } from '../tasks/checkpoint.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTools, playbookInstructions, playbooks } from '../tasks/playbooks.js';
import { type Store, type Row } from '../storage/database.js';
import { type Workspace } from './workspace.js';
import { workspaceProfile } from './profiles.js';
import { runAgent, type AgentSpec } from './runtime.js';
import { type Redactor, stop, blobSha } from './common.js';
import { piAdapter, type PiSession } from './pi.js';
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
  const workflowId = taskWorkflow(task as any), saved = String(task.kind).startsWith('workflow.') ? (taskConfiguration(store,task)?.workflow??savedWorkflow(store, task.repository_id, workflowId)) : undefined;
  if (String(task.kind).startsWith('workflow.') && !saved) stop('workflow_not_found', 'cancelled', `工作流 ${workflowId} 已删除。`);
  const profile = workspaceProfile(String(task.kind), context, (taskConfiguration(store,task)?.permissions??workflowPermissions(store, task.repository_id, workflowId)), saved ? { id: workflowId, name: String(saved.name), prompt: String(saved.prompt ?? '') } : undefined);
  const explorer = tokens && Object.keys(profile.capabilities.github.permissions).length ? new RepositoryExplorer(tokens, redactor, guard) : null;
  const records = new TaskRecords(store);
  for(const tool of taskTools) {
    profile.tools.push(tool as any);
    platform[tool.function.name]=async(_id,args)=>{
      const result=records.tool(task.id,tool.function.name,redactor.clean(args),taskTraceAccess(store,task));
      if(!('error' in result)&&tool.function.name==='record_progress'&&profile.capabilities.workspace.write)await checkpoint(store,task,workspace);
      return result;
    };
  }
  for(const tool of memoryTools){if(tool.function.name==='remember_project_memory'&&!profile.capabilities.workspace.notes&&!profile.capabilities.workspace.write)continue;profile.tools.push(tool as any);platform[tool.function.name]=async(_id,args)=>{await guard();return memoryTool(store,task,tool.function.name,redactor.clean(args),async doc=>{const raw=await workspace.call('memory:'+randomId(),{type:'workspace_read',path:doc.path});if(raw.error||typeof raw.content!=='string')throw new Error('memory_source_unavailable');return {content:raw.content,sha:blobSha(Buffer.from(raw.content))};});};}
  const system = profile.system + '\n' + playbookInstructions;
  context={...context,project_memory:new ProjectMemory(store).context(task),playbook_request:JSON.parse(task.input||'{}').playbook_request||null,playbook_catalog:playbooks.map(({content,...p})=>p),structured_task:store.get('SELECT 1 FROM tasks WHERE id=?',task.id)?records.get(task.id):null};
  // Only development ends with its pull request; any other workflow that may open one carries on to its own finish.
  const config = { system, prompt: JSON.stringify({ ...context, effective_rules: undefined, review_rules: undefined }), tools: profile.tools, capabilities: profile.capabilities, workspace_id: task.workspace_id, review_session: !!conversation,
    finish_on_pull_request: profile.completion === 'publication', finish_tools: profile.finishTools,
    ...(profile.subagentSystem ? { subagent_system: profile.subagentSystem } : {}) };
  if(profile.completion==='publication'&&createPullRequest&&controlled(store,task,'development'))return developmentTeam(workspace,system,config.prompt,createPullRequest,profile.capabilities.workspace);
  // The workflow's own executor: one Pi session in the task workspace (the formal Pi harness, src/agent/pi.ts).
  const session: PiSession<any> = { store, taskId: task.id, guard, workspace, redactor, config, conversation, platform, createPullRequest,
    offered: name => profile.tools.some(tool => tool.function.name === name), publication: profile.capabilities.github.publication,
    repository: async (name, args) => {
      const allowed = repositoryTools.some(tool => tool.function.name === name);
      // A living Pi may retain its read token across a control-plane restart; establish this executor's client too.
      const access = allowed && explorer ? await explorer.execute('github_read_token', {}) : null;
      return !allowed ? { error: 'tool_not_allowed' } : !explorer ? { error: 'github_read_token_unavailable' } : access?.error ? access : explorer.execute(name, args);
    },
    token: async () => {
      if (!Object.keys(profile.capabilities.github.permissions).length) stop('github_read_token_not_allowed', undefined, '这条工作流没有 GitHub 读取权限。');
      if (!tokens || !explorer) stop('github_read_token_unavailable', undefined, '当前任务未配置 GitHub 只读令牌服务。');
      const client = await explorer!.connect();
      return { token: client.token, repository: client.fullName, permissions: client.permissions, expires_at: client.expiresAt };
    },
    complete: (state, publication) => {
      const result = state.result;
      if (profile.completion === 'review') return validateReview(result);
      if (profile.completion === 'reply') return validateReply(result);
      // An event workflow's result is checked by its own module; the log windows the agent read go with it.
      if (profile.completion !== 'publication') return { ...result, read_logs: redactor.clean(explorer?.logs ?? []) };
      if (!publication) stop('create_pull_request_required', undefined, '开发执行已结束，但没有通过 create_pull_request 创建或更新 PR。');
      return publication;
    } };
  // Review and Actions analysis retain their task/tools/completion as the dev assignment. Both the controller and
  // that assignment use their configured backend; Pi retains the entry's native workspace session when selected.
  const entry = String(task.kind).startsWith('review.') ? 'review' : task.kind === 'actions.failures' ? 'actions' : null;
  if (entry && controlled(store, task, entry)) {
    const { repository, token, complete } = session, round = randomId();
    const execute = async (name: string, args: any) => {
      if (Object.hasOwn(platform, name)) return platform[name]!(randomId(), args);
      if (repositoryTools.some(t => t.function.name === name)) return repository!(name, args);
      if (name === 'github_read_token') {
        // Native backends use structured repository tools; a provider credential must never become tool output.
        const access = await token!();
        return { repository: access.repository, permissions: access.permissions, expires_at: access.expires_at,
          instruction: 'Use github_read, github_search and read_job_log for repository access.' };
      }
      const key = 'entry-tool:' + randomId();
      if (name === 'read_file') return workspace.call(key, { type: 'workspace_read', path: args?.path });
      if (name === 'write_file') {
        // Review may offer write_file for project notes without permitting repository edits.
        const note = typeof args?.path === 'string' && args.path.startsWith('../notes/');
        if (note ? !profile.capabilities.workspace.notes : !profile.capabilities.workspace.write)
          return { error: note ? 'notes_write_not_allowed' : 'review_repository_write_forbidden' };
        await workspace.write(key, args?.path, Buffer.from(args?.content ?? '')); return { written: true };
      }
      if (name === 'run_command') return workspace.call(key, { type: 'workspace_command', command: args?.command,
        timeout_ms: args?.timeout_seconds > 0 ? args.timeout_seconds * 1000 : null, keep_background: args?.keep_background === true });
      if (name === 'create_pull_request' && createPullRequest) return createPullRequest(randomId(), args);
      return { error: 'tool_not_allowed' };
    };
    const finish = profile.finishTools[0];
    return runTeam({ store, task, redactor, guard, system, modelAttempts: limits.modelAttempts, prompt: config.prompt, tools: profile.tools, model: conversation?.model,
      execute, ...(finish ? { finish: { name: finish, validate: (value: any) => complete({ result: value }, null) }, finalizationTools: [finish] } : {}) },
      { entry, prepare: async () => {}, controller: roleWorkspaces(workspace).controller, workers: ['dev'],
        executor: { round, prepare: async (instance, resolved) => resolved.snapshot.harness.id === 'pi'
          ? executorWorkspace(workspace, { config, conversation, platform, repository, token, createPullRequest, publication: profile.capabilities.github.publication, complete }, round)(instance, resolved)
          : undefined } });
  }
  return runAgent({ store, task, redactor, guard, system, modelAttempts: limits.modelAttempts, prompt: config.prompt, tools: profile.tools, model: conversation?.model, adapter: piAdapter(session) });
}
