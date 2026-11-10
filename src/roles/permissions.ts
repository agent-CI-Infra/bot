import { createHash } from 'node:crypto';
import type { RoleKind } from './catalog.js';

export type PermissionMode = 'none' | 'read' | 'write' | 'allow' | 'deny';
export type RolePermissions = Record<string, PermissionMode>;
interface PermissionItem { id: string; name: string; modes: PermissionMode[]; read: string[]; write: string[]; detail: string }
const access = (id: string, name: string, read: string[], write: string[], detail: string): PermissionItem => ({ id, name, modes: write.length ? ['none', 'read', 'write'] : ['none', 'read'], read, write, detail });
const action = (id: string, name: string, tools: string[], detail: string): PermissionItem => ({ id, name, modes: ['deny', 'allow'], read: [], write: tools, detail });

/** Flat permissions narrow the tools supplied by the task entry. They never create a tool or a GitHub grant. */
export const permissionItems: PermissionItem[] = [
  access('repository', '工作区文件', ['read_file'], ['write_file'], '读写可修改当前工作区；只读仅提供文件读取工具。'),
  action('commands', '运行命令', ['run_command'], '命令可以修改工作区；需要禁止执行命令时单独选择拒绝。'),
  access('task_records', '任务记录与证据', ['read_task_record', 'read_task_history', 'read_evidence'], ['record_progress'], '读取当前任务记录，或写入工作进度。'),
  action('scope_differences', '记录范围差异', ['record_scope_difference'], '登记实际修改与原计划的差异及证据，不改变任务目标或授权。'),
  access('playbooks', '操作指南', ['read_playbook'], ['select_playbooks'], '读取指南，或登记本次采用的指南。'),
  access('project_memory', '项目知识', ['search_project_memory', 'read_project_memory'], ['remember_project_memory'], '查询项目知识，或提交知识候选；仍受知识本身的可见范围限制。'),
  access('role_memory', '角色知识', ['search_role_memory', 'read_role_memory'], ['remember_role_memory'], '查询或记录当前角色的知识。'),
  access('skills', '技能包', ['read_skill'], [], '读取绑定在当前角色上的技能文件。'),
  access('related_artifacts', '关联交付物', ['read_related_artifact'], [], '读取任务提供的关联交付物。'),
  access('github', 'GitHub 内容', ['github_read_token', 'github_read', 'github_search', 'read_job_log'], [], '读取本次任务授权的仓库；不授予 GitHub 写入凭据。'),
  access('project_tasks', '项目内其他任务', ['list_project_tasks', 'read_project_task'], [], '查询同一项目的任务事实，不开放其他项目。'),
  access('coordination', '跨任务协调记录', ['read_coordination'], ['acknowledge_coordination', 'request_task_coordination', 'wait_for_tasks', 'submit_coordination'], '读取协调通知，或提出请求、等待依赖、登记采纳和提交建议。'),
  access('stage_plan', '任务阶段计划', ['read_stage_schedule'], ['plan_task'], '读取阶段进度，或安排可选阶段；项目必需阶段仍由控制面校验。'),
  action('dispatch', '处理项目事件', ['dispatch'], '决定为事件新建任务、续接任务或不处理。'),
  action('delegation', '委派角色', ['delegate_role', 'delegate_roles'], '将工作委派给已配置并启用的角色。'),
  action('subagents', '启动独立执行会话', ['start_agent'], '启动工具范围不超过当前角色的独立会话。'),
  action('nomination', '交付提名与任务协调', ['nominate_delivery','submit_followup_plan','set_task_priority','relate_task'], '将候选交给独立 QA，按事实判级或关联任务；不等于通过验收，也不授予 GitHub 写权限。'),
  action('submission', '提交角色结果', ['submit_role_result', 'submit_delivery', 'finish', 'finish_review', 'finish_analysis', 'finish_observation', 'finish_release_notes', 'submit_gate_plan'], '提交当前任务入口要求的结构化结果。'),
  action('acceptance', '提交独立验收', ['submit_acceptance'], '仅独立验收入口提供此工具。'),
  action('pull_request', '创建或更新 bot PR', ['create_pull_request'], '请求控制面发布本次任务允许的 PR，仍须通过项目验证和 QA。'),
  action('issues', '提报 Issue', ['create_issue', 'report_failure'], '请求控制面提交本次任务允许的 Issue。'),
  action('actions_rerun', '重跑失败的 Actions', ['rerun_failed_run'], '请求控制面重跑本次任务允许的失败运行。')
];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
export const permissionTools = (permissions: RolePermissions) => permissionItems.flatMap(item => {
  const mode = permissions[item.id];
  return mode === 'write' || mode === 'allow' ? [...item.read, ...item.write] : mode === 'read' ? item.read : [];
});
export const permitsTool = (permissions: RolePermissions, tool: string) => permissionTools(permissions).includes(tool);

/** Defaults are individual values, editable independently after creation. */
export function defaultPermissions(id: string, kind: RoleKind): RolePermissions {
  const permissions: RolePermissions = Object.fromEntries(permissionItems.map(item => [item.id, item.modes[0]!]));
  const set = (values: RolePermissions) => Object.assign(permissions, values);
  set({ task_records: 'read', submission: 'allow' });
  if (id === 'coordinator') set({ project_tasks: 'read', coordination: 'write' });
  else if (kind === 'controller') set({ task_records: 'write', playbooks: 'write', skills: 'read', project_tasks: 'read', coordination: 'write', stage_plan: 'write', dispatch: 'allow', delegation: 'allow', nomination: 'allow' });
  else {
    set({ repository: kind === 'writer' ? 'write' : 'read', commands: 'allow', playbooks: 'write', project_memory: kind === 'writer' ? 'write' : 'read', role_memory: kind === 'writer' ? 'write' : 'read', skills: 'read', related_artifacts: 'read' });
    if (kind === 'writer') set({ task_records: 'write', scope_differences: 'allow', github: 'read', coordination: 'write', subagents: 'allow', pull_request: 'allow', issues: 'allow', actions_rerun: 'allow' });
    if (kind === 'evaluator') set({ acceptance: 'allow' });
  }
  return permissions;
}

/** Old stored policies are converted on read; historical rows and snapshots remain unchanged. */
export function migratePermissions(role: { role_id: string; kind: RoleKind; permissions?: RolePermissions; capability_policy_ref?: { id: string } }) {
  if (role.permissions) return { ...Object.fromEntries(permissionItems.map(item => [item.id, item.modes[0]!])), ...role.permissions };
  const permissions = defaultPermissions(role.role_id, role.kind);
  if (role.capability_policy_ref?.id === 'observer-readonly') permissions.commands = 'deny';
  if (role.capability_policy_ref?.id === 'controller') { permissions.project_tasks = 'none'; permissions.coordination = 'none'; }
  return permissions;
}
// The protocol snapshot keeps its existing shape so older trace readers can still interpret it.
export function permissionSnapshot(permissions: RolePermissions) {
  const tools = permissionTools(permissions), has = (tool: string) => tools.includes(tool);
  return { id: 'permissions', version: hash({permissions,tools}), tools, authorities: {
    query_facts: has('read_task_record') || has('read_project_task'), delegate: has('delegate_role'), coordinate: has('request_task_coordination') || has('submit_coordination'),
    nominate: has('nominate_delivery'), edit_candidate: has('write_file'), decide_acceptance: has('submit_acceptance'),
    finish_task: false, override_qa: false, publish: false, merge: false, grant_permissions: false
  } };
}
