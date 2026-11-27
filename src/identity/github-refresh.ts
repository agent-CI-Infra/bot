import type { Store } from '../storage/database.js';
import { GitHubIdentity } from './github.js';
import { closeReadTokens } from './read-tokens.js';

export interface GitHubRefreshOptions {
  /** Between the end of one full round and the start of the next. */
  interval?: number;
  /** Installations checked at the same time. */
  concurrency?: number;
  /** Between the starts of two installation checks, so that a round does not reach GitHub in one burst. */
  stagger?: number;
  /** Fallback GitHub API base URL when no OAuth login identity is configured yet. */
  apiUrl?: string;
}

/** The full background round is a fallback (#1411): webhooks, sign-ins and installation syncs refresh what changed in between. */
export const fullRefreshInterval = 8 * 3600_000;

/**
 * Refreshes the local repository-collaborator and installation-owner caches (#1158).
 * Work scales with active installations rather than signed-in users: each installation reuses a cached read-only installation
 * token while it lives (#1411) and sends `If-None-Match` (`304 Not Modified` costs zero quota), then recomputes `scoped_grants`
 * for every bound GitHub account (console sessions, Feishu users and group-binding grantors alike). Super administrators and
 * principals holding independent explicit delegation remain exempt. Rate limits pause the refresh until GitHub's reset.
 *
 * `run` is the full round: on start and then every eight hours it revalidates every installation, which is how a collaborator
 * removed on GitHub without a webhook loses the derived grants. `runChanged` follows each periodic installation sync and only
 * refreshes installations whose member cache needs it: cold, dirty, failed, or with a changed revision, target or selection.
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
    this.interval = options.interval ?? fullRefreshInterval;
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

  /** Stops the rounds and revokes the cached read-only installation tokens. */
  async close(): Promise<void> { this.closed = true; clearTimeout(this.timer); await this.round; await closeReadTokens(this.store); }

  /** One full round across active installations, revalidating cached owners and collaborators with conditional requests. */
  run(): Promise<void> { return this.sync(true); }

  /** After a periodic installation sync: only installations whose member cache needs it; no GitHub request when none does. */
  runChanged(): Promise<void> { return this.sync(false); }

  private async sync(checkAll: boolean): Promise<void> {
    const active = this.identity() ?? this.fallbackIdentity;
    if (active.rateLimitedUntil > Date.now() || this.closed) return;
    await active.syncMemberCache({
      checkAll,
      concurrency: this.concurrency,
      staggerMs: this.stagger,
      shouldStop: () => this.closed,
    });
  }
}
