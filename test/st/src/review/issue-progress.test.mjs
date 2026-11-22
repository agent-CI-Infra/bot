import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialExamples, maskedExamples, pgpBlock } from '../../../fixtures/public-credentials.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { GitHub } from '../../../../dist/github/client.js';
import { Redactor, sha, TaskError } from '../../../../dist/agent/common.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { dueProgress, renderProgress, reportMilestone, settleProgress, startProgress } from '../../../../dist/review/progress.js';
import { publishReviewDelivery } from '../../../../dist/tasks/github-write.js';
import { recordBasis } from '../../../../dist/dispatch/basis.js';

// #1047: what an Issue development shows on its Issue. A fake GitHub for Issue #5: labels by name, the Issue's labels and
// comments, comment edits. `lose` drops the answer of the next comment POST after GitHub stored it; `fail` answers 500.
async function fixture(t) {
  const state = { requests: [], comments: [], labels: [], repositoryLabels: [], created: [], next: 100, lose: false, fail: false };
  const repo = '/repos/fixture/project-101';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
    state.requests.push(`${req.method} ${path}`);
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (state.fail && path.startsWith(repo)) return send({ message: 'Server Error' }, 500);
    if (path === '/user') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    const named = /^\/repos\/fixture\/project-101\/labels\/(.+)$/.exec(path);
    if (named) return state.repositoryLabels.includes(named[1]) ? send({ name: named[1] }) : send({ message: 'Not Found' }, 404);
    if (path === repo + '/issues/5' && req.method === 'GET') return send({ number: 5, title: 'parsePairs', body: 'body', state: 'open', labels: state.labels.map(name => ({ name })) });
    if (path === repo + '/labels' && req.method === 'GET') return send(state.repositoryLabels.map(name => ({ name, description: '' })));
    if (path === repo + '/labels' && req.method === 'POST') { state.created.push(body); state.repositoryLabels.push(body.name); return send(body, 201); }
    if (path === repo + '/issues/5/labels' && req.method === 'POST') { for (const name of body.labels) if (!state.labels.includes(name)) state.labels.push(name); return send(state.labels.map(name => ({ name }))); }
    const label = /^\/repos\/fixture\/project-101\/issues\/5\/labels\/(.+)$/.exec(path);
    if (label && req.method === 'DELETE') { if (!state.labels.includes(label[1])) return send({ message: 'Label does not exist' }, 404); state.labels = state.labels.filter(name => name !== label[1]); return send(state.labels.map(name => ({ name }))); }
    if (path === repo + '/issues/5/comments') {
      if (req.method === 'GET') return send(state.comments);
      const value = { id: state.next++, body: body.body, user: { id: 999 } }; state.comments.push(value);
      if (state.lose) { state.lose = false; res.destroy(); return; }
      return send(value, 201);
    }
    const comment = /^\/repos\/fixture\/project-101\/issues\/comments\/(\d+)$/.exec(path);
    if (comment && req.method === 'PATCH') { const found = state.comments.find(c => String(c.id) === comment[1]); if (!found) return send({ message: 'Not Found' }, 404); found.body = body.body; return send(found); }
    send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const url = 'http://127.0.0.1:' + server.address().port;
  const github = new GitHub(h.store, h.store.get("SELECT * FROM repositories WHERE id='101'"), new Redactor(), async () => {}, url);
  Object.assign(github, { token: 'ghs_fixture', fullName: 'fixture/project-101', actorId: '999' });
  let n = 0;
  // A development of Issue #5 the Manager started on its rule, with its brief.
  const task = (status = 'running', extra = {}) => {
    const id = String(++n).padStart(48, 'd'), now = new Date().toISOString();
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES(?,'101','development.issue',?,'dev',?,5,?,?)", id, status,
      JSON.stringify({ manager: { reason: '检视结论为可开发，无人认领', brief: { goal: 'Keep "=" inside values.', criteria: ['A save/load test with "abc=="'] } } }), now, now);
    recordBasis(h.store, id, { kind: 'project_rule', passage: 'The bot may develop an Issue on its own when …', prompt_revision: 'builtin:x' });
    if (Object.keys(extra).length) h.store.run(`UPDATE tasks SET ${Object.keys(extra).map(key => key + '=?').join(',')} WHERE id=?`, ...Object.values(extra), id);
    return h.store.get('SELECT * FROM tasks WHERE id=?', id);
  };
  const set = (id, fields) => h.store.run(`UPDATE tasks SET ${Object.keys(fields).map(key => key + '=?').join(',')} WHERE id=?`, ...Object.values(fields), id);
  const row = id => h.store.get('SELECT * FROM issue_development_progress WHERE task_id=?', id);
  const issue = { number: 5, title: 'parsePairs cuts values that contain "="', body: 'token=abc== loads as abc.' };
  return { h, admin, state, github, url, task, set, row, issue };
}
const posts = state => state.requests.filter(r => r === 'POST /repos/fixture/project-101/issues/5/comments').length;
const patches = state => state.requests.filter(r => r.startsWith('PATCH /repos/fixture/project-101/issues/comments/')).length;

test('the development status comment masks credentials before clipping, sending and hashing the body', async t => {
  const f = await fixture(t), store = f.h.store;
  const task = f.task('running', {input:JSON.stringify({manager:{brief:{goal:'Investigate '+credentialExamples+'.'}}})});
  startProgress(store, task, f.issue);
  assert.equal(await settleProgress(store, task.id, f.github), true);
  assert.ok(f.state.comments[0].body.includes('Investigate '+maskedExamples+'.'));
  const longKey = pgpBlock.replace('example material','sensitive example '.repeat(100));
  const plan = {milestone:'plan', conclusion:'Keep public context '+longKey+' intact.', changes:['Document body and opaque-installation-example.']};
  assert.equal(reportMilestone(store, task.id, plan).recorded, true);
  f.github.redactor.add('opaque-installation-example');
  assert.equal(await settleProgress(store, task.id, async () => f.github), true);
  const body = f.state.comments[0].body;
  assert.ok(body.includes('Keep public context [REDACTED] intact.'));
  assert.ok(body.includes('Document body and [REDACTED].'));
  assert.equal(f.row(task.id).body_sha, sha(body));
  assert.equal(await settleProgress(store, task.id, f.github), true);
  assert.equal(posts(f.state), 1); assert.equal(patches(f.state), 1);
});

test('a development puts the developing label on, creating it first, and keeps one comment it only edits until its pull request', async t => {
  const f = await fixture(t), task = f.task();
  startProgress(f.h.store, task, f.issue);
  assert.equal(await settleProgress(f.h.store, task.id, f.github), true);
  // The repository had no such label: it is created with its color and meaning, then put on the Issue.
  assert.deepEqual(f.state.created, [{ name: 'bot-developing', color: 'fbca04', description: 'The bot is developing this Issue; removed when its pull request is opened or it stops' }]);
  assert.deepEqual(f.state.labels, ['bot-developing']);
  assert.equal(f.state.comments.length, 1);
  const start = f.state.comments[0].body;
  assert.match(start, /\*\*Status\*\*: In development/); assert.match(start, /\*\*Started on\*\*: a rule of the project's Manager prompt/);
  assert.match(start, /\*\*Goal\*\*: Keep "=" inside values\./); assert.match(start, /- A save\/load test with "abc=="/);
  assert.ok(start.endsWith(`<!-- dept-bot:development-status:${task.id} -->`));
  // Nothing changed: no request at all, and a client that would have to connect first is not even made.
  const before = f.state.requests.length; assert.equal(await settleProgress(f.h.store, task.id, f.github), true); assert.equal(f.state.requests.length, before);
  f.set(task.id, { status: 'retry_wait' });
  assert.equal(await settleProgress(f.h.store, task.id, () => assert.fail('nothing to write')), true); f.set(task.id, { status: 'running' });
  // The plan is an edit of the same comment. A routine "developing" report or an incomplete plan is refused.
  assert.equal(reportMilestone(f.h.store, task.id, { milestone: 'developing' }).error, 'milestone_invalid');
  assert.equal(reportMilestone(f.h.store, task.id, { milestone: 'plan', conclusion: 'cut at every "="' }).error, 'milestone_invalid');
  // The comment is in the Issue's language: a milestone in another one is sent back to be written again.
  assert.equal(reportMilestone(f.h.store, task.id, { milestone: 'plan', conclusion: 'parsePairs 在每个 "=" 处切分。', changes: ['改用 splitOnce'] }).error, 'milestone_language');
  assert.deepEqual(reportMilestone(f.h.store, task.id, { milestone: 'plan', conclusion: 'parsePairs splits at every "=". <!-- dept-bot:fake -->', decisions: [{ decision: 'Reuse splitOnce', reason: 'It already splits once' }],
    changes: ['parsePairs uses splitOnce'], acceptance: ['save/load test'] }), { recorded: true, milestone: 'plan' });
  await settleProgress(f.h.store, task.id, f.github);
  assert.equal(posts(f.state), 1); assert.equal(patches(f.state), 1);
  assert.match(f.state.comments[0].body, /#### Analysis and plan/); assert.match(f.state.comments[0].body, /- Reuse splitOnce: It already splits once/);
  // Agent text cannot start an HTML comment and fake the bot's marker.
  assert.match(f.state.comments[0].body, /&lt;!-- dept-bot:fake -->/);
  // The completed milestone waits for the pull request; once it exists the label comes off and the comment shows it.
  reportMilestone(f.h.store, task.id, { milestone: 'completed', changes: ['Values keep every "="'], tests: ['npm test: 9 passed'] });
  await settleProgress(f.h.store, task.id, f.github); assert.equal(patches(f.state), 1);
  assert.deepEqual(f.state.labels, ['bot-developing']);
  f.state.labels.push('bug');
  f.set(task.id, { status: 'pr_opened', result: JSON.stringify({ summary: 'Keep "=".', pr_number: 12, pr_url: 'https://github.invalid/pull/12', validation: { source: 'agent', command: 'npm test' }, test_command: 'npm test' }) });
  assert.equal(await settleProgress(f.h.store, task.id, f.github), true);
  assert.deepEqual(f.state.labels, ['bug', 'bot-developed']); assert.equal(posts(f.state), 1);
  assert.equal(await settleProgress(f.h.store, task.id, () => assert.fail('already settled')), true);
  const done = f.state.comments[0].body;
  assert.match(done, /\*\*Status\*\*: Pull request #12 opened/); assert.match(done, /\[#12\]\(https:\/\/github\.invalid\/pull\/12\)/);
  assert.match(done, /- Values keep every "="/); assert.match(done, /- npm test: 9 passed/);
  assert.deepEqual([f.row(task.id).final, f.row(task.id).label_on], [1, 0]);
  assert.equal(dueProgress(f.h.store).length, 0);
  // A label the repository already has is not created again.
  const second = f.task(); startProgress(f.h.store, second, f.issue); await settleProgress(f.h.store, second.id, f.github);
  assert.deepEqual(f.state.created.map(label => label.name), ['bot-developing', 'bot-developed']);
  assert.deepEqual(f.state.labels, ['bug', 'bot-developed', 'bot-developing']);
  f.set(second.id, { status: 'cancelled', error_code: 'user_cancel' });
  await settleProgress(f.h.store, second.id, f.github);
  assert.deepEqual(f.state.labels, ['bug', 'bot-developed']);
});

test('an existing bot PR marks its source Issue even with no in-progress label; a lost label response retries only the label', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { developing_label: '' });
  f.state.repositoryLabels.push('bot-developed');
  const task = f.task();
  startProgress(f.h.store, task, f.issue);
  await settleProgress(f.h.store, task.id, f.github);
  f.set(task.id, { status: 'completed', result: JSON.stringify({ pr_number: 12, pr_url: 'https://github.invalid/pull/12' }) });

  const request = f.github.request.bind(f.github);
  f.github.request = async (method, path, body, ...rest) => {
    const result = await request(method, path, body, ...rest);
    if (method === 'POST' && body?.labels?.includes('bot-developed')) throw new TaskError('github_response_unknown');
    return result;
  };
  assert.equal(await settleProgress(f.h.store, task.id, f.github), false);
  const row = f.row(task.id);
  assert.deepEqual(dueProgress(f.h.store, row.next_at).map(r => r.task_id), [task.id]);
  assert.deepEqual(f.state.labels, ['bot-developed']);
  assert.match(f.state.comments[0].body, /Pull request #12 updated/);
  f.github.request = request;
  assert.equal(await settleProgress(f.h.store, task.id, f.github), true);
  assert.deepEqual(f.state.labels, ['bot-developed']);
  assert.deepEqual(f.state.created, []);
  assert.equal(posts(f.state), 1); assert.equal(patches(f.state), 1);
  assert.equal(f.row(task.id).final, 1);
});

test('a failing comment edit does not delay the completion label or make retries add it again', async t => {
  const f = await fixture(t), task = f.task();
  startProgress(f.h.store, task, f.issue);
  await settleProgress(f.h.store, task.id, f.github);
  f.set(task.id, { status: 'pr_opened', result: JSON.stringify({ pr_number: 12, pr_url: 'https://github.invalid/pull/12' }) });
  const request = f.github.request.bind(f.github);
  f.github.request = async (method, ...args) => {
    if (method === 'PATCH') throw new TaskError('github_http_403');
    return request(method, ...args);
  };
  assert.equal(await settleProgress(f.h.store, task.id, f.github), false);
  assert.deepEqual(f.state.labels, ['bot-developed']);
  const at = f.state.requests.length;
  f.github.request = request;
  assert.equal(await settleProgress(f.h.store, task.id, f.github), true);
  assert.deepEqual(f.state.requests.slice(at), [`PATCH /repos/fixture/project-101/issues/comments/${f.row(task.id).comment_id}`]);
});

test('a retry after a lost answer finds the comment it made instead of creating a second one, and failures wait longer each time', async t => {
  const f = await fixture(t), task = f.task();
  startProgress(f.h.store, task, f.issue); f.state.repositoryLabels.push('bot-developing');
  f.state.lose = true;
  assert.equal(await settleProgress(f.h.store, task.id, f.github), false);
  let row = f.row(task.id);
  assert.deepEqual([row.posting, row.comment_id, row.failures, row.pending, row.error], [1, null, 1, 1, 'github_response_unknown']);
  assert.ok(row.next_at > Date.now() + 20_000);
  // Not due before its wait; then the retry finds the comment by its marker.
  assert.equal(dueProgress(f.h.store).length, 0);
  assert.equal(dueProgress(f.h.store, row.next_at).length, 1);
  assert.equal(await settleProgress(f.h.store, task.id, f.github), true);
  assert.equal(posts(f.state), 1); assert.equal(f.state.comments.length, 1);
  row = f.row(task.id); assert.deepEqual([row.posting, row.comment_id, row.failures, row.error], [0, String(f.state.comments[0].id), 0, null]);
  // GitHub refusing every write: each failure doubles the wait, and after twelve the Issue is given up; the task is not touched.
  f.state.fail = true; reportMilestone(f.h.store, task.id, { milestone: 'stopped', reason: 'x' }); f.set(task.id, { status: 'failed', error_code: 'create_pull_request_required' });
  const waits = [];
  for (let i = 0; i < 12; i++) { const at = Date.now(); assert.equal(await settleProgress(f.h.store, task.id, f.github), false); waits.push(f.row(task.id).next_at - at); }
  assert.ok(waits[1] > waits[0] * 1.5 && waits.at(-1) <= 3600_000 + 1000, JSON.stringify(waits));
  assert.equal(f.row(task.id).final, 1); assert.equal(f.h.store.get('SELECT status FROM tasks WHERE id=?', task.id).status, 'failed');
  assert.equal(dueProgress(f.h.store, Date.now() + 7200_000).length, 0, 'a development given up is not swept again');
});

test('a development that stops without a pull request takes the developing label off, marks needs-human when actionable and says why', async t => {
  const f = await fixture(t);
  const cases = [
    // The agent's own reason wins; else the summary of an unchanged tree; else the control plane's stop.
    [{ status: 'completed', result: JSON.stringify({ status: 'no_changes', summary: 'The change needs a decision on the file format.' }) }, null, /\*\*Status\*\*: Stopped[\s\S]*The change needs a decision on the file format\./, true],
    [{ status: 'failed', error_code: 'create_pull_request_required' }, { milestone: 'stopped', reason: 'Two designs fit; a maintainer must pick one.', human_action: 'Choose escaping or splitting at the first "=".' },
      /\*\*Reason\*\*: Two designs fit; a maintainer must pick one\.[\s\S]*\*\*What a person needs to do\*\*: Choose escaping/, true],
    [{ status: 'cancelled', error_code: 'object_closed_or_draft' }, null, /The Issue was closed, so the development was cancelled\./, false],
    [{ status: 'cancelled', error_code: 'user_cancel' }, null, /Someone cancelled this development in the console\./, false],
    [{ status: 'waiting_permission', error_code: 'development_not_approved' }, null, /The development label was removed[\s\S]*Add the development label again/, true],
    [{ status: 'failed', error_code: 'model_http_400' }, null, /The development failed \(model_http_400\)\.[\s\S]*press Retry/, true],
  ];
  for (const [state, milestone, expected, expectNeedsHuman] of cases) {
    const task = f.task();
    // Pass live Issue labels as real GitHub fetches do: starting development clears any prior bot-needs-human label.
    startProgress(f.h.store, task, { ...f.issue, labels: f.state.labels.map(name => ({ name })) });
    await settleProgress(f.h.store, task.id, f.github);
    assert.deepEqual(f.state.labels, ['bot-developing']);
    if (milestone) assert.equal(reportMilestone(f.h.store, task.id, milestone).recorded, true);
    // The development ended outside a run (or the run left it): the sweep finds it by its status.
    f.set(task.id, state);
    assert.deepEqual(dueProgress(f.h.store).map(row => row.task_id), [task.id]);
    assert.equal(await settleProgress(f.h.store, task.id, f.github), true);
    assert.deepEqual(f.state.labels, expectNeedsHuman ? ['bot-needs-human'] : [], JSON.stringify(state));
    assert.match(f.state.comments.at(-1).body, expected);
    assert.equal(f.state.comments.filter(c => c.body.includes(task.id)).length, 1);
  }
  // A paused development waits for a person: the developing label comes off and needs-human goes on; retried, it flips back.
  const paused = f.task(); startProgress(f.h.store, paused, { ...f.issue, labels: f.state.labels.map(name => ({ name })) }); await settleProgress(f.h.store, paused.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-developing']);
  f.set(paused.id, { status: 'paused', error_code: 'user_pause' }); await settleProgress(f.h.store, paused.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-needs-human']); assert.match(f.state.comments.at(-1).body, /\*\*Status\*\*: Paused[\s\S]*Press Retry/);
  assert.equal(f.row(paused.id).final, 0, 'a pause is not the end');
  f.set(paused.id, { status: 'running', error_code: null });
  startProgress(f.h.store, f.h.store.get('SELECT * FROM tasks WHERE id=?', paused.id), f.issue); await settleProgress(f.h.store, paused.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-developing']); assert.match(f.state.comments.at(-1).body, /\*\*Status\*\*: In development/);
  assert.doesNotMatch(f.state.comments.at(-1).body, /#### Stopped/);

  // Disabling needs_human_label leaves no label even when development fails.
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { needs_human_label: '' })).status, 200);
  f.state.labels = [];
  const disabledTask = f.task(); startProgress(f.h.store, disabledTask, f.issue); await settleProgress(f.h.store, disabledTask.id, f.github);
  f.set(disabledTask.id, { status: 'failed', error_code: 'model_http_400' });
  await settleProgress(f.h.store, disabledTask.id, f.github);
  assert.deepEqual(f.state.labels, []);
});

test('the comment speaks the Issue\'s language, and a project without a developing label gets the comment only', async t => {
  const f = await fixture(t), task = f.task();
  startProgress(f.h.store, task, { number: 5, title: 'parsePairs 截断带等号的值', body: '保存后读回来值少了一截。' });
  const body = renderProgress(f.row(task.id), f.h.store.get('SELECT * FROM tasks WHERE id=?', task.id));
  assert.match(body, /### bot 开发进展/); assert.match(body, /\*\*状态\*\*：开发中/); assert.match(body, /\*\*开始依据\*\*：项目 Manager 提示词里的规则允许 bot 自行开发。检视结论为可开发，无人认领/);
  assert.equal(reportMilestone(f.h.store, task.id, { milestone: 'stopped', reason: 'The format needs a decision.' }).error, 'milestone_language');
  assert.equal(reportMilestone(f.h.store, task.id, { milestone: 'stopped', reason: '文件格式要由人决定（`parsePairs`）。' }).recorded, true);
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { developing_label: '' })).status, 200);
  const unlabeled = f.task(); startProgress(f.h.store, unlabeled, f.issue); await settleProgress(f.h.store, unlabeled.id, f.github);
  assert.equal(f.row(unlabeled.id).label, null); assert.deepEqual(f.state.labels, []); assert.equal(f.state.comments.length, 1);
});

test('the engine sweep settles a development that ended outside its run', async t => {
  const f = await fixture(t), task = f.task();
  startProgress(f.h.store, task, f.issue); await settleProgress(f.h.store, task.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-developing']);
  // A person cancelled it in the console: no run of it will settle the Issue; the engine's tick does.
  f.set(task.id, { status: 'cancelled', error_code: 'user_cancel' });
  const engine = new TaskEngine(f.h.store, { call: async () => ({ state: 'ready', generation: 1 }) }, f.url);
  t.after(() => engine.close());
  engine.tick(); await engine.progressSweep;
  assert.deepEqual(f.state.labels, []); assert.match(f.state.comments[0].body, /Someone cancelled this development/);
  assert.equal(f.row(task.id).final, 1);
});

test('Issue post_review adds needs_human_label on needs_information/human_decision_required and removes it when ready (#1215)', async t => {
  const f = await fixture(t);
  // Seed token/account/installation details so publishReviewDelivery connects to the fake GitHub server.
  const reviewTask = (id) => {
    const now = new Date().toISOString();
    f.h.store.run(
      `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES(?,'101','task.request','running','review',?,5,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,?)`,
      id, JSON.stringify({ target: { type: 'issue', number: 5 } }), now, now,
    );
    f.h.store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', id, JSON.stringify(['review']), now);
    return f.h.store.get('SELECT * FROM tasks WHERE id=?', id);
  };

  // Round 1: needs_information -> creates & adds bot-needs-human + bot-reviewed, and renders status header
  const t1 = reviewTask('rev-nh-1');
  const out1 = await publishReviewDelivery(f.h.store, t1, {
    target: { type: 'issue', number: 5 },
    key: null,
    summary: '缺少复现步骤。',
    findings: [{ id: 'F1', format: 'discussion', body: '请补充复现输入', requires_human_decision: true, human_action: '补充复现输入' }],
    resolved_comments: [],
    labels: [],
    conclusion: 'needs_information',
    recommendation: '需要补充复现步骤。',
  }, new Redactor(), async () => {}, () => {}, f.url);
  assert.equal(out1.ok, true);
  assert.ok(f.state.labels.includes('bot-reviewed'));
  assert.ok(f.state.labels.includes('bot-needs-human'));
  assert.ok(f.state.created.some(l => l.name === 'bot-needs-human' && l.color === 'd93f0b'));
  assert.match(f.state.comments[0].body, /\*\*自动开发状态\*\*：暂不可开发（需补充信息）/);

  // Round 2: ready_for_development -> removes bot-needs-human and updates status header
  const t2 = reviewTask('rev-nh-2');
  const out2 = await publishReviewDelivery(f.h.store, t2, {
    target: { type: 'issue', number: 5 },
    key: null,
    summary: '问题已确认，可以直接修复。',
    findings: [],
    resolved_comments: [],
    labels: [],
    conclusion: 'ready_for_development',
    recommendation: '可直接开发。',
  }, new Redactor(), async () => {}, () => {}, f.url);
  assert.equal(out2.ok, true);
  assert.ok(f.state.labels.includes('bot-reviewed'));
  assert.equal(f.state.labels.includes('bot-needs-human'), false);
  assert.match(f.state.comments[0].body, /\*\*自动开发状态\*\*：可开发/);
});

test('#1122 generic Issue task.request reconciles needs_human_label and newer development prevents stale older task from re-adding it (#1215)', async t => {
  const f = await fixture(t);
  const genericDev = (id, createdAt) => {
    f.h.store.run(
      `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES(?,'101','task.request','running','dev',?,5,?,?)`,
      id, JSON.stringify({ target: { type: 'issue', number: 5 }, executor_role: 'dev', intent: 'development' }), createdAt, createdAt,
    );
    f.h.store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', id, JSON.stringify(['pull_request']), createdAt);
    return f.h.store.get('SELECT * FROM tasks WHERE id=?', id);
  };

  // Issue starts with bot-needs-human from an earlier review; generic task.request removes it when starting
  f.state.labels = ['bot-needs-human'];
  const dev1 = genericDev('req-dev-1', '2026-11-20T10:00:00.000Z');
  startProgress(f.h.store, dev1, { ...f.issue, labels: [{ name: 'bot-needs-human' }] });
  await settleProgress(f.h.store, dev1.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-developing']);

  // Generic development fails -> adds bot-needs-human and drops bot-developing
  f.set(dev1.id, { status: 'failed', error_code: 'model_http_400' });
  await settleProgress(f.h.store, dev1.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-needs-human']);

  // A newer generic development starts on the same Issue -> removes bot-needs-human and adds bot-developing
  const dev2 = genericDev('req-dev-2', '2026-11-20T10:10:00.000Z');
  startProgress(f.h.store, dev2, { ...f.issue, labels: [] }); // even if issue.labels snapshot was stale, prior progress row had needs_human_on=1
  await settleProgress(f.h.store, dev2.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-developing']);

  // If the older failed development is settled again now, it MUST NOT re-add bot-needs-human or remove bot-developing
  f.h.store.run('UPDATE issue_development_progress SET final=0,pending=1,needs_human_on=0 WHERE task_id=?', dev1.id);
  await settleProgress(f.h.store, dev1.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-developing']);

  // When the newer generic development opens a PR -> removes bot-developing, keeps bot-needs-human off, adds bot-developed
  f.set(dev2.id, { status: 'pr_opened', result: JSON.stringify({ pr_number: 18, pr_url: 'https://github.invalid/fixture/project-101/pull/18', summary: 'Fixed.' }) });
  await settleProgress(f.h.store, dev2.id, f.github);
  assert.deepEqual(f.state.labels, ['bot-developed']);
});
