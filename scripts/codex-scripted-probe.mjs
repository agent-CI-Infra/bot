// Opt-in probe of the real Codex CLI through the full role-run path, against a scripted Responses endpoint instead of a model.
// Usage: npm run build && node scripts/codex-scripted-probe.mjs [work-dir] [model-slug...]
// No credentials are used: a throwaway CODEX_HOME declares a local provider. The scripted "model" tries a host command and a
// file patch, then reads the task fact and submits it through the Bot MCP tools. It checks what the CLI offered the model,
// that the host command never ran and the patch was declined, and that the role result came only from the task tools.
// This verifies the CLI and the client, not any model's behaviour. Exit code 1 means a check failed.
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdirSync,writeFileSync,rmSync,readdirSync} from 'node:fs';import {join,resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import {Store} from '../dist/storage/database.js';import {TaskRecords} from '../dist/tasks/service.js';import {runRole} from '../dist/roles/run.js';import {Redactor} from '../dist/agent/common.js';import {instanceUsage} from '../dist/roles/role-run.js';
const [dir,...slugs]=process.argv.slice(2),work=resolve(dir??'.tmp/codex-scripted-probe'),models=slugs.length?slugs:['gpt-6.1-sol','gpt-5.1-codex'];
const report=[];let failed=false;
for(const model of models){
 const root=join(work,model);rmSync(root,{recursive:true,force:true});mkdirSync(join(root,'home'),{recursive:true});
 const fact=randomBytes(12).toString('hex'),requests=[];
 // Code-mode families call nested tools from one JavaScript `exec`; others get plain function tools.
 const codeMode=body=>(body.input??[]).some(i=>i.type==='additional_tools'&&JSON.stringify(i).includes('"name":"exec"'));
 const call=(body,js,fns)=>codeMode(body)?[{type:'custom_tool_call',id:'ctc_'+requests.length,call_id:'call_'+requests.length,name:'exec',input:js}]
  // MCP tools come as the namespace mcp__bot in function mode.
  :fns.map(([name,args],i)=>({type:'function_call',id:`fc_${requests.length}_${i}`,call_id:`call_${requests.length}_${i}`,...(name.startsWith('mcp__bot__')?{namespace:'mcp__bot',name:name.slice(10)}:{name}),arguments:JSON.stringify(args)}));
 const script=(n,body)=>{
  if(n===0)return call(body,`const out={};try{out.exec=await tools.exec_command({cmd:"cat /etc/hostname"});}catch(e){out.exec="error: "+e.message;}try{out.patch=await tools.apply_patch("*** Begin Patch\\n*** Add File: probe.txt\\n+x\\n*** End Patch\\n");}catch(e){out.patch="error: "+e.message;}out.fact=await tools.mcp__bot__read_task_record({ref:"task:probe"});text(JSON.stringify(out));`,
   [['exec_command',{cmd:'cat /etc/hostname'}],['mcp__bot__read_task_record',{ref:'task:probe'}]]);
  const seen=/Probe fact: ([0-9a-f]{24})/.exec(JSON.stringify(body.input))?.[1]??'not-seen';
  if(n===1)return call(body,`await tools.mcp__bot__submit_role_result({fact:${JSON.stringify(seen)}});text("submitted");`,[['mcp__bot__submit_role_result',{fact:seen}]]);
  return [{type:'message',id:'msg_'+n,role:'assistant',content:[{type:'output_text',text:'done'}]}];
 };
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end('{}');return;}
  const body=JSON.parse(raw),items=script(requests.length,body);requests.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});
  const ev=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);ev('response.created',{response:{id:'resp_'+requests.length}});
  for(const item of items){ev('response.output_item.added',{item});ev('response.output_item.done',{item});}
  ev('response.completed',{response:{id:'resp_'+requests.length,usage:{input_tokens:100,input_tokens_details:{cached_tokens:20},output_tokens:10,output_tokens_details:{reasoning_tokens:5},total_tokens:110}}});res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 writeFileSync(join(root,'home','config.toml'),`model_provider = "scripted"\nmodel = "${model}"\n[model_providers.scripted]\nname = "scripted"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\n`);
 writeFileSync(join(root,'codex.json'),JSON.stringify({command:'codex',args:['app-server'],env:{CODEX_HOME:join(root,'home')},stateDirectory:join(root,'sessions'),version:'0.166.0',timeoutMs:120000,cancelGraceMs:3000}));
 process.env.BOT_CODEX_CONFIG=join(root,'codex.json');
 const store=new Store(join(root,'control.sqlite'),randomBytes(32));
 store.run("INSERT INTO accounts VALUES('probe','probe','github_app','1','{}','now')");store.run("INSERT INTO repositories VALUES('probe','fixture/codex-probe','fixture','probe')");
 store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('probe','probe','task.request','running','Scripted Codex probe','{}')");
 new TaskRecords(store).contract('probe',{goal:'Probe fact: '+fact,scope:['scripted probe'],criteria:['Submit the fact read through the task tools'],endpoint:'report'});
 const fn=(name,properties)=>({type:'function',function:{name,description:name,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}});
 let output=null,error=null;
 try{output=await runRole({store,task:store.get("SELECT * FROM tasks WHERE id='probe'"),redactor:new Redactor(),guard:async()=>{},system:'Scripted probe role.',prompt:'Read task:probe and submit its fact.',
  tools:[fn('read_task_record',{ref:{type:'string'}}),fn('submit_role_result',{fact:{type:'string'}})],execute:async()=>({error:'not_used'}),finish:{name:'submit_role_result',validate:v=>{assert.equal(v.fact,fact);return v;}}},'dev',undefined,'codex');}
 catch(e){error={code:e.code??String(e),detail:e.detail??null};}
 server.close();
 const events=store.all("SELECT data FROM task_history WHERE type='harness_event' ORDER BY id").map(r=>JSON.parse(r.data));
 // The tools the CLI actually offered the model in its first request, including tools nested in a code-mode exec.
 const offered=[];const walk=(t,p)=>{if(Array.isArray(t.tools))for(const x of t.tools)walk(x,p+t.name+'/');else offered.push(p+t.name);};
 for(const t of requests[0]?.tools??[])walk(t,'');for(const i of requests[0]?.input??[])if(i.type==='additional_tools')for(const t of i.tools)walk(t,'');
 const nested=[...new Set([...JSON.stringify(requests[0]??{}).matchAll(/### `([^`]+)`/g)].map(m=>m[1]))];
 const result={model,error,result:!!output,offered,nested,
  items:events.filter(e=>e.type==='tool').map(e=>`${e.itemType}:${e.phase}:${e.status}`),permissions:events.filter(e=>e.type==='permission').map(e=>`${e.method}:${e.decision}`),
  usage:events.filter(e=>e.type==='usage').length,unknown:instanceUsage(store,store.get("SELECT id FROM role_instances WHERE role='dev'").id).unknown_requests,patched:files(join(root,'sessions')).some(f=>f.endsWith('probe.txt'))};
 store.close();report.push(result);
 const checks=[[!error&&output,'role result submitted through the Bot task tools'],[!offered.concat(nested).some(n=>/(^|\/)(exec_command|write_stdin|view_image|shell)$/.test(n)),'no host shell or image tool offered'],
  [!result.items.some(i=>i.startsWith('commandExecution')),'no host command ran'],[!result.patched&&!result.items.some(i=>i==='fileChange:completed:completed'),'patch not applied'],[result.usage>0&&result.unknown===0,'usage reported per response']];
 for(const [ok,what] of checks){console.log(`${ok?'ok  ':'FAIL'} ${model}: ${what}`);if(!ok)failed=true;}
}
function files(path){try{return readdirSync(path,{recursive:true}).map(String);}catch{return [];}}
console.log(JSON.stringify(report,null,1));
process.exitCode=failed?1:0;
