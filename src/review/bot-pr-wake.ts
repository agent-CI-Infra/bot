import type { Store, Row } from '../storage/database.js';
import { type Json, randomId } from '../core/security.js';
import { GitHub, revokeInstallationToken } from '../github/client.js';
import { sha as digest } from '../agent/common.js';
import { publicContent, registeredRedactor } from '../core/redaction.js';
import { covers, projectCeiling } from '../projects/ceiling.js';
import { recordEvent, rootIssueOfBotPr, type CreateOption, type EventInput } from '../dispatch/store.js';
import { taskPermissions } from '../tasks/configuration.js';

const HEX_SHA = /^[a-f0-9]{40}$/i;
const ZERO_SHA = /^0{40}$/;
const BOT_MARKER = /<!-- dept-bot[:-]/;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const ACTIONS_RUN_URL = /\/actions\/runs\/(\d+)(?:\/|$|\?)/;

let recheckDelaysMs = [1500, 4000];
const pendingRechecks = new Set<string>();
const pendingSuiteFlushes = new Map<string, { repositoryId: string; headSha: string; checkSuiteId: number | null; workflowRunId: number | null; attempt: number }>();

const settledReconcileChecks = new Map<string, { headSha: string; updatedAt: string; settledAt: number }>();

/** Allows integration tests to shorten background `mergeable === null` and suite-completion poll delays deterministically. */
export function setBotWakeRecheckDelaysForTest(delays: number[] | null) {
  recheckDelaysMs = delays ? [...delays] : [1500, 4000];
  settledReconcileChecks.clear();
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
       updated_at=excluded.updated_at`,
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

interface HumanCommentSummary {
  key: string;
  id: string;
  author: string | null;
  created_at: string;
  body_excerpt: string;
  url: string | null;
}

function collectHumanComments(store: Store, repositoryId: string, prNumber: number, rootIssue: number | null, ownedAuthorId: string, liveComments?: any[]): HumanCommentSummary[] {
  const actorRow = store.get('SELECT a.actor_id,a.login FROM repositories r JOIN github_actors a ON a.account_id=r.account_id WHERE r.id=?', repositoryId);
  const botIds = new Set<string>([String(ownedAuthorId), ...(actorRow?.actor_id ? [String(actorRow.actor_id)] : [])].filter(Boolean));
  const botLogins = new Set<string>(actorRow?.login ? [String(actorRow.login).toLowerCase()] : []);
  const byKey = new Map<string, HumanCommentSummary>();

  const addCandidate = (key: string, id: string, userType: unknown, userId: unknown, login: unknown, body: unknown, createdAt: unknown, url: unknown) => {
    const text = String(body ?? '').trim();
    if (!text || BOT_MARKER.test(text)) return;
    if (String(userType || '') === 'Bot') return;
    if (userId != null && String(userId) && botIds.has(String(userId))) return;
    const loginStr = login ? String(login) : null;
    if (loginStr && (botLogins.has(loginStr.toLowerCase()) || loginStr.toLowerCase().endsWith('[bot]'))) return;
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
  for (const row of store.all(
    `SELECT id,type,facts,created_at FROM dispatch_events
     WHERE repository_id=? AND object_number IN (${marks})
       AND type IN ('pull_request.updated','pull_request.mention','issue.updated','issue.mention')
     ORDER BY created_at ASC, rowid ASC`,
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
    ? Number(store.get("SELECT count(DISTINCT task_id) n FROM bot_pr_requests WHERE repository_id=? AND number=? AND state='done'", repositoryId, prNumber)?.n || 0)
    : 0;

  const taskRows = store.hasTable('task_events')
    ? store.all(
        `SELECT DISTINCT t.id,t.kind,t.status,t.summary,t.head_sha,t.error_code,t.input,t.result,t.created_at,t.updated_at
         FROM tasks t
         JOIN task_events te ON te.task_id=t.id
         JOIN dispatch_events e ON e.id=te.event_id
         WHERE t.repository_id=?
           AND e.repository_id=?
           AND e.type IN ('pull_request.checks_failed','pull_request.conflicted')
           AND (e.object_number=? OR t.object_number=?)
         ORDER BY t.created_at ASC, t.rowid ASC`,
        repositoryId,
        repositoryId,
        prNumber,
        prNumber,
      )
    : [];

  let forChecksFailed = 0;
  let forConflicts = 0;
  const allRounds = taskRows.map((t, index) => {
    const evTypes = store.all(
      `SELECT DISTINCT e.type FROM task_events te JOIN dispatch_events e ON e.id=te.event_id
       WHERE te.task_id=? AND e.type IN ('pull_request.checks_failed','pull_request.conflicted')`,
      t.id,
    ).map(r => String(r.type));
    if (evTypes.includes('pull_request.checks_failed')) forChecksFailed++;
    if (evTypes.includes('pull_request.conflicted')) forConflicts++;
    let parsedResult: any = null;
    let parsedInput: any = null;
    try { parsedResult = t.result ? JSON.parse(String(t.result)) : null; } catch { parsedResult = null; }
    try { parsedInput = t.input ? JSON.parse(String(t.input)) : null; } catch { parsedInput = null; }
    const roleRow = store.hasTable('task_origins')
      ? store.get('SELECT executor_role FROM task_origins WHERE task_id=?', t.id)
      : undefined;
    const summaryText = parsedResult?.summary
      ? String(parsedResult.summary)
      : t.error_code
        ? `Task ${t.status} (${t.error_code})`
        : String(t.summary || '');
    return {
      round: index + 1,
      task_id: String(t.id),
      status: String(t.status),
      role: roleRow?.executor_role ?? parsedInput?.executor_role ?? null,
      triggers: evTypes,
      head_sha: t.head_sha ?? null,
      published_sha: typeof parsedResult?.sha === 'string' ? parsedResult.sha : null,
      no_changes: parsedResult?.status === 'no_changes',
      error_code: t.error_code ?? null,
      goal: clip(t.summary, 240),
      summary: clip(summaryText, 500),
      created_at: String(t.created_at),
      updated_at: String(t.updated_at),
    };
  });

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

  return publicContent(
    {
      for_checks_or_conflicts: allRounds.length,
      for_checks_failed: forChecksFailed,
      for_conflicts: forConflicts,
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
  if (type !== 'pull_request.checks_failed' && type !== 'pull_request.conflicted') return facts;
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
          preflight?.comments?.[prNumber] as any[] | undefined,
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
        preflight?.comments?.[prNumber] as any[] | undefined,
      ),
    );
    return events;
  }

  return [];
}

async function reconcileOpenBotPullRequestsForRepo(
  store: Store,
  repo: Row,
  apiUrl?: string,
  deliveryId: string | null = null,
  onlyPrNumbers?: number[],
): Promise<void> {
  const repositoryId = String(repo.id);
  const repoFullName = String(repo.full_name || '');
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  if (!policy?.enabled || !covers(projectCeiling(store, repositoryId, policy), 'comment')) return;
  if (!store.hasTable('bot_pull_requests')) return;

  const prFilter = Array.isArray(onlyPrNumbers)
    ? [...new Set(onlyPrNumbers.filter(n => Number.isSafeInteger(n) && n > 0))]
    : null;
  if (prFilter && !prFilter.length) return;
  const candidates = prFilter
    ? store.all(
        `SELECT b.number, s.base_sha AS prev_base_sha
         FROM bot_pull_requests b
         LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
         WHERE b.repository_id=? AND coalesce(s.state,'open')<>'closed'
           AND b.number IN (${prFilter.map(() => '?').join(',')})
         ORDER BY b.number DESC LIMIT 25`,
        repositoryId,
        ...prFilter,
      )
    : store.all(
        `SELECT b.number, s.base_sha AS prev_base_sha
         FROM bot_pull_requests b
         LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
         WHERE b.repository_id=? AND coalesce(s.state,'open')<>'closed'
         ORDER BY b.number DESC LIMIT 25`,
        repositoryId,
      );
  if (!candidates.length) return;

  const redactor = registeredRedactor(store);
  const github = new GitHub(store, repo, redactor, async () => {}, apiUrl);
  try {
    await github.connect(false, undefined, { contents: 'read', pull_requests: 'read', issues: 'read', checks: 'read', actions: 'read' }, false);
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

    for (const row of candidates) {
      if (!store.db.open || rateLimited) break;
      const prNumber = Number(row.number);
      const pr = await guardRequest(github.request('GET', github.path(`/pulls/${prNumber}`), undefined, true));
      if (!pr || typeof pr !== 'object' || !store.db.open || rateLimited) continue;
      syncBotPullRequestState(store, repositoryId, pr);
      if (pr.state !== 'open' || pr.draft === true) {
        settledReconcileChecks.delete(`${repositoryId}:${prNumber}`);
        continue;
      }
      const verified = verifiedOwnedOpenBotPr(store, repositoryId, prNumber, pr);
      if (!verified) continue;

      const targetBranch = verified.baseRef ?? github.defaultBranch ?? 'main';
      const liveBranchSha = await readBranchHead(targetBranch);
      if (rateLimited) break;
      const effectiveBaseSha = liveBranchSha ?? normSha(pr.base?.sha) ?? verified.baseSha;

      if (isPullRequestConflicted(pr, 'pull_request', '')) {
        if (effectiveBaseSha && !store.get('SELECT 1 FROM dispatch_events WHERE event_key=?', conflictEventKey(repositoryId, prNumber, verified.headSha, effectiveBaseSha))) {
          const comments = (await guardRequest(github.pages(github.path(`/issues/${prNumber}/comments`)))) ?? [];
          if (rateLimited) break;
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
            comments,
          );
          store.transaction(() => recordEvent(store, ev));
        }
      } else if (pr.mergeable === null && effectiveBaseSha && effectiveBaseSha !== normSha(row.prev_base_sha)) {
        scheduleMergeableRecheck(store, repo, [prNumber], targetBranch, effectiveBaseSha, apiUrl, deliveryId);
      }

      const settledKey = `${repositoryId}:${prNumber}`;
      const prUpdatedAt = String(pr.updated_at || '');
      const cachedSettled = !prFilter ? settledReconcileChecks.get(settledKey) : undefined;
      if (
        cachedSettled
        && cachedSettled.headSha === verified.headSha
        && cachedSettled.updatedAt === prUpdatedAt
        && Date.now() - cachedSettled.settledAt < 10 * 60_000
      ) {
        continue;
      }

      // Reconcile completed failed check suites on `verified.headSha` without requiring `check_suite` or `workflow_run` webhooks
      // (including `startup_failure` check suites that fail before creating any `check_run`).
      const [runsRes, suitesRes] = await Promise.all([
        guardRequest(github.request('GET', github.path(`/commits/${verified.headSha}/check-runs?filter=latest&per_page=100`), undefined, true)),
        guardRequest(github.request('GET', github.path(`/commits/${verified.headSha}/check-suites?per_page=100`), undefined, true)),
      ]);
      if (rateLimited) break;
      const checkRuns = Array.isArray(runsRes?.check_runs) ? runsRes.check_runs : [];
      const checkSuites = Array.isArray(suitesRes?.check_suites) ? suitesRes.check_suites : [];
      if (!checkRuns.length && !checkSuites.length) continue;
      const allChecksCompleted =
        checkRuns.every((cr: any) => String(cr?.status || '') === 'completed')
        && checkSuites.every((cs: any) => String(cs?.status || '') === 'completed');

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

      let cachedComments: any[] | undefined;
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
        cachedComments ??= await github.pages(github.path(`/issues/${prNumber}/comments`)).catch(() => []);
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
      if (allChecksCompleted && !rateLimited) {
        settledReconcileChecks.set(settledKey, { headSha: verified.headSha, updatedAt: prUpdatedAt, settledAt: Date.now() });
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
 * subscriptions) and completed failed check suites (without requiring `check_suite` / `workflow_run` subscriptions)
 * under both `github_app` and `bot_account`. Repositories without open `bot_pull_requests` perform zero network calls.
 */
export class BotPrWakeScanner {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private closing = false;
  constructor(readonly store: Store, readonly apiUrl?: string) {}
  start(intervalMs = 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }
  async close() {
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.active;
  }
  async tick(): Promise<void> {
    if (this.closing || !this.store.db.open || !this.store.hasTable('bot_pull_requests')) return;
    if (this.active) return this.active;
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
        await reconcileOpenBotPullRequestsForRepo(this.store, repo, this.apiUrl).catch(() => {});
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
