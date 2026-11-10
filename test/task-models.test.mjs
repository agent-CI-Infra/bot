import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { selectedModel } from '../dist/agent/model.js';

async function fixture(t) {
  const h = await harness(t), {admin} = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const password = testPassword();
  await admin('/api/users', 'POST', {username: 'member', password, repository_ids: ['101']});
  const member = h.client(); await member('/api/auth/login', 'POST', {username: 'member', password});
  const create = async (repo, name) => (await admin('/api/models', 'POST', {repository_id: repo, model_name: name, api_url: 'https://model.invalid/v1', api_key: testPassword()})).value.model;
  const defaultModel = await create('101', 'default'), review = await create('101', 'review'), other = await create('202', 'other'), shared = await create(null, 'shared');
  await admin('/api/repositories/101/policy', 'PATCH', {model_id: defaultModel.id});
  return {h, admin, member, defaultModel, review, other, shared};
}

test('task model overrides are exact, extensible and persisted, unspecified tasks use repository default', async t => {
  const {h, member, defaultModel, review} = await fixture(t);
  const map = {'review.pr': review.id, 'custom.scientific-evaluation': review.id};
  const saved = await member('/api/repositories/101/policy', 'PATCH', {task_models: map});
  assert.equal(saved.status, 200); assert.deepEqual(JSON.parse(saved.value.policy.task_models), map);
  for (const kind of Object.keys(map)) assert.equal(selectedModel(h.store, '101', kind).id, review.id);
  for (const kind of [undefined, 'review.issue', 'release.notes', 'development.issue']) assert.equal(selectedModel(h.store, '101', kind).id, defaultModel.id);
  await h.stop(); await h.start();
  assert.equal(selectedModel(h.store, '101', 'review.pr').id, review.id);
  assert.equal((await member('/api/repositories/101/policy', 'PATCH', {task_models: {}})).status, 200);
  assert.equal(selectedModel(h.store, '101', 'review.pr').id, defaultModel.id);
});

test('task model configuration enforces repository scope and grants shared models only through an administrator', async t => {
  const {h, admin, member, review, other, shared} = await fixture(t);
  for (const model of [other.id, shared.id, 'unknown']) {
    const denied = await member('/api/repositories/101/policy', 'PATCH', {task_models: {'review.pr': model}});
    assert.deepEqual([denied.status, denied.value.error], [400, 'model_not_available']);
  }
  assert.equal((await member('/api/repositories/202/policy', 'PATCH', {task_models: {'review.pr': review.id}})).status, 403);
  const granted = await admin('/api/repositories/101/policy', 'PATCH', {task_models: {'release.observe': shared.id}});
  assert.equal(granted.status, 200); assert.ok(h.store.get('SELECT 1 FROM model_projects WHERE model_id=? AND repository_id=?', shared.id, '101'));
  assert.equal(selectedModel(h.store, '101', 'release.observe').id, shared.id);
  assert.equal((await member('/api/repositories/101/policy', 'PATCH', {task_models: {'review.pr': shared.id}})).status, 200);
  await admin(`/api/models/${shared.id}/projects`, 'PUT', {repository_ids: []});
  assert.throws(() => selectedModel(h.store, '101', 'review.pr'), {code: 'model_not_configured', state: 'waiting_configuration'});
});

test('deleted or revoked task models fail closed without falling back to a different provider', async t => {
  const {h, admin, member, review, defaultModel} = await fixture(t);
  await member('/api/repositories/101/policy', 'PATCH', {task_models: {'review.pr': review.id}});
  const used = await member(`/api/models/${review.id}`);
  assert.deepEqual(used.value.model.used_by, [{repository_id: '101', full_name: 'fixture/project-101'}]);
  await admin(`/api/models/${review.id}/credentials/revoke`, 'POST', {});
  assert.throws(() => selectedModel(h.store, '101', 'review.pr'), {code: 'model_not_configured'});
  await member(`/api/models/${review.id}`, 'DELETE', {});
  assert.equal(JSON.parse(h.store.get('SELECT task_models FROM policies WHERE repository_id=?', '101').task_models)['review.pr'], review.id);
  assert.throws(() => selectedModel(h.store, '101', 'review.pr'), {code: 'model_not_configured'});
  assert.equal(selectedModel(h.store, '101', 'review.issue').id, defaultModel.id);
});

test('invalid task maps and failed audit do not partially change model selection or grants', async t => {
  const {h, admin, member, review, shared} = await fixture(t);
  for (const invalid of [null, [], {'../review': review.id}, {'review.*': review.id}, {constructor: review.id}, {'review.pr': null}, {'review.pr': ''}, {'Review': review.id}]) {
    const result = await member('/api/repositories/101/policy', 'PATCH', {task_models: invalid});
    assert.equal(result.status, 400); assert.equal(result.value.error, 'invalid_task_models');
  }
  assert.deepEqual(JSON.parse(h.store.get('SELECT task_models FROM policies WHERE repository_id=?', '101').task_models), {});
  h.store.db.exec("CREATE TRIGGER fail_task_model_audit BEFORE INSERT ON audit WHEN NEW.action='policy.updated' BEGIN SELECT RAISE(ABORT,'test'); END");
  const result = await admin('/api/repositories/101/policy', 'PATCH', {task_models: {'review.pr': shared.id}});
  assert.equal(result.status, 503);
  assert.equal(h.store.get('SELECT 1 FROM model_projects WHERE model_id=? AND repository_id=?', shared.id, '101'), undefined);
  assert.deepEqual(JSON.parse(h.store.get('SELECT task_models FROM policies WHERE repository_id=?', '101').task_models), {});
});

test('project model console preserves custom task IDs, shows stale models and restores inheritance', async () => {
  const {loadConsole} = await import('./console-page.mjs');
  const bodies = [];
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], (method, path, body) => {
    assert.equal(method, 'PATCH'); assert.equal(path, '/api/repositories/101/policy'); bodies.push(body); return [200, {}];
  });
  page.run(`me={role:'super_admin',csrf_token:'csrf'}; current={id:'101',section:'tasks',policy:{model_id:'model',task_models:JSON.stringify({'review.pr':'deleted','custom.science':'model'})}};
    var reloads=0; reloadWith=async()=>{reloads++;};
    var chooser=taskModelEditor('review.pr','检视 PR',current.policy,[{id:'model',repository_id:'101',model_name:'Fixture',api_url:'https://model.invalid/v1',key_configured:true}]);`);
  const click = async (root, label) => {
    await root.querySelectorAll('button').find(button => button.textContent === label).listeners.click[0]();
  };
  const chooser = page.run('chooser');
  assert.ok(chooser.querySelectorAll('option').some(option => option.textContent.includes('模型不可用')));
  chooser.querySelector('select').value = 'model'; await click(chooser, '保存模型');
  assert.deepEqual(bodies[0], {task_models: {'review.pr': 'model', 'custom.science': 'model'}});
  page.run("current.policy.task_models=JSON.stringify({'review.pr':'model','custom.science':'model'});");
  await click(chooser, '恢复继承');
  assert.deepEqual(bodies[1], {task_models: {'custom.science': 'model'}});
  page.run(`current.policy.task_models=JSON.stringify({'custom.science':'model'});
    var inherited=taskModelEditor('review.pr','检视 PR',current.policy,[{id:'model',repository_id:'101',model_name:'Fixture',api_url:'https://model.invalid/v1',key_configured:true}]);
    var custom=taskModelEditor('custom.science','custom.science',current.policy,[{id:'model',repository_id:'101',model_name:'Fixture',api_url:'https://model.invalid/v1',key_configured:true}],{custom:true});`);
  const inherited = page.run('inherited');
  assert.equal(inherited.querySelector('select').value, ''); await click(inherited, '保存模型');
  assert.deepEqual(bodies[2], {task_models: {'custom.science': 'model'}});
  await click(page.run('custom'), '移除这项设置');
  assert.deepEqual(bodies[3], {task_models: {}}); assert.equal(page.run('reloads'), 4);
  assert.equal(page.run("projectSections.map(([id,title])=>id+':'+title).join(',')"), 'overview:项目总览,basic:基本设置,management:管理对话,machine:机器配置,roles:角色,model:模型,release:发版本,knowledge:项目知识,external:外部执行,members:成员,activity:运行状态');
  assert.equal(page.run("kindLabels['release.observe']+'/'+kindLabels['release.notes']"), 'CI 观察/发行说明');
});

test('task model configuration failures identify model configuration rather than bot defects', async () => {
  const {explainFailure} = await import('../dist/agent/failures.js');
  for (const code of ['task_models_invalid', 'model_not_available', 'model_configuration_changed']) {
    const failure = explainFailure(code, 'waiting_configuration');
    assert.equal(failure.cause, 'model'); assert.equal(failure.automatic, true);
  }
});
