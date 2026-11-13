import {GitHub} from '../github/client.js';
import { taskTraceAccess } from '../memory/access.js';
import { taskConfiguration, taskPermissions } from '../tasks/configuration.js';
import { developmentTeam } from '../roles/development.js';
import { controlled } from '../roles/run.js';
import { runTeam } from '../roles/team.js';
import { roleWorkspaces, executorWorkspace } from '../roles/workspace.js';
import { ProjectMemory,memoryTools,memoryTool } from '../memory/project.js';
import { checkpoint } from '../tasks/checkpoint.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTools, taskRecordInstructions } from '../tasks/record-tools.js';
import { type Store, type Row } from '../storage/database.js';
import { type Workspace } from './workspace.js';
import { workspaceProfile, roleAssignmentContext } from './profiles.js';
import { runAgent, type AgentSpec } from './runtime.js';
import { type Redactor, stop, blobSha, TaskError } from './common.js';
import { piAdapter, type PiSession } from './pi.js';
import { validateReview, validateReply } from '../review/findings.js';
import { workType } from '../work/catalog.js';
import { sectionText } from '../work/settings.js';
import { randomId } from '../core/security.js';
import { type ReadTokens } from './read-token.js';
import type { AgentModel } from './gateway.js';
import { RepositoryExplorer, repositoryTools } from './exploration.js';
import { permissionTools } from '../roles/permissions.js';
import { taskReadScopes, taskRolePolicies, taskToolAllowed, withTaskPermissions } from '../tasks/management.js';

export interface ReviewConversation { history?: any[]; resume?: boolean; offset?: number; model?: AgentModel; boundary(stage: string): Promise<{prompt?: string, messages?: string[]}> }
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
  const reply = String(task.kind).startsWith('workflow.'), legacy = reply && task.workflow_id ? taskConfiguration(store,task)?.workflow : undefined;
  const prompt = !reply ? undefined : legacy ? { id: String(legacy.id), name: String(legacy.name), prompt: String(legacy.prompt ?? '') }
    : { id: 'reply', name: workType('reply')!.name, prompt: sectionText(store, task.repository_id, 'reply') };
  const profile = workspaceProfile(String(task.kind), context, taskPermissions(store, task), prompt);
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
  const system = profile.system + '\n' + taskRecordInstructions;
  context={...context,project_memory:new ProjectMemory(store).context(task),structured_task:store.get('SELECT 1 FROM tasks WHERE id=?',task.id)?records.context(task.id):null};
  // Only development ends with its pull request; any other work that may open one carries on to its own finish.
  const config = { system, prompt: JSON.stringify(roleAssignmentContext(context, prompt)), tools: profile.tools, capabilities: profile.capabilities, workspace_id: task.workspace_id, review_session: !!conversation,
    finish_on_pull_request: profile.completion === 'publication', finish_tools: profile.finishTools,
    ...(profile.subagentSystem ? { subagent_system: profile.subagentSystem } : {}) };
  const repairInvalid = (error: unknown) => error instanceof TaskError && ['model_review_invalid','model_finding_invalid','release_notes_invalid','release_observation_invalid','actions_classification_invalid','gate_agent_output_invalid'].includes(error.code)
    ? `Correct the submission and call the finish tool again using the evidence already available. ${error.code}: ${error.detail ?? ''}` : undefined;
  if(profile.completion==='publication'&&createPullRequest&&controlled(store,task,'development'))return developmentTeam(workspace,system,config.prompt,createPullRequest,profile.capabilities.workspace,platform.github_write&&(args=>platform.github_write!(randomId(),args)),tokens?.allowedScopes().includes('contents')?async()=>{const github=new GitHub(store,tokens.repository,redactor,guard,tokens.apiUrl);await github.connect(false,undefined,{contents:'read',...(tokens.allowedScopes().includes('pull_requests')?{pull_requests:'read'}:{})},false);return github;}:undefined);
  // The work type's own executor: one Pi session in the task workspace (the formal Pi harness, src/agent/pi.ts).
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
      // GitHub shares some GET routes between resources. Partial policies must use the checked gateway, not raw shell API calls.
      if(!['issues','pull_requests','contents','actions','checks','statuses'].every(scope=>tokens!.allowedScopes().includes(scope)))
        return { structured_only:true,repository:client.fullName,permissions:client.permissions,expires_at:client.expiresAt,
          instruction:'Use github_read, github_search and read_job_log. This resource policy does not put a token into command environment variables.' };
      return { token: client.token, repository: client.fullName, permissions: client.permissions, expires_at: client.expiresAt };
    },
    complete: (state, publication) => {
      const result = state.result;
      limits.validateSubmission?.(result);
      if (profile.completion === 'review') return validateReview(result);
      if (profile.completion === 'reply') return validateReply(result);
      // An event workflow's result is checked by its own module; the log windows the agent read go with it.
      if (profile.completion !== 'publication') return { ...result, read_logs: redactor.clean(explorer?.logs ?? []) };
      if (!publication) stop('create_pull_request_required', undefined, '开发执行已结束，但没有通过 create_pull_request 创建或更新 PR。');
      return publication;
    } };
  // Review and Actions analysis retain their task/tools/completion as the dev assignment. Both the controller and
  // that assignment use their selected backend; old V2 entries retain Pi until the dev backend changes.
  const entry = String(task.kind).startsWith('review.') ? 'review' : task.kind === 'actions.failures' ? 'actions' : null;
  if (entry && controlled(store, task, entry)) {
    const { repository, token, complete } = session, round = randomId(), spaces=roleWorkspaces(workspace);
    const staged=!!records.get(task.id).stage_schedule.plan_revision||!!(taskConfiguration(store,task)?.roles?.required_stages?.length);
    const execute = async (name: string, args: any) => {
      if(staged&&spaces.role!=='dev'&&['read_file','run_command'].includes(name))return spaces.current.call('stage-observation:'+randomId(),name==='read_file'?{type:'workspace_read',path:args?.path}:{type:'workspace_command',command:args?.command,timeout_ms:120000});
      if(staged&&spaces.role!=='dev'&&memoryTools.some(tool=>tool.function.name===name))return memoryTool(store,{...task,active_role:spaces.role,trace_run_id:spaces.runId},name,redactor.clean(args),async doc=>{const raw=await spaces.current.call('stage-memory:'+randomId(),{type:'workspace_read',path:doc.path});if(raw.error||typeof raw.content!=='string')throw new Error('memory_source_unavailable');return {content:raw.content,sha:blobSha(Buffer.from(raw.content))};});
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
        if (note) return workspace.call(key, { type: 'workspace_write', path: args.path,
          base64: Buffer.from(args?.content ?? '').toString('base64'), offset: 0, final: true, mode: '100644' });
        await workspace.write(key, args?.path, Buffer.from(args?.content ?? '')); return { written: true };
      }
      if (name === 'run_command') return workspace.call(key, { type: 'workspace_command', command: args?.command,
        timeout_ms: args?.timeout_seconds > 0 ? args.timeout_seconds * 1000 : null, keep_background: args?.keep_background === true });
      if (name === 'create_pull_request' && createPullRequest) return createPullRequest(randomId(), args);
      return { error: 'tool_not_allowed' };
    };
    const finish = profile.finishTools[0];
    return runTeam({ store, task, redactor, guard, system, modelAttempts: limits.modelAttempts, repairInvalid, prompt: config.prompt, tools: profile.tools, model: conversation?.model,
      execute: async (name, args) => {
        try { return await execute(name, args); }
        catch (error) { if (error instanceof TaskError) return { error: error.code }; throw error; }
      }, ...(finish ? { finish: { name: finish, validate: (value: any) => complete({ result: value }, null) }, finalizationTools: [finish] } : {}) },
      { entry, prepare: staged?spaces.prepare:async () => {}, controller:spaces.controller,worker:spaces.worker,...(staged?{withRole:spaces.withRole,withObservers:spaces.withObservers,bindRun:spaces.bindRun,snapshot:spaces.snapshot,isolated:spaces.isolated}:{workers:['dev']}),
        executor: { round, prepare: async (instance, resolved) => resolved.snapshot.harness.id === 'pi'
          ? executorWorkspace(workspace, { config, conversation, platform, repository, token, createPullRequest, publication: profile.capabilities.github.publication, complete }, round)(instance, resolved)
          : undefined } });
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
  let submitted:{value:any}|undefined,repairs=0;
  Object.assign(config,{control_tools:profile.finishTools.filter(name=>initial.includes(name))});
  session.control=async(name,args)=>{
    if(!profile.finishTools.includes(name))return {result:{error:'tool_not_allowed'}};
    try {const value=await complete({result:args},null);submitted={value};return {result:{submitted:true,submission:args,submission_name:name},finish:true};}
    catch(error){const feedback=repairInvalid(error);if(!feedback||repairs++>=2)throw error;return {result:{error:'invalid_submission',message:redactor.text(feedback)}};}
  };
  session.complete=(state,publication)=>submitted?submitted.value:complete(state.result?.submitted===true?{...state,result:state.result.submission}:state,publication);
  return withTaskPermissions(store,task,'dev',fixed,()=>runAgent({ store, task, redactor, guard:liveGuard, system, modelAttempts: limits.modelAttempts, prompt: config.prompt, tools: profile.tools, model: conversation?.model, adapter: piAdapter(session) }));
}
