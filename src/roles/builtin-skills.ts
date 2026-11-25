import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

/**
 * Skills shipped with the bot under skills/<id>/. A bundle is its SKILL.md, SOURCES.json and the Markdown under
 * references/; LICENSE stays in the repository and image. Contents are read when used, so an image always serves its own.
 */
export interface BuiltinSkillFile { path:string; content:string; sha256:string; bytes:number }
export interface BuiltinSkillDirectoryFile {
  path: string;
  data: Buffer;
  executable: boolean;
}
const defaultRoot=new URL('../../skills/',import.meta.url);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const BUILTIN_SKILL_ID_PATTERN=/^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function builtinSkillsRoot(overrideDir?: string | URL):URL{
  if(overrideDir instanceof URL)return overrideDir;
  const override=(typeof overrideDir==='string'?overrideDir:process.env.BOT_SKILLS_DIR)?.trim();
  if(override){
    const abs=resolve(override);
    return pathToFileURL(abs.endsWith('/')?abs:abs+'/');
  }
  return defaultRoot;
}

export function builtinSkillsRootPath(overrideDir?: string | URL):string{
  return fileURLToPath(builtinSkillsRoot(overrideDir));
}

/** Lists valid built-in skill directory slugs under the built-in skills root (ignoring symlinks and non-skill dirs). */
export function listBuiltinSkillSlugs(overrideDir?: string | URL):string[]{
  const rootDir=builtinSkillsRootPath(overrideDir);
  if(!existsSync(rootDir))return [];
  const rootInfo=lstatSync(rootDir);
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())return [];
  const slugs:string[]=[];
  for(const entry of readdirSync(rootDir,{withFileTypes:true})){
    if(entry.isSymbolicLink()||!entry.isDirectory())continue;
    if(!BUILTIN_SKILL_ID_PATTERN.test(entry.name))continue;
    const skillMd=join(rootDir,entry.name,'SKILL.md');
    try{
      const stat=lstatSync(skillMd);
      if(stat.isSymbolicLink()||!stat.isFile())continue;
      slugs.push(entry.name);
    }catch{
      continue;
    }
  }
  return slugs.sort((a,b)=>(a<b?-1:a>b?1:0));
}

/**
 * Recursively reads every regular file in a built-in skill directory (`SKILL.md`, `SOURCES.json`, `LICENSE`,
 * `references/**`, `scripts/**`, `assets/**`, etc.). Strictly rejects symlinks, non-regular files and path traversal.
 */
export function readBuiltinSkillDirectory(id:string,overrideDir?: string | URL):BuiltinSkillDirectoryFile[]{
  if(!BUILTIN_SKILL_ID_PATTERN.test(id))throw new Error('invalid_builtin_skill_id');
  const rootDir=builtinSkillsRootPath(overrideDir);
  const skillDir=join(rootDir,id);
  const dirStat=lstatSync(skillDir);
  if(dirStat.isSymbolicLink()||!dirStat.isDirectory())throw new Error('invalid_builtin_skill_dir');
  const files:BuiltinSkillDirectoryFile[]=[];
  const walk=(currentDir:string,prefix:string)=>{
    for(const entry of readdirSync(currentDir,{withFileTypes:true})){
      if(!entry.name||entry.name==='.'||entry.name==='..'||entry.name.includes('/')||entry.name.includes('\\'))throw new Error('invalid_skill_file');
      const full=join(currentDir,entry.name);
      const stat=lstatSync(full);
      if(stat.isSymbolicLink())throw new Error('invalid_skill_file');
      const rel=prefix?`${prefix}/${entry.name}`:entry.name;
      if(stat.isDirectory()){
        walk(full,rel);
      }else if(stat.isFile()){
        files.push({path:rel,data:readFileSync(full),executable:Boolean(stat.mode&0o111)});
      }else{
        throw new Error('invalid_skill_file');
      }
    }
  };
  walk(skillDir,'');
  return files.sort((a,b)=>(a.path<b.path?-1:a.path>b.path?1:0));
}

export function builtinSkillFiles(id:string):BuiltinSkillFile[]{
  if(!BUILTIN_SKILL_ID_PATTERN.test(id))throw new Error('invalid_builtin_skill_id');
  const dir=new URL(id+'/',builtinSkillsRoot()),references=new URL('references/',dir);
  const names=['SKILL.md','SOURCES.json',...(existsSync(references)?readdirSync(references).filter(name=>name.endsWith('.md')).sort().map(name=>'references/'+name):[])];
  return names.map(path=>{const content=readFileSync(new URL(path,dir),'utf8');return {path,content,sha256:hash(content),bytes:Buffer.byteLength(content)};});
}

/** The front matter's name and description, which is what an agent sees before it decides to read a skill. */
export function builtinSkillSummary(id:string):{name:string;description:string}{
  if(!BUILTIN_SKILL_ID_PATTERN.test(id))throw new Error('invalid_builtin_skill_id');
  const text=readFileSync(new URL(id+'/SKILL.md',builtinSkillsRoot()),'utf8'),head=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]??'';
  const field=(key:string)=>new RegExp('^'+key+':\\s*(.+)$','m').exec(head)?.[1]?.trim()??'';
  return {name:field('name')||id,description:field('description')};
}
