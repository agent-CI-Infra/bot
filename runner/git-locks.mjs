import {lstat,readdir,readFile,readlink,stat,unlink} from 'node:fs/promises';
import {basename,resolve} from 'node:path';

// While Git writes a worktree's index or HEAD it holds <name>.lock in that worktree's own Git directory, and it removes
// the lock when it ends. A git process killed on the way (a restart, a timeout, a full disk) leaves the lock behind, and
// every later git command on the worktree then fails with "Unable to create '…/index.lock': File exists" (#712).

// How long a lock with no git process behind it must have existed before it counts as left over: a git process that
// started a moment ago may already hold its lock while it is not visible yet.
export const lockGraceMs = 10_000;

// The worktree's own Git directory: <store>/worktrees/<name> for a worktree of the computer's store (its .git is a file
// naming that directory), or <repo>/.git for a repository of its own. Null when there is none.
export async function gitDirectory(repo){
  const dotGit=resolve(repo,'.git'),info=await lstat(dotGit).catch(()=>null);
  if(info?.isDirectory())return dotGit;
  if(!info?.isFile())return null;
  const pointer=/^gitdir: (.+)$/m.exec(await readFile(dotGit,'utf8'))?.[1]?.trim();
  return pointer?resolve(repo,pointer):null;
}

// The git processes of this computer working on the worktree: their current directory is in the worktree or its Git
// directory (git -C changes into it too), they name either path, or the runner tagged them with the task's workspace id.
// A process this runner may not inspect belongs to another user, never to a task's command.
export async function gitProcesses(repo,admin,workspaceId){
  const inside=value=>[repo,admin].some(root=>value===root||value.startsWith(root+'/')),found=[];
  for(const pid of await readdir('/proc').catch(()=>[])){
    if(!/^\d+$/.test(pid)||Number(pid)===process.pid)continue;
    const argv=(await readFile(`/proc/${pid}/cmdline`).catch(()=>Buffer.alloc(0))).toString().split('\0').filter(Boolean);
    if(!argv.length||!/^git(?:-|$)/.test(basename(argv[0])))continue;
    const cwd=await readlink(`/proc/${pid}/cwd`).catch(()=>'');
    const env=(await readFile(`/proc/${pid}/environ`).catch(()=>Buffer.alloc(0))).toString().split('\0');
    if(inside(cwd)||argv.some(arg=>arg.includes(repo)||arg.includes(admin))||workspaceId&&env.includes('BOT_WORKSPACE_ID='+workspaceId))found.push(Number(pid));
  }
  return found;
}

// Removes the worktree's left-over locks: *.lock files directly in its Git directory that no git process of this computer
// can be holding and that are older than the grace period. Returns what it removed, and `busy` when a lock stays because
// a git process works on the worktree or the lock is too new to tell; the caller then reports the worktree busy.
// A git process that starts after the scan cannot hold one of these files: git creates its lock exclusively, so while the
// old file exists it fails with "File exists" instead. Only the process that created a lock holds it, and one that did so
// before the scan was either found by it or has ended.
export async function clearStaleGitLocks(repo,{workspaceId,graceMs=lockGraceMs,processes=gitProcesses}={}){
  const admin=await gitDirectory(repo);if(!admin)return {removed:[]};
  const locks=(await readdir(admin,{withFileTypes:true}).catch(()=>[])).filter(entry=>entry.isFile()&&entry.name.endsWith('.lock')).map(entry=>entry.name).sort();
  if(!locks.length)return {removed:[]};
  const pids=await processes(repo,admin,workspaceId);
  if(pids.length)return {removed:[],busy:{locks,pids}};
  const removed=[],recent=[];
  for(const name of locks){
    const info=await stat(admin+'/'+name).catch(()=>null);if(!info)continue;
    const age=Date.now()-info.mtimeMs;
    if(age<graceMs){recent.push(name);continue;}
    await unlink(admin+'/'+name).catch(error=>{if(error.code!=='ENOENT')throw error;});
    removed.push({file:name,age_seconds:Math.round(age/1000)});
  }
  return recent.length?{removed,busy:{locks:recent,pids:[]}}:{removed};
}
