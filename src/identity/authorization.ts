import type { Store, Row } from '../storage/database.js';
import { digest, fail, randomId } from '../core/security.js';
import { identityProjection, projectCapabilities } from './storage.js';
import { readInstallationDomainEvents } from '../installations/archive.js';

export interface ActorContext {
  principal_id: string; tenant_id: string | null; project_id?: string; channel: 'web' | 'api' | 'im' | 'service';
  capabilities: string[]; authorization_revision: number; request_id: string;
}
// Why a grant is not usable yet, for the three conditions a client can act on differently. Additive: a
// grant that is `pending_verification` for any other reason (an expired grant, or no active GitHub proof)
// carries no `reason`, and a client falls back to its combined wording exactly as before.
export type ScopeReason = 'installation_pending' | 'permission_pending' | 'tenant_missing';
export interface EffectiveScope {
  grant_id: string; tenant_id: string | null; project_id: string | null; scope: string; role: string;
  capabilities: string[]; source: string; verified_at: number; expires_at: number | null; state: string;
  reason?: ScopeReason;
}
// Object identity is the trust boundary. Deserializing an ActorContext never creates an authenticated actor.
// `confined` names the only tenant whose grants count (see confineActor); every actor derived from a confined one inherits it.
interface Trust {
  store: Store; session?: string; guard?: () => void; parent?: ActorContext; allowedCapabilities?: string[]; confined?: string;
  /** Present on console actors: one resolved from a browser session, and actors narrowed or confined from it. */
  reliance?: Reliance;
}
/**
 * A console request is judged by the authority it holds now, not by the authorization revision it started with (#521).
 * Each successful check is remembered; once the principal's revision moves (it lost some authority), the next guard
 * replays them, so the request stops only if something it relied on is gone. Background actors keep the revision fence.
 */
interface Reliance { revision: number; platform: boolean; checks: Map<string, () => void> }
const issued = new WeakMap<ActorContext, Trust>();
// A derived console actor records its own checks; its parent's are replayed through `parent`.
const derivedReliance = (trust: Trust): Pick<Trust, 'reliance'> => trust.reliance ? { reliance: { revision: trust.reliance.revision, platform: false, checks: new Map() } } : {};
/** Trusted background work can attenuate authority; this never creates or expands a grant. */
export function narrowActor(actor: ActorContext, capabilities: string[]): ActorContext {
  assertCurrent(actor);
  const trust = issued.get(actor)!;
  const allowed = capabilities.filter(c => !trust.allowedCapabilities || trust.allowedCapabilities.includes(c));
  const narrowed = Object.freeze({ ...actor, capabilities: Object.freeze([...allowed]) as unknown as string[] });
  issued.set(narrowed, { store: trust.store, parent: actor, allowedCapabilities: allowed, ...(trust.confined ? { confined: trust.confined } : {}), ...derivedReliance(trust) }); return narrowed;
}
/**
 * Authority that arrives through an organization's own Feishu app (#424) stays inside that organization: only the
 * principal's grants in that tenant count, never a platform grant and never another tenant. The tenant's Feishu
 * administrators can take over its member accounts, so nothing beyond the tenant may be reachable through its app.
 */
export function confineActor(actor: ActorContext, tenant: string): ActorContext {
  assertCurrent(actor);
  const trust = issued.get(actor)!;
  if (actor.tenant_id && actor.tenant_id !== tenant || trust.confined && trust.confined !== tenant) return fail(403, 'tenant_forbidden');
  if (actor.project_id && trust.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', actor.project_id)?.tenant_id !== tenant) return fail(403, 'tenant_forbidden');
  const capabilities = confinedScopes(listEffectiveScopes(trust.store, actor.principal_id), tenant).filter(g => g.state === 'active').flatMap(g => g.capabilities)
    .filter(c => !trust.allowedCapabilities || trust.allowedCapabilities.includes(c));
  const confined = Object.freeze({ ...actor, tenant_id: tenant, capabilities: Object.freeze([...new Set(capabilities)]) as unknown as string[] });
  issued.set(confined, { store: trust.store, parent: actor, allowedCapabilities: trust.allowedCapabilities, confined: tenant, ...derivedReliance(trust) }); return confined;
}
/** The tenant an actor is confined to, or null when its principal's whole authority applies. */
export function confinedTenant(actor: ActorContext): string | null { return issued.get(actor)?.confined ?? null; }
const confinedScopes = (scopes: EffectiveScope[], tenant?: string) => tenant ? scopes.filter(g => g.scope !== 'platform' && g.tenant_id === tenant) : scopes;
// Trusted adapters attach a live credential/connector fence; narrowing scope preserves it.
export function restrictActor(actor: ActorContext, guard: () => void): ActorContext {
  const trust = issued.get(actor); if (!trust) return fail(403, 'untrusted_actor');
  const previous = trust.guard; trust.guard = () => { previous?.(); guard(); }; return actor;
}
export function revision(store: Store, principal: string): number {
  return Number(store.get(`SELECT authorization_revision FROM principals p WHERE id=? AND active=1
    AND (kind='service' OR EXISTS(SELECT 1 FROM users u WHERE u.id=p.user_id AND u.active=1))`, principal)?.authorization_revision || 0);
}
/**
 * Raises the principal's authorization revision. The revision counts only lost authority: it fences background content
 * (management history, queued channel messages, timers) and makes in-flight console requests recheck what they relied on.
 * Call it only for a change that removes authority; for a change that may also keep or add some, use `invalidateIfLost`.
 */
export function invalidate(store: Store, principal: string, reason: string): void {
  store.run('UPDATE principals SET authorization_revision=authorization_revision+1 WHERE id=?', principal);
  store.run('INSERT INTO authorization_events(principal_id,reason,created_at) VALUES(?,?,?)', principal, reason, Date.now());
}
/** The scopes a principal can use now; revoked, expired and unverified grants never count. */
export function activeScopes(store: Store, principal: string): EffectiveScope[] {
  return listEffectiveScopes(store, principal).filter(g => g.state === 'active');
}
// Whether some capability of `held` is no longer covered by any scope the principal can use now. Coverage, not grant IDs:
// a renewed or replaced grant, or a platform role that already covers a project, loses nothing.
function lostAuthority(store: Store, principal: string, held: EffectiveScope[]): boolean {
  if (!held.length) return false;
  const now = activeScopes(store, principal);
  return held.some(g => g.capabilities.some(capability => !now.some(scope => grantMatches(store, scope, capability,
    g.scope === 'platform' ? null : g.tenant_id, g.scope === 'project' ? g.project_id ?? undefined : undefined))));
}
/** Raises the revision only if the principal lost authority it held in `before` (from `activeScopes`); keeping or adding authority never does. */
export function invalidateIfLost(store: Store, principal: string, before: EffectiveScope[], reason: string): boolean {
  const lost = lostAuthority(store, principal, before);
  if (lost) invalidate(store, principal, reason);
  return lost;
}
export function consumeInstallationChanges(store: Store): void {
  let cursor = Number(store.get("SELECT sequence FROM identity_cursors WHERE name='installations'")!.sequence);
  for (;;) {
    const batch = readInstallationDomainEvents(store, cursor, 1000); if (!batch.length) break;
    store.transaction(() => {
      const counted = new Set<string>(), now = Date.now();
      for (const { sequence, event } of batch) {
        const ref = `${event.installation.github_host}/${event.installation.app_id}/${event.installation.installation_id}`;
        const version = Number.isSafeInteger(event.projection_version) ? event.projection_version : Number.MAX_SAFE_INTEGER;
        // A derived grant proved against an older installation revision stops counting (listEffectiveScopes). Only one that
        // was still usable is a loss; one already expired was lost before, and a grant counts once per batch.
        const stale = new Map<string, EffectiveScope[]>();
        for (const g of store.all(`SELECT * FROM scoped_grants WHERE installation_ref=? AND source='github_derived' AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at>?) AND installation_revision<?`, ref, now, version)) {
          if (counted.has(g.id)) continue; counted.add(g.id);
          stale.set(g.principal_id, [...stale.get(g.principal_id) ?? [], { grant_id: g.id, tenant_id: g.tenant_id, project_id: g.project_id, scope: g.scope, role: g.role,
            capabilities: JSON.parse(g.capabilities), source: g.source, verified_at: g.verified_at, expires_at: g.expires_at, state: 'active' }]);
        }
        for (const [principal, held] of stale) if (lostAuthority(store, principal, held)) invalidate(store, principal, event.type);
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
    let reason: ScopeReason | undefined;
    if (g.source === 'github_derived' && state === 'active') {
      const installation = store.get('SELECT * FROM github_installations WHERE ref=?', g.installation_ref);
      const identity = store.get("SELECT 1 FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", principal);
      if (!identity || !installation || installation.status !== 'active' || installation.scope_pending || installation.revision !== g.installation_revision) state = 'pending_verification';
      // Reauthentication comes first when GitHub proof is missing, even if the installation also changed.
      if (state === 'pending_verification' && identity)
        reason = !installation || installation.revision !== g.installation_revision ? 'installation_pending'
          : installation.status !== 'active' || installation.scope_pending ? 'permission_pending' : undefined;
    }
    if (!g.tenant_id || !store.get('SELECT 1 FROM tenants WHERE id=?', g.tenant_id)) { state = 'quarantined'; reason = 'tenant_missing'; }
    result.push({ grant_id: g.id, tenant_id: g.tenant_id, project_id: g.project_id, scope: g.scope, role: g.role,
      capabilities: JSON.parse(g.capabilities), source: g.source, verified_at: g.verified_at, expires_at: g.expires_at, state,
      ...(reason ? { reason } : {}) });
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
  issued.set(actor, { store, session: digest(sessionRef),
    reliance: { revision: actor.authorization_revision, platform: scopes.some(g => g.scope === 'platform'), checks: new Map() } });
  return Object.freeze(actor);
}
export function assertCurrent(actor: ActorContext): void {
  const trusted = issued.get(actor); if (!trusted) return fail(403, 'untrusted_actor');
  const { store, reliance } = trusted;
  if (trusted.parent) assertCurrent(trusted.parent);
  trusted.guard?.();
  // Installation projections are also checked below; a worker need not have consumed an event yet.
  const current = revision(store, actor.principal_id);
  // A disabled account or principal reads as revision 0, which ends a console request as it would a new one.
  if (reliance) { if (!current) fail(401, 'login_required'); }
  else if (current !== actor.authorization_revision) fail(409, 'authorization_changed');
  const principal = store.get('SELECT kind,maintenance,project_id,tenant_id FROM principals WHERE id=?', actor.principal_id);
  // A project service principal stays inside its project. A group binding's principal spans several projects
  // (project_id NULL); each of its scoped grants is still checked against its own project or organization.
  if (principal?.kind === 'service' && (!principal.maintenance || principal.project_id !== null && !store.get('SELECT 1 FROM identity_projects WHERE project_id=? AND tenant_id=?', principal.project_id, principal.tenant_id))) fail(403, 'service_paused');
  if (trusted.session && !store.get('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?', trusted.session, Date.now())) fail(401, 'login_required');
  if (reliance && reliance.revision !== current) {
    // Legacy console code branches on the role read when the request began, so losing the platform role ends the request.
    if (reliance.platform && !activeScopes(store, actor.principal_id).some(g => g.scope === 'platform')) fail(403, 'capability_forbidden');
    for (const check of reliance.checks.values()) check();
    reliance.revision = current;
  }
}
export function authorize(actor: ActorContext, capability: string, resource: { tenant_id?: string | null; project_id?: string } = {}): void {
  assertCurrent(actor);
  permit(actor, capability, resource);
  const { reliance } = issued.get(actor)!;
  if (reliance) {
    const target = { tenant_id: resource.tenant_id, project_id: resource.project_id };
    reliance.checks.set(JSON.stringify([capability, target.tenant_id ?? null, target.project_id ?? null]), () => permit(actor, capability, target));
  }
}
// The grant check behind `authorize`, without the freshness check and without recording a console request's reliance.
function permit(actor: ActorContext, capability: string, resource: { tenant_id?: string | null; project_id?: string }): void {
  const { store, confined } = issued.get(actor)!;
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
  if (!matchingGrants(store, confinedScopes(listEffectiveScopes(store, actor.principal_id), confined), capability, tenant, project).length) fail(403, 'capability_forbidden');
}
/** Whether the actor holds a capability over a whole tenant or over at least one of its projects, reading its grants once. */
export function holdsInTenant(actor: ActorContext, capability: string, tenant: string): boolean {
  assertCurrent(actor);
  const held = holds(actor, capability, tenant), { reliance } = issued.get(actor)!;
  if (held && reliance) reliance.checks.set(JSON.stringify(['tenant', capability, tenant]), () => { if (!holds(actor, capability, tenant)) fail(403, 'capability_forbidden'); });
  return held;
}
function holds(actor: ActorContext, capability: string, tenant: string): boolean {
  const { store, confined, allowedCapabilities } = issued.get(actor)!;
  if (allowedCapabilities && !allowedCapabilities.includes(capability) || actor.tenant_id && actor.tenant_id !== tenant) return false;
  const scopes = confinedScopes(listEffectiveScopes(store, actor.principal_id), confined);
  if (matchingGrants(store, scopes, capability, tenant).length) return true;
  return store.all('SELECT project_id FROM identity_projects WHERE tenant_id=?', tenant).some(p => (!actor.project_id || actor.project_id === p.project_id) &&
    matchingGrants(store, scopes, capability, tenant, p.project_id).length > 0);
}
// Permission summaries and request authorization share the same scope and installation checks.
function matchingGrants(store: Store, scopes: EffectiveScope[], capability: string, tenant: string | null, project?: string): EffectiveScope[] {
  return scopes.filter(g => grantMatches(store, g, capability, tenant, project));
}
function grantMatches(store: Store, g: EffectiveScope, capability: string, tenant: string | null, project?: string): boolean {
  return g.state === 'active' &&
    (g.scope === 'platform' || !!tenant && g.tenant_id === tenant && (g.scope === 'tenant' || !!project && g.project_id === project)) &&
    // Existing project administrators retain their effective task authority without
    // rewriting old grants; the narrower capability never implies project-wide write.
    (g.capabilities.includes('*') || g.capabilities.includes(capability) || capability === 'tasks.manage_own' && g.capabilities.includes('tasks.write')) &&
    // An owner-wide derived grant is bounded by the current installation, including projects synchronized later.
    (g.source !== 'github_derived' || !project || !!store.get(`SELECT 1 FROM installation_repositories r JOIN scoped_grants s ON s.installation_ref=r.installation_ref
      WHERE s.id=? AND r.repository_id=? AND r.present=1`, g.grant_id, project));
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
  // A visibility list, not something a request relies on: losing one of these projects must not end an unrelated write.
  try { assertCurrent(actor); } catch { return []; }
  return store.all('SELECT project_id FROM identity_projects WHERE tenant_id IS NOT NULL').flatMap(r => {
    try { permit(actor, 'tasks.read', { project_id: r.project_id }); return [r.project_id as string]; } catch { return []; }
  });
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
  // A scope chosen under a confined parent can only narrow inside its tenant.
  const confined = parent ? issued.get(parent)?.confined : undefined;
  if (confined) { if (tenant && tenant !== confined) return fail(403, 'tenant_forbidden'); tenant = confined; }
  if (project) {
    const target = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project);
    if (!target?.tenant_id || tenant && tenant !== target.tenant_id) return fail(403, 'tenant_forbidden');
    tenant = target.tenant_id;
  }
  const scopes = confinedScopes(listEffectiveScopes(store, principal), confined).filter(g => g.state === 'active' && (!tenant || !g.tenant_id || g.tenant_id === tenant));
  const actor: ActorContext = { principal_id: principal, tenant_id: tenant, ...(project ? { project_id: project } : {}), channel,
    capabilities: [...new Set(scopes.flatMap(s => s.capabilities))], authorization_revision: revision(store, principal), request_id: randomId() };
  issued.set(actor, { store, parent, ...(confined ? { confined } : {}) }); return Object.freeze(actor);
}
export function migrationReport(store: Store): Row[] { return store.all('SELECT version,applied_at,report FROM identity_migrations'); }
