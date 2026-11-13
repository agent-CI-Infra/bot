import type { Store } from '../storage/database.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { appJwt, revokeInstallationToken } from '../github/client.js';
import { installationRef, numericId, type InstallationRef } from '../installations/archive.js';

interface Access {
  target_id: string; owner: boolean; repository_ids: string[]; admin_ids: string[];
  repository_selection: string;
  /** Why some of this evidence could not be settled, or null when all of it was. */
  uncertain: string | null;
}

/** A failure's error code, safe to record: never a message, URL or credential. */
export const failureCode = (error: unknown): string => error instanceof HttpError ? error.code : 'unexpected_error';

/** Identity comes from OAuth; repository authority is checked with a separate, read-only installation token. */
export class GitHubPermissions {
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com') {}
  private async request(token: string, path: string, body?: Json, missing = false): Promise<Json | null> {
    let response: Response;
    try { response = await fetch(new URL(path, this.apiUrl), {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }); } catch { return fail(502, 'github_verification_unavailable'); }
    if (missing && response.status === 404) return null;
    if (!response.ok) return fail(403, 'github_permission_pending');
    try { return await response.json() as Json; } catch { return fail(502, 'github_incomplete_evidence'); }
  }
  async read(ref: InstallationRef, user: { id: string; login: string }): Promise<Access> {
    installationRef(ref);
    const account = this.store.get("SELECT * FROM accounts WHERE type='github_app' AND app_id=? ORDER BY created_at LIMIT 1", ref.app_id);
    if (!account) return fail(403, 'github_permission_pending');
    const credentials = this.store.secrets.open(account.credentials, `account:${account.id}`);
    const installation = await this.request(appJwt(ref.app_id, String(credentials.private_key || '')), `/app/installations/${ref.installation_id}`);
    const target = installation?.account as Json | undefined, targetId = numericId(target?.id);
    if (!installation || numericId(installation.id) !== ref.installation_id || numericId(installation.app_id) !== ref.app_id || !targetId ||
      !['User', 'Organization'].includes(String(target?.type)) || typeof target?.login !== 'string' || !target.login || installation.suspended_at ||
      !['all', 'selected'].includes(String(installation.repository_selection))) return fail(403, 'github_permission_pending');
    const membershipReadable = target.type === 'Organization' && ['read', 'write'].includes(String((installation.permissions as Json | undefined)?.members));
    const permissions = { metadata: 'read', ...(membershipReadable ? { members: 'read' } : {}) };
    const access = await this.request(appJwt(ref.app_id, String(credentials.private_key || '')),
      `/app/installations/${ref.installation_id}/access_tokens`, { permissions });
    if (typeof access?.token !== 'string' || !access.token) return fail(502, 'github_incomplete_evidence');
    const token = access.token;
    try {
      const repos: Json[] = [], ids = new Set<string>(); let count: number | null = null;
      for (let page = 1; page <= 1000; page++) {
        const data = await this.request(token, `/installation/repositories?per_page=100&page=${page}`);
        if (!Array.isArray(data?.repositories) || !Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0 ||
          count !== null && data.total_count !== count) return fail(502, 'github_incomplete_evidence');
        count = Number(data.total_count);
        for (const repo of data.repositories as Json[]) {
          const id = numericId(repo.id);
          if (!id || ids.has(id) || numericId((repo.owner as Json | undefined)?.id) !== targetId ||
            typeof repo.full_name !== 'string' || !/^[^/]+\/[^/]+$/.test(repo.full_name)) return fail(502, 'github_incomplete_evidence');
          ids.add(id); repos.push(repo);
        }
        if (repos.length === count) break;
        if (repos.length > count || !data.repositories.length || page === 1000) return fail(502, 'github_incomplete_evidence');
      }
      let owner = target.type === 'User' && targetId === user.id;
      // The first reason wins; each names which evidence was missing, for diagnosis (#521).
      let uncertain: string | null = target.type === 'Organization' && !membershipReadable ? 'membership_unreadable' : null;
      if (membershipReadable) {
        try {
          const member = await this.request(token, `/orgs/${encodeURIComponent(target.login)}/memberships/${encodeURIComponent(user.login)}`, undefined, true);
          if (member) {
            if (numericId((member.user as Json | undefined)?.id) !== user.id || numericId((member.organization as Json | undefined)?.id) !== targetId ||
              !['active', 'pending'].includes(String(member.state)) || !['admin', 'member'].includes(String(member.role))) return fail(502, 'github_incomplete_evidence');
            owner = member.state === 'active' && member.role === 'admin'; if (member.state !== 'active') uncertain ??= 'membership_pending';
          }
        } catch (error) { uncertain ??= 'membership:' + failureCode(error); }
      }
      const repositoryIds: string[] = [], adminIds: string[] = [];
      for (const repo of repos) {
        const id = numericId(repo.id)!;
        if (owner) { repositoryIds.push(id); adminIds.push(id); continue; }
        try {
          const permission = await this.request(token, `/repos/${String(repo.full_name).split('/').map(encodeURIComponent).join('/')}/collaborators/${encodeURIComponent(user.login)}/permission`, undefined, true);
          if (!permission) continue;
          if (numericId((permission.user as Json | undefined)?.id) !== user.id || !['none', 'read', 'write', 'admin', 'maintain', 'triage'].includes(String(permission.permission))) return fail(502, 'github_incomplete_evidence');
          // The name may have been transferred/reused after the installation listing. Bind the proof back to its numeric repository ID.
          const current = await this.request(token, `/repos/${String(repo.full_name).split('/').map(encodeURIComponent).join('/')}`);
          if (numericId(current?.id) !== id || numericId((current?.owner as Json | undefined)?.id) !== targetId) return fail(502, 'github_incomplete_evidence');
          if (permission.permission !== 'none') repositoryIds.push(id);
          if (permission.permission === 'admin' || ((permission.user as Json)?.permissions as Json | undefined)?.admin === true) adminIds.push(id);
        } catch (error) { uncertain ??= 'repository_permission:' + failureCode(error); }
      }
      return { target_id: targetId, owner, repository_ids: repositoryIds, admin_ids: adminIds,
        repository_selection: String(installation.repository_selection), uncertain };
    } finally {
      await revokeInstallationToken(this.apiUrl, token).catch(() => false);
      // Include the asynchronous token cleanup in the credential fence.
      if (this.store.get('SELECT credentials FROM accounts WHERE id=?', account.id)?.credentials !== account.credentials) fail(409, 'authorization_changed');
    }
  }
}
