import { randomId, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import { appJwt, missingPermissions, revokeInstallationToken } from '../github/client.js';
export { boardLocation } from '../public-board/state.js';
import { workflowSet } from './gate-templates.js';

type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'blocked' | 'failed';
export type RunState = 'queued' | 'running' | 'planned' | 'awaiting_merge' | 'done' | 'partial' | 'blocked' | 'failed';
// `selected` is false for an item this run was not asked to execute; `code` is why an item stopped.
interface Step { id: string; title: string; status: StepStatus; detail: string; at: string | null; url?: string; selected?: boolean; code?: string }
type Permissions = Record<string, string>;
/** One run's GitHub App credentials; every installation token it mints is revoked when the run ends. */
interface AppSession { appId: string; privateKey: string; issued: string[] }

/** The gate onboarding item; publication is configured separately. */
export const quickstartItems = ['gate_pr'] as const;
export type Item = typeof quickstartItems[number];
const itemTitles: Record<Item, string> = { gate_pr: '门禁 PR' };
/** How one item ended. */
interface Outcome { status: StepStatus; detail: string; code?: string; url?: string }
const blocked = (detail: string, code: string): Outcome => ({ status: 'blocked', detail, code });
/** What the items of one run share: the source repository read with its own installation token. */
interface Source { app: AppSession; appAccountId: string; id: string; dryRun: boolean; full: string; owner: string; name: string; repositoryId: string;
  installation: any; token: string; defaultBranch: string; private: boolean }

const step = (id: string, title: string): Step => ({ id, title, status: 'pending', detail: '等待执行', at: null });
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// Onboarding mints one installation token per purpose, each limited to what that step writes and to what the
// installation has granted. Review and development tokens (GitHub.connect) never ask for workflows, pages or
// administration, so a development task still cannot change `.github/workflows/` or repository settings.
export const quickstartPermissions = {
  // The gate PR commits `.github/workflows/` to the source repository.
  source: { contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read' },
  // Reads the CI-workflow template repository through the App installed on it.
  template: { contents: 'read', metadata: 'read' },
} satisfies Record<string, Permissions>;
const permissionNames: Record<string, string> = { contents: 'Contents', pull_requests: 'Pull requests', workflows: 'Workflows',
  actions: 'Actions', metadata: 'Metadata', administration: 'Administration' };
const levelNames: Record<string, string> = { read: 'Read-only', write: 'Read and write' };

/** What an installation still lacks for one item, in GitHub's own permission names; null when nothing is missing. */
function permissionGap(installation: any, required: Permissions): Outcome | null {
  const missing = missingPermissions(installation.permissions, required);
  if (!missing.length) return null;
  const names = missing.map(item => `${permissionNames[item.permission] || item.permission}（${levelNames[item.required]}）`).join('、');
  return blocked(`GitHub App 缺少权限，需要在 App 设置里新增，并在 ${String(installation.account?.login || installation.id)} 的安装里同意：${names}`, 'app_permissions_missing');
}

/** Gate onboarding opens a source PR; board publication is managed by the repository list switch. */
export class Quickstart {
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com',
    readonly templateRepo = process.env.BOT_CI_TEMPLATE_REPO || 'agent-CI-Infra/CI-workflow') {}

  /** An empty token sends the request without credentials (public reads). */
  private async request(method: string, path: string, token: string, body?: unknown): Promise<any | null> {
    let response: Response;
    try {
      response = await fetch(this.apiUrl.replace(/\/$/, '') + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('github_unavailable'); }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('github_http_' + response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  private async file(repo: string, path: string, token: string): Promise<string | null> {
    const value = await this.request('GET', `/repos/${repo}/contents/${encode(path)}`, token);
    return value && !Array.isArray(value) && typeof value.content === 'string' ? Buffer.from(value.content, 'base64').toString('utf8') : null;
  }
  private async put(repo: string, path: string, content: string, branch: string, token: string, message = `chore(ci): add ${path}`): Promise<void> {
    const payload = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch };
    try { await this.request('PUT', `/repos/${repo}/contents/${encode(path)}`, token, payload); }
    catch (error) {
      if (!String((error as Error).message).endsWith('422')) throw error;
      const current = await this.request('GET', `/repos/${repo}/contents/${encode(path)}?ref=${encodeURIComponent(branch)}`, token);
      if (!current?.sha) throw error;
      await this.request('PUT', `/repos/${repo}/contents/${encode(path)}`, token, { ...payload, sha: current.sha });
    }
  }

  private jwt(app: AppSession): string { return appJwt(app.appId, app.privateKey); }
  /** The App's installation on a repository or organization; null when the App is not installed there. */
  private installation(app: AppSession, path: string): Promise<any | null> { return this.request('GET', path, this.jwt(app)); }
  /** An installation token with the wanted permissions, lowered to what the installation has granted. */
  private async token(app: AppSession, installation: any, wanted: Permissions, scope: Json = {}): Promise<string> {
    const granted = installation?.permissions || {}, permissions: Permissions = {};
    for (const [key, level] of Object.entries(wanted)) if (granted[key]) permissions[key] = granted[key] === 'read' ? 'read' : level;
    const access = await this.request('POST', `/app/installations/${encodeURIComponent(String(installation.id))}/access_tokens`, this.jwt(app), { ...scope, permissions });
    const token = typeof access?.token === 'string' ? access.token : '';
    if (!token) throw new Error('github_token_missing');
    app.issued.push(token); return token;
  }
  /**
   * A token that reads a template repository: the App's own installation there (needed when it is private), otherwise,
   * for a public repository, the token at hand or no token at all. Null when the template cannot be read.
   */
  private async readToken(app: AppSession, repo: string, token: string): Promise<string | null> {
    const installation = await this.installation(app, `/repos/${repo}/installation`);
    if (installation) return this.token(app, installation, quickstartPermissions.template, { repositories: [repo.split('/')[1]] });
    for (const candidate of [token, '']) {
      const meta = await this.request('GET', `/repos/${repo}`, candidate).catch(() => null);
      if (meta?.private === false) return candidate;
    }
    return null;
  }

  latest(repositoryId: string): Json | null {
    const row = this.store.get('SELECT * FROM quickstart_runs WHERE repository_id=? ORDER BY created_at DESC LIMIT 1', repositoryId);
    return row ? this.view(row) : null;
  }
  /** Each item's most recent result, from the latest run that executed it. */
  items(repositoryId: string): Json {
    const rows = this.store.all('SELECT * FROM quickstart_runs WHERE repository_id=? ORDER BY created_at DESC LIMIT 20', repositoryId), items: Json = {};
    for (const item of quickstartItems) for (const row of rows) {
      const found = (JSON.parse(String(row.steps)) as Step[]).find(entry => entry.id === item && entry.selected !== false);
      if (found) { items[item] = { ...found, run_id: row.id, dry_run: !!row.dry_run }; break; }
    }
    return items;
  }
  get(id: string): Json | null {
    const row = this.store.get('SELECT * FROM quickstart_runs WHERE id=?', id);
    return row ? this.view(row) : null;
  }
  start(repositoryId: string, dryRun = false, items: readonly Item[] = quickstartItems): Json {
    const active = this.store.get("SELECT * FROM quickstart_runs WHERE repository_id=? AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1", repositoryId);
    if (active) return this.view(active)!;
    const id = randomId(), now = new Date().toISOString();
    const steps = [step('preflight', '预检'), ...quickstartItems.map(item => {
      const entry = { ...step(item, itemTitles[item]), selected: items.includes(item) };
      return entry.selected ? entry : { ...entry, status: 'skipped' as const, detail: '本次没有执行' };
    })];
    this.store.run('INSERT INTO quickstart_runs VALUES(?,?,?,?,?,?,?,?,?)', id, repositoryId, 'queued', JSON.stringify(steps), null, null, dryRun ? 1 : 0, now, now);
    void this.execute(id).catch(() => {});
    return this.view(this.store.get('SELECT * FROM quickstart_runs WHERE id=?', id)!)!;
  }

  private view(row: Record<string, any>): Json | null {
    if (!row) return null;
    return { id: row.id, repository_id: row.repository_id, state: row.state, steps: JSON.parse(row.steps),
      pr_url: row.pr_url || null, error: row.error || null, dry_run: !!row.dry_run, created_at: row.created_at, updated_at: row.updated_at };
  }

  private async execute(id: string): Promise<void> {
    const run = this.store.get('SELECT * FROM quickstart_runs WHERE id=?', id)!;
    const repositoryId = String(run.repository_id), dryRun = !!run.dry_run;
    const steps: Step[] = JSON.parse(String(run.steps));
    const found = (stepId: string) => steps.find(item => item.id === stepId)!;
    const save = (state: RunState, error: string | null = null) => this.store.run('UPDATE quickstart_runs SET state=?,steps=?,error=?,updated_at=? WHERE id=?',
      state, JSON.stringify(steps), error, new Date().toISOString(), id);
    const mark = (stepId: string, outcome: Outcome) => {
      const item = found(stepId); item.status = outcome.status; item.detail = outcome.detail; item.at = new Date().toISOString();
      if (outcome.url) item.url = outcome.url; if (outcome.code) item.code = outcome.code;
      save('running');
    };
    const selected = quickstartItems.filter(item => found(item).selected !== false);
    // Without the source repository no item can run: each selected item stops with the preflight's reason.
    const stop = (outcome: Outcome) => {
      mark('preflight', outcome);
      for (const item of selected) mark(item, { status: 'blocked', detail: '预检没有通过，这一项没有执行', code: outcome.code });
      save(outcome.status === 'failed' ? 'failed' : 'blocked', outcome.code || null);
    };
    save('running');

    const registered = this.store.get('SELECT * FROM repositories WHERE id=?', repositoryId);
    const installed = registered ? null : this.store.get('SELECT * FROM installed_repositories WHERE repository_id=? AND installed=1', repositoryId);
    const row = registered || installed;
    if (!row) return stop({ status: 'failed', detail: '仓库不在安装列表中', code: 'repository_not_found' });
    const full = String(row.full_name), [owner = '', name = ''] = full.split('/');
    // Only GitHub App installation tokens; a bot account's long-lived token is never read here.
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', String(row.account_id));
    if (account?.type !== 'github_app') return stop(blocked('门禁接入只使用 GitHub App 安装令牌；这个仓库挂在机器人账号上，需要改为安装 GitHub App', 'github_app_required'));
    const secrets = this.store.secrets.open(account.credentials, `account:${account.id}`);
    if (!secrets.private_key) return stop(blocked('GitHub App 账号没有保存私钥', 'github_credentials_missing'));
    const app: AppSession = { appId: String(account.app_id), privateKey: String(secrets.private_key), issued: [] };

    try {
      let source: Source;
      try {
        mark('preflight', { status: 'running', detail: '读取仓库信息…' });
        const installation = await this.installation(app, `/repos/${full}/installation`);
        if (!installation) return stop(blocked('GitHub App 没有安装到该仓库', 'repository_not_found'));
        const token = await this.token(app, installation, quickstartPermissions.source, { repository_ids: [Number(repositoryId)] });
        const meta = await this.request('GET', `/repos/${full}`, token);
        if (!meta) return stop(blocked('没有该仓库的访问权限', 'repository_not_found'));
        source = { app, appAccountId: String(account.id), id, dryRun, full, owner, name, repositoryId, installation, token, defaultBranch: String(meta.default_branch || 'main'), private: !!meta.private };
        mark('preflight', { status: 'done', detail: `默认分支 ${source.defaultBranch} · ${source.private ? '私有仓库' : '公开仓库'}` });
      } catch (error) { const code = (error as Error).message; return stop({ status: 'failed', detail: `失败：${code}`, code }); }

      // Each item checks what it needs before its first write and stops on its own; the others still run.
      const outcomes: Partial<Record<Item, Outcome>> = {};
      for (const item of selected) {
        const progress = (detail: string) => mark(item, { status: 'running', detail });
        progress('检查条件…');
        let outcome: Outcome;
        try {
          outcome = await this.gate(source, progress);
        } catch (error) { const code = (error as Error).message; outcome = { status: 'failed', detail: `失败：${code}`, code }; }
        outcomes[item] = outcome; mark(item, outcome);
        if (outcome.status === 'done' && outcome.url && item === 'gate_pr') this.store.run('UPDATE quickstart_runs SET pr_url=? WHERE id=?', outcome.url, id);
      }
      const bad = selected.filter(item => outcomes[item]!.status === 'blocked' || outcomes[item]!.status === 'failed');
      const state: RunState = !bad.length ? (dryRun ? 'planned' : 'done') : bad.length < selected.length ? 'partial'
        : bad.some(item => outcomes[item]!.status === 'failed') ? 'failed' : 'blocked';
      save(state, bad.length ? outcomes[bad[0]!]!.code || null : dryRun ? 'dry_run' : null);
    } finally {
      await Promise.all(app.issued.splice(0).map(token => revokeInstallationToken(this.apiUrl, token).catch(() => false)));
    }
  }

  /** The gate PR: CI-workflow gate files on a bot branch of the source repository. */
  private async gate(source: Source, progress: (detail: string) => void): Promise<Outcome> {
    const { app, id, full, name, token, defaultBranch, dryRun } = source;
    if (await this.file(full, '.github/ci-gates.json', token) !== null) return { status: 'skipped', detail: '门禁配置已存在，不需要再开 PR' };
    if (await this.file(full, '.github/workflows/ci.yml', token) !== null) return blocked('仓库已有 .github/workflows/ci.yml，需要人工决定是否合并门禁配置', 'ci_exists');
    const pkg = await this.file(full, 'package.json', token);
    if (!pkg) return blocked('暂时只支持 Node 仓库（未找到 package.json）', 'unsupported_stack');
    const parsed = JSON.parse(pkg), scripts = parsed.scripts || {};
    // Empty lanes are runnable scaffolding; repository maintainers choose their own checks.
    const lanes = Object.fromEntries(['build', 'pr-ready', 'pr-merge', 'daily', 'release'].map(lane => [lane, { commands: [] }]));
    const config = { version: 1, level: 'C1', preset: 'auto', caseRoot: 'test', lanes };
    // setup-node caches npm and npm ci needs a lock file; an empty dependency tree can be locked without the registry.
    const hasDependencies = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .some(key => parsed[key] && Object.keys(parsed[key]).length);
    const existingLock = await this.file(full, 'package-lock.json', token) ?? await this.file(full, 'yarn.lock', token) ?? await this.file(full, 'pnpm-lock.yaml', token);
    let lockfile: string | null = null;
    if (existingLock === null) {
      if (hasDependencies) return blocked('仓库没有锁文件；带依赖的项目请先提交 package-lock.json 再接门禁', 'missing_lockfile');
      const label = String(parsed.name || name), version = String(parsed.version || '1.0.0');
      lockfile = JSON.stringify({ name: label, version, lockfileVersion: 3, requires: true, packages: { '': { name: label, version } } }, null, 2) + '\n';
    }
    const gap = permissionGap(source.installation, quickstartPermissions.source);
    if (gap) return gap;
    const templateToken = await this.readToken(app, this.templateRepo, token);
    if (templateToken === null) return blocked(`读取模板仓库 ${this.templateRepo} 被拒绝，需要把同一个 GitHub App 安装到该仓库`, 'template_app_not_installed');
    const extraWorkflows = await this.workflowTemplates(scripts, templateToken);
    if (dryRun) {
      const names = ['.github/workflows/ci.yml', ...Object.keys(extraWorkflows)].join('、');
      return { status: 'skipped', detail: `预演：将新增 ${names}、.github/ci-gates.json、scripts/gate/gate.mjs${lockfile !== null ? '、package-lock.json' : ''}，并开 PR` };
    }
    const template = await this.file(this.templateRepo, 'template/.github/workflows/ci.yml', templateToken);
    const gateScript = await this.file(this.templateRepo, 'scripts/gate/gate.mjs', templateToken);
    if (!template || !gateScript) return { status: 'failed', detail: '读取 CI-workflow 模板失败', code: 'template_unavailable' };
    const ref = await this.request('GET', `/repos/${full}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, token);
    const sha = ref?.object?.sha;
    if (!sha) return { status: 'failed', detail: '读不到默认分支的提交', code: 'base_branch_unavailable' };
    progress('正在创建分支与 PR…');
    const branch = `bot/gate-onboarding-${id.slice(0, 8)}`;
    await this.request('POST', `/repos/${full}/git/refs`, token, { ref: `refs/heads/${branch}`, sha });
    await this.put(full, '.github/workflows/ci.yml', template, branch, token);
    for (const [workflowPath, content] of Object.entries(extraWorkflows)) await this.put(full, workflowPath, content, branch, token);
    await this.put(full, '.github/ci-gates.json', JSON.stringify(config, null, 2) + '\n', branch, token);
    await this.put(full, 'scripts/gate/gate.mjs', gateScript, branch, token);
    if (lockfile !== null) await this.put(full, 'package-lock.json', lockfile, branch, token);
    const pr = await this.request('POST', `/repos/${full}/pulls`, token, {
      title: 'chore(ci): connect CI gates', head: branch, base: defaultBranch,
      body: `提供 CI-workflow 门禁框架及版本标签触发的 .github/workflows/release.yml。\n\n<!-- dept-bot:quickstart:${id} -->\n\nci-gates.json 的 lane 命令留空，由仓库开发者填写；空 lane 只报告 not_applicable，不表示实际检查通过。控制面只提供框架，并在人工确认后打标签。具体检查项和是否发布 PyPI、npm 包或镜像，由仓库开发者写进自己的 Release workflow，由标签触发 Release Actions。手动发版本仍先生成草稿，再由人正式发布。` });
    if (!pr?.html_url) return { status: 'failed', detail: 'PR 创建失败', code: 'pr_failed' };
    return { status: 'done', detail: `已创建 PR #${pr.number}，合入后门禁生效`, url: String(pr.html_url) };
  }

  private async workflowTemplates(scripts: Record<string, unknown>, token: string): Promise<Record<string, string>> {
    const bundled = workflowSet(scripts), result: Record<string, string> = {};
    for (const [workflowPath, fallback] of Object.entries(bundled)) {
      const remote = await this.file(this.templateRepo, `template/${workflowPath}`, token).catch(() => null);
      result[workflowPath] = remote ?? fallback;
    }
    return result;
  }
}
