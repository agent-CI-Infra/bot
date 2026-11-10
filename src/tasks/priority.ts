import {reviewDependencySql} from './readiness.js';
import type {Store,Row} from '../storage/database.js';
import {fail,randomId} from '../core/security.js';
import {traceEvent} from './trace.js';

export const priorities=['P0','P1','P2','P3'] as const;
export const priorityInstructions=`Task priority is decided by Task Manager, not QA. P0: observed or credibly imminent major damage requiring immediate containment (ongoing data loss, credential exposure/unauthorized access, widespread core-service outage without an alternative). P1: a core goal or critical delivery is blocked with no acceptable workaround. P2: ordinary planned work, final integration/acceptance, or bounded defects with an acceptable workaround. P3: non-core polish, wording, or verification beyond required acceptance. Cite occurrence conditions, affected scope, evidence, workaround and delivery impact; adjectives or your own task's importance are not evidence. Missing facts default to P2 with an explicit uncertainty; credible major risk may justify containment. Higher priority takes the next free slot; never preempt a running task. Same-priority tasks are FIFO. Changed priority joins the new priority's tail; setting the same value does not move it. Retries receive a new queue ticket when scheduled, and are eligible only after their retry time/dependencies are ready.`;
export function priorityStorage(s:Store){
 const columns=s.all('PRAGMA table_info(tasks)');
 if(!columns.some(r=>r.name==='priority'))s.db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2' CHECK(priority IN ('P0','P1','P2','P3'))");
 if(!columns.some(r=>r.name==='queue_seq'))s.db.exec('ALTER TABLE tasks ADD COLUMN queue_seq INTEGER NOT NULL DEFAULT 0');
 s.db.exec(`CREATE TABLE IF NOT EXISTS task_queue_counter(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
 INSERT OR IGNORE INTO task_queue_counter VALUES(1,0);
 CREATE TABLE IF NOT EXISTS task_relations(source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 candidate_id TEXT NOT NULL,residual_key TEXT NOT NULL,target_task_id TEXT NOT NULL REFERENCES tasks(id),
 relationship TEXT NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,issue_url TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(source_task_id,candidate_id,residual_key));
 CREATE TABLE IF NOT EXISTS task_followup_plans(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,candidate_id TEXT NOT NULL,
 revision INTEGER NOT NULL,plan TEXT NOT NULL,manager_ref TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_id,candidate_id));
 CREATE INDEX IF NOT EXISTS task_queue_fifo ON tasks(priority,queue_seq,id);
 CREATE TRIGGER IF NOT EXISTS task_queue_insert AFTER INSERT ON tasks BEGIN
 UPDATE task_queue_counter SET value=value+1 WHERE id=1;
 UPDATE tasks SET queue_seq=(SELECT value FROM task_queue_counter WHERE id=1) WHERE id=NEW.id;
 END;
 CREATE TRIGGER IF NOT EXISTS task_queue_reentry AFTER UPDATE OF status,priority ON tasks
 WHEN OLD.priority<>NEW.priority OR (OLD.status<>NEW.status AND NEW.status IN ('queued','retry_wait','waiting_configuration','waiting_environment','waiting_pr_head')) BEGIN
 UPDATE task_queue_counter SET value=value+1 WHERE id=1;
 UPDATE tasks SET queue_seq=(SELECT value FROM task_queue_counter WHERE id=1) WHERE id=NEW.id;
 INSERT INTO task_history(task_id,type,data,created_at) VALUES(NEW.id,'queue_entered',json_object('priority',NEW.priority,'previous_status',OLD.status,'status',NEW.status,'sequence',(SELECT value FROM task_queue_counter WHERE id=1)),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;`);
 // Migrate once in chronological order; reopening the database never moves existing queue entries.
 s.transaction(()=>{for(const r of s.all('SELECT id FROM tasks WHERE queue_seq=0 ORDER BY julianday(created_at),id')){
 s.run('UPDATE task_queue_counter SET value=value+1 WHERE id=1');s.run('UPDATE tasks SET queue_seq=(SELECT value FROM task_queue_counter WHERE id=1) WHERE id=?',r.id);
 }});
}
export function setTaskPriority(s:Store,id:string,priority:unknown,reason:unknown,actor:string){
 if(!priorities.includes(priority as any)||typeof reason!=='string'||!reason.trim()||reason.length>8000)fail(400,'invalid_task_priority');
 const name='priority_'+randomId();s.db.exec('SAVEPOINT '+name);try{const result=(()=>{const old=s.get('SELECT priority FROM tasks WHERE id=?',id);if(!old)fail(404,'task_not_found');
 if(old!.priority!==priority){s.run('UPDATE tasks SET priority=? WHERE id=?',String(priority),id);traceEvent(s,id,'priority_changed',{previous:old!.priority,priority,reason},null,actor);}
 return s.get('SELECT priority,queue_seq FROM tasks WHERE id=?',id)!;})();s.db.exec('RELEASE '+name);return result;}catch(e){s.db.exec('ROLLBACK TO '+name);s.db.exec('RELEASE '+name);throw e;}
}
export const queueEligible="status IN ('queued','retry_wait','waiting_configuration','waiting_environment','waiting_pr_head') AND next_run_at<=? AND "+reviewDependencySql;
/** Claim the current first eligible row under a write transaction, not a stale pre-read list. */
export function claimQueuedTask(s:Store,repo:string,kinds:string,limit:number,now=Date.now(),excluded:string[]=[]):Row|undefined{
 return s.transaction(()=>{
 if(s.get("SELECT count(*) n FROM task_claims c JOIN tasks t ON t.id=c.task_id WHERE c.repository_id=? AND t.status='running'",repo)!.n>=limit)return;
 const exclusion=excluded.length?' AND id NOT IN ('+excluded.map(()=>'?').join(',')+')':'';
 const task=s.get(`SELECT * FROM tasks WHERE repository_id=? AND ${kinds} AND ${queueEligible}${exclusion} ORDER BY priority,queue_seq,id LIMIT 1`,repo,now,...excluded);if(!task)return;
 const token=randomId();s.run('DELETE FROM task_claims WHERE task_id=?',task.id);s.run('INSERT OR IGNORE INTO task_claims(task_id,repository_id,token,claimed_at) VALUES(?,?,?,?)',task.id,repo,token,new Date(now).toISOString());
 if(s.get('SELECT token FROM task_claims WHERE task_id=?',task.id)?.token!==token)return;
 s.run("UPDATE tasks SET claim_token=?,status='running',updated_at=? WHERE id=?",token,new Date(now).toISOString(),task.id);
 traceEvent(s,task.id,'queue_claimed',{priority:task.priority,sequence:task.queue_seq},null,'scheduler');
 return {...task,claim_token:token,status:'running'};
 });
}

export function taskRelations(s:Store,id:string,offset=0){
 const total=s.get('SELECT count(*) n FROM task_relations WHERE source_task_id=? OR target_task_id=?',id,id)!.n;
 const items=s.all('SELECT * FROM task_relations WHERE source_task_id=? OR target_task_id=? ORDER BY created_at DESC,source_task_id,candidate_id,residual_key LIMIT 20 OFFSET ?',id,id,offset);
 return {items,total,next_offset:offset+items.length<total?offset+items.length:null};
}
