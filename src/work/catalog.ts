import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError } from '../core/security.js';
import { defaults } from '../rules/service.js';

// The kinds of work a project does. Each work type is a fixed task kind (or two, for an Issue and a pull request) with a
// switch, a model and the writes the control plane may perform for it; they are project configuration (see settings.ts).
// What runs when is no longer configured per work type: every event that passes the control plane's filters is offered
// to the project Manager, which creates a task of one of these types, continues an existing task, or does nothing.
// Reading is never restricted: every agent may read its workspace, run commands, write project notes, start independent
// agents and read everything on GitHub with a read-only token. A work type's writes are its framework deliveries: each is a
// platform tool the agent calls (see writeCatalog), and the control plane performs it whatever the executing role's GitHub
// permission (#381). Direct writes go through github_write and follow the acting role's GitHub permissions instead. The
// agent never holds a token that can write, and neither the Manager prompt nor event content can add a write.
// Control-plane conditions (a person's development label, tests before publication, release source checks, the single
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
  { id: 'pull_request', title: '开或更新 bot PR', tool: 'create_pull_request', detail: '控制面固定快照、跑项目测试命令，通过后才推 bot 分支、开或更新 PR；要求项目能力上限为「可开发并开 PR」，检视和通用回复只能在 Issue 上开新 PR 或更新 bot 自己的 PR。' },
  { id: 'issue', title: '提报 Issue', tool: 'report_failure', detail: '调查后按原因显式选择值得提报的问题，关联受影响的检查并保留完整诊断；控制面核验来源后新建或评论 Issue，同一原因只报一次。' },
  { id: 'actions_rerun', title: '重跑失败的 Actions 运行', tool: 'rerun_failed_run', detail: '登记后由控制面执行：每个原始运行最多重跑一次，只重跑支持 workflow_dispatch 的运行。' },
  { id: 'release_notes', title: '写发行说明', tool: 'finish_release_notes', detail: '交出已核验来源的分组；控制面核验每个来源恰好出现一次，再写出正文。' }
];
const writeIds = writeCatalog.map(write => write.id);
type Base = 'review' | 'development' | 'reply' | 'release.observe' | 'release.notes' | 'actions' | 'request';
// Which writes a work type can be given, which it starts with and which it cannot drop (the write that ends its task).
// Filing an Issue is a delivery only for Actions failure handling (report_failure); elsewhere it is a direct write through
// github_write, governed by the role (#381).
const writeSets: Record<Base, { options: string[]; defaults: string[]; locked: string[] }> = {
  review: { options: ['reply', 'labels', 'code', 'pull_request'], defaults: ['reply', 'labels'], locked: ['reply'] },
  development: { options: ['code', 'pull_request'], defaults: ['code', 'pull_request'], locked: ['code', 'pull_request'] },
  reply: { options: ['reply', 'labels', 'code', 'pull_request'], defaults: ['reply'], locked: [] },
  'release.observe': { options: [], defaults: [], locked: [] },
  'release.notes': { options: ['release_notes'], defaults: ['release_notes'], locked: [] },
  actions: { options: ['actions_rerun', 'issue'], defaults: ['actions_rerun', 'issue'], locked: [] },
  // Ordinary tasks inherit the capability ceiling (#850): at develop they may change code and deliver a PR like a development
  // task; below it the ceiling removes both. An administrator can still narrow them.
  request: { options: ['code', 'pull_request'], defaults: ['code', 'pull_request'], locked: [] }
};
export const githubScopes = ['contents', 'issues', 'pull_requests', 'actions', 'checks', 'statuses', 'metadata'];

/**
 * A work type. `kinds` are the task kinds it runs as; `section` is the chapter of the Manager prompt that describes it;
 * `family` groups reviews and development. What level of the project's capability ceiling it needs is workLevel (ceiling.ts).
 */
export interface WorkType {
  id: string; name: string; description: string; base: Base; object: 'issue' | 'pr' | 'any' | 'release' | 'actions' | 'schedule';
  kinds: string[]; section: string; family?: 'review' | 'development'; defaultEnabled: boolean;
}
export const workTypes: WorkType[] = [
  { id: 'review.issue', name: '检视 Issue', base: 'review', object: 'issue', kinds: ['review.issue'], section: 'review.issue', family: 'review', defaultEnabled: true,
    description: '检视 Issue，判断意图、核对代码证据，回复评论并加分类标签。' },
  { id: 'review.pr', name: '检视 PR', base: 'review', object: 'pr', kinds: ['review.pr'], section: 'review.pr', family: 'review', defaultEnabled: true,
    description: '检视 PR 的变更、测试与证据，发布 COMMENT 检视结论。' },
  { id: 'development.issue', name: '开发 Issue', base: 'development', object: 'issue', kinds: ['development.issue'], section: 'development', family: 'development', defaultEnabled: true,
    description: '有人加了开发标签、Manager 判断可以开发时，在虚拟电脑里实现、测试并创建 bot PR。' },
  { id: 'development.pr', name: '跟进 bot PR', base: 'development', object: 'pr', kinds: ['development.pr'], section: 'development', family: 'development', defaultEnabled: true,
    description: '检视采纳了 bot PR 上的修改要求，或发现可执行问题后，修订 bot 自己的 PR。' },
  { id: 'reply', name: '通用回复', base: 'reply', object: 'any', kinds: ['workflow.issue', 'workflow.pr'], section: 'reply', defaultEnabled: false,
    description: '按 Manager 提示词「通用回复」章节在 Issue 或 PR 上完成一项工作并回复，用于检视之外的项目约定（原自定义工作流）。' },
  { id: 'release.observe', name: 'CI 观察', base: 'release.observe', object: 'release', kinds: ['release.observe'], section: 'release.observe', defaultEnabled: true,
    description: '只读分析一次 Release 工作流运行并汇总失败线索；观察操作仍留在「发版本」。' },
  { id: 'release.notes', name: '发行说明', base: 'release.notes', object: 'release', kinds: ['release.notes'], section: 'release.notes', defaultEnabled: true,
    description: '把已核验的提交和合并 PR 整理成发行说明；起草与正式发布仍留在「发版本」。' },
  { id: 'actions.failures', name: 'Actions 失败处理', base: 'actions', object: 'actions', kinds: ['actions.failures'], section: 'actions.failures', defaultEnabled: false,
    description: '调查默认分支的 Actions 失败，按原因决定是否提报完整诊断；合并连带检查，外部原因最多重跑原运行一次。' },
  { id: 'task.development', name: '开发任务', base: 'development', object: 'schedule', kinds: ['task.development'], section: 'development', family: 'development', defaultEnabled: true,
    description: '直接创建的开发任务，复用项目开发授权、测试、独立 QA 和 PR 交付；可独立执行或关联父任务，不需要虚构 GitHub Issue。' },
  { id: 'task.request', name: '普通事项与定时检查', base: 'request', object: 'schedule', kinds: ['task.request'], section: 'schedule', defaultEnabled: true,
    description: '处理直接创建的普通事项或到期的定时检查。写入仍受项目能力上限约束：可开发时可交付 PR，经测试及独立 QA。定时检查的 `file_issues` 覆盖角色策略：true 允许用 github_write 提报或回复 Issue，false 拒绝，未设置则跟随角色；角色有写权限时也可在上限内直接写。' }
];
export const workType = (id: string) => workTypes.find(work => work.id === id);
/** The work type a task belongs to: reply tasks (including those of former custom workflows) are one work type. */
export const requestedTask = (task: Record<string,any>) => ['task.request','task.development'].includes(task.kind);
export const workOf = (task: { kind: string }) => String(task.kind).startsWith('workflow.') ? 'reply' : String(task.kind);

// Sections of the Manager prompt. A section the project has not written uses its built-in text. `rule` keys the review,
// development, labels and guide sections in rule resolution by the .bot/ file each one replaced; repositories' .bot/
// files are no longer read (#935).
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
  // Keep this section's default empty: a fixture project's get_effective_config is already
  // ~255 KiB, just under the 256 KiB management tool-result budget. Attaching the recommended
  // schedule-check text as a builtin pushed it over that budget and truncated the result, so
  // the assistant lost the top-level revision and could not finish a write. Projects may paste
  // docs/schedule-check.md into this section. That file must not become a builtin. A due plan
  // that already has an instruction is started by scheduledCheckDecision without waiting on this text.
  { id: 'schedule', title: '定时检查', builtin: () => '' }
];
export const section = (id: string) => sections.find(entry => entry.id === id);
/** Sections of removed work types (see retired.ts): older revisions and task snapshots may still have them; they are skipped. */
export const retiredSections = new Set(['gate.onboarding']);

/** The writes a work type can be given: each with its tool and whether it is locked. */
export function writeOptions(id: string) {
  const set = writeSets[workType(id)?.base ?? 'reply'];
  return writeCatalog.filter(write => set.options.includes(write.id)).map(write => ({ ...write, locked: set.locked.includes(write.id) }));
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
