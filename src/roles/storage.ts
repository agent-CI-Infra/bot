import type { Store } from '../storage/database.js';
import { roleStorageV2 } from './definition.js';
import { roleRunStorage } from './role-run.js';
import { stageStorage } from './schedule.js';
export function cleanRoleMessages(messages:any[]):any[]{return messages.map(message=>Object.fromEntries(Object.entries(message).filter(([key])=>! /^(reasoning.*|thinking.*|analysis)$/i.test(key))));}
export function roleStorage(s:Store){s.db.exec(`
 CREATE TABLE IF NOT EXISTS role_instances(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,role TEXT NOT NULL,definition TEXT NOT NULL,harness TEXT NOT NULL,session TEXT NOT NULL DEFAULT '[]',sequence INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
   conversation_id TEXT,project_id TEXT REFERENCES repositories(id),UNIQUE(task_id,role),CHECK((task_id IS NOT NULL AND conversation_id IS NULL) OR (task_id IS NULL AND conversation_id IS NOT NULL AND project_id IS NOT NULL)));
 CREATE TABLE IF NOT EXISTS role_assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,instance_id TEXT NOT NULL REFERENCES role_instances(id),revision INTEGER NOT NULL,candidate_version TEXT,status TEXT NOT NULL,input_ref TEXT NOT NULL,result_ref TEXT,UNIQUE(instance_id,input_ref));
 `);for(const row of s.all("SELECT id,session FROM role_instances WHERE session LIKE '%reasoning%' OR session LIKE '%thinking%' OR session LIKE '%analysis%'")){const clean=JSON.stringify(cleanRoleMessages(JSON.parse(row.session)));if(clean!==row.session)s.run('UPDATE role_instances SET session=? WHERE id=?',clean,row.id);}

 if(!s.all('PRAGMA table_info(role_instances)').some(r=>r.name==='harness_state'))s.db.exec("ALTER TABLE role_instances ADD COLUMN harness_state TEXT NOT NULL DEFAULT '{}'");
 const existing=new Set(s.all('PRAGMA table_info(task_runs)').map(r=>r.name));for(const [name,type] of Object.entries({role_instance_id:'TEXT',role:'TEXT',role_version:'TEXT',harness:'TEXT',harness_version:'TEXT',assignment_id:'TEXT',recovery_mode:'TEXT',role_snapshot:'TEXT'}))if(!existing.has(name))s.db.exec(`ALTER TABLE task_runs ADD COLUMN ${name} ${type}`);
 // RoleDefinitionV2: an instance pins the snapshot of its current revision; runtime names its live Pi workspace.
 const instance=new Set(s.all('PRAGMA table_info(role_instances)').map(r=>r.name));for(const [name,type] of Object.entries({snapshot_id:'TEXT',config_revision:'INTEGER',role_revision:'INTEGER',pending_revision:'INTEGER',runtime:'TEXT',knowledge_fence:'TEXT'}))if(!instance.has(name))s.db.exec(`ALTER TABLE role_instances ADD COLUMN ${name} ${type}`);
 for(const [name,type] of Object.entries({conversation_id:'TEXT',project_id:'TEXT REFERENCES repositories(id)'}))if(!s.all('PRAGMA table_info(role_instances)').some(r=>r.name===name))s.db.exec(`ALTER TABLE role_instances ADD COLUMN ${name} ${type}`);
 if(s.all('PRAGMA table_info(role_instances)').find(r=>r.name==='task_id')?.notnull){
   // SQLite cannot remove NOT NULL in place. Rebuild under the same table name so assignment FKs keep their target.
   const sql=String(s.get("SELECT sql FROM sqlite_schema WHERE name='role_instances'")!.sql),columns=s.all('PRAGMA table_info(role_instances)').map(r=>'"'+r.name+'"').join(','),
     dependent=s.all("SELECT sql FROM sqlite_schema WHERE tbl_name='role_instances' AND type IN ('index','trigger') AND sql IS NOT NULL");
   s.db.exec('PRAGMA foreign_keys=OFF');
   try{s.transaction(()=>{
     const create=sql.replace(/CREATE TABLE\s+(?:"role_instances"|role_instances)/i,'CREATE TABLE role_instances_next').replace(/\btask_id\s+TEXT\s+NOT\s+NULL/i,'task_id TEXT');
     s.db.exec(create.slice(0,create.lastIndexOf(')'))+',CHECK((task_id IS NOT NULL AND conversation_id IS NULL) OR (task_id IS NULL AND conversation_id IS NOT NULL AND project_id IS NOT NULL)))');
     s.db.exec(`INSERT INTO role_instances_next(${columns}) SELECT ${columns} FROM role_instances; DROP TABLE role_instances; ALTER TABLE role_instances_next RENAME TO role_instances`);
     for(const item of dependent)s.db.exec(String(item.sql));
   });}finally{s.db.exec('PRAGMA foreign_keys=ON');}
 }
 s.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS role_conversation_instance ON role_instances(conversation_id,project_id,role) WHERE conversation_id IS NOT NULL');
 roleStorageV2(s);
 roleRunStorage(s);
 stageStorage(s);
 s.db.exec("UPDATE role_assignments SET status='failed' WHERE status='running' AND EXISTS(SELECT 1 FROM task_runs r WHERE r.assignment_id=role_assignments.id AND r.status IN ('fault','interrupted','stopped')) AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.assignment_id=role_assignments.id AND r.status='running')");
}
