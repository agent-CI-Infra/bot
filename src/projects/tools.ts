import { createHash } from 'node:crypto';
import { constants, existsSync, mkdirSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { basename, join, resolve } from 'node:path';
import type { Store } from '../storage/database.js';
import type { Actor } from '../app/auth.js';
import { repository } from '../app/auth.js';
import { configuredRedactor } from '../core/redaction.js';
import { fail, fields, HttpError, randomId, text, type Json } from '../core/security.js';
import { diskState, type DiskState } from '../storage/disk.js';
import { canConfigureProject, requireProjectConfigWrite, type Manager } from './service.js';
import {
  cloneRevisionToStaging,
  deletePathsInStaging,
  extractTarGzToStaging,
  extractZipFileToStaging,
  finalizeAndValidateStaging,
  MAX_TOOL_FILES,
  normalizeToolRelativePath,
  type StagedToolEntry,
  writeStreamToStagedFile,
} from './tools-archive.js';

export const DEFAULT_PROJECT_TOOLS_ROOT = '/project-tools';
export const PROJECT_TOOLS_QUOTA_KEY = 'project_tools.quota_gb';
export const DEFAULT_PROJECT_TOOLS_QUOTA_GB = 20;
export const projectToolsQuotaBounds = [1, 200] as const;
export const PROJECT_TOOLS_RETAIN_PREVIOUS = 3;
const GIB = 1024 * 1024 * 1024;
const ORPHAN_STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const REPO_ID_RE = /^[1-9]\d{0,19}$/;

export function validateProjectToolsQuotaGb(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < projectToolsQuotaBounds[0] || (value as number) > projectToolsQuotaBounds[1]) {
    return fail(400, 'invalid_project_tools_quota_gb');
  }
  return value as number;
}

export function projectToolsQuotaGb(store: Store): number {
  const raw = Number(store.get('SELECT value FROM settings WHERE key=?', PROJECT_TOOLS_QUOTA_KEY)?.value);
  return Number.isSafeInteger(raw) && raw >= projectToolsQuotaBounds[0] && raw <= projectToolsQuotaBounds[1]
    ? raw
    : DEFAULT_PROJECT_TOOLS_QUOTA_GB;
}

export function projectToolsQuotaBytes(store: Store): number {
  return projectToolsQuotaGb(store) * GIB;
}

/** Ensures the control-plane tables for per-project immutable tool revisions exist. */
export function projectToolsStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS project_tool_state(
      repository_id TEXT PRIMARY KEY,
      active_revision INTEGER,
      next_revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS project_tool_revisions(
      repository_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      files_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      manifest TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      actor TEXT NOT NULL,
      source TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, revision)
    );
    CREATE INDEX IF NOT EXISTS project_tool_revisions_repo_rev ON project_tool_revisions(repository_id, revision DESC);
  `);
}

export interface ProjectToolMountSpec {
  repository_id: string;
  mount_name: string;
  revision: number;
}

export function sanitizeProjectMountName(fullName: string, repositoryId: string): string {
  const parts = String(fullName || '').split('/').filter(Boolean);
  const rawOwner = parts[0] || 'repo';
  const rawRepo = parts.slice(1).join('_') || repositoryId;
  const clean = (segment: string) => segment.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
  return `${clean(rawOwner)}__${clean(rawRepo)}`.slice(0, 120);
}

/** Resolves active project tool revisions for a set of authorized projects (used for group assistant read-only mounts). */
export function activeProjectToolsForProjects(
  store: Store,
  projects: { id: string; full_name: string }[],
): ProjectToolMountSpec[] {
  if (!projects.length || !store.hasTable('project_tool_state')) return [];
  const usedNames = new Set<string>();
  const mounts: ProjectToolMountSpec[] = [];
  for (const project of [...projects].sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id))) {
    if (!REPO_ID_RE.test(project.id)) continue;
    const row = store.get('SELECT active_revision FROM project_tool_state WHERE repository_id=?', project.id);
    const rev = row?.active_revision;
    if (!Number.isSafeInteger(rev) || (rev as number) < 1) continue;
    let mountName = sanitizeProjectMountName(project.full_name, project.id);
    if (usedNames.has(mountName)) mountName = `${mountName}__${project.id}`.slice(0, 140);
    usedNames.add(mountName);
    mounts.push({ repository_id: project.id, mount_name: mountName, revision: Number(rev) });
  }
  return mounts;
}

export function activeProjectToolRevision(store: Store, repositoryId: string): number | null {
  if (!store.hasTable('project_tool_state')) return null;
  const rev = store.get('SELECT active_revision FROM project_tool_state WHERE repository_id=?', repositoryId)?.active_revision;
  return Number.isSafeInteger(rev) && (rev as number) >= 1 ? Number(rev) : null;
}

export interface PublishToolsInput {
  repositoryId: string;
  actorId: string;
  source: 'console' | 'assistant' | 'api';
  mode: 'replace' | 'merge';
  kind?: 'file' | 'archive' | 'delete';
  filename?: string;
  targetPath?: string;
  executable?: boolean;
  deletePaths?: string[];
  note?: string;
  stream?: AsyncIterable<Buffer>;
  filePath?: string;
  buffer?: Buffer;
  archiveFormat?: 'tar.gz' | 'zip';
}

export interface ProjectToolsOptions {
  root?: string;
  manager?: Manager;
  reconcile?: () => void;
  /** Optional hook overriding manager mount inspection (primarily for unit tests). */
  mountedRevisions?: () => Promise<Set<string> | null>;
  /** Optional hook overriding filesystem free-space inspection (primarily for unit tests). */
  diskState?: (path: string) => DiskState | null;
}

function detectArchiveFormat(filename: string | undefined, magic?: Buffer): 'tar.gz' | 'zip' | null {
  if (magic && magic.length >= 4) {
    if (magic[0] === 0x1f && magic[1] === 0x8b) return 'tar.gz';
    if (magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 0x03 || magic[2] === 0x05)) return 'zip';
  }
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.zip')) return 'zip';
  return null;
}

async function streamToDiskFile(
  stream: AsyncIterable<Buffer>,
  destPath: string,
  maxBytes: number,
): Promise<{ size: number; magic: Buffer }> {
  const handle = await open(destPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let size = 0;
  let magic = Buffer.alloc(0);
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (!chunk.length) continue;
      if (magic.length < 8) magic = Buffer.concat([magic, chunk.subarray(0, 8 - magic.length)]);
      size += chunk.length;
      if (size > maxBytes) fail(413, 'project_tools_quota_exceeded');
      let off = 0;
      while (off < chunk.length) {
        const res = await handle.write(chunk, off, chunk.length - off);
        off += res.bytesWritten;
      }
    }
    return { size, magic };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(destPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readMagic(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buf, 0, 8, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Manages per-project immutable read-only tool volumes (`/project-tools/<repository_id>/rev-<N>`).
 * All writes run exclusively inside the control plane via staging -> validation -> atomic seal -> idle rotation.
 */
export class ProjectToolsService {
  readonly root: string | null;
  private readonly locks = new Map<string, Promise<unknown>>();
  private gcTimer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingWork = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(readonly store: Store, readonly options: ProjectToolsOptions = {}) {
    projectToolsStorage(store);
    this.root = options.root ? resolve(options.root) : null;
  }

  available(): boolean {
    return !!this.root && existsSync(this.root);
  }

  private ensureRoot(): string {
    const root = this.root;
    if (!root) return fail(503, 'project_tools_unavailable');
    if (!existsSync(root)) {
      try { mkdirSync(root, { recursive: true, mode: 0o755 }); }
      catch { return fail(503, 'project_tools_unavailable'); }
    }
    return root;
  }

  private assertDiskSpace(root: string, expectedBytes = 0): void {
    const state = (this.options.diskState ?? diskState)(root);
    if (!state) return;
    if (state.low || (expectedBytes > 0 && state.free_bytes - expectedBytes < state.reserve_bytes)) {
      fail(507, 'project_tools_disk_full');
    }
  }

  private assertRepoId(repositoryId: string): void {
    if (!REPO_ID_RE.test(repositoryId || '')) fail(400, 'invalid_repository_id');
  }

  private repoDir(root: string, repositoryId: string): string {
    return join(root, repositoryId);
  }

  revisionDir(repositoryId: string, revision: number): string {
    const root = this.ensureRoot();
    this.assertRepoId(repositoryId);
    if (!Number.isSafeInteger(revision) || revision < 1) fail(400, 'invalid_revision');
    return join(this.repoDir(root, repositoryId), `rev-${revision}`);
  }

  private exclusive<T>(repositoryId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repositoryId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(repositoryId, tail);
    void tail.then(() => { if (this.locks.get(repositoryId) === tail) this.locks.delete(repositoryId); });
    return next;
  }

  private track(work: Promise<unknown>): void {
    if (this.stopped) return;
    const settled = work.catch(error => {
      if (this.stopped || !this.store.db.isOpen) return;
      console.error('[project-tools] background task failed:', error instanceof Error ? error.message : 'unknown');
    })
      .finally(() => this.pendingWork.delete(settled));
    this.pendingWork.add(settled);
  }

  start(): void {
    if (!this.root || this.gcTimer) return;
    this.stopped = false;
    this.gcTimer = setInterval(() => this.track(this.gc()), 10 * 60_000);
    this.gcTimer.unref?.();
    this.startupTimer = setTimeout(() => this.track(this.gc()), 15_000);
    this.startupTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.startupTimer);
    clearInterval(this.gcTimer);
    this.gcTimer = undefined;
    await Promise.allSettled([...this.pendingWork]);
  }

  private async notifyManager(repositoryId: string, revision: number | null): Promise<void> {
    if (!this.options.manager) return;
    await this.options.manager.call('PUT', `/v1/projects/${repositoryId}/tools`, { revision }).catch(() => null);
  }

  /** Summarizes active revision, retained history, quota, file manifest, and live rotation state. */
  async view(repositoryId: string, options: { canManage?: boolean; includeFiles?: boolean } = {}): Promise<Json> {
    this.assertRepoId(repositoryId);
    const quotaGb = projectToolsQuotaGb(this.store);
    const quotaBytes = quotaGb * GIB;
    const stateRow = this.store.get('SELECT * FROM project_tool_state WHERE repository_id=?', repositoryId);
    const activeRevision = Number.isSafeInteger(stateRow?.active_revision) ? Number(stateRow!.active_revision) : null;
    const revisions = this.store.all(
      "SELECT revision,status,mode,files_count,total_bytes,sha256,actor,source,note,created_at FROM project_tool_revisions WHERE repository_id=? AND status IN ('active','retained') ORDER BY revision DESC",
      repositoryId,
    );
    const activeRow = activeRevision !== null
      ? this.store.get('SELECT * FROM project_tool_revisions WHERE repository_id=? AND revision=?', repositoryId, activeRevision)
      : null;
    let files: StagedToolEntry[] = [];
    if (options.includeFiles !== false && activeRow?.manifest) {
      try { files = JSON.parse(String(activeRow.manifest)) as StagedToolEntry[]; } catch { files = []; }
    }
    let appliedRevision: number | null = null;
    let toolsPending: boolean | null = false;
    let rotationStatus: 'unconfigured' | 'synced' | 'pending' | 'unknown' = activeRevision === null ? 'unconfigured' : 'synced';
    let managerToolsRevision: number | null | undefined = undefined;
    if (this.options.manager) {
      const env = await this.options.manager.call('GET', `/v1/projects/${repositoryId}`, undefined, 10_000).catch(() => null);
      const pc = env?.computer;
      if (pc && typeof pc === 'object') {
        appliedRevision = Number.isSafeInteger(pc.applied_tools_revision) ? Number(pc.applied_tools_revision) : null;
        managerToolsRevision = Number.isSafeInteger(pc.tools_revision) ? Number(pc.tools_revision) : null;
        toolsPending = Boolean(pc.tools_pending);
        if (!toolsPending && managerToolsRevision !== undefined && activeRevision !== appliedRevision && (appliedRevision !== null || activeRevision !== null)) {
          toolsPending = managerToolsRevision !== activeRevision || appliedRevision !== activeRevision;
        }
        rotationStatus = toolsPending ? 'pending' : (activeRevision === null && appliedRevision === null ? 'unconfigured' : 'synced');
      } else {
        toolsPending = null;
        rotationStatus = 'unknown';
      }
    }
    const actorIds = new Set<string>();
    if (stateRow?.updated_by) actorIds.add(String(stateRow.updated_by));
    for (const r of revisions) if (r.actor) actorIds.add(String(r.actor));
    const actorLabels = new Map<string, string>();
    if (actorIds.size) {
      const ids = [...actorIds];
      const placeholders = ids.map(() => '?').join(',');
      for (const row of this.store.all(`SELECT id,username FROM users WHERE id IN (${placeholders})`, ...ids)) {
        if (row.username) actorLabels.set(String(row.id), String(row.username));
      }
    }
    const labelFor = (value: unknown): string | null => {
      if (!value) return null;
      const key = String(value);
      return actorLabels.get(key) ?? key;
    };
    return {
      available: this.available(),
      mount_path: '/opt/project-tools',
      active_revision: activeRevision,
      applied_revision: appliedRevision,
      tools_pending: toolsPending,
      rotation_status: rotationStatus,
      quota_gb: quotaGb,
      quota_bytes: quotaBytes,
      used_bytes: activeRow ? Number(activeRow.total_bytes) : 0,
      files_count: activeRow ? Number(activeRow.files_count) : 0,
      sha256: activeRow ? String(activeRow.sha256) : null,
      updated_at: stateRow?.updated_at ?? null,
      updated_by: stateRow?.updated_by ?? null,
      updated_by_label: labelFor(stateRow?.updated_by),
      retain_previous: PROJECT_TOOLS_RETAIN_PREVIOUS,
      can_manage: options.canManage ?? false,
      revisions: revisions.map(r => ({
        revision: Number(r.revision),
        status: String(r.status),
        mode: String(r.mode),
        files_count: Number(r.files_count),
        total_bytes: Number(r.total_bytes),
        sha256: String(r.sha256),
        actor: String(r.actor),
        actor_label: labelFor(r.actor) ?? String(r.actor),
        source: String(r.source),
        note: String(r.note ?? ''),
        created_at: String(r.created_at),
      })),
      ...(options.includeFiles !== false ? { files } : {}),
    };
  }

  /** Publishes a new immutable revision (rev-(N+1)) from a single file, archive (.tar.gz/.zip), or merge deletion. */
  async publish(input: PublishToolsInput): Promise<Json> {
    this.assertRepoId(input.repositoryId);
    if (!['replace', 'merge'].includes(input.mode)) fail(400, 'invalid_publish_mode');
    const note = input.note ? text(input.note, 500) : '';
    const deletePaths = Array.isArray(input.deletePaths)
      ? input.deletePaths.map(p => normalizeToolRelativePath(String(p)))
      : [];
    if (deletePaths.length > 5000) fail(400, 'invalid_delete_paths');
    const root = this.ensureRoot();
    this.assertDiskSpace(root);

    return this.exclusive(input.repositoryId, async () => {
      if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', input.repositoryId)) {
        fail(404, 'repository_not_found');
      }
      this.assertDiskSpace(root);
      const quotaBytes = projectToolsQuotaBytes(this.store);
      const repoPath = this.repoDir(root, input.repositoryId);
      await mkdir(repoPath, { recursive: true, mode: 0o755 });
      await chmod(repoPath, 0o755);

      const stageId = randomId().slice(0, 24);
      const stageDir = join(repoPath, `staging-${stageId}`);
      const tempUpload = join(repoPath, `staging-${stageId}.upload`);
      await mkdir(stageDir, { mode: 0o700 });

      try {
        const currentState = this.store.get('SELECT active_revision,next_revision FROM project_tool_state WHERE repository_id=?', input.repositoryId);
        const activeRev = Number.isSafeInteger(currentState?.active_revision) ? Number(currentState!.active_revision) : null;
        if (input.mode === 'merge' && activeRev !== null) {
          const prevDir = join(repoPath, `rev-${activeRev}`);
          const prevInfo = await lstat(prevDir).catch(() => null);
          if (!prevInfo?.isDirectory() || prevInfo.isSymbolicLink()) {
            fail(409, 'project_tools_revision_missing_on_disk');
          }
          await cloneRevisionToStaging(prevDir, stageDir);
        }
        if (input.mode === 'merge' && deletePaths.length) {
          await deletePathsInStaging(stageDir, deletePaths);
        }

        const hasPayload = !!(input.stream || input.filePath || input.buffer);
        const kind = input.kind ?? (hasPayload ? (detectArchiveFormat(input.filename) ? 'archive' : 'file') : 'delete');
        if (kind === 'delete') {
          if (input.mode !== 'merge' || !deletePaths.length) fail(400, 'empty_tool_publish');
        } else {
          if (!hasPayload) fail(400, 'tool_payload_required');
          const makeIterable = (): AsyncIterable<Buffer> => {
            if (input.stream) return input.stream;
            if (input.buffer) {
              const buf = input.buffer;
              return (async function* () { yield buf; })();
            }
            return (async function* () {
              const handle = await open(input.filePath!, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const buf = Buffer.alloc(64 * 1024);
                let pos = 0;
                for (;;) {
                  const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
                  if (bytesRead <= 0) break;
                  pos += bytesRead;
                  yield Buffer.from(buf.subarray(0, bytesRead));
                }
              } finally {
                await handle.close();
              }
            })();
          };

          if (kind === 'file') {
            const rawTarget = input.targetPath || (input.filename ? basename(input.filename) : '');
            if (!rawTarget) fail(400, 'invalid_tool_path');
            await writeStreamToStagedFile(stageDir, rawTarget, makeIterable(), {
              executable: input.executable === true,
              maxBytes: quotaBytes,
            });
          } else if (kind === 'archive') {
            let archiveFile = input.filePath;
            let magic: Buffer | undefined;
            if (!archiveFile) {
              const streamed = await streamToDiskFile(makeIterable(), tempUpload, quotaBytes);
              if (streamed.size === 0) fail(400, 'invalid_archive');
              archiveFile = tempUpload;
              magic = streamed.magic;
            } else {
              magic = await readMagic(archiveFile);
            }
            const format = input.archiveFormat ?? detectArchiveFormat(input.filename, magic);
            if (!format) fail(400, 'unsupported_archive_format');
            if (format === 'tar.gz') {
              await extractTarGzToStaging(archiveFile, stageDir, { maxBytes: quotaBytes, maxFiles: MAX_TOOL_FILES });
            } else {
              await extractZipFileToStaging(archiveFile, stageDir, { maxBytes: quotaBytes, maxFiles: MAX_TOOL_FILES });
            }
          } else {
            fail(400, 'invalid_tool_kind');
          }
        }

        const redactor = configuredRedactor(this.store);
        const finalized = await finalizeAndValidateStaging(stageDir, {
          maxBytes: quotaBytes,
          maxFiles: MAX_TOOL_FILES,
          registeredSecrets: redactor.values,
        });

        const nextRevision = Math.max(
          Number(currentState?.next_revision ?? 1),
          Number(this.store.get('SELECT coalesce(max(revision),0)+1 AS n FROM project_tool_revisions WHERE repository_id=?', input.repositoryId)!.n),
        );
        const revDir = join(repoPath, `rev-${nextRevision}`);
        // Any pre-existing directory at rev-${nextRevision} is an uncommitted crash orphan
        // (nextRevision exceeds every committed revision in SQLite, so no container can mount it); sweep before rename.
        if (await lstat(revDir).catch(() => null)) {
          await rm(revDir, { recursive: true, force: true });
        }
        await rename(stageDir, revDir);

        const createdAt = new Date().toISOString();
        try {
          this.store.transaction(() => {
            if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', input.repositoryId)) {
              fail(404, 'repository_not_found');
            }
            this.store.run("UPDATE project_tool_revisions SET status='retained' WHERE repository_id=? AND status='active'", input.repositoryId);
            this.store.run(
              `INSERT INTO project_tool_revisions(repository_id,revision,status,mode,files_count,total_bytes,manifest,sha256,actor,source,note,created_at)
               VALUES(?,?,'active',?,?,?,?,?,?,?,?,?)`,
              input.repositoryId,
              nextRevision,
              input.mode,
              finalized.filesCount,
              finalized.totalBytes,
              JSON.stringify(finalized.files),
              finalized.sha256,
              input.actorId,
              input.source,
              note,
              createdAt,
            );
            this.store.run(
              `INSERT INTO project_tool_state(repository_id,active_revision,next_revision,updated_at,updated_by) VALUES(?,?,?,?,?)
               ON CONFLICT(repository_id) DO UPDATE SET active_revision=excluded.active_revision,next_revision=excluded.next_revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
              input.repositoryId,
              nextRevision,
              nextRevision + 1,
              createdAt,
              input.actorId,
            );
            this.store.audit(input.actorId, 'project_tools.published', `rev-${nextRevision}`, input.repositoryId);
          });
        } catch (error) {
          await rm(revDir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }

        await this.notifyManager(input.repositoryId, nextRevision);
        this.options.reconcile?.();
        this.track(this.gc(input.repositoryId));

        return {
          revision: nextRevision,
          mode: input.mode,
          files_count: finalized.filesCount,
          total_bytes: finalized.totalBytes,
          sha256: finalized.sha256,
          created_at: createdAt,
          state: await this.view(input.repositoryId, { canManage: true }),
        };
      } finally {
        await rm(tempUpload, { force: true }).catch(() => {});
        await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** Switches active_revision back to a retained immutable snapshot and triggers idle rotation. */
  async rollback(repositoryId: string, targetRevision: number, actorId: string, source: 'console' | 'assistant' | 'api' = 'console'): Promise<Json> {
    this.assertRepoId(repositoryId);
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) fail(400, 'invalid_revision');
    const root = this.ensureRoot();

    return this.exclusive(repositoryId, async () => {
      if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId)) fail(404, 'repository_not_found');
      const row = this.store.get(
        "SELECT * FROM project_tool_revisions WHERE repository_id=? AND revision=? AND status IN ('active','retained')",
        repositoryId,
        targetRevision,
      );
      if (!row) fail(404, 'project_tools_revision_not_found');
      const revDir = join(this.repoDir(root, repositoryId), `rev-${targetRevision}`);
      const info = await lstat(revDir).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) fail(409, 'project_tools_revision_missing_on_disk');

      const updatedAt = new Date().toISOString();
      this.store.transaction(() => {
        this.store.run("UPDATE project_tool_revisions SET status='retained' WHERE repository_id=? AND status='active'", repositoryId);
        this.store.run("UPDATE project_tool_revisions SET status='active' WHERE repository_id=? AND revision=?", repositoryId, targetRevision);
        this.store.run(
          `INSERT INTO project_tool_state(repository_id,active_revision,next_revision,updated_at,updated_by) VALUES(?,?,?, ?,?)
           ON CONFLICT(repository_id) DO UPDATE SET active_revision=excluded.active_revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
          repositoryId,
          targetRevision,
          targetRevision + 1,
          updatedAt,
          actorId,
        );
        this.store.audit(actorId, 'project_tools.rolled_back', `rev-${targetRevision}:${source}`, repositoryId);
      });

      await this.notifyManager(repositoryId, targetRevision);
      this.options.reconcile?.();
      this.track(this.gc(repositoryId));

      return {
        revision: targetRevision,
        state: await this.view(repositoryId, { canManage: true }),
      };
    });
  }

  /** Clears the project's active tools volume (active_revision = null); running containers unmount when idle. */
  async clear(repositoryId: string, actorId: string, source: 'console' | 'assistant' | 'api' = 'console'): Promise<Json> {
    this.assertRepoId(repositoryId);
    return this.exclusive(repositoryId, async () => {
      if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId)) fail(404, 'repository_not_found');
      const updatedAt = new Date().toISOString();
      const currentState = this.store.get('SELECT next_revision FROM project_tool_state WHERE repository_id=?', repositoryId);
      const nextRev = Number(currentState?.next_revision ?? 1);
      this.store.transaction(() => {
        this.store.run("UPDATE project_tool_revisions SET status='retained' WHERE repository_id=? AND status='active'", repositoryId);
        this.store.run(
          `INSERT INTO project_tool_state(repository_id,active_revision,next_revision,updated_at,updated_by) VALUES(?,NULL,?,?,?)
           ON CONFLICT(repository_id) DO UPDATE SET active_revision=NULL,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
          repositoryId,
          nextRev,
          updatedAt,
          actorId,
        );
        this.store.audit(actorId, 'project_tools.cleared', `clear:${source}`, repositoryId);
      });

      await this.notifyManager(repositoryId, null);
      this.options.reconcile?.();
      this.track(this.gc(repositoryId));

      return {
        cleared: true,
        state: await this.view(repositoryId, { canManage: true }),
      };
    });
  }

  /** Removes a deleted project's on-disk tool directory (called post-commit from ProjectRemoval). */
  async removeProject(repositoryId: string): Promise<void> {
    if (!this.root || !REPO_ID_RE.test(repositoryId)) return;
    await this.exclusive(repositoryId, async () => {
      await this.notifyManager(repositoryId, null).catch(() => {});
      await rm(this.repoDir(this.root!, repositoryId), { recursive: true, force: true });
    });
  }

  private async readMountedRevisions(): Promise<Set<string> | null> {
    if (this.options.mountedRevisions) return this.options.mountedRevisions();
    if (!this.options.manager) return new Set();
    try {
      const answer = await this.options.manager.call('GET', '/v1/project-tools/mounts', undefined, 15_000);
      const list = Array.isArray(answer?.mounts) ? answer.mounts : Array.isArray(answer) ? answer : null;
      if (!Array.isArray(list)) return null;
      const mounted = new Set<string>();
      for (const item of list) {
        if (item && REPO_ID_RE.test(String(item.repository_id)) && Number.isSafeInteger(Number(item.revision)) && Number(item.revision) > 0) {
          mounted.add(`${item.repository_id}:${Number(item.revision)}`);
        }
      }
      return mounted;
    } catch {
      // Fail closed: never delete revision directories when live container mount state is unknown.
      return null;
    }
  }

  /**
   * Garbage-collects unretained revisions (keeping active + PROJECT_TOOLS_RETAIN_PREVIOUS most recent previous revisions),
   * never removing any revision currently mounted by a running project computer or assistant computer.
   * Also cleans stale staging dirs (>1h) and orphaned deleted-project directories.
   */
  async gc(onlyRepositoryId?: string, now = Date.now()): Promise<{ pruned: number; skipped_mounted: number; staging_cleaned: number; orphans_removed: number }> {
    const result = { pruned: 0, skipped_mounted: 0, staging_cleaned: 0, orphans_removed: 0 };
    if (this.stopped || !this.store.db.isOpen || !this.root || !existsSync(this.root)) return result;
    const mounted = await this.readMountedRevisions();
    if (mounted === null || this.stopped || !this.store.db.isOpen) return result;

    const repoIds = onlyRepositoryId
      ? [onlyRepositoryId]
      : [...new Set([
        ...this.store.all('SELECT repository_id FROM project_tool_state').map(r => String(r.repository_id)),
        ...this.store.all("SELECT DISTINCT repository_id FROM project_tool_revisions WHERE status IN ('active','retained')").map(r => String(r.repository_id)),
        ...(await readdir(this.root).catch(() => [])).filter(name => REPO_ID_RE.test(name)),
      ])];

    for (const repoId of repoIds) {
      if (!REPO_ID_RE.test(repoId)) continue;
      await this.exclusive(repoId, async () => {
        if (this.stopped || !this.store.db.isOpen) return;
        const repoPath = this.repoDir(this.root!, repoId);
        const existsInDb = !!this.store.get('SELECT 1 FROM repositories WHERE id=?', repoId);
        const entries = await readdir(repoPath, { withFileTypes: true }).catch(() => null);
        if (this.stopped || !this.store.db.isOpen) return;

        // Orphaned project directory (project deleted, no container mounts any revision of it)
        if (!existsInDb) {
          const hasMounted = [...mounted].some(key => key.startsWith(`${repoId}:`));
          if (!hasMounted && entries !== null) {
            await rm(repoPath, { recursive: true, force: true }).catch(() => {});
            result.orphans_removed++;
          }
          return;
        }

        const activeRev = activeProjectToolRevision(this.store, repoId);
        const rows = this.store.all(
          "SELECT revision FROM project_tool_revisions WHERE repository_id=? AND status IN ('active','retained') ORDER BY revision DESC",
          repoId,
        ).map(r => Number(r.revision));

        const keep = new Set<number>();
        if (activeRev !== null) keep.add(activeRev);
        let keptPrevious = 0;
        for (const rev of rows) {
          if (rev === activeRev) continue;
          if (keptPrevious < PROJECT_TOOLS_RETAIN_PREVIOUS) {
            keep.add(rev);
            keptPrevious++;
          }
        }

        const diskRevisions = new Set<number>();
        if (entries) {
          for (const entry of entries) {
            const fullPath = join(repoPath, entry.name);
            if (entry.name.startsWith('staging-')) {
              const info = await lstat(fullPath).catch(() => null);
              if (info && now - info.mtimeMs > ORPHAN_STAGING_MAX_AGE_MS) {
                await rm(fullPath, { recursive: true, force: true }).catch(() => {});
                result.staging_cleaned++;
              }
              continue;
            }
            const revMatch = /^rev-([1-9]\d*)$/.exec(entry.name);
            if (!revMatch) continue;
            const rev = Number(revMatch[1]);
            diskRevisions.add(rev);
            if (keep.has(rev)) continue;
            if (mounted.has(`${repoId}:${rev}`)) {
              result.skipped_mounted++;
              continue;
            }
            await rm(fullPath, { recursive: true, force: true });
            this.store.run("UPDATE project_tool_revisions SET status='pruned' WHERE repository_id=? AND revision=?", repoId, rev);
            result.pruned++;
          }
        }

        // Mark DB rows whose revision is outside `keep` and already absent on disk as pruned.
        for (const rev of rows) {
          if (!keep.has(rev) && !diskRevisions.has(rev) && !mounted.has(`${repoId}:${rev}`)) {
            this.store.run("UPDATE project_tool_revisions SET status='pruned' WHERE repository_id=? AND revision=?", repoId, rev);
            result.pruned++;
          }
        }
      });
    }
    return result;
  }

  /** Handles streaming upload route: POST /api/repositories/:id/tools/upload */
  async handleUpload(user: Actor, repositoryId: string, url: URL, req: IncomingMessage): Promise<Json> {
    this.assertRepoId(repositoryId);
    repository(this.store, user, repositoryId);
    requireProjectConfigWrite(user, repositoryId);

    const mode = (url.searchParams.get('mode') || 'merge') as 'replace' | 'merge';
    if (!['replace', 'merge'].includes(mode)) fail(400, 'invalid_publish_mode');
    const kindParam = url.searchParams.get('kind') || '';
    const kind = kindParam === 'file' || kindParam === 'archive' ? kindParam : undefined;
    const filename = url.searchParams.get('filename') || undefined;
    const targetPath = url.searchParams.get('target_path') || undefined;
    const executable = url.searchParams.get('executable') === '1' || url.searchParams.get('executable') === 'true';
    const note = url.searchParams.get('note') || undefined;
    const deleteRaw = url.searchParams.getAll('delete_path').filter(Boolean);

    // Enforce Content-Length and filesystem safety reserve early before accepting the upload stream.
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > projectToolsQuotaBytes(this.store)) {
      fail(413, 'project_tools_quota_exceeded');
    }
    this.assertDiskSpace(this.ensureRoot(), Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0);

    return this.publish({
      repositoryId,
      actorId: user.id,
      source: 'console',
      mode,
      kind,
      filename,
      targetPath,
      executable,
      deletePaths: deleteRaw,
      note,
      stream: req,
    });
  }

  /** Handles JSON project-tools routes under /api/repositories/:id/tools* */
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const match = /^\/api\/repositories\/([1-9]\d{0,19})\/tools(?:\/(rollback|clear|delete-files))?$/.exec(url.pathname);
    if (!match) return undefined;
    const id = match[1]!;
    const action = match[2];
    repository(this.store, user, id);

    if (!action && method === 'GET') {
      return this.view(id, { canManage: canConfigureProject(user, id) });
    }
    if (method !== 'POST') return fail(405, 'method_not_allowed');
    requireProjectConfigWrite(user, id);

    if (action === 'rollback') {
      fields(input, ['revision']);
      return this.rollback(id, Number(input.revision), user.id, 'console');
    }
    if (action === 'clear') {
      fields(input, ['confirm']);
      if (input.confirm !== true) fail(400, 'confirmation_required');
      return this.clear(id, user.id, 'console');
    }
    if (action === 'delete-files') {
      fields(input, ['paths', 'note']);
      if (!Array.isArray(input.paths) || !input.paths.length || input.paths.some(p => typeof p !== 'string')) {
        fail(400, 'invalid_delete_paths');
      }
      return this.publish({
        repositoryId: id,
        actorId: user.id,
        source: 'console',
        mode: 'merge',
        kind: 'delete',
        deletePaths: input.paths as string[],
        note: typeof input.note === 'string' ? input.note : undefined,
      });
    }
    return fail(404, 'not_found');
  }
}

export function hashToolMountSpecs(specs: ProjectToolMountSpec[]): string {
  return createHash('sha256').update(JSON.stringify(specs)).digest('hex');
}
