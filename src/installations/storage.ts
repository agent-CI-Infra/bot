import type { Store } from '../storage/database.js';

export function installationStorage(store: Store): void {
  // No foreign keys to credentials, projects, users or ordinary deliveries: these facts outlive them.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS github_installations(
      ref TEXT PRIMARY KEY,github_host TEXT NOT NULL,app_id TEXT NOT NULL,installation_id TEXT NOT NULL,
      account_id TEXT NOT NULL,target_id TEXT,target_type TEXT,target_login TEXT,
      repository_selection TEXT,permissions TEXT NOT NULL DEFAULT '{}',events TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending_sync',completeness TEXT NOT NULL DEFAULT 'pending',
      revision INTEGER NOT NULL DEFAULT 0,scope_version INTEGER NOT NULL DEFAULT 0,permissions_version INTEGER NOT NULL DEFAULT 0,
      scope_pending INTEGER NOT NULL DEFAULT 1,
      last_success_at TEXT,last_error TEXT,history_missing INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,
      UNIQUE(github_host,app_id,installation_id));
    CREATE TABLE IF NOT EXISTS installation_repositories(
      installation_ref TEXT NOT NULL,repository_id TEXT NOT NULL,full_name TEXT NOT NULL,owner_id TEXT NOT NULL,
      owner_login TEXT NOT NULL,private INTEGER NOT NULL,present INTEGER NOT NULL,last_success_at TEXT,
      PRIMARY KEY(installation_ref,repository_id));
    CREATE TABLE IF NOT EXISTS installation_events(
      id TEXT PRIMARY KEY,installation_ref TEXT NOT NULL,account_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,event TEXT NOT NULL,action TEXT NOT NULL,signature_verified INTEGER NOT NULL,
      received_at TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,sender TEXT,requester TEXT,
      evidence_type TEXT NOT NULL,result TEXT NOT NULL,revision INTEGER NOT NULL,
      UNIQUE(installation_ref,delivery_id));
    CREATE TABLE IF NOT EXISTS installation_receipts(
      id TEXT PRIMARY KEY,event_id TEXT NOT NULL,delivery_record_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,
      received_at TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,duplicate INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS installation_sync_jobs(
      account_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,completed_generation INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT);
    CREATE TABLE IF NOT EXISTS installation_sync_attempts(
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,generation INTEGER NOT NULL,started_at TEXT NOT NULL,
      finished_at TEXT,result TEXT NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS installation_domain_events(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,
      installation_ref TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS installation_setup_states(
      state_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,identity_session_ref TEXT,installation_id TEXT,expected_target_id TEXT,
      setup_action TEXT,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS installation_events_ref ON installation_events(installation_ref,received_at);
    CREATE INDEX IF NOT EXISTS installation_jobs_due ON installation_sync_jobs(state,next_attempt);
  `);
  // Existing repository rows establish current scope only; they cannot reconstruct installation/approval history.
  store.run(`INSERT OR IGNORE INTO github_installations(ref,github_host,app_id,installation_id,account_id,
    target_id,target_login,status,updated_at)
    SELECT 'github.com/'||a.app_id||'/'||r.installation_id,'github.com',a.app_id,r.installation_id,a.id,
      r.owner_id,r.owner_login,'pending_sync',r.synced_at
    FROM installed_repositories r JOIN accounts a ON a.id=r.account_id
    WHERE a.type='github_app' AND a.app_id IS NOT NULL AND r.installation_id IS NOT NULL`);
  store.run(`INSERT OR IGNORE INTO installation_repositories
    SELECT 'github.com/'||a.app_id||'/'||r.installation_id,r.repository_id,r.full_name,r.owner_id,
      r.owner_login,r.private,r.installed,r.synced_at FROM installed_repositories r JOIN accounts a ON a.id=r.account_id
    WHERE a.type='github_app' AND r.installation_id IS NOT NULL`);
}
