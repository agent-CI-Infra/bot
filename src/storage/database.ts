import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SecretBox, randomId } from '../core/security.js';
import { externalStorage } from '../external/storage.js';
import { boardStorage } from '../board/storage.js';
import { metricsStorage } from '../metrics/storage.js';

export type Row = Record<string, any>;
export class Store {
  readonly db: DatabaseSync;
  readonly secrets: SecretBox;
  constructor(path: string, key: Buffer) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.secrets = new SecretBox(key);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('super_admin','project_admin')), active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('github_app','bot_account')),
        app_id TEXT, credentials TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS endpoints(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, full_name TEXT NOT NULL COLLATE NOCASE UNIQUE, owner_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS project_admin_assignments(user_id TEXT NOT NULL REFERENCES users(id), repository_id TEXT NOT NULL,
        PRIMARY KEY(user_id,repository_id));
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY, repository_id TEXT REFERENCES repositories(id), api_url TEXT NOT NULL, model_name TEXT NOT NULL,
        api_key TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_projects(model_id TEXT NOT NULL REFERENCES models(id), repository_id TEXT NOT NULL REFERENCES repositories(id),
        PRIMARY KEY(model_id,repository_id));
      CREATE TABLE IF NOT EXISTS policies(repository_id TEXT PRIMARY KEY REFERENCES repositories(id), model_id TEXT REFERENCES models(id),
        review_enabled INTEGER NOT NULL DEFAULT 0, development_enabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, account_id TEXT, endpoint_id TEXT, repository_id TEXT REFERENCES repositories(id),
        delivery_id TEXT NOT NULL, event TEXT NOT NULL, route TEXT NOT NULL, status TEXT NOT NULL, duplicate INTEGER NOT NULL,
        received_at TEXT NOT NULL, http_status INTEGER NOT NULL, request_headers TEXT NOT NULL, payload BLOB NOT NULL,
        body_complete INTEGER NOT NULL, response TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delivery_repo_time ON deliveries(repository_id,received_at);
      CREATE TABLE IF NOT EXISTS processed_deliveries(account_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        PRIMARY KEY(account_id,endpoint_id,delivery_id));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_logs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repository_id TEXT,
        action TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    // The audit outlives the users and repositories it names: deleting either must neither fail on nor remove its records.
    if (this.all('PRAGMA foreign_key_list(audit)').length) this.transaction(() => this.db.exec(`
      CREATE TABLE audit_records(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repository_id TEXT, action TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO audit_records SELECT id,user_id,repository_id,action,resource_id,created_at FROM audit;
      DROP TABLE audit; ALTER TABLE audit_records RENAME TO audit;`));
    // A repository grant may name an installed repository before it is enabled (the project keeps the installation's id),
    // so grants no longer reference repositories; older databases drop that foreign key once.
    if (this.all('PRAGMA foreign_key_list(project_admin_assignments)').some(row => row.table === 'repositories')) this.transaction(() => this.db.exec(`
      CREATE TABLE project_admin_grants(user_id TEXT NOT NULL REFERENCES users(id), repository_id TEXT NOT NULL, PRIMARY KEY(user_id,repository_id));
      INSERT INTO project_admin_grants SELECT user_id,repository_id FROM project_admin_assignments;
      DROP TABLE project_admin_assignments; ALTER TABLE project_admin_grants RENAME TO project_admin_assignments;`));
    // A whole organization granted to a project administrator: every project with this owner_id, including ones enabled later.
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_admin_organizations(user_id TEXT NOT NULL REFERENCES users(id), owner_id TEXT NOT NULL,
      PRIMARY KEY(user_id,owner_id));`);
    if (!this.all('PRAGMA table_info(policies)').some(row => row.name === 'enabled')) this.db.exec('ALTER TABLE policies ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_environments(repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
      generation INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'provisioning',desired TEXT NOT NULL DEFAULT 'ready',error TEXT,started_at TEXT);
      CREATE TABLE IF NOT EXISTS environment_operations(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id),
      action TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
      PRAGMA user_version=2;`);
    if (!this.all('PRAGMA table_info(project_environments)').some(row => row.name === 'revision')) this.db.exec('ALTER TABLE project_environments ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    const extend = (table: string, columns: Record<string, string>) => {
      const names = this.all(`PRAGMA table_info(${table})`).map(row => row.name);
      for (const [name, type] of Object.entries(columns)) if (!names.includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    extend('policies', { test_command: "TEXT NOT NULL DEFAULT ''", base_branch:"TEXT NOT NULL DEFAULT ''", max_revisions: 'INTEGER NOT NULL DEFAULT 3', review_label: "TEXT NOT NULL DEFAULT ''",
      automation: "TEXT NOT NULL DEFAULT '{}'" });
    extend('tasks', { unique_key: 'TEXT', input: "TEXT NOT NULL DEFAULT '{}'", result: 'TEXT', phase: "TEXT NOT NULL DEFAULT 'prepare'",
      object_number: 'INTEGER', head_sha: 'TEXT', source_task_id: 'TEXT', source_delivery_id: 'TEXT', generation: 'INTEGER',
      workspace_id: 'TEXT', messages: 'TEXT', claim_token: 'TEXT', error_code: 'TEXT', attempt: 'INTEGER NOT NULL DEFAULT 1',
      next_run_at: 'INTEGER NOT NULL DEFAULT 0',retry_count:'INTEGER NOT NULL DEFAULT 0', created_at: "TEXT NOT NULL DEFAULT ''", updated_at: "TEXT NOT NULL DEFAULT ''" });
    // A running task holds its own claim; a repository may hold several, up to its concurrency. The earlier
    // one-row-per-repository lock table is replaced (claims never survive a restart, so nothing is migrated).
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS task_unique_key ON tasks(unique_key);
      DROP TABLE IF EXISTS task_locks;
      CREATE TABLE IF NOT EXISTS task_claims(task_id TEXT PRIMARY KEY REFERENCES tasks(id),repository_id TEXT NOT NULL,token TEXT NOT NULL,claimed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_claims_repository ON task_claims(repository_id);
      CREATE TABLE IF NOT EXISTS task_tools(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),request TEXT NOT NULL,result TEXT,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_effects(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,request TEXT NOT NULL,
        state TEXT NOT NULL,response TEXT,marker TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS development_candidates(task_id TEXT PRIMARY KEY REFERENCES tasks(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_branches(repository_id TEXT NOT NULL,branch TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(repository_id,branch));
      CREATE TABLE IF NOT EXISTS bot_pull_requests(repository_id TEXT NOT NULL,number INTEGER NOT NULL,pr_id TEXT NOT NULL,author_id TEXT NOT NULL,
        head_repository_id TEXT NOT NULL,branch TEXT NOT NULL,sha TEXT NOT NULL,source_task_id TEXT NOT NULL,revisions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(repository_id,number));
      CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id),
        delivery_id TEXT,event TEXT NOT NULL,route TEXT NOT NULL,dry_run INTEGER NOT NULL,actions TEXT NOT NULL,notes TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_repo_time ON automation_runs(repository_id,created_at);
      PRAGMA user_version=4;`);
    extend('task_logs', { created_at: "TEXT NOT NULL DEFAULT ''" });
    // Review rules: which events start a review, the comment language and the administrator's project-specific guidance.
    extend('policies', { review_issues: 'INTEGER NOT NULL DEFAULT 1', review_pull_requests: 'INTEGER NOT NULL DEFAULT 1', review_pr_updates: 'INTEGER NOT NULL DEFAULT 1',
      review_language: "TEXT NOT NULL DEFAULT 'auto'", review_instructions: "TEXT NOT NULL DEFAULT ''", rule_overrides: "TEXT NOT NULL DEFAULT '{}'" });
    // How many tasks the project computer runs at once; NULL follows the global default in settings.
    extend('policies', { task_concurrency: 'INTEGER' });
    // Repositories each account can see on GitHub. Seeing a repository does not register or enable it.
    this.db.exec(`CREATE TABLE IF NOT EXISTS installed_repositories(account_id TEXT NOT NULL REFERENCES accounts(id),repository_id TEXT NOT NULL,
        installation_id TEXT,full_name TEXT NOT NULL,owner_id TEXT NOT NULL,owner_login TEXT NOT NULL DEFAULT '',private INTEGER NOT NULL DEFAULT 0,
        installed INTEGER NOT NULL DEFAULT 1,synced_at TEXT NOT NULL,PRIMARY KEY(account_id,repository_id));
      CREATE TABLE IF NOT EXISTS installation_syncs(account_id TEXT PRIMARY KEY REFERENCES accounts(id),synced_at TEXT,error TEXT,repositories INTEGER);`);
    // What GitHub granted on the repository as last read: the installation's permissions for an App, the account's role
    // flags for a bot account. NULL until a sync or permission check has read it.
    extend('installed_repositories', { permissions: 'TEXT', permissions_at: 'TEXT' });
    // Gate/dashboard connection status per repository and one-click onboarding runs.
    this.db.exec(`CREATE TABLE IF NOT EXISTS repo_integrations(repository_id TEXT PRIMARY KEY,
        gate_state TEXT NOT NULL DEFAULT 'unknown',gate_detail TEXT NOT NULL DEFAULT '',
        dashboard_state TEXT NOT NULL DEFAULT 'unknown',dashboard_detail TEXT NOT NULL DEFAULT '',checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quickstart_runs(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,state TEXT NOT NULL,steps TEXT NOT NULL,
        pr_url TEXT,error TEXT,dry_run INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS quickstart_repo_time ON quickstart_runs(repository_id,created_at);
      PRAGMA user_version=5;`);
    externalStorage(this);
    boardStorage(this);
    metricsStorage(this);
  }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args); }
  all(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args); }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Some tables belong to services that create them on construction; deletions skip the ones this process has not made.
  hasTable(name: string): boolean { return !!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name); }
  audit(user: string, action: string, resource: string, repo: string | null = null): void {
    this.run('INSERT INTO audit VALUES(?,?,?,?,?,?)', randomId(), user, repo, action, resource, new Date().toISOString());
  }
  close(): void { this.db.close(); }
}
