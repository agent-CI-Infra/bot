import { randomId } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import type { Manager } from './service.js';
import type { EnvironmentFacts } from '../roles/role-run.js';
/**
 * Control-plane side of per-run environments (manager/run-environments.mjs). The manager reports the inspected container
 * settings; this module decides whether they satisfy the isolation policy, so a manager bug or a changed default cannot
 * turn into a silent isolation claim. A run is admitted with run_isolation only when verifyRunEnvironment passes for that
 * very container.
 */
export interface RunEnvironmentSpec { run_id: string; task_id: string; lease_epoch: number; profile: 'writer' | 'observer'; network?: 'none' | 'egress'; limits?: Record<string, number> }
export class RunEnvironmentClient {
  constructor(readonly manager: Manager, readonly repositoryId: string) {}
  private path(run?: string, action?: string) { return `/v1/projects/${this.repositoryId}/runs${run ? '/' + run : ''}${action ? '/' + action : ''}`; }
  create(spec: RunEnvironmentSpec) { return this.manager.call('POST', this.path(), { run: spec } as any, 180000); }
  inspect(run: string) { return this.manager.call('GET', this.path(run)); }
  release(run: string) { return this.manager.call('DELETE', this.path(run)); }
  /** One runner operation in the run's own workspace (its workspace id is the run id). */
  async call(run: string, request: Record<string, unknown>, timeoutMs = 0) {
    const response = await this.manager.call('POST', this.path(run, 'execute'), { operation_id: randomId(), request: { ...request, ...(String(request.type).startsWith('workspace_') ? { workspace_id: run } : {}) } } as any, timeoutMs);
    return response?.ok ? response.result : { error: response?.error ?? 'runner_operation_failed', ...(response?.detail ? { detail: response.detail } : {}) };
  }
}
// Environment variable names an image may set; anything credential-shaped is a violation whatever its value.
const credentialName = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|^BOT_|^GH_|^GITHUB_|^AWS_|^OPENAI|^ANTHROPIC|^DOCKER_)/i;
/** Checks inspected facts against the isolation policy. Every violation is named; none is tolerated. */
export function verifyRunEnvironment(facts: any, expected: { run_id: string; network: 'none' | 'egress' }) {
  const c = facts?.container, violations: string[] = [];
  if (!c) return { verified: false, violations: ['container_missing'] };
  const [uid, gid] = String(c.user ?? '').split(':');
  if (!uid || uid === '0' || uid === 'root' || gid === '0') violations.push('user_not_unprivileged');
  if (!c.readonly_rootfs) violations.push('root_filesystem_writable');
  if (c.privileged) violations.push('privileged');
  if (!c.cap_drop?.map((x: string) => x.toUpperCase()).includes('ALL') || c.cap_add?.length) violations.push('capabilities_not_dropped');
  if (!c.security_opt?.some((o: string) => /^no-new-privileges(?::true)?$/.test(o))) violations.push('new_privileges_allowed');
  // No volume or bind of any kind: no developer volume, notes, host HOME, Docker socket or other project state.
  if (c.mounts?.some((m: any) => m.type !== 'tmpfs') || c.binds?.length) violations.push('external_mount');
  if (JSON.stringify([c.mounts, c.binds]).includes('docker.sock')) violations.push('docker_socket');
  if (!c.tmpfs?.['/workspace'] || !/size=\d+/.test(c.tmpfs['/workspace']) || !c.tmpfs?.['/tmp'] || !/size=\d+/.test(c.tmpfs['/tmp'])) violations.push('workspace_not_private_tmpfs');
  const ownNetwork = expected.network === 'egress' ? new RegExp(`-run-${expected.run_id.slice(0, 20)}-net$`) : null;
  if (expected.network === 'none' ? c.network_mode !== 'none' : !ownNetwork!.test(c.network_mode ?? '') || c.networks?.some((n: string) => !ownNetwork!.test(n))) violations.push('network_identity_shared');
  if (c.pid_mode && c.pid_mode !== 'private') violations.push('process_namespace_shared');
  if (c.ipc_mode && !['private', 'none'].includes(c.ipc_mode)) violations.push('ipc_namespace_shared');
  if (c.userns_mode === 'host') violations.push('user_namespace_host');
  if (!(c.memory > 0) || c.memory_swap !== c.memory || !(c.pids_limit > 0) || !(c.nano_cpus > 0)) violations.push('resource_limits_missing');
  if (c.env_names?.some((name: string) => credentialName.test(name))) violations.push('credential_environment');
  if (facts.run_id !== expected.run_id || facts.state !== 'ready' || !c.running) violations.push('not_this_run');
  return { verified: !violations.length, violations };
}
/** Creates the environment of one run and returns it with the admission facts. A failed check releases it at once. */
export async function provisionRunEnvironment(client: RunEnvironmentClient, spec: RunEnvironmentSpec): Promise<{ facts: EnvironmentFacts; described: any; release: () => Promise<void> }> {
  const described = await client.create(spec), check = verifyRunEnvironment(described, { run_id: spec.run_id, network: spec.network ?? 'none' });
  let released = false;
  const release = async () => { if (released) return; released = true; await client.release(spec.run_id).catch(() => {}); };
  const facts: EnvironmentFacts = { id: 'run:' + spec.run_id, isolation: 'run_container', verified: check.verified, evidence: check.verified ? `run_environments:${spec.run_id}` : null, detail: { violations: check.violations, container: described?.container?.name ?? null, limits: described?.limits ?? null } };
  if (!check.verified) await release();
  return { facts, described, release };
}
/**
 * Copies the objects of one commit from a source computer (the project computer, or another run's environment) into a
 * run's own git store, then checks it out and verifies the tree. Nothing of the source is mounted, so later changes
 * there cannot reach this run.
 */
export async function copyCommit(source: { call: (request: Record<string, unknown>) => Promise<any> }, target: RunEnvironmentClient, run: string, sha: string, tree: string) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{40}$/.test(tree)) throw new TaskError('run_candidate_invalid', 'failed');
  const pack = randomId();let offset = 0, size = 0;
  for (;;) {
    const chunk = await source.call({ type: 'git_export', pack_id: pack, sha, offset });
    if (chunk?.error || typeof chunk?.base64 !== 'string') throw new TaskError('run_candidate_export_failed', 'waiting_environment', String(chunk?.error ?? 'no_chunk'));
    const written = await target.call(run, { type: 'git_pack', pack_id: pack, base64: chunk.base64, offset });
    if (written?.error) throw new TaskError('run_candidate_import_failed', 'waiting_environment', String(written.error));
    offset += Buffer.from(chunk.base64, 'base64').length; size = chunk.size;
    if (chunk.done) break;
  }
  const imported = await target.call(run, { type: 'git_import', pack_id: pack, commits: [sha] });
  if (imported?.error) throw new TaskError('run_candidate_import_failed', 'waiting_environment', String(imported.error));
  const checkout = await target.call(run, { type: 'workspace_checkout', sha, tree_sha: tree });
  if (checkout?.error || checkout.tree_sha !== tree) throw new TaskError('run_candidate_mismatch', 'waiting_environment', String(checkout?.error ?? checkout?.tree_sha));
  return { commit_sha: sha, tree_hash: checkout.tree_sha, pack_bytes: size };
}
