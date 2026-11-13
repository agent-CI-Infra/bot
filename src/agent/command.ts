import { commandOptions } from '../../runner/command-policy.mjs';
import type { Workspace } from './workspace.js';

export function commandTimeoutLimit() {
  const seconds = Number(process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS ?? 600);
  // Reserve the workspace RPC grace period within Node’s signed 32-bit millisecond timer range.
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > Math.floor((2147483647 - 120000) / 1000))
    throw new Error('BOT_COMMAND_TIMEOUT_MAX_SECONDS must be an integer between 1 and 2147363');
  return seconds;
}
export function commandInstructions(defaultSeconds?: number | null) {
  return `${defaultSeconds === undefined ? 'Default timeouts are 120 seconds for stage observers and independent QA, 180 seconds for role development and request execution; ordinary workflow commands wait for completion without timeout_seconds. Check the run_command description for the current entry.' : defaultSeconds === null ? 'Without timeout_seconds, this entry waits for the command to finish.' : `The default timeout is ${Math.min(defaultSeconds, commandTimeoutLimit())} seconds.`} Explicit timeouts are capped at ${commandTimeoutLimit()} seconds; larger values are reduced with a notice in the result. Use keep_background for servers and watchers; their output is automatically saved to the returned log_path, which later commands can read. Kept processes remain available until the task ends. Ordinary commands clean up their process group when the shell exits.`;
}
export function commandTool(defaultSeconds: number | null, description = 'Run a shell command in this task workspace inside the project container. Output is streamed to the console.') {
  return { type: 'function', function: { name: 'run_command', description: description + ' ' + commandInstructions(defaultSeconds),
    parameters: { type: 'object', properties: {
      command: { type: 'string' },
      // The runtime clamps values above the limit, so the schema must allow them to reach it (including Pi validation).
      timeout_seconds: { type: 'integer', minimum: 1, description: `Optional timeout in seconds; configured maximum ${commandTimeoutLimit()}. Larger values are reduced with a result notice.` },
      keep_background: { type: 'boolean', description: 'Keep servers and watchers available for later commands of this task; output is automatically written to the returned log_path. Kept processes stop when the task ends.' }
    }, required: ['command'], additionalProperties: false } } };
}
export async function runCommand(workspace: Pick<Workspace, 'call'>, key: string, args: any, defaultSeconds: number | null) {
  const options = commandOptions(args, defaultSeconds, commandTimeoutLimit());
  if (!options.request) return { error: options.error, message: options.message };
  const result = await workspace.call(key, options.request);
  return { ...result, ...(options.timeout_notice ? { timeout_notice: options.timeout_notice } : {}) };
}
