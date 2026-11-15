import { setTimeout as sleep } from 'node:timers/promises';
import type { Store } from '../storage/database.js';
import { verificationExempt, type GitHubIdentity } from './github.js';

export interface GitHubRefreshOptions {
  /** Between the end of one round and the start of the next. */
  interval?: number;
  /** Principals checked at the same time. */
  concurrency?: number;
  /** Between the starts of two checks, so that a round does not reach GitHub in one burst. */
  stagger?: number;
}

// Who still uses GitHub-derived authority without signing in to the console (#846): a person with an active Feishu binding,
// and the grantor of an enabled group binding, whose grants the group runs on. `?` is the principal.
const feishuUser = `EXISTS(SELECT 1 FROM external_identities f WHERE f.principal_id=? AND f.provider='feishu' AND f.status='active')`;
const groupGrantor = `EXISTS(SELECT 1 FROM scoped_grants g JOIN channel_service_bindings b ON b.principal_id=g.principal_id
  WHERE g.grantor_id=? AND g.policy='channel_service_binding' AND g.revoked_at IS NULL AND b.enabled=1)`;

/**
 * Keeps GitHub-derived grants proved for the people who use them (#708, #846). Every round checks again each principal with
 * a GitHub identity that can still be checked and either a live console session, an active Feishu binding, or an enabled
 * group binding they granted. Nobody else is sent to GitHub, and one who stopped qualifying while the round waited is
 * skipped. Super administrators and principals holding explicit delegation are never checked. When GitHub reports a rate
 * limit, the round stops and the next ones wait until GitHub said requests may go again.
 */
export class GitHubRefresh {
  private timer?: ReturnType<typeof setTimeout>;
  private round?: Promise<void>;
  private started = false;
  private closed = false;
  private readonly interval: number;
  private readonly concurrency: number;
  private readonly stagger: number;
  constructor(readonly store: Store, private readonly identity: () => GitHubIdentity | undefined, options: GitHubRefreshOptions = {}) {
    this.interval = options.interval ?? 10 * 60_000;
    this.concurrency = options.concurrency ?? 2;
    this.stagger = options.stagger ?? 2_000;
  }
  /** The first round runs at once, so that grants which lapsed while the control plane was down are renewed for those who use them. */
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
  /** A console session, a Feishu binding or a group binding still needs the principal's GitHub-derived grants. */
  private live(principal: string): boolean {
    return !!this.store.get(`SELECT 1 WHERE EXISTS(SELECT 1 FROM sessions WHERE user_id=? AND expires_at>?) OR ${feishuUser} OR ${groupGrantor}`,
      principal, Date.now(), principal, principal);
  }
  /** One round. Principals proved within the last half interval (at sign-in, say) wait for the next one. */
  async run(): Promise<void> {
    const identity = this.identity(), now = Date.now();
    if (!identity || identity.rateLimitedUntil > now) return;
    const due = this.store.all(`SELECT DISTINCT i.principal_id FROM external_identities i
      WHERE i.provider='github' AND i.status IN ('active','pending_verification') AND i.credentials IS NOT NULL AND i.verified_at<=?`,
    now - this.interval / 2).map(row => row.principal_id as string).filter(principal => this.live(principal) && !verificationExempt(this.store, principal));
    let next = 0, slot = now;
    const worker = async () => {
      while (next < due.length) {
        const principal = due[next++]!;
        // Each check takes the next start slot: starts are at least `stagger` apart across all workers.
        const at = Math.max(Date.now(), slot); slot = at + this.stagger;
        if (at > Date.now()) await sleep(at - Date.now());
        if (this.closed || identity.rateLimitedUntil > Date.now()) return;
        if (!this.live(principal) || verificationExempt(this.store, principal)) continue;
        await identity.renew(principal).catch(error => console.error('[github-refresh] check failed:', error));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, due.length) }, worker));
  }
}
