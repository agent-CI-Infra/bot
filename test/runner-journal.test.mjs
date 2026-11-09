import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pruneJournal, journalRetentionMs, runningRetentionMs } from '../runner/journal.mjs';

const id = () => randomBytes(24).toString('hex');
test('journal pruning removes records older than a day and keeps a command still recorded as running for a week', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now(), day = (now - journalRetentionMs - 60_000) / 1000, week = (now - runningRetentionMs - 60_000) / 1000;
  const file = (name, content, time) => { writeFileSync(join(dir, name), content); if (time) utimesSync(join(dir, name), time, time); return name; };
  const done = id(), quiet = id(), stale = id(), orphan = id(), fresh = id(), tmp = id(), folder = id() + '.json';
  file(done + '.json', '{"state":"completed","result":{"ok":true}}', day);
  file(tmp + '.json.tmp', '{}', day);
  // A command that has printed nothing for a day keeps its record and output; a record left running for a week goes.
  file(quiet + '.json', '{"state":"running"}', day); file(quiet + '.out', 'still running', day);
  file(stale + '.json', '{"state":"running"}', week);
  file(orphan + '.out', 'left by a stopped container', day);
  file(fresh + '.json', '{"state":"completed","result":{}}');
  file('notes.txt', 'not a journal record', day); mkdirSync(join(dir, folder));
  assert.deepEqual(await pruneJournal(dir, { now }), { removed: 4, kept: 5 });
  assert.deepEqual(readdirSync(dir).sort(), [fresh + '.json', quiet + '.json', quiet + '.out', 'notes.txt', folder].sort());
  assert.deepEqual(await pruneJournal(join(dir, 'missing')), { removed: 0, kept: 0 });
});
