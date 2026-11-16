import type { Row } from '../storage/database.js';

/** Task-level browser authority: only these origins, and destructive actions stay off unless listed. */
export type BrowserPolicy = {
  origins: string[];
  allow_destructive: boolean | string[];
  timeout_ms: number;
};

const defaultTimeoutMs = 60_000;
const maxTimeoutMs = 180_000;

/**
 * Heuristic labels or paths that need an explicit grant on the task.
 * This is not a complete detector: a generic “确认” or a custom widget can
 * still change data or pay without matching these patterns.
 */
export const destructivePattern = /delete account|destroy|uninstall|revoke access|terminate|pay now|place order|checkout|purchase|buy now|confirm payment|wire transfer|删除账号|注销|付款|结算下单|确认支付|转账/i;

const secretQuery = /^(?:token|secret|password|passwd|pwd|authorization|access_token|id_token|refresh_token|api[_-]?key)$/i;

export function browserPolicyOf(task: Row): BrowserPolicy | null {
  let input: any;
  try { input = JSON.parse(String(task.input || '{}')); } catch { return null; }
  const raw = input?.browser;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.origins)) return null;
  const origins = [...new Set(raw.origins.map((value: unknown) => originOf(String(value ?? '')))).values()].filter((value): value is string => !!value);
  if (!origins.length) return null;
  const timeout = Number(raw.timeout_ms);
  return {
    origins,
    allow_destructive: raw.allow_destructive === true ? true
      : Array.isArray(raw.allow_destructive) ? raw.allow_destructive.map((value: unknown) => String(value)).filter(Boolean)
      : false,
    timeout_ms: Number.isFinite(timeout) ? Math.min(maxTimeoutMs, Math.max(1_000, Math.floor(timeout))) : defaultTimeoutMs
  };
}

/** Exact origin (scheme + host + port) of an http(s) URL; null when the URL is not one the browser may request. */
export function originOf(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '[::]') return null;
  return url.origin;
}

/** Local documents and in-page data that are not a network request to another origin. */
export function isBrowserPassthroughUrl(value: string): boolean {
  if (value === 'about:blank' || value.startsWith('about:')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'data:' || url.protocol === 'blob:';
  } catch {
    return false;
  }
}

export function allowedOrigin(policy: BrowserPolicy, value: string): { ok: true; url: URL } | { ok: false; error: string; detail: string } {
  const origin = originOf(value);
  if (!origin) return { ok: false, error: 'browser_url_refused', detail: '只允许没有账号口令的 http 或 https 地址，且必须事先列入本任务允许的站点。' };
  const url = new URL(value);
  if (!policy.origins.includes(origin))
    return { ok: false, error: 'browser_origin_forbidden', detail: '这个地址不在本任务允许访问的站点范围内。' };
  return { ok: true, url };
}

/** Same origin rule as navigation, applied to every request the browser would make, including redirects, iframes and subresources. */
export function networkRequestAllowed(policy: BrowserPolicy, value: string): { ok: true } | { ok: false; error: string; detail: string } {
  if (isBrowserPassthroughUrl(value)) return { ok: true };
  const check = allowedOrigin(policy, value);
  if (check.ok) return { ok: true };
  return check;
}

export function destructiveAllowed(policy: BrowserPolicy, path: string, label: string): { ok: true } | { ok: false; error: string; detail: string } {
  const looks = destructivePattern.test(label) || destructivePattern.test(path) || /\/(checkout|pay|payment|delete|destroy|billing)\b/i.test(path);
  if (!looks) return { ok: true };
  if (policy.allow_destructive === true) return { ok: true };
  if (Array.isArray(policy.allow_destructive) && policy.allow_destructive.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')))
    return { ok: true };
  return { ok: false, error: 'browser_destructive_forbidden', detail: '这次操作可能改动或支付数据，本任务未授予该路径的破坏性授权。' };
}

/** Drop password-like values and credential keys from anything recorded about a browser step. */
export function redactBrowserValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[omitted]';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => redactBrowserValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/^(?:token|secret|password|authorization|cookie|private_key|set-cookie|passwd|pwd)$/i.test(key)) return [key, '[redacted]'];
    return [key, redactBrowserValue(item, depth + 1)];
  }));
}

/** Keep the origin of a recorded URL, but strip token-like query and fragment values. */
export function redactRecordedUrl(value: string | null): string | null {
  if (!value) return null;
  if (value === 'about:blank' || value.startsWith('about:')) return value;
  let url: URL;
  try { url = new URL(value); } catch { return originOf(value) ? value : null; }
  if (url.username || url.password) return originOf(value);
  for (const key of [...url.searchParams.keys()]) {
    if (secretQuery.test(key) || /(?:token|secret|password|passwd|authorization|api[_-]?key)/i.test(key))
      url.searchParams.set(key, '[redacted]');
  }
  if (/(?:token|secret|password|access_token|id_token|authorization)/i.test(url.hash)) url.hash = '#redacted';
  return url.toString();
}
