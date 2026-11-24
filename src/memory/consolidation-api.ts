import type { Store, Row } from '../storage/database.js';
import { repository, superAdmin, type Actor } from '../app/auth.js';
import { assertCurrent, type ActorContext } from '../identity/authorization.js';
import { platformManager, tenantName } from '../channels/applications.js';
import { scopeProjects } from '../channels/service-bindings.js';
import type { ChannelService } from '../channels/service.js';
import type { ManagementService } from '../management/service.js';
import { normalizeAssistantMemoryPath, type AssistantComputerService } from '../service-roles/assistant-computers.js';
import { modelGaps } from '../service-roles/roles.js';
import { visibleModel } from '../agent/model.js';
import { memoryAuthorize } from './access.js';
import { configuredRedactor } from '../core/redaction.js';
import { fail, fields, HttpError, text, type Json } from '../core/security.js';
import {
  CONSOLIDATION_CONCURRENCY_BOUNDS,
  consolidationDefaults,
  consolidationSettings,
  listConsolidationRuns,
  parsePersonalScopeId,
  personalScopeId,
  saveConsolidationScopeConfig,
  saveConsolidationSettings,
  type ConsolidationRunRow,
  type ConsolidationScopeKind,
} from './consolidation-storage.js';
import { isPersonalAssistantEligible, type MemoryConsolidationService } from './consolidation-engine.js';

const MAX_MEMORY_READ_BYTES = 256 * 1024;

function modelSummary(row: Row): Json {
  return {
    id: String(row.id),
    provider_name: row.provider_name ?? null,
    model_name: String(row.model_name),
    api_url: String(row.api_url),
    key_configured: row.api_key !== null,
    project_id: row.repository_id ?? null,
  };
}

function sharedModels(store: Store): Json[] {
  return store.all(
    'SELECT id,provider_name,model_name,api_url,api_key,repository_id FROM models WHERE repository_id IS NULL ORDER BY updated_at DESC, id',
  ).map(modelSummary);
}

function projectModels(store: Store, repoId: string): Json[] {
  return store.all(
    `SELECT m.id,m.provider_name,m.model_name,m.api_url,m.api_key,m.repository_id
     FROM models m
     WHERE m.repository_id=? OR (m.repository_id IS NULL AND (m.restricted=0 OR EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?)))
     ORDER BY m.repository_id IS NOT NULL, m.updated_at DESC, m.id`,
    repoId, repoId,
  ).map(modelSummary);
}

function groupModels(store: Store, binding: Row): Json[] {
  const projects = scopeProjects(store, String(binding.principal_id));
  return store.all('SELECT id,provider_name,model_name,api_url,api_key,repository_id,restricted FROM models ORDER BY repository_id IS NOT NULL, updated_at DESC, id')
    .filter(m => {
      if (binding.scope === 'organization' && m.repository_id !== null) return false;
      if (binding.scope === 'organization' && m.restricted && !projects.length) return false;
      return modelGaps(store, String(m.id), projects).length === 0;
    })
    .map(modelSummary);
}

function scopeLabel(store: Store, kind: ConsolidationScopeKind, scopeId: string): string {
  if (kind === 'project') {
    const repo = store.get('SELECT full_name FROM repositories WHERE id=?', scopeId);
    return repo?.full_name ? String(repo.full_name) : scopeId;
  }
  if (kind === 'group_assistant') {
    if (store.hasTable('channel_chats')) {
      const chat = store.get('SELECT display_name,chat_id FROM channel_chats WHERE id=?', scopeId);
      if (chat) return String(chat.display_name || chat.chat_id || scopeId);
    }
    return scopeId;
  }
  const { principalId, tenant } = parsePersonalScopeId(scopeId);
  const user = store.get(
    'SELECT u.username FROM principals p JOIN users u ON u.id=p.user_id WHERE p.id=?',
    principalId,
  );
  const name = user?.username ? String(user.username) : principalId;
  if (tenant && store.hasTable('tenants')) {
    const tName = tenantName(store, tenant);
    return tName ? `${name}（${tName}）` : name;
  }
  return name;
}

function enrichRuns(store: Store, runs: ConsolidationRunRow[]): Json[] {
  const modelCache = new Map<string, string | null>();
  const labelCache = new Map<string, string>();
  const modelName = (id: string | null): string | null => {
    if (!id) return null;
    if (!modelCache.has(id)) {
      const row = store.get('SELECT model_name,provider_name FROM models WHERE id=?', id);
      modelCache.set(id, row ? (row.provider_name ? `${row.provider_name} / ${row.model_name}` : String(row.model_name)) : null);
    }
    return modelCache.get(id)!;
  };
  return runs.map(run => {
    const key = `${run.scope_kind}:${run.scope_id}`;
    if (!labelCache.has(key)) labelCache.set(key, scopeLabel(store, run.scope_kind, run.scope_id));
    return {
      ...run,
      model_name: modelName(run.model_id),
      scope_label: labelCache.get(key)!,
    };
  });
}

function parseOverrideInput(input: Json): { enabled_override?: boolean | null; model_id?: string | null } {
  fields(input, ['enabled_override', 'model_id']);
  const out: { enabled_override?: boolean | null; model_id?: string | null } = {};
  if (input.enabled_override !== undefined) {
    if (input.enabled_override !== null && typeof input.enabled_override !== 'boolean') {
      return fail(400, 'invalid_consolidation_settings', 'enabled_override');
    }
    out.enabled_override = input.enabled_override as boolean | null;
  }
  if (input.model_id !== undefined) {
    if (input.model_id === null || input.model_id === '') {
      out.model_id = null;
    } else {
      out.model_id = text(input.model_id, 128);
    }
  }
  if (!Object.keys(out).length) fail(400, 'invalid_consolidation_settings');
  return out;
}

function decorateScopeView(store: Store, view: Json): Json {
  return {
    ...view,
    runs: enrichRuns(store, (view.runs ?? []) as ConsolidationRunRow[]),
  };
}

export class MemoryConsolidationApi {
  constructor(
    readonly store: Store,
    readonly consolidation: MemoryConsolidationService,
    readonly management: ManagementService,
    readonly channels: ChannelService,
    readonly assistants: AssistantComputerService,
  ) {}

  private async serveMemoryFiles(
    method: string,
    url: URL,
    input: Json,
    isContent: boolean,
    options: {
      canWrite: boolean;
      actorId: string;
      auditPrefix: string;
      prepare: () => Promise<{ id: string; generation: number; mode: 'rw' | 'ro'; directory: string }>;
    },
  ): Promise<Json> {
    const homes = this.assistants.homes;
    if (!homes) {
      if (method === 'GET' && !isContent) {
        return { available: false, read_only: true, can_write: false, files: [] };
      }
      return fail(503, 'assistant_computers_unavailable');
    }
    const prepared = await options.prepare();
    if (!isContent) {
      if (method !== 'GET') return fail(405, 'method_not_allowed');
      const listed = await homes.list(prepared.directory, 'memory', true, 500);
      const files = listed.entries
        .filter((e: any) => e.type === 'file')
        .map((e: any) => ({
          path: String(e.path),
          display_path: '~/memory/' + String(e.path),
          size: Number(e.size ?? 0),
          modified_at: e.modified_at ?? null,
        }));
      return {
        available: true,
        read_only: prepared.mode === 'ro',
        can_write: options.canWrite && prepared.mode === 'rw',
        can_delete: options.canWrite,
        files,
        truncated: listed.truncated,
      };
    }
    if (method === 'GET') {
      const rawPath = url.searchParams.get('path');
      const rel = normalizeAssistantMemoryPath(rawPath, { allowBare: true });
      const { data, size } = await homes.read(prepared.directory, rel, MAX_MEMORY_READ_BYTES);
      const content = configuredRedactor(this.store).text(data.toString('utf8'));
      return {
        path: rel.slice('memory/'.length),
        display_path: '~/' + rel,
        content,
        bytes: data.length,
        size,
        truncated: size > MAX_MEMORY_READ_BYTES,
      };
    }
    if (method === 'PUT') {
      if (!options.canWrite) return fail(403, 'capability_forbidden');
      if (prepared.mode === 'ro') return fail(409, 'assistant_home_read_only');
      fields(input, ['path', 'content']);
      const rel = normalizeAssistantMemoryPath(input.path, { allowBare: true });
      if (typeof input.content !== 'string') return fail(400, 'invalid_memory_content', 'content');
      const written = await homes.writeMemoryText(prepared.directory, rel, input.content);
      await homes.measure(prepared.id).catch(() => {});
      this.store.audit(options.actorId, 'assistant.memory.saved', `${options.auditPrefix}:${rel}`);
      return {
        path: rel.slice('memory/'.length),
        display_path: written.path,
        bytes: written.bytes,
      };
    }
    if (method === 'DELETE') {
      if (!options.canWrite) return fail(403, 'capability_forbidden');
      fields(input, ['path']);
      const rel = normalizeAssistantMemoryPath(input.path, { allowBare: true });
      const removed = await homes.remove(prepared.directory, rel);
      await homes.measure(prepared.id).catch(() => {});
      this.store.audit(options.actorId, 'assistant.memory.deleted', `${options.auditPrefix}:${rel}`);
      return {
        deleted: !!removed.deleted,
        path: rel.slice('memory/'.length),
      };
    }
    return fail(405, 'method_not_allowed');
  }

  /** Handles `/api/channels/chats/:chatId/memory-consolidation*` and `/api/channels/chats/:chatId/memory-files*`. */
  async channelApi(actor: ActorContext, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const path = url.pathname;
    const consMatch = /^\/api\/channels\/chats\/([a-f0-9]{48})\/memory-consolidation(?:\/(run|stop))?$/.exec(path);
    const filesMatch = /^\/api\/channels\/chats\/([a-f0-9]{48})\/memory-files(\/content)?$/.exec(path);
    if (!consMatch && !filesMatch) return undefined;

    assertCurrent(actor);
    const chatId = (consMatch ?? filesMatch)![1]!;
    const chat = this.store.get("SELECT * FROM channel_chats WHERE id=? AND chat_type='group'", chatId);
    if (!chat) return fail(404, 'channel_chat_not_found');
    const binding = this.channels.serviceBindings.get(chatId);
    if (!binding) return fail(404, 'channel_service_binding_not_found');

    const canManage = this.channels.serviceBindings.canManage(actor, chatId);
    const canView = platformManager(actor) || !!this.channels.serviceBindings.canView(actor, chatId);
    if (method === 'GET' ? !canView : !canManage) {
      fail(403, 'channel_service_binding_forbidden');
    }

    if (consMatch) {
      const action = consMatch[2];
      if (!action) {
        if (method === 'GET') {
          return {
            ...decorateScopeView(this.store, this.consolidation.scopeView('group_assistant', chatId)),
            available_models: groupModels(this.store, binding),
            can_manage: canManage,
            binding_enabled: !!binding.enabled,
          };
        }
        if (method === 'PUT') {
          const parsed = parseOverrideInput(input);
          if (parsed.model_id) {
            const projects = scopeProjects(this.store, String(binding.principal_id));
            const modelRow = this.store.get('SELECT * FROM models WHERE id=?', parsed.model_id);
            if (!modelRow) return fail(404, 'model_not_found', 'model_id');
            if (binding.scope === 'organization' && modelRow.repository_id !== null) {
              return fail(400, 'shared_model_required', 'model_id');
            }
            if (binding.scope === 'organization' && modelRow.restricted && !projects.length) {
              return fail(409, 'channel_service_model_unavailable', 'model_id');
            }
            if (modelGaps(this.store, String(modelRow.id), projects).length) {
              return fail(409, 'channel_service_model_unavailable', 'model_id');
            }
          }
          saveConsolidationScopeConfig(this.store, 'group_assistant', chatId, parsed, actor.principal_id);
          return {
            ...decorateScopeView(this.store, this.consolidation.scopeView('group_assistant', chatId)),
            available_models: groupModels(this.store, binding),
            can_manage: canManage,
            binding_enabled: !!binding.enabled,
          };
        }
        return fail(405, 'method_not_allowed');
      }
      if (action === 'run' && method === 'POST') {
        fields(input, []);
        if (!binding.enabled) fail(409, 'channel_service_binding_disabled');
        this.channels.serviceBindings.assertUsable(binding);
        const run = this.consolidation.triggerManual('group_assistant', chatId);
        return {
          run,
          ...decorateScopeView(this.store, this.consolidation.scopeView('group_assistant', chatId)),
          available_models: groupModels(this.store, binding),
          can_manage: canManage,
          binding_enabled: !!binding.enabled,
        };
      }
      if (action === 'stop' && method === 'POST') {
        fields(input, []);
        const stopped = this.consolidation.stopScope('group_assistant', chatId);
        return {
          ...stopped,
          ...decorateScopeView(this.store, this.consolidation.scopeView('group_assistant', chatId)),
          available_models: groupModels(this.store, binding),
          can_manage: canManage,
          binding_enabled: !!binding.enabled,
        };
      }
      return fail(405, 'method_not_allowed');
    }

    // Group ~/memory/ file browser
    const isContent = Boolean(filesMatch![2]);
    if (!binding.enabled) {
      if (method === 'GET' && !isContent) {
        return { available: false, reason: 'binding_disabled', read_only: true, can_write: false, can_delete: false, files: [] };
      }
      fail(409, 'channel_service_binding_disabled');
    }
    return this.serveMemoryFiles(method, url, input, isContent, {
      canWrite: canManage,
      actorId: actor.principal_id,
      auditPrefix: `group:${chatId}`,
      prepare: () => this.assistants.homes!.prepare(
        { kind: 'group', subject: chatId, tenant: String(chat.installation_tenant ?? '') },
        { binding: String(binding.id), role: String(binding.service_role_id), repositories: this.channels.serviceBindings.reach(binding).projects.map(p => p.id) },
        { touch: false },
      ),
    });
  }

  /** Handles global settings, project consolidation, and personal assistant consolidation + ~/memory/ routes. */
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const path = url.pathname;
    const context = user.context!;

    // 1. Global settings & platform-wide recent runs (superAdmin only)
    if (path === '/api/memory/consolidation/settings') {
      superAdmin(user);
      if (method === 'GET') {
        const { runs, total } = listConsolidationRuns(this.store, { limit: 30 });
        return {
          settings: consolidationSettings(this.store),
          defaults: consolidationDefaults,
          bounds: { max_concurrency: [...CONSOLIDATION_CONCURRENCY_BOUNDS] },
          models: sharedModels(this.store),
          recent_runs: enrichRuns(this.store, runs),
          runs_total: total,
        };
      }
      if (method === 'PUT') {
        const saved = saveConsolidationSettings(this.store, user.id, input);
        return {
          settings: saved,
          defaults: consolidationDefaults,
          bounds: { max_concurrency: [...CONSOLIDATION_CONCURRENCY_BOUNDS] },
          models: sharedModels(this.store),
        };
      }
      return fail(405, 'method_not_allowed');
    }

    if (path === '/api/memory/consolidation/runs' && method === 'GET') {
      superAdmin(user);
      const scopeKind = url.searchParams.get('scope_kind') || undefined;
      if (scopeKind && !['project', 'group_assistant', 'personal_assistant'].includes(scopeKind)) {
        fail(400, 'invalid_scope_kind');
      }
      const scopeId = url.searchParams.get('scope_id') || undefined;
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 30;
      const listed = listConsolidationRuns(this.store, {
        scope_kind: scopeKind as ConsolidationScopeKind | undefined,
        scope_id: scopeId,
        offset,
        limit,
      });
      return {
        runs: enrichRuns(this.store, listed.runs),
        total: listed.total,
        next_offset: listed.next_offset,
      };
    }

    // 2. Project consolidation routes
    const projMatch = /^\/api\/repositories\/([^/]+)\/memory-consolidation(?:\/(run|stop))?$/.exec(path);
    if (projMatch) {
      const repoId = projMatch[1]!;
      const action = projMatch[2];
      repository(this.store, user, repoId);
      const access = { actor: context };
      memoryAuthorize(access, repoId, method !== 'GET');
      const canManage = (() => {
        try { memoryAuthorize(access, repoId, true); return true; }
        catch (error) { if (error instanceof HttpError && error.code === 'capability_forbidden') return false; throw error; }
      })();

      if (!action) {
        if (method === 'GET') {
          return {
            ...decorateScopeView(this.store, this.consolidation.scopeView('project', repoId)),
            available_models: projectModels(this.store, repoId),
            can_manage: canManage,
          };
        }
        if (method === 'PUT') {
          const parsed = parseOverrideInput(input);
          if (parsed.model_id && !visibleModel(this.store, repoId, parsed.model_id)) {
            fail(400, 'model_unavailable', 'model_id');
          }
          saveConsolidationScopeConfig(this.store, 'project', repoId, parsed, user.id, repoId);
          return {
            ...decorateScopeView(this.store, this.consolidation.scopeView('project', repoId)),
            available_models: projectModels(this.store, repoId),
            can_manage: canManage,
          };
        }
        return fail(405, 'method_not_allowed');
      }
      if (action === 'run' && method === 'POST') {
        fields(input, []);
        const run = this.consolidation.triggerManual('project', repoId);
        return {
          run,
          ...decorateScopeView(this.store, this.consolidation.scopeView('project', repoId)),
          available_models: projectModels(this.store, repoId),
          can_manage: canManage,
        };
      }
      if (action === 'stop' && method === 'POST') {
        fields(input, []);
        const stopped = this.consolidation.stopScope('project', repoId);
        return {
          ...stopped,
          ...decorateScopeView(this.store, this.consolidation.scopeView('project', repoId)),
          available_models: projectModels(this.store, repoId),
          can_manage: canManage,
        };
      }
      return fail(405, 'method_not_allowed');
    }

    // 3. Personal management assistant consolidation & ~/memory/ file browser
    const persCons = /^\/api\/identity\/memory-consolidation(?:\/(run|stop))?$/.exec(path);
    if (persCons) {
      const action = persCons[1];
      const tenant = context.tenant_id ?? '';
      const scopeId = personalScopeId(context.principal_id, tenant);
      const eligible = isPersonalAssistantEligible(this.store, this.management, context);
      if (!action) {
        if (method === 'GET') {
          return {
            eligible,
            available: !!this.assistants.homes,
            ...decorateScopeView(this.store, this.consolidation.scopeView('personal_assistant', scopeId)),
            available_models: sharedModels(this.store),
            can_manage: eligible,
          };
        }
        if (method === 'PUT') {
          if (!eligible) fail(403, 'capability_forbidden');
          const parsed = parseOverrideInput(input);
          if (parsed.model_id) {
            const row = this.store.get('SELECT id,repository_id FROM models WHERE id=?', parsed.model_id);
            if (!row) return fail(404, 'model_not_found', 'model_id');
            if (row.repository_id !== null) return fail(400, 'shared_model_required', 'model_id');
          }
          saveConsolidationScopeConfig(this.store, 'personal_assistant', scopeId, parsed, user.id);
          return {
            eligible,
            available: !!this.assistants.homes,
            ...decorateScopeView(this.store, this.consolidation.scopeView('personal_assistant', scopeId)),
            available_models: sharedModels(this.store),
            can_manage: eligible,
          };
        }
        return fail(405, 'method_not_allowed');
      }
      if (action === 'run' && method === 'POST') {
        fields(input, []);
        if (!eligible) fail(403, 'capability_forbidden');
        const run = this.consolidation.triggerManual('personal_assistant', scopeId);
        return {
          run,
          eligible,
          available: !!this.assistants.homes,
          ...decorateScopeView(this.store, this.consolidation.scopeView('personal_assistant', scopeId)),
          available_models: sharedModels(this.store),
          can_manage: eligible,
        };
      }
      if (action === 'stop' && method === 'POST') {
        fields(input, []);
        if (!eligible) fail(403, 'capability_forbidden');
        const stopped = this.consolidation.stopScope('personal_assistant', scopeId);
        return {
          ...stopped,
          eligible,
          available: !!this.assistants.homes,
          ...decorateScopeView(this.store, this.consolidation.scopeView('personal_assistant', scopeId)),
          available_models: sharedModels(this.store),
          can_manage: eligible,
        };
      }
      return fail(405, 'method_not_allowed');
    }

    const persFiles = /^\/api\/identity\/memory-files(\/content)?$/.exec(path);
    if (persFiles) {
      const isContent = Boolean(persFiles[1]);
      const tenant = context.tenant_id ?? '';
      const eligible = isPersonalAssistantEligible(this.store, this.management, context);
      if (!eligible) {
        if (method === 'GET' && !isContent) {
          return { available: false, eligible: false, read_only: true, can_write: false, can_delete: false, files: [] };
        }
        fail(403, 'capability_forbidden');
      }
      const res = await this.serveMemoryFiles(method, url, input, isContent, {
        canWrite: true,
        actorId: user.id,
        auditPrefix: `person:${context.principal_id}:${tenant}`,
        prepare: () => this.assistants.homes!.prepare(
          { kind: 'person', subject: context.principal_id, tenant },
          { repositories: [...new Set([...this.management.projects(context), ...this.management.pendingRepositories(context).map(r => r.id)])] },
          { touch: false },
        ),
      });
      return { eligible: true, ...res };
    }

    return undefined;
  }
}
