import { mkdir, realpath, readdir, open, rename, unlink, rm, chmod, stat, lstat, utimes, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { noteComponent, withNoteDirectory, withNoteParent } from './note-path.mjs';

const internal = name => name.startsWith('.write-') || name.startsWith('.expired-');
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
    if (!this.lockCheck) return locked(this.root, run);
    await this.lockCheck(); return run(this.lockCheck);
  }
  async directory() {
    if (await mkdir(this.root, { recursive: true, mode: 0o770 })) await chmod(this.root, 0o770);
    if (await realpath(this.root) !== this.canonicalRoot) throw new Error('invalid_notes_directory');
  }
  async list() {
    await this.directory(); const files = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (internal(entry.name)) continue;
      noteName(entry.name); if (!entry.isFile()) throw new Error('invalid_note_file');
      const handle = await open(this.root + '/' + entry.name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const info=await handle.stat(); if (!info.isFile()) throw new Error('invalid_note_file'); files.push({ name: entry.name, bytes: info.size }); } finally { await handle.close(); }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }
  async state(name) {
    try {
      return await withNoteParent(this.root, name, async path => {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const info = await handle.stat(); if (!info.isFile()) throw new Error('invalid_note_file'); return { content: await handle.readFile('utf8'), deleted: false }; }
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
  async index(name) {
    const root = await this.historyRoot(), path = root + '/' + createHash('sha256').update(name).digest('hex') + '.json';
    try {
      return await withNoteParent(this.root, path.slice(this.root.length + 1), async target => {
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!(await handle.stat()).isFile()) throw new Error('invalid_notes_history');
          const value = JSON.parse(await handle.readFile('utf8'));
          if (value.schema !== 1 || value.name !== name || !Array.isArray(value.versions)) throw new Error('invalid_notes_history');
          return { path, value };
        } finally { await handle.close(); }
      }, { internal: true, canonicalRoot: this.canonicalRoot });
    } catch (error) { if (error.code === 'ENOENT') return { path, value: { schema: 1, name, versions: [] } }; throw error; }
  }
  async atomic(path, content, check) {
    if (!path.startsWith(this.root + '/')) throw new Error('invalid_note_path');
    const options = { internal: true, canonicalRoot: this.canonicalRoot };
    return withNoteParent(this.root, '.write-' + randomBytes(12).toString('hex'), async temp => {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o660);
      try { await handle.chmod(0o660); await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      try { await withNoteParent(this.root, path.slice(this.root.length + 1), async target => { await check(); await rename(temp, target); }, options); }
      finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }, options);
  }
  async blob(sha) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('invalid_notes_history');
    await this.historyRoot();
    return withNoteParent(this.root, '.write-history/blobs/' + sha, async target => {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('invalid_notes_history');
        const content = await handle.readFile('utf8');
        if (createHash('sha256').update(content).digest('hex') !== sha) throw new Error('invalid_notes_history');
        return content;
      } finally { await handle.close(); }
    }, { internal: true, canonicalRoot: this.canonicalRoot });
  }
  // Old files and shell edits enter history when next observed; a crashed writer's complete file is recovered too.
  async observe(name, actor, check) {
    const index = await this.index(name), state = await this.state(name), last = index.value.versions.at(-1);
    const sha256 = state.deleted ? null : createHash('sha256').update(state.content).digest('hex');
    if ((!last && state.deleted) || last && last.deleted === state.deleted && last.sha256 === sha256) return index;
    if (!state.deleted) {
      const path = (await this.historyRoot()) + '/blobs/' + sha256;
      try { await this.blob(sha256); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await this.atomic(path, state.content, check); }
    }
    const revision = (last?.revision ?? 0) + 1;
    index.value.versions.push({ revision, created_at: new Date().toISOString(), actor, deleted: state.deleted, sha256, bytes: state.deleted ? 0 : Buffer.byteLength(state.content) });
    await this.atomic(index.path, JSON.stringify(index.value), check); return index;
  }
  async lockedFile(name, run, writing = false) {
    noteName(name); await this.directory();
    try { return await this.withLock(async check => run(await this.observe(name, 'filesystem', check), check)); }
    catch (error) { if (writing && error.code === 'ELOOP') throw new Error('invalid_note_file'); throw error; }
  }
  expected(index, revision) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0 || revision !== (index.value.versions.at(-1)?.revision ?? 0))) throw new Error('note_revision_changed');
  }
  async view(index, revision) {
    const current = index.value.versions.at(-1), version = revision === undefined ? current : index.value.versions.find(v => v.revision === revision);
    if (!version) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' });
    return { name: index.value.name, ...version, current_revision: current.revision, current_deleted: current.deleted, historical: version.revision !== current.revision, content: version.deleted ? null : await this.blob(version.sha256) };
  }
  async file(name, revision) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('invalid_note_revision');
    return this.lockedFile(name, index => this.view(index, revision));
  }
  async versions(name) { return this.lockedFile(name, async index => { if (!index.value.versions.length) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' }); return { versions: [...index.value.versions].reverse(), current_revision: index.value.versions.at(-1).revision }; }); }
  async files(includeDeleted = false) {
    await this.directory();
    return this.withLock(async check => {
      const names = new Set((await this.list()).map(f => f.name));
      await this.historyRoot();
      const histories = await withNoteDirectory(this.root, '.write-history', path => readdir(path), { internal: true, canonicalRoot: this.canonicalRoot });
      for (const entry of histories) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        await withNoteParent(this.root, '.write-history/' + entry, async target => {
          const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { if (!(await handle.stat()).isFile()) throw new Error('invalid_notes_history'); const value = JSON.parse(await handle.readFile('utf8')); noteName(value.name); if (entry !== createHash('sha256').update(value.name).digest('hex') + '.json') throw new Error('invalid_notes_history'); names.add(value.name); } finally { await handle.close(); }
        }, { internal: true, canonicalRoot: this.canonicalRoot });
      }
      const files = [];
      for (const name of names) { const index = await this.observe(name, 'filesystem', check), version = index.value.versions.at(-1); if (version && (includeDeleted || !version.deleted)) files.push({ name, ...version }); }
      return { files: files.sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }
  async saveFile(name, content, expectedRevision, actor = 'workspace') {
    if (typeof content !== 'string') throw new Error('invalid_note_content');
    return this.lockedFile(name, async (index, check) => {
      this.expected(index, expectedRevision);
      const previous = await lstat(this.root + '/' + name).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (previous && !previous.isFile()) throw new Error('invalid_note_file');
      const last = index.value.versions.at(-1), sha = createHash('sha256').update(content).digest('hex');
      if (!last || last.deleted || last.sha256 !== sha) { await this.atomic(this.root + '/' + name, content, check); index = await this.observe(name, actor, check); }
      return this.view(index);
    }, true);
  }
  async removeFile(name, expectedRevision, actor = 'workspace') {
    return this.lockedFile(name, async (index, check) => {
      this.expected(index, expectedRevision);
      if (!index.value.versions.length || index.value.versions.at(-1).deleted) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' });
      await check(); await unlink(this.root + '/' + name); return this.view(await this.observe(name, actor, check));
    }, true);
  }
  async restoreFile(name, revision, expectedRevision, actor = 'workspace') {
    return this.lockedFile(name, async (index, check) => {
      this.expected(index, expectedRevision); const target = await this.view(index, revision);
      if (target.deleted) throw new Error('invalid_note_revision');
      await this.atomic(this.root + '/' + name, target.content, check); return this.view(await this.observe(name, actor, check));
    }, true);
  }
  async read(name) { const file = await this.file(name); if (file.deleted) throw Object.assign(new Error('ENOENT: note_not_found'), { code: 'ENOENT' }); return { content: file.content }; }
  async write(name, content) { await this.saveFile(name, content); return { written: true }; }
  async delete(name) { await this.removeFile(name); return { deleted: true }; }
}

export { locked as withNotesLock };
