import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness, setup, account } from './helpers.mjs';

// #291: a refused webhook (unknown endpoint, bad signature, oversized body) may still be archived for audit, but the
// archive must never grow with the sender's body. One refused row keeps a bounded digest, the refused archive keeps at
// most 500 rows within 7 days, and the counters behind that limit are readable from the delivery list.
const MAX_ROWS = 500, SUMMARY_BYTES = 256, HEADER_BYTES = 1024, MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const marker = 'ATTACKER-BODY-' + 'x'.repeat(900);

async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  return { h, admin, a, unknown: '/hooks/github/' + a.id + '/' + 'f'.repeat(48) };
}

test('a refused webhook keeps a bounded digest instead of the request body', async t => {
  const { h, admin, a, unknown } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const result = await h.hook(unknown, a.secret, 'unknown-' + i, marker);
    assert.equal(result.status, 404); assert.equal(result.value.error, 'unknown_endpoint');
  }
  const rows = h.store.all('SELECT * FROM deliveries ORDER BY delivery_id');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, 'unknown_endpoint');
    // The single-row bound: a 900-byte body leaves a digest, its length and nothing else.
    assert.ok(row.payload.length <= SUMMARY_BYTES, `${row.payload.length} bytes stored`);
    const summary = JSON.parse(Buffer.from(row.payload).toString('utf8'));
    assert.equal(summary.rejected, 'unknown_endpoint');
    assert.equal(summary.bytes, Buffer.byteLength(marker));
    assert.equal(summary.sha256, createHash('sha256').update(marker).digest('hex'));
    assert.ok(!Buffer.from(row.payload).toString('utf8').includes('ATTACKER-BODY'));
    // Headers are cut to the identifying set, so a header cannot inflate a refused row either.
    assert.ok(row.request_headers.length <= HEADER_BYTES, `${row.request_headers.length} header bytes`);
    assert.ok(!row.request_headers.includes('ATTACKER'));
  }
  // The detail read shows the same bounded summary, never the raw body.
  const detail = await admin('/api/events/' + rows[0].id);
  assert.equal(detail.status, 200);
  assert.ok(detail.value.event.payload.includes('unknown_endpoint'));
  assert.ok(!JSON.stringify(detail.value).includes('ATTACKER-BODY'));
  assert.equal(h.store.get('SELECT count(*) AS n FROM tasks').n, 0);
});

test('a bad signature and an oversized body are archived as bounded summaries too', async t => {
  const { h, a } = await fixture(t);
  const invalid = await h.hook(a.path, 'wrong-secret', 'bad-signature', marker);
  assert.equal(invalid.status, 401); assert.equal(invalid.value.error, 'invalid_signature');
  // Over the 2 KiB request limit: the response is 413 and only the read prefix is digested.
  const oversized = await h.hook(a.path, a.secret, 'oversized', marker + 'y'.repeat(9000));
  assert.equal(oversized.status, 413); assert.equal(oversized.value.error, 'payload_too_large');
  const rows = h.store.all("SELECT * FROM deliveries WHERE delivery_id IN ('bad-signature','oversized') ORDER BY delivery_id");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.payload.length <= SUMMARY_BYTES);
    const summary = JSON.parse(Buffer.from(row.payload).toString('utf8'));
    assert.ok(['invalid_signature', 'payload_too_large'].includes(summary.rejected));
    assert.ok(row.request_headers.length <= HEADER_BYTES);
    assert.ok(!Buffer.from(row.payload).toString('utf8').includes('ATTACKER'));
  }
  const oversizedRow = rows.find(row => row.delivery_id === 'oversized');
  assert.equal(JSON.parse(Buffer.from(oversizedRow.payload).toString('utf8')).truncated, true);
  assert.equal(h.store.get('SELECT count(*) AS n FROM tasks').n, 0);
  assert.equal(h.store.get('SELECT count(*) AS n FROM processed_deliveries').n, 0);
});

test('the refused archive is capped in rows and age, and the prune is counted', async t => {
  const { h, admin, a, unknown } = await fixture(t);
  const summary = Buffer.from(JSON.stringify({ rejected: 'unknown_endpoint', bytes: 1, truncated: false, sha256: 'a'.repeat(64) }));
  const insert = (id, status, ageMs) => h.store.run(`INSERT INTO deliveries(id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,
    http_status,request_headers,payload,body_complete,response) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, null, null, null, id, 'issues', 'issue', status, 0, new Date(Date.now() - ageMs).toISOString(), 404, '{}', summary, 1, '{}');
  // An accepted archive older than the window is never pruned, and an expired refusal is.
  insert('kept-accepted', 'accepted', 9 * 24 * 3600 * 1000);
  insert('expired-rejected', 'unknown_endpoint', 8 * 24 * 3600 * 1000);
  for (let i = 0; i < 520; i++) insert('rejected-' + i, 'unknown_endpoint', i * 1000);
  assert.equal((await admin('/api/events')).value.rejected_archive.rows, 521);
  const result = await h.hook(unknown, a.secret, 'fresh-reject', 'x');
  assert.equal(result.status, 404);
  const state = (await admin('/api/events')).value.rejected_archive;
  assert.equal(state.rows, MAX_ROWS);
  assert.ok(state.bytes <= MAX_ROWS * SUMMARY_BYTES);
  assert.equal(state.max_rows, MAX_ROWS);
  assert.equal(state.max_age_ms, MAX_AGE_MS);
  assert.ok(state.pruned_total >= 21, String(state.pruned_total));
  assert.equal(h.store.get("SELECT count(*) AS n FROM deliveries WHERE id='kept-accepted'").n, 1);
  assert.equal(h.store.get("SELECT count(*) AS n FROM deliveries WHERE id='expired-rejected'").n, 0);
  // Oldest refusals go first; the newest rows and every accepted row stay.
  assert.equal(h.store.get("SELECT count(*) AS n FROM deliveries WHERE id='rejected-519'").n, 0);
  assert.equal(h.store.get("SELECT count(*) AS n FROM deliveries WHERE id='rejected-0'").n, 1);
});

test('an accepted delivery still archives its full body and keeps duplicate semantics', async t => {
  const { h, a } = await fixture(t);
  const payload = { repository: { id: 7, full_name: 'fixture/project-7' }, action: 'opened' };
  const first = await h.hook(a.path, a.secret, 'accepted-1', payload);
  assert.equal(first.status, 200);
  const row = h.store.get("SELECT * FROM deliveries WHERE delivery_id='accepted-1'");
  assert.equal(Buffer.from(row.payload).length, Buffer.byteLength(JSON.stringify(payload)));
  assert.deepEqual(JSON.parse(Buffer.from(row.payload).toString('utf8')), payload);
  const duplicate = await h.hook(a.path, a.secret, 'accepted-1', payload);
  assert.equal(duplicate.value.duplicate, true);
  assert.equal(h.store.get('SELECT count(*) AS n FROM processed_deliveries').n, 1);
});
