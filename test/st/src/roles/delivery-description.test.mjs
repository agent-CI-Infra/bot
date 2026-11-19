// #1106: in the team path the developer's submitted summary is the pull request description. Both tools say what the text
// becomes, the Manager sees the developer's text where it nominates, and a nomination without summary publishes it unchanged.
process.env.BOT_HARNESS_MODEL_TRANSPORT = 'gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { developmentTeam } from '../../../../dist/roles/development.js';
import { roleApi } from '../../../../dist/roles/api.js';

const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const receipts = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')));
const parameter = (body, tool, name) => body.tools.find(t => t.function.name === tool)?.function.parameters.properties[name];
const devText = '## What changed\n\nThe fixture file now says delivered.\n\n## Verification\n\n`printf ok` printed ok.\n\n## Risk\n\nNone known.';

async function fixture(t, respond) {
  const root = mkdtempSync(join(tmpdir(), 'bot-delivery-text-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root), bodies = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: respond(body) }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(async () => { await manager.recover(); await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); }); store.close(); rmSync(root, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('101','fixture/text','o','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  const environment = await manager.call('PUT', '/v1/projects/101');
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)', 't', '101', 'development.issue', 'running', 'text fixture', '{}', 1, environment.generation, randomBytes(24).toString('hex'));
  new TaskRecords(store).contract('t', { goal: 'Say delivered', scope: ['fixture.txt'], criteria: ['The file says delivered'], endpoint: 'reviewable_pull_request' });
  roleApi(store, { id: 'owner', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), { expected_revision: 0, enabled: true, controller: { entries: { development: true } }, roles: ['manager', 'dev', 'qa'].map(role_id => ({ role_id, harness_ref: { id: 'native' } })) });
  const task = store.get("SELECT * FROM tasks WHERE id='t'"), workspace = new Workspace(store, manager, task, new Redactor(), async () => {}, () => {});
  await workspace.call('init', { type: 'workspace_init' });
  await workspace.write('seed-write', 'fixture.txt', Buffer.from('baseline\n'));
  assert.equal((await workspace.call('seed-commit', { type: 'workspace_command', command: 'git init -q && git add fixture.txt && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm baseline', timeout_ms: 10000 })).exit_code, 0);
  const published = [];
  const run = () => developmentTeam(workspace, 'Implement', '{}', async (_, candidate) => { published.push(candidate); return { pr: { number: 1 } }; }, { read: true, write: true, shell: true });
  return { store, bodies, published, run };
}

test('a nomination without summary publishes the developer\'s text, which the Manager sees where it nominates', { timeout: 90000 }, async t => {
  let round = 0;
  // The Manager keeps its session between runs: each run's input is its latest user message.
  const input = body => JSON.parse(body.messages.findLast(m => m.role === 'user').content);
  const f = await fixture(t, body => {
    if (body.tools.some(t => t.function.name === 'nominate_delivery')) {
      if (round === 2) return call('nominate_delivery', { result_ref: input(body).latest_dev_result.ref });
      const done = receipts(body).find(r => r.result_ref);
      return done ? call('nominate_delivery', { result_ref: done.result_ref }) : call('delegate_role', { role: 'dev', purpose: 'Make the file say delivered', refs: [] });
    }
    return body.messages.at(-1).role === 'tool' ? call('submit_delivery', { summary: devText, test_command: 'printf ok', change_title: 'Say delivered' })
      : call('write_file', { path: 'fixture.txt', content: 'delivered\n' });
  });
  round = 1; await f.run();
  const managers = f.bodies.filter(body => body.tools.some(t => t.function.name === 'nominate_delivery')), developer = f.bodies.find(body => body.tools.some(t => t.function.name === 'submit_delivery'));
  // The developer is told its summary is the public pull request description, and what the platform adds.
  assert.match(parameter(developer, 'submit_delivery', 'summary').description, /^The public pull request description on GitHub/);
  assert.match(parameter(developer, 'submit_delivery', 'summary').description, /development_basis[\s\S]*Markdown in the repository's language[\s\S]*No internal references such as task_history:…[\s\S]*no Closes\/Fixes, Tests or Commit lines/);
  assert.match(parameter(developer, 'submit_delivery', 'change_title').description, /pull request title/);
  // The Manager is told an omitted summary keeps the nominated text, and gets that text from delegate_role.
  assert.match(parameter(managers[0], 'nominate_delivery', 'summary').description, /^Optional\. Leave it out to publish the summary of the result you nominate exactly as the developer wrote it; that is the default\.[\s\S]*keep its language and structure/);
  const receipt = receipts(managers.at(-1)).find(r => r.result_ref);
  assert.equal(receipt.summary, devText); assert.equal(receipt.change_title, 'Say delivered');
  assert.equal(input(managers[0]).latest_dev_result, undefined);
  assert.deepEqual(f.published.map(c => [c.summary, c.change_title]), [[devText, 'Say delivered']]);
  // A later Manager run reads the developer's latest text in its input and can nominate it as it is.
  round = 2; const before = f.bodies.length; await f.run();
  const later = input(f.bodies.slice(before).find(body => body.tools.some(t => t.function.name === 'nominate_delivery'))).latest_dev_result;
  assert.deepEqual(later, { ref: receipt.result_ref, summary: devText, change_title: 'Say delivered' });
  assert.equal(f.published.length, 2); assert.equal(f.published[1].summary, devText);
});
