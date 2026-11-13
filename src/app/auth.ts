import { type IncomingMessage } from 'node:http';
import { type Store } from '../storage/database.js';
import { digest, fail, randomId, type Json } from '../core/security.js';
import { authorize, effectiveRepositories, resolveActor, type ActorContext } from '../identity/authorization.js';

export interface Actor { id: string; username: string; role: 'super_admin' | 'project_admin'; csrf: string; repositories: string[]; context?: ActorContext; github?: { login: string; avatar_url: string }; }
export const sessionToken = (req: IncomingMessage): string => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('bot_session='))?.slice(12) || '';
export function actor(store: Store, req: IncomingMessage): Actor {
  const token = sessionToken(req), context = resolveActor(store, token);
  const row = store.get(`SELECT u.id,u.username,u.role,s.csrf,i.display_name AS github_login,i.external_actor AS github_id
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN external_identities i ON i.id=s.identity_id AND i.principal_id=u.id AND i.provider='github' AND i.host='github.com' AND i.status<>'revoked'
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, digest(token), Date.now());
  if (!row) return fail(401, 'login_required');
  // Repositories granted one by one, plus every project of an organization granted as a whole. Read on each request, so a
  // project enabled later is in scope without logging in again.
  const repositories = effectiveRepositories(store, context);
  // Use the verified numeric GitHub identity for avatars, including sessions created before profile display existed.
  const github = row.github_login && /^[1-9]\d*$/.test(row.github_id) ? {
    login: row.github_login, avatar_url: `https://avatars.githubusercontent.com/u/${row.github_id}?s=64&v=4`
  } : undefined;
  return { id: row.id, username: row.username, role: row.role, csrf: row.csrf, repositories, context, github };
}
export function superAdmin(user: Actor): void { if (user.role !== 'super_admin') fail(403, 'super_admin_required'); if (user.context) authorize(user.context, 'platform.manage'); }
export function repository(store: Store, user: Actor, id: string): void {
  if (user.role !== 'super_admin' && !user.repositories.includes(id)) fail(403, 'repository_forbidden');
  if (user.context) authorize(user.context, 'tasks.read', { project_id: id });
  if (!store.get('SELECT id FROM repositories WHERE id=?', id)) fail(404, 'repository_not_found');
}
export function scope(user: Actor, column: string): { sql: string; args: string[] } {
  if (user.role === 'super_admin' && !user.context?.tenant_id) return { sql: '1=1', args: [] };
  if (!user.repositories.length) return { sql: '0=1', args: [] };
  return { sql: `${column} IN (${user.repositories.map(() => '?').join(',')})`, args: user.repositories };
}
export function publicActor(user: Actor): Json {
  return { id: user.id, username: user.username, role: user.role, repository_ids: user.repositories, csrf_token: user.csrf,
    ...(user.context ? { actor: user.context } : {}), ...(user.github ? { github: user.github } : {}) };
}
export function session(store: Store, userId: string, identityId: string | null = null): { token: string; csrf: string } {
  const token = randomId(), csrf = randomId();
  store.run('DELETE FROM sessions WHERE expires_at<=?', Date.now());
  store.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,identity_id) VALUES(?,?,?,?,?)', digest(token), userId, csrf, Date.now() + 12 * 3600_000, identityId);
  return { token, csrf };
}
