import test from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../../../../dist/agent/common.js';
import { CallIdentities, maskCommandCredentials, progressText, serviceProgressReader, ProgressBudget } from '../../../../dist/harness/service-progress.js';

// A Pi turn's progress (#1296) is shown to people: credentials written out on a command line never reach it.
test('credentials named on a command line are masked, and ordinary commands are left alone', () => {
  const cases = [
    ['GH_TOKEN=abc123secret gh pr list', 'GH_TOKEN=[REDACTED] gh pr list'],
    ['export OPENAI_API_KEY="sk live value"', 'export OPENAI_API_KEY=[REDACTED]'],
    ['mysql --password=hunter2-x --user root', 'mysql --password=[REDACTED] --user root'],
    ['tool --api-key s3cret run', 'tool --api-key [REDACTED] run'],
    ['curl -H "Authorization: Bearer abc.def.ghi" https://x', 'curl -H "Authorization: Bearer [REDACTED]" https://x'],
    ["curl -H 'X-Api-Key: k-123' https://x", "curl -H 'X-Api-Key: [REDACTED]' https://x"],
    ['git clone https://bot:pa55word@github.com/o/r.git', 'git clone https://[REDACTED]@github.com/o/r.git'],
    ['curl -su admin:pa55word-1; echo ok', 'curl -su [REDACTED]; echo ok'],
    ['curl -u admin:pa55word-1; echo ok', 'curl -u [REDACTED]; echo ok'],
    ['password: hunter2', 'password: [REDACTED]'],
  ];
  for (const [input, expected] of cases) assert.equal(maskCommandCredentials(input), expected, input);
  // A variable reference is not a secret, and ordinary words that only contain a credential name stay as written.
  for (const plain of ['GH_TOKEN=$TOKEN gh api /user', 'hdc list targets', 'git log --author=alice', 'max_tokens=512 node run.js', 'grep -rn tokenize src'])
    assert.equal(maskCommandCredentials(plain), plain, plain);
});

test('progress text also masks token formats and the known values of the turn and the deployment, in any encoding', () => {
  const turn = new Redactor(), deployment = new Redactor();
  turn.add('turn-secret-0001'); deployment.add('deploy/secret value');
  const token = 'ghp_' + 'A'.repeat(36);
  const text = progressText(`echo ${token} turn-secret-0001 ${encodeURIComponent('deploy/secret value')}`, [turn, deployment]);
  assert.equal(text, 'echo [REDACTED] [REDACTED] [REDACTED]');
});

test('native tool events become bounded steps; other tools and events are not progress', () => {
  let clock = 1000;
  const read = serviceProgressReader(text => maskCommandCredentials(text), () => clock);
  const long = 'echo ' + 'x'.repeat(400);
  assert.deepEqual(read({ type: 'tool', phase: 'started', name: 'bash', call_id: 'c1', arguments: { command: '\n  API_TOKEN=s3cret ./deploy.sh\nrm -rf build\n' } }),
    { kind: 'tool_started', call_id: 'c1', name: 'bash', preview: 'API_TOKEN=[REDACTED] ./deploy.sh …' });
  const preview = read({ type: 'tool', phase: 'started', name: 'bash', call_id: 'c2', arguments: { command: long } }).preview;
  assert.equal(Array.from(preview).length, 160); assert.ok(preview.endsWith('…'));
  assert.equal(read({ type: 'tool', phase: 'started', name: 'grep', call_id: 'c3', arguments: { pattern: 'TODO', path: 'src' } }).preview, 'TODO · src');
  assert.equal(read({ type: 'tool', phase: 'started', name: 'ls', call_id: 'c4', arguments: {} }).preview, '.');
  assert.equal(read({ type: 'tool', phase: 'started', name: 'write', call_id: 'c5', arguments: { path: 'notes.md', content: 'private body' } }).preview, 'notes.md');

  // A failed command: its exit code, Pi's own duration, and only the last lines of its output.
  // Pi appends two blank lines and the status; a blank run takes one line of the tail.
  const output = Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n') + '\n\n\npassword=hunter2\n\n\nCommand exited with code 3';
  const ended = read({ type: 'tool', phase: 'completed', name: 'bash', call_id: 'c1', isError: true, duration_ms: 1234.4, result: { content: [{ type: 'text', text: output }] } });
  assert.deepEqual({ ...ended, tail: undefined }, { kind: 'tool_finished', call_id: 'c1', name: 'bash', state: 'failed', duration_ms: 1234, exit_code: 3, tail: undefined });
  assert.equal(ended.tail, 'line 39\n\npassword=[REDACTED]\n\nCommand exited with code 3');
  const quiet = read({ type: 'tool', phase: 'completed', name: 'bash', call_id: 'c6', isError: true, result: { content: [{ type: 'text', text: '\n\n\nCommand exited with code 1' }] } });
  assert.equal(quiet.tail, 'Command exited with code 1');
  // An older runner sends no duration: it is measured from when the call was seen to start.
  clock = 4000;
  const measured = read({ type: 'tool', phase: 'completed', name: 'grep', call_id: 'c3', isError: false, result: { content: [{ type: 'text', text: 'src/a.ts:1: TODO' }] } });
  assert.deepEqual(measured, { kind: 'tool_finished', call_id: 'c3', name: 'grep', state: 'succeeded', duration_ms: 3000 });
  // A long output keeps a bounded tail.
  const huge = read({ type: 'tool', phase: 'completed', name: 'bash', call_id: 'c2', isError: false, result: { content: [{ type: 'text', text: 'y'.repeat(100000) }], structuredContent: { exit_code: 0 } } });
  assert.equal(huge.exit_code, 0); assert.ok(Array.from(huge.tail).length <= 300);

  assert.deepEqual(read({ type: 'model_start', step: 2 }), { kind: 'model_step', step: 2 });
  assert.deepEqual(read({ type: 'compaction', phase: 'started', reason: 'threshold' }), { kind: 'notice', notice: 'compacting' });
  assert.deepEqual(read({ type: 'compaction', phase: 'completed', reason: 'overflow', failed: true }), { kind: 'notice', notice: 'compaction_failed' });
  assert.deepEqual(read({ type: 'compaction', phase: 'completed', reason: 'threshold', failed: false }), { kind: 'notice', notice: 'compacted' });
  // The platform's own tools report themselves; a model event or text is not a step.
  for (const event of [{ type: 'tool', phase: 'started', name: 'management_query' }, { type: 'tool_start', name: 'run_command' }, { type: 'model', step: 1 }, { type: 'text_delta', text: 'hi' }, { type: 'ended' }])
    assert.equal(read(event), undefined, JSON.stringify(event));
});

test('the progress budget allows a burst, then one step per interval, at most a cap a turn, and never cuts a tool in half', () => {
  let clock = 0;
  const budget = new ProgressBudget(3, 1000, 5, () => clock);
  const start = id => ({ kind: 'tool_started', call_id: id, name: 'bash' }), end = id => ({ kind: 'tool_finished', call_id: id, name: 'bash', state: 'succeeded' });
  assert.deepEqual(['a', 'b', 'c', 'd'].map(id => budget.admit(start(id))), [true, true, true, false]);
  // Every admitted start is followed by its end; the end of a skipped one is skipped too.
  assert.deepEqual(['a', 'b', 'c', 'd'].map(id => budget.admit(end(id))), [true, true, true, false]);
  assert.equal(budget.skipped(), 1); assert.equal(budget.skipped(), 0);
  clock = 1000; assert.equal(budget.admit({ kind: 'model_step', step: 2 }), true);
  assert.equal(budget.admit(start('e')), false, 'one step per interval');
  clock = 2000; assert.equal(budget.admit(start('f')), true);
  clock = 60000; assert.equal(budget.admit(start('g')), false, 'the turn cap holds whatever the time');
  assert.equal(budget.admit(end('f')), true);
  assert.equal(budget.admit({ kind: 'notice', notice: 'compacting' }), true, 'notices are rare and always pass');
  assert.equal(budget.skipped(), 2);
});

// #1313: the console pairs a tool call with its own result by an identity made per invocation. Pi may reuse its own
// call id in a later step of the same turn, so that id must never become the pairing key.
test('a reused Pi call id still gets one console identity per invocation', () => {
  let n = 0; const ids = new CallIdentities(() => 'call-' + ++n);
  const first = ids.start('pi-1'); assert.equal(ids.finish('pi-1'), first);
  const second = ids.start('pi-1'); assert.notEqual(second, first, 'the same Pi id must not reconnect two invocations');
  assert.equal(ids.finish('pi-1'), second);
  const orphan = ids.finish('pi-unknown'); assert.ok(orphan && orphan !== first && orphan !== second, 'a finish without a start gets its own identity');
});
