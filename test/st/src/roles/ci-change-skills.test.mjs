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

// #1136: a development a project administrator confirmed as a CI change (#931) runs its Dev with the layered CI gate skill
// pinned in the role snapshot, read through read_skill like any bound skill; an ordinary development's Dev has no skill.
const tool=name=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{},additionalProperties:true}}});
const call=(name,args,id)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

async function fixture(t,input){
 const s=new Store(':memory:',randomBytes(32)),requests=[];
 s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/ci','o','a')");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','layer the CI',?)",JSON.stringify(input));
 new TaskRecords(s).contract('t',{goal:'Layer the CI gates',scope:['.github/workflows/'],criteria:['Each layer has a local command'],endpoint:'artifact'});
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

test('the Dev of a confirmed CI change reads the layered CI gate skill; an ordinary development offers none',async t=>{
 const ci=await fixture(t,{request:'Layer the CI',workflow_changes:{confirmed_by:'u1',confirmed_at:'now'}});
 await runRole(ci.spec,'dev');
 const first=ci.requests[0],context=JSON.parse(first.messages.at(-1).content).role_context;
 assert.ok(first.tools.some(t=>t.function.name==='read_skill'));
 assert.equal(context.skills.bundle,'@role-defaults/dev');
 assert.ok(context.skills.files.some(f=>f.path==='defaults/layered-ci-gates/references/github-setup.md'));
 const result=JSON.parse(ci.requests[1].messages.find(m=>m.role==='tool').content);
 assert.equal(result.path,'defaults/layered-ci-gates/SKILL.md');assert.match(result.content,/# Layered CI gates/);
 assert.ok(ci.s.get("SELECT 1 FROM task_history WHERE type='skill_read' AND json_extract(data,'$.path')='defaults/layered-ci-gates/SKILL.md'"));

 // The same task without a person's confirmation: the Dev has no skill bundle and no read_skill.
 const plain=await fixture(t,{request:'Layer the CI'});
 await runRole(plain.spec,'dev');
 assert.ok(!plain.requests[0].tools.some(t=>t.function.name==='read_skill'));
 assert.equal(JSON.parse(plain.requests[0].messages.at(-1).content).role_context.skills,undefined);
 // Only the presence of confirmed_by counts, as for the Workflows permission itself.
 const unconfirmed=await fixture(t,{request:'Layer the CI',workflow_changes:{confirmed_at:'now'}});
 await runRole(unconfirmed.spec,'dev');
 assert.ok(!unconfirmed.requests[0].tools.some(t=>t.function.name==='read_skill'));
});
