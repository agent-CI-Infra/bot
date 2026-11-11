import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup } from './helpers.mjs';
import { loginBucket } from '../dist/core/client-address.js';

// #293: the password login limit follows the real client behind a reverse proxy, but only when the immediate peer is a
// configured trusted proxy. Without that trust the socket is the client, so a forged header cannot move a bucket.
const trusted = { trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] };
const login = (client, password, headers) => client('/api/auth/login', 'POST', { username: 'administrator', password }, headers);
async function fail20(client, headers) {
  for (let i = 0; i < 20; i++) assert.equal((await login(client, 'wrong-password-' + i, headers)).status, 401);
}

test('each real client behind a trusted proxy gets its own login bucket', async t => {
  const h = await harness(t, undefined, trusted), { password } = await setup(h);
  const a = h.client(), b = h.client();
  await fail20(a, { 'X-Forwarded-For': '198.51.100.10' });
  // Twenty failures block the client that made them...
  assert.equal((await login(a, password, { 'X-Forwarded-For': '198.51.100.10' })).status, 429);
  // ...and do not block another client of the same proxy.
  const other = await login(b, password, { 'X-Forwarded-For': '198.51.100.20' });
  assert.equal(other.status, 200);
  assert.ok(other.value.csrf_token);
  // A client already at the limit stays blocked while the other client is signed in.
  assert.equal((await login(a, password, { 'X-Forwarded-For': '198.51.100.10' })).status, 429);
});

test('a forged forwarded address does not change the bucket without a trusted proxy', async t => {
  const h = await harness(t), { password } = await setup(h);
  const a = h.client();
  // Every request claims a different client, but the proxy is not trusted, so the socket address is the bucket.
  for (let i = 0; i < 20; i++) assert.equal((await login(a, 'wrong-password-' + i, { 'X-Forwarded-For': '198.51.100.' + (10 + i) })).status, 401);
  assert.equal((await login(a, password, { 'X-Forwarded-For': '203.0.113.99' })).status, 429);
  // A second connection from the same peer shares that bucket; the hint did not buy a fresh one.
  assert.equal((await login(h.client(), password, { 'X-Forwarded-For': '203.0.113.98' })).status, 429);
});

test('a trusted proxy may name the client in Forwarded as well', async t => {
  const h = await harness(t, undefined, trusted), { password } = await setup(h);
  const a = h.client();
  await fail20(a, { Forwarded: 'for="198.51.100.30:51234";proto=https' });
  assert.equal((await login(a, password, { Forwarded: 'for=198.51.100.30' })).status, 429);
  assert.equal((await login(h.client(), password, { Forwarded: 'for=198.51.100.40' })).status, 200);
});

// #361: a trusted-proxy entry may be a CIDR range. The prefix length is checked against the address width (32 or 128),
// never against the family number isIP() answers — otherwise every /8, /32 or /64 is refused, the proxy trust is
// silently dropped, and every client behind that proxy shares one bucket again. These call the resolver directly.
const bucket = (peer, trusted, headers = {}) => loginBucket({ socket: { remoteAddress: peer }, headers }, trusted);

test('a trusted proxy entry is a CIDR range of any prefix length', () => {
  // Each case: name, peer, trusted proxies, the forwarded client, the bucket it must resolve to.
  const cases = [
    // A container network written the way the docs suggest.
    ['network', '10.1.2.3', ['10.0.0.0/8'], '198.51.100.7', '198.51.100.7'],
    // The network address itself is 0 after masking: a valid entry, not an unparsable one.
    ['network address', '10.0.0.0', ['10.0.0.0/8'], '198.51.100.7', '198.51.100.7'],
    // A host route.
    ['host route', '127.0.0.1', ['127.0.0.1/32'], '198.51.100.7', '198.51.100.7'],
    // IPv6: a /64, and the whole space.
    ['v6 range', '2001:db8:1::5', ['2001:db8:1::/64'], '198.51.100.7', '198.51.100.7'],
    ['v6 everything', '2001:db8::5', ['::/0'], '198.51.100.7', '198.51.100.7'],
    // An IPv4-mapped peer is the IPv4 client.
    ['mapped peer', '::ffff:10.1.2.3', ['10.0.0.0/8'], '198.51.100.7', '198.51.100.7'],
    // The chain is walked from the nearest hop back: trusted hops are skipped, the first untrusted one is the client.
    ['chain', '127.0.0.1', ['127.0.0.1', '10.0.0.0/8'], '1.2.3.4, 10.0.0.2', '1.2.3.4'],
    // 0.0.0.0/0 trusts every hop, so the socket stays the client; kept as a check of the range maths, not as evidence.
    ['whole v4 space', '10.1.2.3', ['0.0.0.0/0'], '198.51.100.7', '10.1.2.3'],
  ];
  assert.deepEqual(cases.map(([name, peer, trusted, forwarded]) => [name, bucket(peer, trusted, { 'x-forwarded-for': forwarded })]),
    cases.map(([name, , , , expected]) => [name, expected]));
});

test('a CIDR entry trusts only the addresses inside it', () => {
  // A neighbour outside the range is not our proxy: the socket stays the client.
  assert.equal(bucket('10.1.3.4', ['10.1.2.0/24'], { 'x-forwarded-for': '198.51.100.7' }), '10.1.3.4');
  assert.equal(bucket('2001:db8:2::5', ['2001:db8:1::/64'], { 'x-forwarded-for': '198.51.100.7' }), '2001:db8:2::5');
  // A prefix longer than the family allows is refused, not rounded.
  assert.equal(bucket('10.1.2.3', ['10.0.0.0/33'], { 'x-forwarded-for': '198.51.100.7' }), '10.1.2.3');
  // No trusted proxy at all ignores the header; a malformed entry trusts nothing and does not throw.
  assert.equal(bucket('10.1.2.3', [], { 'x-forwarded-for': '198.51.100.7' }), '10.1.2.3');
  assert.equal(bucket('10.1.2.3', ['nonsense/8'], { 'x-forwarded-for': '198.51.100.7' }), '10.1.2.3');
  // A forwarded chain of only trusted hops falls back to the socket, as before.
  assert.equal(bucket('10.1.2.3', ['10.0.0.0/8'], { 'x-forwarded-for': '10.0.0.9' }), '10.1.2.3');
});
