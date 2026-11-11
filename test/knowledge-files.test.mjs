import { createManagerServer } from '../manager/server.mjs';
import { ManagerClient } from '../dist/projects/service.js';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notes } from '../runner/notes.mjs';
import { managerFixture } from './project-manager-fixture.mjs';
import { harness, setup, account, repository } from './helpers.mjs';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { knowledgeFilesApi } from '../dist/projects/knowledge-files.js';
import { invalidate } from '../dist/identity/authorization.js';

async function directory(t) { const root=await mkdtemp(join(tmpdir(),'knowledge-files-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
test('free files retain exact revisions across workspace writes, external edits, conflicts, deletion and restore', async t=>{
 const root=await directory(t),notes=new Notes(join(root,'notes'));await notes.directory();
 const name='自由文件 #?%.txt',original='{\n  "original": true\n}\n';await writeFile(join(notes.root,name),original);
 assert.equal((await notes.file(name)).revision,1);assert.equal((await notes.file(name)).content,original);
 await notes.write(name,'workspace edit');assert.equal((await notes.file(name)).revision,2);
 const races=await Promise.allSettled([notes.saveFile(name,'human edit',2,'user:a'),new Notes(notes.root).saveFile(name,'concurrent edit',2,'user:b')]);
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.match(races.find(r=>r.status==='rejected').reason.message,/note_revision_changed/);
 await writeFile(join(notes.root,name),'shell edit');assert.equal((await notes.file(name)).revision,4);
 await notes.removeFile(name,4,'user:a');assert.equal((await notes.files()).files.length,0);assert.equal((await notes.files(true)).files[0].deleted,true);
 const restored=await notes.restoreFile(name,1,5,'user:a');assert.equal(restored.revision,6);assert.equal(restored.content,original);
 assert.equal((await new Notes(notes.root).versions(name)).versions.length,6);assert.equal((await notes.file(name,2)).content,'workspace edit');
 await notes.write('.history','ordinary file');assert.equal((await notes.read('.history')).content,'ordinary file');
 assert.ok(!(await notes.list()).some(f=>f.name.startsWith('.write-')));await assert.rejects(notes.read('.write-history'),/invalid_note_(?:name|path)/);
 await notes.saveFile(name,'',6,'user:a');assert.equal((await notes.file(name)).content,'');
});

test('history refuses symlinked storage instead of reading or writing another directory',async t=>{
 const root=await directory(t),notes=new Notes(join(root,'notes')),other=join(root,'other');await notes.directory();await mkdir(other);await writeFile(join(other,'sentinel'),'unchanged');
 await symlink(other,join(notes.root,'.write-history'));await assert.rejects(notes.saveFile('a.txt','content',0),/invalid_notes_history/);
 assert.equal(await readFile(join(other,'sentinel'),'utf8'),'unchanged');
});

test('one files API preserves old notes and knowledge, allows unrestricted text and protects versions and private entries',async t=>{
 const f=await managerFixture(t),h=await harness(t,f.manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const base='/api/repositories/101/knowledge-files';
 await admin('/api/repositories/101/notes/'+encodeURIComponent('旧文件.txt'),'PUT',{content:'old note'});
 const old=await admin('/api/repositories/101/memories','POST',{key:'existing',expected_revision:0,kind:'experience',body:'existing knowledge',sources:[{reference:'original source'}],reason:'initial',catalog:{audience:'role:dev'}});
 assert.equal(old.status,201);const memory=old.value.memory;
 let list=await admin(base);assert.equal(list.status,200);assert.equal(list.value.files.length,2);
 const inherited=list.value.files.find(f=>f.id==='m:'+memory.id);assert.ok(inherited.name.endsWith('.md'));
 const large='  {\n  "raw": "'+ '界'.repeat(12000)+'"\n}\n';
 const create=await admin(base,'POST',{name:'任意格式 #?%.data',content:large});assert.equal(create.status,201,JSON.stringify(create.value));const file=create.value.file;
 assert.equal(file.content,large);assert.equal(file.revision,1);
 const endpoint=base+'/'+encodeURIComponent(file.id);
 assert.equal((await admin(endpoint,'PUT',{content:'',expected_revision:1})).value.file.revision,2);
 assert.equal((await admin(endpoint,'PUT',{content:'stale',expected_revision:1})).status,409);
 assert.equal((await admin(endpoint+'/restore','POST',{revision:1,expected_revision:2})).value.file.content,large);
 assert.equal((await admin(endpoint,'DELETE',{expected_revision:3})).value.file.deleted,true);
 assert.equal((await admin(endpoint+'/restore','POST',{revision:1,expected_revision:4})).value.file.revision,5);
 assert.equal((await admin(endpoint+'/versions')).value.versions.length,5);
 assert.equal((await admin(base+'/m:'+memory.id,'PUT',{content:large,expected_revision:1})).value.file.content,large);
 assert.equal((await admin(base+'/m:'+memory.id,'PUT',{content:large,expected_revision:2})).value.file.revision,2);
 assert.equal((await admin(base+'/m:'+memory.id,'DELETE',{expected_revision:2})).value.file.deleted,true);
 const revived=await admin(base+'/m:'+memory.id,'PUT',{content:'',expected_revision:3});assert.equal(revived.value.file.deleted,false);assert.equal(revived.value.file.content,'');
 assert.equal((await admin('/api/repositories/101/memories/'+memory.id+'?revision=1')).value.memory.body,'existing knowledge');
 assert.equal((await admin('/api/repositories/101/memories/'+memory.id)).value.memory.catalog.audience,'role:dev');
 const actor=knowledgeActor(h.store,'reader','101',['tasks.read','knowledge.read']),user={id:actor.principal_id,role:'project_admin',repositories:['101'],context:actor};
 const visible=await knowledgeFilesApi(h.store,f.manager,user,'GET',new URL('http://local'+base),{});
 assert.ok(!visible.files.some(f=>f.id==='m:'+memory.id));
 await assert.rejects(knowledgeFilesApi(h.store,f.manager,user,'GET',new URL('http://local'+base+'/m:'+memory.id),{}),/memory_not_found/);
 await assert.rejects(knowledgeFilesApi(h.store,f.manager,user,'PUT',new URL('http://local'+endpoint),{content:'no',expected_revision:5}),/capability_forbidden/);
 const manager={async call(){invalidate(h.store,actor.principal_id,'fixture revoke');return {content:'must not escape'};}};
 await assert.rejects(knowledgeFilesApi(h.store,manager,user,'GET',new URL('http://local'+endpoint),{}),/authorization_changed/);
 const stranger=h.client();const login=await admin('/api/users','POST',{username:'other-project',password:'fixture-password-12345',repository_ids:[]});assert.equal(login.status,201);
 await stranger('/api/auth/login','POST',{username:'other-project',password:'fixture-password-12345'});assert.equal((await stranger(base)).status,403);
});


test('the manager HTTP file protocol preserves revisions and returns a real conflict response',async t=>{
 const f=await managerFixture(t),token=randomBytes(32),{server,recovered}=createManagerServer({projects:f.projects,token});await recovered;
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const client=new ManagerClient('http://127.0.0.1:'+server.address().port,token),path='/v1/projects/101/files/'+encodeURIComponent('http #?%.txt');
 const one=await client.call('PUT',path,{content:'raw\ncontent',expected_revision:0,actor:'user:http'});assert.equal(one.revision,1);
 await assert.rejects(client.call('PUT',path,{content:'stale',expected_revision:0}),e=>e.status===409&&e.code==='note_revision_changed');
 assert.equal((await client.call('GET',path+'?revision=1')).content,'raw\ncontent');assert.equal((await client.call('GET',path+'/versions')).versions[0].actor,'user:http');
 await client.call('DELETE',path,{expected_revision:1});const restored=await client.call('POST',path+'/restore',{expected_revision:2,revision:1});assert.equal(restored.revision,3);assert.equal(restored.content,'raw\ncontent');
});


test('a complete file written before a stopped history commit is recovered without losing prior versions',async t=>{
 const root=await directory(t),notes=new Notes(join(root,'notes'));await notes.saveFile('recovered.txt','before',0,'user:a');
 const atomic=notes.atomic.bind(notes);notes.atomic=async(path,content,check)=>{if(path.endsWith('.json'))throw Object.assign(new Error('interrupted history'),{code:'EIO'});return atomic(path,content,check);};
 await assert.rejects(notes.saveFile('recovered.txt','after',1,'user:a'),/interrupted history/);
 const reopened=new Notes(notes.root),file=await reopened.file('recovered.txt');assert.equal(file.content,'after');assert.equal(file.revision,2);assert.equal((await reopened.file('recovered.txt',1)).content,'before');
});

test('directory HTTP API keeps stable ids, legacy aliases, exact history and empty folders through move and restore',async t=>{
 const f=await managerFixture(t),h=await harness(t,f.manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const base='/api/repositories/101/knowledge-files',dirs='/api/repositories/101/knowledge-directories';
 await admin('/api/repositories/101/notes/old.txt','PUT',{content:'old bytes\n'});
 const original=(await admin(base)).value.files[0],endpoint=base+'/'+encodeURIComponent(original.id);assert.match(original.id,/^n:/);
 assert.equal((await admin(dirs,'POST',{path:'docs'})).status,201);assert.equal((await admin(dirs,'POST',{path:'docs/empty'})).status,201);
 const empty=await admin(base+'?directory=docs%2Fempty');assert.deepEqual(empty.value.files,[]);assert.ok(empty.value.directories.includes('docs/empty'));assert.equal(empty.value.can_write,true);
 const moved=await admin(endpoint+'/move','POST',{path:'docs/renamed.txt',expected_revision:1});assert.equal(moved.status,201,JSON.stringify(moved.value));assert.equal(moved.value.file.id,original.id);assert.equal(moved.value.file.revision,2);
 assert.equal((await admin(endpoint+'?revision=1')).value.file.content,'old bytes\n');assert.equal((await admin(endpoint)).value.file.path,'docs/renamed.txt');
 const newFile=await admin(base,'POST',{path:'old.txt',content:'new identity'});assert.equal(newFile.status,201);assert.notEqual(newFile.value.file.id,original.id);assert.equal((await admin(endpoint)).value.file.content,'old bytes\n');
 const nested=await admin(base+'?directory=docs');assert.deepEqual(nested.value.files.map(file=>file.id),[original.id]);
 assert.equal((await admin(base+'?query=renamed')).value.files[0].path,'docs/renamed.txt');
 assert.equal((await admin(endpoint+'/move','POST',{path:'old.txt',expected_revision:2})).status,409);
 assert.equal((await admin(endpoint,'PUT',{content:'stale',expected_revision:1})).status,409);
 assert.equal((await admin(endpoint,'DELETE',{expected_revision:2})).value.file.revision,3);
 assert.equal((await admin(dirs,'DELETE',{path:'docs/empty'})).status,200);assert.equal((await admin(dirs,'DELETE',{path:'docs'})).status,200);
 assert.equal((await admin(base+'?deleted_only=1')).value.files[0].id,original.id);
 const restored=await admin(endpoint+'/restore','POST',{revision:1,expected_revision:3});assert.equal(restored.value.file.revision,4);assert.equal(restored.value.file.content,'old bytes\n');
 assert.ok((await admin(base)).value.directories.includes('docs'));
 assert.equal((await admin(endpoint+'/versions')).value.versions.length,4);
 for(const path of ['../escape','/absolute','C:/absolute','docs//bad','docs/../escape','docs/\\bad','.git/entry','.write-history/file-tree.json'])assert.equal((await admin(dirs,'POST',{path})).status,400,path);
 assert.equal((await admin(dirs,'DELETE',{path:''})).status,400);
 const actor=knowledgeActor(h.store,'tree-reader','101',['tasks.read','knowledge.read']),user={id:actor.principal_id,role:'project_admin',repositories:['101'],context:actor};
 const result=await knowledgeFilesApi(h.store,f.manager,user,'GET',new URL('http://local'+base+'?directory=docs'),{});assert.equal(result.can_write,false);assert.equal(result.files[0].readonly,true);assert.equal(result.files[0].can_move,false);
 await assert.rejects(knowledgeFilesApi(h.store,f.manager,user,'POST',new URL('http://local'+dirs),{path:'forbidden'}),/capability_forbidden/);
 await assert.rejects(knowledgeFilesApi(h.store,f.manager,user,'GET',new URL('http://local/api/repositories/202/knowledge-files'),{}),/repository_forbidden/);
});

test('new manager HTTP routes accept encoded stable ids and serialize real conflict errors',async t=>{
 const f=await managerFixture(t),token=randomBytes(32),{server,recovered}=createManagerServer({projects:f.projects,token});await recovered;
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const client=new ManagerClient('http://127.0.0.1:'+server.address().port,token),base='/v1/projects/101/file-tree';
 await client.call('POST',base+'/directories',{path:'目录 #?%'});
 const one=await client.call('POST',base,{path:'目录 #?%/文件.txt',content:'raw\ncontent',actor:'user:http'}),path=base+'/'+encodeURIComponent(one.id);assert.match(one.id,/^f:/);
 assert.equal((await client.call('GET',base+'?directory='+encodeURIComponent('目录 #?%'))).files[0].id,one.id);
 assert.equal((await client.call('POST',path+'/move',{path:'renamed.txt',expected_revision:1})).revision,2);
 await assert.rejects(client.call('PUT',path,{content:'stale',expected_revision:1}),e=>e.status===409&&e.code==='note_revision_changed');
 assert.equal((await client.call('GET',path+'?revision=1')).content,'raw\ncontent');assert.equal((await client.call('GET',path+'/versions')).versions[0].operation,'move');
 await assert.rejects(client.call('POST',base+'/directories',{path:'/absolute'}),e=>e.status===400&&e.code==='invalid_note_path');
});

test('repository-backed legacy files cannot be edited, moved, deleted or restored through the file adapter',async t=>{
 const {ProjectMemory}=await import('../dist/memory/project.js');const f=await managerFixture(t),h=await harness(t,f.manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const actor=knowledgeActor(h.store,'repo-owner','101'),user={id:actor.principal_id,role:'project_admin',repositories:['101'],context:actor},memory=new ProjectMemory(h.store,{actor});
 const file=memory.save('101','repo-file',{kind:'experience',body:'original',sources:[{reference:'source'}]},0,'user:repo-owner','seed');
 const doc={path:'docs/source.md',commit:'a'.repeat(40),blob_sha:'b'.repeat(40),pr_number:1,merged:true,default_base:true};memory.linkDocument('101',file.id,1,doc,'user:repo-owner');
 const base='http://local/api/repositories/101/knowledge-files',id='m:'+file.id,list=await knowledgeFilesApi(h.store,f.manager,user,'GET',new URL(base),{}),summary=list.files.find(row=>row.id===id);
 assert.equal(summary.source,'repository');assert.equal(summary.readonly,true);assert.equal(summary.can_edit,false);assert.equal(summary.can_move,false);
 for(const [method,suffix,input] of [['PUT','',{content:'overwrite',expected_revision:2}],['DELETE','',{expected_revision:2}],['POST','/restore',{revision:1,expected_revision:2}],['POST','/move',{path:'moved.md',expected_revision:2}]])await assert.rejects(knowledgeFilesApi(h.store,f.manager,user,method,new URL(base+'/'+id+suffix),input),/memory_repository_authority/);
 assert.equal(memory.get('101',file.id).revision,2);assert.equal(memory.get('101',file.id).authority,'repository');assert.notEqual(memory.get('101',file.id).status,'archived');
});

test('a file name or a moved path carrying a control character is refused by the files API',async t=>{
 const f=await managerFixture(t),h=await harness(t,f.manager),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
 const base='/api/repositories/101/knowledge-files',dirs='/api/repositories/101/knowledge-directories';
 // A name is one component, so it reports the name's own code; the console can then say the name is wrong.
 for(const name of ['ctl\u0001name.txt','tab\tname.txt','new\nline.txt','del\x7fname.txt','line\u2028sep.txt']){
   const created=await admin(base,'POST',{name,content:'x'});assert.deepEqual([created.status,created.value.error],[400,'invalid_note_name'],JSON.stringify(name)); }
 const ok=(await admin(base,'POST',{name:'ok.txt',content:'one'})).value.file;
 for(const path of ['renamed\u0001.txt','new\nline.txt','del\x7f.txt']){
   const moved=await admin(base+'/'+encodeURIComponent(ok.id)+'/move','POST',{path,expected_revision:1});assert.deepEqual([moved.status,moved.value.error],[400,'invalid_note_path'],JSON.stringify(path)); }
 const badDir=await admin(dirs,'POST',{path:'docs\u0001'}),badList=await admin(base+'?directory='+encodeURIComponent('docs\u0001'));
 assert.deepEqual([badDir.status,badList.status],[400,400]);
 assert.equal((await admin(base+'/'+encodeURIComponent(ok.id))).value.file.content,'one');
});
