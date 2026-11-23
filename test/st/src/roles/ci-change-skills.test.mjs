import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {Store} from '../../../../dist/storage/database.js';
import {TaskRecords} from '../../../../dist/tasks/service.js';
import {runRole} from '../../../../dist/roles/run.js';
import {Redactor} from '../../../../dist/agent/common.js';
import {nativeRoles} from '../../../fixtures/native-roles.mjs';

// #1136, #1269: a development targeting `.github/workflows/` or CI gates runs its Dev with the layered CI gate skill
// pinned in the role snapshot, read through read_skill like any bound skill; an ordinary non-CI task's Dev has no skill.
const tool=name=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{},additionalProperties:true}}});
const call=(name,args,id)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

async function fixture(t,input,summary='implement feature'){
 const s=new Store(':memory:',randomBytes(32)),requests=[];
 s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/ci','o','a')");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running',?,?)",summary,JSON.stringify(input));
 new TaskRecords(s).contract('t',{goal:'Update code',scope:['src/'],criteria:['Tests pass'],endpoint:'artifact'});
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);
  const names=body.tools.map(t=>t.function.name),seen=body.messages.filter(m=>m.role==='tool');
  const message=names.includes('read_skill')&&!seen.length?call('read_skill',{path:'defaults/layered-ci-gates/SKILL.md'},'read'):call('finish',{summary:'done'},'finish');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','r','http://127.0.0.1:'+server.address().port+'/v1','fixture',s.secrets.seal({value:'fixture-key'},'model:m'),'now');
 s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
 nativeRoles(s,'r');
 t.after(()=>new Promise(resolve=>{s.close();server.close(resolve);server.closeAllConnections();}));
 const task=s.get("SELECT * FROM tasks WHERE id='t'");
 return {s,requests,spec:{store:s,task,redactor:new Redactor(),guard:async()=>{},system:'Task execution',prompt:'{}',tools:[tool('finish')],finish:{name:'finish',validate:v=>v},maxTurns:4}};
}

test('the Dev of a task targeting .github/workflows/ reads the layered CI gate skill; an ordinary non-CI development offers none',async t=>{
 const ci=await fixture(t,{request:'Layer the CI in .github/workflows/ci.yml',contract:{goal:'Layer CI',scope:['.github/workflows/ci.yml'],criteria:['Passes'],endpoint:'reviewable_pull_request'}},'layer the CI');
 await runRole(ci.spec,'dev');
 const first=ci.requests[0],context=JSON.parse(first.messages.at(-1).content).role_context;
 assert.ok(first.tools.some(t=>t.function.name==='read_skill'));
 assert.equal(context.skills.bundle,'@role-defaults/dev');
 assert.ok(context.skills.files.some(f=>f.path==='defaults/layered-ci-gates/references/github-setup.md'));
 const result=JSON.parse(ci.requests[1].messages.find(m=>m.role==='tool').content);
 assert.equal(result.path,'defaults/layered-ci-gates/SKILL.md');assert.match(result.content,/# Layered CI gates/);
 assert.ok(ci.s.get("SELECT 1 FROM task_history WHERE type='skill_read' AND json_extract(data,'$.path')='defaults/layered-ci-gates/SKILL.md'"));

 // An ordinary code task not mentioning .github/workflows/ or layered-ci-gates: the Dev has no skill bundle and no read_skill.
 const plain=await fixture(t,{request:'Fix login validation',contract:{goal:'Fix login',scope:['src/auth.ts'],criteria:['Tests pass'],endpoint:'reviewable_pull_request'}},'fix login');
 await runRole(plain.spec,'dev');
 assert.ok(!plain.requests[0].tools.some(t=>t.function.name==='read_skill'));
 assert.equal(JSON.parse(plain.requests[0].messages.at(-1).content).role_context.skills,undefined);
});

test('Manager-dispatched PR revision with default goal attaches layered-ci-gates deterministically from PR diff files or parent candidate (#1269)',async t=>{
 // 1. development.pr with default goal ("Revise bot PR #201: fix unit test") and PR diff files touching .github/workflows/ci.yml.
 const fromDiff=await fixture(t,{request:'Revise bot PR #201: fix unit test',contract:{goal:'Revise bot PR #201: fix unit test',scope:['Revise bot PR #201: fix unit test'],criteria:['Pass CI'],endpoint:'reviewable_pull_request'},files:[{filename:'.github/workflows/ci.yml',status:'modified'}]},'修订 PR #201');
 fromDiff.s.run("UPDATE tasks SET kind='development.pr',object_number=201 WHERE id='t'");
 fromDiff.spec.task=fromDiff.s.get("SELECT * FROM tasks WHERE id='t'");
 await runRole(fromDiff.spec,'dev');
 assert.ok(fromDiff.requests[0].tools.some(t=>t.function.name==='read_skill'),'PR diff touching workflow must attach layered-ci-gates');
 assert.ok(JSON.parse(fromDiff.requests[0].messages.at(-1).content).role_context.skills.files.some(f=>f.path==='defaults/layered-ci-gates/SKILL.md'));

 // 2. task.request targeting PR #202 with default goal (no files array yet), linked via bot_pull_requests -> parent development_candidates touching workflow.
 const fromParent=await fixture(t,{request:'Revise bot PR #202: address review comment',target:{type:'pr',number:202},contract:{goal:'Revise bot PR #202: address review comment',scope:['Revise bot PR #202: address review comment'],criteria:['Pass CI'],endpoint:'reviewable_pull_request'}},'修订 PR #202');
 fromParent.s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('parent-ci','r','task.request','pr_opened','Add checks','{}')");
 fromParent.s.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('r',202,'PR_202','901','r','bot/task-parent-ci','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','parent-ci')");
 fromParent.s.run("INSERT INTO development_candidates(task_id,data) VALUES('parent-ci',?)",JSON.stringify({
  files:[{path:'.github/workflows/ci.yml',mode:'100644',sha:'2'.repeat(40)}],
  snapshot_files:[{path:'.github/workflows/ci.yml',mode:'100644',sha:'1'.repeat(40)}],
 }));
 await runRole(fromParent.spec,'dev');
 assert.ok(fromParent.requests[0].tools.some(t=>t.function.name==='read_skill'),'parent candidate touching workflow must attach layered-ci-gates');

 // 3. Non-workflow PR revision with default goal does not attach layered-ci-gates.
 const nonCiPr=await fixture(t,{request:'Revise bot PR #203: fix typo',contract:{goal:'Revise bot PR #203: fix typo',scope:['Revise bot PR #203: fix typo'],criteria:['Pass'],endpoint:'reviewable_pull_request'},files:[{filename:'README.md',status:'modified'}]},'修订 PR #203');
 nonCiPr.s.run("UPDATE tasks SET kind='development.pr',object_number=203 WHERE id='t'");
 nonCiPr.spec.task=nonCiPr.s.get("SELECT * FROM tasks WHERE id='t'");
 await runRole(nonCiPr.spec,'dev');
 assert.ok(!nonCiPr.requests[0].tools.some(t=>t.function.name==='read_skill'));
});
