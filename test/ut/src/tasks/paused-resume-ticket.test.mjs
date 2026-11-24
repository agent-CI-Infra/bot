import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../../../dist/storage/database.js';
import {TaskCommands} from '../../../../dist/tasks/commands.js';
import {claimQueuedTask} from '../../../../dist/tasks/priority.js';
const kind="kind='task.request'";
function fixture(t){
 const s=new Store(':memory:',Buffer.alloc(32,7));t.after(()=>{try{s.close();}catch{}});
 s.run("INSERT OR IGNORE INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT OR IGNORE INTO repositories VALUES('r','fixture/repo','o','a')");s.run("INSERT OR IGNORE INTO policies(repository_id,enabled,task_concurrency) VALUES('r',1,2)");
 const create=(id,status='queued',error=null)=>s.run("INSERT INTO tasks(id,repository_id,kind,status,error_code,summary,input,priority,created_at,updated_at) VALUES(?,'r','task.request',?,?,?,'{}','P2',?,?)",id,status,error,id,new Date().toISOString(),new Date().toISOString());
 return {s,create,commands:new TaskCommands(s),owner:{id:'u',username:'u',role:'super_admin',repositories:[]}};
}
const seq=(f,id)=>Number(f.s.get('SELECT queue_seq FROM tasks WHERE id=?',id).queue_seq);

test('a task paused by the user keeps its queue ticket when it is continued',t=>{
 const f=fixture(t);f.create('first');f.create('second');const ticket=seq(f,'first');
 f.commands.api(f.owner,'POST',new URL('http://local/api/tasks/first/pause'),{});
 assert.equal(f.s.get('SELECT status FROM tasks WHERE id=?','first').status,'paused');
 f.commands.api(f.owner,'POST',new URL('http://local/api/tasks/first/retry'),{});
 const resumed=f.s.get('SELECT status,error_code FROM tasks WHERE id=?','first');
 assert.equal(resumed.status,'queued');assert.equal(resumed.error_code,null);
 assert.equal(seq(f,'first'),ticket,'the continued task keeps the queue ticket it held');
 assert.equal(claimQueuedTask(f.s,'r',kind,1).id,'first');
});

test('a task that was created paused still joins the back of the queue when it is started',t=>{
 const f=fixture(t);f.create('draft','paused');f.create('queued');const before=seq(f,'draft');
 f.commands.api(f.owner,'POST',new URL('http://local/api/tasks/draft/retry'),{});
 assert.ok(seq(f,'draft')>before);
 assert.equal(claimQueuedTask(f.s,'r',kind,1).id,'queued');
});

test('resuming with a new configuration is a replan, so it joins the back of the queue',t=>{
 const f=fixture(t);f.create('replanned');f.create('waiting');const before=seq(f,'replanned');
 f.commands.api(f.owner,'POST',new URL('http://local/api/tasks/replanned/pause'),{});
 f.commands.api(f.owner,'POST',new URL('http://local/api/tasks/replanned/adopt-config'),{});
 assert.ok(seq(f,'replanned')>before);
 assert.equal(claimQueuedTask(f.s,'r',kind,1).id,'waiting');
});

// The previous release's rule, verbatim: every entry into a queue state took a new ticket.
const previousReentry=`DROP TRIGGER IF EXISTS task_queue_reentry;
 CREATE TRIGGER task_queue_reentry AFTER UPDATE OF status,priority ON tasks
 WHEN OLD.priority<>NEW.priority OR (OLD.status<>NEW.status AND NEW.status IN ('queued','retry_wait','waiting_configuration','waiting_environment','waiting_pr_head')) BEGIN
 UPDATE task_queue_counter SET value=value+1 WHERE id=1;
 UPDATE tasks SET queue_seq=(SELECT value FROM task_queue_counter WHERE id=1) WHERE id=NEW.id;
 INSERT INTO task_history(task_id,type,data,created_at) VALUES(NEW.id,'queue_entered',json_object('priority',NEW.priority,'previous_status',OLD.status,'status',NEW.status,'sequence',(SELECT value FROM task_queue_counter WHERE id=1)),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;`;

test('a database written by the previous release adopts the new rule and keeps the tickets it already had',t=>{
 const dir=mkdtempSync(join(tmpdir(),'queue-ticket-')),path=join(dir,'control.sqlite'),key=Buffer.alloc(32,9);
 let s=new Store(path,key);t.after(()=>{try{s.close();}catch{}try{rmSync(dir,{recursive:true,force:true});}catch{}});
 s.run("INSERT OR IGNORE INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT OR IGNORE INTO repositories VALUES('r','fixture/repo','o','a')");s.run("INSERT OR IGNORE INTO policies(repository_id,enabled,task_concurrency) VALUES('r',1,2)");
 const create=id=>s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,priority,created_at,updated_at) VALUES(?,'r','task.request','queued',?,'{}','P2',?,?)",id,id,new Date().toISOString(),new Date().toISOString());
 create('kept');create('parked');
 const owner={id:'u',username:'u',role:'super_admin',repositories:[]};
 new TaskCommands(s).api(owner,'POST',new URL('http://local/api/tasks/parked/pause'),{});
 const kept=seq({s},'kept'),parked=seq({s},'parked');
 s.db.exec(previousReentry); // a database written before #1318 carries this definition
 s.close();
 s=new Store(path,key);
 assert.match(s.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='task_queue_reentry'").sql,/user_pause/,'reopening replaces the previous rule');
 assert.deepEqual([seq({s},'kept'),seq({s},'parked')],[kept,parked],'tickets recorded before the upgrade survive it');
 new TaskCommands(s).api(owner,'POST',new URL('http://local/api/tasks/parked/retry'),{});
 assert.equal(seq({s},'parked'),parked,'the adopted rule keeps the ticket of a task paused before the upgrade');
 assert.equal(claimQueuedTask(s,'r',kind,1).id,'kept');
});
