import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { externalFixture } from '../../../fixtures/external-helpers.mjs';

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
  assert.deepEqual(JSON.parse(row.payload_summary), { action: 'opened', number: 5, repository: { full_name: 'fixture/project-101' }, pull_request: { number: 5, draft: false, head: { sha: 'b'.repeat(40) } } });
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
});

test('deleting a project removes its webhook body files', async t => {
  const { h } = await fixture(t);
  assert.equal((await h.hook(h.a.path, h.a.secret, 'large-pr', raw, { 'X-GitHub-Event': 'pull_request' })).status, 200);
  const file = join(h.store.webhookBodiesDir, h.store.get("SELECT payload_ref FROM deliveries WHERE delivery_id='large-pr'").payload_ref);
  assert.equal(existsSync(file), true);
  assert.equal((await h.admin('/api/projects/101', 'DELETE', { confirm: true })).status, 200);
  assert.equal(existsSync(file), false); assert.equal(existsSync(join(h.store.webhookBodiesDir, '101')), false);
});
