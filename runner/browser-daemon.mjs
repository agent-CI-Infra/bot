#!/usr/bin/env node
/**
 * Long-lived task browser on the project computer. Each workspace_browser runner
 * request is a short process; this daemon holds the Chromium session.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { allowedOrigin, boundedTimeoutMs, destructiveAllowed, networkRequestAllowed, originOf, redactBrowserValue, redactRecordedUrl, normalizePolicy, tighterDestructive } from './browser-policy.mjs';
import { homeDirectory, tasksDirectory } from './paths.mjs';

const workspaceId = process.argv[2] || '';
if (!/^[a-f0-9]{48}$/.test(workspaceId)) {
  console.error('invalid_workspace');
  process.exit(1);
}

const sessionRoot = join(tasksDirectory, workspaceId, 'browser');
const profileDir = join(sessionRoot, 'profile');
const evidenceDir = join(sessionRoot, 'evidence');
const sockPath = join(sessionRoot, 'session.sock');
const pidPath = join(sessionRoot, 'daemon.pid');

function resolveChromium() {
  const fromEnv = process.env.BOT_BROWSER_EXECUTABLE?.trim();
  if (fromEnv) {
    if (existsSync(fromEnv)) return { executablePath: fromEnv, kind: 'env' };
    const error = Object.assign(new Error('browser_runtime_unavailable'), {
      code: 'browser_runtime_unavailable',
      detail: 'BOT_BROWSER_EXECUTABLE 指向的可执行文件不存在，不会改用其他浏览器，也不会在控制面启动。'
    });
    throw error;
  }
  const candidates = [];
  try { candidates.push({ path: chromium.executablePath(), kind: 'playwright' }); } catch { /* bundled path may be absent */ }
  const home = process.env.HOME || homeDirectory || tmpdir();
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(home, '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const name of readdirSync(cache).sort().reverse()) {
      const shell = join(cache, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      const chrome = join(cache, name, 'chrome-linux64', 'chrome');
      if (existsSync(shell)) candidates.push({ path: shell, kind: 'playwright-shell' });
      if (existsSync(chrome)) candidates.push({ path: chrome, kind: 'playwright-chrome' });
    }
  }
  for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])
    if (existsSync(path)) candidates.push({ path, kind: 'system' });
  const hit = candidates.find(item => existsSync(item.path));
  if (!hit) {
    const error = Object.assign(new Error('browser_runtime_unavailable'), {
      code: 'browser_runtime_unavailable',
      detail: '项目电脑上未找到真实 Chromium。生产镜像由 #916 预装；找不到时不会在控制面启动浏览器，也不会用假页面代替。'
    });
    throw error;
  }
  return { executablePath: hit.path, kind: hit.kind };
}

mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
mkdirSync(profileDir, { recursive: true, mode: 0o700 });
try { unlinkSync(sockPath); } catch { /* first start */ }

let context, page, policy = null, steps = [], secretTyped = false, closed = false;
const blocked = { url: null };

function isBlockedNavigation(error) {
  return /blockedbyclient|ERR_BLOCKED_BY_CLIENT|NS_ERROR_ABORT|net::ERR_ABORTED/i.test(String(error?.message || error));
}

function withholdSavedScreenshots() {
  for (const step of steps) {
    if (!step.screenshot) continue;
    try { rmSync(join(evidenceDir, step.screenshot.file), { force: true }); } catch { /* already gone */ }
    delete step.screenshot;
  }
  writeFileSync(join(evidenceDir, 'steps.json'), JSON.stringify({ workspace_id: workspaceId, steps }, null, 2), { mode: 0o600 });
}

async function installRoutes(browserContext, nextPolicy) {
  await browserContext.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    const check = networkRequestAllowed(nextPolicy, url);
    if (!check.ok) {
      blocked.url = url;
      return route.abort('blockedbyclient');
    }
    const type = request.resourceType();
    // Document and navigations: hop-by-hop so a 302 cannot leave the allowlist.
    // EventSource/SSE uses continue() so the body is not buffered in this process. Residual:
    // an already-allowed EventSource URL that later 302s off-origin may still send one request.
    // WebSocket is aborted below (route does not cover it); WebRTC constructors are removed in boot().
    if (type === 'eventsource' || type === 'websocket') {
      if (type === 'websocket') return route.abort('blockedbyclient');
      return route.continue();
    }
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      const status = response.status();
      if (status >= 300 && status < 400) {
        const location = response.headers().location;
        if (location) {
          let next;
          try { next = new URL(location, url).toString(); }
          catch {
            blocked.url = location;
            return route.abort('blockedbyclient');
          }
          const nextCheck = networkRequestAllowed(nextPolicy, next);
          if (!nextCheck.ok) {
            blocked.url = next;
            return route.abort('blockedbyclient');
          }
        }
      }
      return route.fulfill({ response });
    } catch {
      return route.abort('failed');
    }
  });
}

async function boot(nextPolicy) {
  if (context) return;
  const resolved = resolveChromium();
  const timeout = boundedTimeoutMs(nextPolicy.timeout_ms);
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: resolved.executablePath,
    headless: true,
    viewport: { width: 1280, height: 720 },
    acceptDownloads: false,
    serviceWorkers: 'block',
    timeout,
    args: ['--disable-dev-shm-usage', '--disable-gpu', ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [])]
  });
  context.setDefaultTimeout(timeout);
  context.setDefaultNavigationTimeout(timeout);
  // Chromium has no --disable-webrtc switch; hide constructors before any page script runs.
  await context.addInitScript(() => {
    const hide = (object, name) => {
      try {
        Object.defineProperty(object, name, { configurable: true, enumerable: false, writable: true, value: undefined });
        delete object[name];
      } catch { /* non-configurable in this environment */ }
    };
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel']) {
      hide(globalThis, name);
      hide(window, name);
    }
  });
  await installRoutes(context, nextPolicy);
  const guardPage = p => {
    p.on('websocket', ws => { try { if (typeof ws.close === 'function') ws.close(); } catch { /* already closed */ } });
  };
  context.on('page', guardPage);
  try {
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket(/./, ws => { try { ws.close(); } catch { /* gone */ } });
  } catch { /* Playwright build without routeWebSocket */ }
  for (const p of context.pages()) guardPage(p);
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
}

function describeTarget(args) {
  for (const key of ['name', 'text', 'selector', 'label']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function locator(target) {
  if (target.startsWith('#') || target.startsWith('.') || target.includes('['))
    return page.locator(target).first();
  return page.getByRole('textbox', { name: target })
    .or(page.getByRole('button', { name: target }))
    .or(page.getByRole('link', { name: target }))
    .or(page.getByLabel(target, { exact: true }))
    .or(page.getByText(target, { exact: true })).first();
}

async function control(loc) {
  const inner = loc.locator('input, textarea, select, button, a, [contenteditable="true"]');
  if (await inner.count()) return inner.first();
  return loc;
}

async function record(action, result, skipScreenshot = false, forceScreenshot = false) {
  const n = steps.length + 1;
  const id = `step-${n}`;
  let url = null, title = null;
  try { url = page?.isClosed() ? null : page.url(); } catch { url = null; }
  try { title = page?.isClosed() ? null : await page.title(); } catch { title = null; }
  const step = {
    id, n, at: new Date().toISOString(), action,
    url: url && (url === 'about:blank' || originOf(url)) ? redactRecordedUrl(url) : null,
    title,
    result: String(result.detail || result.error || (result.ok ? 'ok' : 'done')),
    ...(typeof result.error === 'string' ? { error: result.error } : {})
  };
  let screenshot = null;
  if (!skipScreenshot && (forceScreenshot || !result.error) && page && !page.isClosed() && !secretTyped) {
    const file = `step-${n}.png`;
    const path = join(evidenceDir, file);
    const buf = await page.screenshot({ type: 'png', fullPage: true });
    writeFileSync(path, buf, { mode: 0o600 });
    const sha256 = createHash('sha256').update(buf).digest('hex');
    step.screenshot = { file, sha256, bytes: buf.length };
    screenshot = { file, sha256, bytes: buf.length, base64: buf.toString('base64') };
  }
  steps.push(step);
  writeFileSync(join(evidenceDir, 'steps.json'), JSON.stringify({ workspace_id: workspaceId, steps }, null, 2), { mode: 0o600 });
  return redactBrowserValue({ ...result, step, ...(screenshot ? { screenshot } : {}) });
}

async function perform(action, args) {
  const allow = value => allowedOrigin(policy, value);
  if (action === 'open') {
    const check = allow(String(args.url ?? ''));
    if (!check.ok) return record(action, check);
    blocked.url = null;
    try {
      await page.goto(check.url.toString(), { waitUntil: 'domcontentloaded' });
    } catch (error) {
      await page.goto('about:blank').catch(() => {});
      if (blocked.url || isBlockedNavigation(error))
        return record(action, { error: 'browser_origin_forbidden', detail: '页面跳转到了未允许的站点，请求已被拦截。' });
      throw error;
    }
    const final = allow(page.url());
    if (!final.ok) {
      await page.goto('about:blank').catch(() => {});
      return record(action, { ...final, detail: '页面跳转到了未允许的站点，已中止。' });
    }
    return record(action, { ok: true });
  }
  if (action === 'see' || action === 'screenshot') {
    if (secretTyped)
      return record(action, { error: 'browser_screenshot_withheld', detail: '本轮已输入口令或密钥，这帧截图不会保存，以免把密钥留在证据里。' }, true);
    return record(action, { ok: true }, false, true);
  }
  if (action === 'click') {
    const target = describeTarget(args);
    if (!target) return record(action, { error: 'browser_invalid_arguments', detail: '点击需要名称、文本或选择器。' }, true);
    const loc = await control(locator(target));
    const label = (await loc.innerText().catch(() => '')) || target;
    const href = await loc.getAttribute('href').catch(() => null);
    const path = href ? new URL(href, page.url()).pathname : new URL(page.url()).pathname;
    const grant = destructiveAllowed(policy, path, `${label} ${target}`);
    if (!grant.ok) return record(action, grant, true);
    if (href) {
      const check = allow(new URL(href, page.url()).toString());
      if (!check.ok) return record(action, check, true);
    }
    blocked.url = null;
    try {
      await loc.click();
    } catch (error) {
      if (blocked.url || isBlockedNavigation(error)) {
        await page.goto('about:blank').catch(() => {});
        return record(action, { error: 'browser_origin_forbidden', detail: '点击后跳转到了未允许的站点，请求已被拦截。' });
      }
      throw error;
    }
    const final = allow(page.url());
    if (!final.ok) {
      await page.goto('about:blank').catch(() => {});
      return record(action, { ...final, detail: '点击后跳转到了未允许的站点，已中止。' });
    }
    return record(action, { ok: true });
  }
  if (action === 'type') {
    const target = describeTarget(args);
    const text = args.text;
    if (!target || typeof text !== 'string') return record(action, { error: 'browser_invalid_arguments', detail: '输入需要目标字段和文本。' }, true);
    const loc = await control(locator(target));
    const type = (await loc.getAttribute('type').catch(() => null) || '').toLowerCase();
    const named = `${await loc.getAttribute('name').catch(() => '')} ${await loc.getAttribute('autocomplete').catch(() => '')} ${await loc.getAttribute('aria-label').catch(() => '')}`;
    const secret = type === 'password' || /password|token|secret|authorization/i.test(named);
    if (secret) {
      secretTyped = true;
      withholdSavedScreenshots();
    }
    await loc.fill(text);
    return record(action, { ok: true, secret_field: secret }, secret);
  }
  return record(action, { error: 'browser_action_unsupported', detail: '不支持这个浏览器动作。' }, true);
}

async function shutdown() {
  if (closed) return;
  closed = true;
  try { await page?.close(); } catch { /* already gone */ }
  try { await context?.close(); } catch { /* already gone */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { unlinkSync(sockPath); } catch { /* already gone */ }
  try { unlinkSync(pidPath); } catch { /* already gone */ }
}

async function handle(message) {
  const action = String(message.action || '');
  if (action === 'close') {
    const summary = { ok: true, steps: steps.length, withheld: secretTyped };
    await shutdown();
    return { ...summary, _exit: true };
  }
  const next = normalizePolicy(message.policy);
  if (!next) return { error: 'browser_not_configured', detail: '这个任务没有列出允许打开的站点，不能启动浏览器。' };
  if (policy && (next.origins.slice().sort().join(' ') !== policy.origins.slice().sort().join(' ')))
    return { error: 'browser_policy_changed', detail: '本会话的允许源不能在中途扩大或更换。' };
  if (policy) {
    // Origins cannot change. allow_destructive and timeout may only shrink, so a revocation is honored.
    policy = {
      origins: policy.origins,
      allow_destructive: tighterDestructive(policy.allow_destructive, next.allow_destructive),
      timeout_ms: boundedTimeoutMs(Math.min(policy.timeout_ms, next.timeout_ms))
    };
  } else policy = next;
  try {
    await boot(policy);
  } catch (error) {
    const mapped = error.code || (/executable|Failed to launch|browser_runtime_unavailable/i.test(String(error)) ? 'browser_runtime_unavailable' : 'browser_failed');
    return { error: mapped, detail: error.detail || (mapped === 'browser_runtime_unavailable' ? '项目电脑上未能启动真实浏览器。' : '浏览器没有启动完成。') };
  }
  let timedOut = false;
  const timeoutMs = boundedTimeoutMs(policy.timeout_ms);
  const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
  try {
    const outcome = await Promise.race([
      perform(action, message.args || {}),
      new Promise(resolve => setTimeout(() => resolve({ error: 'browser_timeout', detail: '这个浏览器动作超过了本任务允许的时间，会话已关闭。' }), timeoutMs))
    ]);
    if (outcome?.error === 'browser_timeout' || timedOut) {
      await shutdown();
      return { ...(outcome || { error: 'browser_timeout' }), _exit: true };
    }
    return outcome;
  } catch (error) {
    if (/has been closed|Target closed|browser has been closed|crashed/i.test(String(error)))
      return { error: 'browser_crashed', detail: '项目电脑上的浏览器已关闭或崩溃。' };
    if (isBlockedNavigation(error))
      return { error: 'browser_origin_forbidden', detail: '请求被拦截：地址不在本任务允许访问的站点范围内。' };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}


writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
const server = createServer(socket => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    const nl = buffer.indexOf('\n');
    if (nl < 0) return;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let message;
    try { message = JSON.parse(line); } catch {
      socket.end(JSON.stringify({ error: 'browser_invalid_arguments', detail: '浏览器请求无法解析。' }) + '\n');
      return;
    }
    handle(message).then(result => {
      const exit = result?._exit === true || result?.error === 'browser_crashed';
      if (result && typeof result === 'object') delete result._exit;
      socket.end(JSON.stringify(result) + '\n');
      if (exit) socket.once('close', () => process.exit(0));
    }).catch(async error => {
      try { socket.end(JSON.stringify({ error: 'browser_failed', detail: '浏览器动作没有完成。' }) + '\n'); } catch { /* gone */ }
      console.error(error);
    });
  });
});
server.listen(sockPath, () => {
  try { writeFileSync(join(sessionRoot, 'ready'), 'ok', { mode: 0o600 }); } catch { /* best-effort */ }
});
server.on('error', error => {
  console.error(error);
  process.exit(1);
});
process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
process.on('exit', () => { try { unlinkSync(sockPath); } catch { /* gone */ } });
