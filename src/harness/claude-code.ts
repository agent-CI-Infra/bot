import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { TaskError } from '../agent/common.js';
import type { AgentSpec, ExternalUsage } from '../agent/runtime.js';
import type { RunContext } from '../roles/protocol.js';
import { contentHash } from '../roles/protocol.js';
import type { HarnessEvent } from './session.js';
import { claudeCodeRuntime, ClaudeJsonStream, claudeUserMessage, uuidPattern, type ClaudeUsage } from './claude-code-protocol.js';
import { claudeModelGateway, type ClaudeProvider } from './claude-gateway.js';

export interface ClaudeConfiguration { command?: string; version: string; stateDirectory: string; model: string; provider: ClaudeProvider; timeoutMs?: number }
export interface ClaudePreparation { config: ClaudeConfiguration; configurationHash: string; command: string; version: string }
const fail = (code: string, state: 'waiting_configuration' | 'retry_wait' | 'cancelled' | 'needs_replan' = 'waiting_configuration'): never => { throw new TaskError(code, state); };
const executionFailure = (fault: string): never => fail(({ authentication: 'claude_authentication_failed', model: 'claude_model_unavailable', rate_limit: 'claude_rate_limited', transport: 'claude_transport_error' } as Record<string, string>)[fault] ?? 'claude_execution_failed', ['rate_limit', 'transport', 'execution'].includes(fault) ? 'retry_wait' : 'waiting_configuration');
/** Only an operator-owned profile is executable input. No arbitrary argv, env, hooks or provider keys. */
export function claudeConfiguration(): ClaudeConfiguration {
  const path = process.env.BOT_CLAUDE_CODE_CONFIG;
  if (!path) return fail('claude_not_configured');
  let c: any; try { c = JSON.parse(readFileSync(path, 'utf8')); } catch { return fail('claude_configuration_invalid'); }
  if (!c || Object.keys(c).some(k => !['command', 'version', 'stateDirectory', 'model', 'provider', 'timeoutMs'].includes(k)) ||
    c.version !== claudeCodeRuntime.version || typeof c.stateDirectory !== 'string' || !isAbsolute(c.stateDirectory) ||
    c.command !== undefined && (typeof c.command !== 'string' || !isAbsolute(c.command)) ||
    typeof c.model !== 'string' || !/^claude-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(c.model) || /(?:^|-)latest$/.test(c.model) ||
    c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 3600_000)) return fail('claude_configuration_invalid');
  if (!c.provider || typeof c.provider !== 'object' || Array.isArray(c.provider) || Object.keys(c.provider).some(k => !['baseUrl', 'credentialFile'].includes(k)) || typeof c.provider.credentialFile !== 'string' || !isAbsolute(c.provider.credentialFile)) return fail('claude_configuration_invalid');
  let url: URL; try { url = new URL(c.provider.baseUrl); } catch { return fail('claude_configuration_invalid'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
    url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) return fail('claude_configuration_invalid');
  return { version: c.version, stateDirectory: c.stateDirectory, model: c.model,
    ...(c.command ? { command: c.command } : {}), ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
    provider: { baseUrl: c.provider.baseUrl, credentialFile: c.provider.credentialFile } };
}
/** Resolve the pinned native optional package directly: npm ci --ignore-scripts leaves the npm bin as a stub. */
export function claudeBinary(): string {
  const platform = process.platform, arch = process.arch;
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) return fail('claude_platform_unsupported');
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const name = `@anthropic-ai/claude-code-linux-${arch}${report.header.glibcVersionRuntime ? '' : '-musl'}`;
  try { return join(dirname(createRequire(import.meta.url).resolve(name + '/package.json')), 'claude'); } catch { return fail('claude_binary_unavailable'); }
}
function privateDirectory(path: string) {
  let ancestor = resolve(path); while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) return fail('claude_state_directory_invalid');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (realpathSync(path) !== resolve(path) || !stat.isDirectory() || (stat.mode & 0o077) !== 0) return fail('claude_state_directory_invalid');
}
function environment(home: string, tmp: string): NodeJS.ProcessEnv {
  return { PATH: dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, TMPDIR: tmp,
    CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
/** Called by RoleRun.prepare before start: verify the selected binary and version in a fresh, empty HOME. */
export async function prepareClaudeCode<T>(spec: AgentSpec<T>) {
  const config = claudeConfiguration(), command = config.command ?? claudeBinary();
  privateDirectory(config.stateDirectory);
  const dir = mkdtempSync(join(config.stateDirectory, 'preflight-')); privateDirectory(join(dir, 'tmp'));
  try {
    const version = await new Promise<string>((ok, no) => execFile(command, ['--version'], { cwd: dir, env: environment(dir, join(dir, 'tmp')), timeout: 10_000, maxBuffer: 4096 }, (e, stdout) => e ? no(new TaskError('claude_binary_unavailable', 'waiting_configuration')) : ok(stdout.trim())));
    if (version !== `${claudeCodeRuntime.version} (Claude Code)`) return fail('claude_version_unsupported');
    if (!spec.finish || !spec.tools?.some(t => t.function.name === spec.finish!.name)) return fail('claude_submission_tool_required');
    const prepared: ClaudePreparation = { config, command, version, configurationHash: contentHash({ ...config, command, protocol: claudeCodeRuntime.protocol }) };
    spec.harnessPreparation = prepared;
    spec.harnessBinding = { model_revision: `claude_code:${config.model}:${prepared.configurationHash}`, harness_revision: `claude_code@${claudeCodeRuntime.version}:${prepared.configurationHash}` };
    spec.modelTrace = { source: 'external_harness', provider: 'anthropic_gateway', model: config.model, cli_version: claudeCodeRuntime.version, configuration_hash: prepared.configurationHash };
    return prepared;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const scope = (ctx: RunContext) => ({ tenant_id: ctx.tenant_id, project_id: ctx.project_id, task_id: ctx.task_id,...(ctx.conversation_id?{conversation_id:ctx.conversation_id}:{}),instance_id: ctx.execution_context?.role_instance_id, role: ctx.execution_context?.role, assignment_id: ctx.assignment_id });
const identity = (value: any) => value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'assignment_id'));
const inputs = (ctx: RunContext) => contentHash({ source: ctx.source_ref, contract: ctx.contract_revision, candidate: ctx.candidate_ref, role: ctx.role_revision, policy: ctx.policy_revision, skills: ctx.skill_revisions, model: ctx.model_revision });
function transcriptExists(home: string, sid: string) {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root) || realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory()) return false;
  return readdirSync(root, { withFileTypes: true }).some(d => { const file = join(root, d.name, sid + '.jsonl'); return d.isDirectory() && !d.isSymbolicLink() && existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(); });
}
/** The gateway must authenticate this exact run capability and report the requested provider/model before CLI startup. */
async function checkGateway(config: ClaudeConfiguration & { gatewayUrl: string }, token: string, signal: AbortSignal) {
  let response: Response;
  try { response = await fetch(config.gatewayUrl.replace(/\/$/, '') + '/v1/models', { headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error' }); }
  catch { if (signal.aborted) throw signal.reason; return fail('claude_gateway_unavailable', 'retry_wait'); }
  if ([401, 403].includes(response.status)) return fail('claude_authentication_failed');
  if (response.status === 429) return fail('claude_rate_limited', 'retry_wait');
  if (!response.ok) return fail('claude_gateway_unavailable', 'retry_wait');
  let body: any; try { body = await response.json(); } catch { return fail('claude_gateway_protocol_invalid'); }
  if (!Array.isArray(body.data) || !body.data.some((m: any) => m.id === config.model)) return fail('claude_model_unavailable');
}
export interface ClaudeBridge<T> { url: string; readonly submitted: boolean; readonly result: T }
/** Executes the real native CLI. Repository operations and task references stay behind the framework's broker. */
export async function runClaudeCode<T>(spec: AgentSpec<T>, bridge: ClaudeBridge<T>, signal: AbortSignal, emit: (e: HarnessEvent) => void): Promise<T> {
  const prepared = spec.harnessPreparation as ClaudePreparation | undefined;
  if (!prepared) return fail('claude_prepare_required');
  const ctx = spec.runContext?.(); if (!ctx || !spec.runAccess?.token) return fail('claude_run_context_required');
  if (!['writer', 'observer', 'evaluator'].includes(ctx.execution_context?.kind ?? '')) return fail('harness_role_unsupported');
  const gateway = await claudeModelGateway(spec, prepared.config.provider, ctx, signal);
  try { return await runAtGateway(spec, bridge, signal, emit, { ...prepared, config: { ...prepared.config, gatewayUrl: gateway.url } }, gateway.usage); }
  finally { await gateway.close(); }
}
async function runAtGateway<T>(spec: AgentSpec<T>, bridge: ClaudeBridge<T>, signal: AbortSignal, emit: (e: HarnessEvent) => void, prepared: ClaudePreparation & { config: ClaudeConfiguration & { gatewayUrl: string } }, gatewayUsage: () => ExternalUsage): Promise<T> {
  const { config } = prepared, ctx = spec.runContext?.();
  if (!ctx || !spec.runAccess?.token) return fail('claude_run_context_required');
  await spec.guard(); if (signal.aborted) throw signal.reason;
  // The CLI's dollars are an estimate for an entire native conversation, including earlier resumes. They cannot
  // enforce a framework monetary cap without a gateway billing ledger. Refuse that policy instead of counting zero.
  if (ctx.budget.max_cost) return fail('claude_cost_budget_unsupported');
  const token = spec.runAccess.token; spec.redactor.add(token);
  await checkGateway(config, token, signal);
  const previous = spec.harnessState?.value ?? {}, fresh = !!ctx.conversation_id || ['observer', 'evaluator'].includes(ctx.execution_context?.kind ?? '') || spec.roleRun?.recovery_mode === 'rebuilt_from_task_records';
  if (!fresh && previous.sessionId && previous.scope && contentHash(identity(previous.scope)) !== contentHash(identity(scope(ctx)))) return fail('claude_session_scope_mismatch');
  const inputHash = inputs(ctx), root = join(config.stateDirectory, contentHash(scope(ctx))), compatible = !fresh && previous.sessionId && contentHash(previous.scope) === contentHash(scope(ctx)) && previous.configurationHash === prepared.configurationHash && previous.inputHash === inputHash;
  privateDirectory(root);
  let resume = false, sid = randomUUID(), directory = join(root, sid), recoveryMode = fresh ? 'fresh_evaluation' : previous.sessionId ? 'rebuilt_from_task_records' : 'new_session';
  if (compatible && uuidPattern.test(previous.sessionId)) {
    const expected = join(root, previous.sessionId);
    if (previous.directory !== expected) return fail('claude_session_scope_mismatch');
    if (transcriptExists(join(expected, 'home'), previous.sessionId)) { resume = true; sid = previous.sessionId; directory = expected; recoveryMode = 'native_resume'; }
  }
  for (const d of [directory, join(directory, 'cwd'), join(directory, 'home'), join(directory, 'tmp')]) privateDirectory(d);
  const cwd = join(directory, 'cwd'), home = join(directory, 'home'), allowed = (spec.tools ?? []).map(t => 'mcp__bot__' + t.function.name);
  if (allowed.some(n => !/^mcp__bot__[A-Za-z0-9_]+$/.test(n))) return fail('claude_tool_name_unsupported');
  const args = ['--bare', '--restricted', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '',
    '--disable-slash-commands', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, enableAllProjectMcpServers: false, autoUpdatesChannel: 'stable' }),
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { bot: { type: 'http', url: bridge.url } } }),
    '--allowedTools', allowed.join(','), '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-chrome', '--model', config.model,
    '--max-turns', String(spec.maxTurns ?? 32), '--system-prompt', spec.system + '\nUse only the offered bot MCP tools. Repository work runs on the managed project computer. Read pinned skills with read_skill. Submit through ' + spec.finish!.name + '; a submission is not task acceptance. Do not publish, merge or start agents.',
    ...(resume ? ['--resume', sid] : ['--session-id', sid])];
  const env = { ...environment(home, join(directory, 'tmp')), ANTHROPIC_BASE_URL: config.gatewayUrl, ANTHROPIC_API_KEY: token,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.maxOutputTokens ?? 8192) };
  const child = spawn(prepared.command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let failure: unknown, initialized = false, result: any, finished = false, killTimer: ReturnType<typeof setTimeout> | undefined;
  let cursor = 0, publicBytes = 0, truncated = false;
  const seen = new Map<string, ClaudeUsage | null>();
  const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const interrupt = (error: unknown) => {
    if (failure) return; failure = error;
    // The print stream control protocol is the first interrupt, followed by a bounded process-group reap.
    if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }) + '\n');
    killTimer = setTimeout(kill, 500); killTimer.unref();
  };
  const abort = () => interrupt(signal.reason ?? new TaskError('harness_cancelled', 'cancelled'));
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  // Legacy absolute timeout is not a run cancellation policy. RoleRun reports to Manager instead.
  let checking = false;
  const guard = setInterval(() => { if (!checking) { checking = true; void spec.guard().catch(interrupt).finally(() => { checking = false; }); } }, 100); guard.unref();
  const save = () => spec.harnessState?.save({ sessionId: sid, previousSessionId: previous.sessionId ?? null, directory, cwd, scope: scope(ctx), inputHash,
    configurationHash: prepared.configurationHash, version: claudeCodeRuntime.version, recoveryMode, run_id: ctx.run_id, lease_epoch: ctx.lease_epoch, raw_cursor: cursor });
  const usage = (messageId: string, final?: ClaudeUsage | null) => {
    // Assistant blocks are provisional: the pinned CLI emits output_tokens=0 until result.usage.
    // The in-process gateway is authoritative when HTTP requests were forwarded, including rejected attempts.
    const measured = gatewayUsage(), snapshot: ExternalUsage = measured.model_requests ? measured : {
      model_requests: seen.size, input_tokens: final ? final.input_tokens + (final.cache_read_input_tokens ?? 0) + (final.cache_creation_input_tokens ?? 0) : [...seen.values()].reduce((n, u) => n + (u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0), 0),
      output_tokens: final?.output_tokens ?? 0, unknown_requests: final ? 0 : seen.size, semantics: final ? 'exact' : 'lower_bound', cost: 'unknown', accounting_source: final ? 'cli_result' : 'cli_provisional' };
    spec.onExternalUsage?.(snapshot); emit({ type: 'configuration', stage: 'usage', messageId, usage: snapshot, raw_cursor: cursor });
    if (final && measured.model_requests) emit({ type: 'configuration', stage: 'usage_reconciliation', gateway_usage: measured, cli_result_usage: final,
      matches: measured.unknown_requests === 0 && measured.output_tokens === final.output_tokens && measured.input_tokens === final.input_tokens + (final.cache_read_input_tokens ?? 0) + (final.cache_creation_input_tokens ?? 0) });
  };
  const stream = new ClaudeJsonStream((m, at) => {
    cursor = at; if (failure) return;
    if (result && m.type !== 'ignored') return fail('claude_protocol_incompatible');
    if (m.session_id && m.session_id !== sid) return fail('claude_session_scope_mismatch');
    if (m.type === 'init') {
      if (initialized || m.model !== config.model || m.tools.some((n: string) => !allowed.includes(n) && n !== 'EndConversation') || !Array.isArray(m.mcp_servers) || m.mcp_servers.length !== 1 || m.mcp_servers.some((s: any) => s.name !== 'bot' || s.status !== 'connected')) return fail('claude_capability_mismatch');
      initialized = true; save(); emit({ type: 'session_bound', sessionRef: sid, recoveryMode, version: claudeCodeRuntime.version, configuredModel: config.model, configurationHash: prepared.configurationHash, usage: 'unknown' }); return;
    }
    if (m.type === 'control_request') {
      emit({ type: 'permission', requestId: m.request_id, decision: 'deny' });
      child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'permission_denied' } }) + '\n'); return;
    }
    if (m.type === 'api_retry') {
      emit({ type: 'configuration', stage: 'api_retry', error: m.error, attempt: m.attempt, raw_cursor: at });
      if (m.error === 'authentication') return executionFailure(m.error);
      return;
    }
    if (m.type === 'ignored') return;
    if (!initialized) return fail('claude_protocol_incompatible');
    if (m.type === 'assistant') {
      if (m.error) return executionFailure(m.error);
      if (typeof m.id !== 'string') return fail('claude_protocol_incompatible');
      const before = seen.get(m.id);
      if (before && m.usage) seen.set(m.id, Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(k => [k, Math.max((before as any)[k] ?? 0, m.usage[k] ?? 0)])) as unknown as ClaudeUsage);
      else seen.set(m.id, m.usage ?? before ?? null);
      usage(m.id);
    }
    for (const c of m.content ?? []) {
      if (c.type === 'text') {
        const text = spec.redactor.text(c.text), room = Math.max(0, 32 * 1024 - publicBytes), bounded = Buffer.from(text).subarray(0, room).toString('utf8'); publicBytes += Buffer.byteLength(bounded);
        if (bounded) emit({ type: 'message', text: bounded, raw_cursor: at });
        if (Buffer.byteLength(text) > room && !truncated) { truncated = true; emit({ type: 'configuration', output_truncated: true, limit_bytes: 32 * 1024 }); }
      } else if (c.type === 'tool_use') {
        if (!allowed.includes(c.name)) return fail('claude_tool_denied');
        emit({ type: 'tool', callId: c.id, name: c.name, phase: 'started', raw_cursor: at });
      }
    }
    if (m.type === 'result') { result = m; usage('result', m.usage); child.stdin.end(); }
    save();
  });
  child.stdout.on('data', chunk => { try { stream.push(chunk); } catch (e) { interrupt(e); } });
  // Do not persist raw stderr: the vendor may place private or credential-bearing diagnostics there.
  child.stderr.resume(); child.stdin.on('error', () => interrupt(new TaskError('claude_stream_interrupted', 'retry_wait')));
  const closed = new Promise<number | null>((ok, no) => { child.once('error', () => no(new TaskError('claude_binary_unavailable', 'waiting_configuration'))); child.once('close', code => ok(code)); });
  try {
    spec.onExternalUsage?.({ model_requests: 0, input_tokens: 0, output_tokens: 0, unknown_requests: 0, semantics: 'exact', cost: 'unknown' });
    child.stdin.write(JSON.stringify(claudeUserMessage(spec.prompt + '\nRecovery: ' + recoveryMode + '. Inspect task records and unknown side effects before repeating operations.', sid)) + '\n');
    const code = await closed;
    if (failure) throw failure;
    stream.end(); await spec.guard(); if (signal.aborted) throw signal.reason;
    emit({ type: 'configuration', stage: 'process_exit', exit_code: code, result_subtype: result?.subtype ?? null });
    // The pinned CLI exits 1 for structured errors too; its result must win over the OS exit code.
    // waiting_configuration is automatically polled by the engine; an unchanged CLI limit must not spin new runs.
    if (result?.subtype.startsWith('error_max_')) return fail('claude_budget_exhausted', 'needs_replan');
    if (result && (result.is_error || result.subtype !== 'success')) return executionFailure(result.fault ?? 'execution');
    if (code !== 0) return fail('claude_process_exit', 'retry_wait');
    if (!result) return fail('claude_result_missing', 'retry_wait');
    if (!bridge.submitted) return fail('claude_submission_required', 'retry_wait');
    finished = true; return bridge.result;
  } finally {
    clearInterval(guard); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', abort);
    kill(); child.stdin.destroy(); if (!finished) emit({ type: 'configuration', ended_without_validated_result: true, raw_cursor: cursor });
  }
}
