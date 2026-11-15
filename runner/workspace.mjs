import { cp,mkdir,readFile,writeFile,open,realpath,symlink,unlink,readlink,chmod,rename,rm,stat,lstat,utimes } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve,dirname,sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { command,environment,workspaceTag } from './command.mjs';
import {agentOperation} from './agent.mjs';
import { git as storeGit, storeRoot } from './store.mjs';
import {withWorkspaceLock} from './workspace-lock.mjs';
import {clearStaleGitLocks,lockGraceMs} from './git-locks.mjs';
import { Notes } from './notes.mjs';
import { tasksDirectory, worktreesDirectory, workspaceRoot as projectRoot } from './paths.mjs';

function safe(value){if(typeof value!=='string'||!value||value.length>1024||value.startsWith('/')||value.includes('\\')||value.includes('\0')||value.split('/').some(p=>!p||['.','..','.git'].includes(p.toLowerCase())))throw new Error('invalid_path');return value;}
const id48=/^[a-f0-9]{48}$/,names=buffer=>buffer.toString('utf8').split('\0').filter(Boolean);
// The answer to a call that needs the repository before the task has a worktree. The Pi session asks the control plane to
// bind the task's worktree when it gets it (runner/pi-entry.mjs), so the agent only sees it after choosing none.
export const notSelected='workspace_not_selected: this task has no repository workspace yet';
// What a task's <task>/repo holds: a directory of its own (a file copy, or a worktree workspace_checkout made there), or a
// link to one of the computer's shared worktrees (#769). Returns the real directory; a link anywhere else, or a directory
// replaced by a link, means the workspace was replaced and nothing is done in it.
export async function checkoutDirectory(repo,worktreeRoot=worktreesDirectory){
  // A task gets its worktree when it first needs one (#769): until then there is no repo at all.
  const info=await lstat(repo).catch(error=>{if(error.code==='ENOENT')throw new Error(notSelected);throw error;});
  if(info.isSymbolicLink()){
    const target=await readlink(repo);
    if(!target.startsWith(worktreeRoot+'/')||!id48.test(target.slice(worktreeRoot.length+1))||await realpath(repo)!==target)throw new Error(`workspace_replaced: ${repo} links to ${target}`);
    return target;
  }
  const actual=await realpath(repo);if(actual!==repo)throw new Error(`workspace_replaced: expected ${repo}, actual ${actual}`);
  return repo;
}
// A worktree's tracked changes against HEAD and its untracked files that are not ignored. Ignored files (installed
// dependencies, build output) are no change: they stay with the worktree for the next task.
async function changedFiles(dir){
  const tracked=names(await storeGit(['diff','--name-only','-z','HEAD'],{cwd:dir})),untracked=names(await storeGit(['ls-files','-z','--others','--exclude-standard'],{cwd:dir}));
  return [...new Set([...tracked,...untracked])];
}
// A worktree's state as a handover checks it, or as list_workspaces shows it.
async function worktreeState(dir){
  const head=(await storeGit(['rev-parse','HEAD'],{cwd:dir})).toString().trim(),tree=(await storeGit(['rev-parse','HEAD^{tree}'],{cwd:dir})).toString().trim();
  const changed=await changedFiles(dir);return {head,tree_sha:tree,changed_count:changed.length,changed:changed.slice(0,200)};
}
// Writes the changes of a worktree (tracked, and the untracked files listed) as a patch into a task's context, and returns
// what it saved; null when there is nothing.
async function savePatch(dir,untracked,context,name){
  const run=(args,data)=>storeGit(args,{cwd:dir,...(data?{input:data}:{})});
  // Intent-to-add puts those files into the diff; the checkout that follows resets the index anyway.
  if(untracked.length)await run(['add','--intent-to-add','--pathspec-from-file=-','--pathspec-file-nul'],Buffer.from(untracked.join('\0')+'\0'));
  const changed=names(await run(['diff','--name-only','-z','HEAD']));if(!changed.length)return null;
  await mkdir(context,{recursive:true});await writeFile(context+'/'+name,await run(['diff','--binary','HEAD']),{mode:0o600});
  return {path:'../context/'+name,count:changed.length,files:changed.slice(0,200)};
}
export async function workspace(input,workspaceRoot=tasksDirectory,gitRoot=storeRoot,notesRoot=projectRoot+'/project-notes',worktreeRoot=worktreesDirectory){
  if(!id48.test(input.workspace_id||''))throw new Error('invalid_workspace');
  const root=`${workspaceRoot}/${input.workspace_id}`,repo=root+'/repo';
  const notes=new Notes(notesRoot),linkNotes=async()=>{
    try{await symlink(notesRoot,root+'/notes');}catch(error){if(error.code!=='EEXIST'||await readlink(root+'/notes')!==notesRoot)throw new Error('invalid_notes_link');}
  };
  // The checkout's real directory, read once per call: file tools stay inside it, through the link too.
  let checkout=null;const base=async()=>checkout??=await checkoutDirectory(repo,worktreeRoot);
  const path=async(value,create=false)=>{
    const target=resolve(repo,safe(value)),inside=await base();
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));if(parent!==inside&&!parent.startsWith(inside+sep))throw new Error('invalid_parent');return target;
  };
  // Removes what the task directory has as its checkout: a link goes alone, a directory of its own with its worktree
  // registration in the store.
  const dropCheckout=async()=>{
    const info=await lstat(repo).catch(()=>null);if(!info)return;
    if(info.isSymbolicLink()){await unlink(repo);return;}
    await rm(repo,{recursive:true,force:true});await storeGit(['worktree','prune'],{cwd:gitRoot+'/repo.git'}).catch(()=>{});
  };
  const writeAuthor=async email=>{if(!email)return;if(!/^[1-9]\d*\+[a-zA-Z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com$/.test(email))throw new Error('invalid_author_email');await writeFile(root+'/author.json',JSON.stringify({email}),{mode:0o600});};
  // Task context the control plane writes (the Issue or PR, its comments, the project's skills) sits next to the checkout.
  // The agent reads it as ../context/<path>; it is not part of the repository and never part of a candidate.
  const context=root+'/context',contextPath=async(value,create=false)=>{
    const target=resolve(context,safe(value));
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));if(parent!==context&&!parent.startsWith(context+sep))throw new Error('invalid_parent');return target;
  };
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
  // Before an operation writes the worktree's index or HEAD, the locks a git process that ended abnormally left there are
  // removed and named in the result; while a git process works on the worktree the operation stops as busy, and the
  // control plane retries it (#712).
  const unlock=async()=>{
    const {removed,busy}=await clearStaleGitLocks(await base(),{workspaceId:input.workspace_id});
    if(busy)throw new Error(`git_worktree_busy: ${busy.locks.join(', ')} ${busy.pids.length?'held by running git process '+busy.pids.join(', '):`created less than ${lockGraceMs/1000} seconds ago`}; retry later`);
    return removed.length?{stale_git_locks_removed:removed}:{};
  };
  // An evaluator gets a distinct checkout of the submitted Git object, never the executor's dirty tree/session.
  if(input.type==='workspace_acceptance'){
    if(!id48.test(input.source_workspace_id||'')||input.source_workspace_id===input.workspace_id||!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||''))throw new Error('invalid_acceptance_snapshot');
    const source=`${workspaceRoot}/${input.source_workspace_id}/repo`;
    await checkoutDirectory(source,worktreeRoot).catch(()=>{throw new Error('invalid_acceptance_source');});
    await mkdir(root,{recursive:true});await dropCheckout();
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
    // A file copy is the task's own: a link to a shared worktree an earlier preparation left there goes first.
    if(await lstat(repo).then(info=>info.isSymbolicLink(),()=>false))await unlink(repo);
    await mkdir(repo,{recursive:true});
    await linkNotes();
    if(input.author_email){await writeAuthor(input.author_email);author.email=input.author_email;}
    try{await writeFile(root+'/snapshot.json','{}',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    return {initialized:true};
  }
  // The task's checkout: a worktree of one fixed commit from the computer's git store, with the repository's history.
  if(input.type==='workspace_checkout'){
    if(!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||''))throw new Error('invalid_commit');
    await mkdir(root,{recursive:true});
    await linkNotes();
    await writeAuthor(input.author_email);
    // A link to a shared worktree is not this task's own checkout; it is replaced, the worktree stays.
    if(await lstat(repo).then(info=>info.isSymbolicLink(),()=>false))await unlink(repo);
    // An existing directory counts only as a worktree of the store at exactly this commit; anything else there, such as an
    // earlier file copy of the same tree (its own repository, without history), is replaced.
    const worktree=await stat(repo+'/.git').then(s=>s.isFile(),()=>false),current=worktree?(await storeGit(['rev-parse','HEAD'],{cwd:repo}).catch(()=>Buffer.from(''))).toString().trim():'';
    if(current!==input.sha){await rm(repo,{recursive:true,force:true});await storeGit(['worktree','prune'],{cwd:gitRoot+'/repo.git'}).catch(()=>{});await storeGit(['worktree','add','--detach','--force',repo,input.sha],{cwd:gitRoot+'/repo.git'});}
    const tree=(await storeGit(['rev-parse','HEAD^{tree}'],{cwd:repo})).toString().trim(),head=(await storeGit(['rev-parse','HEAD'],{cwd:repo})).toString().trim();
    if(tree!==input.tree_sha)throw new Error(`checkout_tree_mismatch: expected ${input.tree_sha}, actual ${tree}`);
    return {tree_sha:tree,local_sha:head};
  }
  // The computer's worktrees as list_workspaces shows them (#769): HEAD, its tree and the changed files of each, and when
  // it was last handed over. Nothing is changed.
  if(input.type==='workspace_worktree_inspect'){
    if(!Array.isArray(input.worktree_ids)||input.worktree_ids.length>30||input.worktree_ids.some(id=>!id48.test(id)))throw new Error('invalid_worktree');
    const worktrees=[];
    for(const id of input.worktree_ids){
      const target=`${worktreeRoot}/${id}`,info=await lstat(target).catch(()=>null);
      if(!info?.isDirectory()||!await lstat(target+'/.git').then(s=>s.isFile(),()=>false)){worktrees.push({worktree_id:id,present:false});continue;}
      try{const {changed,...state}=await worktreeState(target);worktrees.push({worktree_id:id,present:true,...state,changed:changed.slice(0,20),used_at:info.mtime.toISOString()});}
      catch(error){worktrees.push({worktree_id:id,present:true,error:String(error.message).slice(0,300)});}
    }
    return {worktrees};
  }
  // A shared worktree for the task (#769): workspace_worktree_create makes /workspace/worktrees/<id> at one commit,
  // workspace_worktree_bind takes an existing one. Either way the worktree is handed over only when its HEAD and HEAD's tree are the ones asked for
  // and it has no changes; ignored files (installed dependencies, build output) are no change and stay. A worktree that
  // fails the check is refused with what it holds instead, and nothing is changed: the control plane picks another.
  // Only an explicit choice (on_changes) takes a worktree that fails it: keep_changes takes one at the commit asked for with
  // its changes; reset first saves its changes as a patch into this task's ../context/, then restores it to the commit asked
  // for, keeping ignored files. The task directory then points at it with <task>/repo.
  // An observer's or evaluator's directory names the task directory it checks (source_workspace_id): it gets a copy of that
  // directory's ../context/, as workspace_acceptance gives one.
  if(input.type==='workspace_worktree_create'||input.type==='workspace_worktree_bind'){
    if(!id48.test(input.worktree_id||'')||!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||'')||input.on_changes!==undefined&&!['reset','keep_changes'].includes(input.on_changes))throw new Error('invalid_worktree');
    const source=input.source_workspace_id===undefined?null:`${workspaceRoot}/${input.source_workspace_id}`;
    if(source&&(!id48.test(input.source_workspace_id)||input.source_workspace_id===input.workspace_id||!await stat(source).then(s=>s.isDirectory(),()=>false)))throw new Error('invalid_source_workspace');
    const target=`${worktreeRoot}/${input.worktree_id}`;
    if(input.type==='workspace_worktree_create'){
      // A new id names no directory; one that is there belongs to another worktree.
      if(await lstat(target).then(()=>true,()=>false))throw new Error('worktree_exists');
      await mkdir(worktreeRoot,{recursive:true});
      await storeGit(['worktree','add','--detach',target,input.sha],{cwd:gitRoot+'/repo.git'});
    }else{
      const info=await lstat(target).catch(()=>null);
      if(!info?.isDirectory()||!await lstat(target+'/.git').then(s=>s.isFile(),()=>false))return {refused:'workspace_missing'};
    }
    let state=await worktreeState(target),saved=null,unlocked={};
    const matches=state.head===input.sha&&state.tree_sha===input.tree_sha;
    if(input.on_changes==='reset'&&(!matches||state.changed_count)){
      const locks=await clearStaleGitLocks(target,{workspaceId:input.workspace_id});
      if(locks.busy)throw new Error(`git_worktree_busy: ${locks.busy.locks.join(', ')}; retry later`);
      if(locks.removed.length)unlocked={stale_git_locks_removed:locks.removed};
      const untracked=names(await storeGit(['ls-files','-z','--others','--exclude-standard'],{cwd:target}));
      saved=await savePatch(target,untracked,context,`saved-changes-${input.worktree_id.slice(0,12)}-${state.head.slice(0,12)}.patch`);
      await storeGit(['checkout','--detach','--force',input.sha],{cwd:target});await storeGit(['clean','-fdq'],{cwd:target});
      state=await worktreeState(target);
      if(state.head!==input.sha||state.tree_sha!==input.tree_sha||state.changed_count)throw new Error(`checkout_tree_mismatch: expected ${input.tree_sha}, actual ${state.tree_sha} with ${state.changed_count} changed files`);
    }
    if(state.head!==input.sha||state.tree_sha!==input.tree_sha)return {refused:'workspace_mismatch',...state};
    if(state.changed_count&&input.on_changes!=='keep_changes')return {refused:'workspace_dirty',...state};
    await mkdir(root,{recursive:true});await linkNotes();await writeAuthor(input.author_email);
    await dropCheckout();await symlink(target,repo);
    if(source&&await stat(source+'/context').then(s=>s.isDirectory(),()=>false))await cp(source+'/context',context,{recursive:true,dereference:false});
    // The handover counts as activity of the worktree: the cleanup leaves a worktree alone that was used since it listed it.
    const now=new Date();await utimes(target,now,now);
    return {worktree_id:input.worktree_id,...state,local_sha:state.head,...(saved?{saved}:{}),...unlocked};
  }
  // The task's worktree moves to another commit in place (#770): a pull request got new commits while its task ran. The
  // directory stays, and so do untracked and ignored files (installed dependencies, build output). What the agent changed
  // in tracked files, and untracked files the new commit would overwrite, is first saved as a patch next to the checkout,
  // so nothing is discarded silently.
  if(input.type==='workspace_advance'){
    if(!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||''))throw new Error('invalid_commit');
    await base();if(!await stat(repo+'/.git').then(s=>s.isFile(),()=>false))throw new Error('workspace_not_worktree');
    const run=(args,data)=>storeGit(args,{cwd:repo,...(data?{input:data}:{})});
    const previous=(await run(['rev-parse','HEAD'])).toString().trim();
    let saved=null,unlocked={};
    if(previous!==input.sha){
      unlocked=await unlock();
      const incoming=new Set(names(await run(['ls-tree','-r','-z','--name-only',input.sha])));
      const overwritten=names(await run(['ls-files','-z','--others','--exclude-standard'])).filter(name=>incoming.has(name));
      saved=await savePatch(repo,overwritten,context,`saved-changes-${previous.slice(0,12)}.patch`);
      await run(['checkout','--detach','--force',input.sha]);
    }
    const tree=(await run(['rev-parse','HEAD^{tree}'])).toString().trim(),head=(await run(['rev-parse','HEAD'])).toString().trim();
    if(head!==input.sha||tree!==input.tree_sha)throw new Error(`checkout_tree_mismatch: expected ${input.tree_sha}, actual ${tree}`);
    return {tree_sha:tree,local_sha:head,previous_sha:previous,saved,...unlocked};
  }
  // The task's context, its agent's session and the project notes are next to the checkout, not in it: they work before the
  // task has a worktree (#769).
  if(input.type==='workspace_context'){
    // The control plane sends context in 45,000-byte chunks, 60,000 base64 characters.
    if(typeof input.base64!=='string'||input.base64.length>61440||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_content');
    const data=Buffer.from(input.base64,'base64'),target=await contextPath(input.path,true);
    const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
    try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(data,0,data.length,input.offset);}finally{await handle.close();}
    return {written:true};
  }
  if(input.type.startsWith('workspace_agent_')||input.type.startsWith('workspace_harness_'))return agentOperation(input,root);
  const aside=typeof input.path==='string'&&!input.sha&&(input.path.startsWith('../notes/')||input.type==='workspace_read'&&input.path.startsWith('../context/'));
  if(aside&&input.type==='workspace_write'){
    if(input.offset!==0||input.final!==true||input.mode!=='100644'||input.snapshot||typeof input.base64!=='string')throw new Error('invalid_note_write');
    return notes.write(input.path.slice(9),Buffer.from(input.base64,'base64').toString('utf8'));
  }
  if(aside&&input.type==='workspace_read'){
    if(input.path.startsWith('../notes/'))return notes.read(input.path.slice(9));
    const handle=await open(await contextPath(input.path.slice(11)),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{return {content:await handle.readFile('utf8')};}finally{await handle.close();}
  }
  await base();
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
    const manifest=JSON.parse(await readFile(root+'/snapshot.json','utf8')),unlocked=await unlock();
    await git(['init','--initial-branch=bot-local']);await git(['config','core.autocrlf','false']);
    for(const [name,entry]of Object.entries(manifest)){
      const target=await path(name),data=entry.mode==='120000'?Buffer.from(await readlink(target)):await readFile(target);
      const blob=(await git(['hash-object','--no-filters','-w','--stdin'],data)).toString().trim();if(blob!==entry.sha)throw new Error(`snapshot_hash_mismatch: ${name}, expected ${entry.sha}, actual ${blob}`);
      await git(['update-index','--add','--cacheinfo',entry.mode,blob,name]);
    }
    const tree=(await git(['write-tree'])).toString().trim();if(tree!==input.tree_sha)throw new Error(`snapshot_tree_mismatch: expected ${input.tree_sha}, actual ${tree}`);
    const commit=(await git(['commit-tree',tree],Buffer.from('Prepare repository snapshot\n'))).toString().trim();await git(['update-ref','refs/heads/bot-local',commit]);
    return {tree_sha:tree,local_sha:commit,...unlocked};
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
    await checkoutDirectory(source,worktreeRoot).catch(()=>{throw new Error('invalid_integration_source');});
    const unlocked=await unlock();
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
    return {merged,conflicts,source_sha:input.sha,target_sha:current,...unlocked};
  }
  if(input.type==='workspace_integration_check'){
    const saved=await readFile(root+'/integration.json','utf8').then(JSON.parse).catch(()=>({conflicts:[]})),unresolved=[];
    for(const name of saved.conflicts){const bytes=await readFile(await path(name)).catch(()=>null);if(bytes&&/^(?:<<<<<<< |=======\r?$|>>>>>>> )/m.test(bytes.toString('utf8')))unresolved.push(name);}
    return {unresolved};
  }
  if(input.type==='workspace_restore'){
    if(!/^[a-f0-9]{48}$/.test(input.source_workspace_id||'')||!/^[a-f0-9]{40}$/.test(input.sha||'')||!/^[a-f0-9]{40}$/.test(input.tree_sha||''))throw new Error('invalid_recovery_snapshot');
    const source=`${workspaceRoot}/${input.source_workspace_id}/repo`;
    await checkoutDirectory(source,worktreeRoot).catch(()=>{throw new Error('invalid_recovery_source');});
    const unlocked=await unlock();
    await git(['fetch','--no-tags','--',source,input.sha]);
    const tree=(await git(['rev-parse',input.sha+'^{tree}'])).toString().trim();
    if(tree!==input.tree_sha)throw new Error('recovery_snapshot_mismatch');
    await git(['read-tree','--reset','-u',input.sha]);return {restored:true,tree_sha:tree,...unlocked};
  }
  if(input.type==='workspace_read'){
    if(input.sha){if(!/^[a-f0-9]{40}$/.test(input.sha))throw new Error('invalid_read_commit');return {content:(await git(['show',input.sha+':'+safe(input.path)])).toString('utf8'),version:input.sha};}
    const target=await path(String(input.path||'')),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
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
  if(input.type==='workspace_command')return command(input.command,repo,input.timeout_ms,{outputFile:input.output_file,keepBackground:input.keep_background===true,secretEnv:input.secret_env,workspaceId:input.workspace_id,backgroundDirectory:root+'/logs'});
  if(input.type==='workspace_finalize')return withWorkspaceLock(root+'/finalize.lock',async()=>{
    const unlocked=await unlock();
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
    return {tree_sha:tree,local_sha:local,files,...unlocked};
  });
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
