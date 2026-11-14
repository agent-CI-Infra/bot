import { statfsSync } from 'node:fs';
import { workspaceRoot, assistant } from './paths.mjs';

// The free space of a project computer's work volume (#671). The volume is on the host's data disk, and most of what a
// task writes lands in it: checkouts, dependency installs, test output. The runner checks it around the operations and
// commands that write and answers disk_full when the volume ran full, so the control plane stops the task waiting for
// space (src/agent/workspace.ts) instead of handing the failure to the model as an ordinary failed command or, worse,
// as failing tests.
// - full: less than the smaller of 1 % of the disk and 1 GiB is left.
// - low: less than the smaller of 5 % and 10 GiB is left, the control plane's task-start floor before its per-project
//   part (src/storage/disk.ts).
const GiB = 1024 ** 3, MiB = 1024 ** 2;
export const fullBytes = total => Math.min(Math.floor(total * 0.01), GiB);
export const lowBytes = total => Math.min(Math.floor(total * 0.05), 10 * GiB);

/** The volume holding path now; null when it cannot be read. */
export function volume(path = workspaceRoot) {
  try {
    const stats = statfsSync(path), free = stats.bavail * stats.bsize, total = stats.blocks * stats.bsize;
    return { free_bytes: free, total_bytes: total, full: free < fullBytes(total), low: free < lowBytes(total) };
  } catch { return null; }
}

// How file systems and the tools on top of them report a full disk or an exceeded quota.
const noSpaceText = /no space left on device|disk quota exceeded|\bENOSPC\b|\bEDQUOT\b/i;
/** An error that means the disk is full. */
export const noSpace = error => ['ENOSPC', 'EDQUOT'].includes(error?.code) || noSpaceText.test(String(error?.message ?? ''));
export const describeVolume = state => state ? `${Math.floor(state.free_bytes / MiB)} MiB free of ${Math.floor(state.total_bytes / MiB)} MiB` : 'free space unknown';

// The runner's journaled calls (runner/runner.mjs). A call that would write is refused while the volume is full, before
// it runs or is journaled, and one that failed for want of space, or while the volume is full, answers disk_full instead
// of runner_operation_failed. Calls that only read, or keep a small cache of what they read, are left as they are;
// answers to a running agent are small and never refused, so an agent about to finish still can. An assistant
// computer's volumes are its own business (manager/assistant-computers.mjs).
const reads = new Set(['read', 'workspace_read', 'workspace_source', 'workspace_integration_check', 'workspace_reuse', 'workspace_blob', 'workspace_export',
  'git_have', 'git_export', 'workspace_agent_poll', 'workspace_agent_live', 'workspace_agent_session', 'workspace_agent_runtime']);
const guarded = type => !assistant && !reads.has(type);
const answer = (input, reason, state) => ({ ok: false, error: 'disk_full', detail: `${input.type}${input.path ? ' ' + input.path : ''}: ${String(reason).slice(0, 2000)}; the work volume has ${describeVolume(state)}` });
/** The answer to a call that must not run on the volume now, or null. */
export function refuseFull(input, read = volume) {
  if (!guarded(input.type) || input.type.startsWith('workspace_agent_') && !['workspace_agent_start', 'workspace_agent_continue'].includes(input.type)) return null;
  const state = read(); return state?.full ? answer(input, 'refused, nothing was run', state) : null;
}
/** The answer to a call that failed with error when that was for want of space, or null. */
export function failedFull(input, error, read = volume) {
  if (!guarded(input.type)) return null;
  const state = read(); return noSpace(error) || state?.full ? answer(input, error?.message || 'operation failed', state) : null;
}

/**
 * Watches the volume while a command runs (statfs every second) and marks its result. A command that failed is marked
 * disk_full when the volume ran full at any time while it ran (cleanup after the failure can free the space again before
 * it ends), or when its output says there is no space left while the volume is low. That message on a volume with room
 * is left alone: a project's own tests may print it.
 */
export function watchVolume(read = volume, everyMs = 1000) {
  let lowest = read();
  const sample = () => { const now = read(); if (now && (!lowest || now.free_bytes < lowest.free_bytes)) lowest = now; return now; };
  const timer = setInterval(sample, everyMs); timer.unref?.();
  return {
    stop() { clearInterval(timer); },
    mark(result) {
      clearInterval(timer);
      const end = sample(), failed = !result.running && result.exit_code !== 0;
      if (!failed || !end || !(lowest.full || end.low && noSpaceText.test(String(result.output ?? '')))) return result;
      return { ...result, disk_full: { free_bytes: end.free_bytes, lowest_free_bytes: lowest.free_bytes, total_bytes: end.total_bytes } };
    },
  };
}

/** The reason to stop on a result of the agent's own tools in the computer (runner/pi-entry.mjs), or null. */
export function toolDiskFull(result) {
  if (result?.disk_full) return `the command failed while the volume ran full (${describeVolume({ free_bytes: result.disk_full.lowest_free_bytes, total_bytes: result.disk_full.total_bytes })} at the lowest)`;
  // A write that failed for want of space, as write_file reports it.
  return typeof result?.error === 'string' && noSpaceText.test(result.error) ? result.error.slice(0, 500) : null;
}
