import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture } from '../../../fixtures/channel-fixture.mjs';
import { ChannelConnections } from '../../../../dist/channels/connections.js';

// #533 follow-up from the #1193 review: reconcile runs every second (`src/server.ts:506`), so a permanently terminal
// long connection — a rotated or invalid app secret — would rebuild its client and call the Feishu endpoint about every
// two seconds forever. Terminal rebuilds back off 1s, 2s, 4s … capped at five minutes, and a connected socket resets it.
test('terminal long-connection failures rebuild with exponential backoff', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  h.store.run("UPDATE channel_connectors SET transport='websocket',application_type='enterprise',enabled=1 WHERE id=?", id);
  let created = 0, healthy = false;
  const clients = [], closed = [];
  // Each client owns its SDK state; start() resolves, as the pinned SDK does, and the state is read by the health branch.
  const sockets = new ChannelConnections(service, () => {
    const index = ++created;
    let state = 'idle';
    const client = {
      start: async () => { state = healthy ? 'connected' : 'failed'; },
      close: () => closed.push(index),
      getConnectionStatus: () => ({ state, reconnectAttempts: 0 }),
      setState: next => { state = next; },
    };
    clients.push(client); return client;
  });
  t.after(() => sockets.close());
  const state = () => h.store.get('SELECT connection_state FROM channel_connectors WHERE id=?', id).connection_state;

  let now = 0;
  const tick = () => { now += 1000; sockets.reconcile(now); };

  sockets.reconcile(now);
  assert.equal(created, 1, 'the first tick builds the client');
  assert.equal(state(), 'connecting');

  // Each iteration: one tick sees the terminal state and schedules the rebuild, then the rebuild happens exactly
  // `delay` milliseconds after that failure. 1s doubling to the five-minute cap.
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000];
  for (const delay of delays) {
    tick();
    const failedAt = now, before = created;
    assert.equal(closed.length, before, `the failed client is closed (attempt ${before})`);
    for (let waited = 0; waited < delay - 1000; waited += 1000) tick();
    assert.equal(created, before, `no rebuild earlier than ${delay}ms after the failure at ${failedAt}`);
    tick();
    assert.equal(created, before + 1, `one rebuild ${delay}ms after the failure at ${failedAt}`);
  }

  // A connection that reports connected clears the schedule: the next terminal failure waits one second again.
  healthy = true;
  for (let waited = 0; waited <= 300000; waited += 1000) tick();
  tick();
  assert.equal(state(), 'connected');
  const beforeReset = created;
  clients.at(-1).setState('failed');
  tick();
  assert.equal(created, beforeReset, 'a terminal failure never rebuilds inside the same tick');
  tick();
  assert.equal(created, beforeReset + 1, 'after a healthy connection the next rebuild waits one second again');
  tick();
  assert.equal(state(), 'connected');
});

test('a credential revision change rebuilds immediately and forgets the backoff', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  h.store.run("UPDATE channel_connectors SET transport='websocket',application_type='enterprise',enabled=1 WHERE id=?", id);
  let created = 0;
  const sockets = new ChannelConnections(service, () => {
    const index = ++created;
    let state = 'idle';
    return {
      start: async () => { state = 'failed'; },
      close: () => {},
      getConnectionStatus: () => ({ state, reconnectAttempts: 0 }),
    };
  });
  t.after(() => sockets.close());

  sockets.reconcile(0);
  sockets.reconcile(1000); // terminal failure: the next rebuild is not before 2000
  sockets.reconcile(2000);
  sockets.reconcile(3000); // terminal failure again: the next rebuild is not before 5000
  assert.equal(created, 2);
  // The credential was re-saved: the revision change is a new client, not a retry of the old one.
  h.store.run('UPDATE channel_connectors SET revision=revision+1 WHERE id=?', id);
  sockets.reconcile(4000);
  assert.equal(created, 3, 'a revision change rebuilds on the same tick, ignoring the retry delay');
});
