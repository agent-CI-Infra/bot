import type { Store } from '../storage/database.js';
export function releaseStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS release_preflights(token TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS project_releases(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    version TEXT NOT NULL,target_sha TEXT NOT NULL,actor_id TEXT NOT NULL,stage TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_poll INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(repository_id,version));
    CREATE UNIQUE INDEX IF NOT EXISTS release_repository_active ON project_releases(repository_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS release_effects(id TEXT PRIMARY KEY,release_id TEXT NOT NULL REFERENCES project_releases(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,response TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    -- Observer leases of the earlier in-process CI observation; observations are tasks now and the table stays for old databases.
    CREATE TABLE IF NOT EXISTS release_observers(release_id TEXT PRIMARY KEY REFERENCES project_releases(id) ON DELETE CASCADE,
    token TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS release_attempts(release_id TEXT NOT NULL REFERENCES project_releases(id) ON DELETE CASCADE,
    run_id INTEGER NOT NULL,attempt INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(release_id,run_id,attempt));`);
  releaseIdleDrafts(store);
}

export function releaseIdleDrafts(store: Store): void {
  // Older drafts held the repository indefinitely. Keep only an unexpired editor/publisher claim.
  store.run("UPDATE project_releases SET active=0,lease=NULL,lease_until=0 WHERE stage='draft' AND (lease IS NULL OR lease_until<=?)", Date.now());
}
