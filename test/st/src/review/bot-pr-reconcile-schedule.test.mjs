// #1396: the fallback reconcile of open bot PRs reads each PR on its own schedule (5 minutes, doubling while nothing changes,
// at most 4 hours; a change or a webhook starts over), covers every open bot PR, reads all due PRs of a repository in one
// GraphQL query, sends REST requests only for PRs that changed, and sends nothing at all while no PR is due.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { botPrGraphql } from '../../../fixtures/bot-pr-graphql.mjs';
import { BotPrWakeScanner, BOT_PR_RECONCILE_MAX_MS, BOT_PR_RECONCILE_MIN_MS, setBotPatrolConfigForTest } from '../../../../dist/review/bot-pr-wake.js';
import { appEvents, appPermissions } from '../../../../dist/github/client.js';
import { blockedUntil, installationBucket } from '../../../../dist/github/rate-limits.js';

const MINUTE = 60_000;
const oid = (...parts) => createHash('sha1').update(parts.join(':')).digest('hex');
const botActor = { id: 999, login: 'dept-bot[bot]', type: 'Bot' };

// A GitHub App installation with `count` open bot PRs (#101 onwards) on main, each with one green check suite. Every
// request is listed in `requests`; GraphQL answers carry the graphql window's headers and REST answers the core window's.
async function fixture(t, { count = 30, patrolIntervalMs = 0 } = {}) {
  let clock = Date.parse('2026-11-26T00:00:00.000Z');
  setBotPatrolConfigForTest({ intervalMs: patrolIntervalMs, now: () => clock });
  t.after(() => setBotPatrolConfigForTest(null));
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const state = { pulls: new Map(), refs: { main: oid('main', 1) }, checkSuites: new Map(), graphql: null, graphqlRemaining: 4990 };
  for (let n = 101; n < 101 + count; n++) {
    const head = oid('head', n, 1);
    state.pulls.set(n, {
      id: 5000 + n, number: n, title: `Bot PR #${n}`, body: '', state: 'open', draft: false, mergeable: true, mergeable_state: 'clean',
      updated_at: '2026-11-25T00:00:00Z', user: botActor, labels: [], html_url: `https://github.com/fixture/project-101/pull/${n}`,
      head: { sha: head, ref: `bot/pr-${n}`, repo: { id: 101 } }, base: { sha: state.refs.main, ref: 'main', repo: { id: 101 } },
    });
    state.checkSuites.set(head, [{ id: 70000 + n, status: 'completed', conclusion: 'success', app: { name: 'GitHub Actions' } }]);
  }
  const requests = [];
  const window = (resource, remaining) => ({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-used': String(5000 - remaining),
    'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': resource });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname), body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, path, body });
    const send = (value, status = 200, headers = window('core', 4000)) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (path === '/repos/fixture/project-101/installation') return send({ id: 55, account: { id: 10, login: 'fixture' }, permissions: { ...appPermissions }, events: appEvents });
    if (path === '/app/installations/55/access_tokens') return send({ token: 'ghs_reconcile_fixture', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions }, 201);
    if (path === '/installation/token') { res.writeHead(204); return res.end(); }
    if (path === '/repositories/101') return send({ id: 101, full_name: 'fixture/project-101', owner: { id: 10, login: 'fixture' }, default_branch: 'main' });
    if (path === '/graphql') {
      if (state.graphql) return state.graphql(body, send, window);
      return send(botPrGraphql(body, { pulls: state.pulls, refs: state.refs, checkSuites: state.checkSuites }), 200, window('graphql', state.graphqlRemaining));
    }
    const sub = path.slice('/repos/fixture/project-101'.length);
    let m;
    if ((m = /^\/pulls\/(\d+)$/.exec(sub))) { const pr = state.pulls.get(Number(m[1])); return send(pr ?? { message: 'Not Found' }, pr ? 200 : 404); }
    if (/^\/pulls\/\d+\/reviews$/.test(sub) || /^\/issues\/\d+\/comments$/.test(sub)) return send([]);
    if ((m = /^\/commits\/([a-f0-9]{40})\/check-suites$/.exec(sub))) return send({ check_suites: state.checkSuites.get(m[1]) ?? [] });
    if ((m = /^\/commits\/([a-f0-9]{40})\/check-runs$/.exec(sub))) {
      return send({ check_runs: (state.checkSuites.get(m[1]) ?? []).map(s => ({ id: s.id + 1, name: 'ci', status: s.status, conclusion: s.conclusion, check_suite: { id: s.id } })) });
    }
    if (sub === '/actions/runs') return send({ workflow_runs: [] });
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(sub))) return state.refs[m[1]] ? send({ ref: `refs/heads/${m[1]}`, object: { sha: state.refs[m[1]] } }) : send({ message: 'Not Found' }, 404);
    return send({ message: `Unhandled ${req.method} ${path}` }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const githubUrl = `http://127.0.0.1:${server.address().port}`;

  const h = await harness(t, undefined, { githubUrl });
  const { admin } = await setup(h);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const acc = await account(admin, { type: 'github_app', app_id: '77', private_key: privateKey, token: undefined });
  await repository(admin, acc.id, '101');
  h.store.run("UPDATE policies SET enabled=1,capability_ceiling='comment',base_branch='main' WHERE repository_id='101'");
  h.store.run('INSERT OR REPLACE INTO github_actors VALUES(?,?,?,?)', acc.id, String(botActor.id), botActor.login, new Date(clock).toISOString());
  for (const pr of state.pulls.values()) {
    h.store.run("INSERT INTO bot_pull_requests VALUES('101',?,?,?,'101',?,?,?,0)", pr.number, String(pr.id), String(botActor.id), pr.head.ref, pr.head.sha, `src-${pr.number}`);
  }
  const scanner = new BotPrWakeScanner(h.store, githubUrl);
  t.after(() => scanner.close());

  const schedule = n => {
    const row = h.store.get('SELECT reconcile_at,reconcile_due_at,reconcile_interval_ms FROM bot_pr_states WHERE repository_id=? AND number=?', '101', n);
    return row && { ...row };
  };
  // One scanner pass at the fixture's clock; returns the requests it sent.
  const tick = async () => { const from = requests.length; await scanner.tick(); return requests.slice(from); };
  const pullReads = sent => sent.filter(r => r.method === 'GET' && /\/pulls\/\d+$/.test(r.path)).map(r => Number(r.path.split('/').at(-1))).sort((a, b) => a - b);
  const queried = sent => sent.filter(r => r.path === '/graphql').flatMap(r => [...String(r.body.query).matchAll(/p(\d+):pullRequest/g)].map(x => Number(x[1]))).sort((a, b) => a - b);
  return {
    h, acc, state, requests, schedule, tick, pullReads, queried,
    get clock() { return clock; },
    advance: ms => { clock += ms; },
  };
}

test('every open bot PR is read on its own schedule: 5 minutes, doubling while nothing changes, at most 4 hours, and no request while none is due', async t => {
  const f = await fixture(t, { count: 30 });
  const all = [...f.state.pulls.keys()];

  // The first pass reads all 30 PRs (more than the old newest-25 cap) in one GraphQL query, and each once over REST.
  let sent = await f.tick();
  assert.equal(sent.filter(r => r.path === '/graphql').length, 1, 'one batched query for 30 PRs');
  assert.deepEqual(f.queried(sent), all);
  assert.deepEqual(f.pullReads(sent), all, 'first read of each PR is a full REST read');
  for (const n of all) assert.deepEqual(f.schedule(n), { reconcile_at: f.clock, reconcile_due_at: f.clock + BOT_PR_RECONCILE_MIN_MS, reconcile_interval_ms: BOT_PR_RECONCILE_MIN_MS });

  // Scanner passes every minute for 10 hours. Nothing changes on GitHub, so each read is the GraphQL query alone and
  // the gaps between reads double up to the 4-hour cap; minutes with no PR due send nothing at all.
  const start = f.clock, reads = [];
  for (let minute = 1; minute <= 600; minute++) {
    f.advance(MINUTE);
    sent = await f.tick();
    if (!sent.length) continue;
    reads.push((f.clock - start) / MINUTE);
    assert.deepEqual(f.queried(sent), all, `minute ${minute}: all PRs share the schedule and one query`);
    assert.deepEqual(f.pullReads(sent), [], `minute ${minute}: nothing changed, so no REST read of a PR`);
    assert.ok(sent.every(r => r.path === '/graphql' || ['/repos/fixture/project-101/installation', '/app/installations/55/access_tokens', '/repositories/101', '/installation/token'].includes(r.path)),
      sent.map(r => `${r.method} ${r.path}`).join());
  }
  assert.deepEqual(reads, [5, 15, 35, 75, 155, 315, 555], 'gaps of 5, 10, 20, 40, 80, 160 and then 240 minutes');
  assert.equal(f.schedule(101).reconcile_interval_ms, BOT_PR_RECONCILE_MAX_MS);

  // The GraphQL window is observed like the REST one.
  const graphql = f.h.store.get("SELECT quota,remaining,kind FROM github_rate_limits WHERE bucket='installation:55' AND resource='graphql'");
  assert.deepEqual({ ...graphql }, { quota: 5000, remaining: 4990, kind: 'installation' });
});

test('a change GitHub reports, a local settings change and webhooks about a PR, its head or its base start the interval over', async t => {
  const f = await fixture(t, { count: 30 });
  await f.tick();
  for (const step of [5, 10, 20]) { f.advance(step * MINUTE); await f.tick(); }
  assert.equal(f.schedule(105).reconcile_interval_ms, 40 * MINUTE);

  // PR #105 gets a new head. At the next shared read GraphQL shows the change: only #105 is read over REST (with its new
  // failed suite's details) and only its interval starts over.
  const pr105 = f.state.pulls.get(105), head2 = oid('head', 105, 2);
  pr105.head.sha = head2;
  pr105.updated_at = '2026-11-26T00:40:00Z';
  f.state.checkSuites.set(head2, [{ id: 80105, status: 'completed', conclusion: 'startup_failure', app: { name: 'Broken workflow' } }]);
  f.advance(40 * MINUTE);
  let sent = await f.tick();
  assert.deepEqual(f.pullReads(sent), [105]);
  assert.ok(sent.some(r => r.path.endsWith(`/commits/${head2}/check-suites`)), 'the failed suite is read in detail over REST');
  assert.equal(f.h.store.get("SELECT count(*) n FROM dispatch_events WHERE object_number=105 AND type='pull_request.checks_failed'").n, 1, 'a runless startup_failure suite still wakes the Manager');
  assert.equal(f.schedule(105).reconcile_interval_ms, BOT_PR_RECONCILE_MIN_MS);
  assert.equal(f.schedule(106).reconcile_interval_ms, 80 * MINUTE);

  // Five minutes later only #105 is due; the others wait for their 80 minutes.
  f.advance(BOT_PR_RECONCILE_MIN_MS);
  sent = await f.tick();
  assert.deepEqual(f.queried(sent), [105]);
  assert.deepEqual(f.pullReads(sent), [], 'unchanged since the last read');
  assert.equal(f.schedule(105).reconcile_interval_ms, 10 * MINUTE);

  // A comment on PR #110 marks it for the next pass: it is read then, well before its 80 minutes are up.
  f.advance(MINUTE);
  await f.h.hook(f.acc.path, f.acc.secret, 'comment-110', {
    action: 'created', repository: { id: 101 }, issue: { number: 110, title: 'Bot PR #110', pull_request: {} },
    comment: { id: 9110, body: 'Looks fine.', user: { id: 800, login: 'alice', type: 'User' } }, sender: { id: 800, login: 'alice', type: 'User' },
  }, { 'X-GitHub-Event': 'issue_comment' });
  assert.equal(f.schedule(110).reconcile_interval_ms, BOT_PR_RECONCILE_MIN_MS);
  sent = await f.tick();
  assert.deepEqual(f.queried(sent), [110]);

  // Within five minutes of that read, another webhook about #110 cannot make it due again before the minimum is up.
  f.advance(2 * MINUTE);
  await f.h.hook(f.acc.path, f.acc.secret, 'check-110', {
    action: 'completed', repository: { id: 101 },
    check_suite: { id: 70110, head_sha: f.state.pulls.get(110).head.sha, head_branch: 'bot/pr-110', status: 'completed', conclusion: 'success', pull_requests: [] },
    sender: { id: 1, login: 'github-actions[bot]', type: 'Bot' },
  }, { 'X-GitHub-Event': 'check_suite' });
  assert.deepEqual(await f.tick(), []);
  f.advance(3 * MINUTE);
  assert.deepEqual(f.queried(await f.tick()), [110], 'the check suite on its head made #110 due at its 5-minute minimum');

  // Another PR merging into main advanced the base of every PR on main: all are due at once.
  f.advance(10 * MINUTE);
  await f.h.hook(f.acc.path, f.acc.secret, 'human-pr-merged', {
    action: 'closed', repository: { id: 101 }, number: 90,
    pull_request: { id: 5090, number: 90, state: 'closed', merged: true, merge_commit_sha: oid('main', 2), title: 'Human change', body: '',
      user: { id: 800, login: 'alice', type: 'User' }, head: { sha: oid('human', 90), ref: 'alice/x', repo: { id: 101 } }, base: { sha: oid('main', 1), ref: 'main', repo: { id: 101 } }, labels: [] },
    sender: { id: 800, login: 'alice', type: 'User' },
  }, { 'X-GitHub-Event': 'pull_request' });
  assert.deepEqual(f.queried(await f.tick()), [...f.state.pulls.keys()]);

  // A change to the project's own settings (here its base branch policy) makes every PR due once its minimum is up.
  for (const step of [5, 10, 20, 40]) { f.advance(step * MINUTE); await f.tick(); }
  f.h.store.run("UPDATE policies SET test_command='npm test' WHERE repository_id='101'");
  f.advance(BOT_PR_RECONCILE_MIN_MS);
  assert.deepEqual(f.queried(await f.tick()), [...f.state.pulls.keys()]);
});

test('a used-up GraphQL window stops the pass without REST reads and without sending into it; other GraphQL failures read over REST', async t => {
  const f = await fixture(t, { count: 3 });
  const resetAt = Math.floor((Date.now() + 30 * MINUTE) / 1000);
  f.state.graphql = (_body, send, window) => send({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for installation ID 55.' }] }, 200,
    { ...window('graphql', 0), 'x-ratelimit-reset': String(resetAt) });
  let sent = await f.tick();
  assert.equal(sent.filter(r => r.path === '/graphql').length, 1);
  assert.deepEqual(f.pullReads(sent), [], 'no fallback into the REST window');
  assert.equal(f.schedule(101), undefined, 'nothing recorded: every PR stays due');
  const bucket = installationBucket(f.acc.id, '55');
  assert.equal(blockedUntil(f.h.store, bucket, Date.now(), 'graphql'), resetAt * 1000);
  assert.equal(blockedUntil(f.h.store, bucket, Date.now(), 'core'), null, 'the REST window is not the one used up');
  sent = await f.tick();
  assert.equal(sent.filter(r => r.path === '/graphql').length, 0, 'the used-up window is not sent into again');

  // GraphQL failing for any other reason: each due PR is read over REST, and the schedule still grows when nothing changes.
  f.h.store.run("DELETE FROM github_rate_limits WHERE resource='graphql'");
  f.state.graphql = (_body, send) => send({ message: 'Bad gateway' }, 502);
  sent = await f.tick();
  assert.deepEqual(f.pullReads(sent), [101, 102, 103]);
  assert.equal(f.schedule(101).reconcile_interval_ms, BOT_PR_RECONCILE_MIN_MS);
  f.advance(BOT_PR_RECONCILE_MIN_MS);
  sent = await f.tick();
  assert.deepEqual(f.pullReads(sent), [101, 102, 103]);
  assert.equal(f.schedule(101).reconcile_interval_ms, 10 * MINUTE);
});

// The quota the fallback reconcile spends, per hour, for a repository with 41 open bot PRs (sciencediscovery's count in
// the production incident) whose state does not change, with the 6-hour patrol on: the first hour includes every PR's
// first full read and patrol, and the later hours are the steady state.
test('request count per hour for 41 unchanged open bot PRs', async t => {
  const f = await fixture(t, { count: 41, patrolIntervalMs: 6 * 60 * MINUTE });
  const hours = [];
  for (let hour = 0; hour < 8; hour++) {
    const counts = { rest: 0, graphql: 0, pullReads: 0 };
    for (let minute = 0; minute < 60; minute++) {
      const sent = await f.tick();
      for (const r of sent) {
        if (r.path === '/graphql') counts.graphql++;
        // The App's own JWT requests (installation lookup, token minting) are not counted against the installation.
        else if (r.path !== '/repos/fixture/project-101/installation' && r.path !== '/app/installations/55/access_tokens') counts.rest++;
      }
      counts.pullReads += f.pullReads(sent).length;
      f.advance(MINUTE);
    }
    hours.push(counts);
  }
  t.diagnostic(`per hour (installation REST core / GraphQL queries / REST PR reads): ${hours.map(c => `${c.rest}/${c.graphql}/${c.pullReads}`).join(' ')}`);
  // Hour 1: 41 first reads with their patrol (PR, check runs, check suites and reviews each) plus 1 lazy repo-wide
  // `GET /actions/runs?event=merge_group` read (#1427), in the first of four passes (at minutes 0, 5, 15 and 35) that
  // each also take a repository check and a token revocation.
  assert.ok(hours[0].rest <= 41 * 4 + 4 * 2 + 1 && hours[0].graphql === 4, JSON.stringify(hours[0]));
  // Hours 3 to 6: at most one or two shared passes an hour, each a token, a repository check and one query.
  for (const c of hours.slice(2, 6)) assert.ok(c.rest <= 4 && c.graphql <= 2 && c.pullReads === 0, JSON.stringify(c));
  // Hour 7: the patrol is due once for every PR (6 hours after the first), the only REST PR reads after hour 1.
  assert.equal(hours[6].pullReads, 41, JSON.stringify(hours[6]));
});
