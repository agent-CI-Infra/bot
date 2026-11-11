import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {Redactor} from '../dist/agent/common.js';
import {collectCheckEvidence} from '../dist/github/ci-evidence.js';
const sha='a'.repeat(40);
function fixture(t,{annotationsError=false,logError=false,external=false,mismatch=false}={}){
 const s=new Store(':memory:',Buffer.alloc(32,4));t.after(()=>s.close());
 s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/project','o','a')");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('t','r','development.issue','running','fixture')");
 const paths=[],github={fullName:'fixture/project',path:p=>p,async request(method,path){paths.push(path);
  if(path.includes('annotations')){if(annotationsError)throw {code:'github_http_403'};return path.endsWith('page=1')?Array.from({length:100},()=>({message:'The job was not started because account payments failed'})):[];}
  if(path.includes('/actions/jobs/'))return {id:456,head_sha:sha,status:'completed',conclusion:'failure',steps:[]};
  return {id:123,head_sha:mismatch?'b'.repeat(40):sha,status:'completed',conclusion:'failure',output:{summary:'Not started'},details_url:external?'https://other.test/check/123':'https://github.com/fixture/project/actions/runs/99/job/456'};
 },async jobLog(id){assert.equal(id,456);if(logError)throw {code:'github_log_download_failed'};return 'actual test failure';}};
 return {s,github,paths,task:s.get("SELECT * FROM tasks WHERE id='t'"),records:()=>s.all("SELECT data FROM task_history WHERE type='retry_evidence'").map(r=>JSON.parse(r.data))};
}
test('C replay: account annotation and empty job steps survive unavailable logs; annotations page separately',async t=>{
 const f=fixture(t,{logError:true});const first=await collectCheckEvidence(f.s,f.task,f.github,new Redactor(),sha,123);
 assert.equal(first.annotations_next_page,2);const rows=f.records();assert.match(JSON.stringify(rows),/payments failed/);assert.ok(rows.some(r=>r.kind==='job'&&r.data.id===456));assert.ok(rows.some(r=>r.kind==='log'&&r.error==='github_log_download_failed'));
 await collectCheckEvidence(f.s,f.task,f.github,new Redactor(),sha,123,2);assert.ok(f.paths.some(p=>p.endsWith('page=2')));assert.ok(!f.paths.includes('/actions/jobs/123'));
});
test('annotations permission failure does not erase job and actual log',async t=>{const f=fixture(t,{annotationsError:true});await collectCheckEvidence(f.s,f.task,f.github,new Redactor(),sha,123);const rows=f.records();assert.ok(rows.some(r=>r.kind==='annotations'&&r.error));assert.ok(rows.some(r=>r.kind==='log'&&r.data.log==='actual test failure'));});
test('non-Actions checks keep annotations without inventing a job association',async t=>{const f=fixture(t,{external:true});await collectCheckEvidence(f.s,f.task,f.github,new Redactor(),sha,123);assert.ok(!f.paths.some(p=>p.includes('/actions/jobs/')));assert.ok(f.records().some(r=>r.kind==='annotations'));});
test('wrong candidate SHA is reported without fetching misleading job/log evidence',async t=>{const f=fixture(t,{mismatch:true});const result=await collectCheckEvidence(f.s,f.task,f.github,new Redactor(),sha,123);assert.equal(result.error,'ci_candidate_mismatch');assert.equal(f.paths.length,1);});
