import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {recordRetryFailure,resolveRetry,pendingRetryReport,retryContext,retryNeedsInvestigation} from '../dist/tasks/retries.js';
import {assessRetryReport} from '../dist/roles/retries.js';
import {Redactor} from '../dist/agent/common.js';
import {workspace as runnerWorkspace} from '../runner/workspace.mjs';
import {randomWorkspaceId} from './helpers.mjs';

function setup(t,path=':memory:'){
 const s=new Store(path,Buffer.alloc(32,4));t.after(()=>s.close());
 s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/project','o','a')");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input) VALUES('t','r','development.issue','waiting_environment','prepare','Repair the actual failure','{}')");
 const records=new TaskRecords(s);records.contract('t',{goal:'Deliver the feature',scope:['src'],criteria:['Correct behavior'],endpoint:'artifact',source:{}});
 return {s,records,task:s.get("SELECT * FROM tasks WHERE id='t'")};
}
const failure=(n,group='execution:candidate_unavailable')=>({group,occurrence:'attempt:'+n,code:'candidate_unavailable',detail:'git write-tree failed:128; index is unmerged'});

test('retry reports are persisted at 3/6/9, survive a new Store/session/SHA, and do not pause the task',t=>{
 const dir=mkdtempSync(join(tmpdir(),'retry-report-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=setup(t,join(dir,'control.sqlite'));
 for(let n=1;n<=4;n++)recordRetryFailure(f.s,f.task,failure(n));
 const resumed=new Store(join(dir,'control.sqlite'),Buffer.alloc(32,4));
 try{
  resumed.run("UPDATE tasks SET head_sha=?,attempt=20 WHERE id='t'",'b'.repeat(40));
  for(let n=5;n<=9;n++)recordRetryFailure(resumed,resumed.get("SELECT * FROM tasks WHERE id='t'"),failure(n));
  recordRetryFailure(resumed,f.task,failure(9));
  assert.deepEqual(retryContext(resumed,'t').map(r=>r.count),[9,6,3]);
  assert.equal(resumed.get("SELECT count(*) n FROM task_history WHERE type='retry_failure'").n,9);
  assert.equal(resumed.get("SELECT status FROM tasks WHERE id='t'").status,'waiting_environment');
  const history=f.records.tool('t','read_task_history',{limit:20});assert.ok(history.observations.some(r=>r.type==='retry_failure'&&r.data.detail.includes('index is unmerged')));
  resolveRetry(resumed,'t','execution:candidate_unavailable');assert.equal(pendingRetryReport(resumed,'t'),undefined);
  for(let n=9;n<=11;n++)recordRetryFailure(resumed,f.task,failure(n));assert.equal(pendingRetryReport(resumed,'t').count,3,'a recovered group may fail on the same target again');
 }finally{resumed.close();}
});

const call=(name,args)=>({role:'assistant',tool_calls:[{id:Math.random().toString(36).slice(2),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
for(const action of ['continue_retry','investigate'])test(`Native Manager reads retained failure evidence then chooses ${action}`,async t=>{
 const f=setup(t);for(let n=1;n<=3;n++)recordRetryFailure(f.s,f.task,action==='investigate'?{group:'merge_checks',occurrence:'head:'+n,code:'pull_request_checks_failed',detail:JSON.stringify({check_runs:[{id:123,name:'Install packages',status:'completed',conclusion:'failure'}]})}:failure(n));const report=pendingRetryReport(f.s,'t');
 f.s.run("INSERT INTO settings VALUES('roles:r',?)",JSON.stringify({enabled:true,harnesses:{manager:'native'}}));
 const requests=[];const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  const input=JSON.parse(body.messages[1].content);
  const message=requests.length===1?call('read_task_record',{ref:report.failure_ref}):action==='investigate'&&requests.length===2?call('read_task_record',{ref:input.ci_evidence_refs[0]}):call('submit_retry_decision',{action,reason:'Read the retained failure and choose the next action'});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message}]}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 f.s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r',?,'fixture',?,'now')",'http://127.0.0.1:'+server.address().port+'/v1',f.s.secrets.seal({value:'test'},'model:m'));
 f.s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('r','m',1)");
 const github={request:async()=>({steps:[{name:'Install packages',conclusion:'failure'}]}),path:p=>p,jobLog:async()=>"Package liblz4-tool has no installation candidate"};
 const investigate=await assessRetryReport(f.s,f.task,{store:f.s,task:f.task},github,async()=>{},new Redactor());
 assert.equal(investigate,action==='investigate');assert.equal(requests.length,action==='investigate'?3:2,JSON.stringify(f.s.all("SELECT data FROM task_history WHERE type='retry_notification_fault'")));
 assert.match(JSON.stringify(requests[1].messages),action==='investigate'?/Install packages/:/index is unmerged/);assert.equal(pendingRetryReport(f.s,'t'),undefined);
 assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='retry_decision'").n,1);
 assert.equal(retryNeedsInvestigation(f.s,'t'),action==='investigate');
 if(action==='investigate'){resolveRetry(f.s,'t','merge_checks');assert.equal(retryNeedsInvestigation(f.s,'t'),false);}
 assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,'waiting_environment');
 if(action==='investigate')assert.match(JSON.stringify(requests.at(-1).messages),/liblz4-tool has no installation candidate/);
});

test('runner finalize failure retains the Git stderr instead of an unexplained exit 128',async t=>{
 const root=mkdtempSync(join(tmpdir(),'retry-git-stderr-')),id=randomWorkspaceId();t.after(()=>rmSync(root,{recursive:true,force:true}));
 const run=request=>runnerWorkspace({...request,workspace_id:id},join(root,'tasks'),join(root,'git'),join(root,'notes'));
 await run({type:'workspace_init'});execFileSync('git',['init','-q'],{cwd:join(root,'tasks',id,'repo')});const gitdir=join(root,'tasks',id,'repo','.git');writeFileSync(join(gitdir,'index.lock'),'fixture lock');
 await assert.rejects(run({type:'workspace_finalize'}),error=>/git add failed: 128/.test(error.message)&&/index.lock/.test(error.message));
});
