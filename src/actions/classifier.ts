export type FailureKind = 'external' | 'code' | 'unknown';
// The verified log quote supports classification and matching historical per-job receipts.
export interface Evidence { job: any; kind: FailureKind; reason: string; quote: string }
const clean = (line: string) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// What the failed steps of a job printed: the log lines inside each failed step's time interval. The model classifies from
// this output (and may read the whole log); the lines it cites must be lines of it. `problem` says why there is none.
export function failedStepOutput(job: any, log: string | null): { lines: string[]; problem?: string } {
  const none = (problem: string) => ({ lines: [], problem });
  if (!log || /\[(?:log )?truncated\]|characters omitted|output truncated/i.test(log)) return none('Missing or incomplete job log.');
  const steps = (job.steps || []).filter((s: any) => s.conclusion === 'failure');
  if (!steps.length) return none('No failed step with a log interval.');
  const lines = log.split('\n').map(clean).map(line => {
    const match = /^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$/.exec(line);
    return match ? { at: Date.parse(match[1]!), text: match[2]! } : null;
  });
  const output: string[] = [];
  for (const step of steps) {
    const start = Date.parse(step.started_at), end = Date.parse(step.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return none('Failed step timestamps are missing.');
    const scoped = lines.filter(l => l && l.at >= start && l.at < end + 1000).map(l => l!.text);
    if (!scoped.length) return none('Failed step output is missing.');
    output.push(...scoped);
  }
  return { lines: output };
}
// Lines the model cites must be lines the failed steps printed (compared without surrounding space), so it can neither
// invent log text nor quote a step that did not fail.
export function verifiedEvidence(cited: unknown, output: string[]): string[] {
  if (!Array.isArray(cited)) return [];
  const printed = new Set(output.map(line => line.trim()).filter(Boolean));
  return [...new Set(cited.filter((line): line is string => typeof line === 'string').map(line => clean(line).replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim()).filter(line => printed.has(line)))];
}

export function classifyFailure(evidence: Evidence[]): FailureKind {
  const kinds = new Set(evidence.map(e => e.kind));
  return kinds.size === 1 ? evidence[0]!.kind : 'unknown';
}

export function normalizeSignature(value: string) {
  return value.toLowerCase().replace(/\b[0-9a-f]{7,64}\b/g, '<sha>')
    .replace(/\b\d{4}-\d\d-\d\d[t ][\d:.+z-]+/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|mins?|s)\b/g, '<duration>')
    .replace(/:\d+(?::\d+)?\b|\(\d+(?:,\d+)?\)|\bline \d+\b/g, '<line>')
    .replace(/\s+/g, ' ').trim();
}
