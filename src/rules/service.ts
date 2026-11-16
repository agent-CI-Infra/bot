import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { Store, Row } from '../storage/database.js';
import { type Actor, repository } from '../app/auth.js';
import { fail, fields, HttpError, type Json } from '../core/security.js';
import { GitHub, repositoryTree } from '../github/client.js';
import { type Mirror } from '../agent/git-cache.js';
import { Redactor } from '../agent/common.js';
import type { Manager } from '../projects/service.js';
import { importBotRules, importPending, importRepository } from './imported.js';

// The scenario rules are the Markdown files in docs/prompts, read once at startup so the documented text and the
// text the model receives cannot drift apart. The runtime image copies that directory next to dist.
//
// Rules are role configuration (#935): the Manager prompt's sections (their console layer is policies.rule_overrides,
// kept equal to them), the review and development labels as project settings, and the project computer. The keys below
// still name the .bot/ files these sections replaced, as identifiers only: repositories' .bot/ files are no longer read.
// They were imported once at the upgrade (see imported.ts); a repository that still has them is told they can go.
const prompt = (name: string) => readFileSync(resolve(import.meta.dirname, '../../docs/prompts', name), 'utf8');
export const defaults: Record<string, string> = {
  '.bot/guide.md': 'Act on the stated Issue or PR. Inspect relevant code and tests. Keep conclusions concise and evidence-based. Never invent test results. GitHub publication and authorization belong to the control plane. Do not merge PRs or expose credentials.',
  '.bot/rules/labels.md': prompt('labels.md'),
  '.bot/rules/issue-review.md': prompt('issue-review.md'),
  '.bot/rules/pr-review.md': prompt('pr-review.md'),
  '.bot/rules/issue-development.md': prompt('issue-development.md'),
  '.bot/computer.yaml': '{}\n'
};
/** Paths whose change changes how the bot works on this repository: its skills. .bot/ is no longer read (#935). */
export const behaviorPath = (path: string) => path === '.agents/skills' || path.startsWith('.agents/skills/');
const skillPath = (path: string) => /^\.agents\/skills\/(?:[^/]+\/)+SKILL\.md$/.test(path);
/** A retired .bot/ file: listed (never read) so the project page can say it was imported and can be deleted. */
export const retiredPath = (path: string) => path.startsWith('.bot/');
// Skills and rule texts have no size limit of their own: they are sent with the task as written. A skill error names
// the file, so the person who has to fix it knows which one.
const ruleError = (code: string, detail: string): never => { throw Object.assign(new HttpError(400, code), { detail }); };
// Skill errors a person has to fix; a task that meets one waits for configuration instead of failing.
export const ruleErrors = new Set(['invalid_skill_file', 'invalid_rule_content', 'too_many_bot_skills', 'unsafe_skill_file']);
// The fields of the project computer spec (and of the .bot/computer.yaml files imported into it).
export const computerKeys = ['cpus', 'memory_mb', 'pids', 'tmp_mb', 'egress', 'packages', 'env', 'setup_script'];
// The resource values that were fixed before a super administrator could change the defaults.
const builtinResources: Record<string, number> = { cpus: 2, memory_mb: 4096, pids: 1024, tmp_mb: 1024 };
// The console layer taken from a computer the manager describes: its fields without the resources that follow the default.
export function ownComputer(live: any): Record<string, unknown> {
  return Object.fromEntries(computerKeys.filter(key => live?.[key] !== undefined && !live.inherited?.includes(key)).map(key => [key, live[key]]));
}
// What applying the rules sends to the manager: the effective computer, plus null for every resource the computer still
// sets as its own although the console no longer does, so that resource follows the global default again. Empty when
// the computer already matches.
export function computerRequest(effective: Record<string, unknown>, live: any): Record<string, unknown> | null {
  const dropped = Array.isArray(live?.inherited) ? Object.keys(builtinResources).filter(key => effective[key] === undefined && live[key] !== undefined && !live.inherited.includes(key)) : [];
  const changed = dropped.length || Object.entries(effective).some(([key, value]) => JSON.stringify(live?.[key]) !== JSON.stringify(value));
  return changed ? { ...effective, ...Object.fromEntries(dropped.map(key => [key, null])) } : null;
}
// The project's skills as the agent finds them: a name, what the skill is for (its front matter description, or its first
// line), and where its full text is in the task context. The agent reads a skill when it does the job the skill describes.
export function skillIndex(rows: { path: string, source: string, effective: string }[]) {
  return rows.filter(row => skillPath(row.path)).map(row => {
    const name = row.path.slice('.agents/skills/'.length, -'/SKILL.md'.length), front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(row.effective)?.[1] || '';
    let description = ''; try { const value = parse(front, { maxAliasCount: 0 }); if (value && typeof value.description === 'string') description = value.description; } catch {}
    description ||= row.effective.replace(/^---[\s\S]*?\n---/, '').split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    return { name, description: description.slice(0, 500), file: `skills/${name}/SKILL.md`, path: `../context/skills/${name}/SKILL.md`, content: row.effective };
  });
}
/**
 * The rules a task works with: each rule's console text (its Manager section) or the built-in text, the project
 * computer, the project's skills from the default branch, and the labels from the project settings. `files` are the
 * repository files read for the task: its skills, and the names of retired .bot/ files, which are never content.
 */
export function resolveRules(policy: Row, files: Record<string, string>, computer: any = {}, labels: Labels = defaultLabels) {
  const skills=Object.keys(files).filter(skillPath).length;if(skills>32)ruleError('too_many_bot_skills',`.agents/skills/ 下共有 ${skills} 份 SKILL.md，最多 32 份`);
  // A NUL byte means the file is not text; it is rejected, not read as missing, also when an older version cached it.
  const binary=Object.entries(files).find(([path,content])=>skillPath(path)&&content.includes('\0'));if(binary)ruleError('invalid_rule_content',`${binary[0]} 不是文本文件（含 NUL 字节）`);
  const overrides = JSON.parse(policy.rule_overrides || '{}'), rows: any[] = [];
  // The existing manager computer is the console layer, not a new resource system.
  const consoleComputer = Object.fromEntries(computerKeys.filter(key => computer[key] !== undefined).map(key => [key, computer[key]]));
  const computerSources: Record<string, string> = Object.fromEntries(Object.keys(consoleComputer).map(key => [key, 'console']));
  for (const [path, builtin] of Object.entries(defaults)) {
    const layers = [{ source: 'builtin', content: builtin }];
    if (path === '.bot/computer.yaml') { if (Object.keys(consoleComputer).length) layers.push({ source: 'console', content: JSON.stringify(consoleComputer, null, 2) }); }
    else if (Object.hasOwn(overrides, path)) layers.push({ source: 'console', content: overrides[path]! });
    rows.push({ path, layers, source: layers.at(-1)!.source, effective: layers.at(-1)!.content });
  }
  for (const [path, content] of Object.entries(files).filter(([path]) => skillPath(path))) rows.push({ path, source: 'repository', layers: [{ source: 'repository', content }], effective: content });
  return { files: rows, computer: consoleComputer, computer_sources: computerSources, review_label: labels.review_label, development_label: labels.development_label,
    retired_files: Object.keys(files).filter(retiredPath).sort() };
}
// The bot's review label (empty: none) and the development label automatic development waits for, as project settings
// (#935). A project without its own keeps the built-in names.
export interface Labels { review_label: string; development_label: string }
export const defaultDevelopmentLabel = 'bot-develop';
export const defaultLabels: Labels = { review_label: 'bot-reviewed', development_label: defaultDevelopmentLabel };
export function projectLabels(store: Store, repositoryId: string): Labels {
  if (!store.hasTable('project_labels')) return { ...defaultLabels };
  const row = store.get('SELECT review_label,development_label FROM project_labels WHERE repository_id=?', repositoryId);
  return row ? { review_label: String(row.review_label), development_label: String(row.development_label) || defaultDevelopmentLabel } : { ...defaultLabels };
}
/** A label as GitHub takes it: at most 50 characters, no surrounding space or control characters. The review label may be empty. */
export function validLabel(value: unknown, key: keyof Labels): string {
  if (typeof value !== 'string' || value.length > 50 || value !== value.trim() || /\p{Cc}/u.test(value) || (key === 'development_label' && !value)) fail(400, 'invalid_label', key);
  return value as string;
}
export function saveLabels(store: Store, repositoryId: string, change: Partial<Labels>): Labels {
  const next = { ...projectLabels(store, repositoryId), ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) } as Labels;
  for (const key of ['review_label', 'development_label'] as const) validLabel(next[key], key);
  store.run('INSERT INTO project_labels VALUES(?,?,?) ON CONFLICT(repository_id) DO UPDATE SET review_label=excluded.review_label,development_label=excluded.development_label', repositoryId, next.review_label, next.development_label);
  return next;
}
// The first `key: value` line of a rule text; a JSON string keeps the exact characters. The value ends with its line:
// `key:` alone declares an empty label rather than taking the next line. Only the import reads it, from the .bot/
// files and console rules that declared the labels before they were settings.
export function declaredLabel(text: string, key: string, path: string) {
  const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim();
  let label = raw || '';
  try { if (raw?.startsWith('"')) label = JSON.parse(raw); } catch { return ruleError('invalid_bot_label', `${path} 的 ${key} 不是合法的 JSON 字符串`); }
  if (label.length > 50 || label !== label.trim() || /\p{Cc}/u.test(label)) ruleError('invalid_bot_label', `${path} 的 ${key} 不合法（最长 50 个字符，首尾不能有空白，不能含控制字符）`);
  return label;
}
export function developmentLabel(store: Store, repositoryId: string) {
  return projectLabels(store, repositoryId).development_label;
}
/** The bot's own review and development labels: no agent chooses them for a pull request (#845). */
export function ownLabels(store: Store, repositoryId: string): string[] {
  const labels = projectLabels(store, repositoryId);
  return [labels.review_label, labels.development_label].filter(Boolean);
}
export const rulesUpdateRemoved = '规则文件和它们的控制台覆盖已不再使用：检视、开发和标签的规则改在 Manager 提示词对应的章节（PUT /api/repositories/:id/manager，管理命令 manager.update）和角色配置（管理命令 roles.update）里修改，标签名在项目设置里修改。';
export class RuleService {
  constructor(readonly store: Store, readonly manager?: Manager, readonly githubUrl?: string) {
    if (!store.all('PRAGMA table_info(policies)').some(r => r.name === 'rule_overrides')) store.db.exec("ALTER TABLE policies ADD COLUMN rule_overrides TEXT NOT NULL DEFAULT '{}'");
    store.db.exec('CREATE TABLE IF NOT EXISTS repository_rule_sources(repository_id TEXT PRIMARY KEY,sha TEXT NOT NULL,files TEXT NOT NULL,updated_at TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS computer_console_specs(repository_id TEXT PRIMARY KEY,spec TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS project_labels(repository_id TEXT PRIMARY KEY,review_label TEXT NOT NULL,development_label TEXT NOT NULL)');
    // Review guidance and the review label used to be policy fields that fed the console layer of the rule files. Move
    // them into that layer once, before the .bot/ import below takes the label from it; existing overrides win as before.
    store.transaction(() => {
      for (const row of store.all("SELECT repository_id,rule_overrides,review_instructions,review_label FROM policies WHERE review_instructions<>'' OR review_label<>''")) {
        const overrides = JSON.parse(row.rule_overrides || '{}');
        if (row.review_instructions) for (const path of ['.bot/rules/issue-review.md', '.bot/rules/pr-review.md']) if (!Object.hasOwn(overrides, path)) overrides[path] = defaults[path] + '\n\n' + row.review_instructions;
        if (row.review_label && !Object.hasOwn(overrides, '.bot/rules/labels.md')) overrides['.bot/rules/labels.md'] = 'review_label: ' + JSON.stringify(row.review_label);
        store.run("UPDATE policies SET rule_overrides=?,review_instructions='',review_label='' WHERE repository_id=?", JSON.stringify(overrides), row.repository_id);
      }
    });
    // The console layer used to copy all four resources from the manager. Values equal to the built-in defaults are dropped
    // once, as the manager does with its saved specs, so those projects follow the global default from then on.
    if (!store.get("SELECT 1 FROM settings WHERE key='computer.own_resources'")) store.transaction(() => {
      for (const row of store.all('SELECT repository_id,spec FROM computer_console_specs')) {
        const spec = JSON.parse(row.spec); for (const [key, value] of Object.entries(builtinResources)) if (spec[key] === value) delete spec[key];
        store.run('UPDATE computer_console_specs SET spec=? WHERE repository_id=?', JSON.stringify(spec), row.repository_id);
      }
      store.run("INSERT INTO settings VALUES('computer.own_resources','1')");
    });
    // The repositories' .bot/ files become role configuration once (#935).
    importBotRules(store);
  }
  consoleComputer(id:string,live:any){const row=this.store.get('SELECT spec FROM computer_console_specs WHERE repository_id=?',id);return row?JSON.parse(row.spec):ownComputer(live);}
  rememberComputer(id:string,live:any){this.store.run('INSERT INTO computer_console_specs VALUES(?,?) ON CONFLICT DO NOTHING',id,JSON.stringify(ownComputer(live)));}
  cache(id: string, sha: string, files: Record<string, string>) { this.store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET sha=excluded.sha,files=excluded.files,updated_at=excluded.updated_at', id, sha, JSON.stringify(files), new Date().toISOString()); }
  // The repository's skills at a commit, and the names (never the contents) of retired .bot/ files. A mirror that holds
  // the commit supplies the listing and contents; the files and their checks are the same either way. `repositoryId`
  // names the project the files are read for: one that still waits for its .bot/ import (it had nothing cached at the
  // upgrade) reads those files this once and imports them.
  async fetch(github: GitHub, sha: string, mirror?: Mirror, repositoryId?: string) {
    const listing = mirror?.has(sha) ? await mirror.listing(sha) : null, cached = !!listing;
    const tree = listing ?? await repositoryTree(github, (await github.request('GET', github.path('/git/commits/' + sha))).tree.sha);
    const read = async (file: any) => (cached ? await mirror!.blob(file.sha) : null) ?? Buffer.from((await github.request('GET', github.path('/git/blobs/' + file.sha))).content, 'base64');
    const retired = tree.tree.filter((f: any) => f.type === 'blob' && retiredPath(f.path));
    if (repositoryId !== undefined && importPending(this.store, repositoryId)) {
      const contents: Record<string, string> = {};
      for (const file of retired.filter((f: any) => Object.hasOwn(defaults, f.path) && ['100644', '100755'].includes(f.mode))) contents[file.path] = (await read(file)).toString('utf8');
      importRepository(this.store, repositoryId, sha, contents);
    }
    const files: Record<string, string> = Object.fromEntries(retired.slice(0, 50).map((f: any) => [f.path, '']));
    const entries = tree.tree.filter((f: any) => skillPath(f.path));
    if (entries.length > 32) ruleError('too_many_bot_skills', `.agents/skills/ 下共有 ${entries.length} 份 SKILL.md，最多 32 份`);
    for (const file of entries) {
      if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) ruleError('invalid_skill_file', `${file.path} 不是普通文件（符号链接或子模块）`);
      const data = await read(file);
      if (data.includes(0)) ruleError('invalid_rule_content', `${file.path} 不是文本文件（含 NUL 字节）`);
      files[file.path] = data.toString('utf8');
    }
    return files;
  }
  async view(id: string) {
    const saved = this.store.get('SELECT * FROM repository_rule_sources WHERE repository_id=?', id), policy = this.store.get('SELECT * FROM policies WHERE repository_id=?', id)!;
    const env = await this.manager?.call('GET', '/v1/projects/' + id).catch(() => null);
    const imported = this.store.get('SELECT sha,imported_at,report FROM rule_imports WHERE repository_id=?', id);
    return { ...resolveRules(policy, saved ? JSON.parse(saved.files) : {}, this.consoleComputer(id,env?.computer), projectLabels(this.store, id)), sha: saved?.sha || null, updated_at: saved?.updated_at || null, needs_refresh: !saved,
      imported: imported ? { sha: imported.sha, imported_at: imported.imported_at, ...JSON.parse(imported.report) } : null };
  }
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const match = /^\/api\/repositories\/([^/]+)\/rules(?:\/(refresh|apply-computer))?$/.exec(url.pathname); if (!match) return undefined;
    const id = match[1]!; repository(this.store, user, id);
    if (method === 'GET' && !match[2]) return { rules: await this.view(id) };
    // The console override editor of the rule files is gone (#935): rules are the Manager prompt's sections and the roles.
    if (method === 'PUT' && !match[2]) throw Object.assign(new HttpError(410, 'rules_update_removed'), { detail: rulesUpdateRemoved });
    if (method === 'POST' && match[2] === 'refresh') {
      fields(input, []); const repo = this.store.get('SELECT * FROM repositories WHERE id=?', id)!;
      const github = new GitHub(this.store, repo, new Redactor(), async () => {}, this.githubUrl); await github.connect(false);
      const ref = await github.ref(github.defaultBranch); if (!ref) fail(409, 'repository_has_no_commit');
      this.cache(id, ref.object.sha, await this.fetch(github, ref.object.sha, undefined, id)); return { rules: await this.view(id) };
    }
    // Applying .bot/computer.yaml at once went with the file (#935): the machine page saves the project computer directly.
    if (method === 'POST' && match[2] === 'apply-computer') throw Object.assign(new HttpError(410, 'rules_update_removed'), { detail: '仓库 .bot/computer.yaml 已不再读取；机器配置在项目「机器」页修改，保存后立即重建虚拟电脑。' });
    return fail(404, 'not_found');
  }
}
