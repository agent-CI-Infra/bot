// #1331: Continuous multi-round bot PR development tasks — single task_id across rounds,
// exact per-PR continuation matching (#1314 multi-baseline safe), in-place worktree reuse
// via workspace.advance (preserving ignored caches & remote human commits) with seamless
// fallback on container rebuild, dev session continuity, stale cross-round nomination guard,
// unified Task Manager orchestration (no single-role dev fork), and scoped Publisher updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { GitCache } from '../../../../dist/agent/git-cache.js';
import { Dispatcher } from '../../../../dist/dispatch/worker.js';
import { managerDecision } from '../../../../dist/dispatch/manager.js';
import {
  applyDecision,
  continuations,
  dispatchContext,
  findResumableBotPrTask,
  genericRefusal,
  isBotPrOpen,
} from '../../../../dist/dispatch/store.js';
import { continueDevelopmentTask } from '../../../../dist/review/continuation.js';
import { queueWebhook, revisionFacts } from '../../../../dist/review/queue.js';
import { syncBotPullRequestState } from '../../../../dist/review/bot-pr-wake.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { captureTaskConfiguration } from '../../../../dist/tasks/configuration.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { traceEvent } from '../../../../dist/tasks/trace.js';
import { runRole } from '../../../../dist/roles/run.js';
import { saveConfiguration } from '../../../../dist/roles/definition.js';
import { gitServer, git } from '../../../fixtures/git-server.mjs';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { scriptedHarness } from '../../../fixtures/scripted-driver.mjs';

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('#1331 continuations, genericRefusal, multi-baseline isolation, legacy fallback, close stop, continueDevelopmentTask, and revisionFacts', t => {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());

  const now = '2026-11-24T08:00:00.000Z';
  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'gh-tok' }, 'account:a'), now);
  store.run("INSERT INTO repositories VALUES('101','fixture/repo','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:9/v1', 'fixture', store.secrets.seal({ value: 'k' }, 'model:m'), now);
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling) VALUES('101','m',1,1,'develop')");
  scriptedRoles(store, '101');

  const seedTask = (id, { kind = 'task.request', status = 'pr_opened', objectNumber = 42, target = { type: 'issue', number: 42 }, workspaceId = 'a'.repeat(48), generation = 1, grantPr = true } = {}) => {
    const input = { generic: kind === 'task.request', target, round: 1, ...(kind === 'task.request' ? { delivery: 'pull_request' } : {}) };
    store.run(
      `INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,result,object_number,head_sha,workspace_id,generation,attempt,created_at,updated_at)
       VALUES(?,?,?,'queued','prepare',?,?,?,?,?,?,?,?,?,?)`,
      id, '101', kind, `Task ${id}`, JSON.stringify(input),
      JSON.stringify({ pr_number: objectNumber, pr_url: `https://github.invalid/pull/${objectNumber}`, branch: 'bot/issue-42', sha: '1'.repeat(40), summary: `Done ${id}` }),
      objectNumber, '1'.repeat(40), workspaceId, generation, 1, now, now,
    );
    new TaskRecords(store).contract(id, { goal: `Goal ${id}`, scope: ['app.mjs'], criteria: ['Pass'], endpoint: 'reviewable_pull_request', source: { type: 'test' }, completeness: 'explicit' });
    store.run("UPDATE tasks SET status=?,phase='done' WHERE id=?", status, id);
    if (grantPr) setGrant(store, { id, repository_id: '101' }, ['pull_request'], 'role:manager', null);
    captureTaskConfiguration(store, id);
  };

  // 1. #1314 multi-baseline PRs on the SAME Issue #42: PR #88 (main) and PR #89 (release/v1) never collide!
  seedTask('t-main', { objectNumber: 42, target: { type: 'issue', number: 42 }, workspaceId: 'a'.repeat(48) });
  seedTask('t-rel', { objectNumber: 42, target: { type: 'issue', number: 42, ref: 'release/v1' }, status: 'completed', workspaceId: 'b'.repeat(48) });
  store.run("INSERT INTO bot_pull_requests VALUES('101',88,'5088','999','101','bot/issue-42',?,'t-main',0)", '1'.repeat(40));
  store.run("INSERT INTO bot_pull_requests VALUES('101',89,'5089','999','101','bot/issue-42-release-v1',?,'t-rel',0)", '2'.repeat(40));

  assert.equal(isBotPrOpen(store, '101', 88), true);
  assert.equal(isBotPrOpen(store, '101', 89), true);
  assert.equal(findResumableBotPrTask(store, '101', 88)?.id, 't-main');
  assert.equal(findResumableBotPrTask(store, '101', 89)?.id, 't-rel', 'completed open-PR task is also resumable');

  const mkPrEvent = (prNumber, delivery, commentId = 501) => {
    const prObj = { number: prNumber, state: 'open', draft: false, title: `PR #${prNumber}`, user: { id: 999, login: 'bot', type: 'Bot' }, head: { sha: '1'.repeat(40), ref: prNumber === 88 ? 'bot/issue-42' : 'bot/issue-42-release-v1' }, base: { ref: prNumber === 88 ? 'main' : 'release/v1' } };
    queueWebhook(store, '101', 'issue_comment', {
      action: 'created',
      sender: { id: 5, login: 'alice', type: 'User' },
      issue: { number: prNumber, state: 'open', title: prObj.title, pull_request: {}, user: { id: 999 } },
      comment: { id: commentId, body: 'Please adjust error handling.', author_association: 'MEMBER', html_url: `https://github.invalid/pull/${prNumber}#c${commentId}`, user: { id: 5, login: 'alice', type: 'User' } },
    }, delivery, prObj);
    return store.get('SELECT * FROM dispatch_events WHERE delivery_id=?', delivery);
  };

  const ev88 = mkPrEvent(88, 'd-88-1', 501);
  const ev89 = mkPrEvent(89, 'd-89-1', 502);
  const cont88 = continuations(store, ev88);
  const cont89 = continuations(store, ev89);
  assert.deepEqual(cont88.map(c => c.task_id), ['t-main'], 'PR #88 exposes ONLY t-main');
  assert.deepEqual(cont89.map(c => c.task_id), ['t-rel'], 'PR #89 exposes ONLY t-rel');

  // Duplicate pull_request create_task for PR #88 is refused with bot_pr_task_resumable
  const ref88 = genericRefusal(store, dispatchContext(store, ev88), null, ['pull_request'], { type: 'pr', number: 88 });
  assert.equal(ref88?.code, 'bot_pr_task_resumable');
  assert.equal(ref88?.task_id, 't-main');

  // 2. Seed role_instances + task_history + model_requests + stale candidate on t-main, then wake via applyDecision(continue)
  store.run(
    "INSERT INTO role_instances(id,task_id,role,definition,harness,session,harness_state,updated_at) VALUES('ri-dev','t-main','dev','{}','process',?,?,?)",
    JSON.stringify([{ role: 'user', content: 'round 1 prompt' }, { role: 'assistant', content: 'round 1 reply' }]),
    JSON.stringify({ harness: 'pi', sessionId: 'pi-sess-1', stateWorkspaceId: 'c'.repeat(48) }),
    now,
  );
  const h1 = traceEvent(store, 't-main', 'role_result', { role: 'dev', contract_revision: 1, result: { summary: 'R1' } });
  store.run(
    "INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,input_tokens,output_tokens) VALUES('mr-1','t-main','101','req-1','m','fixture',?,100,50)",
    now,
  );
  store.run("UPDATE task_records SET candidate='{\"id\":\"c1\"}',acceptance='{\"outcome\":\"pass\"}',pending='{\"outcome\":\"pass\"}',rounds=1 WHERE task_id='t-main'");
  store.run("UPDATE policies SET test_command='npm test' WHERE repository_id='101'");

  const applied = applyDecision(store, ev88, { decision: 'continue', option_ids: ['continue:t-main'], reason: '在原任务第 2 轮修订 PR #88' }, null);
  assert.deepEqual(applied.continued, ['t-main']);

  const woken = store.get('SELECT * FROM tasks WHERE id=?', 't-main');
  const wokenInput = JSON.parse(woken.input);
  assert.equal(woken.status, 'queued');
  assert.equal(woken.phase, 'prepare');
  assert.equal(woken.attempt, 2);
  assert.equal(woken.workspace_id, 'a'.repeat(48), 'workspace_id preserved across rounds');
  assert.equal(woken.generation, 1, 'generation preserved across rounds');
  assert.equal(wokenInput.round, 2);
  assert.equal(wokenInput.pr_number, 88);
  assert.equal(wokenInput.executor_role, undefined);
  assert.ok(wokenInput.round_started_history_id >= Number(h1.split(':')[1]), 'round_started_history_id recorded past round 1 history');
  assert.equal(wokenInput.previous_delivery.round, 1);
  assert.equal(wokenInput.revision_requests?.[0]?.id, '501');

  // Role instance session/harness_state, task_history, and model_requests are preserved; per-round slots cleared; config refreshed
  const ri = store.get('SELECT session,harness_state FROM role_instances WHERE id=?', 'ri-dev');
  assert.equal(JSON.parse(ri.session).length, 2, 'dev session preserved');
  assert.equal(JSON.parse(ri.harness_state).sessionId, 'pi-sess-1', 'dev harness_state preserved');
  const rec = store.get('SELECT candidate,acceptance,pending,rounds FROM task_records WHERE task_id=?', 't-main');
  assert.deepEqual([rec.candidate, rec.acceptance, rec.pending, rec.rounds], [null, null, null, 0]);
  assert.equal(store.get("SELECT count(*) n FROM model_requests WHERE task_id='t-main'").n, 1);
  const refreshedCfg = JSON.parse(store.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', 't-main').snapshot);
  assert.equal(refreshedCfg.policy.test_command, 'npm test', 'task_execution_configs refreshed for round 2');

  // Multi-round revisionFacts counts distinct (task_id, round): round 2 request 501 => 1; another comment in same round 2 => still 1; round 3 request => 2!
  assert.equal(revisionFacts(store, '101', 88, '5').for_requests, 1);
  const ev88SameRound = mkPrEvent(88, 'd-88-2', 503);
  applyDecision(store, ev88SameRound, { decision: 'continue', option_ids: ['continue:t-main'], reason: '同轮补充意见' }, null);
  assert.equal(revisionFacts(store, '101', 88, '5').for_requests, 1, 'two comments in same round count as 1 revision round');

  // Finish round 2 and wake round 3 at a later timestamp
  store.run("UPDATE tasks SET status='pr_opened',phase='done',result='{\"pr_number\":88}' WHERE id='t-main'");
  // Ensure timestamp advances by >= 2ms for deterministic round boundary in revisionFacts
  const waitUntil = Date.now() + 5;
  while (Date.now() < waitUntil) { /* busy wait 5ms */ }
  const ev88Round3 = mkPrEvent(88, 'd-88-3', 504);
  applyDecision(store, ev88Round3, { decision: 'continue', option_ids: ['continue:t-main'], reason: '第 3 轮修订' }, null);
  assert.equal(revisionFacts(store, '101', 88, '5').for_requests, 2, 'round 2 and round 3 on same task_id count as 2 revision rounds');
  assert.equal(revisionFacts(store, '101', 88, '5').for_this_author, 2);

  // 3. Closing PR #88 cancels its active Issue-rooted source_task_id AND stops continuations!
  queueWebhook(store, '101', 'pull_request', {
    action: 'closed',
    sender: { id: 5, login: 'alice', type: 'User' },
    pull_request: { number: 88, state: 'closed', merged: true, draft: false, title: 'PR #88', user: { id: 999 }, head: { sha: '1'.repeat(40), ref: 'bot/issue-42' }, base: { ref: 'main' } },
  }, 'd-88-closed');
  assert.equal(store.get('SELECT status,error_code FROM tasks WHERE id=?', 't-main').status, 'cancelled');
  assert.equal(isBotPrOpen(store, '101', 88), false);
  assert.equal(findResumableBotPrTask(store, '101', 88), undefined);
  // Also closing PR #89 via syncBotPullRequestState (without review_objects) stops continuations
  syncBotPullRequestState(store, '101', { number: 89, state: 'closed', draft: false, head: { sha: '2'.repeat(40), ref: 'bot/issue-42-release-v1' }, base: { ref: 'release/v1' } });
  assert.equal(isBotPrOpen(store, '101', 89), false);
  assert.equal(findResumableBotPrTask(store, '101', 89), undefined);

  // 4. Legacy development.issue PR fallback: does NOT force continuation of legacy kind; creates unified task.request, then reuses it!
  seedTask('legacy-dev', { kind: 'development.issue', status: 'pr_opened', objectNumber: 70, grantPr: false });
  store.run("INSERT INTO bot_pull_requests VALUES('101',95,'5095','999','101','bot/issue-70',?,'legacy-dev',0)", '3'.repeat(40));
  const ev95a = mkPrEvent(95, 'd-95-1', 601);
  assert.deepEqual(continuations(store, ev95a), [], 'legacy development.issue is not forced into continuations');
  assert.equal(genericRefusal(store, dispatchContext(store, ev95a), null, ['pull_request'], { type: 'pr', number: 95 }), null);
  const created95 = applyDecision(store, ev95a, { decision: 'create', option_ids: ['development'], reason: '旧 PR 建统一任务' }, null).created[0];
  assert.ok(created95);
  assert.equal(store.get('SELECT executor_role FROM task_origins WHERE task_id=?', created95).executor_role, null, 'fallback task unifies onto Task Manager team');
  // Once that unified task finishes (pr_opened), subsequent events on PR #95 DO expose and reuse it!
  store.run("UPDATE tasks SET status='pr_opened',phase='done',result='{\"pr_number\":95}' WHERE id=?", created95);
  const ev95b = mkPrEvent(95, 'd-95-2', 602);
  assert.deepEqual(continuations(store, ev95b).map(c => c.task_id), [created95], 'subsequent round reuses the unified task.request');
  assert.equal(genericRefusal(store, dispatchContext(store, ev95b), null, ['pull_request'], { type: 'pr', number: 95 })?.code, 'bot_pr_task_resumable');
});

test('#1331 end-to-end 3-round continuous bot PR task: in-place worktree reuse (GitCache + workspace.advance), human commit preservation, dev session continuity, stale nomination guard, scoped PATCH, and container-rebuild fallback', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-1331-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 1. Real upstream git repository served over Git HTTP so GitCache + workspace.bind + workspace.advance run for real!
  const ghToken = 'ghs_' + 'e'.repeat(36);
  const work = join(root, 'upstream-work');
  const bare = join(root, 'git-srv', 'fixture', 'repo.git');
  mkdirSync(work, { recursive: true });
  mkdirSync(bare, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(work, 'app.mjs'), 'export const greet = () => "v0";\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'initial main');
  const mainSha = git(work, 'rev-parse', 'HEAD');
  git(bare, 'init', '-q', '--bare');
  git(work, 'push', '-q', bare, `${mainSha}:refs/heads/main`);
  const gitSrv = await gitServer(t, join(root, 'git-srv'), ghToken);
  const cloneUrl = `${gitSrv.url}/fixture/repo.git`;

  // Real GitHub REST API stub backed by the real bare repository so pushes & commits materialize in bare!
  const ghState = {
    prs: new Map(),
    comments: new Map(),
    prPatches: [],
    createdCommits: [],
    nextPr: 88,
    nextComment: 100,
    issue42: { number: 42, state: 'open', title: 'Improve greet()', body: 'Update greet() to v1.', labels: [{ name: 'bot-develop' }], assignees: [], user: { login: 'alice', type: 'User' }, html_url: 'https://github.invalid/fixture/repo/issues/42' },
  };
  const readGitTree = commitSha => {
    const out = git(bare, 'ls-tree', '-r', '-l', commitSha);
    return out.split('\n').filter(Boolean).map(line => {
      const [meta, path] = line.split('\t');
      const [mode, type, sha, sizeStr] = meta.trim().split(/\s+/);
      return { path, mode, type, sha, size: sizeStr === '-' ? 0 : Number(sizeStr) };
    });
  };
  const ghServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://gh');
    const p = url.pathname;
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (p === '/user') return send({ id: 999, login: 'dept-bot', type: 'User' });
    if (p === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/repo', default_branch: 'main', clone_url: cloneUrl });
    const sub = p.replace(/^\/repos\/fixture\/repo/, '');
    if (req.method === 'GET' && sub === '/labels') return send([{ name: 'bot-develop' }, { name: 'bot-developing' }, { name: 'bot-developed' }]);
    if (req.method === 'GET' && sub.startsWith('/labels/')) return send({ name: decodeURIComponent(sub.slice('/labels/'.length)) });
    if (req.method === 'POST' && sub === '/labels') return send(body, 201);
    if (req.method === 'GET' && sub === '/issues/42') return send(ghState.issue42);
    if (req.method === 'GET' && sub === '/issues/42/events') return send([{ event: 'labeled', label: { name: 'bot-develop' }, actor: { type: 'User', login: 'alice' } }]);
    if (req.method === 'POST' && /^\/issues\/\d+\/labels$/.test(sub)) return send([]);
    if (req.method === 'DELETE' && /^\/issues\/\d+\/labels\//.test(sub)) return send([]);
    if (req.method === 'GET' && /^\/issues\/(\d+)\/comments$/.test(sub)) {
      const num = Number(/^\/issues\/(\d+)\/comments$/.exec(sub)[1]);
      return send(ghState.comments.get(num) ?? []);
    }
    if (req.method === 'POST' && /^\/issues\/(\d+)\/comments$/.test(sub)) {
      const num = Number(/^\/issues\/(\d+)\/comments$/.exec(sub)[1]);
      const c = { id: ++ghState.nextComment, body: body.body, user: { id: 999, login: 'dept-bot', type: 'User' }, html_url: `https://github.invalid/c/${ghState.nextComment}` };
      ghState.comments.set(num, [...(ghState.comments.get(num) ?? []), c]);
      return send(c, 201);
    }
    if (req.method === 'PATCH' && /^\/issues\/comments\/(\d+)$/.test(sub)) {
      const cid = Number(/^\/issues\/comments\/(\d+)$/.exec(sub)[1]);
      for (const list of ghState.comments.values()) {
        const hit = list.find(c => c.id === cid);
        if (hit) { hit.body = body.body; return send(hit); }
      }
      return send({ message: 'Not Found' }, 404);
    }
    if (req.method === 'GET' && /^\/git\/ref\/heads\/(.+)$/.test(sub)) {
      const br = decodeURIComponent(/^\/git\/ref\/heads\/(.+)$/.exec(sub)[1]);
      try {
        const sha = execFileSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${br}`], { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return send({ ref: `refs/heads/${br}`, object: { sha } });
      } catch {
        return send({ message: 'Not Found' }, 404);
      }
    }
    if (req.method === 'GET' && /^\/git\/commits\/([a-f0-9]{40})$/.test(sub)) {
      const sha = /^\/git\/commits\/([a-f0-9]{40})$/.exec(sub)[1];
      const treeSha = git(bare, 'rev-parse', `${sha}^{tree}`);
      const parents = git(bare, 'show', '-s', '--format=%P', sha).split(/\s+/).filter(Boolean).map(s => ({ sha: s }));
      return send({ sha, tree: { sha: treeSha }, parents, message: git(bare, 'show', '-s', '--format=%s', sha) });
    }
    if (req.method === 'GET' && /^\/git\/trees\/([a-f0-9]{40})$/.test(sub)) {
      const treeSha = /^\/git\/trees\/([a-f0-9]{40})$/.exec(sub)[1];
      return send({ sha: treeSha, truncated: false, tree: readGitTree(treeSha) });
    }
    if (req.method === 'GET' && /^\/git\/blobs\/([a-f0-9]{40})$/.test(sub)) {
      const blobSha = /^\/git\/blobs\/([a-f0-9]{40})$/.exec(sub)[1];
      const buf = Buffer.from(git(bare, 'cat-file', 'blob', blobSha), 'utf8');
      return send({ sha: blobSha, encoding: 'base64', content: buf.toString('base64'), size: buf.length });
    }
    if (req.method === 'POST' && sub === '/git/blobs') {
      const data = Buffer.from(body.content, 'base64');
      const tmp = join(root, 'blob-' + randomBytes(6).toString('hex'));
      writeFileSync(tmp, data);
      const sha = git(bare, 'hash-object', '-w', tmp);
      rmSync(tmp, { force: true });
      return send({ sha }, 201);
    }
    if (req.method === 'POST' && sub === '/git/trees') {
      const baseEntries = body.base_tree ? new Map(readGitTree(body.base_tree).map(e => [e.path, e])) : new Map();
      for (const item of body.tree) {
        if (item.sha === null) baseEntries.delete(item.path);
        else baseEntries.set(item.path, { path: item.path, mode: item.mode, type: item.type, sha: item.sha });
      }
      const idx = join(root, 'idx-' + randomBytes(6).toString('hex'));
      const env = { ...process.env, GIT_INDEX_FILE: idx };
      for (const e of [...baseEntries.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        execFileSync('git', ['update-index', '--add', '--cacheinfo', `${e.mode},${e.sha},${e.path}`], { cwd: bare, env, encoding: 'utf8' });
      }
      const treeSha = execFileSync('git', ['write-tree'], { cwd: bare, env, encoding: 'utf8' }).trim();
      rmSync(idx, { force: true });
      return send({ sha: treeSha }, 201);
    }
    if (req.method === 'POST' && sub === '/git/commits') {
      const args = ['commit-tree', body.tree];
      for (const parent of body.parents || []) args.push('-p', parent);
      args.push('-m', body.message || 'bot commit');
      const sha = execFileSync('git', args, { cwd: bare, env: { ...process.env, GIT_AUTHOR_NAME: 'Bot', GIT_AUTHOR_EMAIL: 'bot@example.invalid', GIT_COMMITTER_NAME: 'Bot', GIT_COMMITTER_EMAIL: 'bot@example.invalid' }, encoding: 'utf8' }).trim();
      ghState.createdCommits.push({ sha, parents: body.parents || [], tree: body.tree });
      return send({ sha, tree: { sha: body.tree } }, 201);
    }
    if (req.method === 'POST' && sub === '/git/refs') {
      git(bare, 'update-ref', body.ref, body.sha);
      return send({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (req.method === 'PATCH' && /^\/git\/refs\/heads\/(.+)$/.test(sub)) {
      const br = decodeURIComponent(/^\/git\/refs\/heads\/(.+)$/.exec(sub)[1]);
      git(bare, 'update-ref', `refs/heads/${br}`, body.sha);
      for (const pr of ghState.prs.values()) {
        if (pr.head.ref === br) pr.head.sha = body.sha;
      }
      return send({ ref: `refs/heads/${br}`, object: { sha: body.sha } });
    }
    if (req.method === 'POST' && sub === '/pulls') {
      const num = ghState.nextPr++;
      const headSha = git(bare, 'rev-parse', `refs/heads/${body.head}`);
      const baseSha = git(bare, 'rev-parse', `refs/heads/${body.base}`);
      const pr = {
        id: 5000 + num,
        number: num,
        state: 'open',
        draft: false,
        title: body.title,
        body: body.body,
        mergeable: true,
        mergeable_state: 'clean',
        user: { id: 999, login: 'dept-bot', type: 'User' },
        head: { ref: body.head, sha: headSha, repo: { id: 101 } },
        base: { ref: body.base, sha: baseSha, repo: { id: 101 } },
        labels: [],
        html_url: `https://github.invalid/fixture/repo/pull/${num}`,
      };
      ghState.prs.set(num, pr);
      return send(pr, 201);
    }
    if (req.method === 'GET' && /^\/pulls\/(\d+)$/.test(sub)) {
      const num = Number(/^\/pulls\/(\d+)$/.exec(sub)[1]);
      const pr = ghState.prs.get(num);
      if (!pr) return send({ message: 'Not Found' }, 404);
      // Mirror real GitHub: GET /pulls/:n reflects the live head branch SHA updated by git push as well as REST ref updates.
      try {
        const liveSha = execFileSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${pr.head.ref}`], { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (liveSha) pr.head.sha = liveSha;
      } catch { /* ignore */ }
      return send(pr);
    }
    if (req.method === 'PATCH' && /^\/pulls\/(\d+)$/.test(sub)) {
      const num = Number(/^\/pulls\/(\d+)$/.exec(sub)[1]);
      const pr = ghState.prs.get(num);
      if (!pr) return send({ message: 'Not Found' }, 404);
      Object.assign(pr, { title: body.title ?? pr.title, body: body.body ?? pr.body });
      ghState.prPatches.push({ number: num, head_sha: pr.head.sha, title: pr.title, body: pr.body });
      return send(pr);
    }
    if (req.method === 'GET' && /^\/pulls\/(\d+)\/(files|reviews|comments)$/.test(sub)) {
      return send([]);
    }
    send({ message: `Unhandled ${req.method} ${sub}` }, 404);
  });
  ghServer.listen(0, '127.0.0.1');
  await once(ghServer, 'listening');
  const ghUrl = `http://127.0.0.1:${ghServer.address().port}`;
  t.after(() => new Promise(r => { ghServer.close(r); ghServer.closeAllConnections(); }));

  // Track assertions across all 3 rounds!
  const observed = {
    round1DevResultRef: null,
    staleNominationRejected: false,
    round2DevMessagesCount: 0,
    round2DevSawRound1Transcript: false,
    round2DevSawContinuation: null,
    round2CachePreserved: false,
    round2HumanFilePreserved: false,
    round2ReviewerRan: false,
    round3DevSawFallback: false,
  };
  let currentRoundPhase = 1;

  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const msgs = body.messages || [];
    const sys = String(msgs[0]?.content || '');
    const tools = (body.tools || []).map(x => x.function?.name);
    const lastUserIdx = msgs.findLastIndex(m => m.role === 'user');
    const roundMsgs = msgs.slice(lastUserIdx + 1);
    const roundTools = roundMsgs.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return { raw: m.content }; } });
    const roundCalls = roundMsgs.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(c => c.function.name);
    let reply;

    if (tools.includes('submit_acceptance')) {
      reply = toolCall('qa_ok', 'submit_acceptance', { pass: true, issues: [] });
    } else if (tools.includes('create_task') && tools.includes('continue_task')) {
      // Object Manager dispatch
      const payload = JSON.parse(msgs[1].content);
      if (payload.work?.continue?.length) {
        reply = toolCall('om_cont', 'continue_task', {
          task_id: payload.work.continue[0].task_id,
          reason: `续接原开发任务处理第 ${currentRoundPhase} 轮 PR 评论。`,
        });
      } else {
        reply = toolCall('om_create', 'create_task', {
          writes: ['pull_request'],
          basis: { kind: 'label' },
          brief: { goal: 'Implement greet() v1 for Issue #42', criteria: ['greet() returns v1'] },
          reason: '开发标签已添加，由 Task Manager 团队开发 Issue #42。',
        });
      }
    } else if (tools.includes('delegate_role')) {
      // Task Manager team orchestration
      const mgrInput = JSON.parse(msgs[lastUserIdx].content);
      const devDelegated = roundTools.find(r => typeof r.result_ref === 'string' && !r.reused);
      const allRefs = roundTools.filter(r => typeof r.result_ref === 'string').map(r => r.result_ref);
      const staleError = roundTools.find(r => r.error === 'role_nomination_stale' || r.code === 'role_nomination_stale' || String(r.raw || '').includes('previous_round_result'));
      if (staleError) observed.staleNominationRejected = true;

      if (currentRoundPhase === 1) {
        if (!allRefs.length) {
          reply = toolCall('tm1_dev', 'delegate_role', { role: 'dev', purpose: 'Implement v1 and populate build cache.', refs: [] });
        } else {
          observed.round1DevResultRef = allRefs[0];
          reply = toolCall('tm1_nom', 'nominate_delivery', { result_ref: allRefs[0], checks_note: 'Initial small fixture change.' });
        }
      } else if (currentRoundPhase === 2) {
        assert.equal(mgrInput.continuation?.mode, 'pull_request_development', 'Task Manager sees Round 2 continuation context');
        assert.equal(mgrInput.continuation?.round, 2);
        // First deliberately attempt to nominate Round 1's stale result_ref to verify control-plane rejection!
        if (!observed.staleNominationRejected && !roundCalls.includes('nominate_delivery') && observed.round1DevResultRef) {
          reply = toolCall('tm2_stale', 'nominate_delivery', { result_ref: observed.round1DevResultRef });
        } else if (allRefs.length === 0) {
          reply = toolCall('tm2_dev', 'delegate_role', { role: 'dev', purpose: 'Address PR comment while preserving human commit and cache.', refs: [] });
        } else if (allRefs.length === 1) {
          reply = toolCall('tm2_rev', 'delegate_role', { role: 'reviewer', purpose: 'Independently review round 2 edit.', refs: [allRefs[0]] });
        } else {
          reply = toolCall('tm2_nom', 'nominate_delivery', { result_ref: allRefs[0], checks_note: 'Reviewed by independent reviewer.' });
        }
      } else {
        // Round 3: non-code reply/report round after container generation rebuild
        if (!allRefs.length) {
          reply = toolCall('tm3_dev', 'delegate_role', { role: 'dev', purpose: 'Inspect PR question and answer via report without code edits.', refs: [] });
        } else {
          reply = toolCall('tm3_nom', 'nominate_delivery', { result_ref: allRefs[0], delivery: 'report' });
        }
      }
    } else if (tools.includes('submit_role_result')) {
      // Independent reviewer in Round 2
      observed.round2ReviewerRan = true;
      reply = toolCall('rev2_ok', 'submit_role_result', {
        summary: 'Verified app.mjs updated to v2 and human.txt preserved.',
        findings: [],
        inspected_scope: ['app.mjs', 'human.txt'],
        unknowns: [],
      });
    } else {
      // Dev worker across rounds 1, 2, 3
      const rawUser = String(msgs[lastUserIdx]?.content || '');
      let devInput;
      try {
        devInput = JSON.parse(rawUser);
      } catch (err) {
        throw new Error(`Unexpected non-JSON user prompt in phase ${currentRoundPhase} (tools=${JSON.stringify(tools)}, lastUser=${JSON.stringify(rawUser)}, recentTools=${JSON.stringify(roundTools.slice(-3))}): ${err.message}`);
      }
      const srcCtx = (() => { try { return JSON.parse(devInput.source_context || '{}'); } catch { return {}; } })();
      if (currentRoundPhase === 1) {
        if (!roundCalls.includes('run_command')) {
          // Create a gitignored build cache inside the worktree + edit app.mjs!
          reply = toolCall('d1_cmd', 'run_command', { command: 'mkdir -p node_modules && printf "warm-cache-round-1" > node_modules/cached.txt && printf "export const greet = () => \\"v1\\";\\n" > app.mjs' });
        } else {
          reply = toolCall('d1_pr', 'open_pull_request', {
            change_title: 'feat: update greet to v1',
            summary: 'Updated greet() to v1 (round 1).',
            artifacts: [{ path: 'app.mjs', description: 'Updated greet to v1' }],
            evidence: [{ source: 'app.mjs', result: 'v1' }],
          });
        }
      } else if (currentRoundPhase === 2) {
        observed.round2DevMessagesCount = msgs.length;
        observed.round2DevSawRound1Transcript = msgs.slice(0, lastUserIdx).some(m => String(m.content || '').includes('warm-cache-round-1') || JSON.stringify(m.tool_calls || []).includes('warm-cache-round-1'));
        observed.round2DevSawContinuation = srcCtx.continuation;
        if (!roundCalls.includes('run_command')) {
          reply = toolCall('d2_check', 'run_command', { command: 'cat node_modules/cached.txt && echo "---" && cat human.txt && printf "export const greet = () => \\"v2\\";\\n" > app.mjs' });
        } else {
          const cmdOut = String(roundTools.at(-1)?.output || roundTools.at(-1)?.stdout || '');
          if (cmdOut.includes('warm-cache-round-1')) observed.round2CachePreserved = true;
          if (cmdOut.includes('from-human-push')) observed.round2HumanFilePreserved = true;
          reply = toolCall('d2_pr', 'open_pull_request', {
            change_title: 'feat: update greet to v2',
            summary: 'Updated greet() to v2 in round 2 while preserving human commit.',
            artifacts: [{ path: 'app.mjs', description: 'Updated greet to v2' }],
            evidence: [{ source: 'app.mjs', result: 'v2 + human.txt preserved' }],
          });
        }
      } else {
        observed.round3DevSawFallback = srcCtx.continuation?.round === 3;
        reply = toolCall('d3_rep', 'submit_report', {
          summary: 'Answered maintainer question in round 3 without pushing code.',
          artifacts: [],
          evidence: [{ source: 'app.mjs', result: 'Already v2' }],
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: reply }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  t.after(() => new Promise(r => { modelServer.close(r); modelServer.closeAllConnections(); }));

  const store = new Store(':memory:', randomBytes(32));
  const localManager = new LocalManager('101', join(root, 'computer'));
  const gitCache = new GitCache(join(root, 'git-cache'));
  const engine = new TaskEngine(store, localManager, ghUrl, gitCache);
  const dispatcher = new Dispatcher(store, (s, ctx) => managerDecision(s, ctx, ghUrl, localManager));
  t.after(async () => {
    await dispatcher.close();
    await engine.close();
    await localManager.recover();
    store.close();
  });

  const now = new Date().toISOString();
  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: ghToken }, 'account:a'), now);
  store.run("INSERT INTO repositories VALUES('101','fixture/repo','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${modelServer.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'model-key' }, 'model:m'), now);
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling) VALUES('101','m',1,1,'develop')");
  scriptedRoles(store, '101');
  await localManager.call('PUT', '/v1/projects/101');

  const drainTask = async (taskId, expectedStatus) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      dispatcher.tick();
      await dispatcher.idle();
      engine.tick();
      if (engine.working('101').length) await Promise.allSettled(engine.working('101'));
      const tRow = taskId
        ? store.get('SELECT * FROM tasks WHERE id=?', taskId)
        : store.get("SELECT * FROM tasks WHERE repository_id='101' ORDER BY rowid DESC LIMIT 1");
      if (tRow && tRow.status === expectedStatus) return tRow;
      if (tRow && ['failed', 'cancelled', 'waiting_configuration', 'waiting_permission', 'waiting_environment', 'needs_replan'].includes(tRow.status)) {
        assert.fail(`Task ${tRow.id} stopped unexpectedly: ${tRow.status} (${tRow.error_code})`);
      }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail(`Timed out waiting for status ${expectedStatus}`);
  };

  // === ROUND 1: Issue #42 labeled -> unified Task Manager team opens PR #88 ===
  currentRoundPhase = 1;
  queueWebhook(store, '101', 'issues', {
    action: 'labeled',
    label: { name: 'bot-develop' },
    issue: ghState.issue42,
    sender: { id: 5, login: 'alice', type: 'User' },
  }, 'del-r1');

  const round1Task = await drainTask(null, 'pr_opened');
  const taskId = round1Task.id;
  const round1WorkspaceId = round1Task.workspace_id;
  const round1Worktrees = store.all("SELECT id,head_sha FROM worktrees WHERE repository_id='101'");
  assert.equal(round1Worktrees.length, 1, 'round 1 created 1 worktree');
  const round1DevInstance = store.get("SELECT id FROM role_instances WHERE task_id=? AND role='dev'", taskId);
  assert.ok(round1DevInstance, 'round 1 created dev role_instance');
  assert.equal(ghState.prs.size, 1);
  const pr88 = ghState.prs.get(88);
  assert.ok(pr88, 'PR #88 opened');
  const prHead1 = pr88.head.sha;
  const issueCommentAfterR1 = (ghState.comments.get(42) || [])[0]?.body || '';
  assert.match(issueCommentAfterR1, /Pull request #88 opened|已开出 PR #88/);
  const r1ModelReqs = store.get('SELECT count(*) n FROM model_requests WHERE task_id=?', taskId).n;
  assert.ok(r1ModelReqs >= 3, 'round 1 model_requests recorded under taskId');

  // === HUMAN PUSHES COMMIT ONTO bot/issue-42 + COMMENTS ON PR #88 ===
  const humanWork = join(root, 'human-push');
  mkdirSync(humanWork, { recursive: true });
  git(humanWork, 'clone', '-q', '-b', 'bot/issue-42', bare, '.');
  writeFileSync(join(humanWork, 'human.txt'), 'from-human-push\n');
  git(humanWork, 'add', 'human.txt');
  git(humanWork, 'commit', '-qm', 'human commit on bot PR branch');
  const prHeadHuman = git(humanWork, 'rev-parse', 'HEAD');
  git(humanWork, 'push', '-q', 'origin', 'bot/issue-42');
  pr88.head.sha = prHeadHuman;

  // === ROUND 2: PR #88 comment wakes SAME task -> workspace.advance in-place, dev session reused, stale nomination rejected, PATCH with round:2 scope ===
  currentRoundPhase = 2;
  queueWebhook(store, '101', 'issue_comment', {
    action: 'created',
    sender: { id: 5, login: 'alice', type: 'User' },
    issue: { number: 88, state: 'open', title: pr88.title, pull_request: {}, user: { id: 999 } },
    comment: { id: 701, body: 'Please update greet() to v2 and keep human.txt.', author_association: 'MEMBER', html_url: 'https://github.invalid/pull/88#c701', user: { id: 5, login: 'alice', type: 'User' } },
  }, 'del-r2', pr88);

  const round2Task = await drainTask(taskId, 'pr_opened');
  assert.equal(store.get("SELECT count(*) n FROM tasks WHERE repository_id='101'").n, 1, 'still ONLY ONE task row for PR #88');
  assert.equal(round2Task.workspace_id, round1WorkspaceId, 'round 2 reused the EXACT SAME workspace_id in place');
  const round2Worktrees = store.all("SELECT id,head_sha FROM worktrees WHERE repository_id='101'");
  assert.equal(round2Worktrees.length, 1, 'round 2 reused the EXACT SAME worktree without creating a second one');
  assert.equal(round2Worktrees[0].id, round1Worktrees[0].id);
  assert.equal(round2Worktrees[0].head_sha, prHeadHuman, 'worktreeMoved recorded prHeadHuman');
  const round2Input = JSON.parse(round2Task.input);
  assert.equal(round2Input.round, 2);
  assert.equal(round2Input.snapshot_sha, prHeadHuman, 'snapshot_sha aligned to remote prHeadHuman');
  assert.equal(round2Input.workspace_base_head_sha, prHeadHuman, 'workspace_base_head_sha aligned to prHeadHuman');

  assert.equal(observed.staleNominationRejected, true, 'round 1 stale dev result nomination was rejected with role_nomination_stale');
  assert.equal(observed.round2DevSawRound1Transcript, true, 'round 2 dev reused round 1 conversation transcript');
  assert.equal(observed.round2DevSawContinuation?.mode, 'pull_request_development');
  assert.equal(observed.round2DevSawContinuation?.round, 2);
  assert.equal(observed.round2CachePreserved, true, 'gitignored node_modules/cached.txt survived in-place workspace.advance');
  assert.equal(observed.round2HumanFilePreserved, true, 'human commit file human.txt was fetched into worktree by workspace.advance');
  assert.equal(observed.round2ReviewerRan, true, 'Task Manager delegated independent reviewer in round 2');
  assert.equal(store.get("SELECT id FROM role_instances WHERE task_id=? AND role='dev'", taskId).id, round1DevInstance.id, 'same dev role_instance reused');

  // Verify Round 2 commit was built on top of prHeadHuman (not clobbering human.txt!) and PR #88 was PATCHed with round:2 scope
  const r2Head = git(bare, 'rev-parse', 'refs/heads/bot/issue-42');
  const r2Parents = git(bare, 'show', '-s', '--format=%P', r2Head).split(/\s+/).filter(Boolean);
  assert.notEqual(r2Head, prHeadHuman, 'round 2 pushed a new commit onto bot/issue-42');
  assert.deepEqual(r2Parents, [prHeadHuman], 'round 2 commit parent is prHeadHuman');
  const r2Tree = readGitTree(r2Head);
  assert.ok(r2Tree.some(e => e.path === 'human.txt'), 'published round 2 tree preserved human.txt');
  assert.match(git(bare, 'cat-file', 'blob', r2Tree.find(e => e.path === 'app.mjs').sha), /"v2"/);
  assert.equal(ghState.prPatches.length, 1, 'round 2 updated PR #88 in place via PATCH');
  assert.equal(ghState.prPatches[0].number, 88);
  const r2Effects = store.all("SELECT id,kind FROM github_effects WHERE task_id=?", taskId);
  assert.ok(r2Effects.length >= 4, 'round 1 and round 2 effects coexist without colliding');
  // Verify Issue #42 progress comment stayed on PR #88 without regressing to "In development"
  assert.equal((ghState.comments.get(42) || [])[0]?.body, issueCommentAfterR1, 'Issue #42 progress comment was not regressed in round 2');
  const r2ModelReqs = store.get('SELECT count(*) n FROM model_requests WHERE task_id=?', taskId).n;
  assert.ok(r2ModelReqs > r1ModelReqs, 'round 2 model_requests aggregated under the same taskId');
  const logsR2 = store.all('SELECT content FROM task_logs WHERE task_id=?', taskId).map(r => JSON.parse(r.content));
  assert.ok(logsR2.some(l => l.type === 'workspace_reused' && l.round === 2), 'workspace_reused log recorded');

  // === ROUND 3: Container rebuilt (generation incremented) -> seamless fallback + non-code report completion ===
  currentRoundPhase = 3;
  // Simulate project computer container rebuild (increment generation & wipe container worktrees)
  const projState = await localManager.call('GET', '/v1/projects/101');
  projState.generation += 1;
  rmSync(join(root, 'computer', 'worktrees'), { recursive: true, force: true });
  rmSync(join(root, 'computer', 'tasks'), { recursive: true, force: true });
  queueWebhook(store, '101', 'issue_comment', {
    action: 'created',
    sender: { id: 5, login: 'alice', type: 'User' },
    issue: { number: 88, state: 'open', title: pr88.title, pull_request: {}, user: { id: 999 } },
    comment: { id: 702, body: 'Quick question: does v2 handle empty input?', author_association: 'MEMBER', html_url: 'https://github.invalid/pull/88#c702', user: { id: 5, login: 'alice', type: 'User' } },
  }, 'del-r3', pr88);

  const round3Task = await drainTask(taskId, 'completed');
  assert.equal(store.get("SELECT count(*) n FROM tasks WHERE repository_id='101'").n, 1, 'still ONLY ONE task row after round 3');
  assert.notEqual(round3Task.workspace_id, round1WorkspaceId, 'round 3 degraded seamlessly to a new workspace_id after container rebuild');
  assert.equal(JSON.parse(round3Task.input).round, 3);
  assert.equal(observed.round3DevSawFallback, true);
  const logsR3 = store.all('SELECT content FROM task_logs WHERE task_id=?', taskId).map(r => JSON.parse(r.content));
  assert.ok(logsR3.some(l => l.type === 'workspace_reuse_fallback' && l.round === 3 && l.reason === 'generation_changed'), 'workspace_reuse_fallback logged cleanly');
  // Completed open-PR task remains resumable for round 4!
  assert.equal(findResumableBotPrTask(store, '101', 88)?.id, taskId);
});

test('#1331 rebind clears session and harness_state when role harness changes between rounds', async t => {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  const now = new Date().toISOString();
  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'gh-tok' }, 'account:a'), now);
  store.run("INSERT INTO repositories VALUES('101','fixture/repo','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:9/v1', 'fixture', store.secrets.seal({ value: 'k' }, 'model:m'), now);
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling) VALUES('101','m',1,1,'develop')");
  // V2 role config starts with dev on pi (default), then admin switches dev to scriptedHarness before round 2.
  saveConfiguration(store, '101', { expected_revision: 0, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'pi' } }] }, 'owner');

  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,object_number,created_at,updated_at) VALUES('t-rebind','101','task.request','queued','prepare','Rebind',?,42,?,?)",
    JSON.stringify({ generic: true, target: { type: 'issue', number: 42 } }),
    now,
    now,
  );
  new TaskRecords(store).contract('t-rebind', { goal: 'Test rebind', scope: ['app.mjs'], criteria: ['ok'], endpoint: 'reviewable_pull_request', source: { type: 'test' }, completeness: 'explicit' });
  store.run("UPDATE tasks SET status='pr_opened',phase='done' WHERE id='t-rebind'");
  setGrant(store, { id: 't-rebind', repository_id: '101' }, ['pull_request'], 'role:manager', null);
  captureTaskConfiguration(store, 't-rebind');
  // Simulate round 1 ran on pi with saved harness_state + session
  store.run(
    "INSERT INTO role_instances(id,task_id,role,definition,harness,session,harness_state,updated_at) VALUES('ri-switch','t-rebind','dev','{\"version\":\"old\"}','pi',?,?,?)",
    JSON.stringify([{ role: 'user', content: 'old pi transcript' }]),
    JSON.stringify({ harness: 'pi', sessionId: 'pi-old-123' }),
    now,
  );
  // Admin switches dev role harness from pi -> scriptedHarness (process), then round 2 wakes the task!
  saveConfiguration(store, '101', { expected_revision: 1, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: scriptedHarness } }] }, 'owner');
  assert.equal(continueDevelopmentTask(store, 't-rebind'), true);
  // Before runRole, harness_state was preserved; on runRole rebind sees pi !== process and clears it!
  const before = store.get("SELECT harness,harness_state,session FROM role_instances WHERE id='ri-switch'");
  assert.equal(before.harness, 'pi');
  assert.equal(JSON.parse(before.harness_state).sessionId, 'pi-old-123');

  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: toolCall('c1', 'submit_report', { summary: 'ok', artifacts: [] }) }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(r => { model.close(r); model.closeAllConnections(); }));
  store.run('UPDATE models SET api_url=? WHERE id=?', `http://127.0.0.1:${model.address().port}/v1`, 'm');
  store.run('DELETE FROM task_execution_configs WHERE task_id=?', 't-rebind');
  captureTaskConfiguration(store, 't-rebind');

  const task = store.get('SELECT * FROM tasks WHERE id=?', 't-rebind');
  await runRole(
    {
      store,
      task,
      redactor: { add() {}, clean: v => v, text: s => String(s), values: [] },
      guard: async () => {},
      system: 'dev',
      prompt: 'round 2',
      tools: [{ type: 'function', function: { name: 'submit_report', description: 'submit', parameters: { type: 'object', properties: { summary: { type: 'string' }, artifacts: { type: 'array' } }, required: ['summary', 'artifacts'] } } }],
      finish: { name: 'submit_report', validate: v => v },
      validate: s => JSON.parse(s),
    },
    'dev',
  );
  const after = store.get("SELECT harness,harness_state FROM role_instances WHERE id='ri-switch'");
  assert.equal(after.harness, scriptedHarness);
  assert.equal(after.harness_state, '{}', 'incompatible pi harness_state cleared on harness switch');
  assert.ok(store.get("SELECT 1 FROM task_history WHERE task_id='t-rebind' AND type='role_harness_changed'"), 'role_harness_changed traced');
});
