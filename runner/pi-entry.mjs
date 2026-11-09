import {readFile,writeFile,rename,unlink,appendFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createAgentSession,createExtensionRuntime,ModelRuntime,SessionManager,SettingsManager,estimateTokens} from '@earendil-works/pi-coding-agent';
import {workspace} from './workspace.mjs';
import {waitModelReply} from './model-reply.mjs';
import {toolCapabilityError,platformWrites} from './capabilities.mjs';
import {createRepositoryTool} from './repository-tool.mjs';
import {createTokenExchange} from './token-exchange.mjs';
import {createToolResultGuard} from './repository-context.mjs';
import {runSubagent} from './subagent.mjs';
import {local} from './paths.mjs';

const root=process.argv[2],dir=root+'/agent',cwd=root+'/repo',config=JSON.parse(await readFile(dir+'/input.json','utf8'));
if(local)config.system+='\nLocal execution: this is a host process, not a container. Stay inside your task workspace and project notes. Never search the host root filesystem or inspect unrelated projects or credentials. Never use pkill, killall or process-name-wide termination. Use keep_background for servers; the manager cleans your task processes when you finish. Read ../notes/environment.md for verified local tooling.';
const boot=(await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>({}))).boot;
const save=async value=>{value={...value,pid:process.pid,boot};await writeFile(dir+'/state.tmp',JSON.stringify(value),{mode:0o600});await rename(dir+'/state.tmp',dir+'/state.json');};
let steps=0,session,finished,grant=null,requestFailure;
// reserve: tokens a later request needs beyond raw, such as a compaction summary.
const modelRequestTooLarge=(raw,reserve=0)=>estimateTokens({role:'user',content:raw,timestamp:Date.now()})+8192+reserve>128000;
// Serialize model and tool events in execution order; mask every issued token before it reaches disk.
const secrets=new Set();let events=Promise.resolve();
const clean=value=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'?[...secrets].reduce((text,secret)=>text.replaceAll(secret,'[REDACTED]'),item):item));
const writeEvent=value=>{const line=JSON.stringify(clean(value))+'\n';events=events.then(()=>appendFile(dir+'/events.jsonl',line,{mode:0o600}));return events;};
// Asks the control plane for a read-only GitHub token through the task mailbox, as model requests do.
const exchange=createTokenExchange(dir);
// Repository exploration and the platform's write tools run in the control plane, through one mailbox.
const repositoryTool=createRepositoryTool(dir);
// The tools that end the task: finish_review unless the configuration names others (a development task ends with its PR).
const finishTools=new Set(config.finish_tools||['finish_review']);
// Tools the control plane runs itself (a project controller's task-record queries and delegation). The call waits
// without a deadline: a delegation lasts as long as the delegated role runs.
const controlTools=new Set(config.control_tools||[]);
// The SDK version that actually runs, from its installed manifest; reported with every state and session event.
const sdk={agent:'pi',package:'@earendil-works/pi-coding-agent',version:await readFile(new URL('../package.json',import.meta.resolve('@earendil-works/pi-coding-agent')),'utf8').then(text=>JSON.parse(text).version).catch(()=>'unknown'),node:process.version};
async function controlTool(name,args,signal){
  const id=randomBytes(24).toString('hex'),reply=dir+'/control-reply-'+id+'.json';
  await writeFile(dir+'/control-request.tmp',JSON.stringify({id,name,arguments:args}),{mode:0o600});await rename(dir+'/control-request.tmp',dir+'/control-request.json');
  try{
    for(;;){
      if(signal?.aborted)return {result:{error:'control_tool_cancelled'}};
      const value=await readFile(reply,'utf8').then(JSON.parse).catch(()=>null);if(value)return value;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }finally{await unlink(dir+'/control-request.json').catch(()=>{});await unlink(reply).catch(()=>{});}
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
// One model request at a time goes through the mailbox, whether the main agent or a sub-agent sends it.
let proxyQueue=Promise.resolve();
const server=createServer((req,res)=>{const run=proxyQueue.then(()=>proxy(req,res));proxyQueue=run.catch(()=>{});});
async function proxy(req,res){
  try{
    // Any number of model requests per task; only the chat completion endpoint is proxied.
    if(req.url!=='/v1/chat/completions'||req.method!=='POST')throw new Error('model_request_not_allowed');
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024){requestFailure='agent_context_too_large';throw new Error(requestFailure);};chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
    if(modelRequestTooLarge(raw)){requestFailure='agent_context_too_large';throw new Error(requestFailure);}
    const id=randomBytes(24).toString('hex');await writeFile(dir+'/request.tmp',JSON.stringify({id,body:JSON.parse(raw)}),{mode:0o600});await rename(dir+'/request.tmp',dir+'/request.json');
    const response=await waitModelReply(dir,id);await unlink(dir+'/request.json');await unlink(dir+'/reply-'+id+'.json');
    res.writeHead(response.status,{'Content-Type':response.content_type});res.end(response.body);
  }catch{res.writeHead(502,{'Content-Type':'application/json'});res.end('{"error":"model_proxy_unavailable"}');}
}
server.listen(0,'127.0.0.1');await once(server,'listening');
try{
  // This literal is not a provider credential. The local proxy ignores it and cannot reach any provider itself.
  await writeFile(dir+'/models.json',JSON.stringify({providers:{'department-proxy':{api:'openai-completions',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:'local-proxy',models:[{id:'selected',name:'Project model',contextWindow:128000,maxTokens:8192,reasoning:false,input:['text'],compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false}}]}}}),{mode:0o600});
  const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:dir+'/models.json',modelsStorePath:dir+'/catalog.json',allowModelNetwork:false});
  // Tools for one agent. cfg holds that agent's trusted capabilities; agent names a sub-agent in the task log; guard
  // checks repository results against that agent's own session.
  const makeTools=(cfg,agent,guard)=>cfg.tools.map(tool=>({name:tool.function.name,label:tool.function.name,description:tool.function.description,parameters:tool.function.parameters,
    async execute(id,args,signal){
      const name=tool.function.name,who=agent?{agent}:{};
      // Start metadata deliberately excludes file contents and publication payloads.
      await writeEvent({type:'tool_start',name,call_id:id,...who,...(['read_file','write_file'].includes(name)?{path:args.path}:name==='run_command'?{command:args.command}:{})});
      let result,submitted=false;
      const denied=controlTools.has(name)&&!agent?null:toolCapabilityError(cfg,name,args);
      if(denied) result={error:denied};
      // The control plane decides the result; only its explicit finish ends this session with the validated submission.
      else if(controlTools.has(name)&&!agent){const reply=await controlTool(name,args,signal);result=reply.result;if(reply.finish===true){finished=reply.result;submitted=true;}}
      else if(['github_read','github_search','read_job_log','read_task_history','read_playbook','select_playbooks','record_progress','search_project_memory','read_project_memory','remember_project_memory'].includes(name)||Object.hasOwn(platformWrites,name)&&!agent)result=await repositoryTool(name,args,signal);
      else if(finishTools.has(name)&&!agent){finished=args;result={finished:true};}
      else if(name==='create_pull_request'&&!agent){
        result=await createPullRequest(args);
        // Development ends with its pull request; other workflows publish one and carry on to their own finish.
        if(config.finish_on_pull_request!==false&&(result.pr||result.status==='no_changes')){finished={...args,...result};setTimeout(()=>void session.abort(),10);}
      }
      // A sub-agent is a new session built from its own configuration; it never sees this conversation.
      else if(name==='start_agent'&&!agent)result=await runSubagent({config:cfg,args,id:'agent-'+randomBytes(6).toString('hex'),createSession:(child,childId)=>createSession(child,childId,[]),writeEvent});
      else if(name==='read_file')result=await workspace({type:'workspace_read',workspace_id:cfg.workspace_id,path:args.path});
      else if(name==='write_file'){
        const note=typeof args.path==='string'&&args.path.startsWith('../notes/');
        try{const data=Buffer.from(args.content);if(!note&&data.length>48000)throw new Error('file_too_large');result=await workspace({type:'workspace_write',workspace_id:cfg.workspace_id,path:args.path,base64:data.toString('base64'),offset:0,final:true,mode:'100644'});}
        catch(error){result={error:String(error.message)};}
      }else if(name==='run_command'){
        // Commands have no time limit; the model may still bound one that could hang.
        const timeout=args.timeout_seconds>0?args.timeout_seconds*1000:null;
        await writeFile(dir+'/command.out','',{mode:0o600});await writeFile(dir+'/live.json',JSON.stringify(clean({operation_id:id,command:args.command,timeout_ms:timeout,keep_background:args.keep_background===true})),{mode:0o600});
        const secret_env=grant?{GH_TOKEN:grant.token,GITHUB_TOKEN:grant.token}:undefined;
        try{result=await workspace({type:'workspace_command',workspace_id:cfg.workspace_id,command:args.command,timeout_ms:timeout,keep_background:args.keep_background===true,output_file:dir+'/command.out',secret_env});}finally{await unlink(dir+'/live.json').catch(()=>{});}
      }else if(name==='github_read_token'){
        // The token stays in this process and reaches later commands only as environment variables; the model sees what it can do, not the value.
        if(!grant||Date.parse(grant.expires_at)-Date.now()<10*60000){const reply=await exchange(signal);if(reply.error)result={error:reply.error};else {grant=reply;secrets.add(grant.token);}}
        result??={variables:['GH_TOKEN','GITHUB_TOKEN'],api:'https://api.github.com',repository:grant.repository,permissions:grant.permissions,expires_at:grant.expires_at};
      }else result={error:'tool_not_allowed'};
      result=await guard.check(id,name,result);
      await writeEvent({type:'tool',name,call_id:id,...who,arguments:args,result});return {content:[{type:'text',text:JSON.stringify(result)}],details:{},...(submitted||finishTools.has(name)&&!agent&&!controlTools.has(name)?{terminate:true}:{})};
    }}));
  // A Pi session from one configuration: its system prompt, its tools and the history it is given (none for a sub-agent).
  async function createSession(cfg,agent,history){
    const loader={getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>cfg.system,getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{}};
    const guard={check:async(_id,_name,value)=>value},tools=makeTools(cfg,agent,guard),sessionManager=SessionManager.inMemory(cwd);
    for(const message of history)sessionManager.appendMessage(message);
    const {session:created}=await createAgentSession({cwd,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('department-proxy','selected'),thinkingLevel:'off',resourceLoader:loader,
      tools:tools.map(tool=>tool.name),customTools:tools,sessionManager,settingsManager:SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:24000,keepRecentTokens:16000},retry:{enabled:false}})});
    guard.check=createToolResultGuard({getMessages:()=>created.messages,tooLarge:modelRequestTooLarge,renderRequest:async messages=>{
      // Let the same SDK serialize the projected request, then stop before any HTTP request or accounting.
      let raw;
      const stream=runtime.streamSimple(created.agent.state.model,{messages:await created.agent.convertToLlm(messages),tools:created.agent.state.tools},{
        onPayload(payload){raw=JSON.stringify(payload);throw new Error('repository_request_preview_complete');}
      });
      await stream.result();
      if(raw===undefined)throw new Error('repository_request_preview_failed');
      return raw;
    }});
    let own=0;
    created.subscribe(event=>{if(event.type==='message_end'&&event.message.role==='assistant'){
      guard.check.reset();
      const m=event.message;void writeEvent({type:'model',step:agent?++own:++steps,...(agent?{agent}:{}),reasoning:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join(''),content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''),tool_calls:m.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,name:c.name,arguments:JSON.stringify(c.arguments)}))});
    }});
    return created;
  }
  const history=await readFile(dir+'/restore.json','utf8').then(JSON.parse).catch(()=>[]);
  session=await createSession(config,null,history);
  // The runtime and the exact tool surface of this session, before its first model request.
  await writeEvent({type:'pi_session',...sdk,tools:config.tools.map(tool=>tool.function.name),control_tools:[...controlTools],extensions:0,skills:0,context_files:0,restored_messages:history.length});
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
    // A controlled session ends only through its control-plane submission; without one the control plane decides.
    const result=finished||(controlTools.size?null:JSON.parse(session.getLastAssistantText().replace(/^```(?:json)?\s*|\s*```$/g,'')));
    if(!config.review_session){await save({state:'completed',result,...sdk});break;}
    // Persist the compacted projection, not old system prompts, model selection or discarded raw entries.
    const messages=clean(session.messages.filter(message=>['user','assistant','toolResult','compactionSummary'].includes(message.role)).map(message=>message.role==='compactionSummary'
      ?{role:'user',content:[{type:'text',text:'Previous conversation summary:\n'+message.summary}],timestamp:message.timestamp}:message));
    const encoded=JSON.stringify(messages);if(Buffer.byteLength(encoded)>32*1024*1024)throw new Error('agent_context_too_large');
    await writeFile(dir+'/history.json',encoded,{mode:0o600});
    await save({state:'review_ready',result,...sdk});
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
