import type { Store, Row } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { applyDecision, dispatchContext, decideImmediately, onDispatchEvent, InvalidDecision, dispatchLeaseMs, type Decision, type DispatchContext, type CreateOption, dispatchHook } from './store.js';
import { managerDecision } from './manager.js';

export type Decider = (store: Store, context: DispatchContext) => Promise<Decision>;
const leaseMs = dispatchLeaseMs, maxAttempts = 8;
// A failed attempt waits 5 s, 15 s, 45 s … up to 10 minutes. A model that cannot be reached or is not configured is retried
// until it can; other failures (an invalid decision, a runtime fault) are marked failed for a person after eight attempts.
const backoff = (attempts: number) => Math.min(5000 * 3 ** Math.max(0, attempts - 1), 10 * 60000);

/**
 * Decides pending events in the background. Each event is claimed with a lease, decided by one Manager call and applied in
 * one transaction fenced by that lease. A restart returns claimed events to pending; deciding again cannot create a task
 * twice (see applyDecision). The Manager is called only for events that still have something to choose.
 */
export class Dispatcher {
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined; private closing = false;
  constructor(readonly store: Store, readonly decide: Decider = managerDecision, readonly onApplied: () => void = () => {}, readonly concurrency = 4) {}
  start() {
    this.store.run("UPDATE dispatch_events SET state='pending',lease=NULL,lease_until=NULL WHERE state='dispatching'");
    onDispatchEvent(() => this.tick());
    this.timer = setInterval(() => this.tick(), 2000); this.tick();
  }
  async close() { this.closing = true; if (this.timer) clearInterval(this.timer); onDispatchEvent(null); await Promise.allSettled([...this.running.values()]); }
  /** Waits for the events being decided now (tests and shutdown). */
  idle() { return Promise.allSettled([...this.running.values()]); }
  // Events of one Issue or pull request are decided one at a time, in order: a decision must see the task the previous
  // one created, or two updates arriving together would each create a review.
  private readonly busy = new Set<string>();
  tick() {
    if (this.closing) return;
    const now = Date.now(), objectKey = (event: Row) => event.object_number == null ? 'event:' + event.id : `${event.repository_id}:${event.object_type}:${event.object_number}`;
    // An expired lease (a stuck call) is taken over; the old call's apply then finds its lease gone.
    // Only an object's own turn enters the window: a due event that still has an earlier pending or dispatching event on
    // the same object cannot run, and one Issue's backlog must not fill the LIMIT and hide the other objects' work.
    const due = this.store.all(`SELECT * FROM dispatch_events e WHERE ((e.state='pending' AND e.next_run_at<=?) OR (e.state='dispatching' AND e.lease_until<?))
      AND NOT (e.object_number IS NOT NULL AND EXISTS (SELECT 1 FROM dispatch_events p WHERE p.repository_id=e.repository_id AND p.object_type=e.object_type
        AND p.object_number=e.object_number AND p.state IN ('pending','dispatching')
        AND (p.created_at<e.created_at OR (p.created_at=e.created_at AND p.rowid<e.rowid))))
      ORDER BY e.created_at,e.rowid LIMIT 200`, now, now);
    const waiting = new Set<string>();
    for (const event of due) {
      const key = objectKey(event);
      // The scan already keeps one turn per object; this keeps that turn while an earlier claim of the same tick is
      // decided, and the check below still refuses an event whose predecessor appeared after the scan.
      if (waiting.has(key)) continue; waiting.add(key);
      if (this.running.size >= this.concurrency || this.running.has(event.id) || this.busy.has(key)) continue;
      if (event.object_number != null && this.store.get(`SELECT 1 FROM dispatch_events WHERE repository_id=? AND object_type=? AND object_number=? AND state IN ('pending','dispatching')
        AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM dispatch_events WHERE id=?)))`, event.repository_id, event.object_type, event.object_number, event.created_at, event.created_at, event.id)) continue;
      const lease = randomId();
      const claimed = this.store.run(`UPDATE dispatch_events SET state='dispatching',lease=?,lease_until=?,attempts=attempts+1 WHERE id=? AND (state='pending' OR (state='dispatching' AND lease_until<?))`,
        lease, now + leaseMs, event.id, now);
      if (!claimed.changes) continue;
      this.busy.add(key);
      const work = this.run(this.store.get('SELECT * FROM dispatch_events WHERE id=?', event.id)!, lease).finally(() => { this.running.delete(event.id); this.busy.delete(key); queueMicrotask(() => this.tick()); });
      this.running.set(event.id, work);
    }
  }
  private async run(event: Row, lease: string) {
    try {
      const context = dispatchContext(this.store, event);
      // Everything it could lead to was switched off or ended meanwhile: nothing to ask.
      const decision: Decision = context.options.length || context.continuations.length ? await this.decide(this.store, context)
        : { decision: 'ignore', option_ids: [], reason: '没有可选的处理方式：相关工作已关闭，或可续接的任务已经结束。', model: null };
      applyDecision(this.store, event, { ...decision, seen: context.continuations.map(option => option.id) }, lease);
      this.onApplied();
    } catch (error) {
      if (error instanceof InvalidDecision && error.code === 'dispatch_lease_lost') return;
      // The situation changed while the Manager thought: decide again at once, without counting it as a failure.
      if (error instanceof InvalidDecision && error.code === 'dispatch_context_changed') {
        this.store.run("UPDATE dispatch_events SET state='pending',lease=NULL,lease_until=NULL,next_run_at=0,attempts=max(0,attempts-1) WHERE id=? AND lease=?", event.id, lease); return;
      }
      const code = error instanceof TaskError || error instanceof InvalidDecision ? error.code : 'dispatch_runtime_failure';
      const detail = error instanceof TaskError ? String(error.detail ?? '') : String((error as Error)?.message ?? '');
      if (!(error instanceof TaskError || error instanceof InvalidDecision)) console.error(`[dispatch] event ${event.id}: ${detail}`);
      this.store.transaction(() => {
        const current = this.store.get('SELECT * FROM dispatch_events WHERE id=? AND lease=? AND state=?', event.id, lease, 'dispatching');
        if (!current) return;
        // A model that is down or not configured is waited out, like a task waits for it; only real failures run out.
        const waiting = error instanceof TaskError && ['retry_wait', 'waiting_configuration', 'waiting_environment'].includes(String(error.state));
        const failed = !waiting && Number(current.attempts) >= maxAttempts;
        this.store.run('UPDATE dispatch_events SET state=?,lease=NULL,lease_until=NULL,next_run_at=?,error=? WHERE id=?', failed ? 'failed' : 'pending',
          Date.now() + backoff(Number(current.attempts)), JSON.stringify({ code, detail: detail.slice(0, 600) }), event.id);
        // A module waiting for the outcome (a release observation, a gate turn) stops waiting when no decision will come.
        if (failed) for (const option of JSON.parse(current.options) as CreateOption[]) if (option.hook) dispatchHook(option.hook)?.declined(this.store, current, 'dispatch_failed', option.ref ?? null);
      });
    }
  }
}

/** Retries a failed event now (a person pressed retry). */
export function retryEvent(store: Store, repositoryId: string, id: string) {
  return store.run("UPDATE dispatch_events SET state='pending',attempts=0,next_run_at=0,error=NULL WHERE id=? AND repository_id=? AND state='failed'", id, repositoryId).changes > 0;
}

/**
 * The deterministic decision of the control plane before #207, for tests that exercise everything after dispatch: an
 * update joins a running review, otherwise the options the old triggers created are created. Production never uses it.
 */
export function ruleDecider(context: DispatchContext): Decision {
  const updates = ['issue.updated', 'pull_request.updated', 'issue.mention', 'pull_request.mention', 'issue.labeled', 'pull_request.labeled'];
  const defaults = context.options.filter(option => option.default);
  const reviews = defaults.filter(option => option.work.startsWith('review.')), others = defaults.filter(option => !option.work.startsWith('review.'));
  if (updates.includes(String(context.event.type)) && context.continuations.length && !others.length)
    return { decision: 'continue', option_ids: [context.continuations[0]!.id], reason: 'rule: update joins the running review', model: 'rule' };
  const chosen = [...others, ...(updates.includes(String(context.event.type)) && context.continuations.length ? [] : reviews)];
  return chosen.length ? { decision: 'create', option_ids: chosen.slice(0, 3).map(option => option.id), reason: 'rule: default work for this event', model: 'rule' }
    : { decision: 'ignore', option_ids: [], reason: 'rule: no default work', model: 'rule' };
}
/** Tests decide synchronously with the rule decider (or another one); null restores Manager dispatch. */
export const configureDispatch = (decider: ((context: DispatchContext) => Decision) | null) => decideImmediately(decider);
