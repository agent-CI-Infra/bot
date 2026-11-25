export type SyncMode = 'ro' | 'rw';

export type SyncConflictPolicy = 'reject' | 'merge_or_conflict_copy';

export type SyncRedactionPolicy = 'none' | 'redact' | 'reject';

export type SyncPushMode = 'interactive' | 'background';

export type SyncNamespaceName =
  | 'tool-results'
  | 'project-tools'
  | 'agent-tools'
  | 'skill-store'
  | 'project-notes'
  | 'assistant-homes';

export interface SyncNamespacePolicy {
  readonly name: SyncNamespaceName;
  readonly containerPath: string;
  readonly mode: SyncMode;
  readonly immutable: boolean;
  readonly conflictPolicy: SyncConflictPolicy;
  readonly redact: boolean;
  readonly redactionPolicy: SyncRedactionPolicy;
  readonly history: boolean;
  readonly rejectSensitivePaths: boolean;
  readonly allowInternalSymlinks: boolean;
  readonly maxFileBytes: number;
  readonly maxBatchBlobs: number;
  readonly maxBatchBytes: number;
}

export interface SyncEntry {
  path: string;
  sha256: string | null;
  revision: number;
  size: number;
  mode: number;
  deleted: boolean;
  kind?: 'file' | 'symlink';
  link_target?: string | null;
  actor?: string | null;
  updated_at?: string | null;
}

export interface SyncManifestSnapshot {
  revision: number;
  entries: SyncEntry[];
}

export interface SyncManifestResponse {
  namespace: SyncNamespaceName;
  scope: string;
  mode: SyncMode;
  immutable: boolean;
  allow_internal_symlinks: boolean;
  revision: number;
  since_rev: number;
  full: boolean;
  entries: SyncEntry[];
}

export interface SyncBlobItem {
  sha256: string;
  size: number;
  content_base64: string;
}

export interface SyncBlobFetchResponse {
  blobs: SyncBlobItem[];
  missing: string[];
}

export interface SyncBlobPutInput {
  sha256: string;
  content_base64: string;
}

export interface SyncBlobPutItemResult {
  sha256: string;
  original_sha256: string;
  size: number;
  redacted: boolean;
  deduplicated: boolean;
  content_base64?: string;
}

export interface SyncBlobPutResponse {
  stored: SyncBlobPutItemResult[];
}

export interface SyncCommitChange {
  path: string;
  base_revision: number;
  base_sha256?: string | null;
  content_sha256?: string | null;
  deleted?: boolean;
  mode?: number;
}

export interface SyncCommitRequest {
  mode: SyncPushMode;
  actor: string;
  actor_tag?: string;
  skip_if_human_edited?: boolean;
  changes: SyncCommitChange[];
}

export interface MergeConflictHunk {
  base_start_line: number;
  base_end_line: number;
  base: string;
  current: string;
  local: string;
}

export interface SyncConflictDetail {
  path: string;
  code: 'sync_conflict';
  reason: string;
  base_revision: number;
  current_revision: number;
  base_sha256: string | null;
  current_sha256: string | null;
  local_sha256: string | null;
  binary: boolean;
  base_content: string | null;
  current_content: string | null;
  local_content: string | null;
  conflict_markers: string | null;
  hunks: MergeConflictHunk[];
}

export type SyncChangeOutcomeStatus =
  | 'committed'
  | 'unchanged'
  | 'merged'
  | 'conflict'
  | 'conflict_copy'
  | 'skipped_human_edited';

export interface SyncCommitItemResult {
  path: string;
  status: SyncChangeOutcomeStatus;
  revision: number;
  sha256: string | null;
  size: number;
  deleted: boolean;
  redacted?: boolean;
  merged_content_base64?: string;
  current_content_base64?: string;
  conflict_path?: string;
  conflict_revision?: number;
  conflict_sha256?: string;
  conflict_content_base64?: string;
  current_actor?: string | null;
  conflict?: SyncConflictDetail;
}

export interface SyncCommitResponse {
  ok: boolean;
  error?: 'sync_conflict';
  revision: number;
  results: SyncCommitItemResult[];
  conflicts: SyncConflictDetail[];
}

export interface SyncHistoryVersion {
  revision: number;
  sha256: string | null;
  deleted: boolean;
  actor: string | null;
  created_at: string | null;
  bytes: number;
  binary?: boolean;
}

export interface SyncConflictRecord {
  id: string;
  namespace: SyncNamespaceName;
  scope: string;
  path: string;
  mode: SyncPushMode;
  resolution: 'rejected_interactive' | 'conflict_copy' | 'skipped_human_edited';
  actor: string;
  base_revision: number;
  current_revision: number;
  base_sha256: string | null;
  current_sha256: string | null;
  local_sha256: string | null;
  conflict_path: string | null;
  reason: string;
  created_at: string;
}

export interface BlobMetadata {
  sha256: string;
  size: number;
}

export interface PresignedBlobUrl {
  url: string;
  method: 'GET' | 'PUT';
  headers?: Record<string, string>;
  expires_at: string;
}

export interface BlobStore {
  readonly kind: string;
  has(sha256: string): Promise<boolean>;
  stat(sha256: string): Promise<BlobMetadata | null>;
  get(sha256: string): Promise<Buffer | null>;
  put(data: Buffer, expectedSha256?: string): Promise<BlobMetadata & { deduplicated: boolean }>;
  delete(sha256: string): Promise<boolean>;
  presignGet?(sha256: string, ttlSeconds?: number): Promise<PresignedBlobUrl | null>;
  presignPut?(sha256: string, size: number, ttlSeconds?: number): Promise<PresignedBlobUrl | null>;
}

export interface SyncAdapterCommitInput {
  path: string;
  expectedRevision: number;
  content: Buffer | null;
  sha256: string | null;
  deleted: boolean;
  mode?: number;
  actor: string;
}

export interface SyncNamespaceAdapter {
  readonly policy: SyncNamespacePolicy;
  validateScope(scope: string): void;
  withScopeLock?<T>(scope: string, fn: () => Promise<T>): Promise<T>;
  snapshot(scope: string, options?: { paths?: readonly string[] }): Promise<SyncManifestSnapshot>;
  readBlob(scope: string, sha256: string, hintPath?: string): Promise<Buffer | null>;
  versions?(scope: string, path: string): Promise<SyncHistoryVersion[]>;
  readRevision?(
    scope: string,
    path: string,
    revision: number,
  ): Promise<{ content: Buffer | null; sha256: string | null; deleted: boolean; binary?: boolean } | null>;
  applyChange?(scope: string, input: SyncAdapterCommitInput): Promise<SyncEntry>;
}

export interface SyncTokenGrant {
  namespace: SyncNamespaceName | '*';
  scope: string; // exact scope or '*' for trusted node-level credentials
  mode: SyncMode;
}

export interface SyncPrincipal {
  tokenId: string;
  actor: string;
  actorTag: string;
  grants: readonly SyncTokenGrant[];
}
