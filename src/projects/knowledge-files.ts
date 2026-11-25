import type { Store } from '../storage/database.js';
import type { Manager } from './service.js';
import { repository, type Actor } from '../app/auth.js';
import { configuredRedactor } from '../core/redaction.js';
import { fail, fields, type Json } from '../core/security.js';
import { memoryAuthorize } from '../memory/access.js';
import { migrateLegacyProjectMemories } from '../memory/migration.js';

// A control character (NUL, the rest of C0, DEL, the C1 range and the two line separators) cannot be shown or typed in
// the console, so a name or a path carrying one is refused before any filesystem request, as the manager does.
const controlCharacter = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Match the manager's relative-path contract before sending any filesystem request.
const filePath = (value: unknown, root = false): string => {
  if (root && value === '') return '';
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /^[A-Za-z]:\//.test(value) || value.includes('\\') || controlCharacter.test(value)) fail(400, 'invalid_note_path');
  const parts = (value as string).split('/');
  if (parts.length > 32 || parts.some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()) || /^\.(?:write|expired|sync)-/.test(part) || Buffer.byteLength(part) > 255)) fail(400, 'invalid_note_path');
  return value as string;
};
// A legacy id is a physical file id by form: an old name that carries a control character still round-trips, and the
// manager reports that file as quarantined instead of this route misrouting the request as an unknown id. A name the
// manager refuses for being internal (`.`, `..`, `.git`, `.write-*`, `.expired-*`, `.sync-*`) is not a file this route can address,
// so it stays unknown here and reads as 404 like any other unknown id, instead of being forwarded to answer 400.
const internalName = (name: string) => ['.', '..', '.git'].includes(name.toLowerCase()) || /^\.(?:write|expired|sync)-/.test(name);
const physicalId = (id: string) => {
  if (/^f:[a-f0-9]{32}$/.test(id)) return true;
  if (!/^n:[a-zA-Z0-9_-]+$/.test(id)) return false;
  try {
    const name = Buffer.from(id.slice(2), 'base64url').toString('utf8');
    return !name.includes('/') && !internalName(name) && 'n:' + Buffer.from(name).toString('base64url') === id;
  } catch {
    return false;
  }
};

/** Single-source physical project knowledge files API backed by the project notes volume (`../notes/`). */
export async function knowledgeFilesApi(store: Store, manager: Manager | undefined, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
  const match = /^\/api\/repositories\/([^/]+)\/(knowledge-files|knowledge-directories)(?:\/([^/]+))?(?:\/(versions|restore|move))?$/.exec(url.pathname);
  if (!match) return;
  const repo = match[1]!, directories = match[2] === 'knowledge-directories', operation = match[4];
  repository(store, user, repo);
  const access = { actor: user.context! }, authorize = () => { repository(store, user, repo); memoryAuthorize(access, repo, method !== 'GET'); };
  authorize();
  const writable = () => {
    try { memoryAuthorize(access, repo, true); return true; }
    catch (error) { if ((error as any).code === 'capability_forbidden') return false; throw error; }
  };
  const present = (file: any) => {
    const readonly = !!file.readonly || !writable();
    return { ...file, readonly, can_edit: !readonly && file.can_edit !== false, can_move: !readonly };
  };
  const call = async (verb: string, path: string, body?: Json) => {
    if (!manager) fail(503, 'manager_unavailable');
    authorize();
    const result = await manager!.call(verb, '/v1/projects/' + repo + '/file-tree' + path, body);
    authorize();
    return result;
  };
  if (directories) {
    if (match[3] || operation) return fail(404, 'not_found');
    if (!['POST', 'DELETE'].includes(method)) return fail(405, 'method_not_allowed');
    fields(input, ['path']);
    const path = filePath(input.path), result = await call(method, '/directories', { path });
    store.audit(user.id, 'knowledge.directory.' + (method === 'POST' ? 'created' : 'deleted'), path, repo);
    return result;
  }
  if (!match[3]) {
    if (method === 'GET') {
      const directory = filePath(url.searchParams.get('directory') ?? '', true);
      const query = url.searchParams.get('query') ?? '';
      const trash = url.searchParams.get('deleted_only') === '1';
      const include = url.searchParams.get('include_deleted') === '1';
      if (query.length > 200) fail(400, 'invalid_note_query');
      const recursive = url.searchParams.get('recursive') === '1';
      if (manager) await migrateLegacyProjectMemories(store, manager, repo);
      const params = new URLSearchParams({ directory, query, include_deleted: include ? '1' : '0', deleted_only: trash ? '1' : '0' });
      if (recursive) params.set('recursive', '1');
      if (url.searchParams.get('preview') === '1') params.set('preview', '1');
      const disk = await call('GET', '?' + params);
      return { ...disk, can_write: writable(), files: (disk.files || []).map(present).sort((a: any, b: any) => a.path.localeCompare(b.path)) };
    }
    if (method === 'POST') {
      fields(input, ['name', 'path', 'content']);
      if (input.name !== undefined && input.path !== undefined) fail(400, 'invalid_note_path');
      if (input.name !== undefined && (typeof input.name !== 'string' || controlCharacter.test(input.name))) fail(400, 'invalid_note_name');
      const path = filePath(input.path ?? input.name);
      if (input.name !== undefined && path.includes('/')) fail(400, 'invalid_note_name');
      if (typeof input.content !== 'string') return fail(400, 'invalid_note_content');
      const content = configuredRedactor(store).text(input.content);
      const file = await call('POST', '', { path, content, actor: 'user:' + access.actor.principal_id });
      store.audit(user.id, 'knowledge.file.saved', path, repo);
      return { file: present(file) };
    }
    return fail(405, 'method_not_allowed');
  }
  let id: string;
  try { id = decodeURIComponent(match[3]); } catch { return fail(400, 'invalid_note_id'); }
  const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) fail(400, 'invalid_note_revision');
  if (method !== 'GET') {
    fields(input, operation === 'move' ? ['path', 'expected_revision'] : operation === 'restore' ? ['revision', 'expected_revision'] : method === 'DELETE' ? ['expected_revision'] : ['content', 'expected_revision']);
    if (!Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 1) fail(400, 'invalid_note_revision');
    if (operation === 'move') filePath(input.path);
  }
  if (!physicalId(id)) return fail(404, 'note_not_found');
  const path = '/' + encodeURIComponent(id);
  if (method === 'GET' && operation === 'versions') return await call('GET', path + '/versions');
  if (method === 'GET' && !operation) return { file: present(await call('GET', path + (revision === undefined ? '' : '?revision=' + revision))) };
  if ((method === 'PUT' && !operation) || (method === 'DELETE' && !operation) || (method === 'POST' && ['restore', 'move'].includes(operation!))) {
    const payload: Json = method === 'PUT' && !operation
      ? { ...input, content: typeof input.content === 'string' ? configuredRedactor(store).text(input.content) : input.content, actor: 'user:' + access.actor.principal_id }
      : { ...input, actor: 'user:' + access.actor.principal_id };
    const file = await call(method, path + (operation ? '/' + operation : ''), payload);
    store.audit(user.id, 'knowledge.file.' + (method === 'DELETE' ? 'deleted' : operation === 'restore' ? 'restored' : operation === 'move' ? 'moved' : 'saved'), file.path, repo);
    return { file: present(file) };
  }
  return fail(405, 'method_not_allowed');
}
