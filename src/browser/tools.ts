import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Row, Store } from '../storage/database.js';
import type { Workspace } from '../agent/workspace.js';
import { TaskRecords } from '../tasks/service.js';
import { browserPolicyOf, redactArgs, redactBrowserValue } from './policy.js';
import { browserEvidenceDir } from './runtime.js';

const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

export const browserTool = fn('browser',
  'Drive an isolated real browser for this task on the project computer: open a permitted page, click or type, take a screenshot, or close. The control plane only dispatches the action and stores evidence; it never starts Chromium. Every HTTP request (pages, redirects, iframes, subresources) must stay on origins listed on the task. WebSocket and WebRTC are disabled rather than intercepted: a page cannot keep a socket or peer connection. EventSource is not hop-by-hop buffered, so an already-allowed stream that later redirects off-origin may still send one request. A static label/path check flags some destructive wording (delete, pay, checkout and similar) and requires an explicit grant; it cannot recognize every risky click, so a generic confirm may still run. Recognized password or secret fields are not kept in logs, and already-saved screenshots from that session are removed; unrecognized fields can still leak. A fresh profile is used; it does not reuse the host desktop or its cookies. If the project computer or Chromium is unavailable, the tool fails instead of falling back to the control plane.',
  {
    action: { type: 'string', enum: ['open', 'see', 'click', 'type', 'screenshot', 'close'] },
    url: { type: 'string', description: 'Page to open (action=open). Must match an allowed origin.' },
    name: { type: 'string', description: 'Visible name, label or text of the control to click or type into.' },
    selector: { type: 'string', description: 'Optional CSS selector when the name is not unique.' },
    text: { type: 'string', description: 'Text to type (action=type). Password values are not kept in logs or evidence.' }
  },
  ['action']);

export const browserToolNames = ['browser'];

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

function recordTool(store: Store, task: Row, action: string, args: Record<string, unknown>, result: Record<string, unknown>): void {
  const safeArgs = redactArgs({ ...args }) as Record<string, unknown>;
  if (action === 'type' && (result.secret_field === true || /password|token|secret/i.test(String(args.selector || args.name || args.label || ''))))
    safeArgs.text = '[redacted]';
  const recorded = redactBrowserValue({
    name: 'browser',
    action,
    arguments: safeArgs,
    result: redactBrowserValue({ ...result, screenshot: result.screenshot ? { file: (result.screenshot as any).file, sha256: (result.screenshot as any).sha256, bytes: (result.screenshot as any).bytes } : null }),
    screenshot: (result.step as { screenshot?: unknown } | undefined)?.screenshot ?? result.screenshot ?? null
  });
  new TaskRecords(store).history(task.id, 'execution_evidence', recorded);
}

function persistEvidence(store: Store, task: Row, result: Record<string, unknown>): void {
  const dir = browserEvidenceDir(browserEvidenceRoot(store), task.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stepsFile = join(dir, 'steps.json');
  let steps: any[] = [];
  try { steps = JSON.parse(readFileSync(stepsFile, 'utf8')).steps || []; } catch { steps = []; }
  const withhold = result.secret_field === true || result.error === 'browser_screenshot_withheld';
  if (withhold) {
    for (const step of steps) {
      if (step.screenshot?.file) try { rmSync(join(dir, String(step.screenshot.file)), { force: true }); } catch { /* gone */ }
      delete step.screenshot;
    }
  }
  const incoming = result.step && typeof result.step === 'object' ? { ...(result.step as Record<string, unknown>) } : null;
  const shot = result.screenshot as { file?: string; sha256?: string; bytes?: number; base64?: string } | undefined;
  if (incoming) {
    if (shot?.base64 && !withhold) {
      const buf = Buffer.from(String(shot.base64), 'base64');
      if (buf.subarray(0, 8).equals(pngMagic)) {
        const sha256 = createHash('sha256').update(buf).digest('hex');
        if (!shot.sha256 || shot.sha256 === sha256) {
          const file = evidenceShotName(incoming, shot.file);
          if (!file) { delete incoming.screenshot; }
          else {
            writeFileSync(join(dir, file), buf, { mode: 0o600 });
            incoming.screenshot = { file, sha256, bytes: buf.length };
          }
        } else delete incoming.screenshot;
      } else delete incoming.screenshot;
    } else if (withhold) delete incoming.screenshot;
    const i = steps.findIndex(step => step.id === incoming.id || step.n === incoming.n);
    if (i >= 0) steps[i] = incoming;
    else steps.push(incoming);
  }
  writeFileSync(stepsFile, JSON.stringify({ task_id: task.id, steps }, null, 2), { mode: 0o600 });
  if (result.screenshot && typeof result.screenshot === 'object') {
    const meta = result.screenshot as { base64?: string; file?: string; sha256?: string; bytes?: number };
    delete meta.base64;
  }
}

function computerUnavailable(): Record<string, unknown> {
  return { error: 'browser_computer_unavailable', detail: '这个任务还没有可用的项目电脑，不能启动浏览器。控制面不会改为在本机启动浏览器。' };
}

function mapComputerError(result: Record<string, unknown>): Record<string, unknown> {
  const error = String(result.error || '');
  if (error === 'workspace_unavailable' || error === 'runner_operation_failed' || error === 'stale_generation')
    return { ...result, error: 'browser_computer_unavailable', detail: result.detail || '项目电脑当前不可用，不能启动浏览器。' };
  return result;
}

/** Close the project-computer browser session. Does nothing when no computer is attached. Never starts Chromium here. */

function evidenceShotName(step: Record<string, unknown>, shotFile?: string): string | null {
  const raw = basename(String((step.screenshot as { file?: string } | undefined)?.file || shotFile || `step-${step.n}.png`));
  if (/^step-\d+\.png$/.test(raw)) return raw;
  const n = Number(step.n);
  if (Number.isInteger(n) && n >= 0) return `step-${n}.png`;
  return null;
}

const openedBrowsers = new WeakSet<Workspace>();

export async function closeBrowserOnComputer(workspace: Workspace | undefined, task: { workspace_id?: unknown; generation?: unknown }): Promise<void> {
  if (!workspace || !task.workspace_id || !task.generation || !openedBrowsers.has(workspace)) return;
  openedBrowsers.delete(workspace);
  await workspace.deliverCleanup({ type: 'workspace_browser', action: 'close' }).catch(() => {});
}

export async function runBrowserTool(
  store: Store,
  task: Row,
  args: unknown,
  options: { guard?: () => Promise<void> | void; workspace?: Workspace } = {}
): Promise<Record<string, unknown>> {
  const policy = browserPolicyOf(task);
  if (!policy) return { error: 'browser_not_configured', detail: '这个任务没有列出允许打开的站点，不能启动浏览器。' };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'browser_invalid_arguments', detail: 'browser 需要一个动作。' };
  const input = args as Record<string, unknown>;
  const action = String(input.action || '');
  const workspace = options.workspace;
  if (!workspace) return computerUnavailable();
  await options.guard?.();
  if (action === 'close') {
    await closeBrowserOnComputer(workspace, task);
    const result = { ok: true };
    recordTool(store, task, action, input, result);
    return result;
  }
  const response = await workspace.call(`browser:${task.id}:${action}:${Date.now()}`, {
    type: 'workspace_browser',
    action,
    args: { url: input.url, name: input.name, selector: input.selector, text: input.text, label: input.label },
    policy,
    timeout_ms: policy.timeout_ms
  });
  openedBrowsers.add(workspace);
  const result = mapComputerError(response && typeof response === 'object' ? response as Record<string, unknown> : { error: 'browser_failed', detail: '浏览器动作没有完成。' });
  persistEvidence(store, task, result);
  recordTool(store, task, action, input, result);
  return result;
}

export function evidenceFileDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(pngMagic)) return null;
  return createHash('sha256').update(bytes).digest('hex');
}
