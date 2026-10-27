// Which task workspace a project process belongs to: its BOT_WORKSPACE_ID tag, the workspace a runner request or agent
// was started for, or its working directory under /workspace/tasks; otherwise that of its parent. Null for none.
// environ(pid) and cwd(pid) read /proc in the computer; tests pass their own.
export const tasksRoot = '/workspace/tasks/';
const idPattern = /^[a-f0-9]{48}$/, runnerPrefix = 'node /opt/runner/runner.mjs ', agentPrefix = 'node /opt/runner/pi-entry.mjs ' + tasksRoot;
export const isRunner = row => row.cmdline.startsWith(runnerPrefix);
export async function ownership(rows, { environ, cwd }) {
  const byPid = new Map(rows.map(row => [row.pid, row])), direct = new Map(), resolved = new Map();
  for (const row of rows) {
    let id = String(await environ(row.pid)).split('\0').find(entry => entry.startsWith('BOT_WORKSPACE_ID='))?.slice(17) || null;
    if (!id && isRunner(row)) try { id = JSON.parse(Buffer.from(row.cmdline.slice(runnerPrefix.length), 'base64url').toString()).workspace_id || null; } catch { /* Not a request. */ }
    if (!id && row.cmdline.startsWith(agentPrefix)) id = row.cmdline.slice(agentPrefix.length).split('/')[0];
    if (!id) { const dir = String(await cwd(row.pid)); if (dir.startsWith(tasksRoot)) id = dir.slice(tasksRoot.length).split('/')[0]; }
    direct.set(row.pid, idPattern.test(id || '') ? id : null);
  }
  const owner = (pid, depth = 0) => {
    if (resolved.has(pid)) return resolved.get(pid);
    const row = byPid.get(pid); if (!row) return null;
    const value = direct.get(pid) ?? (depth < 64 && row.ppid > 1 ? owner(row.ppid, depth + 1) : null);
    resolved.set(pid, value); return value;
  };
  return owner;
}
