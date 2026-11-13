import type { Store } from '../storage/database.js';
import { repository, superAdmin, type Actor } from '../app/auth.js';
import { digest, fail, fields, randomId, text, type Json } from '../core/security.js';
import { activeScopes, authorize, createProjectServicePrincipal, invalidateIfLost, listEffectiveScopes, migrationReport } from './authorization.js';
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

export function identityApi(store: Store, user: Actor, token: string, method: string, url: URL, body: Json): Json | undefined {
  const path = url.pathname, context = user.context!;
  const members = /^\/api\/repositories\/([^/]+)\/members$/.exec(path);
  if (members && method === 'GET') {
    const project = members[1]!;
    repository(store, user, project);
    authorize(context, 'config.write', { project_id: project });
    const tenant = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id;
    // A tenant-wide GitHub grant only covers repositories still present in that installation.
    const grants = store.all(`SELECT g.id,g.principal_id,g.scope,g.role,g.source,g.policy,g.verified_at,g.expires_at
      FROM scoped_grants g WHERE g.tenant_id=? AND (g.project_id=? OR g.scope='tenant')
      AND (g.source<>'github_derived' OR EXISTS(SELECT 1 FROM installation_repositories r
        WHERE r.installation_ref=g.installation_ref AND r.repository_id=? AND r.present=1)) ORDER BY g.principal_id,g.id`, tenant, project, project)
      .map(g => {
        const scope = listEffectiveScopes(store, g.principal_id).find(s => s.grant_id === g.id);
        return { ...g, state: scope?.state || 'inactive', capabilities: scope?.capabilities || [],
          principal_name: store.get("SELECT display_name FROM external_identities WHERE principal_id=? AND provider='github' ORDER BY verified_at DESC LIMIT 1", g.principal_id)?.display_name ||
            store.get('SELECT username FROM users WHERE id=?', g.principal_id)?.username || g.principal_id };
      });
    let canManageLegacy = false;
    try { superAdmin(user); canManageLegacy = true; } catch { /* Source-specific writes remain platform-only. */ }
    return { grants, can_manage_legacy: canManageLegacy, read_at: Date.now() };
  }
  if (path === '/api/identity' && method === 'GET') {
    const scopes = listEffectiveScopes(store, context.principal_id), platform = scopes.some(s => s.scope === 'platform');
    const tenants = store.all('SELECT * FROM tenants').filter(t => platform || scopes.some(s => s.tenant_id === t.id && s.state === 'active'));
    return { actor: context, tenants, scopes,
      identities: store.all('SELECT id,provider,host,display_name,status,verified_at FROM external_identities WHERE principal_id=?', context.principal_id),
      github_connection: githubConnection(store, context.principal_id) };
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
      fields(body, ['principal_id', 'tenant_id', 'project_id', 'capabilities']);
      const principal = text(body.principal_id), tenant = text(body.tenant_id), project = body.project_id === undefined ? undefined : text(body.project_id);
      authorize(context, 'grants.manage', { tenant_id: tenant, project_id: project });
      if (principal === context.principal_id) return fail(403, 'self_delegation_forbidden');
      if (!store.get('SELECT 1 FROM principals WHERE id=? AND active=1', principal)) return fail(404, 'principal_not_found');
      if (!store.get('SELECT 1 FROM tenants WHERE id=?', tenant)) return fail(404, 'tenant_not_found');
      const grantable = [...projectCapabilities, ...explicitDelegationCapabilities];
      if (!Array.isArray(body.capabilities) || !body.capabilities.length || body.capabilities.some(c => !grantable.includes(String(c)))) return fail(400, 'invalid_capabilities');
      // Grant managers can configure an opt-in capability without themselves holding that capability.
      // Ordinary capabilities still require the grantor's own effective permission, as before.
      for (const capability of body.capabilities) if (!explicitDelegationCapabilities.includes(String(capability))) authorize(context, String(capability), { tenant_id: tenant, project_id: project });
      const id = randomId();
      store.transaction(() => {
        store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
          VALUES(?,?,?,?,?,'delegated',?,'explicit_delegation',?,'independent','console delegation',?)`, id, principal, tenant, project || null, project ? 'project' : 'tenant', JSON.stringify(body.capabilities), context.principal_id, Date.now());
        // Added authority leaves the authorization revision alone (#521).
        store.audit(user.id, 'delegation.created', id, project || null);
      }); return { grant_id: id };
    }
  }
  const revoke = /^\/api\/identity\/grants\/([^/]+)$/.exec(path);
  if (revoke && method === 'DELETE') {
    fields(body, []); const grant = store.get('SELECT * FROM scoped_grants WHERE id=?', revoke[1]!);
    if (!grant) return fail(404, 'grant_not_found');
    authorize(context, 'grants.manage', { tenant_id: grant.tenant_id, project_id: grant.project_id || undefined });
    if (grant.source !== 'explicit_delegation' || grant.policy === 'legacy') return fail(409, 'use_source_revocation');
    store.transaction(() => {
      const before = activeScopes(store, grant.principal_id);
      store.run('UPDATE scoped_grants SET revoked_at=? WHERE id=?', Date.now(), grant.id);
      invalidateIfLost(store, grant.principal_id, before, 'delegation.revoked'); store.audit(user.id, 'delegation.revoked', grant.id, grant.project_id);
    }); return { ok: true };
  }
  return undefined;
}
