import type { Store } from '../storage/database.js';
import {
  DEFAULT_AGENT_TOOLS_ROOT,
  inspectAgentTools,
  type AgentToolCli,
} from '../harness/agent-tools.js';
import { subscriptionStatusView } from '../harness/subscription.js';
import { harnesses } from './harness.js';

export const recommendedBackend = 'pi';
const names: Record<string, string> = {
  pi: 'Pi',
  native: 'Native',
  process: 'Process',
  claude_code: 'Claude Code',
  codex: 'Codex',
};

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
  reason_code: string | null;
  reason: string | null;
  subscription: ReturnType<typeof subscriptionStatusView>;
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
): BackendRuntimeStatus {
  const root = toolsRoot ?? process.env.BOT_AGENT_TOOLS_DIR ?? DEFAULT_AGENT_TOOLS_ROOT;
  const inspected = inspectAgentTools(root);
  const info = inspected.clis[cli];
  const label = names[cli] ?? cli;
  const overrideVar = cli === 'claude_code' ? 'BOT_CLAUDE_CODE_CONFIG' : 'BOT_CODEX_CONFIG';
  const configOverride = Boolean(process.env[overrideVar]);
  const installedVersions = [...info.compatible_versions, ...info.incompatible_versions];

  const modelCount =
    store && repositoryId
      ? Number(
          store.get(
            `SELECT count(*) n FROM models m WHERE m.api_key IS NOT NULL AND (m.repository_id=? OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?)))`,
            repositoryId,
            repositoryId,
          )?.n ?? 0,
        )
      : store
        ? 0
        : 1;
  const modelRelayReady = modelCount > 0 || configOverride;

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
    reasonCode = 'model_not_configured';
    reason = '项目尚未配置可用于容器内模型中转的上游模型与凭据。';
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
    reason_code: reasonCode,
    reason,
    subscription: subscriptionStatusView(cli),
  };
}

export function agentBackends(store?: Store, repositoryId?: string, toolsRoot?: string) {
  return [...harnesses]
    .sort((a, b) => Number(b.id === recommendedBackend) - Number(a.id === recommendedBackend))
    .map(h => {
      const isContainerCli = h.id === 'claude_code' || h.id === 'codex';
      const runtime_status = isContainerCli
        ? containerCliStatus(h.id as AgentToolCli, store, repositoryId, toolsRoot)
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
