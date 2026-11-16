import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from './helpers.mjs';
import { RuleService, projectLabels, defaults } from '../dist/rules/service.js';
import { importPending } from '../dist/rules/imported.js';
import { managerPrompt, managerSection, saveManager, withSection } from '../dist/work/settings.js';

// The upgrade that retires the repositories' .bot/ files (#935): each project's effective layer becomes its Manager
// sections, label settings and computer once, with a report, and the project behaves as before.
const sha = 'a'.repeat(40);
const writeSection = (store, id, section, text) => { const current = managerPrompt(store, id); saveManager(store, id, { expected_revision: current.revision, content: withSection(current.content, section, text) }, null, 'test'); };
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
  writeSection(store, '101', 'development', 'development_label: "ship it"\nDevelop carefully.');
  // A task that prepared before the upgrade froze the repository guide it read; one that has not prepared yet would read
  // the repository's files at its start.
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('prepared','101','review.pr','running','r','{}',7),('queued','101','review.pr','queued','q','{}',8),('done','101','review.pr','succeeded','d','{}',9)");
  const snapshot = files => JSON.stringify({ policy: { repository_id: '101', rule_overrides: '{}' }, ...(files ? { rule_files: files, rule_sha: sha } : {}) });
  store.run("INSERT INTO task_execution_configs VALUES('prepared',1,?,'now'),('queued',1,?,'now'),('done',1,?,'now')", snapshot({ '.bot/guide.md': 'Frozen guide', '.agents/skills/ci/SKILL.md': '# CI\n' }), snapshot(), snapshot({ '.bot/guide.md': 'Old guide' }));
  const before = managerPrompt(store, '101').revision;

  new RuleService(store, manager);

  // The rule texts are Manager sections, the repository file named with its commit; the label lines left them.
  assert.equal(managerSection(store, '101', 'review.pr'), `由 \`.bot/rules/pr-review.md\` 导入（提交 ${sha.slice(0, 7)}）。\n\nRepository PR review rule.`);
  assert.equal(managerSection(store, '101', 'labels'), `由 \`.bot/rules/labels.md\` 导入（提交 ${sha.slice(0, 7)}）。\n\n\n# Labels\nUse type/* labels.`.replace('\n\n\n', '\n\n'));
  assert.equal(managerSection(store, '101', 'development'), 'Develop carefully.');
  assert.equal(managerSection(store, '101', 'guide'), undefined);
  assert.equal(managerPrompt(store, '101').revision, before + 1);
  assert.equal(managerPrompt(store, '101').source, 'upgrade');
  assert.deepEqual(projectLabels(store, '101'), { review_label: 'team-reviewed', development_label: 'ship it' });
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
  assert.deepEqual(projectLabels(store, '101'), { review_label: 'team-reviewed', development_label: 'ship it' });
  assert.equal((await admin('/api/repositories/101/rules')).value.rules.review_label, 'team-reviewed');

  // 202 had nothing cached: it imports the first time the bot reads its repository, from that commit.
  assert.equal(importPending(store, '202'), true); assert.equal(report(store, '202').sha, null);
  assert.deepEqual(projectLabels(store, '202'), { review_label: 'bot-reviewed', development_label: 'bot-develop' });
  const pending = { path: suffix => suffix, request: async (_method, path) => path.startsWith('/git/commits/') ? { tree: { sha: 'tree' } } : path.startsWith('/git/trees/')
    ? { tree: [{ path: '.bot/rules/labels.md', type: 'blob', mode: '100644', sha: 'labels', size: 20 }, { path: '.bot/guide.md', type: 'blob', mode: '100644', sha: 'guide', size: 5 }], truncated: false }
    : { content: Buffer.from(path.endsWith('labels') ? 'review_label:\n# Our labels\n' : 'Guide').toString('base64') } };
  assert.deepEqual(await service.fetch(pending, 'c'.repeat(40), undefined, '202'), { '.bot/rules/labels.md': '', '.bot/guide.md': '' });
  assert.equal(importPending(store, '202'), false); assert.equal(report(store, '202').sha, 'c'.repeat(40));
  assert.deepEqual(projectLabels(store, '202'), { review_label: '', development_label: 'bot-develop' });
  assert.equal(managerSection(store, '202', 'labels'), `由 \`.bot/rules/labels.md\` 导入（提交 ccccccc）。\n\n# Our labels`);
  assert.equal(managerSection(store, '202', 'guide'), `由 \`.bot/guide.md\` 导入（提交 ccccccc）。\n\nGuide`);
});

test('a project on the built-in texts keeps the built-in labels, and an invalid label line falls back with a warning', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const store = h.store; beforeUpgrade(store);
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '101', sha, JSON.stringify({}), 'now');
  store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?)', '202', sha, JSON.stringify({ '.bot/rules/labels.md': 'review_label: ' + 'y'.repeat(51) + '\n# Labels\n' }), 'now');
  new RuleService(store);
  assert.deepEqual(projectLabels(store, '101'), { review_label: 'bot-reviewed', development_label: 'bot-develop' });
  assert.deepEqual(report(store, '101').report.files, []);
  assert.deepEqual(projectLabels(store, '202'), { review_label: 'bot-reviewed', development_label: 'bot-develop' });
  assert.match(report(store, '202').report.warnings.join('\n'), /review_label 不合法，使用默认值 bot-reviewed/);
  // The built-in texts no longer declare the labels: the settings name them.
  assert.doesNotMatch(defaults['.bot/rules/labels.md'], /^review_label:/m); assert.doesNotMatch(defaults['.bot/rules/issue-development.md'], /^development_label:/m);
});

test('rules.update answers 410 with what replaces it', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const capabilities = (await admin('/api/management/query', 'POST', { query: 'get_capabilities', target: { project_id: '101' } })).value;
  if (capabilities?.commands) assert.ok(!capabilities.commands.some(command => command.operation === 'rules.update'));
  const sent = await admin('/api/management/commands', 'POST', { operation: 'rules.update', target: { project_id: '101' }, arguments: { path: '.bot/guide.md', content: 'x' }, expected_revision: 'r', idempotency_key: 'k' });
  assert.equal(sent.status, 410, JSON.stringify(sent.value)); assert.equal(sent.value.error, 'rules_update_removed'); assert.match(sent.value.detail, /manager\.update/);
});
