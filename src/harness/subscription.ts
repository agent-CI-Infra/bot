import { TaskError } from '../agent/common.js';
import type { AgentToolCli } from './agent-tools.js';

/**
 * Model source selector for container CLIs (`claude_code` and `codex`) (#705, #1260).
 *
 * - `'gateway'`: platform-managed model (direct or loopback model relay).
 * - `'local_config'`: platform injects NO model configuration (no base URL, API key, `--model`, or
 *   Codex `config.toml`/`bot_direct`); the CLI reads administrator-written configuration files from the
 *   project computer's persistent HOME (`/workspace/home`) staged into the isolated per-run session directory.
 *
 * Legacy `'subscription'` values in stored configurations normalize to `'local_config'`.
 */
export type HarnessModelSource = 'gateway' | 'local_config';

export const HARNESS_MODEL_SOURCES: readonly HarnessModelSource[] = ['gateway', 'local_config'] as const;

export const LOCAL_CONFIG_CAPABLE_HARNESSES: ReadonlySet<string> = new Set<AgentToolCli>(['claude_code', 'codex']);
/** Back-compat alias kept for existing callers/tests. */
export const SUBSCRIPTION_CAPABLE_HARNESSES = LOCAL_CONFIG_CAPABLE_HARNESSES;

export const SUBSCRIPTION_PROVIDER_DOMAINS: Record<AgentToolCli, readonly string[]> = {
  claude_code: ['api.anthropic.com', 'claude.ai'],
  codex: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
};

export const LOCAL_CONFIG_FILES: Record<AgentToolCli, readonly string[]> = {
  claude_code: ['/workspace/home/.claude/settings.json', '/workspace/home/.claude/.credentials.json'],
  codex: ['/workspace/home/.codex/config.toml', '/workspace/home/.codex/auth.json'],
};

export const LOCAL_CONFIG_SECURITY_NOTICE =
  '这些凭据存放在项目电脑的 /workspace/home 中，同一项目内任意 Agent 的原生 Shell 都可以读取。控制面不读取、不保存文件内容。';

export const SUBSCRIPTION_NOT_IMPLEMENTED_MESSAGE =
  '仅 Claude Code 与 Codex 支持「项目电脑内自行配置」模式；请将模型来源切换回「平台模型」。';

export interface LocalModelConfigStatusView {
  supported: boolean;
  implemented: true;
  mode: 'local_config';
  configured: boolean | null;
  available: boolean;
  config_files: readonly string[];
  files?: Record<string, { path: string; exists: boolean; bytes: number | null; updated_at: string | null }>;
  allowlisted_domains: readonly string[];
  notice: string;
}

export type SubscriptionStatusView = LocalModelConfigStatusView;

export interface CliConfigSnapshot {
  available: boolean;
  reason?: string | null;
  clis?: Partial<Record<AgentToolCli, {
    configured: boolean;
    files: Record<string, { path: string; exists: boolean; bytes: number | null; updated_at: string | null }>;
  }>>;
}

export function subscriptionStatusView(harness: AgentToolCli, snapshot?: CliConfigSnapshot | null): LocalModelConfigStatusView {
  const entry = snapshot?.available ? snapshot.clis?.[harness] : undefined;
  return {
    supported: true,
    implemented: true,
    mode: 'local_config',
    configured: snapshot ? (snapshot.available ? Boolean(entry?.configured) : null) : null,
    available: Boolean(snapshot?.available),
    config_files: LOCAL_CONFIG_FILES[harness],
    ...(entry?.files ? { files: entry.files } : {}),
    allowlisted_domains: SUBSCRIPTION_PROVIDER_DOMAINS[harness],
    notice: LOCAL_CONFIG_SECURITY_NOTICE,
  };
}

export function normalizeHarnessModelSource(value: unknown): HarnessModelSource | null {
  if (value === 'gateway') return 'gateway';
  if (value === 'local_config' || value === 'subscription') return 'local_config';
  return null;
}

export function isHarnessModelSource(value: unknown): value is HarnessModelSource | 'subscription' {
  return normalizeHarnessModelSource(value) !== null;
}

export function assertHarnessModelSourceImplemented(
  source: HarnessModelSource | 'subscription' | undefined,
  field?: string,
  harnessId?: string,
): void {
  const normalized = normalizeHarnessModelSource(source ?? 'gateway');
  if (normalized === 'local_config' && harnessId && !LOCAL_CONFIG_CAPABLE_HARNESSES.has(harnessId)) {
    const prefix = field ? `${field}：` : '';
    throw new TaskError('subscription_mode_not_implemented', 'waiting_configuration', prefix + SUBSCRIPTION_NOT_IMPLEMENTED_MESSAGE);
  }
}
