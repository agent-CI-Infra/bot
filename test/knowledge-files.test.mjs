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
 assert.ok(!(await notes.list()).some(f=>f.name.startsWith('.write-')));await assert.rejects(notes.read('.write-history'),/invalid_note_name/);
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
