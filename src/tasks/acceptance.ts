import { commandTool, resolveCommandTimeout, runCommand } from '../agent/command.js';
import { taskTraceAccess } from '../memory/access.js';
import { runRole, roleExecutionModel } from '../roles/run.js';
import { roleBackendWorkspace } from '../roles/workspace.js';
import { memoryTools, memoryTool } from '../memory/project.js';
import { beginRun, endRun } from './trace.js';
import { relatedDeliveryIndex, relatedDeliveries, relatedArtifactTool, readRelatedArtifact } from './related.js';
import { readEvidence, previousVerificationEvidence, boundedCandidate } from './evidence.js';
import { genericTask, softwareRequest } from './pull-request.js';
import type { Store, Row } from '../storage/database.js';
import { Workspace } from '../agent/workspace.js';
import { Redactor, stop } from '../agent/common.js';
import { TaskRecords, validateVerdict, type Verdict } from './service.js';
import { randomId } from '../core/security.js';

export { acceptanceInstructions as acceptanceSystem } from '../roles/pool.js';
import { acceptanceInstructions as acceptanceSystem } from '../roles/pool.js';
import { acceptanceParticipation } from '../roles/participation.js';

const tool = (name: string, description: string, properties: any, required: string[]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

/** Issue execution keeps its file index under context; managed requests also use a top-level file map. */
export function acceptanceContextFiles(...inputs: any[]): string[] {
  const paths: string[] = [];
  for (const input of inputs) {
    for (const index of [input?.context_files, input?.context?.context_files]) {
      const names = Array.isArray(index)
        ? index.map(file => (typeof file === 'string' ? file : file?.path))
        : index && typeof index === 'object'
          ? Object.keys(index)
          : [];
      for (const name of names) if (typeof name === 'string' && name) paths.push(name.startsWith('../context/') ? name : '../context/' + name);
    }
  }
  return [...new Set(paths)];
}

export const acceptanceRequirements = (completeness?: string) =>
  completeness === 'explicit'
    ? 'The explicit contract defines this delivery. Use the listed original sources when needed to check its referenced requirements.'
    : 'This contract is a condensed summary, not the complete original requirements. Read the original request in context_files (object.json contains the full Issue/PR body) if needed to check whether the delivery addresses the user request.';

const hasExternalTaskWrite = (store: Store, taskId: string): boolean =>
  Boolean(
    store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending' LIMIT 1", taskId) ||
      store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='execution_evidence' AND json_extract(data,'$.name') IN ('post_review','github_write') LIMIT 1", taskId),
  );

/**
 * Tiered QA gate (#1121):
 * - Skips QA (`false`) for pure Q&A / internal status reports (`task.request` generic `submit_report` with no GitHub writes),
 *   internal `release.observe`, label/comment-only `workflow.*` tasks, and `actions.failures` runs that neither edit code nor file an Issue.
 * - Runs Lightweight Gatekeeper QA (`true`) before opening/updating a PR, publishing a formal PR/Issue review, filing an Issue,
 *   or publishing an external diagnostic/release report.
 */
export function shouldRunQa(store: Store, task: Row, candidate?: any): boolean {
  const kind = String(task.kind ?? '');
  const hasCode = Boolean(candidate?.artifacts?.some((a: any) => a?.kind === 'code' && !(a.content as any)?.no_changes));
  if (hasCode) return true;
  if (kind === 'release.observe') return false;
  if (kind.startsWith('workflow.')) return false;
  if (kind === 'actions.failures') {
    const report = candidate?.artifacts?.find((a: any) => a?.kind === 'report')?.content as any;
    const filesIssue = Boolean(report?.action === 'file_issue' || report?.report_issue || report?.issue || hasExternalTaskWrite(store, String(task.id)));
    return filesIssue;
  }
  if (genericTask(task) && !softwareRequest(task)) {
    const report = candidate?.artifacts?.find((a: any) => a?.kind === 'report')?.content as any;
    if (report?.delivery === 'review') return true;
    const isTestDiagnosis = (() => { try { return JSON.parse(String(task.input || '{}')).executor_role === 'test'; } catch { return false; } })();
    if (isTestDiagnosis) return hasExternalTaskWrite(store, String(task.id));
    const hasFileDeliverable = Array.isArray(report?.artifacts) && report.artifacts.length > 0;
    return hasFileDeliverable || hasExternalTaskWrite(store, String(task.id));
  }
  return true;
}

export function skipQa(store: Store, task: Row, candidate: any, method = 'qa_not_required'): Verdict {
  const verdict = validateVerdict({ pass: true, issues: [], reason: '纯问答或内部状态交付，无需触发守门员 QA。' });
  new TaskRecords(store).history(task.id, 'acceptance_evaluated', {
    evaluation_id: 'skip:' + candidate.id,
    candidate_id: candidate.id,
    elapsed_ms: 0,
    verdict,
    method,
  });
  return verdict;
}

const dirtyPathPattern = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|\.DS_Store|node_modules|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:\/|$)/i;
const binaryPathPattern = /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|wav|ogg|wasm|so|dylib|dll|exe|bin|class|jar|pyc|pyo|sqlite3?|db|har|hap|hsp)$/i;
const preflightMaxBytes = 262144;
const conflictMarker = (text: string) => /^(?:<<<<<<< |>>>>>>> )/m.test(text) && /^=======\r?$/m.test(text);
const privateKeyBlock = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

export async function deterministicCandidateIssues(store: Store, _task: Row, workspace: Workspace, candidate: any, redactor: Redactor): Promise<string[]> {
  const issues: string[] = [];
  const serializedClaims = JSON.stringify(candidate.claims ?? '');
  if (redactor.contains(Buffer.from(serializedClaims))) {
    issues.push('Delivery summary or metadata contains a raw registered credential; remove secrets before publishing.');
  }
  for (const artifact of candidate.artifacts ?? []) {
    if (artifact.kind === 'report' && artifact.content) {
      const text = typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content);
      if (conflictMarker(text)) issues.push('Delivered report contains unresolved Git conflict markers (<<<<<<< / ======= / >>>>>>>).');
      if (redactor.contains(Buffer.from(text))) issues.push('Delivered report contains a raw registered credential.');
    }
    if (artifact.kind === 'code' && artifact.content && !(artifact.content as any).no_changes) {
      const content = artifact.content as any;
      const baseline = new Map<string, string>();
      for (const entry of Array.isArray(content.snapshot_files) ? content.snapshot_files : []) {
        if (entry?.path && entry?.sha) baseline.set(String(entry.path), String(entry.sha));
      }
      const changed = (Array.isArray(content.files) ? content.files : []).filter((f: any) => f?.path && baseline.get(String(f.path)) !== f.sha);
      for (const file of changed) {
        const filePath = String(file.path);
        if (dirtyPathPattern.test(filePath)) {
          issues.push(`Forbidden or dirty file staged in candidate: ${filePath} (remove .env, private keys, .DS_Store, or node_modules).`);
          continue;
        }
        if (binaryPathPattern.test(filePath)) continue;
        if (typeof file.size === 'number' && file.size > preflightMaxBytes) continue;
        let text: string | null = null;
        if (typeof file.base64 === 'string') {
          if (Math.floor(file.base64.length * 3 / 4) > preflightMaxBytes) continue;
          const bytes = Buffer.from(file.base64, 'base64');
          if (bytes.length > preflightMaxBytes || bytes.subarray(0, 8192).includes(0)) continue;
          text = bytes.toString('utf8');
        } else if (typeof workspace?.call === 'function') {
          const read = await workspace.call(`accept:preflight:${randomId()}`, {
            type: 'workspace_read',
            path: filePath,
            max_bytes: preflightMaxBytes,
            skip_binary: true,
            ...(content.local_sha ? { sha: content.local_sha } : {}),
          }).catch(() => null);
          if (read?.skipped) continue;
          if (typeof read?.content === 'string') text = read.content;
        }
        if (text === null) continue;
        if (conflictMarker(text)) issues.push(`Unresolved Git merge conflict markers found in ${filePath}.`);
        if (redactor.contains(Buffer.from(text))) issues.push(`Registered secret/credential leaked in ${filePath}.`);
        else if (!/^test\/|\.test\.|\.spec\./.test(filePath) && privateKeyBlock.test(text)) issues.push(`Private key block found in ${filePath}.`);
      }
    }
  }
  void store;
  return [...new Set(issues)];
}

const gatekeeperChecklist = [
  '1. Missing tests: Did a code behavior change or bug fix unintentionally omit or skip regression tests?',
  '2. Obvious mistakes: Did the candidate modify the wrong target, leave obvious syntax/logic/debug errors, or fail to answer the requested goal?',
  '3. Data safety: Does the diff, review or report leak credentials, tokens or private internal paths/data?',
];

export async function evaluateDelivery(store: Store, task: Row, workspace: Workspace, redactor: Redactor, guard: () => Promise<void>, shell = true): Promise<Verdict> {
  return evaluateCandidate(store, task, workspace, redactor, guard, shell);
}

async function evaluateCandidate(store: Store, task: Row, workspace: Workspace, redactor: Redactor, guard: () => Promise<void>, shell = true): Promise<Verdict> {
  const records = new TaskRecords(store), record = records.get(task.id), candidate = record.candidate;
  if (!candidate) throw new Error('acceptance_candidate_required');
  const related = relatedDeliveries(store, task), relatedIndex = relatedDeliveryIndex(related);
  const parentContext = related.find(r => r.description.relationship === 'parent');
  const contextFiles = acceptanceContextFiles(JSON.parse(task.input || '{}'), parentContext ? JSON.parse(parentContext.row.input || '{}') : null);
  if (parentContext) contextFiles.push('../context/parent-delivery.json', '../context/related-deliveries.json');
  const tools = [
    tool('read_evidence', 'Read a paginated original observation by offered source or task_history:<id> belonging to this task', { source: { type: 'string' }, offset: { type: 'integer' }, length: { type: 'integer' } }, ['source']),
    tool('read_task_history', 'Read this task’s most recent factual observations and checkpoints', { offset: { type: 'integer' }, limit: { type: 'integer' } }, []),
    tool('read_file', 'Read artifact or repository text in the shared task workspace', { path: { type: 'string' } }, ['path']),
  ];
  if (related.length) tools.push(relatedArtifactTool);
  tools.push(...memoryTools.filter(t => t.function.name !== 'remember_project_memory'));
  if (shell) {
    const cmdBudget = resolveCommandTimeout(store, task, 'qa', 120);
    tools.push(commandTool(cmdBudget.defaultSeconds, 'Run spot-check verification in the shared task workspace; do not modify source.', cmdBudget.maxSeconds));
  }
  const validateDecision = (value: any): Verdict => {
    if (value?.outcome === 'evaluation_incomplete') {
      return stop('acceptance_budget_exhausted', 'retry_wait', '验收未形成判断，候选和原始观察已保留：' + redactor.text(String(value.reason || 'verification budget exhausted')).slice(0, 2000));
    }
    try { return validateVerdict(redactor.clean(value)); }
    catch (error) { return stop('acceptance_output_invalid', 'retry_wait', String((error as Error).message)); }
  };
  tools.push({
    type: 'function',
    function: {
      name: 'submit_acceptance',
      description: 'Submit the lightweight gatekeeper QA decision in 1-3 turns. Pass `{ pass: true, issues: [] }` when clean, or `{ pass: false, issues: ["concrete issue ..."] }` to return the candidate to the original role for in-place repair.',
      parameters: {
        type: 'object',
        properties: {
          pass: { type: 'boolean', description: 'True when the candidate passes the 3-item gatekeeper checklist; false when concrete issues require repair.' },
          issues: { type: 'array', items: { type: 'string' }, description: 'Empty array when pass is true; non-empty list of concrete blocking issues when pass is false.' },
        },
        required: [],
        additionalProperties: true,
      },
    },
  });

  const evaluationId = randomId(), start = Date.now();
  const files = candidate.artifacts.find(a => a.kind === 'files' || a.kind === 'code');
  let snapshot = files?.content as any, sourceTree = files?.version;
  const previousRun = task.trace_run_id;
  const verificationRun = beginRun(store, task, 'verification', { evaluation_id: evaluationId, role: 'qa', prompt_source: 'configured_role', shell, source_tree: sourceTree });
  task.trace_run_id = verificationRun?.id;
  let verificationOutcome: string | undefined, verificationFault: string | undefined;
  const verification = workspace;
  try {
    const sourceInput = JSON.parse(task.input || '{}');
    if (!snapshot?.local_sha && task.workspace_id && sourceInput.snapshot_tree) {
      const source = await workspace.call(`accept:${evaluationId}:source`, { type: 'workspace_source', tree_sha: sourceInput.snapshot_tree });
      if (source.error) return stop('acceptance_snapshot_unavailable', 'waiting_environment', '无法确认检视报告所依据的原始源码快照。');
      snapshot = source;
      sourceTree = source.tree_sha;
    }
    const worktreeId = store.hasTable('worktree_bindings') && workspace.task?.workspace_id
      ? store.get('SELECT worktree_id FROM worktree_bindings WHERE task_id=? AND workspace_id=? AND released_at IS NULL', task.id, workspace.task.workspace_id)?.worktree_id ?? null
      : null;
    records.history(task.id, 'acceptance_started', {
      evaluation_id: evaluationId,
      candidate_id: candidate.id,
      revision: record.revision,
      context: 'fresh',
      source_tree: sourceTree || null,
      verification_workspace: verification.task?.workspace_id || null,
      ...(worktreeId ? { verification_worktree: worktreeId } : {}),
    });

    // Step 1a: Deterministic test_command check (0 tokens).
    const required = candidate.artifacts.some(a => a.kind === 'code' && !(a.content as any)?.no_changes)
      ? String(store.get('SELECT test_command FROM policies WHERE repository_id=?', task.repository_id)?.test_command || '').trim()
      : '';
    const proof = candidate.evidence.some(
      e =>
        e.source === 'policy_validation' &&
        candidate.artifacts.some(a => a.kind === 'code' && (a.version === e.version || (a.content as any)?.tree_sha === e.version)) &&
        e.verified &&
        (e.result as any)?.command === required &&
        (e.result as any)?.exit_code === 0 &&
        !(e.result as any)?.timed_out,
    );
    let additionalVerification: any = null;
    if (required && !proof) {
      // The command runs in the shared task workspace, so it certifies the candidate only while the workspace still holds the
      // candidate's tree (#1121 review): another role or a resumed run may have changed it since the submission. A runner
      // without the tree operation leaves it unknown, and the result is recorded as before.
      const expected = String((snapshot as any)?.tree_sha || sourceTree || '');
      const live = await verification.call(`accept:${evaluationId}:tree`, { type: 'workspace_tree' }).catch(() => null);
      const tested = typeof live?.tree_sha === 'string' && /^[0-9a-f]{40,64}$/.test(live.tree_sha) ? live.tree_sha : null;
      if (expected && tested && tested !== expected) {
        const gap = `The shared task workspace changed after this candidate was submitted (candidate tree ${expected.slice(0, 12)}, workspace tree ${tested.slice(0, 12)}), so the project check \`${required}\` cannot certify it. Submit the delivery again from the current workspace, or restore the candidate's files first.`;
        records.history(task.id, 'acceptance_evidence', { evaluation_id: evaluationId, name: 'policy_validation', version: tested, candidate_version: expected, command: required, skipped: 'workspace_changed' });
        const verdict: Verdict = { pass: false, issues: [gap], outcome: 'return', reason: 'The workspace no longer holds the submitted candidate', gaps: [gap], residuals: [], core_complete: false, required_evidence_complete: false, acceptable_risk: true };
        records.history(task.id, 'acceptance_evaluated', { evaluation_id: evaluationId, candidate_id: candidate.id, elapsed_ms: Date.now() - start, verdict, method: 'deterministic_policy' }, verificationRun?.id);
        verificationOutcome = verdict.outcome;
        return verdict;
      }
      additionalVerification = await verification.call(`accept:${evaluationId}:policy`, { type: 'workspace_command', command: required, timeout_ms: null });
      records.history(task.id, 'acceptance_evidence', { evaluation_id: evaluationId, name: 'policy_validation', version: tested ?? sourceTree, tested_tree: tested, command: required, result: additionalVerification });
      if (additionalVerification.error || additionalVerification.exit_code !== 0 || additionalVerification.timed_out) {
        const failure = required + '; ' + String(additionalVerification.output || additionalVerification.error || 'verification incomplete').slice(-4000);
        const verdict: Verdict = { pass: false, issues: [failure], outcome: 'return', reason: 'Required project verification failed for the submitted candidate', gaps: [failure], residuals: [], core_complete: false, required_evidence_complete: false, acceptable_risk: true };
        records.history(task.id, 'acceptance_evaluated', { evaluation_id: evaluationId, candidate_id: candidate.id, elapsed_ms: Date.now() - start, verdict, method: 'deterministic_policy' }, verificationRun?.id);
        verificationOutcome = verdict.outcome;
        return verdict;
      }
    }

    // Step 1b: Deterministic dirty-file, conflict-marker and secret-leak scan (0 tokens).
    const preflightIssues = await deterministicCandidateIssues(store, task, verification, candidate, redactor);
    if (preflightIssues.length) {
      const verdict = validateVerdict({ pass: false, issues: preflightIssues });
      records.history(task.id, 'acceptance_evaluated', { evaluation_id: evaluationId, candidate_id: candidate.id, elapsed_ms: Date.now() - start, verdict, method: 'deterministic_preflight' }, verificationRun?.id);
      verificationOutcome = verdict.outcome;
      return verdict;
    }

    // Step 2: 1-3 turn minimal checklist model review in the shared task workspace.
    const model = roleExecutionModel(store, task, 'qa');
    const { result: verdict } = await runRole(
      {
        store,
        task,
        redactor,
        guard,
        model,
        system: acceptanceSystem,
        prompt: JSON.stringify({
          checklist: gatekeeperChecklist,
          contract: record.contract,
          requirements_instruction: acceptanceRequirements(record.contract.completeness),
          scope_differences: record.scope_differences.map(d => ({ ...d, version_matches_candidate: candidate.artifacts.some(a => a.version === d.source_version) })),
          revision: record.revision,
          project: record.project,
          candidate: boundedCandidate(candidate),
          previous_verification_evidence: previousVerificationEvidence(store, task.id, candidate),
          // Who produced results for this candidate (#1250): the facts the Manager nominated with, not a checklist item.
          candidate_participation: acceptanceParticipation(store, task.id),
          related_deliveries: relatedIndex.deliveries,
          related_deliveries_page: { ...relatedIndex, deliveries: undefined },
          context_files: [...new Set(contextFiles)],
          additional_verification: additionalVerification ? { ...additionalVerification, output: String(additionalVerification.output || '').slice(-8000) } : undefined,
          previous_acceptance: record.pending || record.acceptance,
          delivery_boundary: files?.kind === 'code' ? { stage: 'pre_publication', remaining: 'Framework creates or updates the PR after acceptance; judge candidate readiness, do not require an unpublished URL.' } : undefined,
          policy: { test_command: candidate.artifacts.some(a => a.kind === 'code') ? store.get('SELECT test_command FROM policies WHERE repository_id=?', task.repository_id)?.test_command || null : null },
          workspace: 'Shared task workspace: candidate files, installed dependencies and build caches are available in place.',
        }),
        tools,
        requestPrefix: `acceptance:${evaluationId}:`,
        // Up to 3 inspection turns + submit_acceptance (+ 2 finalization reserve turns on native/process/pi).
        maxTurns: 6,
        harnessTurnLimit: 5,
        maxOutputChars: 16000,
        finish: {
          name: 'submit_acceptance',
          validate: validateDecision,
          finalizationMessage: 'Spot-check budget reached. Call submit_acceptance({ pass, issues }) now using the inspected candidate and evidence.',
        },
        finalizationTools: ['submit_acceptance'],
        execute: async (name, args) => {
          if (['search_project_memory', 'read_project_memory'].includes(name)) {
            return memoryTool(store, { ...task, active_role: 'qa', head_sha: snapshot?.local_sha || task.head_sha }, name, redactor.clean(args), verification);
          }
          const result =
            name === 'read_related_artifact'
              ? await readRelatedArtifact(store, task, verification, args)
              : name === 'read_evidence'
                ? readEvidence(store, task.id, candidate, args, taskTraceAccess(store, { ...task, active_role: 'qa' }))
                : name === 'read_task_history'
                  ? records.tool(task.id, name, args, taskTraceAccess(store, task))
                  : name === 'read_file'
                    ? await verification.call(`accept:${evaluationId}:read:${randomId()}`, {
                        type: 'workspace_read',
                        path: args?.path,
                        ...(snapshot?.local_sha && typeof args?.path === 'string' && !args.path.startsWith('../') && !args.path.startsWith('/') ? { sha: snapshot.local_sha } : {}),
                      })
                    : await runCommand(verification, `accept:${evaluationId}:verify:${randomId()}`, args, 120, 'qa');
          records.history(task.id, 'acceptance_evidence', { evaluation_id: evaluationId, name, arguments: redactor.clean(args), result: redactor.clean(result) });
          return result;
        },
        repairInvalid: error => {
          if ((error as any).code !== 'acceptance_output_invalid') return undefined;
          records.history(task.id, 'acceptance_format_error', { evaluation_id: evaluationId, candidate_id: candidate.id, detail: String((error as any).detail || 'invalid_verdict') });
          return 'The verdict failed schema validation. Call submit_acceptance with { "pass": true, "issues": [] } when clean, or { "pass": false, "issues": ["concrete blocking issue"] } when returning for repair. Validation detail: ' + String((error as any).detail || 'invalid_verdict');
        },
        validate: content => {
          let value;
          try { value = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
          catch { return stop('acceptance_output_invalid', 'retry_wait', '验收器未返回有效 JSON。'); }
          return validateDecision(value);
        },
      },
      'qa',
      undefined,
      undefined,
      { prepare: roleBackendWorkspace(verification) },
    );
    records.history(task.id, 'acceptance_evaluated', { evaluation_id: evaluationId, candidate_id: candidate.id, elapsed_ms: Date.now() - start, verdict }, verificationRun?.id);
    verificationOutcome = verdict.outcome;
    return verdict;
  } catch (error) {
    verificationFault = (error as any).code || 'runtime_fault';
    records.history(task.id, 'acceptance_fault', { evaluation_id: evaluationId, candidate_id: candidate.id, elapsed_ms: Date.now() - start, code: (error as any).code || 'runtime_fault' });
    if (['acceptance_output_invalid', 'agent_turn_limit', 'acceptance_budget_exhausted'].includes((error as any).code)) {
      const failures = store.get("SELECT count(*) n FROM task_history WHERE task_id=? AND type='acceptance_fault' AND json_extract(data,'$.candidate_id')=? AND json_extract(data,'$.code') IN ('acceptance_output_invalid','agent_turn_limit','acceptance_budget_exhausted')", task.id, candidate.id)?.n || 0;
      if (failures >= 3) return stop('acceptance_unavailable', 'needs_replan', '轻量 QA 未能产生有效结论，候选与故障记录已保留；交回 Manager 决定恢复方法。');
    }
    if ((error as any).code === 'agent_turn_limit') return stop('acceptance_output_invalid', 'retry_wait', '轻量 QA 达到本轮轮次上限，候选已保留，自动重试。');
    throw error;
  } finally {
    endRun(store, verificationRun, verificationOutcome ? 'succeeded' : 'fault', verificationFault || verificationOutcome);
    task.trace_run_id = previousRun;
  }
}
