// #476: a restart returned the events it was deciding to the queue but kept the attempt the claim had spent, so every
// restart used up one of an event's attempts without deciding anything and the event was given up early.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { dispatchStorage, InvalidDecision } from '../../../../dist/dispatch/store.js';
import { Dispatcher } from '../../../../dist/dispatch/worker.js';

const open = () => { const store = new Store(':memory:', randomBytes(32)); dispatchStorage(store); return store; };
const event = (store, { state = 'dispatching', attempts = 2 } = {}) => store.run(
  `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,attempts,lease,lease_until,next_run_at,created_at,answer_round)
   VALUES('e','101','k','issue.updated','github','issue',5,'s','{}','[]',?,?,?,?,0,?,1)`,
  state, attempts, state === 'dispatching' ? 'lease-1' : null, state === 'dispatching' ? Date.now() + 60000 : null, new Date().toISOString());
const row = store => store.get("SELECT * FROM dispatch_events WHERE id='e'");
const ignore = () => ({ decision: 'ignore', option_ids: [], model: null, reason: 'nothing to do' });

test('a restart hands back the attempt an interrupted decision spent (#476)', async () => {
  const store = open();
  // A claim counted this event as attempt 2 and the process died while deciding it.
  event(store, { attempts: 2 });
  let seen = null;
  const dispatcher = new Dispatcher(store, async () => { seen = row(store).attempts; return ignore(); }, () => {}, 1);
  dispatcher.start(); await dispatcher.idle(); await dispatcher.close();
  // The recovery refunded the interrupted claim (2 -> 1) and the new claim counted its own (1 -> 2). Leaving the count at 2
  // would mean this round costs nothing although it is a retry of the interrupted one.
  assert.equal(seen, 2, 'the decision runs with the attempt count the recovery handed back plus its own claim');
  assert.deepEqual([row(store).state, row(store).attempts], ['decided', 2]);
});

test('the retry path refunds its own attempt once, and a restart does not refund it again (#476)', async () => {
  const store = open();
  // An event already back in the queue after a lost decision context: its attempt was handed back there.
  event(store, { state: 'pending', attempts: 3 });
  const dispatcher = new Dispatcher(store, async () => { throw new InvalidDecision('dispatch_context_changed', 'context moved'); }, () => {}, 1);
  dispatcher.start(); await dispatcher.idle(); await dispatcher.close();
  // Claim (+1) and the lost-context refund (-1) cancel out; the restart recovery sees a queued event and must not refund it.
  assert.deepEqual([row(store).state, row(store).attempts], ['pending', 3]);
});
