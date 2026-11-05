import type { Store } from '../storage/database.js';

// One row per gate onboarding conversation: the facts read from the repository, the messages, the current plan and its
// revision, the person's merge queue answer (only when the facts could not tell) and the PR it opened.
export function gateOnboardingStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS gate_onboarding_sessions(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,state TEXT NOT NULL,
      facts TEXT,messages TEXT NOT NULL DEFAULT '[]',plan TEXT,revision INTEGER NOT NULL DEFAULT 0,merge_queue TEXT,
      pr_url TEXT,error TEXT,detail TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS gate_onboarding_repo_time ON gate_onboarding_sessions(repository_id,created_at);`);
}
