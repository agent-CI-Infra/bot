import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notes } from '../runner/notes.mjs';
import { FileTree } from '../manager/file-tree.mjs';

async function fixture(t) {
  const base=await mkdtemp(join(tmpdir(),'file-tree-')),root=join(base,'notes'),other=join(base,'other');
  await mkdir(root);await mkdir(other);await writeFile(join(other,'sentinel'),'outside');
  t.after(()=>rm(base,{recursive:true,force:true}));return {root,other,tree:new FileTree(root)};
}
const legacy=name=>'n:'+Buffer.from(name).toString('base64url');

test('empty directories are real and persistent while nested files keep opaque identities and exact versions',async t=>{
  const {root,tree}=await fixture(t);await tree.createDirectory('guides');await tree.createDirectory('guides/empty');
  assert.deepEqual((await new FileTree(root).list()).directories,['','guides','guides/empty']);
  const file=await tree.create('guides/自由 #?%.txt','one\n','user:a');assert.match(file.id,/^f:/);assert.equal(file.path,'guides/自由 #?%.txt');
  assert.equal((await tree.list()).files.length,0);const nested=await tree.list({directory:'guides'});assert.equal(nested.files[0].id,file.id);
  assert.equal(await readFile(join(root,file.path),'utf8'),'one\n');assert.equal((await new FileTree(root).read(file.id)).content,'one\n');
  const saved=await tree.save(file.id,'two\n',1,'user:b');assert.equal(saved.revision,2);assert.equal((await tree.read(file.id,1)).content,'one\n');
  assert.equal((await tree.versions(file.id)).versions.length,2);
  assert.equal((await tree.list({directory:'guides/empty'})).files.length,0);
});

test('legacy root names keep n: identities and history, and a newly created root file has a compatible alias',async t=>{
  const {root,tree}=await fixture(t),notes=new Notes(root);await notes.write('old.txt','old one');await notes.write('old.txt','old two');
  const list=await tree.list();assert.equal(list.files[0].id,legacy('old.txt'));assert.equal((await tree.read(legacy('old.txt'),1)).content,'old one');
  const fresh=await tree.create('new.txt','new');assert.equal((await tree.read(legacy('new.txt'))).id,fresh.id);
  await tree.createDirectory('folder');assert.equal((await notes.list()).length,2);
  const searched=await tree.list({directory:'folder',query:'old'});assert.equal(searched.search_scope,'all_directories');assert.equal(searched.files[0].path,'old.txt');
});

test('revision conflicts, deletion and restore preserve all prior content and do not replace another path',async t=>{
  const {tree}=await fixture(t),file=await tree.create('a.md','one');await tree.save(file.id,'two',1);
  await assert.rejects(tree.save(file.id,'stale',1),/note_revision_changed/);assert.equal((await tree.read(file.id)).content,'two');
  await tree.delete(file.id,2);assert.equal((await tree.list()).files.length,0);assert.equal((await tree.list({includeDeleted:true})).files[0].id,file.id);
  await assert.rejects(tree.create('a.md','replacement'),/note_path_conflict/);
  const restored=await tree.restore(file.id,1,3);assert.equal(restored.revision,4);assert.equal(restored.content,'one');assert.equal((await tree.versions(file.id)).versions.length,4);
});

test('independent managers serialize creates and expected-revision saves on the same volume',async t=>{
  const {root,tree}=await fixture(t),other=new FileTree(root);
  const creates=await Promise.allSettled([tree.create('same.txt','one'),other.create('same.txt','two')]);assert.equal(creates.filter(r=>r.status==='fulfilled').length,1);
  const file=creates.find(r=>r.status==='fulfilled').value;
  const saves=await Promise.allSettled([tree.save(file.id,'first',1),other.save(file.id,'second',1)]);assert.equal(saves.filter(r=>r.status==='fulfilled').length,1);
  assert.match(saves.find(r=>r.status==='rejected').reason.message,/note_revision_changed/);assert.equal((await tree.read(file.id)).revision,2);
});

test('traversal, internal paths, unsafe ids and symlinked directories never access another tree',async t=>{
  const {root,other,tree}=await fixture(t);
  for(const path of ['../other/a','/absolute','C:/absolute','a/../../b','.write-history/a','a/.git/b'])assert.throws(()=>tree.createDirectory(path),/invalid_note_path/);
  await assert.rejects(tree.read(legacy('../outside')),/invalid_note_id/);
  await symlink(other,join(root,'redirect'));assert.deepEqual((await tree.list()).files,[]);
  await assert.rejects(tree.create('redirect/file','no'),/directory_not_found|invalid_note_path/);assert.equal(await readFile(join(other,'sentinel'),'utf8'),'outside');
});

test('invalid creation data does not reserve a filename, and an interrupted create remains retryable',async t=>{
  const {root,tree}=await fixture(t);assert.throws(()=>tree.create('a.txt',null),/invalid_note_content/);assert.equal((await tree.list()).files.length,0);
  const original=tree.notes.bind(tree);let interrupt=true;
  tree.notes=(directory,check,run)=>original(directory,check,notes=>{const save=notes.saveFile.bind(notes);notes.saveFile=async(...args)=>{if(interrupt){interrupt=false;throw new Error('interrupted create');}return save(...args);};return run(notes);});
  await assert.rejects(tree.create('a.txt','one'),/interrupted create/);
  const recovered=await new FileTree(root).create('a.txt','one');assert.equal(recovered.content,'one');assert.equal(recovered.revision,1);
});

test('a pre-catalog root file keeps its n: identity and every old version after moving and reusing its name',async t=>{
  const {root,tree}=await fixture(t),name='legacy.txt';
  const {createHash}=await import('node:crypto'),sha=value=>createHash('sha256').update(value).digest('hex');
  await mkdir(join(root,'.write-history/blobs'),{recursive:true});
  const versions=[];for(const [i,content]of ['old one','old two'].entries()){
    await writeFile(join(root,'.write-history/blobs',sha(content)),content);
    versions.push({revision:i+1,created_at:`2020-01-0${i+1}T00:00:00Z`,actor:'legacy-user',deleted:false,sha256:sha(content),bytes:content.length});
  }
  await writeFile(join(root,name),'old two');await writeFile(join(root,'.write-history',sha(name)+'.json'),JSON.stringify({schema:1,name,versions}));
  const before=(await tree.list()).files[0];assert.equal(before.id,legacy(name));assert.equal(before.revision,2);
  await tree.createDirectory('docs');const moved=await tree.move(before.id,'docs/renamed.txt',2,'user:mover');
  assert.equal(moved.id,before.id);assert.equal(moved.revision,3);assert.equal((await tree.read(before.id,1)).content,'old one');
  assert.equal((await tree.versions(before.id)).versions.at(-1).created_at,versions[0].created_at);
  await assert.rejects(new Notes(root).read(name),{code:'ENOENT'});assert.equal((await tree.list()).files.length,0);
  const replacement=await tree.create(name,'different file');assert.notEqual(replacement.id,before.id);assert.equal(replacement.revision,1);
  await new Notes(root).write(name,'different file updated');
  assert.equal((await tree.read(before.id)).path,'docs/renamed.txt');assert.equal((await tree.read(before.id)).content,'old two');
  assert.equal((await tree.versions(before.id)).versions.length,3);assert.equal((await tree.versions(replacement.id)).versions.length,2);
});

test('a completed filesystem move recovers its stable path and records the move exactly once',async t=>{
  const {root,tree}=await fixture(t);await tree.createDirectory('docs');const file=await tree.create('a.txt','one');
  const original=tree.notes.bind(tree);let interrupt=true;
  tree.notes=(directory,check,run)=>original(directory,check,notes=>{
    const atomic=notes.atomic.bind(notes);notes.atomic=async(path,content,lease)=>{
      if(interrupt&&path.endsWith('/file-tree.json')){const value=JSON.parse(content);if(value.pending&&value.files.find(row=>row.id===file.id)?.path==='docs/b.txt'){interrupt=false;throw new Error('interrupted path commit');}}
      return atomic(path,content,lease);
    };return run(notes);
  });
  await assert.rejects(tree.move(file.id,'docs/b.txt',1,'user:a'),/interrupted path commit/);
  assert.equal(await readFile(join(root,'docs/b.txt'),'utf8'),'one');
  assert.equal((await new Notes(root).read('docs/b.txt')).content,'one');
  const reopened=new FileTree(root);assert.equal((await reopened.read(file.id)).path,'docs/b.txt');assert.equal((await reopened.read(file.id)).revision,2);
  assert.equal((await reopened.versions(file.id)).versions.filter(version=>version.operation==='move').length,1);
});

test('a committed move version is not repeated when clearing the pending marker fails',async t=>{
  const {root,tree}=await fixture(t),file=await tree.create('a.txt','one');const original=tree.notes.bind(tree);let interrupt=true;
  tree.notes=(directory,check,run)=>original(directory,check,notes=>{
    const atomic=notes.atomic.bind(notes);notes.atomic=async(path,content,lease)=>{
      if(interrupt&&path.endsWith('/file-tree.json')){const value=JSON.parse(content);if(!value.pending&&value.files.find(row=>row.id===file.id)?.path==='b.txt'){interrupt=false;throw new Error('interrupted pending clear');}}
      return atomic(path,content,lease);
    };return run(notes);
  });
  await assert.rejects(tree.move(file.id,'b.txt',1,'user:a'),/interrupted pending clear/);
  const reopened=new FileTree(root);assert.equal((await reopened.read(file.id)).revision,2);assert.equal((await reopened.versions(file.id)).versions.length,2);
});

test('move conflicts and missing destination directories leave both files and the catalog usable',async t=>{
  const {tree}=await fixture(t),a=await tree.create('a','A'),b=await tree.create('b','B');
  await assert.rejects(tree.move(a.id,'b',1),/note_path_conflict/);
  await assert.rejects(tree.move(a.id,'missing/a',1),/directory_not_found/);
  await assert.rejects(tree.move(a.id,'new',0),/note_revision_changed/);
  assert.equal((await tree.read(a.id)).content,'A');assert.equal((await tree.read(b.id)).content,'B');
});

test('deleted files remain globally discoverable after deleting an empty folder and restore recreates that folder',async t=>{
  const {tree}=await fixture(t);await tree.createDirectory('docs');const file=await tree.create('docs/a.txt','one');
  await assert.rejects(tree.deleteDirectory('docs'),/directory_not_empty/);
  await tree.delete(file.id,1);await tree.deleteDirectory('docs');
  assert.ok(!(await tree.list()).directories.includes('docs'));
  const trash=await tree.list({deletedOnly:true});assert.equal(trash.files[0].id,file.id);assert.equal((await tree.read(file.id,1)).content,'one');
  const restored=await tree.restore(file.id,1,2,'user:a');assert.equal(restored.revision,3);assert.equal(restored.content,'one');
  assert.ok((await tree.list()).directories.includes('docs'));
});

test('unsupported binary bytes stay exact, list beside text files, and cannot be silently decoded by editing',async t=>{
  const {root,tree}=await fixture(t),raw=Buffer.from([0,255,254,10,65]);await writeFile(join(root,'binary.data'),raw);
  await tree.create('readme.md','# text');const list=await tree.list(),binary=list.files.find(file=>file.name==='binary.data');assert.equal(list.files.length,2);assert.equal(binary.can_edit,false);
  const first=await tree.read(binary.id);assert.equal(first.content,null);assert.equal(first.availability,'unsupported_format');assert.deepEqual(Buffer.from(first.download_base64,'base64'),raw);
  await assert.rejects(tree.save(binary.id,'lossy replacement',1,'user:a'),/unsupported_note_format/);
  assert.deepEqual(await readFile(join(root,'binary.data')),raw);
  await tree.delete(binary.id,1,'user:a');const restored=await tree.restore(binary.id,1,2,'user:a');assert.equal(restored.revision,3);assert.deepEqual(Buffer.from(restored.download_base64,'base64'),raw);assert.deepEqual(await readFile(join(root,'binary.data')),raw);
});

test('explicit restore creates a new revision even when the chosen historical content equals the current bytes',async t=>{
  const {tree}=await fixture(t),file=await tree.create('a.txt','same');await tree.move(file.id,'b.txt',1,'user:a');
  const restored=await tree.restore(file.id,1,2,'user:b');assert.equal(restored.revision,3);assert.equal(restored.content,'same');
  const latest=(await tree.versions(file.id)).versions[0];assert.equal(latest.operation,'restore');assert.equal(latest.restored_from,1);assert.equal(latest.actor,'user:b');
});

test('a directory cannot reserve the catalog path of a deleted file and unrelated operations remain available',async t=>{
  const {tree}=await fixture(t),file=await tree.create('a.txt','one');await tree.delete(file.id,1);
  await assert.rejects(tree.createDirectory('a.txt'),error=>error.message==='note_path_conflict'&&error.status===409);
  const other=await tree.create('b.txt','other');assert.equal((await tree.read(other.id)).content,'other');
  assert.equal((await tree.list({deletedOnly:true})).files[0].id,file.id);assert.equal((await tree.restore(file.id,1,2)).content,'one');
});

test('external directories and symlinks at catalog paths cannot block other files or fabricate deletion history',async t=>{
  const {root,other,tree}=await fixture(t),file=await tree.create('a.txt','one'),healthy=await tree.create('b.txt','other');
  await tree.delete(file.id,1);const catalog=JSON.parse(await readFile(join(root,'.write-history/file-tree.json'),'utf8')),row=catalog.files.find(row=>row.id===file.id);
  const history=join(root,'.write-history',row.history_key+'.json'),before=await readFile(history,'utf8');
  await mkdir(join(root,'a.txt'));assert.deepEqual((await tree.list({includeDeleted:true})).files.map(row=>row.id),[healthy.id]);
  assert.equal((await tree.read(healthy.id)).content,'other');await assert.rejects(tree.read(file.id),/invalid_note_file/);await tree.deleteDirectory('a.txt');
  assert.equal((await tree.restore(file.id,1,2)).revision,3);await rm(join(root,'a.txt'));await symlink(join(other,'sentinel'),join(root,'a.txt'));
  assert.deepEqual((await tree.list()).files.map(row=>row.id),[healthy.id]);await assert.rejects(tree.save(file.id,'replace',3),/invalid_note_file/);
  const versions=JSON.parse(await readFile(history,'utf8')).versions;assert.equal(versions.length,3);assert.equal(versions.at(-1).deleted,false);assert.equal(JSON.parse(before).versions.length,2);
  assert.equal(await readFile(join(other,'sentinel'),'utf8'),'outside');await rm(join(root,'a.txt'));await tree.restore(file.id,1,4);
  assert.equal((await tree.list()).files.length,2);
});

test('an uncertain move journal stays intact and fail-closed across manager and task entry points',async t=>{
  const {root,tree}=await fixture(t),file=await tree.create('a.txt','one');await tree.create('b.txt','other');
  const path=join(root,'.write-history/file-tree.json'),catalog=JSON.parse(await readFile(path,'utf8'));
  catalog.pending={operation_id:'1'.repeat(24),file_id:file.id,from:'a.txt',to:'moved.txt',actor:'user:a',deleted:false,source:{dev:'0',ino:'0'}};
  await rm(join(root,'a.txt'));await writeFile(join(root,'moved.txt'),'unknown replacement');await writeFile(path,JSON.stringify(catalog));
  const before=await readFile(path,'utf8');for(const operation of [()=>tree.list(),()=>new Notes(root).files(),()=>new Notes(root).read('b.txt')])await assert.rejects(operation(),/note_move_uncertain/);
  assert.equal(await readFile(path,'utf8'),before);assert.equal(await readFile(join(root,'moved.txt'),'utf8'),'unknown replacement');
});

test('a control character in a name is refused for create, rename and move instead of reaching the filesystem',async t=>{
  const {root,tree}=await fixture(t),names=['ctl\u0001name.txt','tab\tname.txt','new\nline.txt','del\x7fname.txt','line\u2028sep.txt'];
  for(const name of names)assert.throws(()=>tree.create(name,'x'),/invalid_note_path/,JSON.stringify(name));
  await tree.createDirectory('guides');
  for(const name of names)assert.throws(()=>tree.create('guides/'+name,'x'),/invalid_note_path/,JSON.stringify(name));
  for(const name of names)assert.throws(()=>tree.createDirectory(name),/invalid_note_path/,JSON.stringify(name));
  const file=await tree.create('ok.txt','one');
  for(const name of names)assert.throws(()=>tree.move(file.id,name,1),/invalid_note_path/,JSON.stringify(name));
  // A refused rename leaves the file where it was, with its content and revision untouched.
  assert.equal((await tree.read(file.id)).content,'one');assert.equal((await tree.read(file.id)).revision,1);
  assert.deepEqual((await tree.list()).files.map(row=>row.path),['ok.txt']);
});
