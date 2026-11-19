import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { developmentTeam } from '../../../../dist/roles/development.js';
import { evaluateDelivery } from '../../../../dist/tasks/acceptance.js';
import { RepositoryExplorer } from '../../../../dist/agent/exploration.js';
import { ReadTokens } from '../../../../dist/agent/read-token.js';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { roleApi } from '../../../../dist/roles/api.js';
import { server as github } from '../../../fixtures/agent-server.mjs';

const call = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

const toolReceipts = body =>
  body.messages
    .filter(m => m.role === 'tool')
    .map(m => JSON.parse(typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')));

test('#1121 dev -> test -> reviewer -> qa share one task workspace, read preceding role traces, use GitHub read tools, share project memory/notes, and return QA issues in place', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-shared-1121-'));
  const store = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root);
  github.listen(0, '127.0.0.1');
  await once(github, 'listening');
  const ghUrl = 'http://127.0.0.1:' + github.address().port;
  await fetch(ghUrl + '/fixture/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ github_token: 'fixture-github-token' }),
  });

  let qaAttempt = 0;
  let reviewerSawDevTrace = false;
  let reviewerUsedGithubRead = false;
  let reviewerReadSharedMemory = false;
  let testReusedDevArtifact = false;

  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const toolNames = (body.tools || []).map(x => x.function.name);
    const results = toolReceipts(body);
    let message;

    if (toolNames.includes('nominate_delivery')) {
      const refs = results.filter(r => r.result_ref).map(r => r.result_ref);
      const feedback = /Missing regression test/i.test(JSON.stringify(body.messages));
      if (!feedback) {
        message =
          refs.length === 0
            ? call('delegate_role', { role: 'dev', purpose: 'Implement feature and build artifact', refs: [] })
            : refs.length === 1
              ? call('delegate_role', { role: 'test', purpose: 'Verify build artifact in shared workspace', refs })
              : refs.length === 2
                ? call('delegate_role', { role: 'reviewer', purpose: 'Review dev trace, GitHub context and shared memory', refs })
                : call('nominate_delivery', { result_ref: refs[0] });
      } else {
        const delegatedRepair = body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.arguments?.includes('Add missing regression test')));
        message = !delegatedRepair ? call('delegate_role', { role: 'dev', purpose: 'Add missing regression test reported by QA', refs: [] }) : call('nominate_delivery', { result_ref: refs.at(-1) });
      }
    } else if (toolNames.includes('submit_acceptance')) {
      if (qaAttempt === 1) {
        message = call('submit_acceptance', { pass: false, issues: ['Missing regression test in test/feature.test.js for changed behavior'] });
      } else {
        const readTest = results.find(r => typeof r.content === 'string' && r.content.includes('assertFeature'));
        message = readTest ? call('submit_acceptance', { pass: true, issues: [] }) : call('read_file', { path: 'test/feature.test.js' });
      }
    } else if (toolNames.includes('submit_role_result')) {
      const isTest = body.messages[0].content.includes('Independently test');
      if (isTest) {
        const checked = results.find(r => typeof r.output === 'string' && r.output.includes('CACHED_BUILD_OK'));
        if (!checked) {
          message = call('run_command', { command: 'cat node_modules/.cache/dev-build.stamp' });
        } else {
          testReusedDevArtifact = true;
          message = call('submit_role_result', {
            summary: 'Verified cached build artifact in the exact same workspace without reinstalling',
            findings: [],
            inspected_scope: ['src/feature.js'],
            unknowns: [],
          });
        }
      } else {
        // Reviewer: verify github_read,github_search,read_job_log are offered, read dev's tool_observation via read_task_history, and read/write shared memory!
        assert.ok(toolNames.includes('github_read') && toolNames.includes('github_search') && toolNames.includes('read_job_log'), 'reviewer must receive GitHub read tools');
        assert.ok(toolNames.includes('remember_project_memory'), 'reviewer must receive remember_project_memory');
        const historyObs = results.find(r => Array.isArray(r.observations));
        const ghObs = results.find(r => r.number === 1 || r.title || r.full_name || r.items || r.repository);
        const memObs = results.find(r => Array.isArray(r.items) && r.items.some(i => i.key === 'arch-note'));
        const wroteMem = results.find(r => r.revision === 2);
        if (!historyObs) {
          message = call('read_task_history', { offset: 0, limit: 20 });
        } else if (!ghObs) {
          reviewerSawDevTrace = JSON.stringify(historyObs).includes('CACHED_BUILD_OK');
          message = call('github_read', { path: '/issues/1' });
        } else if (!memObs) {
          reviewerUsedGithubRead = true;
          message = call('search_project_memory', { query: 'arch-note' });
        } else if (!wroteMem) {
          reviewerReadSharedMemory = true;
          message = call('remember_project_memory', { key: 'arch-note', body: 'Updated by reviewer with review context', kind: 'experience' });
        } else {
          message = call('submit_role_result', {
            summary: 'Reviewed candidate with full dev trace, GitHub read and shared memory access',
            findings: [],
            inspected_scope: ['src/feature.js'],
            unknowns: [],
          });
        }
      }
    } else {
      // Dev role
      const feedback = /missing regression test/i.test(JSON.stringify(body.messages));
      if (!feedback) {
        const wroteCode = body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'write_file' && JSON.parse(c.function.arguments).path === 'src/feature.js'));
        const wroteNote = body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'write_file' && JSON.parse(c.function.arguments).path === '../notes/handoff.md'));
        const savedMem = body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'remember_project_memory'));
        const builtCache = body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'run_command'));
        message = !wroteCode
          ? call('write_file', { path: 'src/feature.js', content: 'export const feature = () => 42;\n' })
          : !wroteNote
            ? call('write_file', { path: '../notes/handoff.md', content: 'Shared workspace handoff note\n' })
            : !savedMem
              ? call('remember_project_memory', { key: 'arch-note', body: 'Initial dev architecture note', kind: 'experience' })
              : !builtCache
                ? call('run_command', { command: 'mkdir -p node_modules/.cache && printf CACHED_BUILD_OK > node_modules/.cache/dev-build.stamp' })
                : call('submit_delivery', { summary: 'Implemented feature', test_command: 'node -e "process.exit(0)"', change_title: 'feat: implement feature' });
      } else {
        const wroteTest = body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'write_file' && JSON.parse(c.function.arguments).path === 'test/feature.test.js'));
        message = !wroteTest
          ? call('write_file', { path: 'test/feature.test.js', content: 'export const assertFeature = true;\n' })
          : call('submit_delivery', { summary: 'Implemented feature with regression test', test_command: 'node -e "process.exit(0)"', change_title: 'feat: implement feature' });
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(async () => {
    await manager.recover();
    await new Promise(r => { model.close(r); model.closeAllConnections(); });
    await new Promise(r => { github.close(r); github.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  store.run(
    "INSERT INTO accounts VALUES('a','fixture','github_app','123',?,'now')",
    store.secrets.seal({ private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 'account:a'),
  );
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)',
    'm',
    '101',
    `http://127.0.0.1:${model.address().port}/v1`,
    'fixture',
    store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'),
    'now',
  );
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  const env = await manager.call('PUT', '/v1/projects/101');
  const workspaceId = randomBytes(24).toString('hex');
  store.run(
    'INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)',
    't1',
    '101',
    'development.issue',
    'running',
    'Implement feature',
    '{}',
    1,
    env.generation,
    workspaceId,
  );
  authorizeKnowledgeTask(store, 't1');
  const records = new TaskRecords(store);
  records.contract('t1', { goal: 'Implement feature with tests', scope: ['src/feature.js'], criteria: ['Include regression test'], endpoint: 'reviewable_pull_request' });
  roleApi(store, { id: 'owner', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), {
    expected_revision: 0,
    enabled: true,
    roles: ['manager', 'dev', 'test', 'reviewer', 'qa'].map(role_id => ({ role_id, harness_ref: { id: 'native' } })),
  });

  const task = store.get("SELECT * FROM tasks WHERE id='t1'");
  const redactor = new Redactor();
  const guard = async () => {};
  const workspace = new Workspace(store, manager, task, redactor, guard, () => {});
  await workspace.call('init', { type: 'workspace_init' });
  writeFileSync(join(root, 'tasks', workspaceId, 'repo', '.gitignore'), 'node_modules/\n');
  await workspace.call('seed', {
    type: 'workspace_command',
    command: 'git init -q && git add .gitignore && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm init',
    timeout_ms: 10000,
  });

  const repoRow = store.get("SELECT * FROM repositories WHERE id='101'");
  const scopes = ['issues', 'pull_requests', 'contents', 'actions', 'checks', 'statuses'];
  const tokens = new ReadTokens(store, repoRow, redactor, guard, ghUrl + '/github', scopes, () => scopes);
  const explorer = new RepositoryExplorer(tokens, redactor, guard);

  const delivered = await developmentTeam(
    workspace,
    'Implement the requested feature.',
    '{"goal":"Implement feature"}',
    async (_id, candidateMeta) => {
      const snap = await workspace.artifact('publish:' + randomBytes(6).toString('hex'));
      const submitted = records.submit(
        't1',
        [{ kind: 'code', reference: 'task:t1:candidate', version: snap.tree_sha, content: { ...snap, files: snap.files, summary: candidateMeta.summary } }],
        [],
        candidateMeta,
      );
      qaAttempt++;
      const verdict = await evaluateDelivery(store, task, workspace, redactor, guard);
      if (!verdict.pass) {
        records.decide('t1', submitted.id, submitted.revision, verdict, 'running', false);
        store.run("UPDATE tasks SET status='running' WHERE id='t1'");
        return { error: 'acceptance_return', reason: verdict.reason, gaps: verdict.issues };
      }
      return { pr: { number: 42 } };
    },
    { read: true, write: true, shell: true },
    undefined,
    undefined,
    undefined,
    explorer,
  );
  await tokens.revoke();

  assert.equal(delivered.pr.number, 42);
  assert.equal(qaAttempt, 2, 'QA returned missing-test issue on round 1 and passed on round 2');
  assert.equal(testReusedDevArtifact, true, 'test reused dev node_modules/.cache artifact in-place');
  assert.equal(reviewerSawDevTrace, true, 'reviewer read dev execution trace without trace_role_private');
  assert.equal(reviewerUsedGithubRead, true, 'reviewer invoked github_read directly');
  assert.equal(reviewerReadSharedMemory, true, 'reviewer searched and updated shared project memory');
  assert.equal(existsSync(join(root, 'tasks', workspaceId, 'repo', 'test', 'feature.test.js')), true, 'dev repaired in-place in the same workspace');
  assert.equal(readFileSync(join(root, 'project-notes', 'handoff.md'), 'utf8'), 'Shared workspace handoff note\n');
  const candidates = store.all("SELECT data FROM task_history WHERE task_id='t1' AND type='role_candidate'").map(r => JSON.parse(r.data));
  assert.ok(candidates.every(c => c.workspace_id === workspaceId), 'all roles worked in the single shared task workspace');
});
