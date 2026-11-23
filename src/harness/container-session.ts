import { acpProductExecutable, icodeProductId, workswarmProductId, type AcpProductManifest } from '../../runner/acp-products.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomId } from '../core/security.js';
import { stop, TaskError } from '../agent/common.js';
import type { AgentSpec } from '../agent/runtime.js';
import type { RuntimeModel } from '../agent/model.js';
import { ReadTokens } from '../agent/read-token.js';
import type { Workspace } from '../agent/workspace.js';
import { useWorkspace } from '../projects/workspace-cleanup.js';
import { createTaskToolDispatcher, handleMailboxToolRequest, type TaskToolDispatcher } from '../roles/task-tools.js';
import { recordConversationCliVersion, recordRunCliVersion } from '../roles/role-run.js';
import { githubReadScopes, githubResources } from '../roles/permissions.js';
import { roleConfiguration } from '../roles/definition.js';
import { taskPermissions } from '../tasks/configuration.js';
import { taskReadScopes } from '../tasks/management.js';
import { COMPATIBLE_CLI_RANGES, DEFAULT_AGENT_TOOLS_ROOT, selectCompatibleCliVersion, type AgentToolCli } from './agent-tools.js';
import type { HarnessModelSource } from './subscription.js';
import { createMailboxModelGateway, type FileBackedModelProvider, type PolledModelRequestEntry } from './model-gateway.js';
import { modelTransport, nativeModelConnection, type ModelTransport } from './model-connection.js';

/**
 * Low-level repository/command/sub-agent tools replaced by the container CLI's native tools and credential helpers.
 * Structured GitHub read tools (`github_read`, `github_search`, `read_job_log`) and versioned snapshot tools
 * (`read_version_file`, `compare_versions`) remain offered so partial GitHub policies and fixed-ref reads keep working.
 */
export const NATIVE_CLI_REPLACED_TOOLS = new Set([
  'read_file',
  'write_file',
  'run_command',
  'github_read_token',
  'start_agent',
]);

export function filterPlatformTools<T>(spec: AgentSpec<T>): any[] {
  const raw = spec.tools ?? [];
  if (spec.containerOptions?.keepRawTools) return raw;
  const finishNames = new Set(spec.finish ? (spec.finish.names ?? [spec.finish.name]) : []);
  return raw.filter(tool => {
    const name = tool?.function?.name;
    if (typeof name !== 'string' || !name) return false;
    if (finishNames.has(name)) return true;
    return !NATIVE_CLI_REPLACED_TOOLS.has(name);
  });
}

export const persistentCliStateWorkspaceId = (instanceId: string): string =>
  createHash('sha256').update('cli-state:' + instanceId).digest('hex').slice(0, 48);

export interface ContainerHarnessLaunch {
  modelTransport?: ModelTransport;
  modelSource?: HarnessModelSource;
  modelProvider?: string;
  claudeHomeOverride?: string;
  cli: AgentToolCli | 'container_acp';
  acpProduct?: AcpProductManifest;
  backendId?: string;
  acpLocalLeaseMs?: number;
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  maxOutputTokens?: number;
  sessionId?: string | null;
  resume?: boolean;
  sessionKey?: string;
  stateWorkspaceIdOverride?: string;
  localWorkspaceRoot?: string;
  codexHomeOverride?: string;
  egress?: boolean;
  githubHost?: string;
  allowHttpGit?: boolean;
  extraEnv?: Record<string, string>;
  executableOverride?: {
    executable: string;
    args?: string[];
    nodeExecutable?: string;
    version?: string;
  };
  fileProvider?: FileBackedModelProvider;
  primaryModel?: RuntimeModel;
  gatewayTiming?: { firstByteMs: number; idleMs: number; keepaliveMs?: number };
  pollWaitMs?: number;
  manualCancel?: (reason: unknown) => void;
  onExit?: (exit: ContainerHarnessExit) => void;
}

export interface ContainerHarnessExit {
  state: string;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  stderr_tail: string;
}

export interface RunningContainerHarness<T> {
  readonly started: Record<string, any>;
  readonly workspaceId: string;
  readonly stateWorkspaceId: string;
  readonly cliVersion: string;
  readonly platformTools: any[];
  readonly dispatcher: TaskToolDispatcher<T>;
  writeStdin(chunk: string | Buffer, closeAfter?: boolean): Promise<void>;
  closeStdin(): Promise<void>;
  interrupt(mode?: 'graceful' | 'kill', graceMs?: number): Promise<void>;
  waitExit(): Promise<ContainerHarnessExit>;
}

interface RunnerTransport {
  kind: 'workspace' | 'local';
  workspaceId: string;
  stateWorkspaceId: string;
  egress: boolean;
  deliver: (request: Record<string, unknown>) => Promise<any>;
  deliverCleanup: (request: Record<string, unknown>) => Promise<any>;
  reap: (instanceId: string, superseded: boolean) => Promise<void>;
}

function createDirectLocalRunner(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(root + '/tasks', { recursive: true, mode: 0o700 });
  mkdirSync(root + '/project-notes', { recursive: true, mode: 0o700 });
  const runnerScript = resolve(import.meta.dirname, '../../runner/runner.mjs');
  return (input: Record<string, unknown>, timeoutMs = 90_000): Promise<any> =>
    new Promise((resolveResult, reject) => {
      const payload = { operation_id: randomId(), ...input };
      const child = spawn(process.execPath, [runnerScript, Buffer.from(JSON.stringify(payload)).toString('base64url')], {
        env: {
          PATH: dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          BOT_LOCAL_EXECUTION: 'true',
          BOT_LOCAL_WORKSPACE: root,
          ...(process.env.BOT_AGENT_TOOLS_DIR ? { BOT_AGENT_TOOLS_DIR: process.env.BOT_AGENT_TOOLS_DIR } : {}),
          ...(process.env.BOT_REAL_GH_BIN ? { BOT_REAL_GH_BIN: process.env.BOT_REAL_GH_BIN } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      const timer = timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('local_runner_timeout')); }, timeoutMs) : undefined;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { out += chunk; if (out.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.on('data', chunk => { err = (err + chunk).slice(-1000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          resolveResult({ error: 'local_runner_failed', detail: err || String(code) });
          return;
        }
        try {
          const parsed = JSON.parse(out);
          resolveResult(parsed?.ok ? parsed.result : { error: parsed?.error || 'runner_operation_failed', ...(parsed?.detail ? { detail: parsed.detail } : {}) });
        } catch {
          resolveResult({ error: 'local_runner_invalid_response' });
        }
      });
    });
}

function resolveRunnerTransport<T>(spec: AgentSpec<T>, launch: ContainerHarnessLaunch): RunnerTransport {
  const space: Workspace | undefined = spec.roleWorkspace ?? spec.pi?.workspace;
  if (space && typeof space.task?.workspace_id === 'string' && /^[a-f0-9]{48}$/.test(space.task.workspace_id)) {
    const workspaceId = String(space.task.workspace_id);
    const stateWorkspaceId = launch.stateWorkspaceIdOverride && /^[a-f0-9]{48}$/.test(launch.stateWorkspaceIdOverride)
      ? launch.stateWorkspaceIdOverride
      : spec.roleRun?.instance_id
        ? persistentCliStateWorkspaceId(spec.roleRun.instance_id)
        : workspaceId;
    if (stateWorkspaceId !== workspaceId) {
      useWorkspace(spec.store, { ...space.task, workspace_id: stateWorkspaceId }, 'workspace_harness_start');
    }
    return {
      kind: 'workspace',
      workspaceId,
      stateWorkspaceId,
      egress: launch.egress ?? spec.containerOptions?.egress ?? false,
      deliver: request => space.deliver(request),
      deliverCleanup: request => space.deliverCleanup(request, 15_000),
      reap: async (instanceId, superseded) => {
        if (superseded) return;
        const intRes = await space.deliverCleanup({ type: 'workspace_harness_interrupt', mode: 'kill', instance_id: instanceId }, 15_000).catch(() => null);
        if (intRes?.stale_instance) return;
        await space.deliverCleanup({ type: 'reap' }, 15_000).catch(() => {});
      },
    };
  }

  if (launch.localWorkspaceRoot) {
    const execLocal = createDirectLocalRunner(launch.localWorkspaceRoot);
    const seed = spec.roleRun?.instance_id
      ? `${spec.task?.id ?? 'task'}:${spec.roleRun.instance_id}`
      : `${spec.task?.id ?? 'task'}:${randomId()}`;
    const workspaceId = /^[a-f0-9]{48}$/.test(String(spec.task?.workspace_id ?? ''))
      ? String(spec.task.workspace_id)
      : createHash('sha256').update('local-ws:' + seed).digest('hex').slice(0, 48);
    const stateWorkspaceId = launch.stateWorkspaceIdOverride && /^[a-f0-9]{48}$/.test(launch.stateWorkspaceIdOverride)
      ? launch.stateWorkspaceIdOverride
      : spec.roleRun?.instance_id
        ? persistentCliStateWorkspaceId(spec.roleRun.instance_id)
        : workspaceId;
    mkdirSync(join(launch.localWorkspaceRoot, 'tasks', workspaceId, 'repo'), { recursive: true, mode: 0o700 });
    return {
      kind: 'local',
      workspaceId,
      stateWorkspaceId,
      egress: launch.egress ?? spec.containerOptions?.egress ?? false,
      deliver: request => execLocal({ ...request, workspace_id: workspaceId }),
      deliverCleanup: request => execLocal({ ...request, workspace_id: workspaceId }, 15_000),
      reap: async (instanceId, superseded) => {
        if (superseded) return;
        const intRes = await execLocal({ type: 'workspace_harness_interrupt', mode: 'kill', instance_id: instanceId, workspace_id: workspaceId }, 15_000).catch(() => null);
        if (intRes?.stale_instance) return;
        await execLocal({ type: 'reap', workspace_id: workspaceId }, 15_000).catch(() => {});
      },
    };
  }

  return stop('container_workspace_required', 'waiting_environment', 'Claude Code 与 Codex 必须在项目容器或隔离运行容器中执行，当前运行未提供容器工作区。');
}

export function computeAllowedGithubScopes<T>(spec: AgentSpec<T>): { initial: string[]; live: () => string[] } {
  const repoId = String(spec.task?.repository_id ?? '');
  const roleId = spec.roleRun?.role;
  const computeLive = (): string[] => {
    let scopes: string[] = [...githubResources];
    if (roleId) {
      const config = roleConfiguration(spec.store, repoId);
      const roleDef = config.roles.find(r => r.role_id === roleId);
      if (!roleDef || !roleDef.enabled) return [];
      scopes = githubReadScopes(roleDef.permissions);
    }
    if (spec.task?.id && spec.task.kind !== 'role.conversation' && spec.store.get('SELECT 1 FROM tasks WHERE id=?', spec.task.id)) {
      const tp = taskPermissions(spec.store, spec.task).github;
      scopes = scopes.filter(s => tp.includes(s));
      const trs = taskReadScopes(spec.store, spec.task);
      scopes = scopes.filter(s => trs.includes(s));
    }
    if(spec.harnessAccess)scopes=scopes.filter(scope=>spec.harnessAccess!.github.scopes.includes(scope));
    return scopes;
  };
  return { initial: computeLive(), live: computeLive };
}

function githubHostFromApiUrl(apiUrl?: string): string {
  if (!apiUrl) return 'github.com';
  try {
    const parsed = new URL(apiUrl);
    if (parsed.hostname === 'api.github.com') return 'github.com';
    return parsed.host;
  } catch {
    return 'github.com';
  }
}

export async function withContainerHarnessSession<T, R>(
  spec: AgentSpec<T>,
  launch: ContainerHarnessLaunch,
  signal: AbortSignal,
  onStdoutChunk: (chunk: Buffer, rawCursor: number) => void,
  drive: (session: RunningContainerHarness<T>) => Promise<R>,
): Promise<R> {
  const runAccess = spec.runAccess;
  if (!runAccess?.token) {
    return stop('run_token_invalid', 'failed', '容器内 Agent 运行缺少控制面签发的运行级身份令牌。');
  }
  const runToken = runAccess.token;
  spec.redactor.add(runToken);

  let executable: string;
  let executableArgs: string[] = [];
  let nodeExecutable: string | undefined;
  let cliVersion: string;

  if (launch.executableOverride) {
    executable = launch.executableOverride.executable;
    executableArgs = launch.executableOverride.args ?? [];
    nodeExecutable = launch.executableOverride.nodeExecutable;
    cliVersion = launch.executableOverride.version ?? (launch.cli === 'container_acp' ? '1' : COMPATIBLE_CLI_RANGES[launch.cli].tested);
  } else if (launch.cli === 'container_acp') {
    if (!launch.acpProduct) return stop('acp_product_not_installed', 'waiting_configuration');
    const { id, version } = launch.acpProduct;
    executable = `${DEFAULT_AGENT_TOOLS_ROOT}/acp/${id}/${version}/${acpProductExecutable(id)}`;
    cliVersion = version;
  } else {
    const selected = selectCompatibleCliVersion(process.env.BOT_AGENT_TOOLS_DIR ?? DEFAULT_AGENT_TOOLS_ROOT, launch.cli);
    executable = selected.container_executable;
    nodeExecutable = selected.container_node_executable ?? undefined;
    cliVersion = selected.version;
  }

  const transport = resolveRunnerTransport(spec, launch);
  const platformTools = filterPlatformTools(spec);
  const dispatcher = createTaskToolDispatcher({ ...spec, tools: platformTools });

  const boundRunId = spec.runContext?.()?.run_id ?? spec.task?.trace_run_id;
  if (boundRunId && spec.store.get('SELECT 1 FROM task_runs WHERE id=?', boundRunId)) {
    recordRunCliVersion(spec.store, String(boundRunId), cliVersion);
  } else if (spec.task?.id && spec.store.hasTable('role_conversation_turns') && spec.store.get('SELECT 1 FROM role_conversation_turns WHERE id=?', spec.task.id)) {
    recordConversationCliVersion(spec.store, String(spec.task.id), launch.backendId ?? launch.cli, cliVersion);
  }
  const runRow = boundRunId
    ? spec.store.get('SELECT lease_epoch FROM task_runs WHERE id=?', boundRunId)
    : null;
  const leaseEpoch = Number(runRow?.lease_epoch ?? spec.runContext?.()?.lease_epoch ?? 0);
  const runId = String(boundRunId ?? randomId());

  const acp = launch.cli === 'container_acp';
  const icode = acp && launch.acpProduct?.id === icodeProductId;
  const workswarm = acp && launch.acpProduct?.id === workswarmProductId;
  const localConfig = !acp && (launch.modelSource ?? spec.containerOptions?.modelSource) === 'local_config';
  const connectionMode = localConfig ? 'local_config' : acp ? 'gateway' : modelTransport(launch.modelTransport ?? spec.containerOptions?.modelTransport);
  const supported = launch.cli === 'codex' ? 'openai-responses' : 'anthropic-messages';
  const nativeModel = connectionMode === 'direct' ? nativeModelConnection(launch.primaryModel, launch.fileProvider ?? spec.containerOptions?.fileProvider,supported) : undefined;
  if (nativeModel) {
    spec.redactor.add(nativeModel.key);
    if (nativeModel.interfaceType !== supported) stop('harness_direct_protocol_unsupported', 'waiting_configuration', `${launch.cli} needs ${supported} for this provider. Configure a native-compatible provider or explicitly select modelTransport: gateway; no automatic protocol proxy is used.`);
  }
  const modelGateway = connectionMode === 'gateway' ? createMailboxModelGateway({
    store: spec.store,
    task: spec.task,
    runId,
    leaseEpoch,
    runAccess,
    redactor: spec.redactor,
    runner: input => transport.deliver(input),
    workspaceId: transport.workspaceId,
    primaryModel: launch.primaryModel,
    fileProvider: launch.fileProvider ?? spec.containerOptions?.fileProvider,
    allowVisibleModels: !icode && !workswarm,
    guard: spec.guard,
    beforeModel: spec.beforeModel,
    maxOutputTokens: launch.maxOutputTokens ?? spec.maxOutputTokens,
    signal,
    ...(launch.gatewayTiming ? { timing: launch.gatewayTiming } : {}),
  }) : undefined;

  const repoRow = spec.task?.repository_id
    ? spec.store.get('SELECT * FROM repositories WHERE id=?', spec.task.repository_id)
    : undefined;
  const scopeInfo = computeAllowedGithubScopes(spec);
  const githubApiUrl = spec.containerOptions?.githubApiUrl;
  const readTokens = repoRow && scopeInfo.initial.length
    ? new ReadTokens(spec.store, repoRow, spec.redactor, spec.guard, githubApiUrl, scopeInfo.initial, scopeInfo.live, 64)
    : null;

  const mcpTools = platformTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));

  const instanceId = randomId();
  const harnessConfig = {
    instance_id: instanceId,
    harness: launch.cli,
    ...(acp ? { acp_product: launch.acpProduct, acp_local_lease_ms: launch.acpLocalLeaseMs } : {}),
    ...(icode || workswarm ? { acp_model: {
      interface_type: launch.primaryModel?.protocol?.interface_type ?? 'openai-chat-completions',
      context_window: launch.primaryModel?.capabilities?.context_window ?? 128000,
      max_output_tokens: Math.min(spec.maxOutputTokens ?? 8192, launch.primaryModel?.capabilities?.max_output_tokens ?? 8192),
      image_input: launch.primaryModel?.capabilities?.image_input ?? false,
    } } : {}),
    model_transport: connectionMode,
    ...(localConfig ? { model_source: 'local_config' } : {}),
    ...(nativeModel ? { native_model: nativeModel } : {}),
    ...(!localConfig && launch.modelProvider ? { model_provider: launch.modelProvider } : {}),
    ...(launch.claudeHomeOverride ? { claude_home_override: launch.claudeHomeOverride } : {}),
    executable,
    ...(executableArgs.length ? { executable_args: executableArgs } : {}),
    ...(nodeExecutable ? { node_executable: nodeExecutable } : {}),
    run_token: runToken,
    ...(!localConfig && launch.model ? { model: launch.model } : {}),
    system_prompt: launch.systemPrompt ?? '',
    max_turns: spec.harnessAccess ? spec.harnessTurnLimit : launch.maxTurns ?? spec.maxTurns,
    execution_access: spec.harnessAccess,
    resources:spec.harnessResources,
    max_output_tokens: launch.maxOutputTokens ?? spec.maxOutputTokens ?? 8192,
    session_id: launch.sessionId ?? null,
    resume: Boolean(launch.resume),
    session_key: launch.sessionKey ?? spec.harnessSessionKey ?? 'default',
    state_workspace_id: transport.stateWorkspaceId,
    ...(launch.codexHomeOverride ? { codex_home_override: launch.codexHomeOverride } : {}),
    egress: transport.egress,
    github_host: launch.githubHost ?? githubHostFromApiUrl(githubApiUrl),
    allow_http_git: Boolean(launch.allowHttpGit ?? spec.containerOptions?.allowHttpGit),
    ...(launch.extraEnv || spec.containerOptions?.extraEnv
      ? { extra_env: { ...(spec.containerOptions?.extraEnv ?? {}), ...(launch.extraEnv ?? {}) } }
      : {}),
    mcp_tools: mcpTools,
  };

  const configBytes = Buffer.from(JSON.stringify(harnessConfig), 'utf8');
  if (configBytes.length > 2 * 1024 * 1024) {
    stop('agent_context_too_large', 'waiting_configuration', `容器 Harness 启动配置大小 ${configBytes.length} 字节，超过 2 MiB 上限。`);
  }
  for (let offset = 0; offset < configBytes.length || offset === 0; offset += 30_000) {
    const saved = await transport.deliver({
      type: 'workspace_harness_config',
      base64: configBytes.subarray(offset, offset + 30_000).toString('base64'),
      offset,
      final: offset + 30_000 >= configBytes.length,
    });
    if (saved?.error) {
      stop('execution_interrupted', 'waiting_environment', `写入容器 Harness 配置失败（${saved.detail || saved.error}）。`);
    }
    if (configBytes.length === 0) break;
  }

  let started: any;
  try {
    started = await transport.deliver({ type: 'workspace_harness_start', instance_id: instanceId });
    if (!started?.started) {
      if (started?.error === 'claude_local_config_missing' || started?.error === 'codex_local_config_missing') {
        const detail = started.error === 'claude_local_config_missing'
          ? '项目电脑中缺少 /workspace/home/.claude/settings.json 或 /workspace/home/.claude/.credentials.json，不会回退到平台模型。'
          : '项目电脑中缺少 /workspace/home/.codex/config.toml 或 /workspace/home/.codex/auth.json，不会回退到平台模型。';
        stop(started.error, 'waiting_configuration', detail);
      }
      const reason = started?.detail || started?.error || (started?.state ? `state:${String(started.state)}` : 'startup_failed');
      stop('execution_interrupted', 'waiting_environment', `启动容器内 ${launch.cli} 失败：${spec.redactor.text(String(reason))}。`);
    }
  } catch (error) {
    await Promise.allSettled([transport.reap(instanceId, false), modelGateway?.close(), dispatcher.close(), readTokens?.revoke()]);
    throw error;
  }
  const startedPid = typeof started?.pid === 'number' ? started.pid : null;
  const pollWaitMs = Number.isSafeInteger(launch.pollWaitMs) && (launch.pollWaitMs as number) >= 0
    ? Math.min(launch.pollWaitMs as number, 1000)
    : 150;

  let stdoutOffset = 0;
  let exitInfo: ContainerHarnessExit | null = null;
  let resolveExit!: (info: ContainerHarnessExit) => void;
  let rejectExit!: (error: unknown) => void;
  const exitPromise = new Promise<ContainerHarnessExit>((ok, no) => {
    resolveExit = ok;
    rejectExit = no;
  });
  exitPromise.catch(() => {});

  const answered = new Set<string>();
  const failed = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  let backgroundError: unknown = null;
  let stopPolling = false;
  let superseded = false;
  let cancelSignaled = false;
  let wakePoll: (() => void) | null = null;
  let wakePending = false;

  const notifyWake = () => {
    if (wakePoll) {
      const fn = wakePoll;
      wakePoll = null;
      fn();
    } else {
      wakePending = true;
    }
  };

  const waitNextPoll = (ms: number) => {
    if (wakePending || stopPolling) {
      wakePending = false;
      return Promise.resolve();
    }
    return new Promise<void>(resolveWait => {
      const timer = setTimeout(() => {
        if (wakePoll === done) wakePoll = null;
        resolveWait();
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolveWait();
      };
      wakePoll = done;
    });
  };

  const startBackground = (idKey: string, work: () => Promise<void>) => {
    if (answered.has(idKey) || failed.has(idKey) || inFlight.has(idKey) || backgroundError !== null) return;
    if (answered.size > 4096) {
      const oldest = answered.values().next().value;
      if (oldest) answered.delete(oldest);
    }
    const job = work()
      .then(() => { answered.add(idKey); }, err => { failed.add(idKey); backgroundError ??= err; })
      .finally(() => { inFlight.delete(idKey); notifyWake(); });
    inFlight.set(idKey, job);
  };

  const collectKnownIds = (prefix: 'tool:' | 'token:', limit = 512): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (key: string) => {
      if (!key.startsWith(prefix)) return;
      const raw = key.slice(prefix.length);
      if (/^[a-f0-9]{48}$/.test(raw) && !seen.has(raw)) {
        seen.add(raw);
        ids.push(raw);
      }
    };
    for (const k of inFlight.keys()) { add(k); if (ids.length >= limit) return ids; }
    for (const k of failed) { add(k); if (ids.length >= limit) return ids; }
    const recent = [...answered];
    for (let i = recent.length - 1; i >= 0 && ids.length < limit; i--) add(recent[i]!);
    return ids;
  };

  const handleTokenRequest = async (tokenRequest: any) => {
    const id = String(tokenRequest?.id ?? '');
    if (!/^[a-f0-9]{48}$/.test(id)) stop('model_request_invalid');
    const purpose = tokenRequest?.purpose === 'gh' ? 'gh' : 'git';
    let reply: Record<string, unknown>;
    try {
      spec.runAccess!.check(tokenRequest?.token, 'github:read_token');
      await spec.guard();
      const liveScopes = scopeInfo.live();
      if (!readTokens || !liveScopes.length) {
        spec.onDenied?.('github_read_token', 'github_read_token_not_allowed');
        reply = { error: 'github_read_token_not_allowed' };
      } else if (purpose === 'git') {
        if (!liveScopes.includes('contents')) {
          spec.onDenied?.('github_read_token', 'github_read_token_not_allowed');
          reply = { error: 'github_read_token_not_allowed' };
        } else {
          reply = await readTokens.issueContents();
        }
      } else {
        reply = await readTokens.issue();
      }
    } catch (error) {
      const code = String((error as any)?.code ?? 'github_read_token_unavailable');
      if (tokenRequest?.token !== runToken && /^(?:run_token_|lease_epoch_stale$)/.test(code)) {
        spec.onDenied?.('github_read_token', code);
        reply = { error: code };
      } else if (code === 'run_token_capability_denied') {
        spec.onDenied?.('github_read_token', code);
        reply = { error: 'github_read_token_not_allowed' };
      } else if (/^(?:run_token_|lease_epoch_stale$)/.test(code)) {
        await transport.deliver({
          type: 'workspace_agent_token',
          request_id: id,
          base64: Buffer.from(JSON.stringify({ error: code })).toString('base64'),
        }).catch(() => {});
        throw error;
      } else if (error instanceof TaskError && ['github_app_required', 'github_read_token_not_allowed', 'github_read_token_limit', 'github_read_token_not_read_only'].includes(error.code)) {
        reply = { error: error.code };
      } else {
        await spec.guard();
        reply = { error: error instanceof TaskError ? error.code : 'github_read_token_unavailable' };
      }
    }
    await transport.deliver({
      type: 'workspace_agent_token',
      request_id: id,
      base64: Buffer.from(JSON.stringify(reply)).toString('base64'),
    });
  };

  const drainStdoutFromPoll = (polled: any) => {
    if (typeof polled.stdout_base64 === 'string' && polled.stdout_base64.length > 0) {
      const bytes = Buffer.from(polled.stdout_base64, 'base64');
      stdoutOffset = Number.isSafeInteger(polled.next_offset) ? polled.next_offset : stdoutOffset + bytes.length;
      onStdoutChunk(bytes, stdoutOffset);
    } else if (Number.isSafeInteger(polled.next_offset)) {
      stdoutOffset = polled.next_offset;
    }
  };

  const pollLoop = (async () => {
    let idlePolls = 0;
    let lastHeartbeat = 0;
    try {
      while (!stopPolling) {
        if (backgroundError !== null) throw backgroundError;
        wakePending = false;

        let renew = false;
        if (acp && !signal.aborted && !cancelSignaled && Date.now() - lastHeartbeat >= 1000) {
          try {
            runAccess.check(runToken);
            renew = true;
            lastHeartbeat = Date.now();
          } catch (error) {
            cancelSignaled = true;
            dispatcher.halt();
            launch.manualCancel?.(error);
            if (!launch.manualCancel) throw error;
          }
        }
        const polled = await transport.deliver({
          type: 'workspace_harness_poll',
          offset: stdoutOffset,
          instance_id: instanceId,
          wait_ms: pollWaitMs,
          known_tool_ids: collectKnownIds('tool:'),
          known_token_ids: collectKnownIds('token:'),
          known_model_ids: modelGateway?.knownIds() ?? [],
          ...(renew ? { lease_heartbeat: true } : {}),
        });
        if (polled?.error === 'disk_full') {
          stop('disk_full', 'waiting_environment', '项目容器工作卷空间不足，容器内 Agent 已停止。');
        }
        const leaseExpired = acp && polled?.state === 'interrupted' && polled.error === 'acp_lease_expired';
        if (polled?.error && !leaseExpired) {
          stop('execution_interrupted', 'waiting_environment', `轮询容器内 ${launch.cli} 失败：${spec.redactor.text(String(polled.detail || polled.error))}。`);
        }
        if (
          polled?.state === 'superseded' ||
          (typeof polled?.instance_id === 'string' && polled.instance_id && polled.instance_id !== instanceId) ||
          (startedPid !== null && typeof polled?.pid === 'number' && polled.pid !== startedPid)
        ) {
          superseded = true;
          stop('execution_interrupted', 'waiting_environment', `容器内 ${launch.cli} 会话已被新运行接管或进程身份不匹配。`);
        }

        if (leaseExpired && !cancelSignaled) {
          cancelSignaled = true;
          dispatcher.halt();
          await modelGateway?.close();
        }

        const prevOffset = stdoutOffset;
        drainStdoutFromPoll(polled);
        const hadStdout = stdoutOffset > prevOffset;

        if (backgroundError !== null) throw backgroundError;

        if (launch.manualCancel) {
          if (!cancelSignaled) {
            if (signal.aborted) {
              cancelSignaled = true;
              dispatcher.halt();
              launch.manualCancel(signal.reason ?? new TaskError('harness_cancelled', 'cancelled'));
            } else {
              try {
                await spec.guard();
              } catch (guardErr) {
                cancelSignaled = true;
                dispatcher.halt();
                launch.manualCancel(guardErr);
              }
            }
          }
        } else {
          await spec.guard();
          if (signal.aborted) throw signal.reason ?? new TaskError('harness_cancelled', 'cancelled');
        }

        let hadNewRequests = false;
        if (!cancelSignaled) {
          for (const tokenReq of polled.token_requests ?? []) {
            if (tokenReq?.stub) continue;
            const id = String(tokenReq?.id ?? '');
            if (id) {
              hadNewRequests = true;
              startBackground('token:' + id, () => handleTokenRequest(tokenReq));
            }
          }
        }

        for (const toolReq of polled.tool_requests ?? []) {
          if (toolReq?.stub) continue;
          const id = String(toolReq?.id ?? '');
          if (!id) continue;
          hadNewRequests = true;
          if (toolReq?.oversized) {
            startBackground('tool:' + id, async () => {
              await transport.deliver({
                type: 'workspace_agent_tool',
                request_id: id,
                offset: 0,
                final: true,
                base64: Buffer.from(JSON.stringify({ error: 'tool_request_too_large' })).toString('base64'),
              });
            });
            continue;
          }
          startBackground('tool:' + id, async () => {
            await handleMailboxToolRequest(dispatcher, spec.redactor, toolReq, chunk => transport.deliver(chunk));
          });
        }

        const modelEntries = polled.model_requests as PolledModelRequestEntry[] | undefined;
        if (!cancelSignaled) {
          if (Array.isArray(modelEntries) && modelEntries.some(e => !e?.stub)) hadNewRequests = true;
          modelGateway?.dispatchPoll(modelEntries);
        }

        if (polled.has_more) {
          idlePolls = 0;
          continue;
        }

        if (['completed', 'failed', 'interrupted', 'missing'].includes(String(polled.state ?? ''))) {
          if (inFlight.size) await Promise.allSettled([...inFlight.values()]);
          await modelGateway?.drain();
          if (backgroundError !== null) throw backgroundError;
          // Drain any final stdout bytes emitted right before exit.
          if (Number.isSafeInteger(polled.stdout_size) && polled.stdout_size > stdoutOffset) continue;
          exitInfo = {
            state: String(polled.state),
            exit_code: typeof polled.exit_code === 'number' ? polled.exit_code : null,
            signal: typeof polled.signal === 'string' ? polled.signal : null,
            error: typeof polled.error === 'string' ? polled.error : null,
            stderr_tail: typeof polled.stderr_tail === 'string' ? spec.redactor.text(polled.stderr_tail) : '',
          };
          launch.onExit?.(exitInfo);
          resolveExit(exitInfo);
          return;
        }

        if (hadStdout || hadNewRequests) {
          idlePolls = 0;
          await waitNextPoll(15);
        } else {
          idlePolls++;
          await waitNextPoll(Math.min(300, 25 * (2 ** Math.min(idlePolls - 1, 4))));
        }
      }
    } catch (err) {
      rejectExit(err);
    }
  })();

  let stdinQueue: Promise<void> = Promise.resolve();
  const enqueueStdin = (work: () => Promise<void>) => {
    const next = stdinQueue.then(work, work);
    stdinQueue = next.catch(() => {});
    return next;
  };

  const writeStdin = (chunk: string | Buffer, closeAfter = false) =>
    enqueueStdin(async () => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (bytes.length === 0 && !closeAfter) return;
      for (let at = 0; at < bytes.length || at === 0; at += 36_000) {
        const slice = bytes.subarray(at, at + 36_000);
        const isLast = at + 36_000 >= bytes.length;
        const res = await transport.deliver({
          type: 'workspace_harness_stdin',
          instance_id: instanceId,
          ...(slice.length ? { base64: slice.toString('base64') } : {}),
          ...(closeAfter && isLast ? { final: true } : {}),
        });
        if (res?.stale_instance) {
          superseded = true;
          throw new TaskError('execution_interrupted', 'waiting_environment', 'harness_instance_superseded');
        }
        if (res?.error) throw new TaskError('execution_interrupted', 'waiting_environment', String(res.detail || res.error));
        if (bytes.length === 0) break;
      }
      notifyWake();
    });

  const closeStdin = () =>
    enqueueStdin(async () => {
      const send = signal.aborted || cancelSignaled || stopPolling ? transport.deliverCleanup : transport.deliver;
      await send({ type: 'workspace_harness_stdin', instance_id: instanceId, final: true }).catch(() => {});
      notifyWake();
    });

  const interrupt = async (mode: 'graceful' | 'kill' = 'graceful', graceMs?: number) => {
    const res = await transport.deliverCleanup({
      type: 'workspace_harness_interrupt',
      mode,
      instance_id: instanceId,
      ...(graceMs ? { grace_ms: graceMs } : {}),
    }).catch(() => null);
    if (res?.stale_instance) superseded = true;
    notifyWake();
  };

  const onAbort = () => {
    dispatcher.halt();
    if (launch.manualCancel) {
      if (!cancelSignaled) {
        cancelSignaled = true;
        launch.manualCancel(signal.reason ?? new TaskError('harness_cancelled', 'cancelled'));
      }
    } else {
      void interrupt('graceful', 1500);
    }
    notifyWake();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const handle: RunningContainerHarness<T> = {
    started,
    workspaceId: transport.workspaceId,
    stateWorkspaceId: transport.stateWorkspaceId,
    cliVersion,
    platformTools,
    dispatcher,
    writeStdin,
    closeStdin,
    interrupt,
    waitExit: () => exitPromise,
  };

  try {
    return await drive(handle);
  } finally {
    stopPolling = true;
    signal.removeEventListener('abort', onAbort);
    dispatcher.halt();
    notifyWake();
    await Promise.allSettled([
      pollLoop,
      modelGateway?.close(),
      dispatcher.close(),
      readTokens?.revoke(),
      transport.reap(instanceId, superseded),
    ]);
  }
}
