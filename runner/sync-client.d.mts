export const SYNC_BASE_FILENAME: '.sync-base.json';
export const SYNC_BASE_SCHEMA: 'bot.sync-base/1';

export class SyncClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, status?: number, detail?: unknown);
}

export function sha256Bytes(data: Buffer | string): string;
export function isReservedSyncName(name: string): boolean;
export function validateRelativeSyncPath(raw: unknown): string;

export class CasCache {
  readonly root: string;
  constructor(cacheDir: string);
  objectPath(sha256: string): string;
  has(sha256: string): Promise<boolean>;
  get(sha256: string): Promise<Buffer | null>;
  put(data: Buffer | string, expectedSha256?: string): Promise<{ sha256: string; size: number; deduplicated: boolean }>;
  materialize(sha256: string, destPath: string, options?: { mode?: number; allowHardlink?: boolean }): Promise<{ hardlinked: boolean }>;
}

export interface SyncClientOptions {
  baseUrl: string;
  token?: string;
  namespace: string;
  scope: string;
  targetDir: string;
  cacheDir?: string;
  cas?: CasCache;
  actorTag?: string;
  preferHardlink?: boolean;
  fetchImpl?: typeof fetch;
  baseFile?: string;
  maxBatchBlobs?: number;
}

export class SyncClient {
  readonly baseUrl: string;
  readonly namespace: string;
  readonly scope: string;
  readonly targetDir: string;
  readonly cas: CasCache;
  constructor(options: SyncClientOptions);
  readBaseline(mode?: 'ro' | 'rw'): Promise<Record<string, any>>;
  acceptServerBase(relPath: string, serverRevision: number, serverSha256: string | null): Promise<void>;
  pull(options?: { full?: boolean; force?: boolean; paths?: string[] }): Promise<{
    namespace: string;
    scope: string;
    mode: 'ro' | 'rw';
    revision: number;
    full: boolean;
    entries_count: number;
    cached_hits: number;
    fetched_blobs: number;
    fetched_bytes: number;
    written_files: number;
    hardlinked_files: number;
    symlinks_written: number;
    deleted_files: number;
    skipped_dirty: string[];
  }>;
  push(options?: { mode?: 'interactive' | 'background'; actorTag?: string; skipIfHumanEdited?: boolean; paths?: string[] }): Promise<{
    ok: boolean;
    status: number;
    error?: string;
    revision: number;
    uploaded_blobs: number;
    uploaded_bytes: number;
    results: any[];
    conflicts: any[];
  }>;
}
