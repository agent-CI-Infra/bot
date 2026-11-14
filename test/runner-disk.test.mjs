import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../runner/command.mjs';
import { failedFull, fullBytes, lowBytes, noSpace, refuseFull, toolDiskFull, volume, watchVolume } from '../runner/disk.mjs';

// #671: a project computer's work volume that runs full. The runner refuses or marks the call, and the control plane
// stops the task as disk_full (test/storage-guard.test.mjs).
const GiB = 1024 ** 3, MiB = 1024 ** 2, total = 1000 * GiB;
const state = free => ({ free_bytes: free, total_bytes: total, full: free < fullBytes(total), low: free < lowBytes(total) });
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write '/workspace/tasks/x/repo/a.bin'"), { code: 'ENOSPC' });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('the volume is full under the smaller of 1 % and 1 GiB, low under the smaller of 5 % and 10 GiB; full-disk errors are recognized', () => {
  assert.equal(fullBytes(total), GiB); assert.equal(fullBytes(50 * GiB), Math.floor(0.5 * GiB));
  assert.equal(lowBytes(total), 10 * GiB); assert.equal(lowBytes(50 * GiB), Math.floor(2.5 * GiB));
  const now = volume(tmpdir()); assert.ok(now.total_bytes > 0 && typeof now.full === 'boolean' && typeof now.low === 'boolean');
  assert.equal(volume('/nonexistent-' + Date.now()), null);
  for (const error of [enospc(), { code: 'EDQUOT' }, new Error('fatal: unable to write new index file: No space left on device')]) assert.equal(noSpace(error), true);
  for (const error of [new Error('EACCES: permission denied'), null]) assert.equal(noSpace(error), false);
});

test('a call that would write is refused on a full volume; reads and answers to a running agent are not', () => {
  const full = () => state(200 * MiB), room = () => state(500 * GiB);
  const refused = refuseFull({ type: 'workspace_command', command: 'npm ci' }, full);
  assert.equal(refused.ok, false); assert.equal(refused.error, 'disk_full');
  assert.match(refused.detail, /^workspace_command: refused, nothing was run; the work volume has 200 MiB free of 1024000 MiB$/);
  for (const type of ['command', 'workspace_checkout', 'workspace_init', 'git_import', 'workspace_write', 'workspace_agent_start']) assert.equal(refuseFull({ type }, full)?.error, 'disk_full', type);
  for (const type of ['workspace_read', 'workspace_blob', 'workspace_agent_poll', 'workspace_agent_reply', 'workspace_agent_control_tool']) assert.equal(refuseFull({ type }, full), null, type);
  assert.equal(refuseFull({ type: 'workspace_command' }, room), null);
  assert.equal(refuseFull({ type: 'workspace_command' }, () => null), null, 'an unreadable volume refuses nothing');
});

test('a call that failed for want of space, or while the volume is full, answers disk_full; other failures stay as they were', () => {
  const room = () => state(500 * GiB), full = () => state(0);
  const answer = failedFull({ type: 'workspace_write', path: 'a.bin' }, enospc(), room);
  assert.equal(answer.error, 'disk_full'); assert.match(answer.detail, /^workspace_write a\.bin: ENOSPC: no space left on device.*; the work volume has 512000 MiB free/);
  // A reply to the agent is not refused, but its failure on a full volume is still disk_full.
  assert.equal(failedFull({ type: 'workspace_agent_reply' }, new Error('agent_reply_offset'), full)?.error, 'disk_full');
  assert.equal(failedFull({ type: 'workspace_write', path: 'a.bin' }, new Error('offset_mismatch'), room), null);
  assert.equal(failedFull({ type: 'workspace_blob' }, enospc(), full), null, 'a read keeps its own failure');
});

test('a failed command is marked when the volume ran full while it ran, or reports no space while the volume is low', () => {
  // The volume is read when the command starts and when it ends (and every minute here, which these never last).
  const mark = (states, result) => { const queue = [...states], watch = watchVolume(() => queue.length > 1 ? queue.shift() : queue[0], 60_000); return watch.mark(result); };
  const failed = { exit_code: 1, output: 'Error: something broke', truncated: false, timed_out: false };
  // Full while it ran, with room again at the end (the failure's cleanup freed it).
  assert.deepEqual(mark([state(0), state(300 * GiB)], failed).disk_full, { free_bytes: 300 * GiB, lowest_free_bytes: 0, total_bytes: total });
  assert.equal(mark([state(400 * GiB), state(300 * GiB)], failed).disk_full, undefined, 'a plain failure on a volume with room');
  assert.equal(mark([state(0), state(300 * GiB)], { ...failed, exit_code: 0 }).disk_full, undefined, 'a command that succeeded is not marked');
  assert.equal(mark([state(0)], { ...failed, exit_code: null, running: true }).disk_full, undefined, 'a background command still running is not marked');
  // It says there is no space: marked on a low volume, a plain failure on a volume with room.
  const says = { ...failed, output: 'npm ERR! code ENOSPC\nnpm ERR! nospc ENOSPC: no space left on device, write' };
  assert.equal(mark([state(5 * GiB)], says).disk_full?.free_bytes, 5 * GiB);
  assert.equal(mark([state(60 * GiB)], says).disk_full, undefined);
  assert.equal(mark([state(5 * GiB)], failed).disk_full, undefined, 'a low volume alone is not a reason');
  assert.equal(mark([null], says).disk_full, undefined, 'an unreadable volume marks nothing');
});

test('the volume is sampled while a command runs', async () => {
  let reads = 0; const watch = watchVolume(() => [state(400 * GiB), state(0)][reads++] ?? state(300 * GiB), 5);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(watch.mark({ exit_code: 2, output: '' }).disk_full?.lowest_free_bytes, 0);
});

test('a command that fails writing to a full device is marked only while the volume is low', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-disk-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  // /dev/full answers every write with ENOSPC.
  const full = quote(process.execPath) + ' -e ' + quote("require('fs').writeFileSync('/dev/full', 'x')");
  const low = await command(full, directory, 30000, { volume: () => state(3 * GiB) });
  assert.notEqual(low.exit_code, 0); assert.match(low.output, /ENOSPC/);
  assert.deepEqual(low.disk_full, { free_bytes: 3 * GiB, lowest_free_bytes: 3 * GiB, total_bytes: total });
  assert.equal((await command(full, directory, 30000, { volume: () => state(300 * GiB) })).disk_full, undefined);
  assert.equal((await command('true', directory, 30000, { volume: () => state(0) })).disk_full, undefined);
});

test('the agent stops on a tool result that ran out of space', () => {
  assert.match(toolDiskFull({ exit_code: 1, output: '', disk_full: { free_bytes: 3 * GiB, lowest_free_bytes: 0, total_bytes: total } }), /volume ran full \(0 MiB free of 1024000 MiB at the lowest\)/);
  assert.match(toolDiskFull({ error: "ENOSPC: no space left on device, write '/workspace/tasks/x/repo/a.txt'" }), /^ENOSPC/);
  for (const result of [{ exit_code: 1, output: 'ENOSPC' }, { error: 'file_too_large' }, { written: true }, null]) assert.equal(toolDiskFull(result), null);
});
