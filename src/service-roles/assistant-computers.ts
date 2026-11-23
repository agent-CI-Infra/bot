import {Workspace} from '../agent/workspace.js';
import {Redactor} from '../agent/common.js';
import { commandResult, assistantResultOwner } from '../agent/tool-results.js';
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rm, statfs, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Store, Row } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import { digest, fail, fields, HttpError, randomId, text, type Json } from '../core/security.js';
import { superAdmin, type Actor } from '../app/auth.js';
import { commandTimeoutLimit } from '../agent/command.js';
import { readFileChunks } from './checkout.js';

/**
 * Assistant computers (#457): group assistants and the management assistant get a computer of their conversation owner, a
 * group (its chat) or a person (tenant + principal, shared by their Feishu private chat and console conversations). The
 * manager runs it as a short-lived container (manager/assistant-computers.mjs); this side decides the owner, its fence and
 * its HOME generation, keeps the HOME data (/assistant-homes/<owner>/home-<generation>, the volume the containers mount
 * one subpath of), measures it, applies the size limit and the retention period, and serves HOME files without a shell.
 *
 * The model names only paths: ~/... (or /home/assistant/...) is HOME, /tmp/... and relative paths are the computer's
 * temporary areas. It never names an owner, container, volume or host path.
 */
export const assistantHome = '/home/assistant';
const gib = 1024 ** 3, readLimit = 1024 * 1024, chunk = 40_000;
// #534: one ceiling for every entry. The assistant computer reads the same deployment setting as the task workspace
// tools, so a deployment that raises BOT_COMMAND_TIMEOUT_MAX_SECONDS no longer has to patch this file; the default stays 600.
const commandSecondsLimit = commandTimeoutLimit();
const fn = (name: string, description: string, properties: Json, required: string[] = []) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const path = { type: 'string', description: '~/... (or /home/assistant/...) is your persistent HOME; /tmp/... and relative paths (working directory /workspace) are temporary. Never a host path.' };
export const assistantComputerTools = [
  fn('read_file', 'Read a UTF-8 file of your computer (at most 1 MiB is returned).', { path }, ['path']),
  fn('write_file', 'Write a UTF-8 file on your computer, replacing it. Temporary files belong in /tmp; write to HOME (~/...) only data worth keeping for later turns.', { path, content: { type: 'string' } }, ['path', 'content']),
  fn('delete_file', 'Delete a file or a directory (with its contents) on your computer, in HOME or a temporary area. Use it to clean up HOME, for example when it is over its size limit.', { path }, ['path']),
  fn('run_command', `Run a non-interactive /bin/sh command on your computer: working directory /workspace, HOME persistent, /tmp temporary. Chromium ($BOT_BROWSER_EXECUTABLE / bot-chromium) and X11 virtual desktop tools (bot-desktop, xvfb-run, Xvfb, openbox, xdotool, wmctrl, xclip, scrot, ffmpeg) are preinstalled for CLI, CDP and desktop-level browser or GUI tasks. Set keep_background=true to keep long-lived processes (such as bot-desktop start or a Chromium CDP server) alive across commands in this turn; all processes end when the turn finishes. Times out after timeout_seconds (default 120, at most ${commandSecondsLimit}; a smaller configured maximum lowers that default).`,
    { command: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: commandSecondsLimit, description: `Optional timeout in seconds; the configured maximum is ${commandSecondsLimit}.` }, keep_background: { type: 'boolean', description: 'Keep background processes (such as bot-desktop start or Chromium CDP) alive across commands in this turn; they end when the turn finishes.' } }, ['command']),
];
export const assistantComputerNames = assistantComputerTools.map(t => t.function.name);
/** delete_file needs no permission item of its own: whoever may write files may delete them. */
export const computerPermission = (name: string) => name === 'delete_file' ? 'write_file' : name;
/**
 * #534: the assistant computer's timeout request, checked against the same configured ceiling as the task workspace
 * tools. A value above it is refused with the ceiling in the message, so the refusal never states a stale 600. Without a
 * request the entry default applies, clamped to the ceiling like the other entries (agent/command.ts), so a deployment
 * ceiling below 120 seconds does not refuse every command.
 */
export function assistantCommandTimeout(value: unknown, limit = commandSecondsLimit): number {
  const seconds = value === undefined ? Math.min(120, limit) : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > limit)
    fail(400, 'invalid_timeout_seconds', 'timeout_seconds', { max_seconds: limit, message: `timeout_seconds must be an integer between 1 and ${limit}` });
  return seconds;
}
/** Prompt text shared by the assistants that offer the computer tools. */
export const computerInstructions = (shared: string) => ` Your computer (read_file, write_file, delete_file, run_command, and checkout_repository when offered) has Chromium ($BOT_BROWSER_EXECUTABLE / bot-chromium) and X11 virtual desktop tools (bot-desktop, xvfb-run, Xvfb, openbox, xdotool, wmctrl, xclip, scrot, ffmpeg) preinstalled for direct CLI, CDP, screenshot, recording and desktop-level operation; outbound internet access follows the assistant computer egress setting (isolated from the control plane network). HOME (~) persists across turns and ${shared}; /workspace and /tmp are ephemeral disk-backed directories (default 20 GB each, separate from the 16 GB RAM limit) that are cleared when the computer is reclaimed or recreated. Only small reusable personal/group data belongs in HOME (package caches already go to /tmp). To fetch full source code of an authorized repository for inspection, building, or testing, prefer checkout_repository (which uses the control-plane cache into /workspace/<dir> or /tmp/<dir> without exposing credentials, and works for both GitHub App and PAT accounts) or run \`git clone https://<host>/<owner>/<repo>.git /workspace/<dir>\` directly when in a container harness with Git credentials configured; never use anonymous curl against GitHub /tarball or codeload URLs for private repositories, and never clone repositories or put build outputs/dependencies inside persistent HOME (~). HOME has a size limit: when a tool reports it read-only, delete what is no longer needed with delete_file or ask an administrator to clear it in the console.`;

export interface ComputerOwner { kind: 'group' | 'person'; subject: string; tenant: string }
/** What decides the HOME generation: a new binding or service role, or a narrower repository scope, starts a new one. */
export interface HomeFacts { binding?: string; role?: string; repositories: string[] }
export const ownerId = (owner: ComputerOwner) => digest(`assistant-computer:${owner.kind}:${owner.tenant}:${owner.subject}`).slice(0, 32);
const homeDefaults = { home_limit_gb: 5, retention_days: 30, total_alert_gb: 50 };
const homeBounds: Record<string, [number, number]> = { home_limit_gb: [1, 1024], retention_days: [1, 3650], total_alert_gb: [1, 1_000_000] };
// The manager keeps and checks the container settings: timers, capacity, network egress and each computer's resources.
const managerKeys = ['idle_minutes', 'max_containers', 'max_lifetime_minutes', 'cpus', 'memory_mb', 'pids', 'tmp_mb', 'workspace_mb', 'egress'];

/** HOME paths below the generation directory: no empty, '.' or '..' segment; null for the HOME root itself. */
function homeRelative(value: string): string | null {
  const parts = value.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..') || parts.length > 64) fail(400, 'invalid_path');
  return parts.length ? parts.join('/') : null;
}
type Location = { home: true; rel: string | null; display: string } | { home: false; path: string; display: string };
function locate(value: unknown): Location {
  const raw = typeof value === 'string' ? value : '';
  if (!raw || raw.length > 4096 || raw.includes('\0')) fail(400, 'invalid_path');
  if (raw === '~' || raw === assistantHome || raw.startsWith('~/') || raw.startsWith(assistantHome + '/')) {
    const rel = homeRelative(raw.startsWith('~') ? raw.slice(1) : raw.slice(assistantHome.length));
    return { home: true, rel, display: '~/' + (rel ?? '') };
  }
  return { home: false, path: raw, display: raw };
}

export class AssistantHomes {
  private readonly locks = new Map<string, Promise<unknown>>();
  private alerted = 0;
  constructor(readonly store: Store, readonly root: string) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_homes(owner TEXT PRIMARY KEY,kind TEXT NOT NULL,subject TEXT NOT NULL,tenant TEXT NOT NULL,
        generation INTEGER NOT NULL,binding_id TEXT,service_role_id TEXT,repositories TEXT NOT NULL,bytes INTEGER,files INTEGER,measured_at INTEGER,
        over_limit INTEGER NOT NULL DEFAULT 0,active_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_home_sealed(owner TEXT NOT NULL,generation INTEGER NOT NULL,sealed_at INTEGER NOT NULL,reason TEXT NOT NULL,bytes INTEGER,
        PRIMARY KEY(owner,generation));`);
  }
  settings(): typeof homeDefaults {
    const saved = this.store.get("SELECT value FROM settings WHERE key='assistant_computers.homes'")?.value;
    return { ...homeDefaults, ...(saved ? JSON.parse(saved) : {}) };
  }
  saveSettings(input: Json): void {
    for (const [key, value] of Object.entries(input)) { const [min, max] = homeBounds[key]!;
      if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(400, 'invalid_assistant_settings', key); }
    this.store.run("INSERT INTO settings VALUES('assistant_computers.homes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ ...this.settings(), ...input }));
  }
  view(): Json { return { settings: this.settings(), defaults: homeDefaults, bounds: homeBounds }; }
  row(owner: string): Row | undefined { return this.store.get('SELECT * FROM assistant_homes WHERE owner=?', owner); }
  directory(owner: string, generation: number): string { return `${this.root}/${owner}/home-${generation}`; }
  /** Serializes clearing and removal of an owner's data with the turns that prepare it. */
  exclusive<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(owner) ?? Promise.resolve(), next = previous.then(fn, fn), tail = next.catch(() => {});
    this.locks.set(owner, tail); void tail.then(() => { if (this.locks.get(owner) === tail) this.locks.delete(owner); });
    return next;
  }
  /** The owner's current HOME generation, made on first use; a new binding or role, or a narrower scope, seals the old one. */
  prepare(owner: ComputerOwner, facts: HomeFacts): Promise<{ id: string; generation: number; mode: 'rw' | 'ro'; directory: string }> {
    const id = ownerId(owner);
    return this.exclusive(id, async () => {
      const repositories = [...new Set(facts.repositories)].sort(), now = Date.now();
      this.store.transaction(() => {
        const row = this.row(id);
        if (!row) {
          this.store.run('INSERT INTO assistant_homes(owner,kind,subject,tenant,generation,binding_id,service_role_id,repositories,active_at,created_at) VALUES(?,?,?,?,1,?,?,?,?,?)',
            id, owner.kind, owner.subject, owner.tenant, facts.binding ?? null, facts.role ?? null, JSON.stringify(repositories), now, now);
          return;
        }
        const previous = JSON.parse(row.repositories) as string[];
        const reason = (facts.binding ?? null) !== row.binding_id ? 'binding_changed' : (facts.role ?? null) !== row.service_role_id ? 'service_role_changed'
          : previous.some(r => !repositories.includes(r)) ? 'scope_narrowed' : null;
        if (reason) {
          // Data the HOME may hold from a scope or role it no longer has is sealed, never mounted again, and removed after retention.
          this.store.run('INSERT OR REPLACE INTO assistant_home_sealed VALUES(?,?,?,?,?)', id, row.generation, now, reason, row.bytes);
          this.store.run(`UPDATE assistant_homes SET generation=generation+1,binding_id=?,service_role_id=?,repositories=?,bytes=NULL,files=NULL,measured_at=NULL,over_limit=0
            WHERE owner=?`, facts.binding ?? null, facts.role ?? null, JSON.stringify(repositories), id);
        } else if (repositories.length !== previous.length) this.store.run('UPDATE assistant_homes SET repositories=? WHERE owner=?', JSON.stringify(repositories), id);
      });
      const row = this.row(id)!, directory = this.directory(id, row.generation);
      // Owner directories are readable by the manager's group (it checks the generation exists before mounting it).
      for (const [path, mode] of [[`${this.root}/${id}`, 0o750], [directory, 0o700]] as const) {
        // A HOME volume that is missing or not writable leaves the assistants without a computer, never on another one.
        await mkdir(path).catch(error => { if (error.code !== 'EEXIST') fail(503, 'assistant_computer_unavailable'); });
        const info = await lstat(path).catch(() => null);
        if (!info?.isDirectory()) fail(503, 'assistant_computer_unavailable');
        await chmod(path, mode).catch(() => fail(503, 'assistant_computer_unavailable'));
      }
      return { id, generation: row.generation, mode: row.over_limit ? 'ro' as const : 'rw' as const, directory };
    });
  }
  touch(owner: string): void { this.store.run('UPDATE assistant_homes SET active_at=? WHERE owner=?', Date.now(), owner); }
  // Opens a HOME file and proves, from the open descriptor, that it is a regular file inside the generation directory: a
  // symlink placed by a command anywhere on the path cannot lead the control plane into another owner's data.
  private async inside(directory: string, handle: Awaited<ReturnType<typeof open>>): Promise<void> {
    const actual = await readlink(`/proc/self/fd/${handle.fd}`), base = await realpath(directory).catch(() => '\0');
    if (!actual.startsWith(base + '/')) { await handle.close(); fail(400, 'invalid_path'); }
    if (!(await handle.stat()).isFile()) { await handle.close(); fail(400, 'regular_file_required'); }
  }
  async read(directory: string, rel: string | null, limit: number): Promise<{ data: Buffer; size: number }> {
    if (!rel) return fail(400, 'regular_file_required');
    const handle = await open(`${directory}/${rel}`, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => fail(400, error.code === 'ELOOP' ? 'invalid_path' : error.code === 'ENOENT' ? 'file_not_found' : 'file_not_readable'));
    await this.inside(directory, handle);
    try {
      const size = (await handle.stat()).size, data = Buffer.alloc(Math.min(size, limit)), { bytesRead } = await handle.read(data, 0, data.length, 0);
      return { data: data.subarray(0, bytesRead), size };
    } finally { await handle.close(); }
  }
  async write(directory: string, rel: string | null, data: Buffer): Promise<void> {
    if (!rel) return fail(400, 'regular_file_required');
    // Parent directories one by one, refusing a symlink on the way; the file is truncated only after its descriptor is proven
    // to be inside this HOME.
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const path = `${directory}/${parts.slice(0, i).join('/')}`, info = await lstat(path).catch(() => null);
      if (!info) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') fail(400, 'file_not_writable'); });
      else if (!info.isDirectory()) fail(400, 'invalid_path');
    }
    const handle = await open(`${directory}/${rel}`, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644).catch(error => fail(400, error.code === 'ELOOP' ? 'invalid_path' : 'file_not_writable'));
    await this.inside(directory, handle);
    try { await handle.truncate(0); await handle.write(data, 0, data.length, 0); }
    catch (error) { fail(400, (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'assistant_computer_disk_full' : 'file_not_writable'); }
    finally { await handle.close(); }
  }
  /** Removes a HOME entry directly. Only safe while no process can change this HOME (the caller checks the computer). */
  async remove(directory: string, rel: string | null): Promise<Json> {
    if (!rel) return fail(400, 'invalid_path');
    const parent = rel.includes('/') ? `${directory}/${rel.slice(0, rel.lastIndexOf('/'))}` : directory;
    const real = await realpath(parent).catch(() => null), base = await realpath(directory).catch(() => fail(400, 'file_not_found'));
    if (real === null) return { deleted: false };
    if (real !== base && !real.startsWith(base + '/')) fail(400, 'invalid_path');
    const path = `${real}/${rel.split('/').at(-1)}`, info = await lstat(path).catch(() => null);
    if (!info) return { deleted: false };
    await (info.isDirectory() ? rm(path, { recursive: true, force: true }) : unlink(path)).catch(() => fail(400, 'file_not_deletable'));
    return { deleted: true, directory: info.isDirectory() };
  }
  /** Bytes on disk and files of a directory tree, without following symlinks; bounded in time. */
  async usage(directory: string, budgetMs = 60_000): Promise<{ bytes: number; files: number; complete: boolean }> {
    const deadline = Date.now() + budgetMs, stack = [directory];
    let bytes = 0, files = 0;
    while (stack.length) {
      if (Date.now() > deadline) return { bytes, files, complete: false };
      const current = stack.pop()!;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = `${current}/${entry.name}`, info = await lstat(path).catch(() => null);
        if (!info) continue;
        bytes += Math.max(info.blocks * 512, 0); if (!info.isDirectory()) files++; else stack.push(path);
      }
    }
    return { bytes, files, complete: true };
  }
  /** After a turn: the HOME's size decides whether the next turn mounts it read-only (the soft limit). */
  async measure(owner: string): Promise<void> {
    const row = this.row(owner); if (!row) return;
    const used = await this.usage(this.directory(owner, row.generation)), limit = this.settings().home_limit_gb * gib;
    this.store.run('UPDATE assistant_homes SET bytes=?,files=?,measured_at=?,over_limit=? WHERE owner=? AND generation=?',
      used.bytes, used.files, Date.now(), used.bytes > limit ? 1 : 0, owner, row.generation);
    this.alert();
  }
  totals(): { bytes: number; alert_bytes: number; alert: boolean } {
    const bytes = Number(this.store.get('SELECT coalesce(sum(bytes),0) n FROM assistant_homes')!.n) + Number(this.store.get('SELECT coalesce(sum(bytes),0) n FROM assistant_home_sealed')!.n);
    const limit = this.settings().total_alert_gb * gib;
    return { bytes, alert_bytes: limit, alert: bytes > limit };
  }
  // All HOMEs together have no hard limit; past the threshold the console shows an alert and the log says so hourly.
  private alert(): void {
    const totals = this.totals();
    if (totals.alert && Date.now() - this.alerted > 3600_000) { this.alerted = Date.now(); console.warn(`[assistant-computers] HOME total ${(totals.bytes / gib).toFixed(1)} GB exceeds the alert threshold ${(totals.alert_bytes / gib).toFixed(0)} GB`); }
  }
  /** Removes an owner's data: every generation, or (keep) all but an empty current one. */
  async clear(owner: string, keep: boolean): Promise<void> {
    const row = this.row(owner);
    this.store.trajectories.results.removeOwner(assistantResultOwner(owner));
    await rm(`${this.root}/${owner}`, { recursive: true, force: true });
    this.store.run('DELETE FROM assistant_home_sealed WHERE owner=?', owner);
    if (keep && row) {
      this.store.run('UPDATE assistant_homes SET bytes=0,files=0,measured_at=?,over_limit=0 WHERE owner=?', Date.now(), owner);
    } else this.store.run('DELETE FROM assistant_homes WHERE owner=?', owner);
  }
  async sweepSealed(now: number): Promise<number> {
    const before = now - this.settings().retention_days * 86400_000, rows = this.store.all('SELECT * FROM assistant_home_sealed WHERE sealed_at<?', before);
    for (const row of rows) {
      // A sealed generation is never mounted, so nothing can change it while it is removed.
      await rm(this.directory(row.owner, row.generation), { recursive: true, force: true });
      this.store.run('DELETE FROM assistant_home_sealed WHERE owner=? AND generation=?', row.owner, row.generation);
    }
    return rows.length;
  }
  inactive(now: number): Row[] { return this.store.all('SELECT * FROM assistant_homes WHERE active_at<?', now - this.settings().retention_days * 86400_000); }
}

type FenceResolver = (row: Row) => string | null;
/** The assistants configured with a harness other than native: the management assistant and enabled group bindings. */
export function harnessAssistants(store: Store): string[] {
  const management = store.hasTable('service_roles') ? store.get("SELECT harness FROM service_roles WHERE id='management-assistant' AND enabled=1 AND harness<>'native'") : undefined;
  const groups = store.hasTable('channel_service_bindings') ? Number(store.get("SELECT count(*) n FROM channel_service_bindings WHERE enabled=1 AND harness<>'native'")!.n) : 0;
  return [...(management ? [`the management assistant (${management.harness})`] : []), ...(groups ? [`${groups} group assistant binding${groups > 1 ? 's' : ''}`] : [])];
}
/** The control plane's side of assistant computers: the manager calls, the background sweeps and the console view. */
export class AssistantComputerService {
  readonly homes?: AssistantHomes;
  readonly active = new Map<string, AssistantComputer>();
  private readonly fences = new Map<string, FenceResolver>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private startup?: ReturnType<typeof setTimeout>;
  private readonly maintenance = new Set<Promise<unknown>>();
  private stopped = false;
  private reconciled = false;
  private sweeping = false;
  constructor(readonly store: Store, readonly manager?: Manager, root?: string) {
    if (root) this.homes = new AssistantHomes(store, root);
  }
  available(): boolean { return !!this.manager && !!this.homes; }
  /**
   * Whether a harness turn can get a computer now (#1254), and if not, why: no manager, no HOME volume in the control
   * plane, a manager that does not answer, or a manager without the HOME volume. Read without creating a computer.
   */
  async status(): Promise<{ available: boolean; reason?: string }> {
    if (!this.manager) return { available: false, reason: 'manager_not_configured' };
    if (!this.homes) return { available: false, reason: 'assistant_homes_missing' };
    const view = await this.manager.call('GET', '/v1/assistant-computers/settings').catch(() => null) as Json | null;
    if (!view) return { available: false, reason: 'manager_unavailable' };
    if (view.homes === false) return { available: false, reason: 'assistant_homes_unavailable' };
    return { available: true };
  }
  /**
   * The start-up warning (#1254): an assistant that runs on a harness (Pi, Codex, Claude Code) needs a computer for every
   * turn, so a deployment without one says so when it starts, not when the first turn fails.
   */
  async warnIfRequired(log: (line: string) => void = line => console.warn(line)): Promise<string | null> {
    const users = harnessAssistants(this.store); if (!users.length) return null;
    const status = await this.status(); if (status.available) return null;
    const line = `[assistant-computers] ${users.join(' and ')} run on a harness that needs an assistant computer for every turn, but assistant computers are unavailable (${status.reason}): those turns fail until the manager and the assistant-homes volume are available.`;
    log(line); return line;
  }
  /** How a kind of owner computes its fence now; null means its computer must go (disabled binding, inactive person). */
  resolve(kind: ComputerOwner['kind'], fence: FenceResolver): void { this.fences.set(kind, fence); }
  turn(options: TurnOptions): AssistantComputer { return new AssistantComputer(this, options); }
  async remove(owner: string): Promise<void> { await this.manager?.call('DELETE', '/v1/assistant-computers/' + owner); }
  // Computers whose owner's fence changed, or whose binding or person is no longer usable, are removed at once; after a
  // restart of the control plane every computer not held by a turn it runs now is removed.
  async sweep(): Promise<void> {
    if (!this.available() || this.sweeping) return; this.sweeping = true;
    try {
      if (!this.reconciled) { await this.manager!.call('POST', '/v1/assistant-computers/reconcile', { turns: [...this.active.keys()] }); this.reconciled = true; }
      const { computers } = await this.manager!.call('GET', '/v1/assistant-computers') as { computers: Json[] };
      for (const computer of computers) {
        const row = this.homes!.row(String(computer.owner)), fence = row ? this.current(row) : null;
        if (fence !== computer.fence) await this.remove(String(computer.owner)).catch(() => {});
      }
    } catch { /* The manager is unavailable: the next sweep tries again. */ } finally { this.sweeping = false; }
  }
  current(row: Row): string | null { try { return this.fences.get(row.kind)?.(row) ?? null; } catch { return null; } }
  /** Retention: sealed generations and owners without a turn for the retention period are removed. */
  async retain(now = Date.now()): Promise<void> {
    if (!this.homes) return;
    await this.homes.sweepSealed(now);
    for (const row of this.homes.inactive(now)) await this.homes.exclusive(row.owner, async () => {
      if (this.homes!.row(row.owner)?.active_at !== row.active_at) return;
      await this.remove(row.owner); await this.homes!.clear(row.owner, false);
    }).catch(error => console.error('[assistant-computers] retention failed:', error instanceof Error ? error.message : 'unknown'));
  }
  start(): void {
    if (!this.available() || this.timers.length) return;
    this.stopped = false;
    const run = (work: () => Promise<void>) => {
      if(this.stopped)return;
      const pending=work().catch(error=>console.error('[assistant-computers] maintenance failed:',error instanceof Error?error.message:'unknown')).finally(()=>this.maintenance.delete(pending));this.maintenance.add(pending);
    };
    this.timers = [setInterval(() => run(()=>this.sweep()), 10_000), setInterval(() => run(()=>this.retain()), 3600_000)];
    for (const timer of this.timers) timer.unref();
    this.startup=setTimeout(() => { run(()=>this.sweep());run(()=>this.retain()); }, 1000);this.startup.unref();
  }
  async close(): Promise<void> {
    this.stopped=true;clearTimeout(this.startup);for(const timer of this.timers)clearInterval(timer);this.timers=[];
    // Retention reads SQLite again after filesystem/manager awaits; finish it before the caller closes storage.
    await Promise.allSettled([...this.maintenance]);
  }
  async settingsView(): Promise<Json | null> {
    if (!this.available()) return null;
    return { computers: await this.manager!.call('GET', '/v1/assistant-computers/settings').catch(() => null), homes: this.homes!.view() };
  }
  async saveSettings(input: Json): Promise<void> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) fail(400, 'invalid_assistant_settings');
    if (!this.available()) fail(503, 'assistant_computers_unavailable');
    fields(input, [...managerKeys, ...Object.keys(homeDefaults)]);
    const computer = Object.fromEntries(Object.entries(input).filter(([k]) => managerKeys.includes(k))), homes = Object.fromEntries(Object.entries(input).filter(([k]) => !managerKeys.includes(k)));
    // Checked before either part is saved, so a refused value changes nothing.
    for (const [key, value] of Object.entries(homes)) { const [min, max] = homeBounds[key]!;
      if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(400, 'invalid_assistant_settings', key); }
    if (Object.keys(computer).length) await this.manager!.call('PUT', '/v1/assistant-computers/settings', computer);
    if (Object.keys(homes).length) this.homes!.saveSettings(homes);
  }
  /** Every group and person with a HOME: size, files, last activity, state and whether a computer runs now. */
  async overview(): Promise<Json> {
    if (!this.available()) fail(503, 'assistant_computers_unavailable');
    const computers = await this.manager!.call('GET', '/v1/assistant-computers').then(r => r.computers as Json[]).catch(() => null);
    const running = new Map((computers ?? []).map(c => [String(c.owner), c]));
    const name = (row: Row) => row.kind === 'group'
      ? String(this.store.get('SELECT display_name FROM channel_chats WHERE id=?', row.subject)?.display_name || '') || null
      : this.store.get('SELECT u.username FROM principals p JOIN users u ON u.id=p.user_id WHERE p.id=?', row.subject)?.username ?? null;
    const homes = this.store.all('SELECT * FROM assistant_homes ORDER BY coalesce(bytes,0) DESC,active_at DESC').map(row => ({ owner: row.owner, kind: row.kind, subject: row.subject,
      name: name(row), tenant: row.tenant || null, generation: row.generation, bytes: row.bytes, files: row.files, measured_at: row.measured_at, active_at: row.active_at,
      read_only: !!row.over_limit, computer: running.get(row.owner)?.state ?? null,
      sealed: this.store.all('SELECT generation,sealed_at,reason,bytes FROM assistant_home_sealed WHERE owner=? ORDER BY generation', row.owner) }));
    const disk = await statfs(this.homes!.root).then(s => ({ free_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize })).catch(() => null);
    return { homes, totals: this.homes!.totals(), disk, computers: computers === null ? null : { running: computers.length, busy: computers.filter(c => c.state === 'busy').length }, settings: this.homes!.settings() };
  }
  /** Console: removes the owner's computer and every byte of its HOME (all generations). */
  async clear(owner: string): Promise<Json> {
    if (!this.available()) fail(503, 'assistant_computers_unavailable');
    if (!/^[a-f0-9]{32}$/.test(owner) || !this.homes!.row(owner)) fail(404, 'assistant_home_not_found');
    await this.homes!.exclusive(owner, async () => { await this.remove(owner); await this.homes!.clear(owner, true); });
    return { owner, cleared: true };
  }
}

export interface TurnOptions {
  owner: ComputerOwner; turn: string;
  /** The owner's fence now; the computer is bound to it. */
  fence: () => string;
  facts: () => HomeFacts;
  /** Rechecks the turn (stopped, changed source); throws to end it. */
  check: () => Promise<void> | void;
  /** Whether this turn may run commands; without it only HOME is available, served without a computer. */
  commands: () => boolean;
  /** Throws when this owner may not use a computer at all. */
  eligible: () => void;
  /** Tells the conversation that the turn waits for a computer. */
  notify?: (text: string) => Promise<unknown> | unknown;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A refused computer operation, returned to the model as its tool result. */
class Refusal extends Error { constructor(readonly result: Json) { super(String(result.error)); } }
/** One turn's use of its owner's computer. Created lazily: a turn that never touches it starts nothing. */
export class AssistantComputer {
  private home?: { id: string; generation: number; mode: 'rw' | 'ro'; directory: string };
  private held = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  egress = true;
  constructor(readonly service: AssistantComputerService, readonly options: TurnOptions) {}
  // An early start (warm) and the first use share one HOME preparation and one acquisition of the container.
  private preparing?: Promise<NonNullable<AssistantComputer['home']>>;
  private acquiring?: Promise<string>;
  // Set when the turn ended: an acquisition still under way then gives its container back instead of keeping it.
  private closed = false;
  private async prepare(runtime=false) {
    if (!this.service.available()) fail(409, 'computer_not_configured');
    await this.options.check(); if(!runtime)this.options.eligible();
    // A failed preparation is not kept: the next use tries again, as before the early start.
    if (!this.home) this.home = await (this.preparing ??= this.service.homes!.prepare(this.options.owner, this.options.facts()).catch(error => { this.preparing = undefined; throw error; }));
    return this.home;
  }
  /**
   * Starts taking the owner's computer for a harness turn before its first use (#1254), the way that use takes it (the
   * harness runtime: no command permission needed), so creating or reusing the container overlaps the turn's other
   * preparation. A failure here changes nothing: the first use meets it again and reports it.
   */
  warm(): void { if (this.service.available() && !this.held && !this.closed) void this.computer(true).catch(() => {}); }
  private notice(): Json { return this.home?.mode === 'ro' ? { home_read_only: true, notice: 'HOME 已超过容量上限，本回合只读：先用 delete_file 删除不再需要的文件，或请管理员在控制台清空；下一回合按清理后的大小恢复可写。' } : {}; }
  /** The owner's container, held by this turn: created or reused, waiting in line while capacity is full. */
  private async computer(runtime=false): Promise<string> {
    const home = await this.prepare(runtime);
    this.service.store.trajectories.results.directory(assistantResultOwner(home.id));
    if (this.held) return home.id;
    if (!runtime&&!this.options.commands()) fail(400, 'assistant_computer_requires_commands');
    return this.acquiring ??= this.acquire(home, runtime).finally(() => { this.acquiring = undefined; });
  }
  private async acquire(home: NonNullable<AssistantComputer['home']>, runtime: boolean): Promise<string> {
    let told = false, retried = false;
    for (;;) {
      if (this.closed) fail(409, 'assistant_computer_released');
      await this.options.check();
      const result = await this.service.manager!.call('PUT', '/v1/assistant-computers/' + home.id,
        { turn: this.options.turn, fence: this.options.fence(), home_generation: home.generation, home_mode: home.mode,...(runtime?{harness:true}:{}) }, 120_000).catch(error => {
        // No fallback to a project computer or the host: the turn learns that the computer is unavailable.
        if (error instanceof HttpError && ['manager_unavailable', 'docker_operation_failed', 'assistant_computer_create_failed', 'runner_not_ready', 'assistant_homes_unavailable', 'assistant_home_missing', 'not_found'].includes(error.code)) fail(503, 'assistant_computer_unavailable');
        // Removed while it was being created: the turn is not in `active` until this call returns, so the first reconcile
        // after a start of the control plane removes it (the periodic sweep never sees a computer being created). It is
        // taken again once, after check() (a turn whose permission or source changed ends there), like an execute that
        // meets a removal.
        if (!retried && error instanceof HttpError && error.code === 'assistant_computer_released') { retried = true; return { state: 'released' }; }
        throw error;
      });
      if (result?.state === 'ready') {
        this.egress = typeof result?.computer?.egress === 'boolean' ? result.computer.egress : true;
        break;
      }
      if (result?.state === 'released') continue;
      if (!told && this.options.notify) {
        told = true;
        await this.options.notify(result?.reason === 'owner_busy' ? '电脑正在被你的另一个会话使用，等它结束后继续。' : `助手电脑繁忙，正在排队（第 ${result?.position ?? 1} 位），轮到后继续。`);
      }
      await sleep(2000);
    }
    // The turn ended while its computer was being taken (an early start the turn never used): give it back at once.
    if (this.closed) {
      await this.service.manager!.call('POST', `/v1/assistant-computers/${home.id}/release`, { turn: this.options.turn, remove: false }).catch(() => {});
      fail(409, 'assistant_computer_released');
    }
    this.held = true; this.service.active.set(this.options.turn, this);
    // Model thinking and other tools keep the computer: the manager counts a turn as gone only when renewals stop.
    this.heartbeat = setInterval(() => { void this.service.manager!.call('POST', `/v1/assistant-computers/${home.id}/renew`, { turn: this.options.turn }).catch(() => {}); }, 30_000);
    this.heartbeat.unref();
    return home.id;
  }
  private async run(request: Json, timeoutMs = 90_000, retry = true): Promise<Json> {
    const owner = await this.computer();
    let result: Json; const operation=randomId();
    try {
      result = await this.service.manager!.call('POST', `/v1/assistant-computers/${owner}/execute`, { turn: this.options.turn, operation_id: operation, request }, timeoutMs + 60_000);
    } catch (error) {
      // The computer went away under the turn (idle sweep after a manager restart, a removal): it is taken again once.
      if (retry && error instanceof HttpError && ['assistant_computer_released', 'assistant_computer_not_acquired'].includes(error.code)) {
        await this.options.check(); this.drop(); return this.run(request, timeoutMs, false);
      }
      throw error;
    }
    await this.options.check();
    if (!result?.ok) {
      // A failed file operation or runner call is an observation for the model, never the end of the turn.
      const detail = String(result?.detail ?? '');
      throw new Refusal({ error: /destination_exists/.test(detail) ? 'destination_exists'
        : /unsafe_archive_symlink/.test(detail) ? 'unsafe_archive_symlink'
        : /unsafe_archive_path/.test(detail) ? 'unsafe_archive_path'
        : /unsafe_archive_entry_type/.test(detail) ? 'unsafe_archive_entry_type'
        : /archive_too_large/.test(detail) ? 'archive_too_large'
        : /archive_too_many_files/.test(detail) ? 'archive_too_many_files'
        : /archive_missing/.test(detail) ? 'archive_missing'
        : /ENOENT/.test(detail) ? 'file_not_found' : /EROFS/.test(detail) ? 'assistant_home_read_only' : /ENOSPC/.test(detail) ? 'assistant_computer_disk_full'
        : /regular_file_required|EISDIR/.test(detail) ? 'regular_file_required' : /invalid_path|ENOTDIR|ELOOP/.test(detail) ? 'invalid_path' : 'assistant_computer_operation_failed',
        ...(detail ? { detail: detail.slice(0, 2000) } : {}) });
    }
    return request.type==='command'?commandResult(result.result,'assistant:'+owner+':'+operation,offset=>this.service.manager!.call('POST',`/v1/assistant-computers/${owner}/output`,{turn:this.options.turn,operation_id:operation,offset})):result.result as Json;
  }
  /** Trusted Harness transport, never exposed as a model tool. Runtime allocation grants no native tools. */
  async sessionWorkspace(task:Row,workspaceId:string,redactor:Redactor,log:(event:any)=>void):Promise<Workspace>{
    const owner=await this.computer(true);
    const transport={call:async(method:string,path:string,input?:Json)=>{
      await this.options.check();
      if(method==='GET')return {state:'ready',generation:this.home!.generation,computer:{egress:this.egress}};
      if(method!=='POST'||!input?.request)fail(400,'invalid_runner_request');
      const result=await this.service.manager!.call('POST',`/v1/assistant-computers/${owner}/execute`,{turn:this.options.turn,operation_id:input!.operation_id,request:input!.request});
      await this.options.check();return result;
    }} as Manager;
    const space=new Workspace(this.service.store,transport,{...task,workspace_id:workspaceId,generation:this.home!.generation},redactor,async()=>{await this.options.check();},log,'service_role_operations');
    const ready=await space.call('session-init:'+randomId(),{type:'workspace_init'});if(ready.error)fail(503,'conversation_workspace_unavailable');
    return space;
  }
  private drop(): void { clearInterval(this.heartbeat); this.held = false; this.service.active.delete(this.options.turn); }
  private async readComputer(path: string, limit: number): Promise<{ data: Buffer; size: number }> {
    const chunks: Buffer[] = []; let size = 0, offset = 0;
    do {
      const part = await this.run({ type: 'assistant_read', path, offset, limit: Math.min(readLimit, limit - offset) });
      size = Number(part.size); const data = Buffer.from(String(part.base64), 'base64'); chunks.push(data); offset += data.length;
      if (!data.length) break;
    } while (offset < Math.min(size, limit));
    return { data: Buffer.concat(chunks), size };
  }
  private async writeComputer(path: string, data: Buffer): Promise<void> {
    let offset = 0;
    do { await this.run({ type: 'assistant_write', path, base64: data.subarray(offset, offset + chunk).toString('base64'), offset }); offset += chunk; } while (offset < data.length);
  }
  private writable(): void { if (this.home?.mode === 'ro') fail(400, 'assistant_home_read_only'); }
  // Whether a direct change to HOME is safe now: no running process can change it (this turn's own computer when it mounts
  // HOME read-write, or another turn of the same owner holding the computer).
  private async quiet(owner: string): Promise<'direct' | 'computer'> {
    if (this.held) return this.home!.mode === 'ro' ? 'direct' : 'computer';
    const { computers } = await this.service.manager!.call('GET', '/v1/assistant-computers') as { computers: Json[] };
    const other = computers.find(c => c.owner === owner);
    if (other?.state === 'busy' && (other.home as Json)?.mode === 'rw') fail(400, 'assistant_computer_busy');
    return 'direct';
  }
  async execute(name: string, args: Json): Promise<Json> {
    try { return await this.operate(name, args); } catch (error) { if (error instanceof Refusal) return { ...error.result, ...this.notice() }; throw error; }
  }
  private async operate(name: string, args: Json): Promise<Json> {
    if (name === 'run_command') {
      fields(args, ['command', 'timeout_seconds', 'keep_background']);
      if (args.keep_background !== undefined && typeof args.keep_background !== 'boolean') fail(400, 'invalid_field', 'keep_background');
      const command = text(args.command, 16000), seconds = assistantCommandTimeout(args.timeout_seconds);
      return { ...(await this.run({ type: 'command', command, timeout_ms: seconds * 1000, ...(args.keep_background === true ? { keep_background: true } : {}) }, seconds * 1000)), ...this.notice() };
    }
    fields(args, name === 'write_file' ? ['path', 'content'] : ['path']);
    const where = locate(args.path);
    if (name === 'read_file') {
      const file = where.home ? await this.prepare().then(home => this.service.homes!.read(home.directory, where.rel, readLimit)) : await this.readComputer(where.path, readLimit);
      return { path: where.display, content: file.data.toString('utf8'), size: file.size, ...(file.size > readLimit ? { truncated: true, notice: '只返回了前 1 MiB；更大的文件请用 run_command（如 head、sed、jq）分段处理。' } : {}), ...this.notice() };
    }
    if (name === 'write_file') {
      if (typeof args.content !== 'string' || args.content.length > 48000 || args.content.includes('\0')) fail(400, 'invalid_field', 'content');
      await this.store(where, Buffer.from(args.content as string));
      return { path: where.display, written: true, ...this.notice() };
    }
    if (name !== 'delete_file') fail(403, 'tool_not_allowed');
    if (!where.home) return { path: where.display, ...(await this.run({ type: 'assistant_delete', path: where.path })) };
    const home = await this.prepare();
    if (await this.quiet(home.id) === 'computer') return { path: where.display, ...(await this.run({ type: 'assistant_delete', path: assistantHome + '/' + (where.rel ?? '') })), ...this.notice() };
    return { path: where.display, ...(await this.service.homes!.remove(home.directory, where.rel)), ...this.notice() };
  }
  private async store(where: Location, data: Buffer): Promise<void> {
    if (!where.home) return this.writeComputer(where.path, data);
    const home = await this.prepare(); this.writable();
    await this.service.homes!.write(home.directory, where.rel, data);
  }
  /** An attachment copied into HOME or a temporary area (import_message_resource). */
  async importFile(path: string, data: Buffer): Promise<Json> {
    const where = locate(path);
    try { await this.store(where, data); } catch (error) { if (error instanceof Refusal) return { ...error.result, ...this.notice() }; throw error; }
    return { path: where.display, written: true, size: data.length, ...this.notice() };
  }
  /** A regular file of the computer for a reply attachment (attach_workspace_file). */
  async exportFile(path: string, maxBytes: number): Promise<{ data: Buffer; name: string }> {
    const where = locate(path);
    const file = await (where.home ? this.prepare().then(home => this.service.homes!.read(home.directory, where.rel, maxBytes + 1)) : this.readComputer(where.path, maxBytes + 1))
      .catch(error => { if (error instanceof Refusal) fail(400, String(error.result.error)); throw error; });
    if (!file.size || file.size > maxBytes || file.data.length !== file.size) fail(413, 'channel_resource_too_large');
    return { data: file.data, name: where.display.split('/').filter(Boolean).at(-1)! };
  }
  /** Stages and safely extracts a control-plane tar.gz archive into /workspace or /tmp (checkout_repository, #1279). */
  async extractArchive(archive: Buffer | { file: string; size: number }, destination: string, options: { overwrite?: boolean } = {}): Promise<Json> {
    const stageId = randomId();
    try {
      if (Buffer.isBuffer(archive)) {
        for (let offset = 0; offset < archive.length || offset === 0; offset += chunk) {
          const slice = archive.subarray(offset, offset + chunk);
          await this.run({ type: 'assistant_archive_stage', stage_id: stageId, base64: slice.toString('base64'), offset });
          if (archive.length === 0) break;
        }
      } else {
        await readFileChunks(archive.file, archive.size, chunk, async (slice, offset) => {
          await this.run({ type: 'assistant_archive_stage', stage_id: stageId, base64: slice.toString('base64'), offset });
        });
      }
      const extracted = await this.run({
        type: 'assistant_archive_extract',
        stage_id: stageId,
        destination,
        overwrite: options.overwrite === true,
      }, 180_000);
      return { ...extracted, ...this.notice() };
    } catch (error) {
      if (error instanceof Refusal) return { ...error.result, ...this.notice() };
      throw error;
    }
  }
  /** The turn ended: its processes end and the idle timer starts, or with remove (a changed fence) the computer goes. */
  async close(remove = false): Promise<void> {
    const id = ownerId(this.options.owner), held = this.held;
    this.closed = true; this.drop(); this.service.homes?.touch(id);
    if (held) await this.service.manager!.call('POST', `/v1/assistant-computers/${id}/release`, { turn: this.options.turn, remove }).catch(() => {});
    if (this.home) void this.service.homes!.measure(id).catch(() => {});
  }
}

/** Console: every HOME with its use and the clear action, for super administrators (global settings). */
export async function assistantComputersApi(service: AssistantComputerService, user: Actor, method: string, path: string): Promise<Json | undefined> {
  if (path !== '/api/assistant-computers' && !path.startsWith('/api/assistant-computers/')) return undefined;
  // Whether assistant computers work in this deployment (#1254): the console warns whoever picks a harness that needs them.
  if (method === 'GET' && path === '/api/assistant-computers/status') return service.status();
  superAdmin(user);
  if (method === 'GET' && path === '/api/assistant-computers') return service.overview();
  const clear = /^\/api\/assistant-computers\/([a-f0-9]{32})\/clear$/.exec(path);
  if (method === 'POST' && clear) { const result = await service.clear(clear[1]!); service.store.audit(user.id, 'assistant_computers.home_cleared', clear[1]!); return result; }
  return fail(404, 'not_found');
}
