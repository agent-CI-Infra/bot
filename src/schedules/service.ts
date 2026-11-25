import type { Store, Row } from '../storage/database.js';
import { authorize, createProjectServicePrincipal, listEffectiveScopes, narrowActor, resolvePrincipalActor, resolveServiceActor, type ActorContext } from '../identity/authorization.js';
import { fail, HttpError, randomId, type Json } from '../core/security.js';
import { installationExecutionDenied } from '../installations/archive.js';
import type { ChannelService } from '../channels/service.js';
import type { ChannelEvent } from '../channels/types.js';
import { chatProfile } from '../channels/profiles.js';
import type { ManagementCommand, ManagementService } from '../management/service.js';
import { parameterHash } from '../management/service.js';
import { validate } from '../management/catalog.js';
import { planSchema, schedulingCommands, subscriptionSchema } from './schema.js';
import { localParts, nextTime, parseCron, previewTimes, quietUntil } from './time.js';
import { defaultLimits, type Plan, type SubscriptionSpec, type TriggerHandler, type ActionUsage } from './types.js';
import { budgetScopes, notificationWorkflow, reserve, terminalRunStates } from './budget.js';

export const reasonOf = (e: unknown): string => e instanceof HttpError ? e.code : 'schedule_service_failed';
const missingServiceIdentity = 'actor_id is not a service identity of this project, and a project plan runs as one. For a new project plan pass actor_id "auto": '
  + 'schedule.register then uses the project\'s service identity or, when it has none, creates one holding the project capabilities you hold; '
  + 'preview_schedule previews "auto" the same way without creating anything. list_schedule_destinations lists the existing ones as services.';
/** A preview run inside a savepoint that is rolled back: the identity "auto" would create is checked, then undone (#1362). */
class Rehearsal extends Error { constructor(readonly plan: Plan) { super('schedule_preview_rehearsal'); } }
export class ScheduleService {
  readonly handlers = new Map<string, TriggerHandler>();
  constructor(readonly store: Store, readonly management: ManagementService, readonly channels: ChannelService, readonly clock: () => number = Date.now) {
    for (const operation of Object.keys(schedulingCommands)) management.register(operation, {
      execute: async (actor, command, key) => this.command(actor, command, key),
      reconcile: async (actor, command, key) => {
        const row = store.get('SELECT result FROM schedule_operations WHERE effect_key=? AND project_id=?', key, command.target.project_id);
        // These effects are entirely local: absence of a committed effect receipt proves no write
        // committed. Re-entering the idempotent transaction is safe after checking its revision.
        return row ? JSON.parse(row.result) : this.command(actor, command, key);
      },
    });
    management.schedulingQuery = (actor, operation, project, args) => this.query(actor, operation, project, args);
  }
  register(workflow: string, handler: TriggerHandler): void {
    if (this.handlers.has(workflow) || !handler.capability) throw new Error('invalid_trigger_registration');
    this.handlers.set(workflow, handler);
  }
  /** A project plan runs a registered handler: in production only the project scheduled task, manager.check (#1027). A plan
   * saved for a workflow that has none, such as a retired daily report, can no longer be saved, resumed or run. */
  private required(workflow: string): string[] {
    const handler = this.handlers.get(workflow);
    if (!handler) return fail(409, 'schedule_workflow_unsupported');
    return ['tasks.read', 'schedules.manage', handler.capability];
  }
  audit(row: Row, action: string, actor: ActorContext | null, source: string, detail: Json = {}): void {
    const authorization = typeof row.authorization === 'string' ? JSON.parse(row.authorization) : {};
    const execution = row.actor_id ?? actor?.principal_id ?? authorization.actor_id;
    const initiator = actor && !action.startsWith('action.') ? actor.principal_id : authorization.initiator ?? row.creator_id ?? execution;
    const authorizationRevision = execution === actor?.principal_id ? actor!.authorization_revision : row.authorization_revision ?? authorization.authorization_revision ?? 0;
    this.store.run(`INSERT INTO schedule_audit(project_id,resource_id,initiator,actor_id,authorization_revision,revision,source,action,detail,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, row.project_id, row.id, initiator, execution, authorizationRevision, row.revision ?? 0, source, action, JSON.stringify(detail), this.clock());
  }
  destination(id: string, project: string): { row: Row; event: ChannelEvent } {
    const row = this.store.get('SELECT * FROM channel_outbox WHERE id=? AND state=\'registered\'', id);
    if (!row) return fail(403, 'schedule_destination_unavailable');
    const payload = this.store.secrets.open(row.payload, 'channel-outbox:' + row.id), protection = payload.protection as Json;
    if (!protection || protection.project_id !== project) fail(403, 'schedule_destination_project_mismatch');
    const event = payload.event as unknown as ChannelEvent;
    this.channels.source(event);
    const tenant = this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)?.tenant_id;
    if (!tenant) fail(403, 'schedule_destination_project_mismatch');
    if (event.chat_type === 'group') this.channels.groupDestination(event, project);
    else {
      // A recipient's present read access is separate from a service schedule's execution rights.
      const recipient = resolvePrincipalActor(this.store, String(protection.principal_id), tenant, project, 'service');
      authorize(recipient, 'tasks.read', { project_id: project });
      if (!this.store.get(`SELECT 1 FROM external_identities WHERE principal_id=? AND provider='feishu' AND connector=?
        AND external_tenant=? AND external_actor=? AND status='active'`, recipient.principal_id, event.connector_id + ':' + event.app_id, event.actor_tenant, event.actor_id)) fail(403, 'schedule_destination_binding_revoked');
    }
    return { row, event };
  }
  private grants(actor: ActorContext, plan: Plan, project: string, existing?: Row): Row {
    const required = this.required(plan.workflow);
    if (plan.kind === 'personal') {
      if (plan.actor_id !== actor.principal_id || plan.owner_id !== actor.principal_id || plan.maintainer_id !== actor.principal_id) fail(403, 'personal_schedule_identity_mismatch');
      return { approver_id: null, capabilities: required, grants: listEffectiveScopes(this.store, actor.principal_id).filter(g => g.state === 'active') };
    }
    // Project plans run as the project's service identity; its administrators (config.write) set them up (#851).
    authorize(actor, 'config.write', { project_id: project });
    const principal = this.store.get("SELECT * FROM principals WHERE id=? AND kind='service' AND project_id=?", plan.actor_id, project);
    // #1362: an actor_id that is no service identity of this project is a missing identity, not a paused one. Reported as
    // service_paused, the assistant told people the scheduling service was paused. 409: the console's schedule panel reads a
    // 403 as its own access being lost.
    if (!principal) return fail(409, 'project_service_identity_missing', 'actor_id', { message: missingServiceIdentity });
    if (!principal.maintenance) return fail(403, 'service_paused');
    // An existing owner is an immutable audit reference, not the current maintenance authority.
    const people: [string, string][] = existing ? [['maintainer', plan.maintainer_id]] : [['owner', plan.owner_id], ['maintainer', plan.maintainer_id]];
    for (const [role, id] of people) {
      const person = this.store.get("SELECT 1 FROM principals p JOIN users u ON p.user_id=u.id WHERE p.id=? AND p.kind='human' AND p.active=1 AND u.active=1", id);
      if (!person) fail(403, 'schedule_' + role + '_required');
      try { authorize(resolvePrincipalActor(this.store, id, principal.tenant_id, project), 'schedules.manage', { project_id: project }); }
      catch { return fail(403, 'schedule_' + role + '_required'); }
    }
    const grants = listEffectiveScopes(this.store, plan.actor_id).filter(g => g.state === 'active' && g.scope === 'project' && g.project_id === project && g.source === 'explicit_delegation' &&
      !!this.store.get('SELECT grantor_id FROM scoped_grants WHERE id=? AND grantor_id IS NOT NULL', g.grant_id));
    if (required.some(c => !grants.some(g => g.capabilities.includes(c)))) fail(403, 'schedule_service_delegation_required');
    return { approver_id: actor.principal_id, grants: grants.map(g => ({ ...g, grantor_id: this.store.get('SELECT grantor_id FROM scoped_grants WHERE id=?', g.grant_id)!.grantor_id })), capabilities: required };
  }
  /** The plan's execution identity, narrowed to what it was approved for. Project plans have no Feishu destination (#1027),
   * so a chat's binding or audience never pauses one: its results stay in the project's task records and on GitHub. */
  actor(row: Row, plan: Plan): ActorContext {
    const required = this.required(plan.workflow);
    const actor = plan.kind === 'project' ? resolveServiceActor(this.store, plan.actor_id) : resolvePrincipalActor(this.store, plan.actor_id, row.tenant_id, row.project_id, 'service');
    const approved = JSON.parse(row.grant_snapshot);
    if (required.some(c => !(approved.capabilities as string[]).includes(c))) fail(403, 'schedule_capability_changed');
    if (plan.kind === 'project') {
      const principal = this.store.get('SELECT project_id,tenant_id FROM principals WHERE id=?', plan.actor_id)!;
      if (principal.project_id !== row.project_id || principal.tenant_id !== row.tenant_id) fail(403, 'schedule_service_scope_changed');
      const current = listEffectiveScopes(this.store, plan.actor_id);
      for (const g of approved.grants ?? []) {
        const actual = current.find(c => c.grant_id === g.grant_id && c.state === 'active' && c.project_id === row.project_id && c.source === 'explicit_delegation');
        if (!actual || parameterHash(actual.capabilities) !== parameterHash(g.capabilities) || actual.verified_at !== g.verified_at || actual.expires_at !== g.expires_at) fail(403, 'schedule_service_delegation_changed');
      }
      // A handover changes the maintainer explicitly, never the service's granted capabilities.
      const maintainer = resolvePrincipalActor(this.store, plan.maintainer_id, row.tenant_id, row.project_id, 'service');
      authorize(maintainer, 'schedules.manage', { project_id: row.project_id });
    }
    authorize(actor, 'schedules.manage', { project_id: row.project_id });
    authorize(actor, 'tasks.read', { project_id: row.project_id });
    authorize(actor, required[2]!, { project_id: row.project_id });
    this.executionScope(row.project_id);
    return narrowActor(actor, required);
  }
  executionScope(project: string): void {
    const p = this.store.get('SELECT r.*,p.enabled FROM repositories r JOIN policies p ON p.repository_id=r.id WHERE r.id=?', project);
    if (!p?.enabled) fail(403, 'schedule_project_disabled');
    if (installationExecutionDenied(this.store, p!.account_id, project) || !this.store.get('SELECT 1 FROM installed_repositories WHERE account_id=? AND repository_id=? AND installed=1', p!.account_id, project)) fail(403, 'schedule_installation_unavailable');
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', p!.account_id);
    if (!account) return fail(403, 'schedule_account_unavailable');
    const credential = this.store.secrets.open(account.credentials, 'account:' + account.id);
    if (!credential.token && !credential.private_key) fail(403, 'schedule_account_credentials_revoked');
  }
  /** Business handlers persist occurrence_id with their run and call this again before each tool or
   * model action, including after restart. No creator session or login token is needed. Costs are
   * reserved before calling a model; unknown prices must fail in the caller rather than count as zero. */
  authorizeAction(occurrenceId: string, capability: string, usage: ActionUsage = {}): ActorContext {
    for (const [key, value] of Object.entries(usage)) if (!['model_calls', 'cost_micros'].includes(key) || !Number.isSafeInteger(value) || value < 0) fail(400, 'invalid_schedule_usage');
    const row = this.store.get('SELECT * FROM schedule_occurrences WHERE id=?', occurrenceId);
    if (!row) return fail(404, 'occurrence_not_found');
    try {
      return this.store.transaction(() => {
        if (usage.model_calls && usage.cost_micros === undefined) fail(409, 'schedule_budget_price_unknown');
        const schedule = this.schedule(row.project_id, row.schedule_id), plan = JSON.parse(row.snapshot).plan as Plan;
        if (schedule.state !== 'active' || ['blocked', 'budget_exhausted', 'dead'].includes(row.state)) fail(403, 'schedule_not_active');
        const business = this.store.get('SELECT state FROM schedule_business_runs WHERE occurrence_id=?', row.id);
        if (business && !['queued', 'running'].includes(business.state)) fail(403, 'schedule_business_run_finished');
        const actor = this.actor({ ...schedule, grant_snapshot: JSON.stringify(JSON.parse(row.authorization).grant_snapshot) }, plan);
        authorize(actor, capability, { project_id: row.project_id });
        if (row.started_at === null || this.clock() - row.started_at >= Math.min(...budgetScopes(this.store, row, plan).map(s => s.limits.runtime_ms))) fail(409, 'runtime_budget_exhausted');
        for (const [key, amount] of Object.entries(usage)) reserve(this.store, row, plan, this.clock(), key as 'model_calls' | 'cost_micros', amount);
        this.audit(row, 'action.authorized', actor, row.source, { capability, usage });
        return actor;
      });
    } catch (error) {
      const reason = reasonOf(error);
      this.store.transaction(() => {
        if (reason !== 'schedule_business_run_finished') {
          this.store.run("UPDATE schedule_occurrences SET state=?,reason=? WHERE id=?", reason.includes('budget') ? 'budget_exhausted' : 'blocked', reason, occurrenceId);
          this.store.run("UPDATE schedule_business_runs SET state='blocked' WHERE occurrence_id=? AND state IN ('queued','running')", occurrenceId);
        }
        this.audit(row, 'action.blocked', null, row.source, { reason, capability });
      });
      throw error;
    }
  }
  /** Trusted business services report terminal results against their persisted occurrence, not a
   * new dispatch. Completion only records facts; it never performs another external action. */
  settleRun(occurrenceId: string, state: 'succeeded' | 'failed' | 'cancelled', result: Json): void {
    if (!['succeeded', 'failed', 'cancelled'].includes(state)) fail(400, 'invalid_business_run_state');
    this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM schedule_occurrences WHERE id=?', occurrenceId);
      const business = this.store.get('SELECT * FROM schedule_business_runs WHERE occurrence_id=?', occurrenceId);
      if (!row || !business) return fail(404, 'schedule_business_run_not_found');
      if (!['queued', 'running'].includes(business.state)) return;
      this.store.run('UPDATE schedule_business_runs SET state=?,result=? WHERE occurrence_id=?', state, JSON.stringify(result), occurrenceId);
      this.store.run('UPDATE schedule_occurrences SET state=?,result=?,finished_at=? WHERE id=?', state, JSON.stringify({ ...JSON.parse(row.result ?? '{}'), business_state: state, business_result: result }), this.clock(), occurrenceId);
      if (state === 'succeeded') this.store.run('UPDATE schedules SET last_success=? WHERE id=?', this.clock(), row.schedule_id);
      this.audit(row, 'business.' + state, null, row.source, { run_id: row.run_id });
    });
  }
  /** Chats the actor may name as a subscription's destination without registering them first (#330): a private chat of the
   * actor's own with read access to the project, or a group whose assistant the actor manages and whose scope reaches it. */
  chatDestinations(actor: ActorContext, project: string): Json[] {
    const usable = (check: () => unknown) => { try { check(); return true; } catch (error) { if (error instanceof HttpError) return false; throw error; } };
    const channels = this.channels, personal = this.store.all("SELECT c.* FROM channel_personal_owners o JOIN channel_chats c ON c.id=o.chat_id WHERE o.principal_id=? AND c.chat_type='p2p'", actor.principal_id)
      .filter(chat => usable(() => { channels.schedules.owner(channels.employees.chat(chat.id), actor.principal_id); authorize(actor, 'tasks.read', { project_id: project }); channels.assertApplicationProject(chat, project); }));
    const groups = this.store.all("SELECT c.* FROM channel_service_bindings b JOIN channel_chats c ON c.id=b.chat_id WHERE b.enabled=1 AND c.chat_type='group'").filter(chat => usable(() => {
      const binding = channels.serviceBindings.canView(actor, chat.id);
      if (!binding || !channels.serviceBindings.reachable(channels.serviceBindings.assertUsable(binding), project, ['tasks.read'])) fail(403, 'schedule_destination_unavailable');
    }));
    return [...personal, ...groups].map(chat => ({ id: 'chat:' + chat.id, type: chat.chat_type, chat_id: chat.chat_id, name: this.chatName(chat.id) }));
  }
  /** A destination chat's name (#1360): a group's Feishu name or the private chat person's, as stored; null when none is known. */
  private chatName(id: string | undefined): string | null {
    return (id ? String(chatProfile(this.store, id).display_name ?? '') : '') || null;
  }
  /** A chosen chat ('chat:<id>') is registered for this project and registrant when saved, with every check of a registration;
   * the saved subscription keeps the registered destination. Previews only check that the chat may be chosen. */
  private chosen(actor: ActorContext, project: string, id: string, register = true): string {
    if (!id.startsWith('chat:')) return id;
    if (!register) { if (!this.chatDestinations(actor, project).some(d => d.id === id)) fail(403, 'schedule_destination_unavailable'); return id; }
    return String(this.channels.registerDestination(actor, id.slice(5), { project_id: project }).id);
  }
  /** The project's first maintained service identity, which a project plan's actor_id "auto" stands for. */
  private projectService(project: string): string | undefined {
    return this.store.get("SELECT id FROM principals WHERE kind='service' AND active=1 AND project_id=? AND maintenance<>'' ORDER BY rowid LIMIT 1", project)?.id;
  }
  private static auto(value: unknown): boolean {
    return !!value && typeof value === 'object' && (value as Json).kind === 'project' && (value as Json).actor_id === 'auto';
  }
  /** A new plan's shorthand identities: 'self' is the actor, and a project plan's actor_id "auto" the project's service identity,
   * created as in the console's schedule panel when the project has none (#851). Registration and preview both use this. */
  private resolveIdentities(actor: ActorContext, project: string, value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const next = { ...value } as Json;
    if (next.owner_id === 'self') next.owner_id = actor.principal_id;
    if (next.maintainer_id === 'self') next.maintainer_id = actor.principal_id;
    if (next.kind === 'personal' && next.actor_id === 'self') next.actor_id = actor.principal_id;
    if (ScheduleService.auto(next)) {
      authorize(actor, 'config.write', { project_id: project });
      next.actor_id = this.projectService(project) ?? createProjectServicePrincipal(this.store, actor, project, '项目定时检查');
    }
    return next;
  }
  validatePlan(actor: ActorContext, project: string, value: unknown, existing?: Row): { plan: Plan; grant: Row; execution: ActorContext } {
    validate(planSchema, value); const plan = value as Plan;
    if (!this.handlers.has(plan.workflow)) fail(400, 'schedule_workflow_unsupported');
    if (existing && (plan.kind !== existing.kind || plan.actor_id !== existing.actor_id || plan.owner_id !== existing.owner_id)) fail(403, 'schedule_identity_immutable');
    if (!!plan.cron === !!plan.interval_ms || plan.end_at !== undefined && plan.end_at <= plan.start_at) fail(400, 'invalid_schedule_recurrence');
    localParts(this.clock(), plan.timezone); if (plan.cron) parseCron(plan.cron);
    if (plan.enabled && nextTime(plan, this.clock()) === null) fail(400, 'schedule_has_no_future_occurrence');
    if (plan.workflow === 'manager.check') {
      if (Object.keys(plan.parameters).some(k => k !== 'instruction' && k !== 'file_issues')) fail(400, 'invalid_schedule_parameters');
      const instruction = plan.parameters.instruction;
      if (instruction !== undefined && (typeof instruction !== 'string' || instruction.length > 4000)) fail(400, 'invalid_schedule_parameters');
      if (plan.parameters.file_issues !== undefined && typeof plan.parameters.file_issues !== 'boolean') fail(400, 'invalid_schedule_parameters');
    }
    const grant = this.grants(actor, plan, project, existing), tenant = this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id;
    const execution = this.actor({ tenant_id: tenant, project_id: project, grant_snapshot: JSON.stringify(grant) }, plan);
    return { plan, grant, execution };
  }
  pause(row: Row, reason: string): void {
    this.store.run("UPDATE schedules SET state='paused',reason=?,revision=revision+1,updated_at=? WHERE id=? AND state='active'", reason, this.clock(), row.id);
    this.audit(row, 'paused', null, 'security_recheck', { reason });
  }
  private schedule(project: string, id: string): Row {
    const row = this.store.get('SELECT * FROM schedules WHERE id=? AND project_id=?', id, project);
    if (!row) return fail(404, 'schedule_not_found'); return row;
  }
  private owned(actor: ActorContext, row: Row): void {
    if (row.kind === 'personal' && row.owner_id !== actor.principal_id) fail(403, 'personal_schedule_owner_required');
    if (row.kind === 'project') authorize(actor, 'config.write', { project_id: row.project_id });
  }
  /** A later tick or run-now must not stack on a check that is still queued, running, or waiting to be decided.
   *  task.request normally ends as completed (also pr_opened or superseded); those are finished, not busy.
   *  Only non-terminal occurrences, runs, events, or tasks are considered, so a long history of finished
   *  checks is not scanned. A still-busy task is detected even when its occurrence already finished. */
  busyManagerCheck(scheduleId: string, projectId: string): boolean {
    const taskKey = `${projectId}:task.request:`;
    return !!this.store.get(`SELECT 1 AS n WHERE EXISTS(
        SELECT 1 FROM schedule_occurrences o
        WHERE o.schedule_id=? AND o.state IN ('pending','retry','running','dispatched')
      ) OR EXISTS(
        SELECT 1 FROM schedule_business_runs b
        JOIN schedule_occurrences o ON o.id=b.occurrence_id
        WHERE o.schedule_id=? AND b.state NOT IN ${terminalRunStates}
      ) OR EXISTS(
        SELECT 1 FROM dispatch_events e
        JOIN schedule_occurrences o ON o.id=json_extract(e.facts,'$.occurrence_id')
        WHERE e.type='schedule.due' AND e.state IN ('pending','dispatching') AND o.schedule_id=?
      ) OR EXISTS(
        SELECT 1 FROM tasks t
        WHERE t.status NOT IN ('succeeded','failed','cancelled','completed','pr_opened','superseded')
          AND t.unique_key LIKE ? || '%'
          AND EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.schedule_id=? AND t.unique_key=? || o.id)
      )`, scheduleId, scheduleId, scheduleId, taskKey, scheduleId, taskKey);
  }
  occurrence(row: Row, key: string, logical: number, source: string, state = 'pending', reason?: string, initiator?: string): Row {
    const previous = this.store.get('SELECT * FROM schedule_occurrences WHERE schedule_id=? AND logical_key=?', row.id, key);
    if (previous) return previous;
    const id = 'occ_' + parameterHash([row.id, key]), plan = JSON.parse(row.spec) as Plan, run = 'run_' + parameterHash(id);
    const currentActor = this.actor(row, plan);
    const authorization = { actor_id: row.actor_id, initiator: initiator ?? row.creator_id, authorization_revision: currentActor.authorization_revision, grant_snapshot: JSON.parse(row.grant_snapshot), source };
    const config = { policy: this.store.get('SELECT * FROM policies WHERE repository_id=?', row.project_id), work: plan.workflow, work_settings: this.store.get('SELECT work_settings FROM policies WHERE repository_id=?', row.project_id)?.work_settings ?? null,
      rules: this.store.get('SELECT sha,files FROM repository_rule_sources WHERE repository_id=?', row.project_id), management_revision: this.management.revision({ project_id: row.project_id }) };
    // Snapshots contain configuration and references, never account or model credentials.
    this.store.run(`INSERT INTO schedule_occurrences(id,schedule_id,tenant_id,project_id,revision,logical_key,logical_at,scheduled_at,source,snapshot,authorization,run_id,state,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, row.id, row.tenant_id, row.project_id, row.revision, key, logical, this.clock(), source, JSON.stringify({ plan, config }), JSON.stringify(authorization), run, state, reason ?? null);
    this.audit(row, 'occurrence.' + state, null, source, { occurrence_id: id, run_id: run, logical_at: logical, reason });
    return this.store.get('SELECT * FROM schedule_occurrences WHERE id=?', id)!;
  }
  private command(actor: ActorContext, command: ManagementCommand, key: string): Json {
    return this.store.transaction(() => {
      const previous = this.store.get('SELECT result FROM schedule_operations WHERE effect_key=?', key); if (previous) return JSON.parse(previous.result);
      this.management.expectRevision(command.target, command.expected_revision);
      const project = command.target.project_id, args = command.arguments as any, operation = command.operation;
      this.management.scope(actor, project, 'schedules.manage');
      let result: Json;
      if (operation === 'schedule.register' || operation === 'schedule.update') {
        const old = operation === 'schedule.update' ? this.schedule(project, args.id) : undefined;
        if (old) { this.owned(actor, old); if (old.state === 'deleted' || old.revision !== args.revision) fail(409, 'schedule_revision_conflict'); }
        const inputPlan = old ? args.plan : this.resolveIdentities(actor, project, args.plan);
        const { plan, grant, execution } = this.validatePlan(actor, project, inputPlan, old), id = old?.id ?? randomId(), now = this.clock();
        if (old) this.store.run(`UPDATE schedules SET spec=?,maintainer_id=?,grant_snapshot=?,approver_id=?,authorization_revision=?,revision=revision+1,
          state=?,reason=NULL,next_at=?,updated_at=? WHERE id=?`, JSON.stringify(plan), plan.maintainer_id, JSON.stringify(grant), grant.approver_id, execution.authorization_revision,
          plan.enabled ? 'active' : 'paused', nextTime(plan, now), now, id);
        else this.store.run(`INSERT INTO schedules(id,tenant_id,project_id,creator_id,owner_id,maintainer_id,actor_id,kind,approver_id,authorization_revision,grant_snapshot,spec,revision,state,next_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`, id, this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id, project, actor.principal_id,
          plan.owner_id, plan.maintainer_id, plan.actor_id, plan.kind, grant.approver_id, execution.authorization_revision, JSON.stringify(grant), JSON.stringify(plan), plan.enabled ? 'active' : 'paused', nextTime(plan, now), now, now);
        const row = this.schedule(project, id); this.audit(row, operation, actor, key); result = { schedule: this.view(row) };
      } else if (operation.startsWith('schedule.')) {
        const row = this.schedule(project, args.id), plan = JSON.parse(row.spec) as Plan; this.owned(actor, row);
        if (row.revision !== args.revision || row.state === 'deleted') fail(409, 'schedule_revision_conflict');
        if (operation === 'schedule.run-now') {
          if (row.state !== 'active') fail(409, 'schedule_not_active'); this.actor(row, plan);
          if (plan.workflow === 'manager.check' && this.busyManagerCheck(row.id, project)) fail(409, 'schedule_occurrence_in_progress');
          result = { occurrence: this.occurrence(row, 'manual:' + key, this.clock(), 'run-now:' + actor.principal_id, 'pending', undefined, actor.principal_id) };
        } else {
          const state = operation === 'schedule.delete' ? 'deleted' : operation === 'schedule.resume' ? 'active' : 'paused';
          if (state === 'active') this.actor(row, plan);
          plan.enabled = state === 'active';
          this.store.run('UPDATE schedules SET state=?,reason=?,spec=?,next_at=?,revision=revision+1,updated_at=? WHERE id=?', state, state === 'active' ? null : 'user_' + state, JSON.stringify(plan), state === 'active' ? nextTime(plan, this.clock()) : row.next_at, this.clock(), row.id);
          if (state !== 'active') this.store.run("UPDATE notification_outbox SET state='blocked',last_error='schedule_not_active' WHERE schedule_id=? AND state IN ('pending','retry')", row.id);
          this.audit(row, operation, actor, key); result = { schedule: this.view(this.schedule(project, row.id)) };
        }
      } else if (operation === 'notification.retry') {
        const row = this.store.get('SELECT * FROM notification_outbox WHERE id=? AND project_id=?', args.id, project);
        if (!row || !['dead', 'unknown'].includes(row.state)) fail(409, 'notification_not_retryable');
        if (row!.schedule_id) this.owned(actor, this.schedule(project, row!.schedule_id));
        else if (this.store.get('SELECT principal_id FROM notification_subscriptions WHERE id=?', row!.subscription_id)?.principal_id !== actor.principal_id) fail(403, 'subscription_owner_required');
        if (row!.state === 'unknown' && args.acknowledge_unknown !== true) fail(409, 'notification_duplicate_risk_acknowledgement_required');
        const scopes = budgetScopes(this.store, { ...row!, schedule_id: row!.schedule_id ?? row!.subscription_id }, this.notificationPlan(row!));
        if (row!.manual_retries >= Math.min(...scopes.map(s => s.limits.manual_retries))) fail(409, 'notification_manual_retry_budget_exhausted');
        this.deliveryGuard(row!); this.store.run("UPDATE notification_outbox SET state='retry',manual_retries=manual_retries+1,next_attempt=?,last_error='manual_retry' WHERE id=?", this.clock(), row!.id);
        this.audit({ ...row!, revision: 0 }, operation, actor, key, { possible_duplicate: row!.state === 'unknown' }); result = { id: row!.id, state: 'retry', sent: false };
      } else result = this.subscriptionCommand(actor, project, operation, args, key);
      this.store.run('INSERT INTO schedule_operations VALUES(?,?,?)', key, project, JSON.stringify(result)); return result;
    });
  }
  private validateSubscription(actor: ActorContext, project: string, input: unknown, register = true) {
    validate(subscriptionSchema, input); const spec = input as SubscriptionSpec;
    // Each project has an independent authorization and subscription cursor.
    if (spec.projects.length !== 1 || spec.projects[0] !== project) fail(400, 'subscription_project_scope_required');
    localParts(this.clock(), spec.timezone);
    if (!!spec.quiet_start !== !!spec.quiet_end || [spec.quiet_start, spec.quiet_end].some(v => v !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) || spec.quiet_start && spec.quiet_start === spec.quiet_end) fail(400, 'invalid_subscription_quiet_hours');
    const previewChat = !register && spec.destination_id.startsWith('chat:');
    spec.destination_id = this.chosen(actor, project, spec.destination_id, register);
    // Chosen chats are authorized above; a read-only preview must not materialize a registration.
    const event = previewChat ? this.channels.employees.chat(spec.destination_id.slice(5)) : this.destination(spec.destination_id, project).event;
    return { spec, destination: { id: spec.destination_id, type: event.chat_type, chat_id: event.chat_id } };
  }
  private subscriptionCommand(actor: ActorContext, project: string, operation: string, args: any, key: string): Json {
    const old = args.id ? this.store.get('SELECT * FROM notification_subscriptions WHERE id=? AND project_id=?', args.id, project) : undefined;
    if (args.id && !old) fail(404, 'subscription_not_found');
    if (old && (old.principal_id !== actor.principal_id || old.revision !== args.revision || old.state === 'deleted')) fail(409, 'subscription_revision_conflict');
    if (operation === 'notification.register' || operation === 'subscription.update') {
      const { spec } = this.validateSubscription(actor, project, args.subscription); const id = old?.id ?? randomId(), now = this.clock();
      if (old) this.store.run('UPDATE notification_subscriptions SET spec=?,revision=revision+1,state=?,reason=NULL,updated_at=? WHERE id=?', JSON.stringify(spec), spec.enabled ? 'active' : 'paused', now, id);
      else this.store.run(`INSERT INTO notification_subscriptions(id,tenant_id,project_id,principal_id,spec,revision,state,reason,event_cursor,created_at,updated_at) VALUES(?,?,?,?,?,1,?,NULL,?,?,?)`, id,
        this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id, project, actor.principal_id, JSON.stringify(spec),
        spec.enabled ? 'active' : 'paused', this.store.get('SELECT coalesce(max(sequence),0) n FROM schedule_events')!.n, now, now);
      const row = this.store.get('SELECT * FROM notification_subscriptions WHERE id=?', id)!;
      if (old) this.store.run("UPDATE notification_outbox SET state='blocked',last_error='subscription_revoked_or_changed' WHERE subscription_id=? AND state IN ('pending','retry')", id);
      this.audit({ ...row, actor_id: actor.principal_id }, operation, actor, key); return { subscription: this.subscriptionView(row) };
    }
    const state = operation === 'subscription.delete' ? 'deleted' : operation === 'subscription.resume' ? 'active' : 'paused';
    const spec = JSON.parse(old!.spec); if (state === 'active') this.destination(spec.destination_id, project);
    spec.enabled = state === 'active';
    this.store.run('UPDATE notification_subscriptions SET state=?,spec=?,reason=?,revision=revision+1,updated_at=? WHERE id=?', state, JSON.stringify(spec), state === 'active' ? null : 'user_' + state, this.clock(), old!.id);
    this.store.run("UPDATE notification_outbox SET state='blocked',last_error='subscription_revoked_or_changed' WHERE subscription_id=? AND state IN ('pending','retry')", old!.id);
    this.audit({ ...old!, actor_id: actor.principal_id }, operation, actor, key); return { subscription: this.subscriptionView(this.store.get('SELECT * FROM notification_subscriptions WHERE id=?', old!.id)!) };
  }
  subscriptionView(row: Row): Json { return { ...row, spec: JSON.parse(row.spec), unsubscribe: { operation: 'subscription.delete', arguments: { id: row.id, revision: row.revision } } }; }
  view(row: Row): Json {
    const plan = JSON.parse(row.spec) as Plan;
    return { ...row, next_at: row.state === 'active' ? row.next_at : null, spec: plan, grant_snapshot: JSON.parse(row.grant_snapshot), parsed: { timezone: plan.timezone, recurrence: plan.cron ?? `每 ${plan.interval_ms} 毫秒`,
      dst: 'gap_skip_fold_first', misfire: plan.misfire, timezone_change: '新版本保存后仅影响新实例' }, future: row.state === 'active' ? previewTimes(plan, this.clock()) : [],
      supported: this.handlers.has(plan.workflow), handover: { maintainer_id: plan.maintainer_id, required: row.kind === 'project' && row.state === 'paused' },
      migration: this.store.get('SELECT outcome,reason,chat_type,channel_schedule_id,created_at FROM schedule_migrations WHERE schedule_id=?', row.id) ?? null,
      latest: this.store.get('SELECT id,state,reason,run_id,logical_at FROM schedule_occurrences WHERE schedule_id=? ORDER BY scheduled_at DESC,id DESC LIMIT 1', row.id) ?? null };
  }
  async query(actor: ActorContext, operation: string, project: string, args: any): Promise<Json> {
    if (!project) fail(400, 'project_target_required'); this.management.scope(actor, project, 'schedules.manage');
    const revision = this.management.revision({ project_id: project }), limit = args.limit ?? 20, offset = args.offset ?? 0;
    if (operation === 'preview_schedule') {
      const existing = args.schedule_id ? this.schedule(project, args.schedule_id) : undefined;
      if (existing) this.owned(actor, existing);
      const check = () => this.validatePlan(actor, project, existing ? args.plan : this.resolveIdentities(actor, project, args.plan), existing).plan;
      // #1362: "auto" previews as registration resolves it. When registration would create the project's service identity,
      // the preview creates and checks it in a savepoint that is then rolled back: the same rules, and nothing is left behind.
      const auto = !existing && ScheduleService.auto(args.plan), creates = auto && !this.projectService(project);
      const rehearse = (): Plan => {
        try { return this.store.transaction(() => { throw new Rehearsal(check()); }); }
        catch (error) { if (error instanceof Rehearsal) return { ...error.plan, actor_id: 'auto' }; throw error; }
      };
      const plan = creates ? rehearse() : check();
      return { revision, plan, timezone: plan.timezone, future: previewTimes(plan, this.clock()), supported: this.handlers.has(plan.workflow),
        ...(auto ? { service_identity: creates ? { id: null, created_on_register: true } : { id: plan.actor_id, created_on_register: false } } : {}) };
    }
    if (operation === 'preview_subscription') {
      const { spec, destination } = this.validateSubscription(actor, project, args.subscription, false), now = this.clock();
      const aggregationEnds = now + spec.aggregate_ms;
      // This is a hypothetical single event at the server's current time, not a saved trigger or delivery.
      return { revision, subscription: spec, preview_at: now, event_received_at: now, aggregation_ends_at: aggregationEnds,
        first_send_at: spec.enabled ? quietUntil(spec, aggregationEnds) : null, timezone: spec.timezone,
        destination, hypothetical: true };
    }
    if (operation === 'list_schedules' || operation === 'list_subscriptions') {
      const table = operation === 'list_schedules' ? 'schedules' : 'notification_subscriptions';
      const exact = operation === 'list_subscriptions' && args.id;
      const rows = this.store.all(`SELECT * FROM ${table} WHERE project_id=?${exact ? ' AND id=?' : ''} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`, project, ...(exact ? [args.id] : []), limit + 1, offset), more = rows.length > limit; rows.splice(limit);
      return { revision, [operation === 'list_schedules' ? 'schedules' : 'subscriptions']: rows.map(r => operation === 'list_schedules' ? this.view(r) : { ...this.subscriptionView(r), editable: r.principal_id === actor.principal_id && r.state !== 'deleted' }), next_offset: more ? offset + limit : null };
    }
    if (operation === 'list_schedule_destinations') {
      const destinations: Json[] = this.store.all("SELECT id,created_at FROM channel_outbox WHERE state='registered'").flatMap(r => {
        try {
          const d = this.destination(r.id, project), chat = this.store.get('SELECT id FROM channel_chats WHERE connector_id=? AND chat_id=?', d.event.connector_id, d.event.chat_id);
          return [{ id: r.id, type: d.event.chat_type, chat_id: d.event.chat_id, name: this.chatName(chat?.id) }];
        } catch { return []; }
      });
      // Chats that may receive this project's event notifications are offered directly; no separate registration step (#330).
      destinations.push(...this.chatDestinations(actor, project).filter(chat => !destinations.some(d => d.chat_id === chat.chat_id)));
      let canDelegate = false; try { authorize(actor, 'config.write', { project_id: project }); canDelegate = true; } catch { /* Personal schedules need no delegation capability. */ }
      const tenant = this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id;
      const services = canDelegate ? this.store.all("SELECT id,maintenance FROM principals WHERE kind='service' AND active=1 AND project_id=? AND tenant_id=? AND maintenance<>''", project, tenant) : [];
      const maintainers = this.store.all("SELECT p.id,u.username name FROM principals p JOIN users u ON u.id=p.user_id WHERE p.kind='human' AND p.active=1 AND u.active=1").filter(p => {
        try { authorize(resolvePrincipalActor(this.store, p.id, tenant, project), 'schedules.manage', { project_id: project }); return canDelegate || p.id === actor.principal_id; } catch { return false; }
      });
      // can_manage_project: the caller sets up project plans here and may create the project's service identity (#851).
      return { revision, principal_id: actor.principal_id, destinations, services, maintainers, can_manage_project: canDelegate };
    }
    if (operation === 'list_schedule_migrations') {
      // The migration report of this project's daily report plans (#1027): every plan, where it went, or why it did not.
      const rows = this.store.all('SELECT * FROM schedule_migrations WHERE project_id=? ORDER BY created_at,schedule_id LIMIT ? OFFSET ?', project, limit + 1, offset), more = rows.length > limit; rows.splice(limit);
      return { revision, migrations: rows.map(r => ({ ...r, detail: JSON.parse(r.detail) })), next_offset: more ? offset + limit : null };
    }
    const table = ({ list_occurrences: 'schedule_occurrences', list_notification_deliveries: 'notification_outbox', list_schedule_audit: 'schedule_audit' } as Record<string, string>)[operation];
    if (!table) return fail(400, 'unknown_schedule_query');
    const rows = this.store.all(`SELECT * FROM ${table} WHERE project_id=? ORDER BY ${table === 'schedule_occurrences' ? 'scheduled_at' : 'created_at'} DESC,id DESC LIMIT ? OFFSET ?`, project, limit + 1, offset);
    const more = rows.length > limit; rows.splice(limit);
    return { revision, records: rows.map(r => ({ ...r, ...Object.fromEntries(['snapshot', 'authorization', 'payload', 'result', 'detail'].filter(k => typeof r[k] === 'string').map(k => [k, JSON.parse(r[k])])),
      ...(table === 'notification_outbox' ? { ...this.deliveryContext(r, project), attempts_detail: this.store.all('SELECT * FROM notification_attempts WHERE outbox_id=? ORDER BY attempt', r.id) } : {}) })),
      budgets: this.store.all('SELECT * FROM schedule_budgets WHERE (scope=\'project\' AND scope_id=?) OR (scope=\'tenant\' AND scope_id=?)', project, actor.tenant_id),
      usage: this.store.all('SELECT * FROM schedule_usage WHERE scope=\'project\' AND scope_id=? ORDER BY day DESC', project), next_offset: more ? offset + limit : null };
  }
  private deliveryContext(row: Row, project: string): Json {
    // Use the occurrence snapshot, not a plan edited after this notification was produced.
    const occurrence = row.occurrence_id ? this.store.get('SELECT * FROM schedule_occurrences WHERE id=? AND project_id=?', row.occurrence_id, project) : undefined;
    const plan = occurrence ? JSON.parse(occurrence.snapshot).plan as Plan : undefined;
    const subscription = row.subscription_id ? this.store.get('SELECT * FROM notification_subscriptions WHERE id=? AND project_id=?', row.subscription_id, project) : undefined;
    const spec = subscription && subscription.revision === row.subscription_revision ? JSON.parse(subscription.spec) as SubscriptionSpec : undefined;
    let destination: Json;
    try {
      const current = this.destination(row.destination_id, project);
      destination = { valid: true, type: current.event.chat_type, chat_id: current.event.chat_id };
    } catch (error) { destination = { valid: false, reason: error instanceof HttpError ? error.code : 'destination_unavailable' }; }
    return { origin: plan && occurrence ? { name: plan.name, timezone: plan.timezone, revision: occurrence.revision,
      logical_at: occurrence.logical_at, run_id: occurrence.run_id, state: occurrence.state, reason: occurrence.reason } :
      { name: spec?.name ?? null, timezone: spec?.timezone ?? null, revision: row.subscription_revision }, destination };
  }

  deliveryGuard(row: Row): ActorContext {
    this.executionScope(row.project_id);
    // A plan's own notification came only from a daily report (#1027): one still queued from before is never sent.
    if (row.schedule_id) return fail(403, 'schedule_notifications_retired');
    const sub = this.store.get('SELECT * FROM notification_subscriptions WHERE id=?', row.subscription_id);
    if (!sub) return fail(403, 'subscription_revoked_or_changed');
    if (sub.state !== 'active' || sub.revision !== row.subscription_revision) fail(403, 'subscription_revoked_or_changed');
    const actor = resolvePrincipalActor(this.store, sub.principal_id, sub.tenant_id, sub.project_id, 'service');
    authorize(actor, 'tasks.read', { project_id: sub.project_id }); authorize(actor, 'schedules.manage', { project_id: sub.project_id });
    this.destination(row.destination_id, row.project_id);
    return actor;
  }
  /** Budget limits of a notification: an event subscription's are the defaults, bounded by project and tenant budgets. */
  notificationPlan(row: Row): Plan {
    if (row.occurrence_id) return JSON.parse(this.store.get('SELECT snapshot FROM schedule_occurrences WHERE id=?', row.occurrence_id)!.snapshot).plan;
    return { workflow: notificationWorkflow, limits: defaultLimits } as Plan;
  }
}
