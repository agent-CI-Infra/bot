import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from './helpers.mjs';
import { Dispatcher } from '../dist/dispatch/worker.js';

// The dispatcher claims due events from one bounded scan window. Events of one Issue are decided in order, so a backlog
// of that Issue cannot run anyway; it must not fill the window and hide the work of other objects and projects.
const offered = JSON.stringify([{ id: 'review', work: 'review.issue', title: '检视 Issue',
  spec: { type: 'object', kind: 'review.issue', number: 5, head: null, input: {}, delivery: null } }]);

function add(store, row) {
  store.run(`INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,lease,lease_until,next_run_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.repository, 'key-' + row.id, 'issue.updated', 'webhook', 'issue', row.number, '积压事件 ' + row.id, '{}',
    offered, row.state ?? 'pending', row.lease ?? null, row.leaseUntil ?? null, row.nextRunAt ?? 0, row.createdAt);
}
// A decider that never answers: claimed events stay dispatching, so a claim is visible without running a model.
function held() {
  const seen = [];
  return { seen, decide: (store, context) => { seen.push(String(context.event.id)); return new Promise(() => {}); } };
}
async function projects(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  return { h, admin, a };
}

test('a backlog of one Issue filling the scan window does not starve another project', async t => {
  const { h, admin, a } = await projects(t);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  for (const id of ['101', '202']) await admin(`/api/repositories/${id}/policy`, 'PATCH', { review_enabled: true });
  const base = Date.parse('2026-11-11T00:00:00.000Z'), at = i => new Date(base + i * 1000).toISOString();
  // The Issue's oldest event waits for its next attempt; 200 later updates of it are due but cannot run before it.
  add(h.store, { id: 'a-first', repository: '101', number: 5, createdAt: at(0), nextRunAt: Date.now() + 600000 });
  for (let i = 0; i < 200; i++) add(h.store, { id: 'a-' + i, repository: '101', number: 5, createdAt: at(i + 1) });
  add(h.store, { id: 'b', repository: '202', number: 9, createdAt: at(1000) });
  const decider = held(), dispatcher = new Dispatcher(h.store, decider.decide);
  dispatcher.tick();
  assert.deepEqual(decider.seen, ['b'], 'the scan reaches the other project instead of walking one Issue backlog');
  assert.equal(h.store.get('SELECT state FROM dispatch_events WHERE id=?', 'b').state, 'dispatching');
  assert.deepEqual(h.store.all("SELECT id FROM dispatch_events WHERE id<>'b' AND state<>'pending'"), [], 'the blocked backlog keeps waiting');
});

test('a live lease and a waiting predecessor keep an object in order; an expired lease is taken over', async t => {
  const { h, admin, a } = await projects(t);
  for (const id of ['303', '404']) { await repository(admin, a.id, id); await admin(`/api/repositories/${id}/policy`, 'PATCH', { review_enabled: true }); }
  const base = Date.parse('2026-11-11T00:00:00.000Z'), at = i => new Date(base + i * 1000).toISOString(), now = Date.now();
  add(h.store, { id: 'c-first', repository: '303', number: 7, createdAt: at(0), state: 'dispatching', lease: 'live-lease', leaseUntil: now + 60000 });
  add(h.store, { id: 'c-later', repository: '303', number: 7, createdAt: at(1) });
  add(h.store, { id: 'd-first', repository: '404', number: 8, createdAt: at(2), state: 'dispatching', lease: 'stale-lease', leaseUntil: now - 1000 });
  add(h.store, { id: 'd-later', repository: '404', number: 8, createdAt: at(3) });
  const decider = held(), dispatcher = new Dispatcher(h.store, decider.decide);
  dispatcher.tick();
  assert.deepEqual(decider.seen, ['d-first'], 'only the event whose lease ran out is taken over');
  assert.equal(h.store.get('SELECT lease FROM dispatch_events WHERE id=?', 'c-first').lease, 'live-lease', 'a valid lease is left alone');
  assert.equal(h.store.get('SELECT state FROM dispatch_events WHERE id=?', 'c-later').state, 'pending', 'a waiting predecessor keeps the object in order');
  assert.equal(h.store.get('SELECT state FROM dispatch_events WHERE id=?', 'd-later').state, 'pending', 'the successor waits for the event taken over before it');
  assert.notEqual(h.store.get('SELECT lease FROM dispatch_events WHERE id=?', 'd-first').lease, 'stale-lease');
});

test('a scan with more runnable objects than slots still claims no more than the configured concurrency', async t => {
  const { h, admin, a } = await projects(t);
  const base = Date.parse('2026-11-11T00:00:00.000Z'), at = i => new Date(base + i * 1000).toISOString();
  for (let i = 0; i < 6; i++) {
    const id = String(500 + i);
    await repository(admin, a.id, id); await admin(`/api/repositories/${id}/policy`, 'PATCH', { review_enabled: true });
    add(h.store, { id: 'e-' + i, repository: id, number: 20 + i, createdAt: at(i) });
  }
  const decider = held(), dispatcher = new Dispatcher(h.store, decider.decide, undefined, 2);
  dispatcher.tick();
  assert.equal(decider.seen.length, 2, 'two slots, two events');
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE state='dispatching'").n, 2);
  assert.equal(h.store.get("SELECT count(*) n FROM dispatch_events WHERE state='pending'").n, 4);
});
