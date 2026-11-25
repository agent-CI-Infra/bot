import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Store } from '../../../../dist/storage/database.js';
import {
  deleteFeedbackEntry,
  feedbackSettings,
  getFeedbackEntry,
  readFeedbackPayload,
  saveFeedbackSettings,
  sweepOrphanFeedbackFiles,
  writeFeedbackPayload,
} from '../../../../dist/feedback/storage.js';
import {
  executeSubmitFeedback,
  isFeedbackEnabled,
  MAX_FEEDBACK_EVIDENCE_ITEMS,
  MAX_FEEDBACK_FIELD_BYTES,
  MAX_FEEDBACK_TITLE_CHARS,
  MAX_FEEDBACK_TOTAL_BYTES,
  SUBMIT_FEEDBACK_TOOL_NAME,
  submitFeedbackTool,
} from '../../../../dist/feedback/tool.js';
import { sanitizeApiUrl } from '../../../../dist/feedback/snapshot.js';
import { basicTools, defaultPermissions, fullPermissions, permissionTools, updatePermissions } from '../../../../dist/roles/permissions.js';
import { filterPlatformTools, NATIVE_CLI_REPLACED_TOOLS } from '../../../../dist/harness/container-session.js';
import { groupConsolidationTools, personalConsolidationTools, projectConsolidationTools } from '../../../../dist/memory/consolidation-tools.js';

function createDiskStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-ut-'));
  const store = new Store(join(dir, 'control.sqlite'), Buffer.alloc(32, 7));
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,?,'2026-01-01')", store.secrets.seal({ token: 'ghp_AccountSecretToken1234567890123456' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run("INSERT INTO policies(repository_id,enabled) VALUES('101',1)");
  store.run(
    "INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m1','101',?,?,?,'2026-01-01')",
    'https://user:pass1234@model.invalid/v1/chat?api_key=leak#frag',
    'fixture-model',
    store.secrets.seal({ value: 'sk-super-secret-model-key-99887766' }, 'model:m1'),
  );
  return { dir, store };
}

const sampleSnapshot = (overrides = {}) => ({
  source_kind: 'project_role',
  untrusted_context: false,
  repository_id: '101',
  repository_full_name: 'fixture/project-101',
  role: {
    role_id: 'dev',
    role_name: 'Developer',
    kind: 'writer',
    config_revision: 2,
    role_revision: 3,
    system_prompt: 'You are a developer role.',
    permissions: defaultPermissions('dev', 'writer'),
    offered_tools: ['read_file', 'submit_feedback'],
  },
  model: {
    id: 'm1',
    name: 'fixture-model',
    version: 1,
    source: 'project',
    api_url: 'https://user:pass1234@model.invalid/v1/chat?api_key=leak#frag',
    interface_type: 'chat_completions',
  },
  harness: { id: 'pi', version: '0.1.0', cli_version: '0.1.0', environment: 'project_computer' },
  skills: { bundle: { id: 'b1', revision: 1, content_hash: 'a'.repeat(64), files: [{ path: '.agents/skills/foo/SKILL.md', sha256: 'b'.repeat(64), bytes: 120 }] }, skills_read: ['.agents/skills/foo/SKILL.md'] },
  execution: { task_id: 't1', run_id: 'r1', attempt: 1, elapsed_ms: 4200, recent_tools: [{ name: 'read_file', outcome: 'ok', at: new Date().toISOString() }] },
  ...overrides,
});

const validArgs = (overrides = {}) => ({
  title: 'Skill instructions contradict test runner command',
  category: 'skill',
  severity: 'high',
  context: 'While implementing a fix under project 101.',
  problem: 'The skill recommends running npm run verify which does not exist.',
  suggestion: 'Update the skill to reference npm run check and npm test.',
  target_ref: '.agents/skills/foo/SKILL.md',
  evidence_refs: ['task:t1', 'run:r1'],
  ...overrides,
});

test('plaintext .json.gz atomic write, 0o600 permissions, gunzip without master key, and lightweight SQLite index schema', t => {
  const { dir, store } = createDiskStore(t);
  const obs = executeSubmitFeedback({
    store,
    idempotencyScope: 'ut:plaintext',
    snapshot: () => sampleSnapshot(),
  }, validArgs());
  assert.equal(obs.accepted, true);
  assert.equal(obs.deduplicated, false);
  assert.equal(obs.remaining_in_run, 2);
  assert.ok(obs.feedback_id);

  // SQLite index table has zero large body or snapshot columns
  const cols = store.all('PRAGMA table_info(feedback_entries)').map(c => c.name);
  for (const forbidden of ['context', 'problem', 'suggestion', 'environment_snapshot', 'payload', 'body']) {
    assert.equal(cols.includes(forbidden), false, `feedback_entries must not store ${forbidden} in SQLite`);
  }
  const row = getFeedbackEntry(store, obs.feedback_id);
  assert.ok(row);
  assert.ok(Buffer.byteLength(JSON.stringify(row), 'utf8') < 1024);

  // On disk: <dir>/feedback/<id[:2]>/<id>.json.gz, plaintext gzip readable with standard gunzipSync (no master key!)
  const expectedPath = join(dir, 'feedback', obs.feedback_id.slice(0, 2), `${obs.feedback_id}.json.gz`);
  assert.equal(existsSync(expectedPath), true);
  assert.equal(statSync(expectedPath).mode & 0o777, 0o600);
  const rawGzip = readFileSync(expectedPath);
  const parsed = JSON.parse(gunzipSync(rawGzip).toString('utf8'));
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.id, obs.feedback_id);
  assert.equal(parsed.feedback.title, validArgs().title);
  assert.equal(parsed.environment_snapshot.role_config.role_id, 'dev');
  assert.equal(parsed.environment_snapshot.model.api_url, 'https://model.invalid/v1/chat');
  assert.deepEqual(parsed.environment_snapshot.skills.skills_read, ['.agents/skills/foo/SKILL.md']);
  assert.equal(readFeedbackPayload(store, row.id, row.payload_sha256).id, row.id);
});

test('readFeedbackPayload fails closed with 409 feedback_payload_corrupt on tamper, missing file, symlink, or corrupt gzip', t => {
  const { dir, store } = createDiskStore(t);
  const submit = key => executeSubmitFeedback({
    store,
    idempotencyScope: 'ut:corrupt:' + key,
    snapshot: () => sampleSnapshot(),
  }, validArgs({ title: 'Case ' + key }));

  // 1. Tampered byte -> sha256 mismatch
  const r1 = submit('tamper');
  const row1 = getFeedbackEntry(store, r1.feedback_id);
  const p1 = join(dir, 'feedback', row1.payload_relpath);
  const buf = Buffer.from(readFileSync(p1));
  buf[buf.length - 1] ^= 0xff;
  writeFileSync(p1, buf);
  assert.throws(() => readFeedbackPayload(store, row1.id, row1.payload_sha256), err => err.status === 409 && err.code === 'feedback_payload_corrupt');

  // 2. Missing file
  const r2 = submit('missing');
  const row2 = getFeedbackEntry(store, r2.feedback_id);
  rmSync(join(dir, 'feedback', row2.payload_relpath));
  assert.throws(() => readFeedbackPayload(store, row2.id, row2.payload_sha256), err => err.status === 409 && err.code === 'feedback_payload_corrupt');

  // 3. Symlink replacement -> O_NOFOLLOW ELOOP rejected
  const r3 = submit('symlink');
  const row3 = getFeedbackEntry(store, r3.feedback_id);
  const p3 = join(dir, 'feedback', row3.payload_relpath);
  const decoy = join(dir, 'decoy.gz');
  writeFileSync(decoy, readFileSync(p3));
  rmSync(p3);
  symlinkSync(decoy, p3);
  assert.throws(() => readFeedbackPayload(store, row3.id, row3.payload_sha256), err => err.status === 409 && err.code === 'feedback_payload_corrupt');

  // 4. Corrupt non-gzip payload even if sha256 matches
  const r4 = submit('badgzip');
  const row4 = getFeedbackEntry(store, r4.feedback_id);
  const p4 = join(dir, 'feedback', row4.payload_relpath);
  const junk = Buffer.from('not-a-gzip-stream');
  writeFileSync(p4, junk);
  assert.throws(() => readFeedbackPayload(store, row4.id, '0'.repeat(64)), err => err.status === 409 && err.code === 'feedback_payload_corrupt');

  // Deleting an entry removes both index row and file
  const r5 = submit('delete');
  const row5 = getFeedbackEntry(store, r5.feedback_id);
  const p5 = join(dir, 'feedback', row5.payload_relpath);
  assert.equal(existsSync(p5), true);
  deleteFeedbackEntry(store, row5.id, 'admin');
  assert.equal(getFeedbackEntry(store, row5.id), null);
  assert.equal(existsSync(p5), false);
});

test('deep redaction strips configured keys, tokens, PEM, Bearer, URL credentials; writeFeedbackPayload fails closed on raw secret', t => {
  const { dir, store } = createDiskStore(t);
  const extraSecret = 'extra-run-secret-value-999888777';
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----';
  const obs = executeSubmitFeedback({
    store,
    idempotencyScope: 'ut:redact',
    extraSecrets: [extraSecret],
    snapshot: () => sampleSnapshot(),
  }, validArgs({
    title: 'Key leak sk-super-secret-model-key-99887766 in title',
    context: `Account token ghp_AccountSecretToken1234567890123456 and extra ${extraSecret}`,
    problem: `Bearer eyJhbGciOiJIUzI1NiJ9.abcdef123456 and url https://alice:s3cr3tpass@host.invalid/p?token=abc`,
    suggestion: `Remove PEM block:\n${pem}`,
    evidence_refs: ['https://bob:topsecret@example.invalid/trace'],
    idempotency_key: 'idem-sk-super-secret-model-key-99887766',
  }));
  assert.equal(obs.accepted, true);
  // Replaying with the same secret-bearing idempotency_key still deduplicates against the redacted index value
  const deduped = executeSubmitFeedback({
    store,
    idempotencyScope: 'ut:redact',
    extraSecrets: [extraSecret],
    snapshot: () => sampleSnapshot(),
  }, validArgs({
    title: 'Key leak sk-super-secret-model-key-99887766 in title',
    idempotency_key: 'idem-sk-super-secret-model-key-99887766',
  }));
  assert.equal(deduped.accepted, true);
  assert.equal(deduped.deduplicated, true);
  assert.equal(deduped.feedback_id, obs.feedback_id);
  const row = getFeedbackEntry(store, obs.feedback_id);
  assert.equal(row.idempotency_key.includes('sk-super-secret-model-key-99887766'), false, 'idempotency_key in SQLite index must be redacted');
  const rawJson = gunzipSync(readFileSync(join(dir, 'feedback', row.payload_relpath))).toString('utf8');
  const serialized = JSON.stringify(row) + '\n' + rawJson;
  for (const leaked of [
    'sk-super-secret-model-key-99887766',
    'ghp_AccountSecretToken1234567890123456',
    extraSecret,
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj',
    'eyJhbGciOiJIUzI1NiJ9.abcdef123456',
    'alice:s3cr3tpass',
    'bob:topsecret',
    'user:pass1234',
    'api_key=leak',
  ]) {
    assert.equal(serialized.includes(leaked), false, `secret must be scrubbed from index and payload: ${leaked}`);
  }
  assert.equal(sanitizeApiUrl('https://u:p@api.openai.com:443/v1/chat?key=1#top'), 'https://api.openai.com/v1/chat');
  assert.equal(sanitizeApiUrl('not-a-url'), null);

  // Direct writeFeedbackPayload refuses unredacted secret fail-closed and creates no file
  const badId = 'deadbeef00112233445566778899aabb';
  assert.throws(() => writeFeedbackPayload(store, badId, {
    schema_version: 1,
    id: badId,
    created_at: new Date().toISOString(),
    feedback: validArgs({ problem: 'raw sk-unredacted-secret-12345678901234' }),
    environment_snapshot: { source_kind: 'project_role' },
  }), err => err.code === 'role_run_secret_rejected');
  assert.equal(existsSync(join(dir, 'feedback', badId.slice(0, 2), `${badId}.json.gz`)), false);
});

test('validation, size limits, idempotency replay, per-run cap, hourly sliding limit, disk guard, and toggle all return non-fatal observations', t => {
  const { store } = createDiskStore(t);
  let clock = Date.parse('2026-11-24T10:00:00.000Z');
  const ctx = (scope, extra = {}) => ({
    store,
    idempotencyScope: scope,
    now: () => clock,
    snapshot: () => sampleSnapshot(),
    ...extra,
  });

  // Validation errors never throw
  assert.equal(executeSubmitFeedback(ctx('val'), null).error, 'feedback_invalid_arguments');
  assert.equal(executeSubmitFeedback(ctx('val'), { ...validArgs(), extra: 1 }).error, 'feedback_unknown_field');
  assert.equal(executeSubmitFeedback(ctx('val'), validArgs({ category: 'bogus' })).error, 'feedback_invalid_field');
  assert.equal(executeSubmitFeedback(ctx('val'), validArgs({ severity: 'critical' })).error, 'feedback_invalid_field');
  assert.equal(executeSubmitFeedback(ctx('val'), validArgs({ title: 'x'.repeat(MAX_FEEDBACK_TITLE_CHARS + 1) })).error, 'feedback_field_too_long');
  assert.equal(executeSubmitFeedback(ctx('val'), validArgs({ problem: 'a'.repeat(MAX_FEEDBACK_FIELD_BYTES + 1) })).error, 'feedback_field_too_large');
  assert.equal(executeSubmitFeedback(ctx('val'), validArgs({ evidence_refs: Array.from({ length: MAX_FEEDBACK_EVIDENCE_ITEMS + 1 }, (_, i) => 'e' + i) })).error, 'feedback_field_too_long');
  // Combined > 64 KiB (each individual field <= 16 KiB and evidence_refs <= 20 items of <= 512 chars, using 3-byte UTF-8 chars to cross 64 KiB)
  const bigChunk = 'x'.repeat(16 * 1024);
  const multiByteEvidence = Array.from({ length: 20 }, (_, i) => `ev-${i}-` + '中'.repeat(400));
  const overTotal = executeSubmitFeedback(ctx('val'), validArgs({
    context: bigChunk,
    problem: bigChunk,
    suggestion: bigChunk,
    evidence_refs: multiByteEvidence,
  }));
  assert.equal(overTotal.accepted, false);
  assert.equal(overTotal.error, 'feedback_payload_too_large');
  assert.equal(MAX_FEEDBACK_TOTAL_BYTES, 64 * 1024);

  // Per-run cap (default 3) + idempotency deduplication does NOT consume extra quota
  const s1 = executeSubmitFeedback(ctx('run:cap'), validArgs({ title: 'One', idempotency_key: 'k1' }));
  const s2 = executeSubmitFeedback(ctx('run:cap'), validArgs({ title: 'Two', idempotency_key: 'k2' }));
  const s3 = executeSubmitFeedback(ctx('run:cap'), validArgs({ title: 'Three', idempotency_key: 'k3' }));
  assert.deepEqual([s1.remaining_in_run, s2.remaining_in_run, s3.remaining_in_run], [2, 1, 0]);
  // Replaying k1 even when 3/3 used still deduplicates cleanly
  const replay = executeSubmitFeedback(ctx('run:cap'), validArgs({ title: 'One retry', idempotency_key: 'k1' }));
  assert.equal(replay.accepted, true);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.feedback_id, s1.feedback_id);
  assert.equal(replay.remaining_in_run, 0);
  // 4th distinct call rejected cleanly
  const overCap = executeSubmitFeedback(ctx('run:cap'), validArgs({ title: 'Four', idempotency_key: 'k4' }));
  assert.equal(overCap.accepted, false);
  assert.equal(overCap.error, 'feedback_run_limit_reached');

  // Hourly sliding-window rate limit per project
  clock += 2 * 3600_000;
  const h1 = executeSubmitFeedback(ctx('run:h1', { hourlyLimit: 2 }), validArgs({ title: 'H1' }));
  const h2 = executeSubmitFeedback(ctx('run:h2', { hourlyLimit: 2 }), validArgs({ title: 'H2' }));
  const h3 = executeSubmitFeedback(ctx('run:h3', { hourlyLimit: 2 }), validArgs({ title: 'H3' }));
  assert.deepEqual([h1.accepted, h2.accepted, h3.accepted, h3.error], [true, true, false, 'feedback_rate_limited']);
  clock += 61 * 60_000;
  assert.equal(executeSubmitFeedback(ctx('run:h4', { hourlyLimit: 2 }), validArgs({ title: 'H4' })).accepted, true);

  // Disk guard refusal
  store.disk = { check: () => ({ low: true, free: 100, reserve: 1000, total: 10000 }) };
  const diskRefused = executeSubmitFeedback(ctx('run:disk'), validArgs({ title: 'Disk low' }));
  assert.equal(diskRefused.accepted, false);
  assert.equal(diskRefused.error, 'feedback_disk_low');
  store.disk = undefined;

  // Global disable toggle
  assert.equal(isFeedbackEnabled(store), true);
  saveFeedbackSettings(store, 'admin', { enabled: false, max_per_run: 5 });
  assert.deepEqual(feedbackSettings(store), { enabled: false, max_per_run: 5 });
  assert.equal(isFeedbackEnabled(store), false);
  assert.equal(executeSubmitFeedback(ctx('run:disabled'), validArgs({ title: 'Disabled' })).error, 'feedback_disabled');
});

test('orphan sweep cleans >1h unreferenced .json.gz and .tmp while preserving indexed and recent files', t => {
  const { dir, store } = createDiskStore(t);
  const active = executeSubmitFeedback({
    store,
    idempotencyScope: 'ut:sweep',
    snapshot: () => sampleSnapshot(),
  }, validArgs());
  const activePath = join(dir, 'feedback', getFeedbackEntry(store, active.feedback_id).payload_relpath);
  const shard = join(dir, 'feedback', 'ab');
  mkdirSync(shard, { recursive: true, mode: 0o700 });
  const oldOrphan = join(shard, 'ab1234567890.json.gz');
  const oldTmp = join(shard, 'ab1234567890.json.gz.a1b2c3d4e5f6.tmp');
  const freshOrphan = join(shard, 'ab9999999999.json.gz');
  for (const p of [oldOrphan, oldTmp, freshOrphan]) writeFileSync(p, Buffer.from('x'));
  const oldTime = new Date(Date.now() - 2 * 3600_000);
  utimesSync(oldOrphan, oldTime, oldTime);
  utimesSync(oldTmp, oldTime, oldTime);
  utimesSync(activePath, oldTime, oldTime);

  const swept = sweepOrphanFeedbackFiles(store);
  assert.equal(swept.count, 2);
  assert.equal(swept.failed, 0);
  assert.equal(existsSync(oldOrphan), false);
  assert.equal(existsSync(oldTmp), false);
  assert.equal(existsSync(freshOrphan), true);
  assert.equal(existsSync(activePath), true);
});

test('write-only boundary and 5-backend tool exposure: submit_feedback offered everywhere with zero read/list/delete feedback tools', () => {
  assert.equal(basicTools.includes(SUBMIT_FEEDBACK_TOOL_NAME), true);
  assert.equal(NATIVE_CLI_REPLACED_TOOLS.has(SUBMIT_FEEDBACK_TOOL_NAME), false);

  // filterPlatformTools keeps submit_feedback for Claude Code, Codex, iCode, WorkSwarm MCP
  const filtered = filterPlatformTools({
    tools: [
      submitFeedbackTool,
      { type: 'function', function: { name: 'read_file' } },
      { type: 'function', function: { name: 'run_command' } },
    ],
  });
  assert.deepEqual(filtered.map(t => t.function.name), [SUBMIT_FEEDBACK_TOOL_NAME]);

  // Every built-in role + custom role gets submit_feedback even with all optional permissions stripped
  for (const [id, kind] of [['manager', 'controller'], ['dev', 'writer'], ['reviewer', 'observer'], ['test', 'observer'], ['ux', 'observer'], ['qa', 'evaluator'], ['custom', 'observer']]) {
    const minimal = updatePermissions(defaultPermissions(id, kind), {
      github_issues: 'none',
      github_pull_requests: 'none',
      github_contents: 'none',
      github_actions: 'none',
      github_checks: 'none',
      github_statuses: 'none',
      project_memory: 'none',
      project_tasks: 'none',
      delegation: 'deny',
    });
    const tools = permissionTools(minimal);
    assert.ok(tools.includes(SUBMIT_FEEDBACK_TOOL_NAME), `${id} must receive submit_feedback`);
    assert.equal(tools.includes('github_write'), false, 'submit_feedback must not widen GitHub permissions');
  }

  // Zero read/list/search/delete/update feedback tools exist in role or consolidation tool registries
  const allRoleTools = permissionTools(fullPermissions());
  const allConsolidationTools = [
    ...projectConsolidationTools,
    ...groupConsolidationTools(fullPermissions()),
    ...personalConsolidationTools,
  ].map(t => t.function.name);
  for (const name of [...allRoleTools, ...allConsolidationTools]) {
    if (name.includes('feedback')) {
      assert.equal(name, SUBMIT_FEEDBACK_TOOL_NAME, `unexpected feedback tool exposed: ${name}`);
    }
  }
});
