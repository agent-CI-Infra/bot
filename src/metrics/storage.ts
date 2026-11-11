import type { Store } from '../storage/database.js';

export const executingStatuses = "('running','preparing','implementing','validating','publishing','result_ready')";
export function metricsStorage(store: Store): void {
  // repository_id is empty for service roles (management assistant, chat assistants), whose usage belongs to service_role_id.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS task_metrics(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      runtime_ms INTEGER NOT NULL DEFAULT 0,active_since INTEGER,complete INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS model_pricing(model_id TEXT PRIMARY KEY REFERENCES models(id),currency TEXT NOT NULL,
      input_per_million REAL NOT NULL,output_per_million REAL NOT NULL,cache_per_million REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS model_requests(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      repository_id TEXT REFERENCES repositories(id),request_id TEXT NOT NULL,model_id TEXT NOT NULL,model_name TEXT NOT NULL,
      requested_at TEXT NOT NULL,finished_at TEXT,http_status INTEGER,state TEXT NOT NULL DEFAULT 'pending',
      input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER,
      currency TEXT,input_per_million REAL,output_per_million REAL,cache_per_million REAL,cost REAL);
    CREATE INDEX IF NOT EXISTS model_request_task ON model_requests(task_id);
    CREATE INDEX IF NOT EXISTS model_request_date ON model_requests(requested_at,repository_id);
    CREATE INDEX IF NOT EXISTS model_request_repo_date ON model_requests(repository_id,requested_at);
    CREATE TRIGGER IF NOT EXISTS metrics_task_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO task_metrics(task_id,active_since) VALUES(NEW.id,
        CASE WHEN NEW.status IN ${executingStatuses} THEN cast(unixepoch('subsec')*1000 AS INTEGER) END);
    END;
    CREATE TRIGGER IF NOT EXISTS metrics_task_status AFTER UPDATE OF status ON tasks WHEN OLD.status<>NEW.status BEGIN
      UPDATE task_metrics SET runtime_ms=runtime_ms+CASE WHEN active_since IS NOT NULL AND NEW.status NOT IN ${executingStatuses}
        THEN max(0,cast(unixepoch('subsec')*1000 AS INTEGER)-active_since) ELSE 0 END,
        active_since=CASE WHEN NEW.status IN ${executingStatuses}
          THEN coalesce(active_since,cast(unixepoch('subsec')*1000 AS INTEGER)) END WHERE task_id=NEW.id;
    END;
  `);
  // Old tasks have no reliable execution clock or token ledger. Mark their coverage as incomplete.
  if (!store.get("SELECT 1 FROM settings WHERE key='task_metrics_v1'")) store.transaction(() => {
    store.run(`INSERT OR IGNORE INTO task_metrics(task_id,active_since,complete)
      SELECT id,CASE WHEN status IN ${executingStatuses} THEN ? END,0 FROM tasks`,Date.now());
    store.run("INSERT INTO settings VALUES('task_metrics_v1',?)",new Date().toISOString());
  });
  nullableRepositoryLedger(store);
  if (!store.all('PRAGMA table_info(model_requests)').some(r => r.name === 'service_role_id')) store.db.exec('ALTER TABLE model_requests ADD COLUMN service_role_id TEXT');
  store.db.exec('CREATE INDEX IF NOT EXISTS model_request_service_role ON model_requests(service_role_id,requested_at) WHERE service_role_id IS NOT NULL');
}

/** Ledgers created before service roles have `repository_id TEXT NOT NULL`. SQLite cannot drop a NOT NULL constraint,
 * so the table is rebuilt once: the stored CREATE statement (which already contains every column added later by
 * ALTER TABLE) is copied with only that constraint removed, every row is copied, and every index and trigger on the
 * table is recreated from its own stored SQL. */
function nullableRepositoryLedger(store: Store): void {
  const column = store.all('PRAGMA table_info(model_requests)').find(r => r.name === 'repository_id');
  if (!column?.notnull) return;
  const table = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_requests'")!.sql as string;
  const definition = /(\brepository_id\s+TEXT)\s+NOT\s+NULL\b/i;
  if (!definition.test(table)) throw new Error('model_requests_migration_unrecognized');
  const rebuilt = table.replace(definition, '$1').replace(/^CREATE TABLE\s+(?:"model_requests"|model_requests)\b/i, 'CREATE TABLE model_requests_rebuild');
  if (!rebuilt.startsWith('CREATE TABLE model_requests_rebuild')) throw new Error('model_requests_migration_unrecognized');
  const dependents = store.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='model_requests' AND type IN ('index','trigger') AND sql IS NOT NULL");
  const columns = store.all('PRAGMA table_info(model_requests)').map(r => `"${String(r.name).replace(/"/g, '""')}"`).join(',');
  // The documented 12-step table change: foreign keys are off while the old table is dropped and the copy renamed, so
  // neither step touches rows of other tables. Rows are copied unchanged; nothing references model_requests. The legacy
  // rename only renames this table, instead of re-parsing every trigger and view of the schema.
  store.db.exec('PRAGMA foreign_keys=OFF;PRAGMA legacy_alter_table=ON');
  try {
    store.transaction(() => {
      store.db.exec(rebuilt);
      store.db.exec(`INSERT INTO model_requests_rebuild(${columns}) SELECT ${columns} FROM model_requests`);
      store.db.exec('DROP TABLE model_requests');
      store.db.exec('ALTER TABLE model_requests_rebuild RENAME TO model_requests');
      for (const item of dependents) store.db.exec(item.sql);
      store.run("INSERT INTO settings VALUES('model_requests_nullable_repository',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", new Date().toISOString());
    });
  } finally { store.db.exec('PRAGMA legacy_alter_table=OFF;PRAGMA foreign_keys=ON'); }
}
