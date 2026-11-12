// A manager serving assistant computers (#457) for control-plane tests: this checkout's manager code over HTTP, with
// FakeDocker containers whose runner works on real directories (HOME is the owner's generation directory under `homes`,
// /tmp and /workspace are directories of the fake container). Commands run on the host with that HOME and working directory.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { open, rm, unlink, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AssistantComputers } from '../manager/assistant-computers.mjs';
import { Projects } from '../manager/projects.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { ManagerClient } from '../dist/projects/service.js';

export async function assistantManager(t) {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-fixture-')), homes = join(directory, 'homes'), containers = join(directory, 'containers');
  mkdirSync(homes); mkdirSync(containers);
  const docker = new FakeDocker(); docker.homesMount = homes; docker.info = { NCPU: 8, MemTotal: 32 * 1024 ** 3 };
  const commands = [];
  // A removed container takes its temporary files with it.
  const request = docker.request.bind(docker);
  docker.request = async (method, path, body) => {
    if (method === 'DELETE' && path.startsWith('/containers/')) rmSync(join(containers, path.split('/')[2].split('?')[0]), { recursive: true, force: true });
    return request(method, path, body);
  };
  // Where a path of a fake container lives on the host.
  const place = (name, path) => {
    const host = docker.containers.get(name).HostConfig, home = join(homes, host.Mounts[0].VolumeOptions.Subpath), root = join(containers, name);
    const absolute = resolve('/workspace', path);
    if (absolute === '/home/assistant' || absolute.startsWith('/home/assistant/')) return { path: join(home, absolute.slice(15)), readOnly: host.Mounts[0].ReadOnly, home };
    if (absolute.startsWith('/tmp/') || absolute.startsWith('/workspace/')) return { path: join(root, absolute), readOnly: false, home };
    throw new Error('invalid_path');
  };
  docker.runner = async (name, input) => {
    docker.runs.push(input);
    if (input.type === 'health') { mkdirSync(join(containers, name, 'tmp'), { recursive: true }); mkdirSync(join(containers, name, 'workspace'), { recursive: true }); return { ok: true, result: { ready: true } }; }
    if (['reap', 'journal_clear'].includes(input.type)) return { ok: true, result: {} };
    try {
      if (input.type === 'command') {
        const { home } = place(name, '/home/assistant'); commands.push({ container: name, command: input.command });
        const run = spawnSync('/bin/sh', ['-c', input.command], { cwd: join(containers, name, 'workspace'), env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: input.timeout_ms });
        return { ok: true, result: { exit_code: run.status, output: (run.stdout || '') + (run.stderr || ''), timed_out: false, truncated: false } };
      }
      const target = place(name, input.path);
      if (input.type === 'assistant_read') {
        // Like the runner: the final component is never followed.
        const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW); let data; try { data = await handle.readFile(); } finally { await handle.close(); }
        return { ok: true, result: { base64: data.subarray(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 1024 * 1024)).toString('base64'), offset: input.offset ?? 0, size: data.length } };
      }
      if (target.readOnly) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      if (input.type === 'assistant_write') {
        mkdirSync(dirname(target.path), { recursive: true });
        const handle = await open(target.path, input.offset === 0 ? 'w' : 'r+'); try { await handle.write(Buffer.from(input.base64, 'base64'), 0, undefined, input.offset); } finally { await handle.close(); }
        return { ok: true, result: { written: true } };
      }
      if (input.type === 'assistant_delete') {
        const info = await lstat(target.path).catch(() => null); if (!info) return { ok: true, result: { deleted: false } };
        if (info.isDirectory()) await rm(target.path, { recursive: true }); else await unlink(target.path);
        return { ok: true, result: { deleted: true, directory: info.isDirectory() } };
      }
    } catch (error) { return { ok: false, error: 'runner_operation_failed', detail: `${input.type} ${input.path ?? ''}: ${error.message}` }; }
    return { ok: false, error: 'runner_operation_failed' };
  };
  const db = new DatabaseSync(':memory:'), computers = new AssistantComputers({ docker, db, deployment: 'fixture', image: 'approved', homes });
  const projects = new Projects({ database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  const token = randomBytes(32), created = createManagerServer({ projects, token, assistants: computers });
  created.server.listen(0, '127.0.0.1'); await new Promise(r => created.server.once('listening', r)); await created.recovered;
  t.after(async () => { await new Promise(r => created.server.close(r)); projects.db.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { manager: new ManagerClient('http://127.0.0.1:' + created.server.address().port, token), computers, docker, homes, commands, directory,
    realHomes: await realpath(homes) };
}
