import type { Row } from '../storage/database.js';
import type { WriteOperation, WriteResource } from '../github/write.js';

export function taskInputOf(task: Row): any {
  try { return JSON.parse(String(task.input || '{}')); } catch { return {}; }
}

/**
 * The plan's `file_issues` flag is authoritative for Issue create/reply on a scheduled check:
 * true allows those writes even if the executing role has no GitHub write; false denies them
 * even if the role has it; absent/unset falls back to role policy. The flag never grants
 * Contents or pull-request writes, and every write still goes through the project capability
 * ceiling (#850).
 */
export function scheduledIssueWrite(task: Row): 'allow' | 'deny' | 'unset' {
  const input = taskInputOf(task);
  const source = input.contract?.source;
  if (source?.type !== 'schedule') return 'unset';
  const flag = input.file_issues ?? source.file_issues;
  if (flag === true) return 'allow';
  if (flag === false) return 'deny';
  return 'unset';
}

/** `null` means fall through to role policies. */
export function scheduledIssueOperationAllowed(task: Row, resource: WriteResource, operation?: WriteOperation): boolean | null {
  const mode = scheduledIssueWrite(task);
  if (mode === 'unset') return null;
  if (resource === 'issues' && (operation === 'create' || operation === 'reply')) return mode === 'allow';
  return null;
}

/** Default contract criteria when a scheduled check starts without a Manager brief. */
export function scheduledCheckCriteria(file_issues?: boolean): string[] {
  if (file_issues === true) {
    return ['Report what was checked, with evidence; create or reply to Issues when the instruction requires it; change nothing else outside the task workspace.'];
  }
  if (file_issues === false) {
    return ['Report what was checked, with evidence; do not create or reply to Issues; change nothing outside the task workspace.'];
  }
  return ['Report what was checked, with evidence; create or reply to Issues only when the instruction requires it and github_write is offered; change nothing else outside the task workspace.'];
}
