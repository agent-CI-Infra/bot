import type {Store,Row} from '../storage/database.js';
import {traceEvent} from './trace.js';

const returned=['completed','succeeded','pr_opened','failed','cancelled','superseded','needs_help','needs_replan','paused'];
export function childTaskStorage(s:Store){
 s.db.exec(`CREATE TABLE IF NOT EXISTS task_children(parent_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 child_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS children_parent ON task_children(parent_id);
 CREATE TABLE IF NOT EXISTS task_child_events(id INTEGER PRIMARY KEY AUTOINCREMENT,parent_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 child_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,status TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS child_events_parent ON task_child_events(parent_id,id);
 CREATE TABLE IF NOT EXISTS task_child_waits(parent_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,after_event_id INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS child_task_returned AFTER UPDATE OF status ON tasks
 WHEN OLD.status<>NEW.status AND NEW.status IN (${returned.map(v=>"'"+v+"'").join(',')}) BEGIN
 INSERT INTO task_child_events(parent_id,child_id,status,reason,created_at)
 SELECT parent_id,NEW.id,NEW.status,NEW.error_code,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM task_children WHERE child_id=NEW.id; END;`);
}
/** Called only inside the authorized create_task transaction, never with a model supplied parent id. */
export function attachChild(s:Store,parent:string,child:string){
 if(parent===child||!s.get('SELECT c.id FROM tasks c JOIN tasks p ON p.repository_id=c.repository_id WHERE c.id=? AND p.id=?',child,parent))throw new Error('invalid_child_task');
 s.run('INSERT OR IGNORE INTO task_children VALUES(?,?,?)',parent,child,new Date().toISOString());
 const t=s.get('SELECT status,error_code FROM tasks WHERE id=?',child)!;
 // A deliberately unstarted task is not a returned execution.
 if(returned.includes(t.status)&&t.status!=='paused')s.run('INSERT INTO task_child_events(parent_id,child_id,status,reason,created_at) VALUES(?,?,?,?,?)',parent,child,t.status,t.error_code,new Date().toISOString());
 traceEvent(s,parent,'child_task_created',{child_id:child},null,'framework');
 traceEvent(s,child,'parent_task_linked',{parent_id:parent},null,'framework');
}
export function childTaskContext(s:Store,parent:string,after?:number){
 const cursor=after??s.get('SELECT after_event_id FROM task_child_waits WHERE parent_id=?',parent)?.after_event_id??0;
 const children=s.all(`SELECT t.id,t.summary,t.status,t.phase,t.error_code,t.result,r.revision,r.candidate,r.acceptance,r.completed,r.next_action
 FROM task_children c JOIN tasks t ON t.id=c.child_id JOIN task_records r ON r.task_id=t.id WHERE c.parent_id=? ORDER BY c.created_at,c.child_id`,parent).map(t=>{
  const candidate=JSON.parse(t.candidate||'null');return {id:t.id,summary:t.summary,status:t.status,phase:t.phase,reason:t.error_code,revision:t.revision,
   progress:{completed:JSON.parse(t.completed),next_action:t.next_action},result:JSON.parse(t.result||'null'),acceptance:JSON.parse(t.acceptance||'null'),
   candidate:candidate?{id:candidate.id,artifacts:candidate.artifacts.map(({kind,reference,version}:any)=>({kind,reference,version}))}:null,
   record_ref:'task:'+t.id,query_tool:'read_managed_task'};
 });
 const events=s.all('SELECT * FROM task_child_events WHERE parent_id=? AND id>? ORDER BY id LIMIT 100',parent,cursor);
 const last=events.at(-1)?.id??cursor;
 const parentRow=s.get('SELECT t.id,r.contract,r.revision FROM task_children c JOIN tasks t ON t.id=c.parent_id JOIN task_records r ON r.task_id=t.id WHERE c.child_id=?',parent);
 return {parent_id:parentRow?.id??null,parent:parentRow?{id:parentRow.id,revision:parentRow.revision,contract:JSON.parse(parentRow.contract),query_tool:'read_managed_task'}:null,children,events,after_event_id:last,
  more:!!s.get('SELECT id FROM task_child_events WHERE parent_id=? AND id>?',parent,last)};
}
export function waitForChildren(s:Store,task:Row,args:any){
 if(!Number.isSafeInteger(args?.after_event_id)||args.after_event_id<0||typeof args.reason!=='string'||!args.reason.trim())return {error:'invalid_child_wait'};
 return s.transaction(()=>{
  const max=s.get('SELECT coalesce(max(id),0) id FROM task_child_events WHERE parent_id=?',task.id)!.id;
  const previous=s.get('SELECT after_event_id FROM task_child_waits WHERE parent_id=?',task.id)?.after_event_id??0;
  if(args.after_event_id>max||args.after_event_id<previous)return {error:'invalid_child_cursor'};
  const ctx=childTaskContext(s,task.id,args.after_event_id);
  if(!ctx.children.length)return {error:'no_child_tasks'};
  s.run('INSERT INTO task_child_waits VALUES(?,?) ON CONFLICT(parent_id) DO UPDATE SET after_event_id=excluded.after_event_id',task.id,args.after_event_id);
  if(ctx.events.length)return {waiting:false,...ctx};
  const pending=ctx.children.some(t=>!returned.includes(t.status));
  if(!pending)return {waiting:false,...ctx,instruction:'No child is executing. Decide the next work or integration; do not wait on already returned results.'};
  traceEvent(s,task.id,'children_waiting',{after_event_id:args.after_event_id,reason:args.reason},task.trace_run_id,'role:manager');
  return {waiting:true,...ctx};
 });
}
export function resumeParentTasks(s:Store,active:(id:string)=>boolean){
 for(const t of s.all("SELECT t.id FROM tasks t JOIN task_child_waits w ON w.parent_id=t.id WHERE t.status='waiting_coordination' AND t.error_code='task_children_pending' AND EXISTS(SELECT 1 FROM task_child_events e WHERE e.parent_id=t.id AND e.id>w.after_event_id)")){
  if(active(t.id))continue;
  s.transaction(()=>{const changed=s.run("UPDATE tasks SET status='queued',phase='model',error_code=NULL,next_run_at=0,attempt=attempt+1,updated_at=? WHERE id=? AND status='waiting_coordination' AND error_code='task_children_pending'",new Date().toISOString(),t.id);
   if(changed.changes)traceEvent(s,t.id,'children_resumed',{events:childTaskContext(s,t.id).events.map(e=>e.id)},null,'framework');});
 }
}
