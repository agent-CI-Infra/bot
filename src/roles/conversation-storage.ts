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
  if(!store.all('PRAGMA table_info(role_conversation_turns)').some(r=>r.name==='tool_calls')){
    store.db.exec('ALTER TABLE role_conversation_turns ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;ALTER TABLE role_conversation_turns ADD COLUMN usage_complete INTEGER NOT NULL DEFAULT 1');
    store.run("UPDATE role_conversation_turns SET tool_calls=(SELECT count(*) FROM role_conversation_events e WHERE e.turn_id=role_conversation_turns.id AND e.type='conversation_tool'),usage_complete=CASE WHEN reply IS NULL AND NOT EXISTS(SELECT 1 FROM role_conversation_events e WHERE e.turn_id=role_conversation_turns.id) THEN 0 ELSE 1 END");
  }
  for(const [name,type] of Object.entries({external_key:'TEXT',accounting_source:"TEXT NOT NULL DEFAULT 'native'"}))
    if(!store.all('PRAGMA table_info(model_requests)').some(r=>r.name===name))store.db.exec(`ALTER TABLE model_requests ADD COLUMN ${name} ${type}`);
  store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS external_model_request ON model_requests(external_key) WHERE external_key IS NOT NULL');
}
