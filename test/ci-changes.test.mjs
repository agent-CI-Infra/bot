import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { testPassword } from './helpers.mjs';
import { managementFixture, query } from './management-fixture.mjs';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { GitHub } from '../dist/github/client.js';
import { githubWrite } from '../dist/github/write.js';
import { pullRequestPermissions } from '../dist/tasks/pull-request.js';
import { managerPrompt, parseSections } from '../dist/work/settings.js';

// CI changes are bot pull requests that people review and merge (#931): only a development a project administrator
// confirmed as a CI change pushes with the Workflows permission; github_write never has it.

// A GitHub App installation that grants `granted`, and a GitHub that records every request. `extra` is added to every
// token GitHub returns, as if it granted more than was asked for.
async function appFixture(t, granted, extra = {}) {
  const requests = [], tokens = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    requests.push(`${req.method} ${path}`);
    if (path === '/repos/fixture/r/installation') return send({ id: 55, account: { id: 1 }, permissions: { metadata: 'read', ...granted } });
    if (path === '/app/installations/55/access_tokens') {
      const body = JSON.parse(raw); tokens.push(body.permissions);
      return send({ token: 'ghs_' + randomBytes(12).toString('hex'), expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { ...body.permissions, ...extra } }, 201);
    }
    if (path === '/repositories/r') return send({ id: 'r', owner: { id: 1 }, full_name: 'fixture/r', default_branch: 'main' });
    if (path === '/repos/fixture/r/git/refs' && req.method === 'POST') return send({ ref: JSON.parse(raw).ref, object: { sha: 'a'.repeat(40), type: 'commit' } }, 201);
    return send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const store = new Store(':memory:', Buffer.alloc(32, 7)); t.after(() => store.close());
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  store.run("INSERT INTO accounts VALUES('a','fixture','github_app','123',?,'now')", store.secrets.seal({ private_key: privateKey }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')"); store.run("INSERT INTO policies(repository_id,enabled,capability_ceiling) VALUES('r',1,'develop')");
  const repository = store.get("SELECT * FROM repositories WHERE id='r'"), apiUrl = 'http://127.0.0.1:' + server.address().port;
  // The caller's own permission allows every write: only the rules under test refuse.
  const write = args => githubWrite({ store, repository, redactor: new Redactor(), guard: async () => {}, apiUrl, scope: 'test', actor: { kind: 'manager', role: 'manager' }, allowed: () => true }, args);
  return { store, repository, apiUrl, requests, tokens, write };
}

test('github_write refuses .github/workflows/ before anything reaches GitHub, and never asks for Workflows', async t => {
  const f = await appFixture(t, { contents: 'write', pull_requests: 'write', issues: 'write', workflows: 'write' });
  const file = { message: 'ci', content: Buffer.from('on: push\n').toString('base64') };
  // A file write, a deletion, and the same path encoded or in other case: each is the workflow directory GitHub sees.
  for (const [method, path] of [['PUT', '/contents/.github/workflows/ci.yml'], ['DELETE', '/contents/.github/workflows/ci.yml'], ['PUT', '/contents/.github/workflows'],
    ['PUT', '/contents/%2Egithub/workflows/ci.yml'], ['PUT', '/contents/.github/%77orkflows/ci.yml'], ['PUT', '/contents/.GitHub/Workflows/ci.yml']]) {
    const result = await f.write({ method, path, key: method + path, ...(method === 'PUT' ? { body: file } : { body: { message: 'ci', sha: 'b'.repeat(40) } }) });
    assert.equal(result.error, 'github_workflow_write_forbidden', `${method} ${path}`); assert.match(result.detail, /bot pull request/);
  }
  assert.deepEqual(f.requests, [], 'nothing reached GitHub, not even a token request');
  // Other files under .github/ are ordinary Contents writes.
  assert.notEqual((await f.write({ method: 'PUT', path: '/contents/.github/CODEOWNERS', key: 'owners', body: file })).error, 'github_workflow_write_forbidden');

  // A ref update is the other way to change a workflow: its token has Contents only, though the installation grants
  // Workflows, so GitHub itself refuses a commit that changes .github/workflows/.
  f.tokens.length = 0;
  const ref = await f.write({ method: 'POST', path: '/git/refs', key: 'ref', body: { ref: 'refs/heads/ci', sha: 'a'.repeat(40) } });
  assert.equal(ref.status, 201, JSON.stringify(ref));
  assert.deepEqual(f.tokens, [{ contents: 'write', metadata: 'read' }]);
  assert.ok(f.store.all("SELECT action FROM audit WHERE action LIKE 'github.write.%'").length > 0);
  assert.deepEqual(f.store.all("SELECT state,error FROM github_writes WHERE error='github_workflow_write_forbidden'").length, 6);
});

test('github_write refuses a token GitHub returns with Workflows', async t => {
  const f = await appFixture(t, { contents: 'write', workflows: 'write' }, { workflows: 'write' });
  const ref = await f.write({ method: 'POST', path: '/git/refs', key: 'ref', body: { ref: 'refs/heads/ci', sha: 'a'.repeat(40) } });
  assert.equal(ref.error, 'github_write_token_scope_invalid');
  assert.ok(!f.requests.includes('POST /repos/fixture/r/git/refs'), 'nothing was sent with that token');
});

test('only a task a person confirmed as a CI change publishes with Workflows, and only where the installation grants it', async t => {
  const task = workflow_changes => ({ input: JSON.stringify({ request: 'Change CI', contract: { endpoint: 'reviewable_pull_request' }, ...(workflow_changes ? { workflow_changes } : {}) }) });
  assert.equal(pullRequestPermissions(task()), undefined);
  // The control plane writes workflow_changes with the person who confirmed it; anything else is not a confirmation.
  assert.equal(pullRequestPermissions(task({ confirmed_at: 'now' })), undefined);
  const confirmed = pullRequestPermissions(task({ confirmed_by: 'u1', confirmed_at: 'now' }));
  assert.deepEqual(confirmed, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' });
  for (const [granted, expected] of [[{ contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }],
    [{ contents: 'write', issues: 'write', pull_requests: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }]]) {
    const f = await appFixture(t, granted), github = new GitHub(f.store, f.repository, new Redactor(), async () => {}, f.apiUrl);
    await github.connect(true, undefined, confirmed, false);
    assert.deepEqual(f.tokens, [expected]);
  }
  // The usual development token, which every other task pushes with.
  const f = await appFixture(t, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }), github = new GitHub(f.store, f.repository, new Redactor(), async () => {}, f.apiUrl);
  await github.connect(true, undefined, pullRequestPermissions(task()), false);
  assert.deepEqual(f.tokens, [{ contents: 'write', issues: 'write', pull_requests: 'write' }]);
});

test('a project administrator confirms a CI change in the console; members, reports and assistants cannot', async t => {
  const { h, admin } = await managementFixture(t);
  h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");
  const contract = endpoint => ({ goal: 'Run the tests on Node 22', scope: ['.github/workflows/ci.yml'], criteria: ['CI runs on Node 22'], endpoint });
  const create = (client, body) => client('/api/tasks', 'POST', { repository_id: '101', request: 'Move CI to Node 22', ...body });
  const confirmed = await create(admin, { intent: 'development', contract: contract('reviewable_pull_request'), workflow_changes: true });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.value));
  const input = JSON.parse(h.store.get('SELECT input FROM tasks WHERE id=?', confirmed.value.id).input);
  assert.ok(input.workflow_changes.confirmed_by); assert.ok(input.workflow_changes.confirmed_at);
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='task.workflow_changes' AND resource_id=?", confirmed.value.id).n, 1);
  // Only a code PR can change workflows; the flag is a boolean.
  assert.equal((await create(admin, { intent: 'report', contract: contract('report'), workflow_changes: true })).value.error, 'invalid_workflow_changes');
  assert.equal((await create(admin, { intent: 'development', contract: contract('reviewable_pull_request'), workflow_changes: 'yes' })).status, 400);
  const plain = await create(admin, { intent: 'development', contract: contract('reviewable_pull_request') });
  assert.equal(plain.status, 201); assert.equal(JSON.parse(h.store.get('SELECT input FROM tasks WHERE id=?', plain.value.id).input).workflow_changes, undefined);

  // A member who may create tasks but not configure the project.
  const password = testPassword(), user = (await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] })).value.user;
  const principal = h.store.get('SELECT id FROM principals WHERE user_id=?', user.id).id, tenant = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  assert.equal((await admin('/api/identity/grants', 'POST', { principal_id: principal, tenant_id: tenant, project_id: '101', capabilities: ['tasks.read', 'tasks.write'] })).status, 201);
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  const refused = await create(member, { intent: 'development', contract: contract('reviewable_pull_request'), workflow_changes: true });
  assert.equal(refused.status, 403, JSON.stringify(refused.value));
  assert.equal((await create(member, { intent: 'development', contract: contract('reviewable_pull_request') })).status, 201);
  // The console offers the checkbox only to who may tick it.
  assert.equal((await query(admin, 'get_effective_config', { project_id: '101' })).value.task_creation.workflow_changes, true);
  assert.equal((await query(member, 'get_effective_config', { project_id: '101' })).value.task_creation.workflow_changes, false);

  // Through management commands: the console's new-task page is a person; any other source (an assistant's conversation,
  // a group chat) cannot confirm a CI change, even for an administrator.
  const command = async (source, key) => admin('/api/management/commands', 'POST', { operation: 'task.create', target: { project_id: '101' },
    arguments: { request: 'Move CI to Node 22', contract: contract('reviewable_pull_request'), intent: 'development', workflow_changes: true },
    expected_revision: (await query(admin, 'get_effective_config', { project_id: '101' })).value.revision, idempotency_key: key, source_conversation: source, source_message: key });
  const fromAssistant = await command('assistant-conversation', 'assistant');
  assert.equal(fromAssistant.value.error ?? fromAssistant.value.result?.error, 'workflow_changes_need_person', JSON.stringify(fromAssistant.value));
  const fromConsole = await command('console:new-task', 'console');
  assert.equal(fromConsole.value.state, 'succeeded', JSON.stringify(fromConsole.value));
  assert.ok(JSON.parse(h.store.get('SELECT input FROM tasks WHERE id=?', fromConsole.value.result.id).input).workflow_changes.confirmed_by);
});

test('the gate onboarding addresses answer 410 with what replaces them', async t => {
  const { admin } = await managementFixture(t);
  for (const [method, path] of [['GET', '/api/projects/101/gate-onboarding'], ['POST', '/api/projects/101/gate-onboarding'], ['GET', '/api/gate-onboarding/abc/messages'], ['POST', '/api/gate-onboarding/abc/confirm']]) {
    const result = await admin(path, method, method === 'POST' ? {} : undefined);
    assert.equal(result.status, 410, `${method} ${path}`); assert.equal(result.value.error, 'gate_onboarding_removed'); assert.match(result.value.detail, /开发任务/);
  }
});

test('upgrading ends unfinished gate onboarding tasks and drops its settings, sessions and Manager section; history still reads', t => {
  const directory = mkdtempSync(join(tmpdir(), 'retired-')), database = join(directory, 'control.sqlite'), key = randomBytes(32);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(database, key);
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')"); store.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");
  store.run(`INSERT INTO policies(repository_id,enabled,work_settings,task_models) VALUES('r',1,?,?)`,
    JSON.stringify({ 'gate.onboarding': { enabled: true }, 'review.pr': { enabled: true } }), JSON.stringify({ 'gate.onboarding': 'm1', 'review.pr': 'm2' }));
  const old = '## 检视 PR `review.pr`\n\nRead the diff.\n\n## 接入门禁 `gate.onboarding`\n\nDesign the gates.\n';
  store.run("INSERT INTO manager_revisions VALUES('r',1,?,'{}','{}','console',NULL,'now')", old);
  const now = new Date().toISOString();
  for (const [id, status] of [['open', 'queued'], ['waiting', 'waiting_environment'], ['done', 'succeeded']])
    store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,created_at,updated_at) VALUES(?,'r','gate.onboarding',?,'Gate turn',?,?)", id, status, now, now);
  // What an older version kept for gate onboarding conversations and the one-click runs before them.
  store.db.exec("CREATE TABLE gate_onboarding_sessions(id TEXT PRIMARY KEY,repository_id TEXT); INSERT INTO gate_onboarding_sessions VALUES('s','r'); CREATE TABLE quickstart_runs(id TEXT PRIMARY KEY)");
  store.close(); store = new Store(database, key); t.after(() => store.close());

  assert.deepEqual(store.all("SELECT id,status,error_code FROM tasks ORDER BY id").map(row => [row.id, row.status, row.error_code]),
    [['done', 'succeeded', null], ['open', 'cancelled', 'work_removed'], ['waiting', 'cancelled', 'work_removed']]);
  const policy = store.get("SELECT work_settings,task_models FROM policies WHERE repository_id='r'");
  assert.ok(!('gate.onboarding' in JSON.parse(policy.work_settings))); assert.deepEqual(JSON.parse(policy.work_settings)['review.pr'], { enabled: true });
  assert.deepEqual(JSON.parse(policy.task_models), { 'review.pr': 'm2' });
  assert.ok(!store.hasTable('gate_onboarding_sessions') && !store.hasTable('quickstart_runs'));
  // The section goes in a new revision; the older one is kept and still parses.
  const prompt = managerPrompt(store, 'r');
  assert.equal(prompt.revision, 2); assert.equal(prompt.source, 'upgrade'); assert.doesNotMatch(prompt.content, /gate\.onboarding|接入门禁/); assert.match(prompt.content, /Read the diff\./);
  assert.deepEqual([...parseSections(store.get("SELECT content FROM manager_revisions WHERE repository_id='r' AND revision=1").content).sections.keys()], ['review.pr']);
  // Once.
  store.close(); store = new Store(database, key);
  assert.equal(store.get("SELECT max(revision) n FROM manager_revisions WHERE repository_id='r'").n, 2);
});
