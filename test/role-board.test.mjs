import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #228 contract A+B: the project policy carries per-role limits, and a read-only role board projects them.
// Nothing here enforces anything yet: admission is the second pull request.
async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  return { h, admin };
}
const board = (client, id = '101') => client('/api/repositories/' + id + '/role-board');
const policy = (client, body, id = '101') => client('/api/repositories/' + id + '/policy', 'PATCH', body);

test('角色看板在未配置限额时返回 unset，不编造默认上限', async t => {
  const { admin } = await fixture(t);
  const read = await board(admin);
  assert.equal(read.status, 200);
  const view = read.value;
  assert.equal(view.enforced, false);
  assert.equal(view.project.task_concurrency, view.project.task_concurrency_default);
  assert.ok(Array.isArray(view.roles) && view.roles.length > 0);
  for (const role of view.roles) { assert.equal(role.limit, null); assert.equal(role.limit_source, 'unset'); }
  // A project with no required_stages cannot say which role a queued task waits for; it says so instead of guessing.
  assert.deepEqual(view.unsupported, ['role_queue']);
  for (const role of view.roles) assert.deepEqual(role.ready, []);
  const detail = await admin('/api/repositories/101');
  assert.deepEqual(detail.value.policy.role_concurrency, {});
  assert.equal(detail.value.role_concurrency_default, null);
});

test('角色限额写入项目策略并按项目策略读回', async t => {
  const { h, admin } = await fixture(t);
  const view = (await board(admin)).value, dev = view.roles.find(role => role.role === 'dev');
  assert.ok(dev, 'the default configuration defines a dev role');
  const saved = await policy(admin, { role_concurrency: { dev: 3 } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.policy.role_concurrency, { dev: 3 });
  const detail = await admin('/api/repositories/101');
  assert.deepEqual(detail.value.policy.role_concurrency, { dev: 3 });
  const after = (await board(admin)).value, configured = after.roles.find(role => role.role === 'dev');
  assert.equal(configured.limit, 3); assert.equal(configured.limit_source, 'policy');
  for (const role of after.roles.filter(role => role.role !== 'dev')) { assert.equal(role.limit, null); assert.equal(role.limit_source, 'unset'); }
  // null means "explicitly unset", and it is persisted as unset rather than as a number.
  assert.deepEqual((await policy(admin, { role_concurrency: { dev: null } })).value.policy.role_concurrency, { dev: null });
  const cleared = (await board(admin)).value.roles.find(role => role.role === 'dev');
  assert.equal(cleared.limit, null); assert.equal(cleared.limit_source, 'unset');
  // Survives a restart: the limits live in the policies table, not in memory.
  await h.stop(); await h.start();
  assert.deepEqual((await admin('/api/repositories/101')).value.policy.role_concurrency, { dev: null });
});

test('角色限额拒绝未知角色、越界数字与非对象', async t => {
  const { admin } = await fixture(t);
  // Values reach the policy validator and are named there; a body that is not an object at all is refused earlier,
  // by the console's shared command schema, which is why it reports its own code.
  for (const [body, code] of [[{ role_concurrency: { unknown_role: 1 } }, 'invalid_role_concurrency'],
    [{ role_concurrency: { dev: 0 } }, 'invalid_role_concurrency'], [{ role_concurrency: { dev: 33 } }, 'invalid_role_concurrency'],
    [{ role_concurrency: { dev: '2' } }, 'invalid_role_concurrency'], [{ role_concurrency: { dev: 2.5 } }, 'invalid_role_concurrency'],
    [{ role_concurrency: [] }, 'invalid_management_arguments'], [{ role_concurrency: 'dev' }, 'invalid_management_arguments']]) {
    const rejected = await policy(admin, body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal(rejected.value.error, code, JSON.stringify(body));
  }
  // A rejected write leaves the stored limits untouched.
  assert.deepEqual((await admin('/api/repositories/101')).value.policy.role_concurrency, {});
  // Values at the bounds are accepted, because the project concurrency bounds are reused.
  assert.equal((await policy(admin, { role_concurrency: { dev: 1 } })).status, 200);
  assert.equal((await policy(admin, { role_concurrency: { dev: 32 } })).status, 200);
  // Keys that are not role ids of this project are refused for other projects' roles too.
  assert.equal((await policy(admin, { role_concurrency: { constructor: 1 } })).status, 400);
});

test('角色看板恒为只展示不拦截，同一配置版本下两次读取计数一致', async t => {
  const { admin } = await fixture(t);
  await policy(admin, { role_concurrency: { dev: 2 } });
  const first = (await board(admin)).value, second = (await board(admin)).value;
  assert.equal(first.enforced, false);
  assert.equal(second.enforced, false);
  assert.equal(first.version, second.version);
  const shape = view => view.roles.map(role => [role.role, role.limit, role.limit_source, role.running.length, role.ready.length]);
  assert.deepEqual(shape(first), shape(second));
  assert.deepEqual(first.unsupported, second.unsupported);
});

test('角色看板与其他项目读取共享同一套项目权限', async t => {
  const { h, admin } = await fixture(t);
  const password = testPassword();
  await admin('/api/users', 'POST', { username: 'outsider', password, repository_ids: ['202'] });
  const outsider = h.client();
  assert.equal((await outsider('/api/auth/login', 'POST', { username: 'outsider', password })).status, 200);
  assert.equal((await board(outsider)).status, 403);
  assert.equal((await policy(outsider, { role_concurrency: { dev: 2 } })).status, 403);
});

test('阶段可解析但归属不唯一时，队列同样标为 unsupported 而不是挑一个角色', async t => {
  const { h, admin } = await fixture(t);
  // A stage policy that resolves to exactly one stage for the queued task, but that stage names no role_ids: every
  // enabled observer is eligible, so the queue cannot be attributed to one role. This is the second way into
  // unsupported:["role_queue"] — the first is "no usable stage policy at all" (covered above).
  const observer = { depends_on: [], delivery_types: ['code'], required: true, retry: { max_attempts: 2 }, budget: { max_tool_calls: 8 },
    role_constraints: { kinds: ['observer'], capabilities: ['raw_evidence', 'fixed_candidate_read', 'fresh_context'], independent: true },
    completion: { evidence_types: ['role_result'], min_evidence: 1, no_findings: true } };
  const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: true, roles: [], required_stages: [{ stage_id: 'review', ...observer }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at) VALUES('q1','101','review.pr','queued','pr',7,'2026-11-10T00:00:00Z')");
  const ambiguous = (await board(admin)).value;
  assert.deepEqual(ambiguous.unsupported, ['role_queue']);
  for (const role of ambiguous.roles) assert.deepEqual(role.ready, [], 'an unattributable task must not be assigned a role');
  // Naming one role turns the very same queue into a real attribution: the difference is uniqueness, not the stage.
  const one = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: saved.value.configuration.revision, enabled: true, roles: [],
    required_stages: [{ stage_id: 'review', ...observer, role_constraints: { ...observer.role_constraints, role_ids: ['reviewer'] } }] });
  assert.equal(one.status, 200, JSON.stringify(one.value));
  const resolved = (await board(admin)).value;
  assert.deepEqual(resolved.unsupported, []);
  assert.deepEqual(resolved.roles.find(role => role.role === 'reviewer').ready.map(entry => entry.task_id), ['q1']);
  // Exactly one role sees the task, so no other role can claim the same capacity.
  assert.equal(resolved.roles.filter(role => role.ready.length).length, 1);
});

test('角色限额是增量 PATCH：只改给出的键，其余上限保持不变', async t => {
  const { admin } = await fixture(t);
  assert.equal((await policy(admin, { role_concurrency: { dev: 2 } })).status, 200);
  // A second PATCH naming another role must not wipe the first one: the body is a delta, not the whole map.
  assert.equal((await policy(admin, { role_concurrency: { reviewer: 4 } })).status, 200);
  assert.deepEqual((await admin('/api/repositories/101')).value.policy.role_concurrency, { dev: 2, reviewer: 4 });
  // `null` unsets one key and leaves the other alone.
  assert.equal((await policy(admin, { role_concurrency: { dev: null } })).status, 200);
  assert.deepEqual((await admin('/api/repositories/101')).value.policy.role_concurrency, { dev: null, reviewer: 4 });
  const view = (await board(admin)).value;
  assert.equal(view.roles.find(role => role.role === 'dev').limit, null);
  assert.equal(view.roles.find(role => role.role === 'reviewer').limit, 4);
});

test('角色看板只读取当前角色定义内的键，删除后重建的角色不继承旧上限', async t => {
  // This one needs the role configuration endpoint, which is served by the engine; the rest of this file only needs the
  // control plane, so it uses the plain fixture.
  const h = await harness(t, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  // A key nobody defined is ignored on read instead of coming back when a role with that id is created later.
  h.store.run("UPDATE policies SET role_concurrency='{\"ghost\":9}' WHERE repository_id='101'");
  assert.deepEqual((await admin('/api/repositories/101')).value.policy.role_concurrency, {});
  assert.equal((await board(admin)).value.roles.every(role => role.limit === null), true);
  // A project may define a role called `constructor`; it is an ordinary name and its limit must work.
  const config = (await admin('/api/repositories/101/roles')).value, reviewer = config.configuration.roles.find(role => role.role_id === 'reviewer');
  // The definition input takes the editable fields only; `revision` and `kind` are server-owned.
  const { revision, kind, ...editable } = reviewer;
  const custom = { ...editable, role_id: 'constructor', name: 'constructor' };
  const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: config.revision, enabled: true, roles: [custom], required_stages: [] });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const written = await policy(admin, { role_concurrency: { constructor: 1 } });
  assert.equal(written.status, 200, JSON.stringify(written.value));
  assert.deepEqual((await admin('/api/repositories/101')).value.policy.role_concurrency, { constructor: 1 });
});

test('角色看板封顶扫描 500 个排队任务，截断时 ready_more 为 true', async t => {
  const { h, admin } = await fixture(t);
  // One observer stage naming exactly one role, so every queued task is attributable and the ready lists fill up.
  const stage = { stage_id: 'review', depends_on: [], delivery_types: ['code'], required: true, retry: { max_attempts: 2 }, budget: { max_tool_calls: 8 },
    role_constraints: { kinds: ['observer'], role_ids: ['reviewer'], capabilities: ['raw_evidence', 'fixed_candidate_read', 'fresh_context'], independent: true },
    completion: { evidence_types: ['role_result'], min_evidence: 1, no_findings: true } };
  assert.equal((await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, enabled: true, roles: [], required_stages: [stage] })).status, 200);
  const insert = h.store.db.prepare("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at) VALUES(?,?,?,?,?,?,?)");
  h.store.transaction(() => { for (let index = 1; index <= 501; index++) insert.run('bulk-' + String(index).padStart(3, '0'), '101', 'review.pr', 'queued', 'pr', index, '2026-11-10T00:00:00Z'); });
  const view = (await board(admin)).value;
  assert.equal(view.ready_more, true);
  assert.equal(view.roles.find(role => role.role === 'reviewer').ready.length, 50);
  // The cap is on the scan, not on the page: a larger page still never reads beyond the bounded window.
  const more = await admin('/api/repositories/101/role-board?ready_limit=100');
  assert.equal(more.status, 200);
  assert.equal(more.value.roles.find(role => role.role === 'reviewer').ready.length, 100);
  assert.equal(more.value.ready_more, true);
});

test('角色看板不返回 blocked：准入落地前没有任何被拦截的数据可报', async t => {
  const { admin } = await fixture(t);
  // Nothing in this slice blocks a run, so a `blocked` object could only carry a hard-coded zero. A reader would take
  // that for a measurement, which is worse than the field being absent until admission lands.
  for (const role of (await board(admin)).value.roles) assert.equal(Object.hasOwn(role, 'blocked'), false);
});
