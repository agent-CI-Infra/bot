import { TaskError } from '../agent/common.js';
import type { AgentToolCli } from './agent-tools.js';

/**
 * Reserved subscription model source interfaces for `claude_code` and `codex` (#705).
 *
 * This legacy model-source selector names platform model configuration, not the wire transport.
 * External Harnesses default to native direct connections; `modelTransport: 'gateway'` explicitly
 * selects the loopback model relay. Managed subscription credential staging remains reserved.
 *
 * In `'subscription'` mode (reserved for a future release), the CLI would connect directly to vendor domains
 * allowlisted for the container, using sealed subscription credentials staged into the run's CLI state directory
 * only for the duration of the run, with CLI session transcripts collected when the run ends.
 * First release reserves configuration and interfaces only.
 */
export type HarnessModelSource = 'gateway' | 'subscription';

export const HARNESS_MODEL_SOURCES: readonly HarnessModelSource[] = ['gateway', 'subscription'] as const;

export const SUBSCRIPTION_CAPABLE_HARNESSES: ReadonlySet<string> = new Set<AgentToolCli>(['claude_code', 'codex']);

export const SUBSCRIPTION_PROVIDER_DOMAINS: Record<AgentToolCli, readonly string[]> = {
  claude_code: ['api.anthropic.com', 'claude.ai'],
  codex: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
};

export const SUBSCRIPTION_NOT_IMPLEMENTED_MESSAGE =
  '订阅模式暂未实现：首版仅预留配置项与接口（尚未实现订阅登录、容器域名白名单放行与结束会话采集），请将模型来源切换为“平台网关”。';

export interface SubscriptionCredentialBundle {
  harness: AgentToolCli;
  principal_id: string;
  owner_confirmed_tos: boolean;
  recommended_isolation: 'project_computer';
  allowlisted_domains: readonly string[];
  staged_files: Record<string, string>;
  expires_at: string | null;
}

export interface SubscriptionStatusView {
  supported: boolean;
  implemented: false;
  configured: false;
  recommended_isolation: 'project_computer';
  allowlisted_domains: readonly string[];
  notice: string;
}

export interface SubscriptionCredentialStore {
  status(projectId: string, harness: AgentToolCli): SubscriptionStatusView;
  stageForRun(input: {
    runId: string;
    projectId: string;
    harness: AgentToolCli;
    isolation: 'none';
  }): Promise<SubscriptionCredentialBundle>;
  cleanupRun(runId: string): Promise<void>;
  collectSessionTranscript(input: {
    runId: string;
    projectId: string;
    harness: AgentToolCli;
    files: Record<string, string>;
  }): Promise<void>;
}

export function subscriptionStatusView(harness: AgentToolCli): SubscriptionStatusView {
  return {
    supported: true,
    implemented: false,
    configured: false,
    recommended_isolation: 'project_computer',
    allowlisted_domains: SUBSCRIPTION_PROVIDER_DOMAINS[harness],
    notice: SUBSCRIPTION_NOT_IMPLEMENTED_MESSAGE,
  };
}

export function isHarnessModelSource(value: unknown): value is HarnessModelSource {
  return value === 'gateway' || value === 'subscription';
}

export function assertHarnessModelSourceImplemented(source: HarnessModelSource | undefined, field?: string): void {
  if (source === 'subscription') {
    const prefix = field ? `${field}：` : '';
    throw new TaskError('subscription_mode_not_implemented', 'waiting_configuration', prefix + SUBSCRIPTION_NOT_IMPLEMENTED_MESSAGE);
  }
}

export const reservedSubscriptionStore: SubscriptionCredentialStore = {
  status(_projectId, harness) {
    return subscriptionStatusView(harness);
  },
  async stageForRun() {
    throw new TaskError('subscription_mode_not_implemented', 'waiting_configuration', SUBSCRIPTION_NOT_IMPLEMENTED_MESSAGE);
  },
  async cleanupRun() {},
  async collectSessionTranscript() {
    throw new TaskError('subscription_mode_not_implemented', 'waiting_configuration', SUBSCRIPTION_NOT_IMPLEMENTED_MESSAGE);
  },
};
