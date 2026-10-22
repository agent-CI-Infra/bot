import { mkdir, readFile, writeFile, realpath, readdir, rename, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { spawn } from 'node:child_process';

const workspace = '/workspace', journal = workspace + '/.runner-journal';
const idPattern = /^[a-f0-9]{48}$/;
async function save(id, value) {
  const target = `${journal}/${id}.json`;
  await writeFile(target + '.tmp', JSON.stringify(value), { mode: 0o600 }); await rename(target + '.tmp', target);
}
async function filePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.startsWith('/') || value.split('/').some(p => p === '..' || p === '.runner-journal')) throw new Error('invalid_path');
  const target = resolve(workspace, value), parent = await realpath(dirname(target));
  if (parent !== workspace && !parent.startsWith(workspace + sep)) throw new Error('invalid_path');
  return target;
}
async function execute(input) {
  if (input.type === 'health') {
    let interrupted = 0;
    for (const name of await readdir(journal)) if (/^[a-f0-9]{48}\.json$/.test(name) && name !== `${input.operation_id}.json`) {
      const record = JSON.parse(await readFile(`${journal}/${name}`, 'utf8'));
      if (record.state === 'running') { await save(name.slice(0, -5), { state: 'interrupted' }); interrupted++; }
    }
    return { ready: true, runner_version: 1, interrupted };
  }
  if (input.type === 'write') {
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 48 * 1024) throw new Error('invalid_content');
    const handle = await open(await filePath(input.path), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(input.content); await handle.sync(); } finally { await handle.close(); }
    return { written: true };
  }
  if (input.type === 'read') {
    const handle = await open(await filePath(input.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if ((await handle.stat()).size > 1024 * 1024) throw new Error('file_too_large'); return { content: await handle.readFile('utf8') }; }
    finally { await handle.close(); }
  }
  if (input.type !== 'command' || typeof input.command !== 'string' || !input.command || input.command.length > 32768) throw new Error('invalid_command');
  const timeout = Math.min(60000, Math.max(100, Number(input.timeout_ms) || 10000));
  return new Promise((resolveResult, reject) => {
    // A process group is killed even when the shell exits, so background children cannot outlive the project lock.
    const child = spawn('/bin/sh', ['-c', input.command], { cwd: workspace, detached: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/workspace/home', LANG: 'C.UTF-8', TMPDIR: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, truncated = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    const collect = data => { if (Buffer.byteLength(output) + data.length <= 1024 * 1024) output += data.toString(); else { truncated = true; kill(); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { clearTimeout(timer); kill(); reject(error); });
    child.on('exit', () => kill());
    child.on('close', (code, signal) => { clearTimeout(timer); kill(); resolveResult({ exit_code: code, signal, output, timed_out: timedOut, truncated }); });
  });
}
await mkdir(journal, { recursive: true, mode: 0o700 }); await mkdir('/workspace/home', { recursive: true });
const request = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString());
if (!idPattern.test(request.operation_id || '')) throw new Error('invalid_operation_id');
let result;
try {
  const existing = await readFile(`${journal}/${request.operation_id}.json`, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) result = existing.state === 'completed' ? existing.result : { ok: false, error: 'operation_interrupted' };
  else {
    await save(request.operation_id, { state: 'running' });
    try { result = { ok: true, result: await execute(request) }; } catch { result = { ok: false, error: 'runner_operation_failed' }; }
    await save(request.operation_id, { state: 'completed', result });
  }
} catch { result = { ok: false, error: 'runner_journal_failed' }; }
process.stdout.write(JSON.stringify(result));
