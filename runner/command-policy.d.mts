export const RUNNER_PROTOCOL_VERSION: number;
export const INLINE_ARGV_COMMAND_LIMIT: number;
export const commandLimit: number;
export const runnerRequestLimit: number;
export const legacyExecRequestLimit: number;
export const RUNNER_TRANSFER_CHUNK_BYTES: number;

export function requestTooLarge(
  input: unknown,
  limit?: number,
): { error: string; limit: number; length: number; detail: string } | null;

export function commandTooLong(
  value: unknown,
): { code: 'command_too_long'; limit: number; length: number } | null;

export function commandFailure(
  error: unknown,
): { ok: false; error: 'command_too_long'; limit: number; length: number; detail: string } | null;

export function commandOptions(
  args: { command?: unknown; timeout_seconds?: unknown; keep_background?: unknown } | null | undefined,
  defaultSeconds: number | null,
  maxSeconds: number,
): {
  error?: string;
  message?: string;
  request?: { type: 'workspace_command'; command: unknown; timeout_ms: number | null; keep_background: boolean };
  timeout_notice?: { requested_seconds: number; effective_seconds: number; max_seconds: number; message: string };
};
