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
  const ownedPrsByTask = new Map<string, Row>();
  const ownedPrsByKey = new Map<string, Row>();
  for (const row of store.all(`SELECT * FROM bot_pull_requests WHERE source_task_id IN (${placeholders})`, ...ids)) {
    ownedPrsByTask.set(String(row.source_task_id), row);
    ownedPrsByKey.set(`${row.repository_id}:${row.number}`, row);
  }
  const prNumbersByRepo = new Map<string, Set<number>>();
  for (const task of tasks) {
    const repoId = String(task.repository_id ?? '');
    const kind = String(task.kind ?? '');
    const prNo = (kind === 'review.pr' || kind === 'development.pr') && Number.isSafeInteger(task.object_number) && task.object_number > 0
      ? Number(task.object_number)
      : Number.isSafeInteger(task.result?.pr_number) && task.result.pr_number > 0 ? Number(task.result.pr_number)
      : Number.isSafeInteger(candidates.get(String(task.id))?.pr_number) ? Number(candidates.get(String(task.id)).pr_number) : null;
    if (repoId && prNo) {
      let set = prNumbersByRepo.get(repoId);
      if (!set) { set = new Set(); prNumbersByRepo.set(repoId, set); }
      set.add(prNo);
    }
  }
  for (const [repoId, nums] of prNumbersByRepo) {
    const list = [...nums];
    if (!list.length) continue;
    for (const row of store.all(`SELECT * FROM bot_pull_requests WHERE repository_id=? AND number IN (${list.map(() => '?').join(',')})`, repoId, ...list)) {
      ownedPrsByKey.set(`${row.repository_id}:${row.number}`, row);
    }
  }

  const effectsByTask = new Map<string, any>();
  for (const row of store.all(`SELECT task_id,response FROM github_effects WHERE task_id IN (${placeholders}) AND kind='pull_request' AND response IS NOT NULL`, ...ids)) {
    try { effectsByTask.set(String(row.task_id), JSON.parse(String(row.response))); } catch {}
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

  const sourceIds = [...new Set(tasks.map(t => t.source_task_id).filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const sourceTasks = new Map<string, Row>();
  if (sourceIds.length) {
    for (const row of store.all(`SELECT id,kind,object_number FROM tasks WHERE id IN (${sourceIds.map(() => '?').join(',')})`, ...sourceIds)) {
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

    // 1. Issue resolution
    let issueNumber: number | null = null;
    if ((kind === 'review.issue' || kind === 'development.issue') && Number.isSafeInteger(task.object_number) && task.object_number > 0) {
      issueNumber = Number(task.object_number);
    } else if (kind.startsWith('workflow.') && Number.isSafeInteger(task.object_number) && task.object_number > 0) {
      const isPr = hasBoard && !!store.get("SELECT 1 FROM board_objects WHERE repository_id=? AND object_type='pr' AND object_number=?", repoId, task.object_number);
      if (!isPr) issueNumber = Number(task.object_number);
    } else if (typeof task.source_task_id === 'string') {
      const src = sourceTasks.get(task.source_task_id);
      if (src && (src.kind === 'development.issue' || src.kind === 'review.issue') && Number.isSafeInteger(src.object_number) && src.object_number > 0) {
        issueNumber = Number(src.object_number);
      }
    }
    const issueRow = issueNumber && hasBoard ? store.get("SELECT title,github_state FROM board_objects WHERE repository_id=? AND object_type='issue' AND object_number=?", repoId, issueNumber) : undefined;
    const issue = issueNumber ? {
      number: issueNumber,
      title: issueRow?.title ? String(issueRow.title) : null,
      state: issueRow?.github_state ? String(issueRow.github_state) : null,
      url: ghBase ? `${ghBase}/issues/${issueNumber}` : null,
    } : null;

    // 2. Pull Request resolution
    const prNumber = (kind === 'review.pr' || kind === 'development.pr') && Number.isSafeInteger(task.object_number) && task.object_number > 0
      ? Number(task.object_number)
      : Number.isSafeInteger(result?.pr_number) && result.pr_number > 0 ? Number(result.pr_number)
      : Number.isSafeInteger(candidate?.pr_number) && candidate.pr_number > 0 ? Number(candidate.pr_number)
      : owned && Number.isSafeInteger(owned.number) ? Number(owned.number)
      : Number.isSafeInteger(effect?.number) && effect.number > 0 ? Number(effect.number)
      : null;
    const prOwned = prNumber ? (ownedPrsByKey.get(`${repoId}:${prNumber}`) ?? owned) : owned;
    const prBoard = prNumber && hasBoard ? store.get("SELECT title,github_state,draft FROM board_objects WHERE repository_id=? AND object_type='pr' AND object_number=?", repoId, prNumber) : undefined;
    const isMerged = mergedTasks.has(id) || result?.merged === true || effect?.merged === true;
    const prBranch = typeof result?.branch === 'string' && result.branch ? result.branch
      : typeof candidate?.branch === 'string' && candidate.branch ? candidate.branch
      : typeof prOwned?.branch === 'string' && prOwned.branch ? prOwned.branch
      : typeof effect?.head?.ref === 'string' && effect.head.ref ? effect.head.ref
      : null;
    const prSha = [task.pushed_sha, result?.sha, candidate?.remote_sha, prOwned?.sha, effect?.head?.sha, (kind === 'review.pr' || kind === 'development.pr') ? task.head_sha : null]
      .find(v => typeof v === 'string' && hexSha.test(v)) ?? null;
    const prUrl = typeof result?.pr_url === 'string' && /^https?:\/\//i.test(result.pr_url) ? result.pr_url
      : typeof effect?.html_url === 'string' && /^https?:\/\//i.test(effect.html_url) ? effect.html_url
      : prNumber && ghBase ? `${ghBase}/pull/${prNumber}` : null;
    const pull_request = prNumber ? {
      number: prNumber,
      title: prBoard?.title ? String(prBoard.title) : typeof effect?.title === 'string' ? effect.title : null,
      state: isMerged ? 'merged' : prBoard?.github_state ? String(prBoard.github_state) : typeof effect?.state === 'string' ? effect.state : 'open',
      draft: prBoard?.draft === 1 || effect?.draft === true,
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
