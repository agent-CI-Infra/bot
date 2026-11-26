import { type Store, type Row } from '../storage/database.js';
import { type Manager } from './service.js';
import { randomId, type Json } from '../core/security.js';
import { FailureLog } from '../core/log.js';
import { retentionSettings } from '../storage/retention.js';
import { worktreesRemoved } from './worktrees.js';

/*
 * Scheduled removal of task workspaces from the project computers.
 *
 * Every task directory (/workspace/tasks/<workspace id>) the control plane uses for a task is recorded in task_workspaces
 * with that task: the task's own checkout, evaluator and role checkouts, the workspace a retry restores from, and one a
 * later review reuses (each task that uses it adds its own row). A sweep lists a computer's task directories through the
 * runner (names and last activity only), decides from these records and the tasks' current state which ones go, and
 * removes them through the runner a few at a time. The directory a task no longer needs is kept:
 *
 * - for an unfinished task (running, queued, preparing, retry_wait, waiting_*, paused, needs_*…), only the directories it
 *   can still use stay: its current workspace_id, open worktree bindings, resumable role-instance / CLI-state workspaces,
 *   pending retry/recovery/integration restore sources, undecided candidate checkouts, and anything active in the last
 *   half hour; directories from earlier attempts or published review rounds go at the next sweep (#1268);
 * - for a finished task that is the parent of an unfinished follow-up task, its directory stays until the follow-up ends;
 * - while the pull request a development task opened or revises is open; once it is closed or merged, at the next sweep.
 *   A review of a pull request that is closed goes at the next sweep too;
 * - otherwise for a day after the task's last update (succeeded, cancelled, superseded), a week when it failed.
 * A directory no record names (made before records existed, or by a conversation) goes a day after its last activity.
 * The day and the week are the defaults of the storage settings (workspace_finished_days, workspace_failed_days, #671);
 * a directory no record names follows the first.
 * A directory active in the last half hour, or used by this process then, stays whatever its owner.
 */
const hour = 3600_000, day = 24 * hour;
export const workspaceRetention = { finishedMs: day, failedMs: 7 * day, unownedMs: day, quietMs: hour / 2 };
/** The retention now in force: the saved storage settings, else the defaults above. */
function retentionMs(store: Store) {
  const saved = retentionSettings(store);
  return { finishedMs: saved.workspace_finished_days * day, failedMs: saved.workspace_failed_days * day, unownedMs: saved.workspace_finished_days * day };
}
// Directories per removal call, the pause between calls (other calls on the computer go first), and how long the
// records of removed directories stay.
export const sweepLimits = { batch: 10, pauseMs: 1000, releasedKeptMs: 30 * day };
const finished = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded'];
const ended = `(${[...finished, 'failed'].map(status => `'${status}'`).join(',')})`;
const workspaceId = /^[a-f0-9]{48}$/;

export function workspaceStorage(store: Store): void {
  // task_id is '' on the row recording the removal of a directory no record named. kind: how the task came to use it
  // ('task', 'checkout' for an evaluator's or role's checkout of a fixed candidate; recovered records: 'recovery',
  // 'integration', 'parent'). freed_bytes is per directory and repeats on each of its rows.
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_workspaces(repository_id TEXT NOT NULL,workspace_id TEXT NOT NULL,task_id TEXT NOT NULL,
      task_kind TEXT,object_number INTEGER,kind TEXT NOT NULL,created_at TEXT NOT NULL,released_at TEXT,release_reason TEXT,freed_bytes INTEGER,
      PRIMARY KEY(repository_id,workspace_id,task_id));
    CREATE INDEX IF NOT EXISTS task_workspaces_released ON task_workspaces(repository_id,released_at);`);
}

// In this process: when each workspace was last used, which (workspace, task) pairs are recorded, and the workspaces a
// removal call is deleting right now. Bounded; the oldest entries go first.
const lastUse = new Map<string, number>(), recorded = new Set<string>(), removing = new Set<string>();
const bounded = (collection: Map<string, number> | Set<string>) => { if (collection.size > 50_000) collection.delete(collection.keys().next().value!); };

/**
 * Records that a task uses a workspace, before a runner call for it. Workspace.call and deliver call it for the task
 * directory; binding a shared worktree (src/projects/worktrees.ts) calls it with the worktree's id and type 'worktree', and
 * an observer's or evaluator's directory that reads one is recorded with type 'checkout' (Workspace.observe).
 */
export function useWorkspace(store: Store | null, task: Row, type: string, now = Date.now()): void {
  if (!workspaceId.test(String(task.workspace_id || ''))) return;
  const key = `${task.repository_id}:${task.workspace_id}`, pair = `${key}:${task.id}`;
  lastUse.delete(key); lastUse.set(key, now); bounded(lastUse);
  // Conversations and service roles have no task row; their workspaces count as nobody's.
  if (!store || task.conversation_id || recorded.has(pair)) return;
  store.run(`INSERT INTO task_workspaces(repository_id,workspace_id,task_id,task_kind,object_number,kind,created_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(repository_id,workspace_id,task_id) DO UPDATE SET released_at=NULL,release_reason=NULL,freed_bytes=NULL WHERE released_at IS NOT NULL`,
  String(task.repository_id), task.workspace_id, String(task.id), task.kind ?? null, task.object_number ?? null, type === 'checkout' ? 'checkout' : type === 'worktree' ? 'worktree' : 'task', new Date(now).toISOString());
  recorded.add(pair); bounded(recorded);
}
/** True while a removal call is deleting the workspace: a review must not reuse it. */
export function workspaceRemoving(repository: string, workspace: string): boolean { return removing.has(`${repository}:${workspace}`); }

interface Listed { name: string; active_at: number }
interface Planned extends Listed { reason: string }
// Pull requests of the project: which are closed, the bot's by the task that opened them, and by the Issue developed.
interface PullRequests { closed: Set<number>; bySource: Map<string, number[]>; byIssue: Map<number, number[]> }
const push = <K>(map: Map<K, number[]>, key: K, value: number) => map.set(key, [...map.get(key) ?? [], value]);

function pullRequests(store: Store, repo: string): PullRequests {
  const closed = new Set(store.all("SELECT object_number FROM review_objects WHERE repository_id=? AND kind='review.pr' AND closed_at IS NOT NULL", repo).map(row => Number(row.object_number)));
  if (store.hasTable('bot_pr_states')) {
    for (const row of store.all("SELECT number FROM bot_pr_states WHERE repository_id=? AND lower(state)<>'open'", repo)) {
      closed.add(Number(row.number));
    }
  }
  const bot = store.all('SELECT number,source_task_id FROM bot_pull_requests WHERE repository_id=?', repo), bySource = new Map<string, number[]>(), byIssue = new Map<number, number[]>();
  for (const row of bot) push(bySource, String(row.source_task_id), Number(row.number));
  // Later developments of the same Issue continue the bot's pull request opened by the first one. The Issue number is read
  // from the board's covering index for legacy development.issue rows, and by primary key for generic task.request Issue rows.
  const sources = JSON.stringify([...bySource.keys()]);
  for (const row of store.all(`SELECT id,object_number FROM tasks INDEXED BY board_task_cover WHERE kind='development.issue' AND repository_id=?
    AND id IN (SELECT value FROM json_each(?))`, repo, sources)) for (const number of bySource.get(row.id) ?? []) push(byIssue, Number(row.object_number), number);
  for (const row of store.all(`SELECT id,object_number FROM tasks WHERE kind='task.request' AND repository_id=? AND object_number IS NOT NULL
    AND id IN (SELECT value FROM json_each(?)) AND json_extract(input,'$.target.type')='issue'`, repo, sources))
    for (const number of bySource.get(row.id) ?? []) push(byIssue, Number(row.object_number), number);
  return { closed, bySource, byIssue };
}

/** The listed directories that may go now, least recently active first, each with the rule that lets it go. */
export function removableWorkspaces(store: Store, repo: string, entries: Listed[], now = Date.now(), prs = pullRequests(store, repo)): Planned[] {
  const until = retention(store, repo, entries.map(entry => entry.name), prs), planned: Planned[] = [], { unownedMs } = retentionMs(store);
  for (const entry of entries) {
    const key = `${repo}:${entry.name}`;
    if (removing.has(key) || now - (lastUse.get(key) ?? 0) < workspaceRetention.quietMs || now - entry.active_at < workspaceRetention.quietMs) continue;
    const [time, reason] = until(entry.name, entry.active_at);
    if (reason === 'unowned' ? now - entry.active_at > unownedMs : now >= time) planned.push({ ...entry, reason });
  }
  return planned;
}

// The most one task of each project took on its computer at the last volume scan, per store (noteTaskUsage).
const taskUsage = new WeakMap<Store, Map<string, number>>();
/**
 * Records, from a computer's volume scan (the size of each task directory), the most disk one task of the project took
 * there: its task directories together, since a task checks out one for itself and one for each role or evaluator; a
 * directory no record names counts on its own. The directories a scan finds are the recent ones (they are removed a day
 * or a week after their task ends). StorageReport calls it once per scan; the task-start floor reads it (taskUsageBytes).
 */
export function noteTaskUsage(store: Store, repo: string, entries: { name: string; bytes: number }[]): number {
  const size = new Map(entries.map(entry => [entry.name, Math.max(0, Number(entry.bytes) || 0)])), perTask = new Map<string, number>();
  for (const row of store.all(`SELECT workspace_id,task_id FROM task_workspaces WHERE repository_id=? AND task_id<>'' AND workspace_id IN (SELECT value FROM json_each(?))`,
    repo, JSON.stringify([...size.keys()]))) perTask.set(row.task_id, (perTask.get(row.task_id) ?? 0) + (size.get(row.workspace_id) ?? 0));
  const most = Math.max(0, ...perTask.values(), ...size.values());
  let projects = taskUsage.get(store); if (!projects) taskUsage.set(store, projects = new Map());
  projects.set(repo, most);
  return most;
}
/** What noteTaskUsage last recorded for the project; 0 before its computer's first scan since this process started. */
export const taskUsageBytes = (store: Store, repo: string): number => taskUsage.get(store)?.get(repo) ?? 0;

/**
 * The storage page's view of a computer's task directories (#671), from its last volume scan: how many and how much
 * belong to tasks still running or waiting (active), are kept for a pull request that is open, or wait for their
 * removal under the rules above (expiring, including directories no record names).
 */
export function workspaceClasses(store: Store, repo: string, entries: { name: string; bytes: number }[]): Record<'active' | 'pull_request' | 'expiring', { count: number; bytes: number }> {
  const until = retention(store, repo, entries.map(entry => entry.name), pullRequests(store, repo));
  const classes = { active: { count: 0, bytes: 0 }, pull_request: { count: 0, bytes: 0 }, expiring: { count: 0, bytes: 0 } };
  for (const entry of entries) {
    const [, reason] = until(entry.name, 0), target = classes[reason === 'active' || reason === 'followup' ? 'active' : reason === 'pr_open' ? 'pull_request' : 'expiring'];
    target.count++; target.bytes += Math.max(0, Number(entry.bytes) || 0);
  }
  return classes;
}

// For each unfinished task in `unfinishedIds`, compute the exact set of workspace/worktree directories it can still use
// (#1268): current workspace_id, open worktree bindings, resumable role-instance / CLI-state workspaces, pending
// recovery/integration restore sources, development candidate source workspace, and undecided candidate checkouts.
interface UnfinishedState {
  keep: Map<string, Set<string>>;
  bindingTracked: Map<string, Set<string>>;
  roundCutoff: Map<string, string | null>;
}
const addId = (map: Map<string, Set<string>>, taskId: string, ws: unknown) => {
  const value = String(ws || '');
  if (!workspaceId.test(value)) return;
  let set = map.get(taskId);
  if (!set) map.set(taskId, set = new Set());
  set.add(value);
};

function unfinishedWorkspacesState(store: Store, repo: string, unfinishedIds: string[]): UnfinishedState {
  const keep = new Map<string, Set<string>>(), bindingTracked = new Map<string, Set<string>>(), roundCutoff = new Map<string, string | null>();
  if (!unfinishedIds.length) return { keep, bindingTracked, roundCutoff };
  const idList = JSON.stringify(unfinishedIds);
  const envGen = store.hasTable('project_environments')
    ? store.get('SELECT generation FROM project_environments WHERE repository_id=?', repo)?.generation ?? null
    : null;
  const taskInfo = new Map<string, { generation: number | null; phase: string | null }>();
  for (const row of store.all(
    `SELECT id,workspace_id,generation,phase,
       CASE WHEN json_valid(input) THEN json_extract(input,'$.recovery.source_workspace_id') END AS recovery_ws,
       CASE WHEN json_valid(input) THEN json_extract(input,'$.integration.source_workspace_id') END AS integration_ws,
       CASE WHEN json_valid(input) THEN json_extract(input,'$.round') END AS round_num,
        CASE WHEN json_valid(input) THEN coalesce(json_extract(input,'$.previous_result.finished_at'),json_extract(input,'$.previous_delivery.finished_at')) END AS prev_finished_at
     FROM tasks WHERE id IN (SELECT value FROM json_each(?))`,
    idList,
  )) {
    const id = String(row.id);
    taskInfo.set(id, { generation: row.generation == null ? null : Number(row.generation), phase: row.phase ? String(row.phase) : null });
    addId(keep, id, row.workspace_id);
    addId(keep, id, row.recovery_ws);
    addId(keep, id, row.integration_ws);
    roundCutoff.set(id, Number(row.round_num) > 1 && typeof row.prev_finished_at === 'string' && row.prev_finished_at ? row.prev_finished_at : null);
  }
  if (store.hasTable('worktree_bindings')) {
    for (const row of store.all(
      'SELECT task_id,worktree_id,workspace_id,released_at FROM worktree_bindings WHERE task_id IN (SELECT value FROM json_each(?))',
      idList,
    )) {
      const id = String(row.task_id);
      addId(bindingTracked, id, row.worktree_id);
      if (row.released_at == null) {
        addId(keep, id, row.worktree_id);
        addId(keep, id, row.workspace_id);
      }
    }
  }
  if (store.hasTable('role_instances')) {
    for (const row of store.all(
      'SELECT task_id,runtime,harness_state FROM role_instances WHERE task_id IN (SELECT value FROM json_each(?))',
      idList,
    )) {
      const id = String(row.task_id);
      const currentGen = taskInfo.get(id)?.generation ?? (envGen == null ? null : Number(envGen));
      try {
        const runtime = row.runtime ? JSON.parse(String(row.runtime)) : null;
        if (runtime && !runtime.guidance_retired && (currentGen == null || runtime.generation == null || Number(runtime.generation) === currentGen)) {
          addId(keep, id, runtime.workspace_id);
        }
      } catch {}
      try {
        const state = row.harness_state ? JSON.parse(String(row.harness_state)) : null;
        if (state?.stateWorkspaceId) addId(keep, id, state.stateWorkspaceId);
      } catch {}
    }
  }
  if (store.hasTable('development_candidates')) {
    for (const row of store.all(
      `SELECT task_id,json_extract(data,'$.source_workspace_id') AS source_ws FROM development_candidates WHERE task_id IN (SELECT value FROM json_each(?))`,
      idList,
    )) addId(keep, String(row.task_id), row.source_ws);
  }
  const decidedTasks = new Set<string>();
  if (store.hasTable('task_records')) {
    for (const row of store.all(
      'SELECT task_id,candidate,acceptance,pending FROM task_records WHERE task_id IN (SELECT value FROM json_each(?))',
      idList,
    )) {
      const id = String(row.task_id), phase = taskInfo.get(id)?.phase;
      let candidate: any = null, acceptance: any = null, pending: any = null;
      try { candidate = row.candidate ? JSON.parse(String(row.candidate)) : null; } catch {}
      try { acceptance = row.acceptance ? JSON.parse(String(row.acceptance)) : null; } catch {}
      try { pending = row.pending ? JSON.parse(String(row.pending)) : null; } catch {}
      const undecided = Boolean(
        pending != null || phase === 'acceptance' || phase === 'publish'
        || (candidate?.id && acceptance?.candidate_id !== candidate.id),
      );
      if (undecided && Array.isArray(candidate?.artifacts)) {
        for (const art of candidate.artifacts) {
          addId(keep, id, art?.content?.source_workspace_id);
          const m = /^workspace:([a-f0-9]{48})$/.exec(String(art?.reference || ''));
          if (m) addId(keep, id, m[1]);
        }
      }
      if (!undecided && candidate != null) decidedTasks.add(id);
    }
  }
  if (store.hasTable('task_history')) {
    // The newest checkout of each role, unless it belongs to an earlier review round.
    for (const [id, roles] of roleCandidates(store, unfinishedIds.filter(id => !decidedTasks.has(id)))) {
      const cutoff = roundCutoff.get(id);
      for (const row of roles.values()) {
        if (!cutoff || !row.created_at || String(row.created_at) > cutoff) {
          addId(keep, id, row.ws);
          addId(keep, id, row.wt);
        }
      }
    }
  }
  return { keep, bindingTracked, roundCutoff };
}

/*
 * The newest role_candidate of each role of a task: the checkout its role runs were given (src/roles/workspace.ts).
 * No index covers task_id with type, so `task_id=? AND type='role_candidate'` read every history row of the task: up to
 * 8 s for one long task in production, and the storage refresh every five minutes held the thread for over a minute
 * (#1398). A task's candidates are read once through the indexes there are: its runs from task_history_run (index
 * only), each run's candidates from task_history_run_type, and its rows without a run. After that only the rows added
 * since are read, a rowid range at the end of the table: ids only grow (AUTOINCREMENT), and a role_candidate row is
 * never rewritten (the payload migration moves only operation and runtime_log bodies).
 */
interface RoleCandidate { id: number; ws: unknown; wt: unknown; created_at: unknown }
interface CandidateCache { readTo: number; primed: boolean; tasks: Map<string, Map<string, RoleCandidate>> }
const candidateCaches = new WeakMap<Store, CandidateCache>();
const candidateColumns = `id,task_id,json_extract(data,'$.role') AS role,json_extract(data,'$.workspace_id') AS ws,json_extract(data,'$.worktree_id') AS wt,created_at`;
const noteCandidate = (roles: Map<string, RoleCandidate>, row: Row) => {
  const role = String(row.role ?? ''), id = Number(row.id);
  if ((roles.get(role)?.id ?? -1) < id) roles.set(role, { id, ws: row.ws, wt: row.wt, created_at: row.created_at });
};

function roleCandidates(store: Store, ids: string[]): Map<string, Map<string, RoleCandidate>> {
  const top = Number(store.get('SELECT max(id) AS id FROM task_history')?.id ?? 0);
  let cache = candidateCaches.get(store);
  if (!cache) candidateCaches.set(store, cache = { readTo: top, primed: false, tasks: new Map() });
  if (top > cache.readTo) {
    for (const row of store.all(`SELECT ${candidateColumns} FROM task_history WHERE id>? AND type='role_candidate'`, cache.readTo)) {
      const roles = cache.tasks.get(String(row.task_id));
      if (roles) noteCandidate(roles, row);
    }
    cache.readTo = top;
  }
  const missing = [...new Set(ids)].filter(id => !cache.tasks.has(id));
  if (missing.length) {
    const list = JSON.stringify(missing);
    const runs = store.all('SELECT DISTINCT run_id FROM task_history WHERE task_id IN (SELECT value FROM json_each(?)) AND run_id IS NOT NULL', list).map(row => row.run_id);
    const rows = [
      ...runs.length ? store.all(`SELECT ${candidateColumns} FROM task_history INDEXED BY task_history_run_type
        WHERE run_id IN (SELECT value FROM json_each(?)) AND type='role_candidate' AND task_id IN (SELECT value FROM json_each(?))`, JSON.stringify(runs), list) : [],
      ...store.all(`SELECT ${candidateColumns} FROM task_history INDEXED BY task_history_run
        WHERE task_id IN (SELECT value FROM json_each(?)) AND run_id IS NULL AND type='role_candidate'`, list),
    ];
    for (const id of missing) cache.tasks.set(id, new Map());
    for (const row of rows) noteCandidate(cache.tasks.get(String(row.task_id))!, row);
  }
  const result = new Map<string, Map<string, RoleCandidate>>();
  for (const id of ids) {
    // Used last goes last; past the bound, the tasks no one asked about for longest are dropped (read again if asked).
    const roles = cache.tasks.get(id)!;
    cache.tasks.delete(id); cache.tasks.set(id, roles); result.set(id, roles);
  }
  while (cache.tasks.size > 10_000) cache.tasks.delete(cache.tasks.keys().next().value!);
  return result;
}

/**
 * Reads the role checkouts of the unfinished tasks holding directories one task at a time, yielding between them, so the
 * first storage refresh or sweep after a start does not read them all in one block (#1398). Once per store.
 */
export async function primeRoleCandidates(store: Store): Promise<void> {
  if (!store.hasTable('task_history') || candidateCaches.get(store)?.primed) return;
  const ids = store.all(`SELECT DISTINCT tw.task_id FROM task_workspaces tw JOIN tasks t ON t.id=tw.task_id
    WHERE tw.released_at IS NULL AND tw.task_id<>'' AND t.status NOT IN ${ended}`).map(row => String(row.task_id));
  roleCandidates(store, []);
  for (const id of ids) {
    if (candidateCaches.get(store)!.tasks.has(id)) continue;
    roleCandidates(store, [id]);
    await new Promise(resolve => setImmediate(resolve));
  }
  candidateCaches.get(store)!.primed = true;
}

/**
 * Unfinished tasks holding unreleased workspace directories in a project (#1268), sorted by directory count descending
 * so runaway tasks are immediately visible on the storage page.
 */
export function unfinishedTaskWorkspaces(
  store: Store,
  repo: string,
  entries?: { name: string; bytes: number }[],
  limit = 50,
): { task_id: string; kind: string; status: string; object_number: number | null; attempt: number; directories: number; active: number; releasable: number; bytes: number | null }[] {
  const rows = store.all(
    `SELECT tw.task_id,tw.workspace_id,tw.kind AS ws_kind,tw.created_at,t.kind,t.status,t.object_number,t.attempt
     FROM task_workspaces tw JOIN tasks t ON t.id=tw.task_id
     WHERE tw.repository_id=? AND tw.released_at IS NULL AND tw.task_id<>'' AND t.status NOT IN ${ended}`,
    repo,
  );
  if (!rows.length) return [];
  const unfinishedIds = [...new Set(rows.map(row => String(row.task_id)))];
  const state = unfinishedWorkspacesState(store, repo, unfinishedIds);
  const sizes = entries ? new Map(entries.map(entry => [entry.name, Math.max(0, Number(entry.bytes) || 0)])) : null;
  const byTask = new Map<string, { task_id: string; kind: string; status: string; object_number: number | null; attempt: number; seen: Set<string>; active: number; releasable: number; bytes: number | null }>();
  for (const row of rows) {
    const id = String(row.task_id), ws = String(row.workspace_id);
    let item = byTask.get(id);
    if (!item) {
      byTask.set(id, item = {
        task_id: id, kind: String(row.kind || ''), status: String(row.status || ''),
        object_number: row.object_number == null ? null : Number(row.object_number),
        attempt: Number(row.attempt || 1), seen: new Set(), active: 0, releasable: 0, bytes: sizes ? 0 : null,
      });
    }
    if (item.seen.has(ws)) continue;
    item.seen.add(ws);
    const kept = Boolean(state.keep.get(id)?.has(ws) || (row.ws_kind === 'worktree' && !state.bindingTracked.get(id)?.has(ws)));
    if (kept) item.active++; else item.releasable++;
    if (sizes && sizes.has(ws)) item.bytes = (item.bytes ?? 0) + sizes.get(ws)!;
  }
  return [...byTask.values()]
    .map(({ seen, ...item }) => ({ ...item, directories: seen.size }))
    .sort((a, b) => b.directories - a.directories || (b.bytes ?? 0) - (a.bytes ?? 0) || a.task_id.localeCompare(b.task_id))
    .slice(0, limit);
}

// For the named directories: until when the tasks that use them need them, and why (Infinity keeps it; 'unowned' for a
// directory no record names, whose time comes from its own activity).
function retention(store: Store, repo: string, list: string[], prs: PullRequests): (name: string, activeAt: number) => [number, string] {
  const names = JSON.stringify(list), { finishedMs, failedMs, unownedMs } = retentionMs(store);
  const rows = store.all(`SELECT workspace_id,task_id,task_kind,object_number,kind,created_at FROM task_workspaces WHERE repository_id=? AND task_id<>''
    AND workspace_id IN (SELECT value FROM json_each(?))`, repo, names);
  const owners = JSON.stringify([...new Set(rows.map(row => row.task_id))]);
  // status precedes the task input in a tasks row, so this reads no more than the row's first page.
  const status = new Map(store.all('SELECT id,status FROM tasks WHERE id IN (SELECT value FROM json_each(?))', owners).map(row => [row.id, String(row.status)]));
  const unfinishedIds = [...status.entries()].filter(([, s]) => ![...finished, 'failed'].includes(s)).map(([id]) => String(id));
  const unfinished = unfinishedWorkspacesState(store, repo, unfinishedIds);
  const requestOwners = JSON.stringify([...new Set(rows.filter(row => row.task_kind === 'task.request' && Number(row.object_number) > 0).map(row => row.task_id))]);
  const requestMeta = new Map(
    store.all(
      `SELECT t.id, json_extract(t.input,'$.target.type') AS target_type,
        (json_extract(t.input,'$.delivery')='pull_request' OR EXISTS (
          SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request')
        )) AS has_pr_write
       FROM tasks t WHERE t.id IN (SELECT value FROM json_each(?))`,
      requestOwners,
    ).map(row => [String(row.id), { targetType: row.target_type ? String(row.target_type) : null, hasPrWrite: Boolean(row.has_pr_write) }]),
  );
  const parents = new Set(store.all(`SELECT DISTINCT f.parent_id FROM task_followups f JOIN tasks t ON t.id=f.task_id
    WHERE f.parent_id IN (SELECT value FROM json_each(?)) AND t.status NOT IN ${ended}`, owners).map(row => row.parent_id));
  // The last update comes from the board's covering index, one seek per object, for the same reason as above.
  const updated = new Map<string, number>(), groups = new Map<string, Row>();
  for (const row of rows) groups.set(JSON.stringify([row.task_kind, row.object_number]), row);
  for (const row of groups.values()) for (const task of store.all(`SELECT id,updated_at,created_at FROM tasks INDEXED BY board_task_cover
    WHERE kind=? AND repository_id=? AND object_number IS ?`, row.task_kind ?? '', repo, row.object_number ?? null))
    if (status.has(task.id)) updated.set(task.id, Math.max(Date.parse(task.updated_at) || 0, Date.parse(task.created_at) || 0));
  const byName = new Map<string, Row[]>();
  for (const row of rows) if (status.has(row.task_id)) byName.set(row.workspace_id, [...byName.get(row.workspace_id) ?? [], row]);
  // When a task stops needing the directory, and why: Infinity keeps it.
  const until = (row: Row, activeAt: number): [number, string] => {
    const state = status.get(row.task_id)!, number = Number(row.object_number), req = requestMeta.get(String(row.task_id));
    if (![...finished, 'failed'].includes(state)) {
      const taskId = String(row.task_id), ws = String(row.workspace_id);
      if (unfinished.keep.get(taskId)?.has(ws)) return [Infinity, 'active'];
      if (row.kind === 'worktree' && !unfinished.bindingTracked.get(taskId)?.has(ws)) return [Infinity, 'active'];
      const cutoff = unfinished.roundCutoff.get(taskId);
      if (cutoff && row.created_at && String(row.created_at) <= cutoff) return [0, 'superseded_round'];
      return [0, 'superseded_attempt'];
    }
    if (parents.has(row.task_id)) return [Infinity, 'followup'];
    const isPrDev = row.task_kind === 'development.pr' || (row.task_kind === 'task.request' && req?.targetType === 'pr' && req.hasPrWrite);
    const isIssueDev = row.task_kind === 'development.issue' || (row.task_kind === 'task.request' && req?.targetType === 'issue' && req.hasPrWrite);
    const pulls = [...prs.bySource.get(row.task_id) ?? [], ...(isPrDev ? [number] : []), ...(isIssueDev ? prs.byIssue.get(number) ?? [] : [])];
    if (pulls.length) return pulls.some(pr => !prs.closed.has(pr)) ? [Infinity, 'pr_open'] : [0, 'pr_closed'];
    if ((row.task_kind === 'review.pr' || (row.task_kind === 'task.request' && req?.targetType === 'pr')) && prs.closed.has(number)) return [0, 'pr_closed'];
    const last = Math.max(updated.get(row.task_id) ?? 0, activeAt);
    return state === 'failed' ? [last + failedMs, 'failed'] : [last + finishedMs, 'finished'];
  };
  return (name, activeAt) => {
    const owned = byName.get(name);
    if (!owned) return [activeAt + unownedMs, 'unowned'];
    // The task that needs it longest decides.
    return owned.map(row => until(row, activeAt)).reduce((a, b) => b[0] > a[0] ? b : a);
  };
}

// Records for tasks that were not finished when records began: their workspace, the one a retry restores from or
// integrates, and a follow-up's parent's. Once, before the first removal; reading a task's input walks about 1 MB, so
// it runs in steps of 5 tasks.
async function recoverRecords(store: Store): Promise<void> {
  if (store.get("SELECT 1 FROM settings WHERE key='workspace_records_recovered'")) return;
  const tasks = store.all(`SELECT id,repository_id,kind,object_number FROM tasks INDEXED BY board_task_cover WHERE status NOT IN ${ended}`);
  const add = (task: Row, workspace: unknown, kind: string) => { if (workspaceId.test(String(workspace || ''))) store.run(`INSERT OR IGNORE INTO task_workspaces(repository_id,workspace_id,task_id,task_kind,object_number,kind,created_at)
    VALUES(?,?,?,?,?,?,?)`, task.repository_id, String(workspace), task.id, task.kind, task.object_number ?? null, kind, new Date().toISOString()); };
  for (let index = 0; index < tasks.length; index += 5) {
    for (const task of tasks.slice(index, index + 5)) {
      let row: Row | undefined;
      try { row = store.get(`SELECT workspace_id,source_task_id,json_extract(input,'$.recovery.source_workspace_id') AS recovery,
        json_extract(input,'$.integration.source_workspace_id') AS integration FROM tasks WHERE id=?`, task.id); }
      catch { row = store.get('SELECT workspace_id,source_task_id FROM tasks WHERE id=?', task.id); }
      if (!row) continue;
      add(task, row.workspace_id, 'task'); add(task, row.recovery, 'recovery'); add(task, row.integration, 'integration');
      const parent = row.source_task_id ? store.get(`SELECT t.id,t.repository_id,t.kind,t.object_number,t.workspace_id FROM task_followups f JOIN tasks t ON t.id=f.parent_id
        WHERE f.task_id=? AND f.parent_id=?`, task.id, row.source_task_id) : undefined;
      if (parent) add(parent, parent.workspace_id, 'parent');
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  store.run("INSERT OR IGNORE INTO settings VALUES('workspace_records_recovered',?)", new Date().toISOString());
}

/** The scheduled sweep: shortly after start, then every hour, one project computer after another. */
export class WorkspaceCleanup {
  private first: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<{ count: number; bytes: number; failed: number }> | null = null;
  private closing = false;
  private readonly failures = new FailureLog('workspaces');
  constructor(readonly store: Store, readonly manager: Manager, readonly options: { firstDelayMs?: number; intervalMs?: number; pauseMs?: number; skip?: (repo: string) => boolean } = {}) {}
  start(): void {
    this.first = setTimeout(() => void this.run(), this.options.firstDelayMs ?? 5 * 60_000); this.first.unref();
    this.timer = setInterval(() => void this.run(), this.options.intervalMs ?? hour); this.timer.unref();
  }
  /** One sweep of every project; a sweep still running is returned instead of starting another. */
  run() {
    if (this.closing) return Promise.resolve({ count: 0, bytes: 0, failed: 1 });
    this.running ??= this.sweep().catch(error => { this.failures.report('sweep', error); return { count: 0, bytes: 0, failed: 1 }; }).finally(() => { this.running = null; });
    return this.running;
  }
  // Stops scheduling; a removal call already sent finishes on the computer, and the next start lists what is left.
  close(): void { this.closing = true; clearTimeout(this.first); clearInterval(this.timer); }
  private async sweep() {
    const total = { count: 0, bytes: 0, failed: 0 };
    await recoverRecords(this.store);
    await primeRoleCandidates(this.store);
    for (const { id } of this.store.all('SELECT r.id FROM repositories r JOIN policies p ON p.repository_id=r.id ORDER BY r.id')) {
      if (this.closing) { total.failed++; break; }
      if (this.options.skip?.(id)) continue;
      try { const result = await this.project(id); if (result) { total.count += result.removed; total.bytes += result.bytes; } this.failures.clear('project ' + id); } catch (error) { total.failed++; this.failures.report('project ' + id, error); }
      // Records of directories removed a month ago have served their purpose.
      this.store.run('DELETE FROM task_workspaces WHERE rowid IN (SELECT rowid FROM task_workspaces WHERE repository_id=? AND released_at<? LIMIT 5000)',
        id, new Date(Date.now() - sweepLimits.releasedKeptMs).toISOString());
    }
    return total;
  }
  private async runner(repo: string, generation: number, request: Json, timeoutMs: number): Promise<any> {
    const response = await this.manager.call('POST', `/v1/projects/${repo}/execute`, { operation_id: randomId(), generation, request }, timeoutMs);
    if (!response?.ok) throw new Error(`${request.type}: ${response?.error || 'no answer'}${response?.detail ? ` (${response.detail})` : ''}`);
    return response.result;
  }
  private release(repo: string, items: { name: string; bytes: number | null; reason: string; active_at?: number }[], worktrees = false): void {
    const now = new Date().toISOString();
    this.store.transaction(() => { for (const item of items) {
      if (worktrees) worktreesRemoved(this.store, repo, [item.name], item.reason);
      // A task directory's plan of the worktree it was to get (#769) goes with the directory.
      else this.store.run('DELETE FROM worktree_plans WHERE repository_id=? AND workspace_id=?', repo, item.name);
      const changed = this.store.run(`UPDATE task_workspaces SET released_at=?,release_reason=?,freed_bytes=? WHERE repository_id=? AND workspace_id=?`,
        now, item.reason, item.bytes, repo, item.name).changes;
      if (!Number(changed)) this.store.run(`INSERT OR IGNORE INTO task_workspaces(repository_id,workspace_id,task_id,kind,created_at,released_at,release_reason,freed_bytes)
        VALUES(?,?,'','unrecorded',?,?,?,?)`, repo, item.name, new Date(item.active_at ?? Date.now()).toISOString(), now, item.reason, item.bytes);
    } });
  }
  private async project(repo: string) {
    const environment = await this.manager.call('GET', '/v1/projects/' + repo);
    if (!environment || !['ready', 'busy'].includes(environment.state)) return;
    const prs = pullRequests(this.store, repo), tasks = await this.pass(repo, environment.generation, prs, false), worktrees = await this.pass(repo, environment.generation, prs, true);
    const removed = tasks.removed + worktrees.removed, bytes = tasks.bytes + worktrees.bytes, skipped = tasks.skipped + worktrees.skipped;
    const reasons: Record<string, number> = {};
    for (const map of [tasks.reasons, worktrees.reasons]) for (const [reason, n] of Object.entries(map)) reasons[reason] = (reasons[reason] ?? 0) + n;
    const reasonSummary = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r, n]) => `${r}=${n}`).join(', ');
    if (removed || skipped || reasonSummary) console.log(`[workspaces] project ${repo}: removed ${tasks.removed} task directories and ${worktrees.removed} worktrees (${Math.round(bytes / 1024 / 1024)} MiB), ${skipped} skipped${reasonSummary ? ` (${reasonSummary})` : ''}; ${tasks.total} and ${worktrees.total} were there`);
    // What this sweep freed, for the storage page (#671).
    const swept = JSON.parse(this.store.get("SELECT value FROM settings WHERE key='workspace_cleanup'")?.value ?? '{}');
    swept[repo] = { at: new Date().toISOString(), removed, bytes, skipped, reasons };
    this.store.run("INSERT INTO settings VALUES('workspace_cleanup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(swept));
    return { removed, bytes };
  }
  // One kind of directory on the computer: the task directories, or the shared worktrees (#769), each listed and removed
  // through its own runner calls. A worktree's rows (kind 'worktree') come from its bindings; the same retention applies.
  private async pass(repo: string, generation: number, prs: PullRequests, worktrees: boolean): Promise<{ removed: number; bytes: number; skipped: number; total: number; reasons: Record<string, number> }> {
    const listing = await this.runner(repo, generation, { type: worktrees ? 'worktrees_list' : 'tasks_list' }, 10 * 60_000);
    const entries: Listed[] = (Array.isArray(listing?.entries) ? listing.entries : [])
      .filter((entry: any) => workspaceId.test(String(entry?.name)) && Number.isSafeInteger(entry.active_at));
    const reasonCounts: Record<string, number> = {};
    const countReason = (reason: string) => { reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1; };
    // With the whole directory listed, recorded workspaces it lacks are gone (removed by hand, or a reset started a new
    // work volume). A record younger than an hour may be one whose directory the runner is creating right now.
    if (listing?.total === entries.length) {
      const present = new Set(entries.map(entry => entry.name)), before = new Date(Date.now() - hour).toISOString();
      const gone = this.store.all(`SELECT DISTINCT workspace_id FROM task_workspaces WHERE repository_id=? AND released_at IS NULL AND created_at<? AND kind${worktrees ? '=' : '<>'}'worktree'`, repo, before)
        .filter(row => !present.has(row.workspace_id)).map(row => ({ name: String(row.workspace_id), bytes: null, reason: 'missing' }));
      if (gone.length) { this.release(repo, gone, worktrees); for (const item of gone) countReason(item.reason); }
    }
    const planned = removableWorkspaces(this.store, repo, entries, Date.now(), prs);
    let removed = 0, bytes = 0, skipped = 0;
    for (let index = 0; index < planned.length && !this.closing; index += sweepLimits.batch) {
      if (index) await new Promise(resolve => setTimeout(resolve, this.options.pauseMs ?? sweepLimits.pauseMs));
      // Decided again right before sending: since the listing a task may have started using one of them.
      const batch = removableWorkspaces(this.store, repo, planned.slice(index, index + sweepLimits.batch), Date.now(), prs);
      if (!batch.length) continue;
      const keys = batch.map(entry => `${repo}:${entry.name}`); for (const key of keys) removing.add(key);
      let result: any;
      try { result = await this.runner(repo, generation, { type: worktrees ? 'worktrees_remove' : 'tasks_remove', entries: batch.map(({ name, active_at }) => ({ name, active_at })) }, 60 * 60_000); }
      finally { for (const key of keys) removing.delete(key); }
      const reasons = new Map(batch.map(entry => [entry.name, entry])), done: { name: string; bytes: number | null; reason: string; active_at?: number }[] = [];
      for (const item of Array.isArray(result?.removed) ? result.removed : []) if (reasons.has(item.name)) {
        const reason = reasons.get(item.name)!.reason;
        done.push({ name: item.name, bytes: Number.isSafeInteger(item.bytes) ? item.bytes : null, reason, active_at: reasons.get(item.name)!.active_at });
        removed++; bytes += Number.isSafeInteger(item.bytes) ? item.bytes : 0; countReason(reason);
      }
      for (const item of Array.isArray(result?.skipped) ? result.skipped : []) {
        if (item?.reason === 'missing' && reasons.has(item.name)) { done.push({ name: item.name, bytes: null, reason: 'missing', active_at: reasons.get(item.name)!.active_at }); countReason('missing'); }
        else skipped++;
      }
      if (done.length) this.release(repo, done, worktrees);
    }
    return { removed, bytes, skipped, total: Number(listing?.total ?? entries.length), reasons: reasonCounts };
  }
}
