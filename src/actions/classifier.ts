export type FailureKind = 'external' | 'code' | 'unknown';
export interface Evidence { job: any; kind: FailureKind; reason: string; quote: string }

const external = [
  /\b(?:HTTP(?:Error|StatusError)?(?:\s+(?:status|error))?\s*[:=]?\s*|status(?: code)?\s*[:=]?\s*)(?:429|502|503)\b/i,
  /\b(?:429 Too Many Requests|502 Bad Gateway|503 Service Unavailable)\b/i,
  /\b(?:arxiv|arXiv)\b.*\b(?:HTTP\s*|status\s*[:=]?\s*)?(?:406|429)\b/i,
  /\b406\b.*\barxiv\b/i,
  /\b(?:ConnectTimeout|ReadTimeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND)\b/,
  /^curl:\s*\(28\)/i,
  /\b(?:connection|network|request|socket|gateway)\b.*\b(?:timed out|timeout|unreachable|reset by peer)\b/i,
  /\b(?:No space left on device|ENOSPC|runner lost communication|runner has lost communication|failed to acquire (?:a )?runner|GitHub Actions.*queue.*fail)\b/i,
];
const code = [
  /^(?:E\s+|error:\s*|##\[error\]\s*)?(?:[\w.]+\.)?(?:AssertionError|TypeError|ReferenceError|SyntaxError|NameError|ImportError|ModuleNotFoundError)\b/,
  /^(?:##\[error\]\s*)?(?:[^\s]+\(\d+,\d+\):\s*|[^\s]+:\d+:\d+\s*[-:]?\s*)?error TS\d+: /i,
  /^(?:##\[error\]\s*)?(?:error\[E\d+\]|FAIL\s+\S+|[✕×]\s+|Expected:|Assertion failed:)/,
  /^(?:##\[error\]\s*)?[^\s]+:\d+(?::\d+)?:\s*(?:error|fatal error):/i,
  /^\s*\d+:\d+\s+error\s+.+\S+$/,
];
const clean = (line: string) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// Only failed step intervals count. Successful steps, echoed commands and generic exit wrappers are not causes.
export function classifyJob(job: any, log: string | null): Evidence {
  const unknown = (reason: string, quote = ''): Evidence => ({ job, kind: 'unknown', reason, quote });
  if (!log || /\[(?:log )?truncated\]|characters omitted|output truncated/i.test(log)) return unknown('Missing or incomplete job log.');
  const steps = (job.steps || []).filter((s: any) => s.conclusion === 'failure');
  if (!steps.length) return unknown('No failed step with a causal log interval.');
  const lines = log.split('\n').map(clean).map(line => {
    const match = /^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$/.exec(line);
    return match ? { at: Date.parse(match[1]!), text: match[2]! } : null;
  });
  const causes: string[] = [], kinds = new Set<FailureKind>();
  for (const step of steps) {
    const start = Date.parse(step.started_at), end = Date.parse(step.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return unknown('Failed step timestamps are missing.');
    const scoped = lines.filter(l => l && l.at >= start && l.at < end + 1000).map(l => l!.text);
    if (!scoped.length) return unknown('Failed step output is missing.');
    let found = false;
    for (const text of scoped) {
      if (/^\s*(?:##\[group\]|Run |echo |\+ |\$ |shell:|env:)/.test(text)) continue;
      const causal = /^(?:##\[error\]\s*|E\s+)?(?:[\w.]+(?:Error|Exception|Timeout)\b|error\b|HTTP\b|arxiv\b|curl:|No space left on device|ENOSPC|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|runner\b|failed to acquire\b|GitHub Actions\b)/i.test(text);
      const e = causal && external.some(pattern => pattern.test(text)), c = code.some(pattern => pattern.test(text));
      if (e || c) { if (e) kinds.add('external'); if (c) kinds.add('code'); causes.push(text); found = true; }
      else if (/^(?:##\[error\]|(?:[\w.]+)?(?:Error|Exception):)/.test(text)
        && !/Process completed with exit code|script returned exit code|command failed with exit code/i.test(text)) { kinds.add('unknown'); causes.push(text); }
    }
    if (!found) return unknown('No recognized causal evidence in a failed step.', causes.join('\n'));
  }
  const quote = causes.join('\n');
  return kinds.size === 1 && !kinds.has('unknown')
    ? { job, kind: [...kinds][0]!, reason: 'Causal evidence from failed steps.', quote }
    : unknown('Mixed or ambiguous causal evidence in failed steps.', quote);
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
