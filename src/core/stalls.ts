// The control plane runs on one thread: a synchronous piece of work (a heavy query, a huge JSON value) blocks every
// request, timer and task until it returns, and requests started before it can time out afterwards. This finds the
// work. A one-second timer notices that it ran late and logs how long the thread was blocked, with the HTTP requests that
// finished while it was blocked (a request whose handler blocks the thread finishes just before the timer runs, so it is
// usually the cause) and those still in flight; a request that took long is logged with its method and path. A block
// with neither came from background work (engine, timers). Paths only: query strings can carry values that must not be
// logged.
interface InFlight { method: string; path: string; started: number }
interface Finished extends InFlight { finished: number }

export class StallMonitor {
  private readonly active = new Map<number, InFlight>();
  private readonly recent: Finished[] = [];
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: { stallMs?: number; slowMs?: number; log?: (line: string) => void; now?: () => number } = {}) {}

  private get now() { return this.options.now ?? Date.now; }
  private log(line: string) { (this.options.log ?? console.warn)(line); }

  start(intervalMs = 1000) {
    let last = this.now();
    this.timer = setInterval(() => {
      const now = this.now(), late = now - last - intervalMs; last = now;
      if (late >= (this.options.stallMs ?? 2000)) {
        const during = this.recent.filter(row => row.finished >= now - late - intervalMs);
        this.log(`[stall] event loop blocked ~${(late / 1000).toFixed(1)} s; requests finished while blocked: ${during.length ? this.list(during, row => row.finished) : 'none'}; requests in flight: ${this.describe(now)}`);
      }
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
      this.recent.push({ method, path, started, finished: started + ms }); if (this.recent.length > 20) this.recent.shift();
      if (ms >= (this.options.slowMs ?? 5000)) this.log(`[slow] ${method} ${path} ${ms} ms`);
    };
  }

  private describe(now: number) {
    const rows = [...this.active.values()];
    return rows.length ? this.list(rows, () => now) : 'none';
  }

  private list<T extends InFlight>(rows: T[], end: (row: T) => number) {
    const sorted = [...rows].sort((a, b) => a.started - b.started);
    return sorted.slice(0, 5).map(row => `${row.method} ${row.path} (${((end(row) - row.started) / 1000).toFixed(1)} s)`).join(', ') + (sorted.length > 5 ? ` and ${sorted.length - 5} more` : '');
  }
}
