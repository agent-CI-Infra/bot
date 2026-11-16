import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { account, harness, repository, setup } from './helpers.mjs';
import { allowedOrigin, browserPolicyOf, destructiveAllowed, originOf, redactBrowserValue } from '../dist/browser/policy.js';
import { listBrowserEvidence } from '../dist/browser/evidence.js';
import { browserEvidenceDir } from '../dist/browser/runtime.js';
import { browserEvidenceRoot } from '../dist/browser/tools.js';

const policy = (origins, extra = {}) => ({ origins, allow_destructive: false, timeout_ms: 60_000, ...extra });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

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
    steps: [{ id: 'step-1', n: 1, at: '2026-11-16T00:00:00.000Z', action: 'screenshot', url: 'http://127.0.0.1:9/', title: '夹具', result: 'ok', screenshot: { file: 'step-1.png', sha256: 'abc', bytes: png.length } }]
  }));
  const listed = listBrowserEvidence(h.store, 'browse-1');
  assert.equal(listed.steps.length, 1);
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
});
