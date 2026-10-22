import { type Store } from '../storage/database.js';

export function externalStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS external_clients(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id),
      name TEXT NOT NULL,auth_type TEXT NOT NULL,secret_hash TEXT,trust TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS external_grants(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES external_clients(id),
      request_id TEXT NOT NULL,identity TEXT,created_at INTEGER NOT NULL,state TEXT NOT NULL,token_hash TEXT,expires_at TEXT,
      UNIQUE(client_id,request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS external_identity_once ON external_grants(identity) WHERE identity IS NOT NULL;
    CREATE TABLE IF NOT EXISTS external_subscriptions(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES external_clients(id),
      repository_id TEXT NOT NULL REFERENCES repositories(id),name TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,
      filters TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS external_deliveries(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES external_subscriptions(id),
      repository_id TEXT NOT NULL REFERENCES repositories(id),source_id TEXT NOT NULL REFERENCES deliveries(id),version INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,error TEXT,created_at TEXT NOT NULL,UNIQUE(subscription_id,source_id));
    CREATE INDEX IF NOT EXISTS external_grant_quota ON external_grants(client_id,created_at);
    CREATE INDEX IF NOT EXISTS external_client_repo ON external_clients(repository_id);
    CREATE INDEX IF NOT EXISTS external_subscription_repo ON external_subscriptions(repository_id);
    CREATE INDEX IF NOT EXISTS external_delivery_repo ON external_deliveries(repository_id,created_at);
    CREATE INDEX IF NOT EXISTS external_retry_due ON external_deliveries(state,next_at);
  `);
  if(!store.all('PRAGMA table_info(external_clients)').some(row=>row.name==='public_key'))store.db.exec('ALTER TABLE external_clients ADD COLUMN public_key TEXT');
  // Keep client IDs and subscriptions, but never accept legacy reusable credentials after upgrade.
  store.run("UPDATE external_clients SET auth_type='private_key_jwt',secret_hash=NULL,version=version+1 WHERE auth_type='client_secret'");
}
