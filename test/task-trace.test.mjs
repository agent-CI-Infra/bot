import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobSha } from '../dist/agent/common.js';
import { Store } from '../dist/storage/database.js';
import { beginRun,endRun,interruptRuns,taskTrace,traceSource,traceSnapshot,traceEvent,retainedTextArtifact } from '../dist/tasks/trace.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { queries } from '../dist/app/queries.js';
function seed(s){s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','a/OpenToday','o','a')");s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','OpenToday release report','{}')");}
const url=(q='')=>new URL('http://local/api/tasks/t/events'+(q?q+'&':'?')+'include_data=1');
test('run snapshots survive reopen and input/config changes; interrupted run and recovery have stable ancestry',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bot155-')),path=join(dir,'db');let s=new Store(path,Buffer.alloc(32));try{seed(s);
 const run=beginRun(s,{id:'t'},'execution',{model:'fixed',prompt:'original',api_key:'secret'});
 s.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES('op','t',?,NULL,'pending')",JSON.stringify({type:'workspace_command',command:'npm test',token:'ghp_SECRET123456789012345678901234567890'}));
 s.run("UPDATE task_tools SET state='completed',result=? WHERE id='op'",JSON.stringify({exit_code:0,output:'actual observed result'}));
 s.run("UPDATE tasks SET input=? WHERE id='t'",JSON.stringify({request:'changed later'}));s.close();s=new Store(path,Buffer.alloc(32));interruptRuns(s);
 const next=beginRun(s,{id:'t'},'execution',{prompt:'resumed'});assert.equal(s.get('SELECT previous_run_id FROM task_runs WHERE id=?',next.id).previous_run_id,run.id);
 const first=taskTrace(s,'t',url('?include_snapshots=1'),'runs').runs[0];assert.equal(first.status,'interrupted');assert.equal(first.context_snapshot.data.input.request,undefined);assert.equal(first.config_snapshot.data.prompt,'original');assert.equal(first.config_snapshot.data.api_key,undefined);
 const ops=taskTrace(s,'t',url('?type=operation'),'events').events;assert.equal(ops.length,2);assert.equal(ops[0].run_id,run.id);assert.match(JSON.stringify(ops[1]),/actual observed result/);assert.doesNotMatch(JSON.stringify(ops),/SECRET/);
 assert.ok(traceSource(s,'t',ops[1].event_id).complete);assert.throws(()=>traceSource(s,'foreign',ops[1].event_id));
 endRun(s,next,'succeeded');endRun(s,next,'succeeded');assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='run_ended' AND run_id=?",next.id).n,1);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('events are transaction-bound, paginated, filterable and authorized without invented legacy runs',()=>{
 const s=new Store(':memory:',Buffer.alloc(32));try{seed(s);assert.equal(taskTrace(s,'t',url(),'runs').runs.length,0);
 const before=s.get('SELECT count(*) n FROM task_history').n;assert.throws(()=>s.transaction(()=>{s.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES('rollback','t','{}',NULL,'pending')");throw Error('fault');}));assert.equal(s.get('SELECT count(*) n FROM task_history').n,before);
 traceEvent(s,'t','contract',{revision:2});assert.equal(taskTrace(s,'t',url('?revision=2&type=contract'),'events').events.length,1);
 for(let i=0;i<3;i++)traceEvent(s,'t','intervention',{i},null,'user:owner');
 const first=taskTrace(s,'t',url('?type=intervention&limit=2'),'events');assert.equal(first.events.length,2);const second=taskTrace(s,'t',url('?type=intervention&limit=2&after='+first.next_after),'events');assert.equal(second.events.length,1);assert.equal(second.events[0].actor,'user:owner');assert.throws(()=>taskTrace(s,'t',url('?limit=-1'),'events'));
 assert.throws(()=>queries(s,{id:'outsider',role:'project_admin',repositories:[]},url()),/task_not_found/);
 }finally{s.close();}
});
test('legacy followups resolve exact acceptance events and replay never schedules more work',()=>{
 const s=new Store(':memory:',Buffer.alloc(32));try{seed(s);const r=new TaskRecords(s),c=r.submit('t',[{kind:'report',reference:'report.md',version:'v1',content:'core report'}],[],{});
 const verdict={outcome:'pass_with_issues',reason:'Core complete; citation fix separate',gaps:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true,residuals:[{key:'citation',description:'Fix citation',evidence:'specific bad key',impact:'citation accuracy',nonblocking_reason:'does not invalidate core report',goal:'Fix cited key',criteria:['key exists']}]};
 const a=r.decide('t',c.id,c.revision,verdict);assert.deepEqual(a.followups,[]);
 const child='legacy-child';s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,source_task_id) VALUES(?,'r','task.request','queued','Legacy citation correction','{}','t')",child);
 s.run("INSERT INTO task_followups VALUES('t',?,'citation',?)",c.id,child);
 s.run("UPDATE task_records SET acceptance=json_set(acceptance,'$.followups',json(?)) WHERE task_id='t'",JSON.stringify([child]));
 s.run("UPDATE task_history SET data=json_set(data,'$.followups',json(?)) WHERE task_id='t' AND type='acceptance'",JSON.stringify([child]));
 assert.deepEqual(r.decide('t',c.id,c.revision,verdict).followups,[child]);
 const links=taskTrace(s,child,url(),'lineage');assert.equal(links.parents[0].parent_id,'t');assert.ok(links.parents[0].acceptance_event_id);
 const cc=r.submit(child,[{kind:'report',reference:'report.md',version:'v2',content:'corrected key'}],[],{}),b=r.decide(child,cc.id,cc.revision,{...verdict,residuals:[{...verdict.residuals[0],key:'fence',goal:'Fix code fence'}]});assert.deepEqual(b.followups,[]);
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,source_task_id) VALUES('legacy-grandchild','r','task.request','completed','Legacy fence correction','{}',?)",child);
 s.run("INSERT INTO task_followups VALUES(?,?,'fence','legacy-grandchild')",child,cc.id);
 s.run("UPDATE task_history SET data=json_set(data,'$.followups',json(?)) WHERE task_id=? AND type='acceptance'",JSON.stringify(['legacy-grandchild']),child);
 assert.equal(taskTrace(s,'legacy-grandchild',url(),'lineage').parents[0].parent_id,child);
 assert.ok(taskTrace(s,'legacy-grandchild',url(),'lineage').parents[0].acceptance_event_id);
 assert.equal(s.get('SELECT count(*) n FROM tasks').n,3);
 }finally{s.close();}
});
test('bounded capture marks missing content and removes private reasoning and credentials',()=>{
 const captured=JSON.parse(traceSnapshot({api_key:'private',nested:JSON.stringify({authorization:'secret',content:'public'}),reasoning_content:'private thought',content:'public output'}));assert.equal(captured.complete,true);assert.doesNotMatch(JSON.stringify(captured),/private|secret/);
 const large=JSON.parse(traceSnapshot({text:'x'.repeat(3*1024*1024)}));assert.equal(large.complete,false);assert.equal(large.missing_reason,'capture_limit_exceeded');assert.ok(large.sha256);
});

test('task log pages use stable cursors, preserve public output and omit historical private model fields',()=>{
 const s=new Store(':memory:',Buffer.alloc(32));try{seed(s);
 const actor={id:'owner',role:'super_admin',repositories:[]},read=query=>queries(s,actor,new URL('http://local/api/tasks/t/logs'+query));
 for(let i=0;i<215;i++)s.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)','log-'+i,'t',JSON.stringify({type:'model',content:JSON.stringify({analysis:'public result '+i}),reasoning_content:'PRIVATE_REASONING_SENTINEL',debug:{thinking:'PRIVATE_REASONING_SENTINEL'}}),'same-time');
 const page=read('');assert.equal(page.logs.length,100);assert.equal(page.logs[0].id,'log-115');assert.equal(page.log_page.has_older,true);assert.equal(page.log_page.has_newer,false);
 assert.doesNotMatch(JSON.stringify(page),/PRIVATE_REASONING_SENTINEL/);assert.equal(JSON.parse(page.logs[0].content).content,JSON.stringify({analysis:'public result 115'}));
 const older=read('?before='+page.log_page.first_sequence);assert.equal(older.logs.length,100);assert.equal(older.logs[0].id,'log-15');assert.equal(older.log_page.has_older,true);
 const first=read('?before='+older.log_page.first_sequence);assert.equal(first.logs.length,15);assert.equal(first.log_page.has_older,false);
 s.run("INSERT INTO task_logs(id,task_id,content) VALUES('later','t','public tool output')");
 const tail=read('?after='+page.log_page.last_sequence);assert.deepEqual(tail.logs.map(l=>l.id),['later']);assert.equal(tail.log_page.has_newer,false);
 assert.equal(read('?after=0&limit=1').log_page.has_newer,true);
 assert.throws(()=>read('?limit=101'),/invalid_pagination/);assert.throws(()=>read('?before=1&after=2'),/invalid_pagination/);assert.throws(()=>read('?after=-1'),/invalid_pagination/);
 assert.throws(()=>queries(s,{id:'outsider',role:'project_admin',repositories:[]},new URL('http://local/api/tasks/t/logs?before=100')),/task_not_found/);
 }finally{s.close();}
});

test('detail polling returns a bounded history index and omits large candidate/operation bodies',()=>{
 const s=new Store(':memory:',Buffer.alloc(32));try{seed(s);const r=new TaskRecords(s);r.submit('t',[{kind:'report',reference:'large.json',version:'v',content:{text:'PAYLOAD_SENTINEL'.repeat(50000)}}],[{source:'test',version:'v',verified:false,result:{text:'PAYLOAD_SENTINEL'.repeat(50000)}}],{});
 for(let i=0;i<120;i++)s.run('INSERT INTO task_tools(id,task_id,request,result,state) VALUES(?,?,?,?,?)','op'+i,'t',JSON.stringify({command:'inspect',output:'PAYLOAD_SENTINEL'.repeat(1000)}),'{}','completed');
 const actor={id:'owner',role:'super_admin',repositories:[]},detail=queries(s,actor,new URL('http://local/api/tasks/t'));assert.equal(detail.history.length,50);assert.equal(detail.history_page.has_older,true);assert.ok(JSON.stringify(detail).length<30000);assert.doesNotMatch(JSON.stringify(detail),/PAYLOAD_SENTINEL/);
 const page=taskTrace(s,'t',new URL('http://local?limit=2&type=operation'),'events');assert.equal(page.events.length,2);assert.ok(page.events[0].data.body_omitted);assert.ok(traceSource(s,'t',page.events[0].event_id).complete);
 }finally{s.close();}
});
test('JSON delivery bytes remain exact unless explicitly sanitized, with captured hashes and completeness',()=>{
 const original='{\n  "token": "ordinary public value",\n  "analysis": [1, 2]\n}\n',data=Buffer.from(original),version=blobSha(data);
 const artifact=retainedTextArtifact('result.json',version,data,data.length,x=>x),wrapped=JSON.parse(traceSnapshot(artifact));assert.equal(wrapped.data.content,original);assert.equal(wrapped.data.complete,true);assert.equal(wrapped.data.captured_blob_sha,version);assert.equal(wrapped.data.sanitized,false);
 const redacted=retainedTextArtifact('result.json',version,data,data.length,x=>x.replace('public value','[REDACTED]'));assert.equal(redacted.read_complete,true);assert.equal(redacted.complete,false);assert.equal(redacted.sanitized,true);assert.notEqual(redacted.captured_blob_sha,version);assert.equal(redacted.missing_reason,'sanitized_representation');
});

test('near-limit escaped artifact text survives source retrieval and over-limit metadata remains available',()=>{
 const s=new Store(':memory:',Buffer.alloc(32));try{seed(s);const limit=2*1024*1024,line='"'.repeat(78)+'\n',text=line.repeat(Math.ceil((limit-1)/line.length)).slice(0,limit-1),bytes=Buffer.from(text),version=blobSha(bytes);
 const full=JSON.parse(traceSnapshot(retainedTextArtifact('large.md',version,bytes,bytes.length,x=>x)));assert.ok(full.original_bytes>limit);assert.equal(full.complete,true);assert.equal(full.data.content,text);assert.equal(full.data.captured_blob_sha,version);
 const event=traceEvent(s,'t','artifact_content',full),source=traceSource(s,'t',event);assert.equal(source.complete,true);assert.equal(source.data.content,text);assert.equal(source.data.version,version);
 const oversized=Buffer.from(text+'xx'),trimmed=JSON.parse(traceSnapshot(retainedTextArtifact('too-big.md',blobSha(oversized),oversized,oversized.length,x=>x)));assert.equal(trimmed.complete,false);assert.equal(trimmed.data.path,'too-big.md');assert.equal(trimmed.data.read_complete,true);assert.equal(trimmed.data.sanitized,false);assert.ok(trimmed.data.content_sha256);assert.ok(trimmed.data.captured_blob_sha);assert.equal(trimmed.data.content,undefined);assert.equal(trimmed.data.body_omitted,true);assert.equal(trimmed.data.content_preview,(text+'xx').slice(0,32000));
 }finally{s.close();}
});
