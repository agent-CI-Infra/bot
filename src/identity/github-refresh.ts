import type { Store } from '../storage/database.js';
import { GitHubIdentity } from './github.js';

export interface GitHubRefreshOptions {
  /** Between the end of one round and the start of the next. */
  interval?: number;
  /** Installations checked at the same time. */
  concurrency?: number;
  /** Between the starts of two installation checks, so that a round does not reach GitHub in one burst. */
  stagger?: number;
  /** Fallback GitHub API base URL when no OAuth login identity is configured yet. */
  apiUrl?: string;
}

/**
 * Periodically refreshes the local repository-collaborator and installation-owner caches (#1158).
 * Work scales with active installations rather than signed-in users: each installation reuses one read-only installation
 * token per round and sends `If-None-Match` (`304 Not Modified` costs zero quota), then recomputes `scoped_grants` for
 * every bound GitHub account (console sessions, Feishu users and group-binding grantors alike). Super administrators and
 * principals holding independent explicit delegation remain exempt. Rate limits pause the refresh until GitHub's reset.
 */
export class GitHubRefresh {
  private timer?: ReturnType<typeof setTimeout>;
  private round?: Promise<void>;
  private started = false;
  private closed = false;
  private readonly interval: number;
  private readonly concurrency: number;
  private readonly stagger: number;
  private readonly fallbackIdentity: GitHubIdentity;

  constructor(readonly store: Store, private readonly identity: () => GitHubIdentity | undefined, options: GitHubRefreshOptions = {}) {
    this.interval = options.interval ?? 10 * 60_000;
    this.concurrency = options.concurrency ?? 2;
    this.stagger = options.stagger ?? 2_000;
    this.fallbackIdentity = new GitHubIdentity(store, {
      clientId: 'member-cache-sync',
      clientSecret: 'unused',
      redirectUri: 'http://127.0.0.1/auth/github/callback',
      apiUrl: options.apiUrl,
    });
  }

  /** The first round runs at once, warming the local member cache and cleaning up stale derived grants on startup. */
  start(): void {
    if (this.started || this.closed) return; this.started = true;
    const tick = () => {
      this.round = this.run().catch(error => console.error('[github-refresh] round failed:', error)).finally(() => {
        if (!this.closed) { this.timer = setTimeout(tick, this.interval); this.timer.unref(); }
      });
    };
    tick();
  }

  async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); await this.round; }

  /** One round across active installations, revalidating cached owners and collaborators with conditional requests. */
  async run(): Promise<void> {
    const active = this.identity() ?? this.fallbackIdentity;
    if (active.rateLimitedUntil > Date.now() || this.closed) return;
    await active.syncMemberCache({
      checkAll: true,
      concurrency: this.concurrency,
      staggerMs: this.stagger,
      shouldStop: () => this.closed,
    });
  }
}
