import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { TaskError, stop, clip, type Redactor } from '../agent/common.js';
import { satisfiesCliRange } from './agent-tools.js';
import type { HarnessEvent } from './session.js';

/**
 * Codex app-server dialect inside the isolated project computer or per-run container (`src/harness/codex.ts`).
 * Speaks the app-server JSON-RPC lines over the runner's stdin/stdout mailbox: `initialize`/`initialized`,
 * `thread/start` or a verified `thread/resume`, `turn/start` until a terminal `turn/completed`, `turn/interrupt`,
 * and explicit server approval responses.
 *
 * `test/live/codex/codex-protocol-lock.mjs` regenerates the JSON Schema against the tested CLI version (`codexAppServer.cli`)
 * and compares `schemaDigest`; runtime runs accept versions matching `COMPATIBLE_CLI_RANGES.codex`.
 */
export const codexAppServer = {
  cli: '0.166.0',
  schemaDigest: '723ea781a3f0d5be4ddefb69e58f7c48fc8c77fa070234bf2f603088c38023ec',
  definitions: [
    'InitializeParams', 'InitializeResponse', 'ThreadStartParams', 'ThreadStartResponse', 'ThreadResumeParams', 'ThreadResumeResponse', 'ThreadTurnsListParams', 'ThreadTurnsListResponse',
    'TurnStartParams', 'TurnStartResponse', 'TurnInterruptParams', 'Turn', 'TurnStatus', 'TurnError', 'CodexErrorInfo', 'ThreadItem', 'ItemStartedNotification', 'ItemCompletedNotification', 'TurnCompletedNotification',
    'ThreadTokenUsageUpdatedNotification', 'ThreadTokenUsage', 'TokenUsageBreakdown', 'ErrorNotification', 'ModelReroutedNotification', 'McpServerStatusUpdatedNotification', 'ListMcpServerStatusParams', 'ListMcpServerStatusResponse', 'McpServerStatus',
    'CommandExecutionRequestApprovalParams', 'CommandExecutionApprovalDecision', 'FileChangeRequestApprovalParams', 'FileChangeApprovalDecision', 'PermissionsRequestApprovalParams', 'PermissionsRequestApprovalResponse', 'GrantedPermissionProfile',
    'McpServerElicitationRequestParams', 'McpServerElicitationRequestResponse', 'ToolRequestUserInputParams', 'ToolRequestUserInputResponse', 'DynamicToolCallParams', 'DynamicToolCallResponse',
    'ExperimentalFeatureListParams', 'ExperimentalFeatureListResponse', 'ExperimentalFeature', 'AskForApproval', 'SandboxPolicy',
  ],
  /** Server requests of the locked version; each one gets an explicit answer below. */
  serverRequests: [
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
    'item/permissions/requestApproval', 'item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'applyPatchApproval', 'execCommandApproval',
  ],
} as const;

export interface CodexTransport {
  writeLine(line: string): void;
}

export interface CodexDialectContext {
  transport: CodexTransport;
  expectedVersion: string;
  codexHome: string;
  cwd: string;
  egress: boolean;
  sandbox: 'danger-full-access' | 'workspace-write' | 'read-only';
  computerAllowed?: boolean;
  fileWriteAllowed?: boolean;
  recordNativeReceipt?:(item:Record<string,unknown>)=>string;
  model?: string;
  modelProvider?: string;
  mcpCommand: string;
  mcpArgs: string[];
  toolStartupMs?: number;
  cancelGraceMs?: number;
  tools: string[];
  instructions: string;
  redactor: Redactor;
  emit: (event: HarnessEvent) => void;
  guard: () => Promise<void>;
  denied: (name: string, reason: string) => void;
  stop: (error: TaskError) => void;
  save: (patch: Record<string, unknown>) => void;
}

export interface CodexDialect {
  feed(chunk: Buffer | string): void;
  failStream(error: Error): void;
  open(previous: Record<string, any> | undefined, fresh: boolean): Promise<{
    sessionId: string;
    recovery: string;
    agentInfo: unknown;
    state: Record<string, unknown>;
    bound: Record<string, unknown>;
    notice?: string;
  }>;
  turn(text: string): Promise<{ text: string }>;
  cancel(): Promise<void>;
  bound(): void;
  close(reason?: unknown): void;
}

// Notifications the client does not need. Deltas are suppressed at the server; the complete item arrives in item/completed.
const optOut = [
  'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
  'item/plan/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'command/exec/outputDelta',
  'process/outputDelta', 'remoteControl/status/changed', 'account/rateLimits/updated',
];
const ignored = new Set([
  'thread/started', 'thread/status/changed', 'thread/readState/changed', 'thread/name/updated', 'thread/goal/updated',
  'thread/goal/cleared', 'thread/settings/updated', 'thread/compacted', 'thread/closed', 'turn/diff/updated', 'turn/plan/updated',
  'serverRequest/resolved', 'item/mcpToolCall/progress', 'item/commandExecution/terminalInteraction', 'item/fileChange/patchUpdated',
  'item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'hook/started', 'hook/completed', 'skills/changed',
  'account/updated', 'app/list/updated', 'mcpServer/event/stream/notification',
  ...optOut,
]);
const turnStatuses = ['completed', 'interrupted', 'failed', 'inProgress'];

/** Native container tools enabled for Codex inside `<task_dir>/repo`, with optional extensions left to native configuration. */
export const enabledFeatures = ['shell_tool', 'view_image', 'multi_agent'] as const;
export const deniedFeatures:readonly string[] = [];

/** Native execution items recorded as public observations with separate full receipts. */
const quietNativeItems = new Set(['commandExecution', 'fileChange', 'imageView', 'collabAgentToolCall', 'subAgentActivity']);

class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) {
    super(message);
  }
}
const threadMissing = (error: RpcError) => error.code === -32600 && /^no rollout found for thread id /.test(error.message);
const invalid = (at: string): never => stop('codex_protocol_invalid', 'retry_wait', at);
const need = (ok: unknown, at: string) => { if (!ok) invalid(at); };
const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

const check = {
  initialize(v: any) {
    need(v && typeof v.userAgent === 'string' && typeof v.codexHome === 'string' && typeof v.platformOs === 'string', 'initialize.result');
    return v as { userAgent: string; codexHome: string; platformOs: string };
  },
  thread(v: any, at: string) {
    need(v && v.thread && id(v.thread.id) && typeof v.model === 'string' && typeof v.modelProvider === 'string' && typeof v.cwd === 'string', at);
    need(v.instructionSources == null || (Array.isArray(v.instructionSources) && v.instructionSources.every((s: unknown) => typeof s === 'string')), at + '.instructionSources');
    return v as { thread: { id: string; cliVersion?: string }; model: string; modelProvider: string; cwd: string; instructionSources?: string[]; approvalPolicy: unknown; sandbox: unknown };
  },
  turn(v: any, at: string) {
    need(v && id(v.id) && turnStatuses.includes(v.status), at);
    need(v.error == null || typeof v.error.message === 'string', at + '.error');
    return v as { id: string; status: string; error?: { message: string; codexErrorInfo?: unknown } | null; durationMs?: number | null };
  },
  usage(v: any) {
    const b = v?.tokenUsage?.total;
    need(b && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'].every(k => count(b[k])), 'thread/tokenUsage/updated.tokenUsage.total');
    return b;
  },
  item(v: any, method: string) {
    need(v && id(v.threadId) && id(v.turnId) && v.item && id(v.item.id) && typeof v.item.type === 'string', method);
    return v;
  },
};

type Usage = { input: number; cached: number; output: number; reasoning: number; total: number };
const usageOf = (b: any): Usage => ({
  input: b.inputTokens,
  cached: b.cachedInputTokens,
  output: b.outputTokens,
  reasoning: b.reasoningOutputTokens,
  total: b.totalTokens,
});

/** JSON-RPC over newline-delimited stdio, as the app-server speaks it (no "jsonrpc" member). */
export class LineRpc {
  private pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: unknown) => void; accept?: (result: any) => any }>();
  private next = 1;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  failure: Error | null = null;
  constructor(
    private write: (line: string) => void,
    private handlers: {
      notification: (method: string, params: any) => void;
      request: (id: number | string, method: string, params: any) => void;
      anomaly: (kind: string, detail: Record<string, unknown>) => void;
      failed: (error: Error) => void;
    },
    private maxLine = 16 * 1024 * 1024,
  ) {}
  feed(chunk: Buffer | string) {
    if (this.failure) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let at: number;
    while (!this.failure && (at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim()) this.line(line);
    }
    if (this.buffer.length > this.maxLine) this.fail(new TaskError('codex_protocol_invalid', 'retry_wait', 'line_too_long'));
  }
  private line(text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      this.fail(new TaskError('codex_protocol_invalid', 'retry_wait', 'json_line'));
      return;
    }
    try {
      if (!m || typeof m !== 'object' || Array.isArray(m)) invalid('message');
      const hasId = typeof m.id === 'number' || typeof m.id === 'string';
      if (typeof m.method === 'string') {
        if (hasId) this.handlers.request(m.id, m.method, m.params);
        else this.handlers.notification(m.method, m.params);
        return;
      }
      if (hasId && ('result' in m || 'error' in m)) {
        const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
        if (!p) {
          this.handlers.anomaly('unexpected_response', { id: String(m.id) });
          return;
        }
        this.pending.delete(m.id);
        if (m.error) {
          p.reject(new RpcError(p.method, Number(m.error?.code ?? 0), String(m.error?.message ?? 'error')));
          return;
        }
        let value: any;
        try {
          value = p.accept ? p.accept(m.result) : m.result;
        } catch (error) {
          p.reject(error);
          throw error;
        }
        p.resolve(value);
        return;
      }
      this.handlers.anomaly('unclassified_message', {});
    } catch (error) {
      this.fail(error as Error);
    }
  }
  request(method: string, params: unknown, accept?: (result: any) => any): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const n = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(n, { method, resolve, reject, accept });
      this.write(JSON.stringify({ id: n, method, params }));
    });
  }
  notify(method: string, params?: unknown) {
    if (!this.failure) this.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }
  respond(n: number | string, result: unknown) {
    if (!this.failure) this.write(JSON.stringify({ id: n, result }));
  }
  respondError(n: number | string, code: number, message: string) {
    if (!this.failure) this.write(JSON.stringify({ id: n, error: { code, message } }));
  }
  fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.handlers.failed(error);
  }
}

const version = (userAgent: string) => /^[^\/\s]+\/(\d+\.\d+\.\d+[\w.+-]*)/.exec(userAgent)?.[1] ?? null;
const httpStatus = (info: any) => {
  if (!info || typeof info !== 'object') return null;
  for (const v of Object.values(info)) {
    if (v && typeof v === 'object' && Number.isSafeInteger((v as any).httpStatusCode)) return (v as any).httpStatusCode as number;
  }
  return null;
};
const errorKind = (info: unknown) => (typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] ?? null : null);

function turnFailure(turn: { error?: { message: string; codexErrorInfo?: unknown } | null }, clean: (s: string) => string) {
  const info = turn.error?.codexErrorInfo;
  const status = httpStatus(info);
  const message = clean(String(turn.error?.message ?? '')).slice(0, 500);
  if (info === 'unauthorized' || status === 401 || status === 403) return new TaskError('codex_authentication_failed', 'waiting_configuration', message);
  if (info === 'modelNotFound') return new TaskError('codex_model_unavailable', 'waiting_configuration', message);
  return new TaskError('codex_turn_failed', 'retry_wait', `${errorKind(info) ?? 'unknown'}: ${message}`);
}

function declinePayload(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision: 'decline' };
  }
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return { decision: 'abort' };
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {} };
  }
  return { action: 'decline' };
}

function decide(
  method: string,
  params: any,
  computerAllowed: boolean,
  fileWriteAllowed=computerAllowed,
): { result?: unknown; error?: [number, string]; decision: string; allowed: boolean; reason: string } {
  switch (method) {
    case 'mcpServer/elicitation/request':
      return params?.mode !== 'url'
        ? { result: { action: 'accept', content: {} }, decision: 'accept', allowed: true, reason: 'offered_task_tools_rechecked_by_control_plane' }
        : { result: { action: 'decline' }, decision: 'decline', allowed: false, reason: 'tool_server_not_offered' };
    case 'item/commandExecution/requestApproval':
      return computerAllowed
        ? { result: { decision: 'accept' }, decision: 'accept', allowed: true, reason: 'container_workspace_command_authorized' }
        : { result: { decision: 'decline' }, decision: 'decline', allowed: false, reason: 'computer_command_outside_role_authority' };
    case 'item/fileChange/requestApproval':
      return fileWriteAllowed
        ? { result: { decision: 'accept' }, decision: 'accept', allowed: true, reason: 'container_workspace_edit_authorized' }
        : { result: { decision: 'decline' }, decision: 'decline', allowed: false, reason: 'computer_file_change_outside_role_authority' };
    case 'item/permissions/requestApproval':
      return { result: { permissions: {} }, decision: 'grant_none', allowed: false, reason: 'sandbox_escalation_outside_role_authority' };
    case 'item/tool/requestUserInput':
      return { result: { answers: {} }, decision: 'no_answer', allowed: false, reason: 'no_interactive_user' };
    case 'item/tool/call':
      return {
        result: { success: false, contentItems: [{ type: 'inputText', text: 'Dynamic tools are not offered. Use native container tools or the bot MCP task tools.' }] },
        decision: 'refuse',
        allowed: false,
        reason: 'dynamic_tool_not_registered',
      };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { result: { decision: 'abort' }, decision: 'abort', allowed: false, reason: 'legacy_approval_outside_role_authority' };
    case 'account/chatgptAuthTokens/refresh':
      return { error: [-32601, 'token refresh is not provided by this client'], decision: 'refuse', allowed: false, reason: 'client_holds_no_account_tokens' };
    case 'attestation/generate':
      return { error: [-32601, 'attestation is not provided by this client'], decision: 'refuse', allowed: false, reason: 'attestation_not_offered' };
    default:
      return { error: [-32601, 'method not found'], decision: 'refuse', allowed: false, reason: 'unknown_server_request' };
  }
}

const bounded = (value: unknown, limit = 8000) => {
  const json = JSON.stringify(value ?? null);
  return json.length <= limit ? value ?? null : { truncated: true, preview: clip(json, limit) };
};

function itemFields(it: any, completed: boolean) {
  const status = typeof it.status === 'string' ? it.status : completed ? 'completed' : 'in_progress';
  switch (it.type) {
    case 'commandExecution':return {kind:'command',title:clip(String(it.command??''),300),status,rawInput:{command:it.command,cwd:it.cwd},rawOutput:completed?{exit_code:it.exitCode,output:bounded(it.aggregatedOutput)}:null};
    case 'fileChange':return {kind:'file_change',title:'file changes',status,rawInput:{changes:bounded(it.changes)},rawOutput:null};
    case 'mcpToolCall':
      return {
        kind: 'mcp',
        title: clip(`${it.server}.${it.tool}`, 300),
        status,
        rawInput: { server: it.server ?? null, tool: it.tool ?? null, arguments: bounded(it.arguments) },
        rawOutput: completed ? { error: it.error?.message ? clip(it.error.message, 500) : null, durationMs: it.durationMs ?? null } : null,
      };
    case 'dynamicToolCall':
      return {
        kind: 'dynamic',
        title: clip(it.tool, 300),
        status,
        rawInput: { tool: it.tool ?? null, arguments: bounded(it.arguments) },
        rawOutput: completed ? { success: it.success ?? null } : null,
      };
    case 'webSearch':
      return { kind: 'fetch', title: clip(it.query, 500), status, rawInput: { query: clip(it.query, 500) }, rawOutput: null };
    case 'plan':
      return { kind: 'plan', title: 'plan', status, rawInput: null, rawOutput: completed ? { text: clip(it.text, 8000) } : null };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { kind: 'builtin_review', title: clip(it.review, 500), status, rawInput: null, rawOutput: null, note: 'not_platform_review' };
    default:
      return { kind: 'other', title: String(it.type), status, rawInput: null, rawOutput: null };
  }
}

export function appServerDialect(ctx: CodexDialectContext): CodexDialect {
  const { cwd, emit, redactor } = ctx;
  const home = resolve(ctx.codexHome);
  const computerAllowed = ctx.computerAllowed ?? true;
  const featurePolicy: Record<string, boolean> = {
    ...Object.fromEntries(enabledFeatures.map(name => [name, true])),
    ...Object.fromEntries(deniedFeatures.map(name => [name, false])),
    shell_tool:computerAllowed,
  };
  let threadId = '';
  let cli: string | null = null;
  let text = '';
  let usageBase: Usage | null = null;
  let lastTurn: { id: string | null; status: string | null } = { id: null, status: null };
  let knownTurn: string | null = null;
  const persist = (turn: typeof lastTurn, known: string | null = knownTurn) => {
    ctx.save({ lastTurnId: turn.id, lastTurnStatus: turn.status, knownTurnId: known });
    lastTurn = turn;
    knownTurn = known;
  };
  type Waiter = {
    id: string | null;
    hint: string | null;
    hintStarted: boolean;
    previous: string | null;
    done: boolean;
    announced: boolean;
    resolve: (turn: any) => void;
    reject: (e: unknown) => void;
    usage: boolean;
    onTurnKnown?: (turnId: string) => void;
  };
  let current: Waiter | null = null;
  let rerouted: { from: string; to: string } | null = null;
  const ended = new Set<string>();
  const awaiting = new Map<string, () => void>();
  let connectionEnded!: (kind: string) => void;
  const closed = new Promise<string>(r => { connectionEnded = r; });
  const terminalOf = (turnId: string) =>
    ended.has(turnId) ? Promise.resolve('terminal') : new Promise<string>(r => { awaiting.set(turnId, () => r('terminal')); });
  const early = new Map<string, any>();
  const seen = new Set<string>();
  const reported = new Set<string>();
  const servers = new Map<string, { status: string; error: string | null }>();
  let serverChange: (() => void) | null = null;
  let committed = false;
  const pendingUsage: HarnessEvent[] = [];

  const anomaly = (kind: string, detail: Record<string, unknown> = {}) => {
    const key = kind + ':' + String(detail.method ?? '');
    if (reported.has(key)) return;
    reported.add(key);
    emit({ type: 'configuration', stage: 'protocol_anomaly', anomaly: kind, ...detail });
  };
  const ours = (params: any, at: string) => {
    if (!threadId) return false;
    if (params?.threadId === threadId) {
      learn(params.turnId, false);
      return true;
    }
    anomaly('foreign_thread', { method: at });
    return false;
  };
  const learn = (turnId: unknown, started: boolean) => {
    if (!current || current.id || !id(turnId) || turnId === current.previous || (current.hint && (current.hintStarted || !started || current.hint === turnId))) return;
    current.hint = turnId as string;
    current.hintStarted = started;
    persist({ id: current.hint, status: 'inProgress' }, current.hint);
    if (started) current.onTurnKnown?.(current.hint);
  };
  const refuse = (itemType: string, reason: string, turnId: string, itemId: string) => {
    ctx.denied('codex:' + itemType, reason);
    emit({ type: 'permission', requestId: null, method: 'item/' + itemType, threadId, turnId, itemId, decision: 'refused_after_start', allowed: false, reason });
    ctx.stop(new TaskError('codex_builtin_tool_refused', 'waiting_configuration', `Codex 工具 ${itemType}（${reason}）不在角色授权内却已执行；本次运行已停止。`));
  };

  const notification = (method: string, params: any) => {
    if (method === 'turn/started') {
      if (ours(params, method)) learn(check.turn(params?.turn, 'turn/started.turn').id, true);
      return;
    }
    if (method === 'turn/completed') {
      if (!ours(params, method)) return;
      const turn = check.turn(params?.turn, 'turn/completed.turn');
      ended.add(turn.id);
      awaiting.get(turn.id)?.();
      awaiting.delete(turn.id);
      if (current && current.id === turn.id) {
        if (current.done) {
          anomaly('duplicate_terminal', { method });
          return;
        }
        current.done = true;
        current.resolve(turn);
      } else if (current && current.id === null) {
        early.set(turn.id, turn);
      } else {
        anomaly('unknown_turn', { method });
      }
    } else if (method === 'item/started' || method === 'item/completed') {
      const p = check.item(params, method);
      if (!ours(p, method)) return;
      const it = p.item;
      const completed = method === 'item/completed';
      const key = (completed ? 'c:' : 's:') + it.id;
      if (seen.has(key)) {
        anomaly('duplicate_item', { method });
        return;
      }
      seen.add(key);

      const refused =
        it.type === 'dynamicToolCall'
          ? 'dynamic_tool_not_registered'
          : it.type === 'webSearch' && !ctx.egress ? 'web_search_disabled' : null;
      if (refused) {
        emit({ type: 'tool', callId: it.id, threadId, turnId: p.turnId, itemType: it.type, phase: completed ? 'completed' : 'started', ...redactor.clean(itemFields(it, completed)) });
        refuse(it.type, refused, p.turnId, it.id);
        return;
      }
      if (it.type === 'reasoning' || it.type === 'userMessage' || it.type === 'hookPrompt') return;
      if (it.type === 'agentMessage') {
        if (!completed) return;
        need(typeof it.text === 'string', 'item/completed.item.text');
        text += (text ? '\n' : '') + it.text;
        if (text.length > 2 * 1024 * 1024) stop('codex_output_limit', 'retry_wait');
        emit({ type: 'message', text: clip(redactor.text(it.text), 12000), threadId, turnId: p.turnId, itemId: it.id, phase: it.phase ?? null });
        return;
      }
      // Native container commands, file edits, image reads and sub-agents run inside the isolated container and are not logged one-by-one.
      const rawRef=completed&&quietNativeItems.has(it.type)?ctx.recordNativeReceipt?.(it):undefined;
      emit({ ...(rawRef?{raw_ref:rawRef}:{}),type: 'tool', callId: it.id, threadId, turnId: p.turnId, itemType: it.type, phase: completed ? 'completed' : 'started', ...redactor.clean(itemFields(it, completed)) });
    } else if (method === 'thread/tokenUsage/updated') {
      if (!ours(params, method)) return;
      const total = usageOf(check.usage(params));
      const base = usageBase ?? { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
      if (total.total < base.total) {
        anomaly('usage_decreased', { method });
        usageBase = total;
        ctx.save({ usage: total });
        return;
      }
      if (total.total === base.total) return;
      const delta = {
        input_tokens: total.input - base.input,
        cached_input_tokens: total.cached - base.cached,
        output_tokens: total.output - base.output,
        reasoning_output_tokens: total.reasoning - base.reasoning,
        total_tokens: total.total - base.total,
      };
      usageBase = total;
      ctx.save({ usage: total });
      if (current && (current.id === params.turnId || (current.id === null && params.turnId !== current.previous))) current.usage = true;
      const event: HarnessEvent = { type: 'usage', source: 'codex_app_server', threadId, turnId: String(params.turnId), delta, thread_total: total };
      if (committed) emit(event);
      else pendingUsage.push(event);
    } else if (method === 'error') {
      if (!ours(params, method)) return;
      need(typeof params?.error?.message === 'string' && typeof params.willRetry === 'boolean', 'error.params');
      emit({
        type: 'configuration',
        stage: 'turn_error',
        threadId,
        turnId: params.turnId ?? null,
        willRetry: params.willRetry,
        code: errorKind(params.error.codexErrorInfo),
        message: clip(redactor.text(params.error.message), 500),
      });
    } else if (method === 'model/rerouted') {
      if (!ours(params, method)) return;
      need(typeof params?.fromModel === 'string' && typeof params?.toModel === 'string', 'model/rerouted.params');
      rerouted = { from: params.fromModel, to: params.toModel };
      emit({
        type: 'configuration',
        stage: 'model_rerouted',
        threadId,
        turnId: params.turnId ?? null,
        fromModel: params.fromModel,
        toModel: params.toModel,
        reason: params.reason ?? null,
      });
      ctx.stop(new TaskError('codex_model_rerouted', 'waiting_configuration', `app-server 把 ${rerouted.from} 改路由到 ${rerouted.to}；不会在未配置的模型上继续。`));
    } else if (method === 'mcpServer/startupStatus/updated') {
      need(typeof params?.name === 'string' && typeof params?.status === 'string', 'mcpServer/startupStatus/updated.params');
      if (params.threadId && threadId && params.threadId !== threadId) return;
      servers.set(params.name, { status: params.status, error: typeof params.error === 'string' ? clip(redactor.text(params.error), 300) : null });
      serverChange?.();
    } else if (method === 'warning' || method === 'configWarning' || method === 'deprecationNotice') {
      emit({ type: 'configuration', stage: 'warning', method, message: clip(redactor.text(String(params?.message ?? params?.summary ?? '')), 500) });
    } else if (!ignored.has(method)) {
      anomaly('unknown_notification', { method });
    }
  };

  const request = (n: number | string, method: string, params: any) => {
    void (async () => {
      let reply = decide(method, params, computerAllowed, ctx.fileWriteAllowed??computerAllowed);
      if (params?.threadId !== undefined && params.threadId !== threadId) {
        if (reply.allowed) reply = { result: declinePayload(method), decision: 'decline', allowed: false, reason: 'foreign_thread' };
        else reply = { ...reply, reason: 'foreign_thread' };
      } else if (reply.allowed) {
        try {
          await ctx.guard();
        } catch {
          reply = { result: declinePayload(method), decision: 'cancel', allowed: false, reason: 'run_no_longer_authorized' };
        }
      }
      if (reply.error) rpc.respondError(n, reply.error[0], reply.error[1]);
      else rpc.respond(n, reply.result);
      if (!reply.allowed) ctx.denied('codex:' + method, reply.reason);
      emit({
        type: 'permission',
        requestId: String(n),
        method,
        threadId: params?.threadId ?? null,
        turnId: params?.turnId ?? null,
        itemId: params?.itemId ?? null,
        decision: reply.decision,
        allowed: reply.allowed,
        reason: reply.reason,
        ...redactor.clean({
          command: typeof params?.command === 'string' ? clip(params.command, 1000) : undefined,
          serverName: params?.serverName,
          requested: params?.permissions ? Object.keys(params.permissions) : undefined,
          justification: typeof params?.reason === 'string' ? clip(params.reason, 500) : undefined,
        }),
      });
    })();
  };

  const rpc = new LineRpc(
    line => { ctx.transport.writeLine(line); },
    {
      notification,
      request,
      anomaly,
      failed: error => {
        current?.reject(error);
        connectionEnded('connection_closed');
        serverChange?.();
      },
    },
  );

  async function verifyBuiltins(thread: ReturnType<typeof check.thread>) {
    const sandbox = (thread.sandbox as any)?.type ?? thread.sandbox;
    const allowedSandboxes = ctx.sandbox === 'danger-full-access'
      ? ['dangerFullAccess', 'danger-full-access']
      : ctx.sandbox==='read-only'?['readOnly','read-only']:['workspaceWrite', 'workspace-write'];
    if (thread.approvalPolicy !== 'never' || !allowedSandboxes.includes(String(sandbox))) {
      stop(
        'codex_builtin_tools_enabled',
        'waiting_configuration',
        `thread 的 sandbox ${JSON.stringify(thread.sandbox)}、审批策略 ${JSON.stringify(thread.approvalPolicy)} 与容器策略不符。`,
      );
    }
    const state = new Map<string, boolean>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const listed = await rpc.request('experimentalFeature/list', { threadId, limit: 500, ...(cursor ? { cursor } : {}) });
      need(Array.isArray(listed?.data) && listed.data.every((f: any) => typeof f?.name === 'string' && typeof f?.enabled === 'boolean'), 'experimentalFeature/list.result');
      for (const f of listed.data) state.set(f.name, f.enabled);
      cursor = typeof listed.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : null;
      if (!cursor) break;
    }
    const forbiddenOn = deniedFeatures.filter(name => state.get(name) === true);
    if (forbiddenOn.length) {
      stop('codex_builtin_tools_enabled', 'waiting_configuration', `Codex 未授权功能未关闭：${forbiddenOn.join(', ')}`);
    }
    const missingEnabled = enabledFeatures.filter(name => (name!=='shell_tool'||ctx.computerAllowed!==false)&&state.get(name) === false);
    if(ctx.computerAllowed===false&&state.get('shell_tool')===true)stop('harness_permission_mismatch','waiting_configuration','Shell is enabled despite the configured command denial.');
    if (missingEnabled.length) {
      stop('codex_builtin_tools_enabled', 'waiting_configuration', `Codex 容器原生工具未开启：${missingEnabled.join(', ')}`);
    }
    return [...deniedFeatures];
  }

  async function verifyTools() {
    const deadline = Date.now() + (ctx.toolStartupMs ?? 15000);
    while (!['ready', 'failed', 'cancelled'].includes(servers.get('bot')?.status ?? '')) {
      if (rpc.failure) throw rpc.failure;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>(done => {
        const t = setTimeout(done, left);
        serverChange = () => {
          clearTimeout(t);
          done();
        };
      });
      serverChange = null;
    }
    const started = servers.get('bot');
    if (started?.status !== 'ready') {
      stop('codex_task_tools_unavailable', 'retry_wait', `bot MCP: ${started?.status ?? 'no status'} ${started?.error ?? ''}`.trim());
    }
    const listed = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' });
    need(Array.isArray(listed?.data) && listed.data.every((s: any) => typeof s?.name === 'string'), 'mcpServerStatus/list.result');
    const extra = listed.data.map((s: any) => String(s.name)).filter((name: string) => name !== 'bot');
    emit({type:'configuration',stage:'tool_servers',servers:listed.data.map((server:any)=>server.name),has_more:!!listed.nextCursor});
    const exposed = Object.keys(listed.data.find((s: any) => s.name === 'bot')?.tools ?? {}).sort();
    const offered = [...ctx.tools].sort();
    if (exposed.join('\n') !== offered.join('\n')) {
      stop('codex_task_tools_mismatch', 'retry_wait', `exposed ${exposed.join(',')}; offered ${offered.join(',')}`);
    }
    return exposed;
  }

  const dialect: CodexDialect = {
    feed(chunk) {
      rpc.feed(chunk);
    },
    failStream(error) {
      rpc.fail(error);
    },
    async open(previous, fresh) {
      const init = check.initialize(
        await rpc.request('initialize', {
          clientInfo: { name: 'bot', title: 'Bot role harness', version: '1' },
          capabilities: { experimentalApi: false, optOutNotificationMethods: optOut },
        }),
      );
      cli = version(init.userAgent);
      if (!cli || !satisfiesCliRange('codex', cli) || !satisfiesCliRange('codex', ctx.expectedVersion) || cli !== ctx.expectedVersion) {
        stop('codex_version_unsupported', 'waiting_configuration', `codex app-server ${cli ?? 'unknown'}，预期版本 ${ctx.expectedVersion}`);
      }
      if (resolve(init.codexHome) !== home) {
        stop('codex_home_unexpected', 'waiting_configuration', 'app-server 使用的 CODEX_HOME 不是容器启动配置指定的专用目录。');
      }
      rpc.notify('initialized');

      const overrides = {
        cwd,
        approvalPolicy: 'never' as const,
        sandbox: ctx.sandbox,
        developerInstructions: ctx.instructions,
        config: {
          mcp_servers: {
            bot: {
              command: ctx.mcpCommand,
              args: ctx.mcpArgs,
              env_vars: ['BOT_RUN_TOKEN', 'BOT_WORKSPACE_ID'],
              tool_timeout_sec: 3600,
              startup_timeout_sec: 30,
            },
          },
          features: featurePolicy,
          web_search: ctx.egress ? 'live' : 'disabled',
        },
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.modelProvider ? { modelProvider: ctx.modelProvider } : {}),
      };

      const prior = !fresh && previous?.protocol === 'codex-app-server' && id(previous.sessionId) ? previous : null;
      const checkoutChanged = Boolean(prior?.cwd && resolve(String(prior.cwd)) !== resolve(cwd));
      let recovery = fresh ? 'fresh_evaluation' : previous?.sessionId ? 'rebuilt_from_task_records' : 'new_session';
      let thread: ReturnType<typeof check.thread> | null = null;
      let reconciled: Record<string, unknown> | null = null;
      let notice = '';
      const switched = (model: unknown, provider: unknown) =>
        prior && ((prior.model && model !== prior.model) || (prior.modelProvider && provider !== prior.modelProvider));

      if (prior) {
        if (switched(ctx.model ?? prior.model, ctx.modelProvider ?? prior.modelProvider)) {
          stop(
            'codex_resume_incompatible',
            'waiting_configuration',
            `thread ${prior.sessionId} 绑定 ${prior.modelProvider}/${prior.model}，当前配置 ${ctx.modelProvider ?? '-'}/${ctx.model ?? '-'}。可还原配置后重试；确需换模型时暂停任务并执行 adopt-config（POST /api/tasks/:id/adopt-config），按新配置重建角色会话。`,
          );
        }
        if (!checkoutChanged) {
          try {
            thread = check.thread(await rpc.request('thread/resume', { threadId: prior.sessionId, excludeTurns: true, ...overrides }), 'thread/resume.result');
          } catch (error) {
            if (!(error instanceof RpcError)) throw error;
            if (!threadMissing(error)) {
              stop('codex_resume_failed', 'retry_wait', `thread/resume ${prior.sessionId}：${clip(redactor.text(error.message), 300)}（${error.code}）；保留原 thread 绑定。`);
            }
            emit({ type: 'configuration', recovery: 'native_resume_failed', previousSessionId: prior.sessionId, reason: clip(redactor.text(error.message), 300) });
          }
        } else {
          emit({ type: 'configuration', recovery: 'native_resume_skipped_checkout_changed', previousSessionId: prior.sessionId });
        }

        if (thread) {
          if (thread.thread.id !== prior.sessionId || resolve(thread.cwd) !== resolve(cwd)) {
            stop('codex_thread_ownership_mismatch', 'failed', '恢复的 thread 不属于这个角色实例。');
          }
          if (switched(thread.model, thread.modelProvider)) {
            stop('codex_resume_incompatible', 'waiting_configuration', `恢复的 thread 使用 ${thread.modelProvider}/${thread.model}，绑定的是 ${prior.modelProvider}/${prior.model}。`);
          }
          recovery = 'native_resume';
          usageBase = prior.usage && count(prior.usage.total) ? prior.usage : null;
          knownTurn = [prior.knownTurnId, prior.lastTurnId, prior.previousTurnId].find(id) ?? null;
          if (prior.lastTurnStatus && !['completed', 'not_started'].includes(prior.lastTurnStatus)) {
            let status = 'unknown';
            let turnId: string | null = id(prior.lastTurnId) ? prior.lastTurnId : null;
            try {
              const page = await rpc.request('thread/turns/list', { threadId: prior.sessionId, limit: 1 });
              const last = Array.isArray(page?.data) ? page.data[0] : undefined;
              if (turnId) {
                if (last?.id === turnId && turnStatuses.includes(last.status)) status = last.status;
              } else if (last && id(last.id) && last.id !== knownTurn && turnStatuses.includes(last.status)) {
                turnId = knownTurn = last.id;
                status = last.status;
              } else if (Array.isArray(page?.data)) {
                status = 'not_started';
              }
            } catch (error) {
              if (!(error instanceof RpcError)) throw error;
            }
            reconciled = { turnId, recorded: prior.lastTurnStatus ?? null, observed: status };
            notice = `Your previous turn ${turnId ?? '(its start was never confirmed)'} did not end with a confirmed completion (observed: ${status}). Before repeating any action, check task records for its effects.`;
          }
        }
      }

      if (!thread) {
        thread = check.thread(await rpc.request('thread/start', overrides), 'thread/start.result');
        if (switched(thread.model, thread.modelProvider)) {
          stop(
            'codex_resume_incompatible',
            'waiting_configuration',
            `thread ${prior!.sessionId} 已丢失，重建会从 ${prior!.modelProvider}/${prior!.model} 换成 ${thread.modelProvider}/${thread.model}。可还原模型配置后重试；确需换模型时暂停任务并执行 adopt-config（POST /api/tasks/:id/adopt-config），按新配置重建角色会话。`,
          );
        }
      }

      threadId = thread.thread.id;
      if ((ctx.model && thread.model !== ctx.model) || (ctx.modelProvider && thread.modelProvider !== ctx.modelProvider)) {
        stop('codex_model_mismatch', 'waiting_configuration', `配置 ${ctx.modelProvider ?? '-'}/${ctx.model ?? '-'}，app-server 实际为 ${thread.modelProvider}/${thread.model}。`);
      }
      const builtins = await verifyBuiltins(thread);
      const tools = await verifyTools();
      if (prior && recovery === 'native_resume') {
        lastTurn = {
          id: (reconciled?.turnId as string | null | undefined) ?? prior.lastTurnId ?? null,
          status: (reconciled?.observed as string | undefined) ?? prior.lastTurnStatus ?? null,
        };
      } else {
        lastTurn = { id: null, status: null };
        knownTurn = null;
      }

      return {
        sessionId: threadId,
        recovery,
        notice,
        agentInfo: { name: 'codex-app-server', version: cli },
        state: {
          protocol: 'codex-app-server',
          model: thread.model,
          modelProvider: thread.modelProvider,
          cliVersion: cli,
          lastTurnId: lastTurn.id,
          lastTurnStatus: lastTurn.status,
          knownTurnId: knownTurn,
          usage: usageBase,
        },
        bound: {
          threadId,
          model: thread.model,
          modelProvider: thread.modelProvider,
          cliVersion: cli,
          approvalPolicy: redactor.clean(thread.approvalPolicy ?? null),
          sandbox: redactor.clean(thread.sandbox ?? null),
          enabledBuiltins: [...enabledFeatures],
          disabledBuiltins: builtins,
          instructionSources: redactor.clean(thread.instructionSources ?? []),
          tools,
          reconciled,
        },
      };
    },
    async turn(prompt) {
      text = '';
      const waiter: Waiter = {
        id: null,
        hint: null,
        hintStarted: false,
        previous: knownTurn,
        done: false,
        announced: false,
        usage: false,
        resolve: () => {},
        reject: () => {},
      };
      const terminal = new Promise<any>((ok, fail) => {
        waiter.resolve = ok;
        waiter.reject = fail;
      });
      terminal.catch(() => {});
      current = waiter;
      const before = { turn: lastTurn, known: knownTurn };
      persist({ id: null, status: 'startRequested' });

      const accept = (result: any) => {
        const started = check.turn(result?.turn, 'turn/start.result.turn');
        if (waiter.hint && waiter.hint !== started.id) anomaly('hint_not_started_turn', { method: 'turn/start' });
        waiter.id = started.id;
        persist({ id: started.id, status: 'inProgress' }, started.id);
        emit({ type: 'turn', phase: 'started', threadId, turnId: started.id });
        waiter.announced = true;
        waiter.onTurnKnown?.(started.id);
        const known = early.get(started.id);
        if (known) {
          early.delete(started.id);
          waiter.done = true;
          waiter.resolve(known);
        }
        return started;
      };

      try {
        await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }, accept);
      } catch (error) {
        if (waiter.id) {
          try { persist({ id: waiter.id, status: 'inProgress' }, waiter.id); } catch {}
          if (!waiter.announced) {
            try { emit({ type: 'turn', phase: 'answered', threadId, turnId: waiter.id, usage: waiter.usage ? 'observed' : 'unknown', reason: 'started_event_not_recorded' }); } catch {}
          }
          throw error;
        }
        if (error instanceof RpcError) {
          persist(before.turn, before.known);
        } else {
          const endedHint = waiter.hint ? early.get(waiter.hint) : undefined;
          if (endedHint) persist({ id: waiter.hint, status: endedHint.status }, waiter.hint);
          emit({ type: 'turn', phase: 'start_unconfirmed', threadId, turnId: waiter.hint, usage: waiter.usage ? 'observed' : 'unknown' });
        }
        throw error;
      }

      const turn = await terminal;
      persist({ id: turn.id, status: turn.status }, turn.id);
      emit({
        type: 'turn',
        phase: 'ended',
        threadId,
        turnId: turn.id,
        status: turn.status,
        durationMs: turn.durationMs ?? null,
        usage: waiter.usage ? 'observed' : 'unknown',
        error: turn.error ? { code: errorKind(turn.error.codexErrorInfo), message: clip(redactor.text(turn.error.message), 500) } : null,
      });
      if (rerouted) {
        stop('codex_model_rerouted', 'waiting_configuration', `app-server 把 ${rerouted.from} 改路由到 ${rerouted.to}；不会在未配置的模型上继续。`);
      }
      if (turn.status === 'completed') return { text };
      if (turn.status === 'interrupted') throw new TaskError('codex_turn_interrupted', 'retry_wait');
      if (turn.status === 'inProgress') invalid('turn/completed.turn.status');
      throw turnFailure(turn, s => redactor.text(s));
    },
    async cancel() {
      const waiter = current;
      if (!threadId || !waiter || waiter.done || rpc.failure) return;
      const grace = ctx.cancelGraceMs ?? 5000;
      let interruptedTurnId: string | null = null;
      let timer: NodeJS.Timeout | undefined;
      let settleReceipt!: (receipt: string) => void;
      const receiptPromise = new Promise<string>(r => { settleReceipt = r; });

      const startGraceTimer = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => settleReceipt('timeout'), ms);
      };

      const interruptTurn = (idToInterrupt: string) => {
        if (interruptedTurnId || rpc.failure) return;
        interruptedTurnId = idToInterrupt;
        emit({ type: 'turn', phase: 'interrupt_requested', threadId, turnId: idToInterrupt });
        rpc.request('turn/interrupt', { threadId, turnId: idToInterrupt }).catch(() => {});
        void terminalOf(idToInterrupt).then(r => settleReceipt(r));
        startGraceTimer(grace);
      };

      const initialId = waiter.id ?? waiter.hint;
      if (initialId) {
        interruptTurn(initialId);
      } else {
        startGraceTimer(grace);
        waiter.onTurnKnown = idFromStream => {
          interruptTurn(idFromStream);
        };
      }

      const receipt = await Promise.race([receiptPromise, closed]);
      clearTimeout(timer);
      waiter.onTurnKnown = undefined;
      if (interruptedTurnId) awaiting.delete(interruptedTurnId);
      emit({ type: 'turn', phase: 'interrupt_receipt', threadId, turnId: interruptedTurnId, receipt });
    },
    bound() {
      committed = true;
      for (const event of pendingUsage.splice(0)) emit(event);
    },
    close() {
      rpc.fail(new TaskError('codex_connection_closed', 'retry_wait'));
    },
  };
  return dialect;
}
