import type { Store } from '../storage/database.js';

// Keep a small object projection at ingestion time; board reads never load task inputs or delivery bodies.
export function boardStorage(store: Store): void {
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
    CREATE INDEX IF NOT EXISTS board_task_object ON tasks(repository_id,object_number,kind,created_at DESC);
    CREATE INDEX IF NOT EXISTS board_task_latest ON tasks(repository_id,object_number,kind,coalesce(nullif(updated_at,''),created_at) DESC,created_at DESC);
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
    const json = isTask ? `${source}.input` : `CAST(${source}.payload AS TEXT)`;
    const body = `CASE WHEN json_valid(${json}) THEN ${json} ELSE '{}' END`;
    const obj = arrayPath ? `CASE WHEN j.type='object' THEN j.value ELSE '{}' END` : `CASE WHEN json_type(${body},'$.pull_request')='object' THEN json_extract(${body},'$.pull_request')
      WHEN json_type(${body},'$.issue')='object' THEN json_extract(${body},'$.issue') ELSE '{}' END`;
    const type = arrayPath ? "'pr'" : isTask ? `CASE WHEN ${source}.kind IN ('review.pr','development.pr') THEN 'pr' ELSE 'issue' END`
      : `CASE WHEN json_type(${body},'$.pull_request')='object' OR json_type(${body},'$.issue.pull_request')='object' THEN 'pr' ELSE 'issue' END`;
    const number = isTask ? `${source}.object_number` : arrayPath ? `json_extract(${obj},'$.number')` : `coalesce(json_extract(${obj},'$.number'),CASE WHEN ${obj}<>'{}' THEN json_extract(${body},'$.number') END)`;
    const time = isTask ? `${source}.created_at` : `${source}.received_at`;
    const title = `coalesce(json_extract(${obj},'$.title'),json_extract(${body},'$.title'))`;
    const knownTitle = `CASE WHEN typeof(${title})='text' AND length(trim(${title}))>0 THEN substr(${title},1,1000) END`;
    const knownState = `CASE WHEN json_extract(${obj},'$.state') IN ('open','closed') THEN json_extract(${obj},'$.state') END`;
    const knownDraft = `CASE WHEN json_type(${obj},'$.draft') IN ('true','false') THEN json_extract(${obj},'$.draft') END`;
    const valid = isTask ? `${source}.kind IN ('review.issue','review.pr','development.issue','development.pr')`
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
    WHERE ${where} AND s.kind='development.issue' AND json_valid(s.result)
    AND typeof(json_extract(s.result,'$.pr_number'))='integer' AND json_extract(s.result,'$.pr_number') BETWEEN 1 AND 9007199254740991 ${upsert};`;
  // Triggers also cover executor updates, retries and cancellations without changing execution policy.
  for (const table of ['tasks','deliveries'] as const) {
    for (const operation of ['INSERT','UPDATE']) {
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS board_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
        ${projection(table, 's', 's.rowid=NEW.rowid')} ${table === 'tasks' ? published('s.rowid=NEW.rowid') : deliveryArrays('s.rowid=NEW.rowid')} END;`);
    }
  }
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
}
