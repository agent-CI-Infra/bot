import { cp,mkdir,readFile,writeFile,open,realpath,symlink,unlink,readlink,chmod,rename,rm,stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve,dirname,sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { command,environment,workspaceTag } from './command.mjs';
import {agentOperation} from './agent.mjs';
import { git as storeGit, storeRoot } from './store.mjs';
import { Notes } from './notes.mjs';
import { tasksDirectory, workspaceRoot as projectRoot } from './paths.mjs';

function safe(value){if(typeof value!=='string'||!value||value.length>1024||value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').some(p=>!p||['.','..','.git'].includes(p.toLowerCase())))throw new Error('invalid_path');return value;}
export async function workspace(input,workspaceRoot=tasksDirectory,gitRoot=storeRoot,notesRoot=projectRoot+'/project-notes'){
  if(!/^[a-f0-9]{48}$/.test(input.workspace_id||''))throw new Error('invalid_workspace');
  const root=`${workspaceRoot}/${input.workspace_id}`,repo=root+'/repo';
  const notes=new Notes(notesRoot),linkNotes=async()=>{
    try{await symlink(notesRoot,root+'/notes');}catch(error){if(error.code!=='EEXIST'||await readlink(root+'/notes')!==notesRoot)throw new Error('invalid_notes_link');}
  };
  const path=async(value,create=false)=>{
    const target=resolve(repo,safe(value));
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));if(parent!==repo&&!parent.startsWith(repo+sep))throw new Error('invalid_parent');return target;
  };
  // Task context the control plane writes (the Issue or PR, its comments, the project's skills) sits next to the checkout.
  // The agent reads it as ../context/<path>; it is not part of the repository and never part of a candidate.
  const context=root+'/context',contextPath=async(value,create=false)=>{
    const target=resolve(context,safe(value));
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));if(parent!==context&&!parent.startsWith(context+sep))throw new Error('invalid_parent');return target;
  };
  if(input.type==='workspace_cache'){
    await writeFile(root+'/review-cache.json',JSON.stringify({sha:input.sha,tree_sha:input.tree_sha}),{mode:0o600});return {written:true};
  }
  if(input.type==='workspace_reuse'){
    const cache=await readFile(root+'/review-cache.json','utf8').then(JSON.parse).catch(()=>null);
    if(!cache||cache.sha!==input.sha||!await realpath(repo).then(actual=>actual===repo,()=>false))return {reused:false};
    const dirty=await storeGit(['status','--porcelain'],{cwd:repo}).catch(()=>Buffer.from('missing'));
    const tree=(await storeGit(['rev-parse','HEAD^{tree}'],{cwd:repo}).catch(()=>Buffer.from(''))).toString().trim();
    if(dirty.length||tree!==input.tree_sha)return {reused:false};
    if(await stat(repo+'/.git').then(s=>s.isFile(),()=>false)){
      const head=(await storeGit(['rev-parse','HEAD'],{cwd:repo})).toString().trim();if(head!==input.sha)return {reused:false};
    }
    // Only the checkout is cached. The agent, mailbox and session belong to the new task.
    await rm(root+'/agent',{recursive:true,force:true});return {reused:true,tree_sha:cache.tree_sha};
  }
  const authorFile=root+'/author.json';
  const author=await readFile(authorFile,'utf8').then(JSON.parse).catch(()=>({email:'department-bot@invalid.local'}));
  // Snapshot plumbing has no command timeout or execFile output cap. Large cat-file output goes to disk.
  // The model's shell command timeout is still controlled by command().
  const git=(args,data,output)=>new Promise((res,rej)=>{
    const chunks=[],errors=[],child=spawn('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],
      {cwd:repo,env:{...environment,...workspaceTag(input.workspace_id),GIT_AUTHOR_NAME:'Department Bot',GIT_AUTHOR_EMAIL:author.email,GIT_COMMITTER_NAME:'Department Bot',GIT_COMMITTER_EMAIL:author.email},stdio:['pipe',output?.fd??'pipe','pipe']});
    child.stdout?.on('data',chunk=>chunks.push(chunk));
    let errorBytes=0;child.stderr.on('data',chunk=>{if(errorBytes<8000)errors.push(chunk.subarray(0,8000-errorBytes));errorBytes+=chunk.length;});
    child.on('error',()=>rej(new Error(`git ${args[0]} could not start`)));
    child.on('close',(code,signal)=>code===0?res(Buffer.concat(chunks)):rej(new Error(`git ${args[0]} failed: ${signal||code}; ${Buffer.concat(errors).toString('utf8').trim()}`)));
    child.stdin.on('error',()=>{});child.stdin.end(data);
  });
  // An evaluator gets a distinct checkout of the submitted Git object, never the executor's dirty tree/session.
  if(input.type==='workspace_acceptance'){
    if(!/^[a-f0-9]{48}$/.test(input.source_workspace_id||'')||input.source_workspace_id===input.workspace_id||!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||''))throw new Error('invalid_acceptance_snapshot');
    const source=`${workspaceRoot}/${input.source_workspace_id}/repo`;
    if(await realpath(source)!==source)throw new Error('invalid_acceptance_source');
    await mkdir(root,{recursive:true});await rm(repo,{recursive:true,force:true});
    await storeGit(['clone','--shared','--no-checkout','--',source,repo],{cwd:root});
    await git(['checkout','--detach',input.sha]);
    const tree=(await git(['rev-parse','HEAD^{tree}'])).toString().trim();
    if(tree!==input.tree_sha)throw new Error('acceptance_snapshot_mismatch');
    await linkNotes();
    const originalContext=`${workspaceRoot}/${input.source_workspace_id}/context`;
    if(await stat(originalContext).then(s=>s.isDirectory(),()=>false))await cp(originalContext,context,{recursive:true,dereference:false});
    return {tree_sha:tree,sha:input.sha};
  }
  if(input.type==='workspace_init'){
    await mkdir(repo,{recursive:true});
    await linkNotes();
    if(input.author_email){if(!/^[1-9]\d*\+[a-zA-Z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com$/.test(input.author_email))throw new Error('invalid_author_email');await writeFile(authorFile,JSON.stringify({email:input.author_email}),{mode:0o600});author.email=input.author_email;}
    try{await writeFile(root+'/snapshot.json','{}',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    return {initialized:true};
  }
  // The task's checkout: a worktree of one fixed commit from the computer's git store, with the repository's history.
  if(input.type==='workspace_checkout'){
    if(!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||''))throw new Error('invalid_commit');
    await mkdir(root,{recursive:true});
    await linkNotes();
    if(input.author_email){if(!/^[1-9]\d*\+[a-zA-Z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com$/.test(input.author_email))throw new Error('invalid_author_email');await writeFile(authorFile,JSON.stringify({email:input.author_email}),{mode:0o600});}
    // An existing directory counts only as a worktree of the store at exactly this commit; anything else there, such as an
    // earlier file copy of the same tree (its own repository, without history), is replaced.
    const worktree=await stat(repo+'/.git').then(s=>s.isFile(),()=>false),current=worktree?(await storeGit(['rev-parse','HEAD'],{cwd:repo}).catch(()=>Buffer.from(''))).toString().trim():'';
    if(current!==input.sha){await rm(repo,{recursive:true,force:true});await storeGit(['worktree','prune'],{cwd:gitRoot+'/repo.git'}).catch(()=>{});await storeGit(['worktree','add','--detach','--force',repo,input.sha],{cwd:gitRoot+'/repo.git'});}
    const tree=(await storeGit(['rev-parse','HEAD^{tree}'],{cwd:repo})).toString().trim(),head=(await storeGit(['rev-parse','HEAD'],{cwd:repo})).toString().trim();
    if(tree!==input.tree_sha)throw new Error(`checkout_tree_mismatch: expected ${input.tree_sha}, actual ${tree}`);
    return {tree_sha:tree,local_sha:head};
  }
  const actual=await realpath(repo);if(actual!==repo)throw new Error(`workspace_replaced: expected ${repo}, actual ${actual}`);
  if(input.type==='workspace_context'){
    // The control plane sends context in 45,000-byte chunks, 60,000 base64 characters.
    if(typeof input.base64!=='string'||input.base64.length>61440||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_content');
    const data=Buffer.from(input.base64,'base64'),target=await contextPath(input.path,true);
    const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
    try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(data,0,data.length,input.offset);}finally{await handle.close();}
    return {written:true};
  }
  if(input.type.startsWith('workspace_agent_'))return agentOperation(input,root);
  if(input.type==='workspace_write'){
    if(typeof input.path==='string'&&input.path.startsWith('../notes/')){
      if(input.offset!==0||input.final!==true||input.mode!=='100644'||input.snapshot||typeof input.base64!=='string')throw new Error('invalid_note_write');
      return notes.write(input.path.slice(9),Buffer.from(input.base64,'base64').toString('utf8'));
    }
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
  if(input.type==='workspace_source'){
    const local_sha=(await git(['rev-parse','HEAD'])).toString().trim(),tree_sha=(await git(['rev-parse','HEAD^{tree}'])).toString().trim();
    if(input.tree_sha&&tree_sha!==input.tree_sha)throw new Error('source_snapshot_changed');return {local_sha,tree_sha};
  }
  // Three-way integration in a NEW task workspace. Both synthetic tips share the exact old base
  // tree; this also works for file-copy checkouts without remote commit history. The original
  // candidate workspace is read-only, and Git leaves real unmerged index stages for the writer.
  if(input.type==='workspace_integrate'){
    if(!/^[a-f0-9]{48}$/.test(input.source_workspace_id||'')||input.source_workspace_id===input.workspace_id||
      ![input.sha,input.tree_sha,input.base_tree].every(v=>/^[a-f0-9]{40}$/.test(v||'')))throw new Error('invalid_integration_snapshot');
    const source=`${workspaceRoot}/${input.source_workspace_id}/repo`;
    if(await realpath(source)!==source)throw new Error('invalid_integration_source');
    await git(['fetch','--no-tags','--',source,input.sha]);
    if((await git(['rev-parse',input.sha+'^{tree}'])).toString().trim()!==input.tree_sha)throw new Error('integration_snapshot_mismatch');
    const current=(await git(['rev-parse','HEAD'])).toString().trim(),tree=(await git(['rev-parse','HEAD^{tree}'])).toString().trim();
    const base=(await git(['commit-tree',input.base_tree],Buffer.from('Integration common base\n'))).toString().trim();
    const ours=(await git(['commit-tree',tree,'-p',base,'-p',current],Buffer.from('Integration target\n'))).toString().trim();
    const theirs=(await git(['commit-tree',input.tree_sha,'-p',base,'-p',input.sha],Buffer.from('Integration candidate\n'))).toString().trim();
    await git(['reset','--hard',ours]);
    let merged=true;try{await git(['merge','--no-commit','--no-ff',theirs]);}catch{merged=false;}
    const conflicts=(await git(['diff','--name-only','--diff-filter=U','-z'])).toString().split('\0').filter(Boolean);
    if(!merged&&!conflicts.length)throw new Error('integration_merge_failed');
    await writeFile(root+'/integration.json',JSON.stringify({conflicts,source_sha:input.sha,target_sha:current}),{mode:0o600});
    return {merged,conflicts,source_sha:input.sha,target_sha:current};
  }
  if(input.type==='workspace_integration_check'){
    const saved=await readFile(root+'/integration.json','utf8').then(JSON.parse).catch(()=>({conflicts:[]})),unresolved=[];
    for(const name of saved.conflicts){const bytes=await readFile(await path(name)).catch(()=>null);if(bytes&&/^(?:<<<<<<< |=======\r?$|>>>>>>> )/m.test(bytes.toString('utf8')))unresolved.push(name);}
    return {unresolved};
  }
  if(input.type==='workspace_restore'){
    if(!/^[a-f0-9]{48}$/.test(input.source_workspace_id||'')||!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||''))throw new Error('invalid_recovery_snapshot');
    const source=`${workspaceRoot}/${input.source_workspace_id}/repo`;
    if(await realpath(source)!==source)throw new Error('invalid_recovery_source');
    await git(['fetch','--no-tags','--',source,input.sha]);
    const tree=(await git(['rev-parse',input.sha+'^{tree}'])).toString().trim();
    if(tree!==input.tree_sha)throw new Error('recovery_snapshot_mismatch');
    await git(['read-tree','--reset','-u',input.sha]);return {restored:true,tree_sha:tree};
  }
  if(input.type==='workspace_read'){
    if(input.sha){if(!/^[a-f0-9]{40}$/.test(input.sha))throw new Error('invalid_read_commit');return {content:(await git(['show',input.sha+':'+safe(input.path)])).toString('utf8'),version:input.sha};}
    if(typeof input.path==='string'&&input.path.startsWith('../notes/'))return notes.read(input.path.slice(9));
    const asked=String(input.path||''),target=asked.startsWith('../context/')?await contextPath(asked.slice(11)):await path(asked),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{return {content:await handle.readFile('utf8')};}finally{await handle.close();}
  }
  // Snapshot one regular private-workspace file; later chunks read this immutable blob, never a live mutable path.
  if(input.type==='workspace_export'){
    const target=await path(input.path),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    let data;
    try{
      const info=await handle.stat(),max=30*1024*1024;
      if(!info.isFile())throw new Error('artifact_regular_file_required');
      if(info.size<1||info.size>max)throw new Error('artifact_size_limit');
      const buffer=Buffer.alloc(info.size+1);let size=0;
      while(size<buffer.length){const part=await handle.read(buffer,size,buffer.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}
      if(size!==info.size)throw new Error('artifact_changed');data=buffer.subarray(0,size);
    }finally{await handle.close();}
    const sha=createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),cache=root+'/blob-'+sha;
    try{await writeFile(cache,data,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    return {sha,size:data.length};
  }
  // secret_env comes only from the agent process in this container; the manager forwards no such field.
  if(input.type==='workspace_command')return command(input.command,repo,input.timeout_ms,{outputFile:input.output_file,keepBackground:input.keep_background===true,secretEnv:input.secret_env,workspaceId:input.workspace_id});
  if(input.type==='workspace_finalize'){
    await git(['add','--all']);const tree=(await git(['write-tree'])).toString().trim();
    const raw=(await git(['ls-tree','-r','-l','-z',tree])).toString();const files=[];
    for(const row of raw.split('\0').filter(Boolean)){
      const tab=row.indexOf('\t'),[mode,type,hash,size]=row.slice(0,tab).trim().split(/\s+/),name=safe(row.slice(tab+1));
      // A submodule a checkout keeps in the index stays as the base tree has it; it is not a file of the candidate.
      if(type==='commit'&&mode==='160000')continue;
      if(type!=='blob'||!['100644','100755','120000'].includes(mode))throw new Error(`unsupported_tree_entry: ${name}, type ${type}, mode ${mode}`);
      files.push({path:name,mode,sha:hash,size:Number(size)});
    }
    const local=(await git(['commit-tree',tree,'-p','HEAD'],Buffer.from('Project agent candidate\n'))).toString().trim();
    // SQLite references must remain readable after Git's ordinary garbage collection.
    await git(['update-ref','refs/bot/artifacts/'+local,local]);
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
