import { eventWork as eventWorkflow } from '../../dist/tasks/event-adapters.js';
import { taskPermissions } from '../../dist/tasks/configuration.js';
import { selectedModel } from '../../dist/agent/model.js';
import { Redactor } from '../../dist/agent/common.js';
import { runAgent } from '../../dist/agent/runtime.js';
import { roleHarness } from '../../dist/roles/harness.js';
import { resultSpec } from '../../dist/agent/tool-results.js';
import { scriptedHarness } from './scripted-driver.mjs';
import { workspaceProfile } from '../../dist/agent/profiles.js';
import { ReadTokens } from '../../dist/agent/read-token.js';
import { RepositoryExplorer } from '../../dist/agent/exploration.js';
import { GitHub } from '../../dist/github/client.js';
import '../../dist/releases/observe.js';
import '../../dist/releases/notes.js';
import '../../dist/actions/analysis.js';

export async function runEventTasks(store, kind, agent, { github } = {}) {
  let ran = 0;
  for (const task of store.all("SELECT * FROM tasks WHERE (kind=? OR (kind='task.request' AND json_extract(input,'$.event_adapter')=?)) AND status IN ('queued','retry_wait','waiting_configuration') ORDER BY created_at,rowid", kind, kind)) {
    const workflow = eventWorkflow(kind), input = JSON.parse(task.input), state = {};
    const end = (status, code, detail) => { store.run('UPDATE tasks SET status=?,error_code=? WHERE id=?', status, code, task.id); if (['failed', 'cancelled'].includes(status)) workflow.ended?.(store, task, code, detail); };
    try { selectedModel(store, task.repository_id); } catch (error) { end(error.state || 'waiting_configuration', error.code); ran++; continue; }
    try {
      workflow.validate(store, task, input);
      const target = await workflow.prepare(store, github ? await github(task) : null, task, input, new Redactor());
      const tools = workflow.tools?.(store, task, input, taskPermissions(store, task).writes, state) ?? {};
      const result = await agent({ task, input, target, tools });
      if (result?.wait) { end('retry_wait', result.wait); ran++; continue; }
      const kept = await workflow.finish(store, task, input, result, state);
      store.run("UPDATE tasks SET status='succeeded',phase='done',error_code=NULL,result=?,input=? WHERE id=?", JSON.stringify(kept), JSON.stringify(input), task.id); ran++;
    } catch (error) { if (!error.code) throw error; end(error.state === 'cancelled' ? 'cancelled' : 'failed', error.code, error.detail); ran++; }
  }
  return ran;
}

export const releaseGitHub = (store, apiUrl) => async task => {
  const client = new GitHub(store, store.get('SELECT * FROM repositories WHERE id=?', task.repository_id), new Redactor(), async () => {}, apiUrl);
  await client.connect(false, { contents: 'read', actions: 'read' }, undefined, false); return client;
};

export const observationAgent = (store, apiUrl) => async ({ task, input, target }) => {
  const redactor = new Redactor(), guard = async () => eventWorkflow('release.observe').validate(store, task, input);
  const permissions = taskPermissions(store, task), profile = workspaceProfile('release.observe', target.context, permissions);
  const tokens = new ReadTokens(store, store.get('SELECT * FROM repositories WHERE id=?', task.repository_id), redactor, guard, apiUrl, permissions.github), explorer = new RepositoryExplorer(tokens, redactor, guard);
  try {
    // The observation agent's tool exchange runs on the in-process scripted driver (#1257: runAgent needs a transport).
    // resultSpec first, as runAgent would: results over their bound are saved as files before the driver sees them.
    const spec = resultSpec({ store, task, redactor, guard, system: profile.system, prompt: JSON.stringify(target.context), tools: profile.tools, maxTurns: 16,
      execute: (name, args) => explorer.execute(name, args), validate: content => JSON.parse(content) });
    const value = await runAgent({ ...spec, adapter: roleHarness(scriptedHarness).adapter(spec) });
    return { ...value, read_logs: explorer.logs };
  } finally { await tokens.revoke(); }
};
