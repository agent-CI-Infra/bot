import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { ManagerError } from './docker.mjs';
import { logFailure } from './projects.mjs';

/**
 * Assistant computers (#457): one short-lived container per conversation owner (a group, or a person's private chats and
 * console conversations), created by the trusted manager beside the other containers. The control plane decides the owner,
 * its authorization fence and its HOME generation; the model never names a container, volume or path.
 *
 * Lifecycle of an owner's lease, in memory only (a manager restart removes every assistant container):
 * - acquire: the turn that first needs the computer marks it busy, reusing an idle container of the same fence, HOME
 *   generation and HOME mode that has not outlived max_lifetime; anything else is removed and created again;
 * - renew: the control plane renews a busy lease while its turn runs (model thinking included); a command in flight
 *   counts as use too. A busy lease that stops being renewed belongs to a stopped control plane and is removed;
 * - release: the turn ended; its processes end, the container stays and its idle timer starts;
 * - idle for idle_minutes, idle past max_lifetime, a changed fence or an explicit removal: removed at once (SIGKILL).
 * Capacity is max_containers: an idle container used longest ago gives way, otherwise new owners wait in arrival order.
 *
 * Hardening follows run-environments.mjs: uid 10001, read-only root, every capability dropped, no-new-privileges, init,
 * no network at all, private IPC, CPU/memory (no swap)/PID limits, tmpfs workspace and /tmp. The only persistent mount is
 * the owner's current HOME generation, a subpath of the shared HOME volume, never its parent.
 */
const mib = 1024 * 1024, ownerPattern = /^[a-f0-9]{32}$/, idPattern = /^[a-f0-9]{48}$/, turnPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const assistantHome = '/home/assistant';
// Fixed per-computer resources; tmpfs contents count against the memory limit.
export const assistantLimits = { cpus: 1, memory_mb: 2048, pids: 512, tmp_mb: 512, workspace_mb: 512 };
export const assistantDefaults = { idle_minutes: 5, max_containers: 20, max_lifetime_minutes: 240, runtime: 'runc' };
const bounds = { idle_minutes: [1, 120], max_containers: [1, 500], max_lifetime_minutes: [10, 7 * 24 * 60] };
const runtimePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A busy lease whose turn stopped renewing for this long (and runs nothing) is abandoned. The control plane renews every 30 s.
export const abandonAfterMs = 120_000;
// A waiting owner keeps its place while it asks again within this time; the control plane retries every 2 s.
const ticketMs = 15_000;
// Runner operations an assistant computer accepts: a shell command in /workspace, file access below HOME, /workspace and /tmp.
const types = ['command', 'assistant_read', 'assistant_write', 'assistant_delete'];
const keys = { command: ['command', 'timeout_ms'], assistant_read: ['path', 'offset', 'limit'], assistant_write: ['path', 'base64', 'offset'], assistant_delete: ['path'] };

function validateCall(call) {
  if (!call || typeof call !== 'object' || !types.includes(call.type) || Object.keys(call).some(k => k !== 'type' && !keys[call.type].includes(k))) throw new ManagerError('invalid_runner_request', 400);
  if (call.timeout_ms != null && !(Number.isSafeInteger(call.timeout_ms) && call.timeout_ms > 0)) throw new ManagerError('invalid_runner_request', 400);
  if (call.type !== 'command' && (typeof call.path !== 'string' || !call.path || call.path.length > 4096 || call.path.includes('\0'))) throw new ManagerError('invalid_runner_request', 400);
}
export function validateAssistantSettings(input, runtimes = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(k => !Object.hasOwn(assistantDefaults, k))) throw new ManagerError('invalid_assistant_settings', 400);
  for (const [key, [min, max]] of Object.entries(bounds)) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)) throw new ManagerError('invalid_assistant_settings', 400);
  if (input.runtime !== undefined && (typeof input.runtime !== 'string' || !runtimePattern.test(input.runtime))) throw new ManagerError('invalid_assistant_settings', 400);
  // Docker would refuse to start a container on a runtime it does not have; refuse the setting instead.
  if (input.runtime !== undefined && runtimes && !runtimes.includes(input.runtime)) throw new ManagerError('assistant_runtime_unavailable', 400);
  return input;
}

export class AssistantComputers {
  /** homes: where the HOME volume is mounted in the manager (read-only), to find its name and check a generation exists. */
  constructor({ docker, db, deployment, image, homes = '/assistant-homes' }) {
    this.docker = docker; this.db = db; this.deployment = deployment; this.image = image; this.homes = homes;
    // owner -> lease; owner -> pending removal; owner -> serialized operations; waiting: owners queued for capacity.
    this.leases = new Map(); this.removing = new Map(); this.locks = new Map(); this.waiting = [];
    this.db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  settings() { const saved = this.db.prepare("SELECT value FROM settings WHERE key='assistant_computers'").get(); return { ...assistantDefaults, ...(saved ? JSON.parse(saved.value) : {}) }; }
  async runtimes() { const info = await this.docker.request('GET', '/info').catch(() => null); return info?.Runtimes ? Object.keys(info.Runtimes).sort() : null; }
  async settingsView() {
    return { settings: this.settings(), defaults: assistantDefaults, bounds, limits: assistantLimits, runtimes: await this.runtimes(),
      usage: { computers: this.leases.size, busy: [...this.leases.values()].filter(l => l.state === 'busy').length, waiting: this.waiting.length } };
  }
  /** New values apply at once: timers on the next check, capacity on the next creation, the runtime to containers created from now on. */
  async setSettings(input) {
    validateAssistantSettings(input, input?.runtime !== undefined ? await this.runtimes() : null);
    this.db.prepare("INSERT INTO settings VALUES('assistant_computers',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...this.settings(), ...input }));
    return this.settingsView();
  }
  validate(owner) { if (!ownerPattern.test(owner || '')) throw new ManagerError('invalid_assistant_owner', 400); }
  name(owner) { return `dbot-${this.deployment}-ac-${owner}`; }
  labels(owner) { return { 'department.bot.deployment': this.deployment, 'department.bot.kind': 'assistant', 'department.bot.owner': owner }; }
  lock(owner, fn) { const previous = this.locks.get(owner) || Promise.resolve(), next = previous.then(fn, fn); const tail = next.catch(() => {}); this.locks.set(owner, tail); tail.then(() => { if (this.locks.get(owner) === tail) this.locks.delete(owner); }); return next; }
  async volume() {
    if (this.volumeName) return this.volumeName;
    const name = await this.docker.volumeName(this.homes).catch(() => null);
    if (!name) throw new ManagerError('assistant_homes_unavailable', 503);
    return this.volumeName = name;
  }
  view(lease) {
    return { owner: lease.owner, state: lease.state, turn: lease.turn, fence: lease.fence, home: { generation: lease.generation, mode: lease.mode },
      runtime: lease.runtime, image: lease.image, created_at: lease.created, used_at: lease.used, renewed_at: lease.renewed, running_operations: lease.inflight };
  }
  list() { return { computers: [...this.leases.values()].filter(l => l.state !== 'creating').map(l => this.view(l)), waiting: this.waiting.length, settings: this.settings() }; }
  /** Inspected facts of the owner's container, for the control plane's own policy check and for tests. */
  async inspect(owner) {
    const container = await this.docker.request('GET', `/containers/${this.name(owner)}/json`);
    if (container && Object.entries(this.labels(owner)).some(([k, v]) => container.Config?.Labels?.[k] !== v)) throw new ManagerError('resource_ownership_mismatch', 403);
    return container;
  }
  facts(container) {
    const host = container?.HostConfig ?? {}, config = container?.Config ?? {};
    return container ? { running: !!container.State?.Running, user: config.User ?? null, readonly_rootfs: host.ReadonlyRootfs === true, privileged: host.Privileged === true,
      cap_drop: host.CapDrop ?? [], cap_add: host.CapAdd ?? [], security_opt: host.SecurityOpt ?? [], network_mode: host.NetworkMode ?? null, runtime: host.Runtime ?? null,
      mounts: (host.Mounts ?? []).map(m => ({ type: m.Type, source: m.Source, target: m.Target, read_only: !!m.ReadOnly, subpath: m.VolumeOptions?.Subpath ?? null })),
      binds: host.Binds ?? [], tmpfs: host.Tmpfs ?? {}, memory: host.Memory ?? 0, memory_swap: host.MemorySwap ?? 0, nano_cpus: host.NanoCpus ?? 0, pids_limit: host.PidsLimit ?? 0,
      ipc_mode: host.IpcMode ?? null, pid_mode: host.PidMode ?? '', userns_mode: host.UsernsMode ?? '' } : null;
  }
  // Removes a lease now: it leaves the map at once (freeing its slot) and the container is killed in the background; a
  // later creation for the same owner waits for that. Never waits for the owner's lock, so it can stop a running command.
  discard(lease, reason) {
    if (this.leases.get(lease.owner) === lease) this.leases.delete(lease.owner);
    lease.removed = reason;
    const previous = this.removing.get(lease.owner) || Promise.resolve();
    const done = previous.then(() => this.docker.request('DELETE', `/containers/${this.name(lease.owner)}?force=true`))
      .catch(error => logFailure(`assistant computer ${lease.owner} removal (${reason}) failed`, error))
      .finally(() => { if (this.removing.get(lease.owner) === done) this.removing.delete(lease.owner); });
    this.removing.set(lease.owner, done);
    return done;
  }
  ticket(owner, turn) {
    const now = Date.now(); this.waiting = this.waiting.filter(t => now - t.seen < ticketMs);
    let ticket = this.waiting.find(t => t.owner === owner && t.turn === turn);
    if (!ticket) { ticket = { owner, turn, seen: now }; this.waiting.push(ticket); } else ticket.seen = now;
    return this.waiting.indexOf(ticket) + 1;
  }
  /**
   * The turn's computer, created when needed. Answers { state: 'ready', ... } or, without taking anything,
   * { state: 'queued', reason: 'capacity' | 'owner_busy', position } for the caller to ask again.
   */
  async acquire(owner, input) {
    this.validate(owner);
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['turn', 'fence', 'home_generation', 'home_mode'].includes(k))) throw new ManagerError('invalid_assistant_request', 400);
    const { turn, fence, home_generation: generation, home_mode: mode } = input;
    if (!turnPattern.test(turn || '') || !/^[a-f0-9]{16,128}$/.test(fence || '') || !Number.isSafeInteger(generation) || generation < 1 || !['rw', 'ro'].includes(mode)) throw new ManagerError('invalid_assistant_request', 400);
    return this.lock(owner, async () => {
      const now = Date.now(), settings = this.settings();
      let lease = this.leases.get(owner);
      if (lease?.state === 'busy' && lease.turn !== turn) {
        // Another turn of the same owner (a private chat and a console conversation of one person) holds it: wait for it,
        // unless that turn's control plane stopped renewing it.
        if (lease.inflight || now - lease.renewed < abandonAfterMs) return { state: 'queued', reason: 'owner_busy', position: 1 };
        this.discard(lease, 'abandoned'); lease = undefined;
      }
      if (lease) {
        const current = lease.fence === fence && lease.generation === generation && lease.mode === mode && lease.runtime === settings.runtime && lease.image === this.image
          && now - lease.created < settings.max_lifetime_minutes * 60_000;
        const running = current && (await this.inspect(owner).catch(() => null))?.State?.Running === true;
        if (running) {
          const reused = lease.state === 'idle';
          lease.state = 'busy'; lease.turn = turn; lease.renewed = now;
          return { state: 'ready', reused, computer: this.view(lease) };
        }
        // A changed fence, HOME generation or mode, another runtime or image, or a container past its lifetime: replaced,
        // keeping the owner's slot.
        this.discard(lease, 'replaced');
      } else {
        // A new container needs a free slot and its turn in the queue; an idle container used longest ago gives way.
        const position = this.waiting.length || this.leases.size >= settings.max_containers ? this.ticket(owner, turn) : 0;
        if (position > 1) return { state: 'queued', reason: 'capacity', position };
        if (this.leases.size >= settings.max_containers) {
          const idle = [...this.leases.values()].filter(l => l.state === 'idle').sort((a, b) => a.used - b.used)[0];
          if (!idle) return { state: 'queued', reason: 'capacity', position: Math.max(position, 1) };
          this.discard(idle, 'capacity');
        }
        this.waiting = this.waiting.filter(t => t.owner !== owner);
      }
      lease = { owner, turn, fence, generation, mode, runtime: settings.runtime, image: this.image, state: 'creating', created: now, used: now, renewed: now, inflight: 0 };
      this.leases.set(owner, lease);
      try {
        await this.create(lease);
      } catch (error) {
        this.discard(lease, 'create_failed');
        throw error instanceof ManagerError ? error : Object.assign(new ManagerError('assistant_computer_create_failed', 503), { detail: String(error?.message || error) });
      }
      // Removed while it was being created (a changed fence, a reconcile): its removal may have run before the container
      // existed, so it is removed again now.
      if (lease.removed) { await this.discard(lease, lease.removed); throw new ManagerError('assistant_computer_released', 410); }
      lease.state = 'busy'; lease.created = lease.used = lease.renewed = Date.now();
      return { state: 'ready', reused: false, computer: this.view(lease) };
    });
  }
  async create(lease) {
    const { owner } = lease, name = this.name(owner), l = assistantLimits, volume = await this.volume(), subpath = `${owner}/home-${lease.generation}`;
    // The control plane creates the generation directory; it must be a real directory inside this owner's directory.
    if (this.homes) for (const path of [`${this.homes}/${owner}`, `${this.homes}/${subpath}`]) {
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory()) throw new ManagerError('assistant_home_missing', 409);
    }
    await this.removing.get(owner);
    // A container left by an earlier lease of this owner (a failed removal) is never reused.
    if (await this.inspect(owner)) await this.docker.request('DELETE', `/containers/${name}?force=true`);
    await this.docker.request('POST', `/containers/create?name=${name}`, { Image: lease.image, User: '10001:10001', WorkingDir: '/workspace', Hostname: 'assistant',
      Cmd: ['node', '/opt/runner/idle.mjs'], Env: [`HOME=${assistantHome}`, 'LANG=C.UTF-8', 'BOT_COMPUTER_KIND=assistant'], Labels: this.labels(owner),
      HostConfig: { Runtime: lease.runtime, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, Init: true, RestartPolicy: { Name: 'no' },
        Memory: l.memory_mb * mib, MemorySwap: l.memory_mb * mib, NanoCpus: Math.round(l.cpus * 1e9), PidsLimit: l.pids, IpcMode: 'private', NetworkMode: 'none',
        Mounts: [{ Type: 'volume', Source: volume, Target: assistantHome, ReadOnly: lease.mode === 'ro', VolumeOptions: { NoCopy: true, Subpath: subpath } }],
        Tmpfs: { '/workspace': `rw,nosuid,nodev,size=${l.workspace_mb * mib},uid=10001,gid=10001,mode=0700`, '/tmp': `rw,nosuid,nodev,size=${l.tmp_mb * mib},mode=1777` } } });
    await this.docker.request('POST', `/containers/${name}/start`);
    const health = await this.docker.runner(name, { operation_id: randomBytes(24).toString('hex'), type: 'health' });
    if (!health?.ok || !health.result?.ready) throw new ManagerError('runner_not_ready');
  }
  held(owner, turn) {
    const lease = this.leases.get(owner);
    if (!lease) throw new ManagerError('assistant_computer_released', 410);
    if (lease.state !== 'busy' || lease.turn !== turn) throw new ManagerError('assistant_computer_not_acquired', 409);
    return lease;
  }
  renew(owner, input) {
    this.validate(owner);
    if (!input || Object.keys(input).some(k => k !== 'turn') || !turnPattern.test(input.turn || '')) throw new ManagerError('invalid_assistant_request', 400);
    const lease = this.held(owner, input.turn); lease.renewed = Date.now();
    return { state: 'busy', renewed_at: lease.renewed };
  }
  /** One runner operation of the turn holding the computer. A command never outlives the removal of its container. */
  async execute(owner, input) {
    this.validate(owner);
    if (!input || Object.keys(input).some(k => !['turn', 'operation_id', 'request'].includes(k)) || !turnPattern.test(input.turn || '') || !idPattern.test(input.operation_id || '')) throw new ManagerError('invalid_operation', 400);
    validateCall(input.request);
    const lease = this.held(owner, input.turn), command = input.request.type === 'command';
    lease.inflight++; lease.renewed = Date.now();
    try {
      return await this.docker.runner(this.name(owner), { ...input.request, operation_id: input.operation_id }, command ? (input.request.timeout_ms ?? 10_000) + 30_000 : 90_000);
    } catch (error) {
      if (lease.removed) throw new ManagerError('assistant_computer_released', 410);
      throw error;
    } finally { lease.inflight--; lease.renewed = Date.now(); }
  }
  /** The turn ended: every process it started ends, and the idle timer starts. remove (a changed fence) removes it at once. */
  async release(owner, input) {
    this.validate(owner);
    if (!input || Object.keys(input).some(k => !['turn', 'remove'].includes(k)) || !turnPattern.test(input.turn || '') || input.remove !== undefined && typeof input.remove !== 'boolean') throw new ManagerError('invalid_assistant_request', 400);
    return this.lock(owner, async () => {
      const lease = this.leases.get(owner);
      if (!lease || lease.turn !== input.turn || lease.state !== 'busy') return { state: lease ? lease.state : 'removed', released: false };
      if (input.remove) { await this.discard(lease, 'released'); return { state: 'removed', released: true }; }
      // Without a workspace id the runner ends every process except init, the idle keeper and itself.
      const reaped = await this.docker.runner(this.name(owner), { operation_id: randomBytes(24).toString('hex'), type: 'reap' }).catch(error => ({ ok: false, error }));
      if (!reaped?.ok) { logFailure(`assistant computer ${owner} reap failed, removed`, reaped?.error || 'no detail'); await this.discard(lease, 'reap_failed'); return { state: 'removed', released: true }; }
      // The runner journal only serves retries within a turn; clearing it keeps the tmpfs for the next turn's work.
      await this.docker.runner(this.name(owner), { operation_id: randomBytes(24).toString('hex'), type: 'journal_clear' }).catch(error => logFailure(`assistant computer ${owner} journal clear failed`, error));
      lease.state = 'idle'; lease.turn = null; lease.used = Date.now();
      return { state: 'idle', released: true };
    });
  }
  async remove(owner, reason = 'removed') {
    this.validate(owner);
    const lease = this.leases.get(owner);
    if (lease) await this.discard(lease, reason);
    else {
      // Without a lease the container may still be going away from an earlier discard (the lease leaves the map first).
      // Wait for that removal: a second DELETE meanwhile gets Docker's 409 "removal already in progress", and the caller
      // (the control plane's sweep, a console clear, retention) would fail although the computer is gone.
      await this.removing.get(owner);
      if (await this.inspect(owner).catch(() => null)) await this.docker.request('DELETE', `/containers/${this.name(owner)}?force=true`);
    }
    return { owner, state: 'removed' };
  }
  /** After a control plane restart: only the turns it still runs keep their computers. */
  async reconcile(input) {
    if (!input || Object.keys(input).some(k => k !== 'turns') || !Array.isArray(input.turns) || input.turns.length > 10_000 || input.turns.some(t => !turnPattern.test(t || ''))) throw new ManagerError('invalid_assistant_request', 400);
    // A lease being created for a turn that is not kept is removed too; its acquire removes the container once it exists.
    const keep = new Set(input.turns), removed = [...this.leases.values()].filter(l => !(['busy', 'creating'].includes(l.state) && keep.has(l.turn)));
    await Promise.all(removed.map(lease => this.discard(lease, 'reconciled')));
    return { removed: removed.length };
  }
  /** Every few seconds: idle timers, abandoned turns and containers idle past their lifetime. */
  async check() {
    const now = Date.now(), { idle_minutes: idle, max_lifetime_minutes: lifetime } = this.settings();
    this.waiting = this.waiting.filter(t => now - t.seen < ticketMs);
    const expired = [];
    for (const lease of this.leases.values()) {
      if (lease.state === 'idle' && (now - lease.used >= idle * 60_000 || now - lease.created >= lifetime * 60_000)) expired.push([lease, now - lease.used >= idle * 60_000 ? 'idle' : 'lifetime']);
      else if (lease.state === 'busy' && !lease.inflight && now - lease.renewed >= abandonAfterMs) expired.push([lease, 'abandoned']);
    }
    await Promise.all(expired.map(([lease, reason]) => this.discard(lease, reason)));
    return expired.length;
  }
  /** On start: assistant containers of this deployment are left from before and removed, never reused. */
  async recover() {
    const filters = encodeURIComponent(JSON.stringify({ label: [`department.bot.deployment=${this.deployment}`, 'department.bot.kind=assistant'] }));
    const containers = await this.docker.request('GET', `/containers/json?all=1&filters=${filters}`) || [];
    for (const container of containers) await this.docker.request('DELETE', `/containers/${container.Id}?force=true`).catch(error => logFailure('leftover assistant computer removal failed', error));
    return containers.length;
  }
  async shutdown() { await Promise.all([...this.leases.values()].map(lease => this.discard(lease, 'manager_stopped'))); await Promise.all([...this.removing.values()]); }
}
