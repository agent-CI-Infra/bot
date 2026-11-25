import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { roleConfiguration, resolveRole, saveConfiguration, skillFiles } from '../../../../dist/roles/definition.js';
import { roleApi } from '../../../../dist/roles/api.js';
import {
  loadBuiltinBundles,
  defaultProjectRoleBundleIds,
  defaultServiceRoleBundleIds,
  detectBuiltinBundleUpgrades,
  classifyProjectBundle,
} from '../../../../dist/roles/builtin-bundles.js';
import { createConsoleSkill, updateConsoleSkill, syncBuiltinSkills, listSkills } from '../../../../dist/roles/skill-library.js';
import { migrateSkillsToLibraryV3 } from '../../../../dist/roles/skill-migration.js';
import {
  listServiceRoles,
  managementAssistant,
  groupAssistant,
  serviceRole,
  serviceRoleStorage,
  updateServiceRole,
} from '../../../../dist/service-roles/roles.js';
import {
  parseStoredServiceSkillBundles,
  resolveServiceRoleSkills,
  readSkill,
} from '../../../../dist/service-roles/skills.js';
import {
  ChannelServiceBindings,
  serviceBindingStorage,
} from '../../../../dist/channels/service-bindings.js';
import { ChannelEmployees } from '../../../../dist/channels/employees.js';
import { channelStorage } from '../../../../dist/channels/storage.js';
import { identityStorage } from '../../../../dist/identity/storage.js';
import { digest } from '../../../../dist/core/security.js';
import { normalizePermissions } from '../../../../dist/roles/permissions.js';

function baseStore(t) {
  const s = new Store(':memory:', randomBytes(32));
  t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/bundles','o','a')");
  s.run(
    "INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r','https://fixture.invalid/v1','fixture',?,'now')",
    s.secrets.seal({ value: 'fixture' }, 'model:m'),
  );
  s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('r','m',1)");
  return s;
}

const adminActor = { id: 'admin', role: 'super_admin', repositoryIds: ['r'] };

test('skills/bundles.json declares the four confirmed built-in bundles and exact default bindings (#1359)', () => {
  const bundles = loadBuiltinBundles();
  assert.deepEqual(bundles.map(b => b.id), ['planning', 'ci-gates', 'dev-practices', 'feishu-cards']);
  assert.deepEqual(defaultProjectRoleBundleIds('manager'), ['planning', 'ci-gates']);
  assert.deepEqual(defaultProjectRoleBundleIds('dev'), ['ci-gates', 'dev-practices']);
  assert.deepEqual(defaultProjectRoleBundleIds('reviewer'), ['ci-gates']);
  assert.deepEqual(defaultProjectRoleBundleIds('test'), ['dev-practices']);
  assert.deepEqual(defaultProjectRoleBundleIds('ux'), []);
  assert.deepEqual(defaultProjectRoleBundleIds('qa'), []);
  assert.deepEqual(defaultServiceRoleBundleIds(managementAssistant), ['ci-gates', 'feishu-cards']);
  assert.deepEqual(defaultServiceRoleBundleIds(groupAssistant), ['feishu-cards']);
  assert.deepEqual(bundles.find(b => b.id === 'feishu-cards').channels, ['feishu']);
});

test('multi-bundle skill_bundle_refs union works and rejects cross-bundle version/origin conflicts with 400 skill_version_conflict', t => {
  const s = baseStore(t);
  const v1 = createConsoleSkill(s, 'r', {
    slug: 'deploy-flow',
    files: [{ path: 'SKILL.md', content: '---\nname: deploy-flow\ndescription: v1 deploy.\n---\nStep 1.' }],
  }, 'admin');
  const v2 = createConsoleSkill(s, 'r', {
    slug: 'extra-check',
    files: [{ path: 'SKILL.md', content: '---\nname: extra-check\ndescription: Extra checks.\n---\nCheck logs.' }],
  }, 'admin');

  const updatedDeploy = updateConsoleSkill(s, 'r', v1.skill.id, {
    expected_version: 1,
    files: [{ path: 'SKILL.md', content: '---\nname: deploy-flow\ndescription: v2 deploy.\n---\nStep 2.' }],
  }, 'admin');
  assert.equal(updatedDeploy.version.version, 2);

  // Valid multi-bundle union with overlapping identical skill (deduped cleanly).
  const ok = saveConfiguration(s, 'r', {
    expected_revision: 0,
    skills: [
      { id: 'kit-a', source: { type: 'library', items: [{ skill_id: v1.skill.id, version: 1 }] } },
      { id: 'kit-b', source: { type: 'library', items: [{ skill_id: v1.skill.id, version: 1 }, { skill_id: v2.skill.id, version: 1 }] } },
    ],
    roles: [{ role_id: 'dev', skill_bundle_refs: [{ id: 'kit-a' }, { id: 'kit-b' }] }],
  }, 'admin');
  assert.deepEqual(ok.roles.find(r => r.role_id === 'dev').skill_bundle_refs.map(r => r.id), ['kit-a', 'kit-b']);
  const devSnap = resolveRole(s, 'r', 'dev', 'task.request').snapshot.skills;
  assert.deepEqual(
    devSnap.files.map(f => f.path).sort(),
    ['project/deploy-flow/SKILL.md', 'project/extra-check/SKILL.md'],
  );

  // Conflicting versions of the same slug across two bundles on the same role -> 400 skill_version_conflict.
  assert.throws(() => saveConfiguration(s, 'r', {
    expected_revision: ok.revision,
    skills: [
      { id: 'kit-v1', source: { type: 'library', items: [{ skill_id: v1.skill.id, version: 1 }] } },
      { id: 'kit-v2', source: { type: 'library', items: [{ skill_id: v1.skill.id, version: 2 }] } },
    ],
    roles: [{ role_id: 'dev', skill_bundle_refs: [{ id: 'kit-v1' }, { id: 'kit-v2' }] }],
  }, 'admin'), err => err.status === 400 && err.code === 'skill_version_conflict' && err.detail?.slug === 'deploy-flow');
});

test('follows_default auto-follows latest built-in skill versions while custom projects pin v1 and surface upgrade notices (#1359)', async t => {
  const s = baseStore(t);
  s.run("INSERT INTO repositories VALUES('r2','fixture/custom','o','a')");
  s.run(
    "INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m2','r2','https://fixture.invalid/v1','fixture',?,'now')",
    s.secrets.seal({ value: 'fixture' }, 'model:m2'),
  );
  s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('r2','m2',1)");
  const customSaved = saveConfiguration(s, 'r2', {
    expected_revision: 0,
    roles: [{ role_id: 'dev', responsibility: 'Custom developer responsibility.' }],
  }, 'admin');
  assert.equal(customSaved.follows_default, undefined);
  assert.equal(customSaved.skills.find(b => b.id === 'dev-practices').source.items[0].version, 1);

  const dir = await mkdtemp(join(tmpdir(), 'builtin-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'test-driven-development'), { recursive: true });
  await writeFile(
    join(dir, 'test-driven-development', 'SKILL.md'),
    '---\nname: test-driven-development\ndescription: Upgraded TDD workflow v2.\n---\n# TDD v2\nAlways write a failing test first.\n',
    'utf8',
  );
  const synced = syncBuiltinSkills(s, { root: dir, imageTag: 'v2.0.0' });
  assert.equal(synced.updated, 1);

  // 1. follows_default project `r` automatically resolves v2 without any manual migration.
  const defaultCfg = roleConfiguration(s, 'r');
  assert.equal(defaultCfg.follows_default, true);
  assert.equal(
    defaultCfg.skills.find(b => b.id === 'dev-practices').source.items.find(i => i.skill_id === 'builtin:test-driven-development').version,
    2,
  );
  const rView = roleApi(s, adminActor, 'GET', new URL('http://local/api/repositories/r/roles'), {});
  assert.deepEqual(rView.bundle_upgrades, []);

  // 2. Saved custom project `r2` stays pinned to v1 and reports an explicit upgrade notice.
  const customCfg = roleConfiguration(s, 'r2');
  assert.equal(
    customCfg.skills.find(b => b.id === 'dev-practices').source.items.find(i => i.skill_id === 'builtin:test-driven-development').version,
    1,
  );
  const upgrades = detectBuiltinBundleUpgrades(s, customCfg.skills);
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].bundle_id, 'dev-practices');
  assert.deepEqual(upgrades[0].upgrades, [{
    skill_id: 'builtin:test-driven-development',
    slug: 'test-driven-development',
    name: 'test-driven-development',
    pinned_version: 1,
    latest_version: 2,
  }]);
  assert.equal(classifyProjectBundle(customCfg.skills.find(b => b.id === 'dev-practices')), 'builtin');

  const r2View = roleApi(s, { ...adminActor, repositoryIds: ['r2'] }, 'GET', new URL('http://local/api/repositories/r2/roles'), {});
  assert.equal(r2View.bundle_upgrades.length, 1);
  assert.equal(r2View.bundle_origins['dev-practices'], 'builtin');

  // 3. One-click upgrade saves v2 cleanly and clears the upgrade notice.
  const upgradedInputs = r2View.skill_inputs.map(b => b.id === 'dev-practices'
    ? { ...b, source: { ...b.source, items: b.source.items.map(i => i.skill_id === 'builtin:test-driven-development' ? { ...i, version: 2 } : i) } }
    : b);
  saveConfiguration(s, 'r2', { expected_revision: customCfg.revision, skills: upgradedInputs }, 'admin');
  const r2After = roleApi(s, { ...adminActor, repositoryIds: ['r2'] }, 'GET', new URL('http://local/api/repositories/r2/roles'), {});
  assert.deepEqual(r2After.bundle_upgrades, []);
  const devFiles = skillFiles(s, 'r2', resolveRole(s, 'r2', 'dev', 'task.request').snapshot.skills);
  assert.match(devFiles.find(f => f.path === 'defaults/test-driven-development/SKILL.md').content, /# TDD v2/);
});

test('service roles configure skill_bundle_ids and automatically filter Feishu-only bundles on Web console turns (#1359)', t => {
  const s = baseStore(t);
  serviceRoleStorage(s);

  const webDefault = resolveServiceRoleSkills(s, null, managementAssistant, 'web');
  assert.deepEqual(webDefault.bundleIds, ['ci-gates']);
  assert.deepEqual(webDefault.skills.map(sk => sk.slug), ['layered-ci-gates']);

  const feishuDefault = resolveServiceRoleSkills(s, null, managementAssistant, 'feishu');
  assert.deepEqual(feishuDefault.bundleIds, ['ci-gates', 'feishu-cards']);
  assert.deepEqual(feishuDefault.skills.map(sk => sk.slug), ['layered-ci-gates', 'feishu-cards']);
  assert.match(readSkill({ path: 'feishu-cards/SKILL.md' }, feishuDefault).content, /feishu/i);
  assert.throws(() => readSkill({ path: 'feishu-cards/SKILL.md' }, webDefault), err => err.status === 400 && err.code === 'skill_file_not_found');

  const listBefore = listServiceRoles(s);
  assert.ok(listBefore.skill_bundles.some(b => b.id === 'feishu-cards' && b.channels?.includes('feishu')));
  const mgmt = serviceRole(s, managementAssistant);
  const updated = updateServiceRole(s, 'admin', managementAssistant, { expected_revision: mgmt.revision, skill_bundle_ids: [] });
  assert.deepEqual(updated.skill_bundle_ids, []);
  assert.deepEqual(updated.effective_skill_bundle_ids, []);
  const webEmpty = resolveServiceRoleSkills(s, parseStoredServiceSkillBundles(serviceRole(s, managementAssistant).skill_bundle_ids), managementAssistant, 'web');
  assert.deepEqual(webEmpty.skills, []);

  assert.throws(() => updateServiceRole(s, 'admin', managementAssistant, {
    expected_revision: updated.revision,
    skill_bundle_ids: ['non-existent-bundle'],
  }), err => err.status === 400 && err.code === 'skill_bundle_not_found');

  const restored = updateServiceRole(s, 'admin', managementAssistant, { expected_revision: updated.revision, skill_bundle_ids: null });
  assert.equal(restored.skill_bundle_ids, null);
  assert.deepEqual(restored.effective_skill_bundle_ids, ['ci-gates', 'feishu-cards']);
});

test('startup migration:1359 migrates legacy inline/repository bundles to library, backfills built-in bundles, preserves snapshots/revisions and leaves follows_default untouched', t => {
  const s = baseStore(t);
  s.run("INSERT INTO repositories VALUES('r_default','fixture/default','o','a')");
  s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('r_default','m',1)");

  const looseFiles = [{ path: 'guide.md', content: 'Always verify DB migrations.', sha256: 'sha-loose', bytes: 28 }];
  const validMd = '---\nname: team-check\ndescription: Valid team checklist.\n---\n# Team Check\nRun lint.';
  const validFiles = [{ path: 'SKILL.md', content: validMd, sha256: 'sha-valid', bytes: Buffer.byteLength(validMd) }];
  const repoMd = '---\nname: repo-skill\ndescription: Pinned repo skill.\n---\n# Repo Skill\nFollow repo conventions.';
  const repoFiles = [{ path: '.agents/skills/repo-skill/SKILL.md', content: repoMd, sha256: 'sha-repo', bytes: Buffer.byteLength(repoMd) }];

  s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)', 'r', 'loose-kit', 1, JSON.stringify({ type: 'inline', commit: null }), JSON.stringify(looseFiles), 'hash-loose', '2026-01-01T00:00:00Z');
  s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)', 'r', 'valid-kit', 1, JSON.stringify({ type: 'inline', commit: null }), JSON.stringify(validFiles), 'hash-valid', '2026-01-01T00:00:00Z');
  s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)', 'r', 'repo-kit', 1, JSON.stringify({ type: 'repository', path_root: '.agents/skills', commit: 'a'.repeat(40), paths: ['.agents/skills/repo-skill/SKILL.md'] }), JSON.stringify(repoFiles), 'hash-repo', '2026-01-01T00:00:00Z');

  const preConfig = {
    schema: 2,
    revision: 1,
    enabled: true,
    controller: { role: 'manager', entries: { development: true, request: true, review: true, actions: true } },
    skills: [
      { id: 'loose-kit', revision: 1, content_hash: 'hash-loose', source: { type: 'inline', commit: null }, files: [{ path: 'guide.md', sha256: 'sha-loose', bytes: 28 }] },
      { id: 'valid-kit', revision: 1, content_hash: 'hash-valid', source: { type: 'inline', commit: null }, files: [{ path: 'SKILL.md', sha256: 'sha-valid', bytes: Buffer.byteLength(validMd) }] },
      { id: 'repo-kit', revision: 1, content_hash: 'hash-repo', source: { type: 'repository', path_root: '.agents/skills', commit: 'a'.repeat(40), paths: ['.agents/skills/repo-skill/SKILL.md'] }, files: [{ path: '.agents/skills/repo-skill/SKILL.md', sha256: 'sha-repo', bytes: Buffer.byteLength(repoMd) }] },
    ],
    roles: [
      { role_id: 'manager', revision: 1, enabled: true, kind: 'controller', name: 'Manager', responsibility: 'Manage', persona_prompt: 'Manage', model_profile_ref: null, skill_bundle_ref: { id: 'valid-kit', revision: 1, content_hash: 'hash-valid' }, harness_ref: { id: 'pi', version: '1.4.0' }, permissions: normalizePermissions({}), environment_profile_ref: { id: 'control-session', version: '1.0.0' }, budget_policy_ref: { id: 'entry-default', version: '1.0.0' }, output_schema_ref: { id: 'delivery-nomination', version: '1.0.0' } },
      { role_id: 'dev', revision: 1, enabled: true, kind: 'writer', name: 'Developer', responsibility: 'Code', persona_prompt: 'Code', model_profile_ref: null, skill_bundle_ref: { id: 'loose-kit', revision: 1, content_hash: 'hash-loose' }, harness_ref: { id: 'pi', version: '1.4.0' }, permissions: normalizePermissions({}), environment_profile_ref: { id: 'task-workspace', version: '1.0.0' }, budget_policy_ref: { id: 'entry-default', version: '1.0.0' }, output_schema_ref: { id: 'entry-delivery', version: '1.0.0' } },
      { role_id: 'reviewer', revision: 1, enabled: true, kind: 'observer', name: 'Reviewer', responsibility: 'Review', persona_prompt: 'Review', model_profile_ref: null, skill_bundle_ref: { id: 'repo-kit', revision: 1, content_hash: 'hash-repo' }, harness_ref: { id: 'pi', version: '1.4.0' }, permissions: normalizePermissions({}), environment_profile_ref: { id: 'candidate-checkout', version: '1.0.0' }, budget_policy_ref: { id: 'entry-default', version: '1.0.0' }, output_schema_ref: { id: 'role-findings', version: '1.0.0' } },
      { role_id: 'qa', revision: 1, enabled: true, kind: 'evaluator', name: 'Independent QA', responsibility: 'QA', persona_prompt: 'QA', model_profile_ref: null, skill_bundle_ref: null, harness_ref: { id: 'pi', version: '1.4.0' }, permissions: normalizePermissions({}), environment_profile_ref: { id: 'evaluation-checkout', version: '1.0.0' }, budget_policy_ref: { id: 'entry-default', version: '1.0.0' }, output_schema_ref: { id: 'acceptance-verdict', version: '1.0.0' } },
    ],
  };
  const preConfigJson = JSON.stringify(preConfig);
  s.run("INSERT INTO settings VALUES('roles:r',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", preConfigJson);
  s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?)', 'r', 1, preConfigJson, 'pre-hash', 'admin', '2026-01-01T00:00:00Z');
  const frozenSnapshot = JSON.stringify({ schema: 2, role_id: 'dev', frozen: true });
  s.run('INSERT INTO role_snapshots VALUES(?,?,?,?,?,?,?)', 'snap-legacy-1', 'r', 'dev', 1, 1, frozenSnapshot, '2026-01-01T00:00:00Z');
  const followMarker = JSON.stringify({ schema: 2, revision: 1, follows_default: true });
  s.run("INSERT INTO settings VALUES('roles:r_default',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", followMarker);

  s.run("DELETE FROM settings WHERE key='migration:1359:skill-bundles-v3'");
  migrateSkillsToLibraryV3(s);

  // 1. Historical role_snapshot and revision 1 are preserved byte-for-byte.
  assert.equal(s.get("SELECT snapshot FROM role_snapshots WHERE id='snap-legacy-1'").snapshot, frozenSnapshot);
  assert.equal(s.get("SELECT config FROM role_config_revisions WHERE repository_id='r' AND revision=1").config, preConfigJson);

  // 2. r_default stays untouched as follows_default.
  assert.equal(s.get("SELECT value FROM settings WHERE key='roles:r_default'").value, followMarker);

  // 3. Migrated custom project has revision 2 with library bundles + backfilled built-in bundles.
  const after = roleConfiguration(s, 'r');
  assert.equal(after.revision, 2);
  assert.equal(after.updated_by, 'migration:1359');
  const looseBundle = after.skills.find(b => b.id === 'loose-kit');
  assert.equal(looseBundle.source.type, 'library');
  assert.equal(looseBundle.source.migrated_needs_review, true);
  const validBundle = after.skills.find(b => b.id === 'valid-kit');
  assert.equal(validBundle.source.type, 'library');
  assert.equal(validBundle.source.migrated_needs_review, undefined);
  const repoBundle = after.skills.find(b => b.id === 'repo-kit');
  assert.equal(repoBundle.source.type, 'library');
  assert.ok(after.skills.some(b => b.id === 'planning' && b.origin === 'builtin'));
  assert.ok(after.skills.some(b => b.id === 'ci-gates' && b.origin === 'builtin'));
  assert.ok(after.skills.some(b => b.id === 'dev-practices' && b.origin === 'builtin'));

  assert.deepEqual(after.roles.find(r => r.role_id === 'manager').skill_bundle_refs.map(r => r.id), ['valid-kit', 'planning', 'ci-gates']);
  assert.deepEqual(after.roles.find(r => r.role_id === 'dev').skill_bundle_refs.map(r => r.id), ['loose-kit', 'ci-gates', 'dev-practices']);
  assert.deepEqual(after.roles.find(r => r.role_id === 'reviewer').skill_bundle_refs.map(r => r.id), ['repo-kit', 'ci-gates']);
  assert.deepEqual(after.roles.find(r => r.role_id === 'qa').skill_bundle_refs, []);

  const projectLib = listSkills(s, 'r', { include_builtin: false });
  assert.equal(projectLib.total, 3);

  // 4. Migration is strictly one-shot / idempotent.
  migrateSkillsToLibraryV3(s);
  assert.equal(roleConfiguration(s, 'r').revision, 2);
});

test('independent pre-upgrade regression: adding skill_bundle_ids column preserves ChannelServiceBindings.fence() byte-for-byte (#1359)', t => {
  const s = new Store(':memory:', randomBytes(32));
  t.after(() => s.close());
  identityStorage(s);
  channelStorage(s);
  serviceRoleStorage(s);

  // Construct a genuine pre-#1359 `channel_service_bindings` table WITHOUT `skill_bundle_ids`.
  s.db.exec(`
    DROP TABLE IF EXISTS channel_service_bindings;
    CREATE TABLE channel_service_bindings(
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      service_role_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      principal_id TEXT NOT NULL UNIQUE,
      configured_by TEXT NOT NULL,
      participation TEXT NOT NULL DEFAULT 'mentions',
      enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      migrated_from TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      owner_id TEXT NOT NULL DEFAULT '',
      permissions TEXT,
      model_id TEXT,
      prompt TEXT,
      harness TEXT NOT NULL DEFAULT 'pi'
    );
  `);
  const now = Date.now();
  s.run("INSERT INTO users(id,username,password_hash,role,active) VALUES('p-owner','owner','hash','super_admin',1)");
  s.run("UPDATE principals SET authorization_revision=3 WHERE id='p-owner'");
  s.run("INSERT INTO principals(id,kind,authorization_revision,active) VALUES('p-group','service',7,1)");
  s.run(
    "INSERT INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at) VALUES('conn-1','feishu','cli_1','t1','ou_bot','self_built','websocket','cred-1',1,1,?)",
    now,
  );
  s.run(
    "INSERT INTO channel_chats(id,provider,app_id,installation_tenant,chat_id,chat_type,connector_id,state,revision,context_revision,created_at,last_received_at) VALUES('chat-1','feishu','cli_1','t1','oc_1','group','conn-1','active',1,5,?,?)",
    now, now,
  );
  const perms = normalizePermissions({ github_issues: 'read', github_pull_requests: 'read', project_tasks: 'read' }, true);
  s.run(
    `INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,participation,enabled,revision,migrated_from,created_at,updated_at,owner_id,permissions,model_id,prompt,harness)
     VALUES('bind-1','chat-1','group-assistant','repositories','p-group','p-owner','mentions',1,4,NULL,?,?,'p-owner',?,NULL,'Custom group prompt','pi')`,
    now, now,
    JSON.stringify(perms),
  );
  s.run(
    `INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
     VALUES('grant-1','p-group','t1','repo-1','project','service','["tasks.read"]','explicit_delegation','p-owner','channel_service_binding','channel:chat-1',?)`,
    now,
  );
  s.run("INSERT INTO settings VALUES('channel_service_bindings_migrated','2026-01-01T00:00:00Z') ON CONFLICT(key) DO NOTHING");
  s.run("INSERT INTO settings VALUES('migration:1249:group-assistant-inline','2026-01-01T00:00:00Z') ON CONFLICT(key) DO NOTHING");

  // Independently compute the pre-#1359 fence formula before serviceBindingStorage alters the schema.
  const expectedFence = digest(JSON.stringify({
    context: 5,
    binding: ['bind-1', 4, 1, 7],
    role: ['group-assistant', 1, JSON.stringify(perms)],
    grants: [['grant-1', 3]],
  }));
  const bindings = new ChannelServiceBindings(s, new ChannelEmployees(s));
  const beforeUpgradeFence = bindings.fence('chat-1');
  assert.equal(beforeUpgradeFence, expectedFence, 'pre-upgrade fence matches independent SHA-256 formula');

  serviceBindingStorage(s);

  const row = s.get("SELECT * FROM channel_service_bindings WHERE chat_id='chat-1'");
  assert.equal(row.revision, 4, 'untouched binding revision must not change on schema upgrade');
  assert.equal(row.skill_bundle_ids, null, 'existing binding defaults to NULL (follows built-in group defaults)');

  const actualFence = bindings.fence('chat-1');
  assert.equal(actualFence, expectedFence, 'ChannelServiceBindings.fence() must remain byte-for-byte identical after upgrading schema');
});
