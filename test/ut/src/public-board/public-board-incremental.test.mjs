import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse as parseYaml } from 'yaml';
import { Store } from '../../../../dist/storage/database.js';
import { configuredRedactorFingerprint } from '../../../../dist/core/redaction.js';
import {
  DEFAULT_BOARD_COOLDOWN_MS,
  DEFAULT_BOARD_RECONCILE_MS,
  boardWebhook,
  classifyBoardWebhook,
  configurePublicBoard,
  mergeBoardScopes,
  parseBoardScopes,
  queueBoard,
  resolveBoardCooldownMs,
  resolveBoardReconcileMs,
} from '../../../../dist/public-board/state.js';
import {
  finalizeBoardStaging,
  runFinalizeBoardStagingWorker,
} from '../../../../dist/public-board/redaction-worker.js';
import { collectRepo } from '../../../../public-board/scripts/collect.mjs';
import { GitHubClient } from '../../../../public-board/scripts/lib/github.mjs';
import { credentialExamples, maskedExamples } from '../../../fixtures/public-credentials.mjs';

function makeStore(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 7));
  t.after(() => store.close());
  const accountId = 'a'.repeat(48);
  store.run(
    `INSERT INTO accounts(id,name,type,credentials,created_at) VALUES(?,?,'bot_account',?,?)`,
    accountId, 'Bot', store.secrets.seal({ token: 'account-secret-token-value' }, `account:${accountId}`), new Date().toISOString(),
  );
  store.run(
    `INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
     VALUES(?,?,?,?,?,?,0,1,?)`,
    accountId, '101', '1', 'octo/hello', '10', 'octo', new Date().toISOString(),
  );
  return { store, accountId };
}

test('classifyBoardWebhook filters noise events and maps data-affecting events to dirty scopes', () => {
  const noise = [
    ['ping', {}],
    ['status', { state: 'success' }],
    ['check_run', { action: 'completed' }],
    ['check_suite', { action: 'completed' }],
    ['workflow_job', { action: 'completed' }],
    ['workflow_run', { action: 'requested' }],
    ['workflow_run', { action: 'in_progress' }],
    ['deployment', { action: 'created' }],
    ['deployment_status', { action: 'created' }],
    ['deployment_protection_rule', { action: 'requested' }],
    ['deployment_review', { action: 'approved' }],
    ['issue_comment', { action: 'edited', issue: { number: 1 } }],
    ['pull_request_review', { action: 'edited' }],
    ['pull_request_review_comment', { action: 'created' }],
    ['pull_request_review_thread', { action: 'resolved' }],
    ['commit_comment', { action: 'created' }],
    ['milestone', { action: 'edited' }],
    ['member', { action: 'added' }],
    ['organization', { action: 'member_added' }],
  ];
  for (const [event, payload] of noise) {
    assert.equal(classifyBoardWebhook(event, payload), null, `${event}:${payload.action ?? ''}`);
  }

  assert.deepEqual(classifyBoardWebhook('issues', { action: 'opened' }), ['issues']);
  assert.deepEqual(classifyBoardWebhook('label', { action: 'edited' }), ['issues', 'pulls']);
  assert.deepEqual(classifyBoardWebhook('label', { action: 'deleted' }), ['issues', 'pulls']);
  assert.deepEqual(classifyBoardWebhook('issue_comment', { action: 'created', issue: { number: 1 } }), ['issues']);
  assert.deepEqual(classifyBoardWebhook('issue_comment', { action: 'deleted', issue: { number: 2, pull_request: {} } }), ['issues', 'pulls']);
  assert.deepEqual(classifyBoardWebhook('pull_request', { action: 'opened', pull_request: { merged: false } }), ['pulls']);
  assert.deepEqual(classifyBoardWebhook('pull_request', { action: 'closed', pull_request: { merged: true } }), ['pulls', 'contributors']);
  assert.deepEqual(classifyBoardWebhook('pull_request_review', { action: 'submitted' }), ['reviews']);
  assert.deepEqual(classifyBoardWebhook('workflow_run', { action: 'completed' }), ['ci']);
  assert.deepEqual(classifyBoardWebhook('release', { action: 'published' }), ['releases']);
  assert.deepEqual(classifyBoardWebhook('push', {}), ['repo', 'contributors']);
  for (const event of ['repository', 'public', 'star', 'watch', 'fork']) {
    assert.deepEqual(classifyBoardWebhook(event, {}), ['repo'], event);
  }
});

test('boardWebhook drops noise events, always enforces repository.private changes, and coalesces cooldown windows', t => {
  const { store, accountId } = makeStore(t);
  let clock = 1_000_000;
  configurePublicBoard(store, { cooldownMs: 5 * 60_000, now: () => clock });
  assert.equal(DEFAULT_BOARD_COOLDOWN_MS, 5 * 60_000);

  const payload = (extra = {}) => ({ repository: { id: 101, full_name: 'octo/hello', private: false }, ...extra });

  // Noise events never create or advance a board job.
  for (const [event, extra] of [
    ['ping', {}],
    ['status', {}],
    ['check_run', { action: 'completed' }],
    ['check_suite', { action: 'completed' }],
    ['workflow_job', { action: 'completed' }],
    ['workflow_run', { action: 'in_progress' }],
    ['deployment_status', { action: 'created' }],
  ]) {
    boardWebhook(store, accountId, event, payload(extra));
  }
  assert.equal(store.get('SELECT count(*) n FROM public_board_jobs').n, 0);

  // Even a noise event carrying private=true updates visibility immediately so reads see 404 right away.
  boardWebhook(store, accountId, 'status', { repository: { id: 101, full_name: 'octo/hello', private: true } });
  assert.equal(store.get('SELECT private FROM installed_repositories WHERE repository_id=?', '101').private, 1);
  assert.equal(store.get('SELECT count(*) n FROM public_board_jobs').n, 0);

  // Flipping back to private=false on any event queues immediately when no snapshot exists yet.
  boardWebhook(store, accountId, 'status', { repository: { id: 101, full_name: 'octo/hello', private: false } });
  assert.equal(store.get('SELECT private FROM installed_repositories WHERE repository_id=?', '101').private, 0);
  let job = store.get('SELECT * FROM public_board_jobs');
  assert.equal(job.generation, 1);
  assert.equal(job.next_attempt, 0);
  assert.deepEqual(parseBoardScopes(job.dirty_scopes), ['all']);

  // Simulate a finished collection at clock = 1_000_000.
  store.run(
    `UPDATE public_board_jobs SET active_path='/tmp/snap-1',collected_generation=1,last_collected_at=?,next_attempt=0,dirty_scopes='' WHERE account_id=? AND repository_id=?`,
    clock, accountId, '101',
  );

  // Multiple events within the 5-minute cooldown window merge dirty scopes and pin next_attempt to cooldown expiry.
  clock += 10_000;
  boardWebhook(store, accountId, 'issues', payload({ action: 'opened' }));
  job = store.get('SELECT * FROM public_board_jobs');
  assert.equal(job.generation, 2);
  assert.equal(job.next_attempt, 1_000_000 + 5 * 60_000);
  assert.deepEqual(parseBoardScopes(job.dirty_scopes), ['issues']);

  clock += 20_000;
  boardWebhook(store, accountId, 'pull_request', payload({ action: 'opened' }));
  job = store.get('SELECT * FROM public_board_jobs');
  assert.equal(job.generation, 3);
  assert.equal(job.next_attempt, 1_000_000 + 5 * 60_000, 'subsequent webhooks during cooldown must never reset next_attempt to 0');
  assert.deepEqual(parseBoardScopes(job.dirty_scopes), ['issues', 'pulls']);

  // Manual immediate enable bypasses cooldown.
  queueBoard(store, accountId, '101', { immediate: true, scopes: ['all'] });
  job = store.get('SELECT * FROM public_board_jobs');
  assert.equal(job.generation, 4);
  assert.equal(job.next_attempt, 0);
  assert.deepEqual(parseBoardScopes(job.dirty_scopes), ['all']);

  // Failure backoff is preserved across subsequent webhooks when cooldown > 0.
  store.run(
    `UPDATE public_board_jobs SET last_error='collection_failed',attempts=3,next_attempt=? WHERE account_id=? AND repository_id=?`,
    clock + 600_000, accountId, '101',
  );
  boardWebhook(store, accountId, 'release', payload({ action: 'published' }));
  job = store.get('SELECT * FROM public_board_jobs');
  assert.equal(job.next_attempt, clock + 600_000);
});

test('board timing env vars validate strictly, respect overrides, and are wired in compose.yaml', t => {
  const prevCooldown = process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS;
  const prevReconcile = process.env.BOT_PUBLIC_BOARD_RECONCILE_MS;
  t.after(() => {
    if (prevCooldown === undefined) delete process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS;
    else process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS = prevCooldown;
    if (prevReconcile === undefined) delete process.env.BOT_PUBLIC_BOARD_RECONCILE_MS;
    else process.env.BOT_PUBLIC_BOARD_RECONCILE_MS = prevReconcile;
  });

  delete process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS;
  delete process.env.BOT_PUBLIC_BOARD_RECONCILE_MS;
  assert.equal(resolveBoardCooldownMs(), DEFAULT_BOARD_COOLDOWN_MS);
  assert.equal(resolveBoardReconcileMs(), DEFAULT_BOARD_RECONCILE_MS);

  process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS = '0';
  assert.equal(resolveBoardCooldownMs(), 0);
  process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS = '45000';
  assert.equal(resolveBoardCooldownMs(), 45_000);
  assert.equal(resolveBoardCooldownMs(undefined, 12_000), 12_000);
  for (const bad of ['abc', '-1', '1.5', '0x10', 'Infinity']) {
    process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS = bad;
    assert.throws(() => resolveBoardCooldownMs(), /BOT_PUBLIC_BOARD_COOLDOWN_MS/, `bad cooldown ${bad}`);
  }

  process.env.BOT_PUBLIC_BOARD_RECONCILE_MS = '0';
  assert.equal(resolveBoardReconcileMs(), 0);
  process.env.BOT_PUBLIC_BOARD_RECONCILE_MS = '60000';
  assert.equal(resolveBoardReconcileMs(), 60_000);
  assert.equal(resolveBoardReconcileMs(undefined, 120_000), 120_000);
  for (const bad of ['abc', '-1', '1.5', '1', '59999', '0x10']) {
    process.env.BOT_PUBLIC_BOARD_RECONCILE_MS = bad;
    assert.throws(() => resolveBoardReconcileMs(), /BOT_PUBLIC_BOARD_RECONCILE_MS/, `bad reconcile ${bad}`);
  }

  const compose = parseYaml(readFileSync('docker/compose.yaml', 'utf8'));
  const botEnv = compose?.services?.bot?.environment ?? {};
  assert.equal(botEnv.BOT_PUBLIC_BOARD_COOLDOWN_MS, `\${BOT_PUBLIC_BOARD_COOLDOWN_MS:-${DEFAULT_BOARD_COOLDOWN_MS}}`);
  assert.equal(botEnv.BOT_PUBLIC_BOARD_RECONCILE_MS, `\${BOT_PUBLIC_BOARD_RECONCILE_MS:-${DEFAULT_BOARD_RECONCILE_MS}}`);

  assert.equal(mergeBoardScopes('issues', ['releases'], true), 'issues,releases');
  assert.equal(mergeBoardScopes('', ['releases'], true), 'all');
  assert.equal(mergeBoardScopes('', ['releases'], false), 'releases');
});

test('worker-thread staging finalizer redacts secrets off-thread, hard-links unchanged shards, and re-redacts on credential change', async t => {
  const work = await mkdtemp(join(tmpdir(), 'board-worker-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const secretA = 'super_secret_deploy_key_AAA111';
  const secretB = 'rotated_deploy_secret_BBB222';
  const prevDir = join(work, 'prev');
  const stage1 = join(work, 'stage-1');
  await mkdir(join(stage1, 'board/data/history/records/issues'), { recursive: true });
  await mkdir(join(stage1, 'board/data/e2e'), { recursive: true });

  const normalText = 'normal diagnostic output with unicode 中文 and quotes "ok"';
  await writeFile(join(stage1, 'board/data/snapshot.json'), JSON.stringify({
    repository: { name: 'octo/hello' },
    note: `${normalText} | ${secretA} | ${Buffer.from(secretA).toString('base64')} | ${credentialExamples}`,
  }));
  // Historical shard containing secretB (not yet registered on run 1) and clean shard.
  await writeFile(join(stage1, 'board/data/history/records/issues/000000000000.json'), JSON.stringify({
    '1': { title: 'older item', body: `carries ${secretB} before rotation` },
  }));
  await writeFile(join(stage1, 'board/data/history/records/issues/000000000001.json'), JSON.stringify({
    '2': { title: 'clean item', body: normalText },
  }));
  await writeFile(join(stage1, 'gate.json'), '{"legacy":true}');
  await writeFile(join(stage1, 'board/data/e2e/index.json'), '{"legacy":true}');

  // Run 1 (initial full redaction in Worker with secretA only).
  const res1 = await runFinalizeBoardStagingWorker({
    stagingDir: stage1,
    redactorValues: [secretA],
    fullRedaction: true,
  });
  assert.equal(res1.snapshotRepoName, 'octo/hello');
  assert.equal(res1.redactedFiles, 5);
  assert.equal(res1.reusedFiles, 0);
  const snap1 = JSON.parse(await readFile(join(stage1, 'board/data/snapshot.json'), 'utf8'));
  assert.equal(snap1.note, `${normalText} | [REDACTED] | [REDACTED] | ${maskedExamples}`);

  // Run 2 (incremental, credential fingerprint unchanged): only snapshot.json is rewritten; shards are hard-linked untouched!
  await mkdir(prevDir, { recursive: true });
  const stage2 = join(work, 'stage-2');
  await mkdir(join(stage2, 'board/data'), { recursive: true });
  await writeFile(join(stage2, 'board/data/snapshot.json'), JSON.stringify({
    repository: { name: 'octo/hello' },
    note: `${normalText} | ${secretA}`,
  }));
  const res2 = await runFinalizeBoardStagingWorker({
    stagingDir: stage2,
    prevDir: stage1,
    redactorValues: [secretA],
    fullRedaction: false,
  });
  assert.equal(res2.snapshotRepoName, 'octo/hello');
  assert.equal(res2.redactedFiles, 1, 'only newly written snapshot.json is parsed and redacted');
  assert.equal(res2.reusedFiles, 2, 'two unchanged historical shards are reused via hard links');
  assert.equal(existsSync(join(stage2, 'gate.json')), false, 'retired gate.json is not inherited');
  assert.equal(existsSync(join(stage2, 'board/data/e2e/index.json')), false, 'retired e2e dir is not inherited');

  // Verify hard-link inode equality for unchanged shards and distinct inode for replaced snapshot.json.
  const prevShard0 = await stat(join(stage1, 'board/data/history/records/issues/000000000000.json'));
  const nextShard0 = await stat(join(stage2, 'board/data/history/records/issues/000000000000.json'));
  assert.equal(nextShard0.ino, prevShard0.ino);
  assert.equal(nextShard0.dev, prevShard0.dev);
  const prevSnapStat = await stat(join(stage1, 'board/data/snapshot.json'));
  const nextSnapStat = await stat(join(stage2, 'board/data/snapshot.json'));
  assert.notEqual(nextSnapStat.ino, prevSnapStat.ino);

  // Run 3 (credential fingerprint CHANGED -> secretB added -> fullRedaction: true):
  // historical shard containing secretB is rewritten with [REDACTED] without mutating stage2!
  const stage3 = join(work, 'stage-3');
  await mkdir(join(stage3, 'board/data'), { recursive: true });
  const res3 = await runFinalizeBoardStagingWorker({
    stagingDir: stage3,
    prevDir: stage2,
    redactorValues: [secretA, secretB],
    fullRedaction: true,
  });
  assert.equal(res3.snapshotRepoName, 'octo/hello');
  assert.equal(res3.redactedFiles, 3, 'all three JSON files are re-scanned when credentials change');
  assert.equal(res3.rewrittenFiles, 1, 'only the shard containing the newly registered secretB is rewritten');
  assert.equal(res3.reusedFiles, 2, 'unchanged clean files still reuse hard links');

  const stage3Shard0 = JSON.parse(await readFile(join(stage3, 'board/data/history/records/issues/000000000000.json'), 'utf8'));
  assert.equal(stage3Shard0['1'].body, 'carries [REDACTED] before rotation');
  // Previous generation stays untouched for concurrent readers during the 60s grace period.
  const stage2Shard0 = JSON.parse(await readFile(join(stage2, 'board/data/history/records/issues/000000000000.json'), 'utf8'));
  assert.equal(stage2Shard0['1'].body, `carries ${secretB} before rotation`);

  // Verify Worker redaction genuinely runs off the main event loop:
  // On a single large JSON file, in-process finalizeBoardStaging holds the main thread synchronously
  // for the entire JSON.parse + publicContent + JSON.stringify pass (high main-thread ELU active time),
  // whereas runFinalizeBoardStagingWorker executes that pass on the Worker thread and leaves the main
  // thread mostly idle while keeping heartbeat timers ticking.
  const bulkSecrets = [
    secretA,
    secretB,
    ...Array.from({ length: 18 }, (_, i) => `extra_registered_secret_token_${String(i).padStart(2, '0')}_XYZ987`),
  ];
  const heavyRecords = Object.fromEntries(
    Array.from({ length: 4000 }, (_, idx) => [
      String(idx),
      {
        title: `Run #${idx} ${secretA}`,
        summary: `prefix_${'a'.repeat(180)}_${secretB}_${credentialExamples}_${'b'.repeat(180)}`,
        output: `detail_${'c'.repeat(180)}_${bulkSecrets[idx % bulkSecrets.length]}`,
      },
    ]),
  );
  const heavyPayload = JSON.stringify(heavyRecords);
  const snapshotPayload = JSON.stringify({ repository: { name: 'octo/hello' } });

  const bulkMainDir = join(work, 'bulk-main');
  const bulkWorkerDir = join(work, 'bulk-worker');
  for (const dir of [bulkMainDir, bulkWorkerDir]) {
    await mkdir(join(dir, 'board/data/history/records/runs'), { recursive: true });
    await writeFile(join(dir, 'board/data/snapshot.json'), snapshotPayload);
    await writeFile(join(dir, 'board/data/history/records/runs/000000000000.json'), heavyPayload);
  }

  const mainEluStart = performance.eventLoopUtilization();
  const mainBulkResult = await finalizeBoardStaging({
    stagingDir: bulkMainDir,
    redactorValues: bulkSecrets,
    fullRedaction: true,
  });
  const mainElu = performance.eventLoopUtilization(mainEluStart);

  let ticks = 0;
  const heartbeat = setInterval(() => { ticks++; }, 5);
  const workerEluStart = performance.eventLoopUtilization();
  let bulkResult;
  try {
    bulkResult = await runFinalizeBoardStagingWorker({
      stagingDir: bulkWorkerDir,
      redactorValues: bulkSecrets,
      fullRedaction: true,
    });
  } finally {
    clearInterval(heartbeat);
  }
  const workerElu = performance.eventLoopUtilization(workerEluStart);

  assert.deepEqual(bulkResult, mainBulkResult);
  assert.equal(bulkResult.redactedFiles, 2);
  assert.equal(bulkResult.rewrittenFiles, 1);
  assert.equal(
    await readFile(join(bulkWorkerDir, 'board/data/history/records/runs/000000000000.json'), 'utf8'),
    await readFile(join(bulkMainDir, 'board/data/history/records/runs/000000000000.json'), 'utf8'),
  );
  assert.ok(mainElu.active >= 30, `expected in-process redaction to perform measurable main-thread CPU work (mainElu.active=${mainElu.active.toFixed(1)}ms)`);
  assert.ok(
    workerElu.active < mainElu.active * 0.4,
    `expected worker redaction to keep main-thread active time far below in-process (worker=${workerElu.active.toFixed(1)}ms, inProcess=${mainElu.active.toFixed(1)}ms)`,
  );
  assert.ok(ticks >= 1, `expected main-thread event loop to keep ticking during worker redaction (ticks=${ticks})`);

  // Also verify configuredRedactorFingerprint changes when a credential is added.
  const { store } = makeStore(t);
  const fp1 = configuredRedactorFingerprint(store);
  const endpointId = 'e'.repeat(48);
  const accountId = 'a'.repeat(48);
  store.run('INSERT INTO endpoints(id,account_id,secret) VALUES(?,?,?)',
    endpointId, accountId, store.secrets.seal({ value: secretB }, `endpoint:${endpointId}`));
  const fp2 = configuredRedactorFingerprint(store);
  assert.notEqual(fp1, fp2);
  // Direct in-process helper matches Worker behavior too.
  const direct = await finalizeBoardStaging({ stagingDir: stage3, redactorValues: [secretA, secretB], fullRedaction: false });
  assert.equal(direct.snapshotRepoName, 'octo/hello');
});

test('multi-repo incremental collectRepo matches full collection contract while skipping untouched domains and old pages', async t => {
  const work = await mkdtemp(join(tmpdir(), 'board-collect-inc-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const requests = [];
  const data = {
    repo: {
      html_url: 'https://github.com/octo/hello',
      description: 'Demo repo',
      homepage: 'https://example.test',
      default_branch: 'main',
      created_at: '2025-01-01T00:00:00Z',
      license: { spdx_id: 'Apache-2.0' },
      topics: ['automation'],
      stargazers_count: 10,
      forks_count: 2,
      subscribers_count: 3,
      open_issues_count: 2,
    },
    contributors: [
      { login: 'alice', type: 'User' },
      { login: 'bob', type: 'User' },
    ],
    pulls: [
      {
        number: 20, title: 'Recent PR', user: { login: 'alice', type: 'User' }, state: 'open', draft: false,
        created_at: '2026-06-01T08:00:00Z', updated_at: '2026-06-01T09:00:00Z', merged_at: null, closed_at: null,
        labels: [{ name: 'feat' }], html_url: 'https://github.com/octo/hello/pull/20',
      },
      {
        number: 10, title: 'Old PR', user: { login: 'bob', type: 'User' }, state: 'closed', draft: false,
        created_at: '2026-01-10T08:00:00Z', updated_at: '2026-01-12T08:00:00Z', merged_at: '2026-01-12T08:00:00Z', closed_at: '2026-01-12T08:00:00Z',
        labels: [], html_url: 'https://github.com/octo/hello/pull/10',
      },
      {
        number: 4, title: 'Older PR', user: { login: 'bob', type: 'User' }, state: 'closed', draft: false,
        created_at: '2025-12-01T08:00:00Z', updated_at: '2025-12-02T08:00:00Z', merged_at: '2025-12-02T08:00:00Z', closed_at: '2025-12-02T08:00:00Z',
        labels: [], html_url: 'https://github.com/octo/hello/pull/4',
      },
      {
        number: 2, title: 'Ancient PR', user: { login: 'alice', type: 'User' }, state: 'closed', draft: false,
        created_at: '2025-11-01T08:00:00Z', updated_at: '2025-11-02T08:00:00Z', merged_at: '2025-11-02T08:00:00Z', closed_at: '2025-11-02T08:00:00Z',
        labels: [], html_url: 'https://github.com/octo/hello/pull/2',
      },
    ],
    issues: [
      {
        number: 20, title: 'Recent PR', user: { login: 'alice', type: 'User' }, state: 'open',
        created_at: '2026-06-01T08:00:00Z', updated_at: '2026-06-01T09:00:00Z', closed_at: null,
        comments: 1, labels: [{ name: 'feat' }], html_url: 'https://github.com/octo/hello/pull/20', pull_request: {},
      },
      {
        number: 15, title: 'Open bug', user: { login: 'carol', type: 'User' }, state: 'open',
        created_at: '2026-04-01T00:00:00Z', updated_at: '2026-06-01T07:00:00Z', closed_at: null,
        comments: 2, labels: [{ name: 'bug' }], html_url: 'https://github.com/octo/hello/issues/15',
      },
      {
        number: 5, title: 'Old closed issue', user: { login: 'bob', type: 'User' }, state: 'closed',
        created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-06T00:00:00Z', closed_at: '2026-01-06T00:00:00Z',
        comments: 0, labels: [], html_url: 'https://github.com/octo/hello/issues/5',
      },
    ],
    releases: [
      { tag_name: 'v1.0.0', name: 'Release 1.0', published_at: '2026-05-01T00:00:00Z', prerelease: false, draft: false, html_url: 'https://github.com/octo/hello/releases/tag/v1.0.0' },
    ],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    requests.push(`${url.pathname}${url.search}`);
    const page = Number(url.searchParams.get('page') || 1);
    const send = (items, totalPages = 1) => {
      const headers = { 'Content-Type': 'application/json' };
      if (page < totalPages) {
        const next = new URL(url.href);
        next.searchParams.set('page', String(page + 1));
        headers.Link = `<${next.href}>; rel="next"`;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(items));
    };
    const paginateList = (list, sortField) => {
      let sorted = [...list].sort((a, b) => (b[sortField] || '').localeCompare(a[sortField] || '') || b.number - a.number);
      const since = url.searchParams.get('since');
      if (since) sorted = sorted.filter(item => (item.updated_at || '') >= since);
      // 1 item per page to verify stopWhen halts pagination before fetching older pages!
      const pageSize = 1;
      const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
      send(sorted.slice((page - 1) * pageSize, page * pageSize), totalPages);
    };
    if (url.pathname === '/repos/octo/hello') return send(data.repo);
    if (url.pathname === '/repos/octo/hello/contributors') return send(data.contributors);
    if (url.pathname === '/repos/octo/hello/releases') return send(data.releases);
    if (url.pathname === '/repos/octo/hello/pulls') {
      return paginateList(data.pulls, url.searchParams.get('sort') === 'updated' ? 'updated_at' : 'created_at');
    }
    if (url.pathname === '/repos/octo/hello/issues') {
      return paginateList(data.issues, url.searchParams.get('sort') === 'updated' ? 'updated_at' : 'created_at');
    }
    res.writeHead(404); res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const repo = { owner: 'octo', name: 'hello', fullName: 'octo/hello' };
  const makeCfg = outDir => ({
    repos: [repo],
    config: { internalContributors: { 'octo/hello': ['alice'] }, bots: ['dependabot[bot]'], longOpenIssueDays: 30 },
    token: 'test-token',
    outDir,
    maxListPages: 20,
    schemaVersion: 1,
    releaseOverrides: {},
  });
  const client = new GitHubClient({ token: 'test-token', apiBase });
  const stateFile = join(work, '.community-sync.json');

  // 1. Baseline full collection at T1.
  const t1 = new Date('2026-06-01T10:00:00Z');
  const gen1Dir = join(work, 'gen1');
  await collectRepo(repo, makeCfg(gen1Dir), client, t1, () => {}, { stateFile });
  const meta1 = JSON.parse(await readFile(join(gen1Dir, 'octo/hello/meta.json'), 'utf8'));
  assert.equal(meta1.status, 'ok', JSON.stringify(meta1.errors));

  // 2. Single-repo CI-only event on same UTC day -> ZERO API requests and ZERO rewritten files!
  requests.length = 0;
  const genCiDir = join(work, 'gen-ci');
  const summaryCi = await collectRepo(repo, makeCfg(genCiDir), client, new Date('2026-06-01T10:15:00Z'), () => {}, {
    prevDir: gen1Dir, stateFile, dirtyScopes: ['ci'],
  });
  assert.equal(requests.length, 0, 'CI-only update makes zero community API requests');
  assert.equal(existsSync(join(genCiDir, 'octo/hello/latest.json')), false, 'CI-only update writes no community files');
  assert.equal(summaryCi.fullName, 'octo/hello');

  // 3. Mutate issues + PR comment count + PR state at T2, then compare incremental vs fresh full collection.
  const t2 = new Date('2026-06-01T11:00:00Z');
  data.repo.stargazers_count = 12;
  data.repo.open_issues_count = 2;
  data.issues[0].comments = 4;
  data.issues[0].updated_at = '2026-06-01T10:50:00Z';
  data.issues[1].state = 'closed';
  data.issues[1].closed_at = '2026-06-01T10:45:00Z';
  data.issues[1].updated_at = '2026-06-01T10:45:00Z';
  data.issues.unshift({
    number: 25, title: 'New issue', user: { login: 'dave', type: 'User' }, state: 'open',
    created_at: '2026-06-01T10:55:00Z', updated_at: '2026-06-01T10:55:00Z', closed_at: null,
    comments: 0, labels: [{ name: 'triage' }], html_url: 'https://github.com/octo/hello/issues/25',
  });

  requests.length = 0;
  const gen2Dir = join(work, 'gen2');
  await collectRepo(repo, makeCfg(gen2Dir), client, t2, () => {}, {
    prevDir: gen1Dir, stateFile, dirtyScopes: ['issues'],
  });
  assert.ok(requests.some(r => r.startsWith('/repos/octo/hello/issues?state=all&sort=updated&direction=desc&since=')));
  assert.ok(!requests.some(r => r.includes('/pulls')), `should not fetch pulls: ${JSON.stringify(requests)}`);
  assert.ok(!requests.some(r => r.includes('/contributors')), `should not fetch contributors: ${JSON.stringify(requests)}`);
  assert.ok(!requests.some(r => r.includes('/releases')), `should not fetch releases: ${JSON.stringify(requests)}`);
  assert.equal(existsSync(join(gen2Dir, 'octo/hello/releases.json')), false, 'untouched releases.json is skipped for hardlink reuse');

  // Fresh full collection at the exact same T2 timestamp for strict contract equivalence check.
  const fullT2Dir = join(work, 'full-t2');
  await collectRepo(repo, makeCfg(fullT2Dir), client, t2, () => {});

  for (const name of ['latest.json', 'issues.json', 'pulls.json', 'contributors.json', 'history.json']) {
    const inc = JSON.parse(await readFile(join(gen2Dir, 'octo/hello', name), 'utf8'));
    const full = JSON.parse(await readFile(join(fullT2Dir, 'octo/hello', name), 'utf8'));
    assert.deepEqual(inc, full, `incremental ${name} must match full collection contract`);
  }

  // 4. Incremental PR update stops early before fetching old PR page.
  const t3 = new Date('2026-06-01T12:00:00Z');
  data.pulls[0].state = 'closed';
  data.pulls[0].merged_at = '2026-06-01T11:30:00Z';
  data.pulls[0].closed_at = '2026-06-01T11:30:00Z';
  data.pulls[0].updated_at = '2026-06-01T11:30:00Z';
  data.pulls.unshift({
    number: 26, title: 'Brand new PR', user: { login: 'eve', type: 'User' }, state: 'open', draft: true,
    created_at: '2026-06-01T11:45:00Z', updated_at: '2026-06-01T11:45:00Z', merged_at: null, closed_at: null,
    labels: [], html_url: 'https://github.com/octo/hello/pull/26',
  });
  data.issues.unshift({
    number: 26, title: 'Brand new PR', user: { login: 'eve', type: 'User' }, state: 'open',
    created_at: '2026-06-01T11:45:00Z', updated_at: '2026-06-01T11:45:00Z', closed_at: null,
    comments: 0, labels: [], html_url: 'https://github.com/octo/hello/pull/26', pull_request: {},
  });

  // Note: gen2Dir skipped writing releases.json because it came from gen1Dir; copy releases.json to gen2Dir to simulate hardlinked snapshot.
  await writeFile(join(gen2Dir, 'octo/hello/releases.json'), await readFile(join(gen1Dir, 'octo/hello/releases.json')));
  requests.length = 0;
  const gen3Dir = join(work, 'gen3');
  await collectRepo(repo, makeCfg(gen3Dir), client, t3, () => {}, {
    prevDir: gen2Dir, stateFile, dirtyScopes: ['pulls'],
  });
  const pullReqs = requests.filter(r => r.includes('/pulls'));
  assert.ok(pullReqs.every(r => r.includes('sort=updated&direction=desc')));
  assert.equal(pullReqs.length, 3, `expected early stop on first old PR page before fetching older pages: ${JSON.stringify(pullReqs)}`);
  assert.ok(!requests.some(r => r.includes('/issues')), 'pulls-only update does not fetch issues');
  assert.ok(!requests.some(r => r.includes('/releases')), 'pulls-only update does not fetch releases');

  const fullT3Dir = join(work, 'full-t3');
  await collectRepo(repo, makeCfg(fullT3Dir), client, t3, () => {});
  for (const name of ['pulls.json', 'contributors.json', 'history.json']) {
    const inc = JSON.parse(await readFile(join(gen3Dir, 'octo/hello', name), 'utf8'));
    const full = JSON.parse(await readFile(join(fullT3Dir, 'octo/hello', name), 'utf8'));
    assert.deepEqual(inc, full, `incremental pulls ${name} must match full collection contract`);
  }

  // 5. fullReconcileMs = 0 disables periodic reconciliation even after >24h; positive interval triggers drift-healing full reconcile.
  await writeFile(join(gen3Dir, 'octo/hello/issues.json'), await readFile(join(gen2Dir, 'octo/hello/issues.json')));
  await writeFile(join(gen3Dir, 'octo/hello/releases.json'), await readFile(join(gen2Dir, 'octo/hello/releases.json')));
  data.releases.unshift({
    tag_name: 'v1.1.0', name: 'Release 1.1', published_at: '2026-06-02T11:00:00Z', prerelease: false, draft: false,
    html_url: 'https://github.com/octo/hello/releases/tag/v1.1.0',
  });
  requests.length = 0;
  const gen4DisabledDir = join(work, 'gen4-disabled');
  await collectRepo(repo, makeCfg(gen4DisabledDir), client, new Date('2026-06-02T12:00:00Z'), () => {}, {
    prevDir: gen3Dir, stateFile, dirtyScopes: ['ci'], fullReconcileMs: 0,
  });
  assert.equal(requests.length, 0, `fullReconcileMs=0 must disable periodic full reconciliation: ${JSON.stringify(requests)}`);

  requests.length = 0;
  const gen4Dir = join(work, 'gen4');
  await collectRepo(repo, makeCfg(gen4Dir), client, new Date('2026-06-02T12:00:00Z'), () => {}, {
    prevDir: gen3Dir, stateFile, dirtyScopes: ['ci'], fullReconcileMs: 24 * 60 * 60 * 1000,
  });
  assert.ok(requests.some(r => r.includes('/releases')), 'periodic reconciliation refreshes releases');
  assert.ok(requests.some(r => r.includes('/pulls?state=all&sort=created')), 'periodic reconciliation runs full pulls fetch');
  const releases4 = JSON.parse(await readFile(join(gen4Dir, 'octo/hello/releases.json'), 'utf8'));
  assert.deepEqual(releases4.items.map(r => r.tag), ['v1.1.0', 'v1.0.0']);
});
