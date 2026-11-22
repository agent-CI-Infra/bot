import { readFile, readdir } from 'node:fs/promises';

// The control plane renews only while it still holds the run. This also ends an ACP process group after a crash.
export const ACP_LEASE_MS = 30_000;
export const acpLeaseFile = (dir, id) => `${dir}/harness-lease-${id}`;

// A product may start a daemon in a new process group. Match the instance tag before signaling it, so a later run in the
// same workspace or an unrelated command cannot be mistaken for a descendant of this ACP session.
export async function reapAcpDescendants(id) {
  const tag = `BOT_ACP_INSTANCE_ID=${id}`;
  for (const name of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(name) || Number(name) <= 1) continue;
    const env = await readFile(`/proc/${name}/environ`, 'utf8').catch(() => '');
    if (env.split('\0').includes(tag)) {
      try { process.kill(Number(name), 'SIGKILL'); } catch {}
    }
  }
}
