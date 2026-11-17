import {stageSessionSkills} from './session-resources.mjs';
import {startCredentialHelperServer} from './credential-helper.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { maskedStream } from './command-output.mjs';
import { environment as baseEnv, workspaceTag } from './command.mjs';
import { startModelRelay } from './model-relay.mjs';
import { local, runnerRoot, tasksDirectory } from './paths.mjs';
import { createTokenExchange } from './token-exchange.mjs';

const ID48_RE = /^[a-f0-9]{48}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

function mapToolsPath(containerPath) {
  if (!containerPath || typeof containerPath !== 'string') return null;
  if (local && process.env.BOT_AGENT_TOOLS_DIR && containerPath.startsWith('/opt/agent-tools/')) {
    return resolve(process.env.BOT_AGENT_TOOLS_DIR, containerPath.slice('/opt/agent-tools/'.length));
  }
  return containerPath;
}

async function ensureSafeDirectory(dirPath, allowedRoot) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(allowedRoot);
  const realDir = await realpath(dirPath);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new Error('unsafe_state_directory');
  }
  const st = await lstat(dirPath);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unsafe_state_directory');
  await chmod(dirPath, 0o700).catch(() => {});
  return realDir;
}

function claudeTranscriptExists(homeDir, sessionId) {
  if (!UUID_RE.test(sessionId || '')) return false;
  const projectsDir = join(homeDir, '.claude', 'projects');
  try {
    if (!existsSync(projectsDir)) return false;
    if (realpathSync(projectsDir) !== resolve(projectsDir) || !lstatSync(projectsDir).isDirectory()) return false;
    return readdirSync(projectsDir, { withFileTypes: true }).some(entry => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      const file = join(projectsDir, entry.name, sessionId + '.jsonl');
      return existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink();
    });
  } catch {
    return false;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function buildCodexConfigToml({ model, relayUrl, egress, nodeExec, mcpBridgePath, agentDir, access }) {
  return [
    `model = ${tomlString(model)}`,
    `model_provider = "bot_relay"`,
    `approval_policy = "never"`,
    `sandbox_mode = ${tomlString(access&&access.workspace!=='write'?'read-only':local ? 'workspace-write' : 'danger-full-access')}`,
    `web_search = ${tomlString(egress ? 'live' : 'disabled')}`,
    ``,
    `[features]`,
    `shell_tool = ${access?.commands!==false}`,
    `view_image = true`,
    `multi_agent = true`,
    ``,
    `[model_providers.bot_relay]`,
    `name = "Bot Relay"`,
    `base_url = ${tomlString(relayUrl + '/v1')}`,
    `env_key = "BOT_RUN_TOKEN"`,
    `wire_api = "responses"`,
    ``,
    `[mcp_servers.bot]`,
    `command = ${tomlString(nodeExec)}`,
    `args = [${tomlString(mcpBridgePath)}, ${tomlString(agentDir)}]`,
    `env_vars = ["BOT_RUN_TOKEN", "BOT_WORKSPACE_ID"]`,
    `tool_timeout_sec = 3600`,
    `startup_timeout_sec = 30`,
    ``,
  ].join('\n');
}


function buildGitConfigEnv(existingEnv, gitCredentialScript, allowHttp) {
  const entries = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['commit.gpgsign', 'false'],
    ['gc.auto', '0'],
    ['credential.useHttpPath', 'false'],
    ['credential.helper', `!${process.execPath} ${gitCredentialScript}`],
  ];
  if (allowHttp) entries.push(['http.extraHeader', '']);
  const out = { ...existingEnv, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k;
    out[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return out;
}

const root = resolve(process.argv[2] || '');
const workspaceId = root.split('/').pop() || '';
if (!ID48_RE.test(workspaceId)) {
  process.stderr.write('harness-entry: invalid workspace root\n');
  process.exit(2);
}

const agentDir = root + '/agent';
const repoDir = root + '/repo';
const stateFile = agentDir + '/harness-state.json';
const stdoutFile = agentDir + '/harness-stdout.bin';
const stdinFile = agentDir + '/harness-stdin.jsonl';
const interruptFile = agentDir + '/harness-interrupt.json';
const bootLine = await readFile('/proc/1/stat', 'utf8').catch(() => '');
const boot = bootLine ? bootLine.slice(bootLine.lastIndexOf(')') + 2).split(' ')[19] : 'local';

let instanceId = null;
let hasWrittenRunning = false;

let currentState = {
  state: 'starting',
  pid: process.pid,
  cli_pid: null,
  boot,
  instance_id: null,
  relay_url: null,
  session_id: null,
  actual_resume: false,
  exit_code: null,
  signal: null,
  error: null,
  stderr_tail: '',
};

async function ownsStateFile() {
  const onDisk = await readFile(stateFile, 'utf8').then(JSON.parse).catch(() => null);
  if (onDisk) {
    if (instanceId && onDisk.instance_id && onDisk.instance_id !== instanceId) return false;
    if (onDisk.pid && onDisk.pid !== process.pid) return false;
    return true;
  }
  return !hasWrittenRunning;
}

let stateWriteChain = Promise.resolve();
const writeState = patch => {
  currentState = { ...currentState, ...patch };
  const isRunningPatch = patch.state === 'running';
  const snapshot = JSON.stringify(currentState);
  stateWriteChain = stateWriteChain.then(async () => {
    if (!(await ownsStateFile())) return;
    await writeFile(stateFile + '.tmp', snapshot, { mode: 0o600 });
    await rename(stateFile + '.tmp', stateFile);
    if (isRunningPatch) hasWrittenRunning = true;
  }).catch(() => {});
  return stateWriteChain;
};

const runAbort = new AbortController();
const secrets = [];
const addSecret = s => {
  if (typeof s === 'string' && s.length >= 8 && !secrets.includes(s)) secrets.push(s);
};

let relay = null;
let credHelper = null;
let cliChild = null;
let pollTimer = null;

const shutdown = async (finalPatch = {}) => {
  runAbort.abort();
  if (pollTimer) clearInterval(pollTimer);
  await Promise.allSettled([
    relay?.close?.(),
    credHelper?.close?.(),
  ]);
  await writeState(finalPatch);
};

try {
  const rawConfig = JSON.parse(await readFile(agentDir + '/harness.json', 'utf8'));
  if (ID48_RE.test(rawConfig.instance_id || '')) {
    instanceId = rawConfig.instance_id;
    currentState.instance_id = instanceId;
  }
  const runToken = String(rawConfig.run_token || '');
  if (!runToken) throw new Error('harness_run_token_missing');
  addSecret(runToken);

  // Scrub run_token from harness.json on disk before spawning any child process.
  const scrubbedConfig = { ...rawConfig };
  delete scrubbedConfig.run_token;
  await writeFile(agentDir + '/harness.json.tmp', JSON.stringify(scrubbedConfig), { mode: 0o600 });
  await rename(agentDir + '/harness.json.tmp', agentDir + '/harness.json');

  const harness = rawConfig.harness;
  if (harness !== 'claude_code' && harness !== 'codex') throw new Error('unsupported_container_harness');

  const executable = mapToolsPath(rawConfig.executable);
  if (!executable || !executable.startsWith('/')) throw new Error('harness_executable_invalid');
  const nodeExecutable = mapToolsPath(rawConfig.node_executable) || process.execPath;

  const stateWorkspaceId = ID48_RE.test(rawConfig.state_workspace_id || '') ? rawConfig.state_workspace_id : workspaceId;
  const sessionKey = SESSION_KEY_RE.test(rawConfig.session_key || '') ? rawConfig.session_key : 'default';
  const tasksBase = await ensureSafeDirectory(tasksDirectory, dirname(tasksDirectory));
  const stateWorkspaceDir = await ensureSafeDirectory(`${tasksBase}/${stateWorkspaceId}`, tasksBase);
  const cliStateRoot = await ensureSafeDirectory(`${stateWorkspaceDir}/cli-state/${sessionKey}`, stateWorkspaceDir);
  const homeDir = await ensureSafeDirectory(`${cliStateRoot}/home`, cliStateRoot);
  const tmpDir = await ensureSafeDirectory(`${agentDir}/tmp`, agentDir);
  const wrapperBinDir = await ensureSafeDirectory(`${agentDir}/bin`, agentDir);

  await writeFile(
    `${wrapperBinDir}/gh`,
    `#!/bin/sh\nexec "${process.execPath}" "${runnerRoot}/gh-wrapper.mjs" "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(`${wrapperBinDir}/gh`, 0o700);

  // Login shells (`bash -lc` / `sh -lc`, used by Claude Code's shell snapshot and Codex's shell tool) source
  // `/etc/profile`, which overwrites PATH on Debian. Restore the wrapper and bundled runtime directories at the front.
  const loginProfile = [
    '# Managed by Bot container harness (#705)',
    'case "${PATH:-}" in',
    '  "${BOT_NODE_BIN_DIR}:"*|"${BOT_WRAPPER_BIN_DIR}:${BOT_NODE_BIN_DIR}:"*) ;;',
    '  *) [ -n "${BOT_NODE_BIN_DIR:-}" ] && PATH="${BOT_NODE_BIN_DIR}${PATH:+:$PATH}" ;;',
    'esac',
    'case "${PATH:-}" in',
    '  "${BOT_WRAPPER_BIN_DIR}:"*) ;;',
    '  *) [ -n "${BOT_WRAPPER_BIN_DIR:-}" ] && PATH="${BOT_WRAPPER_BIN_DIR}${PATH:+:$PATH}" ;;',
    'esac',
    'export PATH',
    '',
  ].join('\n');
  const bashProfile = 'if [ -f "$HOME/.profile" ]; then\n  . "$HOME/.profile"\nfi\n';
  for (const [name, content] of [['.profile', loginProfile], ['.bash_profile', bashProfile]]) {
    const tmpProfile = `${homeDir}/${name}.tmp`;
    await unlink(tmpProfile).catch(() => {});
    await writeFile(tmpProfile, content, { mode: 0o600 });
    await rename(tmpProfile, `${homeDir}/${name}`);
  }

  const gateway = rawConfig.model_transport === 'gateway';
  if(gateway) relay = await startModelRelay({ agentDir, signal: runAbort.signal });
  const nativeModel = gateway ? undefined : rawConfig.native_model;
  if(nativeModel?.key)addSecret(nativeModel.key);
  credHelper = await startCredentialHelperServer({ agentDir, runToken, addSecret, signal: runAbort.signal });

  const githubHost = typeof rawConfig.github_host === 'string' && rawConfig.github_host ? rawConfig.github_host : 'github.com';
  const allowHttpGit = Boolean(local && rawConfig.allow_http_git === true);
  const mcpBridgePath = `${runnerRoot}/mcp-bridge.mjs`;
  const gitCredPath = `${runnerRoot}/git-credential-bot.mjs`;

  const nodeBinDir = dirname(nodeExecutable);
  const pathParts = [wrapperBinDir, nodeBinDir, ...String(baseEnv.PATH).split(delimiter)];
  if (local) pathParts.splice(2, 0, dirname(process.execPath));
  const childPath = [...new Set(pathParts.filter(Boolean))].join(delimiter);

  let childEnv = {
    ...baseEnv,
    ...workspaceTag(workspaceId),
    PATH: childPath,
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: 'C.UTF-8',
    BOT_RUN_TOKEN: runToken,
    BOT_CREDENTIAL_HELPER_URL: credHelper.url,
    BOT_CREDENTIAL_HELPER_SECRET: credHelper.secret,
    BOT_WRAPPER_BIN_DIR: wrapperBinDir,
    BOT_NODE_BIN_DIR: nodeBinDir,
    BOT_GITHUB_HOST: githubHost,
    ...(allowHttpGit ? { BOT_ALLOW_HTTP_GIT_CREDENTIAL: 'true' } : {}),
    ...(local && process.env.BOT_REAL_GH_BIN ? { BOT_REAL_GH_BIN: process.env.BOT_REAL_GH_BIN } : {}),
  };

  if (rawConfig.extra_env && typeof rawConfig.extra_env === 'object' && !Array.isArray(rawConfig.extra_env)) {
    for (const [k, v] of Object.entries(rawConfig.extra_env)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(k) && !/^(BOT_|HOME$|PATH$|TMPDIR$)/.test(k) && typeof v === 'string') {
        childEnv[k] = v;
        if (/TOKEN|SECRET|KEY/i.test(k)) addSecret(v);
      }
    }
  }

  childEnv = buildGitConfigEnv(childEnv, gitCredPath, allowHttpGit);

  let spawnCmd = executable;
  let spawnArgs = [];
  let sessionId = typeof rawConfig.session_id === 'string' ? rawConfig.session_id : null;
  let actualResume = false;

  if (harness === 'claude_code') {
    // Explicit provider credentials take precedence over an unrelated native login.
    if(gateway||nativeModel){delete childEnv.ANTHROPIC_AUTH_TOKEN;delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;}
    const claudeHome = local && rawConfig.claude_home_override?.startsWith('/')
      ? await ensureSafeDirectory(rawConfig.claude_home_override, dirname(rawConfig.claude_home_override))
      : await ensureSafeDirectory(`${homeDir}/.claude`, homeDir);
    await stageSessionSkills(claudeHome,rawConfig.resources);
    await ensureSafeDirectory(`${homeDir}/.config`, homeDir);
    await ensureSafeDirectory(`${homeDir}/.cache`, homeDir);
    if (rawConfig.resume === true && sessionId && claudeTranscriptExists(homeDir, sessionId)) {
      actualResume = true;
    } else {
      if (!sessionId || !UUID_RE.test(sessionId) || rawConfig.resume === true) {
        sessionId = randomUUID();
      }
      actualResume = false;
    }

    const disallowed = [
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'PushNotification',
      'DesignSync',
      'Workflow',
      'ReportFindings',
      'Monitor',
    ];
    if (!rawConfig.egress) disallowed.push('WebFetch', 'WebSearch');
    if(rawConfig.execution_access){const access=rawConfig.execution_access;if(!access.commands)disallowed.push('Bash');if((access.fileTools??access.workspace)!=='write')disallowed.push('Write','Edit','NotebookEdit');if((access.fileTools??access.workspace)==='none')disallowed.push('Read','Glob','Grep');}

    const mcpConfig = {
      mcpServers: {
        bot: {
          command: nodeExecutable,
          args: [mcpBridgePath, agentDir],
        },
      },
    };

    spawnArgs = [
      ...(Array.isArray(rawConfig.executable_args) ? rawConfig.executable_args : []),
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', 'default',
      '--disallowedTools', disallowed.join(','),
      '--setting-sources', 'project,local',
      '--settings', JSON.stringify({ autoUpdatesChannel: 'stable' }),
      '--mcp-config', JSON.stringify(mcpConfig),
      '--dangerously-skip-permissions',
      '--no-chrome',
      '--model', String(rawConfig.model || 'claude-sonnet-4-5-20250929'),
      ...(rawConfig.max_turns?['--max-turns',String(rawConfig.max_turns)]:[]),
      '--system-prompt', String(rawConfig.system_prompt || ''),
      ...(actualResume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ];

    Object.assign(childEnv, {
      CLAUDE_CONFIG_DIR: claudeHome,
      XDG_CONFIG_HOME: `${homeDir}/.config`,
      XDG_CACHE_HOME: `${homeDir}/.cache`,
      ...(gateway ? {ANTHROPIC_BASE_URL: relay.url,ANTHROPIC_API_KEY: runToken}
        : nativeModel ? {ANTHROPIC_BASE_URL:nativeModel.baseUrl,ANTHROPIC_API_KEY:nativeModel.key} : {}),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(rawConfig.max_output_tokens || 8192),
      MCP_TIMEOUT: '60000',
      MCP_TOOL_TIMEOUT: '3600000',
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '3600000',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  } else {
    const codexHome = local && typeof rawConfig.codex_home_override === 'string' && rawConfig.codex_home_override.startsWith('/')
      ? await ensureSafeDirectory(rawConfig.codex_home_override, dirname(rawConfig.codex_home_override))
      : await ensureSafeDirectory(`${cliStateRoot}/codex-home`, cliStateRoot);
    await stageSessionSkills(codexHome,rawConfig.resources);
    if(gateway) await writeFile(
      `${codexHome}/config.toml`,
      buildCodexConfigToml({
        model: String(rawConfig.model || 'gpt-5-codex'),
        relayUrl: relay.url,
        egress: Boolean(rawConfig.egress),
        nodeExec: nodeExecutable,
        mcpBridgePath,
        agentDir,
        access:rawConfig.execution_access,
      }),
      { mode: 0o600 },
    );
    const nativeProvider = nativeModel ? ['-c',`model_providers.bot_direct = { name = "Bot direct", base_url = ${tomlString(nativeModel.baseUrl)}, env_key = "BOT_NATIVE_MODEL_KEY", wire_api = "responses" }`] : [];
    spawnArgs = [...(Array.isArray(rawConfig.executable_args) ? rawConfig.executable_args : []), ...nativeProvider, 'app-server'];
    Object.assign(childEnv, {
      CODEX_HOME: codexHome,
      ...(gateway ? {CODEX_RELAY_URL: relay.url,OPENAI_BASE_URL: `${relay.url}/v1`,OPENAI_API_KEY: runToken}
        : nativeModel ? {BOT_NATIVE_MODEL_KEY:nativeModel.key} : {}),
    });
  }

  await writeFile(stdoutFile, '', { mode: 0o600 });
  await writeFile(stdinFile, '', { mode: 0o600 });
  await unlink(interruptFile).catch(() => {});

  const stdoutHandle = await open(stdoutFile, 'a', 0o600);
  let stdoutWriteChain = Promise.resolve();
  const outMask = maskedStream(secrets, text => {
    const buf = Buffer.from(text, 'utf8');
    stdoutWriteChain = stdoutWriteChain.then(() => stdoutHandle.write(buf)).catch(() => {});
  });
  let stderrTail = '';
  const errMask = maskedStream(secrets, text => {
    stderrTail = (stderrTail + text).slice(-4000);
  });

  cliChild = spawn(spawnCmd, spawnArgs, {
    cwd: repoDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  cliChild.stdout.on('data', chunk => outMask.data(chunk));
  cliChild.stderr.on('data', chunk => errMask.data(chunk));
  cliChild.stdin.on('error', () => {});

  await writeState({
    state: 'running',
    cli_pid: cliChild.pid ?? null,
    model_transport: gateway ? 'gateway' : 'direct',
    relay_url: relay?.url ?? null,
    session_id: sessionId,
    actual_resume: actualResume,
    repo_dir: repoDir,
    codex_home: childEnv.CODEX_HOME ?? null,
    mcp_command: nodeExecutable,
    mcp_args: [mcpBridgePath, agentDir],
  });

  let stdinLineCursor = 0;
  let interruptHandled = false;
  let killHandled = false;
  let pollingStdin = false;

  const pumpControlFiles = async () => {
    if (pollingStdin || !cliChild) return;
    pollingStdin = true;
    try {
      if (!existsSync(agentDir) || !(await ownsStateFile())) {
        interruptHandled = true;
        killHandled = true;
        try { cliChild.kill('SIGKILL'); } catch {}
        return;
      }
      const rawStdin = await readFile(stdinFile, 'utf8').catch(() => '');
      const completeLines = rawStdin.split('\n').slice(0, -1);
      while (stdinLineCursor < completeLines.length) {
        const line = completeLines[stdinLineCursor++];
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry?.close === true) {
          if (cliChild.stdin.writable) cliChild.stdin.end();
        } else if (typeof entry?.chunk_base64 === 'string' && cliChild.stdin.writable) {
          cliChild.stdin.write(Buffer.from(entry.chunk_base64, 'base64'));
        }
      }

      if (!killHandled) {
        const intr = await readFile(interruptFile, 'utf8').then(JSON.parse).catch(() => null);
        if (intr && (!intr.instance_id || !instanceId || intr.instance_id === instanceId)) {
          if (intr.mode === 'kill') {
            interruptHandled = true;
            killHandled = true;
            try { cliChild.kill('SIGKILL'); } catch {}
          } else if (!interruptHandled) {
            interruptHandled = true;
            if (harness === 'claude_code' && cliChild.stdin.writable) {
              cliChild.stdin.write(JSON.stringify({
                type: 'control_request',
                request_id: randomUUID(),
                request: { subtype: 'interrupt' },
              }) + '\n');
            } else {
              try { cliChild.kill('SIGTERM'); } catch {}
            }
            const graceMs = Number.isSafeInteger(intr.grace_ms) && intr.grace_ms > 0 ? intr.grace_ms : 1500;
            setTimeout(() => {
              try { cliChild?.kill('SIGKILL'); } catch {}
            }, graceMs).unref();
          }
        }
      }
    } catch {} finally {
      pollingStdin = false;
    }
  };

  pollTimer = setInterval(() => { void pumpControlFiles(); }, 20);
  pollTimer.unref();

  const exitResult = await new Promise(resolveExit => {
    cliChild.once('error', err => resolveExit({ code: null, signal: null, error: String(err?.message || 'spawn_failed') }));
    cliChild.once('close', (code, signal) => resolveExit({ code, signal, error: null }));
  });

  outMask.end();
  errMask.end();
  await stdoutWriteChain;
  await stdoutHandle.close().catch(() => {});

  const finalState = interruptHandled
    ? 'interrupted'
    : exitResult.error
      ? 'failed'
      : exitResult.code === 0
        ? 'completed'
        : 'failed';

  await shutdown({
    state: finalState,
    exit_code: exitResult.code,
    signal: exitResult.signal,
    error: exitResult.error,
    stderr_tail: stderrTail,
  });

  // Reclaim any lingering descendants in our detached process group before exiting (#632).
  process.on('SIGTERM', () => {});
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  process.exit(0);
} catch (err) {
  await shutdown({
    state: 'failed',
    error: String(err?.message || 'harness_entry_failed').slice(0, 1000),
  });
  process.exit(1);
}
