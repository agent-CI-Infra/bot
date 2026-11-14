import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { TaskError } from '../agent/common.js';

export type AgentToolCli = 'claude_code' | 'codex';
export type AgentToolArch = 'x64' | 'arm64';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export interface CliCompatibilityRange {
  cli: AgentToolCli;
  min: string;
  maxExclusive: string;
  range: string;
  tested: string;
}

export const AGENT_TOOL_CLIS: readonly AgentToolCli[] = ['claude_code', 'codex'] as const;
export const DEFAULT_AGENT_TOOLS_ROOT = '/opt/agent-tools';
export const DEFAULT_CLI_RETAIN_COUNT = 3;
export const CLI_RETAIN_BOUNDS = [1, 10] as const;
export const BUNDLED_NODE_VERSION = '22.15.0';

export const COMPATIBLE_CLI_RANGES: Record<AgentToolCli, CliCompatibilityRange> = {
  claude_code: {
    cli: 'claude_code',
    min: '2.1.0',
    maxExclusive: '3.0.0',
    range: '>=2.1.0 <3.0.0',
    tested: '2.1.319',
  },
  codex: {
    cli: 'codex',
    min: '0.166.0',
    maxExclusive: '1.0.0',
    range: '>=0.166.0 <1.0.0',
    tested: '0.166.0',
  },
};

export interface AgentToolArtifact {
  role: 'package' | 'native_binary' | 'node_runtime' | 'static_binary';
  source_url: string;
  sha256: string;
  bytes: number;
}

export interface AgentToolManifest {
  schema: 'bot.agent-tools/1';
  cli: AgentToolCli;
  version: string;
  arch: AgentToolArch;
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
  cli: AgentToolCli;
  available: boolean;
  compatible_range: string;
  tested_version: string;
  selected_version: string | null;
  container_executable: string | null;
  node_version: string | null;
  compatible_versions: string[];
  incompatible_versions: string[];
  installed_manifests: AgentToolManifest[];
  reason: string | null;
}

export interface AgentToolsVolumeStatus {
  volume_root: string;
  container_root: string;
  volume_present: boolean;
  arch: AgentToolArch | null;
  node_versions: string[];
  clis: Record<AgentToolCli, CliAvailabilityStatus>;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 768 * 1024 * 1024;

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

export function resolveSupportedArch(arch = process.arch): AgentToolArch | null {
  if (arch === 'x64' || arch === 'arm64') return arch;
  return null;
}

function isSubpath(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
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

function readValidCliManifest(
  rootReal: string,
  cli: AgentToolCli,
  version: string,
  arch: AgentToolArch,
  containerRoot: string,
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
    return parsed as AgentToolManifest;
  } catch {
    return null;
  }
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

export function inspectCliAvailability(
  volumeRoot: string,
  cli: AgentToolCli,
  options: { containerRoot?: string; arch?: AgentToolArch | null } = {},
): CliAvailabilityStatus {
  const range = COMPATIBLE_CLI_RANGES[cli];
  const containerRoot = options.containerRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
  const arch = options.arch === undefined ? resolveSupportedArch() : options.arch;
  const base: CliAvailabilityStatus = {
    cli,
    available: false,
    compatible_range: range.range,
    tested_version: range.tested,
    selected_version: null,
    container_executable: null,
    node_version: null,
    compatible_versions: [],
    incompatible_versions: [],
    installed_manifests: [],
    reason: null,
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

  const cliDir = resolve(rootReal, cli);
  if (!existsSync(cliDir)) return { ...base, reason: 'cli_not_installed' };
  let dirEntries: string[];
  try {
    const st = lstatSync(cliDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return { ...base, reason: 'cli_not_installed' };
    dirEntries = readdirSync(cliDir);
  } catch {
    return { ...base, reason: 'cli_not_installed' };
  }

  const manifests: AgentToolManifest[] = [];
  for (const entry of dirEntries) {
    const manifest = readValidCliManifest(rootReal, cli, entry, arch, containerRoot);
    if (manifest) manifests.push(manifest);
  }
  manifests.sort((a, b) => compareSemver(b.version, a.version));
  if (!manifests.length) return { ...base, reason: 'cli_not_installed' };

  const compatible = manifests.filter(m => satisfiesCliRange(cli, m.version));
  const incompatible = manifests.filter(m => !satisfiesCliRange(cli, m.version));
  const selected = compatible[0] ?? null;

  return {
    cli,
    available: Boolean(selected),
    compatible_range: range.range,
    tested_version: range.tested,
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
  options: { containerRoot?: string; arch?: AgentToolArch | null } = {},
): AgentToolsVolumeStatus {
  const containerRoot = options.containerRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
  const arch = options.arch === undefined ? resolveSupportedArch() : options.arch;
  let volumePresent = false;
  let nodeVersions: string[] = [];
  if (volumeRoot && isAbsolute(volumeRoot) && existsSync(volumeRoot)) {
    try {
      const st = lstatSync(volumeRoot);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        volumePresent = true;
        if (arch) nodeVersions = listValidNodeVersions(realpathSync(volumeRoot), arch);
      }
    } catch {}
  }
  return {
    volume_root: volumeRoot,
    container_root: containerRoot,
    volume_present: volumePresent,
    arch,
    node_versions: nodeVersions,
    clis: {
      claude_code: inspectCliAvailability(volumeRoot, 'claude_code', { containerRoot, arch }),
      codex: inspectCliAvailability(volumeRoot, 'codex', { containerRoot, arch }),
    },
  };
}

export function selectCompatibleCliVersion(
  volumeRoot: string,
  cli: AgentToolCli,
  options: { containerRoot?: string; arch?: AgentToolArch | null } = {},
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

// ---------------------------------------------------------------- Pure-Node safe .tar.gz extractor

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new TaskError('agent_tool_archive_invalid', 'failed', 'invalid_tar_octal');
  return value;
}

function readCString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const zero = slice.indexOf(0);
  return (zero >= 0 ? slice.subarray(0, zero) : slice).toString('utf8');
}

function parsePaxHeaders(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  const text = data.toString('utf8');
  while (pos < text.length) {
    const space = text.indexOf(' ', pos);
    if (space < 0) break;
    const len = Number.parseInt(text.slice(pos, space), 10);
    if (!Number.isSafeInteger(len) || len <= space - pos + 1) break;
    // PAX record length is in bytes; slice byte-accurately from Buffer when non-ASCII is possible.
    const recordBytes = data.subarray(Buffer.byteLength(text.slice(0, pos)), Buffer.byteLength(text.slice(0, pos)) + len);
    const record = recordBytes.toString('utf8');
    const sp = record.indexOf(' ');
    const eq = record.indexOf('=', sp + 1);
    if (sp > 0 && eq > sp) {
      const key = record.slice(sp + 1, eq);
      const val = record.endsWith('\n') ? record.slice(eq + 1, -1) : record.slice(eq + 1);
      out[key] = val;
    }
    pos += record.length;
  }
  return out;
}

function normalizeArchiveRelativePath(rawPath: string, stripComponents: number): string | null {
  const cleaned = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) {
    throw new TaskError('agent_tool_archive_invalid', 'failed', `unsafe_archive_path:${rawPath}`);
  }
  if (parts.length <= stripComponents) return null;
  return parts.slice(stripComponents).join('/');
}

export function extractTarGz(
  compressed: Buffer,
  destDir: string,
  options: { stripComponents?: number; include?: (relPath: string) => boolean } = {},
): void {
  const stripComponents = options.stripComponents ?? 0;
  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    throw new TaskError('agent_tool_archive_invalid', 'failed', 'gunzip_failed_or_too_large');
  }

  mkdirSync(destDir, { recursive: true, mode: 0o755 });
  const destReal = realpathSync(destDir);

  let offset = 0;
  let nextPax: Record<string, string> = {};
  let gnuLongPath: string | null = null;
  let gnuLongLink: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(b => b === 0)) continue;

    const size = parseOctal(header, 124, 12);
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length) throw new TaskError('agent_tool_archive_invalid', 'failed', 'truncated_tar_entry');
    const body = tar.subarray(offset, offset + size);
    offset += padded;

    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    if (typeflag === 'x' || typeflag === 'g') {
      const parsed = parsePaxHeaders(body);
      if (typeflag === 'x') nextPax = { ...nextPax, ...parsed };
      continue;
    }
    if (typeflag === 'L') {
      gnuLongPath = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'K') {
      gnuLongLink = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    const prefix = readCString(header, 345, 155);
    const name = readCString(header, 0, 100);
    const rawPath = nextPax.path ?? gnuLongPath ?? (prefix ? `${prefix}/${name}` : name);
    const rawLink = nextPax.linkpath ?? gnuLongLink ?? readCString(header, 157, 100);
    const mode = parseOctal(header, 100, 8);
    nextPax = {};
    gnuLongPath = null;
    gnuLongLink = null;

    const relPath = normalizeArchiveRelativePath(rawPath, stripComponents);
    if (!relPath) continue;
    if (options.include && !options.include(relPath)) continue;

    const targetPath = resolve(destReal, relPath);
    if (!isSubpath(destReal, targetPath) || targetPath === destReal) {
      throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_escape:${relPath}`);
    }

    if (typeflag === '5') {
      mkdirSync(targetPath, { recursive: true, mode: 0o755 });
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o755 });
    const parentReal = realpathSync(dirname(targetPath));
    if (!isSubpath(destReal, parentReal)) {
      throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_symlink_escape:${relPath}`);
    }

    if (typeflag === '0') {
      const execBit = (mode & 0o111) !== 0;
      const safeMode = execBit ? 0o755 : 0o644;
      writeFileSync(targetPath, body, { mode: safeMode });
      chmodSync(targetPath, safeMode);
    } else if (typeflag === '2') {
      if (!rawLink || rawLink.startsWith('/')) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', `unsafe_symlink:${relPath}`);
      }
      const resolvedLinkTarget = resolve(dirname(targetPath), rawLink);
      if (!isSubpath(destReal, resolvedLinkTarget)) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', `symlink_escape:${relPath}`);
      }
      rmSync(targetPath, { force: true });
      symlinkSync(rawLink, targetPath);
    } else {
      throw new TaskError('agent_tool_archive_invalid', 'failed', `unsupported_tar_type:${typeflag}`);
    }
  }
}

// ---------------------------------------------------------------- Trusted Installer & Pruner

export interface TrustedToolSources {
  npmRegistryBase: string;
  nodeDistBase: string;
  githubApiBase: string;
  githubDownloadOrigins: string[];
  allowLoopbackHttp?: boolean;
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

export interface AgentToolManagerOptions {
  volumeRoot?: string;
  containerRoot?: string;
  arch?: AgentToolArch;
  nodeVersion?: string;
  sources?: Partial<TrustedToolSources>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  protectedVersions?: (cli: AgentToolCli) => Iterable<string>;
}

export class AgentToolManager {
  readonly volumeRoot: string;
  readonly containerRoot: string;
  readonly nodeVersion: string;
  private readonly explicitArch?: AgentToolArch;
  private readonly sources: TrustedToolSources;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly protectedVersions?: (cli: AgentToolCli) => Iterable<string>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AgentToolManagerOptions = {}) {
    this.volumeRoot = options.volumeRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
    this.containerRoot = options.containerRoot ?? DEFAULT_AGENT_TOOLS_ROOT;
    this.nodeVersion = options.nodeVersion ?? BUNDLED_NODE_VERSION;
    this.explicitArch = options.arch;
    this.sources = { ...DEFAULT_TRUSTED_SOURCES, ...(options.sources ?? {}) };
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.protectedVersions = options.protectedVersions;
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
    mkdirSync(this.volumeRoot, { recursive: true, mode: 0o755 });
    const st = lstatSync(this.volumeRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new TaskError('agent_tools_volume_missing', 'waiting_configuration', 'volume_root_not_directory');
    }
    return realpathSync(this.volumeRoot);
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

  private async ensureNodeRuntime(rootReal: string, arch: AgentToolArch): Promise<AgentToolArtifact> {
    const nodeVer = parseSemver(this.nodeVersion)?.raw;
    if (!nodeVer) throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_node_version');
    const finalDir = resolve(rootReal, 'node', nodeVer);
    const existingManifestPath = resolve(finalDir, 'manifest.json');
    const existingBinPath = resolve(finalDir, 'bin', 'node');
    if (existsSync(existingManifestPath) && verifySafeExecutable(rootReal, existingBinPath)) {
      try {
        const existing = JSON.parse(readFileSync(existingManifestPath, 'utf8')) as NodeRuntimeManifest;
        if (existing.schema === 'bot.agent-tools-node/1' && existing.version === nodeVer && existing.arch === arch && SHA256_RE.test(existing.sha256)) {
          return { role: 'node_runtime', source_url: existing.source_url, sha256: existing.sha256, bytes: existing.bytes };
        }
      } catch {}
    }

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
      extractTarGz(archiveBytes, stageDir, {
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
      writeFileSync(resolve(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      mkdirSync(resolve(rootReal, 'node'), { recursive: true, mode: 0o755 });
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
      renameSync(stageDir, finalDir);
      return { role: 'node_runtime', source_url: tarballUrl, sha256: actualSha256, bytes: archiveBytes.length };
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private async installClaudeCode(rootReal: string, version: string, arch: AgentToolArch, expectedSha256?: string): Promise<AgentToolManifest> {
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
    // Prefer musl static build so custom project container libc changes cannot break execution; fall back to glibc linux package.
    const muslPkg = `@anthropic-ai/claude-code-linux-${arch}-musl`;
    const glibcPkg = `@anthropic-ai/claude-code-linux-${arch}`;
    const chosenNativePkg = optionalDeps[muslPkg] ? muslPkg : optionalDeps[glibcPkg] ? glibcPkg : null;

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
      artifacts.push({ role: 'native_binary', source_url: nativeTarballUrl, sha256: nativeSha256, bytes: nativeBytes.length });
    }

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = resolve(stagingRoot, `claude_code-${version}-${randomBytes(8).toString('hex')}`);
    try {
      const pkgDir = resolve(stageDir, 'package');
      extractTarGz(pkgBytes, pkgDir, { stripComponents: 1 });

      let hasNativeBinary = false;
      if (nativeBytes) {
        const nativeDir = resolve(stageDir, 'native');
        extractTarGz(nativeBytes, nativeDir, { stripComponents: 1 });
        const nativeBin = resolve(nativeDir, 'claude');
        if (!verifySafeExecutable(stageDir, nativeBin)) {
          throw new TaskError('agent_tool_archive_invalid', 'failed', 'claude_native_binary_missing');
        }
        hasNativeBinary = true;
      }

      const jsCandidates = ['cli.js', 'cli.mjs', 'cli-wrapper.cjs'];
      const jsEntry = jsCandidates.find(rel => existsSync(resolve(pkgDir, rel)) && lstatSync(resolve(pkgDir, rel)).isFile()) ?? null;

      const binDir = resolve(stageDir, 'bin');
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const launcher = buildClaudeLauncherScript(this.containerRoot, version, this.nodeVersion, hasNativeBinary, jsEntry);
      const launcherPath = resolve(binDir, 'claude');
      writeFileSync(launcherPath, launcher, { mode: 0o755 });
      chmodSync(launcherPath, 0o755);

      const manifest: AgentToolManifest = {
        schema: 'bot.agent-tools/1',
        cli: 'claude_code',
        version,
        arch,
        installed_at: new Date().toISOString(),
        container_executable: posix.join(this.containerRoot, 'claude_code', version, 'bin', 'claude'),
        container_node_executable: posix.join(this.containerRoot, 'node', this.nodeVersion, 'bin', 'node'),
        node_version: this.nodeVersion,
        artifacts,
      };
      writeFileSync(resolve(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });

      const finalDir = resolve(rootReal, 'claude_code', version);
      mkdirSync(dirname(finalDir), { recursive: true, mode: 0o755 });
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
      renameSync(stageDir, finalDir);
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
    const release = await this.fetchJson(releaseUrl, [apiBase]);

    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((a: any) => a?.name === assetName);
    if (!asset || typeof asset.browser_download_url !== 'string') {
      throw new TaskError('agent_tool_download_failed', 'failed', `codex_release_asset_missing:${assetName}`);
    }
    const digestMatch = typeof asset.digest === 'string' ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest.trim()) : null;
    const releaseSha256 = digestMatch ? digestMatch[1]!.toLowerCase() : null;
    if (!releaseSha256 && !expectedSha256) {
      throw new TaskError('agent_tool_hash_mismatch', 'failed', `codex_release_digest_missing:${assetName}`);
    }

    const downloadUrl = String(asset.browser_download_url);
    const archiveBytes = await this.fetchBytes(downloadUrl, this.sources.githubDownloadOrigins);
    const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    if (releaseSha256) verifyDigestHex(actualSha256, releaseSha256, assetName);
    if (expectedSha256) verifyDigestHex(actualSha256, expectedSha256, assetName);

    const stagingRoot = resolve(rootReal, '.staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stageDir = resolve(stagingRoot, `codex-${version}-${randomBytes(8).toString('hex')}`);
    try {
      const unpackDir = resolve(stageDir, 'unpacked');
      extractTarGz(archiveBytes, unpackDir, { stripComponents: 0 });
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
      writeFileSync(resolve(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });

      const finalDir = resolve(rootReal, 'codex', version);
      mkdirSync(dirname(finalDir), { recursive: true, mode: 0o755 });
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
      renameSync(stageDir, finalDir);
      return manifest;
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  status(): AgentToolsVolumeStatus {
    return inspectAgentTools(this.volumeRoot, { containerRoot: this.containerRoot, arch: this.explicitArch });
  }

  select(cli: AgentToolCli): SelectedCliVersion {
    return selectCompatibleCliVersion(this.volumeRoot, cli, { containerRoot: this.containerRoot, arch: this.explicitArch });
  }

  install(input: { cli: AgentToolCli; version: string; sha256?: string; retainCount?: number; protectedVersions?: Iterable<string> | (() => Iterable<string>) }): Promise<{
    installed: AgentToolManifest;
    compatible: boolean;
    pruned: string[];
    status: CliAvailabilityStatus;
  }> {
    return this.serialized(async () => {
      if (!AGENT_TOOL_CLIS.includes(input.cli)) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'unsupported_cli');
      }
      const parsed = parseSemver(input.version);
      if (!parsed) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_version');
      }
      if (input.sha256 !== undefined && !SHA256_RE.test(input.sha256.toLowerCase())) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_sha256');
      }
      const arch = this.requireArch();
      const rootReal = this.requireVolumeRoot();
      const installed = input.cli === 'claude_code'
        ? await this.installClaudeCode(rootReal, parsed.raw, arch, input.sha256?.toLowerCase())
        : await this.installCodex(rootReal, parsed.raw, arch, input.sha256?.toLowerCase());
      const dynamicProtected = typeof input.protectedVersions === 'function' ? input.protectedVersions() : (input.protectedVersions ?? []);
      const protectedSet = new Set<string>([installed.version, ...dynamicProtected]);
      const pruned = input.retainCount !== undefined ? this.pruneLocked(rootReal, arch, input.cli, input.retainCount, protectedSet) : [];
      return {
        installed,
        compatible: satisfiesCliRange(input.cli, parsed.raw),
        pruned,
        status: inspectCliAvailability(this.volumeRoot, input.cli, { containerRoot: this.containerRoot, arch }),
      };
    });
  }

  prune(options: { cli?: AgentToolCli; retainCount?: number; protectedVersions?: Partial<Record<AgentToolCli, Iterable<string>>> | Iterable<string> | ((cli: AgentToolCli) => Iterable<string>) } = {}): Promise<{ pruned: Record<AgentToolCli, string[]>; status: AgentToolsVolumeStatus }> {
    return this.serialized(async () => {
      const retainCount = options.retainCount ?? DEFAULT_CLI_RETAIN_COUNT;
      if (!Number.isSafeInteger(retainCount) || retainCount < CLI_RETAIN_BOUNDS[0] || retainCount > CLI_RETAIN_BOUNDS[1]) {
        throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_retain_count');
      }
      const arch = this.requireArch();
      if (!existsSync(this.volumeRoot)) {
        return { pruned: { claude_code: [], codex: [] }, status: this.status() };
      }
      const rootReal = this.requireVolumeRoot();
      const targets = options.cli ? [options.cli] : [...AGENT_TOOL_CLIS];
      const pruned: Record<AgentToolCli, string[]> = { claude_code: [], codex: [] };
      const isFn = typeof options.protectedVersions === 'function';
      const isIterable = !isFn && options.protectedVersions && typeof (options.protectedVersions as any)[Symbol.iterator] === 'function';
      for (const cli of targets) {
        if (!AGENT_TOOL_CLIS.includes(cli)) throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'unsupported_cli');
        const extra = isFn
          ? (options.protectedVersions as (cli: AgentToolCli) => Iterable<string>)(cli)
          : isIterable
            ? (options.protectedVersions as Iterable<string>)
            : (options.protectedVersions as Partial<Record<AgentToolCli, Iterable<string>>> | undefined)?.[cli];
        pruned[cli] = this.pruneLocked(rootReal, arch, cli, retainCount, extra);
      }
      return { pruned, status: this.status() };
    });
  }

  private pruneLocked(rootReal: string, arch: AgentToolArch, cli: AgentToolCli, retainCount: number, extraProtected?: Iterable<string>): string[] {
    if (!Number.isSafeInteger(retainCount) || retainCount < CLI_RETAIN_BOUNDS[0] || retainCount > CLI_RETAIN_BOUNDS[1]) {
      throw new TaskError('agent_tool_invalid', 'waiting_configuration', 'invalid_retain_count');
    }
    const cliDir = resolve(rootReal, cli);
    if (!existsSync(cliDir)) return [];

    const validVersions: string[] = [];
    const brokenDirs: string[] = [];
    for (const entry of readdirSync(cliDir)) {
      const manifest = readValidCliManifest(rootReal, cli, entry, arch, this.containerRoot);
      if (manifest) validVersions.push(manifest.version);
      else brokenDirs.push(entry);
    }
    validVersions.sort((a, b) => compareSemver(b, a));

    // Retain the newest N compatible versions; if fewer than N compatible versions exist, retain newest remaining up to N.
    const compatible = validVersions.filter(v => satisfiesCliRange(cli, v));
    const incompatible = validVersions.filter(v => !satisfiesCliRange(cli, v));
    const keepSet = new Set<string>(compatible.slice(0, retainCount));
    for (const v of incompatible) {
      if (keepSet.size >= retainCount) break;
      keepSet.add(v);
    }
    // Never remove versions currently bound to active running task_runs or explicitly protected (e.g. just installed).
    for (const v of this.protectedVersions?.(cli) ?? []) {
      if (typeof v === 'string' && v.trim()) keepSet.add(v.trim());
    }
    for (const v of extraProtected ?? []) {
      if (typeof v === 'string' && v.trim()) keepSet.add(v.trim());
    }

    const removed: string[] = [];
    const stagingTrash = resolve(rootReal, '.staging');
    mkdirSync(stagingTrash, { recursive: true, mode: 0o700 });

    for (const bad of brokenDirs) {
      const badPath = resolve(cliDir, bad);
      if (isSubpath(rootReal, badPath) && badPath !== cliDir) rmSync(badPath, { recursive: true, force: true });
    }
    for (const ver of validVersions) {
      if (keepSet.has(ver)) continue;
      const verPath = resolve(cliDir, ver);
      const trashPath = resolve(stagingTrash, `trash-${cli}-${ver}-${randomBytes(6).toString('hex')}`);
      renameSync(verPath, trashPath);
      rmSync(trashPath, { recursive: true, force: true });
      removed.push(ver);
    }

    this.pruneUnreferencedNodeRuntimes(rootReal, arch);
    return removed;
  }

  private pruneUnreferencedNodeRuntimes(rootReal: string, arch: AgentToolArch): void {
    const referencedNodes = new Set<string>();
    const claudeStatus = inspectCliAvailability(rootReal, 'claude_code', { containerRoot: this.containerRoot, arch });
    for (const m of claudeStatus.installed_manifests) {
      if (m.node_version) referencedNodes.add(m.node_version);
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
}
