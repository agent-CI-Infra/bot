import { constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { open, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../storage/database.js';
import { type Actor, scope } from '../app/auth.js';
import { fail } from '../core/security.js';
import { redactBrowserValue, redactRecordedUrl } from './policy.js';
import { browserEvidenceDir } from './runtime.js';
import { browserEvidenceRoot, evidenceFileDigest } from './tools.js';

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

/** An explicitly selected screenshot must still match the evidence recorded for this task. */
export async function readBrowserScreenshot(store: Store, taskId: string, name: string, maxBytes: number): Promise<Buffer | null> {
  if (!isBrowserScreenshotName(name)) return null;
  const root = resolve(browserEvidenceRoot(store)), dir = browserEvidenceDir(root, taskId);
  try {
    if (dirname(dir) !== root || await realpath(dir) !== dir) return null;
    const shot = recordedSteps(dir).find(step => step?.screenshot?.file === name)?.screenshot;
    if (!Number.isSafeInteger(shot?.bytes) || shot.bytes < 1 || shot.bytes > maxBytes) return null;
    const path = join(dir, name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      // Confirm the opened file as well, in case its parent was replaced after the directory check.
      if (!info.isFile() || info.nlink !== 1 || info.size !== shot.bytes || await readlink(`/proc/self/fd/${handle.fd}`) !== path) return null;
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      return length === info.size && createHash('sha256').update(bytes).digest('hex') === shot.sha256 ? bytes : null;
    } finally { await handle.close(); }
  } catch { return null; }
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
