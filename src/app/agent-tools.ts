import type { Store } from '../storage/database.js';
import { superAdmin, type Actor } from './auth.js';
import { fail, fields, type Json } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { activeCliVersions } from '../roles/role-run.js';
import {
  AGENT_PRODUCT_MAP,
  AgentToolManager,
  CLI_RETAIN_BOUNDS,
  DEFAULT_CLI_RETAIN_COUNT,
  isAgentToolProduct,
  parseSemver,
  type AgentToolProduct,
} from '../harness/agent-tools.js';

const RETAIN_COUNT_KEY = 'agent_tools.retain_count';

export function agentToolsRetainCount(store: Store): number {
  const raw = Number(store.get('SELECT value FROM settings WHERE key=?', RETAIN_COUNT_KEY)?.value);
  return Number.isSafeInteger(raw) && raw >= CLI_RETAIN_BOUNDS[0] && raw <= CLI_RETAIN_BOUNDS[1]
    ? raw
    : DEFAULT_CLI_RETAIN_COUNT;
}

function validateRetainCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < CLI_RETAIN_BOUNDS[0] || (value as number) > CLI_RETAIN_BOUNDS[1]) {
    return fail(400, 'invalid_retain_count');
  }
  return value as number;
}

function validateProduct(value: unknown): AgentToolProduct {
  if (!isAgentToolProduct(value)) {
    return fail(400, 'invalid_agent_tool_cli');
  }
  return value;
}

/** The one writer of the saved default: call it only on the success path, so a failed call never changes the setting. */
function saveRetainCount(store: Store, retainCount: number): void {
  store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', RETAIN_COUNT_KEY, String(retainCount));
}

function mapToolError(err: unknown): never {
  if (err instanceof TaskError) {
    const status = err.code === 'agent_tool_invalid' || err.code === 'agent_tool_version_unverified' ? 400
      : err.code === 'agent_tool_version_in_use' ? 409
      : err.code === 'agent_tool_download_failed' || err.code === 'agent_tool_hash_mismatch' || err.code === 'agent_tool_archive_invalid' ? 502
      : 503;
    return fail(status, err.code, err.detail);
  }
  throw err;
}

export async function agentToolsApi(
  store: Store,
  tools: AgentToolManager,
  user: Actor,
  method: string,
  path: string,
  input: Json,
): Promise<Json | undefined> {
  if (!path.startsWith('/api/agent-tools')) return undefined;
  superAdmin(user);

  const view = () => ({
    ...tools.status(),
    retain_count: agentToolsRetainCount(store),
    retain_bounds: [...CLI_RETAIN_BOUNDS],
  }) as unknown as Json;

  if (path === '/api/agent-tools') {
    if (method === 'GET') return view();
    return fail(405, 'method_not_allowed');
  }

  if (path === '/api/agent-tools/install' || path === '/api/agent-tools/upgrade') {
    if (method !== 'POST') return fail(405, 'method_not_allowed');
    fields(input, ['cli', 'version', 'sha256', 'native_sha256', 'retain_count']);
    const cli = validateProduct(input.cli);
    const entry = AGENT_PRODUCT_MAP.get(cli)!;
    const rawVersion = input.version === undefined || input.version === '' ? entry.defaultVersion : input.version;
    const ver = parseSemver(rawVersion);
    if (!ver) return fail(400, 'invalid_agent_tool_version');
    const sha256 = input.sha256 === undefined ? undefined : typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.sha256) ? input.sha256.toLowerCase() : fail(400, 'invalid_agent_tool_sha256');
    const nativeSha256 = input.native_sha256 === undefined ? undefined : cli === 'claude_code' && typeof input.native_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.native_sha256) ? input.native_sha256.toLowerCase() : fail(400, 'invalid_agent_tool_native_sha256');
    const retainCount = input.retain_count === undefined ? agentToolsRetainCount(store) : validateRetainCount(input.retain_count);
    const mode = path === '/api/agent-tools/upgrade' ? 'upgrade' : 'install';
    try {
      const outcome = await tools.install({
        cli,
        version: ver.raw,
        mode,
        sha256,
        nativeSha256,
        retainCount,
        protectedVersions: () => activeCliVersions(store, cli),
      });
      if (input.retain_count !== undefined) saveRetainCount(store, retainCount);
      store.audit(user.id, mode === 'upgrade' ? 'agent_tools.upgraded' : 'agent_tools.installed', `${cli}@${ver.raw}`);
      return {
        installed: outcome.installed as unknown as Json,
        compatible: outcome.compatible,
        pruned: outcome.pruned,
        protected_invalid: outcome.protected_invalid as unknown as Json,
        status: view(),
      };
    } catch (err) {
      return mapToolError(err);
    }
  }

  if (path === '/api/agent-tools/remove') {
    if (method !== 'POST') return fail(405, 'method_not_allowed');
    fields(input, ['cli', 'version']);
    const cli = validateProduct(input.cli);
    const version = input.version === undefined || input.version === ''
      ? undefined
      : typeof input.version === 'string' && /^[0-9][a-zA-Z0-9._+-]{0,63}$/.test(input.version.trim())
        ? input.version.trim()
        : fail(400, 'invalid_agent_tool_version');
    try {
      const outcome = await tools.remove({
        cli,
        version,
        protectedVersions: () => activeCliVersions(store, cli),
      });
      store.audit(user.id, 'agent_tools.removed', version ? `${cli}@${version}` : cli);
      return {
        removed: outcome.removed,
        removed_agent: outcome.removed_agent,
        status: view(),
      };
    } catch (err) {
      return mapToolError(err);
    }
  }

  if (path === '/api/agent-tools/prune') {
    if (method !== 'POST') return fail(405, 'method_not_allowed');
    fields(input, ['cli', 'retain_count']);
    const cli = input.cli === undefined ? undefined : validateProduct(input.cli);
    const retainCount = input.retain_count === undefined ? agentToolsRetainCount(store) : validateRetainCount(input.retain_count);
    try {
      const outcome = await tools.prune({ cli, retainCount, protectedVersions: c => activeCliVersions(store, c) });
      if (input.retain_count !== undefined) saveRetainCount(store, retainCount);
      store.audit(user.id, 'agent_tools.pruned', cli ?? 'all');
      return {
        pruned: outcome.pruned as unknown as Json,
        protected_invalid: outcome.protected_invalid as unknown as Json,
        status: view(),
      };
    } catch (err) {
      return mapToolError(err);
    }
  }

  return undefined;
}
