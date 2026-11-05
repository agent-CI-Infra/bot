import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from '../core/security.js';

// A workflow is what a project runs on GitHub events: its triggers, its prompt and its model.
// The built-in task kinds are workflows whose id is the task kind, so a saved task_models entry keeps naming them.
// Built-in and custom workflows have the same settings: a name, a switch, a trigger list, a prompt and a model.
// Reading is never restricted: every workflow's agent may read its workspace, run commands, write project notes, start
// independent agents and read everything on GitHub with a read-only token. Writing is configured per workflow: each write
// is a platform tool the agent calls when it needs to (see writeCatalog), and the control plane performs it. The agent
// never holds a token that can write.
// Control-plane conditions (development label, assignees, tests before publication, release source checks, the single
// Actions rerun) live in those tools, next to the write they guard; a workflow chooses its writes, never those conditions.

export interface WorkflowPermissions {
  workspace: { read: boolean; write: boolean; notes: boolean; shell: boolean };
  /** GitHub read scopes of the task's read-only token. */
  github: string[];
  /** May the agent start independent sub-agents (start_agent)? */
  agents: boolean;
  /** The writes this workflow may ask the platform for (ids of writeCatalog). */
  writes: string[];
}
/** A write the platform performs for an agent: the tool the agent calls and what the control plane then does. */
export interface WriteDefinition { id: string; title: string; tool: string; detail: string }
export const writeCatalog: WriteDefinition[] = [
  { id: 'reply', title: '回复评论', tool: 'finish_review', detail: '结束时交出回复；控制面发一条评论，PR 上有真实 diff 位置的意见作为 COMMENT 行内检视发出。' },
  { id: 'labels', title: '加分类标签', tool: 'finish_review', detail: '在回复里给出分类标签；控制面只加仓库里已有、对象上还没有的标签，从不加检视标签和开发标签。' },
  { id: 'code', title: '修改工作区代码', tool: 'write_file', detail: '只改这次任务的检出，不直接写 GitHub。' },
  { id: 'pull_request', title: '开或更新 bot PR', tool: 'create_pull_request', detail: '控制面固定快照、跑项目测试命令，通过后才推 bot 分支、开或更新 PR；检视和自定义工作流还要求项目的开发开关打开，只能在 Issue 上开新 PR 或更新 bot 自己的 PR。' },
  { id: 'issue', title: '提报 Issue', tool: 'create_issue', detail: '控制面以 bot 身份新建一个 Issue，正文里的 @ 提及会被转义。' },
  { id: 'actions_rerun', title: '重跑失败的 Actions 运行', tool: 'rerun_failed_run', detail: '登记后由控制面执行：每个原始运行最多重跑一次，只重跑支持 workflow_dispatch 的运行。' },
  { id: 'release_notes', title: '写发行说明', tool: 'finish_release_notes', detail: '交出已核验来源的分组；控制面核验每个来源恰好出现一次，再写出正文。' },
  { id: 'gate_plan', title: '提交门禁方案', tool: 'submit_gate_plan', detail: '交出回复和门禁方案；控制面核对后显示在接入门禁对话里，人看过将提交的文件并确认后，才由控制面开门禁 PR。' }
];
const writeIds = writeCatalog.map(write => write.id);
// Which writes a workflow can be given, which it starts with and which it cannot drop (the write that ends its task).
const writeSets: Record<string, { options: string[]; defaults: string[]; locked: string[] }> = {
  review: { options: ['reply', 'labels', 'code', 'pull_request', 'issue'], defaults: ['reply', 'labels'], locked: ['reply'] },
  development: { options: ['code', 'pull_request', 'issue'], defaults: ['code', 'pull_request'], locked: ['code', 'pull_request'] },
  custom: { options: ['reply', 'labels', 'code', 'pull_request', 'issue'], defaults: ['reply'], locked: [] },
  'release.observe': { options: ['issue'], defaults: [], locked: [] },
  'release.notes': { options: ['release_notes', 'issue'], defaults: ['release_notes'], locked: [] },
  actions: { options: ['actions_rerun', 'issue'], defaults: ['actions_rerun', 'issue'], locked: [] },
  gate: { options: ['gate_plan'], defaults: ['gate_plan'], locked: ['gate_plan'] }
};
/** `short` names the trigger in a workflow's flowchart. */
export interface TriggerDefinition { id: string; title: string; short: string; object: 'issue' | 'pr' | 'any' | 'release' | 'review' | 'actions' | 'repository'; label?: boolean; note?: string }
export interface BuiltinWorkflow {
  id: string; name: string; description: string;
  base: 'review' | 'development' | 'release.observe' | 'release.notes' | 'actions' | 'gate';
  object: 'issue' | 'pr' | 'release' | 'actions' | 'repository';
  /** Where the prompt's console layer is saved and which repository file replaces it. */
  prompt: { rule?: string; repository?: string; builtin: string };
  /** The triggers this workflow can be given; its defaults are all of them unless the policy switches say otherwise. */
  triggers: string[];
}

export const githubScopes = ['contents', 'issues', 'pull_requests', 'actions', 'checks', 'statuses', 'metadata'];

// Every trigger keeps today's filters: drafts, closed objects, the bot's own writing and comments from people without
// a role in the repository never start anything.
export const triggers: TriggerDefinition[] = [
  { id: 'issue.opened', title: 'Issue 打开', short: 'Issue 打开', object: 'issue' },
  { id: 'issue.updated', title: 'Issue 标题或正文修改、有新评论', short: 'Issue 修改或评论', object: 'issue' },
  { id: 'issue.labeled', title: '有人给 Issue 加上标签', short: 'Issue 加标签', object: 'issue', label: true },
  { id: 'pull_request.opened', title: 'PR 打开或 Ready for review', short: 'PR 打开', object: 'pr' },
  { id: 'pull_request.synchronize', title: 'PR head 更新（推送新提交）', short: 'PR 推送新提交', object: 'pr' },
  { id: 'pull_request.updated', title: 'PR 标题或描述修改、新评论、提交检视或回复检视', short: 'PR 修改或讨论', object: 'pr' },
  { id: 'pull_request.labeled', title: '有人给 PR 加上标签', short: 'PR 加标签', object: 'pr', label: true },
  { id: 'comment.mention', title: '评论提到 bot', short: '评论提到 bot', object: 'any' },
  { id: 'review.published', title: '检视工作流发布结论后', short: '检视发布结论', object: 'review', note: '开发 Issue：结论要求改代码；跟进 bot PR：检视发布了可执行意见（在修订轮数内）' },
  { id: 'release.manual', title: '「发版本」页的操作', short: '发版本页操作', object: 'release' },
  { id: 'actions.run_failed', title: '默认分支的 Actions 运行失败', short: 'Actions 运行失败', object: 'actions', note: 'workflow_run 事件，另有每分钟扫描兜底' },
  { id: 'gate.manual', title: '「接入门禁」对话里开始或回复', short: '接入门禁对话', object: 'repository' }
];
// The triggers a custom workflow can use: events on the Issue or pull request it replies on.
export const customTriggerIds = triggers.filter(trigger => ['issue', 'pr', 'any'].includes(trigger.object)).map(trigger => trigger.id);
export const triggerIds = new Set(triggers.map(trigger => trigger.id));

const prompt = (name: string) => readFileSync(resolve(import.meta.dirname, '../../docs/prompts', name), 'utf8');
export const builtinWorkflows: BuiltinWorkflow[] = [
  { id: 'review.issue', name: '检视 Issue', base: 'review', object: 'issue', description: '检视新 Issue，判断意图、核对代码证据，并按规则决定是否衔接开发。',
    prompt: { rule: '.bot/rules/issue-review.md', builtin: prompt('issue-review.md') },
    triggers: ['issue.opened', 'issue.updated', 'issue.labeled', 'comment.mention'], },
  { id: 'review.pr', name: '检视 PR', base: 'review', object: 'pr', description: '检视 PR 的变更、测试与证据，发布 COMMENT 检视结论。',
    prompt: { rule: '.bot/rules/pr-review.md', builtin: prompt('pr-review.md') },
    triggers: ['pull_request.opened', 'pull_request.synchronize', 'pull_request.updated', 'pull_request.labeled', 'comment.mention'], },
  { id: 'development.issue', name: '开发 Issue', base: 'development', object: 'issue', description: 'Issue 明确要求改代码时，在虚拟电脑里实现、测试并创建 bot PR。',
    prompt: { rule: '.bot/rules/issue-development.md', builtin: prompt('issue-development.md') }, triggers: ['review.published', 'issue.labeled'], },
  { id: 'development.pr', name: '跟进 bot PR', base: 'development', object: 'pr', description: '跟进 bot 自己创建的 PR：检视发现可执行问题后，按开发 Issue 的同一份提示词自动修订。',
    prompt: { rule: '.bot/rules/issue-development.md', builtin: prompt('issue-development.md') }, triggers: ['review.published'], },
  { id: 'release.observe', name: 'CI 观察', base: 'release.observe', object: 'release', description: '只读分析一次 Release 工作流运行并汇总失败线索；观察操作仍留在「发版本」。',
    prompt: { builtin: prompt('release-observe.md') }, triggers: ['release.manual'], },
  { id: 'release.notes', name: '发行说明', base: 'release.notes', object: 'release', description: '把已核验的提交和合并 PR 整理成发行说明；起草与正式发布仍留在「发版本」。',
    prompt: { repository: '.agents/skills/release-notes/SKILL.md', builtin: '' }, triggers: ['release.manual'], },
  // The model classifies a failed run; the control plane checks the log lines it cites and keeps the single rerun, the
  // reports and their redaction. The Issue review workflow then reviews each report.
  { id: 'actions.failures', name: 'Actions 失败处理', base: 'actions', object: 'actions', description: '默认分支的 Actions 运行失败后，由模型分析失败原因：外部原因最多重跑原运行一次，代码缺陷或不明原因提报 Issue，再由检视 Issue 接手。',
    prompt: { builtin: prompt('actions-failures.md') }, triggers: ['actions.run_failed'], },
  // The gate onboarding conversation: each turn is a task on a checkout of the default branch; the plan goes back to the
  // conversation, and only a person's confirmation makes the control plane open the gate PR.
  { id: 'gate.onboarding', name: '接入门禁', base: 'gate', object: 'repository', description: '在「接入门禁」对话里分析仓库、设计各 lane 的门禁命令并回答问题；人确认方案后，控制面才开门禁 PR。',
    prompt: { builtin: prompt('gate-onboarding.md') }, triggers: ['gate.manual'], }
];
export const builtinWorkflow = (id: string) => builtinWorkflows.find(workflow => workflow.id === id);
export const triggerOptions = (id: string) => builtinWorkflow(id)?.triggers ?? customTriggerIds;
export const customWorkflowId = /^custom\.[a-f0-9]{12}$/;

export const workflowBase = (id: string) => builtinWorkflow(id)?.base ?? 'custom';
/** The writes a workflow can be given: each with its tool (Actions failure handling reports through report_failure) and whether it is locked. */
export function writeOptions(id: string) {
  const set = writeSets[workflowBase(id)]!;
  return writeCatalog.filter(write => set.options.includes(write.id)).map(write => ({ ...write, ...(write.id === 'issue' && workflowBase(id) === 'actions' ? { tool: 'report_failure',
    detail: '登记失败的 job、类别和引用的日志行；控制面核验引用确实是失败 step 打印的，再新建或评论 Issue，同一失败只报一次。' } : {}), locked: set.locked.includes(write.id) }));
}
export const defaultWrites = (id: string) => writeIds.filter(write => writeSets[workflowBase(id)]!.defaults.includes(write));
const invalidWrites = (detail: string): never => { throw Object.assign(new HttpError(400, 'invalid_workflow_writes'), { detail }); };
/** An administrator's choice of writes: known, offered to this workflow, its locked writes kept, a PR only with code. */
export function validateWrites(value: unknown, id: string): string[] {
  const set = writeSets[workflowBase(id)]!;
  if (!Array.isArray(value) || value.some(write => typeof write !== 'string')) return invalidWrites('writes 必须是写入能力的列表');
  for (const write of value as string[]) if (!set.options.includes(write)) invalidWrites(`这条工作流不能配置写入 ${write}`);
  for (const write of set.locked) if (!(value as string[]).includes(write)) invalidWrites(`这条工作流必须保留写入 ${write}`);
  if ((value as string[]).includes('pull_request') && !(value as string[]).includes('code')) invalidWrites('开 PR 需要同时允许修改工作区代码');
  return writeIds.filter(write => (value as string[]).includes(write));
}
/** Saved writes, read leniently: what no longer fits is dropped, locked writes come back; none saved means the defaults. */
export function savedWrites(saved: unknown, id: string): string[] {
  const set = writeSets[workflowBase(id)]!;
  let value: any = null; try { value = typeof saved === 'string' ? JSON.parse(saved) : saved; } catch { value = null; }
  if (!Array.isArray(value?.writes)) return defaultWrites(id);
  const writes = new Set([...value.writes.filter((write: unknown) => typeof write === 'string' && set.options.includes(write)), ...set.locked]);
  if (!writes.has('code')) writes.delete('pull_request');
  return writeIds.filter(write => writes.has(write));
}
/** What a workflow's agent may do: reading is open to every workflow; writing is the configured writes, nothing else. */
export function workflowAccess(id: string, writes: string[] = defaultWrites(id)): WorkflowPermissions {
  return { workspace: { read: true, write: writes.includes('code'), notes: true, shell: true }, github: [...githubScopes], agents: true, writes: [...writes] };
}
/** What a sub-agent may do: the parent's permissions, narrowed by the request; it never publishes or starts agents. */
export function narrowPermissions(parent: WorkflowPermissions, requested: any = {}): WorkflowPermissions {
  const ask = requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : {};
  const allow = (have: boolean, key: string) => have && ask[key] !== false;
  const read = allow(parent.workspace.read, 'workspace_read');
  return { workspace: { read, write: read && allow(parent.workspace.write, 'write_workspace'), notes: allow(parent.workspace.notes, 'write_notes'),
    shell: read && allow(parent.workspace.shell, 'run_commands') }, github: ask.github_read === false ? [] : [...parent.github], agents: false, writes: [] };
}

// The flowchart of a prompt is its first ```mermaid flowchart block; the console draws it, the model reads it.
export function hasFlowchart(text: string) { return /```mermaid[^\n]*\n\s*(?:flowchart|graph)\b/.test(text); }
