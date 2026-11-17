// #734: a job with no timeout-minutes can hold a required check for the platform default of 360 minutes. Every job
// that runs on push, pull_request or merge_group in these three workflows must bound itself, and the two commands
// that hold a required check the longest must be bounded below their job so a wedged run fails at a point where the
// failure artifacts still upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflows = new URL('../.github/workflows/', import.meta.url);
const read = name => parse(readFileSync(new URL(`${name}.yml`, workflows), 'utf8'));
const steps = job => job.steps ?? [];

// Sizes decided on #734 from each job's own recent runs: unit/e2e 30 minutes (slowest recent 762 s and 400 s),
// analyze 15 (slowest leg 356 s), image 10 (slowest leg 85 s).
const jobBounds = new Map([
  ['checks', new Map([['unit-shards', 30], ['unit', 5], ['e2e', 30]])],
  ['codeql', new Map([['analyze', 15]])],
  ['images', new Map([['image', 10]])],
]);
// The command bound sits below the job bound, so the command fails first and the job's remaining minutes still run
// the failure-only steps (checks.yml uploads the Playwright report with `if: failure()`).
const commandBounds = new Map([
  ['checks', new Map([['npm test', 25 * 60], ['npm run test:e2e', 20 * 60]])],
]);

for (const [name, bounds] of jobBounds) {
  const jobs = read(name).jobs ?? {};
  test(`${name}.yml bounds every job that can hold a required check`, () => {
    for (const [id, job] of Object.entries(jobs)) {
      const minutes = job['timeout-minutes'];
      assert.ok(Number.isInteger(minutes), `${name}.yml: job ${id} must declare an integer timeout-minutes`);
      assert.ok(minutes > 0 && minutes < 360, `${name}.yml: job ${id} timeout-minutes ${minutes} must be positive and below the platform's 360-minute default`);
    }
    for (const [id, minimum] of bounds) {
      assert.ok(jobs[id], `${name}.yml: expected job ${id}`);
      assert.ok(jobs[id]['timeout-minutes'] >= minimum, `${name}.yml: job ${id} timeout-minutes ${jobs[id]['timeout-minutes']} is below the ${minimum} minutes sized for its recent runs`);
    }
  });
}

for (const [name, bounds] of commandBounds) {
  const jobs = read(name).jobs ?? {};
  test(`${name}.yml bounds the long test commands inside their job`, () => {
    for (const [command, minimum] of bounds) {
      const host = Object.entries(jobs).filter(([, job]) => steps(job).some(step => typeof step.run === 'string' && step.run.includes(command)));
      assert.equal(host.length, 1, `${name}.yml: expected exactly one job running ${command}, found ${host.map(([id]) => id).join(', ') || 'none'}`);
      const [id, job] = host[0];
      const step = steps(job).find(candidate => typeof candidate.run === 'string' && candidate.run.includes(command));
      const bounded = /^timeout --signal=KILL (\d+) (.+)$/.exec(step.run.trim());
      assert.ok(bounded, `${name}.yml: ${id}'s ${command} must be wrapped as "timeout --signal=KILL <seconds> ${command}" so a wedged run fails the check`);
      const seconds = Number(bounded[1]);
      assert.equal(bounded[2].trim(), command, `${name}.yml: ${id}'s bound must wrap ${command}, not ${bounded[2].trim()}`);
      assert.ok(seconds >= minimum, `${name}.yml: ${id}'s ${command} bound ${seconds}s is below the ${minimum}s sized for its recent runs`);
      assert.ok(seconds < job['timeout-minutes'] * 60, `${name}.yml: ${id}'s ${command} bound ${seconds}s must fire before the job's ${job['timeout-minutes']}-minute bound`);
    }
  });
}
