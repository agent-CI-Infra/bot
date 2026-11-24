import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { StorageReport } from '../../../../dist/app/storage.js';

function makeTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    Buffer.from(entry.name, 'utf8').copy(header, 0, 0, 100);
    Buffer.from((entry.mode ?? 0o755).toString(8).padStart(7, '0') + '\0', 'ascii').copy(header, 100);
    Buffer.from('0000000\0', 'ascii').copy(header, 108);
    Buffer.from('0000000\0', 'ascii').copy(header, 116);
    const body = Buffer.from(entry.content || '');
    Buffer.from(body.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124);
    Buffer.from('00000000000\0', 'ascii').copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
    blocks.push(header);
    if (body.length) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function makeFakeManager() {
  const state = new Map();
  const refreshes = [];
  const ensure = id => {
    if (!state.has(id)) {
      state.set(id, {
        repository_id: id, generation: 1, revision: 1, state: 'ready', desired: 'ready', parallel: 1,
        computer: { cpus: 2, memory_mb: 4096, pids: 512, tmp_mb: 1024, packages: [], env: {}, setup_script: '',
          tools_revision: null, applied_tools_revision: null, tools_pending: false },
      });
    }
    return state.get(id);
  };
  return {
    state,
    refreshes,
    async call(method, path, body) {
      if (method === 'GET' && path === '/v1/project-tools/mounts') return { mounts: [] };
      if (method === 'GET' && path === '/v1/defaults') return { defaults: { cpus: 2, memory_mb: 4096, pids: 512, tmp_mb: 1024 } };
      if (method === 'GET' && path === '/v1/storage') return { usage: [], computers: [], expiry: { window_days: 2 } };
      const toolsMatch = /^\/v1\/projects\/([1-9]\d*)\/tools$/.exec(path);
      if (method === 'PUT' && toolsMatch) {
        const s = ensure(toolsMatch[1]);
        s.computer.tools_revision = body?.revision ?? null;
        s.computer.tools_pending = s.computer.applied_tools_revision !== s.computer.tools_revision;
        s.revision++;
        return structuredClone(s);
      }
      const opMatch = /^\/v1\/projects\/([1-9]\d*)\/(refresh|start|stop|delete)$/.exec(path);
      if (method === 'POST' && opMatch) {
        const [, id, action] = opMatch;
        const s = ensure(id);
        if (action === 'refresh') {
          refreshes.push(id);
          s.computer.applied_tools_revision = s.computer.tools_revision;
          s.computer.tools_pending = false;
        } else if (action === 'delete') {
          s.state = 'deleted'; s.desired = 'deleted';
        }
        s.revision++;
        return structuredClone(s);
      }
      const repoMatch = /^\/v1\/projects\/([1-9]\d*)$/.exec(path);
      if (repoMatch) {
        if (method === 'GET' || method === 'PUT') return structuredClone(ensure(repoMatch[1]));
      }
      return null;
    },
  };
}

async function uploadBinary(client, repoId, query, bytes, extraHeaders = {}) {
  const res = await fetch(`${client.harness.admin}/api/repositories/${repoId}/tools/upload?${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Connection: 'close',
      Cookie: client.cookie(),
      'X-CSRF-Token': client.csrf(),
      ...extraHeaders,
    },
    body: bytes,
  });
  return { status: res.status, value: await res.json() };
}

test('streaming upload, RBAC, CSRF, audit, rollback, clear, quota setting, idle rotation, storage accounting, and project deletion cleanup', async t => {
  const ptRoot = await mkdtemp(join(tmpdir(), 'pt-st-'));
  t.after(() => rm(ptRoot, { recursive: true, force: true }));
  const manager = makeFakeManager();
  const h = await harness(t, manager, store => ({
    projectToolsDir: ptRoot,
    storage: new StorageReport(store, manager, { project_tools: ptRoot }),
  }));
  const { admin } = await setup(h);
  const acc = await account(admin);
  await repository(admin, acc.id, '101');
  await repository(admin, acc.id, '202');

  // Create a project_admin assigned ONLY to project 101
  const projectAdmin = h.client();
  await admin('/api/users', 'POST', { username: 'padmin', password: 'project-admin-password-123', role: 'project_admin', repository_ids: ['101'] });
  assert.equal((await projectAdmin('/api/auth/login', 'POST', { username: 'padmin', password: 'project-admin-password-123' })).status, 200);

  // Create a project_admin with NO repositories (unauthorized)
  const outsider = h.client();
  await admin('/api/users', 'POST', { username: 'outsider', password: 'outsider-password-123', role: 'project_admin', repository_ids: [] });
  assert.equal((await outsider('/api/auth/login', 'POST', { username: 'outsider', password: 'outsider-password-123' })).status, 200);

  // Unauthenticated and missing CSRF are rejected
  assert.equal((await uploadBinary(h.client(), '101', 'mode=replace&kind=file&target_path=bin/a', Buffer.from('a'))).status, 401);
  assert.equal((await uploadBinary(projectAdmin, '101', 'mode=replace&kind=file&target_path=bin/a', Buffer.from('a'), { 'X-CSRF-Token': 'wrong' })).status, 403);

  // Project admin can upload to own project 101, refused on 202; outsider refused on 101
  assert.equal((await uploadBinary(outsider, '101', 'mode=replace&kind=file&target_path=bin/a', Buffer.from('a'))).status, 403);
  assert.equal((await uploadBinary(projectAdmin, '202', 'mode=replace&kind=file&target_path=bin/a', Buffer.from('a'))).status, 403);

  // Hold a running task claim on 101 so reconcile does NOT refresh while busy!
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('t-busy','101','task.request','running','busy task')");
  h.store.run("INSERT INTO task_claims VALUES('t-busy','101','claim-1',?)", new Date().toISOString());

  const up1 = await uploadBinary(projectAdmin, '101', 'mode=replace&kind=file&target_path=bin/tool-a&executable=1&note=v1', Buffer.from('#!/bin/sh\necho tool-a\n'));
  assert.equal(up1.status, 201);
  assert.equal(up1.value.revision, 1);
  assert.equal(up1.value.state.tools_pending, true, 'tools_pending must be true while task claim holds container');
  await h.projects.reconcile();
  assert.equal(manager.refreshes.length, 0, 'busy project computer must NOT be refreshed mid-task');

  // Release task claim -> idle reconcile triggers refresh and clears tools_pending!
  h.store.run("DELETE FROM task_claims WHERE repository_id='101'");
  await h.projects.reconcile();
  assert.deepEqual(manager.refreshes, ['101']);
  const afterRotate = await projectAdmin('/api/repositories/101/tools');
  assert.equal(afterRotate.status, 200);
  assert.equal(afterRotate.value.active_revision, 1);
  assert.equal(afterRotate.value.applied_revision, 1);
  assert.equal(afterRotate.value.tools_pending, false);

  // Upload tar.gz in merge mode -> rev-2 retains bin/tool-a and adds bin/tool-b
  const tarBuf = makeTarGz([{ name: 'bin/tool-b', mode: 0o755, content: '#!/bin/sh\necho tool-b\n' }]);
  const up2 = await uploadBinary(projectAdmin, '101', 'mode=merge&kind=archive&filename=extra.tar.gz&note=merge-b', tarBuf);
  assert.equal(up2.status, 201);
  assert.equal(up2.value.revision, 2);
  assert.deepEqual(up2.value.state.files.map(f => f.path), ['bin/tool-a', 'bin/tool-b']);

  // Delete file in merge mode -> rev-3
  const del = await projectAdmin('/api/repositories/101/tools/delete-files', 'POST', { paths: ['bin/tool-a'], note: 'drop a' });
  assert.equal(del.status, 201);
  assert.equal(del.value.revision, 3);
  assert.deepEqual(del.value.state.files.map(f => f.path), ['bin/tool-b']);

  // Rollback to rev-1
  const rb = await projectAdmin('/api/repositories/101/tools/rollback', 'POST', { revision: 1 });
  assert.equal(rb.status, 201);
  assert.equal(rb.value.revision, 1);
  assert.deepEqual(rb.value.state.files.map(f => f.path), ['bin/tool-a']);

  // Verify audit records exist for published & rolled_back
  const audits = h.store.all("SELECT action,resource_id FROM audit WHERE repository_id='101' AND action LIKE 'project_tools.%' ORDER BY rowid");
  assert.ok(audits.some(a => a.action === 'project_tools.published' && a.resource_id === 'rev-1'));
  assert.ok(audits.some(a => a.action === 'project_tools.rolled_back' && a.resource_id.startsWith('rev-1')));

  // Global quota setting: super_admin can update 1..200 GiB, project_admin gets 403
  assert.equal((await projectAdmin('/api/settings', 'PATCH', { project_tools_quota_gb: 30 })).status, 403);
  const badQuota = await admin('/api/settings', 'PATCH', { project_tools_quota_gb: 500 });
  assert.equal(badQuota.status, 400);
  const savedQuota = await admin('/api/settings', 'PATCH', { project_tools_quota_gb: 35 });
  assert.equal(savedQuota.status, 200);
  assert.equal(savedQuota.value.settings.project_tools_quota_gb, 35);

  // Storage report includes project_tools total + per-project attribution
  const storageRes = await admin('/api/storage');
  assert.equal(storageRes.status, 200);
  assert.equal(typeof storageRes.value.host.known.project_tools, 'number');
  assert.ok(storageRes.value.host.known.project_tools > 0, 'project_tools disk footprint must be measured');
  const p101Storage = storageRes.value.projects.find(p => p.repository_id === '101');
  assert.equal(p101Storage.project_tools.active_revision, 1);
  assert.equal(p101Storage.project_tools.quota_bytes, 35 * 1024 ** 3);
  const row101 = storageRes.value.overview.rows.find(r => r.id === '101');
  assert.ok(row101.bytes > 0, 'project overview row must include project_tools bytes');

  // Clear active revision
  const clr = await projectAdmin('/api/repositories/101/tools/clear', 'POST', { confirm: true });
  assert.equal(clr.status, 201);
  assert.equal(clr.value.state.active_revision, null);

  // Deleting project 101 removes DB rows AND on-disk /project-tools/101 directory
  assert.ok(await lstat(join(ptRoot, '101')).catch(() => null));
  const delProject = await admin('/api/projects/101', 'DELETE', { confirm: true });
  assert.equal(delProject.status, 200);
  assert.equal(await lstat(join(ptRoot, '101')).catch(() => null), null, 'project deletion must remove /project-tools/101');
  assert.equal(h.store.get("SELECT count(*) n FROM project_tool_revisions WHERE repository_id='101'").n, 0);
  assert.equal(h.store.get("SELECT count(*) n FROM project_tool_state WHERE repository_id='101'").n, 0);
});
