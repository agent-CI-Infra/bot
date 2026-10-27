import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { selectedModel } from '../dist/agent/model.js';
import { beginModelRequest, finishModelRequest } from '../dist/metrics/accounting.js';
import { loadConsole } from './console-page.mjs';

const pricing = { currency: 'USD', input_per_million: 2, output_per_million: 10, cache_per_million: 0.2 };
async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const password = testPassword(), member = h.client();
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] });
  await member('/api/auth/login', 'POST', { username: 'member', password });
  const create = async (client, repository_id) => {
    const key = testPassword(), result = await client('/api/models', 'POST', { repository_id, api_url: 'https://model.invalid/v1', api_key: key, model_name: 'fixture', pricing });
    assert.equal(result.status, 201); return { ...result.value.model, key };
  };
  return { h, admin, member, create };
}

test('deleting a selected project model clears references and its sealed key, preserving requests and running work', async t => {
  const { h, admin, member, create } = await fixture(t), model = await create(member, '101');
  assert.equal(h.store.get('PRAGMA foreign_keys').foreign_keys, 1);
  await member('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  // A leftover sharing row must also be removed, although a project model cannot be selected by another project.
  h.store.run('INSERT INTO model_projects VALUES(?,?)', model.id, '101');
  const unavailable = await admin('/api/repositories/202/policy', 'PATCH', { model_id: model.id });
  assert.deepEqual([unavailable.status, unavailable.value.error], [400, 'model_not_available']);
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,claim_token) VALUES('running','101','review.pr','running','fixture','claim')");
  const task = h.store.get("SELECT * FROM tasks WHERE id='running'"), held = selectedModel(h.store, '101');
  const request = beginModelRequest(h.store, task, 'in-flight', held), before = h.store.get('SELECT * FROM model_requests WHERE id=?', request);
  const ciphertext = h.store.get('SELECT api_key FROM models WHERE id=?', model.id).api_key;
  const detail = await member(`/api/models/${model.id}`);
  assert.deepEqual(detail.value.model.used_by, [{ repository_id: '101', full_name: 'fixture/project-101' }]);
  const removed = await member(`/api/models/${model.id}`, 'DELETE', {});
  assert.deepEqual(removed.value, { ok: true, cleared_repository_ids: ['101'] }); assert.equal(removed.status, 200);
  assert.deepEqual((await member(`/api/models/${model.id}`)).value, { error: 'model_not_found' });
  assert.equal((await admin(`/api/models/${model.id}`)).status, 404);
  assert.equal((await member('/api/repositories/101/policy')).value.policy.model_id, null);
  for (const table of ['model_pricing', 'model_projects']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE model_id=?`, model.id).n, 0);
  assert.deepEqual(h.store.get('SELECT * FROM model_requests WHERE id=?', request), before);
  assert.deepEqual(h.store.get("SELECT * FROM tasks WHERE id='running'"), task);
  assert.equal(held.key, model.key); // A request that already took the key can still finish and record its cost.
  finishModelRequest(h.store, request, { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } }, 200);
  const recorded = h.store.get('SELECT * FROM model_requests WHERE id=?', request);
  assert.equal(recorded.model_name, 'fixture'); assert.equal(recorded.input_per_million, pricing.input_per_million); assert.equal(recorded.state, 'received');
  assert.ok(recorded.cost > 0);
  assert.throws(() => selectedModel(h.store, '101'), { code: 'model_not_configured', state: 'waiting_configuration' });
  const audit = (await admin('/api/audit')).value.audit;
  assert.equal(audit.filter(row => row.action === 'model.deleted' && row.resource_id === model.id && row.repository_id === '101').length, 1);
  for (const secret of [model.key, ciphertext]) assert.ok(!JSON.stringify([detail.value, removed.value, audit, recorded, h.store.all('SELECT * FROM task_logs')]).includes(secret));
});

test('only a super administrator deletes a shared model and clears every selected project, with visibility protected', async t => {
  const { h, admin, member, create } = await fixture(t), shared = await create(admin, null), outside = await create(admin, '202');
  const missing = async (client, id) => {
    const result = await client(`/api/models/${id}`, 'DELETE', {});
    assert.equal(result.status, 404); assert.deepEqual(result.value, { error: 'model_not_found' });
  };
  await missing(member, shared.id); await missing(member, outside.id); await missing(member, 'unknown'); await missing(admin, 'unknown');
  await admin(`/api/models/${shared.id}/projects`, 'PUT', { repository_ids: ['101', '202'] });
  for (const id of ['101', '202']) await admin(`/api/repositories/${id}/policy`, 'PATCH', { model_id: shared.id });
  assert.ok(!('used_by' in (await member(`/api/models/${shared.id}`)).value.model));
  assert.deepEqual((await admin(`/api/models/${shared.id}`)).value.model.used_by, [
    { repository_id: '101', full_name: 'fixture/project-101' }, { repository_id: '202', full_name: 'fixture/project-202' }]);
  const snapshot = () => ['models', 'policies', 'model_pricing', 'model_projects', 'audit'].map(table => h.store.all(`SELECT * FROM ${table}`));
  const before = snapshot(), denied = await member(`/api/models/${shared.id}`, 'DELETE', {});
  assert.equal(denied.status, 403); assert.deepEqual(denied.value, { error: 'super_admin_required' }); assert.deepEqual(snapshot(), before);
  const removed = await admin(`/api/models/${shared.id}`, 'DELETE', {});
  assert.equal(removed.status, 200); assert.deepEqual(removed.value, { ok: true, cleared_repository_ids: ['101', '202'] });
  assert.ok(h.store.all('SELECT model_id FROM policies').every(row => row.model_id === null));
  assert.equal((await admin(`/api/models/${shared.id}`)).status, 404);
  for (const table of ['model_pricing', 'model_projects']) assert.equal(h.store.get(`SELECT count(*) n FROM ${table} WHERE model_id=?`, shared.id).n, 0);
  assert.ok(h.store.get('SELECT 1 FROM models WHERE id=?', outside.id));
});

test('deletion rolls every change back when its audit fails, and an unused model needs no version', async t => {
  const { h, admin, member, create } = await fixture(t), model = await create(member, '101');
  await member('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  h.store.run('INSERT INTO model_projects VALUES(?,?)', model.id, '101');
  const snapshot = () => ['models', 'policies', 'model_pricing', 'model_projects', 'audit'].map(table => h.store.all(`SELECT * FROM ${table}`)), before = snapshot();
  h.store.db.exec("CREATE TRIGGER fail_model_audit BEFORE INSERT ON audit WHEN NEW.action='model.deleted' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  const refused = await member(`/api/models/${model.id}`, 'DELETE', {});
  assert.deepEqual([refused.status, refused.value], [503, { error: 'service_unavailable' }]); assert.deepEqual(snapshot(), before);
  h.store.db.exec('DROP TRIGGER fail_model_audit');
  await member('/api/repositories/101/policy', 'PATCH', { model_id: null });
  assert.deepEqual((await member(`/api/models/${model.id}`)).value.model.used_by, []);
  assert.deepEqual((await member(`/api/models/${model.id}`, 'DELETE', {})).value, { ok: true, cleared_repository_ids: [] });
  assert.equal((await admin(`/api/models/${model.id}`, 'DELETE', {})).status, 404);
});

function consoleFixture(respond, shared = false) {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], respond);
  page.run(`me = { role: 'super_admin', csrf_token: 'csrf' }; current = { id: '101', section: 'model' };
    var reloads = 0; reloadProject = async () => { reloads++; };
    var model = { id: 'm', repository_id: ${shared ? 'null' : "'101'"}, model_name: 'fixture', key_configured: true };
    var outcome = probeResult(); var actions = modelActions(model, outcome);`);
  const view = page.run('confirmView');
  return { page, view, click: () => page.run('actions').querySelectorAll('button').find(node => node.textContent === '删除').listeners.click[0](),
    cancel: () => view.querySelector('.confirm-actions button').listeners.click[0](),
    submit: () => view.querySelector('form').listeners.submit[0]({ preventDefault() {} }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('model deletion previews all selected repositories, preserves a refusal across status refresh and retries in place', async () => {
  let answer = [503, { error: 'service_unavailable' }];
  const { page, view, click, cancel, submit } = consoleFixture((method, path, body) => {
    assert.equal(path, '/api/models/m');
    if (method === 'GET') return [200, { model: { model_name: 'fixture', repository_id: null, used_by: [
      { repository_id: '101', full_name: 'fixture/one' }, { repository_id: '202', full_name: 'fixture/two' }] } }];
    assert.equal(method, 'DELETE'); assert.deepEqual(body, {}); return answer;
  }, true);
  const opening = click(); await settle();
  assert.deepEqual(view.querySelectorAll('h2').map(node => node.textContent), ['删除模型 fixture？']);
  assert.deepEqual(view.querySelectorAll('li').map(node => node.textContent), ['fixture/one', 'fixture/two']);
  const paragraphs = view.querySelectorAll('p').map(node => node.textContent).join('\n');
  assert.match(paragraphs, /销毁封存的 API Key/); assert.match(paragraphs, /不会删除 GitHub/); assert.match(paragraphs, /成本记录保留/);
  assert.match(paragraphs, /不使用模型.*配置待补/); assert.match(paragraphs, /所有项目都不能再选/);
  assert.equal(view.querySelectorAll('.confirm-actions button')[1].className, 'danger');
  cancel(); await opening; assert.deepEqual(page.requests, ['GET /api/models/m']);
  const retrying = click(); await settle(); await submit();
  const failure = view.querySelector('.confirm-status'); assert.equal(failure.textContent, '503 · service_unavailable'); assert.equal(view.open, true);
  // The existing five-second status refresher exits on the model page and cannot erase the modal's error.
  await page.run('refreshProjectStatus(renderToken)');
  assert.equal(view.querySelector('.confirm-status'), failure); assert.equal(failure.textContent, '503 · service_unavailable');
  assert.equal(page.run('reloads'), 0);
  answer = [200, { ok: true, cleared_repository_ids: ['101', '202'] }]; await submit(); await retrying;
  assert.equal(view.open, false); assert.equal(page.run('reloads'), 1);
});

test('unused models say nobody selected them, and project administrators only get deletion on their own models', async () => {
  const { page, view, click, cancel } = consoleFixture(() => [200, { model: { model_name: 'fixture', repository_id: '101', used_by: [] } }]);
  const opening = click(); await settle(); assert.ok(view.querySelectorAll('p').some(node => node.textContent === '当前没有项目选用它。'));
  cancel(); await opening;
  page.run("me.role = 'project_admin';");
  assert.ok(page.run('modelActions(model, outcome)').querySelectorAll('button').some(node => node.textContent === '删除'));
  assert.equal(page.run('modelActions({ ...model, repository_id: null }, outcome)').childElementCount, 0);
  assert.equal(page.run("modelActions({ ...model, repository_id: '202' }, outcome)").childElementCount, 0);
  // Revoking a key does not remove the deletion action.
  assert.ok(page.run('modelActions({ ...model, key_configured: false }, outcome)').querySelectorAll('button').some(node => node.textContent === '删除'));
});

test('a model detail failure stays on the row through a status refresh without sending DELETE', async () => {
  const { page, view, click } = consoleFixture(() => [404, { error: 'model_not_found' }]);
  await click(); assert.equal(view.open, undefined);
  const failure = page.run('outcome').querySelector('p'); assert.equal(failure.textContent, '404 · model_not_found');
  await page.run('refreshProjectStatus(renderToken)');
  assert.equal(page.run('outcome').querySelector('p'), failure); assert.deepEqual(page.requests, ['GET /api/models/m']); assert.equal(page.run('reloads'), 0);
});
