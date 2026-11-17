import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Store} from '../storage/database.js';
import type {RoleSnapshot} from './definition.js';

type Bundle = NonNullable<RoleSnapshot['skills']>;
type File = Bundle['files'][number] & {content:string};
const hash = (value:string) => createHash('sha256').update(value).digest('hex');

/** Supplemental working material, never a role permission or a change to the task contract. */
export function managerSkills(s:Store, repositoryId:string, configured:Bundle|null, projectFiles:File[], persist:boolean):Bundle {
  const defaults=['SKILL.md','SOURCES.json'].map(name=>{
    const content=readFileSync(new URL('../../skills/roadmap-decomposition/'+name,import.meta.url),'utf8');
    return {path:'defaults/roadmap-decomposition/'+name,content,sha256:hash(content),bytes:Buffer.byteLength(content)};
  });
  // Separate roots let native loaders discover the default even when a project bundle has its own root SKILL.md.
  // Prefix all project files together so relative references within that bundle still work.
  const projectRoot=configured?.source.type==='repository'?'.agents/skills/':'';
  const files=[...defaults,...projectFiles.map(file=>({...file,path:'project/'+file.path.slice(projectRoot.length)}))].sort((a,b)=>a.path<b.path?-1:1);
  const listing=files.map(({content,...file})=>file);
  const source={type:'role_defaults',role:'manager',defaults:[{id:'roadmap-decomposition',files:defaults.map(({content,...file})=>file)}],
    configured:configured?{id:configured.id,revision:configured.revision,content_hash:configured.content_hash,source:configured.source,path_prefix:'project/',source_path_root:projectRoot}:null};
  const content_hash=hash(JSON.stringify({source,files:listing})),id='@role-defaults/manager';
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
