import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { defaultTestFiles, discoverSets, planShards, loadWeights } from '../../framework/test-plan.mjs';
import { mergeReports, candidateWeights, summarizeReports, writeResults, readReports } from '../../framework/unit-shards.mjs';

function fixture(t) {
  mkdirSync('.tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/shard-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = ['a', 'b', 'c', 'd', 'e'].map(name => {
    const file = join(dir, `${name}.test.mjs`);
    writeFileSync(file, `${['a', 'b'].includes(name) ? '// test-set: shared one resource must remain serial\n' : ''}import { test } from 'node:test'; test('fixture', () => {});\n`);
    return file;
  });
  const weights = { shared: 8, c: 7, d: 4, e: 3 }, sets = discoverSets(files);
  return { dir, files, weights, sets, plan: planShards(sets, 2, weights) };
}

function reports(plan, attempt = 1) {
  return plan.shards.map(shard => ({ version: 1, planHash: plan.hash, corpusHash: plan.corpusHash,
    revision: 'source', runId: 'run', attempt, shard: { index: shard.index, total: plan.shards.length }, jobs: 4,
    seconds: shard.index === 1 ? 10 : 12, startedAt: shard.index * 1000, endedAt: shard.index * 1000 + (shard.index === 1 ? 10 : 12) * 1000,
    machine: { cpu: 'fixture', parallelism: 4, node: 'v22', image: 'test' },
    sets: shard.sets.map(set => ({ name: set.name, files: set.files, ok: true, seconds: set.weight,
      counts: { tests: set.files.length, pass: set.files.length, fail: 0, cancelled: 0, skipped: 0, todo: 0 } })) }));
}

test('weighted planning is deterministic, disjoint and keeps named test sets intact', t => {
  const f = fixture(t), reverse = planShards(discoverSets([...f.files].reverse()), 2, f.weights);
  assert.equal(reverse.hash, f.plan.hash);
  assert.deepEqual(f.plan.shards.map(shard => shard.weight), [11, 11]);
  const selected = f.plan.shards.flatMap(shard => shard.sets.flatMap(set => set.files));
  assert.deepEqual([...selected].sort(), [...f.files].sort());
  assert.equal(new Set(selected).size, selected.length);
  assert.equal(f.plan.shards.flatMap(shard => shard.sets).find(set => set.name === 'shared').files.length, 2);
  assert.throws(() => discoverSets([f.files[0], f.files[0]]), /duplicate/);
  assert.throws(() => discoverSets(['test/service.live.test.mjs']), /real external/);
  assert.throws(() => planShards(f.sets, 0, f.weights), /shard count/);
  assert.throws(() => planShards(f.sets, 5, f.weights), /shard count/);
});

test('new tests get finite estimates and a source edit invalidates old reports', t => {
  const f = fixture(t), file = join(f.dir, 'constructor.test.mjs');
  writeFileSync(file, 'export {};\n');
  const plan = planShards(discoverSets([...f.files, file]), 2, f.weights);
  assert.ok(Number.isFinite(plan.shards.flatMap(shard => shard.sets).find(set => set.name === 'constructor').weight));
  writeFileSync(f.files[0], readFileSync(f.files[0], 'utf8') + '// changed\n');
  const changed = planShards(discoverSets(f.files), 2, f.weights);
  assert.notEqual(changed.corpusHash, f.plan.corpusHash);
  assert.throws(() => mergeReports(changed, reports(f.plan)), /different corpus/);
  const weights = join(f.dir, 'weights.json'); writeFileSync(weights, '{"c":0}');
  assert.throws(() => loadWeights(weights), /positive finite/);
});

test('fan-in sums exact coverage and reports the slower shard and idle tail', t => {
  const { plan } = fixture(t), result = mergeReports(plan, reports(plan), { revision: 'source', runId: 'run', attempt: 1 });
  assert.equal(result.counts.tests, 5); assert.equal(result.counts.pass, 5);
  assert.deepEqual(result.shards.map(shard => shard.sets), [2, 2]);
  assert.equal(result.balance.maximumSeconds, 12);
  assert.equal(result.balance.ratio, 1.2);
  assert.ok(Math.abs(result.balance.idleFraction - 1 / 12) < 1e-12);
});

test('fan-in rejects missing, duplicated, failed, partial and foreign reports', t => {
  const { plan } = fixture(t), good = reports(plan);
  assert.throws(() => mergeReports(plan, good.slice(0, 1)), /missing shard/);
  assert.throws(() => mergeReports(plan, [...good, good[0]]), /duplicate shard/);
  for (const [edit, message] of [
    [r => { r[0].sets.pop(); }, /missing or extra/],
    [r => { r[0].sets[1] = structuredClone(r[0].sets[0]); }, /duplicate test set/],
    [r => { r[0].sets[0].files.push('test/unrun.test.mjs'); }, /membership/],
    [r => { r[0].sets[0].ok = false; }, /failed test set/],
    [r => { delete r[0].sets[0].counts.fail; }, /missing TAP fail/],
    [r => { r[0].sets[0].counts.tests++; }, /inconsistent TAP/],
    [r => { r[0].jobs = 8; }, /worker count/],
    [r => { r[0].revision = 'another'; }, /different runs or revisions/],
    [r => { r[0].planHash = 'another'; }, /different corpus or weights/],
  ]) {
    const changed = structuredClone(good); edit(changed);
    assert.throws(() => mergeReports(plan, changed), message);
  }
  assert.throws(() => mergeReports(plan, good, { revision: 'other' }), /wrong revision/);
  assert.throws(() => mergeReports(plan, good, { runId: 'other' }), /wrong workflow/);
});

test('a failed-only rerun carries a successful old shard but uses the latest attempt of each shard', t => {
  const { plan } = fixture(t), first = reports(plan), second = reports(plan, 2);
  first[1].sets[0].ok = false;
  const result = mergeReports(plan, [...first, second[1]], { attempt: 2 });
  assert.deepEqual(result.shards.map(shard => shard.attempt), [1, 2]);
  second[1].sets[0].ok = false;
  assert.throws(() => mergeReports(plan, [...first, second[1]]), /failed test set/);
  assert.throws(() => mergeReports(plan, reports(plan, 3), { attempt: 2 }), /invalid attempt/);
});

test('failed sets still write accurate Nightly metrics before the gate rejects them', t => {
  const f = fixture(t), rows = reports(f.plan);
  writeResults(f.plan, rows, {}, f.dir);
  assert.ok(existsSync(join(f.dir, 'unit-balance.json')));
  rows[0].sets[0].ok = false;
  rows[0].sets[0].counts.pass--; rows[0].sets[0].counts.fail++;
  assert.throws(() => writeResults(f.plan, rows, {}, f.dir), /failed test set/);
  assert.equal(existsSync(join(f.dir, 'unit-balance.json')), false, 'a previous successful balance report must not survive a failed gate');
  const summary = JSON.parse(readFileSync(join(f.dir, 'unit-summary.json'), 'utf8'));
  const values = Object.fromEntries(summary.metrics.map(metric => [metric.name, metric.value]));
  assert.equal(summary.complete, true);
  assert.equal(values.tests, 5); assert.equal(values.pass, 4); assert.equal(values.fail, 1); assert.equal(values['failed sets'], 1);
  assert.equal(values.duration, 13, 'whole pool spans from 1000 to 14000, not just the 12s slowest shard');
  assert.equal(values['pool duration max'], 12);
});

test('partial and invalid reports expose gaps without inventing unseen test counts', t => {
  const f = fixture(t), rows = reports(f.plan);
  assert.throws(() => writeResults(f.plan, rows.slice(0, 1), {}, f.dir), /missing shard/);
  const summary = JSON.parse(readFileSync(join(f.dir, 'unit-summary.json'), 'utf8'));
  const values = Object.fromEntries(summary.metrics.map(metric => [metric.name, metric.value]));
  assert.equal(summary.complete, false); assert.equal(values.tests, 3); assert.equal(values['missing sets'], 2); assert.equal(values['failed sets'], 2);
  assert.ok(!Object.hasOwn(values, 'duration'));
  const foreign = structuredClone(rows); foreign[0].planHash = 'foreign';
  assert.ok(summarizeReports(f.plan, foreign).errors.length > 0);
  assert.throws(() => mergeReports(f.plan, foreign), /different corpus/);
  const empty = summarizeReports(f.plan, []);
  assert.equal(empty.metrics.find(metric => metric.name === 'missing sets').value, 4);
  const carried = reports(f.plan); carried[1].attempt = 2;
  assert.ok(!summarizeReports(f.plan, carried).metrics.some(metric => metric.name === 'duration'));
});

test('a truncated artifact still preserves metrics from the readable shard and fails the gate', t => {
  const f = fixture(t), rows = reports(f.plan), directory = join(f.dir, 'artifacts');
  mkdirSync(directory); writeFileSync(join(directory, 'unit-shard-1.json'), JSON.stringify(rows[0]));
  writeFileSync(join(directory, 'unit-shard-2.json'), '{');
  const input = readReports(directory);
  assert.throws(() => writeResults(f.plan, input, {}, f.dir), /unsupported shard report/);
  const summary = JSON.parse(readFileSync(join(f.dir, 'unit-summary.json'), 'utf8'));
  assert.equal(summary.metrics.find(metric => metric.name === 'tests').value, 3);
  assert.equal(summary.metrics.find(metric => metric.name === 'missing sets').value, 2);
  assert.match(summary.errors.join(' '), /unit-shard-2.json/);
  assert.deepEqual(readReports(join(directory, 'missing')), []);
});

test('weight candidates need three complete runs and normalize whole-runner slowdowns', t => {
  let id = 0;
  const f = fixture(t), sample = speed => {
    const rows = reports(f.plan);
    id++;
    for (const row of rows) { row.runId = `run-${id}`; for (const set of row.sets) set.seconds *= speed; }
    return mergeReports(f.plan, rows);
  };
  assert.throws(() => candidateWeights(f.plan, [sample(1), sample(1)], f.weights), /at least three/);
  const updated = candidateWeights(f.plan, [sample(1), sample(2), sample(0.5)], f.weights);
  assert.deepEqual(updated, { c: 7, d: 4, e: 3, shared: 8 });
  const repeated = sample(1);
  assert.throws(() => candidateWeights(f.plan, [repeated, repeated, repeated], f.weights), /distinct workflow/);
  const broken = sample(1); broken.reports[0].sets.pop();
  assert.throws(() => candidateWeights(f.plan, [sample(1), sample(1), broken], f.weights), /missing or extra/);
});

async function run(args, env) {
  const child = spawn(process.execPath, ['test/framework/test-sets.mjs', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; child.stdout.on('data', data => chunks.push(data)); child.stderr.on('data', data => chunks.push(data));
  const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  return { code, output: Buffer.concat(chunks).toString() };
}

test('the real runner executes both shards, reports exact coverage and rejects malformed shard arguments', async t => {
  const f = fixture(t), env = { ...process.env, BOT_TEST_JOBS: '4' };
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'BOT_TEST_SHARD', 'BOT_TEST_REPORT', 'BOT_TEST_SUMMARY']) delete env[key];
  const rows = [];
  for (const index of [1, 2]) {
    const path = join(f.dir, `report-${index}.json`), result = await run([...f.files, '--shard', `${index}/2`], { ...env, BOT_TEST_REPORT: path });
    assert.equal(result.code, 0, result.output);
    rows.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  const actual = planShards(f.sets);
  assert.equal(mergeReports(actual, rows).counts.pass, 5);
  for (const value of ['0/2', '3/2', '1/0', '1/99', 'bad', '']) {
    const result = await run([...f.files, '--shard', value], env);
    assert.equal(result.code, 2, result.output);
  }
  const missing = await run([...f.files, '--shard'], env); assert.equal(missing.code, 2);
  // Exercise an actual failed node:test process, not only a hand-written failed report.
  writeFileSync(f.files[0], "// test-set: shared one resource must remain serial\nimport {test} from 'node:test'; test('expected failure',()=>{throw new Error('fixture failure');});\n");
  const failedRows = [];
  for (const index of [1, 2]) {
    const path = join(f.dir, `failed-${index}.json`);
    const result = await run([...f.files, '--shard', `${index}/2`], { ...env, BOT_TEST_REPORT: path });
    const report = JSON.parse(readFileSync(path, 'utf8')); failedRows.push(report);
    assert.equal(result.code, report.sets.some(set => !set.ok) ? 1 : 0, result.output);
  }
  assert.throws(() => writeResults(planShards(discoverSets(f.files)), failedRows, {}, f.dir), /failed test set/);
  const summary = JSON.parse(readFileSync(join(f.dir, 'unit-summary.json'), 'utf8'));
  assert.equal(summary.metrics.find(metric => metric.name === 'fail').value, 1);
  assert.equal(summary.metrics.find(metric => metric.name === 'pass').value, 4);
});

test('the workflow keeps the unit gate dependent on two four-worker shards and preserves failure evidence', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/checks.yml', import.meta.url), 'utf8'));
  for (const event of ['pull_request', 'merge_group', 'workflow_call']) assert.ok(Object.hasOwn(workflow.on, event));
  const shard = workflow.jobs['unit-shards'], gate = workflow.jobs.unit;
  assert.deepEqual(shard.strategy.matrix.shard, [1, 2]); assert.equal(shard.strategy['fail-fast'], false);
  const step = shard.steps.find(step => step.run?.includes('npm test'));
  assert.equal(step.env.BOT_TEST_JOBS, '4'); assert.equal(step.env.BOT_REQUIRE_PI, '1');
  assert.equal(step.env.BOT_TEST_SHARD, '${{ matrix.shard }}/2');
  assert.equal(gate.name, 'unit'); assert.equal(gate.needs, 'unit-shards'); assert.match(gate.if, /always\(\)/);
  assert.ok(gate.steps.some(step => step.run === 'node test/framework/unit-shards.mjs merge .tmp/unit-shards'));
  assert.equal(gate.steps.find(step => step.run === 'node test/framework/unit-shards.mjs merge .tmp/unit-shards').if, 'always()');
  assert.ok(gate.steps.some(step => step.env?.SHARD_RESULT === '${{ needs.unit-shards.result }}' && step.run.includes('= success')));
  assert.ok(shard.steps.some(step => step.if === 'always()' && step.with?.name?.includes('github.run_attempt')));
  assert.ok(gate.steps.some(step => step.with?.name === 'unit-summary'));
  const uploads = [...shard.steps, ...gate.steps].filter(step => step.uses?.startsWith('actions/upload-artifact@') && step.with?.path?.startsWith('.tmp/unit-'));
  assert.equal(uploads.length, 3, 'both shard reports, the balance report and the Nightly summary must be configured');
  for (const step of uploads) assert.equal(step.with['include-hidden-files'], true, 'the explicit JSON reports under .tmp must upload');
});

test('recursive discovery scans nested ut and st tiers, skips live/docker/acceptance, preserves weights and rejects duplicate basenames', t => {
  mkdirSync('.tmp', { recursive: true });
  const root = mkdtempSync('.tmp/nested-discovery-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const sub of ['ut/src/board', 'st/src/tasks', 'live/tasks', 'docker/projects', 'acceptance'])
    mkdirSync(join(root, sub), { recursive: true });
  writeFileSync(join(root, 'ut/src/board/board.test.mjs'), "import { test } from 'node:test'; test('ut', () => {});\n");
  writeFileSync(join(root, 'st/src/tasks/tasks.test.mjs'), "import { test } from 'node:test'; test('st', () => {});\n");
  writeFileSync(join(root, 'ut/src/board/skip.live.test.mjs'), "import { test } from 'node:test'; test('live', () => {});\n");
  writeFileSync(join(root, 'live/tasks/probe.test.mjs'), "import { test } from 'node:test'; test('outside', () => {});\n");
  const discovered = defaultTestFiles(root);
  assert.deepEqual(discovered, [
    `${root}/st/src/tasks/tasks.test.mjs`,
    `${root}/ut/src/board/board.test.mjs`,
  ]);
  const sets = discoverSets(discovered);
  assert.deepEqual(sets.map(set => set.name), ['tasks', 'board']);
  const planned = planShards(sets, 2, { board: 7, tasks: 21 });
  writeFileSync(join(root, 'stray.test.mjs'), "import { test } from 'node:test'; test('stray', () => {});\n");
  assert.throws(() => defaultTestFiles(root), /place \*\.test\.mjs files under/);
  rmSync(join(root, 'stray.test.mjs'));
  assert.equal(planned.shards.flatMap(s => s.sets).find(s => s.name === 'board').weight, 7);
  assert.equal(planned.shards.flatMap(s => s.sets).find(s => s.name === 'tasks').weight, 21);

  writeFileSync(join(root, 'st/src/tasks/board.test.mjs'), "import { test } from 'node:test'; test('collision', () => {});\n");
  assert.throws(() => discoverSets(defaultTestFiles(root)), /duplicate test-set name "board"/);
});
