import type { Store } from '../storage/database.js';
import { commitChecksStorage } from '../tasks/external-links.js';
import { grantStorage } from '../tasks/grants.js';
import { deliveryJsonSql } from '../storage/webhook-bodies.js';

// Keep a small object projection at ingestion time; board reads never load task inputs or delivery bodies.
export function boardStorage(store: Store): void {
  commitChecksStorage(store);
  grantStorage(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS board_objects(
      repository_id TEXT NOT NULL REFERENCES repositories(id), object_type TEXT NOT NULL CHECK(object_type IN ('issue','pr')),
      object_number INTEGER NOT NULL CHECK(object_number>0), title TEXT, github_state TEXT, draft INTEGER,
      title_at TEXT NOT NULL DEFAULT '', state_at TEXT NOT NULL DEFAULT '', draft_at TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL,
      PRIMARY KEY(repository_id,object_type,object_number));
    CREATE INDEX IF NOT EXISTS board_recent ON board_objects(last_seen DESC,repository_id,object_type,object_number);
    CREATE INDEX IF NOT EXISTS board_repo_recent ON board_objects(repository_id,last_seen DESC,object_type,object_number);
    CREATE INDEX IF NOT EXISTS board_type_recent ON board_objects(object_type,last_seen DESC);
    CREATE INDEX IF NOT EXISTS board_number_recent ON board_objects(object_number,last_seen DESC);
    CREATE TABLE IF NOT EXISTS board_issue_tasks(
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL,
      object_number INTEGER NOT NULL CHECK(object_number>0),
      role_kind TEXT NOT NULL CHECK(role_kind IN ('review','development')),
      status TEXT NOT NULL,
      error_code TEXT,
      conclusion TEXT,
      recommendation TEXT,
      human_action TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      no_changes INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS board_issue_tasks_repo_num ON board_issue_tasks(repository_id,object_number,role_kind,updated_at DESC,created_at DESC);
    CREATE TABLE IF NOT EXISTS board_pr_tasks(
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL,
      object_number INTEGER NOT NULL CHECK(object_number>0),
      role_kind TEXT NOT NULL CHECK(role_kind IN ('review','development')),
      status TEXT NOT NULL,
      error_code TEXT,
      conclusion TEXT,
      recommendation TEXT,
      human_action TEXT,
      head_sha TEXT,
      no_changes INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS board_pr_tasks_repo_num ON board_pr_tasks(repository_id,object_number,role_kind,updated_at DESC,created_at DESC);
    CREATE INDEX IF NOT EXISTS board_task_object ON tasks(repository_id,object_number,kind,created_at DESC);
    CREATE INDEX IF NOT EXISTS board_task_latest ON tasks(repository_id,object_number,kind,coalesce(nullif(updated_at,''),created_at) DESC,created_at DESC);
    -- Everything the board needs from a task (see latestTasks in api.ts), so card lists never read a tasks row.
    CREATE INDEX IF NOT EXISTS board_task_cover ON tasks(kind,repository_id,object_number,updated_at,created_at,status,id);
    CREATE TABLE IF NOT EXISTS board_fields(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS board_options(id TEXT PRIMARY KEY,field_id TEXT NOT NULL REFERENCES board_fields(id) ON DELETE CASCADE,
      name TEXT NOT NULL,position INTEGER NOT NULL,UNIQUE(field_id,name),UNIQUE(field_id,id));
    CREATE TABLE IF NOT EXISTS board_values(user_id TEXT NOT NULL REFERENCES users(id),repository_id TEXT NOT NULL,object_type TEXT NOT NULL,
      object_number INTEGER NOT NULL,field_id TEXT NOT NULL REFERENCES board_fields(id) ON DELETE CASCADE,option_id TEXT NOT NULL,
      PRIMARY KEY(user_id,repository_id,object_type,object_number,field_id),
      FOREIGN KEY(repository_id,object_type,object_number) REFERENCES board_objects(repository_id,object_type,object_number),
      FOREIGN KEY(field_id,option_id) REFERENCES board_options(field_id,id));
    CREATE TABLE IF NOT EXISTS board_views(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,
      group_by TEXT NOT NULL DEFAULT 'bot_stage',filters TEXT NOT NULL DEFAULT '[]',hidden_columns TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS board_user_views ON board_views(user_id);
    CREATE INDEX IF NOT EXISTS board_user_fields ON board_fields(user_id);
  `);
  const upsert = `ON CONFLICT(repository_id,object_type,object_number) DO UPDATE SET
    title=CASE WHEN excluded.title IS NOT NULL AND excluded.title_at>=board_objects.title_at THEN excluded.title ELSE board_objects.title END,
    title_at=CASE WHEN excluded.title IS NOT NULL THEN max(board_objects.title_at,excluded.title_at) ELSE board_objects.title_at END,
    github_state=CASE WHEN excluded.github_state IS NOT NULL AND excluded.state_at>=board_objects.state_at THEN excluded.github_state ELSE board_objects.github_state END,
    state_at=CASE WHEN excluded.github_state IS NOT NULL THEN max(board_objects.state_at,excluded.state_at) ELSE board_objects.state_at END,
    draft=CASE WHEN excluded.draft IS NOT NULL AND excluded.draft_at>=board_objects.draft_at THEN excluded.draft ELSE board_objects.draft END,
    draft_at=CASE WHEN excluded.draft IS NOT NULL THEN max(board_objects.draft_at,excluded.draft_at) ELSE board_objects.draft_at END,
    last_seen=max(board_objects.last_seen,excluded.last_seen)`;
  const insert = `INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,title_at,state_at,draft_at,last_seen)`;
  const projection = (table: 'tasks' | 'deliveries', source: string, where: string, arrayPath?: string) => {
    const isTask = table === 'tasks';
    // A delivery whose body is in its own file is read from its summary, which keeps these fields in the body's shape (#1403).
    const json = isTask ? `${source}.input` : deliveryJsonSql(source);
    const body = `CASE WHEN json_valid(${json}) THEN ${json} ELSE '{}' END`;
    const obj = arrayPath ? `CASE WHEN j.type='object' THEN j.value ELSE '{}' END` : `CASE WHEN json_type(${body},'$.pull_request')='object' THEN json_extract(${body},'$.pull_request')
      WHEN json_type(${body},'$.issue')='object' THEN json_extract(${body},'$.issue') ELSE '{}' END`;
    const type = arrayPath ? "'pr'" : isTask
      ? `CASE WHEN ${source}.kind IN ('review.pr','development.pr') THEN 'pr' WHEN ${source}.kind='task.request' AND json_extract(${body},'$.target.type') IN ('issue','pr') THEN json_extract(${body},'$.target.type') ELSE 'issue' END`
      : `CASE WHEN json_type(${body},'$.pull_request')='object' OR json_type(${body},'$.issue.pull_request')='object' THEN 'pr' ELSE 'issue' END`;
    const number = isTask ? `${source}.object_number` : arrayPath ? `json_extract(${obj},'$.number')` : `coalesce(json_extract(${obj},'$.number'),CASE WHEN ${obj}<>'{}' THEN json_extract(${body},'$.number') END)`;
    const time = isTask ? `${source}.created_at` : `${source}.received_at`;
    const title = `coalesce(json_extract(${obj},'$.title'),json_extract(${body},'$.title'))`;
    const knownTitle = `CASE WHEN typeof(${title})='text' AND length(trim(${title}))>0 THEN substr(${title},1,1000) END`;
    const knownState = `CASE WHEN json_extract(${obj},'$.state') IN ('open','closed') THEN json_extract(${obj},'$.state') END`;
    const knownDraft = `CASE WHEN json_type(${obj},'$.draft') IN ('true','false') THEN json_extract(${obj},'$.draft') END`;
    const valid = isTask ? `(${source}.kind IN ('review.issue','review.pr','development.issue','development.pr') OR (${source}.kind='task.request' AND json_extract(${body},'$.target.type') IN ('issue','pr')))`
      : `${source}.status='accepted' AND ${source}.duplicate=0 AND ${source}.body_complete=1`;
    return `${insert} SELECT ${source}.repository_id,${type},${number},
      ${knownTitle},${knownState},${knownDraft},
      CASE WHEN (${knownTitle}) IS NOT NULL THEN ${time} ELSE '' END,
      CASE WHEN (${knownState}) IS NOT NULL THEN ${time} ELSE '' END,
      CASE WHEN (${knownDraft}) IS NOT NULL THEN ${time} ELSE '' END,
      ${isTask ? `coalesce(nullif(${source}.updated_at,''),${time})` : time}
      FROM ${table} ${source} ${arrayPath ? `JOIN json_each(CASE WHEN json_type(${body},'${arrayPath}')='array' THEN json_extract(${body},'${arrayPath}') ELSE '[]' END) j` : ''}
      WHERE ${where} AND ${valid} AND ${source}.repository_id IS NOT NULL
      AND typeof(${number})='integer' AND ${number} BETWEEN 1 AND 9007199254740991 ${upsert};`;
  };
  const deliveryArrays = (where: string) => ['$.pull_requests','$.check_run.pull_requests','$.check_suite.pull_requests','$.workflow_run.pull_requests']
    .map(path => projection('deliveries','s',where,path)).join('\n');
  // A published PR is already known through its source task, even before its webhook arrives.
  const published = (where: string) => `${insert} SELECT s.repository_id,'pr',json_extract(s.result,'$.pr_number'),NULL,NULL,NULL,
    '','','',coalesce(nullif(s.updated_at,''),s.created_at) FROM tasks s
    WHERE ${where} AND (s.kind='development.issue' OR (s.kind='task.request' AND json_valid(s.input) AND json_extract(s.input,'$.target.type')='issue')) AND json_valid(s.result)
    AND typeof(json_extract(s.result,'$.pr_number'))='integer' AND json_extract(s.result,'$.pr_number') BETWEEN 1 AND 9007199254740991 ${upsert};`;
  const issueRoleExpr = `CASE
      WHEN s.kind='development.issue' THEN 'development'
      WHEN s.kind='review.issue' THEN 'review'
      WHEN s.kind='task.request' AND json_valid(s.input) AND json_extract(s.input,'$.target.type')='issue' THEN
        CASE
          WHEN EXISTS(SELECT 1 FROM task_write_grants g WHERE g.task_id=s.id AND json_valid(g.writes) AND EXISTS(SELECT 1 FROM json_each(g.writes) WHERE value='pull_request'))
            OR json_extract(s.input,'$.intent')='development'
            OR (json_valid(s.result) AND (typeof(json_extract(s.result,'$.pr_number'))='integer' OR json_extract(s.result,'$.delivery')='pull_request')) THEN 'development'
          WHEN EXISTS(SELECT 1 FROM task_write_grants g WHERE g.task_id=s.id AND json_valid(g.writes) AND EXISTS(SELECT 1 FROM json_each(g.writes) WHERE value='review'))
            OR json_extract(s.input,'$.delivery')='review'
            OR (json_valid(s.result) AND (json_type(s.result,'$.review_delivery')='object' OR typeof(json_extract(s.result,'$.conclusion'))='text')) THEN 'review'
          ELSE NULL
        END
      ELSE NULL END`;
  const issueTaskProjection = (where: string) => `INSERT INTO board_issue_tasks(
      task_id,repository_id,object_number,role_kind,status,error_code,conclusion,recommendation,human_action,pr_number,pr_url,no_changes,summary,created_at,updated_at)
    SELECT s.id,s.repository_id,s.object_number,(${issueRoleExpr}),s.status,s.error_code,
      CASE WHEN json_valid(s.result) AND typeof(coalesce(json_extract(s.result,'$.conclusion'),json_extract(s.result,'$.review_delivery.conclusion')))='text'
        THEN substr(coalesce(json_extract(s.result,'$.conclusion'),json_extract(s.result,'$.review_delivery.conclusion')),1,64) END,
      CASE WHEN json_valid(s.result) AND typeof(coalesce(json_extract(s.result,'$.recommendation'),json_extract(s.result,'$.review_delivery.recommendation')))='text'
        THEN substr(coalesce(json_extract(s.result,'$.recommendation'),json_extract(s.result,'$.review_delivery.recommendation')),1,500) END,
      CASE WHEN json_valid(s.result) THEN substr((
        SELECT coalesce(nullif(trim(json_extract(f.value,'$.human_action')),''),trim(json_extract(f.value,'$.body')))
        FROM json_each(CASE
          WHEN json_type(s.result,'$.findings')='array' THEN json_extract(s.result,'$.findings')
          WHEN json_type(s.result,'$.review_delivery.findings')='array' THEN json_extract(s.result,'$.review_delivery.findings')
          ELSE '[]' END) f
        WHERE json_type(f.value)='object' AND json_extract(f.value,'$.requires_human_decision')=1
        LIMIT 1),1,500) END,
      CASE WHEN json_valid(s.result) AND typeof(json_extract(s.result,'$.pr_number'))='integer' AND json_extract(s.result,'$.pr_number') BETWEEN 1 AND 9007199254740991
        THEN json_extract(s.result,'$.pr_number') END,
      CASE WHEN json_valid(s.result) AND typeof(json_extract(s.result,'$.pr_url'))='text'
        THEN substr(json_extract(s.result,'$.pr_url'),1,500) END,
      CASE WHEN json_valid(s.result) AND json_extract(s.result,'$.status')='no_changes' THEN 1 ELSE 0 END,
      CASE WHEN typeof(s.summary)='text' THEN substr(s.summary,1,300) END,
      s.created_at,coalesce(nullif(s.updated_at,''),s.created_at)
    FROM tasks s
    WHERE ${where} AND s.repository_id IS NOT NULL
      AND typeof(s.object_number)='integer' AND s.object_number BETWEEN 1 AND 9007199254740991
      AND (${issueRoleExpr}) IS NOT NULL
    ON CONFLICT(task_id) DO UPDATE SET
      repository_id=excluded.repository_id,object_number=excluded.object_number,role_kind=excluded.role_kind,
      status=excluded.status,error_code=excluded.error_code,conclusion=excluded.conclusion,
      recommendation=excluded.recommendation,human_action=excluded.human_action,pr_number=excluded.pr_number,
      pr_url=excluded.pr_url,no_changes=excluded.no_changes,summary=excluded.summary,updated_at=excluded.updated_at;`;
  const prRoleExpr = `CASE
      WHEN s.kind='development.pr' THEN 'development'
      WHEN s.kind='review.pr' THEN 'review'
      WHEN s.kind='task.request' AND json_valid(s.input) AND json_extract(s.input,'$.target.type')='pr' THEN
        CASE
          WHEN EXISTS(SELECT 1 FROM task_write_grants g WHERE g.task_id=s.id AND json_valid(g.writes) AND EXISTS(SELECT 1 FROM json_each(g.writes) WHERE value='pull_request'))
            OR json_extract(s.input,'$.intent')='development'
            OR (json_valid(s.result) AND json_extract(s.result,'$.delivery')='pull_request') THEN 'development'
          WHEN EXISTS(SELECT 1 FROM task_write_grants g WHERE g.task_id=s.id AND json_valid(g.writes) AND EXISTS(SELECT 1 FROM json_each(g.writes) WHERE value='review'))
            OR json_extract(s.input,'$.delivery')='review'
            OR (json_valid(s.result) AND (json_type(s.result,'$.review_delivery')='object' OR typeof(json_extract(s.result,'$.conclusion'))='text')) THEN 'review'
          ELSE NULL
        END
      ELSE NULL END`;
  const prTaskProjection = (where: string) => `INSERT INTO board_pr_tasks(
      task_id,repository_id,object_number,role_kind,status,error_code,conclusion,recommendation,human_action,head_sha,no_changes,summary,created_at,updated_at)
    SELECT s.id,s.repository_id,s.object_number,(${prRoleExpr}),s.status,s.error_code,
      CASE WHEN json_valid(s.result) AND typeof(coalesce(json_extract(s.result,'$.conclusion'),json_extract(s.result,'$.review_delivery.conclusion')))='text'
        THEN substr(coalesce(json_extract(s.result,'$.conclusion'),json_extract(s.result,'$.review_delivery.conclusion')),1,64) END,
      CASE WHEN json_valid(s.result) AND typeof(coalesce(json_extract(s.result,'$.recommendation'),json_extract(s.result,'$.review_delivery.recommendation')))='text'
        THEN substr(coalesce(json_extract(s.result,'$.recommendation'),json_extract(s.result,'$.review_delivery.recommendation')),1,500) END,
      CASE WHEN json_valid(s.result) THEN substr((
        SELECT coalesce(nullif(trim(json_extract(f.value,'$.human_action')),''),trim(json_extract(f.value,'$.body')))
        FROM json_each(CASE
          WHEN json_type(s.result,'$.findings')='array' THEN json_extract(s.result,'$.findings')
          WHEN json_type(s.result,'$.review_delivery.findings')='array' THEN json_extract(s.result,'$.review_delivery.findings')
          ELSE '[]' END) f
        WHERE json_type(f.value)='object' AND json_extract(f.value,'$.requires_human_decision')=1
        LIMIT 1),1,500) END,
      CASE WHEN typeof(s.head_sha)='text' AND length(trim(s.head_sha))>0 THEN substr(trim(s.head_sha),1,64) END,
      CASE WHEN json_valid(s.result) AND json_extract(s.result,'$.status')='no_changes' THEN 1 ELSE 0 END,
      CASE WHEN typeof(s.summary)='text' THEN substr(s.summary,1,300) END,
      s.created_at,coalesce(nullif(s.updated_at,''),s.created_at)
    FROM tasks s
    WHERE ${where} AND s.repository_id IS NOT NULL
      AND typeof(s.object_number)='integer' AND s.object_number BETWEEN 1 AND 9007199254740991
      AND (${prRoleExpr}) IS NOT NULL
    ON CONFLICT(task_id) DO UPDATE SET
      repository_id=excluded.repository_id,object_number=excluded.object_number,role_kind=excluded.role_kind,
      status=excluded.status,error_code=excluded.error_code,conclusion=excluded.conclusion,
      recommendation=excluded.recommendation,human_action=excluded.human_action,head_sha=excluded.head_sha,
      no_changes=excluded.no_changes,summary=excluded.summary,updated_at=excluded.updated_at;`;
  // Triggers also cover executor updates, retries and cancellations without changing execution policy.
  // On tasks, status/lease/phase updates only advance last_seen; input and result JSON are parsed only when those columns change.
  // Replaced on every start, so a database created before #1403 gets the triggers that read a moved body's summary.
  store.transaction(() => {
    for (const operation of ['INSERT','UPDATE'] as const) store.db.exec(`DROP TRIGGER IF EXISTS board_deliveries_${operation.toLowerCase()};
      CREATE TRIGGER board_deliveries_${operation.toLowerCase()} AFTER ${operation} ON deliveries BEGIN
      ${projection('deliveries', 's', 's.rowid=NEW.rowid')} ${deliveryArrays('s.rowid=NEW.rowid')} END;`);
  });
  // Another worker can open this database concurrently; it must never observe half-replaced task triggers.
  store.transaction(()=>store.db.exec(`
    DROP TRIGGER IF EXISTS board_tasks_insert;
    CREATE TRIGGER board_tasks_insert AFTER INSERT ON tasks BEGIN
      ${projection('tasks', 's', 's.rowid=NEW.rowid')} ${published('s.rowid=NEW.rowid')} ${issueTaskProjection('s.rowid=NEW.rowid')} ${prTaskProjection('s.rowid=NEW.rowid')} END;
    DROP TRIGGER IF EXISTS board_tasks_update;
    DROP TRIGGER IF EXISTS board_tasks_update_input;
    DROP TRIGGER IF EXISTS board_tasks_update_seen;
    DROP TRIGGER IF EXISTS board_tasks_update_published;
    DROP TRIGGER IF EXISTS board_issue_tasks_update;
    DROP TRIGGER IF EXISTS board_issue_tasks_grants_insert;
    DROP TRIGGER IF EXISTS board_issue_tasks_grants_update;
    CREATE TRIGGER board_tasks_update_input AFTER UPDATE OF repository_id, kind, object_number, input, created_at ON tasks
    WHEN NEW.repository_id IS NOT OLD.repository_id OR NEW.kind IS NOT OLD.kind OR NEW.object_number IS NOT OLD.object_number
      OR NEW.input IS NOT OLD.input OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      ${projection('tasks', 's', 's.rowid=NEW.rowid')}
    END;
    CREATE TRIGGER board_tasks_update_seen AFTER UPDATE OF updated_at ON tasks
    WHEN NEW.updated_at IS NOT OLD.updated_at
      AND (NEW.kind IN ('review.issue','review.pr','development.issue','development.pr')
        OR (NEW.kind='task.request' AND json_valid(NEW.input) AND json_extract(NEW.input,'$.target.type') IN ('issue','pr')))
      AND NEW.repository_id IS NOT NULL
      AND typeof(NEW.object_number)='integer' AND NEW.object_number BETWEEN 1 AND 9007199254740991
    BEGIN
      ${insert} VALUES(NEW.repository_id,
        CASE WHEN NEW.kind IN ('review.pr','development.pr') THEN 'pr' WHEN NEW.kind='task.request' THEN json_extract(NEW.input,'$.target.type') ELSE 'issue' END,
        NEW.object_number, NULL, NULL, NULL, '', '', '', coalesce(nullif(NEW.updated_at,''), NEW.created_at))
      ON CONFLICT(repository_id,object_type,object_number) DO UPDATE SET last_seen=max(board_objects.last_seen,excluded.last_seen);
    END;
    CREATE TRIGGER board_tasks_update_published AFTER UPDATE OF repository_id, kind, result, updated_at, created_at ON tasks
    WHEN (NEW.kind='development.issue' OR (NEW.kind='task.request' AND json_valid(NEW.input) AND json_extract(NEW.input,'$.target.type')='issue'))
      AND NEW.result IS NOT NULL
      AND (NEW.result IS NOT OLD.result OR NEW.updated_at IS NOT OLD.updated_at OR NEW.kind IS NOT OLD.kind OR NEW.repository_id IS NOT OLD.repository_id OR NEW.created_at IS NOT OLD.created_at)
    BEGIN
      ${published('s.rowid=NEW.rowid')}
    END;
    CREATE TRIGGER board_issue_tasks_update AFTER UPDATE OF repository_id, kind, status, error_code, object_number, head_sha, input, result, summary, updated_at, created_at ON tasks
    WHEN NEW.repository_id IS NOT OLD.repository_id OR NEW.kind IS NOT OLD.kind OR NEW.status IS NOT OLD.status
      OR NEW.error_code IS NOT OLD.error_code OR NEW.object_number IS NOT OLD.object_number OR NEW.head_sha IS NOT OLD.head_sha
      OR NEW.input IS NOT OLD.input OR NEW.result IS NOT OLD.result OR NEW.summary IS NOT OLD.summary OR NEW.updated_at IS NOT OLD.updated_at
    BEGIN
      ${issueTaskProjection('s.rowid=NEW.rowid')}
      ${prTaskProjection('s.rowid=NEW.rowid')}
    END;
    CREATE TRIGGER board_issue_tasks_grants_insert AFTER INSERT ON task_write_grants BEGIN
      ${issueTaskProjection('s.id=NEW.task_id')}
      ${prTaskProjection('s.id=NEW.task_id')}
    END;
    CREATE TRIGGER board_issue_tasks_grants_update AFTER UPDATE OF writes ON task_write_grants WHEN NEW.writes IS NOT OLD.writes BEGIN
      ${issueTaskProjection('s.id=NEW.task_id')}
      ${prTaskProjection('s.id=NEW.task_id')}
    END;
  `));
  if (!store.get("SELECT 1 FROM settings WHERE key='board_projection_v1'")) {
    store.transaction(() => {
      // A one-time migration reads existing rows in bounded, primary-key batches.
      for (const table of ['tasks','deliveries'] as const) {
        let after = 0;
        for (;;) {
          const rows = store.all(`SELECT rowid FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 250`, after);
          if (!rows.length) break;
          const end = Number(rows.at(-1)!.rowid);
          store.db.exec(projection(table, 's', `s.rowid>${after} AND s.rowid<=${end}`));
          if (table === 'tasks') store.db.exec(published(`s.rowid>${after} AND s.rowid<=${end}`));
          else store.db.exec(deliveryArrays(`s.rowid>${after} AND s.rowid<=${end}`));
          after = end;
        }
      }
      store.run("INSERT INTO settings VALUES('board_projection_v1','1')");
    });
  }
  if (!store.get("SELECT 1 FROM settings WHERE key='board_issue_tasks_v2'")) {
    store.transaction(() => {
      store.db.exec('DELETE FROM board_issue_tasks');
      let after = 0;
      for (;;) {
        const rows = store.all('SELECT rowid FROM tasks WHERE rowid>? ORDER BY rowid LIMIT 250', after);
        if (!rows.length) break;
        const end = Number(rows.at(-1)!.rowid);
        store.db.exec(projection('tasks', 's', `s.rowid>${after} AND s.rowid<=${end}`));
        store.db.exec(published(`s.rowid>${after} AND s.rowid<=${end}`));
        store.db.exec(issueTaskProjection(`s.rowid>${after} AND s.rowid<=${end}`));
        after = end;
      }
      store.run("INSERT OR REPLACE INTO settings VALUES('board_issue_tasks_v1','1')");
      store.run("INSERT OR REPLACE INTO settings VALUES('board_issue_tasks_v2','1')");
    });
  }
  if (!store.get("SELECT 1 FROM settings WHERE key='board_pr_tasks_v1'")) {
    store.transaction(() => {
      store.db.exec('DELETE FROM board_pr_tasks');
      let after = 0;
      for (;;) {
        const rows = store.all('SELECT rowid FROM tasks WHERE rowid>? ORDER BY rowid LIMIT 250', after);
        if (!rows.length) break;
        const end = Number(rows.at(-1)!.rowid);
        store.db.exec(projection('tasks', 's', `s.rowid>${after} AND s.rowid<=${end}`));
        store.db.exec(prTaskProjection(`s.rowid>${after} AND s.rowid<=${end}`));
        after = end;
      }
      store.run("INSERT OR REPLACE INTO settings VALUES('board_pr_tasks_v1','1')");
    });
  }
}
