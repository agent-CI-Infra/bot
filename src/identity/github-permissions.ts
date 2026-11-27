import type { Store, Row } from '../storage/database.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { appJwt, revokeInstallationToken } from '../github/client.js';
import { acquireReadToken, refuseReadToken, type ReadTokenLease } from './read-tokens.js';
import { appBucket, installationBucket, observe, refused, type Bucket } from '../github/rate-limits.js';
import { installationRef, numericId, type InstallationRef } from '../installations/archive.js';

export type CollaboratorRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read';
export type StoredCollaboratorRole = CollaboratorRole | 'none' | 'ambiguous_public_read';
export type CollaboratorSource = 'collaborators' | 'permission' | 'none';
export type MemberCacheTier = 'full' | 'admin';
export type RepositorySyncMode = 'collaborators' | 'assignees' | 'degraded_metadata';

export interface BoundGitHubUser {
  id: string;
  login: string;
}

export interface LiveInstallationAccess {
  target_id: string;
  owner: boolean;
  repository_ids: string[];
  admin_ids: string[];
}

/** A failure's error code, safe to record: never a message, URL or credential. */
export const failureCode = (error: unknown): string => error instanceof HttpError ? error.code : 'unexpected_error';

/** Transient GitHub faults keep the last confirmed membership snapshot instead of revoking active grants (#708, #1158). */
export const isTransientGitHubError = (code: string | null | undefined): boolean =>
  code === 'github_rate_limited' || code === 'github_verification_unavailable';

const retryDelayMs = (failures: number): number => Math.min(10 * 60_000, 15_000 * 2 ** Math.min(Math.max(0, failures), 5));

/** Bound GitHub accounts whose derived grants depend on repository membership (#1158). */
export function boundGitHubUsers(store: Store, principalId?: string): BoundGitHubUser[] {
  if (!store.hasTable('external_identities')) return [];
  const rows = principalId
    ? store.all(`SELECT DISTINCT external_actor AS id,display_name AS login FROM external_identities
        WHERE principal_id=? AND provider='github' AND host='github.com' AND status<>'revoked' AND credentials IS NOT NULL`, principalId)
    : store.all(`SELECT DISTINCT external_actor AS id,display_name AS login FROM external_identities
        WHERE provider='github' AND host='github.com' AND status<>'revoked' AND credentials IS NOT NULL`);
  const seen = new Set<string>(), users: BoundGitHubUser[] = [];
  for (const row of rows) {
    const id = numericId(row.id), login = typeof row.login === 'string' ? row.login.trim() : '';
    if (!id || !login || seen.has(id)) continue;
    seen.add(id);
    users.push({ id, login });
  }
  return users;
}

/**
 * In repository-only (`assignees`) or degraded metadata-only sync modes, collaborator roles are recorded in
 * `github_repository_collaborators` from `/collaborators` (`source = 'collaborators'`), `/permission` (`source = 'permission'`),
 * or confirmed absence (`source = 'none'`). Returns true when `cached` has not yet recorded a bound user's status there, so a
 * newly invited outside collaborator or concealed org member signing in triggers a conditional ETag revalidation once.
 */
export function repositoryNeedsBoundUserRole(
  store: Store,
  installationRef: string,
  repositoryId: string,
  cached: Row | undefined,
  users: readonly BoundGitHubUser[],
): boolean {
  if (!cached || cached.synced_at === null || Number(cached.in_installation) === 0 || cached.last_error) return false;
  const mode = String(cached.sync_mode || 'collaborators') as RepositorySyncMode;
  if (mode === 'collaborators' || !users.length) return false;
  for (const user of users) {
    const recorded = store.get(
      'SELECT 1 FROM github_repository_collaborators WHERE installation_ref=? AND repository_id=? AND github_user_id=?',
      installationRef, repositoryId, user.id,
    );
    if (!recorded) return true;
  }
  return false;
}

/** When GitHub refused a response for its rate limit, the time it may be asked again (its reset or Retry-After, else a minute); otherwise null. */
export function rateLimitedUntil(store: Store, response: Response, bucket?: Bucket): number | null {
  const limited = response.status === 429 || response.status === 403 &&
    (response.headers.get('retry-after') !== null || response.headers.get('x-ratelimit-remaining') === '0');
  if (bucket && !limited) observe(store, bucket, response.headers, response.status);
  return limited ? refused(store, bucket, response.headers).until : null;
}

/**
 * Extracts a real collaborator's highest effective role from `/repos/{owner}/{repo}/collaborators` (#1158).
 */
export function collaboratorRole(item: unknown): { id: string; login: string; role: CollaboratorRole | null } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(502, 'github_incomplete_evidence');
  const row = item as Json, id = numericId(row.id);
  if (!id || typeof row.login !== 'string' || !row.login) return fail(502, 'github_incomplete_evidence');
  const roleName = typeof row.role_name === 'string' ? row.role_name.toLowerCase() : '';
  const perms = row.permissions && typeof row.permissions === 'object' && !Array.isArray(row.permissions) ? row.permissions as Json : null;
  const knownName = ['admin', 'maintain', 'write', 'triage', 'read', 'none'].includes(roleName);
  if (!knownName && !perms) return fail(502, 'github_incomplete_evidence');
  const role: CollaboratorRole | null = roleName === 'admin' || perms?.admin === true ? 'admin'
    : roleName === 'maintain' || perms?.maintain === true ? 'maintain'
    : roleName === 'write' || perms?.push === true ? 'write'
    : roleName === 'triage' || perms?.triage === true ? 'triage'
    : roleName === 'read' || perms?.pull === true ? 'read' : null;
  return { id, login: row.login, role };
}

/**
 * Parses `/repos/{owner}/{repo}/collaborators/{username}/permission`, binding the response back to `expectedUserId`.
 * Callers must gate `'read'` on public repositories with `/assignees` membership so public outsiders never receive access.
 */
export function singleUserPermissionRole(data: unknown, expectedUserId: string): { role: CollaboratorRole | 'none'; login: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(502, 'github_incomplete_evidence');
  const body = data as Json, user = body.user as Json | undefined;
  const perm = typeof body.permission === 'string' ? body.permission.toLowerCase() : '';
  if (numericId(user?.id) !== expectedUserId || !['none', 'read', 'write', 'admin', 'maintain', 'triage'].includes(perm)) {
    return fail(502, 'github_incomplete_evidence');
  }
  const login = typeof user?.login === 'string' && user.login ? user.login : '';
  if (perm === 'none') return { role: 'none', login };
  const roleName = typeof body.role_name === 'string' ? body.role_name.toLowerCase() : '';
  const userPerms = user?.permissions && typeof user.permissions === 'object' && !Array.isArray(user.permissions) ? user.permissions as Json : null;
  const role: CollaboratorRole = perm === 'admin' || roleName === 'admin' || userPerms?.admin === true ? 'admin'
    : perm === 'maintain' || roleName === 'maintain' || userPerms?.maintain === true ? 'maintain'
    : perm === 'write' || roleName === 'write' || userPerms?.push === true ? 'write'
    : perm === 'triage' || roleName === 'triage' || userPerms?.triage === true ? 'triage'
    : 'read';
  return { role, login };
}

interface PageRead {
  status: 'ok' | 'not_modified' | 'missing';
  items: Json[];
  etag: string | null;
}

interface LiveRepo {
  id: string;
  full_name: string;
  owner_id: string;
  private: boolean;
}

/**
 * Synchronizes local owner and repository-collaborator caches per installation (#1158):
 * - Repository-only default (`sync_mode = 'assignees'`): without requesting Organization `Members: read`, enumerates real
 *   repository members (including concealed organization members) via `GET /repos/{owner}/{repo}/assignees?per_page=100`
 *   (`issues: read` or `pull_requests: read`, with `ETag` `304`), combines direct collaborators from `/collaborators`, and
 *   resolves exact 5-tier roles for bound GitHub users via `/collaborators/{username}/permission` (also `ETag` `304`). Public
 *   outsiders are absent from `/assignees`, so implicit public `read` is never granted.
 * - Optional `Members: read` fast path (`sync_mode = 'collaborators'`): when an existing App already has `Members: read`
 *   (or on personal installations), caches owners from `/orgs/{org}/members?role=admin` and full collaborators from
 *   `/repos/{owner}/{repo}/collaborators` in one paginated call per repository.
 * - Reuses the cached read-only installation token across rounds until it nears expiry (#1411, `read-tokens.ts`), so
 *   conditional requests can answer 304, and retains the last confirmed snapshot on 5xx / network / 429 faults.
 */
export class GitHubPermissions {
  /** `limited` hears when GitHub refused a request for its rate limit, and until when. */
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com', private readonly limited: (until: number) => void = () => {}) {}

  private async send(
    token: string,
    bucket: Bucket | undefined,
    path: string,
    options: { body?: Json; ifNoneMatch?: string | null; missing?: boolean; noContent?: boolean } = {},
  ): Promise<{ status: number; data: Json | null; etag: string | null }> {
    let response: Response;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.ifNoneMatch ? { 'If-None-Match': options.ifNoneMatch } : {}),
    };
    try {
      response = await fetch(new URL(path, this.apiUrl), {
        method: options.body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch {
      return fail(502, 'github_verification_unavailable');
    }
    const limit = rateLimitedUntil(this.store, response, bucket);
    if (limit) { this.limited(limit); return fail(429, 'github_rate_limited'); }
    if (options.ifNoneMatch && response.status === 304) {
      return { status: 304, data: null, etag: response.headers.get('etag') || options.ifNoneMatch };
    }
    if (options.missing && response.status === 404) {
      return { status: 404, data: null, etag: null };
    }
    if (options.noContent && response.status === 204) {
      return { status: 204, data: null, etag: response.headers.get('etag') || null };
    }
    if (response.status >= 500) return fail(502, 'github_verification_unavailable');
    // A refused installation token leaves the token cache; the status tells a caller that may retry with a new one.
    if (response.status === 401) { refuseReadToken(this.store, token); return fail(401, 'github_permission_pending'); }
    if (!response.ok) return fail(403, 'github_permission_pending');
    try {
      return { status: response.status, data: await response.json() as Json, etag: response.headers.get('etag') || null };
    } catch {
      return fail(502, 'github_incomplete_evidence');
    }
  }

  private async readPages(token: string, bucket: Bucket, basePath: string, ifNoneMatch: string | null = null, missing = false): Promise<PageRead> {
    const items: Json[] = [];
    let firstEtag: string | null = null;
    const separator = basePath.includes('?') ? '&' : '?';
    for (let page = 1; page <= 1000; page++) {
      const response = await this.send(token, bucket, `${basePath}${separator}per_page=100&page=${page}`, {
        ifNoneMatch: page === 1 ? ifNoneMatch : null,
        missing: page === 1 && missing,
      });
      if (page === 1 && response.status === 304) return { status: 'not_modified', items: [], etag: response.etag };
      if (page === 1 && response.status === 404) return { status: 'missing', items: [], etag: null };
      if (!Array.isArray(response.data)) return fail(502, 'github_incomplete_evidence');
      if (page === 1) firstEtag = response.etag;
      const list = response.data as Json[];
      items.push(...list);
      if (list.length < 100) {
        // Only a single-page listing has a single ETag covering the whole collection.
        return { status: 'ok', items, etag: page === 1 ? firstEtag : null };
      }
      if (page === 1000) return fail(502, 'github_incomplete_evidence');
    }
    return fail(502, 'github_incomplete_evidence');
  }

  private async readInstallationRepositories(token: string, bucket: Bucket, targetId: string): Promise<Map<string, LiveRepo>> {
    const repos = new Map<string, LiveRepo>();
    let count: number | null = null;
    for (let page = 1; page <= 1000; page++) {
      const { data } = await this.send(token, bucket, `/installation/repositories?per_page=100&page=${page}`);
      if (!Array.isArray(data?.repositories) || !Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0 ||
        count !== null && data.total_count !== count) return fail(502, 'github_incomplete_evidence');
      count = Number(data.total_count);
      for (const repo of data.repositories as Json[]) {
        const id = numericId(repo.id);
        if (!id || repos.has(id) || numericId((repo.owner as Json | undefined)?.id) !== targetId ||
          typeof repo.full_name !== 'string' || !/^[^/]+\/[^/]+$/.test(repo.full_name)) return fail(502, 'github_incomplete_evidence');
        repos.set(id, { id, full_name: repo.full_name, owner_id: targetId, private: Boolean(repo.private) });
      }
      if (repos.size === count) return repos;
      if (repos.size > count || !(data.repositories as Json[]).length || page === 1000) return fail(502, 'github_incomplete_evidence');
    }
    return fail(502, 'github_incomplete_evidence');
  }

  private resolveAccount(appId: string, preferredAccountId?: string | null): Row | undefined {
    if (preferredAccountId) {
      const preferred = this.store.get("SELECT * FROM accounts WHERE id=? AND type='github_app' AND app_id=?", preferredAccountId, appId);
      if (preferred) return preferred;
    }
    return this.store.get("SELECT * FROM accounts WHERE type='github_app' AND app_id=? ORDER BY created_at LIMIT 1", appId);
  }

  private async confirmRepositoryIdentity(token: string, bucket: Bucket, encodedName: string, repoId: string, ownerId: string): Promise<'ok' | 'missing'> {
    const meta = await this.send(token, bucket, `/repos/${encodedName}`, { missing: true });
    if (!meta.data) return 'missing';
    if (numericId(meta.data.id) !== repoId || numericId((meta.data.owner as Json | undefined)?.id) !== ownerId) {
      return fail(502, 'github_incomplete_evidence');
    }
    return 'ok';
  }

  /**
   * Synchronizes one active `github_installations` row's owner and repository collaborator caches.
   * When `checkAll` is false, only cold, dirty, errored, tier-upgraded or newly bound-user entries are fetched; when `checkAll`
   * is true, cached ETag conditional requests revalidate every entry in one installation-token round.
   */
  async syncInstallation(snapshot: Row, options: { checkAll?: boolean; bypassBackoff?: boolean } = {}): Promise<void> {
    const ref = String(snapshot.ref), now = Date.now();
    if (snapshot.status !== 'active' || snapshot.scope_pending || snapshot.completeness !== 'complete') return;
    const instCache = this.store.get('SELECT * FROM github_installation_member_cache WHERE installation_ref=?', ref);
    if (!options.bypassBackoff && instCache && instCache.next_retry_at > now && !instCache.dirty) return;

    const presentRepos = this.store.all(`SELECT ir.repository_id,ir.full_name,ir.owner_id,ir.private,
      EXISTS(SELECT 1 FROM repositories r WHERE r.id=ir.repository_id) AS started
      FROM installation_repositories ir WHERE ir.installation_ref=? AND ir.present=1 ORDER BY ir.repository_id`, ref);
    const repoCaches = new Map<string, Row>(
      this.store.all('SELECT * FROM github_repository_member_cache WHERE installation_ref=?', ref).map(row => [String(row.repository_id), row]),
    );
    const boundUsers = boundGitHubUsers(this.store);
    const instDirtyBefore = Number(instCache?.dirty ?? 1);
    const needOwnersInitial = Boolean(
      options.checkAll || !instCache || instCache.synced_at === null || instDirtyBefore > 0 || instCache.last_error !== null ||
      instCache.installation_revision !== snapshot.revision || instCache.target_id !== snapshot.target_id ||
      instCache.repository_selection !== snapshot.repository_selection,
    );
    const repoNeedsSync = (repo: Row, desiredMode?: RepositorySyncMode): boolean => {
      const id = String(repo.repository_id), cached = repoCaches.get(id), neededTier: MemberCacheTier = repo.started ? 'full' : 'admin';
      const missingUser = repositoryNeedsBoundUserRole(this.store, ref, id, cached, boundUsers);
      const modeChanged = Boolean(desiredMode && cached && String(cached.sync_mode || 'collaborators') !== desiredMode);
      if (!options.bypassBackoff && cached && cached.next_retry_at > now && !cached.dirty && !missingUser && !modeChanged &&
        (cached.tier === 'full' || neededTier === 'admin')) return false;
      return Boolean(
        options.checkAll || !cached || cached.synced_at === null || Number(cached.dirty) > 0 || cached.last_error !== null ||
        cached.full_name !== repo.full_name || (neededTier === 'full' && cached.tier !== 'full') || missingUser || modeChanged,
      );
    };
    if (!needOwnersInitial && !presentRepos.some(repo => repoNeedsSync(repo))) return;

    const account = this.resolveAccount(String(snapshot.app_id), snapshot.account_id ? String(snapshot.account_id) : null);
    if (!account) {
      this.recordInstallationError(snapshot, instCache, instDirtyBefore, 'github_permission_pending');
      return;
    }
    const credentials = this.store.secrets.open(account.credentials, `account:${account.id}`);
    const jwtBucket = appBucket(String(account.id));
    let installation: Json | null;
    try {
      installation = (await this.send(appJwt(String(snapshot.app_id), String(credentials.private_key || '')), jwtBucket, `/app/installations/${snapshot.installation_id}`)).data;
    } catch (error) {
      this.recordInstallationError(snapshot, instCache, instDirtyBefore, failureCode(error));
      return;
    }
    const target = installation?.account as Json | undefined, targetId = numericId(target?.id);
    if (!installation || numericId(installation.id) !== String(snapshot.installation_id) || numericId(installation.app_id) !== String(snapshot.app_id) || !targetId ||
      !['User', 'Organization'].includes(String(target?.type)) || typeof target?.login !== 'string' || !target.login || installation.suspended_at ||
      !['all', 'selected'].includes(String(installation.repository_selection))) {
      this.recordInstallationError(snapshot, instCache, instDirtyBefore, 'github_permission_pending');
      return;
    }
    if (targetId !== String(snapshot.target_id) || String(installation.repository_selection) !== String(snapshot.repository_selection)) {
      this.recordInstallationError(snapshot, instCache, instDirtyBefore, 'installation_target_changed');
      return;
    }

    const instPerms = (installation.permissions && typeof installation.permissions === 'object' ? installation.permissions : {}) as Json;
    const hasRead = (key: string) => ['read', 'write'].includes(String(instPerms[key]));
    const membershipReadable = target.type === 'Organization' && hasRead('members');
    const assigneesScope = !membershipReadable && target.type === 'Organization'
      ? (hasRead('issues') ? 'issues' : hasRead('pull_requests') ? 'pull_requests' : null)
      : null;
    const syncMode: RepositorySyncMode = target.type === 'User' || membershipReadable ? 'collaborators'
      : assigneesScope ? 'assignees' : 'degraded_metadata';
    const expectedOwnersUncertain = syncMode === 'degraded_metadata' ? 'membership_unreadable' : null;
    const needOwners = needOwnersInitial || (instCache?.owners_uncertain ?? null) !== expectedOwnersUncertain;
    const candidateRepos = presentRepos.filter(repo => repoNeedsSync(repo, syncMode));
    if (!needOwners && !candidateRepos.length) return;

    const permissions: Record<string, string> = {
      metadata: 'read',
      ...(membershipReadable ? { members: 'read' } : assigneesScope ? { [assigneesScope]: 'read' } : {}),
    };
    // The read-only installation token outlives this round (#1411): a later round within its life reuses it, and its ETags.
    const acquire = () => acquireReadToken(this.store, this.apiUrl, account, String(snapshot.installation_id), permissions, async () =>
      (await this.send(appJwt(String(snapshot.app_id), String(credentials.private_key || '')), jwtBucket,
        `/app/installations/${snapshot.installation_id}/access_tokens`, { body: { permissions } })).data);
    const instBucket = installationBucket(String(account.id), String(snapshot.installation_id), String(target.login));
    let lease: ReadTokenLease | undefined, liveRepos: Map<string, LiveRepo>;
    try {
      lease = await acquire();
      try {
        liveRepos = await this.readInstallationRepositories(lease.token, instBucket, targetId);
      } catch (error) {
        if (!lease.reused || !(error instanceof HttpError && error.status === 401)) throw error;
        // GitHub refused a token an earlier round minted, so the cache has dropped it: one new token reads again.
        await lease.release();
        lease = await acquire();
        liveRepos = await this.readInstallationRepositories(lease.token, instBucket, targetId);
      }
    } catch (error) {
      await lease?.release();
      this.recordInstallationError(snapshot, instCache, instDirtyBefore, failureCode(error));
      return;
    }
    const token = lease.token;
    try {
      type OwnersOutcome =
        | { kind: 'skipped' }
        | { kind: 'not_modified'; etag: string | null }
        | { kind: 'updated'; owners: { id: string; login: string }[]; etag: string | null; uncertain: string | null }
        | { kind: 'error'; code: string; transient: boolean };
      let ownersOutcome: OwnersOutcome = { kind: 'skipped' };
      let rateLimitedAbort = false;

      if (needOwners) {
        if (target.type === 'User') {
          ownersOutcome = { kind: 'updated', owners: [{ id: targetId, login: String(target.login) }], etag: null, uncertain: null };
        } else if (!membershipReadable) {
          ownersOutcome = { kind: 'updated', owners: [], etag: null, uncertain: expectedOwnersUncertain };
        } else {
          const reuseEtag = instCache && instCache.synced_at !== null && !instCache.last_error && !instCache.owners_uncertain &&
            instCache.target_id === targetId ? (instCache.owners_etag as string | null) : null;
          try {
            const page = await this.readPages(token, instBucket, `/orgs/${encodeURIComponent(String(target.login))}/members?role=admin`, reuseEtag, true);
            if (page.status === 'not_modified') {
              ownersOutcome = { kind: 'not_modified', etag: page.etag };
            } else if (page.status === 'missing') {
              ownersOutcome = { kind: 'updated', owners: [], etag: null, uncertain: null };
            } else {
              const owners: { id: string; login: string }[] = [], seen = new Set<string>();
              for (const member of page.items) {
                const id = numericId(member.id);
                if (!id || typeof member.login !== 'string' || !member.login) { fail(502, 'github_incomplete_evidence'); continue; }
                if (!seen.has(id)) { seen.add(id); owners.push({ id, login: member.login }); }
              }
              ownersOutcome = { kind: 'updated', owners, etag: page.etag, uncertain: null };
            }
          } catch (error) {
            const code = failureCode(error), transient = isTransientGitHubError(code);
            ownersOutcome = { kind: 'error', code: transient ? code : 'membership:' + code, transient };
            if (code === 'github_rate_limited') rateLimitedAbort = true;
          }
        }
      }

      type CollaboratorEntry = { id: string; login: string; role: StoredCollaboratorRole; roleEtag: string | null; source: CollaboratorSource };
      type RepoOutcome = {
        repository_id: string;
        owner_id: string;
        full_name: string;
        private: boolean;
        tier: MemberCacheTier;
        syncMode: RepositorySyncMode;
        dirtyBefore: number;
        result:
          | { kind: 'not_modified'; etag: string | null; assigneesEtag: string | null }
          | {
              kind: 'updated';
              collaborators: CollaboratorEntry[];
              assignees: { id: string; login: string }[] | null;
              etag: string | null;
              assigneesEtag: string | null;
            }
          | { kind: 'removed' }
          | { kind: 'error'; code: string; transient: boolean };
      };
      const repoOutcomes: RepoOutcome[] = [];

      const syncOneRepository = async (repo: Row): Promise<RepoOutcome> => {
        const repoId = String(repo.repository_id), cached = repoCaches.get(repoId), dirtyBefore = Number(cached?.dirty ?? 1);
        const live = liveRepos.get(repoId);
        const tier: MemberCacheTier = repo.started ? 'full' : 'admin';
        if (!live) {
          return {
            repository_id: repoId, owner_id: String(repo.owner_id), full_name: String(repo.full_name),
            private: Boolean(repo.private), tier, syncMode, dirtyBefore, result: { kind: 'removed' },
          };
        }

        const encodedName = live.full_name.split('/').map(encodeURIComponent).join('/');
        const sameConfirmedRepo = Boolean(
          cached && cached.synced_at !== null && Number(cached.in_installation) === 1 && !cached.last_error &&
          cached.full_name === live.full_name && String(cached.sync_mode || 'collaborators') === syncMode,
        );

        try {
          if (syncMode === 'collaborators') {
            const reuseEtag = sameConfirmedRepo && cached!.tier === tier ? (cached!.etag as string | null) : null;
            const path = `/repos/${encodedName}/collaborators${tier === 'admin' ? '?permission=admin' : ''}`;
            const page = await this.readPages(token, instBucket, path, reuseEtag, true);
            if (page.status === 'not_modified') {
              return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
                result: { kind: 'not_modified', etag: page.etag, assigneesEtag: null } };
            }
            if (page.status === 'missing' || await this.confirmRepositoryIdentity(token, instBucket, encodedName, repoId, live.owner_id) === 'missing') {
              return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
                result: { kind: 'updated', collaborators: [], assignees: [], etag: null, assigneesEtag: null } };
            }
            const collaborators: CollaboratorEntry[] = [], seen = new Set<string>();
            for (const item of page.items) {
              const parsed = collaboratorRole(item);
              if (!parsed.role || tier === 'admin' && parsed.role !== 'admin') continue;
              if (!seen.has(parsed.id)) {
                seen.add(parsed.id);
                collaborators.push({ id: parsed.id, login: parsed.login, role: parsed.role, roleEtag: null, source: 'collaborators' });
              }
            }
            return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
              result: { kind: 'updated', collaborators, assignees: [], etag: page.etag, assigneesEtag: null } };
          }

          // Repository-only (`assignees`) or `degraded_metadata` mode (no Organization `Members: read`).
          const prevCollabs = new Map<string, { login: string; role: StoredCollaboratorRole; roleEtag: string | null; source: CollaboratorSource }>(
            sameConfirmedRepo && cached!.tier === tier
              ? this.store.all('SELECT github_user_id,login,role,role_etag,source FROM github_repository_collaborators WHERE installation_ref=? AND repository_id=?', ref, repoId)
                  .map(r => [String(r.github_user_id), {
                    login: String(r.login),
                    role: String(r.role) as StoredCollaboratorRole,
                    roleEtag: r.role_etag ? String(r.role_etag) : null,
                    source: (r.source === 'permission' || r.source === 'none' ? r.source : 'collaborators') as CollaboratorSource,
                  }])
              : [],
          );

          let assigneesPage: PageRead = { status: 'ok', items: [], etag: null };
          const assigneesMap = new Map<string, string>();
          if (syncMode === 'assignees') {
            const reuseAssigneesEtag = sameConfirmedRepo ? (cached!.assignees_etag as string | null) : null;
            assigneesPage = await this.readPages(token, instBucket, `/repos/${encodedName}/assignees`, reuseAssigneesEtag, true);
            if (assigneesPage.status === 'missing') {
              return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
                result: { kind: 'updated', collaborators: [], assignees: [], etag: null, assigneesEtag: null } };
            }
            if (assigneesPage.status === 'not_modified') {
              for (const row of this.store.all('SELECT github_user_id,login FROM github_repository_assignees WHERE installation_ref=? AND repository_id=?', ref, repoId)) {
                assigneesMap.set(String(row.github_user_id), String(row.login));
              }
            } else {
              for (const item of assigneesPage.items) {
                const id = numericId(item.id);
                if (!id || typeof item.login !== 'string' || !item.login) fail(502, 'github_incomplete_evidence');
                else if (!assigneesMap.has(id)) assigneesMap.set(id, item.login);
              }
            }
          }

          const reuseCollabEtag = sameConfirmedRepo && cached!.tier === tier ? (cached!.etag as string | null) : null;
          const collabPath = `/repos/${encodedName}/collaborators${tier === 'admin' ? '?permission=admin' : ''}`;
          const collabPage = await this.readPages(token, instBucket, collabPath, reuseCollabEtag, true);
          if (collabPage.status === 'missing') {
            return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
              result: { kind: 'updated', collaborators: [], assignees: [], etag: null, assigneesEtag: null } };
          }

          const directRoles = new Map<string, CollaboratorEntry>();
          if (collabPage.status === 'ok') {
            for (const item of collabPage.items) {
              const parsed = collaboratorRole(item);
              if (!parsed.role || tier === 'admin' && parsed.role !== 'admin') continue;
              if (!directRoles.has(parsed.id)) {
                directRoles.set(parsed.id, { id: parsed.id, login: parsed.login, role: parsed.role, roleEtag: null, source: 'collaborators' });
              }
            }
          }

          let anyFresh200 = assigneesPage.status === 'ok' || collabPage.status === 'ok';
          let anyUserChanged = false;
          const nextCollabs = new Map<string, CollaboratorEntry>(directRoles);

          // A `304` on `/collaborators` authoritatively confirms every cached direct/outside collaborator (bound or unbound),
          // including outside Read collaborators on public repositories who are absent from `/assignees`.
          if (collabPage.status === 'not_modified') {
            for (const [id, prev] of prevCollabs) {
              if (prev.source === 'collaborators' && prev.role !== 'none' && prev.role !== 'ambiguous_public_read') {
                nextCollabs.set(id, { id, login: prev.login, role: prev.role, roleEtag: null, source: 'collaborators' });
              }
            }
          }

          for (const user of boundUsers) {
            if (rateLimitedAbort) break;
            if (nextCollabs.has(user.id)) continue;
            const inAssignees = syncMode === 'assignees' && assigneesMap.has(user.id);
            // In `assignees` mode, direct/outside collaborators are already in `/collaborators` and concealed org members are
            // in `/assignees`; bound users absent from their union hold no role here without any `/permission` call.
            if (syncMode === 'assignees' && !inAssignees) {
              const prev = prevCollabs.get(user.id);
              if (!prev || prev.role !== 'none' || prev.source !== 'none') anyUserChanged = true;
              nextCollabs.set(user.id, { id: user.id, login: user.login, role: 'none', roleEtag: null, source: 'none' });
              continue;
            }
            const login = assigneesMap.get(user.id) || user.login;
            const prev = prevCollabs.get(user.id);
            const needRoleCheck = Boolean(
              options.checkAll || !prev || prev.source !== 'permission' || prev.login !== login || assigneesPage.status === 'ok',
            );
            if (!needRoleCheck && prev) {
              nextCollabs.set(user.id, { id: user.id, login: prev.login, role: prev.role, roleEtag: prev.roleEtag, source: 'permission' });
              continue;
            }
            const permResp = await this.send(
              token, instBucket, `/repos/${encodedName}/collaborators/${encodeURIComponent(login)}/permission`,
              { ifNoneMatch: prev?.source === 'permission' ? prev.roleEtag : null, missing: true },
            );
            if (permResp.status === 304 && prev && prev.source === 'permission') {
              nextCollabs.set(user.id, { id: user.id, login, role: prev.role, roleEtag: permResp.etag || prev.roleEtag, source: 'permission' });
              continue;
            }
            anyFresh200 = anyFresh200 || permResp.status === 200;
            anyUserChanged = true;
            if (permResp.status === 404 || !permResp.data) {
              nextCollabs.set(user.id, { id: user.id, login, role: 'none', roleEtag: null, source: 'permission' });
              continue;
            }
            const parsed = singleUserPermissionRole(permResp.data, user.id);
            let storedRole: StoredCollaboratorRole = parsed.role;
            if (!live.private && parsed.role === 'read' && !inAssignees) {
              storedRole = syncMode === 'degraded_metadata' ? 'ambiguous_public_read' : 'none';
            } else if (tier === 'admin' && parsed.role !== 'admin') {
              storedRole = 'none';
            }
            nextCollabs.set(user.id, { id: user.id, login: parsed.login || login, role: storedRole, roleEtag: permResp.etag, source: 'permission' });
          }

          if (!anyFresh200 && !anyUserChanged && assigneesPage.status !== 'ok' && collabPage.status === 'not_modified') {
            return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
              result: { kind: 'not_modified', etag: collabPage.etag, assigneesEtag: assigneesPage.etag } };
          }
          if (anyFresh200 && await this.confirmRepositoryIdentity(token, instBucket, encodedName, repoId, live.owner_id) === 'missing') {
            return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
              result: { kind: 'updated', collaborators: [], assignees: [], etag: null, assigneesEtag: null } };
          }
          return {
            repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
            result: {
              kind: 'updated',
              collaborators: [...nextCollabs.values()],
              assignees: syncMode === 'assignees'
                ? (assigneesPage.status === 'ok' ? [...assigneesMap.entries()].map(([id, login]) => ({ id, login })) : null)
                : [],
              etag: collabPage.etag,
              assigneesEtag: syncMode === 'assignees' ? assigneesPage.etag : null,
            },
          };
        } catch (error) {
          const code = failureCode(error), transient = isTransientGitHubError(code);
          if (code === 'github_rate_limited') rateLimitedAbort = true;
          return { repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, private: live.private, tier, syncMode, dirtyBefore,
            result: { kind: 'error', code, transient } };
        }
      };

      if (!rateLimitedAbort && candidateRepos.length) {
        const concurrency = Math.min(4, candidateRepos.length);
        let nextRepoIndex = 0;
        const results = new Array<RepoOutcome | undefined>(candidateRepos.length);
        const worker = async () => {
          while (!rateLimitedAbort && nextRepoIndex < candidateRepos.length) {
            const index = nextRepoIndex++;
            results[index] = await syncOneRepository(candidateRepos[index]!);
          }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        for (const item of results) if (item) repoOutcomes.push(item);
      }

      // The reads are done. Releasing the token comes before the credential fence, so that a revoke it still needs (a token
      // replaced meanwhile, or one minted without a usable expiry) happens inside the fence, and no await separates the
      // check from the commit below. A round whose account credentials changed commits nothing and retires its token.
      const rotated = () => this.store.get('SELECT credentials FROM accounts WHERE id=?', account.id)?.credentials !== account.credentials;
      await lease.release(rotated());
      if (rotated()) {
        this.recordInstallationError(snapshot, instCache, instDirtyBefore, 'authorization_changed');
        return;
      }

      const committedAt = Date.now();
      this.store.transaction(() => {
        const current = this.store.get('SELECT * FROM github_installations WHERE ref=?', ref);
        if (!current || current.status !== 'active' || current.scope_pending || current.completeness !== 'complete') return;

        // Clean up caches for repositories no longer marked present in installation_repositories.
        for (const table of ['github_repository_collaborators', 'github_repository_assignees', 'github_repository_member_cache']) {
          this.store.run(`DELETE FROM ${table} WHERE installation_ref=?
            AND repository_id NOT IN (SELECT repository_id FROM installation_repositories WHERE installation_ref=? AND present=1)`, ref, ref);
        }

        const handledRepoIds = new Set<string>();
        for (const outcome of repoOutcomes) {
          handledRepoIds.add(outcome.repository_id);
          const startedNow = !!this.store.get('SELECT 1 FROM repositories WHERE id=?', outcome.repository_id);
          const tierShort = outcome.result.kind !== 'removed' && startedNow && outcome.tier !== 'full';
          const prevRepo = this.store.get('SELECT * FROM github_repository_member_cache WHERE installation_ref=? AND repository_id=?', ref, outcome.repository_id);
          const nextDirty = tierShort ? Math.max(1, Number(prevRepo?.dirty ?? 1))
            : prevRepo ? (Number(prevRepo.dirty) === outcome.dirtyBefore ? 0 : Number(prevRepo.dirty)) : 0;

          if (outcome.result.kind === 'removed') {
            this.store.run('DELETE FROM github_repository_collaborators WHERE installation_ref=? AND repository_id=?', ref, outcome.repository_id);
            this.store.run('DELETE FROM github_repository_assignees WHERE installation_ref=? AND repository_id=?', ref, outcome.repository_id);
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,private,sync_mode,etag,assignees_etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,0,?,?,NULL,NULL,?,?,?,0,NULL,0)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET owner_id=excluded.owner_id,full_name=excluded.full_name,
              tier=excluded.tier,in_installation=0,private=excluded.private,sync_mode=excluded.sync_mode,etag=NULL,assignees_etag=NULL,
              synced_at=excluded.synced_at,checked_at=excluded.checked_at,dirty=excluded.dirty,failures=0,last_error=NULL,next_retry_at=0`,
              ref, outcome.repository_id, outcome.owner_id, outcome.full_name, startedNow ? 'full' : 'admin',
              Number(outcome.private), outcome.syncMode, committedAt, committedAt, nextDirty);
            continue;
          }

          if (outcome.result.kind === 'updated') {
            this.store.run('DELETE FROM github_repository_collaborators WHERE installation_ref=? AND repository_id=?', ref, outcome.repository_id);
            for (const c of outcome.result.collaborators) {
              this.store.run(
                'INSERT INTO github_repository_collaborators(installation_ref,repository_id,github_user_id,login,role,role_etag,source) VALUES(?,?,?,?,?,?,?)',
                ref, outcome.repository_id, c.id, c.login, c.role, c.roleEtag, c.source,
              );
            }
            if (outcome.result.assignees !== null) {
              this.store.run('DELETE FROM github_repository_assignees WHERE installation_ref=? AND repository_id=?', ref, outcome.repository_id);
              for (const a of outcome.result.assignees) {
                this.store.run('INSERT INTO github_repository_assignees VALUES(?,?,?,?)', ref, outcome.repository_id, a.id, a.login);
              }
            }
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,private,sync_mode,etag,assignees_etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,0,NULL,0)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET owner_id=excluded.owner_id,full_name=excluded.full_name,
              tier=excluded.tier,in_installation=1,private=excluded.private,sync_mode=excluded.sync_mode,etag=excluded.etag,
              assignees_etag=excluded.assignees_etag,synced_at=excluded.synced_at,checked_at=excluded.checked_at,
              dirty=excluded.dirty,failures=0,last_error=NULL,next_retry_at=0`,
              ref, outcome.repository_id, outcome.owner_id, outcome.full_name, outcome.tier, Number(outcome.private),
              outcome.syncMode, outcome.result.etag, outcome.result.assigneesEtag, committedAt, committedAt, nextDirty);
          } else if (outcome.result.kind === 'not_modified') {
            this.store.run(`UPDATE github_repository_member_cache SET owner_id=?,full_name=?,in_installation=1,private=?,sync_mode=?,
              etag=COALESCE(?,etag),assignees_etag=COALESCE(?,assignees_etag),
              checked_at=?,dirty=?,failures=0,last_error=NULL,next_retry_at=0 WHERE installation_ref=? AND repository_id=?`,
              outcome.owner_id, outcome.full_name, Number(outcome.private), outcome.syncMode,
              outcome.result.etag, outcome.result.assigneesEtag, committedAt, nextDirty, ref, outcome.repository_id);
          } else {
            const failures = Number(prevRepo?.failures ?? 0) + 1;
            const retryAt = committedAt + retryDelayMs(failures - 1);
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,private,sync_mode,etag,assignees_etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,1,?,?,NULL,NULL,NULL,?,?,?,?,?)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET checked_at=excluded.checked_at,dirty=excluded.dirty,
              failures=excluded.failures,last_error=excluded.last_error,next_retry_at=excluded.next_retry_at`,
              ref, outcome.repository_id, outcome.owner_id, outcome.full_name, prevRepo?.tier ?? outcome.tier,
              Number(outcome.private), prevRepo?.sync_mode ?? outcome.syncMode, committedAt, nextDirty, failures, outcome.result.code, retryAt);
          }
        }

        // Mark any non-candidate repository that vanished from GitHub's authoritative installation listing as absent.
        for (const repo of presentRepos) {
          const repoId = String(repo.repository_id);
          if (!handledRepoIds.has(repoId) && !liveRepos.has(repoId)) {
            const startedNow = !!this.store.get('SELECT 1 FROM repositories WHERE id=?', repoId);
            this.store.run('DELETE FROM github_repository_collaborators WHERE installation_ref=? AND repository_id=?', ref, repoId);
            this.store.run('DELETE FROM github_repository_assignees WHERE installation_ref=? AND repository_id=?', ref, repoId);
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,private,sync_mode,etag,assignees_etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,0,?,?,NULL,NULL,?,?,0,0,NULL,0)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET tier=excluded.tier,in_installation=0,private=excluded.private,
              sync_mode=excluded.sync_mode,etag=NULL,assignees_etag=NULL,
              synced_at=excluded.synced_at,checked_at=excluded.checked_at,dirty=0,failures=0,last_error=NULL,next_retry_at=0`,
              ref, repoId, String(repo.owner_id), String(repo.full_name), startedNow ? 'full' : 'admin', Number(Boolean(repo.private)), syncMode, committedAt, committedAt);
          }
        }

        const prevInst = this.store.get('SELECT * FROM github_installation_member_cache WHERE installation_ref=?', ref);
        const nextInstDirty = prevInst ? (Number(prevInst.dirty) === instDirtyBefore ? 0 : Number(prevInst.dirty)) : 0;
        const rateLimitError = rateLimitedAbort ? 'github_rate_limited' : null;
        const rateLimitRetry = rateLimitedAbort ? committedAt + retryDelayMs(0) : 0;

        if (ownersOutcome.kind === 'updated') {
          this.store.run('DELETE FROM github_installation_owners WHERE installation_ref=?', ref);
          for (const owner of ownersOutcome.owners) {
            this.store.run('INSERT INTO github_installation_owners VALUES(?,?,?)', ref, owner.id, owner.login);
          }
          this.store.run(`INSERT INTO github_installation_member_cache(installation_ref,target_id,target_type,repository_selection,installation_revision,
            owners_etag,owners_uncertain,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)
            ON CONFLICT(installation_ref) DO UPDATE SET target_id=excluded.target_id,target_type=excluded.target_type,
            repository_selection=excluded.repository_selection,installation_revision=excluded.installation_revision,
            owners_etag=excluded.owners_etag,owners_uncertain=excluded.owners_uncertain,
            synced_at=excluded.synced_at,checked_at=excluded.checked_at,dirty=excluded.dirty,failures=0,last_error=excluded.last_error,next_retry_at=excluded.next_retry_at`,
            ref, targetId, String(target.type), String(installation.repository_selection), current.revision,
            ownersOutcome.etag, ownersOutcome.uncertain, committedAt, committedAt, nextInstDirty, rateLimitError, rateLimitRetry);
        } else if (ownersOutcome.kind === 'not_modified' || ownersOutcome.kind === 'skipped') {
          this.store.run(`UPDATE github_installation_member_cache SET target_id=?,target_type=?,repository_selection=?,installation_revision=?,
            owners_etag=CASE WHEN ? IS NOT NULL THEN ? ELSE owners_etag END,checked_at=?,dirty=?,failures=0,last_error=?,next_retry_at=?
            WHERE installation_ref=?`,
            targetId, String(target.type), String(installation.repository_selection), current.revision,
            ownersOutcome.kind === 'not_modified' ? ownersOutcome.etag : null, ownersOutcome.kind === 'not_modified' ? ownersOutcome.etag : null,
            committedAt, nextInstDirty, rateLimitError, rateLimitRetry, ref);
        } else {
          const failures = Number(prevInst?.failures ?? 0) + 1;
          const retryAt = committedAt + retryDelayMs(failures - 1);
          this.store.run(`INSERT INTO github_installation_member_cache(installation_ref,target_id,target_type,repository_selection,installation_revision,
            owners_etag,owners_uncertain,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
            VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?)
            ON CONFLICT(installation_ref) DO UPDATE SET installation_revision=excluded.installation_revision,
            checked_at=excluded.checked_at,dirty=excluded.dirty,failures=excluded.failures,last_error=excluded.last_error,next_retry_at=excluded.next_retry_at`,
            ref, targetId, String(target.type), String(installation.repository_selection), current.revision,
            committedAt, nextInstDirty, failures, ownersOutcome.code, retryAt);
        }
      });
    } finally {
      await lease.release();
    }
  }

  private recordInstallationError(snapshot: Row, prevInst: Row | undefined, instDirtyBefore: number, code: string): void {
    const ref = String(snapshot.ref), now = Date.now(), failures = Number(prevInst?.failures ?? 0) + 1;
    const retryAt = now + retryDelayMs(failures - 1);
    const currentDirty = this.store.get('SELECT dirty FROM github_installation_member_cache WHERE installation_ref=?', ref)?.dirty;
    const nextDirty = currentDirty !== undefined && Number(currentDirty) !== instDirtyBefore ? Number(currentDirty) : 0;
    this.store.run(`INSERT INTO github_installation_member_cache(installation_ref,target_id,target_type,repository_selection,installation_revision,
      owners_etag,owners_uncertain,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
      VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?)
      ON CONFLICT(installation_ref) DO UPDATE SET checked_at=excluded.checked_at,dirty=excluded.dirty,
      failures=excluded.failures,last_error=excluded.last_error,next_retry_at=excluded.next_retry_at`,
      ref, String(snapshot.target_id || ''), String(snapshot.target_type || 'Organization'), String(snapshot.repository_selection || 'selected'),
      Number(snapshot.revision || 0), now, nextDirty, failures, code, retryAt);
  }

  /**
   * Verifies a person's real ownership or collaborator membership on an installation directly (used when an installation is
   * not yet projected in `github_installations` during App setup, or when unstarted repositories need non-admin collaborator
   * disclosure in the archive). Supports repository-only installations without `Members: read`, and never grants access to
   * public-repository outsiders (#1158).
   */
  async readInstallationAccess(ref: InstallationRef, userId: string, userLogin = ''): Promise<LiveInstallationAccess> {
    installationRef(ref);
    const account = this.resolveAccount(ref.app_id);
    if (!account) return fail(403, 'github_permission_pending');
    const credentials = this.store.secrets.open(account.credentials, `account:${account.id}`);
    const jwtBucket = appBucket(String(account.id));
    const installation = (await this.send(appJwt(ref.app_id, String(credentials.private_key || '')), jwtBucket, `/app/installations/${ref.installation_id}`)).data;
    const target = installation?.account as Json | undefined, targetId = numericId(target?.id);
    if (!installation || numericId(installation.id) !== ref.installation_id || numericId(installation.app_id) !== ref.app_id || !targetId ||
      !['User', 'Organization'].includes(String(target?.type)) || typeof target?.login !== 'string' || !target.login || installation.suspended_at ||
      !['all', 'selected'].includes(String(installation.repository_selection))) return fail(403, 'github_permission_pending');
    const instPerms = (installation.permissions && typeof installation.permissions === 'object' ? installation.permissions : {}) as Json;
    const hasRead = (key: string) => ['read', 'write'].includes(String(instPerms[key]));
    const membershipReadable = target.type === 'Organization' && hasRead('members');
    const assigneesScope = !membershipReadable && target.type === 'Organization'
      ? (hasRead('issues') ? 'issues' : hasRead('pull_requests') ? 'pull_requests' : null)
      : null;
    const permissions: Record<string, string> = {
      metadata: 'read',
      ...(membershipReadable ? { members: 'read' } : assigneesScope ? { [assigneesScope]: 'read' } : {}),
    };
    const access = (await this.send(appJwt(ref.app_id, String(credentials.private_key || '')), jwtBucket,
      `/app/installations/${ref.installation_id}/access_tokens`, { body: { permissions } })).data;
    if (typeof access?.token !== 'string' || !access.token) return fail(502, 'github_incomplete_evidence');
    const token = access.token, instBucket = installationBucket(String(account.id), ref.installation_id, String(target.login));
    let revoked = false;
    try {
      const repos = await this.readInstallationRepositories(token, instBucket, targetId);
      let owner = target.type === 'User' && targetId === userId;
      if (!owner && membershipReadable) {
        try {
          const page = await this.readPages(token, instBucket, `/orgs/${encodeURIComponent(String(target.login))}/members?role=admin`, null, true);
          if (page.status === 'ok') {
            for (const member of page.items) {
              const id = numericId(member.id);
              if (!id || typeof member.login !== 'string' || !member.login) return fail(502, 'github_incomplete_evidence');
              if (id === userId) owner = true;
            }
          }
        } catch (error) {
          if (failureCode(error) === 'github_rate_limited') throw error;
        }
      }
      const repositoryIds: string[] = [], adminIds: string[] = [];
      for (const [id, repo] of repos) {
        if (owner) { repositoryIds.push(id); adminIds.push(id); continue; }
        try {
          const encodedName = repo.full_name.split('/').map(encodeURIComponent).join('/');
          // Check `/collaborators` first (matched by numeric user ID) so direct/outside collaborators — including outside Read
          // collaborators on public repositories who are absent from `/assignees` — are always recognized.
          const page = await this.readPages(token, instBucket, `/repos/${encodedName}/collaborators`, null, true);
          if (page.status !== 'ok') continue;
          let directRole: CollaboratorRole | null = null;
          for (const item of page.items) {
            const parsed = collaboratorRole(item);
            if (parsed.id === userId && parsed.role) { directRole = parsed.role; break; }
          }
          if (directRole) {
            if (await this.confirmRepositoryIdentity(token, instBucket, encodedName, id, repo.owner_id) === 'missing') continue;
            repositoryIds.push(id);
            if (directRole === 'admin') adminIds.push(id);
            continue;
          }
          if (target.type === 'User' || membershipReadable || !userLogin) continue;
          // Repository-only Organization installation fallback for concealed org members omitted from `/collaborators`.
          if (assigneesScope) {
            const assigneeCheck = await this.send(
              token, instBucket, `/repos/${encodedName}/assignees/${encodeURIComponent(userLogin)}`,
              { missing: true, noContent: true },
            );
            if (assigneeCheck.status !== 204) continue;
          }
          const permResp = await this.send(
            token, instBucket, `/repos/${encodedName}/collaborators/${encodeURIComponent(userLogin)}/permission`, { missing: true },
          );
          if (!permResp.data) continue;
          const parsed = singleUserPermissionRole(permResp.data, userId);
          if (parsed.role === 'none' || !repo.private && parsed.role === 'read' && !assigneesScope) continue;
          if (await this.confirmRepositoryIdentity(token, instBucket, encodedName, id, repo.owner_id) === 'missing') continue;
          repositoryIds.push(id);
          if (parsed.role === 'admin') adminIds.push(id);
        } catch (error) {
          if (failureCode(error) === 'github_rate_limited') throw error;
        }
      }
      await revokeInstallationToken(this.apiUrl, token).catch(() => false);
      revoked = true;
      if (this.store.get('SELECT credentials FROM accounts WHERE id=?', account.id)?.credentials !== account.credentials) fail(409, 'authorization_changed');
      return { target_id: targetId, owner, repository_ids: repositoryIds, admin_ids: adminIds };
    } finally {
      if (!revoked) await revokeInstallationToken(this.apiUrl, token).catch(() => false);
    }
  }
}
