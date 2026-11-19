import type { Store, Row } from '../storage/database.js';
import {
  DEFAULT_AGENT_TOOLS_ROOT,
  inspectAgentTools,
  type AgentToolCli,
} from '../harness/agent-tools.js';
import { subscriptionStatusView } from '../harness/subscription.js';
import { openModel, selectedModel, visibleModel } from '../agent/model.js';
import { stop, TaskError } from '../agent/common.js';
import { modelProtocol } from '../models/catalog.js';
import { testUpstreamModel } from '../app/model-probe.js';
import { type Json } from '../core/security.js';
import { harnesses } from './harness.js';
import { roleConfiguration } from './definition.js';

export const recommendedBackend = 'pi';
const names: Record<string, string> = {
  pi: 'Pi',
  native: 'Native',
  process: 'Process',
  claude_code: 'Claude Code',
  codex: 'Codex',
};

export interface ModelConnectivityStatus {
  state: 'untested' | 'ok' | 'failed';
  source: 'probe' | 'relay' | null;
  model_id: string | null;
  model_name: string | null;
  checked_at: string | null;
  http_status: number | null;
  error: string | null;
  detail: string | null;
}

export interface BackendResolvedModel {
  id: string;
  name: string;
  source: 'project' | 'workflow' | 'role';
}

export interface BackendRuntimeStatus {
  ready: boolean;
  status: 'ready' | 'unavailable';
  volume_root: string;
  volume_present: boolean;
  cli_installed: boolean;
  installed_versions: string[];
  compatible_versions: string[];
  incompatible_versions: string[];
  selected_version: string | null;
  compatible_range: string;
  tested_version: string;
  node_version: string | null;
  config_override: boolean;
  model_relay_ready: boolean;
  model_count: number;
  resolved_model: BackendResolvedModel | null;
  connectivity: ModelConnectivityStatus;
  reason_code: string | null;
  reason: string | null;
  subscription: ReturnType<typeof subscriptionStatusView>;
}

const emptyConnectivity = (): ModelConnectivityStatus => ({
  state: 'untested',
  source: null,
  model_id: null,
  model_name: null,
  checked_at: null,
  http_status: null,
  error: null,
  detail: null,
});

export function recordModelProbeResult(store: Store, modelRow: Row, probe: Json): ModelConnectivityStatus {
  const checkedAt = new Date().toISOString();
  const ok = probe.ok === true;
  const httpStatus = typeof probe.status === 'number' ? probe.status : null;
  const error = !ok && typeof probe.error === 'string' ? probe.error : null;
  const message = !ok && typeof probe.message === 'string' && probe.message.trim() ? probe.message.trim() : null;
  const detail = ok
    ? null
    : [httpStatus ? `HTTP ${httpStatus}` : null, error, message].filter(Boolean).join(' · ') || '上游模型连通探测失败';
  const entry = {
    ok,
    status: httpStatus,
    error,
    detail,
    checked_at: checkedAt,
    version: Number(modelRow.version ?? 1),
    model_updated_at: String(modelRow.updated_at ?? ''),
  };
  store.run(
    'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'model_probe:' + String(modelRow.id),
    JSON.stringify(entry),
  );
  return {
    state: ok ? 'ok' : 'failed',
    source: 'probe',
    model_id: String(modelRow.id),
    model_name: String(modelRow.model_name),
    checked_at: checkedAt,
    http_status: httpStatus,
    error,
    detail,
  };
}

export function modelConnectivity(store: Store, repositoryId: string | null, modelRow: Row | null | undefined): ModelConnectivityStatus {
  if (!modelRow?.id) return emptyConnectivity();
  const modelId = String(modelRow.id);
  const modelName = String(modelRow.model_name ?? '');
  const updatedAt = String(modelRow.updated_at ?? '');
  const version = Number(modelRow.version ?? 1);

  let probeCandidate: ModelConnectivityStatus | null = null;
  const savedProbeRaw = store.get('SELECT value FROM settings WHERE key=?', 'model_probe:' + modelId)?.value;
  if (savedProbeRaw) {
    try {
      const saved = JSON.parse(String(savedProbeRaw));
      if (saved && saved.version === version && saved.model_updated_at === updatedAt && typeof saved.checked_at === 'string') {
        probeCandidate = {
          state: saved.ok === true ? 'ok' : 'failed',
          source: 'probe',
          model_id: modelId,
          model_name: modelName,
          checked_at: saved.checked_at,
          http_status: typeof saved.status === 'number' ? saved.status : null,
          error: typeof saved.error === 'string' ? saved.error : null,
          detail: typeof saved.detail === 'string' ? saved.detail : null,
        };
      }
    } catch {}
  }

  let relayCandidate: ModelConnectivityStatus | null = null;
  if (repositoryId && store.hasTable('model_requests')) {
    const req = store.get(
      `SELECT state, http_status, requested_at, finished_at
         FROM model_requests
        WHERE repository_id=? AND model_id=? AND state IN ('succeeded','failed') AND requested_at>=?
        ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
      repositoryId,
      modelId,
      updatedAt,
    );
    if (req) {
      const ok = req.state === 'succeeded';
      const httpStatus = typeof req.http_status === 'number' ? req.http_status : null;
      const checkedAt = String(req.finished_at || req.requested_at || '');
      relayCandidate = {
        state: ok ? 'ok' : 'failed',
        source: 'relay',
        model_id: modelId,
        model_name: modelName,
        checked_at: checkedAt || null,
        http_status: httpStatus,
        error: ok ? null : (httpStatus ? `HTTP ${httpStatus}` : 'relay_request_failed'),
        detail: ok ? null : (httpStatus ? `最近一次模型请求失败（HTTP ${httpStatus}）` : '最近一次模型请求失败'),
      };
    }
  }

  if (probeCandidate && relayCandidate) {
    return (relayCandidate.checked_at ?? '') > (probeCandidate.checked_at ?? '') ? relayCandidate : probeCandidate;
  }
  if (probeCandidate) return probeCandidate;
  if (relayCandidate) return relayCandidate;
  return {
    state: 'untested',
    source: null,
    model_id: modelId,
    model_name: modelName,
    checked_at: null,
    http_status: null,
    error: null,
    detail: null,
  };
}

export async function probeRepositoryModel(
  store: Store,
  repositoryId: string,
  options: { role?: string; modelId?: string; workflow?: string } = {},
): Promise<ModelConnectivityStatus> {
  const workflow = options.workflow || 'development.issue';
  let row: Row | undefined;
  if (options.modelId) {
    row = visibleModel(store, repositoryId, options.modelId);
    if (!row?.api_key) return stop('role_model_not_available', 'waiting_configuration', `模型 ${options.modelId} 不可用或缺少凭据。`);
  } else if (options.role) {
    const config = roleConfiguration(store, repositoryId);
    const roleDef = config.roles.find(r => r.role_id === options.role);
    if (roleDef?.model_profile_ref?.model_id) {
      row = visibleModel(store, repositoryId, roleDef.model_profile_ref.model_id);
      if (!row?.api_key) return stop('role_model_not_available', 'waiting_configuration', `角色 ${options.role} 指定的模型不可用或缺少凭据。`);
    }
  }
  if (!row) {
    const selected = selectedModel(store, repositoryId, workflow);
    row = visibleModel(store, repositoryId, selected.id);
    if (!row?.api_key) return stop('model_not_configured', 'waiting_configuration', '项目尚未配置可用默认模型。');
  }
  const opened = openModel(store, row);
  const proto = modelProtocol(store, row as any);
  const probe = await testUpstreamModel(String(row.api_url), opened.key, String(row.model_name), {
    interface_type: proto.interface_type,
    auth_header: proto.auth_header,
  });
  return recordModelProbeResult(store, row, probe);
}

const cliReasonMessages: Record<string, (label: string, root: string, range: string, versions: string[]) => string> = {
  agent_tools_volume_missing: (label, root) =>
    `只读工具卷 ${root} 未挂载；需挂载 agent-tools 卷并安装 ${label} CLI。`,
  platform_arch_unsupported: (label) =>
    `当前主机架构暂不支持容器内 ${label} CLI 工具卷。`,
  cli_not_installed: (label, root, range) =>
    `工具卷 ${root} 中尚未安装 ${label} CLI（兼容范围 ${range}）。`,
  cli_version_incompatible: (label, _root, range, versions) =>
    `工具卷中已安装的 ${label} 版本（${versions.join('、') || '无'}）不在兼容范围 ${range} 内。`,
};

function containerCliStatus(
  cli: AgentToolCli,
  store?: Store,
  repositoryId?: string,
  toolsRoot?: string,
  workflow = 'development.issue',
): BackendRuntimeStatus {
  const root = toolsRoot ?? process.env.BOT_AGENT_TOOLS_DIR ?? DEFAULT_AGENT_TOOLS_ROOT;
  const inspected = inspectAgentTools(root);
  const info = inspected.clis[cli];
  const label = names[cli] ?? cli;
  const overrideVar = cli === 'claude_code' ? 'BOT_CLAUDE_CODE_CONFIG' : 'BOT_CODEX_CONFIG';
  const configOverride = Boolean(process.env[overrideVar]);
  const installedVersions = [...info.compatible_versions, ...info.incompatible_versions];

  let modelCount = store ? 0 : 1;
  let resolvedModel: BackendResolvedModel | null = null;
  let resolvedModelRow: Row | null = null;
  let modelErrorCode: string | null = null;

  if (store && repositoryId) {
    modelCount = Number(
      store.get(
        `SELECT count(*) n FROM models m WHERE m.api_key IS NOT NULL AND (m.repository_id=? OR (m.repository_id IS NULL AND (m.restricted=0 OR EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?))))`,
        repositoryId,
        repositoryId,
      )?.n ?? 0,
    );
    try {
      const opened = selectedModel(store, repositoryId);
      resolvedModel = { id: String(opened.id), name: String(opened.model), source: 'project' };
      resolvedModelRow = store.get('SELECT id,model_name,version,updated_at FROM models WHERE id=?', opened.id) ?? null;
    } catch (err) {
      modelErrorCode = err instanceof TaskError ? err.code : 'model_not_configured';
      const config = roleConfiguration(store, repositoryId);
      const boundRoles = config.roles.filter(
        r => r.enabled && r.harness_ref.id === cli && r.harness_ref.model_source !== 'subscription',
      );
      if (boundRoles.length > 0) {
        const rows = boundRoles.map(r =>
          r.model_profile_ref?.model_id ? visibleModel(store, repositoryId, r.model_profile_ref.model_id) : undefined,
        );
        if (rows.every(r => Boolean(r?.api_key))) {
          const first = rows[0]!;
          resolvedModel = { id: String(first.id), name: String(first.model_name), source: 'role' };
          resolvedModelRow = first;
          modelErrorCode = null;
        }
      }
    }
  }

  const modelRelayReady = (store && repositoryId ? Boolean(resolvedModel) : modelCount > 0) || configOverride;
  const connectivity =
    store && repositoryId && resolvedModelRow
      ? modelConnectivity(store, repositoryId, resolvedModelRow)
      : emptyConnectivity();

  const displayRoot = inspected.container_root;
  let reasonCode: string | null = null;
  let reason: string | null = null;
  if (!configOverride && !info.available) {
    reasonCode = info.reason ?? 'cli_not_installed';
    const formatter = cliReasonMessages[reasonCode];
    reason = formatter
      ? formatter(label, displayRoot, info.compatible_range, installedVersions)
      : `${label} 工具卷不可用（${reasonCode}）。`;
  } else if (!modelRelayReady) {
    reasonCode = modelErrorCode ?? 'model_not_configured';
    reason =
      modelCount > 0
        ? `项目已有 ${modelCount} 个带密钥模型，但尚未选择项目默认模型（请在项目设置选择默认模型，或为使用 ${label} 的角色单独指定模型）。`
        : '项目尚未配置可用于容器内模型中转的上游模型与凭据。';
  }

  const ready = reasonCode === null;
  return {
    ready,
    status: ready ? 'ready' : 'unavailable',
    volume_root: displayRoot,
    volume_present: inspected.volume_present,
    cli_installed: installedVersions.length > 0 || configOverride,
    installed_versions: installedVersions,
    compatible_versions: info.compatible_versions,
    incompatible_versions: info.incompatible_versions,
    selected_version: info.selected_version,
    compatible_range: info.compatible_range,
    tested_version: info.tested_version,
    node_version: info.node_version,
    config_override: configOverride,
    model_relay_ready: modelRelayReady,
    model_count: modelCount,
    resolved_model: resolvedModel,
    connectivity,
    reason_code: reasonCode,
    reason,
    subscription: subscriptionStatusView(cli),
  };
}

export function agentBackends(store?: Store, repositoryId?: string, toolsRoot?: string, workflow = 'development.issue') {
  return [...harnesses]
    .sort((a, b) => Number(b.id === recommendedBackend) - Number(a.id === recommendedBackend))
    .map(h => {
      const isContainerCli = h.id === 'claude_code' || h.id === 'codex';
      const runtime_status = isContainerCli
        ? containerCliStatus(h.id as AgentToolCli, store, repositoryId, toolsRoot, workflow)
        : null;
      return {
        id: h.id,
        name: names[h.id] ?? h.id,
        available: true,
        recommended: h.id === recommendedBackend,
        version: h.version,
        kinds: h.kinds,
        model_source: h.externalModel ? 'external_harness' : 'project',
        supported_model_sources: isContainerCli ? ['gateway', 'subscription'] : ['gateway'],
        integration_issue: null,
        runtime_status,
      };
    });
}
export const plannedBackend = (_id: string) => false;
