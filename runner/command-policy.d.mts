export function commandOptions(args: any, defaultSeconds: number | null, maxSeconds: number): {
  error?: string; message?: string;
  request?: { type: 'workspace_command'; command: any; timeout_ms: number | null; keep_background: boolean };
  timeout_notice?: { requested_seconds: number; effective_seconds: number; max_seconds: number; message: string };
};

export const commandLimit: number;
export const runnerRequestLimit: number;
export function requestTooLarge(input: unknown): { error: string; limit: number; length: number; detail: string } | null;
export function commandTooLong(value: unknown): { code: string; limit: number; length: number } | null;
export function commandFailure(error: any): { ok: false; error: string; limit: number; length: number; detail: string } | null;
