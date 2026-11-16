import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { Workspace } from '../dist/agent/workspace.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { browserEvidenceRoot, runBrowserTool, closeBrowserOnComputer } from '../dist/browser/tools.js';
import { browserEvidenceDir } from '../dist/browser/runtime.js';

const pagesRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'browser-site');
const pages = { '/': 'index.html', '/about': 'about.html', '/delete': 'delete.html' };

function resolveTestChromium() {
  if (process.env.BOT_BROWSER_EXECUTABLE && existsSync(process.env.BOT_BROWSER_EXECUTABLE))
    return process.env.BOT_BROWSER_EXECUTABLE;
  try {
    const playwright = import.meta.resolve('playwright-core');
    const source = `import { chromium } from ${JSON.stringify(playwright)}; process.stdout.write(chromium.executablePath());`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout && existsSync(result.stdout)) return result.stdout;
  } catch { /* try cache below */ }
  const home = process.env.HOME || tmpdir();
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(home, '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const name of readdirSync(cache).sort().reverse()) {
      for (const candidate of [
        join(cache, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        join(cache, name, 'chrome-linux64', 'chrome')
      ]) if (existsSync(candidate)) return candidate;
    }
  }
  for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])
    if (existsSync(path)) return path;
  return null;
}

function seed(store) {
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
}

async function withSite(t) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/login') {
      res.writeHead(303, { Location: '/welcome', 'Set-Cookie': 'session=login-ok; Path=/' });
      res.end();
      return;
    }
    if (url.pathname === '/welcome') {
      const cookie = req.headers.cookie || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>欢迎</title></head><body><h1>欢迎</h1><p id="cookie">${cookie}</p><script>document.title = '欢迎 ' + document.cookie;</script></body></html>`);
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const timer = setInterval(() => { try { res.write('data: tick\n\n'); } catch { clearInterval(timer); } }, 400);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (url.pathname === '/stream-page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>stream</title></head><body><h1>stream</h1><script>new EventSource("/events")</script></body></html>');
      return;
    }
    if (url.pathname === '/webrtc-page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>webrtc</title></head><body><h1>webrtc</h1>
        <script>
          const report = {
            RTCPeerConnection: typeof RTCPeerConnection,
            webkitRTCPeerConnection: typeof webkitRTCPeerConnection,
            mozRTCPeerConnection: typeof mozRTCPeerConnection
          };
          try {
            if (typeof RTCPeerConnection === 'function') {
              const pc = new RTCPeerConnection();
              report.constructed = true;
              pc.createOffer().then(() => { report.offer = true; document.title = JSON.stringify(report); })
                .catch(err => { report.offerError = String(err); document.title = JSON.stringify(report); });
            } else {
              document.title = JSON.stringify(report);
            }
          } catch (err) {
            report.error = String(err);
            document.title = JSON.stringify(report);
          }
        </script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/hang') return; // never responds, for timeout
    const file = pages[url.pathname];
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(pagesRoot, file)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function withPairedSites(t) {
  let evilHits = 0, evilUpgrades = 0, allowedUpgrades = 0;
  const evil = createServer((_req, res) => {
    evilHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>evil</body></html>');
  });
  evil.on('upgrade', (_req, socket) => { evilUpgrades += 1; socket.destroy(); });
  evil.listen(0, '127.0.0.1');
  await once(evil, 'listening');
  const evilOrigin = `http://127.0.0.1:${evil.address().port}`;
  const allowed = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/go-out') {
      res.writeHead(302, { Location: `${evilOrigin}/landed` });
      res.end();
      return;
    }
    if (url.pathname === '/embeds') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>允许的页面</h1>
        <iframe src="${evilOrigin}/frame" id="ext-frame"></iframe>
        <img src="${evilOrigin}/pixel.png" alt="x">
        <p>embeds</p>
      </body></html>`);
      return;
    }
    if (url.pathname === '/token') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>token page</body></html>');
      return;
    }
    if (url.pathname === '/img-go-out') {
      res.writeHead(302, { Location: `${evilOrigin}/pixel-redirect.png` });
      res.end();
      return;
    }
    if (url.pathname === '/subresource-redirect') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>subresource redirect</h1><img src="/img-go-out" alt="x"></body></html>');
      return;
    }
    if (url.pathname === '/ws-page') {
      const evilWs = evilOrigin.replace(/^http/, 'ws') + '/socket';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>ws</h1><script>try { new WebSocket(' + JSON.stringify(evilWs) + '); } catch (e) {} try { new WebSocket("ws://" + location.host + "/same-origin"); } catch (e) {}</script></body></html>');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  allowed.on('upgrade', (_req, socket) => { allowedUpgrades += 1; socket.destroy(); });
  allowed.listen(0, '127.0.0.1');
  await once(allowed, 'listening');
  t.after(() => new Promise(resolve => {
    allowed.close(() => evil.close(resolve));
    allowed.closeAllConnections();
    evil.closeAllConnections();
  }));
  return { origin: `http://127.0.0.1:${allowed.address().port}`, evilOrigin, evilHits: () => evilHits, evilUpgrades: () => evilUpgrades, allowedUpgrades: () => allowedUpgrades };
}

async function fixture(t, taskId, origin, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bot-browser-runtime-'));
  const computer = mkdtempSync(join(tmpdir(), 'bot-browser-computer-'));
  const store = new Store(join(directory, 'control.sqlite'), randomBytes(32));
  seed(store);
  const manager = new LocalManager('101', computer);
  const environment = await manager.call('PUT', '/v1/projects/101');
  const workspaceId = randomBytes(24).toString('hex');
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)",
    taskId, '101', 'task.request', 'running', 'Browse the fixture',
    JSON.stringify({ request: 'Inspect the local fixture', browser: { origins: [origin], timeout_ms: 30_000, ...extra } }),
    1, environment.generation, workspaceId);
  const task = () => store.get('SELECT * FROM tasks WHERE id=?', taskId);
  const redactor = new Redactor(), guard = async () => {};
  const workspace = new Workspace(store, manager, task(), redactor, guard, () => {});
  await workspace.call('init', { type: 'workspace_init' });
  t.after(async () => {
    await closeBrowserOnComputer(workspace, task());
    await manager.recover();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(computer, { recursive: true, force: true });
  });
  return { store, manager, workspace, task, workspaceId, computer, directory };
}


function storedText(store, computer, workspaceId, taskId) {
  const chunks = [JSON.stringify(store.all('SELECT request, result FROM task_tools WHERE task_id=?', taskId))];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === 'profile') continue;
      if (entry.isDirectory()) walk(path);
      else if (/\.(json|log|txt)$/i.test(entry.name)) {
        try { chunks.push(readFileSync(path, 'utf8')); } catch { /* unreadable */ }
      }
    }
  };
  walk(computer);
  return chunks.join('\n');
}

function profileDir(computer, workspaceId) {
  return join(computer, 'tasks', workspaceId, 'browser', 'profile');
}

test('control plane refuses to start a browser when no project computer is attached', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-browser-nocomp-'));
  const store = new Store(join(directory, 'control.sqlite'), randomBytes(32));
  seed(store);
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,?,?,?,?,?)",
    'no-computer', '101', 'task.request', 'running', 'Browse',
    JSON.stringify({ request: 'Inspect', browser: { origins: ['http://127.0.0.1:9'], timeout_ms: 5000 } }));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const row = store.get("SELECT * FROM tasks WHERE id='no-computer'");
  const result = await runBrowserTool(store, row, { action: 'open', url: 'http://127.0.0.1:9/' });
  assert.equal(result.error, 'browser_computer_unavailable');
});

test('real Chromium on the project computer opens a local fixture, records a PNG, and enforces origin, destructive and secret boundaries', async (t) => {
  const executable = resolveTestChromium();
  if (!executable) assert.fail('未找到真实 Chromium。本测试必须经项目电脑路径启动真实浏览器，缺少运行时按失败处理，不得跳过。');
  process.env.BOT_BROWSER_EXECUTABLE = executable;
  const origin = await withSite(t);
  const f = await fixture(t, 'task-browser', origin);
  const row = () => f.task();
  const opened = await runBrowserTool(f.store, row(), { action: 'open', url: origin + '/' }, { workspace: f.workspace });
  assert.equal(opened.error, undefined, opened.detail || 'open should succeed');
  assert.ok(existsSync(profileDir(f.computer, f.workspaceId)), 'the session profile must live on the project computer');
  const seen = await runBrowserTool(f.store, row(), { action: 'screenshot' }, { workspace: f.workspace });
  assert.equal(seen.error, undefined, seen.detail || 'screenshot should succeed');
  assert.equal(seen.step.screenshot.file, 'step-2.png');
  const file = join(browserEvidenceDir(browserEvidenceRoot(f.store), row().id), seen.step.screenshot.file);
  assert.equal(existsSync(file), true);
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(bytes.length > 32);
  const off = await runBrowserTool(f.store, row(), { action: 'click', name: '外部站点' }, { workspace: f.workspace });
  assert.equal(off.error, 'browser_origin_forbidden');
  const destroy = await runBrowserTool(f.store, row(), { action: 'click', name: '删除账号' }, { workspace: f.workspace });
  assert.equal(destroy.error, 'browser_destructive_forbidden');
  const about = await runBrowserTool(f.store, row(), { action: 'click', name: '查看说明' }, { workspace: f.workspace });
  assert.equal(about.error, undefined, about.detail || 'ordinary click should succeed');
  const login = await runBrowserTool(f.store, row(), { action: 'open', url: origin + '/login' }, { workspace: f.workspace });
  assert.equal(login.error, undefined, login.detail || 'allowed redirect with Set-Cookie must succeed');
  assert.match(String(login.step.title || ''), /欢迎/);
  const streamed = await runBrowserTool(f.store, row(), { action: 'open', url: origin + '/stream-page' }, { workspace: f.workspace });
  assert.equal(streamed.error, undefined, streamed.detail || 'a page that opens EventSource must not hang the session');
  const typed = await runBrowserTool(f.store, row(), { action: 'open', url: origin + '/' }, { workspace: f.workspace });
  assert.equal(typed.error, undefined, typed.detail);
  const secret = 'fixture-password-value';
  const filled = await runBrowserTool(f.store, row(), { action: 'type', name: '口令', text: secret }, { workspace: f.workspace });
  assert.equal(filled.secret_field, true);
  assert.equal(existsSync(file), false, 'screenshots saved before a secret was typed must be removed');
  const withheld = await runBrowserTool(f.store, row(), { action: 'screenshot' }, { workspace: f.workspace });
  assert.equal(withheld.error, 'browser_screenshot_withheld');
  const history = f.store.all("SELECT data FROM task_history WHERE task_id=? AND type='execution_evidence'", row().id).map(entry => entry.data).join('\n');
  const steps = readFileSync(join(browserEvidenceDir(browserEvidenceRoot(f.store), row().id), 'steps.json'), 'utf8');
  assert.equal(history.includes(secret), false);
  assert.equal(steps.includes(secret), false);
  const profile = profileDir(f.computer, f.workspaceId);
  assert.equal(existsSync(profile), true);
  await runBrowserTool(f.store, row(), { action: 'close' }, { workspace: f.workspace });
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(file), false);
  const leftover = existsSync(profile) ? readdirSync(profile) : [];
  assert.deepEqual(leftover, []);
});

test('real Chromium blocks off-origin redirects, iframes and subresources, and redacts token query values', async (t) => {
  const executable = resolveTestChromium();
  if (!executable) assert.fail('未找到真实 Chromium。本测试必须经项目电脑路径启动真实浏览器，缺少运行时按失败处理，不得跳过。');
  process.env.BOT_BROWSER_EXECUTABLE = executable;
  const sites = await withPairedSites(t);
  const f = await fixture(t, 'task-browser-net', sites.origin);
  const row = () => f.task();
  const redirected = await runBrowserTool(f.store, row(), { action: 'open', url: sites.origin + '/go-out' }, { workspace: f.workspace });
  assert.equal(redirected.error, 'browser_origin_forbidden', redirected.detail || 'redirect must be refused');
  assert.equal(sites.evilHits(), 0, 'the off-origin redirect target must not be contacted');
  const embeds = await runBrowserTool(f.store, row(), { action: 'open', url: sites.origin + '/embeds' }, { workspace: f.workspace });
  assert.equal(embeds.error, undefined, embeds.detail || 'allowed page with blocked embeds should still open');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(sites.evilHits(), 0, 'iframe and image requests to another origin must not reach that host');
  const token = 'super-secret-access-token';
  const opened = await runBrowserTool(f.store, row(), { action: 'open', url: `${sites.origin}/token?access_token=${token}` }, { workspace: f.workspace });
  assert.equal(opened.error, undefined, opened.detail);
  assert.equal(String(opened.step.url).includes(token), false);
  const steps = readFileSync(join(browserEvidenceDir(browserEvidenceRoot(f.store), row().id), 'steps.json'), 'utf8');
  assert.equal(steps.includes(token), false);
  const history = f.store.all("SELECT data FROM task_history WHERE task_id=? AND type='execution_evidence'", row().id).map(entry => entry.data).join('\n');
  assert.equal(history.includes(token), false);
  await runBrowserTool(f.store, row(), { action: 'close' }, { workspace: f.workspace });
});

test('timeout and workspace reap clean the project-computer profile and leave written evidence', async (t) => {
  const executable = resolveTestChromium();
  if (!executable) assert.fail('未找到真实 Chromium。本测试必须经项目电脑路径启动真实浏览器，缺少运行时按失败处理，不得跳过。');
  process.env.BOT_BROWSER_EXECUTABLE = executable;
  const origin = await withSite(t);
  const f = await fixture(t, 'task-browser-timeout', origin, { timeout_ms: 3000 });
  const row = () => f.task();
  const hung = await runBrowserTool(f.store, row(), { action: 'open', url: origin + '/hang' }, { workspace: f.workspace });
  assert.equal(hung.error, 'browser_timeout', hung.detail || 'a hung navigation must be mapped to browser_timeout');
  assert.equal(existsSync(profileDir(f.computer, f.workspaceId)), false, 'a timeout must close the session and remove the profile');
  const opened = await runBrowserTool(f.store, row(), { action: 'open', url: origin + '/' }, { workspace: f.workspace });
  assert.equal(opened.error, undefined, opened.detail);
  const shot = await runBrowserTool(f.store, row(), { action: 'screenshot' }, { workspace: f.workspace });
  assert.equal(shot.error, undefined, shot.detail);
  const file = join(browserEvidenceDir(browserEvidenceRoot(f.store), row().id), shot.step.screenshot.file);
  assert.equal(existsSync(file), true);
  const profile = profileDir(f.computer, f.workspaceId);
  assert.equal(existsSync(profile), true);
  const reaped = await f.manager.call('POST', '/v1/projects/101/execute', {
    generation: row().generation, operation_id: randomBytes(24).toString('hex'),
    request: { type: 'reap', workspace_id: f.workspaceId }
  });
  assert.equal(reaped.ok, true);
  assert.equal(existsSync(profile), false, 'reap must remove the browser profile');
  assert.equal(existsSync(file), true, 'already written evidence stays after cleanup');
});

test('a project computer without Chromium fails honestly and does not start a control-plane browser', async (t) => {
  const origin = await withSite(t);
  const previousExec = process.env.BOT_BROWSER_EXECUTABLE;
  const previousCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const empty = mkdtempSync(join(tmpdir(), 'bot-no-browsers-'));
  process.env.BOT_BROWSER_EXECUTABLE = join(empty, 'missing-chromium');
  process.env.PLAYWRIGHT_BROWSERS_PATH = empty;
  t.after(() => {
    if (previousExec === undefined) delete process.env.BOT_BROWSER_EXECUTABLE; else process.env.BOT_BROWSER_EXECUTABLE = previousExec;
    if (previousCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = previousCache;
    rmSync(empty, { recursive: true, force: true });
  });
  const f = await fixture(t, 'task-browser-missing', origin);
  const result = await runBrowserTool(f.store, f.task(), { action: 'open', url: origin + '/' }, { workspace: f.workspace });
  assert.equal(result.error, 'browser_runtime_unavailable', result.detail || 'missing Chromium must fail honestly');
});


test('real Chromium blocks a same-origin subresource 302 that leaves the allowlist and disables WebSocket', async (t) => {
  const executable = resolveTestChromium();
  if (!executable) assert.fail('未找到真实 Chromium。本测试必须经项目电脑路径启动真实浏览器，缺少运行时按失败处理，不得跳过。');
  process.env.BOT_BROWSER_EXECUTABLE = executable;
  const sites = await withPairedSites(t);
  const f = await fixture(t, 'task-browser-redirect-sub', sites.origin);
  const row = () => f.task();
  const page = await runBrowserTool(f.store, row(), { action: 'open', url: sites.origin + '/subresource-redirect' }, { workspace: f.workspace });
  assert.equal(page.error, undefined, page.detail || 'the allowed page should open');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(sites.evilHits(), 0, 'a same-origin image that 302s off-origin must not contact that host');
  const ws = await runBrowserTool(f.store, row(), { action: 'open', url: sites.origin + '/ws-page' }, { workspace: f.workspace });
  assert.equal(ws.error, undefined, ws.detail || 'the websocket test page should still open');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(sites.evilUpgrades(), 0, 'an off-origin WebSocket upgrade must not reach that host');
  assert.equal(sites.allowedUpgrades(), 0, 'same-origin WebSocket is disabled rather than forwarded');
  await runBrowserTool(f.store, row(), { action: 'close' }, { workspace: f.workspace });
});


test('real Chromium removes WebRTC constructors so a page cannot create a peer connection', async (t) => {
  const executable = resolveTestChromium();
  if (!executable) assert.fail('未找到真实 Chromium。本测试必须经项目电脑路径启动真实浏览器，缺少运行时按失败处理，不得跳过。');
  process.env.BOT_BROWSER_EXECUTABLE = executable;
  const origin = await withSite(t);
  const f = await fixture(t, 'task-browser-webrtc', origin);
  const opened = await runBrowserTool(f.store, f.task(), { action: 'open', url: origin + '/webrtc-page' }, { workspace: f.workspace });
  assert.equal(opened.error, undefined, opened.detail || 'open should succeed');
  const report = JSON.parse(String(opened.step?.title || ''));
  assert.equal(report.RTCPeerConnection, 'undefined');
  assert.equal(report.webkitRTCPeerConnection, 'undefined');
  assert.equal(report.constructed, undefined);
  assert.equal(report.offer, undefined);
  await runBrowserTool(f.store, f.task(), { action: 'close' }, { workspace: f.workspace });
});

test('typed secrets and screenshot bytes are absent from persisted workspace operation records', async (t) => {
  const executable = resolveTestChromium();
  if (!executable) assert.fail('未找到真实 Chromium。本测试必须经项目电脑路径启动真实浏览器，缺少运行时按失败处理，不得跳过。');
  process.env.BOT_BROWSER_EXECUTABLE = executable;
  const origin = await withSite(t);
  const f = await fixture(t, 'task-browser-logs', origin);
  const row = () => f.task();
  const opened = await runBrowserTool(f.store, row(), { action: 'open', url: origin + '/' }, { workspace: f.workspace });
  assert.equal(opened.error, undefined, opened.detail);
  const shot = await runBrowserTool(f.store, row(), { action: 'screenshot' }, { workspace: f.workspace });
  assert.equal(shot.error, undefined, shot.detail);
  const afterShot = storedText(f.store, f.computer, f.workspaceId, row().id);
  assert.equal(afterShot.includes('iVBORw0KGgo'), false, 'raw screenshot base64 must not be persisted in operation logs');
  const toolsAfterShot = JSON.stringify(f.store.all('SELECT request, result FROM task_tools WHERE task_id=?', row().id));
  assert.equal(toolsAfterShot.includes('iVBORw0KGgo'), false);
  assert.match(toolsAfterShot, /\[omitted\]|screenshot/, 'the stored result should keep screenshot metadata without pixels');
  const secret = 'fixture-password-value';
  const filled = await runBrowserTool(f.store, row(), { action: 'type', name: '口令', text: secret }, { workspace: f.workspace });
  assert.equal(filled.secret_field, true);
  const afterType = storedText(f.store, f.computer, f.workspaceId, row().id);
  assert.equal(afterType.includes(secret), false, 'typed password must not remain in workspace operation logs');
  const toolsAfterType = JSON.stringify(f.store.all('SELECT request, result FROM task_tools WHERE task_id=?', row().id));
  assert.equal(toolsAfterType.includes(secret), false);
  await runBrowserTool(f.store, row(), { action: 'close' }, { workspace: f.workspace });
});

test('close is not sent when this workspace never opened a browser', async (t) => {
  const origin = await withSite(t);
  const f = await fixture(t, 'task-browser-no-open', origin);
  const calls = [];
  const original = f.workspace.deliverCleanup.bind(f.workspace);
  f.workspace.deliverCleanup = async (request) => { calls.push(request); return original(request); };
  await closeBrowserOnComputer(f.workspace, f.task());
  assert.deepEqual(calls, []);
});

test('control-plane browser modules do not import playwright-core', () => {
  for (const rel of ['src/browser/tools.ts', 'src/browser/runtime.ts', 'src/browser/policy.ts', 'src/browser/evidence.ts',
    'dist/browser/tools.js', 'dist/browser/runtime.js', 'dist/browser/policy.js', 'dist/browser/evidence.js']) {
    if (!existsSync(rel)) continue;
    const source = readFileSync(rel, 'utf8');
    assert.equal(/playwright-core|from 'playwright'|from "playwright"/.test(source), false, rel);
  }
});

test('manager image copies browser-policy and import-checks manager modules', () => {
  const dockerfile = readFileSync(new URL('../manager/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /runner\/browser-policy\.mjs/);
  assert.match(dockerfile, /import\('\.?\/manager\/projects\.mjs'\)/);
  assert.match(dockerfile, /import\('\.?\/manager\/run-environments\.mjs'\)/);
  assert.equal(dockerfile.includes("import('./manager/main.mjs')"), false);
});
