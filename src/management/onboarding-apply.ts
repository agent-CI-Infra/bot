import { createHash } from 'node:crypto';
import type { Store, Row } from '../storage/database.js';
import { fail, fields, HttpError, randomId, type Json } from '../core/security.js';
import type { ActorContext } from '../identity/authorization.js';
import { createProjectServicePrincipal } from '../identity/authorization.js';
import { Redactor } from '../agent/common.js';
import { agentReadPermissions } from '../github/client.js';
import { githubWrite } from '../github/write.js';
import { installationApi } from '../app/installations.js';
import { trustCeiling, trustedOrganization } from '../app/trusted-organizations.js';
import { projectCeiling } from '../projects/ceiling.js';
import { effectiveManagerPrompt, eventFilters, managerPrompt } from '../dispatch/settings.js';
import { roleConfiguration } from '../roles/definition.js';
import { defaultLimits } from '../schedules/types.js';
import { ServiceRepositories } from '../service-roles/resources.js';
import type { ManagementService } from './service.js';
import { OnboardingRequests } from './onboarding-requests.js';

/**
 * Applying a confirmed onboarding plan (#932). The administrator confirms the whole plan once, leaving out the items they do
 * not want; the control plane then applies the items in a fixed order, each through the channel a person would use (the
 * installation start, management commands, github_write, schedules), as the person who confirmed, with their permissions
 * checked as usual. Each item gets a receipt: succeeded, exists (already as planned), failed (with the reason, retried on its
 * own) or skipped (left out). Nothing new is configurable here: every item is an existing setting.
 *
 * What is confirmed is the live difference between the plan and the project as it is now (`changes`): items already as
 * planned are not listed, and a change made by someone else after the plan was proposed shows up as its current value. The
 * confirmation names the difference it was given (`changes_revision`); a different one means the page is outdated.
 */
export const onboardingItems = ['start', 'capability_ceiling', 'events', 'test_command', 'review_language', 'conventions', 'labels', 'schedules', 'ci'] as const;
export type OnboardingItem = typeof onboardingItems[number];
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
// Where each item takes effect, for the confirmation list and the receipts.
const where: Record<OnboardingItem, string> = {
  start: '启动项目', capability_ceiling: '项目设置 · 能力上限', events: 'Manager · 监听与触发', test_command: '项目设置 · 测试命令',
  review_language: '项目设置 · 检视语言', conventions: 'Manager 提示词与角色提示词（独立段落）', labels: 'GitHub 标签', schedules: '定时任务与通知 · 项目定时任务',
  ci: '开发任务（开 bot PR，人合并）',
};

/** The repository as the onboarding sees it (onboarding.ts) and the person's actor for it, re-read before each item. */
export interface ApplyHost {
  store: Store; service: ManagementService;
  repository(id: string): Row | undefined;
  actor(base: ActorContext, id: string): ActorContext;
}
// A start waiting for a super administrator's approval (#933) stays pending, with the request in its detail.
// A decision on it (rejected, withdrawn, lapsed) fails it with that reason.
type Outcome = { state: 'succeeded' | 'exists' | 'pending' | 'failed'; error?: string; detail?: Json };

/** The heading that marks one plan version's conventions in a prompt; its presence means they were appended already. */
const conventionsMark = (version: number) => `## 本仓库约定（接入向导第 ${version} 版`;
/** The onboarding sections of a prompt: from each such heading to the next level-two heading. */
function onboardingSections(text: string): string[] {
  return text.split(/^(?=## )/m).filter(part => part.startsWith('## 本仓库约定（接入向导第 '));
}
function conventionsBlock(plan: Json, version: number, date: string): string {
  const c = plan.conventions as Json, parts = [`${conventionsMark(version)}，${date}）`, '以下约定由项目管理员在接入向导里确认，适用于本仓库的所有工作。'];
  if (c.label_usage) parts.push('### 标签用法\n' + c.label_usage);
  if (c.review_focus) parts.push('### 检视重点\n' + c.review_focus);
  if (c.simple_issues) parts.push('### 哪些问题算"简单问题"\n' + c.simple_issues);
  return parts.join('\n\n');
}

export class OnboardingApply {
  // Repositories with an application being applied in this control plane: one at a time per repository.
  private readonly applying = new Set<string>();
  readonly requests: OnboardingRequests;
  constructor(readonly host: ApplyHost) {
    this.requests = new OnboardingRequests({ store: host.store, service: host.service, repository: id => host.repository(id), actor: (base, id) => host.actor(base, id),
      startOutcome: (application, outcome) => this.finish(application, 'start', outcome.executed_by, { state: outcome.state, error: outcome.error, detail: outcome.detail }),
      resume: (application, base) => this.run(base, application), busy: id => this.applying.has(id) });
  }
  get store() { return this.host.store; }
  /** Whether an application of this repository is being applied now (the approval of a start request waits for it). */
  applyingRepository(id: string): boolean { return this.applying.has(id); }

  /**
   * The items of `plan` that would change the repository as it is now, in the order they are applied. A started project lists
   * only what differs from its settings; a repository not started yet lists the start and every item of the plan.
   */
  changes(repository: Row, planRow: Row): Json[] {
    const plan = JSON.parse(planRow.plan) as Json, id = String(repository.id), started = !!this.store.get('SELECT 1 FROM repositories WHERE id=?', id);
    const policy = started ? this.store.get('SELECT * FROM policies WHERE repository_id=?', id) : undefined;
    const out: Json[] = [], add = (item: OnboardingItem, current: unknown, proposed: unknown, extra: Json = {}) => out.push({ item, where: where[item], current: current ?? null, proposed, ...extra });
    if (!started) {
      // A trusted organization's start uses the organization's level; the level item then moves it to the plan's.
      const trusted = trustedOrganization(this.store, String(repository.owner_id));
      add('start', null, { capability_ceiling: (plan.capability_ceiling as Json | undefined)?.value ?? null, organization_trusted: !!trusted, ...(trusted ? { organization_capability_ceiling: trustCeiling(trusted) } : {}) });
    }
    const value = (key: string) => (plan[key] as Json | undefined)?.value;
    if (value('capability_ceiling') !== undefined) { const current = policy ? projectCeiling(this.store, id, policy) : null; if (current !== value('capability_ceiling')) add('capability_ceiling', current, value('capability_ceiling')); }
    if (value('events') !== undefined) {
      const wanted = value('events') as Json, now = policy ? eventFilters(this.store, id, policy) as unknown as Json : undefined;
      const differs = Object.keys(wanted).filter(key => !now || JSON.stringify(normal(now[key])) !== JSON.stringify(normal(wanted[key])));
      if (differs.length) add('events', now ? Object.fromEntries(differs.map(key => [key, now[key]])) : null, Object.fromEntries(differs.map(key => [key, wanted[key]])));
    }
    if (value('test_command') !== undefined && (policy?.test_command || null) !== value('test_command')) add('test_command', policy ? policy.test_command || null : null, value('test_command'));
    if (value('review_language') !== undefined && (policy ? policy.review_language ?? 'auto' : null) !== value('review_language')) add('review_language', policy ? policy.review_language ?? 'auto' : null, value('review_language'));
    if (plan.conventions && !(started && this.conventionsPresent(id, plan.conventions as Json))) add('conventions', null, plan.conventions);
    // Labels to create, except those an earlier confirmation created or found; any other label on GitHub is found when applying.
    const known = new Set(this.store.all(`SELECT json_extract(l.value,'$.name') AS name FROM onboarding_receipts r JOIN onboarding_applications a ON a.id=r.application_id,
      json_each(r.detail,'$.labels') l WHERE a.repository_id=? AND r.item='labels' AND json_extract(l.value,'$.state') IN ('created','exists')`, id).map(row => String(row.name).toLowerCase()));
    const labels = (((plan.labels as Json | undefined)?.items as Json[] | undefined) ?? []).filter(label => label.action === 'create' && !known.has(String(label.name).toLowerCase()));
    if (labels.length) add('labels', null, labels);
    const schedules = ((plan.schedules as Json[] | undefined) ?? []).filter(schedule => !(started && this.scheduleNamed(id, String(schedule.name))));
    // The checks run as the project's service identity: say before the confirmation when this creates it as the person's delegation.
    if (schedules.length) add('schedules', null, schedules, { service_principal: started && this.servicePrincipal(id) ? 'existing' : 'delegated' });
    // The same CI suggestion already became a task once.
    if (plan.ci && !this.store.all(`SELECT p.plan FROM onboarding_receipts r JOIN onboarding_applications a ON a.id=r.application_id JOIN onboarding_plans p ON p.id=a.plan_id
      WHERE a.repository_id=? AND r.item='ci' AND r.state='succeeded'`, id).some(row => JSON.stringify(JSON.parse(row.plan).ci) === JSON.stringify(plan.ci))) add('ci', null, plan.ci);
    return out;
  }
  revision(changes: Json[]): string { return hash(changes); }

  /**
   * Whether an onboarding section (of any plan version) in the Manager prompt and in every working role's prompt already holds
   * each part of these conventions. Only those sections count: the same words elsewhere in a prompt are not this item.
   */
  private conventionsPresent(id: string, conventions: Json): boolean {
    const parts = Object.values(conventions).map(String), has = (text: string) => onboardingSections(text).some(section => parts.every(part => section.includes(part)));
    return has(managerText(this.store, id)) && roleTargets(this.store, id).every(role => has(String(role.persona_prompt)));
  }
  private scheduleNamed(id: string, name: string): Row | undefined {
    return this.store.get(`SELECT id FROM schedules WHERE project_id=? AND kind='project' AND state<>'deleted'
      AND json_extract(spec,'$.workflow')='manager.check' AND json_extract(spec,'$.name')=?`, id, name);
  }

  private servicePrincipal(id: string): string | undefined {
    return this.store.get("SELECT id FROM principals WHERE kind='service' AND active=1 AND project_id=? AND maintenance<>'' ORDER BY rowid LIMIT 1", id)?.id as string | undefined;
  }

  application(repositoryId: string): Json | null {
    const row = this.store.get('SELECT * FROM onboarding_applications WHERE repository_id=? ORDER BY confirmed_at DESC,rowid DESC LIMIT 1', repositoryId);
    if (!row) return null;
    const receipts = this.store.all('SELECT * FROM onboarding_receipts WHERE application_id=? ORDER BY position', row.id)
      .map(r => ({ item: r.item, where: where[r.item as OnboardingItem], state: r.state, error: r.error ?? null, detail: r.detail ? JSON.parse(r.detail) : null, executed_by: r.executed_by ?? null, attempts: r.attempts, updated_at: r.updated_at }));
    return { id: row.id, plan_id: row.plan_id, version: row.version, confirmed_by: row.confirmed_by, confirmed_at: row.confirmed_at, applying: this.applying.has(repositoryId), receipts };
  }

  /**
   * Confirms the latest plan of the repository as `changes_revision` showed it, with the chosen items, and applies them.
   * Confirming the same plan again returns its application: nothing is applied twice.
   */
  async confirm(base: ActorContext, repositoryId: string, plan: Row, input: Json): Promise<void> {
    fields(input, ['version', 'changes_revision', 'items']);
    const actor = this.host.actor(base, repositoryId), repository = this.host.repository(repositoryId)!;
    if (input.version !== plan.version) fail(409, 'onboarding_plan_outdated', 'version');
    if (this.store.get('SELECT 1 FROM onboarding_applications WHERE plan_id=?', plan.id)) return;
    // The difference is read while no other confirmation is applying, so the "already done" checks see its writes.
    if (this.applying.has(repositoryId)) fail(409, 'onboarding_apply_running');
    const changes = this.changes(repository, plan);
    if (!changes.length) fail(409, 'onboarding_nothing_to_apply');
    if (input.changes_revision !== this.revision(changes)) fail(409, 'onboarding_changes_outdated', 'changes_revision');
    const listed = changes.map(change => String(change.item));
    if (!Array.isArray(input.items) || !input.items.length || input.items.some(item => typeof item !== 'string' || !listed.includes(item)) || new Set(input.items).size !== input.items.length)
      fail(400, 'invalid_onboarding_items', 'items');
    const chosen = input.items as string[];
    // Every other item works on the project: it cannot be left out of a repository that is not started.
    if (listed.includes('start') && !chosen.includes('start')) fail(400, 'onboarding_start_required', 'items');
    const id = randomId(), time = now();
    this.store.transaction(() => {
      this.store.run('INSERT INTO onboarding_applications VALUES(?,?,?,?,?,?,?,?)', id, plan.id, repositoryId, plan.version, actor.principal_id, time, JSON.stringify(changes), '{}');
      for (const [position, item] of listed.entries())
        this.store.run('INSERT INTO onboarding_receipts(application_id,item,position,state,updated_at) VALUES(?,?,?,?,?)', id, item, position, chosen.includes(item) ? 'pending' : 'skipped', time);
      this.store.audit(actor.principal_id, 'onboarding.confirmed', String(plan.id), repositoryId);
    });
    await this.run(base, id);
  }

  /** Applies one failed item again; a start that now succeeds goes on with the items that waited for it. */
  async retry(base: ActorContext, repositoryId: string, item: string, input: Json): Promise<void> {
    fields(input, []);
    this.host.actor(base, repositoryId);
    const application = this.store.get('SELECT * FROM onboarding_applications WHERE repository_id=? ORDER BY confirmed_at DESC,rowid DESC LIMIT 1', repositoryId);
    if (!application) return fail(404, 'onboarding_application_not_found');
    const receipt = this.store.get('SELECT * FROM onboarding_receipts WHERE application_id=? AND item=?', application.id, item);
    if (!receipt) return fail(404, 'onboarding_item_not_found');
    if (receipt.state !== 'failed') fail(409, 'onboarding_item_not_failed');
    // Refused before the receipt changes: a retry that cannot run now leaves the item failed, to be retried later.
    if (this.applying.has(repositoryId)) fail(409, 'onboarding_apply_running');
    this.store.run("UPDATE onboarding_receipts SET state='pending',updated_at=? WHERE application_id=? AND item=?", now(), application.id, item);
    await this.run(base, String(application.id));
  }

  /**
   * Runs the pending items in order, one application per repository at a time. Each next item is read again, so the order
   * holds whatever became pending meanwhile. Without a started project the remaining items wait for the start.
   */
  async run(base: ActorContext, applicationId: string): Promise<void> {
    const application = this.store.get('SELECT * FROM onboarding_applications WHERE id=?', applicationId)!, id = String(application.repository_id);
    if (this.applying.has(id)) fail(409, 'onboarding_apply_running');
    this.applying.add(id);
    try {
      const plan = JSON.parse(this.store.get('SELECT plan FROM onboarding_plans WHERE id=?', application.plan_id)!.plan) as Json;
      const seen: string[] = [];
      for (let receipt; (receipt = this.store.get(`SELECT * FROM onboarding_receipts WHERE application_id=? AND state='pending'
        AND item NOT IN (SELECT value FROM json_each(?)) ORDER BY position LIMIT 1`, applicationId, JSON.stringify(seen)));) {
        const item = receipt.item as OnboardingItem; seen.push(item);
        if (item !== 'start' && !this.store.get('SELECT 1 FROM repositories WHERE id=?', id)) {
          this.store.run("UPDATE onboarding_receipts SET error='project_not_started',updated_at=? WHERE application_id=? AND item=?", now(), applicationId, item); continue;
        }
        let actor: ActorContext;
        try { actor = this.host.actor(base, id); } catch (error) { this.finish(applicationId, item, base.principal_id, error); continue; }
        this.store.run("UPDATE onboarding_receipts SET state='running',error=NULL,executed_by=?,attempts=attempts+1,updated_at=? WHERE application_id=? AND item=?", actor.principal_id, now(), applicationId, item);
        const attempt = Number(receipt.attempts) + 1;
        try { this.finish(applicationId, item, actor.principal_id, await this.apply(item, { base, actor, id, application, plan, attempt, item })); }
        catch (error) { this.finish(applicationId, item, actor.principal_id, error); }
      }
    } finally { this.applying.delete(id); }
  }
  finish(applicationId: string, item: string, principal: string, result: Outcome | unknown): void {
    const outcome = result instanceof Error || !(result as Outcome)?.state ? undefined : result as Outcome;
    // Anything but a refusal (a bug, a broken response) still ends the item as failed, so the others go on and it can be retried.
    const error = outcome ? (outcome.error ? new HttpError(409, outcome.error) : null) : result instanceof HttpError ? result : new HttpError(500, 'onboarding_item_error');
    const state = outcome?.state ?? 'failed', detail = outcome?.detail ?? (error?.field || error?.detail ? { ...(error.field ? { field: error.field } : {}), ...(error.detail as Json | undefined) } : null);
    this.store.transaction(() => {
      // Who executed it: the person applying, or for an approved start the super administrator who started the project.
      this.store.run('UPDATE onboarding_receipts SET state=?,error=?,detail=?,executed_by=?,updated_at=? WHERE application_id=? AND item=?', state, error?.code ?? null, detail ? JSON.stringify(detail) : null, principal, now(), applicationId, item);
      this.store.audit(principal, 'onboarding.item.' + state, `${applicationId}:${item}`, String(this.store.get('SELECT repository_id FROM onboarding_applications WHERE id=?', applicationId)!.repository_id));
    });
  }

  // ---- Items ----

  private async apply(item: OnboardingItem, c: ItemContext): Promise<Outcome> {
    const value = (key: string) => (c.plan[key] as Json | undefined)?.value;
    const policy = () => this.store.get('SELECT * FROM policies WHERE repository_id=?', c.id)!;
    switch (item) {
      case 'start': return this.start(c);
      case 'capability_ceiling':
        if (projectCeiling(this.store, c.id) === value('capability_ceiling')) return { state: 'exists' };
        return this.command(c, 'project.update', { capability_ceiling: value('capability_ceiling') });
      case 'events': {
        const wanted = value('events') as Json, current = eventFilters(this.store, c.id) as unknown as Json;
        if (Object.keys(wanted).every(key => JSON.stringify(normal(current[key])) === JSON.stringify(normal(wanted[key])))) return { state: 'exists' };
        return this.command(c, 'manager.update', { events: wanted });
      }
      case 'test_command':
        if ((policy().test_command || null) === value('test_command')) return { state: 'exists' };
        // Not run here: the first task or the CI task runs it, so it stays unverified until then.
        return { ...await this.command(c, 'project.update', { test_command: value('test_command') }), detail: { verified: false } };
      case 'review_language':
        if ((policy().review_language ?? 'auto') === value('review_language')) return { state: 'exists' };
        return this.command(c, 'project.update', { review_language: value('review_language') });
      case 'conventions': return this.conventions(c);
      case 'labels': return this.labels(c);
      case 'schedules': return this.schedules(c);
      case 'ci': return this.ci(c);
    }
  }

  /** One management command as the person who confirmed, keyed by application, item, attempt and step. */
  private async command(c: ItemContext, operation: string, args: Json, step = 0): Promise<Outcome> {
    const target = { project_id: c.id };
    const receipt = await this.host.service.submit(c.actor, { operation, target, arguments: args, expected_revision: this.host.service.revision(target),
      idempotency_key: `onboarding:${c.application.id}:${c.item}:${c.attempt}:${step}`,
      // A person's confirmation in the console, which is what lets the CI task change workflows (#931).
      source_conversation: 'console:onboarding:' + c.id, source_message: String(c.application.id) });
    const result = (receipt.result ?? {}) as Json;
    if (receipt.state !== 'succeeded') throw new HttpError(Number(result.http_status ?? 409), String(result.error ?? 'management_command_failed'), result.field as string | undefined, { command_id: receipt.id });
    return { state: 'succeeded', detail: { command_id: receipt.id } };
  }

  /**
   * The start (#899 ceiling included). A super administrator starts it with the plan's ceiling and the deployment's default
   * shared model; an administrator of a trusted organization's repository starts it with the organization's defaults, and
   * the ceiling item then moves it to the plan's level as they could in the console. Everyone else requests it, and a super
   * administrator approves or rejects (#933, onboarding-requests.ts).
   */
  private async start(c: ItemContext): Promise<Outcome> {
    if (this.store.get('SELECT 1 FROM repositories WHERE id=?', c.id)) return { state: 'exists' };
    const user = this.host.service.user(c.actor), repository = this.host.repository(c.id)!;
    let body: Json;
    if (user.role === 'super_admin') {
      const ceiling = this.store.get("SELECT state FROM onboarding_receipts WHERE application_id=? AND item='capability_ceiling'", c.application.id)?.state === 'pending' ? (c.plan.capability_ceiling as Json).value : undefined;
      const model = this.store.get("SELECT m.id FROM settings s JOIN models m ON m.id=json_extract(s.value,'$') AND m.repository_id IS NULL WHERE s.key='onboarding.model' AND json_valid(s.value)")?.id;
      body = { ...(ceiling ? { capability_ceiling: ceiling } : {}), ...(model ? { model_id: model } : {}) };
    } else if (trustedOrganization(this.store, String(repository.owner_id))) body = {};
    else {
      // Neither: a super administrator decides (#933). The request carries this confirmation; the other items wait for the start.
      const request = this.requests.open(c.actor, c.application, c.plan);
      return { state: 'pending', error: 'start_approval_pending', detail: { request_id: request.id } };
    }
    await installationApi(this.store, undefined, user, 'POST', new URL(`http://local/api/installations/${c.id}/activate`), body);
    const policy = this.store.get('SELECT model_id FROM policies WHERE repository_id=?', c.id);
    return { state: 'succeeded', detail: { by: user.role === 'super_admin' ? 'super_admin' : 'trusted_organization', capability_ceiling: projectCeiling(this.store, c.id), model_id: policy?.model_id ?? null } };
  }

  /**
   * The conventions as their own section, appended (never replacing anything) to the Manager prompt and to the prompt of each
   * enabled role: the saved dispatch prompt when the project has one, else the preamble of the Manager prompt, which the
   * dispatch prompt starts with. A prompt that has this version's section keeps it.
   */
  private async conventions(c: ItemContext): Promise<Outcome> {
    const version = Number(c.application.version), mark = conventionsMark(version), block = conventionsBlock(c.plan, version, String(c.application.confirmed_at).slice(0, 10));
    const done: Json = { manager: 'present', roles: [] as string[] };
    const currentText = managerText(this.store, c.id);
    if (!currentText.includes(mark)) {
      const current = managerPrompt(this.store, c.id);
      await this.command(c, 'manager.update', { expected_revision: current.revision, prompt: currentText.trimEnd() + '\n\n' + block }, 0);
      done.manager = 'appended';
    }
    const roles = roleTargets(this.store, c.id).filter(role => !String(role.persona_prompt).includes(mark));
    if (roles.length) {
      const config = roleConfiguration(this.store, c.id);
      await this.command(c, 'roles.update', { expected_revision: config.revision,
        roles: roles.map(role => ({ ...Object.fromEntries(roleKeys.filter(key => key in role).map(key => [key, (role as unknown as Json)[key]])), persona_prompt: role.persona_prompt + '\n\n' + block })) }, 1);
      done.roles = roles.map(role => role.role_id);
    }
    return { state: done.manager === 'present' && !(done.roles as string[]).length ? 'exists' : 'succeeded', detail: done };
  }

  /**
   * Labels on GitHub through github_write (`POST /labels`), as the person who confirmed. A label that exists already stays as
   * it is, colour and description included, and counts as existing; keyed writes are never sent twice.
   */
  private async labels(c: ItemContext): Promise<Outcome> {
    const wanted = (((c.plan.labels as Json).items as Json[]) ?? []).filter(label => label.action === 'create');
    const repository = this.store.get('SELECT * FROM repositories WHERE id=?', c.id)!, redactor = new Redactor();
    const guard = async () => { this.host.actor(c.base, c.id); };
    const reads = new ServiceRepositories(this.store, redactor, guard, () => repository, () => Object.keys(agentReadPermissions), this.host.service.githubUrl);
    const existing = new Set<string>();
    try {
      for (let page = 1; page <= 10; page++) {
        const read = await reads.execute('github_read', { repository: repository.full_name, path: `/labels?per_page=100&page=${page}` }) as Json;
        // github_read reports its own failures inside the result.
        const failure = read.error ?? (read.result as Json | undefined)?.error;
        if (failure || !Array.isArray(read.result)) return fail(502, 'labels_unreadable', undefined, failure ? { reason: failure } : undefined);
        for (const label of read.result as Json[]) existing.add(String(label.name).toLowerCase());
        if ((read.result as Json[]).length < 100) break;
      }
    } finally { await reads.close(); }
    const results: Json[] = [];
    for (const label of wanted) {
      if (existing.has(String(label.name).toLowerCase())) { results.push({ name: label.name, state: 'exists' }); continue; }
      const sent = await githubWrite({ store: this.store, repository, redactor, guard, apiUrl: this.host.service.githubUrl, scope: `onboarding:${c.application.id}`,
        actor: { kind: 'management', principal_id: c.actor.principal_id, source_message: String(c.application.id) },
        // Only the label route: issues is the resource GitHub files labels under.
        allowed: resource => resource === 'issues' }, { method: 'POST', path: '/labels', body: { name: label.name, color: label.color, ...(label.description ? { description: label.description } : {}) }, key: 'label:' + String(label.name).toLowerCase() });
      results.push(sent?.error ? { name: label.name, state: 'failed', error: sent.error } : { name: label.name, state: 'created' });
    }
    const failed = results.filter(r => r.state === 'failed');
    if (failed.length) return fail(502, 'labels_failed', undefined, { labels: results });
    return { state: results.every(r => r.state === 'exists') ? 'exists' : 'succeeded', detail: { labels: results } };
  }

  /**
   * Manager checks (#851) as project scheduled tasks. They run as the project's service identity: a project without one gets it
   * here, as the confirming administrator's delegation (shown in the confirmation). Their results stay in the project (#1027).
   */
  private async schedules(c: ItemContext): Promise<Outcome> {
    const wanted = (c.plan.schedules as Json[]).filter(schedule => !this.scheduleNamed(c.id, String(schedule.name)));
    if (!wanted.length) return { state: 'exists' };
    let service = this.servicePrincipal(c.id);
    const created = !service;
    service ??= createProjectServicePrincipal(this.store, c.actor, c.id, `接入向导第 ${c.application.version} 版的 Manager 定时检查`);
    const done: string[] = [];
    for (const [i, schedule] of wanted.entries()) {
      await this.command(c, 'schedule.register', { plan: { name: schedule.name, kind: 'project', actor_id: service, owner_id: c.actor.principal_id, maintainer_id: c.actor.principal_id,
        workflow: 'manager.check', parameters: { instruction: schedule.instruction }, timezone: schedule.timezone, cron: schedule.cron, start_at: Date.parse(String(c.application.confirmed_at)),
        enabled: true, misfire: 'skip', grace_ms: 60000, limits: defaultLimits } }, i);
      done.push(String(schedule.name));
    }
    return { state: 'succeeded', detail: { schedules: done, service_principal: service, service_principal_created: created } };
  }

  /**
   * The CI suggestion as an ordinary development task whose contract is the suggestion (#931). The person confirmed the CI
   * item, so the task may change `.github/workflows/` (workflow_changes): its bot branch asks for Workflows when it is pushed,
   * and a person merges its PR.
   */
  private async ci(c: ItemContext): Promise<Outcome> {
    // An earlier attempt whose task was created before the receipt could say so (a restart in between) is that task.
    const earlier = this.store.get("SELECT id,result FROM management_commands WHERE idempotency_key LIKE ? AND operation='task.create' AND state='succeeded' ORDER BY rowid LIMIT 1",
      `onboarding:${c.application.id}:ci:%`);
    if (earlier) return { state: 'succeeded', detail: { command_id: earlier.id, task_id: JSON.parse(earlier.result).id ?? null } };
    const ci = c.plan.ci as Json, files = (ci.files as string[]).length ? ci.files as string[] : ['.github/workflows/'];
    const created = await this.command(c, 'task.create', { intent: 'development', workflow_changes: true, request: `接入向导第 ${c.application.version} 版确认的 CI 建议：\n\n${ci.summary}`,
      contract: { goal: `按接入向导确认的建议调整本仓库的 CI：${String(ci.summary).slice(0, 2000)}`, scope: files.slice(0, 50),
        criteria: ['改动经 bot PR 交付，由人检视并合并；不直接修改默认分支', '只改建议列出的文件，必要时在 PR 里说明额外改动的原因'], endpoint: 'reviewable_pull_request' } });
    const receipt = this.store.get('SELECT result FROM management_commands WHERE id=?', String((created.detail as Json).command_id));
    const result = receipt ? JSON.parse(receipt.result) : {};
    return { state: 'succeeded', detail: { command_id: (created.detail as Json).command_id, task_id: result.id ?? result.task?.id ?? null } };
  }
}

interface ItemContext { base: ActorContext; actor: ActorContext; id: string; application: Row; plan: Json; attempt: number; item: OnboardingItem }
// The fields roles.update keeps for a role it is given (see roles/definition.ts); a role sent without one loses it.
const roleKeys = ['role_id', 'enabled', 'name', 'responsibility', 'persona_prompt', 'model_profile_ref', 'skill_bundle_ref', 'harness_ref', 'permissions', 'environment_profile_ref', 'budget_policy_ref', 'output_schema_ref'];
/** The roles that get the conventions: the enabled ones that work on the repository (not the cross-task coordinator). */
const roleTargets = (store: Store, id: string) => roleConfiguration(store, id).roles.filter(role => role.enabled && role.role_id !== 'coordinator');
/** The Manager text the dispatch reads: the project's effective unified Manager prompt. */
function managerText(store: Store, id: string): string {
  return effectiveManagerPrompt(store, id);
}
// Label lists compare as sets.
const normal = (value: unknown) => Array.isArray(value) ? [...value].map(String).sort() : value;
