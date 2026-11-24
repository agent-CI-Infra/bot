// #1255: Pi is the default backend of the management assistant, group assistants and project roles. A database from before
// it moves what it saved as Native to Pi once at start-up; every other backend stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { roleConfiguration } from '../../../../dist/roles/definition.js';
import { migrateNativeToPi, retireNativeProjectRoles, retireNativeServiceAssistants } from '../../../../dist/roles/native-to-pi.js';
import { rolePool } from '../../../../dist/roles/pool.js';
import { managementAssistant, serviceRole, updateServiceRole } from '../../../../dist/service-roles/roles.js';

const repos = ['v2', 'kept', 'legacy', 'defaults'];
const admin = { id: 'admin', role: 'project_admin', repositories: repos };
const url = repo => new URL(`http://local/api/repositories/${repo}/roles`);
const get = (s, repo) => roleApi(s, admin, 'GET', url(repo), {});
const put = (s, repo, body) => roleApi(s, admin, 'PUT', url(repo), { expected_revision: get(s, repo).revision, ...body }).configuration;
const stored = (s, repo) => JSON.parse(s.get('SELECT value FROM settings WHERE key=?', 'roles:' + repo).value);
const save = (s, repo, value) => s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(value), 'roles:' + repo);
const harnessOf = (s, repo) => Object.fromEntries(roleConfiguration(s, repo).roles.map(role => [role.role_id, role.harness_ref.id]));
const builtinIds = rolePool.map(role => role.id).filter(id => id !== 'coordinator');

function fixture(t) {
  const s = new Store(':memory:', randomBytes(32));
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  for (const id of repos) s.run('INSERT INTO repositories VALUES(?,?,?,?)', id, 'fixture/' + id, 'o', 'a');
  s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','kept','http://127.0.0.1:9/v1','fixture',?,'now')", s.secrets.seal({ value: 'fixture-key' }, 'model:m'));
  t.after(() => s.close());
  return s;
}
// A V2 configuration whose `roleId` was saved on Native, as a database from before #1257 holds it: saved through the API on
// another backend (the API no longer takes Native), then stored with Native in its place.
function saveNative(s, repo, roleId) {
  put(s, repo, { roles: [{ role_id: roleId, harness_ref: { id: 'process' } }] });
  const value = stored(s, repo);
  save(s, repo, { ...value, roles: value.roles.map(role => role.role_id === roleId ? { ...role, harness_ref: { id: 'native', version: '1' } } : role) });
}
const textJsonProfile = { model_id: 'm', name: 'fixture', profile_hash: 'x', version: 1, api: 'openai-chat-completions', tool_calls: true, structured_output: 'text_json' };
// What a database from before #1255 held: rows saved as Native next to other backends.
function oldData(s) {
  s.run("UPDATE service_roles SET harness='native',revision=3 WHERE id=?", managementAssistant);
  for (const [id, harness] of [['custom-native', 'native'], ['custom-codex', 'codex']])
    s.run("INSERT INTO service_roles(id,builtin,enabled,name,harness,revision,created_at,updated_at) VALUES(?,0,1,?,?,2,'then','then')", id, id, harness);
  for (const [id, harness] of [['g-native', 'native'], ['g-claude', 'claude_code']]) {
    s.run("INSERT INTO channel_chats(id,provider,app_id,installation_tenant,chat_id,chat_type,connector_id,created_at,last_received_at) VALUES(?,'feishu','app','tenant',?,'group','connector',1,1)", 'chat-' + id, 'oc-' + id);
    s.run(`INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,revision,model_id,prompt,harness,created_at,updated_at)
      VALUES(?,?,'group-assistant','repositories',?,'admin','admin',4,NULL,'',?,1,1)`, id, 'chat-' + id, 'principal-' + id, harness);
  }
  // v2: dev chose Native, reviewer Codex.
  saveNative(s, 'v2', 'dev');
  const v2 = stored(s, 'v2');
  save(s, 'v2', { ...v2, roles: v2.roles.map(role => role.role_id === 'reviewer' ? { ...role, harness_ref: { id: 'codex', version: '1' } } : role) });
  // kept: QA on Native with a model profile that answers in text_json, which Pi cannot take.
  saveNative(s, 'kept', 'qa');
  const kept = stored(s, 'kept');
  save(s, 'kept', { ...kept, roles: kept.roles.map(role => role.role_id === 'qa' ? { ...role, model_profile_ref: textJsonProfile } : role) });
  // legacy: from before RoleDefinitionV2, the manager named Native, dev Codex, an own role and the rest unnamed.
  s.run("INSERT INTO settings VALUES('roles:legacy',?)", JSON.stringify({ enabled: true, harnesses: { manager: 'native', dev: 'codex' }, roles: [{ id: 'security', prompt: '' }] }));
  // defaults saved its own configuration and then restored the recommended one, which already runs Pi.
  put(s, 'defaults', { roles: [{ role_id: 'ux', enabled: false }] });
  put(s, 'defaults', { follow_default: true });
}

test('migration #1255: Native service roles, group bindings and project roles move to Pi once; other backends stay', t => {
  const s = fixture(t);
  oldData(s);
  const before = { kept: s.get("SELECT value FROM settings WHERE key='roles:kept'").value, defaults: s.get("SELECT value FROM settings WHERE key='roles:defaults'").value };
  const revisions = repo => s.all('SELECT revision,actor FROM role_config_revisions WHERE repository_id=? ORDER BY revision', repo).map(row => [row.revision, row.actor]);
  const v2Revisions = revisions('v2');
  s.run("DELETE FROM settings WHERE key='migration:1255:native-to-pi'");
  const lines = [];
  migrateNativeToPi(s, line => lines.push(line));

  // Service roles: Native moves under a new revision, Codex stays.
  const role = id => ({ ...s.get('SELECT harness,revision FROM service_roles WHERE id=?', id) });
  assert.deepEqual([role(managementAssistant), role('custom-native'), role('custom-codex')],
    [{ harness: 'pi', revision: 4 }, { harness: 'pi', revision: 3 }, { harness: 'codex', revision: 2 }]);
  // Group bindings: the revision is part of the group's fence and stays.
  const binding = id => ({ ...s.get('SELECT harness,revision FROM channel_service_bindings WHERE id=?', id) });
  assert.deepEqual([binding('g-native'), binding('g-claude')], [{ harness: 'pi', revision: 4 }, { harness: 'claude_code', revision: 4 }]);

  // v2: dev moves under a new configuration revision; the reviewer keeps Codex.
  assert.deepEqual([harnessOf(s, 'v2').dev, harnessOf(s, 'v2').reviewer, harnessOf(s, 'v2').manager], ['pi', 'codex', 'pi']);
  assert.deepEqual(revisions('v2'), [...v2Revisions, [v2Revisions.at(-1)[0] + 1, 'migration:1255']]);
  assert.equal(stored(s, 'v2').updated_by, 'migration:1255');
  // kept: QA's model profile needs text_json, so it stays Native and nothing is rewritten.
  assert.equal(s.get("SELECT value FROM settings WHERE key='roles:kept'").value, before.kept);
  assert.equal(harnessOf(s, 'kept').qa, 'native');
  // legacy: the named Native entry becomes Pi, Codex stays, and the roles it does not name run Pi.
  assert.deepEqual(stored(s, 'legacy').harnesses, { manager: 'pi', dev: 'codex' });
  assert.deepEqual(harnessOf(s, 'legacy'), { ...Object.fromEntries(builtinIds.map(id => [id, 'pi'])), dev: 'codex', security: 'pi' });
  // defaults is untouched.
  assert.equal(s.get("SELECT value FROM settings WHERE key='roles:defaults'").value, before.defaults);

  // One log line with the counts: the legacy project moved every role but dev (the own role included).
  const legacyMoved = builtinIds.length - 1 + 1;
  assert.deepEqual(lines, [`[migration:1255] Native → Pi: 2 service roles, 1 group bindings, ${1 + legacyMoved} roles in 2 projects; 1 roles stay Native (their pinned model profile needs text_json output, which Pi cannot use)`]);
  assert.deepEqual(s.all("SELECT action,resource_id,repository_id FROM audit WHERE user_id='migration:1255' ORDER BY action,resource_id").map(row => [row.action, row.resource_id, row.repository_id]), [
    ['channel.service_binding.native_to_pi', 'g-native', null],
    ['roles.native_to_pi', '0', 'legacy'],
    ['roles.native_to_pi', String(stored(s, 'v2').revision), 'v2'],
    ['service_role.native_to_pi', 'custom-native', null],
    ['service_role.native_to_pi', managementAssistant, null],
  ]);

  // It runs once: Native chosen by hand afterwards stays for it (a service assistant moves at start-up since #1257, below).
  s.run("UPDATE service_roles SET harness='native' WHERE id='custom-native'");
  migrateNativeToPi(s, line => lines.push(line));
  assert.equal(role('custom-native').harness, 'native');
  assert.equal(lines.length, 1);
});

test('a new database starts on Pi: the management assistant, a legacy configuration without backends, and the migration has nothing to do', t => {
  const s = fixture(t);
  assert.ok(s.get("SELECT 1 FROM settings WHERE key='migration:1255:native-to-pi'"));
  assert.equal(serviceRole(s, managementAssistant).harness, 'pi');
  assert.equal(s.get('SELECT dflt_value FROM pragma_table_info(?) WHERE name=?', 'service_roles', 'harness').dflt_value, "'pi'");
  assert.equal(s.get('SELECT dflt_value FROM pragma_table_info(?) WHERE name=?', 'channel_service_bindings', 'harness').dflt_value, "'pi'");
  s.run("INSERT INTO settings VALUES('roles:legacy',?)", JSON.stringify({ enabled: false, harnesses: {} }));
  assert.deepEqual(new Set(Object.values(harnessOf(s, 'legacy'))), new Set(['pi']));
  const lines = [];
  migrateNativeToPi(s, line => lines.push(line));
  assert.deepEqual(lines, []);
  // Native can no longer be chosen (#1257): the role API refuses it.
  assert.throws(() => put(s, 'v2', { roles: [{ role_id: 'dev', harness_ref: { id: 'native' } }] }), error => error.code === 'unknown_role_harness');
});

test('Native is gone for service assistants (#1257): one still saved on it moves to Pi at every start, the API refuses it', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-retired-')), path = join(directory, 'control.sqlite'), key = randomBytes(32);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let s = new Store(path, key);
  // Saved on Native after #1255's migration, while it could still be chosen by hand, next to other backends.
  s.run("UPDATE service_roles SET harness='native',revision=3 WHERE id=?", managementAssistant);
  for (const [id, harness] of [['custom-native', 'native'], ['custom-codex', 'codex']])
    s.run("INSERT INTO service_roles(id,builtin,enabled,name,harness,revision,created_at,updated_at) VALUES(?,0,1,?,?,2,'then','then')", id, id, harness);
  for (const [id, harness] of [['g-native', 'native'], ['g-claude', 'claude_code']]) {
    s.run("INSERT INTO channel_chats(id,provider,app_id,installation_tenant,chat_id,chat_type,connector_id,created_at,last_received_at) VALUES(?,'feishu','app','tenant',?,'group','connector',1,1)", 'chat-' + id, 'oc-' + id);
    s.run(`INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,revision,model_id,prompt,harness,created_at,updated_at)
      VALUES(?,?,'group-assistant','repositories',?,'admin','admin',4,NULL,'',?,1,1)`, id, 'chat-' + id, 'principal-' + id, harness);
  }
  s.close();
  // The next start moves them: a service role under a new revision, a binding keeping its own (its fence).
  s = new Store(path, key); t.after(() => s.close());
  const role = id => ({ ...s.get('SELECT harness,revision FROM service_roles WHERE id=?', id) });
  assert.deepEqual([role(managementAssistant), role('custom-native'), role('custom-codex')],
    [{ harness: 'pi', revision: 4 }, { harness: 'pi', revision: 3 }, { harness: 'codex', revision: 2 }]);
  const binding = id => ({ ...s.get('SELECT harness,revision FROM channel_service_bindings WHERE id=?', id) });
  assert.deepEqual([binding('g-native'), binding('g-claude')], [{ harness: 'pi', revision: 4 }, { harness: 'claude_code', revision: 4 }]);
  assert.deepEqual(s.all("SELECT action,resource_id FROM audit WHERE user_id='migration:1257' ORDER BY action,resource_id").map(row => [row.action, row.resource_id]),
    [['channel.service_binding.native_retired', 'g-native'], ['service_role.native_retired', 'custom-native'], ['service_role.native_retired', managementAssistant]]);
  // It says what it moved; with nothing left it says nothing.
  s.run("UPDATE service_roles SET harness='native' WHERE id='custom-native'");
  const lines = [];
  retireNativeServiceAssistants(s, line => lines.push(line));
  retireNativeServiceAssistants(s, line => lines.push(line));
  assert.deepEqual(lines, ['[migration:1257] Native retired: 1 service roles and 0 group bindings moved to Pi']);
  // Native can no longer be chosen.
  assert.throws(() => updateServiceRole(s, 'admin', managementAssistant, { expected_revision: role(managementAssistant).revision, harness: 'native' }),
    error => error.status === 400 && error.code === 'unknown_role_harness');
});

test('Native is gone for project roles (#1257): saved configurations, frozen task configurations and role instances move once, text_json roles to Process', t => {
  const s = fixture(t);
  // Saved after #1255's migration: dev chosen as Native by hand, QA kept on Native for its text_json model profile, and a
  // legacy configuration naming Native for the manager.
  saveNative(s, 'v2', 'dev');
  saveNative(s, 'kept', 'qa');
  const kept = stored(s, 'kept');
  save(s, 'kept', { ...kept, roles: kept.roles.map(role => role.role_id === 'qa' ? { ...role, model_profile_ref: textJsonProfile } : role) });
  s.run("INSERT INTO settings VALUES('roles:legacy',?)", JSON.stringify({ enabled: true, harnesses: { manager: 'native', dev: 'codex' } }));
  // Tasks froze those configurations; their role instances ran on Native.
  const frozen = { 't-v2': ['v2', { roles: stored(s, 'v2') }], 't-kept': ['kept', { roles: stored(s, 'kept') }], 't-legacy': ['legacy', { roles: { enabled: true, harnesses: { qa: 'native', dev: 'codex' } } }] };
  for (const [task, [repo, snapshot]] of Object.entries(frozen)) {
    s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES(?,?,'task.request','pr_opened','frozen','{}',1,1)", task, repo);
    s.run("INSERT INTO task_execution_configs(task_id,revision,snapshot,created_at) VALUES(?,1,?,'then')", task, JSON.stringify(snapshot));
  }
  for (const [id, task, role] of [['ri-dev', 't-v2', 'dev'], ['ri-qa', 't-kept', 'qa'], ['ri-legacy', 't-legacy', 'qa'], ['ri-codex', 't-legacy', 'dev']])
    s.run("INSERT INTO role_instances(id,task_id,role,definition,harness,session,harness_state,updated_at) VALUES(?,?,?,'{}',?,'[\"old\"]','{\"turn\":3}','then')", id, task, role, role === 'dev' && task === 't-legacy' ? 'codex' : 'native');
  const revision = repo => stored(s, repo).revision, before = { v2: revision('v2'), kept: revision('kept') };
  s.run("DELETE FROM settings WHERE key='migration:1257:retire-native-roles'");
  const lines = [];
  retireNativeProjectRoles(s, line => lines.push(line));

  // Saved configurations: a new revision for V2, the legacy map in place.
  assert.deepEqual([harnessOf(s, 'v2').dev, harnessOf(s, 'kept').qa, stored(s, 'legacy').harnesses], ['pi', 'process', { manager: 'pi', dev: 'codex' }]);
  assert.deepEqual([revision('v2') - before.v2, revision('kept') - before.kept, stored(s, 'v2').updated_by], [1, 1, 'migration:1257']);
  assert.equal(s.get("SELECT actor FROM role_config_revisions WHERE repository_id='kept' AND revision=?", revision('kept')).actor, 'migration:1257');
  // Frozen task configurations resume on the same backends.
  const snapshot = task => JSON.parse(s.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', task).snapshot).roles;
  assert.equal(snapshot('t-v2').roles.find(role => role.role_id === 'dev').harness_ref.id, 'pi');
  assert.equal(snapshot('t-kept').roles.find(role => role.role_id === 'qa').harness_ref.id, 'process');
  assert.ok(snapshot('t-v2').revision > before.v2);
  assert.deepEqual(snapshot('t-legacy').harnesses, { qa: 'pi', dev: 'codex' });
  // Role instances follow their task's role and start again from task records; others stay as they are.
  const instance = id => ({ ...s.get('SELECT harness,session,harness_state FROM role_instances WHERE id=?', id) });
  assert.deepEqual([instance('ri-dev'), instance('ri-qa'), instance('ri-legacy')].map(row => row.harness), ['pi', 'process', 'pi']);
  assert.ok([instance('ri-dev'), instance('ri-qa'), instance('ri-legacy')].every(row => row.session === '[]' && row.harness_state === '{}'));
  assert.deepEqual(instance('ri-codex'), { harness: 'codex', session: '["old"]', harness_state: '{"turn":3}' });
  assert.deepEqual(lines, ['[migration:1257] Native retired: 3 roles in 3 projects (1 to Process for text_json output, the rest to Pi), 3 frozen task configurations, 3 role instances']);
  assert.deepEqual(s.all("SELECT resource_id,repository_id FROM audit WHERE user_id='migration:1257' AND action='roles.native_retired' ORDER BY repository_id").map(row => [row.resource_id, row.repository_id]),
    [[String(revision('kept')), 'kept'], ['0', 'legacy'], [String(revision('v2')), 'v2']]);
  // Once: nothing runs again.
  retireNativeProjectRoles(s, line => lines.push(line));
  assert.equal(lines.length, 1);
});
