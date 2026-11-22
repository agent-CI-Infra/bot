import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { acpProductExecutable, acpProductId, acpVersion, icodeProductId, icodeReleases, readAcpProduct, validateAcpLaunch, workswarmLaunch, workswarmProductId, workswarmRelease } from '../runner/acp-products.mjs';

const [action, ...args] = process.argv.slice(2);
const { values: options } = parseArgs({ args, options: {
  root: { type: 'string', default: '/opt/agent-tools' },
  product: { type: 'string' }, version: { type: 'string' }, source: { type: 'string' },
  archive: { type: 'string' }, preset: { type: 'string' }, 'python-executable': { type: 'string' }, offline: { type: 'boolean' },
} });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (action === 'hash-source' && options.source) {
  console.log(stageSource(realpathSync(options.source)));
  process.exit(0);
}
if (!['install', 'select', 'remove'].includes(action) || !acpProductId.test(options.product ?? '') || !acpVersion.test(options.version ?? '')) {
  throw new Error('Expected install, select or remove with --product and --version, or hash-source with --source.');
}

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

// Source acquisition is operator-controlled. Hash and copy the exact files uv receives, rejecting links and special files.
function stageSource(source, target) {
  const digest = createHash('sha256');
  function copy(directory, relative = '') {
    if (target) mkdirSync(join(target, relative), { recursive: true, mode: 0o755 });
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name), name = join(relative, entry.name);
      if (entry.isDirectory()) copy(path, name);
      else if (entry.isFile()) {
        const content = readFileSync(path);
        digest.update(JSON.stringify([name, hash(content)]) + '\n');
        if (target) writeFileSync(join(target, name), content, { mode: 0o644 });
      } else throw new Error(`invalid_acp_source_entry:${name}`);
    }
  }
  copy(source);
  return digest.digest('hex');
}

function install() {
  if (options.archive) return installICode();
  if (options.product === icodeProductId) throw new Error('icode_offline_archive_required');
  const workswarm = options.product === workswarmProductId;
  if (workswarm && (options.version !== workswarmRelease.version || process.platform !== 'linux' || options.preset)) {
    throw new Error('workswarm_release_unsupported');
  }
  const preset = workswarm ? {
    python: workswarmRelease.python, lock: 'uv.lock',
    source: 'https://github.com/openJiuwen-ai/jiuwenswarm/commit/' + workswarmRelease.commit,
    sourceSha256: workswarmRelease.sourceSha256, launch: workswarmLaunch,
  } : JSON.parse(readFileSync(options.preset, 'utf8'));
  const launch = validateAcpLaunch(preset.launch);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(preset.python ?? '') ||
      !['uv.lock', 'requirements.txt'].includes(preset.lock) ||
      typeof preset.source !== 'string' || !preset.source || !/^[a-f0-9]{64}$/.test(preset.sourceSha256 ?? '')) {
    throw new Error('invalid_acp_install_preset');
  }
  const source = realpathSync(options.source);
  if (versionDir === source || versionDir.startsWith(source + '/')) throw new Error('acp_source_contains_install_directory');
  // The venv embeds interpreter paths. Install at the final mount path and publish the manifest only after verification.
  mkdirSync(versionDir, { mode: 0o755 });
  const project = join(versionDir, 'source');
  const venv = join(versionDir, 'venv');
  const scratch = join(versionDir, '.install');
  try {
    const sourceSha256 = stageSource(source, project);
    if (sourceSha256 !== preset.sourceSha256) throw new Error('acp_source_hash_mismatch');
    mkdirSync(scratch, { mode: 0o700 });
    const env = {
      PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: scratch, TMPDIR: scratch,
      UV_CACHE_DIR: join(scratch, 'cache'), UV_PYTHON_INSTALL_DIR: join(versionDir, 'python'),
      UV_PROJECT_ENVIRONMENT: venv, UV_LINK_MODE: 'copy', UV_NO_PROGRESS: '1',
      ...(options.offline ? { UV_OFFLINE: '1' } : {}),
    };
    const uv = (...command) => execFileSync('uv', command, { env, cwd: project, stdio: 'inherit' });
    const interpreter = options['python-executable'] ? realpathSync(options['python-executable']) : undefined;
    const python = interpreter ?? preset.python;
    const pythonMode = interpreter ? '--no-managed-python' : '--managed-python';
    if (!interpreter) {
      if (workswarm) {
        const catalog = execFileSync('uv', ['python', 'list', '--only-downloads', python], { env, cwd: project, encoding: 'utf8' });
        if (!catalog.trim()) {
          throw new Error(`workswarm_python_unavailable: This uv catalog does not provide CPython ${python} for this platform. Use a uv build that lists it (verified with uv 0.13.9), or pass --python-executable for an existing CPython ${python}.`);
        }
      }
      uv('python', 'install', '--no-bin', preset.python);
    }
    uv('venv', pythonMode, '--no-python-downloads', '--python', python, venv);
    if (workswarm) {
      const dependencies = execFileSync('uv', ['export', '--frozen', '--no-dev', '--no-emit-project',
        '--no-annotate', '--no-header', '--format', 'requirements.txt'], { env, cwd: project, encoding: 'utf8' });
      const wheel = pathToFileURL(join(project, workswarmRelease.wheel));
      const requirements = join(scratch, 'requirements.txt');
      writeFileSync(requirements, dependencies + '\nworkswarm @ ' + wheel + ' --hash=sha256:' + workswarmRelease.wheelSha256 + '\n');
      // The upstream lock includes a source-only dependency (jieba).
      uv('pip', 'sync', '--no-config', '--require-hashes', '--python', join(venv, 'bin', 'python'), requirements);
      execFileSync(join(venv, 'bin', 'python'), ['-c',
        'from importlib.metadata import version; import sys; assert version("workswarm") == sys.argv[1]', options.version], { env, cwd: project });
    } else if (preset.lock === 'uv.lock') uv('sync', '--locked', '--no-dev', '--no-editable', pythonMode, '--no-python-downloads', '--python', python);
    else uv('pip', 'sync', '--no-config', '--require-hashes', '--only-binary', ':all:', '--python', join(venv, 'bin', 'python'), 'requirements.txt');
    execFileSync(join(venv, 'bin', 'python'), ['-c', `import sys; assert sys.version.split()[0] == ${JSON.stringify(preset.python)}`], { env, cwd: project });
    const manifest = { schema: 'bot.acp-product/1', id: options.product, version: options.version, python: preset.python,
      ...(interpreter ? { interpreter } : {}), source: preset.source, sourceSha256, lockSha256: hash(readFileSync(join(project, preset.lock))), launch };
    rmSync(scratch, { recursive: true, force: true });
    // The tool volume is writable only to trusted installers and mounted read-only in each project computer.
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  } catch (error) {
    rmSync(versionDir, { recursive: true, force: true });
    throw error;
  }
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
      launch: { args: ['acp', '--approval', 'bypass', '--ask-user-timeout', '5', '--agent', 'Launchpad'],
        mcp: 'http', access: 'native', untrustedCheckout: true, env: {}, answers: {}, sidecars: [] },
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
