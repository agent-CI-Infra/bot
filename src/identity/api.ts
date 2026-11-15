import type { Store } from '../storage/database.js';
import { repository, superAdmin, type Actor } from '../app/auth.js';
import { digest, fail, fields, HttpError, randomId, text, type Json } from '../core/security.js';
import { activeScopes, authorize, createProjectServicePrincipal, invalidateIfLost, listEffectiveScopes, migrationReport, type ActorContext } from './authorization.js';
import { projectCapabilities, explicitDelegationCapabilities } from './storage.js';
import { revokeIdentity } from './bindings.js';
import { githubConnection } from './github-status.js';

// A grant names two people: the holder and, when one was recorded, the person who granted it. Both resolve the same
// way — verified GitHub identity first, then local username, then the raw id — so the console never guesses at one.
function personName(store: Store, principalId: string | null | undefined): string | null {
  if (!principalId) return null;
  return store.get("SELECT display_name FROM external_identities WHERE principal_id=? AND provider='github'", principalId)?.display_name ||
    store.get('SELECT username FROM users WHERE id=?', principalId)?.username || principalId;
}
// Only an authorization refusal means "no"; anything else still propagates.
function permitted(check: () => void): boolean {
  try { check(); return true; } catch (error) { if (error instanceof HttpError && error.status === 403) return false; throw error; }
}
// The account that signed in with this GitHub login (#847), so a project administrator can name whom to delegate to
// without reading the platform's user list. The login is matched as GitHub last reported it.
function githubAccount(store: Store, login: string): string {
  const rows = store.all("SELECT DISTINCT principal_id FROM external_identities WHERE provider='github' AND status<>'revoked' AND lower(display_name)=lower(?)", login.replace(/^@/, ''));
  if (rows.length > 1) return fail(409, 'github_login_ambiguous', 'github_login');
  return rows[0]?.principal_id ?? fail(404, 'principal_not_found', 'github_login');
}
/**
 * Who may delegate inside a project (#847): super administrators (grants.manage) anywhere, and a project administrator
 * (config.write there) for that project only, never for a whole organization. Returns whether the actor is a super
 * administrator, whose grants stand on their own; a project administrator's last only while they still hold what they gave.
 */
function delegator(context: ActorContext, tenant: string, project: string | undefined): boolean {
  if (permitted(() => authorize(context, 'grants.manage', { tenant_id: tenant, project_id: project }))) return true;
  if (!project) return fail(403, 'organization_delegation_forbidden');
  authorize(context, 'config.write', { tenant_id: tenant, project_id: project });
  return false;
}

export function identityApi(store: Store, user: Actor, token: string, method: string, url: URL, body: Json): Json | undefined {
  const path = url.pathname, context = user.context!;
  const members = /^\/api\/repositories\/([^/]+)\/members$/.exec(path);
  if (members && method === 'GET') {
    const project = members[1]!;
    repository(store, user, project);
    authorize(context, 'config.write', { project_id: project });
    const tenant = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id;
    // A tenant-wide GitHub grant only covers repositories still present in that installation.
    // What this viewer may delegate here (#847): a super administrator anything, a project administrator what they hold.
    const manager = permitted(() => authorize(context, 'grants.manage', { tenant_id: tenant, project_id: project }));
    const delegable = projectCapabilities.filter(capability => manager || permitted(() => authorize(context, capability, { project_id: project })));
    const grants = store.all(`SELECT g.id,g.principal_id,g.scope,g.role,g.source,g.policy,g.grantor_id,g.capabilities AS granted,g.verified_at,g.expires_at
      FROM scoped_grants g WHERE g.tenant_id=? AND (g.project_id=? OR g.scope='tenant')
      AND (g.source<>'github_derived' OR EXISTS(SELECT 1 FROM installation_repositories r
        WHERE r.installation_ref=g.installation_ref AND r.repository_id=? AND r.present=1)) ORDER BY g.principal_id,g.id`, tenant, project, project)
      .map(({ granted, ...g }) => {
        const scope = listEffectiveScopes(store, g.principal_id).find(s => s.grant_id === g.id);
        const revocable = g.source === 'explicit_delegation' && g.scope === 'project' && ['independent', 'project_delegation'].includes(g.policy) && scope?.state !== 'revoked'
          && (manager || (JSON.parse(granted) as string[]).every(capability => delegable.includes(capability)));
        return { ...g, state: scope?.state || 'inactive', capabilities: scope?.capabilities || [], ...(scope?.reason ? { reason: scope.reason } : {}),
          principal_name: store.get("SELECT display_name FROM external_identities WHERE principal_id=? AND provider='github' ORDER BY verified_at DESC LIMIT 1", g.principal_id)?.display_name ||
            store.get('SELECT username FROM users WHERE id=?', g.principal_id)?.username || g.principal_id,
          grantor_name: personName(store, g.grantor_id), can_revoke: revocable };
      });
    let canManageLegacy = false;
    try { superAdmin(user); canManageLegacy = true; } catch { /* Source-specific writes remain platform-only. */ }
    return { grants, tenant_id: tenant, can_manage_legacy: canManageLegacy, can_delegate: true, delegable_capabilities: delegable, read_at: Date.now() };
  }
  if (path === '/api/identity' && method === 'GET') {
    const scopes = listEffectiveScopes(store, context.principal_id), platform = scopes.some(s => s.scope === 'platform');
    const tenants = store.all('SELECT * FROM tenants').filter(t => platform || scopes.some(s => s.tenant_id === t.id && s.state === 'active'));
    return { actor: context, tenants, scopes,
      identities: store.all('SELECT id,provider,host,display_name,status,verified_at FROM external_identities WHERE principal_id=?', context.principal_id),
      github_connection: githubConnection(store, context.principal_id, { visible: user.repositories, tenant: context.tenant_id }) };
  }
  if (path === '/api/identity/tenant' && method === 'POST') {
    fields(body, ['tenant_id']); const tenant = body.tenant_id === null ? null : text(body.tenant_id);
    const scopes = listEffectiveScopes(store, context.principal_id);
    if (tenant !== null && !scopes.some(s => s.state === 'active' && (s.scope === 'platform' || s.tenant_id === tenant))) return fail(403, 'tenant_forbidden');
    if (tenant && !store.get('SELECT 1 FROM tenants WHERE id=?', tenant)) return fail(404, 'tenant_not_found');
    store.run('UPDATE sessions SET tenant_id=? WHERE token_hash=?', tenant, digest(token));
    store.audit(user.id, 'tenant.selected', tenant || 'platform'); return { ok: true };
  }
  const unlink = /^\/api\/identity\/bindings\/([^/]+)$/.exec(path);
  if (unlink && method === 'DELETE') {
    fields(body, []);
    store.transaction(() => revokeIdentity(store, context.principal_id, unlink[1]!));
    return { ok: true };
  }
  if (path === '/api/identity/migration' && method === 'GET') {
    authorize(context, 'platform.manage'); return { migrations: migrationReport(store), quarantine: store.all('SELECT * FROM identity_quarantine') };
  }
  if (path === '/api/identity/service-principals' && method === 'POST') {
    fields(body, ['project_id', 'maintenance']);
    return { principal_id: createProjectServicePrincipal(store, context, text(body.project_id), text(body.maintenance)) };
  }
  if (path === '/api/identity/grants') {
    if (method === 'GET') {
      const tenant = text(url.searchParams.get('tenant_id'));
      authorize(context, 'config.write', { tenant_id: tenant });
      return { grants: store.all('SELECT id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,evidence,verified_at,expires_at,revoked_at FROM scoped_grants WHERE tenant_id=?', tenant)
        .map(g => ({ ...g, capabilities: JSON.parse(g.capabilities),
          principal_name: personName(store, g.principal_id), grantor_name: personName(store, g.grantor_id),
          state: listEffectiveScopes(store, g.principal_id).find(s => s.grant_id === g.id)?.state || 'revoked' })) };
    }
    if (method === 'POST') {
      fields(body, ['principal_id', 'github_login', 'tenant_id', 'project_id', 'capabilities']);
      const tenant = text(body.tenant_id), project = body.project_id === undefined ? undefined : text(body.project_id);
      const manager = delegator(context, tenant, project);
      if ((body.principal_id === undefined) === (body.github_login === undefined)) return fail(400, 'principal_required');
      const principal = body.github_login !== undefined ? githubAccount(store, text(body.github_login, 100)) : text(body.principal_id);
      if (principal === context.principal_id) return fail(403, 'self_delegation_forbidden');
      // A project administrator delegates to people; project automation stays with super administrators.
      if (!store.get(`SELECT 1 FROM principals WHERE id=? AND active=1${manager ? '' : " AND kind='human'"}`, principal)) return fail(404, 'principal_not_found');
      if (!store.get('SELECT 1 FROM tenants WHERE id=?', tenant)) return fail(404, 'tenant_not_found');
      const grantable = [...projectCapabilities, ...explicitDelegationCapabilities];
      if (!Array.isArray(body.capabilities) || !body.capabilities.length || body.capabilities.some(c => !grantable.includes(String(c)))) return fail(400, 'invalid_capabilities');
      // Grant managers can configure an opt-in capability without themselves holding that capability. Every other
      // capability, and for a project administrator every capability, requires the grantor's own effective permission.
      for (const capability of body.capabilities) if (!manager || !explicitDelegationCapabilities.includes(String(capability))) authorize(context, String(capability), { tenant_id: tenant, project_id: project });
      const id = randomId();
      store.transaction(() => {
        store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
          VALUES(?,?,?,?,?,'delegated',?,'explicit_delegation',?,?,'console delegation',?)`, id, principal, tenant, project || null, project ? 'project' : 'tenant',
          JSON.stringify(body.capabilities), context.principal_id, manager ? 'independent' : 'project_delegation', Date.now());
        // Added authority leaves the authorization revision alone (#521).
        store.audit(user.id, 'delegation.created', id, project || null);
      }); return { grant_id: id };
    }
  }
  const revoke = /^\/api\/identity\/grants\/([^/]+)$/.exec(path);
  if (revoke && method === 'DELETE') {
    fields(body, []); const grant = store.get('SELECT * FROM scoped_grants WHERE id=?', revoke[1]!);
    if (!grant) return fail(404, 'grant_not_found');
    const manager = delegator(context, grant.tenant_id, grant.project_id || undefined);
    if (grant.source !== 'explicit_delegation' || grant.policy === 'legacy') return fail(409, 'use_source_revocation');
    // A project administrator revokes people's delegations in their project, and only those within what they hold there (#847).
    if (!manager) {
      if (!['independent', 'project_delegation'].includes(grant.policy)) return fail(409, 'use_source_revocation');
      for (const capability of JSON.parse(grant.capabilities) as string[]) authorize(context, capability, { tenant_id: grant.tenant_id, project_id: grant.project_id });
    }
    store.transaction(() => {
      const before = activeScopes(store, grant.principal_id);
      store.run('UPDATE scoped_grants SET revoked_at=? WHERE id=?', Date.now(), grant.id);
      invalidateIfLost(store, grant.principal_id, before, 'delegation.revoked'); store.audit(user.id, 'delegation.revoked', grant.id, grant.project_id);
    }); return { ok: true };
  }
  return undefined;
}
