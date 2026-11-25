import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Docker } from '../../../manager/docker.mjs';
import { Projects } from '../../../manager/projects.mjs';
import { createManagerServer } from '../../../manager/server.mjs';
import { DockerComputeDriver } from '../../../manager/compute-driver.mjs';
import { RunnerClient } from '../../../manager/runner-client.mjs';
import { sshString } from '../../../runner/ssh-agent.mjs';
import { FakeDocker } from '../../fixtures/fake-docker.mjs';

const opId = () => randomBytes(24).toString('hex');
const gate = fileURLToPath(new URL('../../../runner/ssh-gate.mjs', import.meta.url));
const key = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 7))]).toString('base64');
const target = { id: 'a'.repeat(48), alias: 'build-box', host: '10.1.2.3', port: 2222, username: 'deploy', auth: 'key', route: 'direct',
  jump_id: null, host_key_sha256: 'SHA256:' + 'A'.repeat(43), public_key: key };
const board = { ...target, id: 'b'.repeat(48), alias: 'old-board', auth: 'password', public_key: null };

test('the manager forwards a run\'s SSH grant only to the daemon, writes the computer\'s ssh_config and never records the grant', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-ssh-')), work = join(dir, 'work'), sockets = join(dir, 'sockets');
  // Runner and agent sockets stay below the 107-byte sun_path limit, also inside deep worktree TMPDIRs.
  const sockDir = Buffer.byteLength(join(dir, 'sock', 'ssh-agent.sock')) < 100 ? join(dir, 'sock') : mkdtempSync(join('/tmp', 'mgr-ssh-'));
  for (const path of [work, sockets, sockDir]) mkdirSync(path, { recursive: true, mode: 0o770 });
  // Undone in reverse order once the test ends, also when it fails halfway: the directories go last.
  const undo = [];
  t.after(async () => { for (const step of undo.reverse()) await step(); });
  undo.push(() => { rmSync(dir, { recursive: true, force: true }); rmSync(sockDir, { recursive: true, force: true }); });
  const previous = { local: process.env.BOT_LOCAL_EXECUTION, work: process.env.BOT_LOCAL_WORKSPACE };
  process.env.BOT_LOCAL_EXECUTION = 'true'; process.env.BOT_LOCAL_WORKSPACE = work;
  undo.push(() => {
    for (const [name, value] of [['BOT_LOCAL_EXECUTION', previous.local], ['BOT_LOCAL_WORKSPACE', previous.work]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const checks = [];
  const controlPlane = createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => { checks.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) }); res.end(JSON.stringify({ ok: true })); });
  });
  controlPlane.listen(0, '127.0.0.1'); await once(controlPlane, 'listening');
  undo.push(() => new Promise(resolve => { controlPlane.closeAllConnections(); controlPlane.close(resolve); }));
  const { startRunnerDaemon } = await import('../../../runner/daemon.mjs');
  const token = randomBytes(32).toString('hex'), socketPath = join(sockDir, 'r.sock');
  const daemon = await startRunnerDaemon({ socketPath, token, ssh: { upstream: { url: `http://127.0.0.1:${controlPlane.address().port}` } } });
  undo.push(() => daemon.close());
  assert.ok(daemon.ssh, 'the daemon serves the agent socket');
  const client = new RunnerClient({ socketPath, token });
  undo.push(() => client.close());
  const docker = new FakeDocker();
  docker.volumeName = async () => null;
  docker.runnerClient = () => client;
  docker.runner = (_container, input, timeout) => { docker.runs.push(input); return client.execute(input, { timeoutMs: timeout }); };
  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'ssh1379', image: 'approved', runnerSockets: sockets });
  undo.push(() => projects.shutdown());
  // Calls go through the manager's own HTTP routing (manager/server.mjs), which checks the body's fields.
  const managerToken = randomBytes(32);
  const { server, recovered } = createManagerServer({ projects, token: managerToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  undo.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await recovered;
  const call = async (action, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/projects/101/${action}`, { method: 'POST',
      headers: { authorization: 'Bearer ' + managerToken.toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await res.json();
    if (res.status !== 200) throw Object.assign(new Error(value.error), { status: res.status });
    return value.result;
  };
  const execute = body => call('execute', body);
  await projects.register('101');

  const grant = 'rsg_' + randomBytes(32).toString('base64url');
  const ssh = { grant, targets: [target, board], allowed: [target.id, board.id], password: true };
  const command = `env | grep -E '^(SSH_|BOT_SSH)' | sort; ${process.execPath} ${gate} check ${daemon.ssh.socketPath} ${target.id} && echo allowed`;
  const operation = opId();
  const result = await execute({ operation_id: operation, generation: 1, request: { type: 'command', command, timeout_ms: 20_000 }, ssh });
  assert.equal(result.ok, true, JSON.stringify(result));
  const output = result.result.output;
  assert.match(output, new RegExp(`^SSH_AUTH_SOCK=${daemon.ssh.socketPath}$`, 'm'));
  assert.match(output, /^SSH_ASKPASS=.*ssh-askpass\.mjs$/m);
  assert.match(output, /^SSH_ASKPASS_REQUIRE=force$/m);
  assert.match(output, /^allowed$/m);
  assert.deepEqual(checks.map(row => [row.path, row.authorization, row.body.target]), [['/v1/ssh/check', 'Bearer ' + grant, target.id]]);
  // The same command without a grant has no SSH context and is refused.
  const bare = await execute({ operation_id: opId(), generation: 1, request: { type: 'command', command, timeout_ms: 20_000 } });
  assert.doesNotMatch(bare.result.output, /SSH_AUTH_SOCK|allowed/);

  // The computer's ssh_config and public keys, written by the manager into the runner directory it owns.
  const computer = join(sockets, createHash('sha256').update(projects.names('101', 1).container).digest('hex').slice(0, 24));
  const config = readFileSync(join(computer, 'ssh_config'), 'utf8');
  assert.match(config, /^Match originalhost build-box exec /m);
  assert.match(config, /^Host old-board$/m);
  assert.equal(statSync(join(computer, 'ssh_config')).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(join(computer, 'ssh-keys')), [target.id + '.pub']);
  assert.equal(readFileSync(join(computer, 'ssh-keys', target.id + '.pub'), 'utf8'), `ssh-ed25519 ${key} build-box\n`);

  // Neither the ledger, its trajectory files nor the runner journal keep the grant; a replay answers without it.
  const ledger = new DatabaseSync(join(dir, 'manager.sqlite'), { readOnly: true });
  undo.push(() => ledger.close());
  assert.ok(!JSON.stringify(ledger.prepare('SELECT * FROM operations').all()).includes(grant));
  const files = [];
  const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) entry.isDirectory() ? walk(join(path, entry.name)) : files.push(join(path, entry.name)); };
  walk(dir);
  for (const file of files.filter(path => !path.endsWith('.sock'))) assert.ok(!readFileSync(file).includes(grant), file);
  const replay = await execute({ operation_id: operation, generation: 1, request: { type: 'command', command, timeout_ms: 20_000 } });
  assert.equal(replay.result.output, output);

  // An agent start registers the agent process: the groups of its direct children use the grant (runner/agent.mjs).
  const workspace = opId();
  assert.equal((await execute({ operation_id: opId(), generation: 1, request: { type: 'workspace_init', workspace_id: workspace } })).ok, true);
  mkdirSync(join(work, 'tasks', workspace, 'agent'), { recursive: true });
  writeFileSync(join(work, 'tasks', workspace, 'agent', 'input.json'), '{}');
  assert.equal(daemon.ssh.agents.size, 0);
  const started = await execute({ operation_id: opId(), generation: 1, request: { type: 'workspace_agent_start', workspace_id: workspace }, ssh });
  assert.equal(started.result?.started, true, JSON.stringify(started));
  assert.equal(daemon.ssh.agents.size, 1);
  const [agentPid] = daemon.ssh.agents.keys();
  assert.equal(daemon.ssh.groups.get(agentPid)?.kind, 'agent');
  await execute({ operation_id: opId(), generation: 1, request: { type: 'reap', workspace_id: workspace } });

  // A compute node (#1380) routes an execute to the same Projects; its driver accepts the grant beside the cluster fields.
  const driver = new DockerComputeDriver({ dataDir: join(dir, 'node'), docker });
  driver.projects = projects; driver.ready = true;
  const relayed = await driver.dispatchLocalManagerRequest('POST', '/v1/projects/101/execute', { operation_id: opId(), generation: 1,
    request: { type: 'command', command: 'echo "$SSH_AUTH_SOCK"', timeout_ms: 20_000 }, ssh, node_id: 'lab-node-1', binding_epoch: 1 });
  assert.equal(relayed.result.output.trim(), daemon.ssh.socketPath);

  // A grant rides only with a call that starts processes, and only in its validated shape.
  await assert.rejects(execute({ operation_id: opId(), generation: 1, request: { type: 'read', path: 'x' }, ssh }), /invalid_ssh_grant/);
  await assert.rejects(execute({ operation_id: opId(), generation: 1, request: { type: 'command', command: 'true' },
    ssh: { ...ssh, targets: [{ ...target, alias: 'x\nHost *' }] } }), /invalid_ssh_grant/);
  await assert.rejects(call('stop', { operation_id: opId(), generation: 1, ssh }), /invalid_input/);
  await assert.rejects(projects.operate('101', 'stop', { operation_id: opId(), generation: 1, ssh }), /invalid_ssh_grant/);
});

test('a one-shot exec of the runner never carries an SSH grant', async () => {
  const docker = new Docker('/nonexistent.sock');
  let sent;
  docker.execRunner = async (_container, input) => { sent = input; return { ok: true }; };
  await docker.runner('computer', { operation_id: opId(), type: 'command', command: 'true', ssh: { grant: 'rsg_x' } });
  assert.equal(Object.hasOwn(sent, 'ssh'), false);
});
