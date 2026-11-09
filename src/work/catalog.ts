import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from '../core/security.js';
import { defaults } from '../rules/service.js';

// The kinds of work a project does. Each work type is a fixed task kind (or two, for an Issue and a pull request) with a
// switch, a model and the writes the control plane may perform for it; they are project configuration (see settings.ts).
// What runs when is no longer configured per work type: every event that passes the control plane's filters is offered
// to the project Manager, which creates a task of one of these types, continues an existing task, or does nothing.
// Reading is never restricted: every agent may read its workspace, run commands, write project notes, start independent
// agents and read everything on GitHub with a read-only token. Writing is per work type: each write is a platform tool
// the agent calls when it needs to (see writeCatalog), and the control plane performs it. The agent never holds a token
// that can write, and neither the Manager prompt nor event content can add a write.
// Control-plane conditions (development label, assignees, tests before publication, release source checks, the single
// Actions rerun) live in those tools and in the modules that own them; a work type chooses its writes, never those conditions.

export interface WorkPermissions {
  workspace: { read: boolean; write: boolean; notes: boolean; shell: boolean };
  /** GitHub read scopes of the task's read-only token. */
  github: string[];
  /** May the agent start independent sub-agents (start_agent)? */
  agents: boolean;
  /** The writes this task may ask the platform for (ids of writeCatalog). */
  writes: string[];
}
/** A write the platform performs for an agent: the tool the agent calls and what the control plane then does. */
export interface WriteDefinition { id: string; title: string; tool: string; detail: string }
export const writeCatalog: WriteDefinition[] = [
  { id: 'reply', title: '回复评论', tool: 'finish_review', detail: '结束时交出回复；控制面发一条评论，PR 上有真实 diff 位置的意见作为 COMMENT 行内检视发出。' },
  { id: 'labels', title: '加分类标签', tool: 'finish_review', detail: '在回复里给出分类标签；控制面只加仓库里已有、对象上还没有的标签，从不加检视标签和开发标签。' },
  { id: 'code', title: '修改工作区代码', tool: 'write_file', detail: '只改这次任务的检出，不直接写 GitHub。' },
  { id: 'pull_request', title: '开或更新 bot PR', tool: 'create_pull_request', detail: '控制面固定快照、跑项目测试命令，通过后才推 bot 分支、开或更新 PR；检视和通用回复还要求项目的开发开关打开，只能在 Issue 上开新 PR 或更新 bot 自己的 PR。' },
  { id: 'issue', title: '提报 Issue', tool: 'create_issue', detail: '控制面以 bot 身份新建一个 Issue，正文里的 @ 提及会被转义。' },
  { id: 'actions_rerun', title: '重跑失败的 Actions 运行', tool: 'rerun_failed_run', detail: '登记后由控制面执行：每个原始运行最多重跑一次，只重跑支持 workflow_dispatch 的运行。' },
  { id: 'release_notes', title: '写发行说明', tool: 'finish_release_notes', detail: '交出已核验来源的分组；控制面核验每个来源恰好出现一次，再写出正文。' },
  { id: 'gate_plan', title: '提交门禁方案', tool: 'submit_gate_plan', detail: '交出回复和门禁方案；控制面核对后显示在接入门禁对话里，人看过将提交的文件并确认后，才由控制面开门禁 PR。' }
];
const writeIds = writeCatalog.map(write => write.id);
type Base = 'review' | 'development' | 'reply' | 'release.observe' | 'release.notes' | 'actions' | 'gate' | 'request';
// Which writes a work type can be given, which it starts with and which it cannot drop (the write that ends its task).
const writeSets: Record<Base, { options: string[]; defaults: string[]; locked: string[] }> = {
  review: { options: ['reply', 'labels', 'code', 'pull_request', 'issue'], defaults: ['reply', 'labels'], locked: ['reply'] },
  development: { options: ['code', 'pull_request', 'issue'], defaults: ['code', 'pull_request'], locked: ['code', 'pull_request'] },
  reply: { options: ['reply', 'labels', 'code', 'pull_request', 'issue'], defaults: ['reply'], locked: [] },
  'release.observe': { options: ['issue'], defaults: [], locked: [] },
  'release.notes': { options: ['release_notes', 'issue'], defaults: ['release_notes'], locked: [] },
  actions: { options: ['actions_rerun', 'issue'], defaults: ['actions_rerun', 'issue'], locked: [] },
  gate: { options: ['gate_plan'], defaults: ['gate_plan'], locked: ['gate_plan'] },
  // An ordinary request (a scheduled check the Manager turned into a task) has no GitHub writes at all.
  request: { options: [], defaults: [], locked: [] }
};
export const githubScopes = ['contents', 'issues', 'pull_requests', 'actions', 'checks', 'statuses', 'metadata'];

/**
 * A work type. `kinds` are the task kinds it runs as; `section` is the chapter of the Manager prompt that describes it;
 * `family` names the project-wide switch (review_enabled, development_enabled) that also gates it.
 */
export interface WorkType {
  id: string; name: string; description: string; base: Base; object: 'issue' | 'pr' | 'any' | 'release' | 'actions' | 'repository' | 'schedule';
  kinds: string[]; section: string; family?: 'review' | 'development'; defaultEnabled: boolean;
}
export const workTypes: WorkType[] = [
  { id: 'review.issue', name: '检视 Issue', base: 'review', object: 'issue', kinds: ['review.issue'], section: 'review.issue', family: 'review', defaultEnabled: true,
    description: '检视 Issue，判断意图、核对代码证据，回复评论并加分类标签。' },
  { id: 'review.pr', name: '检视 PR', base: 'review', object: 'pr', kinds: ['review.pr'], section: 'review.pr', family: 'review', defaultEnabled: true,
    description: '检视 PR 的变更、测试与证据，发布 COMMENT 检视结论。' },
  { id: 'development.issue', name: '开发 Issue', base: 'development', object: 'issue', kinds: ['development.issue'], section: 'development', family: 'development', defaultEnabled: true,
    description: 'Issue 明确要求改代码、有人加了开发标签且无人指派时，在虚拟电脑里实现、测试并创建 bot PR。' },
  { id: 'development.pr', name: '跟进 bot PR', base: 'development', object: 'pr', kinds: ['development.pr'], section: 'development', family: 'development', defaultEnabled: true,
    description: '检视采纳了 bot PR 上的修改要求，或发现可执行问题后，修订 bot 自己的 PR。' },
  { id: 'reply', name: '通用回复', base: 'reply', object: 'any', kinds: ['workflow.issue', 'workflow.pr'], section: 'reply', defaultEnabled: false,
    description: '按 Manager 提示词「通用回复」章节在 Issue 或 PR 上完成一项工作并回复，用于检视之外的项目约定（原自定义工作流）。' },
  { id: 'release.observe', name: 'CI 观察', base: 'release.observe', object: 'release', kinds: ['release.observe'], section: 'release.observe', defaultEnabled: true,
    description: '只读分析一次 Release 工作流运行并汇总失败线索；观察操作仍留在「发版本」。' },
  { id: 'release.notes', name: '发行说明', base: 'release.notes', object: 'release', kinds: ['release.notes'], section: 'release.notes', defaultEnabled: true,
    description: '把已核验的提交和合并 PR 整理成发行说明；起草与正式发布仍留在「发版本」。' },
  { id: 'actions.failures', name: 'Actions 失败处理', base: 'actions', object: 'actions', kinds: ['actions.failures'], section: 'actions.failures', defaultEnabled: false,
    description: '默认分支的 Actions 运行失败后分析原因：外部原因最多重跑原运行一次，代码缺陷或不明原因提报 Issue，再由检视 Issue 接手。' },
  { id: 'gate.onboarding', name: '接入门禁', base: 'gate', object: 'repository', kinds: ['gate.onboarding'], section: 'gate.onboarding', defaultEnabled: true,
    description: '在「接入门禁」对话里分析仓库、设计各 lane 的门禁命令并回答问题；人确认方案后，控制面才开门禁 PR。' },
  { id: 'task.request', name: '定时检查', base: 'request', object: 'schedule', kinds: ['task.request'], section: 'schedule', defaultEnabled: true,
    description: '定时计划到期时，由 Manager 按「定时检查」章节决定是否发起一项只读的通用任务。' }
];
export const workType = (id: string) => workTypes.find(work => work.id === id);
/** The work type a task belongs to: reply tasks (including those of former custom workflows) are one work type. */
export const workOf = (task: { kind: string }) => String(task.kind).startsWith('workflow.') ? 'reply' : String(task.kind);

// Sections of the Manager prompt. A section the project has not written uses its built-in text. The review and
// development sections are the console layer of their .bot/rules/ file: a repository file still replaces them, as before.
const prompt = (name: string) => readFileSync(resolve(import.meta.dirname, '../../docs/prompts', name), 'utf8');
export interface SectionDefinition { id: string; title: string; rule?: string; repository?: string; builtin: () => string }
export const sections: SectionDefinition[] = [
  { id: 'dispatch', title: '分派', builtin: () => prompt('manager-dispatch.md') },
  { id: 'review.issue', title: '检视 Issue', rule: '.bot/rules/issue-review.md', builtin: () => defaults['.bot/rules/issue-review.md']! },
  { id: 'review.pr', title: '检视 PR', rule: '.bot/rules/pr-review.md', builtin: () => defaults['.bot/rules/pr-review.md']! },
  { id: 'development', title: '开发与跟进 bot PR', rule: '.bot/rules/issue-development.md', builtin: () => defaults['.bot/rules/issue-development.md']! },
  { id: 'labels', title: '标签规则', rule: '.bot/rules/labels.md', builtin: () => defaults['.bot/rules/labels.md']! },
  { id: 'guide', title: '行为指南', rule: '.bot/guide.md', builtin: () => defaults['.bot/guide.md']! },
  { id: 'reply', title: '通用回复', builtin: () => '' },
  { id: 'release.observe', title: 'CI 观察', builtin: () => prompt('release-observe.md') },
  { id: 'release.notes', title: '发行说明', repository: '.agents/skills/release-notes/SKILL.md', builtin: () => '' },
  { id: 'actions.failures', title: 'Actions 失败处理', builtin: () => prompt('actions-failures.md') },
  { id: 'gate.onboarding', title: '接入门禁', builtin: () => prompt('gate-onboarding.md') },
  { id: 'schedule', title: '定时检查', builtin: () => '' }
];
export const section = (id: string) => sections.find(entry => entry.id === id);

/** The writes a work type can be given: each with its tool (Actions failure handling reports through report_failure) and whether it is locked. */
export function writeOptions(id: string) {
  const base = workType(id)?.base ?? 'reply', set = writeSets[base];
  return writeCatalog.filter(write => set.options.includes(write.id)).map(write => ({ ...write, ...(write.id === 'issue' && base === 'actions' ? { tool: 'report_failure',
    detail: '登记失败的 job、类别和引用的日志行；控制面核验引用确实是失败 step 打印的，再新建或评论 Issue，同一失败只报一次。' } : {}), locked: set.locked.includes(write.id) }));
}
const setOf = (id: string) => writeSets[workType(id)?.base ?? 'reply'];
export const defaultWrites = (id: string) => writeIds.filter(write => setOf(id).defaults.includes(write));
const invalidWrites = (detail: string, field?: string): never => { throw Object.assign(new HttpError(400, 'invalid_work_writes', field), { detail }); };
/** An administrator's choice of writes: known, offered to this work type, its locked writes kept, a PR only with code. */
export function validateWrites(value: unknown, id: string, field?: string): string[] {
  const set = setOf(id);
  if (!Array.isArray(value) || value.some(write => typeof write !== 'string')) return invalidWrites('writes 必须是写入能力的列表', field);
  for (const write of value as string[]) if (!set.options.includes(write)) invalidWrites(`${id} 不能配置写入 ${write}`, field);
  for (const write of set.locked) if (!(value as string[]).includes(write)) invalidWrites(`${id} 必须保留写入 ${write}`, field);
  if ((value as string[]).includes('pull_request') && !(value as string[]).includes('code')) invalidWrites('开 PR 需要同时允许修改工作区代码', field);
  return writeIds.filter(write => (value as string[]).includes(write));
}
/** Saved writes, read leniently: what no longer fits is dropped, locked writes come back; none saved means the defaults. */
export function savedWrites(saved: unknown, id: string): string[] {
  const set = setOf(id);
  if (!Array.isArray(saved)) return defaultWrites(id);
  const writes = new Set([...saved.filter((write: unknown) => typeof write === 'string' && set.options.includes(write)), ...set.locked]);
  if (!writes.has('code')) writes.delete('pull_request');
  return writeIds.filter(write => writes.has(write));
}
/**
 * The writes a task keeps when the Manager narrowed them: only writes the project allows, never more; the locked writes
 * that end its task stay. A narrowing is a list of write ids; anything else (or none) keeps the project's writes.
 */
export function narrowWrites(allowed: string[], requested: unknown, id: string): string[] {
  if (!Array.isArray(requested)) return [...allowed];
  const locked = setOf(id).locked, wanted = new Set(requested.filter(write => typeof write === 'string'));
  const writes = allowed.filter(write => wanted.has(write) || locked.includes(write));
  return writes.includes('pull_request') && !writes.includes('code') ? writes.filter(write => write !== 'pull_request') : writes;
}
/** What a task's agent may do: reading is open to every work type; writing is the configured writes, nothing else. */
export function workAccess(id: string, writes: string[] = defaultWrites(id)): WorkPermissions {
  return { workspace: { read: true, write: writes.includes('code'), notes: true, shell: true }, github: [...githubScopes], agents: true, writes: [...writes] };
}
/** What a sub-agent may do: the parent's permissions, narrowed by the request; it never publishes or starts agents. */
export function narrowPermissions(parent: WorkPermissions, requested: any = {}): WorkPermissions {
  const ask = requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : {};
  const allow = (have: boolean, key: string) => have && ask[key] !== false;
  const read = allow(parent.workspace.read, 'workspace_read');
  return { workspace: { read, write: read && allow(parent.workspace.write, 'write_workspace'), notes: allow(parent.workspace.notes, 'write_notes'),
    shell: read && allow(parent.workspace.shell, 'run_commands') }, github: ask.github_read === false ? [] : [...parent.github], agents: false, writes: [] };
}
