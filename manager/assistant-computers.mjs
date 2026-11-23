import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { ManagerError } from './docker.mjs';
import { clampMemoryToHost, logFailure, resourceBounds, validResource, validateCall as validateProjectCall } from './projects.mjs';

/**
 * Assistant computers (#457): one short-lived container per conversation owner (a group, or a person's private chats and
 * console conversations), created by the trusted manager beside the other containers. The control plane decides the owner,
 * its authorization fence and its HOME generation; the model never names a container, volume or path.
 *
 * Lifecycle of an owner's lease, in memory only (a manager restart removes every assistant container):
 * - acquire: the turn that first needs the computer marks it busy, reusing an idle container of the same fence, HOME
 *   generation, HOME mode and resources that has not outlived max_lifetime; anything else is removed and created again;
 * - renew: the control plane renews a busy lease while its turn runs (model thinking included); a command in flight
 *   counts as use too. A busy lease that stops being renewed belongs to a stopped control plane and is removed;
 * - release: the turn ended; its processes end, the container stays and its idle timer starts;
 * - idle for idle_minutes, idle past max_lifetime, a changed fence or an explicit removal: removed at once (SIGKILL).
 * Capacity is max_containers: an idle container used longest ago gives way, otherwise new owners wait in arrival order.
 *
 * Hardening: uid 10001, read-only root, every capability dropped, no-new-privileges, init,
 * isolated network (configurable egress, default enabled on a dedicated ICC-disabled bridge network isolated from the
 * control network; when egress is disabled, no network at all), private IPC, CPU/memory (no swap)/PID limits, ephemeral
 * disk-backed Docker volumes for /workspace and /tmp (decoupled from cgroup memory and deleted with the container), Docker's default runtime.
 * The only persistent mount is the owner's current HOME generation, a subpath of the shared HOME volume, never its parent.
 */
const mib = 1024 * 1024, ownerPattern = /^[a-f0-9]{32}$/, idPattern = /^[a-f0-9]{48}$/, turnPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const assistantHome = '/home/assistant';
// Timers and capacity, then each computer's resources and egress: the project computers' resources in the same bounds,
// plus the working directory limit. /workspace and /tmp are ephemeral disk-backed Docker volumes so large checkouts and
// builds (default 20 GiB) do not consume the container's 16 GiB RAM limit (#1279).
// An idle computer stays half an hour (#1254): a harness turn (Pi, Codex, Claude Code) needs one every turn, and an idle
// container costs a few MiB; when capacity is full the one used longest ago still gives way.
export const assistantDefaults = { idle_minutes: 30, max_containers: 20, max_lifetime_minutes: 240, cpus: 1, memory_mb: 16384, pids: 512, tmp_mb: 20480, workspace_mb: 20480, egress: true };
const timerBounds = { idle_minutes: [1, 120], max_containers: [1, 500], max_lifetime_minutes: [10, 7 * 24 * 60] };
const sizeBounds = { ...resourceBounds, workspace_mb: resourceBounds.tmp_mb }, resourceKeys = Object.keys(sizeBounds);
const bounds = { ...timerBounds, ...sizeBounds };
const resourcesOf = settings => Object.fromEntries(resourceKeys.map(key => [key, settings[key]]));
// A busy lease whose turn stopped renewing for this long (and runs nothing) is abandoned. The control plane renews every 30 s.
export const abandonAfterMs = 120_000;
// A waiting owner keeps its place while it asks again within this time; the control plane retries every 2 s.
const ticketMs = 15_000;
// Runner operations an assistant computer accepts: a shell command in /workspace, file access below HOME, /workspace and /tmp,
// and control-plane staged repository archive extraction into /workspace or /tmp.
const types = ['command', 'assistant_read', 'assistant_write', 'assistant_delete', 'assistant_archive_stage', 'assistant_archive_extract'];
const keys = {
  command: ['command', 'timeout_ms', 'keep_background'],
  assistant_read: ['path', 'offset', 'limit'],
  assistant_write: ['path', 'base64', 'offset'],
  assistant_delete: ['path'],
  assistant_archive_stage: ['stage_id', 'base64', 'offset'],
  assistant_archive_extract: ['stage_id', 'destination', 'overwrite'],
};

function validateCall(call, harness = false) {
  if(harness&&(call?.type==='workspace_init'||call?.type==='reap'||call?.type?.startsWith('workspace_agent_')||call?.type?.startsWith('workspace_harness_'))){validateProjectCall(call);return;}
  if (!call || typeof call !== 'object' || !types.includes(call.type) || Object.keys(call).some(k => k !== 'type' && !keys[call.type].includes(k))) throw new ManagerError('invalid_runner_request', 400);
  if (call.timeout_ms != null && !(Number.isSafeInteger(call.timeout_ms) && call.timeout_ms > 0)) throw new ManagerError('invalid_runner_request', 400);
  if (call.keep_background !== undefined && typeof call.keep_background !== 'boolean') throw new ManagerError('invalid_runner_request', 400);
  if (['assistant_read', 'assistant_write', 'assistant_delete'].includes(call.type) && (typeof call.path !== 'string' || !call.path || call.path.length > 4096 || call.path.includes('\0'))) throw new ManagerError('invalid_runner_request', 400);
  if (['assistant_archive_stage', 'assistant_archive_extract'].includes(call.type) && !idPattern.test(call.stage_id || '')) throw new ManagerError('invalid_runner_request', 400);
  if (call.type === 'assistant_archive_extract' && (typeof call.destination !== 'string' || !call.destination || call.destination.length > 4096 || call.destination.includes('\0') || (call.overwrite !== undefined && typeof call.overwrite !== 'boolean'))) throw new ManagerError('invalid_runner_request', 400);
}
export function validateAssistantSettings(input, host = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(k => !Object.hasOwn(assistantDefaults, k))) throw new ManagerError('invalid_assistant_settings', 400);
  for (const [key, [min, max]] of Object.entries(timerBounds)) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)) throw new ManagerError('invalid_assistant_settings', 400);
  for (const key of resourceKeys) if (input[key] !== undefined && !validResource(key, input[key], sizeBounds)) throw new ManagerError('invalid_assistant_settings', 400);
  if (input.egress !== undefined && typeof input.egress !== 'boolean') throw new ManagerError('invalid_assistant_settings', 400);
  // Docker refuses to create a container that is given more CPUs or memory than the host has.
  const hostCpus = typeof host === 'number' ? host : host?.cpus ?? null;
  const hostMemoryMb = typeof host === 'object' && host ? host.memory_mb ?? null : null;
  if (hostCpus && input.cpus !== undefined && input.cpus > hostCpus) throw new ManagerError('cpus_exceed_host', 400);
  if (hostMemoryMb && input.memory_mb !== undefined && input.memory_mb > hostMemoryMb) throw new ManagerError('memory_exceeds_host', 400);
  return input;
}

export class AssistantComputers {
  /** homes: where the HOME volume is mounted in the manager (read-only), to find its name and check a generation exists. */
  constructor({ docker, db, deployment, image, homes = '/assistant-homes', agentTools, resultMount, globalEnvironment = null, disk = null }) {
    this.docker = docker; this.db = db; this.deployment = deployment; this.image = image; this.homes = homes; this.agentTools=agentTools; this.resultMount=resultMount;
    this.globalEnvironment = globalEnvironment; this.disk = disk;
    // owner -> lease; owner -> pending removal; owner -> serialized operations; waiting: owners queued for capacity.
    this.leases = new Map(); this.removing = new Map(); this.locks = new Map(); this.waiting = [];
    this.db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    // Saving used to store every key, defaults included, so a saved idle time of 5 minutes is the old default rather than a
    // choice: once, it follows the new default (#1254). A value saved from now on is kept as given.
    // The marker keeps what was replaced, and the log says so.
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='assistant_idle_default'").get()) {
      const saved = this.db.prepare("SELECT value FROM settings WHERE key='assistant_computers'").get(), values = saved ? JSON.parse(saved.value) : null;
      const replaced = values?.idle_minutes === 5;
      if (replaced) { delete values.idle_minutes; this.db.prepare("UPDATE settings SET value=? WHERE key='assistant_computers'").run(JSON.stringify(values)); }
      this.db.prepare("INSERT INTO settings VALUES('assistant_idle_default',?)").run(JSON.stringify({ default: assistantDefaults.idle_minutes, replaced: replaced ? 5 : null, at: new Date().toISOString() }));
      if (replaced) console.log(`[manager] assistant computers: the stored idle time of 5 minutes (the old default) now follows the default of ${assistantDefaults.idle_minutes} minutes`);
    }
    // Older saves stored every resource key including the old defaults (2048 MiB RAM, 512 MiB /tmp & /workspace).
    // Drop those legacy default values once so upgraded deployments follow the new 16 GiB / 20 GiB defaults (#1279).
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='assistant_resource_defaults_20g_16g'").get()) {
      const saved = this.db.prepare("SELECT value FROM settings WHERE key='assistant_computers'").get(), values = saved ? JSON.parse(saved.value) : null;
      const legacy = { memory_mb: 2048, tmp_mb: 512, workspace_mb: 512 };
      const replaced = {};
      if (values) {
        for (const [k, oldVal] of Object.entries(legacy)) {
          if (values[k] === oldVal) { delete values[k]; replaced[k] = oldVal; }
        }
        if (Object.keys(replaced).length) {
          this.db.prepare("UPDATE settings SET value=? WHERE key='assistant_computers'").run(JSON.stringify(values));
        }
      }
      this.db.prepare("INSERT INTO settings VALUES('assistant_resource_defaults_20g_16g',?)").run(JSON.stringify({ replaced, at: new Date().toISOString() }));
    }
  }
  effectiveGlobal() {
    const g = this.globalEnvironment?.();
    return {
      image: g?.image || this.image,
      tag: g?.tag || null,
      base_image_id: g?.base_image_id || null,
      env: g?.env && typeof g.env === 'object' ? g.env : {},
      defaults: g?.defaults || null,
      onStaleImage: g?.onStaleImage ?? null,
    };
  }
  activeImages() {
    return [...new Set([...this.leases.values()].map(l => l.image).filter(Boolean))];
  }
  // Only the current keys: a value an earlier version saved (the container runtime) is dropped, and the next save forgets it.
  // When wired to unified global defaults, resource and egress keys fall back to the shared global computer defaults.
  settings() {
    const saved = this.db.prepare("SELECT value FROM settings WHERE key='assistant_computers'").get(), values = saved ? JSON.parse(saved.value) : {};
    const shared = this.effectiveGlobal().defaults;
    const base = shared ? { ...assistantDefaults, ...shared } : assistantDefaults;
    return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, values[key] ?? value]));
  }
  // The host's CPUs and memory, for the console to offer only sizes the host has; null when Docker cannot be read.
  async host() { const info = await this.docker.request('GET', '/info').catch(() => null); return info?.NCPU ? { cpus: info.NCPU, memory_mb: Math.floor(info.MemTotal / mib) } : null; }
  async settingsView() {
    // homes: whether this manager has the HOME volume, without which no computer can be created (#1254).
    const host = await this.host();
    const configured = this.settings();
    const effectiveMemoryMb = clampMemoryToHost(configured.memory_mb, host?.memory_mb);
    const effective = { ...configured, memory_mb: effectiveMemoryMb };
    const hostClamped = effectiveMemoryMb !== configured.memory_mb ? { memory_mb: effectiveMemoryMb } : null;
    return { settings: effective, configured_settings: configured, host_clamped: hostClamped, defaults: assistantDefaults, bounds, host, homes: await this.volume().then(() => true, () => false),
      usage: { computers: this.leases.size, busy: [...this.leases.values()].filter(l => l.state === 'busy').length, waiting: this.waiting.length } };
  }
  /**
   * New values apply at once: timers on the next check, capacity on the next creation. Resources apply to containers
   * created from now on; an idle container with other resources is replaced when its owner's next turn takes it.
   */
  async setSettings(input) {
    const host = input && (input.cpus !== undefined || input.memory_mb !== undefined) ? await this.host() : null;
    validateAssistantSettings(input, host);
    // Only the values someone set, of the current keys: the others keep following their defaults, and a key an earlier
    // version saved is forgotten.
    const row = this.db.prepare("SELECT value FROM settings WHERE key='assistant_computers'").get(), saved = row ? JSON.parse(row.value) : {};
    const kept = Object.fromEntries(Object.entries(saved).filter(([key]) => key in assistantDefaults));
    this.db.prepare("INSERT INTO settings VALUES('assistant_computers',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...kept, ...input }));
    if (input.egress === false && !this.removing.size && ![...this.leases.values()].some(l => l.egress)) await this.removeNetwork();
    return this.settingsView();
  }
  validate(owner) { if (!ownerPattern.test(owner || '')) throw new ManagerError('invalid_assistant_owner', 400); }
  name(owner) { return `dbot-${this.deployment}-ac-${owner}`; }
  workspaceVolumeName(owner) { return `dbot-${this.deployment}-ac-${owner}-ws`; }
  tmpVolumeName(owner) { return `dbot-${this.deployment}-ac-${owner}-tmp`; }
  networkName() { return `dbot-${this.deployment}-ac-egress`; }
  labels(owner) { return { 'department.bot.deployment': this.deployment, 'department.bot.kind': 'assistant', 'department.bot.owner': owner }; }
  scratchVolumeLabels(owner, kind) { return { 'department.bot.deployment': this.deployment, 'department.bot.kind': kind, 'department.bot.owner': owner }; }
  networkLabels() { return { 'department.bot.deployment': this.deployment, 'department.bot.kind': 'assistant' }; }
  async removeScratchVolumes(owner) {
    for (const [volName, kind] of [[this.workspaceVolumeName(owner), 'assistant-workspace'], [this.tmpVolumeName(owner), 'assistant-tmp']]) {
      const existing = await this.docker.request('GET', `/volumes/${volName}`).catch(() => null);
      if (!existing) continue;
      if (Object.entries(this.scratchVolumeLabels(owner, kind)).some(([k, v]) => existing.Labels?.[k] !== v)) {
        logFailure(`assistant scratch volume ${volName} ownership mismatch`, 'skipped removal');
        continue;
      }
      await this.docker.request('DELETE', `/volumes/${volName}?force=true`).catch(error => logFailure(`assistant scratch volume ${volName} removal failed`, error));
    }
  }
  async createScratchVolume(volName, owner, kind) {
    const labels = this.scratchVolumeLabels(owner, kind);
    const existing = await this.docker.request('GET', `/volumes/${volName}`).catch(() => null);
    if (existing) {
      if (Object.entries(labels).some(([k, v]) => existing.Labels?.[k] !== v)) throw new ManagerError('resource_ownership_mismatch', 403);
      await this.docker.request('DELETE', `/volumes/${volName}?force=true`);
    }
    await this.docker.request('POST', '/volumes/create', { Name: volName, Labels: labels });
    return volName;
  }
  networkValid(network) {
    return !!network
      && !Object.entries(this.networkLabels()).some(([k, v]) => network.Labels?.[k] !== v)
      && network.Internal === false
      && network.Options?.['com.docker.network.bridge.enable_icc'] === 'false';
  }
  async ensureNetwork() {
    const name = this.networkName();
    const existing = await this.docker.request('GET', `/networks/${name}`).catch(() => null);
    if (existing) {
      if (Object.entries(this.networkLabels()).some(([k, v]) => existing.Labels?.[k] !== v)) throw new ManagerError('resource_ownership_mismatch', 403);
      if (this.networkValid(existing)) return name;
      const removed = await this.docker.request('DELETE', `/networks/${name}`).then(() => true, () => false);
      if (!removed) throw new ManagerError('assistant_network_misconfigured', 503);
    }
    try {
      await this.docker.request('POST', '/networks/create', {
        Name: name, Driver: 'bridge', Internal: false, CheckDuplicate: true,
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
        Labels: this.networkLabels(),
      });
    } catch (error) {
      const created = await this.docker.request('GET', `/networks/${name}`).catch(() => null);
      if (!this.networkValid(created)) throw error;
    }
    return name;
  }
  async removeNetwork() {
    const name = this.networkName();
    const existing = await this.docker.request('GET', `/networks/${name}`).catch(() => null);
    if (!existing || Object.entries(this.networkLabels()).some(([k, v]) => existing.Labels?.[k] !== v)) return;
    await this.docker.request('DELETE', `/networks/${name}`).catch(error => logFailure(`assistant egress network ${name} removal failed`, error));
  }
  lock(owner, fn) { const previous = this.locks.get(owner) || Promise.resolve(), next = previous.then(fn, fn); const tail = next.catch(() => {}); this.locks.set(owner, tail); tail.then(() => { if (this.locks.get(owner) === tail) this.locks.delete(owner); }); return next; }
  async volume() {
    if (this.volumeName) return this.volumeName;
    const name = await this.docker.volumeName(this.homes).catch(() => null);
    if (!name) throw new ManagerError('assistant_homes_unavailable', 503);
    return this.volumeName = name;
  }
  view(lease) {
    return { owner: lease.owner, state: lease.state, turn: lease.turn, fence: lease.fence, home: { generation: lease.generation, mode: lease.mode },
      resources: lease.resources, egress: lease.egress, image: lease.image, created_at: lease.created, used_at: lease.used, renewed_at: lease.renewed, running_operations: lease.inflight };
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
      cap_drop: host.CapDrop ?? [], cap_add: host.CapAdd ?? [], security_opt: host.SecurityOpt ?? [], network_mode: host.NetworkMode ?? null,
      network_policy: host.NetworkMode === 'none' ? 'none' : host.NetworkMode === this.networkName() ? 'internet egress' : null, runtime: host.Runtime ?? null,
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
      .then(() => this.removeScratchVolumes(lease.owner))
      .then(() => { if (this.db.isOpen && !this.settings().egress && ![...this.leases.values()].some(l => l.egress)) return this.removeNetwork(); })
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
    if (input?.harness !== undefined && typeof input.harness !== 'boolean') throw new ManagerError('invalid_assistant_request', 400);
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['turn', 'fence', 'home_generation', 'home_mode','harness'].includes(k))) throw new ManagerError('invalid_assistant_request', 400);
    const { turn, fence, home_generation: generation, home_mode: mode } = input;
    if (!turnPattern.test(turn || '') || !/^[a-f0-9]{16,128}$/.test(fence || '') || !Number.isSafeInteger(generation) || generation < 1 || !['rw', 'ro'].includes(mode)) throw new ManagerError('invalid_assistant_request', 400);
    return this.lock(owner, async () => {
      const now = Date.now(), settings = this.settings(), globalEnv = this.effectiveGlobal();
      const host = await this.host();
      const effectiveResources = { ...resourcesOf(settings), memory_mb: clampMemoryToHost(settings.memory_mb, host?.memory_mb) };
      let targetImage = globalEnv.image;
      // Validate BOTH the live approved base image digest AND the stored image ID (not only the tag):
      // if the approved base image changed before the next 5s reconcile timer or the stored ID was pruned,
      // adopt a moved tag only when its base label matches the current approved base; otherwise fall back
      // immediately to the approved base image and trigger background reconciliation.
      if (targetImage !== this.image) {
        const [approvedImg, presentById] = await Promise.all([
          this.docker.request('GET', `/images/${encodeURIComponent(this.image)}/json`).catch(() => null),
          this.docker.request('GET', `/images/${encodeURIComponent(targetImage)}/json`).catch(() => null),
        ]);
        const currentApprovedId = approvedImg?.Id || globalEnv.base_image_id || null;
        const storedBaseMatches = !currentApprovedId || !globalEnv.base_image_id || globalEnv.base_image_id === currentApprovedId;
        const idBaseLabel = presentById?.Config?.Labels?.['department.bot.base_image_id'];
        const idValid = storedBaseMatches && !!presentById?.Id && (!currentApprovedId || !idBaseLabel || idBaseLabel === currentApprovedId);
        if (!idValid) {
          const presentByTag = storedBaseMatches && globalEnv.tag
            ? await this.docker.request('GET', `/images/${encodeURIComponent(globalEnv.tag)}/json`).catch(() => null)
            : null;
          const tagBase = presentByTag?.Config?.Labels?.['department.bot.base_image_id'];
          const tagValid = storedBaseMatches && !!presentByTag?.Id && (!currentApprovedId || !tagBase || tagBase === currentApprovedId);
          targetImage = tagValid ? presentByTag.Id : this.image;
          globalEnv.onStaleImage?.();
        }
      }
      const env = globalEnv.env, envSignature = JSON.stringify(Object.entries(env).sort());
      let lease = this.leases.get(owner);
      if (lease?.state === 'busy' && lease.turn !== turn) {
        // Another turn of the same owner (a private chat and a console conversation of one person) holds it: wait for it,
        // unless that turn's control plane stopped renewing it.
        if (lease.inflight || now - lease.renewed < abandonAfterMs) return { state: 'queued', reason: 'owner_busy', position: 1 };
        this.discard(lease, 'abandoned'); lease = undefined;
      }
      if (lease) {
        // The turn already holding it (a retried request) keeps it through new resources and past its lifetime: both apply
        // between turns. A changed fence, HOME generation or mode never keeps it.
        const held = lease.state === 'busy' && lease.turn === turn;
        const current = lease.fence === fence && lease.generation === generation && lease.mode === mode && (!input.harness || lease.harness)
          && (held || (lease.image === targetImage && (lease.envSignature ?? '[]') === envSignature
            && lease.egress === settings.egress && JSON.stringify(lease.resources) === JSON.stringify(effectiveResources) && now - lease.created < settings.max_lifetime_minutes * 60_000));
        const running = current && (await this.inspect(owner).catch(() => null))?.State?.Running === true;
        if (running) {
          const reused = lease.state === 'idle';
          lease.state = 'busy'; lease.turn = turn; lease.renewed = now;
          return { state: 'ready', reused, computer: this.view(lease) };
        }
        // A changed fence, HOME generation or mode, other resources or image, or a container past its lifetime: replaced,
        // keeping the owner's slot.
        this.discard(lease, 'replaced');
      }
      // Disk free-space admission (#1279): ephemeral /workspace and /tmp volumes share the host Docker data disk with
      // manager.sqlite and the control plane. Reclaim idle scratch volumes first, then fail closed if still below reserve.
      if (this.disk?.check()?.low) {
        const idles = [...this.leases.values()].filter(l => l.state === 'idle' && l.owner !== owner);
        if (idles.length) {
          await Promise.all(idles.map(idle => this.discard(idle, 'disk_pressure')));
        }
        if (this.disk.check(true)?.low) throw new ManagerError('disk_full', 507);
      }
      if (!lease) {
        // A new container needs a free slot and its turn in the queue; an idle container used longest ago gives way.
        const position = this.waiting.length || this.leases.size >= settings.max_containers ? this.ticket(owner, turn) : 0;
        if (position > 1) return { state: 'queued', reason: 'capacity', position };
        if (this.leases.size >= settings.max_containers) {
          const idle = [...this.leases.values()].filter(l => l.state === 'idle').sort((a, b) => a.used - b.used)[0];
          if (!idle) return { state: 'queued', reason: 'capacity', position: Math.max(position, 1) };
          this.discard(idle, 'capacity');
        }
      }
      // Aggregate memory admission on known hosts (#1279): cgroup Memory is a burst ceiling rather than reserved RAM,
      // so allow up to 2x host RAM across concurrently busy assistant computers (preventing max_containers=20 from
      // OOM-killing the manager/control plane while keeping normal multi-user concurrency on 16-32 GiB hosts).
      if (host?.memory_mb) {
        const busyLeases = [...this.leases.values()].filter(l => l.owner !== owner && (l.state === 'busy' || l.state === 'creating'));
        const busyMemoryMb = busyLeases.reduce((sum, l) => sum + (l.resources?.memory_mb || 0), 0);
        if (busyLeases.length > 0 && busyMemoryMb + effectiveResources.memory_mb > host.memory_mb * 2) {
          const position = this.ticket(owner, turn);
          return { state: 'queued', reason: 'capacity', position };
        }
      }
      this.waiting = this.waiting.filter(t => t.owner !== owner);
      lease = { owner, turn, fence, generation, mode, harness:input.harness===true, resources: effectiveResources, egress: settings.egress, image: targetImage, env, envSignature, state: 'creating', created: now, used: now, renewed: now, inflight: 0 };
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
    const { owner } = lease, name = this.name(owner), l = lease.resources, volume = await this.volume(), subpath = `${owner}/home-${lease.generation}`;
    // The control plane creates the generation directory; it must be a real directory inside this owner's directory.
    if (this.homes) for (const path of [`${this.homes}/${owner}`, `${this.homes}/${subpath}`]) {
      const info = await lstat(path).catch(() => null);
      if (!info?.isDirectory()) throw new ManagerError('assistant_home_missing', 409);
    }
    await this.removing.get(owner);
    // A container left by an earlier lease of this owner (a failed removal) is never reused.
    if (await this.inspect(owner)) await this.docker.request('DELETE', `/containers/${name}?force=true`);
    // Fresh ephemeral disk-backed volumes for /workspace and /tmp so large checkouts/builds (default 20 GiB)
    // do not count against the 16 GiB memory cgroup limit and are always clean on recreate or fence change.
    const wsVol = await this.createScratchVolume(this.workspaceVolumeName(owner), owner, 'assistant-workspace');
    const tmpVol = await this.createScratchVolume(this.tmpVolumeName(owner), owner, 'assistant-tmp');
    // Docker answers 404 (no such image) with nothing: a clear creation failure, not a container gone missing later.
    const networkMode = lease.egress ? await this.ensureNetwork() : 'none';
    const tools=lease.harness?await this.agentTools?.():null, results=await this.resultMount?.(owner)??[];
    const extraEnv = lease.env && Object.keys(lease.env).length
      ? [...Object.entries(lease.env).map(([k, v]) => `${k}=${v}`), `BOT_PROJECT_ENV_KEYS=${Object.keys(lease.env).join(',')}`]
      : [];
    const made = await this.docker.request('POST', `/containers/create?name=${name}`, { Image: lease.image, User: '10001:10001', WorkingDir: '/workspace', Hostname: 'assistant',
      Cmd: ['node', '/opt/runner/idle.mjs'], Env: [`HOME=${assistantHome}`, 'LANG=C.UTF-8', 'BOT_COMPUTER_KIND=assistant', `BOT_WORKSPACE_LIMIT_MB=${l.workspace_mb}`, `BOT_TMP_LIMIT_MB=${l.tmp_mb}`, ...extraEnv], Labels: this.labels(owner),
      HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, Init: true, RestartPolicy: { Name: 'no' },
        Memory: l.memory_mb * mib, MemorySwap: l.memory_mb * mib, NanoCpus: Math.round(l.cpus * 1e9), PidsLimit: l.pids, IpcMode: 'private', NetworkMode: networkMode,
        Mounts: [
          ...results,
          { Type: 'volume', Source: volume, Target: assistantHome, ReadOnly: lease.mode === 'ro', VolumeOptions: { NoCopy: true, Subpath: subpath } },
          { Type: 'volume', Source: wsVol, Target: '/workspace', ReadOnly: false },
          { Type: 'volume', Source: tmpVol, Target: '/tmp', ReadOnly: false },
          ...(tools?[{Type:'volume',Source:tools,Target:'/opt/agent-tools',ReadOnly:true}]:[]),
        ] } });
    if (!made) throw Object.assign(new ManagerError('assistant_computer_create_failed', 503), { detail: `image ${lease.image} not found` });
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
  async output(owner,input) {
    this.validate(owner);
    if(!input||Object.keys(input).some(k=>!['turn','operation_id','offset'].includes(k))||!turnPattern.test(input.turn||'')||!idPattern.test(input.operation_id||'')||!Number.isSafeInteger(input.offset)||input.offset<0)throw new ManagerError('invalid_operation',400);
    this.held(owner,input.turn);
    const response=await this.docker.runner(this.name(owner),{type:'tail',operation_id:input.operation_id,offset:input.offset});
    this.held(owner,input.turn);
    if(!response.ok)throw new ManagerError('output_unavailable',503);
    return response.result;
  }
  async execute(owner, input) {
    this.validate(owner);
    if (!input || Object.keys(input).some(k => !['turn', 'operation_id', 'request'].includes(k)) || !turnPattern.test(input.turn || '') || !idPattern.test(input.operation_id || '')) throw new ManagerError('invalid_operation', 400);
    const lease = this.held(owner, input.turn);
    validateCall(input.request, lease.harness);
    const writing = ['command', 'assistant_write', 'assistant_archive_stage', 'assistant_archive_extract'].includes(input.request.type);
    if (writing && this.disk?.check()?.low) throw new ManagerError('disk_full', 507);
    const command = input.request.type === 'command';
    const timeoutMs = command
      ? (input.request.timeout_ms ?? 10_000) + 30_000
      : input.request.type === 'assistant_archive_extract' ? 180_000 : 90_000;
    lease.inflight++; lease.renewed = Date.now();
    try {
      return await this.docker.runner(this.name(owner), { ...input.request, operation_id: input.operation_id }, timeoutMs);
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
      await this.removeScratchVolumes(owner);
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
  /** On start: assistant containers and their ephemeral scratch volumes of this deployment are left from before and removed, never reused. */
  async recover() {
    const filters = encodeURIComponent(JSON.stringify({ label: [`department.bot.deployment=${this.deployment}`, 'department.bot.kind=assistant'] }));
    const containers = await this.docker.request('GET', `/containers/json?all=1&filters=${filters}`) || [];
    for (const container of containers) await this.docker.request('DELETE', `/containers/${container.Id}?force=true`).catch(error => logFailure('leftover assistant computer removal failed', error));
    for (const kind of ['assistant-workspace', 'assistant-tmp']) {
      const volFilters = encodeURIComponent(JSON.stringify({ label: [`department.bot.deployment=${this.deployment}`, `department.bot.kind=${kind}`] }));
      const listed = await this.docker.request('GET', `/volumes?filters=${volFilters}`).catch(() => null);
      for (const vol of listed?.Volumes ?? []) {
        await this.docker.request('DELETE', `/volumes/${encodeURIComponent(vol.Name)}?force=true`).catch(error => logFailure(`leftover ${kind} volume ${vol.Name} removal failed`, error));
      }
    }
    await this.removeNetwork();
    return containers.length;
  }
  async shutdown() { await Promise.all([...this.leases.values()].map(lease => this.discard(lease, 'manager_stopped'))); await Promise.all([...this.removing.values()]); await this.removeNetwork(); }
}
