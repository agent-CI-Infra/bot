import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {relatedDeliveries,relatedDeliveryIndex,relatedIndexBudget,readRelatedArtifact} from '../dist/tasks/related.js';
import {Workspace} from '../dist/agent/workspace.js';
import {Redactor} from '../dist/agent/common.js';
function fixture(t,count=7,files=2200){
 const s=new Store(':memory:',Buffer.alloc(32,7));t.after(()=>s.close());s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");s.run("INSERT INTO repositories VALUES('other','fixture/other','1','a')");
 const records=new TaskRecords(s),add=(id,repo='r')=>{s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,workspace_id,generation) VALUES(?,?,'task.request','running',?,'{}',?,1)",id,repo,id,'workspace-'+id);records.contract(id,{goal:'Complete '+id+' '+ 'goal '.repeat(400),scope:['feature'],criteria:['required behavior'],endpoint:'artifact'});};add('root');add('foreign','other');
 for(let i=0;i<count;i++){const id='child-'+String(i).padStart(2,'0');add(id);s.run("INSERT INTO task_children VALUES('root',?,'now')",id);const revision=records.get(id).revision;s.run("UPDATE task_records SET candidate=?,acceptance=? WHERE task_id=?",JSON.stringify({id:'candidate-'+id,revision,artifacts:[{kind:'code',reference:'task:'+id+':candidate',version:'b'.repeat(40),content:{local_sha:'c'.repeat(40),files:Array.from({length:files},(_,n)=>({path:'crates/unit/file-'+String(n).padStart(5,'0')+'.rs',sha:'d'.repeat(40)}))}}]}),JSON.stringify({outcome:'pass',candidate_id:'candidate-'+id,revision}),id);s.run("UPDATE tasks SET status='pr_opened' WHERE id=?",id);}
 const task=s.get("SELECT * FROM tasks WHERE id='root'"),calls=[];
 const manager={call:async(_method,_path,body)=>{calls.push(body);return {ok:true,result:{content:'pinned-content\n'.repeat(1000),version:body.request.sha}};}};
 const workspace=new Workspace(s,manager,task,new Redactor(),async()=>{},()=>{});return {s,records,task,workspace,calls};
}
test('large related repositories remain compact, disclose omissions and page every delivery',async t=>{
 const f=fixture(t),related=relatedDeliveries(f.s,f.task),index=relatedDeliveryIndex(related);
 assert.ok(JSON.stringify(index).length<relatedIndexBudget+2000);assert.equal(index.total,7);assert.equal(index.next_offset,5);
 assert.ok(index.deliveries.every(d=>d.file_count===2200&&!('files' in d)&&d.goal_truncated));
 const page=await readRelatedArtifact(f.s,f.task,f.workspace,index.discovery.arguments);assert.equal(page.deliveries.length,2);assert.equal(page.next_offset,null);assert.equal(f.calls.length,0);
 const metadata=await readRelatedArtifact(f.s,f.task,f.workspace,{task_id:'child-00',section:'contract',length:100});assert.equal(metadata.complete,false);assert.equal(metadata.content.length,100);assert.ok(metadata.next_offset>0);
});
test('file manifests filter and paginate; immutable content is chunked and candidate changes never masquerade as the old version',async t=>{
 const f=fixture(t,1),args={task_id:'child-00',candidate_id:'candidate-child-00',directory:'crates/unit/',query:'file-000',limit:17};
 let next=0;const seen=[];
 do{const page=await readRelatedArtifact(f.s,f.task,f.workspace,{...args,offset:next});assert.equal(page.matching_files,100);assert.equal(page.total_files,2200);assert.ok(page.files.length<=17);seen.push(...page.files);next=page.next_offset;}while(next!==null);
 assert.equal(new Set(seen).size,100);assert.equal(f.calls.length,0);
 const first=await readRelatedArtifact(f.s,f.task,f.workspace,{task_id:'child-00',candidate_id:args.candidate_id,path:seen[0],length:100});assert.equal(first.content.length,100);assert.equal(first.complete,false);assert.equal(first.blob_sha,'d'.repeat(40));assert.equal(f.calls[0].request.sha,'c'.repeat(40));assert.equal(f.calls[0].request.workspace_id,'workspace-child-00');
 const second=await readRelatedArtifact(f.s,f.task,f.workspace,{task_id:'child-00',candidate_id:args.candidate_id,path:seen[0],length:100,offset:first.next_offset});assert.equal(second.offset,100);
 assert.equal((await readRelatedArtifact(f.s,f.task,f.workspace,{task_id:'child-00',candidate_id:'old-candidate',path:seen[0]})).error,'related_candidate_changed');
 for(const input of [{task_id:'foreign',path:'secret'},{task_id:'child-00',path:'../secret'},{task_id:'child-00',directory:'../secret'},{offset:-1},{limit:101}])assert.ok((await readRelatedArtifact(f.s,f.task,f.workspace,input)).error);
 assert.equal(f.s.get("SELECT count(*) n FROM task_tools WHERE task_id<>'root'").n,0);
});
test('an oversized metadata entry is explicit and its original remains readable in chunks',async t=>{
 const f=fixture(t,1),candidate=JSON.parse(f.s.get("SELECT candidate FROM task_records WHERE task_id='child-00'").candidate);
 candidate.artifacts[0].version='v'.repeat(relatedIndexBudget+1);
 f.s.run("UPDATE task_records SET candidate=? WHERE task_id='child-00'",JSON.stringify(candidate));
 const index=relatedDeliveryIndex(relatedDeliveries(f.s,f.task));
 assert.equal(index.error,'related_index_entry_too_large');assert.equal(index.omitted_task_id,'child-00');
 const result=await readRelatedArtifact(f.s,f.task,f.workspace,index.discovery.arguments);
 assert.equal(result.section,'delivery');assert.equal(result.complete,false);assert.ok(result.content.length<=8000);
});

test('complete indexes offer no phantom next page, and full delivery metadata clears summary truncation',async t=>{
 const f=fixture(t,1),index=relatedDeliveryIndex(relatedDeliveries(f.s,f.task));assert.equal(index.complete,true);assert.equal(index.discovery,undefined);
 const result=await readRelatedArtifact(f.s,f.task,f.workspace,{task_id:'child-00',section:'delivery',length:16000}),metadata=JSON.parse(result.content);
 assert.equal(result.complete,true);assert.ok(metadata.goal.length>600);assert.equal(metadata.goal_truncated,false);
});
test('a pathological oversized manifest entry is explicit and cannot trap pagination at the same offset',async t=>{
 const f=fixture(t,1,1),candidate=JSON.parse(f.s.get("SELECT candidate FROM task_records WHERE task_id='child-00'").candidate);
 candidate.artifacts[0].content.files.unshift({path:'x'.repeat(relatedIndexBudget+1),sha:'a'.repeat(40)});f.s.run("UPDATE task_records SET candidate=? WHERE task_id='child-00'",JSON.stringify(candidate));
 const first=await readRelatedArtifact(f.s,f.task,f.workspace,{task_id:'child-00',limit:1});assert.equal(first.error,'related_file_entry_too_large');assert.equal(first.next_offset,1);assert.ok(first.omitted_path_preview.length<=200);
 const next=await readRelatedArtifact(f.s,f.task,f.workspace,{task_id:'child-00',offset:first.next_offset,limit:1});assert.equal(next.files.length,1);assert.equal(next.next_offset,null);
});
