import type { Store, Row } from '../storage/database.js';
import { fail, type Json } from '../core/security.js';
import { scope, type Actor } from '../app/auth.js';
import { GitHub } from '../github/client.js';
import { Redactor, TaskError } from '../agent/common.js';

const hexSha = /^[a-f0-9]{40}$/i;
const repoPath = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const passingConclusions = new Set(['success', 'neutral', 'skipped']);
const checkRetentionMs = 30 * 24 * 3600_000;
const opportunisticPruneIntervalMs = 10 * 60_000;
const liveSyncCooldownMs = 15_000;
let lastOpportunisticPruneAt = 0;
const liveSyncSeen = new Map<string, number>();

export function commitChecksStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS commit_checks(
      repository_id TEXT NOT NULL REFERENCES repositories(id),
      head_sha TEXT NOT NULL,
      check_key TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      conclusion TEXT,
      details_url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id,head_sha,check_key)
    );
    CREATE INDEX IF NOT EXISTS commit_checks_updated ON commit_checks(updated_at);
  `);
}

/** Bounded retention cleanup for aged `commit_checks` rows so long-running deployments do not grow without bound. */
export function pruneCommitChecks(store: Store, maxAgeMs = checkRetentionMs, now = Date.now()): number {
  if (!store.hasTable('commit_checks')) return 0;
  const cutoff = new Date(now - maxAgeMs).toISOString();
  const res = store.run(
    'DELETE FROM commit_checks WHERE rowid IN (SELECT rowid FROM commit_checks WHERE updated_at < ? LIMIT 500)',
    cutoff,
  );
  return Number(res.changes ?? 0);
}

function upsertCheck(store: Store, repositoryId: string, headSha: string, key: string, name: string, status: string, conclusion: string | null, detailsUrl: string | null, updatedAt = new Date().toISOString()): void {
  if (!repositoryId || !hexSha.test(headSha) || !key || !name) return;
  if (!store.hasTable('commit_checks')) commitChecksStorage(store);
  const normalizedSha = headSha.toLowerCase();
  const normalizedStatus = status === 'completed' ? 'completed' : status === 'queued' ? 'queued' : 'in_progress';
  const safeUrl = detailsUrl && /^https?:\/\//i.test(detailsUrl) ? detailsUrl.slice(0, 500) : null;
  store.run(`INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(repository_id,head_sha,check_key) DO UPDATE SET
      name=excluded.name,
      status=excluded.status,
      conclusion=excluded.conclusion,
      details_url=coalesce(excluded.details_url,commit_checks.details_url),
      updated_at=excluded.updated_at`,
    repositoryId, normalizedSha, key.slice(0, 200), name.slice(0, 160), normalizedStatus,
    normalizedStatus === 'completed' ? (conclusion ? String(conclusion).toLowerCase().slice(0, 64) : 'unknown') : null,
    safeUrl, updatedAt);
}

export function recordCheckWebhook(store: Store, repositoryId: string, event: string, payload: any): void {
  if (!repositoryId || !payload || typeof payload !== 'object') return;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  if (nowMs - lastOpportunisticPruneAt >= opportunisticPruneIntervalMs) {
    lastOpportunisticPruneAt = nowMs;
    pruneCommitChecks(store, checkRetentionMs, nowMs);
  }
  if (event === 'check_run' && payload.check_run && typeof payload.check_run === 'object') {
    const run = payload.check_run;
    const sha = String(run.head_sha ?? '');
    const name = String(run.name ?? '').trim();
    const key = 'check:' + (name || String(run.id ?? ''));
    upsertCheck(store, repositoryId, sha, key, name || key, String(run.status ?? 'in_progress'),
      run.conclusion ? String(run.conclusion) : null, String(run.html_url || run.details_url || ''), now);
  } else if (event === 'workflow_run' && payload.workflow_run && typeof payload.workflow_run === 'object') {
    const wf = payload.workflow_run;
    const sha = String(wf.head_sha ?? '');
    const name = String(wf.name ?? '').trim();
    const key = 'workflow:' + String(wf.workflow_id || name || wf.id || '');
    upsertCheck(store, repositoryId, sha, key, name || 'Actions', String(wf.status ?? 'in_progress'),
      wf.conclusion ? String(wf.conclusion) : null, String(wf.html_url || ''), now);
  } else if (event === 'status' && typeof payload.sha === 'string' && typeof payload.context === 'string') {
    const state = String(payload.state ?? 'pending').toLowerCase();
    upsertCheck(store, repositoryId, payload.sha, 'status:' + payload.context, payload.context.trim(),
      state === 'pending' ? 'in_progress' : 'completed',
      state === 'pending' ? null : state === 'success' ? 'success' : 'failure',
      String(payload.target_url || ''), now);
  }
}

export function recordMergeChecks(store: Store, repositoryId: string, headSha: string, checkRuns: any[], statusContexts: any[]): void {
  if (!repositoryId || !hexSha.test(headSha)) return;
  const now = new Date().toISOString();
  for (const run of checkRuns) {
    if (!run || typeof run !== 'object') continue;
    const name = String(run.name ?? '').trim();
    if (!name) continue;
    upsertCheck(store, repositoryId, headSha, 'check:' + name, name, String(run.status ?? 'in_progress'),
      run.conclusion ? String(run.conclusion) : null, typeof run.html_url === 'string' ? run.html_url : typeof run.details_url === 'string' ? run.details_url : null, now);
  }
  for (const ctx of statusContexts) {
    if (!ctx || typeof ctx !== 'object' || typeof ctx.context !== 'string') continue;
    const state = String(ctx.state ?? 'pending').toLowerCase();
    upsertCheck(store, repositoryId, headSha, 'status:' + ctx.context, ctx.context.trim(),
      state === 'pending' ? 'in_progress' : 'completed',
      state === 'pending' ? null : state === 'success' ? 'success' : 'failure',
      typeof ctx.target_url === 'string' ? ctx.target_url : null, now);
  }
}

function summarizeChecks(items: { name: string; status: string; conclusion: string | null; details_url: string | null }[], headSha: string | null, fallbackUrl: string | null, eventsUnsubscribed = false): Json {
  let passed = 0, running = 0, failed = 0;
  for (const item of items) {
    if (item.status !== 'completed') running++;
    else if (item.conclusion && passingConclusions.has(item.conclusion)) passed++;
    else failed++;
  }
  const total = items.length;
  const status = total === 0 ? 'none' : failed > 0 ? 'failing' : running > 0 ? 'running' : 'passing';
  const url = items.find(i => i.details_url)?.details_url ?? fallbackUrl;
  return { status, head_sha: headSha, total, passed, running, failed, checks: items.slice(0, 12), url, ...(total === 0 && Boolean(headSha) && eventsUnsubscribed ? { events_unsubscribed: true } : {}) };
}

export interface PublicTaskTarget {
  type: 'issue' | 'pr' | 'branch' | 'commit';
  number?: number;
  ref?: string;
}

export function taskTargetSelectSQL(column = 'input'): string {
  return `CASE WHEN json_valid(${column}) THEN json_extract(${column},'$.target.type','$.target.number','$.target.ref') END`;
}

function positiveInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function normalizeTargetType(value: unknown): PublicTaskTarget['type'] | null {
  if (value === 'pull_request' || value === 'pr') return 'pr';
  if (value === 'issue' || value === 'branch' || value === 'commit') return value;
  return null;
}

function nonEmptyString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function httpUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
}

function validSha(value: unknown): string | null {
  return typeof value === 'string' && hexSha.test(value) ? value : null;
}

export function parseTaskTargetMeta(raw: unknown): PublicTaskTarget | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const type = normalizeTargetType(parsed[0]);
  if (!type) return null;
  const number = positiveInt(parsed[1]);
  const ref = nonEmptyString(parsed[2], 256);
  const target: PublicTaskTarget = { type };
  if (number !== null) target.number = number;
  if (ref !== null) target.ref = ref;
  return target;
}

interface TaskInputMeta {
  targetType: PublicTaskTarget['type'] | null;
  targetNumber: number | null;
  targetRef: string | null;
  botPrNumber: number | null;
  botPrBranch: string | null;
  botPrSha: string | null;
  botPrTitle: string | null;
  botPrState: string | null;
  botPrDraft: boolean;
  botPrMerged: boolean;
  botPrUrl: string | null;
  objectPrBranch: string | null;
  objectPrSha: string | null;
  objectPrTitle: string | null;
  objectPrState: string | null;
  objectPrDraft: boolean;
  objectPrMerged: boolean;
  objectPrUrl: string | null;
}

function parseTaskInputMeta(raw: unknown): TaskInputMeta | null {
  if (typeof raw !== 'string') return null;
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return {
    targetType: normalizeTargetType(arr[0]),
    targetNumber: positiveInt(arr[1]),
    targetRef: nonEmptyString(arr[2], 256),
    botPrNumber: positiveInt(arr[3]),
    botPrBranch: nonEmptyString(arr[4], 256),
    botPrSha: validSha(arr[5]),
    botPrTitle: nonEmptyString(arr[6], 300),
    botPrState: nonEmptyString(arr[7], 32),
    botPrDraft: arr[8] === true || arr[8] === 1,
    botPrMerged: arr[9] === true || arr[9] === 1,
    botPrUrl: httpUrl(arr[10]),
    objectPrBranch: nonEmptyString(arr[11], 256),
    objectPrSha: validSha(arr[12]),
    objectPrTitle: nonEmptyString(arr[13], 300),
    objectPrState: nonEmptyString(arr[14], 32),
    objectPrDraft: arr[15] === true || arr[15] === 1,
    objectPrMerged: arr[16] === true || arr[16] === 1,
    objectPrUrl: httpUrl(arr[17]),
  };
}

function issueNumberOfSourceTask(src: Row | undefined, expectedRepoId: string): number | null {
  if (!src) return null;
  if (expectedRepoId && String(src.repository_id ?? '') !== expectedRepoId) return null;
  const srcKind = String(src.kind ?? '');
  if (srcKind === 'development.issue' || srcKind === 'review.issue') {
    return positiveInt(src.object_number);
  }
  const target = parseTaskTargetMeta(src.target_meta);
  if (target?.type === 'issue') {
    return target.number ?? positiveInt(src.object_number);
  }
  return null;
}

export function attachExternalLinks<T extends Record<string, any>>(store: Store, tasks: T[]): (T & { external: Json })[] {
  if (!tasks.length) return [];
  const ids = tasks.map(t => String(t.id));
  const placeholders = ids.map(() => '?').join(',');
  const hasBoard = store.hasTable('board_objects');
  const hasChecks = store.hasTable('commit_checks');
  const hasMerge = store.hasTable('task_merge_requests');

  const candidates = new Map<string, any>();
  for (const row of store.all(`SELECT task_id,data FROM development_candidates WHERE task_id IN (${placeholders})`, ...ids)) {
    try { candidates.set(String(row.task_id), JSON.parse(String(row.data))); } catch {}
  }

  // Extract only lightweight target / PR metadata in one SQLite JSON pass without loading full task `input` blobs.
  const inputMetaByTask = new Map<string, TaskInputMeta>();
  for (const row of store.all(
    `SELECT id,
       CASE WHEN json_valid(input) THEN json_extract(input,
         '$.target.type','$.target.number','$.target.ref',
         '$.bot_pr.number','$.bot_pr.head.ref','$.bot_pr.head.sha',
         '$.bot_pr.title','$.bot_pr.state','$.bot_pr.draft','$.bot_pr.merged','$.bot_pr.html_url',
         '$.object.head.ref','$.object.head.sha',
         '$.object.title','$.object.state','$.object.draft','$.object.merged','$.object.html_url'
       ) END AS meta
     FROM tasks WHERE id IN (${placeholders})`,
    ...ids,
  )) {
    const meta = parseTaskInputMeta(row.meta);
    if (meta) inputMetaByTask.set(String(row.id), meta);
  }

  const ownedPrsByTask = new Map<string, Row>();
  const ownedPrsByKey = new Map<string, Row>();
  for (const row of store.all(`SELECT * FROM bot_pull_requests WHERE source_task_id IN (${placeholders})`, ...ids)) {
    ownedPrsByTask.set(String(row.source_task_id), row);
    ownedPrsByKey.set(`${row.repository_id}:${row.number}`, row);
  }

  const effectsByTask = new Map<string, any>();
  for (const row of store.all(`SELECT task_id,response FROM github_effects WHERE task_id IN (${placeholders}) AND kind='pull_request' AND response IS NOT NULL`, ...ids)) {
    try { effectsByTask.set(String(row.task_id), JSON.parse(String(row.response))); } catch {}
  }

  const resolvedPrByTask = new Map<string, number>();
  const prNumbersByRepo = new Map<string, Set<number>>();
  for (const task of tasks) {
    const id = String(task.id);
    const repoId = String(task.repository_id ?? '');
    const kind = String(task.kind ?? '');
    const meta = inputMetaByTask.get(id) ?? null;
    const targetType = meta?.targetType ?? normalizeTargetType(task.target?.type);
    const targetNumber = meta?.targetNumber ?? positiveInt(task.target?.number);
    const result = task.result && typeof task.result === 'object' ? task.result : null;
    const candidate = candidates.get(id) ?? null;
    const owned = ownedPrsByTask.get(id) ?? null;
    const effect = effectsByTask.get(id) ?? null;
    const directPrNo = (kind === 'review.pr' || kind === 'development.pr')
      ? positiveInt(task.object_number)
      : targetType === 'pr'
        ? (targetNumber ?? positiveInt(task.object_number))
        : null;
    const prNo = directPrNo
      ?? positiveInt(result?.pr_number)
      ?? positiveInt(candidate?.pr_number)
      ?? meta?.botPrNumber
      ?? positiveInt(owned?.number)
      ?? positiveInt(effect?.number)
      ?? null;
    if (prNo !== null) {
      resolvedPrByTask.set(id, prNo);
      if (repoId) {
        let set = prNumbersByRepo.get(repoId);
        if (!set) { set = new Set(); prNumbersByRepo.set(repoId, set); }
        set.add(prNo);
      }
    }
  }
  for (const [repoId, nums] of prNumbersByRepo) {
    const list = [...nums];
    if (!list.length) continue;
    for (const row of store.all(`SELECT * FROM bot_pull_requests WHERE repository_id=? AND number IN (${list.map(() => '?').join(',')})`, repoId, ...list)) {
      ownedPrsByKey.set(`${row.repository_id}:${row.number}`, row);
    }
  }

  const mergedTasks = new Set<string>();
  if (hasMerge) {
    for (const row of store.all(`SELECT task_id FROM task_merge_requests WHERE task_id IN (${placeholders}) AND state='merged'`, ...ids)) mergedTasks.add(String(row.task_id));
  }
  for (const row of store.all(`SELECT DISTINCT task_id FROM task_history WHERE task_id IN (${placeholders}) AND type='repository_evolved'`, ...ids)) {
    mergedTasks.add(String(row.task_id));
  }

  const mergeChecksByTask = new Map<string, any>();
  for (const row of store.all(`SELECT task_id,CASE WHEN length(data)<=32768 THEN data END AS data FROM task_history WHERE task_id IN (${placeholders}) AND type='merge_checks' ORDER BY id ASC`, ...ids)) {
    if (typeof row.data === 'string') { try { mergeChecksByTask.set(String(row.task_id), JSON.parse(row.data)); } catch {} }
  }

  const sourceIdSet = new Set<string>();
  for (const task of tasks) {
    if (typeof task.source_task_id === 'string' && task.source_task_id.length > 0) {
      sourceIdSet.add(task.source_task_id);
    }
    const id = String(task.id);
    const repoId = String(task.repository_id ?? '');
    const prNo = resolvedPrByTask.get(id) ?? null;
    const prOwned = prNo ? (ownedPrsByKey.get(`${repoId}:${prNo}`) ?? ownedPrsByTask.get(id) ?? null) : (ownedPrsByTask.get(id) ?? null);
    if (typeof prOwned?.source_task_id === 'string' && prOwned.source_task_id.length > 0) {
      sourceIdSet.add(prOwned.source_task_id);
    }
  }
  const sourceIds = [...sourceIdSet];
  const sourceTasks = new Map<string, Row>();
  if (sourceIds.length) {
    for (const row of store.all(
      `SELECT id,repository_id,kind,object_number,${taskTargetSelectSQL()} AS target_meta FROM tasks WHERE id IN (${sourceIds.map(() => '?').join(',')})`,
      ...sourceIds,
    )) {
      sourceTasks.set(String(row.id), row);
    }
  }

  const repoIds = [...new Set(tasks.map(t => String(t.repository_id ?? '')).filter(Boolean))];
  const unsubscribedRepos = new Set<string>();
  if (repoIds.length && store.hasTable('installed_repositories')) {
    for (const row of store.all(
      `SELECT r.id AS repository_id, a.type AS account_type, i.events AS events
       FROM repositories r
       JOIN accounts a ON a.id=r.account_id
       LEFT JOIN installed_repositories i ON i.account_id=r.account_id AND i.repository_id=r.id AND i.installed=1
       WHERE r.id IN (${repoIds.map(() => '?').join(',')})`,
      ...repoIds,
    )) {
      if (row.account_type !== 'github_app' || typeof row.events !== 'string') continue;
      try {
        const parsed = JSON.parse(row.events);
        if (Array.isArray(parsed) && !parsed.includes('check_run') && !parsed.includes('status')) {
          unsubscribedRepos.add(String(row.repository_id));
        }
      } catch {}
    }
  }

  return tasks.map(task => {
    const id = String(task.id);
    const repoId = String(task.repository_id ?? '');
    const fullName = typeof task.full_name === 'string' && repoPath.test(task.full_name) ? task.full_name : null;
    const ghBase = fullName ? `https://github.com/${fullName}` : null;
    const kind = String(task.kind ?? '');
    const result = task.result && typeof task.result === 'object' ? task.result : null;
    const candidate = candidates.get(id) ?? null;
    const effect = effectsByTask.get(id) ?? null;
    const owned = ownedPrsByTask.get(id) ?? null;
    const meta = inputMetaByTask.get(id) ?? null;
    const targetType = meta?.targetType ?? normalizeTargetType(task.target?.type);
    const targetNumber = meta?.targetNumber ?? positiveInt(task.target?.number);
    const targetRef = meta?.targetRef ?? nonEmptyString(task.target?.ref, 256);
    const isPrTarget = kind === 'review.pr' || kind === 'development.pr' || targetType === 'pr';

    const prNumber = resolvedPrByTask.get(id) ?? null;
    const prOwned = prNumber ? (ownedPrsByKey.get(`${repoId}:${prNumber}`) ?? owned) : owned;

    // 1. Issue resolution (direct Issue target, source task, or bot PR root Issue)
    let issueNumber: number | null = null;
    if ((kind === 'review.issue' || kind === 'development.issue') && positiveInt(task.object_number)) {
      issueNumber = positiveInt(task.object_number);
    } else if (targetType === 'issue') {
      issueNumber = targetNumber ?? positiveInt(task.object_number);
    } else if (kind.startsWith('workflow.') && positiveInt(task.object_number)) {
      const isPr = hasBoard && !!store.get("SELECT 1 FROM board_objects WHERE repository_id=? AND object_type='pr' AND object_number=?", repoId, task.object_number);
      if (!isPr) issueNumber = positiveInt(task.object_number);
    }
    if (!issueNumber && typeof task.source_task_id === 'string' && task.source_task_id) {
      issueNumber = issueNumberOfSourceTask(sourceTasks.get(task.source_task_id), repoId);
    }
    if (!issueNumber && typeof prOwned?.source_task_id === 'string' && prOwned.source_task_id) {
      issueNumber = issueNumberOfSourceTask(sourceTasks.get(prOwned.source_task_id), repoId);
    }
    const issueRow = issueNumber && hasBoard ? store.get("SELECT title,github_state FROM board_objects WHERE repository_id=? AND object_type='issue' AND object_number=?", repoId, issueNumber) : undefined;
    const issue = issueNumber ? {
      number: issueNumber,
      title: issueRow?.title ? String(issueRow.title) : null,
      state: issueRow?.github_state ? String(issueRow.github_state) : null,
      url: ghBase ? `${ghBase}/issues/${issueNumber}` : null,
    } : null;

    // 2. Pull Request resolution
    const matchingBotPr = meta && meta.botPrNumber !== null && meta.botPrNumber === prNumber ? meta : null;
    const directPrNum = isPrTarget ? (targetType === 'pr' ? (targetNumber ?? positiveInt(task.object_number)) : positiveInt(task.object_number)) : null;
    const matchingObjPr = meta && isPrTarget && directPrNum !== null && directPrNum === prNumber ? meta : null;
    const prBoard = prNumber && hasBoard ? store.get("SELECT title,github_state,draft FROM board_objects WHERE repository_id=? AND object_type='pr' AND object_number=?", repoId, prNumber) : undefined;
    const isMerged = mergedTasks.has(id) || result?.merged === true || effect?.merged === true || matchingBotPr?.botPrMerged === true || matchingObjPr?.objectPrMerged === true;
    const prBranch = typeof result?.branch === 'string' && result.branch ? result.branch
      : typeof candidate?.branch === 'string' && candidate.branch ? candidate.branch
      : matchingBotPr?.botPrBranch
      ?? (typeof prOwned?.branch === 'string' && prOwned.branch ? prOwned.branch : null)
      ?? (typeof effect?.head?.ref === 'string' && effect.head.ref ? effect.head.ref : null)
      ?? matchingObjPr?.objectPrBranch
      ?? null;
    const prSha = [
      task.pushed_sha,
      result?.sha,
      candidate?.remote_sha,
      matchingBotPr?.botPrSha,
      prOwned?.sha,
      effect?.head?.sha,
      matchingObjPr?.objectPrSha,
      isPrTarget ? task.head_sha : null,
      isPrTarget ? validSha(targetRef) : null,
    ].find(v => typeof v === 'string' && hexSha.test(v)) ?? null;
    const prUrl = typeof result?.pr_url === 'string' && /^https?:\/\//i.test(result.pr_url) ? result.pr_url
      : typeof effect?.html_url === 'string' && /^https?:\/\//i.test(effect.html_url) ? effect.html_url
      : matchingBotPr?.botPrUrl
      ?? matchingObjPr?.objectPrUrl
      ?? (prNumber && ghBase ? `${ghBase}/pull/${prNumber}` : null);
    const pull_request = prNumber ? {
      number: prNumber,
      title: prBoard?.title ? String(prBoard.title) : matchingBotPr?.botPrTitle ?? matchingObjPr?.objectPrTitle ?? (typeof effect?.title === 'string' ? effect.title : null),
      state: isMerged ? 'merged' : prBoard?.github_state ? String(prBoard.github_state) : matchingBotPr?.botPrState ?? matchingObjPr?.objectPrState ?? (typeof effect?.state === 'string' ? effect.state : 'open'),
      draft: prBoard?.draft === 1 || (!prBoard && (matchingBotPr?.botPrDraft === true || matchingObjPr?.objectPrDraft === true)) || effect?.draft === true,
      branch: prBranch,
      head_sha: prSha ? String(prSha).toLowerCase() : null,
      url: prUrl,
    } : null;

    // 3. GitHub Actions / Check Runs resolution
    const checkSha = (pull_request?.head_sha
      ?? ([task.pushed_sha, result?.sha, (kind === 'actions.failures' || kind.startsWith('release.') ? task.head_sha : null)].find(v => typeof v === 'string' && hexSha.test(v)) ?? null));
    const normalizedCheckSha = checkSha ? String(checkSha).toLowerCase() : null;
    let checkItems: { name: string; status: string; conclusion: string | null; details_url: string | null }[] = [];
    if (normalizedCheckSha && hasChecks) {
      checkItems = store.all('SELECT name,status,conclusion,details_url FROM commit_checks WHERE repository_id=? AND head_sha=? ORDER BY name ASC', repoId, normalizedCheckSha)
        .map(r => ({ name: String(r.name), status: String(r.status), conclusion: r.conclusion ? String(r.conclusion) : null, details_url: r.details_url ? String(r.details_url) : null }));
    }
    if (!checkItems.length && mergeChecksByTask.has(id)) {
      const mc = mergeChecksByTask.get(id);
      const runs = Array.isArray(mc?.check_runs) ? mc.check_runs : [];
      const contexts = Array.isArray(mc?.status_contexts) ? mc.status_contexts : [];
      checkItems = [
        ...runs.filter((c: any) => c?.name).map((c: any) => ({ name: String(c.name), status: String(c.status ?? 'completed'), conclusion: c.conclusion ? String(c.conclusion).toLowerCase() : null, details_url: null })),
        ...contexts.filter((c: any) => c?.context).map((c: any) => ({
          name: String(c.context),
          status: c.state === 'pending' ? 'in_progress' : 'completed',
          conclusion: c.state === 'pending' ? null : c.state === 'success' ? 'success' : 'failure',
          details_url: null,
        })),
      ];
    }
    const actionsFallbackUrl = pull_request?.url ? `${pull_request.url}/checks` : ghBase ? `${ghBase}/actions` : null;
    const resolvedSha = normalizedCheckSha ?? (typeof mcSha(mergeChecksByTask.get(id)) === 'string' ? mcSha(mergeChecksByTask.get(id)) : null);
    const actions = summarizeChecks(checkItems, resolvedSha, actionsFallbackUrl, unsubscribedRepos.has(repoId));

    return { ...task, external: { issue, pull_request, actions } };
  });
}

function mcSha(mc: any): string | null {
  return typeof mc?.sha === 'string' && hexSha.test(mc.sha) ? mc.sha.toLowerCase() : null;
}

/** Live read-only GitHub check-runs + commit-status backfill for a task (`GET /api/tasks/:id/checks?sync=1`). */
export async function taskChecksApi(store: Store, user: Actor, method: string, url: URL, githubUrl?: string): Promise<Json | undefined> {
  const match = /^\/api\/tasks\/([^/]+)\/checks$/.exec(url.pathname);
  if (!match) return undefined;
  if (method !== 'GET') return fail(405, 'method_not_allowed');
  const filter = scope(user, 'repository_id');
  const row = store.get(
    `SELECT tasks.*,
      (SELECT full_name FROM repositories WHERE id=tasks.repository_id) AS full_name,
      (SELECT json_extract(data,'$.remote_sha') FROM development_candidates WHERE task_id=tasks.id) AS pushed_sha
     FROM tasks WHERE id=? AND ${filter.sql}`,
    match[1]!, ...filter.args,
  );
  if (!row) return fail(404, 'task_not_found');

  const buildTask = () => ({
    ...row,
    pushed_sha: row.pushed_sha || null,
    result: row.result ? (() => { try { return JSON.parse(String(row.result)); } catch { return null; } })() : null,
  });

  const initial = attachExternalLinks(store, [buildTask()])[0]!.external.actions as Record<string, any>;
  const syncRequested = url.searchParams.get('sync') === '1';
  if (!syncRequested) return { actions: initial, synced: false };

  const headSha = typeof initial.head_sha === 'string' && hexSha.test(initial.head_sha) ? initial.head_sha.toLowerCase() : null;
  if (!headSha) return { actions: initial, synced: false, reason: 'no_commit_sha' };

  const repoId = String(row.repository_id);
  const cacheKey = `${repoId}:${headSha}`;
  const now = Date.now();
  for (const [k, at] of liveSyncSeen) {
    if (now - at >= liveSyncCooldownMs) liveSyncSeen.delete(k);
  }
  if ((liveSyncSeen.get(cacheKey) ?? 0) > now - liveSyncCooldownMs) {
    return { actions: initial, synced: false, cached: true };
  }

  const repo = store.get('SELECT * FROM repositories WHERE id=?', repoId);
  if (!repo) return fail(404, 'repository_not_found');
  const github = new GitHub(store, repo, new Redactor(), async () => store.checkAuthorization(), githubUrl);
  github.purpose = 'task_checks';
  let partialError: TaskError | null = null;
  try {
    await github.connect(false, undefined, { checks: 'read', statuses: 'read' }, false);
    const runs: any[] = [];
    let runsError: TaskError | null = null;
    let statusError: TaskError | null = null;
    try {
      for (let page = 1; page <= 5; page++) {
        const res = await github.request('GET', github.path(`/commits/${headSha}/check-runs?filter=latest&per_page=100&page=${page}`));
        if (!Array.isArray(res?.check_runs)) break;
        runs.push(...res.check_runs);
        if (res.check_runs.length < 100) break;
      }
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      runsError = err;
    }
    let contexts: any[] = [];
    try {
      const st = await github.request('GET', github.path(`/commits/${headSha}/status`));
      if (Array.isArray(st?.statuses)) contexts = st.statuses;
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      statusError = err;
    }
    if (runsError && statusError) {
      const primary = runsError.code === 'github_rate_limited' ? runsError : statusError.code === 'github_rate_limited' ? statusError : runsError;
      return fail(primary.code === 'github_rate_limited' ? 429 : 502, primary.code);
    }
    store.checkAuthorization();
    recordMergeChecks(store, repoId, headSha, runs, contexts);
    partialError = runsError ?? statusError;
    if (!partialError) liveSyncSeen.set(cacheKey, Date.now());
  } catch (err) {
    if (err instanceof TaskError) return fail(err.code === 'github_rate_limited' ? 429 : 502, err.code);
    throw err;
  } finally {
    await github.revokeTokens('task_checks');
  }

  const updated = attachExternalLinks(store, [buildTask()])[0]!.external.actions;
  if (partialError) return { actions: updated, synced: true, partial: true, error: partialError.code };
  return { actions: updated, synced: true };
}
