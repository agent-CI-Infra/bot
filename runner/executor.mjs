import { mkdir, readFile, writeFile, realpath, readdir, rename, open, unlink, readlink, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { workspace as workspaceTool } from './workspace.mjs';
import { command } from './command.mjs';
import { RUNNER_PROTOCOL_VERSION, commandFailure } from './command-policy.mjs';
import { ownership, operationOwnership, isRunner, isKeeper, tasksRoot } from './ownership.mjs';
import { pruneJournal } from './journal.mjs';
import { storeOperation, pruneStore } from './store.mjs';
import { listTaskDirectories, removeTaskDirectories } from './task-dirs.mjs';
import { storageScan } from './storage-scan.mjs';
import { local, workspaceRoot, assistant, worktreesDirectory } from './paths.mjs';
import { assistantFile } from './assistant-files.mjs';
import { deleteCliConfig, inspectCliConfigs, writeCliConfig } from './cli-config.mjs';
import { refuseFull, failedFull } from './disk.mjs';

export const workspace = workspaceRoot;
export const journal = workspace + '/.runner-journal';
export const idPattern = /^[a-f0-9]{48}$/;

export const DAEMON_CAPABILITIES = Object.freeze([
  'http',
  'ws',
  'async_command',
  'stream_output',
  'mailbox_watch',
  'binary_transfer',
]);

const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;

let dirsPrepared = false;
export async function ensureRunnerDirs() {
  if (dirsPrepared) return;
  await mkdir(journal, { recursive: true, mode: 0o700 });
  if (!assistant) {
    await mkdir(workspace + '/home', { recursive: true });
    await mkdir(workspace + '/tmp', { recursive: true });
  }
  dirsPrepared = true;
}

export async function saveJournalRecord(id, value) {
  await mkdir(journal, { recursive: true, mode: 0o700 });
  const target = `${journal}/${id}.json`;
  await writeFile(target + '.tmp', JSON.stringify(value), { mode: 0o600 });
  await rename(target + '.tmp', target);
}

export async function readJournalRecord(id) {
  return readFile(`${journal}/${id}.json`, 'utf8')
    .then(JSON.parse)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

async function filePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.startsWith('/') || value.split('/').some(p => p === '..' || p === '.runner-journal')) {
    throw new Error('invalid_path');
  }
  const target = resolve(workspace, value), parent = await realpath(dirname(target));
  if (parent !== workspace && !parent.startsWith(workspace + sep)) throw new Error('invalid_path');
  return target;
}

export function healthResult(daemon = false) {
  return daemon
    ? { ready: true, runner_version: 1, protocol_version: RUNNER_PROTOCOL_VERSION, daemon: true, pid: process.pid, capabilities: DAEMON_CAPABILITIES }
    : { ready: true, runner_version: 1 };
}

async function executeInner(input, options = {}) {
  const outputFile = `${journal}/${input.operation_id}.out`;
  if (input.type.startsWith('workspace_')) {
    return workspaceTool({
      ...input,
      output_file: outputFile,
      ...(options.onOutput ? { _onOutput: options.onOutput } : {}),
      ...(options.onSpawn ? { _onSpawn: options.onSpawn } : {}),
    });
  }
  if (input.type.startsWith('git_')) return storeOperation(input);
  if (input.type.startsWith('assistant_')) {
    if (!assistant) throw new Error('invalid_command');
    return assistantFile(input);
  }
  // Health does not read the journal: a record left running by an earlier container already answers a repeated id
  // with operation_interrupted, and reading every record took longer than a start may on a computer with a large journal.
  if (input.type === 'health') return healthResult(options.daemon === true);
  if (input.type === 'write') {
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_WRITE_BYTES) throw new Error('invalid_content');
    const handle = await open(await filePath(input.path), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(input.content); await handle.sync(); } finally { await handle.close(); }
    return { written: true };
  }
  if (input.type === 'read') {
    const handle = await open(await filePath(input.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > MAX_READ_BYTES) throw new Error('file_too_large');
      return { content: await handle.readFile('utf8') };
    } finally { await handle.close(); }
  }
  if (input.type !== 'command') throw new Error('invalid_command');
  return command(input.command, workspace, input.timeout_ms, {
    outputFile,
    keepBackground: input.keep_background === true,
    operationId: input.operation_id,
    onOutput: options.onOutput,
    onSpawn: options.onSpawn,
    ...(assistant ? { backgroundDirectory: '/tmp/.bot-bg' } : {}),
  });
}

// Live output of a running command, cut at a UTF-8 character boundary.
export async function tailOperation(input) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('invalid_offset');
  const record = await readFile(`${journal}/${input.operation_id}.json`, 'utf8').then(JSON.parse).catch(() => null);
  let handle;
  try { handle = await open(`${journal}/${input.operation_id}.out`, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return { data: '', offset: input.offset, size: 0, state: record?.state || 'missing' }; }
  try {
    const maxBytes = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 512 * 1024) : 65536;
    const size = (await handle.stat()).size, buffer = Buffer.alloc(Math.max(0, Math.min(maxBytes, size - input.offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
    let end = bytesRead;
    for (let back = 1; back <= 3 && end - back >= 0; back++) {
      const byte = buffer[end - back];
      if ((byte & 0xc0) === 0x80) continue;
      const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (need > back) end -= back;
      break;
    }
    return { data: buffer.subarray(0, end).toString('utf8'), offset: input.offset + end, size, state: record?.state || 'running' };
  } finally { await handle.close(); }
}

async function processes() {
  const rows = [];
  for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) try {
    const stat = await readFile(`/proc/${name}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    rows.push({
      pid: Number(name),
      state: fields[0],
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      started: fields[19],
      cmdline: (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').filter(Boolean).join(' '),
    });
  } catch { /* The process already exited. */ }
  return rows;
}

// Bytes used by the work volume; bounded so a huge tree cannot hold the caller.
function usage() {
  return new Promise(resolveUsage => execFile('du', ['-sxb', workspace], { timeout: 20000, maxBuffer: 65536 }, (error, stdout) =>
    resolveUsage({ workspace_bytes: Number(String(stdout).split('\t')[0]) || null, complete: !error })));
}

// Without a workspace: ends every project process except init, the resident daemon/idle keeper and this runner; the container keeps
// running. With one: ends only the processes of that task workspace, so other tasks on the computer keep running;
// runner requests are left to finish, and keep_agent spares the task's agent while it waits for a policy command.
export async function reapProcesses({ workspace_id: workspaceId, keep_agent: keepAgent }, options = {}) {
  const keep = new Set([1, process.pid, ...(options.keepPids || [])]);
  const scoped = idPattern.test(workspaceId || '');
  // Host execution must never use the container-wide kill path.
  if (local && !scoped) throw new Error('local_reap_requires_workspace');
  // The resident daemon or legacy idle keeper is the first child of container init; later processes cannot take a lower PID.
  const keeper = (await processes()).filter(p => p.ppid === 1 && isKeeper(p)).sort((a, b) => a.pid - b.pid)[0];
  if (keeper) keep.add(keeper.pid);
  if (scoped && keepAgent) {
    const { waitingAgent } = await import('./agent.mjs');
    const pids = await waitingAgent(`${tasksRoot}${workspaceId}`, await processes());
    for (const pid of Array.isArray(pids) ? pids : pids ? [pids] : []) keep.add(pid);
  }
  let killed = 0;
  for (let round = 0; round < 20; round++) {
    const rows = await processes();
    const owner = scoped
      ? await ownership(rows, {
        environ: pid => readFile(`/proc/${pid}/environ`, 'utf8').catch(() => ''),
        cwd: pid => readlink(`/proc/${pid}/cwd`).catch(() => ''),
      })
      : null;
    const live = rows.filter(p => !keep.has(p.pid) && p.state !== 'Z' && (!owner || (!isRunner(p) && owner(p.pid) === workspaceId)));
    if (!live.length) {
      if (scoped && !keepAgent) {
        const marker = `${tasksRoot}${workspaceId}/agent/staged-cli-config.json`;
        try {
          const paths = JSON.parse(await readFile(marker, 'utf8'));
          if (Array.isArray(paths) && paths.length) {
            const { cleanupStagedCliConfig } = await import('./cli-config.mjs');
            await cleanupStagedCliConfig(paths);
          }
          await unlink(marker).catch(() => {});
        } catch {}
      }
      return { killed, remaining: 0 };
    }
    for (const p of live) try { process.kill(p.pid, 'SIGKILL'); killed++; } catch { /* Already gone. */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('reap_incomplete');
}

// An unscoped operation (for example a Git export or daemon command) has no task directory. Its children inherit
// BOT_OPERATION_ID (and daemon also tracks spawned process groups directly). Never use container-wide reap here.
export async function reapOperation(operationId, options = {}) {
  if (!idPattern.test(operationId || '')) throw new Error('invalid_target_operation');
  let killed = 0;
  const keep = new Set([1, process.pid, ...(options.keepPids || [])]);
  const trackedPids = options.activeOperations?.get(operationId);
  if (trackedPids) {
    for (const pid of trackedPids) {
      if (keep.has(pid)) continue;
      try { process.kill(-pid, 'SIGKILL'); killed++; }
      catch { try { process.kill(pid, 'SIGKILL'); killed++; } catch {} }
    }
  }
  const owned = new Map();
  for (let round = 0; round < 20; round++) {
    const rows = await processes();
    await operationOwnership(
      rows.filter(row => !keep.has(row.pid)),
      operationId,
      pid => readFile(`/proc/${pid}/environ`, 'utf8').catch(() => ''),
      owned,
    );
    const live = rows.filter(row => !keep.has(row.pid) && row.state !== 'Z' && owned.has(row.pid));
    if (!live.length) return { killed, remaining: 0 };
    for (const row of live) try {
      const stat = await readFile(`/proc/${row.pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== row.started) continue;
      process.kill(row.pgid === row.pid ? -row.pid : row.pid, 'SIGKILL');
      killed++;
    } catch { /* Already gone. */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('operation_reap_incomplete');
}

const NON_JOURNALED_TYPES = new Set([
  'tail', 'reap', 'reap_operation', 'usage', 'storage_scan', 'prune',
  'tasks_list', 'tasks_remove', 'worktrees_list', 'worktrees_remove',
  'workspace_harness_poll', 'cli_config_status', 'cli_config_write', 'cli_config_delete',
]);

/**
 * Core in-process runner dispatcher shared by the resident `runner/daemon.mjs` and the CLI `runner/runner.mjs`.
 */
export async function executeRunnerRequest(request, options = {}) {
  await ensureRunnerDirs();
  if (!request || typeof request !== 'object' || !idPattern.test(request.operation_id || '')) {
    throw new Error('invalid_operation_id');
  }
  let result;
  // journal_clear: an assistant computer's journal serves retries within one turn; the manager clears it when the turn ends.
  if (request.type === 'journal_clear' && assistant) {
    try {
      for (const name of await readdir(journal)) await rm(`${journal}/${name}`, { force: true });
      result = { ok: true, result: { cleared: true } };
    } catch {
      result = { ok: false, error: 'journal_clear_failed' };
    }
    return result;
  }
  if (assistant && ['assistant_archive_read', 'assistant_archive_cleanup'].includes(request.type)) {
    // Streaming reads and cleanup of packed archives are repeatable and never journaled so multi-GB exports never bloat .runner-journal.
    try { result = { ok: true, result: await assistantFile(request) }; }
    catch (error) {
      result = failedFull(request, error) ?? { ok: false, error: 'runner_operation_failed', detail: `${request.type}: ${String(error?.message || 'operation failed').slice(0, 2000)}` };
    }
    return result;
  }
  if (NON_JOURNALED_TYPES.has(request.type)) {
    // Reading progress or usage, measuring the work volume, stopping leftovers, removing old journal records, listing or
    // removing task directories and shared worktrees, and managing /workspace/home CLI config files are repeatable and
    // never journaled (so CLI config credentials never enter .runner-journal).
    try {
      result = {
        ok: true,
        result: request.type === 'tail' ? await tailOperation(request)
          : request.type === 'usage' ? await usage()
          : request.type === 'storage_scan' ? await storageScan(workspace)
          : request.type === 'prune' ? { journal: await pruneJournal(journal), store: await pruneStore() }
          : request.type === 'tasks_list' ? await listTaskDirectories()
          : request.type === 'tasks_remove' ? await removeTaskDirectories(request.entries)
          : request.type === 'worktrees_list' ? await listTaskDirectories(worktreesDirectory)
          : request.type === 'worktrees_remove' ? await removeTaskDirectories(request.entries, worktreesDirectory)
          : request.type === 'reap_operation' ? await reapOperation(request.target_operation_id, options)
          : request.type === 'cli_config_status' ? await inspectCliConfigs(workspace)
          : request.type === 'cli_config_write' ? await (async () => {
            let b64 = options.cliConfigB64;
            if (b64 === undefined && process.env.BOT_CLI_CONFIG_B64 !== undefined) {
              b64 = process.env.BOT_CLI_CONFIG_B64;
              delete process.env.BOT_CLI_CONFIG_B64;
            }
            const content = b64 !== undefined ? Buffer.from(b64, 'base64').toString('utf8') : request.content;
            return writeCliConfig(workspace, request.cli, request.file, content);
          })()
          : request.type === 'cli_config_delete' ? await deleteCliConfig(workspace, request.cli, request.file)
          : request.type === 'workspace_harness_poll' ? await executeInner(request, options)
          : await reapProcesses(request, options),
      };
    } catch (error) {
      result = {
        ok: false,
        error: request.type.startsWith('cli_config_')
          ? String(error?.message || 'cli_config_failed')
          : request.type === 'workspace_harness_poll' ? 'runner_operation_failed' : request.type + '_failed',
        ...(request.type.startsWith('tasks_') || request.type.startsWith('worktrees_') || request.type === 'workspace_harness_poll'
          ? { detail: String(error?.message || 'operation failed').slice(0, 2000) } : {}),
      };
    }
    return result;
  }
  try {
    const existing = options.preJournaled ? null : await readJournalRecord(request.operation_id);
    // A work volume that ran full answers disk_full (#671, runner/disk.mjs): the control plane stops the task waiting for space.
    const refusal = existing || options.preJournaled ? null : refuseFull(request);
    if (existing) {
      result = existing.state === 'completed' ? existing.result : { ok: false, error: 'operation_interrupted' };
    } else if (refusal) {
      result = refusal;
    } else {
      if (!options.preJournaled) await saveJournalRecord(request.operation_id, { state: 'running' });
      try {
        result = { ok: true, result: await executeInner(request, options) };
      } catch (error) {
        result = failedFull(request, error)
          ?? commandFailure(error)
          ?? {
            ok: false,
            error: 'runner_operation_failed',
            ...(/^(?:workspace|assistant)_/.test(request.type)
              ? { detail: `${request.type}${request.path ? ' ' + request.path : ''}: ${String(error?.message || 'operation failed').slice(0, 8000)}` }
              : {}),
          };
      }
      await saveJournalRecord(request.operation_id, { state: 'completed', result });
      // Small output is in the journal JSON. A preview does not replace the complete output: retain its file for the
      // control plane's streaming copy and for idempotent retries; journal pruning removes it with the other records.
      if (!result.result?.truncated) await unlink(`${journal}/${request.operation_id}.out`).catch(() => {});
    }
  } catch (error) {
    result = failedFull(request, error) ?? { ok: false, error: 'runner_journal_failed' };
  }
  return result;
}
