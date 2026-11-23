import { computerResultOwner } from '../../../runner/result-owner.mjs';
// Real-Docker acceptance of assistant computers (#457). It builds a test image from an existing project-computer image with
// this checkout's runner on top, runs this checkout's manager code in-process under a deployment id of its own, and removes
// every container, volume and image it created (all labelled with that deployment). Nothing of another Compose project is
// touched. It checks isolation between owners, the lease lifecycle, HOME persistence and modes, limits and leftovers, and
// prints the timings asked for in the issue (cold start, per-command cost when reused, concurrent starts, memory).
//   BOT_TEST_BASE_IMAGE=department-bot-project-computer:<tag> npm run test:assistant:docker
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Docker } from '../../../manager/docker.mjs';
import { AssistantComputers } from '../../../manager/assistant-computers.mjs';

const tag = randomBytes(4).toString('hex'), root = resolve('.tmp/assistant-computers-docker'), work = join(root, tag);
const deployment = 'ac457' + tag, image = `dbot-assistant-457-${tag}:test`, volume = `dbot-${deployment}-assistant-homes`, resultVolume=`dbot-${deployment}-tool-results`;
const base = process.env.BOT_TEST_BASE_IMAGE || 'department-bot-project-computer:local';
mkdirSync(work, { recursive: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
const evidence = { tag, deployment, base_image: base, image, checks: [], timings: {}, started_at: new Date().toISOString() };
const passed = (name, detail = null) => { evidence.checks.push({ name, detail }); console.log('PASS ' + name); };
const hex = n => randomBytes(n).toString('hex');
// The manager runs on the host here: the volume name is known, and the generation directories are made by a helper
// container as the computers' user, the way the control plane makes them in its own container.
class HostDocker extends Docker { async volumeName() { return volume; } }
const docker = new HostDocker(), db = new DatabaseSync(':memory:'), resultOwners=new Set();
let computers = new AssistantComputers({ docker, db, deployment, image, homes: null, resultMount:async owner=>resultOwners.has(owner)?[{Type:'volume',Source:resultVolume,Target:'/results',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:computerResultOwner('assistant',owner)}}]:[] });
const fence = 'a'.repeat(64), other = 'b'.repeat(64);
// As the control plane would: create (or list) directories in the HOME volume as uid 10001.
const homes = script => sh('docker', ['run', '--rm', '--network', 'none', '--user', '10001:10001', '--label', 'department.bot.deployment=' + deployment,
  '-v', volume + ':/assistant-homes', '-v', resultVolume + ':/tool-results', '--entrypoint', 'sh', image, '-c', script]).trim();
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; };
const timed = async fn => { const start = performance.now(); const value = await fn(); return [performance.now() - start, value]; };
try {
  // 1. Test image: the base project-computer image with this checkout's runner, and the HOME root owned by 10001 so the
  //    first mount of the empty volume takes its ownership (as the control-plane image does for /assistant-homes).
  const context = join(work, 'context'); mkdirSync(join(context, 'runner'), { recursive: true });
  for (const name of readdirSync('runner')) if (name.endsWith('.mjs')) cpSync(join('runner', name), join(context, 'runner', name));
  writeFileSync(join(context, 'Dockerfile'), `FROM ${base}\nUSER root\nCOPY runner/ /opt/runner/\nRUN for f in /opt/runner/*.mjs; do node --check "$f"; done && chmod -R a-w /opt/runner \\\n && mkdir /assistant-homes /tool-results && chown 10001:10001 /assistant-homes /tool-results && chmod 750 /assistant-homes && chmod 755 /tool-results\nUSER 10001:10001\n`);
  sh('docker', ['build', '-q', '-t', image, '--label', 'department.bot.deployment=' + deployment, context]);
  sh('docker', ['volume', 'create', '--label', 'department.bot.deployment=' + deployment, volume]);
  sh('docker', ['volume', 'create', '--label', 'department.bot.deployment=' + deployment, resultVolume]);
  passed('test image and HOME volume created from ' + base);
  const [A, B] = [hex(16), hex(16)];resultOwners.add(A);resultOwners.add(B);
  homes(`set -e; for o in ${A} ${B}; do mkdir -p -m 750 /assistant-homes/$o; mkdir -m 700 /assistant-homes/$o/home-1; done; stat -c '%U %a %n' /assistant-homes /assistant-homes/${A}/home-1`);
  homes(`mkdir -p /tool-results/${computerResultOwner('assistant',A)} /tool-results/${computerResultOwner('assistant',B)}; printf '{\"issues\":[452,459],\"tail\":\"中😀\"}' > /tool-results/${computerResultOwner('assistant',A)}/sample.utf8; printf other > /tool-results/${computerResultOwner('assistant',B)}/other.utf8; chmod 444 /tool-results/*/*.utf8`);
  const run = async (owner, turn, command, timeout_ms = 30_000, extra = {}) => {
    const r = await computers.execute(owner, { turn, operation_id: hex(24), request: { type: 'command', command, timeout_ms, ...extra } });
    assert.equal(r.ok, true, JSON.stringify(r)); return r.result;
  };
  const acquire = (owner, turn, extra = {}) => computers.acquire(owner, { turn, fence, home_generation: 1, home_mode: 'rw', ...extra });

  // 2. Two owners side by side: each sees only its own HOME, /tmp and processes; default egress uses an ICC-disabled
  //    bridge network isolated from sibling assistant containers and host loopback ports.
  assert.equal((await acquire(A, 'ta')).state, 'ready'); assert.equal((await acquire(B, 'tb')).state, 'ready');
  const netInfo = JSON.parse(sh('docker', ['network', 'inspect', computers.networkName()]))[0];
  assert.equal(netInfo.Internal, false);
  assert.equal(netInfo.Options?.['com.docker.network.bridge.enable_icc'], 'false');
  const resultView=await run(A,'ta',"cat /results/sample.utf8; test ! -e /results/other.utf8; for action in 'printf changed > /results/sample.utf8' 'rm /results/sample.utf8' 'touch /results/new'; do if sh -c \"$action\"; then exit 90; fi; done; cat /results/sample.utf8");
  assert.equal(resultView.exit_code,0,resultView.output);assert.equal((resultView.output.match(/中😀/g)||[]).length,2);
  const hidden=await run(B,'tb','test ! -e /results/sample.utf8 && cat /results/other.utf8');assert.equal(hidden.exit_code,0);assert.match(hidden.output,/other/);
  homes(`rm /tool-results/${computerResultOwner('assistant',A)}/sample.utf8`);
  assert.equal((await run(A,'ta','test ! -e /results/sample.utf8')).exit_code,0);
  passed('results are UTF-8 readable, owner-isolated, read-only and disappear when the control plane expires them');
  await run(A, 'ta', 'echo a-secret > ~/a-home.txt && echo a-tmp > /tmp/a-tmp.txt && (sleep 600 &) && ln -s /assistant-homes/' + B + '/home-1/b-home.txt ~/link-to-b && ln -s ../../../etc/passwd ~/dots');
  await run(B, 'tb', 'echo b-secret > ~/b-home.txt && echo b-tmp > /tmp/b-tmp.txt && (B_SECRET=b-env sleep 600 &)');
  const view = await run(A, 'ta', `id -u; echo $HOME; ls -A ~; ls -A /tmp; cat ~/link-to-b 2>&1; ls /home; grep -rl b-secret /home /tmp /workspace /opt /etc 2>/dev/null | head -5; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c B_SECRET; ls /sys/class/net | sort | tr '\\n' ','; echo; grep ' /home/assistant ' /proc/self/mountinfo | wc -l`);
  assert.match(view.output, /^10001\n\/home\/assistant\n/);
  assert.ok(view.output.includes('a-home.txt') && !view.output.includes('b-home.txt') && !view.output.includes('b-tmp.txt'), view.output);
  assert.match(view.output, /No such file or directory/);
  assert.ok(!/b-secret|b-env/.test(view.output), view.output);
  assert.match(view.output, /\n0\neth0,lo,\n1\n/);
  // Verify ICC isolation (A cannot reach a TCP listener in B) and host loopback isolation (A cannot reach a 127.0.0.1 host port).
  const bServer = await run(B, 'tb', `node -e "require('net').createServer(s=>s.end('from-b')).listen(18999,'0.0.0.0',()=>console.log('listening'))"`, 15_000, { keep_background: true });
  assert.equal(bServer.running, true, JSON.stringify(bServer));
  const bIp = JSON.parse(sh('docker', ['inspect', computers.name(B)]))[0].NetworkSettings.Networks[computers.networkName()].IPAddress;
  const gatewayIp = netInfo.IPAM?.Config?.[0]?.Gateway || '';
  assert.ok(bIp, 'container B should have an IP on the assistant egress network');
  const hostLoopback = createServer(socket => socket.end('host-loopback'));
  await new Promise(resolve => hostLoopback.listen(0, '127.0.0.1', resolve));
  const hostPort = hostLoopback.address().port;
  try {
    const netCheck = await run(A, 'ta', `node -e "
      const net = require('net');
      const probe = (host, port) => new Promise(resolve => {
        const s = net.connect({ host, port });
        const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 1500);
        s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('CONNECTED'); });
        s.on('error', e => { clearTimeout(t); resolve(e.code || 'ERR'); });
      });
      Promise.all([probe('${bIp}', 18999), probe('127.0.0.1', ${hostPort})${gatewayIp ? `, probe('${gatewayIp}', ${hostPort})` : ''}]).then(r => console.log(JSON.stringify(r)));
    "`, 15_000);
    const probes = JSON.parse(netCheck.output.trim());
    assert.ok(probes.every(p => p !== 'CONNECTED'), `ICC and host loopback must stay unreachable: ${JSON.stringify(probes)}`);
  } finally {
    await new Promise(resolve => hostLoopback.close(resolve));
  }
  passed('owners are isolated: HOME, /tmp, symlinks to another HOME, processes, environment, ICC and host loopback', { bIp, gatewayIp });

  // 2b. Preinstalled Chromium + X11 virtual desktop work across run_command calls with keep_background: true.
  const desktop = await run(A, 'ta', 'bot-desktop start --display :99 --size 1280x720x24', 15_000, { keep_background: true });
  assert.equal(desktop.running, true, JSON.stringify(desktop));
  const browser = await run(A, 'ta', `DISPLAY=:99 bot-chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile --window-size=1024,700 'data:text/html,<title>AssistantDesktop</title><h1>OK</h1>'`, 15_000, { keep_background: true });
  assert.equal(browser.running, true, JSON.stringify(browser));
  const desktopVerify = await run(A, 'ta', `set -e
    DISPLAY=:99 xdpyinfo >/dev/null
    i=0; until curl -fsS http://127.0.0.1:9222/json/version > /tmp/cdp.json; do i=$((i+1)); [ "$i" -lt 30 ] || exit 1; sleep 0.2; done
    grep -q '"Browser":"Chrome/' /tmp/cdp.json || grep -q '"Browser": "Chrome/' /tmp/cdp.json
    DISPLAY=:99 scrot -o /tmp/desktop.png
    identify /tmp/desktop.png
    rm -f /tmp/cdp.json /tmp/desktop.png`, 20_000);
  assert.equal(desktopVerify.exit_code, 0, desktopVerify.output);
  assert.match(desktopVerify.output, /1280x720/);
  passed('preinstalled Chromium CDP and X11 virtual desktop persist across commands with keep_background: true', desktopVerify.output.trim());
  const limits = await run(A, 'ta', 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max; echo "$BOT_TMP_LIMIT_MB"; echo "$BOT_WORKSPACE_LIMIT_MB"; touch /x 2>&1; cat /proc/self/status | grep -E "^(CapEff|NoNewPrivs)"');
  assert.match(limits.output, /^17179869184\n0\n512\n100000 100000\n20480\n20480\n.*Read-only file system\nCapEff:\t0000000000000000\nNoNewPrivs:\t1/s);
  passed('limits are in force: 16 GiB memory without swap, 512 pids, 1 CPU, 20 GiB ephemeral disk volumes, read-only root, no capabilities', limits.output.trim().split('\n'));
  const programs = await run(A, 'ta', `for d in /tmp /workspace; do printf '#!/bin/sh\\necho ran from %s\\n' $d > $d/probe.sh && chmod +x $d/probe.sh && $d/probe.sh; done`);
  assert.equal(programs.output, 'ran from /tmp\nran from /workspace\n', programs.output);
  passed('programs written to /tmp and /workspace run (both ephemeral volumes allow exec)', programs.output.trim().split('\n'));
  const imageTools = await run(A, 'ta', `python3 -c "from PIL import Image; im=Image.new('RGB',(320,240),(12,34,56)); im.save('/tmp/im.png'); im.resize((80,60)).save('/tmp/im.jpg',quality=80)" && identify /tmp/im.png /tmp/im.jpg && convert /tmp/im.png -resize 40x30 /workspace/im-small.png && identify /workspace/im-small.png && rm -f /tmp/im.png /tmp/im.jpg /workspace/im-small.png`);
  assert.equal(imageTools.exit_code, 0, imageTools.output);
  assert.match(imageTools.output, /320x240[\s\S]*80x60[\s\S]*40x30/);
  passed('image tools (Pillow and ImageMagick) run under the read-only sandbox');
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
  const listed = await file({ type: 'assistant_list', path: '/tmp', recursive: true });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.ok(listed.result.entries.some(e => e.path === 'in/data.bin' && e.type === 'file'));
  assert.ok(listed.result.entries.some(e => e.path === 'to-home' && e.type === 'symlink'));
  for (const path of ['/tmp/to-home', '/home/assistant/link-to-b', '/home/assistant/dots', '/etc', '../etc', '.runner-journal', '/workspace/.runner-journal', 'work-link'])
    assert.equal((await file({ type: 'assistant_list', path })).ok, false, 'list ' + path);
  for (const path of ['/tmp/to-home', '/home/assistant/link-to-b', '/home/assistant/dots', '/home/assistant', '/etc/passwd', '../etc/passwd', '.runner-journal/x', '/workspace/.runner-journal', 'work-link/in/data.bin', '/tmp', '/home/node/x'])
    assert.equal((await file({ type: 'assistant_read', path })).ok, false, path);
  assert.equal((await file({ type: 'assistant_delete', path: '/tmp/to-home' })).result.deleted, true);
  assert.equal((await run(A, 'ta', 'cat ~/a-home.txt')).output, 'a-secret\n', 'deleting a symlink leaves its target');
  assert.equal((await file({ type: 'assistant_delete', path: '/tmp/in' })).result.directory, true);
  passed('file operations are confined to HOME, /workspace and /tmp and follow no symlink');

  // 3. The turn ends: its processes (including background desktop and Chromium) end, /tmp stays for the next turn within the idle time.
  await computers.release(A, { turn: 'ta' });
  const name = computers.name(A), idle = sh('docker', ['top', name, '-eo', 'pid,args']);
  assert.ok(!idle.includes('sleep 600') && !idle.includes('Xvfb') && !idle.includes('openbox') && !idle.includes('chromium'), idle);
  const reused = await acquire(A, 'ta2');
  assert.equal(reused.reused, true);
  // Only this command's own record (and its live output) is in the journal.
  assert.match((await run(A, 'ta2', 'cat /tmp/a-tmp.txt ~/a-home.txt; ls /workspace/.runner-journal | wc -l')).output, /^a-tmp\na-secret\n[12]\n$/);
  passed('release ends the turn\'s processes (including background desktop/Chromium) and clears the journal; the next turn reuses the container and its /tmp');

  // 4. A changed fence: a new container; HOME persists, /tmp does not. Read-only HOME refuses writes.
  await computers.release(A, { turn: 'ta2' });
  await acquire(A, 'ta3', { fence: other, home_mode: 'ro' });
  const ro = await run(A, 'ta3', 'cat ~/a-home.txt; cat /tmp/a-tmp.txt 2>&1; { echo x > ~/new.txt; } 2>&1; echo scratch > /tmp/ok && cat /tmp/ok');
  assert.match(ro.output, /^a-secret\n.*No such file.*\n.*Read-only file system\nscratch\n$/s);
  passed('a changed fence recreates the computer: HOME kept, /tmp empty; a read-only HOME refuses writes', ro.output.trim().split('\n'));
  await computers.release(A, { turn: 'ta3' });
  // 5. A new HOME generation mounts only its new, empty directory.
  homes(`mkdir -m 700 /assistant-homes/${A}/home-2`);
  await acquire(A, 'ta4', { fence: other, home_generation: 2 });
  // /home/node comes from the base image; no other owner or generation is visible.
  assert.equal((await run(A, 'ta4', 'ls -A ~ | wc -l; ls /home')).output, '0\nassistant\nnode\n');
  passed('a new HOME generation starts empty and the sealed one is not mounted');
  await run(A, 'ta4', 'echo kept > ~/kept.txt');
  await computers.release(A, { turn: 'ta4' });
  // 6. New resources apply from the owner's next turn: the idle computer is replaced with the new limits, HOME kept.
  await computers.setSettings({ cpus: 0.5, memory_mb: 1024, pids: 256, tmp_mb: 128, workspace_mb: 256 });
  assert.equal((await acquire(A, 'ta5', { fence: other, home_generation: 2 })).reused, false);
  const resized = await run(A, 'ta5', 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max; echo "$BOT_TMP_LIMIT_MB"; echo "$BOT_WORKSPACE_LIMIT_MB"; stat -f -c %T /workspace; stat -f -c %T /tmp; df -Pk /workspace | awk "NR==2 {print \\$4}"; cat ~/kept.txt');
  const resizedLines = resized.output.trim().split('\n');
  assert.deepEqual(resizedLines.slice(0, 6), ['1073741824', '0', '256', '50000 100000', '128', '256']);
  assert.notEqual(resizedLines[6], 'tmpfs', '/workspace must be a disk-backed volume, not tmpfs');
  assert.notEqual(resizedLines[7], 'tmpfs', '/tmp must be a disk-backed volume, not tmpfs');
  assert.ok(Number(resizedLines[8]) > 0, 'disk-backed /workspace must report positive available space');
  assert.equal(resizedLines[9], 'kept');
  passed('new resources replace the idle computer at the next turn: 1 GiB without swap, 256 pids, 0.5 CPU, disk-backed /workspace & /tmp volumes with 128/256 MiB soft limits, HOME kept', resizedLines);
  await computers.release(A, { turn: 'ta5' });
  // 6b. Turning egress off replaces the idle container with NetworkMode: none.
  await computers.setSettings({ cpus: 1, memory_mb: 2048, pids: 512, tmp_mb: 512, workspace_mb: 512, egress: false });
  assert.equal((await acquire(A, 'ta6', { fence: other, home_generation: 2 })).reused, false);
  const offline = await run(A, 'ta6', `ls /sys/class/net; node -e "require('net').connect(80,'1.1.1.1').on('error',e=>console.log('net',e.code))"`);
  assert.match(offline.output, /^lo\nnet E(NETUNREACH|NOTFOUND|AI_AGAIN|CONNREFUSED)/);
  assert.equal(computers.facts(await computers.inspect(A)).network_policy, 'none');
  passed('disabling egress replaces the idle container with NetworkMode: none (lo only, outbound blocked)', offline.output.trim().split('\n'));
  await computers.release(A, { turn: 'ta6' });
  await computers.setSettings({ egress: true });

  // 7. Idle timeout and fence removal take the container away with its processes.
  computers.leases.get(A).used -= 10 * 60_000; await computers.check(); await Promise.all([...computers.removing.values()]);
  assert.equal(sh('docker', ['ps', '-aq', '--filter', 'name=' + name]).trim(), '');
  await computers.remove(B);
  passed('idle and removed computers leave no container');

  // 8. Measurements.
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

  // 9. A manager restart removes every assistant computer of the deployment.
  computers = new AssistantComputers({ docker, db, deployment, image, homes: null });
  assert.equal(await computers.recover(), 10);
  assert.equal(sh('docker', ['ps', '-aq', '--filter', 'label=department.bot.deployment=' + deployment, '--filter', 'label=department.bot.kind=assistant']).trim(), '');
  passed('a manager restart removes the computers left from before');
  // 10. No fallback: a computer that cannot be created (here its image does not exist) is an error, and nothing runs elsewhere.
  computers = new AssistantComputers({ docker, db, deployment, image: `dbot-assistant-457-missing-${tag}:none`, homes: null });
  await assert.rejects(acquire(A, 'tz'), error => error.message === 'assistant_computer_create_failed' && /not found/.test(error.detail));
  assert.equal(computers.leases.size, 0);
  passed('a failed creation is a clear error and leaves no lease');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = String(error?.stack || error); console.error(error); process.exitCode = 1;
} finally {
  await computers.shutdown().catch(() => {});
  for (const id of sh('docker', ['ps', '-aq', '--filter', 'label=department.bot.deployment=' + deployment]).split('\n').filter(Boolean)) sh('docker', ['rm', '-f', id]);
  try { sh('docker', ['volume', 'rm', '-f', volume, resultVolume]); } catch {}
  try { sh('docker', ['image', 'rm', '-f', image]); } catch {}
  writeFileSync(join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));
  rmSync(join(work, 'context'), { recursive: true, force: true });
  console.log('evidence: ' + join(work, 'evidence.json'));
}
