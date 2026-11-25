import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { normalizeResponseFraming } from './response-framing.js';
import type { Row, Store } from '../storage/database.js';
import { traceSnapshot } from '../tasks/trace.js';
import { networkReason, TaskError, type Redactor } from '../agent/common.js';
import type { AgentSpec } from '../agent/runtime.js';
import { openModel, resolveModelWireUrl, type RuntimeModel } from '../agent/model.js';
import { beginModelRequest, finishModelRequest, pricingFor, type Pricing } from '../metrics/accounting.js';
import { modelGaps } from '../service-roles/roles.js';
import { scopeProjects } from '../channels/service-bindings.js';
import {
  entryCapabilities,
  inferCatalogEntryProtocol,
  modelCapabilities,
  modelCatalog,
  modelProtocol,
  normalizeModelName,
  type ModelAuthHeader,
  type ModelInterfaceType,
} from '../models/catalog.js';
import {
  accountingUsagePayload,
  endpointToFormat,
  formatErrorPayload,
  formatSseErrorEvent,
  PassthroughTap,
  patchPassthroughRequest,
  type CanonicalUsage,
  type DownstreamEndpoint,
  type PassthroughResponseSummary,
} from './model-formats.js';

export const DEFAULT_MODEL_GATEWAY_SOCKET = '/run/model-gateway/gateway.sock';
export const maxGatewayRequestBytes = 20 * 1024 * 1024;
export const maxUpstreamResponseBytes = 32 * 1024 * 1024;

export interface FileBackedModelProvider {
  id?: string;
  baseUrl: string;
  model: string;
  credentialFile?: string;
  apiKey?: string;
  interfaceType?: ModelInterfaceType;
  authHeader?: ModelAuthHeader;
  pricing?: Pricing | null;
}

export interface GatewayPreRequestContext {
  endpoint: DownstreamEndpoint;
  format: ModelInterfaceType;
  body: Record<string, any>;
  rawBytes: number;
  headers: IncomingMessage['headers'];
  isSubagent: boolean;
}

export interface GatewayPreRequestRejection {
  status: number;
  code: string;
  message: string;
}

export interface ModelGatewaySessionOptions {
  store: Store;
  task: Row;
  runId: string;
  leaseEpoch: number;
  runAccess: NonNullable<AgentSpec<any>['runAccess']>;
  redactor: Redactor;
  primaryModel?: RuntimeModel;
  fileProvider?: FileBackedModelProvider;
  allowVisibleModels?: boolean;
  allowedTools?: ReadonlySet<string>;
  guard?: () => Promise<void>;
  beforeModel?: () => Promise<void>;
  /** Optional control-plane hook before forwarding a parsed JSON body (e.g. Pi turn limits, checkpoint, task updates). */
  beforeRequest?: (ctx: GatewayPreRequestContext) => Promise<GatewayPreRequestRejection | void> | GatewayPreRequestRejection | void;
  /** Optional real-time text delta observer for main-agent SSE streams (used by Pi service turns). */
  onTextDelta?: (delta: string) => void | Promise<void>;
  /** Optional post-response hook (used by Pi to screen denied tool calls across all protocols). */
  onResponseComplete?: (summary: PassthroughResponseSummary, tap: PassthroughTap, isSubagent: boolean) => void;
  /** Optional hook when an upstream HTTP status should also raise a control-plane session fault (e.g. Pi 401/403). */
  onUpstreamHttpError?: (status: number, detail: string) => void;
  /** Optional hook when an upstream request fails with a transport or timeout error before completing. */
  onUpstreamTransportError?: (reason: string) => void;
  /** Optional callback for fatal control-plane errors raised inside a request handler. */
  onSessionFault?: (error: TaskError) => void;
  maxRequestBytes?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  timing?: { firstByteMs: number; idleMs: number };
  fetcher?: typeof fetch;
  /** Prefer the loopback TCP server even if a global UDS server is active (for local host runners/tests). */
  preferLoopback?: boolean;
}

export interface ModelGatewaySessionHandle {
  readonly token: string;
  readonly gatewayUrl: string | null;
  readonly socketPath: string | null;
  readonly activeCount: number;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface ModelGatewayServerHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface ResolvedTargetModel {
  id: string;
  model: string;
  url: string;
  key: string;
  pricing: Pricing | null;
  interfaceType: ModelInterfaceType;
  authHeader: ModelAuthHeader;
  maxOutputTokens: number;
}

const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'openai-beta',
  'user-agent',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'session_id',
  'x-session-id',
  'x-session-affinity',
]);

/**
 * Reads a control-plane provider credential file, accepting read-only mounts and symlinks
 * (such as Kubernetes/Docker secret projections) while reporting specific failure causes.
 */
export function readProviderCredentialFile(filePath: string): { key: string } {
  if (!filePath || typeof filePath !== 'string') {
    throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '未配置模型凭据文件路径 (credential_file_missing)');
  }
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err: any) {
    const code = err?.code;
    if (code === 'ENOENT') throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据文件不存在 (credential_file_not_found)');
    if (code === 'ELOOP') throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据符号链接损坏或循环 (credential_file_broken_symlink)');
    if (code === 'EACCES' || code === 'EPERM') throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据文件无读取权限 (credential_file_permission_denied)');
    throw new TaskError('provider_credential_unavailable', 'waiting_configuration', `凭据文件无法访问 (${code || 'credential_file_inaccessible'})`);
  }
  if (!stat.isFile()) {
    throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据路径不是普通文件 (credential_file_not_regular)');
  }
  if (stat.size > 32768) {
    throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据文件超过 32 KiB 上限 (credential_file_too_large)');
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err: any) {
    const code = err?.code;
    if (code === 'EACCES' || code === 'EPERM') throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据文件无读取权限 (credential_file_permission_denied)');
    throw new TaskError('provider_credential_unavailable', 'waiting_configuration', `读取凭据文件失败 (${code || 'credential_file_read_failed'})`);
  }
  const key = raw.trim();
  if (!key) throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据文件内容为空 (credential_file_empty)');
  if (/\s|[\x00-\x1f]/.test(key)) throw new TaskError('provider_credential_unavailable', 'waiting_configuration', '凭据包含空白或控制字符 (credential_file_malformed)');
  return { key };
}

function scrubSecrets(text: string, redactor: Redactor, secret: string): string {
  let out = secret ? text.split(secret).join('[REDACTED]') : text;
  out = redactor.text(out);
  return out;
}

function maxSecretLength(redactor: Redactor, secret: string): number {
  let maxLen = secret ? secret.length : 0;
  for (const s of redactor.values) {
    if (typeof s === 'string' && s.length > maxLen) maxLen = s.length;
  }
  return maxLen;
}

function parseRoute(rawUrl: string | undefined, method: string | undefined): {
  endpoint: 'models' | DownstreamEndpoint;
  query: string;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl || '/', 'http://localhost');
  } catch {
    return null;
  }
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    return { endpoint: 'models', query: parsed.search };
  }
  if (m === 'POST') {
    if (pathname === '/v1/messages' || pathname === '/messages') return { endpoint: 'messages', query: parsed.search };
    if (pathname === '/v1/responses' || pathname === '/responses') return { endpoint: 'responses', query: parsed.search };
    if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') return { endpoint: 'chat_completions', query: parsed.search };
  }
  return null;
}

function extractPresentedToken(headers: IncomingMessage['headers']): string {
  const rawApiKey = headers['x-api-key'];
  const rawAuth = headers.authorization;
  if (Array.isArray(rawApiKey) || Array.isArray(rawAuth)) return '';
  const apiKey = typeof rawApiKey === 'string' && rawApiKey.trim() ? rawApiKey.trim() : '';
  let bearer = '';
  if (typeof rawAuth === 'string' && rawAuth.trim()) {
    const match = /^Bearer\s+(.+)$/i.exec(rawAuth.trim());
    if (!match?.[1]?.trim()) return '';
    bearer = match[1].trim();
  }
  if (apiKey && bearer && apiKey !== bearer) return '';
  return apiKey || bearer;
}

function matchesModelIdentity(
  store: Store,
  candidate: { id?: string; api_url: string; model_name: string },
  requested: string,
): boolean {
  const reqTrim = requested.trim();
  if (!reqTrim) return false;
  if (candidate.id && reqTrim === candidate.id) return true;
  if (reqTrim === candidate.model_name) return true;
  if (normalizeModelName(reqTrim) === normalizeModelName(candidate.model_name)) return true;
  const match = modelCatalog(store).match(candidate).entry;
  if (match) {
    if (reqTrim === match.ref || reqTrim === match.model || (match.canonical && reqTrim === match.canonical)) return true;
    if (normalizeModelName(reqTrim) === normalizeModelName(match.model)) return true;
  }
  return false;
}

function consolidationAuthorizedRow(store: Store, task: Row, modelId: string, projectClause: string): Row | undefined {
  if (task.consolidation_scope === 'project') {
    if (!task.repository_id) return undefined;
    return store.get(`SELECT m.* FROM models m WHERE m.id=? AND ${projectClause}`, modelId, task.repository_id, task.repository_id);
  }
  if (task.consolidation_scope === 'group_assistant') {
    if (!task.consolidation_scope_id) return undefined;
    const binding = store.get('SELECT principal_id,scope FROM channel_service_bindings WHERE chat_id=? AND enabled=1', task.consolidation_scope_id);
    if (!binding) return undefined;
    const projects = scopeProjects(store, String(binding.principal_id));
    if (!projects.length) return undefined;
    const row = store.get('SELECT m.* FROM models m WHERE m.id=?', modelId);
    if (!row) return undefined;
    if (binding.scope === 'organization' && row.repository_id !== null) return undefined;
    return modelGaps(store, String(row.id), projects).length === 0 ? row : undefined;
  }
  if (task.consolidation_scope === 'personal_assistant') {
    return store.get('SELECT m.* FROM models m WHERE m.id=? AND m.repository_id IS NULL', modelId);
  }
  return undefined;
}

function extractUpstreamErrorMessage(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const err = parsed.error;
  const found = [err?.message, err, parsed.message, parsed.detail, parsed.msg].find(
    v => typeof v === 'string' && v.trim(),
  );
  return found ? String(found).trim().slice(0, 300) : null;
}

async function writeChunk(res: ServerResponse, chunk: Buffer | string): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  if (!res.write(chunk)) {
    await new Promise<void>(resolve => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        res.off('error', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
      res.once('error', done);
    });
  }
}

interface RegisteredSession {
  readonly token: string;
  readonly handleHttp: (
    req: IncomingMessage,
    res: ServerResponse,
    endpoint: 'models' | DownstreamEndpoint,
    query: string,
    presentedToken: string,
  ) => Promise<void>;
  readonly activeCount: () => number;
  readonly drain: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function createRegisteredSession(options: ModelGatewaySessionOptions): RegisteredSession {
  const {
    store,
    task,
    runId,
    leaseEpoch,
    runAccess,
    redactor,
    primaryModel,
    fileProvider,
    allowVisibleModels = true,
    allowedTools,
    guard,
    beforeModel,
    beforeRequest,
    onTextDelta,
    onResponseComplete,
    onUpstreamHttpError,
    onUpstreamTransportError,
    onSessionFault,
    maxRequestBytes = maxGatewayRequestBytes,
    maxOutputTokens: explicitMaxTokens,
    signal,
    timing = { firstByteMs: 120_000, idleMs: 120_000 },
    fetcher = fetch,
  } = options;

  const sessionAbort = new AbortController();
  const onParentAbort = () => sessionAbort.abort(signal?.reason ?? new Error('gateway_closed'));
  if (signal) {
    if (signal.aborted) sessionAbort.abort(signal.reason);
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let closed = false;
  let requestSeq = 0;
  const inFlight = new Set<Promise<void>>();

  const projectClause =
    '(m.repository_id=? OR (m.repository_id IS NULL AND (m.restricted=0 OR EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?))))';

  const checkLiveAuthorization = async (presentedToken: string) => {
    if (closed || sessionAbort.signal.aborted) throw new TaskError('run_token_revoked', 'cancelled');
    runAccess.check(presentedToken, 'model:invoke');
    if (task.repository_id) {
      const policy = store.get('SELECT enabled FROM policies WHERE repository_id=?', task.repository_id);
      if (policy && !policy.enabled) throw new TaskError('repository_policy_disabled', 'cancelled', '项目已停用');
    }
    await guard?.();
  };

  const visibleModelRows = (): Row[] => {
    const billedOnly = Boolean(task.onboarding) || !task.repository_id;
    if (task.kind === 'memory.consolidation') {
      if (!primaryModel) return [];
      const row = consolidationAuthorizedRow(store, task, primaryModel.id, projectClause);
      return row ? [row] : [];
    }
    if (task.service_role_id && task.trusted_owner) {
      return store.all(
        `SELECT m.* FROM models m JOIN trusted_organizations o ON o.model_id=m.id JOIN service_roles s ON s.id=? AND s.enabled=1
         WHERE o.owner_id=? AND m.repository_id IS NULL`,
        task.service_role_id,
        task.trusted_owner,
      );
    }
    if (task.kind === 'channel.service' && task.conversation_id) {
      return store.all(
        `SELECT m.* FROM models m JOIN channel_service_bindings b ON b.model_id=m.id
         WHERE b.chat_id=? AND b.enabled=1 AND ${billedOnly ? 'm.repository_id IS NULL' : projectClause}`,
        task.conversation_id,
        ...(billedOnly ? [] : [task.repository_id, task.repository_id]),
      );
    }
    if (task.service_role_id) {
      return store.all(
        `SELECT m.* FROM models m JOIN service_roles s ON s.model_id=m.id
         WHERE s.id=? AND s.enabled=1 AND ${billedOnly ? 'm.repository_id IS NULL' : projectClause}`,
        task.service_role_id,
        ...(billedOnly ? [] : [task.repository_id, task.repository_id]),
      );
    }
    if (task.repository_id) {
      return store.all(
        `SELECT m.* FROM models m WHERE ${projectClause} ORDER BY m.updated_at DESC`,
        task.repository_id,
        task.repository_id,
      );
    }
    return [];
  };

  const buildModelsListResponse = () => {
    const catalog = modelCatalog(store);
    const items: Record<string, any>[] = [];
    const seen = new Set<string>();
    const addModelEntry = (
      id: string,
      displayName: string,
      provider: string,
      createdAt: string,
      extra?: Record<string, any>,
    ) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      items.push({
        id,
        object: 'model',
        type: 'model',
        display_name: displayName,
        created: Math.floor(Date.parse(createdAt || '') / 1000) || 1735689600,
        created_at: createdAt || '2026-01-01T00:00:00Z',
        owned_by: provider,
        ...extra,
      });
    };

    if (fileProvider) {
      const entry = catalog.match({ api_url: fileProvider.baseUrl, model_name: fileProvider.model }).entry;
      const proto = inferCatalogEntryProtocol(entry);
      const iface = fileProvider.interfaceType ?? proto?.interface_type ?? 'anthropic-messages';
      addModelEntry(
        fileProvider.model,
        entry?.name ?? fileProvider.model,
        entry?.provider ?? 'configured',
        '2026-01-01T00:00:00Z',
        { interface_type: iface, ...(entry ? { capabilities: entryCapabilities(entry) } : {}) },
      );
    }

    const candidates: Row[] = [];
    if (primaryModel) {
      const row = store.get('SELECT * FROM models WHERE id=?', primaryModel.id);
      if (row) candidates.push(row);
    }
    if (allowVisibleModels) {
      for (const row of visibleModelRows()) {
        if (row.api_key !== null && !candidates.some(c => c.id === row.id)) candidates.push(row);
      }
    }
    for (const row of candidates) {
      const caps = modelCapabilities(store, row as any);
      const proto = modelProtocol(store, row as any);
      const entry = caps.catalog.entry;
      addModelEntry(
        String(row.model_name),
        entry?.name ?? String(row.model_name),
        entry?.provider ?? 'configured',
        String(row.updated_at || '2026-01-01T00:00:00Z'),
        {
          interface_type: proto.interface_type,
          capabilities: {
            context_window: caps.context_window,
            max_output_tokens: caps.max_output_tokens,
            reasoning: caps.reasoning,
            image_input: caps.image_input,
          },
        },
      );
      if (entry && entry.model !== row.model_name) {
        addModelEntry(
          entry.model,
          entry.name,
          entry.provider,
          String(row.updated_at || '2026-01-01T00:00:00Z'),
          { interface_type: proto.interface_type, capabilities: entryCapabilities(entry) },
        );
      }
    }

    return {
      object: 'list',
      data: items,
      has_more: false,
      first_id: items[0]?.id ?? null,
      last_id: items.at(-1)?.id ?? null,
    };
  };

  const resolveTargetModel = (requestedModel: string): ResolvedTargetModel | null => {
    if (fileProvider && matchesModelIdentity(store, { api_url: fileProvider.baseUrl, model_name: fileProvider.model }, requestedModel)) {
      const key = fileProvider.apiKey ? fileProvider.apiKey : readProviderCredentialFile(fileProvider.credentialFile || '').key;
      redactor.add(key);
      const entry = modelCatalog(store).match({ api_url: fileProvider.baseUrl, model_name: fileProvider.model }).entry;
      const inferred = inferCatalogEntryProtocol(entry);
      let host = '';
      try { host = new URL(fileProvider.baseUrl).hostname.toLowerCase(); } catch {}
      const trimmed = fileProvider.baseUrl.replace(/\/$/, '');
      const urlInterface: ModelInterfaceType | null = /\/messages$/.test(trimmed)
        ? 'anthropic-messages'
        : /\/responses$/.test(trimmed)
          ? 'openai-responses'
          : /\/chat\/completions$/.test(trimmed)
            ? 'openai-chat-completions'
            : null;
      const interfaceType: ModelInterfaceType = fileProvider.interfaceType ?? urlInterface ?? inferred?.interface_type ?? 'anthropic-messages';
      const authHeader =
        fileProvider.authHeader ??
        inferred?.auth_header ??
        (interfaceType === 'anthropic-messages' || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')
          ? 'x-api-key'
          : 'bearer');
      const maxOut = explicitMaxTokens ?? entry?.capabilities.max_output_tokens ?? 8192;
      const pricing: Pricing | null =
        fileProvider.pricing !== undefined
          ? fileProvider.pricing
          : entry?.cost
            ? {
                currency: 'USD',
                input_per_million: entry.cost.input,
                output_per_million: entry.cost.output,
                cache_per_million: entry.cost.cache_read ?? entry.cost.input,
              }
            : null;
      return {
        id: fileProvider.id ?? 'external:provider_requests',
        model: fileProvider.model,
        url: fileProvider.baseUrl,
        key,
        pricing,
        interfaceType,
        authHeader,
        maxOutputTokens: maxOut,
      };
    }

    const openCheckedRow = (row: Row, pinVersion?: RuntimeModel): ResolvedTargetModel => {
      if (!row.api_key) {
        throw new TaskError('model_not_configured', 'waiting_configuration', '固定模型的凭据已撤销；重新设置 Key 后可以继续。');
      }
      if (
        pinVersion &&
        (Number(row.version) !== pinVersion.version ||
          String(row.api_url) !== pinVersion.url ||
          String(row.model_name) !== pinVersion.model)
      ) {
        throw new TaskError('model_configuration_changed', 'waiting_configuration', '任务运行期间模型配置已变化，请重新启动任务。');
      }
      const opened = openModel(store, row);
      redactor.add(opened.key);
      const proto = opened.protocol ?? modelProtocol(store, row as any);
      const maxOut = explicitMaxTokens ?? opened.capabilities?.max_output_tokens ?? 8192;
      return {
        id: opened.id,
        model: opened.model,
        url: opened.url,
        key: opened.key,
        pricing: pricingFor(store, opened.id),
        interfaceType: proto.interface_type,
        authHeader: proto.auth_header,
        maxOutputTokens: maxOut,
      };
    };

    if (
      primaryModel &&
      (requestedModel === 'selected' ||
        matchesModelIdentity(store, { id: primaryModel.id, api_url: primaryModel.url, model_name: primaryModel.model }, requestedModel))
    ) {
      const visible = visibleModelRows().find(r => String(r.id) === primaryModel.id);
      if (!visible) {
        const msg =
          task.kind === 'memory.consolidation'
            ? '夜间记忆整理所选模型已被更换、删除或不再授权给当前范围。'
            : task.kind === 'channel.service'
              ? '本群聊助手的模型已被更换、删除或不再授权给这个项目。'
              : task.service_role_id
                ? '管理助手的模型已被更换、删除或不再授权给这个项目。'
                : '任务模型已被删除或撤销项目访问权限。';
        throw new TaskError('model_not_available', 'waiting_configuration', msg);
      }
      return openCheckedRow(visible, primaryModel);
    }

    if (allowVisibleModels) {
      const rows = visibleModelRows().filter(r => r.api_key !== null);
      const matched = rows.find(r => matchesModelIdentity(store, r as any, requestedModel));
      if (matched) return openCheckedRow(matched);
    }

    return null;
  };

  const sendJson = (
    res: ServerResponse,
    status: number,
    payload: string,
    extraHeaders?: Record<string, string>,
  ) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
    res.end(payload);
  };

  const handleHttp = async (
    req: IncomingMessage,
    res: ServerResponse,
    endpoint: 'models' | DownstreamEndpoint,
    query: string,
    presentedToken: string,
  ): Promise<void> => {
    const requestAbort = new AbortController();
    const combinedSignal = AbortSignal.any([sessionAbort.signal, requestAbort.signal]);
    let clientClosed = false;
    const onClientClose = () => {
      if (!res.writableEnded) {
        clientClosed = true;
        requestAbort.abort(new Error('client_cancelled'));
      }
    };
    req.once('aborted', onClientClose);
    res.once('close', onClientClose);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => requestAbort.abort(new Error('provider_timeout')), ms);
      timer.unref?.();
    };

    let requestLogId: string | null = null;
    let streamedAny = false;
    let upstreamStatus: number | null = null;
    let finalUsage: CanonicalUsage = { input_tokens: null, output_tokens: null, cached_input_tokens: null };
    let secretToScrub = '';

    const recordResponseTrajectory = (value: unknown) => {
      if (!requestLogId) return;
      const cleaned = redactor.clean(value);
      const scope = store.trajectories.scopeOf(task);
      if (scope) {
        store.run(
          'UPDATE model_requests SET response_ref=? WHERE id=?',
          store.trajectories.appendModelResponse(scope, requestLogId, cleaned),
          requestLogId,
        );
      } else {
        const snap = task.conversation_id
          ? store.secrets.seal({ snapshot: traceSnapshot(cleaned) }, 'conversation-model-response:' + requestLogId)
          : traceSnapshot(cleaned);
        store.run('UPDATE model_requests SET response_snapshot=? WHERE id=?', snap, requestLogId);
      }
    };

    const work = (async () => {
      try {
        try {
          await checkLiveAuthorization(presentedToken);
        } catch (err) {
          const code = err instanceof TaskError ? err.code : 'authentication_error';
          const status = code === 'repository_policy_disabled' ? 403 : 401;
          sendJson(res, status, formatErrorPayload(endpoint, code));
          return;
        }

        if (endpoint === 'models') {
          sendJson(res, 200, JSON.stringify(buildModelsListResponse()), {
            'x-bot-run-id': runId,
            'x-bot-lease-epoch': String(leaseEpoch),
          });
          return;
        }

        // Stream request body with hard size ceiling.
        const chunks: Buffer[] = [];
        let rawBytes = 0;
        let tooLarge = false;
        for await (const part of req) {
          const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
          rawBytes += buf.length;
          if (rawBytes > maxRequestBytes) {
            tooLarge = true;
            break;
          }
          chunks.push(buf);
        }
        if (tooLarge) {
          sendJson(
            res,
            413,
            formatErrorPayload(
              endpoint,
              'request_too_large',
              `Request payload exceeded the ${Math.round(maxRequestBytes / (1024 * 1024))} MiB model gateway limit. Resize, compress or crop large images or inspect fewer images per request.`,
            ),
          );
          req.resume();
          return;
        }
        if (clientClosed || combinedSignal.aborted) return;

        let parsedBody: any;
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          sendJson(res, 400, formatErrorPayload(endpoint, 'invalid_request_error', 'Invalid JSON request body'));
          return;
        }
        if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
          sendJson(res, 400, formatErrorPayload(endpoint, 'invalid_request_error', 'Request body must be a JSON object'));
          return;
        }

        const rawBody: Record<string, any> = redactor.clean(parsedBody);
        const downstreamFormat = endpointToFormat(endpoint);

        try {
          await checkLiveAuthorization(presentedToken);
        } catch (err) {
          const taskErr = err instanceof TaskError ? err : new TaskError('run_token_invalid', 'failed', String(err));
          sendJson(res, 401, formatErrorPayload(endpoint, taskErr.code, taskErr.detail ?? taskErr.code));
          return;
        }

        const isSubagent = req.headers['x-bot-subagent'] === '1';
        if (beforeRequest) {
          try {
            const rejected = await beforeRequest({
              endpoint,
              format: downstreamFormat,
              body: rawBody,
              rawBytes,
              headers: req.headers,
              isSubagent,
            });
            if (rejected) {
              sendJson(res, rejected.status, formatErrorPayload(endpoint, rejected.code, rejected.message));
              return;
            }
          } catch (err) {
            const taskErr = err instanceof TaskError
              ? err
              : new TaskError('model_request_invalid', 'failed', String((err as Error)?.message ?? err));
            onSessionFault?.(taskErr);
            const status =
              taskErr.code === 'role_revision_checkpoint'
                ? 409
                : taskErr.code === 'agent_turn_limit' || taskErr.code === 'role_budget_exhausted'
                  ? 429
                  : 400;
            sendJson(res, status, formatErrorPayload(endpoint, taskErr.code, taskErr.detail ?? taskErr.code));
            return;
          }
        }

        const requestedModel = typeof rawBody.model === 'string' ? rawBody.model.trim() : '';
        if (!requestedModel) {
          sendJson(res, 400, formatErrorPayload(endpoint, 'invalid_request_error', 'missing_model'));
          return;
        }

        let target: ResolvedTargetModel | null;
        try {
          target = resolveTargetModel(requestedModel);
        } catch (err) {
          const taskErr = err instanceof TaskError ? err : new TaskError('model_not_available', 'waiting_configuration', String(err));
          onSessionFault?.(taskErr);
          sendJson(res, 503, formatErrorPayload(endpoint, taskErr.code, taskErr.detail ?? taskErr.code));
          return;
        }
        if (!target) {
          sendJson(res, 403, formatErrorPayload(endpoint, 'model_not_allowed', `Model '${requestedModel}' is not authorized for this run.`));
          return;
        }
        secretToScrub = target.key;

        // Strict passthrough invariant: endpoint protocol MUST match the bound model's effective protocol.
        if (downstreamFormat !== target.interfaceType) {
          sendJson(
            res,
            400,
            formatErrorPayload(
              endpoint,
              'model_protocol_mismatch',
              `Model '${target.model}' uses protocol '${target.interfaceType}', which does not match '${downstreamFormat}'. Cross-protocol conversion is not supported.`,
            ),
          );
          return;
        }

        if (beforeModel) {
          try {
            await beforeModel();
          } catch (err) {
            const taskErr = err instanceof TaskError ? err : new TaskError('role_budget_exhausted', 'waiting_configuration', String(err));
            const status = taskErr.code === 'role_budget_exhausted' || taskErr.code === 'stage_budget_exhausted' ? 429 : 401;
            sendJson(res, status, formatErrorPayload(endpoint, taskErr.code, taskErr.detail ?? taskErr.code));
            return;
          }
        }

        const upstreamBody = redactor.clean(patchPassthroughRequest(
          target.interfaceType,
          rawBody,
          target.model,
          target.maxOutputTokens,
          allowedTools ? { allowedTools } : undefined,
        ));

        const clientRequestId = randomUUID();
        const ledgerTask = { ...task, id: task.id && store.get('SELECT id FROM tasks WHERE id=?', task.id) ? task.id : null };
        requestLogId = beginModelRequest(
          store,
          ledgerTask,
          `${task.kind ?? 'role'}:${task.id ?? runId}:gateway:${++requestSeq}:${clientRequestId}`,
          { id: target.id, model: target.model, pricing: target.pricing },
        );
        const scope = store.trajectories.scopeOf(task);
        const capturedRequest = redactor.clean(rawBody);
        const recordedRunId = task.trace_run_id ?? runId;
        store.run("DELETE FROM model_requests WHERE run_id=? AND accounting_source='codex_events'", recordedRunId);
        if (scope) {
          store.run(
            'UPDATE model_requests SET run_id=?,request_ref=? WHERE id=?',
            recordedRunId,
            store.trajectories.appendModelRequest(scope, requestLogId, capturedRequest),
            requestLogId,
          );
        } else {
          const snap = task.conversation_id
            ? store.secrets.seal({ snapshot: traceSnapshot(capturedRequest) }, 'conversation-model-request:' + requestLogId)
            : traceSnapshot(capturedRequest);
          store.run('UPDATE model_requests SET run_id=?,request_ref=NULL,request_snapshot=? WHERE id=?', recordedRunId, snap, requestLogId);
        }

        let wireUrl = resolveModelWireUrl(target.url, target.interfaceType);
        if (query && !wireUrl.includes('?')) {
          wireUrl += query;
        }

        const reqHeaders: Record<string, string> = {
          'content-type': 'application/json',
          'x-client-request-id': clientRequestId,
        };
        for (const [k, v] of Object.entries(req.headers)) {
          const lower = k.toLowerCase();
          if (FORWARDED_REQUEST_HEADERS.has(lower) && typeof v === 'string' && v.trim()) {
            reqHeaders[lower] = v;
          }
        }
        if (target.interfaceType === 'anthropic-messages' && !reqHeaders['anthropic-version']) {
          reqHeaders['anthropic-version'] = '2023-06-01';
        }
        if (target.authHeader === 'x-api-key') {
          delete reqHeaders.authorization;
          reqHeaders['x-api-key'] = target.key;
        } else {
          delete reqHeaders['x-api-key'];
          reqHeaders.Authorization = 'Bearer ' + target.key;
        }

        armTimeout(timing.firstByteMs);
        const pendingFetch = fetcher(wireUrl, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(upstreamBody),
          redirect: 'error',
          signal: combinedSignal,
        });
        void pendingFetch.catch(() => {});
        const upstream = await normalizeResponseFraming(await pendingFetch);
        upstreamStatus = upstream.status;
        armTimeout(timing.idleMs);

        await checkLiveAuthorization(presentedToken);

        if (!upstream.ok) {
          const errChunks: Buffer[] = [];
          let errBytes = 0;
          if (upstream.body) {
            for await (const chunk of Readable.fromWeb(upstream.body as any)) {
              errBytes += chunk.length;
              if (errBytes <= 512 * 1024) errChunks.push(Buffer.from(chunk));
              else break;
            }
          }
          const rawErr = scrubSecrets(Buffer.concat(errChunks).toString('utf8'), redactor, secretToScrub);
          let parsedErr: any = null;
          try { parsedErr = JSON.parse(rawErr); } catch {}
          recordResponseTrajectory(parsedErr ?? { status: upstream.status, error: rawErr.slice(0, 2000) });
          const rejectedClientUsage =
            upstream.status >= 400 && upstream.status < 500
              ? { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }
              : null;
          finishModelRequest(store, requestLogId, rejectedClientUsage, upstream.status, 'http_error', false);
          const errHeaders: Record<string, string> = {
            'content-type': upstream.headers.get('content-type') || 'application/json',
          };
          const retryAfter = upstream.headers.get('retry-after');
          if (retryAfter) errHeaders['retry-after'] = retryAfter;
          const errBody = rawErr || formatErrorPayload(endpoint, 'api_error', `upstream_http_${upstream.status}`);
          sendJson(res, upstream.status, errBody, errHeaders);
          onUpstreamHttpError?.(upstream.status, extractUpstreamErrorMessage(parsedErr) || rawErr.slice(0, 300));
          return;
        }

        const upstreamContentType = upstream.headers.get('content-type') || 'application/json';
        const upstreamIsSse = upstreamContentType.includes('text/event-stream');
        let deltaChain = Promise.resolve();
        const tap = new PassthroughTap(
          target.interfaceType,
          upstreamIsSse,
          target.model,
          onTextDelta && !isSubagent
            ? delta => {
                const cleaned = scrubSecrets(delta, redactor, secretToScrub);
                if (cleaned) {
                  deltaChain = deltaChain.then(() => onTextDelta(cleaned)).catch(() => {});
                }
              }
            : undefined,
        );

        const responseHeaders: Record<string, string> = {
          'content-type': upstreamContentType,
          ...(upstreamIsSse ? { 'cache-control': 'no-cache' } : {}),
        };
        const emitChunk = async (chunk: Buffer | string) => {
          if (!chunk.length || clientClosed || res.destroyed) return;
          if (!res.headersSent) {
            res.writeHead(upstream.status, responseHeaders);
            res.flushHeaders?.();
          }
          streamedAny = true;
          await writeChunk(res, chunk);
        };

        const holdLimit = Math.max(0, maxSecretLength(redactor, secretToScrub) - 1);
        const textDecoder = holdLimit > 0 ? new TextDecoder('utf-8', { fatal: false }) : null;
        let scrubPending = '';
        let totalBytes = 0;
        let lastAuthCheck = Date.now();

        if (upstream.body) {
          const bodyStream = Readable.fromWeb(upstream.body as any);
          const onAbortStream = () => {
            bodyStream.destroy((combinedSignal.reason as Error) ?? new Error('aborted'));
          };
          if (combinedSignal.aborted) onAbortStream();
          else combinedSignal.addEventListener('abort', onAbortStream, { once: true });
          try {
            for await (const rawChunk of bodyStream) {
              armTimeout(timing.idleMs);
              const buf = Buffer.from(rawChunk);
              totalBytes += buf.length;
              if (totalBytes > maxUpstreamResponseBytes) throw new Error('response_limit');
              if (clientClosed || combinedSignal.aborted) {
                if (clientClosed && !sessionAbort.signal.aborted && tap.completed) break;
                throw combinedSignal.reason ?? new Error('aborted');
              }
              if (Date.now() - lastAuthCheck >= 1000) {
                lastAuthCheck = Date.now();
                await checkLiveAuthorization(presentedToken);
              }

              tap.push(buf);
              finalUsage = tap.usage;

              if (textDecoder) {
                scrubPending += textDecoder.decode(buf, { stream: true });
                if (upstreamIsSse) {
                  let m: RegExpExecArray | null;
                  let safeOut = '';
                  while ((m = /\r?\n\r?\n/.exec(scrubPending))) {
                    const endIdx = m.index + m[0].length;
                    safeOut += scrubSecrets(scrubPending.slice(0, endIdx), redactor, secretToScrub);
                    scrubPending = scrubPending.slice(endIdx);
                  }
                  if (safeOut) await emitChunk(safeOut);
                } else {
                  scrubPending = scrubSecrets(scrubPending, redactor, secretToScrub);
                  if (scrubPending.length > holdLimit) {
                    let emitLen = scrubPending.length - holdLimit;
                    const lastUnit = scrubPending.charCodeAt(emitLen - 1);
                    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) emitLen -= 1;
                    if (emitLen > 0) {
                      await emitChunk(scrubPending.slice(0, emitLen));
                      scrubPending = scrubPending.slice(emitLen);
                    }
                  }
                }
              } else {
                await emitChunk(buf);
              }
            }
          } catch (streamErr) {
            // Clients like Codex CLI close the SSE connection right after receiving a terminal event
            // (response.completed / message_stop / [DONE]) before upstream closes the TCP stream.
            if (!(clientClosed && !sessionAbort.signal.aborted && tap.completed)) throw streamErr;
          } finally {
            combinedSignal.removeEventListener('abort', onAbortStream);
          }
        }

        if ((clientClosed || combinedSignal.aborted) && !(clientClosed && !sessionAbort.signal.aborted && tap.completed)) {
          throw combinedSignal.reason ?? new Error('aborted');
        }

        const summary = tap.end();
        finalUsage = tap.usage;
        await deltaChain;

        if (textDecoder) {
          const rest = scrubPending + textDecoder.decode();
          if (rest) await emitChunk(scrubSecrets(rest, redactor, secretToScrub));
        }

        if (!res.headersSent) {
          res.writeHead(upstream.status, responseHeaders);
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }

        recordResponseTrajectory(summary);
        finishModelRequest(store, requestLogId, accountingUsagePayload(finalUsage), upstream.status, 'received', true);
        try {
          onResponseComplete?.(summary, tap, isSubagent);
        } catch (inspectErr) {
          if (inspectErr instanceof TaskError) onSessionFault?.(inspectErr);
        }
      } catch (err: any) {
        const isTimeout =
          err?.message === 'provider_timeout' ||
          (combinedSignal.aborted && (combinedSignal.reason as any)?.message === 'provider_timeout');
        if (requestLogId) {
          try {
            const errCode = clientClosed
              ? 'client_cancelled'
              : err instanceof TaskError
                ? err.code
                : isTimeout
                  ? 'provider_timeout'
                  : 'transport_error';
            recordResponseTrajectory({ error: errCode, detail: redactor.text(String(err?.message || errCode)).slice(0, 500) });
            const hasPartialUsage = finalUsage.input_tokens !== null || finalUsage.output_tokens !== null;
            finishModelRequest(
              store,
              requestLogId,
              hasPartialUsage ? accountingUsagePayload(finalUsage) : null,
              upstreamStatus,
              errCode === 'client_cancelled' ? 'cancelled' : err instanceof TaskError ? 'guard_failed' : 'transport_error',
              streamedAny || hasPartialUsage,
            );
          } catch {
            // Storage failure during error cleanup must not escape request teardown.
          }
        }
        if (!clientClosed && !(err instanceof TaskError)) {
          const transportReason = isTimeout
            ? `连续 ${Math.round(timing.idleMs / 1000)} 秒没有响应`
            : networkReason(err, timing.idleMs);
          onUpstreamTransportError?.(transportReason);
        }
        if (!clientClosed && !res.writableEnded && !res.destroyed) {
          const code = err instanceof TaskError ? err.code : isTimeout ? 'provider_timeout' : 'api_error';
          const detail = redactor.text(String(err?.message || code)).slice(0, 300);
          if (!res.headersSent) {
            sendJson(res, err instanceof TaskError ? 401 : 502, formatErrorPayload(endpoint, code, detail));
          } else {
            const ct = String(res.getHeader('content-type') || '');
            if (ct.includes('text/event-stream') && endpoint !== 'models') {
              await writeChunk(res, formatSseErrorEvent(endpoint, code, detail)).catch(() => {});
            }
            res.end();
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
        req.off('aborted', onClientClose);
        res.off('close', onClientClose);
        requestAbort.abort();
      }
    })();

    inFlight.add(work);
    try {
      await work;
    } finally {
      inFlight.delete(work);
    }
  };

  return {
    token: runAccess.token,
    handleHttp,
    activeCount: () => inFlight.size,
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
    async close() {
      closed = true;
      signal?.removeEventListener('abort', onParentAbort);
      sessionAbort.abort(new Error('gateway_closed'));
      await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * Control-plane HTTP model passthrough gateway hub.
 * Serves identical HTTP handlers over a dedicated read-only mounted UDS socket (in Docker deployments)
 * and/or a ref-counted loopback TCP listener (for local runners and in-process tests).
 */
export class ModelGatewayHub {
  private sessions = new Map<string, RegisteredSession>();
  private udsServer: Server | null = null;
  private udsSocketPath: string | null = null;
  private loopbackServer: Server | null = null;
  private loopbackUrl: string | null = null;
  private loopbackStart: Promise<string> | null = null;
  private loopbackRefs = 0;

  private readonly onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const route = parseRoute(req.url, req.method);
    if (!route) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(formatErrorPayload('chat_completions', 'endpoint_not_allowed'));
      return;
    }
    const token = extractPresentedToken(req.headers);
    const session = token ? this.sessions.get(token) : undefined;
    if (!session) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(formatErrorPayload(route.endpoint, 'run_token_invalid'));
      return;
    }
    void session.handleHttp(req, res, route.endpoint, route.query, token).catch(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(formatErrorPayload(route.endpoint, 'api_error'));
      }
    });
  };

  get socketPath(): string | null {
    return this.udsSocketPath;
  }

  /**
   * Handles a proxied HTTP request (e.g. from a remote node-agent relaying container `/run/model-gateway/gateway.sock`
   * traffic over an authenticated cluster session). Authentication still strictly requires a live `rrt_...` run token
   * and all API keys remain exclusively on the control plane.
   */
  handleIncoming(req: IncomingMessage, res: ServerResponse): void {
    this.onRequest(req, res);
  }

  async startUds(socketPath: string): Promise<ModelGatewayServerHandle> {
    if (Buffer.byteLength(socketPath, 'utf8') >= 104) {
      throw new Error(`model_gateway_socket_path_too_long (${Buffer.byteLength(socketPath, 'utf8')} bytes): ${socketPath}`);
    }
    if (this.udsServer) {
      if (this.udsSocketPath === socketPath) {
        return { socketPath, close: () => this.closeUds() };
      }
      await this.closeUds();
    }
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o755 });
    try { unlinkSync(socketPath); } catch {}
    const server = createServer(this.onRequest);
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 60_000;
    try {
      server.listen(socketPath);
      await once(server, 'listening');
      chmodSync(socketPath, 0o660);
    } catch (err) {
      server.closeAllConnections?.();
      try { await new Promise<void>(resolve => server.close(() => resolve())); } catch {}
      try { unlinkSync(socketPath); } catch {}
      throw err;
    }
    this.udsServer = server;
    this.udsSocketPath = socketPath;
    return { socketPath, close: () => this.closeUds() };
  }

  async closeUds(): Promise<void> {
    const server = this.udsServer;
    const sock = this.udsSocketPath;
    this.udsServer = null;
    this.udsSocketPath = null;
    if (server) {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (sock) {
      try { unlinkSync(sock); } catch {}
    }
  }

  private async acquireLoopback(): Promise<string> {
    this.loopbackRefs++;
    if (this.loopbackUrl) return this.loopbackUrl;
    if (!this.loopbackStart) {
      this.loopbackStart = (async () => {
        const server = createServer(this.onRequest);
        server.requestTimeout = 0;
        server.headersTimeout = 60_000;
        server.keepAliveTimeout = 60_000;
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        server.unref?.();
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        this.loopbackServer = server;
        this.loopbackUrl = `http://127.0.0.1:${port}`;
        return this.loopbackUrl;
      })().catch(err => {
        this.loopbackStart = null;
        throw err;
      });
    }
    try {
      return await this.loopbackStart;
    } catch (err) {
      this.loopbackRefs = Math.max(0, this.loopbackRefs - 1);
      throw err;
    }
  }

  private async releaseLoopback(): Promise<void> {
    this.loopbackRefs = Math.max(0, this.loopbackRefs - 1);
    if (this.loopbackRefs > 0) return;
    const server = this.loopbackServer;
    this.loopbackServer = null;
    this.loopbackUrl = null;
    this.loopbackStart = null;
    if (server) {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  async registerSession(options: ModelGatewaySessionOptions): Promise<ModelGatewaySessionHandle> {
    const token = options.runAccess?.token;
    if (!token || typeof token !== 'string') {
      throw new TaskError('run_token_invalid', 'failed', '模型网关会话缺少运行令牌。');
    }
    const session = createRegisteredSession(options);
    const useLoopback = Boolean(options.preferLoopback) || !this.udsServer;
    let gatewayUrl: string | null = null;
    if (useLoopback) {
      gatewayUrl = await this.acquireLoopback();
    }
    this.sessions.set(token, session);
    let closed = false;
    return {
      token,
      gatewayUrl,
      socketPath: useLoopback ? null : this.udsSocketPath,
      get activeCount() {
        return session.activeCount();
      },
      drain: () => session.drain(),
      close: async () => {
        if (closed) return;
        closed = true;
        if (this.sessions.get(token) === session) this.sessions.delete(token);
        await session.close();
        if (useLoopback) await this.releaseLoopback();
      },
    };
  }

  async closeAll(): Promise<void> {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(active.map(s => s.close()));
    this.loopbackRefs = 0;
    await this.releaseLoopback();
    await this.closeUds();
  }
}

export const defaultModelGateway = new ModelGatewayHub();

export function createModelGatewayHub(): ModelGatewayHub {
  return new ModelGatewayHub();
}

export function resolveControlPlaneModelGatewaySocket(
  envValue: string | undefined = process.env.BOT_MODEL_GATEWAY_SOCKET,
  dirExists: (dir: string) => boolean = existsSync,
): string | null {
  if (envValue !== undefined) {
    const trimmed = envValue.trim();
    return trimmed || null;
  }
  return dirExists(dirname(DEFAULT_MODEL_GATEWAY_SOCKET)) ? DEFAULT_MODEL_GATEWAY_SOCKET : null;
}

export function startModelGatewayServer(
  socketPath = process.env.BOT_MODEL_GATEWAY_SOCKET || DEFAULT_MODEL_GATEWAY_SOCKET,
): Promise<ModelGatewayServerHandle> {
  return defaultModelGateway.startUds(socketPath);
}

export function closeModelGatewayServer(): Promise<void> {
  return defaultModelGateway.closeAll();
}

export function modelGatewaySocketPath(): string | null {
  return defaultModelGateway.socketPath;
}

export function registerModelGatewaySession(
  options: ModelGatewaySessionOptions,
): Promise<ModelGatewaySessionHandle> {
  return defaultModelGateway.registerSession(options);
}
