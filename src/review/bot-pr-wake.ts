import type { Store, Row } from '../storage/database.js';
import { type Json, randomId } from '../core/security.js';
import { GitHub, revokeInstallationToken } from '../github/client.js';
import { sha as digest } from '../agent/common.js';
import { publicContent, registeredRedactor } from '../core/redaction.js';
import { covers, projectCeiling } from '../projects/ceiling.js';
import { botPullRequestsOfIssue, recordEvent, rootIssueOfBotPr, threadKey, type CreateOption, type Decision, type EventInput } from '../dispatch/store.js';
import { roleConfiguration } from '../roles/definition.js';
import { taskPermissions } from '../tasks/configuration.js';

const HEX_SHA = /^[a-f0-9]{40}$/i;
const ZERO_SHA = /^0{40}$/;
const BOT_MARKER = /<!-- dept-bot[:-]/;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const ACTIONS_RUN_URL = /\/actions\/runs\/(\d+)(?:\/|$|\?)/;

export const DEFAULT_BOT_PR_PATROL_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_BOT_PR_PATROL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BOT_PR_SUPPRESSED_DIRTY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_BOT_PR_STALLED_TASK_AGE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_BOT_CAPABILITY_VERSION = '2026-11-24.v1';
// The fallback reconcile reads each open bot PR on its own schedule (#1396): first after 5 minutes, then twice as long each
// time nothing changed, up to 4 hours. A change it finds, or a webhook about the PR, its head commit or its base branch,
// starts the interval over. It never reads one PR more often than every 5 minutes.
export const BOT_PR_RECONCILE_MIN_MS = 5 * 60_000;
export const BOT_PR_RECONCILE_MAX_MS = 4 * 60 * 60_000;
// Pull requests per GraphQL query; 50 of them with their check suites cost one point.
const RECONCILE_BATCH = 50;

const ACTIVE_EXECUTING_TASK_STATUSES = [
  'queued',
  'running',
  'preparing',
  'implementing',
  'validating',
  'publishing',
  'result_ready',
  'waiting_coordination',
  'waiting_event',
  'waiting_pr_head',
  'waiting_publication',
];
const STALLABLE_WAITING_TASK_STATUSES = [
  'retry_wait',
  'waiting_environment',
  'waiting_configuration',
  'waiting_permission',
];
const LEGACY_RETIRED_BLOCKER_CODES = new Set(['workflow_changes_not_confirmed']);

export interface BotPatrolConfig {
  intervalMs: number;
  cooldownMs: number;
  suppressedDirtyCooldownMs: number;
  stalledTaskAgeMs: number;
  capabilityVersion: string;
  now: () => number;
}

let recheckDelaysMs = [1500, 4000];
let patrolTestOverrides: Partial<BotPatrolConfig> | null = null;
const pendingRechecks = new Set<string>();
const pendingSuiteFlushes = new Map<string, { repositoryId: string; headSha: string; checkSuiteId: number | null; workflowRunId: number | null; attempt: number }>();

/** Allows integration tests to shorten background `mergeable === null` and suite-completion poll delays deterministically. */
export function setBotWakeRecheckDelaysForTest(delays: number[] | null) {
  recheckDelaysMs = delays ? [...delays] : [1500, 4000];
}

/** Allows unit/integration tests to configure patrol intervals, cooldowns, capability version, and clock deterministically. */
export function setBotPatrolConfigForTest(overrides: Partial<BotPatrolConfig> | null) {
  patrolTestOverrides = overrides ? { ...overrides } : null;
}

function resolvePatrolConfig(overrides?: Partial<BotPatrolConfig>): BotPatrolConfig {
  const baseInterval = overrides?.intervalMs ?? DEFAULT_BOT_PR_PATROL_INTERVAL_MS;
  const baseCooldown = overrides?.cooldownMs ?? DEFAULT_BOT_PR_PATROL_COOLDOWN_MS;
  const intervalMs = patrolTestOverrides?.intervalMs ?? baseInterval;
  const cooldownMs = patrolTestOverrides?.cooldownMs ?? baseCooldown;
  const suppressedDirtyCooldownMs =
    patrolTestOverrides?.suppressedDirtyCooldownMs
    ?? overrides?.suppressedDirtyCooldownMs
    ?? Math.max(cooldownMs, DEFAULT_BOT_PR_SUPPRESSED_DIRTY_COOLDOWN_MS);
  const stalledTaskAgeMs =
    patrolTestOverrides?.stalledTaskAgeMs
    ?? overrides?.stalledTaskAgeMs
    ?? DEFAULT_BOT_PR_STALLED_TASK_AGE_MS;
  const capabilityVersion =
    patrolTestOverrides?.capabilityVersion
    ?? overrides?.capabilityVersion
    ?? DEFAULT_BOT_CAPABILITY_VERSION;
  const now = patrolTestOverrides?.now ?? overrides?.now ?? (() => Date.now());
  return { intervalMs, cooldownMs, suppressedDirtyCooldownMs, stalledTaskAgeMs, capabilityVersion, now };
}

const normSha = (value: unknown): string | null => {
  const s = String(value ?? '').trim().toLowerCase();
  return HEX_SHA.test(s) && !ZERO_SHA.test(s) ? s : null;
};

const clip = (value: unknown, limit = 1500): string => {
  const text = String(value ?? '').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
};

const safeHttpUrl = (value: unknown): string | null => {
  const s = String(value ?? '').trim();
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 500) : null;
};

const extractWorkflowRunIdFromUrl = (...urls: unknown[]): number | null => {
  for (const raw of urls) {
    const m = ACTIONS_RUN_URL.exec(String(raw ?? ''));
    if (m) {
      const id = Number(m[1]);
      if (Number.isSafeInteger(id) && id >= 1) return id;
    }
  }
  return null;
};

export function botPrWakeStorage(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS bot_pr_states(
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      draft INTEGER NOT NULL DEFAULT 0,
      base_ref TEXT,
      base_sha TEXT,
      head_sha TEXT,
      mergeable INTEGER,
      mergeable_state TEXT,
      title TEXT,
      html_url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, number)
    );
    CREATE INDEX IF NOT EXISTS bot_pr_states_open ON bot_pr_states(repository_id, state, draft);
  `);
  const cols = new Set(store.all('PRAGMA table_info(bot_pr_states)').map(c => String(c.name)));
  for (const [name, type] of [
    ['last_patrol_at', 'TEXT'],
    ['last_patrol_event_at', 'TEXT'],
    ['patrol_env_fingerprint', 'TEXT'],
    ['patrol_env_summary', 'TEXT'],
    ['patrol_head_sha', 'TEXT'],
    ['patrol_base_sha', 'TEXT'],
    ['patrol_status', 'TEXT'],
    ['conflict_suppressed_head_sha', 'TEXT'],
    ['conflict_suppressed_env', 'TEXT'],
    ['conflict_suppressed_at', 'TEXT'],
    ['conflict_suppressed_reason', 'TEXT'],
    // The fallback reconcile's schedule (#1396), in epoch milliseconds: when it last read the PR, when it reads it next
    // and the interval in between; what it saw (a digest of state, head, base, mergeability, updated_at and check suites);
    // and the digest of the project's local settings then, so a change to them makes the PR due again.
    ['reconcile_at', 'INTEGER'],
    ['reconcile_due_at', 'INTEGER'],
    ['reconcile_interval_ms', 'INTEGER'],
    ['reconcile_fingerprint', 'TEXT'],
    ['reconcile_env', 'TEXT'],
  ] as const) {
    if (!cols.has(name)) store.db.exec(`ALTER TABLE bot_pr_states ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Makes the open bot PRs a webhook is about due for the fallback reconcile as soon as their 5-minute minimum allows, with
 * the interval back at its minimum: the PR itself (its events, reviews and comments), the PRs whose head is the commit a
 * check or status reports on, and the PRs whose head or base is a pushed branch or the base a merged PR advanced.
 */
export function markBotPrsForReconcile(store: Store, repositoryId: string, event: string, payload: any, nowMs = resolvePatrolConfig().now()): number {
  if (!repositoryId || !payload || typeof payload !== 'object' || !store.hasTable('bot_pull_requests')) return 0;
  const numbers = new Set<number>(), shas = new Set<string>(), heads = new Set<string>(), bases = new Set<string>();
  const addNumber = (value: unknown) => { const n = Number(value); if (Number.isSafeInteger(n) && n > 0) numbers.add(n); };
  const addLinked = (prs: unknown) => {
    if (Array.isArray(prs)) for (const pr of prs) if (pr?.base?.repo?.id == null || String(pr.base.repo.id) === repositoryId) addNumber(pr?.number);
  };
  const branch = (value: unknown) => typeof value === 'string' && value && value.length <= 255 ? value : null;
  if (['pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread'].includes(event)) {
    addNumber(payload.pull_request?.number);
    if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged === true) {
      const base = branch(payload.pull_request?.base?.ref);
      if (base) bases.add(base);
    }
  } else if (event === 'issue_comment') {
    if (payload.issue?.pull_request) addNumber(payload.issue.number);
  } else if (event === 'check_run' || event === 'check_suite' || event === 'workflow_run') {
    const check = payload[event];
    const sha = normSha(check?.head_sha ?? check?.check_suite?.head_sha);
    if (sha) shas.add(sha);
    addLinked(check?.pull_requests);
    const head = branch(check?.head_branch ?? check?.check_suite?.head_branch);
    if (head) heads.add(head);
  } else if (event === 'status') {
    const sha = normSha(payload.sha);
    if (sha) shas.add(sha);
  } else if (event === 'push') {
    const ref = typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/') ? branch(payload.ref.slice('refs/heads/'.length)) : null;
    if (ref) { heads.add(ref); bases.add(ref); }
  }
  if (!numbers.size && !shas.size && !heads.size && !bases.size) return 0;
  if (!store.hasTable('bot_pr_states')) botPrWakeStorage(store);
  const list = (values: Set<number> | Set<string>): Array<number | string | null> => values.size ? [...values] : [null];
  const marks = (values: Set<number> | Set<string>) => list(values).map(() => '?').join(',');
  // A PR without a state row has never been reconciled and is due already.
  const rows = store.all(
    `SELECT b.number FROM bot_pull_requests b JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
     WHERE b.repository_id=? AND s.state<>'closed'
       AND (b.number IN (${marks(numbers)}) OR lower(b.sha) IN (${marks(shas)}) OR lower(s.head_sha) IN (${marks(shas)})
         OR b.branch IN (${marks(heads)}) OR s.base_ref IN (${marks(bases)}))`,
    repositoryId,
    ...list(numbers),
    ...list(shas),
    ...list(shas),
    ...list(heads),
    ...list(bases),
  );
  for (const row of rows) {
    store.run(
      `UPDATE bot_pr_states SET reconcile_interval_ms=?, reconcile_due_at=max(?, coalesce(reconcile_at,0)+?)
       WHERE repository_id=? AND number=?`,
      BOT_PR_RECONCILE_MIN_MS,
      nowMs,
      BOT_PR_RECONCILE_MIN_MS,
      repositoryId,
      Number(row.number),
    );
  }
  return rows.length;
}

export interface PatrolEnvironmentSummary {
  control_plane: {
    capability_version: string;
    capabilities: string[];
  };
  installation: {
    account_type: string;
    status: string;
    scope_pending: boolean;
    permissions: Record<string, string | boolean>;
  };
  policy: {
    capability_ceiling: string;
    auto_merge_policy: string;
    base_branch: string;
    test_command_sha: string;
    enabled_roles: string[];
    dev_harness: string | null;
  };
  environment: {
    generation: number;
    availability: string;
    toolchain_pending: boolean;
  };
}

export interface PatrolEnvironmentSnapshot {
  fingerprint: string;
  summary: PatrolEnvironmentSummary;
}

function normalizePermissionsMap(raw: unknown): Record<string, string | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | boolean> = {};
  for (const key of Object.keys(raw as Record<string, unknown>).sort()) {
    const val = (raw as Record<string, unknown>)[key];
    if (typeof val === 'string' && val.trim()) out[key] = val.trim();
    else if (typeof val === 'boolean') out[key] = val;
  }
  return out;
}

function parseJsonObject(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Computes a deterministic, low-churn fingerprint of control-plane capabilities, GitHub installation permissions,
 * project policy, and project-computer availability so internal bot PR patrol detects real unblocking changes
 * without flipping on volatile timestamps or transient `ready`/`busy` transitions.
 */
export function computePatrolEnvironmentSnapshot(
  store: Store,
  repositoryId: string,
  liveInstallationPermissions?: Record<string, string> | null,
  capabilityVersion?: string,
): PatrolEnvironmentSnapshot {
  const cfg = resolvePatrolConfig(capabilityVersion ? { capabilityVersion } : undefined);
  const repo = store.get('SELECT account_id,owner_id FROM repositories WHERE id=?', repositoryId);
  const account = repo?.account_id ? store.get('SELECT id,type,app_id FROM accounts WHERE id=?', repo.account_id) : undefined;
  const accountType = String(account?.type || 'unknown');
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);

  let installStatus = accountType === 'bot_account' ? 'bot_account' : 'unknown';
  let scopePending = false;
  let storedPerms: Record<string, unknown> = {};

  if (accountType === 'github_app' && account?.app_id && store.hasTable('github_installations')) {
    const instRow = store.get(
      `SELECT g.status,g.scope_pending,g.permissions
       FROM installation_repositories r
       JOIN github_installations g ON g.ref=r.installation_ref
       LEFT JOIN installed_repositories i ON i.account_id=? AND i.installation_id=g.installation_id AND i.repository_id=r.repository_id
       WHERE g.github_host='github.com' AND g.app_id=? AND r.repository_id=?
       ORDER BY CASE WHEN i.repository_id IS NOT NULL THEN 0 ELSE 1 END,r.present DESC,g.updated_at DESC LIMIT 1`,
      account.id,
      String(account.app_id),
      repositoryId,
    ) ?? (repo?.owner_id
      ? store.get(
          `SELECT status,scope_pending,permissions FROM github_installations
           WHERE github_host='github.com' AND app_id=? AND target_id=?
           ORDER BY updated_at DESC LIMIT 1`,
          String(account.app_id),
          String(repo.owner_id),
        )
      : undefined);
    if (instRow) {
      installStatus = String(instRow.status || 'active');
      scopePending = Boolean(instRow.scope_pending);
      storedPerms = parseJsonObject(instRow.permissions) ?? {};
    }
  }

  if (repo?.account_id && store.hasTable('installed_repositories')) {
    const repoInst = store.get(
      'SELECT permissions,installed FROM installed_repositories WHERE account_id=? AND repository_id=?',
      repo.account_id,
      repositoryId,
    );
    if (repoInst) {
      const repoPerms = parseJsonObject(repoInst.permissions) ?? {};
      if (!Object.keys(storedPerms).length && Object.keys(repoPerms).length) storedPerms = repoPerms;
      if (installStatus === 'unknown') installStatus = Number(repoInst.installed) === 1 ? 'active' : 'uninstalled';
    }
  }

  const mergedPerms = normalizePermissionsMap({
    ...storedPerms,
    ...(liveInstallationPermissions && typeof liveInstallationPermissions === 'object' ? liveInstallationPermissions : {}),
  });

  let enabledRoles: string[] = [];
  let devHarness: string | null = null;
  try {
    const roles = roleConfiguration(store, repositoryId).roles;
    enabledRoles = roles.filter(r => r.enabled).map(r => r.role_id).sort();
    devHarness = roles.find(r => r.role_id === 'dev')?.harness_ref?.id ?? null;
  } catch {
    enabledRoles = [];
    devHarness = null;
  }

  const envRow = store.hasTable('project_environments')
    ? store.get('SELECT generation,state,toolchain_pending FROM project_environments WHERE repository_id=?', repositoryId)
    : undefined;
  const rawState = envRow?.state ? String(envRow.state) : '';
  const availability = !rawState
    ? 'unknown'
    : ['ready', 'busy'].includes(rawState)
      ? 'available'
      : rawState;

  const summary: PatrolEnvironmentSummary = {
    control_plane: {
      capability_version: cfg.capabilityVersion,
      capabilities: ['bot_pr_patrol_v1', 'conflict_rebase', 'workflow_pr_delivery'],
    },
    installation: {
      account_type: accountType,
      status: installStatus,
      scope_pending: scopePending,
      permissions: mergedPerms,
    },
    policy: {
      capability_ceiling: projectCeiling(store, repositoryId, policy),
      auto_merge_policy: String(policy?.auto_merge_policy || 'disallow'),
      base_branch: String(policy?.base_branch || '').trim(),
      test_command_sha: policy?.test_command ? digest(String(policy.test_command)).slice(0, 12) : '',
      enabled_roles: enabledRoles,
      dev_harness: devHarness,
    },
    environment: {
      generation: Number(envRow?.generation || 0),
      availability,
      toolchain_pending: Boolean(envRow?.toolchain_pending),
    },
  };

  return {
    fingerprint: digest(JSON.stringify(summary)),
    summary,
  };
}

/** Computes concise, secret-free change notes between two patrol environment snapshots. */
export function diffPatrolEnvironments(
  prev: PatrolEnvironmentSummary | null | undefined,
  curr: PatrolEnvironmentSummary,
): string[] {
  if (!prev || typeof prev !== 'object') return [];
  const changes: string[] = [];
  if (prev.control_plane?.capability_version !== curr.control_plane.capability_version) {
    changes.push(`control_plane.capability_version: ${prev.control_plane?.capability_version ?? 'unknown'} -> ${curr.control_plane.capability_version}`);
  }
  const prevCaps = new Set(prev.control_plane?.capabilities ?? []);
  const currCaps = new Set(curr.control_plane.capabilities);
  for (const c of currCaps) if (!prevCaps.has(c)) changes.push(`control_plane.capability added: ${c}`);
  for (const c of prevCaps) if (!currCaps.has(c)) changes.push(`control_plane.capability removed: ${c}`);

  if (prev.installation?.status !== curr.installation.status) {
    changes.push(`installation.status: ${prev.installation?.status ?? 'unknown'} -> ${curr.installation.status}`);
  }
  if (Boolean(prev.installation?.scope_pending) !== curr.installation.scope_pending) {
    changes.push(`installation.scope_pending: ${Boolean(prev.installation?.scope_pending)} -> ${curr.installation.scope_pending}`);
  }
  const prevPerms = prev.installation?.permissions ?? {};
  const currPerms = curr.installation.permissions;
  const allPermKeys = [...new Set([...Object.keys(prevPerms), ...Object.keys(currPerms)])].sort();
  for (const k of allPermKeys) {
    if (prevPerms[k] !== currPerms[k]) {
      changes.push(`installation.permissions.${k}: ${prevPerms[k] ?? 'none'} -> ${currPerms[k] ?? 'none'}`);
    }
  }

  if (prev.policy?.capability_ceiling !== curr.policy.capability_ceiling) {
    changes.push(`policy.capability_ceiling: ${prev.policy?.capability_ceiling ?? 'unknown'} -> ${curr.policy.capability_ceiling}`);
  }
  if (prev.policy?.auto_merge_policy !== curr.policy.auto_merge_policy) {
    changes.push(`policy.auto_merge_policy: ${prev.policy?.auto_merge_policy ?? 'disallow'} -> ${curr.policy.auto_merge_policy}`);
  }
  if ((prev.policy?.base_branch ?? '') !== curr.policy.base_branch) {
    changes.push(`policy.base_branch: ${prev.policy?.base_branch || '(default)'} -> ${curr.policy.base_branch || '(default)'}`);
  }
  if ((prev.policy?.test_command_sha ?? '') !== curr.policy.test_command_sha) {
    changes.push('policy.test_command: updated');
  }
  if (JSON.stringify(prev.policy?.enabled_roles ?? []) !== JSON.stringify(curr.policy.enabled_roles)) {
    changes.push(`policy.enabled_roles: [${(prev.policy?.enabled_roles ?? []).join(',')}] -> [${curr.policy.enabled_roles.join(',')}]`);
  }
  if ((prev.policy?.dev_harness ?? null) !== curr.policy.dev_harness) {
    changes.push(`policy.dev_harness: ${prev.policy?.dev_harness ?? 'none'} -> ${curr.policy.dev_harness ?? 'none'}`);
  }

  if (prev.environment?.availability !== curr.environment.availability) {
    changes.push(`environment.availability: ${prev.environment?.availability ?? 'unknown'} -> ${curr.environment.availability}`);
  }
  if (Number(prev.environment?.generation || 0) !== curr.environment.generation) {
    changes.push(`environment.generation: ${Number(prev.environment?.generation || 0)} -> ${curr.environment.generation}`);
  }
  if (Boolean(prev.environment?.toolchain_pending) !== curr.environment.toolchain_pending) {
    changes.push(`environment.toolchain_pending: ${Boolean(prev.environment?.toolchain_pending)} -> ${curr.environment.toolchain_pending}`);
  }
  return changes;
}

/** Keeps auxiliary state for PRs recorded in `bot_pull_requests` without altering its 9-column schema. */
export function syncBotPullRequestState(store: Store, repositoryId: string, pr: any, now = new Date().toISOString()): void {
  const number = Number(pr?.number);
  if (!repositoryId || !Number.isSafeInteger(number) || number < 1) return;
  if (!store.hasTable('bot_pull_requests')) return;
  const owned = store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, number);
  if (!owned) return;
  if (pr?.user?.id != null && String(pr.user.id) !== String(owned.author_id)) return;
  if (pr?.head?.repo?.id != null && String(pr.head.repo.id) !== String(owned.head_repository_id)) return;
  if (!store.hasTable('bot_pr_states')) botPrWakeStorage(store);

  const prev = store.get('SELECT * FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, number);
  const state = typeof pr?.state === 'string' && pr.state ? pr.state : String(prev?.state ?? 'open');
  const draft = pr?.draft !== undefined ? (pr.draft === true ? 1 : 0) : Number(prev?.draft ?? 0);
  const baseRef = typeof pr?.base?.ref === 'string' && pr.base.ref ? pr.base.ref : (prev?.base_ref ? String(prev.base_ref) : null);
  const baseSha = normSha(pr?.base?.sha) ?? (prev?.base_sha ? String(prev.base_sha) : null);
  const headSha = normSha(pr?.head?.sha) ?? (prev?.head_sha ? String(prev.head_sha) : normSha(owned.sha));
  const mergeable = pr?.mergeable === true ? 1 : pr?.mergeable === false ? 0 : pr?.mergeable === null ? null : (prev?.mergeable ?? null);
  const mergeableState = typeof pr?.mergeable_state === 'string' && pr.mergeable_state
    ? pr.mergeable_state
    : (prev?.mergeable_state ? String(prev.mergeable_state) : null);
  const title = typeof pr?.title === 'string' && pr.title ? pr.title.slice(0, 400) : (prev?.title ? String(prev.title) : null);
  const htmlUrl = safeHttpUrl(pr?.html_url) ?? (prev?.html_url ? String(prev.html_url) : null);
  const clearSuppression =
    state !== 'open'
    || draft === 1
    || pr?.mergeable === true
    || String(pr?.mergeable_state || '').toLowerCase() === 'clean'
    || Boolean(prev?.conflict_suppressed_head_sha && headSha && String(prev.conflict_suppressed_head_sha).toLowerCase() !== headSha);

  store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,base_sha,head_sha,mergeable,mergeable_state,title,html_url,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repository_id,number) DO UPDATE SET
       state=excluded.state,
       draft=excluded.draft,
       base_ref=coalesce(excluded.base_ref,bot_pr_states.base_ref),
       base_sha=coalesce(excluded.base_sha,bot_pr_states.base_sha),
       head_sha=coalesce(excluded.head_sha,bot_pr_states.head_sha),
       mergeable=excluded.mergeable,
       mergeable_state=excluded.mergeable_state,
       title=coalesce(excluded.title,bot_pr_states.title),
       html_url=coalesce(excluded.html_url,bot_pr_states.html_url),
       updated_at=excluded.updated_at,
       conflict_suppressed_head_sha=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_head_sha END,
       conflict_suppressed_env=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_env END,
       conflict_suppressed_at=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_at END,
       conflict_suppressed_reason=CASE WHEN ? THEN NULL ELSE bot_pr_states.conflict_suppressed_reason END`,
    repositoryId,
    number,
    state,
    draft,
    baseRef,
    baseSha,
    headSha,
    mergeable,
    mergeableState,
    title,
    htmlUrl,
    now,
    clearSuppression ? 1 : 0,
    clearSuppression ? 1 : 0,
    clearSuppression ? 1 : 0,
    clearSuppression ? 1 : 0,
  );
  if (headSha && pr?.state === 'open' && pr?.draft !== true && String(owned.sha).toLowerCase() !== headSha) {
    if (!pr?.head?.ref || pr.head.ref === String(owned.branch)) {
      store.run('UPDATE bot_pull_requests SET sha=? WHERE repository_id=? AND number=?', headSha, repositoryId, number);
    }
  }
}

interface VerifiedBotPr {
  owned: Row;
  savedState: Row | undefined;
  number: number;
  headSha: string;
  headRef: string;
  baseRef: string | null;
  baseSha: string | null;
  title: string;
  htmlUrl: string | null;
  prObject: Record<string, any>;
}

function verifiedOwnedOpenBotPr(store: Store, repositoryId: string, prNumber: number, pr?: any): VerifiedBotPr | null {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !store.hasTable('bot_pull_requests')) return null;
  const owned = store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber);
  if (!owned || String(owned.head_repository_id) !== String(repositoryId)) return null;
  if (pr && typeof pr === 'object') {
    if (pr.user?.id != null && String(pr.user.id) !== String(owned.author_id)) return null;
    if (pr.head?.repo?.id != null && String(pr.head.repo.id) !== String(owned.head_repository_id)) return null;
    if (typeof pr.head?.ref === 'string' && pr.head.ref && pr.head.ref !== String(owned.branch)) return null;
    if (pr.id != null && /^\d+$/.test(String(owned.pr_id)) && String(pr.id) !== String(owned.pr_id)) return null;
  }
  const savedState = store.hasTable('bot_pr_states')
    ? store.get('SELECT * FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber)
    : undefined;
  const closedReview = store.hasTable('review_objects')
    ? store.get("SELECT closed_at FROM review_objects WHERE repository_id=? AND kind='review.pr' AND object_number=?", repositoryId, prNumber)
    : undefined;

  const state = typeof pr?.state === 'string' && pr.state
    ? pr.state
    : savedState?.state
      ? String(savedState.state)
      : closedReview?.closed_at
        ? 'closed'
        : 'open';
  const draft = pr?.draft !== undefined ? pr.draft === true : Boolean(savedState?.draft);
  if (state !== 'open' || draft) return null;

  const headSha = normSha(pr?.head?.sha) ?? normSha(savedState?.head_sha) ?? normSha(owned.sha);
  if (!headSha) return null;

  const boardRow = store.hasTable('board_objects')
    ? store.get("SELECT title FROM board_objects WHERE repository_id=? AND object_type='pr' AND object_number=?", repositoryId, prNumber)
    : undefined;
  const repoFullName = String(store.get('SELECT full_name FROM repositories WHERE id=?', repositoryId)?.full_name || '');
  const defaultBase = String(store.get('SELECT base_branch FROM policies WHERE repository_id=?', repositoryId)?.base_branch || '').trim() || null;
  const baseRef = typeof pr?.base?.ref === 'string' && pr.base.ref
    ? pr.base.ref
    : savedState?.base_ref
      ? String(savedState.base_ref)
      : defaultBase;
  const baseSha = normSha(pr?.base?.sha) ?? normSha(savedState?.base_sha);
  const title = clip(pr?.title ?? savedState?.title ?? boardRow?.title ?? `Bot PR #${prNumber}`, 300);
  const htmlUrl = safeHttpUrl(pr?.html_url ?? savedState?.html_url) ?? (repoFullName ? `https://github.com/${repoFullName}/pull/${prNumber}` : null);
  const actorLogin = store.get('SELECT a.login FROM repositories r JOIN github_actors a ON a.account_id=r.account_id WHERE r.id=?', repositoryId)?.login;

  const prObject: Record<string, any> = {
    ...(pr && typeof pr === 'object' ? pr : {}),
    number: prNumber,
    title,
    state: 'open',
    draft: false,
    user: pr?.user ?? { id: Number(owned.author_id) || owned.author_id, login: actorLogin ?? null },
    head: { ...(pr?.head ?? {}), ref: String(owned.branch), sha: headSha, repo: { id: Number(repositoryId) || repositoryId } },
    base: { ...(pr?.base ?? {}), ...(baseRef ? { ref: baseRef } : {}), ...(baseSha ? { sha: baseSha } : {}) },
    html_url: htmlUrl,
  };

  return {
    owned,
    savedState,
    number: prNumber,
    headSha,
    headRef: String(owned.branch),
    baseRef,
    baseSha,
    title,
    htmlUrl,
    prObject,
  };
}

export interface ParsedFailedCheck {
  source: 'workflow_run' | 'check_suite' | 'check_run';
  headSha: string;
  headBranch: string | null;
  runOrSuiteId: string;
  canonicalGroup: string;
  workflowRunId: number | null;
  checkSuiteId: number | null;
  checkRunId: number | null;
  attempt: number;
  conclusion: string;
  name: string;
  workflowName: string | null;
  url: string | null;
  summary: string;
  pullRequests: any[];
  flushDeferredOnly?: boolean;
}

function canonicalCheckGroup(workflowRunId: number | null, checkSuiteId: number | null, checkRunId: number | null): string {
  if (workflowRunId) return `run:${workflowRunId}`;
  if (checkSuiteId) return `suite:${checkSuiteId}`;
  return `check:${checkRunId ?? 0}`;
}

function canonicalRunOrSuiteId(workflowRunId: number | null, checkSuiteId: number | null, checkRunId: number | null): string {
  return String(workflowRunId ?? checkSuiteId ?? checkRunId ?? '');
}

function parseFailedCheckDelivery(repositoryId: string, repoFullName: string, event: string, payload: any): ParsedFailedCheck | null {
  if (!payload || typeof payload !== 'object' || String(payload.action || '') !== 'completed') return null;

  if (event === 'workflow_run' && payload.workflow_run && typeof payload.workflow_run === 'object') {
    const wf = payload.workflow_run;
    const conclusion = String(wf.conclusion || '').toLowerCase();
    if (!FAILED_CONCLUSIONS.has(conclusion)) return null;
    if (wf.head_repository?.id != null && String(wf.head_repository.id) !== String(repositoryId)) return null;
    const headSha = normSha(wf.head_sha);
    const id = Number(wf.id);
    if (!headSha || !Number.isSafeInteger(id) || id < 1) return null;
    const attempt = Number.isSafeInteger(wf.run_attempt) && wf.run_attempt >= 1 ? Number(wf.run_attempt) : 1;
    const workflowName = String(wf.name || wf.workflow?.name || 'GitHub Actions').trim() || 'GitHub Actions';
    const displayTitle = typeof wf.display_title === 'string' && wf.display_title.trim() ? wf.display_title.trim() : '';
    const checkSuiteId = Number.isSafeInteger(wf.check_suite_id) && wf.check_suite_id >= 1 ? Number(wf.check_suite_id) : null;
    const url = safeHttpUrl(wf.html_url) ?? (repoFullName ? `https://github.com/${repoFullName}/actions/runs/${id}` : null);
    const summaryParts = [
      `Workflow "${workflowName}" completed with ${conclusion} (run #${wf.run_number ?? id}, attempt ${attempt}).`,
      displayTitle && displayTitle !== workflowName ? `Title: ${displayTitle}` : '',
    ].filter(Boolean);
    return {
      source: 'workflow_run',
      headSha,
      headBranch: typeof wf.head_branch === 'string' && wf.head_branch ? wf.head_branch : null,
      runOrSuiteId: canonicalRunOrSuiteId(id, checkSuiteId, null),
      canonicalGroup: canonicalCheckGroup(id, checkSuiteId, null),
      workflowRunId: id,
      checkSuiteId,
      checkRunId: null,
      attempt,
      conclusion,
      name: workflowName,
      workflowName,
      url,
      summary: clip(summaryParts.join(' '), 1500),
      pullRequests: Array.isArray(wf.pull_requests) ? wf.pull_requests : [],
    };
  }

  if (event === 'check_suite' && payload.check_suite && typeof payload.check_suite === 'object') {
    const cs = payload.check_suite;
    const conclusion = String(cs.conclusion || '').toLowerCase();
    if (!FAILED_CONCLUSIONS.has(conclusion)) return null;
    const headSha = normSha(cs.head_sha);
    const id = Number(cs.id);
    if (!headSha || !Number.isSafeInteger(id) || id < 1) return null;
    const attempt = Number.isSafeInteger(cs.run_attempt) && cs.run_attempt >= 1 ? Number(cs.run_attempt) : 1;
    const workflowRunId = extractWorkflowRunIdFromUrl(cs.html_url, cs.details_url, cs.url);
    const appName = String(cs.app?.name || cs.app?.slug || 'check_suite').trim() || 'check_suite';
    const url = safeHttpUrl(cs.html_url || cs.details_url) ?? (repoFullName ? `https://github.com/${repoFullName}/commit/${headSha}/checks` : null);
    return {
      source: 'check_suite',
      headSha,
      headBranch: typeof cs.head_branch === 'string' && cs.head_branch ? cs.head_branch : null,
      runOrSuiteId: canonicalRunOrSuiteId(workflowRunId, id, null),
      canonicalGroup: canonicalCheckGroup(workflowRunId, id, null),
      workflowRunId,
      checkSuiteId: id,
      checkRunId: null,
      attempt,
      conclusion,
      name: appName,
      workflowName: null,
      url,
      summary: clip(`Check suite "${appName}" (${id}) completed with ${conclusion}.`, 1500),
      pullRequests: Array.isArray(cs.pull_requests) ? cs.pull_requests : [],
    };
  }

  if (event === 'check_run' && payload.check_run && typeof payload.check_run === 'object') {
    const cr = payload.check_run;
    const conclusion = String(cr.conclusion || '').toLowerCase();
    const headSha = normSha(cr.head_sha);
    const id = Number(cr.id);
    if (!headSha || !Number.isSafeInteger(id) || id < 1) return null;
    const checkSuiteId = Number.isSafeInteger(cr.check_suite?.id) && cr.check_suite.id >= 1 ? Number(cr.check_suite.id) : null;
    const workflowRunId = extractWorkflowRunIdFromUrl(cr.details_url, cr.html_url);
    const attempt = Number.isSafeInteger(cr.run_attempt) && cr.run_attempt >= 1
      ? Number(cr.run_attempt)
      : Number.isSafeInteger(cr.check_suite?.run_attempt) && cr.check_suite.run_attempt >= 1
        ? Number(cr.check_suite.run_attempt)
        : 1;
    const suiteFlushKey = checkSuiteId ? `${repositoryId}:suite:${checkSuiteId}:${attempt}` : workflowRunId ? `${repositoryId}:run:${workflowRunId}:${attempt}` : '';
    const isFailed = FAILED_CONCLUSIONS.has(conclusion);
    // If an earlier sibling job in the same suite/run failed while this last job was still running, allow this
    // completed sibling check_run to flush the now-completed suite even if this job itself succeeded.
    if (!isFailed && !(suiteFlushKey && pendingSuiteFlushes.has(suiteFlushKey))) return null;

    const name = String(cr.name || 'check_run').trim() || 'check_run';
    const url = safeHttpUrl(cr.html_url || cr.details_url) ?? (repoFullName ? `https://github.com/${repoFullName}/runs/${id}` : null);
    const outTitle = typeof cr.output?.title === 'string' ? cr.output.title.trim() : '';
    const outSummary = typeof cr.output?.summary === 'string' ? cr.output.summary.trim() : '';
    const outText = typeof cr.output?.text === 'string' ? cr.output.text.trim() : '';
    const detail = [outTitle, outSummary, outText ? clip(outText, 600) : ''].filter(Boolean).join(' — ');
    return {
      source: 'check_run',
      headSha,
      headBranch: typeof cr.check_suite?.head_branch === 'string' && cr.check_suite.head_branch ? cr.check_suite.head_branch : null,
      runOrSuiteId: canonicalRunOrSuiteId(workflowRunId, checkSuiteId, id),
      canonicalGroup: canonicalCheckGroup(workflowRunId, checkSuiteId, id),
      workflowRunId,
      checkSuiteId,
      checkRunId: id,
      attempt,
      conclusion: isFailed ? conclusion : 'failure',
      name,
      workflowName: typeof cr.app?.name === 'string' ? cr.app.name : null,
      url,
      summary: clip(detail ? `Check "${name}" (${conclusion}): ${detail}` : `Check "${name}" (${id}) completed with ${conclusion}.`, 1500),
      pullRequests: Array.isArray(cr.pull_requests) && cr.pull_requests.length
        ? cr.pull_requests
        : Array.isArray(cr.check_suite?.pull_requests)
          ? cr.check_suite.pull_requests
          : [],
      ...(!isFailed ? { flushDeferredOnly: true } : {}),
    };
  }

  return null;
}

function candidateBotPrNumbersForCheck(store: Store, repositoryId: string, parsed: ParsedFailedCheck): number[] {
  if (!store.hasTable('bot_pull_requests')) return [];
  const numbers = new Set<number>();
  for (const pr of parsed.pullRequests) {
    if (!pr || typeof pr !== 'object') continue;
    if (pr.head?.repo?.id != null && String(pr.head.repo.id) !== String(repositoryId)) continue;
    if (pr.base?.repo?.id != null && String(pr.base.repo.id) !== String(repositoryId)) continue;
    const n = Number(pr.number);
    if (Number.isSafeInteger(n) && n >= 1 && store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, n)) {
      numbers.add(n);
    }
  }
  if (!numbers.size) {
    const byShaOrBranch = store.all(
      'SELECT number FROM bot_pull_requests WHERE repository_id=? AND (lower(sha)=? OR (? IS NOT NULL AND branch=?)) ORDER BY number DESC',
      repositoryId,
      parsed.headSha,
      parsed.headBranch,
      parsed.headBranch,
    );
    for (const row of byShaOrBranch) numbers.add(Number(row.number));
  }
  return [...numbers].filter(n => {
    const st = store.hasTable('bot_pr_states')
      ? store.get('SELECT state,draft FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, n)
      : undefined;
    if (st && (st.state === 'closed' || Number(st.draft) === 1)) return false;
    return true;
  });
}

function checkFailureEventKey(repositoryId: string, prNumber: number, parsed: ParsedFailedCheck): string {
  return `${repositoryId}:pull_request.checks_failed:${prNumber}:${parsed.headSha}:${parsed.canonicalGroup}:${parsed.attempt}`;
}

/**
 * Collapses `workflow_run`, `check_suite`, and all job `check_run`s of the same attempt into one Manager wakeup,
 * even when one source supplies `workflow_run_id` and another supplies `check_suite_id`.
 */
function hasRecordedCheckFailure(store: Store, repositoryId: string, prNumber: number, parsed: ParsedFailedCheck): boolean {
  if (store.get('SELECT 1 FROM dispatch_events WHERE event_key=?', checkFailureEventKey(repositoryId, prNumber, parsed))) {
    return true;
  }
  if (!parsed.workflowRunId && !parsed.checkSuiteId) return false;
  const rows = store.all(
    `SELECT facts FROM dispatch_events
     WHERE repository_id=? AND type='pull_request.checks_failed' AND object_number=? AND source='github'`,
    repositoryId,
    prNumber,
  );
  for (const row of rows) {
    try {
      const f = JSON.parse(String(row.facts || '{}'));
      if (normSha(f.head_sha) !== parsed.headSha) continue;
      if (Number(f.check?.attempt || 1) !== parsed.attempt) continue;
      if (parsed.workflowRunId && Number(f.check?.workflow_run_id) === parsed.workflowRunId) return true;
      if (parsed.checkSuiteId && Number(f.check?.check_suite_id) === parsed.checkSuiteId) return true;
    } catch { /* ignore malformed row */ }
  }
  return false;
}

function conflictEventKey(repositoryId: string, prNumber: number, headSha: string, baseSha: string): string {
  return `${repositoryId}:pull_request.conflicted:${prNumber}:${headSha}:${baseSha}`;
}

function openBotPrNumbersTargetingBranch(store: Store, repositoryId: string, branch: string, excludePrNumber?: number): number[] {
  const rows = store.all('SELECT number FROM bot_pull_requests WHERE repository_id=? ORDER BY number DESC', repositoryId);
  return rows
    .map(r => Number(r.number))
    .filter(n => {
      if (excludePrNumber && n === excludePrNumber) return false;
      const st = store.hasTable('bot_pr_states')
        ? store.get('SELECT state,draft,base_ref FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, n)
        : undefined;
      if (st && (st.state === 'closed' || Number(st.draft) === 1)) return false;
      if (st?.base_ref && String(st.base_ref) !== branch) return false;
      const closed = store.hasTable('review_objects')
        ? store.get("SELECT closed_at FROM review_objects WHERE repository_id=? AND kind='review.pr' AND object_number=?", repositoryId, n)
        : undefined;
      return !closed?.closed_at;
    });
}

export interface BotWakePreflightPlan {
  kind: 'check_failure' | 'push_conflict' | 'pr_mergeable_pending';
  prNumbers: number[];
  headSha?: string;
  workflowRunId?: number | null;
  checkSuiteId?: number | null;
  attempt?: number;
  branch?: string;
  baseSha?: string;
}

export interface BotWakePreflight {
  pullRequests?: Record<number, Json>;
  comments?: Record<number, Json[]>;
  failedJobs?: Json[];
  resolvedWorkflowRunId?: number | null;
  resolvedCheckSuiteId?: number | null;
  resolvedWorkflowName?: string | null;
  resolvedWorkflowUrl?: string | null;
  resolvedBaseSha?: string | null;
  suitePending?: boolean;
}

export function botWakePreflightPlan(store: Store, repositoryId: string, event: string, payload: Json): BotWakePreflightPlan | null {
  if (!repositoryId || !payload || typeof payload !== 'object' || !store.hasTable('bot_pull_requests')) return null;
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  if (!policy?.enabled || !covers(projectCeiling(store, repositoryId, policy), 'comment')) return null;
  const repoFullName = String(store.get('SELECT full_name FROM repositories WHERE id=?', repositoryId)?.full_name || '');

  if (event === 'workflow_run' || event === 'check_suite' || event === 'check_run') {
    const parsed = parseFailedCheckDelivery(repositoryId, repoFullName, event, payload);
    if (!parsed) return null;
    const candidates = candidateBotPrNumbersForCheck(store, repositoryId, parsed);
    const unseen = candidates.filter(n => !hasRecordedCheckFailure(store, repositoryId, n, parsed));
    if (!unseen.length) return null;
    return {
      kind: 'check_failure',
      prNumbers: unseen,
      headSha: parsed.headSha,
      workflowRunId: parsed.workflowRunId,
      checkSuiteId: parsed.checkSuiteId,
      attempt: parsed.attempt,
    };
  }

  if (event === 'push') {
    const p = payload as any;
    if (p.deleted === true || typeof p.ref !== 'string' || !p.ref.startsWith('refs/heads/')) return null;
    const baseSha = normSha(p.after);
    if (!baseSha) return null;
    const branch = p.ref.slice('refs/heads/'.length);
    if (!branch) return null;
    const prNumbers = openBotPrNumbersTargetingBranch(store, repositoryId, branch);
    if (!prNumbers.length) return null;
    return { kind: 'push_conflict', prNumbers, branch, baseSha };
  }

  if (event === 'pull_request') {
    const p = payload as any;
    const pr = p.pull_request;
    const n = Number(pr?.number);
    // When ANY pull request merges into a base branch (`pull_request` is in baseline `appEvents`!), that base branch
    // just advanced: inspect all other open `bot_pull_requests` targeting the same branch for new merge conflicts.
    if (p.action === 'closed' && pr?.merged === true && typeof pr?.base?.ref === 'string' && pr.base.ref) {
      const prNumbers = openBotPrNumbersTargetingBranch(store, repositoryId, pr.base.ref, Number.isSafeInteger(n) ? n : undefined);
      if (prNumbers.length) {
        const baseSha = normSha(pr.merge_commit_sha);
        return { kind: 'push_conflict', prNumbers, branch: pr.base.ref, ...(baseSha ? { baseSha } : {}) };
      }
      return null;
    }
    if (!pr || pr.state !== 'open' || pr.draft === true || pr.mergeable !== null || !Number.isSafeInteger(n) || n < 1) return null;
    const owned = store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, n);
    if (!owned || (pr.user?.id != null && String(pr.user.id) !== String(owned.author_id))) return null;
    return { kind: 'pr_mergeable_pending', prNumbers: [n] };
  }

  return null;
}

function summarizeFailedCheckRun(cr: any): Record<string, any> {
  const outTitle = typeof cr?.output?.title === 'string' ? cr.output.title.trim() : '';
  const outSummary = typeof cr?.output?.summary === 'string' ? cr.output.summary.trim() : '';
  const detail = [outTitle, outSummary].filter(Boolean).map(s => clip(s, 180));
  return {
    id: Number(cr?.id) || null,
    name: clip(cr?.name || 'check', 160),
    conclusion: String(cr?.conclusion || 'failure'),
    url: safeHttpUrl(cr?.html_url || cr?.details_url),
    failed_steps: detail,
  };
}

export async function collectBotWakePreflight(
  store: Store,
  owner: Row,
  plan: BotWakePreflightPlan,
  githubUrl?: string,
  deliveryId?: string,
): Promise<BotWakePreflight> {
  const out: BotWakePreflight = { pullRequests: {}, comments: {} };
  const repoId = String(owner.id);
  const redactor = registeredRedactor(store);
  const github = new GitHub(store, owner, redactor, async () => {}, githubUrl);
  try {
    await github.connect(
      false,
      undefined,
      {
        pull_requests: 'read',
        issues: 'read',
        ...(plan.kind === 'push_conflict' && !plan.baseSha && plan.branch ? { contents: 'read' } : {}),
        ...(plan.kind === 'check_failure' ? { checks: 'read', actions: 'read' } : {}),
      },
      false,
    );
  } catch {
    return out;
  }

  if (plan.kind === 'push_conflict' && !plan.baseSha && plan.branch) {
    const refObj = await github.ref(plan.branch).catch(() => null);
    out.resolvedBaseSha = normSha(refObj?.object?.sha);
  }

  const pendingMergeablePrs: number[] = [];
  for (const prNumber of plan.prNumbers.slice(0, 25)) {
    const pr = await github.request('GET', github.path(`/pulls/${prNumber}`), undefined, true).catch(() => null);
    if (!pr || typeof pr !== 'object') continue;
    out.pullRequests![prNumber] = pr;
    if (pr.state === 'open' && pr.draft !== true) {
      if (plan.kind === 'check_failure' || pr.mergeable === false || String(pr.mergeable_state || '').toLowerCase() === 'dirty') {
        const comments = await github.pages(github.path(`/issues/${prNumber}/comments`)).catch(() => null);
        if (Array.isArray(comments)) out.comments![prNumber] = comments;
      }
      const targetMatches = plan.kind !== 'push_conflict' || !plan.branch || pr.base?.ref === plan.branch;
      if (targetMatches && pr.mergeable === null) pendingMergeablePrs.push(prNumber);
    }
  }

  if (plan.kind === 'check_failure') {
    let wfRunId = plan.workflowRunId ?? null;
    let csId = plan.checkSuiteId ?? null;
    if (wfRunId) {
      const runObj = await github.request('GET', github.path(`/actions/runs/${wfRunId}`), undefined, true).catch(() => null);
      if (runObj && typeof runObj === 'object') {
        out.resolvedWorkflowRunId = Number(runObj.id) || wfRunId;
        if (Number.isSafeInteger(runObj.check_suite_id) && runObj.check_suite_id >= 1) csId = Number(runObj.check_suite_id);
        if (typeof runObj.name === 'string' && runObj.name.trim()) out.resolvedWorkflowName = runObj.name.trim();
        if (safeHttpUrl(runObj.html_url)) out.resolvedWorkflowUrl = safeHttpUrl(runObj.html_url);
      }
      const jobsRes = await github.request('GET', github.path(`/actions/runs/${wfRunId}/jobs?per_page=50`), undefined, true).catch(() => null);
      const jobs = Array.isArray(jobsRes?.jobs) ? jobsRes.jobs : [];
      if (jobs.length && jobs.some((j: any) => String(j?.status || 'completed') !== 'completed')) {
        out.suitePending = true;
      } else {
        const failed = jobs
          .filter((j: any) => FAILED_CONCLUSIONS.has(String(j?.conclusion || '').toLowerCase()))
          .slice(0, 15)
          .map((j: any) => ({
            id: Number(j.id) || null,
            name: clip(j.name || 'job', 160),
            conclusion: String(j.conclusion || 'failure'),
            url: safeHttpUrl(j.html_url),
            failed_steps: Array.isArray(j.steps)
              ? j.steps
                  .filter((s: any) => FAILED_CONCLUSIONS.has(String(s?.conclusion || '').toLowerCase()))
                  .slice(0, 5)
                  .map((s: any) => clip(s?.name || 'step', 160))
              : [],
          }));
        if (failed.length) out.failedJobs = failed;
      }
    }
    if (csId && plan.headSha && !out.failedJobs?.length && !out.suitePending) {
      const runsRes = await github.request('GET', github.path(`/commits/${plan.headSha}/check-runs?per_page=100`), undefined, true).catch(() => null);
      const allRuns = Array.isArray(runsRes?.check_runs) ? runsRes.check_runs : [];
      const suiteRuns = allRuns.filter((cr: any) => Number(cr?.check_suite?.id) === csId);
      if (suiteRuns.length) {
        for (const cr of suiteRuns) {
          wfRunId ??= extractWorkflowRunIdFromUrl(cr?.details_url, cr?.html_url);
        }
        if (suiteRuns.some((cr: any) => String(cr?.status || 'completed') !== 'completed')) {
          out.suitePending = true;
        } else {
          const failedRuns = suiteRuns.filter((cr: any) => FAILED_CONCLUSIONS.has(String(cr?.conclusion || '').toLowerCase()));
          if (failedRuns.length) out.failedJobs = failedRuns.slice(0, 15).map(summarizeFailedCheckRun);
        }
      }
    }
    out.resolvedWorkflowRunId ??= wfRunId;
    out.resolvedCheckSuiteId = csId;
    if (out.suitePending && plan.headSha) {
      const flushKey = csId ? `${repoId}:suite:${csId}:${plan.attempt ?? 1}` : wfRunId ? `${repoId}:run:${wfRunId}:${plan.attempt ?? 1}` : '';
      if (flushKey) {
        pendingSuiteFlushes.set(flushKey, {
          repositoryId: repoId,
          headSha: plan.headSha,
          checkSuiteId: csId,
          workflowRunId: wfRunId,
          attempt: plan.attempt ?? 1,
        });
        schedulePendingSuiteRecheck(store, owner, flushKey, plan.prNumbers, githubUrl, deliveryId ?? null);
      }
    }
  }

  if (pendingMergeablePrs.length) {
    scheduleMergeableRecheck(store, owner, pendingMergeablePrs, plan.branch ?? null, plan.baseSha ?? out.resolvedBaseSha ?? null, githubUrl, deliveryId ?? null);
  }
  return out;
}

function schedulePendingSuiteRecheck(
  store: Store,
  owner: Row,
  flushKey: string,
  prNumbers: number[],
  githubUrl: string | undefined,
  deliveryId: string | null,
) {
  if (pendingRechecks.has(`suite-poll:${flushKey}`)) return;
  pendingRechecks.add(`suite-poll:${flushKey}`);
  void (async () => {
    try {
      for (const delay of recheckDelaysMs) {
        if (!pendingSuiteFlushes.has(flushKey) || !store.db.open) break;
        if (delay > 0) {
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, delay);
            t.unref?.();
          });
        }
        if (!pendingSuiteFlushes.has(flushKey) || !store.db.open) break;
        await reconcileOpenBotPullRequestsForRepo(store, owner, githubUrl, deliveryId, prNumbers).catch(() => {});
      }
    } catch {
      // Never let a background suite-flush poll reject unhandled (e.g. closed DB or revoked installation).
    } finally {
      pendingRechecks.delete(`suite-poll:${flushKey}`);
    }
  })();
}

function scheduleMergeableRecheck(
  store: Store,
  owner: Row,
  prNumbers: number[],
  pushedBranch: string | null,
  pushedBaseSha: string | null,
  githubUrl: string | undefined,
  deliveryId: string | null,
) {
  const repoId = String(owner.id);
  const targets = prNumbers.filter(n => {
    const key = `${repoId}:${n}:${pushedBaseSha ?? 'pr'}`;
    if (pendingRechecks.has(key)) return false;
    pendingRechecks.add(key);
    return true;
  });
  if (!targets.length) return;

  void (async () => {
    try {
      let remaining = [...targets];
      for (const delay of recheckDelaysMs) {
        if (!remaining.length || !store.db.open) break;
        if (delay > 0) {
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, delay);
            t.unref?.();
          });
        }
        if (!store.db.open) break;
        const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repoId);
        if (!policy?.enabled || !covers(projectCeiling(store, repoId, policy), 'comment')) break;
        const redactor = registeredRedactor(store);
        const github = new GitHub(store, owner, redactor, async () => {}, githubUrl);
        try {
          await github.connect(false, undefined, { pull_requests: 'read', issues: 'read' }, false);
        } catch {
          break;
        }
        const stillNull: number[] = [];
        for (const prNumber of remaining) {
          if (!store.db.open) break;
          const pr = await github.request('GET', github.path(`/pulls/${prNumber}`), undefined, true).catch(() => null);
          if (!pr || typeof pr !== 'object' || !store.db.open) continue;
          const comments = isPullRequestConflicted(pr, pushedBranch ? 'push' : 'pull_request', '')
            ? await github.pages(github.path(`/issues/${prNumber}/comments`)).catch(() => [])
            : [];
          store.transaction(() => {
            syncBotPullRequestState(store, repoId, pr);
            if (pr.state !== 'open' || pr.draft === true) return;
            if (pushedBranch && pr.base?.ref && pr.base.ref !== pushedBranch) return;
            if (isPullRequestConflicted(pr, pushedBranch ? 'push' : 'pull_request', '')) {
              const verified = verifiedOwnedOpenBotPr(store, repoId, prNumber, pr);
              if (!verified) return;
              if (isConflictWakeSuppressed(store, repoId, verified, comments)) return;
              const baseSha = pushedBaseSha ?? normSha(pr.base?.sha) ?? verified.baseSha;
              if (!baseSha) return;
              const ev = buildConflictEventInput(
                store,
                repoId,
                pushedBranch ? 'push' : 'pull_request',
                pushedBranch ? 'branch_advanced' : 'rechecked',
                '',
                deliveryId,
                verified,
                baseSha,
                pushedBranch ?? verified.baseRef,
                typeof pr.mergeable_state === 'string' ? pr.mergeable_state : 'dirty',
                pushedBranch ? 'base_advanced' : 'pull_request',
                comments,
              );
              recordEvent(store, ev);
            } else if (pr.mergeable === null) {
              stillNull.push(prNumber);
            }
          });
        }
        remaining = stillNull;
      }
    } catch {
      // Never let a background mergeable poll reject unhandled if the store closes or throws mid-loop.
    } finally {
      for (const n of targets) pendingRechecks.delete(`${repoId}:${n}:${pushedBaseSha ?? 'pr'}`);
    }
  })();
}

function isPullRequestConflicted(pr: any, event: string, action: string, reason = ''): boolean {
  if (!pr || typeof pr !== 'object') return false;
  if (pr.mergeable === false || pr.mergeable === 0) return true;
  const state = String(pr.mergeable_state || '').toLowerCase();
  if (state === 'dirty' || state === 'conflicting') return true;
  if (event === 'pull_request' && action === 'dequeued' && /conflict|dirty|merge/i.test(reason)) return true;
  return false;
}

function objectFacts(pr: any) {
  return {
    number: pr?.number,
    title: clip(pr?.title, 300),
    state: pr?.state ?? 'open',
    author: pr?.user?.login ?? null,
    labels: (Array.isArray(pr?.labels) ? pr.labels : []).map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
    body_excerpt: clip(pr?.body, 1200),
    draft: pr?.draft === true,
    head: pr?.head?.sha ?? null,
    base: pr?.base?.ref ?? null,
    url: pr?.html_url ?? null,
  };
}

function botIdentitySets(store: Store, repositoryId: string, ownedAuthorId?: string | null) {
  const actorRow = store.get('SELECT a.actor_id,a.login FROM repositories r JOIN github_actors a ON a.account_id=r.account_id WHERE r.id=?', repositoryId);
  const botIds = new Set<string>([ownedAuthorId ? String(ownedAuthorId) : '', actorRow?.actor_id ? String(actorRow.actor_id) : ''].filter(Boolean));
  const botLogins = new Set<string>(actorRow?.login ? [String(actorRow.login).toLowerCase()] : []);
  return { botIds, botLogins };
}

function isOwnBotActor(
  botIds: Set<string>,
  botLogins: Set<string>,
  userId: unknown,
  login: unknown,
  body?: unknown,
): boolean {
  if (typeof body === 'string' && BOT_MARKER.test(body)) return true;
  if (userId != null && String(userId) && botIds.has(String(userId))) return true;
  const loginStr = login ? String(login).toLowerCase() : '';
  if (loginStr && botLogins.has(loginStr)) return true;
  return false;
}

function isTimestampAfter(candidate: string | null | undefined, baseline: string | null | undefined): boolean {
  if (!candidate || !baseline) return false;
  const a = Date.parse(candidate);
  const b = Date.parse(baseline);
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
  return candidate > baseline;
}

function clearBotPrConflictSuppression(store: Store, repositoryId: string, prNumber: number): void {
  if (!store.hasTable('bot_pr_states')) return;
  store.run(
    `UPDATE bot_pr_states
     SET conflict_suppressed_head_sha=NULL,conflict_suppressed_env=NULL,conflict_suppressed_at=NULL,conflict_suppressed_reason=NULL
     WHERE repository_id=? AND number=?`,
    repositoryId,
    prNumber,
  );
}

function clearBotPrConflictSuppressionOnHumanActivity(store: Store, repositoryId: string, event: string, payload: any): void {
  if (!store.hasTable('bot_pull_requests') || !store.hasTable('bot_pr_states')) return;
  if (!['issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(event)) return;
  const action = String(payload?.action || '');
  if ((event === 'issue_comment' || event === 'pull_request_review_comment') && action !== 'created') return;
  if (event === 'pull_request_review' && action !== 'submitted') return;
  const actor = payload?.comment?.user ?? payload?.review?.user ?? payload?.sender;
  const body = payload?.comment?.body ?? payload?.review?.body ?? '';
  if (String(actor?.type || '') === 'Bot') return;
  const login = actor?.login ? String(actor.login).toLowerCase() : '';
  if (login.endsWith('[bot]')) return;

  const targetPrNumbers: number[] = [];
  if (event === 'issue_comment') {
    const num = Number(payload?.issue?.number);
    if (!Number.isSafeInteger(num) || num < 1) return;
    if (payload?.issue?.pull_request) targetPrNumbers.push(num);
    else targetPrNumbers.push(...botPullRequestsOfIssue(store, repositoryId, num));
  } else {
    const num = Number(payload?.pull_request?.number);
    if (Number.isSafeInteger(num) && num >= 1) targetPrNumbers.push(num);
  }
  for (const prNumber of targetPrNumbers) {
    const owned = store.get('SELECT author_id FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber);
    if (!owned) continue;
    const { botIds, botLogins } = botIdentitySets(store, repositoryId, String(owned.author_id));
    if (isOwnBotActor(botIds, botLogins, actor?.id, actor?.login, body)) continue;
    clearBotPrConflictSuppression(store, repositoryId, prNumber);
  }
}

function fallbackPermissionsForSnapshot(
  store: Store,
  repositoryId: string,
  stateRow?: Row,
  facts?: Record<string, any> | null,
): Record<string, string> | undefined {
  const savedSummary = parseJsonObject(stateRow?.patrol_env_summary);
  const fromFacts = facts?.environment_snapshot?.installation?.permissions ?? facts?.patrol?.environment_snapshot?.installation?.permissions;
  const candidate = (fromFacts && typeof fromFacts === 'object' ? fromFacts : savedSummary?.installation?.permissions) as Record<string, unknown> | undefined;
  if (!candidate || !Object.keys(candidate).length) return undefined;
  const base = computePatrolEnvironmentSnapshot(store, repositoryId);
  if (Object.keys(base.summary.installation.permissions).length > 0) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(candidate)) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  return Object.keys(out).length ? out : undefined;
}

/**
 * Returns true when Manager already explicitly ignored merge conflicts on this exact `(pr, head_sha, env_fingerprint)`
 * and no new human comment arrived since that decision, suppressing high-frequency `pull_request.conflicted` burn.
 */
function isConflictWakeSuppressed(
  store: Store,
  repositoryId: string,
  verified: VerifiedBotPr,
  liveComments?: any[],
  currentEnvFingerprint?: string,
): boolean {
  if (!store.hasTable('bot_pr_states')) return false;
  const stateRow = store.get('SELECT * FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, verified.number);
  if (!stateRow?.conflict_suppressed_head_sha || !stateRow.conflict_suppressed_at) return false;
  if (normSha(stateRow.conflict_suppressed_head_sha) !== verified.headSha) return false;
  const envFp =
    currentEnvFingerprint
    ?? computePatrolEnvironmentSnapshot(store, repositoryId, fallbackPermissionsForSnapshot(store, repositoryId, stateRow)).fingerprint;
  if (!stateRow.conflict_suppressed_env || String(stateRow.conflict_suppressed_env) !== envFp) return false;
  const rootIssue = rootIssueOfBotPr(store, repositoryId, verified.number);
  const humanComments = collectHumanComments(store, repositoryId, verified.number, rootIssue, String(verified.owned.author_id), liveComments);
  const suppressedAt = String(stateRow.conflict_suppressed_at);
  if (humanComments.some(c => isTimestampAfter(c.created_at, suppressedAt))) {
    clearBotPrConflictSuppression(store, repositoryId, verified.number);
    return false;
  }
  return true;
}

/**
 * Persists conflict suppression and patrol baseline updates atomically whenever Manager decides a bot PR event.
 */
export function recordBotPrDispatchOutcome(
  store: Store,
  event: Row,
  decision: Decision,
  _created: string[],
  _continued: string[],
  now = new Date().toISOString(),
): void {
  const eventType = String(event.type || '');
  if (!['pull_request.conflicted', 'pull_request.patrol', 'pull_request.checks_failed', 'pull_request.updated', 'pull_request.mention'].includes(eventType)) {
    return;
  }
  if (!store.hasTable('bot_pull_requests')) return;
  const repositoryId = String(event.repository_id);
  const facts = parseJsonObject(event.facts) ?? {};
  const prNumber = event.object_type === 'pr' && event.object_number != null
    ? Number(event.object_number)
    : Number(facts.pr_number || 0);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) return;
  const owned = store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber);
  if (!owned) return;
  if (!store.hasTable('bot_pr_states')) botPrWakeStorage(store);

  const prev = store.get('SELECT * FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
  const headSha = normSha(facts.head_sha) ?? normSha(prev?.head_sha) ?? normSha(owned.sha);
  const baseSha = normSha(facts.base_sha) ?? normSha(prev?.base_sha);
  const baseRef = typeof facts.base_ref === 'string' && facts.base_ref ? facts.base_ref : (prev?.base_ref ? String(prev.base_ref) : null);

  if (!prev) {
    store.run(
      `INSERT OR IGNORE INTO bot_pr_states(repository_id,number,state,draft,base_ref,base_sha,head_sha,updated_at)
       VALUES(?,?,'open',0,?,?,?,?)`,
      repositoryId,
      prNumber,
      baseRef,
      baseSha,
      headSha,
      now,
    );
  }

  const livePermsFallback = fallbackPermissionsForSnapshot(store, repositoryId, prev, facts);
  const currentEnv = computePatrolEnvironmentSnapshot(store, repositoryId, livePermsFallback);
  const envSummaryJson = JSON.stringify(currentEnv.summary);
  const isConflictDecision =
    eventType === 'pull_request.conflicted'
    || (eventType === 'pull_request.patrol' && Boolean(facts.patrol?.is_conflicted));

  if (decision.decision === 'ignore') {
    if (isConflictDecision && headSha) {
      store.run(
        `UPDATE bot_pr_states
         SET conflict_suppressed_head_sha=?,
             conflict_suppressed_env=?,
             conflict_suppressed_at=?,
             conflict_suppressed_reason=?,
             patrol_env_fingerprint=?,
             patrol_env_summary=?,
             patrol_head_sha=coalesce(?,patrol_head_sha),
             patrol_base_sha=coalesce(?,patrol_base_sha),
             patrol_status='suppressed_dirty',
             last_patrol_at=CASE WHEN ? THEN ? ELSE last_patrol_at END
         WHERE repository_id=? AND number=?`,
        headSha,
        currentEnv.fingerprint,
        now,
        clip(decision.reason, 400),
        currentEnv.fingerprint,
        envSummaryJson,
        headSha,
        baseSha,
        eventType === 'pull_request.patrol' ? 1 : 0,
        now,
        repositoryId,
        prNumber,
      );
    } else if (eventType === 'pull_request.patrol' || eventType === 'pull_request.checks_failed') {
      store.run(
        `UPDATE bot_pr_states
         SET patrol_env_fingerprint=?,
             patrol_env_summary=?,
             patrol_head_sha=coalesce(?,patrol_head_sha),
             patrol_base_sha=coalesce(?,patrol_base_sha),
             patrol_status='ignored',
             last_patrol_at=CASE WHEN ? THEN ? ELSE last_patrol_at END
         WHERE repository_id=? AND number=?`,
        currentEnv.fingerprint,
        envSummaryJson,
        headSha,
        baseSha,
        eventType === 'pull_request.patrol' ? 1 : 0,
        now,
        repositoryId,
        prNumber,
      );
    }
    return;
  }

  // Manager actively created or continued work: lift any conflict suppression and advance patrol env baseline.
  store.run(
    `UPDATE bot_pr_states
     SET conflict_suppressed_head_sha=NULL,
         conflict_suppressed_env=NULL,
         conflict_suppressed_at=NULL,
         conflict_suppressed_reason=NULL,
         patrol_env_fingerprint=?,
         patrol_env_summary=?,
         patrol_head_sha=coalesce(?,patrol_head_sha),
         patrol_base_sha=coalesce(?,patrol_base_sha),
         patrol_status=?,
         last_patrol_at=CASE WHEN ? THEN ? ELSE last_patrol_at END
     WHERE repository_id=? AND number=?`,
    currentEnv.fingerprint,
    envSummaryJson,
    headSha,
    baseSha,
    decision.decision === 'create' ? 'task_created' : 'task_continued',
    eventType === 'pull_request.patrol' ? 1 : 0,
    now,
    repositoryId,
    prNumber,
  );
}

interface HumanCommentSummary {
  key: string;
  id: string;
  author: string | null;
  created_at: string;
  body_excerpt: string;
  url: string | null;
}

function collectHumanComments(store: Store, repositoryId: string, prNumber: number, rootIssue: number | null, ownedAuthorId: string, liveComments?: any[]): HumanCommentSummary[] {
  const { botIds, botLogins } = botIdentitySets(store, repositoryId, ownedAuthorId);
  const byKey = new Map<string, HumanCommentSummary>();

  const addCandidate = (key: string, id: string, userType: unknown, userId: unknown, login: unknown, body: unknown, createdAt: unknown, url: unknown) => {
    const text = String(body ?? '').trim();
    if (!text) return;
    if (String(userType || '') === 'Bot') return;
    if (isOwnBotActor(botIds, botLogins, userId, login, text)) return;
    const loginStr = login ? String(login) : null;
    if (loginStr && loginStr.toLowerCase().endsWith('[bot]')) return;
    const at = typeof createdAt === 'string' && createdAt ? createdAt : null;
    if (!at || byKey.has(key)) return;
    byKey.set(key, {
      key,
      id,
      author: loginStr,
      created_at: at,
      body_excerpt: clip(text, 400),
      url: safeHttpUrl(url),
    });
  };

  if (Array.isArray(liveComments)) {
    for (const c of liveComments) {
      if (!c || typeof c !== 'object') continue;
      const cid = String(c.id ?? '');
      if (!cid) continue;
      addCandidate(`comment:${cid}`, cid, c.user?.type, c.user?.id, c.user?.login, c.body, c.created_at ?? c.updated_at, c.html_url);
    }
  }

  const numbers = [prNumber, ...(rootIssue ? [rootIssue] : [])];
  const marks = numbers.map(() => '?').join(',');
  // The PR's and its Issue's events through dispatch_events_object (#1401). Without statistics SQLite read them through
  // dispatch_events_repository (repository_id,created_at), whose order spares the sort: every event of the repository,
  // about 40 KB each, for up to 24 s. These four types are recorded with object type 'pr' or 'issue' (review/queue.ts,
  // review/development.ts), so naming both keeps the rows; `+created_at` sorts the few rows found instead.
  for (const row of store.all(
    `SELECT id,type,facts,created_at FROM dispatch_events
     WHERE repository_id=? AND object_type IN ('pr','issue') AND object_number IN (${marks})
       AND type IN ('pull_request.updated','pull_request.mention','issue.updated','issue.mention')
     ORDER BY +created_at ASC, rowid ASC`,
    repositoryId,
    ...numbers,
  )) {
    let facts: any = null;
    try { facts = JSON.parse(String(row.facts || '{}')); } catch { facts = null; }
    if (!facts) continue;
    const actorType = facts.trigger?.actor_type;
    const actorId = facts.trigger?.actor_id;
    if (facts.comment) {
      const cid = String(facts.comment.id || row.id);
      addCandidate(`comment:${cid}`, cid, actorType ?? 'User', actorId, facts.comment.author ?? facts.actor, facts.comment.body, row.created_at, facts.comment.url);
    } else if (facts.review) {
      const rid = String(facts.trigger?.source?.id || row.id);
      addCandidate(`review:${rid}`, rid, actorType ?? 'User', actorId, facts.review.author ?? facts.actor, facts.review.body, row.created_at, facts.trigger?.url);
    }
  }

  return [...byKey.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * The tasks a bot PR was woken for, selected by the PR alone (#1353). The three wake types are recorded by this module
 * with `object: { type: 'pr', number }` (`recordEvent` stores `object_type`/`object_number` from it), so
 * `object_type='pr'` keeps exactly the rows the earlier `(e.object_number=? OR t.object_number=?)` selected.
 *
 * The previous single statement joined every task and every event of the repository through the cross-table `OR`:
 * `board_task_object (repository_id=?)` × `dispatch_events_object (repository_id=?)` took 3.5 s per call on a repository
 * with 5k tasks and 13k events. Both halves of the `OR` are now index-driven branches that `UNION` to the same deduplicated
 * task ids: the PR's wake events through `dispatch_events_object` → `task_events_event`, and the PR's own tasks through
 * `board_task_object`/`board_task_latest` → their linked events.
 *
 * Every join is a `CROSS JOIN` because SQLite does not reorder the tables on either side of one, so the join order
 * these statements rely on is fixed by the SQL instead of by the planner version: the event branch reads the PR's events
 * and then their task links, the task branch reads the PR's tasks, their task links by `task_id`, and each event by its
 * primary key, and the outer `CROSS JOIN tasks t` keeps `w`'s few ids as the loop with the task row as a primary-key
 * lookup. Without the pinning, SQLite 3.50.4 joined `dispatch_events` before `task_events` in the task branch, i.e. it
 * read every event of the repository once per task of the PR. The pinning fixes that order, not the index choice: within
 * it the planner still picks the index (with ANALYZE statistics it may, for example, prefer `board_task_cover` or scan
 * `task_events`), and that choice stays PR-driven.
 *
 * The task branch only exists to keep the row set identical to the earlier `OR` statement: a task numbered for the PR is
 * returned even when its linked wake events belong to another PR. It cannot change the counted rounds, because `wakeLinks`
 * compares `object_number`, which this projection does not select (`Number(t.object_number || 0)` is 0), so only the PR's
 * own events produce a round.
 */
export const BOT_PR_WAKE_TASK_ROWS_SQL = `
  SELECT t.id,t.kind,t.status,t.summary,t.head_sha,t.error_code,t.input,t.result,t.created_at,t.updated_at
  FROM (
    SELECT te.task_id AS task_id
    FROM dispatch_events e
    CROSS JOIN task_events te ON te.event_id=e.id
    WHERE e.repository_id=? AND e.object_type='pr' AND e.object_number=?
      AND e.type IN ('pull_request.checks_failed','pull_request.conflicted','pull_request.patrol')
    UNION
    SELECT te.task_id AS task_id
    FROM tasks s
    CROSS JOIN task_events te ON te.task_id=s.id
    CROSS JOIN dispatch_events e ON e.id=te.event_id
    WHERE s.repository_id=? AND s.object_number=?
      AND e.repository_id=?
      AND e.type IN ('pull_request.checks_failed','pull_request.conflicted','pull_request.patrol')
  ) w
  CROSS JOIN tasks t
  WHERE t.id=w.task_id AND t.repository_id=?
  ORDER BY t.created_at ASC, t.rowid ASC`;

/**
 * Computes comprehensive, untruncated-count revision history facts for a bot PR (#1167):
 * - how many times this PR was previously revised due to check failures or merge conflicts (no hard retry cap)
 * - per-round task outcome summaries (`rounds`)
 * - whether new human comments arrived in the meantime (`has_new_human_comments` + `new_human_comments`)
 */
export function botPrWakeRevisionFacts(store: Store, repositoryId: string, prNumber: number, liveComments?: any[]) {
  const redactor = registeredRedactor(store);
  const owned = store.hasTable('bot_pull_requests')
    ? store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber)
    : undefined;
  const rootIssue = rootIssueOfBotPr(store, repositoryId, prNumber);
  const forRequests = store.hasTable('bot_pr_requests')
    ? (() => {
        const reqRows = store.all("SELECT task_id, created_at FROM bot_pr_requests WHERE repository_id=? AND number=? AND state='done'", repositoryId, prNumber);
        if (!reqRows.length) return 0;
        const contsByTask = new Map<string, { round: number; at: string }[]>();
        if (store.hasTable('task_history')) {
          for (const tid of new Set(reqRows.map(r => String(r.task_id || '')))) {
            if (!tid) continue;
            const cs = store.all("SELECT json_extract(data,'$.round') AS round, created_at FROM task_history WHERE task_id=? AND run_id IS NULL AND type='task_continued' ORDER BY id ASC", tid);
            if (cs.length) contsByTask.set(tid, cs.map(c => ({ round: Number(c.round) || 2, at: String(c.created_at || '') })));
          }
        }
        const distinct = new Set<string>();
        for (const r of reqRows) {
          const tid = String(r.task_id || ''), at = String(r.created_at || '');
          let round = 1;
          for (const c of contsByTask.get(tid) ?? []) if (c.at <= at) round = c.round;
          distinct.add(`${tid}:${round}`);
        }
        return distinct.size;
      })()
    : 0;

  const taskRows = store.hasTable('task_events')
    ? store.all(
        BOT_PR_WAKE_TASK_ROWS_SQL,
        repositoryId,
        prNumber,
        repositoryId,
        prNumber,
        repositoryId,
        repositoryId,
      )
    : [];

  let forChecksFailed = 0;
  let forConflicts = 0;
  let forPatrol = 0;
  const rawRounds: any[] = [];
  for (const t of taskRows) {
    const wakeLinks = store.all(
      `SELECT e.id AS event_id, e.type, e.created_at AS event_at, te.relation, te.created_at AS linked_at
       FROM task_events te JOIN dispatch_events e ON e.id=te.event_id
       WHERE te.task_id=? AND e.repository_id=?
         AND e.type IN ('pull_request.checks_failed','pull_request.conflicted','pull_request.patrol')
         AND (e.object_number=? OR ?=?)
       ORDER BY te.created_at ASC, te.rowid ASC`,
      t.id,
      repositoryId,
      prNumber,
      Number(t.object_number || 0),
      prNumber,
    );
    const continuedEvents = store.hasTable('task_history')
      ? store.all(
          "SELECT id, data, created_at FROM task_history WHERE task_id=? AND run_id IS NULL AND type='task_continued' ORDER BY id ASC",
          t.id,
        ).map(row => {
          let d: any = {};
          try { d = JSON.parse(String(row.data || '{}')); } catch {}
          return { id: Number(row.id), round: Number(d.round) || 2, event_id: d.event_id ? String(d.event_id) : null, at: String(row.created_at || '') };
        })
      : [];
    // `delivery` rows written while `attemptRun` is active receive `run_id = attemptRun.id` via `trace_history_scope`,
    // whereas rows written outside an active run keep `run_id IS NULL`. Query both disjoint slices through existing
    // indexes (`task_history_run` and `task_history_run_type` via `task_run_task`) without scanning child run history.
    const deliveries = store.hasTable('task_history')
      ? [
          ...store.all(
            "SELECT id, data, created_at FROM task_history WHERE task_id=? AND run_id IS NULL AND type='delivery' ORDER BY id ASC",
            t.id,
          ),
          ...(store.hasTable('task_runs')
            ? store.all(
                "SELECT id, data, created_at FROM task_history WHERE run_id IN (SELECT id FROM task_runs WHERE task_id=?) AND type='delivery' AND +task_id=?",
                t.id,
                t.id,
              )
            : []),
        ]
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map(row => {
            let d: any = null;
            try { d = JSON.parse(String(row.data || 'null')); } catch {}
            return { id: Number(row.id), data: d, at: String(row.created_at || '') };
          })
      : [];

    let parsedResult: any = null;
    let parsedInput: any = null;
    try { parsedResult = t.result ? JSON.parse(String(t.result)) : null; } catch { parsedResult = null; }
    try { parsedInput = t.input ? JSON.parse(String(t.input)) : null; } catch { parsedInput = null; }
    const roleRow = store.hasTable('task_origins')
      ? store.get('SELECT executor_role FROM task_origins WHERE task_id=?', t.id)
      : undefined;
    const currentRound = Number(parsedInput?.round || 1);

    // Group wake events into logical rounds: Round 1 (before any task_continued) + each continued round N (#1331).
    const byRound = new Map<number, { types: Set<string>; startedAt: string; nextStartedAt: string | null; contId: number | null; nextContId: number | null }>();
    for (const link of wakeLinks) {
      let rNum = 1;
      let startedAt = String(t.created_at);
      let contIdx = -1;
      const exactIdx = continuedEvents.findIndex(c => c.event_id && c.event_id === String(link.event_id));
      if (exactIdx >= 0) {
        contIdx = exactIdx;
      } else {
        const linkTime = String(link.linked_at || link.event_at || '');
        for (let i = 0; i < continuedEvents.length; i++) {
          if (continuedEvents[i]!.at <= linkTime) contIdx = i;
        }
      }
      if (contIdx >= 0) {
        rNum = continuedEvents[contIdx]!.round;
        startedAt = continuedEvents[contIdx]!.at || String(link.linked_at || t.created_at);
      }
      const nextCont = contIdx >= 0 ? continuedEvents[contIdx + 1] : continuedEvents[0];
      let bucket = byRound.get(rNum);
      if (!bucket) {
        bucket = {
          types: new Set<string>(),
          startedAt,
          nextStartedAt: nextCont?.at ?? null,
          contId: contIdx >= 0 ? continuedEvents[contIdx]!.id : null,
          nextContId: nextCont?.id ?? null,
        };
        byRound.set(rNum, bucket);
      }
      bucket.types.add(String(link.type));
    }

    const sortedRoundNums = [...byRound.keys()].sort((a, b) => a - b);
    for (const rNum of sortedRoundNums) {
      const bucket = byRound.get(rNum)!;
      const evTypes = [...bucket.types];
      if (evTypes.includes('pull_request.checks_failed')) forChecksFailed++;
      if (evTypes.includes('pull_request.conflicted')) forConflicts++;
      if (evTypes.includes('pull_request.patrol')) forPatrol++;
      const isLatestRound = rNum === currentRound || (!continuedEvents.length && rNum === 1);
      const roundDelivery = deliveries.find(d =>
        (bucket.contId === null || d.id > bucket.contId)
        && (bucket.nextContId === null || d.id < bucket.nextContId),
      );
      const effectiveResult = roundDelivery?.data ?? (isLatestRound ? parsedResult : null);
      const effectiveStatus = isLatestRound ? String(t.status) : (roundDelivery?.data?.pr_url ? 'pr_opened' : 'completed');
      const summaryText = effectiveResult?.summary
        ? String(effectiveResult.summary)
        : (isLatestRound && t.error_code)
          ? `Task ${t.status} (${t.error_code})`
          : String(t.summary || '');
      rawRounds.push({
        task_id: String(t.id),
        task_round: rNum,
        status: effectiveStatus,
        role: roleRow?.executor_role ?? parsedInput?.executor_role ?? null,
        triggers: evTypes,
        head_sha: t.head_sha ?? null,
        published_sha: typeof effectiveResult?.sha === 'string' ? effectiveResult.sha : null,
        no_changes: effectiveResult?.status === 'no_changes',
        error_code: isLatestRound ? (t.error_code ?? null) : null,
        goal: clip(t.summary, 240),
        summary: clip(summaryText, 500),
        created_at: bucket.startedAt,
        updated_at: roundDelivery?.at ?? (isLatestRound ? String(t.updated_at) : bucket.startedAt),
      });
    }
  }
  rawRounds.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.task_round - b.task_round);
  const allRounds = rawRounds.map((r, index) => ({ round: index + 1, ...r }));

  const sourceTask = owned?.source_task_id
    ? store.get('SELECT created_at FROM tasks WHERE id=?', owned.source_task_id)
    : undefined;
  const firstRevisionAt = allRounds[0]?.created_at ?? null;
  const lastRevisionAt = allRounds.at(-1)?.created_at ?? null;
  const baselineForNewComments = lastRevisionAt ?? (sourceTask?.created_at ? String(sourceTask.created_at) : null);

  const humanComments = collectHumanComments(
    store,
    repositoryId,
    prNumber,
    rootIssue,
    String(owned?.author_id ?? ''),
    liveComments,
  );
  const newHumanComments = baselineForNewComments
    ? humanComments.filter(c => c.created_at >= baselineForNewComments)
    : humanComments;
  const commentsSinceFirstRevision = firstRevisionAt
    ? humanComments.filter(c => c.created_at >= firstRevisionAt)
    : newHumanComments;

  const forChecksOrConflicts = allRounds.filter(r => r.triggers.includes('pull_request.checks_failed') || r.triggers.includes('pull_request.conflicted')).length;

  return publicContent(
    {
      for_checks_or_conflicts: forChecksOrConflicts,
      for_checks_failed: forChecksFailed,
      for_conflicts: forConflicts,
      for_patrol: forPatrol,
      for_requests: forRequests,
      for_this_author: 0,
      rounds_truncated: allRounds.length > 20,
      rounds: allRounds.slice(-20).map(({ key: _k, ...r }: any) => r),
      has_new_human_comments: newHumanComments.length > 0,
      human_comments_since_first_revision: commentsSinceFirstRevision.length,
      new_human_comments: newHumanComments.slice(-10).map(({ key: _k, ...c }) => c),
    },
    redactor,
  );
}

/** Refreshes `facts.revisions` right when `dispatchContext` runs so serialized events see just-completed rounds. */
export function refreshBotPrWakeFacts(store: Store, event: Row, facts: Record<string, any>): Record<string, any> {
  const type = String(event.type || '');
  if (type !== 'pull_request.checks_failed' && type !== 'pull_request.conflicted' && type !== 'pull_request.patrol') return facts;
  const prNumber = Number(facts?.pr_number ?? event.object_number ?? 0);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) return facts;
  const capturedHumanComments = Array.isArray(facts?.revisions?.new_human_comments)
    ? facts.revisions.new_human_comments.map((c: any) => ({
        id: c.id,
        user: { type: 'User', login: c.author },
        body: c.body_excerpt,
        created_at: c.created_at,
        html_url: c.url,
      }))
    : undefined;
  return {
    ...facts,
    revisions: botPrWakeRevisionFacts(store, String(event.repository_id), prNumber, capturedHumanComments),
  };
}

function buildCheckFailedEventInput(
  store: Store,
  repositoryId: string,
  event: string,
  action: string,
  actor: string,
  delivery: string | null,
  verified: VerifiedBotPr,
  parsed: ParsedFailedCheck,
  failedJobs?: Json[],
  liveComments?: any[],
): EventInput {
  const redactor = registeredRedactor(store);
  const rootIssue = rootIssueOfBotPr(store, repositoryId, verified.number);
  const eventKey = checkFailureEventKey(repositoryId, verified.number, parsed);
  const jobSummary = Array.isArray(failedJobs) && failedJobs.length
    ? ` Failed jobs: ${failedJobs.map((j: any) => `${j.name}${j.failed_steps?.length ? ` (${j.failed_steps.join(', ')})` : ''}`).join('; ')}.`
    : '';
  const checkFacts = publicContent(
    {
      source: parsed.source,
      name: parsed.name,
      workflow_name: parsed.workflowName,
      run_or_suite_id: parsed.runOrSuiteId,
      workflow_run_id: parsed.workflowRunId,
      check_suite_id: parsed.checkSuiteId,
      check_run_id: parsed.checkRunId,
      attempt: parsed.attempt,
      conclusion: parsed.conclusion,
      url: parsed.url,
      summary: clip(parsed.summary + jobSummary, 2000),
      ...(Array.isArray(failedJobs) && failedJobs.length ? { failed_jobs: failedJobs } : {}),
    },
    redactor,
  );

  const revisions = botPrWakeRevisionFacts(store, repositoryId, verified.number, liveComments);
  const wakeSummary = {
    type: 'pull_request.checks_failed',
    pr_number: verified.number,
    head_sha: verified.headSha,
    check: checkFacts,
  };
  const options: CreateOption[] = [
    {
      id: 'development',
      work: 'development.pr',
      title: `修复 bot PR #${verified.number} 检查失败（${clip(parsed.name, 60)}）`,
      default: false,
      spec: {
        type: 'object',
        kind: 'development.pr',
        number: verified.number,
        head: verified.headSha,
        input: { revision: { source: 'checks_failed' }, wake_event: wakeSummary },
        delivery,
      },
    },
    {
      id: 'reply',
      work: 'reply',
      title: `通用回复 #${verified.number}`,
      default: false,
      spec: {
        type: 'reply',
        kind: 'workflow.pr',
        number: verified.number,
        head: verified.headSha,
        input: { pull_request: verified.prObject, wake_event: wakeSummary },
        key: `checks_failed:${parsed.canonicalGroup}:${parsed.attempt}`,
        delivery,
      },
    },
  ];

  const trigger = {
    event,
    action,
    reason: 'pull_request.checks_failed',
    actor,
    pr_number: verified.number,
    head_sha: verified.headSha,
    check_name: checkFacts.name,
    run_or_suite_id: checkFacts.run_or_suite_id,
    workflow_run_id: checkFacts.workflow_run_id,
    check_suite_id: checkFacts.check_suite_id,
    attempt: checkFacts.attempt,
    conclusion: checkFacts.conclusion,
    url: checkFacts.url,
    summary: checkFacts.summary,
  };

  return {
    repositoryId,
    key: eventKey,
    type: 'pull_request.checks_failed',
    source: 'github',
    summary: `bot PR 检查失败：#${verified.number} ${clip(parsed.name, 80)}（${parsed.conclusion}）`,
    object: { type: 'pr', number: verified.number },
    delivery,
    facts: {
      event,
      action,
      actor,
      bot_pull_request: true,
      pr_number: verified.number,
      head_sha: verified.headSha,
      root_issue_number: rootIssue,
      object: objectFacts(verified.prObject),
      check: checkFacts,
      revisions,
    },
    options,
    merge: {
      key: eventKey,
      data: {
        reason: 'pull_request.checks_failed',
        wake_type: 'pull_request.checks_failed',
        actor,
        pr_number: verified.number,
        head_sha: verified.headSha,
        check: checkFacts,
        url: checkFacts.url,
      },
      trigger,
      head: verified.headSha,
      kinds: ['development.pr'],
    },
  };
}

function buildConflictEventInput(
  store: Store,
  repositoryId: string,
  event: string,
  action: string,
  actor: string,
  delivery: string | null,
  verified: VerifiedBotPr,
  baseSha: string,
  baseRef: string | null,
  mergeableState: string | null,
  detectedVia: 'push' | 'pull_request' | 'base_advanced' | 'reconcile',
  liveComments?: any[],
  envSnapshot?: PatrolEnvironmentSnapshot,
): EventInput {
  const redactor = registeredRedactor(store);
  const rootIssue = rootIssueOfBotPr(store, repositoryId, verified.number);
  const eventKey = conflictEventKey(repositoryId, verified.number, verified.headSha, baseSha);
  const targetBranch = baseRef ?? verified.baseRef ?? 'main';
  const conflictFacts = publicContent(
    {
      pr_number: verified.number,
      head_sha: verified.headSha,
      head_ref: verified.headRef,
      base_sha: baseSha,
      base_ref: targetBranch,
      mergeable: false,
      mergeable_state: mergeableState ?? 'dirty',
      detected_via: detectedVia,
      url: verified.htmlUrl,
      summary: `Bot PR #${verified.number} (${verified.headRef} @ ${verified.headSha.slice(0, 7)}) has merge conflicts with base branch ${targetBranch} (${baseSha.slice(0, 7)}).`,
    },
    redactor,
  );
  const revisions = botPrWakeRevisionFacts(store, repositoryId, verified.number, liveComments);
  const wakeSummary = {
    type: 'pull_request.conflicted',
    pr_number: verified.number,
    head_sha: verified.headSha,
    base_sha: baseSha,
    base_ref: targetBranch,
    conflict: conflictFacts,
  };
  const options: CreateOption[] = [
    {
      id: 'development',
      work: 'development.pr',
      title: `解决 bot PR #${verified.number} 与 ${targetBranch} 的合并冲突`,
      default: false,
      spec: {
        type: 'object',
        kind: 'development.pr',
        number: verified.number,
        head: verified.headSha,
        input: {
          revision: { source: 'conflicted' },
          conflict_base_sha: baseSha,
          conflict_base_ref: targetBranch,
          wake_event: wakeSummary,
        },
        delivery,
      },
    },
    {
      id: 'reply',
      work: 'reply',
      title: `通用回复 #${verified.number}`,
      default: false,
      spec: {
        type: 'reply',
        kind: 'workflow.pr',
        number: verified.number,
        head: verified.headSha,
        input: { pull_request: verified.prObject, wake_event: wakeSummary },
        key: `conflicted:${verified.headSha}:${baseSha}`,
        delivery,
      },
    },
  ];

  const trigger = {
    event,
    action,
    reason: 'pull_request.conflicted',
    actor,
    pr_number: verified.number,
    head_sha: verified.headSha,
    base_ref: targetBranch,
    base_sha: baseSha,
    mergeable: false,
    url: verified.htmlUrl,
    summary: conflictFacts.summary,
  };

  return {
    repositoryId,
    key: eventKey,
    type: 'pull_request.conflicted',
    source: 'github',
    summary: `bot PR 合并冲突：#${verified.number} 与 ${targetBranch}（${baseSha.slice(0, 7)}）冲突`,
    object: { type: 'pr', number: verified.number },
    delivery,
    facts: {
      event,
      action,
      actor,
      bot_pull_request: true,
      pr_number: verified.number,
      head_sha: verified.headSha,
      base_sha: baseSha,
      base_ref: targetBranch,
      root_issue_number: rootIssue,
      object: objectFacts({ ...verified.prObject, base: { ref: targetBranch, sha: baseSha } }),
      conflict: conflictFacts,
      revisions,
      ...(envSnapshot ? { environment_snapshot: envSnapshot.summary } : {}),
    },
    options,
    merge: {
      key: eventKey,
      data: {
        reason: 'pull_request.conflicted',
        wake_type: 'pull_request.conflicted',
        actor,
        pr_number: verified.number,
        head_sha: verified.headSha,
        base_sha: baseSha,
        base_ref: targetBranch,
        conflict: conflictFacts,
        url: verified.htmlUrl,
      },
      trigger,
      head: verified.headSha,
      kinds: ['development.pr'],
    },
  };
}

function applyResolvedCheckPreflight(parsed: ParsedFailedCheck, preflight?: BotWakePreflight): ParsedFailedCheck {
  const wfRunId = preflight?.resolvedWorkflowRunId ?? parsed.workflowRunId;
  const csId = preflight?.resolvedCheckSuiteId ?? parsed.checkSuiteId;
  const wfName = preflight?.resolvedWorkflowName ?? parsed.workflowName;
  const name = parsed.source === 'check_run' && Array.isArray(preflight?.failedJobs) && preflight!.failedJobs!.length > 1 && wfName
    ? wfName
    : (preflight?.resolvedWorkflowName && parsed.source === 'check_suite' ? preflight.resolvedWorkflowName : parsed.name);
  const summary = parsed.flushDeferredOnly && Array.isArray(preflight?.failedJobs) && preflight!.failedJobs!.length
    ? clip(`Check suite "${name}" completed with ${preflight!.failedJobs!.length} failed check(s).`, 1500)
    : parsed.summary;
  return {
    ...parsed,
    workflowRunId: wfRunId,
    checkSuiteId: csId,
    workflowName: wfName,
    name,
    url: preflight?.resolvedWorkflowUrl ?? parsed.url,
    runOrSuiteId: canonicalRunOrSuiteId(wfRunId, csId, parsed.checkRunId),
    canonicalGroup: canonicalCheckGroup(wfRunId, csId, parsed.checkRunId),
    summary,
  };
}

/**
 * Produces deduplicated `pull_request.checks_failed` and `pull_request.conflicted` Manager events
 * for open, non-draft PRs recorded in `bot_pull_requests`.
 */
export function botPrWakeEvents(
  store: Store,
  repositoryId: string,
  event: string,
  payload: Json,
  delivery: string,
  preflight?: BotWakePreflight,
): EventInput[] {
  if (!repositoryId || !payload || typeof payload !== 'object' || !store.hasTable('bot_pull_requests')) return [];
  const p = payload as any;
  const action = String(p.action || '');
  const actor = String(p.sender?.login || '');
  const repoFullName = String(store.get('SELECT full_name FROM repositories WHERE id=?', repositoryId)?.full_name || '');

  if (preflight?.pullRequests) {
    for (const pr of Object.values(preflight.pullRequests)) syncBotPullRequestState(store, repositoryId, pr);
  }
  if (event === 'pull_request' && p.pull_request) {
    syncBotPullRequestState(store, repositoryId, p.pull_request);
  }
  clearBotPrConflictSuppressionOnHumanActivity(store, repositoryId, event, p);
  markBotPrsForReconcile(store, repositoryId, event, p);

  const events: EventInput[] = [];

  if (event === 'workflow_run' || event === 'check_suite' || event === 'check_run') {
    const rawParsed = parseFailedCheckDelivery(repositoryId, repoFullName, event, p);
    if (!rawParsed || preflight?.suitePending) return [];
    const parsed = applyResolvedCheckPreflight(rawParsed, preflight);
    if (parsed.flushDeferredOnly && (!preflight?.failedJobs || !preflight.failedJobs.length)) return [];

    for (const k of [
      parsed.checkSuiteId ? `${repositoryId}:suite:${parsed.checkSuiteId}:${parsed.attempt}` : '',
      parsed.workflowRunId ? `${repositoryId}:run:${parsed.workflowRunId}:${parsed.attempt}` : '',
    ]) {
      if (k) pendingSuiteFlushes.delete(k);
    }

    const prNumbers = candidateBotPrNumbersForCheck(store, repositoryId, parsed);
    for (const prNumber of prNumbers) {
      const livePr = preflight?.pullRequests?.[prNumber];
      const verified = verifiedOwnedOpenBotPr(store, repositoryId, prNumber, livePr);
      if (!verified || verified.headSha !== parsed.headSha) continue;
      if (hasRecordedCheckFailure(store, repositoryId, prNumber, parsed)) continue;
      events.push(
        buildCheckFailedEventInput(
          store,
          repositoryId,
          event,
          action,
          actor,
          delivery,
          verified,
          parsed,
          preflight?.failedJobs,
          preflight?.comments?.[prNumber] as any[] | undefined,
        ),
      );
    }
    return events;
  }

  const inspectBranchAdvance = (pushedBranch: string, baseSha: string, sourceEvent: 'push' | 'pull_request', detectedVia: 'push' | 'base_advanced', excludePr?: number) => {
    const rows = store.all('SELECT number FROM bot_pull_requests WHERE repository_id=? ORDER BY number ASC', repositoryId);
    for (const row of rows) {
      const prNumber = Number(row.number);
      if (excludePr && prNumber === excludePr) continue;
      const livePr = preflight?.pullRequests?.[prNumber];
      const verified = verifiedOwnedOpenBotPr(store, repositoryId, prNumber, livePr);
      if (!verified) continue;
      const targetBranch = verified.baseRef ?? (String(store.get('SELECT base_branch FROM policies WHERE repository_id=?', repositoryId)?.base_branch || '').trim() || 'main');
      if (targetBranch !== pushedBranch) continue;
      const stateSource = livePr ?? verified.savedState;
      if (!isPullRequestConflicted(stateSource, sourceEvent, '')) continue;
      const liveComments = preflight?.comments?.[prNumber] as any[] | undefined;
      if (isConflictWakeSuppressed(store, repositoryId, verified, liveComments)) continue;
      const mergeableState = typeof (livePr as any)?.mergeable_state === 'string'
        ? String((livePr as any).mergeable_state)
        : verified.savedState?.mergeable_state
          ? String(verified.savedState.mergeable_state)
          : 'dirty';
      events.push(
        buildConflictEventInput(
          store,
          repositoryId,
          sourceEvent,
          'branch_advanced',
          actor,
          delivery,
          verified,
          baseSha,
          pushedBranch,
          mergeableState,
          detectedVia,
          liveComments,
        ),
      );
    }
  };

  if (event === 'push') {
    if (p.deleted === true || typeof p.ref !== 'string' || !p.ref.startsWith('refs/heads/')) return [];
    const baseSha = normSha(p.after);
    if (!baseSha) return [];
    const pushedBranch = p.ref.slice('refs/heads/'.length);
    if (!pushedBranch) return [];
    inspectBranchAdvance(pushedBranch, baseSha, 'push', 'push');
    return events;
  }

  if (event === 'pull_request' && p.pull_request) {
    const prNumber = Number(p.pull_request.number);
    if (action === 'closed' && p.pull_request.merged === true && typeof p.pull_request.base?.ref === 'string' && p.pull_request.base.ref) {
      const baseSha = normSha(p.pull_request.merge_commit_sha) ?? normSha(preflight?.resolvedBaseSha ?? null);
      if (baseSha) inspectBranchAdvance(p.pull_request.base.ref, baseSha, 'pull_request', 'base_advanced', prNumber);
      return events;
    }
    const livePr = preflight?.pullRequests?.[prNumber] ?? p.pull_request;
    const verified = verifiedOwnedOpenBotPr(store, repositoryId, prNumber, livePr);
    if (!verified) return [];
    if (!isPullRequestConflicted(livePr, 'pull_request', action, String(p.reason || ''))) return [];
    const liveComments = preflight?.comments?.[prNumber] as any[] | undefined;
    if (isConflictWakeSuppressed(store, repositoryId, verified, liveComments)) return [];
    const baseSha = normSha((livePr as any)?.base?.sha) ?? verified.baseSha ?? digest(`base:${verified.baseRef ?? 'main'}:${verified.headSha}`).slice(0, 40);
    const mergeableState = typeof (livePr as any)?.mergeable_state === 'string' ? String((livePr as any).mergeable_state) : 'dirty';
    events.push(
      buildConflictEventInput(
        store,
        repositoryId,
        'pull_request',
        action,
        actor,
        delivery,
        verified,
        baseSha,
        verified.baseRef,
        mergeableState,
        'pull_request',
        liveComments,
      ),
    );
    return events;
  }

  return [];
}

interface UnresolvedReviewSummary {
  id: string;
  author: string | null;
  author_type: string | null;
  commit_id: string | null;
  submitted_at: string;
  body_excerpt: string;
  url: string | null;
}

function collectUnresolvedChangesRequested(
  store: Store,
  repositoryId: string,
  verified: VerifiedBotPr,
  reviews: any[],
): UnresolvedReviewSummary[] {
  if (!Array.isArray(reviews) || !reviews.length) return [];
  const redactor = registeredRedactor(store);
  const { botIds, botLogins } = botIdentitySets(store, repositoryId, String(verified.owned.author_id));
  const ordered = [...reviews]
    .filter(r => r && typeof r === 'object')
    .sort((a, b) => {
      const ta = Date.parse(String(a.submitted_at || a.created_at || '')) || 0;
      const tb = Date.parse(String(b.submitted_at || b.created_at || '')) || 0;
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });

  const latestByReviewer = new Map<string, any>();
  for (const r of ordered) {
    const user = r.user;
    if (isOwnBotActor(botIds, botLogins, user?.id, user?.login, r.body)) continue;
    const reviewerKey = user?.id != null
      ? `id:${user.id}`
      : typeof user?.login === 'string' && user.login
        ? `login:${user.login.toLowerCase()}`
        : null;
    if (!reviewerKey) continue;
    const state = String(r.state || '').toUpperCase();
    if (state === 'CHANGES_REQUESTED') latestByReviewer.set(reviewerKey, r);
    else if (state === 'APPROVED' || state === 'DISMISSED') latestByReviewer.delete(reviewerKey);
    // COMMENTED / PENDING never dismisses an existing CHANGES_REQUESTED review.
  }

  const latestPrOpenedTask = store.get(
    `SELECT updated_at FROM tasks
     WHERE repository_id=? AND object_number=? AND status='pr_opened'
       AND (kind='development.pr' OR (kind='task.request' AND json_extract(input,'$.target.type')='pr'))
     ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    repositoryId,
    verified.number,
  );
  const latestPrOpenedAt = latestPrOpenedTask?.updated_at ? String(latestPrOpenedTask.updated_at) : null;

  const unresolved: UnresolvedReviewSummary[] = [];
  for (const r of latestByReviewer.values()) {
    const rid = String(r.id ?? '');
    const submittedAt = String(r.submitted_at || r.created_at || '');
    const commitId = normSha(r.commit_id);
    if (commitId && commitId !== verified.headSha) {
      const addressedReq = rid && store.hasTable('bot_pr_requests')
        ? store.get(
            "SELECT 1 FROM bot_pr_requests WHERE repository_id=? AND number=? AND source_id=? AND state='done'",
            repositoryId,
            verified.number,
            rid,
          )
        : undefined;
      if (addressedReq || (latestPrOpenedAt && submittedAt && isTimestampAfter(latestPrOpenedAt, submittedAt))) {
        continue;
      }
    }
    unresolved.push({
      id: rid,
      author: typeof r.user?.login === 'string' ? r.user.login : null,
      author_type: typeof r.user?.type === 'string' ? r.user.type : null,
      commit_id: commitId,
      submitted_at: submittedAt,
      body_excerpt: clip(r.body, 400),
      url: safeHttpUrl(r.html_url),
    });
  }
  return publicContent(unresolved.slice(-10), redactor);
}

interface PatrolFailedCheckSummary {
  source: 'workflow_run' | 'check_suite' | 'check_run';
  name: string;
  conclusion: string;
  workflow_run_id: number | null;
  check_suite_id: number | null;
  attempt: number;
  url: string | null;
  summary: string;
}

function summarizePatrolChecks(
  repoFullName: string,
  headSha: string,
  checkRuns: any[],
  checkSuites: any[],
): { checksPending: boolean; failedChecks: PatrolFailedCheckSummary[] } {
  const checksPending =
    checkRuns.some((cr: any) => String(cr?.status || '') !== 'completed')
    || checkSuites.some((cs: any) => String(cs?.status || '') !== 'completed');
  const seen = new Set<string>();
  const failed: PatrolFailedCheckSummary[] = [];
  for (const cr of checkRuns) {
    if (String(cr?.status || '') !== 'completed') continue;
    const conclusion = String(cr?.conclusion || '').toLowerCase();
    if (!FAILED_CONCLUSIONS.has(conclusion)) continue;
    const suiteId = Number.isSafeInteger(cr?.check_suite?.id) && cr.check_suite.id >= 1 ? Number(cr.check_suite.id) : null;
    const wfRunId = extractWorkflowRunIdFromUrl(cr?.details_url, cr?.html_url);
    const attempt = Number.isSafeInteger(cr?.run_attempt) && cr.run_attempt >= 1
      ? Number(cr.run_attempt)
      : Number.isSafeInteger(cr?.check_suite?.run_attempt) && cr.check_suite.run_attempt >= 1
        ? Number(cr.check_suite.run_attempt)
        : 1;
    const key = `${canonicalCheckGroup(wfRunId, suiteId, Number(cr?.id) || 0)}:${attempt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = clip(cr?.name || 'check_run', 160);
    const detail = [cr?.output?.title, cr?.output?.summary].filter(v => typeof v === 'string' && v.trim()).map(v => clip(v, 180)).join(' — ');
    failed.push({
      source: wfRunId ? 'workflow_run' : suiteId ? 'check_suite' : 'check_run',
      name,
      conclusion,
      workflow_run_id: wfRunId,
      check_suite_id: suiteId,
      attempt,
      url: safeHttpUrl(cr?.html_url || cr?.details_url) ?? (repoFullName ? `https://github.com/${repoFullName}/commit/${headSha}/checks` : null),
      summary: clip(detail ? `${name} (${conclusion}): ${detail}` : `${name} (${conclusion})`, 400),
    });
  }
  for (const cs of checkSuites) {
    if (String(cs?.status || '') !== 'completed') continue;
    const conclusion = String(cs?.conclusion || '').toLowerCase();
    if (!FAILED_CONCLUSIONS.has(conclusion)) continue;
    const suiteId = Number.isSafeInteger(cs?.id) && cs.id >= 1 ? Number(cs.id) : null;
    if (!suiteId) continue;
    const attempt = Number.isSafeInteger(cs?.run_attempt) && cs.run_attempt >= 1 ? Number(cs.run_attempt) : 1;
    const key = `suite:${suiteId}:${attempt}`;
    if (seen.has(key)) continue;
    if (failed.some(f => f.check_suite_id === suiteId && f.attempt === attempt)) continue;
    seen.add(key);
    const name = clip(cs?.app?.name || 'check_suite', 160);
    failed.push({
      source: 'check_suite',
      name,
      conclusion,
      workflow_run_id: null,
      check_suite_id: suiteId,
      attempt,
      url: safeHttpUrl(cs?.html_url) ?? (repoFullName ? `https://github.com/${repoFullName}/commit/${headSha}/checks` : null),
      summary: clip(`Check suite "${name}" (#${suiteId}, attempt ${attempt}) concluded with ${conclusion}.`, 400),
    });
  }
  return { checksPending, failedChecks: failed.slice(0, 15) };
}

interface LocalBotPrTaskSummary {
  id: string;
  kind: string;
  status: string;
  error_code: string | null;
  head_sha: string | null;
  result_status: string | null;
  summary: string;
  degraded_to_report: boolean;
  updated_at: string;
}

interface LocalBotPrInspection {
  hasActiveExecutingTask: boolean;
  stalledTasks: LocalBotPrTaskSummary[];
  lastPrTask: LocalBotPrTaskSummary | null;
  hasPriorObstacle: boolean;
}

function inspectLocalBotPrTasks(
  store: Store,
  repositoryId: string,
  verified: VerifiedBotPr,
  rootIssue: number | null,
  tKey: string,
  nowMs: number,
  stalledTaskAgeMs: number,
  envChanged: boolean,
  prevState: Row | undefined,
): LocalBotPrInspection {
  const redactor = registeredRedactor(store);
  const prTasks = store.all(
    `SELECT id,repository_id,kind,status,summary,head_sha,error_code,input,result,created_at,updated_at
     FROM tasks
     WHERE repository_id=? AND (
       (object_number=? AND (kind LIKE '%.pr' OR (kind='task.request' AND json_extract(input,'$.target.type')='pr')))
       OR id=?
     )
     ORDER BY updated_at DESC, rowid DESC LIMIT 10`,
    repositoryId,
    verified.number,
    String(verified.owned.source_task_id || ''),
  );
  const issueActiveTasks = rootIssue
    ? store.all(
        `SELECT id,repository_id,kind,status,summary,head_sha,error_code,input,result,created_at,updated_at
         FROM tasks
         WHERE repository_id=? AND object_number=?
           AND (kind='development.issue' OR (kind='task.request' AND json_extract(input,'$.target.type')='issue'
             AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=tasks.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request'))))
           AND status IN (${[...ACTIVE_EXECUTING_TASK_STATUSES, ...STALLABLE_WAITING_TASK_STATUSES].map(() => '?').join(',')})
         ORDER BY updated_at DESC, rowid DESC LIMIT 5`,
        repositoryId,
        rootIssue,
        ...ACTIVE_EXECUTING_TASK_STATUSES,
        ...STALLABLE_WAITING_TASK_STATUSES,
      )
    : [];

  const allTasks = [...prTasks, ...issueActiveTasks.filter(t => !prTasks.some(p => p.id === t.id))];
  const summarizeTask = (t: Row): LocalBotPrTaskSummary => {
    const parsedInput = parseJsonObject(t.input);
    const parsedResult = parseJsonObject(t.result);
    const writes = t.kind === 'task.request'
      ? taskPermissions(store, t).writes
      : String(t.kind).startsWith('development.')
        ? ['pull_request']
        : [];
    const expectedPrDelivery =
      String(t.kind).startsWith('development.')
      || writes.includes('pull_request')
      || parsedInput?.contract?.endpoint === 'reviewable_pull_request';
    const degradedToReport = Boolean(
      expectedPrDelivery
      && String(t.status) === 'completed'
      && (!parsedResult?.pr_url && !parsedResult?.sha || parsedResult?.status === 'no_changes' || parsedResult?.delivery === 'report'),
    );
    return publicContent(
      {
        id: String(t.id),
        kind: String(t.kind),
        status: String(t.status),
        error_code: t.error_code ? String(t.error_code) : null,
        head_sha: t.head_sha ? String(t.head_sha) : null,
        result_status: typeof parsedResult?.status === 'string' ? parsedResult.status : null,
        summary: clip(parsedResult?.summary ?? t.summary ?? '', 360),
        degraded_to_report: degradedToReport,
        updated_at: String(t.updated_at || t.created_at || ''),
      },
      redactor,
    );
  };

  let hasActiveExecutingTask = false;
  const stalledTasks: LocalBotPrTaskSummary[] = [];

  for (const t of allTasks) {
    const status = String(t.status || '');
    if (ACTIVE_EXECUTING_TASK_STATUSES.includes(status)) {
      hasActiveExecutingTask = true;
      continue;
    }
    if (STALLABLE_WAITING_TASK_STATUSES.includes(status)) {
      const updatedMs = Date.parse(String(t.updated_at || t.created_at || '')) || 0;
      const ageMs = updatedMs > 0 ? Math.max(0, nowMs - updatedMs) : stalledTaskAgeMs;
      const unblockedWait = envChanged && ['waiting_permission', 'waiting_environment', 'waiting_configuration'].includes(status);
      if (ageMs >= stalledTaskAgeMs || unblockedWait) {
        stalledTasks.push(summarizeTask(t));
      } else {
        hasActiveExecutingTask = true;
      }
    }
  }

  const lastPrTask = prTasks.length ? summarizeTask(prTasks[0]!) : null;
  const lastPrOpenedAt = prTasks.find(t => String(t.status) === 'pr_opened' && !t.error_code)?.updated_at
    ? String(prTasks.find(t => String(t.status) === 'pr_opened' && !t.error_code)!.updated_at)
    : null;

  let hadIgnoredObstacle = false;
  const recentDecisions = store.all(
    `SELECT type,decision,facts,refusals,created_at
     FROM dispatch_events
     WHERE repository_id=? AND thread_key=? AND state='decided'
       AND type IN ('pull_request.checks_failed','pull_request.conflicted','pull_request.patrol','pull_request.updated')
     ORDER BY created_at DESC, rowid DESC LIMIT 5`,
    repositoryId,
    tKey,
  );
  for (const ev of recentDecisions) {
    if (lastPrOpenedAt && ev.created_at && !isTimestampAfter(String(ev.created_at), lastPrOpenedAt)) continue;
    const evFacts = parseJsonObject(ev.facts);
    if (evFacts?.head_sha && normSha(evFacts.head_sha) !== verified.headSha) continue;
    const hasRefusals = (() => {
      try { const r = JSON.parse(String(ev.refusals || '[]')); return Array.isArray(r) && r.length > 0; } catch { return false; }
    })();
    if (hasRefusals || (String(ev.decision) === 'ignore' && ['pull_request.checks_failed', 'pull_request.conflicted', 'pull_request.patrol'].includes(String(ev.type)))) {
      hadIgnoredObstacle = true;
      break;
    }
  }

  const hasPriorObstacle = Boolean(
    stalledTasks.length > 0
    || (lastPrTask && (lastPrTask.status === 'failed' || Boolean(lastPrTask.error_code) || lastPrTask.degraded_to_report))
    || (prevState?.conflict_suppressed_head_sha && normSha(prevState.conflict_suppressed_head_sha) === verified.headSha)
    || hadIgnoredObstacle,
  );

  return {
    hasActiveExecutingTask,
    stalledTasks: stalledTasks.slice(0, 5),
    lastPrTask,
    hasPriorObstacle,
  };
}

function buildPatrolEventInput(
  store: Store,
  repositoryId: string,
  verified: VerifiedBotPr,
  pr: any,
  targetBranch: string,
  effectiveBaseSha: string | null,
  previousBaseSha: string | null,
  baseMoved: boolean,
  isConflicted: boolean,
  checksPending: boolean,
  failedChecks: PatrolFailedCheckSummary[],
  unresolvedChangesRequested: UnresolvedReviewSummary[],
  local: LocalBotPrInspection,
  currentEnv: PatrolEnvironmentSnapshot,
  changesSinceLastCheck: string[],
  environmentChanges: string[],
  prevState: Row | undefined,
  patrolConfig: BotPatrolConfig,
  nowMs: number,
  liveComments?: any[],
): EventInput {
  const redactor = registeredRedactor(store);
  const rootIssue = rootIssueOfBotPr(store, repositoryId, verified.number);
  const changesKey = [...changesSinceLastCheck].sort().join('+');
  const windowUnit = Math.max(1, Math.min(patrolConfig.cooldownMs, patrolConfig.intervalMs));
  const windowBucket = changesSinceLastCheck.includes('environment_or_policy_changed')
    ? `env:${currentEnv.fingerprint.slice(0, 12)}`
    : `w:${Math.floor(nowMs / windowUnit)}`;
  const eventKey = `${repositoryId}:pull_request.patrol:${verified.number}:${verified.headSha}:${effectiveBaseSha ?? 'nobase'}:${changesKey}:${windowBucket}`;

  const revisions = botPrWakeRevisionFacts(store, repositoryId, verified.number, liveComments);
  const patrolFacts = publicContent(
    {
      is_conflicted: isConflicted,
      mergeable: pr?.mergeable ?? null,
      mergeable_state: typeof pr?.mergeable_state === 'string' ? pr.mergeable_state : null,
      base_moved: baseMoved,
      previous_base_sha: previousBaseSha,
      current_base_sha: effectiveBaseSha,
      checks_pending: checksPending,
      failed_checks: failedChecks,
      unresolved_changes_requested: unresolvedChangesRequested,
      stalled_tasks: local.stalledTasks,
      last_pr_task: local.lastPrTask,
      previous_patrol_at: prevState?.last_patrol_at ? String(prevState.last_patrol_at) : null,
      previous_patrol_status: prevState?.patrol_status ? String(prevState.patrol_status) : null,
      environment_snapshot: currentEnv.summary,
    },
    redactor,
  );
  const wakeSummary = {
    type: 'pull_request.patrol',
    pr_number: verified.number,
    head_sha: verified.headSha,
    base_sha: effectiveBaseSha,
    base_ref: targetBranch,
    is_conflicted: isConflicted,
    changes_since_last_check: changesSinceLastCheck,
    environment_changes: environmentChanges,
    failed_checks: failedChecks,
    unresolved_changes_requested: unresolvedChangesRequested,
  };
  const labelMap: Record<string, string> = {
    environment_or_policy_changed: '环境或权限变化',
    base_moved: '基线前进',
    conflicted: '存在合并冲突',
    checks_failed: '检查失败',
    unresolved_changes_requested: '未解决的变更请求',
    stalled_task: '任务长期停滞',
  };
  const summaryTags = changesSinceLastCheck.map(c => labelMap[c] ?? c).join('、');

  const options: CreateOption[] = [
    {
      id: 'development',
      work: 'development.pr',
      title: `复核并继续推进 bot PR #${verified.number}`,
      default: false,
      spec: {
        type: 'object',
        kind: 'development.pr',
        number: verified.number,
        head: verified.headSha,
        input: {
          revision: { source: 'patrol' },
          ...(isConflicted && effectiveBaseSha ? { conflict_base_sha: effectiveBaseSha, conflict_base_ref: targetBranch } : {}),
          wake_event: wakeSummary,
        },
        delivery: null,
      },
    },
    {
      id: 'reply',
      work: 'reply',
      title: `通用回复 #${verified.number}`,
      default: false,
      spec: {
        type: 'reply',
        kind: 'workflow.pr',
        number: verified.number,
        head: verified.headSha,
        input: { pull_request: verified.prObject, wake_event: wakeSummary },
        key: `patrol:${verified.headSha}:${windowBucket}`,
        delivery: null,
      },
    },
  ];

  const trigger = {
    event: 'bot_pr_patrol',
    action: 'recheck',
    reason: 'pull_request.patrol',
    pr_number: verified.number,
    head_sha: verified.headSha,
    base_ref: targetBranch,
    base_sha: effectiveBaseSha,
    changes_since_last_check: changesSinceLastCheck,
    environment_changes: environmentChanges,
    url: verified.htmlUrl,
    summary: `Internal patrol recheck for bot PR #${verified.number}: ${changesSinceLastCheck.join(', ')}`,
  };

  return {
    repositoryId,
    key: eventKey,
    type: 'pull_request.patrol',
    source: 'control_plane',
    summary: `bot PR 内部巡检：#${verified.number}（${summaryTags}）`,
    object: { type: 'pr', number: verified.number },
    delivery: null,
    facts: {
      event: 'bot_pr_patrol',
      action: 'recheck',
      bot_pull_request: true,
      internal_patrol: true,
      no_external_notifications: true,
      pr_number: verified.number,
      head_sha: verified.headSha,
      base_sha: effectiveBaseSha,
      base_ref: targetBranch,
      root_issue_number: rootIssue,
      object: objectFacts({ ...verified.prObject, base: { ref: targetBranch, sha: effectiveBaseSha } }),
      changes_since_last_check: changesSinceLastCheck,
      environment_changes: environmentChanges,
      patrol: patrolFacts,
      revisions,
    },
    options,
    merge: {
      key: eventKey,
      data: {
        reason: 'pull_request.patrol',
        wake_type: 'pull_request.patrol',
        pr_number: verified.number,
        head_sha: verified.headSha,
        base_sha: effectiveBaseSha,
        base_ref: targetBranch,
        is_conflicted: isConflicted,
        changes_since_last_check: changesSinceLastCheck,
        environment_changes: environmentChanges,
        url: verified.htmlUrl,
      },
      trigger,
      head: verified.headSha,
      kinds: ['development.pr'],
    },
  };
}

function savePatrolState(
  store: Store,
  repositoryId: string,
  prNumber: number,
  nowIso: string,
  eventRecorded: boolean,
  currentEnv: PatrolEnvironmentSnapshot,
  headSha: string,
  baseSha: string | null,
  status: string,
): void {
  store.run(
    `UPDATE bot_pr_states
     SET last_patrol_at=?,
         last_patrol_event_at=CASE WHEN ? THEN ? ELSE last_patrol_event_at END,
         patrol_env_fingerprint=?,
         patrol_env_summary=?,
         patrol_head_sha=?,
         patrol_base_sha=coalesce(?,patrol_base_sha),
         patrol_status=?
     WHERE repository_id=? AND number=?`,
    nowIso,
    eventRecorded ? 1 : 0,
    nowIso,
    currentEnv.fingerprint,
    JSON.stringify(currentEnv.summary),
    headSha,
    baseSha,
    status,
    repositoryId,
    prNumber,
  );
}

interface ReconcileOptions {
  patrol?: Partial<BotPatrolConfig>;
  forcePatrol?: boolean;
}

// What one read of a bot PR saw: a digest of the PR fields the reconcile acts on, and one of its head commit's check suites.
interface BotPrSnapshot {
  pr: string;
  checks: string;
  headSha: string | null;
  baseRef: string | null;
  baseTip: string | null;
  // Completed check suites on the head that did not pass: failed, timed out, never started (startup_failure, which has
  // no check run), or cancelled or awaiting action after some of their check runs failed.
  unpassedSuites: number;
}

const snapshotDigest = (value: unknown) => digest(JSON.stringify(value)).slice(0, 24);
const checksDigest = (headSha: string | null, total: unknown, suites: Array<[unknown, unknown, unknown]>) =>
  snapshotDigest([headSha, Number(total) || suites.length, suites.map(([id, status, conclusion]) =>
    `${Number(id) || 0}:${String(status ?? '').toLowerCase()}:${String(conclusion ?? '').toLowerCase()}`).sort()]);

const PASSED_SUITE_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const BOT_PR_FIELDS = 'number state isDraft mergeable updatedAt headRefName headRefOid baseRefName baseRefOid baseRef{target{oid}} '
  + 'commits(last:1){nodes{commit{oid checkSuites(first:100){totalCount nodes{databaseId status conclusion}}}}}';

/**
 * Reads the given bot PRs of one repository with GraphQL, 50 to a query: state, draft, mergeability, head, base and the
 * base branch's tip, updated_at, and the head commit's check suites. A PR GitHub does not find maps to null. Returns null
 * when GraphQL cannot answer (the caller then reads each PR over REST) and rateLimited when its window is used up.
 */
async function readBotPrSnapshots(github: GitHub, numbers: number[]): Promise<{ snapshots: Map<number, BotPrSnapshot | null> | null; rateLimited: boolean }> {
  const [owner, name] = String(github.fullName || '').split('/');
  if (!owner || !name) return { snapshots: null, rateLimited: false };
  const snapshots = new Map<number, BotPrSnapshot | null>();
  for (let i = 0; i < numbers.length; i += RECONCILE_BATCH) {
    const chunk = numbers.slice(i, i + RECONCILE_BATCH);
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${chunk.map(n => `p${n}:pullRequest(number:${n}){...BotPr}`).join(' ')}}}`
      + ` fragment BotPr on PullRequest{${BOT_PR_FIELDS}}`;
    let value: any;
    try {
      value = await github.request('POST', '/graphql', { query, variables: { owner, name } });
    } catch (err: any) {
      return { snapshots: null, rateLimited: err?.code === 'github_rate_limited' };
    }
    const errors: any[] = Array.isArray(value?.errors) ? value.errors : [];
    if (errors.some(e => String(e?.type) === 'RATE_LIMITED')) return { snapshots: null, rateLimited: true };
    // Only "no such pull request" (repository.pN) leaves the rest of the answer usable; any other error falls back to REST.
    const notFound = (e: any) => String(e?.type) === 'NOT_FOUND' && Array.isArray(e?.path) && e.path.length === 2;
    const repository = value?.data?.repository;
    if (!repository || typeof repository !== 'object' || !errors.every(notFound)) return { snapshots: null, rateLimited: false };
    for (const n of chunk) {
      const node = repository[`p${n}`];
      if (!node || typeof node !== 'object') { snapshots.set(n, null); continue; }
      const commit = node.commits?.nodes?.[0]?.commit;
      const suites: any[] = Array.isArray(commit?.checkSuites?.nodes) ? commit.checkSuites.nodes.filter(Boolean) : [];
      const headSha = normSha(node.headRefOid);
      const baseTip = normSha(node.baseRef?.target?.oid);
      const baseRef = typeof node.baseRefName === 'string' && node.baseRefName ? node.baseRefName : null;
      snapshots.set(n, {
        pr: snapshotDigest(['graphql', node.state, node.isDraft === true, node.mergeable ?? null, node.headRefName ?? null, headSha, baseRef, normSha(node.baseRefOid), baseTip, node.updatedAt ?? null]),
        checks: checksDigest(normSha(commit?.oid), commit?.checkSuites?.totalCount, suites.map(s => [s.databaseId, s.status, s.conclusion])),
        headSha,
        baseRef,
        baseTip,
        unpassedSuites: suites.filter(s => String(s.status) === 'COMPLETED' && !PASSED_SUITE_CONCLUSIONS.has(String(s.conclusion || ''))).length,
      });
    }
  }
  return { snapshots, rateLimited: false };
}

/** Whether the fallback reconcile reads this open bot PR now (row: its bot_pr_states schedule columns). */
function botPrReconcileDue(row: Row, nowMs: number, localEnv: string, patrol: BotPatrolConfig): boolean {
  const last = Number(row.reconcile_at) || 0;
  if (last && nowMs - last < BOT_PR_RECONCILE_MIN_MS) return false;
  if (row.reconcile_due_at == null || Number(row.reconcile_due_at) <= nowMs) return true;
  // A change to the project's policy, roles, installation permissions or computer can unblock a PR (#1316).
  if (row.reconcile_env && String(row.reconcile_env) !== localEnv) return true;
  // The patrol's own interval: once per interval, even when the PR's schedule has grown past it.
  if (patrol.intervalMs > 0) {
    const lastPatrol = row.last_patrol_at ? Date.parse(String(row.last_patrol_at)) : NaN;
    const patrolDueAt = Number.isFinite(lastPatrol) ? lastPatrol + patrol.intervalMs : 0;
    if (patrolDueAt <= nowMs && last < patrolDueAt) return true;
  }
  return false;
}

/**
 * Records one read of a bot PR and schedules the next: 5 minutes after a change, otherwise twice the previous interval up to
 * 4 hours. A webhook that marked the PR while it was being read (its due time no longer what the read started from) wins.
 */
function saveBotPrReconcile(store: Store, repositoryId: string, prNumber: number, nowMs: number, fingerprint: string, previous: Row, localEnv: string): void {
  const changed = fingerprint !== (previous.reconcile_fingerprint == null ? null : String(previous.reconcile_fingerprint));
  const prior = Number(previous.reconcile_interval_ms) || 0;
  const interval = changed || !prior ? BOT_PR_RECONCILE_MIN_MS : Math.min(BOT_PR_RECONCILE_MAX_MS, Math.max(BOT_PR_RECONCILE_MIN_MS, prior * 2));
  const readDue = previous.reconcile_due_at == null ? null : Number(previous.reconcile_due_at);
  store.run(
    `INSERT INTO bot_pr_states(repository_id,number,updated_at,reconcile_at,reconcile_due_at,reconcile_interval_ms,reconcile_fingerprint,reconcile_env)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(repository_id,number) DO UPDATE SET
       reconcile_at=excluded.reconcile_at,
       reconcile_due_at=CASE WHEN bot_pr_states.reconcile_due_at IS NOT ? THEN ? ELSE excluded.reconcile_due_at END,
       reconcile_interval_ms=CASE WHEN bot_pr_states.reconcile_due_at IS NOT ? THEN ? ELSE excluded.reconcile_interval_ms END,
       reconcile_fingerprint=excluded.reconcile_fingerprint,
       reconcile_env=excluded.reconcile_env`,
    repositoryId,
    prNumber,
    new Date(nowMs).toISOString(),
    nowMs,
    nowMs + interval,
    interval,
    fingerprint,
    localEnv,
    readDue,
    nowMs + BOT_PR_RECONCILE_MIN_MS,
    readDue,
    BOT_PR_RECONCILE_MIN_MS,
  );
}

async function reconcileOpenBotPullRequestsForRepo(
  store: Store,
  repo: Row,
  apiUrl?: string,
  deliveryId: string | null = null,
  onlyPrNumbers?: number[],
  options?: ReconcileOptions,
): Promise<void> {
  const repositoryId = String(repo.id);
  const repoFullName = String(repo.full_name || '');
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  if (!policy?.enabled || !covers(projectCeiling(store, repositoryId, policy), 'comment')) return;
  if (!store.hasTable('bot_pull_requests')) return;
  if (!store.hasTable('bot_pr_states')) botPrWakeStorage(store);

  const patrolConfig = resolvePatrolConfig(options?.patrol);
  const nowMs = patrolConfig.now();
  const nowIso = new Date(nowMs).toISOString();

  const prFilter = Array.isArray(onlyPrNumbers)
    ? [...new Set(onlyPrNumbers.filter(n => Number.isSafeInteger(n) && n > 0))]
    : null;
  if (prFilter && !prFilter.length) return;
  // Every open bot PR is a candidate (#1396 removed the newest-25 cap). A webhook-driven recheck (prFilter) reads its
  // PRs over REST at once; the scheduled reconcile reads only the PRs that are due, and connects only when one is.
  const allCandidates = store.all(
    `SELECT b.number, s.base_sha AS prev_base_sha, s.reconcile_at, s.reconcile_due_at, s.reconcile_interval_ms,
            s.reconcile_fingerprint, s.reconcile_env, s.last_patrol_at
     FROM bot_pull_requests b
     LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
     WHERE b.repository_id=? AND coalesce(s.state,'open')<>'closed'
       ${prFilter ? `AND b.number IN (${prFilter.map(() => '?').join(',')})` : ''}
     ORDER BY b.number DESC`,
    repositoryId,
    ...(prFilter ?? []),
  );
  const scheduled = !prFilter;
  const localEnv = scheduled ? computePatrolEnvironmentSnapshot(store, repositoryId, undefined, patrolConfig.capabilityVersion).fingerprint : '';
  const candidates = scheduled && !options?.forcePatrol
    ? allCandidates.filter(row => botPrReconcileDue(row, nowMs, localEnv, patrolConfig))
    : allCandidates;
  if (!candidates.length) return;

  const redactor = registeredRedactor(store);
  const github = new GitHub(store, repo, redactor, async () => {}, apiUrl);
  try {
    await github.connect(false, undefined, { contents: 'read', pull_requests: 'read', issues: 'read', checks: 'read', actions: 'read' }, false);
    const currentEnv = computePatrolEnvironmentSnapshot(store, repositoryId, github.installationPermissions, patrolConfig.capabilityVersion);
    const branchHeads = new Map<string, string | null>();
    let rateLimited = false;
    const guardRequest = <T>(p: Promise<T>): Promise<T | null> =>
      p.catch((err: any) => {
        if (err?.code === 'github_rate_limited') rateLimited = true;
        return null;
      });
    const readBranchHead = async (branch: string) => {
      if (branchHeads.has(branch)) return branchHeads.get(branch)!;
      const refObj = await guardRequest(github.ref(branch));
      const sha = normSha(refObj?.object?.sha);
      branchHeads.set(branch, sha);
      return sha;
    };

    // One GraphQL read of all due PRs says which of them changed since the last read; only those (and PRs whose patrol
    // is due) are read in detail over REST. Without a GraphQL answer every due PR is read over REST, as before #1396.
    let snapshots: Map<number, BotPrSnapshot | null> | null = null;
    if (scheduled) {
      const batch = await readBotPrSnapshots(github, candidates.map(row => Number(row.number)));
      if (batch.rateLimited) return;
      snapshots = batch.snapshots;
      for (const s of snapshots?.values() ?? []) if (s?.baseRef && s.baseTip && !branchHeads.has(s.baseRef)) branchHeads.set(s.baseRef, s.baseTip);
    }

    for (const row of candidates) {
      if (!store.db.open || rateLimited) break;
      const prNumber = Number(row.number);
      const prevState = store.get('SELECT * FROM bot_pr_states WHERE repository_id=? AND number=?', repositoryId, prNumber);
      const snapshot = snapshots?.get(prNumber);
      // What this read saw; null until known (a REST read fills it in), saved with the next schedule when the read ends.
      let seen: string | null = snapshot ? `${snapshot.pr}:${snapshot.checks}` : snapshot === null ? 'missing' : null;
      const checksSeenBefore = String(row.reconcile_fingerprint ?? '').split(':')[1] ?? null;
      try {
        const prevEnvFp = prevState?.patrol_env_fingerprint ? String(prevState.patrol_env_fingerprint) : null;
        const envChangedFromPatrol = Boolean(prevEnvFp && prevEnvFp !== currentEnv.fingerprint);
        const patrolEnabled = patrolConfig.intervalMs > 0 && (!prFilter || Boolean(options?.forcePatrol));
        const lastPatrolMs = prevState?.last_patrol_at ? Date.parse(String(prevState.last_patrol_at)) : 0;
        const patrolDueFor = (envChanged: boolean) => patrolEnabled && (
          Boolean(options?.forcePatrol)
          || envChanged
          || !lastPatrolMs
          || !Number.isFinite(lastPatrolMs)
          || (nowMs - lastPatrolMs) >= patrolConfig.intervalMs
        );
        const suppressionEnvChanged = (headSha: string | null) => Boolean(
          prevState?.conflict_suppressed_head_sha
          && normSha(prevState.conflict_suppressed_head_sha) === headSha
          && prevState?.conflict_suppressed_env
          && String(prevState.conflict_suppressed_env) !== currentEnv.fingerprint,
        );
        // GitHub has no such pull request, or reports nothing new since the last read and the patrol is not due:
        // there is nothing to act on, so nothing is read over REST.
        if (snapshot === null) continue;
        if (snapshot && seen === row.reconcile_fingerprint
          && !patrolDueFor(envChangedFromPatrol || suppressionEnvChanged(snapshot.headSha))) continue;

        const pr = await guardRequest(github.request('GET', github.path(`/pulls/${prNumber}`), undefined, true));
        // A change GitHub reported but that could not be read in detail stays a change: it is read again at the next pass.
        if (!pr || typeof pr !== 'object') seen = null;
        if (!pr || typeof pr !== 'object' || !store.db.open || rateLimited) continue;
        if (!snapshot) seen = `${snapshotDigest(['rest', pr.state, pr.draft === true, pr.mergeable ?? null, pr.head?.ref ?? null, normSha(pr.head?.sha), pr.base?.ref ?? null, normSha(pr.base?.sha), pr.updated_at ?? null])}:unread`;
        syncBotPullRequestState(store, repositoryId, pr, nowIso);
        if (pr.state !== 'open' || pr.draft === true) continue;
        const verified = verifiedOwnedOpenBotPr(store, repositoryId, prNumber, pr);
        if (!verified) continue;

        const targetBranch = verified.baseRef ?? github.defaultBranch ?? 'main';
        const liveBranchSha = await readBranchHead(targetBranch);
        if (rateLimited) break;
        const effectiveBaseSha = liveBranchSha ?? normSha(pr.base?.sha) ?? verified.baseSha;

        const suppressedOnSameHead = Boolean(
          prevState?.conflict_suppressed_head_sha
          && normSha(prevState.conflict_suppressed_head_sha) === verified.headSha,
        );
        const envChangedFromSuppression = suppressionEnvChanged(verified.headSha);
        const envChanged = envChangedFromPatrol || envChangedFromSuppression;
        const patrolDue = patrolDueFor(envChanged);

        let cachedComments: any[] | undefined;
        const isConflicted = isPullRequestConflicted(pr, 'pull_request', '');
        if (isConflicted) {
          const suppressedFast = suppressedOnSameHead
            && (
              (envChangedFromSuppression && patrolEnabled)
              || isConflictWakeSuppressed(store, repositoryId, verified, undefined, currentEnv.fingerprint)
            );
          if (!suppressedFast && effectiveBaseSha && !store.get('SELECT 1 FROM dispatch_events WHERE event_key=?', conflictEventKey(repositoryId, prNumber, verified.headSha, effectiveBaseSha))) {
            cachedComments = (await guardRequest(github.pages(github.path(`/issues/${prNumber}/comments`)))) ?? [];
            if (rateLimited) break;
            if (!isConflictWakeSuppressed(store, repositoryId, verified, cachedComments, currentEnv.fingerprint)) {
              const ev = buildConflictEventInput(
                store,
                repositoryId,
                'pull_request',
                'reconciled',
                '',
                deliveryId,
                verified,
                effectiveBaseSha,
                targetBranch,
                typeof pr.mergeable_state === 'string' ? pr.mergeable_state : 'dirty',
                'reconcile',
                cachedComments,
                currentEnv,
              );
              store.transaction(() => recordEvent(store, ev));
            }
          }
        } else if (pr.mergeable === null && effectiveBaseSha && effectiveBaseSha !== normSha(row.prev_base_sha)) {
          scheduleMergeableRecheck(store, repo, [prNumber], targetBranch, effectiveBaseSha, apiUrl, deliveryId);
        }

        let fetchedCheckRuns: any[] | null = null;
        let fetchedCheckSuites: any[] | null = null;

        // The check runs and suites are read over REST only when GraphQL showed a completed suite on the head that did not
        // pass and that it had not shown in the same state before (or could not answer, or this is a webhook-driven recheck).
        const readChecks = !snapshot || (snapshot.unpassedSuites > 0 && snapshot.checks !== checksSeenBefore);
        if (readChecks) {
          // Reconcile completed failed check suites on `verified.headSha` without requiring `check_suite` or `workflow_run` webhooks
          // (including `startup_failure` check suites that fail before creating any `check_run`).
          const [runsRes, suitesRes] = await Promise.all([
            guardRequest(github.request('GET', github.path(`/commits/${verified.headSha}/check-runs?filter=latest&per_page=100`), undefined, true)),
            guardRequest(github.request('GET', github.path(`/commits/${verified.headSha}/check-suites?per_page=100`), undefined, true)),
          ]);
          if (rateLimited) break;
          const checkRuns = Array.isArray(runsRes?.check_runs) ? runsRes.check_runs : [];
          const checkSuites = Array.isArray(suitesRes?.check_suites) ? suitesRes.check_suites : [];
          fetchedCheckRuns = checkRuns;
          fetchedCheckSuites = checkSuites;
          if (!snapshot && suitesRes) seen = `${String(seen).split(':')[0]}:${checksDigest(verified.headSha, checkSuites.length, checkSuites.map((cs: any) => [cs?.id, cs?.status, cs?.conclusion]))}`;
          // Checks that could not be read are read again at the next pass, as a change.
          if (snapshot && (!runsRes || !suitesRes)) seen = `${snapshot.pr}:unread`;
          if (checkRuns.length || checkSuites.length) {
            const byGroup = new Map<string, { suiteId: number | null; wfRunId: number | null; attempt: number; runs: any[] }>();
            const coveredSuiteAttempts = new Set<string>();
            for (const cr of checkRuns) {
              const suiteId = Number.isSafeInteger(cr?.check_suite?.id) && cr.check_suite.id >= 1 ? Number(cr.check_suite.id) : null;
              const wfRunId = extractWorkflowRunIdFromUrl(cr?.details_url, cr?.html_url);
              const attempt = Number.isSafeInteger(cr?.run_attempt) && cr.run_attempt >= 1
                ? Number(cr.run_attempt)
                : Number.isSafeInteger(cr?.check_suite?.run_attempt) && cr.check_suite.run_attempt >= 1
                  ? Number(cr.check_suite.run_attempt)
                  : 1;
              if (suiteId) coveredSuiteAttempts.add(`${suiteId}:${attempt}`);
              const key = canonicalCheckGroup(wfRunId, suiteId, Number(cr?.id) || 0) + ':' + attempt;
              const entry = byGroup.get(key) ?? { suiteId, wfRunId, attempt, runs: [] };
              if (!entry.wfRunId && wfRunId) entry.wfRunId = wfRunId;
              if (!entry.suiteId && suiteId) entry.suiteId = suiteId;
              entry.runs.push(cr);
              byGroup.set(key, entry);
            }

            for (const group of byGroup.values()) {
              if (group.runs.some(cr => String(cr?.status || 'completed') !== 'completed')) continue;
              const failedRuns = group.runs.filter(cr => FAILED_CONCLUSIONS.has(String(cr?.conclusion || '').toLowerCase()));
              if (!failedRuns.length) {
                if (group.suiteId) pendingSuiteFlushes.delete(`${repositoryId}:suite:${group.suiteId}:${group.attempt}`);
                if (group.wfRunId) pendingSuiteFlushes.delete(`${repositoryId}:run:${group.wfRunId}:${group.attempt}`);
                continue;
              }
              const first = failedRuns[0]!;
              let workflowName = typeof first.app?.name === 'string' ? first.app.name : null;
              let workflowUrl = safeHttpUrl(first.html_url || first.details_url) ?? (repoFullName ? `https://github.com/${repoFullName}/commit/${verified.headSha}/checks` : null);
              if (group.wfRunId) {
                const runObj = await github.request('GET', github.path(`/actions/runs/${group.wfRunId}`), undefined, true).catch(() => null);
                if (typeof runObj?.name === 'string' && runObj.name.trim()) workflowName = runObj.name.trim();
                if (safeHttpUrl(runObj?.html_url)) workflowUrl = safeHttpUrl(runObj.html_url);
                if (!group.suiteId && Number.isSafeInteger(runObj?.check_suite_id) && runObj.check_suite_id >= 1) group.suiteId = Number(runObj.check_suite_id);
              }
              const displayName = failedRuns.length === 1 ? String(first.name || workflowName || 'check_run') : (workflowName || String(first.name || 'check_suite'));
              const parsed: ParsedFailedCheck = {
                source: group.wfRunId ? 'workflow_run' : group.suiteId ? 'check_suite' : 'check_run',
                headSha: verified.headSha,
                headBranch: verified.headRef,
                runOrSuiteId: canonicalRunOrSuiteId(group.wfRunId, group.suiteId, Number(first.id) || null),
                canonicalGroup: canonicalCheckGroup(group.wfRunId, group.suiteId, Number(first.id) || null),
                workflowRunId: group.wfRunId,
                checkSuiteId: group.suiteId,
                checkRunId: failedRuns.length === 1 ? (Number(first.id) || null) : null,
                attempt: group.attempt,
                conclusion: String(first.conclusion || 'failure').toLowerCase(),
                name: displayName,
                workflowName,
                url: workflowUrl,
                summary: clip(`Checks "${displayName}" completed with ${failedRuns.length} failed job(s) on attempt ${group.attempt}.`, 1500),
                pullRequests: [{ number: prNumber }],
              };
              if (group.suiteId) pendingSuiteFlushes.delete(`${repositoryId}:suite:${group.suiteId}:${group.attempt}`);
              if (group.wfRunId) pendingSuiteFlushes.delete(`${repositoryId}:run:${group.wfRunId}:${group.attempt}`);
              if (hasRecordedCheckFailure(store, repositoryId, prNumber, parsed)) continue;
              cachedComments ??= (await guardRequest(github.pages(github.path(`/issues/${prNumber}/comments`)))) ?? [];
              const failedJobs = failedRuns.slice(0, 15).map(summarizeFailedCheckRun);
              const ev = buildCheckFailedEventInput(store, repositoryId, parsed.source, 'completed', '', deliveryId, verified, parsed, failedJobs, cachedComments);
              store.transaction(() => recordEvent(store, ev));
            }

            for (const cs of checkSuites) {
              const suiteId = Number.isSafeInteger(cs?.id) && cs.id >= 1 ? Number(cs.id) : null;
              if (!suiteId || String(cs?.status || '') !== 'completed') continue;
              const conclusion = String(cs?.conclusion || '').toLowerCase();
              if (!FAILED_CONCLUSIONS.has(conclusion)) continue;
              const attempt = Number.isSafeInteger(cs?.run_attempt) && cs.run_attempt >= 1 ? Number(cs.run_attempt) : 1;
              if (coveredSuiteAttempts.has(`${suiteId}:${attempt}`)) continue;
              const appName = typeof cs?.app?.name === 'string' && cs.app.name.trim() ? cs.app.name.trim() : 'check_suite';
              const suiteUrl = safeHttpUrl(cs?.html_url) ?? (repoFullName ? `https://github.com/${repoFullName}/commit/${verified.headSha}/checks` : null);
              const parsed: ParsedFailedCheck = {
                source: 'check_suite',
                headSha: verified.headSha,
                headBranch: verified.headRef,
                runOrSuiteId: String(suiteId),
                canonicalGroup: `suite:${suiteId}`,
                workflowRunId: null,
                checkSuiteId: suiteId,
                checkRunId: null,
                attempt,
                conclusion,
                name: appName,
                workflowName: appName,
                url: suiteUrl,
                summary: clip(`Check suite "${appName}" (#${suiteId}, attempt ${attempt}) concluded with ${conclusion}.`, 1500),
                pullRequests: [{ number: prNumber }],
              };
              if (hasRecordedCheckFailure(store, repositoryId, prNumber, parsed)) continue;
              cachedComments ??= (await guardRequest(github.pages(github.path(`/issues/${prNumber}/comments`)))) ?? [];
              const ev = buildCheckFailedEventInput(store, repositoryId, 'check_suite', 'completed', '', deliveryId, verified, parsed, [], cachedComments);
              store.transaction(() => recordEvent(store, ev));
            }
          }
        }

        if (!patrolDue || rateLimited || !store.db.open) continue;

        // Low-frequency internal open-PR patrol (strictly internal to control plane; zero external chat/notification triggers).
        try {
          const rootIssue = rootIssueOfBotPr(store, repositoryId, prNumber);
          const tKey = threadKey(store, {
            repository_id: repositoryId,
            object_type: 'pr',
            object_number: prNumber,
            source: 'control_plane',
            type: 'pull_request.patrol',
          });
          const hasPendingEvent = Boolean(
            store.get(
              // thread_key alone: it already carries the repository id, and adding repository_id scans the repository's events (#1350).
              "SELECT 1 FROM dispatch_events WHERE thread_key=? AND state IN ('pending','dispatching') LIMIT 1",
              tKey,
            ),
          );
          if (hasPendingEvent) continue;

          const local = inspectLocalBotPrTasks(
            store,
            repositoryId,
            verified,
            rootIssue,
            tKey,
            nowMs,
            patrolConfig.stalledTaskAgeMs,
            envChanged,
            prevState,
          );
          if (local.hasActiveExecutingTask) continue;

          if (fetchedCheckRuns === null || fetchedCheckSuites === null) {
            const [runsRes, suitesRes] = await Promise.all([
              guardRequest(github.request('GET', github.path(`/commits/${verified.headSha}/check-runs?filter=latest&per_page=100`), undefined, true)),
              guardRequest(github.request('GET', github.path(`/commits/${verified.headSha}/check-suites?per_page=100`), undefined, true)),
            ]);
            if (rateLimited) break;
            fetchedCheckRuns = Array.isArray(runsRes?.check_runs) ? runsRes.check_runs : [];
            fetchedCheckSuites = Array.isArray(suitesRes?.check_suites) ? suitesRes.check_suites : [];
          }
          const { checksPending, failedChecks } = summarizePatrolChecks(repoFullName, verified.headSha, fetchedCheckRuns ?? [], fetchedCheckSuites ?? []);

          const reviews = (await guardRequest(github.pages(github.path(`/pulls/${prNumber}/reviews`)))) ?? [];
          if (rateLimited) break;
          const unresolvedChangesRequested = collectUnresolvedChangesRequested(store, repositoryId, verified, reviews);

          if (isConflicted && suppressedOnSameHead && cachedComments === undefined) {
            cachedComments = (await guardRequest(github.pages(github.path(`/issues/${prNumber}/comments`)))) ?? [];
            if (rateLimited) break;
          }
          const suppressedDirty = isConflicted && isConflictWakeSuppressed(store, repositoryId, verified, cachedComments, currentEnv.fingerprint);

          const prevEnvSummary = parseJsonObject(prevState?.patrol_env_summary) as PatrolEnvironmentSummary | null;
          const envDiffs = envChanged ? diffPatrolEnvironments(prevEnvSummary, currentEnv.summary) : [];
          if (envChanged && !envDiffs.length) envDiffs.push('environment_or_policy_fingerprint changed since previous check');
          const legacyNotes: string[] = [];
          if (!prevEnvFp && local.lastPrTask) {
            if (local.lastPrTask.error_code && LEGACY_RETIRED_BLOCKER_CODES.has(local.lastPrTask.error_code)) {
              legacyNotes.push(`control_plane: legacy blocker ${local.lastPrTask.error_code} is retired in ${currentEnv.summary.control_plane.capability_version}; bot PR delivery now supports workflow changes`);
            }
            if (local.lastPrTask.error_code === 'github_workflows_permission_missing' && currentEnv.summary.installation.permissions.workflows === 'write') {
              legacyNotes.push('installation.permissions.workflows: now write (previously github_workflows_permission_missing)');
            }
            if (local.lastPrTask.error_code === 'capability_ceiling_lowered' && covers(currentEnv.summary.policy.capability_ceiling as any, 'develop')) {
              legacyNotes.push('policy.capability_ceiling: now develop (previously capability_ceiling_lowered)');
            }
            if (local.lastPrTask.error_code === 'environment_not_ready' && currentEnv.summary.environment.availability === 'available') {
              legacyNotes.push('environment.availability: now available (previously environment_not_ready)');
            }
            if (local.lastPrTask.degraded_to_report) {
              legacyNotes.push('previous pull_request revision task degraded to report without updating PR; re-evaluating under current capabilities');
            }
          }

          const hasAnyObstacle = local.hasPriorObstacle || isConflicted || failedChecks.length > 0 || unresolvedChangesRequested.length > 0;
          const effectiveEnvChanged = (envChanged && hasAnyObstacle) || legacyNotes.length > 0;
          const environmentChanges = [...envDiffs, ...legacyNotes];
          const prevPatrolBaseSha = normSha(prevState?.patrol_base_sha) ?? normSha(prevState?.base_sha);
          const baseMoved = Boolean(effectiveBaseSha && prevPatrolBaseSha && effectiveBaseSha !== prevPatrolBaseSha);

          const lastEventAtMs = prevState?.last_patrol_event_at ? Date.parse(String(prevState.last_patrol_event_at)) : 0;
          const inCooldown = Number.isFinite(lastEventAtMs) && lastEventAtMs > 0 && (nowMs - lastEventAtMs) < patrolConfig.cooldownMs;
          const suppressedRefMs = Math.max(
            Number.isFinite(lastEventAtMs) ? lastEventAtMs : 0,
            prevState?.conflict_suppressed_at ? (Date.parse(String(prevState.conflict_suppressed_at)) || 0) : 0,
          );
          const inSuppressedDirtyCooldown = suppressedDirty && suppressedRefMs > 0 && (nowMs - suppressedRefMs) < patrolConfig.suppressedDirtyCooldownMs;
          const humanBrokeSuppression = suppressedOnSameHead && !envChangedFromSuppression && !suppressedDirty;

          const wakeForEnv = effectiveEnvChanged;
          const wakeForConflict = isConflicted && (suppressedDirty ? (!inSuppressedDirtyCooldown && baseMoved) : (humanBrokeSuppression || !inCooldown));
          const wakeForChecksAfterBase = failedChecks.length > 0 && !checksPending && baseMoved && !inCooldown;
          const wakeForUnresolvedReview = unresolvedChangesRequested.length > 0 && !inCooldown;
          const wakeForStalledTask = local.stalledTasks.length > 0 && !inCooldown;
          const shouldWake = wakeForEnv || wakeForConflict || wakeForChecksAfterBase || wakeForUnresolvedReview || wakeForStalledTask;

          if (!shouldWake) {
            const nextStatus = suppressedDirty
              ? 'suppressed_dirty'
              : isConflicted || failedChecks.length > 0 || unresolvedChangesRequested.length > 0 || local.stalledTasks.length > 0
                ? 'cooldown'
                : 'clean';
            savePatrolState(store, repositoryId, prNumber, nowIso, false, currentEnv, verified.headSha, effectiveBaseSha, nextStatus);
            continue;
          }

          const changesSinceLastCheck: string[] = [];
          if (effectiveEnvChanged) changesSinceLastCheck.push('environment_or_policy_changed');
          if (baseMoved) changesSinceLastCheck.push('base_moved');
          if (isConflicted) changesSinceLastCheck.push('conflicted');
          if (failedChecks.length > 0) changesSinceLastCheck.push('checks_failed');
          if (unresolvedChangesRequested.length > 0) changesSinceLastCheck.push('unresolved_changes_requested');
          if (local.stalledTasks.length > 0) changesSinceLastCheck.push('stalled_task');

          cachedComments ??= (await guardRequest(github.pages(github.path(`/issues/${prNumber}/comments`)))) ?? [];
          if (rateLimited) break;
          const ev = buildPatrolEventInput(
            store,
            repositoryId,
            verified,
            pr,
            targetBranch,
            effectiveBaseSha,
            prevPatrolBaseSha,
            baseMoved,
            isConflicted,
            checksPending,
            failedChecks,
            unresolvedChangesRequested,
            local,
            currentEnv,
            changesSinceLastCheck,
            environmentChanges,
            prevState,
            patrolConfig,
            nowMs,
            cachedComments,
          );
          store.transaction(() => {
            const recorded = recordEvent(store, ev);
            savePatrolState(store, repositoryId, prNumber, nowIso, recorded > 0, currentEnv, verified.headSha, effectiveBaseSha, recorded > 0 ? 'woken' : 'cooldown');
          });
        } catch {
          // Isolate per-PR patrol errors so one malformed row or transient failure never stalls scanning other PRs.
        }
      } finally {
        // A read that ran into the rate limit is not recorded: the PR stays due and is read once the window allows.
        if (scheduled && !rateLimited && store.db.isOpen) saveBotPrReconcile(store, repositoryId, prNumber, nowMs, seen ?? 'unreadable', row, localEnv);
      }
    }
  } finally {
    if (github.token && store.get('SELECT type FROM accounts WHERE id=?', repo.account_id)?.type === 'github_app') {
      await revokeInstallationToken(apiUrl || 'https://api.github.com', github.token).catch(() => false);
    }
  }
}

/**
 * Background reconciler for open `bot_pull_requests`: detects base-branch advances (without requiring `push` webhook
 * subscriptions), completed failed check suites (without requiring `check_suite` / `workflow_run` subscriptions), and
 * runs strictly internal low-frequency open-PR patrol (with dirty-conflict anti-burn suppression and zero external
 * notifications) under both `github_app` and `bot_account`. Each tick reads only the open bot PRs that are due on their
 * own schedule (#1396: 5 minutes to 4 hours, see BOT_PR_RECONCILE_MIN_MS), with one GraphQL query per repository and REST
 * details only for PRs that changed; a repository with no due PR makes no GitHub request at all.
 */
export class BotPrWakeScanner {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private closing = false;
  private patrolOptions?: Partial<BotPatrolConfig>;
  constructor(readonly store: Store, readonly apiUrl?: string, patrolOptions?: Partial<BotPatrolConfig>) {
    this.patrolOptions = patrolOptions;
  }
  start(intervalMs = 60_000, patrolOptions?: Partial<BotPatrolConfig>) {
    if (patrolOptions) this.patrolOptions = { ...this.patrolOptions, ...patrolOptions };
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }
  async close() {
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.active;
  }
  async tick(options?: { forcePatrol?: boolean; patrol?: Partial<BotPatrolConfig> }): Promise<void> {
    if (this.closing || !this.store.db.open || !this.store.hasTable('bot_pull_requests')) return;
    if (this.active) return this.active;
    const mergedPatrol = { ...this.patrolOptions, ...options?.patrol };
    this.active = (async () => {
      const repos = this.store.all(
        `SELECT DISTINCT r.*
         FROM repositories r
         JOIN policies p ON p.repository_id=r.id
         JOIN bot_pull_requests b ON b.repository_id=r.id
         LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
         WHERE p.enabled=1 AND coalesce(s.state,'open')<>'closed'`,
      );
      for (const repo of repos) {
        if (this.closing || !this.store.db.open) break;
        await reconcileOpenBotPullRequestsForRepo(this.store, repo, this.apiUrl, null, undefined, {
          patrol: mergedPatrol,
          forcePatrol: options?.forcePatrol,
        }).catch(() => {});
      }
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
}

/**
 * Atomically reads pending `review_updates` (`id > review_update_cursor`) for an active non-`review.*` task
 * and advances `review_update_cursor` so mid-turn execution consumes continued check failures, conflicts, and comments.
 */
export function consumePendingTaskUpdates(store: Store, taskId: string): any[] {
  if (!taskId || !store.hasTable('review_updates')) return [];
  const task = store.get('SELECT id,kind,review_update_cursor FROM tasks WHERE id=?', taskId);
  if (!task || String(task.kind).startsWith('review.')) return [];
  const cursor = Number(task.review_update_cursor || 0);
  const rows = store.all('SELECT id,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id ASC', taskId, cursor);
  if (!rows.length) return [];
  const maxId = Number(rows.at(-1)!.id);
  store.run('UPDATE tasks SET review_update_cursor=max(review_update_cursor,?) WHERE id=?', maxId, taskId);
  return rows.map(r => {
    try { return JSON.parse(String(r.data)); } catch { return { raw: String(r.data) }; }
  });
}

/**
 * Carries any `review_updates` (`id > review_update_cursor`) that joined a revision task after its last model turn
 * (during acceptance/publish) or before a terminal failure back to the Manager thread so zero updates are dropped.
 */
export function carryUnconsumedTaskUpdates(store: Store, taskId: string, currentHeadSha: string | null): void {
  if (!taskId || !store.hasTable('review_updates')) return;
  const task = store.get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!task || String(task.kind).startsWith('review.')) return;
  let parsedInput: any = {};
  try { parsedInput = JSON.parse(String(task.input || '{}')); } catch { parsedInput = {}; }
  const isDevTask = String(task.kind).startsWith('development.')
    || (task.kind === 'task.request' && taskPermissions(store, task).writes.some((w: string) => w === 'pull_request' || w === 'actions_rerun'));
  if (!isDevTask) return;

  const cursor = Number(task.review_update_cursor || 0);
  const rows = store.all('SELECT id,event_key,data FROM review_updates WHERE task_id=? AND id>? ORDER BY id ASC', taskId, cursor);
  if (!rows.length) return;
  const maxId = Number(rows.at(-1)!.id);
  store.run('UPDATE tasks SET review_update_cursor=max(review_update_cursor,?) WHERE id=?', maxId, taskId);

  const repositoryId = String(task.repository_id);
  for (const row of rows) {
    let data: any = null;
    try { data = JSON.parse(String(row.data || '{}')); } catch { data = null; }
    if (!data) continue;
    const wakeType = String(data.wake_type || '');
    const prNumber = Number(data.pr_number ?? (parsedInput.target?.type === 'pr' ? parsedInput.target.number : parsedInput.bot_pr?.number ?? task.object_number));
    const carryKey = `${repositoryId}:carried:${taskId}:${row.id}`;

    if (wakeType === 'pull_request.checks_failed' && data.check) {
      if (!Number.isSafeInteger(prNumber) || prNumber < 1) continue;
      const verified = verifiedOwnedOpenBotPr(store, repositoryId, prNumber);
      if (!verified) continue;
      const effectiveHead = normSha(currentHeadSha) ?? verified.headSha;
      if (normSha(data.head_sha) && effectiveHead !== normSha(data.head_sha)) continue;
      const rootIssue = rootIssueOfBotPr(store, repositoryId, prNumber);
      const revisions = botPrWakeRevisionFacts(store, repositoryId, prNumber);
      recordEvent(store, {
        repositoryId,
        key: carryKey,
        type: 'pull_request.checks_failed',
        source: 'control_plane',
        summary: `bot PR #${prNumber} 修订收尾期间未消费的检查失败：${clip(data.check.name, 80)}`,
        object: { type: 'pr', number: prNumber },
        delivery: task.source_delivery_id ?? null,
        facts: {
          bot_pull_request: true,
          carried_from: String(taskId),
          pr_number: prNumber,
          head_sha: effectiveHead,
          root_issue_number: rootIssue,
          object: objectFacts(verified.prObject),
          check: data.check,
          revisions,
          reason: 'This check failure joined the previous task after its last model turn or before it stopped, and was not consumed.',
        },
        options: [
          {
            id: 'development',
            work: 'development.pr',
            title: `修复 bot PR #${prNumber} 检查失败`,
            default: false,
            spec: { type: 'object', kind: 'development.pr', number: prNumber, head: effectiveHead, input: { revision: { source: 'checks_failed' }, wake_event: data }, delivery: null },
          },
          {
            id: 'reply',
            work: 'reply',
            title: `通用回复 #${prNumber}`,
            default: false,
            spec: { type: 'reply', kind: 'workflow.pr', number: prNumber, head: effectiveHead, input: { pull_request: verified.prObject, wake_event: data }, key: `carried:${taskId}:${row.id}`, delivery: null },
          },
        ],
        merge: {
          key: carryKey,
          data,
          trigger: { reason: 'pull_request.checks_failed', pr_number: prNumber, head_sha: effectiveHead, check_name: data.check.name, run_or_suite_id: data.check.run_or_suite_id, attempt: data.check.attempt, conclusion: data.check.conclusion, url: data.check.url, summary: data.check.summary },
          head: effectiveHead,
          kinds: ['development.pr'],
        },
      });
    } else if (wakeType === 'pull_request.conflicted' && data.conflict) {
      if (!Number.isSafeInteger(prNumber) || prNumber < 1) continue;
      const verified = verifiedOwnedOpenBotPr(store, repositoryId, prNumber);
      if (!verified) continue;
      const effectiveHead = normSha(currentHeadSha) ?? verified.headSha;
      const baseSha = normSha(data.base_sha) ?? normSha(data.conflict?.base_sha);
      if (!baseSha) continue;
      let candidateData: any = null;
      try { candidateData = JSON.parse(String(store.get('SELECT data FROM development_candidates WHERE task_id=?', taskId)?.data || 'null')); } catch { candidateData = null; }
      if (task.status === 'pr_opened' && candidateData?.base_sha === baseSha) continue;
      const ev = buildConflictEventInput(
        store,
        repositoryId,
        'pull_request',
        'carried',
        String(data.actor || ''),
        task.source_delivery_id ?? null,
        { ...verified, headSha: effectiveHead, prObject: { ...verified.prObject, head: { ...verified.prObject.head, sha: effectiveHead } } },
        baseSha,
        data.base_ref ?? data.conflict?.base_ref ?? verified.baseRef,
        data.conflict?.mergeable_state ?? 'dirty',
        'pull_request',
      );
      recordEvent(store, {
        ...ev,
        key: carryKey,
        source: 'control_plane',
        summary: `bot PR #${prNumber} 修订收尾期间未消费的合并冲突`,
        facts: { ...(ev.facts as Record<string, unknown>), carried_from: String(taskId) },
        merge: ev.merge ? { ...ev.merge, key: carryKey } : null,
      });
    } else {
      // Late comment, review, or object update joined into `task.request` via `continue_task` after its last model turn
      // or before terminal failure: carry it back to the object Manager thread instead of dropping it.
      const isIssueObj = parsedInput.target?.type === 'issue' && (!Number.isSafeInteger(prNumber) || !store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, prNumber));
      const objType: 'pr' | 'issue' = isIssueObj ? 'issue' : 'pr';
      const objNum = objType === 'issue' ? Number(parsedInput.target?.number ?? task.object_number) : prNumber;
      if (!Number.isSafeInteger(objNum) || objNum < 1) continue;
      // Avoid duplicating if `carryRevisionRequests` (`revision.carried:${taskId}`) already carried this exact comment/request ID.
      const sourceId = data.revision_request?.id ?? data.source?.id ?? data.comment?.id;
      if (sourceId != null) {
        const revCarried = store.get('SELECT facts FROM dispatch_events WHERE event_key=?', `${repositoryId}:revision.carried:${taskId}`);
        if (revCarried?.facts) {
          let carriedReqs: any[] = [];
          try { carriedReqs = JSON.parse(String(revCarried.facts))?.requests ?? []; } catch { carriedReqs = []; }
          if (Array.isArray(carriedReqs) && carriedReqs.some(r => String(r?.id) === String(sourceId))) continue;
        }
        if (store.get('SELECT 1 FROM dispatch_events WHERE repository_id=? AND event_key LIKE ?', repositoryId, `${repositoryId}:pull_request.updated:${objNum}:carried:%:${sourceId}`)) {
          continue;
        }
      }
      const verified = objType === 'pr' ? verifiedOwnedOpenBotPr(store, repositoryId, objNum) : null;
      const effectiveHead = normSha(currentHeadSha) ?? verified?.headSha ?? normSha(task.head_sha);
      const redactor = registeredRedactor(store);
      const actor = String(data.actor ?? data.comment?.user?.login ?? data.review?.user?.login ?? '');
      const bodyText = clip(data.comment?.body ?? data.review?.body ?? data.summary ?? '', 1200);
      recordEvent(store, {
        repositoryId,
        key: carryKey,
        type: objType === 'pr' ? 'pull_request.updated' : 'issue.updated',
        source: 'control_plane',
        summary: `${objType === 'pr' ? `PR #${objNum}` : `Issue #${objNum}`} 收尾期间未消费的续接更新${actor ? `（${actor}）` : ''}`,
        object: { type: objType, number: objNum },
        delivery: task.source_delivery_id ?? null,
        facts: publicContent(
          {
            carried_from: String(taskId),
            actor,
            ...(verified ? { bot_pull_request: true, revisions: botPrWakeRevisionFacts(store, repositoryId, objNum) } : {}),
            trigger: data,
            ...(bodyText ? { comment: { id: sourceId ?? String(row.id), author: actor || null, body: bodyText, url: safeHttpUrl(data.url ?? data.comment?.html_url) } } : {}),
            object: verified ? objectFacts(verified.prObject) : { number: objNum },
          },
          redactor,
        ),
        options: verified
          ? [
              {
                id: 'development',
                work: 'development.pr',
                title: `跟进 bot PR #${objNum} 未消费更新`,
                default: false,
                spec: { type: 'object', kind: 'development.pr', number: objNum, head: effectiveHead, input: { revision: { source: 'carried_update' }, trigger: data }, delivery: null },
              },
            ]
          : [],
        merge: {
          key: carryKey,
          data,
          trigger: data,
          head: effectiveHead,
          kinds: objType === 'pr' ? ['review.pr', 'development.pr'] : ['review.issue', 'development.issue'],
        },
      });
    }
  }
}
