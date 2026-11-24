import type { Store, Row } from '../storage/database.js';
import { blobValue } from '../storage/payloads.js';
import { changedWorkflowPaths, type CandidateFileEntry } from '../github/workflow-changes.js';
import { effectiveWrites, grantedWrites } from './grants.js';
import { sourcePolicies } from './management.js';
import { genericTask, softwareRequest } from './pull-request.js';
import { TaskRecords, type Candidate } from './service.js';
import { taskPermissions } from './configuration.js';

export type DeliveryKind = 'pull_request' | 'review' | 'report';

export interface ChangeSummary {
  total: number;
  added_count: number;
  modified_count: number;
  deleted_count: number;
  added: string[];
  modified: string[];
  deleted: string[];
  truncated: boolean;
  touches_workflows: boolean;
  workflow_files: string[];
}

export interface DeliveryContext {
  target: Record<string, unknown> | null;
  base_branch: string | null;
  base_sha: string | null;
  base_ref_sha?: string;
  pr_number?: number;
  pr_branch?: string | null;
  goal: string | null;
  intended_delivery: DeliveryKind;
  writes: string[];
  pr_base_semantics: string;
}

export interface DeliveryHandoff {
  target: Record<string, unknown> | null;
  goal: string | null;
  intended_delivery: DeliveryKind;
  actual_delivery: DeliveryKind;
  baseline: {
    base_branch: string | null;
    base_sha: string | null;
    workspace_head_sha: string | null;
    head_matches_baseline: boolean | null;
  };
  changes: ChangeSummary | null;
  nomination: {
    source_ref: string | null;
    source_task_id: string | null;
    is_child_task: boolean;
    change_title: string | null;
    summary: string | null;
    checks_note: string | null;
    delivery: DeliveryKind | null;
  };
}

const isSha40 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);

/** Summarizes added, modified, and deleted paths relative to the baseline snapshot, with bounded path lists. */
export function summarizeFileChanges(
  files: ReadonlyArray<CandidateFileEntry> = [],
  snapshotFiles: ReadonlyArray<CandidateFileEntry> = [],
  maxPerBucket = 100,
): ChangeSummary {
  const baseline = new Map<string, CandidateFileEntry>();
  for (const entry of snapshotFiles) {
    if (entry?.path) baseline.set(String(entry.path), entry);
  }
  const current = new Set<string>();
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const entry of files) {
    if (!entry?.path) continue;
    const p = String(entry.path);
    current.add(p);
    const prev = baseline.get(p);
    if (!prev) {
      added.push(p);
    } else if (prev.sha !== entry.sha || (prev.mode && entry.mode && prev.mode !== entry.mode)) {
      modified.push(p);
    }
  }
  for (const entry of snapshotFiles) {
    if (!entry?.path) continue;
    const p = String(entry.path);
    if (!current.has(p)) deleted.push(p);
  }
  added.sort();
  modified.sort();
  deleted.sort();
  const workflowFiles = changedWorkflowPaths(files, snapshotFiles);
  return {
    total: added.length + modified.length + deleted.length,
    added_count: added.length,
    modified_count: modified.length,
    deleted_count: deleted.length,
    added: added.slice(0, maxPerBucket),
    modified: modified.slice(0, maxPerBucket),
    deleted: deleted.slice(0, maxPerBucket),
    truncated: added.length > maxPerBucket || modified.length > maxPerBucket || deleted.length > maxPerBucket,
    touches_workflows: workflowFiles.length > 0,
    workflow_files: workflowFiles,
  };
}

function safeParseJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Resolves the workspace's expected baseline commit SHA (local synthetic commit for snapshot checkouts, remote SHA for git worktrees). */
export function resolveExpectedWorkspaceHead(task: Row, parsedInput?: any): string | null {
  const input = parsedInput ?? safeParseJson(task?.input);
  const candidate = input?.workspace_base_head_sha ?? input?.snapshot_sha ?? task?.head_sha;
  return isSha40(candidate) ? candidate.toLowerCase() : null;
}

/** Checks whether the workspace HEAD drifted away from the recorded publication baseline (excluding valid conflict merges/rebases or integrations). */
export function checkWorkspaceHeadDrift(
  expectedHead: string | null | undefined,
  actualHead: string | null | undefined,
  options: { conflictResolved?: boolean; rebased?: boolean; integration?: boolean } = {},
): { drifted: boolean; head_matches_baseline: boolean | null; expected_head_sha: string | null; workspace_head_sha: string | null } {
  const expected = isSha40(expectedHead) ? expectedHead.toLowerCase() : null;
  const actual = isSha40(actualHead) ? actualHead.toLowerCase() : null;
  if (!expected || !actual) {
    return { drifted: false, head_matches_baseline: null, expected_head_sha: expected, workspace_head_sha: actual };
  }
  const matches = expected === actual;
  if (matches) {
    return { drifted: false, head_matches_baseline: true, expected_head_sha: expected, workspace_head_sha: actual };
  }
  if (options.conflictResolved || options.rebased || options.integration) {
    return { drifted: false, head_matches_baseline: false, expected_head_sha: expected, workspace_head_sha: actual };
  }
  return { drifted: true, head_matches_baseline: false, expected_head_sha: expected, workspace_head_sha: actual };
}

function resolveTaskWrites(store: Store, task: Row): string[] {
  try {
    if (genericTask(task)) return effectiveWrites(store, task, sourcePolicies(store, task));
  } catch { /* fall back below */ }
  try {
    const granted = grantedWrites(store, String(task.id));
    if (granted) return granted;
  } catch { /* ignore */ }
  try {
    return taskPermissions(store, task).writes;
  } catch {
    return [];
  }
}

export function resolveIntendedDelivery(task: Row, contract: any, writes: string[]): DeliveryKind {
  const endpoint = String(contract?.endpoint ?? '');
  const kind = String(task.kind ?? '');
  if (endpoint === 'reviewable_pull_request' || kind.startsWith('development.') || kind === 'task.development') return 'pull_request';
  if (endpoint === 'review' || kind.startsWith('review.')) return 'review';
  if (writes.includes('pull_request')) return 'pull_request';
  if (writes.includes('review')) return 'review';
  return 'report';
}

function resolveTarget(task: Row, input: any): Record<string, unknown> | null {
  if (input?.target_meta && typeof input.target_meta === 'object') return input.target_meta;
  if (input?.target && typeof input.target === 'object') return input.target;
  if (task?.object_number != null) {
    return { type: String(task.kind ?? '').endsWith('.pr') ? 'pr' : 'issue', number: Number(task.object_number) };
  }
  return null;
}

/** Deterministically builds structured delivery context shared across Task Manager, Dev, and Observer roles. */
export function buildDeliveryContext(store: Store, task: Row): DeliveryContext {
  const input = safeParseJson(task?.input);
  let contract: any = input?.contract ?? null;
  try {
    contract = new TaskRecords(store).get(String(task.id)).contract ?? contract;
  } catch { /* task_records row may not exist in minimal fixtures */ }
  const writes = resolveTaskWrites(store, task);
  const intended = resolveIntendedDelivery(task, contract, writes);
  const target = resolveTarget(task, input);
  const baseBranch: string | null =
    (typeof input?.base_branch === 'string' && input.base_branch.trim() ? input.base_branch.trim() : null) ??
    (typeof input?.target_meta?.base_ref === 'string' && input.target_meta.base_ref.trim() ? input.target_meta.base_ref.trim() : null) ??
    (typeof input?.bot_pr?.base?.ref === 'string' && input.bot_pr.base.ref.trim() ? input.bot_pr.base.ref.trim() : null);
  const baseSha: string | null =
    (isSha40(input?.snapshot_sha) ? input.snapshot_sha.toLowerCase() : null) ??
    (isSha40(task?.head_sha) ? String(task.head_sha).toLowerCase() : null);
  const baseRefSha = isSha40(input?.base_ref_sha) ? input.base_ref_sha.toLowerCase() : undefined;
  const botPr = input?.bot_pr && typeof input.bot_pr === 'object' ? input.bot_pr : null;
  const shaLabel = baseSha ? baseSha.slice(0, 12) : 'unknown';
  const branchLabel = baseBranch ? `'${baseBranch}'` : 'the repository default branch';

  let prBaseSemantics: string;
  if (intended === 'pull_request' || writes.includes('pull_request')) {
    if (botPr?.number) {
      prBaseSemantics = `The workspace is checked out at existing bot PR #${botPr.number} head (${shaLabel}) targeting base branch ${branchLabel}. Calling open_pull_request updates that PR branch against ${branchLabel}. Do NOT run git checkout/switch to another branch; the control plane tracks and enforces this baseline (only explicit conflict resolution merges/rebases onto bot-conflict-base).`;
    } else {
      prBaseSemantics = `The workspace is checked out at baseline commit ${shaLabel} on branch ${branchLabel}. Calling open_pull_request creates a bot branch from this baseline and opens a PR with base branch ${branchLabel}. Do NOT run git checkout/switch to another branch; the control plane tracks and enforces this baseline.`;
    }
  } else {
    prBaseSemantics = baseBranch
      ? `The workspace is checked out at commit ${shaLabel} (branch ${branchLabel}).`
      : `The workspace is checked out at commit ${shaLabel}.`;
  }

  return {
    target,
    base_branch: baseBranch,
    base_sha: baseSha,
    ...(baseRefSha && baseRefSha !== baseSha ? { base_ref_sha: baseRefSha } : {}),
    ...(botPr?.number ? { pr_number: Number(botPr.number), pr_branch: typeof botPr.head?.ref === 'string' ? botPr.head.ref : null } : {}),
    goal: typeof contract?.goal === 'string' ? contract.goal : typeof input?.request === 'string' ? input.request : typeof task?.summary === 'string' ? task.summary : null,
    intended_delivery: intended,
    writes,
    pr_base_semantics: prBaseSemantics,
  };
}

/** Deterministically builds top-level QA delivery handoff (never folded by boundedCandidate). */
export function buildDeliveryHandoff(
  store: Store,
  task: Row,
  candidate: Candidate,
  liveHeadSha?: string | null,
): DeliveryHandoff {
  const input = safeParseJson(task?.input);
  let contract: any = input?.contract ?? null;
  try {
    contract = new TaskRecords(store).get(String(task.id)).contract ?? contract;
  } catch { /* ignore */ }
  const writes = resolveTaskWrites(store, task);
  const intended = resolveIntendedDelivery(task, contract, writes);
  const target = resolveTarget(task, input);

  const codeArtifact = candidate.artifacts.find(a => a.kind === 'code');
  const filesArtifact = codeArtifact ?? candidate.artifacts.find(a => a.kind === 'files');
  const reportArtifact = candidate.artifacts.find(a => a.kind === 'report');
  const codeContent = (codeArtifact?.content ?? null) as any;
  const filesContent = (filesArtifact?.content ?? null) as any;
  const reportContent = (reportArtifact?.content ?? null) as any;
  const claims = (candidate.claims ?? null) as any;

  let actualDelivery: DeliveryKind;
  if (codeArtifact && !codeContent?.no_changes) {
    actualDelivery = 'pull_request';
  } else if (reportContent?.delivery === 'pull_request' || reportContent?.delivery === 'review' || reportContent?.delivery === 'report') {
    actualDelivery = reportContent.delivery;
  } else if (input?.delivery === 'pull_request' || input?.delivery === 'review' || input?.delivery === 'report') {
    actualDelivery = input.delivery;
  } else if (softwareRequest(task)) {
    actualDelivery = 'pull_request';
  } else {
    actualDelivery = 'report';
  }

  const baseBranch: string | null =
    (typeof codeContent?.base_branch === 'string' && codeContent.base_branch.trim() ? codeContent.base_branch.trim() : null) ??
    (typeof input?.base_branch === 'string' && input.base_branch.trim() ? input.base_branch.trim() : null) ??
    (typeof input?.target_meta?.base_ref === 'string' && input.target_meta.base_ref.trim() ? input.target_meta.base_ref.trim() : null) ??
    null;
  const baseSha: string | null =
    (isSha40(codeContent?.base_sha) ? codeContent.base_sha.toLowerCase() : null) ??
    (isSha40(filesContent?.base_sha) ? filesContent.base_sha.toLowerCase() : null) ??
    (isSha40(input?.snapshot_sha) ? input.snapshot_sha.toLowerCase() : null) ??
    (isSha40(task?.head_sha) ? String(task.head_sha).toLowerCase() : null);

  const expectedWorkspaceHead =
    (isSha40(codeContent?.expected_head_sha) ? codeContent.expected_head_sha.toLowerCase() : null) ??
    (isSha40(filesContent?.expected_head_sha) ? filesContent.expected_head_sha.toLowerCase() : null) ??
    resolveExpectedWorkspaceHead(task, input);

  const workspaceHeadSha: string | null =
    (isSha40(codeContent?.head_sha) ? codeContent.head_sha.toLowerCase() : null) ??
    (isSha40(filesContent?.head_sha) ? filesContent.head_sha.toLowerCase() : null) ??
    (isSha40(liveHeadSha) ? liveHeadSha.toLowerCase() : null);

  const headMatchesBaseline: boolean | null =
    typeof codeContent?.head_matches_baseline === 'boolean'
      ? codeContent.head_matches_baseline
      : typeof filesContent?.head_matches_baseline === 'boolean'
        ? filesContent.head_matches_baseline
        : expectedWorkspaceHead && workspaceHeadSha
          ? expectedWorkspaceHead === workspaceHeadSha
          : null;

  const currentFiles: CandidateFileEntry[] | null = Array.isArray(filesContent?.files) ? filesContent.files : null;
  const snapshotFilesRaw = Array.isArray(codeContent?.snapshot_files)
    ? codeContent.snapshot_files
    : blobValue(store, input?.snapshot_files);
  const snapshotFiles: CandidateFileEntry[] | null = Array.isArray(snapshotFilesRaw) ? snapshotFilesRaw : null;
  const changes: ChangeSummary | null = currentFiles && snapshotFiles ? summarizeFileChanges(currentFiles, snapshotFiles) : null;

  // Read latest delivery_nominated event if it corresponds to this candidate (newer than or matching latest worker result).
  const nomRow = store.get(
    "SELECT id,data FROM task_history WHERE task_id=? AND type='delivery_nominated' ORDER BY id DESC LIMIT 1",
    task.id,
  );
  const latestWorkerId = store.get(
    "SELECT max(id) id FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role') NOT IN ('manager','qa')",
    task.id,
  )?.id;
  const nomData = nomRow && (latestWorkerId == null || Number(nomRow.id) >= Number(latestWorkerId))
    ? safeParseJson(nomRow.data)
    : null;
  const primarySource = Array.isArray(nomData?.sources) ? nomData.sources[0] : null;
  const sourceTaskId = typeof primarySource?.task_id === 'string' ? primarySource.task_id : String(task.id);
  const isChildTask = typeof nomData?.is_child_task === 'boolean'
    ? nomData.is_child_task
    : Boolean(primarySource?.task_id && primarySource.task_id !== String(task.id));
  const rawSummary =
    (typeof nomData?.summary === 'string' && nomData.summary) ||
    (typeof codeContent?.summary === 'string' && codeContent.summary) ||
    (typeof reportContent?.summary === 'string' && reportContent.summary) ||
    (typeof claims?.summary === 'string' && claims.summary) ||
    null;
  const rawChangeTitle =
    (typeof nomData?.change_title === 'string' && nomData.change_title) ||
    (typeof codeContent?.change_title === 'string' && codeContent.change_title) ||
    (typeof reportContent?.change_title === 'string' && reportContent.change_title) ||
    (typeof claims?.change_title === 'string' && claims.change_title) ||
    null;

  return {
    target,
    goal: typeof contract?.goal === 'string' ? contract.goal : typeof input?.request === 'string' ? input.request : null,
    intended_delivery: intended,
    actual_delivery: actualDelivery,
    baseline: {
      base_branch: baseBranch,
      base_sha: baseSha,
      workspace_head_sha: workspaceHeadSha,
      head_matches_baseline: headMatchesBaseline,
    },
    changes,
    nomination: {
      source_ref: typeof nomData?.result_ref === 'string' ? nomData.result_ref : null,
      source_task_id: sourceTaskId,
      is_child_task: isChildTask,
      change_title: rawChangeTitle ? rawChangeTitle.slice(0, 300) : null,
      summary: rawSummary ? rawSummary.slice(0, 2000) : null,
      checks_note: typeof nomData?.checks_note === 'string' ? nomData.checks_note : null,
      delivery: (nomData?.delivery === 'pull_request' || nomData?.delivery === 'review' || nomData?.delivery === 'report')
        ? nomData.delivery
        : actualDelivery,
    },
  };
}
