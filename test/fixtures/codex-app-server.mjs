// Protocol fixture of `codex app-server` 0.166.0 (stdio JSON-RPC lines without a "jsonrpc" member). It is a contract test
// double for the client, never a substitute for a real Codex run. Scenarios are selected with FIXTURE_* variables.
import {createInterface} from 'node:readline';import {mkdirSync,readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
const env=process.env,home=env.CODEX_HOME,threads=join(home,'threads');mkdirSync(threads,{recursive:true});
const flag=name=>env['FIXTURE_'+name]==='true';
const log=(file,value)=>appendFileSync(join(home,file),JSON.stringify(value)+'\n');
writeFileSync(join(home,'pid'),String(process.pid));
// Output is one ordered byte stream; FRAGMENT writes it in 7-byte pieces, splitting lines and multi-byte characters.
let queue=Promise.resolve();
const write=text=>{queue=queue.then(async()=>{const data=Buffer.from(text);if(!flag('FRAGMENT')){process.stdout.write(data);return;}for(let i=0;i<data.length;i+=7){process.stdout.write(data.subarray(i,i+7));await new Promise(r=>setImmediate(r));}});return queue;};
const send=m=>write(JSON.stringify(m)+'\n');
const notify=(method,params)=>send({method,params,emittedAtMs:Date.now()});
let nextId=1000;const waiting=new Map();
const ask=(method,params)=>new Promise(resolve=>{const id=nextId++;waiting.set(id,resolve);send({id,method,params});});
const load=id=>existsSync(join(threads,id+'.json'))?JSON.parse(readFileSync(join(threads,id+'.json'),'utf8')):null;
const store=t=>writeFileSync(join(threads,t.id+'.json'),JSON.stringify(t));
let thread=null,mcp=null,policy=null;
const rpc=async(method,params)=>{const r=await fetch(mcp,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return (await r.json()).result;};
const tool=async(name,args)=>JSON.parse((await rpc('tools/call',{name,arguments:args})).content[0].text);
// A tool call after the client stopped the run must be refused; the outcome is logged for the test.
const lateTool=()=>setTimeout(()=>tool('finish',{summary:'after stop'}).then(r=>log('late-tools.jsonl',{accepted:true,r}),e=>log('late-tools.jsonl',{accepted:false,error:String(e)})),50);
const threadView=t=>({id:t.id,cwd:t.cwd,model:t.model,modelProvider:t.modelProvider,cliVersion:'0.166.0',ephemeral:false,preview:'',sessionId:t.id,status:{type:'idle'},turns:[],createdAt:1,updatedAt:1,source:'appServer'});
// The applied policy echoes what the client asked for; SANDBOX_IGNORED and FEATURE_IGNORED model a server that did not apply it.
const opened=t=>({thread:threadView(t),model:t.model,modelProvider:t.modelProvider,cwd:t.cwd,approvalPolicy:policy.approvalPolicy,approvalsReviewer:'user',
 sandbox:flag('SANDBOX_IGNORED')?{type:'workspaceWrite',writableRoots:[]}:{type:policy.sandbox==='read-only'?'readOnly':'workspaceWrite'},instructionSources:[]});
const featureNames=['shell_tool','unified_exec','view_image','multi_agent','apps','plugins','goals','sleep_tool','hooks','memories'];
const bind=params=>{policy={approvalPolicy:params.approvalPolicy,sandbox:params.sandbox,features:params.config?.features??{},web_search:params.config?.web_search??null};
 log('thread-params.jsonl',{method:params.threadId?'thread/resume':'thread/start',...policy});mcp=params.config.mcp_servers.bot.url;};
async function startTools(){
 notify('mcpServer/startupStatus/updated',{threadId:thread.id,name:'bot',status:'starting',error:null});
 if(flag('MCP_FAIL')){notify('mcpServer/startupStatus/updated',{threadId:thread.id,name:'bot',status:'failed',error:'connection refused'});return;}
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-mcp-client',version:'0.166.0'}});
 thread.tools=(await rpc('tools/list',{})).tools.map(t=>t.name);
 // EARLY_USAGE: the thread grew by 110 tokens the client never saw; resuming restates that same total while the client is
 // still verifying the session, before it commits the new binding.
 if(flag('EARLY_USAGE')){const t=load(thread.id);if(!t.early){const u=t.usage??{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0};
   t.usage={inputTokens:u.inputTokens+100,cachedInputTokens:u.cachedInputTokens+20,outputTokens:u.outputTokens+10,reasoningOutputTokens:u.reasoningOutputTokens+5,totalTokens:u.totalTokens+110};t.early=true;store(t);thread.usage=t.usage;}
  notify('thread/tokenUsage/updated',{threadId:thread.id,turnId:'earlier-turn',tokenUsage:{total:t.usage,last:t.usage}});}
 notify('mcpServer/startupStatus/updated',{threadId:thread.id,name:'bot',status:'ready',error:null});
}
const turnView=(id,status,error=null)=>({id,items:[],itemsView:'notLoaded',status,error,startedAt:1,completedAt:status==='inProgress'?null:2,durationMs:status==='inProgress'?null:5});
const item=async(phase,turnId,it)=>notify('item/'+phase,{threadId:thread.id,turnId,item:it,...(phase==='started'?{startedAtMs:1}:{completedAtMs:2})});
async function runTurn(turnId,prompt){
 log('prompts.jsonl',{turnId,prompt});
 const t=load(thread.id);t.turns.push({id:turnId,status:'inProgress'});store(t);
 notify('turn/started',{threadId:thread.id,turn:turnView(turnId,'inProgress')});
 if(flag('WAIT')||flag('LATE'))return;
 // A total restated after resume is not new usage; the client must not count it again.
 if(t.usage)notify('thread/tokenUsage/updated',{threadId:thread.id,turnId,tokenUsage:{total:t.usage,last:t.usage}});
 await item('started',turnId,{type:'reasoning',id:'r-'+turnId,summary:[],content:[]});
 await item('completed',turnId,{type:'reasoning',id:'r-'+turnId,summary:['PRIVATE_FIXTURE_REASONING'],content:['PRIVATE_FIXTURE_REASONING']});
 await item('completed',turnId,{type:'agentMessage',id:'m-'+turnId,text:'公开输出 fixture public output '+(env.FIXTURE_TOKEN??''),phase:null});
 // Built-in tools that act without asking: the sandbox let a command run, a patch applied, a sub-agent spawned.
 if(flag('BUILTIN_EXEC')){await item('started',turnId,{type:'commandExecution',id:'c-'+turnId,command:'cat /etc/hostname',cwd:thread.cwd,commandActions:[],status:'inProgress'});
  await item('completed',turnId,{type:'commandExecution',id:'c-'+turnId,command:'cat /etc/hostname',cwd:thread.cwd,commandActions:[],status:'completed',exitCode:0,aggregatedOutput:'HOST_OUTPUT\n'});lateTool();return;}
 if(flag('UNAPPROVED_PATCH')){await item('started',turnId,{type:'fileChange',id:'f-'+turnId,changes:[{path:join(thread.cwd,'x.txt'),kind:{type:'add'},diff:'+x'}],status:'inProgress'});
  await item('completed',turnId,{type:'fileChange',id:'f-'+turnId,changes:[{path:join(thread.cwd,'x.txt'),kind:{type:'add'},diff:'+x'}],status:'completed'});lateTool();return;}
 if(flag('SUBAGENT')){await item('started',turnId,{type:'subAgentActivity',id:'s-'+turnId,agentPath:'/root/child',agentThreadId:randomUUID(),kind:'spawned'});lateTool();return;}
 // An apply_patch attempt under the read-only sandbox waits for an approval the client declines.
 await item('started',turnId,{type:'fileChange',id:'f-'+turnId,changes:[{path:join(thread.cwd,'notes.md'),kind:{type:'add'},diff:'+notes'}],status:'inProgress'});
 if(flag('PERMISSIONS')){
  const base={threadId:thread.id,turnId,startedAtMs:1};
  for(const [method,params] of [['item/commandExecution/requestApproval',{...base,itemId:'c-'+turnId,command:'curl https://example.invalid',reason:'network'}],['item/fileChange/requestApproval',{...base,itemId:'f-'+turnId,reason:'write outside sandbox'}],
   ['item/permissions/requestApproval',{...base,itemId:'p-'+turnId,cwd:thread.cwd,permissions:{network:{enabled:true}}}],['mcpServer/elicitation/request',{threadId:thread.id,turnId,serverName:'bot',mode:'form',message:'Allow read_task_record?',requestedSchema:{type:'object',properties:{}}}],
   ['mcpServer/elicitation/request',{threadId:thread.id,turnId,serverName:'github',mode:'form',message:'Allow create_issue?',requestedSchema:{type:'object',properties:{}}}],
   ['mcpServer/elicitation/request',{threadId:thread.id,turnId,serverName:'bot',mode:'url',elicitationId:'e-'+turnId,message:'Sign in',url:'https://example.invalid/login'}],['item/tool/requestUserInput',{threadId:thread.id,turnId,itemId:'q-'+turnId,isBlocking:true,questions:[]}],
   ['item/tool/call',{threadId:thread.id,turnId,callId:'d-'+turnId,tool:'publish',arguments:{}}],['account/chatgptAuthTokens/refresh',{reason:'unauthorized'}],['attestation/generate',{threadId:thread.id,turnId}],
   ['applyPatchApproval',{conversationId:thread.id,callId:'ap-'+turnId,fileChanges:{},reason:null,grantRoot:null}],['execCommandApproval',{conversationId:thread.id,callId:'ec-'+turnId,command:['ls'],cwd:thread.cwd,reason:null,parsedCmd:[]}],
   ['item/commandExecution/requestApproval',{threadId:'foreign-thread',turnId,itemId:'x',startedAtMs:1}]])log('responses.jsonl',{method,response:await ask(method,params)});
 }
 await item('completed',turnId,{type:'fileChange',id:'f-'+turnId,changes:[{path:join(thread.cwd,'notes.md'),kind:{type:'add'},diff:'+notes'}],status:'declined'});
 if(flag('DISCONNECT')){await queue;process.exit(0);}
 const tools=(await rpc('tools/list',{})).tools.map(t=>t.name);
 if(tools.includes('read_task_record')){await tool('read_task_record',{ref:'task:t'});await item('completed',turnId,{type:'mcpToolCall',id:'mcp-'+turnId,server:'bot',tool:'read_task_record',arguments:{ref:'task:t'},status:'completed',result:{content:[]}});}
 const now=load(thread.id).usage;
 const usage={inputTokens:(now?.inputTokens??0)+100,cachedInputTokens:(now?.cachedInputTokens??0)+20,outputTokens:(now?.outputTokens??0)+10,reasoningOutputTokens:(now?.reasoningOutputTokens??0)+5,totalTokens:(now?.totalTokens??0)+110};
 if(!flag('NO_USAGE')){notify('thread/tokenUsage/updated',{threadId:thread.id,turnId,tokenUsage:{total:usage,last:usage}});const saved=load(thread.id);saved.usage=usage;store(saved);}
 // Duplicate and unknown events must not change the result.
 await item('completed',turnId,{type:'fileChange',id:'f-'+turnId,changes:[],status:'declined'});
 notify('fixture/unknownNotification',{threadId:thread.id});
 send({id:99999,result:{}});
 if(flag('REROUTE')){notify('model/rerouted',{threadId:thread.id,turnId,fromModel:thread.model,toModel:'other-model',reason:'highRiskCyberActivity'});lateTool();return;}
 if(flag('FAIL')){finish(turnId,'failed',{message:'unexpected status 401 Unauthorized',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:401}},additionalDetails:null});return;}
 if(!flag('NO_SUBMIT'))await tool('finish',{summary:'actual fixture result'});
 finish(turnId,'completed');
}
function finish(turnId,status,error=null){const t=load(thread.id);const turn=t.turns.find(x=>x.id===turnId);if(turn)turn.status=status;store(t);notify('turn/completed',{threadId:thread.id,turn:turnView(turnId,status,error)});}
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(m.id!==undefined&&!m.method){waiting.get(m.id)?.(m.error?{error:m.error}:m.result);waiting.delete(m.id);return;}
 const reply=result=>send({id:m.id,result}),error=(code,message)=>send({id:m.id,error:{code,message}});
 log('requests.jsonl',{method:m.method,keys:Object.keys(m.params??{}).sort()});
 if(m.method==='initialize')reply({userAgent:`${m.params.clientInfo.name}/${env.FIXTURE_VERSION??'0.166.0'} (fixture) unknown`,codexHome:env.FIXTURE_HOME??home,platformFamily:'unix',platformOs:'linux'});
 else if(m.method==='initialized'){}
 else if(m.method==='thread/start'){
  bind(m.params);
  thread={id:randomUUID(),cwd:m.params.cwd,model:env.FIXTURE_MODEL??m.params.model??'gpt-fixture',modelProvider:env.FIXTURE_PROVIDER??m.params.modelProvider??'openai',turns:[],usage:null};store(thread);
  reply(opened(thread));notify('thread/started',{thread:threadView(thread)});await startTools();
 }else if(m.method==='thread/resume'){
  // RESUME_ERROR="<code>:<message>" answers resume with that error, whatever the thread state is.
  if(env.FIXTURE_RESUME_ERROR){const [code,...message]=env.FIXTURE_RESUME_ERROR.split(':');error(Number(code),message.join(':'));return;}
  const t=load(m.params.threadId);if(!t){error(-32600,'no rollout found for thread id '+m.params.threadId);return;}
  bind(m.params);thread={...t,model:env.FIXTURE_MODEL??t.model,modelProvider:env.FIXTURE_PROVIDER??t.modelProvider};
  // A turn that was running when the previous server went away is interrupted when the thread is read back.
  for(const turn of t.turns)if(turn.status==='inProgress')turn.status='interrupted';store(t);
  reply(opened(flag('FOREIGN_CWD')?{...thread,cwd:'/elsewhere'}:thread));await startTools();
 }else if(m.method==='thread/turns/list')reply({data:load(m.params.threadId).turns.slice(-1).reverse().map(t=>turnView(t.id,t.status)),nextCursor:null});
 // Feature state computed from the thread's own config, in two pages; FEATURE_IGNORED keeps shell_tool on.
 else if(m.method==='experimentalFeature/list'){
  const all=featureNames.map(name=>({name,stage:'stable',defaultEnabled:true,enabled:name==='shell_tool'&&flag('FEATURE_IGNORED')?true:policy.features[name]!==false}));
  reply(m.params.cursor?{data:all.slice(5),nextCursor:null}:{data:all.slice(0,5),nextCursor:'page-2'});
 }else if(m.method==='mcpServerStatus/list'){const tools=Object.fromEntries((thread.tools??[]).map(name=>[name,{name,inputSchema:{type:'object'}}]));
  reply({data:[{name:'bot',runtimeStatus:'connected',tools,resources:[],resourceTemplates:[],authStatus:'unsupported'},...(flag('EXTRA_SERVER')?[{name:'github',runtimeStatus:'connected',tools:{},resources:[],resourceTemplates:[],authStatus:'unsupported'}]:[])],nextCursor:null});}
 else if(m.method==='turn/start'){
  if(flag('EXIT'))process.exit(7);
  // START_UNANSWERED: the server begins the turn, sends its notifications and a 110-token usage report, but never answers the
  // start and goes away. START_SILENT: the same turn begins without any notification.
  if(flag('START_UNANSWERED')||flag('START_SILENT')){
   const turnId=randomUUID(),t=load(thread.id),previous=t.turns.at(-1)?.id;t.turns.push({id:turnId,status:'inProgress'});log('unanswered.jsonl',{turnId});
   // LATE_PREVIOUS: a late notification of the previous turn arrives while this start is unanswered.
   if(flag('LATE_PREVIOUS')&&previous)notify('item/completed',{threadId:thread.id,turnId:previous,item:{type:'agentMessage',id:'late-'+previous,text:'late',phase:null},completedAtMs:2});
   if(flag('START_UNANSWERED')){const u=t.usage??{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0};
    t.usage={inputTokens:u.inputTokens+100,cachedInputTokens:u.cachedInputTokens+20,outputTokens:u.outputTokens+10,reasoningOutputTokens:u.reasoningOutputTokens+5,totalTokens:u.totalTokens+110};store(t);
    notify('turn/started',{threadId:thread.id,turn:turnView(turnId,'inProgress')});notify('thread/tokenUsage/updated',{threadId:thread.id,turnId,tokenUsage:{total:t.usage,last:t.usage}});}
   else store(t);
   await queue;process.exit(0);
  }
  const turnId=randomUUID();
  // SAME_CHUNK: the answer and a sub-agent item arrive in one chunk, so the item is read before the answer is handled.
  if(flag('SAME_CHUNK')){const t=load(thread.id);t.turns.push({id:turnId,status:'inProgress'});store(t);
   write(JSON.stringify({id:m.id,result:{turn:turnView(turnId,'inProgress')}})+'\n'+JSON.stringify({method:'item/started',params:{threadId:thread.id,turnId,item:{type:'subAgentActivity',id:'s-'+turnId,agentPath:'/root/child',agentThreadId:randomUUID(),kind:'spawned'},startedAtMs:1}})+'\n');lateTool();return;}
  reply({turn:turnView(turnId,'inProgress')});void runTurn(turnId,m.params.input[0].text);
 }else if(m.method==='turn/interrupt'){
  log('interrupts.jsonl',m.params);reply({});
  if(flag('IGNORE_INTERRUPT'))return;
  // A late successful terminal must not turn a cancelled run into a completed one.
  if(flag('LATE')){await tool('finish',{summary:'late result'}).catch(()=>{});finish(m.params.turnId,'completed');return;}
  finish(m.params.turnId,'interrupted');
 }else error(-32601,'method not found');
});
