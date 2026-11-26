import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { externalFixture } from '../../../fixtures/external-helpers.mjs';
import { DeliveryBodyError, transientBodyError } from '../../../../dist/storage/webhook-bodies.js';
import { Store } from '../../../../dist/storage/database.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// #1403: an accepted webhook body over 2 KiB is kept in its own file beside the database; the row keeps an empty
// payload, the file's path, its sha256 and size, and the few fields the delivery list shows. Every reader gets the bytes
// that were received, and a project's bodies go with the project.
const sha = text => createHash('sha256').update(text).digest('hex');
const large = { repository: { id: 101, full_name: 'fixture/project-101' }, action: 'opened', number: 5,
  pull_request: { number: 5, draft: false, head: { sha: 'b'.repeat(40) }, title: 'large change', body: 'B'.repeat(5000) } };
// Not the canonical JSON text: the file must hold the bytes as received, not a re-serialization.
const raw = JSON.stringify(large, null, 1);

async function fixture(t) {
  const h = await externalFixture(t, {}, { maxBodyBytes: 64 * 1024 }), client = await h.client(), received = [];
  const receiver = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; received.push(body); res.writeHead(204); res.end(); });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening'); t.after(() => new Promise(resolve => receiver.close(resolve)));
  const subscription = await h.admin('/api/external/subscriptions', 'POST', { client_id: client.client.id, name: 'PR review', url: 'http://127.0.0.1:' + receiver.address().port + '/review',
    filters: { events: ['pull_request'], actions: ['opened'], exclude_drafts: true } });
  assert.equal(subscription.status, 201);
  return { h, client, received };
}

test('a large accepted body lives in its own file and the list, detail, external events and forwarding read it unchanged', async t => {
  const { h, client, received } = await fixture(t);
  assert.equal((await h.hook(h.a.path, h.a.secret, 'large-pr', raw, { 'X-GitHub-Event': 'pull_request' })).status, 200);
  const small = { repository: { id: 101 }, action: 'opened', issue: { number: 7, title: 'small' } };
  assert.equal((await h.hook(h.a.path, h.a.secret, 'small-issue', small)).status, 200);
  const row = h.store.get("SELECT * FROM deliveries WHERE delivery_id='large-pr'"), inline = h.store.get("SELECT * FROM deliveries WHERE delivery_id='small-issue'");
  assert.equal(row.payload.length, 0); assert.equal(row.payload_bytes, Buffer.byteLength(raw)); assert.equal(row.payload_sha256, sha(raw)); assert.equal(row.payload_removed_at, null);
  const file = join(h.store.webhookBodiesDir, row.payload_ref);
  assert.equal(readFileSync(file, 'utf8'), raw); assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(row.payload_summary), { action: 'opened', number: 5, repository: { full_name: 'fixture/project-101' }, pull_request: { number: 5, title: 'large change', draft: false, head: { sha: 'b'.repeat(40) } } });
  assert.equal(Buffer.from(inline.payload).toString('utf8'), JSON.stringify(small), 'a body of at most 2 KiB stays in its row'); assert.equal(inline.payload_ref, null);
  // The list reads the summary: the same repository name and result as from the body itself.
  const list = await h.admin('/api/events?limit=10');
  const listed = list.value.events.find(event => event.id === row.id);
  assert.equal(listed.full_name, 'fixture/project-101'); assert.ok(listed.processing_result); assert.ok(!JSON.stringify(list.value).includes('B'.repeat(100)));
  const detail = await h.admin('/api/events/' + row.id);
  assert.deepEqual(JSON.parse(detail.value.event.payload), large); assert.equal(detail.value.event.payload_unreadable, undefined);
  // An external executor polling the archive and a subscriber receive the accepted body.
  const grant = await h.exchange(client.client.id, client.privateKey);
  const events = await (await fetch(h.webhook + '/external/events', { headers: { Authorization: 'Bearer ' + grant.value.token } })).json();
  assert.deepEqual(events.events.find(event => event.delivery_id === 'large-pr').payload, large);
  const forward = h.store.get('SELECT * FROM external_deliveries WHERE source_id=?', row.id);
  await h.external.forwarder.deliver(forward);
  assert.equal(h.store.get('SELECT state FROM external_deliveries WHERE id=?', forward.id).state, 'succeeded');
  assert.deepEqual(JSON.parse(received[0]).payload, large);
  // A body file that no longer matches its hash is refused: the detail says why, a forward finds no source.
  writeFileSync(file, raw.replace('large change', 'edited change'));
  const corrupt = await h.admin('/api/events/' + row.id);
  assert.equal(corrupt.status, 200); assert.equal(corrupt.value.event.payload, ''); assert.equal(corrupt.value.event.payload_unreadable, 'delivery_body_corrupt');
  h.store.run("UPDATE external_deliveries SET state='retry' WHERE id=?", forward.id);
  await h.external.forwarder.deliver(h.store.get('SELECT * FROM external_deliveries WHERE id=?', forward.id));
  assert.deepEqual({ ...h.store.get('SELECT state,error FROM external_deliveries WHERE id=?', forward.id) }, { state: 'failed', error: 'source_unavailable' });
  assert.equal(received.length, 1);
  // Another executor polling now gets the other events whole and this one without its body, named from the summary.
  const other = await h.client(), late = await h.exchange(other.client.id, other.privateKey);
  const polled = await (await fetch(h.webhook + '/external/events', { headers: { Authorization: 'Bearer ' + late.value.token } })).json();
  const damaged = polled.events.find(event => event.delivery_id === 'large-pr');
  assert.deepEqual([damaged.payload, damaged.payload_unavailable, damaged.action, damaged.object_number], [null, 'delivery_body_corrupt', 'opened', 5]);
  assert.deepEqual(polled.events.find(event => event.delivery_id === 'small-issue').payload, small);
  // A file that is gone reads as missing.
  rmSync(file);
  assert.equal((await h.admin('/api/events/' + row.id)).value.event.payload_unreadable, 'delivery_body_missing');
});

test('only a read that failed for want of descriptors or memory is worth retrying', () => {
  const failed = code => new DeliveryBodyError('delivery_body_unreadable', 'x', { cause: Object.assign(new Error(code), { code }) });
  assert.deepEqual(['EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN', 'EACCES', 'EIO'].map(code => transientBodyError(failed(code))), [true, true, true, true, false, false]);
  assert.equal(transientBodyError(new DeliveryBodyError('delivery_body_corrupt', 'x')), false);
  assert.equal(transientBodyError(Object.assign(new Error('EMFILE'), { code: 'EMFILE' })), false, 'only a body read failure');
});

test('large bodies still reach the board and the CI events, which read the summary kept in the row', async t => {
  const { h } = await fixture(t);
  const pad = 'L'.repeat(4000), hook = (id, event, body) => h.hook(h.a.path, h.a.secret, id, body, { 'X-GitHub-Event': event });
  const board = (type, number) => ({ ...h.store.get('SELECT title,github_state,draft FROM board_objects WHERE repository_id=? AND object_type=? AND object_number=?', '101', type, number) });
  assert.equal((await hook('issue-opened', 'issues', { action: 'opened', repository: { id: 101 }, issue: { number: 31, title: 'Large issue', state: 'open', body: pad } })).status, 200);
  assert.ok(h.store.get("SELECT payload_ref FROM deliveries WHERE delivery_id='issue-opened'").payload_ref, 'the body went to its own file');
  assert.deepEqual(board('issue', 31), { title: 'Large issue', github_state: 'open', draft: null });
  assert.equal((await hook('issue-closed', 'issues', { action: 'closed', repository: { id: 101 }, issue: { number: 31, title: 'Renamed issue', state: 'closed', body: pad } })).status, 200);
  assert.deepEqual(board('issue', 31), { title: 'Renamed issue', github_state: 'closed', draft: null });
  assert.equal((await hook('pr-draft', 'pull_request', { action: 'opened', number: 32, repository: { id: 101 }, pull_request: { number: 32, title: 'Draft change', state: 'open', draft: true, head: { sha: 'c'.repeat(40) }, body: pad } })).status, 200);
  assert.deepEqual(board('pr', 32), { title: 'Draft change', github_state: 'open', draft: 1 });
  // A check run names the pull requests it ran for.
  assert.equal((await hook('check-pr', 'check_run', { action: 'created', repository: { id: 101 }, check_run: { id: 5, status: 'queued', output: { text: pad }, pull_requests: [{ number: 33, head: { sha: 'd'.repeat(40) } }] } })).status, 200);
  assert.ok(h.store.get("SELECT 1 FROM board_objects WHERE repository_id='101' AND object_type='pr' AND object_number=33"));
  // A failed workflow run opens a CI incident and its success closes it.
  const run = conclusion => ({ action: 'completed', repository: { id: 101 }, workflow_run: { id: 77, status: 'completed', conclusion, name: 'CI', logs: pad } });
  assert.equal((await hook('ci-failed', 'workflow_run', run('failure'))).status, 200);
  assert.equal((await hook('ci-recovered', 'workflow_run', run('success'))).status, 200);
  assert.deepEqual(h.store.all("SELECT type,incident FROM schedule_events WHERE project_id='101' AND type LIKE 'ci.%' ORDER BY created_at,type").map(row => ({ ...row })),
    [{ type: 'ci.failed', incident: 'ci:workflow_run:77' }, { type: 'ci.recovered', incident: 'ci:workflow_run:77' }]);
  assert.equal(h.store.get("SELECT count(*) n FROM deliveries WHERE delivery_id LIKE 'ci-%' AND payload_ref IS NOT NULL").n, 2);
});

test('a database written before #1403 gets the triggers that read the summary when it starts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'webhook-bodies-')), path = join(directory, 'control.sqlite'), key = Buffer.alloc(32, 5);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(path, key);
  // The triggers as they were: reading the row's own payload only.
  store.db.exec(`DROP TRIGGER board_deliveries_insert; CREATE TRIGGER board_deliveries_insert AFTER INSERT ON deliveries BEGIN SELECT CAST(NEW.payload AS TEXT); END;
    DROP TRIGGER schedule_ci_event; CREATE TRIGGER schedule_ci_event AFTER INSERT ON deliveries BEGIN SELECT CAST(NEW.payload AS TEXT); END;`);
  store.close();
  store = new Store(path, key); t.after(() => store.close());
  for (const name of ['board_deliveries_insert', 'board_deliveries_update', 'schedule_ci_event'])
    assert.match(store.get("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?", name).sql, /payload_summary/, name);
});

test('deleting a project removes its webhook body files', async t => {
  const { h } = await fixture(t);
  assert.equal((await h.hook(h.a.path, h.a.secret, 'large-pr', raw, { 'X-GitHub-Event': 'pull_request' })).status, 200);
  const file = join(h.store.webhookBodiesDir, h.store.get("SELECT payload_ref FROM deliveries WHERE delivery_id='large-pr'").payload_ref);
  assert.equal(existsSync(file), true);
  assert.equal((await h.admin('/api/projects/101', 'DELETE', { confirm: true })).status, 200);
  assert.equal(existsSync(file), false); assert.equal(existsSync(join(h.store.webhookBodiesDir, '101')), false);
});
