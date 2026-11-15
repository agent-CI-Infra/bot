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
    CREATE INDEX IF NOT EXISTS worktree_bindings_task ON worktree_bindings(task_id,released_at);`);
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
 * Takes an existing worktree for the task before the runner checks it, in one transaction with the check that nobody else
 * holds it. Null when it is taken meanwhile.
 */
export function claimWorktree(store: Store, task: Row, worktree: Row, mode: WorktreeMode): number | null {
  return store.transaction(() => {
    if (heldBy(store, String(task.repository_id), worktree.id).length) return null;
    return bind(store, task, worktree.id, mode, worktree.head_sha, worktree.tree_sha);
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
