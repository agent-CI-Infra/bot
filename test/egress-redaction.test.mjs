import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account } from './helpers.mjs';
import { managementFixture, query } from './management-fixture.mjs';

// #357: a delivery body and a management receipt leave the control plane for the console, so a key whose name is one of
// the closed set below must not carry its value past that exit. Nothing is inferred from a value's shape: a key that is
// not in the set keeps its value exactly, including nested objects and array elements.
const secret = { password: 'hunter2', nested: { token: 'ghp_x' }, list: [{ secret: 's3', keep: 'visible' }], action: 'opened', Cookie: 'session=abc' };

async function deliveryFixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  const posted = await h.hook(a.path, a.secret, 'egress-1', secret, { Authorization: 'Bearer hunter2', Cookie: 'session=abc' });
  assert.equal(posted.status, 200);
  return { h, admin, row: h.store.get("SELECT * FROM deliveries WHERE delivery_id='egress-1'") };
}

test('a delivery detail replaces the closed set of credential keys at every depth and leaves other keys alone', async t => {
  const { h, admin, row } = await deliveryFixture(t);
  h.store.run('UPDATE deliveries SET response=? WHERE id=?', JSON.stringify({ ok: true, token: 'ghp_response', nested: { private_key: 'pem' } }), row.id);
  const detail = (await admin('/api/events/' + row.id)).value.event;
  assert.deepEqual(JSON.parse(detail.payload), {
    password: '[redacted]', nested: { token: '[redacted]' }, list: [{ secret: '[redacted]', keep: 'visible' }],
    action: 'opened', Cookie: '[redacted]' });
  assert.deepEqual(detail.response, { ok: true, token: '[redacted]', nested: { private_key: '[redacted]' } });
  assert.equal(detail.request_headers.authorization, '[redacted]');
  assert.equal(detail.request_headers.cookie, '[redacted]');
  assert.equal(detail.request_headers['x-github-event'], 'issues');
  // The stored rows are untouched: this is an exit filter, not a new storage policy.
  assert.ok(Buffer.from(h.store.get("SELECT payload FROM deliveries WHERE delivery_id='egress-1'").payload).toString('utf8').includes('hunter2'));
});

test('a management receipt replaces the same keys in its arguments and result', async t => {
  const { h, admin } = await managementFixture(t), time = new Date().toISOString();
  h.store.run(`INSERT INTO management_commands(id,principal_id,tenant_id,project_id,channel,operation,target,arguments,expected_revision,
    idempotency_key,parameter_hash,authorization_revision,execution_fence,source_conversation,source_message,state,result,before_revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'egress-command', 'fixture-principal',
    h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id, '101', 'api', 'workflow.update',
    JSON.stringify({ project_id: '101', workflow_id: 'review.issue' }), JSON.stringify(secret), 'r1', 'egress-key', 'hash', 1,
    'fence', 'conversation', 'message', 'succeeded', JSON.stringify({ token: 'ghp_result', nested: { password: 'p' }, diff: { after: { prompt: 'kept' } } }), 'r',
    time, time);
  const receipt = (await query(admin, 'list_audit', { project_id: '101' })).value.audit.find(row => row.id === 'egress-command');
  // The read path already drops the keys traceClean knows; the closed set adds `secret` and `cookie`, and a value that
  // survives is replaced rather than dropped.
  const hidden = (value, key) => !(key in value) || value[key] === '[redacted]';
  assert.ok(hidden(receipt.arguments, 'password'));
  assert.ok(hidden(receipt.arguments.nested, 'token'));
  assert.ok(hidden(receipt.arguments.list[0], 'secret'));
  assert.ok(hidden(receipt.arguments, 'Cookie'));
  assert.equal(receipt.arguments.action, 'opened');
  assert.equal(receipt.arguments.list[0].keep, 'visible');
  assert.ok(hidden(receipt.result, 'token'));
  assert.ok(hidden(receipt.result.nested, 'password'));
  assert.deepEqual(receipt.result.diff, { after: { prompt: 'kept' } });
});

// #357: the exit filter is fail-closed. A body can parse and still be too deep to walk (the walk is recursive), and a
// body that could not be filtered must not come back as the bytes the sender wrote: that would hand the credential
// this exit exists to remove straight to the console.
test('a body that cannot be redacted comes back as a closed placeholder, never as its raw bytes', async t => {
  const { h, admin, row } = await deliveryFixture(t);
  const deep = '{"password":"hunter2","deep":' + '['.repeat(5000) + ']'.repeat(5000) + '}';
  h.store.run('UPDATE deliveries SET payload=? WHERE id=?', Buffer.from(deep), row.id);
  const detail = (await admin('/api/events/' + row.id)).value.event;
  assert.equal(String(detail.payload).includes('hunter2'), false);
  assert.deepEqual(JSON.parse(detail.payload), { redacted: true, reason: 'redaction_failed' });
});
