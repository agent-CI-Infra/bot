import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';

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
