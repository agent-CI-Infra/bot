import {stageSessionSkills} from './session-resources.mjs';
import {dirname,join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {startCredentialHelperServer} from './credential-helper.mjs';
import { localCommandResult, prepareLocalResults } from './tool-results.mjs';
import {readFile,writeFile,rename,unlink,appendFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createAgentSession,createExtensionRuntime,DefaultResourceLoader,createBashTool,createCodingTools,ModelRuntime,SessionManager,SettingsManager,estimateTokens} from '@earendil-works/pi-coding-agent';
import {workspace as runnerWorkspace,notSelected} from './workspace.mjs';
import {commandOptions} from './command-policy.mjs';
import {waitModelReply} from './model-reply.mjs';
import {toolCapabilityError,platformWrites} from './capabilities.mjs';
import {createRepositoryTool} from './repository-tool.mjs';
import {createToolDispatch} from './tool-dispatch.mjs';
import {createTokenExchange,createReadGrant} from './token-exchange.mjs';
import {createToolResultGuard} from './repository-context.mjs';
import {runSubagent} from './subagent.mjs';
import {local} from './paths.mjs';
import {noSpace,toolDiskFull} from './disk.mjs';

const root=process.argv[2],dir=root+'/agent',legacyCwd=root+'/repo',config=JSON.parse(await readFile(dir+'/input.json','utf8'));
const direct=config.model_transport!=='gateway';
const native=config.native_access;
const cwd=native&&/^[a-f0-9]{48}$/.test(config.native_workspace_id??'')?join(dirname(root),config.native_workspace_id,'repo'):legacyCwd;
// Pi keeps its session files and its own state (settings, staged skills, the HOME of its shell) in the task directory the
// control plane names for one task and role instance (session_store). That directory is no checkout, so a later round or a
// retry in another workspace or worktree finds the session again (#1040); it is removed with the task's other directories.
// Without one, the state stays next to the checkout.
const sessionStore=/^[a-f0-9]{48}$/.test(config.session_store??'')?join(dirname(root),config.session_store):dirname(cwd);
const nativeDir=join(sessionStore,'cli-state','pi',String(config.session_key??'session').replace(/[^a-zA-Z0-9_-]/g,''));
const sessionDir=join(nativeDir,'sessions');
let credentialHelper;

if(local)config.system+='\nLocal execution: this is a host process, not a container. Stay inside your task workspace and project notes. Never search the host root filesystem or inspect unrelated projects or credentials. Never use pkill, killall or process-name-wide termination. Use keep_background for servers; the manager cleans your task processes when you finish. Read ../notes/environment.md for verified local tooling.';
const boot=(await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>({}))).boot;
const save=async value=>{value={...value,pid:process.pid,boot};await writeFile(dir+'/state.tmp',JSON.stringify(value),{mode:0o600});await rename(dir+'/state.tmp',dir+'/state.json');};
// recovery: how the main session began (openSession). lastModelError: the error of the latest failed model reply, the
// reason a turn ended without its finishing call.
let steps=0,session,nativeSessionId,recovery,finished,requestFailure,failureDetail,lastModelError;
// reserve: tokens a later request needs beyond raw, such as a compaction summary.
const modelCapabilities=config.model??{context_window:128000,max_output_tokens:8192,reasoning:false};
const outputReserve=config.output_tokens??modelCapabilities.max_output_tokens;
const modelRequestTooLarge=(raw,reserve=0)=>estimateTokens({role:'user',content:raw,timestamp:Date.now()})+outputReserve+reserve>modelCapabilities.context_window;
// Serialize model and tool events in execution order; mask every issued token before it reaches disk.
const secrets=new Set();let events=Promise.resolve();
if(config.native_model?.key)secrets.add(config.native_model.key);
const clean=value=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'?[...secrets].reduce((text,secret)=>text.replaceAll(secret,'[REDACTED]'),item):item));
const writeEvent=value=>{const line=JSON.stringify(clean(value))+'\n';events=events.then(()=>appendFile(dir+'/events.jsonl',line,{mode:0o600}));return events;};
// Asks the control plane for a read-only GitHub token through the task mailbox, as model requests do.
const exchange=createTokenExchange(dir),grant=createReadGrant(exchange,token=>secrets.add(token));
// Repository exploration, publication and control-plane tools share the per-request tool mailbox with mcp-bridge.mjs.
const repositoryTool=createRepositoryTool(dir);
const dispatchTool=createToolDispatch(dir);
// The tools that end the task: finish_review unless the configuration names others (a development task ends with its PR).
const finishTools=new Set(config.finish_tools||['finish_review']);
// The calls that end this session as the model sees them: the finish tools and, for development, create_pull_request.
const finishingNames=config.tools.map(tool=>tool.function.name).filter(name=>finishTools.has(name)||name==='create_pull_request'&&config.finish_on_pull_request!==false);
// How many times one prompt may be followed by "continue and finish" before the run fails with agent_finish_missing.
const finishNudges=3;
// Tools the control plane runs itself (a project controller's task-record queries and delegation). The call waits
// without a deadline: a delegation lasts as long as the delegated role runs.
const controlTools=new Set(config.control_tools||[]);
// The SDK version that actually runs, from its installed manifest; reported with every state and session event.
const sdk={agent:'pi',package:'@earendil-works/pi-coding-agent',version:await readFile(new URL('../package.json',import.meta.resolve('@earendil-works/pi-coding-agent')),'utf8').then(text=>JSON.parse(text).version).catch(()=>'unknown'),node:process.version};
// A task gets its worktree when it first needs one (#769). A file tool or command that finds none asks the control plane to
// bind it, the one the agent chose or the system's choice, and runs again; it answers with the control plane's reason when
// the task has none (the agent chose no workspace).
async function workspace(request,signal){
  try{return await runnerWorkspace(request);}
  catch(error){
    if(!String(error?.message).startsWith(notSelected))throw error;
    const reply=await dispatchTool('ensure_workspace',{},{kind:'workspace',signal,cancelledError:'workspace_cancelled'});
    if(reply?.error)return {error:reply.error,...(reply.message?{message:reply.message}:{})};
    return runnerWorkspace(request);
  }
}
async function controlTool(name,args,signal){
  const reply=await dispatchTool(name,args,{kind:'control',signal,cancelledError:'control_tool_cancelled'});
  return reply&&typeof reply==='object'&&'result' in reply?reply:{result:reply};
}
// Publication can include a long-running policy command. Wait for the control plane instead of
// ending the session or imposing a request deadline.
function createPullRequest(args,signal){
  return dispatchTool('create_pull_request',args,{kind:'pull_request',signal,cancelledError:'pull_request_cancelled'});
}
// The control plane answers only between turns, after all tool results have entered history. The start of a review also
// says how its session began, so the control plane can tell it what an earlier round left only when it is not in it.
async function boundary(stage,detail={}){
  const id=randomBytes(24).toString('hex'),reply=dir+'/boundary-reply-'+id+'.json';
  await writeFile(dir+'/boundary.tmp',JSON.stringify({...detail,id,stage}),{mode:0o600});await rename(dir+'/boundary.tmp',dir+'/boundary.json');
  try{for(;;){const value=await readFile(reply,'utf8').then(JSON.parse).catch(()=>null);if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}}
  finally{await unlink(dir+'/boundary.json').catch(()=>{});await unlink(reply).catch(()=>{});}
}
// One model request at a time goes through the mailbox, whether the main agent or a sub-agent sends it.
let proxyQueue=Promise.resolve();
const server=direct?null:createServer((req,res)=>{const run=proxyQueue.then(()=>proxy(req,res));proxyQueue=run.catch(()=>{});});
// A request over the 2 MiB mailbox or 128k context limit never leaves the runner. It is answered the way a provider
// reports a context overflow (HTTP 413), because Pi's own threshold compaction does not always run first: it measures
// provider-reported usage, not this raw-request estimate, and it always keeps the latest ~16k tokens, so a huge message
// among them leaves nothing to cut yet. Pi then compacts once and retries; the run fails only when that recovery fails
// (compaction_end below).
// A model error saying a request did not fit: this proxy's answer below, and the generic wording providers use (a subset of
// Pi's own overflow patterns).
const contextOverflow=/context[_ ]length[_ ]exceeded|exceeds the context window|maximum context length|prompt (?:is )?too long|request_too_large|too many tokens|token limit exceeded/i;
const overflow=(res,detail)=>{res.writeHead(413,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:{type:'invalid_request_error',code:'context_length_exceeded',message:'Request exceeds the context window of this model: '+detail}}));};
async function proxy(req,res){
  try{
    // Any number of model requests per task; only the chat completion endpoint is proxied.
    if(req.url!=='/v1/chat/completions'||req.method!=='POST')throw new Error('model_request_not_allowed');
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes<=2*1024*1024)chunks.push(chunk);}
    if(bytes>2*1024*1024)return overflow(res,`${bytes} bytes exceed the 2 MiB request limit.`);
    const raw=Buffer.concat(chunks).toString('utf8');
    if(modelRequestTooLarge(raw))return overflow(res,`the estimated tokens plus the ${outputReserve}-token output reserve exceed ${modelCapabilities.context_window}.`);
    const id=randomBytes(24).toString('hex');await writeFile(dir+'/request.tmp',JSON.stringify({id,body:JSON.parse(raw)}),{mode:0o600});await rename(dir+'/request.tmp',dir+'/request.json');
    const response=await waitModelReply(dir,id);await unlink(dir+'/request.json');await unlink(dir+'/reply-'+id+'.json');
    res.writeHead(response.status,{'Content-Type':response.content_type});res.end(response.body);
  }catch{res.writeHead(502,{'Content-Type':'application/json'});res.end('{"error":"model_proxy_unavailable"}');}
}
try{
  if(direct&&!config.native_model)throw new Error('pi_native_model_required');
  if(!direct){server.listen(0,'127.0.0.1');await once(server,'listening');}
  // This literal is not a provider credential. The local proxy ignores it and cannot reach any provider itself.
  const providerId=direct?'department-direct':'department-proxy',modelId=direct?config.native_model.model:'selected';
  const api=direct?({'openai-chat-completions':'openai-completions','openai-responses':'openai-responses','anthropic-messages':'anthropic-messages'}[config.native_model.interfaceType]):'openai-completions';
  await writeFile(dir+'/models.json',JSON.stringify({providers:{[providerId]:{api,baseUrl:direct?config.native_model.baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',apiKey:direct?config.native_model.key:'local-proxy',models:[{id:modelId,name:direct?modelId:'Project model',contextWindow:modelCapabilities.context_window,maxTokens:modelCapabilities.max_output_tokens,reasoning:modelCapabilities.reasoning,input:['text'],...(api==='openai-completions'?{compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false}}:{})}]}}}),{mode:0o600});
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
      else if(['github_read','github_search','read_job_log','read_task_history','record_progress','search_project_memory','read_project_memory','remember_project_memory'].includes(name)||Object.hasOwn(platformWrites,name)&&!agent)result=await repositoryTool(name,args,signal);
      else if(finishTools.has(name)&&!agent){finished=args;result={finished:true};}
      else if(name==='create_pull_request'&&!agent){
        result=await createPullRequest(args,signal);
        // Development ends with its pull request; other workflows publish one and carry on to their own finish.
        if(config.finish_on_pull_request!==false&&(result.pr||result.status==='no_changes')){finished={...args,...result};setTimeout(()=>void session.abort(),10);}
      }
      // A sub-agent is a new session built from its own configuration; it never sees this conversation.
      else if(name==='start_agent'&&!agent)result=await runSubagent({config:cfg,args,id:'agent-'+randomBytes(6).toString('hex'),createSession,writeEvent});
      else if(name==='read_tool_result')result=await repositoryTool(name,args,signal);
      else if(name==='read_file')result=await workspace({type:'workspace_read',workspace_id:cfg.workspace_id,path:args.path},signal);
      else if(name==='write_file'){
        const note=typeof args.path==='string'&&args.path.startsWith('../notes/');
        try{const data=Buffer.from(args.content);if(!note&&data.length>48000)throw new Error('file_too_large');result=await workspace({type:'workspace_write',workspace_id:cfg.workspace_id,path:args.path,base64:data.toString('base64'),offset:0,final:true,mode:'100644'},signal);}
        catch(error){result={error:String(error.message)};}
      }else if(name==='run_command'){
        const policy=cfg.command_timeout??{default_seconds:null,max_seconds:600};
        const options=commandOptions(args,policy.default_seconds,policy.max_seconds);
        if(!options.request)result={error:options.error,message:options.message};
        else {
          const outputId=randomBytes(24).toString('hex'),outputDirectory=dir+'/results';
          const secret_env=await grant.env(signal);
          try{await prepareLocalResults(outputDirectory);
            await writeFile(dir+'/command.out','',{mode:0o600});await writeFile(dir+'/live.json',JSON.stringify(clean({operation_id:id,output_file:outputDirectory+'/'+outputId+'.utf8',...options.request})),{mode:0o600});
            result=await workspace({...options.request,workspace_id:cfg.workspace_id,output_file:outputDirectory+'/'+outputId+'.utf8',secret_env},signal);
            result=await localCommandResult(outputId,result,args=>repositoryTool('store_command_result',args,signal));
            if(options.timeout_notice)result={...result,timeout_notice:options.timeout_notice};
          }catch(error){if(!noSpace(error))throw error;result={error:String(error.message)};}
          finally{await unlink(dir+'/live.json').catch(()=>{});}
        }
      }else if(name==='github_read_token'){
        // The token stays in this process and reaches later commands only as environment variables; the model sees what it can do, not the value.
        const reply=await grant.request(signal);
        result=reply.error?{error:reply.error}:reply.structured_only?{repository:reply.repository,permissions:reply.permissions,variables:[],instruction:reply.instruction}
          :{variables:['GH_TOKEN','GITHUB_TOKEN'],api:'https://api.github.com',repository:reply.repository,permissions:reply.permissions,expires_at:reply.expires_at};
      }else result={error:'tool_not_allowed'};
      // A write or command that failed because the work volume ran full ends the task as disk_full, waiting for space
      // (#671), rather than letting the model read it as a failed command or failing tests: no further model request.
      const full=['run_command','write_file'].includes(name)?toolDiskFull(result):null;
      if(full&&!requestFailure){requestFailure='disk_full';failureDetail=`${name}${name==='run_command'?' '+String(args.command).slice(0,200):' '+args.path}: ${full}`;if(agent)setTimeout(()=>void session.abort(),10);}
      result=await guard.check(id,name,result);
      await writeEvent({type:'tool',name,call_id:id,...who,arguments:args,result});return {content:[{type:'text',text:JSON.stringify(result)}],details:{},...(full||submitted||finishTools.has(name)&&!agent&&!controlTools.has(name)?{terminate:true}:{})};
    }}));
  // The main session is the one the control plane bound to this task and role instance (native_session): its file is
  // opened under the current working directory, whatever directory the session was recorded in (native_resume). A new
  // session starts when there is no binding, its file is gone or holds another session (rebuilt_from_task_records: the
  // control plane's prompt carries what the task records keep), and always for QA. A sub-agent's session is never
  // continued, so it is not stored.
  function openSession(agent){
    if(agent)return {manager:SessionManager.inMemory(cwd),mode:'new_session'};
    const bound=config.native_session,file=typeof bound?.file==='string'?resolve(bound.file):'';
    if(!config.native_fresh&&file.endsWith('.jsonl')&&dirname(file)===resolve(sessionDir)&&existsSync(file))try{
      const manager=SessionManager.open(file,sessionDir,cwd);
      if(manager.getSessionId()===bound.id)return {manager,mode:'native_resume'};
    }catch{}
    return {manager:SessionManager.create(cwd,sessionDir),mode:config.native_fresh?'fresh_evaluation':bound?.id?'rebuilt_from_task_records':'new_session'};
  }
  // A Pi session from one configuration: its system prompt and its tools. Pi's own settings apply, compaction and retry
  // included; a session without native access reads no repository settings, as it loads none of its other resources.
  async function createSession(cfg,agent){
    await mkdir(nativeDir,{recursive:true,mode:0o700});
    const settingsManager=SettingsManager.create(cwd,nativeDir,{projectTrusted:!!native});
    const loader=native?new DefaultResourceLoader({cwd,agentDir:nativeDir,settingsManager,appendSystemPrompt:[cfg.system]}):{getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>cfg.system,getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{}};
    if(native){await stageSessionSkills(nativeDir,cfg.resources);await loader.reload();}
    const guard={check:async(_id,_name,value)=>value},tools=makeTools(cfg,agent,guard);
    const {manager:sessionManager,mode}=openSession(agent);
    if(!agent){nativeSessionId=sessionManager.getSessionId();recovery=mode;}
    if(native?.commands){
      credentialHelper??=await startCredentialHelperServer({agentDir:dir,runToken:config.run_token,addSecret:token=>secrets.add(token)});
      const bin=nativeDir+'/bin';await mkdir(bin,{recursive:true,mode:0o700});
      await writeFile(bin+'/gh',`#!/bin/sh\nexec "${process.execPath}" "${new URL('./gh-wrapper.mjs',import.meta.url).pathname}" "$@"\n`,{mode:0o700});
      const bash=createBashTool(cwd,{spawnHook:ctx=>({...ctx,env:{...ctx.env,HOME:nativeDir,PATH:bin+':'+(ctx.env.PATH??''),BOT_WRAPPER_BIN_DIR:bin,BOT_CREDENTIAL_HELPER_URL:credentialHelper.url,BOT_CREDENTIAL_HELPER_SECRET:credentialHelper.secret}})});
      tools.push({...bash,label:'bash'});
    }
    const fileAccess=native?.fileTools??native?.workspace;
    const builtin=native?[...(fileAccess!=='none'?['read','grep','find','ls']:[]),...(fileAccess==='write'?['edit','write']:[]),...(native.commands?['bash']:[])]:[];
    if(native){
      tools.push(...createCodingTools(cwd).filter(tool=>builtin.includes(tool.name)&&tool.name!=='bash'));
      for(let i=0;i<tools.length;i++)if(builtin.includes(tools[i].name)){
        const tool=tools[i];tools[i]={...tool,execute:async(...args)=>{
          const ready=await dispatchTool('ensure_workspace',{},{kind:'workspace',signal:args[2],cancelledError:'workspace_cancelled'});
          if(ready?.error)return {content:[{type:'text',text:JSON.stringify(ready)}],details:ready,isError:true};
          return tool.execute(...args);
        }};
      }
    }
    const {session:created}=await createAgentSession({cwd,agentDir:native?nativeDir:dir,modelRuntime:runtime,model:runtime.getModel(providerId,modelId),resourceLoader:loader,
      tools:[...builtin,...tools.map(tool=>tool.name)],customTools:tools,sessionManager,settingsManager});
    // The control plane binds the task's role instance to this session and file; the next run opens them again.
    if(!agent)await writeEvent({type:'session_bound',session_id:sessionManager.getSessionId(),recoveryMode:mode,transcript:sessionManager.getSessionFile(),messages:created.messages.length,native_tools:builtin,resources:{skills:loader.getSkills().skills.map(s=>s.name),context_files:loader.getAgentsFiles().agentsFiles.map(f=>f.path)}});
    guard.check=createToolResultGuard({getMessages:()=>created.messages,tooLarge:modelRequestTooLarge,preserve:(name,value)=>repositoryTool('store_tool_result',{name,value}),renderRequest:async messages=>{
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
    created.subscribe(event=>{
      if(native&&['tool_execution_start','tool_execution_end'].includes(event.type))void writeEvent({type:'tool',phase:event.type==='tool_execution_start'?'started':'completed',name:event.toolName,call_id:event.toolCallId,...(event.args?{arguments:event.args}:{}),...(event.result?{result:event.result}:{}),isError:event.isError});
      // Pi recovers from a request over the context window itself: it compacts once and retries. The session is over the
      // limit (agent_context_too_large) when the retry still does not fit, or when the compaction's own summary request
      // does not fit either; reopening it would fail the same way. A compaction that failed otherwise (its summary request
      // failed, an extension cancelled it) keeps its own reason and the session. Pi 1.4.0 says which only in its message.
      if(event.type==='compaction_end'&&event.reason==='overflow'&&event.errorMessage&&!event.aborted&&!requestFailure){
        requestFailure=/ recovery failed after /.test(event.errorMessage)||contextOverflow.test(event.errorMessage)?'agent_context_too_large':'agent_compaction_failed';failureDetail=event.errorMessage;
      }
      if(event.type==='message_end'&&event.message.role==='assistant'){
        guard.check.reset();
        const m=event.message;lastModelError=m.stopReason==='error'&&m.errorMessage?String(m.errorMessage):undefined;void writeEvent({type:'model',step:agent?++own:++steps,...(agent?{agent}:{}),...(direct?{model:m.model,usage:m.usage,source:'pi_native'}:{}),reasoning:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join(''),content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''),tool_calls:m.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,name:c.name,arguments:JSON.stringify(c.arguments)}))});
      }
    });
    return created;
  }
  session=await createSession(config,null);
  // The runtime and the exact tool surface of this session, before its first model request.
  await writeEvent({type:'pi_session',...sdk,tools:session.agent.state.tools.map(tool=>tool.name),control_tools:[...controlTools],native:!!native,recovery});
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
  // Compaction is Pi's: it compacts the reopened session when a request needs it, never an empty one up front.
  let prompt=config.prompt;
  if(config.review_session)prompt=(await boundary('start',{recovery})).prompt||prompt;
  // A JSON result written as the last answer, the older way to finish; undefined when there is none.
  const textResult=()=>{
    const text=session.getLastAssistantText();if(typeof text!=='string'||!text.trim())return undefined;
    try{return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{return undefined;}
  };
  // Runs one prompt until the session finishes. A turn can end without finishing: an empty or failed model reply, or prose
  // instead of the finishing call. The work so far is in this session, so it is asked to continue (a bounded number of
  // times) rather than failing the attempt and starting again in a fresh workspace.
  async function untilFinished(input){
    for(let nudge=0;;nudge++){
      try{await session.prompt(input);}catch(error){if(!finished||requestFailure)throw error;}
      if(requestFailure)throw Object.assign(new Error(requestFailure),failureDetail?{detail:failureDetail}:{});
      // A controlled session ends only through its control-plane submission; without one the control plane decides.
      if(finished)return finished;
      if(config.accept_turn_result)return {harness_turn:true,text:session.getLastAssistantText()??'',session_id:nativeSessionId};
      if(controlTools.size)return null;
      const result=textResult();if(result!==undefined)return result;
      const names=finishingNames.join(' or ')||'a finishing tool';
      if(nudge>=finishNudges)throw Object.assign(new Error('agent_finish_missing'),{detail:`The model ended ${nudge+1} turns without calling ${names}.${lastModelError?' Last model error: '+lastModelError.slice(0,500):''}`});
      await writeEvent({type:'agent_nudge',attempt:nudge+1,finishing_tools:finishingNames});
      input=`Your last reply ended the turn without finishing the task: it did not call ${names}. Continue from where you stopped, using the work already done in this session, and finish by calling ${names}.`;
    }
  }
  for(;;){
    const result=await untilFinished(prompt);
    await events;
    if(!config.review_session){await save({state:'completed',result,...sdk});break;}
    // The conversation is in the session file; a later round opens it again.
    await save({state:'review_ready',result,...sdk});
    for(;;){if(await readFile(dir+'/continue.json','utf8').catch(()=>null))break;await new Promise(resolve=>setTimeout(resolve,50));}
    await unlink(dir+'/continue.json');finished=undefined;grant.resume();
    await save({state:'review_resuming'});
    const reply=await boundary('resume');
    // Each update remains a distinct user message, in delivery order.
    const messagesToSend=reply.messages||[];prompt=messagesToSend.shift()||'Recheck the current discussion and finish the review.';
    for(const message of messagesToSend)await session.followUp(message);
  }
}catch(error){await events.catch(()=>{});
  // The reason goes into the task log; issued tokens are masked like every event.
  const known=['agent_context_too_large','agent_compaction_failed','agent_finish_missing','disk_full'];
  await save({state:'failed',error:requestFailure||(known.includes(error?.message)?error.message:noSpace(error)?'disk_full':'pi_execution_failed'),detail:clean(String(failureDetail||error?.detail||error?.message||error||'unknown')).slice(0,1000)});}
finally{session?.dispose();if(server?.listening){server.closeAllConnections();server.close();}await credentialHelper?.close();}
