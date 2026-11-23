import type { Store } from '../storage/database.js';
import { type Actor, superAdmin } from '../app/auth.js';
import { fail, type Json } from '../core/security.js';
import { deleteServiceRole, listServiceRoles, managementAssistant, serviceItems, serviceRoleStorage, updateServiceRole } from './roles.js';

/** /api/service-roles: maintains the singleton platform management assistant (#1249). Group chat assistants are configured directly on each group binding. */
export function serviceRolesApi(store: Store, user: Actor, method: string, path: string, input: Json): Json | undefined {
  if (path === '/api/service-roles') {
    if (method === 'GET') {
      if (user.role === 'super_admin') { superAdmin(user); return listServiceRoles(store); }
      return { service_roles: [], permission_items: serviceItems };
    }
    if (method === 'POST') {
      superAdmin(user);
      return fail(400, 'service_role_group_moved');
    }
    return undefined;
  }
  const events=/^\/api\/service-roles\/([a-z0-9-]{1,64})\/sessions\/([a-f0-9]{64})\/events$/.exec(path);
  if(events&&method==='GET'){
    superAdmin(user);serviceRoleStorage(store);
    const session=store.get('SELECT id FROM service_harness_sessions WHERE id=? AND service_role_id=?',events[2]!,events[1]!);
    if(!session)return {events:[]};
    return {events:store.all('SELECT id,type,payload,created_at FROM service_harness_events WHERE session_id=? ORDER BY id DESC LIMIT 100',session.id).reverse().map(event=>({id:event.id,type:event.type,created_at:event.created_at,...store.secrets.open(event.payload,'service-harness:'+session.id)}))};
  }
  const sessions=/^\/api\/service-roles\/([a-z0-9-]{1,64})\/sessions$/.exec(path);
  if(sessions&&method==='GET'){superAdmin(user);serviceRoleStorage(store);return {sessions:store.all('SELECT id,service_role_id,turn_id,updated_at FROM service_harness_sessions WHERE service_role_id=? ORDER BY updated_at DESC LIMIT 100',sessions[1]!)};}
  const id = /^\/api\/service-roles\/([a-z0-9-]{1,64})$/.exec(path)?.[1];
  if (!id) return undefined;
  if (method === 'PATCH') {
    superAdmin(user);
    if (id !== managementAssistant) return fail(400, 'service_role_group_moved');
    return { service_role: updateServiceRole(store, user.id, id, input) };
  }
  if (method === 'DELETE') {
    superAdmin(user);
    if (id === managementAssistant) return deleteServiceRole(store, user.id, id, input);
    return fail(400, 'service_role_group_moved');
  }
  return undefined;
}
