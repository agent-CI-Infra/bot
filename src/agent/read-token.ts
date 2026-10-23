import { type Store, type Row } from '../storage/database.js';
import { GitHub, agentReadPermissions, revokeInstallationToken } from '../github/client.js';
import { type Redactor, stop } from './common.js';

// Read-only GitHub tokens a task agent exchanges for itself, so it can read what it needs instead of what was prepared.
// Each token covers this repository only, joins the task's redactor so it never reaches logs or the model provider,
// and is revoked when the agent finishes. Comments, labels, reviews, branches and PRs keep using the control plane's token.
export class ReadTokens {
  private readonly issued: string[] = [];
  constructor(readonly store: Store, readonly repository: Row, readonly redactor: Redactor, readonly guard: () => Promise<void>, readonly apiUrl?: string) {}
  async issue() {
    if (this.issued.length >= 10) stop('github_read_token_limit');
    // A bot account has one long-lived token that can write; only a GitHub App can mint a narrower one.
    if (this.store.get('SELECT type FROM accounts WHERE id=?', this.repository.account_id)?.type !== 'github_app') stop('github_app_required');
    const github = new GitHub(this.store, this.repository, this.redactor, this.guard, this.apiUrl);
    try { await github.connect(false, undefined, agentReadPermissions); }
    finally { if (github.token) this.issued.push(github.token); }
    if (!Object.keys(github.permissions).length || Object.values(github.permissions).some(value => value !== 'read')) stop('github_read_token_not_read_only');
    return { token: github.token, expires_at: github.expiresAt, permissions: github.permissions, repository: github.fullName };
  }
  async revoke() { for (const token of this.issued.splice(0)) await revokeInstallationToken(this.apiUrl || 'https://api.github.com', token).catch(() => false); }
}
