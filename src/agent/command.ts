import { commandOptions } from '../../runner/command-policy.mjs';
import type { Workspace } from './workspace.js';

const maxTimerSeconds = Math.floor((2147483647 - 120000) / 1000);

export function commandTimeoutLimit() {
  const seconds = Number(process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS ?? 600);
  // Reserve the workspace RPC grace period within Node’s signed 32-bit millisecond timer range.
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maxTimerSeconds)
    throw new Error('BOT_COMMAND_TIMEOUT_MAX_SECONDS must be an integer between 1 and 2147363');
  return seconds;
}

/**
 * Resolves the optional command timeout budget configured on the role (`budget_policy_ref.command_timeout_seconds`) or
 * project (`policies.command_timeout_seconds`). Returns null when neither is set so entry defaults apply unchanged.
 */
export function configuredCommandTimeout(
  store?: { get(sql: string, ...args: any[]): any; hasTable?(name: string): boolean },
  task?: Record<string, any>,
  role?: string,
): number | null {
  if (!store || !task?.repository_id) return null;
  if (role) {
    try {
      const snap = task.id && store.hasTable?.('task_execution_configs') ? store.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', task.id)?.snapshot : null;
      const raw = snap ? JSON.parse(String(snap))?.roles : (() => { const s = store.get('SELECT value FROM settings WHERE key=?', 'roles:' + task.repository_id)?.value; return s ? JSON.parse(String(s)) : null; })();
      const b = Array.isArray(raw?.roles) ? raw.roles.find((r: any) => r?.role_id === role)?.budget_policy_ref : null;
      if (b && (b.id === 'bounded' || b.id === 'metered') && Number.isSafeInteger(b.command_timeout_seconds) && b.command_timeout_seconds >= 10) return Number(b.command_timeout_seconds);
    } catch {}
  }
  try {
    const p = store.get('SELECT command_timeout_seconds FROM policies WHERE repository_id=?', task.repository_id)?.command_timeout_seconds;
    if (Number.isSafeInteger(p) && p >= 10) return Number(p);
  } catch {}
  return null;
}

export function resolveCommandTimeout(
  store: { get(sql: string, ...args: any[]): any; hasTable?(name: string): boolean } | undefined,
  task: Record<string, any> | undefined,
  role: string | undefined,
  fallbackDefault: number | null,
): { defaultSeconds: number | null; maxSeconds: number } {
  const configured = configuredCommandTimeout(store, task, role);
  const envCap = process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS !== undefined ? commandTimeoutLimit() : null;
  const maxSeconds = envCap ?? Math.min(maxTimerSeconds, Math.max(commandTimeoutLimit(), configured ?? 0));
  return { defaultSeconds: configured ?? fallbackDefault, maxSeconds };
}

export function commandInstructions(defaultSeconds?: number | null, maxSeconds = commandTimeoutLimit()) {
  return `${defaultSeconds === undefined ? 'Default timeouts follow role/project command_timeout_seconds when configured, otherwise 120 seconds for stage observers and lightweight QA and 180 seconds for role development and request execution; ordinary workflow commands wait for completion without timeout_seconds. Check the run_command description for the current entry.' : defaultSeconds === null ? 'Without timeout_seconds, this entry waits for the command to finish.' : `The default timeout is ${Math.min(defaultSeconds, maxSeconds)} seconds.`} Explicit timeouts are capped at ${maxSeconds} seconds; larger values are reduced with a notice in the result. Use keep_background for servers and watchers; their output is automatically saved to the returned log_path, which later commands can read. Kept processes remain available until the task ends. Ordinary commands clean up their process group when the shell exits.`;
}
export function commandTool(defaultSeconds: number | null, description = 'Run a shell command in this task workspace inside the long-lived project container, with internet access for installing dependencies. Output is streamed to the console.', maxSeconds = commandTimeoutLimit()) {
  return { type: 'function', function: { name: 'run_command', description: description + ' ' + commandInstructions(defaultSeconds, maxSeconds),
    parameters: { type: 'object', properties: {
      command: { type: 'string' },
      // The runtime clamps values above the limit, so the schema must allow them to reach it (including Pi validation).
      timeout_seconds: { type: 'integer', minimum: 1, description: `Optional timeout in seconds; configured maximum ${maxSeconds}. Larger values are reduced with a result notice.` },
      keep_background: { type: 'boolean', description: 'Keep servers and watchers available for later commands of this task; output is automatically written to the returned log_path. Kept processes stop when the task ends.' }
    }, required: ['command'], additionalProperties: false } } };
}
/**
 * The same run_command tool with other timeout fields (#1121 review): the entry's own description (for example QA's "do not
 * modify source", or a request's "never publish") is kept, and only the timeout sentences commandInstructions() appended are
 * replaced. A tool built without them keeps its whole description.
 */
export function retimeCommandTool(tool: { function: { description?: string } }, defaultSeconds: number | null, maxSeconds: number) {
  const description = String(tool.function.description ?? '');
  const cut = description.search(/ (?:Default timeouts follow|Without timeout_seconds, this entry|The default timeout is )/);
  return commandTool(defaultSeconds, (cut >= 0 ? description.slice(0, cut) : description) || undefined, maxSeconds);
}
export async function runCommand(workspace: Pick<Workspace, 'call'> & { store?: any; task?: any }, key: string, args: any, defaultSeconds: number | null, role?: string) {
  const budget = resolveCommandTimeout(workspace.store, workspace.task, role ?? workspace.task?.active_role, defaultSeconds);
  const options = commandOptions(args, budget.defaultSeconds, budget.maxSeconds);
  if (!options.request) return { error: options.error, message: options.message };
  const result = await workspace.call(key, options.request);
  return { ...result, ...(options.timeout_notice ? { timeout_notice: options.timeout_notice } : {}) };
}
