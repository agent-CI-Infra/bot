// Start requests (#933, #1133): an administrator of an untrusted-organization repository files a start request directly
// through the management assistant's start_repository tool (application_id NULL); super administrators are notified in
// the console (#/inbox) and Feishu private chat, decide in either place, and legacy application-backed requests remain
// upgrade-safe and approvable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { identityFixture } from '../../../fixtures/identity-fixture.mjs';
import { installed, repositoryRoutes, provider, call, person, say, assistantModel } from '../../../fixtures/onboarding-fixture.mjs';
import { transport, connector, bindFixture, privateChat, until, post, envelope, finished, managementOutcome } from '../../../fixtures/channel-fixture.mjs';
import { Store } from '../../../../dist/storage/database.js';
import { projectCeiling } from '../../../../dist/projects/ceiling.js';

test('a direct start_repository request reaches super administrators, is checked, withdrawn, rejected with a reason, and approved (#933, #1133)', async t => {
  const wire = transport(); let channels;
  const f = await identityFixture(t, { github: true, channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }, onChannels: s => { channels = s; } });
  const { h, admin, state } = f;
  installed(f, '103'); installed(f, '104'); state.accessible = ['101', '103', '104']; repositoryRoutes(f);

  const model = await provider(t, context => {
    const text = String(context.request?.content ?? context.request ?? '');
    const repo = text.includes('104') ? '104' : '103';
    if (text.includes('状态')) return [call(0, ['start_repository', { action: 'status', repository: repo }]), { role: 'assistant', content: '已查询状态。' }];
    if (text.includes('撤回')) return [call(0, ['start_repository', { action: 'withdraw', repository: repo }]), { role: 'assistant', content: '已撤回启动申请。' }];
    return [
      call(0, ['start_repository', { action: 'start', repository: repo, capability_ceiling: 'develop', summary: 'Node.js CLI tool; npm test; labels kind/bug' }]),
      { role: 'assistant', content: '已提交启动申请，等待超级管理员处理。' },
    ];
  });
  await assistantModel(f, model);

  const requester = await person(f, 42, 'admin'), writer = await person(f, 43, 'write');
  const feishu = await connector(admin), superAdmin = (await admin('/api/auth/me')).value.id;
  const requesterPrincipal = requester.principal;
  bindFixture(h, feishu, superAdmin); bindFixture(h, feishu, requesterPrincipal, 'ou_bob');
  const chats = { h, id: feishu };
  await privateChat(chats, 'ou_alice', superAdmin, 'oc_admin'); await privateChat(chats, 'ou_bob', requesterPrincipal, 'oc_bob');
  const told = (chat, text) => until(() => wire.sent.find(m => m.receive_id === chat && JSON.stringify(m.content).includes(text)));

  const conversation = (await requester('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const startTurn = async text => {
    const turn = await say(requester, conversation, text);
    return turn.history.events.find(e => e.message_id === turn.id && e.type === 'tool_result' && e.data.name === 'start_repository').data.result;
  };

  // Filing a direct start request stores application_id NULL and notifies super administrators.
  const filed = await startTurn('申请启动 103');
  assert.equal(filed.state, 'start_requested');
  const first = filed.request;
  assert.deepEqual([first.state, first.repository.full_name, first.requested_by.principal_id, first.requested_by.github_login, first.summary.capability_ceiling, first.summary.profile],
    ['pending', 'fixture/project-103', requesterPrincipal, 'user-42', 'develop', 'Node.js CLI tool; npm test; labels kind/bug']);
  assert.equal(h.store.get('SELECT application_id FROM onboarding_requests WHERE id=?', first.id).application_id, null);

  assert.deepEqual((await admin('/api/management/onboarding-requests')).value.requests.map(r => r.id), [first.id]);
  assert.equal((await requester('/api/management/onboarding-requests')).value.error, 'super_admin_required');
  assert.equal((await requester(`/api/management/onboarding-requests/${first.id}/approve`, 'POST', {})).value.error, 'super_admin_required');
  await told('oc_admin', 'fixture/project-103 申请启动');
  assert.match(JSON.stringify((await told('oc_admin', 'fixture/project-103 申请启动')).content), /https:\/\/console\.example\.test\/#\/inbox/);

  // Status returns the open request; requesting again keeps a single pending row.
  const statusRes = await startTurn('查看 103 状态');
  assert.deepEqual([statusRes.state, statusRes.request.id], ['start_requested', first.id]);
  const again = await startTurn('再次申请启动 103');
  assert.equal(again.request.id, first.id);
  assert.equal(h.store.get("SELECT count(*) AS n FROM onboarding_requests WHERE repository_id='103' AND state='pending'").n, 1);

  // A Write collaborator on 103 (who also has write on started 101) cannot start or withdraw 103.
  const writerConv = (await writer('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const writerWithdraw = await say(writer, writerConv, '撤回 103');
  assert.equal(writerWithdraw.history.events.find(e => e.type === 'tool_result' && e.data.name === 'start_repository').data.result.error, 'repository_admin_required');

  // Withdrawn by the requester, then requested again as a new row.
  const withdrawn = await startTurn('撤回 103');
  assert.deepEqual([withdrawn.state, withdrawn.request.state], ['withdrawn', 'withdrawn']);
  const second = (await startTurn('重新申请启动 103')).request;
  assert.notEqual(second.id, first.id);
  assert.equal(second.state, 'pending');

  // Rejected: requires a reason, notifies requester with a link to #/management (since unstarted), and closes the request.
  assert.equal((await admin(`/api/management/onboarding-requests/${second.id}/reject`, 'POST', { reason: ' ' })).value.error, 'rejection_reason_required');
  const rejected = (await admin(`/api/management/onboarding-requests/${second.id}/reject`, 'POST', { reason: '先在组织里确认谁来维护。' })).value.request;
  assert.deepEqual([rejected.state, rejected.reason, rejected.decided_by], ['rejected', '先在组织里确认谁来维护。', superAdmin]);
  await told('oc_bob', '先在组织里确认谁来维护。');
  assert.match(JSON.stringify((await told('oc_bob', '先在组织里确认谁来维护。')).content), /https:\/\/console\.example\.test\/#\/management\b/);
  assert.doesNotMatch(JSON.stringify((await told('oc_bob', '先在组织里确认谁来维护。')).content), /#\/onboarding\//);
  assert.equal((await admin(`/api/management/onboarding-requests/${second.id}/approve`, 'POST', {})).value.error, 'onboarding_request_closed');
  assert.equal(h.store.get("SELECT 1 FROM repositories WHERE id='103'"), undefined);

  // Requested again and approved at comment ceiling + trust_organization: starts project, projects identity immediately, and links to #/projects/103/management.
  const third = (await startTurn('再次提交 103 启动申请')).request;
  const approved = (await admin(`/api/management/onboarding-requests/${third.id}/approve`, 'POST', { capability_ceiling: 'comment', trust_organization: true })).value.request;
  assert.deepEqual([approved.state, approved.decision.capability_ceiling, approved.decision.trust_organization], ['approved', 'comment', true]);
  assert.equal(projectCeiling(h.store, '103'), 'comment');
  assert.ok(h.store.get("SELECT 1 FROM trusted_organizations WHERE owner_id='10'"));
  await told('oc_bob', 'fixture/project-103 的启动申请已同意');
  assert.match(JSON.stringify((await told('oc_bob', 'fixture/project-103 的启动申请已同意')).content), /https:\/\/console\.example\.test\/#\/projects\/103\/management\b/);

  // Requester immediately holds project access on 103 without re-signing in.
  assert.equal((await requester('/api/management/conversations', 'POST', { scope: 'project:103' })).status, 201);

  // Removing trust and uninstalling 104 lapses an open request.
  assert.equal((await admin('/api/trusted-organizations/10', 'DELETE', {})).status, 200);
  const fourth = (await startTurn('申请启动 104')).request;
  assert.equal(fourth.state, 'pending');
  h.store.run("UPDATE installed_repositories SET installed=0 WHERE repository_id='104'");
  h.store.run("UPDATE installation_repositories SET present=0 WHERE repository_id='104'");
  assert.deepEqual((await admin('/api/management/onboarding-requests?state=all')).value.requests.map(r => [r.repository.id, r.state]),
    [['104', 'lapsed'], ['103', 'approved'], ['103', 'rejected'], ['103', 'withdrawn']]);
  assert.ok(channels);
});

test('a super administrator decides a direct start request by answering its notice in the Feishu private chat; the requester cannot (#933, #1133)', async t => {
  const wire = transport();
  const f = await identityFixture(t, { github: true, channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false } });
  const { h, admin, state } = f;
  installed(f, '103'); installed(f, '104'); installed(f, '105'); state.accessible = ['103', '104', '105']; repositoryRoutes(f);

  const model = await provider(t, (context, body) => {
    const text = typeof context.request === 'string' ? context.request : JSON.stringify(context.request?.messages ?? context.request ?? '');
    const askMatch = /申请启动\s*(\d+)/.exec(text);
    if (askMatch) {
      return [call(0, ['start_repository', { action: 'start', repository: askMatch[1], capability_ceiling: 'develop', summary: 'CLI tool' }]),
        { role: 'assistant', content: '已提交启动申请。' }];
    }
    const pending = context.pending_start_requests?.[0];
    if (!pending) return [{ role: 'assistant', content: '没有待处理的启动申请。' }];
    // A refused decision comes back as the tool's observation; the assistant then reports it.
    const refused = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).find(result => result.error)?.error;
    return /拒绝/.test(text)
      ? [call(0, ['start_requests', { action: 'reject', request_id: pending.id, reason: '先确认谁来维护。' }]), { role: 'assistant', content: '已拒绝。' }]
      : [call(0, ['start_requests', { action: 'approve', request_id: pending.id }]), { role: 'assistant', content: refused ? `没有同意：${refused}` : '已同意，项目已启动。' }];
  });
  await assistantModel(f, model);

  const requester = await person(f, 42, 'admin');
  const feishu = await connector(admin), superAdmin = (await admin('/api/auth/me')).value.id;
  bindFixture(h, feishu, superAdmin); bindFixture(h, feishu, requester.principal, 'ou_bob');
  const chats = { h, id: feishu };
  await privateChat(chats, 'ou_alice', superAdmin, 'oc_admin'); await privateChat(chats, 'ou_bob', requester.principal, 'oc_bob');
  const told = (chat, text) => until(() => wire.sent.find(m => m.receive_id === chat && JSON.stringify(m.content).includes(text)));
  const answer = async (actor, chat, text) => {
    const row = await finished(h, (await post(h, feishu, envelope(text, { sender: { sender_id: { open_id: actor } }, message: { chat_id: chat } }))).value.operation_id);
    assert.equal(row.state, 'completed', JSON.stringify(managementOutcome(h, row.id)));
    return model.requests.filter(body => JSON.parse(body.messages[1].content).source_message === 'feishu:' + row.id);
  };
  const offered = body => body.tools.some(tool => tool.function.name === 'start_requests');
  const decided = id => { const row = h.store.get('SELECT state,reason,decided_by FROM onboarding_requests WHERE id=?', id); return [row.state, row.reason, row.decided_by]; };
  const userConv = (await requester('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const requestStart = async id => {
    const turn = await say(requester, userConv, '申请启动 ' + id);
    return turn.history.events.find(e => e.message_id === turn.id && e.type === 'tool_result' && e.data.name === 'start_repository').data.result.request;
  };

  const first = await requestStart('103');
  await told('oc_admin', '直接回复「同意」即可启动');

  // Requester is not a super administrator: start_requests is neither carried nor offered.
  const theirs = await answer('ou_bob', 'oc_bob', '同意');
  assert.ok(theirs.length && theirs.every(body => !offered(body) && !JSON.parse(body.messages[1].content).pending_start_requests));
  assert.deepEqual(decided(first.id), ['pending', null, null]);

  // Reject in Feishu private chat with reason.
  const rejecting = await answer('ou_alice', 'oc_admin', '拒绝，先确认谁来维护。');
  assert.ok(offered(rejecting[0]));
  assert.deepEqual(decided(first.id), ['rejected', '先确认谁来维护。', superAdmin]);
  await told('oc_bob', '先确认谁来维护。');

  // Re-request and approve in Feishu private chat.
  const second = await requestStart('103');
  await answer('ou_alice', 'oc_admin', '同意');
  assert.deepEqual(decided(second.id), ['approved', null, superAdmin]);
  assert.equal(projectCeiling(h.store, '103'), 'develop');
  await told('oc_bob', 'fixture/project-103 的启动申请已同意');

  // Decided on 待处理 while the Feishu turn is in flight: the approval is refused with onboarding_request_closed, which comes
  // back to the assistant (maintainers' decision on #1256); the console's decision stands.
  const third = await requestStart('104'), before = model.requests.length;
  let release; model.state.gate = new Promise(resolve => { release = resolve; });
  const operation = (await post(h, feishu, envelope('同意', { message: { chat_id: 'oc_admin' } }))).value.operation_id;
  await until(() => model.requests.length > before);
  assert.equal((await admin(`/api/management/onboarding-requests/${third.id}/reject`, 'POST', { reason: '已在控制台处理。' })).status, 201);
  model.state.gate = null; release();
  await finished(h, operation);
  assert.equal(managementOutcome(h, operation).message, 'completed');
  await told('oc_admin', '没有同意：onboarding_request_closed');
  assert.deepEqual(decided(third.id), ['rejected', '已在控制台处理。', superAdmin]);

  // Organization-confined Feishu app sends super administrator to 待处理.
  h.store.run("UPDATE channel_connectors SET owner_tenant='github.com:10' WHERE id=?", feishu);
  await requestStart('105');
  await told('oc_admin', '在控制台「待处理」的启动申请里同意或拒绝');
});

test('upgrading relaxes older NOT NULL application_id schemas and preserves approval of legacy application-backed start requests (#1133)', async t => {
  // 1. Verify 12-step schema migration from pre-#1133 NOT NULL application_id without summary column.
  const directory = mkdtempSync(join(tmpdir(), 'onboarding-req-upgrade-')), database = join(directory, 'control.sqlite'), key = randomBytes(32);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(database, key);
  store.db.exec(`
    DROP TABLE onboarding_requests;
    CREATE TABLE onboarding_requests(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,application_id TEXT NOT NULL REFERENCES onboarding_applications(id),
      requested_by TEXT NOT NULL,requested_at TEXT NOT NULL,state TEXT NOT NULL,decided_by TEXT,decided_at TEXT,reason TEXT,decision TEXT,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX onboarding_open_request ON onboarding_requests(repository_id) WHERE state='pending';
    CREATE INDEX onboarding_request_state ON onboarding_requests(state,requested_at);
  `);
  const ts = new Date().toISOString();
  store.run("INSERT INTO onboarding_sessions VALUES('s1','103','c1','open',NULL,'p1',?,?,NULL,NULL)", ts, ts);
  store.run("INSERT INTO onboarding_plans VALUES('pl1','s1','103',1,?,'m1','p1',?)", JSON.stringify({ profile: { summary: 'legacy', sources: ['README.md'] } }), ts);
  store.run("INSERT INTO onboarding_applications VALUES('ap1','pl1','103',1,'p1',?,'[]','{}')", ts);
  store.run("INSERT INTO onboarding_requests VALUES('rq1','103','ap1','p1',?,'pending',NULL,NULL,NULL,NULL,?)", ts, ts);
  store.close();

  store = new Store(database, key); t.after(() => store.close());
  const cols = store.all('PRAGMA table_info(onboarding_requests)');
  assert.equal(cols.find(c => c.name === 'application_id').notnull, 0);
  assert.ok(cols.some(c => c.name === 'summary'));
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  assert.equal(store.get("SELECT id FROM onboarding_requests WHERE id='rq1'").id, 'rq1');
  // Direct insert with application_id NULL now succeeds.
  store.run("INSERT INTO onboarding_requests(id,repository_id,application_id,requested_by,requested_at,state,summary,updated_at) VALUES('rq2','104',NULL,'p1',?,'pending','{}',?)", ts, ts);

  // 2. Verify approving an in-flight legacy application-backed request still starts the repository and resumes waiting items.
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f;
  installed(f, '103'); state.accessible = ['103'];
  const github = repositoryRoutes(f);
  const requester = await person(f, 42, 'admin');
  const legacyPlan = {
    profile: { summary: 'Legacy plan', sources: ['README.md'] },
    capability_ceiling: { value: 'develop', reason: 'develop' },
    test_command: { value: 'npm test', reason: 'README' },
    labels: { items: [{ name: 'kind/bug', color: 'd73a4a', action: 'create' }], reason: 'triage' },
  };
  h.store.run("INSERT INTO onboarding_sessions VALUES('leg-s','103','leg-c','open',NULL,?,?,?,NULL,NULL)", requester.principal, ts, ts);
  h.store.run("INSERT INTO onboarding_plans VALUES('leg-p','leg-s','103',1,?,'leg-m',?,?)", JSON.stringify(legacyPlan), requester.principal, ts);
  h.store.run("INSERT INTO onboarding_applications VALUES('leg-a','leg-p','103',1,?,?,'[]','{}')", requester.principal, ts);
  for (const [pos, item] of [[0, 'start'], [1, 'capability_ceiling'], [2, 'test_command'], [3, 'labels']])
    h.store.run("INSERT INTO onboarding_receipts(application_id,item,position,state,error,updated_at) VALUES('leg-a',?,?,'pending',?,?)",
      item, pos, item === 'start' ? 'start_approval_pending' : 'project_not_started', ts);
  const legacyReqId = 'deadbeef11330001';
  h.store.run("INSERT INTO onboarding_requests(id,repository_id,application_id,requested_by,requested_at,state,updated_at) VALUES(?,'103','leg-a',?,?,'pending',?)",
    legacyReqId, requester.principal, ts, ts);

  const approved = await admin(`/api/management/onboarding-requests/${legacyReqId}/approve`, 'POST', { capability_ceiling: 'comment' });
  assert.equal(approved.status, 201, JSON.stringify(approved.value));
  assert.equal(projectCeiling(h.store, '103'), 'comment');
  assert.equal(h.store.get("SELECT test_command FROM policies WHERE repository_id='103'").test_command, 'npm test');
  assert.deepEqual(github.created.map(c => c.body.name), ['kind/bug']);
  const states = Object.fromEntries(h.store.all("SELECT item,state FROM onboarding_receipts WHERE application_id='leg-a'").map(r => [r.item, r.state]));
  assert.deepEqual(states, { start: 'succeeded', capability_ceiling: 'skipped', test_command: 'succeeded', labels: 'succeeded' });
});
