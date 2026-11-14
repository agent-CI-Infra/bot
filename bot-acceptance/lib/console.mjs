import { readJson, readOptional, writeJson } from './state.mjs';

// A minimal client for the bot's console API: one session (cookie + CSRF token) per instance. Errors carry the HTTP status
// and the API error code, never the request body, so a failed login or credential call cannot echo a secret into a log.
export class ConsoleError extends Error {
  constructor(method, path, status, code, detail) {
    super(`${method} ${path} -> ${status} ${code}${detail ? `: ${detail}` : ''}`);
    Object.assign(this, { method, path, status, code });
  }
}

export class Console {
  constructor(base, { timeoutMs = 60_000 } = {}) {
    this.base = base.replace(/\/$/, ''); this.timeoutMs = timeoutMs; this.cookie = ''; this.csrf = '';
  }
  /** The session as plain data, so a CLI can reuse it across processes instead of logging in on every call. */
  session() { return { cookie: this.cookie, csrf: this.csrf }; }
  resume(session) { this.cookie = session?.cookie || ''; this.csrf = session?.csrf || ''; return this; }
  async setup(username, password) { return this.#credentials('/api/setup', username, password); }
  async login(username, password) { return this.#credentials('/api/auth/login', username, password); }
  async #credentials(path, username, password) {
    const response = await this.raw('POST', path, { username, password });
    this.cookie = (response.headers.get('set-cookie') || '').split(';')[0]; this.csrf = response.body.csrf_token || '';
    if (!this.cookie || !this.csrf) throw new ConsoleError('POST', path, response.status, 'session_missing');
    return response.body;
  }
  /** Sends one request and returns the parsed body; any status outside 2xx throws a ConsoleError. */
  async request(method, path, body) {
    const response = await this.raw(method, path, body);
    return response.body;
  }
  async raw(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = this.csrf;
    let response;
    try {
      response = await fetch(this.base + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) { throw new ConsoleError(method, path, 0, 'unreachable', error?.cause?.code || error?.name); }
    const text = await response.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
    // API errors are {error, field?}; field names the offending setting, never request contents.
    if (!response.ok) throw new ConsoleError(method, path, response.status, parsed?.error || 'http_error', parsed?.field && `field ${parsed.field}`);
    return { status: response.status, headers: response.headers, body: parsed };
  }
}

/**
 * A signed-in console for one of the accounts bootstrap created ('admin' or 'operator'). The session is cached in the
 * state directory and refreshed when the bot no longer accepts it.
 */
export async function signedIn(dir, role) {
  const target = readJson(dir, 'target.json'), account = readJson(dir, `${role}.json`);
  const client = new Console(target.bot_url).resume(readOptional(dir, `${role}.session.json`));
  if (client.cookie) {
    try { await client.request('GET', '/api/auth/me'); return { client, target }; }
    catch (error) { if (error.status !== 401) throw error; }
  }
  await client.login(account.username, account.password);
  writeJson(dir, `${role}.session.json`, client.session(), { secret: true });
  return { client, target };
}

/** Polls until check() returns a truthy value; throws with the last observation after the deadline. */
export async function until(label, check, { timeoutMs, intervalMs = 5000, log = () => {} }) {
  const deadline = Date.now() + timeoutMs; let last;
  for (;;) {
    try { const value = await check(); if (value) return value; last = 'not yet'; }
    catch (error) { last = error.message; }
    if (Date.now() >= deadline) throw new Error(`${label}: gave up after ${Math.round(timeoutMs / 1000)} s (${last})`);
    log(`${label}: waiting (${last})`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
