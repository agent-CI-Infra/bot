import type { Store } from '../storage/database.js';

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
      approval_operations TEXT NOT NULL DEFAULT '[]',role_fields TEXT NOT NULL DEFAULT '["enabled","controller","roles","skills","required_stages"]');
    CREATE TABLE IF NOT EXISTS management_budgets(project_id TEXT NOT NULL,currency TEXT NOT NULL,limit_amount REAL NOT NULL,
      PRIMARY KEY(project_id,currency));
    CREATE TABLE IF NOT EXISTS management_conversations(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS management_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES management_conversations(id),
      source_message TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,authorization_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(conversation_id,source_message));
    CREATE TABLE IF NOT EXISTS management_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL REFERENCES management_messages(id),
      type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_execution_configs(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
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
