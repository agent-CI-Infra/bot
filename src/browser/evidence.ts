import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../storage/database.js';
import { type Actor, scope } from '../app/auth.js';
import { fail } from '../core/security.js';
import { browserEvidenceDir } from './runtime.js';

const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');
const secretQuery = /^(?:token|secret|password|passwd|pwd|authorization|access_token|id_token|refresh_token|api[_-]?key)$/i;

export function browserEvidenceRoot(store: Store): string {
  return store.path === ':memory:' ? join(tmpdir(), 'bot-browser-evidence') : join(dirname(store.path), 'browser-evidence');
}

export function removeBrowserEvidence(store: Store, taskIds: readonly string[]): void {
  const root = browserEvidenceRoot(store);
  for (const id of taskIds) {
    if (!id) continue;
    try { rmSync(browserEvidenceDir(root, id), { recursive: true, force: true }); } catch { /* already gone or unreadable */ }
  }
}

export function evidenceFileDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(pngMagic)) return null;
  return createHash('sha256').update(bytes).digest('hex');
}

function originOf(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '[::]') return null;
  return url.origin;
}

export function redactRecordedUrl(value: string): string | null {
  if (!value) return null;
  if (value === 'about:blank' || String(value).startsWith('about:')) return value;
  let url: URL;
  try { url = new URL(value); } catch { return String(value).startsWith('/') ? value : (originOf(value) ? value : null); }
  if (url.username || url.password) return originOf(value);
  for (const key of [...url.searchParams.keys()]) {
    if (secretQuery.test(key) || /(?:token|secret|password|passwd|authorization|api[_-]?key)/i.test(key))
      url.searchParams.set(key, '[redacted]');
  }
  if (/(?:token|secret|password|access_token|id_token|authorization)/i.test(url.hash)) url.hash = '#redacted';
  return url.toString();
}

export function redactBrowserValue(value: unknown, depth = 0): unknown {
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

export type BrowserEvidenceList = {
  task_id: string;
  total_steps: number;
  truncated: boolean;
  steps: Array<{
    id: string;
    n: number;
    at: string;
    action: string;
    url: string | null;
    title: string | null;
    result: string;
    error?: string;
    screenshot?: { file: string; sha256: string; bytes: number; url: string };
  }>;
};

export const isBrowserScreenshotName = (name: string) => /^step-\d+\.png$/.test(name);
const maxListedSteps = 80;

function safeDecode(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function recordedSteps(dir: string): any[] {
  try {
    const { steps } = JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8'));
    return Array.isArray(steps) ? steps : [];
  } catch { return []; }
}

export function listBrowserEvidence(store: Store, taskId: string): BrowserEvidenceList {
  const all = recordedSteps(browserEvidenceDir(browserEvidenceRoot(store), taskId));
  const truncated = all.length > maxListedSteps;
  const steps = truncated ? all.slice(-maxListedSteps) : all;
  return redactBrowserValue({
    task_id: taskId,
    total_steps: all.length,
    truncated,
    steps: steps.map((step: any) => {
      const file = typeof step?.screenshot?.file === 'string' && isBrowserScreenshotName(basename(step.screenshot.file)) ? basename(step.screenshot.file) : null;
      return {
        id: String(step.id || ''),
        n: Number(step.n) || 0,
        at: String(step.at || ''),
        action: String(step.action || ''),
        url: typeof step.url === 'string' ? redactRecordedUrl(step.url) : null,
        title: typeof step.title === 'string' ? step.title : null,
        result: String(step.result || ''),
        ...(typeof step.error === 'string' ? { error: step.error } : {}),
        ...(file ? { screenshot: { file, sha256: String(step.screenshot.sha256 || ''), bytes: Number(step.screenshot.bytes) || 0, url: `/api/tasks/${encodeURIComponent(taskId)}/browser-evidence/${file}` } } : {})
      };
    })
  }) as BrowserEvidenceList;
}

export function resolveEvidenceFile(store: Store, taskId: string, name: string): string | null {
  if (!isBrowserScreenshotName(name)) return null;
  const listed = listBrowserEvidence(store, taskId).steps.some(step => step.screenshot?.file === name);
  if (!listed) return null;
  const dir = browserEvidenceDir(browserEvidenceRoot(store), taskId);
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const root = realpathSync(dir);
  const real = realpathSync(path);
  if (real !== join(root, name) && !real.startsWith(root + '/')) return null;
  return real;
}

/** Authenticated GET for the step list (JSON) or one PNG. Returns true when this request was handled. */
export function sendBrowserEvidence(store: Store, user: Actor, url: URL, _req: IncomingMessage, res: ServerResponse): boolean {
  const list = /^\/api\/tasks\/([^/]+)\/browser-evidence$/.exec(url.pathname);
  const file = /^\/api\/tasks\/([^/]+)\/browser-evidence\/([^/]+)$/.exec(url.pathname);
  if (!list && !file) return false;
  const rawId = safeDecode((list || file)![1]!);
  if (rawId == null) { fail(400, 'invalid_task_id'); return false; }
  const id = rawId;
  const filter = scope(user, 'repository_id');
  const task = store.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`, id, ...filter.args);
  if (!task) fail(404, 'task_not_found');
  if (list) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(listBrowserEvidence(store, id)));
    return true;
  }
  const rawName = safeDecode(file![2]!);
  if (rawName == null) { fail(400, 'invalid_evidence_name'); return false; }
  const name = rawName;
  const path = resolveEvidenceFile(store, id, name);
  if (!path) { fail(404, 'browser_evidence_not_found'); return false; }
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(404, 'browser_evidence_not_found');
  const listedHash = listBrowserEvidence(store, id).steps.find(step => step.screenshot?.file === name)?.screenshot?.sha256;
  const digest = evidenceFileDigest(path!);
  if (!digest || (listedHash && listedHash !== digest)) fail(404, 'browser_evidence_not_found');
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${name}"`
  });
  res.end(bytes);
  return true;
}
