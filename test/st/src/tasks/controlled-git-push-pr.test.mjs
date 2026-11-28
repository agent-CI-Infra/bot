import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { GitCache } from '../../../../dist/agent/git-cache.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { GitHub } from '../../../../dist/github/client.js';
import { Publisher } from '../../../../dist/github/publisher.js';
import { pushBranchFromWorkspace } from '../../../../dist/tasks/git-push.js';
import { scanBlobStreaming } from '../../../../dist/github/git-push.js';
import { grantedTaskWrite } from '../../../../dist/tasks/github-write.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { gitServer, git } from '../../../fixtures/git-server.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { workspace as runWorkspace } from '../../../../runner/workspace.mjs';

const call = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Creates a real local bare Git repository served over smart HTTP (`git-server.mjs`) together with a GitHub REST API
 * server reading live refs directly from that bare repository. Supports both `bot_account` and `github_app` modes.
 */
async function createRealGitHubFixture(t, { app = false, installationPermissions = { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bot-real-git-push-'));
  const gitRoot = join(root, 'git-root');
  const bareDir = join(gitRoot, 'fixture', 'repo.git');
  const seedDir = join(root, 'seed');
  mkdirSync(bareDir, { recursive: true });
  mkdirSync(seedDir, { recursive: true });
  git(bareDir, 'init', '--bare', '--initial-branch=main');
  git(bareDir, 'config', 'http.receivepack', 'true');

  git(seedDir, 'init', '--initial-branch=main');
  writeFileSync(join(seedDir, 'calc.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(
    join(seedDir, 'calc.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );
  git(seedDir, 'add', '--all');
  git(seedDir, 'commit', '-m', 'initial commit');
  git(seedDir, 'remote', 'add', 'origin', bareDir);
  git(seedDir, 'push', 'origin', 'main');
  const mainSha = git(bareDir, 'rev-parse', 'refs/heads/main');

  const validTokens = new Set(['fixture-token']);
  const state = {
    prs: [],
    comments: [],
    labels: [],
    treeCreates: 0,
    mintedTokens: [],
    revokedTokens: [],
    installationPermissions: { ...installationPermissions },
    nextPr: 10,
    nextComment: 100,
    gitRequests: [],
  };

  // Serve bare repo with dynamic token validation (accepts base token and minted App tokens).
  const gitHttp = await gitServer(t, gitRoot, app ? tok => validTokens.has(tok) : 'fixture-token');
  state.gitRequests = gitHttp.requests;
  const cloneUrl = `${gitHttp.url}/fixture/repo.git`;

  const readRef = branch => {
    try {
      const sha = git(bareDir, 'rev-parse', '--verify', `refs/heads/${branch}`);
      return sha || null;
    } catch {
      return null;
    }
  };

  const api = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://fixture');
    const path = decodeURIComponent(url.pathname);
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (path === '/user' && req.method === 'GET') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/app' && req.method === 'GET') return send({ id: 77, slug: 'fixture-app' });
    if (path === '/users/fixture-app[bot]' && req.method === 'GET') return send({ id: 999, login: 'fixture-app[bot]' });
    if (path === '/installation/token' && req.method === 'DELETE') {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      validTokens.delete(tok);
      state.revokedTokens.push(tok);
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/app/installations/555/access_tokens' && req.method === 'POST') {
      const requested = body.permissions || {};
      for (const [k, v] of Object.entries(requested)) {
        if (v === 'write' && state.installationPermissions[k] !== 'write') {
          return send({ message: `The permissions requested are not granted to this installation (${k})` }, 422);
        }
      }
      const token = 'ghs_inst_' + randomBytes(12).toString('hex');
      const granted = Object.fromEntries(Object.entries(requested).filter(([k]) => state.installationPermissions[k]));
      validTokens.add(token);
      state.mintedTokens.push({ token, requested, granted });
      return send({ token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: granted }, 201);
    }
    if (path === '/repositories/101' && req.method === 'GET') {
      return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/repo', default_branch: 'main', clone_url: cloneUrl });
    }

    const repoPrefix = '/repos/fixture/repo';
    if (!path.startsWith(repoPrefix)) return send({ message: 'Not Found' }, 404);
    const sub = path.slice(repoPrefix.length);

    if (sub === '/installation' && req.method === 'GET') {
      return send({
        id: 555,
        account: { id: 10, login: 'fixture' },
        events: ['issues', 'pull_request', 'issue_comment'],
        permissions: state.installationPermissions,
      });
    }
    if (sub === '/labels' && req.method === 'GET') return send([]);
    if (sub === '/labels' && req.method === 'POST') return send(body, 201);
    if (sub.startsWith('/labels/') && req.method === 'GET') return send({ message: 'Not Found' }, 404);

    if (sub === '/git/trees' && req.method === 'POST') {
      state.treeCreates++;
      return send({ message: 'Simulated 502 on POST /git/trees' }, 502);
    }

    const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(sub);
    if (refMatch && req.method === 'GET') {
      const sha = readRef(refMatch[1]);
      return sha ? send({ ref: 'refs/heads/' + refMatch[1], object: { sha, type: 'commit' } }) : send({ message: 'Not Found' }, 404);
    }

    const issueMatch = /^\/issues\/(\d+)$/.exec(sub);
    if (issueMatch && req.method === 'GET') {
      const num = Number(issueMatch[1]);
      const pr = state.prs.find(p => p.number === num);
      if (pr) {
        return send({ number: num, title: pr.title, body: pr.body, state: pr.state, pull_request: { url: pr.html_url }, labels: [] });
      }
      return send({ number: num, title: `Issue #${num}: fix add`, body: 'add(2, 3) should return 5', state: 'open', labels: [] });
    }
    const issueComments = /^\/issues\/(\d+)\/comments$/.exec(sub);
    if (issueComments) {
      const num = Number(issueComments[1]);
      if (req.method === 'GET') return send(state.comments.filter(c => c.issue === num));
      const c = { id: state.nextComment++, issue: num, body: body.body, html_url: `https://github.invalid/fixture/repo/issues/${num}#issuecomment-${state.nextComment - 1}`, user: { id: 999 } };
      state.comments.push(c);
      return send(c, 201);
    }
    const editComment = /^\/issues\/comments\/(\d+)$/.exec(sub);
    if (editComment && req.method === 'PATCH') {
      const found = state.comments.find(c => c.id === Number(editComment[1]));
      if (!found) return send({ message: 'Not Found' }, 404);
      found.body = body.body;
      return send(found);
    }
    const issueLabels = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(sub);
    if (issueLabels) {
      if (req.method === 'POST') state.labels.push({ number: Number(issueLabels[1]), labels: body.labels });
      return send([]);
    }

    if (sub === '/pulls' && req.method === 'GET') return send(state.prs);
    if (sub === '/pulls' && req.method === 'POST') {
      const headSha = readRef(body.head);
      if (!headSha) return send({ message: `Head branch ${body.head} not found` }, 422);
      const baseSha = readRef(body.base) || mainSha;
      const num = state.nextPr++;
      const pr = {
        id: 2000 + num,
        number: num,
        state: 'open',
        draft: false,
        title: body.title,
        body: body.body,
        html_url: `https://github.invalid/fixture/repo/pull/${num}`,
        head: { ref: body.head, sha: headSha, repo: { id: 101 } },
        base: { ref: body.base, sha: baseSha },
        user: { id: 999, login: 'fixture-bot' },
        mergeable: true,
        mergeable_state: 'clean',
      };
      state.prs.push(pr);
      return send(pr, 201);
    }
    const prMatch = /^\/pulls\/(\d+)$/.exec(sub);
    if (prMatch) {
      const pr = state.prs.find(p => p.number === Number(prMatch[1]));
      if (!pr) return send({ message: 'Not Found' }, 404);
      if (req.method === 'GET') {
        const liveSha = readRef(pr.head.ref);
        if (liveSha) pr.head.sha = liveSha;
        return send(pr);
      }
      if (req.method === 'PATCH') {
        if (body.title !== undefined) pr.title = body.title;
        if (body.body !== undefined) pr.body = body.body;
        if (body.state !== undefined) pr.state = body.state;
        const liveSha = readRef(pr.head.ref);
        if (liveSha) pr.head.sha = liveSha;
        return send(pr);
      }
    }

    send({ message: `Unhandled ${req.method} ${sub}` }, 404);
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');

  const store = new Store(':memory:', randomBytes(32));
  const computer = new LocalManager('101', join(root, 'computer'));
  const gitCache = new GitCache(join(root, 'cache'));

  t.after(async () => {
    await computer.recover().catch(() => {});
    await new Promise(r => { api.close(r); api.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  if (app) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture-app', 'github_app', '77', store.secrets.seal({ private_key: pem }, 'account:a'), 'now');
  } else {
    store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'fixture-token' }, 'account:a'), 'now');
  }
  store.run("INSERT INTO repositories VALUES('101','fixture/repo','10','a')");
  store.run("INSERT INTO policies(repository_id,enabled,development_enabled,capability_ceiling,test_command) VALUES('101',1,1,'develop','node --test')");
  scriptedRoles(store, '101');

  return { root, bareDir, seedDir, mainSha, cloneUrl, apiUrl, store, computer, gitCache, state, readRef };
}

test('Plan B1 end-to-end: native git commit without manual config, push_bot_branch real git push (0 POST /git/trees), scoped github_write PR creation with hosted media + auto-registration, QA reuse, and bot PR close state sync', { timeout: 240000 }, async t => {
  const fx = await createRealGitHubFixture(t);
  fx.store.run("INSERT OR REPLACE INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://bot.example.test' }));

  let qaCalls = 0;
  let localCommittedSha = null;
  let pushResult = null;
  let scopedRefusals = [];
  let openedPrResult = null;

  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map(x => x.function.name);
    const msgs = body.messages;
    const toolMsgs = msgs.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return { raw: m.content }; } });
    const names = msgs.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(c => c.function.name);
    let message;

    if (tools.includes('submit_acceptance')) {
      qaCalls++;
      message = call('submit_acceptance', { pass: true, issues: [] });
    } else if (tools.includes('delegate_role')) {
      const delegated = toolMsgs.find(r => typeof r.result_ref === 'string');
      message = delegated
        ? call('nominate_delivery', { result_ref: delegated.result_ref })
        : call('delegate_role', { role: 'dev', purpose: 'Fix calc.mjs, commit cleanly, push with push_bot_branch, open PR via github_write, and submit_report', refs: [] });
    } else {
      assert.ok(tools.includes('push_bot_branch') && tools.includes('github_write'), 'dev must receive push_bot_branch and scoped github_write under pull_request grant');
      const step = names.length;
      if (step === 0) {
        // Edit calc.mjs, create an untracked screenshot under .tmp/proof.png, and run plain `git commit` (relying on runner auto-configured git author!).
        const b64 = TINY_PNG.toString('base64');
        message = call('run_command', {
          command: `printf 'export const add = (a, b) => a + b;\\n' > calc.mjs && mkdir -p .tmp && node -e "require('fs').writeFileSync('.tmp/proof.png', Buffer.from('${b64}', 'base64'))" && git add calc.mjs && git commit -m "fix: add sums both numbers" && git rev-parse HEAD`,
        });
      } else if (step === 1) {
        const out = String(toolMsgs.at(-1)?.output || '').trim().split('\n').at(-1).trim();
        localCommittedSha = out;
        assert.match(localCommittedSha, /^[a-f0-9]{40}$/, `expected real git commit sha, got: ${JSON.stringify(toolMsgs.at(-1))}`);
        message = call('push_bot_branch', { test_command: 'node --test', summary: 'Fix add() to sum instead of subtract.' });
      } else if (step === 2) {
        pushResult = toolMsgs.at(-1);
        assert.equal(pushResult.ok, true, JSON.stringify(pushResult));
        assert.equal(pushResult.remote_sha, localCommittedSha, 'remote_sha MUST equal exact local git commit SHA');
        assert.equal(pushResult.branch, 'bot/issue-7');
        // Verify scoped github_write refuses forbidden routes under pull_request-only grant:
        message = call('github_write', { method: 'PUT', path: '/pulls/99/merge', body: {}, key: 'try-merge' });
      } else if (step === 3) {
        scopedRefusals.push(toolMsgs.at(-1));
        message = call('github_write', { method: 'POST', path: '/issues', body: { title: 'nope' }, key: 'try-issue' });
      } else if (step === 4) {
        scopedRefusals.push(toolMsgs.at(-1));
        // Open PR autonomously with hosted workspace media + confirmed remote SHA
        message = call('github_write', {
          method: 'POST',
          path: '/pulls',
          body: {
            title: 'fix: sum both operands in add()',
            head: pushResult.branch,
            base: pushResult.base_branch,
            body: `Fixes #7\n\nVerified at commit \`${pushResult.remote_sha}\`.\n\n![Proof](workspace:.tmp/proof.png)`,
          },
          media: ['.tmp/proof.png'],
          key: 'open-pr-7',
        });
      } else if (step === 5) {
        openedPrResult = toolMsgs.at(-1);
        assert.equal(openedPrResult.number, 10, JSON.stringify(openedPrResult));
        assert.equal(openedPrResult.head.sha, localCommittedSha);
        // Update the bot-owned PR body via PATCH /pulls/10 (keeping latest complete state)
        message = call('github_write', {
          method: 'PATCH',
          path: '/pulls/10',
          body: {
            body: `Fixes #7\n\nLatest complete state at \`${pushResult.remote_sha}\` (node --test passed).\n\n![Proof](workspace:.tmp/proof.png)`,
          },
          media: ['.tmp/proof.png'],
          key: 'update-pr-7-body',
        });
      } else {
        message = call('submit_report', {
          summary: `Opened PR #${openedPrResult.number} on ${pushResult.branch} at ${pushResult.remote_sha}.`,
          artifacts: [{ path: 'calc.mjs', description: 'Fixed add()' }],
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(r => { model.close(r); model.closeAllConnections(); }));

  fx.store.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)',
    'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture',
    fx.store.secrets.seal({ value: 'model-key' }, 'model:m'), 'now',
  );
  fx.store.run("UPDATE policies SET model_id='m' WHERE repository_id='101'");

  const engine = new TaskEngine(fx.store, fx.computer, fx.apiUrl, fx.gitCache);
  t.after(() => engine.close());

  const commands = new TaskCommands(fx.store);
  const operator = { id: 'op', role: 'project_admin', repositories: ['101'] };
  const id = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
    repository_id: '101',
    request: 'Fix Issue #7',
    target: { type: 'issue', number: 7 },
    writes: ['pull_request'],
    contract: { goal: 'Fix add(2, 3) === 5', scope: ['calc.mjs'], criteria: ['node --test passes'], endpoint: 'reviewable_pull_request' },
  }).id;
  fx.store.run("UPDATE tasks SET status='running',claim_token='claim' WHERE id=?", id);
  fx.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", id);
  authorizeKnowledgeTask(fx.store, id);

  await engine.run(id, 'claim');

  const task = fx.store.get('SELECT * FROM tasks WHERE id=?', id);
  assert.equal(task.status, 'pr_opened', JSON.stringify({ status: task.status, error: task.error_code, detail: task.error_detail }));
  const result = JSON.parse(task.result);
  assert.equal(result.pr_number, 10);
  assert.equal(result.branch, 'bot/issue-7');
  assert.equal(result.sha, localCommittedSha);
  assert.equal(result.local_sha, localCommittedSha);

  // Zero POST /git/trees calls were made — everything went through real git push!
  assert.equal(fx.state.treeCreates, 0, 'real git push must never call POST /git/trees');
  assert.equal(fx.readRef('bot/issue-7'), localCommittedSha, 'remote bare repo ref MUST match local commit SHA');
  // Untracked .tmp/proof.png was NOT committed into the pushed tree AND NOT listed in the settled code candidate artifact
  const pushedFiles = git(fx.bareDir, 'ls-tree', '-r', '--name-only', localCommittedSha).split('\n').filter(Boolean).sort();
  assert.ok(!pushedFiles.includes('.tmp/proof.png'), 'untracked screenshot must not pollute pushed git commit');
  const settledCodeArtifact = new TaskRecords(fx.store).get(id).candidate?.artifacts?.find(a => a.kind === 'code');
  assert.ok(settledCodeArtifact, 'settled candidate must include code artifact');
  assert.deepEqual(
    (settledCodeArtifact.content.files || []).map(f => f.path).sort(),
    pushedFiles,
    'settled code artifact files must exactly match the pushed commit tree without untracked files',
  );
  assert.equal(settledCodeArtifact.content.commit_ancestry_verified, true);

  // QA ran exactly ONCE inside push_bot_branch and was reused on submit_report
  assert.equal(qaCalls, 1, 'push-gate QA verdict should be reused without duplicate QA run');

  // Scoped github_write refused non-bot-PR routes cleanly
  assert.equal(scopedRefusals.length, 2);
  assert.equal(scopedRefusals[0].error, 'github_write_scope_forbidden');
  assert.equal(scopedRefusals[1].error, 'github_write_scope_forbidden');

  // PR body has hosted /pr-media/ URL + updated latest complete state
  assert.equal(fx.state.prs.length, 1);
  assert.match(fx.state.prs[0].body, /Latest complete state/);
  assert.match(fx.state.prs[0].body, /https:\/\/bot\.example\.test\/pr-media\//);

  // bot_pull_requests & bot_pr_states were automatically registered and synced by github_write
  const botPr = fx.store.get("SELECT * FROM bot_pull_requests WHERE repository_id='101' AND number=10");
  assert.ok(botPr, 'github_write POST /pulls must auto-register bot_pull_requests');
  assert.equal(botPr.source_task_id, id);
  assert.equal(botPr.branch, 'bot/issue-7');
  assert.equal(botPr.sha, localCommittedSha);
  const prState = fx.store.get("SELECT * FROM bot_pr_states WHERE repository_id='101' AND number=10");
  assert.equal(prState?.state, 'open');
  assert.equal(prState?.head_sha, localCommittedSha);

  // Issue progress comment settled with PR #10 link and bot-developed label
  const progressComment = fx.state.comments.find(c => c.issue === 7);
  assert.ok(progressComment && progressComment.body.includes('#10'), 'Issue progress comment must reference PR #10');
  assert.ok(fx.state.labels.some(l => l.number === 7 && l.labels.includes('bot-developed')));

  // Closing bot PR via github_write PATCH /pulls/10 automatically updates bot_pr_states to closed
  const gw = grantedTaskWrite(fx.store, task, new Redactor(), async () => {}, fx.apiUrl);
  const closed = await gw('github_write', { method: 'PATCH', path: '/pulls/10', body: { state: 'closed' }, key: 'close-bot-pr-10' });
  assert.equal(closed.state, 'closed', JSON.stringify(closed));
  assert.equal(fx.store.get("SELECT state FROM bot_pr_states WHERE repository_id='101' AND number=10")?.state, 'closed');
});

test('push_bot_branch enforces force_with_lease, stale lease, dirty tree, branch ownership, HEAD drift, commit-range secret/dirty/key/conflict scans, and on-demand workflows:write permission', { timeout: 240000 }, async t => {
  const fx = await createRealGitHubFixture(t, {
    app: true,
    installationPermissions: { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' },
  });
  const redactor = new Redactor();
  const fakeSecret = 'sk_live_SUPERSECRET_CONTROL_PLANE_999999';
  redactor.add(fakeSecret);

  const commands = new TaskCommands(fx.store);
  const operator = { id: 'op', role: 'project_admin', repositories: ['101'] };
  const taskId = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
    repository_id: '101',
    request: 'Test security boundaries',
    target: { type: 'issue', number: 20 },
    writes: ['pull_request'],
    contract: { goal: 'Security boundary checks', scope: ['calc.mjs'], criteria: ['pass'], endpoint: 'reviewable_pull_request' },
  }).id;
  const task = fx.store.get('SELECT * FROM tasks WHERE id=?', taskId);
  const env = await fx.computer.call('PUT', '/v1/projects/101');
  const workspaceId = randomBytes(24).toString('hex');
  fx.store.run("UPDATE tasks SET status='running',claim_token='claim',generation=?,workspace_id=?,head_sha=? WHERE id=?", env.generation, workspaceId, fx.mainSha, taskId);
  fx.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", taskId);
  Object.assign(task, fx.store.get('SELECT * FROM tasks WHERE id=?', taskId));

  const workspace = new Workspace(fx.store, fx.computer, task, redactor, async () => {}, () => {});
  const github = new GitHub(fx.store, fx.store.get("SELECT * FROM repositories WHERE id='101'"), redactor, async () => {}, fx.apiUrl);
  await github.connect(false, undefined, { contents: 'read' });
  const mirror = await fx.gitCache.open('101', { url: fx.cloneUrl, token: github.token, commits: [fx.mainSha], refs: ['refs/heads/main'] });
  const snap = await workspace.bind(github, fx.mainSha, mirror, [], 'write');
  await github.revokeTokens('test');
  assert.ok(snap, 'workspace bound as git worktree');
  const taskInput = { ...JSON.parse(task.input || '{}'), target: { type: 'issue', number: 20 }, base_branch: 'main', default_branch: 'main', snapshot_sha: fx.mainSha, workspace_base_head_sha: fx.mainSha, snapshot_files: snap.files };
  fx.store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify(taskInput), taskId);
  task.input = JSON.stringify(taskInput);

  const runCmd = cmd => workspace.call('cmd:' + randomBytes(6).toString('hex'), { type: 'workspace_command', command: cmd });
  const push = (args = {}) => pushBranchFromWorkspace({
    store: fx.store, task, input: taskInput, workspace, redactor, guard: async () => {}, log: () => {},
    apiUrl: fx.apiUrl, gitCache: fx.gitCache, budgetRole: 'dev', args, execution: 'exec-1', skipGates: true,
  });

  // 1. Forbidden branch names
  const badMain = await push({ branch: 'main' });
  assert.equal(badMain.error, 'branch_not_owned');
  const badOther = await push({ branch: 'feature/not-bot' });
  assert.equal(badOther.error, 'branch_not_owned');

  // 2. Uncommitted tracked change rejected
  await runCmd("printf 'export const add = (a, b) => a + b;\\n' > calc.mjs");
  const dirtyTracked = await push();
  assert.equal(dirtyTracked.error, 'uncommitted_tracked_changes');

  // 3. Clean commit pushed to bot/issue-20
  await runCmd('git add calc.mjs && git commit -m "fix: add"');
  const c1 = (await runCmd('git rev-parse HEAD')).output.trim();
  const ok1 = await push({ expected_remote_sha: '' });
  assert.equal(ok1.ok, true, JSON.stringify(ok1));
  assert.equal(ok1.remote_sha, c1);
  assert.equal(fx.readRef('bot/issue-20'), c1);

  // 4. Stale expected_remote_sha refused
  const stale = await push({ expected_remote_sha: fx.mainSha });
  assert.equal(stale.error, 'branch_head_changed');

  // 5. Rebase onto advanced main: refused without force_with_lease, succeeds with force_with_lease
  writeFileSync(join(fx.seedDir, 'README.md'), 'upstream advance\n');
  git(fx.seedDir, 'add', 'README.md');
  git(fx.seedDir, 'commit', '-m', 'main advance');
  git(fx.seedDir, 'push', 'origin', 'main');
  const newMainSha = fx.readRef('main');
  // Amend local commit on top of main (non-FF relative to c1)
  await runCmd('git commit --amend -m "fix: add (amended)"');
  const amendedSha = (await runCmd('git rev-parse HEAD')).output.trim();
  assert.notEqual(amendedSha, c1);
  const nonFf = await push();
  assert.equal(nonFf.error, 'non_fast_forward', JSON.stringify(nonFf));
  const okForce = await push({ force_with_lease: true, expected_remote_sha: c1 });
  assert.equal(okForce.ok, true, JSON.stringify(okForce));
  assert.equal(okForce.forced, true);
  assert.equal(fx.readRef('bot/issue-20'), amendedSha);
  void newMainSha;

  // 6. Registered secret committed in commit N and deleted in commit N+1 is STILL blocked by commit-range scan!
  // Construct the secret inside the container via split printf arguments so workspace.call redaction does not scrub the command itself.
  const secretHalfA = fakeSecret.slice(0, 16);
  const secretHalfB = fakeSecret.slice(16);
  await runCmd(`printf 'const k = "%s%s";\\n' '${secretHalfA}' '${secretHalfB}' > leak.mjs && git add leak.mjs && git commit -m "add secret" && git rm -q leak.mjs && git commit -m "remove secret"`);
  const secretRefused = await push();
  assert.equal(secretRefused.error, 'push_preflight_failed', JSON.stringify(secretRefused));
  assert.ok(secretRefused.issues.some(i => i.includes('Registered secret')), JSON.stringify(secretRefused.issues));
  await runCmd(`git reset --hard ${amendedSha}`);

  // 7. Dirty file (.env.local) refused
  await runCmd("printf 'FOO=bar\\n' > .env.local && git add -f .env.local && git commit -m 'dirty env'");
  const dirtyEnv = await push();
  assert.equal(dirtyEnv.error, 'push_preflight_failed');
  assert.ok(dirtyEnv.issues.some(i => i.includes('.env.local')));
  await runCmd(`git reset --hard ${amendedSha}`);

  // 8. Private key block refused in non-test file, allowed in test fixture file
  await runCmd("printf -- '-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n' > src_key.txt && git add src_key.txt && git commit -m 'key in src'");
  const keyRefused = await push();
  assert.equal(keyRefused.error, 'push_preflight_failed');
  assert.ok(keyRefused.issues.some(i => i.includes('Private key block')));
  await runCmd(`git reset --hard ${amendedSha}`);

  await runCmd("mkdir -p test && printf -- '-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n' > test/key.test.mjs && git add test/key.test.mjs && git commit -m 'test fixture key'");
  const fixtureAllowed = await push();
  assert.equal(fixtureAllowed.ok, true, JSON.stringify(fixtureAllowed));
  const afterFixtureSha = fixtureAllowed.remote_sha;

  // 9. Unresolved conflict markers refused
  await runCmd("printf '<<<<<<< HEAD\\na\\n=======\\nb\\n>>>>>>> main\\n' > calc.mjs && git add calc.mjs && git commit -m 'markers'");
  const markersRefused = await push();
  assert.equal(markersRefused.error, 'push_preflight_failed');
  assert.ok(markersRefused.issues.some(i => i.includes('conflict markers')));
  await runCmd(`git reset --hard ${afterFixtureSha}`);

  // 10. Unrelated orphan branch refused as workspace_head_drifted
  await runCmd("git checkout --orphan orphan-branch && git rm -rf -q . && printf 'hi\\n' > orphan.txt && git add orphan.txt && git commit -m 'orphan'");
  const orphanRefused = await push({ force_with_lease: true });
  assert.equal(orphanRefused.error, 'workspace_head_drifted', JSON.stringify(orphanRefused));
  await runCmd(`git checkout --detach ${afterFixtureSha}`);

  // 11. `.github/workflows/` commit: blocked with waiting_permission when App lacks workflows:write, succeeds when granted + revokes short-lived token
  await runCmd("mkdir -p .github/workflows && printf 'name: ci\\non: push\\njobs:\\n  t:\\n    runs-on: ubuntu-latest\\n    steps: []\\n' > .github/workflows/ci.yml && git add .github/workflows/ci.yml && git commit -m 'ci: add workflow'");
  const wfSha = (await runCmd('git rev-parse HEAD')).output.trim();
  const mintedBefore = fx.state.mintedTokens.length;
  await assert.rejects(() => push(), err => err.code === 'github_workflows_permission_missing' && err.state === 'waiting_permission');
  assert.equal(fx.readRef('bot/issue-20'), afterFixtureSha, 'workflow commit must NOT be pushed without workflows:write');

  // Now grant workflows: write on the installation and retry!
  fx.state.installationPermissions.workflows = 'write';
  const wfOk = await push();
  assert.equal(wfOk.ok, true, JSON.stringify(wfOk));
  assert.deepEqual(wfOk.workflow_files, ['.github/workflows/ci.yml']);
  assert.equal(fx.readRef('bot/issue-20'), wfSha);
  const wfMint = fx.state.mintedTokens.slice(mintedBefore).find(m => m.requested.workflows === 'write');
  assert.ok(wfMint, 'must mint on-demand workflows:write token right before pushing workflow commit');
  assert.ok(fx.state.revokedTokens.includes(wfMint.token), 'short-lived push token must be revoked in finally');
});

test('push_bot_branch blocks push on failing test_command or QA rejection; legacy Publisher.branch uses real git push; workspace_verify_merge rejects unmerged edits with base_not_integrated', { timeout: 240000 }, async t => {
  const fx = await createRealGitHubFixture(t);
  let qaOutcome = 'return';

  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map(x => x.function.name);
    assert.ok(tools.includes('submit_acceptance'));
    const message = qaOutcome === 'return'
      ? call('submit_acceptance', { pass: false, issues: ['Missing edge case test'] })
      : call('submit_acceptance', { pass: true, issues: [] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(r => { model.close(r); model.closeAllConnections(); }));

  fx.store.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)',
    'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture',
    fx.store.secrets.seal({ value: 'model-key' }, 'model:m'), 'now',
  );
  fx.store.run("UPDATE policies SET model_id='m' WHERE repository_id='101'");

  const commands = new TaskCommands(fx.store);
  const operator = { id: 'op', role: 'project_admin', repositories: ['101'] };
  const taskId = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
    repository_id: '101',
    request: 'Gate checks',
    target: { type: 'issue', number: 30 },
    writes: ['pull_request'],
    contract: { goal: 'Fix calc.mjs', scope: ['calc.mjs'], criteria: ['node --test passes'], endpoint: 'reviewable_pull_request' },
  }).id;
  const task = fx.store.get('SELECT * FROM tasks WHERE id=?', taskId);
  const env = await fx.computer.call('PUT', '/v1/projects/101');
  const workspaceId = randomBytes(24).toString('hex');
  fx.store.run("UPDATE tasks SET status='running',claim_token='claim',generation=?,workspace_id=?,head_sha=? WHERE id=?", env.generation, workspaceId, fx.mainSha, taskId);
  fx.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", taskId);
  Object.assign(task, fx.store.get('SELECT * FROM tasks WHERE id=?', taskId));

  const redactor = new Redactor();
  const workspace = new Workspace(fx.store, fx.computer, task, redactor, async () => {}, () => {});
  const github = new GitHub(fx.store, fx.store.get("SELECT * FROM repositories WHERE id='101'"), redactor, async () => {}, fx.apiUrl);
  await github.connect(true);
  const mirror = await fx.gitCache.open('101', { url: fx.cloneUrl, token: github.token, commits: [fx.mainSha], refs: ['refs/heads/main'] });
  const snap = await workspace.bind(github, fx.mainSha, mirror, [], 'write');
  const taskInput = { ...JSON.parse(task.input || '{}'), target: { type: 'issue', number: 30 }, base_branch: 'main', default_branch: 'main', snapshot_sha: fx.mainSha, workspace_base_head_sha: fx.mainSha, snapshot_files: snap.files };
  fx.store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify(taskInput), taskId);
  task.input = JSON.stringify(taskInput);

  const runCmd = cmd => workspace.call('cmd:' + randomBytes(6).toString('hex'), { type: 'workspace_command', command: cmd });
  const push = () => pushBranchFromWorkspace({
    store: fx.store, task, input: taskInput, workspace, redactor, guard: async () => {}, log: () => {},
    apiUrl: fx.apiUrl, gitCache: fx.gitCache, budgetRole: 'dev', args: {}, execution: 'exec-gate',
  });

  // 1. Failing test_command blocks push
  await runCmd("printf 'export const add = (a, b) => a * b;\\n' > calc.mjs && git add calc.mjs && git commit -m 'broken add'");
  const testFail = await push();
  assert.equal(testFail.error, 'policy_test_failed', JSON.stringify(testFail));
  assert.equal(fx.readRef('bot/issue-30'), null, 'failing test_command must block push');

  // 2. Passing test_command but QA rejects -> blocks push
  await runCmd("printf 'export const add = (a, b) => a + b;\\n' > calc.mjs && git add calc.mjs && git commit -m 'fix add'");
  const qaFail = await push();
  assert.equal(qaFail.error, 'qa_rejected', JSON.stringify(qaFail));
  assert.equal(fx.readRef('bot/issue-30'), null, 'QA rejection must block push');

  // 3. QA passes -> pushes cleanly!
  qaOutcome = 'pass';
  const qaOk = await push();
  assert.equal(qaOk.ok, true, JSON.stringify(qaOk));
  assert.equal(fx.readRef('bot/issue-30'), qaOk.remote_sha);

  // 4. Legacy Publisher.branch with gitCache pushes via real git push with ZERO POST /git/trees calls!
  const legacyBranch = 'bot/issue-31';
  fx.store.run('INSERT INTO bot_branches VALUES(?,?,?)', '101', legacyBranch, taskId);
  const fixedBytes = Buffer.from('export const add = (a, b) => a + b; // legacy-git-push\n');
  const fixedSha = createHash('sha1').update(`blob ${fixedBytes.length}\0`).update(fixedBytes).digest('hex');
  const updatedFiles = snap.files.map(f => f.path === 'calc.mjs' ? { path: 'calc.mjs', mode: '100644', sha: fixedSha, base64: fixedBytes.toString('base64') } : { ...f });
  // Compute exact tree sha via temporary index update in seedDir
  writeFileSync(join(fx.seedDir, 'calc.mjs'), fixedBytes);
  git(fx.seedDir, 'add', 'calc.mjs');
  const legacyTreeSha = git(fx.seedDir, 'write-tree');
  git(fx.seedDir, 'checkout', '--', 'calc.mjs');

  const publisher = new Publisher(fx.store, github, task, async () => {}, undefined, () => {}, undefined, 'legacy-git-push', fx.gitCache);
  const legacyCommit = await publisher.branch({
    branch: legacyBranch,
    owner_task_id: taskId,
    files: updatedFiles,
    snapshot_files: snap.files,
    skipped_files: [],
    source_tree: snap.source_tree_sha,
    tree_sha: legacyTreeSha,
    base_sha: fx.mainSha,
    expected_sha: null,
    summary: 'Legacy candidate pushed via real git push',
    change_title: 'fix: legacy git push path',
    date: '2026-11-28T00:00:00.000Z',
  });
  assert.match(legacyCommit, /^[a-f0-9]{40}$/);
  assert.equal(fx.readRef(legacyBranch), legacyCommit);
  assert.equal(fx.state.treeCreates, 0, 'Publisher.branch with gitCache must bypass POST /git/trees via real git push');

  // 5. Direct workspace_verify_merge regression check: editing a file WITHOUT merging/rebasing base MUST return base_not_integrated
  const wsRoot = join(fx.root, 'verify-merge-ws');
  const gitStore = join(wsRoot, 'git');
  const tasksDir = join(wsRoot, 'tasks');
  const notesDir = join(wsRoot, 'notes');
  const wtDir = join(wsRoot, 'worktrees');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(wtDir, { recursive: true });
  const wsId = 'b'.repeat(48);
  const repoDir = join(tasksDir, wsId, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '--initial-branch=main');
  writeFileSync(join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, 'add', 'a.txt');
  git(repoDir, 'commit', '-m', 'root');
  const rootCommit = git(repoDir, 'rev-parse', 'HEAD');
  git(repoDir, 'checkout', '-b', 'pr');
  writeFileSync(join(repoDir, 'a.txt'), 'pr change\n');
  git(repoDir, 'add', 'a.txt');
  git(repoDir, 'commit', '-m', 'pr commit');
  const prCommit = git(repoDir, 'rev-parse', 'HEAD');
  const prTree = git(repoDir, 'rev-parse', 'HEAD^{tree}');
  git(repoDir, 'checkout', 'main');
  writeFileSync(join(repoDir, 'b.txt'), 'main advance\n');
  git(repoDir, 'add', 'b.txt');
  git(repoDir, 'commit', '-m', 'main commit');
  const mainCommit = git(repoDir, 'rev-parse', 'HEAD');
  // Switch back to PR head and modify an unrelated file WITHOUT merging or rebasing main!
  git(repoDir, 'checkout', 'pr');
  writeFileSync(join(repoDir, 'a.txt'), 'pr tweak without integrating main\n');

  const verifyRes = await runWorkspace(
    { type: 'workspace_verify_merge', workspace_id: wsId, base_sha: mainCommit, head_sha: prCommit, head_tree_sha: prTree },
    tasksDir, gitStore, notesDir, wtDir,
  );
  assert.equal(verifyRes.ok, false, 'editing a file without integrating base_sha must NOT return ok:true');
  assert.equal(verifyRes.reason, 'base_not_integrated', JSON.stringify(verifyRes));
  assert.equal(verifyRes.git_merged, false);
  assert.equal(verifyRes.rebased, false);
  void rootCommit;
});

test('Review hardening: fail-closed ancestry, stale closed PR never settled/reopened, post-push edits blocked, short-secret >=8 filter, and streaming cross-chunk scan', { timeout: 240000 }, async t => {
  const fx = await createRealGitHubFixture(t);
  // Seed a prior closed PR #10 from task-old on deterministic branch bot/issue-40
  const closedPr = {
    id: 2010,
    number: 10,
    state: 'closed',
    draft: false,
    title: 'Closed by human',
    body: 'old closed PR',
    html_url: 'https://github.invalid/fixture/repo/pull/10',
    head: { ref: 'bot/issue-40', sha: fx.mainSha, repo: { id: 101 } },
    base: { ref: 'main', sha: fx.mainSha },
    user: { id: 999, login: 'fixture-bot' },
    mergeable: false,
    mergeable_state: 'dirty',
  };
  fx.state.prs.push(closedPr);
  fx.state.nextPr = 11;
  fx.store.run("INSERT INTO bot_branches(repository_id,branch,task_id) VALUES('101','bot/issue-40','task-old')");
  fx.store.run(
    "INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',10,'2010','999','101','bot/issue-40',?,'task-old',0)",
    fx.mainSha,
  );
  fx.store.run(
    "INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,base_sha,head_sha,mergeable,mergeable_state,title,html_url,updated_at) VALUES('101',10,'closed',0,'main',?,?,0,'dirty','Closed by human','https://github.invalid/fixture/repo/pull/10','now')",
    fx.mainSha,
    fx.mainSha,
  );

  // 1. Drive real runRequest (TaskEngine): reclaim bot/issue-40, push, make a post-push tracked edit -> submit_report MUST refuse unpushed_workspace_changes,
  //    then revert tracked edit and call submit_report WITHOUT POST /pulls -> MUST NOT settle as pr_opened pointing to closed PR #10!
  let devTurn = 0;
  let sawUnpushedError = false;
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map(x => x.function.name);
    const msgs = body.messages ?? [];
    const toolMsgs = msgs.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return { raw: m.content }; } });
    let message;
    if (tools.includes('submit_acceptance')) {
      message = call('submit_acceptance', { pass: true, issues: [] });
    } else if (tools.includes('delegate_role')) {
      const delegated = toolMsgs.find(r => typeof r.result_ref === 'string');
      message = delegated
        ? call('nominate_delivery', { result_ref: delegated.result_ref })
        : call('delegate_role', { role: 'dev', purpose: 'Fix calc.mjs on reclaimed bot/issue-40', refs: [] });
    } else {
      devTurn++;
      if (msgs.some(m => m.role === 'tool' && String(m.content || '').includes('unpushed_workspace_changes'))) {
        sawUnpushedError = true;
      }
      if (devTurn === 1) {
        message = call('run_command', {
          command: "printf 'export const add = (a, b) => a + b;\\n' > calc.mjs && git add calc.mjs && git commit -m 'fix: issue 40'",
        });
      } else if (devTurn === 2) {
        message = call('push_bot_branch', { summary: 'Fix add for issue 40' });
      } else if (devTurn === 3) {
        // Post-push tracked edit (uncommitted) that MUST NOT be silently dropped on submit_report
        message = call('run_command', {
          command: "printf 'export const add = (a, b) => a + b + 0;\\n' > calc.mjs",
        });
      } else if (devTurn === 4) {
        message = call('submit_report', {
          summary: 'Attempt submit with unpushed tracked edits',
          artifacts: [],
        });
      } else if (devTurn === 5) {
        // Revert unintended post-push tracked edit
        message = call('run_command', { command: 'git checkout -- calc.mjs' });
      } else {
        // Finish with submit_report WITHOUT opening a new PR (only closed PR #10 exists on bot/issue-40)
        message = call('submit_report', {
          summary: 'Pushed branch without opening a new PR after closed PR #10',
          artifacts: [],
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(r => { model.close(r); model.closeAllConnections(); }));

  fx.store.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)',
    'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture',
    fx.store.secrets.seal({ value: 'model-key' }, 'model:m'), 'now',
  );
  fx.store.run("UPDATE policies SET model_id='m' WHERE repository_id='101'");

  const engine = new TaskEngine(fx.store, fx.computer, fx.apiUrl, fx.gitCache);
  t.after(() => engine.close());
  const commands = new TaskCommands(fx.store);
  const operator = { id: 'op', role: 'project_admin', repositories: ['101'] };
  const taskId = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
    repository_id: '101',
    request: 'Fix Issue #40',
    target: { type: 'issue', number: 40 },
    writes: ['pull_request'],
    contract: { goal: 'Fix add(2, 3) === 5', scope: ['calc.mjs'], criteria: ['node --test passes'], endpoint: 'reviewable_pull_request' },
  }).id;
  fx.store.run("UPDATE tasks SET status='running',claim_token='claim' WHERE id=?", taskId);
  fx.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", taskId);
  authorizeKnowledgeTask(fx.store, taskId);

  await engine.run(taskId, 'claim');

  const settled = fx.store.get('SELECT * FROM tasks WHERE id=?', taskId);
  assert.equal(sawUnpushedError, true, 'submit_report after post-push tracked edits must be rejected with unpushed_workspace_changes');
  assert.notEqual(settled.status, 'pr_opened', 'reclaimed branch with only a closed PR must NEVER settle as pr_opened');
  assert.equal(settled.status, 'completed', JSON.stringify({ status: settled.status, error: settled.error_code }));
  const settledRes = JSON.parse(settled.result || '{}');
  assert.equal(settledRes.delivery, 'report');
  assert.equal(settledRes.pr_number, undefined);

  // 2. Direct pushBranchFromWorkspace checks:
  //    (a) Stale input.bot_pr snapshot MUST NOT overwrite live closed bot_pr_states
  //    (b) already_up_to_date MUST report commit_ancestry_verified: false
  //    (c) Short <8-char secret in redactor MUST NOT falsely block code pushes
  //    (d) Orphan history with no resolvable baseline commit MUST fail closed (baseline_ancestry_unverifiable)
  const task2Id = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
    repository_id: '101',
    request: 'Direct hardening checks',
    target: { type: 'issue', number: 40 },
    writes: ['pull_request'],
    contract: { goal: 'Verify push hardening', scope: ['calc.mjs'], criteria: ['node --test passes'], endpoint: 'reviewable_pull_request' },
  }).id;
  const env = await fx.computer.call('PUT', '/v1/projects/101');
  const wsId = randomBytes(24).toString('hex');
  fx.store.run("UPDATE tasks SET status='running',claim_token='claim2',generation=?,workspace_id=?,head_sha=? WHERE id=?", env.generation, wsId, fx.mainSha, task2Id);
  fx.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim2','now')", task2Id);
  const task2 = fx.store.get('SELECT * FROM tasks WHERE id=?', task2Id);

  const redactor = new Redactor();
  const workspace = new Workspace(fx.store, fx.computer, task2, redactor, async () => {}, () => {});
  const github = new GitHub(fx.store, fx.store.get("SELECT * FROM repositories WHERE id='101'"), redactor, async () => {}, fx.apiUrl);
  await github.connect(true);
  const mirror = await fx.gitCache.open('101', { url: fx.cloneUrl, token: github.token, commits: [fx.mainSha], refs: ['refs/heads/main'] });
  const snap = await workspace.bind(github, fx.mainSha, mirror, [], 'write');
  const staleTaskInput = {
    ...JSON.parse(task2.input || '{}'),
    target: { type: 'issue', number: 40 },
    base_branch: 'main',
    default_branch: 'main',
    snapshot_sha: fx.mainSha,
    workspace_base_head_sha: fx.mainSha,
    snapshot_files: snap.files,
    // Stale open snapshot taken before human closed PR #10
    bot_pr: { number: 10, state: 'open', draft: false, title: 'Stale open title', html_url: 'https://github.invalid/fixture/repo/pull/10', head: { ref: 'bot/issue-40', sha: fx.mainSha }, base: { ref: 'main', sha: fx.mainSha }, mergeable: true, mergeable_state: 'clean' },
  };
  fx.store.run('UPDATE tasks SET input=? WHERE id=?', JSON.stringify(staleTaskInput), task2Id);
  task2.input = JSON.stringify(staleTaskInput);

  const runCmd = cmd => workspace.call('cmd:' + randomBytes(6).toString('hex'), { type: 'workspace_command', command: cmd });
  const commitOut = await runCmd("printf 'export const add = (a, b) => a + b; // bar42\\n' > calc.mjs && git add calc.mjs && git commit -m 'fix: second commit'");
  assert.equal(commitOut.exit_code, 0, JSON.stringify(commitOut));
  // Register a short (< 8 char) value that actually appears in calc.mjs; must NOT falsely block push.
  redactor.addExact('bar42');

  const push2 = await pushBranchFromWorkspace({
    store: fx.store, task: task2, input: staleTaskInput, workspace, redactor, guard: async () => {}, log: () => {},
    apiUrl: fx.apiUrl, gitCache: fx.gitCache, budgetRole: 'dev', args: { force_with_lease: true }, execution: 'exec-stale', skipGates: true,
  });
  assert.equal(push2.ok, true, JSON.stringify(push2));
  assert.equal(push2.commit_ancestry_verified, true);
  assert.equal(push2.existing_pr_number, null, 'live closed PR #10 must not be reported as active existing_pr_number');
  assert.equal(push2.closed_pr_number, 10);
  const stateAfterPush = fx.store.get("SELECT state,title FROM bot_pr_states WHERE repository_id='101' AND number=10");
  assert.equal(stateAfterPush?.state, 'closed', 'stale input.bot_pr must NEVER revert live closed bot_pr_states back to open');
  assert.equal(stateAfterPush?.title, 'Closed by human');

  // Repeating push on same HEAD hits already_up_to_date AND proves baseline ancestry in the control-plane mirror!
  const upToDate = await pushBranchFromWorkspace({
    store: fx.store, task: task2, input: staleTaskInput, workspace, redactor, guard: async () => {}, log: () => {},
    apiUrl: fx.apiUrl, gitCache: fx.gitCache, budgetRole: 'dev', args: {}, execution: 'exec-stale-2', skipGates: true,
  });
  assert.equal(upToDate.ok, true, JSON.stringify(upToDate));
  assert.equal(upToDate.already_up_to_date, true);
  assert.equal(upToDate.commit_ancestry_verified, true, 'already_up_to_date must verify baseline ancestry in the control-plane mirror');
  assert.ok(Array.isArray(upToDate._pushed_files) && upToDate._pushed_files.some(f => f.path === 'calc.mjs'));

  // Without gitCache (ancestry unprovable), already_up_to_date fails closed with baseline_ancestry_unverifiable
  const upToDateNoCache = await pushBranchFromWorkspace({
    store: fx.store, task: task2, input: staleTaskInput, workspace, redactor, guard: async () => {}, log: () => {},
    apiUrl: fx.apiUrl, gitCache: undefined, budgetRole: 'dev', args: {}, execution: 'exec-stale-nocache', skipGates: true,
  });
  assert.equal(upToDateNoCache.error, 'baseline_ancestry_unverifiable', JSON.stringify(upToDateNoCache));

  // Fail-closed baseline ancestry: orphan commit with NO gitCache (baseline unresolvable in staging repo) MUST be refused!
  await runCmd("git checkout --orphan orphan-branch && printf 'export const add = (a, b) => a + b;\\n' > calc.mjs && git add calc.mjs && git commit -m 'orphan commit'");
  const orphanInput = { ...staleTaskInput, bot_pr: undefined };
  const orphanPush = await pushBranchFromWorkspace({
    store: fx.store, task: task2, input: orphanInput, workspace, redactor, guard: async () => {}, log: () => {},
    apiUrl: fx.apiUrl, gitCache: undefined, budgetRole: 'dev', args: { branch: 'bot/orphan-test' }, execution: 'exec-orphan', skipGates: true,
  });
  assert.equal(orphanPush.error, 'baseline_ancestry_unverifiable', JSON.stringify(orphanPush));
  assert.equal(fx.readRef('bot/orphan-test'), null, 'orphan commit with unverifiable baseline must never be pushed');

  // 3. Streaming blob scan detects a registered secret straddling the 64 KiB pipe chunk boundary without loading full file as text
  const boundarySecret = 'boundary-secret-token-9876543210';
  const bigBuf = Buffer.concat([Buffer.alloc(65530, 0x61), Buffer.from(boundarySecret), Buffer.alloc(70000, 0x62)]);
  const bigFile = join(fx.root, 'big-blob.bin');
  writeFileSync(bigFile, bigBuf);
  const writtenBigSha = git(fx.bareDir, 'hash-object', '-w', bigFile);
  const streamRes = await scanBlobStreaming(fx.bareDir, writtenBigSha, bigBuf.length, {
    needles: [Buffer.from(boundarySecret)],
    maxTextBytes: 1024, // force streaming-only path (smaller than bigBuf.length)
    checkPrivateKey: true,
    checkConflictMarkers: true,
  });
  assert.equal(streamRes.secretHit, true, 'streaming blob scan must detect secret straddling chunk boundaries');
});

test('Resumed runRequest hitting already_up_to_date with untracked workspace media settles pr_opened without HEAD drift or workspace_changed', { timeout: 240000 }, async t => {
  const fx = await createRealGitHubFixture(t);
  fx.store.run("INSERT OR REPLACE INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://bot.example.test' }));

  let executionPhase = 1;
  let exec1DevStep = 0;
  let exec2DevStep = 0;
  let committedSha = null;
  let exec2PushResult = null;
  let qaRuns = 0;

  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map(x => x.function.name);
    const msgs = body.messages ?? [];
    const toolMsgs = msgs.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return { raw: m.content }; } });
    let message;

    if (tools.includes('submit_acceptance')) {
      qaRuns++;
      message = call('submit_acceptance', { pass: true, issues: [] });
    } else if (tools.includes('delegate_role')) {
      const delegated = toolMsgs.find(r => typeof r.result_ref === 'string');
      message = delegated
        ? call('nominate_delivery', { result_ref: delegated.result_ref })
        : call('delegate_role', { role: 'dev', purpose: 'Commit, push, open PR, and settle', refs: [] });
    } else if (executionPhase === 1) {
      exec1DevStep++;
      if (exec1DevStep === 1) {
        const b64 = TINY_PNG.toString('base64');
        message = call('run_command', {
          command: `printf 'export const add = (a, b) => a + b;\\n' > calc.mjs && mkdir -p .tmp && node -e "require('fs').writeFileSync('.tmp/proof.png', Buffer.from('${b64}', 'base64'))" && git add calc.mjs && git commit -m "fix: resume test" && git rev-parse HEAD`,
        });
      } else if (exec1DevStep === 2) {
        committedSha = String(toolMsgs.at(-1)?.output || '').trim().split('\n').at(-1).trim();
        message = call('push_bot_branch', { summary: 'Fix add for issue 50' });
      } else if (exec1DevStep === 3) {
        message = call('github_write', {
          method: 'POST',
          path: '/pulls',
          body: {
            title: 'fix: issue 50',
            head: 'bot/issue-50',
            base: 'main',
            body: `Fixes #50 at \`${committedSha}\`\n\n![Proof](workspace:.tmp/proof.png)`,
          },
          media: ['.tmp/proof.png'],
          key: 'open-pr-50',
        });
      } else {
        // Simulate immediate unretried interruption BEFORE submit_report completes (401 avoids 503 retry backoff)
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'simulated worker crash before submit_report' } }));
        return;
      }
    } else {
      exec2DevStep++;
      if (exec2DevStep === 1) {
        // Fresh execution with empty pushSession re-calls push_bot_branch on already-pushed HEAD while .tmp/proof.png stays untracked!
        message = call('push_bot_branch', { summary: 'Re-verify already pushed commit for issue 50' });
      } else {
        exec2PushResult = toolMsgs.at(-1);
        message = call('submit_report', {
          summary: `Verified PR #10 on bot/issue-50 at ${committedSha}.`,
          artifacts: [{ path: 'calc.mjs', description: 'Fixed add()' }],
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(r => { model.close(r); model.closeAllConnections(); }));

  fx.store.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)',
    'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture',
    fx.store.secrets.seal({ value: 'model-key' }, 'model:m'), 'now',
  );
  fx.store.run("UPDATE policies SET model_id='m' WHERE repository_id='101'");

  const commands = new TaskCommands(fx.store);
  const operator = { id: 'op', role: 'project_admin', repositories: ['101'] };
  const id = commands.api(operator, 'POST', new URL('http://local/api/tasks'), {
    repository_id: '101',
    request: 'Fix Issue #50',
    target: { type: 'issue', number: 50 },
    writes: ['pull_request'],
    contract: { goal: 'Fix add(2, 3) === 5', scope: ['calc.mjs'], criteria: ['node --test passes'], endpoint: 'reviewable_pull_request' },
  }).id;
  fx.store.run("UPDATE tasks SET status='running',claim_token='claim-1' WHERE id=?", id);
  fx.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim-1','now')", id);
  authorizeKnowledgeTask(fx.store, id);

  // Execution 1: commits, pushes, opens PR #10, then interrupts before submit_report
  const engine1 = new TaskEngine(fx.store, fx.computer, fx.apiUrl, fx.gitCache);
  t.after(() => engine1.close());
  await engine1.run(id, 'claim-1');
  const afterExec1 = fx.store.get('SELECT * FROM tasks WHERE id=?', id);
  assert.notEqual(afterExec1.status, 'pr_opened', 'execution 1 interrupted before submit_report');
  assert.equal(fx.readRef('bot/issue-50'), committedSha);
  assert.equal(fx.state.prs.length, 1);

  // Execution 2: brand-new TaskEngine & runRequest (fresh empty pushSession) resumes the task
  executionPhase = 2;
  fx.store.run("UPDATE tasks SET status='running',phase='model',claim_token='claim-2',error_code=NULL WHERE id=?", id);
  fx.store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim-2','now')", id);
  const engine2 = new TaskEngine(fx.store, fx.computer, fx.apiUrl, fx.gitCache);
  t.after(() => engine2.close());
  await engine2.run(id, 'claim-2');

  assert.ok(exec2PushResult, 'execution 2 must have received push_bot_branch result');
  assert.equal(exec2PushResult.ok, true, JSON.stringify(exec2PushResult));
  assert.equal(exec2PushResult.already_up_to_date, true);
  assert.equal(exec2PushResult.commit_ancestry_verified, true, 'already_up_to_date on resumed execution must prove baseline ancestry');
  assert.equal(exec2PushResult.existing_pr_number, 10);

  const finalTask = fx.store.get('SELECT * FROM tasks WHERE id=?', id);
  assert.equal(finalTask.status, 'pr_opened', JSON.stringify({ status: finalTask.status, error: finalTask.error_code, detail: finalTask.error_detail }));
  const finalResult = JSON.parse(finalTask.result || '{}');
  assert.equal(finalResult.delivery, 'pull_request');
  assert.equal(finalResult.pr_number, 10);
  assert.equal(finalResult.sha, committedSha);
  assert.ok(qaRuns >= 2, `fresh resumed execution without cached push-gate QA receipt must run evaluateDelivery cleanly (qaRuns=${qaRuns})`);
});
