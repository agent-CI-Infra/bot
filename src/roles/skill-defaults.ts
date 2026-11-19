import {createHash} from 'node:crypto';
import type {Store} from '../storage/database.js';
import type {RoleSnapshot} from './definition.js';
import {builtinSkillFiles} from './builtin-skills.js';

type Bundle = NonNullable<RoleSnapshot['skills']>;
type File = Bundle['files'][number] & {content:string};
const hash = (value:string) => createHash('sha256').update(value).digest('hex');

/**
 * Built-in skills a role gets without a project binding. The Manager always has roadmap decomposition. In a task a project
 * administrator confirmed as a CI change (#931), the roles that plan and write the change (controller and writer kinds)
 * also get layered CI gates (#1136). Other tasks and roles keep exactly their configured bundle.
 */
export function defaultSkillIds(role:{id:string;kind:string},ciChange:boolean):string[]{
  return [...(role.id==='manager'?['roadmap-decomposition']:[]),...(ciChange&&['controller','writer'].includes(role.kind)?['layered-ci-gates']:[])];
}

/** Supplemental working material, never a role permission or a change to the task contract. */
export function roleSkills(s:Store, repositoryId:string, role:{id:string;kind:string}, configured:Bundle|null, projectFiles:File[], persist:boolean, ciChange=false):Bundle|null {
  const ids=defaultSkillIds(role,ciChange);
  if(!ids.length)return configured;
  const defaults=ids.map(id=>({id,files:builtinSkillFiles(id).map(file=>({...file,path:`defaults/${id}/${file.path}`}))}));
  // Separate roots let native loaders discover the default even when a project bundle has its own root SKILL.md.
  // Prefix all project files together so relative references within that bundle still work.
  const projectRoot=configured?.source.type==='repository'?'.agents/skills/':'';
  const files=[...defaults.flatMap(d=>d.files),...projectFiles.map(file=>({...file,path:'project/'+file.path.slice(projectRoot.length)}))].sort((a,b)=>a.path<b.path?-1:1);
  const listing=files.map(({content,...file})=>file);
  const source={type:'role_defaults',role:role.id,defaults:defaults.map(d=>({id:d.id,files:d.files.map(({content,...file})=>file)})),
    configured:configured?{id:configured.id,revision:configured.revision,content_hash:configured.content_hash,source:configured.source,path_prefix:'project/',source_path_root:projectRoot}:null};
  const content_hash=hash(JSON.stringify({source,files:listing})),id='@role-defaults/'+role.id;
  const pin=()=>{
    // Tasks can retain different project bundle versions. Reuse a matching historical composition rather than
    // minting a new revision whenever an old task and a new task alternate their role resolution.
    const existing=s.get('SELECT revision FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND content_hash=? ORDER BY revision DESC LIMIT 1',repositoryId,id,content_hash);
    if(existing)return Number(existing.revision);
    const revision=Number(s.get('SELECT max(revision) revision FROM skill_bundle_revisions WHERE repository_id=? AND id=?',repositoryId,id)?.revision??0)+1;
    if(persist)s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)',repositoryId,id,revision,JSON.stringify(source),JSON.stringify(files),content_hash,new Date().toISOString());
    return revision;
  };
  const revision=persist?s.transaction(pin):pin();
  return {id,revision,content_hash,source,files:listing};
}
