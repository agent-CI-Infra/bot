import type { Store } from '../storage/database.js';

// One row per custom workflow, and per built-in workflow whose permissions (or, for the release workflows, prompt)
// an administrator saved. Built-in triggers, review/development prompts and models keep living where they always did
// (policy switches, rule_overrides, task_models), so saved configuration keeps working unchanged.
export function workflowStorage(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS workflows(repository_id TEXT NOT NULL REFERENCES repositories(id),id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,triggers TEXT NOT NULL DEFAULT '[]',
    prompt TEXT,permissions TEXT,model_id TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(repository_id,id))`);
  // Tasks of a custom workflow name it; built-in tasks keep their kind as their workflow.
  if (!store.all('PRAGMA table_info(tasks)').some(row => row.name === 'workflow_id')) store.db.exec('ALTER TABLE tasks ADD COLUMN workflow_id TEXT');
}
