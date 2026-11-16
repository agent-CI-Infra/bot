import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { allowedOrigin, destructiveAllowed, originOf, redactBrowserValue, type BrowserPolicy } from './policy.js';

export type BrowserStep = {
  id: string;
  n: number;
  at: string;
  action: string;
  url: string | null;
  title: string | null;
  result: string;
  error?: string;
  screenshot?: { file: string; sha256: string; bytes: number };
};

type LiveSession = BrowserSession & {
  evidenceDir: string;
  page: Page;
  browser: Browser;
  context: BrowserContext;
};

export type BrowserSession = {
  taskId: string;
  policy: BrowserPolicy;
  steps: BrowserStep[];
  secretTyped: boolean;
  profileDir: string;
  close: () => Promise<void>;
  run: (action: string, args: Record<string, unknown>, guard?: () => Promise<void> | void) => Promise<Record<string, unknown>>;
};

const sessions = new Map<string, LiveSession>();

/** Resolve a real Chromium (or headless shell). Never falls back to a mock page or fake browser. */
export function resolveChromium(): { executablePath: string; kind: string } {
  const fromEnv = process.env.BOT_BROWSER_EXECUTABLE?.trim();
  if (fromEnv && existsSync(fromEnv)) return { executablePath: fromEnv, kind: 'env' };
  const candidates: { path: string; kind: string }[] = [];
  try { candidates.push({ path: chromium.executablePath(), kind: 'playwright' }); } catch { /* bundled path may be absent */ }
  const home = process.env.HOME || tmpdir();
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
      detail: '未找到真实 Chromium。控制面或 CI 使用 Playwright 已安装的浏览器；生产项目电脑镜像由 #916 预装，不在文档里要求自行 apt。'
    });
    throw error;
  }
  return { executablePath: hit.path, kind: hit.kind };
}

export function browserEvidenceDir(root: string, taskId: string): string {
  return join(root, taskId.replace(/[^A-Za-z0-9._-]/g, '_'));
}

export async function openBrowserSession(taskId: string, policy: BrowserPolicy, root: string): Promise<BrowserSession> {
  const existing = sessions.get(taskId);
  if (existing) return existing;
  const resolved = resolveChromium();
  const profileDir = mkdtempSync(join(tmpdir(), 'bot-browser-'));
  const evidenceDir = browserEvidenceDir(root, taskId);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    sessions.delete(taskId);
    try { await page?.close(); } catch { /* already gone */ }
    try { await context?.close(); } catch { /* already gone */ }
    try { await browser?.close(); } catch { /* already gone */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort profile cleanup */ }
  };
  try {
    browser = await chromium.launch({
      executablePath: resolved.executablePath,
      headless: true,
      args: ['--disable-dev-shm-usage', '--disable-gpu', ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [])],
      timeout: policy.timeout_ms
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: false,
      serviceWorkers: 'block'
    });
    page = await context.newPage();
    page.setDefaultTimeout(policy.timeout_ms);
    page.setDefaultNavigationTimeout(policy.timeout_ms);
  } catch (error) {
    await close();
    throw error;
  }

  const session = {
    taskId, policy, steps: [] as BrowserStep[], secretTyped: false, profileDir, evidenceDir,
    page, browser, context, close,
    run: async (action: string, args: Record<string, unknown>, guard?: () => Promise<void> | void) => {
      const live = sessions.get(taskId);
      if (closed || !live) return { error: 'browser_session_closed', detail: '浏览器已关闭。' };
      if (guard) {
        try { await guard(); }
        catch (error) { await close(); throw error; }
      }
      const timer = setTimeout(() => { void close(); }, policy.timeout_ms + 1_000);
      try {
        return await perform(live, action, args);
      } finally {
        clearTimeout(timer);
      }
    }
  } satisfies LiveSession;
  sessions.set(taskId, session);
  return session;
}

export function existingBrowserSession(taskId: string): BrowserSession | undefined {
  return sessions.get(taskId);
}

export async function closeBrowserSession(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (session) await session.close();
}

async function perform(session: LiveSession, action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const page = session.page;
  const allow = (value: string) => allowedOrigin(session.policy, value);
  if (action === 'open') {
    const check = allow(String(args.url ?? ''));
    if (!check.ok) return record(session, action, check);
    await page.goto(check.url.toString(), { waitUntil: 'domcontentloaded' });
    const final = allow(page.url());
    if (!final.ok) {
      await page.goto('about:blank').catch(() => {});
      return record(session, action, { ...final, detail: '页面跳转到了未允许的站点，已中止。' });
    }
    return record(session, action, { ok: true });
  }
  if (action === 'see' || action === 'screenshot') {
    if (session.secretTyped)
      return record(session, action, { error: 'browser_screenshot_withheld', detail: '本轮已输入口令或密钥，这帧截图不会保存，以免把密钥留在证据里。' }, true);
    return record(session, action, { ok: true }, false, true);
  }
  if (action === 'click') {
    const target = describeTarget(args);
    if (!target) return record(session, action, { error: 'browser_invalid_arguments', detail: '点击需要名称、文本或选择器。' }, true);
    const loc = await control(locator(page, target));
    const label = (await loc.innerText().catch(() => '')) || target;
    const href = await loc.getAttribute('href').catch(() => null);
    const path = href ? new URL(href, page.url()).pathname : new URL(page.url()).pathname;
    const grant = destructiveAllowed(session.policy, path, `${label} ${target}`);
    if (!grant.ok) return record(session, action, grant, true);
    if (href) {
      const check = allow(new URL(href, page.url()).toString());
      if (!check.ok) return record(session, action, check, true);
    }
    await loc.click();
    const final = allow(page.url());
    if (!final.ok) {
      await page.goto('about:blank').catch(() => {});
      return record(session, action, { ...final, detail: '点击后跳转到了未允许的站点，已中止。' });
    }
    return record(session, action, { ok: true });
  }
  if (action === 'type') {
    const target = describeTarget(args);
    const text = args.text;
    if (!target || typeof text !== 'string') return record(session, action, { error: 'browser_invalid_arguments', detail: '输入需要目标字段和文本。' }, true);
    const loc = await control(locator(page, target));
    const type = (await loc.getAttribute('type').catch(() => null) || '').toLowerCase();
    const named = `${await loc.getAttribute('name').catch(() => '')} ${await loc.getAttribute('autocomplete').catch(() => '')} ${await loc.getAttribute('aria-label').catch(() => '')}`;
    const secret = type === 'password' || /password|token|secret|authorization/i.test(named);
    if (secret) session.secretTyped = true;
    await loc.fill(text);
    return record(session, action, { ok: true, secret_field: secret }, secret);
  }
  if (action === 'close') {
    const summary = { ok: true, steps: session.steps.length };
    await session.close();
    return summary;
  }
  return record(session, action, { error: 'browser_action_unsupported', detail: '不支持这个浏览器动作。' }, true);
}

function describeTarget(args: Record<string, unknown>): string | null {
  for (const key of ['name', 'text', 'selector', 'label']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function locator(page: Page, target: string) {
  if (target.startsWith('#') || target.startsWith('.') || target.includes('['))
    return page.locator(target).first();
  // Prefer a form control or named widget over a wrapping label (label text also matches getByText).
  return page.getByRole('textbox', { name: target })
    .or(page.getByRole('button', { name: target }))
    .or(page.getByRole('link', { name: target }))
    .or(page.getByLabel(target, { exact: true }))
    .or(page.getByText(target, { exact: true })).first();
}

async function control(loc: ReturnType<Page['locator']>) {
  const inner = loc.locator('input, textarea, select, button, a, [contenteditable="true"]');
  if (await inner.count()) return inner.first();
  return loc;
}

async function record(session: LiveSession, action: string, result: Record<string, unknown>, skipScreenshot = false, forceScreenshot = false): Promise<Record<string, unknown>> {
  const n = session.steps.length + 1;
  const id = `step-${n}`;
  let url: string | null = null, title: string | null = null;
  try { url = session.page.isClosed() ? null : session.page.url(); } catch { url = null; }
  try { title = session.page.isClosed() ? null : await session.page.title(); } catch { title = null; }
  const step: BrowserStep = {
    id, n, at: new Date().toISOString(), action,
    url: url && (url === 'about:blank' || originOf(url)) ? url : null,
    title,
    result: String(result.detail || result.error || (result.ok ? 'ok' : 'done')),
    ...(typeof result.error === 'string' ? { error: result.error } : {})
  };
  if (!skipScreenshot && (forceScreenshot || !result.error) && !session.page.isClosed() && !session.secretTyped) {
    const file = `step-${n}.png`;
    const path = join(session.evidenceDir, file);
    const buf = await session.page.screenshot({ type: 'png', fullPage: true });
    writeFileSync(path, buf, { mode: 0o600 });
    step.screenshot = { file, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  }
  session.steps.push(step);
  writeFileSync(join(session.evidenceDir, 'steps.json'), JSON.stringify({ task_id: session.taskId, steps: session.steps }, null, 2), { mode: 0o600 });
  return redactBrowserValue({ ...result, step }) as Record<string, unknown>;
}
