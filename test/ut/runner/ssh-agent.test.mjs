import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT, AgentReader, SshAgentBroker, agentFrame, sshString } from '../../../runner/ssh-agent.mjs';
import { renderSshConfig, validSshGrant } from '../../../runner/ssh-config.mjs';

const agentModule = fileURLToPath(new URL('../../../runner/ssh-agent.mjs', import.meta.url));
const askpass = fileURLToPath(new URL('../../../runner/ssh-askpass.mjs', import.meta.url));
const id = n => String(n).repeat(48).slice(0, 48);
const pin = 'SHA256:' + 'A'.repeat(43);
const blob = name => Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, name))]).toString('base64');
const target = (n, extra = {}) => ({ id: id(n), alias: `host-${n}`, host: '10.0.0.' + n, port: 22, username: 'deploy', auth: 'key', route: 'direct',
  jump_id: null, host_key_sha256: pin, public_key: blob(n), ...extra });
const payload = (allowed, targets, secret = 'a') => ({ grant: 'rsg_' + secret.repeat(43).slice(0, 43), targets, allowed, password: targets.some(row => allowed.includes(row.id) && row.auth === 'password') });

// A process that asks the agent for its identities and a signature with the first one, then prints what it got.
const client = socket => `
const { AGENT, AgentReader, agentFrame, sshString } = await import(${JSON.stringify(agentModule)});
const s = (await import('node:net')).connect(${JSON.stringify(socket)});
let buffer = Buffer.alloc(0); const replies = [];
const next = () => new Promise(resolve => replies.push(resolve));
s.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) { const n = buffer.readUInt32BE(0); replies.shift()(buffer.subarray(4, 4 + n)); buffer = buffer.subarray(4 + n); } });
await new Promise(resolve => s.on('connect', resolve));
let reply = next(); s.write(agentFrame(AGENT.REQUEST_IDENTITIES)); const ids = await reply;
const reader = new AgentReader(ids, 1), count = reader.uint32(), keys = [];
for (let i = 0; i < count; i++) keys.push({ blob: reader.string().toString('base64'), comment: reader.string().toString() });
let signed = null;
if (keys.length) { reply = next(); s.write(agentFrame(AGENT.SIGN_REQUEST, sshString(Buffer.from(keys[0].blob, 'base64')), sshString('session'), Buffer.from([0,0,0,2]))); const answer = await reply;
  signed = answer[0] === AGENT.SIGN_RESPONSE ? new AgentReader(answer, 1).string().toString() : 'refused'; }
console.log(JSON.stringify({ keys: keys.map(k => k.comment), signed })); s.end();`;

// Paths reach shell scripts as environment variables, never spliced into the script text.
const shell = (script, env = {}) => run('/bin/sh', ['-c', script], { ...process.env, NODE: process.execPath, ...env });
function run(command, args, env = process.env) {
  const child = spawn(command, args, { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
  return { child, done };
}

// A socket path must stay below the 107-byte sun_path limit, also inside deep worktree TMPDIRs.
export function socketDirectory(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (Buffer.byteLength(join(dir, 'ssh-agent.sock')) < 100) return dir;
  rmSync(dir, { recursive: true, force: true });
  return mkdtempSync(join('/tmp', prefix));
}

async function fixture(t, options = {}) {
  const dir = socketDirectory('ssh-agent-'), socket = join(dir, 'agent.sock'), seen = [];
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = createHttpServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => {
      seen.push({ path: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      const answer = options.answer?.(req.url, JSON.parse(body || 'null'));
      res.end(JSON.stringify(answer ?? (req.url === '/v1/ssh/sign' ? { ok: true, signature: Buffer.from('signed-by-control-plane').toString('base64') } : { ok: true })));
    });
  });
  upstream.on('upgrade', (req, socketToClient) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    socketToClient.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: bot-ssh-tunnel\r\n\r\n');
    // The answer comes after the caller has already ended its side, as a remote's last reply does.
    socketToClient.on('data', data => setTimeout(() => socketToClient.write(data), 150));
    socketToClient.on('end', () => setTimeout(() => socketToClient.end(), 300));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const broker = await new SshAgentBroker({ socketPath: socket, upstream: { url: `http://127.0.0.1:${upstream.address().port}` }, ...options.broker }).start();
  t.after(() => broker.close());
  return { broker, socket, seen };
}

test('the agent lists and signs only its run\'s keys for a registered group; setsid and unregistered callers get nothing', async t => {
  const { broker, socket, seen } = await fixture(t);
  const grant = payload([id(1), id(2)], [target(1), target(2), target(3)]);
  const registered = shell('"$NODE" --input-type=module -e "$CLIENT"; setsid "$NODE" --input-type=module -e "$CLIENT"', { CLIENT: client(socket) });
  assert.ok(broker.register(registered.child.pid, grant, 'command'));
  const [inside, escaped] = (await registered.done).stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(inside, { keys: ['host-1', 'host-2'], signed: 'signed-by-control-plane' });
  assert.deepEqual(escaped, { keys: [], signed: null });
  const outsider = run(process.execPath, ['--input-type=module', '-e', client(socket)]);
  assert.deepEqual(JSON.parse((await outsider.done).stdout), { keys: [], signed: null });
  // The control plane gets the grant and the target, never more: a signature request names only the key.
  const sign = seen.filter(row => row.path === '/v1/ssh/sign');
  assert.equal(sign.length, 1);
  assert.equal(sign[0].authorization, 'Bearer ' + grant.grant);
  assert.deepEqual(Object.keys(sign[0].body).sort(), ['data', 'flags', 'key', 'target']);
  assert.equal(sign[0].body.target, id(1));
  assert.equal(sign[0].body.flags, 2);
  // A released group is refused, even while its leader is alive.
  const late = shell('sleep 0.3; "$NODE" --input-type=module -e "$CLIENT"', { CLIENT: client(socket) });
  assert.ok(broker.register(late.child.pid, grant, 'command'));
  broker.release(late.child.pid);
  assert.deepEqual(JSON.parse((await late.done).stdout), { keys: [], signed: null });
});

test('an agent process passes its grant to the groups of its direct children, not to groups they start', async t => {
  const { broker, socket } = await fixture(t);
  const grant = payload([id(1)], [target(1)]);
  // The agent starts a detached child (a command's shell, as runner/command.mjs does), which starts a detached grandchild.
  const script = `
    const { spawn } = await import('node:child_process');
    const start = (args, env) => new Promise(resolve => { const c = spawn(process.execPath, args, { detached: true, env, stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''; c.stdout.on('data', d => out += d); c.on('close', () => resolve(out.trim())); });
    const child = await start(['--input-type=module', '-e', process.env.CLIENT], process.env);
    const nested = await start(['--input-type=module', '-e', "const { spawn } = await import('node:child_process'); const c = spawn(process.execPath, ['--input-type=module', '-e', process.env.CLIENT], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); c.on('close', () => {});"], process.env);
    console.log(child); console.log(nested);`;
  const agent = shell('sleep 0.2; exec "$NODE" --input-type=module -e "$AGENT"', { AGENT: script, CLIENT: client(socket) });
  assert.ok(broker.register(agent.child.pid, grant, 'agent'));
  const [child, nested] = (await agent.done).stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(child.keys, ['host-1']);
  assert.deepEqual(nested.keys, []);
});

test('askpass answers only the image\'s ssh binary in the same group with a prompt naming exactly one password target', async t => {
  // The "ssh binary" here is node itself: the helper is started by a node process standing in for ssh.
  const { broker } = await fixture(t, { broker: { sshBinary: process.execPath }, answer: path => path === '/v1/ssh/password' ? { ok: true, password: 'pw' } : undefined });
  const board = target(4, { auth: 'password', public_key: null, username: 'root', host: 'board.lan' });
  const twin = target(5, { auth: 'password', public_key: null, username: 'root', host: 'board.lan', port: 2222 });
  const ask = async (grant, prompt, parent = process.execPath) => {
    const launcher = parent === process.execPath
      ? `"$NODE" -e "require('child_process').spawn(process.env.HELPER,[process.env.PROMPT],{stdio:'inherit'}).on('close',c=>process.exit(c))"`
      : `/bin/sh -c '"$HELPER" "$PROMPT"; exit $?'`;
    const pending = shell(launcher, { ...broker.environment(grant), PROMPT: prompt, HELPER: askpass });
    assert.ok(broker.register(pending.child.pid, grant, 'command'));
    return pending.done;
  };
  const only = payload([board.id], [board]);
  assert.equal(broker.environment(only).SSH_ASKPASS, askpass);
  assert.deepEqual(await ask(only, "root@board.lan's password: "), { code: 0, stdout: 'pw\n', stderr: '' });
  assert.equal((await ask(only, '(root@board.lan) Password: ')).stdout, 'pw\n');
  for (const [grant, prompt, parent] of [
    [only, "admin@board.lan's password: "],
    [only, "Enter passphrase for key '/x': "],
    [payload([board.id, twin.id], [board, twin]), "root@board.lan's password: "],
    [only, "root@board.lan's password: ", '/bin/sh'],
  ]) {
    const refused = await ask(grant, prompt, parent);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /ssh_target_denied/);
  }
});

test('tunnels carry bytes for the registered target id only, within the per-run limit', async t => {
  const { broker, socket, seen } = await fixture(t, { broker: { limits: { perGrant: 1, perComputer: 32, idleMs: 60_000, lifetimeMs: 60_000 } } });
  const lab = target(6, { route: 'tunnel' }), plain = target(7);
  const grant = payload([lab.id, plain.id], [lab, plain]);
  const gate = fileURLToPath(new URL('../../../runner/ssh-gate.mjs', import.meta.url));
  const paths = { GATE: gate, SOCK: socket, LAB: lab.id, PLAIN: plain.id };
  const both = shell('printf ping | "$NODE" "$GATE" tunnel "$SOCK" "$LAB" 203.0.113.9 9; echo; "$NODE" "$GATE" tunnel "$SOCK" "$PLAIN" </dev/null; echo " direct:$?"', paths);
  assert.ok(broker.register(both.child.pid, grant, 'command'));
  const { stdout, stderr } = await both.done;
  assert.match(stdout, /^ping\n/);
  assert.match(stdout, /direct:1/);
  assert.match(stderr, /ssh_target_denied/);
  const tunnels = seen.filter(row => row.path?.startsWith('/v1/ssh/tunnel/'));
  assert.deepEqual(tunnels.map(row => row.path), [`/v1/ssh/tunnel/${lab.id}`]);
  // A second open tunnel of the same run is refused while the first one lasts.
  const holder = shell('sleep 2 | "$NODE" "$GATE" tunnel "$SOCK" "$LAB" & sleep 0.5; "$NODE" "$GATE" tunnel "$SOCK" "$LAB" </dev/null; echo "second:$?"; kill $!', paths);
  assert.ok(broker.register(holder.child.pid, grant, 'command'));
  const second = await holder.done;
  assert.match(second.stdout, /second:1/);
  assert.match(second.stderr, /ssh_tunnel_limit/);
});

test('the agent socket answers malformed or unknown messages with a failure or by closing', async t => {
  const { socket } = await fixture(t);
  const exchange = data => new Promise(resolve => {
    const s = connect(socket); let got = Buffer.alloc(0);
    s.on('data', chunk => { got = Buffer.concat([got, chunk]); });
    s.on('close', () => resolve(got)); s.on('error', () => {});
    s.on('connect', () => { s.write(data); setTimeout(() => s.end(), 300); });
  });
  assert.deepEqual([...await exchange(agentFrame(17))], [0, 0, 0, 1, AGENT.FAILURE]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(512 * 1024);
  assert.equal((await exchange(oversized)).length, 0);
  const reply = await exchange(agentFrame(AGENT.EXTENSION, sshString('check@bot-runner'), sshString(id(1))));
  assert.equal(reply[4], AGENT.EXTENSION_FAILURE);
  assert.equal(new AgentReader(reply.subarray(4), 1).string().toString(), 'ssh_target_denied');
});

test('the grant and the generated ssh_config accept only registered aliases with safe values', () => {
  const jump = target(1), behind = target(2, { route: 'proxy_jump', jump_id: id(1) }), lab = target(3, { route: 'tunnel', auth: 'password', public_key: null, username: 'CORP\\ops' });
  const grant = validSshGrant(payload([id(1)], [jump, behind, lab]));
  assert.equal(grant.targets.length, 3);
  for (const bad of [
    { ...payload([], [target(1, { alias: 'x\n  ProxyCommand sh' })]) },
    { ...payload([], [target(1, { host: 'a b' })]) },
    { ...payload([], [target(1), target(2, { alias: 'host-1' })]) },
    { ...payload([], [target(2, { route: 'proxy_jump', jump_id: id(9) })]) },
    { ...payload([id(9)], [target(1)]) },
    { ...payload([], [target(1)]), extra: true },
    { ...payload([], [target(1, { auth: 'password' })]) },
  ]) assert.throws(() => validSshGrant(bad), /invalid_ssh_grant/);
  const config = renderSshConfig(grant.targets);
  assert.doesNotMatch(config, /^Host \*/m);
  assert.match(config, new RegExp(`^Match originalhost host-1 exec "/usr/local/bin/node /opt/runner/ssh-gate.mjs check /run/bot-runner/ssh-agent.sock ${id(1)}"$`, 'm'));
  assert.match(config, /^Host host-2\n {2}ProxyCommand \/usr\/local\/bin\/node \/opt\/runner\/ssh-gate.mjs deny \/run\/bot-runner\/ssh-agent.sock host-2$/m);
  assert.match(config, /ProxyJump host-1/);
  assert.match(config, new RegExp(`ProxyCommand /usr/local/bin/node /opt/runner/ssh-gate.mjs tunnel /run/bot-runner/ssh-agent.sock ${id(3)}`));
  assert.match(config, /User "CORP\\\\ops"/);
  assert.match(config, /IdentityFile \/run\/bot-runner\/ssh-keys\/1{48}\.pub/);
  assert.match(config, /KnownHostsCommand \/usr\/local\/bin\/node \/opt\/runner\/ssh-gate.mjs known-host \/run\/bot-runner\/ssh-agent.sock SHA256:A{43} %I %H %t %K/);
  assert.throws(() => renderSshConfig(grant.targets, { node: '/bin/node; rm' }), /invalid_ssh_path/);
});

test('commands inherit the SSH environment only from an agent the daemon started with a grant', async () => {
  const module = fileURLToPath(new URL('../../../runner/command.mjs', import.meta.url));
  const read = async env => JSON.parse((await run(process.execPath, ['--input-type=module', '-e',
    `const { environment } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(environment))`], { PATH: process.env.PATH, ...env }).done).stdout);
  const granted = await read({ BOT_SSH_BROKER: '1', SSH_AUTH_SOCK: '/run/bot-runner/ssh-agent.sock', SSH_ASKPASS: '/opt/runner/ssh-askpass.mjs', SSH_ASKPASS_REQUIRE: 'force' });
  assert.equal(granted.SSH_AUTH_SOCK, '/run/bot-runner/ssh-agent.sock');
  assert.equal(granted.SSH_ASKPASS_REQUIRE, 'force');
  // A host's own agent (local execution, a developer shell) never reaches task commands.
  const host = await read({ SSH_AUTH_SOCK: '/home/someone/.ssh/agent.sock', SSH_ASKPASS: '/usr/bin/ksshaskpass' });
  assert.equal(host.SSH_AUTH_SOCK, undefined);
  assert.equal(host.SSH_ASKPASS, undefined);
});

test('a socket path the kernel would truncate is refused instead of bound elsewhere', async () => {
  await assert.rejects(new SshAgentBroker({ socketPath: '/tmp/' + 'x'.repeat(110) + '.sock' }).start(), /ssh_agent_socket_path_too_long/);
});

test('a running agent moves to a newer grant only for its own task directory; another task\'s agent or process never does', async t => {
  const { broker, socket } = await fixture(t);
  const first = payload([id(1)], [target(1), target(2)], 'a'), second = payload([id(2)], [target(1), target(2)], 'b');
  const own = 'c'.repeat(48), other = 'd'.repeat(48);
  // The agent waits for a line on stdin before each child, so the test can re-arm between them.
  const script = `
    const { spawn } = await import('node:child_process');
    const child = () => new Promise(resolve => { const c = spawn(process.execPath, ['--input-type=module', '-e', process.env.CLIENT], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''; c.stdout.on('data', d => out += d); c.on('close', () => resolve(out.trim())); });
    const lines = (await import('node:readline')).createInterface({ input: process.stdin });
    for await (const _ of lines) console.log(await child());`;
  const agent = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, env: { ...process.env, CLIENT: client(socket) }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => { try { process.kill(-agent.pid, 'SIGKILL'); } catch {} });
  assert.ok(broker.register(agent.pid, first, 'agent', own));
  const answers = [];
  agent.stdout.on('data', data => answers.push(...String(data).trim().split('\n').map(line => JSON.parse(line).keys)));
  const ask = async count => { agent.stdin.write('next\n'); while (answers.length < count) await new Promise(resolve => setTimeout(resolve, 20)); };
  await ask(1);
  // Another task wrote this agent's pid into its own state.json: its call does not move this agent.
  assert.equal(broker.rearm(agent.pid, second, other), false);
  assert.equal(broker.rearm(agent.pid, second, null), false);
  await ask(2);
  assert.ok(broker.rearm(agent.pid, second, own));
  await ask(3);
  assert.deepEqual(answers, [['host-1'], ['host-1'], ['host-2']]);
  // Only a process registered as an agent can be re-armed: not a pid read from a file a task could write.
  const stranger = spawn('sleep', ['5'], { detached: true });
  t.after(() => { try { process.kill(stranger.pid, 'SIGKILL'); } catch {} });
  assert.equal(broker.rearm(stranger.pid, second, own), false);
  assert.equal(broker.rearm(agent.pid, { ...second, grant: 'not-a-grant' }, own), false);
  agent.stdin.end();
});

test('starting or continuing a session that is already running hands its pid to the daemon instead of spawning', async t => {
  const { agentOperation } = await import('../../../runner/agent.mjs');
  const root = mkdtempSync(join(tmpdir(), 'agent-attach-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stat = readFileSync('/proc/1/stat', 'utf8'), boot = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  mkdirSync(join(root, 'agent'), { recursive: true });
  writeFileSync(join(root, 'agent', 'state.json'), JSON.stringify({ state: 'running', pid: process.pid, boot }));
  const attached = [], spawned = [];
  const hooks = { _onAttach: pid => attached.push(pid), _onSpawn: pid => spawned.push(pid) };
  assert.deepEqual(await agentOperation({ type: 'workspace_agent_start', ...hooks }, root), { started: true });
  assert.deepEqual(await agentOperation({ type: 'workspace_agent_continue', ...hooks }, root), { written: true });
  assert.deepEqual(attached, [process.pid, process.pid]);
  assert.deepEqual(spawned, []);
});
