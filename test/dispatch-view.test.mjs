import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';

async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '102');
  const add = (id, values = {}) => {
    const event = { repository_id: '101', created_at: '2026-11-11T10:00:00.000Z', type: 'issue.opened', state: 'decided', decision: 'ignore', ...values };
    h.store.run(`INSERT INTO dispatch_events(id,repository_id,event_key,type,source,summary,facts,options,created_at,state,decision,reason,model,error,attempts,lease)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, event.repository_id, id, event.type, 'github', 'Fixture event ' + id, '{"private":"not-a-public-event-field"}', '[{"private":"task-input"}]', event.created_at,
      event.state, event.decision, 'Already covered by another request.', 'historical-model', event.error ? JSON.stringify(event.error) : null, event.attempts || 0, 'private-lease');
  };
  return { h, admin, add };
}

test('dispatch filters apply before pagination, use half-open event times and reject invalid ranges', async t => {
  const { admin, add } = await fixture(t);
  add('old', { created_at: '2026-11-10T10:00:00.000Z' }); add('match'); add('other-type', { type: 'issue.updated' });
  add('other-decision', { decision: 'create' }); add('failed', { state: 'failed', decision: null });
  add('boundary', { created_at: '2026-11-12T00:00:00.000Z' }); add('other-project', { repository_id: '102' });
  const query = '/api/repositories/101/dispatch?limit=1&state=decided&decision=ignore&type=issue.opened&from=2026-11-11T00:00:00Z&until=2026-11-12T00:00:00Z';
  const page = await admin(query); assert.equal(page.status, 200); assert.deepEqual(page.value.events.map(e => e.id), ['match']); assert.equal(page.value.has_more, false);
  for (const filter of ['state=unknown', 'decision=failed', 'type=bad%20type', 'from=yesterday', 'from=2026-02-31T00:00:00Z', 'until=2026-11-10T00:00:00Z&from=2026-11-11T00:00:00Z', 'limit=1.5', 'offset=-1']) {
    assert.equal((await admin('/api/repositories/101/dispatch?' + filter)).status, 400, filter);
  }
});

test('dispatch cursor traverses tied timestamps once while newer events arrive and is scoped to filters and project', async t => {
  const { admin, add } = await fixture(t); for (const id of ['a', 'b', 'c', 'd', 'e']) add(id);
  const first = (await admin('/api/repositories/101/dispatch?limit=2')).value;
  assert.deepEqual(first.events.map(e => e.id), ['e', 'd']); assert.ok(first.next_cursor); assert.ok(!('cursor_row' in first.events[0]));
  add('arrived-later');
  const second = (await admin('/api/repositories/101/dispatch?limit=2&cursor=' + first.next_cursor)).value;
  const third = (await admin('/api/repositories/101/dispatch?limit=2&cursor=' + second.next_cursor)).value;
  assert.deepEqual([...first.events, ...second.events, ...third.events].map(e => e.id), ['e', 'd', 'c', 'b', 'a']); assert.equal(third.has_more, false);
  assert.deepEqual((await admin('/api/repositories/101/dispatch?limit=2&offset=2')).value.events.map(e => e.id), ['d', 'c']);
  for (const path of ['/api/repositories/102/dispatch?cursor=', '/api/repositories/101/dispatch?state=decided&cursor=', '/api/repositories/101/dispatch?offset=1&cursor=']) {
    assert.equal((await admin(path + first.next_cursor)).status, 400);
  }
  assert.equal((await admin('/api/repositories/101/dispatch?cursor=broken')).status, 400);
});

test('dispatch detail exposes its recorded projection and project-local task links, not raw inputs or lease', async t => {
  const { h, admin, add } = await fixture(t); add('event'); add('elsewhere', { repository_id: '102' });
  const now = new Date().toISOString();
  for (const [id, repo] of [['same-project', '101'], ['other-project', '102']]) {
    h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,?,?,?,?)', id, repo, 'review.issue', 'succeeded', 'Fixture task');
    h.store.run('INSERT INTO task_events(task_id,event_id,relation,created_at) VALUES(?,?,?,?)', id, 'event', 'created', now);
  }
  const detail = await admin('/api/repositories/101/dispatch/event'); assert.equal(detail.status, 200);
  assert.equal(detail.value.event.model, 'historical-model'); assert.deepEqual(detail.value.tasks.map(t => t.id), ['same-project']);
  for (const key of ['facts', 'options', 'merge', 'lease', 'cursor_row']) assert.ok(!(key in detail.value.event), key);
  assert.ok(!JSON.stringify(detail.value).includes('not-a-public-event-field'));
  assert.equal((await admin('/api/repositories/101/dispatch/elsewhere')).status, 404);
  assert.equal((await admin('/api/repositories/101/dispatch/event', 'POST', {})).status, 405);
  assert.equal((await admin('/api/repositories/101/dispatch/event/retry')).status, 405);
});

test('manual retry retains the original failure across restarts and later decisions, and repeated clicks do not create retries', async t => {
  const { h, admin, add } = await fixture(t); add('failed', { state: 'failed', decision: null, attempts: 8, error: { code: 'invalid_decision', detail: 'No offered option matched.' } });
  assert.equal((await admin('/api/repositories/101/dispatch/failed/retry', 'POST', {})).status, 201);
  assert.equal((await admin('/api/repositories/101/dispatch/failed/retry', 'POST', {})).status, 409);
  const pending = (await admin('/api/repositories/101/dispatch/failed')).value;
  assert.equal(pending.event.state, 'pending'); assert.equal(pending.event.attempts, 0); assert.equal(pending.event.error, null);
  assert.equal(pending.retries.length, 1); assert.equal(pending.retries[0].previous_attempts, 8); assert.equal(pending.retries[0].previous_error.code, 'invalid_decision');
  h.store.run("UPDATE dispatch_events SET state='decided',decision='ignore',reason='Now safely ignored' WHERE id='failed'");
  await h.stop(); await h.start();
  const decided = (await admin('/api/repositories/101/dispatch/failed')).value;
  assert.equal(decided.event.id, 'failed'); assert.equal(decided.event.reason, 'Now safely ignored'); assert.deepEqual(decided.retries, pending.retries);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 0);
  h.store.run("DELETE FROM dispatch_events WHERE id='failed'"); assert.equal(h.store.get('SELECT count(*) n FROM dispatch_retries').n, 0);
});

test('failure history and retry state roll back together if recording a retry fails', async t => {
  const { h, admin, add } = await fixture(t); add('failed', { state: 'failed', attempts: 8, error: { code: 'fixture_failure' } });
  h.store.db.exec("CREATE TRIGGER refuse_retry BEFORE INSERT ON dispatch_retries BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
  assert.equal((await admin('/api/repositories/101/dispatch/failed/retry', 'POST', {})).status, 503);
  const detail = (await admin('/api/repositories/101/dispatch/failed')).value; assert.equal(detail.event.state, 'failed'); assert.equal(detail.event.error.code, 'fixture_failure'); assert.equal(detail.retries.length, 0);
});

test('project authorization fences the list, detail and retry even for a known event id', async t => {
  const { h, admin, add } = await fixture(t); add('secret', { repository_id: '102', state: 'failed' });
  const password = testPassword(); await admin('/api/users', 'POST', { username: 'scoped', password, repository_ids: ['101'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'scoped', password });
  assert.equal((await member('/api/repositories/102/dispatch')).status, 403);
  assert.equal((await member('/api/repositories/102/dispatch/secret')).status, 403);
  assert.equal((await member('/api/repositories/102/dispatch/secret/retry', 'POST', {})).status, 403);
  assert.equal((await member('/api/repositories/101/dispatch/secret')).status, 404);
  assert.equal(h.store.get("SELECT state FROM dispatch_events WHERE id='secret'").state, 'failed');
});
