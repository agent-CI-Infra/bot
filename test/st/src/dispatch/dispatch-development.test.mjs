import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { configureDispatch, Dispatcher } from '../../../../dist/dispatch/worker.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { managerDecision } from '../../../../dist/dispatch/manager.js';
import { queueDevelopment } from '../../../../dist/review/development.js';
import { taskPermissions } from '../../../../dist/tasks/configuration.js';
import { alice, issue, head, tasks, events, fixture, toolCall } from './dispatch-fixture.mjs';

configureDispatch(null);

test('a person\'s development label always reaches the Manager: it answers with a review, or develops on the label to its own brief', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { development_enabled: true });
  // The published review left the start to a person: a claim in the Issue text.
  const result = { summary: 'The Issue reserves the fix for its author; a maintainer must decide.', recommendation: 'Human decision required: who makes the change.', findings: [] }, now = new Date().toISOString();
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)", JSON.stringify(result), now, now);
  const labeled = { ...issue, labels: [{ name: 'bot-develop' }], assignees: [] }, label = delivery => queueWebhook(f.h.store, '101', 'issues', { action: 'labeled', label: { name: 'bot-develop' }, issue: labeled, sender: { ...alice, login: 'maintainer' } }, delivery);
  // Development does not fit yet: the Manager answers the label with a review instead of staying silent.
  f.state.decide = input => ({ decision: 'create', option_ids: ['review'], reason: '还缺维护者对实现范围的决定，先回复',
    brief: { goal: 'Answer the development label: say why development does not start and what a person can do.', criteria: ['Names what is missing'] } });
  assert.equal(label('label-1'), 1); await f.run();
  const offered = JSON.parse(f.requests[0].messages[1].content);
  assert.deepEqual(offered.work.create.map(o => o.work), ['development.issue', 'review.issue', 'reply']);
  assert.deepEqual([offered.event.facts.development.labeled_by, offered.event.facts.development.review.recommendation], ['maintainer', 'Human decision required: who makes the change.']);
  assert.match(f.requests[0].messages[0].content, /## Starting development/);
  const [answer] = tasks(f.h).filter(task => task.kind === 'task.request' && task.id !== 'rv'), answerInput = JSON.parse(answer.input);
  assert.equal(answerInput.trigger.reason, 'labeled'); assert.match(answerInput.manager.brief.goal, /^Answer the development label/);
  f.h.store.run("UPDATE tasks SET status='succeeded',result=? WHERE id=?", JSON.stringify(result), answer.id);
  // Developing an Issue needs the Manager's brief (no review gives a goal); the refusal goes back to the model once.
  f.state.decide = (input, round) => round === 0 ? { decision: 'create', option_ids: ['development'], reason: '维护者已放行', basis: { kind: 'label' } }
    : { decision: 'create', option_ids: ['development'], reason: '维护者已放行，按说明实现', basis: { kind: 'label' }, brief: { goal: 'Keep the last CRLF line.', criteria: ['A test with a CRLF file'] } };
  assert.equal(label('label-2'), 1); await f.run();
  const refusal = f.requests.at(-1).messages.find(m => m.role === 'tool');
  assert.match(refusal.content, /dispatch_brief_required/);
  const development = tasks(f.h).find(isDevTask), input = JSON.parse(development.input);
  assert.equal(input.manager.brief.goal, 'Keep the last CRLF line.');
  // #1250: developing an Issue opens a pull request, so the shorthand goes to the Task Manager's team, not dev alone.
  assert.equal(input.executor_role, undefined);
  assert.equal(f.h.store.get('SELECT executor_role FROM task_origins WHERE task_id=?', development.id).executor_role, null);
  assert.ok(development.unique_key.startsWith('101:dispatch:101:issue.labeled:5:update:' + events(f.h).at(-1).delivery_id));
  // The label is the basis, as the control plane read it when it wrote the event (#815).
  assert.deepEqual(JSON.parse(f.h.store.get('SELECT detail FROM task_development_basis WHERE task_id=?', development.id).detail), { kind: 'label', label: 'bot-develop', labeled_by: 'maintainer' });
});

test('all pull_request development tasks unify onto the Task Manager team, even when role="manager" or role="dev" is passed (#1250, #1331)', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { development_enabled: true });
  const labeled = { ...issue, labels: [{ name: 'bot-develop' }], assignees: [] }, label = delivery => queueWebhook(f.h.store, '101', 'issues', { action: 'labeled', label: { name: 'bot-develop' }, issue: labeled, sender: { ...alice, login: 'maintainer' } }, delivery);
  const brief = { goal: 'Keep the last CRLF line.', criteria: ['A test with a CRLF file'] };
  let role = 'manager';
  f.state.message = () => toolCall('create_task', { role, writes: ['pull_request'], basis: { kind: 'label' }, reason: '维护者加了开发标签', brief }, 'c1');
  assert.equal(label('team-1'), 1); await f.run();
  // The guidance the Manager decided with: its role prompt and the create_task tool both send pull_request tasks to the team.
  const [request] = f.requests, system = request.messages[0].content.replace(/\s+/g, ' ');
  assert.ok(system.includes("Every verified pull_request development task goes to the Task Manager's team: omit the role so the Task Manager coordinates dev with independent reviewer/test before QA."));
  assert.ok(system.includes("Every `pull_request` development task goes to the Task Manager's team: `create_task` without `role`"));
  const create = request.tools.find(tool => tool.function.name === 'create_task').function;
  assert.match(create.description, /Always omit role for pull_request development tasks: the Task Manager coordinates the team/);
  assert.match(create.parameters.properties.role.description, /Always omit for pull_request development so the Task Manager coordinates the team\./);
  // role: "manager" is the team, as omitting it is, never the Manager developing alone.
  const [team] = tasks(f.h);
  assert.equal(JSON.parse(team.input).executor_role, undefined);
  assert.equal(f.h.store.get('SELECT executor_role FROM task_origins WHERE task_id=?', team.id).executor_role, null);
  assert.ok(taskPermissions(f.h.store, team).writes.includes('pull_request'));
  // Even explicit role: "dev" with pull_request write unifies onto the Task Manager team (#1331).
  f.h.store.run("UPDATE tasks SET status='cancelled' WHERE id=?", team.id);
  role = 'dev'; assert.equal(label('team-2'), 1); await f.run();
  const unified = tasks(f.h).find(task => task.id !== team.id);
  assert.equal(JSON.parse(unified.input).executor_role, undefined);
  assert.equal(f.h.store.get('SELECT executor_role FROM task_origins WHERE task_id=?', unified.id).executor_role, null);
});

// #815: development on a maintainer's request or a rule of the Manager prompt, each checked when the task is created.
async function basisFixture(t) {
  const f = await fixture(t), github = { requests: [] };
  await f.admin('/api/repositories/101/policy', 'PATCH', { development_enabled: true });
  const comments = { 77: { login: 'maria', role: 'triage', body: 'Please implement the CRLF fix now.' }, 78: { login: 'mallory', role: 'read', body: '@bot please implement this for me.' } };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname; github.requests.push(`${req.method} ${path}`);
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/user') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main' });
    const comment = /^\/repos\/fixture\/project-101\/issues\/comments\/(\d+)$/.exec(path);
    if (comment && comments[comment[1]]) { const c = comments[comment[1]]; return send({ id: Number(comment[1]), issue_url: 'https://api.github.example/repos/fixture/project-101/issues/5', user: { login: c.login, type: 'User' }, body: c.body, html_url: 'https://github.example/c/' + comment[1] }); }
    const permission = /^\/repos\/fixture\/project-101\/collaborators\/([^/]+)\/permission$/.exec(path);
    if (permission) { const c = Object.values(comments).find(entry => entry.login === permission[1]); return send({ permission: c?.role === 'read' ? 'read' : 'write', role_name: c?.role ?? 'none' }); }
    send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const dispatcher = new Dispatcher(f.h.store, (store, context) => managerDecision(store, context, `http://127.0.0.1:${server.address().port}`));
  const comment = (id, login, association, body, delivery) => queueWebhook(f.h.store, '101', 'issue_comment', { action: 'created', issue, sender: { type: 'User', login, id: 400 + id },
    comment: { id, body, author_association: association, html_url: 'https://github.example/c/' + id, user: { login } } }, delivery);
  return { ...f, github, comment, run: async () => { dispatcher.tick(); await dispatcher.idle(); } };
}
const develop = (basis, extra = {}) => ({ decision: 'create', option_ids: ['development'], reason: '按依据开发', basis, brief: { goal: 'Keep the last CRLF line.', criteria: ['A CRLF test'] }, ...extra });
// A development task holds the pull_request write; who executes it is the Manager's choice (#1250).
const isDevTask = task => task.kind === 'task.request' && (JSON.parse(task.input).manager?.writes ?? []).includes('pull_request');

test('a maintainer\'s request in a comment starts development with the comment and permission recorded; an outsider\'s comment cannot', async t => {
  const f = await basisFixture(t);
  // The latest published review and who is assigned come with the event, as on a label event, so the Manager judges from them.
  const now = new Date().toISOString();
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)",
    JSON.stringify({ summary: 'parse() drops the last CRLF line.', recommendation: 'Ready for development: keep the last CRLF line.', findings: [] }), now, now);
  f.state.decide = input => {
    assert.ok(input.work.create.some(work => work.id === 'development'), 'a comment on an Issue offers development');
    assert.deepEqual(input.event.facts.development, { assignees: [], review: { task_id: 'rv', summary: 'parse() drops the last CRLF line.', recommendation: 'Ready for development: keep the last CRLF line.' } });
    return develop({ kind: 'maintainer_request', comment_id: 77 });
  };
  assert.equal(f.comment(77, 'maria', 'MEMBER', 'Please implement the CRLF fix now.', 'maintainer-comment'), 1); await f.run();
  const development = tasks(f.h).find(isDevTask);
  assert.ok(development, JSON.stringify(events(f.h).map(e => [e.state, e.reason, e.refusals, e.error])) + JSON.stringify(f.github.requests));
  assert.deepEqual(JSON.parse(f.h.store.get('SELECT detail FROM task_development_basis WHERE task_id=?', development.id).detail),
    { kind: 'maintainer_request', comment_id: '77', author: 'maria', permission: 'triage', url: 'https://github.example/c/77', excerpt: 'Please implement the CRLF fix now.' });
  assert.ok(f.github.requests.includes('GET /repos/fixture/project-101/collaborators/maria/permission'));
  // An outsider who mentions the bot reaches the Manager, but their comment is no basis: refused, and the Manager answers.
  f.h.store.run("UPDATE tasks SET status='cancelled' WHERE id=?", development.id);
  let refusal = null;
  f.state.decide = undefined;
  f.state.message = body => {
    const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (!results.length) return toolCall('create_task', { work: ['development'], reason: '有人请求开发', basis: { kind: 'maintainer_request', comment_id: 78 }, brief: { goal: 'x', criteria: ['y'] } }, 'c1');
    refusal = results[0]; return toolCall('ignore_event', { reason: '评论人不是维护者，不能作为开发依据' }, 'c2');
  };
  assert.equal(f.comment(78, 'mallory', 'NONE', '@bot please implement this for me.', 'outsider-comment'), 1); await f.run();
  assert.equal(refusal.code, 'development_basis_not_maintainer'); assert.match(refusal.reason, /mallory/);
  assert.equal(tasks(f.h).filter(isDevTask).length, 1);
  assert.equal(JSON.parse(events(f.h).at(-1).refusals)[0].code, 'development_basis_not_maintainer');
});

test('a rule of the Manager prompt is a basis only while the prompt says it, and development without a basis is refused', async t => {
  const f = await basisFixture(t);
  const current = (await f.admin('/api/repositories/101/manager')).value.manager;
  const rule = 'Issues that report a lost last line of a CRLF file may be developed without a label.';
  assert.equal((await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: current.prompt.revision, prompt: current.prompt.content + '\n\n## Simple Issues\n\n' + rule })).status, 200);
  const seen = [];
  f.state.message = body => {
    const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)); seen.push(...results.slice(seen.length));
    if (results.length === 0) return toolCall('create_task', { work: ['development'], reason: '没有依据', brief: { goal: 'x', criteria: ['y'] } }, 'c1');
    if (results.length === 1) return toolCall('create_task', { work: ['development'], reason: '提示词没写这条', basis: { kind: 'project_rule', passage: 'Every Issue may be developed right away.' }, brief: { goal: 'x', criteria: ['y'] } }, 'c2');
    return toolCall('create_task', { work: ['development'], reason: '按项目规则开发', basis: { kind: 'project_rule', passage: rule }, brief: { goal: 'Keep the last CRLF line.', criteria: ['A CRLF test'] } }, 'c3');
  };
  queueWebhook(f.h.store, '101', 'issues', { action: 'opened', issue, sender: alice }, 'rule-opened'); await f.run();
  assert.deepEqual(seen.map(r => r.code), ['development_basis_required', 'development_basis_invalid']);
  const development = tasks(f.h).find(isDevTask), basis = JSON.parse(f.h.store.get('SELECT detail FROM task_development_basis WHERE task_id=?', development.id).detail);
  assert.equal(basis.kind, 'project_rule'); assert.equal(basis.passage, rule); assert.match(basis.prompt_revision, /^revision:/);
  // The task details show the basis.
  assert.equal((await f.admin('/api/tasks/' + development.id)).value.basis.kind, 'project_rule');
});

test('the built-in rule for clear Issues is a project_rule basis when a review concludes ready_for_development (#1026)', async t => {
  const f = await fixture(t);
  await f.admin('/api/repositories/101/policy', 'PATCH', { development_enabled: true });
  // The rule's sentence as the built-in Manager prompt states it; no prompt was saved for this project.
  const rule = /The bot may develop an Issue on its own when [^.]+\./.exec(readFileSync(new URL('../../../../docs/prompts/manager-dispatch.md', import.meta.url), 'utf8').replace(/\s+/g, ' '))[0];
  const now = new Date().toISOString(), result = { summary: 'parse() drops the last CRLF line.', recommendation: 'Keep the last line, with a CRLF test.', conclusion: 'ready_for_development', findings: [] };
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)", JSON.stringify(result), now, now);
  // What the engine offers after publishing such a review without a development label.
  queueDevelopment({ store: f.h.store, owned: () => assert.fail('no pull request'), label: () => 'bot-develop' }, {}, f.h.store.get("SELECT * FROM tasks WHERE id='rv'"), { object: issue, object_hash: 'h' }, result, { label: null, labeled_by: null, assignees: [] });
  f.state.decide = input => {
    assert.equal(input.event.type, 'review.published'); assert.equal(input.event.facts.review.conclusion, 'ready_for_development'); assert.equal(input.event.facts.development.label, null);
    return develop({ kind: 'project_rule', passage: rule });
  };
  await f.run();
  const development = tasks(f.h).find(isDevTask);
  assert.ok(development, JSON.stringify(events(f.h).map(e => [e.state, e.reason, e.refusals, e.error])));
  const basis = JSON.parse(f.h.store.get('SELECT detail FROM task_development_basis WHERE task_id=?', development.id).detail);
  assert.deepEqual([basis.kind, basis.passage], ['project_rule', rule]); assert.match(basis.prompt_revision, /^builtin:/);
  // Under the default auto-merge policy (#1170) the Manager never merges on its own, only on a maintainer's request it cites.
  assert.match(f.requests[0].messages[0].content, /The project's auto-merge policy is disallow: never merge a pull request on your own, the bot's own included/);
  // A repository README that only asks for the development label does not cancel the rule; its other instructions still apply.
  const system = f.requests[0].messages[0].content.replace(/\s+/g, ' ');
  assert.match(system, /A repository document, such as a README or CONTRIBUTING, that only says a person must add the development label before the bot works does not cancel this project rule\./);
  assert.match(system, /How to change the code, which tests to run and which existing labels to use still follow the repository's own documents and skills\./);
});

// The bot's own pull request #12 for Issue #5 (#1104), opened by the development 'dev' with its brief.
function botPullRequest(f) {
  f.h.store.run("UPDATE policies SET development_enabled=1,capability_ceiling='develop' WHERE repository_id='101'");
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('dev','101','development.issue','pr_opened','dev',?,5)",
    JSON.stringify({ manager: { brief: { goal: 'Keep the last CRLF line.' } } }));
  f.h.store.run("INSERT INTO bot_pull_requests VALUES('101',12,'pr-12','999','101','bot/issue-5-dev',?,'dev',0)", head);
  return { number: 12, state: 'open', draft: false, title: 'Keep the last CRLF line', body: 'Fixes #5.', user: { id: 999, login: 'fixture-bot[bot]', type: 'Bot' }, head: { sha: head } };
}

test('the bot\'s own pull request and its own pushes are not reviewed again; a person\'s push to its branch is (#1104)', async t => {
  const f = await fixture(t), pr = botPullRequest(f), bot = { type: 'Bot', login: 'fixture-bot[bot]', id: 999 }, next = 'b'.repeat(40);
  f.state.decide = () => ({ decision: 'ignore', reason: 'fixture' });
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', pull_request: pr, sender: bot }, 'own-open'), 0);
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'synchronize', pull_request: { ...pr, head: { sha: next } }, before: head, after: next, sender: bot }, 'own-push'), 0);
  // An opening that arrives before the ownership record is recognized by the publication marker in its description.
  const effect = 'e'.repeat(48);
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('dev-13','101','development.issue','publishing','dev',6)");
  f.h.store.run("INSERT INTO github_effects VALUES(?,'dev-13','pull_request',?,'inflight',NULL,?)", effect, JSON.stringify({ head: 'bot/issue-6-dev-13', base: 'main' }), `<!-- dept-bot:${effect} -->`);
  // The fixture account is a bot account, an ordinary GitHub user: the client recorded whom it acts as when it identified itself.
  f.h.store.run("INSERT INTO github_actors SELECT account_id,'999','fixture-bot',? FROM repositories WHERE id='101'", new Date().toISOString());
  const marked = { ...pr, number: 13, user: { id: 999, login: 'fixture-bot', type: 'User' }, body: `Fixes #6.\n\n<!-- dept-bot:${effect} -->`, head: { sha: head, ref: 'bot/issue-6-dev-13', repo: { id: 101 } } };
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', pull_request: marked, sender: { ...bot, type: 'User' } }, 'own-open-13'), 0);
  assert.deepEqual(events(f.h).map(e => [e.state, JSON.parse(e.result).filtered]), [['filtered', 'bot_own_pull_request'], ['filtered', 'bot_own_pull_request'], ['filtered', 'bot_own_pull_request']]);
  assert.match(events(f.h)[0].reason, /独立检视、测试和 QA/);
  // A copied marker is not the bot's pull request: a person's, or one from another branch, is reviewed as usual (#1104 review).
  // Because `marked.body` links `Fixes #6.` while `dev-13` is actively publishing Issue #6, each non-bot PR also emits an
  // `issue.linked_pull_request` convergence event on Issue #6's Manager thread alongside its own `pull_request.opened` event.
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', pull_request: { ...marked, number: 15, user: { id: 5, login: 'alice', type: 'User' } }, sender: alice }, 'copied-by-person'), 2);
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', pull_request: { ...marked, number: 16, head: { ...marked.head, ref: 'feature/x' } }, sender: bot }, 'copied-other-branch'), 2);
  const otherApp = { id: 1234, login: 'other-app[bot]', type: 'Bot' };
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', pull_request: { ...marked, number: 17, user: otherApp }, sender: otherApp }, 'copied-by-app'), 2);
  // Someone else's push to the bot's branch, and a person's own pull request, still reach the Manager.
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'synchronize', pull_request: { ...pr, head: { sha: 'c'.repeat(40) } }, sender: alice }, 'person-push'), 1);
  assert.equal(queueWebhook(f.h.store, '101', 'pull_request', { action: 'opened', pull_request: { ...pr, number: 14, body: 'Mine.', user: { id: 5 } }, sender: alice }, 'person-open'), 1);
  // The dispatcher claims at most four events at a time and serializes events on `101:issue:6`.
  for (let i = 0; i < 4; i++) await f.run();
  assert.equal(f.requests.length, 8);
  assert.equal(events(f.h).filter(e => e.type === 'issue.linked_pull_request' && e.thread_key === '101:issue:6').length, 3);
});

test('a member\'s comment on the bot\'s pull request reaches the Manager as a revision it can start, once per comment (#1104)', async t => {
  const f = await fixture(t), pr = botPullRequest(f);
  const comment = (id, body) => ({ action: 'created', sender: alice, issue: { number: 12, state: 'open', title: pr.title, pull_request: {}, user: { id: 999 } },
    comment: { id, body, author_association: 'MEMBER', html_url: `https://github.invalid/pull/12#issuecomment-${id}`, user: { login: 'alice', type: 'User' } } });
  let seen = null;
  f.state.decide = input => { seen = input; return { decision: 'create', option_ids: ['development'], reason: '成员要求修改错误信息' }; };
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', comment(301, 'Please name the SKU in the error.'), 'c-301', pr), 1);
  await f.run();
  // Beside a review and a reply, the Manager could revise the pull request; no review stands in between.
  assert.equal(seen.event.facts.bot_pull_request, true);
  // The Manager prompt says what such a comment calls for, and that the bot's own pull requests are not reviewed again.
  const system = f.requests[0].messages[0].content.replace(/\s+/g, ' ');
  assert.match(system, /The bot's own pull requests and its own pushes do not come here/);
  assert.match(system, /On the bot's own pull request \(`facts\.bot_pull_request`\), each open bot PR is one continuous multi-round development task: prioritize `continue_task` on its resumable task in `work\.continue`/);
  assert.match(system, /`facts\.revisions` says how often the pull request was already revised for comments \(`for_requests`\) and for this author \(`for_this_author`\); when another review bot keeps asking after the bot already revised for it and no person joined, answer it instead of revising again/);
  assert.match(system, /Issue review published: start development \(`writes: \["pull_request"\]`, omitting `role`\) when the review concludes `ready_for_development`/);
  assert.deepEqual(seen.event.facts.revisions, { for_requests: 0, for_this_author: 0 });
  assert.equal(seen.work.create.find(o => o.id === 'development')?.work, 'development.pr'); assert.ok(seen.work.create.some(o => o.id === 'review'));
  const revision = tasks(f.h).find(isDevTask);
  assert.ok(revision, JSON.stringify(events(f.h).map(e => [e.state, e.reason, e.refusals, e.error])));
  // Under #1331, pull_request revisions unify onto the Task Manager team (no single-role dev fork).
  assert.equal(JSON.parse(revision.input).executor_role, undefined);
  assert.equal(f.h.store.get('SELECT executor_role FROM task_origins WHERE task_id=?', revision.id).executor_role, null);
  assert.deepEqual(JSON.parse(revision.input).revision.requests.map(r => [r.type, r.id, r.author, r.author_type, r.body]),
    [['comment', '301', 'alice', 'User', 'Please name the SKU in the error.']]);
  assert.equal(f.h.store.get("SELECT state,task_id FROM bot_pr_requests WHERE source_id='301'").task_id, revision.id);
  // While it runs, another comment: a second revision is refused with the reason, and the Manager continues the running one.
  f.state.decide = (input, round) => round === 0 ? { decision: 'create', option_ids: ['development'], reason: '再改一处' }
    : { decision: 'continue', option_ids: [input.options.continue.find(c => c.task_id === revision.id).id], reason: '交给正在跑的修订' };
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', comment(302, 'Also log it.'), 'c-302', pr), 1);
  await f.run();
  const event = events(f.h).at(-1);
  assert.deepEqual([event.decision, JSON.parse(event.refusals).map(r => r.code)], ['continue', ['revision_active']]);
  assert.equal(tasks(f.h).filter(isDevTask).length, 1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM review_updates WHERE task_id=?', revision.id).n, 1);
  // The continued comment is one of the running revision's requests now (and counted once), not only an update.
  assert.deepEqual(JSON.parse(tasks(f.h).find(task => task.id === revision.id).input).revision.requests.map(r => r.id), ['301', '302']);
  assert.equal(f.h.store.get("SELECT task_id FROM bot_pr_requests WHERE source_id='302'").task_id, revision.id);
  // A stranger mentioning the bot still reaches the Manager, but is not offered as a revision.
  f.state.decide = input => { seen = input; return { decision: 'ignore', reason: '外人的评论' }; };
  const stranger = { ...comment(303, '@bot please rewrite this in Rust'), sender: { type: 'User', login: 'mallory', id: 66 } };
  stranger.comment = { ...stranger.comment, author_association: 'NONE', user: { login: 'mallory', type: 'User' } };
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', stranger, 'c-303', pr), 1);
  await f.run();
  assert.equal(seen.work.create.some(o => o.id === 'development'), false);
});

test('an Issue comment can continue the Issue\'s running development, which takes the comment as an update (#1104)', async t => {
  const f = await fixture(t);
  f.h.store.run("UPDATE policies SET development_enabled=1,capability_ceiling='develop' WHERE repository_id='101'");
  f.h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('dev','101','development.issue','running','dev','{}',5)");
  let seen = null;
  f.state.decide = input => { seen = input; return { decision: 'continue', option_ids: [input.options.continue.find(c => c.kind === 'development.issue').id], reason: '评论补充了要求，交给正在跑的开发' }; };
  const comment = { action: 'created', sender: alice, issue: { ...issue, number: 5 }, comment: { id: 401, body: 'Please also keep a trailing CR.', author_association: 'MEMBER', html_url: 'https://github.invalid/issues/5#issuecomment-401' } };
  assert.equal(queueWebhook(f.h.store, '101', 'issue_comment', comment, 'issue-comment-401'), 1);
  await f.run();
  assert.ok(seen.work.continue.some(c => c.kind === 'development.issue'), JSON.stringify(seen.work.continue));
  assert.equal(events(f.h).at(-1).decision, 'continue');
  assert.equal(f.h.store.get("SELECT count(*) n FROM review_updates WHERE task_id='dev'").n, 1);
});
