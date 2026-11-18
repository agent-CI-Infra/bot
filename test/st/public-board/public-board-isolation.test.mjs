import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cp, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicBoardFixture } from '../../fixtures/public-board-fixtures.mjs';

// A published repository whose snapshot directory is unreadable must cost only that repository's
// card. The dashboard aggregate, the shared config and the board index keep serving
// every repository that is still readable, and the aggregate names the repository it could not read
// instead of quietly presenting it as a board with no data.
test('one unreadable snapshot does not take the dashboard or the board index down with it', async t => {
  const { h, boards, state, hook, get, owner } = await publicBoardFixture(t);
  state.stars = 7;
  assert.equal((await hook('publish')).status, 200);
  await boards.drain();
  const healthy = h.store.get('SELECT * FROM public_board_jobs');
  assert.ok(healthy.active_path, 'the healthy repository published a snapshot');
  const summary = JSON.parse(await readFile(join(healthy.active_path, 'summary.json'), 'utf8'));

  // A second published repository. Its last collection is unusable: the dashboard summary is gone,
  // the shared config is truncated mid-object and the board snapshot is missing.
  const broken = await mkdtemp(join(tmpdir(), 'broken-board-'));
  t.after(() => rm(broken, { recursive: true, force: true }));
  await cp(healthy.active_path, broken, { recursive: true });
  await unlink(join(broken, 'summary.json'));
  await writeFile(join(broken, 'config.json'), '{"truncated":');
  await unlink(join(broken, 'board/data/snapshot.json'));
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,?,?,?,?,0,1,?)`, owner.id, '202', '1', 'octo/broken', '10', 'octo', new Date().toISOString());
  h.store.run(`INSERT INTO public_board_jobs(account_id,repository_id,generation,collected_generation,active_path)
    VALUES(?,?,2,1,?)`, owner.id, '202', broken);

  const index = await get('/dashboard/data/index.json');
  assert.equal(index.status, 200, `dashboard index answered ${index.status}: ${JSON.stringify(index.data)}`);
  assert.deepEqual(index.data.repos, [summary]);
  assert.deepEqual(index.data.unavailable, [{ repository: 'octo/broken', file: 'summary.json', reason: 'read_failed' }],
    'the aggregate names the repository, the file and a stable reason');
  assert.ok(!JSON.stringify(index.data).includes(broken), 'the aggregate never echoes the snapshot path');

  const config = await get('/dashboard/data/config.json');
  assert.equal(config.status, 200, `config answered ${config.status}: ${JSON.stringify(config.data)}`);
  assert.ok(Array.isArray(config.data.bots), 'the readable config of the healthy repository still contributes');
  assert.deepEqual(config.data.unavailable, [{ repository: 'octo/broken', file: 'config.json', reason: 'invalid_json' }],
    'a truncated document is reported as invalid JSON, not as a read failure');

  const boardsPage = await fetch(h.webhook + '/boards/');
  assert.equal(boardsPage.status, 200);
  const html = await boardsPage.text();
  assert.match(html, /\/boards\/octo\/hello\//);
  assert.match(html, /\/boards\/octo\/broken\//, 'the unreadable repository keeps its entrance on the board index');
  assert.equal((html.match(/等待首次采集/g) || []).length, 1, 'the unreadable repository shows no generation time');

  // A deleted shared config only removes that repository's contribution to the merged config.
  await unlink(join(broken, 'config.json'));
  const merged = await get('/dashboard/data/config.json');
  assert.equal(merged.status, 200);
  assert.ok(Array.isArray(merged.data.bots));
  assert.deepEqual(merged.data.unavailable, [{ repository: 'octo/broken', file: 'config.json', reason: 'read_failed' }]);
});
