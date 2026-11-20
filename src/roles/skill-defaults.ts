import {createHash} from 'node:crypto';
import type {Store} from '../storage/database.js';
import type {RoleSnapshot} from './definition.js';
import {builtinSkillFiles} from './builtin-skills.js';
import {parseSkillDescription, skillEntryPath, skillFilePath} from '../rules/service.js';

type Bundle = NonNullable<RoleSnapshot['skills']>;
type File = Bundle['files'][number] & {content:string};
const hash = (value:string) => createHash('sha256').update(value).digest('hex');

/**
 * Built-in skills a role gets without a project binding. The Manager always has roadmap decomposition. In a task a project
 * administrator confirmed as a CI change (#931), the roles that plan and write the change (controller and writer kinds)
 * also get layered CI gates (#1136). Other tasks and roles keep their configured and repository bundles.
 */
export function defaultSkillIds(role:{id:string;kind:string},ciChange:boolean):string[]{
  return [...(role.id==='manager'?['roadmap-decomposition']:[]),...(ciChange&&['controller','writer'].includes(role.kind)?['layered-ci-gates']:[])];
}

/** Extracts validated `.agents/skills/<name>/**` text files belonging to directories that declare a `SKILL.md`. */
export function extractRepositorySkillFiles(files:Record<string,string>):File[]{
  const roots=Object.keys(files).filter(skillEntryPath);
  if(!roots.length)return [];
  const dirs=roots.map(path=>path.slice(0,-'/SKILL.md'.length));
  return Object.entries(files)
    .filter(([path,content])=>skillFilePath(path)&&typeof content==='string'&&!content.includes('\0')&&dirs.some(dir=>path.startsWith(dir+'/')))
    .sort(([a],[b])=>(a<b?-1:a>b?1:0))
    .map(([path,content])=>({path,content,sha256:hash(content),bytes:Buffer.byteLength(content)}));
}

export interface PinnedRepositorySkills {
  id:string;
  revision:number;
  content_hash:string;
  sha:string|null;
}

/** Pins a task's trusted base-branch `.agents/skills/` files in `skill_bundle_revisions` without bloating `tasks.input`. */
export function pinRepositorySkillEntries(s:Store, repositoryId:string, sha:string|null, files:Record<string,string>, persist=true):PinnedRepositorySkills|null{
  const extracted=extractRepositorySkillFiles(files);
  if(!extracted.length)return null;
  const listing=extracted.map(({content,...file})=>file);
  const source={type:'repository_auto',path_root:'.agents/skills',commit:sha};
  const content_hash=hash(JSON.stringify({path_root:'.agents/skills',files:listing})),id='@repository-skills';
  const pin=()=>{
    const existing=s.get('SELECT revision FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND content_hash=? ORDER BY revision DESC LIMIT 1',repositoryId,id,content_hash);
    if(existing)return Number(existing.revision);
    const revision=Number(s.get('SELECT max(revision) revision FROM skill_bundle_revisions WHERE repository_id=? AND id=?',repositoryId,id)?.revision??0)+1;
    if(persist)s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)',repositoryId,id,revision,JSON.stringify(source),JSON.stringify(extracted),content_hash,new Date().toISOString());
    return revision;
  };
  const revision=persist?s.transaction(pin):pin();
  return {id,revision,content_hash,sha};
}

/** Resolves a skill file by exact bundle path, `.agents/skills/...` path, or unambiguous relative path. */
export function resolveSkillBundleFile<T extends {path:string}>(files:T[], rawPath:unknown):T|undefined{
  if(typeof rawPath!=='string')return undefined;
  const trimmed=rawPath.trim().replace(/^(?:\.\/)+/,'');
  if(!trimmed||trimmed.startsWith('/')||trimmed.endsWith('/')||trimmed.includes('\\')||trimmed.includes('\0'))return undefined;
  if(trimmed.split('/').some(part=>!part||part==='.'||part==='..'))return undefined;
  const exact=files.find(f=>f.path===trimmed);
  if(exact)return exact;
  const stripped=trimmed.startsWith('.agents/skills/')?trimmed.slice('.agents/skills/'.length):trimmed;
  for(const prefix of ['repository/','project/','defaults/','.agents/skills/']){
    const prefixed=files.find(f=>f.path===prefix+stripped);
    if(prefixed)return prefixed;
  }
  const suffixed=files.filter(f=>f.path.endsWith('/'+stripped));
  return suffixed.length===1?suffixed[0]:undefined;
}

export function skillSummariesFromFiles(files:{path:string;content:string}[]){
  return files
    .filter(file=>file.path==='SKILL.md'||file.path.endsWith('/SKILL.md'))
    .map(file=>{
      const dir=file.path==='SKILL.md'?'':file.path.slice(0,-'/SKILL.md'.length);
      const front=/^---\r?\n([\s\S]*?)\r?\n---/.exec(file.content)?.[1]??'';
      const declaredName=/^name:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
      const fallbackName=dir?dir.replace(/^(?:repository|project|defaults|\.agents\/skills)\//,''):'project';
      const support=files
        .filter(other=>other.path!==file.path&&(dir?other.path.startsWith(dir+'/'):!other.path.endsWith('/SKILL.md')))
        .map(other=>dir?other.path.slice(dir.length+1):other.path)
        .sort();
      return {
        name:declaredName||fallbackName,
        description:parseSkillDescription(file.content),
        path:file.path,
        ...(support.length?{support_files:support}:{}),
      };
    });
}

/** Supplemental working material, never a role permission or a change to the task contract. */
export function roleSkills(
  s:Store,
  repositoryId:string,
  role:{id:string;kind:string},
  configured:Bundle|null,
  projectFiles:File[],
  persist:boolean,
  ciChange=false,
  repositorySource?:{sha:string|null;files:Record<string,string>}|null,
):Bundle|null {
  const ids=defaultSkillIds(role,ciChange);
  const autoEligible=role.kind!=='evaluator'&&role.id!=='coordinator'&&!configured;
  const autoFiles=autoEligible&&repositorySource
    ? extractRepositorySkillFiles(repositorySource.files).map(file=>({...file,path:'repository/'+file.path.slice('.agents/skills/'.length)}))
    : [];
  if(!ids.length&&!autoFiles.length)return configured;
  const defaults=ids.map(id=>({id,files:builtinSkillFiles(id).map(file=>({...file,path:`defaults/${id}/${file.path}`}))}));
  // Separate roots let native loaders discover built-in defaults, console-configured bundles, and trusted base-branch
  // `.agents/skills/` side by side while preserving relative references inside each skill directory.
  const projectRoot=configured?.source.type==='repository'?'.agents/skills/':'';
  const files=[
    ...defaults.flatMap(d=>d.files),
    ...projectFiles.map(file=>({...file,path:'project/'+file.path.slice(projectRoot.length)})),
    ...autoFiles,
  ].sort((a,b)=>a.path<b.path?-1:1);
  const listing=files.map(({content,...file})=>file);
  const source={
    type:'role_defaults',
    role:role.id,
    defaults:defaults.map(d=>({id:d.id,files:d.files.map(({content,...file})=>file)})),
    configured:configured?{id:configured.id,revision:configured.revision,content_hash:configured.content_hash,source:configured.source,path_prefix:'project/',source_path_root:projectRoot}:null,
    ...(autoFiles.length?{repository:{commit:repositorySource?.sha??null,path_prefix:'repository/',source_path_root:'.agents/skills/'}}:{}),
  };
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
