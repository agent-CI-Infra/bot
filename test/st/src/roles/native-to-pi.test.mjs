// #1255: Pi is the default backend of the management assistant, group assistants and project roles. A database from before
// it moves what it saved as Native to Pi once at start-up; every other backend stays. #1337: the management assistant, group
// assistants, Manager and QA run only on Pi, and what was saved for them on another backend moves to Pi once.
// #1338: the Process backend is gone, and what was saved on it moves to Pi once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { resolveRole, roleConfiguration } from '../../../../dist/roles/definition.js';
import { migrateNativeToPi, pinAssistantsToPi, retireNativeProjectRoles, retireNativeServiceAssistants, retireProcessRoles } from '../../../../dist/roles/native-to-pi.js';
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
// A V2 configuration whose `roleId` was saved on Native, as a database from before #1257 holds it: saved through the API
// (which no longer takes Native), then stored with Native in its place.
function saveNative(s, repo, roleId) {
  put(s, repo, { roles: [{ role_id: roleId, harness_ref: { id: 'pi' } }] });
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

test('Native is gone for project roles (#1257): saved configurations, frozen task configurations and role instances move once to Pi, text_json roles answering through tool calls', t => {
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
  assert.deepEqual([harnessOf(s, 'v2').dev, harnessOf(s, 'kept').qa, stored(s, 'legacy').harnesses], ['pi', 'pi', { manager: 'pi', dev: 'codex' }]);
  // The text_json profile keeps its model and answers through tool calls, which Pi reads (#1338).
  assert.deepEqual(stored(s, 'kept').roles.find(role => role.role_id === 'qa').model_profile_ref, { ...textJsonProfile, structured_output: 'tool_call' });
  assert.deepEqual([revision('v2') - before.v2, revision('kept') - before.kept, stored(s, 'v2').updated_by], [1, 1, 'migration:1257']);
  assert.equal(s.get("SELECT actor FROM role_config_revisions WHERE repository_id='kept' AND revision=?", revision('kept')).actor, 'migration:1257');
  // Frozen task configurations resume on Pi.
  const snapshot = task => JSON.parse(s.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', task).snapshot).roles;
  assert.equal(snapshot('t-v2').roles.find(role => role.role_id === 'dev').harness_ref.id, 'pi');
  assert.deepEqual([snapshot('t-kept').roles.find(role => role.role_id === 'qa').harness_ref.id, snapshot('t-kept').roles.find(role => role.role_id === 'qa').model_profile_ref.structured_output], ['pi', 'tool_call']);
  assert.ok(snapshot('t-v2').revision > before.v2);
  assert.deepEqual(snapshot('t-legacy').harnesses, { qa: 'pi', dev: 'codex' });
  // Role instances on Native move to Pi and start again from task records; others stay as they are.
  const instance = id => ({ ...s.get('SELECT harness,session,harness_state FROM role_instances WHERE id=?', id) });
  assert.deepEqual([instance('ri-dev'), instance('ri-qa'), instance('ri-legacy')].map(row => row.harness), ['pi', 'pi', 'pi']);
  assert.ok([instance('ri-dev'), instance('ri-qa'), instance('ri-legacy')].every(row => row.session === '[]' && row.harness_state === '{}'));
  assert.deepEqual(instance('ri-codex'), { harness: 'codex', session: '["old"]', harness_state: '{"turn":3}' });
  assert.deepEqual(lines, ['[migration:1257] Native retired: 3 roles in 3 projects moved to Pi, 3 frozen task configurations, 3 role instances']);
  assert.deepEqual(s.all("SELECT resource_id,repository_id FROM audit WHERE user_id='migration:1257' AND action='roles.native_retired' ORDER BY repository_id").map(row => [row.resource_id, row.repository_id]),
    [[String(revision('kept')), 'kept'], ['0', 'legacy'], [String(revision('v2')), 'v2']]);
  // Once: nothing runs again.
  retireNativeProjectRoles(s, line => lines.push(line));
  assert.equal(lines.length, 1);
});

test('the assistants, Manager and QA run only on Pi (#1337): what was saved on other backends moves once; worker roles keep theirs', t => {
  const s = fixture(t);
  // Saved before #1337: the management assistant and a group on Codex or Claude Code.
  s.run("UPDATE service_roles SET harness='codex',revision=3 WHERE id=?", managementAssistant);
  for (const [id, harness] of [['g-codex', 'codex'], ['g-pi', 'pi']]) {
    s.run("INSERT INTO channel_chats(id,provider,app_id,installation_tenant,chat_id,chat_type,connector_id,created_at,last_received_at) VALUES(?,'feishu','app','tenant',?,'group','connector',1,1)", 'chat-' + id, 'oc-' + id);
    s.run(`INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,revision,model_id,prompt,harness,created_at,updated_at)
      VALUES(?,?,'group-assistant','repositories',?,'admin','admin',4,NULL,'',?,1,1)`, id, 'chat-' + id, 'principal-' + id, harness);
  }
  // v2: Manager on Codex with its own model configuration, QA on Claude Code with a model profile Pi cannot speak, Dev and
  // the reviewer on CLIs too (the API no longer takes the first two).
  put(s, 'v2', { roles: [{ role_id: 'dev', harness_ref: { id: 'codex' } }, { role_id: 'reviewer', harness_ref: { id: 'claude_code' } }] });
  const anthropic = { ...textJsonProfile, api: 'anthropic-messages', structured_output: 'tool_call' }, v2 = stored(s, 'v2');
  save(s, 'v2', { ...v2, roles: v2.roles.map(role => role.role_id === 'manager' ? { ...role, harness_ref: { id: 'codex', version: '1', model_source: 'local_config' } }
    : role.role_id === 'qa' ? { ...role, harness_ref: { id: 'claude_code', version: role.harness_ref.version }, model_profile_ref: anthropic } : role) });
  s.run("INSERT INTO settings VALUES('roles:legacy',?)", JSON.stringify({ enabled: true, harnesses: { manager: 'codex', qa: 'process', dev: 'claude_code' } }));
  const frozen = { 't-v2': ['v2', { roles: stored(s, 'v2') }], 't-legacy': ['legacy', { roles: { enabled: true, harnesses: { qa: 'codex', dev: 'codex' } } }] };
  for (const [task, [repo, snapshot]] of Object.entries(frozen)) {
    s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES(?,?,'task.request','pr_opened','frozen','{}',1,1)", task, repo);
    s.run("INSERT INTO task_execution_configs(task_id,revision,snapshot,created_at) VALUES(?,1,?,'then')", task, JSON.stringify(snapshot));
  }
  for (const [id, task, role, harness] of [['ri-manager', 't-v2', 'manager', 'codex'], ['ri-qa', 't-legacy', 'qa', 'claude_code'], ['ri-dev', 't-v2', 'dev', 'codex']])
    s.run("INSERT INTO role_instances(id,task_id,role,definition,harness,session,harness_state,updated_at) VALUES(?,?,?,'{}',?,'[\"old\"]','{\"turn\":3}','then')", id, task, role, harness);
  const before = stored(s, 'v2').revision;
  s.run("DELETE FROM settings WHERE key='migration:1337:assistants-on-pi'");
  const lines = [];
  pinAssistantsToPi(s, line => lines.push(line));

  // Service assistants: a new revision for the management assistant, a group binding keeps its own (its fence).
  assert.deepEqual({ ...s.get('SELECT harness,revision FROM service_roles WHERE id=?', managementAssistant) }, { harness: 'pi', revision: 4 });
  assert.deepEqual(s.all('SELECT id,harness,revision FROM channel_service_bindings ORDER BY id').map(row => [row.id, row.harness, row.revision]), [['g-codex', 'pi', 4], ['g-pi', 'pi', 4]]);
  // Saved configurations: Manager and QA move (the model source with them, the pinned profile stays); Dev and the reviewer keep theirs.
  assert.deepEqual(harnessOf(s, 'v2'), { manager: 'pi', dev: 'codex', test: 'pi', reviewer: 'claude_code', ux: 'pi', qa: 'pi' });
  const saved = stored(s, 'v2'), role = id => saved.roles.find(entry => entry.role_id === id);
  assert.deepEqual([saved.revision, saved.updated_by, role('manager').harness_ref, role('qa').model_profile_ref.api], [before + 1, 'migration:1337', role('test').harness_ref, 'anthropic-messages']);
  assert.equal(role('test').harness_ref.id, 'pi');
  assert.equal(s.get("SELECT actor FROM role_config_revisions WHERE repository_id='v2' AND revision=?", saved.revision).actor, 'migration:1337');
  assert.deepEqual(stored(s, 'legacy').harnesses, { manager: 'pi', qa: 'pi', dev: 'claude_code' });
  // Frozen task configurations resume on Pi for those two roles only.
  const snapshot = task => JSON.parse(s.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', task).snapshot).roles;
  assert.deepEqual(snapshot('t-v2').roles.map(entry => [entry.role_id, entry.harness_ref.id]), Object.entries(harnessOf(s, 'v2')));
  assert.ok(snapshot('t-v2').revision > before);
  assert.deepEqual(snapshot('t-legacy').harnesses, { qa: 'pi', dev: 'codex' });
  // Their role instances start again from task records on Pi; Dev's stays as it was.
  const instance = id => ({ ...s.get('SELECT harness,session,harness_state FROM role_instances WHERE id=?', id) });
  assert.deepEqual([instance('ri-manager'), instance('ri-qa'), instance('ri-dev')], [{ harness: 'pi', session: '[]', harness_state: '{}' }, { harness: 'pi', session: '[]', harness_state: '{}' }, { harness: 'codex', session: '["old"]', harness_state: '{"turn":3}' }]);
  // One log line with the counts, naming the role that waits for configuration.
  assert.deepEqual(lines, ['[migration:1337] assistants on Pi: 1 service roles, 1 group bindings, 4 Manager/QA roles in 2 projects, 2 frozen task configurations, 2 role instances; 1 of those roles pin a model profile Pi cannot use and wait for configuration']);
  assert.deepEqual(s.all("SELECT action,resource_id,repository_id FROM audit WHERE user_id='migration:1337' ORDER BY action,resource_id").map(row => [row.action, row.resource_id, row.repository_id]), [
    ['channel.service_binding.moved_to_pi', 'g-codex', null], ['roles.moved_to_pi', '0', 'legacy'], ['roles.moved_to_pi', String(saved.revision), 'v2'], ['service_role.moved_to_pi', managementAssistant, null]]);
  // Once: a later start finds the marker and changes nothing, and nothing logs.
  s.run("UPDATE channel_service_bindings SET harness='codex' WHERE id='g-pi'");
  pinAssistantsToPi(s, line => lines.push(line));
  assert.equal(s.get("SELECT harness FROM channel_service_bindings WHERE id='g-pi'").harness, 'codex');
  assert.equal(lines.length, 1);
});

test('Process is gone (#1338): roles saved on it move to Pi once, text_json answers through tool calls, waiting tasks resume, the API refuses it', t => {
  const s = fixture(t);
  // Saved before #1338 (the API no longer takes Process): Dev on Process with a text_json profile, the reviewer on Process,
  // the tester on Codex; a legacy configuration naming Process for test; frozen task configurations and role instances.
  put(s, 'kept', { roles: [{ role_id: 'test', harness_ref: { id: 'codex' } }] });
  const kept = stored(s, 'kept');
  save(s, 'kept', { ...kept, roles: kept.roles.map(role => role.role_id === 'dev' ? { ...role, harness_ref: { id: 'process', version: '1' }, model_profile_ref: textJsonProfile }
    : role.role_id === 'reviewer' ? { ...role, harness_ref: { id: 'process', version: '1' } } : role) });
  s.run("INSERT INTO settings VALUES('roles:legacy',?)", JSON.stringify({ enabled: true, harnesses: { test: 'process', dev: 'codex' } }));
  const frozen = { 't-kept': ['kept', { roles: stored(s, 'kept') }], 't-legacy': ['legacy', { roles: { enabled: true, harnesses: { reviewer: 'process', dev: 'codex' } } }] };
  for (const [task, [repo, snapshot]] of Object.entries(frozen)) {
    s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES(?,?,'task.request','waiting','frozen','{}',1,1)", task, repo);
    s.run("INSERT INTO task_execution_configs(task_id,revision,snapshot,created_at) VALUES(?,1,?,'then')", task, JSON.stringify(snapshot));
  }
  for (const [id, task, role, harness] of [['ri-dev', 't-kept', 'dev', 'process'], ['ri-rev', 't-legacy', 'reviewer', 'process'], ['ri-codex', 't-kept', 'test', 'codex']])
    s.run("INSERT INTO role_instances(id,task_id,role,definition,harness,session,harness_state,updated_at) VALUES(?,?,?,'{}',?,'[\"old\"]','{\"turn\":3}','then')", id, task, role, harness);
  const before = stored(s, 'kept').revision;
  s.run("DELETE FROM settings WHERE key='migration:1338:retire-process'");
  const lines = [];
  retireProcessRoles(s, line => lines.push(line));

  assert.deepEqual(harnessOf(s, 'kept'), { manager: 'pi', dev: 'pi', test: 'codex', reviewer: 'pi', ux: 'pi', qa: 'pi' });
  const dev = stored(s, 'kept').roles.find(role => role.role_id === 'dev');
  assert.deepEqual(dev.model_profile_ref, { ...textJsonProfile, structured_output: 'tool_call' }, 'the same model, answering through tool calls');
  assert.deepEqual([stored(s, 'kept').revision, stored(s, 'kept').updated_by], [before + 1, 'migration:1338']);
  assert.deepEqual(stored(s, 'legacy').harnesses, { test: 'pi', dev: 'codex' });
  const snapshot = task => JSON.parse(s.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', task).snapshot).roles;
  assert.deepEqual(snapshot('t-kept').roles.map(role => [role.role_id, role.harness_ref.id]), Object.entries(harnessOf(s, 'kept')));
  assert.deepEqual(snapshot('t-legacy').harnesses, { reviewer: 'pi', dev: 'codex' });
  const instance = id => ({ ...s.get('SELECT harness,session,harness_state FROM role_instances WHERE id=?', id) });
  assert.deepEqual([instance('ri-dev'), instance('ri-rev'), instance('ri-codex')], [{ harness: 'pi', session: '[]', harness_state: '{}' }, { harness: 'pi', session: '[]', harness_state: '{}' }, { harness: 'codex', session: '["old"]', harness_state: '{"turn":3}' }]);
  // A waiting task resumes on Pi from its frozen configuration instead of stopping at the backend check.
  s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('kept','m',1) ON CONFLICT(repository_id) DO UPDATE SET model_id='m'");
  assert.equal(resolveRole(s, 'kept', 'reviewer', 'task.request', { configuration: snapshot('t-kept'), persist: false }).snapshot.harness.id, 'pi');
  assert.deepEqual(lines, ['[migration:1338] Process retired: 3 roles in 2 projects, 2 frozen task configurations, 2 role instances moved to Pi']);
  // Once; and Process can no longer be chosen.
  retireProcessRoles(s, line => lines.push(line));
  assert.equal(lines.length, 1);
  assert.throws(() => put(s, 'v2', { roles: [{ role_id: 'dev', harness_ref: { id: 'process' } }] }), error => error.code === 'unknown_role_harness');
});
