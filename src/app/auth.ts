import { type IncomingMessage } from 'node:http';
import { type Store } from '../storage/database.js';
import { digest, fail, randomId, type Json } from '../core/security.js';

export interface Actor { id: string; username: string; role: 'super_admin' | 'project_admin'; csrf: string; repositories: string[]; }
export function actor(store: Store, req: IncomingMessage): Actor {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('bot_session='))?.slice(12) || '';
  const row = store.get(`SELECT u.id,u.username,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE token_hash=? AND expires_at>? AND u.active=1`, digest(token), Date.now());
  if (!row) return fail(401, 'login_required');
  const repositories = store.all('SELECT repository_id FROM project_admin_assignments WHERE user_id=?', row.id).map(r => String(r.repository_id));
  return { id: row.id, username: row.username, role: row.role, csrf: row.csrf, repositories };
}
export function superAdmin(user: Actor): void { if (user.role !== 'super_admin') fail(403, 'super_admin_required'); }
export function repository(store: Store, user: Actor, id: string): void {
  if (user.role !== 'super_admin' && !user.repositories.includes(id)) fail(403, 'repository_forbidden');
  if (!store.get('SELECT id FROM repositories WHERE id=?', id)) fail(404, 'repository_not_found');
}
export function scope(user: Actor, column: string): { sql: string; args: string[] } {
  if (user.role === 'super_admin') return { sql: '1=1', args: [] };
  if (!user.repositories.length) return { sql: '0=1', args: [] };
  return { sql: `${column} IN (${user.repositories.map(() => '?').join(',')})`, args: user.repositories };
}
export function publicActor(user: Actor): Json {
  return { id: user.id, username: user.username, role: user.role, repository_ids: user.repositories, csrf_token: user.csrf };
}
export function session(store: Store, userId: string): { token: string; csrf: string } {
  const token = randomId(), csrf = randomId();
  store.run('DELETE FROM sessions WHERE expires_at<=?', Date.now());
  store.run('INSERT INTO sessions VALUES(?,?,?,?)', digest(token), userId, csrf, Date.now() + 12 * 3600_000);
  return { token, csrf };
}
