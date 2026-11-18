import type { GitHub } from '../github/client.js';
import { verifiedEvidence, type FailureKind } from './classifier.js';
import { redactCredentials } from '../core/redaction.js';

export type Citation = { type: 'log'; job_id: number; lines: string[] }
  | { type: 'source'; path: string; lines: string[] }
  | { type: 'artifact'; artifact_id: number };
export interface FailureReport {
  cause: string;
  job_ids: number[];
  kind: FailureKind;
  title: string;
  diagnosis: string;
  report_reason: string;
  evidence: Citation[];
}
export interface CheckedReport extends FailureReport {
  withheld_reason?: string;
}
export const causeIdentity = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const lines = (value: unknown): value is string[] => Array.isArray(value) && !!value.length && value.every(text);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sourcePath = (value: unknown): value is string => text(value) && !/[\\\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
/** Validate both live tool arguments and persisted results; stored data is not a publication authority. */
export function validReport(value: any, jobIds: Set<number>): value is FailureReport {
  return !!value && ['external', 'code', 'unknown'].includes(value.kind) &&
    ['cause', 'title', 'diagnosis', 'report_reason'].every(key => text(value[key])) &&
    Array.isArray(value.job_ids) && !!value.job_ids.length && value.job_ids.every((id: unknown) => positive(id) && jobIds.has(id)) &&
    new Set(value.job_ids).size === value.job_ids.length && Array.isArray(value.evidence) && value.evidence.every((cite: any) =>
      cite?.type === 'log' ? value.job_ids.includes(cite.job_id) && lines(cite.lines) :
      cite?.type === 'source' ? sourcePath(cite.path) && lines(cite.lines) :
      cite?.type === 'artifact' && positive(cite.artifact_id));
}

/** Logs are matched verbatim; source is read at the failed SHA. An artifact link verifies origin, never its contents. */
export async function checkReports(github: GitHub, run: any, reports: FailureReport[], outputs: { job: any; output: { lines: string[] } }[]): Promise<CheckedReport[]> {
  const jobs = new Map(outputs.map(item => [item.job.id, item.output.lines]));
  const sources = new Map<string, string[]>(), artifacts = new Map<number, any>();
  const checked: CheckedReport[] = [];
  for (const report of reports) {
    if (!validReport(report, new Set(jobs.keys()))) continue;
    if (report.kind === 'unknown') { checked.push(report); continue; }
    let verified = false;
    for (const cite of report.evidence) {
      if (cite.type === 'log') {
        verified = verifiedEvidence(cite.lines, jobs.get(cite.job_id) || []).length > 0;
      } else if (cite.type === 'source') {
        if (!sources.has(cite.path)) {
          const file = await github.request('GET', github.path('/contents/' + cite.path.split('/').map(encodeURIComponent).join('/') + '?ref=' + run.head_sha), undefined, true);
          sources.set(cite.path, file?.type !== 'dir' && file?.encoding === 'base64' && typeof file.content === 'string' ? Buffer.from(file.content, 'base64').toString('utf8').split('\n') : []);
        }
        verified = verifiedEvidence(cite.lines, sources.get(cite.path)!).length > 0;
      } else {
        if (!artifacts.has(cite.artifact_id)) artifacts.set(cite.artifact_id, await github.request('GET', github.path('/actions/artifacts/' + cite.artifact_id), undefined, true));
        const artifact = artifacts.get(cite.artifact_id);
        verified = artifact?.id === cite.artifact_id && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === run.head_sha;
      }
      if (verified) break; // One verified source satisfies the publication gate.
    }
    // Invalid citations never silently turn a code accusation into an automatically filed unknown report.
    checked.push({ ...report, ...(!verified
      ? { withheld_reason: 'No cited reference could be verified; this report was withheld rather than automatically filed as unknown.' } : {}) });
  }
  return redactCredentials(github.redactor.clean(checked));
}
