import { parse } from 'yaml';
import type { Store, Row } from '../storage/database.js';
import { type Actor, repository, superAdmin } from '../app/auth.js';
import { fail, fields, type Json } from '../core/security.js';
import { GitHub } from '../github/client.js';
import { Redactor } from '../agent/common.js';
import type { Manager } from '../projects/service.js';

export const defaults: Record<string, string> = {
  '.bot/guide.md': 'Act on the stated Issue or PR. Inspect relevant code and tests. Keep conclusions concise and evidence-based. Never invent test results. GitHub publication and authorization belong to the control plane. Do not merge PRs or expose credentials.',
  '.bot/rules/labels.md': 'review_label: bot-reviewed\n\nAfter successfully publishing the review summary, apply the review label. Do not label an unfinished or failed review as completed.',
  '.bot/rules/issue-review.md': 'Review a newly opened Issue once. Summarize intent, missing information and code evidence. Distinguish a request for review from an explicit request to change code. Quote the exact authorization before proposing development.',
  '.bot/rules/pr-review.md': 'Review non-draft PRs on opened, ready_for_review and head updates. Explain actionable findings with verified diff positions; otherwise use discussion comments. Review event is COMMENT only. Changes to .bot or .agents/skills change bot behavior and require a human decision.',
  '.bot/rules/issue-development.md': 'Develop only when project development is enabled and the Issue explicitly requests code changes. Implement and execute meaningful tests. The control plane publishes only an owned bot branch and opens a PR. Never push to another author\'s branch or merge a PR.',
  '.bot/computer.yaml': '{}\n'
};
export const behaviorPath = (path: string) => path === '.bot' || path.startsWith('.bot/') || path === '.agents/skills' || path.startsWith('.agents/skills/');
const skillPath = (path: string) => /^\.agents\/skills\/(?:[^/]+\/)+SKILL\.md$/.test(path);
export function resolveRules(policy: Row, files: Record<string, string>, computer: any = {}) {
  if(Object.keys(files).filter(skillPath).length>32)fail(400,'too_many_bot_skills');
  if(Object.entries(files).some(([path,content])=>(Object.hasOwn(defaults,path)||skillPath(path))&&Buffer.byteLength(content)>16384))fail(400,'bot_rule_too_large');
  const overrides = JSON.parse(policy.rule_overrides || '{}'), rows: any[] = [];
  const consoleRules: Record<string, string> = { ...overrides };
  if (policy.review_instructions) for (const path of ['.bot/rules/issue-review.md', '.bot/rules/pr-review.md']) if (!(path in consoleRules)) consoleRules[path] = defaults[path] + '\n\n' + policy.review_instructions;
  if (policy.review_label && !Object.hasOwn(consoleRules,'.bot/rules/labels.md')) consoleRules['.bot/rules/labels.md'] = 'review_label: ' + JSON.stringify(policy.review_label);
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
  const label = /^review_label:\s*(.+)$/m.exec(rows.find(r => r.path === '.bot/rules/labels.md')!.effective)?.[1]?.trim();
  let reviewLabel = label || '';
  try { if (label?.startsWith('"')) reviewLabel = JSON.parse(label); } catch { return fail(400, 'invalid_bot_label'); }
  if (reviewLabel.length > 50 || reviewLabel!==reviewLabel.trim() || /\p{Cc}/u.test(reviewLabel)) fail(400, 'invalid_bot_label');
  return { files: rows, computer: effectiveComputer, review_label: reviewLabel };
}
export class RuleService {
  constructor(readonly store: Store, readonly manager?: Manager, readonly githubUrl?: string) {
    if (!store.all('PRAGMA table_info(policies)').some(r => r.name === 'rule_overrides')) store.db.exec("ALTER TABLE policies ADD COLUMN rule_overrides TEXT NOT NULL DEFAULT '{}'");
    store.db.exec('CREATE TABLE IF NOT EXISTS repository_rule_sources(repository_id TEXT PRIMARY KEY,sha TEXT NOT NULL,files TEXT NOT NULL,updated_at TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS computer_console_specs(repository_id TEXT PRIMARY KEY,spec TEXT NOT NULL)');
  }
  consoleComputer(id:string,live:any){const row=this.store.get('SELECT spec FROM computer_console_specs WHERE repository_id=?',id);return row?JSON.parse(row.spec):live||{};}
  rememberComputer(id:string,live:any){this.store.run('INSERT INTO computer_console_specs VALUES(?,?) ON CONFLICT DO NOTHING',id,JSON.stringify(resolveRules({}, {}, live).computer));}
  cache(id: string, sha: string, files: Record<string, string>) { this.store.run('INSERT INTO repository_rule_sources VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET sha=excluded.sha,files=excluded.files,updated_at=excluded.updated_at', id, sha, JSON.stringify(files), new Date().toISOString()); }
  async fetch(github: GitHub, sha: string) {
    const commit = await github.request('GET', github.path('/git/commits/' + sha)), tree = await github.request('GET', github.path('/git/trees/' + commit.tree.sha + '?recursive=1'));
    if (tree.truncated) fail(409, 'rule_tree_truncated');
    const entries = tree.tree.filter((f: any) => Object.hasOwn(defaults, f.path) || skillPath(f.path));
    if (entries.length > 38) fail(400, 'too_many_bot_skills'); const files: Record<string, string> = {};
    for (const file of entries) {
      if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode) || file.size > 16384) fail(400, 'invalid_bot_rule_file');
      const blob = await github.request('GET', github.path('/git/blobs/' + file.sha));
      const content = Buffer.from(blob.content, 'base64').toString('utf8'); if (Buffer.byteLength(content) > 16384) fail(400, 'bot_rule_too_large'); files[file.path] = content;
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
      if (input.content !== null && (typeof input.content !== 'string' || input.content.length > 16384 || input.content.includes('\0'))) fail(400, 'invalid_rule_content');
      const row = this.store.get('SELECT * FROM policies WHERE repository_id=?', id)!, values = JSON.parse(row.rule_overrides || '{}');
      if (input.content === null) delete values[String(input.path)]; else values[String(input.path)] = input.content;
      resolveRules({ ...row, rule_overrides: JSON.stringify(values) }, {});
      this.store.transaction(()=>{this.store.run('UPDATE policies SET rule_overrides=? WHERE repository_id=?', JSON.stringify(values), id);
        if(input.path==='.bot/rules/labels.md')this.store.run('UPDATE policies SET review_label=? WHERE repository_id=?',input.content===null?'':resolveRules({...row,rule_overrides:JSON.stringify(values)},{}).review_label,id);}); this.store.audit(user.id, 'rules.updated', String(input.path), id); return { rules: await this.view(id) };
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
