import type { Store, Row } from '../storage/database.js';
import { digest, fail, randomId } from '../core/security.js';
import { identityProjection, projectCapabilities } from './storage.js';
import { readInstallationDomainEvents } from '../installations/archive.js';

export interface ActorContext {
  principal_id: string; tenant_id: string | null; project_id?: string; channel: 'web' | 'api' | 'im' | 'service';
  capabilities: string[]; authorization_revision: number; request_id: string;
}
export interface EffectiveScope {
  grant_id: string; tenant_id: string | null; project_id: string | null; scope: string; role: string;
  capabilities: string[]; source: string; verified_at: number; expires_at: number | null; state: string;
}
// Object identity is the trust boundary. Deserializing an ActorContext never creates an authenticated actor.
const issued = new WeakMap<ActorContext, { store: Store; session?: string; guard?: () => void; parent?: ActorContext; allowedCapabilities?: string[] }>();
/** Trusted background work can attenuate authority; this never creates or expands a grant. */
export function narrowActor(actor: ActorContext, capabilities: string[]): ActorContext {
  assertCurrent(actor);
  const trust = issued.get(actor)!;
  const allowed = capabilities.filter(c => !trust.allowedCapabilities || trust.allowedCapabilities.includes(c));
  const narrowed = Object.freeze({ ...actor, capabilities: Object.freeze([...allowed]) as unknown as string[] });
  issued.set(narrowed, { store: trust.store, parent: actor, allowedCapabilities: allowed }); return narrowed;
}
// Trusted adapters attach a live credential/connector fence; narrowing scope preserves it.
export function restrictActor(actor: ActorContext, guard: () => void): ActorContext {
  const trust = issued.get(actor); if (!trust) return fail(403, 'untrusted_actor');
  const previous = trust.guard; trust.guard = () => { previous?.(); guard(); }; return actor;
}
export function revision(store: Store, principal: string): number {
  return Number(store.get(`SELECT authorization_revision FROM principals p WHERE id=? AND active=1
    AND (kind='service' OR EXISTS(SELECT 1 FROM users u WHERE u.id=p.user_id AND u.active=1))`, principal)?.authorization_revision || 0);
}
export function invalidate(store: Store, principal: string, reason: string): void {
  store.run('UPDATE principals SET authorization_revision=authorization_revision+1 WHERE id=?', principal);
  store.run('INSERT INTO authorization_events(principal_id,reason,created_at) VALUES(?,?,?)', principal, reason, Date.now());
}
export function consumeInstallationChanges(store: Store): void {
  let cursor = Number(store.get("SELECT sequence FROM identity_cursors WHERE name='installations'")!.sequence);
  for (;;) {
    const batch = readInstallationDomainEvents(store, cursor, 1000); if (!batch.length) break;
    store.transaction(() => {
      for (const { sequence, event } of batch) {
        const ref = `${event.installation.github_host}/${event.installation.app_id}/${event.installation.installation_id}`;
        for (const p of store.all("SELECT DISTINCT principal_id FROM scoped_grants WHERE installation_ref=? AND source='github_derived' AND revoked_at IS NULL", ref))
          invalidate(store, p.principal_id, event.type);
        cursor = sequence;
      }
      store.run("UPDATE identity_cursors SET sequence=? WHERE name='installations'", cursor);
    });
  }
}
export function listEffectiveScopes(store: Store, principal: string): EffectiveScope[] {
  const user = store.get('SELECT u.role FROM users u JOIN principals p ON p.user_id=u.id WHERE p.id=? AND p.active=1 AND u.active=1', principal);
  if (!revision(store, principal)) return [];
  const result: EffectiveScope[] = user?.role === 'super_admin' ? [{ grant_id: 'platform', tenant_id: null, project_id: null, scope: 'platform', role: 'super_admin',
    capabilities: ['*'], source: 'explicit_delegation', verified_at: 0, expires_at: null, state: 'active' }] : [];
  for (const g of store.all('SELECT * FROM scoped_grants WHERE principal_id=?', principal)) {
    let state = g.revoked_at ? 'revoked' : g.expires_at !== null && g.expires_at <= Date.now() ? 'pending_verification' : 'active';
    if (g.source === 'github_derived' && state === 'active') {
      const installation = store.get('SELECT * FROM github_installations WHERE ref=?', g.installation_ref);
      const identity = store.get("SELECT 1 FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", principal);
      if (!identity || !installation || installation.status !== 'active' || installation.scope_pending || installation.revision !== g.installation_revision) state = 'pending_verification';
    }
    if (!g.tenant_id || !store.get('SELECT 1 FROM tenants WHERE id=?', g.tenant_id)) state = 'quarantined';
    result.push({ grant_id: g.id, tenant_id: g.tenant_id, project_id: g.project_id, scope: g.scope, role: g.role,
      capabilities: JSON.parse(g.capabilities), source: g.source, verified_at: g.verified_at, expires_at: g.expires_at, state });
  }
  return result;
}
export function resolveActor(store: Store, sessionRef: string, options: { channel?: ActorContext['channel']; project_id?: string } = {}): ActorContext {
  identityProjection(store); consumeInstallationChanges(store);
  const s = store.get(`SELECT s.*,p.id AS principal_id FROM sessions s JOIN users u ON u.id=s.user_id JOIN principals p ON p.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND p.active=1`, digest(sessionRef), Date.now());
  if (!s) return fail(401, 'login_required');
  let tenant = s.tenant_id as string | null;
  if (options.project_id) {
    const p = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', options.project_id);
    if (!p?.tenant_id || tenant && tenant !== p.tenant_id) return fail(403, 'tenant_forbidden');
    tenant = p.tenant_id;
  }
  const scopes = listEffectiveScopes(store, s.principal_id).filter(g => g.state === 'active' && (!tenant || !g.tenant_id || g.tenant_id === tenant));
  const actor: ActorContext = { principal_id: s.principal_id, tenant_id: tenant, ...(options.project_id ? { project_id: options.project_id } : {}),
    channel: options.channel || 'web', capabilities: [...new Set(scopes.flatMap(g => g.capabilities))], authorization_revision: revision(store, s.principal_id), request_id: randomId() };
  issued.set(actor, { store, session: digest(sessionRef) }); return Object.freeze(actor);
}
export function assertCurrent(actor: ActorContext): void {
  const trusted = issued.get(actor); if (!trusted) return fail(403, 'untrusted_actor');
  const { store } = trusted;
  if (trusted.parent) assertCurrent(trusted.parent);
  trusted.guard?.();
  // Installation projections are also checked below; a worker need not have consumed an event yet.
  if (revision(store, actor.principal_id) !== actor.authorization_revision) fail(409, 'authorization_changed');
  const principal = store.get('SELECT kind,maintenance,project_id,tenant_id FROM principals WHERE id=?', actor.principal_id);
  if (principal?.kind === 'service' && (!principal.maintenance || !store.get('SELECT 1 FROM identity_projects WHERE project_id=? AND tenant_id=?', principal.project_id, principal.tenant_id))) fail(403, 'service_paused');
  if (trusted.session && !store.get('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?', trusted.session, Date.now())) fail(401, 'login_required');
}
export function authorize(actor: ActorContext, capability: string, resource: { tenant_id?: string | null; project_id?: string } = {}): void {
  assertCurrent(actor);
  const { store } = issued.get(actor)!;
  const permitted = issued.get(actor)!.allowedCapabilities;
  if (permitted && !permitted.includes(capability)) fail(403, 'capability_forbidden');
  let tenant = resource.tenant_id || actor.tenant_id;
  const project = resource.project_id || actor.project_id;
  if (project) {
    const row = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project);
    if (!row?.tenant_id || tenant && tenant !== row.tenant_id) return fail(403, 'tenant_forbidden');
    tenant = row.tenant_id;
  }
  if (actor.tenant_id && tenant !== actor.tenant_id) fail(403, 'tenant_forbidden');
  if (!matchingGrants(store, listEffectiveScopes(store, actor.principal_id), capability, tenant, project).length) fail(403, 'capability_forbidden');
}
// Permission summaries and request authorization share the same scope and installation checks.
function matchingGrants(store: Store, scopes: EffectiveScope[], capability: string, tenant: string | null, project?: string): EffectiveScope[] {
  return scopes.filter(g => g.state === 'active' &&
    (g.scope === 'platform' || !!tenant && g.tenant_id === tenant && (g.scope === 'tenant' || !!project && g.project_id === project)) &&
    (g.capabilities.includes('*') || g.capabilities.includes(capability)) &&
    // An owner-wide derived grant is bounded by the current installation, including projects synchronized later.
    (g.source !== 'github_derived' || !project || !!store.get(`SELECT 1 FROM installation_repositories r JOIN scoped_grants s ON s.installation_ref=r.installation_ref
      WHERE s.id=? AND r.repository_id=? AND r.present=1`, g.grant_id, project)));
}
export function listEffectiveProjectAccess(store: Store, principal: string): { id: string; full_name: string; sources: string[]; can_configure: boolean }[] {
  const scopes = listEffectiveScopes(store, principal);
  return store.all(`SELECT r.id,r.full_name,p.tenant_id FROM repositories r JOIN identity_projects p ON p.project_id=r.id
    WHERE p.tenant_id IS NOT NULL ORDER BY r.full_name`).flatMap(project => {
    const grants = matchingGrants(store, scopes, 'tasks.read', project.tenant_id, project.id);
    const configuration = matchingGrants(store, scopes, 'config.write', project.tenant_id, project.id);
    return grants.length ? [{ id: project.id, full_name: project.full_name, sources: [...new Set([...grants, ...configuration].map(g => g.source))],
      can_configure: configuration.length > 0 }] : [];
  });
}
export function effectiveRepositories(store: Store, actor: ActorContext): string[] {
  return store.all('SELECT project_id FROM identity_projects WHERE tenant_id IS NOT NULL').flatMap(r => {
    try { authorize(actor, 'tasks.read', { project_id: r.project_id }); return [r.project_id as string]; } catch { return []; }
  });
}
export function refreshSessionRevision(store: Store, token: string): void {
  store.run('UPDATE sessions SET authorization_revision=(SELECT authorization_revision FROM principals WHERE user_id=sessions.user_id) WHERE token_hash=?', digest(token));
}
export function assertSessionWrite(store: Store, token: string, actor: ActorContext): void {
  assertCurrent(actor);
  const s = store.get('SELECT authorization_revision FROM sessions WHERE token_hash=?', digest(token));
  if (s?.authorization_revision !== actor.authorization_revision) fail(409, 'authorization_changed');
}
export function createProjectServicePrincipal(store: Store, actor: ActorContext, project: string, maintenance: string): string {
  authorize(actor, 'grants.manage', { project_id: project });
  if (!maintenance.trim()) return fail(400, 'maintenance_required');
  const tenant = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id, id = randomId();
  store.transaction(() => {
    store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service',?,?,?)", id, project, tenant, maintenance);
    store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
      VALUES(?,?,?,?,'project','service',?,'explicit_delegation',?,'tenant_maintained','project automation',?)`, randomId(), id, tenant, project,
      JSON.stringify(projectCapabilities), actor.principal_id, Date.now());
    store.audit(actor.principal_id, 'service_principal.created', id, project);
  }); return id;
}
// Trusted in-process workers hold the service principal ID, never a creator's OAuth credential.
export function resolveServiceActor(store: Store, principal: string): ActorContext {
  const row = store.get("SELECT * FROM principals WHERE id=? AND kind='service' AND active=1 AND maintenance<>''", principal);
  if (!row || !store.get('SELECT 1 FROM identity_projects WHERE project_id=? AND tenant_id=?', row.project_id, row.tenant_id)) return fail(403, 'service_paused');
  const actor: ActorContext = { principal_id: principal, tenant_id: row.tenant_id, project_id: row.project_id, channel: 'service', capabilities: [],
    authorization_revision: row.authorization_revision, request_id: randomId() };
  issued.set(actor, { store });
  const candidates = [...new Set(listEffectiveScopes(store, principal).filter(g => g.state === 'active').flatMap(g => g.capabilities))];
  actor.capabilities = candidates.filter(capability => {
    try { authorize(actor, capability); return true; }
    catch (error) { if ((error as any).code === 'capability_forbidden') return false; throw error; }
  });
  return Object.freeze(actor);
}
// For trusted asynchronous workers/adapters. This function is never exposed as an HTTP/model tool.
export function resolvePrincipalActor(store: Store, principal: string, tenant: string | null, project?: string, channel: ActorContext['channel'] = 'api', parent?: ActorContext): ActorContext {
  if (parent) { assertCurrent(parent); if (parent.principal_id !== principal) fail(403, 'principal_mismatch'); }
  identityProjection(store); consumeInstallationChanges(store);
  if (!revision(store, principal)) return fail(403, 'principal_inactive');
  if (project) {
    const target = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project);
    if (!target?.tenant_id || tenant && tenant !== target.tenant_id) return fail(403, 'tenant_forbidden');
    tenant = target.tenant_id;
  }
  const scopes = listEffectiveScopes(store, principal).filter(g => g.state === 'active' && (!tenant || !g.tenant_id || g.tenant_id === tenant));
  const actor: ActorContext = { principal_id: principal, tenant_id: tenant, ...(project ? { project_id: project } : {}), channel,
    capabilities: [...new Set(scopes.flatMap(s => s.capabilities))], authorization_revision: revision(store, principal), request_id: randomId() };
  issued.set(actor, { store, parent }); return Object.freeze(actor);
}
export function migrationReport(store: Store): Row[] { return store.all('SELECT version,applied_at,report FROM identity_migrations'); }
