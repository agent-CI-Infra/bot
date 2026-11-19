import type { Store, Row } from '../storage/database.js';
import { fail } from '../core/security.js';
import { stop } from '../agent/common.js';

/**
 * The project's capability ceiling (#850, #1122): the single project-wide write gate, in three levels.
 *
 * - read: answer and review in chat; nothing is written on GitHub.
 * - comment: every write on Issues and Pull requests (comments, labels, titles and bodies, assignees, closing, new Issues,
 *   reviews), Actions reruns and starting workflows (workflow_dispatch, #1072); no code.
 * - develop: change code and open PRs as well, including Contents writes and merging, which the Manager holds by default.
 *
 * Every write the bot makes sits under it: generic task deliveries, and github_write of project roles, Feishu groups and
 * the management assistant. Task grants, role permissions, a group's level and a person's grant only narrow it; event
 * switches only decide which GitHub events reach the Manager. The former review and development switches stay in the policy
 * equal to it (review_enabled: comment or more, development_enabled: develop) for older readers; only setCeiling writes them.
 */
export const ceilingLevels = ['read', 'comment', 'develop'] as const;
export type Ceiling = typeof ceilingLevels[number];
export const isCeiling = (value: unknown): value is Ceiling => (ceilingLevels as readonly unknown[]).includes(value);
const rank = (level: Ceiling) => ceilingLevels.indexOf(level);
/** Does a ceiling allow what needs `needed`? */
export const covers = (ceiling: Ceiling, needed: Ceiling) => rank(ceiling) >= rank(needed);
export const ceilingTitles: Record<Ceiling, string> = { read: '只读问答', comment: '可评论和打标签', develop: '可开发并开 PR' };
/**
 * What each level allows, said with its title wherever a level is named to people or models. The short title of comment
 * reads as "comments and labels only", while the level covers every Issue and Pull request write.
 */
export const ceilingScopes: Record<Ceiling, string> = {
  read: '不在 GitHub 上写任何内容',
  comment: '可以写 Issue 和 PR：评论、加删标签、改标题和正文、指派人、关闭或重开、新建 Issue、发检视；可以触发 Actions 工作流，不改代码',
  develop: '另外可以改代码、开 PR、写分支和合并 PR',
};

/**
 * The level historical switches stood for, used once to upgrade a policy and for a policy row nothing has set the
 * ceiling on yet: develop with the development switch on, comment while review or Actions failure handling was on, else read.
 */
export function derivedCeiling(policy: Row | undefined): Ceiling {
  if (!policy) return 'read';
  if (policy.development_enabled) return 'develop';
  let reply = false;
  try { reply = JSON.parse(String(policy.work_settings ?? '{}'))?.reply?.enabled === true; } catch { reply = false; }
  return policy.review_enabled || policy.actions_failures_enabled || reply ? 'comment' : 'read';
}
const policyOf = (store: Store, repositoryId: string) => store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
/** The project's ceiling now. */
export function projectCeiling(store: Store, repositoryId: string, policy: Row | undefined = policyOf(store, repositoryId)): Ceiling {
  return isCeiling(policy?.capability_ceiling) ? policy!.capability_ceiling : derivedCeiling(policy);
}

const writeLevels: Record<string, Ceiling> = {
  reply: 'comment',
  review: 'comment',
  github: 'comment',
  labels: 'comment',
  issue: 'comment',
  actions_rerun: 'comment',
  code: 'develop',
  pull_request: 'develop',
  release_notes: 'read',
};
export const writeLevel = (write: string): Ceiling => writeLevels[write] ?? 'develop';
/** The level a github_write on a GitHub resource needs: merging a PR and pushing are Contents writes; Issues, pull requests
 * and Actions (starting a workflow) need comment. */
export const resourceLevel = (resource: string): Ceiling => resource === 'contents' ? 'develop' : 'comment';
/** The writes of a list the ceiling allows. */
export const withinCeiling = (ceiling: Ceiling, writes: string[]) => writes.filter(write => covers(ceiling, writeLevel(write)));

/**
 * The minimum ceiling level a task needs to continue running at all. Generic tasks (`task.request`) check their
 * granted writes per delivery tool call rather than stopping read-only execution; legacy in-flight rows follow their kind.
 */
export function taskRequiredCeiling(task: { kind?: unknown }): Ceiling {
  const kind = String(task.kind ?? 'task.request');
  if (kind === 'development.issue' || kind === 'development.pr' || kind === 'task.development') return 'develop';
  if (kind.startsWith('review.') || kind.startsWith('workflow.') || kind === 'actions.failures') return 'comment';
  return 'read';
}

/**
 * Why something above the ceiling was refused: the project's level and the level needed, each with what it allows. People
 * read it on refused tasks and API calls; the Manager reads it when a write is unavailable.
 */
export const ceilingMessage = (needed: Ceiling, ceiling: Ceiling) =>
  `项目能力上限为「${ceilingTitles[ceiling]}」(${ceiling}，${ceilingScopes[ceiling]})，这项操作需要「${ceilingTitles[needed]}」(${needed}，${ceilingScopes[needed]})；项目管理员可以在「项目设置 → 监听与触发」调整。`;
/** For a running task: stops with `code` (capability_ceiling, or capability_ceiling_lowered from the guard) until a person
 * raises the ceiling and retries it. */
export function stopAboveCeiling(store: Store, repositoryId: string, needed: Ceiling, code = 'capability_ceiling', policy?: Row): void {
  const ceiling = projectCeiling(store, repositoryId, policy ?? policyOf(store, repositoryId));
  if (!covers(ceiling, needed)) stop(code, 'waiting_permission', ceilingMessage(needed, ceiling));
}
/** For an API call: refuses with 403 capability_ceiling, naming the level needed and the project's level. */
export function assertCeiling(store: Store, repositoryId: string, needed: Ceiling): void {
  const ceiling = projectCeiling(store, repositoryId);
  if (!covers(ceiling, needed)) fail(403, 'capability_ceiling', 'capability_ceiling', { needed, ceiling, message: ceilingMessage(needed, ceiling) });
}

/** Sets the ceiling and keeps the former switches equal to it. Lowering it stops affected tasks at their next tool call
 * (capability_ceiling_lowered, see the engine's guard); raising it lets them be retried. */
export function setCeiling(store: Store, repositoryId: string, level: Ceiling, actor: string): void {
  const before = projectCeiling(store, repositoryId);
  store.run('UPDATE policies SET capability_ceiling=?,review_enabled=?,development_enabled=? WHERE repository_id=?', level, Number(covers(level, 'comment')), Number(level === 'develop'), repositoryId);
  if (before !== level) store.audit(actor, 'policy.capability_ceiling', `${before} -> ${level}`, repositoryId);
}
/**
 * What the policy API's former switches ask for, as a ceiling: review on means at least comment, off means read; development
 * on means develop, off at most comment. Asking for development without review is refused, since develop includes reviews.
 */
export function legacySwitchCeiling(current: Ceiling, review: unknown, development: unknown): Ceiling {
  let level = current;
  if (review === false) level = 'read'; else if (review === true && !covers(level, 'comment')) level = 'comment';
  if (development === true) { if (review === false) fail(400, 'invalid_capability_ceiling', 'development_enabled'); level = 'develop'; }
  else if (development === false && level === 'develop') level = 'comment';
  return level;
}

export function ceilingStorage(store: Store): void {
  if (!store.all('PRAGMA table_info(policies)').some(column => column.name === 'capability_ceiling'))
    store.db.exec('ALTER TABLE policies ADD COLUMN capability_ceiling TEXT');
  const pending = store.all('SELECT * FROM policies WHERE capability_ceiling IS NULL');
  if (!pending.length) return;
  store.transaction(() => {
    for (const policy of pending) {
      const level = derivedCeiling(policy);
      store.run('UPDATE policies SET capability_ceiling=?,review_enabled=?,development_enabled=? WHERE repository_id=?', level, Number(covers(level, 'comment')), Number(level === 'develop'), policy.repository_id);
      store.audit('system', 'policy.capability_ceiling_migrated', level, String(policy.repository_id));
    }
  });
}
