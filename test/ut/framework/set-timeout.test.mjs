// #1371: a test set that never returns must not keep npm test running. test-sets stops a set that is still running after
// BOT_TEST_SET_TIMEOUT seconds, together with every process under it, records it as failed and runs the other sets on;
// a SIGTERM to the runner itself stops the running sets the same way. The fixture set hangs in top-level await, outside
// any test(), so only the set's wall clock can end it, and it leaves a helper that ignores SIGTERM, which node --test
// itself would not stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url)), runner = join(root, 'test/framework/test-sets.mjs');

function fixtures(t) {
  mkdirSync(join(root, '.tmp'), { recursive: true });
  const dir = mkdtempSync(join(root, '.tmp', 'set-timeout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper.pid'), hang = join(dir, 'hang.test.mjs'), pass = join(dir, 'pass.test.mjs');
  writeFileSync(hang, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const helper = spawn('sh', ['-c', "trap '' TERM; exec sleep 300"], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(helper)}, String(helper.pid));
await new Promise(() => setInterval(() => {}, 1000));
`);
  writeFileSync(pass, "import { test } from 'node:test';\ntest('passes', () => {});\n");
  return { dir, helper, files: [hang, pass] };
}

// The runner works in the fixture directory, so its .tmp/ (timings, run directories) stays out of the checkout's own.
function start({ dir, files }, timeout) {
  const env = { ...process.env, BOT_TEST_SET_TIMEOUT: String(timeout), BOT_TEST_JOBS: '2' };
  // A nested runner must not inherit the outer node --test context, or the fixtures are reported as skipped.
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.BOT_TEST_REPORT; delete env.BOT_TEST_SUMMARY; delete env.BOT_TEST_SHARD;
  const child = spawn(process.execPath, [runner, ...files], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }), output = [];
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, output: Buffer.concat(output).toString() }));
  });
  return { child, ended };
}

// A process is gone once kill(0) fails or it is a zombie its new parent has not reaped yet.
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z'; } catch { return true; }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function gone(pid) {
  for (const until = Date.now() + 5000; alive(pid); await pause(50)) if (Date.now() > until) return false;
  return true;
}

async function helperPid(path) {
  for (const until = Date.now() + 30_000; !existsSync(path) || !readFileSync(path, 'utf8'); await pause(50))
    if (Date.now() > until) assert.fail('the hanging fixture never started its helper');
  return Number(readFileSync(path, 'utf8'));
}

test('a set past its time limit is stopped with everything it started, fails the run, and the other sets still pass', { timeout: 60_000 }, async t => {
  const fixture = fixtures(t), began = Date.now();
  // Long enough for the passing set to start node and finish on a loaded machine, as it has the same limit.
  const { code, output } = await start(fixture, 6).ended;
  const pid = await helperPid(fixture.helper);
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert.equal(code, 1, output);
  assert.ok(Date.now() - began < 30_000, `the runner must end soon after the limit:\n${output}`);
  assert.match(output, /^# set hang still running after 6s: stopping it \(SIGTERM, SIGKILL after 10s\)$/m);
  assert.match(output, /^# set hang \(\S*hang\.test\.mjs\) failed \(timed out after 6s\), /m);
  assert.match(output, /^# set pass \(\S*pass\.test\.mjs\) passed, /m);
  assert.match(output, /^# failed sets: hang; /m);
  assert.ok(await gone(pid), `the set's helper, which ignores SIGTERM, must not outlive the set (pid ${pid})`);
});

test('SIGTERM to the runner stops a running set with everything it started, long before the set limit', { timeout: 60_000 }, async t => {
  const fixture = fixtures(t), { child, ended } = start(fixture, 600);
  const pid = await helperPid(fixture.helper);
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  child.kill('SIGTERM');
  const { code, output } = await ended;
  assert.equal(code, 1, output);
  assert.match(output, /^# set hang \(\S*hang\.test\.mjs\) failed \(exit /m);
  assert.doesNotMatch(output, /^# set hang still running after/m);
  assert.ok(await gone(pid), `the set's helper must not outlive an interrupted run (pid ${pid})`);
});
