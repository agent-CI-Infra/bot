// Runs the unit tests as test sets: the files of one set run one after another in a node --test process of their own,
// and different sets run at the same time. Each set gets its own TMPDIR and HOME inside one run directory under .tmp/,
// and its processes may only connect to loopback (test/framework/test-network-guard.mjs). Rules for writing tests that fit
// this: CONTRIBUTING.md, section 检查与测试.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverSets, planShards } from './test-plan.mjs';

const usage = 'usage: node test/framework/test-sets.mjs [--jobs N] [--shard INDEX/TOTAL] [test/.../<name>.test.mjs ...]';
let jobs = Number(process.env.BOT_TEST_JOBS) || availableParallelism(), shardArg = process.env.BOT_TEST_SHARD;
const picked = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--jobs') jobs = Number(process.argv[++i]);
  else if (arg.startsWith('--jobs=')) jobs = Number(arg.slice('--jobs='.length));
  else if (arg === '--shard') shardArg = process.argv[++i] ?? '';
  else if (arg.startsWith('--shard=')) shardArg = arg.slice('--shard='.length);
  else if (arg.startsWith('-')) fail(usage);
  else picked.push(arg);
}
if (!Number.isInteger(jobs) || jobs < 1) fail(usage);
// #1371: the wall-clock limit of one set, in seconds. node --test waits forever for a test without a timeout of its own,
// and sets stuck that way once kept a whole local run waiting for an hour. The default stays well above the
// slowest healthy set: codex-harness takes up to about 340 s on CI and up to about 1340 s on a loaded local machine.
// It bounds the whole set process instead of using node's --test-timeout: given to node --test, that caps each file as a
// whole, cutting a file whose tests together run longer even when each has a longer timeout of its own.
const limit = process.env.BOT_TEST_SET_TIMEOUT ? Number(process.env.BOT_TEST_SET_TIMEOUT) : 1800;
if (!Number.isFinite(limit) || limit <= 0) fail('BOT_TEST_SET_TIMEOUT must be a positive number of seconds');
const grace = 10_000; // How long a stopped set has between SIGTERM and SIGKILL.

let plan, shard;
try {
  const match = shardArg === undefined ? null : /^(\d+)\/(\d+)$/.exec(shardArg);
  if (shardArg !== undefined && !match) fail(usage);
  plan = planShards(discoverSets(picked.length ? picked : undefined), match ? Number(match[2]) : 1);
  const index = match ? Number(match[1]) : 1;
  if (index < 1 || index > plan.shards.length) fail(usage);
  shard = plan.shards[index - 1];
} catch (error) { fail(error.message); }
const sets = new Map(shard.sets.map(set => [set.name, set]));

mkdirSync('.tmp', { recursive: true });
// The longest sets of the last run start first, so that no long set is left running alone at the end; sets without a
// recorded duration (new ones, or every set on a fresh checkout) go first, the bigger files before the smaller.
const timings = resolve('.tmp/test-set-durations.json'), previous = (() => { try { return JSON.parse(readFileSync(timings, 'utf8')); } catch { return {}; } })();
const queue = [...sets.values()].sort((a, b) => (previous[b.name] ?? (shardArg ? b.weight : Infinity)) - (previous[a.name] ?? (shardArg ? a.weight : Infinity)) || b.size - a.size);
const run = mkdtempSync(resolve('.tmp/tests-')), guard = new URL('./test-network-guard.mjs', import.meta.url).href;
const began = Date.now(), seconds = at => ((at - began) / 1000).toFixed(1), results = [], children = new Set();
let active = 0, peak = 0, stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; for (const child of children) stop(child, signal); });
console.log(`# ${sets.size} test sets, up to ${jobs} at a time, in ${run}; a set still running after ${limit}s is stopped (BOT_TEST_SET_TIMEOUT)`);
// #973: without the runner's dependencies role-conversation stops at pi_runtime_unavailable and integration-engine at
// waiting_environment, and neither error names the missing install step, so a full local run reads as two
// implementation regressions. Say it next to the banner, before any red is read, and stay silent when the SDK is
// there. BOT_RUNNER_DIR is the directory to check (default `runner`); the test that pins this line points it elsewhere.
const runnerDir = process.env.BOT_RUNNER_DIR || 'runner';
if (!existsSync(join(runnerDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')))
  console.log(`# runner dependencies missing under ${runnerDir}/node_modules: role-conversation (test/st/src/roles/role-conversation.test.mjs) and integration-engine (test/st/src/tasks/integration-engine.test.mjs) fail for that reason\n`
    + '#   install them with: npm ci --prefix runner --omit=dev --ignore-scripts   (CONTRIBUTING.md)');

async function runSet(set) {
  const root = join(run, set.name), network = join(root, 'network.log');
  const env = { ...process.env, BOT_TEST_SET: set.name, TMPDIR: join(root, 'tmp'), HOME: join(root, 'home'), BOT_TEST_NETWORK_LOG: network,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${guard}`.trim() };
  // Removed so that programs following the XDG layout fall back to the set's HOME, and nothing prefers TMP over TMPDIR.
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMP', 'TEMP']) delete env[name];
  // Nested runner tests must not write over the parent shard's artifacts.
  delete env.BOT_TEST_REPORT; delete env.BOT_TEST_SUMMARY; delete env.BOT_TEST_SHARD;
  mkdirSync(env.TMPDIR, { recursive: true }); mkdirSync(env.HOME);
  const start = Date.now(), output = [];
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...set.files], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); active++; peak = Math.max(peak, active);
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
  let timedOut = false;
  // setTimeout fires at once for delays above 2^31-1 ms, so a very large limit is held at that (about 24 days).
  const timer = setTimeout(() => {
    timedOut = true;
    process.stdout.write(`# set ${set.name} still running after ${limit}s: stopping it (SIGTERM, SIGKILL after ${grace / 1000}s)\n`);
    stop(child, 'SIGTERM');
  }, Math.min(limit * 1000, 2 ** 31 - 1));
  const code = await new Promise(done => child.on('close', (code, signal) => done(code ?? signal)));
  clearTimeout(timer); settle(child);
  children.delete(child); active--;
  const text = Buffer.concat(output).toString(), blocked = existsSync(network) ? readFileSync(network, 'utf8') : '', counts = {};
  // node --test ends its TAP output with "# tests N", "# pass N", ... for everything it ran. A stopped one prints the
  // tests that finished and no totals.
  for (const [, key, value] of text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) counts[key] = Number(value);
  const ok = code === 0 && !blocked && !timedOut;
  const state = ok ? 'passed' : timedOut ? `failed (timed out after ${limit}s)` : code !== 0 ? `failed (exit ${code})` : 'failed (connected outside loopback)';
  const result = { set, ok, state, start, end: Date.now(), counts };
  results.push(result);
  // A set's output is printed in one piece when it finishes, so the output of sets that ran together never interleaves.
  process.stdout.write(`# set ${set.name} (${set.files.join(' ')}) ${result.state}, +${seconds(start)}s to +${seconds(result.end)}s\n${text}`
    + (blocked ? `# connections outside loopback, blocked by test/framework/test-network-guard.mjs:\n${blocked.trimEnd().replace(/^/gm, '#   ')}\n` : ''));
  if (ok) rmSync(root, { recursive: true, force: true });
}
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length && !stopping) await runSet(queue.shift()); }));

writeFileSync(`${timings}.${process.pid}`, JSON.stringify({ ...previous, ...Object.fromEntries(results.map(r => [r.set.name, (r.end - r.start) / 1000])) }));
renameSync(`${timings}.${process.pid}`, timings);
const total = key => results.reduce((sum, r) => sum + (r.counts[key] || 0), 0), failed = results.filter(r => !r.ok);
console.log(`# ${results.length} of ${sets.size} test sets ran, at most ${peak} at the same time, in ${seconds(Date.now())}s`);
console.log(`# start and end of each set, in seconds after ${new Date(began).toISOString()}:`);
for (const r of [...results].sort((a, b) => a.start - b.start || a.end - b.end)) console.log(`#   ${r.set.name.padEnd(28)} ${seconds(r.start).padStart(6)} ${seconds(r.end).padStart(6)}  ${r.state}`);
console.log(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => `# ${key} ${total(key)}`).join('\n'));
// BOT_TEST_SUMMARY: where to write the same totals as named numbers (the simple JSON format the public board charts
// scheduled runs from, #938). Nightly uploads it as an artifact.
if (process.env.BOT_TEST_SUMMARY) writeFileSync(process.env.BOT_TEST_SUMMARY, JSON.stringify({ metrics: [
  ...['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => ({ name: key, value: total(key), unit: 'count' })),
  { name: 'failed sets', value: failed.length + sets.size - results.length, unit: 'count' },
  { name: 'duration', value: Math.round((Date.now() - began) / 1000), unit: 's' }] }, null, 2) + '\n');
const endedAt = Date.now();
if (process.env.BOT_TEST_REPORT) writeFileSync(process.env.BOT_TEST_REPORT, JSON.stringify({ version: 1, planHash: plan.hash, corpusHash: plan.corpusHash,
  revision: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, attempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
  shard: { index: shard.index, total: plan.shards.length }, jobs, seconds: (endedAt - began) / 1000, startedAt: began, endedAt,
  machine: { cpu: cpus()[0]?.model || 'unknown', parallelism: availableParallelism(), node: process.version, image: process.env.ImageVersion ?? null },
  sets: results.map(r => ({ name: r.set.name, files: r.set.files, ok: r.ok, counts: r.counts, seconds: (r.end - r.start) / 1000 })) }, null, 2) + '\n');
if (failed.length || results.length < sets.size) { console.log(`# failed sets: ${failed.map(r => r.set.name).join(' ') || 'none'}; their files stay in ${run}`); process.exitCode = 1; }
else rmSync(run, { recursive: true, force: true });

// Stops a set's node --test process and every process under it. node --test ends its own file processes on SIGTERM or
// SIGINT, but not what those files started: a helper of a test that never finished would be left behind, owned by
// init. So the signal goes to the whole tree as it is now, and what is still there a grace period later gets SIGKILL.
// The set's output pipes are closed then too, because a leftover that inherited them would hold back 'close'.
function stop(child, signal) {
  const running = child.exitCode === null && child.signalCode === null, tree = running ? [child.pid, ...descendants(child.pid)] : [];
  child.tree = [...new Set([...(child.tree || []), ...tree])];
  for (const pid of tree) send(pid, signal);
  child.killer ??= setTimeout(() => {
    const now = child.exitCode === null && child.signalCode === null ? [child.pid, ...descendants(child.pid)] : [];
    for (const pid of new Set([...now, ...child.tree])) send(pid, 'SIGKILL');
    child.stdout.destroy(); child.stderr.destroy();
  }, grace);
}

// After a stopped set has closed: nothing it started may outlive it, even what ignored the first signal.
function settle(child) {
  clearTimeout(child.killer);
  for (const pid of child.tree || []) if (pid !== child.pid) send(pid, 'SIGKILL');
}

// Every process below pid, from one ps listing (POSIX options, so Linux and macOS alike); none without ps.
function descendants(pid) {
  let listing;
  try { listing = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return []; }
  const below = new Map();
  for (const line of listing.trim().split('\n')) {
    const [id, parent] = line.trim().split(/\s+/).map(Number);
    if (!below.has(parent)) below.set(parent, []);
    below.get(parent).push(id);
  }
  const found = [];
  for (let i = 0, next = [pid]; i < next.length; i++) for (const kid of below.get(next[i]) || []) { found.push(kid); next.push(kid); }
  return found;
}

function send(pid, signal) { try { process.kill(pid, signal); } catch { /* already gone */ } }

function fail(message) { console.error(message); process.exit(2); }
