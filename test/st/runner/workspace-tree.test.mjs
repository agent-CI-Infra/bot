import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {workspace} from '../../../runner/workspace.mjs';
import {randomWorkspaceId} from '../../fixtures/helpers.mjs';

// #1121 review: acceptance asks the shared workspace for the tree a finalize would record before it runs the project's test
// command there. workspace_tree answers that tree without committing it or adding a ref.
const identity={GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
function computer(t){
  const root=mkdtempSync(join(tmpdir(),'workspace-tree-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=join(root,'git','repo.git'),git=(args,options={})=>execFileSync('git',args,{cwd:store,encoding:'utf8',env:{...process.env,...identity},...options}).trim();
  mkdirSync(join(root,'git'),{recursive:true});execFileSync('git',['init','--bare','-q',store]);
  const blob=git(['hash-object','-w','--stdin'],{input:'base\n'}),tree=git(['mktree'],{input:`100644 blob ${blob}\tbase.txt\n`}),sha=git(['commit-tree',tree,'-m','base']);
  git(['update-ref','refs/bot/commits/'+sha,sha]);
  const id=randomWorkspaceId(),run=request=>workspace({...request,workspace_id:id},root,join(root,'git'),join(root,'notes'));
  return {run,sha,tree,repo:join(root,id,'repo'),refs:()=>git(['for-each-ref','--format=%(refname)']).split('\n').filter(Boolean)};
}

test('workspace_tree reports the tree a finalize would record, without a commit or a ref', async t => {
  const c=computer(t);
  await c.run({type:'workspace_checkout',sha:c.sha,tree_sha:c.tree});
  assert.equal((await c.run({type:'workspace_tree'})).tree_sha,c.tree);
  writeFileSync(join(c.repo,'change.txt'),'changed\n');
  const refs=c.refs(),head=execFileSync('git',['rev-parse','HEAD'],{cwd:c.repo,encoding:'utf8'}).trim();
  const live=(await c.run({type:'workspace_tree'})).tree_sha;
  assert.notEqual(live,c.tree);
  assert.deepEqual(c.refs(),refs,'no ref is added');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:c.repo,encoding:'utf8'}).trim(),head,'HEAD stays');
  // The same tree finalize then records for the candidate.
  assert.equal((await c.run({type:'workspace_finalize'})).tree_sha,live);
});
