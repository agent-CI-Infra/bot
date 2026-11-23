import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { piAdapter } from '../../../../dist/agent/pi.js';

// The control plane's side of a Pi session's mailbox (src/agent/pi.ts): how it starts the session and how often it polls,
// against a runner that holds polls (#1277) and against one that answers at once (an older image, a test double).
const T = 'a'.repeat(48), M = 'b'.repeat(48);
function store(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-mailbox-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const value = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 7)); t.after(() => value.close());
  value.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  value.run("INSERT INTO repositories VALUES('101','fixture/project','10','a')");
  value.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','101','task.request','running','Fixture','{}')");
  return value;
}
// A runner mailbox; polls(request, n) answers the n-th poll (from 1).
function computer({ legacy = false, version = '1.4.0', polls }) {
  const calls = [];
  const answer = async request => {
    const call = { type: request.type, request, at: Date.now() }; calls.push(call);
    if (request.type === 'workspace_agent_config') {
      if (legacy || !request.start) return { written: true };
      const runtime = { agent: 'pi', package: '@earendil-works/pi-coding-agent', version };
      return request.runtime_version !== undefined && request.runtime_version !== version ? { written: false, started: false, runtime } : { written: true, started: true, runtime };
    }
    if (request.type === 'workspace_agent_runtime') return { agent: 'pi', version };
    if (request.type === 'workspace_agent_start') return { started: true };
    if (request.type === 'workspace_agent_poll') { const value = await polls(request, calls.filter(c => c.type === 'workspace_agent_poll').length); call.returned = Date.now(); return value; }
    return { written: true };
  };
  return { calls, workspace: { call: (_key, request) => answer(request), deliver: answer, log: () => {} } };
}
function run(t, mailbox, extra = {}) {
  const adapter = piAdapter({ store: store(t), taskId: 't', workspace: mailbox.workspace, redactor: new Redactor(), guard: async () => {},
    config: { prompt: 'hello', tools: [], control_tools: ['probe'] }, runtime: { version: '1.4.0', report: () => {} }, offered: () => true,
    control: async () => ({ result: { ok: true } }), complete: state => state.result, ...extra });
  return adapter({ request: async () => ({ value: { choices: [{ message: { role: 'assistant', content: 'ok' } }] }, status: 200, model: { model: 'm' } }), model: { id: 'm', model: 'm', url: 'http://127.0.0.1:9/v1', key: 'k' } });
}
const types = mailbox => mailbox.calls.map(call => call.type);
const gaps = mailbox => { const polls = mailbox.calls.filter(call => call.type === 'workspace_agent_poll'); return polls.slice(1).map((call, i) => call.at - polls[i].returned); };

test('with a runner that holds polls, one call starts the session and polls follow each other, naming what is already handled', async t => {
  const mailbox = computer({ polls: (_request, n) => [
    { state: 'running', long_poll: true, events: [], offset: 0, tool_requests: [{ id: T, kind: 'control', name: 'probe', arguments: {} }] },
    { state: 'running', long_poll: true, events: [], offset: 0, request: { id: M, body: { messages: [{ role: 'user', content: 'hello' }] } } },
    { state: 'running', long_poll: true, events: [], offset: 0, tool_requests: [{ id: T, stub: true }], request: { id: M, body: { messages: [] } } },
    { state: 'completed', long_poll: true, events: [], offset: 0, result: { summary: 'done' } },
  ][n - 1] });
  assert.deepEqual(await run(t, mailbox), { summary: 'done' });
  const [config, ...rest] = mailbox.calls;
  assert.deepEqual([config.type, config.request.start, config.request.runtime_version], ['workspace_agent_config', true, '1.4.0']);
  assert.ok(!types(mailbox).includes('workspace_agent_runtime') && !types(mailbox).includes('workspace_agent_start'), types(mailbox).join());
  const polls = rest.filter(call => call.type === 'workspace_agent_poll').map(call => call.request);
  assert.ok(polls.every(request => request.wait_ms === 3000));
  // The control tool runs in the background and the model request was answered: the next polls wait past both.
  assert.deepEqual([polls[0].known_tool_ids, polls[0].known_model_ids], [undefined, undefined]);
  assert.deepEqual(polls[1].known_tool_ids, [T]); assert.deepEqual(polls[2].known_model_ids, [M]);
  assert.deepEqual([polls[3].known_tool_ids, polls[3].known_model_ids], [[T], [M]]);
  assert.ok(gaps(mailbox).every(gap => gap < 450), gaps(mailbox).join());
});

test('with a runner that answers at once, the runtime query and start follow the configuration and polls keep 500 ms apart', async t => {
  const mailbox = computer({ legacy: true, polls: (_request, n) => n < 3 ? { state: 'running', events: [], offset: 0 } : { state: 'completed', events: [], offset: 0, result: { summary: 'done' } } });
  assert.deepEqual(await run(t, mailbox), { summary: 'done' });
  assert.deepEqual(types(mailbox).slice(0, 4), ['workspace_agent_config', 'workspace_agent_runtime', 'workspace_agent_start', 'workspace_agent_poll']);
  assert.ok(gaps(mailbox).length === 2 && gaps(mailbox).every(gap => gap >= 450), gaps(mailbox).join());
});

test('another Pi version stops a new session before it starts, as the separate runtime query did', async t => {
  for (const legacy of [false, true]) {
    const mailbox = computer({ legacy, version: '9.9.9', polls: () => assert.fail('no poll') });
    await assert.rejects(run(t, mailbox), error => error.code === 'harness_version_mismatch' && /9\.9\.9/.test(error.detail));
    assert.ok(!types(mailbox).includes('workspace_agent_start') && !types(mailbox).includes('workspace_agent_poll'), types(mailbox).join());
  }
});

test('a held poll ends at once when the session is cancelled or background work fails', async t => {
  const held = () => new Promise(() => {});
  const controller = new AbortController(), cancelled = new Error('cancelled by the user');
  const waiting = computer({ polls: held });
  setTimeout(() => controller.abort(cancelled), 100);
  const start = Date.now();
  await assert.rejects(run(t, waiting, { signal: controller.signal }), error => error === cancelled);
  assert.ok(Date.now() - start < 2500, `${Date.now() - start} ms`);

  // The tool's reply cannot be delivered while the next poll is held.
  const failing = computer({ polls: (_request, n) => n === 1 ? { state: 'running', long_poll: true, events: [], offset: 0, tool_requests: [{ id: T, kind: 'repository', name: 'github_read', arguments: {} }] } : held() });
  const deliver = failing.workspace.deliver;
  failing.workspace.deliver = async request => request.type === 'workspace_agent_tool' ? { error: 'runner_operation_failed' } : deliver(request);
  const began = Date.now();
  await assert.rejects(run(t, failing), error => error.code === 'execution_interrupted');
  assert.ok(Date.now() - began < 2500, `${Date.now() - began} ms`);
});
