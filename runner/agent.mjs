import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {environment,workspaceTag} from './command.mjs';

async function currentRepositoryRequest(dir){
  return readFile(dir+'/repository-request.json','utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
}

// Policy commands run while Pi waits for publication. Reap command leftovers without killing
// that exact agent; an explicit task release still reaps everything.
export async function waitingAgent(root,processes){
  const state=await readFile(root+'/agent/state.json','utf8').then(JSON.parse).catch(()=>null);
  return state?.state==='running'&&processes.some(p=>p.pid===state.pid&&p.cmdline==='node /opt/runner/pi-entry.mjs '+root)?state.pid:null;
}

// The project has no path to the control network. A task-owned mailbox transports model data, never provider keys.
export async function agentOperation(input,root){
  const dir=root+'/agent';await mkdir(dir,{recursive:true,mode:0o700});
  const stat=await readFile('/proc/1/stat','utf8'),boot=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
  if(input.type==='workspace_agent_live'){
    const live=await readFile(dir+'/live.json','utf8').then(JSON.parse).catch(()=>null);if(!live)return {running:false};
    if(!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_offset');
    const bytes=await readFile(dir+'/command.out').catch(()=>Buffer.alloc(0)),start=Math.min(input.offset,bytes.length);let end=Math.min(bytes.length,start+65536);
    if(end<bytes.length)while(end>start&&(bytes[end]&0xc0)===0x80)end--;
    return {...live,running:true,output:bytes.subarray(start,end).toString('utf8'),offset:end,state:'running'};
  }
  if(input.type==='workspace_agent_session'){
    if(!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_session_offset');
    const data=await readFile(dir+'/history.json');
    return {base64:data.subarray(input.offset,input.offset+45000).toString('base64'),size:data.length};
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
  if(input.type==='workspace_agent_config'||input.type==='workspace_agent_history'){
    if(typeof input.base64!=='string'||input.base64.length>48000||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>(input.type==='workspace_agent_history'?32:2)*1024*1024)throw new Error('invalid_agent_config');
    const prefix=input.type==='workspace_agent_history'?'/restore':'/input';
    const path=dir+prefix+'.tmp',file=await open(path,input.offset===0?'w':'r+',0o600);
    try{if((await file.stat()).size!==input.offset)throw new Error('agent_config_offset');const bytes=Buffer.from(input.base64,'base64');await file.write(bytes,0,bytes.length,input.offset);}finally{await file.close();}
    if(input.final)await rename(path,dir+prefix+'.json');return {written:true};
  }
  if(input.type==='workspace_agent_start'){
    const old=await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>null);
    if(old){if(old.state==='running')try{if(old.boot!==boot)throw new Error();process.kill(old.pid,0);}catch{return {error:'agent_interrupted'};}return {started:true};}
    JSON.parse(await readFile(dir+'/input.json','utf8'));
    const out=await open(dir+'/process.log','a',0o600);
    try{const child=spawn('node',['/opt/runner/pi-entry.mjs',root],{cwd:root+'/repo',env:{...environment,...workspaceTag(input.workspace_id)},detached:true,stdio:['ignore',out.fd,out.fd]});
      await writeFile(dir+'/state.json',JSON.stringify({state:'running',pid:child.pid,boot}),{mode:0o600});child.unref();}
    finally{await out.close();}return {started:true};
  }
  if(input.type==='workspace_agent_poll'){
    const state=await readFile(dir+'/state.json','utf8').then(JSON.parse).catch(()=>({state:'missing'}));
    if(['running','review_ready','review_resuming'].includes(state.state)&&state.pid)try{if(state.boot!==undefined&&state.boot!==boot)throw new Error();process.kill(state.pid,0);}catch{state.state='interrupted';}
    const boundary=await readFile(dir+'/boundary.json','utf8').then(JSON.parse).catch(()=>null);
    const request=await readFile(dir+'/request.json','utf8').then(JSON.parse).catch(()=>null);
    const token_request=await readFile(dir+'/token-request.json','utf8').then(JSON.parse).catch(()=>null);
    const pull_request=await readFile(dir+'/pr-request.json','utf8').then(JSON.parse).catch(()=>null);
    const repository_tool=await readFile(dir+'/repository-request.json','utf8').then(JSON.parse).catch(()=>null);
    const lines=(await readFile(dir+'/events.jsonl','utf8').catch(()=>'')).split('\n').filter(Boolean);
    const offset=Number(input.offset)||0,events=lines.slice(offset,offset+20).map(line=>JSON.parse(line));
    return {...state,boundary,request,token_request,pull_request,repository_tool,events,offset:offset+events.length,has_more:offset+events.length<lines.length};
  }
  // The answer to the agent's github_read_token request: a read-only token, or the reason there is none.
  if(input.type==='workspace_agent_token'){
    if(!/^[a-f0-9]{48}$/.test(input.request_id||'')||typeof input.base64!=='string'||input.base64.length>48000)throw new Error('invalid_agent_token');
    const current=JSON.parse(await readFile(dir+'/token-request.json','utf8'));if(current.id!==input.request_id)throw new Error('agent_request_changed');
    const path=dir+'/token-reply-'+input.request_id;
    await writeFile(path+'.tmp',Buffer.from(input.base64,'base64'),{mode:0o600});await rename(path+'.tmp',path+'.json');return {written:true};
  }
  if(input.type==='workspace_agent_progress'){
    if(!/^[a-f0-9]{48}$/.test(input.request_id||'')||!Number.isSafeInteger(input.sequence)||input.sequence<1)throw new Error('invalid_agent_progress');
    const current=JSON.parse(await readFile(dir+'/request.json','utf8'));if(current.id!==input.request_id)throw new Error('agent_request_changed');
    const path=dir+'/progress-'+input.request_id;
    await writeFile(path+'.tmp',JSON.stringify({sequence:input.sequence}),{mode:0o600});await rename(path+'.tmp',path+'.json');return {written:true};
  }
  if(input.type==='workspace_agent_reply'||input.type==='workspace_agent_pull_request'||input.type==='workspace_agent_repository_tool'){
    if(!/^[a-f0-9]{48}$/.test(input.request_id||'')||typeof input.base64!=='string'||input.base64.length>48000||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>2*1024*1024)throw new Error('invalid_agent_reply');
    const pr=input.type==='workspace_agent_pull_request',repository=input.type==='workspace_agent_repository_tool';
    const current=repository?await currentRepositoryRequest(dir):JSON.parse(await readFile(dir+(pr?'/pr-request.json':'/request.json'),'utf8'));if(current?.id!==input.request_id)throw new Error('agent_request_changed');
    const prefix=dir+(pr?'/pr-reply-':repository?'/repository-reply-':'/reply-')+input.request_id;
    const path=prefix+'.tmp';
    try{
      const file=await open(path,input.offset===0?'w':'r+',0o600);
      try{if((await file.stat()).size!==input.offset)throw new Error('agent_reply_offset');await file.write(Buffer.from(input.base64,'base64'),0,Buffer.from(input.base64,'base64').length,input.offset);}finally{await file.close();}
      if(input.final)await rename(path,prefix+'.json');
      if(!repository||(await currentRepositoryRequest(dir))?.id===input.request_id)return {written:true};
    }catch(error){
      // Cancellation can remove a partial reply after validation but before open/rename.
      if(!repository||(await currentRepositoryRequest(dir))?.id===input.request_id)throw error;
    }
    await unlink(path).catch(()=>{});await unlink(prefix+'.json').catch(()=>{});
    throw new Error('agent_request_changed');
  }
  throw new Error('unknown_agent_operation');
}
