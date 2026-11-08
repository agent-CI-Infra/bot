import type { Store } from '../storage/database.js';
import type { Actor } from '../app/auth.js';
import { digest, fail, fields, randomId, text, type Json } from '../core/security.js';
import { authorize, createProjectServicePrincipal, invalidate, listEffectiveScopes, migrationReport, refreshSessionRevision } from './authorization.js';
import { projectCapabilities } from './storage.js';
import { revokeIdentity } from './bindings.js';

export function identityApi(store: Store, user: Actor, token: string, method: string, url: URL, body: Json): Json | undefined {
  const path = url.pathname, context = user.context!;
  if (path === '/api/identity' && method === 'GET') {
    const scopes = listEffectiveScopes(store, context.principal_id), platform = scopes.some(s => s.scope === 'platform');
    const tenants = store.all('SELECT * FROM tenants').filter(t => platform || scopes.some(s => s.tenant_id === t.id && s.state === 'active'));
    return { actor: context, tenants, scopes,
      identities: store.all('SELECT id,provider,host,display_name,status,verified_at FROM external_identities WHERE principal_id=?', context.principal_id) };
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
          principal_name: store.get("SELECT display_name FROM external_identities WHERE principal_id=? AND provider='github'", g.principal_id)?.display_name ||
            store.get('SELECT username FROM users WHERE id=?', g.principal_id)?.username || g.principal_id,
          state: listEffectiveScopes(store, g.principal_id).find(s => s.grant_id === g.id)?.state || 'revoked' })) };
    }
    if (method === 'POST') {
      fields(body, ['principal_id', 'tenant_id', 'project_id', 'capabilities']);
      const principal = text(body.principal_id), tenant = text(body.tenant_id), project = body.project_id === undefined ? undefined : text(body.project_id);
      authorize(context, 'grants.manage', { tenant_id: tenant, project_id: project });
      if (principal === context.principal_id) return fail(403, 'self_delegation_forbidden');
      if (!store.get('SELECT 1 FROM principals WHERE id=? AND active=1', principal)) return fail(404, 'principal_not_found');
      if (!store.get('SELECT 1 FROM tenants WHERE id=?', tenant)) return fail(404, 'tenant_not_found');
      if (!Array.isArray(body.capabilities) || !body.capabilities.length || body.capabilities.some(c => !projectCapabilities.includes(String(c)))) return fail(400, 'invalid_capabilities');
      for (const capability of body.capabilities) authorize(context, String(capability), { tenant_id: tenant, project_id: project });
      const id = randomId();
      store.transaction(() => {
        store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
          VALUES(?,?,?,?,?,'delegated',?,'explicit_delegation',?,'independent','console delegation',?)`, id, principal, tenant, project || null, project ? 'project' : 'tenant', JSON.stringify(body.capabilities), context.principal_id, Date.now());
        invalidate(store, principal, 'delegation.created'); store.audit(user.id, 'delegation.created', id, project || null);
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
      store.run('UPDATE scoped_grants SET revoked_at=? WHERE id=?', Date.now(), grant.id);
      invalidate(store, grant.principal_id, 'delegation.revoked'); store.audit(user.id, 'delegation.revoked', grant.id, grant.project_id);
    }); return { ok: true };
  }
  return undefined;
}
export { refreshSessionRevision };
