export function commandOptions(args: any, defaultSeconds: number | null, maxSeconds: number): {
  error?: string; message?: string;
  request?: { type: 'workspace_command'; command: any; timeout_ms: number | null; keep_background: boolean };
  timeout_notice?: { requested_seconds: number; effective_seconds: number; max_seconds: number; message: string };
};
