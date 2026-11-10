import type { Store } from '../storage/database.js';
/** Logical conversations and transport turns are not business tasks or another task scheduler. */
export function conversationStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS role_conversations(id TEXT PRIMARY KEY,project_id TEXT,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS role_conversation_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES role_conversations(id),
      source_message TEXT NOT NULL,project_id TEXT NOT NULL,role_id TEXT NOT NULL,principal_id TEXT,fence TEXT NOT NULL,snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL,reply TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(conversation_id,source_message));
    CREATE INDEX IF NOT EXISTS conversation_turn_scope ON role_conversation_turns(conversation_id,created_at);
    CREATE TABLE IF NOT EXISTS role_conversation_events(id INTEGER PRIMARY KEY,turn_id TEXT NOT NULL REFERENCES role_conversation_turns(id) ON DELETE CASCADE,
      type TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS role_conversation_operations(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL REFERENCES role_conversation_turns(id) ON DELETE CASCADE,
      request TEXT NOT NULL,result TEXT,state TEXT NOT NULL);`);
  for (const name of ['conversation_id','role_id','source_message'])
    if (!store.all('PRAGMA table_info(model_requests)').some(r => r.name === name)) store.db.exec(`ALTER TABLE model_requests ADD COLUMN ${name} TEXT`);
  store.db.exec('CREATE INDEX IF NOT EXISTS model_conversation_scope ON model_requests(conversation_id,role_id,requested_at)');
}
