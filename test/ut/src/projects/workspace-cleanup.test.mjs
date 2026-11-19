import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { WorkspaceCleanup, useWorkspace, workspaceRemoving } from '../../../../dist/projects/workspace-cleanup.js';
import { reviewObjectState } from '../../../../dist/review/sessions.js';
import { listTaskDirectories, removeTaskDirectories } from '../../../../runner/task-dirs.mjs';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { planWorktree } from '../../../../dist/projects/worktrees.js';

const id = () => randomBytes(24).toString('hex'), hour = 3600_000, day = 24 * hour, iso = time => new Date(time).toISOString();

// A control-plane store with project 101, and a stand-in manager whose project computer is a directory: its runner
// calls go to the real runner functions. Every runner request is kept in calls.
function fixture(t, onRemove) {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-cleanup-')), tasks = join(dir, 'tasks'), worktrees = join(dir, 'worktrees'), store = new Store(join(dir, 'control.sqlite'), randomBytes(32));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(tasks); mkdirSync(worktrees);
  store.run("INSERT INTO accounts(id,name,type,credentials,created_at) VALUES('a','Fixture','bot_account','{}',?)", iso(Date.now()));
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')"); store.run("INSERT INTO policies(repository_id) VALUES('101')");
  const calls = [], manager = { async call(method, _path, input) {
    if (method === 'GET') return { repository_id: '101', state: 'ready', generation: 1 };
    const request = input.request; calls.push(request);
    if (request.type.endsWith('_remove')) await onRemove?.(request);
    // The shared worktrees (#769) are listed and removed the same way, in their own directory.
    const root = request.type.startsWith('worktrees_') ? worktrees : tasks;
    try { return { ok: true, result: request.type.endsWith('_list') ? await listTaskDirectories(root) : await removeTaskDirectories(request.entries, root, join(dir, 'store')) }; }
    catch (error) { return { ok: false, error: request.type + '_failed', detail: error.message }; }
  } };
  // A task directory last active `age` ago.
  const directory = (age, name = id()) => {
    mkdirSync(join(tasks, name, 'repo'), { recursive: true }); writeFileSync(join(tasks, name, 'repo', 'file'), 'x'.repeat(5000));
    const time = (Date.now() - age) / 1000; utimesSync(join(tasks, name, 'repo'), time, time); utimesSync(join(tasks, name), time, time); return name;
  };
  // A task last updated `age` ago that used its directory then, recorded as Workspace does before each runner call.
  const task = (status, { age = 2 * day, kind = 'review.issue', number = 1, workspace = directory(age), taskId = id(), input = '{}' } = {}) => {
    store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input,created_at,updated_at,workspace_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      taskId, '101', kind, status, '', number, input, iso(Date.now() - age), iso(Date.now() - age), workspace);
    useWorkspace(store, { id: taskId, repository_id: '101', kind, object_number: number, workspace_id: workspace }, 'workspace_checkout', Date.now() - age);
    return { id: taskId, workspace };
  };
  const cleanup = new WorkspaceCleanup(store, manager, { firstDelayMs: hour, pauseMs: 0 });
  // A worktree last active `age` ago (no git registration: removal prunes nothing then).
  const worktree = (age, name = id()) => {
    mkdirSync(join(worktrees, name), { recursive: true }); writeFileSync(join(worktrees, name, 'file'), 'x'.repeat(5000));
    const time = (Date.now() - age) / 1000; utimesSync(join(worktrees, name), time, time); return name;
  };
  return { store, calls, directory, worktree, task, tasks, cleanup, sweep: () => cleanup.run(), left: () => readdirSync(tasks).sort(), worktrees: () => readdirSync(worktrees).sort(),
    released: workspace => store.all('SELECT task_id,kind,release_reason,freed_bytes FROM task_workspaces WHERE workspace_id=? AND released_at IS NOT NULL', workspace) };
}
const sorted = (...names) => names.sort();

test('workspaces of tasks that are not finished stay whatever their age', async t => {
  const f = fixture(t);
  const kept = ['running', 'queued', 'preparing', 'publishing', 'retry_wait', 'waiting_environment', 'waiting_configuration', 'waiting_pr_head', 'paused', 'needs_replan']
    .map(status => f.task(status, { age: 30 * day }).workspace);
  await f.sweep();
  assert.deepEqual(f.left(), sorted(...kept));
  assert.deepEqual(f.calls.map(call => call.type), ['tasks_list', 'worktrees_list']);
});

test('finished tasks go after a day, failed ones after a week, and directories no task names after a day', async t => {
  const f = fixture(t);
  const gone = [f.task('succeeded'), f.task('cancelled'), f.task('superseded'), f.task('completed', { kind: 'reply' }), f.task('failed', { age: 8 * day })].map(task => task.workspace);
  const kept = [f.task('succeeded', { age: 12 * hour }), f.task('failed', { age: 6 * day })].map(task => task.workspace);
  const orphan = f.directory(2 * day), young = f.directory(12 * hour);
  // #769: a task directory's plan of the worktree it was to get goes with the directory.
  const plan = (task, workspace) => f.store.run("INSERT INTO worktree_plans(task_id,workspace_id,repository_id,head_sha,tree_sha,mode,state,created_at) VALUES(?,?,'101',?,?,'read','none',?)", task, workspace, 'a'.repeat(40), 'b'.repeat(40), iso(Date.now()));
  plan('gone', gone[0]); plan('kept', kept[0]);
  await f.sweep();
  assert.deepEqual(f.left(), sorted(...kept, young));
  assert.deepEqual(f.store.all('SELECT task_id FROM worktree_plans').map(row => row.task_id), ['kept']);
  assert.deepEqual(f.released(gone[0]).map(row => row.release_reason), ['finished']); assert.ok(f.released(gone[0])[0].freed_bytes >= 4096);
  assert.deepEqual(f.released(gone[4]).map(row => row.release_reason), ['failed']);
  // A directory no record named is recorded when it goes.
  assert.deepEqual(f.released(orphan).map(({ task_id, kind, release_reason }) => ({ task_id, kind, release_reason })), [{ task_id: '', kind: 'unrecorded', release_reason: 'unowned' }]);
  // The age is the task's last update, not only the directory's: a task updated recently keeps an old directory.
  const updated = f.task('succeeded', { age: 12 * hour, workspace: f.directory(5 * day) }).workspace;
  await f.sweep(); assert.ok(f.left().includes(updated));
});

test("a pull request's workspaces stay while it is open and go at the next sweep after its merge is seen", async t => {
  const f = fixture(t), long = 20 * day;
  // The development that opened PR #7 for Issue #3, a revision of the PR, a later development of the Issue that
  // continued the PR and failed, and a recent review of the PR.
  const opened = f.task('pr_opened', { kind: 'development.issue', number: 3, age: long });
  f.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'pr7','99','101','bot/issue-3','sha',?,0)", opened.id);
  const revision = f.task('completed', { kind: 'development.pr', number: 7, age: long }), later = f.task('failed', { kind: 'development.issue', number: 3, age: long });
  const review = f.task('succeeded', { kind: 'review.pr', number: 7, age: 2 * hour });
  // Another pull request, merged: its development goes although it finished an hour ago.
  const other = f.task('pr_opened', { kind: 'development.issue', number: 4, age: hour });
  f.store.run("INSERT INTO bot_pull_requests VALUES('101',8,'pr8','99','101','bot/issue-4','sha',?,0)", other.id); reviewObjectState(f.store, '101', 'review.pr', 8, true);
  await f.sweep();
  assert.deepEqual(f.left(), sorted(opened.workspace, revision.workspace, later.workspace, review.workspace));
  assert.deepEqual(f.released(other.workspace).map(row => row.release_reason), ['pr_closed']);
  reviewObjectState(f.store, '101', 'review.pr', 7, true);
  await f.sweep();
  assert.deepEqual(f.left(), []);
  assert.deepEqual(f.released(review.workspace).map(row => row.release_reason), ['pr_closed']);
});

test("#1122 generic task.request workspaces follow open/closed bot PR lifecycle for Issue developments, PR revisions, and PR reviews", async t => {
  const f = fixture(t), long = 20 * day;
  const grant = (taskId, writes) => f.store.run("INSERT INTO task_write_grants VALUES(?,?,1,?)", taskId, JSON.stringify(writes), iso(Date.now() - long));
  // Generic Issue development that opened PR #17 for Issue #13, a generic PR revision on #17, a later generic Issue development on #13, and a generic PR review on #17.
  const opened = f.task('pr_opened', { kind: 'task.request', number: 13, age: long, input: JSON.stringify({ target: { type: 'issue', number: 13 }, delivery: 'pull_request' }) });
  grant(opened.id, ['pull_request']);
  f.store.run("INSERT INTO bot_pull_requests VALUES('101',17,'pr17','99','101','bot/issue-13','sha',?,0)", opened.id);
  const revision = f.task('pr_opened', { kind: 'task.request', number: 17, age: long, input: JSON.stringify({ target: { type: 'pr', number: 17 }, delivery: 'pull_request' }) });
  grant(revision.id, ['pull_request']);
  const laterIssueDev = f.task('failed', { kind: 'task.request', number: 13, age: long, input: JSON.stringify({ target: { type: 'issue', number: 13 } }) });
  grant(laterIssueDev.id, ['pull_request']);
  const prReview = f.task('succeeded', { kind: 'task.request', number: 17, age: 2 * hour, input: JSON.stringify({ target: { type: 'pr', number: 17 }, delivery: 'review' }) });
  grant(prReview.id, ['review']);

  await f.sweep();
  assert.deepEqual(f.left(), sorted(opened.workspace, revision.workspace, laterIssueDev.workspace, prReview.workspace));

  reviewObjectState(f.store, '101', 'review.pr', 17, true);
  await f.sweep();
  assert.deepEqual(f.left(), []);
  for (const ws of [opened.workspace, revision.workspace, laterIssueDev.workspace, prReview.workspace]) {
    assert.deepEqual(f.released(ws).map(row => row.release_reason), ['pr_closed']);
  }
});

test('a workspace another task reuses, one used in the last half hour and one written since the listing stay', async t => {
  let touched = null, during = [];
  const f = fixture(t, request => {
    during = request.entries.map(entry => workspaceRemoving('101', entry.name));
    // Written between the listing and the removal call, as by a task taking it up right then.
    if (touched) { const time = Date.now() / 1000; utimesSync(join(f.tasks, touched), time, time); }
  });
  // A succeeded review whose workspace a running review of the same head reuses.
  const first = f.task('succeeded', { age: 3 * day }); f.task('running', { age: 3 * day, workspace: first.workspace });
  // A succeeded task whose workspace this process used a few minutes ago.
  const recent = f.task('succeeded', { age: 3 * day });
  useWorkspace(f.store, { id: 'another', repository_id: '101', conversation_id: 'c', workspace_id: recent.workspace }, 'workspace_read', Date.now() - 5 * 60_000);
  const written = f.task('succeeded', { age: 3 * day }), gone = f.task('succeeded', { age: 3 * day });
  touched = written.workspace;
  await f.sweep();
  assert.deepEqual(f.left(), sorted(first.workspace, recent.workspace, written.workspace));
  assert.deepEqual(f.calls.filter(call => call.type === 'tasks_remove').at(-1).entries.map(entry => entry.name).sort(), sorted(written.workspace, gone.workspace));
  assert.deepEqual(during, [true, true]); assert.equal(workspaceRemoving('101', gone.workspace), false);
  // A directory written since the listing keeps its record unreleased.
  assert.deepEqual(f.released(written.workspace), []);
});

test('#769 a shared worktree stays while any task that used it needs it, then goes by the same rules; its record follows', async t => {
  // While the sweep removes a worktree, a task that chooses it is told it does not exist instead of getting a vanishing directory.
  let chosen = null;
  const f = fixture(t, async request => { if (request.type === 'worktrees_remove') chosen = await choose(request.entries.map(entry => entry.name).find(name => name === done)); }), bind = (task, worktree) => useWorkspace(f.store, { id: task.id, repository_id: '101', kind: 'review.issue', object_number: 1, workspace_id: worktree }, 'worktree', Date.now() - 3 * day);
  const record = worktree => f.store.run(`INSERT INTO worktrees(repository_id,id,generation,head_sha,tree_sha,mode,state,created_by,created_at,used_at) VALUES('101',?,1,?,?,'read','ready','t',?,?)`,
    worktree, 'a'.repeat(40), 'b'.repeat(40), iso(Date.now() - 3 * day), iso(Date.now() - 3 * day));
  // Two reviews used one worktree; the second is still running.
  const shared = f.worktree(3 * day), done = f.worktree(3 * day), orphan = f.worktree(2 * day), young = f.worktree(12 * hour);
  for (const name of [shared, done]) record(name);
  const ended = f.task('succeeded', { age: 3 * day }), running = f.task('running', { age: 3 * day }), finished = f.task('succeeded', { age: 3 * day });
  bind(ended, shared); bind(running, shared); bind(finished, done);
  // A recorded worktree whose directory is gone.
  const gone = id(); record(gone); bind(finished, gone);
  const chooser = { id: id(), repository_id: '101', kind: 'review.pr', generation: 1, attempt: 1, workspace_id: id() };
  planWorktree(f.store, chooser, 'a'.repeat(40), 'b'.repeat(40), 'read', null);
  const choose = worktree => new Workspace(f.store, null, chooser, new Redactor(), async () => {}, () => {}).choose('use', { worktree_id: worktree, mode: 'read' }, 'manager');
  await f.sweep();
  assert.equal(chosen?.error, 'workspace_not_found');
  assert.equal(f.store.get('SELECT count(*) n FROM worktree_bindings WHERE task_id=?', chooser.id).n, 0);
  assert.deepEqual(f.worktrees(), sorted(shared, young));
  assert.deepEqual(f.released(done).map(row => [row.kind, row.release_reason, row.freed_bytes > 0]), [['worktree', 'finished', true]]);
  assert.deepEqual(f.released(orphan).map(row => row.release_reason), ['unowned']);
  assert.deepEqual(f.store.all('SELECT id,state,state_reason FROM worktrees ORDER BY id').map(row => [row.id, row.state, row.state_reason]),
    [[shared, 'ready', null], [done, 'removed', 'finished'], [gone, 'removed', 'missing']].sort((a, b) => a[0] < b[0] ? -1 : 1));
  // The task directories are swept on their own: none of them is a worktree.
  assert.deepEqual(f.calls.map(call => call.type), ['tasks_list', 'tasks_remove', 'worktrees_list', 'worktrees_remove']);
  f.store.run("UPDATE tasks SET status='succeeded' WHERE id=?", running.id); await f.sweep();
  assert.deepEqual(f.worktrees(), [young]);
});

test("a follow-up that is not finished keeps its parent's workspace", async t => {
  const f = fixture(t), parent = f.task('succeeded', { age: 5 * day }), child = f.task('queued', { age: 5 * day });
  f.store.run("INSERT INTO task_followups VALUES(?,'candidate','issue',?)", parent.id, child.id);
  await f.sweep(); assert.deepEqual(f.left(), sorted(parent.workspace, child.workspace));
  f.store.run("UPDATE tasks SET status='succeeded' WHERE id=?", child.id);
  await f.sweep(); assert.deepEqual(f.left(), []);
});

test('tasks waiting since before records began keep their workspace and the one their retry restores from', async t => {
  const f = fixture(t), own = f.directory(5 * day), saved = f.directory(5 * day), integrated = f.directory(5 * day), orphan = f.directory(5 * day), waiting = id();
  f.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input,created_at,updated_at,workspace_id) VALUES(?,'101','development.issue','retry_wait','',5,?,?,?,?)`,
    waiting, JSON.stringify({ recovery: { source_workspace_id: saved }, integration: { source_workspace_id: integrated } }), iso(Date.now() - 5 * day), iso(Date.now() - 5 * day), own);
  await f.sweep();
  assert.deepEqual(f.left(), sorted(own, saved, integrated));
  assert.deepEqual(f.store.all('SELECT workspace_id,kind FROM task_workspaces WHERE task_id=? ORDER BY kind', waiting).map(row => ({ ...row })),
    [{ workspace_id: integrated, kind: 'integration' }, { workspace_id: saved, kind: 'recovery' }, { workspace_id: own, kind: 'task' }]);
  assert.equal(f.store.get("SELECT 1 AS done FROM settings WHERE key='workspace_records_recovered'").done, 1);
  assert.deepEqual(f.released(orphan).map(row => row.release_reason), ['unowned']);
});

test('a recorded workspace whose directory is gone is marked released', async t => {
  const f = fixture(t), gone = id();
  f.store.run("INSERT INTO task_workspaces(repository_id,workspace_id,task_id,kind,created_at) VALUES('101',?,'t','task',?)", gone, iso(Date.now() - 2 * hour));
  const fresh = id(); f.store.run("INSERT INTO task_workspaces(repository_id,workspace_id,task_id,kind,created_at) VALUES('101',?,'t','task',?)", fresh, iso(Date.now()));
  await f.sweep();
  assert.deepEqual(f.released(gone).map(row => row.release_reason), ['missing']); assert.deepEqual(f.released(fresh), []);
});

test('the sweep starts after startup, removes ten directories per runner call and stops when closed', async t => {
  const f = fixture(t), names = Array.from({ length: 23 }, () => f.directory(2 * day));
  const cleanup = new WorkspaceCleanup(f.store, { call: (...args) => f.cleanup.manager.call(...args) }, { firstDelayMs: 50, intervalMs: hour, pauseMs: 0 });
  t.after(() => cleanup.close());
  cleanup.start();
  assert.deepEqual(f.calls, []);
  for (let waited = 0; f.left().length && waited < 10_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  await cleanup.run();
  assert.deepEqual(f.left(), []);
  const removals = f.calls.filter(call => call.type === 'tasks_remove');
  assert.deepEqual(removals.map(call => call.entries.length), [10, 10, 3]);
  assert.deepEqual(removals.flatMap(call => call.entries.map(entry => entry.name)).sort(), names.sort());
  cleanup.close(); const before = f.calls.length; await cleanup.run(); assert.equal(f.calls.length, before);
});
