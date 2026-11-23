import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { Publisher } from '../../../../dist/github/publisher.js';
import { blobSha, TaskError, treeSha } from '../../../../dist/agent/common.js';
import { automaticState, explainFailure, failureCause } from '../../../../dist/agent/failures.js';
import {
  changedWorkflowPaths,
  isWorkflowPath,
} from '../../../../dist/github/workflow-changes.js';

const shaOf = ch => ch.repeat(40);

function publisherFixture(t, { taskInput = '{}', installationPermissions = null, permissions = {}, isAppInstallation = false, withPermissions, onRequest } = {}) {
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
    isAppInstallation,
    ...(withPermissions ? { withPermissions } : {}),
    path: suffix => suffix,
    authorEmail: () => '1+bot[bot]@users.noreply.github.com',
    ref: async () => (head ? { object: { sha: head } } : null),
    async request(method, path, body, _allow404, token) {
      requests.push({ method, path, body, ...(token ? { token } : {}) });
      if (onRequest) {
        const overridden = await onRequest(method, path, body, token);
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
});

test('Publisher.branch requests workflows: write on demand for ordinary tasks touching .github/workflows/ (add, modify, delete)', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: shaOf('1') };
  const codeBase = { path: 'src/app.ts', mode: '100644', sha: shaOf('2') };
  const newWfBytes = Buffer.from('name: CI\non: push\n');
  const newWf = { path: '.github/workflows/new.yml', mode: '100644', sha: blobSha(newWfBytes), base64: newWfBytes.toString('base64') };
  const modWfBytes = Buffer.from('name: CI v2\non: pull_request\n');
  const modWf = { path: '.github/workflows/ci.yml', mode: '100644', sha: blobSha(modWfBytes), base64: modWfBytes.toString('base64') };

  const cases = [
    { name: 'add', files: [wfBase, codeBase, newWf], snapshot_files: [wfBase, codeBase] },
    { name: 'modify', files: [modWf, codeBase], snapshot_files: [wfBase, codeBase] },
    { name: 'delete', files: [codeBase], snapshot_files: [wfBase, codeBase] },
  ];

  for (const scenario of cases) {
    const expectedTree = treeSha(scenario.files);
    const mintedScopes = [];
    const f = publisherFixture(t, {
      taskInput: {},
      installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
      permissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
      isAppInstallation: true,
      async withPermissions(perms, use) {
        mintedScopes.push(perms);
        return use('minted-wf-token', { ...perms });
      },
      onRequest(method, path) {
        if (method === 'POST' && path === '/git/trees') return { sha: expectedTree };
      },
    });
    const candidate = {
      files: scenario.files,
      snapshot_files: scenario.snapshot_files,
      source_tree: shaOf('0'),
      tree_sha: expectedTree,
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
    assert.equal(await f.publisher.branch(candidate), shaOf('c'), scenario.name);
    assert.deepEqual(mintedScopes, [{ contents: 'write', workflows: 'write' }], scenario.name);
    assert.ok(f.requests.every(req => req.token === 'minted-wf-token'), `${scenario.name}: git writes must use on-demand workflow token`);
  }
});

test('Publisher.branch stops when App installation or token lacks workflows: write, and translates 403 for PATs', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: shaOf('1') };
  const modWfBytes = Buffer.from('name: CI v2\n');
  const modWf = { path: '.github/workflows/ci.yml', mode: '100644', sha: blobSha(modWfBytes), base64: modWfBytes.toString('base64') };

  for (const [label, installationPermissions, permissions, extra] of [
    ['installation missing workflows', { contents: 'write', issues: 'write', pull_requests: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }, { isAppInstallation: true }],
    ['installation has workflows read only', { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'read' }, { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'read' }, { isAppInstallation: true }],
    ['static token missing workflows write', { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }, { isAppInstallation: false }],
    ['on-demand token minted without workflows write', { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }, {
      isAppInstallation: true,
      withPermissions: async (_perms, use) => use('short-token', { contents: 'write' }),
    }],
    ['on-demand token mint rejected with 422', { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' }, { contents: 'write', issues: 'write', pull_requests: 'write' }, {
      isAppInstallation: true,
      withPermissions: async () => { throw new TaskError('github_http_422', 'failed', 'Unprocessable Entity'); },
    }],
  ]) {
    const f = publisherFixture(t, { taskInput: {}, installationPermissions, permissions, ...extra });
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

  // Fallback for a non-App token (PAT) where installationPermissions is null and GitHub rejects POST /git/blobs or POST /git/trees with 403.
  for (const failPath of ['/git/blobs', '/git/trees']) {
    const pat = publisherFixture(t, {
      taskInput: {},
      installationPermissions: null,
      permissions: {},
      onRequest(method, path) {
        if (method === 'POST' && path === failPath) {
          throw new TaskError('github_permission_403', 'waiting_permission', `GitHub 请求 POST ${failPath} 返回 HTTP 403：Resource not accessible by integration`);
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
      assert.equal(error.code, 'github_workflows_permission_missing', failPath);
      assert.equal(error.state, 'waiting_permission', failPath);
      assert.ok(error.detail.includes('.github/workflows/ci.yml'), failPath);
      assert.match(error.detail, /Workflows: Read and write/);
      return true;
    });
  }

  // A 422 raised by Git object creation inside pushBranch after on-demand token minting must preserve github_http_422.
  const badTree = publisherFixture(t, {
    taskInput: {},
    installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
    isAppInstallation: true,
    withPermissions: async (perms, use) => use('minted-wf-token', { ...perms }),
    onRequest(method, path) {
      if (method === 'POST' && path === '/git/trees') {
        throw new TaskError('github_http_422', 'failed', 'GitHub 请求 POST /git/trees 返回 HTTP 422：invalid tree');
      }
    },
  });
  const badTreeCandidate = {
    files: [modWf],
    snapshot_files: [wfBase],
    source_tree: shaOf('0'),
    tree_sha: treeSha([modWf]),
    branch: badTree.branch,
    owner_task_id: 't',
    base_sha: shaOf('a'),
    expected_sha: null,
    date: '2026-11-21T00:00:00Z',
    summary: 'Update CI',
    change_title: 'ci: update workflow',
    validation: { command: 'npm test', exit_code: 0 },
  };
  badTree.store.run("INSERT INTO development_candidates VALUES('t',?)", JSON.stringify(badTreeCandidate));
  await assert.rejects(badTree.publisher.branch(badTreeCandidate), error => {
    assert.equal(error.code, 'github_http_422');
    assert.equal(error.state, 'failed');
    return true;
  });
});

test('Publisher.branch publishes normally without extra token when workflow files are unchanged or when token already has workflows: write', async t => {
  const wfBase = { path: '.github/workflows/ci.yml', mode: '100644', sha: shaOf('1') };
  const codeBytes = Buffer.from('export const x = 2;\n');
  const codeNew = { path: 'src/app.ts', mode: '100644', sha: blobSha(codeBytes), base64: codeBytes.toString('base64') };
  const unchangedTree = treeSha([wfBase, codeNew]);

  let mintedUnchanged = 0;
  const normal = publisherFixture(t, {
    taskInput: {},
    installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
    isAppInstallation: true,
    withPermissions: async (_perms, use) => { mintedUnchanged++; return use('unexpected', {}); },
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
  assert.equal(mintedUnchanged, 0, 'unchanged workflows must not mint a workflows: write token');
  assert.ok(normal.requests.some(req => req.method === 'POST' && req.path === '/git/trees'));

  const modWfBytes = Buffer.from('name: CI v2\n');
  const modWf = { path: '.github/workflows/ci.yml', mode: '100644', sha: blobSha(modWfBytes), base64: modWfBytes.toString('base64') };
  const wfTree = treeSha([modWf]);
  let mintedAlready = 0;
  const authorized = publisherFixture(t, {
    taskInput: {},
    installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
    isAppInstallation: true,
    withPermissions: async (_perms, use) => { mintedAlready++; return use('unexpected', {}); },
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
  assert.equal(mintedAlready, 0, 'token already holding workflows: write need not re-mint');
  assert.ok(authorized.requests.some(req => req.method === 'POST' && req.path === '/git/trees'));
});

test('failures.ts classifies github_workflows_permission_missing and legacy workflow_changes_not_confirmed with actionable guidance', () => {
  for (const code of ['workflow_changes_not_confirmed', 'github_workflows_permission_missing']) {
    assert.equal(failureCause(code, 'waiting_permission'), 'github_access');
    assert.equal(automaticState(code, 'waiting_permission'), 'waiting_permission');
    const explained = explainFailure(code, 'waiting_permission');
    assert.equal(explained.cause, 'github_access');
    assert.equal(explained.automatic, false);
    assert.equal(explained.attempt_retry, false);
  }
  assert.match(explainFailure('workflow_changes_not_confirmed', 'waiting_permission').action, /已移除该限制/);
  assert.match(explainFailure('workflow_changes_not_confirmed', 'waiting_permission').action, /点「重试」即可继续/);
  assert.match(explainFailure('github_workflows_permission_missing', 'waiting_permission').action, /Workflows: Read and write/);
});
