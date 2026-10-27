import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { Store, Row } from '../storage/database.js';
import { type Actor, repository, superAdmin } from '../app/auth.js';
import { fail, fields, type Json } from '../core/security.js';
import { GitHub, repositoryTree } from '../github/client.js';
import { Redactor } from '../agent/common.js';
import type { Manager } from '../projects/service.js';

// The scenario rules are the Markdown files in docs/prompts, read once at startup so the documented text and the
// text the model receives cannot drift apart. The runtime image copies that directory next to dist.
const prompt = (name: string) => readFileSync(resolve(import.meta.dirname, '../../docs/prompts', name), 'utf8');
export const defaults: Record<string, string> = {
  '.bot/guide.md': 'Act on the stated Issue or PR. Inspect relevant code and tests. Keep conclusions concise and evidence-based. Never invent test results. GitHub publication and authorization belong to the control plane. Do not merge PRs or expose credentials.',
  '.bot/rules/labels.md': prompt('labels.md'),
  '.bot/rules/issue-review.md': prompt('issue-review.md'),
  '.bot/rules/pr-review.md': prompt('pr-review.md'),
  '.bot/rules/issue-development.md': prompt('issue-development.md'),
  '.bot/computer.yaml': '{}\n'
};
export const behaviorPath = (path: string) => path === '.bot' || path.startsWith('.bot/') || path === '.agents/skills' || path.startsWith('.agents/skills/');
const skillPath = (path: string) => /^\.agents\/skills\/(?:[^/]+\/)+SKILL\.md$/.test(path);
const rulePath = (path: string) => Object.hasOwn(defaults, path) || skillPath(path);
// One rule file holds at most this many UTF-8 bytes, whether it comes from the console or the repository.
export const maxRuleBytes = 16384;
// Rule file errors a person has to fix; a task that meets one waits for configuration instead of failing.
export const ruleErrors = new Set(['bot_rule_too_large', 'invalid_bot_label', 'invalid_bot_computer', 'invalid_bot_rule_file', 'invalid_rule_content', 'too_many_bot_skills', 'unsafe_bot_rule']);
export function resolveRules(policy: Row, files: Record<string, string>, computer: any = {}) {
  if(Object.keys(files).filter(skillPath).length>32)fail(400,'too_many_bot_skills');
  const repositoryRules=Object.entries(files).filter(([path])=>rulePath(path));
  // A NUL byte means the file is not text; it is rejected, not read as missing, also when an older version cached it.
  if(repositoryRules.some(([,content])=>content.includes('\0')))fail(400,'invalid_rule_content');
  if(repositoryRules.some(([,content])=>Buffer.byteLength(content)>maxRuleBytes))fail(400,'bot_rule_too_large');
  const overrides = JSON.parse(policy.rule_overrides || '{}'), rows: any[] = [];
  const consoleRules: Record<string, string> = { ...overrides };
  // The existing manager computer is the console layer, not a new resource system.
  const allowed = ['cpus', 'memory_mb', 'pids', 'tmp_mb', 'egress', 'packages', 'env', 'setup_script'];
  const consoleComputer = Object.fromEntries(allowed.filter(key => computer[key] !== undefined).map(key => [key, computer[key]]));
  let effectiveComputer = { ...consoleComputer };
  for (const [path, builtin] of Object.entries(defaults)) {
    const layers = [{ source: 'builtin', content: builtin }];
    if (path === '.bot/computer.yaml' && Object.keys(consoleComputer).length) layers.push({ source: 'console', content: JSON.stringify(consoleComputer, null, 2) });
    else if (Object.hasOwn(consoleRules,path)) layers.push({ source: 'console', content: consoleRules[path]! });
    if (Object.hasOwn(files,path)) layers.push({ source: 'repository', content: files[path]! });
    let effective = layers.at(-1)!.content;
    if (path === '.bot/computer.yaml') {
      try { const value = parse(files[path] || consoleRules[path] || '{}', { maxAliasCount: 0 }) || {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        // Commands no longer have a time limit; files written for older versions may still set one, which is ignored.
        delete value.max_command_minutes;
        if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error();
        effectiveComputer = { ...consoleComputer, ...value }; effective = JSON.stringify(effectiveComputer, null, 2);
      } catch { return fail(400, 'invalid_bot_computer'); }
    }
    rows.push({ path, layers, source: layers.at(-1)!.source, effective });
  }
  for (const [path, content] of Object.entries(files).filter(([path]) => skillPath(path))) rows.push({ path, source: 'repository', layers: [{ source: 'repository', content }], effective: content });
  const effective = (path: string) => rows.find(r => r.path === path)!.effective;
  return { files: rows, computer: effectiveComputer, review_label: declaredLabel(effective('.bot/rules/labels.md'), 'review_label'),
    development_label: declaredLabel(effective('.bot/rules/issue-development.md'), 'development_label') || defaultDevelopmentLabel };
}
// Automatic development needs this label on the Issue, applied by a person. A development rule without the line keeps
// the built-in name, so replacing the rule text can never switch the requirement off.
export const defaultDevelopmentLabel = 'bot-develop';
// The first `key: value` line of a rule file; a JSON string keeps the exact characters. The value ends with its line:
// `key:` alone declares an empty label rather than taking the next line.
function declaredLabel(text: string, key: string) {
  const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim();
  let label = raw || '';
  try { if (raw?.startsWith('"')) label = JSON.parse(raw); } catch { return fail(400, 'invalid_bot_label'); }
  if (label.length > 50 || label !== label.trim() || /\p{Cc}/u.test(label)) fail(400, 'invalid_bot_label');
  return label;
}
// The development label from the saved rule layers, without calling GitHub or the manager.
export function developmentLabel(store: Store, repositoryId: string) {
  const path = '.bot/rules/issue-development.md', policy = store.get('SELECT rule_overrides FROM policies WHERE repository_id=?', repositoryId);
  const saved = store.get('SELECT files FROM repository_rule_sources WHERE repository_id=?', repositoryId);
  const files = saved ? JSON.parse(saved.files) : {}, overrides = JSON.parse(policy?.rule_overrides || '{}');
  const text = Object.hasOwn(files, path) ? files[path] : Object.hasOwn(overrides, path) ? overrides[path] : defaults[path]!;
  if (text.includes('\0')) fail(400, 'invalid_rule_content');
  return declaredLabel(text, 'development_label') || defaultDevelopmentLabel;
}
export class RuleService {
  constructor(readonly store: Store, readonly manager?: Manager, readonly githubUrl?: string) {
    if (!store.all('PRAGMA table_info(policies)').some(r => r.name === 'rule_overrides')) store.db.exec("ALTER TABLE policies ADD COLUMN rule_overrides TEXT NOT NULL DEFAULT '{}'");
    store.db.exec('CREATE TABLE IF NOT EXISTS repository_rule_sources(repository_id TEXT PRIMARY KEY,sha TEXT NOT NULL,files TEXT NOT NULL,updated_at TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS computer_console_specs(repository_id TEXT PRIMARY KEY,spec TEXT NOT NULL)');
    // Review guidance and the review label used to be policy fields that fed the console layer of the rule files.
    // Move them into that layer once, so the rule files are the only place to edit them; existing overrides win as before.
    store.transaction(() => {
      for (const row of store.all("SELECT repository_id,rule_overrides,review_instructions,review_label FROM policies WHERE review_instructions<>'' OR review_label<>''")) {
        const overrides = JSON.parse(row.rule_overrides || '{}');
        if (row.review_instructions) for (const path of ['.bot/rules/issue-review.md', '.bot/rules/pr-review.md']) if (!Object.hasOwn(overrides, path)) overrides[path] = defaults[path] + '\n\n' + row.review_instructions;
        if (row.review_label && !Object.hasOwn(overrides, '.bot/rules/labels.md')) overrides['.bot/rules/labels.md'] = 'review_label: ' + JSON.stringify(row.review_label);
        store.run("UPDATE policies SET rule_overrides=?,review_instructions='',review_label='' WHERE repository_id=?", JSON.stringify(overrides), row.repository_id);
      }
    });
  }
  consoleComputer(id:string,live:any){const row=this.store.get('SELECT spec FROM computer_console_specs WHERE repository_id=?',id);return row?JSON.parse(row.spec):live||{};}
  rememberComputer(id:string,live:any){this.store.run('INSERT INTO computer_console_specs VALUES(?,?) ON CONFLICT DO NOTHING',id,JSON.stringify(resolveRules({}, {}, live).computer));}
  cache(id: string, sha: string, files: Record<string, string>) { this.store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET sha=excluded.sha,files=excluded.files,updated_at=excluded.updated_at', id, sha, JSON.stringify(files), new Date().toISOString()); }
  async fetch(github: GitHub, sha: string) {
    const commit = await github.request('GET', github.path('/git/commits/' + sha)), tree = await repositoryTree(github,commit.tree.sha);
    const entries = tree.tree.filter((f: any) => rulePath(f.path));
    if (entries.length > 38) fail(400, 'too_many_bot_skills'); const files: Record<string, string> = {};
    for (const file of entries) {
      if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) fail(400, 'invalid_bot_rule_file');
      if (file.size > maxRuleBytes) fail(400, 'bot_rule_too_large');
      const blob = await github.request('GET', github.path('/git/blobs/' + file.sha)), data = Buffer.from(blob.content, 'base64');
      if (data.includes(0)) fail(400, 'invalid_rule_content');
      const content = data.toString('utf8'); if (Buffer.byteLength(content) > maxRuleBytes) fail(400, 'bot_rule_too_large'); files[file.path] = content;
    }
    return files;
  }
  async view(id: string) {
    const saved = this.store.get('SELECT * FROM repository_rule_sources WHERE repository_id=?', id), policy = this.store.get('SELECT * FROM policies WHERE repository_id=?', id)!;
    const env = await this.manager?.call('GET', '/v1/projects/' + id).catch(() => null);
    return { ...resolveRules(policy, saved ? JSON.parse(saved.files) : {}, this.consoleComputer(id,env?.computer)), sha: saved?.sha || null, updated_at: saved?.updated_at || null, needs_refresh: !saved };
  }
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const match = /^\/api\/repositories\/([^/]+)\/rules(?:\/(refresh|apply-computer))?$/.exec(url.pathname); if (!match) return undefined;
    const id = match[1]!; repository(this.store, user, id);
    if (method === 'GET' && !match[2]) return { rules: await this.view(id) };
    if (method === 'PUT' && !match[2]) {
      fields(input, ['path', 'content']); if (!Object.hasOwn(defaults, String(input.path)) || input.path === '.bot/computer.yaml') fail(400, 'invalid_rule_path');
      // The limit counts UTF-8 bytes, as for repository files; longer text is rejected, never cut.
      if (input.content !== null && (typeof input.content !== 'string' || Buffer.byteLength(input.content) > maxRuleBytes || input.content.includes('\0'))) fail(400, 'invalid_rule_content');
      const row = this.store.get('SELECT * FROM policies WHERE repository_id=?', id)!, values = JSON.parse(row.rule_overrides || '{}');
      if (input.content === null) delete values[String(input.path)]; else values[String(input.path)] = input.content;
      resolveRules({ ...row, rule_overrides: JSON.stringify(values) }, {});
      this.store.run('UPDATE policies SET rule_overrides=? WHERE repository_id=?', JSON.stringify(values), id); this.store.audit(user.id, 'rules.updated', String(input.path), id); return { rules: await this.view(id) };
    }
    if (method === 'POST' && match[2] === 'refresh') {
      fields(input, []); const repo = this.store.get('SELECT * FROM repositories WHERE id=?', id)!;
      const github = new GitHub(this.store, repo, new Redactor(), async () => {}, this.githubUrl); await github.connect(false);
      const ref = await github.ref(github.defaultBranch); if (!ref) fail(409, 'repository_has_no_commit');
      this.cache(id, ref.object.sha, await this.fetch(github, ref.object.sha)); return { rules: await this.view(id) };
    }
    if (method === 'POST' && match[2] === 'apply-computer') {
      fields(input, []); superAdmin(user); if (!this.manager) fail(503, 'manager_not_configured');
      const live = await this.manager!.call('GET', '/v1/projects/' + id), rules = await this.view(id);
      if (!live) fail(409, 'environment_not_ready');
      this.rememberComputer(id,live.computer);
      const result = await this.manager!.call('POST', `/v1/projects/${id}/configure`, { operation_id: (await import('../core/security.js')).randomId(), generation: live.generation, request: rules.computer }, 35 * 60000);
      this.store.audit(user.id, 'rules.computer_applied', id, id); return { environment: result };
    }
    return fail(404, 'not_found');
  }
}
