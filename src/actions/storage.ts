import type { Store } from '../storage/database.js';

export function actionsStorage(store: Store) {
  if (!store.all('PRAGMA table_info(policies)').some(r => r.name === 'actions_failures_enabled'))
    store.db.exec('ALTER TABLE policies ADD COLUMN actions_failures_enabled INTEGER NOT NULL DEFAULT 0');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS actions_failure_scans(repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
      enabled_at TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, windows TEXT NOT NULL DEFAULT '[]',
      page_data TEXT, next_scan INTEGER NOT NULL DEFAULT 0, error TEXT, configured_at TEXT, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS actions_failure_runs(repository_id TEXT NOT NULL REFERENCES repositories(id), run_id INTEGER NOT NULL,
      retry_state TEXT NOT NULL DEFAULT 'none', before_attempt INTEGER, expected_attempt INTEGER, retry_at INTEGER,
      head_sha TEXT, head_branch TEXT, tracking INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(repository_id,run_id));
    CREATE TABLE IF NOT EXISTS actions_failure_attempts(repository_id TEXT NOT NULL REFERENCES repositories(id), run_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', classification TEXT, data TEXT,
      PRIMARY KEY(repository_id,run_id,attempt));
    CREATE TABLE IF NOT EXISTS actions_failure_issues(repository_id TEXT NOT NULL REFERENCES repositories(id), number INTEGER NOT NULL,
      signature TEXT NOT NULL, classification TEXT NOT NULL, PRIMARY KEY(repository_id,number));
    CREATE INDEX IF NOT EXISTS actions_failure_signature ON actions_failure_issues(repository_id,signature);
    CREATE TABLE IF NOT EXISTS actions_failure_reports(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id),
      run_id INTEGER NOT NULL, attempt INTEGER NOT NULL, signature TEXT NOT NULL, classification TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', issue_number INTEGER, body TEXT NOT NULL, title TEXT NOT NULL);
  `);
  // When the last look for reruns of earlier runs happened (milliseconds); see ActionsFailures.reconcileReruns.
  if (!store.all('PRAGMA table_info(actions_failure_scans)').some(r => r.name === 'reconciled_at'))
    store.db.exec('ALTER TABLE actions_failure_scans ADD COLUMN reconciled_at INTEGER NOT NULL DEFAULT 0');
}

// Activation starts a new discovery epoch; the retry budget and processed attempts outlive toggles.
export function activateActions(store: Store, id: string, now = new Date().toISOString()) {
  store.run(`INSERT INTO actions_failure_scans(repository_id,enabled_at) VALUES(?,?)
    ON CONFLICT(repository_id) DO UPDATE SET enabled_at=excluded.enabled_at,cursor=0,windows='[]',page_data=NULL,next_scan=0,error=NULL,configured_at=NULL,lease=NULL,lease_until=0,reconciled_at=0`, id, now);
}

export function recordActionsRun(store: Store, id: string, run: any) {
  if (!Number.isSafeInteger(run?.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return;
  store.run(`INSERT INTO actions_failure_runs(repository_id,run_id) VALUES(?,?)
    ON CONFLICT(repository_id,run_id) DO UPDATE SET tracking=1`, id, run.id);
  if (run.status === 'completed') store.run('INSERT OR IGNORE INTO actions_failure_attempts(repository_id,run_id,attempt) VALUES(?,?,?)', id, run.id, run.run_attempt);
}

export function actionsWebhook(store: Store, id: string, event: string, payload: any) {
  if (event !== 'workflow_run' || payload.action !== 'completed'
    || !store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1 AND actions_failures_enabled=1', id)) return;
  recordActionsRun(store, id, payload.workflow_run);
}
