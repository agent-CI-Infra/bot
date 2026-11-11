// The control plane runs on one thread: a synchronous piece of work (a heavy query, a huge JSON value) blocks every
// request, timer and task until it returns, and requests started before it can time out afterwards. This finds the
// work. A one-second timer notices that it ran late and logs how long the thread was blocked, with the HTTP requests in
// flight at that moment; a request that took long is logged with its method and path. A block with no request in
// flight came from background work (engine, timers). Paths only: query strings can carry values that must not be logged.
interface InFlight { method: string; path: string; started: number }

export class StallMonitor {
  private readonly active = new Map<number, InFlight>();
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: { stallMs?: number; slowMs?: number; log?: (line: string) => void; now?: () => number } = {}) {}

  private get now() { return this.options.now ?? Date.now; }
  private log(line: string) { (this.options.log ?? console.warn)(line); }

  start(intervalMs = 1000) {
    let last = this.now();
    this.timer = setInterval(() => {
      const now = this.now(), late = now - last - intervalMs; last = now;
      if (late >= (this.options.stallMs ?? 2000)) this.log(`[stall] event loop blocked ~${(late / 1000).toFixed(1)} s; requests in flight: ${this.describe(now)}`);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  /** Tracks one HTTP request; the returned function marks it finished. */
  request(method: string, url: string | undefined): () => void {
    const id = ++this.sequence, started = this.now(), path = (url || '/').split('?')[0]!.slice(0, 200);
    this.active.set(id, { method, path, started });
    let finished = false;
    return () => {
      if (finished) return; finished = true; this.active.delete(id);
      const ms = this.now() - started;
      if (ms >= (this.options.slowMs ?? 5000)) this.log(`[slow] ${method} ${path} ${ms} ms`);
    };
  }

  private describe(now: number) {
    const rows = [...this.active.values()].sort((a, b) => a.started - b.started);
    if (!rows.length) return 'none';
    return rows.slice(0, 5).map(row => `${row.method} ${row.path} (${((now - row.started) / 1000).toFixed(1)} s)`).join(', ') + (rows.length > 5 ? ` and ${rows.length - 5} more` : '');
  }
}
