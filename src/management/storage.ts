import type { Store } from '../storage/database.js';
import { retireAcpTaskExecutionConfigs, retireIsolatedEnvironmentProfiles } from '../roles/definition.js';

export function managementStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS management_commands(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,tenant_id TEXT,project_id TEXT NOT NULL,
      channel TEXT NOT NULL,operation TEXT NOT NULL,target TEXT NOT NULL,arguments TEXT NOT NULL,expected_revision TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,parameter_hash TEXT NOT NULL,authorization_revision INTEGER NOT NULL,execution_fence TEXT NOT NULL,
      source_conversation TEXT NOT NULL,source_message TEXT NOT NULL,state TEXT NOT NULL,result TEXT,
      before_revision TEXT,after_revision TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(principal_id,idempotency_key));
    CREATE INDEX IF NOT EXISTS management_commands_scope ON management_commands(project_id,created_at);
    -- Commands no longer wait for approval (#312): permissions are configured in the console and nothing waits for a manual
    -- confirmation. management_approvals keeps earlier decisions readable; approval_operations is no longer read.
    CREATE TABLE IF NOT EXISTS management_approvals(command_id TEXT PRIMARY KEY,parameter_hash TEXT NOT NULL,target_revision TEXT NOT NULL,
      expires_at INTEGER NOT NULL,decided_by TEXT,decision TEXT,decided_at INTEGER);
    CREATE TABLE IF NOT EXISTS management_policies(tenant_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1,
      approval_operations TEXT NOT NULL DEFAULT '[]',role_fields TEXT NOT NULL DEFAULT '["enabled","controller","roles","skills"]');
    DROP TABLE IF EXISTS management_budgets;
    CREATE TABLE IF NOT EXISTS management_conversations(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,created_at TEXT NOT NULL,title TEXT,title_revision INTEGER);
    CREATE TABLE IF NOT EXISTS management_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES management_conversations(id),
      source_message TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,authorization_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(conversation_id,source_message));
    CREATE INDEX IF NOT EXISTS management_message_activity ON management_messages(conversation_id,authorization_revision,updated_at);
    CREATE TABLE IF NOT EXISTS management_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL REFERENCES management_messages(id),
      type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_execution_configs(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
  // Preserve retry identity even when two different inputs redact to the same stored text.
  if (!store.all('PRAGMA table_info(management_messages)').some(column => column.name === 'input_hash'))
    store.db.exec('ALTER TABLE management_messages ADD COLUMN input_hash TEXT');
  const conversationColumns = store.all('PRAGMA table_info(management_conversations)');
  if (!conversationColumns.some(column => column.name === 'title'))
    store.db.exec('ALTER TABLE management_conversations ADD COLUMN title TEXT');
  if (!conversationColumns.some(column => column.name === 'title_revision'))
    store.db.exec('ALTER TABLE management_conversations ADD COLUMN title_revision INTEGER');
  retireAcpTaskExecutionConfigs(store);
  retireIsolatedEnvironmentProfiles(store);
  onboardingStorage(store);
  // A command still waiting for approval from before the approval flow was retired never runs: it ends as failed.
  const waiting = store.all("SELECT id,principal_id,project_id FROM management_commands WHERE state='awaiting_approval'");
  if (waiting.length) store.transaction(() => {
    for (const row of waiting) {
      store.run("UPDATE management_commands SET state='failed',result=?,updated_at=? WHERE id=? AND state='awaiting_approval'",
        JSON.stringify({ error: 'approval_retired', notice: '审批流程已取消，这条等待审批的命令没有执行；需要时请重新发起。' }), new Date().toISOString(), row.id);
      store.audit(row.principal_id, 'management.failed', row.id, row.project_id);
    }
  });
}

// Repository onboarding sessions and plan drafts (#930, see onboarding.ts), and confirmed plans (#932).
function onboardingStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_sessions(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,conversation_id TEXT NOT NULL,state TEXT NOT NULL,
      questions TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_by TEXT,closed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS onboarding_open_session ON onboarding_sessions(repository_id) WHERE state='open';
    CREATE INDEX IF NOT EXISTS onboarding_session_conversation ON onboarding_sessions(conversation_id);
    -- Plan drafts by repository and version; a later version replaces the earlier draft.
    CREATE TABLE IF NOT EXISTS onboarding_plans(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES onboarding_sessions(id),repository_id TEXT NOT NULL,
      version INTEGER NOT NULL,plan TEXT NOT NULL,message_id TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(repository_id,version));
    -- A confirmed plan (#932): one application per plan, one receipt per item (see onboarding-apply.ts).
    CREATE TABLE IF NOT EXISTS onboarding_applications(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE REFERENCES onboarding_plans(id),
      repository_id TEXT NOT NULL,version INTEGER NOT NULL,confirmed_by TEXT NOT NULL,confirmed_at TEXT NOT NULL,changes TEXT NOT NULL,options TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS onboarding_application_repository ON onboarding_applications(repository_id,confirmed_at);
    CREATE TABLE IF NOT EXISTS onboarding_receipts(application_id TEXT NOT NULL REFERENCES onboarding_applications(id),item TEXT NOT NULL,position INTEGER NOT NULL,
      state TEXT NOT NULL,error TEXT,detail TEXT,executed_by TEXT,attempts INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(application_id,item));
    -- Requests to start a repository for super administrators to decide (#933, #1133, see onboarding-requests.ts); one open per repository.
    CREATE TABLE IF NOT EXISTS onboarding_requests(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,application_id TEXT REFERENCES onboarding_applications(id),
      requested_by TEXT NOT NULL,requested_at TEXT NOT NULL,state TEXT NOT NULL,decided_by TEXT,decided_at TEXT,reason TEXT,decision TEXT,summary TEXT,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS onboarding_open_request ON onboarding_requests(repository_id) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS onboarding_request_state ON onboarding_requests(state,requested_at);
  `);
  nullableRequestApplication(store);
  if (!store.all('PRAGMA table_info(onboarding_requests)').some(column => column.name === 'summary'))
    store.db.exec('ALTER TABLE onboarding_requests ADD COLUMN summary TEXT');
  // An item that was being applied when the control plane stopped did not finish: it failed and may be retried.
  store.run("UPDATE onboarding_receipts SET state='failed',error='onboarding_item_interrupted',updated_at=? WHERE state='running'", new Date().toISOString());
}

/** Direct start requests from the management assistant (#1133) need no onboarding_applications row: relax older NOT NULL schemas. */
function nullableRequestApplication(store: Store): void {
  const column = store.all('PRAGMA table_info(onboarding_requests)').find(r => r.name === 'application_id');
  if (!column?.notnull) return;
  const table = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='onboarding_requests'")!.sql as string;
  const definition = /(\bapplication_id\s+TEXT)\s+NOT\s+NULL\b/i;
  if (!definition.test(table)) throw new Error('onboarding_requests_migration_unrecognized');
  const rebuilt = table.replace(definition, '$1').replace(/^CREATE TABLE\s+(?:"onboarding_requests"|onboarding_requests)\b/i, 'CREATE TABLE onboarding_requests_rebuild');
  if (!rebuilt.startsWith('CREATE TABLE onboarding_requests_rebuild')) throw new Error('onboarding_requests_migration_unrecognized');
  const dependents = store.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='onboarding_requests' AND type IN ('index','trigger') AND sql IS NOT NULL");
  const columns = store.all('PRAGMA table_info(onboarding_requests)').map(r => `"${String(r.name).replace(/"/g, '""')}"`).join(',');
  store.db.exec('PRAGMA foreign_keys=OFF;PRAGMA legacy_alter_table=ON');
  try {
    store.transaction(() => {
      store.db.exec(rebuilt);
      store.db.exec(`INSERT INTO onboarding_requests_rebuild(${columns}) SELECT ${columns} FROM onboarding_requests`);
      store.db.exec('DROP TABLE onboarding_requests');
      store.db.exec('ALTER TABLE onboarding_requests_rebuild RENAME TO onboarding_requests');
      for (const item of dependents) store.db.exec(item.sql);
    });
  } finally { store.db.exec('PRAGMA legacy_alter_table=OFF;PRAGMA foreign_keys=ON'); }
}

/** Starting a project bills its onboarding usage so far to it (#930): those turns ran before the project existed. */
export function adoptOnboardingUsage(store: Store, repositoryId: string): void {
  store.run(`UPDATE model_requests SET repository_id=? WHERE repository_id IS NULL AND service_role_id=? AND conversation_id IN
    (SELECT conversation_id FROM onboarding_sessions WHERE repository_id=?)`, repositoryId, 'management-assistant', repositoryId);
}
