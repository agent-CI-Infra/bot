import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { post } from '../../../fixtures/channel-fixture.mjs';
import { fixtureClient, fixtureHook } from '../../../fixtures/helpers.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`, h = { admin: origin, webhook: origin };
  return { server, h, client: fixtureClient(h), hook: fixtureHook(h) };
}

test('fixture clients retain cookies, CSRF and JSON after the server closes idle connections', async t => {
  const requests = [];
  const { server, client } = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, cookie: req.headers.cookie, csrf: req.headers['x-csrf-token'], intent: req.headers['x-fixture'] });
    res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=fixture; HttpOnly', 'X-Fixture': 'response' });
    res.end(JSON.stringify({ csrf_token: 'fixture-csrf', value: body ? JSON.parse(body).value : null }));
  });
  for (let i = 0; i < 4; i++) await client('/warm');
  await nextTurn();
  server.closeIdleConnections();
  const result = await client('/after', 'POST', { value: 42 }, { 'X-Fixture': 'one-write' });
  assert.equal(result.status, 201);
  assert.equal(result.value.value, 42);
  assert.equal(result.headers.get('x-fixture'), 'response');
  assert.equal(client.cookie(), 'session=fixture');
  assert.equal(client.csrf(), 'fixture-csrf');
  assert.equal(requests.length, 5);
  assert.deepEqual(requests.at(-1), { path: '/after', method: 'POST', cookie: 'session=fixture', csrf: 'fixture-csrf', intent: 'one-write' });
});

test('fixture clients surface a received write failure without retrying the operation', async t => {
  let writes = 0;
  const { client } = await fixture(t, async (req, res) => {
    if (req.url === '/write') {
      for await (const _ of req) {}
      writes++;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ writes }));
  });
  await assert.rejects(client('/write', 'POST', { value: 'once' }), error => ['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code));
  assert.equal(writes, 1);
  assert.equal((await client('/receipt')).value.writes, 1);
});

test('webhook deliveries leave no closed idle socket for the next client write', async t => {
  const requests = [], secret = 'fixture-webhook-secret';
  const { server, hook, client } = await fixture(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, raw, delivery: req.headers['x-github-delivery'], event: req.headers['x-github-event'], signature: req.headers['x-hub-signature-256'] });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: JSON.parse(raw).value }));
  });
  for (let i = 0; i < 4; i++) {
    const payload = JSON.stringify({ value: i });
    const result = await hook('/hook', secret, `delivery-${i}`, i % 2 ? payload : { value: i }, { 'X-GitHub-Event': 'pull_request' });
    assert.equal(result.status, 201);
    assert.equal(result.value.value, i);
  }
  await nextTurn();
  server.closeIdleConnections();
  const result = await client('/after', 'POST', { value: 42 });
  assert.equal(result.status, 201);
  assert.equal(result.value.value, 42);
  assert.equal(requests.length, 5);
  for (const [i, request] of requests.slice(0, 4).entries()) {
    assert.equal(request.path, '/hook');
    assert.equal(request.delivery, `delivery-${i}`);
    assert.equal(request.event, 'pull_request');
    assert.equal(request.signature, 'sha256=' + createHmac('sha256', secret).update(request.raw).digest('hex'));
  }
  assert.deepEqual(requests.at(-1), { path: '/after', method: 'POST', raw: '{"value":42}', delivery: undefined, event: undefined, signature: undefined });
});

test('successive Feishu fixture deliveries survive an idle connection close without replaying a write', async t => {
  const received = [];
  const { server, h } = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body).sequence);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  for (let sequence = 1; sequence <= 4; sequence++) await post(h, 'local', { sequence });
  await nextTurn();
  server.closeIdleConnections();
  const result = await post(h, 'local', { sequence: 5 });
  assert.deepEqual(result, { status: 200, value: { accepted: true } });
  assert.deepEqual(received, [1, 2, 3, 4, 5]);
});
