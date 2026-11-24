// #1068: a project without a configuration of its own runs the recommended configuration and follows built-in updates;
// saving makes it the project's own; restoring the defaults and a one-time migration return unchanged projects to them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { Store } from '../../../../dist/storage/database.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { defaultRoles, followBuiltinDefaults, resolveRole, roleConfiguration, roleStorageV2 } from '../../../../dist/roles/definition.js';
import { earlierPermissions, earlierTemplates } from '../../../../dist/roles/earlier-defaults.js';
import { recommendedBackend } from '../../../../dist/roles/backends.js';
import { rolePool, roleTemplate } from '../../../../dist/roles/pool.js';
import { captureTaskConfiguration } from '../../../../dist/tasks/configuration.js';
import { roleConfig } from '../../../../dist/roles/run.js';

const admin = { id: 'admin', role: 'project_admin', repositories: ['r', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'legacy', 'custom-legacy'] };
const url = repo => new URL(`http://local/api/repositories/${repo}/roles`);
const get = (s, repo = 'r') => roleApi(s, admin, 'GET', url(repo), {});
const put = (s, body, repo = 'r') => roleApi(s, admin, 'PUT', url(repo), { expected_revision: get(s, repo).revision, ...body }).configuration;
const rejects = (fn, code, field) => assert.throws(fn, e => { assert.equal(e.code, code); if (field) assert.equal(e.field, field); return true; });
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const stored = (s, repo = 'r') => JSON.parse(s.get('SELECT value FROM settings WHERE key=?', 'roles:' + repo).value);
const revisions = (s, repo = 'r') => s.all('SELECT revision,actor FROM role_config_revisions WHERE repository_id=? ORDER BY revision', repo).map(row => [row.revision, row.actor]);

function fixture(t) {
  const s = new Store(':memory:', randomBytes(32));
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  for (const id of admin.repositories) s.run('INSERT INTO repositories VALUES(?,?,?,?)', id, 'fixture/' + id, 'o', 'a');
  s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r','http://127.0.0.1:9/v1','fixture',?,'now')", s.secrets.seal({ value: 'fixture-key' }, 'model:m'));
  s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,review_enabled) VALUES('r','m',1,1,1)");
  t.after(() => s.close());
  return s;
}
const task = (s, id) => {
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES(?,'r','task.request','running','fixture','{}',1,1)", id);
  captureTaskConfiguration(s, id);
  return s.get('SELECT * FROM tasks WHERE id=?', id);
};
// A built-in default changed by a later version: the reviewer's template.
function changeBuiltinTemplate(t, role, text) {
  const entry = rolePool.find(r => r.id === role), before = entry.prompt;
  entry.prompt = text; t.after(() => { entry.prompt = before; });
}

test('a project without a configuration runs, shows and previews the recommended configuration', t => {
  const s = fixture(t), view = get(s);
  assert.equal(view.configured, false);
  assert.equal(view.configuration.follows_default, true);
  assert.equal(view.revision, 0);
  assert.equal(view.configuration.legacy, undefined);
  assert.deepEqual(view.configuration.roles, defaultRoles());
  assert.deepEqual(view.configuration.roles.map(r => r.role_id), rolePool.map(r => r.id));
  // One recommendation: every role, control-plane roles included, on the recommended backend (#1068 replaced native).
  assert.equal(recommendedBackend, 'pi');
  for (const role of view.configuration.roles) {
    assert.equal(role.harness_ref.id, recommendedBackend, role.role_id);
    assert.equal(role.persona_prompt, roleTemplate(role.role_id));
  }
  assert.equal(view.recommended_backend, recommendedBackend);
  // The preview is what a run starts with: the role's own backend, not a legacy binding.
  for (const entry of view.preview) {
    assert.equal(entry.error, undefined, entry.role + ': ' + entry.detail);
    assert.equal(entry.harness.id, recommendedBackend, entry.role);
    assert.equal(entry.harness.source, 'role', entry.role);
  }
  assert.deepEqual(view.preview.map(entry => entry.role), rolePool.map(r => r.id));
  // The review and Actions entries run the dev role's own backend too.
  assert.equal(resolveRole(s, 'r', 'dev', 'review.pull_request', { entryExecutor: true, persist: false }).snapshot.harness.source, 'role');
});

test('an unchanged project follows a changed built-in default; a custom one and a started task keep theirs', t => {
  const s = fixture(t), original = roleTemplate('test');
  put(s, { roles: [{ role_id: 'reviewer', persona_prompt: 'Our own reviewer instructions.' }] }, 'p2');
  const started = task(s, 'before');
  assert.equal(roleConfig(s, started).roles.find(r => r.role_id === 'test').persona_prompt, original);

  changeBuiltinTemplate(t, 'test', 'Tester template of a later version.');
  // The project without a configuration, and a task it creates now, use the new default.
  assert.equal(get(s).configuration.roles.find(r => r.role_id === 'test').persona_prompt, 'Tester template of a later version.');
  assert.match(resolveRole(s, 'r', 'test', 'task.request', { persist: false }).system, /Tester template of a later version\.$/);
  const created = task(s, 'after');
  assert.equal(roleConfig(s, created).roles.find(r => r.role_id === 'test').persona_prompt, 'Tester template of a later version.');
  // A task that started earlier keeps the configuration it froze.
  assert.equal(roleConfig(s, started).roles.find(r => r.role_id === 'test').persona_prompt, original);
  // A custom project keeps its saved configuration, the roles it did not edit included.
  const custom = get(s, 'p2').configuration;
  assert.equal(custom.roles.find(r => r.role_id === 'reviewer').persona_prompt, 'Our own reviewer instructions.');
  assert.equal(custom.roles.find(r => r.role_id === 'test').persona_prompt, original);
});

test('restoring a configuration from before RoleDefinitionV2 keeps it readable as a revision', t => {
  const s = fixture(t), legacy = { enabled: true, harnesses: { manager: 'process' }, roles: [{ id: 'dev', prompt: 'Review first' }] };
  s.run("INSERT INTO settings VALUES('roles:r',?)", JSON.stringify(legacy));
  const before = get(s);
  assert.deepEqual([before.configured, before.revision, before.configuration.legacy], [true, 0, true]);
  const restored = put(s, { follow_default: true });
  assert.deepEqual([restored.revision, restored.follows_default], [2, true]);
  assert.deepEqual(revisions(s), [[1, 'admin'], [2, 'admin']]);
  // Revision 1 is the legacy configuration as it was read: its backend choice and project instructions included.
  const kept = roleApi(s, admin, 'GET', new URL('http://local/api/repositories/r/roles?revision=1'), {}).configuration;
  assert.deepEqual(kept.roles.map(role => role.role_id), before.configuration.roles.map(role => role.role_id));
  assert.equal(kept.roles.find(role => role.role_id === 'manager').harness_ref.id, 'process');
  assert.match(kept.roles.find(role => role.role_id === 'dev').persona_prompt, /Project instructions:\nReview first$/);
  assert.deepEqual(kept.roles, before.configuration.roles);
  assert.equal(get(s).configured, false);
});

test('saving makes the configuration the project\'s own; restoring the defaults is a new revision that keeps the history', t => {
  const s = fixture(t);
  s.run("UPDATE policies SET role_concurrency='{\"dev\":2,\"security\":1}' WHERE repository_id='r'");
  const saved = put(s, { roles: [{ role_id: 'dev', harness_ref: { id: 'process' } }, { role_id: 'security', persona_prompt: 'Check secrets.' }] });
  assert.equal(saved.revision, 1);
  assert.equal(saved.follows_default, undefined);
  assert.ok(saved.roles.every(role => role.revision === 1), 'leaving the defaults saves every role for the first time');
  const custom = get(s);
  assert.equal(custom.configured, true);
  assert.equal(custom.configuration.roles.find(r => r.role_id === 'dev').harness_ref.id, 'process');

  rejects(() => put(s, { follow_default: false }), 'invalid_role_configuration', 'follow_default');
  rejects(() => put(s, { follow_default: true, roles: [] }), 'unknown_field', 'roles');
  rejects(() => roleApi(s, admin, 'PUT', url('r'), { follow_default: true }), 'expected_revision_required', 'expected_revision');
  rejects(() => roleApi(s, admin, 'PUT', url('r'), { expected_revision: 0, follow_default: true }), 'role_configuration_conflict', 'expected_revision');

  const restored = put(s, { follow_default: true });
  assert.equal(restored.revision, 2);
  assert.equal(restored.follows_default, true);
  assert.deepEqual(restored.roles, defaultRoles());
  const view = get(s);
  assert.equal(view.configured, false);
  assert.deepEqual(view.configuration.roles, defaultRoles());
  // Stored: a revision without roles, so later versions expand their own defaults.
  assert.deepEqual(Object.keys(stored(s)).sort(), ['follows_default', 'revision', 'schema', 'updated_at', 'updated_by']);
  assert.deepEqual(revisions(s), [[1, 'admin'], [2, 'admin']]);
  assert.equal(view.revisions.length, 2);
  // The custom revision stays readable; the defaults revision reads as the defaults.
  assert.equal(roleApi(s, admin, 'GET', new URL('http://local/api/repositories/r/roles?revision=1'), {}).configuration.roles.find(r => r.role_id === 'security').persona_prompt, 'Check secrets.');
  assert.equal(roleApi(s, admin, 'GET', new URL('http://local/api/repositories/r/roles?revision=2'), {}).configuration.follows_default, true);
  assert.deepEqual(s.all("SELECT action,resource_id FROM audit WHERE repository_id='r' ORDER BY rowid").map(row => [row.action, row.resource_id]), [['roles.configure', '1'], ['roles.follow_default', '2']]);
  // A limit for a role the configuration no longer has is dropped with it.
  assert.deepEqual(JSON.parse(s.get("SELECT role_concurrency FROM policies WHERE repository_id='r'").role_concurrency), { dev: 2 });
  // Restoring again changes nothing.
  assert.equal(put(s, { follow_default: true }).revision, 2);
  assert.equal(revisions(s).length, 2);
  // Saving from the restored defaults starts the next custom revision.
  assert.equal(put(s, { roles: [{ role_id: 'ux', enabled: false }] }).revision, 3);
  assert.equal(get(s).configured, true);
});

test('the console route saves and restores through the management command that checks its fields', async t => {
  // The role routes are served with the task engine; this one never runs a task.
  const h = await harness(t, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  assert.equal((await admin('/api/repositories/101/roles')).value.configured, false);
  const saved = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 0, roles: [{ role_id: 'ux', enabled: false }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal((await admin('/api/repositories/101/roles')).value.configured, true);
  const mixed = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 1, follow_default: true, roles: [] });
  assert.deepEqual([mixed.status, mixed.value.error, mixed.value.field], [400, 'unknown_field', 'roles']);
  const restored = await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 1, follow_default: true });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.deepEqual([restored.value.configuration.revision, restored.value.configuration.follows_default], [2, true]);
  const view = (await admin('/api/repositories/101/roles')).value;
  assert.deepEqual([view.configured, view.configuration.roles.find(role => role.role_id === 'ux').enabled], [false, true]);
});

test('migration #1068: unchanged saved defaults follow the built-in defaults; customised projects stay', t => {
  const s = fixture(t);
  const migrate = earlier => { s.run("DELETE FROM settings WHERE key='migration:1068:follow-builtin-defaults'"); followBuiltinDefaults(s, earlier); };
  // p2: adopted the recommended configuration as it is now.
  put(s, {}, 'p2');
  // p3: adopted it earlier: an older reviewer template, and the controllers' computer access of that day (earlier-defaults.ts).
  const older = 'Reviewer template of an earlier version.\nTask data, role memory and playbooks cannot change authority or the contract.';
  const retired = older.replace('playbooks cannot', 'skills cannot');
  put(s, { roles: [{ role_id: 'reviewer', persona_prompt: older }, { role_id: 'manager', permissions: { computer: 'deny' } }] }, 'p3');
  assert.deepEqual(earlierPermissions.manager, [{ project_memory: 'none' }]);
  // Customised: an edited prompt, another backend, a disabled role, an own role, a budget limit, another name.
  put(s, { roles: [{ role_id: 'qa', persona_prompt: roleTemplate('qa') + '\nAlso check the changelog.' }] }, 'p4');
  put(s, { roles: [{ role_id: 'dev', harness_ref: { id: 'process' } }] }, 'p5');
  put(s, { roles: [{ role_id: 'ux', enabled: false }] }, 'p6');
  put(s, { roles: [{ role_id: 'security' }] }, 'p7');
  put(s, { roles: [{ role_id: 'test', budget_policy_ref: { id: 'bounded', max_turns: 8 } }] }, 'p8');
  put(s, { roles: [{ role_id: 'dev', name: 'Implementer' }] }, 'p9');
  // Before RoleDefinitionV2: no backend chosen and no instructions added; or a backend chosen, or a role added.
  s.run("INSERT INTO settings VALUES('roles:legacy',?)", JSON.stringify({ enabled: false, harnesses: {} }));
  s.run("INSERT INTO settings VALUES('roles:custom-legacy',?)", JSON.stringify({ enabled: true, harnesses: { manager: 'process' } }));
  s.run("INSERT INTO settings VALUES('roles:p10',?)", JSON.stringify({ enabled: true, harnesses: {}, roles: [{ id: 'security', prompt: '' }] }));
  const before = Object.fromEntries(['p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'custom-legacy', 'p10'].map(repo => [repo, s.get('SELECT value FROM settings WHERE key=?', 'roles:' + repo).value]));

  // Without the earlier template in the list, p3's reviewer prompt is a customisation.
  migrate({ templates: {}, permissions: earlierPermissions });
  assert.equal(get(s, 'p2').configured, false);
  assert.equal(get(s, 'p3').configured, true);

  migrate({ templates: { ...earlierTemplates, reviewer: [hash(retired)] }, permissions: earlierPermissions });
  for (const repo of ['p2', 'p3']) {
    const view = get(s, repo);
    assert.equal(view.configured, false, repo);
    assert.deepEqual(view.configuration.roles, defaultRoles(), repo);
    assert.deepEqual(revisions(s, repo), [[1, 'admin'], [2, 'migration:1068']], repo);
    assert.equal(stored(s, repo).updated_by, 'migration:1068');
  }
  assert.equal(get(s, 'legacy').configured, false);
  // The legacy row had no revision of its own: it is kept as revision 1 before the defaults take over at 2.
  assert.deepEqual(revisions(s, 'legacy'), [[1, 'migration:1068'], [2, 'migration:1068']]);
  assert.equal(roleApi(s, admin, 'GET', new URL('http://local/api/repositories/legacy/roles?revision=1'), {}).configuration.legacy, true);
  assert.deepEqual(s.all("SELECT user_id,action,resource_id,repository_id FROM audit WHERE action='roles.follow_default' ORDER BY repository_id").map(row => [row.user_id, row.resource_id, row.repository_id]),
    [['migration:1068', '2', 'legacy'], ['migration:1068', '2', 'p2'], ['migration:1068', '2', 'p3']]);
  // The customised projects keep their stored configuration and history.
  for (const [repo, value] of Object.entries(before)) {
    assert.equal(s.get('SELECT value FROM settings WHERE key=?', 'roles:' + repo).value, value, repo);
    assert.equal(get(s, repo).configured, true, repo);
  }
  // It runs once.
  put(s, {}, 'p2');
  followBuiltinDefaults(s);
  assert.equal(get(s, 'p2').configured, true);
});

test('at start-up migration:1072 runs first, so defaults saved before Actions write still follow the defaults', t => {
  const s = fixture(t);
  put(s, { roles: [{ role_id: 'manager', permissions: { github_actions: 'read' } }] }, 'p2'); // the default before #1072
  put(s, { roles: [{ role_id: 'manager', permissions: { github_actions: 'none' } }] }, 'p3'); // a choice
  for (const marker of ['migration:1072:actions-write', 'migration:1068:follow-builtin-defaults']) s.run('DELETE FROM settings WHERE key=?', marker);
  roleStorageV2(s);
  assert.equal(get(s, 'p2').configured, false);
  assert.deepEqual(revisions(s, 'p2'), [[1, 'admin'], [2, 'migration:1072'], [3, 'migration:1068']]);
  assert.equal(get(s, 'p3').configured, true);
  assert.deepEqual(revisions(s, 'p3'), [[1, 'admin']]);
});

test('legacy saved configurations containing retired coordinator load, preview and re-save cleanly without losing historical revisions or snapshots', t => {
  const s = fixture(t);
  const config = put(s, { roles: [{ role_id: 'dev', harness_ref: { id: 'process' } }] });
  const legacySaved = {
    ...config,
    roles: [
      {
        role_id: 'coordinator',
        revision: 1,
        enabled: true,
        kind: 'controller',
        name: 'Task Coordinator',
        responsibility: 'Resolves explicit cross-task coordination requests without product execution or acceptance authority.',
        persona_prompt: 'Old coordinator prompt.',
        model_profile_ref: null,
        skill_bundle_ref: null,
        harness_ref: { id: 'pi', version: '1.4.0' },
        permissions: { project_tasks: 'write' },
        environment_profile_ref: { id: 'control-session', version: 'legacy' },
        budget_policy_ref: { id: 'entry-default', version: 'legacy' },
        output_schema_ref: { id: 'coordination-result', version: 'legacy' },
      },
      ...config.roles.map(r => r.role_id === 'manager' ? { ...r, name: 'Project controller' } : r),
    ],
  };
  s.run("UPDATE settings SET value=? WHERE key='roles:r'", JSON.stringify(legacySaved));
  s.run("UPDATE role_config_revisions SET config=? WHERE repository_id='r' AND revision=1", JSON.stringify(legacySaved));
  // Loading and previewing filters out retired coordinator without schema errors.
  const view = get(s);
  assert.equal(view.configuration.roles.some(role => role.role_id === 'coordinator'), false);
  assert.equal(view.preview.every(entry => !entry.error), true);
  // Saving new edits succeeds cleanly and omits coordinator in the new revision.
  const updated = put(s, { roles: [{ role_id: 'ux', enabled: false }] });
  assert.equal(updated.revision, 2);
  assert.equal(updated.roles.some(role => role.role_id === 'coordinator'), false);
  // Historical revision 1 stays readable for audit.
  const rev1 = roleApi(s, admin, 'GET', new URL('http://local/api/repositories/r/roles?revision=1'), {}).configuration;
  assert.equal(rev1.roles.some(role => role.role_id === 'coordinator'), true);
  // Creating a new role named coordinator is rejected as retired.
  rejects(() => put(s, { roles: [{ role_id: 'coordinator', persona_prompt: 'retry' }] }), 'retired_role', 'roles[0].role_id');
  // Historical task details with coordinator role runs & snapshots remain readable.
  const now = new Date().toISOString();
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('hist-coord','r','task.request','completed','historical','{}',1,1)");
  s.run("INSERT INTO role_snapshots VALUES('snap-coord','r','coordinator',1,1,?,?)", JSON.stringify({ role_id: 'coordinator', name: 'Task Coordinator', harness: { id: 'native' } }), now);
  s.run("INSERT INTO task_runs(id,task_id,attempt,revision,kind,status,started_at,ended_at,context_snapshot,config_snapshot,role,role_snapshot,harness) VALUES('run-coord','hist-coord',1,1,'role','succeeded',?,?,'{}','{}','coordinator','snap-coord','native')", now, now);
  const taskRoles = roleApi(s, admin, 'GET', new URL('http://local/api/tasks/hist-coord/roles'), {});
  assert.equal(taskRoles.runs.length, 1);
  assert.equal(taskRoles.runs[0].role, 'coordinator');
  assert.equal(taskRoles.snapshots['snap-coord'].name, 'Task Coordinator');
});

test('default roles list omits coordinator and names manager as Manager with updated duties', t => {
  const s = fixture(t), view = get(s);
  assert.deepEqual(view.configuration.roles.map(r => r.role_id), ['manager', 'dev', 'test', 'reviewer', 'ux', 'qa']);
  const manager = view.configuration.roles.find(r => r.role_id === 'manager');
  assert.equal(manager.name, 'Manager');
  assert.match(manager.responsibility, /event dispatch/i);
  assert.match(manager.responsibility, /cross-task/i);
});
