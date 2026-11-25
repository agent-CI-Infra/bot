import { createHash } from 'node:crypto';
import { configuredRedactor } from '../core/redaction.js';
import { memoryAuthorize, taskMemoryAccess } from './access.js';
import { migrateLegacyProjectMemories, type NotesManagerLike } from './migration.js';
import type { Store, Row } from '../storage/database.js';
import { randomId, fail } from '../core/security.js';
import { traceEvent } from '../tasks/trace.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.aws|credentials(?:\.(?!ts$|tsx$|js$|mjs$|cjs$|jsx$|py$|md$|mdx$|html$|css$|scss$|vue$|svelte$|rs$|go$|java$|kt$|rb$|php$|sh$)[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:\/|$)/i;

export interface NotesBridge {
  call?: (key: string, request: any) => Promise<any>;
  manager?: NotesManagerLike;
}

export function knowledgePath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 500 || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.includes('\\') || CONTROL_CHARACTER.test(path)) {
    fail(400, 'invalid_memory_path');
  }
  const parts = (path as string).split('/');
  if (parts.length > 32 || parts.some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()) || /^\.(?:write|expired|sync)-/.test(part) || Buffer.byteLength(part) > 255)) {
    fail(400, 'invalid_memory_path');
  }
  if (SENSITIVE_PATH.test(path as string)) fail(400, 'memory_sensitive_path');
  return path as string;
}

export function isPhysicalNoteId(id: string): boolean {
  if (/^f:[a-f0-9]{32}$/.test(id)) return true;
  if (!/^n:[a-zA-Z0-9_-]+$/.test(id)) return false;
  try {
    const name = Buffer.from(id.slice(2), 'base64url').toString('utf8');
    return !!name && !name.includes('/') && !['.', '..', '.git'].includes(name.toLowerCase()) && !/^\.(?:write|expired|sync)-/.test(name) && 'n:' + Buffer.from(name).toString('base64url') === id;
  } catch {
    return false;
  }
}

export function stripNotesPrefix(raw: string): string {
  return raw.startsWith('../notes/') ? raw.slice('../notes/'.length) : raw;
}

export function notePathFromKey(key: string): string {
  const stripped = stripNotesPrefix(key.trim());
  if (!stripped || stripped.length > 240) fail(400, 'invalid_memory_path');
  const segments = stripped.split('/').map(seg => seg.replace(/:/g, '-').trim());
  if (segments.some(seg => !seg)) fail(400, 'invalid_memory_path');
  const last = segments.at(-1)!;
  if (!/\.(?:md|txt|json|ya?ml|toml|ini|conf|csv|tsv|log|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|go|rs|java|rb|php)$/i.test(last)) {
    segments[segments.length - 1] = last + '.md';
  }
  return knowledgePath(segments.join('/'));
}

export interface SearchProjectNotesOptions {
  path?: string;
  offset?: number;
  limit?: number;
}

export async function searchProjectNotes(
  manager: NotesManagerLike,
  repo: string,
  query = '',
  options: SearchProjectNotesOptions = {},
) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || query.length > 200) {
    fail(400, 'invalid_memory_query');
  }
  const tree = await manager.call('GET', `/v1/projects/${repo}/file-tree?` + new URLSearchParams({
    directory: '',
    query: query.slice(0, 200),
    include_deleted: '0',
    deleted_only: '0',
    recursive: '1',
    preview: '1',
  }));
  const prefix = options.path ? stripNotesPrefix(options.path) : '';
  const allFiles = (Array.isArray(tree?.files) ? tree.files : []).filter((f: any) => !prefix || String(f.path || '').startsWith(prefix));
  const slice = allFiles.slice(offset, offset + limit);
  return {
    items: slice.map((f: any) => ({
      id: f.id,
      path: f.path,
      name: f.name,
      directory: f.directory ?? '',
      revision: f.revision,
      bytes: f.bytes ?? 0,
      actor: f.actor ?? null,
      created_at: f.created_at ?? null,
      preview: typeof f.preview === 'string' ? f.preview : null,
      ...(f.match_in ? { match_in: f.match_in } : {}),
      ...(f.binary ? { binary: true } : {}),
    })),
    total: allFiles.length,
    next_offset: offset + slice.length < allFiles.length ? offset + slice.length : null,
    search_scope: tree?.search_scope ?? 'all_directories',
    scan_limited: Boolean(tree?.scan_limited),
  };
}

export async function resolveNoteId(manager: NotesManagerLike, repo: string, idOrPath: string): Promise<string> {
  if (isPhysicalNoteId(idOrPath)) return idOrPath;
  const rel = knowledgePath(stripNotesPrefix(idOrPath));
  const listed = await manager.call('GET', `/v1/projects/${repo}/file-tree?` + new URLSearchParams({
    directory: '',
    query: '',
    include_deleted: '1',
    deleted_only: '0',
    recursive: '1',
  }));
  const found = (Array.isArray(listed?.files) ? listed.files : []).find((f: any) => f.path === rel);
  if (!found?.id) fail(404, 'note_not_found');
  return String(found.id);
}

export async function readProjectNote(
  manager: NotesManagerLike,
  repo: string,
  idOrPath: string,
  revision?: number,
) {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) fail(400, 'invalid_note_revision');
  const id = await resolveNoteId(manager, repo, idOrPath);
  return manager.call('GET', `/v1/projects/${repo}/file-tree/${encodeURIComponent(id)}` + (revision === undefined ? '' : `?revision=${revision}`));
}

export async function projectNoteVersions(manager: NotesManagerLike, repo: string, idOrPath: string) {
  const id = await resolveNoteId(manager, repo, idOrPath);
  return manager.call('GET', `/v1/projects/${repo}/file-tree/${encodeURIComponent(id)}/versions`);
}

export async function saveProjectNote(
  store: Store,
  manager: NotesManagerLike,
  repo: string,
  input: { id?: string; path?: string; content: string; expected_revision?: number },
  actor: string,
) {
  if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 256 * 1024) fail(400, 'invalid_note_content');
  const redacted = configuredRedactor(store).text(input.content);
  if (input.id && isPhysicalNoteId(input.id)) {
    const expected = input.expected_revision;
    if (!Number.isSafeInteger(expected) || expected! < 1) fail(400, 'invalid_note_revision');
    return manager.call('PUT', `/v1/projects/${repo}/file-tree/${encodeURIComponent(input.id)}`, {
      content: redacted,
      expected_revision: expected,
      actor,
    });
  }
  const rel = knowledgePath(stripNotesPrefix(String(input.path ?? '')));
  const listed = await manager.call('GET', `/v1/projects/${repo}/file-tree?` + new URLSearchParams({
    directory: '',
    query: '',
    include_deleted: '1',
    deleted_only: '0',
    recursive: '1',
  }));
  const existing = (Array.isArray(listed?.files) ? listed.files : []).find((f: any) => f.path === rel);
  if (existing?.id) {
    const currentRev = Number(existing.revision);
    if (input.expected_revision !== undefined && input.expected_revision !== currentRev) fail(409, 'note_revision_changed');
    return manager.call('PUT', `/v1/projects/${repo}/file-tree/${encodeURIComponent(existing.id)}`, {
      content: redacted,
      expected_revision: currentRev,
      actor,
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== 0) fail(409, 'note_revision_changed');
  return manager.call('POST', `/v1/projects/${repo}/file-tree`, {
    path: rel,
    content: redacted,
    actor,
    create_parents: true,
  });
}

const tool = (name: string, description: string, properties: any, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const memoryTools = [
  tool(
    'search_project_memory',
    'Search shared project notes in ../notes/ by filename, path or text content; previews are excerpts, not proof of reading.',
    { query: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
  ),
  tool(
    'read_project_memory',
    'Read one exact project note file revision from ../notes/ by file id or relative path.',
    { id: { type: 'string' }, revision: { type: 'integer' }, offset: { type: 'integer' } },
    ['id'],
  ),
  tool(
    'remember_project_memory',
    'Save or update a shared project note file in ../notes/ visible to all project roles and the console; cannot publish to GitHub or finish this task.',
    {
      path: { type: 'string', description: 'Relative path inside ../notes/ (e.g. guides/retry.md).' },
      key: { type: 'string', description: 'Short note key mapped to a Markdown file in ../notes/ when path is omitted.' },
      body: { type: 'string', description: 'UTF-8 note content to save.' },
      expected_revision: { type: 'integer', description: 'Optional optimistic concurrency revision.' },
    },
    ['body'],
  ),
];

export async function memoryTool(store: Store, task: Row, name: string, args: any, notes?: NotesBridge): Promise<any> {
  try {
    const access = taskMemoryAccess(store, task);
    const repo = String(task.repository_id);
    if (name === 'search_project_memory') {
      memoryAuthorize(access, repo);
      if (!notes?.manager) return { error: 'notes_unavailable' };
      await migrateLegacyProjectMemories(store, notes.manager, repo);
      const result = await searchProjectNotes(notes.manager, repo, String(args?.query ?? ''), {
        path: typeof args?.path === 'string' ? args.path : undefined,
        offset: args?.offset,
        limit: args?.limit,
      });
      traceEvent(store, task.id, 'memory_search', {
        query: String(args?.query ?? ''),
        path: args?.path ?? null,
        returned: result.items.map((m: any) => ({ id: m.id, path: m.path, revision: m.revision })),
      }, task.trace_run_id);
      return result;
    }

    if (name === 'read_project_memory') {
      memoryAuthorize(access, repo);
      const offset = args?.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) return { error: 'invalid_memory_offset' };
      const rawId = String(args?.id ?? '');
      if (!rawId) return { error: 'note_not_found' };
      let fileData: any;
      if (notes?.manager) {
        await migrateLegacyProjectMemories(store, notes.manager, repo);
        fileData = await readProjectNote(notes.manager, repo, rawId, args?.revision);
      } else if (notes?.call) {
        const rel = knowledgePath(stripNotesPrefix(rawId));
        fileData = await notes.call('memory-note:' + randomId(), { type: 'workspace_read', path: '../notes/' + rel });
        if (fileData?.error) return { error: fileData.error };
        fileData = { id: rawId, path: rel, revision: Number(args?.revision ?? 1), content: fileData.content };
      } else {
        return { error: 'notes_unavailable' };
      }
      if (fileData?.error) return { error: fileData.error };
      if (fileData?.deleted) return { error: 'note_not_found' };
      if (fileData?.binary || fileData?.availability === 'unsupported_format') {
        return { id: fileData.id ?? rawId, path: fileData.path ?? rawId, revision: Number(fileData.revision ?? 1), availability: 'unsupported_format' };
      }
      const body = String(fileData?.content ?? '');
      const rev = Number(fileData?.revision ?? args?.revision ?? 1);
      const id = String(fileData?.id ?? rawId);
      const slice = body.slice(offset, offset + 8000);
      traceEvent(store, task.id, 'memory_read', {
        id,
        path: fileData?.path ?? rawId,
        revision: rev,
        memory_source: `notes:${id}:${rev}`,
        availability: 'available',
        content_sha256: hash(slice),
        offset,
        characters: slice.length,
        role: access.role,
      }, task.trace_run_id);
      return {
        id,
        path: fileData?.path ?? rawId,
        name: fileData?.name,
        revision: rev,
        current_revision: fileData?.current_revision ?? rev,
        historical: Boolean(fileData?.historical),
        availability: 'available',
        body: slice,
        offset,
        next_offset: offset + 8000 < body.length ? offset + 8000 : null,
      };
    }

    if (name !== 'remember_project_memory') return { error: 'memory_tool_not_found' };
    memoryAuthorize(access, repo, true);
    if (typeof args?.body !== 'string' || !args.body.trim()) return { error: 'invalid_note_content' };
    const targetPath = typeof args?.path === 'string' && args.path.trim()
      ? knowledgePath(stripNotesPrefix(args.path.trim()))
      : typeof args?.key === 'string' && args.key.trim()
        ? notePathFromKey(args.key)
        : fail(400, 'invalid_memory_path');

    let saved: any;
    const actor = 'agent:' + task.id;
    if (notes?.manager) {
      saved = await saveProjectNote(store, notes.manager, repo, {
        path: targetPath,
        content: args.body,
        expected_revision: args?.expected_revision,
      }, actor);
    } else if (notes?.call) {
      const redacted = configuredRedactor(store).text(args.body);
      const wrote = await notes.call('memory-write:' + randomId(), {
        type: 'workspace_write',
        path: '../notes/' + targetPath,
        base64: Buffer.from(redacted).toString('base64'),
        offset: 0,
        final: true,
        mode: '100644',
      });
      if (wrote?.error) return { error: wrote.error };
      saved = { id: '../notes/' + targetPath, path: targetPath, revision: 1 };
    } else {
      return { error: 'notes_unavailable' };
    }
    traceEvent(store, task.id, 'memory_recorded', { id: saved.id, path: saved.path ?? targetPath, revision: saved.revision }, task.trace_run_id);
    return { id: saved.id, path: saved.path ?? targetPath, revision: saved.revision };
  } catch (error) {
    const code = (error as any)?.code || ((error as any)?.status ? String((error as any).message || '') : '') || 'memory_operation_failed';
    traceEvent(store, task.id, 'memory_fault', { operation: name, code }, task.trace_run_id);
    return { error: code };
  }
}
