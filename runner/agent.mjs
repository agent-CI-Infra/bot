import { constants } from 'node:fs';
import {mkdir,readdir,readFile,writeFile,rename,open,stat,unlink,appendFile,rm} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {environment,workspaceTag} from './command.mjs';
import {local,runnerRoot} from './paths.mjs';
import {volume} from './disk.mjs';
import {acpLeaseFile,acpRunHome,reapAcpDescendants} from './acp-lease.mjs';
import {releaseWorkSwarmPorts} from './workswarm.mjs';
import {requiresAcpRunHome,workswarmProductId} from './acp-products.mjs';

async function currentRequestFile(path){
  return readFile(path,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
}

const MAX_SINGLE_REQUEST_BYTES=2*1024*1024;
const MAX_POLL_REQUEST_BUDGET_BYTES=1536*1024;

async function readRequestDirectory(subdir,options={}){
  const knownIds=options.knownIds instanceof Set?options.knownIds:null;
  const budget=options.budget??null;
  const names=await readdir(subdir).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const candidates=[];
  for(const name of names){
    if(!/^[a-f0-9]{48}\.json$/.test(name))continue;
    const id=name.slice(0,48),path=subdir+'/'+name;
    const info=await stat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(info)candidates.push({mtime:info.mtimeMs,id,path,size:info.size});
  }
  candidates.sort((a,b)=>a.mtime-b.mtime||a.id.localeCompare(b.id));
  const results=[];
  for(const item of candidates){
    if(knownIds?.has(item.id)){
      results.push({id:item.id,stub:true});
      continue;
    }
    if(budget&&item.size>MAX_SINGLE_REQUEST_BYTES){
      results.push({id:item.id,oversized:true,size:item.size});
      continue;
    }
    if(budget&&results.some(r=>!r.stub)&&item.size>budget.remaining){
      budget.deferred=true;
      break;
    }
    const data=await currentRequestFile(item.path);
    if(data&&data.id===item.id){
      if(budget)budget.remaining=Math.max(0,budget.remaining-item.size);
      results.push(data);
    }
  }
  return results;
}

async function readProcStat(pid){
  if(!Number.isInteger(pid)||pid<=1)return null;
  const line=await readFile(`/proc/${pid}/stat`,'utf8').catch(()=>null);
  if(!line)return null;
  const fields=line.slice(line.lastIndexOf(')')+2).split(' ');
  if(!fields[0]||fields[0]==='Z')return null;
  return {state:fields[0],ppid:Number(fields[1]),pgid:Number(fields[2]),started:fields[19]};
}

async function isLiveHarnessProcess(pid,expectedBoot,currentBoot,root){
  if(expectedBoot&&expectedBoot!=='local'&&expectedBoot!==currentBoot)return false;
  const proc=await readProcStat(pid);
  if(!proc)return false;
  const rawCmd=await readFile(`/proc/${pid}/cmdline`,'utf8').catch(()=>'');
  if(!rawCmd)return false;
  const args=rawCmd.split('\0').filter(Boolean);
  return args.includes(runnerRoot+'/harness-entry.mjs')&&args.includes(root);
}

async function isOwnedChildProcess(cliPid,harnessPid,workspaceId){
  const proc=await readProcStat(cliPid);
  if(!proc)return false;
  if(Number.isInteger(harnessPid)&&harnessPid>1&&(proc.ppid===harnessPid||proc.pgid===harnessPid))return true;
  if(workspaceId){
    const rawEnv=await readFile(`/proc/${cliPid}/environ`,'utf8').catch(()=>'');
    if(rawEnv&&rawEnv.split('\0').includes(`BOT_WORKSPACE_ID=${workspaceId}`))return true;
  }
  return false;
}

async function findTaggedGroupMembers(pgid,workspaceId){
  if(!Number.isInteger(pgid)||pgid<=1||!workspaceId)return [];
  const names=await readdir('/proc').catch(()=>[]);
  const pids=[];
  for(const name of names){
    if(!/^\d+$/.test(name))continue;
    const pid=Number(name);
    if(pid<=1||pid===process.pid)continue;
    const proc=await readProcStat(pid);
    if(!proc||proc.pgid!==pgid)continue;
    const rawEnv=await readFile(`/proc/${pid}/environ`,'utf8').catch(()=>'');
    if(rawEnv&&rawEnv.split('\0').includes(`BOT_WORKSPACE_ID=${workspaceId}`))pids.push(pid);
  }
  return pids;
}

async function terminateHarnessState(state,currentBoot,root,workspaceId){
  if(!state||(!state.pid&&!state.cli_pid))return false;
  if(state.boot&&state.boot!=='local'&&state.boot!==currentBoot)return false;
  const harnessAlive=state.pid?await isLiveHarnessProcess(state.pid,state.boot,currentBoot,root):false;
  const cliOwned=state.cli_pid?await isOwnedChildProcess(state.cli_pid,state.pid,workspaceId):false;
  const groupMembers=!harnessAlive&&state.pid?await findTaggedGroupMembers(state.pid,workspaceId):[];
  const acp=state.harness==='acp';
  if(!harnessAlive&&!cliOwned&&!groupMembers.length&&!acp)return false;
  if(cliOwned)try{process.kill(state.cli_pid,'SIGKILL');}catch{}
  if(harnessAlive){
    try{process.kill(-state.pid,'SIGKILL');}catch{try{process.kill(state.pid,'SIGKILL');}catch{}}
  }else{
    for(const pid of groupMembers)try{process.kill(pid,'SIGKILL');}catch{}
  }
  if(acp){
    await reapAcpDescendants(state.instance_id);
    if(state.acp_product_id===workswarmProductId) await releaseWorkSwarmPorts(state.instance_id);
    if(requiresAcpRunHome(state.acp_product_id)&&/^[a-f0-9]{48}$/.test(state.instance_id||'')){
      await rm(acpRunHome(root+'/agent',state.instance_id),{recursive:true,force:true}).catch(()=>{});
    }
  }
  for(const deadline=Date.now()+2000;Date.now()<deadline;){
    const stillHarness=state.pid?await isLiveHarnessProcess(state.pid,state.boot,currentBoot,root):false;
    const stillCli=state.cli_pid?await isOwnedChildProcess(state.cli_pid,state.pid,workspaceId):false;
    const stillGroup=state.pid?await findTaggedGroupMembers(state.pid,workspaceId):[];
    if(!stillHarness&&!stillCli&&!stillGroup.length)break;
    await delay(25);
  }
  return true;
}

// Policy commands run while Pi waits for publication. Reap command leftovers without killing
// that exact agent; an explicit task release still reaps everything.
export async function waitingAgent(root,processes){
  const state=await readFile(root+'/agent/state.json','utf8').then(JSON.parse).catch(()=>null);
  if(state?.state==='running'&&processes.some(p=>p.pid===state.pid&&p.cmdline==='node '+runnerRoot+'/pi-entry.mjs '+root))return state.pid;
  const harness=await readFile(root+'/agent/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
  if(harness?.state==='running'&&processes.some(p=>p.pid===harness.pid&&p.cmdline.includes(runnerRoot+'/harness-entry.mjs '+root))){
    const spared=new Set([harness.pid]);
    for(const p of processes)if(p.pgid===harness.pid)spared.add(p.pid);
    for(let added=true;added;){
      added=false;
      for(const p of processes){
        if(!spared.has(p.pid)&&spared.has(p.ppid)){spared.add(p.pid);added=true;}
      }
    }
    return [...spared];
  }
  return null;
}

// The Pi SDK this runner would start, read from its installed package rather than assumed from the image tag.
async function piRuntime(){
  const manifest=await readFile(runnerRoot+'/node_modules/@earendil-works/pi-coding-agent/package.json','utf8').then(JSON.parse).catch(()=>null);
  return manifest?{agent:'pi',package:manifest.name,version:manifest.version,node:process.version}:{error:'pi_runtime_missing'};
}
// Starts the Pi process on the configuration in input.json; a session that already has a state answers instead.
async function startAgent(dir,root,boot,workspaceId){
  const old=await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>null);
  if(old){if(old.state==='running')try{if(old.boot!==boot)throw new Error();process.kill(old.pid,0);}catch{return {error:'agent_interrupted'};}return {started:true};}
  JSON.parse(await readFile(dir+'/input.json','utf8'));
  const out=await open(dir+'/process.log','a',0o600);
  // A task gets its worktree when it first needs one (#769): until then the session starts in the task directory.
  const cwd=await stat(root+'/repo').then(()=>root+'/repo',()=>root);
  try{const child=spawn('node',[runnerRoot+'/pi-entry.mjs',root],{cwd,env:{...environment,...workspaceTag(workspaceId)},detached:true,stdio:['ignore',out.fd,out.fd]});
    await writeFile(dir+'/state.json',JSON.stringify({state:'running',pid:child.pid,boot}),{mode:0o600});child.unref();}
  finally{await out.close();}return {started:true};
}

// A Pi long poll (#1277) waits at most this long: short enough that the control plane checks the task (a user's stop,
// changed permissions) every few seconds, far below the manager's 90 s exec timeout. It looks every agentPollCheck ms.
// The same 3 s is declared as pollWait in src/agent/pi.ts (what it asks for) and in manager/project-runner-calls.mjs
// (the largest wait_ms it passes on); the tests of both compare theirs with agentPollWaitLimit.
export const agentPollWaitLimit=3000,agentPollCheck=50,agentEventInterval=200;
const knownIds=value=>new Set(Array.isArray(value)?value.filter(id=>typeof id==='string'&&/^[a-f0-9]{48}$/.test(id)):[]);
// Session states the control plane only waits through; any other state (ended, ready for publication, missing) is news.
const activeAgentStates=['running','review_resuming'];
async function agentState(dir,boot){
  const state=await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>({state:'missing'}));
  if(['running','review_ready','review_resuming'].includes(state.state)&&state.pid)try{if(state.boot!==undefined&&state.boot!==boot)throw new Error();process.kill(state.pid,0);}catch{state.state='interrupted';}
  return state;
}
const unseenRequestFile=async(subdir,known)=>(await readdir(subdir).catch(()=>[])).some(name=>/^[a-f0-9]{48}\.json$/.test(name)&&!known.has(name.slice(0,48)));
/**
 * What the session has that the control plane has not seen, judged against what it says it knows (its event offset and
 * the ids it already handles), not against the start of the wait: 'urgent' for a state it must act on, a turn boundary,
 * a new tool or token request, or a page of events beyond this one; 'events' for new events only; null for nothing.
 * The events file is read again only when its size changed.
 */
async function unseenAgentWork(dir,boot,offset,known,watch){
  if(!activeAgentStates.includes((await agentState(dir,boot)).state))return 'urgent';
  const boundary=await readFile(dir+'/boundary.json','utf8').then(JSON.parse).catch(()=>null);
  if(boundary?.id&&!known.boundaries.has(boundary.id))return 'urgent';
  if(await unseenRequestFile(dir+'/tool-requests',known.tools)||await unseenRequestFile(dir+'/token-requests',known.tokens))return 'urgent';
  const size=(await stat(dir+'/events.jsonl').catch(()=>null))?.size??0;
  if(size!==watch.eventsSize){
    watch.eventsSize=size;
    const lines=(await readFile(dir+'/events.jsonl','utf8').catch(()=>'')).split('\n').slice(0,-1).filter(Boolean).length;
    if(lines>offset+20)return 'urgent';
    watch.events=lines>offset;
  }
  return watch.events?'events':null;
}
// One answer of workspace_agent_poll. Tool and token requests the control plane already handles come back as stubs.
async function readAgentPoll(dir,boot,offset,known){
  const state=await agentState(dir,boot);
  // An agent that ended without saving why, while the work volume is full, ran out of space (#671): its last state could
  // not be written either.
  if(state.state==='interrupted'&&!state.error&&volume()?.full)state.error='disk_full';
  const boundary=await readFile(dir+'/boundary.json','utf8').then(JSON.parse).catch(()=>null);
  const token_requests=await readRequestDirectory(dir+'/token-requests',{knownIds:known.tokens});
  const tool_requests=await readRequestDirectory(dir+'/tool-requests',{knownIds:known.tools});
  // An append can still be in progress, especially for large tool arguments. Only consume
  // newline-terminated records so the next poll retries the unfinished tail at the same offset.
  const lines=(await readFile(dir+'/events.jsonl','utf8').catch(()=>'')).split('\n').slice(0,-1).filter(Boolean);
  const events=lines.slice(offset,offset+20).map(line=>JSON.parse(line));
  return {...state,boundary,token_requests,tool_requests,events,offset:offset+events.length,has_more:offset+events.length<lines.length};
}

// The project has no path to the control network. A task-owned mailbox transports model data, never provider keys.
export async function agentOperation(input,root){
  const dir=root+'/agent';
  if(input.type!=='workspace_harness_poll')await mkdir(dir,{recursive:true,mode:0o700});
  const statLine=await readFile('/proc/1/stat','utf8'),boot=statLine.slice(statLine.lastIndexOf(')')+2).split(' ')[19];
  if(input.type==='workspace_agent_result'){
    if(!/^[a-f0-9]{48}$/.test(input.request_id??'')||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_tool_result_range');
    const file=await open(dir+'/results/'+input.request_id+'.utf8',constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const size=(await file.stat()).size,data=Buffer.alloc(Math.max(0,Math.min(65539,size-input.offset)));
      const {bytesRead}=await file.read(data,0,data.length,input.offset);let end=Math.min(65536,bytesRead);
      if(input.offset+end<size)while(end>0&&(data[end]&0xc0)===0x80)end--;
      return {data:data.subarray(0,end).toString('utf8'),offset:input.offset+end,size};
    }finally{await file.close();}
  }
  if(input.type==='workspace_agent_live'){
    const live=await readFile(dir+'/live.json','utf8').then(JSON.parse).catch(()=>null);if(!live)return {running:false};
    if(!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_offset');
    const path=typeof live.output_file==='string'&&new RegExp('^'+dir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/results/[a-f0-9]{48}\\.utf8$').test(live.output_file)?live.output_file:dir+'/command.out';
    const file=await open(path,'r').catch(()=>null);let output='',offset=input.offset;
    if(file)try{
      const size=(await file.stat()).size,bytes=Buffer.alloc(Math.max(0,Math.min(65539,size-input.offset))),{bytesRead}=await file.read(bytes,0,bytes.length,input.offset);
      let end=Math.min(65536,bytesRead);if(input.offset+end<size)while(end>0&&(bytes[end]&0xc0)===0x80)end--;
      output=bytes.subarray(0,end).toString('utf8');offset=input.offset+end;
    }finally{await file.close();}
    const {output_file,...details}=live;return {...details,running:true,output,offset,state:'running'};
  }
  if(input.type==='workspace_agent_continue'){
    await writeFile(dir+'/continue.json','{}',{mode:0o600});return {written:true};
  }
  if(input.type==='workspace_agent_boundary'){
    if(!/^[a-f0-9]{48}$/.test(input.request_id||''))throw new Error('invalid_agent_boundary');
    const current=JSON.parse(await readFile(dir+'/boundary.json','utf8'));if(current.id!==input.request_id)throw new Error('agent_request_changed');
    const bytes=Buffer.from(input.base64||'','base64');
    if(bytes.length>45000||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>32*1024*1024)throw new Error('invalid_boundary_reply');
    const path=dir+'/boundary-reply-'+input.request_id,file=await open(path+'.tmp',input.offset===0?'w':'r+',0o600);
    try{if((await file.stat()).size!==input.offset)throw new Error('boundary_reply_offset');await file.write(bytes,0,bytes.length,input.offset);}finally{await file.close();}
    if(input.final)await rename(path+'.tmp',path+'.json');return {written:true};
  }
  if(input.type==='workspace_agent_config'){
    if(typeof input.base64!=='string'||input.base64.length>48000||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>2*1024*1024)throw new Error('invalid_agent_config');
    // The last piece may also start the session (#1277), saving the runtime query and the start call. A runtime that is
    // not the one the control plane pinned stops it before anything is written, as that query did; the answer always
    // carries the runtime, which tells the control plane this runner started the session itself.
    const launch=input.final===true&&input.start===true;
    const runtime=launch?await piRuntime():null;
    if(launch&&input.runtime_version!==undefined&&runtime.version!==input.runtime_version)return {written:false,started:false,runtime};
    if(input.offset===0){
      const previous=await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>null);
      if(previous?.state==='running'){try{process.kill(previous.pid,0);throw new Error('agent_session_busy');}catch(error){if(error.message==='agent_session_busy')throw error;}}
      // Pi's session files live in its session store; only the completed process's mailbox is reset, with the history
      // files that runners before #1040 left behind.
      for(const name of ['state.json','events.jsonl','boundary.json','continue.json','restore.json','history.json','gateway.tmp'])await unlink(dir+'/'+name).catch(error=>{if(error.code!=='ENOENT')throw error;});
      // So are the requests it left unanswered (a session ended during a tool call or model request, #1253): the next
      // session's control plane would otherwise see them as its own and run them.
      await Promise.all(['tool-requests','tool-replies','token-requests','token-replies'].map(name=>rm(dir+'/'+name,{recursive:true,force:true})));
      for(const name of await readdir(dir).catch(()=>[]))if(/^(?:request\.(?:json|tmp)|(?:boundary-)?reply-[a-f0-9]{48}\.(?:json|tmp))$/.test(name))await unlink(dir+'/'+name).catch(()=>{});
    }
    const path=dir+'/input.tmp',file=await open(path,input.offset===0?'w':'r+',0o600);
    try{if((await file.stat()).size!==input.offset)throw new Error('agent_config_offset');const bytes=Buffer.from(input.base64,'base64');await file.write(bytes,0,bytes.length,input.offset);}finally{await file.close();}
    if(input.final)await rename(path,dir+'/input.json');
    return launch?{written:true,...await startAgent(dir,root,boot,input.workspace_id),runtime}:{written:true};
  }
  if(input.type==='workspace_agent_start')return startAgent(dir,root,boot,input.workspace_id);
  if(input.type==='workspace_agent_poll'){
    const offset=Number(input.offset)||0;
    const known={tools:knownIds(input.known_tool_ids),tokens:knownIds(input.known_token_ids),boundaries:knownIds(input.known_boundary_ids)};
    const waitMs=Number.isSafeInteger(input.wait_ms)&&input.wait_ms>0?Math.min(input.wait_ms,agentPollWaitLimit):0;
    // Without wait_ms (an older control plane, a probe) the poll answers at once, as before.
    if(!waitMs)return readAgentPoll(dir,boot,offset,known);
    // A long poll (#1277) holds until the session has something the control plane has not seen, checking every 50 ms, or
    // until wait_ms runs out. New events alone answer no sooner than 200 ms after the poll began, so streamed text (written
    // every 200 ms) does not cost a call each time. long_poll tells the control plane not to wait before the next poll.
    const began=Date.now(),deadline=began+waitMs,watch={eventsSize:-1,events:false};
    for(;;){
      const seen=await unseenAgentWork(dir,boot,offset,known,watch);
      if(seen==='urgent'||Date.now()>=deadline||seen==='events'&&Date.now()-began>=agentEventInterval)break;
      await delay(Math.max(1,Math.min(agentPollCheck,deadline-Date.now(),seen==='events'?began+agentEventInterval-Date.now():Infinity)));
    }
    return {...await readAgentPoll(dir,boot,offset,known),long_poll:true};
  }
  if(input.type==='workspace_agent_gateway'){
    if(typeof input.base64!=='string'||input.base64.length>8192)throw new Error('invalid_agent_gateway');
    await mkdir(dir,{recursive:true,mode:0o700});
    const bytes=Buffer.from(input.base64,'base64');
    await writeFile(dir+'/gateway.tmp',bytes,{mode:0o600});
    await rename(dir+'/gateway.tmp',dir+'/gateway.json');
    return {written:true};
  }
  // The answer to a github_read_token request in token-requests/<id>.json: a read-only token, or the reason there is none.
  if(input.type==='workspace_agent_token'){
    if(!/^[a-f0-9]{48}$/.test(input.request_id||'')||typeof input.base64!=='string'||input.base64.length>48000)throw new Error('invalid_agent_token');
    const reqPath=dir+'/token-requests/'+input.request_id+'.json';
    const current=await currentRequestFile(reqPath);if(current?.id!==input.request_id)throw new Error('agent_request_changed');
    await mkdir(dir+'/token-replies',{recursive:true,mode:0o700});
    const prefix=dir+'/token-replies/'+input.request_id;
    try{
      await writeFile(prefix+'.tmp',Buffer.from(input.base64,'base64'),{mode:0o600});
      await rename(prefix+'.tmp',prefix+'.json');
      if((await currentRequestFile(reqPath))?.id===input.request_id)return {written:true};
    }catch(error){
      if((await currentRequestFile(reqPath))?.id===input.request_id)throw error;
    }
    await unlink(prefix+'.tmp').catch(()=>{});await unlink(prefix+'.json').catch(()=>{});
    throw new Error('agent_request_changed');
  }
  if(input.type==='workspace_agent_runtime')return piRuntime();
  if(input.type==='workspace_agent_tool'){
    if(!/^[a-f0-9]{48}$/.test(input.request_id||'')||typeof input.base64!=='string'||input.base64.length>48000||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>24*1024*1024)throw new Error('invalid_agent_reply');
    const reqPath=dir+'/tool-requests/'+input.request_id+'.json';
    const current=await currentRequestFile(reqPath);if(current?.id!==input.request_id)throw new Error('agent_request_changed');
    await mkdir(dir+'/tool-replies',{recursive:true,mode:0o700});
    const prefix=dir+'/tool-replies/'+input.request_id,path=prefix+'.tmp',bytes=Buffer.from(input.base64,'base64');
    try{
      const file=await open(path,input.offset===0?'w':'r+',0o600);
      try{if((await file.stat()).size!==input.offset)throw new Error('agent_reply_offset');await file.write(bytes,0,bytes.length,input.offset);}finally{await file.close();}
      if(input.final)await rename(path,prefix+'.json');
      if((await currentRequestFile(reqPath))?.id===input.request_id)return {written:true};
    }catch(error){
      // Cancellation can remove the request or partial reply after validation but before open/rename.
      if((await currentRequestFile(reqPath))?.id===input.request_id)throw error;
    }
    await unlink(path).catch(()=>{});await unlink(prefix+'.json').catch(()=>{});
    throw new Error('agent_request_changed');
  }
  if(input.type==='workspace_harness_config'){
    if(typeof input.base64!=='string'||input.base64.length>48000||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>2*1024*1024)throw new Error('invalid_harness_config');
    const path=dir+'/harness.tmp',file=await open(path,input.offset===0?'w':'r+',0o600);
    try{if((await file.stat()).size!==input.offset)throw new Error('harness_config_offset');const bytes=Buffer.from(input.base64,'base64');await file.write(bytes,0,bytes.length,input.offset);}finally{await file.close();}
    if(input.final){
      const parsed=JSON.parse(await readFile(path,'utf8'));
      const mcpTools=Array.isArray(parsed.mcp_tools)?parsed.mcp_tools:[];
      delete parsed.mcp_tools;
      const oldState=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
      const nextInstanceId=/^[a-f0-9]{48}$/.test(parsed.instance_id||'')?parsed.instance_id:null;
      if(nextInstanceId){
        await writeFile(dir+'/harness-state.json.tmp',JSON.stringify({state:'configuring',instance_id:nextInstanceId,boot}),{mode:0o600});
        await rename(dir+'/harness-state.json.tmp',dir+'/harness-state.json');
      }else{
        await unlink(dir+'/harness-state.json').catch(()=>{});
      }
      if(oldState)await terminateHarnessState(oldState,boot,root,input.workspace_id);
      if(oldState?.harness==='acp'&&/^[a-f0-9]{48}$/.test(oldState.instance_id||''))await unlink(acpLeaseFile(dir,oldState.instance_id)).catch(()=>{});
      await Promise.all([
        unlink(dir+'/harness-stdout.bin').catch(()=>{}),
        unlink(dir+'/harness-stdin.jsonl').catch(()=>{}),
        unlink(dir+'/harness-interrupt.json').catch(()=>{}),
        rm(dir+'/tool-requests',{recursive:true,force:true}),
        rm(dir+'/tool-replies',{recursive:true,force:true}),
        rm(dir+'/model-requests',{recursive:true,force:true}),
        rm(dir+'/model-replies',{recursive:true,force:true}),
        rm(dir+'/token-requests',{recursive:true,force:true}),
        rm(dir+'/token-replies',{recursive:true,force:true}),
      ]);
      await writeFile(dir+'/mcp-tools.json.tmp',JSON.stringify(mcpTools),{mode:0o600});
      await rename(dir+'/mcp-tools.json.tmp',dir+'/mcp-tools.json');
      await writeFile(path,JSON.stringify(parsed),{mode:0o600});
      await rename(path,dir+'/harness.json');
    }
    return {written:true};
  }
  if(input.type==='workspace_harness_start'){
    const cfg=JSON.parse(await readFile(dir+'/harness.json','utf8'));
    const targetInstanceId=/^[a-f0-9]{48}$/.test(input.instance_id||'')?input.instance_id:(/^[a-f0-9]{48}$/.test(cfg.instance_id||'')?cfg.instance_id:null);
    const old=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
    if(old?.pid&&await isLiveHarnessProcess(old.pid,old.boot,boot,root)){
      if(old.state==='running'&&(!targetInstanceId||!old.instance_id||old.instance_id===targetInstanceId)){
        return {started:true,...old};
      }
      await terminateHarnessState(old,boot,root,input.workspace_id);
    }
    await mkdir(root+'/repo',{recursive:true});
    const out=await open(dir+'/harness-process.log','a',0o600);
    let childPid;
    try{
      const extraLocalEnv=local?{
        ...(process.env.BOT_AGENT_TOOLS_DIR?{BOT_AGENT_TOOLS_DIR:process.env.BOT_AGENT_TOOLS_DIR}:{}),
        ...(process.env.BOT_REAL_GH_BIN?{BOT_REAL_GH_BIN:process.env.BOT_REAL_GH_BIN}:{}),
      }:{};
      const child=spawn(process.execPath,[runnerRoot+'/harness-entry.mjs',root],{
        cwd:root+'/repo',
        env:{...environment,...workspaceTag(input.workspace_id),...extraLocalEnv},
        detached:true,
        stdio:['ignore',out.fd,out.fd],
      });
      childPid=child.pid;
      const acp = cfg.harness === 'acp' ? { harness: cfg.harness, acp_product_id: cfg.acp_product?.id } : {};
      await writeFile(dir+'/harness-state.json',JSON.stringify({state:'starting',pid:child.pid,boot,...acp,...(targetInstanceId?{instance_id:targetInstanceId}:{})}),{mode:0o600});
      child.unref();
    }finally{await out.close();}
    for(const end=Date.now()+15000;Date.now()<end;){
      const cur=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
      if(cur&&(!targetInstanceId||!cur.instance_id||cur.instance_id===targetInstanceId)&&cur.state!=='starting'){
        return {started:cur.state==='running',...cur};
      }
      if(!(await isLiveHarnessProcess(childPid,boot,boot,root))){
        const finalState=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
        return {started:false,...(finalState||{state:'failed',error:'harness_exited_during_startup'})};
      }
      await delay(25);
    }
    const last=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>({state:'starting',pid:childPid}));
    return {started:last?.state==='running'||last?.state==='starting',...last};
  }
  if(input.type==='workspace_harness_stdin'){
    const hasBytes=typeof input.base64==='string'&&input.base64.length>0;
    if(input.base64!==undefined&&(typeof input.base64!=='string'||input.base64.length>65536))throw new Error('invalid_harness_stdin');
    const expectedInstanceId=/^[a-f0-9]{48}$/.test(input.instance_id||'')?input.instance_id:null;
    if(expectedInstanceId){
      const state=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
      if(state?.instance_id&&state.instance_id!==expectedInstanceId){
        return {written:false,stale_instance:true};
      }
    }
    let lines='';
    if(hasBytes)lines+=JSON.stringify({chunk_base64:input.base64})+'\n';
    if(input.final===true)lines+=JSON.stringify({close:true})+'\n';
    if(lines)await appendFile(dir+'/harness-stdin.jsonl',lines,{mode:0o600});
    return {written:true};
  }
  if(input.type==='workspace_harness_poll'){
    const offset=Number.isSafeInteger(input.offset)&&input.offset>=0?input.offset:0;
    const waitMs=Number.isSafeInteger(input.wait_ms)&&input.wait_ms>0?Math.min(input.wait_ms,1000):0;
    const expectedInstanceId=/^[a-f0-9]{48}$/.test(input.instance_id||'')?input.instance_id:null;
    const knownToolIds=new Set(Array.isArray(input.known_tool_ids)?input.known_tool_ids.filter(id=>typeof id==='string'&&/^[a-f0-9]{48}$/.test(id)):[]);
    const knownTokenIds=new Set(Array.isArray(input.known_token_ids)?input.known_token_ids.filter(id=>typeof id==='string'&&/^[a-f0-9]{48}$/.test(id)):[]);

    const readOnce=async()=>{
      const state=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>({state:'missing'}));
      if(expectedInstanceId&&state.instance_id&&state.instance_id!==expectedInstanceId){
        return {state:'superseded',instance_id:state.instance_id,expected_instance_id:expectedInstanceId,stdout_base64:'',next_offset:offset,stdout_size:0,has_more:false,token_requests:[],tool_requests:[]};
      }
      if(['starting','running'].includes(state.state)&&state.pid){
        if(!(await isLiveHarnessProcess(state.pid,state.boot,boot,root))){
          const reread=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
          if(reread&&!['starting','running'].includes(reread.state))Object.assign(state,reread);
          else state.state='interrupted';
        }
      }
      if(state.state==='interrupted'&&!state.error&&volume()?.full)state.error='disk_full';
      let stdout_base64='',next_offset=offset,stdout_size=0;
      const stdoutHandle=await open(dir+'/harness-stdout.bin','r').catch(()=>null);
      if(stdoutHandle){
        try{
          stdout_size=(await stdoutHandle.stat()).size;
          const readLen=Math.max(0,Math.min(65536,stdout_size-offset));
          if(readLen>0){
            const buf=Buffer.alloc(readLen);
            const {bytesRead}=await stdoutHandle.read(buf,0,readLen,offset);
            stdout_base64=buf.subarray(0,bytesRead).toString('base64');
            next_offset=offset+bytesRead;
          }
        }finally{await stdoutHandle.close();}
      }
      const budget={remaining:MAX_POLL_REQUEST_BUDGET_BYTES,deferred:false};
      const token_requests=await readRequestDirectory(dir+'/token-requests',{knownIds:knownTokenIds,budget});
      const tool_requests=await readRequestDirectory(dir+'/tool-requests',{knownIds:knownToolIds,budget});
      const has_more=next_offset<stdout_size||budget.deferred;
      return {...state,stdout_base64,next_offset,stdout_size,has_more,token_requests,tool_requests};
    };

    if (expectedInstanceId && input.lease_heartbeat === true) {
      const state = await readFile(dir + '/harness-state.json', 'utf8').then(JSON.parse).catch(() => null);
      if (state?.instance_id === expectedInstanceId && state.harness === 'acp' && state.state === 'running') {
        await writeFile(acpLeaseFile(dir, expectedInstanceId), '', { mode: 0o600 });
      }
    }
    const deadline=Date.now()+waitMs;
    for(;;){
      const snapshot=await readOnce();
      const hasActivity=
        !['starting','running'].includes(snapshot.state)||
        snapshot.next_offset>offset||
        snapshot.has_more||
        snapshot.token_requests.some(r=>!r.stub)||
        snapshot.tool_requests.some(r=>!r.stub);
      if(hasActivity||Date.now()>=deadline)return snapshot;
      await delay(Math.min(25,Math.max(1,deadline-Date.now())));
    }
  }
  if(input.type==='workspace_harness_interrupt'){
    const mode=input.mode==='kill'?'kill':'graceful';
    const grace_ms=Number.isSafeInteger(input.grace_ms)&&input.grace_ms>0?input.grace_ms:undefined;
    const expectedInstanceId=/^[a-f0-9]{48}$/.test(input.instance_id||'')?input.instance_id:null;
    const state=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
    if(expectedInstanceId&&state?.instance_id&&state.instance_id!==expectedInstanceId){
      return {interrupted:false,stale_instance:true,mode};
    }
    await writeFile(dir+'/harness-interrupt.json.tmp',JSON.stringify({mode,...(grace_ms?{grace_ms}:{}),...(expectedInstanceId?{instance_id:expectedInstanceId}:{}),at:Date.now()}),{mode:0o600});
    await rename(dir+'/harness-interrupt.json.tmp',dir+'/harness-interrupt.json');
    if(mode==='kill'&&state){
      await terminateHarnessState(state,boot,root,input.workspace_id);
      const latest=await readFile(dir+'/harness-state.json','utf8').then(JSON.parse).catch(()=>null);
      if((!latest||!state.instance_id||latest.instance_id===state.instance_id) &&
        (state.harness!=='acp'||['starting','running'].includes(latest?.state??state.state))){
        await writeFile(dir+'/harness-state.json.tmp',JSON.stringify({...state,...(latest||{}),state:'interrupted'}),{mode:0o600});
        await rename(dir+'/harness-state.json.tmp',dir+'/harness-state.json');
      }
    }
    return {interrupted:true,mode};
  }
  throw new Error('unknown_agent_operation');
}
