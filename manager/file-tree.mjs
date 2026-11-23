import { mkdir, chmod, rmdir } from 'node:fs/promises';
import { Notes, withNotesLock } from '../runner/notes.mjs';
import { validNoteId } from '../runner/note-catalog.mjs';
import { notePath, withNoteDirectory, withNoteParent } from '../runner/note-path.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status,code:message});};
const parts=path=>{const at=path.lastIndexOf('/');return {directory:at<0?'':path.slice(0,at),name:path.slice(at+1)};};
const publicFile=(row,file)=>({...file,id:row.id,name:parts(row.path).name,path:row.path,directory:parts(row.path).directory,readonly:false,can_edit:!file.binary});
const MAX_SEARCH_FILE_BYTES=512*1024;
const MAX_SEARCH_SCAN_BYTES=32*1024*1024;
function makePreview(content,needle,terms){
  if(typeof content!=='string')return null;
  const flat=content.replace(/\s+/g,' ').trim();
  if(!flat)return '';
  let pos=-1;
  if(needle){
    const lower=flat.toLowerCase();
    pos=lower.indexOf(needle);
    if(pos<0){
      for(const term of terms){
        const at=lower.indexOf(term);
        if(at>=0&&(pos<0||at<pos))pos=at;
      }
    }
  }
  const maxLen=240;
  if(pos<=40)return flat.length>maxLen?flat.slice(0,maxLen).trimEnd()+'…':flat;
  const start=Math.max(0,pos-60);
  const slice=flat.slice(start,start+maxLen);
  return (start>0?'…':'')+slice.trim()+(start+maxLen<flat.length?'…':'');
}

// The directory tree is the filesystem, and stable ids use the same catalog/history as workspace note tools.
export class FileTree {
  constructor(root){this.root=root;}
  async notes(_directory,check,run){return run(new Notes(this.root,{check}));}
  async run(operation){
    const root=new Notes(this.root);await root.directory();
    return withNotesLock(this.root,check=>this.notes('',check,notes=>notes.withLock(async(_check,catalog)=>{
      const entries=await notes.entries(),{files,unreadable}=await notes.files(true,entries);
      return operation({notes,catalog,check,directories:entries.directories,files,unreadable});
    })));
  }
  row(ctx,id){if(!validNoteId(id))fail('invalid_note_id');const row=ctx.catalog.refs.get(id);if(!row)fail('note_not_found',404);return row;}
  list({directory='',query='',includeDeleted=false,deletedOnly=false,recursive=false,preview=false}={}){
    notePath(directory,{root:true});if(typeof query!=='string'||query.length>200)fail('invalid_note_query');
    const needle=query.trim().toLowerCase(),terms=needle?needle.split(/\s+/).filter(Boolean).slice(0,8):[];
    return this.run(async ctx=>{
      if(!deletedOnly&&!ctx.directories.includes(directory))fail('directory_not_found',404);
      const files=[];
      let scannedBytes=0;
      let scanLimited=false;
      for(const raw of ctx.files){
        const file=publicFile(this.row(ctx,raw.id),raw);
        if(deletedOnly){if(!file.deleted)continue;}
        else if(file.deleted&&!includeDeleted)continue;
        if(!needle){
          if(!deletedOnly&&!recursive&&file.directory!==directory)continue;
          if(!preview){files.push(file);continue;}
          let content=null;
          if(!file.deleted&&!file.binary&&file.sha256){
            if(Number(file.bytes??0)<=MAX_SEARCH_FILE_BYTES&&scannedBytes<MAX_SEARCH_SCAN_BYTES){
              try{content=await ctx.notes.blob(file.sha256);scannedBytes+=Buffer.byteLength(content);}catch{}
            }else scanLimited=true;
          }
          files.push({...file,preview:makePreview(content,'',[])});
          continue;
        }
        const pathLower=file.path.toLowerCase();
        const pathMatch=pathLower.includes(needle)||(terms.length>1&&terms.every(term=>pathLower.includes(term)));
        let content=null,contentMatch=false;
        if(!file.deleted&&!file.binary&&file.sha256){
          if(Number(file.bytes??0)<=MAX_SEARCH_FILE_BYTES&&scannedBytes<MAX_SEARCH_SCAN_BYTES){
            try{
              content=await ctx.notes.blob(file.sha256);
              scannedBytes+=Buffer.byteLength(content);
              const contentLower=content.toLowerCase();
              contentMatch=contentLower.includes(needle)||(terms.length>1&&terms.every(term=>pathLower.includes(term)||contentLower.includes(term)));
            }catch{}
          }else scanLimited=true;
        }
        if(!pathMatch&&!contentMatch)continue;
        files.push({...file,preview:makePreview(content,needle,terms),match_in:pathMatch&&contentMatch?'both':contentMatch?'content':'path'});
      }
      // A file saved under a name the current contract refuses, or one the manager lacks permission to open (#1278),
      // stays on disk and is reported here instead of failing the whole listing or posing as a readable entry.
      const quarantinedByPath=new Map();
      for(const row of ctx.catalog.quarantined)quarantinedByPath.set(row.path,{id:row.id,path:row.path,reason:'unsupported_name'});
      for(const row of ctx.unreadable||[])if(!quarantinedByPath.has(row.path))quarantinedByPath.set(row.path,row);
      const quarantined=[...quarantinedByPath.values()].sort((a,b)=>a.path.localeCompare(b.path));
      return {directory,directories:ctx.directories.sort((a,b)=>a.localeCompare(b)),files:files.sort((a,b)=>a.path.localeCompare(b.path)),quarantined,revision:ctx.catalog.value.revision,search_scope:deletedOnly?'deleted_files':needle||recursive?'all_directories':'directory',scan_limited:scanLimited};
    });
  }
  createDirectory(path){
    notePath(path);
    return this.run(async ctx=>{
      if(ctx.catalog.paths.has(path))fail('note_path_conflict',409);
      try{await withNoteParent(this.root,path,async(target,parent)=>{await ctx.check();await mkdir(target,{mode:0o770});await chmod(target,0o770);await parent.sync();});}
      catch(error){if(error.code==='EEXIST')fail('note_path_conflict',409);if(error.code==='ENOENT')fail('directory_not_found',404);throw error;}
      await ctx.catalog.save(ctx.check);return {directory:path,revision:ctx.catalog.value.revision};
    });
  }
  deleteDirectory(path){
    notePath(path);
    return this.run(async ctx=>{
      try{await withNoteParent(this.root,path,async(target,parent)=>{await ctx.check();await rmdir(target);await parent.sync();});}
      catch(error){if(['ENOTEMPTY','EEXIST'].includes(error.code))fail('directory_not_empty',409);if(error.code==='ENOENT')fail('directory_not_found',404);throw error;}
      await ctx.catalog.save(ctx.check);return {deleted:true,directory:path,revision:ctx.catalog.value.revision};
    });
  }
  create(path,content,actor='console',{createParents=false}={}){
    notePath(path);if(typeof content!=='string')fail('invalid_note_content');if(typeof actor!=='string'||actor.length>240)fail('invalid_input');
    return this.run(async ctx=>{
      const row=ctx.catalog.paths.get(path);if(row&&ctx.files.some(file=>file.id===row.id))fail('note_path_conflict',409);
      const location=parts(path);
      if(!ctx.directories.includes(location.directory)){
        if(!createParents)fail('directory_not_found',404);
        await withNoteDirectory(this.root,location.directory,()=>{},{create:true});
      }
      const file=await ctx.notes.saveFile(path,content,0,actor,{opaqueId:true});return publicFile(this.row(ctx,file.id),file);
    });
  }
  read(id,revision){return this.run(async ctx=>{const row=this.row(ctx,id);return publicFile(row,await ctx.notes.file(row.path,revision));});}
  versions(id){return this.run(async ctx=>{const row=this.row(ctx,id);return {id:row.id,path:row.path,...await ctx.notes.versions(row.path)};});}
  save(id,content,expectedRevision,actor){return this.run(async ctx=>{const row=this.row(ctx,id);return publicFile(row,await ctx.notes.saveFile(row.path,content,expectedRevision,actor));});}
  delete(id,expectedRevision,actor){return this.run(async ctx=>{const row=this.row(ctx,id);return publicFile(row,await ctx.notes.removeFile(row.path,expectedRevision,actor));});}
  restore(id,revision,expectedRevision,actor){return this.run(async ctx=>{
    const row=this.row(ctx,id),index=await ctx.notes.observe(row.path,'filesystem',ctx.check);ctx.notes.expected(index,expectedRevision);
    const target=await ctx.notes.view(index,revision);if(target.deleted)fail('invalid_note_revision');
    await withNoteDirectory(this.root,parts(row.path).directory,()=>{},{create:true});
    return publicFile(row,await ctx.notes.restoreFile(row.path,revision,expectedRevision,actor));
  });}
  move(id,path,expectedRevision,actor='console'){
    notePath(path);
    return this.run(async ctx=>{const row=this.row(ctx,id);await ctx.catalog.beginMove(row.id,path,expectedRevision,actor,ctx.check);return publicFile(row,await ctx.notes.file(row.path));});
  }
}
