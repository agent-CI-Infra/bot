import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixtureClient } from './helpers.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, client: fixtureClient({ admin: `http://127.0.0.1:${server.address().port}` }) };
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
  await assert.rejects(client('/write', 'POST', { value: 'once' }), { name: 'TypeError', message: 'fetch failed' });
  assert.equal(writes, 1);
  assert.equal((await client('/receipt')).value.writes, 1);
});
