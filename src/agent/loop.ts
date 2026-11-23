import { readToolResult } from './tool-results.js';
import { submissionFeedback } from '../roles/submission-feedback.js';
import { resolveCommandTimeout, retimeCommandTool, runCommand } from './command.js';
import {GitHub} from '../github/client.js';
import { taskTraceAccess } from '../memory/access.js';
import { taskConfiguration, taskPermissions } from '../tasks/configuration.js';
import { developmentTeam } from '../roles/development.js';
import { controlled } from '../roles/run.js';
import { runTeam } from '../roles/team.js';
import { roleWorkspaces, executorWorkspace } from '../roles/workspace.js';
import { memoryTools, memoryTool } from '../memory/project.js';
import { checkpoint } from '../tasks/checkpoint.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTools, taskRecordInstructions } from '../tasks/record-tools.js';
import { type Store, type Row } from '../storage/database.js';
import { type Workspace } from './workspace.js';
import { workspaceProfile, roleAssignmentContext } from './profiles.js';
import { autoMergePolicy } from '../github/merge-policy.js';
import { runAgent, type AgentSpec } from './runtime.js';
import { type Redactor, stop, TaskError } from './common.js';
import { piAdapter, type PiSession } from './pi.js';
import { validateReview, validateReply } from '../review/findings.js';
import { reviewUpdateCursor } from '../review/sessions.js';
import { eventAdapterId } from '../tasks/event-adapters.js';
import { effectiveManagerPrompt } from '../dispatch/settings.js';
import { randomId } from '../core/security.js';
import { type ReadTokens } from './read-token.js';
import { RepositoryExplorer, workspaceRepositoryTools } from './exploration.js';
import { eventSubscriptionToolNames, eventSubscriptionTools, executeTaskSubscriptionTool, taskEventSubscriptionContext } from '../tasks/event-subscriptions.js';
import { permissionTools } from '../roles/permissions.js';
import { workspaceInstructions, workspaceTool, workspaceToolNames, workspaceTools } from './workspace-tools.js';
import { taskReadScopes, taskRolePolicies, taskToolAllowed, withTaskPermissions } from '../tasks/management.js';
import { milestoneTool, milestoneToolName } from '../review/progress.js';

export type ReviewConversation = import('./pi.js').PiConversation;
/** The platform's write tools for this task, by tool name: the control plane performs the write and answers the agent. */
export type PlatformTools = Record<string, (id: string, args: any) => Promise<any>>;
type LoopLimits = Pick<AgentSpec<unknown>, 'modelAttempts'> & { validateSubmission?: (result: any) => void };

export async function agentLoop(store: Store, task: Row, workspace: Workspace, redactor: Redactor, guard: () => Promise<void>, context: any, tokens?: ReadTokens, createPullRequest?: (id: string, result: any) => Promise<any>, conversation?: ReviewConversation, platform: PlatformTools = {}, limits: LoopLimits = {}) {
  try { return await run(store, task, workspace, redactor, guard, context, tokens, createPullRequest, conversation, platform, limits); }
  // A token the agent exchanged is useless after the model phase; revoke it however the phase ends.
  finally { await tokens?.revoke(); }
}
async function run(store: Store, task: Row, workspace: Workspace, redactor: Redactor, guard: () => Promise<void>, context: any, tokens?: ReadTokens, createPullRequest?: (id: string, result: any) => Promise<any>, conversation?: ReviewConversation, platform: PlatformTools = {}, limits: LoopLimits = {}) {
  // Permissions and a reply task's prompt are read from trusted storage here, for every caller and every attempt. A task of a
  // former custom workflow keeps the prompt its snapshot captured; new reply tasks follow the Manager's reply section.
  const profileKind = eventAdapterId(task) ?? String(task.kind);
  const reply = profileKind.startsWith('workflow.'), legacy = reply && task.workflow_id ? taskConfiguration(store, task)?.workflow : undefined;
  const prompt = !reply ? undefined : legacy ? { id: String(legacy.id), name: String(legacy.name), prompt: String(legacy.prompt ?? '') }
    : { id: 'reply', name: '事件回复', prompt: effectiveManagerPrompt(store, task.repository_id) };
  const profile = workspaceProfile(profileKind, context, taskPermissions(store, task), prompt, autoMergePolicy(store, String(task.repository_id)));
  const explorer = tokens && Object.keys(profile.capabilities.github.permissions).length
    ? new RepositoryExplorer(tokens, redactor, guard, {
        extract: (artifactId, data, targetPath) => workspace.extractArtifact(artifactId, data, targetPath),
        canWriteCheckout: () => profile.capabilities.workspace.write,
      })
    : null;
  const records = new TaskRecords(store);
  for(const tool of taskTools) {
    profile.tools.push(tool as any);
    platform[tool.function.name]=async(_id,args)=>{
      const result=records.tool(task.id,tool.function.name,redactor.clean(args),taskTraceAccess(store,task));
      if(!('error' in result)&&tool.function.name==='record_progress'&&profile.capabilities.workspace.write)await checkpoint(store,task,workspace);
      return result;
    };
  }
  for (const tool of eventSubscriptionTools) {
    profile.tools.push(tool as any);
    platform[tool.function.name] = async (_id, args) => {
      await guard();
      return executeTaskSubscriptionTool(store, task, tool.function.name, redactor.clean(args), { log: entry => workspace.log(entry) });
    };
  }
  for(const tool of memoryTools){if(tool.function.name==='remember_project_memory'&&!profile.capabilities.workspace.notes&&!profile.capabilities.workspace.write)continue;profile.tools.push(tool as any);platform[tool.function.name]=async(_id,args)=>{await guard();return memoryTool(store,task,tool.function.name,redactor.clean(args),workspace);};}
  // An Issue's development reports its milestones on the Issue's status comment (#1047): the engine offers the handler.
  if (platform[milestoneToolName]) profile.tools.push(milestoneTool as any);
  // Legacy review and Actions analysis under the project controller, and development under its team, run through runTeam below.
  const entry = String(task.kind).startsWith('review.') ? 'review' : profileKind === 'actions.failures' ? 'actions' : null;
  const team = !!entry && controlled(store, task, entry) || profile.completion === 'publication' && !!createPullRequest && controlled(store, task, 'development');
  // Without a role team the executing agent chooses the task's workspace itself (#769), while it holds none yet.
  const plan = workspace.plannedWorktree?.(), choosing = !team && !!plan && plan.state !== 'bound';
  if (choosing) profile.tools.push(...workspaceTools as any);
  const system = profile.system + '\n' + taskRecordInstructions + (choosing ? '\n' + workspaceInstructions : '');
  const subscriptionCtx = store.get('SELECT 1 FROM tasks WHERE id=?', task.id) ? taskEventSubscriptionContext(store, String(task.id)) : undefined;
  context={...context,structured_task:store.get('SELECT 1 FROM tasks WHERE id=?',task.id)?records.context(task.id):null,...(subscriptionCtx?{event_subscriptions:subscriptionCtx}:{})};
  // Only development ends with its pull request; any other work that may open one carries on to its own finish.
  if(!profile.tools.some(t=>t.function.name==='read_tool_result'))profile.tools.push(readToolResult);
  const entryBudget = resolveCommandTimeout(store, task, 'dev', null);
  const config = { command_timeout: { default_seconds: entryBudget.defaultSeconds, max_seconds: entryBudget.maxSeconds }, system, prompt: JSON.stringify(roleAssignmentContext(context, prompt)), tools: profile.tools, capabilities: profile.capabilities, workspace_id: task.workspace_id, review_session: !!conversation,
    finish_on_pull_request: profile.completion === 'publication', finish_tools: profile.finishTools,
    ...(profile.subagentSystem ? { subagent_system: profile.subagentSystem } : {}) };
  const repairInvalid = (error: unknown) => error instanceof TaskError && ['model_review_invalid','model_finding_invalid','release_notes_invalid','release_observation_invalid','actions_classification_invalid'].includes(error.code)
    ? `Correct the submission and call the finish tool again using the evidence already available. ${error.code}: ${error.detail ?? ''}` : undefined;
  if(profile.completion==='publication'&&createPullRequest&&controlled(store,task,'development'))return developmentTeam(workspace,system,config.prompt,createPullRequest,profile.capabilities.workspace,platform.github_write&&(args=>platform.github_write!(randomId(),args)),platform[milestoneToolName]&&(args=>platform[milestoneToolName]!(randomId(),args)),tokens?.allowedScopes().includes('contents')?async()=>{const github=new GitHub(store,tokens.repository,redactor,guard,tokens.apiUrl);await github.connect(false,undefined,{contents:'read',...(tokens.allowedScopes().includes('pull_requests')?{pull_requests:'read'}:{})},false);return github;}:undefined,explorer??undefined);
  // The work type's own executor: one Pi session in the task workspace (the formal Pi harness, src/agent/pi.ts).
  const session: PiSession<any> = { store, taskId: task.id, guard, workspace, redactor, config, conversation, platform, createPullRequest, ensureWorkspace: async () => workspace.ensure?.() ?? {},
    offered: name => profile.tools.some(tool => tool.function.name === name), publication: profile.capabilities.github.publication,
    repository: async (name, args) => {
      const allowed = workspaceRepositoryTools.some(tool => tool.function.name === name);
      // A living Pi may retain its read token across a control-plane restart; establish this executor's client too.
      const access = allowed && explorer ? await explorer.execute('github_read_token', {}) : null;
      return !allowed ? { error: 'tool_not_allowed' } : !explorer ? { error: 'github_read_token_unavailable' } : access?.error ? access : explorer.execute(name, args);
    },
    token: async () => {
      if (!Object.keys(profile.capabilities.github.permissions).length) stop('github_read_token_not_allowed', undefined, '这条工作流没有 GitHub 读取权限。');
      if (!tokens || !explorer) stop('github_read_token_unavailable', undefined, '当前任务未配置 GitHub 只读令牌服务。');
      const client = await explorer!.connect();
      // GitHub shares some GET routes between resources. Partial policies must use the checked gateway, not raw shell API calls.
      if(!['issues','pull_requests','contents','actions','checks','statuses'].every(scope=>tokens!.allowedScopes().includes(scope)))
        return { structured_only:true,repository:client.fullName,permissions:client.permissions,expires_at:client.expiresAt,
          instruction:'Use github_read, github_search and read_job_log. This resource policy does not put a token into command environment variables.' };
      return { token: client.token, repository: client.fullName, permissions: client.permissions, expires_at: client.expiresAt };
    },
    complete: (state, publication) => {
      const result = state.result;
      limits.validateSubmission?.(result);
      // A review result names the last update it covers (#1100): what its session or role had been given when it finished.
      // The platform sets it; a value the model submits is replaced.
      if (profile.completion === 'review') return String(task.kind).startsWith('review.') ? { ...validateReview(result), updates_through: reviewUpdateCursor(store, task.id) } : validateReview(result);
      if (profile.completion === 'reply') return validateReply(result);
      // An event workflow's result is checked by its own module; the log windows the agent read go with it.
      if (profile.completion !== 'publication') return { ...result, read_logs: redactor.clean(explorer?.logs ?? []) };
      if (!publication) stop('create_pull_request_required', undefined, '开发执行已结束，但没有通过 create_pull_request 创建或更新 PR。');
      return publication;
    } };
  // Review and Actions analysis retain their task/tools/completion as the dev assignment. Both the controller and
  // that assignment use their selected backend; old V2 entries retain Pi until the dev backend changes.
  if (entry && controlled(store, task, entry)) {
    const { repository, token, complete } = session, round = randomId(), spaces = roleWorkspaces(workspace);
    const execute = async (name: string, args: any) => {
      if (spaces.role && spaces.role !== 'dev' && ['read_file', 'run_command'].includes(name)) {
        return name === 'run_command'
          ? runCommand(spaces.current, 'stage-observation:' + randomId(), args, 120, spaces.role)
          : spaces.current.call('stage-observation:' + randomId(), { type: 'workspace_read', path: args?.path });
      }
      if (Object.hasOwn(platform, name)) return platform[name]!(randomId(), args);
      if (workspaceRepositoryTools.some(t => t.function.name === name)) return repository!(name, args);
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
        if (note) return workspace.call(key, { type: 'workspace_write', path: args.path,
          base64: Buffer.from(redactor.text(String(args?.content ?? ''))).toString('base64'), offset: 0, final: true, mode: '100644' });
        await workspace.write(key, args?.path, Buffer.from(args?.content ?? '')); return { written: true };
      }
      if (name === 'run_command') return runCommand(workspace, key, args, null, spaces.role);
      if (name === 'create_pull_request' && createPullRequest) return createPullRequest(randomId(), args);
      return { error: 'tool_not_allowed' };
    };
    const finish = profile.finishTools[0];
    const observerBudget = resolveCommandTimeout(store, task, undefined, 120);
    return runTeam({ store, task, redactor, guard, system, modelAttempts: limits.modelAttempts, repairInvalid, prompt: config.prompt, tools: profile.tools, model: conversation?.model,
      execute: async (name, args) => {
        try { return await execute(name, args); }
        catch (error) { if (error instanceof TaskError && error.state !== 'waiting_event') return { error: error.code }; throw error; }
      }, ...(finish ? { finish: { name: finish, validate: (value: any) => complete({ result: value }, null) }, finalizationTools: [finish] } : {}) },
      { entry, workspace, observerTools: profile.tools.map(t => t.function.name === 'run_command' ? retimeCommandTool(t, observerBudget.defaultSeconds, observerBudget.maxSeconds) : t),
        prepare: async (role: string) => profile.capabilities.workspace.write || role !== 'dev' ? spaces.prepare(role) : undefined,
        controller: spaces.controller, worker: spaces.worker,
        withRole: spaces.withRole, withObservers: spaces.withObservers, bindRun: spaces.bindRun,
        snapshot: profile.capabilities.workspace.write ? spaces.snapshot : undefined,
        executor: { round, prepare: async (instance, resolved) => resolved.snapshot.harness.id === 'pi'
          ? executorWorkspace(workspace, { config, conversation, platform, repository, token, createPullRequest, publication: profile.capabilities.github.publication, complete }, round)(instance, resolved)
          : spaces.worker(instance, resolved) } });
  }
  // Legacy single-executor entries use the same role policy as team runs. A broad runner profile cannot bypass it.
  const allowed=()=>profile.tools.filter(tool=>taskRolePolicies(store,task).every(p=>permissionTools(p).includes(tool.function.name))&&taskToolAllowed(store,task,'dev',tool.function.name));
  const initial=allowed().map(tool=>tool.function.name),scopes=taskReadScopes(store,task),fixed=taskRolePolicies(store,task);
  profile.tools=profile.tools.filter(tool=>initial.includes(tool.function.name));config.tools=profile.tools;
  const rights=profile.capabilities;
  rights.workspace.read&&=initial.includes('read_file');rights.workspace.write&&=initial.includes('write_file');
  rights.workspace.notes&&=initial.includes('write_file');rights.workspace.shell&&=initial.includes('run_command');
  rights.github.permissions=Object.fromEntries(Object.entries(rights.github.permissions).filter(([scope])=>scopes.includes(scope)));
  if(!initial.includes('create_pull_request'))rights.github.publication='none';
  const liveGuard=async()=>{await guard();const current=allowed().map(tool=>tool.function.name);
    if(initial.some(name=>!current.includes(name))||scopes.some(scope=>!taskReadScopes(store,task).includes(scope)))stop('role_authority_revoked','waiting_permission');};
  session.guard=liveGuard;
  // Legacy single-executor Pi sessions use the same live validation as role-backed entries. Keep the raw submission
  // in the runner receipt so a control-plane restart can validate it again without publishing anything twice.
  const complete=session.complete;
  let submitted:{value:any}|undefined;
  // The milestone tool and event subscription tools are control tools: the runner forwards them through the mailbox without ending.
  Object.assign(config,{control_tools:[...profile.finishTools,...choosing?workspaceToolNames:[],...eventSubscriptionToolNames,...platform[milestoneToolName]?[milestoneToolName]:[]].filter(name=>initial.includes(name))});
  session.control=async(name,args,meta)=>{
    if(choosing&&workspaceToolNames.includes(name))return {result:redactor.clean(await workspaceTool(workspace,name,redactor.clean(args),'agent',meta?.id))};
    if(eventSubscriptionToolNames.includes(name)&&platform[name])return {result:redactor.clean(await platform[name]!(meta?.id??randomId(),args))};
    if(name===milestoneToolName&&platform[name])return {result:redactor.clean(await platform[name]!(meta?.id??randomId(),args))};
    if(!profile.finishTools.includes(name))return {result:{error:'tool_not_allowed'}};
    try {const value=await complete({result:args},null);submitted={value};return {result:{submitted:true,submission:args,submission_name:name},finish:true};}
    catch(error){const feedback=submissionFeedback({store,task,redactor,repairInvalid} as import('./runtime.js').AgentSpec<any>,error);if(!feedback)throw error;return {result:feedback};}
  };
  session.complete=(state,publication)=>submitted?submitted.value:complete(state.result?.submitted===true?{...state,result:state.result.submission}:state,publication);
  return withTaskPermissions(store,task,'dev',fixed,()=>runAgent({ store, task, redactor, guard:liveGuard, system, modelAttempts: limits.modelAttempts, prompt: config.prompt, tools: profile.tools, model: conversation?.model, adapter: piAdapter(session) }));
}
