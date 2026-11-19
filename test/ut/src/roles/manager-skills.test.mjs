import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../../../dist/storage/database.js';
import {roleConfiguration,resolveRole,saveConfiguration,skillFiles} from '../../../../dist/roles/definition.js';
import {stageSessionSkills} from '../../../../runner/session-resources.mjs';

function fixture(t){
 const s=new Store(':memory:',randomBytes(32));t.after(()=>s.close());
 s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
 s.run("INSERT INTO repositories VALUES('r','fixture/manager','o','a')");
 s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r','https://fixture.invalid/v1','fixture',?,'now')",s.secrets.seal({value:'fixture'},'model:m'));
 s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('r','m',1)");
 return s;
}
const resolve=(s,options)=>resolveRole(s,'r','manager','development.issue',options);
const source=content=>({id:'custom',source:{type:'inline',files:[{path:'SKILL.md',content:'---\nname: project\ndescription: Project conventions.\n---\n'+content},{path:'notes.txt',content:'Keep this relative reference.'}]}});
const bind=(s,bundle)=>saveConfiguration(s,'r',{expected_revision:roleConfiguration(s,'r').revision,skills:[bundle],roles:[{role_id:'manager',skill_bundle_ref:{id:bundle.id}}]},'fixture');

test('new and existing Managers receive default working material without changing configuration, permissions or prompt',t=>{
 const s=fixture(t),before=roleConfiguration(s,'r');
 const preview=resolve(s,{persist:false});
 assert.ok(preview.snapshot.skills.files.some(f=>f.path==='defaults/roadmap-decomposition/SKILL.md'));
 assert.equal(s.get('SELECT count(*) n FROM skill_bundle_revisions').n,0,'preview stores no skill revisions');
 assert.equal(s.get('SELECT count(*) n FROM role_snapshots').n,0);
 const legacy=resolve(s);assert.equal(legacy.id,preview.id);
 assert.deepEqual(legacy.definition.permissions,before.roles.find(r=>r.role_id==='manager').permissions);
 assert.ok(!legacy.system.includes('Progressive roadmap decomposition'),'body stays out of the system prompt');
 assert.deepEqual(roleConfiguration(s,'r'),before);
 const saved=saveConfiguration(s,'r',{expected_revision:0,roles:[{role_id:'manager',harness_ref:{id:'pi'}}]},'fixture');
 const stored=s.get("SELECT value FROM settings WHERE key='roles:r'").value;
 assert.equal(saved.roles.find(r=>r.role_id==='manager').skill_bundle_ref,null);
 const current=resolve(s);assert.ok(current.snapshot.skills);
 assert.equal(s.get("SELECT value FROM settings WHERE key='roles:r'").value,stored);
 assert.equal(resolveRole(s,'r','dev','development.issue').snapshot.skills,null);
});

test('project files coexist with defaults and old effective snapshots retain their pinned contents',t=>{
 const s=fixture(t),first=bind(s,source('Original project material.'));
 const customRef=first.roles.find(r=>r.role_id==='manager').skill_bundle_ref;
 const old=resolve(s),files=skillFiles(s,'r',old.snapshot.skills);
 assert.equal(files.find(f=>f.path==='project/SKILL.md').content,skillFiles(s,'r',customRef).find(f=>f.path==='SKILL.md').content);
 assert.equal(files.find(f=>f.path==='project/notes.txt').content,'Keep this relative reference.');
 assert.equal(old.snapshot.skills.source.configured.content_hash,customRef.content_hash);
 assert.equal(old.snapshot.skills.source.defaults[0].id,'roadmap-decomposition');
 bind(s,source('Updated project material.'));
 const count=s.get('SELECT count(*) n FROM skill_bundle_revisions').n;
 const preview=resolve(s,{persist:false});assert.equal(s.get('SELECT count(*) n FROM skill_bundle_revisions').n,count);
 const next=resolve(s);assert.equal(next.id,preview.id);assert.notEqual(next.id,old.id);
 assert.match(skillFiles(s,'r',next.snapshot.skills).find(f=>f.path==='project/SKILL.md').content,/Updated project material/);
 assert.match(skillFiles(s,'r',old.snapshot.skills).find(f=>f.path==='project/SKILL.md').content,/Original project material/);
 assert.equal(s.get('SELECT snapshot FROM role_snapshots WHERE id=?',old.id).snapshot,JSON.stringify(old.snapshot));
  const savedCount=s.get('SELECT count(*) n FROM skill_bundle_revisions').n;
  assert.equal(resolve(s,{configuration:first}).id,old.id,'a frozen older task reuses its exact effective snapshot');
  assert.equal(resolve(s).id,next.id,'alternating old and new tasks does not churn skill revisions');
  assert.equal(s.get('SELECT count(*) n FROM skill_bundle_revisions').n,savedCount);
 assert.deepEqual(roleConfiguration(s,'r').roles.find(r=>r.role_id==='manager').skill_bundle_ref.id,'custom');
});

test('native Pi discovers defaults beside a project root SKILL and keeps its support files',async t=>{
 const s=fixture(t);bind(s,source('Read notes.txt relative to this Skill.'));
 const root=await mkdtemp(join(tmpdir(),'manager-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {loadSkillsFromDir}=await import('../../../../runner/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js');
 await stageSessionSkills(root,skillFiles(s,'r',resolve(s).snapshot.skills));
 const loaded=loadSkillsFromDir({dir:join(root,'skills'),source:'user'});
 assert.deepEqual(loaded.skills.map(s=>s.name).sort(),['project','roadmap-decomposition']);
});

test('repository skill roots stay discoverable rather than hiding below .agents',async t=>{
 const s=fixture(t),path='.agents/skills/team/SKILL.md',content='---\nname: team\ndescription: Team guidance.\n---\nProject guidance.';
 // A repository bundle already pinned by the ordinary configuration path; a moved cache cannot change its body.
 const {createHash}=await import('node:crypto'),sha256=createHash('sha256').update(content).digest('hex');
 const files=[{path,content,sha256,bytes:Buffer.byteLength(content)}],ref={id:'repo',revision:1,content_hash:'pinned-repository-files'};
 const config=roleConfiguration(s,'r'),bundle={...ref,source:{type:'repository',commit:'a'.repeat(40),paths:[path]},files:files.map(({content,...f})=>f)};
 s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)','r',ref.id,1,JSON.stringify(bundle.source),JSON.stringify(files),ref.content_hash,'now');
 const configuration={...config,skills:[bundle],roles:config.roles.map(r=>r.role_id==='manager'?{...r,skill_bundle_ref:ref}:r)};
 const resolved=resolve(s,{configuration}),root=await mkdtemp(join(tmpdir(),'manager-repo-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await stageSessionSkills(root,skillFiles(s,'r',resolved.snapshot.skills));
 const {loadSkillsFromDir}=await import('../../../../runner/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js');
 assert.deepEqual(loadSkillsFromDir({dir:join(root,'skills'),source:'user'}).skills.map(s=>s.name).sort(),['roadmap-decomposition','team']);
 assert.equal(resolved.snapshot.skills.source.configured.source_path_root,'.agents/skills/');
});

test('a confirmed CI change gives its planning and writing roles the CI gate skill; other roles and tasks keep theirs',async t=>{
 const s=fixture(t),ci=(role,options={})=>resolveRole(s,'r',role,'development.issue',{ciChange:true,...options});
 const ordinary=resolve(s);
 const manager=ci('manager');
 assert.deepEqual(manager.snapshot.skills.source.defaults.map(d=>d.id),['roadmap-decomposition','layered-ci-gates']);
 assert.notEqual(manager.snapshot.skills.content_hash,ordinary.snapshot.skills.content_hash);
 assert.deepEqual(ordinary.snapshot.skills.source.defaults.map(d=>d.id),['roadmap-decomposition'],'other tasks keep the Manager bundle they had');
 const dev=ci('dev'),paths=dev.snapshot.skills.files.map(f=>f.path);
 assert.equal(dev.snapshot.skills.id,'@role-defaults/dev');assert.equal(dev.snapshot.skills.source.role,'dev');assert.equal(dev.snapshot.skills.source.configured,null);
 assert.ok(paths.includes('defaults/layered-ci-gates/SKILL.md')&&paths.includes('defaults/layered-ci-gates/references/layers.md'),paths.join());
 assert.match(skillFiles(s,'r',dev.snapshot.skills).find(f=>f.path==='defaults/layered-ci-gates/references/report.md').content,/# Recommendation report/);
 // Reviewing and accepting the change are not where gates are designed: observers and evaluators keep their own bundle.
 for(const role of ['reviewer','qa'])assert.equal(ci(role).snapshot.skills,null,role);
 assert.equal(resolve(s).snapshot.skills.id,'@role-defaults/manager');
 assert.equal(resolveRole(s,'r','dev','development.issue').snapshot.skills,null,'a development that may not change CI is unchanged');
 // A project's own Dev bundle stays complete beside the default, under project/.
 const config=bind(s,{...source('Project CI conventions.'),id:'dev-custom'});
 saveConfiguration(s,'r',{expected_revision:config.revision,roles:[{role_id:'dev',skill_bundle_ref:{id:'dev-custom'}}]},'fixture');
 const bound=ci('dev'),files=skillFiles(s,'r',bound.snapshot.skills);
 assert.equal(files.find(f=>f.path==='project/notes.txt').content,'Keep this relative reference.');
 assert.equal(bound.snapshot.skills.source.configured.id,'dev-custom');
 const root=await mkdtemp(join(tmpdir(),'ci-change-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {loadSkillsFromDir}=await import('../../../../runner/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js');
 await stageSessionSkills(root,files);
 const loaded=loadSkillsFromDir({dir:join(root,'skills'),source:'user'});
 assert.deepEqual(loaded.skills.map(s=>s.name).sort(),['layered-ci-gates','project']);
 assert.deepEqual(loaded.diagnostics??[],[]);
});
