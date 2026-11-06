import type { Store } from '../storage/database.js';

/** Extensions of the existing task identity; no parallel queue or completion authority. */
export function taskStorage(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS task_records(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      contract TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, completed TEXT NOT NULL DEFAULT '[]',
      next_action TEXT, selections TEXT NOT NULL DEFAULT '[]', candidate TEXT, acceptance TEXT, pending TEXT, rounds INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS task_history(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_context(repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1,facts TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_followups(parent_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL,issue_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY(parent_id,candidate_id,issue_key));
    CREATE TRIGGER IF NOT EXISTS structured_task_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO task_records(task_id,contract) VALUES(NEW.id,json_object('goal',NEW.summary,'scope',json_array(),
        'criteria',json_array(),'endpoint',NULL,'source',json_object('kind',NEW.kind,'delivery_id',NEW.source_delivery_id),'completeness','unspecified'));
      INSERT INTO task_history(task_id,type,data,created_at) VALUES(NEW.id,'created',json_object('status',NEW.status,'phase',NEW.phase,'attempt',NEW.attempt),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END;
    CREATE TRIGGER IF NOT EXISTS structured_task_progress AFTER UPDATE OF status,phase,attempt,error_code ON tasks
    WHEN OLD.status IS NOT NEW.status OR OLD.phase IS NOT NEW.phase OR OLD.attempt IS NOT NEW.attempt OR OLD.error_code IS NOT NEW.error_code BEGIN
      INSERT INTO task_history(task_id,type,data,created_at) VALUES(NEW.id,'progress',json_object('status',NEW.status,'phase',NEW.phase,'attempt',NEW.attempt,'reason',NEW.error_code),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END;
    INSERT OR IGNORE INTO task_records(task_id,contract)
      SELECT id,json_object('goal',summary,'scope',json_array(),'criteria',json_array(),'endpoint',NULL,
        'source',json_object('kind',kind),'completeness','legacy_unknown') FROM tasks;
  `);
  store.db.exec('PRAGMA user_version=6');
  if(!store.all('PRAGMA table_info(task_records)').some(r=>r.name==='pending'))store.db.exec('ALTER TABLE task_records ADD COLUMN pending TEXT');
}
