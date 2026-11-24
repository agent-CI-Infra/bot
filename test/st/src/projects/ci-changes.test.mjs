import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPassword } from '../../../fixtures/helpers.mjs';
import { managementFixture, query } from '../../../fixtures/management-fixture.mjs';
import { Store } from '../../../../dist/storage/database.js';
import { blobSha, Redactor, treeSha } from '../../../../dist/agent/common.js';
import { GitHub } from '../../../../dist/github/client.js';
import { githubWrite } from '../../../../dist/github/write.js';
import { pullRequestPermissions, publishRequestPullRequest, requestPolicyHash } from '../../../../dist/tasks/pull-request.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { managerPrompt } from '../../../../dist/dispatch/settings.js';
import { roleConfiguration } from '../../../../dist/roles/definition.js';

// CI changes are bot pull requests that people review and merge (#931, #1269): any PR-capable development task may
// modify `.github/workflows/` and requests `workflows: write` on demand when pushing its bot branch; `github_write`
// still never modifies workflows.

// A GitHub App installation that grants `granted`, and a GitHub that records every request. `extra` is added to every
// token GitHub returns, as if it granted more than was asked for.
async function appFixture(t, granted, extra = {}) {
  const requests = [], tokens = [], revokedTokens = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    requests.push(`${req.method} ${path}`);
    if (path === '/repos/fixture/r/installation') return send({ id: 55, account: { id: 1 }, permissions: { metadata: 'read', ...granted } });
    if (path === '/app/installations/55/access_tokens') {
      const body = JSON.parse(raw); tokens.push(body.permissions);
      return send({ token: 'ghs_' + randomBytes(12).toString('hex'), expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { ...body.permissions, ...extra } }, 201);
    }
    if (path === '/installation/token' && req.method === 'DELETE') {
      revokedTokens.push(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      res.writeHead(204); return res.end();
    }
    if (path === '/repositories/r') return send({ id: 'r', owner: { id: 1 }, full_name: 'fixture/r', default_branch: 'main' });
    if (path === '/app') return send({ slug: 'fixture-bot' });
    if (path === '/users/fixture-bot%5Bbot%5D') return send({ id: 901, login: 'fixture-bot[bot]' });
    if (path === '/repos/fixture/r/git/blobs' && req.method === 'POST') return send({ sha: blobSha(Buffer.from(JSON.parse(raw).content, 'base64')) }, 201);
    if (path === '/repos/fixture/r/git/trees' && req.method === 'POST') {
      const body = JSON.parse(raw);
      return send({ sha: body.tree ? treeSha(body.tree.filter(entry => entry.sha !== null)) : 'e'.repeat(40) }, 201);
    }
    if (path === '/repos/fixture/r/git/commits' && req.method === 'POST') {
      const body = JSON.parse(raw);
      return send({ sha: 'c'.repeat(40), tree: { sha: body.tree } }, 201);
    }
    if (path === '/repos/fixture/r/git/refs' && req.method === 'POST') {
      const body = JSON.parse(raw);
      return send({ ref: body.ref, object: { sha: body.sha || 'a'.repeat(40), type: 'commit' } }, 201);
    }
    if (path.startsWith('/repos/fixture/r/git/ref/heads/') && req.method === 'GET') {
      return send({ ref: 'refs/heads/' + path.slice('/repos/fixture/r/git/ref/heads/'.length), object: { sha: 'c'.repeat(40), type: 'commit' } });
    }
    if (path === '/repos/fixture/r/pulls' && req.method === 'POST') {
      const body = JSON.parse(raw);
      return send({
        id: 701,
        number: 12,
        html_url: 'https://github.invalid/fixture/r/pull/12',
        title: body.title,
        body: body.body,
        user: { id: 901 },
        head: { ref: body.head, sha: 'c'.repeat(40), repo: { id: 'r' } },
      }, 201);
    }
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
  return { store, repository, apiUrl, requests, tokens, revokedTokens, write };
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

test('pullRequestPermissions requests Workflows only when candidate actually modifies .github/workflows/', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: '1'.repeat(40) };
  const codeBase = { path: 'src/app.ts', mode: '100644', sha: '2'.repeat(40) };
  const codeNew = { path: 'src/app.ts', mode: '100644', sha: '3'.repeat(40) };
  const wfNew = { path: '.github/workflows/ci.yml', mode: '100644', sha: '4'.repeat(40) };

  assert.equal(pullRequestPermissions(null), undefined);
  assert.equal(pullRequestPermissions({ files: [wfBase, codeNew], snapshot_files: [wfBase, codeBase] }), undefined);
  const withWf = pullRequestPermissions({ files: [wfNew, codeBase], snapshot_files: [wfBase, codeBase] });
  assert.deepEqual(withWf, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' });

  for (const [granted, expected] of [
    [{ contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }],
    [{ contents: 'write', issues: 'write', pull_requests: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }],
  ]) {
    const f = await appFixture(t, granted), github = new GitHub(f.store, f.repository, new Redactor(), async () => {}, f.apiUrl);
    await github.connect(true, undefined, withWf, false);
    assert.deepEqual(f.tokens, [expected]);
  }
  const f = await appFixture(t, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }), github = new GitHub(f.store, f.repository, new Redactor(), async () => {}, f.apiUrl);
  await github.connect(true, undefined, pullRequestPermissions({ files: [wfBase, codeNew], snapshot_files: [wfBase, codeBase] }), false);
  assert.deepEqual(f.tokens, [{ contents: 'write', issues: 'write', pull_requests: 'write' }]);
});

test('task creation requires no workflow_changes confirmation and smoothly ignores legacy boolean workflow_changes', async t => {
  const { h, admin } = await managementFixture(t);
  h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");
  const contract = endpoint => ({ goal: 'Run the tests on Node 22', scope: ['.github/workflows/ci.yml'], criteria: ['CI runs on Node 22'], endpoint });
  const create = (client, body) => client('/api/tasks', 'POST', { repository_id: '101', request: 'Move CI to Node 22', ...body });

  // Legacy boolean workflow_changes is accepted and ignored without persisting confirmation or extra audit rows.
  const legacy = await create(admin, { intent: 'development', contract: contract('reviewable_pull_request'), workflow_changes: true });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.value));
  const input = JSON.parse(h.store.get('SELECT input FROM tasks WHERE id=?', legacy.value.id).input);
  assert.equal(input.workflow_changes, undefined);
  assert.equal(h.store.get("SELECT count(*) n FROM audit WHERE action='task.workflow_changes' AND resource_id=?", legacy.value.id).n, 0);
  assert.equal((await create(admin, { intent: 'development', contract: contract('reviewable_pull_request'), workflow_changes: 'yes' })).status, 400);

  // Project member with tasks.write (no config.write) can create CI development tasks directly.
  const password = testPassword(), user = (await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] })).value.user;
  const principal = h.store.get('SELECT id FROM principals WHERE user_id=?', user.id).id, tenant = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  assert.equal((await admin('/api/identity/grants', 'POST', { principal_id: principal, tenant_id: tenant, project_id: '101', capabilities: ['tasks.read', 'tasks.write'] })).status, 201);
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await create(member, { intent: 'development', contract: contract('reviewable_pull_request'), workflow_changes: true })).status, 201);
  assert.equal((await create(member, { intent: 'development', contract: contract('reviewable_pull_request') })).status, 201);

  // get_effective_config no longer exposes task_creation.workflow_changes.
  assert.deepEqual((await query(admin, 'get_effective_config', { project_id: '101' })).value.task_creation, { allowed: true, reason: null });
  assert.deepEqual((await query(member, 'get_effective_config', { project_id: '101' })).value.task_creation, { allowed: true, reason: null });

  // Management commands from non-console conversations (such as assistant or group chat) also succeed directly.
  const command = async (source, key, extra = {}) => admin('/api/management/commands', 'POST', { operation: 'task.create', target: { project_id: '101' },
    arguments: { request: 'Move CI to Node 22', contract: contract('reviewable_pull_request'), intent: 'development', ...extra },
    expected_revision: (await query(admin, 'get_effective_config', { project_id: '101' })).value.revision, idempotency_key: key, source_conversation: source, source_message: key });
  const fromAssistant = await command('assistant-conversation', 'assistant', { workflow_changes: true });
  assert.equal(fromAssistant.value.state, 'succeeded', JSON.stringify(fromAssistant.value));
  assert.equal(JSON.parse(h.store.get('SELECT input FROM tasks WHERE id=?', fromAssistant.value.result.id).input).workflow_changes, undefined);
  const fromConsole = await command('console:new-task', 'console');
  assert.equal(fromConsole.value.state, 'succeeded', JSON.stringify(fromConsole.value));
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
  store.db.exec("CREATE TABLE gate_onboarding_sessions(id TEXT PRIMARY KEY,repository_id TEXT); INSERT INTO gate_onboarding_sessions VALUES('s','r'); CREATE TABLE quickstart_runs(id TEXT PRIMARY KEY)");
  store.close(); store = new Store(database, key); t.after(() => store.close());

  assert.deepEqual(store.all("SELECT id,status,error_code FROM tasks ORDER BY id").map(row => [row.id, row.status, row.error_code]),
    [['done', 'succeeded', null], ['open', 'cancelled', 'work_removed'], ['waiting', 'cancelled', 'work_removed']]);
  const policy = store.get("SELECT work_settings,task_models FROM policies WHERE repository_id='r'");
  assert.deepEqual(JSON.parse(policy.work_settings), {});
  assert.deepEqual(JSON.parse(policy.task_models), {});
  assert.ok(!store.hasTable('gate_onboarding_sessions') && !store.hasTable('quickstart_runs'));
  const prompt = managerPrompt(store, 'r');
  assert.doesNotMatch(prompt.content, /gate\.onboarding|接入门禁/);
  const reviewer = roleConfiguration(store, 'r').roles.find(r => r.role_id === 'reviewer');
  assert.match(reviewer.persona_prompt, /Read the diff\./);
  assert.doesNotMatch(reviewer.persona_prompt, /gate\.onboarding|接入门禁/);
  const revBefore = roleConfiguration(store, 'r').revision;
  store.close(); store = new Store(database, key);
  assert.equal(roleConfiguration(store, 'r').revision, revBefore);
});

test('publishRequestPullRequest requests workflows: write on demand and reports github_workflows_permission_missing when installation lacks it', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: '1'.repeat(40) };
  const wfNewBytes = Buffer.from('name: CI\non: [push, pull_request]\n');
  const wfNew = { path: '.github/workflows/ci.yml', mode: '100644', sha: blobSha(wfNewBytes), base64: wfNewBytes.toString('base64') };
  const codeBase = { path: 'src/index.ts', mode: '100644', sha: '2'.repeat(40) };
  const codeNewBytes = Buffer.from('export const ok = true;\n');
  const codeNew = { path: 'src/index.ts', mode: '100644', sha: blobSha(codeNewBytes), base64: codeNewBytes.toString('base64') };
  const baseSha = 'b'.repeat(40);
  const setupTask = (f, files, snapshotFiles) => {
    const now = new Date().toISOString();
    const expectedTree = treeSha(files);
    f.store.run("UPDATE policies SET development_enabled=1,test_command='true' WHERE repository_id='r'");
    const commands = new TaskCommands(f.store);
    const operator = { id: 'u1', role: 'project_admin', repositories: ['r'] };
    const created = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
      repository_id: 'r',
      request: 'Update CI workflow',
      intent: 'development',
      contract: { goal: 'Update CI workflow', scope: ['.github/workflows/ci.yml'], criteria: ['Workflow updated'], endpoint: 'reviewable_pull_request' },
    });
    const taskId = created.id;
    const savedInput = JSON.parse(f.store.get('SELECT input FROM tasks WHERE id=?', taskId).input);
    savedInput.delivery = 'pull_request';
    f.store.run("UPDATE tasks SET status='running',phase='publish',claim_token='claim',input=? WHERE id=?", JSON.stringify(savedInput), taskId);
    f.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'r','claim','now')", taskId);
    const branch = `bot/task-${taskId}`;
    f.store.run("INSERT INTO bot_branches VALUES('r',?,?)", branch, taskId);
    const candidate = {
      files,
      snapshot_files: snapshotFiles,
      source_tree: '0'.repeat(40),
      tree_sha: expectedTree,
      local_sha: 'd'.repeat(40),
      branch,
      owner_task_id: taskId,
      base_sha: baseSha,
      base_branch: 'main',
      expected_sha: null,
      pr_number: null,
      date: now,
      summary: 'Update CI workflow',
      change_title: 'ci: update workflow',
      test_command: 'true',
      validation: { command: 'true', exit_code: 0, source: 'policy' },
    };
    f.store.run('INSERT INTO development_candidates VALUES(?,?)', taskId, JSON.stringify(candidate));
    const records = new TaskRecords(f.store);
    const submitted = records.submit(taskId, [{ kind: 'code', reference: `task:${taskId}:candidate`, version: expectedTree, content: { branch, base_sha: baseSha } }], [], { summary: candidate.summary }, 'claim');
    const task = f.store.get('SELECT * FROM tasks WHERE id=?', taskId);
    records.stage(taskId, submitted.id, submitted.revision, { outcome: 'pass', reason: 'verified', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true }, 'claim', { policy_hash: requestPolicyHash(f.store, task) });
    return task;
  };

  // 1. Ordinary development task touching workflows against an installation WITH workflows: write -> requests workflows: write and publishes PR.
  const f1 = await appFixture(t, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' });
  const task1 = setupTask(f1, [wfNew], [wfBase]);
  const published = await publishRequestPullRequest(f1.store, task1, new Redactor(), async () => {}, () => {}, f1.apiUrl);
  assert.equal(published.pr_number, 12);
  assert.deepEqual(f1.tokens, [{ contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }]);
  assert.ok(f1.requests.includes('POST /repos/fixture/r/git/trees'));
  assert.ok(f1.requests.includes('POST /repos/fixture/r/pulls'));

  // 2. Ordinary development task NOT touching workflows -> never requests workflows: write even if installation grants it.
  const f2 = await appFixture(t, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' });
  const task2 = setupTask(f2, [wfBase, codeNew], [wfBase, codeBase]);
  const publishedCodeOnly = await publishRequestPullRequest(f2.store, task2, new Redactor(), async () => {}, () => {}, f2.apiUrl);
  assert.equal(publishedCodeOnly.pr_number, 12);
  assert.deepEqual(f2.tokens, [{ contents: 'write', issues: 'write', pull_requests: 'write' }]);

  // 3. Ordinary development task touching workflows against an installation MISSING workflows: write -> github_workflows_permission_missing, no POST /git/trees.
  const f3 = await appFixture(t, { contents: 'write', issues: 'write', pull_requests: 'write' });
  const task3 = setupTask(f3, [wfNew], [wfBase]);
  await assert.rejects(publishRequestPullRequest(f3.store, task3, new Redactor(), async () => {}, () => {}, f3.apiUrl), error => {
    assert.equal(error.code, 'github_workflows_permission_missing');
    assert.equal(error.state, 'waiting_permission');
    assert.ok(error.detail.includes('.github/workflows/ci.yml'));
    assert.match(error.detail, /Workflows: Read and write/);
    return true;
  });
  assert.ok(!f3.requests.includes('POST /repos/fixture/r/git/trees'));
  assert.ok(!f3.requests.includes('POST /repos/fixture/r/git/blobs'));
});

test('ordinary development task (open_pull_request) modifies .github/workflows/ and publishes PR normally', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-wf-submit-'));
  const store = new Store(':memory:', randomBytes(32));
  const computer = new LocalManager('101', root);
  const { server: ghServer } = await import('../../../fixtures/agent-server.mjs');
  ghServer.listen(0, '127.0.0.1'); await once(ghServer, 'listening');
  const gh = 'http://127.0.0.1:' + ghServer.address().port;
  await fetch(gh + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'wf-submit-token' }) });

  let qaCalls = 0, devStep = 0;
  const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages;
    const tools = (body.tools ?? []).map(tool => tool.function.name);
    let message;
    if (messages[0].content.includes('independent delivery acceptance evaluator')) {
      qaCalls++;
      message = { role: 'assistant', content: JSON.stringify({ outcome: 'pass', reason: 'ok', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true }) };
    } else if (tools.includes('delegate_role')) {
      const toolResults = messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
      const devResult = toolResults.find(r => typeof r.result_ref === 'string');
      message = devResult
        ? call('nominate_delivery', { result_ref: devResult.result_ref, checks_note: 'CI workflow change ready.' })
        : call('delegate_role', { role: 'dev', purpose: 'Add .github/workflows/ci.yml and submit PR.', refs: [] });
    } else if (tools.includes('open_pull_request')) {
      devStep++;
      if (devStep === 1) {
        message = call('write_file', { path: '.github/workflows/ci.yml', content: 'name: CI\non: push\n' });
      } else {
        message = call('open_pull_request', { summary: 'Add CI workflow', artifacts: [{ path: '.github/workflows/ci.yml', description: 'CI' }], change_title: 'ci: add workflow' });
      }
    } else {
      throw new Error('unexpected model tools: ' + tools.join(','));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const engine = new TaskEngine(store, computer, gh + '/github');
  t.after(async () => {
    await engine.close();
    await computer.recover();
    await new Promise(r => { model.close(r); model.closeAllConnections(); });
    await new Promise(r => { ghServer.close(r); ghServer.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'wf-submit-token' }, 'account:a'), 'now');
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:' + model.address().port + '/v1', 'fixture', store.secrets.seal({ value: 'wf-model-token' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling,test_command) VALUES('101','m',1,1,'develop','true')");
  scriptedRoles(store, '101');

  const commands = new TaskCommands(store);
  const operator = { id: 'u1', role: 'project_admin', repositories: ['101'] };
  const id = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
    repository_id: '101',
    request: 'Add CI workflow',
    intent: 'development',
    executor_role: 'dev',
    contract: { goal: 'Add CI', scope: ['.github/workflows/ci.yml'], criteria: ['CI added'], endpoint: 'reviewable_pull_request' },
  }).id;
  store.run("UPDATE tasks SET status='running',claim_token='claim' WHERE id=?", id);
  store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", id);
  authorizeKnowledgeTask(store, id);

  await engine.run(id, 'claim');
  assert.equal(qaCalls, 1, 'QA must run and approve the workflow change');
  const task = store.get('SELECT status, error_code, result FROM tasks WHERE id=?', id);
  assert.equal(task.status, 'pr_opened', JSON.stringify(task));
  assert.equal(task.error_code, null);
  assert.ok(JSON.parse(task.result).pr_number, JSON.stringify(task.result));
});

test('Manager-dispatched PR revision (development.pr) updates .github/workflows/ with on-demand workflows: write token, and reports missing App permission cleanly', async t => {
  const baseCommitSha = '1'.repeat(40);
  const prHeadSha = '2'.repeat(40);
  const newCommitSha = '3'.repeat(40);
  const readmeBytes = Buffer.from('# Repo\n');
  const readmeSha = blobSha(readmeBytes);
  const oldWfBytes = Buffer.from('name: CI\non: push\n');
  const oldWfSha = blobSha(oldWfBytes);
  const initialTreeSha = treeSha([
    { path: 'README.md', mode: '100644', sha: readmeSha },
    { path: '.github/workflows/ci.yml', mode: '100644', sha: oldWfSha },
  ]);

  const runRevision = async (grantedPermissions) => {
    const root = mkdtempSync(join(tmpdir(), 'bot-wf-pr-rev-'));
    const store = new Store(':memory:', randomBytes(32));
    const computer = new LocalManager('101', root);
    const tokens = [], revoked = [], gitWrites = [];
    let currentHead = prHeadSha;

    const ghServer = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const url = new URL(req.url, 'http://fixture'), path = url.pathname;
      const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (path === '/app') return send({ slug: 'fixture-bot' });
      if (path === '/users/fixture-bot%5Bbot%5D') return send({ id: 901, login: 'fixture-bot[bot]' });
      if (path === '/repos/fixture/project-101/installation') return send({ id: 55, account: { id: 10 }, permissions: { metadata: 'read', ...grantedPermissions } });
      if (path === '/app/installations/55/access_tokens') {
        const body = JSON.parse(raw);
        tokens.push(body.permissions);
        const granted = Object.fromEntries(Object.entries(body.permissions || {}).filter(([k]) => grantedPermissions[k]));
        return send({ token: 'ghs_' + randomBytes(8).toString('hex'), expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: granted }, 201);
      }
      if (path === '/installation/token' && req.method === 'DELETE') {
        revoked.push(String(req.headers.authorization || ''));
        res.writeHead(204); return res.end();
      }
      if (path === '/repositories/101') return send({ id: '101', owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
      if (path === '/repos/fixture/project-101/pulls/201' && req.method === 'GET') {
        return send({
          id: 2010, number: 201, state: 'open', draft: false, title: 'ci: initial', body: 'Initial CI PR',
          html_url: 'https://github.invalid/fixture/project-101/pull/201',
          user: { id: 901, login: 'fixture-bot[bot]' }, labels: [],
          base: { ref: 'main', sha: baseCommitSha },
          head: { ref: 'bot/issue-1-src', sha: currentHead, repo: { id: '101' } },
        });
      }
      if (path === '/repos/fixture/project-101/pulls/201' && req.method === 'PATCH') {
        const body = JSON.parse(raw);
        return send({
          id: 2010, number: 201, state: 'open', draft: false, title: body.title, body: body.body,
          html_url: 'https://github.invalid/fixture/project-101/pull/201',
          user: { id: 901, login: 'fixture-bot[bot]' }, labels: [],
          base: { ref: 'main', sha: baseCommitSha },
          head: { ref: 'bot/issue-1-src', sha: currentHead, repo: { id: '101' } },
        });
      }
      if (path === '/repos/fixture/project-101/pulls/201/files') return send([{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }]);
      if (path === '/repos/fixture/project-101/pulls/201/reviews') return send([]);
      if (path === '/repos/fixture/project-101/pulls/201/comments') return send([]);
      if (path === '/repos/fixture/project-101/issues/201/comments' && req.method === 'GET') return send([]);
      if (path === '/repos/fixture/project-101/issues/201/comments' && req.method === 'POST') return send({ id: 5001, html_url: 'https://github.invalid/fixture/project-101/pull/201#issuecomment-5001', body: JSON.parse(raw).body, user: { id: 901 } }, 201);
      if (path === '/repos/fixture/project-101/labels') return send([]);
      if (path === '/repos/fixture/project-101/git/ref/heads/main') return send({ ref: 'refs/heads/main', object: { sha: baseCommitSha, type: 'commit' } });
      if (path === '/repos/fixture/project-101/git/ref/heads/bot%2Fissue-1-src') return send({ ref: 'refs/heads/bot/issue-1-src', object: { sha: currentHead, type: 'commit' } });
      if (path === `/repos/fixture/project-101/git/commits/${baseCommitSha}` || path === `/repos/fixture/project-101/git/commits/${prHeadSha}`) {
        return send({ sha: path.split('/').at(-1), tree: { sha: initialTreeSha }, parents: [] });
      }
      if (path === `/repos/fixture/project-101/git/trees/${initialTreeSha}`) {
        return send({
          sha: initialTreeSha, truncated: false,
          tree: [
            { path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha, size: readmeBytes.length },
            { path: '.github/workflows/ci.yml', mode: '100644', type: 'blob', sha: oldWfSha, size: oldWfBytes.length },
          ],
        });
      }
      if (path === `/repos/fixture/project-101/git/blobs/${readmeSha}`) return send({ sha: readmeSha, encoding: 'base64', content: readmeBytes.toString('base64') });
      if (path === `/repos/fixture/project-101/git/blobs/${oldWfSha}`) return send({ sha: oldWfSha, encoding: 'base64', content: oldWfBytes.toString('base64') });
      if (path === '/repos/fixture/project-101/git/blobs' && req.method === 'POST') {
        gitWrites.push(`${req.method} ${path}`);
        return send({ sha: blobSha(Buffer.from(JSON.parse(raw).content, 'base64')) }, 201);
      }
      if (path === '/repos/fixture/project-101/git/trees' && req.method === 'POST') {
        gitWrites.push(`${req.method} ${path}`);
        const body = JSON.parse(raw);
        const merged = new Map([
          ['README.md', { path: 'README.md', mode: '100644', sha: readmeSha }],
          ['.github/workflows/ci.yml', { path: '.github/workflows/ci.yml', mode: '100644', sha: oldWfSha }],
        ]);
        for (const entry of body.tree || []) {
          if (entry.sha === null) merged.delete(entry.path);
          else merged.set(entry.path, { path: entry.path, mode: entry.mode, sha: entry.sha });
        }
        return send({ sha: treeSha([...merged.values()]) }, 201);
      }
      if (path === '/repos/fixture/project-101/git/commits' && req.method === 'POST') {
        gitWrites.push(`${req.method} ${path}`);
        const body = JSON.parse(raw);
        return send({ sha: newCommitSha, tree: { sha: body.tree } }, 201);
      }
      if (path === '/repos/fixture/project-101/git/refs/heads/bot%2Fissue-1-src' && req.method === 'PATCH') {
        gitWrites.push(`${req.method} ${path}`);
        currentHead = JSON.parse(raw).sha;
        return send({ ref: 'refs/heads/bot/issue-1-src', object: { sha: currentHead, type: 'commit' } });
      }
      return send({ message: `Not Found: ${req.method} ${path}` }, 404);
    });
    ghServer.listen(0, '127.0.0.1'); await once(ghServer, 'listening');

    const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const latestResult = messages => messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return null; } }).filter(r => r?.result_ref).at(-1)?.result_ref;
    const model = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), messages = body.messages;
      const tools = (body.tools ?? []).map(tool => tool.function.name);
      const names = messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(c => c.function.name);
      let message;
      if (messages[0].content.includes('independent delivery acceptance evaluator')) {
        message = { role: 'assistant', content: JSON.stringify({ outcome: 'pass', reason: 'ok', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true }) };
      } else if (tools.includes('delegate_role')) {
        const prompt = JSON.parse(messages[1].content);
        if (!names.includes('delegate_role')) message = call('delegate_role', { role: 'dev', purpose: 'Fix workflow per review feedback', refs: [prompt.task_ref] });
        else message = call('nominate_delivery', { result_ref: latestResult(messages) });
      } else if (tools.includes('submit_delivery')) {
        if (!names.includes('write_file')) message = call('write_file', { path: '.github/workflows/ci.yml', content: 'name: CI\non: [push, pull_request]\n' });
        else message = call('submit_delivery', { summary: 'Fixed workflow trigger on PR', test_command: 'true', change_title: 'ci: trigger on pull_request' });
      } else {
        throw new Error('unexpected model tools: ' + tools.join(','));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
    });
    model.listen(0, '127.0.0.1'); await once(model, 'listening');

    const engine = new TaskEngine(store, computer, 'http://127.0.0.1:' + ghServer.address().port);
    try {
      const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
      store.run("INSERT INTO accounts VALUES('a','fixture','github_app','123',?,'now')", store.secrets.seal({ private_key: privateKey }, 'account:a'));
      store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
      store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:' + model.address().port + '/v1', 'fixture', store.secrets.seal({ value: 'wf-model-token' }, 'model:m'), 'now');
      store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling,test_command) VALUES('101','m',1,1,'develop','true')");
      scriptedRoles(store, '101');

      const now = new Date().toISOString();
      store.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,phase,summary,input,created_at,updated_at) VALUES('src','101','development.issue',1,'pr_opened','done','Open CI PR','{}',?,?)", now, now);
      store.run("INSERT INTO bot_branches VALUES('101','bot/issue-1-src','src')");
      store.run("INSERT INTO bot_pull_requests VALUES('101',201,'2010','901','101','bot/issue-1-src',?,'src',0)", prHeadSha);

      const id = 'wf-pr-rev-1';
      store.run(
        "INSERT INTO tasks(id,repository_id,kind,object_number,status,phase,summary,input,claim_token,created_at,updated_at) VALUES(?,'101','development.pr',201,'running','prepare','Revise CI PR #201',?,'claim',?,?)",
        id,
        JSON.stringify({ revision: { source: 'request', requests: [{ author: 'maintainer', id: 'c1', type: 'comment', body: 'Also trigger on pull_request' }] }, review: { implementation_goal: 'Add pull_request trigger to workflow' } }),
        now,
        now,
      );
      store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", id);
      authorizeKnowledgeTask(store, id);

      await engine.run(id, 'claim');
      const task = store.get('SELECT status, error_code, result FROM tasks WHERE id=?', id);
      return { task, tokens, revoked, gitWrites, currentHead };
    } finally {
      await engine.close();
      await computer.recover();
      await new Promise(r => { model.close(r); model.closeAllConnections(); });
      await new Promise(r => { ghServer.close(r); ghServer.closeAllConnections(); });
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };

  // 1. App installation grants workflows: write -> initial connect omits workflows, Publisher mints short-lived workflows: write token on demand and revokes it.
  const ok = await runRevision({ contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' });
  assert.equal(ok.task.status, 'completed', JSON.stringify(ok.task));
  assert.equal(ok.task.error_code, null);
  assert.equal(ok.currentHead, newCommitSha);
  assert.deepEqual(ok.tokens[0], { contents: 'write', issues: 'write', pull_requests: 'write' }, 'initial task token must stay least-privilege');
  assert.ok(ok.tokens.some(scope => scope.contents === 'write' && scope.workflows === 'write'), `expected on-demand workflows: write token, got ${JSON.stringify(ok.tokens)}`);
  assert.ok(ok.revoked.length >= 1, 'on-demand workflow token must be revoked after branch push');

  // 2. App installation lacks workflows: write -> stops with github_workflows_permission_missing before any git write.
  const denied = await runRevision({ contents: 'write', issues: 'write', pull_requests: 'write' });
  assert.equal(denied.task.status, 'waiting_permission', JSON.stringify(denied.task));
  assert.equal(denied.task.error_code, 'github_workflows_permission_missing');
  assert.deepEqual(denied.gitWrites, [], 'must stop before uploading blobs/trees/refs when installation lacks workflows: write');
});
