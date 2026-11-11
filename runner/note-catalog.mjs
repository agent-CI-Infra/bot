import { open, lstat, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { noteComponent, notePath, withNoteDirectory, withNoteParent } from './note-path.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const legacyNoteId = name => 'n:' + Buffer.from(name).toString('base64url');
// The form a legacy id may encode: one path component, never a separator or an internal name. Control characters are
// allowed here because ids written before the current contract still carry them; addressability is checked separately.
const legacyComponent = name => typeof name==='string' && !!name && !name.includes('/') && !name.includes('\\') && !['.','..','.git'].includes(name.toLowerCase()) && !name.startsWith('.write-') && !name.startsWith('.expired-');
export function validNoteId(id) {
  if (typeof id !== 'string') return false;
  if (/^f:[a-f0-9]{32}$/.test(id)) return true;
  if (!/^n:[a-zA-Z0-9_-]+$/.test(id)) return false;
  try { const name=Buffer.from(id.slice(2),'base64url').toString('utf8');return legacyComponent(name) && legacyNoteId(name)===id; } catch { return false; }
}
const identity = info => info && ({ dev: info.dev.toString(), ino: info.ino.toString() });
const same = (info, saved) => !!info && !!saved && info.dev.toString()===saved.dev && info.ino.toString()===saved.ino;
// A path is addressable when the current contract can name it; a legacy record that is not stays quarantined.
const addressable = path => { try { notePath(path); return true; } catch { return false; } };

// Paths may change; history keys and public ids do not. The same volume lease protects catalog and content writes.
export class NoteCatalog {
  constructor(store,value) {
    this.store=store;this.value=value;this.paths=new Map();this.refs=new Map();this.legacy=new Map();this.histories=new Set();this.quarantined=[];
    if(value.schema!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.files))fail('invalid_notes_catalog');
    for(const row of value.files){
      if(!row||!validNoteId(row.id)||!Array.isArray(row.aliases)||!Array.isArray(row.legacy_paths)||!/^[a-f0-9]{64}$/.test(row.history_key))fail('invalid_notes_catalog');
      // A file created before this contract may still be on disk under a name that carries a control character. Keep its
      // record (nothing is renamed or deleted) but do not index a path no request can address, so one such file cannot
      // fail the whole volume or hide healthy files next to it. The rows are reported to the listing as quarantined.
      // Only the current path decides that: an unaddressable older name in legacy_paths is a place the file used to be,
      // and a file that has since been renamed is readable under the name it has now.
      if(!addressable(row.path)){this.quarantined.push(row);continue;}
      if(this.paths.has(row.path)||this.histories.has(row.history_key))fail('invalid_notes_catalog');this.paths.set(row.path,row);this.histories.add(row.history_key);
      for(const ref of [row.id,...row.aliases]){if(!validNoteId(ref)||this.refs.has(ref))fail('invalid_notes_catalog');this.refs.set(ref,row);}
      for(const path of row.legacy_paths){if(!addressable(path))continue;if(this.legacy.has(path))fail('invalid_notes_catalog');this.legacy.set(path,row);}
    }
    if(value.pending){const p=value.pending;
      if(!/^[a-f0-9]{24}$/.test(p.operation_id)||typeof p.actor!=='string'||p.actor.length>240||typeof p.deleted!=='boolean')fail('invalid_notes_catalog');
      // The file a move belongs to may be quarantined above, and a move that started under the older contract may name a
      // source no request can address any more. recover() retires either journal under the volume lock; opening the
      // catalog never fails over a name, only over a record that is not a move at all.
      if(typeof p.from!=='string'||typeof p.to!=='string')fail('invalid_notes_catalog');
      if(!p.deleted&&(!p.source||!/^\d+$/.test(p.source.dev)||!/^\d+$/.test(p.source.ino)))fail('invalid_notes_catalog');
    }
  }
  static async open(store) {
    await store.historyRoot();let value;
    try{value=await withNoteParent(store.root,'.write-history/file-tree.json',async path=>{
      const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{if(!(await handle.stat()).isFile())fail('invalid_notes_catalog');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
    },{internal:true,canonicalRoot:store.canonicalRoot});}
    catch(error){if(error.code==='ENOENT')value={schema:1,revision:0,files:[],pending:null};else if(error instanceof SyntaxError)fail('invalid_notes_catalog');else throw error;}
    return new NoteCatalog(store,value);
  }
  async save(check){this.value.revision++;await this.store.atomic(this.store.root+'/.write-history/file-tree.json',JSON.stringify(this.value),check);}
  reserve(path,opaque=false){
    notePath(path);if(this.paths.has(path))return this.paths.get(path);
    const alias=path.includes('/')?null:legacyNoteId(path),id=!opaque&&alias&&!this.refs.has(alias)?alias:'f:'+randomBytes(16).toString('hex');
    const row={id,path,aliases:alias&&id!==alias&&!this.refs.has(alias)?[alias]:[],history_key:randomBytes(32).toString('hex'),legacy_paths:this.legacy.has(path)?[]:[path]};
    this.value.files.push(row);this.paths.set(path,row);this.histories.add(row.history_key);for(const ref of [id,...row.aliases])this.refs.set(ref,row);for(const original of row.legacy_paths)this.legacy.set(original,row);return row;
  }
  setPath(row,path){const other=this.paths.get(path);if(other&&other!==row)fail('note_path_conflict',409);this.paths.delete(row.path);row.path=path;this.paths.set(path,row);}
  async entry(path){try{return await withNoteParent(this.store.root,path,target=>lstat(target,{bigint:true}),{canonicalRoot:this.store.canonicalRoot});}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  async beginMove(id,to,expectedRevision,actor,check){
    notePath(to);if(typeof actor!=='string'||actor.length>240)fail('invalid_input');const row=this.refs.get(id);if(!row)fail('note_not_found',404);
    const index=await this.store.observe(row.path,'filesystem',check);this.store.expected(index,expectedRevision);const current=index.value.versions.at(-1);if(!current)fail('note_not_found',404);
    if(row.path===to)return;
    const parent=to.includes('/')?to.slice(0,to.lastIndexOf('/')):'';
    try{await withNoteDirectory(this.store.root,parent,()=>{},{canonicalRoot:this.store.canonicalRoot});}catch(error){if(error.code==='ENOENT')fail('directory_not_found',404);throw error;}
    if(this.paths.has(to)||await this.entry(to))fail('note_path_conflict',409);
    const source=await this.entry(row.path);if(source&&!source.isFile()||!current.deleted&&!source)fail('invalid_note_file');
    this.value.pending={operation_id:randomBytes(12).toString('hex'),file_id:row.id,from:row.path,to,actor,deleted:current.deleted,source:identity(source)};
    await this.save(check);const result=await this.recover(check);if(row.path!==to)fail(result?.reason||'note_path_conflict',409);
  }
  async recover(check){
    const pending=this.value.pending;if(!pending)return;
    const cancel=async reason=>{this.value.pending=null;await this.save(check);return {reason};};
    const row=this.refs.get(pending.file_id);
    // The move belongs to a quarantined file whose paths can no longer be addressed: abandon the record so the rest of
    // the volume stays readable and writable, and leave the two paths on disk untouched.
    if(!row)return cancel('note_move_unavailable');
    // A source or target name the current contract cannot address was written before it; the bytes stay where they are and
    // the journal is retired, so the catalog opens and the file keeps the path it is readable under now.
    if(!addressable(pending.from)||!addressable(pending.to))return cancel('note_move_unavailable');
    if(![pending.from,pending.to].includes(row.path))fail('invalid_notes_catalog');
    const other=this.paths.get(pending.to);if(other&&other!==row)fail('invalid_notes_catalog');
    let source=await this.entry(pending.from),target=await this.entry(pending.to);
    if(target&&!target.isFile()||source&&!source.isFile())fail('invalid_note_file');
    if(pending.deleted){if(target&&row.path===pending.from)return cancel('note_path_conflict');}
    else if(row.path===pending.from){
      if(!target&&same(source,pending.source)){
        try{await withNoteParent(this.store.root,pending.from,(from,fromParent)=>withNoteParent(this.store.root,pending.to,async(to,toParent)=>{
          await check();await link(from,to);await toParent.sync();
        },{canonicalRoot:this.store.canonicalRoot}),{canonicalRoot:this.store.canonicalRoot});}
        catch(error){if(['EEXIST','EXDEV'].includes(error.code))return cancel(error.code==='EXDEV'?'note_move_cross_device':'note_path_conflict');throw error;}
        source=await this.entry(pending.from);target=await this.entry(pending.to);
      }
      if(!same(target,pending.source)){
        if(same(source,pending.source))return cancel('note_path_conflict');
        if(!target&&source)return cancel('note_revision_changed');
        fail('note_move_uncertain',409);
      }
      if(same(source,pending.source))await withNoteParent(this.store.root,pending.from,async(from,parent)=>{await check();await unlink(from);await parent.sync();},{canonicalRoot:this.store.canonicalRoot});
    }else if(!pending.deleted&&!target)fail('note_move_uncertain',409);
    this.setPath(row,pending.to);await this.save(check);
    let index=await this.store.observe(pending.to,'filesystem',check);
    if(!index.value.versions.some(version=>version.operation_id===pending.operation_id)){
      const last=index.value.versions.at(-1);if(!last)fail('invalid_notes_history');
      index.value.versions.push({...last,revision:last.revision+1,created_at:new Date().toISOString(),actor:pending.actor,operation:'move',from_path:pending.from,to_path:pending.to,operation_id:pending.operation_id});
      await this.store.atomic(index.path,JSON.stringify(index.value),check);
    }
    this.value.pending=null;await this.save(check);
  }
}
