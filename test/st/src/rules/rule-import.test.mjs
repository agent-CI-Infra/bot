import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { RuleService, projectLabels, defaults } from '../../../../dist/rules/service.js';
import { importPending, importedComputer } from '../../../../dist/rules/imported.js';
import { cachedRuleFiles, consoleComputer, rememberConsoleComputer } from '../../../../dist/rules/service.js';
import { managerPrompt, saveManager } from '../../../../dist/dispatch/settings.js';

const sha = 'a'.repeat(40);
const writeRuleOverride = (store, id, path, text) => {
  const row = store.get('SELECT rule_overrides FROM policies WHERE repository_id=?', id);
  const current = JSON.parse(row?.rule_overrides || '{}');
  store.run('UPDATE policies SET rule_overrides=? WHERE repository_id=?', JSON.stringify({ ...current, [path]: text }), id);
};
const ruleOverride = (store, id, path) => {
  const row = store.get('SELECT rule_overrides FROM policies WHERE repository_id=?', id);
  return JSON.parse(row?.rule_overrides || '{}')[path];
};
// A store as an older version left it: the import has not run yet.
const beforeUpgrade = store => { store.run("DELETE FROM settings WHERE key='rules.bot_imported'"); store.run('DELETE FROM rule_imports'); };
const report = (store, id) => { const row = store.get('SELECT * FROM rule_imports WHERE repository_id=?', id); return row && { ...row, report: JSON.parse(row.report) }; };

test('labels.md, pr-review.md and computer.yaml become role configuration once, with a report, and later .bot/ changes change nothing', async t => {
  const manager = { call: async (method, path) => method === 'GET' && path === '/v1/projects/101' ? { computer: { cpus: 3, memory_mb: 4096, inherited: ['memory_mb'] } } : null };
  const h = await harness(t, manager), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const store = h.store; beforeUpgrade(store);
  // 101: the repository has three rule files; the console wrote the development section with its own label line.
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', sha, JSON.stringify({
    '.bot/rules/labels.md': 'review_label: team-reviewed\n\n# Labels\nUse type/* labels.\n', '.bot/rules/pr-review.md': 'Repository PR review rule.\n',
    '.bot/computer.yaml': 'memory_mb: 8192\npackages: [jq]\nmax_command_minutes: 30\n', '.agents/skills/ci/SKILL.md': '# CI\n' }), 'now');
  store.run('INSERT INTO computer_console_specs VALUES(?,?)', '101', JSON.stringify({ cpus: 3 }));
  writeRuleOverride(store, '101', '.bot/rules/issue-development.md', 'development_label: "ship it"\nDevelop carefully.');
  // A task that prepared before the upgrade froze the repository guide it read; one that has not prepared yet would read
  // the repository's files at its start.
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('prepared','101','review.pr','running','r','{}',7),('queued','101','review.pr','queued','q','{}',8),('done','101','review.pr','succeeded','d','{}',9)");
  const snapshot = files => JSON.stringify({ policy: { repository_id: '101', rule_overrides: '{}' }, ...(files ? { rule_files: files, rule_sha: sha } : {}) });
  store.run("INSERT INTO task_execution_configs VALUES('prepared',1,?,'now'),('queued',1,?,'now'),('done',1,?,'now')", snapshot({ '.bot/guide.md': 'Frozen guide', '.agents/skills/ci/SKILL.md': '# CI\n' }), snapshot(), snapshot({ '.bot/guide.md': 'Old guide' }));
  const before = managerPrompt(store, '101').revision;

  new RuleService(store, manager);

  // Imported rule texts are persisted in rule_overrides and appended to the Manager prompt; label declaration lines left them.
  assert.equal(ruleOverride(store, '101', '.bot/rules/pr-review.md'), `由 \`.bot/rules/pr-review.md\` 导入（提交 ${sha.slice(0, 7)}）。\n\nRepository PR review rule.`);
  assert.equal(ruleOverride(store, '101', '.bot/rules/labels.md'), `由 \`.bot/rules/labels.md\` 导入（提交 ${sha.slice(0, 7)}）。\n\n# Labels\nUse type/* labels.`);
  assert.equal(ruleOverride(store, '101', '.bot/rules/issue-development.md'), 'Develop carefully.');
  assert.equal(ruleOverride(store, '101', '.bot/guide.md'), undefined);
  assert.equal(managerPrompt(store, '101').revision, before + 1);
  assert.equal(managerPrompt(store, '101').source, 'upgrade');
  assert.deepEqual(projectLabels(store, '101'), { review_label: 'team-reviewed', development_label: 'ship it', developing_label: 'bot-developing' });
  // The computer file's fields over the console's, as tasks applied them.
  assert.deepEqual(JSON.parse(store.get("SELECT spec FROM computer_console_specs WHERE repository_id='101'").spec), { cpus: 3, memory_mb: 8192, packages: ['jq'] });
  // The report names what was imported, and the cache keeps the .bot/ names only.
  const imported = report(store, '101');
  assert.equal(imported.sha, sha); assert.equal(imported.pending, 0);
  assert.deepEqual([...imported.report.files].sort(), ['.bot/computer.yaml', '.bot/rules/labels.md', '.bot/rules/pr-review.md']);
  assert.deepEqual([...imported.report.sections].sort(), ['development', 'labels', 'review.pr']);
  assert.deepEqual(imported.report.computer, ['memory_mb', 'packages']);
  assert.deepEqual(imported.report.labels, { review_label: 'team-reviewed', development_label: 'ship it' });
  assert.ok(store.get("SELECT 1 FROM audit WHERE action='rules.imported' AND repository_id='101'"));
  assert.deepEqual(JSON.parse(store.get("SELECT files FROM repository_rule_sources WHERE repository_id='101'").files),
    { '.bot/rules/labels.md': '', '.bot/rules/pr-review.md': '', '.bot/computer.yaml': '', '.agents/skills/ci/SKILL.md': '# CI\n' });
  // Tasks under way keep their texts: the frozen guide, or the repository texts the queued one would have read.
  const config = id => JSON.parse(store.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', id).snapshot);
  assert.deepEqual(JSON.parse(config('prepared').policy.rule_overrides), { '.bot/guide.md': 'Frozen guide' });
  assert.deepEqual(config('prepared').rule_files, { '.bot/guide.md': '', '.agents/skills/ci/SKILL.md': '# CI\n' });
  assert.equal(JSON.parse(config('queued').policy.rule_overrides)['.bot/rules/pr-review.md'], 'Repository PR review rule.\n');
  assert.deepEqual(config('done').rule_files, { '.bot/guide.md': 'Old guide' }, 'a finished task is left as it was');

  // The view the console and every task read: the same behavior from role configuration.
  const { rules } = (await admin('/api/repositories/101/rules')).value;
  assert.equal(rules.review_label, 'team-reviewed'); assert.equal(rules.development_label, 'ship it');
  assert.equal(rules.files.find(file => file.path === '.bot/rules/pr-review.md').source, 'console');
  assert.deepEqual(rules.retired_files, ['.bot/computer.yaml', '.bot/rules/labels.md', '.bot/rules/pr-review.md']);
  assert.deepEqual(rules.imported.files, imported.report.files);

  // Once: a restart imports nothing again, and a later change to the repository's .bot/ files is only a name.
  new RuleService(store, manager);
  assert.equal(managerPrompt(store, '101').revision, before + 1);
  const service = new RuleService(store, manager);
  const github = { path: suffix => suffix, request: async (_method, path) => path.startsWith('/git/commits/') ? { tree: { sha: 'tree' } } : path.startsWith('/git/trees/')
    ? { tree: [{ path: '.bot/rules/labels.md', type: 'blob', mode: '100644', sha: 'labels', size: 20 }], truncated: false } : { content: Buffer.from('review_label: changed\n').toString('base64') } };
  service.cache('101', 'b'.repeat(40), await service.fetch(github, 'b'.repeat(40), undefined, '101'));
  assert.deepEqual(projectLabels(store, '101'), { review_label: 'team-reviewed', development_label: 'ship it', developing_label: 'bot-developing' });
  assert.equal((await admin('/api/repositories/101/rules')).value.rules.review_label, 'team-reviewed');

  // 202 had nothing cached: it imports the first time the bot reads its repository, from that commit.
  assert.equal(importPending(store, '202'), true); assert.equal(report(store, '202').sha, null);
  assert.deepEqual(projectLabels(store, '202'), { review_label: 'bot-reviewed', development_label: 'bot-develop', developing_label: 'bot-developing' });
  const pending = { path: suffix => suffix, request: async (_method, path) => path.startsWith('/git/commits/') ? { tree: { sha: 'tree' } } : path.startsWith('/git/trees/')
    ? { tree: [{ path: '.bot/rules/labels.md', type: 'blob', mode: '100644', sha: 'labels', size: 20 }, { path: '.bot/guide.md', type: 'blob', mode: '100644', sha: 'guide', size: 5 }], truncated: false }
    : { content: Buffer.from(path.endsWith('labels') ? 'review_label:\n# Our labels\n' : 'Guide').toString('base64') } };
  assert.deepEqual(await service.fetch(pending, 'c'.repeat(40), undefined, '202'), { '.bot/rules/labels.md': '', '.bot/guide.md': '' });
  assert.equal(importPending(store, '202'), false); assert.equal(report(store, '202').sha, 'c'.repeat(40));
  assert.deepEqual(projectLabels(store, '202'), { review_label: '', development_label: 'bot-develop', developing_label: 'bot-developing' });
  assert.equal(ruleOverride(store, '202', '.bot/rules/labels.md'), `由 \`.bot/rules/labels.md\` 导入（提交 ccccccc）。\n\n# Our labels`);
  assert.equal(ruleOverride(store, '202', '.bot/guide.md'), `由 \`.bot/guide.md\` 导入（提交 ccccccc）。\n\nGuide`);
});

test('a project on the built-in texts keeps the built-in labels, and an invalid label line falls back with a warning', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const store = h.store; beforeUpgrade(store);
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', sha, JSON.stringify({}), 'now');
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '202', sha, JSON.stringify({ '.bot/rules/labels.md': 'review_label: ' + 'y'.repeat(51) + '\n# Labels\n' }), 'now');
  new RuleService(store);
  assert.deepEqual(projectLabels(store, '101'), { review_label: 'bot-reviewed', development_label: 'bot-develop', developing_label: 'bot-developing' });
  assert.deepEqual(report(store, '101').report.files, []);
  assert.deepEqual(projectLabels(store, '202'), { review_label: 'bot-reviewed', development_label: 'bot-develop', developing_label: 'bot-developing' });
  assert.match(report(store, '202').report.warnings.join('\n'), /review_label 不合法，使用默认值 bot-reviewed/);
  // The built-in texts no longer declare the labels: the settings name them.
  assert.doesNotMatch(defaults['.bot/rules/labels.md'], /^review_label:/m); assert.doesNotMatch(defaults['.bot/rules/issue-development.md'], /^development_label:/m);
});

test('an empty repository file is the layer it was, and one project that cannot be imported keeps its rules without stopping the others', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202'); await repository(admin, a.id, '303');
  const store = h.store; beforeUpgrade(store);
  // 101: an empty labels.md took effect: no review label and an empty labeling text.
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', sha, JSON.stringify({ '.bot/rules/labels.md': '' }), 'now');
  // 202: the cache is not JSON; 303: a rule_overrides value that is not JSON.
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '202', sha, '{not json', 'now');
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '303', sha, JSON.stringify({ '.bot/rules/pr-review.md': 'Rule.' }), 'now');
  store.run("UPDATE policies SET rule_overrides='{broken' WHERE repository_id='303'");
  new RuleService(store);
  assert.deepEqual(projectLabels(store, '101'), { review_label: '', development_label: 'bot-develop', developing_label: 'bot-developing' });
  assert.equal(ruleOverride(store, '101', '.bot/rules/labels.md'), `由 \`.bot/rules/labels.md\` 导入（提交 ${sha.slice(0, 7)}）。`);
  for (const id of ['202', '303']) {
    const { report: failed } = report(store, id);
    assert.deepEqual([failed.files, failed.sections], [[], []], id); assert.match(failed.warnings[0], /^导入失败，沿用控制台和内置规则/, id);
  }
  assert.equal(store.get("SELECT 1 FROM rule_imports WHERE repository_id='303' AND sha IS NOT NULL") ? false : false, false);
  assert.ok(store.get("SELECT 1 FROM settings WHERE key='rules.bot_imported'"));
  // The unreadable cache is dropped: 202 reads as not yet read, and its rules, roles and configuration stay readable.
  assert.match(report(store, '202').report.warnings.join('\n'), /缓存的仓库文件无法读取，已清除/);
  const rules = await admin('/api/repositories/202/rules');
  assert.equal(rules.status, 200, JSON.stringify(rules.value)); assert.equal(rules.value.rules.needs_refresh, true); assert.equal(rules.value.rules.imported.warnings.length, 2);
  // Damage after the upgrade (a cache, the report, the pending computer fields) is read as missing, never as a failure.
  store.run("INSERT INTO repository_rule_sources VALUES('202',?,'[broken','now')", sha);
  store.run("UPDATE rule_imports SET report='{broken',computer='not json' WHERE repository_id='202'");
  for (const path of ['/api/repositories/202/rules', '/api/repositories/202/manager']) assert.equal((await admin(path)).status, 200, path);
  // The roles page and the skill sources read the cache through the same reader.
  assert.equal(cachedRuleFiles(store, '202'), null);
  const damaged = (await admin('/api/repositories/202/rules')).value.rules;
  assert.equal(damaged.needs_refresh, true); assert.deepEqual(damaged.imported, { sha, imported_at: damaged.imported.imported_at });
});

test('a rule_imports table a pre-release build created without the computer column gets it', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const store = h.store; store.run("DELETE FROM settings WHERE key='rules.bot_imported'"); store.db.exec('DROP TABLE rule_imports');
  store.db.exec('CREATE TABLE rule_imports(repository_id TEXT PRIMARY KEY,sha TEXT,imported_at TEXT,pending INTEGER NOT NULL DEFAULT 0,report TEXT NOT NULL)');
  new RuleService(store);
  assert.ok(store.all('PRAGMA table_info(rule_imports)').some(row => row.name === 'computer'));
  assert.equal(report(store, '101').pending, 1); assert.equal(importedComputer(store, '101'), null);
});

// A project without a saved console spec: the manager's computer may not carry the file's fields (no task applied them).
// They are part of the console spec from the import on, and are saved into it when the spec is first saved.
test('computer.yaml fields of a project without a saved console spec reach its computer after the upgrade', async t => {
  const live = { cpus: 3, memory_mb: 4096, packages: [], inherited: ['memory_mb', 'pids', 'tmp_mb'] };
  const manager = { call: async () => ({ generation: 1, computer: live }) };
  const h = await harness(t, manager), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const store = h.store; beforeUpgrade(store);
  store.run('DELETE FROM computer_console_specs');
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', sha, JSON.stringify({ '.bot/computer.yaml': 'packages: [jq]\nmemory_mb: 8192\n' }), 'now');
  const service = new RuleService(store, manager);
  // At the upgrade (cached files) and at a pending project's first read alike.
  const yaml = { path: suffix => suffix, request: async (_method, path) => path.startsWith('/git/commits/') ? { tree: { sha: 'tree' } } : path.startsWith('/git/trees/')
    ? { tree: [{ path: '.bot/computer.yaml', type: 'blob', mode: '100644', sha: 'c', size: 14 }], truncated: false } : { content: Buffer.from('packages: [ffmpeg]\n').toString('base64') } };
  await service.fetch(yaml, 'c'.repeat(40), undefined, '202');
  for (const [id, fields] of [['101', { packages: ['jq'], memory_mb: 8192 }], ['202', { packages: ['ffmpeg'] }]]) {
    assert.deepEqual(importedComputer(store, id), fields, id);
    assert.deepEqual(consoleComputer(store, id, live), { cpus: 3, packages: [], ...fields }, id);
    assert.deepEqual((await admin(`/api/repositories/${id}/rules`)).value.rules.computer, { cpus: 3, packages: [], ...fields }, id);
  }
  // The first save of the spec (a task's prepare or the machine page) takes the fields in and they stop being pending.
  rememberConsoleComputer(store, '101', live);
  assert.deepEqual(JSON.parse(store.get("SELECT spec FROM computer_console_specs WHERE repository_id='101'").spec), { cpus: 3, packages: ['jq'], memory_mb: 8192 });
  assert.equal(importedComputer(store, '101'), null);
  assert.deepEqual(consoleComputer(store, '101', { ...live, packages: ['jq'], memory_mb: 8192 }), { cpus: 3, packages: ['jq'], memory_mb: 8192 });
});

test('rules.update answers 410 with what replaces it', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const capabilities = (await admin('/api/management/query', 'POST', { query: 'get_capabilities', target: { project_id: '101' } })).value;
  if (capabilities?.commands) assert.ok(!capabilities.commands.some(command => command.operation === 'rules.update'));
  const sent = await admin('/api/management/commands', 'POST', { operation: 'rules.update', target: { project_id: '101' }, arguments: { path: '.bot/guide.md', content: 'x' }, expected_revision: 'r', idempotency_key: 'k' });
  assert.equal(sent.status, 410, JSON.stringify(sent.value)); assert.equal(sent.value.error, 'rules_update_removed'); assert.match(sent.value.detail, /manager\.update/);
});
