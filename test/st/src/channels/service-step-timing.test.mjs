import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, scriptedModel, inGroup, post, finished } from '../../../fixtures/channel-fixture.mjs';
import { serviceBindingStorage } from '../../../../dist/channels/service-bindings.js';

const steps = async (f, chat, turn) => (await f.admin(`/api/channels/chats/${chat.id}/turns/${turn.id}`)).value.events;

test('two calls of the same tool keep their own identity and duration (#1313)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  // The model calls the same tool twice in a row: nothing but a call id can tell the two calls apart.
  scriptedModel(f, [['list_projects', {}], ['list_projects', {}], '两次范围都核对完了。']);
  const receipt = await post(f.h, f.id, inGroup('连续核对两次项目范围。', 'ou_bob'));
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  const turn = f.h.store.get('SELECT * FROM channel_service_turns WHERE chat_id=?', chat.id);
  const events = await steps(f, chat, turn), calls = events.filter(e => e.type === 'tool_call' && e.name === 'list_projects');
  assert.equal(calls.length, 2, JSON.stringify(events));
  assert.ok(calls.every(c => typeof c.call_id === 'string' && c.call_id), 'every call carries its own identity');
  assert.notEqual(calls[0].call_id, calls[1].call_id, 'two calls of one tool are not merged by name');
  assert.ok(calls.every(c => Number.isInteger(c.duration_ms) && c.duration_ms >= 0), 'each call reports its own measured duration');
  // Each duration is the pair's own start and end, not the distance to the neighbouring step.
  const own = calls.map(c => f.h.store.get("SELECT started_at,(SELECT ended_at FROM channel_service_events WHERE call_id=? AND ended_at IS NOT NULL) ended_at FROM channel_service_events WHERE turn_id=? AND call_id=? AND type='tool_call'", c.call_id, turn.id, c.call_id));
  assert.ok(own.every(row => row.started_at !== null && row.ended_at !== null));
  assert.deepEqual(calls.map(c => c.duration_ms), own.map(row => row.ended_at - row.started_at));
  // Nothing but the two calls happened in their window, so the durations cover it and never overlap.
  const window = Math.max(...own.map(row => row.ended_at)) - Math.min(...own.map(row => row.started_at));
  const total = calls.reduce((sum, c) => sum + c.duration_ms, 0);
  assert.ok(total <= window && window - total < 200, `durations ${total} vs window ${window}`);
  assert.ok(!events.some(e => e.arguments || e.result || e.reasoning), 'identity and timing never carry tool content');
});

test('steps recorded before the timing columns existed read as unrecorded (#1313)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  scriptedModel(f, ['没有工具。', '好。']);
  const receipt = await post(f.h, f.id, inGroup('随便说一句。', 'ou_bob'));
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  const turn = f.h.store.get('SELECT * FROM channel_service_turns WHERE chat_id=?', chat.id);
  // The exact shape an old database stores: no call id, no clock readings.
  f.h.store.run("INSERT INTO channel_service_events(turn_id,type,name,created_at) VALUES(?,'tool_call','list_projects',?)", turn.id, Date.now());
  const legacy = (await steps(f, chat, turn)).filter(e => e.type === 'tool_call');
  assert.equal(legacy.length, 1, 'the old row is still listed');
  assert.equal(legacy[0].call_id, undefined);
  assert.equal(legacy[0].duration_ms, null, 'never 0 and never a made-up duration');
});

test('a database from before the timing columns migrates in place without losing steps (#1313)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  scriptedModel(f, [['list_projects', {}], '核对完了。']);
  const receipt = await post(f.h, f.id, inGroup('核对项目范围。', 'ou_bob'));
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  const turn = f.h.store.get('SELECT * FROM channel_service_turns WHERE chat_id=?', chat.id);
  const before = f.h.store.get('SELECT count(*) n FROM channel_service_events WHERE turn_id=?', turn.id).n;
  // Take the table back to its pre-#1313 shape, the way an existing deployment has it.
  for (const column of ['call_id', 'started_at', 'ended_at']) f.h.store.db.exec(`ALTER TABLE channel_service_events DROP COLUMN ${column}`);
  assert.deepEqual(f.h.store.all('PRAGMA table_info(channel_service_events)').map(c => c.name), ['sequence', 'turn_id', 'type', 'name', 'created_at']);
  serviceBindingStorage(f.h.store);
  assert.deepEqual(f.h.store.all('PRAGMA table_info(channel_service_events)').map(c => c.name).slice(-3), ['call_id', 'started_at', 'ended_at']);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_events WHERE turn_id=?', turn.id).n, before, 'the migration keeps the recorded steps');
  const legacy = (await steps(f, chat, turn)).filter(e => e.type === 'tool_call');
  assert.ok(legacy.length >= 1 && legacy.every(e => e.duration_ms === null), 'steps written before the upgrade read as unrecorded');
});

// A turn whose model answered without tools, with its recorded steps replaced by hand: the event rows are the fixture.
async function emptyTurn(f, chat) {
  scriptedModel(f, ['先核对。', '好。']);
  const receipt = await post(f.h, f.id, inGroup('说明一下。', 'ou_bob'));
  assert.equal((await finished(f.h, receipt.value.operation_id)).state, 'completed');
  const turn = f.h.store.get('SELECT * FROM channel_service_turns WHERE chat_id=?', chat.id);
  f.h.store.run('DELETE FROM channel_service_events WHERE turn_id=?', turn.id); return turn;
}
const toolRow = (f, turn, type, call, at) => f.h.store.run('INSERT INTO channel_service_events(turn_id,type,name,call_id,started_at,ended_at,created_at) VALUES(?,?,?,?,?,?,?)',
  turn.id, type, 'list_projects', call, type === 'tool_call' ? at : null, type === 'tool_call' ? null : at, at);

test('a result is paired with its own call even when same-named calls overlap (#1313)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  const turn = await emptyTurn(f, chat), at = 1_700_000_000_000;
  // Pi runs every tool in its own background task: A starts, B starts, B ends, A ends. Both calls are the same tool.
  toolRow(f, turn, 'tool_call', 'a', at); toolRow(f, turn, 'tool_call', 'b', at + 10);
  toolRow(f, turn, 'tool_result', 'b', at + 30); toolRow(f, turn, 'tool_result', 'a', at + 600);
  const calls = (await steps(f, chat, turn)).filter(e => e.type === 'tool_call');
  assert.deepEqual(calls.map(c => [c.call_id, c.duration_ms]), [['a', 600], ['b', 20]], 'each call keeps its own pair, not its neighbour by name');
});

test('a call whose result lands on the next page still shows its own duration (#1313)', async t => {
  const f = await channelFixture(t); await repositoryAssistant(f); const chat = await boundGroup(f);
  const turn = await emptyTurn(f, chat), at = 1_700_000_000_000;
  for (let i = 0; i < 99; i++) f.h.store.run("INSERT INTO channel_service_events(turn_id,type,name,created_at) VALUES(?,'model_start','',?)", turn.id, at + i);
  toolRow(f, turn, 'tool_call', 'p', at + 200); toolRow(f, turn, 'tool_result', 'p', at + 240);
  const page1 = (await f.admin(`/api/channels/chats/${chat.id}/turns/${turn.id}`)).value;
  assert.equal(page1.events.length, 100); assert.ok(page1.has_more);
  const boundary = page1.events.at(-1);
  assert.equal(boundary.type, 'tool_call'); assert.equal(boundary.duration_ms, 40, 'the pair is measured across the page boundary');
  const page2 = (await f.admin(`/api/channels/chats/${chat.id}/turns/${turn.id}?after=${page1.next_after}`)).value;
  assert.equal(page2.events[0].type, 'tool_result');
});
