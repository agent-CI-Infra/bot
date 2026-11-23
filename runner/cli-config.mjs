import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export const MAX_CLI_CONFIG_BYTES = 32 * 1024;

export const CLI_CONFIG_FILES = Object.freeze({
  claude_code: Object.freeze([
    Object.freeze({ name: 'settings.json', relPath: '.claude/settings.json', format: 'json', description: 'Claude Code 用户配置（env、model 等）' }),
    Object.freeze({ name: '.credentials.json', relPath: '.claude/.credentials.json', format: 'json', description: 'Claude Code 登录凭据（可选）' }),
  ]),
  codex: Object.freeze([
    Object.freeze({ name: 'config.toml', relPath: '.codex/config.toml', format: 'toml', description: 'Codex 配置（model、model_provider 等）' }),
    Object.freeze({ name: 'auth.json', relPath: '.codex/auth.json', format: 'json', description: 'Codex 认证凭据（API Key 或订阅登录态）' }),
  ]),
});

export function localConfigMissingCode(cli) {
  return cli === 'claude_code' ? 'claude_local_config_missing' : 'codex_local_config_missing';
}

function findEntry(cli, file) {
  const list = CLI_CONFIG_FILES[cli];
  if (!list) throw new Error('invalid_cli_config_target');
  const entry = list.find(item => item.name === file || item.relPath === file);
  if (!entry) throw new Error('invalid_cli_config_file');
  return entry;
}

async function resolveHomeRoot(workspaceRoot) {
  const home = resolve(workspaceRoot, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const realHome = await realpath(home);
  const realWs = await realpath(workspaceRoot);
  if (realHome !== realWs && !realHome.startsWith(realWs + sep)) {
    throw new Error('unsafe_cli_config_home');
  }
  return realHome;
}

async function inspectOne(realHome, entry) {
  const fullPath = resolve(realHome, entry.relPath);
  const dirPath = dirname(fullPath);
  try {
    const dirStat = await lstat(dirPath);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { exists: false, bytes: null, updated_at: null };
    const st = await lstat(fullPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > MAX_CLI_CONFIG_BYTES) {
      return { exists: false, bytes: null, updated_at: null };
    }
    const realFile = await realpath(fullPath);
    if (!realFile.startsWith(realHome + sep)) return { exists: false, bytes: null, updated_at: null };
    return { exists: true, bytes: st.size, updated_at: st.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: null, updated_at: null };
  }
}

/** Returns ONLY existence and metadata (bytes, updated_at) for allowlisted CLI config files under `/workspace/home`. Never returns file contents. */
export async function inspectCliConfigs(workspaceRoot) {
  const realHome = await resolveHomeRoot(workspaceRoot);
  const result = {};
  for (const [cli, entries] of Object.entries(CLI_CONFIG_FILES)) {
    const files = {};
    let configured = false;
    for (const entry of entries) {
      const info = await inspectOne(realHome, entry);
      files[entry.name] = { path: `/workspace/home/${entry.relPath}`, ...info };
      if (info.exists) configured = true;
    }
    result[cli] = { configured, files };
  }
  return result;
}

/** Atomically writes an allowlisted CLI config file into `/workspace/home` with mode 0600. Never returns or logs content. */
export async function writeCliConfig(workspaceRoot, cli, file, content) {
  const entry = findEntry(cli, file);
  if (typeof content !== 'string' || !content.trim() || content.includes('\0') || Buffer.byteLength(content, 'utf8') > MAX_CLI_CONFIG_BYTES) {
    throw new Error('invalid_cli_config_content');
  }
  if (entry.format === 'json') {
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error('invalid_cli_config_json'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_cli_config_json');
  }
  const realHome = await resolveHomeRoot(workspaceRoot);
  const fullPath = resolve(realHome, entry.relPath);
  const dirPath = dirname(fullPath);
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dirPath);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('unsafe_cli_config_path');
  const realDir = await realpath(dirPath);
  if (!realDir.startsWith(realHome + sep)) throw new Error('unsafe_cli_config_path');
  const existing = await lstat(fullPath).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('unsafe_cli_config_path');
  const tmpPath = `${fullPath}.tmp.${process.pid}.${Date.now()}`;
  const handle = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tmpPath, 0o600).catch(() => {});
  await rename(tmpPath, fullPath);
  const info = await inspectOne(realHome, entry);
  return { cli, file: entry.name, path: `/workspace/home/${entry.relPath}`, ...info };
}

/** Deletes an allowlisted CLI config file from `/workspace/home`. */
export async function deleteCliConfig(workspaceRoot, cli, file) {
  const entry = findEntry(cli, file);
  const realHome = await resolveHomeRoot(workspaceRoot);
  const fullPath = resolve(realHome, entry.relPath);
  const dirPath = dirname(fullPath);
  const dirStat = await lstat(dirPath).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
  if (dirStat) {
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('unsafe_cli_config_path');
    const realDir = await realpath(dirPath);
    if (!realDir.startsWith(realHome + sep)) throw new Error('unsafe_cli_config_path');
  }
  const existing = await lstat(fullPath).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('unsafe_cli_config_path');
    const realFile = await realpath(fullPath);
    if (!realFile.startsWith(realHome + sep)) throw new Error('unsafe_cli_config_path');
    try {
      await unlink(fullPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return { cli, file: entry.name, path: `/workspace/home/${entry.relPath}`, exists: false, bytes: null, updated_at: null };
}

function collectSecretsFromJson(obj, addSecret, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length >= 8 && /key|token|secret|auth|password|bearer/i.test(k)) {
      addSecret(v);
    } else if (v && typeof v === 'object') {
      collectSecretsFromJson(v, addSecret, depth + 1);
    }
  }
}

/**
 * Stages existing allowlisted local config files from `${workspaceRoot}/home` into the per-run isolated session
 * directory (`claudeHome` or `codexHome`) with mode 0600, so each run keeps its own session state while reading
 * administrator-configured keys and default models. Throws `claude_local_config_missing` / `codex_local_config_missing`
 * when no valid local config file exists.
 */
export async function stageLocalCliConfig(workspaceRoot, cli, targetDir, addSecret = () => {}) {
  const entries = CLI_CONFIG_FILES[cli];
  if (!entries) throw new Error('invalid_cli_config_target');
  const realHome = await resolveHomeRoot(workspaceRoot);
  const staged = [];
  for (const entry of entries) {
    const info = await inspectOne(realHome, entry);
    if (!info.exists) continue;
    const srcPath = resolve(realHome, entry.relPath);
    const content = await readFile(srcPath, 'utf8');
    if (!content.trim()) continue;
    if (entry.format === 'json') {
      try { collectSecretsFromJson(JSON.parse(content), addSecret); } catch {}
    } else {
      for (const line of content.split(/\r?\n/)) {
        const m = /(?:api_key|token|secret|password)\s*=\s*"([^"]{8,})"/i.exec(line);
        if (m?.[1]) addSecret(m[1]);
      }
    }
    const dstPath = join(targetDir, entry.name);
    await writeFile(dstPath, content, { mode: 0o600 });
    await chmod(dstPath, 0o600).catch(() => {});
    staged.push(dstPath);
  }
  if (!staged.length) {
    throw new Error(localConfigMissingCode(cli));
  }
  return staged;
}

export async function cleanupStagedCliConfig(stagedPaths) {
  for (const path of stagedPaths || []) {
    await unlink(path).catch(() => {});
  }
}
