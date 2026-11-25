import type { IncomingMessage, ServerResponse } from 'node:http';
import { fail, fields, HttpError, object, type Json } from '../core/security.js';
import type { FileSyncEngine } from './engine.js';
import { isSyncNamespaceName } from './namespaces.js';
import { assertSha256 } from './paths.js';
import type { SyncTokenService } from './storage.js';
import type { SyncMode, SyncNamespaceName, SyncPrincipal } from './types.js';

export type SyncAuthenticator = (
  req: IncomingMessage,
  namespace: SyncNamespaceName,
  scope: string,
  requiredMode: SyncMode,
) => Promise<SyncPrincipal> | SyncPrincipal;

export interface SyncHttpHandlerOptions {
  engine: FileSyncEngine;
  tokens: SyncTokenService;
  authenticate?: SyncAuthenticator;
  maxJsonBodyBytes?: number;
}

const DEFAULT_MAX_JSON_BODY = 32 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage, limit: number): Promise<Json> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    fail(415, 'json_required');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > limit) fail(413, 'payload_too_large');
    chunks.push(buf);
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(400, 'invalid_json');
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

interface ParsedSyncRoute {
  namespace: SyncNamespaceName;
  scope: string;
  action: 'manifest' | 'blobs_fetch' | 'blobs_put' | 'blob_get' | 'commit' | 'conflicts' | 'history';
  sha256?: string;
}

/**
 * Matches `/sync/:namespace/:scope/(manifest|blobs/fetch|blobs/put|blobs/:sha256|commit|conflicts|history)`.
 * Supports both URL-encoded scopes (e.g. `projects%2F42`, `linux%2Fx64`) and slash-delimited scopes
 * (e.g. `projects/42`, `linux/x64`) because action tails are unambiguous.
 */
export function parseSyncRoute(pathname: string): ParsedSyncRoute | null {
  if (!pathname.startsWith('/sync/')) return null;
  const rest = pathname.slice('/sync/'.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash <= 0) return null;
  const rawNamespace = rest.slice(0, firstSlash);
  if (!isSyncNamespaceName(rawNamespace)) return fail(404, 'sync_namespace_not_found');
  const namespace: SyncNamespaceName = rawNamespace;
  const tail = rest.slice(firstSlash + 1);

  const matchTail = (
    suffix: string,
    action: ParsedSyncRoute['action'],
  ): ParsedSyncRoute | null => {
    if (!tail.endsWith(suffix)) return null;
    const rawScope = tail.slice(0, -suffix.length);
    if (!rawScope) return fail(400, 'sync_invalid_scope');
    let scope: string;
    try {
      scope = decodeURIComponent(rawScope);
    } catch {
      return fail(400, 'sync_invalid_scope');
    }
    return { namespace, scope, action };
  };

  const singleBlobMatch = /^(.+)\/blobs\/([a-f0-9]{64})$/.exec(tail);
  if (singleBlobMatch) {
    let scope: string;
    try {
      scope = decodeURIComponent(singleBlobMatch[1]!);
    } catch {
      return fail(400, 'sync_invalid_scope');
    }
    return { namespace, scope, action: 'blob_get', sha256: singleBlobMatch[2]! };
  }

  return (
    matchTail('/manifest', 'manifest') ??
    matchTail('/blobs/fetch', 'blobs_fetch') ??
    matchTail('/blobs/put', 'blobs_put') ??
    matchTail('/commit', 'commit') ??
    matchTail('/conflicts', 'conflicts') ??
    matchTail('/history', 'history')
  );
}

/**
 * Serves the control-plane `/sync/:namespace/:scope/...` HTTP endpoints with scoped Bearer auth.
 * Returns `true` if the request matched `/sync/*` and was handled, `false` otherwise.
 */
export function createSyncHttpHandler(options: SyncHttpHandlerOptions) {
  const { engine, tokens } = options;
  const maxBody = options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY;

  const authenticate: SyncAuthenticator =
    options.authenticate ??
    ((req, namespace, scope, requiredMode) =>
      tokens.authenticate(req.headers.authorization, namespace, scope, requiredMode));

  return async function handleSyncHttp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!url.pathname.startsWith('/sync/')) return false;
    const route = parseSyncRoute(url.pathname);
    if (!route) return fail(404, 'sync_route_not_found');

    const method = req.method || 'GET';
    const isWriteAction = route.action === 'blobs_put' || route.action === 'commit';
    const principal = await authenticate(req, route.namespace, route.scope, isWriteAction ? 'rw' : 'ro');

    if (route.action === 'manifest') {
      if (method !== 'GET') fail(405, 'method_not_allowed');
      const sinceRaw = url.searchParams.get('since_rev');
      const sinceRev = sinceRaw === null || sinceRaw === '' ? 0 : Number(sinceRaw);
      if (!Number.isSafeInteger(sinceRev) || sinceRev < 0) fail(400, 'sync_invalid_revision');
      const pathsParam = url.searchParams.getAll('path');
      const csvPaths = (url.searchParams.get('paths') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const paths = [...pathsParam, ...csvPaths];
      const includeDeleted = url.searchParams.get('include_deleted') === '1';
      const manifest = await engine.manifest(route.namespace, route.scope, {
        sinceRev,
        ...(paths.length ? { paths } : {}),
        includeDeleted,
      });
      sendJson(res, 200, manifest);
      return true;
    }

    if (route.action === 'blob_get') {
      if (method !== 'GET') fail(405, 'method_not_allowed');
      const sha = assertSha256(route.sha256);
      const hintPath = url.searchParams.get('path') || undefined;
      const data = await engine.getBlob(route.namespace, route.scope, sha, hintPath);
      if (!data) return fail(404, 'sync_blob_not_found');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
        'X-Sync-Sha256': sha,
      });
      res.end(data);
      return true;
    }

    if (route.action === 'blobs_fetch') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const body = await readJsonBody(req, Math.min(maxBody, 1024 * 1024));
      fields(body, ['hashes']);
      if (!Array.isArray(body.hashes)) fail(400, 'sync_invalid_hashes');
      const result = await engine.fetchBlobs(route.namespace, route.scope, body.hashes as string[]);
      sendJson(res, 200, result);
      return true;
    }

    if (route.action === 'blobs_put') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const body = await readJsonBody(req, maxBody);
      fields(body, ['blobs']);
      if (!Array.isArray(body.blobs)) fail(400, 'sync_invalid_blob');
      const result = await engine.putBlobs(route.namespace, route.scope, body.blobs as any[]);
      sendJson(res, 200, result);
      return true;
    }

    if (route.action === 'commit') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const body = await readJsonBody(req, Math.min(maxBody, 4 * 1024 * 1024));
      fields(body, [
        'mode',
        'actor',
        'actor_tag',
        'skip_if_human_edited',
        'changes',
        'path',
        'base_revision',
        'base_sha256',
        'content_sha256',
        'deleted',
      ]);
      const mode = body.mode === undefined ? 'interactive' : body.mode;
      if (mode !== 'interactive' && mode !== 'background') return fail(400, 'sync_invalid_mode');
      const changes = Array.isArray(body.changes)
        ? (body.changes as any[])
        : typeof body.path === 'string'
          ? [
              {
                path: body.path,
                base_revision: body.base_revision,
                base_sha256: body.base_sha256,
                content_sha256: body.content_sha256,
                deleted: body.deleted,
              },
            ]
          : fail(400, 'sync_invalid_changes');

      // Actor identity is anchored to the authenticated sync token principal; callers cannot spoof another actor.
      const actor = principal.actor;
      const actorTag = typeof body.actor_tag === 'string' && body.actor_tag.trim()
        ? body.actor_tag.trim()
        : principal.actorTag;

      const result = await engine.commit(route.namespace, route.scope, {
        mode,
        actor,
        actor_tag: actorTag,
        skip_if_human_edited: body.skip_if_human_edited === true,
        changes,
      });
      sendJson(res, result.ok ? 200 : 409, result);
      return true;
    }

    if (route.action === 'conflicts') {
      if (method !== 'GET') fail(405, 'method_not_allowed');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null || limitRaw === '' ? 50 : Number(limitRaw);
      const conflicts = engine.listConflicts(route.namespace, route.scope, limit);
      sendJson(res, 200, { namespace: route.namespace, scope: route.scope, conflicts });
      return true;
    }

    if (route.action === 'history') {
      if (method !== 'GET') fail(405, 'method_not_allowed');
      const rel = url.searchParams.get('path') || '';
      const history = await engine.fileHistory(route.namespace, route.scope, rel);
      sendJson(res, 200, { namespace: route.namespace, scope: route.scope, ...history });
      return true;
    }

    return false;
  };
}
