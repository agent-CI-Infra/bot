import type { Store } from '../storage/database.js';
import { type Actor, superAdmin } from '../app/auth.js';
import type { Json } from '../core/security.js';
import { createServiceRole, deleteServiceRole, listServiceRoles, updateServiceRole } from './roles.js';

/** /api/service-roles: platform service roles, maintained by super administrators only. */
export function serviceRolesApi(store: Store, user: Actor, method: string, path: string, input: Json): Json | undefined {
  if (path === '/api/service-roles') {
    if (method === 'GET') { superAdmin(user); return listServiceRoles(store); }
    if (method === 'POST') { superAdmin(user); return { service_role: createServiceRole(store, user.id, input) }; }
    return undefined;
  }
  const id = /^\/api\/service-roles\/([a-z0-9-]{1,64})$/.exec(path)?.[1];
  if (!id) return undefined;
  if (method === 'PATCH') { superAdmin(user); return { service_role: updateServiceRole(store, user.id, id, input) }; }
  if (method === 'DELETE') { superAdmin(user); return deleteServiceRole(store, user.id, id, input); }
  return undefined;
}
