import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {LocalManager} from '../dist/projects/local-manager.js';
import {Store} from '../dist/storage/database.js';
import {blobSha,treeSha,sha} from '../dist/agent/common.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {requestIntegration,authorizeMerge,integratedPublication} from '../dist/tasks/integration.js';

async function local(t){
 const root=mkdtempSync(join(tmpdir(),'bot-integration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const manager=new LocalManager('101',root);await manager.call('PUT','/v1/projects/101');
 const call=async(id,request)=>{const value=await manager.call('POST','/v1/projects/101/execute',{generation:1,operation_id:randomBytes(24).toString('hex'),request:{workspace_id:id,...request}});assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
 const write=(id,path,content,snapshot=false)=>call(id,{type:'workspace_write',path,base64:Buffer.from(content).toString('base64'),offset:0,final:true,mode:'100644',snapshot,sha:blobSha(Buffer.from(content))});
 const init=async(id,files)=>{await call(id,{type:'workspace_init'});for(const [path,body] of Object.entries(files))await write(id,path,body,true);return call(id,{type:'workspace_snapshot',tree_sha:treeSha(Object.entries(files).map(([path,body])=>({path,mode:'100644',sha:blobSha(Buffer.from(body))})))});};
 return {root,manager,call,write,init};
}

test('real Git integrates independent changes while retaining the original candidate and new main',async t=>{
 const h=await local(t),old='a'.repeat(48),next='b'.repeat(48),base=await h.init(old,{'keep.txt':'unchanged\n','one.txt':'before\n'});
 await h.write(old,'one.txt','candidate\n');const candidate=await h.call(old,{type:'workspace_finalize'});
 await h.init(next,{'keep.txt':'unchanged\n','one.txt':'before\n','other.txt':'already merged\n'});
 const integrated=await h.call(next,{type:'workspace_integrate',source_workspace_id:old,sha:candidate.local_sha,tree_sha:candidate.tree_sha,base_tree:base.tree_sha});
 assert.equal(integrated.merged,true);assert.deepEqual(integrated.conflicts,[]);
 assert.equal((await h.call(next,{type:'workspace_read',path:'one.txt'})).content,'candidate\n');
 assert.equal((await h.call(next,{type:'workspace_read',path:'other.txt'})).content,'already merged\n');
 assert.equal((await h.call(old,{type:'workspace_read',path:'one.txt'})).content,'candidate\n');
 assert.deepEqual((await h.call(next,{type:'workspace_integration_check'})).unresolved,[]);
});

test('real textual conflict is retained for the same writer and cannot be submitted with markers',async t=>{
 const h=await local(t),old='c'.repeat(48),next='d'.repeat(48),base=await h.init(old,{'shared.txt':'old\n'});
 await h.write(old,'shared.txt','our change\n');const candidate=await h.call(old,{type:'workspace_finalize'});
 await h.init(next,{'shared.txt':'their change\n'});
 const value=await h.call(next,{type:'workspace_integrate',source_workspace_id:old,sha:candidate.local_sha,tree_sha:candidate.tree_sha,base_tree:base.tree_sha});
 assert.equal(value.merged,false);assert.deepEqual(value.conflicts,['shared.txt']);
 assert.deepEqual((await h.call(next,{type:'workspace_integration_check'})).unresolved,['shared.txt']);
 await h.write(next,'shared.txt','both changes reconciled\n');
 assert.deepEqual((await h.call(next,{type:'workspace_integration_check'})).unresolved,[]);
 const fixed=await h.call(next,{type:'workspace_finalize'});assert.notEqual(fixed.tree_sha,candidate.tree_sha);
});

test('textually clean combination can fail behavior verification without losing either feature',async t=>{
 const h=await local(t),old='e'.repeat(48),next='f'.repeat(48),check="const fs=require('fs');if(Number(fs.readFileSync('a.txt'))*Number(fs.readFileSync('b.txt'))>2)process.exit(1);";
 const files={'a.txt':'1','b.txt':'1','check.cjs':check},base=await h.init(old,files);
 await h.write(old,'a.txt','2');const candidate=await h.call(old,{type:'workspace_finalize'});
 assert.equal((await h.call(old,{type:'workspace_command',command:'node check.cjs',timeout_ms:5000})).exit_code,0);
 await h.init(next,{...files,'b.txt':'2'});
 assert.equal((await h.call(next,{type:'workspace_command',command:'node check.cjs',timeout_ms:5000})).exit_code,0);
 assert.equal((await h.call(next,{type:'workspace_integrate',source_workspace_id:old,sha:candidate.local_sha,tree_sha:candidate.tree_sha,base_tree:base.tree_sha})).merged,true);
 assert.equal((await h.call(next,{type:'workspace_command',command:'node check.cjs',timeout_ms:5000})).exit_code,1);
 assert.equal((await h.call(next,{type:'workspace_read',path:'a.txt'})).content,'2');assert.equal((await h.call(next,{type:'workspace_read',path:'b.txt'})).content,'2');
});

test('integration and explicit merge intent survive SQLite reopen; candidate changes require fresh QA',t=>{
 const root=mkdtempSync(join(tmpdir(),'bot-integration-state-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const key=randomBytes(32),file=join(root,'control.sqlite');let s=new Store(file,key);
 s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','')");s.run("INSERT INTO repositories VALUES('101','fixture/project','1','a')");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,workspace_id,head_sha) VALUES('t','101','development.issue','running','goal','{}',?,?)",'a'.repeat(48),'1'.repeat(40));
 let records=new TaskRecords(s);records.contract('t',{goal:'goal',scope:['feature'],criteria:['behavior'],endpoint:'reviewable_pull_request'});
 const old=records.submit('t',[{kind:'code',reference:'source',version:'2'.repeat(40)}],[],{});
 records.decide('t',old.id,old.revision,{outcome:'pass',reason:'old candidate only',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true,policy_hash:sha('')},'pr_opened');
 s.run('INSERT INTO development_candidates VALUES(?,?)','t',JSON.stringify({source_workspace_id:'a'.repeat(48),local_sha:'3'.repeat(40),tree_sha:'2'.repeat(40),source_tree:'4'.repeat(40),base_sha:'1'.repeat(40)}));
 s.run("UPDATE tasks SET workspace_id=? WHERE id='t'",'b'.repeat(48));
 const actor={id:'operator',role:'super_admin',repositories:[]};authorizeMerge(s,s.get("SELECT * FROM tasks WHERE id='t'"),actor,'5'.repeat(40),'squash');
 requestIntegration(s,s.get("SELECT * FROM tasks WHERE id='t'"),'6'.repeat(40),'default_branch_advanced',{head:{sha:'5'.repeat(40)},number:1});
 assert.equal(s.get("SELECT status FROM tasks WHERE id='t'").status,'queued');s.close();s=new Store(file,key);t.after(()=>s.close());records=new TaskRecords(s);
 const task=s.get("SELECT * FROM tasks WHERE id='t'"),input=JSON.parse(task.input);assert.equal(input.integration.sha,'3'.repeat(40));assert.equal(input.integration.source_workspace_id,'a'.repeat(48),'candidate provenance survives a replaced execution workspace');assert.equal(input.integration.previous_candidate,old.id);
 assert.equal(s.get("SELECT state FROM task_merge_requests WHERE task_id='t'").state,'integrating');
 records.submit('t',[{kind:'code',reference:'source',version:'7'.repeat(40)}],[],{});assert.equal(records.get('t').acceptance,null);
 integratedPublication(s,task,'8'.repeat(40));assert.equal(s.get("SELECT expected_sha FROM task_merge_requests WHERE task_id='t'").expected_sha,'8'.repeat(40));
 assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='merge_candidate_revalidated'").n,1);
 integratedPublication(s,task,'8'.repeat(40));assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='merge_candidate_revalidated'").n,1);
});

test('memory and execution provenance bind the integrated baseline separately from the owned PR head',async t=>{
 const {executionBaseline}=await import('../dist/agent/common.js'),{ProjectMemory,memoryTool}=await import('../dist/memory/project.js');
 const s=new Store(':memory:',randomBytes(32));t.after(()=>s.close());s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','')");s.run("INSERT INTO repositories VALUES('101','fixture/project','1','a')");
 const ownedHead='1'.repeat(40),baseline='2'.repeat(40),input={snapshot_sha:baseline,integration:{state:'applied'}};
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,head_sha) VALUES('t','101','development.issue','running','integration',?,?)",JSON.stringify(input),ownedHead);
 const task=s.get("SELECT * FROM tasks WHERE id='t'");assert.equal(executionBaseline(task),baseline);
 const result=await memoryTool(s,task,'remember_project_memory',{key:'integration-observation',kind:'experience',body:'Observed on integrated checkout'});
 const memory=new ProjectMemory(s).get('101',result.id);assert.equal(memory.scope.commit,baseline);assert.equal(memory.sources[0].source_sha,baseline);
 assert.equal(task.head_sha,ownedHead,'ownership fence must still refer to the original PR head');
});
