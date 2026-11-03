// Failures of background work (reconciliation, retries of saved operations) go to the control plane's stderr, which is
// where an administrator reads them (`docker compose -p bot logs bot`). The same failure repeats on every pass of a
// loop, so a key logs once when its failure first appears or changes, and once more when it works again.
export class FailureLog {
  private readonly last = new Map<string, string>();
  constructor(private readonly scope: string) {}
  report(key: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    if (this.last.get(key) === reason) return;
    this.last.set(key, reason); console.error(`[${this.scope}] ${key}: ${reason}`);
  }
  clear(key: string): void { if (this.last.delete(key)) console.error(`[${this.scope}] ${key}: works again`); }
  // Work that is given up will not work again: its key goes without a line.
  forget(key: string): void { this.last.delete(key); }
}
