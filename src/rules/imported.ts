import { parse } from 'yaml';
import type { Store } from '../storage/database.js';
import { sections } from '../work/catalog.js';
import { managerPrompt, parseSections, saveManager, withSection } from '../work/settings.js';
import { computerKeys, declaredLabel, defaultLabels, defaults, retiredPath, type Labels } from './service.js';

/**
 * The upgrade that retires the repositories' .bot/ files (#935). Once per project, the layer that took effect before
 * becomes role configuration, so the project behaves as before:
 *
 * - a .bot/ rule file the repository had (it won over the console and the built-in text) becomes its Manager section,
 *   opened by a line naming the file and the commit it came from; sections without a repository file keep their text;
 * - the review label and the development label become project settings, from the layer that declared them, and their
 *   declaration line leaves the section text;
 * - the repository's .bot/computer.yaml is merged into the project computer field by field, as tasks applied it. A
 *   project without a saved console spec keeps the fields in rule_imports.computer until its spec is first saved
 *   (rememberConsoleComputer), so the next prepare or machine save applies them on top of the live computer.
 *
 * It reads the files as the bot last read them for a task (repository_rule_sources). A project with nothing cached is
 * imported the first time the bot reads its repository afterwards (importRepository), from that commit. Each project
 * gets a report (rule_imports) and an audit entry; tasks already under way keep the rule texts they started with. After
 * that the bot never reads .bot/ contents again: a project added later starts from the built-in texts.
 */
export interface ImportReport { files: string[]; sections: string[]; labels: Labels; computer: string[]; warnings: string[] }
const terminal = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded'];

export function importBotRules(store: Store): void {
  store.db.exec('CREATE TABLE IF NOT EXISTS rule_imports(repository_id TEXT PRIMARY KEY,sha TEXT,imported_at TEXT,pending INTEGER NOT NULL DEFAULT 0,report TEXT NOT NULL,computer TEXT)');
  if (store.get("SELECT 1 FROM settings WHERE key='rules.bot_imported'")) return;
  store.transaction(() => {
    for (const policy of store.all('SELECT repository_id FROM policies')) {
      const id = String(policy.repository_id), cached = store.get('SELECT sha,files FROM repository_rule_sources WHERE repository_id=?', id);
      if (cached) importFiles(store, id, String(cached.sha), String(cached.files));
      else store.run('INSERT INTO rule_imports VALUES(?,NULL,NULL,1,?,NULL) ON CONFLICT(repository_id) DO NOTHING', id, JSON.stringify(emptyReport()));
    }
    store.run("INSERT INTO settings VALUES('rules.bot_imported',?)", new Date().toISOString());
  });
}

/** Whether the project still waits for its one import: it had no cached files at the upgrade. */
/** The .bot/computer.yaml fields a project without a saved console spec still has to take into it (null: none). */
export function importedComputer(store: Store, repositoryId: string): Record<string, unknown> | null {
  if (!store.hasTable('rule_imports')) return null;
  const row = store.get('SELECT computer FROM rule_imports WHERE repository_id=? AND computer IS NOT NULL', repositoryId);
  return row ? JSON.parse(String(row.computer)) : null;
}

export function importPending(store: Store, repositoryId: string): boolean {
  return !!store.get('SELECT 1 FROM rule_imports WHERE repository_id=? AND pending=1', repositoryId);
}

/** The pending import of one project, from the .bot/ files at the commit the bot reads first after the upgrade. */
export function importRepository(store: Store, repositoryId: string, sha: string, files: Record<string, string>): void {
  store.transaction(() => { if (importPending(store, repositoryId)) importFiles(store, repositoryId, sha, JSON.stringify(files)); });
}

const emptyReport = (): ImportReport => ({ files: [], sections: [], labels: { ...defaultLabels }, computer: [], warnings: [] });

// One project's import, from the files as JSON text. Whatever goes wrong in one project (a stored value that is not valid
// JSON, a save the Manager prompt refuses) rolls back that project only: it keeps its console and built-in rules, and its
// report says so instead of listing what was rolled back. The startup never stops on it.
function importFiles(store: Store, id: string, sha: string, filesJson: string) {
  let report = emptyReport(), computer: Record<string, unknown> | null = null;
  try {
    const attempt = emptyReport();
    computer = store.transaction(() => importProject(store, id, JSON.parse(filesJson), sha, attempt));
    report = attempt;
  } catch (error) {
    report.warnings.push(`导入失败，沿用控制台和内置规则：${error instanceof Error ? error.message : String(error)}`);
  }
  // What the repository still has is listed by name only.
  const cached = store.get('SELECT files FROM repository_rule_sources WHERE repository_id=?', id);
  // A cache that cannot be read stays as it is (it is refreshed by the next read of the branch); the report says so.
  if (cached) {
    try { store.run('UPDATE repository_rule_sources SET files=? WHERE repository_id=?', JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(cached.files) as Record<string, string>).map(([path, content]) => [path, retiredPath(path) ? '' : content]))), id); }
    catch { report.warnings.push('缓存的仓库文件无法读取，保留原样，下次读取默认分支时更新'); }
  }
  store.run('INSERT INTO rule_imports VALUES(?,?,?,0,?,?) ON CONFLICT(repository_id) DO UPDATE SET sha=excluded.sha,imported_at=excluded.imported_at,pending=0,report=excluded.report,computer=excluded.computer',
    id, sha, new Date().toISOString(), JSON.stringify(report), computer ? JSON.stringify(computer) : null);
  store.audit('system', 'rules.imported', report.files.join(', ') || 'none', id);
}

function importProject(store: Store, id: string, files: Record<string, string>, sha: string, report: ImportReport): Record<string, unknown> | null {
  let computer: Record<string, unknown> | null = null;
  // A repository file took effect when it existed, also when it was empty.
  const repository = (path: string) => Object.hasOwn(files, path) && typeof files[path] === 'string' ? files[path]! : null;
  const policy = store.get('SELECT rule_overrides FROM policies WHERE repository_id=?', id);
  const overrides = JSON.parse(policy?.rule_overrides || '{}');
  // The text a rule section took effect with when the project had its own: the repository file, else the console text.
  // The built-in texts no longer declare labels; a project on them keeps the built-in names.
  const own = (path: string) => repository(path) ?? (Object.hasOwn(overrides, path) ? String(overrides[path]) : null);
  // Labels: the first declaration line of the layer that took effect, as tasks read them. The line then leaves the
  // section text: the setting is the only place that names the label from now on.
  const declarations: Record<string, keyof Labels> = { '.bot/rules/labels.md': 'review_label', '.bot/rules/issue-development.md': 'development_label' };
  const line = (key: string) => new RegExp(`^${key}:[ \\t]*.*(?:\\n|$)`, 'm');
  for (const [path, key] of Object.entries(declarations)) {
    const text = own(path); if (text === null) continue;
    try { const label = declaredLabel(text, key, path); report.labels[key] = key === 'development_label' ? label || defaultLabels.development_label : label; }
    catch { report.warnings.push(`${path} 的 ${key} 不合法，使用默认值 ${defaultLabels[key]}`); }
  }
  let content = managerPrompt(store, id).content;
  const written = parseSections(content).sections;
  const write = (sectionId: string, text: string) => { content = withSection(content, sectionId, text); report.sections.push(sectionId); };
  for (const section of sections.filter(entry => entry.rule && entry.rule !== '.bot/computer.yaml')) {
    const path = section.rule!, key = declarations[path], text = repository(path), console = Object.hasOwn(overrides, path) ? String(overrides[path]) : null;
    const plain = (value: string) => key ? value.replace(line(key), '') : value;
    if (text?.includes('\0')) { report.warnings.push(`${path} 不是文本文件，未导入`); continue; }
    if (text !== null) { report.files.push(path); write(section.id, `由 \`${path}\` 导入（提交 ${sha.slice(0, 7)}）。\n\n${plain(text)}`); }
    // A console text kept only in rule_overrides (an older version wrote it there) joins the prompt, so saving it keeps it.
    else if (console !== null && ((key && line(key).test(console)) || !written.has(section.id))) write(section.id, plain(console));
  }
  store.run('INSERT INTO project_labels VALUES(?,?,?) ON CONFLICT(repository_id) DO NOTHING', id, report.labels.review_label, report.labels.development_label);
  if (report.sections.length) {
    const current = managerPrompt(store, id);
    saveManager(store, id, { expected_revision: current.revision, content }, null, 'upgrade');
  }
  // The project computer: the repository file's fields over the console's, as each task applied them.
  const yaml = repository('.bot/computer.yaml');
  if (yaml !== null) {
    try {
      const value = parse(yaml, { maxAliasCount: 0 }) || {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a mapping');
      delete value.max_command_minutes;
      const known = Object.fromEntries(Object.entries(value).filter(([key]) => computerKeys.includes(key)));
      const ignored = Object.keys(value).filter(key => !computerKeys.includes(key));
      if (ignored.length) report.warnings.push(`.bot/computer.yaml 的字段 ${ignored.join('、')} 不受支持，未导入`);
      // Without a saved console spec the console layer is the computer as the manager has it, which may not carry the
      // file's fields yet (no task applied them); a new spec of the file's fields alone would drop the others. They wait
      // in rule_imports.computer and join the spec when it is first saved.
      const saved = store.get('SELECT spec FROM computer_console_specs WHERE repository_id=?', id);
      if (saved) store.run('UPDATE computer_console_specs SET spec=? WHERE repository_id=?', JSON.stringify({ ...JSON.parse(saved.spec), ...known }), id);
      else if (Object.keys(known).length) computer = known;
      report.files.push('.bot/computer.yaml'); report.computer = Object.keys(known);
    } catch { report.warnings.push('.bot/computer.yaml 不是映射，或含不支持的写法，未导入'); }
  }
  keepStartedTasks(store, id, ruleTexts(files));
  return computer;
}

// The .bot/ rule texts among files (the computer file is merged into the computer, not a text).
const ruleTexts = (files: Record<string, string>) => Object.fromEntries(Object.entries(files)
  .filter(([path, content]) => Object.hasOwn(defaults, path) && path !== '.bot/computer.yaml' && typeof content === 'string' && !content.includes('\0')));

/**
 * Tasks under way keep the rule texts they were going to work with. One that already prepared froze the .bot/ texts it
 * read; one that has not would have read the repository's at its start, which are the texts imported now. Those texts
 * become the console layer of the task's snapshot, which is what rule resolution reads now.
 */
function keepStartedTasks(store: Store, id: string, imported: Record<string, string>) {
  const rows = store.all(`SELECT c.task_id,c.snapshot FROM task_execution_configs c JOIN tasks t ON t.id=c.task_id
    WHERE t.repository_id=? AND t.status NOT IN (${terminal.map(() => '?').join(',')})`, id, ...terminal);
  for (const row of rows) {
    let config: any; try { config = JSON.parse(row.snapshot); } catch { continue; }
    const texts = config.rule_files ? ruleTexts(config.rule_files) : imported;
    if (!config.policy || !Object.keys(texts).length) continue;
    config.policy = { ...config.policy, rule_overrides: JSON.stringify({ ...JSON.parse(config.policy.rule_overrides || '{}'), ...texts }) };
    if (config.rule_files) config.rule_files = Object.fromEntries(Object.entries(config.rule_files as Record<string, string>).map(([path, content]) => [path, retiredPath(path) ? '' : content]));
    store.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify(config), row.task_id);
  }
}
