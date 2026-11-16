import type { Store, Row } from '../storage/database.js';
import { fail, fields, randomId, type Json } from '../core/security.js';
import { resolvePrincipalActor, type ActorContext } from '../identity/authorization.js';
import { installationApi } from '../app/installations.js';
import { trustedOrganization } from '../app/trusted-organizations.js';
import { isCeiling, projectCeiling } from '../work/ceiling.js';
import type { ManagementService } from './service.js';

/**
 * Requests to start a repository (#933). An administrator of a repository whose organization is not trusted (#848) cannot
 * start it: confirming the onboarding plan files a request instead, and the start item waits for it. Every super
 * administrator is told (console and Feishu private chat); one of them approves — choosing the model and level, optionally
 * trusting the organization — or rejects with a reason, and the requester is told. On approval the super administrator
 * starts the project, and the rest of the plan is applied as the requester, with the requester's own permissions.
 *
 * One request per repository is open at a time; requesting again returns it. The requester (or another administrator of
 * the repository) withdraws it; it lapses when the repository leaves the installation or the project starts another way.
 * There is no time limit: an open request stays in the super administrators' list until someone decides.
 */
export type RequestState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'lapsed';
const now = () => new Date().toISOString();

/** What the requests need from the onboarding: the repository, the applying engine and the notifications. */
export interface RequestHost {
  store: Store; service: ManagementService;
  repository(id: string): Row | undefined;
  actor(base: ActorContext, id: string): ActorContext;
  /** Records the start item's outcome on its application. */
  startOutcome(applicationId: string, outcome: { state: 'succeeded' | 'failed'; error?: string; detail: Json; executed_by: string }): void;
  /** Goes on applying the application's waiting items, as `base` (the requester). */
  resume(applicationId: string, base: ActorContext): Promise<void>;
  /** Whether the repository is applying a confirmation right now. */
  busy(repositoryId: string): boolean;
}
/** What a Feishu notice is about, for the delivery to check again before it sends (channels/service.ts). */
export interface RequestNotice { request_id: string; state: RequestState; tenant: string; audience: 'super_admin' | 'requester' }

export class OnboardingRequests {
  /**
   * Tells people (principal ids) about a request in their Feishu private chat, set by the channels when they run; the console
   * list holds every request anyway. Best effort: a person without a bound private chat is told only in the console.
   */
  notify?: (principals: string[], text: string, about: RequestNotice) => void;
  constructor(readonly host: RequestHost) {}
  get store() { return this.host.store; }

  /** The open request of a repository, or the one just filed for this application. Called by the start item. */
  open(actor: ActorContext, application: Row, plan: Json): Row {
    const id = String(application.repository_id);
    const existing = this.store.get("SELECT * FROM onboarding_requests WHERE repository_id=? AND state='pending'", id);
    if (existing) {
      // A newer confirmation takes the open request over: it is the plan the super administrator decides on now.
      if (existing.application_id !== application.id) this.store.run('UPDATE onboarding_requests SET application_id=?,updated_at=? WHERE id=?', application.id, now(), existing.id);
      return { ...existing, application_id: application.id };
    }
    const request = randomId(), time = now();
    this.store.transaction(() => {
      this.store.run(`INSERT INTO onboarding_requests(id,repository_id,application_id,requested_by,requested_at,state,updated_at) VALUES(?,?,?,?,?,'pending',?)`,
        request, id, application.id, actor.principal_id, time, time);
      this.store.audit(actor.principal_id, 'onboarding.start_requested', request, id);
    });
    const repository = this.host.repository(id)!;
    this.notify?.(this.superAdministrators(), `仓库 ${repository.full_name} 申请启动：${summary(plan)}\n在控制台的启动申请里同意或拒绝。`,
      { request_id: request, state: 'pending', tenant: 'github.com:' + repository.owner_id, audience: 'super_admin' });
    return this.store.get('SELECT * FROM onboarding_requests WHERE id=?', request)!;
  }

  /** Requests as a super administrator sees them, newest first; `state` filters (pending by default). */
  list(actor: ActorContext, state: string | null): Json {
    this.superAdministrator(actor); this.lapse();
    if (state !== null && !['pending', 'approved', 'rejected', 'withdrawn', 'lapsed', 'all'].includes(state)) fail(400, 'invalid_request_state', 'state');
    const rows = this.store.all(`SELECT * FROM onboarding_requests ${state === 'all' ? '' : 'WHERE state=?'} ORDER BY requested_at DESC LIMIT 100`, ...(state === 'all' ? [] : [state ?? 'pending']));
    return { requests: rows.map(row => this.view(row)) };
  }
  read(actor: ActorContext, id: string): Json { this.superAdministrator(actor); this.lapse(); return { request: this.view(this.request(id)) }; }
  /** The repository's latest request, for its onboarding page. */
  latest(repositoryId: string): Json | null {
    this.lapse(repositoryId);
    const row = this.store.get('SELECT * FROM onboarding_requests WHERE repository_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1', repositoryId);
    return row ? this.view(row) : null;
  }

  /**
   * Approves: the super administrator starts the project with the model and level they choose (by default the deployment's
   * shared model and the plan's level), trusting the organization if asked, as #848's start does; the plan's other items are
   * then applied as the requester.
   */
  async approve(actor: ActorContext, id: string, input: Json): Promise<Json> {
    fields(input, ['model_id', 'capability_ceiling', 'trust_organization']);
    const user = this.superAdministrator(actor), request = this.pending(id);
    // The rest of the plan is applied right after the start: not while the repository applies another confirmation.
    if (this.host.busy(String(request.repository_id))) fail(409, 'onboarding_apply_running');
    if (input.capability_ceiling !== undefined && !isCeiling(input.capability_ceiling)) fail(400, 'invalid_capability_ceiling', 'capability_ceiling');
    if (input.model_id !== undefined && (typeof input.model_id !== 'string' || !input.model_id)) fail(400, 'invalid_model', 'model_id');
    if (input.trust_organization !== undefined && typeof input.trust_organization !== 'boolean') fail(400, 'invalid_field', 'trust_organization');
    const application = this.store.get('SELECT * FROM onboarding_applications WHERE id=?', request.application_id)!;
    const plan = JSON.parse(this.store.get('SELECT plan FROM onboarding_plans WHERE id=?', application.plan_id)!.plan) as Json;
    const planned = this.store.get("SELECT state FROM onboarding_receipts WHERE application_id=? AND item='capability_ceiling'", application.id)?.state === 'pending' ? (plan.capability_ceiling as Json).value : undefined;
    const ceiling = input.capability_ceiling ?? planned;
    const model = input.model_id ?? this.store.get("SELECT m.id FROM settings s JOIN models m ON m.id=json_extract(s.value,'$') AND m.repository_id IS NULL WHERE s.key='onboarding.model' AND json_valid(s.value)")?.id;
    await installationApi(this.store, undefined, user, 'POST', new URL(`http://local/api/installations/${request.repository_id}/activate`),
      { ...(ceiling ? { capability_ceiling: ceiling } : {}), ...(model ? { model_id: model } : {}), ...(input.trust_organization ? { trust_organization: true } : {}) });
    const decision = { capability_ceiling: projectCeiling(this.store, String(request.repository_id)), model_id: this.store.get('SELECT model_id FROM policies WHERE repository_id=?', request.repository_id)?.model_id ?? null,
      trust_organization: input.trust_organization === true };
    this.decide(request, 'approved', actor.principal_id, { decision });
    // The level the super administrator chose is the project's level: the plan's level item does not move it again.
    if (input.capability_ceiling !== undefined && input.capability_ceiling !== planned)
      this.store.run("UPDATE onboarding_receipts SET state='skipped',error='decided_by_approval',detail=?,updated_at=? WHERE application_id=? AND item='capability_ceiling' AND state='pending'",
        JSON.stringify({ approved: decision.capability_ceiling }), now(), application.id);
    const requester = resolvePrincipalActor(this.store, String(request.requested_by), 'github.com:' + this.host.repository(String(request.repository_id))!.owner_id, undefined, 'web');
    this.host.startOutcome(String(application.id), { state: 'succeeded', detail: { by: 'approval', approved_by: actor.principal_id, ...decision }, executed_by: actor.principal_id });
    await this.host.resume(String(application.id), requester);
    this.tell(request, 'approved', `仓库 ${this.fullName(request)} 的启动申请已同意，项目已启动，方案其余各项正按你的确认应用，结果见接入页。`);
    return this.read(actor, id);
  }

  /** Rejects with a reason, which the requester is told; they may request again later. */
  reject(actor: ActorContext, id: string, input: Json): Json {
    fields(input, ['reason']);
    this.superAdministrator(actor);
    const request = this.pending(id);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 2000) fail(400, 'rejection_reason_required', 'reason');
    this.decide(request, 'rejected', actor.principal_id, { reason });
    this.host.startOutcome(String(request.application_id), { state: 'failed', error: 'start_rejected', detail: { reason, rejected_by: actor.principal_id }, executed_by: actor.principal_id });
    this.tell(request, 'rejected', `仓库 ${this.fullName(request)} 的启动申请被拒绝：${reason}`);
    return this.read(actor, id);
  }

  /** Withdraws the repository's open request (any administrator of the repository). */
  withdraw(base: ActorContext, repositoryId: string, input: Json): void {
    fields(input, []);
    const actor = this.host.actor(base, repositoryId);
    const request = this.store.get("SELECT * FROM onboarding_requests WHERE repository_id=? AND state='pending'", repositoryId);
    if (!request) return fail(404, 'onboarding_request_not_found');
    this.decide(request, 'withdrawn', actor.principal_id, {});
    this.host.startOutcome(String(request.application_id), { state: 'failed', error: 'start_request_withdrawn', detail: { withdrawn_by: actor.principal_id }, executed_by: actor.principal_id });
  }

  /**
   * Open requests lapse when nobody needs to decide any more: the repository left the installation, was started another way,
   * or its organization became trusted (its administrators then start it themselves: retrying the start does). Checked
   * whenever requests are read, so no background job is needed.
   */
  private lapse(repositoryId?: string): void {
    for (const request of this.store.all(`SELECT * FROM onboarding_requests WHERE state='pending'${repositoryId ? ' AND repository_id=?' : ''}`, ...(repositoryId ? [repositoryId] : []))) {
      const repository = this.host.repository(String(request.repository_id));
      const reason = this.store.get('SELECT 1 FROM repositories WHERE id=?', request.repository_id) ? 'project_started' : !repository ? 'repository_not_installed'
        : trustedOrganization(this.store, String(repository.owner_id)) ? 'organization_trusted' : null;
      if (!reason) continue;
      this.decide(request, 'lapsed', null, { reason });
      if (reason !== 'project_started') this.host.startOutcome(String(request.application_id), { state: 'failed', error: 'start_request_lapsed', detail: { reason }, executed_by: String(request.requested_by) });
    }
  }
  private decide(request: Row, state: RequestState, by: string | null, extra: { reason?: string; decision?: Json }): void {
    this.store.transaction(() => {
      const changed = this.store.run(`UPDATE onboarding_requests SET state=?,decided_by=?,decided_at=?,reason=?,decision=?,updated_at=? WHERE id=? AND state='pending'`,
        state, by, now(), extra.reason ?? null, extra.decision ? JSON.stringify(extra.decision) : null, now(), request.id);
      if (!Number(changed.changes)) fail(409, 'onboarding_request_closed');
      this.store.audit(by ?? String(request.requested_by), 'onboarding.request_' + state, String(request.id), String(request.repository_id));
    });
  }
  private pending(id: string): Row {
    this.lapse();
    const request = this.request(id);
    if (request.state !== 'pending') fail(409, 'onboarding_request_closed');
    return request;
  }
  private request(id: string): Row { return this.store.get('SELECT * FROM onboarding_requests WHERE id=?', id) ?? fail(404, 'onboarding_request_not_found'); }
  private superAdministrator(actor: ActorContext) {
    const user = this.host.service.user(actor);
    if (user.role !== 'super_admin') fail(403, 'super_admin_required');
    return user;
  }
  private superAdministrators(): string[] {
    return this.store.all("SELECT p.id FROM principals p JOIN users u ON u.id=p.user_id WHERE p.kind='human' AND p.active=1 AND u.active=1 AND u.role='super_admin'").map(row => String(row.id));
  }
  private fullName(request: Row): string { return String(this.host.repository(String(request.repository_id))?.full_name ?? request.repository_id); }
  private tell(request: Row, state: RequestState, text: string): void {
    const repository = this.host.repository(String(request.repository_id)) ?? this.store.get('SELECT owner_id FROM repositories WHERE id=?', request.repository_id);
    if (repository) this.notify?.([String(request.requested_by)], text, { request_id: String(request.id), state, tenant: 'github.com:' + repository.owner_id, audience: 'requester' });
  }
  private view(row: Row): Json {
    const application = this.store.get('SELECT plan_id,version FROM onboarding_applications WHERE id=?', row.application_id);
    const plan = application ? JSON.parse(this.store.get('SELECT plan FROM onboarding_plans WHERE id=?', application.plan_id)?.plan ?? '{}') as Json : {};
    const requester = this.store.get('SELECT u.username FROM principals p JOIN users u ON u.id=p.user_id WHERE p.id=?', row.requested_by);
    const repository = this.host.repository(String(row.repository_id));
    return { id: row.id, state: row.state, repository: { id: row.repository_id, full_name: repository?.full_name ?? null, organization_trusted: repository ? !!trustedOrganization(this.store, String(repository.owner_id)) : false },
      requested_by: { principal_id: row.requested_by, name: requester?.username ?? null }, requested_at: row.requested_at, plan_version: application?.version ?? null,
      summary: { profile: (plan.profile as Json | undefined)?.summary ?? null, capability_ceiling: (plan.capability_ceiling as Json | undefined)?.value ?? null,
        labels: (((plan.labels as Json | undefined)?.items as Json[] | undefined) ?? []).filter(label => label.action === 'create').map(label => label.name),
        schedules: ((plan.schedules as Json[] | undefined) ?? []).map(schedule => schedule.name), ci: !!plan.ci },
      decided_by: row.decided_by ?? null, decided_at: row.decided_at ?? null, reason: row.reason ?? null, decision: row.decision ? JSON.parse(row.decision) : null };
  }
}

/** One line of the plan for the notification: level, labels to create, Manager checks, CI. */
function summary(plan: Json): string {
  const parts: string[] = [];
  const level = (plan.capability_ceiling as Json | undefined)?.value;
  if (level) parts.push('能力档 ' + level);
  const labels = (((plan.labels as Json | undefined)?.items as Json[] | undefined) ?? []).filter(label => label.action === 'create').map(label => label.name);
  if (labels.length) parts.push('新建标签 ' + labels.join('、'));
  const schedules = ((plan.schedules as Json[] | undefined) ?? []).map(schedule => schedule.name);
  if (schedules.length) parts.push('定时检查 ' + schedules.join('、'));
  if (plan.ci) parts.push('CI 建议转开发任务');
  const profile = String((plan.profile as Json | undefined)?.summary ?? '').slice(0, 300);
  return (parts.join('；') || '按方案启动') + (profile ? `。仓库画像：${profile}` : '');
}
