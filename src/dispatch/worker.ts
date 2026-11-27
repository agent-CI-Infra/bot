import { traceClean } from '../tasks/trace.js';
import type { Store, Row } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import {
  applyDecision,
  dispatchContext,
  decideImmediately,
  onDispatchEvent,
  InvalidDecision,
  dispatchLeaseMs,
  genericRefusal,
  isObjectContinuation,
  pruneFiltered,
  threadKey,
  type Decision,
  type DispatchContext,
  type CreateOption,
  dispatchHook,
} from './store.js';
import { ruleDecision } from './rules.js';
import { managerDecision } from './manager.js';

export type Decider = (store: Store, context: DispatchContext) => Promise<Decision>;
const leaseMs = dispatchLeaseMs, reportEvery = 3;
const backoff = (attempts: number) => Math.min(5000 * 3 ** Math.max(0, attempts - 1), 10 * 60000);

/**
 * Decides pending events in the background, serialized per Object Manager `thread_key` (#1122).
 * Events on the same root Issue (and its bot PR) or standalone PR run one at a time in arrival order.
 */
export class Dispatcher {
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  constructor(readonly store: Store, readonly decide: Decider = managerDecision, readonly onApplied: () => void = () => {}, readonly concurrency = 4) {}
  start() {
    // A claim counts an attempt before the decision starts (see `tick`), so an event a restart found mid-decision spent one
    // attempt without deciding anything: hand it back, or every restart would bring that event closer to being given up
    // (#476). The refund is limited to `dispatching` rows; an event already back in the queue had its refund where it lost
    // the claim, and refunding it here would subtract a round that really ran.
    this.store.run("UPDATE dispatch_events SET state='pending',lease=NULL,lease_until=NULL,attempts=max(0,attempts-1) WHERE state='dispatching'");
    onDispatchEvent(() => this.tick());
    this.timer = setInterval(() => this.tick(), 2000);
    this.tick();
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    onDispatchEvent(null);
    await Promise.allSettled([...this.running.values()]);
  }
  idle() { return Promise.allSettled([...this.running.values()]); }
  private readonly busy = new Set<string>();
  private pruned = 0;

  tick() {
    if (this.closing) return;
    if (Date.now() - this.pruned > 3600000) {
      this.pruned = Date.now();
      pruneFiltered(this.store);
    }
    const now = Date.now();
    // A thread key already starts with its repository id (`threadKey`), so the thread lookups here filter by thread_key alone:
    // adding repository_id made SQLite read every earlier event of the repository through dispatch_events_repository
    // instead of the covering dispatch_events_thread index, 3–4.5 s per tick in production (#1350).
    const due = this.store.all(
      `SELECT * FROM dispatch_events e WHERE ((e.state='pending' AND e.next_run_at<=?) OR (e.state='dispatching' AND e.lease_until<?))
       AND NOT (e.thread_key IS NOT NULL AND EXISTS (SELECT 1 FROM dispatch_events p WHERE p.thread_key=e.thread_key
         AND p.state IN ('pending','dispatching')
         AND (p.created_at<e.created_at OR (p.created_at=e.created_at AND p.rowid<e.rowid))))
       AND NOT (e.object_number IS NOT NULL AND EXISTS (SELECT 1 FROM dispatch_events p WHERE p.repository_id=e.repository_id AND p.object_type=e.object_type
         AND p.object_number=e.object_number AND p.state IN ('pending','dispatching')
         AND (p.created_at<e.created_at OR (p.created_at=e.created_at AND p.rowid<e.rowid))))
       ORDER BY e.created_at,e.rowid LIMIT 200`,
      now,
      now,
    );
    const waiting = new Set<string>();
    for (const event of due) {
      const key = threadKey(this.store, event);
      if (waiting.has(key)) continue;
      waiting.add(key);
      if (this.running.size >= this.concurrency || this.running.has(event.id) || this.busy.has(key)) continue;
      if (
        event.thread_key &&
        this.store.get(
          `SELECT 1 FROM dispatch_events WHERE thread_key=? AND state IN ('pending','dispatching')
           AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM dispatch_events WHERE id=?)))`,
          event.thread_key, event.created_at, event.created_at, event.id,
        )
      ) continue;
      if (
        event.object_number != null &&
        this.store.get(
          `SELECT 1 FROM dispatch_events WHERE repository_id=? AND object_type=? AND object_number=? AND state IN ('pending','dispatching')
           AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM dispatch_events WHERE id=?)))`,
          event.repository_id, event.object_type, event.object_number, event.created_at, event.created_at, event.id,
        )
      ) continue;
      const lease = randomId();
      const claimed = this.store.run(
        `UPDATE dispatch_events SET state='dispatching',lease=?,lease_until=?,attempts=attempts+1 WHERE id=? AND (state='pending' OR (state='dispatching' AND lease_until<?))`,
        lease, now + leaseMs, event.id, now,
      );
      if (!claimed.changes) continue;
      this.busy.add(key);
      const work = this.run(this.store.get('SELECT * FROM dispatch_events WHERE id=?', event.id)!, lease).finally(() => {
        this.running.delete(event.id);
        this.busy.delete(key);
        queueMicrotask(() => this.tick());
      });
      this.running.set(event.id, work);
    }
  }

  private async run(event: Row, lease: string) {
    try {
      const context = dispatchContext(this.store, event);
      const answering = !!event.error || !!Number(event.answer_round);
      const hasWork = context.options.length || context.continuations.length || !!event.object_number;
      const defaultTarget = event.object_type && event.object_number
        ? { type: event.object_type === 'pr' ? 'pr' as const : 'issue' as const, number: Number(event.object_number) }
        : null;
      const hasSubscriptions = Boolean(context.subscriptions?.length);
      const rawRuled = !answering && hasWork && event.type !== 'subscription.check'
        ? ruleDecision(this.store, context, (role, writes) => !genericRefusal(this.store, context, role, writes, defaultTarget))
        : null;
      const ruled = hasSubscriptions && rawRuled?.decision === 'ignore' ? null : rawRuled;
      const decision: Decision = ruled ?? (answering || (context.options.length || context.continuations.length)
        ? await this.decide(this.store, context)
        : {
            decision: 'ignore',
            option_ids: [],
            model: null,
            reason: context.unavailable.length
              ? `没有可以新建的工作，也没有可续接的任务：${[...new Set(context.unavailable.map(work => work.reason))].join(' ')}`.slice(0, 1000)
              : '没有可选的处理方式：相关工作已关闭，或可续接的任务已经结束。',
          });
      applyDecision(this.store, event, { ...decision, seen: context.continuations.map(option => option.id) }, lease);
      this.onApplied();
    } catch (error) {
      if (error instanceof InvalidDecision && error.code === 'dispatch_lease_lost') return;
      if (error instanceof InvalidDecision && error.code === 'dispatch_context_changed') {
        this.store.run("UPDATE dispatch_events SET state='pending',lease=NULL,lease_until=NULL,next_run_at=0,attempts=max(0,attempts-1) WHERE id=? AND lease=?", event.id, lease);
        return;
      }
      const code = error instanceof TaskError || error instanceof InvalidDecision ? error.code : 'dispatch_runtime_failure';
      const detail = error instanceof TaskError ? String(error.detail ?? '') : String((error as Error)?.message ?? '');
      if (!(error instanceof TaskError || error instanceof InvalidDecision)) console.error(`[dispatch] event ${event.id}: ${detail}`);
      this.store.transaction(() => {
        const current = this.store.get('SELECT * FROM dispatch_events WHERE id=? AND lease=? AND state=?', event.id, lease, 'dispatching');
        if (!current) return;
        const terminal = error instanceof TaskError && error.state === 'cancelled';
        const attempt = Number(current.attempts), next = Date.now() + backoff(attempt), report = !terminal && attempt % reportEvery === 0;
        const evidenceRef = 'dispatch_failures:' + event.id + ':' + attempt;
        const failure = traceClean({ code, detail: detail.slice(0, 2000), ...(terminal ? { terminal: true } : {}) });
        this.store.run('INSERT INTO dispatch_failures VALUES(?,?,?,?,?,?)', event.id, attempt, new Date().toISOString(), JSON.stringify(failure), next, report ? 1 : 0);
        this.store.run(
          'UPDATE dispatch_events SET state=?,lease=NULL,lease_until=NULL,next_run_at=?,error=? WHERE id=?',
          terminal ? 'failed' : 'pending',
          next,
          JSON.stringify({ ...failure, attempts: attempt, evidence_ref: evidenceRef, ...(report ? { retry_report: true } : {}) }),
          event.id,
        );
        if (report) this.store.audit('system', 'dispatch.retry_report', event.id, event.repository_id);
        if (terminal) {
          for (const option of JSON.parse(current.options) as CreateOption[]) {
            if (option.hook) dispatchHook(option.hook)?.declined(this.store, current, code, option.ref ?? null);
          }
        }
      });
    }
  }
}

export function retryEvent(store: Store, repositoryId: string, id: string) {
  return store.transaction(() => {
    const previous = store.get("SELECT attempts,error FROM dispatch_events WHERE id=? AND repository_id=? AND (state='failed' OR (state='pending' AND error IS NOT NULL AND next_run_at>0))", id, repositoryId);
    if (!previous) return false;
    const failure = previous.error ? JSON.parse(previous.error) : null;
    if (failure?.terminal === true || failure?.code === 'dispatch_cancelled') return false;
    store.run('INSERT INTO dispatch_retries(id,event_id,requested_at,previous_attempts,previous_error) VALUES(?,?,?,?,?)', randomId(), id, new Date().toISOString(), previous.attempts, previous.error);
    return store.run("UPDATE dispatch_events SET state='pending',next_run_at=0,error=NULL WHERE id=? AND repository_id=? AND (state='failed' OR (state='pending' AND error IS NOT NULL AND next_run_at>0))", id, repositoryId).changes > 0;
  });
}

/**
 * Deterministic test-only rule decider for legacy fixtures (`test/fixtures/helpers.mjs`).
 * Production never uses it.
 */
export function ruleDecider(context: DispatchContext): Decision {
  const updates = ['issue.updated', 'pull_request.updated', 'pull_request.synchronize', 'issue.mention', 'pull_request.mention', 'issue.labeled', 'pull_request.labeled'];
  const defaults = context.options.filter(option => option.default);
  const reviews = defaults.filter(option => option.work.startsWith('review.')), others = defaults.filter(option => !option.work.startsWith('review.'));
  const reviewed = (JSON.parse(String(context.event.options || '[]')) as CreateOption[]).some(option => option.default && option.work.startsWith('review.') && !context.unavailable.some(work => work.id === option.id));
  const joinable = context.continuations.filter(option => isObjectContinuation(option) && (option.status !== 'succeeded' || reviewed));
  if (updates.includes(String(context.event.type)) && joinable.length && !others.length) {
    return { decision: 'continue', option_ids: [joinable[0]!.id], reason: 'rule: update joins the review', model: 'rule' };
  }
  const chosen = [...others, ...(updates.includes(String(context.event.type)) && joinable.length ? [] : reviews)];
  const development = (context.facts as any)?.development;
  const label = development?.label ? { kind: 'label' as const, label: String(development.label), labeled_by: String(development.labeled_by ?? '') } : null;
  const developing = chosen.some(option => option.work === 'development.issue'), review = (context.facts as any)?.review ?? development?.review;
  const brief = developing ? { goal: String(review?.recommendation || review?.summary || 'Develop the change the Issue asks for').slice(0, 1500), criteria: ['The change the Issue asks for works and is tested'] } : null;
  return chosen.length
    ? { decision: 'create', option_ids: chosen.slice(0, 3).map(option => option.id), reason: 'rule: default work for this event', model: 'rule', basis: label, brief, legacyKinds: true }
    : { decision: 'ignore', option_ids: [], reason: 'rule: no default work', model: 'rule' };
}

export const configureDispatch = (decider: ((context: DispatchContext) => Decision) | null) => decideImmediately(decider);
