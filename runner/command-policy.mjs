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
