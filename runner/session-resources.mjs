import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';

function ensureSkillFrontmatter(path,content){
  if(path!=='SKILL.md'&&!path.endsWith('/SKILL.md'))return content;
  const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if(front&&/^description:\s*\S/m.test(front[1]))return content;
  const body=front?content.slice(front[0].length):content;
  const firstLine=body.split(/\r?\n/).map(line=>line.replace(/^#+\s*/,'').trim()).find(Boolean)||'Repository skill';
  const descLine=`description: ${JSON.stringify(firstLine.slice(0,500))}`;
  if(front)return `---\n${front[1].trimEnd()}\n${descLine}\n---\n${body}`;
  return `---\n${descLine}\n---\n${content}`;
}

/** Bot-owned skill files are supplemental resources, not a replacement for the Harness resource loader. */
export async function stageSessionSkills(base,files=[]){
  const root=join(base,'skills','bot-role'),manifest=join(base,'bot-role-skills.json');
  const safe=path=>typeof path==='string'&&path.length>0&&!path.startsWith('/')&&!path.split('/').some(p=>!p||p==='.'||p==='..')&&!path.includes('\\')&&!path.includes('\0');
  const old=await readFile(manifest,'utf8').then(JSON.parse).catch(()=>[]);
  for(const path of Array.isArray(old)?old:[])if(safe(path))await unlink(join(root,path)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  for(const file of files){
    if(!safe(file.path)||typeof file.content!=='string')throw new Error('invalid_session_resource');
    const path=join(root,file.path),content=ensureSkillFrontmatter(file.path,file.content);
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    await writeFile(path,content,{mode:file.path.includes('/scripts/')?0o700:0o600});
  }
  await mkdir(base,{recursive:true,mode:0o700});await writeFile(manifest,JSON.stringify(files.map(f=>f.path)),{mode:0o600});
  return root;
}
