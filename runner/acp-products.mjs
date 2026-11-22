import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export const acpProductId = /^[a-z][a-z0-9_-]{0,31}$/;
export const acpVersion = /^[0-9][a-zA-Z0-9._+-]{0,63}$/;
const hash = /^[a-f0-9]{64}$/;

export const icodeProductId = 'icode';
export const icodeTestedVersion = '0.36.0';
export const icodeReleases = new Map([['0.36.0', {
  commit: '78802f87d07f053fe560d680e4696c2bf322e2c2',
  sha256: {
    x64: '3688097aaa6fd2a6eed530e19fb6046a0e6d8d58ace4b07d8490bea18cef2e00',
    arm64: '3212c67b84d58eea1d515ce0b13e73e6efac5fbeb6ed7804ccee13cfc5a7865e',
  },
}]]);

export const workswarmProductId = 'workswarm';
export const workswarmRelease = Object.freeze({
  version: '0.2.9',
  commit: '453dce3054babf7f3a7000c8e57e068de01d8d2e',
  python: '3.13.18',
  wheel: 'workswarm-0.2.9-py3-none-any.whl',
  wheelSha256: '241ed07f9a23f989984b68474e2b5147ad6907323c92fb8d139be8da6705130f',
  lockSha256: '5db141a6503cc93fa27d6defc3a97aed121e3fbc65ea2d395789956680f48c6e',
  sourceSha256: '670e84322d2296672edfa1edb34d580051484958e1fda31f841dcd4963e83e94',
});
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
export const requiresAcpRunHome = id => id === icodeProductId || id === workswarmProductId;

export const acpProductExecutable = id => id === icodeProductId ? 'bin/icode' : 'venv/bin/python';
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateAcpLaunch(launch) {
  if (!object(launch) || !strings(launch.args) || !['http', 'stdio'].includes(launch.mcp) ||
      !['full', 'native'].includes(launch.access) || typeof launch.untrustedCheckout !== 'boolean' ||
      !object(launch.env) || Object.entries(launch.env).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') ||
      !object(launch.answers) || Object.keys(launch.answers).some(method => !/^_[\w-]+\/[\w/-]+$/.test(method)) ||
      !Array.isArray(launch.sidecars) || launch.sidecars.some(sidecar => !object(sidecar) ||
        !acpProductId.test(sidecar.name ?? '') || !strings(sidecar.args) ||
        (sidecar.healthTransport !== undefined && sidecar.healthTransport !== 'websocket') ||
        typeof sidecar.healthPath !== 'string' || !/^\/(?!\/)[\w/.-]*$/.test(sidecar.healthPath)) ||
      new Set(launch.sidecars.map(sidecar => sidecar.name)).size !== launch.sidecars.length) {
    throw new Error('invalid_acp_product_launch');
  }
  return launch;
}

export function readAcpProduct(root, id, selected) {
  if (!acpProductId.test(id)) throw new Error('invalid_acp_product');
  const parent = join(realpathSync(root), 'acp', id);
  const version = selected ?? readFileSync(join(parent, 'selected'), 'utf8').trim();
  if (!acpVersion.test(version)) throw new Error('invalid_acp_product_version');
  const directory = join(parent, version);
  if (realpathSync(directory) !== directory) throw new Error('invalid_acp_product_directory');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'bot.acp-product/1' || manifest.id !== id || manifest.version !== version ||
      !hash.test(manifest.sourceSha256 ?? '')) throw new Error('invalid_acp_product_manifest');
  if (id === icodeProductId) {
    const expected = icodeReleases.get(version)?.sha256[process.arch];
    if (!expected || manifest.distribution !== 'linux-offline' || manifest.sourceSha256 !== expected) {
      throw new Error('icode_release_unsupported');
    }
  } else if (id === workswarmProductId && (version !== workswarmRelease.version ||
      manifest.python !== workswarmRelease.python || manifest.sourceSha256 !== workswarmRelease.sourceSha256 ||
      manifest.lockSha256 !== workswarmRelease.lockSha256)) {
    throw new Error('workswarm_release_unsupported');
  } else if (!hash.test(manifest.lockSha256 ?? '')) {
    throw new Error('invalid_acp_product_manifest');
  }
  validateAcpLaunch(manifest.launch);
  const executable = join(directory, acpProductExecutable(id));
  const target = realpathSync(executable);
  const fromVersion = relative(directory, target);
  const outside = isAbsolute(fromVersion) || fromVersion.startsWith('..' + sep) || fromVersion === '..';
  if ((outside && (id === icodeProductId || target !== manifest.interpreter)) || !statSync(target).isFile()) {
    throw new Error('invalid_acp_product_executable');
  }
  accessSync(target, constants.X_OK);
  return manifest;
}
