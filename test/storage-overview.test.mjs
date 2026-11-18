import test from 'node:test';
import assert from 'node:assert/strict';
import { storageOverview } from '../dist/storage/overview.js';
import { StorageReport } from '../dist/app/storage.js';
import { harness, setup } from './helpers.mjs';

const entry = (kind, device, bytes, projects = {}) => ({ kind, device, bytes, projects });
const sample = entries => ({ measured_at: '2026-01-01T00:00:00Z', entries, missing: [] });
test('the two allocation breakdowns reconcile, and only matching filesystems enter the host bar', () => {
  const ctrl = sample([entry('database', '10:abcd', 15), entry('trajectories', '10:abcd', 30, { 101: 20, 999: 5 })]);
  const manager = sample([entry('knowledge', '11:ffff', 12, { 101: 12 }), entry('other', '10:cafe', 3)]);
  const fs = { measured_at: ctrl.measured_at, filesystems: [{ device: '10:abcd', total: 150, free: 50 }] };
  const projects = [{ repository_id: '101', name: 'a', computer: { total_bytes: 10, complete: true, disk: { device: '10:abcd' } } },
    { repository_id: '102', name: 'b', computer: { total_bytes: 9000, complete: false } }];
  const view = storageOverview(projects, ctrl, manager, ['101', '102'], fs);
  assert.deepEqual(view.amounts, { database: 15, trajectories: 30, knowledge: 12, workspaces: 10, other: 3 });
  assert.deepEqual(view.rows.map(row => row.bytes), [42, 0]);
  assert.equal(view.shared, 28); assert.equal(view.total, 70); assert.deepEqual(view.missing, ['workspaces']);
  assert.deepEqual([view.machine.launchpad, view.machine.other, view.machine.free], [55, 45, 50]);
  fs.filesystems[0].free = 100;
  assert.equal(storageOverview(projects, ctrl, manager, ['101'], fs).machine.launchpad, null);
  assert.equal(storageOverview(projects, ctrl, null, undefined, null).machine, null);
});

test('manual reclamation authorizes, joins duplicate clicks, reports partial failure and can retry', async t => {
  const gate = Promise.withResolvers();
  const h = await harness(t, undefined, store => {
    let calls = 0;
    const manager = { async call(_method, path) {
      if (path === '/v1/storage/reclaim') {
        if (++calls === 1) { await gate.promise; throw new Error('offline'); }
        return { files: 0, bytes: 0 };
      }
      return { expiry: { window_days: 2 } };
    } };
    return { storage: new StorageReport(store, manager) };
  });
  const { admin } = await setup(h);
  const member = h.client();
  await admin('/api/users', 'POST', { username: 'viewer', password: 'sample-password', role: 'project_admin', repository_ids: [] });
  await member('/api/auth/login', 'POST', { username: 'viewer', password: 'sample-password' });
  assert.equal((await h.client()('/api/storage/reclaim', 'POST', {})).status, 401);
  for (const method of ['GET', 'POST']) assert.equal((await member('/api/storage/reclaim', method, method === 'POST' ? {} : undefined)).status, 403);
  const start = () => admin('/api/storage/reclaim', 'POST', {});
  const first = await start(), second = await start();
  assert.equal(first.value.status, 'running'); assert.equal(first.value.started_at, second.value.started_at);
  assert.equal(h.store.get("SELECT count(*) AS n FROM audit WHERE action='storage.reclaim.started'").n, 1);
  const finish = async () => {
    for (let i = 0; i < 200; i++) {
      const { value } = await admin('/api/storage/reclaim');
      if (value.status !== 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('cleanup did not finish');
  };
  gate.resolve();
  assert.equal((await finish()).status, 'partial');
  await start(); const last = await finish();
  assert.equal(last.status, 'completed'); assert.equal(last.count, 0);
  assert.equal((await admin('/api/storage/retention')).value.reclaim.finished_at, last.finished_at);
});

test('Linux host sampler deduplicates bind mounts and excludes remote, memory and container filesystems', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('python3', ['-c', `
import os, runpy
from types import SimpleNamespace
from unittest.mock import patch
source = runpy.run_path('scripts/host-storage.py')
mounts = ['1 0 8:1 / / rw - ext4 /dev/sda1 rw',
          '2 0 8:1 /cache /bind rw - ext4 /dev/sda1 rw',
          '3 0 8:2 / /data rw - xfs /dev/sda2 rw',
          '4 0 0:2 / /memory rw - tmpfs tmpfs rw',
          '5 0 0:3 / /overlay rw - overlay overlay rw',
          '6 0 0:4 / /net rw - nfs host:/data rw']
def stat(path):
    assert path in ('/', '/bind', '/data')
    return SimpleNamespace(st_dev=os.makedev(8, 2 if path == '/data' else 1))
with patch('os.stat', stat), patch('os.statvfs', return_value=SimpleNamespace(f_blocks=20, f_bfree=8, f_frsize=4096)), patch('subprocess.check_output', return_value='a1'):
    result = source['local_filesystems'](mounts)
    assert len(result) == 2 and all(fs['total'] == 81920 and fs['free'] == 32768 for fs in result)
    for unverified in [mounts[2:], mounts + ['7 0 0:5 / /pool rw - zfs pool rw']]:
        try: source['local_filesystems'](unverified)
        except ValueError: pass
        else: raise AssertionError('unverified or shared-pool inventory accepted')
`]);
});
