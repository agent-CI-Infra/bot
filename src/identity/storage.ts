import type { Store } from '../storage/database.js';

export const projectCapabilities = ['tasks.read', 'tasks.manage_own', 'tasks.write', 'roles.edit', 'roles.publish', 'knowledge.read', 'knowledge.write', 'schedules.manage', 'config.write', 'release.manage'];
// A grant manager may explicitly delegate these; default/derived project grants never include them.
export const explicitDelegationCapabilities = ['knowledge.review'];
export const tenantId = (owner: string): string => `github.com:${owner}`;

// Unknown owners stay quarantined. Names, sender and requester are never identity evidence.
export function identityProjection(store: Store): void {
  store.run(`INSERT OR IGNORE INTO principals(id,kind,user_id,active) SELECT id,'human',id,active FROM users`);
  store.run(`INSERT OR IGNORE INTO tenants(id,github_host,github_account_id,display_name)
    SELECT 'github.com:'||owner_id,'github.com',owner_id,full_name FROM repositories
    WHERE owner_id<>'' AND owner_id NOT GLOB '*[^0-9]*' AND owner_id NOT GLOB '0*'`);
  store.run(`INSERT OR IGNORE INTO tenants(id,github_host,github_account_id,display_name)
    SELECT 'github.com:'||owner_id,'github.com',owner_id,owner_login FROM installed_repositories
    WHERE owner_id<>'' AND owner_id NOT GLOB '*[^0-9]*' AND owner_id NOT GLOB '0*'`);
  store.run(`INSERT OR IGNORE INTO tenants(id,github_host,github_account_id,display_name)
    SELECT 'github.com:'||target_id,github_host,target_id,COALESCE(target_login,target_id) FROM github_installations
    WHERE github_host='github.com' AND target_id<>'' AND target_id NOT GLOB '*[^0-9]*' AND target_id NOT GLOB '0*'`);
  store.run(`INSERT INTO identity_projects(project_id,tenant_id) SELECT r.id,t.id FROM repositories r
    LEFT JOIN tenants t ON t.github_account_id=r.owner_id AND t.github_host='github.com' WHERE 1
    ON CONFLICT(project_id) DO UPDATE SET tenant_id=excluded.tenant_id WHERE tenant_id IS NOT excluded.tenant_id`);
  const caps = JSON.stringify(projectCapabilities);
  store.run(`INSERT OR IGNORE INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at)
    SELECT 'legacy:repo:'||a.user_id||':'||a.repository_id,a.user_id,t.id,a.repository_id,'project','project_admin',?,
      'explicit_delegation','legacy','legacy manual repository grant',0 FROM project_admin_assignments a
    LEFT JOIN repositories r ON r.id=a.repository_id
    LEFT JOIN installed_repositories i ON i.repository_id=a.repository_id
    JOIN tenants t ON t.github_host='github.com' AND t.github_account_id=COALESCE(r.owner_id,i.owner_id)`, caps);
  store.run(`INSERT OR IGNORE INTO scoped_grants(id,principal_id,tenant_id,scope,role,capabilities,source,policy,evidence,verified_at)
    SELECT 'legacy:org:'||a.user_id||':'||a.owner_id,a.user_id,t.id,'tenant','project_admin',?,
      'explicit_delegation','legacy','legacy manual organization grant',0 FROM project_admin_organizations a
    JOIN tenants t ON t.github_host='github.com' AND t.github_account_id=a.owner_id`, caps);
  store.run(`DELETE FROM scoped_grants WHERE policy='legacy' AND
    ((scope='project' AND NOT EXISTS(SELECT 1 FROM project_admin_assignments a WHERE a.user_id=principal_id AND a.repository_id=project_id))
    OR (scope='tenant' AND NOT EXISTS(SELECT 1 FROM project_admin_organizations a JOIN tenants t ON t.github_account_id=a.owner_id
      WHERE a.user_id=principal_id AND t.id=tenant_id)))`);
  store.run(`INSERT OR IGNORE INTO identity_quarantine(kind,resource_id,reason)
    SELECT 'project',project_id,'unknown_github_owner' FROM identity_projects WHERE tenant_id IS NULL`);
  store.run(`INSERT OR IGNORE INTO identity_quarantine(kind,resource_id,reason)
    SELECT 'grant',a.user_id||':'||a.repository_id,'unknown_repository_tenant' FROM project_admin_assignments a
    WHERE NOT EXISTS(SELECT 1 FROM scoped_grants g WHERE g.id='legacy:repo:'||a.user_id||':'||a.repository_id)`);
  store.run(`INSERT OR IGNORE INTO identity_quarantine(kind,resource_id,reason)
    SELECT 'organization_grant',a.user_id||':'||a.owner_id,'unknown_organization_tenant' FROM project_admin_organizations a
    WHERE NOT EXISTS(SELECT 1 FROM tenants t WHERE t.github_account_id=a.owner_id AND t.github_host='github.com')`);
  store.run(`DELETE FROM identity_quarantine WHERE kind='project' AND resource_id IN (SELECT project_id FROM identity_projects WHERE tenant_id IS NOT NULL)`);

}

export function identityStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS identity_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,report TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY,kind TEXT NOT NULL,user_id TEXT UNIQUE,
      authorization_revision INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,project_id TEXT,tenant_id TEXT,maintenance TEXT);
    CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,github_host TEXT NOT NULL,github_account_id TEXT NOT NULL,display_name TEXT NOT NULL,
      UNIQUE(github_host,github_account_id));
    CREATE TABLE IF NOT EXISTS identity_projects(project_id TEXT PRIMARY KEY,tenant_id TEXT);
    CREATE TABLE IF NOT EXISTS identity_quarantine(kind TEXT NOT NULL,resource_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(kind,resource_id));
    CREATE TABLE IF NOT EXISTS task_authorizations(task_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,capability TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS inherit_task_authorization AFTER INSERT ON tasks WHEN NEW.source_task_id IS NOT NULL BEGIN
      INSERT OR IGNORE INTO task_authorizations SELECT NEW.id,principal_id,tenant_id,project_id,capability FROM task_authorizations WHERE task_id=NEW.source_task_id; END;
    CREATE TABLE IF NOT EXISTS scoped_grants(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,tenant_id TEXT,project_id TEXT,scope TEXT NOT NULL,
      role TEXT NOT NULL,capabilities TEXT NOT NULL,source TEXT NOT NULL,grantor_id TEXT,policy TEXT NOT NULL,
      evidence TEXT NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER,installation_ref TEXT,installation_revision INTEGER);
    CREATE INDEX IF NOT EXISTS identity_grants_principal ON scoped_grants(principal_id);
    CREATE TABLE IF NOT EXISTS external_identities(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,provider TEXT NOT NULL,host TEXT NOT NULL,
      connector TEXT NOT NULL,external_tenant TEXT NOT NULL,external_actor TEXT NOT NULL,display_name TEXT NOT NULL,
      credentials TEXT,status TEXT NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER,refresh_expires_at INTEGER,
      UNIQUE(provider,host,connector,external_tenant,external_actor));
    CREATE TABLE IF NOT EXISTS bind_challenges(challenge_hash TEXT PRIMARY KEY,principal_id TEXT NOT NULL,session_hash TEXT NOT NULL,
      tenant_id TEXT NOT NULL,provider TEXT NOT NULL,host TEXT NOT NULL,connector TEXT NOT NULL,external_tenant TEXT NOT NULL,
      external_actor TEXT NOT NULL,expires_at INTEGER NOT NULL,identity_id TEXT,proof_id TEXT);
    CREATE TABLE IF NOT EXISTS github_oauth_states(state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,session_hash TEXT,
      principal_id TEXT,verifier TEXT NOT NULL,mode TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER,setup_state TEXT);
    CREATE TABLE IF NOT EXISTS authorization_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,principal_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_cursors(name TEXT PRIMARY KEY,sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO identity_cursors VALUES('installations',0);
    CREATE TRIGGER IF NOT EXISTS identity_user_insert AFTER INSERT ON users BEGIN
      INSERT OR IGNORE INTO principals(id,kind,user_id) VALUES(NEW.id,'human',NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS identity_user_delete AFTER DELETE ON users BEGIN
      UPDATE principals SET active=0,authorization_revision=authorization_revision+1 WHERE user_id=OLD.id;
      UPDATE external_identities SET status='revoked',credentials=NULL WHERE principal_id=OLD.id;
      DELETE FROM scoped_grants WHERE principal_id=OLD.id; END;
  `);
  // The authorization revision counts only lost authority (#521): disabling a user or removing the platform role raises it;
  // enabling or promoting does not. Manual assignments are saved as whole lists, so saveGrants compares effective authority
  // and their triggers only drop the matching legacy grant. Replaced on every start in one transaction: existing databases
  // lose the older unconditional triggers, and processes starting together never see a missing or duplicate trigger.
  store.transaction(() => store.db.exec(`
    DROP TRIGGER IF EXISTS identity_user_change;
    CREATE TRIGGER identity_user_change AFTER UPDATE OF active,role ON users BEGIN
      UPDATE principals SET active=NEW.active,authorization_revision=authorization_revision+
        (OLD.active=1 AND NEW.active<>1 OR OLD.role='super_admin' AND NEW.role<>'super_admin') WHERE user_id=NEW.id;
      INSERT INTO authorization_events(principal_id,reason,created_at) SELECT NEW.id,'user.changed',unixepoch()*1000
        WHERE OLD.active=1 AND NEW.active<>1 OR OLD.role='super_admin' AND NEW.role<>'super_admin'; END;
    ${([['project_admin_assignments', 'repo', 'repository_id'], ['project_admin_organizations', 'org', 'owner_id']] as const).map(([table, kind, field]) => `
    DROP TRIGGER IF EXISTS identity_${table}_INSERT;
    DROP TRIGGER IF EXISTS identity_${table}_DELETE;
    CREATE TRIGGER identity_${table}_DELETE AFTER DELETE ON ${table} BEGIN
      DELETE FROM scoped_grants WHERE id='legacy:${kind}:'||OLD.user_id||':'||OLD.${field}; END;`).join('')}
  `));
  const columns = store.all('PRAGMA table_info(sessions)');
  for (const [name, type] of Object.entries({ tenant_id: 'TEXT', identity_id: 'TEXT' }))
    if (!columns.some(c => c.name === name)) store.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  if (!store.all('PRAGMA table_info(bind_challenges)').some(c => c.name === 'verified_origin'))
    store.db.exec('ALTER TABLE bind_challenges ADD COLUMN verified_origin INTEGER NOT NULL DEFAULT 0');
  // Why the latest GitHub permission check was uncertain: [{installation, code}], never a credential (#521).
  if (!store.all('PRAGMA table_info(external_identities)').some(c => c.name === 'verification_issues'))
    store.db.exec('ALTER TABLE external_identities ADD COLUMN verification_issues TEXT');
  store.transaction(() => {
    identityProjection(store);
    if (!store.get('SELECT 1 FROM identity_migrations WHERE version=1')) {
    store.run(`INSERT OR IGNORE INTO task_authorizations(task_id,principal_id,tenant_id,project_id,capability)
    SELECT r.task_id,p.id,i.tenant_id,t.repository_id,'tasks.write' FROM task_records r JOIN tasks t ON t.id=r.task_id
    JOIN principals p ON p.id=json_extract(r.contract,'$.source.actor') JOIN identity_projects i ON i.project_id=t.repository_id
    WHERE json_valid(r.contract) AND json_extract(r.contract,'$.source.type')='request' AND i.tenant_id IS NOT NULL`);
    }
    store.run(`INSERT OR IGNORE INTO identity_migrations VALUES(1,?,?)`, new Date().toISOString(), JSON.stringify({
      users: store.get('SELECT count(*) n FROM users')!.n, grants: store.get("SELECT count(*) n FROM scoped_grants WHERE policy='legacy'")!.n,
      quarantined: store.get('SELECT count(*) n FROM identity_quarantine')!.n }));
  });
}
