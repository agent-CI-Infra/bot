import { cpus as osCpus, freemem, loadavg, totalmem } from 'node:os';
import { lstat, mkdir, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { computerResultOwner } from '../runner/result-owner.mjs';
import { Docker, ManagerError } from './docker.mjs';
import { Projects } from './projects.mjs';
import { AssistantComputers } from './assistant-computers.mjs';
import { compactDatabase } from './compaction.mjs';

/**
 * Reserved host-mode compute driver interface (macOS/Windows/bare-metal future support).
 * Linux Docker (`docker`) is the only driver implemented in #1380; `host` fails explicitly with 501.
 */
export class HostComputeDriver {
  constructor() {
    this.kind = 'host';
  }

  _notImplemented() {
    throw new ManagerError('host_driver_not_implemented', 501);
  }

  async recover() {
    this._notImplemented();
  }

  async collectMetrics() {
    this._notImplemented();
  }

  async dispatchLocalManagerRequest() {
    this._notImplemented();
  }

  async reclaimLocalProject() {
    this._notImplemented();
  }

  async revokeAll() {
    this._notImplemented();
  }

  async shutdown() {}
}

/**
 * Linux Docker compute driver wrapping local `Docker`, `Projects`, and `AssistantComputers`.
 * Retains all local runtime state (`manager.sqlite`, local containers, local precompiled image cache,
 * and host CPU/memory/disk watermarks) strictly on the node. Never exposes Docker TCP.
 */
export class DockerComputeDriver {
  constructor(options = {}) {
    this.kind = 'docker';
    this.dataDir = resolve(options.dataDir || '/data');
    this.databasePath = options.database || join(this.dataDir, 'manager.sqlite');
    this.deployment =
      options.deployment ||
      createHash('sha256')
        .update(String(options.deploymentSeed || this.dataDir))
        .digest('hex')
        .slice(0, 16);
    this.docker = options.docker || new Docker(options.dockerSocketPath || process.env.DOCKER_SOCKET || '/var/run/docker.sock');
    this.image = options.image || process.env.BOT_PROJECT_IMAGE || 'department-bot-project-computer:local';
    this.egress = options.egress !== undefined ? Boolean(options.egress) : process.env.BOT_PROJECT_EGRESS !== 'false';
    this.toolsDir = options.toolsDir ?? (process.env.BOT_AGENT_TOOLS_DIR || '/opt/agent-tools');
    this.projectToolsDir = options.projectToolsDir ?? (process.env.BOT_PROJECT_TOOLS_DIR || null);
    this.skillStoreDir = options.skillStoreDir ?? (process.env.BOT_SKILL_STORE_DIR || null);
    this.modelGatewayDir = options.modelGatewayDir ?? (process.env.BOT_MODEL_GATEWAY_DIR || null);
    this.runnerSocketsDir = options.runnerSocketsDir ?? (process.env.BOT_RUNNER_SOCKETS_DIR || null);
    this.toolResultsDir = options.toolResultsDir ?? (process.env.BOT_TOOL_RESULTS_DIR || null);
    this.assistantHomesDir = options.assistantHomesDir ?? (process.env.BOT_ASSISTANT_HOMES || '/assistant-homes');
    this.assistantImage = options.assistantImage || process.env.BOT_ASSISTANT_IMAGE || null;
    this.compactOnStart = options.compactOnStart !== false;
    this.startedAt = Date.now();
    this.projects = null;
    this.assistants = null;
    this.ready = false;
    this._recovered = null;
    this._timers = [];
    this._checking = false;
    this._checkingAssistants = false;
  }

  async init() {
    if (this.projects) return;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let compaction = null;
    if (this.compactOnStart) {
      compaction = await compactDatabase(this.databasePath, { log: line => console.log('[node-agent] ' + line) }).catch(() => null);
    }
    this.projects = new Projects({
      database: this.databasePath,
      docker: this.docker,
      deployment: this.deployment,
      image: this.image,
      egress: this.egress,
      tools: this.toolsDir,
      projectTools: this.projectToolsDir,
      skillStore: this.skillStoreDir,
      modelGateway: this.modelGatewayDir,
      runnerSockets: this.runnerSocketsDir,
      results: this.toolResultsDir,
    });
    if (compaction) {
      this.projects.db
        .prepare("INSERT INTO settings VALUES('compaction',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(compaction));
    }
    this.assistants = new AssistantComputers({
      docker: this.projects.docker,
      db: this.projects.db,
      deployment: this.projects.deployment,
      disk: this.projects.disk,
      allocatedMemoryMb: () => this.projects.busyMemoryMb(),
      resultMount: owner => this.projects.resultMount(computerResultOwner('assistant', owner)),
      agentTools: () => this.projects.agentToolsVolume(),
      modelGateway: () => this.projects.modelGatewayVolume(),
      runnerSocket: {
        prepare: containerName => this.projects.prepareRunnerSocket(containerName),
        cleanup: containerName => this.projects.cleanupRunnerSocket(containerName),
      },
      projectToolsMount: this.projects.projectToolsMount,
      projectToolsVolume: () => this.projects.projectToolsVolume(),
      skillStoreMount: this.projects.skillStoreMount,
      skillStoreVolume: () => this.projects.skillStoreVolume(),
      image: this.assistantImage || this.projects.image,
      homes: this.assistantHomesDir,
      globalEnvironment: this.assistantImage ? null : () => this.projects.assistantGlobalEnvironment(),
    });
  }

  async recover() {
    await this.init();
    if (!this._recovered) {
      this._recovered = this.projects.recover();
    }
    await this._recovered;
    this.ready = true;
  }

  startBackgroundChecks(intervalMs = 5_000) {
    if (this._timers.length || !this.projects || !this.assistants) return;
    const projectTimer = setInterval(async () => {
      if (this._checking || !this.projects || !this.assistants) return;
      this._checking = true;
      try {
        await this.projects.check(this.assistants.activeImages());
      } catch {
        // background check failures are logged internally
      } finally {
        this._checking = false;
      }
    }, intervalMs);
    projectTimer.unref?.();

    const assistantTimer = setInterval(async () => {
      if (this._checkingAssistants || !this.assistants) return;
      this._checkingAssistants = true;
      try {
        await this.assistants.check();
      } catch {
        // ignore transient background error
      } finally {
        this._checkingAssistants = false;
      }
    }, intervalMs);
    assistantTimer.unref?.();

    this._timers.push(projectTimer, assistantTimer);
  }

  async collectMetrics() {
    const cpuList = osCpus();
    const memTotalMb = Math.round(totalmem() / (1024 * 1024));
    const memFreeMb = Math.round(freemem() / (1024 * 1024));
    const memUsedPct = memTotalMb > 0 ? Math.round(((memTotalMb - memFreeMb) / memTotalMb) * 1000) / 10 : 0;
    const load1 = Math.round((loadavg()[0] || 0) * 100) / 100;

    let diskFreeBytes = null;
    let diskTotalBytes = null;
    let diskUsedPct = null;
    try {
      const fsStat = await statfs(this.dataDir);
      diskFreeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
      diskTotalBytes = Number(fsStat.blocks) * Number(fsStat.bsize);
      if (diskTotalBytes > 0) {
        diskUsedPct = Math.round(((diskTotalBytes - diskFreeBytes) / diskTotalBytes) * 1000) / 10;
      }
    } catch {
      // statfs may fail on virtual filesystems
    }

    let runningProjects = 0;
    let runningAssistants = 0;
    let precompiledImages = 0;
    if (this.projects) {
      try {
        const list = this.projects.list();
        runningProjects = list.filter(p => p.state === 'ready' || p.state === 'busy').length;
      } catch {}
      try {
        const imgs = await this.projects.precompiledImages();
        precompiledImages = Array.isArray(imgs?.images) ? imgs.images.length : 0;
      } catch {}
    }
    if (this.assistants) {
      try {
        const list = this.assistants.list();
        runningAssistants = Array.isArray(list?.computers) ? list.computers.length : 0;
      } catch {}
    }

    return {
      cpus: cpuList.length || 1,
      memory_total_mb: memTotalMb,
      memory_free_mb: memFreeMb,
      memory_used_mb: Math.max(0, memTotalMb - memFreeMb),
      memory_used_pct: memUsedPct,
      loadavg_1m: load1,
      cpu_load_1m: load1,
      disk_free_bytes: diskFreeBytes,
      disk_total_bytes: diskTotalBytes,
      disk_used_pct: diskUsedPct,
      running_projects: runningProjects,
      busy_project_containers: runningProjects,
      running_assistants: runningAssistants,
      busy_assistant_containers: runningAssistants,
      precompiled_images: precompiledImages,
      uptime_seconds: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)),
    };
  }

  /**
   * Executes a standard manager `/v1/*` request in-process against this node's local `Projects` and `AssistantComputers`.
   * Mirrors `manager/server.mjs` routing identically without requiring a loopback HTTP hop.
   */
  async dispatchLocalManagerRequest(methodRaw, rawPath, inputRaw = {}) {
    await this.init();
    const method = String(methodRaw || 'GET').toUpperCase();
    const url = new URL(rawPath, 'http://manager');
    const path = url.pathname;
    const input = inputRaw && typeof inputRaw === 'object' && !Array.isArray(inputRaw) ? inputRaw : {};
    const projects = this.projects;
    const assistants = this.assistants;

    if (!this.ready && path !== '/ready') {
      throw new ManagerError('manager_not_ready', 503);
    }

    const output = /^\/v1\/projects\/([1-9]\d{0,19})\/output\/([a-f0-9]{48})$/.exec(path);
    const asyncCmd = /^\/v1\/projects\/([1-9]\d{0,19})\/commands(?:\/([a-f0-9]{48})(?:\/(wait|cancel))?)?$/.exec(path);

    if (method === 'GET' && path === '/v1/projects') return projects.list();
    if (method === 'GET' && path === '/v1/notes-volumes') return await projects.notesVolumes();
    if (method === 'POST' && /^\/v1\/projects\/[1-9]\d{0,19}\/notes\/reclaim$/.test(path)) {
      return await projects.reclaimNotes(path.split('/')[3]);
    }
    if (method === 'GET' && path === '/v1/defaults') return await projects.defaultsView();
    if (method === 'PUT' && path === '/v1/defaults') return await projects.setDefaults(input);
    if (method === 'POST' && path === '/v1/defaults/build/cancel') return projects.cancelGlobalBuild();
    if (method === 'GET' && path === '/v1/storage') return await projects.storage();
    if (method === 'PUT' && path === '/v1/storage/retention') return projects.setRetention(input);
    if (method === 'POST' && path === '/v1/storage/reclaim') return await projects.reclaimStorage();
    if (method === 'GET' && path === '/v1/precompiled-images') return await projects.precompiledImages();
    if (method === 'POST' && path === '/v1/precompiled-images/prune') {
      return await projects.prunePrecompiledImages(assistants?.activeImages() ?? new Set());
    }
    if (method === 'GET' && path === '/v1/project-tools/mounts') {
      return projects.projectToolsMounts(assistants?.list?.()?.computers ?? []);
    }
    if (method === 'PUT' && /^\/v1\/projects\/[1-9]\d{0,19}\/tools$/.test(path)) {
      return projects.setToolsRevision(path.split('/')[3], input.revision === undefined ? null : input.revision);
    }
    if (method === 'POST' && path === '/v1/agent-tools/install-acp') {
      return await projects.installAcpProduct(input);
    }
    if (['GET', 'PUT', 'DELETE'].includes(method) && /^\/v1\/projects\/[1-9]\d{0,19}\/cli-config$/.test(path)) {
      const repoId = path.split('/')[3];
      const bodyInput =
        method === 'GET'
          ? {}
          : method === 'DELETE' && url.searchParams.has('cli')
            ? { cli: url.searchParams.get('cli'), file: url.searchParams.get('file') }
            : input;
      return await projects.cliConfig(repoId, method, bodyInput);
    }
    if (method === 'POST' && /^\/v1\/projects\/[1-9]\d{0,19}\/build\/cancel$/.test(path)) {
      return projects.cancelBuild(path.split('/')[3]);
    }
    if (method === 'GET' && output) {
      return await projects.output(output[1], output[2], Number(url.searchParams.get('offset') || 0));
    }
    if (asyncCmd && method === 'POST' && !asyncCmd[2]) {
      const { node_id: _n, binding_epoch: _e, ...clean } = input;
      if (Object.keys(clean).some(k => !['operation_id', 'generation', 'request'].includes(k))) {
        throw new ManagerError('invalid_input', 400);
      }
      return await projects.startCommand(asyncCmd[1], clean);
    }
    if (asyncCmd && method === 'GET' && asyncCmd[2] && !asyncCmd[3]) {
      return await projects.commandStatus(asyncCmd[1], asyncCmd[2]);
    }
    if (asyncCmd && method === 'GET' && asyncCmd[2] && asyncCmd[3] === 'wait') {
      return await projects.waitCommand(asyncCmd[1], asyncCmd[2], {
        offset: Number(url.searchParams.get('offset') || 0),
        timeoutMs: Number(url.searchParams.get('timeout_ms') || 25_000),
      });
    }
    if (asyncCmd && method === 'POST' && asyncCmd[2] && asyncCmd[3] === 'cancel') {
      return await projects.cancelCommand(asyncCmd[1], asyncCmd[2]);
    }
    if (method === 'GET' && /^\/v1\/projects\/[1-9]\d{0,19}\/stats$/.test(path)) {
      return await projects.stats(path.split('/')[3]);
    }
    if (method === 'PUT' && /^\/v1\/projects\/[1-9]\d{0,19}\/parallel$/.test(path)) {
      return projects.parallelism(path.split('/')[3], input.tasks);
    }
    if (assistants && path.startsWith('/v1/assistant-computers')) {
      const [, , , owner, action] = path.split('/');
      if (path === '/v1/assistant-computers' && method === 'GET') return assistants.list();
      if (path === '/v1/assistant-computers/settings' && method === 'GET') return await assistants.settingsView();
      if (path === '/v1/assistant-computers/settings' && method === 'PUT') return await assistants.setSettings(input);
      if (path === '/v1/assistant-computers/reconcile' && method === 'POST') return await assistants.reconcile(input);
      if (!/^[a-f0-9]{32}$/.test(owner || '') || path.split('/').length > 5) throw new ManagerError('not_found', 404);
      if (method === 'PUT' && !action) return await assistants.acquire(owner, input);
      if (method === 'GET' && !action) {
        const container = await assistants.inspect(owner);
        return { owner, container: assistants.facts(container) };
      }
      if (method === 'DELETE' && !action) return await assistants.remove(owner);
      if (method === 'POST' && action === 'output') return await assistants.output(owner, input);
      if (method === 'POST' && action === 'execute') return await assistants.execute(owner, input);
      if (method === 'POST' && action === 'renew') return assistants.renew(owner, input);
      if (method === 'POST' && action === 'release') return assistants.release(owner, input);
      throw new ManagerError('not_found', 404);
    }

    const match = /^\/v1\/projects\/([1-9]\d{0,19})(?:\/(start|stop|reset|delete|execute|configure|refresh))?$/.exec(path);
    if (!match) throw new ManagerError('not_found', 404);
    if (method === 'GET' && !match[2]) return projects.describe(match[1]);
    if (method === 'PUT' && !match[2]) return await projects.register(match[1]);
    if (method === 'POST' && match[2]) {
      const { node_id: _n, binding_epoch: _e, ...clean } = input;
      // As in manager/server.mjs: an execute may carry the run's SSH grant (#1379), validated by Projects.operate.
      const keys = ['operation_id', 'generation', 'request', ...(match[2] === 'execute' ? ['ssh'] : [])];
      if (Object.keys(clean).some(k => !keys.includes(k))) {
        throw new ManagerError('invalid_input', 400);
      }
      return await projects.operate(match[1], match[2], clean);
    }
    throw new ManagerError('not_found', 404);
  }

  /**
   * Reclaims all local workspace/cache volumes for a repository that was rebound away from this node.
   * Never copies workspace volumes across nodes; only cleans local Docker volumes & local manager notes copy.
   */
  async reclaimLocalProject(repoId) {
    await this.init();
    const removedVolumes = [];
    const prefix = `dbot-${this.deployment}-${repoId}-`;
    try {
      const filters = encodeURIComponent(
        JSON.stringify({ label: [`department.bot.deployment=${this.deployment}`, `department.bot.repository=${repoId}`] }),
      );
      const listed = await this.docker.request('GET', `/volumes?filters=${filters}`);
      const names = new Set((listed?.Volumes || []).map(v => String(v.Name || '')).filter(Boolean));
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        await this.docker.request('DELETE', `/volumes/${encodeURIComponent(name)}?force=true`).catch(() => {});
        removedVolumes.push(name);
      }
    } catch {
      // Fallback: reclaim well-known notes volume name if label filtering failed.
    }
    await this.projects.reclaimNotes(repoId).catch(() => {});
    const localNotesDir = join(this.projects.notesRoot, String(repoId));
    const notesStat = await lstat(localNotesDir).catch(() => null);
    if (notesStat) {
      await rm(localNotesDir, { recursive: true, force: true }).catch(() => {});
    }
    return { repository_id: String(repoId), removed_volumes: removedVolumes };
  }

  /**
   * Best-effort cleanup invoked when a node is revoked by the control plane:
   * removes all assistant containers and stops/deletes all project containers on this node.
   */
  async revokeAll() {
    if (!this.projects || !this.assistants) return { stopped_projects: 0, removed_assistants: 0 };
    let removedAssistants = 0;
    let stoppedProjects = 0;
    try {
      const activeAssistants = this.assistants.list()?.computers || [];
      for (const comp of activeAssistants) {
        await this.assistants.remove(String(comp.owner)).catch(() => {});
        removedAssistants++;
      }
    } catch {}
    try {
      const projects = this.projects.list() || [];
      for (const proj of projects) {
        if (proj.state === 'deleted') continue;
        const opId = createHash('sha256').update(`revoke:${proj.repository_id}:${Date.now()}`).digest('hex').slice(0, 48);
        await this.projects
          .operate(String(proj.repository_id), 'delete', {
            operation_id: opId,
            generation: Number(proj.generation || 1),
          })
          .catch(() => {});
        stoppedProjects++;
      }
    } catch {}
    return { stopped_projects: stoppedProjects, removed_assistants: removedAssistants };
  }

  async shutdown() {
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
    if (this._recovered) await this._recovered.catch(() => {});
    if (this.assistants) await this.assistants.shutdown().catch(() => {});
    if (this.projects) await this.projects.shutdown().catch(() => {});
  }
}

export function createComputeDriver(kind = 'docker', options = {}) {
  const normalized = String(kind || 'docker').toLowerCase();
  if (normalized === 'docker') return new DockerComputeDriver(options);
  if (normalized === 'host') return new HostComputeDriver(options);
  throw new ManagerError('invalid_node_driver', 400);
}
