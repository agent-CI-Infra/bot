/** Heuristic only: a generic confirm or custom widget can still change data or pay. */
export const destructivePattern = /delete account|destroy|uninstall|revoke access|terminate|pay now|place order|checkout|purchase|buy now|confirm payment|wire transfer|删除账号|注销|付款|结算下单|确认支付|转账/i;
const secretQuery = /^(?:token|secret|password|passwd|pwd|authorization|access_token|id_token|refresh_token|api[_-]?key)$/i;
export const defaultTimeoutMs = 60_000;
export const maxTimeoutMs = 180_000;

/** Clamp a task-provided timeout so callers never arm a timer with a raw user value. */
export function boundedTimeoutMs(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.min(maxTimeoutMs, Math.max(1_000, Math.floor(timeout))) : defaultTimeoutMs;
}

export function originOf(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '[::]') return null;
  return url.origin;
}

export function isBrowserPassthroughUrl(value) {
  if (value === 'about:blank' || String(value).startsWith('about:')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'data:' || url.protocol === 'blob:';
  } catch { return false; }
}

export function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.origins)) return null;
  const origins = [...new Set(raw.origins.map(value => originOf(String(value ?? ''))))].filter(Boolean);
  if (!origins.length) return null;
  return {
    origins,
    allow_destructive: raw.allow_destructive === true ? true
      : Array.isArray(raw.allow_destructive) ? raw.allow_destructive.map(value => String(value)).filter(Boolean)
      : false,
    timeout_ms: boundedTimeoutMs(raw.timeout_ms)
  };
}

export function allowedOrigin(policy, value) {
  const origin = originOf(value);
  if (!origin) return { ok: false, error: 'browser_url_refused', detail: '只允许没有账号口令的 http 或 https 地址，且必须事先列入本任务允许的站点。' };
  const url = new URL(value);
  if (!policy.origins.includes(origin))
    return { ok: false, error: 'browser_origin_forbidden', detail: '这个地址不在本任务允许访问的站点范围内。' };
  return { ok: true, url };
}

export function networkRequestAllowed(policy, value) {
  if (isBrowserPassthroughUrl(value)) return { ok: true };
  const check = allowedOrigin(policy, value);
  if (check.ok) return { ok: true };
  return check;
}

export function destructiveAllowed(policy, path, label) {
  const looks = destructivePattern.test(label) || destructivePattern.test(path) || /\/(checkout|pay|payment|delete|destroy|billing)\b/i.test(path);
  if (!looks) return { ok: true };
  if (policy.allow_destructive === true) return { ok: true };
  if (Array.isArray(policy.allow_destructive) && policy.allow_destructive.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')))
    return { ok: true };
  return { ok: false, error: 'browser_destructive_forbidden', detail: '这次操作可能改动或支付数据，本任务未授予该路径的破坏性授权。' };
}

export function redactBrowserValue(value, depth = 0) {
  if (depth > 8) return '[omitted]';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => redactBrowserValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/^(?:token|secret|password|authorization|cookie|private_key|set-cookie|passwd|pwd)$/i.test(key)) return [key, '[redacted]'];
    if (typeof item === 'string' && /^(?:url|href|location|redirect)$/i.test(key)) return [key, redactRecordedUrl(item)];
    return [key, redactBrowserValue(item, depth + 1)];
  }));
}

export function redactRecordedUrl(value) {
  if (!value) return null;
  if (value === 'about:blank' || String(value).startsWith('about:')) return value;
  let url;
  try { url = new URL(value); } catch { return String(value).startsWith('/') ? value : (originOf(value) ? value : null); }
  if (url.username || url.password) return originOf(value);
  for (const key of [...url.searchParams.keys()]) {
    if (secretQuery.test(key) || /(?:token|secret|password|passwd|authorization|api[_-]?key)/i.test(key))
      url.searchParams.set(key, '[redacted]');
  }
  if (/(?:token|secret|password|access_token|id_token|authorization)/i.test(url.hash)) url.hash = '#redacted';
  return url.toString();
}

export function redactArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const safe = { ...args };
  if (typeof safe.url === 'string') safe.url = redactRecordedUrl(safe.url);
  if (typeof safe.text === 'string' && /password|token|secret/i.test(String(safe.selector || safe.name || safe.label || '')))
    safe.text = '[redacted]';
  return redactBrowserValue(safe);
}

/** Redact typed text and screenshot bytes from records that are persisted. The live runner request still carries them. */
export function sanitizeBrowserTrajectory(value, context = {}) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeBrowserTrajectory(item, context));
  const next = { browser: context.browser || value.type === 'workspace_browser' || value.action === 'type' || context.args,
    args: context.args, screenshot: context.screenshot };
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const child = { ...next, args: next.args || key === 'args', screenshot: next.screenshot || key === 'screenshot' };
    if (key === 'text' && typeof entry === 'string' && (child.browser || child.args)) out[key] = '[redacted]';
    else if (key === 'base64' && typeof entry === 'string' && (child.screenshot || child.browser)) out[key] = '[omitted]';
    else out[key] = sanitizeBrowserTrajectory(entry, child);
  }
  return out;
}

function coversPrefix(parent, child) {
  if (parent === child) return true;
  const root = String(parent).endsWith('/') ? parent : parent + '/';
  return String(child) === parent || String(child).startsWith(root);
}

/** Origins are compared separately. Destructive grants and timeouts may only shrink. */
export function tighterDestructive(current, next) {
  if (next === false || current === false) return false;
  if (next === true) return current;
  if (current === true) return next;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  const out = [];
  for (const candidate of next) if (current.some(parent => coversPrefix(parent, candidate)) && !out.includes(candidate)) out.push(candidate);
  for (const candidate of current) if (next.some(parent => coversPrefix(parent, candidate)) && !out.includes(candidate)) out.push(candidate);
  return out;
}
