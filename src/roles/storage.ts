import type { Store } from '../storage/database.js';
export function cleanRoleMessages(messages:any[]):any[]{return messages.map(message=>Object.fromEntries(Object.entries(message).filter(([key])=>! /^(reasoning.*|thinking.*|analysis)$/i.test(key))));}
export function roleStorage(s:Store){s.db.exec(`
 CREATE TABLE IF NOT EXISTS role_instances(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,role TEXT NOT NULL,definition TEXT NOT NULL,harness TEXT NOT NULL,session TEXT NOT NULL DEFAULT '[]',sequence INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,UNIQUE(task_id,role));
 CREATE TABLE IF NOT EXISTS role_assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,instance_id TEXT NOT NULL REFERENCES role_instances(id),revision INTEGER NOT NULL,candidate_version TEXT,status TEXT NOT NULL,input_ref TEXT NOT NULL,result_ref TEXT,UNIQUE(instance_id,input_ref));
 `);for(const row of s.all("SELECT id,session FROM role_instances WHERE session LIKE '%reasoning%' OR session LIKE '%thinking%' OR session LIKE '%analysis%'")){const clean=JSON.stringify(cleanRoleMessages(JSON.parse(row.session)));if(clean!==row.session)s.run('UPDATE role_instances SET session=? WHERE id=?',clean,row.id);}

 if(!s.all('PRAGMA table_info(role_instances)').some(r=>r.name==='harness_state'))s.db.exec("ALTER TABLE role_instances ADD COLUMN harness_state TEXT NOT NULL DEFAULT '{}'");
 const existing=new Set(s.all('PRAGMA table_info(task_runs)').map(r=>r.name));for(const [name,type] of Object.entries({role_instance_id:'TEXT',role:'TEXT',role_version:'TEXT',harness:'TEXT',harness_version:'TEXT',assignment_id:'TEXT',recovery_mode:'TEXT'}))if(!existing.has(name))s.db.exec(`ALTER TABLE task_runs ADD COLUMN ${name} ${type}`);
 s.db.exec("UPDATE role_assignments SET status='failed' WHERE status='running' AND EXISTS(SELECT 1 FROM task_runs r WHERE r.assignment_id=role_assignments.id AND r.status IN ('fault','interrupted','stopped')) AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.assignment_id=role_assignments.id AND r.status='running')");
}
