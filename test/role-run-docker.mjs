// Real-Docker acceptance of per-run environments (#169). It builds a test image from an existing project-computer image
// with this checkout's runner on top, starts this checkout's manager in-process under a deployment id of its own, and
// removes every container, network, volume and image it created. Nothing of another Compose project is touched.
//   npm run test:isolation:docker            (BOT_TEST_BASE_IMAGE overrides the base image)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Docker } from '../manager/docker.mjs';
import { Projects } from '../manager/projects.mjs';
import { RunEnvironments } from '../manager/run-environments.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { ManagerClient } from '../dist/projects/service.js';
import { RunEnvironmentClient, provisionRunEnvironment, copyCommit } from '../dist/projects/run-environment.js';
import { Store } from '../dist/storage/database.js';
import { saveModelMetadata } from '../dist/models/catalog.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { Workspace } from '../dist/agent/workspace.js';
import { Redactor } from '../dist/agent/common.js';
import { runRole, roleRuns } from '../dist/roles/run.js';
import { registerRoleHarness } from '../dist/roles/harness.js';
import { roleApi } from '../dist/roles/api.js';
import { roleWorkspaces } from '../dist/roles/workspace.js';
import { persistentCliStateWorkspaceId } from '../dist/harness/container-session.js';
import { AgentToolManager } from '../dist/harness/agent-tools.js';
import { claudeBinary } from '../dist/harness/claude-code.js';

const tag = randomBytes(4).toString('hex'), root = resolve('.tmp/role-run-docker'), work = join(root, tag);
const deployment = 'rr169' + tag, image = `dbot-role-run-169-${tag}:test`, managerImage = `dbot-manager-705-${tag}:test`, repo = '169' + String(parseInt(tag, 16) % 100000).padStart(5, '0');
const base = process.env.BOT_TEST_BASE_IMAGE || 'department-bot-project-computer:local';
mkdirSync(work, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
const evidence = { tag, deployment, base_image: base, image, repository: repo, checks: [], started_at: new Date().toISOString() };
const passed = (name, detail = null) => { evidence.checks.push({ name, detail }); console.log('PASS ' + name); };
// The manager on the host: notes live in a host directory, so no helper container is needed to resolve them.
let activeToolsVolume = null;
class HostDocker extends Docker {
  async volumeSource(directory) { return directory; }
  async volumeName(destination) { return destination === '/opt/agent-tools' ? activeToolsVolume : null; }
}
const id = () => randomBytes(24).toString('hex');
let projects, runs, server, store, llmServer, ghMockServer;
const prevToolsDir = process.env.BOT_AGENT_TOOLS_DIR;
const prevClaudeCfg = process.env.BOT_CLAUDE_CODE_CONFIG;
const prevCodexCfg = process.env.BOT_CODEX_CONFIG;
try {
  // 1. Test image: the base project-computer image with this checkout's runner files.
  const context = join(work, 'context'); mkdirSync(join(context, 'runner'), { recursive: true });
  for (const name of readdirSync('runner')) if (name.endsWith('.mjs')) cpSync(join('runner', name), join(context, 'runner', name));
  writeFileSync(join(context, 'Dockerfile'), `FROM ${base}\nUSER root\nCOPY runner/ /opt/runner/\nRUN mkdir -p /opt/agent-tools && chown 10001:10001 /opt/agent-tools && chmod 755 /opt/agent-tools && for f in /opt/runner/*.mjs; do node --check "$f"; done && chmod a-w /opt/runner /opt/runner/*.mjs\nUSER 10001:10001\n`);
  sh('docker', ['build', '-q', '-t', image, '--label', 'department.bot.deployment=' + deployment, context]);
  sh('docker', ['build', '-q', '-f', 'manager/Dockerfile', '-t', managerImage, '--label', 'department.bot.deployment=' + deployment, '.']);
  passed('test image built from ' + base);

  projects = new Projects({ database: join(work, 'manager.sqlite'), docker: new HostDocker(), deployment, image, egress: false });
  runs = new RunEnvironments(projects);
  const token = randomBytes(32), created = createManagerServer({ projects, token, runs }); server = created.server;
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); await created.recovered;
  const manager = new ManagerClient('http://127.0.0.1:' + server.address().port, token), client = new RunEnvironmentClient(manager, repo);
  await manager.call('PUT', `/v1/projects/${repo}`, undefined, 300000);
  const computer = async request => { const r = await manager.call('POST', `/v1/projects/${repo}/execute`, { operation_id: id(), generation: 1, request }, 0); return r.ok ? r.result : { error: r.error, detail: r.detail }; };
  const sh1 = async command => computer({ type: 'command', command, timeout_ms: 60000 });

  // 2. The developer's workspace on the shared project computer: a commit with a symlink to /etc/passwd and one out of
  //    the checkout, a secret in the developer HOME and a long-lived process with a secret in its environment.
  const devWs = id();
  const seeded = await sh1(`set -e; rm -rf /workspace/seed; mkdir -p /workspace/seed; cd /workspace/seed; git init -q; echo hello > a.txt; ln -s /etc/passwd evil-link; ln -s ../../home outside-link;
git add -A; git -c user.email=t@e -c user.name=t commit -qm seed; git rev-parse HEAD; git rev-parse 'HEAD^{tree}'`);
  const [sha, tree] = seeded.output.trim().split('\n');
  await computer({ type: 'git_have' });
  await sh1(`git -C /workspace/git/repo.git fetch -q /workspace/seed +HEAD:refs/bot/commits/${sha}`);
  assert.equal((await computer({ type: 'workspace_checkout', workspace_id: devWs, sha, tree_sha: tree })).tree_sha, tree);
  await sh1('mkdir -p /workspace/home && echo DEV_HOME_SECRET > /workspace/home/dev-secret');
  await computer({ type: 'workspace_command', workspace_id: devWs, command: 'DEV_ENV_SECRET=dev-process-secret-169 nohup sleep 600 >/dev/null 2>&1 &', keep_background: true, timeout_ms: 5000 });
  // Positive control: the developer's process and HOME secret do exist on the shared computer.
  const control = await sh1('ps -eo args | grep -c "[s]leep 600"; cat /workspace/home/dev-secret');
  assert.match(control.output, /^[1-9]\d*\nDEV_HOME_SECRET/);
  passed('developer workspace prepared on the project computer', { sha, tree, control: control.output.trim() });

  // 3. A reviewer run environment, verified by the control plane, seeded by copying the commit (no mount).
  const r1 = id(), env1 = await provisionRunEnvironment(client, { run_id: r1, task_id: 'task-169', lease_epoch: 1, profile: 'observer', limits: { pids: 128, memory_mb: 512, workspace_mb: 256, tmp_mb: 64, timeout_ms: 600000 } });
  assert.equal(env1.facts.verified, true, JSON.stringify(env1.facts.detail));
  const raw = JSON.parse(sh('docker', ['inspect', env1.described.container.name]))[0];
  assert.deepEqual([raw.Config.User, raw.HostConfig.ReadonlyRootfs, raw.HostConfig.CapDrop, raw.HostConfig.NetworkMode, raw.Mounts.length, raw.HostConfig.Binds ?? null, raw.HostConfig.Privileged], ['10001:10001', true, ['ALL'], 'none', 0, null, false]);
  passed('run container hardening inspected', { user: raw.Config.User, readonly: raw.HostConfig.ReadonlyRootfs, network: raw.HostConfig.NetworkMode, mounts: raw.Mounts.length, tmpfs: Object.keys(raw.HostConfig.Tmpfs) });
  const copied = await copyCommit({ call: computer }, client, r1, sha, tree);
  assert.equal(copied.tree_hash, tree);
  const run1 = command => client.call(r1, { type: 'workspace_command', command, timeout_ms: 60000 });
  passed('fixed candidate copied into the run container and its tree verified', copied);

  const mounts=await run1("cat /proc/mounts | awk '$2==\"/workspace\" || $2==\"/tmp\" {print $2,$4}'");
  assert.equal(mounts.exit_code,0,mounts.output);
  const mounted=new Map(mounts.output.trim().split('\n').map(line=>{const [path,options]=line.split(' ');return [path,options.split(',')];}));
  for(const path of ['/workspace','/tmp']){
    const options=mounted.get(path);assert.ok(options,path);
    for(const option of ['rw','nosuid','nodev'])assert.ok(options.includes(option),`${path}: ${option}`);
    assert.ok(!options.includes('noexec'),`${path} permits compiled programs`);
  }
  const executable=await run1(`set -eu
for directory in /workspace /tmp; do
  printf '#!/bin/sh\\nprintf "script-ok\\\\n"\\n' > "$directory/mount-probe.sh"
  chmod +x "$directory/mount-probe.sh"
  "$directory/mount-probe.sh"
  printf 'int main(void) { return 0; }\\n' | cc -x c - -o "$directory/mount-probe"
  "$directory/mount-probe"
done`);
  assert.equal(executable.exit_code,0,executable.output);assert.equal(executable.output,'script-ok\nscript-ok\n');
  passed('workspace and tmp retain nosuid/nodev and execute scripts and compiled binaries', {mounts:mounts.output,output:executable.output});
  // An approved image may include Go; also exercise its real temporary test binary when available.
  if((await run1('command -v go')).exit_code===0){
    const go=await run1(`set -eu; mkdir /workspace/mount-go-probe /tmp/mount-go-tmp; cd /workspace/mount-go-probe
export GOCACHE=/workspace/mount-go-cache GOMODCACHE=/workspace/mount-go-mod GOTMPDIR=/tmp/mount-go-tmp
trap 'rm -rf /workspace/mount-go-probe /workspace/mount-go-cache /workspace/mount-go-mod /tmp/mount-go-tmp /workspace/mount-go-probe.test' EXIT
printf 'module mountprobe\\n\\ngo 1.20\\n' > go.mod
printf 'package mountprobe\\nimport "testing"\\nfunc TestExecutable(t *testing.T) {}\\n' > executable_test.go
GOTOOLCHAIN=local GOPROXY=off GOMAXPROCS=2 go test -p=2 -v ./...
GOTOOLCHAIN=local GOPROXY=off GOMAXPROCS=2 go test -p=2 -c -o /workspace/mount-go-probe.test
/workspace/mount-go-probe.test -test.v`);
    assert.equal(go.exit_code,0,go.output);assert.match(go.output,/--- PASS: TestExecutable/);
    passed('Go tests execute from tmp and the compiled test binary executes from workspace',{output:go.output});
  }

  // 4. The developer changes the original workspace; the reviewer's input does not change.
  await computer({ type: 'workspace_command', workspace_id: devWs, command: 'echo changed > a.txt && echo extra > b.txt', timeout_ms: 5000 });
  const view = await run1('cat a.txt; ls; git rev-parse "HEAD^{tree}"');
  assert.match(view.output, /^hello\n/); assert.ok(!view.output.includes('b.txt')); assert.ok(view.output.includes(tree));
  passed('concurrent developer changes do not reach the fixed candidate');

  // 5. Isolation of HOME, processes, environment, root filesystem, Docker socket and network.
  const probe = await run1(`cat /workspace/home/dev-secret 2>&1; ls /workspace/tasks; ps -eo args | grep -c "[s]leep 600" ; grep -a -l dev-process-secret /proc/*/environ 2>/dev/null | wc -l; env | grep -ci -E 'token|secret|key' ;
ls /var/run/docker.sock 2>&1; touch /opt/runner/x 2>&1; touch /etc/x 2>&1; cat /proc/net/route | wc -l; (getent hosts github.com || echo no-dns) 2>&1; ls /workspace/project-notes 2>&1 | head -1`);
  const lines = probe.output.split('\n');
  assert.match(lines[0], /No such file/); assert.equal(lines[1], r1);
  assert.equal(lines[2], '0', 'the developer process is not visible');
  assert.equal(lines[3], '0'); assert.equal(lines[4], '0');
  assert.match(probe.output, /docker\.sock'?: No such file/); assert.match(probe.output, /opt\/runner\/x'?: Read-only file system/); assert.match(probe.output, /\/etc\/x'?: Read-only file system/);
  assert.match(probe.output, /\n1\n/, 'the route table has only its header: no network interface besides loopback');
  assert.match(probe.output, /no-dns/); assert.match(probe.output, /project-notes'?: No such file/);
  passed('another role\'s HOME, processes, environment and volume are not visible; root is read-only; no Docker socket; no network', { output: probe.output });

  // 6. Malicious absolute paths, traversal and symlinks are refused by the runner and the manager.
  const refused = [];
  for (const request of [{ type: 'read', path: '/etc/passwd' }, { type: 'workspace_read', path: '../../home/dev-secret' }, { type: 'workspace_read', path: 'evil-link' }, { type: 'workspace_read', path: 'outside-link/x' },
    { type: 'workspace_write', path: '/workspace/home/x', base64: 'eA==', offset: 0, final: true, mode: '100644' }])
    refused.push([request.type, request.path, (await client.call(r1, request)).error ?? 'ALLOWED']);
  assert.ok(refused.every(r => r[2] !== 'ALLOWED'), JSON.stringify(refused));
  await assert.rejects(manager.call('POST', `/v1/projects/${repo}/runs/${r1}/execute`, { operation_id: id(), request: { type: 'workspace_command', workspace_id: devWs, command: 'id' } }), /cross_run_workspace/);
  passed('absolute paths, traversal, symlinks and other workspace ids are refused', refused);

  // 7. A second role's run environment: its HOME, cache and secrets never reach the first; a cache it poisons stays its own.
  const r2 = id(), env2 = await provisionRunEnvironment(client, { run_id: r2, task_id: 'task-169', lease_epoch: 2, profile: 'observer' });
  assert.equal(env2.facts.verified, true);
  await client.call(r2, { type: 'workspace_init' });
  await client.call(r2, { type: 'workspace_command', keep_background: true, command: 'mkdir -p /workspace/home/.npm/_cacache && echo POISON > /workspace/home/.npm/_cacache/index && echo R2_SECRET > /workspace/home/r2-secret && SECOND=r2-secret-env nohup sleep 300 >/dev/null 2>&1 &', timeout_ms: 10000 });
  const own2 = await client.call(r2, { type: 'command', command: 'ps -eo args | grep -c "[s]leep 300"; cat /workspace/home/r2-secret', timeout_ms: 10000 });
  assert.match(own2.output, /^[1-9]\d*\nR2_SECRET/, 'positive control inside the second run');
  const cross = await run1('ls /workspace/home/.npm 2>&1; cat /workspace/home/r2-secret 2>&1; ps -eo args | grep -c "[s]leep 300"');
  assert.match(cross.output, /No such file/); assert.ok(!cross.output.includes('POISON') && !cross.output.includes('R2_SECRET')); assert.match(cross.output, /\n0\n?$/);
  passed('a second run\'s HOME, cache and processes are invisible to the first; cache poisoning stays inside its own container', { output: cross.output });

  // 8. A writer run produces a candidate that reaches a new reviewer only by copying its commit.
  const w = id(), envW = await provisionRunEnvironment(client, { run_id: w, task_id: 'task-169', lease_epoch: 3, profile: 'writer' });
  await copyCommit({ call: computer }, client, w, sha, tree);
  await client.call(w, { type: 'workspace_command', command: 'echo "from writer" > a.txt', timeout_ms: 10000 });
  const produced = await client.call(w, { type: 'workspace_finalize' });
  const r3 = id(), env3 = await provisionRunEnvironment(client, { run_id: r3, task_id: 'task-169', lease_epoch: 4, profile: 'observer' });
  const handoff = await copyCommit({ call: request => client.call(w, request) }, client, r3, produced.local_sha, produced.tree_sha);
  assert.equal((await client.call(r3, { type: 'workspace_read', path: 'a.txt' })).content, 'from writer\n');
  await client.call(w, { type: 'workspace_command', command: 'echo "writer kept going" > a.txt', timeout_ms: 10000 });
  assert.equal((await client.call(r3, { type: 'workspace_read', path: 'a.txt' })).content, 'from writer\n');
  passed('a writer\'s candidate reaches a reviewer as a verified commit copy, unaffected by later writer changes', { commit: produced.local_sha, tree: handoff.tree_hash });

  // 9. Limits: processes, memory, disk, output and run time end only the offending run.
  const fork = await run1('out=$(for i in $(seq 1 400); do sleep 30 & done 2>&1 | tail -1); kill $(jobs -p) 2>/dev/null || true; wait 2>/dev/null || true; printf "%s\\ndone\\n" "$out"');
  assert.match(fork.output, /Resource temporarily unavailable|fork|retry/i);
  const memory = await run1('node -e "const a=[];for(;;)a.push(Buffer.alloc(16<<20,1))"; echo exit=$?');
  assert.match(memory.output, /exit=(137|134)/);
  const disk = await run1('out=$(dd if=/dev/zero of=/workspace/fill bs=1M count=400 2>&1 || true); rm -f /workspace/fill; printf "%s\\n" "$out" | grep -E "No space|copied"');
  assert.match(disk.output, /No space left/); assert.match(disk.output, /\(\d+ MB, 25[0-6](\.\d+)? MiB\) copied/);
  const output = await run1('yes | head -c 4000000');
  assert.equal(output.truncated, true);
  await run1('pkill sleep; true');
  const short = id(), envS = await provisionRunEnvironment(client, { run_id: short, task_id: 'task-169', lease_epoch: 5, profile: 'observer', limits: { timeout_ms: 15000 } });
  const timed = await client.call(short, { type: 'command', command: 'sleep 60', timeout_ms: 60000 });
  assert.equal(timed.timed_out, true);
  await new Promise(r => setTimeout(r, 2000)); await runs.reap();
  assert.equal((await client.inspect(short)).container, null, 'the run container is gone after its deadline');
  passed('process, memory, disk, output and run-time limits stop the run; expired environments are removed', { fork: fork.output.trim().split('\n').at(-2), memory: memory.output.trim(), disk: disk.output.trim(), output_truncated: output.truncated, timed_out: timed.timed_out });
  await envS.release();

  // 10. Through the role protocol: an adapter that declares the contract runs a reviewer inside its own environment; a
  //     built-in driver on the same profile is refused before any environment exists.
  store = new Store(join(work, 'control.sqlite'), randomBytes(32));
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')"); store.run('INSERT INTO repositories VALUES(?,?,?,?)', repo, 'fixture/role-run', 'o', 'a');
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('task-169',?,'task.request','running','review in isolation','{}',1,1,?)", repo, devWs);
  new TaskRecords(store).contract('task-169', { goal: 'review in isolation', scope: ['a.txt'], criteria: ['inspect fixed candidate'], endpoint: 'artifact' });
  const admin = { id: 'admin', role: 'project_admin', repositories: [repo] }, url = new URL(`http://local/api/repositories/${repo}/roles`);
  const put = body => roleApi(store, admin, 'PUT', url, { expected_revision: roleApi(store, admin, 'GET', url, {}).revision, enabled: true, ...body });
  let inspected = null;
  registerRoleHarness({ id: 'docker-contract-169', version: '1', session: 'task_records', events: 'run_events', kinds: ['writer', 'observer', 'evaluator'],
    capabilities: { raw_evidence: 'control_plane_tools', cancel: 'protocol_then_kill', isolation: 'run_environment', version_binding: true, output_validation: true, fresh_context: true, recovery: ['rebuilt_from_task_records'] } },
  spec => async () => {
    const env = spec.runEnvironment, seen = await env.client.call(env.run_id, { type: 'workspace_command', command: 'cat a.txt; cat /workspace/home/dev-secret 2>&1 | head -1', timeout_ms: 20000 });
    inspected = { run_id: env.run_id, output: seen.output };
    return spec.finish.validate({ summary: 'inspected the fixed candidate in its own container', findings: [], inspected_scope: ['a.txt'], unknowns: [] });
  });
  // The adapter brings no model; the project still has one configured, as a role snapshot pins the resolved model.
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', repo, 'http://127.0.0.1:9/v1', 'unused', store.secrets.seal({ value: 'unused-model-key-169' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES(?,'m',1,1)", repo);
  put({ roles: [{ role_id: 'reviewer', harness_ref: { id: 'docker-contract-169' }, environment_profile_ref: { id: 'isolated-candidate' } }] });
  const task = store.get("SELECT * FROM tasks WHERE id='task-169'"), workspace = new Workspace(store, manager, task, new Redactor(), async () => {}, () => {});
  const spaces = roleWorkspaces(workspace), finishTool = { type: 'function', function: { name: 'finish', description: 'finish', parameters: { type: 'object', additionalProperties: true } } };
  const spec = { store, task, redactor: new Redactor(), guard: async () => {}, system: 'Task', prompt: '{}', tools: [finishTool], finish: { name: 'finish', validate: v => v }, maxTurns: 6 };
  const result = await runRole(spec, 'reviewer', undefined, undefined, { prepare: spaces.isolated });
  assert.equal(result.result.summary, 'inspected the fixed candidate in its own container');
  assert.match(inspected.output, /^changed\n/, 'the run saw the developer workspace snapshot taken when it was prepared');
  assert.match(inspected.output, /No such file/);
  const runRow = store.get("SELECT * FROM task_runs WHERE role='reviewer'"), admission = JSON.parse(runRow.admission);
  assert.deepEqual([admission.admitted, admission.provided.run_isolation.ok, admission.provided.fixed_candidate_read.ok], [true, true, true]);
  const envEvent = JSON.parse(store.get("SELECT data FROM task_history WHERE type='role_run_environment'").data);
  assert.equal(envEvent.verified, true);
  assert.equal((await client.inspect(envEvent.environment_id)).state, 'released', 'the environment is released when the run is collected');
  await assert.rejects(runRole(spec, 'reviewer', undefined, 'native', { prepare: spaces.isolated }), e => e.code === 'unsupported_capability');
  assert.equal(store.get("SELECT count(*) n FROM task_history WHERE type='role_run_environment'").n, 1, 'no environment was provisioned for the refused driver');
  passed('RoleRun admission admits a contract adapter only in a verified run container and refuses a built-in driver before provisioning', { run: runRow.id, environment: envEvent.environment_id, inspected: inspected.output });

  // 11. Real-Docker read-only /opt/agent-tools volume (#705): fresh Compose initialization order (manager mounts empty
  //     volume :ro first, then uid 10001:10001 writes .staging and installs tool), mounted read-only in both project
  //     computer and isolated RunEnvironment, executable by uid 10001:10001, EROFS on write, and untrusted volumes rejected.
  const toolsVolName = `${deployment}_agent-tools`;
  const untrustedVolName = `${deployment}_assistant-homes`;
  const toolsSeedRoot = join(work, 'tools-seed');
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const sha256File = p => createHash('sha256').update(cpBuffer(p)).digest('hex');
  function cpBuffer(p) { return execFileSync('cat', [p]); }

  // Seed bundled Node 22.15.0, install Claude Code 2.1.318 through real AgentToolManager.install (with both glibc and musl
  // native packages advertised, proving glibc ELF selection on node:22-bookworm-slim), and seed protocol fixtures 2.1.319 / 0.166.0.
  const buildTarGz = entries => {
    const blocks = [];
    for (const entry of entries) {
      const header = Buffer.alloc(512, 0);
      Buffer.from(entry.name, 'utf8').copy(header, 0);
      const mode = entry.mode ?? 0o644;
      const body = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8');
      header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
      header.write('0000000\0', 108, 8, 'ascii');
      header.write('0000000\0', 116, 8, 'ascii');
      header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
      header.fill(0x20, 148, 156);
      header[156] = '0'.charCodeAt(0);
      header.write('ustar\0', 257, 6, 'ascii');
      header.write('00', 263, 2, 'ascii');
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += header[i];
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      blocks.push(header);
      if (body.length > 0) {
        blocks.push(body);
        const rem = body.length % 512;
        if (rem > 0) blocks.push(Buffer.alloc(512 - rem, 0));
      }
    }
    blocks.push(Buffer.alloc(1024, 0));
    return gzipSync(Buffer.concat(blocks));
  };
  const npmHashes = bytes => ({
    sha1: createHash('sha1').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  });

  const nodeSeedDir = join(toolsSeedRoot, 'node', '22.15.0');
  mkdirSync(join(nodeSeedDir, 'bin'), { recursive: true, mode: 0o755 });
  const nodeBinScript = '#!/bin/sh\nif [ -x /usr/local/bin/node ]; then exec /usr/local/bin/node "$@"; fi\nexec /usr/bin/node "$@"\n';
  writeFileSync(join(nodeSeedDir, 'bin', 'node'), nodeBinScript, { mode: 0o755 });
  writeFileSync(join(nodeSeedDir, 'manifest.json'), JSON.stringify({
    schema: 'bot.agent-tools-node/1',
    version: '22.15.0',
    arch: hostArch,
    installed_at: new Date().toISOString(),
    container_executable: '/opt/agent-tools/node/22.15.0/bin/node',
    source_url: 'https://nodejs.org/dist/v22.15.0/node-v22.15.0.tar.gz',
    sha256: sha256File(join(nodeSeedDir, 'bin', 'node')),
    bytes: Buffer.byteLength(nodeBinScript),
  }, null, 2));

  // Build real dynamically-linked glibc vs musl ELF binaries inside the project container image, then install 2.1.318 via AgentToolManager.
  const elfDir = join(work, 'elf-build');
  mkdirSync(elfDir, { recursive: true });
  writeFileSync(join(elfDir, 'claude.c'), '#include <stdio.h>\nint main(void) { puts("2.1.318 (Claude Code) glibc-elf"); return 0; }\n');
  const muslLd = hostArch === 'arm64' ? '/lib/ld-musl-aarch64.so.1' : '/lib/ld-musl-x86_64.so.1';
  const [glibcB64, muslB64] = sh('docker', [
    'run', '--rm', '--label', 'department.bot.deployment=' + deployment,
    '-v', `${elfDir}:/elf:ro`, image,
    'sh', '-ec', `gcc -O2 /elf/claude.c -o /tmp/claude-glibc && gcc -O2 -Wl,--dynamic-linker=${muslLd} /elf/claude.c -o /tmp/claude-musl && base64 -w0 /tmp/claude-glibc && echo && base64 -w0 /tmp/claude-musl`,
  ]).trim().split('\n');
  const pkg218 = buildTarGz([
    { name: 'package/package.json', content: JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.318' }) },
    { name: 'package/cli-wrapper.cjs', mode: 0o755, content: 'process.exit(99);\n' },
  ]);
  const glibcTar218 = buildTarGz([{ name: 'package/claude', mode: 0o755, content: Buffer.from(glibcB64, 'base64') }]);
  const muslTar218 = buildTarGz([{ name: 'package/claude', mode: 0o755, content: Buffer.from(muslB64, 'base64') }]);
  const pkg218H = npmHashes(pkg218), glibc218H = npmHashes(glibcTar218), musl218H = npmHashes(muslTar218);
  const toolUpstream = createServer((req, res) => {
    const origin = `http://127.0.0.1:${toolUpstream.address().port}`;
    const u = new URL(req.url, origin);
    if (u.pathname === '/npm/@anthropic-ai%2fclaude-code/2.1.318') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: '@anthropic-ai/claude-code',
        version: '2.1.318',
        optionalDependencies: {
          [`@anthropic-ai/claude-code-linux-${hostArch}`]: '2.1.318',
          [`@anthropic-ai/claude-code-linux-${hostArch}-musl`]: '2.1.318',
        },
        dist: { tarball: `${origin}/npm/@anthropic-ai/claude-code/-/claude-code-2.1.318.tgz`, ...pkg218H },
      }));
      return;
    }
    if (u.pathname === `/npm/@anthropic-ai%2fclaude-code-linux-${hostArch}/2.1.318`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: `@anthropic-ai/claude-code-linux-${hostArch}`,
        version: '2.1.318',
        dist: { tarball: `${origin}/npm/@anthropic-ai/claude-code-linux-${hostArch}/-/claude-code-linux-${hostArch}-2.1.318.tgz`, ...glibc218H },
      }));
      return;
    }
    if (u.pathname === `/npm/@anthropic-ai%2fclaude-code-linux-${hostArch}-musl/2.1.318`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: `@anthropic-ai/claude-code-linux-${hostArch}-musl`,
        version: '2.1.318',
        dist: { tarball: `${origin}/npm/@anthropic-ai/claude-code-linux-${hostArch}-musl/-/claude-code-linux-${hostArch}-musl-2.1.318.tgz`, ...musl218H },
      }));
      return;
    }
    if (u.pathname === '/npm/@anthropic-ai/claude-code/-/claude-code-2.1.318.tgz') { res.writeHead(200); res.end(pkg218); return; }
    if (u.pathname === `/npm/@anthropic-ai/claude-code-linux-${hostArch}/-/claude-code-linux-${hostArch}-2.1.318.tgz`) { res.writeHead(200); res.end(glibcTar218); return; }
    if (u.pathname === `/npm/@anthropic-ai/claude-code-linux-${hostArch}-musl/-/claude-code-linux-${hostArch}-musl-2.1.318.tgz`) { res.writeHead(200); res.end(muslTar218); return; }
    res.writeHead(404); res.end('{}');
  });
  toolUpstream.listen(0, '127.0.0.1');
  await once(toolUpstream, 'listening');
  try {
    const toolOrigin = `http://127.0.0.1:${toolUpstream.address().port}`;
    const realInstaller = new AgentToolManager({
      volumeRoot: toolsSeedRoot,
      containerRoot: '/opt/agent-tools',
      arch: hostArch,
      sources: { npmRegistryBase: `${toolOrigin}/npm`, allowLoopbackHttp: true },
    });
    await realInstaller.install({ cli: 'claude_code', version: '2.1.318' });
    rmSync(join(toolsSeedRoot, '.staging'), { recursive: true, force: true });
  } finally {
    await new Promise(r => toolUpstream.close(r));
  }

  const claudeSeedDir = join(toolsSeedRoot, 'claude_code', '2.1.319');
  mkdirSync(join(claudeSeedDir, 'bin'), { recursive: true, mode: 0o755 });
  mkdirSync(join(claudeSeedDir, 'lib'), { recursive: true, mode: 0o755 });
  cpSync(resolve('test/fixtures/claude-code.mjs'), join(claudeSeedDir, 'lib', 'claude-code.mjs'));
  const claudeWrapper = '#!/bin/sh\nexec /opt/agent-tools/node/22.15.0/bin/node /opt/agent-tools/claude_code/2.1.319/lib/claude-code.mjs "$@"\n';
  writeFileSync(join(claudeSeedDir, 'bin', 'claude'), claudeWrapper, { mode: 0o755 });
  writeFileSync(join(claudeSeedDir, 'manifest.json'), JSON.stringify({
    schema: 'bot.agent-tools/1',
    cli: 'claude_code',
    version: '2.1.319',
    arch: hostArch,
    installed_at: new Date().toISOString(),
    container_executable: '/opt/agent-tools/claude_code/2.1.319/bin/claude',
    container_node_executable: '/opt/agent-tools/node/22.15.0/bin/node',
    node_version: '22.15.0',
    artifacts: [{
      role: 'package',
      source_url: 'https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.319.tgz',
      sha256: sha256File(join(claudeSeedDir, 'bin', 'claude')),
      bytes: Buffer.byteLength(claudeWrapper),
    }],
  }, null, 2));

  const codexSeedDir = join(toolsSeedRoot, 'codex', '0.166.0');
  mkdirSync(join(codexSeedDir, 'bin'), { recursive: true, mode: 0o755 });
  mkdirSync(join(codexSeedDir, 'lib'), { recursive: true, mode: 0o755 });
  cpSync(resolve('test/fixtures/codex-app-server.mjs'), join(codexSeedDir, 'lib', 'codex-app-server.mjs'));
  const codexWrapper = '#!/bin/sh\nexec /opt/agent-tools/node/22.15.0/bin/node /opt/agent-tools/codex/0.166.0/lib/codex-app-server.mjs "$@"\n';
  writeFileSync(join(codexSeedDir, 'bin', 'codex'), codexWrapper, { mode: 0o755 });
  writeFileSync(join(codexSeedDir, 'manifest.json'), JSON.stringify({
    schema: 'bot.agent-tools/1',
    cli: 'codex',
    version: '0.166.0',
    arch: hostArch,
    installed_at: new Date().toISOString(),
    container_executable: '/opt/agent-tools/codex/0.166.0/bin/codex',
    container_node_executable: null,
    node_version: null,
    artifacts: [{
      role: 'static_binary',
      source_url: 'https://github.com/openai/codex/releases/download/rust-v0.166.0/codex.tar.gz',
      sha256: sha256File(join(codexSeedDir, 'bin', 'codex')),
      bytes: Buffer.byteLength(codexWrapper),
    }],
  }, null, 2));

  sh('docker', ['volume', 'create', '--label', 'department.bot.deployment=' + deployment, '--label', 'com.docker.compose.volume=agent-tools', '--label', 'department.bot.kind=agent-tools', toolsVolName]);
  sh('docker', ['volume', 'create', '--label', 'department.bot.deployment=' + deployment, '--label', 'com.docker.compose.volume=assistant-homes', untrustedVolName]);
  // Fresh-deploy Compose order: manager starts before bot and mounts the empty named volume :ro first.
  const seededOwner = sh('docker', ['run', '--rm', '--read-only', '--label', 'department.bot.deployment=' + deployment, '-v', `${toolsVolName}:/opt/agent-tools:ro`, managerImage, 'node', '-e', 'const st = require("node:fs").statSync("/opt/agent-tools"); console.log(st.uid + ":" + st.gid);']).trim();
  assert.equal(seededOwner, '10001:10001', 'manager image seeds empty agent-tools volume as 10001:10001');
  sh('docker', ['run', '--rm', '--read-only', '--label', 'department.bot.deployment=' + deployment, '-u', '10001:10001', '-v', `${toolsVolName}:/opt/agent-tools`, '-v', `${toolsSeedRoot}:/seed:ro`, image, 'sh', '-ec', 'mkdir /opt/agent-tools/.staging && rmdir /opt/agent-tools/.staging && cp -r /seed/. /opt/agent-tools/']);

  activeToolsVolume = toolsVolName;
  await manager.call('POST', `/v1/projects/${repo}/start`, { operation_id: id(), generation: 1 }, 300000);
  const projTools = await sh1('/opt/agent-tools/claude_code/2.1.318/bin/claude --version && /opt/agent-tools/codex/0.166.0/bin/codex --version && (touch /opt/agent-tools/write-probe 2>&1 || echo RO_ENFORCED)');
  assert.match(projTools.output, /2\.1\.318 \(Claude Code\) glibc-elf/);
  assert.match(projTools.output, /codex-cli 0\.166\.0 uid=10001:10001/);
  assert.match(projTools.output, /Read-only file system[\s\S]*RO_ENFORCED/);

  const runToolsId = id();
  const envTools = await provisionRunEnvironment(client, { run_id: runToolsId, task_id: 'task-169', lease_epoch: 10, profile: 'observer' });
  assert.equal(envTools.facts.verified, true);
  assert.deepEqual(envTools.facts.detail.violations, []);
  const isoTools = await client.call(runToolsId, { type: 'command', command: '/opt/agent-tools/claude_code/2.1.318/bin/claude --version && /opt/agent-tools/codex/0.166.0/bin/codex --version && (touch /opt/agent-tools/write-probe 2>&1 || echo RO_ENFORCED)', timeout_ms: 20000 });
  assert.match(isoTools.output, /2\.1\.318 \(Claude Code\) glibc-elf/);
  assert.match(isoTools.output, /codex-cli 0\.166\.0 uid=10001:10001/);
  assert.match(isoTools.output, /Read-only file system[\s\S]*RO_ENFORCED/);
  await envTools.release();

  let realClaudeBin = null;
  try { realClaudeBin = claudeBinary(); } catch {}
  if (realClaudeBin && existsSync(realClaudeBin)) {
    const realVerOut = sh('docker', [
      'run', '--rm', '--read-only', '--network', 'none',
      '--label', 'department.bot.deployment=' + deployment,
      '-v', `${realClaudeBin}:/opt/real-claude:ro`,
      image, '/opt/real-claude', '--version',
    ]).trim();
    assert.match(realVerOut, /^2\.1\.319 \(Claude Code\)/, 'real glibc Claude Code binary executes inside node:22-bookworm-slim --network none container');
  }

  activeToolsVolume = untrustedVolName;
  await assert.rejects(() => provisionRunEnvironment(client, { run_id: id(), task_id: 'task-169', lease_epoch: 11, profile: 'observer' }), /agent_tools_volume_invalid|manager_error|503/);
  activeToolsVolume = toolsVolName;
  passed('read-only /opt/agent-tools volume is executable by 10001:10001 and EROFS in both project and run containers; untrusted volumes refused');

  // 12. Real-Docker container-native execution of Claude Code and Codex (#705):
  //     - Backend availability API discovers /opt/agent-tools manifests (pi, claude_code, codex; acp/opencode retired)
  //     - Claude Code in isolated-workspace (--network none): native file/shell in <task_dir>/repo, loopback model relay
  //       over file mailbox, stdio MCP bot, git-credential-bot short-lived read-only token + redaction, commit handoff
  //     - Codex app-server in isolated-candidate (--network none): native workspace + loopback relay + stdio MCP bot
  //     - Claude Code on shared project computer: persistent CLI state (native_resume) + process-group reap on cancel
  process.env.BOT_AGENT_TOOLS_DIR = toolsSeedRoot;
  delete process.env.BOT_CLAUDE_CODE_CONFIG;
  delete process.env.BOT_CODEX_CONFIG;

  const llmRequests = [];
  const UPSTREAM_ANTHROPIC_KEY = 'sk-ant-upstream-docker-secret-705';
  const UPSTREAM_OPENAI_KEY = 'sk-oai-upstream-docker-secret-705';
  llmServer = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    llmRequests.push({
      url: req.url,
      xApiKey: req.headers['x-api-key'] ?? null,
      auth: req.headers.authorization ?? null,
      body: body ? JSON.parse(body) : null,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/messages') {
      res.writeHead(200);
      res.end(JSON.stringify({
        id: 'msg_docker_705',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'docker relay ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 18, output_tokens: 9 },
      }));
      return;
    }
    if (req.url === '/v1/responses') {
      res.writeHead(200);
      res.end(JSON.stringify({
        id: 'resp_docker_705',
        object: 'response',
        model: 'gpt-5-codex',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'docker codex relay ok' }] }],
        usage: { input_tokens: 24, output_tokens: 10, total_tokens: 34 },
      }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  llmServer.listen(0, '127.0.0.1');
  await once(llmServer, 'listening');

  const { privateKey: ghKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ghPem = ghKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const GH_RO_SECRET = 'ghs_docker_readonly_secret_705';
  ghMockServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/app') {
      res.writeHead(200); res.end(JSON.stringify({ slug: 'docker-fixture-bot' })); return;
    }
    if (req.method === 'GET' && req.url === '/repos/fixture/role-run/installation') {
      res.writeHead(200);
      res.end(JSON.stringify({
        id: 1,
        account: { id: 'o', login: 'fixture' },
        events: ['issues', 'pull_request'],
        permissions: { contents: 'read', metadata: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' },
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/app/installations/1/access_tokens') {
      const parsed = raw ? JSON.parse(raw) : {};
      res.writeHead(201);
      res.end(JSON.stringify({
        token: GH_RO_SECRET,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        permissions: parsed.permissions ?? { contents: 'read', metadata: 'read' },
      }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/installation/token') {
      res.writeHead(204); res.end(); return;
    }
    if (req.method === 'GET' && req.url === '/users/docker-fixture-bot%5Bbot%5D') {
      res.writeHead(200); res.end(JSON.stringify({ id: 99, login: 'docker-fixture-bot[bot]' })); return;
    }
    if (req.method === 'GET' && req.url === '/repositories/' + repo) {
      res.writeHead(200); res.end(JSON.stringify({ id: repo, full_name: 'fixture/role-run', default_branch: 'main', owner: { id: 'o' } })); return;
    }
    res.writeHead(404); res.end('{}');
  });
  ghMockServer.listen(0, '127.0.0.1');
  await once(ghMockServer, 'listening');

  store.run("UPDATE accounts SET credentials=? WHERE id='a'", store.secrets.seal({ private_key: ghPem }, 'account:a'));
  const llmBase = `http://127.0.0.1:${llmServer.address().port}/v1`;
  store.run(
    "INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m-claude',?,?, 'claude-sonnet-4-5-20250929',?,'2026-01-02T00:00:00Z')",
    repo, llmBase, store.secrets.seal({ value: UPSTREAM_ANTHROPIC_KEY }, 'model:m-claude'),
  );
  saveModelMetadata(store, 'm-claude', { interface_type: 'anthropic-messages' });
  store.run(
    "INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m-codex',?,?, 'gpt-5-codex',?,'2026-01-03T00:00:00Z')",
    repo, llmBase, store.secrets.seal({ value: UPSTREAM_OPENAI_KEY }, 'model:m-codex'),
  );
  saveModelMetadata(store, 'm-codex', { interface_type: 'openai-responses' });
  store.run("UPDATE policies SET model_id='m-claude' WHERE repository_id=?", repo);
  // Clear cached task_execution_configs so task-169 resolves the live configured models.
  store.run("DELETE FROM task_execution_configs WHERE task_id='task-169'");

  const rolesView = roleApi(store, admin, 'GET', url, {});
  assert.equal(rolesView.backends.some(b => b.id === 'acp' || b.id === 'opencode'), false);
  const claudeBackendView = rolesView.backends.find(b => b.id === 'claude_code');
  const codexBackendView = rolesView.backends.find(b => b.id === 'codex');
  assert.equal(claudeBackendView.runtime_status.ready, true);
  assert.equal(claudeBackendView.runtime_status.selected_version, '2.1.319');
  assert.equal(codexBackendView.runtime_status.ready, true);
  assert.equal(codexBackendView.runtime_status.selected_version, '0.166.0');

  const readRecordTool = {
    type: 'function',
    function: {
      name: 'read_task_record',
      description: 'Read durable task record',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    },
  };
  const prepareHybrid = async (inst, res) => (await spaces.isolated(inst, res)) ?? (await spaces.worker(inst, res));
  const ghApiUrl = `http://127.0.0.1:${ghMockServer.address().port}`;

  // 12a. Claude Code as writer in isolated-workspace (--network none):
  const currentDevPerms = rolesView.configuration.roles.find(r => r.role_id === 'dev').permissions;
  put({
    roles: [
      {
        role_id: 'dev',
        harness_ref: { id: 'claude_code' },
        model_profile_ref: { model_id: 'm-claude', api: 'anthropic-messages' },
        environment_profile_ref: { id: 'isolated-workspace' },
        permissions: { ...currentDevPerms, github: 'read' },
      },
      {
        role_id: 'reviewer',
        harness_ref: { id: 'codex' },
        model_profile_ref: { model_id: 'm-codex', api: 'openai-responses' },
        environment_profile_ref: { id: 'isolated-candidate' },
      },
    ],
  });

  const claudeIsoSpec = {
    ...spec,
    prompt: JSON.stringify({ fixture_mode: 'native_workspace', fixture_test_git_cred: true, fixture_test_login_gh: true }),
    tools: [readRecordTool, finishTool],
    containerOptions: { githubApiUrl: ghApiUrl },
  };
  const claudeIsoOut = await runRole(claudeIsoSpec, 'dev', 'iso-claude-dev', undefined, { prepare: prepareHybrid });
  assert.equal(claudeIsoOut.result.summary, 'native container tools verified');
  assert.equal(claudeIsoOut.result.shellOut, 'written natively by claude_code');
  assert.equal(claudeIsoOut.result.gitCredMatched, true, 'git credential helper obtained short-lived read-only token over file mailbox inside --network none');
  assert.match(claudeIsoOut.result.loginGhPath, /^\/workspace\/tasks\/[a-f0-9]{48}\/agent\/bin\/gh$/, 'login shell bash -lc preserves gh wrapper ahead of /usr/bin/gh after /etc/profile');
  assert.match(claudeIsoOut.result.loginGhVersion, /^gh version /, 'gh wrapper authenticates over file mailbox and invokes /usr/bin/gh inside --network none');
  assert.match(claudeIsoOut.result.cwd, /^\/workspace\/tasks\/[a-f0-9]{48}\/repo$/);

  const claudeIsoRun = store.get("SELECT * FROM task_runs WHERE role='dev' ORDER BY rowid DESC LIMIT 1");
  assert.equal(claudeIsoRun.cli_version, '2.1.319');
  assert.equal(store.get("SELECT count(*) n FROM task_history WHERE run_id=? AND type='role_record_read'", claudeIsoRun.id).n, 1);
  assert.equal(JSON.parse(claudeIsoRun.admission).provided.run_isolation.ok, true);
  // Upstream secret stayed in control plane; short-lived GitHub read token was redacted from stdout/history.
  assert.ok(llmRequests.some(r => r.url === '/v1/messages' && r.xApiKey === UPSTREAM_ANTHROPIC_KEY));
  const fullHistoryDump = JSON.stringify(store.all('SELECT data FROM task_history'));
  assert.ok(!fullHistoryDump.includes(GH_RO_SECRET), 'short-lived GitHub read token is masked before reaching history');
  assert.ok(!fullHistoryDump.includes(UPSTREAM_ANTHROPIC_KEY), 'upstream Anthropic API key never leaves control plane');
  // Quiet per-command logging: native Bash did NOT emit tool_started/role_run_events; only platform MCP tools did.
  const claudeToolCalls = store.all("SELECT data FROM task_history WHERE run_id=? AND type='tool_started' ORDER BY id", claudeIsoRun.id)
    .map(r => JSON.parse(r.data).name);
  assert.deepEqual(claudeToolCalls, ['read_task_record', 'finish']);
  const claudeRunEventTools = roleRuns.events(store, claudeIsoRun.id, 0, 200).events
    .filter(e => e.type === 'tool_call')
    .map(e => e.data?.name);
  assert.equal(claudeRunEventTools.includes('Bash'), false, 'native Bash tool_use is not logged per-command in role_run_events');
  assert.equal(store.get('SELECT count(*) n FROM model_requests WHERE run_id=?', claudeIsoRun.id).n, 1);
  // Candidate produced inside isolated-workspace was copied back to the task workspace before release.
  assert.equal((await computer({ type: 'workspace_read', workspace_id: devWs, path: 'native-claude.txt' })).content, 'written natively by claude_code\n');

  // 12b. Codex app-server as observer in isolated-candidate (--network none):
  const codexIsoSpec = {
    ...spec,
    prompt: JSON.stringify({ fixture_mode: 'native_workspace', fixture_observer: true }),
    tools: [readRecordTool, finishTool],
  };
  const codexIsoOut = await runRole(codexIsoSpec, 'reviewer', 'iso-codex-rev', undefined, { prepare: prepareHybrid });
  assert.equal(codexIsoOut.result.summary, 'codex native container verified');
  assert.equal(codexIsoOut.result.shellOut, 'written natively by codex');
  assert.match(codexIsoOut.result.loginGhPath, /^\/workspace\/tasks\/[a-f0-9]{48}\/agent\/bin\/gh$/, 'Codex login shell bash -lc preserves gh wrapper ahead of /usr/bin/gh');
  assert.equal(codexIsoOut.result.relayStatus, 200);
  assert.match(codexIsoOut.result.cwd, /^\/workspace\/tasks\/[a-f0-9]{48}\/repo$/);

  const codexIsoRun = store.get("SELECT * FROM task_runs WHERE role='reviewer' ORDER BY rowid DESC LIMIT 1");
  assert.equal(codexIsoRun.cli_version, '0.166.0');
  assert.equal(JSON.parse(codexIsoRun.admission).provided.run_isolation.ok, true);
  assert.ok(llmRequests.some(r => r.url === '/v1/responses' && r.auth === `Bearer ${UPSTREAM_OPENAI_KEY}`));
  const codexToolCalls = store.all("SELECT data FROM task_history WHERE run_id=? AND type='tool_started' ORDER BY id", codexIsoRun.id)
    .map(r => JSON.parse(r.data).name);
  assert.deepEqual(codexToolCalls, ['read_task_record', 'finish']);
  assert.equal(store.get('SELECT count(*) n FROM model_requests WHERE run_id=?', codexIsoRun.id).n, 1);

  // 12c. Shared project computer: Claude Code CLI state persistence (native_resume) + process-group reap on cancel (#632).
  // Use a fresh task id so the persistent dev role_instance starts clean on task-workspace.
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('task-705-proj',?,'task.request','running','project container cli','{}',1,1,?)", repo, devWs);
  new TaskRecords(store).contract('task-705-proj', { goal: 'verify shared computer cli persistence', scope: ['a.txt'], criteria: ['native resume and cancel reap'], endpoint: 'artifact' });
  put({
    roles: [{
      role_id: 'dev',
      harness_ref: { id: 'claude_code' },
      model_profile_ref: { model_id: 'm-claude', api: 'anthropic-messages' },
      environment_profile_ref: { id: 'task-workspace' },
    }],
  });
  const projTask = store.get("SELECT * FROM tasks WHERE id='task-705-proj'");
  const projWorkspace = new Workspace(store, manager, projTask, new Redactor(), async () => {}, () => {});
  const projSpaces = roleWorkspaces(projWorkspace);
  const projSpec = {
    store,
    task: projTask,
    redactor: new Redactor(),
    guard: async () => {},
    system: 'Task',
    prompt: '{}',
    tools: [readRecordTool, finishTool],
    finish: { name: 'finish', validate: v => v },
    maxTurns: 6,
  };
  await runRole(projSpec, 'dev', 'proj-assign-1', undefined, { prepare: projSpaces.worker });
  const projRun1 = store.get("SELECT * FROM task_runs WHERE task_id='task-705-proj' ORDER BY rowid ASC LIMIT 1");
  assert.equal(projRun1.protocol_recovery, null);

  await runRole(projSpec, 'dev', 'proj-assign-1', undefined, { prepare: projSpaces.worker });
  const projRun2 = store.get("SELECT * FROM task_runs WHERE task_id='task-705-proj' ORDER BY rowid DESC LIMIT 1");
  assert.equal(projRun2.protocol_recovery, 'native_resume', 'second run on project computer resumed persisted CLI transcript');

  // Start a hanging run that spawns a background grandchild inside the project container, then cancel and verify process-group reap.
  // Inspect /proc and child.pid directly via `docker exec` so we do not trigger manager/projects.mjs's unscoped-command reap.
  const projContainer = projects.names(repo, 1).container;
  const waitSpec = { ...projSpec, prompt: JSON.stringify({ fixture_mode: 'wait' }) };
  const preparedWait = await roleRuns.prepare(waitSpec, 'dev', 'proj-assign-cancel', undefined, { prepare: projSpaces.worker });
  const waitStateWs = persistentCliStateWorkspaceId(preparedWait.instance.id);
  const waitHandle = await roleRuns.start(preparedWait);
  let grandchildPid = '';
  for (let i = 0; i < 60; i++) {
    if (waitHandle.settled) await roleRuns.collect(waitHandle);
    grandchildPid = sh('docker', ['exec', projContainer, '/bin/sh', '-c', `cat /workspace/tasks/${waitStateWs}/cli-state/*/home/child.pid 2>/dev/null || true`]).trim();
    if (/^\d+$/.test(grandchildPid)) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.match(grandchildPid, /^\d+$/, 'background grandchild started inside project container');
  const aliveBeforeCancel = sh('docker', ['exec', projContainer, '/bin/sh', '-c', `kill -0 ${grandchildPid} 2>/dev/null && echo ALIVE || echo REAPED`]).trim();
  assert.equal(aliveBeforeCancel, 'ALIVE', 'grandchild is alive before cancel');
  const cancelReceipt = await roleRuns.cancel(waitHandle, 'docker_cancel_reap_test', 5000);
  assert.equal(cancelReceipt.tokens_revoked > 0, true);
  await assert.rejects(roleRuns.collect(waitHandle));
  await new Promise(r => setTimeout(r, 300));
  const psProbe = sh('docker', ['exec', projContainer, '/bin/sh', '-c', `kill -0 ${grandchildPid} 2>/dev/null && echo ALIVE || echo REAPED`]).trim();
  assert.equal(psProbe, 'REAPED', 'entire detached process group (including grandchild) was reaped on cancel');
  activeToolsVolume = null;
  passed('Claude Code and Codex run container-natively in both --network none RunEnvironments and shared project containers (#705)', {
    claude_iso_run: claudeIsoRun.id,
    codex_iso_run: codexIsoRun.id,
    resumed_run: projRun2.id,
    reaped_grandchild_pid: Number(grandchildPid),
  });

  // 13. Release and manager restart remove containers; nothing of another run remains.
  for (const env of [env1, env2, envW, env3]) await env.release();
  const leftover = id(); await provisionRunEnvironment(client, { run_id: leftover, task_id: 'task-169', lease_epoch: 9, profile: 'observer' });
  await new Promise(r => server.close(r)); server = null;
  const restarted = new RunEnvironments(projects), again = createManagerServer({ projects, token, runs: restarted }); server = again.server;
  server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); await again.recovered;
  assert.equal(sh('docker', ['ps', '-a', '--filter', 'label=department.bot.kind=run', '--filter', 'label=department.bot.deployment=' + deployment, '--format', '{{.Names}}']).trim(), '');
  passed('released environments and those left before a manager restart are removed');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = String(error?.stack || error); console.error(error); process.exitCode = 1;
} finally {
  evidence.finished_at = new Date().toISOString();
  writeFileSync(join(root, 'evidence-' + tag + '.json'), JSON.stringify(evidence, null, 2));
  if (prevToolsDir === undefined) delete process.env.BOT_AGENT_TOOLS_DIR; else process.env.BOT_AGENT_TOOLS_DIR = prevToolsDir;
  if (prevClaudeCfg === undefined) delete process.env.BOT_CLAUDE_CODE_CONFIG; else process.env.BOT_CLAUDE_CODE_CONFIG = prevClaudeCfg;
  if (prevCodexCfg === undefined) delete process.env.BOT_CODEX_CONFIG; else process.env.BOT_CODEX_CONFIG = prevCodexCfg;
  try { store?.close(); } catch {}
  if (llmServer) await new Promise(r => llmServer.close(r));
  if (ghMockServer) await new Promise(r => ghMockServer.close(r));
  if (server) await new Promise(r => server.close(r));
  // Remove only what this deployment id labelled, then its image.
  const own = kind => sh('docker', [kind, 'ls', '-q', ...(kind === 'container' ? ['-a'] : []), '--filter', 'label=department.bot.deployment=' + deployment]).split('\n').filter(Boolean);
  for (const c of own('container')) sh('docker', ['rm', '-f', c]);
  for (const n of own('network')) sh('docker', ['network', 'rm', n]);
  for (const v of own('volume')) sh('docker', ['volume', 'rm', '-f', v]);
  try { projects?.db.close(); } catch {}
  try { sh('docker', ['image', 'rm', '-f', image]); } catch {}
  try { sh('docker', ['image', 'rm', '-f', managerImage]); } catch {}
  rmSync(work, { recursive: true, force: true });
  console.log(`${evidence.result?.toUpperCase()} ${evidence.checks.length} checks; evidence in .tmp/role-run-docker/evidence-${tag}.json`);
}
