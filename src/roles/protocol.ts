import { createHash } from 'node:crypto';
import { TaskError } from '../agent/common.js';
/**
 * RoleRun backend protocol, version 1. One RoleRun is one execution attempt (a task_runs row) of an existing role
 * assignment; it is not a task system of its own. Every adapter is driven through the same seven operations:
 *   prepare(ctx)                 -> PreparedRun with the declared, verified and missing capabilities
 *   start(prepared, operation)   -> RunHandle (the same operation id returns the same handle)
 *   events(handle, after_cursor) -> bounded, normalized events of that run
 *   checkpoint(handle)           -> checkpoint ref with session, tool receipts and workspace snapshot
 *   cancel(handle, reason)       -> cancellation receipt
 *   collect(handle)              -> validated result with immutable artifact refs
 *   recover(ctx, checkpoint_ref) -> a NEW run (new id and lease epoch) of the same instance and assignment, and its mode
 * The shapes below are the machine contract. Business success is never inferred from adapter text or an exit code.
 */
export const roleRunProtocol = { name: 'bot.role-run', version: 1, id: 'bot.role-run/1' } as const;

export type CandidateRef =
  | { kind: 'code'; ref: string; commit_sha: string; tree_hash: string }
  | { kind: 'artifact'; ref: string; revision: string; content_hash: string }
  | { kind: 'no_changes'; ref: string; source_ref: string; record_hash: string };
/** Limits of a run. per_run caps each run; role_instance counts every run of the role in its task. null means "not limited". */
export interface Budget {
  policy_ref: string; accounting: 'per_run' | 'role_instance'; max_turns: number | null; max_output_tokens: number | null; max_total_tokens: number | null; max_model_requests: number | null;
  max_tool_calls: number | null; max_wall_ms: number | null; max_concurrency: number; max_cost: { amount: number; currency: string } | null;
}
/** The backend's input view of a run. Every field is a reference or a version; secrets never appear here. */
export interface RunContext {
  protocol: typeof roleRunProtocol.id;
  task_id: string; assignment_id: string; run_id: string; tenant_id: string; project_id: string;
  principal_ref: string; source_ref: string; candidate_ref: CandidateRef | null; configuration_snapshot_ref: string;
  lease_epoch: number; resume_from_run_id?: string; contract_revision: number;
  stage_policy_hash?:string;
  stage?: {stage_id:string;plan_revision:number;policy_hash:string};
  policy_revision: string; role_revision: string; harness_revision: string; skill_revisions: string[]; model_revision: string; budget: Budget;
  /** Fields of the plan's ExecutionContext this view maps to, so the two stay translatable. */
  execution_context?: { role_instance_id: string; role: string; kind: string; environment_profile: string };
}
export const recoveryModes = ['native_resume', 'checkpoint_restore', 'rebuilt_from_task_records', 'unsupported'] as const;
export type RecoveryMode = typeof recoveryModes[number];
/**
 * The per-run recovery_mode values recorded before this protocol keep their meaning; this is their protocol name.
 * new_session, fresh_evaluation and external_session_pending describe a start, not a recovery.
 */
export function protocolRecovery(mode: string | null | undefined): RecoveryMode | null {
  if (mode === 'checkpoint_transcript' || mode === 'checkpoint_restore') return 'checkpoint_restore';
  if (mode === 'native_resume' || mode === 'rebuilt_from_task_records' || mode === 'unsupported') return mode;
  return null;
}
/**
 * Capabilities an admission can require. A harness declares what its protocol does; an environment reports what it
 * actually provided (inspected container settings, checked tree hash). A declaration alone never satisfies run_isolation
 * or fixed_candidate_read: those need the environment's verification of this very run.
 */
export const capabilityNames = ['fixed_candidate_read', 'raw_evidence', 'run_isolation', 'cancel', 'version_binding', 'output_validation', 'fresh_context'] as const;
export type CapabilityName = typeof capabilityNames[number];
/** What a harness declares. Missing keys are not supported. */
export interface HarnessCapabilities {
  /** Where tool observations come from: every tool through the control plane, only the offered task tools, or none. */
  raw_evidence?: 'control_plane_tools' | 'task_tools' | 'none';
  /** How a run is interrupted: in-process abort, or protocol cancel then a bounded wait and process-group kill. */
  cancel?: 'abort_signal' | 'protocol_then_kill' | 'none';
  /** The agent executes inside the run environment the framework provisions (not on the control plane). */
  isolation?: 'run_environment' | 'none';
  /** Runs pin the harness version, model and snapshot they started with. */
  version_binding?: boolean;
  /** Results arrive through a schema-checked submission tool, never as free text claims. */
  output_validation?: boolean;
  /** Each formal evaluation can start without the previous conversation. */
  fresh_context?: boolean;
  /** Recovery modes the harness can actually perform. */
  recovery?: readonly RecoveryMode[];
}
export const eventTypes = ['run_started', 'session_bound', 'message', 'tool_call', 'tool_result', 'artifact', 'permission', 'configuration', 'checkpoint', 'budget', 'cancel_requested', 'ended'] as const;
export const resultCategories = ['progress', 'observation', 'artifact', 'checkpoint', 'budget', 'denied', 'error', 'completed', 'cancelled', 'failed'] as const;
export interface RunEvent { run_id: string; seq: number; lease_epoch: number; type: typeof eventTypes[number]; category: typeof resultCategories[number]; operation_id: string | null; source_version: string; data: Record<string, unknown> }

const invalid = (field: string): never => { throw new TaskError('role_run_protocol_invalid', 'waiting_configuration', field); };
const hex = (n: number) => new RegExp(`^[a-f0-9]{${n}}$`);
const refPattern = /^[a-z][a-z0-9_]*:[A-Za-z0-9_.:@\/-]{1,240}$/;
// A fixed reference names an immutable version. "latest", HEAD or a branch name could move under a running role.
const mutable = /(?:^|[:@\/])(?:latest|head|main|master|current)$/i;
function ref(value: unknown, field: string) { if (typeof value !== 'string' || !refPattern.test(value) || mutable.test(value)) invalid(field); return value as string; }
export function validateCandidateRef(value: any, field = 'candidate_ref'): CandidateRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  const keys = { code: ['kind', 'ref', 'commit_sha', 'tree_hash'], artifact: ['kind', 'ref', 'revision', 'content_hash'], no_changes: ['kind', 'ref', 'source_ref', 'record_hash'] }[value.kind as string];
  if (!keys || Object.keys(value).some(k => !keys.includes(k))) return invalid(field + '.kind');
  ref(value.ref, field + '.ref');
  if (value.kind === 'code') { if (!hex(40).test(value.commit_sha ?? '')) invalid(field + '.commit_sha'); if (!hex(40).test(value.tree_hash ?? '')) invalid(field + '.tree_hash'); }
  if (value.kind === 'artifact') { if (typeof value.revision !== 'string' || !value.revision || value.revision.length > 128 || mutable.test(value.revision)) invalid(field + '.revision'); if (!hex(64).test(value.content_hash ?? '')) invalid(field + '.content_hash'); }
  if (value.kind === 'no_changes') { ref(value.source_ref, field + '.source_ref'); if (!hex(64).test(value.record_hash ?? '')) invalid(field + '.record_hash'); }
  return value as CandidateRef;
}
const contextKeys = ['protocol', 'task_id', 'assignment_id', 'run_id', 'tenant_id', 'project_id', 'principal_ref', 'source_ref', 'candidate_ref', 'configuration_snapshot_ref', 'lease_epoch', 'resume_from_run_id', 'contract_revision', 'policy_revision', 'role_revision', 'harness_revision', 'skill_revisions', 'model_revision', 'budget', 'execution_context','stage','stage_policy_hash'];
const budgetKeys = ['policy_ref', 'accounting', 'max_turns', 'max_output_tokens', 'max_total_tokens', 'max_model_requests', 'max_tool_calls', 'max_wall_ms', 'max_concurrency', 'max_cost'];
export function validateBudget(value: any, field = 'budget'): Budget {
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !budgetKeys.includes(k)) || budgetKeys.some(k => !Object.hasOwn(value, k))) return invalid(field);
  if (typeof value.policy_ref !== 'string' || !value.policy_ref) invalid(field + '.policy_ref');
  if (!['per_run', 'role_instance'].includes(value.accounting)) invalid(field + '.accounting');
  for (const key of ['max_turns', 'max_output_tokens', 'max_total_tokens', 'max_model_requests', 'max_tool_calls', 'max_wall_ms']) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 1)) invalid(`${field}.${key}`);
  if (!Number.isSafeInteger(value.max_concurrency) || value.max_concurrency < 1) invalid(field + '.max_concurrency');
  if (value.max_cost !== null && (typeof value.max_cost !== 'object' || !(value.max_cost.amount > 0) || !['USD', 'CNY'].includes(value.max_cost.currency))) invalid(field + '.max_cost');
  return value;
}
export function validateRunContext(value: any): RunContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('run_context');
  const unknown = Object.keys(value).find(k => !contextKeys.includes(k)); if (unknown) invalid(unknown);
  if (value.protocol !== roleRunProtocol.id) invalid('protocol');
  for (const key of ['task_id', 'assignment_id', 'run_id', 'tenant_id', 'project_id']) if (typeof value[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value[key])) invalid(key);
  ref(value.principal_ref, 'principal_ref'); ref(value.source_ref, 'source_ref'); ref(value.configuration_snapshot_ref, 'configuration_snapshot_ref');
  if (value.candidate_ref !== null) validateCandidateRef(value.candidate_ref);
  if (!Number.isSafeInteger(value.lease_epoch) || value.lease_epoch < 1) invalid('lease_epoch');
  if (value.resume_from_run_id !== undefined && (typeof value.resume_from_run_id !== 'string' || value.resume_from_run_id === value.run_id)) invalid('resume_from_run_id');
  if (!Number.isSafeInteger(value.contract_revision) || value.contract_revision < 0) invalid('contract_revision');
  for (const key of ['policy_revision', 'role_revision', 'harness_revision', 'model_revision']) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || mutable.test(value[key])) invalid(key);
  if (!Array.isArray(value.skill_revisions) || value.skill_revisions.some((s: unknown) => typeof s !== 'string' || !s)) invalid('skill_revisions');
  if(value.stage_policy_hash!==undefined&&!hex(64).test(value.stage_policy_hash))invalid('stage_policy_hash');
  if(value.stage!==undefined&&(!value.stage||Object.keys(value.stage).some(k=>!['stage_id','plan_revision','policy_hash'].includes(k))||typeof value.stage.stage_id!=='string'||!Number.isSafeInteger(value.stage.plan_revision)||value.stage.plan_revision<1||!hex(64).test(value.stage.policy_hash)))invalid('stage');
  validateBudget(value.budget);
  assertSecretFree(value);
  return value as RunContext;
}
// Secret-shaped keys and values. Budget fields such as max_total_tokens are counts, not credentials.
const secretKey = /^(?:api_?key|authorization|credentials?|password|private_key|secret|.*_secret|token|access_token|refresh_token|claim_token|cookie)$/i;
const secretValue = /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:sk-[\w-]{12,}|gh[pousr]_\w{15,}|rrt_[\w.-]{20,})|Bearer\s+[\w.\/-]{8,}|https?:\/\/[^\s\/@]+:[^\s\/@]+@/i;
/** Throws when a value carries a credential. RunContext, events and checkpoints pass through this before they persist. */
export function assertSecretFree(value: unknown, path = 'run_context', known: Iterable<string> = []): void {
  const values = [...known].filter(v => typeof v === 'string' && v.length >= 8);
  const walk = (v: unknown, at: string): void => {
    if (typeof v === 'string') { if (secretValue.test(v) || values.some(s => v.includes(s))) throw new TaskError('role_run_secret_rejected', 'failed', at); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (secretKey.test(k)) throw new TaskError('role_run_secret_rejected', 'failed', `${at}.${k}`); walk(x, `${at}.${k}`); }
  };
  walk(value, path);
}
export function validateEvent(value: any): RunEvent {
  if (!value || typeof value !== 'object') return invalid('event');
  if (typeof value.run_id !== 'string' || !Number.isSafeInteger(value.seq) || value.seq < 1 || !Number.isSafeInteger(value.lease_epoch) || value.lease_epoch < 1) invalid('event.sequence');
  if (!(eventTypes as readonly string[]).includes(value.type)) invalid('event.type');
  if (!(resultCategories as readonly string[]).includes(value.category)) invalid('event.category');
  if (value.operation_id !== null && (typeof value.operation_id !== 'string' || !/^[\w:.-]{1,160}$/.test(value.operation_id))) invalid('event.operation_id');
  if (typeof value.source_version !== 'string' || !value.source_version) invalid('event.source_version');
  if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data) || Buffer.byteLength(JSON.stringify(value.data)) > 64 * 1024) invalid('event.data');
  return value as RunEvent;
}
/** JSON hash, used for record and content hashes in references. */
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
