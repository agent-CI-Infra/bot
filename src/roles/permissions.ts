import { createHash } from 'node:crypto';
import type { RoleKind } from './catalog.js';

export type PermissionMode = 'none' | 'read' | 'create' | 'write' | 'allow' | 'deny' | 'custom';
export type RolePermissions = Record<string, PermissionMode>;
interface PermissionItem { id: string; name: string; modes: PermissionMode[]; read: string[]; write: string[]; detail: string; group?: string; supported?: boolean }
const access = (id: string, name: string, read: string[], write: string[], detail: string): PermissionItem => ({ id, name, modes: write.length ? ['none', 'read', 'write'] : ['none', 'read'], read, write, detail });
const action = (id: string, name: string, tools: string[], detail: string): PermissionItem => ({ id, name, modes: ['deny', 'allow'], read: [], write: tools, detail });

/** Flat permissions narrow the tools supplied by the task entry. They never create a tool or a GitHub grant. */
const legacyItems: PermissionItem[] = [
  access('repository', '工作区文件', ['read_file','read_version_file','compare_versions'], ['write_file'], '读写可修改当前工作区；只读仅提供文件读取工具。'),
  action('commands', '运行命令', ['run_command'], '命令可以修改工作区；需要禁止执行命令时单独选择拒绝。'),
  access('task_records', '任务记录与证据', ['read_task_record', 'read_task_history', 'read_evidence'], ['record_progress'], '读取当前任务记录，或写入工作进度。'),
  access('conversation_history', '当前会话记录', ['search_conversation_history', 'read_conversation_message', 'read_conversation_summary'], [], '只查询当前已授权会话的本地记录和摘要；不会联网回源，不开放其他群或私信。'),
  access('task_management', '任务管理', ['list_managed_tasks', 'read_managed_task'], ['create_task', 'manage_task'], '读取获准任务，或创建、追加、继续、暂停和结束自己拥有或已分派的事项。默认由自己执行；选择其他角色另需委派权限，不增加 GitHub 写权限。'),
  action('scope_differences', '记录范围差异', ['record_scope_difference'], '登记实际修改与原计划的差异及证据，不改变任务目标或授权。'),
  access('project_memory', '项目知识', ['search_project_memory', 'read_project_memory'], ['remember_project_memory'], '查询项目知识，或提交知识候选；仍受知识本身的可见范围限制。'),
  access('role_memory', '角色知识', ['search_role_memory', 'read_role_memory'], ['remember_role_memory'], '查询或记录当前角色的知识。'),
  access('skills', '技能包', ['read_skill'], [], '读取绑定在当前角色上的技能文件。'),
  access('related_artifacts', '关联交付物', ['read_related_artifact'], [], '读取任务提供的关联交付物。'),
  access('github', 'GitHub 内容', ['github_read_token', 'github_read', 'github_search', 'read_job_log', 'download_artifact'], [], '读取本次任务授权的仓库；不授予 GitHub 写入凭据。'),
  // 「访问其他角色的任务」：拒绝 / 只读 / 读写。读写的工具只在提供它的入口出现（服务角色的任务操作），工作角色现有的值和快照不变。
  access('project_tasks', '其他角色的任务', ['list_project_tasks', 'read_project_task'], ['manage_project_task'], '只读查询范围内其他角色任务的进展；读写还可以追加指令、暂停、继续或取消这些任务，仍走管理服务的版本检查和幂等。角色自己的独立任务不受这一项限制。'),
  access('coordination', '跨任务协调记录', ['read_coordination'], ['acknowledge_coordination', 'decide_coordination', 'request_task_coordination', 'wait_for_tasks', 'submit_coordination'], '读取协调通知，或提出请求、等待依赖、登记采纳、提交建议；请求方 Manager 还可决定重试或撤回协调建议。'),
  access('stage_plan', '任务阶段计划', ['read_stage_schedule'], ['plan_task'], '读取阶段进度，或安排可选阶段；项目必需阶段仍由控制面校验。'),
  action('dispatch', '处理项目事件', ['dispatch'], '决定为事件新建任务、续接任务或不处理。'),
  action('delegation', '委派角色', ['delegate_role', 'delegate_roles'], '将工作委派给已配置并启用的角色。'),
  action('subagents', '启动独立执行会话', ['start_agent'], '启动工具范围不超过当前角色的独立会话。'),
  action('nomination', '交付提名与任务协调', ['nominate_delivery','finish_coordination','submit_followup_plan','submit_retry_decision','set_task_priority','relate_task'], '将候选交给独立 QA，按事实判级或关联任务；不等于通过验收，也不授予 GitHub 写权限。'),
  action('submission', '提交角色结果', ['submit_role_result', 'submit_delivery', 'finish', 'finish_review', 'finish_analysis', 'finish_observation', 'finish_release_notes'], '提交当前任务入口要求的结构化结果。'),
  action('acceptance', '提交独立验收', ['submit_acceptance'], '仅独立验收入口提供此工具。'),
  action('pull_request', '创建或更新 bot PR', ['create_pull_request'], '请求控制面发布本次任务允许的 PR，仍须通过项目验证和 QA。'),
  action('issues', '提报 Issue', ['create_issue'], '请求控制面提交本次任务允许的 Issue。'),
  action('actions_rerun', '重跑失败的 Actions', ['rerun_failed_run'], '请求控制面重跑本次任务允许的失败运行。')
];

/** These operations concern only the current assignment or its owner. Object/entry checks still apply. */
export const basicTools = ['read_file','read_version_file','compare_versions','write_file','run_command',
  'read_tool_result','read_child_tasks','wait_for_children','read_ci_evidence','read_recovery_source','read_version_context','read_publication_context','search_project_tasks','read_task_record','read_task_history','read_evidence','record_progress','record_scope_difference',
  'search_conversation_history','read_conversation_message','read_conversation_summary',
  'read_managed_task','start_own_task','continue_own_task','list_own_tasks','read_own_task','manage_own_task',
  'search_role_memory','read_role_memory','remember_role_memory','read_skill','read_related_artifact',
  'read_coordination','acknowledge_coordination','start_agent','dispatch',
  'nominate_delivery','finish_coordination','submit_followup_plan','submit_retry_decision','submit_role_result','submit_delivery','finish','finish_review',
  'finish_analysis','finish_observation','finish_release_notes','submit_acceptance',
  // Framework deliveries: a tested PR from the task's candidate, or a granted Actions rerun.
  'create_pull_request','publish_candidate','rerun_failed_run',
  // An Issue development's milestones on the Issue's status comment (#1047), written by the control plane.
  'report_development_milestone',
  // Delivery tools of generic tasks (#814): offered by the writes the task was granted, checked again at every call.
  'submit_report','open_pull_request','post_review',
  // The task's own workspace choice (#769): which worktree of the project computer it works in. They read and write no
  // files themselves, so they need no computer permission.
  'list_workspaces','use_workspace','create_workspace',
  // Lightweight webhook event subscriptions (#1168) for releasing a task's execution slot while waiting for external CI/GitHub events.
  'subscribe_event','list_event_subscriptions','cancel_event_subscription'];
const githubReads = ['github_read_token','github_read','github_search'];
const platform = (item: PermissionItem) => ({ ...item, group: 'platform' });
const github = (item: PermissionItem) => ({ ...item, group: 'github' });
export const retiredPermissionItems = ['playbooks', 'computer', 'browser'] as const;
export const permissionItems: PermissionItem[] = [
  platform(action('delegation','指派其他角色',['delegate_role','delegate_roles','create_project_task','list_managed_tasks','create_task','manage_task','grant_writes'],'将工作交给项目团队或其他已启用角色；自己创建和执行任务默认允许。')),
  platform(access('project_tasks','项目任务与协作',['list_project_tasks','read_project_task'],['manage_project_task','decide_coordination','request_task_coordination','wait_for_tasks','submit_coordination','set_task_priority','relate_task'],'查询其他角色的任务；读写还可修改、协调其他任务，决定协调重试或撤回建议，并参与共享调度。自己的任务、已收到的通知默认可用。')),
  platform(access('project_memory','项目共享知识',['search_project_memory','read_project_memory'],['remember_project_memory'],'查询共享知识或提交候选；自己的私有记忆默认可用，候选仍需原有复核。')),
  platform(access('project_configuration','项目设置与角色配置',['management_query'],['management_command'],'按操作核对项目配置、角色和共享规则的读取或修改权限；不会增加操作者授权。')),
  platform(access('schedules','项目定时与通知',['management_query'],['management_command'],'管理仓库的项目级定时任务和事件通知订阅，目标与收件人仍受项目范围限制；不影响飞书群或私聊自己的会话定时任务。')),
  github(access('github_issues','Issue',githubReads,['github_write'],'只读：查看 Issue、评论和标签。读写：还可以用 github_write 新建、修改和关闭 Issue，评论，加删标签、指派人和里程碑。')),
  github(access('github_pull_requests','Pull Request',githubReads,['github_write'],'只读：查看 PR、diff 和检视。读写：还可以用 github_write 开 PR、修改 PR，评论，发检视（包括批准和要求修改）、请求检视人。合并 PR 需要 Contents 和 Pull Request 都是读写，并按项目的自动合并策略。')),
  github(access('github_actions','Actions',[...githubReads,'read_job_log','download_artifact'],['github_write'],'只读：查看工作流运行、job、日志并下载构建产物到任务工作区。读写：还可以用 github_write 触发 workflow_dispatch、重跑或取消运行与 job。失败处理的重跑不需要这项。')),
  github(access('github_contents','Contents',githubReads,['github_write'],'只读：读取代码和提交。读写：还可以用 github_write 提交文件、创建 Git 对象、分支和引用，可以直接推送到分支；合并 PR 另需 Pull Request 读写，并按项目的自动合并策略。')),
  github(access('github_checks','Checks',githubReads,[],'读取检查运行和结论；尚未提供写入检查结果的角色工具。')),
  github(access('github_statuses','Commit Status',githubReads,[],'读取提交状态；尚未提供发布状态的角色工具。')),
];
// Only a group binding has a binding_id with which to authorize changes to its own tasks.
export const groupTaskModes = ['none', 'read', 'create', 'write'] as const;
export const groupPermissionItems = permissionItems.filter(item => item.id !== 'delegation').map(item =>
  item.id === 'project_tasks' ? { ...item, modes: [...groupTaskModes], name: '项目任务权限',
    detail: '不可访问、只读、可新增或完全可读写。可新增只允许补充或取消本绑定创建的任务。' } : item);
export const servicePermissionIds = permissionItems.map(item => item.id);
/**
 * The items a project role's editor offers (#850). project_configuration and schedules only govern the management tools,
 * which exist for the management assistant and group assistants, never in a project role's run; saved values stay as they
 * are and keep doing nothing.
 */
export const assistantOnlyItems = ['project_configuration', 'schedules'];
export const projectRoleItems = permissionItems.filter(item => !assistantOnlyItems.includes(item.id));
export const githubResources = ['issues','pull_requests','actions','contents','checks','statuses'] as const;
export type GitHubResource = typeof githubResources[number];
const keyOf = (resource: string) => 'github_' + resource;
const mask = (resource: string, action: string) => 'legacy_' + resource + '_' + action;
const on = (value?: PermissionMode) => value === 'allow' || value === 'write';
// write: every github_write route of the resource. create/reply/labels are the narrower legacy subsets github_write still
// honors for matching routes; publish/report only ever governed framework deliveries.
const resourceOperations=['read','create','reply','labels','publish','report','write'] as const;
type ResourceOperation = typeof resourceOperations[number];

/** Exact legacy subsets remain explicit until their resource/computer setting is changed. */
export function resourceAllowed(p: RolePermissions, resource: string, operation: ResourceOperation = 'read'): boolean {
  p = normalizePermissions(p);
  const mode = p[keyOf(resource)];
  if (mode === 'custom') return on(p[mask(resource, operation)]);
  return mode === 'write' || operation === 'read' && mode === 'read';
}
export const githubReadScopes = (p: RolePermissions): string[] => githubResources.filter(resource => resourceAllowed(p, resource));
/** May github_write use a route of this resource? Its full write, or the legacy subset the route matches (#381). */
export function githubWriteAllowed(p: RolePermissions, resource: string, operation?: 'create' | 'reply' | 'labels'): boolean {
  return resourceAllowed(p, resource, 'write') || !!operation && resourceAllowed(p, resource, operation);
}
export const githubWriteResources = ['issues','pull_requests','contents','actions'] as const;
/** github_write is offered when any route is allowed. */
export const githubWrites = (p: RolePermissions): boolean => githubWriteResources.some(resource => ['write','create','reply','labels'].some(operation => resourceAllowed(p, resource, operation as ResourceOperation)));
const empty = (): RolePermissions => Object.fromEntries(permissionItems.map(item => [item.id,item.modes[0]!]));
export const fullPermissions = (): RolePermissions => Object.fromEntries(permissionItems.map(item => [item.id,item.modes.at(-1)!]));
function customResource(p:RolePermissions,resource:string):void {
  if(p[keyOf(resource)]==='custom')return;
  for(const operation of resourceOperations)p[mask(resource,operation)]=resourceAllowed(p,resource,operation)?'allow':'deny';
  p[keyOf(resource)]='custom';
}

/** Old rows and run snapshots keep their original body. Reading a row converts its permission meaning, not its history. */
export function normalizePermissions(value: RolePermissions, service = false): RolePermissions {
  const isV2 = ['computer', 'browser', 'project_configuration', 'schedules', ...githubResources.map(keyOf)].some(key => Object.hasOwn(value, key));
  if (isV2) {
    const { playbooks: _playbooks, computer: _computer, browser: _browser, legacy_repository: _repo, legacy_commands: _commands, ...active } = value;
    return { ...empty(), ...active };
  }
  const p = empty();
  p.delegation = value.delegation ?? 'deny';
  const tasks = value.project_tasks ?? 'none', coordination = value.coordination ?? 'none', nomination = value.nomination ?? 'deny';
  p.project_tasks = tasks;
  if (tasks === 'write' || coordination === 'write' || nomination === 'allow' || service && value.delegation === 'allow') {
    p.project_tasks = 'custom';
    p.legacy_project_tasks = tasks; p.legacy_coordination = coordination; p.legacy_nomination = nomination;
    if(service && value.delegation === 'allow')p.legacy_delegation_controls='allow';
  }
  p.project_memory = value.project_memory ?? 'none';
  for (const resource of githubResources) {
    const read = value.github === 'read', create = resource === 'issues' ? value.issues === 'allow' : resource === 'pull_requests' && value.pull_request === 'allow';
    const reply = ['issues','pull_requests'].includes(resource) && value.submission === 'allow';
    const publish = resource === 'contents' && value.pull_request === 'allow';
    if (!create && !reply && !publish) p[keyOf(resource)] = read ? 'read' : 'none';
    else {
      p[keyOf(resource)] = 'custom';
      for (const [operation,allowed] of Object.entries({read,create,reply,labels:reply,publish,report:resource==='issues'&&value.issues==='allow'})) p[mask(resource,operation)] = allowed ? 'allow' : 'deny';
    }
  }
  return p;
}

/** Validate in the caller; compatibility updates from an older console are translated to the new resource fields. */
export function updatePermissions(base: RolePermissions, input: RolePermissions, service = false): RolePermissions {
  let p = normalizePermissions(base,service);
  const old = legacyItems.filter(item => Object.hasOwn(input,item.id) && !permissionItems.some(next => next.id === item.id));
  for (const item of old) {
    const mode = input[item.id]!;
    if (item.id === 'github') {
      for (const resource of githubResources) {
        if(p[keyOf(resource)]==='write')customResource(p,resource);
        if (p[keyOf(resource)] === 'custom') p[mask(resource,'read')] = mode === 'read' ? 'allow' : 'deny';
        else p[keyOf(resource)] = mode === 'read' ? 'read' : 'none';
      }
    } else if (item.id === 'issues' || item.id === 'pull_request') {
      const resource = item.id === 'issues' ? 'issues' : 'pull_requests';
      for (const target of item.id === 'pull_request' ? [resource,'contents'] : [resource]) {
        customResource(p,target);
        p[mask(target,target === 'contents' ? 'publish' : 'create')] = mode;
        if(target==='issues')p[mask(target,'report')]=mode;
      }
    } else if (item.id === 'coordination' || item.id === 'nomination') {
      if (p.project_tasks !== 'custom') p.legacy_project_tasks = p.project_tasks!;
      p.project_tasks = 'custom'; p['legacy_' + item.id] = mode;
    }
    // Other old fields (including repository/commands) governed only current-task or computer operations, which now need no role permission.
  }
  for (const item of permissionItems) if (Object.hasOwn(input,item.id)) {
    p[item.id] = input[item.id]!;
    if (p[item.id] !== 'custom') {
      if (item.id === 'project_tasks') { delete p.legacy_project_tasks; delete p.legacy_coordination; delete p.legacy_nomination; delete p.legacy_delegation_controls; }
      if (item.id.startsWith('github_')) for (const key of Object.keys(p)) if (key.startsWith('legacy_' + item.id.slice(7) + '_')) delete p[key];
    }
  }
  // Older service-role clients used delegation for finding and updating the work they handed to the Manager.
  if (service && Object.hasOwn(input,'github') && input.delegation === 'allow') {
    if(p.project_tasks!=='custom')p.legacy_project_tasks=p.project_tasks!;
    p.project_tasks='custom';p.legacy_delegation_controls='allow';
  }
  return p;
}
export function validPermissionInput(key: string, mode: unknown, base: RolePermissions): boolean {
  if (key === 'playbooks') return ['none','read','write'].includes(String(mode)); // Old clients may echo a retired field, never grant tools.
  if (key === 'computer') return ['deny','allow','custom'].includes(String(mode));
  if (key === 'browser') return ['deny','allow'].includes(String(mode));
  if (key === 'legacy_repository') return ['none','read','write'].includes(String(mode));
  if (key === 'legacy_commands') return ['deny','allow'].includes(String(mode));
  if (key.startsWith('legacy_')) return base[key] === mode;
  if (mode === 'custom') return normalizePermissions(base)[key] === 'custom';
  const item = permissionItems.find(item => item.id === key) ?? legacyItems.find(item => item.id === key);
  return !!item?.modes.includes(mode as PermissionMode);
}

export function permissionTools(value: RolePermissions): string[] {
  const p = normalizePermissions(value), tools = new Set(basicTools);
  for (const item of permissionItems.filter(item => item.group === 'platform')) {
    const mode = p[item.id];
    if (mode === 'read' || on(mode)) item.read.forEach(name => tools.add(name));
    if (on(mode)) item.write.forEach(name => tools.add(name));
  }
  if (p.project_tasks === 'create') {
    for (const name of ['list_project_tasks', 'read_project_task', 'create_project_task', 'manage_project_task', 'management_query', 'management_command']) tools.add(name);
  }
  if (p.project_tasks === 'custom') {
    const item = permissionItems.find(item => item.id === 'project_tasks')!;
    if (['read','write'].includes(p.legacy_project_tasks!) || p.legacy_delegation_controls==='allow') item.read.forEach(name => tools.add(name));
    if (p.legacy_project_tasks === 'write' || p.legacy_delegation_controls==='allow') tools.add('manage_project_task');
    if (p.legacy_coordination === 'write') ['decide_coordination','request_task_coordination','wait_for_tasks','submit_coordination'].forEach(name => tools.add(name));
    if (p.legacy_nomination === 'allow') ['set_task_priority','relate_task'].forEach(name => tools.add(name));
  }
  if (['project_tasks','project_memory','project_configuration','schedules'].some(id => ['read','write'].includes(p[id]!))) tools.add('management_query');
  if (p.delegation === 'allow' || ['project_tasks','project_memory','project_configuration','schedules'].some(id => p[id] === 'write')) tools.add('management_command');
  const scopes=githubReadScopes(p);
  if (scopes.length) ['github_read_token','github_read'].forEach(name => tools.add(name));
  if (scopes.includes('issues')||scopes.includes('pull_requests')) tools.add('github_search');
  if (resourceAllowed(p,'actions')) ['read_job_log','download_artifact'].forEach(name => tools.add(name));
  if (githubWrites(p)) tools.add('github_write');
  return [...tools];
}

/** A delegated task retains the source run's actual tool ceiling, including transitional legacy subsets. */
export function narrowPermissions(value: RolePermissions, tools: readonly string[]): RolePermissions {
  const p = normalizePermissions(value), allowed = new Set(tools);
  for (const item of permissionItems.filter(item => item.group === 'platform')) {
    const held = permissionTools(p).filter(name => [...item.read,...item.write].includes(name));
    if (held.every(name => allowed.has(name))) continue;
    p[item.id] = item.read.length && item.read.every(name => allowed.has(name)) && held.some(name => item.read.includes(name)) ? 'read' : item.modes[0]!;
  }
  for (const resource of githubResources) {
    const original = normalizePermissions(value);
    p[keyOf(resource)] = 'custom';
    for (const operation of resourceOperations) {
      // Deliveries (publish, report) need no role permission; every direct write goes through github_write.
      const tool = operation === 'read' ? resource === 'actions' && (allowed.has('read_job_log') || allowed.has('download_artifact')) || githubReads.some(name => allowed.has(name))
        : ['publish','report'].includes(operation) || allowed.has('github_write');
      p[mask(resource,operation)] = tool && resourceAllowed(original,resource,operation) ? 'allow' : 'deny';
    }
  }
  return p;
}
export const permitsTool = (permissions: RolePermissions, tool: string) => permissionTools(permissions).includes(tool);

/**
 * Built-in defaults (#381): only the Manager writes to GitHub (Issues, Pull requests and Contents, limited to the repository
 * of the event or task it handles); every other role reads every GitHub resource. Deliveries need no role write. Actions
 * write (starting workflows, #1072) follows Issues write, so the Manager and its project scheduled tasks can start one.
 */
export function defaultPermissions(id: string, kind: RoleKind): RolePermissions {
  const p = empty();
  for (const resource of githubResources) p[keyOf(resource)] = id === 'manager' && (githubWriteResources as readonly string[]).includes(resource) ? 'write' : 'read';
  p.github_actions = p.github_issues === 'write' ? 'write' : p.github_actions!;
  p.project_memory = 'write';
  if (kind === 'controller') { p.project_tasks = 'write'; if (id !== 'coordinator') p.delegation = 'allow'; }
  return p;
}
export function migratePermissions(role: { role_id: string; kind: RoleKind; permissions?: RolePermissions; capability_policy_ref?: { id: string } }): RolePermissions {
  if (role.permissions) return normalizePermissions(role.permissions);
  if (!role.capability_policy_ref) return defaultPermissions(role.role_id,role.kind);
  // Pre-permission V2 rows used fixed capability policies. Reconstruct that old meaning before converting it.
  const writer=role.kind==='writer',controller=role.kind==='controller',coordinator=role.role_id==='coordinator';
  const legacy:RolePermissions={repository:controller?'none':writer?'write':'read',commands:controller||role.capability_policy_ref.id==='observer-readonly'?'deny':'allow',
    github:writer?'read':'none',issues:writer?'allow':'deny',pull_request:writer?'allow':'deny',submission:'allow',
    project_tasks:controller?'read':'none',coordination:controller||writer?'write':'none',nomination:controller&&!coordinator?'allow':'deny',
    delegation:controller&&!coordinator?'allow':'deny',project_memory:controller?'none':writer?'write':'read',actions_rerun:writer?'allow':'deny'};
  if(role.capability_policy_ref.id==='controller'){legacy.project_tasks='none';legacy.coordination='none';}
  return normalizePermissions(legacy);
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
export function permissionSnapshot(permissions: RolePermissions, kind?: RoleKind) {
  const tools = permissionTools(permissions).filter(name => (name !== 'submit_acceptance' || kind === 'evaluator') &&
    (name !== 'write_file' || !['observer','evaluator'].includes(kind??'')) &&
    (!['subscribe_event','cancel_event_subscription'].includes(name) || kind !== 'evaluator')), has = (tool: string) => tools.includes(tool);
  return { id: 'permissions', version: hash({permissions,tools}), tools, permissions:normalizePermissions(permissions), authorities: {
    query_facts: has('read_task_record') || has('read_project_task'), delegate: has('delegate_role'), coordinate: has('request_task_coordination') || has('submit_coordination'),
    nominate: has('nominate_delivery'), edit_candidate: has('write_file'), decide_acceptance: has('submit_acceptance'),
    finish_task: false, override_qa: false, publish: false, merge: false, grant_permissions: false
  } };
}

/** The same operation policy is used for management and group commands, and rechecked at execution. */
export function permitsManagement(p: RolePermissions, operation: string, write = false): boolean {
  p = normalizePermissions(p);
  if (operation === 'list_projects' || operation === 'get_capabilities') return true;
  if (operation === 'task.create') return p.delegation === 'allow';
  if(operation==='configuration.pr'&&(!resourceAllowed(p,'pull_requests','create')||!resourceAllowed(p,'contents','publish')))return false;
  const resource = /^(schedule\.|subscription\.)/.test(operation) || /schedule|subscription|occurrence|notification/.test(operation) ? 'schedules'
    : /^(task\.)/.test(operation) || ['list_tasks','get_task'].includes(operation) ? 'project_tasks'
    : /knowledge/.test(operation) ? 'project_memory' : 'project_configuration';
  if (resource === 'project_tasks' && p.project_tasks === 'custom') {
    if(p.legacy_delegation_controls==='allow'&&(!write||['task.instructions','task.contract','task.cancel'].includes(operation)))return true;
    return p.legacy_project_tasks === 'write' && operation!=='task.contract' || !write && p.legacy_project_tasks === 'read';
  }
  return p[resource] === 'write' || !write && p[resource] === 'read';
}

/** A binding can carry only capabilities its configured role uses; its grantor is checked again per resource. */
export function serviceCapabilities(value: RolePermissions): string[] {
  const p=normalizePermissions(value,true), caps=new Set(['tasks.read']);
  if(p.delegation==='allow'||permitsTool(p,'manage_project_task'))caps.add('tasks.write');
  if(['read','write'].includes(p.project_memory!))caps.add('knowledge.read');
  if(p.project_memory==='write')caps.add('knowledge.write');
  if(p.project_configuration==='write'){caps.add('config.write');caps.add('roles.edit');}
  if(p.schedules==='write')caps.add('schedules.manage');
  return [...caps];
}
