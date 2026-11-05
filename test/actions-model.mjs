
// The analysis model of the Actions failure tests. It answers with the rules the bot used before a model classified failures:
// an error line from outside the repository is external, an assertion or compiler error is code, anything else or a mix is
// unknown, and it cites the lines it used. Tests that need another answer pass `respond`.
const external = [
  /\b(?:HTTP(?:Error|StatusError)?(?:\s+(?:status|error))?\s*[:=]?\s*|status(?: code)?\s*[:=]?\s*)(?:429|502|503)\b/i,
  /\b(?:429 Too Many Requests|502 Bad Gateway|503 Service Unavailable)\b/i,
  /\b(?:arxiv|arXiv)\b.*\b(?:HTTP\s*|status\s*[:=]?\s*)?(?:406|429)\b/i, /\b406\b.*\barxiv\b/i,
  /\b(?:ConnectTimeout|ReadTimeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND)\b/,
  /\b(?:No space left on device|ENOSPC|runner lost communication)\b/i,
];
const code = [
  /^(?:E\s+|error:\s*|##\[error\]\s*)?(?:[\w.]+\.)?(?:AssertionError|TypeError|ReferenceError|SyntaxError|NameError|ImportError|ModuleNotFoundError)\b/,
  /^(?:##\[error\]\s*)?(?:[^\s]+\(\d+,\d+\):\s*|[^\s]+:\d+:\d+\s*[-:]?\s*)?error TS\d+: /i,
  /^(?:##\[error\]\s*)?[^\s]+:\d+(?::\d+)?:\s*(?:error|fatal error):/i,
];
export function classifyOutput(job) {
  if (job.log_problem) return { kind: 'unknown', reason: job.log_problem, evidence: [] };
  const kinds = new Set(), evidence = [];
  for (const text of String(job.failed_step_output || '').split('\n')) {
    if (/^\s*(?:##\[group\]|Run |echo |\+ |\$ |shell:|env:)/.test(text)) continue;
    const causal = /^(?:##\[error\]\s*|E\s+)?(?:[\w.]+(?:Error|Exception|Timeout)\b|error\b|HTTP\b|arxiv\b|curl:|No space left on device|ENOSPC|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|runner\b)/i.test(text);
    const e = causal && external.some(pattern => pattern.test(text)), c = code.some(pattern => pattern.test(text));
    if (e || c) { if (e) kinds.add('external'); if (c) kinds.add('code'); evidence.push(text); }
    else if (/^(?:##\[error\]|(?:[\w.]+)?(?:Error|Exception):)/.test(text) && !/Process completed with exit code/i.test(text)) { kinds.add('unknown'); evidence.push(text); }
  }
  const kind = kinds.size === 1 && !kinds.has('unknown') ? [...kinds][0] : 'unknown';
  return { kind, reason: kind === 'external' ? 'A service outside the repository failed.' : kind === 'code' ? 'The repository code failed its own check.' : 'The evidence does not tell.', evidence };
}
// The analysis agent of the Actions failure tests: it plays the workflow's task in the project computer (see
// event-tasks.mjs). By default it answers with the rules above, through the same tools the agent has: an external job is
// handed to rerun_failed_run, every other job to report_failure. respond(input, request, n) may answer instead with
// { content } (the JSON of {jobs:[...]} or text that is not), or { status } for a model that does not answer.
export function actionsModel(_t, respond) {
  const requests = [];
  const agent = async ({ input, target, tools }) => {
    requests.push({ input, target });
    const reply = respond ? await respond(input, requests.at(-1), requests.length) : { content: JSON.stringify({ jobs: input.failed_jobs.map(job => ({ job_id: job.job_id, ...classifyOutput(job) })) }) };
    if (reply.status) return { wait: 'model_http_' + reply.status };
    let value; try { value = JSON.parse(reply.content); } catch { value = null; }
    if (!Array.isArray(value?.jobs)) throw Object.assign(new Error('unusable output'), { code: 'actions_classification_invalid', state: 'failed' });
    for (const job of value.jobs) {
      const args = { reason: job.reason, evidence: job.evidence };
      if (job.kind === 'external' && tools.rerun_failed_run) await tools.rerun_failed_run('call', { job_ids: [job.job_id], ...args });
      else await tools.report_failure?.('call', { job_id: job.job_id, kind: job.kind, ...args });
    }
    return { summary: 'Analyzed.' };
  };
  return { url: 'https://model.invalid/v1', requests, agent };
}
