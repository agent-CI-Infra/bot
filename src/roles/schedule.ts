import type { Store } from '../storage/database.js';
import { eventHistory, historyOrder } from './role-run.js';
import { contentHash, validateCandidateRef, type CandidateRef } from './protocol.js';

function stageHash(value: unknown) {
  const canonical = (item: any): any =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]))
        : item;
  return contentHash(canonical(value));
}

export function candidateKey(candidate: CandidateRef | null) {
  if (!candidate) return 'source';
  const { ref: _ref, ...version } = validateCandidateRef(candidate);
  return stageHash(version);
}

export function latestRoleCandidate(s: Store, taskId: string): CandidateRef | null {
  const row = s.get(
    `SELECT h.data FROM role_run_events e JOIN task_runs r ON r.id=e.run_id JOIN task_history h ON ${eventHistory}
     WHERE e.task_id=? AND e.type='ended' AND e.category='completed' AND r.role='dev' AND r.revision=(SELECT revision FROM task_records WHERE task_id=e.task_id) ORDER BY ${historyOrder} DESC LIMIT 1`,
    taskId,
  );
  return row ? JSON.parse(row.data).data.candidate_ref ?? null : null;
}

export function deliveryType(s: Store, taskId: string, candidate?: CandidateRef | null): 'code' | 'artifact' | 'no_changes' {
  const task = s.get('SELECT kind FROM tasks WHERE id=?', taskId);
  const record = s.get('SELECT contract FROM task_records WHERE task_id=?', taskId);
  if (!task || !record) throw new Error('task_not_found');
  if (candidate?.kind === 'no_changes') return 'no_changes';
  const contract = JSON.parse(record.contract);
  return String(task.kind ?? '').startsWith('development.') || ['code', 'pull_request', 'pr', 'reviewable_pull_request'].includes(contract.endpoint) ? 'code' : 'artifact';
}

export function artifactCandidate(result: any, treeHash: string | null, revision: number, reference: string, taskKind = ''): CandidateRef {
  let body = result;
  if (taskKind.startsWith('review.') || taskKind.startsWith('workflow.')) {
    const { reviewed_sha: _a, coverage: _b, object_hash: _c, pull_request: _d, ...content } = result;
    body = { ...content, ...(Array.isArray(content.findings) ? { findings: content.findings.map(({ id: _id, ...finding }: any) => finding) } : {}) };
  }
  return { kind: 'artifact', ref: reference, revision: 'contract:revision:' + revision, content_hash: contentHash({ result: body, tree_hash: treeHash }) };
}

export function deliveryCandidate(candidate: any, taskKind = ''): CandidateRef | null {
  if (!candidate) return null;
  const unchanged = candidate.artifacts.find((a: any) => a.content?.status === 'no_changes');
  if (unchanged?.content?.source_ref) {
    return { kind: 'no_changes', ref: 'candidate:' + candidate.id, source_ref: unchanged.content.source_ref, record_hash: contentHash({ source_ref: unchanged.content.source_ref, tree_hash: unchanged.version }) };
  }
  const files = candidate.artifacts.find((a: any) => ['code', 'files'].includes(a.kind));
  const report = candidate.artifacts.find((a: any) => a.kind === 'report');
  if (report) return artifactCandidate(report.content, files?.version ?? null, candidate.revision, 'candidate:' + candidate.id, taskKind);
  const commit = files?.content?.local_sha ?? files?.content?.sha;
  if (/^[a-f0-9]{40}$/.test(commit ?? '') && /^[a-f0-9]{40}$/.test(files?.version ?? '')) {
    return { kind: 'code', ref: 'candidate:' + candidate.id, commit_sha: commit, tree_hash: files.version };
  }
  return artifactCandidate(candidate.claims, null, candidate.revision, 'candidate:' + candidate.id, taskKind);
}
