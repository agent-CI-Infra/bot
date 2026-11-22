import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { icodeReleases, icodeTestedVersion as version } from '../../runner/acp-products.mjs';

export function writeICodeProduct(root, executable = '#!/bin/sh\nexit 0\n', launch = {}) {
  const product = join(root, 'acp', 'icode');
  const directory = join(product, version);
  const manifest = {
    schema: 'bot.acp-product/1', id: 'icode', version, distribution: 'linux-offline',
    sourceSha256: icodeReleases.get(version).sha256[process.arch],
    launch: { args: ['acp'], mcp: 'http', access: 'native', untrustedCheckout: true, env: {}, answers: {}, sidecars: [], ...launch },
  };
  mkdirSync(join(directory, 'bin'), { recursive: true });
  writeFileSync(join(directory, 'bin', 'icode'), executable, { mode: 0o755 });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(product, 'selected'), version + '\n');
  return { product, directory, manifest };
}
