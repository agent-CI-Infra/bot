import type { Store, Row } from '../storage/database.js';
import { fail, fields, type Json } from '../core/security.js';
import { type Actor, superAdmin } from './auth.js';
import { isCeiling, type Ceiling } from '../projects/ceiling.js';

// Trusted organizations (#848): a GitHub owner (organization or personal account) whose repository administrators start
// their own repositories. Only super administrators trust or untrust one; trust only decides who may start a repository
// later, so revoking it leaves projects already started as they are. Optional defaults apply to repositories started under
// it: a deployment-shared model, authorized to each such project, and the capability ceiling they start with (#850).

export function trustedOrganizationStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS trusted_organizations(owner_id TEXT PRIMARY KEY,owner_login TEXT NOT NULL,trusted_by TEXT NOT NULL,
    trusted_at TEXT NOT NULL,model_id TEXT,development_enabled INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)`);
  // The default capability ceiling replaced the development choice (#850). Starting always reviewed, so a saved choice
  // becomes develop (development on) or comment, the level the same start gave before; development_enabled stays equal to
  // it for older readers.
  if (!store.all('PRAGMA table_info(trusted_organizations)').some(column => column.name === 'capability_ceiling')) {
    store.db.exec('ALTER TABLE trusted_organizations ADD COLUMN capability_ceiling TEXT');
    store.run("UPDATE trusted_organizations SET capability_ceiling=CASE WHEN development_enabled=1 THEN 'develop' ELSE 'comment' END");
  }
}
/** The ceiling repositories started under a trusted organization get. */
export const trustCeiling = (row: Row): Ceiling => isCeiling(row.capability_ceiling) ? row.capability_ceiling : row.development_enabled ? 'develop' : 'comment';
/** The level a start or a trust asks for: capability_ceiling, or the former development_enabled (on: develop, off: comment). */
export function requestedCeiling(input: { capability_ceiling?: unknown; development_enabled?: unknown }): Ceiling | undefined {
  if (input.capability_ceiling !== undefined && (!isCeiling(input.capability_ceiling) || input.development_enabled !== undefined)) fail(400, 'invalid_capability_ceiling', 'capability_ceiling');
  if (input.development_enabled !== undefined && typeof input.development_enabled !== 'boolean') fail(400, 'invalid_field', 'development_enabled');
  return input.capability_ceiling !== undefined ? input.capability_ceiling as Ceiling : input.development_enabled === undefined ? undefined : input.development_enabled ? 'develop' : 'comment';
}
export function trustedOrganization(store: Store, owner: string): Row | undefined {
  return store.get('SELECT * FROM trusted_organizations WHERE owner_id=?', owner);
}
// A GitHub owner the deployment knows from an installation, with its login as GitHub last reported it.
function knownOwner(store: Store, owner: string): Row | undefined {
  return store.get(`SELECT owner_id,max(owner_login) AS owner_login FROM installed_repositories WHERE owner_id=? GROUP BY owner_id`, owner);
}
// A default model must be one any project may be given: a deployment-shared model.
function sharedModel(store: Store, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !store.get('SELECT 1 FROM models WHERE id=? AND repository_id IS NULL', value)) return fail(400, 'model_not_shared', 'model_id');
  return value;
}
/** Trusts an owner, or changes its defaults. Runs inside the caller's transaction when there is one. */
export function trustOrganization(store: Store, actor: string, owner: string, input: { model_id?: unknown; capability_ceiling?: unknown; development_enabled?: unknown }): Row {
  const known = knownOwner(store, owner);
  if (!known) return fail(404, 'organization_not_found');
  // Without a choice the default is comment: started projects review, as starting always did.
  const level = requestedCeiling(input) ?? 'comment';
  const model = sharedModel(store, input.model_id), now = new Date().toISOString(), previous = trustedOrganization(store, owner);
  store.run(`INSERT INTO trusted_organizations(owner_id,owner_login,trusted_by,trusted_at,model_id,development_enabled,capability_ceiling,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET owner_login=excluded.owner_login,model_id=excluded.model_id,development_enabled=excluded.development_enabled,
      capability_ceiling=excluded.capability_ceiling,updated_at=excluded.updated_at`,
  owner, String(known.owner_login || owner), actor, now, model, Number(level === 'develop'), level, now);
  store.audit(actor, previous ? 'organization.trust_updated' : 'organization.trusted', owner);
  return trustedOrganization(store, owner)!;
}
function view(store: Store, row: Row): Json {
  const model = row.model_id ? store.get('SELECT id,model_name FROM models WHERE id=? AND repository_id IS NULL', row.model_id) : null;
  return { owner_id: row.owner_id, owner_login: row.owner_login, trusted_at: row.trusted_at, updated_at: row.updated_at,
    trusted_by: store.get("SELECT display_name FROM external_identities WHERE principal_id=? AND provider='github' AND status<>'revoked'", row.trusted_by)?.display_name
      || store.get('SELECT username FROM users WHERE id=?', row.trusted_by)?.username || null,
    // A default model deleted or no longer shared since reads as none: later starts go without one.
    model: model ? { id: model.id, name: model.model_name } : null, capability_ceiling: trustCeiling(row), development_enabled: trustCeiling(row) === 'develop' };
}
/** GET, PUT and DELETE /api/trusted-organizations[/<owner id>], for super administrators only. */
export function trustedOrganizationsApi(store: Store, user: Actor, method: string, path: string, input: Json): Json | undefined {
  if (path !== '/api/trusted-organizations' && !path.startsWith('/api/trusted-organizations/')) return undefined;
  superAdmin(user);
  if (path === '/api/trusted-organizations' && method === 'GET') {
    const trusted = store.all('SELECT * FROM trusted_organizations ORDER BY lower(owner_login),owner_id');
    // Owners that installed the App and are not trusted yet, for the 「添加」 choice.
    const candidates = store.all(`SELECT owner_id,max(owner_login) AS owner_login,count(DISTINCT repository_id) AS repositories FROM installed_repositories
      WHERE installed=1 AND owner_id NOT IN (SELECT owner_id FROM trusted_organizations) GROUP BY owner_id ORDER BY lower(max(owner_login)),owner_id`);
    return { organizations: trusted.map(row => view(store, row)), candidates: candidates.map(row => ({ owner_id: row.owner_id, owner_login: row.owner_login, repositories: row.repositories })) };
  }
  const owner = /^\/api\/trusted-organizations\/([1-9]\d*)$/.exec(path)?.[1];
  if (!owner) return fail(404, 'not_found');
  if (method === 'PUT') {
    fields(input, ['model_id', 'capability_ceiling', 'development_enabled']);
    return { organization: view(store, store.transaction(() => trustOrganization(store, user.id, owner, input))) };
  }
  if (method === 'DELETE') {
    fields(input, []);
    return store.transaction(() => {
      if (!store.run('DELETE FROM trusted_organizations WHERE owner_id=?', owner).changes) return fail(404, 'organization_not_trusted');
      // Only later starts change: projects already started under the trust keep running.
      store.audit(user.id, 'organization.untrusted', owner);
      return { owner_id: owner, trusted: false };
    });
  }
  return fail(404, 'not_found');
}
