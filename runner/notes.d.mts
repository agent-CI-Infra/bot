export interface NotesOptions {
  canonicalRoot?: string;
  check?: () => Promise<void>;
}

export interface NoteVersionEntry {
  revision: number;
  created_at: string;
  actor: string;
  deleted: boolean;
  sha256: string | null;
  bytes: number;
  binary?: boolean;
  operation?: string;
  restored_from?: number;
}

export interface NoteFileView extends NoteVersionEntry {
  id?: string;
  name: string;
  current_revision: number;
  current_deleted: boolean;
  historical: boolean;
  content: string | null;
  availability?: string;
  download_base64?: string;
}

export class Notes {
  readonly root: string;
  readonly canonicalRoot: string;
  constructor(root: string, options?: NotesOptions);
  withLock<T>(run: (check: () => Promise<void>, catalog: any) => Promise<T>): Promise<T>;
  directory(): Promise<void>;
  entries(): Promise<{ files: { name: string; bytes: number }[]; directories: string[]; unreadable: { path: string; reason: string }[] }>;
  files(includeDeleted?: boolean, scanned?: any): Promise<{ files: (NoteVersionEntry & { id?: string; name: string })[]; unreadable: { id: string | null; path: string; reason: string }[] }>;
  file(name: string, revision?: number): Promise<NoteFileView>;
  versions(name: string): Promise<{ versions: NoteVersionEntry[]; current_revision: number }>;
  blob(sha: string, raw?: false): Promise<string>;
  blob(sha: string, raw: true): Promise<Buffer>;
  atomic(path: string, content: string | Buffer, check: () => Promise<void>): Promise<void>;
  observe(name: string, actor: string, check: () => Promise<void>, options?: Record<string, unknown>): Promise<any>;
  expected(index: any, revision?: number): void;
  view(index: any, revision?: number): Promise<NoteFileView>;
  saveFile(name: string, content: string, expectedRevision?: number, actor?: string, options?: { createParent?: boolean; opaqueId?: boolean }): Promise<NoteFileView>;
  removeFile(name: string, expectedRevision?: number, actor?: string): Promise<NoteFileView>;
  restoreFile(name: string, revision: number, expectedRevision?: number, actor?: string): Promise<NoteFileView>;
  pruneHistory(options?: { keepVersions?: number | null; keepDays?: number | null; now?: number }): Promise<{
    pruned_versions: number;
    removed_blobs: number;
    freed_bytes: number;
    files_trimmed: number;
    blob_gc_skipped: boolean;
  }>;
}

export function withNotesLock<T>(root: string, run: (check: () => Promise<void>) => Promise<T>): Promise<T>;
