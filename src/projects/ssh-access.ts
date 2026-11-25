import { createHash, randomBytes, sign as cryptoSign } from 'node:crypto';
import { connect as tcpConnect, type Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import ssh2 from 'ssh2';
import type { Row, Store } from '../storage/database.js';

/**
 * Task-side SSH (#1379). A run that starts processes on its project computer gets a grant: a one-time secret the
 * computer's daemon keeps in memory, with the registered targets this run may use, decided once from the run's role and
 * whether its checkout was trusted when it started. The daemon serves the computer's agent socket only to the process
 * groups it registered for the run (runner/ssh-agent.mjs); this side checks the grant, the run and the target again on
 * every signature, password and tunnel, so the end of the run, a cancel or a revoked target refuses the next one. Private
 * keys and passwords stay sealed here; a signature or a password leaves only as the answer to that one request.
 */

const keyHashes: Record<string, string | null> = { 'ssh-ed25519': null, 'ssh-rsa': 'rsa',
  'ecdsa-sha2-nistp256': 'sha256', 'ecdsa-sha2-nistp384': 'sha384', 'ecdsa-sha2-nistp521': 'sha512' };
const string = (value: Buffer | string) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value), length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
};
const mpint = (value: Buffer) => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const digits = value.subarray(start);
  return string(digits[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), digits]) : digits);
};
function parsedKey(privateKey: string): any {
  const key: any = ssh2.utils.parseKey(privateKey);
  if (!key || key instanceof Error || Array.isArray(key) || !key.isPrivateKey() || !Object.hasOwn(keyHashes, key.type)) return null;
  return key;
}
/** Base64 public key blob of an unencrypted ed25519, ECDSA or RSA private key, or null. */
export function sshPublicKey(privateKey: string): string | null {
  return parsedKey(privateKey)?.getPublicSSH().toString('base64') ?? null;
}
/** An agent SIGN_RESPONSE signature blob; flags 2 and 4 ask RSA keys for rsa-sha2-256 and rsa-sha2-512. */
export function sshSignature(privateKey: string, data: Buffer, flags: number): Buffer {
  const key = parsedKey(privateKey);
  if (!key) throw new Error('ssh_credential_invalid');
  const pem = key.getPrivatePEM();
  if (key.type === 'ssh-ed25519') return Buffer.concat([string('ssh-ed25519'), string(cryptoSign(null, data, pem))]);
  if (key.type === 'ssh-rsa') {
    const [algorithm, hash] = flags & 4 ? ['rsa-sha2-512', 'sha512'] : flags & 2 ? ['rsa-sha2-256', 'sha256'] : ['ssh-rsa', 'sha1'];
    return Buffer.concat([string(algorithm!), string(cryptoSign(hash!, data, pem))]);
  }
  const raw = cryptoSign(keyHashes[key.type]!, data, { key: pem, dsaEncoding: 'ieee-p1363' }), half = raw.length / 2;
  return Buffer.concat([string(key.type), string(Buffer.concat([mpint(raw.subarray(0, half)), mpint(raw.subarray(half))]))]);
}

export interface SshTargetView { id: string; alias: string; host: string; port: number; username: string; auth: 'key' | 'password';
  route: 'direct' | 'proxy_jump' | 'tunnel'; jump_id: string | null; host_key_sha256: string; public_key: string | null }
/** What the manager and the computer receive with a call that starts processes (runner/ssh-config.mjs validates it). */
export interface SshGrantPayload { grant: string; targets: SshTargetView[]; allowed: string[]; password: boolean }
export interface SshGrantOptions { store: Store; repository: string; task: string; role: string; trusted: boolean; live: () => boolean }
interface Grant extends SshGrantOptions { key: string; allowed: Map<string, string>; tunnels: Set<{ close(): void }>; closed: boolean }

// A target is used under the identity it had when the run started; a change of address, user, pin, route or key refuses it.
const identity = ['alias', 'host', 'port', 'username', 'host_key_sha256', 'auth', 'route', 'jump_id', 'relay_node', 'public_key'];
const revision = (row: Row) => createHash('sha256').update(JSON.stringify(identity.map(key => row[key] ?? null))).digest('hex');
const projectTargets = (store: Store, project: string) => store.all(`SELECT * FROM ssh_targets WHERE owner_project=? OR (owner_project IS NULL AND
  id IN (SELECT target_id FROM ssh_target_projects WHERE repository_id=?)) ORDER BY alias`, project, project);
const projectTarget = (store: Store, project: string, id: string) => store.get(`SELECT * FROM ssh_targets WHERE id=? AND (owner_project=? OR
  (owner_project IS NULL AND EXISTS (SELECT 1 FROM ssh_target_projects WHERE target_id=? AND repository_id=?)))`, id, project, id, project);
const permits = (row: Row, role: string, trusted: boolean) => {
  let roles: unknown;
  try { roles = JSON.parse(String(row.allowed_roles)); } catch { roles = []; }
  return Array.isArray(roles) && roles.includes(role) && (trusted || row.allow_untrusted_pr === 1);
};
const view = (row: Row): SshTargetView => ({ id: row.id, alias: row.alias, host: row.host, port: row.port, username: row.username, auth: row.auth,
  route: row.route, jump_id: row.jump_id ?? null, host_key_sha256: row.host_key_sha256, public_key: row.public_key ?? null });
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const targetId = /^[a-f0-9]{48}$/;

export class SshAccess {
  readonly limits = { perGrant: 16, perComputer: 32, idleMs: 10 * 60_000, lifetimeMs: 2 * 3600_000, connectMs: 15_000 };
  /** Opens the TCP connection of a tunnel; tests replace it. Always called with the registered address. */
  connect: (host: string, port: number) => Socket = (host, port) => tcpConnect({ host, port });
  private grants = new Map<string, Grant>();
  private watcher: NodeJS.Timeout | null = null;

  /** A grant for one run, or null when the project registered no SSH host. close() ends it and its tunnels. */
  issue(options: SshGrantOptions): { payload: SshGrantPayload; close: () => void } | null {
    const rows = projectTargets(options.store, options.repository);
    if (!rows.length) return null;
    const byId = new Map(rows.map(row => [row.id as string, row]));
    // A jump host must be usable by the same run; chains are acyclic (src/projects/ssh-targets.ts) and short.
    const usable = (row: Row, depth = 0): boolean => depth < 8 && permits(row, options.role, options.trusted)
      && (row.route !== 'proxy_jump' || (byId.has(row.jump_id) && usable(byId.get(row.jump_id)!, depth + 1)));
    const allowed = rows.filter(row => usable(row));
    const secret = 'rsg_' + randomBytes(32).toString('base64url'), key = digest(secret);
    const grant: Grant = { ...options, key, allowed: new Map(allowed.map(row => [row.id, revision(row)])), tunnels: new Set(), closed: false };
    this.grants.set(key, grant);
    return {
      payload: { grant: secret, targets: rows.map(view), allowed: allowed.map(row => row.id), password: allowed.some(row => row.auth === 'password') },
      close: () => this.revoke(grant),
    };
  }
  private revoke(grant: Grant) {
    grant.closed = true;
    if (this.grants.get(grant.key) === grant) this.grants.delete(grant.key);
    for (const tunnel of [...grant.tunnels]) tunnel.close();
  }
  private live(grant: Grant) {
    if (grant.closed) return false;
    try { return grant.live() === true; } catch { return false; }
  }
  /** The target, if this run may use it now: same identity as at the start, role, trust and the whole jump chain. */
  private target(grant: Grant, id: string, depth = 0): Row | null {
    if (depth >= 8 || !this.live(grant) || !targetId.test(id)) return null;
    const row = projectTarget(grant.store, grant.repository, id);
    if (!row || grant.allowed.get(id) !== revision(row) || !permits(row, grant.role, grant.trusted)) return null;
    if (row.route === 'proxy_jump' && !this.target(grant, row.jump_id, depth + 1)) return null;
    return row;
  }
  private grantOf(req: IncomingMessage) {
    const match = /^Bearer (rsg_[A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''));
    return match ? this.grants.get(digest(match[1]!)) : undefined;
  }
  // Every refusal and every use is audited under the task, never with key material or a password.
  private audit(grant: Grant, action: string, target: string) {
    try { grant.store.audit('task:' + grant.task, 'ssh_target.' + action, targetId.test(target) ? target : 'invalid', grant.repository); } catch { /* A closed store. */ }
  }

  /** POST /v1/ssh/{check,sign,password} on the computers' gateway socket. Returns false for other paths. */
  request(req: IncomingMessage, res: ServerResponse): boolean {
    if (!(req.url ?? '').startsWith('/v1/ssh/')) return false;
    const reply = (status: number, value: Record<string, unknown>) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const route = /^\/v1\/ssh\/(check|sign|password)$/.exec(req.url ?? '')?.[1];
    if (req.method !== 'POST' || !route) { req.resume(); reply(404, { ok: false, error: 'not_found' }); return true; }
    const grant = this.grantOf(req);
    if (!grant) { req.resume(); reply(401, { ok: false, error: 'ssh_grant_invalid' }); return true; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 256 * 1024) chunks.push(chunk); });
    req.on('error', () => reply(400, { ok: false, error: 'invalid_request' }));
    req.on('end', () => {
      let input: any;
      try { input = size <= 256 * 1024 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { input = null; }
      const id = typeof input?.target === 'string' ? input.target : '';
      const row = input ? this.target(grant, id) : null;
      const deny = () => { this.audit(grant, route + '.denied', id); reply(403, { ok: false, error: 'ssh_target_denied' }); };
      if (!row) return deny();
      if (route === 'check') return reply(200, { ok: true });
      let credential: any;
      try { credential = grant.store.secrets.open(row.sealed, 'ssh-target:' + row.id); } catch { return deny(); }
      if (route === 'password') {
        if (row.auth !== 'password' || typeof credential?.password !== 'string') return deny();
        this.audit(grant, 'password.released', row.id);
        return reply(200, { ok: true, password: credential.password });
      }
      const data = typeof input.data === 'string' ? Buffer.from(input.data, 'base64') : null;
      if (row.auth !== 'key' || input.key !== row.public_key || !data || data.length > 64 * 1024 || !Number.isSafeInteger(input.flags) || input.flags < 0 ||
        typeof credential?.private_key !== 'string') return deny();
      try {
        const signature = sshSignature(credential.private_key, data, input.flags);
        this.audit(grant, 'sign.ok', row.id);
        reply(200, { ok: true, signature: signature.toString('base64') });
      } catch { deny(); }
    });
    return true;
  }

  /** GET /v1/ssh/tunnel/<target> with Upgrade: bot-ssh-tunnel. Connects only to the target's registered host and port. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!(req.url ?? '').startsWith('/v1/ssh/')) return false;
    socket.on('error', () => {});
    const refuse = (status: number, error: string) => {
      socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Refused'}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ ok: false, error })}`);
    };
    const id = /^\/v1\/ssh\/tunnel\/([a-f0-9]{48})$/.exec(req.url ?? '')?.[1];
    if (req.method !== 'GET' || !id || String(req.headers.upgrade ?? '').toLowerCase() !== 'bot-ssh-tunnel') { refuse(400, 'invalid_request'); return true; }
    const grant = this.grantOf(req);
    if (!grant) { refuse(401, 'ssh_grant_invalid'); return true; }
    const row = this.target(grant, id);
    if (!row || row.route !== 'tunnel') { this.audit(grant, 'tunnel.denied', id); refuse(403, 'ssh_target_denied'); return true; }
    // A tunnel through a compute node (#1380) has no relay yet: refused, never opened from here instead.
    if (row.relay_node) { this.audit(grant, 'tunnel.unavailable', id); refuse(503, 'ssh_relay_unavailable'); return true; }
    const computer = [...this.grants.values()].filter(other => other.repository === grant.repository).reduce((sum, other) => sum + other.tunnels.size, 0);
    if (grant.tunnels.size >= this.limits.perGrant || computer >= this.limits.perComputer) {
      this.audit(grant, 'tunnel.limited', id); refuse(429, 'ssh_tunnel_limit'); return true;
    }
    const upstream = this.connect(String(row.host), Number(row.port));
    let idle: NodeJS.Timeout | undefined, lifetime: NodeJS.Timeout | undefined, open = false, closed = false;
    const end = () => { closed = true; clearTimeout(idle); clearTimeout(lifetime); clearTimeout(connecting); grant.tunnels.delete(tunnel); upstream.destroy(); };
    // Only an error, a timeout or a revoked grant cuts the connection; a normal end runs each direction to its end.
    const tunnel = { close: () => { if (closed) return; end(); socket.destroy(); } };
    // Before the switch the caller still reads an HTTP answer: end with it instead of cutting the connection.
    const fail = (status: number, error: string, action?: string) => {
      if (closed) return;
      end();
      if (action) this.audit(grant, action, id);
      refuse(status, error);
    };
    grant.tunnels.add(tunnel);
    const touch = () => { clearTimeout(idle); idle = setTimeout(tunnel.close, this.limits.idleMs); idle.unref?.(); };
    const connecting = setTimeout(() => fail(504, 'ssh_connect_timeout', 'tunnel.failed'), this.limits.connectMs);
    connecting.unref?.();
    upstream.on('error', () => { if (open) tunnel.close(); else fail(502, 'ssh_connect_failed', 'tunnel.failed'); });
    upstream.once('connect', () => {
      clearTimeout(connecting);
      // The run may have ended while the connection was being made.
      if (closed) return;
      if (!this.target(grant, id)) { fail(403, 'ssh_target_denied', 'tunnel.denied'); return; }
      open = true;
      this.audit(grant, 'tunnel.opened', id);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: bot-ssh-tunnel\r\n\r\n');
      if (head.length) upstream.write(head);
      lifetime = setTimeout(tunnel.close, this.limits.lifetimeMs); lifetime.unref?.();
      touch();
      socket.on('data', () => touch()); upstream.on('data', () => touch());
      // pipe() ends each side when the other ends (half-close), so the last answer still reaches the caller.
      socket.pipe(upstream); upstream.pipe(socket);
      let sides = 2;
      for (const side of [socket, upstream]) side.on('close', () => { if (--sides === 0) tunnel.close(); });
      socket.on('error', tunnel.close);
      this.watch();
    });
    return true;
  }
  // A run can end before its caller closes the grant (a cancel revokes its token): its tunnels close within a minute.
  private watch() {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      let open = 0;
      for (const grant of [...this.grants.values()]) {
        if (!grant.tunnels.size) continue;
        if (!this.live(grant)) this.revoke(grant); else open += grant.tunnels.size;
      }
      if (!open && this.watcher) { clearInterval(this.watcher); this.watcher = null; }
    }, 30_000);
    this.watcher.unref?.();
  }
}

export const sshAccess = new SshAccess();
