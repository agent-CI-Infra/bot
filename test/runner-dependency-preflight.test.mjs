// #973: a checkout without the project runner's dependencies turns two test files into failures whose own output
// names no cause (role-conversation stops at pi_runtime_unavailable, integration-engine at waiting_environment).
// The test runner must report that gap and the install command next to its banner, and say nothing when the
// dependencies are there. BOT_RUNNER_DIR points the check at another directory, which is how these cases build a
// missing and a present runner without touching the checkout's own runner/node_modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Scratch directories live under the checkout's .tmp (gitignored) so that the test uses the same writable place the
// runner itself uses for its run directories, whatever TMPDIR the caller has.
const scratch = (t, prefix) => {
  mkdirSync(join(root, '.tmp'), { recursive: true });
  const dir = mkdtempSync(join(root, '.tmp', prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const install = 'npm ci --prefix runner --omit=dev --ignore-scripts';
const missing = 'runner dependencies missing';

function runner(t, { sdk }) {
  const dir = scratch(t, 'preflight-runner-');
  if (sdk) {
    const packageDir = join(dir, 'runner', 'node_modules', '@earendil-works', 'pi-coding-agent');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0' }));
  }
  return join(dir, 'runner');
}

// test-sets runs the file it is given as one test set; the fixture keeps that inner run a single passing test, so the
// output under test is the runner's own banner and whatever the preflight adds to it.
function sets(t, runnerDir) {
  const dir = scratch(t, 'preflight-fixture-');
  const fixture = join(dir, 'fixture.test.mjs');
  writeFileSync(fixture, "import { test } from 'node:test';\ntest('fixture', () => {});\n");
  const env = { ...process.env, BOT_RUNNER_DIR: runnerDir, BOT_TEST_JOBS: '1' };
  // The outer test already runs inside node --test; a nested runner must not inherit that context or the fixture is
  // reported as skipped instead of run.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['test/framework/test-sets.mjs', fixture], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, output: Buffer.concat(output).toString() }));
  });
}

test('a checkout without the runner dependencies names them and the install command next to the banner', async t => {
  const { code, output } = await sets(t, runner(t, { sdk: false }));
  assert.equal(code, 0, output);
  const lines = output.split('\n'), banner = lines.findIndex(line => /^# \d+ test sets?, up to \d+ at a time, in /.test(line));
  assert.ok(banner >= 0, `the runner must print its banner:\n${output}`);
  const beside = lines.slice(banner + 1, banner + 4).join('\n');
  assert.ok(beside.includes(missing), `the banner line must be followed by the missing-dependency notice:\n${output}`);
  for (const needle of ['role-conversation', 'test/role-conversation.test.mjs', 'integration-engine', 'test/integration-engine.test.mjs', install, 'docs/development.md:33'])
    assert.ok(beside.includes(needle), `the notice must name ${needle}:\n${beside}`);
});

test('a checkout with the runner dependencies prints no such notice', async t => {
  const { code, output } = await sets(t, runner(t, { sdk: true }));
  assert.equal(code, 0, output);
  assert.ok(!output.includes(missing), `installed runner dependencies must not be reported:\n${output}`);
});
