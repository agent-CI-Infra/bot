import { createServer } from 'node:http';
import { once } from 'node:events';

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
export async function actionsModel(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const reply = respond ? await respond(input, body, requests.length) : { content: JSON.stringify({ jobs: input.failed_jobs.map(job => ({ job_id: job.job_id, ...classifyOutput(job) })) }) };
    if (reply.status) { res.writeHead(reply.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture outage' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...reply } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
