import type { Store } from '../storage/database.js';
import { type Actor, repository, superAdmin } from '../app/auth.js';
import { fail, object, text, type Json } from '../core/security.js';
import { authorize, listEffectiveProjectAccess } from '../identity/authorization.js';
import { roleModelCheck } from '../channels/service-bindings.js';
import { createServiceRole, deleteServiceRole, listServiceRoles, serviceRole, updateServiceRole } from './roles.js';

/** A project administrator: config.write on the project. Super administrators qualify everywhere. */
function projectAdmin(store: Store, user: Actor, project: string): void {
  if (user.role === 'super_admin') return superAdmin(user);
  repository(store, user, project);
  if (!user.context) return fail(403, 'capability_forbidden');
  authorize(user.context, 'config.write', { project_id: project });
}
/** Who maintains a role: super administrators the global templates, project administrators the roles of their project (#849). */
function maintains(store: Store, user: Actor, id: string): void {
  const role = serviceRole(store, id);
  if (!role) { if (user.role !== 'super_admin') fail(403, 'super_admin_required'); return; }
  if (role.project_id) projectAdmin(store, user, role.project_id); else superAdmin(user);
}

/** /api/service-roles: global templates for super administrators, and the group assistant roles of a project for its administrators. */
export function serviceRolesApi(store: Store, user: Actor, method: string, path: string, input: Json): Json | undefined {
  if (path === '/api/service-roles') {
    if (method === 'GET') {
      if (user.role === 'super_admin') { superAdmin(user); return listServiceRoles(store); }
      // A project administrator sees the roles of the projects they configure, never the global templates' settings.
      const projects = user.context ? listEffectiveProjectAccess(store, user.context.principal_id).filter(p => p.can_configure).map(p => String(p.id)) : [];
      return listServiceRoles(store, projects);
    }
    if (method === 'POST') {
      const body = object(input), project = body.project_id === undefined || body.project_id === null ? null : text(body.project_id, 64);
      if (project) projectAdmin(store, user, project); else superAdmin(user);
      return { service_role: createServiceRole(store, user.id, body, project) };
    }
    return undefined;
  }
  const id = /^\/api\/service-roles\/([a-z0-9-]{1,64})$/.exec(path)?.[1];
  if (!id) return undefined;
  if (method === 'PATCH') { maintains(store, user, id); return { service_role: updateServiceRole(store, user.id, id, input, (role, model) => roleModelCheck(store, role, model)) }; }
  if (method === 'DELETE') { maintains(store, user, id); return deleteServiceRole(store, user.id, id, input); }
  return undefined;
}
