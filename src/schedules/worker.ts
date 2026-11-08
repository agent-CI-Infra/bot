import type { Row } from '../storage/database.js';
import { authorize, resolvePrincipalActor } from '../identity/authorization.js';
import { fail, HttpError, randomId, type Json } from '../core/security.js';
import { workflowActive } from '../workflows/resolve.js';
import { ChannelRateLimitError } from '../channels/feishu.js';
import { parameterHash } from '../management/service.js';
import { ScheduleService, reasonOf } from './service.js';
import { nextTime, quietUntil } from './time.js';
import { categoryOf, concurrencyAvailable, notificationSlot, reserve, budgetScopes, terminalRunStates } from './budget.js';
import type { ControlledTrigger, Plan, SubscriptionSpec } from './types.js';

export interface NotificationTransport {
  send(row: Row, guard: () => void): Promise<string>;
  reconcile?(row: Row, guard: () => void): Promise<string | null>;
}
/** The timer only wakes a durable queue. Every due time, claim, cursor and attempt lives in SQLite. */
export class Scheduler {
  readonly worker = randomId();
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;
  constructor(readonly service: ScheduleService, readonly transport?: NotificationTransport) {}
  get store() { return this.service.store; }
  start(): void { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.timer.unref(); }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.active; }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.work().finally(() => { this.active = undefined; }); return this.active;
  }
  private async work(): Promise<void> {
    this.produce(); this.fanout();
    for (let i = 0; i < 20 && !this.stopped; i++) { const claim = this.claimOccurrence(); if (!claim) break; this.dispatch(claim); }
    for (let i = 0; i < 20 && !this.stopped; i++) { const claim = this.claimNotification(); if (!claim) break; await this.send(claim); }
  }
  produce(): void {
    const now = this.service.clock();
    this.store.transaction(() => {
      for (const row of this.store.all(`SELECT o.* FROM schedule_occurrences o JOIN schedule_business_runs b ON b.occurrence_id=o.id WHERE b.state NOT IN ${terminalRunStates}`)) {
        const plan = JSON.parse(row.snapshot).plan as Plan;
        if (now - row.started_at >= Math.min(...budgetScopes(this.store, row, plan).map(s => s.limits.runtime_ms))) {
          this.store.run("UPDATE schedule_business_runs SET state='budget_exhausted' WHERE occurrence_id=?", row.id);
          this.finishOccurrence(row, 'budget_exhausted', 'runtime_budget_exhausted');
        }
      }
      // Check active plans even before their next due time so revocation is observable promptly.
      for (const row of this.store.all("SELECT * FROM schedules WHERE state='active' ORDER BY next_at,id")) {
        const plan = JSON.parse(row.spec) as Plan;
        try { this.service.actor(row, plan); } catch (error) { this.service.pause(row, reasonOf(error)); continue; }
        if (row.next_at === null) { this.store.run("UPDATE schedules SET state='expired',reason='validity_ended',revision=revision+1 WHERE id=?", row.id); continue; }
        if (row.next_at > now) continue;
        const late = now - row.next_at, missed = late > plan.grace_ms || plan.misfire === 'skip' && late >= 60000;
        this.service.occurrence(row, 'time:' + row.next_at, row.next_at, 'timer', missed ? 'skipped' : 'pending', missed ? 'misfire' : undefined);
        // One due cursor per tick, then jump to the future. Never enumerate an unbounded history.
        this.store.run('UPDATE schedules SET next_at=?,updated_at=? WHERE id=?', nextTime(plan, now), now, row.id);
      }
    });
  }
  claimOccurrence(): Row | null {
    const now = this.service.clock();
    return this.store.transaction(() => {
      for (const row of this.store.all("SELECT * FROM schedule_occurrences WHERE (state IN ('pending','retry') AND next_attempt<=?) OR (state='running' AND lease_until<=?) ORDER BY logical_at,id LIMIT 100", now, now)) {
        const plan = JSON.parse(row.snapshot).plan as Plan;
        const schedule = this.store.get('SELECT * FROM schedules WHERE id=?', row.schedule_id);
        if (!schedule || schedule.state !== 'active') { this.finishOccurrence(row, 'blocked', 'schedule_not_active'); continue; }
        try { this.service.actor({ ...schedule, grant_snapshot: JSON.stringify(JSON.parse(row.authorization).grant_snapshot) }, plan); }
        catch (error) { this.service.pause(schedule, reasonOf(error)); this.finishOccurrence(row, 'blocked', reasonOf(error)); continue; }
        const limits = budgetScopes(this.store, row, plan), runtime = Math.min(...limits.map(s => s.limits.runtime_ms)), maxRetries = Math.min(...limits.map(s => s.limits.retries));
        if (row.started_at !== null && now - row.started_at >= runtime) { this.finishOccurrence(row, 'budget_exhausted', 'runtime_budget_exhausted'); continue; }
        if (row.attempts >= maxRetries + 1) { this.finishOccurrence(row, 'dead', 'retry_budget_exhausted'); continue; }
        // An expired claim still consumes a slot until this transaction reclaims it.
        if (row.state !== 'running' && !concurrencyAvailable(this.store, row, plan)) continue;
        const lease = this.worker + ':' + randomId();
        this.store.run("UPDATE schedule_occurrences SET state='running',lease=?,lease_until=?,attempts=attempts+1,started_at=coalesce(started_at,?) WHERE id=?",
          lease, now + Math.min(30000, runtime), now, row.id);
        return this.store.get('SELECT * FROM schedule_occurrences WHERE id=?', row.id)!;
      }
      return null;
    });
  }
  dispatch(claim: Row): void {
    try {
      this.store.transaction(() => {
        const row = this.store.get("SELECT * FROM schedule_occurrences WHERE id=? AND lease=? AND state='running' AND lease_until>?", claim.id, claim.lease, this.service.clock());
        if (!row) return;
        const snapshot = JSON.parse(row.snapshot), plan = snapshot.plan as Plan;
        const schedule = this.store.get('SELECT * FROM schedules WHERE id=?', row.schedule_id)!;
        const guard = () => {
          const current = this.store.get('SELECT state FROM schedules WHERE id=?', row.schedule_id);
          if (current?.state !== 'active') fail(403, 'schedule_not_active');
          this.service.actor({ ...schedule, grant_snapshot: JSON.stringify(JSON.parse(row.authorization).grant_snapshot) }, plan);
          const runtime = Math.min(...budgetScopes(this.store, row, plan).map(s => s.limits.runtime_ms));
          if (this.service.clock() - row.started_at >= runtime) fail(409, 'runtime_budget_exhausted');
        };
        guard(); const actor = this.service.actor(schedule, plan);
        const existing = this.store.get('SELECT * FROM schedule_business_runs WHERE occurrence_id=?', row.id);
        if (existing) { this.finishOccurrence(row, ['queued', 'running'].includes(existing.state) ? 'dispatched' : existing.state, null, JSON.parse(existing.result ?? '{}')); return; }
        let result: Json;
        if (plan.workflow === 'report.daily') {
          reserve(this.store, row, plan, this.service.clock(), 'runs'); guard();
          const report = this.service.reports.render(row.project_id, row.logical_at, plan.timezone, Number(plan.parameters.window_ms ?? 86400000));
          result = { report, business_state: 'succeeded' };
        } else {
          const handler = this.service.handlers.get(plan.workflow);
          if (!handler) { this.finishOccurrence(row, 'unsupported', 'trigger_handler_not_registered'); return; }
          if (!workflowActive(this.store, row.project_id, plan.workflow)) fail(403, 'schedule_workflow_gate_closed');
          authorize(actor, handler.capability, { project_id: row.project_id });
          reserve(this.store, row, plan, this.service.clock(), 'runs');
          const trigger: ControlledTrigger = { occurrence_id: row.id, run_id: row.run_id, project_id: row.project_id, tenant_id: row.tenant_id,
            workflow: plan.workflow, parameters: plan.parameters, logical_at: row.logical_at, source: row.source,
            authorization_revision: actor.authorization_revision, config: snapshot.config };
          const dispatched = handler.dispatch(trigger, actor, guard);
          if (dispatched instanceof Promise || dispatched.run_id !== row.run_id || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(dispatched.state)) fail(500, 'trigger_requires_transactional_dispatch');
          // Persist the downstream run identifier; a dispatched business run is not a completed workflow.
          result = { ...dispatched, business_state: dispatched.state };
        }
        guard();
        this.store.run('INSERT INTO schedule_business_runs VALUES(?,?,?,?,?,?,?)', row.run_id, row.id, plan.workflow, categoryOf(plan), String(result.business_state), JSON.stringify(result), this.service.clock());
        if (result.report) {
          this.store.run('INSERT OR IGNORE INTO schedule_events(event_key,project_id,type,incident,payload,created_at) VALUES(?,?,\'project.daily\',?,?,?)', 'report:' + row.id, row.project_id, 'report:' + row.id, JSON.stringify({ occurrence_id: row.id, report: result.report }), this.service.clock());
          this.enqueue({ tenant_id: row.tenant_id, project_id: row.project_id, destination_id: plan.destination_id,
          schedule_id: row.schedule_id, occurrence_id: row.id, actor_id: plan.actor_id, authorization: row.authorization,
          logical_key: 'report:' + row.id, incident: 'report:' + row.id, payload: { text: (result.report as Json).text, report: result.report }, next_attempt: this.service.clock() });
        }
        const state = ['queued', 'running'].includes(String(result.business_state)) ? 'dispatched' : String(result.business_state);
        this.finishOccurrence(row, state, null, { ...result, scheduler_run_id: row.run_id });
        if (state === 'succeeded') this.store.run('UPDATE schedules SET last_success=? WHERE id=?', this.service.clock(), schedule.id);
      });
    } catch (error) {
      this.store.transaction(() => {
        const row = this.store.get("SELECT * FROM schedule_occurrences WHERE id=? AND lease=? AND state='running'", claim.id, claim.lease);
        if (!row) return;
        const reason = reasonOf(error), exhausted = ['schedule_budget_exhausted', 'runtime_budget_exhausted'].includes(reason);
        const retry = !(error instanceof HttpError) || error.status >= 500;
        this.finishOccurrence(row, exhausted ? 'budget_exhausted' : retry ? 'retry' : 'blocked', reason);
        if (retry) this.store.run('UPDATE schedule_occurrences SET next_attempt=? WHERE id=?', this.service.clock() + Math.min(3600000, 1000 * 2 ** row.attempts), row.id);
      });
    }
  }
  private finishOccurrence(row: Row, state: string, reason?: string | null, result?: Json): void {
    this.store.run('UPDATE schedule_occurrences SET state=?,reason=?,result=?,finished_at=?,lease=NULL,lease_until=0 WHERE id=?', state, reason ?? null, result ? JSON.stringify(result) : row.result ?? null, this.service.clock(), row.id);
    this.service.audit({ ...row, actor_id: JSON.parse(row.authorization).actor_id, creator_id: JSON.parse(row.authorization).initiator }, 'occurrence.' + state, null, row.source,
      { occurrence_id: row.id, run_id: row.run_id, reason, attempt: row.attempts });
  }
  enqueue(input: Row): string {
    const id = 'msg_' + parameterHash(input.logical_key);
    this.store.run(`INSERT OR IGNORE INTO notification_outbox(id,tenant_id,project_id,destination_id,schedule_id,occurrence_id,subscription_id,subscription_revision,
      actor_id,authorization,logical_key,incident,parent_id,payload,state,next_attempt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, id,
      input.tenant_id, input.project_id, input.destination_id, input.schedule_id ?? null, input.occurrence_id ?? null, input.subscription_id ?? null, input.subscription_revision ?? null,
      input.actor_id, input.authorization, input.logical_key, input.incident, input.parent_id ?? null, JSON.stringify(input.payload), input.next_attempt, this.service.clock());
    return id;
  }
  fanout(): void {
    const now = this.service.clock();
    for (const sub of this.store.all("SELECT * FROM notification_subscriptions WHERE state='active'")) this.store.transaction(() => {
      const current = this.store.get("SELECT * FROM notification_subscriptions WHERE id=? AND state='active'", sub.id); if (!current) return;
      const spec = JSON.parse(current.spec) as SubscriptionSpec;
      let authorization: Json;
      try {
        this.service.executionScope(sub.project_id); this.service.destination(spec.destination_id, sub.project_id);
        const actor = resolvePrincipalActor(this.store, sub.principal_id, sub.tenant_id, sub.project_id, 'service');
        authorize(actor, 'schedules.manage', { project_id: sub.project_id }); authorize(actor, 'tasks.read', { project_id: sub.project_id });
        authorization = { initiator: sub.principal_id, actor_id: actor.principal_id, authorization_revision: actor.authorization_revision, subscription_revision: sub.revision };
      } catch (error) { this.store.run("UPDATE notification_subscriptions SET state='paused',reason=?,revision=revision+1 WHERE id=?", reasonOf(error), sub.id); return; }
      for (const event of this.store.all('SELECT * FROM schedule_events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT 500', sub.project_id, current.event_cursor)) {
        if (spec.events.includes(event.type)) {
          const original = this.store.get('SELECT * FROM notification_outbox WHERE subscription_id=? AND incident=? ORDER BY created_at,id LIMIT 1', sub.id, event.incident);
          // Ignore a success without a failure in this subscription; it is not a recovery notification.
          if (event.type !== 'ci.recovered' || original) {
            const key = `sub:${sub.id}:${sub.revision}:${event.incident}:${spec.aggregate_ms ? Math.floor(event.created_at / Math.max(1, spec.aggregate_ms)) : 'incident'}:${event.type === 'ci.recovered' ? 'recovery' : 'failure'}`;
            const pending = this.store.get('SELECT * FROM notification_outbox WHERE logical_key=?', key);
            const previous = pending ? JSON.parse(pending.payload) : { events: [], text: '' };
            const events = [...previous.events, { sequence: event.sequence, type: event.type, evidence: JSON.parse(event.payload), at: event.created_at }];
            const repo = this.store.get('SELECT full_name FROM repositories WHERE id=?', sub.project_id)!.full_name;
            const payload = { events, text: `${repo} · ${event.type}\n关联：${event.incident}\n聚合观测 ${events.length} 条；${spec.timezone}\n${events.filter(e => e.evidence.report).map(e => e.evidence.report.text).join('\n')}\n来源：${events.map(e => this.eventUrl(sub.project_id, e)).join('\n')}\n解除订阅：${(this.service.channels.options.origin ?? '') + '/#/management'}（订阅 ${sub.id}）` };
            if (pending && ['pending', 'retry'].includes(pending.state)) this.store.run('UPDATE notification_outbox SET payload=? WHERE id=?', JSON.stringify(payload), pending.id);
            else if (!pending) this.enqueue({ tenant_id: sub.tenant_id, project_id: sub.project_id, destination_id: spec.destination_id, subscription_id: sub.id,
              subscription_revision: sub.revision, actor_id: sub.principal_id, authorization: JSON.stringify(authorization),
              logical_key: key, incident: event.incident, parent_id: original?.id, payload,
              next_attempt: quietUntil(spec, Math.max(now, event.created_at + spec.aggregate_ms)) });
          }
        }
        this.store.run('UPDATE notification_subscriptions SET event_cursor=? WHERE id=?', event.sequence, sub.id);
      }
    });
  }
  private eventUrl(project: string, event: any): string {
    const p = event.evidence, origin = this.service.channels.options.origin ?? '';
    if (p.occurrence_id) return origin + '/#/management';
    if (p.task_id) return origin + '/#/projects/' + project + '/activity?task=' + p.task_id;
    if (p.command_id) return origin + '/api/management/commands/' + p.command_id;
    const repo = this.store.get('SELECT full_name FROM repositories WHERE id=?', project)!.full_name;
    return 'https://github.com/' + repo + '/actions' + (p.run_id ? '/runs/' + p.run_id : '');
  }
  claimNotification(): Row | null {
    const now = this.service.clock();
    return this.store.transaction(() => {
      // A crashed sender may already have crossed the network boundary. Never blindly resend.
      for (const stale of this.store.all("SELECT * FROM notification_outbox WHERE state='sending' AND lease_until<=?", now)) {
        this.store.run("UPDATE notification_outbox SET state='unknown',last_error='sender_lease_expired',lease=NULL WHERE id=?", stale.id);
        this.store.run("UPDATE notification_attempts SET state='unknown',error='sender_lease_expired',finished_at=? WHERE outbox_id=? AND attempt=?", now, stale.id, stale.attempts);
      }
      for (const row of this.store.all("SELECT * FROM notification_outbox WHERE state IN ('pending','retry') AND next_attempt<=? ORDER BY next_attempt,id LIMIT 100", now)) {
        let authorization: Json;
        try { const actor = this.service.deliveryGuard(row); authorization = { actor_id: actor.principal_id, authorization_revision: actor.authorization_revision, initiator: JSON.parse(row.authorization).initiator }; }
        catch (error) { this.store.run("UPDATE notification_outbox SET state='blocked',last_error=? WHERE id=?", reasonOf(error), row.id); continue; }
        const connector = this.service.destination(row.destination_id, row.project_id).event.connector_id;
        const platformWait = this.store.get('SELECT next_at FROM notification_channel_limits WHERE connector_id=?', connector)?.next_at ?? 0;
        if (platformWait > now) { this.store.run("UPDATE notification_outbox SET next_attempt=?,last_error='platform_rate_limited' WHERE id=?", platformWait, row.id); continue; }
        const plan = this.service.notificationPlan(row), scopes = budgetScopes(this.store, { ...row, schedule_id: row.schedule_id ?? row.subscription_id }, plan);
        const maxRetries = Math.min(...scopes.map(s => s.limits.retries));
        if (row.attempts >= maxRetries + 1 + row.manual_retries) { this.store.run("UPDATE notification_outbox SET state='dead',last_error='notification_retry_budget_exhausted' WHERE id=?", row.id); continue; }
        if (row.subscription_id) {
          const spec = JSON.parse(this.store.get('SELECT spec FROM notification_subscriptions WHERE id=?', row.subscription_id)!.spec);
          const quiet = quietUntil(spec, now); if (quiet > now) { this.store.run('UPDATE notification_outbox SET next_attempt=? WHERE id=?', quiet, row.id); continue; }
        }
        if (!notificationSlot(this.store, { ...row, schedule_id: row.schedule_id ?? row.subscription_id }, plan, now)) { this.store.run("UPDATE notification_outbox SET next_attempt=?,last_error='notification_rate_limited' WHERE id=?", (Math.floor(now / 60000) + 1) * 60000, row.id); continue; }
        const lease = this.worker + ':' + randomId();
        this.store.run("UPDATE notification_outbox SET state='sending',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?", lease, now + 60000, row.id);
        this.store.run("INSERT INTO notification_attempts(outbox_id,attempt,worker,state,started_at,authorization) VALUES(?,?,?,'sending',?,?)", row.id, row.attempts + 1, this.worker, now, JSON.stringify(authorization));
        return this.store.get('SELECT * FROM notification_outbox WHERE id=?', row.id)!;
      }
      return null;
    });
  }
  async send(row: Row): Promise<void> {
    let timedOut = false;
    const guard = () => {
      if (this.stopped || timedOut || !this.store.get("SELECT 1 FROM notification_outbox WHERE id=? AND lease=? AND state='sending' AND lease_until>?", row.id, row.lease, this.service.clock())) fail(403, 'notification_lease_lost');
      this.service.deliveryGuard(row);
    };
    let state = 'sent', reason: string | null = null, remote: string | null = null, next = this.service.clock();
    try {
      guard();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        remote = await Promise.race([this.transport?.send(row, guard) ?? this.sendChannel(row, guard), new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { timedOut = true; reject(new Error('notification_timeout')); }, 20000); timeout.unref();
        })]);
      } finally { clearTimeout(timeout); }
    } catch (error) {
      reason = error instanceof HttpError ? error.code : timedOut ? 'notification_timeout' : 'notification_result_unknown';
      if (reason === 'channel_rate_limited' || reason === 'channel_delivery_rejected') {
        state = 'retry'; next += Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 12));
        if (reason === 'channel_rate_limited') {
          next = Math.max(next, this.service.clock() + (error instanceof ChannelRateLimitError ? error.retryAfterMs : 1000));
          const registration = this.store.get('SELECT connector_id FROM channel_outbox WHERE id=?', row.destination_id);
          if (registration) this.store.run('INSERT INTO notification_channel_limits VALUES(?,?) ON CONFLICT(connector_id) DO UPDATE SET next_at=max(next_at,excluded.next_at)', registration.connector_id, next);
        }
      } else if (error instanceof HttpError && error.status < 500) state = 'blocked';
      else state = 'unknown';
    }
    if (this.stopped) return;
    this.store.transaction(() => {
      const current = this.store.get("SELECT 1 FROM notification_outbox WHERE id=? AND lease=? AND state='sending'", row.id, row.lease); if (!current) return;
      this.store.run('UPDATE notification_outbox SET state=?,last_error=?,remote_message_id=?,next_attempt=?,lease=NULL,lease_until=0,sent_at=? WHERE id=?', state, reason, remote, next, state === 'sent' ? this.service.clock() : null, row.id);
      this.store.run('UPDATE notification_attempts SET state=?,error=?,finished_at=? WHERE outbox_id=? AND attempt=?', state, reason, this.service.clock(), row.id, row.attempts);
      this.service.audit({ ...row, revision: row.subscription_revision ?? 0 }, 'notification.' + state, null, row.logical_key, { attempt: row.attempts, occurrence_id: row.occurrence_id, remote_message_id: remote, reason });
    });
  }
  private async sendChannel(row: Row, guard: () => void): Promise<string> {
    const { event } = this.service.destination(row.destination_id, row.project_id), c = this.service.channels.connector(event.connector_id);
    const payload = JSON.parse(row.payload), parent = row.parent_id ? this.store.get('SELECT remote_message_id FROM notification_outbox WHERE id=?', row.parent_id) : null;
    const content = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: String(payload.text).slice(0, 12000) + (parent?.remote_message_id ? '\n原通知：' + parent.remote_message_id : '') } }] };
    return this.service.channels.adapter(c, guard).send({ receive_id: event.chat_type === 'p2p' ? event.actor_id : event.chat_id, receive_id_type: event.chat_type === 'p2p' ? 'open_id' : 'chat_id', content }, row.id);
  }
  async reconcile(id: string): Promise<Json> {
    const row = this.store.get("SELECT * FROM notification_outbox WHERE id=? AND state='unknown'", id);
    if (!row) return fail(409, 'notification_not_unknown');
    const guard = () => this.service.deliveryGuard(row!); guard();
    const remote = await this.transport?.reconcile?.(row!, guard);
    if (remote) this.store.run("UPDATE notification_outbox SET state='sent',remote_message_id=?,sent_at=?,last_error=NULL WHERE id=? AND state='unknown'", remote, this.service.clock(), id);
    return { id, state: remote ? 'sent' : 'unknown', reconcile_supported: !!this.transport?.reconcile };
  }
}
