import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {traceEvent} from '../dist/tasks/trace.js';
const verdict=outcome=>({outcome,reason:'Candidate evidence',gaps:outcome==='pass'?[]:['Missing CI evidence'],residuals:[],core_complete:true,required_evidence_complete:outcome==='pass',acceptable_risk:true});
test('QA rejection reports count 3/6/9 without stopping, passes do not reset, repeated receipts do not double count',t=>{
 const s=new Store(':memory:',Buffer.alloc(32,4));t.after(()=>s.close());s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/project','o','a')");s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','fixture','{}')");const r=new TaskRecords(s);r.contract('t',{goal:'fixture',scope:[],criteria:['CI evidence'],endpoint:'artifact'});
 for(let n=1;n<=9;n++){
  s.run("UPDATE tasks SET status='running' WHERE id='t'");const c=r.submit('t',[{kind:'report',reference:'report:'+n,version:String(n)}],[],{});
  traceEvent(s,'t','acceptance_evaluated',{evaluation_id:'qa:'+n,candidate_id:c.id,verdict:verdict('return')});
  r.decide('t',c.id,c.revision,verdict('return'),'running',false);r.decide('t',c.id,c.revision,verdict('return'),'running',false);
  assert.equal(s.get("SELECT status FROM tasks WHERE id='t'").status,'queued');
  if(n===4){s.run("UPDATE tasks SET status='running' WHERE id='t'");const p=r.submit('t',[{kind:'report',reference:'pass',version:'pass'}],[],{});traceEvent(s,'t','acceptance_evaluated',{evaluation_id:'pass',candidate_id:p.id,verdict:verdict('pass')});r.decide('t',p.id,p.revision,verdict('pass'),'running',false);}
 }
 assert.deepEqual(s.all("SELECT data FROM task_history WHERE type='retry_report'").map(x=>JSON.parse(x.data).count),[3,6,9]);
 assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='acceptance' AND json_extract(data,'$.outcome')='return'").n,9);
});
