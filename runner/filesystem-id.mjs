import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// Device numbers alone can collide between machines. GNU stat reports the filesystem ID in hex.
export async function filesystemId(path, device) {
  try {
    const { stdout } = await exec('stat', ['-f', '-c', '%i', '--', path], { timeout: 5000 });
    const fsid = stdout.trim().toLowerCase();
    return /^[a-f0-9]+$/.test(fsid) && !/^0+$/.test(fsid) ? (device ?? (await stat(path)).dev) + ':' + fsid : null;
  } catch { return null; }
}
