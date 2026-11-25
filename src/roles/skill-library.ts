import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { parse } from 'yaml';
import type { Store, Row } from '../storage/database.js';
import { configuredRedactor } from '../core/redaction.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { Redactor, TaskError } from '../agent/common.js';
import { GitHub, repositoryTree } from '../github/client.js';
import type { Mirror } from '../agent/git-cache.js';
import { safeSkillSubpath, skillEntryPath, skillTreePath, trustedCachedRuleFiles } from '../rules/service.js';
import { listBuiltinSkillSlugs, readBuiltinSkillDirectory } from './builtin-skills.js';
import type { SkillStoreFile } from './skill-store.js';

export type SkillOrigin = 'builtin' | 'repository' | 'console';
export type SkillScopeKind = 'builtin' | 'project';
export type SkillFileEncoding = 'utf8' | 'base64';

export const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SKILL_ID_PATTERN = /^(?:builtin:[a-z0-9][a-z0-9._-]{0,63}|(?:repository|console):[A-Za-z0-9._-]{1,64}:[a-z0-9][a-z0-9._-]{0,63})$/;
export const SKILL_MAX_FILES = 256;
export const SKILL_MAX_FILE_BYTES = 512 * 1024;
export const SKILL_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const SKILL_MAX_NAME_LENGTH = 120;
export const SKILL_MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_SKILL_BUNDLES = 32;
export const LIBRARY_BUNDLE_MAX_ITEMS = 64;
export const LIBRARY_BUNDLE_MAX_FILES = 512;
export const LIBRARY_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Controlled non-executable binary asset extensions permitted inside a versioned skill directory.
 * Arbitrary binaries (executables, shared libraries, archives, wasm) are rejected fail-closed.
 */
export const CONTROLLED_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.woff', '.woff2', '.ttf', '.otf',
]);

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const DESCRIPTION_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface SkillFileInput {
  path: string;
  content: string;
  encoding?: SkillFileEncoding;
  executable?: boolean;
}

export interface SkillVersionFileSummary {
  path: string;
  sha256: string;
  bytes: number;
  encoding: SkillFileEncoding;
  executable?: boolean;
}

export interface SkillVersionFile extends SkillVersionFileSummary {
  content: string;
}

export interface SkillSummary {
  id: string;
  scope_kind: SkillScopeKind;
  repository_id: string | null;
  slug: string;
  origin: SkillOrigin;
  name: string;
  description: string;
  latest_version: number;
  latest_content_hash: string;
  file_count: number;
  total_bytes: number;
  source_path: string | null;
  source_meta: Record<string, unknown>;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface SkillVersionSummary {
  skill_id: string;
  version: number;
  name: string;
  description: string;
  content_hash: string;
  file_count: number;
  total_bytes: number;
  source_meta: Record<string, unknown>;
  files: SkillVersionFileSummary[];
  created_at: string;
  created_by: string | null;
}

export interface SkillVersionDetail extends Omit<SkillVersionSummary, 'files'> {
  files: SkillVersionFile[];
}

export interface DiscoveredRepositorySkill {
  path: string;
  slug: string;
  name: string;
  description: string;
  file_count: number;
  total_bytes: number;
  imported_skill_id: string | null;
  imported_version: number | null;
}

const sha256Buffer = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const sha256Text = (value: string) => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();

export function builtinSkillId(slug: string): string {
  if (!SKILL_SLUG_PATTERN.test(slug)) fail(400, 'invalid_skill_slug', 'slug');
  return `builtin:${slug}`;
}

export function projectSkillId(origin: 'repository' | 'console', repositoryId: string, slug: string): string {
  if (!SKILL_SLUG_PATTERN.test(slug)) fail(400, 'invalid_skill_slug', 'slug');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(repositoryId)) fail(400, 'invalid_repository_id', 'repository_id');
  return `${origin}:${repositoryId}:${slug}`;
}

export function parseSkillId(id: string): { scope_kind: SkillScopeKind; origin: SkillOrigin; repository_id: string | null; slug: string } | null {
  if (typeof id !== 'string' || !SKILL_ID_PATTERN.test(id)) return null;
  if (id.startsWith('builtin:')) {
    return { scope_kind: 'builtin', origin: 'builtin', repository_id: null, slug: id.slice('builtin:'.length) };
  }
  const first = id.indexOf(':');
  const second = id.indexOf(':', first + 1);
  if (first < 0 || second < 0) return null;
  const origin = id.slice(0, first) as 'repository' | 'console';
  const repositoryId = id.slice(first + 1, second);
  const slug = id.slice(second + 1);
  return { scope_kind: 'project', origin, repository_id: repositoryId, slug };
}

export function deriveSkillSlug(rawPath: string): string {
  const trimmed = rawPath.replace(/^\.agents\/skills\//, '').replace(/\/+$/, '').toLowerCase();
  const cleaned = trimmed
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64);
  if (cleaned && SKILL_SLUG_PATTERN.test(cleaned)) return cleaned;
  return `skill-${sha256Text(rawPath).slice(0, 8)}`;
}

export function assertSafeSkillFilePath(raw: unknown, field = 'files'): string {
  if (typeof raw !== 'string') fail(400, 'invalid_skill_file', field);
  const value = raw as string;
  if (!value || value.length > 220 || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || CONTROL_CHAR_PATTERN.test(value)) {
    fail(400, 'invalid_skill_file', field);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    fail(400, 'invalid_skill_file', field);
  }
  return value;
}

/**
 * Strictly parses required `name` and `description` from leading YAML frontmatter of `SKILL.md`.
 */
export function parseStrictSkillFrontmatter(markdown: string, field = 'SKILL.md'): { name: string; description: string } {
  if (typeof markdown !== 'string' || markdown.includes('\0')) {
    throw Object.assign(new HttpError(400, 'invalid_skill_frontmatter', field), { detail: `${field} 必须是有效的 UTF-8 Markdown 文件。` });
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    throw Object.assign(new HttpError(400, 'invalid_skill_frontmatter', field), {
      detail: `${field} 必须以 YAML frontmatter（---）开头并声明 name 与 description。`,
    });
  }
  let parsed: unknown;
  try {
    parsed = parse(match[1] ?? '', { maxAliasCount: 0 });
  } catch {
    throw Object.assign(new HttpError(400, 'invalid_skill_frontmatter', field), {
      detail: `${field} 的 YAML frontmatter 语法无效。`,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new HttpError(400, 'invalid_skill_frontmatter', field), {
      detail: `${field} 的 YAML frontmatter 必须是键值映射。`,
    });
  }
  const record = parsed as Record<string, unknown>;
  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  if (!rawName || rawName.length > SKILL_MAX_NAME_LENGTH || CONTROL_CHAR_PATTERN.test(rawName)) {
    throw Object.assign(new HttpError(400, 'invalid_skill_frontmatter', `${field}.name`), {
      detail: `${field} 的 frontmatter 缺少合法的 name（1–${SKILL_MAX_NAME_LENGTH} 字符，单行无控制字符）。`,
    });
  }
  const rawDescription = typeof record.description === 'string' ? record.description.trim() : '';
  if (!rawDescription || rawDescription.length > SKILL_MAX_DESCRIPTION_LENGTH || DESCRIPTION_CONTROL_PATTERN.test(rawDescription)) {
    throw Object.assign(new HttpError(400, 'invalid_skill_frontmatter', `${field}.description`), {
      detail: `${field} 的 frontmatter 缺少合法的 description（1–${SKILL_MAX_DESCRIPTION_LENGTH} 字符）。`,
    });
  }
  return { name: rawName, description: rawDescription };
}

export function isControlledAssetPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return CONTROLLED_ASSET_EXTENSIONS.has(ext);
}

/**
 * Classifies a raw blob from disk or Git into UTF-8 text or a controlled binary asset.
 * Non-UTF-8 / NUL-containing files with non-allowlisted extensions are rejected fail-closed.
 */
export function classifySkillBlob(path: string, data: Buffer, executable = false): SkillFileInput {
  assertSafeSkillFilePath(path, path);
  if (data.length > SKILL_MAX_FILE_BYTES) {
    throw Object.assign(new HttpError(400, 'skill_file_too_large', path), {
      detail: `${path} 超过单文件 512 KiB 上限（${data.length} 字节）。`,
    });
  }
  const hasNul = data.includes(0);
  if (!hasNul) {
    try {
      const content = utf8Decoder.decode(data);
      return { path, content, encoding: 'utf8', ...(executable ? { executable: true } : {}) };
    } catch {
      // Invalid UTF-8 byte sequence: fall through to controlled asset check.
    }
  }
  if (!isControlledAssetPath(path)) {
    throw Object.assign(new HttpError(400, 'invalid_skill_file', path), {
      detail: `${path} 不是普通文本或受控资源文件（仅支持 UTF-8 文本及常见图片/PDF/字体等受控静态资源）。`,
    });
  }
  return { path, content: data.toString('base64'), encoding: 'base64' };
}

export function validateSkillFiles(
  rawFiles: unknown,
  options: { redact?: (text: string) => string; field?: string } = {},
): { name: string; description: string; files: SkillVersionFile[]; file_count: number; total_bytes: number; content_hash: string } {
  const field = options.field ?? 'files';
  if (!Array.isArray(rawFiles) || !rawFiles.length) {
    throw Object.assign(new HttpError(400, 'invalid_skill_files', field), { detail: 'Skill 至少须包含 SKILL.md 文件。' });
  }
  if (rawFiles.length > SKILL_MAX_FILES) {
    throw Object.assign(new HttpError(400, 'too_many_skill_files', field), {
      detail: `单个 Skill 最多包含 ${SKILL_MAX_FILES} 个文件（当前 ${rawFiles.length} 个）。`,
    });
  }

  const seen = new Set<string>();
  const normalized: SkillVersionFile[] = [];
  let totalBytes = 0;

  for (let i = 0; i < rawFiles.length; i++) {
    const rawItem = rawFiles[i];
    const itemField = `${field}[${i}]`;
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) { fail(400, 'invalid_skill_file', itemField); throw new Error('unreachable'); }
    const item = rawItem as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!['path', 'content', 'encoding', 'executable'].includes(key)) fail(400, 'unknown_field', `${itemField}.${key}`);
    }
    const path = assertSafeSkillFilePath(item.path, `${itemField}.path`);
    if (seen.has(path)) fail(400, 'duplicate_skill_file', `${itemField}.path`);
    seen.add(path);

    const encoding: SkillFileEncoding = item.encoding === undefined ? 'utf8'
      : item.encoding === 'utf8' || item.encoding === 'base64' ? item.encoding
      : fail(400, 'invalid_skill_file', `${itemField}.encoding`);
    if (typeof item.content !== 'string') { fail(400, 'invalid_skill_file', `${itemField}.content`); throw new Error('unreachable'); }
    const rawContent: string = item.content;
    if (item.executable !== undefined && typeof item.executable !== 'boolean') fail(400, 'invalid_skill_file', `${itemField}.executable`);

    if (encoding === 'base64') {
      if (path === 'SKILL.md' || !isControlledAssetPath(path)) {
        throw Object.assign(new HttpError(400, 'invalid_skill_file', `${itemField}.encoding`), {
          detail: `${path} 不允许以 base64 二进制资源存储。`,
        });
      }
      const compact = rawContent.replace(/\s+/g, '');
      if (!BASE64_PATTERN.test(compact)) {
        throw Object.assign(new HttpError(400, 'invalid_skill_file', `${itemField}.content`), {
          detail: `${path} 的 base64 内容无效。`,
        });
      }
      const raw = Buffer.from(compact, 'base64');
      if (raw.length > SKILL_MAX_FILE_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', `${itemField}.content`), {
          detail: `${path} 超过单文件 512 KiB 上限（${raw.length} 字节）。`,
        });
      }
      totalBytes += raw.length;
      if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', field), {
          detail: `单个 Skill 总大小超过 8 MiB 上限。`,
        });
      }
      normalized.push({
        path,
        sha256: sha256Buffer(raw),
        bytes: raw.length,
        encoding: 'base64',
        content: raw.toString('base64'),
      });
    } else {
      if (rawContent.includes('\0')) {
        throw Object.assign(new HttpError(400, 'invalid_skill_file', `${itemField}.content`), {
          detail: `${path} 不是有效文本文件（含 NUL 字节）。`,
        });
      }
      const content = options.redact ? options.redact(rawContent) : rawContent;
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > SKILL_MAX_FILE_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', `${itemField}.content`), {
          detail: `${path} 超过单文件 512 KiB 上限（${bytes} 字节）。`,
        });
      }
      totalBytes += bytes;
      if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', field), {
          detail: `单个 Skill 总大小超过 8 MiB 上限。`,
        });
      }
      normalized.push({
        path,
        sha256: sha256Text(content),
        bytes,
        encoding: 'utf8',
        content,
        ...(item.executable ? { executable: true } : {}),
      });
    }
  }

  const ancestorDirs = new Set<string>();
  for (const path of seen) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      ancestorDirs.add(parts.slice(0, depth).join('/'));
    }
  }
  for (const path of seen) {
    if (ancestorDirs.has(path)) {
      throw Object.assign(new HttpError(400, 'invalid_skill_file', path), {
        detail: `${path} 同时作为文件路径和目录前缀出现，不能并存。`,
      });
    }
  }

  const entry = normalized.find(file => file.path === 'SKILL.md');
  if (!entry || entry.encoding !== 'utf8') {
    throw Object.assign(new HttpError(400, 'invalid_skill_frontmatter', 'SKILL.md'), {
      detail: 'Skill 根目录必须包含标准 SKILL.md 文件。',
    });
  }
  const { name, description } = parseStrictSkillFrontmatter(entry.content, 'SKILL.md');
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const contentHash = sha256Text(JSON.stringify(normalized.map(file => ({
    path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
    encoding: file.encoding,
    executable: Boolean(file.executable),
  }))));

  return {
    name,
    description,
    files: normalized,
    file_count: normalized.length,
    total_bytes: totalBytes,
    content_hash: contentHash,
  };
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStoredFiles(raw: unknown): SkillVersionFile[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: any) => ({
      path: String(item.path),
      sha256: String(item.sha256),
      bytes: Number(item.bytes),
      encoding: item.encoding === 'base64' ? 'base64' : 'utf8',
      content: String(item.content ?? ''),
      ...(item.executable ? { executable: true } : {}),
    }));
  } catch {
    return [];
  }
}

function stripFileContent(files: SkillVersionFile[]): SkillVersionFileSummary[] {
  return files.map(({ content: _content, ...rest }) => rest);
}

export function stripSkillVersionContent(version: SkillVersionDetail): SkillVersionSummary {
  return { ...version, files: stripFileContent(version.files) };
}

function toSkillSummary(row: Row, latestVersionRow?: Row): SkillSummary {
  return {
    id: String(row.id),
    scope_kind: String(row.scope_kind) as SkillScopeKind,
    repository_id: row.repository_id == null ? null : String(row.repository_id),
    slug: String(row.slug),
    origin: String(row.origin) as SkillOrigin,
    name: String(row.name),
    description: String(row.description ?? ''),
    latest_version: Number(row.latest_version ?? 0),
    latest_content_hash: String(latestVersionRow?.content_hash ?? ''),
    file_count: Number(latestVersionRow?.file_count ?? 0),
    total_bytes: Number(latestVersionRow?.total_bytes ?? 0),
    source_path: row.source_path == null ? null : String(row.source_path),
    source_meta: parseJsonObject(latestVersionRow?.source_meta),
    can_edit: String(row.origin) === 'console',
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    created_by: row.created_by == null ? null : String(row.created_by),
    updated_by: row.updated_by == null ? null : String(row.updated_by),
  };
}

function toVersionSummary(row: Row): SkillVersionSummary {
  return {
    skill_id: String(row.skill_id),
    version: Number(row.version),
    name: String(row.name),
    description: String(row.description ?? ''),
    content_hash: String(row.content_hash),
    file_count: Number(row.file_count),
    total_bytes: Number(row.total_bytes),
    source_meta: parseJsonObject(row.source_meta),
    files: stripFileContent(parseStoredFiles(row.files)),
    created_at: String(row.created_at),
    created_by: row.created_by == null ? null : String(row.created_by),
  };
}

function toVersionDetail(row: Row): SkillVersionDetail {
  return {
    skill_id: String(row.skill_id),
    version: Number(row.version),
    name: String(row.name),
    description: String(row.description ?? ''),
    content_hash: String(row.content_hash),
    file_count: Number(row.file_count),
    total_bytes: Number(row.total_bytes),
    source_meta: parseJsonObject(row.source_meta),
    files: parseStoredFiles(row.files),
    created_at: String(row.created_at),
    created_by: row.created_by == null ? null : String(row.created_by),
  };
}

/**
 * Ensures the independent `skills` and `skill_versions` tables exist and auto-registers built-in skills on startup.
 */
export function skillLibraryStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('builtin','project')),
      repository_id TEXT,
      slug TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('builtin','repository','console')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      latest_version INTEGER NOT NULL DEFAULT 0,
      source_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,
      updated_by TEXT,
      CHECK(
        (scope_kind = 'builtin' AND repository_id IS NULL AND origin = 'builtin')
        OR (scope_kind = 'project' AND repository_id IS NOT NULL AND origin IN ('repository','console'))
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS skills_builtin_slug ON skills(slug) WHERE scope_kind = 'builtin';
    CREATE UNIQUE INDEX IF NOT EXISTS skills_project_origin_slug ON skills(repository_id, origin, slug) WHERE scope_kind = 'project';
    CREATE INDEX IF NOT EXISTS skills_repository ON skills(repository_id) WHERE repository_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS skill_versions (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      files TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      source_meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (skill_id, version)
    );
    CREATE INDEX IF NOT EXISTS skill_versions_skill_hash ON skill_versions(skill_id, content_hash);
  `);
  syncBuiltinSkills(store, { strict: false });
}

function upsertSkillVersion(
  store: Store,
  params: {
    id: string;
    scope_kind: SkillScopeKind;
    repository_id: string | null;
    slug: string;
    origin: SkillOrigin;
    source_path: string | null;
    source_meta: Record<string, unknown>;
    validated: ReturnType<typeof validateSkillFiles>;
    actor: string;
    expectedVersion?: number;
  },
): { skill: SkillSummary; version: SkillVersionDetail; created: boolean } {
  const { id, scope_kind, repository_id, slug, origin, source_path, source_meta, validated, actor, expectedVersion } = params;
  return store.transaction(() => {
    const existing = store.get('SELECT * FROM skills WHERE id=?', id);
    const now = nowIso();
    if (!existing) {
      if (expectedVersion !== undefined) fail(404, 'skill_not_found');
      store.run(
        `INSERT INTO skills(id,scope_kind,repository_id,slug,origin,name,description,latest_version,source_path,created_at,updated_at,created_by,updated_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, scope_kind, repository_id, slug, origin, validated.name, validated.description, 1, source_path, now, now, actor, actor,
      );
      store.run(
        `INSERT INTO skill_versions(skill_id,version,name,description,content_hash,files,file_count,total_bytes,source_meta,created_at,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id, 1, validated.name, validated.description, validated.content_hash, JSON.stringify(validated.files),
        validated.file_count, validated.total_bytes, JSON.stringify(source_meta), now, actor,
      );
      const skillRow = store.get('SELECT * FROM skills WHERE id=?', id)!;
      const versionRow = store.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=1', id)!;
      return { skill: toSkillSummary(skillRow, versionRow), version: toVersionDetail(versionRow), created: true };
    }

    const latestNum = Number(existing.latest_version ?? 0);
    if (expectedVersion !== undefined && expectedVersion !== latestNum) {
      fail(409, 'skill_revision_conflict', 'expected_version', { current_version: latestNum });
    }
    const latestRow = store.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?', id, latestNum);
    if (latestRow && String(latestRow.content_hash) === validated.content_hash) {
      return { skill: toSkillSummary(existing, latestRow), version: toVersionDetail(latestRow), created: false };
    }

    const nextVersion = latestNum + 1;
    store.run(
      `INSERT INTO skill_versions(skill_id,version,name,description,content_hash,files,file_count,total_bytes,source_meta,created_at,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, nextVersion, validated.name, validated.description, validated.content_hash, JSON.stringify(validated.files),
      validated.file_count, validated.total_bytes, JSON.stringify(source_meta), now, actor,
    );
    store.run(
      `UPDATE skills SET name=?,description=?,latest_version=?,source_path=?,updated_at=?,updated_by=? WHERE id=?`,
      validated.name, validated.description, nextVersion, source_path ?? existing.source_path, now, actor, id,
    );
    const skillRow = store.get('SELECT * FROM skills WHERE id=?', id)!;
    const versionRow = store.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?', id, nextVersion)!;
    return { skill: toSkillSummary(skillRow, versionRow), version: toVersionDetail(versionRow), created: true };
  });
}

interface PreparedBuiltinSkill {
  slug: string;
  id: string;
  validated: ReturnType<typeof validateSkillFiles>;
  sourceRevision: string | null;
}

let cachedDefaultBuiltins: PreparedBuiltinSkill[] | null = null;

function loadDefaultBuiltins(strict: boolean): { items: PreparedBuiltinSkill[]; scanned: number; errors: { slug: string; error: string }[] } {
  if (!strict && cachedDefaultBuiltins) {
    return { items: cachedDefaultBuiltins, scanned: cachedDefaultBuiltins.length, errors: [] };
  }
  const slugs = listBuiltinSkillSlugs();
  const items: PreparedBuiltinSkill[] = [];
  const errors: { slug: string; error: string }[] = [];
  for (const slug of slugs) {
    try {
      const id = builtinSkillId(slug);
      const rawEntries = readBuiltinSkillDirectory(slug);
      const inputs = rawEntries.map(entry => classifySkillBlob(entry.path, entry.data, entry.executable));
      const validated = validateSkillFiles(inputs, { field: `builtin:${slug}` });
      const sourcesEntry = rawEntries.find(e => e.path === 'SOURCES.json');
      let sourceRevision: string | null = null;
      if (sourcesEntry) {
        try {
          const parsed = JSON.parse(sourcesEntry.data.toString('utf8'));
          if (typeof parsed?.revision === 'string' && parsed.revision) sourceRevision = parsed.revision;
        } catch {}
      }
      items.push({ slug, id, validated, sourceRevision });
    } catch (error) {
      if (strict) throw error;
      const code = error instanceof HttpError ? error.code : (error instanceof Error ? error.message : String(error));
      errors.push({ slug, error: code });
      console.warn(`[skill-library] skipped invalid built-in skill "${slug}": ${code}`);
    }
  }
  if (!errors.length) cachedDefaultBuiltins = items;
  return { items, scanned: slugs.length, errors };
}

/**
 * Scans the built-in `skills/` directory (respecting `BOT_SKILLS_DIR` or explicit override) and registers new immutable
 * versions whenever a skill is new or its content hash changed. Existing versions are never modified or removed.
 */
export function syncBuiltinSkills(
  store: Store,
  options: { root?: string | URL; imageTag?: string | null; actor?: string; strict?: boolean } = {},
): { scanned: number; created: number; updated: number; unchanged: number; skills: SkillSummary[]; errors: { slug: string; error: string }[] } {
  const actor = options.actor ?? 'system:builtin';
  const imageTag = options.imageTag !== undefined ? options.imageTag : (process.env.BOT_IMAGE_TAG?.trim() || null);
  const useDefaultCache = options.root === undefined && !process.env.BOT_SKILLS_DIR?.trim();

  let prepared: PreparedBuiltinSkill[];
  let scanned: number;
  let errors: { slug: string; error: string }[];

  if (useDefaultCache) {
    const loaded = loadDefaultBuiltins(Boolean(options.strict));
    prepared = loaded.items;
    scanned = loaded.scanned;
    errors = loaded.errors;
  } else {
    const slugs = listBuiltinSkillSlugs(options.root);
    scanned = slugs.length;
    prepared = [];
    errors = [];
    for (const slug of slugs) {
      try {
        const id = builtinSkillId(slug);
        const rawEntries = readBuiltinSkillDirectory(slug, options.root);
        const inputs = rawEntries.map(entry => classifySkillBlob(entry.path, entry.data, entry.executable));
        const validated = validateSkillFiles(inputs, { field: `builtin:${slug}` });
        const sourcesEntry = rawEntries.find(e => e.path === 'SOURCES.json');
        let sourceRevision: string | null = null;
        if (sourcesEntry) {
          try {
            const parsed = JSON.parse(sourcesEntry.data.toString('utf8'));
            if (typeof parsed?.revision === 'string' && parsed.revision) sourceRevision = parsed.revision;
          } catch {}
        }
        prepared.push({ slug, id, validated, sourceRevision });
      } catch (error) {
        if (options.strict) throw error;
        const code = error instanceof HttpError ? error.code : (error instanceof Error ? error.message : String(error));
        errors.push({ slug, error: code });
        console.warn(`[skill-library] skipped invalid built-in skill "${slug}": ${code}`);
      }
    }
  }

  let created = 0, updated = 0, unchanged = 0;
  const skills: SkillSummary[] = [];

  for (const item of prepared) {
    const existed = Boolean(store.get('SELECT 1 FROM skills WHERE id=?', item.id));
    const sourceMeta: Record<string, unknown> = {
      ...(imageTag ? { image_tag: imageTag } : {}),
      ...(item.sourceRevision ? { source_revision: item.sourceRevision } : {}),
    };
    const res = upsertSkillVersion(store, {
      id: item.id,
      scope_kind: 'builtin',
      repository_id: null,
      slug: item.slug,
      origin: 'builtin',
      source_path: `skills/${item.slug}`,
      source_meta: sourceMeta,
      validated: item.validated,
      actor,
    });
    skills.push(res.skill);
    if (res.created) {
      if (existed) updated++;
      else created++;
    } else {
      unchanged++;
    }
  }
  return { scanned, created, updated, unchanged, skills, errors };
}

function visibleSkillRow(store: Store, repositoryId: string, skillId: string): Row | undefined {
  if (!SKILL_ID_PATTERN.test(skillId)) return undefined;
  return store.get(
    `SELECT * FROM skills WHERE id=? AND (scope_kind='builtin' OR (scope_kind='project' AND repository_id=?))`,
    skillId, repositoryId,
  );
}

/** Lists all skills visible to `repositoryId` (built-in + this project's own repository/console skills). */
export function listSkills(
  store: Store,
  repositoryId: string,
  options: { origin?: SkillOrigin; query?: string; include_builtin?: boolean; offset?: number; limit?: number } = {},
): { skills: SkillSummary[]; total: number; next_offset: number | null } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (options.include_builtin === false) {
    where.push(`s.scope_kind='project' AND s.repository_id=?`);
    args.push(repositoryId);
  } else {
    where.push(`(s.scope_kind='builtin' OR (s.scope_kind='project' AND s.repository_id=?))`);
    args.push(repositoryId);
  }
  if (options.origin) {
    where.push(`s.origin=?`);
    args.push(options.origin);
  }
  const q = options.query?.trim().toLowerCase();
  if (q) {
    where.push(`(lower(s.slug) LIKE ? OR lower(s.name) LIKE ? OR lower(s.description) LIKE ?)`);
    const pattern = `%${q.replace(/[%_\\]/g, ch => '\\' + ch)}%`;
    args.push(pattern, pattern, pattern);
  }
  const escapeClause = q ? " ESCAPE '\\'" : '';
  const whereSql = where.map(clause => (clause.includes('LIKE ?') ? clause.replace(/LIKE \?/g, `LIKE ?${escapeClause}`) : clause)).join(' AND ');
  const total = Number(store.get(`SELECT count(*) n FROM skills s WHERE ${whereSql}`, ...args)?.n ?? 0);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const rows = store.all(
    `SELECT s.*, v.content_hash AS v_content_hash, v.file_count AS v_file_count, v.total_bytes AS v_total_bytes, v.source_meta AS v_source_meta
     FROM skills s
     LEFT JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.latest_version
     WHERE ${whereSql}
     ORDER BY (CASE s.origin WHEN 'builtin' THEN 0 WHEN 'repository' THEN 1 ELSE 2 END), s.slug ASC, s.id ASC
     LIMIT ? OFFSET ?`,
    ...args, limit, offset,
  );
  const skills = rows.map(row => toSkillSummary(row, {
    content_hash: row.v_content_hash,
    file_count: row.v_file_count,
    total_bytes: row.v_total_bytes,
    source_meta: row.v_source_meta,
  }));
  return { skills, total, next_offset: offset + skills.length < total ? offset + skills.length : null };
}

/** Reads one visible skill with its requested (or latest) immutable version and version history. */
export function getSkill(
  store: Store,
  repositoryId: string,
  skillId: string,
  options: { version?: number; include_content?: boolean } = {},
): { skill: SkillSummary; version: SkillVersionDetail | SkillVersionSummary; versions: SkillVersionSummary[] } {
  const row = visibleSkillRow(store, repositoryId, skillId);
  if (!row) fail(404, 'skill_not_found');
  const latestNum = Number(row!.latest_version);
  const targetVersion = options.version ?? latestNum;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) fail(400, 'invalid_skill_version', 'version');
  const latestRow = store.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?', skillId, latestNum);
  const targetRow = targetVersion === latestNum
    ? latestRow
    : store.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?', skillId, targetVersion);
  if (!targetRow) fail(404, 'skill_version_not_found');
  const historyRows = store.all('SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT 50', skillId);
  return {
    skill: toSkillSummary(row!, latestRow),
    version: options.include_content === false ? toVersionSummary(targetRow!) : toVersionDetail(targetRow!),
    versions: historyRows.map(toVersionSummary),
  };
}

/** Lists paginated immutable versions of one visible skill. */
export function listSkillVersions(
  store: Store,
  repositoryId: string,
  skillId: string,
  options: { offset?: number; limit?: number } = {},
): { skill_id: string; versions: SkillVersionSummary[]; total: number; next_offset: number | null } {
  const row = visibleSkillRow(store, repositoryId, skillId);
  if (!row) fail(404, 'skill_not_found');
  const total = Number(store.get('SELECT count(*) n FROM skill_versions WHERE skill_id=?', skillId)?.n ?? 0);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const rows = store.all(
    'SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT ? OFFSET ?',
    skillId, limit, offset,
  );
  const versions = rows.map(toVersionSummary);
  return { skill_id: skillId, versions, total, next_offset: offset + versions.length < total ? offset + versions.length : null };
}

/**
 * Resolves exact immutable files of one `(skill_id, version)` visible to `repositoryId` (built-in or project-owned).
 * Throws `404 skill_not_found` / `skill_version_not_found` on missing or cross-project references.
 */
export function getSkillVersion(
  store: Store,
  repositoryId: string,
  skillId: string,
  version: number,
): { skill: SkillSummary; version: SkillVersionDetail } {
  const row = visibleSkillRow(store, repositoryId, skillId);
  if (!row) fail(404, 'skill_not_found');
  if (!Number.isSafeInteger(version) || version < 1) fail(400, 'invalid_skill_version', 'version');
  const latestRow = store.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?', skillId, Number(row!.latest_version));
  const versionRow = store.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?', skillId, version);
  if (!versionRow) fail(404, 'skill_version_not_found');
  return { skill: toSkillSummary(row!, latestRow), version: toVersionDetail(versionRow!) };
}

/** Converts a versioned skill's files into `SkillStoreFile[]` rooted at `<slug>/...` for `materializeSkillSet`. */
export function toSkillStoreFiles(slug: string, files: SkillVersionFile[], prefix = ''): SkillStoreFile[] {
  const base = prefix ? `${prefix.replace(/\/+$/, '')}/${slug}` : slug;
  return files.map(file => ({
    path: `${base}/${file.path}`,
    content: file.content,
    sha256: file.sha256,
    bytes: file.bytes,
    encoding: file.encoding,
    ...(file.executable ? { executable: true } : {}),
  }));
}

/** Creates a new console-authored project skill (v1) with strict `SKILL.md` frontmatter and secret redaction. */
export function createConsoleSkill(
  store: Store,
  repositoryId: string,
  input: { slug: unknown; files: unknown },
  actor: string,
): { skill: SkillSummary; version: SkillVersionDetail; created: boolean } {
  if (typeof input.slug !== 'string' || !SKILL_SLUG_PATTERN.test(input.slug)) {
    fail(400, 'invalid_skill_slug', 'slug');
  }
  const slug = input.slug as string;
  const id = projectSkillId('console', repositoryId, slug);
  if (store.get('SELECT 1 FROM skills WHERE id=?', id)) {
    fail(409, 'skill_already_exists', 'slug');
  }
  const redactor = configuredRedactor(store);
  const validated = validateSkillFiles(input.files, { redact: value => redactor.text(value), field: 'files' });
  const result = upsertSkillVersion(store, {
    id,
    scope_kind: 'project',
    repository_id: repositoryId,
    slug,
    origin: 'console',
    source_path: null,
    source_meta: { origin: 'console' },
    validated,
    actor,
  });
  store.audit(actor, 'skill.created', `${id}@${result.version.version}`, repositoryId);
  return result;
}

/** Saves an edit to a console-authored project skill, minting a new immutable version when content changes. */
export function updateConsoleSkill(
  store: Store,
  repositoryId: string,
  skillId: string,
  input: { expected_version: unknown; files: unknown },
  actor: string,
): { skill: SkillSummary; version: SkillVersionDetail; created: boolean } {
  const row = visibleSkillRow(store, repositoryId, skillId);
  if (!row) fail(404, 'skill_not_found');
  if (String(row!.origin) !== 'console') {
    fail(403, 'skill_read_only', 'id', { origin: String(row!.origin) });
  }
  if (!Number.isSafeInteger(input.expected_version) || Number(input.expected_version) < 1) {
    fail(400, 'expected_version_required', 'expected_version');
  }
  const redactor = configuredRedactor(store);
  const validated = validateSkillFiles(input.files, { redact: value => redactor.text(value), field: 'files' });
  const result = upsertSkillVersion(store, {
    id: skillId,
    scope_kind: 'project',
    repository_id: repositoryId,
    slug: String(row!.slug),
    origin: 'console',
    source_path: null,
    source_meta: { origin: 'console' },
    validated,
    actor,
    expectedVersion: Number(input.expected_version),
  });
  if (result.created) {
    store.audit(actor, 'skill.updated', `${skillId}@${result.version.version}`, repositoryId);
  }
  return result;
}

/** Checks whether any active skill bundle in the project's current role configuration references `skillId`. */
export function isSkillReferencedByActiveConfig(store: Store, repositoryId: string, skillId: string): boolean {
  const raw = store.get('SELECT value FROM settings WHERE key=?', 'roles:' + repositoryId)?.value;
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const config = JSON.parse(raw);
    if (!Array.isArray(config?.skills)) return false;
    return config.skills.some((bundle: any) =>
      bundle?.source?.type === 'library'
      && Array.isArray(bundle.source.items)
      && bundle.source.items.some((item: any) => item?.skill_id === skillId));
  } catch {
    return false;
  }
}

/** Deletes a project-owned skill that is not referenced by the active role configuration. */
export function deleteProjectSkill(
  store: Store,
  repositoryId: string,
  skillId: string,
  expectedVersion: unknown,
  actor: string,
): { deleted: true; id: string } {
  const row = visibleSkillRow(store, repositoryId, skillId);
  if (!row) fail(404, 'skill_not_found');
  if (String(row!.scope_kind) !== 'project') fail(403, 'skill_read_only', 'id');
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    fail(400, 'expected_version_required', 'expected_version');
  }
  return store.transaction(() => {
    const current = store.get('SELECT * FROM skills WHERE id=? AND repository_id=?', skillId, repositoryId);
    if (!current) fail(404, 'skill_not_found');
    if (Number(current!.latest_version) !== Number(expectedVersion)) {
      fail(409, 'skill_revision_conflict', 'expected_version', { current_version: Number(current!.latest_version) });
    }
    if (isSkillReferencedByActiveConfig(store, repositoryId, skillId)) {
      fail(409, 'skill_in_use', 'id');
    }
    store.run('DELETE FROM skill_versions WHERE skill_id=?', skillId);
    store.run('DELETE FROM skills WHERE id=? AND repository_id=?', skillId, repositoryId);
    store.audit(actor, 'skill.deleted', skillId, repositoryId);
    return { deleted: true as const, id: skillId };
  });
}

/**
 * Lists discoverable skills from a repository's verified trusted rule cache (`trustedCachedRuleFiles`),
 * annotated with whether each directory is already imported in the project skill library.
 */
export function listTrustedCacheRepositorySkills(
  store: Store,
  repositoryId: string,
): { commit: string; updated_at: string; skills: DiscoveredRepositorySkill[] } | null {
  const cached = trustedCachedRuleFiles(store, repositoryId);
  if (!cached) return null;
  const entryPaths = Object.keys(cached.files).filter(skillEntryPath).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const claimed = new Set<string>();
  const importedByPath = new Map<string, { id: string; latest_version: number }>();
  for (const row of store.all("SELECT id,source_path,latest_version FROM skills WHERE repository_id=? AND origin='repository'", repositoryId)) {
    if (row.source_path) importedByPath.set(String(row.source_path), { id: String(row.id), latest_version: Number(row.latest_version) });
  }
  const discovered: DiscoveredRepositorySkill[] = [];
  for (const entryPath of entryPaths) {
    const dir = entryPath.slice(0, -'/SKILL.md'.length);
    const prefix = dir + '/';
    let fileCount = 0, totalBytes = 0;
    for (const [path, content] of Object.entries(cached.files)) {
      if (claimed.has(path) || !path.startsWith(prefix)) continue;
      claimed.add(path);
      fileCount++;
      totalBytes += Buffer.byteLength(String(content), 'utf8');
    }
    const slug = deriveSkillSlug(dir);
    let name = slug, description = '';
    try {
      const parsed = parseStrictSkillFrontmatter(String(cached.files[entryPath] ?? ''), entryPath);
      name = parsed.name;
      description = parsed.description;
    } catch {
      const fallbackDesc = String(cached.files[entryPath] ?? '').split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
      description = fallbackDesc.slice(0, 200);
    }
    const existing = importedByPath.get(dir) ?? store.get("SELECT id,latest_version FROM skills WHERE id=?", projectSkillId('repository', repositoryId, slug));
    discovered.push({
      path: dir,
      slug,
      name,
      description,
      file_count: fileCount,
      total_bytes: totalBytes,
      imported_skill_id: existing ? String(existing.id) : null,
      imported_version: existing ? Number(existing.latest_version) : null,
    });
  }
  discovered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { commit: cached.sha, updated_at: cached.updated_at, skills: discovered };
}

function normalizeRepoSkillDirPath(raw: unknown, field = 'path'): string {
  if (typeof raw !== 'string') fail(400, 'invalid_skill_path', field);
  let value = (raw as string).trim().replace(/\/+$/, '');
  if (!value) fail(400, 'invalid_skill_path', field);
  if (value.endsWith('/SKILL.md')) value = value.slice(0, -'/SKILL.md'.length);
  if (!value.startsWith('.agents/skills/')) value = `.agents/skills/${value}`;
  const rel = value.slice('.agents/skills/'.length);
  if (!safeSkillSubpath(rel)) fail(400, 'invalid_skill_path', field);
  return `.agents/skills/${rel}`;
}

export interface GitTreeItem {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}

/**
 * Extracts and validates one or all `.agents/skills/<dir>/**` skill directories from a trusted Git tree.
 * Rejects symlinks (`120000`), git submodules (`160000`), path escapes, unknown binaries and size violations.
 */
export async function extractSkillsFromTrustedGitTree(
  tree: GitTreeItem[],
  readBlob: (item: GitTreeItem) => Promise<Buffer>,
  options: { targetPath?: string; all?: boolean } = {},
): Promise<{ path: string; defaultSlug: string; files: SkillFileInput[] }[]> {
  const underSkills = tree.filter(item => item.type !== 'tree' && skillTreePath(String(item.path ?? '')));

  const targetDir = options.targetPath ? normalizeRepoSkillDirPath(options.targetPath, 'path') : null;
  if (targetDir) {
    // Reject if the target path itself, an ancestor symlink/submodule, or anything inside it is unsafe.
    const conflicting = underSkills.filter(item =>
      item.path === targetDir
      || item.path.startsWith(targetDir + '/')
      || (targetDir.startsWith(item.path + '/') && (item.type !== 'blob' || !['100644', '100755'].includes(item.mode))));
    for (const item of conflicting) {
      if (item.type !== 'blob' || !['100644', '100755'].includes(item.mode)) {
        throw Object.assign(new HttpError(400, 'invalid_skill_file', 'path'), {
          detail: `${item.path} 不是普通文件（符号链接或子模块）。`,
        });
      }
      const sub = item.path.slice('.agents/skills/'.length);
      if (!safeSkillSubpath(sub)) {
        throw Object.assign(new HttpError(400, 'invalid_skill_file', 'path'), {
          detail: `${item.path} 不是合法的 .agents/skills/ 文件路径。`,
        });
      }
    }
    const entry = conflicting.find(item => item.path === `${targetDir}/SKILL.md`);
    if (!entry) fail(404, 'skill_source_not_found', 'path');

    // Exclude nested child skill subtrees (directories underneath targetDir that declare their own SKILL.md).
    const nestedSkillDirs = conflicting
      .filter(item => item.path !== `${targetDir}/SKILL.md` && item.path.endsWith('/SKILL.md'))
      .map(item => item.path.slice(0, -'/SKILL.md'.length));
    const owned = conflicting
      .filter(item => item.path.startsWith(targetDir + '/') && !nestedSkillDirs.some(child => item.path.startsWith(child + '/')))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    if (owned.length > SKILL_MAX_FILES) {
      throw Object.assign(new HttpError(400, 'too_many_skill_files', 'path'), {
        detail: `${targetDir} 下共有 ${owned.length} 个文件，超过单 Skill 上限 ${SKILL_MAX_FILES} 个。`,
      });
    }
    let totalBytes = 0;
    const files: SkillFileInput[] = [];
    for (const item of owned) {
      if (typeof item.size === 'number' && item.size > SKILL_MAX_FILE_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', item.path), {
          detail: `${item.path} 超过单文件 512 KiB 上限。`,
        });
      }
      const data = await readBlob(item);
      if (data.length > SKILL_MAX_FILE_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', item.path), {
          detail: `${item.path} 超过单文件 512 KiB 上限。`,
        });
      }
      totalBytes += data.length;
      if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', targetDir), {
          detail: `${targetDir} 总大小超过单 Skill 8 MiB 上限。`,
        });
      }
      const rel = item.path.slice(targetDir.length + 1);
      files.push(classifySkillBlob(rel, data, item.mode === '100755'));
    }
    return [{ path: targetDir, defaultSlug: deriveSkillSlug(targetDir), files }];
  }

  // Whole `.agents/skills/` import: validate all non-tree items under `.agents/skills/`.
  for (const item of underSkills) {
    if (item.type !== 'blob' || !['100644', '100755'].includes(item.mode)) {
      throw Object.assign(new HttpError(400, 'invalid_skill_file', item.path), {
        detail: `${item.path} 不是普通文件（符号链接或子模块）。`,
      });
    }
    if (item.path === '.agents/skills' || !safeSkillSubpath(item.path.slice('.agents/skills/'.length))) {
      throw Object.assign(new HttpError(400, 'invalid_skill_file', item.path), {
        detail: `${item.path} 不是合法的 .agents/skills/ 文件路径。`,
      });
    }
  }
  const roots = underSkills
    .filter(item => skillEntryPath(item.path))
    .map(item => item.path.slice(0, -'/SKILL.md'.length))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (!roots.length) fail(404, 'skill_source_not_found', 'path');

  const claimed = new Set<string>();
  const results: { path: string; defaultSlug: string; files: SkillFileInput[] }[] = [];
  for (const dir of roots) {
    const owned = underSkills
      .filter(item => !claimed.has(item.path) && item.path.startsWith(dir + '/'))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const item of owned) claimed.add(item.path);
    if (owned.length > SKILL_MAX_FILES) {
      throw Object.assign(new HttpError(400, 'too_many_skill_files', dir), {
        detail: `${dir} 下共有 ${owned.length} 个文件，超过单 Skill 上限 ${SKILL_MAX_FILES} 个。`,
      });
    }
    let totalBytes = 0;
    const files: SkillFileInput[] = [];
    for (const item of owned) {
      if (typeof item.size === 'number' && item.size > SKILL_MAX_FILE_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', item.path), {
          detail: `${item.path} 超过单文件 512 KiB 上限。`,
        });
      }
      const data = await readBlob(item);
      if (data.length > SKILL_MAX_FILE_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', item.path), {
          detail: `${item.path} 超过单文件 512 KiB 上限。`,
        });
      }
      totalBytes += data.length;
      if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
        throw Object.assign(new HttpError(400, 'skill_file_too_large', dir), {
          detail: `${dir} 总大小超过单 Skill 8 MiB 上限。`,
        });
      }
      const rel = item.path.slice(dir.length + 1);
      files.push(classifySkillBlob(rel, data, item.mode === '100755'));
    }
    results.push({ path: dir, defaultSlug: deriveSkillSlug(dir), files });
  }
  results.sort((a, b) => (a.path < b.path ? -1 : 1));
  return results;
}

/**
 * Imports one or all `.agents/skills/<name>/**` directories from a repository's trusted base branch
 * (either from the verified `trustedCachedRuleFiles` snapshot or live from GitHub / `GitCache` mirror).
 */
export async function importRepositorySkills(
  store: Store,
  repositoryId: string,
  input: {
    path?: unknown;
    slug?: unknown;
    all?: unknown;
    commit?: unknown;
    source?: unknown;
  },
  actor: string,
  options: { githubUrl?: string; mirror?: Mirror; beforeCommit?: () => void } = {},
): Promise<{
  commit: string;
  branch: string | null;
  source: 'cache' | 'live';
  imported: { skill: SkillSummary; version: SkillVersionDetail; created: boolean }[];
}> {
  const wantAll = input.all === true;
  if (input.all !== undefined && typeof input.all !== 'boolean') fail(400, 'invalid_skill_import', 'all');
  if (wantAll && input.path !== undefined) fail(400, 'invalid_skill_import', 'path');
  if (wantAll && input.slug !== undefined) fail(400, 'invalid_skill_import', 'slug');
  if (!wantAll && input.path === undefined) fail(400, 'invalid_skill_path', 'path');
  const explicitSlug = input.slug !== undefined ? (() => {
    if (typeof input.slug !== 'string' || !SKILL_SLUG_PATTERN.test(input.slug)) fail(400, 'invalid_skill_slug', 'slug');
    return input.slug as string;
  })() : undefined;
  const requestedCommit = input.commit !== undefined ? (() => {
    if (typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) fail(400, 'invalid_skill_import', 'commit');
    return input.commit as string;
  })() : undefined;
  const requestedSource = input.source !== undefined ? (() => {
    if (input.source !== 'cache' && input.source !== 'live') fail(400, 'invalid_skill_import', 'source');
    return input.source as 'cache' | 'live';
  })() : undefined;

  const repo = store.get('SELECT * FROM repositories WHERE id=?', repositoryId);
  if (!repo) fail(404, 'repository_not_found');

  const cached = trustedCachedRuleFiles(store, repositoryId);
  const useCache = requestedSource === 'cache' || (requestedSource === undefined && requestedCommit !== undefined && cached?.sha === requestedCommit);

  let commitSha: string;
  let branchName: string | null = null;
  let sourceUsed: 'cache' | 'live';
  let extracted: { path: string; defaultSlug: string; files: SkillFileInput[] }[];

  if (useCache) {
    if (!cached || (requestedCommit && cached.sha !== requestedCommit)) {
      fail(409, 'skill_source_commit_unavailable', 'commit');
    }
    commitSha = cached!.sha;
    sourceUsed = 'cache';
    const syntheticTree: GitTreeItem[] = Object.keys(cached!.files)
      .filter(p => skillTreePath(p))
      .map(path => ({ path, type: 'blob', mode: '100644', sha: path, size: Buffer.byteLength(String(cached!.files[path] ?? ''), 'utf8') }));
    extracted = await extractSkillsFromTrustedGitTree(
      syntheticTree,
      async item => Buffer.from(String(cached!.files[item.path] ?? ''), 'utf8'),
      wantAll ? { all: true } : { targetPath: String(input.path) },
    );
  } else {
    try {
      const policy = store.get('SELECT base_branch FROM policies WHERE repository_id=?', repositoryId);
      const github = new GitHub(store, repo!, new Redactor(), async () => {}, options.githubUrl);
      await github.connect(false);
      const configuredBranch = String(policy?.base_branch || '').trim();
      let branch = configuredBranch || github.defaultBranch;
      let ref = await github.ref(branch);
      if (!ref && configuredBranch && configuredBranch !== github.defaultBranch) {
        branch = github.defaultBranch;
        ref = await github.ref(branch);
      }
      if (!ref) fail(409, 'repository_has_no_commit');
      commitSha = ref!.object.sha;
      branchName = branch;
      // Security invariant: never import from an arbitrary untrusted PR/unmerged commit SHA.
      if (requestedCommit && requestedCommit !== commitSha) {
        fail(409, 'skill_source_commit_unavailable', 'commit');
      }
      sourceUsed = 'live';
      const listing = options.mirror?.has(commitSha) ? await options.mirror.listing(commitSha) : null;
      const tree = (listing ?? await repositoryTree(github, (await github.request('GET', github.path('/git/commits/' + commitSha))).tree.sha)).tree as GitTreeItem[];
      const readBlob = async (item: GitTreeItem): Promise<Buffer> => {
        if (listing && options.mirror) {
          const fromMirror = await options.mirror.blob(item.sha);
          if (fromMirror) return fromMirror;
        }
        const blob = await github.request('GET', github.path('/git/blobs/' + item.sha));
        return Buffer.from(String(blob.content ?? ''), 'base64');
      };
      extracted = await extractSkillsFromTrustedGitTree(
        tree,
        readBlob,
        wantAll ? { all: true } : { targetPath: String(input.path) },
      );
    } catch (error) {
      if (error instanceof TaskError) {
        const status = error.state === 'waiting_permission' ? 403 : error.state === 'waiting_configuration' ? 409 : 503;
        throw Object.assign(new HttpError(status, error.code), error.detail ? { detail: error.detail } : {});
      }
      throw error;
    }
  }

  // Validate all extracted skills before committing any row so multi-skill import is atomic.
  const usedSlugs = new Set<string>();
  const prepared = extracted.map(entry => {
    let slug = explicitSlug ?? entry.defaultSlug;
    if (!explicitSlug && usedSlugs.has(slug)) {
      slug = `${slug.slice(0, 56)}-${sha256Text(entry.path).slice(0, 7)}`;
    }
    if (usedSlugs.has(slug)) fail(400, 'duplicate_skill_slug', 'slug');
    usedSlugs.add(slug);
    const validated = validateSkillFiles(entry.files, { field: entry.path });
    return {
      id: projectSkillId('repository', repositoryId, slug),
      slug,
      sourcePath: entry.path,
      validated,
    };
  });

  const imported = store.transaction(() => {
    options.beforeCommit?.();
    return prepared.map(item => {
      const res = upsertSkillVersion(store, {
        id: item.id,
        scope_kind: 'project',
        repository_id: repositoryId,
        slug: item.slug,
        origin: 'repository',
        source_path: item.sourcePath,
        source_meta: {
          commit: commitSha,
          ...(branchName ? { branch: branchName } : {}),
          path: item.sourcePath,
          source: sourceUsed,
        },
        validated: item.validated,
        actor,
      });
      if (res.created) {
        store.audit(actor, 'skill.imported', `${item.id}@${res.version.version}`, repositoryId);
      }
      return res;
    });
  });

  return { commit: commitSha, branch: branchName, source: sourceUsed, imported };
}

/**
 * Resolves a library-backed skill bundle's items (`[{ skill_id, version }]`) for `repositoryId`,
 * enforcing scope isolation, deduplicating identical `(skill_id, version)` entries, and rejecting
 * conflicting versions or origins for the same skill slug with `400 skill_version_conflict`.
 */
export function resolveLibraryBundleItems(
  store: Store,
  repositoryId: string,
  rawItems: unknown,
  field: string,
): {
  items: { skill_id: string; version: number; slug: string; origin: SkillOrigin; content_hash: string }[];
  files: { path: string; content: string; encoding?: SkillFileEncoding; executable?: boolean }[];
} {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > LIBRARY_BUNDLE_MAX_ITEMS) {
    return fail(400, 'invalid_skill_source', field);
  }
  const seenExact = new Set<string>();
  const bySlug = new Map<string, { skill_id: string; version: number; origin: SkillOrigin; field: string }>();
  const items: { skill_id: string; version: number; slug: string; origin: SkillOrigin; content_hash: string }[] = [];
  const files: { path: string; content: string; encoding?: SkillFileEncoding; executable?: boolean }[] = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (let i = 0; i < rawItems.length; i++) {
    const rawEntry = rawItems[i];
    const itemField = `${field}[${i}]`;
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return fail(400, 'invalid_skill_source', itemField);
    const entry = rawEntry as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!['skill_id', 'version'].includes(key)) fail(400, 'unknown_field', `${itemField}.${key}`);
    }
    if (typeof entry.skill_id !== 'string' || !SKILL_ID_PATTERN.test(entry.skill_id)) {
      return fail(400, 'invalid_skill_id', `${itemField}.skill_id`);
    }
    if (!Number.isSafeInteger(entry.version) || Number(entry.version) < 1) {
      return fail(400, 'invalid_skill_version', `${itemField}.version`);
    }
    const skillId: string = entry.skill_id;
    const versionNum = Number(entry.version);
    const exactKey = `${skillId}@${versionNum}`;
    if (seenExact.has(exactKey)) continue;

    let resolved: { skill: SkillSummary; version: SkillVersionDetail };
    try {
      resolved = getSkillVersion(store, repositoryId, skillId, versionNum);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        fail(400, error.code, `${itemField}.${error.code === 'skill_version_not_found' ? 'version' : 'skill_id'}`);
      }
      throw error;
    }

    const prior = bySlug.get(resolved.skill.slug);
    if (prior && (prior.skill_id !== skillId || prior.version !== versionNum)) {
      fail(400, 'skill_version_conflict', itemField, {
        slug: resolved.skill.slug,
        existing: { skill_id: prior.skill_id, version: prior.version, origin: prior.origin },
        conflicting: { skill_id: skillId, version: versionNum, origin: resolved.skill.origin },
      });
    }
    totalFiles += resolved.version.file_count;
    if (totalFiles > LIBRARY_BUNDLE_MAX_FILES) {
      throw Object.assign(new HttpError(400, 'too_many_skill_files', field), {
        detail: `单个技能库技能包最多包含 ${LIBRARY_BUNDLE_MAX_FILES} 个文件。`,
      });
    }
    totalBytes += resolved.version.total_bytes;
    if (totalBytes > LIBRARY_BUNDLE_MAX_BYTES) {
      throw Object.assign(new HttpError(400, 'skill_file_too_large', field), {
        detail: `单个技能库技能包总大小超过 16 MiB 上限。`,
      });
    }
    seenExact.add(exactKey);
    bySlug.set(resolved.skill.slug, { skill_id: skillId, version: versionNum, origin: resolved.skill.origin, field: itemField });
    items.push({
      skill_id: skillId,
      version: versionNum,
      slug: resolved.skill.slug,
      origin: resolved.skill.origin,
      content_hash: resolved.version.content_hash,
    });
    for (const file of resolved.version.files) {
      files.push({
        path: `${resolved.skill.slug}/${file.path}`,
        content: file.content,
        ...(file.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
        ...(file.executable ? { executable: true } : {}),
      });
    }
  }
  return { items, files };
}
