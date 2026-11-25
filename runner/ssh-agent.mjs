import { createServer, connect as connectSocket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SSH_AGENT_SOCKET, validSshGrant } from './ssh-config.mjs';

// OpenSSH agent protocol (draft-miller-ssh-agent). A SIGN_REQUEST names only a key, so every target has its own key and
// the control plane decides which keys a run may use; the agent socket itself grants nothing.
export const AGENT = Object.freeze({ FAILURE: 5, SUCCESS: 6, REQUEST_IDENTITIES: 11, IDENTITIES_ANSWER: 12, SIGN_REQUEST: 13,
  SIGN_RESPONSE: 14, EXTENSION: 27, EXTENSION_FAILURE: 28 });
// Requests of the helpers in /opt/runner (ssh-gate.mjs, ssh-askpass.mjs), carried as agent extensions on the same socket.
export const EXTENSION = Object.freeze({ check: 'check@bot-runner', askpass: 'askpass@bot-runner', tunnel: 'tunnel@bot-runner' });
// Tunnel bounds: concurrent per run and per computer, idle and total lifetime.
export const TUNNEL_LIMITS = Object.freeze({ perGrant: 16, perComputer: 32, idleMs: 10 * 60_000, lifetimeMs: 2 * 3600_000 });
const MAX_MESSAGE = 256 * 1024;

export function sshString(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'), length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}
export function uint32(value) {
  const data = Buffer.alloc(4); data.writeUInt32BE(value); return data;
}
export function agentFrame(type, ...parts) {
  const body = Buffer.concat([Buffer.from([type]), ...parts]), length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}
export class AgentReader {
  constructor(buffer, offset = 0) { this.buffer = buffer; this.offset = offset; }
  uint32() {
    if (this.offset + 4 > this.buffer.length) throw new Error('agent_message_truncated');
    const value = this.buffer.readUInt32BE(this.offset); this.offset += 4; return value;
  }
  string() {
    const length = this.uint32();
    if (this.offset + length > this.buffer.length) throw new Error('agent_message_truncated');
    const value = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return value;
  }
}

/** /proc/<pid>/stat fields the checks need: parent, process group and start time (clock ticks since boot). */
export function processStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}

// Node has no getsockopt: Python reads SO_PEERCRED from the connection, passed as fd 3 by number so the parent's socket
// keeps its reader. The pid is the process that called connect(), in this computer's pid namespace.
const peerScript = 'import socket,struct;s=socket.socket(fileno=3);print(*struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)));s.detach()';
export function peerCredentials(socket, python = 'python3') {
  const fd = socket?._handle?.fd;
  if (!Number.isSafeInteger(fd) || fd < 0) return Promise.resolve(null);
  return new Promise(resolve => {
    let output = '', child;
    try { child = spawn(python, ['-I', '-S', '-c', peerScript], { stdio: ['ignore', 'pipe', 'ignore', fd] }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', data => { output += data; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      const [pid, uid, gid] = output.trim().split(/\s+/).map(Number);
      resolve(code === 0 && Number.isSafeInteger(pid) && pid > 0 ? { pid, uid, gid } : null);
    });
  });
}

/** HTTP over the read-only gateway socket to the control plane (or a loopback URL in tests). */
function upstreamOptions(upstream, path, secret, extra = {}) {
  const target = upstream.socketPath ? { socketPath: upstream.socketPath } : (() => {
    const url = new URL(upstream.url); return { host: url.hostname, port: Number(url.port) };
  })();
  return { ...target, path, headers: { authorization: `Bearer ${secret}`, ...extra.headers }, method: extra.method ?? 'POST', timeout: 20_000 };
}
function upstreamCall(upstream, path, secret, body) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = httpRequest(upstreamOptions(upstream, path, secret, { headers: { 'content-type': 'application/json', 'content-length': data.length } }), res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); else req.destroy(); });
      res.on('end', () => {
        let value = null; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve(res.statusCode === 200 && value?.ok === true ? value : { ok: false, error: value?.error || 'ssh_broker_unavailable' });
      });
      res.on('error', () => resolve({ ok: false, error: 'ssh_broker_unavailable' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, error: 'ssh_broker_unavailable' }));
    req.end(data);
  });
}
// Resolves { socket } once the control plane switched protocols, or { error } with its stable code.
function upstreamTunnel(upstream, secret, target) {
  return new Promise(resolve => {
    const req = httpRequest(upstreamOptions(upstream, `/v1/ssh/tunnel/${target}`, secret, { method: 'GET', headers: { connection: 'Upgrade', upgrade: 'bot-ssh-tunnel' } }));
    req.on('upgrade', (res, socket, head) => {
      if (res.statusCode !== 101) { socket.destroy(); resolve({ error: 'ssh_broker_unavailable' }); return; }
      req.setTimeout(0); socket.setTimeout(0);
      if (head?.length) socket.unshift(head);
      resolve({ socket });
    });
    req.on('response', res => {
      let body = '';
      res.on('data', chunk => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        let error = 'ssh_target_denied';
        try { const code = JSON.parse(body).error; if (/^[a-z_]{1,64}$/.test(code)) error = code; } catch {}
        resolve({ error });
      });
      res.on('error', () => resolve({ error: 'ssh_broker_unavailable' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ error: 'ssh_broker_unavailable' }));
    req.end();
  });
}

class Grant {
  constructor(payload) {
    this.key = createHash('sha256').update(payload.grant).digest('hex');
    this.tunnels = new Set();
    this.update(payload);
  }
  update(payload) {
    this.secret = payload.grant; this.password = payload.password;
    this.targets = new Map(payload.targets.map(row => [row.id, row]));
    this.allowed = new Set(payload.allowed);
  }
  usable(id) { return this.allowed.has(id) ? this.targets.get(id) : undefined; }
}

/**
 * The computer's SSH agent (#1379). The daemon registers process groups it starts for a run (a command's shell, or an
 * agent process together with the groups of its direct children) with that run's grant. Every request reads the caller's
 * pid from SO_PEERCRED and is served only while the caller's process group is such a registered group whose leader is
 * the same process (pid and start time): a process that left with setsid, or any other process on the computer, is not.
 * The control plane still checks the run, role, trust and target on every signature, password and tunnel.
 */
export class SshAgentBroker {
  constructor({ socketPath = SSH_AGENT_SOCKET, upstream = { socketPath: '/run/model-gateway/gateway.sock' }, sshBinary = '/usr/bin/ssh',
    peer = peerCredentials, stat = processStat, limits = TUNNEL_LIMITS } = {}) {
    this.socketPath = socketPath; this.upstream = upstream; this.sshBinary = sshBinary;
    this.peer = peer; this.stat = stat; this.limits = limits;
    this.groups = new Map(); // pgid -> registration of a group leader started by the daemon
    this.agents = new Map(); // pid -> registration of an agent process: its direct children's groups inherit the grant
    this.grants = new Map(); // grant key -> Grant
    this.tunnels = new Set();
    this.server = null;
  }
  async start() {
    // Linux keeps 107 bytes of a socket path and Node binds the truncated path silently; OpenSSH refuses a longer one.
    if (Buffer.byteLength(this.socketPath) >= 104) throw new Error('ssh_agent_socket_path_too_long');
    try { unlinkSync(this.socketPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.server = createServer({ allowHalfOpen: true }, socket => this.serve(socket));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socketPath, () => { this.server.off('error', reject); resolve(); }); });
    chmodSync(this.socketPath, 0o660);
    this.sweeper = setInterval(() => this.sweep(), 60_000); this.sweeper.unref?.();
    return this;
  }
  async close() {
    clearInterval(this.sweeper);
    for (const tunnel of [...this.tunnels]) tunnel.close();
    if (this.server) await new Promise(resolve => this.server.close(() => resolve()));
    try { unlinkSync(this.socketPath); } catch {}
  }
  /** Environment of processes started with a grant; a password target also gets the askpass helper. */
  environment(payload) {
    return { BOT_SSH_BROKER: '1', SSH_AUTH_SOCK: this.socketPath,
      ...(payload.password ? { SSH_ASKPASS: fileURLToPath(new URL('./ssh-askpass.mjs', import.meta.url)), SSH_ASKPASS_REQUIRE: 'force' } : {}) };
  }
  /** Called synchronously from the spawn of a detached leader, before its first instruction can reach this socket. */
  register(pid, payload, kind = 'command') {
    let grant;
    try { grant = validSshGrant(payload); } catch { return false; }
    const leader = this.stat(pid);
    if (!leader || leader.pgid !== pid) return false;
    const key = createHash('sha256').update(grant.grant).digest('hex');
    const shared = this.grants.get(key) ?? new Grant(grant);
    shared.update(grant); this.grants.set(key, shared);
    const registration = { pid, start: leader.start, grant: shared, kind };
    this.groups.set(pid, registration);
    if (kind === 'agent') this.agents.set(pid, registration);
    return true;
  }
  release(pid) {
    const registration = this.groups.get(pid);
    if (!registration) return;
    this.groups.delete(pid);
    if (this.agents.get(pid) === registration) this.agents.delete(pid);
    this.forget(registration.grant);
  }
  forget(grant) {
    if ([...this.groups.values()].some(row => row.grant === grant)) return;
    for (const tunnel of [...grant.tunnels]) tunnel.close();
    this.grants.delete(grant.key);
  }
  alive(registration) { return this.stat(registration.pid)?.start === registration.start; }
  sweep() { for (const registration of [...this.groups.values()]) if (!this.alive(registration)) this.release(registration.pid); }
  /** The registration serving the caller's process group, or null. start pins the caller to the process that connected. */
  authorize(pid, start) {
    const caller = this.stat(pid);
    if (!caller || start !== undefined && caller.start !== start) return null;
    const own = this.groups.get(caller.pgid);
    if (own) return this.alive(own) ? own : null;
    const leader = this.stat(caller.pgid);
    const agent = leader && leader.pgid === caller.pgid ? this.agents.get(leader.ppid) : undefined;
    return agent && this.alive(agent) && BigInt(leader.start) >= BigInt(agent.start) ? agent : null;
  }

  serve(socket) {
    let buffer = Buffer.alloc(0), busy = false, raw = false, peer;
    socket.on('error', () => {});
    const reply = data => { if (!socket.destroyed) socket.write(data); };
    const pump = async () => {
      if (busy || raw) return;
      busy = true;
      try {
        while (!raw && buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (!length || length > MAX_MESSAGE) { socket.destroy(); return; }
          if (buffer.length < 4 + length) break;
          const body = buffer.subarray(4, 4 + length);
          buffer = buffer.subarray(4 + length);
          if (peer === undefined) {
            const credentials = await this.peer(socket), caller = credentials && this.stat(credentials.pid);
            peer = caller ? { pid: caller.pid, start: caller.start } : null;
          }
          const tunnel = await this.message(body, peer, reply);
          if (tunnel) {
            // From here on the connection carries the tunnelled bytes; anything the helper sent early goes first.
            raw = true; socket.removeAllListeners('data');
            tunnel.attach(socket, buffer); buffer = Buffer.alloc(0);
          }
        }
      } catch { socket.destroy(); }
      finally { busy = false; }
      if (!raw && buffer.length >= 4) void pump();
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_MESSAGE + 4) { socket.destroy(); return; }
      void pump();
    });
    // Half-open is for tunnels; an agent conversation the caller ended is ended here too.
    socket.on('end', () => { if (!raw) socket.end(); });
  }
  async message(body, peer, reply) {
    const failure = () => { reply(agentFrame(AGENT.FAILURE)); return null; };
    const registration = peer ? this.authorize(peer.pid, peer.start) : null;
    const reader = new AgentReader(body, 1);
    if (body[0] === AGENT.REQUEST_IDENTITIES) {
      const keys = registration ? [...registration.grant.allowed].map(id => registration.grant.targets.get(id)).filter(row => row?.auth === 'key') : [];
      reply(agentFrame(AGENT.IDENTITIES_ANSWER, uint32(keys.length), ...keys.flatMap(row => [sshString(Buffer.from(row.public_key, 'base64')), sshString(row.alias)])));
      return null;
    }
    if (body[0] === AGENT.SIGN_REQUEST) {
      const key = reader.string(), data = reader.string(), flags = reader.uint32();
      const wanted = key.toString('base64');
      const row = registration && [...registration.grant.allowed].map(id => registration.grant.targets.get(id)).find(item => item?.auth === 'key' && item.public_key === wanted);
      if (!row || data.length > 64 * 1024) return failure();
      const answer = await upstreamCall(this.upstream, '/v1/ssh/sign', registration.grant.secret, { target: row.id, key: wanted, data: data.toString('base64'), flags });
      if (!answer.ok || typeof answer.signature !== 'string') return failure();
      reply(agentFrame(AGENT.SIGN_RESPONSE, sshString(Buffer.from(answer.signature, 'base64'))));
      return null;
    }
    if (body[0] !== AGENT.EXTENSION) return failure();
    const name = reader.string().toString('utf8');
    const deny = (error = 'ssh_target_denied') => { reply(agentFrame(AGENT.EXTENSION_FAILURE, sshString(error))); return null; };
    if (name === EXTENSION.check) {
      const id = reader.string().toString('utf8');
      if (!registration?.grant.usable(id)) return deny();
      const answer = await upstreamCall(this.upstream, '/v1/ssh/check', registration.grant.secret, { target: id });
      if (!answer.ok) return deny(answer.error);
      reply(agentFrame(AGENT.SUCCESS));
      return null;
    }
    if (name === EXTENSION.askpass) {
      const prompt = reader.string().toString('utf8');
      const row = registration && peer && this.askpassTarget(peer.pid, registration, prompt);
      if (!row) return deny();
      const answer = await upstreamCall(this.upstream, '/v1/ssh/password', registration.grant.secret, { target: row.id });
      if (!answer.ok || typeof answer.password !== 'string') return deny(answer.error);
      reply(agentFrame(AGENT.SUCCESS, sshString(answer.password)));
      return null;
    }
    if (name === EXTENSION.tunnel) {
      // Only the target id counts: the address always comes from the registration, never from the caller.
      const id = reader.string().toString('utf8'), row = registration?.grant.usable(id);
      if (!row || row.route !== 'tunnel') return deny();
      if (registration.grant.tunnels.size >= this.limits.perGrant || this.tunnels.size >= this.limits.perComputer) return deny('ssh_tunnel_limit');
      const upstream = await upstreamTunnel(this.upstream, registration.grant.secret, id);
      if (!upstream.socket) return deny(upstream.error);
      reply(agentFrame(AGENT.SUCCESS));
      return this.tunnel(registration.grant, upstream.socket);
    }
    return failure();
  }
  /**
   * A password goes only to the askpass helper OpenSSH started: its parent must be the image's ssh binary (same device
   * and inode) in the same authorized process group, and the prompt must name exactly one password target of this run.
   */
  askpassTarget(pid, registration, prompt) {
    const helper = this.stat(pid), parent = helper && this.stat(helper.ppid);
    if (!helper || !parent || parent.pgid !== helper.pgid) return null;
    try {
      const binary = statSync(`/proc/${helper.ppid}/exe`), expected = statSync(this.sshBinary);
      if (binary.dev !== expected.dev || binary.ino !== expected.ino) return null;
    } catch { return null; }
    const matches = [...registration.grant.allowed].map(id => registration.grant.targets.get(id)).filter(row => {
      if (row?.auth !== 'password') return false;
      // sshconnect2.c: "%.30s@%.128s's password: " for password and "(%s@%s) %s" for keyboard-interactive prompts.
      return prompt === `${row.username.slice(0, 30)}@${row.host.slice(0, 128)}'s password: ` || prompt.startsWith(`(${row.username}@${row.host}) `);
    });
    return matches.length === 1 ? matches[0] : null;
  }
  tunnel(grant, upstream) {
    const limits = this.limits, all = this.tunnels;
    let client = null, idle = null, lifetime = null, closed = false;
    const tunnel = {
      attach(socket, early) {
        client = socket;
        const touch = () => { clearTimeout(idle); idle = setTimeout(() => tunnel.close(), limits.idleMs); idle.unref?.(); };
        lifetime = setTimeout(() => tunnel.close(), limits.lifetimeMs); lifetime.unref?.();
        touch();
        if (early.length) upstream.write(early);
        socket.on('data', chunk => { touch(); if (!upstream.write(chunk)) { socket.pause(); upstream.once('drain', () => socket.resume()); } });
        upstream.on('data', chunk => { touch(); if (!socket.write(chunk)) { upstream.pause(); socket.once('drain', () => upstream.resume()); } });
        // Each direction ends on its own (half-close): the answer to the caller's last bytes still reaches it. Only an
        // error, a timeout or a revoked grant cuts both sides.
        socket.on('end', () => upstream.end()); upstream.on('end', () => socket.end());
        let open = 2;
        for (const side of [socket, upstream]) {
          side.on('close', () => { if (--open === 0) tunnel.close(); });
          side.on('error', () => tunnel.close());
        }
      },
      close() {
        if (closed) return;
        closed = true; clearTimeout(idle); clearTimeout(lifetime);
        grant.tunnels.delete(tunnel); all.delete(tunnel);
        upstream.destroy(); client?.destroy();
      },
    };
    grant.tunnels.add(tunnel); all.add(tunnel);
    return tunnel;
  }
}

/** Connects a helper to the agent socket and exchanges one extension request (runner/ssh-gate.mjs, ssh-askpass.mjs). */
export function agentExtension(socketPath, name, ...args) {
  return new Promise(resolve => {
    const socket = connectSocket(socketPath);
    let buffer = Buffer.alloc(0), done = false;
    const finish = value => { if (done) return; done = true; resolve(value); };
    socket.on('error', () => finish({ ok: false, error: 'ssh_broker_unavailable', socket }));
    socket.on('close', () => finish({ ok: false, error: 'ssh_broker_unavailable', socket }));
    socket.on('connect', () => socket.write(agentFrame(AGENT.EXTENSION, sshString(name), ...args.map(sshString))));
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
      socket.off('data', onData); socket.pause();
      const length = buffer.readUInt32BE(0), body = buffer.subarray(4, 4 + length), rest = buffer.subarray(4 + length);
      if (body[0] === AGENT.SUCCESS) {
        const value = body.length > 1 ? new AgentReader(body, 1).string() : null;
        if (rest.length) socket.unshift(rest);
        finish({ ok: true, value, socket });
      } else {
        let error = 'ssh_target_denied';
        try { if (body[0] === AGENT.EXTENSION_FAILURE && body.length > 1) error = new AgentReader(body, 1).string().toString('utf8'); } catch {}
        finish({ ok: false, error: /^[a-z_]{1,64}$/.test(error) ? error : 'ssh_target_denied', socket });
      }
    };
    socket.on('data', onData);
  });
}
