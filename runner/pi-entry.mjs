import {readFile,writeFile,rename,unlink,appendFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createAgentSession,createExtensionRuntime,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {workspace} from './workspace.mjs';

const root=process.argv[2],dir=root+'/agent',cwd=root+'/repo',config=JSON.parse(await readFile(dir+'/input.json','utf8'));
const save=async value=>{await writeFile(dir+'/state.tmp',JSON.stringify(value),{mode:0o600});await rename(dir+'/state.tmp',dir+'/state.json');};
let calls=0,session,finished;
const server=createServer(async(req,res)=>{
  try{
    if(req.url!=='/v1/chat/completions'||req.method!=='POST'||++calls>32)throw new Error('model_request_not_allowed');
    let raw='';for await(const chunk of req){raw+=chunk.toString();if(raw.length>2*1024*1024)throw new Error('model_request_too_large');}
    const id=randomBytes(24).toString('hex');await writeFile(dir+'/request.tmp',JSON.stringify({id,body:JSON.parse(raw)}),{mode:0o600});await rename(dir+'/request.tmp',dir+'/request.json');
    const end=Date.now()+120000;let response;
    while(Date.now()<end){response=await readFile(dir+'/reply-'+id+'.json','utf8').then(JSON.parse).catch(()=>null);if(response)break;await new Promise(resolve=>setTimeout(resolve,100));}
    if(!response)throw new Error('model_proxy_timeout');await unlink(dir+'/request.json');await unlink(dir+'/reply-'+id+'.json');
    res.writeHead(response.status,{'Content-Type':response.content_type});res.end(response.body);
  }catch{res.writeHead(502,{'Content-Type':'application/json'});res.end('{"error":"model_proxy_unavailable"}');}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
try{
  // This literal is not a provider credential. The local proxy ignores it and cannot reach any provider itself.
  await writeFile(dir+'/models.json',JSON.stringify({providers:{'department-proxy':{api:'openai-completions',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:'local-proxy',models:[{id:'selected',name:'Project model',contextWindow:128000,maxTokens:8192,reasoning:false,input:['text'],compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false}}]}}}),{mode:0o600});
  const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:dir+'/models.json',modelsStorePath:dir+'/catalog.json',allowModelNetwork:false});
  const loader={getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>config.system,getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{}};
  const tools=config.tools.map(tool=>({name:tool.function.name,label:tool.function.name,description:tool.function.description,parameters:tool.function.parameters,
    async execute(id,args){
      let result;
      if(tool.function.name.startsWith('finish_')){finished=args;setTimeout(()=>void session.abort(),10);result={finished:true};}
      else if(tool.function.name==='read_file')result=await workspace({type:'workspace_read',workspace_id:config.workspace_id,path:args.path});
      else if(tool.function.name==='write_file'){
        const data=Buffer.from(args.content);if(data.length>48000)throw new Error('file_too_large');result=await workspace({type:'workspace_write',workspace_id:config.workspace_id,path:args.path,base64:data.toString('base64'),offset:0,final:true,mode:'100644'});
      }else if(tool.function.name==='run_command'){
        if(args.timeout_seconds>config.max_command_minutes*60)throw new Error('command_timeout_exceeds_project_limit');
        await writeFile(dir+'/command.out','',{mode:0o600});await writeFile(dir+'/live.json',JSON.stringify({operation_id:id,command:args.command,timeout_ms:Math.min(args.timeout_seconds||120,config.max_command_minutes*60)*1000,keep_background:args.keep_background===true}),{mode:0o600});
        try{result=await workspace({type:'workspace_command',workspace_id:config.workspace_id,command:args.command,timeout_ms:Math.min(args.timeout_seconds||120,config.max_command_minutes*60)*1000,keep_background:args.keep_background===true,output_file:dir+'/command.out'});}finally{await unlink(dir+'/live.json').catch(()=>{});}
      }else throw new Error('tool_not_allowed');
      await appendFile(dir+'/events.jsonl',JSON.stringify({type:'tool',name:tool.function.name,call_id:id,arguments:args,result})+'\n',{mode:0o600});return {content:[{type:'text',text:JSON.stringify(result)}],details:{}};
    }}));
  ({session}=await createAgentSession({cwd,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('department-proxy','selected'),thinkingLevel:'off',resourceLoader:loader,
    tools:tools.map(tool=>tool.name),customTools:tools,sessionManager:SessionManager.inMemory(cwd),settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}})}));
  session.subscribe(event=>{if(event.type==='message_end'&&event.message.role==='assistant'){
    const m=event.message;void appendFile(dir+'/events.jsonl',JSON.stringify({type:'model',reasoning:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join(''),content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''),tool_calls:m.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,name:c.name,arguments:JSON.stringify(c.arguments)}))})+'\n',{mode:0o600});
  }});
  try{await session.prompt(config.prompt);}catch(error){if(!finished)throw error;}
  const result=finished||JSON.parse(session.getLastAssistantText().replace(/^```(?:json)?\s*|\s*```$/g,''));await save({state:'completed',result,agent:'pi',version:'1.4.0'});
}catch{await save({state:'failed',error:'pi_execution_failed'});}
finally{session?.dispose();server.closeAllConnections();server.close();}
