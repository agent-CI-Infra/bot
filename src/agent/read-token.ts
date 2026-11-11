import { type Store, type Row } from '../storage/database.js';
import { GitHub, agentReadPermissions, revokeInstallationToken } from '../github/client.js';
import { type Redactor, stop } from './common.js';

// Read-only GitHub tokens a task agent exchanges for itself, so it can read what it needs instead of what was prepared.
// Each token covers this repository only, joins the task's redactor so it never reaches logs or the model provider,
// and is revoked when the agent finishes. Comments, labels, reviews, branches and PRs keep using the control plane's token.
export class ReadTokens {
  private readonly issued: string[] = [];
  // scopes: the workflow's saved GitHub read scopes; a token never carries a scope the workflow does not have.
  constructor(readonly store: Store, readonly repository: Row, readonly redactor: Redactor, readonly guard: () => Promise<void>, readonly apiUrl?: string, readonly scopes?: string[], readonly liveScopes?:()=>string[]) {}
  allowedScopes():string[] { return (this.scopes??Object.keys(agentReadPermissions)).filter(scope=>!this.liveScopes||this.liveScopes().includes(scope)); }
  async issue() {
    const github = await this.connect();
    return { token: github.token, expires_at: github.expiresAt, permissions: github.permissions, repository: github.fullName };
  }
  // Common repository exploration keeps credentials in the control plane, including for Pi tools.
  async issueRepository() { return this.connect(undefined, false); }
  // Release observation uses the same issuer/lifecycle as review, with only Actions and metadata reads.
  // Its tool executor keeps this client; neither token values nor arbitrary request paths reach the model.
  async issueActions() {
    const permissions = { actions: 'read', metadata: 'read' };
    const github = await this.connect(permissions, false);
    if (Object.keys(github.permissions).some(key => !(key in permissions))) return stop('github_read_token_not_read_only', undefined, 'GitHub 返回了超出运行观察范围的令牌权限，已拒绝交付。');
    return github;
  }
  private async connect(required?: Record<string, string>, identifyActor = true) {
    if (this.issued.length >= 10) stop('github_read_token_limit', undefined, '当前任务已达到 GitHub 只读令牌的 10 次签发上限。');
    // A bot account has one long-lived token that can write; only a GitHub App can mint a narrower one.
    if (this.store.get('SELECT type FROM accounts WHERE id=?', this.repository.account_id)?.type !== 'github_app') stop('github_app_required', undefined, '签发仓库只读令牌需要 GitHub App 账号，当前账号类型不支持。');
    const github = new GitHub(this.store, this.repository, this.redactor, this.guard, this.apiUrl);
    const scopes=this.allowedScopes();
    if (!scopes.some(scope=>scope!=='metadata')) stop('github_read_token_not_allowed', undefined, '这条任务没有所需的 GitHub 资源读取权限。');
    if(required&&Object.keys(required).some(scope=>scope!=='metadata'&&!scopes.includes(scope)))stop('github_read_token_not_allowed');
    const requested = Object.fromEntries(Object.entries(agentReadPermissions).filter(([scope]) => scope === 'metadata' || scopes.includes(scope)));
    try { await github.connect(false, required, required ? undefined : requested, identifyActor); }
    finally { if (github.token) this.issued.push(github.token); }
    if (!Object.keys(github.permissions).length || Object.values(github.permissions).some(value => value !== 'read')) stop('github_read_token_not_read_only', undefined, 'GitHub 返回的令牌权限为空或包含非只读权限，已拒绝交付。');
    if (Object.keys(github.permissions).some(scope => scope !== 'metadata' && !scopes.includes(scope))) stop('github_read_token_not_read_only', undefined, 'GitHub 返回了超出资源读取范围的令牌权限，已拒绝交付。');
    return github;
  }
  async revoke() { for (const token of this.issued.splice(0)) await revokeInstallationToken(this.apiUrl || 'https://api.github.com', token).catch(() => false); }
}
