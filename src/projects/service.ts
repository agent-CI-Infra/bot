import { projectResultOwner } from '../agent/tool-results.js';
import { request as httpRequest } from 'node:http';
import { historyData, logContent, unreadable } from '../storage/payloads.js';
import { request as httpsRequest } from 'node:https';
import { type Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from '../app/auth.js';
import { authorize } from '../identity/authorization.js';
import { fail, fields, randomId, HttpError, type Json } from '../core/security.js';
import { configuredRedactor } from '../core/redaction.js';
import { FailureLog } from '../core/log.js';
import { withTaskMetrics } from '../metrics/accounting.js';
import { repositoryConcurrency } from '../app/settings.js';
import { consoleComputer, ownComputer, rememberConsoleComputer, saveConsoleComputer, syncConsoleComputer } from '../rules/service.js';
import { MAX_CLI_CONFIG_BYTES } from '../../runner/cli-config.mjs';

// Resource and network policy fields remain super-administrator-only; project administrators may configure software overlays.
export const superAdminComputerFields = new Set(['cpus', 'memory_mb', 'pids', 'tmp_mb', 'egress']);
export const projectAdminComputerFields = new Set(['packages', 'setup_script', 'env', 'rebuild', 'rerun_setup']);

export function canConfigureProject(user: Actor, projectId: string): boolean {
  if (user.role === 'super_admin') return true;
  if (!user.context) return false;
  try { authorize(user.context, 'config.write', { project_id: projectId }); return true; } catch { return false; }
}

export function requireProjectConfigWrite(user: Actor, projectId: string): void {
  if (user.role === 'super_admin') return;
  if (!user.context) return fail(403, 'forbidden');
  authorize(user.context, 'config.write', { project_id: projectId });
}

export function authorizeComputerSpec(user: Actor, spec: Json): void {
  const keys = Object.keys(spec);
  if (keys.some(key => superAdminComputerFields.has(key) || !projectAdminComputerFields.has(key))) superAdmin(user);
}

/** Strips raw global setup_script text and global env values (both in global_defaults and merged top-level env) for non-super actors. */
export function sanitizeComputerForActor(user: Actor, computer: any): any {
  if (!computer || typeof computer !== 'object' || user.role === 'super_admin') return computer;
  const ownEnv = computer.own && typeof computer.own.env === 'object' && computer.own.env !== null
    ? { ...computer.own.env }
    : {};
  const gd = computer.global_defaults;
  const sanitizedGlobal = gd && typeof gd === 'object' ? (() => {
    const { setup_script: globalScript, env: globalEnv, ...restGlobal } = gd;
    return {
      ...restGlobal,
      has_setup_script: typeof globalScript === 'string' && globalScript.trim().length > 0,
      env_keys: globalEnv && typeof globalEnv === 'object' ? Object.keys(globalEnv).sort() : [],
    };
  })() : gd;
  return {
    ...computer,
    ...(computer.own ? { env: ownEnv } : {}),
    ...(gd !== undefined ? { global_defaults: sanitizedGlobal } : {}),
  };
}
// timeoutMs 0 waits until the manager answers, for commands that have no time limit.
export interface Manager { call(method: string, path: string, input?: Json, timeoutMs?: number): Promise<any>; }
export class ManagerClient implements Manager {
  private readonly failures = new FailureLog('manager');
  constructor(private readonly url: string, private readonly token: Buffer) {}
  private report(error: unknown, stage: string, timedOut: boolean): void {
    // Never log the URL, exception message, request or response: all may contain credentials or project data.
    const name = error instanceof Error && ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'Error';
    const code = (error as NodeJS.ErrnoException)?.code;
    const safeCode = typeof code === 'string' && /^(?:E[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,40})$/.test(code) ? code : 'none';
    this.failures.report('request', `target=manager stage=${stage} name=${name} code=${safeCode} timeout=${timedOut}`);
  }
  async call(method: string, path: string, input?: Json, timeoutMs = 90000) {
    // node:http rather than fetch: fetch stops waiting for response headers after 5 minutes, and the manager answers a command only when it ends.
    const url = new URL(this.url + path), body = input ? JSON.stringify(input) : undefined;
    let status: number, text: string, timedOut = false;
    try {
      ({ status, text } = await new Promise<{ status: number, text: string }>((resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method,
          headers: { Authorization: 'Bearer ' + this.token.toString('base64'), 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
          const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', error => { clearTimeout(timer); reject(error); });
          res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString() }); });
        });
        const timer = timeoutMs ? setTimeout(() => { timedOut = true; req.destroy(Object.assign(new Error('manager_timeout'), { code: 'ETIMEDOUT' })); }, timeoutMs) : undefined;
        req.on('error', error => { clearTimeout(timer); reject(error); }); req.end(body);
      }));
    } catch (error) { this.report(error, 'request', timedOut); return fail(503, 'manager_unavailable'); }
    let value: Json; try { value = JSON.parse(text); } catch (error) { this.report(error, 'response_json', false); return fail(503, 'manager_unavailable'); }
    this.failures.clear('request');
    if (status < 200 || status >= 300) fail(status, typeof value.error === 'string' ? value.error : 'manager_unavailable');
    return value.result;
  }
}
export class ProjectService {
  private syncing: Promise<void> | null = null;
  private stateSyncing: Promise<void> | null = null;
  // Projects being deleted, and the reconciliation step running for a project right now. Reconciliation leaves a project
  // that is being deleted alone, so it cannot start or recreate its computer while the deletion runs.
  private readonly removing = new Set<string>();
  private readonly working = new Map<string, Promise<void>>();
  private readonly failures = new FailureLog('projects');
  // Automatic starts of failed computers: how many in a row, and when the next one may be sent.
  private readonly restarts = new Map<string, { attempts: number, at: number }>();
  // Starts the manager refused because a deleted project's notes could not be cleared yet (#783): the row stays deleted,
  // so the deletion itself is not retried on every pass. Same 30 s → 1, 2 … minutes (at most 30) spacing as a failed
  // computer; one answered start clears it.
  private readonly notesRetries = new Map<string, { attempts: number, at: number }>();
  constructor(readonly store: Store, readonly manager: Manager) {store.db.exec('CREATE TABLE IF NOT EXISTS computer_console_specs(repository_id TEXT PRIMARY KEY,spec TEXT NOT NULL)');}
  /**
   * Fail closed at control-plane startup before TaskEngine starts: mark every saved project_environments row
   * toolchain_pending=1 so queued tasks cannot claim against stale rows persisted before a restart/upgrade.
   * Each repository's flag is updated only once GET /v1/projects/:id succeeds and save() writes live state.
   */
  markStartupPending(): void {
    this.store.run('UPDATE project_environments SET toolchain_pending=1');
  }
  save(row: Row): void {
    if (!row) return;
    this.store.run(`INSERT INTO project_environments(repository_id,generation,state,desired,error,started_at,revision,toolchain_pending) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(repository_id) DO UPDATE SET generation=excluded.generation,state=excluded.state,desired=excluded.desired,error=excluded.error,
      started_at=excluded.started_at,revision=excluded.revision,toolchain_pending=excluded.toolchain_pending WHERE excluded.generation>project_environments.generation
      OR (excluded.generation=project_environments.generation AND excluded.revision>=project_environments.revision)`,
    row.repository_id, row.generation, row.state, row.desired, row.error || null, row.started_at || null, row.revision || 0, (row as any).computer?.toolchain_pending ? 1 : 0);
  }
  /**
   * Fast read-only state sync across repositories, decoupled from long-running pending environment_operations
   * so one repository's slow start/configure/refresh never delays toolchain_pending sync for healthy repositories.
   */
  async syncStates(): Promise<void> {
    if (this.stateSyncing) return this.stateSyncing;
    this.stateSyncing = (async () => {
      for (const repo of this.store.all('SELECT r.id FROM repositories r JOIN policies p ON p.repository_id=r.id')) {
        if (this.removing.has(repo.id)) continue;
        try {
          const state = await this.manager.call('GET', '/v1/projects/' + repo.id, undefined, 10_000);
          if (state && !this.removing.has(repo.id)) this.save(state);
        } catch {
          // Fail closed: keep existing toolchain_pending (1 after markStartupPending) while manager is not ready or unavailable.
        }
      }
    })().finally(() => { this.stateSyncing = null; });
    return this.stateSyncing;
  }
  async reconcile(): Promise<void> {
    const states = this.syncStates();
    if (this.syncing) { await states; return this.syncing; }
    this.syncing = states.then(() => this.sync()).finally(() => { this.syncing = null; }); return this.syncing;
  }
  private async sync(): Promise<void> {
    // Retry persisted intentions with their original id, never create another reset after a lost response.
    for (const op of this.store.all("SELECT * FROM environment_operations WHERE state='pending'")) {
      if (this.removing.has(op.repository_id)) continue;
      // Keep the last durable manager state; the operation API exposes failure and the log says why.
      const key = `operation ${op.action} ${op.id} of ${op.repository_id}`;
      try { await this.send(op); this.failures.clear(key); }
      catch (error) {
        // send() marks an operation the manager refused for certain as failed; it is not sent again, so the log says so once.
        const abandoned = this.store.get('SELECT state FROM environment_operations WHERE id=?', op.id)?.state === 'failed';
        this.failures.report(key, abandoned ? `${(error as Error)?.message || error} (given up, not retried)` : error);
        if (abandoned) this.failures.forget(key);
      }
    }
    for (const repo of this.store.all('SELECT r.id,p.enabled FROM repositories r JOIN policies p ON p.repository_id=r.id')) {
      if (this.removing.has(repo.id)) continue;
      const step = this.reconcileProject(repo); this.working.set(repo.id, step);
      try { await step; } finally { this.working.delete(repo.id); }
    }
  }
  /**
   * When the latest committed deletion of this repository that still owes a notes removal happened (#771), or null.
   * The reclaim audit only answers failures it is newer than: a repository connected, deleted and failed again has a
   * new intent even though an earlier reclaim answered the earlier one.
   */
  private notesUnreclaimedAt(id: string): string | null {
    const row = this.store.get(`SELECT max(f.created_at) t FROM audit f WHERE f.repository_id=? AND f.action='repository.notes_removal_failed'
      AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.repository_id=f.repository_id AND r.action='repository.notes_volume_reclaimed' AND r.created_at >= f.created_at)`, id);
    return row?.t ? String(row.t) : null;
  }
  private async reconcileProject(repo: Row): Promise<void> {
    this.store.trajectories.results.directory(projectResultOwner(repo.id));
    try {
      // The repository is connected again while the notes volume of the project it used to be is still there: the old
      // notes must never be readable by the new project, so the volume goes before anything can start against it (#771).
      const failedAt = this.notesUnreclaimedAt(repo.id);
      if (failedAt) {
        const listed = await this.manager.call('GET', '/v1/notes-volumes').catch(() => null);
        const volumes = (Array.isArray(listed) ? listed : Array.isArray((listed as any)?.volumes) ? (listed as any).volumes : null) as
          { repository_id?: unknown; created_at?: unknown }[] | null;
        // A manager that cannot list its volumes is asked again on the next pass; deleting blind is what lost real notes.
        if (volumes) {
          const volume = volumes.find(row => String(row.repository_id) === repo.id);
          // A volume created after the failure belongs to the project connected since: the notes of the deleted project
          // are already gone, so only the intent closes. An old volume, or none at all, is the residue that must go.
          const stale = !volume || !volume.created_at || !Number.isFinite(Date.parse(String(volume.created_at))) ||
            Date.parse(String(volume.created_at)) <= Date.parse(failedAt);
          if (stale) await this.reclaimNotes(repo.id);
          this.store.audit('system', 'repository.notes_volume_reclaimed', repo.id, repo.id);
        }
      }
      let state = await this.manager.call('GET', '/v1/projects/' + repo.id);
      if (this.removing.has(repo.id)) return;
      if (!state && repo.enabled) state = await this.manager.call('PUT', '/v1/projects/' + repo.id);
      if (!state || this.removing.has(repo.id)) return;
      this.save(state);
      syncConsoleComputer(this.store, repo.id, (state as any)?.computer);
      // The manager admits as many runner calls at once as tasks may run, never fewer than hold a claim right now.
      const parallel = Math.max(repositoryConcurrency(this.store, repo.id), Number(this.store.get('SELECT count(*) AS n FROM task_claims WHERE repository_id=?', repo.id)!.n));
      if (Number.isSafeInteger(state.parallel) && state.parallel !== parallel) await this.manager.call('PUT', `/v1/projects/${repo.id}/parallel`, { tasks: parallel }).catch(() => {});
      // An enabled project's computer that failed (a lost container, a failed recovery or restart) is started again, after
      // 30 s, 1, 2, 4 … minutes (at most 30) between attempts, so it never stays down with its tasks waiting for it.
      // A failed reset is left for a person: starting the old generation is refused until it is reset again.
      if (state.state !== 'failed') this.restarts.delete(repo.id);
      const retry = repo.enabled && state.state === 'failed' && Date.now() >= (this.restarts.get(repo.id)?.at ?? 0);
      if (retry) { const attempts = (this.restarts.get(repo.id)?.attempts ?? 0) + 1; this.restarts.set(repo.id, { attempts, at: Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 30 * 60_000) }); }
      // A start still owed a notes purge waits for its retry slot: the manager answered why it could not clear the residue,
      // and asking again on this pass would only repeat that answer (#783).
      const notesWaiting = (this.notesRetries.get(repo.id)?.at ?? 0) > Date.now();
      const action = !repo.enabled && !['stopped','deleted'].includes(state.desired) ? 'stop'
        : repo.enabled && !notesWaiting && (['stopped','deleted'].includes(state.state) || retry) ? 'start' : null;
      if (action) {
        const input = { operation_id: randomId(), generation: state.generation };
        this.store.run("INSERT INTO environment_operations VALUES(?,?,?,?,'pending',NULL)", input.operation_id, repo.id, action, JSON.stringify(input));
        const result = await this.send(this.store.get('SELECT * FROM environment_operations WHERE id=?', input.operation_id)!);
        // A start that brought the computer up ends the backoff, so a later failure is retried at once.
        if (result?.state !== 'failed') this.restarts.delete(repo.id);
        // An answered start also clears the notes-retry slot: the residue it owed is gone, or the manager no longer refuses it.
        this.notesRetries.delete(repo.id);
        if (result?.state) state = result;
      } else if (repo.enabled && state.state === 'ready' && (state.computer?.resources_pending || state.computer?.image_pending)) {
        // Resource defaults changed or a deferred recovery precompiled image finished building: rebuild once no task
        // runs on the computer. claimQueuedTask excludes repositories with a pending environment_operations row, so
        // checking claims and recording `refresh` in one transaction leaves no race window.
        const input = { operation_id: randomId(), generation: state.generation };
        const queued = this.store.transaction(() => {
          if (this.store.get("SELECT 1 FROM task_claims WHERE repository_id=? UNION ALL SELECT 1 FROM environment_operations WHERE repository_id=? AND state='pending'", repo.id, repo.id)) return false;
          this.store.run("INSERT INTO environment_operations VALUES(?,?,?,?,'pending',NULL)", input.operation_id, repo.id, 'refresh', JSON.stringify(input)); return true;
        });
        if (queued) await this.send(this.store.get('SELECT * FROM environment_operations WHERE id=?', input.operation_id)!);
      }
      // A pass that did not throw has not fixed a computer the manager still reports as failed.
      if (!['failed', 'reset_failed'].includes(state.state)) this.failures.clear('project ' + repo.id);
    } catch (error) { /* The environment page retains a visible fault instead of claiming readiness. */
      this.failures.report('project ' + repo.id, error);
      // A start refused because the old notes are still there keeps the row deleted; space the retries out instead of
      // sending one on every pass, and let a successful start clear the slot (#783).
      if (error instanceof HttpError && error.code === 'notes_residue_unclearable') {
        const attempts = (this.notesRetries.get(repo.id)?.attempts ?? 0) + 1;
        this.notesRetries.set(repo.id, { attempts, at: Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 30 * 60_000) });
      }
      // Recovery is a temporary fence, not a new durable fault of this project's computer.
      if (error instanceof HttpError && error.code === 'manager_not_ready') return;
      if (this.removing.has(repo.id) || !this.store.get('SELECT 1 FROM repositories WHERE id=?', repo.id)) return;
      // A manager that answered with its own code has saved what failed (a stopped or failed computer and its code);
      // that state is shown as it is. Only a manager that could not be reached marks the environment unavailable.
      const answered = error instanceof HttpError && error.code !== 'manager_unavailable';
      const state = answered ? await this.manager.call('GET', '/v1/projects/' + repo.id).catch(() => null) : null;
      if (state) { this.save(state); return; }
      this.store.run(`INSERT INTO project_environments(repository_id,state,error) VALUES(?,'unavailable',?)
        ON CONFLICT(repository_id) DO UPDATE SET state='unavailable',error=excluded.error`, repo.id, answered ? (error as HttpError).code : 'manager_unavailable');
    }
  }
  // Deleting a project runs the existing environment deletion: the containers and networks of every generation go, and the
  // work volumes stay, including those an earlier reset left behind; the project notes volume goes with the project.
  // The project stays marked as being deleted until endRemoval, also when this throws.
  async removeEnvironment(id: string, waitMs = 120_000, deleteNotes = false): Promise<void> {
    this.removing.add(id);
    const step = this.working.get(id);
    if (step) { let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([step.catch(() => {}), new Promise(r => { timer = setTimeout(r, waitMs); })]); clearTimeout(timer); }
    const state = await this.manager.call('GET', '/v1/projects/' + id);
    if (!state) return;
    const input = { operation_id: randomId(), generation: state.generation, ...(deleteNotes ? { request: { delete_notes: true } } : {}) };
    this.store.run("INSERT INTO environment_operations VALUES(?,?,?,?,'pending',NULL)", input.operation_id, id, 'delete', JSON.stringify(input));
    await this.send(this.store.get('SELECT * FROM environment_operations WHERE id=?', input.operation_id)!);
  }
  /**
   * Deletes only the project's notes volume, best effort, after the row-deleting transaction has committed. The manager
   * keeps its own project row, so the deletion still works; nothing is saved back, the project no longer exists here for
   * the save to refer to. The caller records a failure instead of reporting the committed deletion as failed.
   */
  /** Every notes volume the manager owns, including ones no project row here refers to any more (#771). */
  async notesVolumes(): Promise<{ name: string; repository_id: string; created_at: string | null }[]> {
    const answer = await this.manager.call('GET', '/v1/notes-volumes') as unknown;
    // The manager answers the bare array today; a proxy or a newer manager may wrap it in `volumes`. Any other answer is
    // unreadable rather than empty: an empty list would claim nothing is left behind while the read actually failed,
    // so every caller takes its documented failure path instead (#808).
    const volumes = Array.isArray(answer) ? answer : (answer as { volumes?: unknown } | null | undefined)?.volumes;
    if (!Array.isArray(volumes)) fail(503, 'manager_notes_volumes_unavailable');
    return volumes as { name: string; repository_id: string; created_at: string | null }[];
  }
  /** Idempotent, name-based reclaim: it works after the project row is gone, which a retried deletion needs (#771). */
  async reclaimNotes(id: string, waitMs = 120_000): Promise<void> { await this.manager.call('POST', `/v1/projects/${id}/notes/reclaim`, {}, waitMs); }
  async removeNotes(id: string, waitMs = 120_000): Promise<void> {
    const state = await this.manager.call('GET', '/v1/projects/' + id);
    // Without the manager's state the volume cannot be identified, so the caller's audit names a removal that did not
    // happen; the volume, if any, is left behind for a later sweep.
    if (!state) fail(503, 'manager_project_missing');
    const input = { operation_id: randomId(), generation: state.generation, request: { delete_notes: true } };
    await this.manager.call('POST', `/v1/projects/${id}/delete`, input, waitMs);
  }
  endRemoval(id: string): void { this.removing.delete(id); }
  /** True while the project is being deleted; background work leaves its computer alone. */
  isRemoving(id: string): boolean { return this.removing.has(id); }
  private async notesApi(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const match = /^\/api\/repositories\/([^/]+)\/notes(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return undefined;
    const id = match[1]!; let name = match[2]; repository(this.store, user, id);
    try { if (name !== undefined) name = decodeURIComponent(name); } catch { return fail(400, 'invalid_note_name'); }
    if (this.removing.has(id)) fail(409, 'repository_deleting');
    if (!['GET','PUT','DELETE'].includes(method) || method !== 'GET' && !name) fail(404, 'not_found');
    fields(input, method === 'PUT' ? ['content'] : []);
    if (method === 'PUT') {
      const content = input.content;
      if (typeof content !== 'string') return fail(400, 'invalid_note_content');
    }
    const result = await this.manager.call(method, `/v1/projects/${id}/notes${name === undefined ? '' : '/' + encodeURIComponent(name)}`, method === 'PUT' ? { content: configuredRedactor(this.store).text(String(input.content)) } : undefined);
    if (method !== 'GET') this.store.audit(user.id, method === 'PUT' ? 'notes.written' : 'notes.deleted', name!, id);
    return result;
  }
  private async send(op: Row): Promise<Json> {
    this.store.trajectories.results.directory(projectResultOwner(op.repository_id));
    try {
      // Starting, resetting, reconfiguring or refreshing may build a package image and run the setup script: allow up to 35 minutes.
      const result = await this.manager.call('POST', `/v1/projects/${op.repository_id}/${op.action}`, JSON.parse(op.input), ['start', 'reset', 'configure', 'refresh'].includes(op.action) ? 35 * 60000 : 90000);
      this.store.transaction(() => {
        this.save(result); this.store.run("UPDATE environment_operations SET state='completed',result=? WHERE id=?", JSON.stringify(result), op.id);
        if(op.action==='configure'){
          const computer = (result as any)?.computer;
          const buildState = String(computer?.build?.state || '');
          // Only commit the console spec layer when the change applied synchronously; async builds sync via spec_revision once ready.
          if (!['queued', 'building', 'cancelling'].includes(buildState)) {
            const base = consoleComputer(this.store, op.repository_id, computer);
            const { rerun_setup: _rerun, rebuild: _rebuild, ...values } = JSON.parse(op.input).request;
            // Merge requested keys into the existing console layer (preserving any unapplied imported fields);
            // a null resource follows the default again, so it leaves the console layer.
            const spec: Record<string, unknown> = { ...base, ...values };
            for (const key of Object.keys(spec)) if (spec[key] === null) delete spec[key];
            const rev = typeof computer?.spec_revision === 'number' ? Number(computer.spec_revision) : undefined;
            saveConsoleComputer(this.store, op.repository_id, spec, rev);
          }
        }
      }); return result;
    } catch (error) {
      // No project operation ran during recovery. Keep the intention pending with its original id for the next pass.
      if (error instanceof HttpError && error.code === 'manager_not_ready') throw error;
      // A timeout may mean the operation completed. Leave it pending and reconcile the same id.
      const state = await this.manager.call('GET', `/v1/projects/${op.repository_id}`).catch(() => null);
      if (state) this.save(state);
      if (error instanceof Error && !['manager_unavailable','service_unavailable'].includes(error.message)) this.store.run("UPDATE environment_operations SET state='failed',result=? WHERE id=?", JSON.stringify({ error: error.message }), op.id);
      throw error;
    }
  }
  // One project computer: its fixed spec, current queue and recent execution history.
  async detail(id: string, user?: Actor): Promise<Json> {
    const saved = this.store.get(`SELECT r.full_name,p.enabled,e.* FROM repositories r JOIN policies p ON p.repository_id=r.id
      LEFT JOIN project_environments e ON e.repository_id=r.id WHERE r.id=?`, id)!;
    let observed = 'available';
    const live = await this.manager.call('GET', '/v1/projects/' + id).catch(error => {
      observed = error instanceof HttpError && error.code === 'manager_not_ready' ? 'recovering'
        : error instanceof HttpError && error.code !== 'manager_unavailable' ? 'error' : 'unavailable';
      return null;
    });
    if (!live && observed === 'available') observed = 'absent';
    if (live?.computer) syncConsoleComputer(this.store, id, live.computer);
    const tasks = this.store.all(`SELECT id,kind,status,phase,object_number,generation,error_code,updated_at FROM tasks WHERE repository_id=?
      ORDER BY created_at DESC,id DESC LIMIT 20`, id);
    const commands: Json[] = [];
    // CROSS JOIN keeps task_logs outermost, walked newest first until 500 rows of this project: with task_logs_task the
    // planner would otherwise fetch every log of the project's tasks and sort them (hundreds of thousands for a busy one).
    for (const row of this.store.all(`SELECT l.task_id,l.content,l.content_ref,l.created_at,t.kind,t.object_number FROM task_logs l CROSS JOIN tasks t ON t.id=l.task_id
      WHERE t.repository_id=? ORDER BY l.rowid DESC LIMIT 500`, id)) {
      let entry: Json; try { entry = JSON.parse(row.content); } catch { continue; }
      // Only command logs are read whole: the header of a large one keeps its type and name, not its arguments.
      if (row.content_ref && (entry.type === 'command' || entry.type === 'tool' && entry.name === 'run_command')) try { entry = JSON.parse(logContent(this.store, row)); } catch { continue; }
      const command = entry.type === 'command' ? entry : entry.type === 'tool' && entry.name === 'run_command' ? { command: (entry.arguments as Json)?.command, ...(entry.result as Json) } : null;
      if (!command) continue;
      commands.push({ task_id: row.task_id, kind: row.kind, object_number: row.object_number, created_at: row.created_at, command: command.command,
        exit_code: command.exit_code ?? null, timed_out: !!command.timed_out, error: command.error ?? null });
      if (commands.length >= 30) break;
    }
    const computer = live?.computer ? (user ? sanitizeComputerForActor(user, live.computer) : live.computer) : null;
    return { observation: { status: observed, checked_at: new Date().toISOString(), state: live?.state ?? null },
      can_configure: user ? canConfigureProject(user, id) : undefined,
      environment: { ...saved, repository_id: id, state: saved.state || (saved.enabled ? 'provisioning' : 'stopped'), computer,
        operation_pending: !!this.store.get("SELECT 1 FROM environment_operations WHERE repository_id=? AND state='pending'", id) },
      running_tasks: this.store.all(`SELECT t.id,t.kind,t.status,t.phase,t.object_number,c.claimed_at FROM task_claims c JOIN tasks t ON t.id=c.task_id
        WHERE c.repository_id=? ORDER BY c.claimed_at,t.id`, id),
      // The queue is independent of the recent-history window, so older waiting tasks stay visible.
      queued_tasks: this.store.all(`SELECT id,kind,status,phase,object_number,created_at FROM tasks
        WHERE repository_id=? AND status='queued' ORDER BY created_at,id`, id),
      task_concurrency: repositoryConcurrency(this.store, id), tasks:withTaskMetrics(this.store,tasks), commands };
  }
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const notes = await this.notesApi(user, method, url, input); if (notes) return notes;
    if (!url.pathname.startsWith('/api/environments')) return undefined;
    if (url.pathname === '/api/environments' && method === 'GET') {
      const clauses = [scope(user, 'r.id').sql], args = [...scope(user, 'r.id').args];
      for (const [key, column] of [['repository_id','r.id'],['account_id','r.account_id'],['owner_id','r.owner_id']]) {
        const value = url.searchParams.get(key!); if (value) { if (key === 'repository_id') repository(this.store, user, value); clauses.push(`${column}=?`); args.push(value); }
      }
      return { environments: this.store.all(`SELECT r.id AS repository_id,r.full_name,r.account_id,r.owner_id,p.enabled,
        e.generation,COALESCE(e.state,CASE WHEN p.enabled=1 THEN 'provisioning' ELSE 'stopped' END) AS state,e.desired,e.error,e.started_at,
        EXISTS(SELECT 1 FROM environment_operations o WHERE o.repository_id=r.id AND o.state='pending') AS operation_pending,
        (SELECT json_group_array(json_object('id',t.id,'kind',t.kind,'status',t.status,'object_number',t.object_number)) FROM task_claims c
          JOIN tasks t ON t.id=c.task_id WHERE c.repository_id=r.id) AS running_tasks
        FROM repositories r JOIN policies p ON p.repository_id=r.id LEFT JOIN project_environments e ON e.repository_id=r.id
        WHERE ${clauses.join(' AND ')} ORDER BY r.full_name`, ...args).map(row => ({ ...row, running_tasks: JSON.parse(row.running_tasks) })) };
    }
    const cliConfigMatch = /^\/api\/environments\/([^/]+)\/cli-config$/.exec(url.pathname);
    if (cliConfigMatch) {
      const id = cliConfigMatch[1]!;
      repository(this.store, user, id);
      if (this.removing.has(id) && method !== 'GET') fail(409, 'repository_deleting');
      if (method === 'GET') {
        return await this.manager.call('GET', `/v1/projects/${id}/cli-config`, undefined, 15_000);
      }
      requireProjectConfigWrite(user, id);
      if (method === 'PUT') {
        fields(input, ['cli', 'file', 'content']);
        const cli = input.cli, file = input.file, content = input.content;
        if (typeof cli !== 'string' || typeof file !== 'string' || typeof content !== 'string') {
          return fail(400, 'invalid_cli_config');
        }
        if (!content.trim() || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_CLI_CONFIG_BYTES) {
          return fail(400, 'invalid_cli_config_content');
        }
        // Forward directly to manager → runner; control plane never stores or logs config file contents (#1260).
        const written = await this.manager.call('PUT', `/v1/projects/${id}/cli-config`, { cli, file, content }, 15_000);
        this.store.audit(user.id, 'environment.cli_config_written', `${cli}:${file}`, id);
        return written;
      }
      if (method === 'DELETE') {
        fields(input, ['cli', 'file']);
        const cli = typeof input.cli === 'string' ? input.cli : url.searchParams.get('cli');
        const file = typeof input.file === 'string' ? input.file : url.searchParams.get('file');
        if (!cli || !file) fail(400, 'invalid_cli_config');
        const removed = await this.manager.call('DELETE', `/v1/projects/${id}/cli-config`, { cli, file }, 15_000);
        this.store.audit(user.id, 'environment.cli_config_deleted', `${cli}:${file}`, id);
        return removed;
      }
      return fail(405, 'method_not_allowed');
    }
    const cancelBuild = /^\/api\/environments\/([^/]+)\/build\/cancel$/.exec(url.pathname);
    if (cancelBuild) {
      if (method !== 'POST') return fail(405, 'method_not_allowed');
      const id = cancelBuild[1]!; repository(this.store, user, id);
      requireProjectConfigWrite(user, id);
      if (this.removing.has(id)) fail(409, 'repository_deleting');
      const result = await this.manager.call('POST', `/v1/projects/${id}/build/cancel`, {});
      if (result?.environment) this.save(result.environment);
      this.store.audit(user.id, 'environment.build_cancelled', id, id);
      return result?.environment?.computer ? { ...result, environment: { ...result.environment, computer: sanitizeComputerForActor(user, result.environment.computer) } } : result;
    }
    const match = /^\/api\/environments\/([^/]+)(?:\/(start|stop|reset|delete|configure|stats))?$/.exec(url.pathname);
    if (!match) return fail(404, 'not_found');
    const id = match[1]!; repository(this.store, user, id);
    if (!match[2] && method === 'GET') return this.detail(id, user);
    if (this.removing.has(id) && method !== 'GET') fail(409, 'repository_deleting');
    if (match[2] === 'stats' && method === 'GET') return { stats: await this.manager.call('GET', `/v1/projects/${id}/stats`) };
    if (method !== 'POST' || !match[2]) return fail(404, 'not_found');
    fields(input, ['operation_id','generation','confirm','spec']);
    if (!/^[a-f0-9]{48}$/.test(String(input.operation_id || '')) || !Number.isSafeInteger(input.generation)) fail(400, 'invalid_operation');
    if (match[2] === 'delete') { superAdmin(user); if (input.confirm !== true) fail(400, 'confirmation_required'); }
    // Resource limits and network egress remain super-admin-only; project admins (config.write) may configure software overlays.
    if (match[2] === 'configure') {
      requireProjectConfigWrite(user, id);
      if (!input.spec || typeof input.spec !== 'object' || Array.isArray(input.spec)) fail(400, 'invalid_spec');
      authorizeComputerSpec(user, input.spec as Json);
    }
    else if (input.spec !== undefined) fail(400, 'invalid_operation');
    const previous = this.store.get('SELECT * FROM environment_operations WHERE id=?', String(input.operation_id));
    const payload = JSON.stringify({ operation_id: input.operation_id, generation: input.generation, ...(match[2] === 'configure' ? { request: input.spec } : {}) });
    if (previous && (previous.repository_id !== id || previous.action !== match[2] || previous.input !== payload)) fail(409, 'operation_id_conflict');
    if (!previous && this.store.get("SELECT 1 FROM environment_operations WHERE repository_id=? AND state='pending'", id)) fail(409, 'environment_operation_pending');
    this.store.trajectories.results.directory(projectResultOwner(id));
    const state = await this.manager.call('GET', '/v1/projects/' + id) || await this.manager.call('PUT', '/v1/projects/' + id);
    this.save(state);
    if(match[2]==='configure'&&!previous)rememberConsoleComputer(this.store,id,state.computer);
    if (!previous && input.generation !== state.generation) fail(409, 'stale_generation');
    this.store.transaction(() => {
      if (!previous) {
        this.store.run("INSERT INTO environment_operations VALUES(?,?,?,?,'pending',NULL)", String(input.operation_id), id, match[2]!, payload);
        this.store.audit(user.id, 'environment.' + match[2], String(input.operation_id), id);
        if (match[2] === 'start' || match[2] === 'reset') this.store.run('UPDATE policies SET enabled=1 WHERE repository_id=?', id);
        else if (match[2] !== 'configure') this.store.run('UPDATE policies SET enabled=0 WHERE repository_id=?', id);
      }
    });
    return { environment: await this.send(this.store.get('SELECT * FROM environment_operations WHERE id=?', String(input.operation_id))!) };
  }
}

/**
 * Control-plane startup sequence: fail closed by marking saved project_environments rows toolchain_pending=1,
 * start TaskEngine immediately without blocking on long-running pending environment_operations, and launch
 * background reconciliation so each repository's live toolchain_pending clears once the manager answers.
 */
export function startProjectRuntime(
  projects: Pick<ProjectService, 'markStartupPending' | 'reconcile'>,
  engine: { start(): void },
  onError: (error: unknown) => void = error => console.error('[projects] reconciliation failed:', error),
): Promise<void> {
  projects.markStartupPending();
  engine.start();
  return projects.reconcile().catch(onError);
}
