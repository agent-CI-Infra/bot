import { testSshTarget } from './ssh-target-test.js';
import { sshPublicKey } from './ssh-access.js';
import { isIP } from 'node:net';
import { repository, superAdmin, type Actor } from '../app/auth.js';
import { fail, fields, randomId, type Json } from '../core/security.js';
import { requireProjectConfigWrite } from './service.js';
import type { Row, Store } from '../storage/database.js';

const columns = 'id,owner_project,alias,host,port,username,host_key_sha256,auth,route,jump_id,relay_node,allowed_roles,allow_untrusted_pr';
const parameters = ['alias','host','port','username','host_key_sha256','auth','route','jump_id','relay_node','allowed_roles','allow_untrusted_pr','private_key','password'];

function checked(value: unknown, pattern: RegExp, max: number, field: string): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) return fail(400, 'invalid_ssh_target', field);
  return value;
}

function targets(store: Store, project: string | null): Row[] {
  const rows = project
    ? store.all(`SELECT ${columns} FROM ssh_targets WHERE owner_project=? OR id IN
        (SELECT target_id FROM ssh_target_projects WHERE repository_id=?) ORDER BY alias`,project,project)
    : store.all(`SELECT ${columns} FROM ssh_targets WHERE owner_project IS NULL ORDER BY alias`);
  return rows.map(row => ({...row, allowed_roles: JSON.parse(row.allowed_roles), allow_untrusted_pr: !!row.allow_untrusted_pr}));
}

/** Host and network policy are managed by platform administrators, as for the project egress setting. */
export function sshTargetsApi(store: Store, user: Actor, method: string, url: URL, input: Json): Json | Promise<Json> | undefined {
  const match = /^\/api\/(?:repositories\/([1-9]\d{0,19})\/)?ssh-targets(?:\/([a-f0-9]{48}))?(?:\/(binding|test))?$/.exec(url.pathname);
  if (!match) return undefined;
  const [,projectId,id,action] = match, project = projectId ?? null;
  if (project) {
    repository(store,user,project);
    requireProjectConfigWrite(user,project);
  }
  if (!project || method !== 'GET') superAdmin(user);
  if (!id && method === 'GET') return {targets: targets(store,project)};
  if (action === 'test' && id && method === 'POST') {
    fields(input,[]);
    return testSshTarget(store,user.id,id,project);
  }
  if (action === 'binding' && id && project && (method === 'PUT' || method === 'DELETE')) {
    fields(input,[]);
    const global = store.get('SELECT alias FROM ssh_targets WHERE id=? AND owner_project IS NULL',id);
    if (!global) return fail(404,'ssh_target_not_found');
    return store.transaction(() => {
      if (method === 'PUT') {
        if (store.get('SELECT 1 FROM ssh_targets WHERE owner_project=? AND alias=?',project,global.alias)) fail(409,'ssh_alias_in_use');
        store.run('INSERT OR IGNORE INTO ssh_target_projects VALUES(?,?)',project,id);
      } else store.run('DELETE FROM ssh_target_projects WHERE repository_id=? AND target_id=?',project,id);
      store.audit(user.id,method === 'PUT' ? 'ssh_target.bound' : 'ssh_target.unbound',id,project);
      return {id};
    });
  }
  if (action || (id ? !['PUT','DELETE'].includes(method) : method !== 'POST')) return fail(405,'method_not_allowed');
  const previous = id ? store.get(`SELECT ${columns},public_key FROM ssh_targets WHERE id=? AND owner_project IS ?`,id,project) : null;
  if (id && !previous) return fail(404,'ssh_target_not_found');
  if (id && method === 'DELETE') {
    fields(input,[]);
    if (store.get('SELECT 1 FROM ssh_targets WHERE jump_id=?',id)) return fail(409,'ssh_target_in_use');
    return store.transaction(() => {
      store.run('DELETE FROM ssh_targets WHERE id=?',id);
      store.audit(user.id,'ssh_target.deleted',id,project);
      return {id};
    });
  }
  fields(input,parameters);
  const data: Row = {...previous, ...input}, targetId = id ?? randomId();
  const alias = checked(data.alias,/^[a-z0-9][a-z0-9.-]*$/,120,'alias');
  const host = typeof data.host === 'string' && isIP(data.host) ? data.host :
    checked(data.host,/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,253,'host');
  const port = data.port ?? 22;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return fail(400,'invalid_ssh_target','port');
  const username = checked(data.username,/^[a-z0-9_][a-z0-9_.@\\-]*$/i,128,'username');
  const pin = checked(data.host_key_sha256,/^SHA256:[A-Za-z0-9+/]{43}$/,50,'host_key_sha256');
  const auth = checked(data.auth,/^(key|password)$/,8,'auth');
  const route = checked(data.route ?? 'direct',/^(direct|proxy_jump|tunnel)$/,10,'route');
  const roles = input.allowed_roles ?? (previous ? JSON.parse(previous.allowed_roles) : []);
  if (!Array.isArray(roles) || roles.length > 128 || !roles.every(role => typeof role === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(role)))
    return fail(400,'invalid_ssh_target','allowed_roles');
  if ('allow_untrusted_pr' in input && typeof input.allow_untrusted_pr !== 'boolean') return fail(400,'invalid_ssh_target','allow_untrusted_pr');
  const jump = data.jump_id ?? null;
  if (route === 'proxy_jump') {
    if (typeof jump !== 'string' || jump === targetId || !targets(store,project).some(target => target.id === jump))
      return fail(400,'invalid_ssh_jump');
    // Existing chains are acyclic. An update must not introduce an indirect cycle.
    let next = jump;
    while (next) {
      if (next === targetId) return fail(400,'invalid_ssh_jump');
      next = store.get('SELECT jump_id FROM ssh_targets WHERE id=?',next)?.jump_id;
    }
  } else if (jump !== null) return fail(400,'invalid_ssh_jump');
  // Reserved for a tunnel through a compute node near the host (#1380). Until nodes relay, such a tunnel is refused.
  const relay = data.relay_node ?? null;
  if (relay !== null && (route !== 'tunnel' || typeof relay !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(relay))) return fail(400,'invalid_ssh_target','relay_node');
  const field = auth === 'key' ? 'private_key' : 'password';
  if ((auth === 'key' ? 'password' : 'private_key') in input) return fail(400,'ssh_auth_mismatch');
  const secret = input[field];
  const identityChanged = !previous || previous.auth !== auth || previous.host !== host || previous.port !== port ||
    previous.username !== username || previous.host_key_sha256 !== pin;
  if (secret === undefined && identityChanged) return fail(400,'ssh_credential_required');
  if (secret !== undefined && (typeof secret !== 'string' || !secret.length || secret.includes('\0') || secret.length > 65536 ||
      (auth === 'password' && /[\r\n]/.test(secret)))) return fail(400,'invalid_ssh_credential');
  // Every output of the project is redacted for the password literally, whatever its length: one or two characters
  // would garble ordinary text, so a password has at least four.
  if (auth === 'password' && typeof secret === 'string' && secret.length < 4) return fail(400,'invalid_ssh_credential','password_too_short');
  if (auth === 'key' && typeof secret === 'string' &&
      !/^-----BEGIN ((?:OPENSSH |RSA |EC )?PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----\s*$/.test(secret))
    return fail(400,'invalid_ssh_credential');
  // An agent signature request names only the key (#1379): every target has its own unencrypted key, never shared.
  const publicKey = auth === 'password' ? null : typeof secret === 'string' ? sshPublicKey(secret) : previous?.public_key ?? null;
  if (auth === 'key' && !publicKey) return fail(400,'invalid_ssh_credential');
  const sealed = secret === undefined ? null : store.secrets.seal({[field]:secret},'ssh-target:'+targetId);
  return store.transaction(() => {
    if (targets(store,project).some(target => target.id !== targetId && target.alias === alias)) fail(409,'ssh_alias_in_use');
    if (!project && id && store.get(`SELECT 1 FROM ssh_target_projects b JOIN ssh_targets t ON t.owner_project=b.repository_id
        WHERE b.target_id=? AND t.alias=?`,id,alias)) fail(409,'ssh_alias_in_use');
    if (publicKey && store.get('SELECT 1 FROM ssh_targets WHERE public_key=? AND id<>?',publicKey,targetId)) fail(409,'ssh_key_reused');
    const values = [alias,host,port,username,pin,auth,route,jump,relay,JSON.stringify([...new Set(roles)]),data.allow_untrusted_pr ? 1 : 0,publicKey];
    if (id) store.run(`UPDATE ssh_targets SET alias=?,host=?,port=?,username=?,host_key_sha256=?,auth=?,route=?,jump_id=?,relay_node=?,
      allowed_roles=?,allow_untrusted_pr=?,public_key=?,sealed=COALESCE(?,sealed) WHERE id=?`,...values,sealed,id);
    else store.run(`INSERT INTO ssh_targets(alias,host,port,username,host_key_sha256,auth,route,jump_id,relay_node,allowed_roles,
      allow_untrusted_pr,public_key,sealed,id,owner_project) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,...values,sealed,targetId,project);
    store.audit(user.id,id ? 'ssh_target.updated' : 'ssh_target.created',targetId,project);
    return {id:targetId};
  });
}
