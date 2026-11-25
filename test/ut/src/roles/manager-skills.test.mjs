import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { roleConfiguration, resolveRole, saveConfiguration, skillFiles } from '../../../../dist/roles/definition.js';
import { materializeSkillSet, projectSkillScope } from '../../../../dist/roles/skill-store.js';

function fixture(t) {
  const s = new Store(':memory:', randomBytes(32));
  t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/manager','o','a')");
  s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r','https://fixture.invalid/v1','fixture',?,'now')", s.secrets.seal({ value: 'fixture' }, 'model:m'));
  s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('r','m',1)");
  return s;
}
const resolve = (s, options) => resolveRole(s, 'r', 'manager', 'development.issue', options);
const source = content => ({
  id: 'custom',
  source: {
    type: 'inline',
    files: [
      { path: 'SKILL.md', content: '---\nname: project\ndescription: Project conventions.\n---\n' + content },
      { path: 'notes.txt', content: 'Keep this relative reference.' },
    ],
  },
});
const planningInput = {
  id: 'planning',
  origin: 'builtin',
  source: { type: 'library', origin: 'builtin', builtin_id: 'planning', items: [{ skill_id: 'builtin:roadmap-decomposition', version: 1 }] },
};
const bindManagerWithPlanning = (s, bundle) => saveConfiguration(s, 'r', {
  expected_revision: roleConfiguration(s, 'r').revision,
  skills: [planningInput, bundle],
  roles: [{ role_id: 'manager', skill_bundle_refs: [{ id: 'planning' }, { id: bundle.id }] }],
}, 'fixture');

test('default projects explicitly bind built-in skill bundles per role without writing previews or changing prompts (#1359)', t => {
  const s = fixture(t), before = roleConfiguration(s, 'r');
  assert.deepEqual(before.skills.map(b => b.id), ['planning', 'ci-gates', 'dev-practices']);
  assert.deepEqual(before.roles.find(r => r.role_id === 'manager').skill_bundle_refs.map(r => r.id), ['planning', 'ci-gates']);
  assert.deepEqual(before.roles.find(r => r.role_id === 'dev').skill_bundle_refs.map(r => r.id), ['ci-gates', 'dev-practices']);
  assert.deepEqual(before.roles.find(r => r.role_id === 'reviewer').skill_bundle_refs.map(r => r.id), ['ci-gates']);
  assert.deepEqual(before.roles.find(r => r.role_id === 'test').skill_bundle_refs.map(r => r.id), ['dev-practices']);
  assert.deepEqual(before.roles.find(r => r.role_id === 'qa').skill_bundle_refs, []);

  const preview = resolve(s, { persist: false });
  assert.ok(preview.snapshot.skills.files.some(f => f.path === 'defaults/roadmap-decomposition/SKILL.md'));
  assert.ok(preview.snapshot.skills.files.some(f => f.path === 'defaults/layered-ci-gates/SKILL.md'));
  assert.equal(s.get('SELECT count(*) n FROM skill_bundle_revisions').n, 0, 'preview stores no skill revisions');
  assert.equal(s.get('SELECT count(*) n FROM role_snapshots').n, 0);

  const persisted = resolve(s);
  assert.equal(persisted.id, preview.id);
  assert.deepEqual(persisted.definition.permissions, before.roles.find(r => r.role_id === 'manager').permissions);
  assert.ok(!persisted.system.includes('Progressive roadmap decomposition'), 'body stays out of the system prompt');
  assert.deepEqual(roleConfiguration(s, 'r'), before);

  // Saving without skills freezes the built-in bundles and keeps default bindings intact.
  const saved = saveConfiguration(s, 'r', { expected_revision: 0, roles: [{ role_id: 'manager', harness_ref: { id: 'pi' } }] }, 'fixture');
  const stored = s.get("SELECT value FROM settings WHERE key='roles:r'").value;
  assert.deepEqual(saved.roles.find(r => r.role_id === 'manager').skill_bundle_refs.map(r => r.id), ['planning', 'ci-gates']);
  const current = resolve(s);
  assert.ok(current.snapshot.skills);
  assert.equal(s.get("SELECT value FROM settings WHERE key='roles:r'").value, stored);

  // Dev receives dev-practices + ci-gates explicitly; QA has no skills by default.
  const devSnap = resolveRole(s, 'r', 'dev', 'development.issue').snapshot.skills;
  assert.ok(devSnap.files.some(f => f.path === 'defaults/test-driven-development/SKILL.md'));
  assert.ok(devSnap.files.some(f => f.path === 'defaults/systematic-debugging/SKILL.md'));
  assert.ok(devSnap.files.some(f => f.path === 'defaults/layered-ci-gates/SKILL.md'));
  assert.equal(resolveRole(s, 'r', 'qa', 'development.issue').snapshot.skills, null);

  // Explicitly unbinding all bundles from Manager removes built-in skills (no hidden hardcoded fallback).
  saveConfiguration(s, 'r', { expected_revision: saved.revision, roles: [{ role_id: 'manager', skill_bundle_refs: [] }] }, 'fixture');
  assert.equal(resolve(s).snapshot.skills, null);
});

test('multi-bundle project files coexist with built-in bundles and old snapshots retain their pinned contents', t => {
  const s = fixture(t), first = bindManagerWithPlanning(s, source('Original project material.'));
  const customRef = first.roles.find(r => r.role_id === 'manager').skill_bundle_refs.find(r => r.id === 'custom');
  const old = resolve(s), files = skillFiles(s, 'r', old.snapshot.skills);
  assert.equal(files.find(f => f.path === 'project/SKILL.md').content, skillFiles(s, 'r', customRef).find(f => f.path === 'SKILL.md').content);
  assert.equal(files.find(f => f.path === 'project/notes.txt').content, 'Keep this relative reference.');
  assert.equal(files.some(f => f.path === 'defaults/roadmap-decomposition/SKILL.md'), true);
  assert.deepEqual(old.snapshot.skills.source.bundles.map(b => b.id), ['planning', 'custom']);

  bindManagerWithPlanning(s, source('Updated project material.'));
  const count = s.get('SELECT count(*) n FROM skill_bundle_revisions').n;
  const preview = resolve(s, { persist: false });
  assert.equal(s.get('SELECT count(*) n FROM skill_bundle_revisions').n, count);
  const next = resolve(s);
  assert.equal(next.id, preview.id);
  assert.notEqual(next.id, old.id);
  assert.match(skillFiles(s, 'r', next.snapshot.skills).find(f => f.path === 'project/SKILL.md').content, /Updated project material/);
  assert.match(skillFiles(s, 'r', old.snapshot.skills).find(f => f.path === 'project/SKILL.md').content, /Original project material/);
  assert.equal(s.get('SELECT snapshot FROM role_snapshots WHERE id=?', old.id).snapshot, JSON.stringify(old.snapshot));
  const savedCount = s.get('SELECT count(*) n FROM skill_bundle_revisions').n;
  assert.equal(resolve(s, { configuration: first }).id, old.id, 'a frozen older task reuses its exact effective snapshot');
  assert.equal(resolve(s).id, next.id, 'alternating old and new tasks does not churn skill revisions');
  assert.equal(s.get('SELECT count(*) n FROM skill_bundle_revisions').n, savedCount);
  assert.deepEqual(roleConfiguration(s, 'r').roles.find(r => r.role_id === 'manager').skill_bundle_refs.map(r => r.id), ['planning', 'custom']);
});

test('native Pi discovers built-in bundle skills beside a project root SKILL and keeps its support files', async t => {
  const s = fixture(t);
  bindManagerWithPlanning(s, source('Read notes.txt relative to this Skill.'));
  const root = await mkdtemp(join(tmpdir(), 'manager-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { loadSkillsFromDir } = await import('../../../../runner/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js');
  const set = materializeSkillSet({ root, scope: projectSkillScope('r'), files: skillFiles(s, 'r', resolve(s).snapshot.skills) });
  const loaded = loadSkillsFromDir({ dir: set.hostSkillsDir, source: 'user' });
  assert.deepEqual(loaded.skills.map(s => s.name).sort(), ['project', 'roadmap-decomposition']);
});

test('repository skill roots stay discoverable beside built-in bundles rather than hiding below .agents', async t => {
  const s = fixture(t), path = '.agents/skills/team/SKILL.md', content = '---\nname: team\ndescription: Team guidance.\n---\nProject guidance.';
  const { createHash } = await import('node:crypto'), sha256 = createHash('sha256').update(content).digest('hex');
  const files = [{ path, content, sha256, bytes: Buffer.byteLength(content) }], ref = { id: 'repo', revision: 1, content_hash: 'pinned-repository-files' };
  const config = roleConfiguration(s, 'r'), bundle = { ...ref, source: { type: 'repository', commit: 'a'.repeat(40), paths: [path] }, files: files.map(({ content, ...f }) => f) };
  s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)', 'r', ref.id, 1, JSON.stringify(bundle.source), JSON.stringify(files), ref.content_hash, 'now');
  const planningBundle = config.skills.find(b => b.id === 'planning');
  const planningRef = { id: planningBundle.id, revision: planningBundle.revision, content_hash: planningBundle.content_hash };
  const configuration = {
    ...config,
    skills: [planningBundle, bundle],
    roles: config.roles.map(r => r.role_id === 'manager' ? { ...r, skill_bundle_ref: planningRef, skill_bundle_refs: [planningRef, ref] } : r),
  };
  const resolved = resolve(s, { configuration }), root = await mkdtemp(join(tmpdir(), 'manager-repo-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const set = materializeSkillSet({ root, scope: projectSkillScope('r'), files: skillFiles(s, 'r', resolved.snapshot.skills) });
  const { loadSkillsFromDir } = await import('../../../../runner/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js');
  assert.deepEqual(loadSkillsFromDir({ dir: set.hostSkillsDir, source: 'user' }).skills.map(s => s.name).sort(), ['roadmap-decomposition', 'team']);
});

test('built-in ci-gates bundle explicitly supplies layered-ci-gates to Manager, Dev and Reviewer and can be combined with project skills (#1359)', async t => {
  const s = fixture(t);
  for (const roleId of ['manager', 'dev', 'reviewer']) {
    const resolved = resolveRole(s, 'r', roleId, 'development.issue');
    const paths = resolved.snapshot.skills.files.map(f => f.path);
    assert.ok(paths.includes('defaults/layered-ci-gates/SKILL.md'), `${roleId} includes layered-ci-gates`);
    assert.ok(paths.includes('defaults/layered-ci-gates/references/layers.md'), `${roleId} includes references`);
    assert.match(skillFiles(s, 'r', resolved.snapshot.skills).find(f => f.path === 'defaults/layered-ci-gates/references/report.md').content, /# Recommendation report/);
  }
  assert.equal(resolveRole(s, 'r', 'qa', 'development.issue').snapshot.skills, null, 'QA stays clean by default');

  // Combining ci-gates + custom project bundle on Dev discovers both in native Pi with zero diagnostics.
  const ciInput = {
    id: 'ci-gates',
    origin: 'builtin',
    source: { type: 'library', origin: 'builtin', builtin_id: 'ci-gates', items: [{ skill_id: 'builtin:layered-ci-gates', version: 1 }] },
  };
  saveConfiguration(s, 'r', {
    expected_revision: 0,
    skills: [ciInput, { ...source('Project CI conventions.'), id: 'dev-custom' }],
    roles: [{ role_id: 'dev', skill_bundle_refs: [{ id: 'ci-gates' }, { id: 'dev-custom' }] }],
  }, 'fixture');
  const bound = resolveRole(s, 'r', 'dev', 'development.issue');
  const files = skillFiles(s, 'r', bound.snapshot.skills);
  assert.equal(files.find(f => f.path === 'project/notes.txt').content, 'Keep this relative reference.');
  const root = await mkdtemp(join(tmpdir(), 'ci-change-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { loadSkillsFromDir } = await import('../../../../runner/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js');
  const set = materializeSkillSet({ root, scope: projectSkillScope('r'), files });
  const loaded = loadSkillsFromDir({ dir: set.hostSkillsDir, source: 'user' });
  assert.deepEqual(loaded.skills.map(s => s.name).sort(), ['layered-ci-gates', 'project']);
  assert.deepEqual(loaded.diagnostics ?? [], []);
});

test('configured custom skill bundles on non-QA roles coexist with trusted base-branch .agents/skills/ while QA stays excluded (#1359)', async t => {
  const s = fixture(t);
  const config = bindManagerWithPlanning(s, { ...source('Custom Dev conventions.'), id: 'dev-custom' });
  saveConfiguration(s, 'r', {
    expected_revision: config.revision,
    roles: [
      { role_id: 'dev', skill_bundle_ref: { id: 'dev-custom' } },
      { role_id: 'reviewer', skill_bundle_ref: { id: 'dev-custom' } },
      { role_id: 'qa', skill_bundle_ref: { id: 'dev-custom' } },
    ],
  }, 'fixture');
  const repositorySkills = { sha: 'b'.repeat(40), files: { '.agents/skills/repo-ops/SKILL.md': '---\nname: repo-ops\ndescription: Trusted repo operations.\n---\nRun repo checks.' } };
  for (const roleId of ['dev', 'reviewer', 'manager']) {
    const resolved = resolveRole(s, 'r', roleId, 'task.request', { repositorySkills });
    const paths = resolved.snapshot.skills.files.map(f => f.path);
    assert.ok(paths.includes('repository/repo-ops/SKILL.md'), `${roleId} must auto-overlay trusted .agents/skills/ alongside configured bundle`);
    assert.ok(paths.includes('project/SKILL.md'), `${roleId} must retain configured custom bundle`);
  }
  const qa = resolveRole(s, 'r', 'qa', 'task.request', { repositorySkills });
  const qaPaths = qa.snapshot.skills.files.map(f => f.path);
  assert.ok(qaPaths.includes('SKILL.md'), 'QA retains explicit custom bundle');
  assert.ok(!qaPaths.some(p => p.includes('repo-ops')), 'QA (evaluator) must not auto-overlay repository .agents/skills/');
});
