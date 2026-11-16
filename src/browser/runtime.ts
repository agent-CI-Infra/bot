import { join } from 'node:path';

/** Per-task directory under the control-plane evidence root (bot-data/browser-evidence). */
export function browserEvidenceDir(root: string, taskId: string): string {
  return join(root, taskId.replace(/[^A-Za-z0-9._-]/g, '_'));
}
