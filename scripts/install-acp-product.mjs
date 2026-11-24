import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { acpProductExecutable, acpVersion, icodeProductId, icodeReleases, readAcpProduct, workswarmProductId } from '../runner/acp-products.mjs';
import { icodeLaunch } from '../runner/agent-products.mjs';
import { buildWorkSwarmProduct } from '../runner/acp-install-worker.mjs';

const [action, ...args] = process.argv.slice(2);
const { values: options } = parseArgs({ args, options: {
  root: { type: 'string', default: '/opt/agent-tools' },
  product: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' },
  archive: { type: 'string' }, 'python-executable': { type: 'string' },
  'uv-bin': { type: 'string' }, offline: { type: 'boolean' },
} });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (!['install', 'select', 'remove'].includes(action) || !options.product || !acpVersion.test(options.version ?? '')) {
  throw new Error('Expected install, select or remove with --product and --version.');
}
// Only the iCode and WorkSwarm backends run ACP products (#1339).
if (![icodeProductId, workswarmProductId].includes(options.product)) throw new Error('acp_product_unsupported');

const parent = join(realpathSync(options.root), 'acp', options.product);
mkdirSync(parent, { recursive: true, mode: 0o755 });
if (realpathSync(parent) !== parent) throw new Error('invalid_acp_product_directory');
const versionDir = join(parent, options.version);
const manifestFile = join(versionDir, 'manifest.json');
const lockDir = join(parent, '.install-lock');
mkdirSync(lockDir, { mode: 0o700 });

function useVersion() {
  readAcpProduct(options.root, options.product, options.version);
  const temporary = join(parent, `.selected-${randomUUID()}`);
  writeFileSync(temporary, options.version + '\n', { mode: 0o644, flag: 'wx' });
  renameSync(temporary, join(parent, 'selected'));
}

function install() {
  if (options.archive) return installICode();
  buildWorkSwarmProduct({
    root: options.root,
    product: options.product,
    version: options.version,
    sourceDir: options.source,
    pythonExecutable: options['python-executable'],
    uvExecutable: options['uv-bin'] || 'uv',
    offline: Boolean(options.offline),
  });
  useVersion();
}

function installICode() {
  const release = icodeReleases.get(options.version);
  const expected = release?.sha256[process.arch];
  if (options.product !== icodeProductId || !expected || process.platform !== 'linux') {
    throw new Error('icode_release_unsupported');
  }
  const archive = readFileSync(options.archive);
  if (hash(archive) !== expected) throw new Error('icode_archive_hash_mismatch');
  mkdirSync(versionDir, { mode: 0o755 });
  try {
    const executable = join(versionDir, acpProductExecutable(icodeProductId));
    mkdirSync(join(versionDir, 'bin'), { mode: 0o755 });
    // Only extract the pinned release's single executable, without applying archive paths or permissions.
    const output = openSync(executable, 'wx', 0o755);
    try {
      execFileSync('tar', ['-xOzf', '-', 'icode'], { input: archive, stdio: ['pipe', output, 'inherit'] });
    } finally {
      closeSync(output);
    }
    const manifest = {
      schema: 'bot.acp-product/1', id: icodeProductId, version: options.version, distribution: 'linux-offline',
      source: 'https://github.com/openJiuwen-ai/iCode/commit/' + release.commit, sourceSha256: expected,
      launch: icodeLaunch,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
    useVersion();
  } catch (error) {
    rmSync(versionDir, { recursive: true, force: true });
    throw error;
  }
}

try {
  if (action === 'install') install();
  else if (action === 'select') useVersion();
  else {
    if (existsSync(join(parent, 'selected')) && readFileSync(join(parent, 'selected'), 'utf8').trim() === options.version) throw new Error('acp_product_version_selected');
    if (realpathSync(versionDir) !== versionDir) throw new Error('invalid_acp_product_directory');
    rmSync(versionDir, { recursive: true });
  }
} finally {
  rmSync(lockDir, { recursive: true });
}
