import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store, Row } from '../storage/database.js';
import { TaskError, stop, executionBaseline } from '../agent/common.js';
import { traceEvent, traceClean } from '../tasks/trace.js';
import { roleRunProtocol, validateRunContext, validateEvent, validateCandidateRef, assertSecretFree, contentHash, protocolRecovery,
  type Budget, type CandidateRef, type CapabilityName, type HarnessCapabilities, type RecoveryMode, type RunContext, type RunEvent } from './protocol.js';
import type { RoleSnapshot } from './definition.js';
import { roleCapacity } from './board.js';
/**
 * Control-plane side of the RoleRun protocol. The rows it adds hang off the existing task_runs (one row per execution
 * attempt), role_instances and role_assignments; nothing here queues or completes tasks.
 *   role_run_leases   the current lease of each assignment scope: which run holds it under which epoch
 *   role_run_tokens   short-lived capability tokens (only their hash) bound to tenant, project, task, run and epoch
 *   role_run_events   sequence index of the normalized event stream; event bodies live in task_history
 */
const now = () => new Date().toISOString();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function roleRunStorage(s: Store) {
  s.db.exec(`CREATE TABLE IF NOT EXISTS role_run_leases(scope TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,epoch INTEGER NOT NULL,run_id TEXT NOT NULL,claim_token TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS role_run_tokens(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,capabilities TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,revoke_reason TEXT);
    CREATE INDEX IF NOT EXISTS role_run_tokens_run ON role_run_tokens(run_id);
    CREATE TABLE IF NOT EXISTS role_run_events(run_id TEXT NOT NULL,seq INTEGER NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,lease_epoch INTEGER NOT NULL,type TEXT NOT NULL,
      category TEXT NOT NULL,operation_id TEXT,source_version TEXT NOT NULL,digest TEXT NOT NULL,history_ref TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,seq));
    CREATE UNIQUE INDEX IF NOT EXISTS role_run_event_operation ON role_run_events(run_id,type,operation_id) WHERE operation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS role_run_event_task ON role_run_events(task_id,type,category);`);
  const existing = new Set(s.all('PRAGMA table_info(task_runs)').map(r => r.name));
  for (const [name, type] of Object.entries({ lease_scope: 'TEXT', lease_epoch: 'INTEGER', resume_from_run_id: 'TEXT', run_context: 'TEXT', admission: 'TEXT', protocol_recovery: 'TEXT', operation_id: 'TEXT' }))
    if (!existing.has(name)) s.db.exec(`ALTER TABLE task_runs ADD COLUMN ${name} ${type}`);
  // A restart ends every run that was still running (interruptRuns); their tokens must not outlive them.
  s.run("UPDATE role_run_tokens SET revoked_at=?,revoke_reason='run_not_running' WHERE revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.id=role_run_tokens.run_id AND r.status='running')", Date.now());
}

// ---------------------------------------------------------------- leases
/**
 * The scheduler's lease for one assignment scope. Only control-plane code that starts a run calls this; adapters, workers
 * and tools never choose an epoch. Epochs increase per task, so a run, its tokens, events and checkpoints are told apart
 * even across scopes. Taking a scope over revokes the previous run's tokens; its later results are stale. claim is the
 * task claim the caller executes under (an engine execution); a run outside the task claim, such as a coordinator with
 * its own worker claim, passes null and is not ended by the task being claimed again.
 */
export function allocateLease(s: Store, taskId: string, scope: string, runId: string, claim: string | null = null) {
  return s.transaction(() => {
    const epoch = Number(s.get('SELECT max(coalesce((SELECT max(lease_epoch) FROM task_runs WHERE task_id=?),0),coalesce((SELECT max(epoch) FROM role_run_leases WHERE task_id=?),0)) n', taskId, taskId)!.n) + 1;
    const previous = s.get('SELECT run_id,epoch FROM role_run_leases WHERE scope=?', scope);
    s.run('INSERT INTO role_run_leases VALUES(?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET epoch=excluded.epoch,run_id=excluded.run_id,claim_token=excluded.claim_token,updated_at=excluded.updated_at', scope, taskId, epoch, runId, claim, now());
    s.run('UPDATE task_runs SET lease_scope=?,lease_epoch=? WHERE id=?', scope, epoch, runId);
    if (previous && previous.run_id !== runId) revokeRunTokens(s, String(previous.run_id), 'lease_taken_over');
    return { epoch, previous_run_id: previous?.run_id as string | undefined, previous_epoch: previous?.epoch as number | undefined };
  });
}
/** A run holds its lease while it is the scope's current run under that epoch and the task claim it was started under stands. */
export function leaseCurrent(s: Store, runId: string, epoch: number): boolean {
  const run = s.get('SELECT task_id,lease_scope,lease_epoch FROM task_runs WHERE id=?', runId);
  if (!run || run.lease_epoch !== epoch || !run.lease_scope) return false;
  const lease = s.get('SELECT run_id,epoch,claim_token FROM role_run_leases WHERE scope=?', run.lease_scope);
  if (!lease || lease.run_id !== runId || lease.epoch !== epoch) return false;
  return lease.claim_token === null || s.get('SELECT claim_token FROM tasks WHERE id=?', run.task_id)?.claim_token === lease.claim_token;
}
export function assertLease(s: Store, runId: string, epoch: number) {
  if (!leaseCurrent(s, runId, epoch)) stop('lease_epoch_stale', 'cancelled', `运行 ${runId} 的租约 epoch ${epoch} 已被接管或撤销，结果不再被接受。`);
}

// ---------------------------------------------------------------- capability tokens
export interface RunBinding { tenant_id: string; project_id: string; task_id: string; run_id: string; lease_epoch: number }
const tokenPattern = /^rrt_([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/;
/** Issues a token for one run. Only its hash is stored; the value goes to the adapter and into the run's redactor. */
export function issueRunToken(s: Store, binding: RunBinding, capabilities: string[], ttlMs = 15 * 60_000, at = Date.now()) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw new TaskError('run_token_ttl_invalid', 'failed');
  const id = randomBytes(9).toString('base64url'), secret = randomBytes(32).toString('base64url');
  s.run('INSERT INTO role_run_tokens VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)', id, digest(secret), binding.tenant_id, binding.project_id, binding.task_id, binding.run_id, binding.lease_epoch, JSON.stringify([...new Set(capabilities)].sort()), at, at + ttlMs);
  return { token: `rrt_${id}.${secret}`, id, expires_at: at + ttlMs };
}
/** Throws a TaskError whose code names the refusal: invalid, expired, revoked, another scope, a stale lease or a missing capability. */
export function verifyRunToken(s: Store, token: unknown, expect: Partial<RunBinding>, capability?: string, at = Date.now()) {
  const deny = (code: string): never => { throw new TaskError(code, 'failed'); };
  const match = tokenPattern.exec(typeof token === 'string' ? token : '');
  if (!match) return deny('run_token_invalid');
  const row = s.get('SELECT * FROM role_run_tokens WHERE id=?', match[1]!);
  if (!row || !timingSafeEqual(Buffer.from(String(row.token_hash), 'hex'), Buffer.from(digest(match[2]!), 'hex'))) return deny('run_token_invalid');
  if (row.revoked_at !== null) deny('run_token_revoked');
  if (Number(row.expires_at) <= at) deny('run_token_expired');
  for (const [key, value] of Object.entries(expect)) if (value !== undefined && String(row[key]) !== String(value)) deny('run_token_scope_mismatch');
  if (!leaseCurrent(s, String(row.run_id), Number(row.lease_epoch))) deny('lease_epoch_stale');
  const granted: string[] = JSON.parse(String(row.capabilities));
  if (capability && !granted.includes(capability)) deny('run_token_capability_denied');
  return { id: String(row.id), tenant_id: String(row.tenant_id), project_id: String(row.project_id), task_id: String(row.task_id), run_id: String(row.run_id), lease_epoch: Number(row.lease_epoch), capabilities: granted, expires_at: Number(row.expires_at) };
}
/**
 * Sliding expiry: a token stays valid only while its run keeps passing control-plane guards.
 * Revocation and expiry are checked on every call; the database row is rewritten only once at least
 * minExtendMs of the TTL window has elapsed (default: 30 s, bounded to half of ttlMs for short TTLs).
 */
export function touchRunToken(s: Store, id: string, ttlMs = 15 * 60_000, at = Date.now(), minExtendMs = Math.min(30_000, Math.floor(ttlMs / 2))) {
  const row = s.get('SELECT revoked_at,expires_at FROM role_run_tokens WHERE id=?', id);
  if (!row || row.revoked_at !== null || Number(row.expires_at) <= at) return false;
  if (at + ttlMs - Number(row.expires_at) < minExtendMs) return true;
  return Number(s.run('UPDATE role_run_tokens SET expires_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>?', at + ttlMs, id, at).changes) > 0;
}
export function revokeRunTokens(s: Store, runId: string, reason: string, at = Date.now()) {
  return Number(s.run('UPDATE role_run_tokens SET revoked_at=?,revoke_reason=? WHERE run_id=? AND revoked_at IS NULL', at, reason, runId).changes);
}

// ---------------------------------------------------------------- normalized events
/**
 * Appends one event to a run's stream. The control plane numbers its own events; an adapter that numbers its own sends
 * seq, and a repeated seq with the same content is acknowledged as a duplicate. A gap, an older seq, conflicting content,
 * an event after the run's end or under a stale epoch is refused and the refusal itself is recorded.
 */
export function appendRunEvent(s: Store, input: { run_id: string; lease_epoch: number; seq?: number; type: RunEvent['type']; category: RunEvent['category']; operation_id?: string | null; source_version?: string; data?: Record<string, unknown> }) {
  const run = s.get('SELECT task_id,lease_epoch,ended_at,harness,harness_version FROM task_runs WHERE id=?', input.run_id);
  if (!run) return { accepted: false as const, reason: 'role_run_unknown' };
  const refuse = (reason: string) => { traceEvent(s, String(run.task_id), 'role_run_event_rejected', { run_id: input.run_id, seq: input.seq ?? null, lease_epoch: input.lease_epoch, type: input.type, operation_id: input.operation_id ?? null, reason }, input.run_id, 'framework'); return { accepted: false as const, reason }; };
  return s.transaction(() => {
    const last = Number(s.get('SELECT coalesce(max(seq),0) n FROM role_run_events WHERE run_id=?', input.run_id)!.n), seq = input.seq ?? last + 1;
    let event: RunEvent;
    try { event = validateEvent({ run_id: input.run_id, seq, lease_epoch: input.lease_epoch, type: input.type, category: input.category, operation_id: input.operation_id ?? null, source_version: input.source_version ?? `${run.harness ?? 'unknown'}@${run.harness_version ?? 'unknown'}`, data: traceClean(input.data ?? {}) }); }
    catch (error) { return refuse((error as TaskError).detail ?? 'event_invalid'); }
    const body = contentHash({ type: event.type, category: event.category, operation_id: event.operation_id, data: event.data });
    const existing = s.get('SELECT digest,history_ref FROM role_run_events WHERE run_id=? AND seq=?', input.run_id, seq);
    if (existing) return existing.digest === body ? { accepted: false as const, duplicate: true, seq, ref: String(existing.history_ref) } : refuse('event_conflict');
    if (input.lease_epoch !== run.lease_epoch || !leaseCurrent(s, input.run_id, input.lease_epoch)) return refuse('lease_epoch_stale');
    if (s.get("SELECT 1 FROM role_run_events WHERE run_id=? AND type='ended'", input.run_id)) return refuse('event_after_end');
    if (seq !== last + 1) return refuse(seq <= last ? 'event_out_of_order' : 'event_sequence_gap');
    if (event.operation_id && s.get('SELECT 1 FROM role_run_events WHERE run_id=? AND type=? AND operation_id=?', input.run_id, event.type, event.operation_id)) return refuse('event_operation_repeated');
    const ref = traceEvent(s, String(run.task_id), 'role_run_event', { protocol: roleRunProtocol.id, ...event }, input.run_id, 'harness');
    s.run('INSERT INTO role_run_events VALUES(?,?,?,?,?,?,?,?,?,?,?)', input.run_id, seq, run.task_id, event.lease_epoch, event.type, event.category, event.operation_id, event.source_version, body, ref, now());
    return { accepted: true as const, seq, ref };
  });
}
// An event's history record by primary key. Matching on 'task_history:'||h.id cannot use the key: SQLite then scanned the
// whole task_history table (100k+ rows) on every lookup, and the engine's task guard runs one several times a second.
// The string comparison stays as a check. Order such queries by historyOrder, which belongs to the event row.
export const eventHistory = "h.id=CAST(substr(e.history_ref,14) AS INTEGER) AND e.history_ref='task_history:'||h.id";
export const historyOrder = 'CAST(substr(e.history_ref,14) AS INTEGER)';
/** A bounded page of a run's events after a cursor. Reading again after a broken connection continues the same run. */
export function runEvents(s: Store, runId: string, after = 0, limit = 100) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new TaskError('role_run_cursor_invalid', 'failed');
  const rows = s.all(`SELECT e.seq,e.history_ref,h.data FROM role_run_events e JOIN task_history h ON h.task_id=e.task_id AND ${eventHistory} WHERE e.run_id=? AND e.seq>? ORDER BY e.seq LIMIT ?`, runId, after, Math.min(limit, 500));
  const events = rows.map(r => ({ ...JSON.parse(String(r.data)), ref: r.history_ref }));
  const last = Number(s.get('SELECT coalesce(max(seq),0) n FROM role_run_events WHERE run_id=?', runId)!.n);
  return { run_id: runId, events, next_cursor: events.length ? events.at(-1)!.seq : after, more: (events.at(-1)?.seq ?? after) < last, ended: !!s.get("SELECT 1 FROM role_run_events WHERE run_id=? AND type='ended'", runId) };
}

// ---------------------------------------------------------------- run context
/** The tenant of a project: its identity tenant, or before identity migration the owning account. */
export function tenantOf(s: Store, repositoryId: string) {
  const tenant = s.hasTable('identity_projects') ? s.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', repositoryId)?.tenant_id : null;
  return tenant ? String(tenant) : 'account:' + String(s.get('SELECT account_id FROM repositories WHERE id=?', repositoryId)?.account_id ?? 'unknown');
}
/** Who the run acts for: the person who requested the task, or the GitHub App installation that delivered its event. */
export function principalOf(s: Store, task: Row) {
  const authorized = s.hasTable('task_authorizations') ? s.get('SELECT principal_id FROM task_authorizations WHERE task_id=?', task.id) : null;
  return authorized ? 'principal:' + authorized.principal_id : 'installation:' + String(s.get('SELECT account_id FROM repositories WHERE id=?', task.repository_id)?.account_id ?? 'unknown');
}
/** A fixed source: the execution baseline commit, otherwise the immutable contract revision. Never a moving branch. */
export function sourceRef(s: Store, task: Row) {
  const base = executionBaseline(task);
  return base && /^[a-f0-9]{40}$/.test(base) ? 'commit:' + base : 'contract:revision:' + Number(s.get('SELECT revision FROM task_records WHERE task_id=?', task.id)?.revision ?? 0);
}
/** The candidate a record describes: code with commit and tree, otherwise the content hash of its artifacts. */
export function candidateFromRecord(candidate: any): CandidateRef | null {
  if (!candidate?.id) return null;
  const code = (candidate.artifacts ?? []).find((a: any) => ['code', 'files'].includes(a?.kind));
  // The artifact version is the tree acceptance checks out and verifies; the content's own tree is the fallback.
  const commit = code?.content?.local_sha ?? code?.content?.sha, tree = /^[a-f0-9]{40}$/.test(code?.version ?? '') ? code.version : code?.content?.tree_sha;
  if (/^[a-f0-9]{40}$/.test(commit ?? '') && /^[a-f0-9]{40}$/.test(tree ?? '')) return { kind: 'code', ref: 'candidate:' + candidate.id, commit_sha: commit, tree_hash: tree };
  return { kind: 'artifact', ref: 'candidate:' + candidate.id, revision: 'revision:' + Number(candidate.revision ?? 0), content_hash: contentHash({ artifacts: candidate.artifacts ?? [], evidence: candidate.evidence ?? [] }) };
}
/**
 * The fixed input of a run. Observers read the exact snapshot their checkout was made from (role_candidate); QA reads the
 * submitted candidate; a writer continues from the current candidate, or from its source when none exists yet.
 */
export function inputCandidate(s: Store, task: Row, role: string, kind: string): { ref: CandidateRef | null; evidence: string | null } {
  if (kind === 'observer') {
    const row = s.get("SELECT id,data FROM task_history WHERE task_id=? AND type='role_candidate' AND json_extract(data,'$.role')=? ORDER BY id DESC LIMIT 1", task.id, role);
    const data = row ? JSON.parse(String(row.data)) : null;
    if (data && /^[a-f0-9]{40}$/.test(data.sha ?? '') && /^[a-f0-9]{40}$/.test(data.version ?? '')) return { ref: { kind: 'code', ref: 'task_history:' + row!.id, commit_sha: data.sha, tree_hash: data.version }, evidence: 'task_history:' + row!.id };
  }
  const record = s.get('SELECT candidate FROM task_records WHERE task_id=?', task.id), candidate = record?.candidate ? JSON.parse(String(record.candidate)) : null, ref = candidateFromRecord(candidate);
  if (kind === 'evaluator' && ref?.kind === 'code') {
    const started = s.get("SELECT id FROM task_history WHERE task_id=? AND type='acceptance_started' AND json_extract(data,'$.candidate_id')=? AND json_extract(data,'$.source_tree')=? ORDER BY id DESC LIMIT 1", task.id, candidate.id, ref.tree_hash);
    return { ref, evidence: started ? 'task_history:' + started.id : null };
  }
  return { ref, evidence: null };
}
export function modelRevision(snapshot: RoleSnapshot) {
  return snapshot.model.source === 'external_harness' ? `external_harness:${snapshot.harness.id}@${snapshot.harness.version}` : `${snapshot.model.source}:${snapshot.model.id}@${snapshot.model.version}:${snapshot.model.profile_hash ?? 'none'}`;
}
/**
 * The budget of a run. entry-default keeps the entry's own per-run limits; bounded replaces configured limits. metered is
 * cumulative over every run of the role instance in its task: recoveries, new attempts, further delegations and
 * sub-agents all count, so neither an automatic restart nor a retry starts it over. Only a higher budget applied to the
 * role does.
 */
export function runBudget(snapshot: RoleSnapshot): Budget {
  const b: any = snapshot.budget ?? { id: 'entry-default', version: 'unknown' };
  const n = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0 ? v as number : null;
  return { policy_ref: `${b.id}@${b.version}`, accounting: b.id === 'metered' ? 'role_instance' : 'per_run', max_turns: n(b.max_turns), max_output_tokens: n(b.max_output_tokens), max_total_tokens: n(b.max_total_tokens), max_model_requests: n(b.max_model_requests),
    max_tool_calls: n(b.max_tool_calls), max_wall_ms: n(b.max_wall_seconds) ? b.max_wall_seconds * 1000 : null, max_concurrency: 1 };
}
export function buildRunContext(s: Store, input: { task: Row; scope: string; run_id: string; lease_epoch: number; resume_from_run_id?: string; instance: Row; role: string; snapshot: RoleSnapshot; snapshot_id: string; candidate: CandidateRef | null }): RunContext {
  const { task, snapshot } = input;
  const conversation=task.kind==='role.conversation'&&!!task.conversation_id;
  const ctx: RunContext = { protocol: roleRunProtocol.id, task_id:conversation?null:String(task.id),...(conversation?{conversation_id:String(task.conversation_id)}:{}),assignment_id: input.scope, run_id: input.run_id, tenant_id: tenantOf(s, String(task.repository_id)), project_id: String(task.repository_id),
    principal_ref:conversation?'principal:'+task.principal_id:principalOf(s, task),source_ref:conversation?'conversation_message:'+task.source_message:sourceRef(s, task), candidate_ref: input.candidate, configuration_snapshot_ref: 'role_snapshots:' + input.snapshot_id, lease_epoch: input.lease_epoch,
    ...(input.resume_from_run_id ? { resume_from_run_id: input.resume_from_run_id } : {}), contract_revision: Number(s.get('SELECT revision FROM task_records WHERE task_id=?', task.id)?.revision ?? 0),
    policy_revision: `${snapshot.capability.id}@${snapshot.capability.version}`, role_revision: `${input.role}@${snapshot.role_revision}:config:${snapshot.config_revision}`, harness_revision: `${snapshot.harness.id}@${snapshot.harness.version}`,
    skill_revisions: snapshot.skills ? [`${snapshot.skills.id}@${snapshot.skills.revision}:${snapshot.skills.content_hash}`] : [], model_revision: modelRevision(snapshot), budget: runBudget(snapshot),
    execution_context: { role_instance_id: String(input.instance.id), role: input.role, kind: snapshot.kind, environment_profile: `${snapshot.environment.id}@${snapshot.environment.version}` } };
  return validateRunContext(ctx);
}

// ---------------------------------------------------------------- budget usage
/**
 * Usage of every run in a scope. Unknown usage stays unknown: a request without token counts is counted in
 * unknown_requests and never as zero. Cached input is part of input, so it is not added again. Costs are the price
 * snapshot's estimate, not the provider's bill.
 */
export function scopeUsage(s: Store, scope: string, at = Date.now()) { return usageOf(s, 'lease_scope', scope, at); }
/** Usage of every run of one role instance (the role within its task): what a cumulative budget counts. */
export function instanceUsage(s: Store, instanceId: string, at = Date.now()) {
  const instance=s.get('SELECT * FROM role_instances WHERE id=?',instanceId);
  return instance?.conversation_id?conversationUsage(s,instance,undefined,at):usageOf(s, 'role_instance_id', instanceId, at);
}
/** The same cumulative role budget, including non-task turns; clearing private transcripts keeps usage counters. */
export function conversationUsage(s:Store,instance:Row,sourceMessage?:string,at=Date.now()){
  const args=[instance.conversation_id,instance.project_id,instance.role,...(sourceMessage?[sourceMessage]:[])],
    modelWhere='task_id IS NULL AND conversation_id=? AND repository_id=? AND role_id=?'+(sourceMessage?' AND source_message=?':''),
    turnWhere='conversation_id=? AND project_id=? AND role_id=?'+(sourceMessage?' AND source_message=?':'');
  const m=s.get(`SELECT count(*) n,coalesce(sum(input_tokens),0) i,coalesce(sum(output_tokens),0) o,
    sum(CASE WHEN finished_at IS NULL OR input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) unknown,sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced FROM model_requests WHERE ${modelWhere}`,...args)!;
  const t=s.get(`SELECT count(*) n,coalesce(sum(tool_calls),0) tools,coalesce(min(usage_complete),1) complete,
    coalesce(sum(max(0,CASE WHEN state='running' THEN ? ELSE updated_at END-created_at)),0) wall FROM role_conversation_turns WHERE ${turnWhere}`,at,...args)!;
  const cost=s.all(`SELECT currency,sum(cost) amount FROM model_requests WHERE ${modelWhere} AND cost IS NOT NULL GROUP BY currency`,...args).map(r=>({currency:String(r.currency),amount:Number(r.amount)}));
  return {runs:Number(t.n),model_requests:Number(m.n),input_tokens:Number(m.i),output_tokens:Number(m.o),total_tokens:Number(m.i)+Number(m.o),
    unknown_requests:Number(m.unknown??0),tool_calls:Number(t.tools),wall_ms:Number(t.wall),cost,unpriced_requests:Number(m.unpriced??0),
    tool_usage_complete:!!t.complete,semantics:m.unknown||!t.complete?'lower_bound' as const:'exact' as const};
}
function usageOf(s: Store, column: 'lease_scope' | 'role_instance_id', value: string, at: number) {
  const runs = s.all(`SELECT id,started_at,ended_at FROM task_runs WHERE ${column}=?`, value), ids = runs.map(r => String(r.id));
  if (!ids.length) return { runs: 0, model_requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, unknown_requests: 0, tool_calls: 0, wall_ms: 0, cost: [] as { currency: string; amount: number }[], unpriced_requests: 0, semantics: 'exact' as 'exact' | 'lower_bound' };
  const marks = ids.map(() => '?').join(',');
  // Provider/Codex receipt rows also feed the common invoice ledger. Their original run events below remain the
  // budget authority, including legacy/recovered events without a projected row; never count both copies.
  const m = s.get(`SELECT count(*) n,coalesce(sum(input_tokens),0) i,coalesce(sum(output_tokens),0) o,sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) unknown,sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced FROM model_requests WHERE run_id IN (${marks}) AND accounting_source NOT IN ('provider_requests','codex_events')`, ...ids)!;
  const costs = s.all(`SELECT currency,sum(cost) amount FROM model_requests WHERE run_id IN (${marks}) AND cost IS NOT NULL GROUP BY currency`, ...ids).map(r => ({ currency: String(r.currency), amount: Number(r.amount) }));
  const tools = Number(s.get(`SELECT count(*) n FROM task_history WHERE run_id IN (${marks}) AND type='tool_observation'`, ...ids)!.n);
  // An external agent with its own model (Codex) reports usage per model response as thread-total deltas; each report is one
  // request; pricing is accounted separately. A turn without any report is one unknown request, never zero: once it ended, or once its run ended
  // without its terminal status (the stream broke, the interrupt timed out). A start the server never answered is such a turn
  // too, identified by the turn id its notifications carried; with reports for that id it is already counted, and without any
  // id no report can belong to it.
  const reported = s.get(`SELECT count(*) n,coalesce(sum(json_extract(data,'$.delta.input_tokens')),0) i,coalesce(sum(json_extract(data,'$.delta.output_tokens')),0) o FROM task_history WHERE run_id IN (${marks}) AND type='harness_event' AND json_extract(data,'$.type')='usage'`, ...ids)!;
  // One unknown request per turn id (whatever records name it: started, answered, an unanswered start with its id), unless a
  // usage report for that id exists in any run of the scope; a started turn counts once it or its run ended. An unanswered
  // start without any id cannot be matched and counts by itself.
  const turnEvent = (alias: string, phases: string) => `${alias}.run_id IN (${marks}) AND ${alias}.type='harness_event' AND json_extract(${alias}.data,'$.type')='turn' AND json_extract(${alias}.data,'$.phase') IN (${phases})`;
  const unreported = Number(s.get(`SELECT
      (SELECT count(DISTINCT json_extract(t.data,'$.turnId')) FROM task_history t JOIN task_runs r ON r.id=t.run_id
        WHERE ${turnEvent('t', "'started','answered','start_unconfirmed'")} AND json_extract(t.data,'$.turnId') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM task_history u WHERE u.run_id IN (${marks}) AND u.type='harness_event' AND json_extract(u.data,'$.type')='usage' AND json_extract(u.data,'$.turnId')=json_extract(t.data,'$.turnId'))
        AND (json_extract(t.data,'$.phase')<>'started' OR r.ended_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM task_history e WHERE e.run_id=t.run_id AND e.type='harness_event' AND json_extract(e.data,'$.type')='turn' AND json_extract(e.data,'$.phase')='ended' AND json_extract(e.data,'$.turnId')=json_extract(t.data,'$.turnId'))))
      + (SELECT count(*) FROM task_history t WHERE ${turnEvent('t', "'start_unconfirmed'")} AND json_extract(t.data,'$.turnId') IS NULL) n`, ...ids, ...ids, ...ids)!.n);
  const wall = runs.reduce((sum, r) => sum + Math.max(0, (r.ended_at ? Date.parse(String(r.ended_at)) : at) - Date.parse(String(r.started_at))), 0);
  // External drivers report a monotonically updated per-run snapshot. Never invent native model_requests or count
  // every snapshot as another request; interrupted runs may retain only a lower bound, with unknown use explicit.
  const external = s.all(`SELECT h.data FROM task_history h WHERE h.run_id IN (${marks}) AND h.type='external_model_usage'
    AND h.id=(SELECT max(x.id) FROM task_history x WHERE x.run_id=h.run_id AND x.type='external_model_usage')`, ...ids).map(r => JSON.parse(String(r.data)));
  const sum = (key: string) => external.reduce((n, u) => n + Number(u[key] ?? 0), 0);
  // Codex usage events are per model response (counted above); snapshots and events never describe the same run.
  const codex = Number(reported.n) + unreported;
  const pricedExternal=Number(s.get(`SELECT count(*) n FROM model_requests WHERE run_id IN (${marks}) AND accounting_source IN ('provider_requests','codex_events') AND cost IS NOT NULL`,...ids)!.n);
  const unknown = Number(m.unknown ?? 0) + sum('unknown_requests') + unreported, input = Number(m.i) + sum('input_tokens') + Number(reported.i), output = Number(m.o) + sum('output_tokens') + Number(reported.o);
  return { runs: ids.length, model_requests: Number(m.n) + sum('model_requests') + codex, input_tokens: input, output_tokens: output, total_tokens: input + output, unknown_requests: unknown, tool_calls: tools, wall_ms: wall, cost: costs, unpriced_requests: Number(m.unpriced ?? 0) + Math.max(0,sum('model_requests') + codex-pricedExternal), semantics: unknown || external.some(u => u.semantics === 'lower_bound') ? 'lower_bound' as const : 'exact' as const };
}
/** The first budget limit the scope's usage reached, or null. With unknown usage the known part is a lower bound. */
export function budgetExceeded(budget: Budget, usage: ReturnType<typeof scopeUsage>, pending: { tool_calls?: number } = {}): string | null {
  if (budget.max_model_requests !== null && usage.model_requests >= budget.max_model_requests) return 'max_model_requests';
  if (budget.max_total_tokens !== null && usage.total_tokens >= budget.max_total_tokens) return 'max_total_tokens';
  if (budget.max_tool_calls !== null && usage.tool_calls + (pending.tool_calls ?? 0) > budget.max_tool_calls) return 'max_tool_calls';
  if (budget.max_wall_ms !== null && usage.wall_ms >= budget.max_wall_ms) return 'max_wall_ms';
  return null;
}

// ---------------------------------------------------------------- admission
export interface EnvironmentFacts { id: string; isolation: 'run_container' | 'none'; verified: boolean; evidence: string | null; detail?: unknown }
/** What each role kind and environment needs before a formal run may start. */
export function requiredCapabilities(kind: string, environment: { isolation?: string } | null): CapabilityName[] {
  const required: CapabilityName[] = ['cancel', 'version_binding', 'output_validation'];
  if (kind !== 'controller') required.push('raw_evidence');
  if (kind === 'observer' || kind === 'evaluator') required.push('fixed_candidate_read');
  if (kind === 'evaluator') required.push('fresh_context');
  if (environment?.isolation === 'run_container') required.push('run_isolation');
  return required;
}
/**
 * Admission compares what a run needs with what its harness declares and what its environment actually verified for this
 * run. A missing capability stops the run before it starts with unsupported_capability; nothing is downgraded silently.
 * run_isolation and fixed_candidate_read are never satisfied by a declaration alone.
 */
export function admitRun(s: Store, input: { task: Row; role: string; kind: string; harness: { id: string; version: string; capabilities?: HarnessCapabilities }; environment: { id: string; isolation?: string } | null;
  environmentFacts?: EnvironmentFacts | null; candidate: { ref: CandidateRef | null; evidence: string | null }; source_ref: string; fresh: boolean; validated: boolean; snapshot_id: string; record?: boolean; required?: CapabilityName[] }) {
  const c = input.harness.capabilities ?? {}, provided: Record<string, { ok: boolean; basis: string; evidence?: string | null }> = {};
  provided.cancel = { ok: c.cancel === 'abort_signal' || c.cancel === 'protocol_then_kill', basis: `harness:${c.cancel ?? 'undeclared'}` };
  provided.version_binding = { ok: c.version_binding === true && /^[a-f0-9]{64}$/.test(input.snapshot_id), basis: 'role_snapshots:' + input.snapshot_id };
  provided.output_validation = { ok: c.output_validation === true && input.validated, basis: input.validated ? 'framework_validator' : 'no_validator' };
  provided.raw_evidence = { ok: c.raw_evidence === 'control_plane_tools' || c.raw_evidence === 'task_tools', basis: `harness:${c.raw_evidence ?? 'undeclared'}` };
  provided.fresh_context = { ok: c.fresh_context === true && input.fresh, basis: input.fresh ? 'empty_session' : 'session_present' };
  const ref = input.candidate.ref;
  // A code candidate counts as fixed only with the checkout evidence that its tree was verified; other kinds are immutable records.
  provided.fixed_candidate_read = ref?.kind === 'code' ? { ok: !!input.candidate.evidence, basis: 'checkout_tree:' + ref.tree_hash, evidence: input.candidate.evidence } : { ok: true, basis: ref ? `${ref.kind}:${ref.ref}` : input.source_ref };
  const facts = input.environmentFacts;
  provided.run_isolation = { ok: c.isolation === 'run_environment' && !!facts?.verified && facts.isolation === 'run_container', basis: `harness:${c.isolation ?? 'undeclared'};environment:${facts ? (facts.verified ? 'verified' : 'unverified') : 'none'}`, evidence: facts?.evidence ?? null };
  const required = [...new Set([...requiredCapabilities(input.kind, input.environment), ...(input.required ?? [])])], missing = required.filter(name => !provided[name]?.ok);
  // A project that configured a per-role limit gets it read here. A project that did not set one still reads the policy
  // and settings rows to find that out, but counts no run rows, and its admission record stays exactly the shape it had
  // before admission existed.
  const capacity = roleCapacity(s, String(input.task.repository_id), input.role, input.kind);
  const admission = { protocol: roleRunProtocol.id, role: input.role, kind: input.kind, harness: `${input.harness.id}@${input.harness.version}`, environment: input.environment?.id ?? null, required, missing, provided: Object.fromEntries(required.map(name => [name, provided[name]])), admitted: !missing.length, ...(capacity ? { capacity } : {}) };
  if (input.record !== false) traceEvent(s, String(input.task.id), 'role_run_admission', admission, input.task.trace_run_id, 'framework');
  if (missing.length) stop('unsupported_capability', 'waiting_configuration', `${input.role}（${input.harness.id}）缺少能力：${missing.join('、')}；未启动运行，也不会换用其他执行后端。`);
  // Capability comes first: an unadmittable run must not look like a capacity wait. A full role waits for a free slot
  // instead of starting and holds no attempt: nothing ran, so the queue retries it as it is.
  if (capacity && capacity.running >= capacity.limit) stop('role_capacity', 'retry_wait', `${input.role}：本项目该角色的并发上限 ${capacity.limit} 已满（${capacity.running} 个运行中）；本次不启动，任务排队重试，不消耗尝试次数。`);
  return admission;
}

// ---------------------------------------------------------------- checkpoint and recovery
// Harness state fields that may be kept for native resume. Anything else stays out of checkpoints.
// Codex bindings add the wire protocol, the model/provider the thread runs on, the turn the binding follows and its confirmed
// status, the last turn known to exist, and the thread's cumulative usage, so a resume can check ownership and version,
// reconcile an unconfirmed turn and not count a restated total twice.
const retainedState = ['sessionId', 'previousSessionId', 'recoveryMode', 'agentInfo', 'version', 'configurationHash', 'cwd', 'scope', 'inputHash', 'run_id', 'lease_epoch', 'raw_cursor', 'protocol', 'model', 'modelProvider', 'cliVersion', 'lastTurnId', 'lastTurnStatus', 'knownTurnId', 'usage'];
export function sessionReference(s: Store, instanceId: string) {
  const row = s.get('SELECT session,harness_state,runtime FROM role_instances WHERE id=?', instanceId);
  if (!row) return null;
  const messages = JSON.parse(String(row.session ?? '[]')), state = JSON.parse(String(row.harness_state ?? '{}'));
  const kept = Object.fromEntries(Object.entries(state).filter(([key]) => retainedState.includes(key)));
  let external: Record<string, unknown> | null = Object.keys(kept).length ? kept : null, refused: string | null = null;
  try { if (external) assertSecretFree(external, 'harness_state'); } catch { external = null; refused = 'secret_shaped_state'; }
  return { transcript: messages.length ? { ref: `role_instances:${instanceId}:session`, sha256: contentHash(messages), messages: messages.length } : null,
    external_session: external ? { sha256: contentHash(external), session_id: typeof external.sessionId === 'string' ? external.sessionId : null } : null,
    workspace_session: row.runtime ? JSON.parse(String(row.runtime)) : null, refused };
}
/** Tool receipts of a run: observations the control plane recorded, and calls that started without a recorded result. */
export function toolReceipts(s: Store, runId: string) {
  const observed = s.all("SELECT id,caused_by,json_extract(data,'$.name') name FROM task_history WHERE run_id=? AND type='tool_observation' ORDER BY id", runId);
  const answered = new Set(observed.flatMap(r => JSON.parse(String(r.caused_by ?? '[]'))));
  const started = s.all("SELECT id,json_extract(data,'$.name') name,json_extract(data,'$.call_id') call_id FROM task_history WHERE run_id=? AND type='tool_started' ORDER BY id", runId);
  return { confirmed: observed.map(r => ({ ref: 'task_history:' + r.id, name: r.name })), unconfirmed: started.filter(r => !answered.has('task_history:' + r.id)).map(r => ({ ref: 'task_history:' + r.id, name: r.name, call_id: r.call_id ?? null })) };
}
export function recordCheckpoint(s: Store, input: { run_id: string; lease_epoch: number; instance_id: string; reason: string; workspace?: { tree_sha?: string; sha?: string; local_sha?: string } | null }) {
  const run = s.get('SELECT task_id FROM task_runs WHERE id=?', input.run_id);
  if (!run) return stop('role_run_unknown', 'failed');
  assertLease(s, input.run_id, input.lease_epoch);
  const session = sessionReference(s, input.instance_id), receipts = toolReceipts(s, input.run_id);
  const workspace = input.workspace && /^[a-f0-9]{40}$/.test(input.workspace.tree_sha ?? '') ? { tree_sha: input.workspace.tree_sha, commit_sha: input.workspace.local_sha ?? input.workspace.sha ?? null } : null;
  const body = { protocol: roleRunProtocol.id, run_id: input.run_id, lease_epoch: input.lease_epoch, reason: input.reason, session, receipts, workspace };
  assertSecretFree(body, 'checkpoint');
  const ref = traceEvent(s, String(run.task_id), 'role_run_checkpoint', body, input.run_id, 'framework');
  appendRunEvent(s, { run_id: input.run_id, lease_epoch: input.lease_epoch, type: 'checkpoint', category: 'checkpoint', operation_id: 'checkpoint:' + ref, data: { checkpoint_ref: ref, reason: input.reason, confirmed: receipts.confirmed.length, unconfirmed: receipts.unconfirmed.length, workspace } });
  return { checkpoint_ref: ref, ...body };
}
/**
 * Decides how a new run of the same scope continues an earlier one. The model may not change silently: a different model
 * revision refuses the recovery. The mode says what is really restored; a rebuild names what is lost, and calls that
 * started without a recorded result are listed for verification before anything is retried.
 */
export function planRecovery(s: Store, input: { previous_run_id: string; checkpoint_ref?: string | null; capabilities: HarnessCapabilities; model_revision: string; role_revision: string; session_kind: string; resumable_session: boolean }) {
  const previous = s.get('SELECT task_id,run_context FROM task_runs WHERE id=?', input.previous_run_id);
  if (!previous) return stop('role_run_unknown', 'failed');
  const earlier = previous.run_context ? JSON.parse(String(previous.run_context)) as RunContext : null;
  // An explicitly applied role revision may bring another model; the same revision resolving to another model (a changed
  // project or workflow default, a replaced profile) would be a silent switch.
  if (earlier && earlier.model_revision !== input.model_revision && earlier.role_revision === input.role_revision) stop('model_revision_changed', 'waiting_configuration', `恢复运行的模型 ${input.model_revision} 与原运行 ${earlier.model_revision} 不同；不会静默换模型继续。`);
  const checkpoint = input.checkpoint_ref ? s.get("SELECT id,data,run_id FROM task_history WHERE task_id=? AND 'task_history:'||id=? AND type='role_run_checkpoint'", previous.task_id, input.checkpoint_ref)
    : s.get("SELECT id,data,run_id FROM task_history WHERE run_id=? AND type='role_run_checkpoint' ORDER BY id DESC LIMIT 1", input.previous_run_id);
  if (input.checkpoint_ref && (!checkpoint || checkpoint.run_id !== input.previous_run_id)) stop('role_checkpoint_not_found', 'failed', '检查点不属于被恢复的运行。');
  const data = checkpoint ? JSON.parse(String(checkpoint.data)) : null, supported = new Set(input.capabilities.recovery ?? []);
  const receipts = toolReceipts(s, input.previous_run_id);
  let mode: RecoveryMode, basis: string, lost: string | null;
  if (supported.has('native_resume') && input.resumable_session) { mode = 'native_resume'; basis = input.session_kind; lost = null; }
  else if (supported.has('checkpoint_restore') && (data?.session?.transcript || input.session_kind === 'checkpoint_transcript')) { mode = 'checkpoint_restore'; basis = data ? 'task_history:' + checkpoint!.id : 'role_instance_transcript'; lost = 'tool calls without a recorded result'; }
  else if (supported.has('rebuilt_from_task_records')) { mode = 'rebuilt_from_task_records'; basis = 'task_records'; lost = 'previous conversation; only durable task records remain'; }
  else { mode = 'unsupported'; basis = 'none'; lost = 'everything not in task records'; }
  return { mode, basis, lost, checkpoint_ref: checkpoint ? 'task_history:' + checkpoint.id : null, unconfirmed_operations: receipts.unconfirmed, confirmed_operations: receipts.confirmed.length };
}
export { protocolRecovery, validateCandidateRef };
