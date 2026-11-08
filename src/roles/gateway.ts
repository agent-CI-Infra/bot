import type { Store, Row } from '../storage/database.js';
import { TaskError } from '../agent/common.js';
import { traceEvent, traceSource } from '../tasks/trace.js';
import { memoryTool } from '../memory/project.js';
import { authorize, resolvePrincipalActor } from '../identity/authorization.js';
import { roleAuthority, type RoleSnapshot } from './definition.js';
import { verifyRunToken, tenantOf } from './role-run.js';
import { contentHash, roleRunProtocol } from './protocol.js';
/**
 * TaskToolGateway: the one server-side broker through which a role run reads task facts, original records, evidence and
 * project knowledge, and proposes experience candidates. Every call presents the run's capability token and is checked
 * again on the server: token binding and expiry, the current lease epoch, the run still running, the principal's current
 * authorization, the role's live policy, and the reference's own scope. A reference is a pointer, not a pass to read
 * everything: other tasks, other role instances' runs and model exchanges, and other roles' scoped memory are refused,
 * and a refused or guessed reference gets the same answer as a missing one. The gateway has no SQL, shell, publication,
 * merge or management tool. Calls and the exact versions read go into the task trace.
 */
const tool = (name: string, description: string, properties: any, required: string[] = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
export const gatewayTools = [
  tool('read_task_record', 'Read a durable record from THIS task by offered reference; use offset to page its JSON.', { ref: { type: 'string' }, offset: { type: 'integer' } }, ['ref']),
  tool('list_task_records', 'List references (type and ref, no bodies) of this task\'s durable records, newest first. Expand one with read_task_record.', { types: { type: 'array', items: { type: 'string' } }, before: { type: 'integer' }, limit: { type: 'integer' } }),
  tool('search_knowledge', 'Search this project\'s knowledge for your role. Previews are not proof; read the exact revision before relying on it.', { query: { type: 'string' }, module: { type: 'string' }, kind: { type: 'string' } }),
  tool('read_knowledge', 'Read one exact project knowledge revision and its sources.', { id: { type: 'string' }, revision: { type: 'integer' }, offset: { type: 'integer' } }, ['id']),
  tool('propose_experience', 'Propose an unverified experience candidate with its evidence references. It asserts no fact and changes no decision.', { key: { type: 'string' }, body: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, request_id: { type: 'string' } }, ['key', 'body', 'evidence'])
];
export const gatewayToolNames = gatewayTools.map(t => t.function.name);
// The capability policy names each gateway tool is governed by.
const policyName: Record<string, string> = { read_task_record: 'read_task_record', list_task_records: 'read_task_history', search_knowledge: 'search_project_memory', read_knowledge: 'read_project_memory', propose_experience: 'remember_project_memory' };
/** The gateway capabilities a role's policy allows; a token carries only these. */
export const gatewayCapabilities = (snapshot: RoleSnapshot) => gatewayToolNames.filter(name => !snapshot.capability.tools || snapshot.capability.tools.includes(policyName[name]!)).map(name => 'gateway:' + name);
const refusal = (code: string) => ({ error: code });
export interface GatewayRequest { tool: string; arguments?: any; run_id?: string; lease_epoch?: number; request_id?: string }

export class TaskToolGateway {
  constructor(private readonly store: Store) {}
  /** Tool definitions this token may call. */
  catalog(token: string) { const binding = verifyRunToken(this.store, token, {}); return gatewayTools.filter(t => binding.capabilities.includes('gateway:' + t.function.name)); }
  async call(token: string, request: GatewayRequest): Promise<any> {
    const s = this.store, name = String(request.tool ?? '');
    let binding: ReturnType<typeof verifyRunToken>;
    try { binding = verifyRunToken(s, token, { run_id: request.run_id, lease_epoch: request.lease_epoch }); }
    catch (error) { return this.denied(null, name, (error as TaskError).code ?? 'run_token_invalid', request); }
    const run = s.get('SELECT * FROM task_runs WHERE id=?', binding.run_id), task = run ? s.get('SELECT * FROM tasks WHERE id=?', run.task_id) : undefined;
    if (!run || !task) return this.denied(null, name, 'role_run_unknown', request);
    const context = { run, task, binding };
    if (run.status !== 'running') return this.denied(context, name, 'role_run_not_running', request);
    if (String(task.repository_id) !== binding.project_id || tenantOf(s, String(task.repository_id)) !== binding.tenant_id) return this.denied(context, name, 'run_token_scope_mismatch', request);
    if (!gatewayToolNames.includes(name)) return this.denied(context, name, 'tool_not_allowed', request);
    if (!binding.capabilities.includes('gateway:' + name)) return this.denied(context, name, 'run_token_capability_denied', request);
    // The person behind a requested task must still hold the right; event tasks act for the installation the engine guards.
    const authorization = s.hasTable('task_authorizations') ? s.get('SELECT * FROM task_authorizations WHERE task_id=?', task.id) : null;
    if (authorization) {
      try { authorize(resolvePrincipalActor(s, String(authorization.principal_id), String(authorization.tenant_id), String(task.repository_id)), name === 'propose_experience' ? 'knowledge.write' : name.endsWith('knowledge') ? 'knowledge.read' : 'tasks.read'); }
      catch { return this.denied(context, name, 'principal_authorization_revoked', request); }
    }
    const snapshotRow = run.role_snapshot ? s.get('SELECT snapshot FROM role_snapshots WHERE id=?', run.role_snapshot) : undefined, snapshot = snapshotRow ? JSON.parse(String(snapshotRow.snapshot)) as RoleSnapshot : null;
    if (!snapshot) return this.denied(context, name, 'role_snapshot_unavailable', request);
    const revoked = roleAuthority(s, String(task.repository_id), snapshot, policyName[name]);
    if (revoked) return this.denied(context, name, revoked, request);
    const args = request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments) ? request.arguments : {};
    let result: any;
    try { result = await this.execute(context, String(run.role ?? ''), name, args, request); }
    catch (error) { result = refusal((error as any).code ?? 'gateway_error'); }
    traceEvent(s, String(task.id), 'gateway_call', { protocol: roleRunProtocol.id, tool: name, run_id: run.id, lease_epoch: binding.lease_epoch, role: run.role, request_id: request.request_id ?? args.request_id ?? null,
      outcome: result?.error ? 'refused' : 'served', error: result?.error ?? null, read: result?.version ? { ref: result.ref ?? args.ref ?? args.id ?? null, version: result.version } : null, receipt: result?.receipt ?? null }, String(run.id), 'gateway');
    return result;
  }
  private denied(context: { run: Row; task: Row } | null, name: string, reason: string, request: GatewayRequest) {
    if (context) {
      traceEvent(this.store, String(context.task.id), 'capability_denied', { role: context.run.role ?? null, tool: name, reason, run_id: context.run.id, transport: 'gateway' }, String(context.run.id), 'framework');
      traceEvent(this.store, String(context.task.id), 'gateway_call', { protocol: roleRunProtocol.id, tool: name, run_id: context.run.id, lease_epoch: request.lease_epoch ?? null, role: context.run.role ?? null, outcome: 'denied', error: reason }, String(context.run.id), 'gateway');
    }
    return refusal(reason);
  }
  private async execute(context: { run: Row; task: Row; binding: ReturnType<typeof verifyRunToken> }, role: string, name: string, args: any, request: GatewayRequest) {
    const s = this.store, { run, task } = context;
    if (name === 'read_task_record') return this.read(run, task, role, args);
    if (name === 'list_task_records') {
      const limit = args.limit ?? 50, before = args.before ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(before)) return refusal('invalid_page');
      const types = Array.isArray(args.types) ? args.types.filter((t: unknown) => typeof t === 'string').slice(0, 20) : [];
      const rows = s.all(`SELECT id,type,run_id,created_at FROM task_history WHERE task_id=? AND id<?${types.length ? ` AND type IN (${types.map(() => '?').join(',')})` : ''} ORDER BY id DESC LIMIT ?`, task.id, before, ...types, limit + 1);
      const visible = rows.filter(r => this.visible(task, run, role, 'task_history:' + r.id));
      return { records: visible.slice(0, limit).map(r => ({ ref: 'task_history:' + r.id, type: r.type, run_id: r.run_id, created_at: r.created_at })), next_before: rows.length > limit ? rows[limit - 1]!.id : null };
    }
    // Knowledge reuses ProjectMemory and its trace; another role's scoped memory reads as missing.
    const scoped = { ...task, trace_run_id: run.id, active_role: role };
    if (name === 'search_knowledge') return memoryTool(s, scoped, 'search_project_memory', { query: args.query ?? '', module: args.module, kind: args.kind, role_scope: role });
    if (name === 'read_knowledge') {
      if (typeof args.id !== 'string') return refusal('knowledge_not_found');
      const row = s.get('SELECT v.data FROM project_memory_versions v JOIN project_memories m ON m.id=v.memory_id WHERE m.id=? AND m.repository_id=? ORDER BY v.revision DESC LIMIT 1', args.id, task.repository_id);
      const owner = row ? JSON.parse(String(row.data))?.scope?.role : undefined;
      if (!row || owner && owner !== role) return refusal('knowledge_not_found');
      const result = await memoryTool(s, scoped, 'read_project_memory', { id: args.id, revision: args.revision, offset: args.offset });
      return result?.error ? result : { ...result, ref: `project_memories:${result.id}:${result.revision}`, version: contentHash(result.body ?? null) };
    }
    // An experience candidate is idempotent per request id across every run of the scope: a confirmed write is not replayed.
    const requestId = typeof (request.request_id ?? args.request_id) === 'string' ? String(request.request_id ?? args.request_id).slice(0, 128) : null;
    if (requestId) {
      const prior = s.get("SELECT h.data FROM task_history h JOIN task_runs r ON r.id=h.run_id WHERE h.task_id=? AND h.type='gateway_call' AND r.lease_scope=? AND json_extract(h.data,'$.tool')='propose_experience' AND json_extract(h.data,'$.request_id')=? AND json_extract(h.data,'$.outcome')='served' ORDER BY h.id DESC LIMIT 1", task.id, run.lease_scope, requestId);
      if (prior) return { receipt: JSON.parse(String(prior.data)).receipt, reused: true };
    }
    if (!Array.isArray(args.evidence) || !args.evidence.length || args.evidence.length > 20 || args.evidence.some((ref: unknown) => typeof ref !== 'string' || !this.visible(task, run, role, ref))) return refusal('experience_evidence_invalid');
    const saved = await memoryTool(s, scoped, 'remember_project_memory', { key: String(args.key ?? '').slice(0, 120), body: String(args.body ?? '').slice(0, 8000), kind: 'experience' });
    return saved?.error ? saved : { receipt: { id: saved.id, revision: saved.revision, verification: saved.verification ?? 'unverified', evidence: args.evidence } };
  }
  /** Whether this run's role may expand a reference of its own task. */
  private visible(task: Row, run: Row, role: string, ref: string): boolean {
    const s = this.store;
    const runRef = /^(?:model_requests|task_runs):([^:]+):/.exec(ref);
    if (runRef) {
      // Model exchanges and run snapshots belong to the role instance that made them.
      const owner = /^model_requests:/.test(ref) ? s.get('SELECT r.role_instance_id FROM model_requests m JOIN task_runs r ON r.id=m.run_id WHERE m.id=? AND m.task_id=?', runRef[1]!, task.id) : s.get('SELECT role_instance_id FROM task_runs WHERE id=? AND task_id=?', runRef[1]!, task.id);
      return !!owner && (owner.role_instance_id ?? null) === (run.role_instance_id ?? null);
    }
    const memory = /^project_memories:([^:]+):(\d+)$/.exec(ref);
    if (memory) { const row = s.get('SELECT v.data FROM project_memory_versions v JOIN project_memories m ON m.id=v.memory_id WHERE m.id=? AND m.repository_id=? AND v.revision=?', memory[1]!, task.repository_id, Number(memory[2])); const owner = row ? JSON.parse(String(row.data))?.scope?.role : undefined; return !!row && (!owner || owner === role); }
    const history = /^task_history:(\d+)$/.exec(ref);
    if (history) {
      const row = s.get('SELECT type,run_id FROM task_history WHERE id=? AND task_id=?', Number(history[1]), task.id);
      if (!row) return false;
      // Another instance's raw role input carries its own prompt and transcript context; its results and findings are shared facts.
      if (row.type === 'role_input' || row.type === 'role_run_checkpoint') { const owner = row.run_id ? s.get('SELECT role_instance_id FROM task_runs WHERE id=?', row.run_id)?.role_instance_id : null; const own = s.get("SELECT 1 FROM task_history WHERE id=? AND json_extract(data,'$.instance_id')=?", Number(history[1]), run.role_instance_id ?? ''); return !!own || owner === run.role_instance_id; }
      return true;
    }
    return /^(?:task:|contract:revision:|role_snapshots:|task_tools:|task_logs:|github_effects:)/.test(ref);
  }
  private read(run: Row, task: Row, role: string, args: any) {
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) return refusal('invalid_offset');
    const ref = String(args.ref ?? ''), missing = { error: 'task_record_not_found', ref, instruction: 'Use an offered task_history source, task:' + task.id + ' or contract:revision:' + (this.store.get('SELECT revision FROM task_records WHERE task_id=?', task.id)?.revision ?? 0) };
    if (!this.visible(task, run, role, ref)) return missing;
    let source: unknown; try { source = traceSource(this.store, String(task.id), ref); } catch { return missing; }
    const text = JSON.stringify(source), version = contentHash(source);
    traceEvent(this.store, String(task.id), 'role_record_read', { role, ref, offset, version, via: 'gateway' }, String(run.id), 'role:' + role, [ref]);
    return { ref, content: text.slice(offset, offset + 16000), next_offset: offset + 16000 < text.length ? offset + 16000 : null, version };
  }
  /** MCP JSON-RPC over any transport: initialize, tools/list and tools/call for the token's run. */
  async mcp(token: string, message: any) {
    const id = message?.id ?? null, method = message?.method;
    try {
      if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bot-task-gateway', version: String(roleRunProtocol.version) } } };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: this.catalog(token).map(t => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })) } };
      if (method === 'tools/call') { const value = await this.call(token, { tool: message.params?.name, arguments: message.params?.arguments ?? {} }); return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: !!value?.error } }; }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_found' } };
    } catch (error) { return { jsonrpc: '2.0', id, error: { code: -32603, message: String((error as any).code ?? 'gateway_error') } }; }
  }
}
