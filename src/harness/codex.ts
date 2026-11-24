import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { TaskError, stop } from '../agent/common.js';
import type { AgentServices, AgentSpec } from '../agent/runtime.js';
import type { RuntimeModel } from '../agent/model.js';
import { executionModel } from '../tasks/configuration.js';
import { traceEvent } from '../tasks/trace.js';
import { contentHash } from '../roles/protocol.js';
import { toolReceipts } from '../roles/role-run.js';
import type { HarnessEvent } from './session.js';
import { appServerDialect, type CodexDialect } from './app-server.js';
import { COMPATIBLE_CLI_RANGES, DEFAULT_AGENT_TOOLS_ROOT, satisfiesCliRange, selectCompatibleCliVersion } from './agent-tools.js';
import type { ModelAuthHeader, ModelInterfaceType } from '../models/catalog.js';
import type { FileBackedModelProvider } from './model-gateway.js';
import { filterPlatformTools, withContainerHarnessSession, type RunningContainerHarness } from './container-session.js';
import { modelTransport, type ModelTransport } from './model-connection.js';
import type { HarnessModelSource } from './subscription.js';

export interface CodexProviderConfig {
  baseUrl: string;
  credentialFile: string;
  interfaceType?: ModelInterfaceType;
  authHeader?: ModelAuthHeader;
}

export interface CodexConfiguration {
  modelTransport?: ModelTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  stateDirectory: string;
  version: string;
  protocol: 'codex-app-server';
  model?: string;
  modelProvider?: string;
  sandbox?: 'workspace-write' | 'danger-full-access' | 'read-only';
  timeoutMs?: number;
  toolStartupMs?: number;
  cancelGraceMs?: number;
  provider?: CodexProviderConfig;
}

export interface CodexPreparation {
  modelTransport: ModelTransport;
  modelSource?: HarnessModelSource;
  mode: 'volume' | 'config_file';
  config?: CodexConfiguration;
  command: string;
  executableArgs: string[];
  version: string;
  model?: string;
  modelProvider?: string;
  primaryModel?: RuntimeModel;
  fileProvider?: FileBackedModelProvider;
  configurationHash: string;
}

const optionalString = (v: unknown) => v === undefined || (typeof v === 'string' && v.length > 0 && v.length <= 200);
const optionalMs = (v: unknown, min: number) => v === undefined || (Number.isSafeInteger(v) && (v as number) >= min);

function resolveExecutableOnPath(command: string): string {
  if (isAbsolute(command)) return command;
  if (command.includes('/')) return stop('codex_configuration_invalid', 'waiting_configuration', 'Codex command must be an absolute path or binary name on PATH.');
  const dirs = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return stop('codex_configuration_invalid', 'waiting_configuration', `Codex binary "${command}" not found on PATH.`);
}

/** Optional operator/test override file (`BOT_CODEX_CONFIG`); normal runs select `/opt/agent-tools/codex/<ver>` + project model. */
export function codexConfiguration(): CodexConfiguration {
  const path = process.env.BOT_CODEX_CONFIG;
  if (!path) return stop('codex_not_configured', 'waiting_configuration', 'Set BOT_CODEX_CONFIG to an operator-owned Codex app-server launch configuration, or install Codex in /opt/agent-tools.');
  let c: any;
  try {
    c = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return stop('codex_configuration_invalid', 'waiting_configuration', 'Codex app-server launch configuration is missing or invalid JSON.');
  }
  const bad = (detail?: string): never => stop('codex_configuration_invalid', 'waiting_configuration', detail);
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    typeof c.command !== 'string' ||
    !c.command ||
    !Array.isArray(c.args ?? []) ||
    (c.args ?? []).some((a: unknown) => typeof a !== 'string') ||
    typeof c.stateDirectory !== 'string' ||
    !c.stateDirectory ||
    !c.env ||
    typeof c.env !== 'object' ||
    Array.isArray(c.env) ||
    Object.values(c.env).some(v => typeof v !== 'string') ||
    (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000))
  ) {
    return bad();
  }
  if (c.protocol !== undefined && c.protocol !== 'codex-app-server') {
    return bad(`BOT_CODEX_CONFIG declares protocol ${String(c.protocol)}, not codex-app-server.`);
  }
  const args: string[] = c.args ?? [];
  if (!args.includes('app-server') || args.some(a => ['proxy', 'daemon', '--listen', '--stdio'].includes(a) || /^(?:ws|unix):\/\//.test(a))) {
    return bad('Codex args must start a stdio `app-server` of its own (no daemon, proxy or listen socket).');
  }
  const home = c.env?.CODEX_HOME;
  if (typeof home !== 'string' || !isAbsolute(home)) {
    return bad('Codex launch needs env.CODEX_HOME: an absolute, dedicated Codex home.');
  }
  if (process.env.HOME && [join(process.env.HOME, '.codex'), resolve(process.env.HOME)].includes(resolve(home))) {
    return bad("CODEX_HOME must not be the host user's shared Codex home.");
  }
  if (c.mode !== undefined) return bad('mode is not supported; Codex container policy uses sandbox.');
  if (c.sandbox !== undefined && !['workspace-write', 'danger-full-access','read-only'].includes(c.sandbox)) {
    return bad('sandbox must be workspace-write or danger-full-access.');
  }
  if (!optionalString(c.model) || !optionalString(c.modelProvider) || !optionalMs(c.toolStartupMs, 100) || !optionalMs(c.cancelGraceMs, 100)) {
    return bad('model, modelProvider, toolStartupMs or cancelGraceMs is invalid.');
  }
  if (typeof c.version !== 'string' || !satisfiesCliRange('codex', c.version)) {
    return bad('version must pin a compatible Codex CLI version.');
  }
  let provider: CodexProviderConfig | undefined;
  if (c.provider !== undefined) {
    if (!c.provider || typeof c.provider !== 'object' || Array.isArray(c.provider) || typeof c.provider.baseUrl !== 'string' || typeof c.provider.credentialFile !== 'string' || !isAbsolute(c.provider.credentialFile)) {
      return bad('provider configuration is invalid.');
    }
    provider = {
      baseUrl: c.provider.baseUrl,
      credentialFile: c.provider.credentialFile,
      ...(c.provider.interfaceType ? { interfaceType: c.provider.interfaceType } : {}),
      ...(c.provider.authHeader ? { authHeader: c.provider.authHeader } : {}),
    };
  }
  return {
    modelTransport: modelTransport(c.modelTransport),
    command: c.command,
    args,
    env: c.env,
    stateDirectory: c.stateDirectory,
    version: c.version,
    protocol: 'codex-app-server',
    ...(c.model ? { model: c.model } : {}),
    ...(c.modelProvider ? { modelProvider: c.modelProvider } : {}),
    ...(c.sandbox ? { sandbox: c.sandbox } : {}),
    ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
    ...(c.toolStartupMs !== undefined ? { toolStartupMs: c.toolStartupMs } : {}),
    ...(c.cancelGraceMs !== undefined ? { cancelGraceMs: c.cancelGraceMs } : {}),
    ...(provider ? { provider } : {}),
  };
}

function stripTrailingAppServerArg(args: string[]): string[] {
  const copy = [...args];
  const idx = copy.lastIndexOf('app-server');
  if (idx >= 0) copy.splice(idx, 1);
  return copy;
}

export async function prepareCodex<T>(spec: AgentSpec<T>): Promise<CodexPreparation> {
  if (process.env.BOT_CODEX_CONFIG) {
    const config = codexConfiguration();
    for (const [name, value] of Object.entries(config.env ?? {})) {
      if (/key|token|secret|password/i.test(name)) spec.redactor.add(value);
    }
    const command = resolveExecutableOnPath(config.command);
    const executableArgs = stripTrailingAppServerArg(config.args);
    const localConfig = spec.containerOptions?.modelSource === 'local_config';
    const connectionMode = localConfig ? 'direct' : modelTransport(spec.containerOptions?.modelTransport ?? config.modelTransport);
    let fileProvider: FileBackedModelProvider | undefined = localConfig ? undefined : spec.containerOptions?.fileProvider;
    let primaryModel: RuntimeModel | undefined;
    if (!localConfig && !fileProvider && config.provider) {
      fileProvider = {
        id: 'codex_config_provider',
        baseUrl: config.provider.baseUrl,
        credentialFile: config.provider.credentialFile,
        model: config.model ?? 'gpt-5-codex',
        interfaceType: config.provider.interfaceType ?? 'openai-responses',
        authHeader: config.provider.authHeader ?? 'bearer',
      };
    } else if (!localConfig && !fileProvider && connectionMode === 'gateway') {
      try {
        primaryModel = (spec.model as RuntimeModel | undefined) ?? (executionModel(spec.store, spec.task) as RuntimeModel);
      } catch {
        primaryModel = undefined;
      }
    }
    const configurationHash = contentHash({
      ...config,
      command,
      modelTransport: connectionMode,
      ...(localConfig ? { modelSource: 'local_config' } : {}),
      protocol: 'codex-app-server',
    });
    const prepared: CodexPreparation = {
      modelTransport: connectionMode,
      modelSource: localConfig ? 'local_config' : 'gateway',
      mode: 'config_file',
      config,
      command,
      executableArgs,
      version: config.version,
      ...(!localConfig && config.model ? { model: config.model } : {}),
      ...(!localConfig ? (connectionMode === 'direct' && (fileProvider || primaryModel) ? { modelProvider: 'bot_direct' } : config.modelProvider ? { modelProvider: config.modelProvider } : {}) : {}),
      ...(primaryModel ? { primaryModel } : {}),
      ...(fileProvider ? { fileProvider } : {}),
      configurationHash,
    };
    spec.harnessPreparation = prepared;
    spec.harnessBinding = {
      harness_revision: `codex@${config.version}:${configurationHash}`,
      cli_version: config.version,
    };
    return prepared;
  }

  const override = spec.containerOptions?.executableOverride;
  let command: string;
  let executableArgs: string[] = [];
  let cliVersion: string;
  if (override) {
    command = override.executable;
    executableArgs = stripTrailingAppServerArg(override.args ?? []);
    cliVersion = override.version ?? COMPATIBLE_CLI_RANGES.codex.tested;
    if (!satisfiesCliRange('codex', cliVersion)) {
      return stop('codex_version_unsupported', 'waiting_configuration', `Codex version ${cliVersion} is outside ${COMPATIBLE_CLI_RANGES.codex.range}.`);
    }
  } else {
    const selected = selectCompatibleCliVersion(process.env.BOT_AGENT_TOOLS_DIR ?? DEFAULT_AGENT_TOOLS_ROOT, 'codex');
    command = selected.container_executable;
    cliVersion = selected.version;
  }

  const localConfig = spec.containerOptions?.modelSource === 'local_config';
  if (localConfig) {
    const configurationHash = contentHash({
      cli: 'codex',
      version: cliVersion,
      command,
      modelSource: 'local_config',
      protocol: 'codex-app-server',
    });
    const prepared: CodexPreparation = {
      modelTransport: 'direct',
      modelSource: 'local_config',
      mode: 'volume',
      command,
      executableArgs,
      version: cliVersion,
      configurationHash,
    };
    spec.harnessPreparation = prepared;
    spec.harnessBinding = {
      model_revision: `codex:local_config:${configurationHash}`,
      harness_revision: `codex@${cliVersion}:${configurationHash}`,
      cli_version: cliVersion,
    };
    return prepared;
  }

  const fileProvider = spec.containerOptions?.fileProvider;
  const primaryModel = fileProvider
    ? undefined
    : ((spec.model as RuntimeModel | undefined) ?? (executionModel(spec.store, spec.task) as RuntimeModel));
  const modelName = fileProvider ? fileProvider.model : primaryModel!.model;
  const connectionMode = modelTransport(spec.containerOptions?.modelTransport);
  const modelProvider = connectionMode === 'gateway' ? 'bot_relay' : 'bot_direct';
  const configurationHash = contentHash({
    cli: 'codex',
    version: cliVersion,
    command,
    model: modelName,
    model_id: primaryModel?.id ?? fileProvider?.id ?? 'provider',
    protocol: 'codex-app-server',
    modelTransport: connectionMode,
  });
  const prepared: CodexPreparation = {
    modelTransport: connectionMode,
    mode: 'volume',
    command,
    executableArgs,
    version: cliVersion,
    model: modelName,
    modelProvider,
    ...(primaryModel ? { primaryModel } : {}),
    ...(fileProvider ? { fileProvider } : {}),
    configurationHash,
  };
  spec.harnessPreparation = prepared;
  spec.harnessBinding = {
    model_revision: primaryModel
      ? `project_model:${primaryModel.id}@${primaryModel.version}:${modelName}`
      : `codex:${modelProvider}/${modelName}:${configurationHash}`,
    harness_revision: `codex@${cliVersion}:${configurationHash}`,
    cli_version: cliVersion,
  };
  return prepared;
}

export async function runCodex<T>(
  spec: AgentSpec<T>,
  signal: AbortSignal,
  emit: (e: HarnessEvent) => void,
): Promise<T> {
  const prepared = (spec.harnessPreparation as CodexPreparation | undefined) ?? (await prepareCodex(spec));
  const ctx = spec.runContext?.();
  if (!spec.runAccess?.token) {
    return stop('run_token_invalid', 'failed', '容器内 Codex 运行缺少控制面签发的运行级身份令牌。');
  }
  // Manager, QA and the service assistants run only on Pi (#1337).
  if (ctx && !['writer', 'observer'].includes(ctx.execution_context?.kind ?? '')) {
    return stop('harness_role_unsupported', 'waiting_configuration');
  }

  const platformTools = filterPlatformTools(spec);
  const offeredToolNames = platformTools.map(t => t.function.name);
  const finishDesc = (spec.finish?.names ?? [spec.finish?.name ?? '(none)']).join(' or ');
  const checkoutTrusted = spec.harnessAccess?.trustedCheckout !== false;
  const trustedAgentsSection =
    !checkoutTrusted && typeof spec.harnessAccess?.trustedAgentsMd === 'string' && spec.harnessAccess.trustedAgentsMd.trim()
      ? '\n\n## Trusted Repository Instructions (AGENTS.md)\n' + spec.harnessAccess.trustedAgentsMd
      : '';
  const instructions =
    spec.system +
    '\n\nYou execute one Bot role assignment inside the isolated workspace container with cwd at the repository checkout. ' +
    'Use native shell, file reading/editing, search, image viewing, and sub-agent tools directly on the repository checkout, and use the offered bot MCP tools for platform task records, memory, skills, and structured submission. ' +
    'Do not publish, push, or merge directly from shell. ' +
    `Use the offered submission tool ${finishDesc} once your role result is ready; a text message alone is not a submission, and submission is followed by independent acceptance. After successful submission, end this turn without further actions.` +
    trustedAgentsSection;

  const rawSessionKey = spec.harnessSessionKey ?? spec.roleRun?.instance_id ?? String(spec.task?.id ?? 'default');
  const sessionKey = String(rawSessionKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
  const fresh =
    spec.roleRun?.role === 'qa' ||
    ctx?.execution_context?.kind === 'evaluator' ||
    spec.roleRun?.recovery_mode === 'rebuilt_from_task_records';
  const egress = Boolean(spec.containerOptions?.egress);

  let dialect = null as CodexDialect | null;
  let activeSession = null as RunningContainerHarness<T> | null;
  let cancelReason: unknown = null;
  let cancelling = null as Promise<void> | null;
  let settled = false;

  const triggerCancel = (reason: unknown): Promise<void> => {
    if (settled) return Promise.resolve();
    if (!cancelReason) cancelReason = reason;
    if (cancelling) return cancelling;
    cancelling = (async () => {
      activeSession?.dispatcher.halt();
      try {
        await dialect?.cancel();
      } catch {}
      dialect?.close(cancelReason);
      await activeSession?.interrupt('kill');
    })();
    return cancelling;
  };

  try {
    return await withContainerHarnessSession(
      spec,
      {
        cli: 'codex',
        modelTransport: prepared.modelTransport,
        ...(prepared.modelSource ? { modelSource: prepared.modelSource } : {}),
        ...(prepared.modelSource !== 'local_config' ? {
          modelProvider: prepared.modelProvider,
          model: prepared.model ?? 'gpt-5-codex',
        } : {}),
        maxTurns: spec.maxTurns,
        maxOutputTokens: spec.maxOutputTokens ?? 8192,
        sessionKey,
        egress,
        ...(prepared.config?.stateDirectory ? { localWorkspaceRoot: prepared.config.stateDirectory } : {}),
        ...(prepared.config?.env?.CODEX_HOME ? { codexHomeOverride: prepared.config.env.CODEX_HOME } : {}),
        ...(prepared.config?.env ? { extraEnv: prepared.config.env } : {}),
        executableOverride: {
          executable: prepared.command,
          ...(prepared.executableArgs.length ? { args: prepared.executableArgs } : {}),
          ...(spec.containerOptions?.executableOverride?.nodeExecutable
            ? { nodeExecutable: spec.containerOptions.executableOverride.nodeExecutable }
            : {}),
          version: prepared.version,
        },
        ...(prepared.primaryModel ? { primaryModel: prepared.primaryModel } : {}),
        ...(prepared.fileProvider ? { fileProvider: prepared.fileProvider } : {}),
        manualCancel: reason => {
          void triggerCancel(reason);
        },
        onExit: exit => {
          dialect?.failStream(
            new TaskError(
              'codex_connection_lost',
              'retry_wait',
              `exit:${exit.exit_code ?? exit.signal ?? exit.state}`,
            ),
          );
        },
      },
      signal,
      chunk => {
        dialect?.feed(chunk);
      },
      async session => {
        activeSession = session;
        if (prepared.config?.timeoutMs !== undefined) {
          emit({ type: 'configuration', stage: 'legacy_timeout_ignored', timeoutMs: prepared.config.timeoutMs });
        }

        const cwd = typeof session.started?.repo_dir === 'string' && session.started.repo_dir
          ? session.started.repo_dir
          : `/workspace/tasks/${session.workspaceId}/repo`;
        const codexHome = typeof session.started?.codex_home === 'string' && session.started.codex_home
          ? session.started.codex_home
          : prepared.config?.env?.CODEX_HOME ?? `/workspace/tasks/${session.stateWorkspaceId}/cli-state/${sessionKey}/codex-home`;
        const mcpCommand = typeof session.started?.mcp_command === 'string' && session.started.mcp_command
          ? session.started.mcp_command
          : process.execPath;
        const mcpArgs = Array.isArray(session.started?.mcp_args)
          ? session.started.mcp_args.map((a: unknown) => String(a))
          : ['/opt/runner/mcp-bridge.mjs', `/workspace/tasks/${session.workspaceId}/agent`];
        const sandbox =
          (spec.harnessAccess&&spec.harnessAccess.workspace!=='write'?'read-only':prepared.config?.sandbox) ??
          (cwd.startsWith('/workspace/') ? 'danger-full-access' : 'workspace-write');

        let binding: Record<string, unknown> = {};
        let isBound = false;
        const save = (patch: Record<string, unknown>) => {
          binding = { ...binding, ...patch };
          if (isBound) spec.harnessState?.save(binding);
        };

        dialect = appServerDialect({
          transport: {
            writeLine: line => {
              void session.writeStdin(line + '\n').catch(err => {
                dialect?.failStream(err instanceof Error ? err : new Error(String(err)));
              });
            },
          },
          expectedVersion: session.cliVersion,
          codexHome,
          cwd,
          egress,
          sandbox,
          computerAllowed: spec.harnessAccess?.commands!==false,
          fileWriteAllowed:spec.harnessAccess?(spec.harnessAccess.fileTools??spec.harnessAccess.workspace)==='write':true,
          trustedCheckout: checkoutTrusted,
          recordNativeReceipt:item=>traceEvent(spec.store,spec.task.id,'harness_native_receipt',spec.redactor.clean(item),spec.task.trace_run_id,'harness'),
          ...(prepared.model ? { model: prepared.model } : {}),
          ...(prepared.modelProvider ? { modelProvider: prepared.modelProvider } : {}),
          mcpCommand,
          mcpArgs,
          ...(prepared.config?.toolStartupMs !== undefined ? { toolStartupMs: prepared.config.toolStartupMs } : {}),
          ...(prepared.config?.cancelGraceMs !== undefined ? { cancelGraceMs: prepared.config.cancelGraceMs } : {}),
          tools: offeredToolNames,
          instructions,
          redactor: spec.redactor,
          emit,
          guard: spec.guard,
          denied: (name, reason) => spec.onDenied?.(name, reason),
          stop: error => {
            session.dispatcher.halt();
            void triggerCancel(error);
          },
          save,
        });

        const previous = spec.harnessState?.value;
        try {
          const opened = await dialect.open(previous, fresh);
          isBound = true;
          save({
            ...opened.state,
            sessionId: opened.sessionId,
            previousSessionId: previous?.sessionId ?? null,
            stateWorkspaceId: session.stateWorkspaceId,
            sessionKey,
            cwd,
            recoveryMode: opened.recovery,
            agentInfo: opened.agentInfo ?? null,
            version: session.cliVersion,
            configurationHash: prepared.configurationHash,
          });
          emit({
            type: 'session_bound',
            sessionRef: opened.sessionId,
            previousSessionRef: previous?.sessionId ?? null,
            recoveryMode: opened.recovery,
            agentInfo: opened.agentInfo ?? null,
            configuredModel: prepared.model ?? (typeof opened.bound?.model === 'string' ? opened.bound.model : null),
            ...(prepared.modelSource === 'local_config' ? { modelSource: 'local_config' } : {}),
            usage: prepared.modelSource !== 'local_config' && prepared.modelTransport === 'gateway' ? 'gateway' : 'native_events',
            protocol: 'codex-app-server',
            ...opened.bound,
          });
          dialect.bound();

          for (let repair = 0; repair < 3; repair++) {
            await spec.guard();
            if (signal.aborted) throw signal.reason;
            const body = (repair === 0 && opened.notice ? opened.notice + '\n\n' : '') + spec.prompt;
            const { text } = await dialect.turn(
              body +
                (repair
                  ? '\nYour last turn did not submit a valid role result. Reuse existing observations and submit the required structured result, without repeating unchanged tests. If a declined permission blocks the assignment, say so in the submission instead of retrying it.'
                  : ''),
            );
            if (cancelReason) {
              if (cancelling) await cancelling;
              throw cancelReason;
            }
            if (session.dispatcher.submitted) return session.dispatcher.result as T;
            if (spec.onTurnEnd) return await spec.onTurnEnd({text,session_id:String(opened.sessionId)});
            if (!spec.finish?.name && spec.validate) return await spec.validate(text);
          }
          return stop('codex_submission_required', 'retry_wait');
        } catch (innerErr) {
          if (cancelling) await cancelling.catch(() => {});
          throw innerErr;
        }
      },
    );
  } catch (error) {
    if (cancelling) await cancelling.catch(() => {});
    if (cancelReason) throw cancelReason;
    if (error instanceof TaskError) throw error;
    throw new TaskError('codex_execution_failed', 'retry_wait', spec.redactor.text(String((error as Error)?.message ?? error)).slice(0, 1000));
  } finally {
    settled = true;
    dialect?.close();
  }
}

export function codexHarness<T>(spec: AgentSpec<T>) {
  return async (services: AgentServices): Promise<T> => {
    const ctx = spec.runContext?.();
    const receipts = ctx?.resume_from_run_id ? toolReceipts(spec.store, ctx.resume_from_run_id) : null;
    return runCodex(
      {
        ...spec,
        guard: services.guard,
        prompt: ctx
          ? spec.prompt + '\nRun context: ' + JSON.stringify(ctx) + '\nPrevious tool receipts: ' + JSON.stringify(receipts)
          : spec.prompt,
      },
      spec.executionSignal!,
      event => {
        if (event.type === 'session_bound' && spec.task.trace_run_id) {
          spec.store.run('UPDATE task_runs SET recovery_mode=? WHERE id=?', String(event.recoveryMode), spec.task.trace_run_id);
        }
        traceEvent(spec.store, spec.task.id, 'harness_event', spec.redactor.clean(event), spec.task.trace_run_id, 'harness');
        spec.onHarnessEvent?.(spec.redactor.clean(event));
      },
    );
  };
}
