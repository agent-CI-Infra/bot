import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../../dist/storage/database.js';
import {
  beginConsolidationRun,
  consolidationDefaults,
  consolidationSettings,
  consolidationStaggerKey,
  consolidationStorage,
  evaluateConsolidationWindow,
  finishConsolidationRun,
  getConsolidationState,
  hasNightlyRunForDay,
  interruptConsolidationRuns,
  isConsolidationEnabledForScope,
  pruneConsolidationRuns,
  saveConsolidationScopeConfig,
  saveConsolidationSettings,
} from '../../../../dist/memory/consolidation-storage.js';
import {
  AssistantHomes,
  isMemorySubpath,
  normalizeAssistantMemoryPath,
} from '../../../../dist/service-roles/assistant-computers.js';
import { Notes } from '../../../../runner/notes.mjs';

test('consolidation defaults are enabled and window evaluator handles same-day and overnight windows', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 1));
  try {
    consolidationStorage(store);
    const defaults = consolidationSettings(store);
    assert.deepEqual(defaults, consolidationDefaults);
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.window_start, '02:00');
    assert.equal(defaults.window_end, '05:00');
    assert.equal(defaults.timezone, 'Asia/Shanghai');
    assert.equal(defaults.max_concurrency, 2);

    // Same-day window 02:00-05:00 Asia/Shanghai (UTC+8)
    assert.deepEqual(
      evaluateConsolidationWindow(Date.parse('2026-06-15T18:00:00Z'), defaults), // 02:00 CST on 2026-06-16
      { inWindow: true, logicalDay: '2026-06-16' },
    );
    assert.deepEqual(
      evaluateConsolidationWindow(Date.parse('2026-06-15T20:59:00Z'), defaults), // 04:59 CST on 2026-06-16
      { inWindow: true, logicalDay: '2026-06-16' },
    );
    assert.deepEqual(
      evaluateConsolidationWindow(Date.parse('2026-06-15T21:00:00Z'), defaults), // 05:00 CST on 2026-06-16
      { inWindow: false, logicalDay: '2026-06-16' },
    );

    // Overnight wrap window 23:00-04:00 Asia/Shanghai assigns pre-midnight and post-midnight to same logical day
    const wrap = { window_start: '23:00', window_end: '04:00', timezone: 'Asia/Shanghai' };
    assert.deepEqual(
      evaluateConsolidationWindow(Date.parse('2026-06-15T15:30:00Z'), wrap), // 23:30 CST on 2026-06-15
      { inWindow: true, logicalDay: '2026-06-15' },
    );
    assert.deepEqual(
      evaluateConsolidationWindow(Date.parse('2026-06-15T18:30:00Z'), wrap), // 02:30 CST on 2026-06-16
      { inWindow: true, logicalDay: '2026-06-15' },
    );
    assert.deepEqual(
      evaluateConsolidationWindow(Date.parse('2026-06-16T02:00:00Z'), wrap), // 10:00 CST on 2026-06-16
      { inWindow: false, logicalDay: '2026-06-16' },
    );

    // Deterministic stagger hash varies across days and scopes
    assert.equal(
      consolidationStaggerKey('2026-06-15', 'project', '101'),
      consolidationStaggerKey('2026-06-15', 'project', '101'),
    );
    assert.notEqual(
      consolidationStaggerKey('2026-06-15', 'project', '101'),
      consolidationStaggerKey('2026-06-16', 'project', '101'),
    );
  } finally {
    store.close();
  }
});

test('consolidation storage validates settings, deduplicates nightly runs per logical day, interrupts stale runs and prunes history', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 2));
  try {
    consolidationStorage(store);
    assert.throws(() => saveConsolidationSettings(store, 'u1', { window_start: '03:00', window_end: '03:00' }), { code: 'invalid_consolidation_window' });
    assert.throws(() => saveConsolidationSettings(store, 'u1', { timezone: 'Invalid/Timezone' }), { code: 'invalid_consolidation_timezone' });
    assert.throws(() => saveConsolidationSettings(store, 'u1', { max_concurrency: 99 }), { code: 'invalid_consolidation_concurrency' });

    // Project-owned model cannot be used as global consolidation model
    store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
    store.run("INSERT INTO repositories VALUES('101','fixture/p1','10','a')");
    store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('pm1','101','https://m.test/v1','proj-m',?,'now')",
      store.secrets.seal({ value: 'sk-proj' }, 'model:pm1'));
    store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('sm1',NULL,'https://m.test/v1','shared-m',?,'now')",
      store.secrets.seal({ value: 'sk-shared' }, 'model:sm1'));

    assert.throws(() => saveConsolidationSettings(store, 'u1', { model_id: 'pm1' }), { code: 'shared_model_required' });
    const saved = saveConsolidationSettings(store, 'u1', { enabled: false, window_start: '01:00', window_end: '04:00', timezone: 'UTC', max_concurrency: 4, model_id: 'sm1' });
    assert.equal(saved.enabled, false);
    assert.equal(saved.model_id, 'sm1');

    // Scope override beats global enabled flag
    assert.equal(isConsolidationEnabledForScope(store, 'project', '101'), false);
    saveConsolidationScopeConfig(store, 'project', '101', { enabled_override: true }, 'u1', '101');
    assert.equal(isConsolidationEnabledForScope(store, 'project', '101'), true);

    // Nightly run deduplication per logical day
    const r1 = beginConsolidationRun(store, {
      scope_kind: 'project', scope_id: '101', logical_day: '2026-06-15', trigger: 'nightly', model_id: 'sm1',
      started_at: '2026-06-15T02:00:00Z',
    });
    assert.ok(r1);
    assert.equal(hasNightlyRunForDay(store, 'project', '101', '2026-06-15'), true);

    // Startup interruption recovery closes stale running rows
    assert.equal(interruptConsolidationRuns(store, '2026-06-15T02:05:00Z'), 1);
    assert.equal(getConsolidationState(store, 'project', '101').last_status, 'failed');

    // Second nightly attempt on same logical day is rejected (returns null) so failed run does not spam retries
    const dup = beginConsolidationRun(store, {
      scope_kind: 'project', scope_id: '101', logical_day: '2026-06-15', trigger: 'nightly', model_id: 'sm1',
      started_at: '2026-06-15T02:10:00Z',
    });
    assert.equal(dup, null);

    // Manual run on the same day IS allowed once previous run is finished
    const manual = beginConsolidationRun(store, {
      scope_kind: 'project', scope_id: '101', logical_day: '2026-06-15', trigger: 'manual', model_id: 'sm1',
      started_at: '2026-06-15T03:00:00Z',
    });
    assert.ok(manual);
    finishConsolidationRun(store, manual.id, {
      status: 'completed',
      summary: 'Consolidated notes',
      changed_files: [{ path: 'INDEX.md', id: 'f:1', revision: 2, action: 'updated' }],
      finished_at: '2026-06-15T03:01:00Z',
    });

    // Retention pruning deletes finished runs older than cutoff
    assert.equal(pruneConsolidationRuns(store, '2026-06-15T02:30:00Z'), 1);
    assert.equal(pruneConsolidationRuns(store, '2026-06-16T00:00:00Z'), 1);
  } finally {
    store.close();
  }
});

test('assistant ~/memory/ path validator, fd-anchored symlink defense, and automatic redaction', async () => {
  assert.equal(isMemorySubpath('memory/INDEX.md'), true);
  assert.equal(isMemorySubpath('memory/'), false);
  assert.equal(isMemorySubpath('notes/a.md'), false);

  assert.equal(normalizeAssistantMemoryPath('~/memory/INDEX.md'), 'memory/INDEX.md');
  assert.equal(normalizeAssistantMemoryPath('/home/assistant/memory/sub/note.md'), 'memory/sub/note.md');
  assert.equal(normalizeAssistantMemoryPath('prefs.md', { allowBare: true }), 'memory/prefs.md');

  for (const bad of ['~/memory', '~/other.txt', '/etc/passwd', '~/memory/../escape.md', '~/memory/.env', '~/memory/id_rsa', '~/memory/cert.pem', 'memory/bad\u0000name.md']) {
    assert.throws(() => normalizeAssistantMemoryPath(bad, { allowBare: true }), err => err.status === 400);
  }

  const root = mkdtempSync(join(tmpdir(), 'assistant-mem-ut-'));
  const outside = mkdtempSync(join(tmpdir(), 'assistant-mem-outside-'));
  const store = new Store(':memory:', Buffer.alloc(32, 3));
  try {
    // Register a known secret in store so configuredRedactor scrubs it on ~/memory/ writes
    const secretValue = 'ghp_unitTestSecretTokenValue1234567890';
    store.run("INSERT INTO accounts VALUES('acc1','Test','bot_account',NULL,?,'now')",
      store.secrets.seal({ token: secretValue }, 'account:acc1'));

    const homes = new AssistantHomes(store, root);
    const prepared = await homes.prepare({ kind: 'person', subject: 'p1', tenant: '' }, { repositories: [] });

    // writeMemoryText redacts registered credentials before writing to disk
    await homes.writeMemoryText(prepared.directory, 'memory/INDEX.md', `Do not leak ${secretValue} here.`);
    const readBack = await homes.read(prepared.directory, 'memory/INDEX.md', 65536);
    const text = readBack.data.toString('utf8');
    assert.ok(!text.includes(secretValue), 'registered secret must be redacted from ~/memory/');
    assert.ok(text.includes('[REDACTED]') || text.includes('Do not leak'));

    // Symlink escape defense via fd-anchored traversal
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_DATA');
    mkdirSync(join(prepared.directory, 'memory'), { recursive: true });
    symlinkSync(join(outside, 'secret.txt'), join(prepared.directory, 'memory/link.md'));
    symlinkSync(outside, join(prepared.directory, 'memory/escape-dir'));

    await assert.rejects(() => homes.read(prepared.directory, 'memory/link.md', 4096), { code: 'invalid_path' });
    await assert.rejects(() => homes.writeMemoryText(prepared.directory, 'memory/link.md', 'overwrite'), { code: 'invalid_path' });
    await assert.rejects(() => homes.writeMemoryText(prepared.directory, 'memory/escape-dir/pwn.md', 'pwn'), { code: 'invalid_path' });
    assert.equal(existsSync(join(outside, 'pwn.md')), false);

    // Removing a symlink removes the link itself without touching the outside target
    await homes.remove(prepared.directory, 'memory/link.md');
    assert.equal(existsSync(join(outside, 'secret.txt')), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('project-notes Notes.pruneHistory keeps union of keepVersions and keepDays, GCs orphan blobs, and fails closed on corrupt index', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-prune-ut-'));
  try {
    const notes = new Notes(root);
    const nowMs = Date.parse('2026-06-30T00:00:00Z');
    const daysAgo = d => new Date(nowMs - d * 86_400_000).toISOString();

    // Write 5 revisions of guide.md + 1 revision of keep.md
    await notes.saveFile('guide.md', 'rev1-old-body', 0, 'user:1');
    await notes.saveFile('guide.md', 'rev2-old-body', 1, 'user:1');
    await notes.saveFile('guide.md', 'rev3-old-body', 2, 'user:1');
    await notes.saveFile('guide.md', 'rev4-recent-body', 3, 'user:1');
    await notes.saveFile('guide.md', 'rev5-latest-body', 4, 'user:1');
    await notes.saveFile('keep.md', 'keep-body', 0, 'user:1');

    // Backdate revisions 1..5 in .write-history/*.json so keepDays & keepVersions union is tested deterministically
    const histRoot = join(root, '.write-history');
    const catalog = JSON.parse(readFileSync(join(histRoot, 'file-tree.json'), 'utf8'));
    const guideKey = catalog.files.find(f => f.path === 'guide.md').history_key;
    const keepKey = catalog.files.find(f => f.path === 'keep.md').history_key;
    const guideFile = join(histRoot, guideKey + '.json');
    const guideParsed = JSON.parse(readFileSync(guideFile, 'utf8'));
    const ages = [90, 60, 45, 10, 1];
    guideParsed.versions.forEach((v, i) => { v.created_at = daysAgo(ages[i] ?? 1); });
    writeFileSync(guideFile, JSON.stringify(guideParsed));
    const keepFile = join(histRoot, keepKey + '.json');
    const keepParsed = JSON.parse(readFileSync(keepFile, 'utf8'));
    keepParsed.versions[0].created_at = daysAgo(5);
    writeFileSync(keepFile, JSON.stringify(keepParsed));

    // Prune keeping >= 2 versions OR within 30 days -> rev1, rev2, rev3 pruned; rev4 & rev5 kept!
    const report = await notes.pruneHistory({ keepVersions: 2, keepDays: 30, now: nowMs });
    assert.equal(report.pruned_versions, 3);
    assert.equal(report.removed_blobs, 3);
    assert.equal(report.blob_gc_skipped, false);

    const remaining = await notes.versions('guide.md');
    assert.deepEqual(remaining.versions.map(v => v.revision), [5, 4]);
    const current = await notes.read('guide.md');
    assert.equal(current.content, 'rev5-latest-body');

    // Fail-closed GC: place a corrupt 64-hex history index file in .write-history/ and verify blobs are NOT deleted
    const blobsDir = join(histRoot, 'blobs');
    writeFileSync(join(histRoot, 'a'.repeat(64) + '.json'), '{not-valid-json');
    writeFileSync(join(blobsDir, 'deadbeef'.repeat(8)), 'orphan-blob-should-stay-when-corrupt');
    const blobsBefore = readdirSync(blobsDir).length;
    const report2 = await notes.pruneHistory({ keepVersions: 1, keepDays: 1, now: nowMs });
    assert.equal(report2.blob_gc_skipped, true);
    assert.equal(report2.removed_blobs, 0);
    assert.equal(readdirSync(blobsDir).length, blobsBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
