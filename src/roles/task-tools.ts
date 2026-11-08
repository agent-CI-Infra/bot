import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomId} from '../core/security.js';
import type {AgentSpec} from '../agent/runtime.js';
import {traceEvent} from '../tasks/trace.js';
/** Run-local MCP bridge. All operations reuse the exact offered tools and validators.
 * Only a loopback endpoint is given to the external agent, never model/GitHub keys. Under a RoleRun the path secret is
 * the run's capability token: every request is checked again, so an expired, revoked or taken-over run is refused. */
export async function taskToolServer<T>(spec:AgentSpec<T>){
 const token=spec.runAccess?.token??randomId();let submitted=false,result:T,active=true,tail=Promise.resolve();
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url!=='/'+token||!active){res.writeHead(404);res.end('{}');return;}
  if(spec.runAccess){try{spec.runAccess.check(token);}catch(error){res.writeHead(401);res.end(JSON.stringify({error:(error as any).code??'run_token_invalid'}));return;}}
  if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
  let requestId:unknown=null;
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)throw new Error('mcp_input_too_large');}
   const request=JSON.parse(raw),{id,method,params}=request;requestId=id;
   if(id===undefined){res.writeHead(202);res.end();return;}
   let value:any;
   if(method==='initialize')value={protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'bot-task-tools',version:'1'}};
   else if(method==='ping')value={};
   else if(method==='tools/list')value={tools:(spec.tools??[]).map(t=>({name:t.function.name,description:t.function.description,inputSchema:t.function.parameters}))};
   else if(method==='tools/call'){
    // Serialize calls: a submission cannot race a write and the active workspace is role-local.
    const work=tail.then(async()=>{
     await spec.guard();if(!active)throw new Error('harness_run_closed');if(submitted)return {error:'execution_already_submitted'};
     const name=params?.name,args=params?.arguments??{},offered=spec.tools?.some(t=>t.function.name===name);
     if(!offered)return {error:'tool_not_allowed'};
     const started=traceEvent(spec.store,spec.task.id,'tool_started',{name,arguments:spec.redactor.clean(args),transport:'mcp'},spec.task.trace_run_id,'harness');
     let observation:any;
     try{if(name===spec.finish?.name){result=await spec.finish!.validate(args);submitted=true;observation={submitted:true};}else observation=await spec.execute?.(name,args);}
     catch(error){const feedback=spec.repairInvalid?.(error);if(!feedback)throw error;observation={error:'invalid_submission',message:spec.redactor.text(feedback)};}
     const clean=spec.redactor.clean(observation??null);
     traceEvent(spec.store,spec.task.id,'tool_observation',{name,observation:clean},spec.task.trace_run_id,'tool',[started]);return clean;
    });tail=work.then(()=>{},()=>{});
    const observation=await work;value={content:[{type:'text',text:JSON.stringify(observation)}],isError:!!observation?.error};
   }else{res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'method_not_found'}}));return;}
   res.end(JSON.stringify({jsonrpc:'2.0',id,result:value}));
  }catch(error){res.end(JSON.stringify({jsonrpc:'2.0',id:requestId,error:{code:-32603,message:spec.redactor.text(String((error as any).code??'task_tool_error'))}}));}
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:`http://127.0.0.1:${(server.address() as any).port}/${token}`,get submitted(){return submitted;},get result(){return result;},async close(){active=false;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await tail;}};
}
