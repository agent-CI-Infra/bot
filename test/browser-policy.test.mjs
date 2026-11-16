import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { account, harness, repository, setup, testPassword } from './helpers.mjs';
import { allowedOrigin, browserPolicyOf, destructiveAllowed, networkRequestAllowed, originOf, redactArgs, redactBrowserValue, redactRecordedUrl, sanitizeBrowserTrajectory, tighterDestructive } from '../dist/browser/policy.js';
import { ACTION_TIMEOUT_POLL_MS, actionTimeoutResult, boundedTimeoutMs, defaultTimeoutMs, maxTimeoutMs, normalizePolicy, startActionTimeout } from '../runner/browser-policy.mjs';
import { listBrowserEvidence } from '../dist/browser/evidence.js';
import { browserEvidenceDir } from '../dist/browser/runtime.js';
import { browserEvidenceRoot } from '../dist/browser/tools.js';

const policy = (origins, extra = {}) => ({ origins, allow_destructive: false, timeout_ms: 60_000, ...extra });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
const pngSha = createHash('sha256').update(png).digest('hex');

test('browser policy accepts only declared http(s) origins and rejects credentials', () => {
  const allowed = policy(['http://127.0.0.1:8080']);
  assert.equal(originOf('http://127.0.0.1:8080/path'), 'http://127.0.0.1:8080');
  assert.equal(originOf('https://user:pass@example.com/'), null);
  assert.equal(originOf('file:///tmp/x'), null);
  assert.equal(originOf('javascript:alert(1)'), null);
  assert.equal(originOf('http://0.0.0.0/'), null);
  assert.equal(allowedOrigin(allowed, 'http://127.0.0.1:8080/about').ok, true);
  assert.equal(allowedOrigin(allowed, 'https://evil.example/outside').error, 'browser_origin_forbidden');
  assert.equal(allowedOrigin(allowed, 'http://user:secret@127.0.0.1:8080/').error, 'browser_url_refused');
});

test('browser policy withholds destructive actions until the task grants them', () => {
  const denied = policy(['http://127.0.0.1:8080']);
  const granted = policy(['http://127.0.0.1:8080'], { allow_destructive: ['/delete'] });
  assert.equal(destructiveAllowed(denied, '/about', '查看说明').ok, true);
  assert.equal(destructiveAllowed(denied, '/delete', '删除账号').error, 'browser_destructive_forbidden');
  assert.equal(destructiveAllowed(granted, '/delete', '删除账号').ok, true);
  assert.equal(destructiveAllowed(policy(['http://127.0.0.1:8080'], { allow_destructive: true }), '/checkout', '结算下单').ok, true);
  // The check is a heuristic, not a complete detector: a generic confirm is not withheld.
  assert.equal(destructiveAllowed(denied, '/submit', '确认').ok, true);
});

test('browser policy is absent unless the task lists at least one allowed origin', () => {
  const task = (input) => ({ input: JSON.stringify(input) });
  assert.equal(browserPolicyOf(task({})), null);
  assert.equal(browserPolicyOf(task({ browser: { origins: ['file:///tmp'] } })), null);
  assert.deepEqual(browserPolicyOf(task({ browser: { origins: ['http://127.0.0.1:9', 'http://127.0.0.1:9'] } })).origins, ['http://127.0.0.1:9']);
});

test('credential field names are stripped from recorded browser values', () => {
  const cleaned = redactBrowserValue({ text: 'visible', password: 'hidden', cookie: 'sid', step: { screenshot: { file: 'step-1.png' } } });
  assert.equal(cleaned.password, '[redacted]');
  assert.equal(cleaned.cookie, '[redacted]');
  assert.equal(cleaned.text, 'visible');
  assert.equal(cleaned.step.screenshot.file, 'step-1.png');
});

test('every network request is bound to the same origin allowlist', () => {
  const allowed = policy(['http://127.0.0.1:8080']);
  assert.equal(networkRequestAllowed(allowed, 'http://127.0.0.1:8080/app.js').ok, true);
  assert.equal(networkRequestAllowed(allowed, 'https://evil.example/pixel.png').error, 'browser_origin_forbidden');
  assert.equal(networkRequestAllowed(allowed, 'http://127.0.0.1:8080/go').ok, true);
  assert.equal(networkRequestAllowed(allowed, 'about:blank').ok, true);
  assert.equal(networkRequestAllowed(allowed, 'data:text/plain,ok').ok, true);
  assert.equal(networkRequestAllowed(allowed, 'blob:http://127.0.0.1:8080/abc').ok, true);
  assert.equal(networkRequestAllowed(allowed, 'file:///etc/passwd').error, 'browser_url_refused');
});

test('recorded page addresses drop token-like query and fragment values', () => {
  assert.equal(
    redactRecordedUrl('http://127.0.0.1:8080/cb?access_token=super-secret&tab=1'),
    'http://127.0.0.1:8080/cb?access_token=%5Bredacted%5D&tab=1'
  );
  assert.equal(redactRecordedUrl('http://127.0.0.1:8080/app#id_token=abc'), 'http://127.0.0.1:8080/app#redacted');
  assert.equal(redactRecordedUrl('about:blank'), 'about:blank');
});

test('task detail and evidence routes expose stored screenshots and refuse path traversal', async (t) => {
  const h = await harness(t);
  const { admin } = await setup(h);
  const acct = await account(admin);
  await repository(admin, acct.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('browse-1','101','task.request','succeeded','Fixture',?)",
    JSON.stringify({ request: 'Inspect the fixture', browser: { origins: ['http://127.0.0.1:9'] } }));
  const dir = browserEvidenceDir(browserEvidenceRoot(h.store), 'browse-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'step-1.png'), png);
  writeFileSync(join(dir, 'secret.png'), png);
  writeFileSync(join(dir, 'steps.json'), JSON.stringify({
    task_id: 'browse-1',
    steps: [{ id: 'step-1', n: 1, at: '2026-11-16T00:00:00.000Z', action: 'screenshot', url: 'http://127.0.0.1:9/', title: '夹具', result: 'ok', screenshot: { file: 'step-1.png', sha256: pngSha, bytes: png.length } }]
  }));
  const listed = listBrowserEvidence(h.store, 'browse-1');
  assert.equal(listed.steps.length, 1);
  assert.equal(listed.total_steps, 1);
  assert.equal(listed.truncated, false);
  assert.equal(listed.steps[0].screenshot.url, '/api/tasks/browse-1/browser-evidence/step-1.png');
  const detail = await admin('/api/tasks/browse-1');
  assert.equal(detail.status, 200);
  assert.equal(detail.value.browser_evidence.steps[0].screenshot.file, 'step-1.png');
  const shot = await fetch(h.admin + '/api/tasks/browse-1/browser-evidence/step-1.png', { headers: { Cookie: admin.cookie() } });
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await shot.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const denied = await fetch(h.admin + '/api/tasks/browse-1/browser-evidence/secret.png', { headers: { Cookie: admin.cookie() } });
  assert.equal(denied.status, 404);
  const traversal = await fetch(h.admin + '/api/tasks/browse-1/browser-evidence/..%2Fsteps.json', { headers: { Cookie: admin.cookie() } });
  assert.equal(traversal.status, 404);
  const anon = await fetch(h.admin + '/api/tasks/browse-1/browser-evidence/step-1.png');
  assert.equal(anon.status, 401);
  const password = testPassword();
  await repository(admin, acct.id, '202');
  const created = await admin('/api/users', 'POST', { username: 'outsider', password, repository_ids: ['202'] });
  assert.equal(created.status, 201);
  const outsider = h.client();
  const login = await outsider('/api/auth/login', 'POST', { username: 'outsider', password });
  assert.equal(login.status, 200);
  const hiddenList = await fetch(h.admin + '/api/tasks/browse-1/browser-evidence', { headers: { Cookie: outsider.cookie() } });
  assert.equal(hiddenList.status, 404);
  const hiddenShot = await fetch(h.admin + '/api/tasks/browse-1/browser-evidence/step-1.png', { headers: { Cookie: outsider.cookie() } });
  assert.equal(hiddenShot.status, 404);
  writeFileSync(join(dir, 'steps.json'), JSON.stringify({
    task_id: 'browse-1',
    steps: [{ id: 'step-1', n: 1, at: '2026-11-16T00:00:00.000Z', action: 'open', url: 'http://127.0.0.1:9/cb?access_token=super-secret', title: '夹具', result: 'ok' }]
  }));
  const cleaned = listBrowserEvidence(h.store, 'browse-1');
  assert.equal(cleaned.steps[0].url.includes('super-secret'), false);
  assert.ok(cleaned.steps[0].url.includes('[redacted]') || cleaned.steps[0].url.includes('%5Bredacted%5D'));
});

test('recorded tool arguments redact token query values on url fields', () => {
  const cleaned = redactArgs({ action: 'open', url: 'http://127.0.0.1:8080/cb?access_token=super-secret&tab=1' });
  assert.equal(String(cleaned.url).includes('super-secret'), false);
  assert.ok(String(cleaned.url).includes('[redacted]') || String(cleaned.url).includes('%5Bredacted%5D'));
});

test('evidence routes reject a bad percent-encoding and a checksum mismatch', async (t) => {
  const h = await harness(t);
  const { admin } = await setup(h);
  const acct = await account(admin);
  await repository(admin, acct.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('browse-bad','101','task.request','succeeded','Fixture',?)",
    JSON.stringify({ request: 'Inspect the fixture', browser: { origins: ['http://127.0.0.1:9'] } }));
  const dir = browserEvidenceDir(browserEvidenceRoot(h.store), 'browse-bad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'step-1.png'), png);
  writeFileSync(join(dir, 'steps.json'), JSON.stringify({
    task_id: 'browse-bad',
    steps: [{ id: 'step-1', n: 1, at: '2026-11-16T00:00:00.000Z', action: 'screenshot', url: 'http://127.0.0.1:9/', title: '夹具', result: 'ok', screenshot: { file: 'step-1.png', sha256: '0'.repeat(64), bytes: png.length } }]
  }));
  const mismatched = await fetch(h.admin + '/api/tasks/browse-bad/browser-evidence/step-1.png', { headers: { Cookie: admin.cookie() } });
  assert.equal(mismatched.status, 404);
  const bad = await fetch(h.admin + '/api/tasks/browse-bad/browser-evidence/step-1.png%', { headers: { Cookie: admin.cookie() } });
  assert.ok([400, 404].includes(bad.status), 'an illegal encoding must not become a 5xx');
});

test('stored browser trajectories omit typed text and screenshot bytes', () => {
  const recorded = sanitizeBrowserTrajectory({
    request: { type: 'workspace_browser', action: 'type', args: { text: 'fixture-password-value', name: '口令' } },
    result: { screenshot: { file: 'step-1.png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }, title: '登录' }
  });
  assert.equal(recorded.request.args.text, '[redacted]');
  assert.equal(recorded.result.screenshot.base64, '[omitted]');
  assert.equal(recorded.result.screenshot.file, 'step-1.png');
  assert.equal(JSON.stringify(recorded).includes('fixture-password-value'), false);
});

test('destructive grants may only shrink for an existing session', () => {
  assert.equal(tighterDestructive(true, false), false);
  assert.equal(tighterDestructive(false, true), false);
  assert.deepEqual(tighterDestructive(true, ['https://example/app']), ['https://example/app']);
  assert.deepEqual(tighterDestructive(['https://example/app'], true), ['https://example/app']);
  assert.deepEqual(tighterDestructive(['https://example/'], ['https://example/app']), ['https://example/app']);
  assert.deepEqual(tighterDestructive(['https://example/app'], ['https://example/']), ['https://example/app']);
  assert.deepEqual(tighterDestructive(['https://example/x'], ['https://example/y']), []);
});

test('too-small and too-large policy timeouts stay inside the 1s–180s bound', () => {
  assert.equal(boundedTimeoutMs(1), 1_000);
  assert.equal(boundedTimeoutMs(999), 1_000);
  assert.equal(boundedTimeoutMs(10 * 60 * 1000), maxTimeoutMs);
  assert.equal(boundedTimeoutMs(maxTimeoutMs + 1), maxTimeoutMs);
  assert.equal(boundedTimeoutMs(undefined), defaultTimeoutMs);
  assert.equal(boundedTimeoutMs(Number.NaN), defaultTimeoutMs);
  assert.equal(normalizePolicy({ origins: ['http://127.0.0.1:9'], timeout_ms: 50 }).timeout_ms, 1_000);
  assert.equal(normalizePolicy({ origins: ['http://127.0.0.1:9'], timeout_ms: 10 * 60 * 1000 }).timeout_ms, maxTimeoutMs);
  assert.equal(ACTION_TIMEOUT_POLL_MS, 1_000);
});

async function intervalDelaysOf(t) {
  const delays = { interval: [], timeout: [] };
  const nativeInterval = setInterval;
  const nativeTimeout = setTimeout;
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
    delays.interval.push(delay);
    return nativeInterval(callback, delay, ...args);
  });
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    delays.timeout.push(delay);
    return nativeTimeout(callback, delay, ...args);
  });
  return delays;
}

test('an undersized policy timeout expires at the 1s bound via a fixed interval deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  const delays = await intervalDelaysOf(t);
  const timeout = startActionTimeout(1);
  t.after(() => timeout.stop());
  assert.equal(timeout.deadline, 1_000_000 + 1_000);
  assert.deepEqual(delays.interval, [ACTION_TIMEOUT_POLL_MS]);
  assert.deepEqual(delays.timeout, []);
  let settled = false;
  const waiting = timeout.promise.then(value => {
    settled = true;
    return value;
  });
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(timeout.timedOut, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await waiting, actionTimeoutResult());
  assert.equal(timeout.timedOut, true);
  assert.deepEqual(delays.timeout, []);
  assert.ok(delays.interval.every(delay => delay === ACTION_TIMEOUT_POLL_MS));
});

test('an oversized policy timeout expires at the 180s bound via a fixed interval deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  const delays = await intervalDelaysOf(t);
  const timeout = startActionTimeout(10 * 60 * 1000);
  t.after(() => timeout.stop());
  assert.equal(timeout.deadline, 1_000_000 + maxTimeoutMs);
  assert.deepEqual(delays.interval, [ACTION_TIMEOUT_POLL_MS]);
  assert.deepEqual(delays.timeout, []);
  let settled = false;
  const waiting = timeout.promise.then(value => {
    settled = true;
    return value;
  });
  t.mock.timers.tick(ACTION_TIMEOUT_POLL_MS);
  await Promise.resolve();
  assert.equal(settled, false, 'a 1s poll must not treat the poll interval as the action timeout');
  assert.equal(timeout.timedOut, false);
  t.mock.timers.tick(maxTimeoutMs - ACTION_TIMEOUT_POLL_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(timeout.timedOut, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await waiting, actionTimeoutResult());
  assert.equal(timeout.timedOut, true);
  assert.deepEqual(delays.timeout, []);
  assert.ok(delays.interval.every(delay => delay === ACTION_TIMEOUT_POLL_MS));
});

test('a finished action wins the race and stop() clears the deadline interval', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  const timeout = startActionTimeout(5_000);
  const outcome = await Promise.race([Promise.resolve({ ok: true }), timeout.promise]);
  timeout.stop();
  assert.deepEqual(outcome, { ok: true });
  t.mock.timers.tick(5_000);
  await Promise.resolve();
  assert.equal(timeout.timedOut, false);
});
