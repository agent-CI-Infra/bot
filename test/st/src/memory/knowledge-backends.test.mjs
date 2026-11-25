import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { memoryTools, memoryTool, readProjectNote } from '../../../../dist/memory/project.js';
import { runRole } from '../../../../dist/roles/run.js';
import { saveConfiguration } from '../../../../dist/roles/definition.js';
import { runAgent } from '../../../../dist/agent/runtime.js';
import { piAdapter } from '../../../../dist/agent/pi.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { replyChatCompletion } from '../../../fixtures/openai-sse.mjs';

const finish={type:'function',function:{name:'finish',description:'Submit observed knowledge results',parameters:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:true}}};
const writeFileTool={type:'function',function:{name:'write_file',description:'Write workspace or ../notes/ file',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}};
const text=v=>typeof v==='string'?v:Array.isArray(v)?v.map(x=>x.text||'').join(''):'';
const call=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:'call_'+randomBytes(6).toString('hex'),type:'function',function:{name,arguments:JSON.stringify(args)}}]});

const sdk=existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json');
const skip=!sdk&&process.env.BOT_REQUIRE_PI!=='1'?'Pi SDK not installed: npm ci --prefix runner --omit=dev --ignore-scripts':false;
test('real Pi mailbox and container Codex stdio MCP share physical project notes, body search and credential redaction', {timeout:120000,skip}, async t=>{
  assert.ok(existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json'),'install runner dependencies before backend acceptance');
  const root=mkdtempSync(join(tmpdir(),'knowledge-backend-')),s=new Store(join(root,'knowledge.sqlite'),randomBytes(32)),manager=new LocalManager('101',join(root,'workspace'));
  t.after(async()=>{await manager.recover();s.close();rmSync(root,{recursive:true,force:true});});
  s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1',?,'now')",s.secrets.seal({token:'pi-registered-secret-77'},'account:a'));
  s.run("INSERT INTO repositories VALUES('101','fixture/knowledge','10','a')");
  const env=await manager.call('PUT','/v1/projects/101');
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,attempt,generation,workspace_id,input) VALUES('t','101','task.request','running','knowledge fixture',1,?,?, '{}')",env.generation,randomBytes(24).toString('hex'));
  authorizeKnowledgeTask(s);
  const seededBody='# Transport retries\n\nReproduce transient socket reset failure before retrying.';
  const item=await manager.call('POST','/v1/projects/101/file-tree',{path:'guides/transport-retry.md',content:seededBody,actor:'user:owner',create_parents:true});
  let step=0;
  const model=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),done=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(text(m.content));}catch{return {};}});
    const actions=[
      ()=>call('search_project_memory',{query:'socket reset'}),
      ()=>{assert.equal(done.at(-1).items[0].id,item.id);assert.ok(done.at(-1).items[0].preview.includes('socket reset'));return call('read_project_memory',{id:item.id,revision:1});},
      ()=>{assert.equal(done.at(-1).body,seededBody);return call('remember_project_memory',{key:'pi.candidate',body:'Actual observed Pi fixture behavior pi-registered-secret-77'});},
      ()=>{assert.equal(done.at(-1).path,'pi.candidate.md');return call('write_file',{path:'../notes/pi-direct-note.md',content:'Direct Pi note pi-registered-secret-77'});},
      ()=>call('finish',{summary:'Pi knowledge tools completed'}),
    ];
    const message=actions[step++]();replyChatCompletion(res,message,{stream:Boolean(body.stream),usage:{prompt_tokens:10,completion_tokens:5}});});
  model.listen(0,'127.0.0.1');await once(model,'listening');t.after(()=>new Promise(r=>{model.close(r);model.closeAllConnections();}));
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','101','http://127.0.0.1:'+model.address().port+'/v1','fixture',s.secrets.seal({value:'knowledge-fixture-key'},'model:m'),'now');s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('101','m',1)");
  saveConfiguration(s,'101',{expected_revision:0,roles:[{role_id:'reviewer',permissions:{project_memory:'read'}}]},'owner');
  const task={...s.get("SELECT * FROM tasks WHERE id='t'"),active_role:'dev'},redactor=new Redactor(),guard=async()=>{},workspace=new Workspace(s,manager,task,redactor,guard,()=>{});
  redactor.add('pi-registered-secret-77');
  await workspace.call('knowledge:init',{type:'workspace_init'});
  const tools=[...memoryTools,writeFileTool,finish],execute=(name,args)=>memoryTool(s,task,name,args,workspace);
  const config={system:'Use offered knowledge tools and submit finish.',prompt:'Search socket reset, read its exact revision, save notes, then finish.',tools,control_tools:[...memoryTools.map(t=>t.function.name),'finish'],finish_tools:[],finish_on_pull_request:false,workspace_id:task.workspace_id,capabilities:{workspace:{read:false,write:true,notes:true,shell:false},github:{permissions:{},publication:'none'},agents:false,writes:[]}};
  const result=await runAgent({store:s,task,redactor,guard,system:config.system,prompt:config.prompt,tools,maxTurns:8,adapter:piAdapter({store:s,taskId:'t',guard,workspace,redactor,config,offered:name=>tools.some(t=>t.function.name===name),control:async(name,args)=>name==='finish'?{result:args,finish:true}:{result:await execute(name,args)},complete:state=>state.result})});
  assert.equal(result.summary,'Pi knowledge tools completed');assert.equal(step,5);

  // Both remember_project_memory and Pi write_file("../notes/...") redact registered credentials.
  const piSaved=await readProjectNote(manager,'101','pi.candidate.md');
  assert.equal(piSaved.content,'Actual observed Pi fixture behavior [REDACTED]');
  const directPiRead=await workspace.call('check-pi-direct-note',{type:'workspace_read',path:'../notes/pi-direct-note.md'});
  assert.equal(directPiRead.content,'Direct Pi note [REDACTED]');

  // Container Codex stdio MCP uses the exact same physical notes backend (with a Codex-compatible Responses model).
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m_codex','101','http://127.0.0.1:'+model.address().port+'/v1/responses','codex-fixture',s.secrets.seal({value:'knowledge-fixture-key'},'model:m_codex'),'now');
  s.run("UPDATE policies SET model_id='m_codex' WHERE repository_id='101'");
  s.run("DELETE FROM task_execution_configs WHERE task_id='t'");
  const codexHome=join(root,'codex-home'),codexSessions=join(root,'codex-sessions');
  mkdirSync(codexHome,{recursive:true,mode:0o700});mkdirSync(codexSessions,{recursive:true,mode:0o700});
  const codexConfig=join(root,'codex.json');writeFileSync(codexConfig,JSON.stringify({command:process.execPath,args:[resolve('test/fixtures/codex-app-server.mjs'),'app-server'],version:'0.166.0',env:{CODEX_HOME:codexHome,FIXTURE_KNOWLEDGE:'true'},stateDirectory:codexSessions,cancelGraceMs:400,toolStartupMs:3000}));
  const previous=process.env.BOT_CODEX_CONFIG;process.env.BOT_CODEX_CONFIG=codexConfig;t.after(()=>{if(previous===undefined)delete process.env.BOT_CODEX_CONFIG;else process.env.BOT_CODEX_CONFIG=previous;});
  const spec={store:s,task,redactor,guard,roleWorkspace:workspace,system:'Knowledge transport fixture',prompt:'Search socket reset and read the offered revision.',tools:[...memoryTools,finish],execute,finish:{name:'finish',validate:v=>v},maxTurns:8};
  const external=await runRole(spec,'dev',undefined,'codex');
  assert.equal(external.result.read_revision,1);
  assert.ok(external.result.search_preview?.includes('socket reset'));
  assert.equal(external.result.note_path,'external.candidate.md');
  const readonly=await runRole(spec,'reviewer',undefined,'codex');
  assert.equal(readonly.result.read_revision,1);
  assert.equal(readonly.result.write_error,'tool_not_allowed');

  const reads=s.all("SELECT data FROM task_history WHERE type='memory_read'").map(r=>JSON.parse(r.data));
  assert.equal(reads.length,3);
  assert.ok(reads.every(r=>r.revision===1&&r.memory_source===`notes:${item.id}:1`&&r.content_sha256&&r.characters===seededBody.length));
  const codexSaved=await readProjectNote(manager,'101','external.candidate.md');
  assert.equal(codexSaved.content,'Observed fixture transport behavior');
  assert.equal(s.get("SELECT status FROM tasks WHERE id='t'").status,'running');
  await workspace.release(false);
  assert.equal((await readProjectNote(manager,'101',item.id)).content,seededBody,'cleaning an execution directory preserves project notes');
});
