import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { TaskError } from '../agent/common.js';
import { extractTarGzAsync, isSubpath } from './tool-archives.js';
import {
  AGENT_PRODUCT_MAP,
  AGENT_PRODUCT_REGISTRY,
  AGENT_TOOL_ACP_PRODUCTS,
  AGENT_TOOL_CLIS,
  AGENT_TOOL_PRODUCTS,
  BUNDLED_NODE_VERSION,
  BUNDLED_UV_RELEASE,
  COMPATIBLE_CLI_RANGES,
  icodeLaunch,
  icodeProductId,
  icodeReleases,
  supportedProductVersions,
  workswarmProductId,
  workswarmReleases,
  type AgentToolAcpProduct,
  type AgentToolArch,
  type AgentToolCli,
  type AgentToolProduct,
  type CliCompatibilityRange,
} from '../../runner/agent-products.mjs';
import {
  acpProductExecutable,
  acpVersion,
  readAcpProduct,
  type AcpProductManifest,
} from '../../runner/acp-products.mjs';
import { stageAcpSource } from '../../runner/acp-install-worker.mjs';

export { extractTarGz, extractTarGzAsync } from './tool-archives.js';
export {
  AGENT_PRODUCT_MAP,
  AGENT_PRODUCT_REGISTRY,
  AGENT_TOOL_ACP_PRODUCTS,
  AGENT_TOOL_CLIS,
  AGENT_TOOL_PRODUCTS,
  BUNDLED_NODE_VERSION,
  BUNDLED_UV_RELEASE,
  COMPATIBLE_CLI_RANGES,
  supportedProductVersions,
  type AgentToolAcpProduct,
  type AgentToolArch,
  type AgentToolCli,
  type AgentToolProduct,
  type CliCompatibilityRange,
};

export type AgentToolLibc = 'glibc' | 'musl';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export const DEFAULT_AGENT_TOOLS_ROOT = '/opt/agent-tools';
export const DEFAULT_CLI_RETAIN_COUNT = 3;
export const CLI_RETAIN_BOUNDS = [1, 10] as const;

const DEFAULT_AUTO_INSTALL_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;

export interface AgentToolArtifact {
  role: 'package' | 'native_binary' | 'node_runtime' | 'static_binary' | 'offline_archive' | 'python_wheel' | 'uv_runtime' | 'source_bundle';
  source_url: string;
  sha256: string;
  bytes: number;
}

export interface AgentToolManifest {
  schema: 'bot.agent-tools/1' | 'bot.acp-product/1';
  cli: AgentToolProduct;
  version: string;
  arch: AgentToolArch;
  libc?: AgentToolLibc;
  installed_at: string;
  container_executable: string;
  container_node_executable: string | null;
  node_version: string | null;
  artifacts: AgentToolArtifact[];
}

export interface NodeRuntimeManifest {
  schema: 'bot.agent-tools-node/1';
  version: string;
  arch: AgentToolArch;
  installed_at: string;
  container_executable: string;
  source_url: string;
  sha256: string;
  bytes: number;
}

export interface UvRuntimeManifest {
  schema: 'bot.agent-tools-uv/1';
  version: string;
  arch: AgentToolArch;
  installed_at: string;
  container_executable: string;
  source_url: string;
  sha256: string;
  bytes: number;
}

export interface ProductVolumeState {
  removed: boolean;
  last_error: string | null;
  last_error_detail: string | null;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  failed_attempts: number;
}

interface VolumeStateFile {
  schema: 'bot.agent-tools-state/1';
  products: Partial<Record<AgentToolProduct, ProductVolumeState>>;
}

export interface SelectedCliVersion {
  cli: AgentToolCli;
  version: string;
  compatible_range: string;
  container_executable: string;
  container_node_executable: string | null;
  node_version: string | null;
  host_executable: string;
  manifest: AgentToolManifest;
}

export interface CliAvailabilityStatus {
  cli: AgentToolProduct;
  name: string;
  kind: 'cli' | 'acp';
  available: boolean;
  default_version: string;
  allow_custom_version: boolean;
  supported_versions: string[];
  compatible_range: string;
  tested_version: string;
  selected_version: string | null;
  container_executable: string | null;
  node_version: string | null;
  compatible_versions: string[];
  incompatible_versions: string[];
  installed_manifests: AgentToolManifest[];
  reason: string | null;
  removed: boolean;
  auto_install_state: 'idle' | 'installing' | 'failed' | 'removed';
  last_error: string | null;
  last_error_detail: string | null;
  last_attempt_at: string | null;
  next_retry_at: string | null;
}

export interface AgentToolsVolumeStatus {
  volume_root: string;
  container_root: string;
  volume_present: boolean;
  arch: AgentToolArch | null;
  node_versions: string[];
  uv_versions: string[];
  auto_install_enabled: boolean;
  clis: Record<AgentToolProduct, CliAvailabilityStatus>;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export function isAgentToolProduct(value: unknown): value is AgentToolProduct {
  return typeof value === 'string' && AGENT_PRODUCT_MAP.has(value);
}

export function isAgentToolCli(value: unknown): value is AgentToolCli {
  return typeof value === 'string' && (AGENT_TOOL_CLIS as readonly string[]).includes(value);
}

export function isAutoInstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BOT_AGENT_TOOLS_AUTO_INSTALL;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function parseSemver(value: unknown): Semver | null {
  if (typeof value !== 'string') return null;
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, raw: `${major}.${minor}.${patch}` };
}

export function compareSemver(a: string | Semver, b: string | Semver): number {
  const va = typeof a === 'string' ? parseSemver(a) : a;
  const vb = typeof b === 'string' ? parseSemver(b) : b;
  if (!va || !vb) throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_semver');
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

export function satisfiesCliRange(cli: AgentToolCli, version: string): boolean {
  const range = COMPATIBLE_CLI_RANGES[cli];
  if (!range) return false;
  const parsed = parseSemver(version);
  if (!parsed) return false;
  return compareSemver(parsed, range.min) >= 0 && compareSemver(parsed, range.maxExclusive) < 0;
}

export function satisfiesProductVersion(product: AgentToolProduct, version: string, arch: AgentToolArch = resolveSupportedArch() ?? 'x64'): boolean {
  if (isAgentToolCli(product)) return satisfiesCliRange(product, version);
  return supportedProductVersions(product, arch).includes(version);
}

export function resolveSupportedArch(arch = process.arch): AgentToolArch | null {
  if (arch === 'x64' || arch === 'arm64') return arch;
  return null;
}

export function detectElfInterpreterLibc(execPath: string): AgentToolLibc | null {
  let fd: number | null = null;
  try {
    fd = openSync(execPath, 'r');
    const hdr = Buffer.alloc(64);
    if (readSync(fd, hdr, 0, 64, 0) < 52) return null;
    if (hdr[0] !== 0x7f || hdr[1] !== 0x45 || hdr[2] !== 0x4c || hdr[3] !== 0x46) return null;
    const is64 = hdr[4] === 2;
    const is32 = hdr[4] === 1;
    const isLE = hdr[5] === 1;
    const isBE = hdr[5] === 2;
    if ((!is64 && !is32) || (!isLE && !isBE)) return null;
    if (is64 && hdr.length < 64) return null;

    const u16 = (buf: Buffer, off: number) => (isLE ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
    const u32 = (buf: Buffer, off: number) => (isLE ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
    const u64 = (buf: Buffer, off: number) => Number(isLE ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off));

    const phoff = is64 ? u64(hdr, 32) : u32(hdr, 28);
    const phentsize = u16(hdr, is64 ? 54 : 42);
    const phnum = u16(hdr, is64 ? 56 : 44);
    const minEntSize = is64 ? 56 : 32;
    if (phoff <= 0 || phentsize < minEntSize || phnum <= 0 || phnum > 128) return null;

    const totalBytes = phentsize * phnum;
    const phdrs = Buffer.alloc(totalBytes);
    if (readSync(fd, phdrs, 0, totalBytes, phoff) < totalBytes) return null;
    for (let i = 0; i < phnum; i++) {
      const base = i * phentsize;
      if (u32(phdrs, base) !== 3) continue; // PT_INTERP
      const interpOffset = is64 ? u64(phdrs, base + 8) : u32(phdrs, base + 4);
      const interpFilesz = is64 ? u64(phdrs, base + 32) : u32(phdrs, base + 16);
      if (interpOffset <= 0 || interpFilesz <= 0 || interpFilesz > 4096) return null;
      const interpBuf = Buffer.alloc(interpFilesz);
      if (readSync(fd, interpBuf, 0, interpFilesz, interpOffset) < interpFilesz) return null;
      const interp = interpBuf.toString('utf8').replace(/\0+.*$/s, '');
      if (interp.includes('musl')) return 'musl';
      if (interp.includes('ld-linux') || interp.includes('ld.so')) return 'glibc';
      return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
  return null;
}

let cachedHostLibc: AgentToolLibc | null = null;

export function detectHostLibc(): AgentToolLibc {
  if (cachedHostLibc) return cachedHostLibc;
  if (process.platform === 'linux') {
    const fromElf = detectElfInterpreterLibc(process.execPath);
    if (fromElf) {
      cachedHostLibc = fromElf;
      return fromElf;
    }
    try {
      const maps = readFileSync('/proc/self/maps', 'utf8');
      if (maps.includes('ld-musl-')) {
        cachedHostLibc = 'musl';
        return 'musl';
      }
    } catch {}
  }
  cachedHostLibc = 'glibc';
  return 'glibc';
}

function emptyProductState(): ProductVolumeState {
  return {
    removed: false,
    last_error: null,
    last_error_detail: null,
    last_attempt_at: null,
    next_retry_at: null,
    failed_attempts: 0,
  };
}

function readVolumeState(rootReal: string): VolumeStateFile {
  const statePath = resolve(rootReal, '.state.json');
  try {
    const st = lstatSync(statePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 128 * 1024) return { schema: 'bot.agent-tools-state/1', products: {} };
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (parsed?.schema !== 'bot.agent-tools-state/1' || !parsed.products || typeof parsed.products !== 'object') {
      return { schema: 'bot.agent-tools-state/1', products: {} };
    }
    return { schema: 'bot.agent-tools-state/1', products: parsed.products };
  } catch {
    return { schema: 'bot.agent-tools-state/1', products: {} };
  }
}

function productStateOf(volumeState: VolumeStateFile, product: AgentToolProduct): ProductVolumeState {
  const raw = volumeState.products[product];
  if (!raw || typeof raw !== 'object') return emptyProductState();
  return {
    removed: raw.removed === true,
    last_error: typeof raw.last_error === 'string' ? raw.last_error : null,
    last_error_detail: typeof raw.last_error_detail === 'string' ? raw.last_error_detail : null,
    last_attempt_at: typeof raw.last_attempt_at === 'string' ? raw.last_attempt_at : null,
    next_retry_at: typeof raw.next_retry_at === 'string' ? raw.next_retry_at : null,
    failed_attempts: Number.isSafeInteger(raw.failed_attempts) && raw.failed_attempts >= 0 ? raw.failed_attempts : 0,
  };
}

function writeVolumeState(rootReal: string, state: VolumeStateFile): void {
  const statePath = resolve(rootReal, '.state.json');
  const tmpPath = resolve(rootReal, `.state.json.tmp.${randomBytes(6).toString('hex')}`);
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
  chmodSync(tmpPath, 0o644);
  renameSync(tmpPath, statePath);
}

function verifySafeExecutable(rootReal: string, filePath: string): boolean {
  try {
    const st = lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    const real = realpathSync(filePath);
    if (!isSubpath(rootReal, real)) return false;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function brokenManifestNodeVersion(rootReal: string, version: string): string | null {
  try {
    const raw = readFileSync(resolve(rootReal, 'claude_code', version, 'manifest.json'), 'utf8');
    const named = /"node_version"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ?? null;
    return named && parseSemver(named) ? named : null;
  } catch { return null; }
}

function inferClaudeNativeBinaryLibc(artifacts: AgentToolArtifact[]): AgentToolLibc | null {
  for (const art of artifacts) {
    if (art.role !== 'native_binary') continue;
    const m = /claude-code-linux-(?:x64|arm64)(-musl)?(?:\/|-)/.exec(art.source_url);
    if (m) return m[1] ? 'musl' : 'glibc';
  }
  return null;
}

function readValidCliManifest(
  rootReal: string,
  cli: AgentToolCli,
  version: string,
  arch: AgentToolArch,
  containerRoot: string,
  libc: AgentToolLibc = detectHostLibc(),
): AgentToolManifest | null {
  if (!parseSemver(version)) return null;
  const versionDir = resolve(rootReal, cli, version);
  const manifestPath = resolve(versionDir, 'manifest.json');
  try {
    const dirStat = lstatSync(versionDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    if (!isSubpath(rootReal, realpathSync(versionDir))) return null;
    const mst = lstatSync(manifestPath);
    if (!mst.isFile() || mst.isSymbolicLink() || mst.size > 64 * 1024) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.schema !== 'bot.agent-tools/1' || parsed.cli !== cli || parsed.version !== version || parsed.arch !== arch) return null;
    if (parsed.libc !== undefined && parsed.libc !== 'glibc' && parsed.libc !== 'musl') return null;
    if (typeof parsed.installed_at !== 'string' || !parsed.installed_at) return null;
    const expectedExec = posix.join(containerRoot, cli, version, 'bin', cli === 'claude_code' ? 'claude' : 'codex');
    if (parsed.container_executable !== expectedExec) return null;
    const hostExec = resolve(versionDir, 'bin', cli === 'claude_code' ? 'claude' : 'codex');
    if (!verifySafeExecutable(rootReal, hostExec)) return null;

    if (cli === 'claude_code') {
      if (typeof parsed.node_version !== 'string' || !parseSemver(parsed.node_version)) return null;
      const expectedNodeExec = posix.join(containerRoot, 'node', parsed.node_version, 'bin', 'node');
      if (parsed.container_node_executable !== expectedNodeExec) return null;
      const hostNodeExec = resolve(rootReal, 'node', parsed.node_version, 'bin', 'node');
      if (!verifySafeExecutable(rootReal, hostNodeExec)) return null;
    } else if (parsed.node_version !== null || parsed.container_node_executable !== null) {
      return null;
    }

    if (!Array.isArray(parsed.artifacts) || !parsed.artifacts.length) return null;
    for (const art of parsed.artifacts) {
      if (!art || typeof art !== 'object') return null;
      if (!['package', 'native_binary', 'node_runtime', 'static_binary'].includes(art.role)) return null;
      if (typeof art.source_url !== 'string' || !art.source_url || !SHA256_RE.test(String(art.sha256 || ''))) return null;
      if (!Number.isSafeInteger(art.bytes) || art.bytes <= 0) return null;
    }
    if (cli === 'claude_code') {
      const effectiveLibc = (parsed.libc as AgentToolLibc | undefined) ?? inferClaudeNativeBinaryLibc(parsed.artifacts as AgentToolArtifact[]);
      if (effectiveLibc && effectiveLibc !== libc) return null;
    }
    return parsed as AgentToolManifest;
  } catch {
    return null;
  }
}

function acpManifestToView(manifest: AcpProductManifest, product: AgentToolAcpProduct, arch: AgentToolArch, containerRoot: string, versionDir: string): AgentToolManifest {
  let installedAt = '';
  try {
    installedAt = typeof (manifest as any).installed_at === 'string' && (manifest as any).installed_at
      ? (manifest as any).installed_at
      : lstatSync(join(versionDir, 'manifest.json')).mtime.toISOString();
  } catch {
    installedAt = '';
  }
  const artifacts: AgentToolArtifact[] = [];
  if (Array.isArray((manifest as any).artifacts) && (manifest as any).artifacts.length) {
    for (const art of (manifest as any).artifacts) {
      artifacts.push({
        role: art.role ?? 'source_bundle',
        source_url: String(art.source_url ?? manifest.source),
        sha256: String(art.sha256 ?? manifest.sourceSha256),
        bytes: Number(art.bytes ?? 0),
      });
    }
  } else {
    artifacts.push({
      role: product === icodeProductId ? 'offline_archive' : 'source_bundle',
      source_url: manifest.source,
      sha256: manifest.sourceSha256,
      bytes: 0,
    });
    if (manifest.lockSha256) {
      artifacts.push({
        role: 'python_wheel',
        source_url: `${manifest.source} (uv.lock)`,
        sha256: manifest.lockSha256,
        bytes: 0,
      });
    }
  }
  return {
    schema: 'bot.acp-product/1',
    cli: product,
    version: manifest.version,
    arch,
    installed_at: installedAt,
    container_executable: posix.join(containerRoot, 'acp', product, manifest.version, acpProductExecutable(product)),
    container_node_executable: null,
    node_version: null,
    artifacts,
  };
}

function listValidNodeVersions(rootReal: string, arch: AgentToolArch): string[] {
  const nodeRoot = resolve(rootReal, 'node');
  if (!existsSync(nodeRoot)) return [];
  let entries: string[];
  try {
    const st = lstatSync(nodeRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
    entries = readdirSync(nodeRoot);
  } catch {
    return [];
  }
  const valid: string[] = [];
  for (const name of entries) {
    if (!parseSemver(name)) continue;
    const dir = resolve(nodeRoot, name);
    const manifestPath = resolve(dir, 'manifest.json');
    const binPath = resolve(dir, 'bin', 'node');
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (m?.schema === 'bot.agent-tools-node/1' && m.version === name && m.arch === arch && SHA256_RE.test(m.sha256) && verifySafeExecutable(rootReal, binPath)) {
        valid.push(name);
      }
    } catch {}
  }
  return valid.sort((a, b) => compareSemver(b, a));
}

function listValidUvVersions(rootReal: string, arch: AgentToolArch): string[] {
  const uvRoot = resolve(rootReal, 'uv');
  if (!existsSync(uvRoot)) return [];
  let entries: string[];
  try {
    const st = lstatSync(uvRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
    entries = readdirSync(uvRoot);
  } catch {
    return [];
  }
  const valid: string[] = [];
  for (const name of entries) {
    if (!parseSemver(name)) continue;
    const dir = resolve(uvRoot, name);
    const manifestPath = resolve(dir, 'manifest.json');
    const binPath = resolve(dir, 'bin', 'uv');
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (m?.schema === 'bot.agent-tools-uv/1' && m.version === name && m.arch === arch && SHA256_RE.test(m.sha256) && verifySafeExecutable(rootReal, binPath)) {
        valid.push(name);
      }
    } catch {}
  }
  return valid.sort((a, b) => compareSemver(b, a));
}

function autoStateFields(
  state: ProductVolumeState,
  installing: boolean,
): Pick<CliAvailabilityStatus, 'removed' | 'auto_install_state' | 'last_error' | 'last_error_detail' | 'last_attempt_at' | 'next_retry_at'> {
  return {
    removed: state.removed,
    auto_install_state: installing ? 'installing' : state.removed ? 'removed' : state.last_error ? 'failed' : 'idle',
    last_error: state.last_error,
    last_error_detail: state.last_error_detail,
    last_attempt_at: state.last_attempt_at,
    next_retry_at: state.next_retry_at,
  };
}

function inspectAcpProductAvailability(
  volumeRoot: string,
  product: AgentToolAcpProduct,
  options: { containerRoot?: string; arch?: AgentToolArch | null; installing?: boolean } = {},
): CliAvailabilityStatus {
  const entry = AGENT_PRODUCT_MAP.get(product)!;
  const containerRoot = options.containerRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
  const arch = options.arch === undefined ? resolveSupportedArch() : options.arch;
  const supported = arch ? supportedProductVersions(product, arch) : [];
  const base: CliAvailabilityStatus = {
    cli: product,
    name: entry.name,
    kind: 'acp',
    available: false,
    default_version: entry.defaultVersion,
    allow_custom_version: entry.allowCustomVersion,
    supported_versions: supported,
    compatible_range: supported.join('、') || entry.defaultVersion,
    tested_version: entry.defaultVersion,
    selected_version: null,
    container_executable: null,
    node_version: null,
    compatible_versions: [],
    incompatible_versions: [],
    installed_manifests: [],
    reason: null,
    ...autoStateFields(emptyProductState(), Boolean(options.installing)),
  };
  if (!arch) return { ...base, reason: 'platform_arch_unsupported' };
  if (!volumeRoot || !isAbsolute(volumeRoot) || !existsSync(volumeRoot)) {
    return { ...base, reason: 'agent_tools_volume_missing' };
  }
  let rootReal: string;
  try {
    const st = lstatSync(volumeRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) return { ...base, reason: 'agent_tools_volume_missing' };
    rootReal = realpathSync(volumeRoot);
  } catch {
    return { ...base, reason: 'agent_tools_volume_missing' };
  }
  const volumeState = readVolumeState(rootReal);
  const pState = productStateOf(volumeState, product);
  const stateFields = autoStateFields(pState, Boolean(options.installing));

  if (!supported.length) {
    return { ...base, ...stateFields, reason: product === icodeProductId ? 'icode_arch_unsupported' : 'platform_arch_unsupported' };
  }

  const parent = join(rootReal, 'acp', product);
  const manifests: AgentToolManifest[] = [];
  if (existsSync(parent)) {
    try {
      const pst = lstatSync(parent);
      if (pst.isDirectory() && !pst.isSymbolicLink()) {
        for (const name of readdirSync(parent)) {
          if (!acpVersion.test(name)) continue;
          try {
            const raw = readAcpProduct(rootReal, product, name);
            manifests.push(acpManifestToView(raw, product, arch, containerRoot, join(parent, name)));
          } catch {}
        }
      }
    } catch {}
  }
  manifests.sort((a, b) => {
    const pa = parseSemver(a.version), pb = parseSemver(b.version);
    if (pa && pb) return compareSemver(pb, pa);
    return b.version.localeCompare(a.version);
  });

  let selected: AgentToolManifest | null = null;
  let reason: string | null = null;
  try {
    const selRaw = readAcpProduct(rootReal, product);
    selected = manifests.find(m => m.version === selRaw.version) ?? acpManifestToView(selRaw, product, arch, containerRoot, join(parent, selRaw.version));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    if (code === 'ENOENT' && !existsSync(join(parent, 'selected'))) {
      reason = manifests.length ? 'acp_product_not_selected' : 'acp_product_not_installed';
    } else {
      reason = 'acp_product_invalid';
    }
  }

  const versions = manifests.map(m => m.version);
  return {
    ...base,
    ...stateFields,
    available: Boolean(selected),
    selected_version: selected?.version ?? null,
    container_executable: selected?.container_executable ?? null,
    compatible_versions: versions,
    incompatible_versions: [],
    installed_manifests: manifests,
    reason: selected ? null : reason,
  };
}

export function inspectCliAvailability(
  volumeRoot: string,
  cli: AgentToolProduct,
  options: { containerRoot?: string; arch?: AgentToolArch | null; libc?: AgentToolLibc; installing?: boolean } = {},
): CliAvailabilityStatus {
  if (!isAgentToolCli(cli)) {
    return inspectAcpProductAvailability(volumeRoot, cli, options);
  }
  const entry = AGENT_PRODUCT_MAP.get(cli)!;
  const range = COMPATIBLE_CLI_RANGES[cli];
  const containerRoot = options.containerRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
  const arch = options.arch === undefined ? resolveSupportedArch() : options.arch;
  const libc = options.libc ?? detectHostLibc();
  const base: CliAvailabilityStatus = {
    cli,
    name: entry.name,
    kind: 'cli',
    available: false,
    default_version: entry.defaultVersion,
    allow_custom_version: entry.allowCustomVersion,
    supported_versions: [entry.defaultVersion],
    compatible_range: range.range,
    tested_version: range.tested,
    selected_version: null,
    container_executable: null,
    node_version: null,
    compatible_versions: [],
    incompatible_versions: [],
    installed_manifests: [],
    reason: null,
    ...autoStateFields(emptyProductState(), Boolean(options.installing)),
  };
  if (!arch) return { ...base, reason: 'platform_arch_unsupported' };
  if (!volumeRoot || !isAbsolute(volumeRoot) || !existsSync(volumeRoot)) {
    return { ...base, reason: 'agent_tools_volume_missing' };
  }
  let rootReal: string;
  try {
    const st = lstatSync(volumeRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) return { ...base, reason: 'agent_tools_volume_missing' };
    rootReal = realpathSync(volumeRoot);
  } catch {
    return { ...base, reason: 'agent_tools_volume_missing' };
  }

  const volumeState = readVolumeState(rootReal);
  const pState = productStateOf(volumeState, cli);
  const stateFields = autoStateFields(pState, Boolean(options.installing));

  const cliDir = resolve(rootReal, cli);
  if (!existsSync(cliDir)) return { ...base, ...stateFields, reason: 'cli_not_installed' };
  let dirEntries: string[];
  try {
    const st = lstatSync(cliDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return { ...base, ...stateFields, reason: 'cli_not_installed' };
    dirEntries = readdirSync(cliDir);
  } catch {
    return { ...base, ...stateFields, reason: 'cli_not_installed' };
  }

  const manifests: AgentToolManifest[] = [];
  for (const entryName of dirEntries) {
    const manifest = readValidCliManifest(rootReal, cli, entryName, arch, containerRoot, libc);
    if (manifest) manifests.push(manifest);
  }
  manifests.sort((a, b) => compareSemver(b.version, a.version));
  if (!manifests.length) return { ...base, ...stateFields, reason: 'cli_not_installed' };

  const compatible = manifests.filter(m => satisfiesCliRange(cli, m.version));
  const incompatible = manifests.filter(m => !satisfiesCliRange(cli, m.version));
  const selected = compatible[0] ?? null;

  return {
    ...base,
    ...stateFields,
    available: Boolean(selected),
    selected_version: selected?.version ?? null,
    container_executable: selected?.container_executable ?? null,
    node_version: selected?.node_version ?? null,
    compatible_versions: compatible.map(m => m.version),
    incompatible_versions: incompatible.map(m => m.version),
    installed_manifests: manifests,
    reason: selected ? null : 'cli_version_incompatible',
  };
}

export function inspectAgentTools(
  volumeRoot = DEFAULT_AGENT_TOOLS_ROOT,
  options: { containerRoot?: string; arch?: AgentToolArch | null; libc?: AgentToolLibc; installing?: ReadonlySet<string>; autoInstallEnabled?: boolean } = {},
): AgentToolsVolumeStatus {
  const containerRoot = options.containerRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
  const arch = options.arch === undefined ? resolveSupportedArch() : options.arch;
  const libc = options.libc ?? detectHostLibc();
  let volumePresent = false;
  let nodeVersions: string[] = [];
  let uvVersions: string[] = [];
  if (volumeRoot && isAbsolute(volumeRoot) && existsSync(volumeRoot)) {
    try {
      const st = lstatSync(volumeRoot);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        volumePresent = true;
        if (arch) {
          const real = realpathSync(volumeRoot);
          nodeVersions = listValidNodeVersions(real, arch);
          uvVersions = listValidUvVersions(real, arch);
        }
      }
    } catch {}
  }
  const clis = Object.fromEntries(
    AGENT_TOOL_PRODUCTS.map(product => [
      product,
      inspectCliAvailability(volumeRoot, product, {
        containerRoot,
        arch,
        libc,
        installing: options.installing?.has(product) ?? false,
      }),
    ]),
  ) as Record<AgentToolProduct, CliAvailabilityStatus>;

  return {
    volume_root: volumeRoot,
    container_root: containerRoot,
    volume_present: volumePresent,
    arch,
    node_versions: nodeVersions,
    uv_versions: uvVersions,
    auto_install_enabled: options.autoInstallEnabled ?? isAutoInstallEnabled(),
    clis,
  };
}

export function selectCompatibleCliVersion(
  volumeRoot: string,
  cli: AgentToolCli,
  options: { containerRoot?: string; arch?: AgentToolArch | null; libc?: AgentToolLibc } = {},
): SelectedCliVersion {
  const status = inspectCliAvailability(volumeRoot, cli, options);
  if (!status.available || !status.selected_version) {
    throw new TaskError(status.reason ?? 'cli_not_installed', 'waiting_configuration', `${cli}: ${status.reason ?? 'unavailable'} (${status.compatible_range})`);
  }
  const manifest = status.installed_manifests.find(m => m.version === status.selected_version)!;
  const rootReal = realpathSync(volumeRoot);
  return {
    cli,
    version: manifest.version,
    compatible_range: status.compatible_range,
    container_executable: manifest.container_executable,
    container_node_executable: manifest.container_node_executable,
    node_version: manifest.node_version,
    host_executable: resolve(rootReal, cli, manifest.version, 'bin', cli === 'claude_code' ? 'claude' : 'codex'),
    manifest,
  };
}

// ---------------------------------------------------------------- Trusted Installer, Remover & Auto-Installer

export interface TrustedToolSources {
  npmRegistryBase: string;
  nodeDistBase: string;
  githubApiBase: string;
  githubDownloadOrigins: string[];
  rawGithubOrigins: string[];
  allowLoopbackHttp?: boolean;
  /** Test-only digest overrides; honored strictly when `allowLoopbackHttp === true`. */
  testDigests?: {
    uv?: Record<string, string>;
    icode?: Record<string, string>;
    workswarm?: Record<string, { pyprojectSha256: string; lockSha256: string; wheelSha256: string; sourceSha256: string }>;
  };
}

export const DEFAULT_TRUSTED_SOURCES: TrustedToolSources = {
  npmRegistryBase: 'https://registry.npmjs.org',
  nodeDistBase: 'https://nodejs.org/dist',
  githubApiBase: 'https://api.github.com',
  githubDownloadOrigins: [
    'https://github.com',
    'https://objects.githubusercontent.com',
    'https://release-assets.githubusercontent.com',
  ],
  rawGithubOrigins: [
    'https://raw.githubusercontent.com',
  ],
};

function verifyDigestHex(actualHex: string, expectedHex: string, label: string): void {
  const a = Buffer.from(actualHex.toLowerCase(), 'utf8');
  const b = Buffer.from(expectedHex.toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TaskError('agent_tool_hash_mismatch', 'failed', `${label}: expected ${expectedHex}, got ${actualHex}`);
  }
}

function verifyNpmIntegrity(bytes: Buffer, integrity: unknown, shasum: unknown): void {
  let checked = false;
  if (typeof shasum === 'string' && /^[a-f0-9]{40}$/i.test(shasum)) {
    const actualSha1 = createHash('sha1').update(bytes).digest('hex');
    verifyDigestHex(actualSha1, shasum, 'npm_shasum');
    checked = true;
  }
  if (typeof integrity === 'string' && integrity.startsWith('sha512-')) {
    const expectedB64 = integrity.slice('sha512-'.length).split(/\s+/)[0]!;
    const actualB64 = createHash('sha512').update(bytes).digest('base64');
    if (actualB64 !== expectedB64) {
      throw new TaskError('agent_tool_hash_mismatch', 'failed', 'npm_integrity_sha512_mismatch');
    }
    checked = true;
  } else if (typeof integrity === 'string' && integrity.startsWith('sha256-')) {
    const expectedB64 = integrity.slice('sha256-'.length).split(/\s+/)[0]!;
    const actualB64 = createHash('sha256').update(bytes).digest('base64');
    if (actualB64 !== expectedB64) {
      throw new TaskError('agent_tool_hash_mismatch', 'failed', 'npm_integrity_sha256_mismatch');
    }
    checked = true;
  }
  if (!checked) {
    throw new TaskError('agent_tool_hash_mismatch', 'failed', 'npm_integrity_missing');
  }
}

function buildClaudeLauncherScript(
  containerRoot: string,
  version: string,
  nodeVersion: string,
  hasNativeBinary: boolean,
  jsEntryRelative: string | null,
): string {
  const nodeBinDir = posix.join(containerRoot, 'node', nodeVersion, 'bin');
  const nodeExec = posix.join(nodeBinDir, 'node');
  const verDir = posix.join(containerRoot, 'claude_code', version);
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `export PATH="${nodeBinDir}:\${PATH:-/usr/bin:/bin}"`,
  ];
  if (hasNativeBinary) {
    lines.push(`exec "${posix.join(verDir, 'native', 'claude')}" "$@"`);
  } else if (jsEntryRelative) {
    lines.push(`exec "${nodeExec}" "${posix.join(verDir, 'package', jsEntryRelative)}" "$@"`);
  } else {
    throw new TaskError('agent_tool_archive_invalid', 'failed', 'claude_code_entrypoint_missing');
  }
  return lines.join('\n') + '\n';
}

export interface AcpIsolatedBuildRequest {
  product: AgentToolAcpProduct;
  version: string;
  sourceDir: string;
  containerSourceDir: string;
  uvBin: string;
  containerUvBin: string;
  offline?: boolean;
}

export interface AgentToolManagerOptions {
  volumeRoot?: string;
  containerRoot?: string;
  arch?: AgentToolArch;
  libc?: AgentToolLibc;
  nodeVersion?: string;
  sources?: Partial<TrustedToolSources>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  protectedVersions?: (cli: AgentToolProduct) => Iterable<string>;
  /** Executes Python/uv ACP product builds (WorkSwarm) inside an isolated installer container. */
  acpBuilder?: (req: AcpIsolatedBuildRequest) => Promise<void>;
  autoInstallEnabled?: boolean;
  autoInstallBackoffMs?: readonly number[];
  clock?: () => number;
}

export class AgentToolManager {
  readonly volumeRoot: string;
  readonly containerRoot: string;
  readonly nodeVersion: string;
  readonly libc: AgentToolLibc;
  private readonly explicitArch?: AgentToolArch;
  private readonly sources: TrustedToolSources;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly protectedVersions?: (cli: AgentToolProduct) => Iterable<string>;
  private readonly acpBuilder?: (req: AcpIsolatedBuildRequest) => Promise<void>;
  private readonly autoInstallEnabled?: boolean;
  private readonly autoInstallBackoffMs: readonly number[];
  private readonly clock: () => number;
  private readonly installing = new Set<AgentToolProduct>();
  private queue: Promise<unknown> = Promise.resolve();
  private activeVersionProvider: (() => Iterable<string>) | null = null;

  constructor(options: AgentToolManagerOptions = {}) {
    this.volumeRoot = options.volumeRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
    this.containerRoot = options.containerRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
    this.nodeVersion = options.nodeVersion ?? BUNDLED_NODE_VERSION;
    this.libc = options.libc ?? detectHostLibc();
    this.explicitArch = options.arch;
    this.sources = {
      ...DEFAULT_TRUSTED_SOURCES,
      ...(options.sources ?? {}),
      githubDownloadOrigins: options.sources?.githubDownloadOrigins ?? DEFAULT_TRUSTED_SOURCES.githubDownloadOrigins,
      rawGithubOrigins: options.sources?.rawGithubOrigins ?? DEFAULT_TRUSTED_SOURCES.rawGithubOrigins,
    };
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.protectedVersions = options.protectedVersions;
    this.acpBuilder = options.acpBuilder;
    this.autoInstallEnabled = options.autoInstallEnabled;
    this.autoInstallBackoffMs = options.autoInstallBackoffMs ?? DEFAULT_AUTO_INSTALL_BACKOFF_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private requireArch(): AgentToolArch {
    const arch = this.explicitArch ?? resolveSupportedArch();
    if (!arch) throw new TaskError('platform_arch_unsupported', 'waiting_configuration', `unsupported arch ${process.arch}`);
    return arch;
  }

  private requireVolumeRoot(): string {
    if (!this.volumeRoot || !isAbsolute(this.volumeRoot)) {
      throw new TaskError('agent_tools_volume_missing', 'waiting_configuration', 'invalid_volume_root');
    }
    const createdRoot = !existsSync(this.volumeRoot);
    mkdirSync(this.volumeRoot, { recursive: true, mode: 0o755 });
    if (createdRoot) chmodSync(this.volumeRoot, 0o755);
    const st = lstatSync(this.volumeRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new TaskError('agent_tools_volume_missing', 'waiting_configuration', 'volume_root_not_directory');
    }
    return realpathSync(this.volumeRoot);
  }

  private updateProductState(rootReal: string, product: AgentToolProduct, updater: (prev: ProductVolumeState) => ProductVolumeState): void {
    const state = readVolumeState(rootReal);
    state.products[product] = updater(productStateOf(state, product));
    writeVolumeState(rootReal, state);
  }

  private assertAllowedOrigin(rawUrl: string, allowedOrigins: string[]): URL {
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch {
      throw new TaskError('agent_tool_download_failed', 'failed', `invalid_url:${rawUrl}`);
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new TaskError('agent_tool_download_failed', 'failed', 'credentials_in_url_forbidden');
    }
    const isLoopbackHttp = this.sources.allowLoopbackHttp === true && parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost');
    if (parsed.protocol !== 'https:' && !isLoopbackHttp) {
      throw new TaskError('agent_tool_download_failed', 'failed', `https_required:${parsed.protocol}`);
    }
    if (!allowedOrigins.some(origin => rawUrl.startsWith(origin.replace(/\/+$/, '') + '/') || parsed.origin === new URL(origin).origin)) {
      throw new TaskError('agent_tool_download_failed', 'failed', `untrusted_source_origin:${parsed.origin}`);
    }
    return parsed;
  }

  private async fetchBytes(rawUrl: string, allowedOrigins: string[], headers: Record<string, string> = {}): Promise<Buffer> {
    let currentUrl = rawUrl;
    for (let hops = 0; hops <= 5; hops++) {
      this.assertAllowedOrigin(currentUrl, allowedOrigins);
      let res: Response;
      try {
        res = await this.fetcher(currentUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'agent-ci-infra-bot-installer/1.0', ...headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err: any) {
        throw new TaskError('agent_tool_download_failed', 'retry_wait', String(err?.message || 'network_error').slice(0, 200));
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc || hops === 5) throw new TaskError('agent_tool_download_failed', 'failed', 'redirect_invalid_or_exceeded');
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }
      if (!res.ok) {
        throw new TaskError('agent_tool_download_failed', res.status >= 500 || res.status === 429 ? 'retry_wait' : 'failed', `HTTP ${res.status} from ${new URL(currentUrl).origin}`);
      }
      if (!res.body) return Buffer.alloc(0);

      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) {
            await reader.cancel().catch(() => {});
            throw new TaskError('agent_tool_download_failed', 'failed', 'artifact_exceeds_size_limit');
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
      return Buffer.concat(chunks);
    }
    throw new TaskError('agent_tool_download_failed', 'failed', 'redirect_limit_exceeded');
  }

  private async fetchJson(url: string, allowedOrigins: string[]): Promise<any> {
    const bytes = await this.fetchBytes(url, allowedOrigins, { Accept: 'application/json' });
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new TaskError('agent_tool_download_failed', 'failed', 'invalid_metadata_json');
    }
  }

  private activeVersions(): Set<string> {
    const active = new Set<string>();
    const provider = this.activeVersionProvider;
    if (!provider) return active;
    for (const version of provider()) {
      if (typeof version === 'string' && version.trim()) active.add(version.trim());
    }
    return active;
  }

  private replaceVersionDir(
    stageDir: string,
    finalDir: string,
    target: { cli: AgentToolProduct | 'node' | 'uv'; version: string; rootReal: string; arch: AgentToolArch },
  ): void {
    const active = this.activeVersions();
    const inUse = target.cli === 'node'
      ? this.activeClaudeDependsOnNode(target.rootReal, active, target.version, target.arch)
      : target.cli === 'uv'
        ? false
        : active.has(target.version);
    if (inUse) throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `${target.cli}@${target.version}`);
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
    renameSync(stageDir, finalDir);
  }

  private existingNodeRuntime(rootReal: string, arch: AgentToolArch, nodeVer: string): NodeRuntimeManifest | null {
    const finalDir = resolve(rootReal, 'node', nodeVer);
    const existingManifestPath = resolve(finalDir, 'manifest.json');
    const existingBinPath = resolve(finalDir, 'bin', 'node');
    if (!existsSync(existingManifestPath) || !verifySafeExecutable(rootReal, existingBinPath)) return null;
    try {
      const existing = JSON.parse(readFileSync(existingManifestPath, 'utf8')) as NodeRuntimeManifest;
      if (existing.schema === 'bot.agent-tools-node/1' && existing.version === nodeVer && existing.arch === arch && SHA256_RE.test(existing.sha256)) return existing;
    } catch {}
    return null;
  }

  private existingUvRuntime(rootReal: string, arch: AgentToolArch, uvVer: string): UvRuntimeManifest | null {
    const finalDir = resolve(rootReal, 'uv', uvVer);
    const existingManifestPath = resolve(finalDir, 'manifest.json');
    const existingBinPath = resolve(finalDir, 'bin', 'uv');
    if (!existsSync(existingManifestPath) || !verifySafeExecutable(rootReal, existingBinPath)) return null;
    try {
      const existing = JSON.parse(readFileSync(existingManifestPath, 'utf8')) as UvRuntimeManifest;
      if (existing.schema === 'bot.agent-tools-uv/1' && existing.version === uvVer && existing.arch === arch && SHA256_RE.test(existing.sha256)) return existing;
    } catch {}
    return null;
  }

  private activeClaudeDependsOnNode(rootReal: string, active: Iterable<string>, nodeVer: string, arch: AgentToolArch): boolean {
    for (const version of active) {
      const manifest = readValidCliManifest(rootReal, 'claude_code', version, arch, this.containerRoot, this.libc);
      const named = manifest?.node_version ?? brokenManifestNodeVersion(rootReal, version);
      if (named === nodeVer) return true;
    }
    return false;
  }

  private async ensureNodeRuntime(rootReal: string, arch: AgentToolArch): Promise<AgentToolArtifact> {
    const nodeVer = parseSemver(this.nodeVersion)?.raw;
    if (!nodeVer) throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_node_version');
    const finalDir = resolve(rootReal, 'node', nodeVer);
    const existing = this.existingNodeRuntime(rootReal, arch, nodeVer);
    if (existing) return { role: 'node_runtime', source_url: existing.source_url, sha256: existing.sha256, bytes: existing.bytes };

    const nodeArch = arch === 'x64' ? 'x64' : 'arm64';
    const archiveName = `node-v${nodeVer}-linux-${nodeArch}.tar.gz`;
    const base = this.sources.nodeDistBase.replace(/\/+$/, '');
    const shasumsUrl = `${base}/v${nodeVer}/SHASUMS256.txt`;
    const tarballUrl = `${base}/v${nodeVer}/${archiveName}`;

    const shasumsText = (await this.fetchBytes(shasumsUrl, [base])).toString('utf8');
    let expectedSha256: string | null = null;
    for (const line of shasumsText.split(/\r?\n/)) {
      const m = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
      if (m && m[2] === archiveName) {
        expectedSha256 = m[1]!;
        break;
      }
    }
    if (!expectedSha256) {
      throw new TaskError('agent_tool_hash_mismatch', 'failed', `shasums_entry_missing:${archiveName}`);
    }

    const archiveBytes = await this.fetchBytes(tarballUrl, [base]);
    const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    verifyDigestHex(actualSha256, expectedSha256, archiveName);

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = resolve(stagingRoot, `node-${nodeVer}-${randomBytes(8).toString('hex')}`);
    try {
      mkdirSync(stageDir, { recursive: true, mode: 0o755 });
      chmodSync(stageDir, 0o755);
      await extractTarGzAsync(archiveBytes, stageDir, {
        stripComponents: 1,
        include: rel => rel === 'bin/node' || rel === 'LICENSE',
      });
      const nodeExec = resolve(stageDir, 'bin', 'node');
      if (!verifySafeExecutable(stageDir, nodeExec)) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', 'node_binary_missing_in_archive');
      }
      const manifest: NodeRuntimeManifest = {
        schema: 'bot.agent-tools-node/1',
        version: nodeVer,
        arch,
        installed_at: new Date().toISOString(),
        container_executable: posix.join(this.containerRoot, 'node', nodeVer, 'bin', 'node'),
        source_url: tarballUrl,
        sha256: actualSha256,
        bytes: archiveBytes.length,
      };
      const manifestPath = resolve(stageDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      chmodSync(manifestPath, 0o644);
      const nodeParent = resolve(rootReal, 'node');
      mkdirSync(nodeParent, { recursive: true, mode: 0o755 });
      chmodSync(nodeParent, 0o755);
      this.replaceVersionDir(stageDir, finalDir, { cli: 'node', version: nodeVer, rootReal, arch });
      return { role: 'node_runtime', source_url: tarballUrl, sha256: actualSha256, bytes: archiveBytes.length };
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private async ensureUvRuntime(rootReal: string, arch: AgentToolArch): Promise<{ hostBin: string; containerBin: string; artifact: AgentToolArtifact }> {
    const uvVer = BUNDLED_UV_RELEASE.version;
    const asset = BUNDLED_UV_RELEASE.assets[arch];
    const finalDir = resolve(rootReal, 'uv', uvVer);
    const existing = this.existingUvRuntime(rootReal, arch, uvVer);
    if (existing) {
      return {
        hostBin: resolve(finalDir, 'bin', 'uv'),
        containerBin: existing.container_executable,
        artifact: { role: 'uv_runtime', source_url: existing.source_url, sha256: existing.sha256, bytes: existing.bytes },
      };
    }

    const primaryOrigin = this.sources.githubDownloadOrigins[0]?.replace(/\/+$/, '');
    if (!primaryOrigin) throw new TaskError('agent_tool_download_failed', 'failed', 'github_download_origin_missing');
    const downloadUrl = `${primaryOrigin}/${BUNDLED_UV_RELEASE.repo}/releases/download/${uvVer}/${asset.name}`;
    const archiveBytes = await this.fetchBytes(downloadUrl, this.sources.githubDownloadOrigins);
    const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    const expectedUvSha = (this.sources.allowLoopbackHttp === true ? this.sources.testDigests?.uv?.[arch] : undefined) ?? asset.sha256;
    verifyDigestHex(actualSha256, expectedUvSha, asset.name);

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o755 });
    const stageDir = resolve(stagingRoot, `uv-${uvVer}-${randomBytes(8).toString('hex')}`);
    try {
      mkdirSync(stageDir, { recursive: true, mode: 0o755 });
      chmodSync(stageDir, 0o755);
      const unpackDir = resolve(stageDir, 'unpacked');
      await extractTarGzAsync(archiveBytes, unpackDir, {
        stripComponents: 0,
        include: rel => rel === asset.entry || rel === 'uv',
      });
      const extracted = existsSync(resolve(unpackDir, asset.entry))
        ? resolve(unpackDir, asset.entry)
        : existsSync(resolve(unpackDir, 'uv'))
          ? resolve(unpackDir, 'uv')
          : null;
      if (!extracted || !lstatSync(extracted).isFile() || lstatSync(extracted).isSymbolicLink()) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', 'uv_binary_missing_in_archive');
      }
      const binDir = resolve(stageDir, 'bin');
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      chmodSync(binDir, 0o755);
      const targetBin = resolve(binDir, 'uv');
      renameSync(extracted, targetBin);
      chmodSync(targetBin, 0o755);
      rmSync(unpackDir, { recursive: true, force: true });

      const containerBin = posix.join(this.containerRoot, 'uv', uvVer, 'bin', 'uv');
      const manifest: UvRuntimeManifest = {
        schema: 'bot.agent-tools-uv/1',
        version: uvVer,
        arch,
        installed_at: new Date().toISOString(),
        container_executable: containerBin,
        source_url: downloadUrl,
        sha256: actualSha256,
        bytes: archiveBytes.length,
      };
      const manifestPath = resolve(stageDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      chmodSync(manifestPath, 0o644);
      const uvParent = resolve(rootReal, 'uv');
      mkdirSync(uvParent, { recursive: true, mode: 0o755 });
      chmodSync(uvParent, 0o755);
      this.replaceVersionDir(stageDir, finalDir, { cli: 'uv', version: uvVer, rootReal, arch });
      return {
        hostBin: resolve(finalDir, 'bin', 'uv'),
        containerBin,
        artifact: { role: 'uv_runtime', source_url: downloadUrl, sha256: actualSha256, bytes: archiveBytes.length },
      };
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private async installClaudeCode(rootReal: string, version: string, arch: AgentToolArch, expectedSha256?: string, expectedNativeSha256?: string): Promise<AgentToolManifest> {
    const nodeArtifact = await this.ensureNodeRuntime(rootReal, arch);
    const npmBase = this.sources.npmRegistryBase.replace(/\/+$/, '');
    const pkgMetaUrl = `${npmBase}/@anthropic-ai%2fclaude-code/${version}`;
    const pkgMeta = await this.fetchJson(pkgMetaUrl, [npmBase]);
    if (pkgMeta?.version !== version || typeof pkgMeta?.dist?.tarball !== 'string') {
      throw new TaskError('agent_tool_download_failed', 'failed', 'npm_package_metadata_invalid');
    }
    const pkgTarballUrl = String(pkgMeta.dist.tarball);
    if (!pkgTarballUrl.startsWith(`${npmBase}/@anthropic-ai/claude-code/-/`)) {
      throw new TaskError('agent_tool_download_failed', 'failed', 'unexpected_npm_tarball_path');
    }
    const pkgBytes = await this.fetchBytes(pkgTarballUrl, [npmBase]);
    verifyNpmIntegrity(pkgBytes, pkgMeta.dist.integrity, pkgMeta.dist.shasum);
    const pkgSha256 = createHash('sha256').update(pkgBytes).digest('hex');
    if (expectedSha256) verifyDigestHex(pkgSha256, expectedSha256, 'claude_code_package');

    const artifacts: AgentToolArtifact[] = [
      nodeArtifact,
      { role: 'package', source_url: pkgTarballUrl, sha256: pkgSha256, bytes: pkgBytes.length },
    ];

    const optionalDeps = (pkgMeta.optionalDependencies && typeof pkgMeta.optionalDependencies === 'object')
      ? pkgMeta.optionalDependencies as Record<string, string>
      : {};
    const glibcPkg = `@anthropic-ai/claude-code-linux-${arch}`;
    const muslPkg = `@anthropic-ai/claude-code-linux-${arch}-musl`;
    const desiredNativePkg = this.libc === 'musl' ? muslPkg : glibcPkg;
    const chosenNativePkg = optionalDeps[desiredNativePkg] ? desiredNativePkg : null;

    let nativeBytes: Buffer | null = null;
    if (chosenNativePkg) {
      const nativeVer = optionalDeps[chosenNativePkg]!;
      if (!parseSemver(nativeVer)) throw new TaskError('agent_tool_download_failed', 'failed', 'invalid_native_dependency_version');
      const encodedName = chosenNativePkg.replaceAll('/', '%2f');
      const nativeMeta = await this.fetchJson(`${npmBase}/${encodedName}/${nativeVer}`, [npmBase]);
      const nativeTarballUrl = String(nativeMeta?.dist?.tarball || '');
      if (!nativeTarballUrl.startsWith(`${npmBase}/${chosenNativePkg}/-/`) && !nativeTarballUrl.startsWith(`${npmBase}/@anthropic-ai/`)) {
        throw new TaskError('agent_tool_download_failed', 'failed', 'unexpected_native_tarball_path');
      }
      nativeBytes = await this.fetchBytes(nativeTarballUrl, [npmBase]);
      verifyNpmIntegrity(nativeBytes, nativeMeta.dist.integrity, nativeMeta.dist.shasum);
      const nativeSha256 = createHash('sha256').update(nativeBytes).digest('hex');
      if (expectedNativeSha256) verifyDigestHex(nativeSha256, expectedNativeSha256, 'claude_code_native_binary');
      artifacts.push({ role: 'native_binary', source_url: nativeTarballUrl, sha256: nativeSha256, bytes: nativeBytes.length });
    } else if (expectedNativeSha256) {
      throw new TaskError('agent_tool_hash_mismatch', 'failed', 'claude_code_native_binary_missing');
    }

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = resolve(stagingRoot, `claude_code-${version}-${randomBytes(8).toString('hex')}`);
    try {
      mkdirSync(stageDir, { recursive: true, mode: 0o755 });
      chmodSync(stageDir, 0o755);
      const pkgDir = resolve(stageDir, 'package');
      await extractTarGzAsync(pkgBytes, pkgDir, { stripComponents: 1 });

      let hasNativeBinary = false;
      if (nativeBytes) {
        const nativeDir = resolve(stageDir, 'native');
        await extractTarGzAsync(nativeBytes, nativeDir, { stripComponents: 1 });
        const nativeBin = resolve(nativeDir, 'claude');
        if (!verifySafeExecutable(stageDir, nativeBin)) {
          throw new TaskError('agent_tool_archive_invalid', 'failed', 'claude_native_binary_missing');
        }
        hasNativeBinary = true;
      }

      const jsCandidates = ['cli.js', 'cli.mjs'];
      const jsEntry = jsCandidates.find(rel => existsSync(resolve(pkgDir, rel)) && lstatSync(resolve(pkgDir, rel)).isFile()) ?? null;

      const binDir = resolve(stageDir, 'bin');
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      chmodSync(binDir, 0o755);
      const launcher = buildClaudeLauncherScript(this.containerRoot, version, this.nodeVersion, hasNativeBinary, jsEntry);
      const launcherPath = resolve(binDir, 'claude');
      writeFileSync(launcherPath, launcher, { mode: 0o755 });
      chmodSync(launcherPath, 0o755);

      const manifest: AgentToolManifest = {
        schema: 'bot.agent-tools/1',
        cli: 'claude_code',
        version,
        arch,
        libc: this.libc,
        installed_at: new Date().toISOString(),
        container_executable: posix.join(this.containerRoot, 'claude_code', version, 'bin', 'claude'),
        container_node_executable: posix.join(this.containerRoot, 'node', this.nodeVersion, 'bin', 'node'),
        node_version: this.nodeVersion,
        artifacts,
      };
      const manifestPath = resolve(stageDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      chmodSync(manifestPath, 0o644);

      const finalDir = resolve(rootReal, 'claude_code', version);
      const claudeParent = dirname(finalDir);
      mkdirSync(claudeParent, { recursive: true, mode: 0o755 });
      chmodSync(claudeParent, 0o755);
      this.replaceVersionDir(stageDir, finalDir, { cli: 'claude_code', version, rootReal, arch });
      return manifest;
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private async installCodex(rootReal: string, version: string, arch: AgentToolArch, expectedSha256?: string): Promise<AgentToolManifest> {
    const rustArch = arch === 'x64' ? 'x86_64' : 'aarch64';
    const binaryName = `codex-${rustArch}-unknown-linux-musl`;
    const assetName = `${binaryName}.tar.gz`;
    const apiBase = this.sources.githubApiBase.replace(/\/+$/, '');
    const releaseUrl = `${apiBase}/repos/openai/codex/releases/tags/rust-v${version}`;
    let downloadUrl: string;
    let releaseSha256: string | null = null;
    try {
      const release = await this.fetchJson(releaseUrl, [apiBase]);
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find((a: any) => a?.name === assetName);
      if (!asset || typeof asset.browser_download_url !== 'string') {
        throw new TaskError('agent_tool_download_failed', 'failed', `codex_release_asset_missing:${assetName}`);
      }
      const digestMatch = typeof asset.digest === 'string' ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest.trim()) : null;
      releaseSha256 = digestMatch ? digestMatch[1]!.toLowerCase() : null;
      downloadUrl = String(asset.browser_download_url);
    } catch (err) {
      const primaryOrigin = this.sources.githubDownloadOrigins[0]?.replace(/\/+$/, '');
      const detail = err instanceof TaskError ? String(err.detail ?? '') : '';
      const isRateOrApiFailure = err instanceof TaskError && err.code === 'agent_tool_download_failed' && !detail.startsWith('codex_release_asset_missing:');
      if (!expectedSha256 || !primaryOrigin || !isRateOrApiFailure) {
        throw err;
      }
      downloadUrl = `${primaryOrigin}/openai/codex/releases/download/rust-v${version}/${assetName}`;
    }
    if (!releaseSha256 && !expectedSha256) {
      throw new TaskError('agent_tool_hash_mismatch', 'failed', `codex_release_digest_missing:${assetName}`);
    }
    const archiveBytes = await this.fetchBytes(downloadUrl, this.sources.githubDownloadOrigins);
    const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    if (releaseSha256) verifyDigestHex(actualSha256, releaseSha256, assetName);
    if (expectedSha256) verifyDigestHex(actualSha256, expectedSha256, assetName);

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = resolve(stagingRoot, `codex-${version}-${randomBytes(8).toString('hex')}`);
    try {
      mkdirSync(stageDir, { recursive: true, mode: 0o755 });
      chmodSync(stageDir, 0o755);
      const unpackDir = resolve(stageDir, 'unpacked');
      await extractTarGzAsync(archiveBytes, unpackDir, { stripComponents: 0 });
      const extractedBin = existsSync(resolve(unpackDir, binaryName))
        ? resolve(unpackDir, binaryName)
        : existsSync(resolve(unpackDir, 'codex'))
          ? resolve(unpackDir, 'codex')
          : null;
      if (!extractedBin || !lstatSync(extractedBin).isFile() || lstatSync(extractedBin).isSymbolicLink()) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', 'codex_binary_missing_in_archive');
      }
      const binDir = resolve(stageDir, 'bin');
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      chmodSync(binDir, 0o755);
      const targetBin = resolve(binDir, 'codex');
      renameSync(extractedBin, targetBin);
      chmodSync(targetBin, 0o755);
      rmSync(unpackDir, { recursive: true, force: true });

      const manifest: AgentToolManifest = {
        schema: 'bot.agent-tools/1',
        cli: 'codex',
        version,
        arch,
        installed_at: new Date().toISOString(),
        container_executable: posix.join(this.containerRoot, 'codex', version, 'bin', 'codex'),
        container_node_executable: null,
        node_version: null,
        artifacts: [
          { role: 'static_binary', source_url: downloadUrl, sha256: actualSha256, bytes: archiveBytes.length },
        ],
      };
      const manifestPath = resolve(stageDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      chmodSync(manifestPath, 0o644);

      const finalDir = resolve(rootReal, 'codex', version);
      const codexParent = dirname(finalDir);
      mkdirSync(codexParent, { recursive: true, mode: 0o755 });
      chmodSync(codexParent, 0o755);
      this.replaceVersionDir(stageDir, finalDir, { cli: 'codex', version, rootReal, arch });
      return manifest;
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private writeAcpSelectedPointer(rootReal: string, product: AgentToolAcpProduct, version: string): void {
    readAcpProduct(rootReal, product, version);
    const parent = resolve(rootReal, 'acp', product);
    const tmp = resolve(parent, `.selected-${randomBytes(6).toString('hex')}`);
    writeFileSync(tmp, version + '\n', { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, resolve(parent, 'selected'));
  }

  private async installICode(rootReal: string, version: string, arch: AgentToolArch, expectedSha256?: string): Promise<AgentToolManifest> {
    const release = icodeReleases.get(version);
    const pinnedSha = (this.sources.allowLoopbackHttp === true ? this.sources.testDigests?.icode?.[`${version}:${arch}`] : undefined) ?? release?.sha256[arch];
    const assetName = release?.assets[arch];
    if (!release || !pinnedSha || !assetName) {
      throw new TaskError('agent_tool_version_unverified', 'waiting_configuration', `icode@${version} (${arch})`);
    }
    if (expectedSha256) verifyDigestHex(pinnedSha, expectedSha256, 'icode_offline_archive');
    const primaryOrigin = this.sources.githubDownloadOrigins[0]?.replace(/\/+$/, '');
    if (!primaryOrigin) throw new TaskError('agent_tool_download_failed', 'failed', 'github_download_origin_missing');
    const downloadUrl = `${primaryOrigin}/${release.repo}/releases/download/${release.tag}/${assetName}`;
    const archiveBytes = await this.fetchBytes(downloadUrl, this.sources.githubDownloadOrigins);
    const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    verifyDigestHex(actualSha256, pinnedSha, assetName);

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = resolve(stagingRoot, `icode-${version}-${randomBytes(8).toString('hex')}`);
    try {
      mkdirSync(stageDir, { recursive: true, mode: 0o755 });
      chmodSync(stageDir, 0o755);
      const unpackDir = resolve(stageDir, 'unpacked');
      await extractTarGzAsync(archiveBytes, unpackDir, {
        stripComponents: 0,
        include: rel => rel === 'icode',
      });
      const extracted = resolve(unpackDir, 'icode');
      if (!existsSync(extracted) || !lstatSync(extracted).isFile() || lstatSync(extracted).isSymbolicLink()) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', 'icode_binary_missing_in_archive');
      }
      const binDir = resolve(stageDir, 'bin');
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      chmodSync(binDir, 0o755);
      const targetBin = resolve(binDir, 'icode');
      renameSync(extracted, targetBin);
      chmodSync(targetBin, 0o755);
      rmSync(unpackDir, { recursive: true, force: true });

      const installedAt = new Date().toISOString();
      const acpManifest = {
        schema: 'bot.acp-product/1' as const,
        id: icodeProductId,
        version,
        distribution: 'linux-offline' as const,
        installed_at: installedAt,
        source: `https://github.com/${release.repo}/commit/${release.commit}`,
        sourceSha256: release.sha256[arch]!,
        artifacts: [
          { role: 'offline_archive', source_url: downloadUrl, sha256: actualSha256, bytes: archiveBytes.length },
        ],
        launch: icodeLaunch,
      };
      const manifestPath = resolve(stageDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(acpManifest, null, 2) + '\n', { mode: 0o644 });
      chmodSync(manifestPath, 0o644);

      const finalDir = resolve(rootReal, 'acp', icodeProductId, version);
      mkdirSync(dirname(finalDir), { recursive: true, mode: 0o755 });
      chmodSync(dirname(finalDir), 0o755);
      this.replaceVersionDir(stageDir, finalDir, { cli: icodeProductId, version, rootReal, arch });
      this.writeAcpSelectedPointer(rootReal, icodeProductId, version);
      return acpManifestToView(readAcpProduct(rootReal, icodeProductId, version), icodeProductId, arch, this.containerRoot, finalDir);
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private async installWorkSwarm(rootReal: string, version: string, arch: AgentToolArch, expectedSha256?: string): Promise<AgentToolManifest> {
    const release = workswarmReleases.get(version);
    if (!release) {
      throw new TaskError('agent_tool_version_unverified', 'waiting_configuration', `workswarm@${version}`);
    }
    const override = this.sources.allowLoopbackHttp === true ? this.sources.testDigests?.workswarm?.[version] : undefined;
    const expectedPyprojectSha = override?.pyprojectSha256 ?? release.pyprojectSha256;
    const expectedLockSha = override?.lockSha256 ?? release.lockSha256;
    const expectedWheelSha = override?.wheelSha256 ?? release.wheelSha256;
    const expectedSourceSha = override?.sourceSha256 ?? release.sourceSha256;
    if (expectedSha256) verifyDigestHex(expectedWheelSha, expectedSha256, release.wheel);
    if (!this.acpBuilder) {
      throw new TaskError(
        'agent_tool_isolated_installer_required',
        'waiting_configuration',
        'WorkSwarm installation requires the isolated manager installer container.',
      );
    }
    const uv = await this.ensureUvRuntime(rootReal, arch);
    const rawOrigin = this.sources.rawGithubOrigins[0]?.replace(/\/+$/, '');
    const ghOrigin = this.sources.githubDownloadOrigins[0]?.replace(/\/+$/, '');
    if (!rawOrigin || !ghOrigin) throw new TaskError('agent_tool_download_failed', 'failed', 'trusted_origin_missing');

    const pyprojectUrl = `${rawOrigin}/${release.repo}/${release.commit}/pyproject.toml`;
    const lockUrl = `${rawOrigin}/${release.repo}/${release.commit}/uv.lock`;
    const wheelUrl = `${ghOrigin}/${release.repo}/releases/download/${release.tag}/${release.wheel}`;

    const pyprojectBytes = await this.fetchBytes(pyprojectUrl, this.sources.rawGithubOrigins);
    verifyDigestHex(createHash('sha256').update(pyprojectBytes).digest('hex'), expectedPyprojectSha, 'pyproject.toml');
    const lockBytes = await this.fetchBytes(lockUrl, this.sources.rawGithubOrigins);
    verifyDigestHex(createHash('sha256').update(lockBytes).digest('hex'), expectedLockSha, 'uv.lock');
    const wheelBytes = await this.fetchBytes(wheelUrl, this.sources.githubDownloadOrigins);
    verifyDigestHex(createHash('sha256').update(wheelBytes).digest('hex'), expectedWheelSha, release.wheel);

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o755 });
    chmodSync(stagingRoot, 0o755);
    const stageName = `workswarm-src-${version}-${randomBytes(8).toString('hex')}`;
    const sourceDir = resolve(stagingRoot, stageName);
    const containerSourceDir = posix.join(this.containerRoot, '.staging', stageName);
    try {
      mkdirSync(sourceDir, { recursive: true, mode: 0o755 });
      chmodSync(sourceDir, 0o755);
      writeFileSync(resolve(sourceDir, 'pyproject.toml'), pyprojectBytes, { mode: 0o644 });
      writeFileSync(resolve(sourceDir, 'uv.lock'), lockBytes, { mode: 0o644 });
      writeFileSync(resolve(sourceDir, release.wheel), wheelBytes, { mode: 0o644 });
      const stagedHash = stageAcpSource(sourceDir);
      verifyDigestHex(stagedHash, expectedSourceSha, 'workswarm_source_bundle');

      const active = this.activeVersions();
      if (active.has(version)) {
        throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `${workswarmProductId}@${version}`);
      }

      await this.acpBuilder({
        product: workswarmProductId,
        version,
        sourceDir,
        containerSourceDir,
        uvBin: uv.hostBin,
        containerUvBin: uv.containerBin,
      });

      const finalDir = resolve(rootReal, 'acp', workswarmProductId, version);
      const verified = readAcpProduct(rootReal, workswarmProductId, version);
      this.writeAcpSelectedPointer(rootReal, workswarmProductId, version);
      return acpManifestToView(verified, workswarmProductId, arch, this.containerRoot, finalDir);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  }

  status(): AgentToolsVolumeStatus {
    return inspectAgentTools(this.volumeRoot, {
      containerRoot: this.containerRoot,
      arch: this.explicitArch,
      libc: this.libc,
      installing: this.installing,
      autoInstallEnabled: this.autoInstallEnabled,
    });
  }

  select(cli: AgentToolCli): SelectedCliVersion {
    return selectCompatibleCliVersion(this.volumeRoot, cli, { containerRoot: this.containerRoot, arch: this.explicitArch, libc: this.libc });
  }

  install(input: {
    cli: AgentToolProduct;
    version?: string;
    mode?: 'install' | 'upgrade';
    sha256?: string;
    nativeSha256?: string;
    retainCount?: number;
    protectedVersions?: Iterable<string> | (() => Iterable<string>);
    fromAutoInstall?: boolean;
  }): Promise<{
    installed: AgentToolManifest;
    compatible: boolean;
    pruned: string[];
    status: CliAvailabilityStatus;
    protected_invalid: string[];
  }> {
    return this.serialized(async () => {
      if (!isAgentToolProduct(input.cli)) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'unsupported_cli');
      }
      const entry = AGENT_PRODUCT_MAP.get(input.cli)!;
      const versionStr = (input.version ?? entry.defaultVersion).trim();
      const parsed = parseSemver(versionStr);
      if (!parsed) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_version');
      }
      if (input.sha256 !== undefined && !SHA256_RE.test(input.sha256.toLowerCase())) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_sha256');
      }
      if (input.nativeSha256 !== undefined && (!SHA256_RE.test(input.nativeSha256.toLowerCase()) || input.cli !== 'claude_code')) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_native_sha256');
      }
      const arch = this.requireArch();
      const rootReal = this.requireVolumeRoot();
      rmSync(resolve(rootReal, '.staging'), { recursive: true, force: true });

      if (input.mode === 'upgrade' && isAgentToolCli(input.cli)) {
        const before = inspectCliAvailability(this.volumeRoot, input.cli, { containerRoot: this.containerRoot, arch, libc: this.libc });
        if (before.selected_version && compareSemver(parsed.raw, before.selected_version) <= 0) {
          throw new TaskError(
            'agent_tool_invalid',
            'waiting_configuration',
            `upgrade_version_must_exceed_selected:${before.selected_version}`,
          );
        }
      }
      if (!isAgentToolCli(input.cli) && !supportedProductVersions(input.cli, arch).includes(parsed.raw)) {
        throw new TaskError('agent_tool_version_unverified', 'waiting_configuration', `${input.cli}@${parsed.raw}`);
      }

      const supplied = input.protectedVersions;
      this.activeVersionProvider = typeof supplied === 'function' ? supplied : () => supplied ?? [];
      this.installing.add(input.cli);
      try {
        const active = this.activeVersions();
        if (active.has(parsed.raw)) {
          throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `${input.cli}@${parsed.raw}`);
        }
        if (input.cli === 'claude_code') {
          const nodeVer = parseSemver(this.nodeVersion)?.raw;
          if (nodeVer && !this.existingNodeRuntime(rootReal, arch, nodeVer) && this.activeClaudeDependsOnNode(rootReal, active, nodeVer, arch)) {
            throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `node@${nodeVer}`);
          }
        }
        let installed: AgentToolManifest;
        if (input.cli === 'claude_code') {
          installed = await this.installClaudeCode(rootReal, parsed.raw, arch, input.sha256?.toLowerCase(), input.nativeSha256?.toLowerCase());
        } else if (input.cli === 'codex') {
          installed = await this.installCodex(rootReal, parsed.raw, arch, input.sha256?.toLowerCase());
        } else if (input.cli === icodeProductId) {
          installed = await this.installICode(rootReal, parsed.raw, arch, input.sha256?.toLowerCase());
        } else {
          installed = await this.installWorkSwarm(rootReal, parsed.raw, arch, input.sha256?.toLowerCase());
        }

        // Clear any removed flag or previous error upon successful install/upgrade.
        this.updateProductState(rootReal, input.cli, () => ({
          removed: false,
          last_error: null,
          last_error_detail: null,
          last_attempt_at: new Date(this.clock()).toISOString(),
          next_retry_at: null,
          failed_attempts: 0,
        }));

        const protectedSet = new Set<string>([installed.version, ...active]);
        const sweep = input.retainCount !== undefined
          ? this.pruneLocked(rootReal, arch, input.cli, input.retainCount, protectedSet)
          : { removed: [], protectedInvalid: [] };
        return {
          installed,
          compatible: satisfiesProductVersion(input.cli, parsed.raw, arch),
          pruned: sweep.removed,
          protected_invalid: sweep.protectedInvalid,
          status: inspectCliAvailability(this.volumeRoot, input.cli, { containerRoot: this.containerRoot, arch, libc: this.libc }),
        };
      } catch (err) {
        const code = err instanceof TaskError ? err.code : 'agent_tool_download_failed';
        const detail = err instanceof TaskError ? (err.detail ?? err.code) : String((err as Error)?.message || 'install_failed').slice(0, 300);
        const nowMs = this.clock();
        try {
          this.updateProductState(rootReal, input.cli, prev => {
            const attempts = input.fromAutoInstall ? prev.failed_attempts + 1 : prev.failed_attempts;
            const backoff = this.autoInstallBackoffMs[Math.min(Math.max(0, attempts - 1), this.autoInstallBackoffMs.length - 1)] ?? 300_000;
            return {
              removed: input.fromAutoInstall ? prev.removed : false,
              last_error: code,
              last_error_detail: detail,
              last_attempt_at: new Date(nowMs).toISOString(),
              next_retry_at: input.fromAutoInstall ? new Date(nowMs + backoff).toISOString() : prev.next_retry_at,
              failed_attempts: attempts,
            };
          });
        } catch {}
        throw err;
      } finally {
        this.installing.delete(input.cli);
        this.activeVersionProvider = null;
      }
    });
  }

  /**
   * Deletes either a single version (`version` specified) or the entire Agent (`version` omitted).
   * Running versions are always protected (409 `agent_tool_version_in_use`).
   * Whole-Agent removal (or removing the last installed version) marks `removed: true` so startup auto-install skips it
   * until an administrator explicitly clicks Install again (#1260).
   */
  remove(input: {
    cli: AgentToolProduct;
    version?: string;
    protectedVersions?: Iterable<string> | (() => Iterable<string>);
  }): Promise<{ removed: string[]; removed_agent: boolean; status: AgentToolsVolumeStatus }> {
    return this.serialized(async () => {
      if (!isAgentToolProduct(input.cli)) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'unsupported_cli');
      }
      if (input.version !== undefined && !acpVersion.test(input.version.trim())) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_version');
      }
      const arch = this.requireArch();
      const rootReal = this.requireVolumeRoot();
      const supplied = input.protectedVersions ?? (this.protectedVersions ? () => this.protectedVersions!(input.cli) : undefined);
      this.activeVersionProvider = typeof supplied === 'function' ? supplied : () => supplied ?? [];
      try {
        const active = this.activeVersions();
        const targetVersion = input.version?.trim();
        const removed: string[] = [];

        if (isAgentToolCli(input.cli)) {
          const cliDir = resolve(rootReal, input.cli);
          if (targetVersion) {
            if (active.has(targetVersion)) {
              throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `${input.cli}@${targetVersion}`);
            }
            const verDir = resolve(cliDir, targetVersion);
            if (existsSync(verDir) && isSubpath(rootReal, verDir) && verDir !== cliDir) {
              rmSync(verDir, { recursive: true, force: true });
              removed.push(targetVersion);
            }
            if (input.cli === 'claude_code') this.pruneUnreferencedNodeRuntimes(rootReal, arch);
            const after = inspectCliAvailability(this.volumeRoot, input.cli, { containerRoot: this.containerRoot, arch, libc: this.libc });
            const markRemoved = after.installed_manifests.length === 0;
            if (markRemoved) {
              this.updateProductState(rootReal, input.cli, () => ({ ...emptyProductState(), removed: true }));
            }
            return { removed, removed_agent: markRemoved, status: this.status() };
          }
          // Whole-agent removal: refuse if any installed version is active.
          if (existsSync(cliDir) && lstatSync(cliDir).isDirectory()) {
            const entries = readdirSync(cliDir);
            for (const v of entries) {
              if (active.has(v)) {
                throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `${input.cli}@${v}`);
              }
            }
            for (const v of entries) {
              const verDir = resolve(cliDir, v);
              if (isSubpath(rootReal, verDir) && verDir !== cliDir) {
                rmSync(verDir, { recursive: true, force: true });
                removed.push(v);
              }
            }
          }
          if (input.cli === 'claude_code') this.pruneUnreferencedNodeRuntimes(rootReal, arch);
          this.updateProductState(rootReal, input.cli, () => ({ ...emptyProductState(), removed: true }));
          return { removed, removed_agent: true, status: this.status() };
        }

        // ACP product (`icode` or `workswarm`)
        const parent = resolve(rootReal, 'acp', input.cli);
        const selectedFile = resolve(parent, 'selected');
        if (targetVersion) {
          if (active.has(targetVersion)) {
            throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `${input.cli}@${targetVersion}`);
          }
          const verDir = resolve(parent, targetVersion);
          const before = inspectAcpProductAvailability(this.volumeRoot, input.cli, { containerRoot: this.containerRoot, arch });
          const remaining = before.compatible_versions.filter(v => v !== targetVersion);
          if (before.selected_version === targetVersion) {
            if (remaining.length > 0) {
              this.writeAcpSelectedPointer(rootReal, input.cli, remaining[0]!);
            } else if (existsSync(selectedFile)) {
              rmSync(selectedFile, { force: true });
            }
          }
          if (existsSync(verDir) && isSubpath(rootReal, verDir) && verDir !== parent) {
            rmSync(verDir, { recursive: true, force: true });
            removed.push(targetVersion);
          }
          const markRemoved = remaining.length === 0;
          if (markRemoved) {
            this.updateProductState(rootReal, input.cli, () => ({ ...emptyProductState(), removed: true }));
          }
          return { removed, removed_agent: markRemoved, status: this.status() };
        }

        // Whole ACP agent removal
        if (existsSync(parent) && lstatSync(parent).isDirectory()) {
          const entries = readdirSync(parent).filter(name => acpVersion.test(name));
          for (const v of entries) {
            if (active.has(v)) {
              throw new TaskError('agent_tool_version_in_use', 'waiting_configuration', `${input.cli}@${v}`);
            }
          }
          if (existsSync(selectedFile)) rmSync(selectedFile, { force: true });
          for (const v of entries) {
            const verDir = resolve(parent, v);
            if (isSubpath(rootReal, verDir) && verDir !== parent) {
              rmSync(verDir, { recursive: true, force: true });
              removed.push(v);
            }
          }
        }
        this.updateProductState(rootReal, input.cli, () => ({ ...emptyProductState(), removed: true }));
        return { removed, removed_agent: true, status: this.status() };
      } finally {
        this.activeVersionProvider = null;
      }
    });
  }

  prune(options: {
    cli?: AgentToolProduct;
    retainCount?: number;
    protectedVersions?: Partial<Record<AgentToolProduct, Iterable<string>>> | Iterable<string> | ((cli: AgentToolProduct) => Iterable<string>);
  } = {}): Promise<{ pruned: Record<AgentToolProduct, string[]>; protected_invalid: Record<AgentToolProduct, string[]>; status: AgentToolsVolumeStatus }> {
    return this.serialized(async () => {
      const retainCount = options.retainCount ?? DEFAULT_CLI_RETAIN_COUNT;
      if (!Number.isSafeInteger(retainCount) || retainCount < CLI_RETAIN_BOUNDS[0] || retainCount > CLI_RETAIN_BOUNDS[1]) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_retain_count');
      }
      const arch = this.requireArch();
      const emptyMap = () => Object.fromEntries(AGENT_TOOL_PRODUCTS.map(p => [p, [] as string[]])) as Record<AgentToolProduct, string[]>;
      if (!existsSync(this.volumeRoot)) {
        return { pruned: emptyMap(), protected_invalid: emptyMap(), status: this.status() };
      }
      const rootReal = this.requireVolumeRoot();
      rmSync(resolve(rootReal, '.staging'), { recursive: true, force: true });
      const targets = options.cli ? [options.cli] : [...AGENT_TOOL_PRODUCTS];
      const pruned = emptyMap();
      const protectedInvalid = emptyMap();
      const isFn = typeof options.protectedVersions === 'function';
      const isIterable = !isFn && options.protectedVersions && typeof (options.protectedVersions as any)[Symbol.iterator] === 'function';
      for (const cli of targets) {
        if (!isAgentToolProduct(cli)) throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'unsupported_cli');
        const extra = isFn
          ? (options.protectedVersions as (c: AgentToolProduct) => Iterable<string>)(cli)
          : isIterable
            ? (options.protectedVersions as Iterable<string>)
            : (options.protectedVersions as Partial<Record<AgentToolProduct, Iterable<string>>> | undefined)?.[cli];
        const sweep = this.pruneLocked(rootReal, arch, cli, retainCount, extra);
        pruned[cli] = sweep.removed;
        protectedInvalid[cli] = sweep.protectedInvalid;
      }
      return { pruned, protected_invalid: protectedInvalid, status: this.status() };
    });
  }

  private pruneLocked(rootReal: string, arch: AgentToolArch, cli: AgentToolProduct, retainCount: number, extraProtected?: Iterable<string>): { removed: string[]; protectedInvalid: string[] } {
    if (!Number.isSafeInteger(retainCount) || retainCount < CLI_RETAIN_BOUNDS[0] || retainCount > CLI_RETAIN_BOUNDS[1]) {
      throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_retain_count');
    }
    const stagingTrash = resolve(rootReal, '.staging');
    mkdirSync(stagingTrash, { recursive: true, mode: 0o700 });

    const protectedNames = new Set<string>();
    for (const name of [...(this.protectedVersions?.(cli) ?? []), ...(extraProtected ?? [])]) {
      if (typeof name === 'string' && name.trim()) protectedNames.add(name.trim());
    }

    if (!isAgentToolCli(cli)) {
      const parent = resolve(rootReal, 'acp', cli);
      if (!existsSync(parent)) return { removed: [], protectedInvalid: [] };
      const info = inspectAcpProductAvailability(this.volumeRoot, cli, { containerRoot: this.containerRoot, arch });
      // Always protect the currently selected ACP version so prune can never dangle `selected` (#1260 F4).
      if (info.selected_version) protectedNames.add(info.selected_version);
      const validVersions = [...info.compatible_versions];
      const keepSet = new Set<string>([...validVersions.slice(0, retainCount), ...protectedNames]);
      const removed: string[] = [];
      for (const ver of validVersions) {
        if (keepSet.has(ver)) continue;
        const verPath = resolve(parent, ver);
        if (!isSubpath(rootReal, verPath) || verPath === parent) continue;
        const trashPath = resolve(stagingTrash, `trash-${cli}-${ver}-${randomBytes(6).toString('hex')}`);
        renameSync(verPath, trashPath);
        rmSync(trashPath, { recursive: true, force: true });
        removed.push(ver);
      }
      return { removed, protectedInvalid: [] };
    }

    const cliDir = resolve(rootReal, cli);
    if (!existsSync(cliDir)) return { removed: [], protectedInvalid: [] };

    const validVersions: string[] = [];
    const brokenDirs: string[] = [];
    for (const entry of readdirSync(cliDir)) {
      const manifest = readValidCliManifest(rootReal, cli, entry, arch, this.containerRoot, this.libc);
      if (manifest) validVersions.push(manifest.version);
      else brokenDirs.push(entry);
    }
    validVersions.sort((a, b) => compareSemver(b, a));

    const compatible = validVersions.filter(v => satisfiesCliRange(cli, v));
    const incompatible = validVersions.filter(v => !satisfiesCliRange(cli, v));
    const keepSet = new Set<string>(compatible.slice(0, retainCount));
    for (const v of incompatible) {
      if (keepSet.size >= retainCount) break;
      keepSet.add(v);
    }
    for (const v of protectedNames) keepSet.add(v);

    const removed: string[] = [];
    const protectedInvalid: string[] = [];
    for (const bad of brokenDirs) {
      const badPath = resolve(cliDir, bad);
      if (!isSubpath(rootReal, badPath) || badPath === cliDir) continue;
      if (protectedNames.has(bad)) { protectedInvalid.push(bad); continue; }
      rmSync(badPath, { recursive: true, force: true });
    }
    for (const ver of validVersions) {
      if (keepSet.has(ver)) continue;
      const verPath = resolve(cliDir, ver);
      const trashPath = resolve(stagingTrash, `trash-${cli}-${ver}-${randomBytes(6).toString('hex')}`);
      renameSync(verPath, trashPath);
      rmSync(trashPath, { recursive: true, force: true });
      removed.push(ver);
    }

    if (cli === 'claude_code') this.pruneUnreferencedNodeRuntimes(rootReal, arch, protectedInvalid);
    return { removed, protectedInvalid };
  }

  private pruneUnreferencedNodeRuntimes(rootReal: string, arch: AgentToolArch, unreadable: string[] = []): void {
    const referencedNodes = new Set<string>();
    const claudeStatus = inspectCliAvailability(rootReal, 'claude_code', { containerRoot: this.containerRoot, arch, libc: this.libc });
    for (const m of claudeStatus.installed_manifests) {
      if (m.node_version) referencedNodes.add(m.node_version);
    }
    for (const version of unreadable) {
      const named = brokenManifestNodeVersion(rootReal, version);
      if (named) referencedNodes.add(named); else return;
    }
    const nodeRoot = resolve(rootReal, 'node');
    if (!existsSync(nodeRoot)) return;
    for (const entry of readdirSync(nodeRoot)) {
      if (referencedNodes.has(entry)) continue;
      const dir = resolve(nodeRoot, entry);
      if (isSubpath(rootReal, dir) && dir !== nodeRoot) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  /**
   * One background reconciliation pass for startup auto-installation (#1260):
   * - Skips when `BOT_AGENT_TOOLS_AUTO_INSTALL=0` or volume/arch unavailable.
   * - Skips any agent marked `removed: true` by an administrator.
   * - Skips any agent whose default version (or a newer compatible version for CLIs) is already installed.
   * - Respects persisted exponential backoff (`next_retry_at`) after failures so offline restarts do not loop.
   */
  async reconcileAutoInstall(options: {
    retainCount?: () => number;
    protectedVersions?: (cli: AgentToolProduct) => Iterable<string>;
    onInstalled?: (product: AgentToolProduct, version: string) => void;
    onFailed?: (product: AgentToolProduct, version: string, error: unknown) => void;
  } = {}): Promise<{ installed: string[]; skipped: string[]; failed: { product: AgentToolProduct; error: string }[] }> {
    const installed: string[] = [];
    const skipped: string[] = [];
    const failed: { product: AgentToolProduct; error: string }[] = [];
    const enabled = this.autoInstallEnabled ?? isAutoInstallEnabled();
    if (!enabled) return { installed, skipped: [...AGENT_TOOL_PRODUCTS], failed };
    const snap = this.status();
    if (!snap.volume_present || !snap.arch) return { installed, skipped: [...AGENT_TOOL_PRODUCTS], failed };

    const nowMs = this.clock();
    for (const entry of AGENT_PRODUCT_REGISTRY) {
      const current = this.status().clis[entry.id];
      if (!current) continue;
      if (current.removed) {
        skipped.push(entry.id);
        continue;
      }
      const alreadyReady = entry.kind === 'cli'
        ? current.selected_version !== null && compareSemver(current.selected_version, entry.defaultVersion) >= 0
        : current.selected_version === entry.defaultVersion;
      if (alreadyReady) {
        skipped.push(entry.id);
        continue;
      }
      if (current.next_retry_at && Date.parse(current.next_retry_at) > nowMs) {
        skipped.push(entry.id);
        continue;
      }
      try {
        const retainCount = options.retainCount ? options.retainCount() : DEFAULT_CLI_RETAIN_COUNT;
        await this.install({
          cli: entry.id,
          version: entry.defaultVersion,
          retainCount,
          protectedVersions: () => options.protectedVersions ? options.protectedVersions(entry.id) : (this.protectedVersions?.(entry.id) ?? []),
          fromAutoInstall: true,
        });
        installed.push(`${entry.id}@${entry.defaultVersion}`);
        options.onInstalled?.(entry.id, entry.defaultVersion);
      } catch (error) {
        const code = error instanceof TaskError ? error.code : 'agent_tool_download_failed';
        failed.push({ product: entry.id, error: code });
        options.onFailed?.(entry.id, entry.defaultVersion, error);
      }
    }
    return { installed, skipped, failed };
  }
}

/** Background startup & retry driver wired only from `src/main.ts`, never from `createControlPlane` (#1260 F7). */
export class AgentToolsAutoInstaller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;

  constructor(
    private readonly tools: AgentToolManager,
    private readonly options: {
      retainCount?: () => number;
      protectedVersions?: (cli: AgentToolProduct) => Iterable<string>;
      onInstalled?: (product: AgentToolProduct, version: string) => void;
      onFailed?: (product: AgentToolProduct, version: string, error: unknown) => void;
      intervalMs?: number;
    } = {},
  ) {}

  start(): void {
    if (this.stopped || !isAutoInstallEnabled()) return;
    const kick = () => {
      if (this.stopped || this.running) return;
      this.running = this.tools.reconcileAutoInstall(this.options)
        .catch(err => console.error('[agent-tools] auto-install pass failed:', err))
        .finally(() => { this.running = null; });
    };
    setTimeout(kick, 1000).unref();
    this.timer = setInterval(kick, this.options.intervalMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.running) await this.running.catch(() => {});
  }
}
