import type { Store } from '../storage/database.js';

export function channelStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS channel_credentials(id TEXT PRIMARY KEY,sealed TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_connectors(id TEXT PRIMARY KEY,provider TEXT NOT NULL,tenant_id TEXT NOT NULL,
      app_id TEXT NOT NULL,installation_tenant TEXT NOT NULL,actor_tenants TEXT NOT NULL,bot_open_id TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS channel_control_operations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT,receipt TEXT NOT NULL);
  `);
  if (!store.all('PRAGMA table_info(channel_connectors)').some(c => c.name === 'connection_state'))
    store.db.exec("ALTER TABLE channel_connectors ADD COLUMN connection_state TEXT NOT NULL DEFAULT 'idle'");
}
