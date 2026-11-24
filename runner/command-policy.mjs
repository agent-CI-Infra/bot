// A runner request travels to the computer as one argument of `docker exec` (manager/docker.mjs base64url-encodes the
// whole request), and Linux refuses a single argument at 131072 bytes (MAX_ARG_STRLEN). 64 KiB of UTF-8 command bytes
// leaves room for the request envelope and still fits that argument; anything longer would need the request delivered
// over stdin instead of argv.
export const commandLimit = 64 * 1024;

// The transport backstop, used by both sides so the number and the predicate cannot drift: manager/docker.mjs refuses a
// request over it, and the control plane answers the same refusal by name before the call (src/agent/workspace.ts,
// src/service-roles/assistant-computers.ts). JSON escaping counts again in this size, so a command inside commandLimit can
// still be too large when it is dense in quotes or newlines; measured: 65535 bytes with 32767 quotes is 98518 JSON bytes.
export const runnerRequestLimit = 95 * 1024;

// A request the transport cannot carry: a stable code with both numbers and an actionable sentence, so the turn gets a
// tool result instead of execution_interrupted and a restart attempt. The detail names the script file because that is
// the way out: a short command reads the large script from disk and the request stays small.
export function requestTooLarge(input) {
  const length = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (length <= runnerRequestLimit) return null;
  return { error: 'runner_request_too_large', limit: runnerRequestLimit, length,
    detail: `The runner request is ${length} bytes once JSON-encoded (quotes and newlines are escaped again); the transport limit is ${runnerRequestLimit} bytes. Write the command to a script file and run the file, or split the work into several commands.` };
}

export function commandTooLong(value) {
  if (typeof value !== 'string') return null;
  const length = Buffer.byteLength(value, 'utf8');
  return length > commandLimit ? { code: 'command_too_long', limit: commandLimit, length } : null;
}

// The runner's answer for that refusal: a stable code with both numbers and an actionable sentence, rather than the
// generic runner_operation_failed that hides which bound was crossed.
export function commandFailure(error) {
  if (error?.code !== 'command_too_long') return null;
  const limit = Number(error.limit), length = Number(error.length);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(length)) return null;
  return { ok: false, error: 'command_too_long', limit, length,
    detail: `The command is ${length} bytes; the limit is ${limit} bytes. Write it as a script file and run that file, or split the work into several commands.` };
}

// Shared by control-plane tools and Pi's local tools. A missing timeout keeps the entry's historical default.
export function commandOptions(args, defaultSeconds, maxSeconds) {
  const requested = args?.timeout_seconds ?? defaultSeconds;
  if (args?.timeout_seconds !== undefined && (!Number.isSafeInteger(args.timeout_seconds) || args.timeout_seconds < 1))
    return { error: 'invalid_timeout_seconds', message: 'timeout_seconds must be a positive integer.' };
  const seconds = requested === null ? null : Math.min(requested, maxSeconds);
  return {
    request: { type: 'workspace_command', command: args?.command, timeout_ms: seconds === null ? null : seconds * 1000, keep_background: args?.keep_background === true },
    ...(requested !== null && requested > maxSeconds ? { timeout_notice: {
      requested_seconds: requested, effective_seconds: seconds, max_seconds: maxSeconds,
      message: `Command timeout reduced from ${requested} to ${seconds} seconds by the configured limit.`
    } } : {})
  };
}
