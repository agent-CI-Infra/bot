import { mkdir, realpath, readdir, open, rename, unlink, rm, chmod, stat, lstat, utimes, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { randomBytes, createHash } from 'node:crypto';
import { NoteCatalog } from './note-catalog.mjs';
import { noteComponent, notePath, withNoteDirectory, withNoteParent } from './note-path.mjs';

const internal = name => name.startsWith('.write-') || name.startsWith('.expired-');
// An externally replaced file is unavailable on its own; it must not become a deletion revision or hide other files.
const unavailableEntry = error => ['ELOOP','ENOTDIR','ENOENT'].includes(error.code) || ['invalid_note_file','invalid_note_path'].includes(error.message);
export const noteName = noteComponent;
// A filesystem lock coordinates the manager and every task process on the same mounted volume.
// A lease recovers writers killed during stop/reset. An expired writer must still own its lease before committing.
async function locked(root, run) {
  const lock = root + '/.write-lock', token = randomBytes(12).toString('hex');
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o770 }); await chmod(lock, 0o770); await writeFile(lock+'/owner',token,{mode:0o660}); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info && Date.now()-info.mtimeMs > 60000) {
        const stale = root+'/.expired-'+token;
        try { await rename(lock,stale); await rm(stale,{recursive:true}); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      if (attempt >= 100) throw new Error('notes_busy'); await new Promise(r => setTimeout(r, 20));
    }
  }
  const owns = async () => await readFile(lock+'/owner','utf8').catch(()=>'') === token;
  const check = async () => { if (!await owns()) throw new Error('notes_lock_expired'); };
  const timer = setInterval(() => { void owns().then(owned=>owned&&utimes(lock,new Date(),new Date())).catch(()=>{}); },5000); timer.unref();
  try { return await run(check); } finally { clearInterval(timer); if (await owns()) await rm(lock, { recursive: true }); }
}
export class Notes {
  constructor(root, { canonicalRoot = root, check } = {}) { this.root = root; this.canonicalRoot = canonicalRoot; this.lockCheck = check; }
  async withLock(run) {
    const execute = async check => {
      const previous = this.catalog; this.catalog = previous || await NoteCatalog.open(this);
      try { await this.catalog.recover(check); return await run(check, this.catalog); }
      finally { this.catalog = previous; }
    };
    if (!this.lockCheck) return locked(this.root, execute);
    await this.lockCheck(); return execute(this.lockCheck);
  }
  async directory() {
    if (await mkdir(this.root, { recursive: true, mode: 0o770 })) await chmod(this.root, 0o770);
    if (await realpath(this.root) !== this.canonicalRoot) throw new Error('invalid_notes_directory');
  }
  async entries() {
    await this.directory(); const files = [], directories = [''];
    const visit = async directory => withNoteDirectory(this.root, directory, async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (internal(entry.name)) continue;
        const relative = directory ? directory + '/' + entry.name : entry.name;
        try {
          // A name the contract no longer addresses is unavailable on its own, like a replaced entry: the rest of the
          // directory still lists.
          notePath(relative);
          if (entry.isDirectory()) { await visit(relative); directories.push(relative); continue; }
          if (!entry.isFile()) continue;
          await withNoteParent(this.root, relative, async target => {
            const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try { const info=await handle.stat(); if (!info.isFile()) throw new Error('invalid_note_file'); files.push({ name: relative, bytes: info.size }); } finally { await handle.close(); }
          }, { canonicalRoot: this.canonicalRoot });
        } catch(error) { if (!unavailableEntry(error)) throw error; }
      }
    }, { canonicalRoot: this.canonicalRoot });
    await visit(''); return { files: files.sort((a,b)=>a.name.localeCompare(b.name)), directories };
  }
  async list() { return (await this.entries()).files; }
  async state(name) {
    try {
      return await withNoteParent(this.root, name, async path => {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const info = await handle.stat(); if (!info.isFile()) throw new Error('invalid_note_file'); const content=await handle.readFile();return { content, binary:!isUtf8(content)||content.includes(0), deleted:false }; }
        finally { await handle.close(); }
      }, { canonicalRoot: this.canonicalRoot });
    } catch (error) { if (error.code === 'ENOENT') return { content: null, deleted: true }; throw error; }
  }
  async historyRoot() {
    const root = this.root + '/.write-history';
    try { await withNoteDirectory(this.root, '.write-history/blobs', () => {}, { create: true, internal: true, canonicalRoot: this.canonicalRoot }); }
    catch (error) { if (error.message === 'invalid_note_path') throw new Error('invalid_notes_history'); throw error; }
    return root;
  }
  async readIndex(key) {
    const path = (await this.historyRoot()) + '/' + key + '.json';
    try {
      return await withNoteParent(this.root, '.write-history/' + key + '.json', async target => {
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { if (!(await handle.stat()).isFile()) throw new Error('invalid_notes_history'); return { path, value: JSON.parse(await handle.readFile('utf8')) }; }
        finally { await handle.close(); }
      }, { internal: true, canonicalRoot: this.canonicalRoot });
    } catch (error) { if (error.code==='ENOENT') return { path, value:null }; throw error; }
  }
  async index(name, check, { present = false, opaqueId = false } = {}) {
    let row = this.catalog.paths.get(name);
    if (!row) {
      const key=createHash('sha256').update(name).digest('hex');
      const legacy = this.catalog.legacy.has(name) ? { path:(await this.historyRoot())+'/'+key+'.json',value:null } : await this.readIndex(key);
      if (legacy.value && (legacy.value.schema!==1 || legacy.value.name!==name || !Array.isArray(legacy.value.versions))) throw new Error('invalid_notes_history');
      if (!present && !legacy.value?.versions.length) return { path:legacy.path,value:{schema:1,name,versions:[]},name };
      row=this.catalog.reserve(name,opaqueId);
      const value={schema:2,file_id:row.id,versions:legacy.value?.versions||[]},path=(await this.historyRoot())+'/'+row.history_key+'.json';
      await this.atomic(path,JSON.stringify(value),check);await this.catalog.save(check);
      return {path,value,name,row};
    }
    const index=await this.readIndex(row.history_key);
    if (!index.value || index.value.schema!==2 || index.value.file_id!==row.id || !Array.isArray(index.value.versions)) throw new Error('invalid_notes_history');
    return {...index,name,row};
  }
  async atomic(path, content, check) {
    if (!path.startsWith(this.root + '/')) throw new Error('invalid_note_path');
    const options = { internal: true, canonicalRoot: this.canonicalRoot };
    return withNoteParent(this.root, '.write-' + randomBytes(12).toString('hex'), async temp => {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o660);
      try { await handle.chmod(0o660); await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      try { await withNoteParent(this.root, path.slice(this.root.length + 1), async (target,parent) => { await check(); await rename(temp, target); await parent.sync(); }, options); }
      finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }, options);
  }
  async blob(sha, raw = false) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('invalid_notes_history');
    await this.historyRoot();
    return withNoteParent(this.root, '.write-history/blobs/' + sha, async target => {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('invalid_notes_history');
        const content = await handle.readFile();
        if (createHash('sha256').update(content).digest('hex') !== sha) throw new Error('invalid_notes_history');
        return raw ? content : content.toString('utf8');
      } finally { await handle.close(); }
    }, { internal: true, canonicalRoot: this.canonicalRoot });
  }
  // Old files and shell edits enter history when next observed; a crashed writer's complete file is recovered too.
  async observe(name, actor, check, options = {}) {
    const state = await this.state(name), index = await this.index(name,check,{...options,present:!state.deleted}), last = index.value.versions.at(-1);
    const sha256 = state.deleted ? null : createHash('sha256').update(state.content).digest('hex');
    if ((!last && state.deleted) || last && last.deleted === state.deleted && last.sha256 === sha256) return index;
    if (!state.deleted) {
      const path = (await this.historyRoot()) + '/blobs/' + sha256;
      try { await this.blob(sha256,true); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await this.atomic(path, state.content, check); }
    }
    const revision = (last?.revision ?? 0) + 1;
    index.value.versions.push({ revision, created_at: new Date().toISOString(), actor, deleted: state.deleted, sha256, bytes: state.deleted ? 0 : Buffer.byteLength(state.content), ...(state.binary?{binary:true}:{}) });
    await this.atomic(index.path, JSON.stringify(index.value), check); return index;
  }
  async lockedFile(name, run, writing = false, options = {}) {
    notePath(name); await this.directory();
    try { return await this.withLock(async check => run(await this.observe(name, 'filesystem', check, options), check)); }
    catch (error) { if (writing && error.code === 'ELOOP') throw new Error('invalid_note_file'); throw error; }
  }
  expected(index, revision) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0 || revision !== (index.value.versions.at(-1)?.revision ?? 0))) throw new Error('note_revision_changed');
  }
  async view(index, revision) {
    const current = index.value.versions.at(-1), version = revision === undefined ? current : index.value.versions.find(v => v.revision === revision);
    if (!version) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' });
    return { id:index.row?.id,name:index.name||index.value.name, ...version, current_revision: current.revision, current_deleted: current.deleted, historical: version.revision !== current.revision, content: version.deleted||version.binary ? null : await this.blob(version.sha256), ...(version.binary&&!version.deleted?{availability:'unsupported_format',download_base64:(await this.blob(version.sha256,true)).toString('base64')}:{}) };
  }
  async file(name, revision) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('invalid_note_revision');
    return this.lockedFile(name, index => this.view(index, revision));
  }
  async versions(name) { return this.lockedFile(name, async index => { if (!index.value.versions.length) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' }); return { versions: [...index.value.versions].reverse(), current_revision: index.value.versions.at(-1).revision }; }); }
  async files(includeDeleted = false) {
    await this.directory();
    return this.withLock(async check => {
      const names = new Set([...(await this.entries()).files.map(f => f.name),...this.catalog.value.files.map(row=>row.path)]);
      await this.historyRoot();
      const histories = await withNoteDirectory(this.root, '.write-history', path => readdir(path), { internal: true, canonicalRoot: this.canonicalRoot });
      for (const entry of histories) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        await withNoteParent(this.root, '.write-history/' + entry, async target => {
          const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { if (!(await handle.stat()).isFile()) throw new Error('invalid_notes_history'); const value = JSON.parse(await handle.readFile('utf8')); if(value.schema===2)return; if(value.schema!==1)throw new Error('invalid_notes_history');
            // A schema 1 history written for a name the current contract no longer addresses is quarantined with its file.
            try { notePath(value.name); } catch { return; }
            if(entry!==createHash('sha256').update(value.name).digest('hex')+'.json')throw new Error('invalid_notes_history'); if(!this.catalog.legacy.has(value.name)||this.catalog.paths.has(value.name))names.add(value.name); } finally { await handle.close(); }
        }, { internal: true, canonicalRoot: this.canonicalRoot });
      }
      const files = [];
      for (const name of names) {
        let index;
        try { index = await this.observe(name, 'filesystem', check); } catch(error) { if (unavailableEntry(error)) continue; throw error; }
        const version = index.value.versions.at(-1);
        if (version && (includeDeleted || !version.deleted)) files.push({ id:index.row?.id,name, ...version });
      }
      return { files: files.sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }
  async saveFile(name, content, expectedRevision, actor = 'workspace', options = {}) {
    if (typeof content !== 'string') throw new Error('invalid_note_content');
    return this.lockedFile(name, async (index, check) => {
      this.expected(index, expectedRevision);
      const previous = await withNoteParent(this.root,name,path=>lstat(path),{canonicalRoot:this.canonicalRoot}).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (previous && !previous.isFile()) throw new Error('invalid_note_file');
      const last = index.value.versions.at(-1);if(last?.binary)throw Object.assign(new Error('unsupported_note_format'),{status:415});
      const sha = createHash('sha256').update(content).digest('hex');
      if (!last || last.deleted || last.sha256 !== sha) { await this.atomic(this.root + '/' + name, content, check); index = await this.observe(name, actor, check, options); }
      return this.view(index);
    }, true, options);
  }
  async removeFile(name, expectedRevision, actor = 'workspace') {
    return this.lockedFile(name, async (index, check) => {
      this.expected(index, expectedRevision);
      if (!index.value.versions.length || index.value.versions.at(-1).deleted) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' });
      await withNoteParent(this.root,name,async(path,parent)=>{await check();await unlink(path);await parent.sync();},{canonicalRoot:this.canonicalRoot}); return this.view(await this.observe(name, actor, check));
    }, true);
  }
  async restoreFile(name, revision, expectedRevision, actor = 'workspace') {
    return this.lockedFile(name, async (index, check) => {
      this.expected(index, expectedRevision); const target = await this.view(index, revision);
      if (target.deleted) throw new Error('invalid_note_revision');
      const before=index.value.versions.at(-1).revision;
      await this.atomic(this.root + '/' + name, target.binary?await this.blob(target.sha256,true):target.content, check);
      index=await this.observe(name,actor,check);
      const last=index.value.versions.at(-1);
      // Restoring is an explicit operation, even when the chosen bytes equal the current file.
      if(last.revision===before)index.value.versions.push({...last,revision:before+1,created_at:new Date().toISOString(),actor});
      Object.assign(index.value.versions.at(-1),{operation:'restore',restored_from:revision});
      await this.atomic(index.path,JSON.stringify(index.value),check);return this.view(index);
    }, true);
  }
  async read(name) { const file = await this.file(name);if(file.binary)throw new Error('unsupported_note_format'); if (file.deleted) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' }); return { content: file.content }; }
  async write(name, content) { await this.saveFile(name, content); return { written: true }; }
  async delete(name) { await this.removeFile(name); return { deleted: true }; }
}

export { locked as withNotesLock };
