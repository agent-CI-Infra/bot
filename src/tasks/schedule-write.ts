import type { Row } from '../storage/database.js';
import type { WriteOperation, WriteResource } from '../github/write.js';

export function taskInputOf(task: Row): any {
  try { return JSON.parse(String(task.input || '{}')); } catch { return {}; }
}

/**
 * A scheduled check may file Issues only when its plan set `parameters.file_issues`.
 * Unset keeps the existing role-gated default. The flag never grants Contents or pull-request writes.
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

export function taskGithubWriteAllowedBySchedule(task: Row, resource: WriteResource, operation?: WriteOperation, roleAllows?: boolean): boolean {
  const scheduled = scheduledIssueOperationAllowed(task, resource, operation);
  if (scheduled !== null) return scheduled;
  return !!roleAllows;
}
