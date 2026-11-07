import { createServer } from 'node:http';
import { server as github } from './agent-server.mjs';
// The fake GitHub of agent-server.mjs plus a scripted model for an ordinary task under the project controller: the
// controller (real Pi in the project computer) delegates dev, reads its result, tries forbidden calls and nominates;
// dev writes a report and submits it; independent QA reads the report and passes it.
const handle = github.listeners('request')[0];
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const results = messages => messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(text(m.content)); } catch { return { raw: text(m.content) }; } });
const call = (name, args) => ({ id: 'call-' + Math.random().toString(16).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } });
const state = { requests: [], delays: { dev: 0 }, steps: {} };
function controller(messages, key) {
  const done = results(messages), ref = done.find(r => r.result_ref)?.result_ref, steps = state.steps[key] ??= {};
  if (!ref) return call('delegate_role', { role: 'dev', purpose: 'Write the requested report', refs: ['task:' + key] });
  if (!done.some(r => r.content)) return call('read_task_record', { ref });
  if (!steps.write) { steps.write = true; return call('write_file', { path: 'report.md', content: 'controller edit' }); }
  if (!steps.qa) { steps.qa = true; return call('delegate_role', { role: 'qa', purpose: 'Approve the delivery', refs: [] }); }
  if (!steps.scope) { steps.scope = true; return call('delegate_role', { role: 'dev', purpose: 'Publish it', refs: [], permissions: { publish: true } }); }
  return call('nominate_delivery', { result_ref: ref });
}
async function model(body) {
  const system = text(body.messages[0]?.content), user = text(body.messages.find(m => m.role === 'user')?.content), names = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(c => c.function.name);
  const task = /"task_id":"([a-f0-9]{48})"/.exec(user)?.[1] ?? 'unknown';
  state.requests.push({ role: system.includes('Coordinate only.') ? 'controller' : system.includes('independent delivery acceptance evaluator') ? 'qa' : 'dev', task, tools: (body.tools || []).map(t => t.function.name), model: body.model });
  if (system.includes('Coordinate only.')) return controller(body.messages, task);
  if (system.includes('independent delivery acceptance evaluator')) {
    if (!names.includes('read_file')) return call('read_file', { path: 'report.md' });
    return call('submit_acceptance', { outcome: 'pass', reason: 'The report exists in the candidate and states the requested fact.', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true });
  }
  if (state.delays.dev) await new Promise(resolve => setTimeout(resolve, state.delays.dev));
  if (!names.includes('write_file')) return call('write_file', { path: 'report.md', content: '# Report\n\nThe add function lives in calc.mjs.\n' });
  return call('submit_delivery', { summary: 'Report written', artifacts: [{ path: 'report.md', description: 'The requested report' }], evidence: [], unknowns: [] });
}
const server = createServer(async (req, res) => {
  if (req.url === '/fixture/pi-state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state)); return; }
  if (req.url === '/fixture/pi-delay' && req.method === 'POST') { let raw = ''; for await (const c of req) raw += c; Object.assign(state.delays, JSON.parse(raw)); res.writeHead(200); res.end('{}'); return; }
  if (req.url !== '/pi-model/chat/completions') return handle(req, res);
  let raw = ''; for await (const c of req) raw += c;
  const message = await model(JSON.parse(raw));
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [message] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
});
server.listen(9100, '0.0.0.0');
