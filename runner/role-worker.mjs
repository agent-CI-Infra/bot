// Separate process harness: model transport and authority remain in the parent;
// this worker owns its conversation loop and communicates only over JSON-line RPC.
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin}),waiting=new Map();let next=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const rpc=(method,args)=>new Promise((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});send({id,method,args});});
lines.on('line',line=>{try{const value=JSON.parse(line);if(value.start)void run(value.start).catch(e=>{send({fault:String(e.message)});process.exitCode=1;lines.close();});else{const w=waiting.get(value.id);if(w){waiting.delete(value.id);value.error?w.reject(new Error(value.error)):w.resolve(value.result);}}}catch{process.exit(1);}});
async function run(c){
 const messages=c.messages.length?[...c.messages,{role:'user',content:c.prompt}]:[{role:'system',content:c.system},{role:'user',content:c.prompt}];
 for(let turn=0;turn<c.maxTurns;turn++){
  await rpc('checkpoint',messages);
  const closing=turn>=c.maxTurns-3,tools=closing?c.tools.filter(t=>t.function.name===c.finish):c.tools;
  if(turn===c.maxTurns-3)messages.push({role:'user',content:'Submit the honest current result now. Do not invent verification.'});
  const message=await rpc('model',{messages,tools,tool_choice:closing?{type:'function',function:{name:c.finish}}:'auto'});
  if(message?.tool_calls?.length){
   if(message.tool_calls.length>8||new Set(message.tool_calls.map(t=>t.id)).size!==message.tool_calls.length)throw Error('invalid_tool_calls');
   messages.push(message);
   for(const call of message.tool_calls){
    if(!/^[\w-]{1,128}$/.test(call.id||'')||typeof call.function?.arguments!=='string')throw Error('invalid_tool_call');
    let args;try{args=JSON.parse(call.function.arguments);}catch{args=null;}
    const result=await rpc('tool',{name:call.function.name,args,finish:call.function.name===c.finish,offered:tools.some(t=>t.function.name===call.function.name)});
    messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    if(call.function.name===c.finish&&result.submitted){for(const pending of message.tool_calls.slice(message.tool_calls.indexOf(call)+1))messages.push({role:'tool',tool_call_id:pending.id,content:'{"skipped":"execution_submitted"}'});await rpc('checkpoint',messages);send({done:true});lines.close();return;}
    await rpc('checkpoint',messages);
   }
  }else{const result=await rpc('final',message?.content);messages.push({role:'assistant',content:message.content});await rpc('checkpoint',messages);send({done:true,result});lines.close();return;}
 }
 throw Error('agent_turn_limit');
}
