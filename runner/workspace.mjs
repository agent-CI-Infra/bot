import { cp,mkdir,readFile,writeFile,open,realpath,symlink,unlink,readlink,chmod,rename,rm,stat,lstat,utimes } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve,dirname,sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { command,environment,operationTag,workspaceTag } from './command.mjs';
import { outputLimit } from './command-output.mjs';
import {agentOperation} from './agent.mjs';
import { git as storeGit, storeRoot } from './store.mjs';
import {withWorkspaceLock} from './workspace-lock.mjs';
import {clearStaleGitLocks,lockGraceMs} from './git-locks.mjs';
import { Notes } from './notes.mjs';
import { tasksDirectory, worktreesDirectory, workspaceRoot as projectRoot } from './paths.mjs';
import { ArtifactArchiveError, extractArtifactZip, MAX_ARTIFACT_COMPRESSED_BYTES } from './artifact-zip.mjs';

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
function previewBytes(headBuf, tailBuf, totalBytes, sourcePath) {
  const head = new StringDecoder('utf8').write(headBuf);
  let start = 0; while (start < 3 && (tailBuf[start] & 0xc0) === 0x80) start++;
  const tail = tailBuf.subarray(start).toString('utf8');
  const omitted = Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
  return head + `\n[… ${omitted} bytes omitted from inline preview; inspect slices of ${sourcePath} directly (e.g., head/tail/sed) …]\n` + tail;
}
async function readBoundedFile(handle, displayPath, { maxBytes, skipBinary } = {}) {
  const size = (await handle.stat()).size;
  if (Number.isSafeInteger(maxBytes) && maxBytes > 0 && size > maxBytes) return { skipped: true, reason: 'file_too_large', size };
  if (skipBinary && size > 0) {
    const probe = Buffer.alloc(Math.min(8192, size));
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (probe.subarray(0, bytesRead).includes(0)) return { skipped: true, reason: 'binary_file', size };
  }
  if (size > outputLimit) {
    const slice = 64 * 1024;
    const headBuf = Buffer.alloc(slice), tailBuf = Buffer.alloc(slice);
    const { bytesRead: headRead } = await handle.read(headBuf, 0, slice, 0);
    const { bytesRead: tailRead } = await handle.read(tailBuf, 0, slice, Math.max(0, size - slice));
    return { content: previewBytes(headBuf.subarray(0, headRead), tailBuf.subarray(0, tailRead), size, displayPath), truncated: true, size, path: displayPath };
  }
  const buf = Buffer.alloc(size);
  let pos = 0;
  while (pos < size) {
    const { bytesRead } = await handle.read(buf, pos, size - pos, pos);
    if (!bytesRead) break;
    pos += bytesRead;
  }
  return { content: buf.subarray(0, pos).toString('utf8') };
}
// A worktree's tracked changes against HEAD and its untracked files that are not ignored. Ignored files (installed
// dependencies, build output) are no change: they stay with the worktree for the next task.
async function changedFiles(dir){
  const tracked=names(await storeGit(['diff','--name-only','-z','HEAD'],{cwd:dir})),untracked=names(await storeGit(['ls-files','-z','--others','--exclude-standard'],{cwd:dir}));
  return [...new Set([...tracked,...untracked])];
}
// Ensures the local repository/worktree config has user.name and user.email set so native `git commit`, `git merge`,
// and `git rebase` work under GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1 across all harnesses.
// Shared worktrees share `/workspace/git/repo.git/config`, so retry briefly on transient config.lock contention.
async function ensureGitAuthor(dir, email) {
  const desiredName = 'Department Bot';
  const desiredEmail = (typeof email === 'string' && email.trim()) ? email.trim() : 'department-bot@invalid.local';
  const currentName = await storeGit(['config', '--get', 'user.name'], { cwd: dir }).then(b => b.toString().trim(), () => '');
  const currentEmail = await storeGit(['config', '--get', 'user.email'], { cwd: dir }).then(b => b.toString().trim(), () => '');
  const setConfig = async (key, value) => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await storeGit(['config', key, value], { cwd: dir });
        return;
      } catch (error) {
        const msg = String(error?.message || '');
        if (attempt < 6 && /could not lock config file|File exists|Unable to create .*config\.lock/i.test(msg)) {
          await new Promise(resolve => setTimeout(resolve, attempt * 50));
          continue;
        }
        throw error;
      }
    }
  };
  if (!currentName) await setConfig('user.name', desiredName);
  if (!currentEmail || (desiredEmail !== 'department-bot@invalid.local' && currentEmail === 'department-bot@invalid.local')) {
    await setConfig('user.email', desiredEmail);
  }
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
  // The checkout's real directory, read once per call: repo-relative file tools stay inside it, through the link too.
  let checkout=null;const base=async()=>checkout??=await checkoutDirectory(repo,worktreeRoot);
  const path=async(value,create=false)=>{
    const target=resolve(repo,safe(value)),inside=await base();
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));if(parent!==inside&&!parent.startsWith(inside+sep))throw new Error('invalid_parent');return target;
  };
  const outsideRepo=value=>typeof value==='string'&&(value.startsWith('/')||value.startsWith('../')||value.includes('/../'));
  const exportFile=async(target,media=false)=>{
    const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let data;
    try{
      const info=await handle.stat(),max=30*1024*1024;
      if(!info.isFile())throw new Error('artifact_regular_file_required');
      // Check the opened file before reading. A task can rename or swap a parent directory after path validation.
      if(media&&(info.nlink!==1||await readlink(`/proc/self/fd/${handle.fd}`)!==target))throw new Error('invalid_media_path');
      if(info.size<1||info.size>max)throw new Error('artifact_size_limit');
      const buffer=Buffer.alloc(info.size+1);let size=0;
      while(size<buffer.length){const part=await handle.read(buffer,size,buffer.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}
      if(size!==info.size)throw new Error('artifact_changed');data=buffer.subarray(0,size);
    }finally{await handle.close();}
    await mkdir(root,{recursive:true});
    const sha=createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),cache=root+'/blob-'+sha;
    try{await writeFile(cache,data,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    return {sha,size:data.length};
  };
  if(input.type==='workspace_export'&&input.mode==='pull_request_media'){
    const name=safe(input.path);
    const target=resolve(await base(),name);
    if(await realpath(dirname(target))!==dirname(target))throw new Error('invalid_media_path');
    return exportFile(target,true);
  }
  const computerPath=async(value,create=false)=>{
    if(typeof value!=='string'||!value||value.length>2048||value.includes('\\')||value.includes('\0')||value.split('/').some(p=>p.toLowerCase()==='.git'||p==='.runner-journal'))throw new Error('invalid_path');
    const volumeRoot=resolve(workspaceRoot).endsWith(sep+'tasks')?dirname(resolve(workspaceRoot)):resolve(workspaceRoot);
    const rawRoots=[volumeRoot,resolve(notesRoot),resolve(worktreeRoot),resolve(environment.TMPDIR||'/tmp')];
    const allowed=[...new Set([...rawRoots,...await Promise.all(rawRoots.map(r=>realpath(r).catch(()=>r)))])];
    const stores=[...new Set([resolve(gitRoot),await realpath(gitRoot).catch(()=>resolve(gitRoot))])];
    const target=value.startsWith('/')?resolve(value):resolve(repo,value);
    if(!allowed.some(r=>target.startsWith(r+sep))||stores.some(g=>target===g||target.startsWith(g+sep)))throw new Error('invalid_path');
    if(create)await mkdir(dirname(target),{recursive:true});
    const parent=await realpath(dirname(target));
    if(!allowed.some(r=>parent===r||parent.startsWith(r+sep))||stores.some(g=>parent===g||parent.startsWith(g+sep)))throw new Error('invalid_parent');
    return target;
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
  const git=(args,data,output,extraEnv)=>new Promise((res,rej)=>{
    const chunks=[],errors=[],child=spawn('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],
      {cwd:repo,env:{...environment,...operationTag(input.operation_id),...workspaceTag(input.workspace_id),GIT_AUTHOR_NAME:'Department Bot',GIT_AUTHOR_EMAIL:author.email,GIT_COMMITTER_NAME:'Department Bot',GIT_COMMITTER_EMAIL:author.email,...extraEnv},stdio:['pipe',output?.fd??'pipe','pipe']});
    child.stdout?.on('data',chunk=>chunks.push(chunk));
    let errorBytes=0;child.stderr.on('data',chunk=>{if(errorBytes<8000)errors.push(chunk.subarray(0,8000-errorBytes));errorBytes+=chunk.length;});
    child.on('error',()=>rej(new Error(`git ${args[0]} could not start`)));
    child.on('close',(code,signal)=>code===0?res(Buffer.concat(chunks)):rej(new Error(`git ${args[0]} failed: ${signal||code}; ${Buffer.concat(errors).toString('utf8').trim()}`)));
    child.stdin.on('error',()=>{});child.stdin.end(data);
  });
  // Snapshots the full working tree using a temporary GIT_INDEX_FILE so workspace_tree, workspace_finalize, and
  // workspace_verify_merge never mutate the live .git/index (preserving untracked files and the agent's staging state).
  const snapshotWorkingTree=async()=>{
    const indexPath=(await git(['rev-parse','--git-path','index'])).toString().trim();
    const absIndex=resolve(repo,indexPath);
    const idxInfo=await lstat(absIndex).catch(()=>null);
    if(idxInfo&&!idxInfo.isFile()){
      // Corrupted non-file index (e.g. a directory): invoke git directly so git's exact stderr is surfaced.
      await git(['add','--all']);
      return (await git(['write-tree'])).toString().trim();
    }
    const tmpIndex=root+'/.snapshot-index-'+randomBytes(8).toString('hex');
    try{
      if(idxInfo)await cp(absIndex,tmpIndex);
      const idxEnv={GIT_INDEX_FILE:tmpIndex};
      await git(['add','--all'],undefined,undefined,idxEnv);
      return (await git(['write-tree'],undefined,undefined,idxEnv)).toString().trim();
    }finally{
      await rm(tmpIndex,{force:true}).catch(()=>{});
    }
  };
  // Before an operation writes the worktree's index or HEAD, the locks a git process that ended abnormally left there are
  // removed and named in the result; while a git process works on the worktree the operation stops as busy, and the
  // control plane retries it (#712).
  const unlock=async()=>{
    const {removed,busy}=await clearStaleGitLocks(await base(),{workspaceId:input.workspace_id});
    if(busy)throw new Error(`git_worktree_busy: ${busy.locks.join(', ')} ${busy.pids.length?'held by running git process '+busy.pids.join(', '):`created less than ${lockGraceMs/1000} seconds ago`}; retry later`);
    return removed.length?{stale_git_locks_removed:removed}:{};
  };
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
    await ensureGitAuthor(repo,input.author_email||author.email);
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
    await ensureGitAuthor(target,input.author_email||author.email);
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
    if(typeof input.base64!=='string'||input.base64.length>6*1024*1024||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_content');
    const data=Buffer.from(input.base64,'base64'),target=await contextPath(input.path,true);
    const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
    try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(data,0,data.length,input.offset);}finally{await handle.close();}
    return {written:true};
  }
  if(input.type==='workspace_artifact_stage'){
    if(!/^[a-f0-9]{16,48}$/.test(String(input.stage_id||''))||typeof input.base64!=='string'||input.base64.length>6*1024*1024||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_artifact_stage');
    const data=Buffer.from(input.base64,'base64');
    if(input.offset+data.length>MAX_ARTIFACT_COMPRESSED_BYTES)throw new Error('artifact_too_large');
    await mkdir(root,{recursive:true,mode:0o700});
    const stage=root+'/.artifact-stage-'+input.stage_id;
    const handle=await open(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
    try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(data,0,data.length,input.offset);}finally{await handle.close();}
    return {staged:true};
  }
  if(input.type==='workspace_artifact_extract'){
    if(!/^[a-f0-9]{16,48}$/.test(String(input.stage_id||''))||typeof input.path!=='string'||!input.path)throw new Error('invalid_artifact_extract');
    const stage=root+'/.artifact-stage-'+input.stage_id;
    try{
      if(input.path.startsWith('../notes/')||resolve(input.path).startsWith(resolve(notesRoot)+sep))throw new Error('invalid_artifact_path');
      const target=input.path.startsWith('../context/')?await contextPath(input.path.slice(11),true):outsideRepo(input.path)?await computerPath(input.path,true):(await base(),await path(input.path,true));
      const archive=await readFile(stage);
      return extractArtifactZip(archive,target);
    }catch(error){
      if(error instanceof ArtifactArchiveError)return {error:error.code,detail:error.detail};
      throw error;
    }finally{await unlink(stage).catch(()=>{});}
  }
  if(input.type.startsWith('workspace_agent_')||input.type.startsWith('workspace_harness_'))return agentOperation(input,root);
  const resolvedNotes=resolve(notesRoot),realNotes=await realpath(notesRoot).catch(()=>resolvedNotes);
  const notesLinkPrefix=resolve(root,'notes')+sep;
  const noteTarget=async(value)=>{
    if(typeof value!=='string')return null;
    if(value.startsWith('../notes/'))return value.slice(9);
    const full=value.startsWith('/')?resolve(value):resolve(repo,value);
    if(full.startsWith(resolvedNotes+sep))return full.slice(resolvedNotes.length+1);
    if(full.startsWith(realNotes+sep))return full.slice(realNotes.length+1);
    if(full.startsWith(notesLinkPrefix))return full.slice(notesLinkPrefix.length);
    if(value.startsWith('/')||value.startsWith('../')||value.includes('/../')){
      // Resolve symlinked paths (e.g. /workspace/tasks/<ws>/notes/<file>) so writes into the project notes volume
      // always go through Notes (0o660 + history/catalog) instead of falling through to outsideRepo's 0o600 open (#1278).
      let probe=full;const tail=[];
      for(;;){
        const resolved=await realpath(probe).catch(()=>null);
        if(resolved!==null){
          const realFull=tail.length?resolved+sep+tail.join(sep):resolved;
          if(realFull.startsWith(realNotes+sep))return realFull.slice(realNotes.length+1);
          break;
        }
        const parent=dirname(probe);
        if(parent===probe)break;
        tail.unshift(probe.slice(parent.length+(parent.endsWith(sep)?0:1)));
        probe=parent;
      }
    }
    return null;
  };
  const notePath=!input.sha&&!input.snapshot?await noteTarget(input.path):null;
  if(notePath!==null&&input.type==='workspace_write'){
    if(input.mode!=='100644'||typeof input.base64!=='string'||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_note_write');
    const chunk=Buffer.from(input.base64,'base64');
    if(input.offset===0&&input.final===true)return notes.write(notePath,chunk.toString('utf8'));
    await mkdir(root,{recursive:true});
    const stage=root+'/.note-stage-'+createHash('sha256').update(notePath).digest('hex').slice(0,24);
    const handle=await open(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
    try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(chunk,0,chunk.length,input.offset);}finally{await handle.close();}
    if(!input.final)return {written:true};
    try{return await notes.write(notePath,await readFile(stage,'utf8'));}finally{await unlink(stage).catch(()=>{});}
  }
  if(notePath!==null&&input.type==='workspace_read')return notes.read(notePath);
  if(!input.sha&&!input.snapshot&&outsideRepo(input.path)&&(input.type==='workspace_read'||input.type==='workspace_write'||input.type==='workspace_export')){
    if(input.type==='workspace_read'){
      const target=await computerPath(input.path),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{return await readBoundedFile(handle,target,{maxBytes:input.max_bytes,skipBinary:input.skip_binary===true});}finally{await handle.close();}
    }
    if(input.type==='workspace_write'){
      if(typeof input.base64!=='string'||input.base64.length>6*1024*1024||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_content');
      if(input.final&&!['100644','100755'].includes(input.mode))throw new Error('invalid_mode');
      const data=Buffer.from(input.base64,'base64'),target=await computerPath(input.path,true);
      const realParent=await realpath(dirname(target));
      if(realParent===realNotes||realParent.startsWith(realNotes+sep))throw new Error('invalid_note_write');
      const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(input.offset===0?constants.O_TRUNC:0),0o600);
      try{if((await handle.stat()).size!==input.offset)throw new Error('offset_mismatch');await handle.write(data,0,data.length,input.offset);await handle.sync();}finally{await handle.close();}
      return {written:true};
    }
    return exportFile(await computerPath(input.path));
  }
  await base();
  if(input.type==='workspace_write'){
    if(typeof input.base64!=='string'||input.base64.length>6*1024*1024||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_content');
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
    await ensureGitAuthor(repo,author.email);
    return {tree_sha:tree,local_sha:commit,...unlocked};
  }
  // The tree a finalize would record now, without a commit or a ref (#1121 review): acceptance compares it with the submitted
  // candidate's tree before the project's test_command runs in this shared workspace.
  if(input.type==='workspace_tree')return withWorkspaceLock(root+'/finalize.lock',async()=>{const unlocked=await unlock();return {tree_sha:await snapshotWorkingTree(),...unlocked};});
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
  if(input.type==='workspace_import_commits'){
    await checkoutDirectory(repo,worktreeRoot);
    const unlocked=await unlock();
    const commits=Array.isArray(input.commits)?input.commits:[];
    const refMap={};
    const hasCommit=async sha=>/^[a-f0-9]{40}$/.test(sha||'')&&await git(['cat-file','-e',sha+'^{commit}']).then(()=>true,()=>false);
    const buildTree=async entries=>{
      const byDir=new Map([['',[]]]);
      const ensureDir=dir=>{
        if(byDir.has(dir))return;
        const parent=dir.includes('/')?dir.slice(0,dir.lastIndexOf('/')):'';
        ensureDir(parent);
        byDir.set(dir,[]);
        byDir.get(parent).push({mode:'040000',type:'tree',name:dir.includes('/')?dir.slice(dir.lastIndexOf('/')+1):dir,dir});
      };
      for(const f of entries){
        const p=safe(f.path),slash=p.lastIndexOf('/'),dir=slash>=0?p.slice(0,slash):'',name=slash>=0?p.slice(slash+1):p;
        if(!/^[a-f0-9]{40}$/.test(f?.sha||''))throw new Error('invalid_import_blob_sha:'+p);
        if(f.type==='commit'&&String(f.mode)==='160000'){
          ensureDir(dir);
          byDir.get(dir).push({mode:'160000',type:'commit',name,sha:f.sha});
          continue;
        }
        if(!['100644','100755','120000'].includes(String(f.mode||'100644')))throw new Error('invalid_import_blob_mode:'+p);
        let blobSha=f.sha;
        if(typeof f.base64==='string'){
          blobSha=(await git(['hash-object','--no-filters','-w','--stdin'],Buffer.from(f.base64,'base64'))).toString().trim();
          if(blobSha!==f.sha)throw new Error(`import_blob_sha_mismatch:${p}:expected ${f.sha}, actual ${blobSha}`);
        }else if(!(await git(['cat-file','-e',f.sha+'^{blob}']).then(()=>true,()=>false))){
          throw new Error('import_blob_missing:'+p);
        }
        ensureDir(dir);
        byDir.get(dir).push({mode:f.mode||'100644',type:'blob',name,sha:blobSha});
      }
      const writeDir=async dir=>{
        const items=byDir.get(dir)||[];
        const lines=[];
        for(const item of items){
          const sha=item.type==='tree'?await writeDir(item.dir):item.sha;
          lines.push(`${item.mode} ${item.type} ${sha}\t${item.name}`);
        }
        return (await git(['mktree'],Buffer.from(lines.length?lines.join('\n')+'\n':''))).toString().trim();
      };
      return writeDir('');
    };
    for(const c of commits){
      if(!/^[a-f0-9]{40}$/.test(c?.sha||''))throw new Error('invalid_import_commit');
      if(!/^[a-f0-9]{40}$/.test(c?.tree_sha||''))throw new Error('invalid_import_tree');
      if(await hasCommit(c.sha)){
        const existingTree=(await git(['rev-parse',c.sha+'^{tree}'])).toString().trim();
        if(existingTree!==c.tree_sha)throw new Error(`import_existing_tree_mismatch:${c.sha}`);
        await git(['update-ref','refs/bot/base/'+c.sha,c.sha]);
        refMap[c.sha]=c.sha;
        continue;
      }
      let treeSha=c.tree_sha;
      if(Array.isArray(c.files)){
        treeSha=await buildTree(c.files);
        if(treeSha!==c.tree_sha)throw new Error(`import_tree_sha_mismatch:${c.sha}:expected ${c.tree_sha}, actual ${treeSha}`);
      }else if(!(await git(['cat-file','-e',c.tree_sha+'^{tree}']).then(()=>true,()=>false))){
        throw new Error(`import_tree_missing:${c.sha}:${c.tree_sha}`);
      }
      const parentArgs=[];
      for(const p of Array.isArray(c.parents)?c.parents:[]){
        if(!/^[a-f0-9]{40}$/.test(p||''))throw new Error(`invalid_import_parent:${c.sha}`);
        const mapped=refMap[p]||(await hasCommit(p)?p:null);
        if(!mapped){
          if(c.boundary_lca===true)continue;
          throw new Error(`import_parent_missing:${c.sha}:${p}`);
        }
        parentArgs.push('-p',mapped);
      }
      const synth=(await git(['commit-tree',treeSha,...parentArgs],Buffer.from((c.message||'Imported commit')+'\n'))).toString().trim();
      await git(['update-ref','refs/bot/base/'+c.sha,synth]);
      refMap[c.sha]=synth;
    }
    if(!(await git(['config','--get','user.name']).then(b=>b.toString().trim(),()=>''))){
      await git(['config','user.name','Department Bot']);
    }
    if(!(await git(['config','--get','user.email']).then(b=>b.toString().trim(),()=>''))){
      await git(['config','user.email',author.email||'department-bot@invalid.local']);
    }
    if(input.conflict_base_sha){
      const baseRefTarget=refMap[input.conflict_base_sha]||(await hasCommit(input.conflict_base_sha)?input.conflict_base_sha:null);
      if(!baseRefTarget)throw new Error('conflict_base_missing');
      await git(['update-ref','refs/heads/bot-conflict-base',baseRefTarget]);
    }
    if(input.pr_head_sha){
      const prRefTarget=refMap[input.pr_head_sha]||(await hasCommit(input.pr_head_sha)?input.pr_head_sha:null);
      if(!prRefTarget)throw new Error('pr_head_missing');
      const headSha=(await git(['rev-parse','HEAD'])).toString().trim();
      const headTree=(await git(['rev-parse','HEAD^{tree}'])).toString().trim();
      const prTree=(await git(['rev-parse',prRefTarget+'^{tree}'])).toString().trim();
      const headParents=(await git(['rev-list','--parents','-n','1',headSha])).toString().trim().split(/\s+/).slice(1);
      if(!headParents.length&&headSha!==prRefTarget){
        if(headTree===prTree){
          await git(['update-ref','refs/heads/bot-local',prRefTarget]);
          await git(['update-ref','refs/bot/pr-local/'+input.pr_head_sha,prRefTarget]);
          await git(['symbolic-ref','HEAD','refs/heads/bot-local']).catch(()=>{});
        }else{
          const prParents=(await git(['rev-list','--parents','-n','1',prRefTarget])).toString().trim().split(/\s+/).slice(1);
          const pArgs=prParents.flatMap(p=>['-p',p]);
          const rooted=(await git(['commit-tree',headTree,...pArgs],Buffer.from('Snapshot PR head\n'))).toString().trim();
          await git(['update-ref','refs/heads/bot-local',rooted]);
          await git(['update-ref','refs/bot/pr-local/'+input.pr_head_sha,rooted]);
          await git(['symbolic-ref','HEAD','refs/heads/bot-local']).catch(()=>{});
        }
      }
    }
    return {imported:Object.keys(refMap),refs:refMap,...unlocked};
  }
  if(input.type==='workspace_verify_merge'){
    if(![input.base_sha,input.head_sha,input.head_tree_sha].every(v=>/^[a-f0-9]{40}$/.test(v||'')))throw new Error('invalid_verify_merge');
    return withWorkspaceLock(root+'/finalize.lock',async()=>{
      await checkoutDirectory(repo,worktreeRoot);
      const unlocked=await unlock();
      const unmerged=(await git(['diff','--name-only','--diff-filter=U','-z'])).toString().split('\0').filter(Boolean);
      if(unmerged.length)return {ok:false,reason:'unmerged_index',files:unmerged.slice(0,50),...unlocked};
      const candidateTree=await snapshotWorkingTree();
      const resolveRef=async ref=>{
        const resolved=await git(['rev-parse','--verify','--quiet',ref+'^{commit}']).then(b=>b.toString().trim(),()=>'');
        return /^[a-f0-9]{40}$/.test(resolved)?resolved:null;
      };
      const resolveCommit=async sha=>(await resolveRef(sha))||(await resolveRef('refs/bot/base/'+sha));
      const baseCommit=await resolveCommit(input.base_sha);
      if(!baseCommit)return {ok:false,reason:'base_commit_missing',candidate_tree:candidateTree,...unlocked};
      const prCommit=await resolveCommit(input.head_sha);
      if(!prCommit)return {ok:false,reason:'pr_commit_missing',candidate_tree:candidateTree,...unlocked};
      const prLocalCommit=await resolveRef('refs/bot/pr-local/'+input.head_sha);
      const headCommit=(await git(['rev-parse','HEAD'])).toString().trim();
      const baseTreeSha=(await git(['rev-parse',baseCommit+'^{tree}'])).toString().trim();
      const prTreeSha=(await git(['rev-parse',prCommit+'^{tree}'])).toString().trim();
      const mergeHead=await readFile(repo+'/.git/MERGE_HEAD','utf8').then(s=>s.trim(),()=>'');
      const isAncestor=(anc,desc)=>git(['merge-base','--is-ancestor',anc,desc]).then(()=>true,()=>false);
      const baseInHead=await isAncestor(baseCommit,headCommit);
      const prInHead=(await isAncestor(prCommit,headCommit))||Boolean(prLocalCommit&&await isAncestor(prLocalCommit,headCommit));
      const gitMerged=(baseInHead&&prInHead)||(prInHead&&mergeHead===baseCommit)||(baseInHead&&(mergeHead===prCommit||(Boolean(prLocalCommit)&&mergeHead===prLocalCommit)));
      const rebased=baseInHead&&!prInHead&&mergeHead!==prCommit&&!(prLocalCommit&&mergeHead===prLocalCommit);
      const alreadyAncestor=await isAncestor(baseCommit,prCommit);
      const prAlreadyInBase=await isAncestor(prCommit,baseCommit);
      if(!alreadyAncestor&&!prAlreadyInBase&&!gitMerged&&!rebased){
        if(candidateTree===input.head_tree_sha||candidateTree===prTreeSha){
          return {ok:false,reason:'tree_unchanged_from_pr_head',candidate_tree:candidateTree,git_merged:false,rebased:false,...unlocked};
        }
      }
      const treeMap=async treeish=>{
        const map=new Map();
        if(!treeish)return map;
        const out=await git(['ls-tree','-r','-z',treeish]).then(b=>b.toString(),()=>'');
        for(const entry of out.split('\0').filter(Boolean)){
          const tab=entry.indexOf('\t');if(tab<0)continue;
          const [mode,type,sha]=entry.slice(0,tab).trim().split(/\s+/),name=entry.slice(tab+1);
          if(type==='blob'||type==='commit')map.set(name,`${mode}:${type}:${sha}`);
        }
        return map;
      };
      const [bMap,pMap,cMap]=await Promise.all([
        treeMap(baseCommit),
        treeMap(prCommit),
        treeMap(candidateTree),
      ]);
      const isBlobEntry=v=>typeof v==='string'&&v.includes(':blob:');
      const markerFiles=[];
      for(const [name,cSha] of cMap){
        if(!isBlobEntry(cSha)||(cSha===bMap.get(name)&&cSha===pMap.get(name)))continue;
        if(cSha!==bMap.get(name)&&cSha!==pMap.get(name)){
          const bytes=await readFile(await path(name)).catch(()=>null);
          if(bytes&&/^(?:<<<<<<< |=======\r?$|>>>>>>> )/m.test(bytes.toString('utf8')))markerFiles.push(name);
        }
      }
      if(markerFiles.length)return {ok:false,reason:'conflict_markers_present',files:markerFiles.slice(0,50),candidate_tree:candidateTree,...unlocked};
      if(!alreadyAncestor&&!prAlreadyInBase&&!gitMerged&&!rebased){
        const lca=await git(['merge-base',baseCommit,prCommit]).then(b=>b.toString().trim(),()=>'');
        if(!/^[a-f0-9]{40}$/.test(lca)){
          return {ok:false,reason:'base_not_integrated',files:[],candidate_tree:candidateTree,git_merged:false,rebased:false,...unlocked};
        }
        const lcaMap=await treeMap(lca);
        const missingBase=[];
        const baseChanged=[];
        for(const name of new Set([...bMap.keys(),...lcaMap.keys()])){
          const bVal=bMap.get(name),lVal=lcaMap.get(name);
          if(bVal===lVal)continue;
          baseChanged.push(name);
          if(pMap.get(name)===lVal&&cMap.get(name)!==bVal)missingBase.push(name);
        }
        if(missingBase.length){
          return {ok:false,reason:'base_not_integrated',files:missingBase.slice(0,50),candidate_tree:candidateTree,git_merged:false,rebased:false,...unlocked};
        }
        if(baseChanged.length&&baseChanged.every(name=>cMap.get(name)===pMap.get(name))){
          return {ok:false,reason:'base_not_integrated',files:baseChanged.slice(0,50),candidate_tree:candidateTree,git_merged:false,rebased:false,...unlocked};
        }
      }
      return {ok:true,candidate_tree:candidateTree,git_merged:gitMerged,rebased,...unlocked};
    });
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
    const opts={maxBytes:input.max_bytes,skipBinary:input.skip_binary===true};
    if(input.sha){
      if(!/^[a-f0-9]{40}$/.test(input.sha))throw new Error('invalid_read_commit');
      const spec=input.sha+':'+safe(input.path);
      const size=Number((await git(['cat-file','-s',spec])).toString().trim());
      if(Number.isSafeInteger(opts.maxBytes)&&opts.maxBytes>0&&Number.isFinite(size)&&size>opts.maxBytes)return {skipped:true,reason:'file_too_large',size,version:input.sha};
      const raw=await git(['show',spec]);
      if(opts.skipBinary&&raw.subarray(0,8192).includes(0))return {skipped:true,reason:'binary_file',size:raw.length,version:input.sha};
      if(raw.length>outputLimit){
        const logsDir=root+'/logs';await mkdir(logsDir,{recursive:true,mode:0o700});
        const spillPath=logsDir+'/read-'+input.sha.slice(0,12)+'-'+createHash('sha256').update(spec).digest('hex').slice(0,16)+'.out';
        await writeFile(spillPath,raw,{mode:0o600});
        return {content:previewBytes(raw.subarray(0,64*1024),raw.subarray(Math.max(0,raw.length-64*1024)),raw.length,spillPath),truncated:true,size:raw.length,log_path:spillPath,version:input.sha};
      }
      return {content:raw.toString('utf8'),version:input.sha};
    }
    const target=await path(String(input.path||'')),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{return await readBoundedFile(handle,target,opts);}finally{await handle.close();}
  }
  // Snapshot one regular private-workspace file; later chunks read this immutable blob, never a live mutable path.
  if(input.type==='workspace_export')return exportFile(await path(input.path));
  // secret_env comes only from the agent process in this container; the manager forwards no such field.
  if(input.type==='workspace_command')return command(input.command,repo,input.timeout_ms,{outputFile:input.output_file,keepBackground:input.keep_background===true,secretEnv:input.secret_env,workspaceId:input.workspace_id,operationId:input.operation_id,backgroundDirectory:root+'/logs',onOutput:input._onOutput,onSpawn:input._onSpawn,sshEnv:input._sshEnv});
  if(input.type==='workspace_git_inspect')return withWorkspaceLock(root+'/finalize.lock',async()=>{
    const unlocked=await unlock();
    const ref=input.ref===undefined?'HEAD':String(input.ref).trim();
    if(!ref||ref.length>256||ref.startsWith('-')||/[\0\r\n\s]/.test(ref))throw new Error('invalid_git_ref');
    const headSha=(await git(['rev-parse','--verify','--quiet','--end-of-options',ref+'^{commit}'])).toString().trim();
    if(!/^[a-f0-9]{40}$/.test(headSha))throw new Error('git_commit_not_found');
    const treeSha=(await git(['rev-parse','--verify','--quiet',headSha+'^{tree}'])).toString().trim();
    const parents=(await git(['rev-list','--parents','-n','1',headSha])).toString().trim().split(/\s+/).slice(1);
    const subject=(await git(['show','-s','--format=%s',headSha])).toString().trim();
    const unmerged=names(await git(['diff','--name-only','--diff-filter=U','-z']));
    const dirtyWorking=names(await git(['diff','--name-only','-z','HEAD']));
    const dirtyIndex=names(await git(['diff','--cached','--name-only','-z','HEAD']));
    const trackedDirty=[...new Set([...dirtyWorking,...dirtyIndex])];
    const untracked=names(await git(['ls-files','-z','--others','--exclude-standard']));
    const isWorktree=await stat(repo+'/.git').then(s=>s.isFile(),()=>false);
    return {
      head_sha:headSha,
      tree_sha:treeSha,
      parents,
      subject,
      unmerged_files:unmerged.slice(0,200),
      tracked_dirty_files:trackedDirty.slice(0,200),
      untracked_files:untracked.slice(0,200),
      untracked_count:untracked.length,
      is_worktree:isWorktree,
      ...unlocked,
    };
  });
  if(input.type==='workspace_git_export_pack'){
    if(!/^[a-f0-9]{40}$/.test(input.sha||'')||!id48.test(input.pack_id||'')||!Number.isSafeInteger(input.offset)||input.offset<0)throw new Error('invalid_git_export');
    const maxPackBytes=128*1024*1024;
    const out=root+'/.git-export-'+input.pack_id;
    if(input.offset===0){
      await git(['cat-file','-e',input.sha+'^{commit}']);
      const haves=Array.isArray(input.have_commits)?input.have_commits.filter(s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s)).slice(0,512):[];
      let present=[];
      if(haves.length){
        const checked=(await git(['cat-file','--batch-check=%(objectname) %(objecttype)'],Buffer.from(haves.join('\n')+'\n'))).toString();
        present=checked.split('\n').filter(line=>line.endsWith(' commit')).map(line=>line.split(' ')[0]);
      }
      const revs=[input.sha,...present.map(s=>'^'+s)].join('\n')+'\n';
      const handle=await open(out,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
      let createdSize=0;
      try{
        await git(['pack-objects','--revs','--thin','--stdout','-q'],Buffer.from(revs),handle);
        createdSize=(await handle.stat()).size;
      }
      catch(error){await rm(out,{force:true}).catch(()=>{});throw error;}
      finally{await handle.close();}
      if(createdSize>maxPackBytes){await rm(out,{force:true}).catch(()=>{});throw new Error('git_export_pack_too_large');}
    }
    const handle=await open(out,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const chunkLimit=Number.isSafeInteger(input.limit)&&input.limit>=1?Math.min(input.limit,4*1024*1024):45000;
      const size=(await handle.stat()).size,buffer=Buffer.alloc(Math.max(0,Math.min(chunkLimit,size-input.offset)));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,input.offset),next=input.offset+bytesRead;
      if(next>=size)await rm(out,{force:true}).catch(()=>{});
      return {base64:buffer.subarray(0,bytesRead).toString('base64'),offset:input.offset,size,done:next>=size};
    }finally{await handle.close();}
  }
  if(input.type==='workspace_finalize')return withWorkspaceLock(root+'/finalize.lock',async()=>{
    const unlocked=await unlock();
    const tree=await snapshotWorkingTree();
    const raw=(await git(['ls-tree','-r','-l','-z',tree])).toString();const files=[];
    for(const row of raw.split('\0').filter(Boolean)){
      const tab=row.indexOf('\t'),[mode,type,hash,size]=row.slice(0,tab).trim().split(/\s+/),name=safe(row.slice(tab+1));
      // A submodule a checkout keeps in the index stays as the base tree has it; it is not a file of the candidate.
      if(type==='commit'&&mode==='160000')continue;
      if(type!=='blob'||!['100644','100755','120000'].includes(mode))throw new Error(`unsupported_tree_entry: ${name}, type ${type}, mode ${mode}`);
      files.push({path:name,mode,sha:hash,size:Number(size)});
    }
    const head=(await git(['rev-parse','HEAD'])).toString().trim();
    const local=(await git(['commit-tree',tree,'-p','HEAD'],Buffer.from('Project agent candidate\n'))).toString().trim();
    // SQLite references must remain readable after Git's ordinary garbage collection.
    await git(['update-ref','refs/bot/artifacts/'+local,local]);
    const expectedHead=typeof input.expected_head_sha==='string'&&/^[a-f0-9]{40}$/i.test(input.expected_head_sha)?input.expected_head_sha.toLowerCase():null;
    return {tree_sha:tree,local_sha:local,head_sha:head,...(expectedHead?{head_matches_baseline:head.toLowerCase()===expectedHead}:{}),files,...unlocked};
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
      const chunkLimit=Number.isSafeInteger(input.limit)&&input.limit>=1?Math.min(input.limit,4*1024*1024):30000;
      const size=(await handle.stat()).size,data=Buffer.alloc(Math.max(0,Math.min(chunkLimit,size-input.offset)));
      const {bytesRead}=await handle.read(data,0,data.length,input.offset);
      return {base64:data.subarray(0,bytesRead).toString('base64'),size};
    }finally{await handle.close();}
  }
  throw new Error('unsupported_workspace_operation');
}
