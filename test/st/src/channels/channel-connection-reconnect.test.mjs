import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture } from '../../../fixtures/channel-fixture.mjs';
import { ChannelConnections } from '../../../../dist/channels/connections.js';

// #533: the pinned @larksuiteoapi/node-sdk@1.76.0 calls reConnect() without awaiting or returning it, so a refused
// connection, a failed handshake or a non-retryable credential error leaves start() resolved and surfaces only as
// getConnectionStatus().state === 'failed'. That is the real failure path; the test drives it, not a rejecting start().
test('a long connection whose start resolves into a terminal failed state is rebuilt on the next reconcile', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  h.store.run("UPDATE channel_connectors SET transport='websocket',application_type='enterprise',enabled=1 WHERE id=?", id);
  let created = 0, started = 0, failures = 2;
  const closed = [];
  // Each client keeps its own SDK state; start() always resolves, as the pinned SDK does.
  const sockets = new ChannelConnections(service, () => {
    const index = ++created;
    let state = 'idle';
    return {
      start: async () => { started++; state = failures-- > 0 ? 'failed' : 'connected'; },
      close: () => closed.push(index),
      getConnectionStatus: () => ({ state, reconnectAttempts: 0 }),
    };
  });
  t.after(() => sockets.close());
  const state = () => h.store.get('SELECT connection_state FROM channel_connectors WHERE id=?', id).connection_state;
  const lastError = () => h.store.get('SELECT last_error FROM channel_connectors WHERE id=?', id).last_error;

  // Attempt 1: reconcile starts the client and records `connecting`; the SDK then resolves start() as `failed`.
  sockets.reconcile();
  assert.equal(started, 1);
  assert.equal(created, 1);
  assert.equal(state(), 'connecting');
  assert.deepEqual(closed, []);

  // Tick 2 sees the terminal failed state: the dead client is closed and dropped, and the console keeps `failed`.
  sockets.reconcile();
  assert.equal(state(), 'failed');
  assert.equal(lastError(), 'channel_connection_failed');
  assert.deepEqual(closed, [1], 'the failed client must be closed before it leaves the map');
  assert.equal(created, 1, 'no two clients for one connector inside a single tick');

  // Tick 3 is when the connector is rebuilt, with a fresh client that starts again.
  sockets.reconcile();
  assert.equal(created, 2);
  assert.equal(started, 2);
  assert.equal(state(), 'connecting');

  // The second attempt also ends failed: same recovery, and the first dead client is not closed twice.
  sockets.reconcile();
  assert.equal(state(), 'failed');
  assert.deepEqual(closed, [1, 2]);

  // Attempt 3 connects: the rebuilt socket is the one the connector reports, and a healthy socket is left alone.
  sockets.reconcile();
  assert.equal(created, 3);
  assert.equal(started, 3);
  sockets.reconcile();
  assert.equal(state(), 'connected');
  assert.deepEqual(closed, [1, 2]);
  assert.equal(started, 3, 'a healthy socket is not restarted on every tick');
});
