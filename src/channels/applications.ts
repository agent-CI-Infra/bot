import type { Store, Row } from '../storage/database.js';
import { authorize, holdsInTenant, listEffectiveScopes, type ActorContext } from '../identity/authorization.js';
import { HttpError } from '../core/security.js';

// Who may add, see and manage a Feishu app (#424). An app (one channel_connectors row) is platform-wide (owner_tenant '')
// or belongs to one GitHub organization (tenant), recorded with its creator (created_by).
// - Add: platform administrators (platform-wide or any organization); organization admins and the admins of any of the
//   organization's repositories (config.write on the tenant or on one of its projects) for that organization.
// - See and use: a platform-wide app everyone; an organization's app anyone with an active grant in that organization.
// - Manage: platform administrators; for an organization's app also its organization admins and its creator while the
//   creator could still add apps there.

/** Only an authorization refusal means "not allowed"; a changed authorization or a server fault still propagates. */
function allowed(check: () => unknown): boolean {
  try { return check() !== false; } catch (error) { if (error instanceof HttpError && error.status === 403) return false; throw error; }
}
export const platformManager = (actor: ActorContext): boolean => allowed(() => authorize(actor, 'platform.manage'));
/** Organization admins hold config.write over the whole tenant. */
export const organizationAdmin = (actor: ActorContext, tenant: string): boolean => allowed(() => authorize(actor, 'config.write', { tenant_id: tenant }));
export const canAddApplication = (actor: ActorContext, tenant: string): boolean => allowed(() => holdsInTenant(actor, 'config.write', tenant));
/** The organizations the actor may add an app for. */
export function applicationOrganizations(store: Store, actor: ActorContext): { id: string; name: string }[] {
  return store.all('SELECT id FROM tenants ORDER BY display_name,id').filter(t => canAddApplication(actor, t.id)).map(t => ({ id: t.id as string, name: tenantName(store, t.id) }));
}
export function canManageApplication(actor: ActorContext, c: Row): boolean {
  if (platformManager(actor)) return true;
  if (!c.owner_tenant) return false;
  return organizationAdmin(actor, c.owner_tenant) || c.created_by === actor.principal_id && canAddApplication(actor, c.owner_tenant);
}
/** Platform-wide apps are public identifiers; an organization's app is shown only to people with a grant there. */
export function applicationVisible(store: Store, principal: string, c: Row): boolean {
  if (!c.owner_tenant) return true;
  return listEffectiveScopes(store, principal).some(g => g.state === 'active' && (g.scope === 'platform' || g.tenant_id === c.owner_tenant));
}
/** Opens the app console for anyone who can add an app somewhere or manage an existing one. */
export function applicationConsole(store: Store, actor: ActorContext): boolean {
  return platformManager(actor) || applicationOrganizations(store, actor).length > 0 || store.all('SELECT * FROM channel_connectors').some(c => canManageApplication(actor, c));
}
/** The organization's login, as the console shows it in repository full names; a tenant's display name may be a full name. */
export function tenantName(store: Store, tenant: string): string {
  const name = store.get('SELECT r.full_name FROM repositories r JOIN identity_projects p ON p.project_id=r.id WHERE p.tenant_id=? ORDER BY r.full_name LIMIT 1', tenant)?.full_name
    ?? store.get('SELECT display_name FROM tenants WHERE id=?', tenant)?.display_name ?? tenant;
  return String(name).split('/')[0]!;
}
