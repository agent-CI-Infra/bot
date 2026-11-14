import { type Store, type Row } from '../storage/database.js';
import { type Manager } from './service.js';
import { randomId, type Json } from '../core/security.js';
import { FailureLog } from '../core/log.js';
import { retentionSettings } from '../storage/retention.js';

/*
 * Scheduled removal of task workspaces from the project computers.
 *
 * Every task directory (/workspace/tasks/<workspace id>) the control plane uses for a task is recorded in task_workspaces
 * with that task: the task's own checkout, evaluator and role checkouts, the workspace a retry restores from, and one a
 * later review reuses (each task that uses it adds its own row). A sweep lists a computer's task directories through the
 * runner (names and last activity only), decides from these records and the tasks' current state which ones go, and
 * removes them through the runner a few at a time. The directory a task no longer needs is kept:
 *
 * - while any task using it is not finished (running, queued, preparing, retry_wait, waiting_*, paused, needs_*…), or
 *   is the parent of such a follow-up task, which restores its parent's result from it;
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

/** Records that a task uses a workspace, before a runner call for it. Workspace.call and deliver call it. */
export function useWorkspace(store: Store | null, task: Row, type: string, now = Date.now()): void {
  if (!workspaceId.test(String(task.workspace_id || ''))) return;
  const key = `${task.repository_id}:${task.workspace_id}`, pair = `${key}:${task.id}`;
  lastUse.delete(key); lastUse.set(key, now); bounded(lastUse);
  // Conversations and service roles have no task row; their workspaces count as nobody's.
  if (!store || task.conversation_id || recorded.has(pair)) return;
  store.run(`INSERT INTO task_workspaces(repository_id,workspace_id,task_id,task_kind,object_number,kind,created_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(repository_id,workspace_id,task_id) DO UPDATE SET released_at=NULL,release_reason=NULL,freed_bytes=NULL WHERE released_at IS NOT NULL`,
  String(task.repository_id), task.workspace_id, String(task.id), task.kind ?? null, task.object_number ?? null, type === 'workspace_acceptance' ? 'checkout' : 'task', new Date(now).toISOString());
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
  const bot = store.all('SELECT number,source_task_id FROM bot_pull_requests WHERE repository_id=?', repo), bySource = new Map<string, number[]>(), byIssue = new Map<number, number[]>();
  for (const row of bot) push(bySource, String(row.source_task_id), Number(row.number));
  // Later developments of the same Issue continue the bot's pull request opened by the first one. The Issue number is read
  // from the board's covering index: a tasks row holds the task input (about 1 MB in production) before object_number.
  const sources = JSON.stringify([...bySource.keys()]);
  for (const row of store.all(`SELECT id,object_number FROM tasks INDEXED BY board_task_cover WHERE kind='development.issue' AND repository_id=?
    AND id IN (SELECT value FROM json_each(?))`, repo, sources)) for (const number of bySource.get(row.id) ?? []) push(byIssue, Number(row.object_number), number);
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

// For the named directories: until when the tasks that use them need them, and why (Infinity keeps it; 'unowned' for a
// directory no record names, whose time comes from its own activity).
function retention(store: Store, repo: string, list: string[], prs: PullRequests): (name: string, activeAt: number) => [number, string] {
  const names = JSON.stringify(list), { finishedMs, failedMs, unownedMs } = retentionMs(store);
  const rows = store.all(`SELECT workspace_id,task_id,task_kind,object_number FROM task_workspaces WHERE repository_id=? AND task_id<>''
    AND workspace_id IN (SELECT value FROM json_each(?))`, repo, names);
  const owners = JSON.stringify([...new Set(rows.map(row => row.task_id))]);
  // status precedes the task input in a tasks row, so this reads no more than the row's first page.
  const status = new Map(store.all('SELECT id,status FROM tasks WHERE id IN (SELECT value FROM json_each(?))', owners).map(row => [row.id, String(row.status)]));
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
    const state = status.get(row.task_id)!, number = Number(row.object_number);
    if (![...finished, 'failed'].includes(state)) return [Infinity, 'active'];
    if (parents.has(row.task_id)) return [Infinity, 'followup'];
    const pulls = [...prs.bySource.get(row.task_id) ?? [], ...row.task_kind === 'development.pr' ? [number] : [], ...row.task_kind === 'development.issue' ? prs.byIssue.get(number) ?? [] : []];
    if (pulls.length) return pulls.some(pr => !prs.closed.has(pr)) ? [Infinity, 'pr_open'] : [0, 'pr_closed'];
    if (row.task_kind === 'review.pr' && prs.closed.has(number)) return [0, 'pr_closed'];
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
  private running: Promise<void> | null = null;
  private closing = false;
  private readonly failures = new FailureLog('workspaces');
  constructor(readonly store: Store, readonly manager: Manager, readonly options: { firstDelayMs?: number; intervalMs?: number; pauseMs?: number; skip?: (repo: string) => boolean } = {}) {}
  start(): void {
    this.first = setTimeout(() => void this.run(), this.options.firstDelayMs ?? 5 * 60_000); this.first.unref();
    this.timer = setInterval(() => void this.run(), this.options.intervalMs ?? hour); this.timer.unref();
  }
  /** One sweep of every project; a sweep still running is returned instead of starting another. */
  run(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.running ??= this.sweep().catch(error => this.failures.report('sweep', error)).finally(() => { this.running = null; });
    return this.running;
  }
  // Stops scheduling; a removal call already sent finishes on the computer, and the next start lists what is left.
  close(): void { this.closing = true; clearTimeout(this.first); clearInterval(this.timer); }
  private async sweep(): Promise<void> {
    await recoverRecords(this.store);
    for (const { id } of this.store.all('SELECT r.id FROM repositories r JOIN policies p ON p.repository_id=r.id ORDER BY r.id')) {
      if (this.closing) return;
      if (this.options.skip?.(id)) continue;
      try { await this.project(id); this.failures.clear('project ' + id); } catch (error) { this.failures.report('project ' + id, error); }
      // Records of directories removed a month ago have served their purpose.
      this.store.run('DELETE FROM task_workspaces WHERE rowid IN (SELECT rowid FROM task_workspaces WHERE repository_id=? AND released_at<? LIMIT 5000)',
        id, new Date(Date.now() - sweepLimits.releasedKeptMs).toISOString());
    }
  }
  private async runner(repo: string, generation: number, request: Json, timeoutMs: number): Promise<any> {
    const response = await this.manager.call('POST', `/v1/projects/${repo}/execute`, { operation_id: randomId(), generation, request }, timeoutMs);
    if (!response?.ok) throw new Error(`${request.type}: ${response?.error || 'no answer'}${response?.detail ? ` (${response.detail})` : ''}`);
    return response.result;
  }
  private release(repo: string, items: { name: string; bytes: number | null; reason: string; active_at?: number }[]): void {
    const now = new Date().toISOString();
    this.store.transaction(() => { for (const item of items) {
      const changed = this.store.run(`UPDATE task_workspaces SET released_at=?,release_reason=?,freed_bytes=? WHERE repository_id=? AND workspace_id=?`,
        now, item.reason, item.bytes, repo, item.name).changes;
      if (!Number(changed)) this.store.run(`INSERT OR IGNORE INTO task_workspaces(repository_id,workspace_id,task_id,kind,created_at,released_at,release_reason,freed_bytes)
        VALUES(?,?,'','unrecorded',?,?,?,?)`, repo, item.name, new Date(item.active_at ?? Date.now()).toISOString(), now, item.reason, item.bytes);
    } });
  }
  private async project(repo: string): Promise<void> {
    const environment = await this.manager.call('GET', '/v1/projects/' + repo);
    if (!environment || !['ready', 'busy'].includes(environment.state)) return;
    const listing = await this.runner(repo, environment.generation, { type: 'tasks_list' }, 10 * 60_000);
    const entries: Listed[] = (Array.isArray(listing?.entries) ? listing.entries : [])
      .filter((entry: any) => workspaceId.test(String(entry?.name)) && Number.isSafeInteger(entry.active_at));
    // With the whole tasks directory listed, recorded workspaces it lacks are gone (removed by hand, or a reset started a
    // new work volume). A record younger than an hour may be one whose directory the runner is creating right now.
    if (listing?.total === entries.length) {
      const present = new Set(entries.map(entry => entry.name)), before = new Date(Date.now() - hour).toISOString();
      const gone = this.store.all('SELECT DISTINCT workspace_id FROM task_workspaces WHERE repository_id=? AND released_at IS NULL AND created_at<?', repo, before)
        .filter(row => !present.has(row.workspace_id)).map(row => ({ name: String(row.workspace_id), bytes: null, reason: 'missing' }));
      if (gone.length) this.release(repo, gone);
    }
    const prs = pullRequests(this.store, repo), planned = removableWorkspaces(this.store, repo, entries, Date.now(), prs);
    let removed = 0, bytes = 0, skipped = 0;
    for (let index = 0; index < planned.length && !this.closing; index += sweepLimits.batch) {
      if (index) await new Promise(resolve => setTimeout(resolve, this.options.pauseMs ?? sweepLimits.pauseMs));
      // Decided again right before sending: since the listing a task may have started using one of them.
      const batch = removableWorkspaces(this.store, repo, planned.slice(index, index + sweepLimits.batch), Date.now(), prs);
      if (!batch.length) continue;
      const keys = batch.map(entry => `${repo}:${entry.name}`); for (const key of keys) removing.add(key);
      let result: any;
      try { result = await this.runner(repo, environment.generation, { type: 'tasks_remove', entries: batch.map(({ name, active_at }) => ({ name, active_at })) }, 60 * 60_000); }
      finally { for (const key of keys) removing.delete(key); }
      const reasons = new Map(batch.map(entry => [entry.name, entry])), done: { name: string; bytes: number | null; reason: string; active_at?: number }[] = [];
      for (const item of Array.isArray(result?.removed) ? result.removed : []) if (reasons.has(item.name)) {
        done.push({ name: item.name, bytes: Number.isSafeInteger(item.bytes) ? item.bytes : null, reason: reasons.get(item.name)!.reason, active_at: reasons.get(item.name)!.active_at });
        removed++; bytes += Number.isSafeInteger(item.bytes) ? item.bytes : 0;
      }
      for (const item of Array.isArray(result?.skipped) ? result.skipped : []) {
        if (item?.reason === 'missing' && reasons.has(item.name)) done.push({ name: item.name, bytes: null, reason: 'missing', active_at: reasons.get(item.name)!.active_at });
        else skipped++;
      }
      if (done.length) this.release(repo, done);
    }
    if (removed || skipped) console.log(`[workspaces] project ${repo}: removed ${removed} task directories (${Math.round(bytes / 1024 / 1024)} MiB), ${skipped} skipped; ${listing?.total ?? entries.length} were there`);
    // What this sweep freed, for the storage page (#671).
    const swept = JSON.parse(this.store.get("SELECT value FROM settings WHERE key='workspace_cleanup'")?.value ?? '{}');
    swept[repo] = { at: new Date().toISOString(), removed, bytes, skipped };
    this.store.run("INSERT INTO settings VALUES('workspace_cleanup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(swept));
  }
}
