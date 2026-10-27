import { mkdir, readFile, writeFile, realpath, readdir, rename, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { workspace as workspaceTool } from './workspace.mjs';
import { command } from './command.mjs';
import { execFile } from 'node:child_process';

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
  const outputFile = `${journal}/${input.operation_id}.out`;
  if(input.type.startsWith('workspace_')) return workspaceTool({ ...input, output_file: outputFile });
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
  if (input.type !== 'command') throw new Error('invalid_command');
  return command(input.command, workspace, input.timeout_ms, { outputFile });
}
// Live output of a running command, cut at a UTF-8 character boundary.
async function tail(input) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('invalid_offset');
  const record = await readFile(`${journal}/${input.operation_id}.json`, 'utf8').then(JSON.parse).catch(() => null);
  let handle; try { handle = await open(`${journal}/${input.operation_id}.out`, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return { data: '', offset: input.offset, size: 0, state: record?.state || 'missing' }; }
  try {
    const size = (await handle.stat()).size, buffer = Buffer.alloc(Math.max(0, Math.min(65536, size - input.offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
    let end = bytesRead; for (let back = 1; back <= 3 && end - back >= 0; back++) { const byte = buffer[end - back];
      if ((byte & 0xc0) === 0x80) continue; const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1; if (need > back) end -= back; break; }
    return { data: buffer.subarray(0, end).toString('utf8'), offset: input.offset + end, size, state: record?.state || 'running' };
  } finally { await handle.close(); }
}
async function processes() {
  const rows = [];
  for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) try {
    const stat = await readFile(`/proc/${name}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    rows.push({ pid: Number(name), state: fields[0], ppid: Number(fields[1]), cmdline: (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').filter(Boolean).join(' ') });
  } catch { /* The process already exited. */ }
  return rows;
}
// Bytes used by the work volume; bounded so a huge tree cannot hold the caller.
function usage() {
  return new Promise(resolve => execFile('du', ['-sxb', workspace], { timeout: 20000, maxBuffer: 65536 }, (error, stdout) =>
    resolve({ workspace_bytes: Number(String(stdout).split('\t')[0]) || null, complete: !error })));
}
// Ends every project process except init, the idle keeper and this runner. The container itself keeps running.
async function reap(workspaceId) {
  const keep = new Set([1, process.pid]);
  // The idle keeper is the first child of the container init; later processes cannot take a lower PID.
  const idle = (await processes()).filter(p => p.ppid === 1 && p.cmdline === 'node /opt/runner/idle.mjs').sort((a, b) => a.pid - b.pid)[0];
  if (idle) keep.add(idle.pid);
  if(idPattern.test(workspaceId||'')){
    const {waitingAgent}=await import('./agent.mjs'),pid=await waitingAgent(`/workspace/tasks/${workspaceId}`,await processes());
    if(pid)keep.add(pid);
  }
  let killed = 0;
  for (let round = 0; round < 20; round++) {
    const live = (await processes()).filter(p => !keep.has(p.pid) && p.state !== 'Z');
    if (!live.length) return { killed, remaining: 0 };
    for (const p of live) try { process.kill(p.pid, 'SIGKILL'); killed++; } catch { /* Already gone. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('reap_incomplete');
}
await mkdir(journal, { recursive: true, mode: 0o700 }); await mkdir('/workspace/home', { recursive: true });
const request = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString());
if (!idPattern.test(request.operation_id || '')) throw new Error('invalid_operation_id');
let result;
if (['tail', 'reap', 'usage'].includes(request.type)) {
  // Reading progress or usage and stopping leftovers are repeatable and never journaled.
  try { result = { ok: true, result: request.type === 'tail' ? await tail(request) : request.type === 'usage' ? await usage() : await reap(request.workspace_id) }; } catch { result = { ok: false, error: request.type + '_failed' }; }
} else try {
  const existing = await readFile(`${journal}/${request.operation_id}.json`, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) result = existing.state === 'completed' ? existing.result : { ok: false, error: 'operation_interrupted' };
  else {
    await save(request.operation_id, { state: 'running' });
    try { result = { ok: true, result: await execute(request) }; }
    catch(error) { result = { ok: false, error: 'runner_operation_failed', ...(request.type.startsWith('workspace_')?{detail:`${request.type}${request.path?' '+request.path:''}: ${String(error?.message||'operation failed').slice(0,8000)}`}:{}) }; }
    await save(request.operation_id, { state: 'completed', result });
    // The journal now holds the full result; the live copy is no longer needed.
    await unlink(`${journal}/${request.operation_id}.out`).catch(() => {});
  }
} catch { result = { ok: false, error: 'runner_journal_failed' }; }
process.stdout.write(JSON.stringify(result));
