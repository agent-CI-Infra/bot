import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TaskError } from '../agent/common.js';
import type { AgentSpec, ExternalUsage } from '../agent/runtime.js';
import { executionModel } from '../tasks/configuration.js';
import type { RuntimeModel } from '../agent/model.js';
import type { RunContext } from '../roles/protocol.js';
import { contentHash } from '../roles/protocol.js';
import type { HarnessEvent } from './session.js';
import { claudeCodeRuntime, ClaudeJsonStream, claudeUserMessage, uuidPattern, type ClaudeUsage } from './claude-code-protocol.js';
import { COMPATIBLE_CLI_RANGES, DEFAULT_AGENT_TOOLS_ROOT, satisfiesCliRange, selectCompatibleCliVersion } from './agent-tools.js';
import { readProviderCredentialFile, type FileBackedModelProvider } from './model-gateway.js';
import { filterPlatformTools, withContainerHarnessSession } from './container-session.js';
import { modelTransport, type ModelTransport } from './model-connection.js';
import type { HarnessModelSource } from './subscription.js';

export interface ClaudeProviderConfig {
  baseUrl: string;
  credentialFile: string;
}

export interface ClaudeConfiguration {
  modelTransport?: ModelTransport;
  command?: string;
  version: string;
  stateDirectory: string;
  model: string;
  provider?: ClaudeProviderConfig;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ClaudePreparation {
  modelTransport: ModelTransport;
  modelSource?: HarnessModelSource;
  mode: 'volume' | 'config_file';
  config?: ClaudeConfiguration;
  command: string;
  nodeExecutable?: string;
  version: string;
  model?: string;
  primaryModel?: RuntimeModel;
  fileProvider?: FileBackedModelProvider;
  configurationHash: string;
}

const fail = (
  code: string,
  state: 'waiting_configuration' | 'retry_wait' | 'cancelled' | 'needs_replan' = 'waiting_configuration',
  detail?: string,
): never => {
  throw new TaskError(code, state, detail);
};

const executionFailure = (fault: string): never =>
  fail(
    ({
      authentication: 'claude_authentication_failed',
      model: 'claude_model_unavailable',
      rate_limit: 'claude_rate_limited',
      transport: 'claude_transport_error',
    } as Record<string, string>)[fault] ?? 'claude_execution_failed',
    ['rate_limit', 'transport', 'execution'].includes(fault) ? 'retry_wait' : 'waiting_configuration',
  );

const FORBIDDEN_CLAUDE_TOOLS = new Set([
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'PushNotification',
]);

/** Optional operator/test override file (`BOT_CLAUDE_CODE_CONFIG`); normal runs select `/opt/agent-tools/claude_code/<ver>` + project model. */
export function claudeConfiguration(): ClaudeConfiguration {
  const path = process.env.BOT_CLAUDE_CODE_CONFIG;
  if (!path) return fail('claude_not_configured');
  let c: any;
  try {
    c = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail('claude_configuration_invalid');
  }
  if (
    !c ||
    Object.keys(c).some(k => !['command', 'version', 'stateDirectory', 'model', 'provider', 'timeoutMs', 'env', 'modelTransport'].includes(k)) ||
    typeof c.version !== 'string' ||
    !satisfiesCliRange('claude_code', c.version) ||
    typeof c.stateDirectory !== 'string' ||
    !isAbsolute(c.stateDirectory) ||
    (c.command !== undefined && (typeof c.command !== 'string' || !isAbsolute(c.command))) ||
    typeof c.model !== 'string' ||
    !/^claude-[a-z0-9]+(?:-[a-z0-9.]+)+$/.test(c.model) ||
    /(?:^|-)latest$/.test(c.model) ||
    (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 3600_000))
  ) {
    return fail('claude_configuration_invalid');
  }
  if (c.provider !== undefined && (
    !c.provider ||
    typeof c.provider !== 'object' ||
    Array.isArray(c.provider) ||
    Object.keys(c.provider).some(k => !['baseUrl', 'credentialFile'].includes(k)) ||
    typeof c.provider.credentialFile !== 'string' ||
    !isAbsolute(c.provider.credentialFile)
  )) {
    return fail('claude_configuration_invalid');
  }
  let url: URL;
  try {
    url = new URL(c.provider?.baseUrl ?? 'https://api.anthropic.com');
  } catch {
    return fail('claude_configuration_invalid');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    return fail('claude_configuration_invalid');
  }
  const extraEnv: Record<string, string> = {};
  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== 'object' || Array.isArray(c.env)) return fail('claude_configuration_invalid');
    for (const [k, v] of Object.entries(c.env)) {
      if (typeof v !== 'string' || !(k==='CLAUDE_CONFIG_DIR'||/^FIXTURE_[A-Z0-9_]+$/.test(k))) return fail('claude_configuration_invalid');
      extraEnv[k] = v;
    }
  }
  return {
    modelTransport: modelTransport(c.modelTransport),
    version: c.version,
    stateDirectory: c.stateDirectory,
    model: c.model,
    ...(c.command ? { command: c.command } : {}),
    ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
    ...(Object.keys(extraEnv).length ? { env: extraEnv } : {}),
    ...(c.provider ? {provider: { baseUrl: c.provider.baseUrl, credentialFile: c.provider.credentialFile }} : {}),
  };
}

/** Resolve the devDependency CLI binary for local smoke probes when `/opt/agent-tools` is not used. */
export function claudeBinary(): string {
  const platform = process.platform, arch = process.arch;
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) return fail('claude_platform_unsupported');
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const name = `@anthropic-ai/claude-code-linux-${arch}${report.header.glibcVersionRuntime ? '' : '-musl'}`;
  try {
    return join(dirname(createRequire(import.meta.url).resolve(name + '/package.json')), 'claude');
  } catch {
    return fail('claude_binary_unavailable');
  }
}

function privateDirectory(path: string) {
  let ancestor = resolve(path);
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) return fail('claude_state_directory_invalid');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (realpathSync(path) !== resolve(path) || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    return fail('claude_state_directory_invalid');
  }
}

function hostPreflightEnv(home: string, tmp: string): NodeJS.ProcessEnv {
  return {
    PATH: dirname(process.execPath) + ':/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: home,
    TMPDIR: tmp,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** Called by RoleRun.prepare before start: select compatible CLI from `/opt/agent-tools` (or verified test config) and bind model. */
export async function prepareClaudeCode<T>(spec: AgentSpec<T>): Promise<ClaudePreparation> {
  if (!spec.finish || !spec.tools?.some(t => t.function.name === spec.finish!.name)) {
    return fail('claude_submission_tool_required');
  }

  if (process.env.BOT_CLAUDE_CODE_CONFIG) {
    const config = claudeConfiguration();
    for(const [name,value] of Object.entries(config.env??{}))if(/key|token|secret|password/i.test(name))spec.redactor.add(value);
    const command = config.command ?? claudeBinary();
    privateDirectory(config.stateDirectory);
    const dir = mkdtempSync(join(config.stateDirectory, 'preflight-'));
    privateDirectory(join(dir, 'tmp'));
    try {
      const versionOut = await new Promise<string>((ok, no) =>
        execFile(
          command,
          ['--version'],
          { cwd: dir, env: hostPreflightEnv(dir, join(dir, 'tmp')), timeout: 10_000, maxBuffer: 4096 },
          (e, stdout) => (e ? no(new TaskError('claude_binary_unavailable', 'waiting_configuration')) : ok(stdout.trim())),
        ),
      );
      const match = /^(\d+\.\d+\.\d+)\s+\(Claude Code\)$/.exec(versionOut);
      if (!match || match[1] !== config.version || !satisfiesCliRange('claude_code', match[1])) {
        return fail('claude_version_unsupported');
      }
      const localConfig = spec.containerOptions?.modelSource === 'local_config';
      const configurationHash = contentHash({
        ...config,
        command,
        modelTransport: localConfig ? 'direct' : modelTransport(spec.containerOptions?.modelTransport ?? config.modelTransport),
        ...(localConfig ? { modelSource: 'local_config' } : {}),
        protocol: claudeCodeRuntime.protocol,
      });
      const fileProvider: FileBackedModelProvider | undefined = !localConfig && config.provider ? {
        id: 'claude_config_provider',
        baseUrl: config.provider.baseUrl,
        credentialFile: config.provider.credentialFile,
        model: config.model,
        interfaceType: 'anthropic-messages',
        authHeader: 'x-api-key',
      } : undefined;
      const prepared: ClaudePreparation = {
        modelTransport: localConfig ? 'direct' : modelTransport(spec.containerOptions?.modelTransport ?? config.modelTransport),
        modelSource: localConfig ? 'local_config' : 'gateway',
        mode: 'config_file',
        config,
        command,
        version: match[1],
        ...(localConfig ? {} : { model: config.model }),
        ...(fileProvider ? { fileProvider } : {}),
        configurationHash,
      };
      spec.harnessPreparation = prepared;
      spec.harnessBinding = {
        model_revision: localConfig ? `claude_code:local_config:${configurationHash}` : `claude_code:${config.model}:${configurationHash}`,
        harness_revision: `claude_code@${match[1]}:${configurationHash}`,
        cli_version: match[1],
      };
      return prepared;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const override = spec.containerOptions?.executableOverride;
  let command: string;
  let nodeExecutable: string | undefined;
  let cliVersion: string;
  if (override) {
    command = override.executable;
    nodeExecutable = override.nodeExecutable;
    cliVersion = override.version ?? COMPATIBLE_CLI_RANGES.claude_code.tested;
    if (!satisfiesCliRange('claude_code', cliVersion)) return fail('claude_version_unsupported');
  } else {
    const selected = selectCompatibleCliVersion(process.env.BOT_AGENT_TOOLS_DIR ?? DEFAULT_AGENT_TOOLS_ROOT, 'claude_code');
    command = selected.container_executable;
    nodeExecutable = selected.container_node_executable ?? undefined;
    cliVersion = selected.version;
  }

  const localConfig = spec.containerOptions?.modelSource === 'local_config';
  if (localConfig) {
    const configurationHash = contentHash({
      cli: 'claude_code',
      version: cliVersion,
      command,
      modelSource: 'local_config',
      protocol: claudeCodeRuntime.protocol,
    });
    const prepared: ClaudePreparation = {
      modelTransport: 'direct',
      modelSource: 'local_config',
      mode: 'volume',
      command,
      ...(nodeExecutable ? { nodeExecutable } : {}),
      version: cliVersion,
      configurationHash,
    };
    spec.harnessPreparation = prepared;
    spec.harnessBinding = {
      model_revision: `claude_code:local_config:${configurationHash}`,
      harness_revision: `claude_code@${cliVersion}:${configurationHash}`,
      cli_version: cliVersion,
    };
    return prepared;
  }

  const fileProvider = spec.containerOptions?.fileProvider;
  const primaryModel = fileProvider
    ? undefined
    : ((spec.model as RuntimeModel | undefined) ?? (executionModel(spec.store, spec.task) as RuntimeModel));
  const modelName = fileProvider ? fileProvider.model : primaryModel!.model;
  const configurationHash = contentHash({
    cli: 'claude_code',
    version: cliVersion,
    command,
    model: modelName,
    model_id: primaryModel?.id ?? fileProvider?.id ?? 'provider',
    protocol: claudeCodeRuntime.protocol,
    modelTransport:modelTransport(spec.containerOptions?.modelTransport),
  });
  const prepared: ClaudePreparation = {
    modelTransport: modelTransport(spec.containerOptions?.modelTransport),
    mode: 'volume',
    command,
    ...(nodeExecutable ? { nodeExecutable } : {}),
    version: cliVersion,
    model: modelName,
    ...(primaryModel ? { primaryModel } : {}),
    ...(fileProvider ? { fileProvider } : {}),
    configurationHash,
  };
  spec.harnessPreparation = prepared;
  spec.harnessBinding = {
    model_revision: primaryModel
      ? `project_model:${primaryModel.id}@${primaryModel.version}:${modelName}`
      : `claude_code:${modelName}:${configurationHash}`,
    harness_revision: `claude_code@${cliVersion}:${configurationHash}`,
    cli_version: cliVersion,
  };
  return prepared;
}

const scope = (ctx: RunContext) => ({
  tenant_id: ctx.tenant_id,
  project_id: ctx.project_id,
  task_id: ctx.task_id,
  ...(ctx.conversation_id ? { conversation_id: ctx.conversation_id } : {}),
  instance_id: ctx.execution_context?.role_instance_id,
  role: ctx.execution_context?.role,
  assignment_id: ctx.assignment_id,
});
const identity = (value: any) => value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'assignment_id'));
const inputs = (ctx: RunContext) =>
  contentHash({
    source: ctx.conversation_id ? 'conversation:'+ctx.conversation_id : ctx.source_ref,
    contract: ctx.contract_revision,
    candidate: ctx.candidate_ref,
    role: ctx.role_revision,
    policy: ctx.policy_revision,
    skills: ctx.skill_revisions,
    model: ctx.model_revision,
  });

async function preflightFileProvider(provider: FileBackedModelProvider, expectedModel: string, signal: AbortSignal) {
  let key: string;
  try {
    key = readProviderCredentialFile(provider.credentialFile!).key;
  } catch {
    return fail('claude_provider_credential_unavailable');
  }
  let response: Response;
  const modelsUrl = provider.baseUrl.replace(/\/+$/, '').endsWith('/v1')
    ? provider.baseUrl.replace(/\/+$/, '') + '/models'
    : provider.baseUrl.replace(/\/+$/, '') + '/v1/models';
  try {
    response = await fetch(modelsUrl, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: 'error',
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    return fail('claude_gateway_unavailable', 'retry_wait');
  }
  if ([401, 403].includes(response.status)) return fail('claude_authentication_failed');
  if (response.status === 429) return fail('claude_rate_limited', 'retry_wait');
  if (!response.ok) return fail('claude_gateway_unavailable', 'retry_wait');
  let body: any;
  try {
    body = await response.json();
  } catch {
    return fail('claude_gateway_protocol_invalid');
  }
  if (!Array.isArray(body?.data) || !body.data.some((m: any) => m?.id === expectedModel)) {
    return fail('claude_model_unavailable');
  }
}

function isAllowedClaudeTool(name: string, allowedMcpTools: Set<string>, egress: boolean): boolean {
  if (name.startsWith('mcp__bot__')) return allowedMcpTools.has(name);
  if(name.startsWith('mcp__'))return false;
  if (FORBIDDEN_CLAUDE_TOOLS.has(name)) return false;
  if (!egress && (name === 'WebFetch' || name === 'WebSearch')) return false;
  return /^[A-Z][A-Za-z0-9_]{0,63}$/.test(name);
}

/** Drives Claude Code inside the project computer or per-run container via `container-session.ts`. */
export async function runClaudeCode<T>(
  spec: AgentSpec<T>,
  signal: AbortSignal,
  emit: (e: HarnessEvent) => void,
): Promise<T> {
  const prepared = (spec.harnessPreparation as ClaudePreparation | undefined) ?? (await prepareClaudeCode(spec));
  const ctx = spec.runContext?.();
  if (!ctx || !spec.runAccess?.token) return fail('claude_run_context_required');
  // Manager, QA and the service assistants run only on Pi (#1337).
  if (!['writer', 'observer'].includes(ctx.execution_context?.kind ?? '')) {
    return fail('harness_role_unsupported');
  }
  await spec.guard();
  if (signal.aborted) throw signal.reason;

  if (prepared.fileProvider?.credentialFile && prepared.model) {
    await preflightFileProvider(prepared.fileProvider, prepared.model, signal);
  }

  const platformTools = filterPlatformTools(spec);
  const allowedMcpNames = platformTools.map(t => 'mcp__bot__' + t.function.name);
  if (allowedMcpNames.some(n => !/^mcp__bot__[A-Za-z0-9_]+$/.test(n))) {
    return fail('claude_tool_name_unsupported');
  }
  const allowedMcpSet = new Set(allowedMcpNames);

  const previous = spec.harnessState?.value ?? {};
  const fresh =
    ctx.execution_context?.kind === 'evaluator' ||
    spec.roleRun?.recovery_mode === 'rebuilt_from_task_records';
  if (!fresh && previous.sessionId && previous.scope && contentHash(identity(previous.scope)) !== contentHash(identity(scope(ctx)))) {
    return fail('claude_session_scope_mismatch');
  }

  const inputHash = inputs(ctx);
  const sessionKey = (spec.harnessSessionKey ?? contentHash(scope(ctx)).slice(0, 48)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
  const compatible =
    !fresh &&
    typeof previous.sessionId === 'string' &&
    uuidPattern.test(previous.sessionId) &&
    contentHash(previous.scope) === contentHash(scope(ctx)) &&
    previous.configurationHash === prepared.configurationHash &&
    previous.inputHash === inputHash;

  if (compatible && previous.sessionKey && previous.sessionKey !== sessionKey) {
    return fail('claude_session_scope_mismatch');
  }

  const requestedSid = compatible ? String(previous.sessionId) : randomUUID();
  const egress = Boolean(spec.containerOptions?.egress);
  const trustedClaudeDoc =
    spec.harnessAccess?.trustedCheckout === false
      ? (typeof spec.harnessAccess.trustedClaudeMd === 'string' && spec.harnessAccess.trustedClaudeMd.trim()
          ? spec.harnessAccess.trustedClaudeMd
          : typeof spec.harnessAccess.trustedAgentsMd === 'string' && spec.harnessAccess.trustedAgentsMd.trim()
            ? spec.harnessAccess.trustedAgentsMd
            : null)
      : null;
  const systemPrompt =
    spec.system +
    '\nYou are running inside the isolated workspace container with cwd at the repository checkout. ' +
    'Use native file, search, edit, shell, and sub-agent tools directly on the repository checkout, and use the offered bot MCP tools (mcp__bot__*) for platform task records, memory, and structured submission. ' +
    (platformTools.some(t => t.function.name === 'read_skill')
      ? 'Read pinned skills with mcp__bot__read_skill when applicable. '
      : spec.harnessSkillSet?.skills.length
        ? 'Pinned skills are loaded natively via the bot plugin from read-only files; use them when applicable without treating them as permission overrides. '
        : '') +
    `Submit through mcp__bot__${spec.finish!.name}; a text reply alone is not a submission, and submission is followed by independent acceptance. Do not publish or push directly from shell.` +
    (trustedClaudeDoc ? '\n\n## Trusted Repository Instructions (CLAUDE.md)\n' + trustedClaudeDoc : '');

  let streamFailure: unknown = null;
  let initialized = false;
  let result: any;
  let finished = false;
  let cursor = 0;
  let publicBytes = 0;
  let truncated = false;
  let submissionRepairs = 0;
  let sid = requestedSid;
  let recoveryMode = fresh ? 'fresh_evaluation' : previous.sessionId ? 'rebuilt_from_task_records' : 'new_session';
  let activeSession: import('./container-session.js').RunningContainerHarness<T> | null = null;
  const seen = new Map<string, ClaudeUsage | null>();
  const reportedAnomalies = new Set<string>();

  const noteAnomaly = (kind: string, detail: Record<string, unknown> = {}) => {
    const key = `${kind}:${String(detail.event_type ?? detail.block_type ?? '')}`;
    if (reportedAnomalies.has(key)) return;
    reportedAnomalies.add(key);
    emit({ type: 'configuration', stage: 'protocol_anomaly', anomaly: kind, ...detail });
  };

  const gatewayRequestCount = () =>
    Number(
      spec.store.get(
        "SELECT count(*) n FROM model_requests WHERE run_id=? AND accounting_source NOT IN ('provider_requests','codex_events')",
        ctx.run_id,
      )?.n ?? 0,
    );

  const reportProvisionalUsage = (messageId: string, final?: ClaudeUsage | null) => {
    const snapshot: ExternalUsage = {
      model_requests: seen.size,
      input_tokens: final
        ? final.input_tokens + (final.cache_read_input_tokens ?? 0) + (final.cache_creation_input_tokens ?? 0)
        : [...seen.values()].reduce(
            (n, u) => n + (u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0),
            0,
          ),
      output_tokens: final?.output_tokens ?? 0,
      unknown_requests: final ? 0 : seen.size,
      semantics: final ? 'exact' : 'lower_bound',
      cost: 'unknown',
      accounting_source: final ? 'cli_result' : 'cli_provisional',
    };
    // Only record external_model_usage when no gateway model_requests rows exist for this run (prevents double-counting).
    const gwCount = gatewayRequestCount();
    if (gwCount === 0) {
      spec.onExternalUsage?.(snapshot);
    } else if (final) {
      const gwOut = Number(
        spec.store.get(
          "SELECT coalesce(sum(output_tokens),0) n FROM model_requests WHERE run_id=? AND accounting_source NOT IN ('provider_requests','codex_events')",
          ctx.run_id,
        )?.n ?? 0,
      );
      emit({
        type: 'configuration',
        stage: 'usage_reconciliation',
        cli_result_usage: final,
        gateway_output_tokens: gwOut,
        matches: gwOut === final.output_tokens,
      });
    }
    emit({ type: 'configuration', stage: 'usage', messageId, usage: snapshot, raw_cursor: cursor });
  };

  let observedModel: string | null = prepared.model ?? null;
  const saveState = () => {
    if (!activeSession) return;
    spec.harnessState?.save({
      sessionId: sid,
      previousSessionId: previous.sessionId ?? null,
      stateWorkspaceId: activeSession.stateWorkspaceId,
      sessionKey,
      cwd: activeSession.started?.repo_dir ?? `/workspace/tasks/${activeSession.workspaceId}/repo`,
      scope: scope(ctx),
      inputHash,
      configurationHash: prepared.configurationHash,
      version: activeSession.cliVersion,
      ...(observedModel ? { model: observedModel } : {}),
      recoveryMode,
      run_id: ctx.run_id,
      lease_epoch: ctx.lease_epoch,
      raw_cursor: cursor,
    });
  };

  const interruptStream = (err: unknown) => {
    if (streamFailure) return;
    streamFailure = err;
    void activeSession?.interrupt('graceful', 500);
  };

  const stream = new ClaudeJsonStream((m, at) => {
    cursor = at;
    if (streamFailure) return;
    if (m.type === 'unknown_event') {
      noteAnomaly('unknown_event', { event_type: (m as any).event_type, raw_cursor: at });
      return;
    }
    if (m.type === 'ignored') return;
    if (result) return fail('claude_protocol_incompatible');
    if (m.session_id && m.session_id !== sid) return fail('claude_session_scope_mismatch');
    if (m.type === 'init') {
      const localConfig = prepared.modelSource === 'local_config';
      const reportedModel = typeof m.model === 'string' && m.model.trim() ? m.model.trim() : null;
      const modelOk = localConfig ? Boolean(reportedModel) : m.model === prepared.model;
      if (
        initialized ||
        !modelOk ||
        !Array.isArray(m.tools) ||
        m.tools.some((n: string) => !isAllowedClaudeTool(n, allowedMcpSet, egress)) ||
        !Array.isArray(m.mcp_servers) ||
        !m.mcp_servers.some((s: any) => s.name === 'bot' && s.status === 'connected') || m.mcp_servers.some((s:any)=>s.name!=='bot')
      ) {
        return fail('claude_capability_mismatch');
      }
      initialized = true;
      if (reportedModel) observedModel = reportedModel;
      saveState();
      emit({
        type: 'session_bound',
        sessionRef: sid,
        recoveryMode,
        version: activeSession?.cliVersion ?? prepared.version,
        configuredModel: prepared.model ?? reportedModel,
        ...(localConfig ? { modelSource: 'local_config', actualModel: reportedModel } : {}),
        ...(Array.isArray(m.skills) && m.skills.length ? { skills: m.skills } : {}),
        configurationHash: prepared.configurationHash,
        usage: !localConfig && prepared.modelTransport === 'gateway' ? 'gateway' : 'native_events',
      });
      return;
    }
    if (m.type === 'control_request') {
      emit({ type: 'permission', requestId: m.request_id, decision: 'deny' });
      void activeSession?.writeStdin(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'error', request_id: m.request_id, error: 'permission_denied' },
        }) + '\n',
      );
      return;
    }
    if (m.type === 'api_retry') {
      emit({ type: 'configuration', stage: 'api_retry', error: m.error, attempt: m.attempt, raw_cursor: at });
      if (m.error === 'authentication') return executionFailure(m.error);
      return;
    }
    if (!initialized) return fail('claude_protocol_incompatible');
    if (m.type === 'assistant') {
      if (m.error) return executionFailure(m.error);
      if (typeof m.id !== 'string') return fail('claude_protocol_incompatible');
      const before = seen.get(m.id);
      if (before && m.usage) {
        seen.set(
          m.id,
          Object.fromEntries(
            ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(k => [
              k,
              Math.max((before as any)[k] ?? 0, m.usage[k] ?? 0),
            ]),
          ) as unknown as ClaudeUsage,
        );
      } else {
        seen.set(m.id, m.usage ?? before ?? null);
      }
      reportProvisionalUsage(m.id);
    }
    for (const c of m.content ?? []) {
      if (c.type === 'unknown_block') {
        noteAnomaly('unknown_block', { block_type: (c as any).block_type, raw_cursor: at });
      } else if (c.type === 'text') {
        const text = spec.redactor.text(c.text);
        const room = Math.max(0, 32 * 1024 - publicBytes);
        const bounded = Buffer.from(text).subarray(0, room).toString('utf8');
        publicBytes += Buffer.byteLength(bounded);
        if (bounded) emit({ type: 'message', text: bounded, raw_cursor: at });
        if (Buffer.byteLength(text) > room && !truncated) {
          truncated = true;
          emit({ type: 'configuration', output_truncated: true, limit_bytes: 32 * 1024 });
        }
      } else if (c.type === 'tool_use') {
        if (!isAllowedClaudeTool(c.name, allowedMcpSet, egress)) {
          spec.onDenied?.(c.name, 'not_offered');
          if(c.name.startsWith('mcp__bot__')){emit({type:'tool',callId:c.id,name:c.name,phase:'denied',reason:'not_offered'});continue;}
          return fail('claude_tool_denied');
        }
        // Native activity is part of provenance too, not only Bot MCP calls.
        {
          emit({ type: 'tool', callId: c.id, name: c.name, phase: 'started', raw_cursor: at });
        }
      }
    }
    if (m.type === 'result') {
      reportProvisionalUsage('result', m.usage);
      if (!spec.onTurnEnd && !m.is_error && m.subtype === 'success' && !activeSession?.dispatcher.submitted && submissionRepairs < 2) {
        submissionRepairs++;
        result = undefined;
        void activeSession?.writeStdin(
          JSON.stringify(
            claudeUserMessage(
              `A text response is not a submission. Call mcp__bot__${spec.finish!.name} now with the required structured result using the evidence already gathered.`,
              sid,
            ),
          ) + '\n',
        );
      } else {
        result = m;
        void activeSession?.closeStdin();
      }
    }
    saveState();
  });

  try {
    return await withContainerHarnessSession(
      spec,
      {
        cli: 'claude_code',
        modelTransport: prepared.modelTransport,
        ...(prepared.modelSource ? { modelSource: prepared.modelSource } : {}),
        ...(prepared.config?.env?.CLAUDE_CONFIG_DIR ? {claudeHomeOverride:prepared.config.env.CLAUDE_CONFIG_DIR} : {}),
        ...(prepared.model ? { model: prepared.model } : {}),
        systemPrompt,
        maxTurns: spec.harnessAccess ? spec.harnessTurnLimit : spec.maxTurns,
        maxOutputTokens: spec.maxOutputTokens ?? 8192,
        sessionId: requestedSid,
        resume: Boolean(compatible),
        sessionKey,
        egress,
        ...(prepared.config?.stateDirectory ? { localWorkspaceRoot: prepared.config.stateDirectory } : {}),
        ...(prepared.config?.env ? { extraEnv: prepared.config.env } : {}),
        executableOverride: spec.containerOptions?.executableOverride
          ? {
              ...spec.containerOptions.executableOverride,
              version: spec.containerOptions.executableOverride.version ?? prepared.version,
            }
          : {
              executable: prepared.command,
              ...(prepared.nodeExecutable ? { nodeExecutable: prepared.nodeExecutable } : {}),
              version: prepared.version,
            },
        ...(prepared.primaryModel ? { primaryModel: prepared.primaryModel } : {}),
        ...(prepared.fileProvider ? { fileProvider: prepared.fileProvider } : {}),
      },
      signal,
      chunk => {
        try {
          stream.push(chunk);
        } catch (err) {
          interruptStream(err);
        }
      },
      async session => {
        activeSession = session;
        sid = typeof session.started?.session_id === 'string' && session.started.session_id ? session.started.session_id : requestedSid;
        recoveryMode = fresh
          ? 'fresh_evaluation'
          : session.started?.actual_resume
            ? 'native_resume'
            : previous.sessionId
              ? 'rebuilt_from_task_records'
              : 'new_session';

        if (prepared.config?.timeoutMs) {
          emit({ type: 'configuration', stage: 'legacy_timeout_ignored', configuredTimeoutMs: prepared.config.timeoutMs });
        }

        await session.writeStdin(
          JSON.stringify(
            claudeUserMessage(
              spec.prompt + '\nRecovery: ' + recoveryMode + '. Inspect task records and unknown side effects before repeating operations.',
              sid,
            ),
          ) + '\n',
        );

        const exit = await session.waitExit();
        if (streamFailure) throw streamFailure;
        try {
          stream.end();
        } catch (err) {
          throw err;
        }
        await spec.guard();
        if (signal.aborted) throw signal.reason;

        emit({
          type: 'configuration',
          stage: 'process_exit',
          exit_code: exit.exit_code,
          result_subtype: result?.subtype ?? null,
        });

        if (result?.subtype?.startsWith('error_max_')) return fail('claude_budget_exhausted', 'needs_replan');
        if (result && (result.is_error || result.subtype !== 'success')) return executionFailure(result.fault ?? 'execution');
        if (exit.exit_code !== 0) {
          const rawExitDetail = (
            exit.stderr_tail ||
            exit.error ||
            (exit.signal ? `signal:${exit.signal}` : `exit_code:${String(exit.exit_code)}`)
          ).trim();
          const exitDetail = rawExitDetail ? spec.redactor.text(rawExitDetail).slice(0, 500) : undefined;
          return fail('claude_process_exit', 'retry_wait', exitDetail);
        }
        if (!result) return fail('claude_result_missing', 'retry_wait');
        if (!session.dispatcher.submitted&&spec.onTurnEnd) return await spec.onTurnEnd({text:String(result?.result??''),session_id:sid});
        if (!session.dispatcher.submitted) return fail('claude_submission_required', 'retry_wait');
        finished = true;
        return session.dispatcher.result as T;
      },
    );
  } finally {
    if (!finished) emit({ type: 'configuration', ended_without_validated_result: true, raw_cursor: cursor });
  }
}
