import type { Store } from '../storage/database.js';
import { ledgerStorage } from './ledger.js';

export function channelStorage(store: Store): void {
  ledgerStorage(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS channel_credentials(id TEXT PRIMARY KEY,sealed TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_connectors(id TEXT PRIMARY KEY,provider TEXT NOT NULL,
      app_id TEXT NOT NULL,installation_tenant TEXT NOT NULL,bot_open_id TEXT NOT NULL,
      application_type TEXT NOT NULL,transport TEXT NOT NULL,credential_ref TEXT NOT NULL,enabled INTEGER NOT NULL,
      revision INTEGER NOT NULL,last_received_at INTEGER,last_error TEXT,created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS channel_installation_key ON channel_connectors(provider,app_id,installation_tenant);
    CREATE TABLE IF NOT EXISTS channel_inbox(id TEXT PRIMARY KEY,connector_id TEXT NOT NULL,event_id TEXT NOT NULL,
      dedup_key TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,error TEXT,conversation_id TEXT,message_id TEXT,
      created_at INTEGER NOT NULL,UNIQUE(connector_id,event_id),UNIQUE(connector_id,dedup_key));
    CREATE TABLE IF NOT EXISTS channel_sessions(id TEXT PRIMARY KEY,connector_id TEXT NOT NULL,installation_tenant TEXT NOT NULL,
      actor_tenant TEXT NOT NULL,actor_id TEXT NOT NULL,chat_id TEXT NOT NULL,thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,principal_id TEXT NOT NULL,conversation_id TEXT NOT NULL,last_message_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(connector_id,installation_tenant,actor_tenant,actor_id,chat_id,thread_id,project_id,principal_id));
    CREATE TABLE IF NOT EXISTS channel_bind_requests(challenge_hash TEXT PRIMARY KEY,connector_id TEXT NOT NULL,
      subject TEXT NOT NULL,expires_at INTEGER NOT NULL,oauth_state TEXT,principal_id TEXT,session_ref TEXT,
      binding_ref TEXT,confirmation_hash TEXT,consumed_at INTEGER,identity_id TEXT);
    CREATE TABLE IF NOT EXISTS channel_oauth_links(state_hash TEXT PRIMARY KEY,challenge_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_group_scopes(id TEXT PRIMARY KEY,connector_id TEXT NOT NULL,installation_tenant TEXT NOT NULL,
      chat_id TEXT NOT NULL,project_id TEXT NOT NULL,fields TEXT NOT NULL,sensitivity TEXT NOT NULL,
      audience_verified_until INTEGER NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,
      UNIQUE(connector_id,installation_tenant,chat_id,project_id));
    CREATE TABLE IF NOT EXISTS channel_cards(token_hash TEXT PRIMARY KEY,connector_id TEXT NOT NULL,principal_id TEXT NOT NULL,
      subject TEXT NOT NULL,project_id TEXT NOT NULL,operation_id TEXT NOT NULL,operation_version TEXT NOT NULL,
      expires_at INTEGER NOT NULL,used_at INTEGER);
    CREATE TABLE IF NOT EXISTS channel_outbox(id TEXT PRIMARY KEY,connector_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
      source_event TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL,last_error TEXT,remote_message_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_control_operations(id TEXT PRIMARY KEY,project_id TEXT,receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_audiences(chat_id TEXT PRIMARY KEY REFERENCES channel_chats(id),revision INTEGER NOT NULL DEFAULT 1,
      verified_until INTEGER NOT NULL DEFAULT 0,checked_at INTEGER NOT NULL DEFAULT 0,members TEXT,last_error TEXT);
    CREATE TABLE IF NOT EXISTS channel_employee_grants(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES channel_chats(id),project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL UNIQUE,role_id TEXT NOT NULL,maintainer_id TEXT NOT NULL,binding_id TEXT NOT NULL,capabilities TEXT NOT NULL,
      enabled INTEGER NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(chat_id,project_id));
    CREATE TABLE IF NOT EXISTS channel_personal_owners(chat_id TEXT PRIMARY KEY REFERENCES channel_chats(id),principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,actor_tenant TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_personal_roles(chat_id TEXT NOT NULL REFERENCES channel_chats(id),project_id TEXT NOT NULL,role_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(chat_id,project_id));
    CREATE TABLE IF NOT EXISTS channel_task_results(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS channel_result_cursor(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO channel_result_cursor VALUES(1,0);
    CREATE TRIGGER IF NOT EXISTS channel_task_result AFTER UPDATE OF status,result,error_code ON tasks
      WHEN NEW.status IN ('completed','succeeded','pr_opened','cancelled','failed') AND (OLD.status<>NEW.status OR OLD.result IS NOT NEW.result OR OLD.error_code IS NOT NEW.error_code)
      AND EXISTS(SELECT 1 FROM task_origins o JOIN channel_chats c ON c.id=o.conversation_id WHERE o.task_id=NEW.id AND o.source_kind='role') BEGIN
      INSERT INTO channel_task_results(task_id) VALUES(NEW.id); END;
  `);
  if (!store.all('PRAGMA table_info(channel_employee_grants)').some(c => c.name === 'participation'))
    store.db.exec("ALTER TABLE channel_employee_grants ADD COLUMN participation TEXT NOT NULL DEFAULT 'mentions'");
  if (!store.all('PRAGMA table_info(channel_connectors)').some(c => c.name === 'connection_state'))
    store.db.exec("ALTER TABLE channel_connectors ADD COLUMN connection_state TEXT NOT NULL DEFAULT 'idle'");
  // Connections are global; keep their IDs so credentials, bindings and queued events remain valid.
  store.transaction(() => {
    if (!store.all('PRAGMA table_info(channel_bind_requests)').some(c => c.name === 'code_hash'))
      store.db.exec('ALTER TABLE channel_bind_requests ADD COLUMN code_hash TEXT');
    store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS channel_bind_code ON channel_bind_requests(code_hash)');
    for (const column of ['app_name', 'tenant_name', 'app_name_source'])
      if (!store.all('PRAGMA table_info(channel_connectors)').some(c => c.name === column))
        store.db.exec(`ALTER TABLE channel_connectors ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    // Existing connections also accept external members; identity and project grants still authorize each request.
    if (store.all('PRAGMA table_info(channel_connectors)').some(c => c.name === 'actor_tenants'))
      store.db.exec('ALTER TABLE channel_connectors DROP COLUMN actor_tenants');
    for (const table of ['channel_connectors', 'channel_control_operations'])
      if (store.all(`PRAGMA table_info(${table})`).some(c => c.name === 'tenant_id'))
        store.db.exec(`ALTER TABLE ${table} DROP COLUMN tenant_id`);
  });
}
