import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { Publisher } from '../../../../dist/github/publisher.js';
import { blobSha, TaskError, treeSha } from '../../../../dist/agent/common.js';
import { automaticState, explainFailure, failureCause } from '../../../../dist/agent/failures.js';
import {
  changedWorkflowPaths,
  hasWorkflowChangesConfirmation,
  isWorkflowPath,
} from '../../../../dist/github/workflow-changes.js';

const shaOf = ch => ch.repeat(40);

function publisherFixture(t, { taskInput = '{}', installationPermissions = null, permissions = {}, onRequest } = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 9));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','github_app','123','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','fixture/repo','1','a')");
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('t','r','task.development','running','fixture',?,1)",
    typeof taskInput === 'string' ? taskInput : JSON.stringify(taskInput),
  );
  const branch = 'bot/task-t';
  store.run("INSERT INTO bot_branches VALUES('r',?,'t')", branch);
  const task = store.get("SELECT * FROM tasks WHERE id='t'");
  const requests = [];
  let head = null;
  const github = {
    defaultBranch: 'main',
    installationPermissions,
    permissions,
    path: suffix => suffix,
    authorEmail: () => '1+bot[bot]@users.noreply.github.com',
    ref: async () => (head ? { object: { sha: head } } : null),
    async request(method, path, body) {
      requests.push({ method, path, body });
      if (onRequest) {
        const overridden = await onRequest(method, path, body);
        if (overridden !== undefined) return overridden;
      }
      if (path === '/git/blobs') {
        const raw = Buffer.from(body.content, 'base64');
        return { sha: blobSha(raw) };
      }
      if (path === '/git/trees') {
        return { sha: body._expected_tree ?? shaOf('e') };
      }
      if (path === '/git/commits') {
        return { sha: shaOf('c'), tree: { sha: body.tree } };
      }
      if (path.startsWith('/git/refs')) {
        head = body.sha;
        return { object: { sha: head } };
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    },
  };
  return { store, task, branch, requests, github, publisher: new Publisher(store, github, task, async () => {}) };
}

test('isWorkflowPath and changedWorkflowPaths detect additions, modifications, deletions and ignore unchanged workflows', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/sub/test.yaml', '.GitHub/Workflows/Release.yml', '.github/workflows']) {
    assert.equal(isWorkflowPath(path), true, path);
  }
  for (const path of ['.github/CODEOWNERS', '.github/workflows-extra/ci.yml', 'src/.github/workflows/ci.yml', 'README.md', null, 123]) {
    assert.equal(isWorkflowPath(path), false, String(path));
  }

  const unchanged = { path: '.github/workflows/ci.yml', mode: '100644', sha: shaOf('1') };
  const code = { path: 'src/index.ts', mode: '100644', sha: shaOf('2') };
  assert.deepEqual(changedWorkflowPaths([unchanged, { ...code, sha: shaOf('3') }], [unchanged, code]), []);
  assert.deepEqual(
    changedWorkflowPaths([unchanged, { path: '.github/workflows/new.yml', mode: '100644', sha: shaOf('4') }], [unchanged]),
    ['.github/workflows/new.yml'],
  );
  assert.deepEqual(
    changedWorkflowPaths([{ ...unchanged, sha: shaOf('5') }], [unchanged]),
    ['.github/workflows/ci.yml'],
  );
  assert.deepEqual(
    changedWorkflowPaths([{ ...unchanged, mode: '100755' }], [unchanged]),
    ['.github/workflows/ci.yml'],
  );
  assert.deepEqual(
    changedWorkflowPaths([code], [unchanged, code]),
    ['.github/workflows/ci.yml'],
  );
  assert.deepEqual(
    changedWorkflowPaths(
      [{ path: '.github/workflows/b.yml', mode: '100644', sha: shaOf('6') }],
      [{ path: '.github/workflows/a.yml', mode: '100644', sha: shaOf('7') }],
    ),
    ['.github/workflows/a.yml', '.github/workflows/b.yml'],
  );
  assert.equal(hasWorkflowChangesConfirmation({ input: '{}' }), false);
  assert.equal(hasWorkflowChangesConfirmation({ input: JSON.stringify({ workflow_changes: { confirmed_at: 'now' } }) }), false);
  assert.equal(hasWorkflowChangesConfirmation({ input: JSON.stringify({ workflow_changes: { confirmed_by: 'u1', confirmed_at: 'now' } }) }), true);
});

test('Publisher.branch stops unconfirmed tasks touching .github/workflows/ (add, modify, delete) without POST /git/trees', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: shaOf('1') };
  const codeBase = { path: 'src/app.ts', mode: '100644', sha: shaOf('2') };
  const newWfBytes = Buffer.from('name: CI\non: push\n');
  const newWf = { path: '.github/workflows/new.yml', mode: '100644', sha: blobSha(newWfBytes), base64: newWfBytes.toString('base64') };
  const modWfBytes = Buffer.from('name: CI v2\non: pull_request\n');
  const modWf = { path: '.github/workflows/ci.yml', mode: '100644', sha: blobSha(modWfBytes), base64: modWfBytes.toString('base64') };

  const cases = [
    { name: 'add', files: [wfBase, codeBase, newWf], snapshot_files: [wfBase, codeBase], expectedPath: '.github/workflows/new.yml' },
    { name: 'modify', files: [modWf, codeBase], snapshot_files: [wfBase, codeBase], expectedPath: '.github/workflows/ci.yml' },
    { name: 'delete', files: [codeBase], snapshot_files: [wfBase, codeBase], expectedPath: '.github/workflows/ci.yml' },
  ];

  for (const scenario of cases) {
    const f = publisherFixture(t, {
      taskInput: {},
      installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
      permissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
    });
    const candidate = {
      files: scenario.files,
      snapshot_files: scenario.snapshot_files,
      source_tree: shaOf('0'),
      tree_sha: treeSha(scenario.files),
      branch: f.branch,
      owner_task_id: 't',
      base_sha: shaOf('a'),
      expected_sha: null,
      date: '2026-11-21T00:00:00Z',
      summary: 'Update CI',
      change_title: 'ci: update workflow',
      validation: { command: 'npm test', exit_code: 0 },
    };
    f.store.run("INSERT INTO development_candidates VALUES('t',?)", JSON.stringify(candidate));
    await assert.rejects(f.publisher.branch(candidate), error => {
      assert.equal(error.code, 'workflow_changes_not_confirmed', scenario.name);
      assert.equal(error.state, 'waiting_permission', scenario.name);
      assert.ok(error.detail.includes(scenario.expectedPath), `${scenario.name}: ${error.detail}`);
      assert.match(error.detail, /重试原任务不会生效/);
      assert.match(error.detail, /允许修改 \.github\/workflows\/（CI 改动）/);
      assert.match(error.detail, /管理助手确认卡片/);
      return true;
    });
    assert.deepEqual(f.requests, [], `${scenario.name}: must not upload blobs or send POST /git/trees`);
  }
});

test('Publisher.branch stops confirmed tasks when App installation or token lacks workflows: write, and translates 403 for PATs', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: shaOf('1') };
  const modWfBytes = Buffer.from('name: CI v2\n');
  const modWf = { path: '.github/workflows/ci.yml', mode: '100644', sha: blobSha(modWfBytes), base64: modWfBytes.toString('base64') };
  const confirmedInput = { workflow_changes: { confirmed_by: 'u1', confirmed_at: '2026-11-21T00:00:00Z' } };

  for (const [label, installationPermissions, permissions] of [
    ['installation missing workflows', { contents: 'write', issues: 'write', pull_requests: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }],
    ['installation has workflows read only', { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'read' }, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'read' }],
    ['token missing workflows write', { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }],
  ]) {
    const f = publisherFixture(t, { taskInput: confirmedInput, installationPermissions, permissions });
    const candidate = {
      files: [modWf],
      snapshot_files: [wfBase],
      source_tree: shaOf('0'),
      tree_sha: treeSha([modWf]),
      branch: f.branch,
      owner_task_id: 't',
      base_sha: shaOf('a'),
      expected_sha: null,
      date: '2026-11-21T00:00:00Z',
      summary: 'Update CI',
      change_title: 'ci: update workflow',
      validation: { command: 'npm test', exit_code: 0 },
    };
    f.store.run("INSERT INTO development_candidates VALUES('t',?)", JSON.stringify(candidate));
    await assert.rejects(f.publisher.branch(candidate), error => {
      assert.equal(error.code, 'github_workflows_permission_missing', label);
      assert.equal(error.state, 'waiting_permission', label);
      assert.ok(error.detail.includes('.github/workflows/ci.yml'), label);
      assert.match(error.detail, /Workflows: Read and write/);
      return true;
    });
    assert.deepEqual(f.requests, [], `${label}: must stop before POST /git/blobs or POST /git/trees`);
  }

  // Fallback for a non-App token (PAT) where installationPermissions is null and GitHub rejects POST /git/trees with 403.
  const pat = publisherFixture(t, {
    taskInput: confirmedInput,
    installationPermissions: null,
    permissions: {},
    onRequest(method, path) {
      if (method === 'POST' && path === '/git/trees') {
        throw new TaskError('github_permission_403', 'waiting_permission', 'GitHub 请求 POST /git/trees 返回 HTTP 403：Resource not accessible by integration');
      }
    },
  });
  const patCandidate = {
    files: [modWf],
    snapshot_files: [wfBase],
    source_tree: shaOf('0'),
    tree_sha: treeSha([modWf]),
    branch: pat.branch,
    owner_task_id: 't',
    base_sha: shaOf('a'),
    expected_sha: null,
    date: '2026-11-21T00:00:00Z',
    summary: 'Update CI',
    change_title: 'ci: update workflow',
    validation: { command: 'npm test', exit_code: 0 },
  };
  pat.store.run("INSERT INTO development_candidates VALUES('t',?)", JSON.stringify(patCandidate));
  await assert.rejects(pat.publisher.branch(patCandidate), error => {
    assert.equal(error.code, 'github_workflows_permission_missing');
    assert.equal(error.state, 'waiting_permission');
    assert.ok(error.detail.includes('.github/workflows/ci.yml'));
    assert.match(error.detail, /Workflows: Read and write/);
    return true;
  });
});

test('Publisher.branch publishes normally when workflow files are unchanged or when workflow_changes and workflows: write are present', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: shaOf('1') };
  const codeBytes = Buffer.from('export const x = 2;\n');
  const codeNew = { path: 'src/app.ts', mode: '100644', sha: blobSha(codeBytes), base64: codeBytes.toString('base64') };
  const unchangedTree = treeSha([wfBase, codeNew]);

  const normal = publisherFixture(t, {
    taskInput: {},
    installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
    onRequest(method, path) {
      if (method === 'POST' && path === '/git/trees') return { sha: unchangedTree };
    },
  });
  const normalCandidate = {
    files: [wfBase, codeNew],
    snapshot_files: [wfBase, { path: 'src/app.ts', mode: '100644', sha: shaOf('2') }],
    source_tree: shaOf('0'),
    tree_sha: unchangedTree,
    branch: normal.branch,
    owner_task_id: 't',
    base_sha: shaOf('a'),
    expected_sha: null,
    date: '2026-11-21T00:00:00Z',
    summary: 'Update app',
    change_title: 'fix: update app',
    validation: { command: 'npm test', exit_code: 0 },
  };
  normal.store.run("INSERT INTO development_candidates VALUES('t',?)", JSON.stringify(normalCandidate));
  assert.equal(await normal.publisher.branch(normalCandidate), shaOf('c'));
  assert.ok(normal.requests.some(req => req.method === 'POST' && req.path === '/git/trees'));

  const modWfBytes = Buffer.from('name: CI v2\n');
  const modWf = { path: '.github/workflows/ci.yml', mode: '100644', sha: blobSha(modWfBytes), base64: modWfBytes.toString('base64') };
  const wfTree = treeSha([modWf]);
  const authorized = publisherFixture(t, {
    taskInput: { workflow_changes: { confirmed_by: 'u1', confirmed_at: '2026-11-21T00:00:00Z' } },
    installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
    onRequest(method, path) {
      if (method === 'POST' && path === '/git/trees') return { sha: wfTree };
    },
  });
  const authorizedCandidate = {
    files: [modWf],
    snapshot_files: [wfBase],
    source_tree: shaOf('0'),
    tree_sha: wfTree,
    branch: authorized.branch,
    owner_task_id: 't',
    base_sha: shaOf('a'),
    expected_sha: null,
    date: '2026-11-21T00:00:00Z',
    summary: 'Update CI',
    change_title: 'ci: update workflow',
    validation: { command: 'npm test', exit_code: 0 },
  };
  authorized.store.run("INSERT INTO development_candidates VALUES('t',?)", JSON.stringify(authorizedCandidate));
  assert.equal(await authorized.publisher.branch(authorizedCandidate), shaOf('c'));
  assert.ok(authorized.requests.some(req => req.method === 'POST' && req.path === '/git/trees'));
});

test('failures.ts classifies workflow_changes_not_confirmed and github_workflows_permission_missing with actionable guidance', () => {
  for (const code of ['workflow_changes_not_confirmed', 'github_workflows_permission_missing']) {
    assert.equal(failureCause(code, 'waiting_permission'), 'github_access');
    assert.equal(automaticState(code, 'waiting_permission'), 'waiting_permission');
    const explained = explainFailure(code, 'waiting_permission');
    assert.equal(explained.cause, 'github_access');
    assert.equal(explained.automatic, false);
    assert.equal(explained.attempt_retry, false);
  }
  assert.match(explainFailure('workflow_changes_not_confirmed', 'waiting_permission').action, /重试原任务不会生效/);
  assert.match(explainFailure('workflow_changes_not_confirmed', 'waiting_permission').action, /允许修改 \.github\/workflows\/（CI 改动）/);
  assert.match(explainFailure('github_workflows_permission_missing', 'waiting_permission').action, /Workflows: Read and write/);
});
