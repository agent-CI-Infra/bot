import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { harness, setup, account, repository, pinLegacyTaskConfiguration } from '../../../fixtures/helpers.mjs';
import { runAgent } from '../../../../dist/agent/runtime.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { readModelResponse } from '../../../../dist/agent/model-stream.js';

const key = 'stream-fixture-credential';
const sse = (delta, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, ...extra }] }) + '\n\n';
const flush = async () => { for (let i = 0; i < 5; i++) await turn(); };
async function until(check) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (check()) return; await turn(); }
  assert.fail('fixture did not reach the expected state');
}

async function fixture(t, { failures = 0 } = {}) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: key, model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('stream','101','review.pr','running','fixture')");
  pinLegacyTaskConfiguration(h.store, 'stream');
  let source, signal;
  const retries = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://model.invalid/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.max_completion_tokens, 8192);
    assert.ok(!('max_tokens' in body));
    if (failures-- > 0) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) { source = controller; signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true }); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const retried = failures > 0;
  const redactor = new Redactor();
  const running = runAgent({
    store: h.store,
    task: h.store.get("SELECT * FROM tasks WHERE id='stream'"),
    redactor,
    guard: async () => {},
    system: 'system',
    prompt: 'review',
    modelAttempts: retried ? undefined : 1,
    onModelRetry: info => { retries.push(info); },
    adapter: async services => services.request({ messages: [{ role: 'user', content: 'review' }] }, 'stream-req'),
  });
  running.catch(() => {});
  if (!retried) await until(() => source);
  return {
    h, admin, running, retries, redactor,
    get signal() { return signal; },
    send: async text => { source.enqueue(Buffer.from(text)); await flush(); },
    close: async () => { try { source.close(); } catch {} await flush(); },
    restore: () => { t.mock.timers.reset(); fetchMock.mock.restore(); },
  };
}

test('90 seconds without tokens fails even with comments, role, empty content and tool metadata; the UI names token inactivity', async t => {
  const f = await fixture(t); let ended = false; f.running.finally(() => { ended = true; }).catch(() => {});
  await f.send(sse({ role: 'assistant' }));
  t.mock.timers.tick(45000); await f.send(': keep-alive\n\n');
  t.mock.timers.tick(44000); await f.send('\n' + sse({ content: '', tool_calls: [{ index: 0, id: 'call', function: { name: 'write_file', arguments: '' } }] }));
  t.mock.timers.tick(999); await flush(); assert.equal(ended, false);
  await f.send(sse({}, { finish_reason: 'stop' }));
  t.mock.timers.tick(1);
  let failure;
  await assert.rejects(f.running, error => { failure = error; return error.code === 'model_unavailable' && error.state === 'retry_wait' && /连续 90 秒没有 token 输出/.test(error.detail); });
  assert.equal(f.signal.aborted, true);
  assert.equal(f.h.store.get('SELECT state FROM model_requests').state, 'transport_error');
  f.restore();
  f.h.store.run("UPDATE tasks SET status='retry_wait',error_code='model_unavailable' WHERE id='stream'");
  f.h.store.run('INSERT INTO task_logs(id,task_id,content) VALUES(?,?,?)', 'idle', 'stream', JSON.stringify({ type: 'fault', code: failure.code, state: failure.state, detail: failure.detail }));
  const detail = (await f.admin('/api/tasks/stream')).value.task, list = (await f.admin('/api/tasks')).value.tasks[0], log = (await f.admin('/api/tasks/stream/logs')).value.logs[0];
  for (const cause of [detail.error_cause, list.error_cause, log.cause]) {
    assert.equal(cause.cause, 'external', 'other model_unavailable causes retain their classification');
    assert.match(cause.label, /连续 90 秒没有 token 输出/); assert.match(cause.action, /自动重试/);
    assert.doesNotMatch(cause.label + cause.action, /外部服务或网络波动|不是配置问题/);
  }
});

test('model completion is reported before usage trailers without counting it as token activity', async () => {
  let source, completed; const finish = new Promise(resolve => { completed = resolve; }), tokens = [];
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  let returned = false;
  const reading = readModelResponse(response, async delta => { tokens.push(delta); }, async reason => { assert.equal(reason, 'stop'); completed(); }).then(value => { returned = true; return value; });
  source.enqueue(Buffer.from(sse({}, { finish_reason: 'stop' }))); await finish;
  assert.equal(returned, false); assert.deepEqual(tokens, []);
  source.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } }) + '\n\ndata: [DONE]\n\n')); source.close();
  assert.equal((await reading).usage.prompt_tokens, 10); assert.deepEqual(tokens, []);
});

test('text, reasoning and tool arguments keep stream alive beyond 120 seconds and record usage', async t => {
  const f = await fixture(t);
  await f.send(sse({ content: '可见文本' }));
  t.mock.timers.tick(60000); await flush();
  await f.send(sse({ reasoning_content: '推理文本' }));
  t.mock.timers.tick(60000); await flush();
  await f.send(sse({ tool_calls: [{ index: 0, id: 'tool', type: 'function', function: { name: 'write_', arguments: '{"path":"../notes/repository.md",' } }] }));
  t.mock.timers.tick(60000); await flush();
  await f.send(sse({ tool_calls: [{ index: 0, function: { name: 'file', arguments: '"content":"safe note"}' } }] }));
  await f.send(sse({}, { finish_reason: 'tool_calls' }) + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 750 } } }) + '\n\ndata: [DONE]\n\n');
  await f.close();
  const res = await f.running;
  assert.ok(Date.now() >= 1180000, 'the complete request ran for 180 seconds');
  const message = res.value.choices[0].message;
  assert.equal(message.content, '可见文本'); assert.equal(message.reasoning_content, '推理文本');
  assert.equal(message.tool_calls[0].function.name, 'write_file');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { path: '../notes/repository.md', content: 'safe note' });
  const usage = f.h.store.get('SELECT * FROM model_requests');
  assert.deepEqual([usage.state, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens], ['received', 1000, 200, 750]);
  f.restore();
});

test('the 90-second deadline resets on a token, then expires after the last token even if comments continue', async t => {
  const f = await fixture(t); t.mock.timers.tick(80000); await f.send(sse({ reasoning: 'thinking' }));
  t.mock.timers.tick(80000); await f.send(': alive\n\n'); assert.equal(f.signal.aborted, false);
  t.mock.timers.tick(9999); await flush(); assert.equal(f.signal.aborted, false);
  t.mock.timers.tick(1); await assert.rejects(f.running, error => error.code === 'model_unavailable' && /连续 90 秒没有 token 输出/.test(error.detail));
  f.restore();
});

test('fragmented credentials are redacted in note writes as well as text and reasoning', async t => {
  const f = await fixture(t);
  const args = JSON.stringify({ path: '../notes/私有笔记.txt', content: key }), at = args.indexOf(key) + 8;
  await f.send(sse({ content: key.slice(0, 8), reasoning_content: key.slice(0, 8), tool_calls: [{ index: 0, id: 'note', function: { name: 'write_file', arguments: args.slice(0, at) } }] }));
  await f.send(sse({ content: key.slice(8), reasoning_content: key.slice(8), tool_calls: [{ index: 0, function: { arguments: args.slice(at) } }] }));
  await f.send(sse({}, { finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
  await f.close();
  const res = await f.running;
  const message = f.redactor.clean(res.value).choices[0].message;
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).content, '[REDACTED]');
  assert.equal(message.content, '[REDACTED]');
  assert.equal(message.reasoning_content, '[REDACTED]');
  const row = f.h.store.get('SELECT response_snapshot FROM model_requests');
  assert.ok(!String(row.response_snapshot).includes(key), 'persisted model response snapshot must redact fragmented key');
  f.restore();
});

test('a retried model request backs off on 503 and succeeds on the third attempt', async t => {
  const f = await fixture(t, { failures: 2 });
  await until(() => f.retries.length === 1); t.mock.timers.tick(1);
  await until(() => f.retries.length === 2); t.mock.timers.tick(3);
  await until(() => f.signal);
  await f.send(sse({ content: 'done' }, { finish_reason: 'stop' }) + 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
  await f.close();
  const res = await f.running;
  assert.equal(res.value.choices[0].message.content, 'done');
  assert.deepEqual(f.h.store.all('SELECT state,http_status FROM model_requests ORDER BY rowid').map(r => [r.state, r.http_status]), [['http_error', 503], ['http_error', 503], ['received', 200]]);
  f.restore();
});

test('SSE parsing handles split UTF-8, CRLF and multi-line data, orders parallel tools, and preserves reasoning variants', async () => {
  const raw = ': comment\r\n\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中文","reasoning_text":"why","tool_calls":[{"index":1,"id":"second","function":{"name":"two","arguments":"{}"}},{"index":0,"id":"first","function":{"name":"one","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = Buffer.from(raw); let tokens = 0;
  const response = new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const result = await readModelResponse(response, async () => { tokens++; });
  assert.equal(result.choices[0].message.content, '中文'); assert.equal(result.choices[0].message.reasoning_text, 'why');
  assert.deepEqual(result.choices[0].message.tool_calls.map(c => c.id), ['first', 'second']); assert.equal(tokens, 1);
});

test('a truncated or malformed stream never forwards a partial tool call, and the response byte limit is enforced while reading', async t => {
  for (const raw of [sse({ tool_calls: [{ index: 0, function: { arguments: '{"unfinished":' } }] }), 'data: {invalid}\n\n', 'data: {"error":{"message":"provider failed"}}\n\n', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    await t.test(raw.length > 100 ? 'oversized or partial stream' : raw.trim(), async () => {
      const response = new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(raw)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
      await assert.rejects(readModelResponse(response, async () => {}), error => ['model_response_invalid', 'model_response_too_large'].includes(error.code));
    });
  }
});

test('SSE envelope overhead does not consume the assembled response budget, while actual text stays capped', async () => {
  const event = JSON.stringify({ id: 'long-envelope-id'.repeat(20), model: 'fixture', choices: [{ index: 0, delta: { content: 'x' } }] });
  const raw = ('data: ' + event + '\n\n').repeat(7000) + 'data: [DONE]\n\n';
  assert.ok(Buffer.byteLength(raw) > 2 * 1024 * 1024);
  const value = await readModelResponse(new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }), async () => {});
  assert.equal(value.choices[0].message.content.length, 7000);
  const oversized = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'x'.repeat(2 * 1024 * 1024 + 1) } }] }) + '\n\ndata: [DONE]\n\n';
  await assert.rejects(readModelResponse(new Response(oversized, { headers: { 'Content-Type': 'text/event-stream' } }), async () => {}), { code: 'model_response_too_large' });
});
