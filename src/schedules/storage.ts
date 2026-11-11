import type { Store } from '../storage/database.js';

export function scheduleStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,creator_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,maintainer_id TEXT NOT NULL,actor_id TEXT NOT NULL,kind TEXT NOT NULL,approver_id TEXT,
      authorization_revision INTEGER NOT NULL,grant_snapshot TEXT NOT NULL,spec TEXT NOT NULL,revision INTEGER NOT NULL,
      state TEXT NOT NULL,reason TEXT,next_at INTEGER,last_success INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules(state,next_at);
    CREATE TABLE IF NOT EXISTS schedule_occurrences(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,logical_key TEXT NOT NULL,logical_at INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,source TEXT NOT NULL,
      snapshot TEXT NOT NULL,authorization TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,reason TEXT,result TEXT,
      lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,finished_at INTEGER,UNIQUE(schedule_id,logical_key));
    CREATE INDEX IF NOT EXISTS occurrence_claim ON schedule_occurrences(state,next_attempt,lease_until);
    CREATE TABLE IF NOT EXISTS schedule_business_runs(id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL UNIQUE,workflow TEXT NOT NULL,
      category TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_subscriptions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,spec TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT,event_cursor INTEGER NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    -- Transactional event outbox: source mutations and these rows commit together. Fan-out advances
    -- each subscription cursor and creates its destination outbox rows in another single transaction.
    CREATE TABLE IF NOT EXISTS schedule_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,type TEXT NOT NULL,incident TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,destination_id TEXT NOT NULL,
      schedule_id TEXT,occurrence_id TEXT,subscription_id TEXT,subscription_revision INTEGER,actor_id TEXT NOT NULL,authorization TEXT NOT NULL,
      logical_key TEXT NOT NULL UNIQUE,incident TEXT NOT NULL,parent_id TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,manual_retries INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,remote_message_id TEXT,created_at INTEGER NOT NULL,sent_at INTEGER);
    CREATE INDEX IF NOT EXISTS notification_claim ON notification_outbox(state,next_attempt,lease_until);
    CREATE TABLE IF NOT EXISTS notification_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,outbox_id TEXT NOT NULL,attempt INTEGER NOT NULL,
      worker TEXT NOT NULL,state TEXT NOT NULL,error TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,authorization TEXT NOT NULL DEFAULT '{}',UNIQUE(outbox_id,attempt));
    CREATE TABLE IF NOT EXISTS schedule_operations(effect_key TEXT PRIMARY KEY,project_id TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,resource_id TEXT NOT NULL,
      initiator TEXT NOT NULL,actor_id TEXT NOT NULL,authorization_revision INTEGER NOT NULL,revision INTEGER NOT NULL,
      source TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_budgets(scope TEXT NOT NULL,scope_id TEXT NOT NULL,category TEXT NOT NULL,limits TEXT NOT NULL,
      PRIMARY KEY(scope,scope_id,category));
    CREATE TABLE IF NOT EXISTS schedule_usage(scope TEXT NOT NULL,scope_id TEXT NOT NULL,category TEXT NOT NULL,day INTEGER NOT NULL,
      runs INTEGER NOT NULL DEFAULT 0,model_calls INTEGER NOT NULL DEFAULT 0,cost_micros INTEGER NOT NULL DEFAULT 0,
      notifications INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,scope_id,category,day));
    CREATE TABLE IF NOT EXISTS schedule_notification_slots(scope TEXT NOT NULL,scope_id TEXT NOT NULL,minute INTEGER NOT NULL,
      used INTEGER NOT NULL,PRIMARY KEY(scope,scope_id,minute));
    CREATE TABLE IF NOT EXISTS notification_channel_limits(connector_id TEXT PRIMARY KEY,next_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS schedule_task_event AFTER UPDATE OF status ON tasks
    WHEN NEW.status='failed' AND OLD.status IS NOT NEW.status BEGIN
      INSERT OR IGNORE INTO schedule_events(event_key,project_id,type,incident,payload,created_at)
      VALUES('task:'||NEW.id||':'||NEW.attempt,NEW.repository_id,'task.failed','task:'||NEW.id,
        json_object('task_id',NEW.id,'status',NEW.status,'error',NEW.error_code),cast(unixepoch('subsec')*1000 AS INTEGER)); END;
    -- Commands no longer wait for approval (#312), so there is no approval.waiting event any more.
    DROP TRIGGER IF EXISTS schedule_approval_event;
    CREATE TRIGGER IF NOT EXISTS schedule_ci_event AFTER INSERT ON deliveries
    WHEN NEW.status='accepted' AND NEW.duplicate=0 AND NEW.body_complete=1 AND NEW.repository_id IS NOT NULL
      AND NEW.event IN ('workflow_run','check_run','check_suite') AND json_valid(CAST(NEW.payload AS TEXT)) BEGIN
      INSERT OR IGNORE INTO schedule_events(event_key,project_id,type,incident,payload,created_at)
      SELECT 'ci:'||NEW.id,NEW.repository_id,CASE WHEN json_extract(obj,'$.conclusion')='success' THEN 'ci.recovered' ELSE 'ci.failed' END,
        'ci:'||NEW.event||':'||json_extract(obj,'$.id'),
        json_object('run_id',json_extract(obj,'$.id'),'conclusion',json_extract(obj,'$.conclusion'),'delivery_id',NEW.id),
        cast(unixepoch('subsec')*1000 AS INTEGER)
      FROM (SELECT json_extract(CAST(NEW.payload AS TEXT),'$.'||NEW.event) obj)
      WHERE json_extract(obj,'$.status')='completed' AND json_extract(obj,'$.id') IS NOT NULL
        AND json_extract(obj,'$.conclusion') IN ('success','failure','timed_out','action_required')
        AND (json_extract(obj,'$.conclusion')<>'success' OR EXISTS(SELECT 1 FROM schedule_events e
          WHERE e.project_id=NEW.repository_id AND e.type='ci.failed' AND e.incident='ci:'||NEW.event||':'||json_extract(obj,'$.id'))); END;
  `);
  // Subscriptions drop the retired approval.waiting event; one left with no event pauses with a reason instead of
  // silently never firing. The revision moves so an editor holding the old version gets a conflict.
  const retired = store.all("SELECT id,spec FROM notification_subscriptions WHERE spec LIKE '%approval.waiting%'");
  if (retired.length) store.transaction(() => {
    for (const row of retired) {
      const spec = JSON.parse(row.spec), events = (spec.events ?? []).filter((e: string) => e !== 'approval.waiting');
      if (events.length === (spec.events ?? []).length) continue;
      store.run(`UPDATE notification_subscriptions SET spec=?,revision=revision+1,updated_at=?,
        state=CASE WHEN ?=0 THEN 'paused' ELSE state END,reason=CASE WHEN ?=0 THEN 'approval_event_retired' ELSE reason END WHERE id=?`,
        JSON.stringify({ ...spec, events }), Date.now(), events.length, events.length, row.id);
    }
  });
}
