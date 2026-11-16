import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import { sha } from '../agent/common.js';
import { developmentLabel } from '../rules/service.js';
import { actionsReport } from '../actions/safety.js';
import { developmentApproved } from '../review/development.js';
import { bindingLevel } from '../channels/service-bindings.js';

/**
 * The basis of a development (#815). Starting development of an Issue the bot did not open is the Manager's decision, and
 * it states why it may: a person's development label, a maintainer's request in a comment, or a rule of the project's
 * Manager prompt. The control plane checks the basis when the task is created and keeps it with the task; nothing in the
 * Issue's text or the review is a condition. Tasks created in a Feishu group or a private chat record theirs too: the
 * group's grant (the speaker is never checked) or the person's own authority.
 */
export type Basis =
  | { kind: 'label'; label: string; labeled_by: string }
  | { kind: 'maintainer_request'; comment_id: string; author: string; permission: string; url: string | null; excerpt: string }
  | { kind: 'project_rule'; passage: string; prompt_revision: string }
  | { kind: 'group_grant'; group: string; grantor: string; level: string }
  | { kind: 'requester'; principal: string }
  | { kind: 'own_issue'; reason: string };
export const basisKinds = ['label', 'maintainer_request', 'project_rule'] as const;
export interface BasisRefusal { code: string; reason: string }

export function basisStorage(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_development_basis(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,detail TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
}
/** Keeps the basis with the task (and in its history), once. */
export function recordBasis(store: Store, taskId: string, basis: Basis) {
  const now = new Date().toISOString(), detail = JSON.stringify(basis);
  const inserted = store.run('INSERT OR IGNORE INTO task_development_basis VALUES(?,?,?,?)', taskId, basis.kind, detail, now);
  if (inserted.changes) store.run('INSERT INTO task_history(task_id,type,data,created_at,actor) VALUES(?,?,?,?,?)', taskId, 'development_basis', detail, now, 'framework');
}
export function taskBasis(store: Store, taskId: string): Basis | null {
  const row = store.hasTable('task_development_basis') ? store.get('SELECT detail FROM task_development_basis WHERE task_id=?', taskId) : undefined;
  try { return row ? JSON.parse(String(row.detail)) as Basis : null; } catch { return null; }
}
/** An Issue the bot filed itself (from an Actions failure): developing it changes nobody else's work, so it needs no basis. */
export const ownIssue = (store: Store, repositoryId: string, number: number): Basis | null =>
  actionsReport(store, repositoryId, number) ? { kind: 'own_issue', reason: 'Actions 失败提报的 Issue' } : null;

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
// Permissions GitHub reports that count as a maintainer: triage or higher.
const maintainer = new Set(['triage', 'write', 'maintain', 'admin']);

/**
 * Checks the basis the Manager stated for developing Issue `number` and returns what is kept, or the refusal. GitHub is read
 * with the Manager's read token: who added the label, the comment and its author's permission. `prompt` is the Manager's
 * dispatch prompt as it is now, with its revision.
 */
export async function verifyBasis(store: Store, repositoryId: string, number: number, value: any, github: () => Promise<GitHub>,
  prompt: { content: string; revision: string }, checked?: { label?: unknown; labeled_by?: unknown } | null): Promise<Basis | BasisRefusal> {
  const own = ownIssue(store, repositoryId, number);
  if (own) return own;
  const refused = (code: string, reason: string): BasisRefusal => ({ code, reason });
  if (!value || typeof value !== 'object' || !basisKinds.includes(value.kind))
    return refused('development_basis_required', '开发不是 bot 自己开的 Issue 需要依据：basis.kind 为 label（有人加了开发标签）、maintainer_request（triage 以上权限的人在评论里要求，给 comment_id）或 project_rule（给 Manager 提示词里依据的原文 passage）。外人的评论不能作为依据。');
  if (value.kind === 'project_rule') {
    const passage = normalize(String(value.passage ?? ''));
    if (passage.length < 12 || passage.length > 2000) return refused('development_basis_invalid', 'project_rule 要给出 Manager 提示词里依据的那段原文（12 到 2000 个字符）。');
    if (!normalize(prompt.content).includes(passage)) return refused('development_basis_invalid', '给出的原文不在当前的 Manager 提示词里。');
    return { kind: 'project_rule', passage, prompt_revision: prompt.revision };
  }
  // A label event, and a review published while the label is on the Issue, carry who added it: the control plane read that
  // when it wrote the event. Other events have the label read from GitHub now.
  if (value.kind === 'label' && checked?.label && checked.labeled_by !== undefined) return { kind: 'label', label: String(checked.label), labeled_by: String(checked.labeled_by) };
  const client = await github();
  if (value.kind === 'label') {
    const label = developmentLabel(store, repositoryId);
    const approved = await developmentApproved({ store, label: () => label, owned: () => { throw new Error('unused'); } }, client, { repository_id: repositoryId, kind: 'development.issue', object_number: number } as Row);
    return approved ? { kind: 'label', label, labeled_by: approved.labeled_by } : refused('development_basis_invalid', `Issue 上没有人加的「${label}」开发标签（App 加的不算）。`);
  }
  const id = String(value.comment_id ?? '');
  if (!/^[1-9]\d{0,19}$/.test(id)) return refused('development_basis_invalid', 'maintainer_request 要给出提出要求的那条评论的 comment_id。');
  const comment = await client.request('GET', client.path('/issues/comments/' + id), undefined, true).catch(() => null) as any;
  if (!comment?.id || !String(comment.issue_url ?? '').endsWith('/issues/' + number)) return refused('development_basis_invalid', `评论 ${id} 不是这个 Issue 上的评论。`);
  const author = String(comment.user?.login ?? '');
  if (!author || comment.user?.type !== 'User') return refused('development_basis_invalid', '这条评论不是人写的。');
  const access = await client.request('GET', client.path(`/collaborators/${encodeURIComponent(author)}/permission`), undefined, true).catch(() => null) as any;
  const permission = String(access?.role_name ?? access?.permission ?? 'none');
  if (!maintainer.has(permission)) return refused('development_basis_not_maintainer', `${author} 在仓库里的权限是 ${permission}，不到 triage；外人的评论不能作为开发依据。`);
  return { kind: 'maintainer_request', comment_id: id, author, permission, url: comment.html_url ?? null, excerpt: normalize(String(comment.body ?? '')).slice(0, 500) };
}
export const isRefusal = (value: Basis | BasisRefusal): value is BasisRefusal => 'code' in value;
/** The revision of the Manager's dispatch prompt a project_rule basis was checked against. */
export function promptRevision(store: Store, repositoryId: string, content: string) {
  const saved = store.get('SELECT revision FROM manager_dispatch_prompts WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repositoryId);
  return saved ? 'revision:' + saved.revision : 'builtin:' + sha(content).slice(0, 16);
}

/**
 * The basis of a task created outside dispatch that delivers a PR: a Feishu group acts with the grant its binding holds (the
 * speaker is never checked); anyone else acts on their own authority, which creation already checked.
 */
export function requestBasis(store: Store, principal: string | null | undefined): Basis | null {
  if (!principal) return null;
  const binding = store.hasTable('channel_service_bindings') ? store.get('SELECT chat_id,configured_by,permissions FROM channel_service_bindings WHERE principal_id=?', principal) : undefined;
  if (!binding) return { kind: 'requester', principal };
  let level = 'custom';
  try { level = bindingLevel(JSON.parse(String(binding.permissions || '{}'))); } catch { level = 'custom'; }
  return { kind: 'group_grant', group: String(binding.chat_id), grantor: String(binding.configured_by), level };
}
