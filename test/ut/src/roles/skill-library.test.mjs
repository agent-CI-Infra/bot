import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { RuleService } from '../../../../dist/rules/service.js';
import {
  builtinSkillId,
  createConsoleSkill,
  deleteProjectSkill,
  extractSkillsFromTrustedGitTree,
  getSkill,
  getSkillVersion,
  importRepositorySkills,
  LIBRARY_BUNDLE_MAX_BYTES,
  LIBRARY_BUNDLE_MAX_FILES,
  LIBRARY_BUNDLE_MAX_ITEMS,
  listSkills,
  listSkillVersions,
  MAX_SKILL_BUNDLES,
  parseStrictSkillFrontmatter,
  projectSkillId,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  syncBuiltinSkills,
  updateConsoleSkill,
} from '../../../../dist/roles/skill-library.js';
import { resolveRole, saveConfiguration, skillFiles } from '../../../../dist/roles/definition.js';
import { materializeSkillSet, projectSkillScope } from '../../../../dist/roles/skill-store.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function setupStore(t) {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a1','acc','bot_account',NULL,?,?)", store.secrets.seal({ token: 'ghp_secret_value_1234567890' }, 'account:a1'), 'now');
  for (const [id, name] of [['101', 'acme/alpha'], ['102', 'acme/beta']]) {
    store.run("INSERT INTO repositories VALUES(?,?,'10','a1')", id, name);
    store.run('INSERT INTO policies(repository_id) VALUES(?)', id);
    store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES(?,?,?,'gpt-test',?,1,'now')", 'm-' + id, id, 'https://model.example/v1', store.secrets.seal({ value: 'sk-test-key-secret-value' }, 'model:m-' + id));
    store.run('UPDATE policies SET model_id=? WHERE repository_id=?', 'm-' + id, id);
  }
  return store;
}

function validSkillMd(name, description = 'Structured workflow guidance for testing.', body = '# Instructions\n\nFollow the checklist.\n') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

test('startup built-in skill sync registers all built-in skills, dedups unchanged restarts, and mints new immutable versions on change', t => {
  const store = setupStore(t);
  const listed = listSkills(store, '101', { origin: 'builtin' });
  const slugs = listed.skills.map(s => s.slug).sort();
  assert.deepEqual(slugs, ['feishu-cards', 'layered-ci-gates', 'roadmap-decomposition', 'systematic-debugging', 'test-driven-development']);
  for (const skill of listed.skills) {
    assert.equal(skill.id, builtinSkillId(skill.slug));
    assert.equal(skill.latest_version, 1);
    assert.equal(skill.can_edit, false);
    assert.equal(skill.repository_id, null);
  }
  // Whole-directory preservation for built-in skills (includes LICENSE, SOURCES.json, references/*).
  const ciDetail = getSkill(store, '101', 'builtin:layered-ci-gates');
  const ciPaths = ciDetail.version.files.map(f => f.path);
  assert.ok(ciPaths.includes('SKILL.md'));
  assert.ok(ciPaths.includes('SOURCES.json'));
  assert.ok(ciPaths.includes('LICENSE'));
  assert.ok(ciPaths.includes('references/layers.md'));

  // Re-syncing unchanged content produces zero new versions.
  const repeat = syncBuiltinSkills(store, { strict: true });
  assert.equal(repeat.created, 0);
  assert.equal(repeat.updated, 0);
  assert.equal(repeat.unchanged, 5);

  // Override directory updates one built-in skill and adds a new one; v1 remains immutable.
  const overrideDir = mkdtempSync(join(tmpdir(), 'bot-builtin-sync-'));
  t.after(() => rmSync(overrideDir, { recursive: true, force: true }));
  mkdirSync(join(overrideDir, 'roadmap-decomposition', 'references'), { recursive: true });
  writeFileSync(join(overrideDir, 'roadmap-decomposition', 'SKILL.md'), validSkillMd('roadmap-decomposition', 'Updated built-in roadmap guidance v2.', '# v2 body\n'));
  writeFileSync(join(overrideDir, 'roadmap-decomposition', 'references', 'extra.md'), '# Extra notes\n');
  mkdirSync(join(overrideDir, 'custom-builtin'), { recursive: true });
  writeFileSync(join(overrideDir, 'custom-builtin', 'SKILL.md'), validSkillMd('custom-builtin', 'Shipped via BOT_SKILLS_DIR override.'));

  const v1Before = getSkillVersion(store, '101', 'builtin:roadmap-decomposition', 1).version;
  const synced = syncBuiltinSkills(store, { root: overrideDir, imageTag: 'deploy-test-2', strict: true });
  assert.equal(synced.created, 1);
  assert.equal(synced.updated, 1);

  const v2 = getSkill(store, '101', 'builtin:roadmap-decomposition');
  assert.equal(v2.skill.latest_version, 2);
  assert.equal(v2.version.source_meta.image_tag, 'deploy-test-2');
  assert.equal(v2.versions.length, 2);
  // v1 stayed byte-for-byte immutable.
  const v1After = getSkillVersion(store, '101', 'builtin:roadmap-decomposition', 1).version;
  assert.equal(v1After.content_hash, v1Before.content_hash);
  assert.notEqual(v2.version.content_hash, v1After.content_hash);

  // Symlink inside a built-in skill directory is rejected fail-closed.
  const symlinkDir = mkdtempSync(join(tmpdir(), 'bot-builtin-sym-'));
  t.after(() => rmSync(symlinkDir, { recursive: true, force: true }));
  mkdirSync(join(symlinkDir, 'bad-link'), { recursive: true });
  writeFileSync(join(symlinkDir, 'bad-link', 'SKILL.md'), validSkillMd('bad-link', 'Has symlink escape.'));
  symlinkSync('/etc/hosts', join(symlinkDir, 'bad-link', 'escape.txt'));
  assert.throws(() => syncBuiltinSkills(store, { root: symlinkDir, strict: true }), /invalid_skill_file/);
});

test('console skills enforce strict SKILL.md frontmatter, safe companion/controlled assets, size limits, secret redaction, optimistic lock, and project isolation', t => {
  const store = setupStore(t);

  // Invalid frontmatter cases
  assert.throws(() => parseStrictSkillFrontmatter('# No frontmatter'), { code: 'invalid_skill_frontmatter' });
  assert.throws(() => parseStrictSkillFrontmatter('---\nname: only-name\n---\nbody'), { code: 'invalid_skill_frontmatter' });
  assert.throws(() => parseStrictSkillFrontmatter('---\ndescription: only-desc\n---\nbody'), { code: 'invalid_skill_frontmatter' });

  // Path traversal, unknown binary, duplicate files, oversized file (>512 KiB), oversized skill (>8 MiB), >256 files
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'bad-path',
    files: [{ path: 'SKILL.md', content: validSkillMd('bad-path') }, { path: '../escape.md', content: 'nope' }],
  }, 'u1'), { code: 'invalid_skill_file' });
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'bad-bin',
    files: [{ path: 'SKILL.md', content: validSkillMd('bad-bin') }, { path: 'bin/payload.exe', content: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]).toString('base64'), encoding: 'base64' }],
  }, 'u1'), { code: 'invalid_skill_file' });
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'bad-nul',
    files: [{ path: 'SKILL.md', content: validSkillMd('bad-nul') }, { path: 'notes.txt', content: 'hello\0world' }],
  }, 'u1'), { code: 'invalid_skill_file' });
  // File/directory prefix conflicts (direct and non-adjacent with sibling `a/b-extra`) must be rejected
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'prefix-conflict',
    files: [
      { path: 'SKILL.md', content: validSkillMd('prefix-conflict') },
      { path: 'scripts', content: 'plain file' },
      { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n' },
    ],
  }, 'u1'), { code: 'invalid_skill_file', field: 'scripts' });
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'nested-prefix-conflict',
    files: [
      { path: 'SKILL.md', content: validSkillMd('nested-prefix-conflict') },
      { path: 'a/b', content: 'file at ancestor' },
      { path: 'a/b-extra', content: 'sibling between a/b and a/b/c' },
      { path: 'a/b/c.txt', content: 'descendant' },
    ],
  }, 'u1'), { code: 'invalid_skill_file', field: 'a/b' });
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'big-file',
    files: [{ path: 'SKILL.md', content: validSkillMd('big-file') }, { path: 'references/huge.md', content: 'a'.repeat(SKILL_MAX_FILE_BYTES + 1) }],
  }, 'u1'), { code: 'skill_file_too_large' });
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'big-skill',
    files: [
      { path: 'SKILL.md', content: validSkillMd('big-skill') },
      ...Array.from({ length: 17 }, (_, i) => ({ path: `references/part-${i}.md`, content: 'x'.repeat(500 * 1024) })),
    ],
  }, 'u1'), { code: 'skill_file_too_large' });
  assert.equal(SKILL_MAX_TOTAL_BYTES, 8 * 1024 * 1024);
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'many-files',
    files: [
      { path: 'SKILL.md', content: validSkillMd('many-files') },
      ...Array.from({ length: SKILL_MAX_FILES }, (_, i) => ({ path: `references/f${i}.md`, content: 'ok' })),
    ],
  }, 'u1'), { code: 'too_many_skill_files' });

  // Valid creation with companion script, controlled PNG asset, and secret redaction
  const created = createConsoleSkill(store, '101', {
    slug: 'release-check',
    files: [
      { path: 'SKILL.md', content: validSkillMd('release-check', 'Verify release checklist.', 'Never print ghp_secret_value_1234567890 here.') },
      { path: 'scripts/verify.sh', content: '#!/bin/sh\necho ok\n', executable: true },
      { path: 'assets/badge.png', content: PNG_1X1_BASE64, encoding: 'base64' },
    ],
  }, 'u1');
  assert.equal(created.created, true);
  assert.equal(created.skill.id, projectSkillId('console', '101', 'release-check'));
  assert.equal(created.version.version, 1);
  assert.equal(created.version.file_count, 3);
  const storedMd = created.version.files.find(f => f.path === 'SKILL.md');
  assert.ok(!storedMd.content.includes('ghp_secret_value_1234567890'), 'registered control-plane secret must be redacted');
  assert.equal(created.version.files.find(f => f.path === 'assets/badge.png').encoding, 'base64');
  assert.equal(created.version.files.find(f => f.path === 'scripts/verify.sh').executable, true);

  // Duplicate slug rejected
  assert.throws(() => createConsoleSkill(store, '101', {
    slug: 'release-check',
    files: [{ path: 'SKILL.md', content: validSkillMd('release-check') }],
  }, 'u1'), { code: 'skill_already_exists' });

  // Unchanged save dedups (created: false, version stays 1)
  const unchanged = updateConsoleSkill(store, '101', created.skill.id, {
    expected_version: 1,
    files: created.version.files.map(({ path, content, encoding, executable }) => ({ path, content, encoding, ...(executable ? { executable } : {}) })),
  }, 'u1');
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.version.version, 1);

  // Real edit mints v2; stale expected_version fails with 409 skill_revision_conflict
  const updated = updateConsoleSkill(store, '101', created.skill.id, {
    expected_version: 1,
    files: [
      { path: 'SKILL.md', content: validSkillMd('release-check', 'Verify release checklist v2.', '# v2\n') },
      { path: 'assets/badge.png', content: PNG_1X1_BASE64, encoding: 'base64' },
    ],
  }, 'u2');
  assert.equal(updated.created, true);
  assert.equal(updated.version.version, 2);
  assert.equal(listSkillVersions(store, '101', created.skill.id).versions.length, 2);
  assert.throws(() => updateConsoleSkill(store, '101', created.skill.id, {
    expected_version: 1,
    files: [{ path: 'SKILL.md', content: validSkillMd('release-check', 'Stale write') }],
  }, 'u2'), e => e.code === 'skill_revision_conflict' && e.detail?.current_version === 2);

  // Project isolation & read-only built-in enforcement
  assert.throws(() => getSkill(store, '102', created.skill.id), { code: 'skill_not_found' });
  assert.ok(!listSkills(store, '102').skills.some(s => s.id === created.skill.id));
  assert.throws(() => updateConsoleSkill(store, '101', 'builtin:layered-ci-gates', {
    expected_version: 1,
    files: [{ path: 'SKILL.md', content: validSkillMd('layered-ci-gates') }],
  }, 'u1'), { code: 'skill_read_only' });
  assert.throws(() => deleteProjectSkill(store, '101', 'builtin:layered-ci-gates', 1, 'u1'), { code: 'skill_read_only' });
});

test('repository whole-directory import validates trusted trees (symlinks, submodules, unknown binaries, controlled assets) and dedups unchanged commits', async t => {
  const store = setupStore(t);
  const rules = new RuleService(store);

  // Untrusted repository_rule_sources row (missing rules:trusted_sha:101) is rejected fail-closed.
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', 'a'.repeat(40), JSON.stringify({
    '.agents/skills/sec/SKILL.md': validSkillMd('sec', 'Security checks'),
  }), 'now');
  await assert.rejects(() => importRepositorySkills(store, '101', { path: 'sec', source: 'cache' }, 'u1'), { code: 'skill_source_commit_unavailable' });

  // Verified trusted cache via RuleService.cache() succeeds and preserves references/ & scripts/.
  const sha1 = '1'.repeat(40);
  rules.cache('101', sha1, {
    '.agents/skills/sec/SKILL.md': validSkillMd('sec', 'Security checklist v1.'),
    '.agents/skills/sec/references/owasp.md': '# OWASP\n',
    '.agents/skills/sec/scripts/audit.sh': '#!/bin/sh\necho audit\n',
  });
  const first = await importRepositorySkills(store, '101', { path: '.agents/skills/sec', source: 'cache' }, 'u1');
  assert.equal(first.source, 'cache');
  assert.equal(first.commit, sha1);
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0].created, true);
  assert.equal(first.imported[0].skill.id, 'repository:101:sec');
  assert.equal(first.imported[0].version.file_count, 3);
  assert.equal(first.imported[0].version.source_meta.commit, sha1);

  // Re-importing same content from a newer trusted commit creates NO new version.
  const sha2 = '2'.repeat(40);
  rules.cache('101', sha2, {
    '.agents/skills/sec/SKILL.md': validSkillMd('sec', 'Security checklist v1.'),
    '.agents/skills/sec/references/owasp.md': '# OWASP\n',
    '.agents/skills/sec/scripts/audit.sh': '#!/bin/sh\necho audit\n',
  });
  const repeat = await importRepositorySkills(store, '101', { path: 'sec', source: 'cache' }, 'u1');
  assert.equal(repeat.imported[0].created, false);
  assert.equal(repeat.imported[0].version.version, 1);

  // Changed content mints v2 with sha3 recorded in source_meta.
  const sha3 = '3'.repeat(40);
  rules.cache('101', sha3, {
    '.agents/skills/sec/SKILL.md': validSkillMd('sec', 'Security checklist v2.'),
    '.agents/skills/sec/references/owasp.md': '# OWASP updated\n',
  });
  const second = await importRepositorySkills(store, '101', { path: 'sec', source: 'cache' }, 'u1');
  assert.equal(second.imported[0].created, true);
  assert.equal(second.imported[0].version.version, 2);
  assert.equal(second.imported[0].version.source_meta.commit, sha3);

  // Direct Git tree extraction rejects symlinks, submodules, and unknown binaries, while preserving controlled assets + 100755 executable bit.
  const pngBytes = Buffer.from(PNG_1X1_BASE64, 'base64');
  const blobs = new Map([
    ['s1', Buffer.from(validSkillMd('deploy', 'Deploy skill with script and image.'), 'utf8')],
    ['s2', Buffer.from('#!/bin/sh\nexit 0\n', 'utf8')],
    ['s3', pngBytes],
    ['badbin', Buffer.from([0x00, 0x01, 0x02, 0xff])],
  ]);
  const goodTree = [
    { path: '.agents/skills/deploy/SKILL.md', type: 'blob', mode: '100644', sha: 's1', size: blobs.get('s1').length },
    { path: '.agents/skills/deploy/scripts/run.sh', type: 'blob', mode: '100755', sha: 's2', size: blobs.get('s2').length },
    { path: '.agents/skills/deploy/assets/flow.png', type: 'blob', mode: '100644', sha: 's3', size: pngBytes.length },
  ];
  const okExtracted = await extractSkillsFromTrustedGitTree(goodTree, async item => blobs.get(item.sha), { targetPath: 'deploy' });
  assert.equal(okExtracted.length, 1);
  assert.equal(okExtracted[0].files.find(f => f.path === 'scripts/run.sh').executable, true);
  assert.equal(okExtracted[0].files.find(f => f.path === 'assets/flow.png').encoding, 'base64');

  await assert.rejects(() => extractSkillsFromTrustedGitTree([
    ...goodTree,
    { path: '.agents/skills/deploy/references/link.md', type: 'blob', mode: '120000', sha: 's1' },
  ], async item => blobs.get(item.sha), { targetPath: 'deploy' }), { code: 'invalid_skill_file' });

  await assert.rejects(() => extractSkillsFromTrustedGitTree([
    ...goodTree,
    { path: '.agents/skills/deploy/vendor', type: 'commit', mode: '160000', sha: 's1' },
  ], async item => blobs.get(item.sha), { targetPath: 'deploy' }), { code: 'invalid_skill_file' });

  await assert.rejects(() => extractSkillsFromTrustedGitTree([
    ...goodTree,
    { path: '.agents/skills/deploy/bin/tool.bin', type: 'blob', mode: '100644', sha: 'badbin', size: 4 },
  ], async item => blobs.get(item.sha), { targetPath: 'deploy' }), { code: 'invalid_skill_file' });
});

test('library-backed role bundles enforce conflict detection, cross-project isolation, 32-bundle unified cap, binary materialization, and deletion protection', t => {
  const store = setupStore(t);
  const custom = createConsoleSkill(store, '101', {
    slug: 'custom-qa',
    files: [
      { path: 'SKILL.md', content: validSkillMd('custom-qa', 'Custom QA skill with binary asset and script.') },
      { path: 'scripts/check.sh', content: '#!/bin/sh\necho check\n', executable: true },
      { path: 'assets/icon.png', content: PNG_1X1_BASE64, encoding: 'base64' },
    ],
  }, 'u1');
  const customV2 = updateConsoleSkill(store, '101', custom.skill.id, {
    expected_version: 1,
    files: [{ path: 'SKILL.md', content: validSkillMd('custom-qa', 'Custom QA v2.') }],
  }, 'u1');
  const foreign = createConsoleSkill(store, '102', {
    slug: 'beta-only',
    files: [{ path: 'SKILL.md', content: validSkillMd('beta-only', 'Project 102 private skill.') }],
  }, 'u1');
  // Console skill colliding on slug with built-in skill `layered-ci-gates`
  const shadowing = createConsoleSkill(store, '101', {
    slug: 'layered-ci-gates',
    files: [{ path: 'SKILL.md', content: validSkillMd('layered-ci-gates', 'Local console override.') }],
  }, 'u1');

  // Same skill, different versions => skill_version_conflict
  assert.throws(() => saveConfiguration(store, '101', {
    expected_revision: 0,
    skills: [{ id: 'conflict-ver', source: { type: 'library', items: [{ skill_id: custom.skill.id, version: 1 }, { skill_id: custom.skill.id, version: 2 }] } }],
  }, 'u1'), { code: 'skill_version_conflict' });

  // Same slug, different origins (builtin vs console) => skill_version_conflict
  assert.throws(() => saveConfiguration(store, '101', {
    expected_revision: 0,
    skills: [{ id: 'conflict-origin', source: { type: 'library', items: [{ skill_id: 'builtin:layered-ci-gates', version: 1 }, { skill_id: shadowing.skill.id, version: 1 }] } }],
  }, 'u1'), { code: 'skill_version_conflict' });

  // Cross-project skill reference => skill_not_found
  assert.throws(() => saveConfiguration(store, '101', {
    expected_revision: 0,
    skills: [{ id: 'foreign-ref', source: { type: 'library', items: [{ skill_id: foreign.skill.id, version: 1 }] } }],
  }, 'u1'), { code: 'skill_not_found' });

  // Aggregate library bundle size cap (>16 MiB rejected with skill_file_too_large)
  assert.equal(LIBRARY_BUNDLE_MAX_ITEMS, 64);
  assert.equal(LIBRARY_BUNDLE_MAX_FILES, 512);
  assert.equal(LIBRARY_BUNDLE_MAX_BYTES, 16 * 1024 * 1024);
  const heavySkills = [0, 1, 2].map(idx => createConsoleSkill(store, '101', {
    slug: `heavy-skill-${idx}`,
    files: [
      { path: 'SKILL.md', content: validSkillMd(`heavy-skill-${idx}`) },
      ...Array.from({ length: 12 }, (_, j) => ({ path: `references/chunk-${j}.md`, content: 'h'.repeat(500 * 1024) })),
    ],
  }, 'u1'));
  assert.throws(() => saveConfiguration(store, '101', {
    expected_revision: 0,
    skills: [{ id: 'too-heavy', source: { type: 'library', items: heavySkills.map(s => ({ skill_id: s.skill.id, version: 1 })) } }],
  }, 'u1'), { code: 'skill_file_too_large' });

  // Valid library bundle (with duplicate identical ref auto-deduped) + 32-bundle unified cap
  const extraBundles = Array.from({ length: MAX_SKILL_BUNDLES - 1 }, (_, i) => ({
    id: `bundle-${i}`,
    source: { type: 'inline', files: [{ path: 'guide.md', content: `Bundle ${i}` }] },
  }));
  const saved = saveConfiguration(store, '101', {
    expected_revision: 0,
    skills: [
      { id: 'lib-bundle', source: { type: 'library', items: [
        { skill_id: custom.skill.id, version: 1 },
        { skill_id: custom.skill.id, version: 1 },
        { skill_id: 'builtin:test-driven-development', version: 1 },
      ] } },
      ...extraBundles,
    ],
    roles: [{ role_id: 'dev', skill_bundle_ref: { id: 'lib-bundle' } }],
  }, 'u1');
  assert.equal(saved.skills.length, MAX_SKILL_BUNDLES);
  assert.equal(saved.skills[0].source.type, 'library');
  assert.equal(saved.skills[0].source.items.length, 2);

  // Exceeding 32 bundles fails with invalid_skill_bundles
  assert.throws(() => saveConfiguration(store, '101', {
    expected_revision: saved.revision,
    skills: [...extraBundles, { id: 'b31', source: { type: 'inline', files: [{ path: 'a.md', content: 'a' }] } }, { id: 'b32', source: { type: 'inline', files: [{ path: 'b.md', content: 'b' }] } }],
  }, 'u1'), { code: 'invalid_skill_bundles' });

  // Active reference blocks skill deletion (409 skill_in_use)
  assert.throws(() => deleteProjectSkill(store, '101', custom.skill.id, customV2.version.version, 'u1'), { code: 'skill_in_use' });

  // Resolve role and materialize into skill-store: binary controlled asset + executable bit preserved byte-for-byte
  const resolved = resolveRole(store, '101', 'dev', 'development.issue');
  const files = skillFiles(store, '101', resolved.snapshot.skills);
  const storeRoot = mkdtempSync(join(tmpdir(), 'bot-skill-lib-store-'));
  t.after(() => rmSync(storeRoot, { recursive: true, force: true }));
  const mat = materializeSkillSet({ root: storeRoot, scope: projectSkillScope('101'), files });
  assert.ok(mat);
  assert.deepEqual(mat.skills.map(s => s.slug), ['custom-qa', 'test-driven-development']);
  const materializedPng = join(mat.hostSkillsDir, 'custom-qa', 'assets', 'icon.png');
  assert.ok(existsSync(materializedPng));
  assert.deepEqual(readFileSync(materializedPng), Buffer.from(PNG_1X1_BASE64, 'base64'));
  const materializedScript = join(mat.hostSkillsDir, 'custom-qa', 'scripts', 'check.sh');
  assert.equal(statSync(materializedScript).mode & 0o777, 0o755);

  // Deleting project 101 cleans project 101 skills/versions while preserving built-in skills and project 102 skills
  deleteProjectRecords(store, '101');
  assert.equal(store.get("SELECT count(*) n FROM skills WHERE repository_id='101'").n, 0);
  assert.equal(store.get("SELECT count(*) n FROM skill_versions WHERE skill_id=?", custom.skill.id).n, 0);
  assert.equal(store.get("SELECT count(*) n FROM skills WHERE scope_kind='builtin'").n, 5);
  assert.equal(store.get("SELECT count(*) n FROM skills WHERE repository_id='102'").n, 1);
});
