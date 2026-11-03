import { mkdir, realpath, readdir, open, rename, unlink, rm, chmod, stat, lstat, utimes, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const noteLimits = { files: 32, file_bytes: 64 * 1024, total_bytes: 512 * 1024 };
export function noteName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/.test(value)) throw new Error('invalid_note_name');
  return value;
}
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
  constructor(root) { this.root = root; }
  async directory() {
    if (await mkdir(this.root, { recursive: true, mode: 0o770 })) await chmod(this.root, 0o770);
    if (await realpath(this.root) !== this.root) throw new Error('invalid_notes_directory');
  }
  async list() {
    await this.directory(); const files = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      noteName(entry.name); if (!entry.isFile()) throw new Error('invalid_note_file');
      const handle = await open(this.root + '/' + entry.name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const info=await handle.stat(); if (!info.isFile()) throw new Error('invalid_note_file'); files.push({ name: entry.name, bytes: info.size }); } finally { await handle.close(); }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }
  async read(name) {
    noteName(name); await this.directory();
    const handle = await open(this.root + '/' + name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat(); if (!info.isFile()) throw new Error('invalid_note_file');
      if (info.size > noteLimits.file_bytes) throw new Error('note_file_limit_64_KiB');
      return { content: await handle.readFile('utf8') };
    } finally { await handle.close(); }
  }
  async write(name, content, contains = () => false) {
    noteName(name); if (typeof content !== 'string') throw new Error('invalid_note_content');
    const data = Buffer.from(content);
    if (contains(data)) throw new Error('credential_in_notes');
    if (data.length > noteLimits.file_bytes) throw new Error('note_file_limit_64_KiB');
    await this.directory();
    return locked(this.root, async check => {
      const files = await this.list(), previous = files.find(file => file.name === name);
      if (!previous && files.length >= noteLimits.files) throw new Error('notes_file_count_limit_32');
      if (files.reduce((n, file) => n + file.bytes, 0) - (previous?.bytes || 0) + data.length > noteLimits.total_bytes) throw new Error('notes_total_limit_512_KiB');
      const temp = this.root + '/.write-' + randomBytes(12).toString('hex');
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o660);
      try { await handle.chmod(0o660); await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      try { await check(); await rename(temp, this.root + '/' + name); } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { written: true };
    });
  }
  async delete(name) {
    noteName(name); await this.directory();
    return locked(this.root, async check => {
      if (!(await lstat(this.root + '/' + name)).isFile()) throw new Error('invalid_note_file');
      await check(); await unlink(this.root + '/' + name); return { deleted: true };
    });
  }
}
