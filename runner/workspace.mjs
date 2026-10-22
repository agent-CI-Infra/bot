import { mkdir,readFile,writeFile,open,realpath,symlink,unlink,readlink,chmod,lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve,dirname,sep } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { command,environment } from './command.mjs';
import {agentOperation} from './agent.mjs';

function safe(value){if(typeof value!=='string'||!value||value.length>1024||value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').some(p=>!p||['.','..','.git'].includes(p.toLowerCase())))throw new Error('invalid_path');return value;}
export async function workspace(input){
  if(!/^[a-f0-9]{48}$/.test(input.workspace_id||''))throw new Error('invalid_workspace');
  const root=`/workspace/tasks/${input.workspace_id}`,repo=root+'/repo';
  const path=async(value,create=false)=>{
    const target=resolve(repo,safe(value));
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));if(parent!==repo&&!parent.startsWith(repo+sep))throw new Error('invalid_parent');return target;
  };
  const git=(args,data)=>new Promise((res,rej)=>{
    const child=execFile('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],
      {cwd:repo,env:{...environment,GIT_AUTHOR_NAME:'Department Bot',GIT_AUTHOR_EMAIL:'bot@users.noreply.github.com',GIT_COMMITTER_NAME:'Department Bot',GIT_COMMITTER_EMAIL:'bot@users.noreply.github.com'},encoding:'buffer',maxBuffer:4*1024*1024,timeout:60000},(e,out)=>e?rej(e):res(out));
    child.stdin.on('error',()=>{});child.stdin.end(data);
  });
  if(input.type==='workspace_init'){
    await mkdir(repo,{recursive:true});
    try{await writeFile(root+'/snapshot.json','{}',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    return {initialized:true};
  }
  const actual=await realpath(repo);if(actual!==repo)throw new Error('workspace_replaced');
  if(input.type.startsWith('workspace_agent_'))return agentOperation(input,root);
  if(input.type==='workspace_write'){
    if(typeof input.base64!=='string'||input.base64.length>56000||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>1024*1024)throw new Error('invalid_content');
    const data=Buffer.from(input.base64,'base64'),target=await path(input.path,true);
    const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
    try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(data,0,data.length,input.offset);await handle.sync();}finally{await handle.close();}
    if(input.final){
      if(!['100644','100755','120000'].includes(input.mode))throw new Error('invalid_mode');
      const bytes=await readFile(target);if(bytes.length>1024*1024)throw new Error('file_too_large');
      const hash=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if(input.snapshot&&hash!==input.sha)throw new Error('snapshot_hash_mismatch');
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
      const blob=(await git(['hash-object','--no-filters','-w','--stdin'],data)).toString().trim();if(blob!==entry.sha)throw new Error('snapshot_hash_mismatch');
      await git(['update-index','--add','--cacheinfo',entry.mode,blob,name]);
    }
    const tree=(await git(['write-tree'])).toString().trim();if(tree!==input.tree_sha)throw new Error('snapshot_tree_mismatch');
    const commit=(await git(['commit-tree',tree],Buffer.from('Prepare repository snapshot\n'))).toString().trim();await git(['update-ref','refs/heads/bot-local',commit]);
    return {tree_sha:tree,local_sha:commit};
  }
  if(input.type==='workspace_read'){
    const target=await path(input.path),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{if((await handle.stat()).size>1024*1024)throw new Error('file_too_large');return {content:await handle.readFile('utf8')};}finally{await handle.close();}
  }
  if(input.type==='workspace_command')return command(input.command,repo,input.timeout_ms,{outputFile:input.output_file,keepBackground:input.keep_background===true});
  if(input.type==='workspace_finalize'){
    await git(['add','--all']);const tree=(await git(['write-tree'])).toString().trim();
    const raw=(await git(['ls-tree','-r','-z',tree])).toString();const files=[];
    for(const row of raw.split('\0').filter(Boolean)){
      const tab=row.indexOf('\t'),[mode,type,hash]=row.slice(0,tab).split(' '),name=safe(row.slice(tab+1));
      if(type!=='blob'||!['100644','100755','120000'].includes(mode))throw new Error('unsupported_tree_entry');
      const size=Number((await git(['cat-file','-s',hash])).toString());if(size>1024*1024)throw new Error('file_too_large');files.push({path:name,mode,sha:hash,size});
    }
    if(files.length>2000)throw new Error('too_many_files');
    const local=(await git(['commit-tree',tree,'-p','HEAD'],Buffer.from('Project agent candidate\n'))).toString().trim();
    return {tree_sha:tree,local_sha:local,files};
  }
  if(input.type==='workspace_blob'){
    if(!/^[a-f0-9]{40}$/.test(input.sha||'')||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_blob');
    const data=await git(['cat-file','blob',input.sha]);if(data.length>1024*1024)throw new Error('file_too_large');return {base64:data.subarray(input.offset,input.offset+30000).toString('base64'),size:data.length};
  }
  throw new Error('unsupported_workspace_operation');
}
