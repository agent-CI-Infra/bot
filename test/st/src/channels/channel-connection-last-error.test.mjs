import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture } from '../../../fixtures/channel-fixture.mjs';
import { ChannelConnections } from '../../../../dist/channels/connections.js';

// #533: a terminal failure writes `last_error='channel_connection_failed'` for the console, but the recovery path
// only wrote `connection_state`. A channel that failed once and then connected by itself therefore kept showing the
// stale error, and an operator reading the connector health saw a connection that still looked broken.
test('a recovered long connection clears the error its earlier failure recorded', async t => {
  const f = await channelFixture(t), { h, id, service } = f;
  h.store.run("UPDATE channel_connectors SET transport='websocket',application_type='enterprise',enabled=1 WHERE id=?", id);
  let state = 'idle', failOnce = true;
  // As in the reconnect test: start() resolves and the SDK reports the terminal state through getConnectionStatus().
  const sockets = new ChannelConnections(service, () => ({
    start: async () => { state = failOnce ? 'failed' : 'connected'; failOnce = false; },
    close: () => {},
    getConnectionStatus: () => ({ state, reconnectAttempts: 0 }),
  }));
  t.after(() => sockets.close());
  const row = () => h.store.get('SELECT connection_state,last_error FROM channel_connectors WHERE id=?', id);
  let now = 0;
  const tick = () => { now += 1000; sockets.reconcile(now); };

  tick();                       // starts the client, which then reports `failed`
  tick();                       // records the failure and schedules the rebuild one second out
  assert.equal(row().connection_state, 'failed');
  assert.equal(row().last_error, 'channel_connection_failed');

  tick();                       // rebuild: the fresh client connects without help
  tick();                       // the health branch sees `connected`
  assert.equal(row().connection_state, 'connected');
  assert.equal(row().last_error, null, 'a recovered connection must not keep reporting the error of the failed one');
});
