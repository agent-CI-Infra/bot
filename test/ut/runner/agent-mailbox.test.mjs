import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { agentOperation } from '../../../runner/agent.mjs';
import { randomWorkspaceId } from '../../fixtures/helpers.mjs';

// The Pi session mailbox of the real runner (runner/agent.mjs): the long poll (#1277) and the start that rides with the
// last piece of the configuration. A live session is this test process (state.json without a boot id).
const A = 'a'.repeat(48), B = 'b'.repeat(48), C = 'c'.repeat(48), D = 'd'.repeat(48);
async function session(t, state = { state: 'running', pid: process.pid }) {
  const base = await mkdtemp(join(tmpdir(), 'agent-mailbox-')), root = join(base, randomWorkspaceId()), dir = join(root, 'agent');
  await mkdir(dir, { recursive: true }); t.after(() => rm(base, { recursive: true, force: true }));
  if (state) await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  return { root, dir };
}
const poll = (root, extra = {}) => agentOperation({ type: 'workspace_agent_poll', offset: 0, ...extra }, root);
async function timed(work) { const start = Date.now(); const value = await work; return { value, ms: Date.now() - start }; }
const later = (ms, work) => new Promise(resolve => setTimeout(resolve, ms)).then(work);
const request = (dir, kind, id, value = {}) => mkdir(join(dir, kind), { recursive: true }).then(() => writeFile(join(dir, kind, id + '.json'), JSON.stringify({ id, ...value })));

test('a poll without wait_ms answers at once as before; a long poll with nothing new waits out its limit', async t => {
  const { root } = await session(t);
  const quick = await timed(poll(root));
  assert.equal(quick.value.state, 'running'); assert.equal(quick.value.long_poll, undefined); assert.ok(quick.ms < 1000, `${quick.ms} ms`);
  const held = await timed(poll(root, { wait_ms: 300 }));
  assert.equal(held.value.state, 'running'); assert.equal(held.value.long_poll, true); assert.ok(held.ms >= 290, `${held.ms} ms`);
  // The limit is the runner's, whatever the caller asks.
  const capped = await timed(poll(root, { wait_ms: 60000 }));
  assert.ok(capped.ms >= 2900 && capped.ms < 6000, `${capped.ms} ms`);
});

test('a long poll returns as soon as the session asks for a tool, a token, a turn boundary or a model, or ends', async t => {
  const changes = {
    tool: dir => request(dir, 'tool-requests', A, { kind: 'control', name: 'probe', arguments: {} }),
    token: dir => request(dir, 'token-requests', A),
    boundary: dir => writeFile(join(dir, 'boundary.json'), JSON.stringify({ id: A, stage: 'turn' })),
    model: dir => writeFile(join(dir, 'request.json'), JSON.stringify({ id: A, body: { messages: [] } })),
    completed: dir => writeFile(join(dir, 'state.json'), JSON.stringify({ state: 'completed', pid: process.pid, result: { done: true } })),
    // A process of an earlier boot of the computer is gone.
    interrupted: dir => writeFile(join(dir, 'state.json'), JSON.stringify({ state: 'running', pid: process.pid, boot: 'an-earlier-boot' })),
  };
  for (const [name, change] of Object.entries(changes)) {
    const { root, dir } = await session(t);
    const [{ value, ms }] = await Promise.all([timed(poll(root, { wait_ms: 3000 })), later(150, () => change(dir))]);
    assert.ok(ms < 2000, `${name}: ${ms} ms`); assert.equal(value.long_poll, true, name);
    if (name === 'tool') assert.deepEqual(value.tool_requests, [{ id: A, kind: 'control', name: 'probe', arguments: {} }]);
    if (name === 'token') assert.deepEqual(value.token_requests, [{ id: A }]);
    if (name === 'boundary') assert.equal(value.boundary.id, A);
    if (name === 'model') assert.equal(value.request.id, A);
    if (name === 'completed') assert.deepEqual([value.state, value.result], ['completed', { done: true }]);
    if (name === 'interrupted') assert.equal(value.state, 'interrupted');
  }
});

test('what the control plane already handles does not end a long poll, and its tool and token requests come back as stubs', async t => {
  const { root, dir } = await session(t);
  await request(dir, 'tool-requests', A, { kind: 'control', name: 'probe', arguments: { large: 'x'.repeat(1000) } });
  await request(dir, 'token-requests', B);
  await writeFile(join(dir, 'boundary.json'), JSON.stringify({ id: C, stage: 'turn' }));
  await writeFile(join(dir, 'request.json'), JSON.stringify({ id: D, body: { messages: [] } }));
  const known = { known_tool_ids: [A], known_token_ids: [B], known_boundary_ids: [C], known_model_ids: [D] };
  const held = await timed(poll(root, { wait_ms: 400, ...known }));
  assert.ok(held.ms >= 390, `${held.ms} ms`);
  assert.deepEqual(held.value.tool_requests, [{ id: A, stub: true }]); assert.deepEqual(held.value.token_requests, [{ id: B, stub: true }]);
  assert.equal(held.value.boundary.id, C); assert.equal(held.value.request.id, D);
  // A request it does not know yet ends the wait, in full beside the known one.
  const [{ value, ms }] = await Promise.all([timed(poll(root, { wait_ms: 3000, ...known })), later(150, () => request(dir, 'tool-requests', D, { kind: 'control', name: 'next', arguments: {} }))]);
  assert.ok(ms < 2000, `${ms} ms`);
  assert.deepEqual(value.tool_requests.find(item => item.id === A), { id: A, stub: true });
  assert.equal(value.tool_requests.find(item => item.id === D).name, 'next');
  // model_requests belong to the other harnesses' relay and never end a Pi session's wait.
  const other = await session(t);
  await request(other.dir, 'model-requests', A, { body: {} });
  assert.ok((await timed(poll(other.root, { wait_ms: 300 }))).ms >= 290);
});

test('new events end a long poll no sooner than 200 ms after it began; a full page more ends it at once', async t => {
  const { root, dir } = await session(t), line = value => JSON.stringify(value) + '\n';
  const [{ value, ms }] = await Promise.all([timed(poll(root, { wait_ms: 3000 })), later(20, () => appendFile(join(dir, 'events.jsonl'), line({ type: 'text_delta', text: 'Hel' })))]);
  assert.ok(ms >= 195 && ms < 2000, `${ms} ms`); assert.deepEqual(value.events, [{ type: 'text_delta', text: 'Hel' }]); assert.equal(value.offset, 1);
  // An unfinished line is not an event yet.
  await appendFile(join(dir, 'events.jsonl'), '{"type":"text_delta","te');
  assert.ok((await timed(poll(root, { offset: 1, wait_ms: 300 }))).ms >= 290);
  await appendFile(join(dir, 'events.jsonl'), 'xt":"llo"}\n' + Array.from({ length: 21 }, (_, i) => line({ type: 'tool', step: i })).join(''));
  const page = await timed(poll(root, { offset: 1, wait_ms: 3000 }));
  assert.ok(page.ms < 2000, `${page.ms} ms`); assert.equal(page.value.events.length, 20); assert.equal(page.value.has_more, true);
});

test('the last configuration piece starts the session after the same cleanup and checks; another Pi version writes nothing', async t => {
  const { root, dir } = await session(t, { state: 'completed', pid: 1 });
  await request(dir, 'tool-requests', A, { kind: 'control', name: 'left-over', arguments: {} });
  const config = Buffer.from(JSON.stringify({ system: 'fixture', prompt: 'hello', tools: [] })).toString('base64');
  const spawned = [];
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => { spawned.push(args); return { pid: 4242, unref() {} }; });
  syncBuiltinESMExports(); t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const piece = extra => agentOperation({ type: 'workspace_agent_config', base64: config, offset: 0, final: true, start: true, ...extra }, root);

  // The pinned version is checked first: nothing of the earlier session is touched and nothing starts.
  const refused = await piece({ runtime_version: '0.0.0-pinned-elsewhere' });
  assert.deepEqual([refused.written, refused.started, typeof refused.runtime], [false, false, 'object']);
  assert.ok(!existsSync(join(dir, 'input.json'))); assert.ok(existsSync(join(dir, 'tool-requests', A + '.json')));
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).state, 'completed'); assert.equal(spawned.length, 0);

  // Without a pinned version it clears what the earlier process left unanswered, then starts, and says which runtime runs.
  const started = await piece({});
  assert.deepEqual([started.written, started.started, typeof started.runtime], [true, true, 'object']);
  assert.equal(spawned.length, 1); assert.ok(!existsSync(join(dir, 'tool-requests', A + '.json')));
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')).prompt, 'hello');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).pid, 4242);
  // A piece that does not finish the configuration only stores it, as before.
  const { root: other } = await session(t, null);
  assert.deepEqual(await agentOperation({ type: 'workspace_agent_config', base64: config, offset: 0, final: false }, other), { written: true });

  // A session still running refuses a new one before anything is written.
  await writeFile(join(dir, 'state.json'), JSON.stringify({ state: 'running', pid: process.pid }));
  await assert.rejects(piece({}), /agent_session_busy/); assert.equal(spawned.length, 1);
});
