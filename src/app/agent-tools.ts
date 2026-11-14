import type { Store } from '../storage/database.js';
import { superAdmin, type Actor } from './auth.js';
import { fail, fields, type Json } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { activeCliVersions } from '../roles/role-run.js';
import {
  AGENT_TOOL_CLIS,
  AgentToolManager,
  CLI_RETAIN_BOUNDS,
  DEFAULT_CLI_RETAIN_COUNT,
  parseSemver,
  type AgentToolCli,
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

function validateCli(value: unknown): AgentToolCli {
  if (typeof value !== 'string' || !AGENT_TOOL_CLIS.includes(value as AgentToolCli)) {
    return fail(400, 'invalid_agent_tool_cli');
  }
  return value as AgentToolCli;
}

function mapToolError(err: unknown): never {
  if (err instanceof TaskError) {
    const status = err.code === 'agent_tool_invalid' ? 400
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

  if (path === '/api/agent-tools/install') {
    if (method !== 'POST') return fail(405, 'method_not_allowed');
    fields(input, ['cli', 'version', 'sha256', 'retain_count']);
    const cli = validateCli(input.cli);
    const ver = parseSemver(input.version);
    if (!ver) return fail(400, 'invalid_agent_tool_version');
    const sha256 = input.sha256 === undefined ? undefined : typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.sha256) ? input.sha256.toLowerCase() : fail(400, 'invalid_agent_tool_sha256');
    const retainCount = input.retain_count === undefined ? agentToolsRetainCount(store) : validateRetainCount(input.retain_count);
    try {
      const outcome = await tools.install({
        cli,
        version: ver.raw,
        sha256,
        retainCount,
        protectedVersions: () => activeCliVersions(store, cli),
      });
      store.audit(user.id, 'agent_tools.installed', `${cli}@${ver.raw}`);
      return {
        installed: outcome.installed as unknown as Json,
        compatible: outcome.compatible,
        pruned: outcome.pruned,
        status: view(),
      };
    } catch (err) {
      return mapToolError(err);
    }
  }

  if (path === '/api/agent-tools/prune') {
    if (method !== 'POST') return fail(405, 'method_not_allowed');
    fields(input, ['cli', 'retain_count']);
    const cli = input.cli === undefined ? undefined : validateCli(input.cli);
    const retainCount = input.retain_count === undefined ? agentToolsRetainCount(store) : validateRetainCount(input.retain_count);
    if (input.retain_count !== undefined) {
      store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', RETAIN_COUNT_KEY, String(retainCount));
    }
    try {
      const outcome = await tools.prune({ cli, retainCount, protectedVersions: c => activeCliVersions(store, c) });
      store.audit(user.id, 'agent_tools.pruned', cli ?? 'all');
      return {
        pruned: outcome.pruned as unknown as Json,
        status: view(),
      };
    } catch (err) {
      return mapToolError(err);
    }
  }

  return undefined;
}
