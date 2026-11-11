import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {workspace} from '../runner/workspace.mjs';
import {withWorkspaceLock} from '../runner/workspace-lock.mjs';
import {randomWorkspaceId} from './helpers.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('C parallel observers wait for one workspace collection boundary, preserve candidate A, then collect B',async t=>{
 const root=mkdtempSync(join(tmpdir(),'finalize-parallel-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const id=randomWorkspaceId(),run=req=>workspace({...req,workspace_id:id},root,join(root,'git'),join(root,'notes'));
 await run({type:'workspace_init'});execFileSync('git',['init','-q'],{cwd:join(root,id,'repo')});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','base'],{cwd:join(root,id,'repo')});await run({type:'workspace_write',path:'app.txt',base64:Buffer.from('A').toString('base64'),offset:0,final:true,mode:'100644'});
 const entered=deferred(),release=deferred();const held=withWorkspaceLock(join(root,id,'finalize.lock'),async()=>{entered.resolve();await release.promise;});await entered.promise;
 let finished=0;const observers=[run({type:'workspace_finalize'}),run({type:'workspace_finalize'})].map(p=>p.then(v=>{finished++;return v;}));
 await new Promise(r=>setTimeout(r,80));assert.equal(finished,0);release.resolve();await held;
 const [a,b]=await Promise.all(observers);assert.equal(a.tree_sha,b.tree_sha);assert.equal(a.files.length,1);
 writeFileSync(join(root,id,'repo/app.txt'),'B');const next=await run({type:'workspace_finalize'});assert.notEqual(next.tree_sha,a.tree_sha);
 assert.equal(execFileSync('git',['show',a.local_sha+':app.txt'],{cwd:join(root,id,'repo'),encoding:'utf8'}),'A');
 const other=randomWorkspaceId();await workspace({type:'workspace_init',workspace_id:other},root,join(root,'git'),join(root,'notes'));execFileSync('git',['init','-q'],{cwd:join(root,other,'repo')});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','base'],{cwd:join(root,other,'repo')});
 const release2=deferred(),entered2=deferred();const hold2=withWorkspaceLock(join(root,id,'finalize.lock'),async()=>{entered2.resolve();await release2.promise;});await entered2.promise;
 try{await workspace({type:'workspace_write',workspace_id:other,path:'other',base64:Buffer.from('independent').toString('base64'),offset:0,final:true,mode:'100644'},root);const result=await workspace({type:'workspace_finalize',workspace_id:other},root);assert.equal(result.files.length,1);}finally{release2.resolve();await hold2;}
});
