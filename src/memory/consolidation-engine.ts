import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Row, Store } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import type { ManagementService } from '../management/service.js';
import type { ChannelService } from '../channels/service.js';
import type { AssistantComputerService } from '../service-roles/assistant-computers.js';
import { ownerId as assistantOwnerId } from '../service-roles/assistant-computers.js';
import { personFence } from '../management/agent.js';
import { repositoryConcurrency } from '../app/settings.js';
import { configuredRedactor } from '../core/redaction.js';
import { fail, HttpError, randomId, type Json } from '../core/security.js';
import { Redactor, stop, TaskError } from '../agent/common.js';
import { openModel, visibleModel, type RuntimeModel } from '../agent/model.js';
import { runAgent, type AgentServices, type AgentSpec } from '../agent/runtime.js';
import { Workspace } from '../agent/workspace.js';
import { assistantResultOwner, projectResultOwner, ResultSession, resultScope } from '../agent/tool-results.js';
import { roleHarness } from '../roles/harness.js';
import { groupAssistant, managementAssistant, modelGaps, serviceRole, serviceRoleStorage } from '../service-roles/roles.js';
import { scopeProjects } from '../channels/service-bindings.js';
import { assertCurrent, resolvePrincipalActor, type ActorContext } from '../identity/authorization.js';
import { recordExternalModelRequest } from '../metrics/accounting.js';
import {
  beginConsolidationRun,
  consolidationSettings,
  consolidationStaggerKey,
  consolidationStorage,
  evaluateConsolidationWindow,
  finishConsolidationRun,
  getConsolidationState,
  hasNightlyRunForDay,
  interruptConsolidationRuns,
  isConsolidationEnabledForScope,
  listConsolidationRuns,
  parsePersonalScopeId,
  personalScopeId,
  runningConsolidationRun,
  type ConsolidationFileChange,
  type ConsolidationRunRow,
  type ConsolidationScopeKind,
  type ConsolidationSettings,
  type ConsolidationStateRow,
  type ConsolidationTrigger,
} from './consolidation-storage.js';
import {
  createGroupConsolidationExecutor,
  createMutationTracker,
  createPersonalConsolidationExecutor,
  createProjectConsolidationExecutor,
  groupConsolidationTools,
  listBoundPersonalPrivateChats,
  personalConsolidationTools,
  projectConsolidationTools,
  type ConsolidationMutationTracker,
} from './consolidation-tools.js';

const CONSOLIDATION_PROMPT_PATH = resolve(import.meta.dirname, '../../docs/prompts/memory-consolidation.md');

export function loadConsolidationPrompt(): string {
  return readFileSync(CONSOLIDATION_PROMPT_PATH, 'utf8').trim();
}

export interface ConsolidationSubmission {
  summary: string;
  changed_files?: string[];
  deleted_files?: string[];
  notes?: string;
}

export interface ResolvedConsolidationModel {
  model: RuntimeModel;
  source: 'scope' | 'global' | 'inherited';
}

export type ConsolidationModelResolution =
  | ResolvedConsolidationModel
  | { unavailable: string; detail: string };

/**
 * Resolves the model for a consolidation run without ever silently downgrading or switching models:
 *   scope override model -> global default consolidation model -> subject's own existing model.
 * If an explicit override is set and unavailable/unkeyed/unauthorized, returns `{ unavailable }` directly.
 */
export function resolveConsolidationModel(
  store: Store,
  scopeKind: ConsolidationScopeKind,
  scopeId: string,
  state: ConsolidationStateRow = getConsolidationState(store, scopeKind, scopeId),
  globalSettings: ConsolidationSettings = consolidationSettings(store),
): ConsolidationModelResolution {
  const tryOpen = (row: Row | undefined, source: 'scope' | 'global' | 'inherited'): ConsolidationModelResolution => {
    if (!row) return { unavailable: 'model_unavailable', detail: 'Selected consolidation model does not exist or is not authorized for this scope.' };
    if (!row.api_key) return { unavailable: 'model_unavailable', detail: `Model ${row.model_name} has no API key configured.` };
    try {
      return { model: openModel(store, row), source };
    } catch (error) {
      return { unavailable: 'model_unavailable', detail: error instanceof Error ? error.message : 'model_unavailable' };
    }
  };

  if (scopeKind === 'project') {
    if (state.model_id) {
      return tryOpen(visibleModel(store, scopeId, state.model_id), 'scope');
    }
    if (globalSettings.model_id) {
      return tryOpen(visibleModel(store, scopeId, globalSettings.model_id), 'global');
    }
    // Subject's own model: reviewer role model first, else project default policy model.
    let roleModelId: string | null = null;
    try {
      const saved = store.get('SELECT value FROM settings WHERE key=?', 'roles:' + scopeId);
      const roles = saved ? JSON.parse(String(saved.value))?.roles : null;
      const reviewer = Array.isArray(roles) ? roles.find((r: any) => r?.role_id === 'reviewer') : null;
      if (typeof reviewer?.model_profile_ref?.model_id === 'string' && reviewer.model_profile_ref.model_id) {
        roleModelId = reviewer.model_profile_ref.model_id;
      }
    } catch { /* ignore */ }
    const policy = store.get('SELECT model_id FROM policies WHERE repository_id=?', scopeId);
    const modelId = roleModelId ?? (policy?.model_id ? String(policy.model_id) : null);
    if (!modelId) return { unavailable: 'model_unavailable', detail: 'No project model configured.' };
    return tryOpen(visibleModel(store, scopeId, modelId), 'inherited');
  }

  if (scopeKind === 'group_assistant') {
    const binding = store.get('SELECT * FROM channel_service_bindings WHERE chat_id=? AND enabled=1', scopeId);
    if (!binding) return { unavailable: 'channel_service_binding_disabled', detail: 'Group assistant binding is disabled.' };
    const projects = scopeProjects(store, String(binding.principal_id));
    if (!projects.length) return { unavailable: 'channel_service_scope_paused', detail: 'Group binding has no active projects.' };
    const checkGroupModel = (modelId: string, source: 'scope' | 'global' | 'inherited'): ConsolidationModelResolution => {
      const row = store.get('SELECT * FROM models WHERE id=?', modelId);
      if (!row) return { unavailable: 'model_unavailable', detail: 'Configured model not found.' };
      if (modelGaps(store, row.id, projects).length) {
        return { unavailable: 'model_unavailable', detail: `Model ${row.model_name} is not authorized for all projects in group scope.` };
      }
      return tryOpen(row, source);
    };
    if (state.model_id) return checkGroupModel(state.model_id, 'scope');
    if (globalSettings.model_id) return checkGroupModel(globalSettings.model_id, 'global');
    if (!binding.model_id) return { unavailable: 'model_unavailable', detail: 'Group assistant has no model configured.' };
    return checkGroupModel(String(binding.model_id), 'inherited');
  }

  // personal_assistant: shared models only (never borrows a project-owned model).
  const checkSharedModel = (modelId: string, source: 'scope' | 'global' | 'inherited'): ConsolidationModelResolution => {
    const row = store.get('SELECT * FROM models WHERE id=? AND repository_id IS NULL', modelId);
    return tryOpen(row, source);
  };
  if (state.model_id) return checkSharedModel(state.model_id, 'scope');
  if (globalSettings.model_id) return checkSharedModel(globalSettings.model_id, 'global');
  const role = serviceRole(store, managementAssistant);
  if (!role?.enabled || !role.model_id) {
    return { unavailable: 'model_unavailable', detail: 'Management assistant has no shared model configured.' };
  }
  return checkSharedModel(String(role.model_id), 'inherited');
}

export function isPersonalAssistantEligible(store: Store, management: ManagementService, actor: ActorContext): boolean {
  try {
    if (management.user(actor).role === 'super_admin') return true;
    if (management.pendingRepositories(actor).length > 0) return true;
    return management.projects(actor).some(project => {
      try { management.scope(actor, project, 'tasks.write'); return true; }
      catch (error) { if (error instanceof HttpError && error.status === 403) return false; throw error; }
    });
  } catch {
    return false;
  }
}

export interface ConsolidationCandidate {
  scope_kind: ConsolidationScopeKind;
  scope_id: string;
}

export interface ConsolidationEngineDeps {
  store: Store;
  manager?: Manager;
  management: ManagementService;
  channels?: ChannelService;
  assistants?: AssistantComputerService;
  engine?: { working(repositoryId: string): Promise<unknown>[] };
  projects?: { isRemoving(repositoryId: string): boolean };
  clock?: () => number;
  tickMs?: number;
  firstDelayMs?: number;
  /** Optional override for unit tests that verify scheduler/deferral/tools without launching Pi subprocesses. */
  runner?: (ctx: ConsolidationRunContext) => Promise<ConsolidationSubmission>;
}

export interface ConsolidationRunContext {
  run: ConsolidationRunRow;
  scope_kind: ConsolidationScopeKind;
  scope_id: string;
  model: RuntimeModel;
  system: string;
  prompt: string;
  tools: Json[];
  execute: (name: string, args: unknown) => Promise<Json>;
  guard: () => Promise<void>;
  signal: AbortSignal;
  mutations: ConsolidationMutationTracker;
}

function validateSubmission(args: unknown): ConsolidationSubmission {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(400, 'invalid_consolidation_submission');
  const input = args as Record<string, unknown>;
  if (typeof input.summary !== 'string' || !input.summary.trim()) return fail(400, 'invalid_consolidation_submission');
  const strList = (val: unknown) => Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 500) : [];
  return {
    summary: input.summary.trim().slice(0, 4000),
    changed_files: strList(input.changed_files),
    deleted_files: strList(input.deleted_files),
    ...(typeof input.notes === 'string' && input.notes.trim() ? { notes: input.notes.trim().slice(0, 2000) } : {}),
  };
}

function scopeKey(kind: ConsolidationScopeKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Pure internal background Nightly Memory Consolidation engine.
 * - Fixed exclusively to the Pi harness (no other backends).
 * - Enabled by default (`enabled: true`), no incremental activity gate, no artificial per-run turn/token/wall limits.
 * - No default-branch code checkout on projects; allows deletion; supports full-history read-only inspection.
 * - Zero external side effects (no Feishu messages, no GitHub writes, no user schedules).
 */
export class MemoryConsolidationService {
  readonly active = new Map<string, { runId: string; controller: AbortController; promise: Promise<ConsolidationRunRow | null> }>();
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private ticking = false;

  constructor(readonly deps: ConsolidationEngineDeps) {
    serviceRoleStorage(deps.store);
    consolidationStorage(deps.store);
    interruptConsolidationRuns(deps.store);
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tickMs = this.deps.tickMs ?? 60_000;
    const firstDelay = this.deps.firstDelayMs ?? 15_000;
    this.first = setTimeout(() => { void this.tick().catch(err => console.error('[memory-consolidation] tick failed:', err)); }, firstDelay);
    this.first.unref?.();
    this.timer = setInterval(() => { void this.tick().catch(err => console.error('[memory-consolidation] tick failed:', err)); }, tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.active.values()) {
      entry.controller.abort(new TaskError('consolidation_stopped', 'cancelled'));
    }
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
  }

  /** Running consolidation promises for a given repository, so project deletion waits cleanly before dropping rows/notes. */
  workingForProject(repositoryId: string): Promise<unknown>[] {
    const entry = this.active.get(scopeKey('project', repositoryId));
    return entry ? [entry.promise] : [];
  }

  /** Cancels any running consolidation for a specific scope (used by manual stop, project removal, and group unbind). */
  stopScope(scopeKind: ConsolidationScopeKind, scopeId: string): { stopped: boolean; run: ConsolidationRunRow | null } {
    const key = scopeKey(scopeKind, scopeId);
    const entry = this.active.get(key);
    const current = runningConsolidationRun(this.deps.store, scopeKind, scopeId);
    if (!entry && !current) return { stopped: false, run: null };
    if (entry) {
      entry.controller.abort(new TaskError('consolidation_cancelled', 'cancelled'));
    }
    if (current) {
      const updated = finishConsolidationRun(this.deps.store, current.id, {
        status: 'cancelled',
        error_code: 'consolidation_cancelled',
        finished_at: new Date(this.now()).toISOString(),
      });
      return { stopped: true, run: updated };
    }
    return { stopped: true, run: null };
  }

  /** Lists all active consolidation candidates across all three tracks (no incremental activity threshold). */
  enumerateCandidates(): ConsolidationCandidate[] {
    const { store, management } = this.deps;
    const candidates: ConsolidationCandidate[] = [];

    // 1. Enabled projects
    for (const row of store.all('SELECT r.id FROM repositories r JOIN policies p ON p.repository_id=r.id WHERE p.enabled=1 ORDER BY r.id')) {
      candidates.push({ scope_kind: 'project', scope_id: String(row.id) });
    }

    // 2. Active bound Feishu groups
    if (store.hasTable('channel_service_bindings') && store.hasTable('channel_chats')) {
      for (const row of store.all(
        "SELECT b.chat_id FROM channel_service_bindings b JOIN channel_chats h ON h.id=b.chat_id WHERE b.enabled=1 AND h.chat_type='group' AND h.state='active' ORDER BY b.chat_id",
      )) {
        candidates.push({ scope_kind: 'group_assistant', scope_id: String(row.chat_id) });
      }
    }

    // 3. Eligible active human users (per distinct tenant HOME scope, default '' for platform scope)
    if (store.hasTable('principals') && store.hasTable('users')) {
      const humans = store.all(
        "SELECT p.id AS principal_id FROM principals p JOIN users u ON u.id=p.user_id WHERE p.kind='human' AND p.active=1 AND u.active=1 ORDER BY p.id",
      );
      for (const human of humans) {
        const principalId = String(human.principal_id);
        const tenants = new Set<string>(['']);
        if (store.hasTable('assistant_homes')) {
          for (const h of store.all("SELECT DISTINCT tenant FROM assistant_homes WHERE kind='person' AND subject=?", principalId)) {
            tenants.add(String(h.tenant ?? ''));
          }
        }
        if (store.hasTable('management_conversations')) {
          for (const c of store.all("SELECT DISTINCT tenant_id FROM management_conversations WHERE principal_id=? AND scope NOT LIKE 'onboarding:%'", principalId)) {
            tenants.add(String(c.tenant_id ?? ''));
          }
        }
        for (const tenant of tenants) {
          try {
            const actor = resolvePrincipalActor(store, principalId, tenant || null, undefined, 'web');
            if (isPersonalAssistantEligible(store, management, actor)) {
              candidates.push({ scope_kind: 'personal_assistant', scope_id: personalScopeId(principalId, tenant) });
            }
          } catch { /* principal has no active access in this tenant */ }
        }
      }
    }

    return candidates;
  }

  /** Whether real-time work is currently occupying this scope (nightly runs yield and retry later in the window). */
  isScopeBusyForNightly(scopeKind: ConsolidationScopeKind, scopeId: string): boolean {
    const { store, engine, projects } = this.deps;
    if (scopeKind === 'project') {
      if (projects?.isRemoving(scopeId)) return true;
      const activeCount = engine?.working(scopeId).length ?? 0;
      return activeCount >= repositoryConcurrency(store, scopeId);
    }
    if (scopeKind === 'group_assistant') {
      if (store.hasTable('channel_service_turns') && store.get("SELECT 1 FROM channel_service_turns WHERE chat_id=? AND state='running'", scopeId)) {
        return true;
      }
      return false;
    }
    const { principalId } = parsePersonalScopeId(scopeId);
    if (store.hasTable('management_messages') && store.hasTable('management_conversations')) {
      if (store.get(
        "SELECT 1 FROM management_messages m JOIN management_conversations c ON c.id=m.conversation_id WHERE c.principal_id=? AND m.state IN ('pending','running')",
        principalId,
      )) {
        return true;
      }
    }
    return false;
  }

  /** One scheduler tick: checks nightly window, enumerates eligible subjects, yields to real-time work, respects concurrency cap. */
  async tick(): Promise<{ launched: number; skipped: number; deferred: number }> {
    if (this.stopped || this.ticking) return { launched: 0, skipped: 0, deferred: 0 };
    this.ticking = true;
    let launched = 0, skipped = 0, deferred = 0;
    try {
      const settings = consolidationSettings(this.deps.store);
      if (!settings.enabled) return { launched, skipped, deferred };
      const nowMs = this.now();
      const { inWindow, logicalDay } = evaluateConsolidationWindow(nowMs, settings);
      if (!inWindow) return { launched, skipped, deferred };

      const candidates = this.enumerateCandidates()
        .filter(c => isConsolidationEnabledForScope(this.deps.store, c.scope_kind, c.scope_id))
        .filter(c => !this.active.has(scopeKey(c.scope_kind, c.scope_id)))
        .filter(c => !hasNightlyRunForDay(this.deps.store, c.scope_kind, c.scope_id, logicalDay))
        .sort((a, b) => consolidationStaggerKey(logicalDay, a.scope_kind, a.scope_id).localeCompare(consolidationStaggerKey(logicalDay, b.scope_kind, b.scope_id)));

      for (const candidate of candidates) {
        if (this.stopped) break;
        if (this.active.size >= settings.max_concurrency) break;
        if (this.isScopeBusyForNightly(candidate.scope_kind, candidate.scope_id)) {
          deferred++;
          continue;
        }
        const started = this.launch(candidate.scope_kind, candidate.scope_id, 'nightly', logicalDay);
        if (started === 'skipped') skipped++;
        else if (started === 'launched') launched++;
      }
    } finally {
      this.ticking = false;
    }
    return { launched, skipped, deferred };
  }

  /** Starts a manual consolidation pass immediately for one subject (returns the run record). */
  triggerManual(scopeKind: ConsolidationScopeKind, scopeId: string): ConsolidationRunRow {
    const key = scopeKey(scopeKind, scopeId);
    if (this.active.has(key) || runningConsolidationRun(this.deps.store, scopeKind, scopeId)) {
      fail(409, 'consolidation_already_running');
    }
    const settings = consolidationSettings(this.deps.store);
    const { logicalDay } = evaluateConsolidationWindow(this.now(), settings);
    const resolved = resolveConsolidationModel(this.deps.store, scopeKind, scopeId, undefined, settings);
    if ('unavailable' in resolved) {
      const skipped = beginConsolidationRun(this.deps.store, {
        scope_kind: scopeKind,
        scope_id: scopeId,
        logical_day: logicalDay,
        trigger: 'manual',
        model_id: null,
        started_at: new Date(this.now()).toISOString(),
        initial_status: 'skipped',
        error_code: resolved.unavailable,
        error_detail: resolved.detail,
      });
      return skipped!;
    }
    const run = beginConsolidationRun(this.deps.store, {
      scope_kind: scopeKind,
      scope_id: scopeId,
      logical_day: logicalDay,
      trigger: 'manual',
      model_id: resolved.model.id,
      started_at: new Date(this.now()).toISOString(),
    });
    if (!run) fail(409, 'consolidation_already_running');
    this.startExecution(run!, resolved.model);
    return run!;
  }

  private launch(
    scopeKind: ConsolidationScopeKind,
    scopeId: string,
    trigger: ConsolidationTrigger,
    logicalDay: string,
  ): 'launched' | 'skipped' | 'busy' {
    const key = scopeKey(scopeKind, scopeId);
    if (this.active.has(key)) return 'busy';
    const settings = consolidationSettings(this.deps.store);
    const resolved = resolveConsolidationModel(this.deps.store, scopeKind, scopeId, undefined, settings);
    if ('unavailable' in resolved) {
      beginConsolidationRun(this.deps.store, {
        scope_kind: scopeKind,
        scope_id: scopeId,
        logical_day: logicalDay,
        trigger,
        model_id: null,
        started_at: new Date(this.now()).toISOString(),
        initial_status: 'skipped',
        error_code: resolved.unavailable,
        error_detail: resolved.detail,
      });
      return 'skipped';
    }
    const run = beginConsolidationRun(this.deps.store, {
      scope_kind: scopeKind,
      scope_id: scopeId,
      logical_day: logicalDay,
      trigger,
      model_id: resolved.model.id,
      started_at: new Date(this.now()).toISOString(),
    });
    if (!run) return 'busy';
    this.startExecution(run, resolved.model);
    return 'launched';
  }

  private startExecution(run: ConsolidationRunRow, model: RuntimeModel): void {
    const key = scopeKey(run.scope_kind, run.scope_id);
    const controller = new AbortController();
    const promise = this.executeRun(run, model, controller.signal)
      .catch(error => {
        console.error(`[memory-consolidation] unhandled failure for ${key}:`, error instanceof Error ? error.message : error);
        return null;
      })
      .finally(() => {
        if (this.active.get(key)?.runId === run.id) this.active.delete(key);
      });
    this.active.set(key, { runId: run.id, controller, promise });
  }

  private async executeRun(run: ConsolidationRunRow, model: RuntimeModel, signal: AbortSignal): Promise<ConsolidationRunRow | null> {
    const { store } = this.deps;
    const mutations = createMutationTracker();
    const redactor = new Redactor();
    redactor.add(model.key);

    const checkBase = () => {
      if (this.stopped || signal.aborted) fail(409, 'consolidation_cancelled');
      const current = store.get('SELECT status FROM memory_consolidation_runs WHERE id=?', run.id);
      if (!current || current.status !== 'running') fail(409, 'consolidation_cancelled');
    };

    try {
      const submission = run.scope_kind === 'project'
        ? await this.runProject(run, model, signal, redactor, checkBase, mutations)
        : run.scope_kind === 'group_assistant'
          ? await this.runGroup(run, model, signal, redactor, checkBase, mutations)
          : await this.runPersonal(run, model, signal, redactor, checkBase, mutations);

      // Final guard check before recording completed state
      checkBase();
      const cleanedSummary = configuredRedactor(store).text(redactor.text(submission.summary)).slice(0, 4000);
      return finishConsolidationRun(store, run.id, {
        status: 'completed',
        model_id: model.id,
        summary: cleanedSummary,
        changed_files: mutations.changed(),
        deleted_files: mutations.deleted(),
        finished_at: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      const existing = store.get('SELECT status FROM memory_consolidation_runs WHERE id=?', run.id);
      if (!existing || existing.status === 'cancelled') return null;
      const code = error instanceof HttpError || error instanceof TaskError
        ? error.code
        : 'consolidation_failed';
      const cancelled = code === 'consolidation_cancelled' || code === 'consolidation_stopped' || code === 'harness_cancelled' || signal.aborted;
      const rawDetail = error instanceof TaskError && error.detail
        ? error.detail
        : error instanceof Error ? error.message : String(error);
      const detail = configuredRedactor(store).text(redactor.text(rawDetail)).slice(0, 1000);
      return finishConsolidationRun(store, run.id, {
        status: cancelled ? 'cancelled' : 'failed',
        model_id: model.id,
        changed_files: mutations.changed(),
        deleted_files: mutations.deleted(),
        error_code: cancelled ? 'consolidation_cancelled' : code,
        error_detail: detail || null,
        finished_at: new Date(this.now()).toISOString(),
      });
    }
  }

  private async runPiSession(input: {
    run: ConsolidationRunRow;
    model: RuntimeModel;
    system: string;
    prompt: string;
    tools: Json[];
    execute: (name: string, args: unknown) => Promise<Json>;
    guard: () => Promise<void>;
    signal: AbortSignal;
    redactor: Redactor;
    workspace: Workspace;
    resultOwner: () => string;
    taskRow: Row;
    projectId: string;
    tenantId: string;
    principalRef: string;
    environmentProfile: 'workspace' | 'assistant';
  }): Promise<ConsolidationSubmission> {
    const { store } = this.deps;
    const driver = roleHarness('pi');
    const token = randomId();
    input.redactor.add(token);
    const binding = `consolidation:${input.run.id}`;
    const results = new ResultSession(
      store,
      resultScope(store, input.taskRow),
      input.resultOwner,
      input.guard,
      input.redactor.values,
      () => false,
    );
    const wrappedExecute = (name: string, args: unknown) =>
      results.execute(name, args, () => input.execute(name, args), true);

    // Gateway transport keeps long-lived API keys inside the control plane and records exact billing in model_requests.
    // Non-chat-completions protocols (e.g. anthropic-messages) use direct transport with external usage recording.
    const useGateway = !input.model.protocol?.interface_type || input.model.protocol.interface_type === 'openai-chat-completions';
    let externalStep = 0;

    const spec: AgentSpec<ConsolidationSubmission> = {
      store,
      task: input.taskRow,
      redactor: input.redactor,
      guard: input.guard,
      executionSignal: input.signal,
      cancelSignal: input.signal,
      model: input.model,
      requestPrefix: `consolidation:${input.run.id}:`,
      system: input.system,
      prompt: input.prompt,
      tools: input.tools,
      execute: wrappedExecute,
      resultSession: results,
      finish: {
        name: 'finish_consolidation',
        validate: args => validateSubmission(args),
      },
      onTurnEnd: turn => ({
        summary: turn.text.trim() ? turn.text.trim().slice(0, 4000) : 'Memory consolidation pass completed.',
      }),
      roleWorkspace: input.workspace,
      harnessAccess: {
        workspace: 'none',
        fileTools: 'none',
        commands: false,
        network: false,
        github: { repository: null, scopes: [] },
        trustedCheckout: false,
      },
      harnessTurnLimit: undefined, // No artificial max_turns / max_tokens / max_wall_ms cap.
      harnessSessionKey: binding,
      harnessState: { value: {}, save: () => {} },
      containerOptions: {
        manager: input.workspace.manager,
        egress: false,
        modelTransport: useGateway ? 'gateway' : 'direct',
      },
      onHarnessEvent: event => {
        if (!useGateway && event.type === 'usage' && event.source === 'pi_native') {
          const u = (event.usage ?? {}) as Record<string, any>;
          const step = ++externalStep;
          try {
            recordExternalModelRequest(store, input.taskRow, input.run.id, {
              key: `consolidation:${input.run.id}:pi:${step}`,
              source: 'provider_requests',
              model: String(event.model || input.model.model),
              input_tokens: Number.isFinite(u.input) ? Number(u.input) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0) : null,
              output_tokens: Number.isFinite(u.output) ? Number(u.output) : null,
              cached_input_tokens: Number.isFinite(u.cacheRead) ? Number(u.cacheRead) : null,
              finished: true,
            });
          } catch { /* accounting error never aborts completed work */ }
        }
      },
      runAccess: { token, check: presented => { if (presented !== token) stop('run_token_invalid', 'failed'); } },
      runContext: () => ({
        protocol: 'bot.role-run/1',
        candidate_ref: null,
        task_id: null,
        conversation_id: String(input.taskRow.conversation_id ?? binding),
        assignment_id: binding,
        run_id: input.run.id,
        tenant_id: input.tenantId,
        project_id: input.projectId,
        principal_ref: input.principalRef,
        source_ref: `memory_consolidation:${input.run.id}`,
        configuration_snapshot_ref: `memory_consolidation:${input.run.scope_kind}:${input.run.scope_id}`,
        lease_epoch: 1,
        contract_revision: 0,
        policy_revision: 'memory_consolidation',
        role_revision: '1',
        harness_revision: driver.version,
        skill_revisions: [],
        model_revision: String(input.model.version),
        budget: {
          policy_ref: 'unbounded',
          accounting: 'per_run',
          max_turns: null,
          max_output_tokens: null,
          max_total_tokens: null,
          max_model_requests: null,
          max_tool_calls: null,
          max_wall_ms: null,
          max_concurrency: 1,
        },
        execution_context: {
          role_instance_id: binding,
          role: 'memory-consolidation',
          kind: 'controller',
          environment_profile: input.environmentProfile,
        },
      }),
      pi: {
        workspace: input.workspace,
        key: `consolidation:${input.run.id}:${randomId()}`,
        resume: false,
        runtime: { version: driver.version, report: () => {} },
      },
    };

    const adapter = driver.adapter(spec);
    return await runAgent({
      ...spec,
      adapter: (services: AgentServices) => adapter({
        ...services,
        request: (body, id, onToken, onFinish, options) =>
          services.request(body, id, onToken, onFinish, { ...options, harnessTools: true }),
      }),
    });
  }

  private async runProject(
    run: ConsolidationRunRow,
    model: RuntimeModel,
    signal: AbortSignal,
    redactor: Redactor,
    checkBase: () => void,
    mutations: ConsolidationMutationTracker,
  ): Promise<ConsolidationSubmission> {
    const { store, manager, projects } = this.deps;
    const repoId = run.scope_id;
    const repo = store.get('SELECT * FROM repositories WHERE id=?', repoId);
    if (!repo) return fail(404, 'repository_not_found');
    if (!manager) return fail(503, 'manager_unavailable');

    const guard = async () => {
      checkBase();
      if (projects?.isRemoving(repoId)) fail(409, 'repository_deleting');
      if (!store.get('SELECT 1 FROM repositories WHERE id=?', repoId)) fail(404, 'repository_not_found');
      if (run.trigger === 'nightly' && !store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1', repoId)) {
        fail(409, 'project_disabled');
      }
      if (!visibleModel(store, repoId, model.id)) fail(409, 'model_unavailable');
    };
    await guard();

    const state = getConsolidationState(store, 'project', repoId);
    const taskCount = Number(store.get('SELECT count(*) AS n FROM tasks WHERE repository_id=?', repoId)?.n ?? 0);
    const threadCount = store.hasTable('dispatch_threads')
      ? Number(store.get('SELECT count(*) AS n FROM dispatch_threads WHERE repository_id=?', repoId)?.n ?? 0)
      : 0;
    const notesListing = await manager.call('GET', `/v1/projects/${repoId}/file-tree?directory=&query=&include_deleted=0&deleted_only=0&recursive=1&preview=0`).catch(() => ({ files: [] }));

    const system = loadConsolidationPrompt();
    const prompt = JSON.stringify({
      scope: {
        kind: 'project',
        repository: repo.full_name,
        notes_location: '../notes/',
        multi_branch_warning: 'No default-branch git checkout is mounted. Preserve branch-specific notes with clear branch/date labels.',
      },
      consolidation: {
        run_id: run.id,
        trigger: run.trigger,
        logical_day: run.logical_day,
        now_utc: new Date(this.now()).toISOString(),
        last_completed_at: state.last_completed_at,
      },
      overview: {
        existing_note_files: (Array.isArray(notesListing?.files) ? notesListing.files : []).map((f: any) => ({ id: f.id, path: f.path, revision: f.revision, bytes: f.bytes })),
        total_historical_tasks: taskCount,
        total_dispatch_threads: threadCount,
      },
      instruction: 'Inspect all existing project notes and freely explore full historical tasks, task records/traces/logs, and dispatch threads using the offered tools. Consolidate durable knowledge, resolve contradictions, remove obsolete or redundant files, maintain INDEX.md, and call finish_consolidation when done.',
    });

    const execute = createProjectConsolidationExecutor({ store, manager, repositoryId: repoId, runId: run.id, guard, mutations });

    if (this.deps.runner) {
      return await this.deps.runner({
        run, scope_kind: 'project', scope_id: repoId, model, system, prompt,
        tools: projectConsolidationTools, execute, guard, signal, mutations,
      });
    }

    let env = await manager.call('GET', '/v1/projects/' + repoId);
    if (!env) env = await manager.call('PUT', '/v1/projects/' + repoId);
    if (!['ready', 'busy'].includes(String(env?.state))) stop('environment_not_ready', 'waiting_environment', '项目电脑尚未就绪，无法启动 Pi 记忆整理会话。');

    const workspaceId = randomId();
    const taskRow: Row = {
      id: `consolidation:${run.id}`,
      repository_id: repoId,
      service_role_id: null,
      role_id: 'memory-consolidation',
      kind: 'memory.consolidation',
      consolidation_scope: 'project',
      consolidation_scope_id: repoId,
      conversation_id: `consolidation:project:${repoId}:${run.id}`,
      workspace_id: workspaceId,
      generation: env.generation,
    };
    const workspace = new Workspace(store, manager, taskRow, redactor, guard, () => {}, 'service_role_operations');
    try {
      // Lightweight workspace_init ONLY — mounts ../notes/ without checking out any git worktree!
      const init = await workspace.call('consolidation-init:' + randomId(), { type: 'workspace_init' });
      if (init?.error) stop('controller_workspace_unavailable', 'waiting_environment', '初始化项目记忆整理工作区失败。');
      return await this.runPiSession({
        run, model, system, prompt, tools: projectConsolidationTools, execute, guard, signal, redactor,
        workspace,
        resultOwner: () => projectResultOwner(repoId),
        taskRow,
        projectId: repoId,
        tenantId: String(repo.owner_id ?? 'project'),
        principalRef: 'system:memory-consolidation',
        environmentProfile: 'workspace',
      });
    } finally {
      await workspace.release(false).catch(() => {});
    }
  }

  private async runGroup(
    run: ConsolidationRunRow,
    model: RuntimeModel,
    signal: AbortSignal,
    redactor: Redactor,
    checkBase: () => void,
    mutations: ConsolidationMutationTracker,
  ): Promise<ConsolidationSubmission> {
    const { store, manager, channels, assistants } = this.deps;
    if (!channels) return fail(503, 'channels_unavailable');
    const homes = assistants?.homes;
    if (!assistants || !homes) return fail(503, 'assistant_computers_unavailable');
    const chatId = run.scope_id;
    const chat = store.get("SELECT * FROM channel_chats WHERE id=? AND chat_type='group' AND state='active'", chatId);
    const binding = chat ? channels.serviceBindings.active(chatId) : undefined;
    if (!chat || !binding) return fail(403, 'channel_service_binding_disabled');
    channels.serviceBindings.assertUsable(binding);
    const initialFence = channels.serviceBindings.fence(chatId);
    const projects = scopeProjects(store, String(binding.principal_id));
    if (!projects.length) return fail(403, 'channel_service_scope_paused');
    const billedRepo = binding.scope === 'repositories' && projects.length === 1 ? projects[0]! : null;
    const owner = { kind: 'group' as const, subject: chatId, tenant: String(chat.installation_tenant ?? '') };
    const facts = () => ({ binding: String(binding.id), role: String(binding.service_role_id), repositories: channels.serviceBindings.reach(binding).projects.map(p => p.id) });
    const prepared = await homes.prepare(owner, facts(), { touch: false });
    const initialGeneration = prepared.generation;
    const ownerKey = prepared.id;

    const guard = async () => {
      checkBase();
      channels.serviceBindings.assertUsable(binding);
      if (channels.serviceBindings.fence(chatId) !== initialFence) fail(409, 'conversation_source_changed');
      if (homes.row(ownerKey)?.generation !== initialGeneration) fail(409, 'assistant_home_sealed');
      const liveProjects = scopeProjects(store, String(binding.principal_id));
      if (!liveProjects.length || modelGaps(store, model.id, liveProjects).length) fail(409, 'model_unavailable');
    };
    await guard();

    const state = getConsolidationState(store, 'group_assistant', chatId);
    const msgCount = Number(store.get('SELECT count(*) AS n FROM channel_messages WHERE chat_id=? AND deleted=0 AND sensitive=0 AND created_at>=?', chatId, Number(chat.retained_after ?? 0))?.n ?? 0);
    const ownTaskCount = Number(store.get("SELECT count(*) AS n FROM service_role_own_tasks WHERE owner_kind='channel' AND owner_id=? AND service_role_id=? AND principal_id=? AND fence=?", chatId, binding.service_role_id, binding.principal_id, initialFence)?.n ?? 0);
    const listedMem = await homes.list(prepared.directory, 'memory', true).catch(() => ({ exists: false, entries: [], truncated: false }));
    const permissions = channels.serviceBindings.permissions(binding);
    const tools = groupConsolidationTools(permissions);

    const system = loadConsolidationPrompt();
    const prompt = JSON.stringify({
      scope: {
        kind: 'group_assistant',
        chat_name: chat.display_name || chat.chat_id,
        memory_location: '~/memory/',
        write_constraint: 'You may write and delete files strictly inside ~/memory/ only.',
      },
      consolidation: {
        run_id: run.id,
        trigger: run.trigger,
        logical_day: run.logical_day,
        now_utc: new Date(this.now()).toISOString(),
        last_completed_at: state.last_completed_at,
      },
      overview: {
        existing_memory_files: listedMem.entries,
        total_visible_messages: msgCount,
        total_own_tasks: ownTaskCount,
        reachable_projects: channels.serviceBindings.reach(binding).projects.map(p => p.full_name),
      },
      instruction: 'Inspect all existing files under ~/memory/ and freely explore the full group conversation ledger, summary, cached members, own tasks, and authorized project context using the offered tools. Consolidate durable group preferences and facts into ~/memory/, remove redundant or obsolete files, maintain ~/memory/INDEX.md, and call finish_consolidation when done.',
    });

    const execute = createGroupConsolidationExecutor({
      store, manager, channels, chat, binding, fence: initialFence,
      home: { homes, ownerId: ownerKey, generation: initialGeneration, directory: prepared.directory, mode: prepared.mode },
      guard, mutations,
    });

    if (this.deps.runner) {
      try {
        return await this.deps.runner({
          run, scope_kind: 'group_assistant', scope_id: chatId, model, system, prompt,
          tools, execute, guard, signal, mutations,
        });
      } finally {
        await homes.measure(ownerKey).catch(() => {});
      }
    }

    if (!assistants.available()) return fail(503, 'assistant_computers_unavailable');
    const computer = assistants.turn({
      owner,
      turn: `consolidation:${run.id}`,
      fence: () => channels.serviceBindings.fence(chatId),
      facts,
      check: guard,
      commands: () => false,
      eligible: () => { if (!channels.serviceBindings.reach(binding, ['tasks.read']).projects.length) fail(403, 'capability_forbidden'); },
    });

    const taskRow: Row = {
      id: `consolidation:${run.id}`,
      repository_id: billedRepo,
      service_role_id: groupAssistant,
      role_id: 'memory-consolidation',
      kind: 'memory.consolidation',
      consolidation_scope: 'group_assistant',
      consolidation_scope_id: chatId,
      conversation_id: chatId,
    };
    const workspaceId = randomId();
    let workspace: Workspace | undefined;
    try {
      workspace = await computer.sessionWorkspace(taskRow, workspaceId, redactor, () => {});
      return await this.runPiSession({
        run, model, system, prompt, tools, execute, guard, signal, redactor,
        workspace,
        resultOwner: () => assistantResultOwner(ownerKey),
        taskRow,
        projectId: billedRepo ?? 'service',
        tenantId: String(chat.installation_tenant ?? 'service'),
        principalRef: `service:${groupAssistant}`,
        environmentProfile: 'assistant',
      });
    } finally {
      await workspace?.release(false).catch(() => {});
      await computer.close(channels.serviceBindings.fence(chatId) !== initialFence).catch(() => {});
      await homes.measure(ownerKey).catch(() => {});
    }
  }

  private async runPersonal(
    run: ConsolidationRunRow,
    model: RuntimeModel,
    signal: AbortSignal,
    redactor: Redactor,
    checkBase: () => void,
    mutations: ConsolidationMutationTracker,
  ): Promise<ConsolidationSubmission> {
    const { store, manager, management, channels, assistants } = this.deps;
    const homes = assistants?.homes;
    if (!assistants || !homes) return fail(503, 'assistant_computers_unavailable');
    const { principalId, tenant } = parsePersonalScopeId(run.scope_id);
    const actor = resolvePrincipalActor(store, principalId, tenant || null, undefined, 'web');
    if (!isPersonalAssistantEligible(store, management, actor)) return fail(403, 'capability_forbidden');
    const initialFence = personFence(store, principalId, tenant);
    const owner = { kind: 'person' as const, subject: principalId, tenant };
    const facts = () => ({
      repositories: [...new Set([...management.projects(actor), ...management.pendingRepositories(actor).map(r => r.id)])],
    });
    const prepared = await homes.prepare(owner, facts(), { touch: false });
    const initialGeneration = prepared.generation;
    const ownerKey = prepared.id;

    const guard = async () => {
      checkBase();
      assertCurrent(actor);
      if (personFence(store, principalId, tenant) !== initialFence) fail(409, 'authorization_changed');
      if (!isPersonalAssistantEligible(store, management, actor)) fail(403, 'capability_forbidden');
      if (homes.row(ownerKey)?.generation !== initialGeneration) fail(409, 'assistant_home_sealed');
      if (!store.get('SELECT 1 FROM models WHERE id=? AND repository_id IS NULL AND api_key IS NOT NULL', model.id)) {
        fail(409, 'model_unavailable');
      }
    };
    await guard();

    const state = getConsolidationState(store, 'personal_assistant', run.scope_id);
    const convCount = Number(store.get(
      `SELECT count(*) AS n FROM management_conversations WHERE principal_id=? AND scope NOT LIKE 'onboarding:%'${tenant ? " AND (tenant_id='' OR tenant_id=?)" : ''}`,
      principalId, ...(tenant ? [tenant] : []),
    )?.n ?? 0);
    const privateChats = listBoundPersonalPrivateChats(store, principalId, tenant);
    const listedMem = await homes.list(prepared.directory, 'memory', true).catch(() => ({ exists: false, entries: [], truncated: false }));

    const system = loadConsolidationPrompt();
    const prompt = JSON.stringify({
      scope: {
        kind: 'personal_assistant',
        memory_location: '~/memory/',
        shared_across: 'Web console management conversations and bound Feishu private chats',
        write_constraint: 'You may write and delete files strictly inside ~/memory/ only.',
      },
      consolidation: {
        run_id: run.id,
        trigger: run.trigger,
        logical_day: run.logical_day,
        now_utc: new Date(this.now()).toISOString(),
        last_completed_at: state.last_completed_at,
      },
      overview: {
        existing_memory_files: listedMem.entries,
        total_management_conversations: convCount,
        bound_feishu_private_chats: privateChats.map(c => ({ chat_id: c.id, app_name: c.app_name || '', tenant_name: c.tenant_name || '' })),
        accessible_projects: management.projects(actor).length,
      },
      instruction: 'Inspect all existing files under ~/memory/ and freely explore all your Web management conversations, bound Feishu private chat history, own tasks, and authorized projects using the offered tools. Consolidate durable personal working preferences, recurring project context, and lessons into ~/memory/, remove redundant or obsolete files, maintain ~/memory/INDEX.md, and call finish_consolidation when done.',
    });

    const execute = createPersonalConsolidationExecutor({
      store, manager, management, channels, actor, scopeId: run.scope_id, tenant,
      home: { homes, ownerId: ownerKey, generation: initialGeneration, directory: prepared.directory, mode: prepared.mode },
      guard, mutations,
    });

    if (this.deps.runner) {
      try {
        return await this.deps.runner({
          run, scope_kind: 'personal_assistant', scope_id: run.scope_id, model, system, prompt,
          tools: personalConsolidationTools, execute, guard, signal, mutations,
        });
      } finally {
        await homes.measure(ownerKey).catch(() => {});
      }
    }

    if (!assistants.available()) return fail(503, 'assistant_computers_unavailable');
    const computer = assistants.turn({
      owner,
      turn: `consolidation:${run.id}`,
      fence: () => personFence(store, principalId, tenant),
      facts,
      check: guard,
      commands: () => false,
      eligible: () => { if (!isPersonalAssistantEligible(store, management, actor)) fail(403, 'capability_forbidden'); },
    });

    const taskRow: Row = {
      id: `consolidation:${run.id}`,
      repository_id: null,
      service_role_id: managementAssistant,
      role_id: 'memory-consolidation',
      kind: 'memory.consolidation',
      consolidation_scope: 'personal_assistant',
      consolidation_scope_id: run.scope_id,
      conversation_id: `consolidation:person:${run.scope_id}:${run.id}`,
    };
    const workspaceId = randomId();
    let workspace: Workspace | undefined;
    try {
      workspace = await computer.sessionWorkspace(taskRow, workspaceId, redactor, () => {});
      return await this.runPiSession({
        run, model, system, prompt, tools: personalConsolidationTools, execute, guard, signal, redactor,
        workspace,
        resultOwner: () => assistantResultOwner(ownerKey),
        taskRow,
        projectId: 'service',
        tenantId: tenant || 'service',
        principalRef: `service:${managementAssistant}`,
        environmentProfile: 'assistant',
      });
    } finally {
      await workspace?.release(false).catch(() => {});
      await computer.close(personFence(store, principalId, tenant) !== initialFence).catch(() => {});
      await homes.measure(ownerKey).catch(() => {});
    }
  }

  /** Summary view of consolidation status, settings, models and recent runs for one scope. */
  scopeView(scopeKind: ConsolidationScopeKind, scopeId: string): Json {
    const global = consolidationSettings(this.deps.store);
    const state = getConsolidationState(this.deps.store, scopeKind, scopeId);
    const effectiveEnabled = state.enabled_override === null ? global.enabled : state.enabled_override;
    const resolved = resolveConsolidationModel(this.deps.store, scopeKind, scopeId, state, global);
    const running = runningConsolidationRun(this.deps.store, scopeKind, scopeId);
    const { runs, total } = listConsolidationRuns(this.deps.store, { scope_kind: scopeKind, scope_id: scopeId, limit: 20 });
    return {
      global_settings: global,
      state,
      effective_enabled: effectiveEnabled,
      effective_model: 'model' in resolved
        ? { id: resolved.model.id, model_name: resolved.model.model, source: resolved.source }
        : { id: null, model_name: null, source: null, unavailable: resolved.unavailable, detail: resolved.detail },
      running_run: running,
      runs,
      runs_total: total,
    };
  }
}

export function assistantOwnerIdForScope(scopeKind: 'group_assistant' | 'personal_assistant', scopeId: string, store: Store): string | null {
  if (scopeKind === 'group_assistant') {
    const chat = store.get('SELECT installation_tenant FROM channel_chats WHERE id=?', scopeId);
    if (!chat) return null;
    return assistantOwnerId({ kind: 'group', subject: scopeId, tenant: String(chat.installation_tenant ?? '') });
  }
  const { principalId, tenant } = parsePersonalScopeId(scopeId);
  return assistantOwnerId({ kind: 'person', subject: principalId, tenant });
}
