import { mkdir, rmdir } from 'node:fs/promises';
import { Notes, withNotesLock } from '../runner/notes.mjs';
import { validNoteId } from '../runner/note-catalog.mjs';
import { notePath, withNoteDirectory, withNoteParent } from '../runner/note-path.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const parts=path=>{const at=path.lastIndexOf('/');return {directory:at<0?'':path.slice(0,at),name:path.slice(at+1)};};
const publicFile=(row,file)=>({...file,id:row.id,name:parts(row.path).name,path:row.path,directory:parts(row.path).directory,readonly:false,can_edit:!file.binary});

// The directory tree is the filesystem, and stable ids use the same catalog/history as workspace note tools.
export class FileTree {
  constructor(root){this.root=root;}
  async notes(_directory,check,run){return run(new Notes(this.root,{check}));}
  async run(operation){
    const root=new Notes(this.root);await root.directory();
    return withNotesLock(this.root,check=>this.notes('',check,notes=>notes.withLock(async(_check,catalog)=>{
      const entries=await notes.entries(),{files}=await notes.files(true);
      return operation({notes,catalog,check,directories:entries.directories,files});
    })));
  }
  row(ctx,id){if(!validNoteId(id))fail('invalid_note_id');const row=ctx.catalog.refs.get(id);if(!row)fail('note_not_found',404);return row;}
  list({directory='',query='',includeDeleted=false,deletedOnly=false}={}){
    notePath(directory,{root:true});if(typeof query!=='string'||query.length>200)fail('invalid_note_query');
    return this.run(ctx=>{
      if(!deletedOnly&&!ctx.directories.includes(directory))fail('directory_not_found',404);
      const files=ctx.files.map(file=>publicFile(this.row(ctx,file.id),file)).filter(file=>(deletedOnly?file.deleted:includeDeleted||!file.deleted)&&(deletedOnly|| (query?file.path.toLowerCase().includes(query.toLowerCase()):file.directory===directory)));
      return {directory,directories:ctx.directories.sort((a,b)=>a.localeCompare(b)),files:files.sort((a,b)=>a.path.localeCompare(b.path)),revision:ctx.catalog.value.revision,search_scope:deletedOnly?'deleted_files':query?'all_directories':'directory'};
    });
  }
  createDirectory(path){
    notePath(path);
    return this.run(async ctx=>{
      try{await withNoteParent(this.root,path,async(target,parent)=>{await ctx.check();await mkdir(target,{mode:0o770});await parent.sync();});}
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
  create(path,content,actor='console'){
    notePath(path);if(typeof content!=='string')fail('invalid_note_content');if(typeof actor!=='string'||actor.length>240)fail('invalid_input');
    return this.run(async ctx=>{
      const row=ctx.catalog.paths.get(path);if(row&&ctx.files.some(file=>file.id===row.id))fail('note_path_conflict',409);
      const location=parts(path);if(!ctx.directories.includes(location.directory))fail('directory_not_found',404);
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
