// Commands up to 64 KiB run directly via `/bin/sh -c`; larger commands (up to commandLimit) are executed
// via a private temporary script file so Linux's 128 KiB MAX_ARG_STRLEN never causes E2BIG.
export const RUNNER_PROTOCOL_VERSION = 2;
export const INLINE_ARGV_COMMAND_LIMIT = 64 * 1024;

// Unified UTF-8 command length ceiling for project and assistant computers. With the resident runner daemon
// (HTTP/WS over private UDS or network) and stdin delivery in local mode, commands are no longer constrained
// by `docker exec` argv limits; this application-layer cap still prevents unbounded script payloads / OOM.
export const commandLimit = 1024 * 1024;

// Application-layer JSON request ceiling for the unified runner wire protocol (HTTP/WS body and local stdin).
// Large files, git packs, configs and archives transfer comfortably in MiB chunks (or via binary streaming)
// while bounding memory per request.
export const runnerRequestLimit = 8 * 1024 * 1024;

// Legacy fallback bound used only when talking to an unupgraded container over `docker exec` argv.
export const legacyExecRequestLimit = 95 * 1024;

// Default chunk size for runner file/config/pack transfers over the network/UDS runner protocol (1 MiB raw bytes,
// ~1.33 MiB base64, replacing the old 30–45 KiB argv-constrained micro-chunks).
export const RUNNER_TRANSFER_CHUNK_BYTES = 1024 * 1024;

// A request that exceeds the configured runner request ceiling: returns a stable code with both numbers and
// an actionable hint so callers surface a tool refusal instead of an interrupted execution or container restart.
export function requestTooLarge(input, limit = runnerRequestLimit) {
  const length = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (length <= limit) return null;
  return {
    error: 'runner_request_too_large',
    limit,
    length,
    detail: `The runner request is ${length} bytes once JSON-encoded; the transport limit is ${limit} bytes. Write the command to a script file and run the file, or split the work into smaller requests.`,
  };
}

export function commandTooLong(value) {
  if (typeof value !== 'string') return null;
  const length = Buffer.byteLength(value, 'utf8');
  return length > commandLimit ? { code: 'command_too_long', limit: commandLimit, length } : null;
}

// The runner's answer for a command over commandLimit: a stable code with both numbers and an actionable sentence,
// rather than the generic runner_operation_failed that hides which bound was crossed.
export function commandFailure(error) {
  if (error?.code !== 'command_too_long') return null;
  const limit = Number(error.limit), length = Number(error.length);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(length)) return null;
  return {
    ok: false,
    error: 'command_too_long',
    limit,
    length,
    detail: `The command is ${length} bytes; the limit is ${limit} bytes. Write it as a script file and run that file, or split the work into several commands.`,
  };
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
      message: `Command timeout reduced from ${requested} to ${seconds} seconds by the configured limit.`,
    } } : {}),
  };
}
