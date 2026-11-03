import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { workspace } from '../runner/workspace.mjs';
import { Notes } from '../runner/notes.mjs';
import { Docker } from '../manager/docker.mjs';
import { Projects } from '../manager/projects.mjs';
import { FakeDocker } from './fake-docker.mjs';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { agentLoop } from '../dist/agent/loop.js';
import { Workspace } from '../dist/agent/workspace.js';
import { Redactor, treeSha } from '../dist/agent/common.js';
import { loadConsole } from './console-page.mjs';

const id = () => randomBytes(24).toString('hex');
async function directory(t) {
  await mkdir('.tmp', { recursive: true }); const root = await mkdtemp(resolve('.tmp/project-notes-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function managerFixture(t) {
  const root = await directory(t), docker = new FakeDocker(), options = { database: join(root, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' };
  let projects = new Projects(options); t.after(() => projects.db.close());
  const manager = { async call(method, path, input) {
    const [, repo, action, name] = /^\/v1\/projects\/(\d+)(?:\/(\w+)(?:\/(.+))?)?$/.exec(path);
    if (action === 'notes') return projects.notes(repo, method, name, input);
    if (method === 'GET') return projects.describe(repo);
    if (method === 'PUT') return projects.register(repo);
    return projects.operate(repo, action, input);
  } };
  return { root, docker, manager, get projects() { return projects; }, restart() { projects.db.close(); projects = new Projects(options); } };
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
    const candidate = await run(task, { type: 'workspace_finalize' });
    assert.deepEqual(candidate.files, []); assert.equal(candidate.tree_sha, treeSha([]));
    assert.equal(execFileSync('git', ['ls-tree','-r',candidate.local_sha], { cwd: join(tasks, task, 'repo') }).toString(), '');
    for (const path of ['../notes/../repo/x.md','../notes/../../x.md','../notes//x.md','../notes/./x.md','../notes/.git/x.md','../notes/a/b.md','../notes/a\\b.md','../notes/.hidden.md','../notes/a.txt','/workspace/project-notes/x.md','../notes/' + 'a'.repeat(65) + '.md']) {
      await assert.rejects(run(task, { type: 'workspace_read', path }), /invalid_(?:path|note_name)/, path);
      await assert.rejects(run(task, { type: 'workspace_write', path, base64: 'eA==', offset: 0, final: true, mode: '100644' }), /invalid_(?:path|note_name)/, path);
    }
    await run(task, { type: 'workspace_context', path: 'nested/object.json', base64: 'eA==', offset: 0 });
    assert.equal((await run(task, { type: 'workspace_read', path: '../context/nested/object.json' })).content, 'x');
    await assert.rejects(run(task, { type: 'workspace_read', path: '../context/../notes/repository.md' }), /invalid_path/);
  }
});

test('note quotas reject the entire write without truncation, including UTF-8 bytes and concurrent writers', async t => {
  const root = await directory(t), notes = new Notes(join(root,'notes'));
  await notes.write('repository.md', 'before');
  await assert.rejects(notes.write('repository.md', '界'.repeat(22000)), /note_file_limit_64_KiB/);
  assert.equal((await notes.read('repository.md')).content, 'before');
  await notes.delete('repository.md');
  for (let i = 0; i < 32; i++) await notes.write('note' + i + '.md', 'x');
  await assert.rejects(notes.write('extra.md','x'), /notes_file_count_limit_32/);
  assert.equal((await notes.list()).length,32);
  await notes.write('note0.md','updated'); assert.equal((await notes.read('note0.md')).content, 'updated');
  for (const file of await notes.list()) await notes.delete(file.name);
  for (let i = 0; i < 7; i++) await notes.write('large' + i + '.md','x'.repeat(65536));
  const writes = await Promise.allSettled(['last1.md','last2.md'].map(name => new Notes(notes.root).write(name,'y'.repeat(65536))));
  assert.equal(writes.filter(w => w.status === 'fulfilled').length, 1);
  assert.match(writes.find(w => w.status === 'rejected').reason.message, /notes_total_limit_512_KiB/);
  assert.equal((await notes.list()).reduce((n,file) => n + file.bytes,0),512*1024);
  await assert.rejects(notes.write('large0.md','z'.repeat(65537)), /note_file_limit_64_KiB/);
  assert.equal((await notes.read('large0.md')).content, 'x'.repeat(65536));
  // A process killed during a reset must not leave the stable volume permanently locked.
  await mkdir(join(notes.root,'.write-lock')); await writeFile(join(notes.root,'.write-lock/owner'),'stopped writer');
  await utimes(join(notes.root,'.write-lock'),new Date(0),new Date(0));
  await notes.write('large0.md','recovered'); assert.equal((await notes.read('large0.md')).content,'recovered');
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

test('project administrators can CRUD their notes but cannot access another project; credentials never reach storage or logs', async t => {
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
  const rejected = await member(path+'/repository.md','PUT',{ content:'secret: '+a.token });
  assert.equal(rejected.status,400); assert.equal(rejected.value.error,'credential_in_notes');
  assert.equal((await admin(path+'/repository.md')).value.content,'shared');
  const redactor = new Redactor(); redactor.add(a.token); const logs=[];
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('secret','101','review.issue','running','fixture')");
  const work = new Workspace(h.store,{call:async()=>assert.fail('must refuse before manager')},h.store.get("SELECT * FROM tasks WHERE id='secret'"),redactor,async()=>{},entry=>logs.push(entry));
  assert.deepEqual(await work.call('write',{type:'workspace_write',path:'../notes/secret.md',base64:Buffer.from(a.token).toString('base64')}),{error:'credential_in_notes'});
  assert.equal(h.store.get("SELECT count(*) n FROM task_tools WHERE task_id='secret'").n,0);
  assert.ok(!JSON.stringify(logs).includes(a.token));
  assert.ok(!JSON.stringify(h.store.all('SELECT content FROM task_logs')).includes(a.token));
  assert.equal((await member(path+'/repository.md','DELETE',{})).status,200);
  assert.deepEqual((await member(path)).value.files,[]);
  assert.equal(f.docker.containers.size,computers); assert.equal(f.docker.starts,starts,'none of the page operations boots a computer');
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
    for(const text of ['At task start','../notes/','repository.md','preferences.md','corrections.md','correct or remove','Do not create empty','Issue or PR language','existing language','Never store keys','not rules','change review events','override .bot rules','Review may write','must not modify','Neither review nor development','32 files','64 KiB','512 KiB','Replacement rules'])assert.ok(config.system.includes(text),kind+': '+text);
    assert.ok(config.tools.some(tool=>tool.function.name==='write_file'));
  }
});

test('model responses containing a known credential mark the note call rejected before any runner or log sees the content',async t=>{
  const key='model-credential-must-not-be-saved',callId='secret-call';
  const server=createServer(async(req,res)=>{for await(const _ of req);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:callId,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'../notes/secret.md',content:key})}}]}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:key,model_name:'fixture'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('model-secret','101','review.pr','running','fixture')");
  const replies=[],logs=[],requests=[];let replied=false;
  const finish={summary:'Done',requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:'',findings:[]};
  const work={log:entry=>logs.push(entry),call:async(_key,input)=>{
    requests.push(input);
    if(input.type==='workspace_agent_reply'){replies.push(Buffer.from(input.base64,'base64'));replied=input.final;}
    if(input.type==='workspace_agent_poll')return replied?{state:'completed',result:finish}:{state:'running',request:{id:id(),body:{messages:[{role:'user',content:'review'}]}}};
    return {};
  }};
  await agentLoop(h.store,{id:'model-secret',repository_id:'101',kind:'review.pr',workspace_id:id()},work,new Redactor(),async()=>{},{});
  const reply=JSON.parse(Buffer.concat(replies));assert.deepEqual(reply.rejected_note_calls,[callId]);
  assert.equal(JSON.parse(JSON.parse(reply.body).choices[0].message.tool_calls[0].function.arguments).content,'');
  assert.ok(!JSON.stringify(requests).includes(key));assert.ok(!JSON.stringify(logs).includes(key));
});

test('the project notes page browses first, expands one editor, saves and returns to the list', async () => {
  const files=new Map([['repository.md','Existing notes']]);
  const page=loadConsole(['static/app.js','static/views.js','static/project.js'],async(method,path,body)=>{
    const name=path.split('/')[5];
    if(method==='PUT'){files.set(name,body.content);return [200,{written:true}];}
    return [200,name?{content:files.get(name)}:{files:[...files].map(([name])=>({name,bytes:10}))}];
  });
  await page.run("current={id:'101'}; $('project-page').append(...notesSection())");
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(page.run("projectSections.some(([id,title])=>id==='notes'&&title==='项目笔记')"));
  const root=page.$('project-page'); assert.equal(root.querySelectorAll('textarea').length,0);
  const edit=root.querySelectorAll('button').find(b=>b.textContent==='查看／编辑');await edit.listeners.click[0]();
  const editor=root.querySelector('textarea'); assert.equal(editor.value,'Existing notes');editor.value='Updated notes';
  root.querySelector('input').checkValidity=()=>true;
  await root.querySelector('form').listeners.submit[0]({preventDefault(){}});
  assert.equal(files.get('repository.md'),'Updated notes');assert.equal(root.querySelectorAll('textarea').length,0);
  await root.querySelectorAll('button').find(b=>b.textContent==='新建 Markdown').listeners.click[0]();
  assert.equal(root.querySelector('textarea').value,'');
  await root.querySelectorAll('button').find(b=>b.textContent==='取消').listeners.click[0]();
  assert.equal(root.querySelectorAll('textarea').length,0);assert.equal(files.size,1);
});
