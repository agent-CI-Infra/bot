import { eventWork as eventWorkflow } from '../dist/work/events.js';
import { workPermissions as workflowPermissions } from '../dist/work/settings.js';
import { selectedModel } from '../dist/agent/model.js';
import { Redactor } from '../dist/agent/common.js';
import { runAgent } from '../dist/agent/runtime.js';
import { workspaceProfile } from '../dist/agent/profiles.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { RepositoryExplorer } from '../dist/agent/exploration.js';
import { GitHub } from '../dist/github/client.js';
import '../dist/releases/observe.js';
import '../dist/releases/notes.js';
import '../dist/actions/analysis.js';
import '../dist/projects/gate-onboarding.js';

// Plays the project computer for event workflow tasks (CI observation, release notes, Actions failure analysis, gate onboarding), the
// way the engine runs them: the model must be configured, the module prepares the task and checks it still applies,
// the agent calls the module's tools and finishes, and the module takes the result. `agent({ task, input, target,
// tools })` returns the finishing tool's arguments, or { wait: code } for a model that does not answer (the task waits),
// or throws a TaskError-like { code, state } to end the task. `github(task)` gives a connected client when prepare needs one.
// Returns how many tasks it ran, waited or ended.
export async function runEventTasks(store, kind, agent, { github } = {}) {
  let ran = 0;
  for (const task of store.all("SELECT * FROM tasks WHERE kind=? AND status IN ('queued','retry_wait','waiting_configuration') ORDER BY created_at,rowid", kind)) {
    const workflow = eventWorkflow(kind), input = JSON.parse(task.input), state = {};
    const end = (status, code, detail) => { store.run('UPDATE tasks SET status=?,error_code=? WHERE id=?', status, code, task.id); if (['failed', 'cancelled'].includes(status)) workflow.ended?.(store, task, code, detail); };
    try { selectedModel(store, task.repository_id, kind); } catch (error) { end(error.state || 'waiting_configuration', error.code); ran++; continue; }
    try {
      workflow.validate(store, task, input);
      const target = await workflow.prepare(store, github ? await github(task) : null, task, input, new Redactor());
      const tools = workflow.tools?.(store, task, input, workflowPermissions(store, task.repository_id, kind).writes, state) ?? {};
      const result = await agent({ task, input, target, tools });
      if (result?.wait) { end('retry_wait', result.wait); ran++; continue; }
      const kept = await workflow.finish(store, task, input, result, state);
      store.run("UPDATE tasks SET status='succeeded',phase='done',error_code=NULL,result=?,input=? WHERE id=?", JSON.stringify(kept), JSON.stringify(input), task.id); ran++;
    } catch (error) { if (!error.code) throw error; end(error.state === 'cancelled' ? 'cancelled' : 'failed', error.code, error.detail); ran++; }
  }
  return ran;
}

// A GitHub client for a release task's preparation, connected as the release module connects.
export const releaseGitHub = (store, apiUrl) => async task => {
  const client = new GitHub(store, store.get('SELECT * FROM repositories WHERE id=?', task.repository_id), new Redactor(), async () => {}, apiUrl);
  await client.connect(false, { contents: 'read', actions: 'read' }, undefined, false); return client;
};
// The CI observation agent, played by the control plane's own loop: the model gateway and the repository tools that the
// project computer's requests reach, with the release.observe workflow's profile. The model answers with its final JSON.
export const observationAgent = (store, apiUrl) => async ({ task, input, target }) => {
  const redactor = new Redactor(), guard = async () => eventWorkflow('release.observe').validate(store, task, input);
  const permissions = workflowPermissions(store, task.repository_id, 'release.observe'), profile = workspaceProfile('release.observe', target.context, permissions);
  const tokens = new ReadTokens(store, store.get('SELECT * FROM repositories WHERE id=?', task.repository_id), redactor, guard, apiUrl, permissions.github), explorer = new RepositoryExplorer(tokens, redactor, guard);
  try {
    const value = await runAgent({ store, task, redactor, guard, system: profile.system, prompt: JSON.stringify(target.context), tools: profile.tools, maxTurns: 16,
      execute: (name, args) => explorer.execute(name, args), validate: content => JSON.parse(content) });
    return { ...value, read_logs: explorer.logs };
  } finally { await tokens.revoke(); }
};
