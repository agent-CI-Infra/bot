// The release workflow was the one long path without job-level bounds (#741): a registry, remote Docker daemon or SSH
// session that hung kept the runner until the platform's 360-minute ceiling, which reads as "still releasing" while
// nothing runs. The workflow file is the subject here, so that a later edit cannot drop a bound again, and the bounds
// stay above the waits they cover: 30 minutes for the manager to start (docker/compose.yaml start_period: 30m), 85 minutes for
// bot to become healthy (the loop in the Deploy script, 1700 rounds of 3 seconds), and the rest for pull and recreate.
// test/docker/deploy/deploy-recovery-docker.mjs still extracts the remote script between the <<'SCRIPT' and SCRIPT markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const text = readFileSync('.github/workflows/release.yml', 'utf8'), workflow = parse(text);
const deploy = workflow.jobs.deploy, step = deploy.steps.find(entry => entry.name === 'Deploy');
const minutes = (name, job) => job?.['timeout-minutes'];
const docs = readFileSync('docs/features/deployment-and-operations.md', 'utf8');

test('the release and deploy jobs of the release workflow stop at a declared time instead of the platform ceiling', () => {
  // release waits up to 30 minutes for the Images run of the tagged commit (seq 1 60, sleep 30) and then tags, so a
  // hang in the registry or in gh must end on its own shortly after that wait.
  assert.equal(minutes('release', workflow.jobs.release), 45, 'jobs.release.timeout-minutes');
  assert.equal(minutes('deploy', deploy), 150, 'jobs.deploy.timeout-minutes');
  // The deploy job covers the manager's 30-minute start plus the 85-minute health loop plus pull and recreate; a value
  // under that sum would fail deployments that are only slow.
  assert.ok(minutes('deploy', deploy) > 30 + 85, 'the deploy bound covers 30 min manager start and 85 min health loop');
  // The step ends before its job, so the failure shows on the step that hung, with its own log.
  assert.equal(minutes('deploy step', step), 145, 'the Deploy step timeout-minutes');
  assert.ok(minutes('deploy step', step) < minutes('deploy', deploy), 'the Deploy step ends before its job');
  // The SSH check keeps its own 2 minutes; nothing else in the file declares a bound.
  const check = deploy.steps.find(entry => entry.name === 'Check SSH connection');
  assert.equal(minutes('ssh check', check), 2, 'the Check SSH connection timeout-minutes');
});

test('the remote commands of the Deploy step are bounded on the server, and the bounds fit inside the step', () => {
  const script = step.run, pull = /timeout -k (\d+)s (\d+)m docker compose pull\n/.exec(script), up = /timeout -k (\d+)s (\d+)m docker compose up -d --force-recreate\n/.exec(script);
  // A local timeout around ssh only kills the client; the bound belongs to the remote command so that the EXIT trap in
  // the script still prints the containers' state and the step's log says what timed out.
  assert.ok(pull, 'docker compose pull runs under a command-level timeout with a kill grace period inside the remote script');
  assert.ok(up, 'docker compose up -d runs under a command-level timeout with a kill grace period inside the remote script');
  // #923: `timeout` alone sends SIGTERM and then waits as long as the command takes to exit; compose stops containers by
  // asking the same daemon that may be the hang, so without a kill grace period the bound holds only when the daemon
  // answers. Thirty seconds after the deadline the command is killed instead.
  assert.equal(Number(pull[1]), 30, 'the pull bound escalates to SIGKILL 30 seconds after its deadline');
  assert.equal(Number(up[1]), 30, 'the recreate bound escalates to SIGKILL 30 seconds after its deadline');
  assert.ok(Number(up[2]) > 30, 'the recreate bound is above the 30-minute start period of the manager');
  const loop = /seq 1 (\d+)\); do[\s\S]*?sleep (\d+)\n/.exec(script);
  assert.ok(loop, 'the health loop is still (seq 1 1700) with sleep 3');
  const health = Number(loop[1]) * Number(loop[2]) / 60;
  assert.equal(health, 85, 'the health loop allows 85 minutes');
  const budget = Number(pull[2]) + Number(up[2]) + health;
  assert.ok(budget <= minutes('deploy step', step), `the inner bounds add up to ${budget} min and fit the ${minutes('deploy step', step)}-minute step`);
  // The heredoc markers are how the deploy test and the server receive the script unchanged.
  assert.ok(script.includes("<<'SCRIPT'\n") && script.trimEnd().endsWith('SCRIPT'), 'the remote script keeps its <<\'SCRIPT\' ... SCRIPT markers');
  // Timeouts only: the waits and the steps of a normal release stay as they are.
  assert.ok(/for attempt in \$\(seq 1 60\); do/.test(text) && script.includes('for i in $(seq 1 1700); do'), 'the Images wait and the 1700-round health wait are unchanged');
});

test('the Deploy step comment counts the inspect calls of the health loop in the 145-minute budget', () => {
  // #923: the loop's 1700 rounds are 85 minutes of sleep plus two docker inspect calls each, so the step's budget has to
  // name that cost instead of leaving the loop's wall-clock time out of the arithmetic.
  // The search is scoped to the Deploy step: `#923` and `docker inspect` both occur earlier in the file (the pull
  // comment and the container sweep), so a match against the whole workflow would pass even with the step's own
  // comment reverted.
  const start = text.indexOf('- name: Deploy');
  const end = text.indexOf('timeout-minutes: 145', start);
  assert.ok(start > -1 && end > start, 'the Deploy step is present with its own timeout-minutes');
  const stepComment = text.slice(start, end);
  assert.match(stepComment, /#923[^]*?about 88[^]*?docker inspect/,
    'the Deploy step comment names the inspect calls and the wall-clock budget they add');
  // The health loop's 90-minute wording is gone from the workflow as well as from the docs.
  assert.ok(!/up to 90 minutes/.test(text), 'the deploy job comment has no stale 90-minute health wait');
});

test('the deployment docs name the server timeout dependency, its bounds and its exit codes', () => {
  // #923: the remote script needs GNU coreutils' `timeout` on the target; a machine without it fails the first
  // deployment with 127, and a bound that fires has to be readable from the docs as 124 (or 137 when the grace period
  // is needed) rather than as a health-check failure.
  assert.match(docs, /GNU coreutils[^]*?`timeout`/, 'docs/features/deployment-and-operations.md names GNU coreutils timeout as a server prerequisite');
  assert.match(docs, /15 分钟[^]*?35 分钟/, 'docs/features/deployment-and-operations.md gives the pull and recreate bounds');
  assert.match(docs, /124/, 'docs/features/deployment-and-operations.md names the exit code of a bound that fires');
  assert.match(docs, /137/, 'docs/features/deployment-and-operations.md names the exit code of the kill grace period');
  assert.match(docs, /85 分钟/, 'docs/features/deployment-and-operations.md states the shortened health wait');
  assert.ok(!docs.includes('90 分钟'), 'docs/features/deployment-and-operations.md has no stale 90-minute health wait');
});
