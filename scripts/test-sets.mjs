// Runs the unit tests as test sets: the files of one set run one after another in a node --test process of their own,
// and different sets run at the same time. Each set gets its own TMPDIR and HOME inside one run directory under .tmp/,
// and its processes may only connect to loopback (scripts/test-network-guard.mjs). Rules for writing tests that fit
// this: docs/development.md, section 测试集与并行.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = 'usage: node scripts/test-sets.mjs [--jobs N] [test/<name>.test.mjs ...]';
let jobs = Number(process.env.BOT_TEST_JOBS) || availableParallelism();
const picked = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--jobs') jobs = Number(process.argv[++i]);
  else if (arg.startsWith('--jobs=')) jobs = Number(arg.slice('--jobs='.length));
  else if (arg.startsWith('-')) fail(usage);
  else picked.push(arg);
}
if (!Number.isInteger(jobs) || jobs < 1) fail(usage);

// *.live.test.mjs files call real external services; they never join the pool and are run by hand with node --test.
const live = file => file.endsWith('.live.test.mjs');
const files = picked.length ? picked : readdirSync('test').filter(name => name.endsWith('.test.mjs') && !live(name)).sort().map(name => `test/${name}`);
if (files.some(live)) fail('*.live.test.mjs files call real external services; run them with node --test, not as a test set');
// A file is a set of its own, unless a "// test-set: <name> <reason>" line puts it into a named set with other files.
const sets = new Map();
for (const file of files) {
  const line = /^\/\/ test-set:(.*)$/m.exec(readFileSync(file, 'utf8'))?.[1].trim(), named = line && /^([a-z0-9-]+)\s+\S/.exec(line)?.[1];
  if (line !== undefined && !named) fail(`${file}: write "// test-set: <name> <why these files must not run at the same time>"`);
  const name = named || basename(file, '.test.mjs'), set = sets.get(name) || { name, files: [], size: 0 };
  set.files.push(file); set.size += statSync(file).size; sets.set(name, set);
}

mkdirSync('.tmp', { recursive: true });
// The longest sets of the last run start first, so that no long set is left running alone at the end; sets without a
// recorded duration (new ones, or every set on a fresh checkout) go first, the bigger files before the smaller.
const timings = resolve('.tmp/test-set-durations.json'), previous = (() => { try { return JSON.parse(readFileSync(timings, 'utf8')); } catch { return {}; } })();
const queue = [...sets.values()].sort((a, b) => (previous[b.name] ?? Infinity) - (previous[a.name] ?? Infinity) || b.size - a.size);
const run = mkdtempSync(resolve('.tmp/tests-')), guard = pathToFileURL(resolve('scripts/test-network-guard.mjs')).href;
const began = Date.now(), seconds = at => ((at - began) / 1000).toFixed(1), results = [], children = new Set();
let active = 0, peak = 0, stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; for (const child of children) child.kill(signal); });
console.log(`# ${sets.size} test sets, up to ${jobs} at a time, in ${run}`);

async function runSet(set) {
  const root = join(run, set.name), network = join(root, 'network.log');
  const env = { ...process.env, BOT_TEST_SET: set.name, TMPDIR: join(root, 'tmp'), HOME: join(root, 'home'), BOT_TEST_NETWORK_LOG: network,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${guard}`.trim() };
  // Removed so that programs following the XDG layout fall back to the set's HOME, and nothing prefers TMP over TMPDIR.
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMP', 'TEMP']) delete env[name];
  mkdirSync(env.TMPDIR, { recursive: true }); mkdirSync(env.HOME);
  const start = Date.now(), output = [];
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...set.files], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); active++; peak = Math.max(peak, active);
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
  const code = await new Promise(done => child.on('close', (code, signal) => done(code ?? signal)));
  children.delete(child); active--;
  const text = Buffer.concat(output).toString(), blocked = existsSync(network) ? readFileSync(network, 'utf8') : '', counts = {};
  // node --test ends its TAP output with "# tests N", "# pass N", ... for everything it ran.
  for (const [, key, value] of text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) counts[key] = Number(value);
  const ok = code === 0 && !blocked, state = ok ? 'passed' : code !== 0 ? `failed (exit ${code})` : 'failed (connected outside loopback)';
  const result = { set, ok, state, start, end: Date.now(), counts };
  results.push(result);
  // A set's output is printed in one piece when it finishes, so the output of sets that ran together never interleaves.
  process.stdout.write(`# set ${set.name} (${set.files.join(' ')}) ${result.state}, +${seconds(start)}s to +${seconds(result.end)}s\n${text}`
    + (blocked ? `# connections outside loopback, blocked by scripts/test-network-guard.mjs:\n${blocked.trimEnd().replace(/^/gm, '#   ')}\n` : ''));
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
if (failed.length || results.length < sets.size) { console.log(`# failed sets: ${failed.map(r => r.set.name).join(' ') || 'none'}; their files stay in ${run}`); process.exitCode = 1; }
else rmSync(run, { recursive: true, force: true });

function fail(message) { console.error(message); process.exit(2); }
