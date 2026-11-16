import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from '../dist/storage/database.js';
import { resolveChromium } from '../dist/browser/runtime.js';
import { existingBrowserSession, closeBrowserSession } from '../dist/browser/runtime.js';
import { browserEvidenceRoot, runBrowserTool } from '../dist/browser/tools.js';
import { browserEvidenceDir } from '../dist/browser/runtime.js';

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'browser-site');
const pages = {
  '/': 'index.html',
  '/about': 'about.html',
  '/delete': 'delete.html'
};

function seed(store) {
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
}

async function withSite(t) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/login') { res.writeHead(303, { Location: '/' }); res.end(); return; }
    const file = pages[url.pathname];
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(root, file)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function storeFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bot-browser-runtime-'));
  const store = new Store(join(directory, 'control.sqlite'), randomBytes(32));
  seed(store);
  t.after(async () => { await closeBrowserSession('task-browser'); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function task(store, origin, extra = {}) {
  const id = 'task-browser';
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,?,?,?,?,?)",
    id, '101', 'task.request', 'running', 'Browse the fixture',
    JSON.stringify({ request: 'Inspect the local fixture', browser: { origins: [origin], timeout_ms: 30_000, ...extra } }));
  return store.get('SELECT * FROM tasks WHERE id=?', id);
}

test('real Chromium opens a local fixture, records a PNG, and enforces origin, destructive and secret boundaries', async (t) => {
  try { resolveChromium(); }
  catch (error) {
    assert.fail(error.detail || '未找到真实 Chromium。本测试必须启动真实浏览器，缺少运行时按失败处理，不得跳过。');
  }
  const origin = await withSite(t);
  const store = storeFor(t);
  const row = task(store, origin);
  const opened = await runBrowserTool(store, row, { action: 'open', url: origin + '/' });
  assert.equal(opened.error, undefined, opened.detail || 'open should succeed');
  const seen = await runBrowserTool(store, row, { action: 'screenshot' });
  assert.equal(seen.error, undefined, seen.detail || 'screenshot should succeed');
  assert.equal(seen.step.screenshot.file, 'step-2.png');
  const file = join(browserEvidenceDir(browserEvidenceRoot(store), row.id), seen.step.screenshot.file);
  assert.equal(existsSync(file), true);
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(bytes.length > 32);
  const off = await runBrowserTool(store, row, { action: 'click', name: '外部站点' });
  assert.equal(off.error, 'browser_origin_forbidden');
  const destroy = await runBrowserTool(store, row, { action: 'click', name: '删除账号' });
  assert.equal(destroy.error, 'browser_destructive_forbidden');
  const about = await runBrowserTool(store, row, { action: 'click', name: '查看说明' });
  assert.equal(about.error, undefined, about.detail || 'ordinary click should succeed');
  const typed = await runBrowserTool(store, row, { action: 'open', url: origin + '/' });
  assert.equal(typed.error, undefined, typed.detail);
  const secret = 'fixture-password-value';
  const filled = await runBrowserTool(store, row, { action: 'type', name: '口令', text: secret });
  assert.equal(filled.secret_field, true);
  const withheld = await runBrowserTool(store, row, { action: 'screenshot' });
  assert.equal(withheld.error, 'browser_screenshot_withheld');
  const history = store.all("SELECT data FROM task_history WHERE task_id=? AND type='execution_evidence'", row.id).map(row => row.data).join('\n');
  const steps = readFileSync(join(browserEvidenceDir(browserEvidenceRoot(store), row.id), 'steps.json'), 'utf8');
  assert.equal(history.includes(secret), false);
  assert.equal(steps.includes(secret), false);
  const session = existingBrowserSession(row.id);
  const profile = session?.profileDir;
  assert.ok(profile && existsSync(profile));
  await runBrowserTool(store, row, { action: 'close' });
  assert.equal(existingBrowserSession(row.id), undefined);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(file), true);
  // Evidence directory is not a host browser profile and must not be walked as one.
  const leftover = existsSync(profile) ? readdirSync(profile) : [];
  assert.deepEqual(leftover, []);
});
