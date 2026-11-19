import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store, Row } from '../storage/database.js';
import { fail, HttpError, randomId, type Json } from '../core/security.js';
import { assertCurrent, authorize, holdsInTenant, resolvePrincipalActor, type ActorContext } from '../identity/authorization.js';
import { pendingInstalledRepositories } from '../identity/github-status.js';
import { installationApi } from '../app/installations.js';
import { trustedOrganization } from '../app/trusted-organizations.js';
import { projectCeiling } from '../work/ceiling.js';
import { obj } from './catalog-base.js';
import { OnboardingApply } from './onboarding-apply.js';
import type { ManagementService } from './service.js';

/**
 * Repository onboarding (#929, #930, unified into the management assistant in #1133).
 * Administrators onboard installed repositories directly in standard management assistant conversations:
 * read-only repository inspection before start, starting or filing a start request via `start_repository`,
 * and applying confirmed settings via standard management commands. Earlier plan drafts, applications and
 * start requests remain compatible in storage so in-flight start requests (#933) keep working seamlessly.
 */
export const onboardingScope = (repository: string) => 'onboarding:' + repository;
export const onboardingRepositoryOf = (scope: unknown) => typeof scope === 'string' && scope.startsWith('onboarding:') ? scope.slice(11) : null;
export const onboardingInstructions = readFileSync(resolve(import.meta.dirname, '../../docs/prompts/onboarding.md'), 'utf8');

/** The repository onboarding reads or starts: a started project, or an unstarted installed repository. */
export function onboardingRepository(store: Store, id: string): Row | undefined {
  const registered = store.get('SELECT id,full_name,owner_id,account_id FROM repositories WHERE id=?', id);
  if (registered) return { ...registered, started: true };
  const installed = store.get(`SELECT i.repository_id AS id,i.full_name,i.owner_id,i.account_id FROM installed_repositories i JOIN accounts a ON a.id=i.account_id
    WHERE i.repository_id=? AND i.installed=1 AND i.hidden=0 ORDER BY (a.type='github_app') DESC,i.synced_at DESC LIMIT 1`, id)
    ?? store.get(`SELECT r.repository_id AS id,r.full_name,r.owner_id,g.account_id AS account_id FROM installation_repositories r
      JOIN github_installations g ON g.ref=r.installation_ref
      WHERE r.repository_id=? AND r.present=1 AND g.status='active'
      AND NOT EXISTS(SELECT 1 FROM installed_repositories h WHERE h.repository_id=r.repository_id AND h.hidden=1)
      ORDER BY g.revision DESC LIMIT 1`, id);
  return installed ? { ...installed, started: false } : undefined;
}

/**
 * Who may run it: a project administrator (config.write, delegations included) of a started project; for one not started
 * yet, an administrator GitHub derived a grant for (as for starting it, #848) or a super administrator. Everyone else gets
 * repository_admin_required.
 */
export function onboardingAccess(store: Store, actor: ActorContext, id: string): Row {
  assertCurrent(actor);
  const repository = onboardingRepository(store, id);
  if (!repository) return fail(404, 'repository_not_installed');
  const tenant = 'github.com:' + repository.owner_id;
  if (actor.tenant_id && actor.tenant_id !== tenant || actor.project_id && actor.project_id !== id) fail(403, 'repository_admin_required');
  const allowed = (check: () => void) => { try { check(); return true; } catch (error) { if (error instanceof HttpError && error.status === 403) return false; throw error; } };
  if (repository.started ? !allowed(() => authorize(actor, 'config.write', { project_id: id }))
    : !allowed(() => authorize(actor, 'platform.manage')) && !pendingInstalledRepositories(store, actor.principal_id, actor.tenant_id).some(repo => repo.id === id))
    fail(403, 'repository_admin_required');
  return repository;
}

export const startRepositoryName = 'start_repository';
export const startRepositoryTool = { type: 'function', function: { name: startRepositoryName,
  description: 'Start an installed repository, check its start request status, or withdraw its pending start request. '
    + 'Use action "start" only after the administrator explicitly confirms starting the repository in this conversation: '
    + 'super administrators and administrators of trusted organizations start the project immediately; administrators of untrusted organizations file a start request for a super administrator to approve. '
    + 'model_id and trust_organization apply only when the caller is a super administrator.',
  parameters: obj({
    action: { type: 'string', enum: ['start', 'status', 'withdraw'] },
    repository: { type: 'string', minLength: 1, maxLength: 256, description: 'Authorized repository full_name (owner/name) or numeric id.' },
    capability_ceiling: { type: 'string', enum: ['read', 'comment', 'develop'], description: 'Confirmed capability ceiling for the newly started project.' },
    model_id: { type: 'string', minLength: 1, maxLength: 128, description: 'Shared model id to assign at start (super administrator only).' },
    trust_organization: { type: 'boolean', description: 'Also mark the repository owner organization as trusted (super administrator only).' },
    summary: { type: 'string', maxLength: 4000, description: 'Concise summary of the repository profile and intended setup, shown to super administrators when a start request is filed.' },
  }, ['action', 'repository']) } };

export class RepositoryOnboarding {
  readonly apply: OnboardingApply;
  constructor(readonly store: Store, readonly service: ManagementService) {
    this.apply = new OnboardingApply({ store, service, repository: id => onboardingRepository(store, id), actor: (actor, id) => this.actor(actor, id) });
  }
  /** The actor scoped to a repository, after checking the person may administer it. */
  actor(actor: ActorContext, repositoryId: string): ActorContext {
    const repository = onboardingRepository(this.store, repositoryId);
    if (!repository) return fail(404, 'repository_not_installed');
    if (actor.tenant_id && actor.tenant_id !== 'github.com:' + repository.owner_id || actor.project_id && actor.project_id !== repositoryId) fail(403, 'scope_forbidden');
    const scoped = resolvePrincipalActor(this.store, actor.principal_id, 'github.com:' + repository.owner_id, repository.started ? repositoryId : undefined, actor.channel, actor);
    onboardingAccess(this.store, scoped, repositoryId);
    return scoped;
  }
  /** Executes the management assistant's `start_repository` tool (#1133). */
  async tool(actor: ActorContext, args: Json): Promise<Json> {
    const selected = String(args.repository);
    const registered = this.store.get('SELECT id,full_name,owner_id,account_id FROM repositories WHERE id=? OR full_name=?', selected, selected);
    if (registered) {
      const id = String(registered.id);
      if (!this.service.projects(actor).includes(id)) return { state: 'failed', error: 'repository_not_found' };
      try { authorize(actor, 'config.write', { project_id: id }); }
      catch (error) { if (error instanceof HttpError && error.status === 403) return { state: 'failed', error: 'repository_admin_required' }; throw error; }
      const ceiling = projectCeiling(this.store, id);
      if (args.action === 'status')
        return { state: 'started', repository: { id, full_name: registered.full_name, started: true, organization_trusted: !!trustedOrganization(this.store, String(registered.owner_id)) },
          capability_ceiling: ceiling, request: this.apply.requests.latest(id) };
      if (args.action === 'withdraw')
        return { state: 'already_started', error: 'onboarding_request_not_found', repository: { id, full_name: registered.full_name, started: true } };
      return { state: 'already_started', repository: { id, full_name: registered.full_name, started: true }, capability_ceiling: ceiling, revision: this.service.revision({ project_id: id }) };
    }
    const pending = this.service.pendingRepository(actor, selected);
    if (!pending) {
      const installed = this.service.findInstalledRepository(selected);
      if (installed && (!actor.project_id || actor.project_id === String(installed.id)) && (!actor.tenant_id || actor.tenant_id === 'github.com:' + installed.owner_id)
        && holdsInTenant(actor, 'tasks.read', 'github.com:' + installed.owner_id)) return { state: 'failed', error: 'repository_admin_required' };
      return { state: 'failed', error: 'repository_not_found' };
    }
    const id = String(pending.id), trusted = !!trustedOrganization(this.store, String(pending.owner_id));
    if (args.action === 'status') {
      const request = this.apply.requests.latest(id);
      return { state: request?.state === 'pending' ? 'start_requested' : 'unstarted', repository: { id, full_name: pending.full_name, started: false, organization_trusted: trusted }, request };
    }
    if (args.action === 'withdraw') {
      try { this.apply.requests.withdraw(actor, id, {}); }
      catch (error) { if (error instanceof HttpError && [404, 409].includes(error.status)) return { state: 'failed', error: error.code }; throw error; }
      return { state: 'withdrawn', repository: { id, full_name: pending.full_name, started: false, organization_trusted: trusted }, request: this.apply.requests.latest(id) };
    }
    const user = this.service.user(actor);
    if (user.role !== 'super_admin' && (args.model_id !== undefined || args.trust_organization !== undefined))
      return { state: 'failed', error: 'super_admin_required' };
    try {
      if (user.role === 'super_admin') {
        const model = (args.model_id as string | undefined)
          ?? this.store.get("SELECT m.id FROM settings s JOIN models m ON m.id=json_extract(s.value,'$') AND m.repository_id IS NULL WHERE s.key='onboarding.model' AND json_valid(s.value)")?.id;
        await installationApi(this.store, undefined, user, 'POST', new URL(`http://local/api/installations/${id}/activate`),
          { ...(args.capability_ceiling ? { capability_ceiling: args.capability_ceiling } : {}), ...(model ? { model_id: model } : {}), ...(args.trust_organization ? { trust_organization: true } : {}) });
      } else if (trusted) {
        await installationApi(this.store, undefined, user, 'POST', new URL(`http://local/api/installations/${id}/activate`), {});
      } else {
        this.apply.requests.openDirect(actor, pending, { capability_ceiling: args.capability_ceiling as string | undefined, summary: args.summary as string | undefined });
        return { state: 'start_requested', repository: { id, full_name: pending.full_name, started: false, organization_trusted: false }, request: this.apply.requests.latest(id) };
      }
    } catch (error) {
      if (error instanceof HttpError) return { state: 'failed', error: error.code };
      throw error;
    }
    this.service.reconcileProjects?.();
    // Settle any pending start request now that the repository has been started directly.
    this.apply.requests.lapse(id);
    if (user.role !== 'super_admin' && args.capability_ceiling && projectCeiling(this.store, id) !== args.capability_ceiling) {
      const receipt = await this.service.submit(actor, { operation: 'project.update', target: { project_id: id },
        arguments: { capability_ceiling: args.capability_ceiling }, expected_revision: this.service.revision({ project_id: id }),
        idempotency_key: 'start_repository:' + randomId(), source_conversation: 'management:start_repository', source_message: actor.request_id });
      if (receipt.state !== 'succeeded')
        return { state: 'started', by: 'trusted_organization', repository: { id, full_name: pending.full_name, started: true },
          capability_ceiling: projectCeiling(this.store, id), ceiling_update_error: (receipt.result as Json)?.error ?? 'management_command_failed',
          revision: this.service.revision({ project_id: id }) };
    }
    const policy = this.store.get('SELECT model_id FROM policies WHERE repository_id=?', id);
    return { state: 'started', by: user.role === 'super_admin' ? 'super_admin' : 'trusted_organization',
      repository: { id, full_name: pending.full_name, started: true }, capability_ceiling: projectCeiling(this.store, id),
      model_id: policy?.model_id ?? null, revision: this.service.revision({ project_id: id }) };
  }
}
