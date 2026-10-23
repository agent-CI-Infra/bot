import type { Store } from '../storage/database.js';

export const executingStatuses = "('running','preparing','implementing','validating','publishing','result_ready')";
export function metricsStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS task_metrics(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      runtime_ms INTEGER NOT NULL DEFAULT 0,active_since INTEGER,complete INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS model_pricing(model_id TEXT PRIMARY KEY REFERENCES models(id),currency TEXT NOT NULL,
      input_per_million REAL NOT NULL,output_per_million REAL NOT NULL,cache_per_million REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS model_requests(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id),request_id TEXT NOT NULL,model_id TEXT NOT NULL,model_name TEXT NOT NULL,
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
}
