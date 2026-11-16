import { type Store, type Row } from '../storage/database.js';
import { useWorkspace, workspaceRemoving } from './workspace-cleanup.js';

/*
 * The project computer's shared git worktrees (#769).
 *
 * A worktree is /workspace/worktrees/<id> on the computer, a git worktree of the computer's store; a task uses one through
 * the link /workspace/tasks/<workspace id>/repo (runner/workspace.mjs). `worktrees` records each one: the computer
 * generation it was made on, the commit it holds (HEAD and HEAD's tree), the mode it was made for and whether it may be
 * handed over (state). `worktree_bindings` records each time a task took one, with the commit it got: the evidence of which
 * worktree a run used.
 *
 * Until the controller chooses itself, the system chooses while a task prepares:
 * - a task that only reads (a review, event work) takes a worktree made for reading at the same commit that no unfinished
 *   task holds, after the runner checked its HEAD, tree and that it has no changes; otherwise it gets a new one;
 * - a task that writes (development, requests) gets a new worktree of its own, never handed to another task by the system.
 * A worktree that fails the check at a handover (changed by its last task, moved, gone) is not offered again.
 *
 * A binding holds until its task takes another workspace (a new attempt) or ends; one whose task ended is released when
 * found. Each binding also adds a task_workspaces row for the worktree, so the scheduled cleanup keeps it while any task
 * that used it needs it, by the same rules as task directories (src/projects/workspace-cleanup.ts).
 *
 * A task that prepares through the computer's git store gets no worktree right away: `worktree_plans` records the commit it
 * works on and the mode the system would give it. The task's controller (runTeam), or its agent when the task runs without
 * a role team, may choose (list_workspaces, use_workspace, create_workspace; src/agent/workspace-tools.ts); when the task
 * first needs its files without a choice, the system's choice above applies. A plan is `planned` until then and `bound`
 * once the task holds a worktree. A task that never needs its files never binds one.
 */
export type WorktreeMode = 'read' | 'write';
const ended = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed'];

export function worktreeStorage(store: Store): void {
  // state: ready (may be handed over), refused (failed the check at a handover), removed (gone from the computer).
  store.db.exec(`CREATE TABLE IF NOT EXISTS worktrees(repository_id TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,head_sha TEXT NOT NULL,
      tree_sha TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,used_at TEXT NOT NULL,state_reason TEXT,
      PRIMARY KEY(repository_id,id));
    CREATE INDEX IF NOT EXISTS worktrees_head ON worktrees(repository_id,generation,head_sha,state);
    CREATE TABLE IF NOT EXISTS worktree_bindings(id INTEGER PRIMARY KEY,repository_id TEXT NOT NULL,worktree_id TEXT NOT NULL,task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,mode TEXT NOT NULL,head_sha TEXT NOT NULL,tree_sha TEXT NOT NULL,bound_at TEXT NOT NULL,released_at TEXT,release_reason TEXT);
    CREATE INDEX IF NOT EXISTS worktree_bindings_worktree ON worktree_bindings(repository_id,worktree_id,released_at);
    CREATE INDEX IF NOT EXISTS worktree_bindings_task ON worktree_bindings(task_id,released_at);
    CREATE TABLE IF NOT EXISTS worktree_plans(task_id TEXT NOT NULL,workspace_id TEXT NOT NULL,repository_id TEXT NOT NULL,head_sha TEXT NOT NULL,tree_sha TEXT NOT NULL,
      mode TEXT NOT NULL,author_email TEXT,state TEXT NOT NULL,decided_by TEXT,reason TEXT,created_at TEXT NOT NULL,decided_at TEXT,PRIMARY KEY(task_id,workspace_id));
    CREATE INDEX IF NOT EXISTS worktree_plans_workspace ON worktree_plans(repository_id,workspace_id);`);
}

const now = () => new Date().toISOString();
// status precedes the task input in a tasks row, so this reads no more than the row's first page.
const taskEnded = (store: Store, taskId: string) => { const status = store.get('SELECT status FROM tasks WHERE id=?', taskId)?.status; return !status || ended.includes(String(status)); };

/** The bindings of the worktree that still hold; those whose task ended are released on the way. */
export function heldBy(store: Store, repo: string, worktree: string): Row[] {
  const rows = store.all('SELECT * FROM worktree_bindings WHERE repository_id=? AND worktree_id=? AND released_at IS NULL', repo, worktree), held: Row[] = [];
  for (const row of rows) {
    if (taskEnded(store, row.task_id)) store.run("UPDATE worktree_bindings SET released_at=?,release_reason='task_ended' WHERE id=? AND released_at IS NULL", now(), row.id);
    else held.push(row);
  }
  return held;
}

/** Releases the task's bindings, except the one of its current workspace when given. */
export function releaseWorktrees(store: Store, taskId: string, reason: string, keepWorkspace?: string | null): void {
  store.run(`UPDATE worktree_bindings SET released_at=?,release_reason=? WHERE task_id=? AND released_at IS NULL${keepWorkspace ? ' AND workspace_id<>?' : ''}`,
    now(), reason, taskId, ...keepWorkspace ? [keepWorkspace] : []);
}

/** The task's binding for its current workspace, if it holds one. */
export function taskWorktree(store: Store, task: Row): Row | undefined {
  if (!task.workspace_id) return undefined;
  return store.get('SELECT * FROM worktree_bindings WHERE task_id=? AND workspace_id=? AND released_at IS NULL ORDER BY id DESC LIMIT 1', task.id, task.workspace_id);
}

/** What a task is to get when it first needs its files (#769), for its current workspace. */
export interface WorktreePlan { task_id: string; workspace_id: string; repository_id: string; head_sha: string; tree_sha: string; mode: WorktreeMode; author_email: string | null;
  state: 'planned' | 'bound'; decided_by: string | null }
export function taskPlan(store: Store, task: Row): WorktreePlan | undefined {
  return task.workspace_id ? store.get('SELECT * FROM worktree_plans WHERE task_id=? AND workspace_id=?', String(task.id), String(task.workspace_id)) as WorktreePlan | undefined : undefined;
}
/** Records the plan of the task's current workspace; a plan made again (a retry of the same workspace) is replaced. */
export function planWorktree(store: Store, task: Row, head: string, tree: string, mode: WorktreeMode, author: string | null): void {
  store.run(`INSERT INTO worktree_plans(task_id,workspace_id,repository_id,head_sha,tree_sha,mode,author_email,state,created_at) VALUES(?,?,?,?,?,?,?,'planned',?)
    ON CONFLICT(task_id,workspace_id) DO UPDATE SET head_sha=excluded.head_sha,tree_sha=excluded.tree_sha,mode=excluded.mode,author_email=excluded.author_email,state='planned',
      decided_by=NULL,reason=NULL,decided_at=NULL`, String(task.id), String(task.workspace_id), String(task.repository_id), head, tree, mode, author, now());
}
/** The plan was carried out: the task holds its worktree (state bound). */
export function decidePlan(store: Store, task: Row, state: 'planned' | 'bound', by: string): void {
  store.run('UPDATE worktree_plans SET state=?,decided_by=?,decided_at=? WHERE task_id=? AND workspace_id=?', state, by, now(), String(task.id), String(task.workspace_id));
}
/**
 * A review moved to a new head of its pull request (#770): one without a worktree yet follows it by its plan alone, one
 * holding a worktree after the worktree moved in place. Either way the plan names the commit the task now works on.
 */
export function movePlan(store: Store, task: Row, head: string, tree: string): void {
  store.run('UPDATE worktree_plans SET head_sha=?,tree_sha=? WHERE task_id=? AND workspace_id=?', head, tree, String(task.id), String(task.workspace_id));
}

/** The project's worktrees on the computer of this generation, newest use first, with the bindings that hold each. */
export function listWorktrees(store: Store, repo: string, generation: number, limit = 30): (Row & { holders: Row[] })[] {
  return store.all("SELECT * FROM worktrees WHERE repository_id=? AND generation=? AND state<>'removed' ORDER BY used_at DESC,id LIMIT ?", repo, generation, limit)
    .filter(row => !workspaceRemoving(repo, row.id)).map(row => ({ ...row, holders: heldBy(store, repo, row.id) }));
}

/** Worktrees a reading task may take for this commit: made for reading, ready, held by no unfinished task, newest use first. */
export function reusableWorktrees(store: Store, repo: string, generation: number, head: string): Row[] {
  return store.all(`SELECT * FROM worktrees WHERE repository_id=? AND generation=? AND head_sha=? AND state='ready' AND mode='read' ORDER BY used_at DESC,id LIMIT 20`,
    repo, generation, head).filter(row => !workspaceRemoving(repo, row.id) && !heldBy(store, repo, row.id).length);
}

// The binding row, the cleanup's record that the task uses the worktree, and the worktree's last use.
function bind(store: Store, task: Row, worktree: string, mode: WorktreeMode, head: string, tree: string): number {
  useWorkspace(store, { ...task, workspace_id: worktree }, 'worktree');
  store.run('UPDATE worktrees SET used_at=? WHERE repository_id=? AND id=?', now(), String(task.repository_id), worktree);
  return Number(store.run(`INSERT INTO worktree_bindings(repository_id,worktree_id,task_id,workspace_id,mode,head_sha,tree_sha,bound_at) VALUES(?,?,?,?,?,?,?,?)`,
    String(task.repository_id), worktree, String(task.id), String(task.workspace_id), mode, head, tree, now()).lastInsertRowid);
}

/**
 * Takes an existing worktree for the task before the runner checks it, in one transaction with the check of who else holds
 * it: a writer only one nobody holds; a reader one no writer holds, and with `share` false (the system's own choice) one
 * nobody holds. The binding records the commit the task asked for. Null when it is taken meanwhile.
 */
export function claimWorktree(store: Store, task: Row, worktree: Row, mode: WorktreeMode, share = false, head = String(worktree.head_sha), tree = String(worktree.tree_sha)): number | null {
  return store.transaction(() => {
    const held = heldBy(store, String(task.repository_id), worktree.id).filter(row => row.task_id !== task.id || row.workspace_id !== task.workspace_id);
    if (mode === 'write' || !share ? held.length : held.some(row => row.mode === 'write')) return null;
    return bind(store, task, worktree.id, mode, head, tree);
  });
}

/** Records a new worktree for the task before the runner makes it, so the cleanup knows whose it is if making it fails. */
export function registerWorktree(store: Store, task: Row, worktree: string, mode: WorktreeMode, head: string, tree: string): number {
  return store.transaction(() => {
    store.run(`INSERT INTO worktrees(repository_id,id,generation,head_sha,tree_sha,mode,state,created_by,created_at,used_at) VALUES(?,?,?,?,?,?,'ready',?,?,?)`,
      String(task.repository_id), worktree, Number(task.generation), head, tree, mode, String(task.id), now(), now());
    return bind(store, task, worktree, mode, head, tree);
  });
}

/** One binding ends; the worktree stays as it is (the task needs another commit, for example). */
export function releaseBinding(store: Store, binding: number, reason: string): void {
  store.run('UPDATE worktree_bindings SET released_at=?,release_reason=? WHERE id=? AND released_at IS NULL', now(), reason, binding);
}

/** A handover or creation failed: the binding ends, and the worktree is not offered again. */
export function refuseWorktree(store: Store, repo: string, worktree: string, binding: number, reason: string): void {
  store.transaction(() => {
    store.run('UPDATE worktree_bindings SET released_at=?,release_reason=? WHERE id=? AND released_at IS NULL', now(), reason, binding);
    store.run("UPDATE worktrees SET state=?,state_reason=? WHERE repository_id=? AND id=? AND state='ready'", reason === 'workspace_missing' ? 'removed' : 'refused', reason, repo, worktree);
  });
}

/** A handover with reset restored the worktree to the commit the task asked for: it may be handed over again. */
export function worktreeRestored(store: Store, repo: string, worktree: string, head: string, tree: string): void {
  store.run("UPDATE worktrees SET head_sha=?,tree_sha=?,state='ready',state_reason=NULL,used_at=? WHERE repository_id=? AND id=? AND state<>'removed'", head, tree, now(), repo, worktree);
}

/** The worktree moved to another commit while its task held it (#770); later handovers check against the new one. */
export function worktreeMoved(store: Store, repo: string, worktree: string, head: string, tree: string): void {
  store.run('UPDATE worktrees SET head_sha=?,tree_sha=?,used_at=? WHERE repository_id=? AND id=?', head, tree, now(), repo, worktree);
}

/** The cleanup removed these worktrees from the computer, or found them gone. */
export function worktreesRemoved(store: Store, repo: string, ids: string[], reason: string): void {
  if (!ids.length) return;
  store.run(`UPDATE worktrees SET state='removed',state_reason=? WHERE repository_id=? AND id IN (SELECT value FROM json_each(?))`, reason, repo, JSON.stringify(ids));
  store.run(`UPDATE worktree_bindings SET released_at=?,release_reason='worktree_removed' WHERE repository_id=? AND released_at IS NULL AND worktree_id IN (SELECT value FROM json_each(?))`,
    now(), repo, JSON.stringify(ids));
}
