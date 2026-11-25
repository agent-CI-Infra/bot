import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import {
  CONTAINER_SKILLS_ROOT,
  ensureProjectSkillScope,
  ensureServiceSkillScope,
  materializeSkillSet,
  normalizeSkillMarkdown,
  projectSkillMountReady,
  projectSkillScope,
  pruneUnusedSkillSets,
  removeProjectSkillStore,
  serviceSkillScope,
} from '../../../../dist/roles/skill-store.js';
import { builtinSkillFiles, builtinSkillSummary } from '../../../../dist/roles/builtin-skills.js';

function tempDir(t, prefix = 'skill-store-ut-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('materializeSkillSet flattens multi-layer skills to 1-level bot/skills/<slug>/, enforces precedence and preserves support files', t => {
  const root = tempDir(t);
  const oldMask = process.umask(0o077);
  t.after(() => process.umask(oldMask));

  const result = materializeSkillSet({
    root,
    scope: projectSkillScope('101'),
    files: [
      { path: 'defaults/roadmap-decomposition/SKILL.md', content: '---\nname: roadmap-decomposition\ndescription: Default roadmap guidance.\n---\nDefault body.' },
      { path: 'defaults/roadmap-decomposition/references/guide.md', content: '# Guide\nRef content.' },
      { path: 'repository/calc-ops/SKILL.md', content: '# Calc Ops\nRepository skill without frontmatter.' },
      { path: 'repository/calc-ops/scripts/check.sh', content: '#!/bin/sh\necho ok\n' },
      { path: 'repository/roadmap-decomposition/SKILL.md', content: '---\nname: roadmap-decomposition\ndescription: Repo override.\n---\nRepo override body.' },
      { path: 'project/SKILL.md', content: '---\nname: team-conventions\ndescription: Project root skill.\n---\nUse strict conventions.' },
      { path: 'project/notes.txt', content: 'Companion notes.' },
    ],
  });

  assert.ok(result);
  assert.equal(result.scope, 'projects/101');
  assert.equal(result.containerPluginDir, `${CONTAINER_SKILLS_ROOT}/sets/${result.setHash}/bot`);
  assert.equal(result.containerSkillsDir, `${CONTAINER_SKILLS_ROOT}/sets/${result.setHash}/bot/skills`);
  assert.deepEqual(result.skills.map(s => s.slug), ['calc-ops', 'roadmap-decomposition', 'team-conventions']);

  // Verify 1-level directory layout under bot/skills/<slug>/ + Claude plugin manifest
  const pluginManifest = JSON.parse(readFileSync(join(result.hostPluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pluginManifest.name, 'bot');
  assert.deepEqual(readdirSync(result.hostSkillsDir).sort(), ['calc-ops', 'roadmap-decomposition', 'team-conventions']);

  // Precedence: repository overrides defaults on slug collision
  const roadmapMd = readFileSync(join(result.hostSkillsDir, 'roadmap-decomposition', 'SKILL.md'), 'utf8');
  assert.match(roadmapMd, /Repo override body\./);

  // Frontmatter synthesized cleanly when missing
  const calcMd = readFileSync(join(result.hostSkillsDir, 'calc-ops', 'SKILL.md'), 'utf8');
  assert.match(calcMd, /^---\nname: calc-ops\ndescription: .+\n---\n/);
  assert.match(calcMd, /Repository skill without frontmatter\./);

  // Companion files preserved with readable permissions even under umask 0077
  assert.equal(readFileSync(join(result.hostSkillsDir, 'team-conventions', 'notes.txt'), 'utf8'), 'Companion notes.');
  assert.equal(statSync(result.hostRoot).mode & 0o777, 0o755);
  assert.equal(statSync(result.hostSkillsDir).mode & 0o777, 0o755);
  assert.equal(statSync(join(result.hostSkillsDir, 'calc-ops', 'SKILL.md')).mode & 0o777, 0o644);
  assert.equal(statSync(join(result.hostSkillsDir, 'calc-ops', 'scripts', 'check.sh')).mode & 0o777, 0o755);

  // Idempotent content-addressed deduplication
  const again = materializeSkillSet({
    root,
    scope: projectSkillScope('101'),
    files: [
      { path: 'project/notes.txt', content: 'Companion notes.' },
      { path: 'project/SKILL.md', content: '---\nname: team-conventions\ndescription: Project root skill.\n---\nUse strict conventions.' },
      { path: 'repository/roadmap-decomposition/SKILL.md', content: '---\nname: roadmap-decomposition\ndescription: Repo override.\n---\nRepo override body.' },
      { path: 'repository/calc-ops/scripts/check.sh', content: '#!/bin/sh\necho ok\n' },
      { path: 'repository/calc-ops/SKILL.md', content: '# Calc Ops\nRepository skill without frontmatter.' },
      { path: 'defaults/roadmap-decomposition/references/guide.md', content: '# Guide\nRef content.' },
      { path: 'defaults/roadmap-decomposition/SKILL.md', content: '---\nname: roadmap-decomposition\ndescription: Default roadmap guidance.\n---\nDefault body.' },
    ],
  });
  assert.equal(again.setHash, result.setHash);
  const setEntries = readdirSync(join(root, 'projects', '101', 'sets'));
  assert.deepEqual(setEntries, [result.setHash], 'no leftover .tmp-* staging directories');
});

test('materializeSkillSet synthesizes valid SKILL.md for legacy non-SKILL inline bundles and validates paths/symlinks', t => {
  const root = tempDir(t);
  const legacy = materializeSkillSet({
    root,
    scope: serviceSkillScope(),
    files: [{ path: 'playbooks/checklist.md', content: 'Verify boundaries.' }],
  });
  assert.ok(legacy);
  assert.deepEqual(legacy.skills.map(s => s.slug), ['project']);
  assert.equal(readFileSync(join(legacy.hostSkillsDir, 'project', 'playbooks', 'checklist.md'), 'utf8'), 'Verify boundaries.');
  assert.match(readFileSync(join(legacy.hostSkillsDir, 'project', 'SKILL.md'), 'utf8'), /playbooks\/checklist\.md/);

  // Frontmatter helper fills only missing fields
  const partial = normalizeSkillMarkdown('---\nname: only-name\n---\nBody summary line.', 'fallback');
  assert.equal(partial.name, 'only-name');
  assert.equal(partial.description, 'Body summary line.');
  assert.match(partial.content, /description:/);

  // Path traversal, NUL bytes, invalid scopes and symlinked scope dirs are refused
  for (const badPath of ['../escape/SKILL.md', '/abs/SKILL.md', 'a\\b/SKILL.md', 'a/\0/SKILL.md']) {
    assert.throws(() => materializeSkillSet({ root, scope: 'service', files: [{ path: badPath, content: 'x' }] }), /skill_store_path_invalid/);
  }
  assert.throws(() => materializeSkillSet({ root, scope: 'projects/../escape', files: [{ path: 'SKILL.md', content: 'x' }] }), /skill_store_path_invalid/);
  assert.throws(() => materializeSkillSet({ root, scope: 'other/101', files: [{ path: 'SKILL.md', content: 'x' }] }), /skill_store_scope_invalid/);

  const target = tempDir(t, 'skill-symlink-target-');
  mkdirSync(join(root, 'projects'), { recursive: true });
  symlinkSync(target, join(root, 'projects', '999'));
  assert.throws(() => ensureProjectSkillScope(root, '999'), /skill_store_path_invalid/);
  assert.throws(() => removeProjectSkillStore(root, '999'), /skill_store_path_invalid/);
});

test('pruneUnusedSkillSets protects running task hashes and grace window, removes expired sets/tmp/orphans and fails closed on unreadable root', t => {
  const dir = tempDir(t);
  const skillRoot = join(dir, 'skill-store');
  const store = new Store(join(dir, 'control.sqlite'), randomBytes(32));
  t.after(() => store.close());

  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/live','o','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t1','101','task.request','running','live','{}')");

  const active = materializeSkillSet({ root: skillRoot, scope: projectSkillScope('101'), files: [{ path: 'a/SKILL.md', content: 'active skill' }] });
  const expired = materializeSkillSet({ root: skillRoot, scope: projectSkillScope('101'), files: [{ path: 'b/SKILL.md', content: 'expired skill' }] });
  const fresh = materializeSkillSet({ root: skillRoot, scope: projectSkillScope('101'), files: [{ path: 'c/SKILL.md', content: 'fresh skill' }] });
  const orphan = materializeSkillSet({ root: skillRoot, scope: projectSkillScope('202'), files: [{ path: 'd/SKILL.md', content: 'orphan repo skill' }] });
  const serviceOld = materializeSkillSet({ root: skillRoot, scope: serviceSkillScope(), files: [{ path: 's/SKILL.md', content: 'old service skill' }] });

  // Active running task references active.setHash
  store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,status,started_at,context_snapshot,config_snapshot,run_context) VALUES('run1','t1','role',1,1,'running',?,'{}','{}',?)",
    new Date().toISOString(), JSON.stringify({ skill_set_hash: active.setHash }));

  const now = Date.now();
  const oldDate = new Date(now - 48 * 3600_000);
  utimesSync(active.hostRoot, oldDate, oldDate);
  utimesSync(expired.hostRoot, oldDate, oldDate);
  utimesSync(orphan.hostRoot, oldDate, oldDate);
  utimesSync(join(skillRoot, 'projects', '202'), oldDate, oldDate);
  utimesSync(serviceOld.hostRoot, oldDate, oldDate);

  const staleTmp = join(skillRoot, 'projects', '101', 'sets', '.tmp-stale1234');
  mkdirSync(staleTmp, { recursive: true });
  writeFileSync(join(staleTmp, 'x'), 'tmp');
  utimesSync(staleTmp, oldDate, oldDate);

  const pruned = pruneUnusedSkillSets(store, { root: skillRoot, now, graceMs: 24 * 3600_000, tmpMaxAgeMs: 3600_000 });
  assert.equal(pruned.failed, 0);
  assert.ok(pruned.count >= 4 && pruned.bytes > 0);
  assert.equal(existsSync(active.hostRoot), true, 'running task active skill set must be protected');
  assert.equal(existsSync(fresh.hostRoot), true, 'skill set within grace window must be protected');
  assert.equal(existsSync(expired.hostRoot), false, 'expired unreferenced project set must be pruned');
  assert.equal(existsSync(staleTmp), false, 'stale .tmp-* staging dir must be pruned');
  assert.equal(existsSync(join(skillRoot, 'projects', '202')), false, 'deleted repo scope dir must be pruned');
  assert.equal(existsSync(serviceOld.hostRoot), false, 'expired service set must be pruned');

  // Direct removal on project deletion
  ensureProjectSkillScope(skillRoot, '303');
  assert.equal(existsSync(join(skillRoot, 'projects', '303')), true);
  removeProjectSkillStore(skillRoot, '303');
  assert.equal(existsSync(join(skillRoot, 'projects', '303')), false);

  // Unreadable root fails closed (throws rather than treating as empty)
  if (process.getuid?.() !== 0) {
    ensureServiceSkillScope(skillRoot);
    chmodSync(skillRoot, 0o000);
    try {
      assert.throws(() => pruneUnusedSkillSets(store, { root: skillRoot, now }));
    } finally {
      chmodSync(skillRoot, 0o755);
    }
  }
});

test('BOT_SKILLS_DIR overrides built-in skills directory dynamically and rejects invalid ids', t => {
  const customRoot = tempDir(t, 'custom-skills-');
  mkdirSync(join(customRoot, 'demo-skill', 'references'), { recursive: true });
  writeFileSync(join(customRoot, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Custom override skill.\n---\nBody.');
  writeFileSync(join(customRoot, 'demo-skill', 'SOURCES.json'), '{"sources":[]}');
  writeFileSync(join(customRoot, 'demo-skill', 'references', 'ref.md'), '# Ref');

  const prev = process.env.BOT_SKILLS_DIR;
  process.env.BOT_SKILLS_DIR = customRoot;
  t.after(() => {
    if (prev === undefined) delete process.env.BOT_SKILLS_DIR;
    else process.env.BOT_SKILLS_DIR = prev;
  });

  const files = builtinSkillFiles('demo-skill');
  assert.deepEqual(files.map(f => f.path), ['SKILL.md', 'SOURCES.json', 'references/ref.md']);
  assert.deepEqual(builtinSkillSummary('demo-skill'), { name: 'demo-skill', description: 'Custom override skill.' });
  assert.throws(() => builtinSkillFiles('../escape'), /invalid_builtin_skill_id/);
});

test('projectSkillMountReady returns false only when computer_console_specs explicitly reports skills_mounted=false', t => {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  assert.equal(projectSkillMountReady(store, '101'), true, 'absent table defaults ready (e.g. local mode)');
  store.db.exec('CREATE TABLE computer_console_specs(repository_id TEXT PRIMARY KEY,spec TEXT NOT NULL)');
  assert.equal(projectSkillMountReady(store, '101'), true, 'absent row defaults ready');
  store.run('INSERT INTO computer_console_specs VALUES(?,?)', '101', JSON.stringify({ skills_mounted: false, skills_pending: true }));
  assert.equal(projectSkillMountReady(store, '101'), false, 'unmounted pre-rotation container must fall back to read_skill');
  store.run('UPDATE computer_console_specs SET spec=? WHERE repository_id=?', JSON.stringify({ skills_mounted: true, skills_pending: false }), '101');
  assert.equal(projectSkillMountReady(store, '101'), true, 'mounted container enables native skill loading');
});
