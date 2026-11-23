import type {Store,Row} from '../storage/database.js';
import {explainFailure,type FailureCause} from '../agent/failures.js';
import {traceEvent} from './trace.js';

const returned=['completed','succeeded','pr_opened','failed','cancelled','superseded','needs_help','needs_replan','paused'];
// A child in one of these states has stopped before returning: its own retry/configuration wait is the reason the parent
// cannot make progress, not a result the parent may consume.
const blockedWaits=new Set(['waiting_environment','waiting_configuration']);
const recovery:Record<string,string>={'waiting_environment':'环境或外部条件恢复后子任务会自动继续。','waiting_configuration':'按子任务说明修正配置后子任务会自动继续。'};
// The aggregate names the settings page each child's own cause points at; a cause without one stays neutral so the callout
// only offers the child entries instead of guessing a page.
const destinations:Partial<Record<FailureCause,{section:string;caption:string}>>={
 environment:{section:'machine',caption:'检查项目电脑'},
 role_configuration:{section:'roles',caption:'打开角色配置'},
 model:{section:'model',caption:'打开项目模型配置'},
};
const labels:Partial<Record<FailureCause,string>>={
 environment:'子任务等待项目电脑或运行环境',
 role_configuration:'子任务等待配置',
 model:'子任务等待模型配置',
 repository:'子任务等待仓库内容或规则修正',
 bot:'子任务等待处理',
};
const actions:Partial<Record<FailureCause,string>>={
 environment:'检查项目电脑或运行环境，并打开子任务查看各自的阻塞原因；条件恢复后子任务会自动继续。',
 role_configuration:'按子任务说明修正项目、角色或集成配置；条件满足后子任务会自动继续。',
 model:'按子任务说明修正项目模型配置；条件满足后子任务会自动继续。',
 repository:'按子任务说明修正仓库内容或规则；条件满足后子任务会自动继续。',
};
const neutralLabel='子任务分别等待不同原因';
const neutralAction='请打开子任务查看各自的阻塞原因；条件恢复后子任务会自动继续。';
const recoveryByCause:Partial<Record<FailureCause,string>>={
 environment:'环境或外部条件恢复后子任务会自动继续。',
 role_configuration:'按子任务说明修正项目、角色或集成配置后子任务会自动继续。',
 model:'按子任务说明修正模型配置后子任务会自动继续。',
 repository:'按子任务说明修正仓库内容或规则后子任务会自动继续。',
 github_access:'按子任务说明修正 GitHub 权限或安装配置后子任务会自动继续。',
 bot:'这是 bot 自身的问题，与环境和配置无关；自动重试后子任务会继续，反复出现请反馈给 bot 维护者。',
};
function waitCause(status:string,code:string|null):{cause:FailureCause|null;recovery:string}{
 const explained=code?explainFailure(code,status):null;
 const cause=explained?.cause as FailureCause|null ?? null;
 return {cause,recovery:(cause&&recoveryByCause[cause])||recovery[status]||'等待外部条件恢复后子任务会自动继续。'};
}
/** The parent's own explanation when every unreturned child is waiting on an outside condition. */
export function childBlockSummary(children:any[]){
 const pending=children.filter(t=>!returned.includes(t.status));
 if(!pending.length||pending.some(t=>!blockedWaits.has(t.status)))return null;
 const statuses=[...new Set(pending.map(t=>t.status))];
 const error_codes=[...new Set(pending.map(t=>t.reason??t.error_code).filter((code:unknown):code is string=>typeof code==='string'&&!!code))];
 const rows=pending.map(t=>{
  const code=typeof t.reason==='string'?t.reason:typeof t.error_code==='string'?t.error_code:null;
  const {cause,recovery:childRecovery}=waitCause(t.status,code);
  return {id:t.id,status:t.status,error_code:code,summary:t.summary??null,next_action:t.progress?.next_action??null,cause,recovery:childRecovery,
   child:{id:t.id,status:t.status,error_code:code,summary:t.summary??null,next_action:t.progress?.next_action??null,recovery:childRecovery}};
 });
 const causes=[...new Set(rows.map(row=>row.cause))];
 // Every child points at the same setting; otherwise the aggregate stays neutral and only lists the children.
 const cause=causes.length===1?causes[0]:null;
 return {
  count:pending.length,statuses,error_codes,cause,destination:(cause&&destinations[cause])||null,
  mixed:causes.length>1,
  label:(cause&&labels[cause])||neutralLabel,
  action:(cause&&actions[cause])||neutralAction,
  children:rows.map(row=>row.child),
 };
}
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
 return {parent_id:parentRow?.id??null,parent:parentRow?{id:parentRow.id,revision:parentRow.revision,contract:JSON.parse(parentRow.contract),query_tool:'read_managed_task'}:null,children,
  blocked:childBlockSummary(children),events,after_event_id:last,
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
