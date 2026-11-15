import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readlinkSync,lstatSync,mkdirSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {workspace} from '../runner/workspace.mjs';
import {listTaskDirectories,removeTaskDirectories} from '../runner/task-dirs.mjs';
import {storageScan} from '../runner/storage-scan.mjs';
import {randomWorkspaceId} from './helpers.mjs';

// #769: the computer's worktrees live in /workspace/worktrees/<id>; a task directory links to one as repo.
const identity={GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
function computer(t){
  const root=mkdtempSync(join(tmpdir(),'worktrees-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=join(root,'git','repo.git'),git=(args,options={})=>execFileSync('git',args,{cwd:store,encoding:'utf8',env:{...process.env,...identity},...options}).trim();
  mkdirSync(join(root,'git'),{recursive:true});execFileSync('git',['init','--bare','-q',store]);
  const commit=(files,parent)=>{
    const tree=git(['mktree'],{input:Object.entries(files).map(([name,text])=>`100644 blob ${git(['hash-object','-w','--stdin'],{input:text})}\t${name}\n`).join('')});
    const sha=git(['commit-tree',tree,...parent?['-p',parent]:[],'-m','commit']);git(['update-ref','refs/bot/commits/'+sha,sha]);return {sha,tree};
  };
  // .gitignore keeps node_modules out of the changes, like a project's installed dependencies.
  const base=commit({'base.txt':'base\n','.gitignore':'node_modules/\n'}),next=commit({'base.txt':'next\n','.gitignore':'node_modules/\n'},base.sha);
  const tasks=join(root,'tasks'),worktrees=join(root,'worktrees');
  const run=(id,request)=>workspace({...request,workspace_id:id},tasks,join(root,'git'),join(root,'notes'),worktrees);
  return {root,tasks,worktrees,run,base,next,repo:id=>join(tasks,id,'repo'),wt:id=>join(worktrees,id),git:(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,...identity}}).trim()};
}

test('#769 a created worktree is linked as the task checkout; file tools and commands work through the link and stay inside it',async t=>{
  const c=computer(t),task=randomWorkspaceId(),id=randomWorkspaceId();
  const created=await c.run(task,{type:'workspace_worktree_create',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  assert.deepEqual(created,{worktree_id:id,head:c.base.sha,tree_sha:c.base.tree,changed_count:0,changed:[],local_sha:c.base.sha});
  assert.equal(readlinkSync(c.repo(task)),c.wt(id));assert.equal(lstatSync(c.wt(id)).isDirectory(),true);
  assert.equal(c.git(c.wt(id),['rev-parse','HEAD']),c.base.sha);
  assert.deepEqual(await c.run(task,{type:'workspace_read',path:'base.txt'}),{content:'base\n'});
  const data=Buffer.from('written\n');
  assert.deepEqual(await c.run(task,{type:'workspace_write',path:'dir/new.txt',base64:data.toString('base64'),offset:0,final:true,mode:'100644'}),{written:true});
  assert.equal(readFileSync(join(c.wt(id),'dir/new.txt'),'utf8'),'written\n');
  // A link inside the checkout pointing out of it is refused as before.
  symlinkSync(c.tasks,join(c.wt(id),'out'));
  await assert.rejects(c.run(task,{type:'workspace_write',path:'out/x.txt',base64:data.toString('base64'),offset:0,final:true,mode:'100644'}),/invalid_parent/);
  const command=await c.run(task,{type:'workspace_command',command:'cat base.txt && git rev-parse HEAD'});
  assert.equal(command.exit_code,0);assert.match(command.output,new RegExp(`base\\n${c.base.sha}`));
  // Finalize sees the change in the shared worktree.
  const final=await c.run(task,{type:'workspace_finalize'});assert.ok(final.files.some(file=>file.path==='dir/new.txt'));
});

test('#769 a worktree is handed to another task only at the commit asked for and without changes; ignored files stay',async t=>{
  const c=computer(t),first=randomWorkspaceId(),second=randomWorkspaceId(),third=randomWorkspaceId(),id=randomWorkspaceId();
  await c.run(first,{type:'workspace_worktree_create',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  mkdirSync(join(c.wt(id),'node_modules'));writeFileSync(join(c.wt(id),'node_modules','dep.js'),'installed\n');
  const bound=await c.run(second,{type:'workspace_worktree_bind',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  assert.equal(bound.head,c.base.sha);assert.equal(bound.changed_count,0);
  assert.equal(readlinkSync(c.repo(second)),c.wt(id));
  assert.equal(readFileSync(join(c.repo(second),'node_modules','dep.js'),'utf8'),'installed\n','installed dependencies stay for the next task');
  // Another commit is refused, and nothing changes in the worktree or in the task directory.
  const moved=await c.run(third,{type:'workspace_worktree_bind',worktree_id:id,sha:c.next.sha,tree_sha:c.next.tree});
  assert.deepEqual(moved,{refused:'workspace_mismatch',head:c.base.sha,tree_sha:c.base.tree,changed_count:0,changed:[]});
  assert.equal(existsSync(c.repo(third)),false);
  // Changes, tracked or untracked and not ignored, are refused too: they are never discarded or handed over silently.
  writeFileSync(join(c.wt(id),'base.txt'),'edited\n');writeFileSync(join(c.wt(id),'notes.txt'),'new\n');
  const dirty=await c.run(third,{type:'workspace_worktree_bind',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  assert.equal(dirty.refused,'workspace_dirty');assert.deepEqual(dirty.changed.sort(),['base.txt','notes.txt']);
  assert.equal(readFileSync(join(c.wt(id),'base.txt'),'utf8'),'edited\n');
  const missing=await c.run(third,{type:'workspace_worktree_bind',worktree_id:randomWorkspaceId(),sha:c.base.sha,tree_sha:c.base.tree});
  assert.deepEqual(missing,{refused:'workspace_missing'});
  await assert.rejects(c.run(third,{type:'workspace_worktree_create',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree}),/worktree_exists/);
});

test('#769 a link anywhere else is a replaced workspace; a file copy or own checkout replaces the link, never the worktree',async t=>{
  const c=computer(t),task=randomWorkspaceId(),other=randomWorkspaceId(),id=randomWorkspaceId();
  await c.run(task,{type:'workspace_worktree_create',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  rmSync(c.repo(task));symlinkSync(c.tasks,c.repo(task));
  await assert.rejects(c.run(task,{type:'workspace_read',path:'base.txt'}),/workspace_replaced/);
  rmSync(c.repo(task));symlinkSync(c.wt(id),c.repo(task));
  // A file copy of the same workspace (the Git cache failed) is its own directory.
  await c.run(task,{type:'workspace_init'});
  assert.equal(lstatSync(c.repo(task)).isSymbolicLink(),false);assert.equal(readFileSync(join(c.wt(id),'base.txt'),'utf8'),'base\n');
  await c.run(other,{type:'workspace_worktree_bind',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  assert.deepEqual(await c.run(other,{type:'workspace_checkout',sha:c.next.sha,tree_sha:c.next.tree}),{tree_sha:c.next.tree,local_sha:c.next.sha});
  assert.equal(lstatSync(c.repo(other)).isSymbolicLink(),false);assert.equal(c.git(c.wt(id),['rev-parse','HEAD']),c.base.sha,'the shared worktree did not move');
});

test('#769 evaluators, restores and moves work from a task whose checkout is a linked worktree',async t=>{
  const c=computer(t),writer=randomWorkspaceId(),evaluator=randomWorkspaceId(),id=randomWorkspaceId();
  await c.run(writer,{type:'workspace_worktree_create',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  writeFileSync(join(c.wt(id),'added.txt'),'added\n');
  const candidate=await c.run(writer,{type:'workspace_finalize'});
  const copied=await c.run(evaluator,{type:'workspace_acceptance',source_workspace_id:writer,sha:candidate.local_sha,tree_sha:candidate.tree_sha});
  assert.equal(copied.tree_sha,candidate.tree_sha);assert.equal(readFileSync(join(c.repo(evaluator),'added.txt'),'utf8'),'added\n');
  const restored=randomWorkspaceId(),other=randomWorkspaceId();
  await c.run(restored,{type:'workspace_worktree_create',worktree_id:other,sha:c.base.sha,tree_sha:c.base.tree});
  assert.equal((await c.run(restored,{type:'workspace_restore',source_workspace_id:writer,sha:candidate.local_sha,tree_sha:candidate.tree_sha})).restored,true);
  assert.equal(readFileSync(join(c.wt(other),'added.txt'),'utf8'),'added\n');
  // #770's move in place moves the linked worktree.
  const moved=await c.run(restored,{type:'workspace_advance',sha:c.next.sha,tree_sha:c.next.tree});
  assert.equal(moved.local_sha,c.next.sha);assert.equal(c.git(c.wt(other),['rev-parse','HEAD']),c.next.sha);assert.equal(moved.saved.files.includes('added.txt'),true);
});

test('#769 the cleanup lists and removes worktrees like task directories; removing a task directory keeps its worktree',async t=>{
  const c=computer(t),task=randomWorkspaceId(),id=randomWorkspaceId();
  await c.run(task,{type:'workspace_worktree_create',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  const tasks=await listTaskDirectories(c.tasks),worktrees=await listTaskDirectories(c.worktrees);
  assert.deepEqual(tasks.entries.map(entry=>entry.name),[task]);assert.deepEqual(worktrees.entries.map(entry=>entry.name),[id]);
  const scan=await storageScan(c.root);
  assert.deepEqual(scan.tasks.map(entry=>entry.name).sort(),[task,id].sort(),'each worktree counts once, under its own id');
  assert.deepEqual((await removeTaskDirectories([{name:task,active_at:tasks.entries[0].active_at}],c.tasks,join(c.root,'git'))).removed.map(item=>item.name),[task]);
  assert.equal(readFileSync(join(c.wt(id),'base.txt'),'utf8'),'base\n','the worktree outlives the task directory that linked to it');
  assert.equal(c.git(join(c.root,'git','repo.git'),['worktree','list']).includes(c.wt(id)),true);
  const removed=await removeTaskDirectories([{name:id,active_at:worktrees.entries[0].active_at}],c.worktrees,join(c.root,'git'));
  assert.deepEqual(removed.removed.map(item=>item.name),[id]);assert.equal(existsSync(c.wt(id)),false);
  assert.equal(c.git(join(c.root,'git','repo.git'),['worktree','list']).includes(c.wt(id)),false,'its registration in the store is pruned');
});

test('#769 before a task has a worktree its context, notes and agent mailbox work; repository calls answer workspace_not_selected',async t=>{
  const c=computer(t),task=randomWorkspaceId(),text=value=>Buffer.from(value).toString('base64');
  assert.deepEqual(await c.run(task,{type:'workspace_context',path:'object.json',base64:text('{"title":"Fix"}'),offset:0}),{written:true});
  assert.deepEqual(await c.run(task,{type:'workspace_read',path:'../context/object.json'}),{content:'{"title":"Fix"}'});
  assert.equal((await c.run(task,{type:'workspace_write',path:'../notes/repository.md',base64:text('learned\n'),offset:0,final:true,mode:'100644'})).written,true);
  assert.equal((await c.run(task,{type:'workspace_read',path:'../notes/repository.md'})).content,'learned\n');
  assert.equal((await c.run(task,{type:'workspace_agent_config',base64:text('{}'),offset:0,final:true})).written,true);
  for(const request of [{type:'workspace_read',path:'base.txt'},{type:'workspace_command',command:'true'},{type:'workspace_finalize'},
    {type:'workspace_write',path:'base.txt',base64:text('x'),offset:0,final:true,mode:'100644'},{type:'workspace_read',path:'base.txt',sha:c.base.sha}])
    await assert.rejects(c.run(task,request),/^Error: workspace_not_selected: /,request.type);
  assert.equal(existsSync(c.repo(task)),false,'nothing made a checkout');
});

test('#769 inspecting worktrees reports HEAD, changes and last handover of each, and changes nothing',async t=>{
  const c=computer(t),task=randomWorkspaceId(),clean=randomWorkspaceId(),changed=randomWorkspaceId(),gone=randomWorkspaceId();
  await c.run(task,{type:'workspace_worktree_create',worktree_id:clean,sha:c.base.sha,tree_sha:c.base.tree});
  await c.run(randomWorkspaceId(),{type:'workspace_worktree_create',worktree_id:changed,sha:c.next.sha,tree_sha:c.next.tree});
  mkdirSync(join(c.wt(clean),'node_modules'));writeFileSync(join(c.wt(clean),'node_modules','dep.js'),'installed\n');
  writeFileSync(join(c.wt(changed),'base.txt'),'edited\n');
  const {worktrees}=await c.run(task,{type:'workspace_worktree_inspect',worktree_ids:[clean,changed,gone]});
  assert.deepEqual(worktrees.map(({used_at,...entry})=>entry),[
    {worktree_id:clean,present:true,head:c.base.sha,tree_sha:c.base.tree,changed_count:0,changed:[]},
    {worktree_id:changed,present:true,head:c.next.sha,tree_sha:c.next.tree,changed_count:1,changed:['base.txt']},
    {worktree_id:gone,present:false}]);
  assert.ok(worktrees.slice(0,2).every(entry=>!Number.isNaN(Date.parse(entry.used_at))));
  assert.equal(readFileSync(join(c.wt(changed),'base.txt'),'utf8'),'edited\n');
  await assert.rejects(c.run(task,{type:'workspace_worktree_inspect',worktree_ids:['x']}),/invalid_worktree/);
  await assert.rejects(c.run(task,{type:'workspace_worktree_inspect',worktree_ids:Array.from({length:31},()=>randomWorkspaceId())}),/invalid_worktree/);
});

test('#769 a chosen worktree with changes is taken only as asked: keep_changes as it is, reset after saving its changes as a patch',async t=>{
  const c=computer(t),first=randomWorkspaceId(),second=randomWorkspaceId(),third=randomWorkspaceId(),id=randomWorkspaceId();
  await c.run(first,{type:'workspace_worktree_create',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree});
  mkdirSync(join(c.wt(id),'node_modules'));writeFileSync(join(c.wt(id),'node_modules','dep.js'),'installed\n');
  writeFileSync(join(c.wt(id),'base.txt'),'edited\n');writeFileSync(join(c.wt(id),'new.txt'),'new\n');
  // keep_changes takes it at its commit with the changes; it cannot move it to another commit.
  const kept=await c.run(second,{type:'workspace_worktree_bind',worktree_id:id,sha:c.base.sha,tree_sha:c.base.tree,on_changes:'keep_changes'});
  assert.deepEqual([kept.head,kept.changed_count,kept.changed.sort(),kept.saved],[c.base.sha,2,['base.txt','new.txt'],undefined]);assert.equal(readlinkSync(c.repo(second)),c.wt(id));
  const elsewhere=await c.run(third,{type:'workspace_worktree_bind',worktree_id:id,sha:c.next.sha,tree_sha:c.next.tree,on_changes:'keep_changes'});
  assert.equal(elsewhere.refused,'workspace_mismatch');assert.equal(existsSync(c.repo(third)),false);
  // reset saves the changes into the taking task's context, restores the worktree to the commit asked for and keeps ignored files.
  const reset=await c.run(third,{type:'workspace_worktree_bind',worktree_id:id,sha:c.next.sha,tree_sha:c.next.tree,on_changes:'reset'});
  const patch=`saved-changes-${id.slice(0,12)}-${c.base.sha.slice(0,12)}.patch`;
  assert.deepEqual([reset.head,reset.tree_sha,reset.changed_count,reset.saved.path,reset.saved.count,reset.saved.files.sort()],[c.next.sha,c.next.tree,0,'../context/'+patch,2,['base.txt','new.txt']]);
  const saved=readFileSync(join(c.tasks,third,'context',patch),'utf8');assert.match(saved,/\+edited/);assert.match(saved,/new file mode[\s\S]*\+new/);
  assert.deepEqual([readFileSync(join(c.wt(id),'base.txt'),'utf8'),existsSync(join(c.wt(id),'new.txt')),readFileSync(join(c.wt(id),'node_modules','dep.js'),'utf8')],['next\n',false,'installed\n']);
  assert.equal((await c.run(third,{type:'workspace_read',path:'base.txt'})).content,'next\n');
  // A clean worktree at the commit asked for needs nothing to reset: nothing is saved.
  const again=await c.run(randomWorkspaceId(),{type:'workspace_worktree_bind',worktree_id:id,sha:c.next.sha,tree_sha:c.next.tree,on_changes:'reset'});
  assert.deepEqual([again.changed_count,again.saved],[0,undefined]);
  await assert.rejects(c.run(randomWorkspaceId(),{type:'workspace_worktree_bind',worktree_id:id,sha:c.next.sha,tree_sha:c.next.tree,on_changes:'discard'}),/invalid_worktree/);
});
