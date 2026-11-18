import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store, Row } from '../storage/database.js';
import { fail, HttpError, randomId, type Json } from '../core/security.js';
import { assertCurrent, authorize, resolvePrincipalActor, type ActorContext } from '../identity/authorization.js';
import { pendingInstalledRepositories } from '../identity/github-status.js';
import { stop, type Redactor } from '../agent/common.js';
import { openModel, type RuntimeModel } from '../agent/model.js';
import { agentReadPermissions } from '../github/client.js';
import { trustedOrganization } from '../app/trusted-organizations.js';
import { managementAssistant, serviceRole, serviceRoleModel } from '../service-roles/roles.js';
import { ServiceRepositories } from '../service-roles/resources.js';
import { projectCeiling } from '../work/ceiling.js';
import { checkFilters, eventFilters } from '../work/settings.js';
import { reservedLabel } from '../review/labels.js';
import { developingColor, developingDescription } from '../review/progress.js';
import { developingLabel } from '../rules/service.js';
import { localParts, parseCron } from '../schedules/time.js';
import { obj } from './catalog-base.js';
import { OnboardingApply } from './onboarding-apply.js';
import type { ManagementService } from './service.js';

/**
 * Repository onboarding (#929, #930). An administrator of a repository talks with the management assistant about how the
 * bot should work there, before the project is started or later to re-run it. The assistant only reads that repository,
 * with read-only installation tokens revoked at the end of each turn; it asks questions with recommended answers and
 * saves plan drafts. Nothing is written to GitHub and no setting changes in the conversation: a plan is applied only when an
 * administrator confirms it (#932, onboarding-apply.ts).
 *
 * A session belongs to the repository, not to a person: one is open at a time, and every administrator of the repository
 * opens the same conversation (a management conversation whose scope is `onboarding:<repository id>`).
 */
export const onboardingScope = (repository: string) => 'onboarding:' + repository;
export const onboardingRepositoryOf = (scope: unknown) => typeof scope === 'string' && scope.startsWith('onboarding:') ? scope.slice(11) : null;
const now = () => new Date().toISOString();
const instructions = readFileSync(resolve(import.meta.dirname, '../../docs/prompts/onboarding.md'), 'utf8');

/** The repository a session reads: a started project, or one installed through a GitHub App that is not started yet. */
export function onboardingRepository(store: Store, id: string): Row | undefined {
  const registered = store.get('SELECT id,full_name,owner_id,account_id FROM repositories WHERE id=?', id);
  if (registered) return { ...registered, started: true };
  const installed = store.get(`SELECT i.repository_id AS id,i.full_name,i.owner_id,i.account_id FROM installed_repositories i JOIN accounts a ON a.id=i.account_id
    WHERE i.repository_id=? AND i.installed=1 AND a.type='github_app' ORDER BY i.synced_at DESC LIMIT 1`, id);
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

// ---- Tools ----

const s = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const list = (items: Json, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const reason = s(2000), flag = { type: 'boolean' }, labels = list(s(50), 30);
const question = obj({ id: s(40), question: s(500), options: list(obj({ label: s(200), description: s(500) }, ['label']), 5, 2), recommended: s(200), reason },
  ['id', 'question', 'options', 'recommended', 'reason']);
// The keys of the Manager's event switches (src/work/settings.ts, checked there again).
const events = obj({ 'issue.opened': flag, 'issue.updated': flag, 'issue.mention': flag, 'issue.labels': labels, 'issue.development_label': flag,
  'pull_request.opened': flag, 'pull_request.synchronize': flag, 'pull_request.updated': flag, 'pull_request.mention': flag, 'pull_request.labels': labels,
  'review.published.issue': flag, 'review.published.pr': flag, 'actions.run_failed': flag });
const label = obj({ name: s(50), color: { type: 'string', pattern: '^[0-9a-fA-F]{6}$' }, description: { type: 'string', maxLength: 100 }, action: { type: 'string', enum: ['create', 'keep'] } },
  ['name', 'color', 'action']);
export const planSchema = obj({
  profile: obj({ summary: s(4000), stack: list(s(100), 20), collaboration: s(2000), ci: s(2000), labels: s(2000), activity: s(2000), sources: list(s(300), 60, 1) }, ['summary', 'sources']),
  capability_ceiling: obj({ value: { type: 'string', enum: ['read', 'comment', 'develop'] }, reason }, ['value', 'reason']),
  events: obj({ value: events, reason }, ['value', 'reason']),
  test_command: obj({ value: s(2048), reason }, ['value', 'reason']),
  review_language: obj({ value: { type: 'string', enum: ['auto', 'zh', 'en'] }, reason }, ['value', 'reason']),
  labels: obj({ items: list(label, 30, 1), reason }, ['items', 'reason']),
  conventions: obj({ label_usage: s(4000), review_focus: s(4000), simple_issues: s(4000) }),
  ci: obj({ summary: s(4000), files: list(s(300), 50) }, ['summary', 'files']),
  schedules: list(obj({ name: s(80), cron: s(100), timezone: s(64), instruction: s(4000) }, ['name', 'cron', 'timezone', 'instruction']), 5, 1),
  feishu: obj({ level: { type: 'string', enum: ['read', 'comment', 'dispatch'] }, reason }, ['level', 'reason']),
  // A recommendation only, like feishu (#1072): workflows with on.schedule that the bot could start on time. Nothing is
  // applied; the page hands it to the management assistant or the schedules page.
  scheduled_dispatch: obj({ workflows: list(obj({ path: s(300), cron: s(200), delay: s(500) }, ['path', 'cron']), 10, 1), reason }, ['workflows', 'reason']),
}, ['profile']);
const fn = (name: string, description: string, parameters: Json) => ({ type: 'function', function: { name, description, parameters } });
export const onboardingTools = [
  fn('ask_onboarding_questions', 'Show the administrator up to five questions that change the plan, each with two to five options, the option you recommend (its label) and why. They answer by choosing, editing or in their own words in a later message: end your turn after asking.',
    obj({ questions: list(question, 5, 1) }, ['questions'])),
  fn('propose_onboarding_plan', 'Save the onboarding plan as a new draft version, replacing the previous draft. Include only the items you recommend; every item maps to an existing setting. Nothing is applied until the administrator confirms the plan.',
    planSchema),
];
export const onboardingToolNames = onboardingTools.map(tool => tool.function.name);

const join = (path: string, key: string | number) => path ? `${path}.${key}` : String(key);
/** The first field of `value` that does not match the closed schema, or null. */
function mismatch(schema: Json, value: unknown, path = ''): string | null {
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return path;
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return path;
      const properties = (schema.properties ?? {}) as Record<string, Json>;
      for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(value, key)) return join(path, key);
      for (const [key, item] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) return join(path, key);
        const found = mismatch(properties[key]!, item, join(path, key)); if (found !== null) return found;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value) || value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems)) return path;
      for (const [i, item] of value.entries()) { const found = mismatch(schema.items as Json, item, join(path, i)); if (found !== null) return found; }
      return null;
    }
    case 'string': {
      const max = Number(schema.maxLength ?? 60000);
      if (typeof value !== 'string' || value.length > max || schema.minLength && !value.trim()) return path;
      // Names and other short fields stay on one line; longer texts may break lines, never hold other control characters.
      const control = max <= 300 ? /\p{Cc}/u : /[^\P{Cc}\n\r\t]/u;
      return control.test(value) || schema.pattern && !new RegExp(String(schema.pattern)).test(value) ? path : null;
    }
    case 'boolean': return typeof value === 'boolean' ? null : path;
  }
  return null;
}
type Problem = { error: string; field: string; reason?: string };
const invalid = (error: string, field: string, reason?: string): Problem => ({ error, field, ...(reason ? { reason } : {}) });
/** Why a plan cannot be saved, or null: the schema, then what only the settings know. */
export function planProblem(plan: unknown): Problem | null {
  const field = mismatch(planSchema, plan);
  if (field !== null) return invalid('invalid_onboarding_plan', field);
  const value = plan as Json, seen = new Set<string>();
  for (const [i, item] of ((value.labels as Json | undefined)?.items as Json[] ?? []).entries()) {
    const name = String(item.name);
    if (name !== name.trim()) return invalid('invalid_onboarding_plan', `labels.items.${i}.name`, 'label_name_spaces');
    if (reservedLabel(name)) return invalid('invalid_onboarding_plan', `labels.items.${i}.name`, 'reserved_label');
    if (seen.has(name.toLowerCase())) return invalid('invalid_onboarding_plan', `labels.items.${i}.name`, 'duplicate_label');
    seen.add(name.toLowerCase());
  }
  if (value.events) try { checkFilters((value.events as Json).value); } catch (error) { if (error instanceof HttpError) return invalid('invalid_onboarding_plan', error.field ?? 'events', error.code); throw error; }
  if (value.conventions && !Object.keys(value.conventions).length) return invalid('invalid_onboarding_plan', 'conventions', 'empty');
  for (const [i, item] of ((value.schedules ?? []) as Json[]).entries()) {
    try { parseCron(String(item.cron)); } catch { return invalid('invalid_onboarding_plan', `schedules.${i}.cron`, 'invalid_schedule_cron'); }
    try { localParts(Date.now(), String(item.timezone)); } catch { return invalid('invalid_onboarding_plan', `schedules.${i}.timezone`, 'invalid_schedule_timezone'); }
  }
  return null;
}
/**
 * A plan that lets the bot develop (`develop`) also creates the label the bot keeps on an Issue while it develops it (#1047),
 * unless the plan names that label already or the project keeps none. A label the repository has is found when applying.
 */
export function withDevelopingLabel(plan: Json, label: string): Json {
  if ((plan.capability_ceiling as Json | undefined)?.value !== 'develop' || !label) return plan;
  const items = ((plan.labels as Json | undefined)?.items as Json[] | undefined) ?? [];
  if (items.some(item => String(item.name).toLowerCase() === label.toLowerCase())) return plan;
  const developing = { name: label, color: developingColor, description: developingDescription, action: 'create' };
  return { ...plan, labels: plan.labels ? { ...(plan.labels as Json), items: [...items, developing] }
    : { items: [developing], reason: 'bot 开发 Issue 期间给它加这个标签，开出 PR 或停下时去掉。' } };
}
export function questionsProblem(args: unknown): Problem | null {
  const field = mismatch(onboardingTools[0]!.function.parameters, args);
  if (field !== null) return invalid('invalid_onboarding_questions', field);
  const ids = new Set<string>();
  for (const [i, item] of ((args as Json).questions as Json[]).entries()) {
    if (ids.has(String(item.id))) return invalid('invalid_onboarding_questions', `questions.${i}.id`, 'duplicate_question');
    ids.add(String(item.id));
    const options = (item.options as Json[]).map(option => String(option.label));
    if (new Set(options).size !== options.length) return invalid('invalid_onboarding_questions', `questions.${i}.options`, 'duplicate_option');
    if (!options.includes(String(item.recommended))) return invalid('invalid_onboarding_questions', `questions.${i}.recommended`, 'not_an_option');
  }
  return null;
}

// ---- Model ----

/**
 * The model of a turn: the default model of the repository's trusted organization (#848) when it has one that is still
 * shared, else the management assistant's own shared model. Without either the turn stops with the assistant's
 * configuration notice; it never borrows a project's model.
 */
export function onboardingModel(store: Store, repository: Row): { model: RuntimeModel; trusted_owner?: string; source: 'organization' | 'assistant' } {
  const trusted = trustedOrganization(store, String(repository.owner_id));
  const row = trusted?.model_id ? store.get('SELECT * FROM models WHERE id=? AND repository_id IS NULL', trusted.model_id) : undefined;
  if (row?.api_key) {
    if (!serviceRole(store, managementAssistant)?.enabled) return stop('service_role_unavailable', 'waiting_configuration', `服务角色 ${managementAssistant} 不存在或已停用。`);
    return { model: openModel(store, row), trusted_owner: String(repository.owner_id), source: 'organization' };
  }
  return { model: serviceRoleModel(store, managementAssistant), source: 'assistant' };
}
function modelView(store: Store, repository: Row): Json {
  try { const chosen = onboardingModel(store, repository); return { available: true, source: chosen.source, name: chosen.model.model }; }
  catch (error) { return { available: false, error: (error as { code?: string }).code ?? 'model_unavailable', notice: (error as { detail?: string }).detail ?? null }; }
}

// ---- Sessions ----

export interface OnboardingTurn {
  repository: Row; system: string; tools: Json[]; model: RuntimeModel; task: Json; context: Json; repositories: ServiceRepositories;
  execute(name: string, args: Json): Json;
}
export class RepositoryOnboarding {
  readonly apply: OnboardingApply;
  constructor(readonly store: Store, readonly service: ManagementService) {
    this.apply = new OnboardingApply({ store, service, repository: id => onboardingRepository(store, id), actor: (actor, id) => this.actor(actor, id) });
  }
  get githubUrl() { return this.service.githubUrl; }
  /** The actor of an onboarding conversation, after checking the person may run it. */
  actor(actor: ActorContext, repositoryId: string): ActorContext {
    const repository = onboardingRepository(this.store, repositoryId);
    if (!repository) return fail(404, 'repository_not_installed');
    // A session limited to one organization or project in the console opens only that one, as other conversations do.
    if (actor.tenant_id && actor.tenant_id !== 'github.com:' + repository.owner_id || actor.project_id && actor.project_id !== repositoryId) fail(403, 'scope_forbidden');
    const scoped = resolvePrincipalActor(this.store, actor.principal_id, 'github.com:' + repository.owner_id, repository.started ? repositoryId : undefined, actor.channel, actor);
    onboardingAccess(this.store, scoped, repositoryId);
    return scoped;
  }
  session(repositoryId: string): Row | undefined { return this.store.get("SELECT * FROM onboarding_sessions WHERE repository_id=? AND state='open'", repositoryId); }
  sessionOf(conversation: string): Row | undefined { return this.store.get('SELECT * FROM onboarding_sessions WHERE conversation_id=?', conversation); }
  latestPlan(repositoryId: string, session?: string): Row | undefined {
    return this.store.get(`SELECT * FROM onboarding_plans WHERE repository_id=? ${session ? 'AND session_id=?' : ''} ORDER BY version DESC LIMIT 1`, repositoryId, ...(session ? [session] : []));
  }
  /** What the onboarding page shows: the repository, the open session, its latest questions and plan draft, and the model. */
  view(base: ActorContext, repositoryId: string): Json {
    const actor = this.actor(base, repositoryId), repository = onboardingRepository(this.store, repositoryId)!, session = this.session(repositoryId);
    const plan = session ? this.latestPlan(repositoryId, session.id) : undefined;
    assertCurrent(actor);
    return { repository: { id: repository.id, full_name: repository.full_name, started: repository.started, organization_trusted: !!trustedOrganization(this.store, String(repository.owner_id)) },
      session: session ? { id: session.id, conversation_id: session.conversation_id, state: session.state, created_at: session.created_at, updated_at: session.updated_at } : null,
      questions: session?.questions ? JSON.parse(session.questions) : null,
      plan: plan ? { id: plan.id, version: plan.version, created_at: plan.created_at, plan: JSON.parse(plan.plan), ...this.pending(repository, plan) } : null,
      // The latest confirmed plan and its receipts (#932), whether or not a session is open, and its start request (#933).
      application: this.apply.application(repositoryId), request: this.apply.requests.latest(repositoryId),
      model: modelView(this.store, repository),
      // This session's model usage, billed to the management assistant and, once the project exists, to the repository.
      usage: session ? { ...this.store.get(`SELECT count(*) AS requests,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens FROM model_requests WHERE conversation_id=?`, session.conversation_id),
        costs: this.store.all('SELECT currency,sum(cost) AS amount FROM model_requests WHERE conversation_id=? AND cost IS NOT NULL GROUP BY currency ORDER BY currency', session.conversation_id) } : null };
  }
  /**
   * What confirming this plan would change now (#932): the items that differ from the project, and the revision of that list
   * a confirmation names. A plan that was confirmed already shows its application instead.
   */
  private pending(repository: Row, plan: Row): Json {
    if (this.store.get('SELECT 1 FROM onboarding_applications WHERE plan_id=?', plan.id)) return { confirmed: true };
    const changes = this.apply.changes(repository, plan);
    return { confirmed: false, changes, changes_revision: this.apply.revision(changes) };
  }
  /** Confirms the latest plan draft of the repository with the chosen items and applies them (#932). */
  async confirm(base: ActorContext, repositoryId: string, input: Json): Promise<Json> {
    this.actor(base, repositoryId);
    const plan = this.latestPlan(repositoryId);
    if (!plan) return fail(404, 'onboarding_plan_not_found');
    await this.apply.confirm(base, repositoryId, plan, input);
    return this.view(base, repositoryId);
  }
  /** Withdraws the repository's open start request (#933); the start item fails and may be retried to request again. */
  withdraw(base: ActorContext, repositoryId: string, input: Json): Json {
    this.apply.requests.withdraw(base, repositoryId, input);
    return this.view(base, repositoryId);
  }
  /** Applies one failed item of the latest confirmed plan again (#932). */
  async retry(base: ActorContext, repositoryId: string, item: string, input: Json): Promise<Json> {
    await this.apply.retry(base, repositoryId, item, input);
    return this.view(base, repositoryId);
  }
  /** Opens the repository's session, or returns the one already open; the conversation is created with it. */
  open(base: ActorContext, repositoryId: string): Json {
    const actor = this.actor(base, repositoryId);
    this.store.transaction(() => {
      if (this.session(repositoryId)) return;
      const conversation = randomId(), time = now();
      this.store.run('INSERT INTO management_conversations VALUES(?,?,?,?,?)', conversation, actor.principal_id, actor.tenant_id ?? '', onboardingScope(repositoryId), time);
      this.store.run("INSERT INTO onboarding_sessions(id,repository_id,conversation_id,state,created_by,created_at,updated_at) VALUES(?,?,?,'open',?,?,?)", randomId(), repositoryId, conversation, actor.principal_id, time, time);
      this.store.audit(actor.principal_id, 'onboarding.opened', repositoryId, repositoryId);
    });
    return this.view(base, repositoryId);
  }
  /** Ends the open session; its conversation and drafts stay readable, and the next open starts a new one. */
  close(base: ActorContext, repositoryId: string): Json {
    const actor = this.actor(base, repositoryId), session = this.session(repositoryId);
    if (!session) return fail(404, 'onboarding_session_not_found');
    if (this.store.get("SELECT 1 FROM management_messages WHERE conversation_id=? AND state IN ('pending','running')", session.conversation_id)) fail(409, 'onboarding_turn_running');
    this.store.transaction(() => {
      this.store.run("UPDATE onboarding_sessions SET state='closed',closed_by=?,closed_at=?,updated_at=? WHERE id=? AND state='open'", actor.principal_id, now(), now(), session.id);
      this.store.audit(actor.principal_id, 'onboarding.closed', repositoryId, repositoryId);
    });
    return this.view(base, repositoryId);
  }
  /** A message may start a turn only in the open session, one turn at a time. */
  admit(conversation: string): void {
    const session = this.sessionOf(conversation);
    if (session?.state !== 'open') fail(409, 'onboarding_session_closed');
    if (this.store.get("SELECT 1 FROM management_messages WHERE conversation_id=? AND state IN ('pending','running')", conversation)) fail(409, 'onboarding_turn_running');
  }
  /** The parts of one turn the management assistant runs differently for onboarding. */
  turn(actor: ActorContext, conversation: string, message: string, guard: () => Promise<void>, redactor: Redactor, extra: string): OnboardingTurn {
    const session = this.sessionOf(conversation); if (!session) return fail(404, 'onboarding_session_not_found');
    const repository = onboardingAccess(this.store, actor, String(session.repository_id)), id = String(repository.id);
    const chosen = onboardingModel(this.store, repository);
    // Tokens cover only this repository and only the read scopes; the turn revokes them when it ends.
    const repositories = new ServiceRepositories(this.store, redactor, guard, selected => {
      if (selected !== id && selected !== repository.full_name) fail(404, 'repository_not_found');
      return onboardingAccess(this.store, actor, id);
    }, () => Object.keys(agentReadPermissions), this.githubUrl);
    const policy = repository.started ? this.store.get('SELECT * FROM policies WHERE repository_id=?', id) : undefined, plan = this.latestPlan(id, session.id);
    const context = { repository: { id, full_name: repository.full_name, started: !!repository.started, organization_trusted: !!trustedOrganization(this.store, String(repository.owner_id)) },
      ...(policy ? { current_settings: { enabled: !!policy.enabled, capability_ceiling: projectCeiling(this.store, id, policy), events: eventFilters(this.store, id, policy),
        test_command: policy.test_command || null, review_language: policy.review_language ?? 'auto' } } : {}),
      latest_questions: session.questions ? JSON.parse(session.questions).questions : null, latest_plan: plan ? { version: plan.version, plan: JSON.parse(plan.plan) } : null };
    const system = `You are the management assistant, running the onboarding of the GitHub repository ${repository.full_name}. Reply in Simplified Chinese.\n\n` + instructions + extra;
    return { repository, system, model: chosen.model, context, repositories,
      // Usage belongs to the management assistant and to the repository (#930); before the project exists the ledger cannot
      // name it (model_requests.repository_id references repositories), so the start moves the session's usage onto it.
      task: { repository_id: repository.started ? id : null, onboarding: true, ...(chosen.trusted_owner ? { trusted_owner: chosen.trusted_owner } : {}) },
      tools: onboardingTools,
      execute: (name, raw) => {
        const args = redactor.clean(raw);
        if (name === 'ask_onboarding_questions') {
          const problem = questionsProblem(args); if (problem) return problem;
          this.store.run("UPDATE onboarding_sessions SET questions=?,updated_at=? WHERE id=? AND state='open'", JSON.stringify({ message_id: message, asked_at: now(), questions: args.questions }), now(), session.id);
          return { recorded: true, questions: (args.questions as Json[]).length, notice: '问题已展示给对方；用一两句话结束本轮，等对方回答，不要替对方作答。' };
        }
        const problem = planProblem(args); if (problem) return problem;
        const plan = withDevelopingLabel(args, developingLabel(this.store, id));
        return this.store.transaction(() => {
          const version = Number(this.store.get('SELECT max(version) AS v FROM onboarding_plans WHERE repository_id=?', id)?.v ?? 0) + 1;
          this.store.run('INSERT INTO onboarding_plans VALUES(?,?,?,?,?,?,?,?)', randomId(), session.id, id, version, JSON.stringify(plan), message, actor.principal_id, now());
          this.store.run('UPDATE onboarding_sessions SET updated_at=? WHERE id=?', now(), session.id);
          return { saved: true, version, notice: `方案草稿已保存为第 ${version} 版，尚未应用：对方在接入页确认后才会生效。` };
        });
      } };
  }
}
