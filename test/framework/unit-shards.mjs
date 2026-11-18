import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverSets, loadWeights, planShards } from './test-plan.mjs';

const median = values => { const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
const integer = value => Number.isSafeInteger(value) && value >= 0;

function identity(plan, report, { revision, runId, attempt = Infinity } = {}) {
  assert.equal(report.version, 1, 'unsupported shard report');
  assert.equal(report.planHash, plan.hash, 'shard planned a different corpus or weights');
  assert.equal(report.corpusHash, plan.corpusHash, 'shard corpus differs');
  assert.equal(report.shard.total, plan.shards.length, 'wrong shard count');
  assert.ok(integer(report.shard.index) && report.shard.index >= 1 && report.shard.index <= plan.shards.length, 'invalid shard index');
  assert.ok(integer(report.attempt) && report.attempt >= 1 && report.attempt <= attempt, 'invalid attempt');
  if (revision !== undefined) assert.equal(report.revision, revision, 'wrong revision');
  if (runId !== undefined) assert.equal(report.runId, runId, 'wrong workflow run');
}

export function mergeReports(plan, input, { jobs = 4, revision, runId, attempt = Infinity } = {}) {
  const latest = new Map(), seen = new Set();
  for (const report of input) {
    identity(plan, report, { revision, runId, attempt });
    const key = `${report.shard.index}/${report.attempt}`;
    assert.ok(!seen.has(key), 'duplicate shard report for the same attempt'); seen.add(key);
    if (!latest.has(report.shard.index) || latest.get(report.shard.index).attempt < report.attempt) latest.set(report.shard.index, report);
  }
  assert.equal(latest.size, plan.shards.length, 'missing shard reports');
  const reports = [...latest.values()].sort((a, b) => a.shard.index - b.shard.index), counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, 0]));
  assert.equal(new Set(reports.map(report => `${report.runId}/${report.revision}`)).size, 1, 'reports come from different runs or revisions');
  for (const report of reports) {
    assert.equal(report.jobs, jobs, 'wrong worker count');
    assert.ok(Number.isFinite(report.seconds) && report.seconds >= 0, 'invalid duration');
    const expected = plan.shards[report.shard.index - 1].sets;
    assert.equal(report.sets.length, expected.length, 'missing or extra test sets');
    assert.equal(new Set(report.sets.map(set => set.name)).size, report.sets.length, 'duplicate test set');
    for (const set of report.sets) {
      const wanted = expected.find(item => item.name === set.name);
      assert.ok(wanted, `unexpected test set ${set.name}`);
      assert.deepEqual([...set.files].sort(), [...wanted.files].sort(), 'test-set membership changed');
      assert.equal(set.ok, true, `failed test set ${set.name}`);
      assert.ok(Number.isFinite(set.seconds) && set.seconds >= 0, 'invalid test-set duration');
      for (const key of Object.keys(counts)) { assert.ok(integer(set.counts[key]), `missing TAP ${key}`); counts[key] += set.counts[key]; }
      assert.equal(set.counts.fail, 0, 'failed tests'); assert.equal(set.counts.cancelled, 0, 'cancelled tests');
      assert.equal(set.counts.tests, set.counts.pass + set.counts.skipped + set.counts.todo, 'inconsistent TAP totals');
    }
  }
  const shards = reports.map(report => ({ index: report.shard.index, attempt: report.attempt, sets: report.sets.length,
    tests: report.sets.reduce((n, set) => n + set.counts.tests, 0), seconds: report.seconds,
    estimatedSeconds: plan.shards[report.shard.index - 1].weight, machine: report.machine }));
  const maximum = Math.max(...shards.map(shard => shard.seconds)), minimum = Math.min(...shards.map(shard => shard.seconds));
  return { version: 1, planHash: plan.hash, corpusHash: plan.corpusHash, revision: reports[0].revision, runId: reports[0].runId, counts, shards,
    balance: { maximumSeconds: maximum, minimumSeconds: minimum, ratio: minimum ? maximum / minimum : null,
      idleFraction: maximum ? 1 - shards.reduce((n, shard) => n + shard.seconds, 0) / (shards.length * maximum) : 0 }, reports };
}

// Diagnostics survive failed/missing shards, but never turn them into a successful gate.
// Unknown test counts stay unknown: missing sets and report errors are separate metrics.
export function summarizeReports(plan, input, options = {}) {
  const latest = new Map(), ambiguous = new Set(), errors = [], counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, 0]));
  for (const report of input) {
    try { identity(plan, report, options); assert.equal(report.jobs, options.jobs ?? 4, 'wrong worker count'); assert.ok(Array.isArray(report.sets), 'missing sets'); }
    catch (error) { errors.push(report?.reportError || error.message); continue; }
    const old = latest.get(report.shard.index);
    if (!old || report.attempt > old.attempt) { latest.set(report.shard.index, report); ambiguous.delete(report.shard.index); }
    else if (report.attempt === old.attempt) { ambiguous.add(report.shard.index); errors.push('duplicate latest shard report'); }
  }
  let missing = 0, failed = 0, reported = 0;
  const selected = [];
  for (const shard of plan.shards) {
    const report = !ambiguous.has(shard.index) && latest.get(shard.index);
    if (!report) { missing += shard.sets.length; continue; }
    selected.push(report);
    const groups = new Map();
    for (const set of report.sets) { const values = groups.get(set.name) || []; values.push(set); groups.set(set.name, values); }
    for (const set of report.sets) if (!shard.sets.some(wanted => wanted.name === set.name)) errors.push(`unexpected test set ${set.name}`);
    for (const wanted of shard.sets) {
      const group = groups.get(wanted.name);
      try {
        assert.equal(group?.length, 1, 'missing or duplicate set');
        const set = group[0]; assert.deepEqual([...set.files].sort(), [...wanted.files].sort());
        for (const key of Object.keys(counts)) assert.ok(integer(set.counts[key]), `missing TAP ${key}`);
        assert.equal(set.counts.tests, set.counts.pass + set.counts.fail + set.counts.cancelled + set.counts.skipped + set.counts.todo, 'inconsistent TAP totals');
        for (const key of Object.keys(counts)) counts[key] += set.counts[key];
        reported++; if (!set.ok || set.counts.fail || set.counts.cancelled) failed++;
      } catch (error) { missing++; errors.push(`${wanted.name}: ${error.message}`); }
    }
  }
  const metrics = [
    ...['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => ({ name: key, value: counts[key], unit: 'count' })),
    { name: 'failed sets', value: failed + missing, unit: 'count' },
    { name: 'reported sets', value: reported, unit: 'count' }, { name: 'missing sets', value: missing, unit: 'count' },
    { name: 'report errors', value: errors.length, unit: 'count' },
  ];
  const durations = selected.map(report => report.seconds).filter(value => Number.isFinite(value) && value >= 0);
  if (durations.length) metrics.push({ name: 'pool duration max', value: Math.round(Math.max(...durations)), unit: 's' });
  // Keep duration as a whole-pool wall clock, not a renamed maximum. A carried report
  // would include the human's wait before rerunning; incomplete/mixed runs omit it.
  if (selected.length === plan.shards.length && new Set(selected.map(report => report.attempt)).size === 1 &&
      selected.every(report => integer(report.startedAt) && integer(report.endedAt) && report.endedAt >= report.startedAt)) {
    metrics.push({ name: 'duration', value: Math.round((Math.max(...selected.map(report => report.endedAt)) - Math.min(...selected.map(report => report.startedAt))) / 1000), unit: 's' });
  }
  return { metrics, complete: !missing && !errors.length, errors };
}

export function writeResults(plan, input, options = {}, directory = '.tmp') {
  mkdirSync(directory, { recursive: true });
  rmSync(join(directory, 'unit-balance.json'), { force: true });
  writeFileSync(join(directory, 'unit-summary.json'), JSON.stringify(summarizeReports(plan, input, options), null, 2) + '\n');
  const result = mergeReports(plan, input, options); // Still throws on every incomplete or failed run.
  writeFileSync(join(directory, 'unit-balance.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

// Median ratios remove a runner's broad slowdown before learning relative costs. A patrol must
// still check hardware, source changes and the before/after balance; this produces a reviewable
// candidate, never an automatic edit to CI or the checked-in weights.
export function candidateWeights(plan, balances, weights = loadWeights()) {
  assert.ok(balances.length >= 3, 'use at least three complete comparable runs');
  const checkedBalances = balances.map(balance => mergeReports(plan, balance.reports));
  assert.equal(new Set(checkedBalances.map(balance => balance.runId)).size, balances.length, 'use distinct workflow runs, not repeated files or attempts');
  const values = new Map();
  for (const balance of checkedBalances) {
    assert.equal(balance.counts.skipped + balance.counts.todo, 0, 'weight samples must not omit tests');
    for (const report of balance.reports) {
      const ratios = report.sets.filter(set => Object.hasOwn(weights, set.name) && set.seconds > 0).map(set => set.seconds / weights[set.name]);
      const scale = ratios.length ? median(ratios) : 1;
      for (const set of report.sets) {
        if (!values.has(set.name)) values.set(set.name, []);
        values.get(set.name).push(Math.max(0.01, set.seconds / scale));
      }
    }
  }
  return Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, samples]) => [name, Math.round(median(samples) * 1000) / 1000]));
}

export function readReports(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return readReports(join(directory, entry.name));
    if (!/^unit-shard-\d+\.json$/.test(entry.name)) return [];
    try { return [JSON.parse(readFileSync(join(directory, entry.name), 'utf8'))]; }
    catch { return [{ version: 0, reportError: `${entry.name}: unreadable or invalid JSON` }]; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...paths] = process.argv.slice(2), plan = planShards(discoverSets());
  if (command === 'merge' && paths.length === 1) {
    const result = writeResults(plan, readReports(paths[0]), { revision: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : Infinity });
    const text = ['| Shard | Sets | Tests | Pool seconds | Estimated work | CPU |', '|---|---:|---:|---:|---:|---|',
      ...result.shards.map(shard => `| ${shard.index} | ${shard.sets} | ${shard.tests} | ${shard.seconds.toFixed(1)} | ${shard.estimatedSeconds.toFixed(1)} | ${shard.machine.cpu} |`),
      `\nPool max/min: ${result.balance.ratio?.toFixed(3)}; idle tail: ${(result.balance.idleFraction * 100).toFixed(1)}%\n`].join('\n');
    console.log(text); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  } else if (command === 'weights' && paths.length >= 3) {
    console.log(JSON.stringify(candidateWeights(plan, paths.map(path => JSON.parse(readFileSync(path, 'utf8')))), null, 2));
  } else throw new Error('usage: node test/framework/unit-shards.mjs merge <artifact-directory> | weights <balance.json> <balance.json> <balance.json> [...]');
}
