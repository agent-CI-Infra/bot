import type { Store, Row } from '../storage/database.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { appJwt, revokeInstallationToken } from '../github/client.js';
import { appBucket, installationBucket, observe, refused, type Bucket } from '../github/rate-limits.js';
import { installationRef, numericId, type InstallationRef } from '../installations/archive.js';

export type CollaboratorRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read';
export type MemberCacheTier = 'full' | 'admin';

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

/** When GitHub refused a response for its rate limit, the time it may be asked again (its reset or Retry-After, else a minute); otherwise null. */
export function rateLimitedUntil(store: Store, response: Response, bucket?: Bucket): number | null {
  const limited = response.status === 429 || response.status === 403 &&
    (response.headers.get('retry-after') !== null || response.headers.get('x-ratelimit-remaining') === '0');
  if (bucket && !limited) observe(store, bucket, response.headers, response.status);
  return limited ? refused(store, bucket, response.headers).until : null;
}

/**
 * Extracts a real collaborator's highest effective role from `/repos/{owner}/{repo}/collaborators` (#1158).
 * Unlike `/collaborators/{username}/permission` (which answers `read` for any stranger on a public repository),
 * `/collaborators` lists only actual collaborators (organization base members, teams, direct and outside collaborators).
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

interface PageRead {
  status: 'ok' | 'not_modified' | 'missing';
  items: Json[];
  etag: string | null;
}

/**
 * Synchronizes local owner and repository-collaborator caches per installation (#1158):
 * - Personal installations record `target_id`; organization installations with `Members: read` cache active owners from
 *   `GET /orgs/{org}/members?role=admin&per_page=100` (degrading cleanly when `Members: read` is absent).
 * - Started projects (`repositories`) cache all real collaborators (`affiliation=all`); installed-but-unstarted
 *   repositories cache only administrators (`?permission=admin`) for `pending_repositories` and self-start checks.
 * - Reuses one read-only installation token per installation round, revokes it before committing, sends `If-None-Match`
 *   for zero-quota `304 Not Modified` renewals, and retains the last confirmed snapshot on 5xx / network / 429 faults.
 */
export class GitHubPermissions {
  /** `limited` hears when GitHub refused a request for its rate limit, and until when. */
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com', private readonly limited: (until: number) => void = () => {}) {}

  private async send(token: string, bucket: Bucket | undefined, path: string, options: { body?: Json; ifNoneMatch?: string | null; missing?: boolean } = {}): Promise<{ status: number; data: Json | null; etag: string | null }> {
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
    if (response.status >= 500) return fail(502, 'github_verification_unavailable');
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

  private async readInstallationRepositories(token: string, bucket: Bucket, targetId: string): Promise<Map<string, { id: string; full_name: string; owner_id: string }>> {
    const repos = new Map<string, { id: string; full_name: string; owner_id: string }>();
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
        repos.set(id, { id, full_name: repo.full_name, owner_id: targetId });
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

  /**
   * Synchronizes one active `github_installations` row's owner and repository collaborator caches.
   * When `checkAll` is false, only cold, dirty, errored or tier-upgraded entries are fetched; when `checkAll` is true,
   * cached ETag conditional requests revalidate every entry in one installation-token round.
   */
  async syncInstallation(snapshot: Row, options: { checkAll?: boolean; bypassBackoff?: boolean } = {}): Promise<void> {
    const ref = String(snapshot.ref), now = Date.now();
    if (snapshot.status !== 'active' || snapshot.scope_pending || snapshot.completeness !== 'complete') return;
    const instCache = this.store.get('SELECT * FROM github_installation_member_cache WHERE installation_ref=?', ref);
    if (!options.bypassBackoff && instCache && instCache.next_retry_at > now && !instCache.dirty) return;

    const presentRepos = this.store.all(`SELECT ir.repository_id,ir.full_name,ir.owner_id,
      EXISTS(SELECT 1 FROM repositories r WHERE r.id=ir.repository_id) AS started
      FROM installation_repositories ir WHERE ir.installation_ref=? AND ir.present=1 ORDER BY ir.repository_id`, ref);
    const repoCaches = new Map<string, Row>(
      this.store.all('SELECT * FROM github_repository_member_cache WHERE installation_ref=?', ref).map(row => [String(row.repository_id), row]),
    );
    const instDirtyBefore = Number(instCache?.dirty ?? 1);
    const needOwners = Boolean(
      options.checkAll || !instCache || instCache.synced_at === null || instDirtyBefore > 0 || instCache.last_error !== null ||
      instCache.installation_revision !== snapshot.revision || instCache.target_id !== snapshot.target_id ||
      instCache.repository_selection !== snapshot.repository_selection,
    );
    const candidateRepos = presentRepos.filter(repo => {
      const id = String(repo.repository_id), cached = repoCaches.get(id), neededTier: MemberCacheTier = repo.started ? 'full' : 'admin';
      if (!options.bypassBackoff && cached && cached.next_retry_at > now && !cached.dirty && (cached.tier === 'full' || neededTier === 'admin')) return false;
      return Boolean(
        options.checkAll || !cached || cached.synced_at === null || Number(cached.dirty) > 0 || cached.last_error !== null ||
        cached.full_name !== repo.full_name || (neededTier === 'full' && cached.tier !== 'full'),
      );
    });
    if (!needOwners && !candidateRepos.length) return;

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

    const membershipReadable = target.type === 'Organization' && ['read', 'write'].includes(String((installation.permissions as Json | undefined)?.members));
    const permissions = { metadata: 'read', ...(membershipReadable ? { members: 'read' } : {}) };
    let token = '';
    try {
      const access = (await this.send(appJwt(String(snapshot.app_id), String(credentials.private_key || '')), jwtBucket,
        `/app/installations/${snapshot.installation_id}/access_tokens`, { body: { permissions } })).data;
      if (typeof access?.token !== 'string' || !access.token) {
        this.recordInstallationError(snapshot, instCache, instDirtyBefore, 'github_incomplete_evidence');
        return;
      }
      token = access.token;
    } catch (error) {
      this.recordInstallationError(snapshot, instCache, instDirtyBefore, failureCode(error));
      return;
    }

    const instBucket = installationBucket(String(account.id), String(snapshot.installation_id), String(target.login));
    let revoked = false;
    try {
      let liveRepos: Map<string, { id: string; full_name: string; owner_id: string }>;
      try {
        liveRepos = await this.readInstallationRepositories(token, instBucket, targetId);
      } catch (error) {
        await revokeInstallationToken(this.apiUrl, token).catch(() => false); revoked = true;
        this.recordInstallationError(snapshot, instCache, instDirtyBefore, failureCode(error));
        return;
      }

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
          ownersOutcome = { kind: 'updated', owners: [], etag: null, uncertain: 'membership_unreadable' };
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

      type RepoOutcome = {
        repository_id: string;
        owner_id: string;
        full_name: string;
        tier: MemberCacheTier;
        dirtyBefore: number;
        result:
          | { kind: 'not_modified'; etag: string | null }
          | { kind: 'updated'; collaborators: { id: string; login: string; role: CollaboratorRole }[]; etag: string | null }
          | { kind: 'removed' }
          | { kind: 'error'; code: string; transient: boolean };
      };
      const repoOutcomes: RepoOutcome[] = [];

      if (!rateLimitedAbort) {
        for (const repo of candidateRepos) {
          const repoId = String(repo.repository_id), cached = repoCaches.get(repoId), dirtyBefore = Number(cached?.dirty ?? 1);
          const live = liveRepos.get(repoId);
          const tier: MemberCacheTier = repo.started ? 'full' : 'admin';
          if (!live) {
            repoOutcomes.push({ repository_id: repoId, owner_id: String(repo.owner_id), full_name: String(repo.full_name), tier, dirtyBefore, result: { kind: 'removed' } });
            continue;
          }
          const reuseEtag = cached && cached.synced_at !== null && Number(cached.in_installation) === 1 && !cached.last_error && cached.tier === tier && cached.full_name === live.full_name
            ? (cached.etag as string | null) : null;
          const encodedName = live.full_name.split('/').map(encodeURIComponent).join('/');
          const path = `/repos/${encodedName}/collaborators${tier === 'admin' ? '?permission=admin' : ''}`;
          try {
            const page = await this.readPages(token, instBucket, path, reuseEtag, true);
            if (page.status === 'not_modified') {
              repoOutcomes.push({ repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, tier, dirtyBefore, result: { kind: 'not_modified', etag: page.etag } });
            } else if (page.status === 'missing') {
              repoOutcomes.push({ repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, tier, dirtyBefore, result: { kind: 'updated', collaborators: [], etag: null } });
            } else {
              // Confirm `owner/repo` still resolves to the same numeric `repository_id` and `owner_id` so a concurrent
              // rename or transfer cannot store another repository's collaborators under `repoId` (#1158).
              const meta = await this.send(token, instBucket, `/repos/${encodedName}`, { missing: true });
              if (!meta.data) {
                repoOutcomes.push({ repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, tier, dirtyBefore, result: { kind: 'updated', collaborators: [], etag: null } });
                continue;
              }
              if (numericId(meta.data.id) !== repoId || numericId((meta.data.owner as Json | undefined)?.id) !== live.owner_id) {
                fail(502, 'github_incomplete_evidence');
              }
              const collaborators: { id: string; login: string; role: CollaboratorRole }[] = [], seen = new Set<string>();
              for (const item of page.items) {
                const parsed = collaboratorRole(item);
                if (!parsed.role || tier === 'admin' && parsed.role !== 'admin') continue;
                if (!seen.has(parsed.id)) { seen.add(parsed.id); collaborators.push({ id: parsed.id, login: parsed.login, role: parsed.role }); }
              }
              repoOutcomes.push({ repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, tier, dirtyBefore, result: { kind: 'updated', collaborators, etag: page.etag } });
            }
          } catch (error) {
            const code = failureCode(error), transient = isTransientGitHubError(code);
            repoOutcomes.push({ repository_id: repoId, owner_id: live.owner_id, full_name: live.full_name, tier, dirtyBefore, result: { kind: 'error', code, transient } });
            if (code === 'github_rate_limited') { rateLimitedAbort = true; break; }
          }
        }
      }

      // Revoke the temporary read-only installation token BEFORE committing completed cache state.
      await revokeInstallationToken(this.apiUrl, token).catch(() => false);
      revoked = true;
      if (this.store.get('SELECT credentials FROM accounts WHERE id=?', account.id)?.credentials !== account.credentials) {
        this.recordInstallationError(snapshot, instCache, instDirtyBefore, 'authorization_changed');
        return;
      }

      const committedAt = Date.now();
      this.store.transaction(() => {
        const current = this.store.get('SELECT * FROM github_installations WHERE ref=?', ref);
        if (!current || current.status !== 'active' || current.scope_pending || current.completeness !== 'complete') return;

        // Clean up caches for repositories no longer marked present in installation_repositories.
        this.store.run(`DELETE FROM github_repository_collaborators WHERE installation_ref=?
          AND repository_id NOT IN (SELECT repository_id FROM installation_repositories WHERE installation_ref=? AND present=1)`, ref, ref);
        this.store.run(`DELETE FROM github_repository_member_cache WHERE installation_ref=?
          AND repository_id NOT IN (SELECT repository_id FROM installation_repositories WHERE installation_ref=? AND present=1)`, ref, ref);

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
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,0,NULL,?,?,?,0,NULL,0)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET owner_id=excluded.owner_id,full_name=excluded.full_name,
              tier=excluded.tier,in_installation=0,etag=NULL,synced_at=excluded.synced_at,checked_at=excluded.checked_at,
              dirty=excluded.dirty,failures=0,last_error=NULL,next_retry_at=0`,
              ref, outcome.repository_id, outcome.owner_id, outcome.full_name, startedNow ? 'full' : 'admin', committedAt, committedAt, nextDirty);
            continue;
          }

          if (outcome.result.kind === 'updated') {
            this.store.run('DELETE FROM github_repository_collaborators WHERE installation_ref=? AND repository_id=?', ref, outcome.repository_id);
            for (const c of outcome.result.collaborators) {
              this.store.run('INSERT INTO github_repository_collaborators VALUES(?,?,?,?,?)', ref, outcome.repository_id, c.id, c.login, c.role);
            }
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,1,?,?,?,?,0,NULL,0)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET owner_id=excluded.owner_id,full_name=excluded.full_name,
              tier=excluded.tier,in_installation=1,etag=excluded.etag,synced_at=excluded.synced_at,checked_at=excluded.checked_at,
              dirty=excluded.dirty,failures=0,last_error=NULL,next_retry_at=0`,
              ref, outcome.repository_id, outcome.owner_id, outcome.full_name, outcome.tier, outcome.result.etag, committedAt, committedAt, nextDirty);
          } else if (outcome.result.kind === 'not_modified') {
            this.store.run(`UPDATE github_repository_member_cache SET owner_id=?,full_name=?,in_installation=1,etag=COALESCE(?,etag),
              checked_at=?,dirty=?,failures=0,last_error=NULL,next_retry_at=0 WHERE installation_ref=? AND repository_id=?`,
              outcome.owner_id, outcome.full_name, outcome.result.etag, committedAt, nextDirty, ref, outcome.repository_id);
          } else {
            const failures = Number(prevRepo?.failures ?? 0) + 1;
            const retryAt = committedAt + retryDelayMs(failures - 1);
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,1,NULL,NULL,?,?,?,?,?)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET checked_at=excluded.checked_at,dirty=excluded.dirty,
              failures=excluded.failures,last_error=excluded.last_error,next_retry_at=excluded.next_retry_at`,
              ref, outcome.repository_id, outcome.owner_id, outcome.full_name, prevRepo?.tier ?? outcome.tier, committedAt, nextDirty, failures, outcome.result.code, retryAt);
          }
        }

        // Mark any non-candidate repository that vanished from GitHub's authoritative installation listing as absent.
        for (const repo of presentRepos) {
          const repoId = String(repo.repository_id);
          if (!handledRepoIds.has(repoId) && !liveRepos.has(repoId)) {
            const startedNow = !!this.store.get('SELECT 1 FROM repositories WHERE id=?', repoId);
            this.store.run('DELETE FROM github_repository_collaborators WHERE installation_ref=? AND repository_id=?', ref, repoId);
            this.store.run(`INSERT INTO github_repository_member_cache(installation_ref,repository_id,owner_id,full_name,tier,in_installation,etag,synced_at,checked_at,dirty,failures,last_error,next_retry_at)
              VALUES(?,?,?,?,?,0,NULL,?,?,0,0,NULL,0)
              ON CONFLICT(installation_ref,repository_id) DO UPDATE SET tier=excluded.tier,in_installation=0,etag=NULL,
              synced_at=excluded.synced_at,checked_at=excluded.checked_at,dirty=0,failures=0,last_error=NULL,next_retry_at=0`,
              ref, repoId, String(repo.owner_id), String(repo.full_name), startedNow ? 'full' : 'admin', committedAt, committedAt);
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
      if (!revoked && token) await revokeInstallationToken(this.apiUrl, token).catch(() => false);
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
   * disclosure in the archive). Never consults `/collaborators/{username}/permission`, so public outsiders gain no access (#1158).
   */
  async readInstallationAccess(ref: InstallationRef, userId: string): Promise<LiveInstallationAccess> {
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
    const membershipReadable = target.type === 'Organization' && ['read', 'write'].includes(String((installation.permissions as Json | undefined)?.members));
    const permissions = { metadata: 'read', ...(membershipReadable ? { members: 'read' } : {}) };
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
          const page = await this.readPages(token, instBucket, `/repos/${encodedName}/collaborators`, null, true);
          if (page.status !== 'ok') continue;
          const meta = await this.send(token, instBucket, `/repos/${encodedName}`, { missing: true });
          if (!meta.data || numericId(meta.data.id) !== id || numericId((meta.data.owner as Json | undefined)?.id) !== repo.owner_id) continue;
          for (const item of page.items) {
            const parsed = collaboratorRole(item);
            if (parsed.id !== userId || !parsed.role) continue;
            repositoryIds.push(id);
            if (parsed.role === 'admin') adminIds.push(id);
            break;
          }
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
