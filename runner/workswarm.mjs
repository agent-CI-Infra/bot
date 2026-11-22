import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { workspaceRoot } from './paths.mjs';

const runFile = promisify(execFile);
const reservations = join(workspaceRoot, '.workswarm-ports');
const runId = /^[a-f0-9]{48}$/;
const prepareWorkspace = `
import json
from pathlib import Path
import sys

import yaml
from jiuwenswarm.common.utils import prepare_runtime_workspace

config = Path(sys.argv[1])
policy = json.loads(config.read_text(encoding="utf-8"))["permissions"]
prepare_runtime_workspace(migrate_config=False)
if yaml.safe_load(config.read_text(encoding="utf-8")).get("permissions") != policy:
    raise SystemExit("WorkSwarm permissions changed during workspace preparation")
`;

export async function releaseWorkSwarmPorts(instanceId) {
  if (!runId.test(instanceId ?? '')) return;
  await Promise.all((await readdir(reservations).catch(() => [])).map(async port => {
    const path = join(reservations, port);
    if (await readlink(path).catch(() => '') === instanceId) await unlink(path).catch(() => {});
  }));
}

function canBind(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function reserveWorkSwarmPorts(instanceId) {
  if (!runId.test(instanceId ?? '')) throw new Error('workswarm_instance_required');
  await mkdir(reservations, { recursive: true, mode: 0o700 });
  const names = ['agent-server', 'gateway', 'web'];
  const ports = {};
  // Preserve ownership through Python startup. Stay below the usual Linux ephemeral
  // range so WebSocket clients and model connections do not take the advertised ports.
  for (let attempt = 0; names.length && attempt < 128; attempt++) {
    const port = randomInt(18_000, 28_000);
    const path = join(reservations, String(port));
    try { await symlink(instanceId, path); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    if (await canBind(port)) ports[names.shift()] = port;
    else await unlink(path);
  }
  if (names.length) throw new Error('workswarm_ports_unavailable');
  return ports;
}

export async function workSwarmToolNames(agentDir) {
  const tools = JSON.parse(await readFile(join(agentDir, 'mcp-tools.json'), 'utf8'));
  return tools.map(tool => 'mcp_bot_' + tool.name);
}

// WorkSwarm accepts MCP through its own config, not through ACP mcpServers.
// Use a private workspace for its built-ins and let platform MCP enforce checkout access.
export async function configureWorkSwarm(config, home, ports, mcp, token, agentDir, { executable, environment, signal }) {
  const data = join(home, 'data');
  const directory = join(data, 'config');
  const workspace = join(home, 'workspace');
  const tmp = join(home, 'tmp');
  await Promise.all([directory, workspace, tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const env = {
    HOME: home,
    TMPDIR: tmp,
    JIUWENSWARM_HOME: home,
    JIUWENSWARM_DATA_DIR: data,
    // Both AgentServer and its Worker use the private cwd. A relative socket fits sun_path
    // even when the task directory and the run HOME both contain a full instance ID.
    JIUWENSWARM_RUNTIME_SOCKET: 'worker.sock',
    AGENT_SERVER_HOST: '127.0.0.1',
    AGENT_SERVER_PORT: String(ports.agent),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(ports.gateway),
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(ports.web),
    API_KEY: token,
    PLAYWRIGHT_BROWSERS_PATH: '0',
  };
  const model = config.acp_model;
  const anthropic = model.interface_type === 'anthropic-messages';
  const protocolBase = process.env.BOT_ACP_RELAY_URL + (anthropic ? '' : '/v1');
  const allowedTools = Object.fromEntries((await workSwarmToolNames(agentDir)).map(name => [name, 'allow']));
  const settings = {
    models: { defaults: [{
      model_id: 'mdl_default_primary', is_default: true,
      model_client_config: {
        api_base: protocolBase, api_key: '${API_KEY}', model_name: config.model,
        client_provider: anthropic ? 'Anthropic' : 'OpenAI',
        ...(anthropic ? {} : { endpoint_profile: 'openai_compatible' }),
      },
      model_config_obj: { context_window: model.context_window, max_tokens: model.max_output_tokens },
    }] },
    mcp: { servers: [{
      name: 'bot', enabled: true, transport: 'streamable-http', url: mcp.url,
      headers: { Authorization: 'Bearer ' + token },
    }] },
    progressive_tool_enabled: false,
    heartbeat: { enabled: false },
    health_check: { enabled: false },
    auto_recap: { enabled: false },
    permissions: { enabled: true, mode: 'manual', defaults: { '*': 'deny' }, tools: allowedTools },
    hooks: { disable_all_hooks: true },
    updater: { enabled: false },
    task_memory: { enabled: false },
  };
  const configPath = join(directory, 'config.yaml');
  await Promise.all([
    writeFile(configPath, JSON.stringify(settings), { flag: 'wx', mode: 0o600 }),
    writeFile(join(directory, '.env'), '', { flag: 'wx', mode: 0o600 }),
  ]);
  // Seed the required workspace files without merging upstream tool grants into the run policy.
  await runFile(executable, ['-c', prepareWorkspace, configPath], {
    cwd: workspace, env: { ...environment, ...env }, signal, timeout: 60_000,
  });
  env.JIUWENSWARM_RUNTIME_WORKSPACE_READY = '1';
  return { env, workspace };
}
