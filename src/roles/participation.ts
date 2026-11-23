import type { Store } from '../storage/database.js';

/**
 * Which roles produced results for a task's current candidate (#1250). The candidate is the latest Dev result; a worker
 * result recorded after it inspected that candidate (an observer run whose candidate changed underneath is rejected in
 * run.ts), one recorded before it saw an earlier version. The Task Manager reads this where it decides on nomination and
 * QA reads the same: facts for their judgment, never a gate.
 */
export function candidateParticipation(s: Store, taskId: string) {
  const rows = s.all("SELECT id,json_extract(data,'$.role') role FROM task_history WHERE task_id=? AND type='role_result' ORDER BY id", taskId)
    .filter(row => typeof row.role === 'string' && !['manager', 'qa'].includes(row.role));
  if (!rows.length) return undefined;
  const dev = rows.filter(row => row.role === 'dev'), candidate = dev.at(-1);
  const after = candidate ? rows.filter(row => row.id > candidate.id && row.role !== 'dev') : [];
  const inspected = [...new Set(after.map(row => String(row.role)))];
  const earlier = [...new Set(rows.filter(row => row.role !== 'dev' && (!candidate || row.id < candidate.id)).map(row => String(row.role)))]
    .filter(role => !inspected.includes(role));
  const list = (roles: string[]) => roles.join(' and ');
  const summary = !candidate ? `no dev result in this task; results from ${list(earlier)}`
    : inspected.length ? `dev, then ${list(inspected)} on this candidate`
    : earlier.length ? `dev only on this candidate: ${list(earlier)} inspected an earlier candidate, not this one`
    : 'dev only: no independent role inspected this candidate';
  return {
    candidate_ref: candidate ? 'task_history:' + candidate.id : null,
    dev_results: dev.length,
    inspected_by: inspected.map(role => ({ role, ref: 'task_history:' + after.filter(row => row.role === role).at(-1)!.id })),
    earlier_candidates_only: earlier,
    summary,
  };
}

/**
 * The same facts for QA: what the Task Manager nominated with, and its note on the checks, while that nomination is newer
 * than the latest worker result. A task without a nomination (a single executing role) reads its own results.
 */
export function acceptanceParticipation(s: Store, taskId: string) {
  const current = candidateParticipation(s, taskId);
  const row = s.get("SELECT id,data FROM task_history WHERE task_id=? AND type='delivery_nominated' ORDER BY id DESC LIMIT 1", taskId);
  const latest = s.get("SELECT max(id) id FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role') NOT IN ('manager','qa')", taskId)?.id;
  if (!row || (latest != null && Number(row.id) < Number(latest))) return current;
  const nominated = JSON.parse(String(row.data));
  const facts = nominated.candidate_participation ?? current;
  return facts || nominated.checks_note ? { ...(facts ?? {}), ...(nominated.checks_note ? { checks_note: nominated.checks_note } : {}) } : undefined;
}
