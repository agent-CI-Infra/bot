import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { normalizeResponseFraming } from './response-framing.js';
import type { Row, Store } from '../storage/database.js';
import { traceSnapshot } from '../tasks/trace.js';
import { TaskError, type Redactor } from '../agent/common.js';
import type { AgentSpec } from '../agent/runtime.js';
import { openModel, resolveModelWireUrl, type RuntimeModel } from '../agent/model.js';
import { beginModelRequest, finishModelRequest, pricingFor, type Pricing } from '../metrics/accounting.js';
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
  DownstreamResponseBuilder,
  endpointToFormat,
  formatSseErrorEvent,
  parseDownstreamRequest,
  patchPassthroughRequest,
  serializeUpstreamRequest,
  UpstreamStreamDecoder,
  type CanonicalUsage,
  type DownstreamEndpoint,
} from './model-formats.js';

export const maxModelReplyChunkBytes = 30_000;
export const maxMailboxModelRequestBytes = 20 * 1024 * 1024;
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

export interface PolledModelRequestEntry {
  id: string;
  size: number;
  chunked?: boolean;
  stub?: boolean;
  data?: MailboxModelEnvelope;
}

export interface MailboxModelEnvelope {
  id: string;
  endpoint: 'models' | DownstreamEndpoint;
  query?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: Record<string, any> | null;
}

export interface MailboxModelGatewayOptions {
  store: Store;
  task: Row;
  runId: string;
  leaseEpoch: number;
  runAccess: NonNullable<AgentSpec<any>['runAccess']>;
  redactor: Redactor;
  runner: (input: Record<string, unknown>) => Promise<any>;
  workspaceId?: string;
  primaryModel?: RuntimeModel;
  fileProvider?: FileBackedModelProvider;
  allowVisibleModels?: boolean;
  guard?: () => Promise<void>;
  beforeModel?: () => Promise<void>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  timing?: { firstByteMs: number; idleMs: number; keepaliveMs?: number };
  fetcher?: typeof fetch;
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

export const abandonedModelRequest = (sent: { error?: string; detail?: string } | null | undefined): boolean =>
  sent?.error === 'agent_request_changed'
  || (sent?.error === 'runner_operation_failed' && typeof sent?.detail === 'string' && sent.detail.includes('agent_request_changed'));

class StreamReplyWriter {
  private queue: Buffer[] = [];
  private offset = 0;
  private headersReady = false;
  private statusSent = false;
  private status = 200;
  private headers: Record<string, string> = { 'content-type': 'application/json' };
  private done = false;
  private errorMsg: string | null = null;
  private sequence = 0;
  private pendingKeepalive = false;
  private flushing: Promise<void> | null = null;
  private notify: (() => void) | null = null;
  abortedByClient = false;
  fatalError: unknown = null;

  constructor(
    private readonly requestId: string,
    private readonly workspaceId: string | undefined,
    private readonly runner: (input: Record<string, unknown>) => Promise<any>,
    private readonly onClientAbort: () => void,
  ) {}

  get headersCommitted(): boolean {
    return this.headersReady;
  }

  get responseContentType(): string {
    return String(this.headers?.['content-type'] || '');
  }

  startResponse(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    this.headersReady = true;
    this.scheduleFlush();
  }

  push(chunk: Buffer | string) {
    if (this.done || this.abortedByClient || this.fatalError) return;
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (buf.length > 0) {
      this.queue.push(buf);
      this.scheduleFlush();
    }
  }

  keepalive() {
    if (this.done || this.abortedByClient || this.fatalError) return;
    this.sequence++;
    this.pendingKeepalive = true;
    this.scheduleFlush();
  }

  async finish(): Promise<void> {
    this.headersReady = true;
    this.done = true;
    this.scheduleFlush();
    if (this.flushing) await this.flushing;
  }

  async fail(code: string): Promise<void> {
    this.errorMsg = code;
    this.done = true;
    this.scheduleFlush();
    if (this.flushing) await this.flushing;
  }

  private scheduleFlush() {
    if (this.notify) {
      const wake = this.notify;
      this.notify = null;
      wake();
    }
    if (!this.flushing) {
      this.flushing = this.runLoop().finally(() => { this.flushing = null; });
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.abortedByClient && !this.fatalError) {
      const queuedBytes = this.queue.reduce((n, b) => n + b.length, 0);
      const needHeaderOnly = this.headersReady && !this.statusSent && queuedBytes === 0 && !this.done && !this.errorMsg;
      if (queuedBytes === 0 && !needHeaderOnly && !this.pendingKeepalive && !this.done && !this.errorMsg) {
        await new Promise<void>(resolve => { this.notify = resolve; });
        if (this.queue.length === 0 && !this.pendingKeepalive && !this.done && !this.errorMsg && (!this.headersReady || this.statusSent)) break;
        continue;
      }

      const slice = this.takeBytes(maxModelReplyChunkBytes);
      const remaining = this.queue.reduce((n, b) => n + b.length, 0);
      const isFinal = (this.done || !!this.errorMsg) && remaining === 0;
      const sendStatus = this.headersReady && !this.statusSent;
      this.pendingKeepalive = false;

      const call: Record<string, unknown> = {
        type: 'workspace_agent_model_reply',
        ...(this.workspaceId ? { workspace_id: this.workspaceId } : {}),
        request_id: this.requestId,
        offset: this.offset,
        base64: slice.toString('base64'),
        ...(sendStatus ? { status: this.status, headers: this.headers } : {}),
        ...(this.sequence > 0 ? { sequence: this.sequence } : {}),
        ...(isFinal ? { final: true } : {}),
        ...(isFinal && this.errorMsg ? { error: this.errorMsg } : {}),
      };

      try {
        const res = await this.runner(call);
        if (abandonedModelRequest(res)) {
          this.abortedByClient = true;
          this.onClientAbort();
          return;
        }
        if (res && typeof res === 'object' && typeof (res as any).error === 'string') {
          this.fatalError = Object.assign(new Error(String((res as any).detail || (res as any).error)), { code: (res as any).error });
          this.onClientAbort();
          return;
        }
        if (sendStatus) this.statusSent = true;
        this.offset += slice.length;
      } catch (err: any) {
        const msg = String(err?.detail || err?.message || '');
        if (msg.includes('agent_request_changed')) {
          this.abortedByClient = true;
          this.onClientAbort();
          return;
        }
        this.fatalError = err;
        this.onClientAbort();
        return;
      }

      if (isFinal) return;
    }
  }

  private takeBytes(limit: number): Buffer {
    if (!this.queue.length) return Buffer.alloc(0);
    if (this.queue[0]!.length > limit) {
      const head = this.queue[0]!.subarray(0, limit);
      this.queue[0] = this.queue[0]!.subarray(limit);
      return head;
    }
    const parts: Buffer[] = [];
    let total = 0;
    while (this.queue.length && total + this.queue[0]!.length <= limit) {
      const part = this.queue.shift()!;
      parts.push(part);
      total += part.length;
    }
    if (this.queue.length && total < limit) {
      const need = limit - total;
      parts.push(this.queue[0]!.subarray(0, need));
      this.queue[0] = this.queue[0]!.subarray(need);
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }
}

function formatErrorPayload(endpoint: MailboxModelEnvelope['endpoint'], code: string, message = code): string {
  if (endpoint === 'messages') return JSON.stringify({ type: 'error', error: { type: code, message } });
  return JSON.stringify({ error: { message, type: code, code } });
}

function scrubSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

function matchesModelIdentity(store: Store, candidate: { id?: string; api_url: string; model_name: string }, requested: string): boolean {
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

export function createMailboxModelGateway(options: MailboxModelGatewayOptions) {
  const {
    store,
    task,
    runId,
    leaseEpoch,
    runAccess,
    redactor,
    runner,
    workspaceId,
    primaryModel,
    fileProvider,
    allowVisibleModels = true,
    guard,
    beforeModel,
    maxOutputTokens: explicitMaxTokens,
    signal,
    timing = { firstByteMs: 120_000, idleMs: 120_000 },
    fetcher = fetch,
  } = options;

  const gatewayAbort = new AbortController();
  const onParentAbort = () => gatewayAbort.abort(signal?.reason ?? new Error('gateway_closed'));
  if (signal) {
    if (signal.aborted) gatewayAbort.abort(signal.reason);
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let closed = false;
  let requestSeq = 0;
  const inFlight = new Map<string, Promise<void>>();
  const handledIds = new Set<string>();

  const checkLiveAuthorization = async (token: unknown) => {
    if (closed || gatewayAbort.signal.aborted) throw new TaskError('run_token_revoked', 'cancelled');
    runAccess.check(token, 'model:invoke');
    if (task.repository_id) {
      const policy = store.get('SELECT enabled FROM policies WHERE repository_id=?', task.repository_id);
      if (policy && !policy.enabled) throw new TaskError('repository_policy_disabled', 'cancelled', '项目已停用');
    }
    await guard?.();
  };

  const visibleModelRows = (): Row[] => {
    if (task.service_role_id && !task.repository_id) {
      return store.all('SELECT m.* FROM models m JOIN service_roles s ON s.model_id=m.id WHERE m.repository_id IS NULL AND s.id=? AND s.enabled=1', task.service_role_id);
    }
    if (task.repository_id) {
      return store.all(
        `SELECT m.* FROM models m WHERE m.repository_id=? OR (m.repository_id IS NULL AND (m.restricted=0 OR EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?))) ORDER BY m.updated_at DESC`,
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
    const addModelEntry = (id: string, displayName: string, provider: string, createdAt: string, extra?: Record<string, any>) => {
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
        { interface_type: proto.interface_type, capabilities: { context_window: caps.context_window, max_output_tokens: caps.max_output_tokens, reasoning: caps.reasoning, image_input: caps.image_input } },
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

  const resolveTargetModel = (requestedModel: string, downstreamFormat: ModelInterfaceType): ResolvedTargetModel | null => {
    const isOpenAiOfficialHost = (url: string) => {
      try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'api.openai.com' || host.endsWith('.openai.com');
      } catch {
        return false;
      }
    };

    if (fileProvider && matchesModelIdentity(store, { api_url: fileProvider.baseUrl, model_name: fileProvider.model }, requestedModel)) {
      const key = fileProvider.apiKey ? fileProvider.apiKey : readProviderCredentialFile(fileProvider.credentialFile || '').key;
      redactor.add(key);
      const entry = modelCatalog(store).match({ api_url: fileProvider.baseUrl, model_name: fileProvider.model }).entry;
      const inferred = inferCatalogEntryProtocol(entry);
      let host = ''; try { host = new URL(fileProvider.baseUrl).hostname.toLowerCase(); } catch {}
      const trimmed = fileProvider.baseUrl.replace(/\/$/, '');
      const urlInterface: ModelInterfaceType | null = /\/messages$/.test(trimmed) ? 'anthropic-messages'
        : /\/responses$/.test(trimmed) ? 'openai-responses'
        : /\/chat\/completions$/.test(trimmed) ? 'openai-chat-completions' : null;
      const baseInterface = fileProvider.interfaceType ?? urlInterface ?? inferred?.interface_type ?? 'anthropic-messages';
      const interfaceType: ModelInterfaceType = !fileProvider.interfaceType
        && !urlInterface
        && downstreamFormat === 'openai-responses'
        && baseInterface === 'openai-chat-completions'
        && isOpenAiOfficialHost(fileProvider.baseUrl)
        ? 'openai-responses'
        : baseInterface;
      const authHeader = fileProvider.authHeader ?? inferred?.auth_header ?? (interfaceType === 'anthropic-messages' || host === 'api.anthropic.com' || host.endsWith('.anthropic.com') ? 'x-api-key' : 'bearer');
      const maxOut = explicitMaxTokens ?? entry?.capabilities.max_output_tokens ?? 8192;
      const pricing: Pricing | null = fileProvider.pricing !== undefined ? fileProvider.pricing : entry?.cost
        ? { currency: 'USD', input_per_million: entry.cost.input, output_per_million: entry.cost.output, cache_per_million: entry.cost.cache_read ?? entry.cost.input }
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
      if (!row.api_key) throw new TaskError('model_not_configured', 'waiting_configuration', '固定模型的凭据已撤销；重新设置 Key 后可以继续。');
      if (pinVersion && (Number(row.version) !== pinVersion.version || String(row.api_url) !== pinVersion.url || String(row.model_name) !== pinVersion.model)) {
        throw new TaskError('model_configuration_changed', 'waiting_configuration', '任务运行期间模型配置已变化，请重新启动任务。');
      }
      const opened = openModel(store, row);
      redactor.add(opened.key);
      const proto = opened.protocol ?? modelProtocol(store, row as any);
      const interfaceType: ModelInterfaceType = downstreamFormat === 'openai-responses'
        && proto.source !== 'manual'
        && proto.source !== 'url'
        && proto.interface_type === 'openai-chat-completions'
        && isOpenAiOfficialHost(opened.url)
        ? 'openai-responses'
        : proto.interface_type;
      const maxOut = explicitMaxTokens ?? opened.capabilities?.max_output_tokens ?? 8192;
      return {
        id: opened.id,
        model: opened.model,
        url: opened.url,
        key: opened.key,
        pricing: pricingFor(store, opened.id),
        interfaceType,
        authHeader: proto.auth_header,
        maxOutputTokens: maxOut,
      };
    };

    if (primaryModel && matchesModelIdentity(store, { id: primaryModel.id, api_url: primaryModel.url, model_name: primaryModel.model }, requestedModel)) {
      const visible = visibleModelRows().find(r => String(r.id) === primaryModel.id);
      if (!visible) throw new TaskError('model_not_available', 'waiting_configuration', '任务模型已被删除或撤销项目访问权限。');
      return openCheckedRow(visible, primaryModel);
    }

    if (allowVisibleModels) {
      const rows = visibleModelRows().filter(r => r.api_key !== null);
      const matched = rows.find(r => matchesModelIdentity(store, r as any, requestedModel));
      if (matched) return openCheckedRow(matched);
    }

    return null;
  };

  const readChunkedEnvelope = async (requestId: string): Promise<MailboxModelEnvelope | null> => {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      let res: any;
      try {
        res = await runner({
          type: 'workspace_agent_model_request',
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
          request_id: requestId,
          offset,
        });
      } catch (err: any) {
        if (String(err?.detail || err?.message || '').includes('agent_request_changed')) return null;
        throw err;
      }
      if (abandonedModelRequest(res)) return null;
      if (res && typeof res === 'object' && typeof res.error === 'string') {
        throw new Error(String(res.detail || res.error));
      }
      const chunk = Buffer.from(String(res.base64 || ''), 'base64');
      parts.push(chunk);
      offset += chunk.length;
      if (offset > maxMailboxModelRequestBytes + 65536) throw Object.assign(new Error('request_too_large'), { status: 413 });
      if (!chunk.length || offset >= Number(res.size || 0)) break;
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };

  const sendSimpleReply = async (writer: StreamReplyWriter, status: number, headers: Record<string, string>, payload: string) => {
    writer.startResponse(status, headers);
    writer.push(payload);
    await writer.finish();
  };

  const handleRequest = async (entry: PolledModelRequestEntry): Promise<void> => {
    const requestAbort = new AbortController();
    const writer = new StreamReplyWriter(entry.id, workspaceId, runner, () => requestAbort.abort(new Error('client_cancelled')));
    const combinedSignal = AbortSignal.any([gatewayAbort.signal, requestAbort.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const armTimeout = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => requestAbort.abort(new Error('provider_timeout')), ms);
      timer.unref?.();
    };

    let envelope: MailboxModelEnvelope | null = null;
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
        store.run('UPDATE model_requests SET response_ref=? WHERE id=?', store.trajectories.appendModelResponse(scope, requestLogId, cleaned), requestLogId);
      } else {
        const snap = task.conversation_id ? store.secrets.seal({ snapshot: traceSnapshot(cleaned) }, 'conversation-model-response:' + requestLogId) : traceSnapshot(cleaned);
        store.run('UPDATE model_requests SET response_snapshot=? WHERE id=?', snap, requestLogId);
      }
    };

    try {
      try {
        envelope = entry.chunked ? await readChunkedEnvelope(entry.id) : entry.data ?? null;
      } catch (readErr: any) {
        if (readErr?.message === 'request_too_large') {
          await sendSimpleReply(
            writer,
            413,
            { 'content-type': 'application/json' },
            formatErrorPayload('chat_completions', 'request_too_large', `Request payload exceeded the ${Math.round(maxMailboxModelRequestBytes / (1024 * 1024))} MiB model gateway limit. Resize, compress or crop large images or inspect fewer images per request.`),
          );
          return;
        }
        throw readErr;
      }
      if (!envelope || envelope.id !== entry.id) return;

      try {
        await checkLiveAuthorization(envelope.token);
      } catch (err) {
        const code = err instanceof TaskError ? err.code : 'authentication_error';
        const status = code === 'repository_policy_disabled' ? 403 : 401;
        await sendSimpleReply(writer, status, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, code));
        return;
      }

      if (envelope.endpoint === 'models') {
        const payload = JSON.stringify(buildModelsListResponse());
        await sendSimpleReply(
          writer,
          200,
          { 'content-type': 'application/json', 'x-bot-run-id': runId, 'x-bot-lease-epoch': String(leaseEpoch) },
          payload,
        );
        return;
      }

      if (!['messages', 'responses', 'chat_completions'].includes(envelope.endpoint)) {
        await sendSimpleReply(writer, 403, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, 'endpoint_not_allowed'));
        return;
      }

      const downstreamFormat = endpointToFormat(envelope.endpoint);
      const rawBody = envelope.body && typeof envelope.body === 'object' && !Array.isArray(envelope.body)
        ? redactor.clean(envelope.body)
        : envelope.body;
      if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        await sendSimpleReply(writer, 400, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, 'invalid_request_error'));
        return;
      }

      let canonical;
      try {
        canonical = parseDownstreamRequest(downstreamFormat, rawBody);
      } catch (err: any) {
        await sendSimpleReply(writer, 400, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, 'invalid_request_error', String(err?.message || 'invalid_request')));
        return;
      }

      let target: ResolvedTargetModel | null;
      try {
        target = resolveTargetModel(canonical.model, downstreamFormat);
      } catch (err) {
        const code = err instanceof TaskError ? err.code : 'model_not_available';
        const msg = err instanceof TaskError && err.detail ? err.detail : code;
        await sendSimpleReply(writer, 503, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, code, msg));
        return;
      }
      if (!target) {
        await sendSimpleReply(writer, 403, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, 'model_not_allowed'));
        return;
      }
      secretToScrub = target.key;

      try {
        await checkLiveAuthorization(envelope.token);
        await beforeModel?.();
      } catch (err) {
        const code = err instanceof TaskError ? err.code : 'role_budget_exhausted';
        const status = code === 'role_budget_exhausted' || code === 'stage_budget_exhausted' ? 429 : 401;
        await sendSimpleReply(writer, status, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, code));
        return;
      }

      const passthrough = downstreamFormat === target.interfaceType;
      const upstreamBody = passthrough
        ? patchPassthroughRequest(target.interfaceType, rawBody, target.model, target.maxOutputTokens)
        : serializeUpstreamRequest(target.interfaceType, canonical, target.model, target.maxOutputTokens);

      const clientRequestId = randomUUID();
      const ledgerTask = { ...task, id: task.id && store.get('SELECT id FROM tasks WHERE id=?', task.id) ? task.id : null };
      requestLogId = beginModelRequest(
        store,
        ledgerTask,
        `${task.kind ?? 'role'}:${task.id ?? runId}:relay:${++requestSeq}:${clientRequestId}`,
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
        const snap = task.conversation_id ? store.secrets.seal({ snapshot: traceSnapshot(capturedRequest) }, 'conversation-model-request:' + requestLogId) : traceSnapshot(capturedRequest);
        store.run('UPDATE model_requests SET run_id=?,request_ref=NULL,request_snapshot=? WHERE id=?', recordedRunId, snap, requestLogId);
      }

      const wireUrl = resolveModelWireUrl(target.url, target.interfaceType)
        + (passthrough && envelope.endpoint === 'messages' && envelope.query === '?beta=true' && !target.url.includes('?') ? '?beta=true' : '');
      const reqHeaders: Record<string, string> = {
        'content-type': 'application/json',
        'x-client-request-id': clientRequestId,
        ...(target.authHeader === 'x-api-key' ? { 'x-api-key': target.key } : { Authorization: 'Bearer ' + target.key }),
        ...(target.interfaceType === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}),
      };
      if (passthrough && target.interfaceType === 'anthropic-messages' && typeof envelope.headers?.['anthropic-beta'] === 'string') {
        reqHeaders['anthropic-beta'] = envelope.headers['anthropic-beta'];
      }

      armTimeout(timing.firstByteMs);
      heartbeat = setInterval(() => writer.keepalive(), timing.keepaliveMs ?? 15_000);
      heartbeat.unref?.();

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

      await checkLiveAuthorization(envelope.token);

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
        const rawErr = scrubSecret(Buffer.concat(errChunks).toString('utf8'), secretToScrub);
        let parsedErr: any = null;
        try { parsedErr = JSON.parse(rawErr); } catch {}
        recordResponseTrajectory(parsedErr ?? { status: upstream.status, error: rawErr.slice(0, 2000) });
        // A completed 4xx client/rate-limit rejection did not generate a model response and is not an unknown bill;
        // 5xx/transport errors stay null so unknown usage remains explicit.
        const rejectedClientUsage = upstream.status >= 400 && upstream.status < 500
          ? { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }
          : null;
        finishModelRequest(store, requestLogId, rejectedClientUsage, upstream.status, 'http_error', false);
        const errOut = passthrough && parsedErr
          ? JSON.stringify(redactor.clean(parsedErr))
          : formatErrorPayload(
              envelope.endpoint,
              upstream.status === 429 ? 'rate_limit_error' : upstream.status === 401 || upstream.status === 403 ? 'authentication_error' : 'api_error',
              redactor.text(extractUpstreamErrorMessage(parsedErr) || `upstream_http_${upstream.status}`),
            );
        await sendSimpleReply(writer, upstream.status, { 'content-type': 'application/json' }, errOut);
        return;
      }

      const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
      const upstreamIsSse = upstreamContentType.includes('text/event-stream');
      const decoder = new UpstreamStreamDecoder(target.interfaceType, upstreamIsSse, target.model);
      const namespacedTools = new Map(canonical.tools.filter(t=>t.namespace&&t.localName).map(t=>[t.name,{namespace:t.namespace!,name:t.localName!}]));
      const customTools = new Set(canonical.tools.filter(t => t.custom).map(t => t.name));
      const responseBuilder = new DownstreamResponseBuilder(
        passthrough ? target.interfaceType : downstreamFormat,
        passthrough ? false : canonical.stream,
        canonical.model,
        customTools,
        namespacedTools,
      );
      const trajectoryTapBuilder = passthrough
        ? responseBuilder
        : new DownstreamResponseBuilder(downstreamFormat, false, canonical.model, customTools, namespacedTools);

      const downstreamHeaders: Record<string, string> = {
        'content-type': passthrough ? upstreamContentType : canonical.stream ? 'text/event-stream; charset=utf-8' : 'application/json',
      };
      const pushBodyChunk = (chunk: Buffer | string) => {
        if (!chunk.length) return;
        if (!writer.headersCommitted) writer.startResponse(200, downstreamHeaders);
        streamedAny = true;
        writer.push(chunk);
      };

      let totalBytes = 0;
      let lastAuthCheck = Date.now();
      let passthroughPending = '';
      const passthroughTextDecoder = passthrough && secretToScrub ? new TextDecoder('utf-8', { fatal: false }) : null;

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
            if (writer.abortedByClient || writer.fatalError || combinedSignal.aborted) {
              throw writer.fatalError ?? combinedSignal.reason ?? new Error('aborted');
            }
            if (Date.now() - lastAuthCheck >= 1000) {
              lastAuthCheck = Date.now();
              await checkLiveAuthorization(envelope.token);
            }

            const events = decoder.push(buf);
            finalUsage = decoder.usage;
            if (passthrough) {
              responseBuilder.push(events);
              if (passthroughTextDecoder) {
                passthroughPending += passthroughTextDecoder.decode(buf, { stream: true });
                if (upstreamIsSse) {
                  let m: RegExpExecArray | null;
                  let safeOut = '';
                  while ((m = /\r?\n\r?\n/.exec(passthroughPending))) {
                    const endIdx = m.index + m[0].length;
                    safeOut += scrubSecret(passthroughPending.slice(0, endIdx), secretToScrub);
                    passthroughPending = passthroughPending.slice(endIdx);
                  }
                  if (safeOut) pushBodyChunk(safeOut);
                } else {
                  passthroughPending = scrubSecret(passthroughPending, secretToScrub);
                  const hold = Math.max(0, secretToScrub.length - 1);
                  if (passthroughPending.length > hold) {
                    let emitLen = passthroughPending.length - hold;
                    const lastUnit = passthroughPending.charCodeAt(emitLen - 1);
                    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) emitLen -= 1;
                    if (emitLen > 0) {
                      pushBodyChunk(passthroughPending.slice(0, emitLen));
                      passthroughPending = passthroughPending.slice(emitLen);
                    }
                  }
                }
              } else {
                pushBodyChunk(buf);
              }
            } else {
              trajectoryTapBuilder.push(events);
              const rendered = responseBuilder.push(events);
              if (canonical.stream && rendered) {
                pushBodyChunk(scrubSecret(rendered, secretToScrub));
              }
            }
          }
        } finally {
          combinedSignal.removeEventListener('abort', onAbortStream);
        }
      }

      if (writer.abortedByClient || writer.fatalError || combinedSignal.aborted) {
        throw writer.fatalError ?? combinedSignal.reason ?? new Error('aborted');
      }

      const tailEvents = decoder.end();
      finalUsage = decoder.usage;
      if (passthrough) {
        responseBuilder.push(tailEvents);
        if (passthroughTextDecoder) {
          const rest = passthroughPending + passthroughTextDecoder.decode();
          if (rest) pushBodyChunk(scrubSecret(rest, secretToScrub));
        }
        const { jsonSnapshot } = responseBuilder.finalize();
        if (!writer.headersCommitted) writer.startResponse(200, downstreamHeaders);
        await writer.finish();
        if (writer.abortedByClient || writer.fatalError) {
          throw writer.fatalError ?? new Error('client_cancelled');
        }
        recordResponseTrajectory(jsonSnapshot);
        finishModelRequest(store, requestLogId, accountingUsagePayload(finalUsage), upstream.status, 'received', true);
      } else {
        trajectoryTapBuilder.push(tailEvents);
        const tailRendered = responseBuilder.push(tailEvents);
        if (canonical.stream && tailRendered) {
          pushBodyChunk(scrubSecret(tailRendered, secretToScrub));
        }
        const { body: finalBody } = responseBuilder.finalize();
        const { jsonSnapshot: trajectorySnap } = trajectoryTapBuilder.finalize();
        if (canonical.stream) {
          if (finalBody) pushBodyChunk(scrubSecret(finalBody, secretToScrub));
          if (!writer.headersCommitted) writer.startResponse(200, downstreamHeaders);
          await writer.finish();
        } else {
          await sendSimpleReply(writer, 200, downstreamHeaders, scrubSecret(finalBody, secretToScrub));
        }
        if (writer.abortedByClient || writer.fatalError) {
          throw writer.fatalError ?? new Error('client_cancelled');
        }
        recordResponseTrajectory(trajectorySnap);
        finishModelRequest(store, requestLogId, accountingUsagePayload(finalUsage), upstream.status, 'received', true);
      }
    } catch (err: any) {
      const isTimeout = err?.message === 'provider_timeout' || (combinedSignal.aborted && (combinedSignal.reason as any)?.message === 'provider_timeout');
      if (requestLogId) {
        try {
          const errCode = writer.abortedByClient ? 'client_cancelled' : err instanceof TaskError ? err.code : isTimeout ? 'provider_timeout' : 'transport_error';
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
          // Storage failure during error cleanup must not escape handleRequest or block stream termination.
        }
      }
      if (!writer.abortedByClient && envelope) {
        const code = err instanceof TaskError ? err.code : isTimeout ? 'provider_timeout' : 'api_error';
        const detail = redactor.text(String(err?.message || code)).slice(0, 300);
        if (!writer.headersCommitted) {
          await sendSimpleReply(writer, err instanceof TaskError ? 401 : 502, { 'content-type': 'application/json' }, formatErrorPayload(envelope.endpoint, code, detail)).catch(() => {});
        } else {
          if (writer.responseContentType.includes('text/event-stream') && envelope.endpoint !== 'models') {
            writer.push(formatSseErrorEvent(envelope.endpoint, code, detail));
          }
          await writer.fail(code).catch(() => {});
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      requestAbort.abort();
    }
  };

  return {
    dispatchPoll(entries: PolledModelRequestEntry[] | undefined) {
      if (closed || !Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry?.id || entry.stub || inFlight.has(entry.id) || handledIds.has(entry.id)) continue;
        handledIds.add(entry.id);
        if (handledIds.size > 4096) {
          const oldest = handledIds.values().next().value;
          if (oldest) handledIds.delete(oldest);
        }
        const p = handleRequest(entry).finally(() => { inFlight.delete(entry.id); });
        inFlight.set(entry.id, p);
      }
    },
    knownIds(limit = 512): string[] {
      const ids: string[] = [];
      for (const id of inFlight.keys()) {
        if (/^[a-f0-9]{48}$/.test(id)) ids.push(id);
        if (ids.length >= limit) return ids;
      }
      const recent = [...handledIds];
      for (let i = recent.length - 1; i >= 0 && ids.length < limit; i--) {
        const id = recent[i]!;
        if (!inFlight.has(id) && /^[a-f0-9]{48}$/.test(id)) ids.push(id);
      }
      return ids;
    },
    get activeCount() {
      return inFlight.size;
    },
    async drain() {
      await Promise.allSettled([...inFlight.values()]);
    },
    async close() {
      closed = true;
      signal?.removeEventListener('abort', onParentAbort);
      gatewayAbort.abort(new Error('gateway_closed'));
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}

function extractUpstreamErrorMessage(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const err = parsed.error;
  const found = [err?.message, err, parsed.message, parsed.detail, parsed.msg].find(v => typeof v === 'string' && v.trim());
  return found ? String(found).trim().slice(0, 300) : null;
}
