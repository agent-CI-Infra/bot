// Real-Docker acceptance of per-run environments (#169). It builds a test image from an existing project-computer image
// with this checkout's runner on top, starts this checkout's manager in-process under a deployment id of its own, and
// removes every container, network, volume and image it created. Nothing of another Compose project is touched.
//   npm run test:isolation:docker            (BOT_TEST_BASE_IMAGE overrides the base image)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Docker } from '../manager/docker.mjs';
import { Projects } from '../manager/projects.mjs';
import { RunEnvironments } from '../manager/run-environments.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { ManagerClient } from '../dist/projects/service.js';
import { RunEnvironmentClient, provisionRunEnvironment, copyCommit } from '../dist/projects/run-environment.js';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { Workspace } from '../dist/agent/workspace.js';
import { Redactor } from '../dist/agent/common.js';
import { runRole } from '../dist/roles/run.js';
import { registerRoleHarness } from '../dist/roles/harness.js';
import { roleApi } from '../dist/roles/api.js';
import { roleWorkspaces } from '../dist/roles/workspace.js';

const tag = randomBytes(4).toString('hex'), root = resolve('.tmp/role-run-docker'), work = join(root, tag);
const deployment = 'rr169' + tag, image = `dbot-role-run-169-${tag}:test`, repo = '169' + String(parseInt(tag, 16) % 100000).padStart(5, '0');
const base = process.env.BOT_TEST_BASE_IMAGE || 'department-bot-project-computer:local';
mkdirSync(work, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
const evidence = { tag, deployment, base_image: base, image, repository: repo, checks: [], started_at: new Date().toISOString() };
const passed = (name, detail = null) => { evidence.checks.push({ name, detail }); console.log('PASS ' + name); };
// The manager on the host: notes live in a host directory, so no helper container is needed to resolve them.
class HostDocker extends Docker { async volumeSource(directory) { return directory; } }
const id = () => randomBytes(24).toString('hex');
let projects, runs, server, store;
try {
  // 1. Test image: the base project-computer image with this checkout's runner files.
  const context = join(work, 'context'); mkdirSync(join(context, 'runner'), { recursive: true });
  for (const name of readdirSync('runner')) if (name.endsWith('.mjs')) cpSync(join('runner', name), join(context, 'runner', name));
  writeFileSync(join(context, 'Dockerfile'), `FROM ${base}\nUSER root\nCOPY runner/ /opt/runner/\nRUN for f in /opt/runner/*.mjs; do node --check "$f"; done && chmod -R a-w /opt/runner\nUSER 10001:10001\n`);
  sh('docker', ['build', '-q', '-t', image, '--label', 'department.bot.deployment=' + deployment, context]);
  passed('test image built from ' + base);

  projects = new Projects({ database: join(work, 'manager.sqlite'), docker: new HostDocker(), deployment, image, egress: false });
  runs = new RunEnvironments(projects);
  const token = randomBytes(32), created = createManagerServer({ projects, token, runs }); server = created.server;
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
  const fork = await run1('for i in $(seq 1 400); do sleep 30 & done 2>&1 | tail -1; echo done');
  assert.match(fork.output, /Resource temporarily unavailable|fork|retry/i);
  const memory = await run1('node -e "const a=[];for(;;)a.push(Buffer.alloc(16<<20,1))"; echo exit=$?');
  assert.match(memory.output, /exit=(137|134)/);
  const disk = await run1('dd if=/dev/zero of=/workspace/fill bs=1M count=400 2>&1 | grep -E "No space|copied"; rm -f /workspace/fill');
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

  // 11. Release and manager restart remove containers; nothing of another run remains.
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
  try { store?.close(); } catch {}
  if (server) await new Promise(r => server.close(r));
  // Remove only what this deployment id labelled, then its image.
  const own = kind => sh('docker', [kind, 'ls', '-q', ...(kind === 'container' ? ['-a'] : []), '--filter', 'label=department.bot.deployment=' + deployment]).split('\n').filter(Boolean);
  for (const c of own('container')) sh('docker', ['rm', '-f', c]);
  for (const n of own('network')) sh('docker', ['network', 'rm', n]);
  for (const v of own('volume')) sh('docker', ['volume', 'rm', '-f', v]);
  try { projects?.db.close(); } catch {}
  try { sh('docker', ['image', 'rm', '-f', image]); } catch {}
  rmSync(work, { recursive: true, force: true });
  console.log(`${evidence.result?.toUpperCase()} ${evidence.checks.length} checks; evidence in .tmp/role-run-docker/evidence-${tag}.json`);
}
