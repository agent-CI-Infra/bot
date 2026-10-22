/**
 * Outbound webhook dispatch (#1 answer 2/3).
 *
 * Automation rules decide. A repository can also forward selected events to a registered
 * `dispatch_targets` row — for example a maintainer laptop that runs the review with its own
 * model. The control plane keeps the queue, signs every payload, retries with backoff, and never
 * trusts a target's response body. Deliveries are recorded before they are sent, so a restart
 * cannot silently drop one.
 */

import { createHmac } from 'node:crypto';
import { randomId, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import type { DispatchRule } from './config.js';

const MAX_ATTEMPTS = 5;

export function payloadLabels(payload: Json): string[] {
  const object = payload.pull_request ?? payload.issue;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  const labels = (object as Json).labels;
  if (!Array.isArray(labels)) return [];
  return labels.map(label => label && typeof label === 'object' ? String((label as Json).name || '') : '').filter(Boolean);
}

/** `event`, `event.action` and `event.*` are the supported route patterns. */
export function matchesDispatch(rule: DispatchRule, event: string, action: string, labels: string[]): boolean {
  const route = action ? `${event}.${action}` : event;
  const routed = rule.events.some(pattern => {
    if (pattern === '*' || pattern === event || pattern === route) return true;
    if (!pattern.endsWith('.*')) return false;
    const prefix = pattern.slice(0, -1);
    return event === pattern.slice(0, -2) || route.startsWith(prefix);
  });
  if (!routed) return false;
  return rule.labels.length === 0 || rule.labels.some(label => labels.includes(label));
}

/**
 * Record one delivery per matching target. Called inside the webhook's transaction; a missing or
 * disabled target is skipped rather than failing the delivery.
 */
export function enqueueDispatches(
  store: Store,
  repositoryId: string,
  rules: readonly DispatchRule[],
  event: string,
  action: string,
  payload: Json,
  deliveryId: string,
): number {
  if (rules.length === 0) return 0;
  const labels = payloadLabels(payload), body = JSON.stringify({ event, action, repository_id: repositoryId, delivery_id: deliveryId, payload });
  let queued = 0;
  for (const rule of rules) {
    if (!matchesDispatch(rule, event, action, labels)) continue;
    if (!store.get('SELECT id FROM dispatch_targets WHERE id=? AND active=1', rule.target)) continue;
    const result = store.run(
      `INSERT OR IGNORE INTO dispatch_deliveries(id,repository_id,target_id,delivery_id,event,action,payload,state,attempts,next_attempt_at,response,created_at)
       VALUES(?,?,?,?,?,?,?,'pending',0,0,NULL,?)`,
      randomId(), repositoryId, rule.target, deliveryId, event, action, body, new Date().toISOString(),
    );
    queued += Number(result.changes);
  }
  return queued;
}

export interface DispatchRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type DispatchSender = (request: DispatchRequest) => Promise<{ status: number }>;

export const fetchDispatch: DispatchSender = async request => {
  const response = await fetch(request.url, {
    method: 'POST', headers: request.headers, body: request.body,
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status };
};

const retryAt = (attempts: number): number => Date.now() + Math.min(60_000, 5_000 * 2 ** Math.max(0, attempts - 1));

export class DispatchWorker {
  private timer: NodeJS.Timeout | undefined;
  constructor(readonly store: Store, readonly sender: DispatchSender = fetchDispatch, readonly intervalMs = 5_000) {}

  start(): void {
    if (this.timer) return;
    void this.tick().catch(() => {});
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Deliver due rows once. Returns how many rows were attempted. */
  async tick(limit = 20): Promise<number> {
    let attempted = 0;
    for (let index = 0; index < limit; index++) {
      const row = this.store.transaction(() => {
        const candidate = this.store.get(
          "SELECT id FROM dispatch_deliveries WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 1",
          Date.now(),
        );
        if (!candidate) return null;
        const claimed = this.store.run("UPDATE dispatch_deliveries SET state='inflight' WHERE id=? AND state='pending'", candidate.id);
        return Number(claimed.changes) === 1 ? this.store.get('SELECT * FROM dispatch_deliveries WHERE id=?', candidate.id) : null;
      });
      if (!row) break;
      attempted++;
      const target = this.store.get('SELECT * FROM dispatch_targets WHERE id=? AND active=1', row.target_id);
      if (!target) {
        this.store.run("UPDATE dispatch_deliveries SET state='failed', response='target_unavailable' WHERE id=?", row.id);
        continue;
      }
      let secret = '';
      try { secret = String(this.store.secrets.open(target.secret, `dispatch:${target.id}`).value || ''); } catch { /* handled below */ }
      if (!secret) {
        this.store.run("UPDATE dispatch_deliveries SET state='failed', response='target_secret_invalid' WHERE id=?", row.id);
        continue;
      }
      const route = row.action ? `${row.event}.${row.action}` : String(row.event);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Bot-Event': route,
        'X-Bot-Delivery': String(row.delivery_id),
        'X-Bot-Target': String(target.id),
        'X-Bot-Signature-256': `sha256=${createHmac('sha256', secret).update(String(row.payload)).digest('hex')}`,
      };
      try {
        const result = await this.sender({ url: String(target.url), headers, body: String(row.payload) });
        if (result.status >= 200 && result.status < 300) {
          this.store.run("UPDATE dispatch_deliveries SET state='delivered', response=? WHERE id=?", String(result.status), row.id);
        } else {
          this.retry(row, `http_${result.status}`);
        }
      } catch {
        this.retry(row, 'transport_error');
      }
    }
    return attempted;
  }

  private retry(row: Record<string, any>, response: string): void {
    const attempts = Number(row.attempts) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.store.run("UPDATE dispatch_deliveries SET state='failed', attempts=?, response=? WHERE id=?", attempts, response, row.id);
      return;
    }
    this.store.run("UPDATE dispatch_deliveries SET state='pending', attempts=?, next_attempt_at=?, response=? WHERE id=?",
      attempts, retryAt(attempts), response, row.id);
  }
}
