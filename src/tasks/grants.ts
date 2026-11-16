import type { Store, Row } from '../storage/database.js';
import { fail } from '../core/security.js';
import { covers, projectCeiling, ceilingMessage, type Ceiling } from '../work/ceiling.js';
import { workEnabled, workSettings } from '../work/settings.js';
import { savedWrites } from '../work/catalog.js';
import { githubWriteAllowed, githubWrites, type RolePermissions } from '../roles/permissions.js';
import { sourcePolicies } from './management.js';
import { pullRequestRefusal } from './pull-request.js';

/**
 * Granted writes (#814). Work that the Manager, a person or a conversation creates is one generic task (kind task.request):
 * a goal, criteria and the writes it is granted. What it delivers is up to its executor, which calls a delivery tool when
 * the work needs one: submit_report always; open_pull_request, post_review and github_write only while their write is
 * granted. The control plane checks every call again against the grant, the project's limit and the source's ceiling, so a
 * refusal returns to the caller with its reason and nothing is written.
 *
 * A grant never exceeds two ceilings, both read live:
 * - the project's limit (projectGrantLimit): the capability ceiling (#850), the project switch and, for pull requests, the
 *   development switch that task.development used to have;
 * - the source's ceiling (sourcePolicies in management.ts): the roles that created or delegated the task and a group
 *   binding's level. A role never lends a GitHub write it does not hold; a pull request is a framework delivery (#381) and
 *   needs none, but a source task must hold it to pass it on.
 *
 * Tasks created before #814 have no grant row: they keep their old path (task.development, an endpoint fixed at creation).
 */
export interface GrantDefinition { id: string; title: string; tool: string; level: Ceiling; detail: string }
export const grantCatalog: GrantDefinition[] = [
  { id: 'pull_request', title: '开或更新 bot PR', tool: 'open_pull_request', level: 'develop',
    detail: '把当前候选交给项目测试和 PR 门槛（默认要求独立 QA 通过），通过后由控制面推 bot 分支、开或更新 bot PR。' },
  { id: 'review', title: '发布 PR 检视', tool: 'post_review', level: 'comment', detail: '在本项目的 PR 上发一条 COMMENT 检视，可带行内评论；从不批准或要求修改。' },
  { id: 'github', title: '评论、标签和 Issue', tool: 'github_write', level: 'comment', detail: '按 GitHub REST 写评论、标签、Issue 等；每次调用按项目上限和来源角色的 GitHub 权限核对。' }
];
export const grantIds = grantCatalog.map(grant => grant.id);
/** The write a delivery tool needs, or undefined for tools that grants do not govern. */
export const toolGrant = (tool: string) => grantCatalog.find(grant => grant.tool === tool)?.id;

export function grantStorage(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_write_grants(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    writes TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)`);
  // Project delivery gates (#814): {"pull_request_qa": false} turns off independent QA before a PR; absent means on.
  if (!store.all('PRAGMA table_info(policies)').some(column => column.name === 'delivery_gates'))
    store.db.exec("ALTER TABLE policies ADD COLUMN delivery_gates TEXT NOT NULL DEFAULT '{}'");
}

const policyOf = (store: Store, repositoryId: string) => store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
/** The writes granted to a task, or null for a task created before grants (it keeps its old path). */
export function grantedWrites(store: Store, taskId: string): string[] | null {
  const row = taskId ? store.get('SELECT writes FROM task_write_grants WHERE task_id=?', taskId) : undefined;
  if (!row) return null;
  try { const writes = JSON.parse(String(row.writes)); return Array.isArray(writes) ? grantIds.filter(id => writes.includes(id)) : []; } catch { return []; }
}
/** Pull requests of generic tasks follow the development switch of former task.development, or ordinary tasks an administrator let deliver PRs. */
function developmentAllowed(store: Store, repositoryId: string, policy: Row) {
  return workEnabled(store, repositoryId, 'task.development', policy)
    || workEnabled(store, repositoryId, 'task.request', policy) && savedWrites(workSettings(store, repositoryId, policy)['task.request']?.writes, 'task.request').includes('pull_request');
}
/** Why the project refuses a write now (null when it allows it): switched off, below the ceiling, or development off. */
export function projectRefusal(store: Store, repositoryId: string, write: string, policy = policyOf(store, repositoryId)): { code: string; message: string; needed?: Ceiling; ceiling?: Ceiling } | null {
  const grant = grantCatalog.find(entry => entry.id === write);
  if (!grant) return { code: 'invalid_task_writes', message: `未知的写入 ${write}；可用：${grantIds.join('、')}。` };
  if (!policy?.enabled) return { code: 'task_software_disabled', message: '项目已停用。' };
  const ceiling = projectCeiling(store, repositoryId, policy);
  if (!covers(ceiling, grant.level)) return { code: 'capability_ceiling', message: ceilingMessage(grant.level, ceiling), needed: grant.level, ceiling };
  if (write === 'pull_request' && !developmentAllowed(store, repositoryId, policy)) return { code: 'task_software_disabled', message: '项目关闭了开发任务，普通任务不能开 PR。' };
  return null;
}
/** The writes the project lets a generic task hold now. */
export const projectGrantLimit = (store: Store, repositoryId: string, policy = policyOf(store, repositoryId)) =>
  grantIds.filter(write => !projectRefusal(store, repositoryId, write, policy));
/** Why the sources' authority does not cover a write (null when it does). Pull requests need no GitHub write (#381). */
export function sourceRefusal(policies: RolePermissions[], write: string): { code: string; message: string } | null {
  const holds = write === 'review' ? (p: RolePermissions) => githubWriteAllowed(p, 'pull_requests', 'reply') : write === 'github' ? githubWrites : () => true;
  return policies.every(holds) ? null : { code: 'task_external_write_forbidden', message: write === 'review'
    ? '创建或委派这个任务的角色（或群的档位）不能在 PR 上发检视，不能把这项写入交给任务。' : '创建或委派这个任务的角色（或群的档位）没有 GitHub 写权限，不能把这项写入交给任务。' };
}
/** The granted writes that both ceilings allow now; a narrowed project or source takes effect at once. */
export function effectiveWrites(store: Store, task: Row, sources: RolePermissions[]): string[] {
  const limit = projectGrantLimit(store, String(task.repository_id));
  return (grantedWrites(store, String(task.id)) ?? []).filter(write => limit.includes(write) && !sourceRefusal(sources, write));
}
/** The writes a create call asks for: its explicit list, plus a PR when intent or endpoint asks for development. */
export function requestedWrites(input: { writes?: unknown; intent?: unknown; endpoint?: unknown }): string[] {
  if (input.writes !== undefined && (!Array.isArray(input.writes) || input.writes.some(write => typeof write !== 'string' || !grantIds.includes(write))))
    fail(400, 'invalid_task_writes', 'writes', { allowed: grantIds });
  const development = input.intent === 'development' || input.intent === undefined && input.endpoint === 'reviewable_pull_request';
  const writes = new Set<string>([...((input.writes as string[] | undefined) ?? []), ...(development ? ['pull_request'] : [])]);
  if (input.intent === 'report' && writes.has('pull_request')) fail(400, 'invalid_task_intent', 'intent');
  return grantIds.filter(write => writes.has(write));
}
/** Refuses (403, nothing written) a write either ceiling does not allow. */
export function assertGrantable(store: Store, repositoryId: string, writes: string[], sources: RolePermissions[]) {
  for (const write of writes) {
    const refusal = projectRefusal(store, repositoryId, write) ?? sourceRefusal(sources, write);
    if (refusal) fail(refusal.code === 'invalid_task_writes' ? 400 : 403, refusal.code, 'writes', { write, ...refusal });
  }
}
/** Records a task's grant (the first one, or a change) with its history entry and audit. */
export function setGrant(store: Store, task: Row, writes: string[], actor: string, reason: string | null) {
  const before = grantedWrites(store, String(task.id)), now = new Date().toISOString(), ordered = grantIds.filter(id => writes.includes(id));
  if (before && JSON.stringify(before) === JSON.stringify(ordered)) return { writes: ordered, changed: false };
  const revision = Number(store.get('SELECT revision FROM task_write_grants WHERE task_id=?', task.id)?.revision ?? 0) + 1;
  store.run(`INSERT INTO task_write_grants VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET writes=excluded.writes,revision=excluded.revision,updated_at=excluded.updated_at`,
    task.id, JSON.stringify(ordered), revision, now);
  const added = ordered.filter(write => !before?.includes(write)), removed = (before ?? []).filter(write => !ordered.includes(write));
  store.run('INSERT INTO task_history(task_id,type,data,created_at,actor) VALUES(?,?,?,?,?)', task.id, before ? 'writes_granted' : 'writes_initial',
    JSON.stringify({ writes: ordered, added, removed, revision, actor, reason }), now, actor);
  if (before) store.audit(actor, 'task.grant_writes', `${task.id}: ${(before).join(',') || '-'} -> ${ordered.join(',') || '-'}${reason ? ' (' + reason.slice(0, 200) + ')' : ''}`, String(task.repository_id));
  return { writes: ordered, changed: true, revision, added, removed };
}

/**
 * grant_writes (#814): the Manager (or a person on the console) sets the writes of a running generic task. Widening stays
 * within the project's limit, the task's source and the granter's own authority; narrowing takes effect at the next call.
 * Audited, and kept in the task history. Older tasks keep their fixed path and cannot be granted writes.
 */
export function grantTaskWrites(store: Store, task: Row, input: { writes?: unknown; reason?: unknown }, actor: string, granter: RolePermissions[]) {
  if (!grantedWrites(store, String(task.id))) fail(409, 'task_writes_not_grantable', 'task_id', { message: '这个任务创建于交付工具之前，按原来的流程完成，不能再授予写入。' });
  if (['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded'].includes(String(task.status))) fail(409, 'task_already_delivered');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) fail(400, 'invalid_grant_reason', 'reason');
  const writes = requestedWrites({ writes: input.writes ?? null, intent: null });
  const before = grantedWrites(store, String(task.id))!, added = writes.filter(write => !before.includes(write));
  return store.transaction(() => {
    assertGrantable(store, String(task.repository_id), added, [...sourcePolicies(store, task), ...granter]);
    const result = setGrant(store, task, writes, actor, String(input.reason).trim());
    if (added.includes('pull_request')) { const refusal = pullRequestRefusal(store, store.get('SELECT * FROM tasks WHERE id=?', task.id)!); if (refusal) fail(403, refusal.code, 'writes', { write: 'pull_request', ...refusal }); }
    return { task_id: String(task.id), ...result, effective: effectiveWrites(store, task, sourcePolicies(store, task)) };
  });
}

/** The pull request gate (#814): a PR delivery needs a passing independent QA on the same candidate unless the project turned it off. */
export function pullRequestQaGate(store: Store, repositoryId: string, policy = policyOf(store, repositoryId)): boolean {
  try { return JSON.parse(String(policy?.delivery_gates ?? '{}'))?.pull_request_qa !== false; } catch { return true; }
}
export function setDeliveryGates(store: Store, repositoryId: string, value: unknown, actor: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'pull_request_qa') || typeof (value as any).pull_request_qa !== 'boolean')
    fail(400, 'invalid_delivery_gates', 'delivery_gates');
  const before = pullRequestQaGate(store, repositoryId), after = (value as any).pull_request_qa as boolean;
  store.run('UPDATE policies SET delivery_gates=? WHERE repository_id=?', JSON.stringify({ pull_request_qa: after }), repositoryId);
  if (before !== after) store.audit(actor, 'policy.delivery_gates', `pull_request_qa: ${before} -> ${after}`, repositoryId);
}
/** What the Manager and the console read about a task's writes: granted, in effect now, and what the project could grant. */
export function grantView(store: Store, task: Row, sources: RolePermissions[]) {
  const granted = grantedWrites(store, String(task.id));
  if (!granted) return null;
  const effective = effectiveWrites(store, task, sources), limit = projectGrantLimit(store, String(task.repository_id)).filter(write => !sourceRefusal(sources, write));
  return { granted, effective, grantable: limit, revision: Number(store.get('SELECT revision FROM task_write_grants WHERE task_id=?', task.id)?.revision ?? 0),
    tools: ['submit_report', ...grantCatalog.filter(grant => effective.includes(grant.id)).map(grant => grant.tool)],
    pull_request_qa: pullRequestQaGate(store, String(task.repository_id)) };
}
/** Task details (#814): the grant, its changes, and which delivery tools each run of the task started with. */
export function taskWritesDetail(store: Store, task: Row, sources: RolePermissions[]) {
  const view = grantView(store, task, sources);
  if (!view) return null;
  const rows = (type: string) => store.all('SELECT data,created_at FROM task_history WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 20', task.id, type).map(row => ({ ...JSON.parse(String(row.data)), at: row.created_at }));
  return { ...view, changes: [...rows('writes_granted'), ...rows('writes_initial').map(change => ({ ...change, initial: true }))], runs: rows('delivery_tools') };
}
