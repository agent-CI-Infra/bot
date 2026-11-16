import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Row, Store } from '../storage/database.js';
import { TaskRecords } from '../tasks/service.js';
import { browserPolicyOf, redactBrowserValue } from './policy.js';
import { closeBrowserSession, existingBrowserSession, openBrowserSession, resolveChromium, type BrowserSession } from './runtime.js';

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

export const browserTool = fn('browser',
  'Drive an isolated real browser for this task: open a permitted page, click or type, take a screenshot, or close. Only origins listed on the task may be opened. Destructive actions (delete, pay, checkout, and similar) need an explicit grant. Passwords are never recorded. A fresh profile is used; it does not reuse the host desktop or its cookies.',
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

function recordTool(store: Store, task: Row, action: string, args: Record<string, unknown>, result: Record<string, unknown>): void {
  const safeArgs = { ...args };
  if (action === 'type' && (result.secret_field === true || /password|token|secret/i.test(String(args.selector || args.name || args.label || ''))))
    safeArgs.text = '[redacted]';
  const recorded = redactBrowserValue({
    name: 'browser',
    action,
    arguments: safeArgs,
    result,
    screenshot: (result.step as { screenshot?: unknown } | undefined)?.screenshot ?? null
  });
  new TaskRecords(store).history(task.id, 'execution_evidence', recorded);
}

export async function runBrowserTool(
  store: Store,
  task: Row,
  args: unknown,
  options: { guard?: () => Promise<void> | void } = {}
): Promise<Record<string, unknown>> {
  const policy = browserPolicyOf(task);
  if (!policy) return { error: 'browser_not_configured', detail: '这个任务没有列出允许打开的站点，不能启动浏览器。' };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'browser_invalid_arguments', detail: 'browser 需要一个动作。' };
  const input = args as Record<string, unknown>;
  const action = String(input.action || '');
  if (action === 'close') {
    const prior = existingBrowserSession(task.id);
    const steps = prior?.steps.length ?? 0;
    await closeBrowserSession(task.id);
    const result = { ok: true, steps };
    recordTool(store, task, action, input, result);
    return result;
  }
  try {
    resolveChromium();
    const session: BrowserSession = existingBrowserSession(task.id) || await openBrowserSession(task.id, policy, browserEvidenceRoot(store));
    const result = await session.run(action, input, options.guard) as Record<string, unknown>;
    recordTool(store, task, action, input, result);
    return redactBrowserValue(result) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const result = code === 'browser_runtime_unavailable' || /browser_runtime_unavailable|executable|Failed to launch|browser has been closed/i.test(String(error))
      ? { error: 'browser_runtime_unavailable', detail: (error as { detail?: string }).detail || '未能启动真实浏览器。控制面或 CI 使用 Playwright 已安装的浏览器；生产项目电脑镜像由 #916 预装。' }
      : { error: 'browser_failed', detail: '浏览器动作没有完成。' };
    recordTool(store, task, action, input, result);
    try { await closeBrowserSession(task.id); } catch { /* already closed */ }
    return result;
  }
}
