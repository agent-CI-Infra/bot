import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, merge3WayBuffers, merge3WayText, splitLinesPreserve } from '../../../../dist/sync/merge3.js';

test('splitLinesPreserve round-trips LF, CRLF, no trailing newline, and empty text', () => {
  for (const sample of ['', 'single', 'a\nb\n', 'a\r\nb\r\nc', '\n\n', 'line1\nline2']) {
    assert.equal(splitLinesPreserve(sample).join(''), sample);
  }
});

test('merge3WayText auto-merges disjoint paragraph edits cleanly', () => {
  const base = [
    '# Project Notes',
    '',
    '## Section A',
    'alpha original',
    '',
    '## Section B',
    'beta original',
    '',
    '## Section C',
    'gamma original',
    '',
  ].join('\n');

  const current = base.replace('alpha original', 'alpha edited by server\nalpha extra line');
  const local = base.replace('gamma original', 'gamma edited by client');

  const res = merge3WayText(base, current, local);
  assert.equal(res.conflict, false);
  assert.equal(res.hunks.length, 0);
  assert.equal(res.conflictMarkers, null);
  assert.match(res.merged, /alpha edited by server\nalpha extra line/);
  assert.match(res.merged, /beta original/);
  assert.match(res.merged, /gamma edited by client/);
});

test('merge3WayText merges adjacent disjoint lines and convergent same-line edits cleanly', () => {
  const base = 'line1\nline2\nline3\n';
  const current = 'line1-server\nline2\nline3\n';
  const local = 'line1\nline2-client\nline3\n';
  const res = merge3WayText(base, current, local);
  assert.equal(res.conflict, false);
  assert.equal(res.merged, 'line1-server\nline2-client\nline3\n');

  // Identical concurrent edit on the same line converges cleanly.
  const sameEdit = merge3WayText(base, 'line1-both\nline2\nline3\n', 'line1-both\nline2\nline3\n');
  assert.equal(sameEdit.conflict, false);
  assert.equal(sameEdit.merged, 'line1-both\nline2\nline3\n');

  // Convergent edit on one line plus disjoint edit on another line.
  const mixed = merge3WayText(base, 'line1-both\nline2-server\nline3\n', 'line1-both\nline2\nline3-client\n');
  assert.equal(mixed.conflict, false);
  assert.equal(mixed.merged, 'line1-both\nline2-server\nline3-client\n');

  // Convergent edit on line 1 followed by delete-vs-modify on line 2 MUST still conflict.
  const delAfterConv = merge3WayText('line1\nline2\n', 'line1-both\n', 'line1-both\nline2-edited\n');
  assert.equal(delAfterConv.conflict, true);
});

test('merge3WayText reports true same-line and same-point insertion conflicts with diff3 markers and hunks', () => {
  const base = 'title\nshared-line\nfooter\n';
  const current = 'title\nserver-version\nfooter\n';
  const local = 'title\nclient-version\nfooter\n';

  const res = merge3WayText(base, current, local);
  assert.equal(res.conflict, true);
  assert.equal(res.hunks.length, 1);
  assert.equal(res.hunks[0].base_start_line, 2);
  assert.equal(res.hunks[0].base, 'shared-line\n');
  assert.equal(res.hunks[0].current, 'server-version\n');
  assert.equal(res.hunks[0].local, 'client-version\n');
  assert.ok(res.conflictMarkers);
  assert.match(res.conflictMarkers, /<<<<<<< current/);
  assert.match(res.conflictMarkers, /server-version/);
  assert.match(res.conflictMarkers, /\|\|\|\|\|\|\| base/);
  assert.match(res.conflictMarkers, /shared-line/);
  assert.match(res.conflictMarkers, /client-version/);
  assert.match(res.conflictMarkers, />>>>>>> local/);

  // Concurrent divergent appends at EOF (same insertion index).
  const appendConflict = merge3WayText('line1\n', 'line1\nfrom-server\n', 'line1\nfrom-client\n');
  assert.equal(appendConflict.conflict, true);
  assert.equal(appendConflict.hunks.length, 1);
});

test('merge3WayText handles overlapping multi-line edits and delete-vs-edit conflicts', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const current = 'a\nB1\nC1\nd\ne\n';
  const local = 'a\nb\nC2\nD2\ne\n';
  const overlap = merge3WayText(base, current, local);
  assert.equal(overlap.conflict, true);
  assert.equal(overlap.hunks.length, 1);
  assert.equal(overlap.hunks[0].base, 'b\nc\nd\n');
  assert.equal(overlap.hunks[0].current, 'B1\nC1\nd\n');
  assert.equal(overlap.hunks[0].local, 'b\nC2\nD2\n');

  // Delete lines 2-3 on server while client edits line 2.
  const delEdit = merge3WayText(base, 'a\nd\ne\n', 'a\nB-local\nc\nd\ne\n');
  assert.equal(delEdit.conflict, true);
});

test('merge3WayBuffers rejects conflicting binary edits while fast-forwarding clean binary updates', () => {
  const base = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const current = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
  const local = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x03]);

  const conflict = merge3WayBuffers(base, current, local);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.binary, true);
  assert.equal(conflict.reason, 'binary_conflict');
  assert.equal(conflict.merged, null);

  // Fast-forward when server matches base.
  const ff = merge3WayBuffers(base, base, local);
  assert.equal(ff.conflict, false);
  assert.deepEqual(ff.merged, local);

  // Convergent identical binary update.
  const same = merge3WayBuffers(base, current, Buffer.from(current));
  assert.equal(same.conflict, false);
  assert.deepEqual(same.merged, current);
});

test('diffLines trims common prefix/suffix and handles large inserts cleanly', () => {
  const base = Array.from({ length: 100 }, (_, i) => `line-${i}\n`);
  const target = [...base];
  target.splice(50, 1, 'line-50-updated\n', 'line-50-extra\n');
  const edits = diffLines(base, target);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].baseStart, 50);
  assert.equal(edits[0].baseEnd, 51);
  assert.deepEqual(edits[0].lines, ['line-50-updated\n', 'line-50-extra\n']);
});
