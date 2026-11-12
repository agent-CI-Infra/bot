// Real-Docker acceptance of assistant computers (#457). It builds a test image from an existing project-computer image with
// this checkout's runner on top, runs this checkout's manager code in-process under a deployment id of its own, and removes
// every container, volume and image it created (all labelled with that deployment). Nothing of another Compose project is
// touched. It checks isolation between owners, the lease lifecycle, HOME persistence and modes, limits and leftovers, and
// prints the timings asked for in the issue (cold start, per-command cost when reused, concurrent starts, memory).
//   BOT_TEST_BASE_IMAGE=department-bot-project-computer:<tag> npm run test:assistant:docker
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Docker } from '../manager/docker.mjs';
import { AssistantComputers } from '../manager/assistant-computers.mjs';

const tag = randomBytes(4).toString('hex'), root = resolve('.tmp/assistant-computers-docker'), work = join(root, tag);
const deployment = 'ac457' + tag, image = `dbot-assistant-457-${tag}:test`, volume = `dbot-${deployment}-assistant-homes`;
const base = process.env.BOT_TEST_BASE_IMAGE || 'department-bot-project-computer:local';
mkdirSync(work, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
const evidence = { tag, deployment, base_image: base, image, checks: [], timings: {}, started_at: new Date().toISOString() };
const passed = (name, detail = null) => { evidence.checks.push({ name, detail }); console.log('PASS ' + name); };
const hex = n => randomBytes(n).toString('hex');
// The manager runs on the host here: the volume name is known, and the generation directories are made by a helper
// container as the computers' user, the way the control plane makes them in its own container.
class HostDocker extends Docker { async volumeName() { return volume; } }
const docker = new HostDocker(), db = new DatabaseSync(':memory:');
let computers = new AssistantComputers({ docker, db, deployment, image, homes: null });
const fence = 'a'.repeat(64), other = 'b'.repeat(64);
// As the control plane would: create (or list) directories in the HOME volume as uid 10001.
const homes = script => sh('docker', ['run', '--rm', '--network', 'none', '--user', '10001:10001', '--label', 'department.bot.deployment=' + deployment,
  '-v', volume + ':/assistant-homes', '--entrypoint', 'sh', image, '-c', script]).trim();
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; };
const timed = async fn => { const start = performance.now(); const value = await fn(); return [performance.now() - start, value]; };
try {
  // 1. Test image: the base project-computer image with this checkout's runner, and the HOME root owned by 10001 so the
  //    first mount of the empty volume takes its ownership (as the control-plane image does for /assistant-homes).
  const context = join(work, 'context'); mkdirSync(join(context, 'runner'), { recursive: true });
  for (const name of readdirSync('runner')) if (name.endsWith('.mjs')) cpSync(join('runner', name), join(context, 'runner', name));
  writeFileSync(join(context, 'Dockerfile'), `FROM ${base}\nUSER root\nCOPY runner/ /opt/runner/\nRUN for f in /opt/runner/*.mjs; do node --check "$f"; done && chmod -R a-w /opt/runner \\\n && mkdir /assistant-homes && chown 10001:10001 /assistant-homes && chmod 750 /assistant-homes\nUSER 10001:10001\n`);
  sh('docker', ['build', '-q', '-t', image, '--label', 'department.bot.deployment=' + deployment, context]);
  sh('docker', ['volume', 'create', '--label', 'department.bot.deployment=' + deployment, volume]);
  passed('test image and HOME volume created from ' + base);
  const [A, B] = [hex(16), hex(16)];
  homes(`set -e; for o in ${A} ${B}; do mkdir -p -m 750 /assistant-homes/$o; mkdir -m 700 /assistant-homes/$o/home-1; done; stat -c '%U %a %n' /assistant-homes /assistant-homes/${A}/home-1`);
  const run = async (owner, turn, command, timeout_ms = 30_000) => {
    const r = await computers.execute(owner, { turn, operation_id: hex(24), request: { type: 'command', command, timeout_ms } });
    assert.equal(r.ok, true, JSON.stringify(r)); return r.result;
  };
  const acquire = (owner, turn, extra = {}) => computers.acquire(owner, { turn, fence, home_generation: 1, home_mode: 'rw', ...extra });

  // 2. Two owners side by side: each sees only its own HOME, /tmp, processes and no network.
  assert.equal((await acquire(A, 'ta')).state, 'ready'); assert.equal((await acquire(B, 'tb')).state, 'ready');
  await run(A, 'ta', 'echo a-secret > ~/a-home.txt && echo a-tmp > /tmp/a-tmp.txt && (sleep 600 &) && ln -s /assistant-homes/' + B + '/home-1/b-home.txt ~/link-to-b && ln -s ../../../etc/passwd ~/dots');
  await run(B, 'tb', 'echo b-secret > ~/b-home.txt && echo b-tmp > /tmp/b-tmp.txt && (B_SECRET=b-env sleep 600 &)');
  const view = await run(A, 'ta', `id -u; echo $HOME; ls -A ~; ls -A /tmp; cat ~/link-to-b 2>&1; ls /home; grep -rl b-secret /home /tmp /workspace /opt /etc 2>/dev/null | head -5; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c B_SECRET; ls /sys/class/net; grep ' /home/assistant ' /proc/self/mountinfo | wc -l; node -e "require('net').connect(80,'1.1.1.1').on('error',e=>console.log('net',e.code))"`);
  assert.match(view.output, /^10001\n\/home\/assistant\n/);
  assert.ok(view.output.includes('a-home.txt') && !view.output.includes('b-home.txt') && !view.output.includes('b-tmp.txt'), view.output);
  assert.match(view.output, /No such file or directory/);
  assert.ok(!/b-secret|b-env/.test(view.output), view.output);
  assert.match(view.output, /\n0\nlo\n1\nnet E(NETUNREACH|NOTFOUND|AI_AGAIN|CONNREFUSED)/);
  passed('owners are isolated: HOME, /tmp, symlinks to another HOME, processes, environment and network', view.output.trim().split('\n'));
  const limits = await run(A, 'ta', 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max; df -k /tmp /workspace | tail -2 | awk \'{print $2}\'; touch /x 2>&1; cat /proc/self/status | grep -E "^(CapEff|NoNewPrivs)"');
  assert.match(limits.output, /^2147483648\n0\n512\n100000 100000\n524288\n524288\n.*Read-only file system\nCapEff:\t0000000000000000\nNoNewPrivs:\t1/s);
  passed('limits are in force: 2 GiB memory without swap, 512 pids, 1 CPU, 512 MiB tmpfs, read-only root, no capabilities', limits.output.trim().split('\n'));
  // File operations stay below /workspace and /tmp, never follow a symlink and never reach HOME or the runner journal.
  const file = request => computers.execute(A, { turn: 'ta', operation_id: hex(24), request });
  const data = Buffer.from('chunked\0binary'), part = Math.ceil(data.length / 2);
  assert.equal((await file({ type: 'assistant_write', path: '/tmp/in/data.bin', base64: data.subarray(0, part).toString('base64'), offset: 0 })).ok, true);
  assert.equal((await file({ type: 'assistant_write', path: '/tmp/in/data.bin', base64: data.subarray(part).toString('base64'), offset: part })).result.size, data.length);
  const back = await file({ type: 'assistant_read', path: '/tmp/in/data.bin' });
  assert.deepEqual([Buffer.from(back.result.base64, 'base64'), back.result.size], [data, data.length]);
  await run(A, 'ta', 'ln -s ~/a-home.txt /tmp/to-home && ln -s /tmp work-link && echo w > relative.txt');
  assert.equal(Buffer.from((await file({ type: 'assistant_read', path: 'relative.txt' })).result.base64, 'base64').toString(), 'w\n');
  assert.equal(Buffer.from((await file({ type: 'assistant_read', path: '/home/assistant/a-home.txt' })).result.base64, 'base64').toString(), 'a-secret\n');
  for (const path of ['/tmp/to-home', '/home/assistant/link-to-b', '/home/assistant/dots', '/home/assistant', '/etc/passwd', '../etc/passwd', '.runner-journal/x', '/workspace/.runner-journal', 'work-link/in/data.bin', '/tmp', '/home/node/x'])
    assert.equal((await file({ type: 'assistant_read', path })).ok, false, path);
  assert.equal((await file({ type: 'assistant_delete', path: '/tmp/to-home' })).result.deleted, true);
  assert.equal((await run(A, 'ta', 'cat ~/a-home.txt')).output, 'a-secret\n', 'deleting a symlink leaves its target');
  assert.equal((await file({ type: 'assistant_delete', path: '/tmp/in' })).result.directory, true);
  passed('file operations are confined to HOME, /workspace and /tmp and follow no symlink');

  // 3. The turn ends: its processes end, /tmp stays for the next turn within the idle time.
  await computers.release(A, { turn: 'ta' });
  const name = computers.name(A), idle = sh('docker', ['top', name, '-eo', 'pid,args']);
  assert.ok(!idle.includes('sleep 600'), idle);
  const reused = await acquire(A, 'ta2');
  assert.equal(reused.reused, true);
  // Only this command's own record (and its live output) is in the journal.
  assert.match((await run(A, 'ta2', 'cat /tmp/a-tmp.txt ~/a-home.txt; ls /workspace/.runner-journal | wc -l')).output, /^a-tmp\na-secret\n[12]\n$/);
  passed('release ends the turn\'s processes and clears the journal; the next turn reuses the container and its /tmp');

  // 4. A changed fence: a new container; HOME persists, /tmp does not. Read-only HOME refuses writes.
  await computers.release(A, { turn: 'ta2' });
  await acquire(A, 'ta3', { fence: other, home_mode: 'ro' });
  const ro = await run(A, 'ta3', 'cat ~/a-home.txt; cat /tmp/a-tmp.txt 2>&1; echo x > ~/new.txt 2>&1; echo scratch > /tmp/ok && cat /tmp/ok');
  assert.match(ro.output, /^a-secret\n.*No such file.*\n.*Read-only file system\nscratch\n$/s);
  passed('a changed fence recreates the computer: HOME kept, /tmp empty; a read-only HOME refuses writes', ro.output.trim().split('\n'));
  await computers.release(A, { turn: 'ta3' });
  // 5. A new HOME generation mounts only its new, empty directory.
  homes(`mkdir -m 700 /assistant-homes/${A}/home-2`);
  await acquire(A, 'ta4', { fence: other, home_generation: 2 });
  // /home/node comes from the base image; no other owner or generation is visible.
  assert.equal((await run(A, 'ta4', 'ls -A ~ | wc -l; ls /home')).output, '0\nassistant\nnode\n');
  passed('a new HOME generation starts empty and the sealed one is not mounted');
  await computers.release(A, { turn: 'ta4' });

  // 6. Idle timeout and fence removal take the container away with its processes.
  computers.leases.get(A).used -= 10 * 60_000; await computers.check(); await Promise.all([...computers.removing.values()]);
  assert.equal(sh('docker', ['ps', '-aq', '--filter', 'name=' + name]).trim(), '');
  await computers.remove(B);
  passed('idle and removed computers leave no container');

  // 7. Measurements.
  const owners = Array.from({ length: 10 }, () => hex(16));
  homes(owners.map(o => `mkdir -p -m 750 /assistant-homes/${o} && mkdir -m 700 /assistant-homes/${o}/home-1`).join(' && '));
  const cold = [];
  for (const o of owners.slice(0, 5)) { const [ms] = await timed(() => acquire(o, 't-' + o)); cold.push(ms); }
  const warm = [];
  for (let i = 0; i < 20; i++) { const [ms] = await timed(() => run(owners[0], 't-' + owners[0], 'true')); warm.push(ms); }
  await computers.release(owners[0], { turn: 't-' + owners[0] });
  const stats = JSON.parse(sh('docker', ['stats', '--no-stream', '--format', '{{json .}}', computers.name(owners[0])]));
  for (const o of owners.slice(0, 5)) await computers.remove(o);
  await Promise.all([...computers.removing.values()]);
  const [total, concurrent] = await timed(() => Promise.all(owners.map(async o => { const [ms] = await timed(() => acquire(o, 'c-' + o)); return ms; })));
  const memory = sh('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', ...owners.map(o => computers.name(o))]).trim().split('\n');
  evidence.timings = { cold_start_ms: cold.map(Math.round), reused_command_ms: { p50: Math.round(percentile(warm, 50)), p95: Math.round(percentile(warm, 95)), min: Math.round(Math.min(...warm)), max: Math.round(Math.max(...warm)) },
    concurrent_10: { total_ms: Math.round(total), p50: Math.round(percentile(concurrent, 50)), p95: Math.round(percentile(concurrent, 95)) }, idle_memory: stats.MemUsage, memory_after_concurrent_start: memory };
  console.log(JSON.stringify(evidence.timings, null, 2));
  passed('measured cold start, reused command cost, 10 concurrent starts and memory');

  // 8. A manager restart removes every assistant computer of the deployment.
  computers = new AssistantComputers({ docker, db, deployment, image, homes: null });
  assert.equal(await computers.recover(), 10);
  assert.equal(sh('docker', ['ps', '-aq', '--filter', 'label=department.bot.deployment=' + deployment, '--filter', 'label=department.bot.kind=assistant']).trim(), '');
  passed('a manager restart removes the computers left from before');
  // 9. No fallback: a computer that cannot be created is an error, and nothing runs elsewhere.
  db.prepare("INSERT INTO settings VALUES('assistant_computers',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ runtime: 'missing-runtime' }));
  await assert.rejects(acquire(A, 'tz'), error => /docker_operation_failed|assistant_computer_create_failed/.test(error.message));
  assert.equal(computers.leases.size, 0);
  passed('a failed creation is a clear error and leaves no lease');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = String(error?.stack || error); console.error(error); process.exitCode = 1;
} finally {
  await computers.shutdown().catch(() => {});
  for (const id of sh('docker', ['ps', '-aq', '--filter', 'label=department.bot.deployment=' + deployment]).split('\n').filter(Boolean)) sh('docker', ['rm', '-f', id]);
  try { sh('docker', ['volume', 'rm', '-f', volume]); } catch {}
  try { sh('docker', ['image', 'rm', '-f', image]); } catch {}
  writeFileSync(join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));
  rmSync(join(work, 'context'), { recursive: true, force: true });
  console.log('evidence: ' + join(work, 'evidence.json'));
}
