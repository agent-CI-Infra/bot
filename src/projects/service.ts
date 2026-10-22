import { type Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from '../app/auth.js';
import { fail, fields, randomId, type Json } from '../core/security.js';

export interface Manager { call(method: string, path: string, input?: Json): Promise<any>; }
export class ManagerClient implements Manager {
  constructor(private readonly url: string, private readonly token: Buffer) {}
  async call(method: string, path: string, input?: Json) {
    let response;
    try { response = await fetch(this.url + path, { method, signal: AbortSignal.timeout(90000),
      headers: { Authorization: 'Bearer ' + this.token.toString('base64'), 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) }); }
    catch { return fail(503, 'manager_unavailable'); }
    const value = await response.json() as Json;
    if (!response.ok) fail(response.status, typeof value.error === 'string' ? value.error : 'manager_unavailable');
    return value.result;
  }
}
export class ProjectService {
  private syncing: Promise<void> | null = null;
  constructor(readonly store: Store, readonly manager: Manager) {}
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
      try { await this.send(op); } catch { /* Keep the last durable manager state; the operation API exposes failure. */ }
    }
    for (const repo of this.store.all('SELECT r.id,p.enabled FROM repositories r JOIN policies p ON p.repository_id=r.id')) {
      try {
        let state = await this.manager.call('GET', '/v1/projects/' + repo.id);
        if (!state && repo.enabled) state = await this.manager.call('PUT', '/v1/projects/' + repo.id);
        if (!state) continue;
        this.save(state);
        const action = !repo.enabled && !['stopped','deleted'].includes(state.desired) ? 'stop'
          : repo.enabled && ['stopped','deleted'].includes(state.state) ? 'start' : null;
        if (action) {
          const input = { operation_id: randomId(), generation: state.generation };
          this.store.run("INSERT INTO environment_operations VALUES(?,?,?,?,'pending',NULL)", input.operation_id, repo.id, action, JSON.stringify(input));
          await this.send(this.store.get('SELECT * FROM environment_operations WHERE id=?', input.operation_id)!);
        }
      } catch { /* The environment page retains a visible fault instead of claiming readiness. */
        this.store.run(`INSERT INTO project_environments(repository_id,state,error) VALUES(?,'unavailable','manager_unavailable')
          ON CONFLICT(repository_id) DO UPDATE SET state='unavailable',error='manager_unavailable'`, repo.id);
      }
    }
  }
  private async send(op: Row): Promise<Json> {
    try {
      const result = await this.manager.call('POST', `/v1/projects/${op.repository_id}/${op.action}`, JSON.parse(op.input));
      this.store.transaction(() => {
        this.save(result); this.store.run("UPDATE environment_operations SET state='completed',result=? WHERE id=?", JSON.stringify(result), op.id);
      }); return result;
    } catch (error) {
      // A timeout may mean the operation completed. Leave it pending and reconcile the same id.
      const state = await this.manager.call('GET', `/v1/projects/${op.repository_id}`).catch(() => null);
      if (state) this.save(state);
      if (error instanceof Error && !['manager_unavailable','service_unavailable'].includes(error.message)) this.store.run("UPDATE environment_operations SET state='failed',result=? WHERE id=?", JSON.stringify({ error: error.message }), op.id);
      throw error;
    }
  }
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    if (!url.pathname.startsWith('/api/environments')) return undefined;
    if (url.pathname === '/api/environments' && method === 'GET') {
      const clauses = [scope(user, 'r.id').sql], args = [...scope(user, 'r.id').args];
      for (const [key, column] of [['repository_id','r.id'],['account_id','r.account_id'],['owner_id','r.owner_id']]) {
        const value = url.searchParams.get(key!); if (value) { if (key === 'repository_id') repository(this.store, user, value); clauses.push(`${column}=?`); args.push(value); }
      }
      return { environments: this.store.all(`SELECT r.id AS repository_id,r.full_name,r.account_id,r.owner_id,p.enabled,
        e.generation,COALESCE(e.state,CASE WHEN p.enabled=1 THEN 'provisioning' ELSE 'stopped' END) AS state,e.desired,e.error,e.started_at,
        EXISTS(SELECT 1 FROM environment_operations o WHERE o.repository_id=r.id AND o.state='pending') AS operation_pending
        FROM repositories r JOIN policies p ON p.repository_id=r.id LEFT JOIN project_environments e ON e.repository_id=r.id
        WHERE ${clauses.join(' AND ')} ORDER BY r.full_name`, ...args) };
    }
    const match = /^\/api\/environments\/([^/]+)(?:\/(start|stop|reset|delete))?$/.exec(url.pathname);
    if (!match) return fail(404, 'not_found');
    const id = match[1]!; repository(this.store, user, id);
    if (!match[2] && method === 'GET') return { environment: this.store.get('SELECT * FROM project_environments WHERE repository_id=?', id) || { repository_id: id, state: 'provisioning' } };
    if (method !== 'POST' || !match[2]) return fail(404, 'not_found');
    fields(input, ['operation_id','generation','confirm']);
    if (!/^[a-f0-9]{48}$/.test(String(input.operation_id || '')) || !Number.isSafeInteger(input.generation)) fail(400, 'invalid_operation');
    if (match[2] === 'delete') { superAdmin(user); if (input.confirm !== true) fail(400, 'confirmation_required'); }
    const previous = this.store.get('SELECT * FROM environment_operations WHERE id=?', String(input.operation_id));
    const payload = JSON.stringify({ operation_id: input.operation_id, generation: input.generation });
    if (previous && (previous.repository_id !== id || previous.action !== match[2] || previous.input !== payload)) fail(409, 'operation_id_conflict');
    if (!previous && this.store.get("SELECT 1 FROM environment_operations WHERE repository_id=? AND state='pending'", id)) fail(409, 'environment_operation_pending');
    const state = await this.manager.call('GET', '/v1/projects/' + id) || await this.manager.call('PUT', '/v1/projects/' + id);
    this.save(state);
    if (!previous && input.generation !== state.generation) fail(409, 'stale_generation');
    this.store.transaction(() => {
      if (!previous) {
        this.store.run("INSERT INTO environment_operations VALUES(?,?,?,?,'pending',NULL)", String(input.operation_id), id, match[2]!, payload);
        this.store.audit(user.id, 'environment.' + match[2], String(input.operation_id), id);
        if (match[2] === 'start' || match[2] === 'reset') this.store.run('UPDATE policies SET enabled=1 WHERE repository_id=?', id);
        else this.store.run('UPDATE policies SET enabled=0 WHERE repository_id=?', id);
      }
    });
    return { environment: await this.send(this.store.get('SELECT * FROM environment_operations WHERE id=?', String(input.operation_id))!) };
  }
}
