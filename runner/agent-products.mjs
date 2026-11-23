// Single source of truth for all third-party container Agent products managed in the agent-tools volume (#1260).
// Pi stays built into the runner image and is intentionally absent from this registry.

export const BUNDLED_NODE_VERSION = '22.15.0';

export const BUNDLED_UV_RELEASE = Object.freeze({
  version: '0.13.9',
  repo: 'astral-sh/uv',
  assets: Object.freeze({
    x64: Object.freeze({
      name: 'uv-x86_64-unknown-linux-musl.tar.gz',
      entry: 'uv-x86_64-unknown-linux-musl/uv',
      sha256: '58ccf5f1792b8a5a88d01bc910ea131a8b3db4a319a17ad5fad75e0845a3e271',
    }),
    arm64: Object.freeze({
      name: 'uv-aarch64-unknown-linux-musl.tar.gz',
      entry: 'uv-aarch64-unknown-linux-musl/uv',
      sha256: '37fbb7c5bc66cf99c12aa881949d216181e201dec449772c4329e56487d61179',
    }),
  }),
});

export const icodeProductId = 'icode';
export const icodeTestedVersion = '0.36.0';
export const icodeLaunch = Object.freeze({
  args: ['acp', '--approval', 'bypass', '--ask-user-timeout', '5', '--agent', 'Launchpad'],
  mcp: 'http',
  access: 'native',
  untrustedCheckout: true,
  env: {},
  answers: {},
  sidecars: [],
});
export const icodeReleases = new Map([['0.36.0', {
  version: '0.36.0',
  repo: 'openJiuwen-ai/iCode',
  tag: 'v0.36.0',
  commit: '78802f87d07f053fe560d680e4696c2bf322e2c2',
  assets: Object.freeze({
    x64: 'icode-linux-x86_64-v0.36.0-offline.tar.gz',
    arm64: 'icode-linux-aarch64-v0.36.0-offline.tar.gz',
  }),
  sha256: {
    x64: '3688097aaa6fd2a6eed530e19fb6046a0e6d8d58ace4b07d8490bea18cef2e00',
    arm64: '3212c67b84d58eea1d515ce0b13e73e6efac5fbeb6ed7804ccee13cfc5a7865e',
  },
}]]);

export const workswarmProductId = 'workswarm';
export const workswarmRelease = Object.freeze({
  version: '0.2.9',
  repo: 'openJiuwen-ai/jiuwenswarm',
  tag: 'v0.2.9',
  commit: '453dce3054babf7f3a7000c8e57e068de01d8d2e',
  python: '3.13.18',
  wheel: 'workswarm-0.2.9-py3-none-any.whl',
  pyprojectSha256: '5d8b71d1fb32c6b7b2112677164c0984f268d0ed4b33307a998367f96d18e787',
  wheelSha256: '241ed07f9a23f989984b68474e2b5147ad6907323c92fb8d139be8da6705130f',
  lockSha256: '5db141a6503cc93fa27d6defc3a97aed121e3fbc65ea2d395789956680f48c6e',
  sourceSha256: '670e84322d2296672edfa1edb34d580051484958e1fda31f841dcd4963e83e94',
});
export const workswarmReleases = new Map([[workswarmRelease.version, workswarmRelease]]);
export const workswarmLaunch = {
  args: ['-m', 'agent_gateway.channel_manager.protocol.acp.acp_connect',
    '--gateway-url', 'ws://127.0.0.1:{port:gateway}/acp'],
  mcp: 'http', access: 'native', untrustedCheckout: true, env: {}, answers: {},
  sidecars: [
    { name: 'agent-server', args: ['-m', 'jiuwenswarm.server.app_agentserver', '--dotenv', '{state}/data/config/.env'],
      healthPath: '/', healthTransport: 'websocket' },
    { name: 'gateway', args: ['-m', 'agent_gateway.app_gateway', '--dotenv', '{state}/data/config/.env'],
      healthPath: '/acp', healthTransport: 'websocket' },
  ],
};

export const AGENT_PRODUCT_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'claude_code',
    name: 'Claude Code',
    kind: 'cli',
    installKind: 'npm_claude_code',
    defaultVersion: '2.1.319',
    allowCustomVersion: true,
    supportsLocalModelConfig: true,
    compatibility: Object.freeze({
      cli: 'claude_code',
      min: '2.1.0',
      maxExclusive: '3.0.0',
      range: '>=2.1.0 <3.0.0',
      tested: '2.1.319',
    }),
    runtimes: Object.freeze({ node: BUNDLED_NODE_VERSION }),
  }),
  Object.freeze({
    id: 'codex',
    name: 'Codex',
    kind: 'cli',
    installKind: 'github_codex',
    defaultVersion: '0.166.0',
    allowCustomVersion: true,
    supportsLocalModelConfig: true,
    compatibility: Object.freeze({
      cli: 'codex',
      min: '0.166.0',
      maxExclusive: '1.0.0',
      range: '>=0.166.0 <1.0.0',
      tested: '0.166.0',
    }),
    runtimes: Object.freeze({}),
  }),
  Object.freeze({
    id: icodeProductId,
    name: 'iCode',
    kind: 'acp',
    installKind: 'github_icode_offline',
    defaultVersion: icodeTestedVersion,
    allowCustomVersion: false,
    supportsLocalModelConfig: false,
    compatibility: null,
    runtimes: Object.freeze({}),
  }),
  Object.freeze({
    id: workswarmProductId,
    name: 'WorkSwarm',
    kind: 'acp',
    installKind: 'github_workswarm_uv',
    defaultVersion: workswarmRelease.version,
    allowCustomVersion: false,
    supportsLocalModelConfig: false,
    compatibility: null,
    runtimes: Object.freeze({ uv: BUNDLED_UV_RELEASE.version, python: workswarmRelease.python }),
  }),
]);

export const AGENT_PRODUCT_MAP = new Map(AGENT_PRODUCT_REGISTRY.map(entry => [entry.id, entry]));
export const AGENT_TOOL_PRODUCTS = Object.freeze(AGENT_PRODUCT_REGISTRY.map(entry => entry.id));
export const AGENT_TOOL_CLIS = Object.freeze(AGENT_PRODUCT_REGISTRY.filter(entry => entry.kind === 'cli').map(entry => entry.id));
export const AGENT_TOOL_ACP_PRODUCTS = Object.freeze(AGENT_PRODUCT_REGISTRY.filter(entry => entry.kind === 'acp').map(entry => entry.id));

export const COMPATIBLE_CLI_RANGES = Object.freeze(
  Object.fromEntries(
    AGENT_PRODUCT_REGISTRY
      .filter(entry => entry.kind === 'cli' && entry.compatibility)
      .map(entry => [entry.id, entry.compatibility]),
  ),
);

export function supportedProductVersions(id, arch = process.arch) {
  if (id === icodeProductId) {
    return [...icodeReleases.values()]
      .filter(release => Object.hasOwn(release.sha256, arch))
      .map(release => release.version);
  }
  if (id === workswarmProductId) {
    return [...workswarmReleases.keys()];
  }
  const entry = AGENT_PRODUCT_MAP.get(id);
  return entry ? [entry.defaultVersion] : [];
}
