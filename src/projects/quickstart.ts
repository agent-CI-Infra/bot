import { randomId, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import { appJwt, missingPermissions, revokeInstallationToken } from '../github/client.js';
import { workflowSet } from './gate-templates.js';

type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'blocked' | 'failed';
export type RunState = 'queued' | 'running' | 'planned' | 'awaiting_merge' | 'done' | 'partial' | 'blocked' | 'failed';
// `selected` is false for an item this run was not asked to execute; `code` is why an item stopped.
interface Step { id: string; title: string; status: StepStatus; detail: string; at: string | null; url?: string; selected?: boolean; code?: string }
type Permissions = Record<string, string>;
/** One run's GitHub App credentials; every installation token it mints is revoked when the run ends. */
interface AppSession { appId: string; privateKey: string; issued: string[] }

/** The onboarding items; each can be executed alone or together with the others. */
export const quickstartItems = ['gate_pr', 'board', 'dashboard'] as const;
export type Item = typeof quickstartItems[number];
const itemTitles: Record<Item, string> = { gate_pr: '门禁 PR', board: '单仓看板', dashboard: 'Dashboard 登记' };
/** How one item ended. */
interface Outcome { status: StepStatus; detail: string; code?: string; url?: string }
const blocked = (detail: string, code: string): Outcome => ({ status: 'blocked', detail, code });
/** What the items of one run share: the source repository read with its own installation token. */
interface Source { app: AppSession; id: string; dryRun: boolean; full: string; owner: string; name: string; repositoryId: string;
  installation: any; token: string; defaultBranch: string; private: boolean }

const step = (id: string, title: string): Step => ({ id, title, status: 'pending', detail: '等待执行', at: null });
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// Onboarding mints one installation token per purpose, each limited to what that step writes and to what the
// installation has granted. Review and development tokens (GitHub.connect) never ask for workflows, pages or
// administration, so a development task still cannot change `.github/workflows/` or repository settings.
export const quickstartPermissions = {
  // The gate PR commits `.github/workflows/` to the source repository.
  source: { contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read' },
  // The dashboard repository hosts the board branch and runs `Create board`.
  board: { actions: 'write', contents: 'read', metadata: 'read' },
  // The registration PR only changes JSON files.
  dashboard: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  // Reads the CI-workflow template repository through the App installed on it.
  template: { contents: 'read', metadata: 'read' },
} satisfies Record<string, Permissions>;
const permissionNames: Record<string, string> = { contents: 'Contents', pull_requests: 'Pull requests', workflows: 'Workflows',
  actions: 'Actions', metadata: 'Metadata', administration: 'Administration' };
const levelNames: Record<string, string> = { read: 'Read-only', write: 'Read and write' };

/** A source's board is an orphan branch of the dashboard repository, published under `/boards/<owner>/<repo>/`. */
export function boardLocation(dashboardRepo: string, full: string) {
  const [dashOwner = '', dashName = ''] = dashboardRepo.split('/');
  const key = full.toLowerCase();
  return { key, branch: `board/${key}`, url: `https://${dashOwner.toLowerCase()}.github.io/${dashName}/boards/${key}/` };
}
const boardKeyValid = (key: string) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(key);
/** Said once on a private source's plan: the dashboard reads it with one shared read-only secret. */
const privateTokenNote = 'dashboard 仓库需要一次性配置只读 secret PRIVATE_SOURCE_TOKEN';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** What an installation still lacks for one item, in GitHub's own permission names; null when nothing is missing. */
function permissionGap(installation: any, required: Permissions): Outcome | null {
  const missing = missingPermissions(installation.permissions, required);
  if (!missing.length) return null;
  const names = missing.map(item => `${permissionNames[item.permission] || item.permission}（${levelNames[item.required]}）`).join('、');
  return blocked(`GitHub App 缺少权限，需要在 App 设置里新增，并在 ${String(installation.account?.login || installation.id)} 的安装里同意：${names}`, 'app_permissions_missing');
}

/**
 * One-click onboarding as three items that run on their own:
 *  - gate_pr   — open a PR that adds the CI-workflow gate files to the source repository (the user merges it);
 *  - board     — trigger the dashboard's `Create board` workflow, which creates the board branch;
 *  - dashboard — open the registration PR on the dashboard for the board.
 * A shared preflight reads the source repository; after that each item checks only what it needs, so an item that cannot
 * run is reported and the others still go ahead. Every write lands on a bot branch or a workflow dispatch; nothing is
 * pushed to a default branch, and only GitHub App installation tokens are used.
 */
export class Quickstart {
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com',
    readonly templateRepo = process.env.BOT_CI_TEMPLATE_REPO || 'agent-CI-Infra/CI-workflow',
    readonly dashboardRepo = process.env.BOT_DASHBOARD_REPO || 'agent-CI-Infra/dashboard') {}

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
    if (account?.type !== 'github_app') return stop(blocked('公共配置只使用 GitHub App 安装令牌；这个仓库挂在机器人账号上，需要改为安装 GitHub App', 'github_app_required'));
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
        source = { app, id, dryRun, full, owner, name, repositoryId, installation, token, defaultBranch: String(meta.default_branch || 'main'), private: !!meta.private };
        mark('preflight', { status: 'done', detail: `默认分支 ${source.defaultBranch} · ${source.private ? `私有仓库 · ${privateTokenNote}` : '公开仓库'}` });
      } catch (error) { const code = (error as Error).message; return stop({ status: 'failed', detail: `失败：${code}`, code }); }

      // Each item checks what it needs before its first write and stops on its own; the others still run.
      const outcomes: Partial<Record<Item, Outcome>> = {};
      for (const item of selected) {
        const progress = (detail: string) => mark(item, { status: 'running', detail });
        progress('检查条件…');
        let outcome: Outcome;
        try {
          outcome = item === 'gate_pr' ? await this.gate(source, progress) : item === 'board' ? await this.board(source, progress) : await this.dashboard(source, outcomes.board);
        } catch (error) { const code = (error as Error).message; outcome = { status: 'failed', detail: `失败：${code}`, code }; }
        outcomes[item] = outcome; mark(item, outcome);
        if (outcome.status === 'done' && outcome.url && item !== 'board') this.store.run('UPDATE quickstart_runs SET pr_url=? WHERE id=?', outcome.url, id);
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
    const build = scripts.build ? ['npm run build'] : scripts.test ? ['npm test'] : [];
    const ready = [scripts.lint ? 'npm run lint' : null, scripts.test ? 'npm test' : null].filter((value): value is string => !!value);
    if (!build.length) return blocked('package.json 里没有 build 或 test 脚本，无法生成 build lane', 'no_build_script');
    const lanes: Json = { build: { commands: build } };
    const checks = ready.length ? ready : build;
    lanes['pr-ready'] = { commands: checks };
    lanes['pr-merge'] = { commands: checks };
    lanes.daily = { commands: checks };
    lanes.release = { commands: build };
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
      body: `把仓库接入 CI-workflow 门禁，并按脚本生成 build / CI / nightly / e2e / release 工作流。\n\n<!-- dept-bot:quickstart:${id} -->\n\n由控制面一键接入创建，合并前请确认 lane 命令符合本仓库的实际脚本。` });
    if (!pr?.html_url) return { status: 'failed', detail: 'PR 创建失败', code: 'pr_failed' };
    return { status: 'done', detail: `已创建 PR #${pr.number}，合入后门禁生效`, url: String(pr.html_url) };
  }

  /**
   * The board branch on the dashboard, created by that repository's `Create board` workflow. The branch records the
   * source's visibility, so the collector reads a private source with the dashboard's one shared PRIVATE_SOURCE_TOKEN.
   */
  private async board(source: Source, progress: (detail: string) => void): Promise<Outcome> {
    const { app, full, dryRun } = source;
    const location = boardLocation(this.dashboardRepo, full);
    if (!boardKeyValid(location.key)) return blocked(`仓库名 ${full} 不能用作看板分支，需要人工处理`, 'invalid_repository');
    const installation = await this.installation(app, `/repos/${this.dashboardRepo}/installation`);
    if (!installation) return blocked('需要把同一个 GitHub App 安装到 ' + this.dashboardRepo + '，才能创建单仓看板', 'dashboard_app_not_installed');
    const gap = permissionGap(installation, quickstartPermissions.board);
    if (gap) return gap;
    const token = await this.token(app, installation, quickstartPermissions.board, { repositories: [this.dashboardRepo.split('/')[1]] });
    // A 404 means the branch does not exist yet; any other failure leaves this item failed instead of assuming it is missing.
    const existing = await this.request('GET', `/repos/${this.dashboardRepo}/git/ref/heads/${encode(location.branch)}`, token);
    if (existing) return { status: 'skipped', detail: `看板分支 ${location.branch} 已存在，数据由「Collect board data」定期更新`, url: location.url };
    if (dryRun) {
      const note = source.private ? `；私有仓库首次运行前，${privateTokenNote}` : '';
      return { status: 'skipped', detail: `预演：将在 ${this.dashboardRepo} 触发「Create board」创建分支 ${location.branch}，随后触发「Collect board data」立即采集首份快照${note}` };
    }
    progress('触发「Create board」…');
    const createdAt = Date.now();
    const dispatched = await this.request('POST', `/repos/${this.dashboardRepo}/actions/workflows/board-create.yml/dispatches`, token,
      { ref: 'main', inputs: { source_repository: full } });
    if (dispatched === null) return { status: 'failed', detail: '触发「Create board」失败', code: 'board_dispatch_failed' };
    // A private board can only be created when the dashboard has the shared token; name that failure precisely.
    if (source.private) {
      const created = await this.workflowOutcome('board-create.yml', token, createdAt);
      if (created?.missing) return blocked('dashboard 仓库没有配置 PRIVATE_SOURCE_TOKEN，无法创建私有仓库看板；请 dashboard 维护者添加该只读 secret 后重试', 'dashboard_private_token_missing');
      if (created?.failed) return { status: 'failed', detail: '触发「Create board」失败，请查看 dashboard 仓库的 Actions 日志', code: 'board_create_failed', url: created.url || location.url };
    }
    // Public boards would otherwise wait for the daily schedule; private boards always need this first snapshot.
    progress('触发首轮「Collect board data」…');
    const collectedAt = Date.now();
    const collected = await this.request('POST', `/repos/${this.dashboardRepo}/actions/workflows/board-collect.yml/dispatches`, token,
      { ref: 'main', inputs: { board: location.key } });
    if (collected === null) return { status: 'failed', detail: '看板分支已创建，但触发首轮「Collect board data」失败', code: 'board_collect_dispatch_failed' };
    if (source.private) {
      const first = await this.workflowOutcome('board-collect.yml', token, collectedAt);
      if (first?.missing) {
        return blocked('dashboard 仓库没有配置 PRIVATE_SOURCE_TOKEN，私有仓库看板无法采集；请 dashboard 维护者添加该只读 secret 后重试', 'dashboard_private_token_missing');
      }
      if (first?.failed) return { status: 'failed', detail: '首轮「Collect board data」失败，请查看 dashboard 仓库的 Actions 日志', code: 'board_collect_failed', url: first.url || location.url };
    }
    return { status: 'done', detail: `已触发「Create board」和首轮「Collect board data」，分支 ${location.branch} 建好后由采集与部署发布${source.private ? `；私有源由 dashboard 的 PRIVATE_SOURCE_TOKEN 读取` : ''}`, url: location.url };
  }

  /**
   * Read a dispatched workflow run just far enough to tell whether it stopped on the missing dashboard secret.
   * Both board workflows keep that check in a step named `Check PRIVATE_SOURCE_TOKEN`; a slow run simply stops being watched.
   */
  private async workflowOutcome(workflow: string, token: string, since: number, timeout = 90000): Promise<{ missing: boolean; failed?: boolean; url?: string } | null> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const runs = await this.request('GET', `/repos/${this.dashboardRepo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=20`, token);
      if (runs === null) return null;
      const list = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
      const run = list.find((item: any) => Date.parse(String(item.run_started_at || item.created_at || '')) >= since - 5000);
      if (run) {
        const jobs = await this.request('GET', `/repos/${this.dashboardRepo}/actions/runs/${encodeURIComponent(String(run.id))}/jobs?per_page=100`, token);
        const missing = Array.isArray(jobs?.jobs) && jobs.jobs.some((job: any) =>
          (Array.isArray(job.steps) ? job.steps : []).some((entry: any) => entry.name === 'Check PRIVATE_SOURCE_TOKEN' && entry.conclusion === 'failure'));
        if (missing) return { missing: true, url: run.html_url };
        if (run.status === 'completed') return { missing: false, failed: run.conclusion === 'failure', url: run.html_url };
      }
      await wait(2000);
    }
    return null;
  }

  /** The registration PR on the dashboard. It points at this source's board, so the board branch has to be in place. */
  private async dashboard(source: Source, boardOutcome: Outcome | undefined): Promise<Outcome> {
    const { app, id, full, owner, name, defaultBranch, dryRun } = source;
    const location = boardLocation(this.dashboardRepo, full);
    if (!boardKeyValid(location.key)) return blocked(`仓库名 ${full} 不能用作看板分支，需要人工处理`, 'invalid_repository');
    const installation = await this.installation(app, `/repos/${this.dashboardRepo}/installation`);
    if (!installation) return blocked(`需要把同一个 GitHub App 安装到 ${this.dashboardRepo}，才能提登记 PR`, 'dashboard_app_not_installed');
    const gap = permissionGap(installation, quickstartPermissions.dashboard);
    if (gap) return gap;
    if (!boardOutcome || !['done', 'skipped'].includes(boardOutcome.status)) {
      // Not created this time: the board branch must already exist on the dashboard.
      const boardToken = await this.token(app, installation, quickstartPermissions.board, { repositories: [this.dashboardRepo.split('/')[1]] });
      const branch = await this.request('GET', `/repos/${this.dashboardRepo}/git/ref/heads/${encode(location.branch)}`, boardToken);
      if (!branch) return blocked(`单仓看板 ${location.branch} 还没有就绪，先执行「单仓看板」这一项`, 'board_not_ready');
    }
    const dashboardToken = await this.token(app, installation, quickstartPermissions.dashboard, { repositories: [this.dashboardRepo.split('/')[1]] });
    const entry = { id: full, name, owner, defaultBranch, type: 'status-board-lanes',
      url: `${location.url}data/snapshot.json`, dashboardUrl: location.url, boardUrl: location.url,
      channelMap: [{ channel: 'gate', workflow: ['CI'] }] };
    const rawGate = await this.file(this.dashboardRepo, 'config/gate-sources.json', dashboardToken);
    const rawCommunity = await this.file(this.dashboardRepo, 'config/internal-contributors.json', dashboardToken);
    if (!rawGate || !rawCommunity) return blocked('读不到 dashboard 的来源清单或社区名单', 'dashboard_unreadable');
    if (dryRun) return { status: 'skipped', detail: `预演：将登记到 config/gate-sources.json 和 config/internal-contributors.json${source.private ? `（私有可见性；${privateTokenNote}）` : ''}` };
    const gateConfigFile = JSON.parse(rawGate), sources: any[] = Array.isArray(gateConfigFile.sources) ? gateConfigFile.sources : [];
    const community: Record<string, string[]> = JSON.parse(rawCommunity);
    const needsGate = !sources.some((entry: any) => entry.id === full);
    const needsCommunity = !(full in community);
    if (!needsGate && !needsCommunity) return { status: 'skipped', detail: 'dashboard 的门禁和社区都已登记' };
    if (needsGate) { sources.push(entry); gateConfigFile.sources = sources; }
    if (needsCommunity) community[full] = Array.isArray(community[full]) && community[full].length ? community[full] : [owner];
    const branch = `onboarding/${owner}-${name}`;
    const open = await this.request('GET', `/repos/${this.dashboardRepo}/pulls?state=open&per_page=100`, dashboardToken).catch(() => null);
    const existingPr = Array.isArray(open) ? open.find((pull: any) => pull.head?.ref === branch) : null;
    if (existingPr) {
      // A PR opened before community registration existed only carries the gate entry; add the missing file to it.
      const updated: string[] = [];
      if (needsCommunity) {
        await this.put(this.dashboardRepo, 'config/internal-contributors.json', JSON.stringify(community, null, 2) + '\n', branch, dashboardToken, `chore(community): monitor ${full}`).catch(() => null);
        updated.push('社区监控');
      }
      return { status: 'skipped', detail: `登记 PR 已存在 #${existingPr.number}${updated.length ? '，已补上' + updated.join('、') : ''}，等待合并`, url: String(existingPr.html_url) };
    }
    const base = await this.request('GET', `/repos/${this.dashboardRepo}/git/ref/heads/main`, dashboardToken);
    if (!base?.object?.sha) return { status: 'failed', detail: '读不到 dashboard 默认分支', code: 'dashboard_base_unavailable' };
    await this.request('POST', `/repos/${this.dashboardRepo}/git/refs`, dashboardToken, { ref: `refs/heads/${branch}`, sha: base.object.sha });
    if (needsGate) await this.put(this.dashboardRepo, 'config/gate-sources.json', JSON.stringify(gateConfigFile, null, 2) + '\n', branch, dashboardToken, `chore(gate): register ${full}`);
    if (needsCommunity) await this.put(this.dashboardRepo, 'config/internal-contributors.json', JSON.stringify(community, null, 2) + '\n', branch, dashboardToken, `chore(community): monitor ${full}`);
    const changes = [needsGate ? '门禁来源' : null, needsCommunity ? '社区监控' : null].filter(Boolean).join(' + ');
    const visibility = source.private ? 'private（私有；看板只发布 site/data 数据，dashboard 仓库需配置 PRIVATE_SOURCE_TOKEN）' : 'public（公开）';
    const pr = await this.request('POST', `/repos/${this.dashboardRepo}/pulls`, dashboardToken, {
      title: `chore(dashboard): register ${full}`, head: branch, base: 'main',
      body: `登记 ${full} 的${changes}。\n\n- 可见性：${visibility}\n- 门禁：\`config/gate-sources.json\`（单仓看板快照）\n- 社区：\`config/internal-contributors.json\`（采集时按它读取仓库）\n\n<!-- dept-bot:quickstart:${id} -->` });
    if (!pr?.html_url) return { status: 'failed', detail: '登记 PR 创建失败', code: 'dashboard_pr_failed' };
    return { status: 'done', detail: `已创建登记 PR #${pr.number}（${changes}），合并后下一次采集即出现`, url: String(pr.html_url) };
  }

  /** Workflow files come from CI-workflow; the bundled copies only cover a missing template. */
  private async workflowTemplates(scripts: Record<string, unknown>, token: string): Promise<Record<string, string>> {
    const bundled = workflowSet(scripts), result: Record<string, string> = {};
    for (const [workflowPath, fallback] of Object.entries(bundled)) {
      const remote = await this.file(this.templateRepo, `template/${workflowPath}`, token).catch(() => null);
      result[workflowPath] = remote ?? fallback;
    }
    return result;
  }
}
