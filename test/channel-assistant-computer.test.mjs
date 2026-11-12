import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { channelFixture, inGroup, post, until, boundGroup } from './channel-fixture.mjs';
import { assistantManager } from './assistant-computer-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { ownerId } from '../dist/service-roles/assistant-computers.js';

// Group assistants on their group's own computer (#457). Model and Feishu traffic go to local fixtures; the computers are
// this checkout's manager code with fake containers whose commands run on the host with the group's HOME.
const reply = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const call = (res, name, args) => reply(res, { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const observations = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const done = (f, receipt) => until(() => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?', receipt.value.operation_id), r => r && ['completed', 'failed'].includes(r.state));

async function fixture(t) {
  const assistant = await assistantManager(t);
  const manager = { call: (method, path, input, timeout) => path.startsWith('/v1/assistant-computers') ? assistant.manager.call(method, path, input, timeout)
    : Promise.resolve(method === 'GET' ? { generation: 1, state: 'ready' } : { ok: true, result: {} }) };
  const f = await channelFixture(t, store => ({ engine: new TaskEngine(store, manager), assistantHomes: assistant.homes }));
  const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant');
  assert.equal((await f.admin('/api/service-roles/repository-assistant', 'PATCH', { expected_revision: role.revision, model_id: f.assistantModel.id, permissions: { computer: 'allow' } })).status, 200);
  const service = f.service.management.service.assistants;
  // The first sweep after the start reconciles with the manager; the computers of this test come after it.
  await until(() => service.reconciled);
  return { ...f, assistant, service };
}
// Each turn runs the steps given for its group, one tool call per model request, then answers.
function script(f, steps) {
  f.modelState.respond = async (body, res) => {
    const chat = JSON.parse(body.messages[1].content).conversation_id, seen = observations(body), plan = steps[chat] ?? [];
    if (seen.length < plan.length) return call(res, ...plan[seen.length]);
    reply(res, { role: 'assistant', content: 'done' });
  };
}
const ask = async (f, chat, text = '处理数据') => {
  const event = inGroup(text, 'ou_bob'); event.event.message.chat_id = chat;
  const row = await done(f, await post(f.h, f.id, event)); assert.equal(row.state, 'completed', row.error);
  return observations(f.requests.at(-1));
};

test('two groups on one role get separate computers and HOMEs; the next turn reuses the computer and member changes keep the HOME', async t => {
  const f = await fixture(t), a = await boundGroup(f, ['101', '102'], 'oc_group'), b = await boundGroup(f, ['101'], 'oc_group_2');
  const [ownerA, ownerB] = [a, b].map(chat => ownerId({ kind: 'group', subject: chat.id, tenant: chat.installation_tenant }));
  script(f, { [a.id]: [['write_file', { path: '~/report.md', content: 'group A data' }], ['run_command', { command: 'cat ~/report.md; echo scratch > /dev/null; echo tmp > note.txt' }]],
    [b.id]: [['read_file', { path: '~/report.md' }], ['run_command', { command: 'ls -A ~ | wc -l' }]] });
  let seen = await ask(f, 'oc_group');
  assert.deepEqual(seen.map(o => o.written ?? o.output), [true, 'group A data']);
  // The system prompt explains HOME and /tmp to the model.
  assert.match(f.requests.at(-1).messages[0].content, /HOME \(~\) persists across turns and is shared by everyone in this group/);
  seen = await ask(f, 'oc_group_2');
  assert.deepEqual([seen[0].error, seen[1].output.trim()], ['file_not_found', '0'], 'group B sees nothing of group A');
  assert.equal(readFileSync(join(f.assistant.homes, ownerA, 'home-1', 'report.md'), 'utf8'), 'group A data');
  assert.ok(!existsSync(join(f.assistant.homes, ownerB, 'home-1', 'report.md')));
  // Both turns ended: their computers wait idle, their processes were ended.
  assert.deepEqual([ownerA, ownerB].map(o => f.assistant.computers.leases.get(o)?.state), ['idle', 'idle']);
  assert.ok(f.assistant.docker.runs.filter(r => r.type === 'reap').length >= 2);
  const created = f.assistant.docker.created;
  script(f, { [a.id]: [['read_file', { path: 'note.txt' }]] });
  assert.equal((await ask(f, 'oc_group'))[0].content, 'tmp\n', 'the next turn reuses the computer and its working directory');
  assert.equal(f.assistant.docker.created, created);
  // A member joins: the fence changes, so the sweep removes the computer; the HOME stays the same generation.
  f.h.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', a.id);
  await f.service.sweep(); await Promise.all([...f.assistant.computers.removing.values()]);
  assert.ok(!f.assistant.computers.leases.has(ownerA) && f.assistant.computers.leases.has(ownerB));
  script(f, { [a.id]: [['read_file', { path: '~/report.md' }]] });
  assert.equal((await ask(f, 'oc_group'))[0].content, 'group A data');
  assert.equal(f.h.store.get('SELECT generation FROM assistant_homes WHERE owner=?', ownerA).generation, 1);
  // The binding drops repository 102: data from it may be in HOME, so a new generation starts and the old one is sealed.
  await boundGroup(f, ['101'], 'oc_group');
  assert.equal((await ask(f, 'oc_group'))[0].error, 'file_not_found');
  assert.equal(f.h.store.get('SELECT generation FROM assistant_homes WHERE owner=?', ownerA).generation, 2);
  assert.deepEqual(f.h.store.all('SELECT generation,reason FROM assistant_home_sealed WHERE owner=?', ownerA).map(r => ({ ...r })), [{ generation: 1, reason: 'scope_narrowed' }]);
  // Disabling the binding removes its computer at the next sweep.
  const binding = f.h.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', b.id);
  assert.equal((await f.admin('/api/channels/chats/' + b.id + '/service-binding', 'PUT', { enabled: false, expected_revision: binding.revision })).status, 200);
  await f.service.sweep(); await Promise.all([...f.assistant.computers.removing.values()]);
  assert.ok(!f.assistant.computers.leases.has(ownerB));
});

test('global settings and the console show and change assistant computers; clearing removes a HOME and its computer', async t => {
  const f = await fixture(t), a = await boundGroup(f, ['101'], 'oc_group'), owner = ownerId({ kind: 'group', subject: a.id, tenant: a.installation_tenant });
  const settings = (await f.admin('/api/settings')).value.settings.assistant_computers;
  assert.deepEqual(settings.computers.settings, { idle_minutes: 5, max_containers: 20, max_lifetime_minutes: 240, runtime: 'runc' });
  assert.deepEqual(settings.homes.settings, { home_limit_gb: 5, retention_days: 30, total_alert_gb: 50 });
  const saved = await f.admin('/api/settings', 'PATCH', { assistant_computers: { idle_minutes: 10, home_limit_gb: 8, retention_days: 7 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.deepEqual([saved.value.settings.assistant_computers.computers.settings.idle_minutes, saved.value.settings.assistant_computers.homes.settings.home_limit_gb], [10, 8]);
  for (const bad of [{ home_limit_gb: 0 }, { retention_days: 1.5 }, { idle_minutes: 0 }, { runtime: 'runsc' }, { other: 1 }]) {
    const refused = await f.admin('/api/settings', 'PATCH', { assistant_computers: bad });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  // A refused value saves nothing of the request.
  assert.equal((await f.admin('/api/settings', 'PATCH', { assistant_computers: { retention_days: 9, home_limit_gb: 0 } })).status, 400);
  assert.equal((await f.admin('/api/settings')).value.settings.assistant_computers.homes.settings.retention_days, 7);
  script(f, { [a.id]: [['run_command', { command: 'echo kept > ~/a.txt' }]] });
  await ask(f, 'oc_group');
  await until(() => f.h.store.get('SELECT measured_at FROM assistant_homes WHERE owner=?', owner)?.measured_at);
  const overview = (await f.admin('/api/assistant-computers')).value;
  const home = overview.homes.find(h => h.owner === owner);
  assert.deepEqual([home.kind, home.generation, home.files, home.read_only, home.computer], ['group', 1, 1, false, 'idle']);
  assert.ok(home.bytes > 0 && overview.totals.bytes >= home.bytes && overview.totals.alert === false && overview.computers.running === 1);
  // Project administrators cannot see or clear HOMEs.
  const member = await f.member('home-reader', { repository_ids: ['101'] });
  assert.equal((await member.client('/api/assistant-computers')).status, 403);
  assert.equal((await member.client('/api/assistant-computers/' + owner + '/clear', 'POST', {})).status, 403);
  assert.deepEqual((await f.admin('/api/assistant-computers/' + owner + '/clear', 'POST', {})).value, { owner, cleared: true });
  await Promise.all([...f.assistant.computers.removing.values()]);
  assert.ok(!existsSync(join(f.assistant.homes, owner, 'home-1', 'a.txt')) && !f.assistant.computers.leases.has(owner));
  assert.ok(f.h.store.get("SELECT 1 FROM audit WHERE action='assistant_computers.home_cleared' AND resource_id=?", owner));
  assert.equal((await f.admin('/api/assistant-computers/' + 'f'.repeat(32) + '/clear', 'POST', {})).status, 404);
});
