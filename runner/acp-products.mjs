import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export const acpProductId = /^[a-z][a-z0-9_-]{0,31}$/;
export const acpVersion = /^[0-9][a-zA-Z0-9._+-]{0,63}$/;
const hash = /^[a-f0-9]{64}$/;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateAcpLaunch(launch) {
  if (!object(launch) || !strings(launch.args) || !['http', 'stdio'].includes(launch.mcp) ||
      !['full', 'native'].includes(launch.access) || typeof launch.untrustedCheckout !== 'boolean' ||
      !object(launch.env) || Object.entries(launch.env).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') ||
      !object(launch.answers) || Object.keys(launch.answers).some(method => !/^_[\w-]+\/[\w/-]+$/.test(method)) ||
      !Array.isArray(launch.sidecars) || launch.sidecars.some(sidecar => !object(sidecar) ||
        !acpProductId.test(sidecar.name ?? '') || !strings(sidecar.args) ||
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
      !hash.test(manifest.sourceSha256 ?? '') || !hash.test(manifest.lockSha256 ?? '')) throw new Error('invalid_acp_product_manifest');
  validateAcpLaunch(manifest.launch);
  const executable = join(directory, 'venv', 'bin', 'python');
  const target = realpathSync(executable);
  const fromVersion = relative(directory, target);
  const outside = isAbsolute(fromVersion) || fromVersion.startsWith('..' + sep) || fromVersion === '..';
  if ((outside && target !== manifest.interpreter) || !statSync(target).isFile()) {
    throw new Error('invalid_acp_product_executable');
  }
  return manifest;
}
