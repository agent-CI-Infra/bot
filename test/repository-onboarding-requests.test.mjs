// Start requests (#933): an administrator of a repository whose organization is not trusted confirms the onboarding plan;
// the start waits for a super administrator, who is told in the console and in their Feishu private chat, approves (with
// the model and level they choose) or rejects with a reason; the requester is told. GitHub, Feishu and the model are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { installed, repositoryRoutes, provider, call, person, say, assistantModel } from './onboarding-fixture.mjs';
import { transport, connector, bindFixture, privateChat, until } from './channel-fixture.mjs';
import { projectCeiling } from '../dist/work/ceiling.js';

const plan = {
  profile: { summary: '命令行工具，Node.js。', sources: ['README.md'] },
  capability_ceiling: { value: 'develop', reason: '可以开发简单问题' },
  test_command: { value: 'npm test', reason: 'README 写明' },
  labels: { items: [{ name: 'kind/bug', color: 'd73a4a', action: 'create' }], reason: '分类' },
  conventions: { label_usage: 'kind/ 前缀表示问题类型。' },
};
const receipts = view => Object.fromEntries(view.application.receipts.map(r => [r.item, [r.state, r.error]]));

test('a start request reaches the super administrators, is withdrawn, rejected with a reason, and approved; the rest of the plan is applied as the requester (#933)', async t => {
  const wire = transport(); let channels;
  const f = await identityFixture(t, { github: true, channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }, onChannels: s => { channels = s; } });
  const { h, admin, state } = f;
  installed(f, '103'); installed(f, '104'); state.accessible = ['101', '103', '104']; repositoryRoutes(f);
  await assistantModel(admin, await provider(t, () => [call(0, ['propose_onboarding_plan', plan]), { role: 'assistant', content: '方案草稿已保存。' }]));
  const requester = await person(f, 42, 'admin'), other = await person(f, 43, 'write');
  // The super administrator and the requester each have a private chat with the bot.
  const feishu = await connector(admin), superAdmin = (await admin('/api/auth/me')).value.id;
  const requesterPrincipal = requester.principal;
  bindFixture(h, feishu, superAdmin); bindFixture(h, feishu, requesterPrincipal, 'ou_bob');
  const chats = { h, id: feishu };
  await privateChat(chats, 'ou_alice', superAdmin, 'oc_admin'); await privateChat(chats, 'ou_bob', requesterPrincipal, 'oc_bob');
  const told = (chat, text) => until(() => wire.sent.find(m => m.receive_id === chat && JSON.stringify(m.content).includes(text)));
  const confirm = async id => {
    const opened = (await requester(`/api/management/onboarding/${id}`, 'POST', {})).value;
    await say(requester, opened.session.conversation_id, '请出方案');
    const view = (await requester(`/api/management/onboarding/${id}`)).value;
    return (await requester(`/api/management/onboarding/${id}/confirm`, 'POST', { version: view.plan.version, changes_revision: view.plan.changes_revision, items: view.plan.changes.map(c => c.item) })).value;
  };

  // Confirming files the request: the start waits for it, the rest for the start.
  let view = await confirm('103');
  assert.deepEqual(receipts(view), { start: ['pending', 'start_approval_pending'], capability_ceiling: ['pending', 'project_not_started'], test_command: ['pending', 'project_not_started'],
    conventions: ['pending', 'project_not_started'], labels: ['pending', 'project_not_started'] });
  const first = view.request;
  assert.deepEqual([first.state, first.repository.full_name, first.requested_by.principal_id, first.summary.capability_ceiling, first.summary.labels], ['pending', 'fixture/project-103', requesterPrincipal, 'develop', ['kind/bug']]);
  assert.equal(view.application.receipts[0].detail.request_id, first.id);
  // The console names a GitHub requester by their login, not the internal username (#934).
  assert.equal(first.requested_by.github_login, 'user-42');
  // Super administrators see it in the console list and are told in their private chat; nobody else may list or decide.
  assert.deepEqual((await admin('/api/management/onboarding-requests')).value.requests.map(r => r.id), [first.id]);
  assert.equal((await requester('/api/management/onboarding-requests')).value.error, 'super_admin_required');
  assert.equal((await requester(`/api/management/onboarding-requests/${first.id}/approve`, 'POST', {})).value.error, 'super_admin_required');
  await told('oc_admin', 'fixture/project-103 申请启动');
  // The notice links to where it is handled (#934): 待处理 for super administrators.
  assert.match(JSON.stringify((await told('oc_admin', 'fixture/project-103 申请启动')).content), /https:\/\/console\.example\.test\/#\/inbox/);
  // Waiting is not a failure: the start cannot be retried while the request is open.
  assert.equal((await requester('/api/management/onboarding/103/items/start/retry', 'POST', {})).value.error, 'onboarding_item_not_failed');

  // Withdrawn by the requester: the start fails, and retrying it requests again, as one open request per repository.
  assert.equal((await other('/api/management/onboarding/103/request/withdraw', 'POST', {})).value.error, 'repository_admin_required');
  view = (await requester('/api/management/onboarding/103/request/withdraw', 'POST', {})).value;
  assert.deepEqual([view.request.state, receipts(view).start], ['withdrawn', ['failed', 'start_request_withdrawn']]);
  view = (await requester('/api/management/onboarding/103/items/start/retry', 'POST', {})).value;
  const second = view.request;
  assert.notEqual(second.id, first.id); assert.equal(second.state, 'pending');
  assert.equal(h.store.get("SELECT count(*) AS n FROM onboarding_requests WHERE repository_id='103' AND state='pending'").n, 1);

  // Rejected: a reason is required, and the requester is told it.
  assert.equal((await admin(`/api/management/onboarding-requests/${second.id}/reject`, 'POST', { reason: ' ' })).value.error, 'rejection_reason_required');
  const rejected = (await admin(`/api/management/onboarding-requests/${second.id}/reject`, 'POST', { reason: '先在组织里确认谁来维护。' })).value.request;
  assert.deepEqual([rejected.state, rejected.reason, rejected.decided_by], ['rejected', '先在组织里确认谁来维护。', superAdmin]);
  view = (await requester('/api/management/onboarding/103')).value;
  assert.deepEqual([receipts(view).start, view.application.receipts[0].detail.reason], [['failed', 'start_rejected'], '先在组织里确认谁来维护。']);
  await told('oc_bob', '先在组织里确认谁来维护。');
  // The requester's notice links to the repository's onboarding page.
  assert.match(JSON.stringify((await told('oc_bob', '先在组织里确认谁来维护。')).content), /https:\/\/console\.example\.test\/#\/onboarding\/103/);
  assert.equal((await admin(`/api/management/onboarding-requests/${second.id}/approve`, 'POST', {})).value.error, 'onboarding_request_closed');
  assert.equal(h.store.get("SELECT 1 FROM repositories WHERE id='103'"), undefined);

  // Requested again and approved at a lower level, trusting the organization: the super administrator starts the project, the
  // plan's level item is left to that decision, and the other items are applied as the requester.
  view = (await requester('/api/management/onboarding/103/items/start/retry', 'POST', {})).value;
  const approved = (await admin(`/api/management/onboarding-requests/${view.request.id}/approve`, 'POST', { capability_ceiling: 'comment', trust_organization: true })).value.request;
  assert.deepEqual([approved.state, approved.decision.capability_ceiling, approved.decision.trust_organization], ['approved', 'comment', true]);
  view = (await requester('/api/management/onboarding/103')).value;
  assert.deepEqual(receipts(view), { start: ['succeeded', null], capability_ceiling: ['skipped', 'decided_by_approval'], test_command: ['succeeded', null],
    conventions: ['succeeded', null], labels: ['succeeded', null] }, JSON.stringify(view.application.receipts, null, 1));
  const executed = Object.fromEntries(view.application.receipts.map(r => [r.item, r.executed_by]));
  assert.deepEqual([executed.start, executed.test_command, executed.conventions, executed.labels], [superAdmin, requesterPrincipal, requesterPrincipal, requesterPrincipal]);
  assert.deepEqual([projectCeiling(h.store, '103'), h.store.get("SELECT test_command FROM policies WHERE repository_id='103'").test_command], ['comment', 'npm test']);
  assert.ok(h.store.get("SELECT 1 FROM trusted_organizations WHERE owner_id='10'"));
  await told('oc_bob', 'fixture/project-103 的启动申请已同意');

  // A trusted organization's repository needs no request; an open request lapses when its repository leaves the installation.
  assert.equal((await admin('/api/trusted-organizations/10', 'DELETE', {})).status, 200);
  view = await confirm('104');
  assert.equal(view.request.state, 'pending');
  h.store.run("UPDATE installed_repositories SET installed=0 WHERE repository_id='104'");
  assert.deepEqual((await admin('/api/management/onboarding-requests?state=all')).value.requests.map(r => [r.repository.id, r.state]), [['104', 'lapsed'], ['103', 'approved'], ['103', 'rejected'], ['103', 'withdrawn']]);
  assert.equal(h.store.get("SELECT error FROM onboarding_receipts r JOIN onboarding_applications a ON a.id=r.application_id WHERE a.repository_id='104' AND r.item='start'").error, 'start_request_lapsed');
  assert.ok(channels);
});
