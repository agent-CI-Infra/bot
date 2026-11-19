import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';

/**
 * Skills shipped with the bot under skills/<id>/. A bundle is its SKILL.md, SOURCES.json and the Markdown under
 * references/; LICENSE stays in the repository and image. Contents are read when used, so an image always serves its own.
 */
export interface BuiltinSkillFile { path:string; content:string; sha256:string; bytes:number }
const root=new URL('../../skills/',import.meta.url);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export function builtinSkillFiles(id:string):BuiltinSkillFile[]{
  const dir=new URL(id+'/',root),references=new URL('references/',dir);
  const names=['SKILL.md','SOURCES.json',...(existsSync(references)?readdirSync(references).filter(name=>name.endsWith('.md')).sort().map(name=>'references/'+name):[])];
  return names.map(path=>{const content=readFileSync(new URL(path,dir),'utf8');return {path,content,sha256:hash(content),bytes:Buffer.byteLength(content)};});
}

/** The front matter's name and description, which is what an agent sees before it decides to read a skill. */
export function builtinSkillSummary(id:string):{name:string;description:string}{
  const text=readFileSync(new URL(id+'/SKILL.md',root),'utf8'),head=/^---\n([\s\S]*?)\n---/.exec(text)?.[1]??'';
  const field=(key:string)=>new RegExp('^'+key+':\\s*(.+)$','m').exec(head)?.[1]?.trim()??'';
  return {name:field('name')||id,description:field('description')};
}
