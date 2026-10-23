import type { Json } from '../core/security.js';
import type { Store, Row } from '../storage/database.js';

/** How long a status stays fresh before the console re-checks it. */
const CACHE_MS = 10 * 60_000;

export type GateState = 'none' | 'configured' | 'live' | 'unknown';
export type DashboardState = 'none' | 'registered' | 'published' | 'unknown';

interface GitHubFile { text: string; sha: string }

/** The account's GitHub token; GitHub App accounts are not supported by the checker yet. */
export function accountToken(store: Store, accountId: string): string | null {
  const account = store.get('SELECT * FROM accounts WHERE id=?', accountId);
  if (!account || account.type !== 'bot_account') return null;
  const secrets = store.secrets.open(account.credentials, `account:${account.id}`);
  return typeof secrets.token === 'string' && secrets.token ? secrets.token : null;
}

const INSTALLED = 'SELECT repository_id FROM installed_repositories WHERE installed=1';
/**
 * Drops the cached status of repositories no installation lists any more. Callers run it in the same write that marks
 * repositories as uninstalled; the check also runs it to clear rows an older version left behind.
 */
export function dropUninstalledIntegrations(store: Store): void {
  store.run(`DELETE FROM repo_integrations WHERE repository_id NOT IN (${INSTALLED})`);
}

/**
 * Whether a repository is connected to the CI gates (CI-workflow) and to the public
 * dashboard. Read-only: it inspects files on the default branch, the latest CI run and
 * the dashboard's source list, then caches the answer.
 */
export class IntegrationChecker {
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com',
    readonly dashboardRepo = process.env.BOT_DASHBOARD_REPO || 'agent-CI-Infra/dashboard') {}

  private async get(path: string, token: string): Promise<any | null> {
    let response: Response;
    try {
      response = await fetch(this.apiUrl.replace(/\/$/, '') + path, { redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch { throw new Error('github_unavailable'); }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('github_http_' + response.status);
    return response.json();
  }
  private async file(repo: string, path: string, token: string): Promise<GitHubFile | null> {
    const value = await this.get(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, token);
    if (!value || Array.isArray(value) || value.type !== 'file' || typeof value.content !== 'string') return null;
    return { text: Buffer.from(value.content, 'base64').toString('utf8'), sha: String(value.sha) };
  }

  private async gate(full: string, token: string): Promise<{ state: GateState; detail: string }> {
    try {
      const config = await this.file(full, '.github/ci-gates.json', token);
      const workflow = await this.file(full, '.github/workflows/ci.yml', token) ?? await this.file(full, '.github/workflows/ci-gates.yml', token);
      if (!config && !workflow) return { state: 'none', detail: '未见 ci-gates 配置和 CI workflow' };
      if (!config) return { state: 'none', detail: '有 CI workflow，但未接入门禁' };
      if (!workflow) return { state: 'configured', detail: '有门禁配置，但没有 CI workflow 运行它' };
      const flows: any = await this.get(`/repos/${full}/actions/workflows`, token).catch(() => null);
      const flow = flows?.workflows?.find((w: any) => w.name === 'CI' || /ci\.ya?ml$/.test(String(w.path)));
      if (!flow) return { state: 'configured', detail: '已配置，尚未看到 CI workflow' };
      const runs: any = await this.get(`/repos/${full}/actions/workflows/${flow.id}/runs?per_page=1`, token).catch(() => null);
      const run = runs?.workflow_runs?.[0];
      if (!run) return { state: 'configured', detail: '已配置，还没有运行记录' };
      const recent = Date.now() - Date.parse(String(run.created_at)) < 30 * 86400_000;
      if (run.conclusion === 'success' && recent) return { state: 'live', detail: `最近一次 CI 通过（${String(run.created_at).slice(0, 10)}）` };
      return { state: 'configured', detail: `已配置，最近一次 CI ${run.conclusion || run.status}` };
    } catch (error) { return { state: 'unknown', detail: (error as Error).message }; }
  }

  private async dashboard(full: string, token: string): Promise<{ state: DashboardState; detail: string }> {
    try {
      const [owner = '', name = ''] = full.split('/');
      const config = await this.file(this.dashboardRepo, 'config/gate-sources.json', token);
      if (!config) return { state: 'unknown', detail: '读不到 dashboard 来源清单' };
      const sources = JSON.parse(config.text).sources;
      const source = (Array.isArray(sources) ? sources : []).find((s: any) => s.id === full
        || (String(s.owner || '').toLowerCase() === owner.toLowerCase() && String(s.name || '').toLowerCase() === name.toLowerCase()));
      if (!source) return { state: 'none', detail: '未登记到公共 dashboard' };
      const indexFile = await this.file(this.dashboardRepo, 'public/data/gate/index.json', token);
      const published = indexFile ? (JSON.parse(indexFile.text).sources || []).some((s: any) => s.id === source.id) : false;
      return published ? { state: 'published', detail: '已发布到公共 dashboard' } : { state: 'registered', detail: '已登记，等待采集发布' };
    } catch (error) { return { state: 'unknown', detail: (error as Error).message }; }
  }

  /** Checks one installed repository; a repository no installation lists is not checked and loses its cached row. */
  async check(repositoryId: string): Promise<Json | null> {
    const installed = this.store.get('SELECT * FROM installed_repositories WHERE repository_id=? AND installed=1', repositoryId);
    if (!installed) { this.store.run('DELETE FROM repo_integrations WHERE repository_id=?', repositoryId); return null; }
    const source = this.store.get('SELECT * FROM repositories WHERE id=?', repositoryId) || installed;
    const full = String(source.full_name), token = accountToken(this.store, String(source.account_id)), now = new Date().toISOString();
    let gate: { state: GateState; detail: string }, dashboard: { state: DashboardState; detail: string };
    if (!token) {
      gate = { state: 'unknown', detail: 'GitHub App 账号暂不支持自动检查' };
      dashboard = { state: 'unknown', detail: 'GitHub App 账号暂不支持自动检查' };
    } else {
      [gate, dashboard] = await Promise.all([this.gate(full, token), this.dashboard(full, token)]);
    }
    this.store.run(`INSERT INTO repo_integrations(repository_id,gate_state,gate_detail,dashboard_state,dashboard_detail,checked_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET gate_state=excluded.gate_state,gate_detail=excluded.gate_detail,
      dashboard_state=excluded.dashboard_state,dashboard_detail=excluded.dashboard_detail,checked_at=excluded.checked_at`,
    repositoryId, gate.state, gate.detail, dashboard.state, dashboard.detail, now);
    return this.view(repositoryId)!;
  }

  private view(repositoryId: string): Json | null {
    const row: Row | undefined = this.store.get('SELECT * FROM repo_integrations WHERE repository_id=?', repositoryId);
    if (!row) return null;
    return { repository_id: row.repository_id, gate_state: row.gate_state, gate_detail: row.gate_detail,
      dashboard_state: row.dashboard_state, dashboard_detail: row.dashboard_detail, checked_at: row.checked_at,
      stale: Date.now() - Date.parse(String(row.checked_at)) > CACHE_MS };
  }

  /** Cached status of installed repositories only; a repository without a row shows as not checked yet. */
  cached(): Json[] {
    return this.store.all(`SELECT repository_id FROM repo_integrations WHERE repository_id IN (${INSTALLED}) ORDER BY repository_id`)
      .map(row => this.view(String(row.repository_id))).filter((row): row is Json => !!row);
  }
}
