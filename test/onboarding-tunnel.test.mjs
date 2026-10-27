import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { harness, setup } from './helpers.mjs';
import { loadConsole } from './console-page.mjs';
import { Onboarding } from '../dist/onboarding/service.js';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const fixtureToken = () => encode({ a: 'fixture-account', t: 'fixture-tunnel', s: randomBytes(32).toString('hex') });
async function tunnelHarness(t) {
  let onboarding;
  const h = await harness(t, undefined, store => ({ maxBodyBytes: 2 * 1024 * 1024, onboarding: onboarding = new Onboarding(store) }));
  onboarding.options.tunnelFile = h.directory + '/tunnel/token';
  return { h, onboarding, ...await setup(h) };
}

test('Cloudflare commands and multi-line instructions save only their unique token without exposing the paste', async t => {
  const { h, onboarding, admin } = await tunnelHarness(t), token = fixtureToken();
  const commands = [
    `  ${token}  `,
    `sudo cloudflared service install ${token}`,
    `cloudflared tunnel run --token ${token}`,
    `cloudflared tunnel run --token=${token}`,
    `cloudflared tunnel run --token='${token}'`,
    `cloudflared tunnel run --token "${token}"`,
    `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token '${token}'`,
    `curl -L https://example.invalid/cloudflared.deb -o cloudflared.deb\nsudo dpkg -i cloudflared.deb\nsudo cloudflared service install "${token}"\nCheck the service`,
    ['cloudflared tunnel run \\', '  --token \\', `  '${token}'`].join('\r\n'),
    `sudo cloudflared service install '${token}'\ncloudflared tunnel run --token=${token}`,
    `Instructions\n${'Installation notes\n'.repeat(1500)}sudo cloudflared service install '${token}'`,
    `Token:\n'${token}'`,
  ];
  for (const command of commands) {
    const response = await admin('/api/onboarding/tunnel', 'POST', { token: command });
    assert.equal(response.status, 201);
    assert.equal(readFileSync(onboarding.options.tunnelFile, 'utf8'), token);
    assert.equal(statSync(onboarding.options.tunnelFile).mode & 0o777, 0o600);
    assert.deepEqual(h.store.secrets.open(onboarding.saved('tunnel'), 'onboarding:tunnel'), { value: token });
    const visible = JSON.stringify([response.value, (await admin('/api/onboarding')).value,
      h.store.all('SELECT * FROM settings'), h.store.all('SELECT * FROM audit')]);
    assert.ok(!visible.includes(token));
    assert.ok(!visible.includes(command));
    assert.ok(!visible.includes('cloudflared'));
  }
  // Blank input still keeps the saved credential, as advertised by the form.
  assert.equal((await admin('/api/onboarding/tunnel', 'POST', { token: '' })).status, 201);
  assert.equal(readFileSync(onboarding.options.tunnelFile, 'utf8'), token);
});

test('invalid and ambiguous pastes cannot create or replace tunnel credentials', async t => {
  const { h, onboarding, admin } = await tunnelHarness(t), first = fixtureToken(), second = fixtureToken();
  const invalid = [
    'sudo cloudflared service install missing-token',
    'curl -L https://example.invalid/cloudflared.deb -o cloudflared.deb',
    ...[null, {}, { a: 'account', t: 'tunnel' }, { a: 1, t: 'tunnel', s: 'secret' },
      { a: 'account', t: [], s: 'secret' }, { a: 'account', t: 'tunnel', s: '' },
      { a: 'account', t: 'tunnel', s: ' ' }].map(encode),
    `cloudflared tunnel run --token ${first}!`,
    `cloudflared tunnel run --token ${first}===`,
    `curl https://example.invalid/${first}\nsudo dpkg -i ${first}.deb`,
    `cloudflared tunnel run --token ${first}\nsudo cloudflared service install '${second}'`,
    `cloudflared tunnel run --token=${first}\n'${second}'`,
    `sudo cloudflared service install ${first}\ncloudflared tunnel run --token="${second}"`,
  ];
  const reject = async command => {
    const response = await admin('/api/onboarding/tunnel', 'POST', { token: command });
    assert.equal(response.status, 400);
    assert.equal(response.value.error, 'invalid_tunnel_token');
    assert.ok(!JSON.stringify(response.value).includes(command));
  };
  for (const command of invalid) {
    await reject(command);
    assert.equal(existsSync(onboarding.options.tunnelFile), false);
    assert.equal(existsSync(h.directory + '/tunnel'), false);
    assert.equal(onboarding.saved('tunnel'), null);
  }
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='onboarding.tunnel_updated'").n, 0);
  await admin('/api/onboarding/tunnel', 'POST', { token: first });
  const sealed = onboarding.saved('tunnel');
  for (const command of invalid) {
    await reject(command);
    assert.equal(readFileSync(onboarding.options.tunnelFile, 'utf8'), first);
    assert.equal(onboarding.saved('tunnel'), sealed);
    assert.deepEqual(readdirSync(h.directory + '/tunnel'), ['token']);
  }
  const oversized = await admin('/api/onboarding/tunnel', 'POST', { token: ' '.repeat(128 * 1024) + first });
  assert.equal(oversized.status, 400);
  assert.equal(readFileSync(onboarding.options.tunnelFile, 'utf8'), first);
});

// Exercise the actual bridge handlers with an in-memory HTTP transport, without binding deployment ports.
function bridge(config) {
  const handlers = [];
  vm.runInNewContext(readFileSync('webhook/main.mjs', 'utf8').replace("import http from 'node:http';", ''), {
    http: { createServer(handler) { handlers.push(handler); return { listen() {} }; } },
    fetch: async () => new Response(JSON.stringify(config)), URL, AbortSignal,
  });
  return async path => {
    let status, body;
    await handlers[1]({ method: 'GET', url: path }, { writeHead(value) { status = value; }, end(value) { body = value; } });
    return { status, value: body && JSON.parse(body) };
  };
}

test('the tunnel bridge preserves only safe status services and HTTP origins', async t => {
  const secret = randomBytes(24).toString('hex');
  const request = bridge({ token: secret, config: { secret, ingress: [
    { hostname: 'hooks.invalid', service: 'http://webhook:8791', originRequest: { headers: { Authorization: secret } } },
    { hostname: '', service: 'http_status:404' },
    { hostname: '', service: 'http_status:503' },
    { hostname: 'wrong.invalid', service: 'http://bot:8792' },
    { hostname: 'other.invalid', service: `https://user:${secret}@example.invalid/private?token=${secret}` },
    ...[`http_status:404${secret}`, 'http_status:40', 'http_status:4044', `ssh://user:${secret}@example.invalid`, secret, null]
      .map(service => ({ hostname: 'unsupported.invalid', service })),
    { service: 'http_status:404' },
  ] } });
  const result = await request('/config');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.config.ingress.slice(0, 5), [
    { hostname: 'hooks.invalid', service: 'http://webhook:8791' },
    { hostname: '', service: 'http_status:404' },
    { hostname: '', service: 'http_status:503' },
    { hostname: 'wrong.invalid', service: 'http://bot:8792' },
    { hostname: 'other.invalid', service: 'https://example.invalid' },
  ]);
  assert.ok(result.value.config.ingress.slice(5, -1).every(route => route.service === 'unsupported service'));
  assert.deepEqual(result.value.config.ingress.at(-1), { hostname: '', service: 'http_status:404' });
  assert.ok(!JSON.stringify(result.value).includes(secret));
  assert.ok(!JSON.stringify(result.value).includes('invalid route'));
  const { onboarding, admin } = await tunnelHarness(t);
  await admin('/api/onboarding/tunnel', 'POST', { token: fixtureToken() });
  onboarding.options.tunnelMetrics = 'http://bridge.invalid';
  onboarding.options.fetcher = async raw => {
    const response = await request(new URL(raw).pathname);
    return new Response(JSON.stringify(response.value), { status: response.status });
  };
  const view = (await admin('/api/onboarding')).value.tunnel;
  assert.equal(view.state, 'connected');
  assert.deepEqual(view.routes[1], { hostname: '', service: 'http_status:404', webhook_route: false });
  assert.deepEqual(view.routes[3], { hostname: 'wrong.invalid', service: 'http://bot:8792', webhook_route: false });
});

test('the wizard explains fallback rules once and still warns about named non-webhook routes', async () => {
  const routes = [
    { hostname: 'hooks.invalid', service: 'http://webhook:8791', webhook_route: true },
    { hostname: '', service: 'http_status:404', webhook_route: false },
    { hostname: '', service: 'http_status:404', webhook_route: false },
    { hostname: 'wrong.invalid', service: 'http://bot:8792', webhook_route: false },
    { hostname: 'named-status.invalid', service: 'http_status:404', webhook_route: false },
  ];
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/onboarding.js'], (_method, path) => {
    if (path === '/api/onboarding') return [200, { tunnel: { state: 'connected', origin: 'http://webhook:8791', routes } }];
    if (path === '/api/models') return [200, { models: [] }];
    throw new Error('Unexpected request: ' + path);
  });
  const draw = () => page.run('onboardingTunnel=true;renderOnboarding(renderVersion)');
  await draw();
  const tunnel = page.$('onboarding-panel').querySelector('#wizard-tunnel'), rows = tunnel.querySelectorAll('.row');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('p').textContent, 'hooks.invalid → http://webhook:8791');
  assert.equal(rows[0].querySelector('button').textContent, '检查并使用此域名');
  assert.equal(rows[1].querySelector('p').textContent, 'wrong.invalid → http://bot:8792');
  assert.equal(rows[2].querySelector('p').textContent, 'named-status.invalid → http_status:404');
  assert.ok(rows.slice(1).every(row => row.querySelector('.status-danger').textContent === '不是 webhook 路由'));
  const explanations = () => page.$('onboarding-panel').querySelector('#wizard-tunnel').querySelectorAll('p').filter(p => p.textContent.includes('自带的兜底规则'));
  assert.equal(explanations().length, 1);
  assert.ok(explanations()[0].classList.contains('muted'));
  assert.match(explanations()[0].textContent, /返回 404.*不是连接故障/);
  const credential = tunnel.querySelectorAll('input').find(input => input.name === 'token');
  assert.equal(credential.type, 'password');
  assert.equal(credential.maxLength, 128 * 1024);
  let prevented = false;
  credential.selectionStart = credential.selectionEnd = 0;
  credential.setRangeText = (value, start, end, mode) => {
    assert.deepEqual([start, end, mode], [0, 0, 'end']); credential.value = value;
  };
  const token = fixtureToken();
  credential.listeners.paste[0]({ preventDefault() { prevented = true; },
    clipboardData: { getData: () => ['Install', 'sudo cloudflared service install \\', `"${token}"`, 'Check status'].join('\r\n') } });
  assert.equal(prevented, true);
  assert.equal(credential.value, `Install sudo cloudflared service install "${token}" Check status`);
  routes.splice(1, 2);
  await draw();
  assert.equal(explanations().length, 0);
});
