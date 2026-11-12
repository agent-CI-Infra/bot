// Protocol fixture, never a substitute for real Codex acceptance.
import {createInterface} from 'node:readline';import {existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');let sessionId='';let server;let prompt;
const rpc=async(method,params)=>{const r=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return (await r.json()).result;};
createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);if(!m.method)return;const reply=result=>send({id:m.id,result});
 if(m.method==='initialize')reply({protocolVersion:1,agentInfo:{name:'fixture',version:'1'},agentCapabilities:{loadSession:process.env.FIXTURE_REBUILD!=='true',mcpCapabilities:{http:true}}});
 else if(m.method==='session/new'){sessionId=crypto.randomUUID();writeFileSync(join(m.params.cwd,sessionId),'fixture');server=m.params.mcpServers[0];reply({sessionId});}
 else if(m.method==='session/load'){if(!existsSync(join(m.params.cwd,m.params.sessionId))){send({id:m.id,error:{code:-32602,message:'missing session'}});return;}sessionId=m.params.sessionId;server=m.params.mcpServers[0];send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'HISTORICAL_REPLAY'}}}});reply({});}
 else if(m.method==='session/prompt'){
  prompt=m;if(process.env.FIXTURE_EXIT==='true'){process.exit(7);}
  if(process.env.FIXTURE_WAIT==='true')return;
  const tools=await rpc('tools/list',{});
  if(process.env.FIXTURE_SKILL==='true'){
   if(tools.tools.some(t=>['read_playbook','select_playbooks'].includes(t.name))||/playbook_catalog|Discover optional playbooks/.test(JSON.stringify(m.params)))throw Error('retired_guidance_offered');
   const call=async(name,args)=>JSON.parse((await rpc('tools/call',{name,arguments:args})).content[0].text);
   const listing=await call('read_skill',{}),file=await call('read_skill',{path:listing.files[0].path});
   await call('finish',{summary:file.content,bundle:listing.bundle,sha256:file.sha256,provided_tools:tools.tools.map(t=>t.name)});reply({stopReason:'end_turn'});return;
  }
  if(process.env.FIXTURE_KNOWLEDGE==='true'){
   const call=async(name,args)=>JSON.parse((await rpc('tools/call',{name,arguments:args})).content[0].text);
   const search=await call('search_project_memory',{query:'socket reset'}),item=search.items?.[0];
   const read=await call('read_project_memory',{id:item?.id,revision:item?.revision});
   const note=await call('remember_project_memory',{key:'external.candidate',kind:'experience',body:'Observed fixture transport behavior'});
   await call('finish',{summary:'knowledge fixture',read_revision:read.revision,note_verification:note.verification,write_error:note.error,read_error:read.error});reply({stopReason:'end_turn'});return;
  }
  if(tools.tools.some(t=>t.name==='read_task_record'))await rpc('tools/call',{name:'read_task_record',arguments:{ref:'task:t'}});
  send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'private-tool',title:'Private assessment',kind:'think',status:'in_progress'}}});
  send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'private-tool',status:'completed',content:[{type:'content',content:{type:'text',text:'PRIVATE_TOOL_REASONING'}}]}}});
  send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE_FIXTURE_REASONING'}}}});
  send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture public output '+(process.env.FIXTURE_TOKEN??'')}}}});
  send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'fixture-call',title:'Fixture observation',status:'in_progress',kind:'read',rawInput:{path:'fixture'}}}});
  if(process.env.FIXTURE_NO_SUBMIT!=='true')await rpc('tools/call',{name:'finish',arguments:process.env.FIXTURE_CONVERSATION==='true'?{message:'A source-bound response'}:{summary:'actual fixture result'}});
  reply({stopReason:'end_turn'});
 }else if(m.method==='session/cancel'&&prompt)send({id:prompt.id,result:{stopReason:'cancelled'}});
 else if(m.id!==undefined)reply({});
});
