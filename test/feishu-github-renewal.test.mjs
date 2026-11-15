// People who use the bot only through Feishu keep their GitHub-derived authority without signing in to the console (#846).
// GitHub, Feishu and the model are local protocol fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { githubChannelFixture as fixture, post, finished, until, inGroup, boundGroup, privateChat, repositoryAssistant, scriptedModel } from './channel-fixture.mjs';
import { GitHubRefresh } from '../dist/identity/github-refresh.js';
import { listEffectiveScopes, resolvePrincipalActor } from '../dist/identity/authorization.js';

const say = (res, content) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const usable = (h, p) => listEffectiveScopes(h.store, p).filter(g => g.source === 'github_derived' && g.state === 'active');
// No check succeeded for 31 minutes: the stored proof and the grants it gave have lapsed, as a day after signing out.
const lapse = (h, p) => {
  h.store.run("UPDATE external_identities SET verified_at=? WHERE principal_id=? AND provider='github'", Date.now() - 31 * 60_000, p);
  h.store.run("UPDATE scoped_grants SET expires_at=? WHERE principal_id=? AND source='github_derived'", Date.now() - 60_000, p);
};

test('a private chat renews a lapsed proof once and keeps working without a console session', async t => {
  const f = await fixture(t), p = await f.person(50, 'feishu-admin', 'ou_feishu_admin');
  lapse(f.h, p); assert.deepEqual(usable(f.h, p), []);
  f.modelState.respond = async (_body, res) => say(res, '你可以管理 agent-test-zone/admin-fixture-101。');
  const before = f.reads(50), row = await f.privately('ou_feishu_admin', '我能管理哪些项目？');
  assert.equal(row.state, 'completed', row.error);
  await f.sent('你可以管理 agent-test-zone/admin-fixture-101。');
  assert.equal(f.reads(50) - before, 1, 'one check before the turn');
  assert.ok(usable(f.h, p).length > 0);
  assert.ok(!JSON.stringify(f.wire.sent).includes('没有可访问的项目'));
  // Proved again: the next message sends nothing to GitHub.
  const again = await f.privately('ou_feishu_admin', '再看一下'); assert.equal(again.state, 'completed', again.error);
  assert.equal(f.reads(50) - before, 1);

  // A chat timer of another such person renews the same way before it runs.
  const owner = await f.person(51, 'timer-owner', 'ou_timer_owner'), chat = await privateChat(f, 'ou_timer_owner', owner, 'oc_timer_owner');
  const actor = resolvePrincipalActor(f.h.store, owner, null);
  const timer = f.service.schedules.create(actor, chat.id, { name: '巡检', prompt: '汇总可访问的项目。', timezone: 'Asia/Shanghai', cron: '0 9 * * *' }).schedule;
  lapse(f.h, owner); scriptedModel(f, ['巡检完成：可以访问 1 个项目。']);
  const timerReads = f.reads(51); f.service.schedules.runNow(actor, timer.id, {});
  const run = await until(() => f.h.store.get('SELECT * FROM channel_schedule_runs WHERE schedule_id=?', timer.id), r => r && r.state !== 'running');
  assert.equal(run.state, 'completed', run.error); assert.equal(f.reads(51) - timerReads, 1);
  await f.sent('巡检完成：可以访问 1 个项目。');
});

test('a revoked GitHub authorization tells the private chat to sign in again; a permission removed on GitHub says so after the next round', async t => {
  const f = await fixture(t), revoked = await f.person(52, 'revoked-user', 'ou_revoked'), removed = await f.person(53, 'removed-user', 'ou_removed');
  // GitHub refuses the stored authorization (the person revoked it there): the check needs a new sign-in.
  lapse(f.h, revoked); f.github.state.failure = 401;
  const models = f.requests.length, row = await f.privately('ou_revoked', '我能管理哪些项目？');
  assert.equal(row.state, 'completed', row.error);
  await f.sent('请登录控制台并用 GitHub 重新登录');
  assert.ok(!JSON.stringify(f.wire.sent).includes('没有可访问的项目')); assert.equal(f.requests.length, models, 'no model call');
  // GitHub takes the admin permission away: the background round revokes the grants, and the reply says why.
  f.github.state.failure = 0; Object.assign(f.github.state, { owner: false, permission: 'none' });
  f.h.store.run("UPDATE external_identities SET verified_at=1 WHERE principal_id=? AND provider='github'", removed);
  await new GitHubRefresh(f.h.store, f.identity, { stagger: 0 }).run();
  assert.deepEqual(usable(f.h, removed), []);
  const sent = f.reads(53), denied = await f.privately('ou_removed', '我能管理哪些项目？');
  assert.equal(denied.state, 'completed', denied.error);
  await f.sent('GitHub 的最新核验显示，你在已接入的仓库上没有可用的权限');
  assert.equal(f.reads(53), sent, 'proved by the round, so the message does not check again');
});

test('a group whose grantor has no console session is not paused, and a grantor GitHub no longer accepts is named in the group', async t => {
  const f = await fixture(t); await repositoryAssistant(f);
  const grantor = await f.person(54, 'group-grantor', 'ou_group_grantor'), stale = await f.person(55, 'stale-grantor', 'ou_stale_grantor');
  const chat = await boundGroup(f, ['101']);
  const grantedBy = principal => f.h.store.run("UPDATE scoped_grants SET grantor_id=? WHERE policy='channel_service_binding'", principal);
  // The fake GitHub answers membership and permission reads for the user it was last pointed at.
  grantedBy(grantor); lapse(f.h, grantor); Object.assign(f.github.state, { id: 54, login: 'group-grantor' });
  scriptedModel(f, [['list_projects', {}], done => '本群可用：' + done[0].projects.map(p => p.repository).join('、')]);
  const before = f.reads(54);
  const answered = await finished(f.h, (await post(f.h, f.id, inGroup('本群能看哪些仓库？'))).value.operation_id);
  assert.equal(answered.state, 'completed', answered.error);
  await f.sent('本群可用：agent-test-zone/admin-fixture-101');
  assert.equal(f.reads(54) - before, 1);
  assert.equal(f.h.store.get('SELECT state FROM channel_service_turns WHERE chat_id=? ORDER BY created_at DESC LIMIT 1', chat.id).state, 'completed');
  // The other grantor's authorization was revoked on GitHub: the group hears who has to sign in, without a model call.
  grantedBy(stale); lapse(f.h, stale); f.github.state.failure = 401;
  const requests = f.requests.length;
  const paused = await finished(f.h, (await post(f.h, f.id, inGroup('本群能看哪些仓库？'))).value.operation_id);
  assert.equal(paused.state, 'completed', paused.error);
  await f.sent('agent-test-zone/admin-fixture-101 暂停使用：本群的授权人 stale-grantor 的 GitHub 授权已失效。请 stale-grantor 登录控制台并用 GitHub 重新登录');
  assert.equal(f.requests.length, requests);
});

test('a group binding disabled while its grantor is checked gets no paused-scope notice (#854 review)', async t => {
  const f = await fixture(t); await repositoryAssistant(f);
  const grantor = await f.person(56, 'held-grantor', 'ou_held_grantor'), chat = await boundGroup(f, ['101']);
  f.h.store.run("UPDATE scoped_grants SET grantor_id=? WHERE policy='channel_service_binding'", grantor); lapse(f.h, grantor);
  // GitHub holds the grantor's check, then refuses the authorization; the binding is disabled meanwhile.
  let release, reached; const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  f.github.state.apiGate = async path => { if (path === '/user') { reached(); await held; } };
  const requests = f.requests.length, receipt = await post(f.h, f.id, inGroup('本群能看哪些仓库？'));
  await arrived;
  const revision = f.h.store.get('SELECT revision FROM channel_service_bindings WHERE chat_id=?', chat.id).revision;
  const disabled = await f.admin('/api/channels/chats/' + chat.id + '/service-binding', 'PUT', { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: ['101'] }, enabled: false, expected_revision: revision });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.value));
  f.github.state.failure = 401; f.github.state.apiGate = undefined; release();
  const row = await finished(f.h, receipt.value.operation_id);
  assert.equal(row.state, 'failed'); assert.equal(row.error, 'conversation_source_changed');
  await f.sent('本群助手的配置或来源消息刚刚变化');
  assert.ok(!JSON.stringify(f.wire.sent).includes('暂停使用'), 'no notice explaining a binding that is gone');
  assert.equal(f.requests.length, requests, 'no model call');
});
