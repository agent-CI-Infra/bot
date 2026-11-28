import type { Store, Row } from '../storage/database.js';
import { GitHub } from '../github/client.js';
import { registeredRedactor } from '../core/redaction.js';
import { TaskError } from '../agent/common.js';
import { covers, projectCeiling } from '../projects/ceiling.js';
import { installationExecutionDenied } from '../installations/archive.js';
import { validateBotBranchName } from '../github/git-push.js';

const HEX_SHA = /^[a-f0-9]{40}$/i;
const ZERO_SHA = /^0{40}$/;

/** Retention window (48 hours / 2 days) before deleting the remote `bot/*` branch of an unmerged closed Bot PR. */
export const BOT_PR_CLOSED_BRANCH_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Exponential retry delays for transient errors (rate limits, 5xx, network errors) and active-task deferrals. */
export const BOT_PR_BRANCH_CLEANUP_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
] as const;

/** Bounded retry budget for repeated non-rate-limit transient errors so broken repos never loop forever. */
export const BOT_PR_BRANCH_CLEANUP_MAX_TRANSIENT_ATTEMPTS = 24;

/** Per-tick cap for bounded legacy backfill of pre-existing closed or state-missing Bot PRs. */
export const BOT_PR_BRANCH_CLEANUP_LEGACY_BATCH_LIMIT = 10;

const TERMINAL_TASK_STATUSES_SQL = "'succeeded','pr_opened','completed','cancelled','superseded','failed'";
const TERMINAL_CLEANUP_STATUSES = new Set(['deleted', 'already_deleted', 'skipped', 'blocked']);

export type BotPrBranchCleanupStatus = 'pending' | 'deleted' | 'already_deleted' | 'skipped' | 'blocked';

export interface BotPrBranchCleanupConfig {
  retentionMs: number;
  backoffMs: readonly number[];
  maxTransientAttempts: number;
  legacyBatchLimit: number;
  now: () => number;
}

export interface LegacyBackfillSummary {
  inspected: number;
  scheduled: number;
  skipped: number;
  opened: number;
  rateLimitedRepos: Set<string>;
}

export interface BotPrBranchCleanupPlan {
  merged: number;
  closedAt: string | null;
  branchDeleteDueAt: number | null;
  branchCleanupStatus: string | null;
  branchCleanupReason: string | null;
  branchCleanupAt: string | null;
  branchCleanupAttempts: number;
  cancelledPending: boolean;
}

export interface BotPrBranchCleanupResult {
  repositoryId: string;
  prNumber: number;
  branch: string | null;
  status: BotPrBranchCleanupStatus | 'cancelled' | 'deferred' | 'noop';
  reason: string;
}

let cleanupTestOverrides: Partial<BotPrBranchCleanupConfig> | null = null;
let sharedTestClockFallback: (() => number) | null = null;
const migratedStores = new WeakSet<Store>();
const inflightByStore = new WeakMap<Store, Map<string, Promise<BotPrBranchCleanupResult>>>();

/** Allows unit and integration tests to override clock, retention window, and retry backoff deterministically. */
export function setBotPrBranchCleanupConfigForTest(overrides: Partial<BotPrBranchCleanupConfig> | null): void {
  cleanupTestOverrides = overrides ? { ...overrides } : null;
}

/** Synced by `setBotPatrolConfigForTest` so shared scanner/webhook tests keep one coherent clock. */
export function setBotPrBranchCleanupClockFallbackForTest(clock: (() => number) | null): void {
  sharedTestClockFallback = clock;
}

export function resolveBotPrBranchCleanupConfig(overrides?: Partial<BotPrBranchCleanupConfig>): BotPrBranchCleanupConfig {
  const retentionMs = cleanupTestOverrides?.retentionMs ?? overrides?.retentionMs ?? BOT_PR_CLOSED_BRANCH_RETENTION_MS;
  const backoffMs = cleanupTestOverrides?.backoffMs ?? overrides?.backoffMs ?? BOT_PR_BRANCH_CLEANUP_BACKOFF_MS;
  const maxTransientAttempts = cleanupTestOverrides?.maxTransientAttempts
    ?? overrides?.maxTransientAttempts
    ?? BOT_PR_BRANCH_CLEANUP_MAX_TRANSIENT_ATTEMPTS;
  const rawLegacyLimit = cleanupTestOverrides?.legacyBatchLimit
    ?? overrides?.legacyBatchLimit
    ?? BOT_PR_BRANCH_CLEANUP_LEGACY_BATCH_LIMIT;
  const legacyBatchLimit = Number.isFinite(rawLegacyLimit) ? Math.max(0, Math.floor(rawLegacyLimit)) : BOT_PR_BRANCH_CLEANUP_LEGACY_BATCH_LIMIT;
  const now = cleanupTestOverrides?.now ?? overrides?.now ?? sharedTestClockFallback ?? (() => Date.now());
  return { retentionMs, backoffMs, maxTransientAttempts, legacyBatchLimit, now };
}

export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normSha(value: unknown): string | null {
  const s = String(value ?? '').trim().toLowerCase();
  return HEX_SHA.test(s) && !ZERO_SHA.test(s) ? s : null;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return /^https?:\/\//i.test(s) ? s.slice(0, 1000) : null;
}

/** Encodes each path segment of a Git branch name while preserving literal `/` separators for GitHub Git Refs REST API. */
export function encodeGitRefPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/**
 * Ensures the `bot_pr_states` columns and partial indexes required for closed/merged Bot PR remote branch cleanup exist.
 * Idempotent and backward-compatible with pre-existing SQLite databases.
 */
export function ensureBotPrBranchCleanupColumns(store: Store): void {
  if (migratedStores.has(store)) return;
  if (!store.hasTable('bot_pr_states')) return;
  const cols = new Set(store.all('PRAGMA table_info(bot_pr_states)').map(c => String(c.name)));
  for (const [name, type] of [
    ['merged', 'INTEGER NOT NULL DEFAULT 0'],
    ['closed_at', 'TEXT'],
    ['branch_delete_due_at', 'INTEGER'],
    ['branch_cleanup_status', 'TEXT'],
    ['branch_cleanup_reason', 'TEXT'],
    ['branch_cleanup_at', 'TEXT'],
    ['branch_cleanup_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!cols.has(name)) store.db.exec(`ALTER TABLE bot_pr_states ADD COLUMN ${name} ${type}`);
  }
  store.db.exec(
    `CREATE INDEX IF NOT EXISTS bot_pr_states_branch_cleanup_due
     ON bot_pr_states(branch_delete_due_at, repository_id, number)
     WHERE branch_cleanup_status='pending' AND branch_delete_due_at IS NOT NULL`,
  );
  store.db.exec(
    `CREATE INDEX IF NOT EXISTS bot_pr_states_branch_cleanup_legacy_closed
     ON bot_pr_states(repository_id, number)
     WHERE lower(state)='closed' AND branch_cleanup_status IS NULL`,
  );
  migratedStores.add(store);
}

/**
 * Computes the persisted branch-cleanup scheduling fields whenever a Bot PR's state is synced.
 *
 * - Open / reopened PR: clears any scheduled cleanup (`cancelledPending: true` if previously `pending`).
 * - Merged closed PR: schedules immediate deletion (`branchDeleteDueAt = nowMs`, `status = 'pending'`).
 * - Unmerged closed PR: schedules deletion at `closedAtMs + retentionMs` (default 48h).
 * - Preserves existing terminal cleanup outcomes (`deleted` / `already_deleted` / `skipped` / `blocked`) and backoff
 *   retry schedules on duplicate syncs of the same closed PR.
 */
export function computeBotPrBranchCleanupPlan(
  prev: Row | undefined,
  state: string,
  pr: any,
  nowIso: string,
  nowMs: number,
  retentionMs = resolveBotPrBranchCleanupConfig().retentionMs,
): BotPrBranchCleanupPlan {
  const lowerState = String(state || 'open').toLowerCase();
  const prevState = prev?.state ? String(prev.state).toLowerCase() : null;
  const prevStatus = prev?.branch_cleanup_status ? String(prev.branch_cleanup_status) : null;
  const prevReason = prev?.branch_cleanup_reason ? String(prev.branch_cleanup_reason) : null;
  const prevCleanupAt = prev?.branch_cleanup_at ? String(prev.branch_cleanup_at) : null;
  const prevDueAt = prev?.branch_delete_due_at != null && Number.isFinite(Number(prev.branch_delete_due_at))
    ? Number(prev.branch_delete_due_at)
    : null;
  const prevAttempts = Number.isSafeInteger(Number(prev?.branch_cleanup_attempts)) && Number(prev?.branch_cleanup_attempts) >= 0
    ? Number(prev!.branch_cleanup_attempts)
    : 0;

  if (lowerState !== 'closed') {
    return {
      merged: 0,
      closedAt: null,
      branchDeleteDueAt: null,
      branchCleanupStatus: null,
      branchCleanupReason: null,
      branchCleanupAt: null,
      branchCleanupAttempts: 0,
      cancelledPending: prevStatus === 'pending',
    };
  }

  const prevMerged = prevState === 'closed' && Number(prev?.merged) === 1 ? 1 : 0;
  const explicitMerged = pr?.merged === true || parseIsoMs(pr?.merged_at) !== null
    ? 1
    : pr?.merged === false
      ? 0
      : null;
  // On GitHub a merged PR can never become unmerged; preserve merged=1 on partial closed payloads.
  const merged = explicitMerged === 1 ? 1 : prevMerged === 1 ? 1 : (explicitMerged ?? 0);

  const incomingClosedMs = merged === 1
    ? (parseIsoMs(pr?.merged_at) ?? parseIsoMs(pr?.closed_at))
    : parseIsoMs(pr?.closed_at);
  const prevClosedMs = prevState === 'closed' ? parseIsoMs(prev?.closed_at) : null;

  const closedMs = incomingClosedMs ?? prevClosedMs ?? nowMs;
  const closedAt = new Date(closedMs).toISOString();
  const closedAtAdvanced = prevClosedMs !== null && incomingClosedMs !== null && incomingClosedMs > prevClosedMs;
  const mergedUpgraded = prevMerged === 0 && merged === 1;

  // Already in a terminal cleanup state for this same close cycle: keep it untouched.
  if (prevState === 'closed' && prevStatus && TERMINAL_CLEANUP_STATUSES.has(prevStatus) && !mergedUpgraded && !closedAtAdvanced) {
    return {
      merged,
      closedAt,
      branchDeleteDueAt: null,
      branchCleanupStatus: prevStatus,
      branchCleanupReason: prevReason,
      branchCleanupAt: prevCleanupAt,
      branchCleanupAttempts: prevAttempts,
      cancelledPending: false,
    };
  }

  const baseDueAt = merged === 1 ? nowMs : closedMs + retentionMs;

  if (prevState === 'closed' && prevStatus === 'pending' && !mergedUpgraded && !closedAtAdvanced) {
    // Keep existing backoff/deferral schedule when attempts > 0 or when due time is unchanged.
    const nextDueAt = prevDueAt != null
      ? (prevAttempts > 0 ? Math.max(prevDueAt, baseDueAt) : baseDueAt)
      : baseDueAt;
    return {
      merged,
      closedAt,
      branchDeleteDueAt: nextDueAt,
      branchCleanupStatus: 'pending',
      branchCleanupReason: prevReason ?? (merged === 1 ? 'merged' : 'closed_retention_wait'),
      branchCleanupAt: prevCleanupAt,
      branchCleanupAttempts: prevAttempts,
      cancelledPending: false,
    };
  }

  return {
    merged,
    closedAt,
    branchDeleteDueAt: baseDueAt,
    branchCleanupStatus: 'pending',
    branchCleanupReason: merged === 1 ? 'merged' : 'closed_retention_wait',
    branchCleanupAt: prevState === 'closed' && !closedAtAdvanced && !mergedUpgraded ? prevCleanupAt : null,
    branchCleanupAttempts: 0,
    cancelledPending: false,
  };
}

/**
 * Checks whether any non-terminal task in this repository is still bound to `branch` or the PR.
 * Fails closed across direct task ownership (`bot_branches`, `bot_pull_requests.source_task_id`), PR-targeted tasks,
 * `development_candidates`, and `tasks.input` branch references.
 */
export function findActiveTasksBoundToBranch(
  store: Store,
  repositoryId: string,
  prNumber: number,
  branch: string,
  owned: Row,
): Row[] {
  if (!store.hasTable('tasks')) return [];
  const sourceTaskId = String(owned.source_task_id ?? '').trim();
  const hasBotBranches = store.hasTable('bot_branches');
  const hasCandidates = store.hasTable('development_candidates');

  const conditions: string[] = [
    `(t.object_number=? AND (t.kind LIKE '%.pr' OR (t.kind='task.request' AND json_valid(t.input) AND json_extract(t.input,'$.target.type')='pr')))`,
    `(json_valid(t.input) AND (
      json_extract(t.input,'$.branch')=?
      OR json_extract(t.input,'$.bot_pr.head.ref')=?
      OR json_extract(t.input,'$.pr.head.ref')=?
      OR (json_extract(t.input,'$.target.type')='branch' AND json_extract(t.input,'$.target.ref')=?)
    ))`,
  ];
  const params: Array<string | number> = [
    repositoryId,
    prNumber,
    branch,
    branch,
    branch,
    branch,
  ];
  if (sourceTaskId) {
    conditions.push('t.id=?');
    params.push(sourceTaskId);
  }
  if (hasBotBranches) {
    conditions.push('t.id IN (SELECT task_id FROM bot_branches WHERE repository_id=? AND branch=?)');
    params.push(repositoryId, branch);
  }
  if (hasCandidates) {
    conditions.push("t.id IN (SELECT task_id FROM development_candidates WHERE json_valid(data) AND json_extract(data,'$.branch')=?)");
    params.push(branch);
  }

  return store.all(
    `SELECT t.id, t.kind, t.status
     FROM tasks t
     WHERE t.repository_id=?
       AND t.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
       AND (${conditions.join(' OR ')})`,
    ...params,
  );
}

/** Returns true if another open bot PR in this repository still references `branch` as either its head or its base. */
export function hasOtherOpenLocalBotPrOnBranch(
  store: Store,
  repositoryId: string,
  branch: string,
  excludePrNumber: number,
): boolean {
  if (!store.hasTable('bot_pull_requests')) return false;
  if (!store.hasTable('bot_pr_states')) {
    return Boolean(
      store.get(
        'SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND branch=? AND number<>? LIMIT 1',
        repositoryId,
        branch,
        excludePrNumber,
      ),
    );
  }
  return Boolean(
    store.get(
      `SELECT 1
       FROM bot_pull_requests b
       LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
       WHERE b.repository_id=? AND b.number<>? AND lower(coalesce(s.state,'open'))='open'
         AND (b.branch=? OR s.base_ref=?)
       LIMIT 1`,
      repositoryId,
      excludePrNumber,
      branch,
      branch,
    ),
  );
}

function backoffDelayMs(attempts: number, schedule: readonly number[]): number {
  if (!schedule.length) return 60_000;
  const idx = Math.min(Math.max(0, attempts - 1), schedule.length - 1);
  return Math.max(1, Number(schedule[idx] ?? 60_000));
}

function auditResource(prNumber: number, branch: string | null, reason?: string): string {
  const safeBranch = (branch || 'unknown').slice(0, 200);
  return reason ? `pr#${prNumber}:${safeBranch}:${reason.slice(0, 120)}` : `pr#${prNumber}:${safeBranch}`;
}

function recordCleanupOutcome(
  store: Store,
  repositoryId: string,
  prNumber: number,
  branch: string | null,
  status: BotPrBranchCleanupStatus,
  reason: string,
  nowIso: string,
  options: {
    dueAt?: number | null;
    attempts?: number;
    auditAction?: string | null;
    removeBotBranch?: boolean;
    owned?: Row;
  } = {},
): boolean {
  if (!store.db.isOpen || !store.hasTable('bot_pr_states')) return false;
  let updated = false;
  store.transaction(() => {
    const live = store.get('SELECT state,branch_cleanup_status,branch_cleanup_reason FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
    if (!live || String(live.state || '').toLowerCase() !== 'closed') return;
    store.run(
      `UPDATE bot_pr_states
       SET branch_cleanup_status=?,
           branch_cleanup_reason=?,
           branch_cleanup_at=?,
           branch_delete_due_at=?,
           branch_cleanup_attempts=?,
           updated_at=?
       WHERE repository_id=? AND number=?`,
      status,
      reason.slice(0, 200),
      nowIso,
      options.dueAt ?? null,
      options.attempts ?? 0,
      nowIso,
      repositoryId,
      prNumber,
    );
    updated = true;

    if (options.removeBotBranch && branch && store.hasTable('bot_branches') && options.owned) {
      const stillReferenced = hasOtherOpenLocalBotPrOnBranch(store, repositoryId, branch, prNumber)
        || findActiveTasksBoundToBranch(store, repositoryId, prNumber, branch, options.owned).length > 0;
      if (!stillReferenced) {
        store.run('DELETE FROM bot_branches WHERE repository_id=? AND branch=?', repositoryId, branch);
      }
    }

    if (options.auditAction) {
      const duplicatePendingAudit = status === 'pending' && String(live.branch_cleanup_reason || '') === reason;
      if (!duplicatePendingAudit) {
        store.audit(
          'system',
          options.auditAction,
          status === 'deleted' || status === 'already_deleted'
            ? auditResource(prNumber, branch)
            : auditResource(prNumber, branch, reason),
          repositoryId,
        );
      }
    }
  });
  return updated;
}

function recordReopenedCancellation(
  store: Store,
  repositoryId: string,
  prNumber: number,
  branch: string | null,
  livePr: any,
  nowIso: string,
): void {
  if (!store.db.isOpen || !store.hasTable('bot_pr_states')) return;
  store.transaction(() => {
    const live = store.get('SELECT branch_cleanup_status FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
    if (!live) return;
    const headSha = normSha(livePr?.head?.sha);
    const baseRef = typeof livePr?.base?.ref === 'string' && livePr.base.ref ? livePr.base.ref : null;
    const baseSha = normSha(livePr?.base?.sha);
    const draft = livePr?.draft === true ? 1 : 0;
    store.run(
      `UPDATE bot_pr_states
       SET state='open',
           draft=?,
           base_ref=coalesce(?,base_ref),
           base_sha=coalesce(?,base_sha),
           head_sha=coalesce(?,head_sha),
           merged=0,
           closed_at=NULL,
           branch_delete_due_at=NULL,
           branch_cleanup_status=NULL,
           branch_cleanup_reason=NULL,
           branch_cleanup_at=NULL,
           branch_cleanup_attempts=0,
           updated_at=?
       WHERE repository_id=? AND number=?`,
      draft,
      baseRef,
      baseSha,
      headSha,
      nowIso,
      repositoryId,
      prNumber,
    );
    if (String(live.branch_cleanup_status || '') === 'pending') {
      store.audit('system', 'bot_pr.branch_cleanup_cancelled', auditResource(prNumber, branch, 'reopened'), repositoryId);
    }
  });
}

function classifyCleanupError(
  error: unknown,
  mintedWriteToken: boolean,
): { transient: boolean; rateLimited: boolean; reason: string; retryAfterMs?: number } {
  if (error instanceof TaskError) {
    const code = String(error.code || 'unknown_error');
    if (code === 'github_rate_limited') {
      return { transient: true, rateLimited: true, reason: 'github_rate_limited', retryAfterMs: error.retryAfterMs };
    }
    if (
      code === 'github_unavailable'
      || code === 'github_response_unknown'
      || code === 'github_http_429'
      || code === 'github_invalid_response'
      || /^github_http_5\d\d$/.test(code)
    ) {
      return { transient: true, rateLimited: false, reason: code, retryAfterMs: error.retryAfterMs };
    }
    if (code === 'github_http_422') {
      return {
        transient: false,
        rateLimited: false,
        reason: mintedWriteToken ? 'branch_protected_422' : 'missing_contents_write',
      };
    }
    if (code === 'github_permission_403' || code === 'github_permissions_insufficient' || code === 'github_token_missing') {
      return { transient: false, rateLimited: false, reason: 'missing_contents_write' };
    }
    if (
      code === 'github_permission_401'
      || code === 'github_permission_404'
      || code === 'github_installation_access_revoked'
      || code === 'github_installation_owner_changed'
      || code === 'github_repository_scope_changed'
      || code === 'github_account_missing'
      || code === 'github_credentials_missing'
      || code === 'github_repository_invalid'
      || /^github_http_4\d\d$/.test(code)
    ) {
      return { transient: false, rateLimited: false, reason: code };
    }
    return { transient: error.state === 'retry_wait', rateLimited: false, reason: code, retryAfterMs: error.retryAfterMs };
  }
  return { transient: true, rateLimited: false, reason: 'transient_runtime_error' };
}

interface LocalPreflightOk {
  ok: true;
  repo: Row;
  policy: Row;
  owned: Row;
  prState: Row;
  branch: string;
  attempts: number;
}

type LocalPreflightOutcome = LocalPreflightOk | { ok: false; result: BotPrBranchCleanupResult };

/**
 * Performs all local ownership, branch-safety, policy, capability ceiling, open-PR, and active-task checks
 * before opening any GitHub connection.
 */
function runLocalPreflight(
  store: Store,
  repositoryId: string,
  prNumber: number,
  nowMs: number,
  nowIso: string,
  cfg: BotPrBranchCleanupConfig,
): LocalPreflightOutcome {
  if (!store.db.isOpen || !store.hasTable('bot_pull_requests') || !store.hasTable('bot_pr_states')) {
    return { ok: false, result: { repositoryId, prNumber, branch: null, status: 'noop', reason: 'storage_unavailable' } };
  }
  ensureBotPrBranchCleanupColumns(store);

  const repo = store.get('SELECT * FROM repositories WHERE id=?', repositoryId);
  if (!repo) {
    return { ok: false, result: { repositoryId, prNumber, branch: null, status: 'noop', reason: 'repository_missing' } };
  }

  const owned = store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber);
  if (!owned) {
    return { ok: false, result: { repositoryId, prNumber, branch: null, status: 'noop', reason: 'not_bot_pr' } };
  }

  const prState = store.get('SELECT * FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
  const rawBranch = typeof owned.branch === 'string' ? owned.branch.trim() : '';
  const branch = rawBranch || null;

  if (!prState) {
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'noop', reason: 'state_missing' } };
  }
  if (String(prState.state || '').toLowerCase() !== 'closed') {
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'noop', reason: 'pr_not_closed' } };
  }
  if (String(prState.branch_cleanup_status || '') !== 'pending') {
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'noop', reason: 'not_pending' } };
  }

  const dueAt = prState.branch_delete_due_at != null ? Number(prState.branch_delete_due_at) : null;
  if (dueAt !== null && Number.isFinite(dueAt) && nowMs < dueAt) {
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'not_due_yet' } };
  }

  const merged = Number(prState.merged) === 1;
  if (!merged) {
    const closedMs = parseIsoMs(prState.closed_at);
    if (closedMs !== null && nowMs < closedMs + cfg.retentionMs) {
      const nextDue = Math.max(dueAt ?? 0, closedMs + cfg.retentionMs);
      store.run(
        'UPDATE bot_pr_states SET branch_delete_due_at=?, branch_cleanup_reason=? WHERE repository_id=? AND number=?',
        nextDue,
        'closed_retention_wait',
        repositoryId,
        prNumber,
      );
      return { ok: false, result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'closed_retention_wait' } };
    }
  }

  // Strict ownership & branch-name boundary: same repository + strict `bot/*` branch, never base/default branch.
  if (String(owned.head_repository_id) !== String(repositoryId)) {
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'cross_repository_head', nowIso, {
      auditAction: 'bot_pr.branch_cleanup_skipped',
    });
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'cross_repository_head' } };
  }

  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const policyBase = String(policy?.base_branch || '').trim();
  const savedBase = String(prState.base_ref || '').trim();
  const branchErr = !branch
    ? 'Missing branch name.'
    : validateBotBranchName(branch, policyBase || 'main', savedBase || null);
  if (!branch || branchErr || branch === 'main' || branch === 'master' || (policyBase && branch === policyBase) || (savedBase && branch === savedBase)) {
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'invalid_or_protected_branch', nowIso, {
      auditAction: 'bot_pr.branch_cleanup_skipped',
    });
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'invalid_or_protected_branch' } };
  }

  // Respect project enabled state, capability ceiling (`develop` required for `contents: write`), and installation status.
  if (!policy?.enabled) {
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', 'project_disabled', nowIso, {
      auditAction: 'bot_pr.branch_cleanup_blocked',
    });
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'blocked', reason: 'project_disabled' } };
  }
  if (!covers(projectCeiling(store, repositoryId, policy), 'develop')) {
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', 'capability_ceiling_insufficient', nowIso, {
      auditAction: 'bot_pr.branch_cleanup_blocked',
    });
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'blocked', reason: 'capability_ceiling_insufficient' } };
  }
  if (installationExecutionDenied(store, String(repo.account_id), repositoryId)) {
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', 'installation_access_revoked', nowIso, {
      auditAction: 'bot_pr.branch_cleanup_blocked',
    });
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'blocked', reason: 'installation_access_revoked' } };
  }

  if (hasOtherOpenLocalBotPrOnBranch(store, repositoryId, branch, prNumber)) {
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'other_open_pr_exists', nowIso, {
      auditAction: 'bot_pr.branch_cleanup_skipped',
    });
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'other_open_pr_exists' } };
  }

  const attempts = Number.isSafeInteger(Number(prState.branch_cleanup_attempts)) && Number(prState.branch_cleanup_attempts) >= 0
    ? Number(prState.branch_cleanup_attempts)
    : 0;

  const activeTasks = findActiveTasksBoundToBranch(store, repositoryId, prNumber, branch, owned);
  if (activeTasks.length > 0) {
    const nextAttempts = attempts + 1;
    const delay = backoffDelayMs(nextAttempts, cfg.backoffMs);
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', 'active_task_bound', nowIso, {
      dueAt: nowMs + delay,
      attempts: nextAttempts,
      auditAction: 'bot_pr.branch_cleanup_deferred',
    });
    return { ok: false, result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'active_task_bound' } };
  }

  return { ok: true, repo, policy, owned, prState, branch, attempts };
}

function applyCleanupError(
  store: Store,
  repositoryId: string,
  prNumber: number,
  branch: string | null,
  attempts: number,
  nowMs: number,
  nowIso: string,
  cfg: BotPrBranchCleanupConfig,
  error: unknown,
  mintedWriteToken: boolean,
): BotPrBranchCleanupResult {
  const classified = classifyCleanupError(error, mintedWriteToken);
  if (!classified.transient) {
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', classified.reason, nowIso, {
      auditAction: 'bot_pr.branch_cleanup_blocked',
    });
    return { repositoryId, prNumber, branch, status: 'blocked', reason: classified.reason };
  }

  const nextAttempts = attempts + 1;
  if (!classified.rateLimited && nextAttempts >= cfg.maxTransientAttempts) {
    const exhaustedReason = `${classified.reason}:retry_exhausted`;
    recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', exhaustedReason, nowIso, {
      attempts: nextAttempts,
      auditAction: 'bot_pr.branch_cleanup_blocked',
    });
    return { repositoryId, prNumber, branch, status: 'blocked', reason: exhaustedReason };
  }

  const baseDelay = backoffDelayMs(nextAttempts, cfg.backoffMs);
  const retryAfter = typeof classified.retryAfterMs === 'number' && Number.isFinite(classified.retryAfterMs) && classified.retryAfterMs > 0
    ? classified.retryAfterMs
    : 0;
  const delay = Math.max(baseDelay, retryAfter);
  recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', classified.reason, nowIso, {
    dueAt: nowMs + delay,
    attempts: nextAttempts,
    auditAction: 'bot_pr.branch_cleanup_deferred',
  });
  return { repositoryId, prNumber, branch, status: 'deferred', reason: classified.reason };
}

type LivePrVerifyOutcome =
  | { ok: true; branch: string; prHeadSha: string; liveBaseRef: string | null }
  | { ok: false; reason: string };

function verifyLiveBotPrOwnershipAndBranch(
  owned: Row,
  livePr: any,
  repositoryId: string,
  policyBase: string,
  savedBase: string,
  liveDefaultBranch: string,
): LivePrVerifyOutcome {
  const branch = typeof owned.branch === 'string' ? owned.branch.trim() : '';
  if (/^\d+$/.test(String(owned.pr_id)) && livePr.id != null && String(livePr.id) !== String(owned.pr_id)) {
    return { ok: false, reason: 'pr_id_mismatch' };
  }
  if (livePr.user?.id == null || String(livePr.user.id) !== String(owned.author_id)) {
    return { ok: false, reason: 'pr_author_mismatch' };
  }
  if (
    livePr.head?.repo?.id == null
    || String(livePr.head.repo.id) !== String(owned.head_repository_id)
    || String(livePr.head.repo.id) !== repositoryId
  ) {
    return { ok: false, reason: 'head_repository_mismatch' };
  }
  if (!branch || String(livePr.head?.ref || '') !== branch) {
    return { ok: false, reason: 'head_branch_mismatch' };
  }
  const liveBaseRef = typeof livePr.base?.ref === 'string' ? livePr.base.ref.trim() : '';
  const liveBranchErr = validateBotBranchName(branch, liveDefaultBranch || policyBase || 'main', liveBaseRef || savedBase || null);
  if (
    liveBranchErr
    || branch === 'main'
    || branch === 'master'
    || (policyBase && branch === policyBase)
    || (savedBase && branch === savedBase)
    || (liveDefaultBranch && branch === liveDefaultBranch)
    || (liveBaseRef && branch === liveBaseRef)
  ) {
    return { ok: false, reason: 'protected_or_base_branch' };
  }
  const prHeadSha = normSha(livePr.head?.sha);
  if (!prHeadSha) {
    return { ok: false, reason: 'pr_head_sha_missing' };
  }
  return { ok: true, branch, prHeadSha, liveBaseRef: liveBaseRef || null };
}

async function runLiveVerifiedCleanup(
  store: Store,
  github: GitHub,
  pre: LocalPreflightOk,
  cfg: BotPrBranchCleanupConfig,
  isClosing?: () => boolean,
): Promise<{ result: BotPrBranchCleanupResult; rateLimited: boolean }> {
  const { owned, branch, attempts } = pre;
  const repositoryId = String(pre.repo.id);
  const prNumber = Number(owned.number);
  const nowMs = cfg.now();
  const nowIso = new Date(nowMs).toISOString();

  if (isClosing?.() || !store.db.isOpen) {
    return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
  }

  let mintedWriteToken = false;
  try {
    // 1. Live PR verification via read-only token: state, author, head repo, head ref, base/default branch, closed_at + 48h.
    const livePr = await github.request('GET', github.path(`/pulls/${prNumber}`), undefined, true);
    if (!store.db.isOpen || isClosing?.()) {
      return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
    }
    if (!livePr || typeof livePr !== 'object') {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'pr_not_found', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'pr_not_found' }, rateLimited: false };
    }

    const liveState = String(livePr.state || '').toLowerCase();
    if (liveState === 'open') {
      recordReopenedCancellation(store, repositoryId, prNumber, branch, livePr, nowIso);
      return { result: { repositoryId, prNumber, branch, status: 'cancelled', reason: 'pr_reopened' }, rateLimited: false };
    }
    if (liveState !== 'closed') {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'pr_not_closed', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'pr_not_closed' }, rateLimited: false };
    }

    const policyBase = String(pre.policy?.base_branch || '').trim();
    const savedBase = String(pre.prState?.base_ref || '').trim();
    const liveDefaultBranch = String(github.defaultBranch || '').trim();
    const verified = verifyLiveBotPrOwnershipAndBranch(owned, livePr, repositoryId, policyBase, savedBase, liveDefaultBranch);
    if (!verified.ok) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', verified.reason, nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: verified.reason }, rateLimited: false };
    }
    const { prHeadSha } = verified;

    const liveMerged = livePr.merged === true || parseIsoMs(livePr.merged_at) !== null;
    if (!liveMerged) {
      const liveClosedMs = parseIsoMs(livePr.closed_at);
      if (liveClosedMs === null) {
        const nextAttempts = attempts + 1;
        const delay = backoffDelayMs(nextAttempts, cfg.backoffMs);
        recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', 'live_closed_at_missing', nowIso, {
          dueAt: nowMs + delay,
          attempts: nextAttempts,
          auditAction: 'bot_pr.branch_cleanup_deferred',
        });
        return { result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'live_closed_at_missing' }, rateLimited: false };
      }
      const liveClosedIso = new Date(liveClosedMs).toISOString();
      const liveDueAt = liveClosedMs + cfg.retentionMs;
      store.run(
        "UPDATE bot_pr_states SET merged=0, closed_at=?, head_sha=? WHERE repository_id=? AND number=? AND lower(state)='closed'",
        liveClosedIso,
        prHeadSha,
        repositoryId,
        prNumber,
      );
      if (nowMs < liveDueAt) {
        recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', 'closed_retention_wait', nowIso, {
          dueAt: liveDueAt,
          attempts: 0,
          auditAction: 'bot_pr.branch_cleanup_deferred',
        });
        return { result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'closed_retention_wait' }, rateLimited: false };
      }
    } else {
      const liveMergedIso = new Date(parseIsoMs(livePr.merged_at) ?? parseIsoMs(livePr.closed_at) ?? nowMs).toISOString();
      store.run(
        "UPDATE bot_pr_states SET merged=1, closed_at=?, head_sha=? WHERE repository_id=? AND number=? AND lower(state)='closed'",
        liveMergedIso,
        prHeadSha,
        repositoryId,
        prNumber,
      );
    }

    // 2. Live ref verification via read-only token: existence (404 => already deleted) and exact HEAD SHA match.
    const encodedBranch = encodeGitRefPath(branch);
    const refObj = await github.request('GET', github.path('/git/ref/heads/' + encodedBranch), undefined, true, github.token, true);
    if (!store.db.isOpen || isClosing?.()) {
      return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
    }
    if (!refObj) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'already_deleted', 'remote_branch_missing', nowIso, {
        auditAction: 'bot_pr.branch_already_deleted',
        removeBotBranch: true,
        owned,
      });
      return { result: { repositoryId, prNumber, branch, status: 'already_deleted', reason: 'remote_branch_missing' }, rateLimited: false };
    }
    if (Array.isArray(refObj) || typeof refObj !== 'object') {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'ref_ambiguous', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'ref_ambiguous' }, rateLimited: false };
    }
    if (typeof refObj.ref === 'string' && refObj.ref !== `refs/heads/${branch}`) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'ref_mismatch', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'ref_mismatch' }, rateLimited: false };
    }
    if (refObj.object?.type && String(refObj.object.type) !== 'commit') {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'ref_not_commit', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'ref_not_commit' }, rateLimited: false };
    }
    const remoteHeadSha = normSha(refObj.object?.sha);
    if (!remoteHeadSha || remoteHeadSha !== prHeadSha) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'head_sha_changed', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'head_sha_changed' }, rateLimited: false };
    }

    // 3. Live open-PR check via read-only token: refuse if ANY open PR uses `<owner>:<branch>` as head OR `<branch>` as base.
    const [owner] = String(github.fullName || '').split('/');
    if (!owner) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'repository_owner_unknown', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'repository_owner_unknown' }, rateLimited: false };
    }
    const openHeadPrs = await github.request(
      'GET',
      github.path('/pulls?state=open&per_page=10&head=' + encodeURIComponent(`${owner}:${branch}`)),
    );
    if (!store.db.isOpen || isClosing?.()) {
      return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
    }
    if (!Array.isArray(openHeadPrs)) {
      const nextAttempts = attempts + 1;
      const delay = backoffDelayMs(nextAttempts, cfg.backoffMs);
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', 'open_prs_invalid_response', nowIso, {
        dueAt: nowMs + delay,
        attempts: nextAttempts,
        auditAction: 'bot_pr.branch_cleanup_deferred',
      });
      return { result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'open_prs_invalid_response' }, rateLimited: false };
    }
    if (openHeadPrs.some((p: any) => p && typeof p === 'object' && String(p.state ?? 'open').toLowerCase() === 'open' && (p.head?.ref == null || String(p.head.ref) === branch))) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'other_open_pr_exists', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'other_open_pr_exists' }, rateLimited: false };
    }

    const openBasePrs = await github.request(
      'GET',
      github.path('/pulls?state=open&per_page=10&base=' + encodeURIComponent(branch)),
    );
    if (!store.db.isOpen || isClosing?.()) {
      return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
    }
    if (!Array.isArray(openBasePrs)) {
      const nextAttempts = attempts + 1;
      const delay = backoffDelayMs(nextAttempts, cfg.backoffMs);
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', 'open_prs_invalid_response', nowIso, {
        dueAt: nowMs + delay,
        attempts: nextAttempts,
        auditAction: 'bot_pr.branch_cleanup_deferred',
      });
      return { result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'open_prs_invalid_response' }, rateLimited: false };
    }
    if (openBasePrs.some((p: any) => p && typeof p === 'object' && String(p.state ?? 'open').toLowerCase() === 'open' && (p.base?.ref == null || String(p.base.ref) === branch))) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'other_open_pr_uses_branch_as_base', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'other_open_pr_uses_branch_as_base' }, rateLimited: false };
    }

    // 4. Re-verify local policy, installation, PR state, other local open PRs, and active tasks across awaits (TOCTOU fence).
    const freshPolicy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
    if (!freshPolicy?.enabled) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', 'project_disabled', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_blocked',
      });
      return { result: { repositoryId, prNumber, branch, status: 'blocked', reason: 'project_disabled' }, rateLimited: false };
    }
    if (!covers(projectCeiling(store, repositoryId, freshPolicy), 'develop')) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', 'capability_ceiling_insufficient', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_blocked',
      });
      return { result: { repositoryId, prNumber, branch, status: 'blocked', reason: 'capability_ceiling_insufficient' }, rateLimited: false };
    }
    if (installationExecutionDenied(store, String(pre.repo.account_id), repositoryId)) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', 'installation_access_revoked', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_blocked',
      });
      return { result: { repositoryId, prNumber, branch, status: 'blocked', reason: 'installation_access_revoked' }, rateLimited: false };
    }
    const freshState = store.get('SELECT state,branch_cleanup_status FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
    if (!freshState || String(freshState.state || '').toLowerCase() !== 'closed' || String(freshState.branch_cleanup_status || '') !== 'pending') {
      return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'state_changed_concurrently' }, rateLimited: false };
    }
    if (hasOtherOpenLocalBotPrOnBranch(store, repositoryId, branch, prNumber)) {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'skipped', 'other_open_pr_exists', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_skipped',
      });
      return { result: { repositoryId, prNumber, branch, status: 'skipped', reason: 'other_open_pr_exists' }, rateLimited: false };
    }
    if (findActiveTasksBoundToBranch(store, repositoryId, prNumber, branch, owned).length > 0) {
      const nextAttempts = attempts + 1;
      const delay = backoffDelayMs(nextAttempts, cfg.backoffMs);
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', 'active_task_bound', nowIso, {
        dueAt: nowMs + delay,
        attempts: nextAttempts,
        auditAction: 'bot_pr.branch_cleanup_deferred',
      });
      return { result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'active_task_bound' }, rateLimited: false };
    }

    // 5. Check App installation `contents: write` grant before minting a single-use write token.
    if (github.isAppInstallation && github.installationPermissions && github.installationPermissions.contents !== 'write') {
      recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', 'missing_contents_write', nowIso, {
        auditAction: 'bot_pr.branch_cleanup_blocked',
      });
      return { result: { repositoryId, prNumber, branch, status: 'blocked', reason: 'missing_contents_write' }, rateLimited: false };
    }

    // 6. Mint a single-use minimal `{ contents: 'write' }` token (for GitHub App), delete the ref, and revoke immediately.
    let deletedStatus: 'deleted' | 'already_deleted' = 'deleted';
    await github.withPermissions({ contents: 'write' }, async (writeToken, granted) => {
      if (github.isAppInstallation && granted && Object.keys(granted).length > 0 && granted.contents !== 'write') {
        throw new TaskError('github_permissions_insufficient', 'waiting_permission', 'Installation token lacks contents: write.');
      }
      mintedWriteToken = true;
      const deleteRes = await github.request(
        'DELETE',
        github.path('/git/refs/heads/' + encodedBranch),
        undefined,
        true,
        writeToken,
      );
      if (deleteRes === null || github.status === 404) {
        deletedStatus = 'already_deleted';
      }
    });
    mintedWriteToken = false;

    // 7. Post-delete read-only verification: confirm 404 before marking terminal `deleted` so an asynchronous racing push
    //    (e.g. a cancelling task finishing a push right after DELETE) cannot leave an untracked orphan branch behind.
    if (deletedStatus === 'deleted') {
      if (!store.db.isOpen || isClosing?.()) {
        return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
      }
      const postDeleteRef = await github.request(
        'GET',
        github.path('/git/ref/heads/' + encodedBranch),
        undefined,
        true,
        github.token,
        true,
      );
      if (!store.db.isOpen || isClosing?.()) {
        return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
      }
      if (postDeleteRef) {
        const nextAttempts = attempts + 1;
        if (nextAttempts >= cfg.maxTransientAttempts) {
          const exhaustedReason = 'branch_recreated_after_delete:retry_exhausted';
          recordCleanupOutcome(store, repositoryId, prNumber, branch, 'blocked', exhaustedReason, nowIso, {
            attempts: nextAttempts,
            auditAction: 'bot_pr.branch_cleanup_blocked',
          });
          return { result: { repositoryId, prNumber, branch, status: 'blocked', reason: exhaustedReason }, rateLimited: false };
        }
        const delay = backoffDelayMs(nextAttempts, cfg.backoffMs);
        recordCleanupOutcome(store, repositoryId, prNumber, branch, 'pending', 'branch_recreated_after_delete', nowIso, {
          dueAt: nowMs + delay,
          attempts: nextAttempts,
          auditAction: 'bot_pr.branch_cleanup_deferred',
        });
        return { result: { repositoryId, prNumber, branch, status: 'deferred', reason: 'branch_recreated_after_delete' }, rateLimited: false };
      }
    }

    const reason = deletedStatus === 'deleted'
      ? (liveMerged ? 'merged' : 'closed_48h_expired')
      : 'remote_branch_missing';
    recordCleanupOutcome(store, repositoryId, prNumber, branch, deletedStatus, reason, nowIso, {
      auditAction: deletedStatus === 'deleted' ? 'bot_pr.branch_deleted' : 'bot_pr.branch_already_deleted',
      removeBotBranch: true,
      owned,
    });
    return { result: { repositoryId, prNumber, branch, status: deletedStatus, reason }, rateLimited: false };
  } catch (error) {
    if (!store.db.isOpen || isClosing?.()) {
      return { result: { repositoryId, prNumber, branch, status: 'noop', reason: 'closing' }, rateLimited: false };
    }
    const result = applyCleanupError(store, repositoryId, prNumber, branch, attempts, nowMs, nowIso, cfg, error, mintedWriteToken);
    const rateLimited = error instanceof TaskError && error.code === 'github_rate_limited';
    return { result, rateLimited };
  }
}

function getStoreInflight(store: Store): Map<string, Promise<BotPrBranchCleanupResult>> {
  let map = inflightByStore.get(store);
  if (!map) {
    map = new Map();
    inflightByStore.set(store, map);
  }
  return map;
}

/**
 * Runs live-verified remote branch cleanup for a single closed/merged Bot PR, deduplicated per `(store, repo, prNumber)`.
 */
export function cleanupBotPrBranch(
  store: Store,
  repositoryId: string,
  prNumber: number,
  options?: {
    apiUrl?: string;
    github?: GitHub;
    now?: () => number;
    isClosing?: () => boolean;
  },
): Promise<BotPrBranchCleanupResult> {
  const inflight = getStoreInflight(store);
  const key = `${repositoryId}:${prNumber}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const work = (async (): Promise<BotPrBranchCleanupResult> => {
    const cfg = resolveBotPrBranchCleanupConfig(options?.now ? { now: options.now } : undefined);
    if (options?.isClosing?.() || !store.db.isOpen) {
      return { repositoryId, prNumber, branch: null, status: 'noop', reason: 'closing' };
    }
    const nowMs = cfg.now();
    const nowIso = new Date(nowMs).toISOString();
    const pre = runLocalPreflight(store, repositoryId, prNumber, nowMs, nowIso, cfg);
    if (!pre.ok) return pre.result;

    if (options?.github) {
      const { result } = await runLiveVerifiedCleanup(store, options.github, pre, cfg, options.isClosing);
      return result;
    }

    const redactor = registeredRedactor(store);
    const github = new GitHub(store, pre.repo, redactor, async () => {}, options?.apiUrl);
    github.purpose = 'bot_pr_branch_cleanup';
    try {
      await github.connect(false, { contents: 'read', pull_requests: 'read' }, undefined, false);
      const { result } = await runLiveVerifiedCleanup(store, github, pre, cfg, options?.isClosing);
      return result;
    } catch (error) {
      if (!store.db.isOpen || options?.isClosing?.()) {
        return { repositoryId, prNumber, branch: pre.branch, status: 'noop', reason: 'closing' };
      }
      return applyCleanupError(store, repositoryId, prNumber, pre.branch, pre.attempts, nowMs, nowIso, cfg, error, false);
    } finally {
      await github.revokeTokens('bot_pr_branch_cleanup').catch(() => {});
    }
  })().catch(() => ({
    repositoryId,
    prNumber,
    branch: null,
    status: 'noop' as const,
    reason: 'cleanup_error',
  })).finally(() => {
    if (inflight.get(key) === work) inflight.delete(key);
  });

  inflight.set(key, work);
  return work;
}

/**
 * Schedules immediate asynchronous branch cleanup without blocking webhook HTTP responses.
 * Deduplicated per `(store, repositoryId, prNumber)` and tracked so shutdown/tests can cleanly await completion.
 */
export function scheduleBotPrBranchCleanup(
  store: Store,
  repositoryId: string,
  prNumber: number,
  apiUrl?: string,
  options?: {
    onTrack?: (work: Promise<BotPrBranchCleanupResult>) => void;
    now?: () => number;
    isClosing?: () => boolean;
  },
): Promise<BotPrBranchCleanupResult> {
  const inflight = getStoreInflight(store);
  const key = `${repositoryId}:${prNumber}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const scheduled = new Promise<BotPrBranchCleanupResult>(resolve => {
    setImmediate(() => {
      if (options?.isClosing?.() || !store.db.isOpen) {
        resolve({ repositoryId, prNumber, branch: null, status: 'noop', reason: 'closing' });
        return;
      }
      // Remove the scheduling placeholder before invoking cleanupBotPrBranch so it registers the real run.
      if (inflight.get(key) === scheduled) inflight.delete(key);
      void cleanupBotPrBranch(store, repositoryId, prNumber, {
        apiUrl,
        now: options?.now,
        isClosing: options?.isClosing,
      }).then(resolve, () => resolve({ repositoryId, prNumber, branch: null, status: 'noop', reason: 'cleanup_error' }));
    });
  }).finally(() => {
    if (inflight.get(key) === scheduled) inflight.delete(key);
  });

  inflight.set(key, scheduled);
  options?.onTrack?.(scheduled);
  return scheduled;
}

/** Awaits all currently scheduled or in-flight Bot PR branch cleanups for `store`. */
export async function awaitPendingBranchCleanups(store: Store): Promise<void> {
  for (;;) {
    const inflight = inflightByStore.get(store);
    if (!inflight || inflight.size === 0) return;
    await Promise.allSettled([...inflight.values()]);
  }
}

interface LegacyBackfillWrite {
  state: 'open' | 'closed';
  draft?: number;
  baseRef?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  mergeable?: number | null;
  mergeableState?: string | null;
  title?: string | null;
  htmlUrl?: string | null;
  merged: number;
  closedAt: string | null;
  branchDeleteDueAt: number | null;
  branchCleanupStatus: BotPrBranchCleanupStatus | null;
  branchCleanupReason: string | null;
  branchCleanupAt: string | null;
  branchCleanupAttempts: number;
  auditAction?: string | null;
  auditReason?: string;
}

function writeLegacyBackfillOutcome(
  store: Store,
  repositoryId: string,
  prNumber: number,
  branch: string | null,
  expectedClosedState: boolean,
  nowIso: string,
  write: LegacyBackfillWrite,
): boolean {
  if (!store.db.isOpen || !store.hasTable('bot_pr_states') || !store.hasTable('bot_pull_requests')) return false;
  let updated = false;
  store.transaction(() => {
    if (!store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber)) return;
    const current = store.get('SELECT state,branch_cleanup_status FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
    if (expectedClosedState) {
      if (!current || String(current.state || '').toLowerCase() !== 'closed' || current.branch_cleanup_status != null) return;
    } else if (current) {
      if (current.branch_cleanup_status != null || String(current.state || '').toLowerCase() !== 'closed') return;
    }

    store.run(
      `INSERT INTO bot_pr_states(
         repository_id,number,state,draft,base_ref,base_sha,head_sha,mergeable,mergeable_state,title,html_url,updated_at,
         merged,closed_at,branch_delete_due_at,branch_cleanup_status,branch_cleanup_reason,branch_cleanup_at,branch_cleanup_attempts
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repository_id,number) DO UPDATE SET
         state=excluded.state,
         draft=excluded.draft,
         base_ref=coalesce(excluded.base_ref,bot_pr_states.base_ref),
         base_sha=coalesce(excluded.base_sha,bot_pr_states.base_sha),
         head_sha=coalesce(excluded.head_sha,bot_pr_states.head_sha),
         mergeable=coalesce(excluded.mergeable,bot_pr_states.mergeable),
         mergeable_state=coalesce(excluded.mergeable_state,bot_pr_states.mergeable_state),
         title=coalesce(excluded.title,bot_pr_states.title),
         html_url=coalesce(excluded.html_url,bot_pr_states.html_url),
         updated_at=excluded.updated_at,
         merged=excluded.merged,
         closed_at=excluded.closed_at,
         branch_delete_due_at=excluded.branch_delete_due_at,
         branch_cleanup_status=excluded.branch_cleanup_status,
         branch_cleanup_reason=excluded.branch_cleanup_reason,
         branch_cleanup_at=excluded.branch_cleanup_at,
         branch_cleanup_attempts=excluded.branch_cleanup_attempts`,
      repositoryId,
      prNumber,
      write.state,
      write.draft ?? 0,
      write.baseRef ?? null,
      write.baseSha ?? null,
      write.headSha ?? null,
      write.mergeable ?? null,
      write.mergeableState ?? null,
      write.title ?? null,
      write.htmlUrl ?? null,
      nowIso,
      write.merged,
      write.closedAt,
      write.branchDeleteDueAt,
      write.branchCleanupStatus,
      write.branchCleanupReason ? write.branchCleanupReason.slice(0, 200) : null,
      write.branchCleanupAt,
      write.branchCleanupAttempts,
    );
    updated = true;

    if (write.auditAction) {
      store.audit(
        'system',
        write.auditAction,
        auditResource(prNumber, branch, write.auditReason ?? write.branchCleanupReason ?? undefined),
        repositoryId,
      );
    }
  });
  return updated;
}

/**
 * Bounded legacy backfill pass for pre-existing Bot PRs whose `bot_pr_states` row is either missing (`s.number IS NULL`)
 * or closed with `branch_cleanup_status IS NULL`.
 *
 * Caps work at `legacyBatchLimit` PRs per pass (default 10), skips disabled / sub-`develop` / revoked-installation repos
 * with zero GitHub calls, live-verifies each candidate via `GET /pulls/{n}` behind the exact same ownership and branch-safety
 * gates, schedules merged -> due now and unmerged -> `closed_at + 48h`, and emits `store.audit` entries.
 * Once all legacy rows are drained, steady-state ticks hit the partial index `bot_pr_states_branch_cleanup_legacy_closed`
 * and make zero GitHub connections or API requests.
 */
export async function backfillLegacyBotPrBranchCleanup(
  store: Store,
  apiUrl?: string,
  options?: {
    now?: () => number;
    isClosing?: () => boolean;
    limit?: number;
    skipMissingStateRepos?: ReadonlySet<string>;
  },
): Promise<LegacyBackfillSummary> {
  const summary: LegacyBackfillSummary = {
    inspected: 0,
    scheduled: 0,
    skipped: 0,
    opened: 0,
    rateLimitedRepos: new Set(),
  };
  if (options?.isClosing?.() || !store.db.isOpen || !store.hasTable('bot_pull_requests') || !store.hasTable('bot_pr_states')) {
    return summary;
  }
  ensureBotPrBranchCleanupColumns(store);

  const cfg = resolveBotPrBranchCleanupConfig({
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.limit !== undefined ? { legacyBatchLimit: options.limit } : {}),
  });
  if (cfg.legacyBatchLimit <= 0) return summary;

  const nowMs = cfg.now();
  const nowIso = new Date(nowMs).toISOString();

  const repoFlags = new Map<string, { hasClosedNull: boolean; hasMissingState: boolean }>();
  const closedNullRepos = store.all(
    `SELECT DISTINCT s.repository_id
     FROM bot_pr_states s
     CROSS JOIN bot_pull_requests b ON b.repository_id=s.repository_id AND b.number=s.number
     JOIN policies p ON p.repository_id=s.repository_id
     WHERE p.enabled=1
       AND lower(s.state)='closed'
       AND s.branch_cleanup_status IS NULL
     ORDER BY s.repository_id ASC`,
  );
  for (const row of closedNullRepos) {
    repoFlags.set(String(row.repository_id), { hasClosedNull: true, hasMissingState: false });
  }
  const missingStateRepos = store.all(
    `SELECT DISTINCT b.repository_id
     FROM bot_pull_requests b
     JOIN policies p ON p.repository_id=b.repository_id
     LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
     WHERE p.enabled=1
       AND s.number IS NULL
     ORDER BY b.repository_id ASC`,
  );
  for (const row of missingStateRepos) {
    const repoId = String(row.repository_id);
    const existing = repoFlags.get(repoId);
    if (existing) existing.hasMissingState = true;
    else repoFlags.set(repoId, { hasClosedNull: false, hasMissingState: true });
  }
  if (!repoFlags.size) return summary;

  const inflight = getStoreInflight(store);
  let remaining = cfg.legacyBatchLimit;

  for (const [repositoryId, flags] of repoFlags) {
    if (remaining <= 0 || options?.isClosing?.() || !store.db.isOpen) break;
    const allowMissingState = flags.hasMissingState && !options?.skipMissingStateRepos?.has(repositoryId);
    if (!flags.hasClosedNull && !allowMissingState) continue;

    const repo = store.get('SELECT * FROM repositories WHERE id=?', repositoryId);
    const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
    if (
      !repo
      || !policy?.enabled
      || !covers(projectCeiling(store, repositoryId, policy), 'develop')
      || installationExecutionDenied(store, String(repo.account_id), repositoryId)
    ) {
      continue;
    }

    const candidates: Array<{ owned: Row; hasStateRow: boolean; savedBase: string }> = [];
    const seenPrs = new Set<number>();
    if (flags.hasClosedNull && remaining > 0) {
      const closedRows = store.all(
        `SELECT b.*, s.base_ref AS saved_base_ref
         FROM bot_pr_states s
         CROSS JOIN bot_pull_requests b ON b.repository_id=s.repository_id AND b.number=s.number
         WHERE s.repository_id=?
           AND lower(s.state)='closed'
           AND s.branch_cleanup_status IS NULL
         ORDER BY s.number ASC
         LIMIT ?`,
        repositoryId,
        remaining,
      );
      for (const row of closedRows) {
        const prNumber = Number(row.number);
        if (!Number.isSafeInteger(prNumber) || prNumber < 1 || seenPrs.has(prNumber)) continue;
        if (inflight.has(`${repositoryId}:${prNumber}`)) continue;
        seenPrs.add(prNumber);
        candidates.push({ owned: row, hasStateRow: true, savedBase: String(row.saved_base_ref || '').trim() });
      }
    }
    if (allowMissingState && candidates.length < remaining) {
      const missingRows = store.all(
        `SELECT b.*
         FROM bot_pull_requests b
         LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
         WHERE b.repository_id=?
           AND s.number IS NULL
         ORDER BY b.number ASC
         LIMIT ?`,
        repositoryId,
        remaining - candidates.length,
      );
      for (const row of missingRows) {
        const prNumber = Number(row.number);
        if (!Number.isSafeInteger(prNumber) || prNumber < 1 || seenPrs.has(prNumber)) continue;
        if (inflight.has(`${repositoryId}:${prNumber}`)) continue;
        seenPrs.add(prNumber);
        candidates.push({ owned: row, hasStateRow: false, savedBase: '' });
      }
    }
    if (!candidates.length) continue;

    const policyBase = String(policy.base_branch || '').trim();
    const needLive: Array<{ owned: Row; hasStateRow: boolean; savedBase: string; branch: string | null }> = [];
    for (const cand of candidates) {
      if (remaining <= 0) break;
      const prNumber = Number(cand.owned.number);
      const rawBranch = typeof cand.owned.branch === 'string' ? cand.owned.branch.trim() : '';
      const branch = rawBranch || null;

      // Already-known-closed rows that violate local ownership or branch-name boundaries can be resolved without GitHub calls.
      if (cand.hasStateRow) {
        if (String(cand.owned.head_repository_id) !== repositoryId) {
          remaining--;
          summary.inspected++;
          if (writeLegacyBackfillOutcome(store, repositoryId, prNumber, branch, true, nowIso, {
            state: 'closed',
            merged: 0,
            closedAt: null,
            branchDeleteDueAt: null,
            branchCleanupStatus: 'skipped',
            branchCleanupReason: 'cross_repository_head',
            branchCleanupAt: nowIso,
            branchCleanupAttempts: 0,
            auditAction: 'bot_pr.branch_cleanup_skipped',
          })) {
            summary.skipped++;
          }
          continue;
        }
        const branchErr = !branch ? 'Missing branch name.' : validateBotBranchName(branch, policyBase || 'main', cand.savedBase || null);
        if (!branch || branchErr || branch === 'main' || branch === 'master' || (policyBase && branch === policyBase) || (cand.savedBase && branch === cand.savedBase)) {
          remaining--;
          summary.inspected++;
          if (writeLegacyBackfillOutcome(store, repositoryId, prNumber, branch, true, nowIso, {
            state: 'closed',
            merged: 0,
            closedAt: null,
            branchDeleteDueAt: null,
            branchCleanupStatus: 'skipped',
            branchCleanupReason: 'invalid_or_protected_branch',
            branchCleanupAt: nowIso,
            branchCleanupAttempts: 0,
            auditAction: 'bot_pr.branch_cleanup_skipped',
          })) {
            summary.skipped++;
          }
          continue;
        }
      }

      remaining--;
      needLive.push({ ...cand, branch });
    }
    if (!needLive.length || options?.isClosing?.() || !store.db.isOpen) continue;

    const redactor = registeredRedactor(store);
    const github = new GitHub(store, repo, redactor, async () => {}, apiUrl);
    github.purpose = 'bot_pr_branch_cleanup';
    try {
      await github.connect(false, { contents: 'read', pull_requests: 'read' }, undefined, false);
      const liveDefaultBranch = String(github.defaultBranch || '').trim();
      for (const cand of needLive) {
        if (options?.isClosing?.() || !store.db.isOpen) break;
        const prNumber = Number(cand.owned.number);
        const branch = cand.branch;
        if (inflight.has(`${repositoryId}:${prNumber}`)) continue;

        summary.inspected++;
        let livePr: any;
        try {
          livePr = await github.request('GET', github.path(`/pulls/${prNumber}`), undefined, true);
        } catch (error) {
          if (error instanceof TaskError && error.code === 'github_rate_limited') {
            summary.rateLimitedRepos.add(repositoryId);
          }
          break;
        }
        if (options?.isClosing?.() || !store.db.isOpen) break;

        if (!livePr || typeof livePr !== 'object') {
          if (writeLegacyBackfillOutcome(store, repositoryId, prNumber, branch, cand.hasStateRow, nowIso, {
            state: 'closed',
            merged: 0,
            closedAt: null,
            branchDeleteDueAt: null,
            branchCleanupStatus: 'skipped',
            branchCleanupReason: 'pr_not_found',
            branchCleanupAt: nowIso,
            branchCleanupAttempts: 0,
            auditAction: 'bot_pr.branch_cleanup_skipped',
          })) {
            summary.skipped++;
          }
          continue;
        }

        const liveState = String(livePr.state || '').toLowerCase();
        const liveBaseRef = typeof livePr.base?.ref === 'string' && livePr.base.ref.trim() ? livePr.base.ref.trim() : null;
        const liveBaseSha = normSha(livePr.base?.sha);
        const liveHeadSha = normSha(livePr.head?.sha);
        const liveTitle = typeof livePr.title === 'string' && livePr.title ? livePr.title.slice(0, 400) : null;
        const liveHtmlUrl = safeHttpUrl(livePr.html_url);
        const liveMergeable = livePr.mergeable === true ? 1 : livePr.mergeable === false ? 0 : null;
        const liveMergeableState = typeof livePr.mergeable_state === 'string' && livePr.mergeable_state ? livePr.mergeable_state : null;

        if (liveState === 'open') {
          if (writeLegacyBackfillOutcome(store, repositoryId, prNumber, branch, cand.hasStateRow, nowIso, {
            state: 'open',
            draft: livePr.draft === true ? 1 : 0,
            baseRef: liveBaseRef,
            baseSha: liveBaseSha,
            headSha: liveHeadSha ?? normSha(cand.owned.sha),
            mergeable: liveMergeable,
            mergeableState: liveMergeableState,
            title: liveTitle,
            htmlUrl: liveHtmlUrl,
            merged: 0,
            closedAt: null,
            branchDeleteDueAt: null,
            branchCleanupStatus: null,
            branchCleanupReason: null,
            branchCleanupAt: null,
            branchCleanupAttempts: 0,
          })) {
            summary.opened++;
          }
          continue;
        }

        if (liveState !== 'closed') {
          if (writeLegacyBackfillOutcome(store, repositoryId, prNumber, branch, cand.hasStateRow, nowIso, {
            state: 'closed',
            baseRef: liveBaseRef,
            baseSha: liveBaseSha,
            headSha: liveHeadSha,
            title: liveTitle,
            htmlUrl: liveHtmlUrl,
            merged: 0,
            closedAt: null,
            branchDeleteDueAt: null,
            branchCleanupStatus: 'skipped',
            branchCleanupReason: 'pr_not_closed',
            branchCleanupAt: nowIso,
            branchCleanupAttempts: 0,
            auditAction: 'bot_pr.branch_cleanup_skipped',
          })) {
            summary.skipped++;
          }
          continue;
        }

        const verified = verifyLiveBotPrOwnershipAndBranch(cand.owned, livePr, repositoryId, policyBase, cand.savedBase, liveDefaultBranch);
        if (!verified.ok) {
          if (writeLegacyBackfillOutcome(store, repositoryId, prNumber, branch, cand.hasStateRow, nowIso, {
            state: 'closed',
            baseRef: liveBaseRef,
            baseSha: liveBaseSha,
            headSha: liveHeadSha,
            title: liveTitle,
            htmlUrl: liveHtmlUrl,
            merged: livePr.merged === true || parseIsoMs(livePr.merged_at) !== null ? 1 : 0,
            closedAt: parseIsoMs(livePr.closed_at) != null ? new Date(parseIsoMs(livePr.closed_at)!).toISOString() : null,
            branchDeleteDueAt: null,
            branchCleanupStatus: 'skipped',
            branchCleanupReason: verified.reason,
            branchCleanupAt: nowIso,
            branchCleanupAttempts: 0,
            auditAction: 'bot_pr.branch_cleanup_skipped',
          })) {
            summary.skipped++;
          }
          continue;
        }

        const liveMerged = livePr.merged === true || parseIsoMs(livePr.merged_at) !== null;
        let closedMs: number;
        let dueAt: number;
        let reason: string;
        if (liveMerged) {
          closedMs = parseIsoMs(livePr.merged_at) ?? parseIsoMs(livePr.closed_at) ?? nowMs;
          dueAt = nowMs;
          reason = 'merged';
        } else {
          const liveClosedMs = parseIsoMs(livePr.closed_at);
          if (liveClosedMs === null) {
            closedMs = nowMs;
            dueAt = nowMs + backoffDelayMs(1, cfg.backoffMs);
            reason = 'live_closed_at_missing';
          } else {
            closedMs = liveClosedMs;
            dueAt = liveClosedMs + cfg.retentionMs;
            reason = 'closed_retention_wait';
          }
        }

        if (writeLegacyBackfillOutcome(store, repositoryId, prNumber, verified.branch, cand.hasStateRow, nowIso, {
          state: 'closed',
          draft: livePr.draft === true ? 1 : 0,
          baseRef: verified.liveBaseRef,
          baseSha: liveBaseSha,
          headSha: verified.prHeadSha,
          mergeable: liveMergeable,
          mergeableState: liveMergeableState,
          title: liveTitle,
          htmlUrl: liveHtmlUrl,
          merged: liveMerged ? 1 : 0,
          closedAt: new Date(closedMs).toISOString(),
          branchDeleteDueAt: dueAt,
          branchCleanupStatus: 'pending',
          branchCleanupReason: reason,
          branchCleanupAt: null,
          branchCleanupAttempts: 0,
          auditAction: 'bot_pr.branch_cleanup_backfilled',
          auditReason: reason,
        })) {
          summary.scheduled++;
        }
      }
    } catch (error) {
      if (error instanceof TaskError && error.code === 'github_rate_limited') {
        summary.rateLimitedRepos.add(repositoryId);
      }
    } finally {
      await github.revokeTokens('bot_pr_branch_cleanup').catch(() => {});
    }
  }

  return summary;
}

/**
 * Sweeps bounded legacy closed/state-missing Bot PRs (via `backfillLegacyBotPrBranchCleanup`) and all due pending
 * closed/merged Bot PR remote branch cleanups across repositories.
 * Uses the partial indexes `bot_pr_states_branch_cleanup_legacy_closed` and `bot_pr_states_branch_cleanup_due` so
 * steady-state ticks with zero legacy and zero due rows make zero GitHub connections and zero API requests.
 */
export async function cleanupDueBotPrBranches(
  store: Store,
  apiUrl?: string,
  options?: {
    now?: () => number;
    isClosing?: () => boolean;
    legacyBatchLimit?: number;
    skipMissingStateRepos?: ReadonlySet<string>;
  },
): Promise<BotPrBranchCleanupResult[]> {
  if (options?.isClosing?.() || !store.db.isOpen || !store.hasTable('bot_pull_requests') || !store.hasTable('bot_pr_states')) {
    return [];
  }
  ensureBotPrBranchCleanupColumns(store);

  const backfill = await backfillLegacyBotPrBranchCleanup(store, apiUrl, {
    now: options?.now,
    isClosing: options?.isClosing,
    limit: options?.legacyBatchLimit,
    skipMissingStateRepos: options?.skipMissingStateRepos,
  });
  if (options?.isClosing?.() || !store.db.isOpen) return [];

  const cfg = resolveBotPrBranchCleanupConfig(options?.now ? { now: options.now } : undefined);
  const nowMs = cfg.now();
  const nowIso = new Date(nowMs).toISOString();

  const dueRows = store.all(
    `SELECT s.repository_id, s.number
     FROM bot_pr_states s
     JOIN bot_pull_requests b ON b.repository_id=s.repository_id AND b.number=s.number
     JOIN repositories r ON r.id=s.repository_id
     WHERE s.branch_cleanup_status='pending'
       AND s.branch_delete_due_at IS NOT NULL
       AND s.branch_delete_due_at <= ?
     ORDER BY s.branch_delete_due_at ASC, s.number ASC`,
    nowMs,
  );
  if (!dueRows.length) return [];

  // Group due PRs by repository so we connect at most once per repository that actually passes local preflight.
  const byRepo = new Map<string, number[]>();
  for (const row of dueRows) {
    const repoId = String(row.repository_id);
    if (backfill.rateLimitedRepos.has(repoId)) continue;
    const prNum = Number(row.number);
    if (!Number.isSafeInteger(prNum) || prNum < 1) continue;
    let list = byRepo.get(repoId);
    if (!list) byRepo.set(repoId, list = []);
    list.push(prNum);
  }

  const results: BotPrBranchCleanupResult[] = [];
  const inflight = getStoreInflight(store);

  for (const [repositoryId, prNumbers] of byRepo) {
    if (options?.isClosing?.() || !store.db.isOpen) break;

    const ready: LocalPreflightOk[] = [];
    for (const prNumber of prNumbers) {
      if (options?.isClosing?.() || !store.db.isOpen) break;
      if (inflight.has(`${repositoryId}:${prNumber}`)) continue;
      try {
        const pre = runLocalPreflight(store, repositoryId, prNumber, nowMs, nowIso, cfg);
        if (pre.ok) ready.push(pre);
        else results.push(pre.result);
      } catch {
        // Isolate malformed/failing rows so one PR never stalls cleanup of others.
      }
    }
    if (!ready.length || options?.isClosing?.() || !store.db.isOpen) continue;

    const repo = ready[0]!.repo;
    const redactor = registeredRedactor(store);
    const github = new GitHub(store, repo, redactor, async () => {}, apiUrl);
    github.purpose = 'bot_pr_branch_cleanup';
    try {
      await github.connect(false, { contents: 'read', pull_requests: 'read' }, undefined, false);
      for (const pre of ready) {
        if (options?.isClosing?.() || !store.db.isOpen) break;
        const prNumber = Number(pre.owned.number);
        const key = `${repositoryId}:${prNumber}`;
        if (inflight.has(key)) continue;

        let rateLimited = false;
        const work = runLiveVerifiedCleanup(store, github, pre, cfg, options?.isClosing)
          .then(outcome => {
            rateLimited = outcome.rateLimited;
            return outcome.result;
          })
          .catch(() => ({
            repositoryId,
            prNumber,
            branch: pre.branch,
            status: 'noop' as const,
            reason: 'cleanup_error',
          }))
          .finally(() => {
            if (inflight.get(key) === work) inflight.delete(key);
          });
        inflight.set(key, work);
        const res = await work;
        results.push(res);
        if (rateLimited) break;
      }
    } catch (error) {
      if (!store.db.isOpen || options?.isClosing?.()) break;
      for (const pre of ready) {
        if (!store.db.isOpen) break;
        const prNumber = Number(pre.owned.number);
        results.push(applyCleanupError(store, repositoryId, prNumber, pre.branch, pre.attempts, nowMs, nowIso, cfg, error, false));
      }
    } finally {
      await github.revokeTokens('bot_pr_branch_cleanup').catch(() => {});
    }
  }

  return results;
}
