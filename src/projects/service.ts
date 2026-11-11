import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { type Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from '../app/auth.js';
import { fail, fields, randomId, HttpError, type Json } from '../core/security.js';
import { FailureLog } from '../core/log.js';
import { withTaskMetrics } from '../metrics/accounting.js';
import { repositoryConcurrency } from '../app/settings.js';
import { ownComputer } from '../rules/service.js';

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
  // Projects being deleted, and the reconciliation step running for a project right now. Reconciliation leaves a project
  // that is being deleted alone, so it cannot start or recreate its computer while the deletion runs.
  private readonly removing = new Set<string>();
  private readonly working = new Map<string, Promise<void>>();
  private readonly failures = new FailureLog('projects');
  // Automatic starts of failed computers: how many in a row, and when the next one may be sent.
  private readonly restarts = new Map<string, { attempts: number, at: number }>();
  constructor(readonly store: Store, readonly manager: Manager) {store.db.exec('CREATE TABLE IF NOT EXISTS computer_console_specs(repository_id TEXT PRIMARY KEY,spec TEXT NOT NULL)');}
  save(row: Row): void {
    if (!row) return;
    this.store.run(`INSERT INTO project_environments(repository_id,generation,state,desired,error,started_at,revision) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(repository_id) DO UPDATE SET generation=excluded.generation,state=excluded.state,desired=excluded.desired,error=excluded.error,
      started_at=excluded.started_at,revision=excluded.revision WHERE excluded.generation>project_environments.generation
      OR (excluded.generation=project_environments.generation AND excluded.revision>=project_environments.revision)`,
    row.repository_id, row.generation, row.state, row.desired, row.error || null, row.started_at || null, row.revision || 0);
  }
  async reconcile(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.sync().finally(() => { this.syncing = null; }); return this.syncing;
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
  private async reconcileProject(repo: Row): Promise<void> {
    try {
      let state = await this.manager.call('GET', '/v1/projects/' + repo.id);
      if (this.removing.has(repo.id)) return;
      if (!state && repo.enabled) state = await this.manager.call('PUT', '/v1/projects/' + repo.id);
      if (!state || this.removing.has(repo.id)) return;
      this.save(state);
      // The manager admits as many runner calls at once as tasks may run, never fewer than hold a claim right now.
      const parallel = Math.max(repositoryConcurrency(this.store, repo.id), Number(this.store.get('SELECT count(*) AS n FROM task_claims WHERE repository_id=?', repo.id)!.n));
      if (Number.isSafeInteger(state.parallel) && state.parallel !== parallel) await this.manager.call('PUT', `/v1/projects/${repo.id}/parallel`, { tasks: parallel }).catch(() => {});
      // An enabled project's computer that failed (a lost container, a failed recovery or restart) is started again, after
      // 30 s, 1, 2, 4 … minutes (at most 30) between attempts, so it never stays down with its tasks waiting for it.
      // A failed reset is left for a person: starting the old generation is refused until it is reset again.
      if (state.state !== 'failed') this.restarts.delete(repo.id);
      const retry = repo.enabled && state.state === 'failed' && Date.now() >= (this.restarts.get(repo.id)?.at ?? 0);
      if (retry) { const attempts = (this.restarts.get(repo.id)?.attempts ?? 0) + 1; this.restarts.set(repo.id, { attempts, at: Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 30 * 60_000) }); }
      const action = !repo.enabled && !['stopped','deleted'].includes(state.desired) ? 'stop'
        : repo.enabled && (['stopped','deleted'].includes(state.state) || retry) ? 'start' : null;
      if (action) {
        const input = { operation_id: randomId(), generation: state.generation };
        this.store.run("INSERT INTO environment_operations VALUES(?,?,?,?,'pending',NULL)", input.operation_id, repo.id, action, JSON.stringify(input));
        const result = await this.send(this.store.get('SELECT * FROM environment_operations WHERE id=?', input.operation_id)!);
        // A start that brought the computer up ends the backoff, so a later failure is retried at once.
        if (result?.state !== 'failed') this.restarts.delete(repo.id);
        if (result?.state) state = result;
      } else if (repo.enabled && state.state === 'ready' && state.computer?.resources_pending) {
        // The resource defaults changed: a computer that follows them is rebuilt once no task runs on it. The engine claims no
        // task on it while the refresh is pending; checking for claims and recording it in one step leaves no gap between.
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
  endRemoval(id: string): void { this.removing.delete(id); }
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
    const result = await this.manager.call(method, `/v1/projects/${id}/notes${name === undefined ? '' : '/' + encodeURIComponent(name)}`, method === 'PUT' ? { content: input.content } : undefined);
    if (method !== 'GET') this.store.audit(user.id, method === 'PUT' ? 'notes.written' : 'notes.deleted', name!, id);
    return result;
  }
  private async send(op: Row): Promise<Json> {
    try {
      // Starting, resetting, reconfiguring or refreshing may build a package image and run the setup script: allow up to 35 minutes.
      const result = await this.manager.call('POST', `/v1/projects/${op.repository_id}/${op.action}`, JSON.parse(op.input), ['start', 'reset', 'configure', 'refresh'].includes(op.action) ? 35 * 60000 : 90000);
      this.store.transaction(() => {
        this.save(result); this.store.run("UPDATE environment_operations SET state='completed',result=? WHERE id=?", JSON.stringify(result), op.id);
        if(op.action==='configure'){
          const previous=this.store.get('SELECT spec FROM computer_console_specs WHERE repository_id=?',op.repository_id),base=previous?JSON.parse(previous.spec):{};
          const{rerun_setup:_rerun,...values}=JSON.parse(op.input).request;
          // A null resource follows the default again, so it leaves the console layer.
          const spec={...base,...values};for(const key of Object.keys(spec))if(spec[key]===null)delete spec[key];
          this.store.run('INSERT INTO computer_console_specs VALUES(?,?) ON CONFLICT(repository_id) DO UPDATE SET spec=excluded.spec',op.repository_id,JSON.stringify(spec));
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
  async detail(id: string): Promise<Json> {
    const saved = this.store.get(`SELECT r.full_name,p.enabled,e.* FROM repositories r JOIN policies p ON p.repository_id=r.id
      LEFT JOIN project_environments e ON e.repository_id=r.id WHERE r.id=?`, id)!;
    let observed = 'available';
    const live = await this.manager.call('GET', '/v1/projects/' + id).catch(error => {
      observed = error instanceof HttpError && error.code === 'manager_not_ready' ? 'recovering'
        : error instanceof HttpError && error.code !== 'manager_unavailable' ? 'error' : 'unavailable';
      return null;
    });
    if (!live && observed === 'available') observed = 'absent';
    const tasks = this.store.all(`SELECT id,kind,status,phase,object_number,generation,error_code,updated_at FROM tasks WHERE repository_id=?
      ORDER BY created_at DESC,id DESC LIMIT 20`, id);
    const commands: Json[] = [];
    for (const row of this.store.all(`SELECT l.task_id,l.content,l.created_at,t.kind,t.object_number FROM task_logs l JOIN tasks t ON t.id=l.task_id
      WHERE t.repository_id=? ORDER BY l.rowid DESC LIMIT 500`, id)) {
      let entry: Json; try { entry = JSON.parse(row.content); } catch { continue; }
      const command = entry.type === 'command' ? entry : entry.type === 'tool' && entry.name === 'run_command' ? { command: (entry.arguments as Json)?.command, ...(entry.result as Json) } : null;
      if (!command) continue;
      commands.push({ task_id: row.task_id, kind: row.kind, object_number: row.object_number, created_at: row.created_at, command: command.command,
        exit_code: command.exit_code ?? null, timed_out: !!command.timed_out, error: command.error ?? null });
      if (commands.length >= 30) break;
    }
    return { observation: { status: observed, checked_at: new Date().toISOString(), state: live?.state ?? null },
      environment: { ...saved, repository_id: id, state: saved.state || (saved.enabled ? 'provisioning' : 'stopped'), computer: live?.computer || null,
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
    const match = /^\/api\/environments\/([^/]+)(?:\/(start|stop|reset|delete|configure|stats))?$/.exec(url.pathname);
    if (!match) return fail(404, 'not_found');
    const id = match[1]!; repository(this.store, user, id);
    if (!match[2] && method === 'GET') return this.detail(id);
    if (this.removing.has(id) && method !== 'GET') fail(409, 'repository_deleting');
    if (match[2] === 'stats' && method === 'GET') return { stats: await this.manager.call('GET', `/v1/projects/${id}/stats`) };
    if (method !== 'POST' || !match[2]) return fail(404, 'not_found');
    fields(input, ['operation_id','generation','confirm','spec']);
    if (!/^[a-f0-9]{48}$/.test(String(input.operation_id || '')) || !Number.isSafeInteger(input.generation)) fail(400, 'invalid_operation');
    if (match[2] === 'delete') { superAdmin(user); if (input.confirm !== true) fail(400, 'confirmation_required'); }
    // The computer spec (CPU, memory, processes, /tmp, internet) is a deployment resource: super administrators only.
    // The manager enforces the bounds; the control plane only forwards the requested values.
    if (match[2] === 'configure') { superAdmin(user); if (!input.spec || typeof input.spec !== 'object' || Array.isArray(input.spec)) fail(400, 'invalid_spec'); }
    else if (input.spec !== undefined) fail(400, 'invalid_operation');
    const previous = this.store.get('SELECT * FROM environment_operations WHERE id=?', String(input.operation_id));
    const payload = JSON.stringify({ operation_id: input.operation_id, generation: input.generation, ...(match[2] === 'configure' ? { request: input.spec } : {}) });
    if (previous && (previous.repository_id !== id || previous.action !== match[2] || previous.input !== payload)) fail(409, 'operation_id_conflict');
    if (!previous && this.store.get("SELECT 1 FROM environment_operations WHERE repository_id=? AND state='pending'", id)) fail(409, 'environment_operation_pending');
    const state = await this.manager.call('GET', '/v1/projects/' + id) || await this.manager.call('PUT', '/v1/projects/' + id);
    this.save(state);
    if(match[2]==='configure'&&!previous)this.store.run('INSERT INTO computer_console_specs VALUES(?,?) ON CONFLICT DO NOTHING',id,JSON.stringify(ownComputer(state.computer)));
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
