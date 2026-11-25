import {dirname,isAbsolute,join,resolve} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {startCredentialHelperServer} from './credential-helper.mjs';
import {buildGitConfigEnv} from './git-credential-bot.mjs';
import { localCommandResult, prepareLocalResults } from './tool-results.mjs';
import {readFile,writeFile,rename,unlink,appendFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createAgentSession,createExtensionRuntime,DefaultResourceLoader,createBashTool,createCodingTools,ModelRuntime,SessionManager,SettingsManager,estimateTokens} from '@earendil-works/pi-coding-agent';
import {workspace as runnerWorkspace,notSelected} from './workspace.mjs';
import {commandOptions} from './command-policy.mjs';
import {startModelBridge} from './model-relay.mjs';
import {toolCapabilityError,platformWrites} from './capabilities.mjs';
import {createRepositoryTool} from './repository-tool.mjs';
import {createToolDispatch} from './tool-dispatch.mjs';
import {createTokenExchange,createReadGrant} from './token-exchange.mjs';
import {createToolResultGuard} from './repository-context.mjs';
import {runSubagent} from './subagent.mjs';
import {local,assistant,homeDirectory} from './paths.mjs';
import {noSpace,toolDiskFull} from './disk.mjs';
import {Redactor} from './credential-redaction.mjs';
import {TEXT_REQUEST_LIMIT,IMAGE_REQUEST_LIMIT,MAX_IMAGES_IN_CONTEXT,IMAGE_TOKEN_ESTIMATE,sanitizeImageEvents,analyzeModelPayload,enforceSessionImageBudget,isImageOrPayloadRejection,extractToolContentBlocks} from './image-budget.mjs';

const root=process.argv[2],dir=root+'/agent',legacyCwd=root+'/repo',config=JSON.parse(await readFile(dir+'/input.json','utf8'));
if(config.run_token){const scrubbed={...config};delete scrubbed.run_token;await writeFile(dir+'/input.json.tmp',JSON.stringify(scrubbed),{mode:0o600});await rename(dir+'/input.json.tmp',dir+'/input.json');}
const native=config.native_access;
const cwd=native&&/^[a-f0-9]{48}$/.test(config.native_workspace_id??'')?join(dirname(root),config.native_workspace_id,'repo'):legacyCwd;
// Pi keeps its session files and its own state (settings, staged skills, and for project computers the HOME of its shell)
// in the task directory the control plane names for one task and role instance (session_store); inside assistant computers,
// the bash tool uses persistent /home/assistant as HOME so ~ aligns with ~/memory/ and other HOME paths. That directory is
// no checkout, so a later round or a retry in another workspace or worktree finds the session again (#1040); it is removed
// with the task's other directories. Without one, the state stays next to the checkout.
const sessionStore=/^[a-f0-9]{48}$/.test(config.session_store??'')?join(dirname(root),config.session_store):dirname(cwd);
const nativeDir=join(sessionStore,'cli-state','pi',String(config.session_key??'session').replace(/[^a-zA-Z0-9_-]/g,''));
const sessionDir=join(nativeDir,'sessions');
let credentialHelper;

if(local)config.system+='\nLocal execution: this is a host process, not a container. Stay inside your task workspace and project notes. Never search the host root filesystem or inspect unrelated projects or credentials. Never use pkill, killall or process-name-wide termination. Use keep_background for servers; the manager cleans your task processes when you finish. Read ../notes/environment.md for verified local tooling.';
const boot=(await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>({}))).boot;
const save=async value=>{value={...value,pid:process.pid,boot};await writeFile(dir+'/state.tmp',JSON.stringify(value),{mode:0o600});await rename(dir+'/state.tmp',dir+'/state.json');};
// recovery: how the main session began (openSession). lastModelError: the error of the latest failed model reply, the
// reason a turn ended without its finishing call.
let steps=0,session,nativeSessionId,recovery,finished,requestFailure,failureDetail,lastModelError,pendingImageRecovery=null;
// reserve: tokens a later request needs beyond raw, such as a compaction summary.
const modelCapabilities=config.model??{context_window:128000,max_output_tokens:8192,reasoning:false,image_input:true};
const modelSupportsImage=modelCapabilities.image_input!==false;
const imageRequestLimit=Number.isSafeInteger(config.image_request_limit)&&config.image_request_limit>0?config.image_request_limit:IMAGE_REQUEST_LIMIT;
const outputReserve=config.output_tokens??modelCapabilities.max_output_tokens;
const estimateRequestTokens=(raw,preAnalyzed)=>{
  let analysis=preAnalyzed;
  if(!analysis&&typeof raw==='string'&&(raw.includes('data:image/')||raw.includes('"type":"image"'))){
    try{analysis=analyzeModelPayload(JSON.parse(raw),Buffer.byteLength(raw,'utf8'));}catch{}
  }
  const textRaw=analysis?.strippedJson??raw;
  return estimateTokens({role:'user',content:textRaw,timestamp:Date.now()})+(analysis?.imageCount??0)*IMAGE_TOKEN_ESTIMATE;
};
const modelRequestTooLarge=(raw,reserve=0,preAnalyzed)=>estimateRequestTokens(raw,preAnalyzed)+outputReserve+reserve>modelCapabilities.context_window;
// Mask credentials issued to this runner before its model sees a result or an event reaches disk.
const secrets = new Redactor();
let events = Promise.resolve();
secrets.add(config.run_token);
const clean = value => secrets.clean(value);
const modelFacing = result => Array.isArray(result?.content) ? { ...result, content: result.content.map(item =>
  item?.type === 'text' ? { ...item, text: clean(item.text) } : item) } : result;
const writeEvent=value=>{const line=JSON.stringify(sanitizeImageEvents(clean(value)))+'\n';events=events.then(()=>appendFile(dir+'/events.jsonl',line,{mode:0o600}));return events;};
// Asks the control plane for a read-only GitHub token through the task mailbox, as model requests do.
const exchange=createTokenExchange(dir,{token:config.run_token??null}),grant=createReadGrant(exchange,token=>secrets.add(token));
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
// A service assistant's turn (#1253) does on Pi what the native loop does between model requests: messages that arrive
// while it works join as steering, before the first request (config.steer) and after each tool batch (the turn boundary).
// Streamed text is tapped directly by the control-plane model gateway; this process still reports Pi's own retries.
const serviceTurn=config.service_turn===true&&!config.review_session;
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
const contextOverflow=/context[_ ]length[_ ]exceeded|exceeds the context window|maximum context length|prompt (?:is )?too long|request_too_large|too many tokens|token limit exceeded/i;
let bridge=null;
const readGatewayOverride=()=>{try{return JSON.parse(readFileSync(dir+'/gateway.json','utf8'));}catch{return null;}};
const currentRunToken=()=>{const gw=readGatewayOverride();return (typeof gw?.run_token==='string'&&gw.run_token)||config.run_token||'';};
try{
  const initialGw=readGatewayOverride();
  bridge=await startModelBridge({
    socketPath:initialGw?.model_gateway_socket??config.model_gateway_socket,
    targetUrl:initialGw?.model_gateway_url??config.model_gateway_url,
    resolveTarget:()=>{const gw=readGatewayOverride();return gw?{socketPath:gw.model_gateway_socket,targetUrl:gw.model_gateway_url}:null;},
  });
  const interfaceType=config.model_interface_type||'openai-chat-completions';
  const api=({'openai-chat-completions':'openai-completions','openai-responses':'openai-responses','anthropic-messages':'anthropic-messages'})[interfaceType]||'openai-completions';
  const baseUrl=interfaceType==='anthropic-messages'?bridge.url:bridge.url+'/v1';
  const providerId='department-proxy',subagentProviderId='department-proxy-subagent',modelId=config.model_name||'selected';
  const initialToken=currentRunToken()||'gateway';
  if(initialToken&&initialToken!=='gateway')secrets.add(initialToken);
  const modelDef={id:modelId,name:modelId,contextWindow:modelCapabilities.context_window,maxTokens:modelCapabilities.max_output_tokens,reasoning:modelCapabilities.reasoning,input:modelSupportsImage?['text','image']:['text'],...(api==='openai-completions'?{compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false}}:{})};
  await writeFile(dir+'/models.json',JSON.stringify({providers:{
    [providerId]:{api,baseUrl,apiKey:initialToken,models:[modelDef]},
    [subagentProviderId]:{api,baseUrl,apiKey:initialToken,headers:{'x-bot-subagent':'1'},models:[modelDef]},
  }}),{mode:0o600});
  const runtime=await ModelRuntime.create({authPath:dir+'/auth.json',modelsPath:dir+'/models.json',modelsStorePath:dir+'/catalog.json',allowModelNetwork:false});
  if(typeof runtime?.prepareRequest==='function'){
    const origPrepareRequest=runtime.prepareRequest.bind(runtime);
    runtime.prepareRequest=async(model,options={})=>{
      await events;
      if(model&&(model.provider===providerId||model.provider===subagentProviderId)){
        const token=currentRunToken();
        if(token){secrets.add(token);return origPrepareRequest(model,{...options,apiKey:token});}
      }
      return origPrepareRequest(model,options);
    };
  }
  // Tools for one agent. cfg holds that agent's trusted capabilities; agent names a sub-agent in the task log; guard
  // checks repository results against that agent's own session.
  const makeTools=(cfg,agent,guard)=>cfg.tools.map(tool=>({name:tool.function.name,label:tool.function.name,description:tool.function.description,parameters:tool.function.parameters,
    async execute(id,args,signal){
      const name=tool.function.name,who=agent?{agent}:{};
      // Start metadata deliberately excludes file contents and publication payloads.
      await writeEvent({type:'tool_start',name,call_id:id,...who,...(['read_file','write_file'].includes(name)?{path:args.path}:name==='run_command'?{command:args.command}:{})});
      let result,toolImages=[],submitted=false;
      const denied=controlTools.has(name)&&!agent?null:toolCapabilityError(cfg,name,args);
      if(denied) result={error:denied};
      // The control plane decides the result; only its explicit finish ends this session with the validated submission.
      else if(controlTools.has(name)&&!agent){const reply=await controlTool(name,args,signal);const extracted=Array.isArray(reply.images)?extractToolContentBlocks(reply):extractToolContentBlocks(reply.result);result=extracted.observation;toolImages=extracted.images;if(reply.finish===true){finished=result;submitted=true;}}
      else if(['github_read','github_search','read_job_log','download_artifact','read_task_history','record_progress','search_project_memory','read_project_memory','remember_project_memory'].includes(name)||Object.hasOwn(platformWrites,name)&&!agent){const reply=await repositoryTool(name,args,signal);const extracted=extractToolContentBlocks(reply);result=extracted.observation;toolImages=extracted.images;}
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
        try{const text=note?secrets.text(String(args.content)):args.content;const data=Buffer.from(text);if(!note&&data.length>48000)throw new Error('file_too_large');result=await workspace({type:'workspace_write',workspace_id:cfg.workspace_id,path:args.path,base64:data.toString('base64'),offset:0,final:true,mode:'100644'},signal);}
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
      await writeEvent({type:'tool',name,call_id:id,...who,arguments:args,result,...(toolImages.length?{image_count:toolImages.length}:{})});
      const content=[{type:'text',text:JSON.stringify(result)},...toolImages.map(img=>({type:'image',data:img.data,mimeType:img.mimeType}))];
      return {content,details:{},...(full||submitted||finishTools.has(name)&&!agent&&!controlTools.has(name)?{terminate:true}:{})};
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
  function mapSkillPath(containerPath,skillSet){
    if(!containerPath||typeof containerPath!=='string')return null;
    if(!local)return containerPath;
    const prefix='/opt/bot-skills/';
    if(!containerPath.startsWith(prefix))return containerPath;
    const baseRoot=process.env.BOT_SKILL_STORE_DIR?.trim()||(typeof skillSet?.local_root==='string'&&isAbsolute(skillSet.local_root)?skillSet.local_root:'');
    const scope=typeof skillSet?.scope==='string'?skillSet.scope:'';
    if(!baseRoot||!scope||scope.includes('..')||scope.startsWith('/')||scope.includes('\\'))return null;
    return resolve(baseRoot,scope,containerPath.slice(prefix.length));
  }
  // A Pi session from one configuration: its system prompt and its tools. Pi's own settings apply, compaction and retry
  // included; a session without native access reads no repository settings, as it loads none of its other resources.
  async function createSession(cfg,agent){
    const checkoutTrusted=Boolean(native&&native.trustedCheckout!==false);
    const settingsManager=SettingsManager.create(cwd,nativeDir,{projectTrusted:checkoutTrusted});
    const mountedSkillsDir=native&&cfg.skill_set?.skills_dir?mapSkillPath(cfg.skill_set.skills_dir,cfg.skill_set):null;
    // On untrusted checkouts (external PRs, untrusted branches/commits), never load checkout-owned `.pi/*`, `.agents/skills`, or `AGENTS.md`/`CLAUDE.md`.
    const skillDirs=[...(mountedSkillsDir&&existsSync(mountedSkillsDir)?[mountedSkillsDir]:[]),...(checkoutTrusted&&existsSync(join(cwd,'.pi','skills'))?[join(cwd,'.pi','skills')]:[])];
    const trustedAgentsMd=typeof native?.trustedAgentsMd==='string'&&native.trustedAgentsMd.trim()?native.trustedAgentsMd:null;
    const loader=native?new DefaultResourceLoader({cwd,agentDir:nativeDir,settingsManager,noExtensions:!checkoutTrusted,noPromptTemplates:!checkoutTrusted,noThemes:!checkoutTrusted,noSkills:true,noContextFiles:!checkoutTrusted,additionalSkillPaths:skillDirs,...(checkoutTrusted||!trustedAgentsMd?{}:{agentsFilesOverride:()=>({agentsFiles:[{path:'AGENTS.md',content:trustedAgentsMd}]})}),appendSystemPrompt:[cfg.system]}):{getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>cfg.system,getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{}};
    if(native)await loader.reload();
    const guard={check:async(_id,_name,value)=>value},tools=makeTools(cfg,agent,guard);
    const {manager:sessionManager,mode}=openSession(agent);
    if(!agent){nativeSessionId=sessionManager.getSessionId();recovery=mode;}
    if(native?.commands){
      const helperToken=currentRunToken();
      credentialHelper??=await startCredentialHelperServer({agentDir:dir,runToken:helperToken,addSecret:token=>secrets.add(token)});
      const bin=nativeDir+'/bin';await mkdir(bin,{recursive:true,mode:0o700});
      await writeFile(bin+'/gh',`#!/bin/sh\nexec "${process.execPath}" "${new URL('./gh-wrapper.mjs',import.meta.url).pathname}" "$@"\n`,{mode:0o700});
      const githubHost=typeof config.github_host==='string'&&config.github_host?config.github_host:'github.com';
      const allowHttpGit=Boolean(local&&config.allow_http_git===true);
      const gitCredPath=new URL('./git-credential-bot.mjs',import.meta.url).pathname;
      const bash=createBashTool(cwd,{spawnHook:ctx=>({...ctx,env:buildGitConfigEnv({...ctx.env,HOME:assistant?homeDirectory:nativeDir,PATH:bin+':'+(ctx.env.PATH??''),BOT_WRAPPER_BIN_DIR:bin,BOT_CREDENTIAL_HELPER_URL:credentialHelper.url,BOT_CREDENTIAL_HELPER_SECRET:credentialHelper.secret,BOT_GITHUB_HOST:githubHost,...(currentRunToken()?{BOT_RUN_TOKEN:currentRunToken()}:{}),...(allowHttpGit?{BOT_ALLOW_HTTP_GIT_CREDENTIAL:'true'}:{}),...(local&&process.env.BOT_REAL_GH_BIN?{BOT_REAL_GH_BIN:process.env.BOT_REAL_GH_BIN}:{})},gitCredPath,allowHttpGit)})});
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
    for(let i=0;i<tools.length;i++){const tool=tools[i];tools[i]={...tool,execute:async(...args)=>modelFacing(await tool.execute(...args))};}
    const {session:created}=await createAgentSession({cwd,agentDir:native?nativeDir:dir,modelRuntime:runtime,model:runtime.getModel(agent?subagentProviderId:providerId,modelId),resourceLoader:loader,
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
    const rejectedImages=new Map();
    let lastSentImages=[];
    const prevTransformContext=created.agent.transformContext;
    created.agent.transformContext=async(messages,signal)=>{
      const base=prevTransformContext?await prevTransformContext(messages,signal):messages;
      const budgeted=enforceSessionImageBudget(base,{maxTotalBytes:imageRequestLimit,maxImages:MAX_IMAGES_IN_CONTEXT,rejected:rejectedImages});
      lastSentImages=budgeted.activeImages;
      return budgeted.messages;
    };
    let own=0;
    created.subscribe(event=>{
      if(serviceTurn&&!agent&&event.type==='auto_retry_start'){
        void writeEvent({type:'model_retry',retry:event.attempt,retries:event.maxAttempts,delay_ms:event.delayMs,error:String(event.errorMessage??'').slice(0,300)});
      }
      if(native&&['tool_execution_start','tool_execution_end'].includes(event.type))void writeEvent({type:'tool',phase:event.type==='tool_execution_start'?'started':'completed',name:event.toolName,call_id:event.toolCallId,...(event.args?{arguments:event.args}:{}),...(event.result?{result:event.result}:{}),isError:event.isError,...(Number.isFinite(event.durationMs)?{duration_ms:event.durationMs}:{})});
      // A service turn's conversation shows its progress (#1296): each model step as it starts, and Pi's own compaction.
      if(serviceTurn&&!agent){
        if(event.type==='turn_start')void writeEvent({type:'model_start',step:steps+1});
        if(event.type==='compaction_start')void writeEvent({type:'compaction',phase:'started',reason:event.reason});
        if(event.type==='compaction_end')void writeEvent({type:'compaction',phase:'completed',reason:event.reason,aborted:!!event.aborted,failed:!!event.errorMessage});
      }
      // Pi recovers from a request over the context window itself: it compacts once and retries. The session is over the
      // limit (agent_context_too_large) when the retry still does not fit, or when the compaction's own summary request
      // does not fit either; reopening it would fail the same way. A compaction that failed otherwise (its summary request
      // failed, an extension cancelled it) keeps its own reason and the session. Pi 1.4.0 says which only in its message.
      if(event.type==='compaction_end'&&event.reason==='overflow'&&event.errorMessage&&!event.aborted&&!requestFailure){
        if(!agent&&pendingImageRecovery)return;
        requestFailure=/ recovery failed after /.test(event.errorMessage)||contextOverflow.test(event.errorMessage)?'agent_context_too_large':'agent_compaction_failed';failureDetail=event.errorMessage;
      }
      if(event.type==='message_end'&&event.message.role==='assistant'){
        guard.check.reset();
        const m=event.message;lastModelError=m.stopReason==='error'&&m.errorMessage?String(m.errorMessage):undefined;
        if(m.stopReason==='error'&&lastModelError&&lastSentImages.length>0&&isImageOrPayloadRejection(lastModelError)){
          const reason=lastModelError.slice(0,400);
          for(const key of lastSentImages)rejectedImages.set(key,reason);
          if(!agent)pendingImageRecovery=reason;
          lastSentImages=[];
        }else if(m.stopReason!=='error'){
          if(!agent)pendingImageRecovery=null;
          lastSentImages=[];
        }
        void writeEvent({type:'model',step:agent?++own:++steps,...(agent?{agent}:{}),reasoning:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join(''),content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''),tool_calls:m.content.filter(c=>c.type==='toolCall').map(c=>({id:c.id,name:c.name,arguments:JSON.stringify(c.arguments)}))});
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
  }else if(serviceTurn){
    session.setSteeringMode('all');
    const previousFinish=session.agent.finishTurn;
    session.agent.finishTurn=async(turn,signal)=>{
      // Only between tool batches: a final answer, or a turn its finishing tool ended, takes no further message in.
      if(!finished&&!requestFailure&&turn.toolResults.length){const reply=await boundary('turn');for(const message of reply.messages||[])await session.steer(message);}
      const previous=await previousFinish?.(turn,signal);
      return finished?{action:'end'}:previous;
    };
    // Queued before the prompt, they follow it as their own user messages in the first request.
    for(const message of config.steer||[])await session.steer(message);
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
    let imageRecoveries=0;
    for(let nudge=0;;nudge++){
      try{await session.prompt(input);}catch(error){if((!finished||requestFailure)&&(!pendingImageRecovery||imageRecoveries>=4))throw error;}
      if(requestFailure)throw Object.assign(new Error(requestFailure),failureDetail?{detail:failureDetail}:{});
      if(finished)return finished;
      if(pendingImageRecovery&&imageRecoveries<4){
        const reason=pendingImageRecovery;pendingImageRecovery=null;imageRecoveries++;
        await writeEvent({type:'image_recovery',attempt:imageRecoveries,reason});
        input=`Your previous model request containing inline image(s) was rejected (${clean(reason).slice(0,300)}). The rejected image(s) have been stripped from the conversation context and replaced with recovery notices. Follow the recovery guidance (resize, compress, crop or convert the image on your computer if available, or explain the limitation clearly to the user without claiming to have inspected any omitted image) and continue.`;
        nudge--;
        continue;
      }
      // A controlled session ends only through its control-plane submission; without one the control plane decides.
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
finally{session?.dispose();await bridge?.close();await credentialHelper?.close();}
