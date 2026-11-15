import type { Store, Row } from '../storage/database.js';
import { fail } from '../core/security.js';
import { stop } from '../agent/common.js';
import { workType } from './catalog.js';

/**
 * The project's capability ceiling (#850): the most the bot may write in a project, in three levels.
 *
 * - read: answer and review in chat; nothing is written on GitHub.
 * - comment: comments, labels, Issues and reviews on GitHub (writes on Issues and Pull requests), Actions reruns.
 * - develop: change code and open PRs as well, including Contents writes and merging, which the Manager holds by default.
 *
 * Every write the bot makes sits under it: the deliveries of work types, and github_write of project roles, Feishu groups and
 * the management assistant. Work-type writes, role permissions, a group's level and a person's grant only narrow it; event
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
 * The level today's switches and writes stand for, used once to upgrade a policy and for a policy row nothing has set the
 * ceiling on yet: develop with the development switch on, comment while any work type writes on GitHub (reviews, Actions
 * failure handling, replies), else read. It is never wider than what those settings already allowed.
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

/**
 * The level a work-type write needs. Release notes and the gate plan are written only after a person confirms them in the
 * console (发版本, 接入门禁), as that person's operation, so they need none.
 */
const writeLevels: Record<string, Ceiling> = { reply: 'comment', labels: 'comment', issue: 'comment', actions_rerun: 'comment', code: 'develop', pull_request: 'develop',
  release_notes: 'read', gate_plan: 'read' };
export const writeLevel = (write: string): Ceiling => writeLevels[write] ?? 'develop';
/** The level a github_write on a GitHub resource needs: merging a PR and pushing are Contents writes. */
export const resourceLevel = (resource: string): Ceiling => resource === 'contents' ? 'develop' : 'comment';
/**
 * The level a work type needs to run at all: reviews, replies and Actions failure handling write on GitHub, development
 * delivers code. Ordinary tasks, CI observation, release notes and gate onboarding run at any level; their writes are
 * still capped one by one.
 */
export function workLevel(id: string): Ceiling {
  const base = workType(id)?.base;
  return base === 'development' ? 'develop' : base === 'review' || base === 'reply' || base === 'actions' ? 'comment' : 'read';
}
/** The writes of a list the ceiling allows. */
export const withinCeiling = (ceiling: Ceiling, writes: string[]) => writes.filter(write => covers(ceiling, writeLevel(write)));

/** Why something above the ceiling was refused, for people: the project's level and the level needed. */
export const ceilingMessage = (needed: Ceiling, ceiling: Ceiling) =>
  `项目能力上限为「${ceilingTitles[ceiling]}」(${ceiling})，这项操作需要「${ceilingTitles[needed]}」(${needed})；项目管理员可以在「项目设置 → 监听与触发」调整。`;
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

/**
 * Once per policy (#850): the ceiling is the narrowest level today's switches and writes allow (derivedCeiling), so no project
 * gains authority. Settings that were narrower than that level are written out so every project keeps the writes it had:
 * a project that developed without reviewing keeps its review work types switched off.
 */
export function ceilingStorage(store: Store): void {
  if (!store.all('PRAGMA table_info(policies)').some(column => column.name === 'capability_ceiling'))
    store.db.exec('ALTER TABLE policies ADD COLUMN capability_ceiling TEXT');
  const pending = store.all('SELECT * FROM policies WHERE capability_ceiling IS NULL');
  if (!pending.length) return;
  store.transaction(() => {
    for (const policy of pending) {
      const level = derivedCeiling(policy);
      if (covers(level, 'comment') && !policy.review_enabled) {
        let work: Record<string, any> = {};
        try { const saved = JSON.parse(String(policy.work_settings ?? '{}')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) work = saved; } catch { work = {}; }
        for (const id of ['review.issue', 'review.pr']) if (work[id]?.enabled !== false) work[id] = { ...(work[id] ?? {}), enabled: false, version: Number(work[id]?.version ?? 0) + 1 };
        store.run('UPDATE policies SET work_settings=? WHERE repository_id=?', JSON.stringify(work), policy.repository_id);
      }
      store.run('UPDATE policies SET capability_ceiling=?,review_enabled=?,development_enabled=? WHERE repository_id=?', level, Number(covers(level, 'comment')), Number(level === 'develop'), policy.repository_id);
      store.audit('system', 'policy.capability_ceiling_migrated', level, String(policy.repository_id));
    }
  });
}
