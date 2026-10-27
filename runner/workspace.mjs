import { mkdir,readFile,writeFile,open,realpath,symlink,unlink,readlink,chmod,rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve,dirname,sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { command,environment,workspaceTag } from './command.mjs';
import {agentOperation} from './agent.mjs';

function safe(value){if(typeof value!=='string'||!value||value.length>1024||value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').some(p=>!p||['.','..','.git'].includes(p.toLowerCase())))throw new Error('invalid_path');return value;}
export async function workspace(input,workspaceRoot='/workspace/tasks'){
  if(!/^[a-f0-9]{48}$/.test(input.workspace_id||''))throw new Error('invalid_workspace');
  const root=`${workspaceRoot}/${input.workspace_id}`,repo=root+'/repo';
  const path=async(value,create=false)=>{
    const target=resolve(repo,safe(value));
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));if(parent!==repo&&!parent.startsWith(repo+sep))throw new Error('invalid_parent');return target;
  };
  const authorFile=root+'/author.json';
  const author=await readFile(authorFile,'utf8').then(JSON.parse).catch(()=>({email:'department-bot@invalid.local'}));
  // Snapshot plumbing has no command timeout or execFile output cap. Large cat-file output goes to disk.
  // The model's shell command timeout is still controlled by command().
  const git=(args,data,output)=>new Promise((res,rej)=>{
    const chunks=[],child=spawn('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],
      {cwd:repo,env:{...environment,...workspaceTag(input.workspace_id),GIT_AUTHOR_NAME:'Department Bot',GIT_AUTHOR_EMAIL:author.email,GIT_COMMITTER_NAME:'Department Bot',GIT_COMMITTER_EMAIL:author.email},stdio:['pipe',output?.fd??'pipe','ignore']});
    child.stdout?.on('data',chunk=>chunks.push(chunk));
    child.on('error',()=>rej(new Error(`git ${args[0]} could not start`)));
    child.on('close',(code,signal)=>code===0?res(Buffer.concat(chunks)):rej(new Error(`git ${args[0]} failed: ${signal||code}`)));
    child.stdin.on('error',()=>{});child.stdin.end(data);
  });
  if(input.type==='workspace_init'){
    await mkdir(repo,{recursive:true});
    if(input.author_email){if(!/^[1-9]\d*\+[a-zA-Z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com$/.test(input.author_email))throw new Error('invalid_author_email');await writeFile(authorFile,JSON.stringify({email:input.author_email}),{mode:0o600});author.email=input.author_email;}
    try{await writeFile(root+'/snapshot.json','{}',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    return {initialized:true};
  }
  const actual=await realpath(repo);if(actual!==repo)throw new Error(`workspace_replaced: expected ${repo}, actual ${actual}`);
  if(input.type.startsWith('workspace_agent_'))return agentOperation(input,root);
  if(input.type==='workspace_write'){
    if(typeof input.base64!=='string'||input.base64.length>56000||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_content');
    const data=Buffer.from(input.base64,'base64'),target=await path(input.path,true);
    const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
    try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(data,0,data.length,input.offset);await handle.sync();}finally{await handle.close();}
    if(input.final){
      if(!['100644','100755','120000'].includes(input.mode))throw new Error('invalid_mode');
      const bytes=await readFile(target);
      const hash=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if(input.snapshot&&hash!==input.sha)throw new Error(`snapshot_hash_mismatch: ${input.path}, expected ${input.sha}, actual ${hash}`);
      if(input.mode==='120000'){await unlink(target);await symlink(bytes.toString('utf8'),target);}else if(input.snapshot)await chmod(target,input.mode==='100755'?0o755:0o644);
      if(input.snapshot){const manifest=JSON.parse(await readFile(root+'/snapshot.json','utf8'));manifest[input.path]={mode:input.mode,sha:hash};await writeFile(root+'/snapshot.json',JSON.stringify(manifest));}
    }
    return {written:true};
  }
  if(input.type==='workspace_snapshot'){
    const manifest=JSON.parse(await readFile(root+'/snapshot.json','utf8'));
    await git(['init','--initial-branch=bot-local']);await git(['config','core.autocrlf','false']);
    for(const [name,entry]of Object.entries(manifest)){
      const target=await path(name),data=entry.mode==='120000'?Buffer.from(await readlink(target)):await readFile(target);
      const blob=(await git(['hash-object','--no-filters','-w','--stdin'],data)).toString().trim();if(blob!==entry.sha)throw new Error(`snapshot_hash_mismatch: ${name}, expected ${entry.sha}, actual ${blob}`);
      await git(['update-index','--add','--cacheinfo',entry.mode,blob,name]);
    }
    const tree=(await git(['write-tree'])).toString().trim();if(tree!==input.tree_sha)throw new Error(`snapshot_tree_mismatch: expected ${input.tree_sha}, actual ${tree}`);
    const commit=(await git(['commit-tree',tree],Buffer.from('Prepare repository snapshot\n'))).toString().trim();await git(['update-ref','refs/heads/bot-local',commit]);
    return {tree_sha:tree,local_sha:commit};
  }
  if(input.type==='workspace_read'){
    const target=await path(input.path),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{return {content:await handle.readFile('utf8')};}finally{await handle.close();}
  }
  // secret_env comes only from the agent process in this container; the manager forwards no such field.
  if(input.type==='workspace_command')return command(input.command,repo,input.timeout_ms,{outputFile:input.output_file,keepBackground:input.keep_background===true,secretEnv:input.secret_env,workspaceId:input.workspace_id});
  if(input.type==='workspace_finalize'){
    await git(['add','--all']);const tree=(await git(['write-tree'])).toString().trim();
    const raw=(await git(['ls-tree','-r','-l','-z',tree])).toString();const files=[];
    for(const row of raw.split('\0').filter(Boolean)){
      const tab=row.indexOf('\t'),[mode,type,hash,size]=row.slice(0,tab).trim().split(/\s+/),name=safe(row.slice(tab+1));
      if(type!=='blob'||!['100644','100755','120000'].includes(mode))throw new Error(`unsupported_tree_entry: ${name}, type ${type}, mode ${mode}`);
      files.push({path:name,mode,sha:hash,size:Number(size)});
    }
    const local=(await git(['commit-tree',tree,'-p','HEAD'],Buffer.from('Project agent candidate\n'))).toString().trim();
    return {tree_sha:tree,local_sha:local,files};
  }
  if(input.type==='workspace_blob'){
    if(!/^[a-f0-9]{40}$/.test(input.sha||'')||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_blob');
    const cache=root+'/blob-'+input.sha;
    let handle;
    try{handle=await open(cache,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){
      if(error.code!=='ENOENT')throw error;
      const temp=cache+'.tmp',out=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
      try{await git(['cat-file','blob',input.sha],undefined,out);}finally{await out.close();}
      await rename(temp,cache);handle=await open(cache,constants.O_RDONLY|constants.O_NOFOLLOW);
    }
    try{
      const size=(await handle.stat()).size,data=Buffer.alloc(Math.max(0,Math.min(30000,size-input.offset)));
      const {bytesRead}=await handle.read(data,0,data.length,input.offset);
      return {base64:data.subarray(0,bytesRead).toString('base64'),size};
    }finally{await handle.close();}
  }
  throw new Error('unsupported_workspace_operation');
}
