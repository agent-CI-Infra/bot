// Separate process harness: model transport and authority remain in the parent;
// this worker owns its conversation loop and communicates only over JSON-line RPC.
import {createInterface} from 'node:readline';
// This worker runs in the control-plane image, alongside the compiled shared loop contract.
import {toolCallsProblem,toolArguments,finalizationReserve} from '../dist/agent/tool-context.js';
const lines=createInterface({input:process.stdin}),waiting=new Map();let next=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const rpc=(method,args)=>new Promise((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});send({id,method,args});});
lines.on('line',line=>{try{const value=JSON.parse(line);if(value.start)void run(value.start).catch(e=>{send({fault:String(e.message)});process.exitCode=1;lines.close();});else{const w=waiting.get(value.id);if(w){waiting.delete(value.id);value.error?w.reject(new Error(value.error)):w.resolve(value.result);}}}catch{process.exit(1);}});
async function run(c){
 const messages=c.messages.length?[...c.messages,{role:'user',content:c.prompt}]:[{role:'system',content:c.system},{role:'user',content:c.prompt}];
 const finishes=c.finishes??[c.finish],finalizingNames=c.finalizationTools??finishes,reserve=finalizationReserve(c.maxTurns);
 for(let turn=0;turn<c.maxTurns;turn++){
  await rpc('checkpoint',messages);
  const closing=!!c.finish&&turn>=c.maxTurns-reserve,tools=closing?c.tools.filter(t=>finalizingNames.includes(t.function.name)):c.tools;
  if(c.finish&&turn===c.maxTurns-reserve)messages.push({role:'user',content:`Execution has ${reserve} turns left. ${c.finalizationMessage??'Save the bounded artifact and submit the honest current result. Reuse existing evidence; do not invent verification.'}`});
  if(closing&&turn===c.maxTurns-1)messages.push({role:'user',content:`This is the last turn. Call ${finishes.join(' or ')} to submit now.`});
  const message=await rpc('model',{messages,tools,tool_choice:closing&&turn===c.maxTurns-1&&finishes.length===1?{type:'function',function:{name:c.finish}}:'auto'});
  if(message?.tool_calls?.length){
   if(toolCallsProblem(message.tool_calls))throw Error('invalid_tool_calls');
   messages.push(message);
   for(const call of message.tool_calls){
    const args=toolArguments(call);
    // The run token from start is presented on every tool call; the parent checks it before executing.
    const result=args===null?{error:'invalid_tool_arguments',message:'Tool arguments must be valid JSON. Correct this call and continue.'}:await rpc('tool',{name:call.function.name,args,finish:finishes.includes(call.function.name),offered:tools.some(t=>t.function.name===call.function.name),token:c.token});
    messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    if(finishes.includes(call.function.name)&&result.submitted){for(const pending of message.tool_calls.slice(message.tool_calls.indexOf(call)+1))messages.push({role:'tool',tool_call_id:pending.id,content:'{"skipped":"execution_submitted"}'});await rpc('checkpoint',messages);send({done:true});lines.close();return;}
    await rpc('checkpoint',messages);
   }
  }else{if(c.finish&&!c.textResult){messages.push({role:'assistant',content:message?.content??''},{role:'user',content:`A text response is not a submission. Call ${finishes.join(' or ')} with the structured result.`});await rpc('checkpoint',messages);continue;}const result=await rpc('final',message?.content);messages.push({role:'assistant',content:message.content});if(result?.error==='invalid_submission'){messages.push({role:'user',content:result.message});await rpc('checkpoint',messages);continue;}await rpc('checkpoint',messages);send({done:true,result});lines.close();return;}
 }
 throw Error('agent_turn_limit');
}
