import {readFile,writeFile,rename,unlink,appendFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createAgentSession,createExtensionRuntime,ModelRuntime,SessionManager,SettingsManager,estimateTokens} from '@earendil-works/pi-coding-agent';
import {workspace} from './workspace.mjs';
import {waitModelReply} from './model-reply.mjs';
import {toolCapabilityError} from './capabilities.mjs';

const root=process.argv[2],dir=root+'/agent',cwd=root+'/repo',config=JSON.parse(await readFile(dir+'/input.json','utf8'));
const boot=(await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>({}))).boot;
const save=async value=>{value={...value,pid:process.pid,boot};await writeFile(dir+'/state.tmp',JSON.stringify(value),{mode:0o600});await rename(dir+'/state.tmp',dir+'/state.json');};
let steps=0,session,finished,grant=null,requestFailure;
// Serialize model and tool events in execution order; mask every issued token before it reaches disk.
const secrets=new Set();let events=Promise.resolve();
const clean=value=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'?[...secrets].reduce((text,secret)=>text.replaceAll(secret,'[REDACTED]'),item):item));
const writeEvent=value=>{const line=JSON.stringify(clean(value))+'\n';events=events.then(()=>appendFile(dir+'/events.jsonl',line,{mode:0o600}));return events;};
// Asks the control plane for a read-only GitHub token through the task mailbox, as model requests do.
async function exchange(){
  const id=randomBytes(24).toString('hex'),reply=dir+'/token-reply-'+id+'.json';
  await writeFile(dir+'/token-request.tmp',JSON.stringify({id}),{mode:0o600});await rename(dir+'/token-request.tmp',dir+'/token-request.json');
  try{
    for(const end=Date.now()+120000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){
      const value=await readFile(reply,'utf8').then(JSON.parse).catch(()=>null);if(value)return value;
    }
    return {error:'github_read_token_timeout'};
  }finally{await unlink(dir+'/token-request.json').catch(()=>{});await unlink(reply).catch(()=>{});}
}
// Publication can include a long-running policy command. Wait for the control plane instead of
// ending the session or imposing a request deadline.
async function createPullRequest(args){
  const id=randomBytes(24).toString('hex'),reply=dir+'/pr-reply-'+id+'.json';
  await writeFile(dir+'/pr-request.tmp',JSON.stringify({id,arguments:args}),{mode:0o600});await rename(dir+'/pr-request.tmp',dir+'/pr-request.json');
  try{
    for(;;){
      const value=await readFile(reply,'utf8').then(JSON.parse).catch(()=>null);if(value)return value;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }finally{await unlink(dir+'/pr-request.json').catch(()=>{});await unlink(reply).catch(()=>{});}
}
// The control plane answers only between turns, after all tool results have entered history.
async function boundary(stage){
  const id=randomBytes(24).toString('hex'),reply=dir+'/boundary-reply-'+id+'.json';
  await writeFile(dir+'/boundary.tmp',JSON.stringify({id,stage}),{mode:0o600});await rename(dir+'/boundary.tmp',dir+'/boundary.json');
  try{for(;;){const value=await readFile(reply,'utf8').then(JSON.parse).catch(()=>null);if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}}
  finally{await unlink(dir+'/boundary.json').catch(()=>{});await unlink(reply).catch(()=>{});}
}
const server=createServer(async(req,res)=>{
  try{
    // Any number of model requests per task; only the chat completion endpoint is proxied.
    if(req.url!=='/v1/chat/completions'||req.method!=='POST')throw new Error('model_request_not_allowed');
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024){requestFailure='agent_context_too_large';throw new Error(requestFailure);};chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
    if(estimateTokens({role:'user',content:raw,timestamp:Date.now()})+8192>128000){requestFailure='agent_context_too_large';throw new Error(requestFailure);}
    const id=randomBytes(24).toString('hex');await writeFile(dir+'/request.tmp',JSON.stringify({id,body:JSON.parse(raw)}),{mode:0o600});await rename(dir+'/request.tmp',dir+'/request.json');
    const response=await waitModelReply(dir,id);await unlink(dir+'/request.json');await unlink(dir+'/reply-'+id+'.json');
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
      const name=tool.function.name;
      // Start metadata deliberately excludes file contents and publication payloads.
      await writeEvent({type:'tool_start',name,call_id:id,...(['read_file','write_file'].includes(name)?{path:args.path}:name==='run_command'?{command:args.command}:{})});
      let result;
      const denied=toolCapabilityError(config,name,args);
      if(denied) result={error:denied};
      else if(tool.function.name==='finish_review'){finished=args;result={finished:true};}
      else if(tool.function.name==='create_pull_request'){
        result=await createPullRequest(args);
        if(result.pr||result.status==='no_changes'){finished={...args,...result};setTimeout(()=>void session.abort(),10);}
      }
      else if(tool.function.name==='read_file')result=await workspace({type:'workspace_read',workspace_id:config.workspace_id,path:args.path});
      else if(tool.function.name==='write_file'){
        const note=typeof args.path==='string'&&args.path.startsWith('../notes/');
        try{const data=Buffer.from(args.content);if(!note&&data.length>48000)throw new Error('file_too_large');result=await workspace({type:'workspace_write',workspace_id:config.workspace_id,path:args.path,base64:data.toString('base64'),offset:0,final:true,mode:'100644'});}
        catch(error){result={error:String(error.message)};}
      }else if(tool.function.name==='run_command'){
        // Commands have no time limit; the model may still bound one that could hang.
        const timeout=args.timeout_seconds>0?args.timeout_seconds*1000:null;
        await writeFile(dir+'/command.out','',{mode:0o600});await writeFile(dir+'/live.json',JSON.stringify(clean({operation_id:id,command:args.command,timeout_ms:timeout,keep_background:args.keep_background===true})),{mode:0o600});
        const secret_env=grant?{GH_TOKEN:grant.token,GITHUB_TOKEN:grant.token}:undefined;
        try{result=await workspace({type:'workspace_command',workspace_id:config.workspace_id,command:args.command,timeout_ms:timeout,keep_background:args.keep_background===true,output_file:dir+'/command.out',secret_env});}finally{await unlink(dir+'/live.json').catch(()=>{});}
      }else if(tool.function.name==='github_read_token'){
        // The token stays in this process and reaches later commands only as environment variables; the model sees what it can do, not the value.
        if(!grant||Date.parse(grant.expires_at)-Date.now()<10*60000){const reply=await exchange();if(reply.error)result={error:reply.error};else {grant=reply;secrets.add(grant.token);}}
        result??={variables:['GH_TOKEN','GITHUB_TOKEN'],api:'https://api.github.com',repository:grant.repository,permissions:grant.permissions,expires_at:grant.expires_at};
      }else throw new Error('tool_not_allowed');
      await writeEvent({type:'tool',name:tool.function.name,call_id:id,arguments:args,result});return {content:[{type:'text',text:JSON.stringify(result)}],details:{},...(name==='finish_review'?{terminate:true}:{})};
    }}));
  const history=await readFile(dir+'/restore.json','utf8').then(JSON.parse).catch(()=>[]),sessionManager=SessionManager.inMemory(cwd);
  for(const message of history)sessionManager.appendMessage(message);
  ({session}=await createAgentSession({cwd,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('department-proxy','selected'),thinkingLevel:'off',resourceLoader:loader,
    tools:tools.map(tool=>tool.name),customTools:tools,sessionManager,settingsManager:SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:24000,keepRecentTokens:16000},retry:{enabled:false}})}));
  session.subscribe(event=>{if(event.type==='message_end'&&event.message.role==='assistant'){
    const m=event.message;void writeEvent({type:'model',step:++steps,reasoning:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join(''),content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''),tool_calls:m.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,name:c.name,arguments:JSON.stringify(c.arguments)}))});
  }});
  if(config.review_session){
    session.setSteeringMode('all');
    const previousFinish=session.agent.finishTurn;
    session.agent.finishTurn=async(turn,signal)=>{
      const reply=await boundary('turn');
      for(const message of reply.messages||[])await session.steer(message);
      if(reply.messages?.length)finished=undefined;
      const previous=await previousFinish?.(turn,signal);
      return finished?{action:'end'}:previous;
    };
  }
  let prompt=config.prompt;
  if(config.review_session)prompt=(await boundary('start')).prompt||prompt;
  if(config.review_session&&history.length&&(history.reduce((sum,message)=>sum+estimateTokens(message),0)+estimateTokens({role:'user',content:prompt+config.system,timestamp:Date.now()})>104000||Buffer.byteLength(JSON.stringify(history))>1536*1024)){
    try{await session.compact();}catch(error){requestFailure='agent_context_too_large';throw error;}
  }
  for(;;){
    try{await session.prompt(prompt);}catch(error){if(!finished||requestFailure)throw error;}
    if(requestFailure)throw new Error(requestFailure);
    await events;
    const result=finished||JSON.parse(session.getLastAssistantText().replace(/^```(?:json)?\s*|\s*```$/g,''));
    if(!config.review_session){await save({state:'completed',result,agent:'pi',version:'1.4.0'});break;}
    // Persist the compacted projection, not old system prompts, model selection or discarded raw entries.
    const messages=clean(session.messages.filter(message=>['user','assistant','toolResult','compactionSummary'].includes(message.role)).map(message=>message.role==='compactionSummary'
      ?{role:'user',content:[{type:'text',text:'Previous conversation summary:\n'+message.summary}],timestamp:message.timestamp}:message));
    const encoded=JSON.stringify(messages);if(Buffer.byteLength(encoded)>32*1024*1024)throw new Error('agent_context_too_large');
    await writeFile(dir+'/history.json',encoded,{mode:0o600});
    await save({state:'review_ready',result,agent:'pi',version:'1.4.0'});
    for(;;){if(await readFile(dir+'/continue.json','utf8').catch(()=>null))break;await new Promise(resolve=>setTimeout(resolve,50));}
    await unlink(dir+'/continue.json');finished=undefined;
    await save({state:'review_resuming'});
    const reply=await boundary('resume');
    // Each update remains a distinct user message, in delivery order.
    const messagesToSend=reply.messages||[];prompt=messagesToSend.shift()||'Recheck the current discussion and finish the review.';
    for(const message of messagesToSend)await session.followUp(message);
  }
}catch(error){await events.catch(()=>{});
  // The reason goes into the task log; issued tokens are masked like every event.
  await save({state:'failed',error:requestFailure||((error?.message==='agent_context_too_large')?'agent_context_too_large':'pi_execution_failed'),detail:clean(String(error?.message||error||'unknown')).slice(0,1000)});}
finally{session?.dispose();server.closeAllConnections();server.close();}
