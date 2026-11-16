// The release workflow was the one long path without job-level bounds (#741): a registry, remote Docker daemon or SSH
// session that hung kept the runner until the platform's 360-minute ceiling, which reads as "still releasing" while
// nothing runs. The workflow file is the subject here, so that a later edit cannot drop a bound again, and the bounds
// stay above the waits they cover: 30 minutes for the manager to start (compose.yaml start_period: 30m), 90 minutes for
// bot to become healthy (the loop in the Deploy script, 1800 rounds of 3 seconds), and the rest for pull and recreate.
// test/deploy-recovery-docker.mjs still extracts the remote script between the <<'SCRIPT' and SCRIPT markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const text = readFileSync('.github/workflows/release.yml', 'utf8'), workflow = parse(text);
const deploy = workflow.jobs.deploy, step = deploy.steps.find(entry => entry.name === 'Deploy');
const minutes = (name, job) => job?.['timeout-minutes'];

test('the release and deploy jobs of the release workflow stop at a declared time instead of the platform ceiling', () => {
  // release waits up to 30 minutes for the Images run of the tagged commit (seq 1 60, sleep 30) and then tags, so a
  // hang in the registry or in gh must end on its own shortly after that wait.
  assert.equal(minutes('release', workflow.jobs.release), 45, 'jobs.release.timeout-minutes');
  assert.equal(minutes('deploy', deploy), 150, 'jobs.deploy.timeout-minutes');
  // The deploy job covers the manager's 30-minute start plus the 90-minute health loop plus pull and recreate; a value
  // under that sum would fail deployments that are only slow.
  assert.ok(minutes('deploy', deploy) > 30 + 90, 'the deploy bound covers 30 min manager start and 90 min health loop');
  // The step ends before its job, so the failure shows on the step that hung, with its own log.
  assert.equal(minutes('deploy step', step), 145, 'the Deploy step timeout-minutes');
  assert.ok(minutes('deploy step', step) < minutes('deploy', deploy), 'the Deploy step ends before its job');
  // The SSH check keeps its own 2 minutes; nothing else in the file declares a bound.
  const check = deploy.steps.find(entry => entry.name === 'Check SSH connection');
  assert.equal(minutes('ssh check', check), 2, 'the Check SSH connection timeout-minutes');
});

test('the remote commands of the Deploy step are bounded on the server, and the bounds fit inside the step', () => {
  const script = step.run, pull = /timeout (\d+)m docker compose pull\n/.exec(script), up = /timeout (\d+)m docker compose up -d --force-recreate\n/.exec(script);
  // A local timeout around ssh only kills the client; the bound belongs to the remote command so that the EXIT trap in
  // the script still prints the containers' state and the step's log says what timed out.
  assert.ok(pull, 'docker compose pull runs under a command-level timeout inside the remote script');
  assert.ok(up, 'docker compose up -d runs under a command-level timeout inside the remote script');
  assert.ok(Number(up[1]) > 30, 'the recreate bound is above the 30-minute start period of the manager');
  const loop = /seq 1 (\d+)\); do[\s\S]*?sleep (\d+)\n/.exec(script);
  assert.ok(loop, 'the health loop is still (seq 1 1800) with sleep 3');
  const health = Number(loop[1]) * Number(loop[2]) / 60;
  assert.equal(health, 90, 'the health loop still allows 90 minutes');
  const budget = Number(pull[1]) + Number(up[1]) + health;
  assert.ok(budget <= minutes('deploy step', step), `the inner bounds add up to ${budget} min and fit the ${minutes('deploy step', step)}-minute step`);
  // The heredoc markers are how the deploy test and the server receive the script unchanged.
  assert.ok(script.includes("<<'SCRIPT'\n") && script.trimEnd().endsWith('SCRIPT'), 'the remote script keeps its <<\'SCRIPT\' ... SCRIPT markers');
  // Timeouts only: the waits and the steps of a normal release stay as they are.
  assert.ok(/for attempt in \$\(seq 1 60\); do/.test(text) && script.includes('for i in $(seq 1 1800); do'), 'the Images and health waits are unchanged');
});
