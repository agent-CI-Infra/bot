import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { sshAccess } from '../../../../dist/projects/ssh-access.js';
import { configuredRedactor } from '../../../../dist/core/redaction.js';
import { traceEvent } from '../../../../dist/tasks/trace.js';
import { SshAgentBroker } from '../../../../runner/ssh-agent.mjs';
import { publicKeyLine, renderSshConfig } from '../../../../runner/ssh-config.mjs';

// Real OpenSSH (ssh, sshd-side ssh2 on loopback) against the control plane's grant checks and the computer's agent
// broker: what a task's `ssh <alias>` does on a project computer, with -F instead of the image's system include.
const code = fileURLToPath(new URL('../../../../runner', import.meta.url));
// ssh2's generator drops a leading zero byte of some ed25519 keys (about 1 in 250) and then cannot parse them itself;
// ssh-keygen keys are not affected. Draw again until both halves parse.
function generated(type, options) {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync(type, options);
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error) && !(ssh2.utils.parseKey(pair.public) instanceof Error)) return pair;
  }
}
const keyPair = () => generated('ed25519').private;
const rsaKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });

function sshServer(users) {
  const seen = { auth: [], commands: [] };
  const server = new ssh2.Server({ hostKeys: [rsaKey()] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      seen.auth.push(`${ctx.username}:${ctx.method}`);
      const user = users[ctx.username];
      if (user?.password !== undefined && ctx.method === 'password' && ctx.password === user.password) return ctx.accept();
      if (user?.key && ctx.method === 'publickey' && ctx.key.data.equals(user.key.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        if (user.key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      ctx.reject(['publickey', 'password']);
    });
    client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, _reject, info) => {
      seen.commands.push(info.command);
      const stream = acceptExec();
      stream.write(`ran ${info.command}\n`);
      stream.exit(0); stream.end();
    })));
  });
  return { server, seen };
}

function run(file, args, env) {
  return new Promise(resolve => {
    const child = spawn(file, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    run.last = child;
  });
}

test('a registered process group uses its run\'s targets with native ssh; other processes, setsid and revoked runs get ssh_target_denied', { timeout: 120_000 }, async t => {
  const h = await harness(t), { admin } = await setup(h), acc = await account(admin);
  await repository(admin, acc.id, '101');
  const keys = { direct: keyPair(), tunnel: generated('rsa', { bits: 2048 }).private, qa: keyPair(), pinned: keyPair() };
  const parsed = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, ssh2.utils.parseKey(key)]));
  const { server, seen } = sshServer({ deploy: { key: parsed.direct }, tunnel: { key: parsed.tunnel }, board: { password: 'p!4z' }, qa: { key: parsed.qa } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  // A slow echo service behind a tunnel: it answers after the caller has finished sending.
  const echo = createTcpServer({ allowHalfOpen: true }, socket => {
    socket.on('data', data => setTimeout(() => socket.write(data), 150));
    socket.on('end', () => setTimeout(() => socket.end(), 300));
  });
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  t.after(() => new Promise(resolve => echo.close(resolve)));
  // A listener the caller might name instead of the registered address: it must never see a connection.
  let decoy = 0;
  const elsewhere = createTcpServer(socket => { decoy++; socket.destroy(); });
  elsewhere.listen(0, '127.0.0.1'); await once(elsewhere, 'listening');
  t.after(() => new Promise(resolve => elsewhere.close(resolve)));
  const port = server.address().port;
  const hostKey = await new Promise(resolve => {
    const probe = new ssh2.Client();
    probe.on('error', () => {});
    probe.connect({ host: '127.0.0.1', port, username: 'none', hostVerifier: key => { resolve('SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')); return false; } });
  });
  const base = { host: '127.0.0.1', port, host_key_sha256: hostKey, allowed_roles: ['dev'] };
  const project = '/api/repositories/101/ssh-targets';
  const create = async body => { const reply = await admin(project, 'POST', body); assert.equal(reply.status, 201, JSON.stringify(reply.value)); return reply.value.id; };
  const ids = {
    direct: await create({ ...base, alias: 'build-box', username: 'deploy', auth: 'key', private_key: keys.direct }),
    tunnel: await create({ ...base, alias: 'lab-board', username: 'tunnel', auth: 'key', private_key: keys.tunnel, route: 'tunnel' }),
    password: await create({ ...base, alias: 'old-board', username: 'board', auth: 'password', password: 'p!4z' }),
    qa: await create({ ...base, alias: 'qa-only', username: 'qa', auth: 'key', private_key: keys.qa, allowed_roles: ['qa'] }),
    pinned: await create({ ...base, alias: 'wrong-pin', username: 'deploy', auth: 'key', private_key: keys.pinned, host_key_sha256: 'SHA256:' + 'B'.repeat(43) }),
    relayed: await create({ ...base, alias: 'relay-box', username: 'relay', auth: 'password', password: 'r3r3', route: 'tunnel', relay_node: 'lab-node-1' }),
    echo: await create({ ...base, port: echo.address().port, alias: 'echo-box', username: 'echo', auth: 'password', password: 'e1e1', route: 'tunnel' }),
  };
  // A relay node is a tunnel setting; it is reserved for compute nodes and refused on other routes.
  assert.equal((await admin(`${project}/${ids.relayed}`, 'PUT', { route: 'direct' })).status, 400);
  // One dedicated key per target: a key registered once is refused for another host.
  assert.equal((await admin(project, 'POST', { ...base, alias: 'reuse', username: 'deploy', auth: 'key', private_key: keys.direct })).status, 409);

  const gateway = createHttpServer((req, res) => { if (!sshAccess.request(req, res)) { res.statusCode = 404; res.end(); } });
  gateway.on('upgrade', (req, socket, head) => { if (!sshAccess.upgrade(req, socket, head)) socket.destroy(); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }));
  // The agent socket must stay below the 107-byte sun_path limit, also inside deep worktree TMPDIRs.
  let dir = mkdtempSync(join(tmpdir(), 'ssh-'));
  if (Buffer.byteLength(join(dir, 'agent.sock')) >= 100) { rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(join('/tmp', 'ssh-')); }
  const socket = join(dir, 'agent.sock'), keyDir = join(dir, 'keys');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broker = await new SshAgentBroker({ socketPath: socket, upstream: { url: `http://127.0.0.1:${gateway.address().port}` } }).start();
  t.after(() => broker.close());

  let running = true;
  const grant = sshAccess.issue({ store: h.store, repository: '101', task: 'task-1', role: 'dev', trusted: true, live: () => running });
  assert.deepEqual(new Set(grant.payload.allowed), new Set([ids.direct, ids.tunnel, ids.password, ids.pinned, ids.relayed, ids.echo]));
  assert.equal(grant.payload.password, true);
  assert.ok(!JSON.stringify(grant.payload).includes('p!4z') && !JSON.stringify(grant.payload).includes('PRIVATE KEY'));
  mkdirSync(keyDir);
  for (const row of grant.payload.targets) if (row.auth === 'key') writeFileSync(join(keyDir, row.id + '.pub'), publicKeyLine(row));
  const config = join(dir, 'ssh_config');
  writeFileSync(config, renderSshConfig(grant.payload.targets, { node: process.execPath, code, socket, keys: keyDir }));
  // Paths reach the shell scripts below as environment variables, never spliced into the script text.
  const env = { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8', ...broker.environment(grant.payload),
    SSH_CONFIG_FILE: config, NODE: process.execPath, GATE: join(code, 'ssh-gate.mjs'), HELPER: join(code, 'ssh-askpass.mjs'), AGENT_SOCKET: socket };
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');

  // The daemon registers a command's shell right after spawning it; every process in that group may use the grant.
  const registered = async (script, payload = grant.payload) => {
    const pending = run('/bin/sh', ['-c', script], env);
    assert.ok(broker.register(run.last.pid, payload, 'command'));
    const result = await pending;
    broker.release(run.last.pid);
    return result;
  };
  const ssh = alias => `ssh -F "$SSH_CONFIG_FILE" -o BatchMode=no ${alias} hello`;

  const direct = await registered(ssh('build-box'));
  assert.equal(direct.code, 0, direct.stderr);
  assert.equal(direct.stdout, 'ran hello\n');
  // Newer OpenSSH may warn about the test server's key exchange; a fingerprint complaint must never appear.
  assert.doesNotMatch(direct.stderr, /ssh_host_key_mismatch|ssh_target_denied/);
  env.TUNNEL_ID = ids.tunnel; env.DECOY_PORT = String(elsewhere.address().port); env.ECHO_ID = ids.echo;
  const tunnel = await registered(`${ssh('lab-board')} && "$NODE" "$GATE" tunnel "$AGENT_SOCKET" "$TUNNEL_ID" 127.0.0.1 "$DECOY_PORT" </dev/null >/dev/null`);
  assert.equal(tunnel.code, 0, tunnel.stderr);
  const password = await registered(ssh('old-board'));
  assert.equal(password.code, 0, password.stderr);
  assert.ok(!password.stdout.includes('p!4z') && !password.stderr.includes('p!4z'));
  assert.equal(decoy, 0);
  // Through daemon and control plane, the last answer arrives after the caller ended its side.
  const halfClosed = await registered('printf ping | "$NODE" "$GATE" tunnel "$AGENT_SOCKET" "$ECHO_ID"');
  assert.equal(halfClosed.code, 0, halfClosed.stderr);
  assert.equal(halfClosed.stdout, 'ping');
  // Only the registered fingerprint is accepted for the host key.
  const pinned = await registered(ssh('wrong-pin'));
  assert.equal(pinned.code, 255); assert.match(pinned.stderr, /ssh_host_key_mismatch/); assert.match(pinned.stderr, /Host key verification failed/);
  const relayed = await registered(ssh('relay-box'));
  assert.equal(relayed.code, 255); assert.match(relayed.stderr, /ssh_relay_unavailable/);

  // The QA-only alias, a process outside any registered group, and a process that left its group are refused by name.
  const qa = await registered(ssh('qa-only'));
  assert.equal(qa.code, 255); assert.match(qa.stderr, /ssh_target_denied: qa-only/);
  const outsider = await run('/bin/sh', ['-c', ssh('build-box')], env);
  assert.equal(outsider.code, 255); assert.match(outsider.stderr, /ssh_target_denied: build-box/);
  const escaped = await registered(`setsid ${ssh('build-box')}`);
  assert.equal(escaped.code, 255); assert.match(escaped.stderr, /ssh_target_denied/);
  // The password helper answers only an ssh parent with a prompt for one registered user@host.
  const askpass = await registered(`"$HELPER" "board@127.0.0.1's password: "`);
  assert.equal(askpass.code, 1); assert.equal(askpass.stdout, '');

  // Unregistered hosts keep their own settings: the generated config never wraps them.
  const github = await run('ssh', ['-F', config, '-G', 'git@github.com'], env);
  assert.doesNotMatch(github.stdout, /ssh-gate|proxycommand \/|identityagent/i);

  // A revoked role refuses the next connection; so does the end of the run.
  await admin(`${project}/${ids.direct}`, 'PUT', { allowed_roles: ['qa'] });
  const revoked = await registered(ssh('build-box'));
  assert.equal(revoked.code, 255); assert.match(revoked.stderr, /ssh_target_denied/);
  running = false;
  const ended = await registered(ssh('old-board'));
  assert.equal(ended.code, 255); assert.match(ended.stderr, /ssh_target_denied/);
  grant.close();

  assert.ok(seen.auth.includes('deploy:publickey') && seen.auth.includes('board:password') && seen.auth.includes('tunnel:publickey'));
  assert.ok(!seen.auth.some(entry => entry.startsWith('qa:')));
  const audit = h.store.all("SELECT action,resource_id,user_id FROM audit WHERE action LIKE 'ssh_target.%'");
  for (const action of ['ssh_target.sign.ok', 'ssh_target.password.released', 'ssh_target.tunnel.opened', 'ssh_target.check.denied'])
    assert.ok(audit.some(row => row.action === action), action);
  assert.ok(!JSON.stringify(audit).includes('p!4z'));
});

test('short registered passwords are redacted from trace events and the tool output of the project', async t => {
  const h = await harness(t), { admin } = await setup(h), acc = await account(admin);
  await repository(admin, acc.id, '101');
  const created = await admin('/api/repositories/101/ssh-targets', 'POST', { alias: 'board', host: 'board.invalid', username: 'root',
    host_key_sha256: 'SHA256:' + 'A'.repeat(43), auth: 'password', password: 'pw7!', allowed_roles: ['dev'] });
  assert.equal(created.status, 201);
  assert.equal(configuredRedactor(h.store, '101').text('login pw7! ok'), 'login [REDACTED] ok');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('ssh-task','101','task.request','running','ssh fixture','{}')");
  traceEvent(h.store, 'ssh-task', 'command', { output: 'echo pw7!' });
  const stored = JSON.stringify(h.store.all("SELECT * FROM task_history WHERE task_id='ssh-task'"));
  assert.ok(stored.length > 2 && !stored.includes('pw7!'), stored);
});
