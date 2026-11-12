import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, chmodSync, existsSync, rmSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { listTaskDirectories, removeTaskDirectories, removeLimit } from '../runner/task-dirs.mjs';
import { LocalManager } from '../dist/projects/local-manager.js';

const id = () => randomBytes(24).toString('hex');
function computer(t) {
  const root = mkdtempSync(join(tmpdir(), 'task-dirs-')), tasks = join(root, 'tasks');
  mkdirSync(tasks); t.after(() => { rmSync(root, { recursive: true, force: true }); });
  // A task directory last active at `time` (seconds).
  const directory = (time, name = id()) => {
    mkdirSync(join(tasks, name, 'repo'), { recursive: true }); writeFileSync(join(tasks, name, 'repo', 'file'), 'x'.repeat(10_000));
    for (const path of [join(tasks, name, 'repo'), join(tasks, name)]) utimesSync(path, time, time); return name;
  };
  return { root, tasks, directory };
}

test('the listing names task directories only, least recently active first, with the time of their last activity', async t => {
  const c = computer(t), now = Math.floor(Date.now() / 1000), older = c.directory(now - 7200), newer = c.directory(now - 3600);
  // The agent's events count as activity even when the directory itself is older.
  const busy = c.directory(now - 9000); mkdirSync(join(c.tasks, busy, 'agent')); writeFileSync(join(c.tasks, busy, 'agent', 'events.jsonl'), '');
  utimesSync(join(c.tasks, busy, 'agent', 'events.jsonl'), now - 60, now - 60); utimesSync(join(c.tasks, busy, 'agent'), now - 9000, now - 9000); utimesSync(join(c.tasks, busy), now - 9000, now - 9000);
  // Not task directories: another name, a file with a task's name, a link with one.
  mkdirSync(join(c.tasks, 'scratch')); writeFileSync(join(c.tasks, id()), ''); mkdirSync(join(c.root, 'outside')); symlinkSync(join(c.root, 'outside'), join(c.tasks, id()));
  const listed = await listTaskDirectories(c.tasks);
  assert.equal(listed.total, 3);
  assert.deepEqual(listed.entries.map(entry => entry.name), [older, newer, busy]);
  assert.deepEqual(listed.entries.map(entry => Math.round(entry.active_at / 1000)), [now - 7200, now - 3600, now - 60]);
  assert.deepEqual(Object.keys(listed.entries[0]).sort(), ['active_at', 'name']);
  assert.deepEqual(await listTaskDirectories(join(c.root, 'missing')), { entries: [], total: 0 });
});

test('removal refuses names and directories outside the tasks directory', async t => {
  const c = computer(t), outside = join(c.root, 'outside'), name = id(), at = Date.now();
  mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'keep');
  for (const entries of [[], [{ name: '../outside', active_at: at }], [{ name: '/etc', active_at: at }], [{ name: name.slice(1), active_at: at }],
    [{ name: name.toUpperCase(), active_at: at }], [{ name, active_at: -1 }], [{ name, active_at: 1.5 }], [{ name }], [name],
    Array.from({ length: removeLimit + 1 }, () => ({ name: id(), active_at: at })), undefined])
    await assert.rejects(removeTaskDirectories(entries, c.tasks), /invalid_entries/, JSON.stringify(entries));
  // A link or file with a task's name is no task directory: it stays, and what a link points to is untouched.
  const link = id(), file = id(); symlinkSync(outside, join(c.tasks, link)); writeFileSync(join(c.tasks, file), '');
  assert.deepEqual(await removeTaskDirectories([{ name: link, active_at: at }, { name: file, active_at: at }], c.tasks),
    { removed: [], skipped: [{ name: link, reason: 'not_directory' }, { name: file, reason: 'not_directory' }] });
  assert.ok(existsSync(join(outside, 'keep'))); assert.ok(existsSync(join(c.tasks, link)));
  // A tasks directory replaced by a link to somewhere else is refused as a whole.
  const victim = c.directory(1); renameSync(c.tasks, join(c.root, 'real-tasks')); symlinkSync(join(c.root, 'real-tasks'), c.tasks);
  await assert.rejects(removeTaskDirectories([{ name: victim, active_at: Date.now() }], c.tasks), /invalid_tasks_directory/);
  await assert.rejects(listTaskDirectories(c.tasks), /invalid_tasks_directory/);
  assert.ok(existsSync(join(c.root, 'real-tasks', victim, 'repo', 'file')));
});

test('removal deletes read-only trees, reports the bytes they used, and reports a directory already gone as missing', async t => {
  const c = computer(t), name = c.directory(1), gone = id();
  // A module cache an agent left read-only, as Go does.
  const cache = join(c.tasks, name, 'repo', 'pkg', 'mod'); mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, 'module.go'), 'package x\n');
  chmodSync(cache, 0o555); chmodSync(join(c.tasks, name, 'repo', 'pkg'), 0o555);
  const result = await removeTaskDirectories([{ name, active_at: Date.now() }, { name: gone, active_at: Date.now() }], c.tasks, join(c.root, 'git'));
  assert.deepEqual(result.removed.map(entry => entry.name), [name]); assert.ok(result.removed[0].bytes >= 10_000);
  assert.deepEqual(result.skipped, [{ name: gone, reason: 'missing' }]);
  assert.deepEqual(readdirSync(c.tasks), []);
});

test('the runner lists and removes task directories as calls it does not journal; invalid entries fail the call', async t => {
  const c = computer(t), manager = new LocalManager('101', c.root), call = request => manager.call('POST', '/v1/projects/101/execute', { operation_id: id(), generation: 1, request });
  await manager.call('PUT', '/v1/projects/101');
  const name = c.directory(Math.floor(Date.now() / 1000) - 3600);
  const listed = await call({ type: 'tasks_list' });
  assert.deepEqual(listed.result.entries.map(entry => entry.name), [name]); assert.equal(listed.ok, true);
  assert.deepEqual((await call({ type: 'tasks_remove', entries: listed.result.entries })).result.removed.map(entry => entry.name), [name]);
  assert.deepEqual(readdirSync(c.tasks), []);
  const refused = await call({ type: 'tasks_remove', entries: [{ name: '../local-state.json', active_at: 1 }] });
  assert.deepEqual(refused, { ok: false, error: 'tasks_remove_failed', detail: 'invalid_entries' });
  assert.deepEqual(readdirSync(join(c.root, '.runner-journal')), []);
});
