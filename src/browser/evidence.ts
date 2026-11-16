import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../storage/database.js';
import { type Actor, scope } from '../app/auth.js';
import { fail } from '../core/security.js';
import { redactBrowserValue, redactRecordedUrl } from './policy.js';
import { browserEvidenceDir } from './runtime.js';
import { browserEvidenceRoot } from './tools.js';

export type BrowserEvidenceList = {
  task_id: string;
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

const screenshotName = /^step-\d+\.png$/;

export function listBrowserEvidence(store: Store, taskId: string): BrowserEvidenceList {
  const dir = browserEvidenceDir(browserEvidenceRoot(store), taskId);
  const stepsFile = join(dir, 'steps.json');
  const empty: BrowserEvidenceList = { task_id: taskId, steps: [] };
  if (!existsSync(stepsFile)) return empty;
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(stepsFile, 'utf8')); } catch { return empty; }
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  return redactBrowserValue({
    task_id: taskId,
    steps: steps.map((step: any) => {
      const file = typeof step?.screenshot?.file === 'string' && screenshotName.test(basename(step.screenshot.file)) ? basename(step.screenshot.file) : null;
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
  if (!screenshotName.test(name)) return null;
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
  const id = decodeURIComponent((list || file)![1]!);
  const filter = scope(user, 'repository_id');
  const task = store.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`, id, ...filter.args);
  if (!task) fail(404, 'task_not_found');
  if (list) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(listBrowserEvidence(store, id)));
    return true;
  }
  const name = decodeURIComponent(file![2]!);
  const path = resolveEvidenceFile(store, id, name);
  if (!path) fail(404, 'browser_evidence_not_found');
  const bytes = readFileSync(path!);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(404, 'browser_evidence_not_found');
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
