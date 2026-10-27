import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ownership, tasksRoot } from '../runner/ownership.mjs';
import { command, environment } from '../runner/command.mjs';
import { workspace as runnerWorkspace } from '../runner/workspace.mjs';

const id = () => randomBytes(24).toString('hex');

test('cleanup attributes each process to its own task workspace, so ending one task leaves the others running', async () => {
  const mine = id(), other = id(), request = value => 'node /opt/runner/runner.mjs ' + Buffer.from(JSON.stringify(value)).toString('base64url');
  const rows = [
    { pid: 1, ppid: 0, cmdline: '/sbin/docker-init -- node /opt/runner/idle.mjs' },
    { pid: 10, ppid: 0, cmdline: 'node /opt/runner/pi-entry.mjs ' + tasksRoot + mine },
    { pid: 11, ppid: 10, cmdline: '/bin/sh -c npm test' },
    { pid: 12, ppid: 11, cmdline: 'env -i node server.js' },
    { pid: 20, ppid: 0, cmdline: 'node /opt/runner/pi-entry.mjs ' + tasksRoot + other },
    { pid: 21, ppid: 20, cmdline: '/bin/sh -c sleep 600' },
    { pid: 30, ppid: 0, cmdline: request({ type: 'workspace_snapshot', workspace_id: other, operation_id: id() }) },
    { pid: 31, ppid: 30, cmdline: 'git hash-object --stdin' },
    { pid: 40, ppid: 1, cmdline: 'daemon' },
    { pid: 41, ppid: 1, cmdline: 'detached server' },
    { pid: 50, ppid: 1, cmdline: 'forged' },
  ];
  // Commands carry their task's BOT_WORKSPACE_ID; a process that cleared its environment is placed by its directory or parent.
  const environ = { 11: 'PATH=/bin\0BOT_WORKSPACE_ID=' + mine, 21: 'BOT_WORKSPACE_ID=' + other, 41: 'HOME=/workspace/home', 50: 'BOT_WORKSPACE_ID=../../etc' };
  const cwd = { 12: '/workspace/home', 40: tasksRoot + mine + '/repo/src', 41: '/' };
  const owner = await ownership(rows, { environ: async pid => environ[pid] || '', cwd: async pid => cwd[pid] || '' });
  assert.deepEqual([10, 11, 12, 40].map(owner), [mine, mine, mine, mine]);
  assert.deepEqual([20, 21, 30, 31].map(owner), [other, other, other, other]);
  assert.deepEqual([1, 41, 50].map(owner), [null, null, null]);
});

test('task commands carry their workspace id and run in their own repository directory', async t => {
  mkdirSync(resolve('.tmp'), { recursive: true }); const root = mkdtempSync(resolve('.tmp/task-command-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceId = id(), result = await command('printf "%s %s" "$BOT_WORKSPACE_ID" "$PWD"', root, 5000, { workspaceId });
  assert.equal(result.output, `${workspaceId} ${root}`);
  assert.equal((await command('printf "[%s]" "$BOT_WORKSPACE_ID"', root, 5000, { workspaceId: '../escape' })).output, '[]');
});

test('one task writes only inside its own workspace, never into another task’s', async t => {
  mkdirSync(resolve('.tmp'), { recursive: true }); const root = mkdtempSync(resolve('.tmp/task-workspaces-'));
  const previous = { HOME: environment.HOME, TMPDIR: environment.TMPDIR }; Object.assign(environment, { HOME: root, TMPDIR: root });
  t.after(() => { Object.assign(environment, previous); rmSync(root, { recursive: true, force: true }); });
  const first = id(), second = id(), run = (workspaceId, request) => runnerWorkspace({ ...request, workspace_id: workspaceId }, root);
  const write = (workspaceId, path, text) => run(workspaceId, { type: 'workspace_write', path, base64: Buffer.from(text).toString('base64'), offset: 0, final: true, mode: '100644' });
  for (const workspaceId of [first, second]) await run(workspaceId, { type: 'workspace_init' });
  await write(first, 'shared.txt', 'first'); await write(second, 'shared.txt', 'second');
  assert.equal(readFileSync(join(root, first, 'repo', 'shared.txt'), 'utf8'), 'first'); assert.equal(readFileSync(join(root, second, 'repo', 'shared.txt'), 'utf8'), 'second');
  await assert.rejects(write(first, `../../${second}/repo/shared.txt`, 'x'), /invalid_path/);
  // A directory link inside the first workspace that points into the second one is not followed.
  symlinkSync(join(root, second, 'repo'), join(root, first, 'repo', 'other'));
  await assert.rejects(write(first, 'other/shared.txt', 'x'), /invalid_parent/);
  await assert.rejects(write(first, 'other/new.txt', 'x'), /invalid_parent/);
  assert.equal(readFileSync(join(root, second, 'repo', 'shared.txt'), 'utf8'), 'second'); assert.ok(!existsSync(join(root, second, 'repo', 'new.txt')));
  // Commands of each task start in that task's repository.
  const output = await run(second, { type: 'workspace_command', command: 'cat shared.txt', timeout_ms: 5000 });
  assert.equal(output.output, 'second');
});
