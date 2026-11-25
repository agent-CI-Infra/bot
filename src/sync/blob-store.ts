import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync, mkdirSync } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fail } from '../core/security.js';
import { assertSha256 } from './paths.js';
import type { BlobMetadata, BlobStore } from './types.js';

export function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Default control-plane local disk CAS blob store: `<root>/blobs/sha256/<aa>/<bb>/<hash>`.
 * Objects are written atomically with `0o600` permissions and integrity-verified on read.
 * Future deployments can plug in an S3/MinIO implementation behind the same `BlobStore` interface.
 */
export class LocalDiskBlobStore implements BlobStore {
  readonly kind = 'local-disk';
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }
  }

  private blobPath(sha256: string): string {
    const clean = assertSha256(sha256);
    return join(this.root, 'blobs', 'sha256', clean.slice(0, 2), clean.slice(2, 4), clean);
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.stat(sha256)) !== null;
  }

  async stat(sha256: string): Promise<BlobMetadata | null> {
    const target = this.blobPath(sha256);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) fail(409, 'sync_blob_corrupt');
      return { sha256, size: info.size };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async get(sha256: string): Promise<Buffer | null> {
    const clean = assertSha256(sha256);
    const target = this.blobPath(clean);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'ELOOP' || error?.code === 'EISDIR') fail(409, 'sync_blob_corrupt');
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) fail(409, 'sync_blob_corrupt');
      const data = await handle.readFile();
      if (sha256Buffer(data) !== clean) fail(409, 'sync_blob_corrupt');
      return data;
    } finally {
      await handle.close();
    }
  }

  async put(data: Buffer, expectedSha256?: string): Promise<BlobMetadata & { deduplicated: boolean }> {
    const actual = sha256Buffer(data);
    if (expectedSha256 !== undefined) {
      const claimed = assertSha256(expectedSha256);
      if (claimed !== actual) fail(400, 'sync_blob_hash_mismatch');
    }
    const existing = await this.stat(actual);
    if (existing) {
      return { sha256: actual, size: existing.size, deduplicated: true };
    }
    const target = this.blobPath(actual);
    const dir = dirname(target);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${target}.tmp-${randomBytes(8).toString('hex')}`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(data);
      await handle.datasync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temp, 0o600).catch(() => {});
      await rename(temp, target);
    } catch (error: any) {
      await unlink(temp).catch(() => {});
      const raced = await this.stat(actual);
      if (raced) return { sha256: actual, size: raced.size, deduplicated: true };
      throw error;
    }
    return { sha256: actual, size: data.length, deduplicated: false };
  }

  async delete(sha256: string): Promise<boolean> {
    const target = this.blobPath(sha256);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) fail(409, 'sync_blob_corrupt');
      await unlink(target);
      return true;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }
}

/** In-memory CAS BlobStore useful for isolated unit tests and ephemeral scopes. */
export class MemoryBlobStore implements BlobStore {
  readonly kind = 'memory';
  private readonly blobs = new Map<string, Buffer>();

  async has(sha256: string): Promise<boolean> {
    return this.blobs.has(assertSha256(sha256));
  }

  async stat(sha256: string): Promise<BlobMetadata | null> {
    const buf = this.blobs.get(assertSha256(sha256));
    return buf ? { sha256, size: buf.length } : null;
  }

  async get(sha256: string): Promise<Buffer | null> {
    const buf = this.blobs.get(assertSha256(sha256));
    return buf ? Buffer.from(buf) : null;
  }

  async put(data: Buffer, expectedSha256?: string): Promise<BlobMetadata & { deduplicated: boolean }> {
    const actual = sha256Buffer(data);
    if (expectedSha256 !== undefined && assertSha256(expectedSha256) !== actual) {
      fail(400, 'sync_blob_hash_mismatch');
    }
    if (this.blobs.has(actual)) {
      return { sha256: actual, size: data.length, deduplicated: true };
    }
    this.blobs.set(actual, Buffer.from(data));
    return { sha256: actual, size: data.length, deduplicated: false };
  }

  async delete(sha256: string): Promise<boolean> {
    return this.blobs.delete(assertSha256(sha256));
  }
}
