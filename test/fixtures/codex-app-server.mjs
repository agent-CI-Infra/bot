// Protocol fixture of `codex app-server` 0.166.0 (stdio JSON-RPC lines without a "jsonrpc" member). It is a contract test
// double for the client, never a substitute for a real Codex run. Scenarios are selected with FIXTURE_* variables.
import {createInterface} from 'node:readline';import {mkdirSync,readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
const env=process.env,home=env.CODEX_HOME,threads=join(home,'threads');mkdirSync(threads,{recursive:true});
const flag=name=>env['FIXTURE_'+name]==='true';
const log=(file,value)=>appendFileSync(join(home,file),JSON.stringify(value)+'\n');
// Output is one ordered byte stream; FRAGMENT writes it in 7-byte pieces, splitting lines and multi-byte characters.
let queue=Promise.resolve();
const write=text=>{queue=queue.then(async()=>{const data=Buffer.from(text);if(!flag('FRAGMENT')){process.stdout.write(data);return;}for(let i=0;i<data.length;i+=7){process.stdout.write(data.subarray(i,i+7));await new Promise(r=>setImmediate(r));}});return queue;};
const send=m=>write(JSON.stringify(m)+'\n');
const notify=(method,params)=>send({method,params,emittedAtMs:Date.now()});
let nextId=1000;const waiting=new Map();
const ask=(method,params)=>new Promise(resolve=>{const id=nextId++;waiting.set(id,resolve);send({id,method,params});});
const load=id=>existsSync(join(threads,id+'.json'))?JSON.parse(readFileSync(join(threads,id+'.json'),'utf8')):null;
const store=t=>writeFileSync(join(threads,t.id+'.json'),JSON.stringify(t));
let thread=null,mcp=null;
const rpc=async(method,params)=>{const r=await fetch(mcp,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return (await r.json()).result;};
const tool=async(name,args)=>JSON.parse((await rpc('tools/call',{name,arguments:args})).content[0].text);
const threadView=t=>({id:t.id,cwd:t.cwd,model:t.model,modelProvider:t.modelProvider,cliVersion:'0.166.0',ephemeral:false,preview:'',sessionId:t.id,status:{type:'idle'},turns:[],createdAt:1,updatedAt:1,source:'appServer'});
const opened=t=>({thread:threadView(t),model:t.model,modelProvider:t.modelProvider,cwd:t.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'},instructionSources:[]});
async function startTools(){
 notify('mcpServer/startupStatus/updated',{threadId:thread.id,name:'bot',status:'starting',error:null});
 if(flag('MCP_FAIL')){notify('mcpServer/startupStatus/updated',{threadId:thread.id,name:'bot',status:'failed',error:'connection refused'});return;}
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-mcp-client',version:'0.166.0'}});
 thread.tools=(await rpc('tools/list',{})).tools.map(t=>t.name);
 // Usage reported while the client is still verifying the session, before its binding is replaced.
 if(flag('EARLY_USAGE'))notify('thread/tokenUsage/updated',{threadId:thread.id,turnId:'early',tokenUsage:{total:{inputTokens:900,cachedInputTokens:0,outputTokens:90,reasoningOutputTokens:0,totalTokens:990},last:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0}}});
 notify('mcpServer/startupStatus/updated',{threadId:thread.id,name:'bot',status:'ready',error:null});
}
const turnView=(id,status,error=null)=>({id,items:[],itemsView:'notLoaded',status,error,startedAt:1,completedAt:status==='inProgress'?null:2,durationMs:status==='inProgress'?null:5});
const item=async(phase,turnId,it)=>notify('item/'+phase,{threadId:thread.id,turnId,item:it,...(phase==='started'?{startedAtMs:1}:{completedAtMs:2})});
async function runTurn(turnId,prompt){
 log('prompts.jsonl',{turnId,prompt});
 const t=load(thread.id);t.turns.push({id:turnId,status:'inProgress'});store(t);
 notify('turn/started',{threadId:thread.id,turn:turnView(turnId,'inProgress')});
 if(flag('WAIT')||flag('IGNORE_INTERRUPT')||flag('LATE'))return;
 // A total restated after resume is not new usage; the client must not count it again.
 if(t.usage)notify('thread/tokenUsage/updated',{threadId:thread.id,turnId,tokenUsage:{total:t.usage,last:t.usage}});
 await item('started',turnId,{type:'reasoning',id:'r-'+turnId,summary:[],content:[]});
 await item('completed',turnId,{type:'reasoning',id:'r-'+turnId,summary:['PRIVATE_FIXTURE_REASONING'],content:['PRIVATE_FIXTURE_REASONING']});
 await item('completed',turnId,{type:'agentMessage',id:'m-'+turnId,text:'公开输出 fixture public output '+(env.FIXTURE_TOKEN??''),phase:null});
 await item('started',turnId,{type:'commandExecution',id:'c-'+turnId,command:'ls /',cwd:thread.cwd,commandActions:[],status:'inProgress'});
 if(flag('PERMISSIONS')){
  const base={threadId:thread.id,turnId,startedAtMs:1};
  for(const [method,params] of [['item/commandExecution/requestApproval',{...base,itemId:'c-'+turnId,command:'curl https://example.invalid',reason:'network'}],['item/fileChange/requestApproval',{...base,itemId:'f-'+turnId,reason:'write outside sandbox'}],
   ['item/permissions/requestApproval',{...base,itemId:'p-'+turnId,cwd:thread.cwd,permissions:{network:{enabled:true}}}],['mcpServer/elicitation/request',{threadId:thread.id,turnId,serverName:'bot',mode:'form',message:'Allow read_task_record?',requestedSchema:{type:'object',properties:{}}}],
   ['mcpServer/elicitation/request',{threadId:thread.id,turnId,serverName:'github',mode:'form',message:'Allow create_issue?',requestedSchema:{type:'object',properties:{}}}],
   ['mcpServer/elicitation/request',{threadId:thread.id,turnId,serverName:'bot',mode:'url',elicitationId:'e-'+turnId,message:'Sign in',url:'https://example.invalid/login'}],['item/tool/requestUserInput',{threadId:thread.id,turnId,itemId:'q-'+turnId,isBlocking:true,questions:[]}],
   ['item/tool/call',{threadId:thread.id,turnId,callId:'d-'+turnId,tool:'publish',arguments:{}}],['account/chatgptAuthTokens/refresh',{reason:'unauthorized'}],
   ['item/commandExecution/requestApproval',{threadId:'foreign-thread',turnId,itemId:'x',startedAtMs:1}]])log('responses.jsonl',{method,response:await ask(method,params)});
 }
 await item('completed',turnId,{type:'commandExecution',id:'c-'+turnId,command:'ls /',cwd:thread.cwd,commandActions:[],status:'declined',exitCode:null,aggregatedOutput:null});
 if(flag('DISCONNECT')){await queue;process.exit(0);}
 const tools=(await rpc('tools/list',{})).tools.map(t=>t.name);
 if(tools.includes('read_task_record')){await tool('read_task_record',{ref:'task:t'});await item('completed',turnId,{type:'mcpToolCall',id:'mcp-'+turnId,server:'bot',tool:'read_task_record',arguments:{ref:'task:t'},status:'completed',result:{content:[]}});}
 const usage={inputTokens:(t.usage?.inputTokens??0)+100,cachedInputTokens:(t.usage?.cachedInputTokens??0)+20,outputTokens:(t.usage?.outputTokens??0)+10,reasoningOutputTokens:(t.usage?.reasoningOutputTokens??0)+5,totalTokens:(t.usage?.totalTokens??0)+110};
 if(!flag('NO_USAGE')){notify('thread/tokenUsage/updated',{threadId:thread.id,turnId,tokenUsage:{total:usage,last:usage}});const saved=load(thread.id);saved.usage=usage;store(saved);}
 // Duplicate and unknown events must not change the result.
 await item('completed',turnId,{type:'commandExecution',id:'c-'+turnId,command:'ls /',cwd:thread.cwd,commandActions:[],status:'declined'});
 notify('fixture/unknownNotification',{threadId:thread.id});
 send({id:99999,result:{}});
 if(flag('REROUTE'))notify('model/rerouted',{threadId:thread.id,turnId,fromModel:thread.model,toModel:'other-model',reason:'highRiskCyberActivity'});
 if(flag('FAIL')){finish(turnId,'failed',{message:'unexpected status 401 Unauthorized',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:401}},additionalDetails:null});return;}
 if(!flag('NO_SUBMIT')&&!flag('REROUTE'))await tool('finish',{summary:'actual fixture result'});
 if(!flag('REROUTE'))finish(turnId,'completed');
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
  thread={id:randomUUID(),cwd:m.params.cwd,model:env.FIXTURE_MODEL??m.params.model??'gpt-fixture',modelProvider:m.params.modelProvider??'openai',turns:[],usage:null};store(thread);mcp=m.params.config.mcp_servers.bot.url;
  reply(opened(thread));notify('thread/started',{thread:threadView(thread)});await startTools();
 }else if(m.method==='thread/resume'){
  const t=load(m.params.threadId);if(!t){error(-32600,'no rollout found for thread id '+m.params.threadId);return;}
  thread={...t,model:env.FIXTURE_MODEL??t.model};mcp=m.params.config.mcp_servers.bot.url;
  // A turn that was running when the previous server went away is interrupted when the thread is read back.
  for(const turn of t.turns)if(turn.status==='inProgress')turn.status='interrupted';store(t);
  reply(opened(flag('FOREIGN_CWD')?{...thread,cwd:'/elsewhere'}:thread));await startTools();
 }else if(m.method==='thread/turns/list')reply({data:load(m.params.threadId).turns.slice(-1).reverse().map(t=>turnView(t.id,t.status)),nextCursor:null});
 else if(m.method==='mcpServerStatus/list'){const tools=Object.fromEntries((thread.tools??[]).map(name=>[name,{name,inputSchema:{type:'object'}}]));
  reply({data:[{name:'bot',runtimeStatus:'connected',tools,resources:[],resourceTemplates:[],authStatus:'unsupported'},...(flag('EXTRA_SERVER')?[{name:'github',runtimeStatus:'connected',tools:{},resources:[],resourceTemplates:[],authStatus:'unsupported'}]:[])],nextCursor:null});}
 else if(m.method==='turn/start'){
  if(flag('EXIT'))process.exit(7);
  const turnId=randomUUID();reply({turn:turnView(turnId,'inProgress')});void runTurn(turnId,m.params.input[0].text);
 }else if(m.method==='turn/interrupt'){
  log('interrupts.jsonl',m.params);reply({});
  if(flag('IGNORE_INTERRUPT'))return;
  // A late successful terminal must not turn a cancelled run into a completed one.
  if(flag('LATE')){await tool('finish',{summary:'late result'}).catch(()=>{});finish(m.params.turnId,'completed');return;}
  finish(m.params.turnId,'interrupted');
 }else error(-32601,'method not found');
});
