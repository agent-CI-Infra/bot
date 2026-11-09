import { managerFixture } from './project-manager-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { workspace } from '../runner/workspace.mjs';
import { Notes } from '../runner/notes.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { ManagerClient } from '../dist/projects/service.js';
import { Docker } from '../manager/docker.mjs';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { agentLoop } from '../dist/agent/loop.js';
import { Workspace } from '../dist/agent/workspace.js';
import { Redactor, treeSha } from '../dist/agent/common.js';

const id = () => randomBytes(24).toString('hex');
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-notes-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('notes are shared by task workspaces, commands keep their checkout cwd, and both candidate trees exclude notes', async t => {
  const root = await directory(t), tasks = join(root, 'tasks'), notes = join(root, 'project-notes');
  const run = (workspace_id, request) => workspace({ ...request, workspace_id }, tasks, undefined, notes);
  for (const mode of ['review','development']) {
    const task = id(); await run(task, { type: 'workspace_init' });
    await run(task, { type: 'workspace_snapshot', tree_sha: treeSha([]) });
    await run(task, { type: 'workspace_write', path: '../notes/repository.md', base64: Buffer.from(mode).toString('base64'), offset: 0, final: true, mode: '100644' });
    const other = id(); await run(other, { type: 'workspace_init' });
    assert.equal((await run(other, { type: 'workspace_read', path: '../notes/repository.md' })).content, mode);
    assert.equal(await readFile(join(tasks, other, 'notes/repository.md'), 'utf8'), mode, 'shell alias points to the same bytes');
    const result = await run(task, { type: 'workspace_command', command: 'pwd; printf shell > ../notes/preferences.md', timeout_ms: 5000 });
    assert.equal(result.output.trim(), join(tasks, task, 'repo'));
    assert.equal((await new Notes(notes).read('preferences.md')).content, 'shell');
    const content = '任务输出与已知凭据 fixture-token\n' + '界'.repeat(30000);
    for (const name of ['仓库经验','x'.repeat(100),'-commands.txt','.hidden','name #?% with spaces']) {
      await run(task, { type:'workspace_write',path:'../notes/'+name,base64:Buffer.from(content).toString('base64'),offset:0,final:true,mode:'100644' });
      assert.equal((await run(other,{type:'workspace_read',path:'../notes/'+name})).content,content);
    }
    const candidate = await run(task, { type: 'workspace_finalize' });
    assert.deepEqual(candidate.files, []); assert.equal(candidate.tree_sha, treeSha([]));
    assert.equal(execFileSync('git', ['ls-tree','-r',candidate.local_sha], { cwd: join(tasks, task, 'repo') }).toString(), '');
    for (const path of ['../notes/../repo/x.md','../notes/../../x.md','../notes//x.md','../notes/./x.md','../notes/.git/x.md','../notes/a/b.md','../notes/a\\b.md','../notes/.write-lock','../notes/.write-reserved','../notes/.expired-reserved','/workspace/project-notes/x.md']) {
      await assert.rejects(run(task, { type: 'workspace_read', path }), /invalid_(?:path|note_name)/, path);
      await assert.rejects(run(task, { type: 'workspace_write', path, base64: 'eA==', offset: 0, final: true, mode: '100644' }), /invalid_(?:path|note_name)/, path);
    }
    await run(task, { type: 'workspace_context', path: 'nested/object.json', base64: 'eA==', offset: 0 });
    assert.equal((await run(task, { type: 'workspace_read', path: '../context/nested/object.json' })).content, 'x');
    await assert.rejects(run(task, { type: 'workspace_read', path: '../context/../notes/repository.md' }), /invalid_path/);
  }
});

test('notes accept many large files and unrestricted single-segment names while preserving atomic writes and locks', async t => {
  const root = await directory(t), notes = new Notes(join(root,'notes'));
  const content = '任务流水、一次性输出与 token: fixture-known-token\n' + '界'.repeat(30000);
  for (let i = 0; i < 33; i++) await notes.write('note' + i, content);
  assert.equal((await notes.list()).length,33);
  assert.ok((await notes.list()).reduce((n,file) => n + file.bytes,0)>512*1024);
  assert.equal((await notes.read('note32')).content,content);
  for (const name of ['仓库经验','x'.repeat(100),'-commands.txt','.hidden','name #?% with spaces']) {
    await notes.write(name,content); assert.equal((await notes.read(name)).content,content);
    assert.ok((await notes.list()).some(file=>file.name===name));
  }
  await Promise.all(['parallel1','parallel2'].map(name=>new Notes(notes.root).write(name,content)));
  for (const name of ['parallel1','parallel2']) assert.equal((await notes.read(name)).content,content);
  // Internal lock and temporary files are not user notes, even after allowing ordinary dotfiles.
  await mkdir(join(notes.root,'.write-lock')); await writeFile(join(notes.root,'.write-lock/owner'),'stopped writer');
  await writeFile(join(notes.root,'.write-leftover'),'temporary'); await writeFile(join(notes.root,'.expired-leftover'),'temporary');
  const listed = (await notes.list()).map(file=>file.name);
  assert.ok(listed.includes('.hidden')); assert.ok(!listed.some(name=>name.startsWith('.write-')||name.startsWith('.expired-')));
  for (const name of ['.write-lock','.write-leftover','.expired-leftover']) {
    await assert.rejects(notes.read(name),/invalid_note_name/);
    await assert.rejects(notes.write(name,'overwrite'),/invalid_note_name/);
    await assert.rejects(notes.delete(name),/invalid_note_name/);
  }
  await utimes(join(notes.root,'.write-lock'),new Date(0),new Date(0));
  await notes.write('note0','recovered'); assert.equal((await notes.read('note0')).content,'recovered');
  const outside = join(root,'outside'); await writeFile(outside,'outside');
  await symlink(outside,join(notes.root,'link.md'));
  await assert.rejects(notes.read('link.md'), /ELOOP/);
  await assert.rejects(notes.write('link.md','replace'), /invalid_note_file/);
  assert.equal(await readFile(outside,'utf8'),'outside');
});

test('the manager resolves the host backing path from its own persistent mount without creating containers', async () => {
  const docker = new Docker(); const calls=[];
  docker.request = async (method,path) => { calls.push([method,path]); return { Mounts: [{ Destination:'/data',Source:'/host/manager-data/_data',RW:true }] }; };
  assert.equal(await docker.volumeSource('/data/project-notes/101'),'/host/manager-data/_data/project-notes/101');
  assert.equal(calls.length,1); assert.match(calls[0][1],/^\/containers\/.+\/json$/);
  await assert.rejects(docker.volumeSource('/elsewhere/notes'),/notes_storage_mount_missing/);
});

test('page edits work before boot; stop, disable, rebuild, manager restart and reset retain the same notes volume', async t => {
  const f = await managerFixture(t);
  await f.projects.notes('101','PUT','repository.md',{ content:'persistent' });
  assert.equal(f.docker.containers.size,0); assert.equal(f.docker.runs.length,0);
  const name = f.projects.notesName('101'), volume = f.docker.volumes.get(name);
  assert.equal(volume.Options.device,join(f.projects.notesRoot,'101'));
  const task=id(),run=request=>workspace({...request,workspace_id:task},join(f.root,'tasks'),undefined,volume.Options.device);
  await run({type:'workspace_init'});
  assert.equal((await run({type:'workspace_read',path:'../notes/repository.md'})).content,'persistent');
  await run({type:'workspace_write',path:'../notes/preferences.md',base64:Buffer.from('from task').toString('base64'),offset:0,final:true,mode:'100644'});
  assert.equal((await f.projects.notes('101','GET','preferences.md')).content,'from task');
  await f.projects.operate('101','start',{ operation_id:id(),generation:1 });
  const mount = generation => f.docker.containers.get(f.projects.names('101',generation).container).HostConfig.Mounts.find(m => m.Target === '/workspace/project-notes');
  assert.deepEqual(mount(1),{ Type:'volume',Source:name,Target:'/workspace/project-notes',ReadOnly:false });
  await f.projects.operate('101','configure',{ operation_id:id(),generation:1,request:{ memory_mb:2048 } });
  assert.equal(mount(1).Source,name);
  await f.projects.operate('101','stop',{ operation_id:id(),generation:1 }); f.restart();
  assert.equal((await f.projects.notes('101','GET','repository.md')).content,'persistent');
  await f.projects.operate('101','reset',{ operation_id:id(),generation:1 });
  assert.equal(mount(2).Source,name); assert.equal(f.docker.volumes.get(name),volume);
  assert.equal((await f.projects.notes('101','GET','repository.md')).content,'persistent');
  await f.projects.operate('101','delete',{ operation_id:id(),generation:2 });
  assert.ok(f.docker.volumes.has(name),'deleting only the computer retains notes');
});

test('project administrators can store credentials verbatim in notes but cannot access another project', async t => {
  const f = await managerFixture(t), h = await harness(t,f.manager), { admin } = await setup(h), a = await account(admin);
  await repository(admin,a.id,'101'); await repository(admin,a.id,'202');
  await h.projects.reconcile();
  const computers=f.docker.containers.size, starts=f.docker.starts;
  const password = testPassword(); await admin('/api/users','POST',{ username:'member',password,repository_ids:['101'] });
  const member = h.client(); await member('/api/auth/login','POST',{ username:'member',password });
  const path = '/api/repositories/101/notes';
  assert.equal((await member(path+'/repository.md','PUT',{ content:'shared' })).status,200);
  assert.equal((await admin(path+'/repository.md')).value.content,'shared');
  assert.equal((await member(path)).value.files[0].name,'repository.md');
  for (const method of ['GET','PUT','DELETE']) {
    const result = await member('/api/repositories/202/notes/repository.md',method,method==='GET'?undefined:{ content:'no' });
    assert.equal(result.status,403); assert.equal(result.value.error,'repository_forbidden');
  }
  const content = '任务流水与一次性输出：secret: '+a.token;
  assert.equal((await member(path+'/repository.md','PUT',{ content })).status,200);
  assert.equal((await admin(path+'/repository.md')).value.content,content);
  const redactor = new Redactor(); redactor.add(a.token); const logs=[];
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('secret','101','review.issue','running','fixture')");
  const task = {...h.store.get("SELECT * FROM tasks WHERE id='secret'"),workspace_id:id(),generation:1,attempt:1};
  const work = new Workspace(h.store,{call:async(_method,_path,input)=>({ok:true,result:await workspace(input.request,join(f.root,'tasks'),undefined,join(f.projects.notesRoot,'101'))})},task,redactor,async()=>{},entry=>logs.push(entry));
  await workspace({type:'workspace_init',workspace_id:task.workspace_id},join(f.root,'tasks'),undefined,join(f.projects.notesRoot,'101'));
  assert.deepEqual(await work.call('write',{type:'workspace_write',path:'../notes/secret.md',base64:Buffer.from(content).toString('base64'),offset:0,final:true,mode:'100644'}),{written:true});
  assert.equal((await admin(path+'/secret.md')).value.content,content);
  assert.ok(!JSON.stringify(logs).includes(a.token));
  assert.ok(!JSON.stringify(h.store.all('SELECT content FROM task_logs')).includes(a.token));
  assert.equal((await member(path+'/secret.md','DELETE',{})).status,200);
  assert.equal((await member(path+'/repository.md','DELETE',{})).status,200);
  assert.deepEqual((await member(path)).value.files,[]);
  assert.equal(f.docker.containers.size,computers); assert.equal(f.docker.starts,starts,'none of the page operations boots a computer');
});

test('project-page HTTP APIs accept Unicode names and large contents through both control plane and manager',async t=>{
  const f=await managerFixture(t),token=Buffer.from('notes-http-fixture');
  const {server,recovered}=createManagerServer({projects:f.projects,token}); await recovered;
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const manager=new ManagerClient(`http://127.0.0.1:${server.address().port}`,token);
  const h=await harness(t,manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const path='/api/repositories/101/notes',content='任务流水：'+a.token+'\n'+'中文输出🙂'.repeat(131072);
  assert.ok(Buffer.byteLength(content)>1500000,'exercises both existing generic JSON body limits');
  for(let i=0;i<33;i++)assert.equal((await admin(path+'/'+i,'PUT',{content:'entry '+i})).status,200);
  for(const name of ['仓库经验','x'.repeat(100),'-commands.txt','.hidden','name #?% with spaces']){
    const endpoint=path+'/'+encodeURIComponent(name);
    assert.equal((await admin(endpoint,'PUT',{content})).status,200);
    assert.equal((await admin(endpoint)).value.content,content);
    assert.equal((await new Notes(join(f.projects.notesRoot,'101')).read(name)).content,content);
  }
  const listing=(await admin(path)).value;
  assert.equal(listing.files.length,38);assert.ok(!('limits' in listing));
  assert.ok(listing.files.some(file=>file.name==='.hidden'));
  for(const name of ['nested/file','back\\slash','.write-lock','.write-staging','.expired-staging','.git','\0']){
    const endpoint=path+'/'+encodeURIComponent(name);
    for(const method of ['GET','PUT','DELETE'])assert.equal((await admin(endpoint,method,method==='GET'?undefined:{content:'escape'})).status,400,name);
  }
  assert.equal((await admin(path+'/'+encodeURIComponent('name #?% with spaces'),'DELETE',{})).status,200);
});

test('project removal deletes notes, but environment, volume or record-deletion failures retain project records and notes', async t => {
  const f = await managerFixture(t), h = await harness(t,f.manager), { admin } = await setup(h), a = await account(admin);
  for (const repo of ['101','202','303','404']) { await repository(admin,a.id,repo); await f.projects.register(repo); await f.projects.notes(repo,'PUT','repository.md',{content:'keep-'+repo}); }
  const failRemoval = async repo => {
    assert.ok((await admin('/api/projects/'+repo,'DELETE',{})).status >= 400);
    assert.ok(h.store.get('SELECT id FROM repositories WHERE id=?',repo));
    assert.ok(f.docker.volumes.has(f.projects.notesName(repo)));
    assert.equal((await f.projects.notes(repo,'GET','repository.md')).content,'keep-'+repo);
  };
  const original = f.docker.request.bind(f.docker);
  f.docker.request = async (method,path,...args) => { if (method==='DELETE'&&path.startsWith('/networks/')) throw new Error('injected environment failure'); return original(method,path,...args); };
  await failRemoval('101'); f.docker.request=original;
  f.docker.failVolume=true; await failRemoval('202'); f.docker.failVolume=false;
  h.store.db.exec("CREATE TRIGGER refuse_project_deletion BEFORE DELETE ON repositories WHEN OLD.id='303' BEGIN SELECT RAISE(ABORT,'injected record failure'); END");
  await failRemoval('303');
  assert.equal((await admin('/api/projects/404','DELETE',{})).status,200);
  assert.ok(!h.store.get("SELECT id FROM repositories WHERE id='404'"));
  assert.ok(!f.docker.volumes.has(f.projects.notesName('404')));
  await assert.rejects(readFile(join(f.projects.notesRoot,'404/repository.md')),/ENOENT/);
});

test('review and development system prompts require useful maintained notes even when repository rules replace built-ins', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin,a.id,'101');
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:'https://model.invalid/v1',api_key:'prompt-fixture-key',model_name:'fixture'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  for (const kind of ['review.issue','review.pr','development.issue']) {
    const chunks=[]; let config, published=false;
    const work={log:()=>{},call:async(_key,request)=>{
      if(request.type==='workspace_agent_config'){chunks.push(Buffer.from(request.base64,'base64'));if(request.final)config=JSON.parse(Buffer.concat(chunks));}
      if(request.type==='workspace_agent_pull_request')published=true;
      if(request.type==='workspace_agent_poll')return kind.startsWith('development')&&!published?{state:'running',pull_request:{id:id(),arguments:{summary:'ready',test_command:'true'}}}:{state:'completed',result:{summary:'Reviewed',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]}};
      return {};
    }};
    await agentLoop(h.store,{id:'prompt',repository_id:'101',workspace_id:id(),kind},work,new Redactor(),async()=>{},{effective_rules:{files:[{path:'.bot/rules/pr-review.md',source:'repository',effective:'Replacement rules'}]}},undefined,async()=>({status:'no_changes'}));
    for(const text of ['At task start','../notes/','repository.md','preferences.md','corrections.md','correct or remove','Do not create empty','Issue or PR language','existing language','not rules','change review events','override .bot rules','Notes are never committed','Replacement rules'])assert.ok(config.system.includes(text),kind+': '+text);
    // Only a workflow without the code write is told to leave the checkout alone.
    assert.equal(config.system.includes('must not modify files in the repository checkout'),!kind.startsWith('development'),kind);
    for(const removed of ['32 files','64 KiB','512 KiB','Never store keys','known credentials are rejected','Note names must match'])assert.ok(!config.system.includes(removed),kind+': '+removed);
    const writeTool=config.tools.find(tool=>tool.function.name==='write_file');assert.ok(writeTool);
    assert.doesNotMatch(writeTool.function.description, /<name>\.md/);
  }
});

test('model responses preserve known credentials in note writes while other output remains redacted',async t=>{
  const key='model-credential-must-not-be-saved',callId='secret-call';
  const server=createServer(async(req,res)=>{for await(const _ of req);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:callId,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'../notes/secret.md',content:key})}}]}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:key,model_name:'fixture'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('model-secret','101','review.pr','running','fixture')");
  const replies=[],logs=[];let replied=false;
  const finish={summary:'Done',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
  const work={log:entry=>logs.push(entry),call:async(_key,input)=>{
    if(input.type==='workspace_agent_reply'){replies.push(Buffer.from(input.base64,'base64'));replied=input.final;}
    if(input.type==='workspace_agent_poll')return replied?{state:'completed',result:finish}:{state:'running',request:{id:id(),body:{messages:[{role:'user',content:'review'}]}}};
    return {};
  }};
  await agentLoop(h.store,{id:'model-secret',repository_id:'101',kind:'review.pr',workspace_id:id()},work,new Redactor(),async()=>{},{});
  const reply=JSON.parse(Buffer.concat(replies));assert.ok(!('rejected_note_calls' in reply));
  assert.equal(JSON.parse(JSON.parse(reply.body).choices[0].message.tool_calls[0].function.arguments).content,key);
  assert.ok(!JSON.stringify(logs).includes(key));
});
