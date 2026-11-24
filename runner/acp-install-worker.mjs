import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  acpProductId,
  acpVersion,
  icodeProductId,
  readAcpProduct,
  validateAcpLaunch,
  workswarmLaunch,
  workswarmProductId,
  workswarmRelease,
} from './acp-products.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Hash and copy the exact files uv receives, rejecting links and special files.
export function stageAcpSource(source, target) {
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

// Builds the pinned WorkSwarm release from its verified source into a private uv environment. iCode installs from its
// offline archive instead (scripts/install-acp-product.mjs); no other ACP product is installed (#1339).
export function buildWorkSwarmProduct({
  root = '/opt/agent-tools',
  product,
  version,
  sourceDir,
  pythonExecutable,
  uvExecutable = 'uv',
  offline = false,
}) {
  if (!acpProductId.test(product ?? '') || !acpVersion.test(version ?? '')) {
    throw new Error('invalid_acp_product_args');
  }
  if (product === icodeProductId) throw new Error('icode_offline_archive_required');
  if (product !== workswarmProductId) throw new Error('acp_product_unsupported');
  if (version !== workswarmRelease.version || process.platform !== 'linux') throw new Error('workswarm_release_unsupported');
  const preset = {
    python: workswarmRelease.python,
    lock: 'uv.lock',
    source: 'https://github.com/openJiuwen-ai/jiuwenswarm/commit/' + workswarmRelease.commit,
    sourceSha256: workswarmRelease.sourceSha256,
  };
  const launch = validateAcpLaunch(workswarmLaunch);

  const rootReal = realpathSync(root);
  const parent = join(rootReal, 'acp', product);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  if (realpathSync(parent) !== parent) throw new Error('invalid_acp_product_directory');
  const versionDir = join(parent, version);
  const manifestFile = join(versionDir, 'manifest.json');
  const source = realpathSync(sourceDir);
  if (versionDir === source || versionDir.startsWith(source + '/')) {
    throw new Error('acp_source_contains_install_directory');
  }

  if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true });
  mkdirSync(versionDir, { mode: 0o755 });
  const project = join(versionDir, 'source');
  const venv = join(versionDir, 'venv');
  const scratch = join(versionDir, '.install');
  try {
    const sourceSha256 = stageAcpSource(source, project);
    if (sourceSha256 !== preset.sourceSha256) throw new Error('acp_source_hash_mismatch');
    mkdirSync(scratch, { mode: 0o700 });
    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: scratch,
      TMPDIR: scratch,
      UV_CACHE_DIR: join(scratch, 'cache'),
      UV_PYTHON_INSTALL_DIR: join(versionDir, 'python'),
      UV_PROJECT_ENVIRONMENT: venv,
      UV_LINK_MODE: 'copy',
      UV_NO_PROGRESS: '1',
      ...(offline ? { UV_OFFLINE: '1' } : {}),
    };
    const uv = (...command) => execFileSync(uvExecutable, command, { env, cwd: project, stdio: 'inherit' });
    const interpreter = pythonExecutable ? realpathSync(pythonExecutable) : undefined;
    const python = interpreter ?? preset.python;
    const pythonMode = interpreter ? '--no-managed-python' : '--managed-python';
    if (!interpreter) {
      const catalog = execFileSync(uvExecutable, ['python', 'list', '--only-downloads', python], { env, cwd: project, encoding: 'utf8' });
      if (!catalog.trim()) {
        throw new Error(`workswarm_python_unavailable: This uv catalog does not provide CPython ${python} for this platform. Use a uv build that lists it (verified with uv 0.13.9), or pass --python-executable for an existing CPython ${python}.`);
      }
      uv('python', 'install', '--no-bin', preset.python);
    }
    uv('venv', pythonMode, '--no-python-downloads', '--python', python, venv);
    const dependencies = execFileSync(uvExecutable, ['export', '--frozen', '--no-dev', '--no-emit-project',
      '--no-annotate', '--no-header', '--format', 'requirements.txt'], { env, cwd: project, encoding: 'utf8' });
    const wheel = pathToFileURL(join(project, workswarmRelease.wheel));
    const requirements = join(scratch, 'requirements.txt');
    writeFileSync(requirements, dependencies + '\nworkswarm @ ' + wheel + ' --hash=sha256:' + workswarmRelease.wheelSha256 + '\n');
    // The upstream lock includes source-only dependencies (e.g. jieba), so this runs inside the isolated installer container.
    uv('pip', 'sync', '--no-config', '--require-hashes', '--python', join(venv, 'bin', 'python'), requirements);
    execFileSync(join(venv, 'bin', 'python'), ['-c',
      'from importlib.metadata import version; import sys; assert version("workswarm") == sys.argv[1]', version], { env, cwd: project });
    execFileSync(join(venv, 'bin', 'python'), ['-c', `import sys; assert sys.version.split()[0] == ${JSON.stringify(preset.python)}`], { env, cwd: project });
    const manifest = {
      schema: 'bot.acp-product/1',
      id: product,
      version,
      python: preset.python,
      ...(interpreter ? { interpreter } : {}),
      source: preset.source,
      sourceSha256,
      lockSha256: hash(readFileSync(join(project, preset.lock))),
      launch,
    };
    rmSync(scratch, { recursive: true, force: true });
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
    return readAcpProduct(rootReal, product, version);
  } catch (error) {
    rmSync(versionDir, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string', default: '/opt/agent-tools' },
      product: { type: 'string' },
      version: { type: 'string' },
      'source-dir': { type: 'string' },
      'uv-bin': { type: 'string', default: 'uv' },
      'python-executable': { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  buildWorkSwarmProduct({
    root: values.root,
    product: values.product,
    version: values.version,
    sourceDir: values['source-dir'],
    uvExecutable: values['uv-bin'],
    pythonExecutable: values['python-executable'],
    offline: Boolean(values.offline),
  });
}
