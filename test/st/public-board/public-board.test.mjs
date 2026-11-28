import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialExamples, maskedExamples } from '../../fixtures/public-credentials.mjs';
import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { calendarRuns, publicBoardFixture } from '../../fixtures/public-board-fixtures.mjs';
import { PublicBoards } from '../../../dist/public-board/service.js';
import { testPassword } from '../../fixtures/helpers.mjs';

test('snapshot, history and dashboard data retain diagnostic text and mask only matching credentials', async t => {
  const sample = 'token = "my_custom_identifier_12345"\\n-----BEGIN CERTIFICATE-----';
  const { boards, hook, get, h } = await publicBoardFixture(t, async ({directory, repository, token}) => {
    const text = [sample, Buffer.from(token).toString('base64'), credentialExamples, 'end'].join(' | ');
    await mkdir(directory+'/board/data/history',{recursive:true});
    await writeFile(directory+'/board/data/snapshot.json',JSON.stringify({repository:{name:repository.full_name},text}));
    await writeFile(directory+'/board/data/history/manifest.json',JSON.stringify({text}));
    await writeFile(directory+'/summary.json',JSON.stringify({text}));
  });
  await hook('redaction'); await boards.drain();
  const root = h.store.get('SELECT active_path FROM public_board_jobs').active_path;
  const expected = sample+' | [REDACTED] | '+maskedExamples+' | end';
  for (const path of ['board/data/snapshot.json','board/data/history/manifest.json','summary.json'])
    assert.equal(JSON.parse(await readFile(root+'/'+path,'utf8')).text,expected);
  assert.equal((await get('/dashboard/data/index.json')).data.repos[0].text,expected);
});

test('verified deliveries update both public contracts through the real local collectors on the webhook listener', async t => {
  const { h, boards, state, hook, get } = await publicBoardFixture(t);
  for (const path of ['/dashboard/', '/boards/octo/hello/']) assert.equal((await fetch(h.webhook + path)).status, 200);
  // The console shares the listener; public boards need no session, while its API still does.
  assert.equal((await fetch(h.webhook + '/api/users')).status, 401);
  assert.equal((await hook('bad', { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) })).status, 401);
  assert.equal(h.store.get('SELECT count(*) n FROM public_board_jobs').n, 0);
  assert.equal((await hook('first')).status, 200);
  await boards.drain();
  const job = h.store.get('SELECT * FROM public_board_jobs');
  assert.equal(job.last_error, null, JSON.stringify(job));
  assert.equal(job.collected_generation, 1);
  const snapshot = (await get('/boards/octo/hello/data/snapshot.json')).data;
  assert.equal(snapshot.repository.name, 'octo/hello');
  assert.equal(snapshot.repository.stars, 1);
  assert.ok(snapshot.sections.ci);
  // Generic data only (#938): no gate verdicts, test reports or coverage, whatever the repository's CI looks like.
  assert.equal(snapshot.schema_version, 5);
  assert.deepEqual(Object.keys(snapshot.sections).sort(), ['ci', 'issues', 'ops', 'prs', 'repo', 'scheduled']);
  assert.equal(snapshot.sections.ci.data.gates, undefined);
  assert.equal((await get('/boards/octo/hello/data/history/manifest.json')).status, 200);
  assert.deepEqual((await get('/dashboard/data/index.json')).data.repos.map(r => r.fullName), ['octo/hello']);
  // The gate page's data and the E2E records are gone with them.
  for (const path of ['/dashboard/data/gate/index.json', '/dashboard/data/gate/octo/hello.json', '/boards/octo/hello/data/e2e/index.json', '/boards/octo/hello/e2e/1/index.html'])
    assert.equal((await get(path)).status, 404, path);
  assert.equal((await get('/dashboard/data/octo/hello/latest.json')).data.repo.stars, 1);
  const html = await (await fetch(h.webhook + '/dashboard/')).text();
  for (const asset of [...html.matchAll(/(?:src|href)="(\/dashboard\/[^"#]+)"/g)].map(m => m[1])) assert.equal((await fetch(h.webhook + asset)).status, 200, asset);
  assert.equal((await fetch(h.webhook + '/boards/octo/hello/.sync/state.json')).status, 404);
  assert.equal((await fetch(h.webhook + '/boards/octo/hello/data/%2e%2e/secret.json')).status, 404);
  const generation = job.generation;
  assert.equal((await hook('first')).value.duplicate, true);
  assert.equal(h.store.get('SELECT generation FROM public_board_jobs').generation, generation);
  state.stars = 9;
  await hook('second'); await boards.drain();
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).data.repository.stars, 9);
  assert.equal((await get('/boards/octo/hello/data/history/manifest.json')).status, 200);
  assert.equal((await get('/dashboard/data/octo/hello/latest.json')).data.repo.stars, 9);
  assert.ok(state.requests.filter(r => !['GET', 'DELETE'].includes(r.method)).every(r => r.path.endsWith('/access_tokens')));
  assert.ok(state.requests.filter(r => r.path.endsWith('/access_tokens')).every(r => r.body.repository_ids[0] === 101 && Object.values(r.body.permissions).every(p => p === 'read')));
  assert.equal(state.tokens, state.revoked);
  assert.ok(!JSON.stringify(snapshot).includes('ghs_fixture_read'));
  const otherAccount = 'f'.repeat(48);
  h.store.run(`INSERT INTO accounts(id,name,type,credentials,created_at) VALUES(?,?,'bot_account',?,?)`, otherAccount, 'Second coverage', h.store.secrets.seal({ token: 'fixture-second-token' }, `account:${otherAccount}`), new Date().toISOString());
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    SELECT ?,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at FROM installed_repositories LIMIT 1`, otherAccount);
  assert.equal((await get('/dashboard/data/index.json')).data.repos.length, 1);
  state.private = true; await hook('visibility-private');
  assert.equal(h.store.get('SELECT count(*) n FROM installed_repositories WHERE private=1').n, 2);
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 404);
  assert.deepEqual((await get('/dashboard/data/index.json')).data.repos, []);
});

test('the Actions calendar groups every trigger, keeps reruns on their creation day and distinguishes uncollected days', async t => {
  const { boards, state, hook, get } = await publicBoardFixture(t);
  state.runs = false;
  state.failRunBackfill = true;
  const date = calendarRuns(state);
  await hook('calendar'); await boards.drain();
  const read = async () => (await get('/boards/octo/hello/data/snapshot.json')).data.sections.ci.data.lanes;
  const { zone, days, rows } = await read();
  assert.equal(zone, 'Asia/Shanghai');
  assert.equal(days.length, 30);
  const i = days.findIndex(day => day.date === date);
  assert.equal(i, 27);
  assert.ok(days.slice(0, i - 1).every(day => !day.collected));
  assert.ok(days.slice(i - 1).every(day => day.collected));
  const byLane = Object.fromEntries(rows.map(row => [row.key, row.days]));
  const ids = Object.fromEntries(rows.map(row => [row.key, row.days.flat().map(run => run.id)]));
  assert.deepEqual(ids, { pr: [8100, 8101, 8102], merge_queue: [8103], daily: [8104, 8105],
    release: [8106, 8107], main: [8108, 8109], other: [8110, 8111] });
  assert.deepEqual(byLane.pr[i].map(run => run.time), ['00:00:05', '00:00:30']);
  const [retry] = byLane.pr[i - 1];
  assert.deepEqual([retry.name, retry.attempt, retry.conclusion, retry.duration_s, retry.time, retry.sha],
    ['Build packages', 2, 'success', 45, '23:59:00', 'bcdef01']);
  assert.equal(byLane.other[i][1].duration_s, null);
  assert.ok(!state.requests.some(r => /actions\/runs\/(8100|8103|8111)\/artifacts/.test(r.path)));
  // Once the scan reaches repository creation, the earlier empty days are known.
  state.failRunBackfill = false;
  await hook('completed-backfill'); await boards.drain();
  assert.ok((await read()).days.every(day => day.collected));
});

test('installation seeds initial collection and repositories without CI still get their community data and board', async t => {
  const { boards, state, get } = await publicBoardFixture(t);
  state.runs = false; boards.seed(); await boards.drain();
  assert.equal((await get('/dashboard/data/index.json')).data.repos.length, 1);
  const snapshot = (await get('/boards/octo/hello/data/snapshot.json')).data;
  assert.equal(snapshot.repository.name, 'octo/hello');
  assert.deepEqual(snapshot.sections.ci.data.workflows.filter(w => w.all.total), []);
});

test('private exports stay absent until explicit local consent and are withdrawn immediately on uninstall', async t => {
  const { h, boards, admin, state, hook, get } = await publicBoardFixture(t);
  state.private = true; h.store.run('UPDATE installed_repositories SET private=1');
  await hook('private-unapproved'); boards.seed(); await boards.drain();
  assert.equal(h.store.get('SELECT count(*) n FROM public_board_jobs').n, 0);
  assert.equal((await fetch(h.webhook + '/boards/octo/hello/')).status, 404);
  assert.deepEqual((await get('/dashboard/data/index.json')).data.repos, []);
  assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled: true })).status, 200);
  await hook('private-approved'); await boards.drain();
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 200);
  assert.equal((await get('/dashboard/data/index.json')).data.repos.length, 1);
  assert.ok(!state.requests.some(r => r.path.includes('/dashboard') || r.path.endsWith('/pulls') && r.method === 'POST'));
  h.store.run('UPDATE installed_repositories SET installed=0');
  assert.equal((await fetch(h.webhook + '/boards/octo/hello/data/snapshot.json')).status, 404);
  assert.deepEqual((await get('/dashboard/data/index.json')).data.repos, []);
});

test('pending generations survive service restart, failures preserve data, and events arriving during collection are retained', async t => {
  const { h, boards, state, hook, get } = await publicBoardFixture(t);
  await hook('initial'); await boards.drain();
  state.fail = true; await hook('failure'); await boards.drain();
  assert.equal(h.store.get('SELECT last_error FROM public_board_jobs').last_error, 'collection_failed');
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).data.repository.stars, 1);
  state.fail = false; state.stars = 3;
  await hook('restart');
  const restarted = new PublicBoards(h.store, boards.directory, boards.apiUrl, async input => {
    await hook('during-collection'); await boards.collector(input);
  });
  await restarted.drain();
  const pending = h.store.get('SELECT * FROM public_board_jobs');
  assert.ok(pending.generation > pending.collected_generation);
  const final = new PublicBoards(h.store, boards.directory, boards.apiUrl); await final.drain();
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).data.repository.stars, 3);
  assert.equal(h.store.get('SELECT generation=collected_generation ok FROM public_board_jobs').ok, 1);
  const files = await readdir(boards.directory, { recursive: true });
  assert.ok(files.some(f => f.endsWith('.sync/state.json')));
  const output = await readFile(h.store.get('SELECT active_path FROM public_board_jobs').active_path + '/board/data/snapshot.json', 'utf8');
  assert.ok(!output.includes('ghs_fixture_read'));
});

test('list switches work before project activation, public defaults on, and private defaults off', async t => {
  const { h, admin, state, hook } = await publicBoardFixture(t);
  const listed = async () => (await admin('/api/installations')).value.repositories.find(row => row.id === '101');
  assert.equal((await listed()).registered, false);
  assert.equal((await listed()).board_enabled, true);
  state.private = true; await hook('private-default');
  assert.equal((await listed()).board_enabled, false);
  const requests = state.requests.length;
  assert.deepEqual((await admin('/api/installations/101/board', 'PATCH', { enabled: true })).value.board.state, 'collecting');
  assert.equal((await listed()).board_enabled, true);
  assert.equal((await listed()).registered, false);
  assert.equal(state.requests.length, requests, 'Changing publication is local and does not call GitHub');
  assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled: false })).value.board.enabled, false);
  assert.equal((await listed()).board_enabled, false);
});

test('turning off removes snapshots and the dashboard data immediately and persists through restart', async t => {
  const { h, boards, admin, hook, get } = await publicBoardFixture(t);
  await hook('publish'); await boards.drain();
  const generation = h.store.get('SELECT generation FROM public_board_jobs').generation;
  assert.equal((await get('/dashboard/data/index.json')).data.repos.length, 1);
  assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled: false })).status, 200);
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 404);
  assert.equal((await get('/dashboard/data/octo/hello/latest.json')).status, 404);
  assert.deepEqual((await get('/dashboard/data/index.json')).data.repos, []);
  await hook('while-off'); boards.seed(); await boards.drain();
  assert.equal(h.store.get('SELECT generation FROM public_board_jobs').generation, generation);
  await h.stop(); await h.start();
  assert.equal((await admin('/api/installations')).value.repositories[0].board_enabled, false);
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 404);
  assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled: true })).status, 200);
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 200);
  assert.equal((await get('/dashboard/data/index.json')).data.repos.length, 1);
});

test('saved choices survive visibility changes while unsaved repositories follow the new default', async t => {
  const { admin, state, hook, get } = await publicBoardFixture(t);
  const enabled = async () => (await admin('/api/installations')).value.repositories[0].board_enabled;
  assert.equal(await enabled(), true);
  state.private = true; await hook('unsaved-private'); assert.equal(await enabled(), false);
  state.private = false; await hook('unsaved-public'); assert.equal(await enabled(), true);
  await admin('/api/installations/101/board', 'PATCH', { enabled: true });
  state.private = true; await hook('saved-on-private'); assert.equal(await enabled(), true);
  state.private = false; await hook('saved-on-public'); assert.equal(await enabled(), true);
  await admin('/api/installations/101/board', 'PATCH', { enabled: false });
  state.private = true; await hook('saved-off-private'); assert.equal(await enabled(), false);
  state.private = false; await hook('saved-off-public'); assert.equal(await enabled(), false);
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 404);
});

test('legacy private consent migrates once without reviving a saved off switch', async t => {
  const { h, owner, admin } = await publicBoardFixture(t);
  h.store.run('UPDATE installed_repositories SET private=1');
  h.store.run('INSERT INTO public_board_consents VALUES(?,?)', owner.id, '101');
  await h.stop(); await h.start();
  assert.equal((await admin('/api/installations')).value.repositories[0].board_enabled, true);
  await admin('/api/installations/101/board', 'PATCH', { enabled: false });
  await h.stop(); await h.start();
  assert.equal((await admin('/api/installations')).value.repositories[0].board_enabled, false);
});

test('switch mutations require a super administrator, CSRF, an installed repository, and a boolean', async t => {
  const { h, admin } = await publicBoardFixture(t);
  assert.equal((await h.client()('/api/installations/101/board', 'PATCH', { enabled: false })).status, 401);
  assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled: false }, { 'X-CSRF-Token': '' })).status, 403);
  for (const enabled of ['false', 0, null]) assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled })).status, 400);
  assert.equal((await admin('/api/installations/999/board', 'PATCH', { enabled: true })).status, 404);
  const password = testPassword(), member = h.client();
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] });
  await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member('/api/installations/101/board', 'PATCH', { enabled: true })).status, 403);
  h.store.run('UPDATE installed_repositories SET installed=0');
  assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled: true })).status, 404);
});

test('turning off during collection prevents the in-flight snapshot from being published', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), collecting = new Promise(resolve => { entered = resolve; });
  const { h, boards, admin, hook, get } = await publicBoardFixture(t, async input => {
    await mkdir(input.directory + '/board/data', { recursive: true });
    await writeFile(input.directory + '/board/data/snapshot.json', JSON.stringify({ repository: { name: input.repository.full_name } }));
    entered(); await waiting;
  });
  await hook('in-flight'); const work = boards.drain(); await collecting;
  await admin('/api/installations/101/board', 'PATCH', { enabled: false });
  release(); await work;
  assert.equal(h.store.get('SELECT active_path FROM public_board_jobs').active_path, null);
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 404);
});

// #938: a board published by an older version still has the gate page's data, E2E record pages and, in its private
// state, tagged catalogs, coverage stores and run records with test reports. The next collection removes them.
test('collecting again after the upgrade removes what the gate, coverage and E2E views left, published and private', async t => {
  const { h, boards, hook, get } = await publicBoardFixture(t);
  const { join } = await import('node:path'), { existsSync } = await import('node:fs');
  await hook('first'); await boards.drain();
  const job = h.store.get('SELECT * FROM public_board_jobs'), stateDir = join(boards.directory, job.account_id, job.repository_id, 'state');
  // What the older collector wrote beside the generic data.
  await writeFile(join(job.active_path, 'gate.json'), '{"branchData":[]}');
  for (const dir of ['board/e2e/7', 'board/data/e2e']) await mkdir(join(job.active_path, dir), { recursive: true });
  await writeFile(join(job.active_path, 'board/e2e/7/index.html'), '<p>old</p>');
  await writeFile(join(job.active_path, 'board/data/e2e/index.json'), '{"records":[]}');
  for (const name of ['tagged.json', 'coverage.json', 'coverage-sources.json']) await writeFile(join(stateDir, '.sync', name), '{}');
  const sync = JSON.parse(await readFile(join(stateDir, '.sync/state.json'), 'utf8'));
  delete sync.retired_fields; await writeFile(join(stateDir, '.sync/state.json'), JSON.stringify(sync));
  const records = join(stateDir, 'site/data/history/records/runs'), [shard] = await readdir(records);
  const stored = JSON.parse(await readFile(join(records, shard), 'utf8'));
  for (const run of Object.values(stored)) Object.assign(run, { channel: 'gate', tests: [{ name: 'ut-results', counts: { tests: 3 } }], coverage: [{ lines: 80 }], reports_status: 'available' });
  await writeFile(join(records, shard), JSON.stringify(stored));

  await hook('after-upgrade'); await boards.drain();
  const active = h.store.get('SELECT active_path FROM public_board_jobs').active_path;
  assert.notEqual(active, job.active_path);
  for (const path of ['gate.json', 'board/e2e', 'board/data/e2e']) assert.equal(existsSync(join(active, path)), false, path);
  for (const name of ['tagged.json', 'coverage.json', 'coverage-sources.json']) assert.equal(existsSync(join(stateDir, '.sync', name)), false, name);
  // The run records, private and published, keep only the generic fields; the former "gate" channel is "ci".
  for (const file of [join(records, shard), join(active, 'board/data/history/records/runs', shard)]) {
    const runs = Object.values(JSON.parse(await readFile(file, 'utf8')));
    assert.ok(runs.length > 0, file);
    for (const run of runs) {
      assert.equal(run.channel, 'ci', file);
      for (const field of ['tests', 'coverage', 'reports_status']) assert.equal(field in run, false, `${file}: ${field}`);
    }
  }
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).data.schema_version, 5);
});

test('noise events are filtered, cooldown coalesces repeated webhooks, and unchanged shards reuse hard links until credentials rotate', async t => {
  let clock = 10_000_000;
  const finalized = [];
  let runCount = 0;
  const rotatedSecret = 'newly_registered_model_secret_987654321';
  const { h, boards, admin, hook, get } = await publicBoardFixture(t, async input => {
    runCount++;
    await mkdir(input.directory + '/board/data/history/records/issues', { recursive: true });
    await writeFile(input.directory + '/board/data/snapshot.json', JSON.stringify({
      repository: { name: input.repository.full_name },
      run: runCount,
      scopes: input.dirtyScopes,
    }));
    await writeFile(input.directory + '/summary.json', JSON.stringify({ fullName: input.repository.full_name, run: runCount }));
    // Only write the historical shard on run 1; later runs inherit it via hard link.
    if (runCount === 1) {
      await writeFile(input.directory + '/board/data/history/records/issues/000000000000.json', JSON.stringify({
        '1': { body: `historical shard mentioning ${rotatedSecret}` },
      }));
    }
  }, {
    cooldownMs: 5 * 60_000,
    now: () => clock,
    onFinalized: info => finalized.push(info),
  });

  // Noise events never enqueue a job.
  for (const [id, event] of [['n1', 'check_run'], ['n2', 'status'], ['n3', 'workflow_job'], ['n4', 'deployment_status']]) {
    assert.equal((await hook(id, { 'X-GitHub-Event': event })).status, 200);
  }
  assert.equal(h.store.get('SELECT count(*) n FROM public_board_jobs').n, 0);

  // First real webhook runs immediately (active_path IS NULL), even with a 5-minute cooldown configured.
  assert.equal((await hook('first-issue', { 'X-GitHub-Event': 'issues' })).status, 200);
  await boards.drain();
  assert.equal(runCount, 1);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].fullRedaction, true);
  const firstActive = h.store.get('SELECT active_path FROM public_board_jobs').active_path;
  const firstShardStat = await stat(firstActive + '/board/data/history/records/issues/000000000000.json');

  // Webhooks within the 5-minute cooldown coalesce and do not trigger collection early.
  clock += 30_000;
  assert.equal((await hook('pr-1', { 'X-GitHub-Event': 'pull_request' })).status, 200);
  clock += 30_000;
  assert.equal((await hook('issue-2', { 'X-GitHub-Event': 'issues' })).status, 200);
  await boards.drain();
  assert.equal(runCount, 1, 'drain within cooldown window performs no collection');

  // Advancing past cooldown runs a single coalesced collection with merged scopes and hard-linked untouched shard.
  clock = 10_000_000 + 5 * 60_000;
  await boards.drain();
  assert.equal(runCount, 2);
  assert.equal(finalized.length, 2);
  assert.equal(finalized[1].fullRedaction, false);
  assert.equal(finalized[1].result.reusedFiles, 1, 'unchanged historical shard skipped re-redaction');
  const secondActive = h.store.get('SELECT active_path FROM public_board_jobs').active_path;
  const secondShardStat = await stat(secondActive + '/board/data/history/records/issues/000000000000.json');
  assert.equal(secondShardStat.ino, firstShardStat.ino, 'unchanged historical shard shares inode via hard link');
  assert.deepEqual((await get('/boards/octo/hello/data/snapshot.json')).data.scopes, ['issues', 'pulls']);

  // Adding a new deployment credential immediately protects live reads AND forces full re-redaction on next build.
  const modelId = 'm'.repeat(48);
  h.store.run(
    `INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES(?,NULL,'https://api.example','gpt',?,1,?)`,
    modelId, h.store.secrets.seal({ value: rotatedSecret }, `model:${modelId}`), new Date().toISOString(),
  );
  // Before the next collection runs, HTTP serve detects the fingerprint mismatch and redacts live.
  const liveShard = (await get('/boards/octo/hello/data/history/records/issues/000000000000.json')).data;
  assert.equal(liveShard['1'].body, 'historical shard mentioning [REDACTED]');

  // Manual board enable bypasses cooldown immediately and re-redacts the historical shard off the main thread.
  clock += 5_000;
  assert.equal((await admin('/api/installations/101/board', 'PATCH', { enabled: true })).status, 200);
  await boards.drain();
  assert.equal(runCount, 3);
  assert.equal(finalized[2].fullRedaction, true);
  assert.equal(finalized[2].result.rewrittenFiles, 1);
  const thirdActive = h.store.get('SELECT active_path FROM public_board_jobs').active_path;
  const thirdDisk = JSON.parse(await readFile(thirdActive + '/board/data/history/records/issues/000000000000.json', 'utf8'));
  assert.equal(thirdDisk['1'].body, 'historical shard mentioning [REDACTED]');
  // The previous snapshot remains immutable on disk during its 60s concurrent-read grace period.
  const secondDisk = JSON.parse(await readFile(secondActive + '/board/data/history/records/issues/000000000000.json', 'utf8'));
  assert.equal(secondDisk['1'].body, `historical shard mentioning ${rotatedSecret}`);
});
