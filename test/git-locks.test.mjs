import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,utimesSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {workspace} from '../runner/workspace.mjs';
import {clearStaleGitLocks,gitDirectory} from '../runner/git-locks.mjs';
import {randomWorkspaceId} from './helpers.mjs';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';

// #712: a git process killed during finalize left index.lock in the worktree's admin directory of the computer's shared
// git store (/workspace/git/repo.git/worktrees/<name>/index.lock), and every later finalize failed on it.
const identity={GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
function computer(t){
  const root=mkdtempSync(join(tmpdir(),'git-locks-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=join(root,'git','repo.git'),git=(args,options={})=>execFileSync('git',args,{cwd:store,encoding:'utf8',env:{...process.env,...identity},...options}).trim();
  mkdirSync(join(root,'git'),{recursive:true});execFileSync('git',['init','--bare','-q',store]);
  const blob=git(['hash-object','-w','--stdin'],{input:'base\n'}),tree=git(['mktree'],{input:`100644 blob ${blob}\tbase.txt\n`}),sha=git(['commit-tree',tree,'-m','base']);
  git(['update-ref','refs/bot/commits/'+sha,sha]);
  const id=randomWorkspaceId(),run=request=>workspace({...request,workspace_id:id},root,join(root,'git'),join(root,'notes'));
  return {root,id,run,sha,tree,repo:join(root,id,'repo')};
}
// A lock left by a git process that ended long ago.
const leftover=(directory,name='index.lock',age=120)=>{const file=join(directory,name);writeFileSync(file,'');const then=new Date(Date.now()-age*1000);utimesSync(file,then,then);return file;};
// A git process that keeps running until it is ended: cat-file waits for object names on its input.
async function runningGit(t,args,options){
  const child=spawn('git',args,{stdio:['pipe','ignore','ignore'],...options});
  const ended=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}});
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(child.exitCode,null,'the git process is still running');
  return {pid:child.pid,end:async()=>{child.stdin.end();await ended;}};
}

test('#712 finalize removes an index.lock that no running git holds in a worktree of the computer store and reports it',async t=>{
  const c=computer(t);
  assert.deepEqual(await c.run({type:'workspace_checkout',sha:c.sha,tree_sha:c.tree}),{tree_sha:c.tree,local_sha:c.sha});
  const admin=await gitDirectory(c.repo);assert.match(admin,/\/git\/repo\.git\/worktrees\/[^/]+$/);
  writeFileSync(join(c.repo,'change.txt'),'changed\n');const lock=leftover(admin);
  // What production saw on every retry before this change.
  assert.throws(()=>execFileSync('git',['add','--all'],{cwd:c.repo,stdio:'pipe'}),/index\.lock': File exists/);
  const result=await c.run({type:'workspace_finalize'});
  assert.equal(existsSync(lock),false);
  assert.equal(result.stale_git_locks_removed.length,1);assert.equal(result.stale_git_locks_removed[0].file,'index.lock');assert.ok(result.stale_git_locks_removed[0].age_seconds>=119);
  assert.deepEqual(result.files.map(f=>f.path).sort(),['base.txt','change.txt']);
  // Nothing is left over the next time, so nothing is reported.
  assert.equal((await c.run({type:'workspace_finalize'})).stale_git_locks_removed,undefined);
});

test('#712 a lock a running git process holds is kept and the operation reports the worktree busy until that process ends',async t=>{
  const c=computer(t);await c.run({type:'workspace_checkout',sha:c.sha,tree_sha:c.tree});
  const admin=await gitDirectory(c.repo),lock=leftover(admin);
  const git=await runningGit(t,['cat-file','--batch'],{cwd:c.repo});
  await assert.rejects(c.run({type:'workspace_finalize'}),new RegExp(`^Error: git_worktree_busy: index\\.lock held by running git process ${git.pid}; retry later$`));
  assert.equal(existsSync(lock),true);
  // A git process the runner tagged with the task's workspace id counts wherever it runs.
  const tagged=await runningGit(t,['--git-dir='+join(c.root,'git','repo.git'),'cat-file','--batch'],{cwd:c.root,env:{...process.env,BOT_WORKSPACE_ID:c.id}});
  await git.end();
  await assert.rejects(c.run({type:'workspace_finalize'}),new RegExp(`held by running git process ${tagged.pid};`));
  assert.equal(existsSync(lock),true);
  await tagged.end();
  assert.equal((await c.run({type:'workspace_finalize'})).stale_git_locks_removed[0].file,'index.lock');assert.equal(existsSync(lock),false);
});

test('#712 a lock too new to tell is kept, other per-worktree locks are cleared, and a repository of its own is covered too',async t=>{
  const c=computer(t);await c.run({type:'workspace_checkout',sha:c.sha,tree_sha:c.tree});
  const admin=await gitDirectory(c.repo),fresh=leftover(admin,'index.lock',1);
  assert.deepEqual(await clearStaleGitLocks(c.repo,{workspaceId:c.id}),{removed:[],busy:{locks:['index.lock'],pids:[]}});
  assert.equal(existsSync(fresh),true);
  await assert.rejects(c.run({type:'workspace_finalize'}),/git_worktree_busy: index\.lock created less than 10 seconds ago; retry later/);
  leftover(admin,'index.lock');leftover(admin,'HEAD.lock');
  const removed=await clearStaleGitLocks(c.repo,{workspaceId:c.id});
  assert.deepEqual(removed.removed.map(lock=>lock.file),['HEAD.lock','index.lock']);assert.equal(removed.busy,undefined);
  // Locks of the shared store itself are not this worktree's.
  const shared=leftover(join(c.root,'git','repo.git'),'packed-refs.lock');
  assert.deepEqual(await clearStaleGitLocks(c.repo,{workspaceId:c.id}),{removed:[]});assert.equal(existsSync(shared),true);
  // A file-copy checkout keeps a repository of its own in repo/.git.
  const own=join(c.root,'own');mkdirSync(own);execFileSync('git',['init','-q'],{cwd:own});
  leftover(join(own,'.git'));
  assert.deepEqual((await clearStaleGitLocks(own)).removed.map(lock=>lock.file),['index.lock']);
  assert.deepEqual(await clearStaleGitLocks(join(c.root,'missing')),{removed:[]});
});

test('#712 the task log names the locks the runner removed before an operation',async t=>{
  const h=await emptyRepositoryFixture(t,{execute(request){
    if(request.type==='workspace_snapshot')return {ok:true,result:{tree_sha:request.tree_sha,stale_git_locks_removed:[{file:'index.lock',age_seconds:120}]}};
  }});
  h.setBranch('ready');assert.equal((await h.run()).status,'succeeded');
  const logs=h.store.all("SELECT content FROM task_logs WHERE task_id=? AND json_extract(content,'$.type')='git_locks_removed'",h.taskId).map(row=>JSON.parse(row.content));
  assert.deepEqual(logs,[{type:'git_locks_removed',operation:'workspace_snapshot',locks:[{file:'index.lock',age_seconds:120}],
    detail:'workspace_snapshot 前清理了工作区里没有 git 进程持有的遗留锁：index.lock（已存在 120 秒）'}]);
});
