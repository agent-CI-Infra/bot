// #1424: Controlled automatic cleanup of remote `bot/*` temporary branches after a Bot PR is merged
// (immediate async deletion, non-blocking webhook) or closed unmerged (48-hour retention, cancelled on reopen),
// driven by both webhooks and background reconcile/scanner sweeps, enforcing all strict ownership & live-check gates
// under both `github_app` and `bot_account`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { botPrGraphql } from '../../../fixtures/bot-pr-graphql.mjs';
import { appEvents, appPermissions } from '../../../../dist/github/client.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { BotPrWakeScanner, setBotPatrolConfigForTest, syncBotPullRequestState } from '../../../../dist/review/bot-pr-wake.js';
import {
  BOT_PR_CLOSED_BRANCH_RETENTION_MS,
  awaitPendingBranchCleanups,
  backfillLegacyBotPrBranchCleanup,
  cleanupBotPrBranch,
  cleanupDueBotPrBranches,
  setBotPrBranchCleanupConfigForTest,
} from '../../../../dist/review/bot-pr-branch-cleanup.js';
import { githubWrite } from '../../../../dist/github/write.js';
import { defaultPermissions, githubWriteAllowed } from '../../../../dist/roles/permissions.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const oid = (...parts) => createHash('sha1').update(parts.join(':')).digest('hex');

async function createCleanupFixture(t, { accountType = 'github_app', installationPermissions, ceiling = 'develop' } = {}) {
  let clock = Date.parse('2026-11-28T00:00:00.000Z');
  setBotPatrolConfigForTest({ intervalMs: 0, now: () => clock });
  setBotPrBranchCleanupConfigForTest({ now: () => clock });
  t.after(() => {
    setBotPrBranchCleanupConfigForTest(null);
    setBotPatrolConfigForTest(null);
  });

  const botActor = accountType === 'bot_account'
    ? { id: 777, login: 'ci-bot-user', type: 'User' }
    : { id: 999, login: 'dept-bot[bot]', type: 'Bot' };
  const humanActor = { id: 800, login: 'alice', type: 'User' };

  const baseSha = oid('main', 1);
  const state = {
    botActor,
    humanActor,
    baseSha,
    defaultBranch: 'main',
    installationPermissions: { ...(installationPermissions ?? appPermissions) },
    refs: new Map([['main', baseSha]]),
    pulls: new Map(),
    checkSuites: new Map(),
    tokenMints: [],
    revokedTokens: [],
    deletes: [],
    requests: [],
    deleteStatusOverride: null, // e.g. () => ({ status, body, headers })
    pullGetOverride: null,
    openPrsOverride: null,
    onDeleteBeforeReply: null, // async gate for non-blocking webhook verification
    onAfterDelete: null, // hook invoked after DELETE removes ref (e.g. simulate racing push recreating ref)
    mintCounter: 0,
  };

  const tokenPermissionsByToken = new Map();

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture.github');
    const path = decodeURIComponent(url.pathname);
    const body = raw ? JSON.parse(raw) : {};
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    state.requests.push({ method: req.method, path, rawPath: url.pathname, query: url.search, body, token: auth });

    const send = (value, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };

    if (path === '/app') return send({ id: 77, slug: 'dept-bot', permissions: state.installationPermissions, events: appEvents });
    if (path === '/user' || path === '/users/dept-bot[bot]') return send(botActor);
    if (path === '/repos/fixture/project-101/installation') {
      return send({ id: 55, account: { id: 10, login: 'fixture' }, permissions: state.installationPermissions, events: appEvents });
    }
    if (path === '/app/installations/55/access_tokens' && req.method === 'POST') {
      const requested = body.permissions || {};
      const missing = Object.entries(requested).some(([k, v]) => !state.installationPermissions[k] || (v === 'write' && state.installationPermissions[k] !== 'write'));
      if (missing) return send({ message: 'The permissions requested are not granted to this installation.' }, 422);
      const token = `ghs_tok_${++state.mintCounter}`;
      tokenPermissionsByToken.set(token, requested);
      state.tokenMints.push({ token, repository_ids: body.repository_ids, permissions: requested });
      return send({ token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: requested }, 201);
    }
    if (path === '/installation/token' && req.method === 'DELETE') {
      state.revokedTokens.push(auth);
      res.writeHead(204);
      return res.end();
    }
    if (path === '/repositories/101') {
      return send({ id: 101, full_name: 'fixture/project-101', owner: { id: 10, login: 'fixture' }, default_branch: state.defaultBranch });
    }
    if (path === '/graphql' && req.method === 'POST') {
      const refsObj = Object.fromEntries(state.refs.entries());
      return send(botPrGraphql(body, { pulls: state.pulls, refs: refsObj, checkSuites: state.checkSuites }));
    }

    const prefix = '/repos/fixture/project-101';
    if (!path.startsWith(prefix)) return send({ message: 'Not Found' }, 404);
    const sub = path.slice(prefix.length);

    let m;
    if (sub === '/pulls' && req.method === 'GET') {
      if (state.openPrsOverride) {
        const custom = state.openPrsOverride(url.searchParams);
        if (custom) return send(custom.body, custom.status ?? 200, custom.headers);
      }
      const reqState = url.searchParams.get('state') || 'open';
      const reqHead = url.searchParams.get('head') || '';
      const reqBase = url.searchParams.get('base') || '';
      const matched = [];
      for (const pr of state.pulls.values()) {
        if (reqState !== 'all' && pr.state !== reqState) continue;
        if (reqHead) {
          const [owner, branch] = reqHead.split(':');
          if (owner !== 'fixture' || pr.head?.ref !== branch || Number(pr.head?.repo?.id) !== 101) continue;
        }
        if (reqBase && pr.base?.ref !== reqBase) continue;
        matched.push(pr);
      }
      return send(matched);
    }

    if ((m = /^\/pulls\/(\d+)$/.exec(sub)) && req.method === 'GET') {
      const num = Number(m[1]);
      if (state.pullGetOverride) {
        const custom = state.pullGetOverride(num);
        if (custom) return send(custom.body, custom.status ?? 200, custom.headers);
      }
      const pr = state.pulls.get(num);
      return send(pr ?? { message: 'Not Found' }, pr ? 200 : 404);
    }

    if ((m = /^\/pulls\/(\d+)$/.exec(sub)) && req.method === 'PATCH') {
      const pr = state.pulls.get(Number(m[1]));
      if (!pr) return send({ message: 'Not Found' }, 404);
      if (body.state) pr.state = body.state;
      if (body.state === 'closed' && !pr.closed_at) pr.closed_at = new Date(clock).toISOString();
      return send(pr, 200);
    }

    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(sub)) && req.method === 'PUT') {
      const pr = state.pulls.get(Number(m[1]));
      if (!pr) return send({ message: 'Not Found' }, 404);
      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = new Date(clock).toISOString();
      pr.closed_at = pr.merged_at;
      return send({ sha: oid('merge', pr.number), merged: true, message: 'Merged' }, 200);
    }

    if ((m = /^\/pulls\/(\d+)\/files$/.exec(sub)) && req.method === 'GET') {
      return send([{ filename: 'src/app.ts', status: 'modified' }]);
    }
    if (sub === '/rules/branches/main' && req.method === 'GET') return send([]);
    if (sub === '/branches/main' && req.method === 'GET') return send({ name: 'main', protected: false });
    if (/^\/pulls\/\d+\/reviews$/.test(sub) || /^\/issues\/\d+\/comments$/.test(sub)) return send([]);
    if (/^\/commits\/[a-f0-9]{40}\/check-suites$/.test(sub)) return send({ check_suites: [] });
    if (/^\/commits\/[a-f0-9]{40}\/check-runs$/.test(sub)) return send({ check_runs: [] });

    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(sub)) && req.method === 'GET') {
      const branch = m[1];
      const sha = state.refs.get(branch);
      return sha ? send({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }) : send({ message: 'Not Found' }, 404);
    }

    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(sub)) && req.method === 'DELETE') {
      const branch = m[1];
      if (state.onDeleteBeforeReply) await state.onDeleteBeforeReply(branch);
      if (state.deleteStatusOverride) {
        const custom = state.deleteStatusOverride(branch, auth);
        if (custom) return send(custom.body ?? { message: 'override' }, custom.status, custom.headers);
      }
      if (accountType === 'github_app') {
        const perms = tokenPermissionsByToken.get(auth);
        if (!perms || perms.contents !== 'write') {
          return send({ message: 'Resource not accessible by integration' }, 403);
        }
      }
      if (!state.refs.has(branch)) return send({ message: 'Reference does not exist' }, 404);
      state.refs.delete(branch);
      state.deletes.push({ branch, rawPath: url.pathname, token: auth, permissions: tokenPermissionsByToken.get(auth) ?? null });
      if (state.onAfterDelete) await state.onAfterDelete(branch);
      res.writeHead(204);
      return res.end();
    }

    return send({ message: `Unhandled ${req.method} ${path}` }, 404);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const githubUrl = `http://127.0.0.1:${server.address().port}`;

  const scheduleBranchCleanupCalls = [];
  let engine;
  let scanner;
  const h = await harness(t, undefined, store => {
    const e = new TaskEngine(store, undefined, githubUrl);
    const s = e.botPrWake;
    const origSchedule = s.scheduleBranchCleanup.bind(s);
    s.scheduleBranchCleanup = (repositoryId, prNumber) => {
      scheduleBranchCleanupCalls.push({ repositoryId, prNumber });
      return origSchedule(repositoryId, prNumber);
    };
    engine = e;
    scanner = s;
    return { githubUrl, engine: e };
  });
  const { admin } = await setup(h);
  const accOverrides = accountType === 'github_app'
    ? {
        type: 'github_app',
        app_id: '77',
        private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
        token: undefined,
      }
    : { type: 'bot_account' };
  const acc = await account(admin, accOverrides);
  await repository(admin, acc.id, '101');
  h.store.run("UPDATE policies SET enabled=1,capability_ceiling=?,base_branch='main' WHERE repository_id='101'", ceiling);
  h.store.run('INSERT OR REPLACE INTO github_actors VALUES(?,?,?,?)', acc.id, String(botActor.id), botActor.login, new Date(clock).toISOString());

  t.after(async () => {
    await awaitPendingBranchCleanups(h.store);
    await engine?.close();
  });

  const seedBotPr = (number, {
    branch = `bot/issue-${number}`,
    headSha = oid('head', number, 1),
    baseRef = 'main',
    headRepoId = 101,
    author = botActor,
    prState = 'open',
    merged = false,
    closedAt = null,
    sourceTaskId = `src-${number}`,
    registerBotBranch = true,
    registerBotPr = true,
  } = {}) => {
    const pr = {
      id: 5000 + number,
      number,
      title: `PR #${number}`,
      body: '',
      state: prState,
      draft: false,
      merged,
      merged_at: merged ? (closedAt ?? new Date(clock).toISOString()) : null,
      closed_at: prState === 'closed' ? (closedAt ?? new Date(clock).toISOString()) : null,
      mergeable: true,
      mergeable_state: 'clean',
      updated_at: new Date(clock).toISOString(),
      user: author,
      labels: [],
      html_url: `https://github.com/fixture/project-101/pull/${number}`,
      head: { sha: headSha, ref: branch, repo: { id: headRepoId } },
      base: { sha: baseSha, ref: baseRef, repo: { id: 101 } },
    };
    state.pulls.set(number, pr);
    if (headRepoId === 101) state.refs.set(branch, headSha);
    if (registerBotPr) {
      h.store.run(
        "INSERT OR REPLACE INTO bot_pull_requests VALUES('101',?,?,?,?,?,?,?,0)",
        number,
        String(pr.id),
        String(author.id),
        String(headRepoId),
        branch,
        headSha,
        sourceTaskId,
      );
    }
    if (registerBotBranch) {
      h.store.run("INSERT OR REPLACE INTO bot_branches VALUES('101',?,?)", branch, sourceTaskId);
    }
    return pr;
  };

  const prStateRow = number => h.store.get("SELECT * FROM bot_pr_states WHERE repository_id='101' AND number=?", number);
  const audits = () => h.store.all("SELECT action,resource_id FROM audit WHERE repository_id='101' AND action LIKE 'bot_pr.branch_%' ORDER BY rowid ASC").map(r => ({ ...r }));

  return {
    h,
    acc,
    state,
    get scanner() { return scanner; },
    scheduleBranchCleanupCalls,
    githubUrl,
    seedBotPr,
    prStateRow,
    audits,
    get clock() { return clock; },
    advance: ms => { clock += ms; },
  };
}

test('merged Bot PR deletes remote bot/* branch immediately & asynchronously without blocking webhook, mints single-use contents:write token and revokes it (github_app)', async t => {
  const f = await createCleanupFixture(t, { accountType: 'github_app' });
  const pr = f.seedBotPr(88, { branch: 'bot/issue-42' });
  syncBotPullRequestState(f.h.store, '101', pr);

  // Hold GitHub DELETE open until after webhook HTTP 200 returns to prove webhook is never blocked.
  let releaseDelete;
  let deleteStartedResolve;
  const deleteStarted = new Promise(r => { deleteStartedResolve = r; });
  const deleteGate = new Promise(r => { releaseDelete = r; });
  f.state.onDeleteBeforeReply = async () => {
    deleteStartedResolve();
    await deleteGate;
  };

  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = new Date(f.clock).toISOString();
  pr.closed_at = pr.merged_at;

  const hookRes = await f.h.hook(f.acc.path, f.acc.secret, 'pr-88-merged', {
    action: 'closed',
    repository: { id: 101 },
    number: 88,
    pull_request: pr,
    sender: f.state.humanActor,
  }, { 'X-GitHub-Event': 'pull_request' });

  // Webhook returned 200 BEFORE GitHub DELETE completed, and dispatched through engine.botPrWake.scheduleBranchCleanup.
  assert.equal(hookRes.status, 200);
  assert.deepEqual(f.scheduleBranchCleanupCalls, [{ repositoryId: '101', prNumber: 88 }]);
  assert.equal(f.state.deletes.length, 0, 'DELETE must run asynchronously after webhook response');

  await deleteStarted;
  releaseDelete();
  await awaitPendingBranchCleanups(f.h.store);

  // Post-delete read-only GET confirmed 404 before marking terminal `deleted`.
  const refGets = f.state.requests.filter(r => r.method === 'GET' && r.path === '/repos/fixture/project-101/git/ref/heads/bot/issue-42');
  assert.equal(refGets.length, 2, 'expected pre-delete GET and post-delete 404 confirmation GET');

  // Closing the scanner drains tracked cleanups and refuses new schedules cleanly with zero extra GitHub calls.
  await f.scanner.close();
  const reqCountAfterClose = f.state.requests.length;
  const closedRes = await f.scanner.scheduleBranchCleanup('101', 88);
  assert.equal(closedRes.status, 'noop');
  assert.equal(closedRes.reason, 'closing');
  assert.equal(f.state.requests.length, reqCountAfterClose);

  // Branch deleted on GitHub using literal slash path and single-use minimal { contents: 'write' } token.
  assert.equal(f.state.deletes.length, 1);
  assert.equal(f.state.deletes[0].branch, 'bot/issue-42');
  assert.equal(f.state.deletes[0].rawPath, '/repos/fixture/project-101/git/refs/heads/bot/issue-42');
  assert.deepEqual(f.state.deletes[0].permissions, { contents: 'write' });
  assert.equal(f.state.refs.has('bot/issue-42'), false);

  // Both the read-only installation token and the single-use write token were scoped to repo 101 and revoked immediately.
  const writeMint = f.state.tokenMints.find(m => m.permissions.contents === 'write');
  const readMint = f.state.tokenMints.find(m => m.permissions.contents === 'read');
  assert.ok(writeMint && readMint);
  assert.deepEqual(writeMint.repository_ids, [101]);
  assert.deepEqual(writeMint.permissions, { contents: 'write' });
  assert.ok(f.state.revokedTokens.includes(writeMint.token), 'write installation token revoked immediately');
  assert.ok(f.state.revokedTokens.includes(readMint.token), 'read installation token revoked in finally');

  // Local state: bot_pull_requests preserved, bot_branches cleaned, bot_pr_states updated, audit logged.
  assert.ok(f.h.store.get("SELECT * FROM bot_pull_requests WHERE repository_id='101' AND number=88"), 'bot_pull_requests history preserved');
  assert.equal(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/issue-42'"), undefined, 'unreferenced bot_branches cleaned');
  const st = f.prStateRow(88);
  assert.equal(st.state, 'closed');
  assert.equal(st.merged, 1);
  assert.equal(st.branch_cleanup_status, 'deleted');
  assert.equal(st.branch_cleanup_reason, 'merged');
  assert.equal(st.branch_delete_due_at, null);
  assert.deepEqual(f.audits(), [{ action: 'bot_pr.branch_deleted', resource_id: 'pr#88:bot/issue-42' }]);
});

test('merged Bot PR deletes remote bot/* branch under bot_account without installation token revocation', async t => {
  const f = await createCleanupFixture(t, { accountType: 'bot_account' });
  const pr = f.seedBotPr(91, { branch: 'bot/issue-91' });
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = new Date(f.clock).toISOString();
  pr.closed_at = pr.merged_at;

  const res = await f.h.hook(f.acc.path, f.acc.secret, 'pr-91-merged-pat', {
    action: 'closed',
    repository: { id: 101 },
    number: 91,
    pull_request: pr,
    sender: f.state.humanActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.equal(res.status, 200);
  await awaitPendingBranchCleanups(f.h.store);

  assert.equal(f.state.deletes.length, 1);
  assert.equal(f.state.deletes[0].branch, 'bot/issue-91');
  assert.equal(f.state.revokedTokens.length, 0);
  assert.equal(f.prStateRow(91).branch_cleanup_status, 'deleted');
});

test('unmerged closed Bot PR retains remote branch for exact 48h, survives restart, enforces live pr.closed_at, and deletes on expiry', async t => {
  const f = await createCleanupFixture(t, { accountType: 'github_app' });
  const closedAt = new Date(f.clock).toISOString();
  const pr = f.seedBotPr(102, { branch: 'bot/issue-102' });
  pr.state = 'closed';
  pr.merged = false;
  pr.closed_at = closedAt;

  await f.h.hook(f.acc.path, f.acc.secret, 'pr-102-closed', {
    action: 'closed',
    repository: { id: 101 },
    number: 102,
    pull_request: pr,
    sender: f.state.humanActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  await awaitPendingBranchCleanups(f.h.store);

  const stInitial = f.prStateRow(102);
  assert.equal(stInitial.merged, 0);
  assert.equal(stInitial.closed_at, closedAt);
  assert.equal(stInitial.branch_cleanup_status, 'pending');
  assert.equal(stInitial.branch_delete_due_at, f.clock + BOT_PR_CLOSED_BRANCH_RETENTION_MS);
  assert.equal(f.state.deletes.length, 0, 'must NOT delete immediately on unmerged close');

  // 47h 59m later: still NOT due -> zero GitHub requests!
  f.advance(47 * HOUR + 59 * MINUTE);
  const reqCountBefore = f.state.requests.length;
  await f.scanner.tick();
  assert.equal(f.state.requests.length, reqCountBefore, 'zero GitHub calls before 48h expiry');
  assert.equal(f.state.refs.has('bot/issue-102'), true);

  // Even if local branch_delete_due_at is skewed earlier than live GitHub closed_at + 48h, live check refuses early delete and fixes due time.
  f.h.store.run("UPDATE bot_pr_states SET branch_delete_due_at=? WHERE repository_id='101' AND number=102", f.clock - 1000);
  await f.scanner.tick();
  assert.equal(f.state.deletes.length, 0, 'live closed_at check must prevent early deletion');
  assert.equal(f.prStateRow(102).branch_cleanup_status, 'pending');
  assert.equal(f.prStateRow(102).branch_delete_due_at, Date.parse(closedAt) + 48 * HOUR);

  // Simulate control-plane restart (stop harness + close SQLite + reopen fresh harness & scanner).
  await f.scanner.close();
  await f.h.stop();
  await f.h.start();
  const restartedScanner = new BotPrWakeScanner(f.h.store, f.githubUrl);
  t.after(() => restartedScanner.close());

  // Advance the remaining 1 minute to reach exact 48h expiry.
  f.advance(MINUTE);
  await restartedScanner.tick();
  assert.equal(f.state.deletes.length, 1);
  assert.equal(f.state.deletes[0].branch, 'bot/issue-102');
  assert.equal(f.prStateRow(102).branch_cleanup_status, 'deleted');
  assert.equal(f.prStateRow(102).branch_cleanup_reason, 'closed_48h_expired');
  assert.equal(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/issue-102'"), undefined);
  assert.ok(f.h.store.get("SELECT * FROM bot_pull_requests WHERE repository_id='101' AND number=102"));
});

test('reopening a closed Bot PR within 48h cancels deletion via webhook AND via live check if reopen webhook was missed', async t => {
  const f = await createCleanupFixture(t);
  const closedAt = new Date(f.clock).toISOString();

  // Case A: Reopen webhook arrives within 48h.
  const prA = f.seedBotPr(110, { branch: 'bot/issue-110' });
  prA.state = 'closed';
  prA.merged = false;
  prA.closed_at = closedAt;
  await f.h.hook(f.acc.path, f.acc.secret, 'pr-110-closed', {
    action: 'closed', repository: { id: 101 }, number: 110, pull_request: prA, sender: f.state.humanActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.equal(f.prStateRow(110).branch_cleanup_status, 'pending');

  f.advance(10 * HOUR);
  prA.state = 'open';
  prA.closed_at = null;
  await f.h.hook(f.acc.path, f.acc.secret, 'pr-110-reopened', {
    action: 'reopened', repository: { id: 101 }, number: 110, pull_request: prA, sender: f.state.humanActor,
  }, { 'X-GitHub-Event': 'pull_request' });

  const stA = f.prStateRow(110);
  assert.equal(stA.state, 'open');
  assert.equal(stA.closed_at, null);
  assert.equal(stA.branch_delete_due_at, null);
  assert.equal(stA.branch_cleanup_status, null);

  // Case B: Reopen webhook missed -> live check at 48h catches open state and cancels without deleting.
  const prB = f.seedBotPr(111, { branch: 'bot/issue-111' });
  prB.state = 'closed';
  prB.merged = false;
  prB.closed_at = new Date(f.clock).toISOString();
  await f.h.hook(f.acc.path, f.acc.secret, 'pr-111-closed', {
    action: 'closed', repository: { id: 101 }, number: 111, pull_request: prB, sender: f.state.humanActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  // PR #111 is reopened on GitHub without delivering a webhook.
  prB.state = 'open';
  prB.closed_at = null;

  f.advance(48 * HOUR);
  await f.scanner.tick();
  assert.equal(f.state.deletes.length, 0, 'neither reopened PR may have its branch deleted');
  assert.equal(f.state.refs.has('bot/issue-110'), true);
  assert.equal(f.state.refs.has('bot/issue-111'), true);
  assert.equal(f.prStateRow(111).state, 'open');
  assert.equal(f.prStateRow(111).branch_cleanup_status, null);
  assert.equal(f.prStateRow(111).branch_delete_due_at, null);
  const cancelAudits = f.audits().filter(a => a.action === 'bot_pr.branch_cleanup_cancelled');
  assert.equal(cancelAudits.length, 2);
});

test('reconcile fallback detects missed close/merge webhooks and schedules or executes remote branch cleanup', async t => {
  const f = await createCleanupFixture(t);
  const prMerged = f.seedBotPr(120, { branch: 'bot/issue-120' });
  const prClosed = f.seedBotPr(121, { branch: 'bot/issue-121' });
  syncBotPullRequestState(f.h.store, '101', prMerged);
  syncBotPullRequestState(f.h.store, '101', prClosed);

  // Both PRs transition on GitHub WITHOUT delivering webhooks.
  prMerged.state = 'closed';
  prMerged.merged = true;
  prMerged.merged_at = new Date(f.clock).toISOString();
  prMerged.closed_at = prMerged.merged_at;

  prClosed.state = 'closed';
  prClosed.merged = false;
  prClosed.closed_at = new Date(f.clock).toISOString();

  await f.scanner.tick();

  // Merged PR #120 was discovered by reconcile AND deleted in the same tick.
  assert.equal(f.state.refs.has('bot/issue-120'), false);
  assert.equal(f.prStateRow(120).branch_cleanup_status, 'deleted');

  // Unmerged closed PR #121 was discovered by reconcile and scheduled for +48h (not deleted yet).
  assert.equal(f.state.refs.has('bot/issue-121'), true);
  assert.equal(f.prStateRow(121).branch_cleanup_status, 'pending');
  assert.equal(f.prStateRow(121).branch_delete_due_at, f.clock + 48 * HOUR);

  f.advance(48 * HOUR);
  await f.scanner.tick();
  assert.equal(f.state.refs.has('bot/issue-121'), false);
  assert.equal(f.prStateRow(121).branch_cleanup_status, 'deleted');
});

test('strict security boundaries block every unsafe deletion: non-bot PR, non-bot branch, default/base branch, fork PR, live identity mismatch, moved HEAD SHA, other open PR, active task, and 404 already-deleted', async t => {
  const f = await createCleanupFixture(t);

  // 1. Human / non-Bot PR (not in bot_pull_requests): webhook ignored, zero deletes.
  const humanPr = f.seedBotPr(200, {
    branch: 'alice/feature',
    author: f.state.humanActor,
    registerBotPr: false,
    registerBotBranch: false,
  });
  humanPr.state = 'closed';
  humanPr.merged = true;
  humanPr.merged_at = new Date(f.clock).toISOString();
  humanPr.closed_at = humanPr.merged_at;
  await f.h.hook(f.acc.path, f.acc.secret, 'human-200', {
    action: 'closed', repository: { id: 101 }, number: 200, pull_request: humanPr, sender: f.state.humanActor,
  }, { 'X-GitHub-Event': 'pull_request' });
  await awaitPendingBranchCleanups(f.h.store);
  assert.equal(f.state.refs.has('alice/feature'), true);

  // 2. Non-`bot/` branch even if somehow listed in bot_pull_requests.
  const nonBotBranchPr = f.seedBotPr(201, { branch: 'feature/human-branch', prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', nonBotBranchPr);
  const res201 = await cleanupBotPrBranch(f.h.store, '101', 201, { apiUrl: f.githubUrl });
  assert.equal(res201.status, 'skipped');
  assert.equal(res201.reason, 'invalid_or_protected_branch');
  assert.equal(f.state.refs.has('feature/human-branch'), true);

  // 3. Default branch (`main`) and PR base branch (even with `bot/` prefix).
  const baseBranchPr = f.seedBotPr(202, { branch: 'bot/release-base', baseRef: 'bot/release-base', prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', baseBranchPr);
  const res202 = await cleanupBotPrBranch(f.h.store, '101', 202, { apiUrl: f.githubUrl });
  assert.equal(res202.status, 'skipped');
  assert.equal(res202.reason, 'invalid_or_protected_branch');
  assert.equal(f.state.refs.has('bot/release-base'), true);

  // 4. Cross-repository fork PR (`head_repository_id !== repository_id`).
  const forkPr = f.seedBotPr(203, { branch: 'bot/fork-branch', headRepoId: 9999, prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', forkPr);
  const res203 = await cleanupBotPrBranch(f.h.store, '101', 203, { apiUrl: f.githubUrl });
  assert.equal(res203.status, 'skipped');
  assert.equal(res203.reason, 'cross_repository_head');

  // 5. Live author mismatch & live head_ref mismatch on GET /pulls/{n}.
  const authorMismatchPr = f.seedBotPr(204, { branch: 'bot/issue-204', prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', authorMismatchPr);
  authorMismatchPr.user = f.state.humanActor; // live GitHub says a human authored it
  const res204 = await cleanupBotPrBranch(f.h.store, '101', 204, { apiUrl: f.githubUrl });
  assert.equal(res204.status, 'skipped');
  assert.equal(res204.reason, 'pr_author_mismatch');
  assert.equal(f.state.refs.has('bot/issue-204'), true);

  const headRefMismatchPr = f.seedBotPr(210, { branch: 'bot/issue-210', prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', headRefMismatchPr);
  headRefMismatchPr.head = { ...headRefMismatchPr.head, ref: 'bot/renamed-210' };
  const res210 = await cleanupBotPrBranch(f.h.store, '101', 210, { apiUrl: f.githubUrl });
  assert.equal(res210.status, 'skipped');
  assert.equal(res210.reason, 'head_branch_mismatch');
  assert.equal(f.state.refs.has('bot/issue-210'), true);

  // 6. Remote HEAD SHA moved after PR closed (new commit pushed).
  const movedHeadPr = f.seedBotPr(205, { branch: 'bot/issue-205', prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', movedHeadPr);
  f.state.refs.set('bot/issue-205', oid('new-commit-after-close'));
  const res205 = await cleanupBotPrBranch(f.h.store, '101', 205, { apiUrl: f.githubUrl });
  assert.equal(res205.status, 'skipped');
  assert.equal(res205.reason, 'head_sha_changed');
  assert.equal(f.state.refs.has('bot/issue-205'), true);
  assert.ok(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/issue-205'"), 'bot_branches retained when skipped');

  // 7. Another open PR on GitHub still uses the same branch (`GET /pulls?state=open&head=fixture:bot/issue-206`).
  const sharedHead = oid('shared-head-206');
  const closedPr206 = f.seedBotPr(206, { branch: 'bot/issue-206', headSha: sharedHead, prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', closedPr206);
  // Open human/other PR on the same branch (not registered in bot_pull_requests so local check passes, live check catches it!).
  f.seedBotPr(207, {
    branch: 'bot/issue-206',
    headSha: sharedHead,
    prState: 'open',
    author: f.state.humanActor,
    registerBotPr: false,
    registerBotBranch: false,
  });
  const res206 = await cleanupBotPrBranch(f.h.store, '101', 206, { apiUrl: f.githubUrl });
  assert.equal(res206.status, 'skipped');
  assert.equal(res206.reason, 'other_open_pr_exists');
  assert.equal(f.state.refs.has('bot/issue-206'), true);
  assert.ok(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/issue-206'"));

  // 8. Active non-terminal local task bound to branch -> deferred, zero deletes; once task terminates -> deletes!
  const activeTaskPr = f.seedBotPr(208, { branch: 'bot/issue-208', prState: 'closed', merged: true, sourceTaskId: 'task-active-208' });
  f.h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input,created_at,updated_at) VALUES('task-active-208','101','task.request','implementing','still active',208,'{}',?,?)",
    new Date(f.clock).toISOString(),
    new Date(f.clock).toISOString(),
  );
  syncBotPullRequestState(f.h.store, '101', activeTaskPr);
  const res208Deferred = await cleanupBotPrBranch(f.h.store, '101', 208, { apiUrl: f.githubUrl });
  assert.equal(res208Deferred.status, 'deferred');
  assert.equal(res208Deferred.reason, 'active_task_bound');
  assert.equal(f.state.refs.has('bot/issue-208'), true);

  // Zero unsafe deletes happened across ALL 8 boundary checks!
  assert.equal(f.state.deletes.length, 0, `expected zero deletes for unsafe cases, got: ${JSON.stringify(f.state.deletes)}`);

  // Now task-active-208 finishes and backoff elapses -> branch is cleanly deleted!
  f.h.store.run("UPDATE tasks SET status='completed' WHERE id='task-active-208'");
  f.advance(2 * MINUTE);
  await f.scanner.tick();
  assert.equal(f.state.deletes.length, 1);
  assert.equal(f.state.deletes[0].branch, 'bot/issue-208');
  assert.equal(f.prStateRow(208).branch_cleanup_status, 'deleted');

  // 9. Remote branch already deleted (404 on GET /git/ref/heads/...) -> gracefully marked already_deleted & cleans bot_branches.
  const gonePr = f.seedBotPr(209, { branch: 'bot/issue-209', prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', gonePr);
  f.state.refs.delete('bot/issue-209');
  const res209 = await cleanupBotPrBranch(f.h.store, '101', 209, { apiUrl: f.githubUrl });
  assert.equal(res209.status, 'already_deleted');
  assert.equal(res209.reason, 'remote_branch_missing');
  assert.equal(f.prStateRow(209).branch_cleanup_status, 'already_deleted');
  assert.equal(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/issue-209'"), undefined);
  assert.ok(f.h.store.get("SELECT * FROM bot_pull_requests WHERE repository_id='101' AND number=209"));
});

test('missing contents:write, disabled project, lowered capability_ceiling, and 422 protected branch record blocked status without infinite retries', async t => {
  // A. Missing contents:write on github_app installation.
  const fNoWrite = await createCleanupFixture(t, {
    accountType: 'github_app',
    installationPermissions: { ...appPermissions, contents: 'read' },
  });
  const prA = fNoWrite.seedBotPr(301, { branch: 'bot/issue-301', prState: 'closed', merged: true });
  syncBotPullRequestState(fNoWrite.h.store, '101', prA);
  await fNoWrite.scanner.tick();
  assert.equal(fNoWrite.state.deletes.length, 0);
  assert.equal(fNoWrite.prStateRow(301).branch_cleanup_status, 'blocked');
  assert.equal(fNoWrite.prStateRow(301).branch_cleanup_reason, 'missing_contents_write');
  assert.equal(fNoWrite.prStateRow(301).branch_delete_due_at, null);
  const reqAfterBlockA = fNoWrite.state.requests.length;
  fNoWrite.advance(10 * HOUR);
  await fNoWrite.scanner.tick();
  assert.equal(fNoWrite.state.requests.length, reqAfterBlockA, 'blocked PR must not retry infinitely');

  // B. Disabled project -> blocked with zero GitHub API calls.
  const fDisabled = await createCleanupFixture(t);
  const prB = fDisabled.seedBotPr(302, { branch: 'bot/issue-302', prState: 'closed', merged: true });
  fDisabled.h.store.run("UPDATE policies SET enabled=0 WHERE repository_id='101'");
  syncBotPullRequestState(fDisabled.h.store, '101', prB);
  const reqBeforeDisabled = fDisabled.state.requests.length;
  await fDisabled.scanner.tick();
  assert.equal(fDisabled.state.requests.length, reqBeforeDisabled, 'disabled project must make zero GitHub calls');
  assert.equal(fDisabled.prStateRow(302).branch_cleanup_status, 'blocked');
  assert.equal(fDisabled.prStateRow(302).branch_cleanup_reason, 'project_disabled');

  // C. Lowered capability_ceiling ('comment') -> blocked with zero GitHub API calls.
  const fCeiling = await createCleanupFixture(t, { ceiling: 'comment' });
  const prC = fCeiling.seedBotPr(303, { branch: 'bot/issue-303', prState: 'closed', merged: true });
  syncBotPullRequestState(fCeiling.h.store, '101', prC);
  const reqBeforeCeiling = fCeiling.state.requests.length;
  await fCeiling.scanner.tick();
  assert.equal(fCeiling.state.requests.length, reqBeforeCeiling, 'insufficient ceiling must make zero GitHub calls');
  assert.equal(fCeiling.prStateRow(303).branch_cleanup_status, 'blocked');
  assert.equal(fCeiling.prStateRow(303).branch_cleanup_reason, 'capability_ceiling_insufficient');

  // D. Protected branch (HTTP 422 on DELETE) -> blocked cleanly, write token still revoked, no infinite retries.
  const f422 = await createCleanupFixture(t);
  const prD = f422.seedBotPr(304, { branch: 'bot/issue-304', prState: 'closed', merged: true });
  syncBotPullRequestState(f422.h.store, '101', prD);
  f422.state.deleteStatusOverride = () => ({ status: 422, body: { message: 'Reference cannot be updated (protected branch)' } });
  await f422.scanner.tick();
  assert.equal(f422.prStateRow(304).branch_cleanup_status, 'blocked');
  assert.equal(f422.prStateRow(304).branch_cleanup_reason, 'branch_protected_422');
  assert.equal(f422.prStateRow(304).branch_delete_due_at, null);
  const writeMint422 = f422.state.tokenMints.find(m => m.permissions.contents === 'write');
  assert.ok(writeMint422 && f422.state.revokedTokens.includes(writeMint422.token), 'write token revoked even after 422');

  // E. bot_account HTTP 403 on DELETE -> blocked as missing_contents_write without infinite retries.
  const fPat403 = await createCleanupFixture(t, { accountType: 'bot_account' });
  const prE = fPat403.seedBotPr(305, { branch: 'bot/issue-305', prState: 'closed', merged: true });
  syncBotPullRequestState(fPat403.h.store, '101', prE);
  fPat403.state.deleteStatusOverride = () => ({ status: 403, body: { message: 'Must have push access to delete refs' } });
  await fPat403.scanner.tick();
  assert.equal(fPat403.prStateRow(305).branch_cleanup_status, 'blocked');
  assert.equal(fPat403.prStateRow(305).branch_cleanup_reason, 'missing_contents_write');
});

test('transient 503 and rate-limit failures retry with backoff and succeed once recovered', async t => {
  const f = await createCleanupFixture(t);
  const pr = f.seedBotPr(401, { branch: 'bot/issue-401', prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', pr);

  let deleteCalls = 0;
  f.state.deleteStatusOverride = () => {
    deleteCalls++;
    if (deleteCalls === 1) return { status: 503, body: { message: 'Service Unavailable' } };
    if (deleteCalls === 2) {
      return {
        status: 429,
        body: { message: 'API rate limit exceeded' },
        headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'core' },
      };
    }
    return null;
  };

  // Attempt 1: HTTP 503 -> deferred with 1m backoff, attempts = 1.
  await f.scanner.tick();
  assert.equal(deleteCalls, 1);
  const after1 = f.prStateRow(401);
  assert.equal(after1.branch_cleanup_status, 'pending');
  assert.equal(after1.branch_cleanup_attempts, 1);
  assert.equal(after1.branch_delete_due_at, f.clock + MINUTE);

  // Before backoff expires -> no retry.
  f.advance(30_000);
  await f.scanner.tick();
  assert.equal(deleteCalls, 1);

  // Attempt 2 after 1m -> HTTP 429 rate-limited -> deferred at least max(5m backoff, retry-after), attempts = 2.
  f.advance(30_000);
  await f.scanner.tick();
  assert.equal(deleteCalls, 2);
  const after2 = f.prStateRow(401);
  assert.equal(after2.branch_cleanup_status, 'pending');
  assert.equal(after2.branch_cleanup_attempts, 2);
  assert.equal(after2.branch_cleanup_reason, 'github_rate_limited');
  assert.ok(after2.branch_delete_due_at >= f.clock + 5 * MINUTE);

  // Clear local rate-limit block window & advance past backoff -> Attempt 3 succeeds!
  f.h.store.run("DELETE FROM github_rate_limits WHERE resource='core'");
  f.advance(5 * MINUTE);
  await f.scanner.tick();
  assert.equal(deleteCalls, 3);
  assert.equal(f.state.deletes.length, 1);
  assert.equal(f.state.deletes[0].branch, 'bot/issue-401');
  assert.equal(f.prStateRow(401).branch_cleanup_status, 'deleted');
  assert.equal(f.prStateRow(401).branch_cleanup_attempts, 0);
});

test('github_write PATCH close and PUT merge sync branch cleanup schedule, and deleteProjectRecords cleans extended rows', async t => {
  const f = await createCleanupFixture(t, { accountType: 'bot_account' });
  f.h.store.run("UPDATE policies SET auto_merge_policy='allow_all' WHERE repository_id='101'");
  f.seedBotPr(501, { branch: 'bot/issue-501', prState: 'open' });
  f.seedBotPr(502, { branch: 'bot/issue-502', prState: 'open' });

  const repo = f.h.store.get("SELECT * FROM repositories WHERE id='101'");
  const role = defaultPermissions('manager', 'controller');
  const write = args => githubWrite({
    store: f.h.store,
    repository: repo,
    redactor: new Redactor(),
    guard: async () => {},
    apiUrl: f.githubUrl,
    scope: 'task:cleanup-test',
    actor: { kind: 'task', role: 'manager', task_id: 'task-cleanup-test' },
    allowed: (resource, op) => githubWriteAllowed(role, resource, op),
  }, args);

  // 1. Closing Bot PR #501 via github_write schedules 48h retention.
  const closedRes = await write({ method: 'PATCH', path: '/pulls/501', key: 'close-501', body: { state: 'closed' } });
  assert.equal(closedRes.status, 200);
  const st501 = f.prStateRow(501);
  assert.equal(st501.state, 'closed');
  assert.equal(st501.merged, 0);
  assert.equal(st501.branch_cleanup_status, 'pending');
  assert.equal(st501.branch_delete_due_at, f.clock + 48 * HOUR);

  // 2. Merging Bot PR #502 via github_write schedules immediate deletion (picked up by scanner).
  const mergedRes = await write({ method: 'PUT', path: '/pulls/502/merge', key: 'merge-502', body: { merge_method: 'rebase' } });
  assert.equal(mergedRes.merged, true);
  const st502 = f.prStateRow(502);
  assert.equal(st502.state, 'closed');
  assert.equal(st502.merged, 1);
  assert.equal(st502.branch_cleanup_status, 'pending');
  assert.equal(st502.branch_delete_due_at, f.clock);

  await f.scanner.tick();
  assert.equal(f.state.refs.has('bot/issue-502'), false, 'PR #502 branch deleted immediately on tick');
  assert.equal(f.state.refs.has('bot/issue-501'), true, 'PR #501 branch retained during 48h window');

  // 3. Project deletion cleans up bot_pr_states, bot_pull_requests, and bot_branches cleanly.
  deleteProjectRecords(f.h.store, '101', { files: false });
  assert.equal(f.h.store.get("SELECT count(*) n FROM bot_pr_states WHERE repository_id='101'").n, 0);
  assert.equal(f.h.store.get("SELECT count(*) n FROM bot_branches WHERE repository_id='101'").n, 0);
  assert.equal(f.h.store.get("SELECT count(*) n FROM bot_pull_requests WHERE repository_id='101'").n, 0);
});

test('F1 bounded legacy backfill deletes pre-existing closed/merged Bot PR branches in one pass, respects 48h retention, caps per-tick batch size, and handles missing state rows safely', async t => {
  const f = await createCleanupFixture(t, { accountType: 'github_app' });
  const seedLegacyClosedRow = (pr, { baseRef = 'main' } = {}) => {
    // Simulate a pre-#1424 closed row in bot_pr_states (branch_cleanup_status IS NULL, merged = 0, closed_at = NULL).
    f.h.store.run(
      `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,base_sha,head_sha,mergeable,mergeable_state,title,updated_at)
       VALUES('101',?,'closed',0,?,?,?,0,'clean',?,?)`,
      pr.number,
      baseRef,
      f.state.baseSha,
      pr.head.sha,
      pr.title,
      new Date(f.clock - 72 * HOUR).toISOString(),
    );
  };

  // 1. Legacy closed & merged PR (like production lingering bot/* branches): must be backfilled AND deleted in ONE scanner.tick()!
  const legacyMerged = f.seedBotPr(601, {
    branch: 'bot/legacy-merged-601',
    prState: 'closed',
    merged: true,
    closedAt: new Date(f.clock - 10 * 24 * HOUR).toISOString(),
  });
  seedLegacyClosedRow(legacyMerged);

  // 2. Legacy closed unmerged PR closed only 10h ago: must be backfilled with closed_at + 48h and retained for remaining 38h.
  const closed10hAgo = new Date(f.clock - 10 * HOUR).toISOString();
  const legacyRecentClosed = f.seedBotPr(602, {
    branch: 'bot/legacy-recent-602',
    prState: 'closed',
    merged: false,
    closedAt: closed10hAgo,
  });
  seedLegacyClosedRow(legacyRecentClosed);

  // 3. Legacy closed unmerged PR closed 72h ago (>48h): must be backfilled AND deleted in ONE pass.
  const closed72hAgo = new Date(f.clock - 72 * HOUR).toISOString();
  const legacyOldClosed = f.seedBotPr(603, {
    branch: 'bot/legacy-old-603',
    prState: 'closed',
    merged: false,
    closedAt: closed72hAgo,
  });
  seedLegacyClosedRow(legacyOldClosed);

  // 4. Legacy closed PR whose live author is a human (ownership mismatch): safely skipped, branch preserved.
  const legacyMismatch = f.seedBotPr(604, {
    branch: 'bot/legacy-mismatch-604',
    prState: 'closed',
    merged: true,
  });
  seedLegacyClosedRow(legacyMismatch);
  legacyMismatch.user = f.state.humanActor;

  // 5. Legacy closed PR on a non-bot branch: skipped locally with zero GitHub calls.
  const legacyNonBot = f.seedBotPr(605, {
    branch: 'feature/human-legacy-605',
    prState: 'closed',
    merged: true,
  });
  seedLegacyClosedRow(legacyNonBot);

  // Enforce bounded per-tick cap = 2 so the 5 legacy rows drain over 3 ticks (2 + 2 + 1).
  setBotPrBranchCleanupConfigForTest({ now: () => f.clock, legacyBatchLimit: 2 });

  // Tick 1: processes #601 and #602 only; #603..#605 remain untouched (NULL).
  await f.scanner.tick();
  assert.equal(f.state.refs.has('bot/legacy-merged-601'), false, '#601 legacy merged branch deleted in one pass');
  assert.equal(f.prStateRow(601).branch_cleanup_status, 'deleted');
  assert.equal(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/legacy-merged-601'"), undefined);
  assert.equal(f.state.refs.has('bot/legacy-recent-602'), true, '#602 retained within 48h window');
  assert.equal(f.prStateRow(602).branch_cleanup_status, 'pending');
  assert.equal(f.prStateRow(602).branch_delete_due_at, Date.parse(closed10hAgo) + 48 * HOUR);
  assert.equal(f.prStateRow(603).branch_cleanup_status, null, '#603 deferred to next tick by batch cap');
  assert.equal(f.prStateRow(604).branch_cleanup_status, null, '#604 deferred to next tick by batch cap');
  assert.equal(f.prStateRow(605).branch_cleanup_status, null, '#605 deferred to next tick by batch cap');

  // Tick 2: processes #603 (expired >48h -> deleted) and #604 (author mismatch -> skipped).
  await f.scanner.tick();
  assert.equal(f.state.refs.has('bot/legacy-old-603'), false, '#603 expired >48h legacy branch deleted');
  assert.equal(f.prStateRow(603).branch_cleanup_status, 'deleted');
  assert.equal(f.prStateRow(603).branch_cleanup_reason, 'closed_48h_expired');
  assert.equal(f.state.refs.has('bot/legacy-mismatch-604'), true, '#604 author mismatch never deleted');
  assert.equal(f.prStateRow(604).branch_cleanup_status, 'skipped');
  assert.equal(f.prStateRow(604).branch_cleanup_reason, 'pr_author_mismatch');
  assert.equal(f.prStateRow(605).branch_cleanup_status, null, '#605 still waiting for tick 3');

  // Tick 3: processes #605 locally (non-bot branch -> skipped with zero GitHub calls!).
  const reqsBeforeTick3 = f.state.requests.length;
  await f.scanner.tick();
  assert.equal(f.state.requests.length, reqsBeforeTick3, 'local-skipped legacy non-bot row makes zero GitHub calls');
  assert.equal(f.prStateRow(605).branch_cleanup_status, 'skipped');
  assert.equal(f.prStateRow(605).branch_cleanup_reason, 'invalid_or_protected_branch');
  assert.equal(f.state.refs.has('feature/human-legacy-605'), true);

  // Tick 4 (steady state while #602 is still within 48h): ZERO GitHub requests!
  const reqsBeforeSteady = f.state.requests.length;
  await f.scanner.tick();
  assert.equal(f.state.requests.length, reqsBeforeSteady, 'zero GitHub requests once legacy backlog is drained');

  // Advance remaining 38h: #602 expires and is deleted!
  f.advance(38 * HOUR);
  await f.scanner.tick();
  assert.equal(f.state.refs.has('bot/legacy-recent-602'), false);
  assert.equal(f.prStateRow(602).branch_cleanup_status, 'deleted');

  // Verify audit trail recorded legacy backfill events.
  const backfillAudits = f.audits().filter(a => a.action === 'bot_pr.branch_cleanup_backfilled');
  assert.deepEqual(backfillAudits.map(a => a.resource_id), [
    'pr#601:bot/legacy-merged-601:merged',
    'pr#602:bot/legacy-recent-602:closed_retention_wait',
    'pr#603:bot/legacy-old-603:closed_retention_wait',
  ]);

  // 6. Legacy bot_pull_requests rows with MISSING bot_pr_states row (s.number IS NULL) on standalone cleanupDueBotPrBranches:
  //    merged PR is backfilled & deleted in one call; still-open PR is synced as state='open' and never deleted.
  f.seedBotPr(606, { branch: 'bot/legacy-missing-merged-606', prState: 'closed', merged: true });
  f.seedBotPr(607, { branch: 'bot/legacy-missing-open-607', prState: 'open', merged: false });
  assert.equal(f.prStateRow(606), undefined);
  assert.equal(f.prStateRow(607), undefined);

  await cleanupDueBotPrBranches(f.h.store, f.githubUrl, { now: () => f.clock, legacyBatchLimit: 10 });
  assert.equal(f.state.refs.has('bot/legacy-missing-merged-606'), false, 'state-missing merged legacy PR deleted in one pass');
  assert.equal(f.prStateRow(606).branch_cleanup_status, 'deleted');
  assert.equal(f.state.refs.has('bot/legacy-missing-open-607'), true, 'state-missing open PR preserved');
  assert.equal(f.prStateRow(607).state, 'open');
  assert.equal(f.prStateRow(607).branch_cleanup_status, null);

  // 7. Sub-`develop` ceiling repo makes zero GitHub calls during legacy backfill.
  f.h.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='101'");
  const legacyBlockedRepoPr = f.seedBotPr(608, { branch: 'bot/legacy-ceiling-608', prState: 'closed', merged: true });
  seedLegacyClosedRow(legacyBlockedRepoPr);
  const reqsBeforeCeilingSkip = f.state.requests.length;
  const skippedSummary = await backfillLegacyBotPrBranchCleanup(f.h.store, f.githubUrl, { now: () => f.clock });
  assert.equal(skippedSummary.inspected, 0);
  assert.equal(f.state.requests.length, reqsBeforeCeilingSkip, 'comment-ceiling repo must make zero GitHub calls in backfill');
  assert.equal(f.state.refs.has('bot/legacy-ceiling-608'), true);
});

test('F2 refuses deleting a closed Bot PR branch that is the base of another open stacked PR', async t => {
  const f = await createCleanupFixture(t, { accountType: 'github_app' });
  const parentPr = f.seedBotPr(701, { branch: 'bot/stacked-parent-701', prState: 'closed', merged: false, closedAt: new Date(f.clock - 72 * HOUR).toISOString() });
  syncBotPullRequestState(f.h.store, '101', parentPr);

  // Stacked open human PR targeting `bot/stacked-parent-701` as its base (not in bot_pull_requests so live check must catch it).
  f.seedBotPr(702, {
    branch: 'alice/stacked-child-702',
    baseRef: 'bot/stacked-parent-701',
    author: f.state.humanActor,
    prState: 'open',
    registerBotPr: false,
    registerBotBranch: false,
  });

  const res = await cleanupBotPrBranch(f.h.store, '101', 701, { apiUrl: f.githubUrl });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'other_open_pr_uses_branch_as_base');
  assert.equal(f.state.deletes.length, 0);
  assert.equal(f.state.refs.has('bot/stacked-parent-701'), true, 'base branch of stacked open PR must not be deleted');
  assert.equal(f.state.tokenMints.some(m => m.permissions.contents === 'write'), false, 'no write token minted when live base check fails');
  assert.equal(f.prStateRow(701).branch_cleanup_status, 'skipped');
  assert.equal(f.prStateRow(701).branch_cleanup_reason, 'other_open_pr_uses_branch_as_base');
  assert.ok(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/stacked-parent-701'"));
});

test('F3 post-delete read-only verification detects a racing push recreating the branch and defers retry instead of falsely marking deleted', async t => {
  const f = await createCleanupFixture(t, { accountType: 'github_app' });

  // Case A: Racing push recreates branch with the SAME head SHA right after DELETE -> stays pending, then cleanly deleted on retry.
  const sameShaHead = oid('race-same-sha', 801);
  const prA = f.seedBotPr(801, { branch: 'bot/race-same-801', headSha: sameShaHead, prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', prA);

  let recreatedOnceA = false;
  f.state.onAfterDelete = branch => {
    if (branch === 'bot/race-same-801' && !recreatedOnceA) {
      recreatedOnceA = true;
      f.state.refs.set(branch, sameShaHead);
    }
  };

  await f.scanner.tick();
  assert.equal(f.state.deletes.filter(d => d.branch === 'bot/race-same-801').length, 1);
  const afterRaceA = f.prStateRow(801);
  assert.equal(afterRaceA.branch_cleanup_status, 'pending', 'must NOT mark terminal deleted while ref still exists');
  assert.equal(afterRaceA.branch_cleanup_reason, 'branch_recreated_after_delete');
  assert.equal(afterRaceA.branch_cleanup_attempts, 1);
  assert.equal(afterRaceA.branch_delete_due_at, f.clock + MINUTE);
  assert.ok(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/race-same-801'"), 'bot_branches retained while pending');

  // After 1m backoff, second pass deletes and post-delete GET returns 404 -> terminal deleted!
  f.advance(MINUTE);
  await f.scanner.tick();
  assert.equal(f.state.deletes.filter(d => d.branch === 'bot/race-same-801').length, 2);
  assert.equal(f.state.refs.has('bot/race-same-801'), false);
  assert.equal(f.prStateRow(801).branch_cleanup_status, 'deleted');
  assert.equal(f.h.store.get("SELECT * FROM bot_branches WHERE repository_id='101' AND branch='bot/race-same-801'"), undefined);

  // Case B: Racing push pushes a NEW commit SHA right after DELETE -> stays pending, then safely skipped (`head_sha_changed`) on retry!
  const prB = f.seedBotPr(802, { branch: 'bot/race-new-802', headSha: oid('race-old', 802), prState: 'closed', merged: true });
  syncBotPullRequestState(f.h.store, '101', prB);

  const newerSha = oid('race-new-commit', 802);
  let recreatedOnceB = false;
  f.state.onAfterDelete = branch => {
    if (branch === 'bot/race-new-802' && !recreatedOnceB) {
      recreatedOnceB = true;
      f.state.refs.set(branch, newerSha);
    }
  };

  await f.scanner.tick();
  assert.equal(f.prStateRow(802).branch_cleanup_status, 'pending');
  assert.equal(f.prStateRow(802).branch_cleanup_reason, 'branch_recreated_after_delete');

  f.advance(MINUTE);
  await f.scanner.tick();
  assert.equal(f.state.deletes.filter(d => d.branch === 'bot/race-new-802').length, 1, 'must NOT delete newer commit on retry');
  assert.equal(f.state.refs.get('bot/race-new-802'), newerSha);
  assert.equal(f.prStateRow(802).branch_cleanup_status, 'skipped');
  assert.equal(f.prStateRow(802).branch_cleanup_reason, 'head_sha_changed');
});
