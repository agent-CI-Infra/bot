import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { publicBoardFixture } from './public-board-fixtures.mjs';
import { PublicBoards } from '../dist/public-board/service.js';

test('verified deliveries update both public contracts through the real local collectors on the webhook listener', async t => {
  const { h, boards, state, hook, get } = await publicBoardFixture(t);
  for (const path of ['/dashboard/', '/boards/octo/hello/']) {
    assert.equal((await fetch(h.webhook + path)).status, 200);
    assert.equal((await fetch(h.admin + path)).status, 404);
  }
  assert.equal((await fetch(h.webhook + '/')).status, 404);
  assert.equal((await fetch(h.webhook + '/api/setup')).status, 404);
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
  assert.equal((await get('/boards/octo/hello/data/history/manifest.json')).status, 200);
  assert.equal((await get('/boards/octo/hello/data/e2e/index.json')).status, 200);
  assert.deepEqual((await get('/dashboard/data/index.json')).data.repos.map(r => r.fullName), ['octo/hello']);
  assert.deepEqual((await get('/dashboard/data/gate/index.json')).data.sources.map(r => r.id), ['octo/hello']);
  assert.equal((await get('/dashboard/data/gate/octo/hello.json')).data.boardUrl, '/boards/octo/hello/');
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

test('installation seeds initial collection and repositories without CI retain community data without fabricated gate rows', async t => {
  const { boards, state, get } = await publicBoardFixture(t);
  state.runs = false; boards.seed(); await boards.drain();
  assert.equal((await get('/dashboard/data/index.json')).data.repos.length, 1);
  assert.deepEqual((await get('/dashboard/data/gate/index.json')).data.sources, []);
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).data.repository.name, 'octo/hello');
});

test('private exports stay absent until explicit local consent and are withdrawn immediately on uninstall', async t => {
  const { h, boards, quickstart, state, hook, get } = await publicBoardFixture(t);
  state.private = true; h.store.run('UPDATE installed_repositories SET private=1');
  await hook('private-unapproved'); boards.seed(); await boards.drain();
  assert.equal(h.store.get('SELECT count(*) n FROM public_board_jobs').n, 0);
  assert.equal((await fetch(h.webhook + '/boards/octo/hello/')).status, 404);
  assert.deepEqual((await get('/dashboard/data/index.json')).data.repos, []);
  const started = quickstart.start('101', false, ['board']);
  for (let i = 0; i < 100 && ['queued', 'running'].includes(quickstart.get(started.id).state); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(quickstart.get(started.id).state, 'done', JSON.stringify(quickstart.get(started.id)));
  await hook('private-approved'); await boards.drain();
  assert.equal((await get('/boards/octo/hello/data/snapshot.json')).status, 200);
  assert.equal((await get('/dashboard/data/index.json')).data.repos.length, 1);
  assert.ok(!state.requests.some(r => r.path.includes('/dashboard') || r.path.endsWith('/pulls') && r.method === 'POST'));
  h.store.run('UPDATE installed_repositories SET installed=0');
  assert.equal((await fetch(h.webhook + '/boards/octo/hello/data/snapshot.json')).status, 404);
  assert.deepEqual((await get('/dashboard/data/gate/index.json')).data.sources, []);
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
