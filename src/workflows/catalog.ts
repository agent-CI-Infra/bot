import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from '../core/security.js';

// A workflow is what a project runs on GitHub events: its triggers, its prompt, its permissions and its model.
// The built-in task kinds are workflows whose id is the task kind, so a saved task_models entry keeps naming them.
// Built-in and custom workflows have the same settings: a name, a switch, a trigger list, a prompt, permissions and a model.
// Control-plane conditions (development label, assignees, tests before publication, release source checks) stay in
// code next to the publication they guard; a workflow configures the agent, never those conditions.

/** What a workflow publishes is decided by its base, never by its prompt or by the model. */
export type Publication = 'reply' | 'pull_request' | 'release_notes' | 'actions' | 'none';
export interface WorkflowPermissions {
  workspace: { read: boolean; write: boolean; notes: boolean; shell: boolean };
  /** GitHub read scopes of the task's read-only token; an empty list means no GitHub reading at all. */
  github: string[];
  /** May the agent start independent sub-agents (start_agent)? */
  agents: boolean;
  publication: Publication;
}
export interface TriggerDefinition { id: string; title: string; object: 'issue' | 'pr' | 'any' | 'release' | 'review' | 'actions'; label?: boolean; note?: string }
export interface BuiltinWorkflow {
  id: string; name: string; description: string;
  base: 'review' | 'development' | 'release.observe' | 'release.notes' | 'actions';
  object: 'issue' | 'pr' | 'release' | 'actions';
  /** Where the prompt's console layer is saved and which repository file replaces it. */
  prompt: { rule?: string; repository?: string; builtin: string };
  /** Saved permissions are clamped to this; the default is the ceiling. */
  ceiling: WorkflowPermissions;
  /** The triggers this workflow can be given; its defaults are all of them unless the policy switches say otherwise. */
  triggers: string[];
}

export const githubScopes = ['contents', 'issues', 'pull_requests', 'actions', 'checks', 'statuses', 'metadata'];

// Every trigger keeps today's filters: drafts, closed objects, the bot's own writing and comments from people without
// a role in the repository never start anything.
export const triggers: TriggerDefinition[] = [
  { id: 'issue.opened', title: 'Issue 打开', object: 'issue' },
  { id: 'issue.updated', title: 'Issue 标题或正文修改、有新评论', object: 'issue' },
  { id: 'issue.labeled', title: '有人给 Issue 加上标签', object: 'issue', label: true },
  { id: 'pull_request.opened', title: 'PR 打开或 Ready for review', object: 'pr' },
  { id: 'pull_request.synchronize', title: 'PR head 更新（推送新提交）', object: 'pr' },
  { id: 'pull_request.updated', title: 'PR 标题或描述修改、新评论、提交检视或回复检视', object: 'pr' },
  { id: 'pull_request.labeled', title: '有人给 PR 加上标签', object: 'pr', label: true },
  { id: 'comment.mention', title: '评论提到 bot', object: 'any' },
  { id: 'review.published', title: '检视工作流发布结论后', object: 'review', note: '开发 Issue：结论要求改代码；跟进 bot PR：检视发布了可执行意见（在修订轮数内）' },
  { id: 'release.manual', title: '「发版本」页的操作', object: 'release' },
  { id: 'actions.run_failed', title: '默认分支的 Actions 运行失败', object: 'actions', note: 'workflow_run 事件，另有每分钟扫描兜底' }
];
// The triggers a custom workflow can use: events on the Issue or pull request it replies on.
export const customTriggerIds = triggers.filter(trigger => ['issue', 'pr', 'any'].includes(trigger.object)).map(trigger => trigger.id);
export const triggerIds = new Set(triggers.map(trigger => trigger.id));

const prompt = (name: string) => readFileSync(resolve(import.meta.dirname, '../../docs/prompts', name), 'utf8');
const scopes = githubScopes;
const workspaceReview = { read: true, write: false, notes: true, shell: true };
export const builtinWorkflows: BuiltinWorkflow[] = [
  { id: 'review.issue', name: '检视 Issue', base: 'review', object: 'issue', description: '检视新 Issue，判断意图、核对代码证据，并按规则决定是否衔接开发。',
    prompt: { rule: '.bot/rules/issue-review.md', builtin: prompt('issue-review.md') },
    triggers: ['issue.opened', 'issue.updated', 'issue.labeled', 'comment.mention'],
    ceiling: { workspace: workspaceReview, github: scopes, agents: true, publication: 'reply' } },
  { id: 'review.pr', name: '检视 PR', base: 'review', object: 'pr', description: '检视 PR 的变更、测试与证据，发布 COMMENT 检视结论。',
    prompt: { rule: '.bot/rules/pr-review.md', builtin: prompt('pr-review.md') },
    triggers: ['pull_request.opened', 'pull_request.synchronize', 'pull_request.updated', 'pull_request.labeled', 'comment.mention'],
    ceiling: { workspace: workspaceReview, github: scopes, agents: true, publication: 'reply' } },
  { id: 'development.issue', name: '开发 Issue', base: 'development', object: 'issue', description: 'Issue 明确要求改代码时，在虚拟电脑里实现、测试并创建 bot PR。',
    prompt: { rule: '.bot/rules/issue-development.md', builtin: prompt('issue-development.md') }, triggers: ['review.published', 'issue.labeled'],
    ceiling: { workspace: { read: true, write: true, notes: true, shell: true }, github: scopes, agents: true, publication: 'pull_request' } },
  { id: 'development.pr', name: '跟进 bot PR', base: 'development', object: 'pr', description: '跟进 bot 自己创建的 PR：检视发现可执行问题后，按开发 Issue 的同一份提示词自动修订。',
    prompt: { rule: '.bot/rules/issue-development.md', builtin: prompt('issue-development.md') }, triggers: ['review.published'],
    ceiling: { workspace: { read: true, write: true, notes: true, shell: true }, github: scopes, agents: true, publication: 'pull_request' } },
  { id: 'release.observe', name: 'CI 观察', base: 'release.observe', object: 'release', description: '只读分析一次 Release 工作流运行并汇总失败线索；观察操作仍留在「发版本」。',
    prompt: { builtin: prompt('release-observe.md') }, triggers: ['release.manual'],
    ceiling: { workspace: { read: false, write: false, notes: false, shell: false }, github: scopes, agents: true, publication: 'none' } },
  { id: 'release.notes', name: '发行说明', base: 'release.notes', object: 'release', description: '把已核验的提交和合并 PR 整理成发行说明；起草与正式发布仍留在「发版本」。',
    prompt: { repository: '.agents/skills/release-notes/SKILL.md', builtin: '' }, triggers: ['release.manual'],
    ceiling: { workspace: { read: false, write: false, notes: false, shell: false }, github: [], agents: false, publication: 'release_notes' } },
  // The model classifies a failed run; the control plane checks the log lines it cites and keeps the single rerun, the
  // reports and their redaction. The Issue review workflow then reviews each report.
  { id: 'actions.failures', name: 'Actions 失败处理', base: 'actions', object: 'actions', description: '默认分支的 Actions 运行失败后，由模型分析失败原因：外部原因最多重跑原运行一次，代码缺陷或不明原因提报 Issue，再由检视 Issue 接手。',
    prompt: { builtin: prompt('actions-failures.md') }, triggers: ['actions.run_failed'],
    ceiling: { workspace: { read: false, write: false, notes: false, shell: false }, github: scopes, agents: true, publication: 'actions' } }
];
export const builtinWorkflow = (id: string) => builtinWorkflows.find(workflow => workflow.id === id);
export const triggerOptions = (id: string) => builtinWorkflow(id)?.triggers ?? customTriggerIds;
// A custom workflow replies on the Issue or PR that triggered it: one summary comment, plus a COMMENT review with
// inline findings on a PR. Branches and PRs stay with the development workflows and their control-plane conditions.
export const customCeiling: WorkflowPermissions = { workspace: workspaceReview, github: scopes, agents: true, publication: 'reply' };
export const customWorkflowId = /^custom\.[a-f0-9]{12}$/;

// Today's built-in behavior: the review workflows never start sub-agents unless an administrator allows it; the
// development prompt uses one for its review step.
export function defaultPermissions(id: string): WorkflowPermissions {
  const builtin = builtinWorkflow(id), ceiling = builtin?.ceiling ?? customCeiling;
  return clone({ ...ceiling, agents: builtin?.base === 'development' });
}
const clone = (value: WorkflowPermissions): WorkflowPermissions => JSON.parse(JSON.stringify(value));
const invalid = (detail: string): never => { throw Object.assign(new HttpError(400, 'invalid_workflow_permissions'), { detail }); };
// Saved permissions come from an administrator. Anything the ceiling does not allow is refused, not silently dropped,
// so a saved configuration never claims more than it gets; publication always follows the base.
export function validatePermissions(value: any, ceiling: WorkflowPermissions): WorkflowPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('权限配置必须是对象');
  const workspace = value.workspace ?? {};
  if (typeof workspace !== 'object' || Array.isArray(workspace)) invalid('workspace 必须是对象');
  const result: WorkflowPermissions = { workspace: { read: false, write: false, notes: false, shell: false }, github: [], agents: false, publication: ceiling.publication };
  for (const key of ['read', 'write', 'notes', 'shell'] as const) {
    const flag = workspace[key] ?? false;
    if (typeof flag !== 'boolean') invalid(`workspace.${key} 必须是布尔值`);
    if (flag && !ceiling.workspace[key]) invalid(`这条工作流不能打开 workspace.${key}`);
    result.workspace[key] = flag;
  }
  const github = value.github ?? [];
  if (!Array.isArray(github) || github.some((scope: unknown) => typeof scope !== 'string')) invalid('github 必须是读取范围列表');
  for (const scope of github) if (!ceiling.github.includes(scope)) invalid(`这条工作流不能读取 GitHub 的 ${scope}`);
  result.github = githubScopes.filter(scope => github.includes(scope));
  if (value.agents !== undefined && typeof value.agents !== 'boolean') invalid('agents 必须是布尔值');
  if (value.agents && !ceiling.agents) invalid('这条工作流不能启动独立 agent');
  result.agents = value.agents === true;
  if (value.publication !== undefined && value.publication !== ceiling.publication) invalid(`发布方式固定为 ${ceiling.publication}`);
  // Writing the checkout or running commands needs the checkout to be readable.
  if ((result.workspace.write || result.workspace.shell) && !result.workspace.read) invalid('修改工作区或运行命令需要先允许读取工作区');
  return result;
}
// A stored value that no longer fits (an older ceiling, a hand-edited row) fails closed to what the ceiling still allows.
export function clampPermissions(value: any, ceiling: WorkflowPermissions): WorkflowPermissions {
  try { return validatePermissions(value, ceiling); }
  catch {
    const workspace = value?.workspace ?? {};
    const result: WorkflowPermissions = { workspace: { read: false, write: false, notes: false, shell: false }, github: [], agents: false, publication: ceiling.publication };
    for (const key of ['read', 'write', 'notes', 'shell'] as const) result.workspace[key] = workspace[key] === true && ceiling.workspace[key];
    if (!result.workspace.read) result.workspace.write = result.workspace.shell = false;
    result.github = Array.isArray(value?.github) ? githubScopes.filter(scope => value.github.includes(scope) && ceiling.github.includes(scope)) : [];
    result.agents = value?.agents === true && ceiling.agents;
    return result;
  }
}
/** What a sub-agent may do: the parent's permissions, narrowed by the request; it never publishes or starts agents. */
export function narrowPermissions(parent: WorkflowPermissions, requested: any = {}): WorkflowPermissions {
  const ask = requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : {};
  const allow = (have: boolean, key: string) => have && ask[key] !== false;
  const read = allow(parent.workspace.read, 'workspace_read');
  return { workspace: { read, write: read && allow(parent.workspace.write, 'write_workspace'), notes: allow(parent.workspace.notes, 'write_notes'),
    shell: read && allow(parent.workspace.shell, 'run_commands') }, github: ask.github_read === false ? [] : [...parent.github], agents: false, publication: 'none' };
}

// The flowchart of a prompt is its first ```mermaid flowchart block; the console draws it, the model reads it.
export function hasFlowchart(text: string) { return /```mermaid[^\n]*\n\s*(?:flowchart|graph)\b/.test(text); }
