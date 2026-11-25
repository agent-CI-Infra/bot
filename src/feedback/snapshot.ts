import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { resolve } from 'node:path';
import type { Row, Store } from '../storage/database.js';
import type { Json } from '../core/security.js';
import { projectCeiling } from '../projects/ceiling.js';
import type { RolePermissions } from '../roles/permissions.js';
import type { FeedbackSourceKind } from './storage.js';

const LAUNCHPAD_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
})();

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Strips username, password, query string, and hash fragment from a model API URL so no key/credential ever persists. */
export function sanitizeApiUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export interface RecentToolSummary {
  name: string;
  outcome: string;
  error?: string | null;
  at?: string | null;
}

export interface FeedbackSnapshotInput {
  source_kind: FeedbackSourceKind;
  untrusted_context: boolean;
  repository_id?: string | null;
  repository_full_name?: string | null;
  scope_summary?: Json | null;
  role: {
    role_id: string | null;
    role_name?: string | null;
    kind?: string | null;
    config_revision?: number | null;
    role_revision?: number | null;
    snapshot_id?: string | null;
    binding_id?: string | null;
    binding_revision?: number | null;
    system_prompt: string;
    persona_prompt?: string | null;
    administrator_prompt?: string | null;
    permissions?: RolePermissions | Json | null;
    budget?: Json | null;
    offered_tools: string[];
  };
  model?: {
    id?: string | null;
    name?: string | null;
    version?: number | null;
    source?: string | null;
    api_url?: string | null;
    interface_type?: string | null;
    transport?: string | null;
  } | null;
  harness?: {
    id?: string | null;
    version?: string | null;
    cli_version?: string | null;
    environment?: string | null;
    model_source?: string | null;
  } | null;
  skills?: {
    bundle?: {
      id?: string | null;
      revision?: number | null;
      content_hash?: string | null;
      source?: Json | null;
      files?: { path: string; sha256?: string; bytes?: number }[];
    } | null;
    skills_read?: string[];
  } | null;
  execution?: {
    task_id?: string | null;
    task_kind?: string | null;
    task_status?: string | null;
    task_phase?: string | null;
    object_number?: number | null;
    attempt?: number | null;
    run_id?: string | null;
    instance_id?: string | null;
    assignment_id?: string | null;
    recovery_mode?: string | null;
    lease_epoch?: number | null;
    dispatch_event_id?: string | null;
    dispatch_event_type?: string | null;
    dispatch_thread_key?: string | null;
    conversation_id?: string | null;
    turn_id?: string | null;
    consolidation_run_id?: string | null;
    consolidation_scope_kind?: string | null;
    consolidation_scope_id?: string | null;
    own_task_id?: string | null;
    started_at?: string | null;
    elapsed_ms?: number | null;
    recent_tools?: RecentToolSummary[];
  };
}

/** Collects authoritative project metadata & policy summary directly from SQLite (never trusts model self-reports). */
export function collectProjectSummary(store: Store, repositoryId: string | null | undefined): Json | null {
  if (!repositoryId) return null;
  const repo = store.get('SELECT id, full_name, owner_id, account_id FROM repositories WHERE id=?', repositoryId);
  if (!repo) {
    return { repository_id: repositoryId, full_name: null, exists: false };
  }
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const ceiling = (() => {
    try { return projectCeiling(store, repositoryId); } catch { return null; }
  })();
  return {
    repository_id: String(repo.id),
    full_name: String(repo.full_name),
    owner_id: String(repo.owner_id ?? ''),
    enabled: policy ? Boolean(policy.enabled) : null,
    capability_ceiling: ceiling,
    base_branch: policy?.base_branch ? String(policy.base_branch) : null,
    auto_merge_policy: policy?.auto_merge_policy ? String(policy.auto_merge_policy) : null,
    review_language: policy?.review_language ? String(policy.review_language) : null,
    test_command_configured: Boolean(policy?.test_command && String(policy.test_command).trim()),
    task_concurrency: policy?.task_concurrency == null ? null : Number(policy.task_concurrency),
    command_timeout_seconds: policy?.command_timeout_seconds == null ? null : Number(policy.command_timeout_seconds),
  };
}

/** Queries recently read skill paths from task_history for a project role run/task. */
export function collectTaskSkillsRead(store: Store, taskId: string, runId?: string | null, role?: string | null): string[] {
  if (!store.hasTable('task_history')) return [];
  const rows = runId
    ? store.all("SELECT data FROM task_history WHERE task_id=? AND run_id=? AND type='skill_read' ORDER BY id ASC LIMIT 100", taskId, runId)
    : role
      ? store.all("SELECT data FROM task_history WHERE task_id=? AND type='skill_read' AND json_extract(data,'$.role')=? ORDER BY id ASC LIMIT 100", taskId, role)
      : store.all("SELECT data FROM task_history WHERE task_id=? AND type='skill_read' ORDER BY id ASC LIMIT 100", taskId);
  const paths = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.data ?? '{}')) as { path?: unknown };
      if (typeof parsed.path === 'string' && parsed.path.trim()) paths.add(parsed.path.trim());
    } catch { /* ignore malformed row */ }
  }
  return [...paths];
}

/** Queries recent tool summaries (names & outcomes only, zero raw payloads) from role_run_events / task_history. */
export function collectRunRecentTools(store: Store, taskId: string, runId?: string | null, limit = 20): RecentToolSummary[] {
  if (!runId || !store.hasTable('role_run_events')) return [];
  const rows = store.all(
    `SELECT e.type, e.category, e.created_at, h.data
     FROM role_run_events e
     JOIN task_history h ON h.task_id=e.task_id AND h.id=CAST(substr(e.history_ref,14) AS INTEGER)
     WHERE e.run_id=? AND e.type IN ('tool_result','tool_call')
     ORDER BY e.seq DESC LIMIT ?`,
    runId,
    limit * 2,
  );
  const out: RecentToolSummary[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (String(row.type) !== 'tool_result') continue;
    try {
      const outer = JSON.parse(String(row.data ?? '{}')) as { data?: Record<string, unknown> };
      const data = outer.data ?? {};
      const name = typeof data.name === 'string' ? data.name : null;
      if (!name) continue;
      out.push({
        name,
        outcome: typeof data.outcome === 'string' ? data.outcome : String(row.category ?? 'observation'),
        error: typeof data.error === 'string' ? data.error : null,
        at: String(row.created_at ?? ''),
      });
    } catch { /* ignore malformed row */ }
  }
  return out.reverse();
}

/** Looks up the authoritative CLI version and start time recorded on a task_runs row. */
export function collectTaskRunMeta(store: Store, runId?: string | null): { cli_version: string | null; started_at: string | null } {
  if (!runId || !store.hasTable('task_runs')) return { cli_version: null, started_at: null };
  const row = store.get('SELECT cli_version, started_at FROM task_runs WHERE id=?', runId);
  return {
    cli_version: row?.cli_version ? String(row.cli_version) : null,
    started_at: row?.started_at ? String(row.started_at) : null,
  };
}

/** Builds a bounded ring buffer for tracking recent tool invocations inside turns without task_runs tables. */
export class RecentToolTracker {
  private readonly items: RecentToolSummary[] = [];
  constructor(private readonly max = 20) {}
  record(name: string, outcome: string, error?: string | null): void {
    this.items.push({ name, outcome, error: error ?? null, at: new Date().toISOString() });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }
  snapshot(): RecentToolSummary[] {
    return this.items.map(item => ({ ...item }));
  }
}

/**
 * Assembles the complete, server-authoritative environment & role configuration snapshot.
 * Never accepts model-supplied environment claims; never includes API keys, tokens, or secrets.
 */
export function buildEnvironmentSnapshot(store: Store, input: FeedbackSnapshotInput, nowMs = Date.now()): Json {
  const project = collectProjectSummary(store, input.repository_id);
  const systemPrompt = String(input.role.system_prompt ?? '');
  const personaPrompt = input.role.persona_prompt != null ? String(input.role.persona_prompt) : null;
  const adminPrompt = input.role.administrator_prompt != null ? String(input.role.administrator_prompt) : null;
  const startedAt = input.execution?.started_at ?? null;
  const elapsedMs = input.execution?.elapsed_ms !== undefined && input.execution?.elapsed_ms !== null
    ? Math.max(0, Math.round(input.execution.elapsed_ms))
    : startedAt && Number.isFinite(Date.parse(startedAt))
      ? Math.max(0, nowMs - Date.parse(startedAt))
      : null;

  const modelRow: Row | undefined = input.model?.id && store.hasTable('models')
    ? store.get('SELECT id, model_name, api_url, version FROM models WHERE id=?', input.model.id)
    : undefined;

  return {
    collected_at: new Date(nowMs).toISOString(),
    platform: {
      launchpad_version: LAUNCHPAD_VERSION,
      image_tag: process.env.BOT_IMAGE_TAG || null,
      node_version: process.version,
      os_platform: process.platform,
      os_arch: process.arch,
      os_release: osRelease(),
    },
    source_kind: input.source_kind,
    untrusted_context: Boolean(input.untrusted_context),
    project,
    ...(input.scope_summary ? { scope_summary: input.scope_summary } : {}),
    role_config: {
      role_id: input.role.role_id ?? null,
      role_name: input.role.role_name ?? null,
      kind: input.role.kind ?? null,
      config_revision: input.role.config_revision ?? null,
      role_revision: input.role.role_revision ?? null,
      snapshot_id: input.role.snapshot_id ?? null,
      binding_id: input.role.binding_id ?? null,
      binding_revision: input.role.binding_revision ?? null,
      system_prompt: systemPrompt,
      system_prompt_sha256: sha256(systemPrompt),
      persona_prompt: personaPrompt,
      ...(personaPrompt !== null ? { persona_prompt_sha256: sha256(personaPrompt) } : {}),
      administrator_prompt: adminPrompt,
      permissions: input.role.permissions ?? null,
      budget: input.role.budget ?? null,
      offered_tools: [...new Set(input.role.offered_tools)].sort(),
    },
    model: input.model ? {
      id: input.model.id ?? (modelRow ? String(modelRow.id) : null),
      name: input.model.name ?? (modelRow ? String(modelRow.model_name) : null),
      version: input.model.version ?? (modelRow ? Number(modelRow.version) : null),
      source: input.model.source ?? null,
      api_url: sanitizeApiUrl(input.model.api_url ?? (modelRow ? String(modelRow.api_url) : null)),
      interface_type: input.model.interface_type ?? null,
      transport: input.model.transport ?? null,
    } : null,
    harness: input.harness ? {
      id: input.harness.id ?? null,
      version: input.harness.version ?? null,
      cli_version: input.harness.cli_version ?? null,
      environment: input.harness.environment ?? null,
      model_source: input.harness.model_source ?? null,
    } : null,
    skills: {
      bundle: input.skills?.bundle ? {
        id: input.skills.bundle.id ?? null,
        revision: input.skills.bundle.revision ?? null,
        content_hash: input.skills.bundle.content_hash ?? null,
        source: input.skills.bundle.source ?? null,
        files: (input.skills.bundle.files ?? []).slice(0, 200).map(file => ({
          path: file.path,
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
          ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
        })),
      } : null,
      skills_read: [...new Set(input.skills?.skills_read ?? [])].slice(0, 100),
    },
    execution: {
      task_id: input.execution?.task_id ?? null,
      task_kind: input.execution?.task_kind ?? null,
      task_status: input.execution?.task_status ?? null,
      task_phase: input.execution?.task_phase ?? null,
      object_number: input.execution?.object_number ?? null,
      attempt: input.execution?.attempt ?? null,
      run_id: input.execution?.run_id ?? null,
      instance_id: input.execution?.instance_id ?? null,
      assignment_id: input.execution?.assignment_id ?? null,
      recovery_mode: input.execution?.recovery_mode ?? null,
      lease_epoch: input.execution?.lease_epoch ?? null,
      dispatch_event_id: input.execution?.dispatch_event_id ?? null,
      dispatch_event_type: input.execution?.dispatch_event_type ?? null,
      dispatch_thread_key: input.execution?.dispatch_thread_key ?? null,
      conversation_id: input.execution?.conversation_id ?? null,
      turn_id: input.execution?.turn_id ?? null,
      consolidation_run_id: input.execution?.consolidation_run_id ?? null,
      consolidation_scope_kind: input.execution?.consolidation_scope_kind ?? null,
      consolidation_scope_id: input.execution?.consolidation_scope_id ?? null,
      own_task_id: input.execution?.own_task_id ?? null,
      started_at: startedAt,
      elapsed_ms: elapsedMs,
      recent_tools: (input.execution?.recent_tools ?? []).slice(-20),
    },
  };
}
