import type { Store, Row } from '../storage/database.js';
import type { RoleSnapshot } from './definition.js';
import { roleConfiguration, roleAuthority } from './definition.js';
import { stageAllows, validateStages, type StageDefinition } from './stage-policy.js';
import { assertLease, eventHistory, historyOrder } from './role-run.js';
import { contentHash, validateCandidateRef, type CandidateRef, type RunContext } from './protocol.js';
import { stop } from '../agent/common.js';
import { traceEvent } from '../tasks/trace.js';
import { legacyWorkflowRow, workVersion } from '../work/settings.js';
import { workOf } from '../work/catalog.js';

// Stage fingerprints ignore object key order without changing persisted backend session hashes.
function stageHash(value:unknown) {
  const canonical=(item:any):any=>Array.isArray(item)?item.map(canonical):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])):item;
  return contentHash(canonical(value));
}

export function stageStorage(s: Store) {
  s.db.exec(`
    CREATE TABLE IF NOT EXISTS task_stage_plans(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,contract_revision INTEGER NOT NULL,policy_hash TEXT NOT NULL,stages TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(task_id,revision));
    CREATE TABLE IF NOT EXISTS task_stage_assignments(assignment_id TEXT PRIMARY KEY REFERENCES role_assignments(id),
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,plan_revision INTEGER NOT NULL,stage_id TEXT NOT NULL,candidate_key TEXT NOT NULL,
      FOREIGN KEY(task_id,plan_revision) REFERENCES task_stage_plans(task_id,revision));
    CREATE TABLE IF NOT EXISTS task_stage_results(run_id TEXT PRIMARY KEY REFERENCES task_runs(id),assignment_id TEXT NOT NULL REFERENCES role_assignments(id),
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,plan_revision INTEGER NOT NULL,stage_id TEXT NOT NULL,
      candidate_key TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_stage_results_task ON task_stage_results(task_id,plan_revision,stage_id);
  `);
}
function facts(s: Store, taskId: string) {
  const task = s.get('SELECT * FROM tasks WHERE id=?', taskId), record = s.get('SELECT * FROM task_records WHERE task_id=?', taskId);
  if (!task || !record) throw new Error('task_not_found');
  const snapshot = s.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', taskId);
  const fixed = snapshot ? JSON.parse(snapshot.snapshot) : null;
  const config = roleConfiguration(s, task.repository_id, fixed?.roles);
  const live = roleConfiguration(s, task.repository_id);
  const policy = s.get('SELECT enabled,test_command FROM policies WHERE repository_id=?', task.repository_id);
  // Before #207 the gate hashed the task's workflow row; that row lives on in the migration archive, so older plans keep
  // their hash. A later change of the work type's settings or Manager section moves its version and invalidates results,
  // as editing the workflow did.
  const workflow = legacyWorkflowRow(s, task.repository_id, fixed?.workflow?.id ?? task.kind), version = workVersion(s, task.repository_id, workOf(task as any));
  // Only relevant gate policy changes invalidate results; changing a persona alone is handled by role revisions.
  const authority=(configuration:typeof live)=>configuration.roles.filter(role=>(configuration.required_stages??[]).some(stage=>stageAllows(stage,{...role,enabled:true}))).map(({role_id,enabled,permissions,environment_profile_ref,harness_ref})=>({role_id,enabled,permissions,environment_profile_ref,harness_ref}));
  const policyHash = stageHash({ stages: live.required_stages ?? [], authority:authority(live), test_command: policy?.test_command ?? '', workflow, ...(version ? { work: version } : {}) });
  return { task, record, config, live, policy, policyHash, authorityChanged:stageHash(authority(config))!==stageHash(authority(live)) };
}
export function candidateKey(candidate: CandidateRef | null) {
  if (!candidate) return 'source';
  const { ref, ...version } = validateCandidateRef(candidate);
  return stageHash(version);
}
export function latestRoleCandidate(s: Store, taskId: string): CandidateRef | null {
  const row = s.get(`SELECT h.data FROM role_run_events e JOIN task_runs r ON r.id=e.run_id JOIN task_history h ON ${eventHistory}
    WHERE e.task_id=? AND e.type='ended' AND e.category='completed' AND r.role='dev' AND r.revision=(SELECT revision FROM task_records WHERE task_id=e.task_id) ORDER BY ${historyOrder} DESC LIMIT 1`, taskId);
  return row ? JSON.parse(row.data).data.candidate_ref ?? null : null;
}
export function deliveryType(s: Store, taskId: string, candidate?: CandidateRef | null): 'code' | 'artifact' | 'no_changes' {
  const { task, record } = facts(s, taskId), contract = JSON.parse(record.contract);
  if (candidate?.kind === 'no_changes') return 'no_changes';
  return task.kind.startsWith('development.') || ['code','pull_request','pr'].includes(contract.endpoint) ? 'code' : 'artifact';
}
export function artifactCandidate(result:any,treeHash:string|null,revision:number,reference:string,taskKind=''):CandidateRef {
  // The review Publisher adds routing metadata and finding IDs after nomination; these are not report content.
  let body=result;
  if(taskKind.startsWith('review.')||taskKind.startsWith('workflow.')){const {reviewed_sha,coverage,object_hash,pull_request,...content}=result;
    body={...content,...(Array.isArray(content.findings)?{findings:content.findings.map(({id,...finding}:any)=>finding)}:{})};}
  return {kind:'artifact',ref:reference,revision:'contract:revision:'+revision,content_hash:contentHash({result:body,tree_hash:treeHash})};
}
export function deliveryCandidate(candidate: any,taskKind=''): CandidateRef | null {
  if (!candidate) return null;
  const unchanged=candidate.artifacts.find((a:any)=>a.content?.status==='no_changes');
  if(unchanged?.content?.source_ref)return {kind:'no_changes',ref:'candidate:'+candidate.id,source_ref:unchanged.content.source_ref,record_hash:contentHash({source_ref:unchanged.content.source_ref,tree_hash:unchanged.version})};
  const files = candidate.artifacts.find((a: any) => ['code','files'].includes(a.kind));
  const report = candidate.artifacts.find((a: any) => a.kind === 'report');
  if(report)return artifactCandidate(report.content,files?.version??null,candidate.revision,'candidate:'+candidate.id,taskKind);
  const commit = files?.content?.local_sha ?? files?.content?.sha;
  if (/^[a-f0-9]{40}$/.test(commit ?? '') && /^[a-f0-9]{40}$/.test(files?.version ?? '')) return {kind:'code',ref:'candidate:'+candidate.id,commit_sha:commit,tree_hash:files.version};
  return artifactCandidate(candidate.claims,null,candidate.revision,'candidate:'+candidate.id,taskKind);
}
const currentPlan = (s: Store, id: string) => s.get('SELECT * FROM task_stage_plans WHERE task_id=? ORDER BY revision DESC LIMIT 1', id);
function assertActive(s: Store, taskId: string) {
  const f = facts(s, taskId);
  if (['cancelled','superseded','paused'].includes(f.task.status)) stop('task_claim_revoked', f.task.status==='paused'?'paused':'cancelled',f.task.status);
  if (!f.policy?.enabled) stop('repository_policy_disabled','cancelled');
  if (!f.live.enabled) stop('role_authority_revoked','paused');
  if (f.authorityChanged || stageHash(f.config.required_stages ?? []) !== stageHash(f.live.required_stages ?? [])) stop('stage_policy_changed', 'paused', '阶段策略已变化，请在安全检查点采用新配置。');
  return f;
}
function stageDefinitions(value:unknown) {
  const display=new Set(['status','waiting_reason','waiting_for','attempts','assignments','results']);
  return Array.isArray(value)?value.map(stage=>stage&&typeof stage==='object'&&!Array.isArray(stage)?Object.fromEntries(Object.entries(stage).filter(([key])=>!display.has(key))):stage):value;
}
export function stageReplanContext(s:Store,taskId:string) {
  const plan=currentPlan(s,taskId);if(!plan)return undefined;
  const f=facts(s,taskId);return {plan_revision:plan.revision,contract_revision:f.record.revision,policy_hash:f.policyHash};
}
function explicitReplan(s:Store,taskId:string) {
  const context=stageReplanContext(s,taskId)!;
  // A previous human retry cannot authorize a later, unrelated policy or contract change.
  return !!s.get("SELECT 1 FROM task_history WHERE task_id=? AND type='intervention' AND actor LIKE 'user:%' AND json_extract(data,'$.action') IN ('retry','contract_revision','adopt-config') AND json_extract(data,'$.stage_plan.plan_revision')=? AND json_extract(data,'$.stage_plan.contract_revision')=? AND json_extract(data,'$.stage_plan.policy_hash')=? LIMIT 1",taskId,context.plan_revision,context.contract_revision,context.policy_hash);
}
/** Permanent stage waits use the existing manual pause, which the task engine never polls. */
export function assertStageWaits(s:Store,taskId:string,waiting:{stage_id:string;reason:string|null}[]) {
  const task=s.get('SELECT status FROM tasks WHERE id=?',taskId);
  if(task&&['paused','cancelled','superseded'].includes(task.status))stop('task_claim_revoked',task.status==='paused'?'paused':'cancelled',task.status);
  const hard=waiting.find(wait=>['stage_policy_changed','stage_plan_stale','stage_retry_exhausted','stage_budget_exhausted','project_disabled','role_coordination_disabled','task_inactive'].includes(wait.reason??''));
  if(!hard)return;
  if(hard.reason==='project_disabled')stop('repository_policy_disabled','cancelled');
  if(hard.reason==='role_coordination_disabled')stop('role_authority_revoked','paused');
  if(hard.reason==='task_inactive')stop('task_claim_revoked','cancelled');
  stop(hard.reason!,'paused',JSON.stringify(waiting));
}
/** Immutable plan revisions extend the task contract/configuration; this is never a queue. */
export function planTask(s: Store, taskId: string, expectedRevision: number, proposed?: unknown, expectedPlanRevision?: number) {
  return s.transaction(() => {
    const f = facts(s, taskId), previous = currentPlan(s, taskId);
    if (f.record.revision !== expectedRevision) throw new Error('task_revision_changed');
    if(proposed!==undefined&&(!Number.isSafeInteger(expectedPlanRevision)||Number(expectedPlanRevision)<0))throw new Error('stage_plan_revision_required');
    if (expectedPlanRevision !== undefined && Number(previous?.revision ?? 0) !== expectedPlanRevision) throw new Error('stage_plan_revision_changed');
    const configured = f.config.enabled ? f.config.required_stages ?? [] : [];
    if (!configured.length && proposed === undefined && !previous) {
      const gate=evaluateRequiredStages(s,taskId,latestRoleCandidate(s,taskId));
      if(gate.waiting.length)assertActive(s,taskId);
      assertStageWaits(s,taskId,gate.waiting);
      return null;
    }
    assertActive(s, taskId);
    if(previous&&(previous.contract_revision!==expectedRevision||previous.policy_hash!==f.policyHash)&&!explicitReplan(s,taskId))stop(previous.contract_revision!==expectedRevision?'stage_plan_stale':'stage_policy_changed','paused');
    if(proposed===undefined&&previous?.contract_revision===expectedRevision&&previous.policy_hash===f.policyHash)return previous;
    const stages = validateStages(stageDefinitions(proposed ?? configured), f.config.roles, 'stages');
    for (const required of configured.filter(stage => stage.required)) {
      if (stageHash(stages.find(stage => stage.stage_id === required.stage_id)) !== stageHash(required)) throw new Error('required_stage_immutable');
    }
    if (stages.some(stage => stage.required && !configured.some(c => c.required && c.stage_id === stage.stage_id))) throw new Error('stage_authority_invalid');
    if (previous?.contract_revision === expectedRevision && previous.policy_hash === f.policyHash && stageHash(JSON.parse(previous.stages)) === stageHash(stages)) return previous;
    if (s.get("SELECT 1 FROM task_runs WHERE task_id=? AND assignment_id IN (SELECT assignment_id FROM task_stage_assignments WHERE task_id=?) AND status='running'", taskId, taskId)) throw new Error('stage_plan_running');
    const revision = Number(previous?.revision ?? 0) + 1;
    s.run('INSERT INTO task_stage_plans VALUES(?,?,?,?,?,?)', taskId, revision, expectedRevision, f.policyHash, JSON.stringify(stages), new Date().toISOString());
    traceEvent(s, taskId, 'stage_plan', {revision,contract_revision:expectedRevision,policy_hash:f.policyHash,stages}, null, 'framework');
    return currentPlan(s, taskId)!;
  });
}
export function stageForAssignment(s: Store, assignment?: string): StageDefinition | null {
  if (!assignment) return null;
  const row = s.get('SELECT p.stages,a.stage_id FROM task_stage_assignments a JOIN task_stage_plans p ON p.task_id=a.task_id AND p.revision=a.plan_revision WHERE a.assignment_id=?', assignment);
  return row ? JSON.parse(row.stages).find((stage: StageDefinition) => stage.stage_id === row.stage_id) ?? null : null;
}
function currentResults(s: Store, taskId: string, plan: Row, candidate: CandidateRef | null) {
  return s.all('SELECT r.* FROM task_stage_results r JOIN task_stage_plans p ON p.task_id=r.task_id AND p.revision=r.plan_revision WHERE r.task_id=? AND p.contract_revision=? AND p.policy_hash=? AND r.candidate_key=? ORDER BY r.rowid', taskId, plan.contract_revision, plan.policy_hash, candidateKey(candidate)).map(row => JSON.parse(row.result)).filter(result=>JSON.parse(plan.stages).some((stage:StageDefinition)=>stage.stage_id===result.stage_id&&stageHash(stage)===result.definition_hash));
}
/** Rebuild runnable/waiting stages from durable assignments/runs, under the existing task claim. */
export function reconcileAssignments(s: Store, taskId: string, candidate = latestRoleCandidate(s, taskId)) {
  const f = facts(s, taskId), plan = currentPlan(s, taskId);
  const policyChanged=f.authorityChanged || stageHash(f.config.required_stages ?? []) !== stageHash(f.live.required_stages ?? []);
  if (!plan) return { task_id:taskId, task_status:f.task.status,task_waiting_reason:f.task.error_code??null, plan_revision:0, stages:[], next:[], waiting:policyChanged&&(f.live.required_stages??[]).some(stage=>stage.required&&stage.delivery_types.includes(deliveryType(s,taskId,candidate)))?[{stage_id:'policy',reason:'stage_policy_changed',dependencies:[]}]:[] };
  const results = currentResults(s, taskId, plan, candidate), applicable = (JSON.parse(plan.stages) as StageDefinition[]).filter(stage => stage.delivery_types.includes(deliveryType(s, taskId, candidate)));
  const latest=new Map(results.map((r:any)=>[r.stage_id,r]));
  const passed = new Set([...latest.values()].filter((r:any)=>r.passed).map((r:any)=>r.stage_id));
  const stages = applicable.map(stage => {
    const assignments = s.all('SELECT a.assignment_id,a.candidate_key,r.id run_id,r.status,r.lease_epoch,r.resume_from_run_id,r.started_at,r.ended_at FROM task_stage_assignments a LEFT JOIN task_runs r ON r.assignment_id=a.assignment_id WHERE a.task_id=? AND a.plan_revision=? AND a.stage_id=? ORDER BY r.rowid', taskId, plan.revision, stage.stage_id);
    const active = assignments.some(a => a.status === 'running');
    const attempts = stageRuns(s,taskId,plan,stage.stage_id).length;
    const deps = stage.depends_on.filter(id => !passed.has(id));
    const reason = ['cancelled','superseded','paused'].includes(f.task.status) ? 'task_inactive' : !f.policy?.enabled ? 'project_disabled' : !f.live.enabled ? 'role_coordination_disabled'
      : policyChanged || plan.policy_hash !== f.policyHash ? 'stage_policy_changed' : plan.contract_revision !== f.record.revision ? 'stage_plan_stale'
      : passed.has(stage.stage_id) ? null : active ? 'running' : deps.length ? 'dependencies' : attempts >= stage.retry.max_attempts ? 'stage_retry_exhausted' : stage.role_constraints.kinds.includes('observer') && !candidate ? 'candidate_required' : null;
    return {...stage,status:reason ? 'waiting' : passed.has(stage.stage_id) ? 'passed' : 'ready',waiting_reason:reason,waiting_for:deps,attempts,assignments,results:results.filter((r: any) => r.stage_id === stage.stage_id)};
  });
  return {task_id:taskId,task_status:f.task.status,task_waiting_reason:f.task.error_code??null,plan_revision:Number(plan.revision),contract_revision:plan.contract_revision,policy_hash:plan.policy_hash,candidate_ref:candidate,stages,next:stages.filter(stage => stage.status === 'ready').map(stage => stage.stage_id),waiting:stages.filter(stage => stage.waiting_reason).map(stage => ({stage_id:stage.stage_id,reason:stage.waiting_reason,dependencies:stage.waiting_for}))};
}
export function bindStageAssignment(s: Store, taskId: string, assignment: string, role: string, stageId?: string) {
  const plan = currentPlan(s, taskId);
  if (!plan) { if (stageId) throw new Error('stage_plan_required'); return; }
  const owner=s.get('SELECT a.task_id,i.role FROM role_assignments a JOIN role_instances i ON i.id=a.instance_id WHERE a.id=?',assignment);
  if(owner?.task_id!==taskId||owner.role!==role)throw new Error('stage_assignment_scope_mismatch');
  const f = assertActive(s, taskId), view = reconcileAssignments(s, taskId);
  const definition = f.config.roles.find(r => r.role_id === role);
  const choices = view.stages.filter(stage => definition && stageAllows(stage, definition));
  if (!stageId && !choices.length) return;
  const stage = stageId ? choices.find(stage => stage.stage_id === stageId) : choices.find(stage => stage.status === 'ready')??choices.find(stage=>stage.status==='passed'&&stage.role_constraints.kinds.includes('writer'))??choices.find(stage=>stage.waiting_reason==='stage_retry_exhausted');
  if(stage?.waiting_reason==='stage_retry_exhausted')stop('stage_retry_exhausted','paused');
  if (!stage || !['ready','passed'].includes(stage.status) || stage.status === 'passed' && !stage.role_constraints.kinds.includes('writer')) throw new Error('stage_not_runnable');
  if (stage.attempts >= stage.retry.max_attempts) stop('stage_retry_exhausted', 'paused');
  const old = s.get('SELECT * FROM task_stage_assignments WHERE assignment_id=?', assignment);
  if (old && (old.plan_revision !== plan.revision || old.stage_id !== stage.stage_id || definition?.kind==='observer'&&old.candidate_key !== candidateKey(latestRoleCandidate(s, taskId)))) throw new Error('stage_assignment_stale');
  s.run('INSERT OR IGNORE INTO task_stage_assignments VALUES(?,?,?,?,?)', assignment, taskId, plan.revision, stage.stage_id, candidateKey(latestRoleCandidate(s, taskId)));
}
/** Both run starts and every tool boundary check the stage fence. Epoch allocation stays in RoleRun's scheduler. */
export function assertStageRun(s: Store, taskId: string, assignment: string | undefined, kind: string) {
  const stage = stageForAssignment(s, assignment);
  if (!stage) return;
  const f = assertActive(s, taskId), plan = currentPlan(s, taskId), row = s.get('SELECT * FROM task_stage_assignments WHERE assignment_id=?', assignment!);
  if (!plan || row?.plan_revision !== plan.revision || plan.contract_revision !== f.record.revision || plan.policy_hash !== f.policyHash) stop('stage_plan_stale', 'paused');
  if (kind === 'observer' && row!.candidate_key !== candidateKey(latestRoleCandidate(s, taskId))) stop('candidate_changed','retry_wait');
}
export function stageBudgetUsage(s: Store, assignment?: string) {
  const stage = stageForAssignment(s, assignment); if (!stage) return null;
  const binding = s.get('SELECT * FROM task_stage_assignments WHERE assignment_id=?', assignment!);
  const plan=currentPlan(s,binding!.task_id)!;
  const runs = stageRuns(s,binding!.task_id,plan,stage.stage_id);
  const wall = runs.reduce((sum, r) => sum + Math.max(0,(r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.started_at)),0);
  const tools = runs.reduce((sum, r) => sum + Number(s.get("SELECT count(*) n FROM role_run_events WHERE run_id=? AND type='tool_call'", r.id)!.n),0);
  return {wall_ms:wall,tool_calls:tools,remaining_wall_ms:stage.budget.max_wall_seconds?Math.max(0,stage.budget.max_wall_seconds*1000-wall):null,exceeded:stage.budget.max_wall_seconds && wall >= stage.budget.max_wall_seconds * 1000 ? 'max_wall_seconds' : stage.budget.max_tool_calls && tools > stage.budget.max_tool_calls ? 'max_tool_calls' : null};
}
export const stageBudgetExceeded=(s:Store,assignment?:string)=>stageBudgetUsage(s,assignment)?.exceeded??null;
function stageRuns(s:Store,taskId:string,plan:Row,stageId:string) {
  // A run refused at admission (the role was at its concurrency limit) has a task_runs row but never started: counting it
  // would spend a stage attempt and stage wall time on a wait. `stop_reason` is what distinguishes it — `status` alone
  // cannot — and `IS NOT` keeps the comparison null-safe, so a stopped row with no reason still counts.
  return s.all('SELECT r.id,r.started_at,r.ended_at FROM task_runs r JOIN task_stage_assignments a ON a.assignment_id=r.assignment_id JOIN task_stage_plans p ON p.task_id=a.task_id AND p.revision=a.plan_revision WHERE a.task_id=? AND p.contract_revision=? AND p.policy_hash=? AND a.stage_id=? AND r.stop_reason IS NOT \'role_capacity\'',taskId,plan.contract_revision,plan.policy_hash,stageId);
}
export function assertStageStart(s:Store,taskId:string,assignment:string|undefined,kind:string) {
  assertStageRun(s,taskId,assignment,kind);
  const stage=stageForAssignment(s,assignment);if(!stage)return;
  const plan=currentPlan(s,taskId)!;
  if(stageRuns(s,taskId,plan,stage.stage_id).length>=stage.retry.max_attempts)stop('stage_retry_exhausted','paused');
}
export function stagePolicyHash(s:Store,taskId:string) {const f=facts(s,taskId);return f.config.enabled&&f.config.required_stages?.length?f.policyHash:undefined;}
export function stageRunBinding(s:Store,assignment?:string) {
  if(!assignment)return undefined;
  const row=s.get('SELECT a.stage_id,a.plan_revision,p.policy_hash FROM task_stage_assignments a JOIN task_stage_plans p ON p.task_id=a.task_id AND p.revision=a.plan_revision WHERE a.assignment_id=?',assignment);
  return row?{stage_id:String(row.stage_id),plan_revision:Number(row.plan_revision),policy_hash:String(row.policy_hash)}:undefined;
}
export function stageTimeline(s:Store,taskId:string) {
  return {...reconcileAssignments(s,taskId),plans:s.all('SELECT revision,contract_revision,policy_hash,stages,created_at FROM task_stage_plans WHERE task_id=? ORDER BY revision DESC LIMIT 20',taskId).map(row=>({...row,stages:JSON.parse(row.stages)})),history:s.all('SELECT result,created_at FROM task_stage_results WHERE task_id=? ORDER BY rowid DESC LIMIT 100',taskId).map(row=>({...JSON.parse(row.result),created_at:row.created_at}))};
}
export function assertPublicationStages(s:Store,taskId:string) {
  const row=s.get('SELECT candidate,pending,acceptance FROM task_records WHERE task_id=?',taskId);
  const decision=JSON.parse(row?.pending??row?.acceptance??'null');
  if(row?.candidate&&['pass','pass_with_issues'].includes(decision?.outcome))assertStageAcceptance(s,taskId,JSON.parse(row.candidate),decision);
}
/** Only the framework calls this after validated collect. Model text cannot supply a passing bit or versions. */
export function recordStageResult(s: Store, assignment: string, runId: string, epoch: number, refs: {result_ref:string;candidate_ref:CandidateRef}) {
  return s.transaction(() => {
    const binding = s.get('SELECT * FROM task_stage_assignments WHERE assignment_id=?', assignment);
    if (!binding) return null;
    assertLease(s,runId,epoch);
    const run = s.get('SELECT * FROM task_runs WHERE id=? AND assignment_id=? AND task_id=?',runId,assignment,binding.task_id);
    const owner=s.get('SELECT task_id,instance_id FROM role_assignments WHERE id=?',assignment);
    if (!run?.run_context || run.status !== 'succeeded'||owner?.task_id!==binding.task_id||owner?.instance_id!==run.role_instance_id) throw new Error('stage_run_mismatch');
    if(run.lease_epoch!==epoch)stop('lease_epoch_stale','cancelled');
    const ctx = JSON.parse(run.run_context) as RunContext, snapshotRow = s.get('SELECT snapshot FROM role_snapshots WHERE id=?',run.role_snapshot);
    if (!snapshotRow) throw new Error('stage_snapshot_required');
    const snapshot = JSON.parse(snapshotRow.snapshot) as RoleSnapshot;
    assertStageRun(s,binding.task_id,assignment,snapshot.kind);
    if (roleAuthority(s,ctx.project_id,snapshot)) stop('role_authority_revoked','waiting_configuration');
    const stage = stageForAssignment(s,assignment)!, definition = facts(s,binding.task_id).config.roles.find(role => role.role_id === run.role);
    const resultRow = s.get("SELECT data FROM task_history WHERE task_id=? AND run_id=? AND type='role_result' AND 'task_history:'||id=?",binding.task_id,runId,refs.result_ref);
    if (!resultRow || !definition || !stageAllows(stage,definition) || ctx.contract_revision !== facts(s,binding.task_id).record.revision) throw new Error('stage_result_mismatch');
    const admission = JSON.parse(run.admission ?? '{}');
    if (!admission.admitted || stage.role_constraints.capabilities.some(cap => !admission.provided?.[cap]?.ok)) stop('unsupported_capability','waiting_configuration');
    if (stage.role_constraints.independent && (snapshot.kind !== 'observer' || snapshot.capability.tools === null || snapshot.capability.tools.includes('write_file') || !admission.provided.fresh_context?.ok)) throw new Error('stage_independence_required');
    const collected=s.get("SELECT h.data FROM role_run_events e JOIN task_history h ON 'task_history:'||h.id=e.history_ref WHERE e.run_id=? AND e.type='ended' AND e.category='completed'",runId);
    const output=collected?JSON.parse(collected.data).data:null;
    if(!output||output.result_ref!==refs.result_ref||candidateKey(output.candidate_ref)!==candidateKey(refs.candidate_ref))throw new Error('stage_result_conflict');
    const candidate = snapshot.kind === 'writer' ? refs.candidate_ref : ctx.candidate_ref;
    if (!candidate || snapshot.kind === 'observer' && candidateKey(candidate) !== binding.candidate_key) throw new Error('stage_candidate_mismatch');
    const raw = JSON.parse(resultRow.data).result;
    const evidence = s.all(`SELECT id,type,data FROM task_history WHERE task_id=? AND run_id=? AND type IN (${stage.completion.evidence_types.map(() => '?').join(',')}) ORDER BY id`,binding.task_id,runId,...stage.completion.evidence_types).filter(row=>{const data=JSON.parse(row.data),snapshot=row.type==='tool_observation'?data.observation:data.result;
      if(snapshot?.schema_version===1&&!snapshot.complete)return false;
      const observation=snapshot?.schema_version===1?snapshot.data:snapshot;
      return (!stage.completion.tools||stage.completion.tools.includes(data.name))&&observation&&typeof observation==='object'&&!observation.error&&!observation.isError&&!observation.timed_out&&!observation.truncated&&(observation.exit_code===undefined||observation.exit_code===0);
    }).map(r => ({ref:'task_history:'+r.id,type:r.type}));
    const passed = evidence.length >= stage.completion.min_evidence && (!stage.completion.no_findings || Array.isArray(raw.findings) && raw.findings.length === 0 && Array.isArray(raw.unknowns) && raw.unknowns.length === 0) && !stageBudgetExceeded(s,assignment);
    const result = {task_id:binding.task_id,plan_revision:binding.plan_revision,stage_id:stage.stage_id,definition_hash:stageHash(stage),contract_revision:ctx.contract_revision,candidate_ref:candidate,policy_hash:currentPlan(s,binding.task_id)!.policy_hash,
      policy_revision:ctx.policy_revision,workflow_revision:{id:snapshot.model.workflow,hash:currentPlan(s,binding.task_id)!.policy_hash},role_revision:ctx.role_revision,harness_revision:ctx.harness_revision,skill_revisions:ctx.skill_revisions,model_revision:ctx.model_revision,snapshot_ref:ctx.configuration_snapshot_ref,role_instance_id:run.role_instance_id,assignment_id:assignment,run_id:runId,lease_epoch:epoch,result_ref:refs.result_ref,evidence,passed,reason:passed?null:evidence.length < stage.completion.min_evidence?'insufficient_evidence':'findings_or_budget'};
    const existing = s.get('SELECT result FROM task_stage_results WHERE run_id=?',runId);
    if (existing) { if (stageHash(JSON.parse(existing.result)) !== stageHash(result)) throw new Error('stage_result_conflict'); return JSON.parse(existing.result); }
    s.run('INSERT INTO task_stage_results VALUES(?,?,?,?,?,?,?,?)',runId,assignment,binding.task_id,binding.plan_revision,stage.stage_id,candidateKey(candidate),JSON.stringify(result),new Date().toISOString());
    traceEvent(s,binding.task_id,'stage_result',result,runId,'framework',evidence.map(e => e.ref));
    return result;
  });
}
export function evaluateRequiredStages(s: Store, taskId: string, candidate: CandidateRef | null) {
  const f = facts(s,taskId), required = f.config.enabled ? (f.config.required_stages ?? []).filter(stage => stage.required && stage.delivery_types.includes(deliveryType(s,taskId,candidate))) : [];
  if (!required.length) {
    const changed=f.config.enabled&&(f.live.required_stages??[]).some(stage=>stage.required&&stage.delivery_types.includes(deliveryType(s,taskId,candidate)))&&stageHash(f.config.required_stages??[])!==stageHash(f.live.required_stages??[]);
    return {satisfied:!changed,waiting:changed?[{stage_id:'policy',reason:'stage_policy_changed'}]:[]};
  }
  const view = reconcileAssignments(s,taskId,candidate);
  const waiting = required.filter(stage => !view.stages.some(s => s.stage_id === stage.stage_id && s.status === 'passed')).map(stage => ({stage_id:stage.stage_id,reason:view.stages.find(s => s.stage_id === stage.stage_id)?.waiting_reason ?? 'stage_result_required'}));
  return {satisfied:waiting.length === 0,waiting};
}
export function assertRequiredStages(s: Store, taskId: string, candidate: CandidateRef | null) {
  const evaluation = evaluateRequiredStages(s,taskId,candidate);
  if (!evaluation.satisfied) {
    assertStageWaits(s,taskId,evaluation.waiting);
    stop('required_stages_incomplete','waiting_configuration',JSON.stringify(evaluation.waiting));
  }
}
/** Configured stages supplement fresh QA; even a complete stage plan cannot sign its own acceptance. */
export function assertStageAcceptance(s: Store, taskId: string, candidate: any, verdict: any) {
  const f=facts(s,taskId);
  assertRequiredStages(s,taskId,deliveryCandidate(candidate,f.task.kind));
  if (!(f.config.enabled && f.config.required_stages?.some(stage=>stage.required && stage.delivery_types.includes(deliveryType(s,taskId,deliveryCandidate(candidate,f.task.kind)))))) return;
  const fields=['outcome','reason','gaps','residuals','core_complete','required_evidence_complete','acceptable_risk'];
  const runs=s.all(`SELECT r.run_context,r.admission,h.data FROM task_runs r JOIN task_history h ON h.run_id=r.id
    WHERE r.task_id=? AND r.role='qa' AND r.status='succeeded' AND h.type='role_result' ORDER BY h.id DESC`,taskId);
  const valid=runs.some(run=>{const ctx=JSON.parse(run.run_context??'{}'),admission=JSON.parse(run.admission??'{}'),result=JSON.parse(run.data).result;
    return ctx.stage_policy_hash===f.policyHash && ctx.contract_revision===f.record.revision && ctx.candidate_ref?.ref==='candidate:'+candidate.id && admission.admitted && admission.provided?.fresh_context?.ok && fields.every(key=>stageHash(result[key])===stageHash(verdict[key]));});
  if(!valid)stop('acceptance_required','retry_wait','必需阶段齐备仍须由 fresh QA 验收当前候选。');
}
