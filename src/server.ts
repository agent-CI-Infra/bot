import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Store } from './storage/database.js';
import { actor, publicActor, session } from './app/auth.js';
import { management } from './app/management.js';
import { models } from './app/models.js';
import { queries } from './app/queries.js';
import { ingest } from './app/webhook.js';
import { type ProjectService } from './projects/service.js';
import { type TaskEngine } from './agent/engine.js';
import type { AutomationConfig } from './automation/config.js';
import { HttpError, digest, fail, fields, hashPassword, object, password, randomId, text, verifyPassword, type Json } from './core/security.js';

interface Options { store: Store; staticDirectory: string; secureCookies?: boolean; adminOrigin?: string; maxBodyBytes?: number; projects?: ProjectService; engine?: TaskEngine;
  repositoryConfigs?: ReadonlyMap<string, AutomationConfig>; }
async function body(req: IncomingMessage, limit: number): Promise<{ bytes: Buffer; complete: boolean }> {
  const chunks: Buffer[] = []; let size = 0, complete = true;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk), remaining = limit - size;
    if (bytes.length > remaining) complete = false;
    if (remaining > 0) { chunks.push(bytes.subarray(0, remaining)); size += Math.min(bytes.length, remaining); }
  }
  return { bytes: Buffer.concat(chunks), complete };
}
function respond(res: ServerResponse, status: number, value: Json): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
export function createControlPlane(options: Options) {
  const { store } = options;
  const loginAttempts = new Map<string, { n: number; until: number }>();
  const cookie = (token: string, age = 43200) => `bot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${options.secureCookies ? '; Secure' : ''}`;
  const initialized = () => !!store.get("SELECT 1 FROM settings WHERE key='initialized'");
  // Errors contain stable codes only: never echo a request, credential, SQL statement or stack.
  const wrap = (fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try { await fn(req, res); }
    catch (error) {
      if (!res.headersSent) respond(res, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.code : 'service_unavailable' });
      else res.end();
    }
  };
  const webhook = createServer(wrap(async (req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/healthz') { store.get('SELECT 1'); respond(res, 200, { ok: true }); return; }
    const match = /^\/hooks\/github\/([a-f0-9]{48})\/([a-f0-9]{48})$/.exec(path);
    if (req.method !== 'POST' || !match) return fail(404, 'not_found');
    const input = await body(req, options.maxBodyBytes ?? 2 * 1024 * 1024);
    const result = ingest(store, match[1]!, match[2]!, req.headers, input.bytes, input.complete, options.repositoryConfigs);
    respond(res, result.status, result.response);
  }));
  const admin = createServer(wrap(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost'), path = url.pathname, method = req.method || 'GET';
    if (method === 'GET' && path === '/healthz') { store.get('SELECT 1'); respond(res, 200, { ok: true }); return; }
    const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
      '/views.js': ['views.js', 'text/javascript'], '/views.css': ['views.css', 'text/css'] };
    if (method === 'GET' && assets[path]) {
      const [name, mime] = assets[path]; const bytes = await readFile(join(options.staticDirectory, name));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(bytes); return;
    }
    if (!path.startsWith('/api/')) return fail(404, 'not_found');
    if (path === '/api/setup' && method === 'GET') { respond(res, 200, { initialized: initialized() }); return; }
    const mutation = !['GET', 'HEAD'].includes(method);
    if (mutation && req.headers.origin) {
      const origin = options.adminOrigin || `${options.secureCookies ? 'https' : 'http'}://${req.headers.host}`;
      if (req.headers.origin !== origin) fail(403, 'origin_forbidden');
    }
    if (path === '/api/setup' && method === 'POST' && initialized()) fail(409, 'already_initialized');
    const publicRequest = path === '/api/setup' && method === 'POST' || path === '/api/auth/login' && method === 'POST';
    const user = publicRequest ? null : actor(store, req);
    if (user && mutation && req.headers['x-csrf-token'] !== user.csrf) fail(403, 'csrf_required');
    let input: Json = {};
    if (mutation) {
      if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'json_required');
      const raw = await body(req, 1024 * 1024);
      if (!raw.complete) fail(413, 'payload_too_large');
      try { input = object(JSON.parse(raw.bytes.toString('utf8'))); }
      catch (error) { if (error instanceof HttpError) throw error; fail(400, 'invalid_json'); }
    }
    if (path === '/api/setup' && method === 'POST') {
      fields(input, ['username', 'password']);
      const username = text(input.username, 100), encoded = await hashPassword(password(input.password)), id = randomId();
      const credentials = store.transaction(() => {
        // Recheck after the asynchronous hash, under SQLite's write lock.
        if (initialized() || store.get("SELECT 1 FROM users WHERE role='super_admin'")) fail(409, 'already_initialized');
        store.run("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,'super_admin')", id, username, encoded);
        store.run("INSERT INTO settings VALUES('initialized','1')");
        store.audit(id, 'system.initialized', id);
        return session(store, id);
      });
      res.setHeader('Set-Cookie', cookie(credentials.token)); respond(res, 201, { ok: true, csrf_token: credentials.csrf }); return;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      fields(input, ['username', 'password']);
      const username = text(input.username, 100), value = password(input.password), key = req.socket.remoteAddress || '';
      const now = Date.now();
      for (const [ip, count] of loginAttempts) if (count.until <= now) loginAttempts.delete(ip);
      const attempt = loginAttempts.get(key) || { n: 0, until: now + 15 * 60_000 };
      if (attempt.n >= 20 || loginAttempts.size > 10000) fail(429, 'login_rate_limited');
      attempt.n++; loginAttempts.set(key, attempt);
      const row = store.get('SELECT * FROM users WHERE username=? AND active=1', username);
      const valid = row ? await verifyPassword(value, row.password_hash) : (await hashPassword(value), false);
      if (!valid) fail(401, 'invalid_login');
      // A concurrent administrator may have disabled this user during hashing.
      if (!store.get('SELECT id FROM users WHERE id=? AND active=1', row!.id)) fail(401, 'invalid_login');
      const credentials = store.transaction(() => session(store, row!.id)); loginAttempts.delete(key);
      res.setHeader('Set-Cookie', cookie(credentials.token)); respond(res, 200, { ok: true, csrf_token: credentials.csrf }); return;
    }
    if (!user) return fail(401, 'login_required');
    if (path === '/api/auth/me' && method === 'GET') { respond(res, 200, publicActor(user)); return; }
    if (path === '/api/auth/logout' && method === 'POST') {
      fields(input, []);
      const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('bot_session='))?.slice(12) || '';
      store.run('DELETE FROM sessions WHERE token_hash=?', digest(token));
      res.setHeader('Set-Cookie', cookie('', 0)); respond(res, 200, { ok: true }); return;
    }
    if (path === '/api/status' && method === 'GET') {
      respond(res, 200, { review_available: true, development_available: true, project_environments_available: true, model_calls_available: true }); return;
    }
    if (path.startsWith('/api/environments') && !options.projects) fail(503, 'manager_not_configured');
    const result = options.engine?.api(user,method,url,input) ?? await options.projects?.api(user, method, url, input) ?? await management(store, user, method, path, input) ?? models(store, user, method, url, input)
      ?? (method === 'GET' ? queries(store, user, url) : undefined);
    if (!result) return fail(404, 'not_found');
    if (mutation && path.startsWith('/api/repositories')) void options.projects?.reconcile().catch(() => {});
    respond(res, method === 'POST' ? 201 : 200, result);
  }));
  for (const server of [webhook, admin]) { server.requestTimeout = 30_000; server.headersTimeout = 10_000; }
  return { webhook, admin };
}
