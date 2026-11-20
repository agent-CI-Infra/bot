const clean = (line: string) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// Extract the log lines inside each failed step's time interval for the event summary.
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
