import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { publicBoardFixture } from './public-board-fixtures.mjs';

// #938: what scheduled CI runs report about themselves becomes named numbers on the repository board, from check run
// tables, JUnit or simple JSON artifacts, or else only the jobs. Nothing names a repository, workflow or artifact.

// Runs the board's own Python parser (public-board/single-repo/gsb/results.py) on the given inputs.
const python = (script, input) => JSON.parse(execFileSync('python3', ['-c', `import sys, json, base64\nsys.path.insert(0, ${JSON.stringify(resolve('public-board/single-repo'))})\nfrom gsb import results\n${script}`],
  { input: JSON.stringify(input), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).toString());
// A zip archive of the given files, built by Python's zipfile like the artifacts GitHub serves.
const zip = files => Buffer.from(python('files = json.load(sys.stdin)\nimport io, zipfile\nout = io.BytesIO()\nwith zipfile.ZipFile(out, "w") as z:\n    [z.writestr(name, body) for name, body in files.items()]\nprint(json.dumps(base64.b64encode(out.getvalue()).decode()))', files), 'base64');

test('tables, JUnit and the simple JSON format become metrics deterministically; anything else is ignored', () => {
  const metrics = python('print(json.dumps(results.table_metrics(json.load(sys.stdin))))', [
    '## Nightly', '', '| tests | pass | **fail** | duration | coverage |', '|---|---:|---|---|---|', '| 1,204 | 1,200 | 4 | 95.5s | 81.2% |', '',
    'Text between tables.', '', '| suite | tests | time |', '| :-- | --: | -- |', '| `unit` | 900 | 60 s |', '| e2e | 304 | [12 min](https://x) |', '| notes | n/a | — |',
  ].join('\n'));
  assert.deepEqual(metrics, [
    { name: 'tests', value: 1204, unit: '' }, { name: 'pass', value: 1200, unit: '' }, { name: 'fail', value: 4, unit: '' },
    { name: 'duration', value: 95.5, unit: 's' }, { name: 'coverage', value: 81.2, unit: '%' },
    { name: 'unit · tests', value: 900, unit: '' }, { name: 'unit · time', value: 60, unit: 's' },
    { name: 'e2e · tests', value: 304, unit: '' }, { name: 'e2e · time', value: 12, unit: 'min' },
  ]);
  assert.deepEqual(python('print(json.dumps(results.table_metrics(json.load(sys.stdin))))', 'No table here.\n| just a pipe |'), []);

  const junit = python('print(json.dumps(results.junit_metrics(json.load(sys.stdin).encode())))',
    '<testsuites><testsuite name="a" tests="3" failures="1" errors="0" skipped="1" time="1.5"/><testsuite name="b" tests="2" failures="0" errors="1" time="2"/></testsuites>');
  assert.deepEqual(junit.map(m => [m.name, m.value, m.unit]), [['tests', 5, 'count'], ['failures', 1, 'count'], ['errors', 1, 'count'], ['skipped', 1, 'count'], ['time', 3.5, 's']]);
  assert.deepEqual(python('print(json.dumps(results.junit_metrics(json.load(sys.stdin).encode())))', '<html><body/></html>'), []);

  const simple = python('print(json.dumps(results.json_metrics(json.load(sys.stdin))))', JSON.stringify({ metrics: [
    { name: 'tests', value: 10, unit: 'count' }, { name: 'duration', value: 61 , unit: 's' }, { name: '', value: 1 }, { name: 'flag', value: true }, { name: 'text', value: '3' }] }));
  assert.deepEqual(simple, [{ name: 'tests', value: 10, unit: 'count' }, { name: 'duration', value: 61, unit: 's' }]);

  // One artifact with a JUnit report and a summary: each file's stem keeps their names apart. Other files are skipped.
  const archive = zip({ 'reports/unit.xml': '<testsuite tests="4" failures="0" errors="0" skipped="0" time="2"/>', 'summary.json': JSON.stringify({ metrics: [{ name: 'tests', value: 4 }] }),
    'broken.json': '{', 'notes.txt': 'tests: 4' });
  const fromArtifact = python('print(json.dumps(results.artifact_metrics(base64.b64decode(json.load(sys.stdin)))))', archive.toString('base64'));
  assert.deepEqual(fromArtifact.map(m => m.name), ['unit · tests', 'unit · failures', 'unit · errors', 'unit · skipped', 'unit · time', 'summary · tests']);
});

test('the board charts what scheduled runs reported, read once with the read-only token, and leaves other runs alone', async t => {
  const { boards, state, hook, get } = await publicBoardFixture(t);
  const at = days => new Date(Date.now() - days * 86400_000).toISOString();
  const run = (id, event, conclusion, days, suite) => ({ id, name: 'Nightly', workflow_id: 30, event, status: 'completed', conclusion, head_branch: 'main', head_sha: String(id).repeat(10).slice(0, 40),
    run_attempt: 1, created_at: at(days), run_started_at: at(days), updated_at: new Date(Date.parse(at(days)) + 600_000).toISOString(), check_suite_id: suite, html_url: `https://github.com/octo/hello/actions/runs/${id}`, pull_requests: [] });
  state.extraRuns = [run(950, 'schedule', 'success', 3, 7001), run(951, 'workflow_dispatch', 'success', 2, 7002), run(952, 'schedule', 'failure', 1, 7003),
    { ...run(953, 'push', 'success', 1, 7004), name: 'Build', workflow_id: 31 }];
  // 950 reports a table in a check run of its suite; 951 uploads a JSON summary and a JUnit report; 952 has only its jobs.
  state.checkRuns[7001] = [{ id: 1, name: 'unit', output: { title: 'Unit', summary: '| tests | pass | fail | duration |\n|---|---|---|---|\n| 120 | 118 | 2 | 95.5s |', text: null } }];
  state.checkRuns[7004] = [{ id: 2, name: 'build', output: { summary: '| tests |\n|---|\n| 1 |' } }];
  state.artifacts[951] = [{ id: 61, name: 'unit-summary', size_in_bytes: 300, expired: false }, { id: 62, name: 'e2e-junit', size_in_bytes: 300, expired: false },
    { id: 63, name: 'huge-trace', size_in_bytes: 500 * 1024 * 1024, expired: false }, { id: 64, name: 'gone', size_in_bytes: 300, expired: true }];
  state.blobs[61] = zip({ 'unit-summary.json': JSON.stringify({ metrics: [{ name: 'tests', value: 130, unit: 'count' }, { name: 'duration', value: 100, unit: 's' }] }) });
  state.blobs[62] = zip({ 'e2e-junit.xml': '<testsuites tests="40" failures="1" errors="0" skipped="2" time="300"/>' });
  state.jobs[952] = [{ name: 'unit', status: 'completed', conclusion: 'failure', started_at: at(1), completed_at: new Date(Date.parse(at(1)) + 120_000).toISOString(), steps: [{ name: 'npm test', conclusion: 'failure' }] }];

  await hook('scheduled'); await boards.drain();
  const snapshot = (await get('/boards/octo/hello/data/snapshot.json')).data;
  const [nightly, ...others] = snapshot.sections.scheduled.data.workflows;
  assert.deepEqual(others, [], 'only the workflow that runs on a schedule is a scheduled workflow');
  assert.equal(nightly.name, 'Nightly');
  assert.deepEqual(nightly.runs.map(r => [r.id, r.event, r.conclusion, r.source]),
    [[950, 'schedule', 'success', 'check_run'], [951, 'workflow_dispatch', 'success', 'artifact'], [952, 'schedule', 'failure', 'jobs']]);
  assert.deepEqual(nightly.runs[0].metrics, { tests: 120, pass: 118, fail: 2, duration: 95.5 });
  assert.deepEqual(nightly.runs[1].metrics, { 'e2e-junit · tests': 40, 'e2e-junit · failures': 1, 'e2e-junit · errors': 0, 'e2e-junit · skipped': 2, 'e2e-junit · time': 300,
    'unit-summary · tests': 130, 'unit-summary · duration': 100 });
  assert.deepEqual(nightly.runs[2].metrics, {});
  assert.deepEqual(nightly.runs[2].jobs, [{ name: 'unit', conclusion: 'failure', duration_s: 120 }]);
  // The metric names a person picks from, newest run first, with their units.
  assert.deepEqual(nightly.metrics.slice(0, 2), [{ name: 'e2e-junit · tests', unit: 'count' }, { name: 'e2e-junit · failures', unit: 'count' }]);
  assert.ok(nightly.metrics.some(m => m.name === 'duration' && m.unit === 's'));
  // The workflow table names the job that failed and the duration spread.
  const workflow = snapshot.sections.ci.data.workflows.find(w => w.name === 'Nightly');
  assert.deepEqual(workflow.top_failed_jobs, [{ name: 'unit', count: 1 }]);
  assert.ok('p90_duration_s' in workflow.all);

  // Reads: the run that is not scheduled is never inspected, oversized and expired artifacts are never downloaded,
  // and the token asked for Checks read alongside the other read permissions.
  const paths = state.requests.map(r => r.path);
  assert.ok(!paths.some(p => p.includes('/check-suites/7004/')), 'the push run is not inspected');
  assert.ok(!paths.some(p => /\/actions\/artifacts\/(63|64)\/zip$/.test(p)));
  assert.ok(state.requests.filter(r => r.path.endsWith('/access_tokens')).every(r => r.body.permissions.checks === 'read' && Object.values(r.body.permissions).every(p => p === 'read')));

  // A second collection reads nothing again for runs whose result is known.
  const before = state.requests.length;
  await hook('again'); await boards.drain();
  assert.ok(!state.requests.slice(before).some(r => /check-suites|\/artifacts/.test(r.path)), JSON.stringify(state.requests.slice(before).map(r => r.path)));
});
