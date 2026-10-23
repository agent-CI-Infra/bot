import { randomId, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import { appJwt, missingPermissions, revokeInstallationToken } from '../github/client.js';
import { boardReadme, workflowSet } from './gate-templates.js';

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
const itemTitles: Record<Item, string> = { gate_pr: '门禁 PR', board: '看板仓库', dashboard: 'Dashboard 登记' };
/** How one item ended. */
interface Outcome { status: StepStatus; detail: string; code?: string; url?: string }
const blocked = (detail: string, code: string): Outcome => ({ status: 'blocked', detail, code });
/** What the items of one run share: the source repository read with its own installation token. */
interface Source { app: AppSession; id: string; dryRun: boolean; full: string; owner: string; name: string; repositoryId: string;
  installation: any; token: string; defaultBranch: string; private: boolean; target?: BoardTarget | Outcome }
interface BoardTarget { organization: string; board: ReturnType<typeof boardRepository> }

const step = (id: string, title: string): Step => ({ id, title, status: 'pending', detail: '等待执行', at: null });
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// Onboarding mints one installation token per purpose, each limited to what that step writes and to what the
// installation has granted. Review and development tokens (GitHub.connect) never ask for workflows, pages or
// repository_creation, so a development task still cannot change `.github/workflows/`.
export const quickstartPermissions = {
  // The gate PR commits `.github/workflows/` to the source repository.
  source: { contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read' },
  // Creates the board repository in the App's organization; not pinned to a repository that does not exist yet.
  creation: { repository_creation: 'write' },
  // The new board repository: template files (workflows included), Pages and the first collection run.
  board: { contents: 'write', workflows: 'write', pages: 'write', actions: 'write', metadata: 'read' },
  // The registration PR only changes JSON files.
  dashboard: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  // Reads a template repository (CI-workflow, or the dashboard's single-repo/) through the App installed on it.
  template: { contents: 'read', metadata: 'read' },
} satisfies Record<string, Permissions>;
const permissionNames: Record<string, string> = { contents: 'Contents', pull_requests: 'Pull requests', workflows: 'Workflows', pages: 'Pages',
  actions: 'Actions', metadata: 'Metadata', repository_creation: 'Repository creation' };
const levelNames: Record<string, string> = { read: 'Read-only', write: 'Read and write' };

/** A source's board repository lives in the App's organization and carries the source owner, so `a/x` and `b/x` never collide. */
export function boardRepository(organization: string, full: string) {
  const [owner = '', name = ''] = full.split('/'), boardName = `${owner}-${name}-board`;
  return { name: boardName, full: `${organization}/${boardName}`, siteUrl: `https://${organization.toLowerCase()}.github.io/${boardName}/`,
    valid: /^[A-Za-z0-9._-]{1,100}$/.test(boardName) };
}
const boardDescription = (full: string) => `${full} 的单仓看板（由控制面创建）`;

/**
 * An existing repository is this source's board when its config sends this board's data to this source, or, before it
 * has any such entry, when the control plane created it for this source (a run that stopped before configuring it).
 */
function ownsBoard(rawConfig: string | null, meta: any, full: string, board: string): boolean {
  let deployments: Record<string, any> = {};
  try { const value = rawConfig ? JSON.parse(rawConfig).deployments : null; if (value && typeof value === 'object' && !Array.isArray(value)) deployments = value; } catch { /* Not our config. */ }
  const sources = Object.entries(deployments).filter(([, value]) => String(value?.repository || '').toLowerCase() === board.toLowerCase()).map(([source]) => source.toLowerCase());
  if (sources.length) return sources.length === 1 && sources[0] === full.toLowerCase();
  return meta?.description === boardDescription(full);
}

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
 *  - board     — create the source's board repository in the App's organization from the single-repo template,
 *                point it at the source repository, enable Pages and start the first collection;
 *  - dashboard — open the registration PR on the public dashboard for the board.
 * A shared preflight reads the source repository; after that each item checks only what it needs, so an item that cannot
 * run is reported and the others still go ahead. Every write lands on a bot branch / a new repository; nothing is pushed to
 * a default branch, and only GitHub App installation tokens are used.
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
  /** Where this source's board lives: the App's organization from `GET /app`, resolved once per run. */
  private async boardTarget(source: Source): Promise<BoardTarget | Outcome> {
    if (!source.target) {
      const appInfo = await this.request('GET', '/app', this.jwt(source.app));
      const organization = appInfo?.owner?.type === 'Organization' ? String(appInfo.owner.login || '') : '';
      const board = organization ? boardRepository(organization, source.full) : null;
      source.target = !board ? blocked(`看板仓库建在 GitHub App 所属的组织下；这个 App 属于个人账号 ${String(appInfo?.owner?.login || '')}，需要改用组织拥有的 App`, 'app_owner_not_organization')
        : !board.valid ? blocked(`看板仓库名 ${board.name} 超过 GitHub 的 100 个字符上限，需要人工处理`, 'board_name_invalid')
        : { organization, board };
    }
    return source.target;
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
        if (/-board$/.test(name) || await this.file(full, 'board-config.json', token).catch(() => null) !== null) {
          return stop(blocked('这是看板仓库，不需要接入；请对源码仓接入', 'board_repository'));
        }
        source = { app, id, dryRun, full, owner, name, repositoryId, installation, token, defaultBranch: String(meta.default_branch || 'main'), private: !!meta.private };
        mark('preflight', { status: 'done', detail: `默认分支 ${source.defaultBranch} · ${source.private ? '私有仓库，只能接门禁' : '公开仓库'}` });
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

  /** The board repository in the App's organization, configured for this source, with Pages and a first collection. */
  private async board(source: Source, progress: (detail: string) => void): Promise<Outcome> {
    const { app, full, owner, name, token, defaultBranch, dryRun } = source;
    if (source.private) return blocked('公共看板只接受公开仓库，私有仓库不创建看板', 'private_repository');
    const target = await this.boardTarget(source);
    if ('status' in target) return target;
    const { organization, board } = target, boardRepo = board.full;
    const orgInstallation = await this.installation(app, `/orgs/${organization}/installation`);
    if (!orgInstallation) return blocked(`GitHub App 没有安装到所属组织 ${organization}，无法在那里创建看板仓库`, 'app_org_not_installed');
    // An existing board repository needs no creation permission; one the App cannot see is handled when creating.
    const exists = !!await this.installation(app, `/repos/${boardRepo}/installation`);
    const gap = permissionGap(orgInstallation, exists ? quickstartPermissions.board : { ...quickstartPermissions.creation, ...quickstartPermissions.board });
    if (gap) return gap;
    // The board template is `single-repo/` in the dashboard repository; reading it does not need the App installed there when it is public.
    const templateToken = await this.readToken(app, this.dashboardRepo, token);
    if (templateToken === null) return blocked(`读取看板模板 ${this.dashboardRepo} 被拒绝，需要把同一个 GitHub App 安装到该仓库`, 'board_template_unavailable');
    let boardToken: string;
    if (!exists) {
      if (dryRun) return { status: 'skipped', detail: `预演：将在 ${organization} 下创建 ${boardRepo} 并复制 single-repo 模板` };
      const creationToken = await this.token(app, orgInstallation, quickstartPermissions.creation);
      const created = await this.request('POST', `/orgs/${organization}/repos`, creationToken,
        { name: board.name, private: false, auto_init: true, description: boardDescription(full) })
        .catch((error: Error) => { if (error.message === 'github_http_422') return 'rejected'; throw error; });
      // Usually a repository with this name that the App cannot see; it is left alone.
      if (created === 'rejected') return blocked(`GitHub 拒绝创建 ${boardRepo}（通常是同名仓库已存在但 App 无权访问），没有覆盖，需要人工确认`, 'board_repository_conflict');
      if (!created?.full_name) return { status: 'failed', detail: '创建看板仓库失败', code: 'board_create_failed' };
      boardToken = await this.token(app, orgInstallation, quickstartPermissions.board, { repositories: [board.name] });
      progress('复制 single-repo 模板…');
      await this.copyTemplate(boardRepo, boardToken, templateToken);
    } else {
      boardToken = await this.token(app, orgInstallation, quickstartPermissions.board, { repositories: [board.name] });
      const boardMeta = await this.request('GET', `/repos/${boardRepo}`, boardToken);
      if (!ownsBoard(await this.file(boardRepo, 'board-config.json', boardToken), boardMeta, full, boardRepo)) {
        return blocked(`${boardRepo} 已存在，但看不出是 ${full} 的看板，没有覆盖也没有删除，需要人工处理`, 'board_repository_conflict');
      }
      if (dryRun) return { status: 'skipped', detail: `预演：将更新 ${boardRepo} 的配置` };
      if (await this.file(boardRepo, '.github/workflows/pages.yml', boardToken) === null) {
        progress('看板仓库存在但模板不完整，补全模板…');
        await this.copyTemplate(boardRepo, boardToken, templateToken);
      } else progress('看板仓库已存在，更新配置…');
    }
    // Keep the template keys (deployments is what the collect workflow reads) and point them at this source.
    const currentRaw = await this.file(boardRepo, 'board-config.json', boardToken);
    const boardConfig: Json = currentRaw ? JSON.parse(currentRaw) : {};
    boardConfig.label = name;
    boardConfig.review_sla_days = boardConfig.review_sla_days ?? 3;
    boardConfig.stale_days = boardConfig.stale_days ?? 30;
    boardConfig.workflows = { ...(boardConfig.workflows as Json || {}), gate: ['^CI$', 'CI Gates', 'gate', '门禁'] };
    boardConfig.branch_lines = [{ key: defaultBranch, ref: defaultBranch }];
    boardConfig.deployments = { ...(boardConfig.deployments as Json || {}), [full]: { environment: 'production', label: name, repository: boardRepo } };
    await this.put(boardRepo, 'board-config.json', JSON.stringify(boardConfig, null, 2) + '\n', 'main', boardToken, 'chore: configure board');
    const siteUrl = board.siteUrl;
    await this.put(boardRepo, 'README.md', boardReadme({ full, board: boardRepo, owner, branch: defaultBranch, siteUrl }), 'main', boardToken, 'docs: describe this board');
    let pages = await this.request('POST', `/repos/${boardRepo}/pages`, boardToken, { build_type: 'workflow' }).catch(() => null);
    if (pages === null) pages = await this.request('GET', `/repos/${boardRepo}/pages`, boardToken).catch(() => null);
    const workflows = await this.request('GET', `/repos/${boardRepo}/actions/workflows`, boardToken).catch(() => null);
    const collect = (workflows?.workflows || []).find((flow: any) => String(flow.path).includes('collect'));
    const dispatched = collect ? await this.request('POST', `/repos/${boardRepo}/actions/workflows/${collect.id}/dispatches`, boardToken, { ref: 'main' }).catch(() => null) : null;
    const gated = await this.file(full, '.github/ci-gates.json', token) !== null;
    return { status: 'done', url: siteUrl, detail: `看板仓库 ${boardRepo} 已就绪${pages ? ' · Pages 已开启' : ' · Pages 未能自动开启，可在仓库 Settings → Pages 选择 GitHub Actions'}`
      + ` · 站点 ${siteUrl}${dispatched !== null ? ' · 已触发首次采集' : ''}${gated ? '' : ' · 门禁还没接入，门禁数据要等门禁 PR 合入后才有'}` };
  }

  /** The registration PR on the public dashboard. It points at this source's board, so the board has to be in place. */
  private async dashboard(source: Source, boardOutcome: Outcome | undefined): Promise<Outcome> {
    const { app, id, full, owner, name, token, defaultBranch, dryRun } = source;
    if (source.private) return blocked('公共 dashboard 只接受公开仓库', 'private_repository');
    const target = await this.boardTarget(source);
    if ('status' in target) return target;
    const installation = await this.installation(app, `/repos/${this.dashboardRepo}/installation`);
    if (!installation) return blocked(`需要把同一个 GitHub App 安装到 ${this.dashboardRepo}，才能提登记 PR`, 'dashboard_app_not_installed');
    const gap = permissionGap(installation, quickstartPermissions.dashboard);
    if (gap) return gap;
    const boardRepo = target.board.full, boardUrl = target.board.siteUrl;
    if (boardOutcome ? !['done', 'skipped'].includes(boardOutcome.status)
      // Not run this time: the public board must already be configured for this source.
      : !ownsBoard(await this.file(boardRepo, 'board-config.json', token).catch(() => null) ?? await this.file(boardRepo, 'board-config.json', '').catch(() => null), null, full, boardRepo)) {
      return blocked(`看板仓库 ${boardRepo} 还没有就绪，先执行「看板仓库」这一项`, 'board_not_ready');
    }
    const dashboardToken = await this.token(app, installation, quickstartPermissions.dashboard, { repositories: [this.dashboardRepo.split('/')[1]] });
    const entry = { id: full, name, owner, defaultBranch, type: 'status-board-lanes',
      url: `${boardUrl}data/snapshot.json`, dashboardUrl: boardUrl, boardUrl, channelMap: [{ channel: 'gate', workflow: ['CI'] }] };
    const rawGate = await this.file(this.dashboardRepo, 'config/gate-sources.json', dashboardToken);
    const rawCommunity = await this.file(this.dashboardRepo, 'config/internal-contributors.json', dashboardToken);
    if (!rawGate || !rawCommunity) return blocked('读不到 dashboard 的来源清单或社区名单', 'dashboard_unreadable');
    if (dryRun) return { status: 'skipped', detail: '预演：将登记到 config/gate-sources.json 和 config/internal-contributors.json' };
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
    const pr = await this.request('POST', `/repos/${this.dashboardRepo}/pulls`, dashboardToken, {
      title: `chore(dashboard): register ${full}`, head: branch, base: 'main',
      body: `登记 ${full} 的${changes}。\n\n- 门禁：\`config/gate-sources.json\`（单仓看板快照）\n- 社区：\`config/internal-contributors.json\`（采集时按它读取仓库）\n\n<!-- dept-bot:quickstart:${id} -->` });
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

  /** Copy `single-repo/` from the dashboard repository (read with its token) into a new board repository (one commit). */
  private async copyTemplate(target: string, token: string, templateToken: string): Promise<void> {
    // A brand-new repository has no refs and rejects Git Data writes until it has one commit.
    const head = async () => this.request('GET', `/repos/${target}/git/ref/heads/main`, token).catch(() => null);
    let base = await head();
    if (!base) {
      await this.request('PUT', `/repos/${target}/contents/README.md`, token, { message: 'chore: initialize repository', content: Buffer.from('# board\n').toString('base64') });
      base = await head();
    }
    const baseSha = base?.object?.sha ? String(base.object.sha) : null;
    const parent = baseSha ? await this.request('GET', `/repos/${target}/git/commits/${baseSha}`, token) : null;
    const tree = await this.request('GET', `/repos/${this.dashboardRepo}/git/trees/main?recursive=1`, templateToken);
    const entries = (tree?.tree || []).filter((item: any) => item.type === 'blob' && String(item.path).startsWith('single-repo/')
      && !/(^|\/)\.git(\/|$)/.test(String(item.path)));
    if (!entries.length) throw new Error('template_unavailable');
    const blobs: any[] = [];
    for (let index = 0; index < entries.length; index += 8) {
      const batch = entries.slice(index, index + 8);
      const created = await Promise.all(batch.map(async (item: any) => {
        const blob = await this.request('GET', `/repos/${this.dashboardRepo}/git/blobs/${item.sha}`, templateToken);
        if (typeof blob?.content !== 'string') throw new Error('template_blob_unavailable');
        return this.request('POST', `/repos/${target}/git/blobs`, token, { content: blob.content, encoding: blob.encoding || 'base64' });
      }));
      created.forEach((blob, position) => blobs.push({ path: String(batch[position]!.path).slice('single-repo/'.length),
        mode: batch[position]!.mode === '100755' ? '100755' : '100644', type: 'blob', sha: blob?.sha }));
    }
    const next = await this.request('POST', `/repos/${target}/git/trees`, token, { tree: blobs, ...(parent?.tree?.sha ? { base_tree: String(parent.tree.sha) } : {}) });
    const commit = await this.request('POST', `/repos/${target}/git/commits`, token, { message: 'chore: initialize board from single-repo template', tree: next?.sha, parents: baseSha ? [baseSha] : [] });
    if (baseSha) await this.request('PATCH', `/repos/${target}/git/refs/heads/main`, token, { sha: commit?.sha, force: true });
    else await this.request('POST', `/repos/${target}/git/refs`, token, { ref: 'refs/heads/main', sha: commit?.sha });
  }
}
