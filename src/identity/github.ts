import { createHash, randomBytes } from 'node:crypto';
import type { Store, Row } from '../storage/database.js';
import { digest, fail, randomId, HttpError, type Json } from '../core/security.js';
import { installationRef, numericId, type InstallationIdentity, type InstallationRef, type VerifiedInstallationAccess } from '../installations/archive.js';
import { activeScopes, invalidateIfLost, listEffectiveScopes, resolveActor, revision } from './authorization.js';
import {
  identityProjection,
  markInstallationMemberCacheDirty,
  markRepositoryMemberCacheDirty,
  memberCapabilities,
  projectCapabilities,
  readerCapabilities,
  tenantId,
} from './storage.js';
import {
  boundGitHubUsers,
  failureCode as errorCode,
  GitHubPermissions,
  isTransientGitHubError,
  rateLimitedUntil,
  repositoryNeedsBoundUserRole,
} from './github-permissions.js';

// What made the latest permission check uncertain, kept on the identity for diagnosis; null once everything was settled.
const issues = (list: { installation: string | null; code: string }[]): string | null => list.length ? JSON.stringify(list) : null;

// A write or Feishu turn whose proof is pending does not repeat a check that failed this recently.
const retryPause = 60_000;

/**
 * Platform super administrators and principals holding explicit delegation are never verified on GitHub (#708): their
 * access does not depend on it, and they receive no GitHub-derived grants. A project administrator's delegation (#847) is
 * not that kind: it adds to what GitHub gives its holder, so they keep being checked.
 */
export function verificationExempt(store: Store, principal: string): boolean {
  return !!store.get("SELECT 1 FROM principals p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.role='super_admin'", principal) ||
    !!store.get(`SELECT 1 FROM scoped_grants WHERE principal_id=? AND source='explicit_delegation' AND policy<>'project_delegation' AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>?) LIMIT 1`, principal, Date.now());
}

/** Whether every active installation and present repository has completed its initial local member-cache sync (#1158). */
export function memberCacheWarm(store: Store, principal?: string): boolean {
  if (!store.hasTable('github_installation_member_cache')) return false;
  const users = boundGitHubUsers(store, principal);
  const installations = store.all(`SELECT * FROM github_installations
    WHERE github_host='github.com' AND status='active' AND scope_pending=0 AND completeness='complete'`);
  for (const snapshot of installations) {
    const ref = String(snapshot.ref);
    const cache = store.get('SELECT * FROM github_installation_member_cache WHERE installation_ref=?', ref);
    if (!cache || cache.synced_at === null || cache.target_id !== snapshot.target_id ||
      cache.repository_selection !== snapshot.repository_selection || cache.installation_revision !== snapshot.revision) return false;
    if (cache.last_error && !isTransientGitHubError(String(cache.last_error))) return false;
    const repos = store.all(`SELECT ir.repository_id,ir.full_name,EXISTS(SELECT 1 FROM repositories r WHERE r.id=ir.repository_id) AS started
      FROM installation_repositories ir WHERE ir.installation_ref=? AND ir.present=1`, ref);
    const repoCaches = new Map<string, Row>(
      store.all('SELECT * FROM github_repository_member_cache WHERE installation_ref=?', ref).map(r => [String(r.repository_id), r]),
    );
    for (const repo of repos) {
      const repoId = String(repo.repository_id), rc = repoCaches.get(repoId);
      if (!rc || rc.synced_at === null || rc.full_name !== repo.full_name ||
        (rc.last_error !== null && !isTransientGitHubError(String(rc.last_error))) ||
        (repo.started && rc.tier !== 'full') ||
        repositoryNeedsBoundUserRole(store, ref, repoId, rc, users)) return false;
    }
  }
  return true;
}

function installationsNeedingMemberSync(store: Store, now = Date.now(), options: { refs?: ReadonlySet<string>; checkAll?: boolean; bypassBackoff?: boolean; principal?: string } = {}): Row[] {
  if (!store.hasTable('github_installation_member_cache')) return [];
  const users = boundGitHubUsers(store, options.principal);
  const snapshots = store.all(`SELECT * FROM github_installations
    WHERE github_host='github.com' AND status='active' AND scope_pending=0 AND completeness='complete' ORDER BY ref`);
  return snapshots.filter(snapshot => {
    const ref = String(snapshot.ref);
    if (options.refs && !options.refs.has(ref)) return false;
    if (options.checkAll) return true;
    const cache = store.get('SELECT * FROM github_installation_member_cache WHERE installation_ref=?', ref);
    if (!cache || cache.synced_at === null || cache.target_id !== snapshot.target_id ||
      cache.repository_selection !== snapshot.repository_selection || cache.installation_revision !== snapshot.revision) {
      return Boolean(options.bypassBackoff || !cache || cache.next_retry_at <= now || Number(cache.dirty) > 0);
    }
    if (Number(cache.dirty) > 0) return true;
    if (cache.last_error && (options.bypassBackoff || cache.next_retry_at <= now)) return true;
    const repos = store.all(`SELECT ir.repository_id,ir.full_name,EXISTS(SELECT 1 FROM repositories r WHERE r.id=ir.repository_id) AS started
      FROM installation_repositories ir WHERE ir.installation_ref=? AND ir.present=1`, ref);
    const repoCaches = new Map<string, Row>(
      store.all('SELECT * FROM github_repository_member_cache WHERE installation_ref=?', ref).map(r => [String(r.repository_id), r]),
    );
    return repos.some(repo => {
      const repoId = String(repo.repository_id), rc = repoCaches.get(repoId);
      if (!rc || rc.synced_at === null || Number(rc.dirty) > 0 || rc.full_name !== repo.full_name ||
        (repo.started && rc.tier !== 'full') ||
        repositoryNeedsBoundUserRole(store, ref, repoId, rc, users)) return true;
      return Boolean(rc.last_error !== null && (options.bypassBackoff || rc.next_retry_at <= now));
    });
  });
}

// Check failures that only a new GitHub sign-in mends: GitHub refused the stored authorization, or it now names someone else.
const reauthorization = ['github_reauthorization_required', 'github_oauth_failed', 'github_identity_mismatch'];

/**
 * Where a principal's GitHub proof stands, for replies outside the console (#846, #1158), or null without a GitHub identity.
 * `reauthorize`: only a new GitHub sign-in proves it again (the authorization was revoked, dropped when the login
 * configuration changed, or refused by GitHub). `pending`: the identity or its derived grants wait on verification or an
 * initial member-cache sync. `checked`: local member caches are settled, so missing grants mean GitHub gives no authority there.
 */
export function githubProof(store: Store, principal: string): { state: 'reauthorize' | 'pending' | 'checked'; login: string } | null {
  const identity = store.get(`SELECT status,credentials IS NULL missing,display_name,verified_at,verification_issues FROM external_identities
    WHERE principal_id=? AND provider='github' ORDER BY status='revoked',verified_at DESC LIMIT 1`, principal);
  if (!identity) return null;
  const codes = (JSON.parse(identity.verification_issues ?? '[]') as { code: string }[]).map(issue => issue.code);
  if (identity.status === 'revoked' || identity.missing || identity.status === 'pending_verification' && codes.some(code => reauthorization.includes(code))) {
    return { state: 'reauthorize', login: String(identity.display_name) };
  }
  const hasPendingGrant = listEffectiveScopes(store, principal).some(g => g.source === 'github_derived' && g.state === 'pending_verification');
  const state = identity.status === 'pending_verification' || hasPendingGrant || !memberCacheWarm(store, principal) ? 'pending' : 'checked';
  return { state, login: String(identity.display_name) };
}

interface SyncWaiter {
  mode: 'dirty' | 'all';
  bypassBackoff: boolean;
}

export interface GitHubOAuthConfig { clientId: string; clientSecret: string; redirectUri: string; apiUrl?: string; webUrl?: string; applicationType?: 'oauth_app' | 'github_app' }
export class GitHubIdentity implements InstallationIdentity {
  private refreshing = new Map<string, Promise<void>>();
  // When each principal's latest check ended, for the pause after a failed one.
  private finished = new Map<string, number>();
  // How far the cold-start or manual check in flight has come, for the console's progress line.
  private progress = new Map<string, { checked: number; total: number }>();
  private tokens = new Map<string, Promise<string>>();
  // Single-flight per installation_ref so concurrent logins, webhooks and periodic refreshes share one GitHub pass (#1158).
  private syncingInstallations = new Map<string, Promise<void>>();
  private queuedInstallationSync = new Map<string, SyncWaiter>();
  private scheduledSyncs = new Set<Promise<void>>();
  private closed = false;
  /** Until when GitHub asked this deployment to stop sending, as reported by the latest rate-limited response; the background refresh waits for it. */
  rateLimitedUntil = 0;
  private limited = (until: number) => { this.rateLimitedUntil = Math.max(this.rateLimitedUntil, until); };

  constructor(readonly store: Store, readonly config: GitHubOAuthConfig, private readonly assertConfiguration: () => void = () => {}) {
    const redirect = new URL(config.redirectUri);
    if (redirect.pathname !== '/auth/github/callback' || redirect.search || redirect.hash ||
      redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname))) throw new Error('invalid_oauth_redirect');
  }

  begin(browser: string, mode: 'login' | 'bind', sessionRef = '', setupState: string | null = null): { url: string } {
    this.assertConfiguration();
    if (!browser) return fail(400, 'oauth_browser_required');
    const principal = mode === 'bind' ? resolveActor(this.store, sessionRef).principal_id : null;
    const state = randomId(), verifier = randomBytes(32).toString('base64url');
    this.store.run('DELETE FROM github_oauth_states WHERE expires_at<?', Date.now());
    this.store.run('INSERT INTO github_oauth_states VALUES(?,?,?,?,?,?,?,NULL,?)', digest(state), digest(browser), mode === 'bind' ? digest(sessionRef) : null,
      principal, this.store.secrets.seal({ verifier }, `oauth:${digest(state)}`), mode, Date.now() + 10 * 60_000, setupState);
    const url = new URL('/login/oauth/authorize', this.config.webUrl || 'https://github.com');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: '' }).toString();
    return { url: url.toString() };
  }

  sessionReference(sessionRef: string): string {
    resolveActor(this.store, sessionRef);
    return this.store.secrets.seal({ session_ref: sessionRef }, 'installation-identity-session');
  }

  private async exchange(values: Record<string, string>): Promise<Json> {
    let response: Response;
    try { response = await fetch(new URL('/login/oauth/access_token', this.config.webUrl || 'https://github.com'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...values }) }); }
    catch { return fail(502, 'github_oauth_unavailable'); }
    let token: Json; try { token = await response.json() as Json; } catch { return fail(502, 'github_oauth_failed'); }
    if (!response.ok || typeof token.access_token !== 'string' || !token.access_token || token.error) return fail(401, 'github_oauth_failed');
    // An OAuth App previously authorized with broader scopes may retain them. Never accept that token for identity-only login.
    if (this.config.applicationType !== 'github_app' && (typeof token.scope !== 'string' || token.scope.trim())) return fail(403, 'github_oauth_excessive_scope');
    return token;
  }

  private async api(token: string, path: string): Promise<Json> {
    let response: Response;
    try { response = await fetch(new URL(path, this.config.apiUrl || 'https://api.github.com'), { redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }); }
    catch { return fail(502, 'github_verification_unavailable'); }
    const limit = rateLimitedUntil(this.store, response);
    if (limit) { this.limited(limit); return fail(429, 'github_rate_limited'); }
    if (!response.ok) return fail(response.status === 401 ? 401 : 403, response.status === 401 ? 'github_reauthorization_required' : 'github_permission_pending');
    try { return await response.json() as Json; } catch { return fail(502, 'github_verification_unavailable'); }
  }

  private saveToken(id: string, token: Json, now = Date.now()): void {
    this.store.run(`UPDATE external_identities SET credentials=?,expires_at=?,refresh_expires_at=?,status='active',verified_at=? WHERE id=?`,
      this.store.secrets.seal(token, `identity:${id}`), Number.isFinite(Number(token.expires_in)) ? now + Number(token.expires_in) * 1000 : null,
      Number.isFinite(Number(token.refresh_token_expires_in)) ? now + Number(token.refresh_token_expires_in) * 1000 : null, now, id);
  }

  /**
   * Signing in exchanges the OAuth code, verifies `/user`, and immediately derives `scoped_grants` from the local member
   * cache when warm (#1158) — no per-installation serial crawl. When an installation or started repository has not yet
   * finished its initial cache sync (cold start), a single-flight background sync runs and updates grants once settled.
   */
  async callback(browser: string, state: string, code: string, sessionRef = ''): Promise<{ principal_id: string; identity_id: string; setup_state: string | null; verification: Promise<void> }> {
    const row = this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM github_oauth_states WHERE state_hash=?', digest(state));
      if (!row || row.browser_hash !== digest(browser) || row.expires_at <= Date.now() || row.consumed_at) return fail(400, 'invalid_oauth_state');
      if (row.mode === 'bind' && (row.session_hash !== digest(sessionRef) || resolveActor(this.store, sessionRef).principal_id !== row.principal_id)) return fail(403, 'oauth_session_mismatch');
      this.store.run('UPDATE github_oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL', Date.now(), digest(state)); return row;
    });
    if (!code || code.length > 2048) return fail(400, 'github_oauth_denied');
    const token = await this.exchange({ code, redirect_uri: this.config.redirectUri, code_verifier: String(this.store.secrets.open(row.verifier, `oauth:${digest(state)}`).verifier) });
    const user = await this.api(String(token.access_token), '/user'), userId = numericId(user.id);
    if (!userId || typeof user.login !== 'string') return fail(502, 'github_invalid_user');
    const login = user.login, now = Date.now();
    const result = this.store.transaction(() => {
      this.assertConfiguration();
      if (row.mode === 'bind' && resolveActor(this.store, sessionRef).principal_id !== row.principal_id) return fail(403, 'oauth_session_mismatch');
      const previous = this.store.get("SELECT * FROM external_identities WHERE provider='github' AND host='github.com' AND external_actor=?", userId);
      if (previous && row.mode === 'bind' && previous.principal_id !== row.principal_id) return fail(409, 'external_identity_conflict');
      const principal = previous?.principal_id || row.principal_id || randomId(), id = previous?.id || randomId();
      if (this.store.get("SELECT 1 FROM external_identities WHERE principal_id=? AND provider='github' AND status<>'revoked' AND id<>?", principal, id)) return fail(409, 'github_identity_already_bound');
      if (!previous && !row.principal_id) {
        // An opaque local name prevents collisions. GitHub login and email never merge local accounts.
        this.store.run("INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,'project_admin')", principal, `github:${userId}:${principal.slice(0, 8)}`, '!external-only');
      }
      if (!this.store.get('SELECT 1 FROM users WHERE id=? AND active=1', principal)) return fail(403, 'user_disabled');
      if (!previous) this.store.run(`INSERT INTO external_identities(id,principal_id,provider,host,connector,external_tenant,external_actor,display_name,status,verified_at)
        VALUES(?,?,'github','github.com','','',?,?,'active',?)`, id, principal, userId, login, now);
      else this.store.run('UPDATE external_identities SET display_name=?,verification_issues=NULL WHERE id=?', login, id);
      this.saveToken(id, token, now); this.store.audit(principal, 'github.authorized', id);

      if (verificationExempt(this.store, principal)) {
        this.dropDerived(principal);
        return { principal_id: principal, identity_id: id, setup_state: row.setup_state as string | null, warm: true };
      }
      const warm = !this.refreshing.has(principal) && memberCacheWarm(this.store, principal) && !installationsNeedingMemberSync(this.store, now, { principal }).length;
      if (warm) {
        this.reconcilePrincipalInTransaction(principal, { login, verifiedAt: now, fromUserCheck: true });
      }
      return { principal_id: principal, identity_id: id, setup_state: row.setup_state as string | null, warm };
    });

    if (result.warm) {
      return { principal_id: result.principal_id, identity_id: result.identity_id, setup_state: result.setup_state, verification: Promise.resolve() };
    }
    return {
      principal_id: result.principal_id,
      identity_id: result.identity_id,
      setup_state: result.setup_state,
      verification: this.finishSignInSync(result.principal_id, login, now).catch(() => {}),
    };
  }

  // Runs only when an installation's member cache is cold/dirty at sign-in, or an earlier check was still in flight.
  private finishSignInSync(principal: string, login: string, verifiedAt: number): Promise<void> {
    const previous = this.refreshing.get(principal);
    const promise = (async () => {
      if (previous) await previous.catch(() => {});
      if (verificationExempt(this.store, principal)) { this.dropDerived(principal); return; }
      const pending = installationsNeedingMemberSync(this.store, Date.now());
      if (pending.length && this.rateLimitedUntil <= Date.now()) {
        const progress = { checked: 0, total: pending.length };
        this.progress.set(principal, progress);
        await this.syncMemberCache({
          refs: pending.map(s => String(s.ref)),
          onProgress: (checked, total) => { progress.checked = checked; progress.total = total; },
        });
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        if (this.commitPrincipalReconcile(principal, { login, verifiedAt, fromUserCheck: true }) === 'done') return;
      }
    })().finally(() => {
      this.finished.set(principal, Date.now());
      if (this.refreshing.get(principal) === promise) { this.refreshing.delete(principal); this.progress.delete(principal); }
    });
    this.refreshing.set(principal, promise);
    return promise;
  }

  private token(identity: Row): Promise<string> {
    const existing = this.tokens.get(identity.id); if (existing) return existing;
    const promise = (async () => {
      const secret = this.store.secrets.open(identity.credentials, `identity:${identity.id}`);
      if (identity.expires_at !== null && identity.expires_at <= Date.now() + 60_000) {
        if (!secret.refresh_token || identity.refresh_expires_at && identity.refresh_expires_at <= Date.now()) return fail(401, 'github_reauthorization_required');
        const fresh = await this.exchange({ grant_type: 'refresh_token', refresh_token: String(secret.refresh_token) });
        this.assertConfiguration();
        // Unlinking during the network request must not restore a revoked identity.
        if (!this.store.get("SELECT 1 FROM external_identities WHERE id=? AND status='active' AND credentials=?", identity.id, identity.credentials)) return fail(409, 'authorization_changed');
        this.saveToken(identity.id, fresh); return String(fresh.access_token);
      }
      return String(secret.access_token);
    })().finally(() => this.tokens.delete(identity.id)); this.tokens.set(identity.id, promise); return promise;
  }

  /** Reconciles one principal's derived grants synchronously from the local member cache when warm (#1158). */
  syncPrincipalFromCache(principal: string): void {
    if (verificationExempt(this.store, principal)) { this.dropDerived(principal); return; }
    if (!memberCacheWarm(this.store, principal)) return;
    const identity = this.store.get("SELECT status,credentials FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", principal);
    if (!identity?.credentials) return;
    this.commitPrincipalReconcile(principal, { fromUserCheck: false });
  }

  /** Triggers asynchronous single-flight member-cache synchronization for dirty or cold installations (#1158). */
  scheduleMemberSync(refs?: Iterable<string>): void {
    if (this.closed) return;
    const list = refs ? [...new Set(refs)].filter(Boolean) : undefined;
    if (list && !list.length) return;
    const task = this.syncMemberCache({ refs: list, shouldStop: () => this.closed }).catch(error => {
      if (this.closed || (error as { code?: string })?.code === 'ERR_INVALID_STATE') return;
      console.error('[github-member-cache] sync failed:', error);
    }).finally(() => this.scheduledSyncs.delete(task));
    this.scheduledSyncs.add(task);
  }

  /** Marks a newly activated or modified repository's member cache dirty and schedules a single-flight refresh (#1158). */
  scheduleRepositoryMemberSync(repositoryId: string): void {
    if (this.closed) return;
    const refs = markRepositoryMemberCacheDirty(this.store, repositoryId);
    if (refs.length) this.scheduleMemberSync(refs);
  }

  close(): void {
    this.closed = true;
  }

  async drain(): Promise<void> {
    while (this.scheduledSyncs.size || this.syncingInstallations.size || this.refreshing.size) {
      await Promise.allSettled([...this.scheduledSyncs, ...this.syncingInstallations.values(), ...this.refreshing.values()]);
    }
  }

  /**
   * Synchronizes local installation-owner and repository-collaborator caches (single-flight per installation), then
   * recomputes `scoped_grants` for every bound GitHub principal and revokes any stale or pre-upgrade outsider grants (#1158).
   */
  async syncMemberCache(options: {
    refs?: Iterable<string>;
    checkAll?: boolean;
    bypassBackoff?: boolean;
    staggerMs?: number;
    concurrency?: number;
    shouldStop?: () => boolean;
    onProgress?: (checked: number, total: number) => void;
  } = {}): Promise<void> {
    const now = Date.now();
    if (this.closed || options.shouldStop?.()) return;
    if (this.rateLimitedUntil > now) {
      this.reconcileAllGrants();
      return;
    }
    const filter = options.refs ? new Set([...options.refs].filter(Boolean)) : undefined;
    const targets = installationsNeedingMemberSync(this.store, now, {
      refs: filter,
      checkAll: options.checkAll,
      bypassBackoff: options.bypassBackoff,
    });
    const mode: 'dirty' | 'all' = options.checkAll ? 'all' : 'dirty';
    const total = targets.length;
    let checked = 0;
    options.onProgress?.(0, total);

    if (total > 0) {
      const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, total));
      const stagger = options.staggerMs ?? 0;
      let nextIndex = 0, nextSlot = Date.now();
      const worker = async () => {
        while (nextIndex < targets.length) {
          const snapshot = targets[nextIndex++]!;
          if (stagger > 0) {
            const at = Math.max(Date.now(), nextSlot);
            nextSlot = at + stagger;
            if (at > Date.now()) await new Promise(resolve => setTimeout(resolve, at - Date.now()));
          }
          if (options.shouldStop?.() || this.rateLimitedUntil > Date.now()) break;
          await this.runSingleFlightInstallationSync(String(snapshot.ref), mode, !!options.bypassBackoff);
          checked++;
          options.onProgress?.(checked, total);
          if (this.rateLimitedUntil > Date.now()) break;
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
    }
    if (this.closed || options.shouldStop?.()) return;
    this.reconcileAllGrants();
  }

  private runSingleFlightInstallationSync(ref: string, mode: 'dirty' | 'all', bypassBackoff: boolean): Promise<void> {
    const existing = this.syncingInstallations.get(ref);
    if (existing) {
      const queued = this.queuedInstallationSync.get(ref);
      this.queuedInstallationSync.set(ref, {
        mode: queued?.mode === 'all' || mode === 'all' ? 'all' : 'dirty',
        bypassBackoff: Boolean(queued?.bypassBackoff || bypassBackoff),
      });
      return existing;
    }
    const run = (async () => {
      let nextMode: 'dirty' | 'all' | undefined = mode;
      let nextBypass = bypassBackoff;
      for (let pass = 0; pass < 3 && nextMode && this.rateLimitedUntil <= Date.now(); pass++) {
        const currentMode = nextMode, currentBypass = nextBypass;
        nextMode = undefined; nextBypass = false;
        const snapshot = this.store.get('SELECT * FROM github_installations WHERE ref=?', ref);
        if (!snapshot || snapshot.status !== 'active' || snapshot.scope_pending || snapshot.completeness !== 'complete') break;
        const permissions = new GitHubPermissions(this.store, this.config.apiUrl, this.limited);
        await permissions.syncInstallation(snapshot, { checkAll: currentMode === 'all', bypassBackoff: currentBypass });
        const queued = this.queuedInstallationSync.get(ref);
        this.queuedInstallationSync.delete(ref);
        if (queued) {
          nextMode = queued.mode;
          nextBypass = queued.bypassBackoff;
        } else if (this.rateLimitedUntil <= Date.now()) {
          const dirty = this.store.get(`SELECT 1 FROM github_installation_member_cache WHERE installation_ref=? AND dirty>0
            UNION ALL SELECT 1 FROM github_repository_member_cache WHERE installation_ref=? AND dirty>0 LIMIT 1`, ref, ref);
          if (dirty) nextMode = 'dirty';
        }
      }
    })().finally(() => {
      this.syncingInstallations.delete(ref);
      this.queuedInstallationSync.delete(ref);
    });
    this.syncingInstallations.set(ref, run);
    return run;
  }

  /** Reconciles `github_derived` grants for all GitHub identities and cleans up any leftover / pre-upgrade outsider grants. */
  reconcileAllGrants(): void {
    const principals = new Set<string>([
      ...this.store.all("SELECT DISTINCT principal_id FROM external_identities WHERE provider='github'").map(r => String(r.principal_id)),
      ...this.store.all("SELECT DISTINCT principal_id FROM scoped_grants WHERE source='github_derived' AND revoked_at IS NULL").map(r => String(r.principal_id)),
    ]);
    // Remove cached members of confirmed deleted or suspended installations so stale snapshots never linger.
    for (const gone of this.store.all("SELECT ref FROM github_installations WHERE status IN ('deleted','suspended')")) {
      this.store.run('DELETE FROM github_installation_owners WHERE installation_ref=?', gone.ref);
      this.store.run('DELETE FROM github_installation_member_cache WHERE installation_ref=?', gone.ref);
      this.store.run('DELETE FROM github_repository_collaborators WHERE installation_ref=?', gone.ref);
      if (this.store.hasTable('github_repository_assignees')) this.store.run('DELETE FROM github_repository_assignees WHERE installation_ref=?', gone.ref);
      this.store.run('DELETE FROM github_repository_member_cache WHERE installation_ref=?', gone.ref);
    }
    for (const principal of principals) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.commitPrincipalReconcile(principal, { fromUserCheck: false }) === 'done') break;
      }
    }
  }

  refresh(principal: string): Promise<void> {
    const previous = this.refreshing.get(principal);
    const promise = (async () => {
      if (previous) await previous.catch(() => {});
      for (let attempt = 0; attempt < 5; attempt++) if (await this.verifyPermissions(principal, false) === 'done') return;
    })().finally(() => {
      this.finished.set(principal, Date.now());
      if (this.refreshing.get(principal) === promise) { this.refreshing.delete(principal); this.progress.delete(principal); }
    });
    this.refreshing.set(principal, promise); return promise;
  }

  /** While a cold-start or manual permission check runs: how many installations it has checked so far. */
  verification(principal: string): { checked: number; total: number } | null {
    return this.refreshing.has(principal) ? { ...(this.progress.get(principal) ?? { checked: 0, total: 0 }) } : null;
  }

  /**
   * Joins a check already in flight, else starts one. Used when a principal's identity or derived grants were left
   * pending verification (for example after a login configuration update, a cold start, or an invalidated grant).
   */
  renew(principal: string): Promise<void> {
    const inflight = this.refreshing.get(principal); if (inflight) return inflight;
    if (!verificationExempt(this.store, principal))
      this.store.run("UPDATE external_identities SET status='active' WHERE principal_id=? AND provider='github' AND status='pending_verification' AND credentials IS NOT NULL", principal);
    return this.refresh(principal);
  }

  /**
   * Daily writes and Feishu turns read valid cached grants directly without hitting GitHub (#1158). Only when the
   * principal's identity/grants are pending verification or the member cache is still cold does it reconcile once.
   */
  async renewIfLapsed(principal: string): Promise<boolean> {
    if (!this.lapsed(principal)) return false;
    await this.renew(principal); return true;
  }

  /** Whether `renewIfLapsed` needs to reconcile now (or join an in-flight check). False in normal warm-cache operation (#1158). */
  lapsed(principal: string): boolean {
    if (verificationExempt(this.store, principal)) return false;
    const identity = this.store.get(`SELECT status,verified_at FROM external_identities WHERE principal_id=? AND provider='github'
      AND status IN ('active','pending_verification') AND credentials IS NOT NULL`, principal), now = Date.now();
    if (!identity) return false;
    if (this.refreshing.has(principal)) return true;
    const hasExpiredGrant = !!this.store.get(`SELECT 1 FROM scoped_grants WHERE principal_id=? AND source='github_derived'
      AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at<=?
      AND (expires_at=0 OR ?<=?) LIMIT 1`, principal, now, Number(identity.verified_at), now - 30 * 60_000);
    const coldCache = !memberCacheWarm(this.store, principal) && installationsNeedingMemberSync(this.store, now, { principal }).length > 0;
    if (identity.status === 'active' && !hasExpiredGrant && !coldCache) return false;
    if (this.rateLimitedUntil > now) return false;
    if (identity.status !== 'active' && now - (this.finished.get(principal) ?? 0) < retryPause) return false;
    return true;
  }

  private async verifyPermissions(principal: string, checkAll: boolean): Promise<'done' | 'retry'> {
    if (verificationExempt(this.store, principal)) { this.dropDerived(principal); return 'done'; }
    const identity = this.store.get("SELECT * FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", principal);
    if (!identity?.credentials) return 'done';
    const startRevision = revision(this.store, principal);
    if (!startRevision) return 'done';
    try {
      const token = await this.token(identity), current = await this.api(token, '/user');
      if (numericId(current.id) !== identity.external_actor || typeof current.login !== 'string' || !current.login) return fail(403, 'github_identity_mismatch');
      const now = Date.now();
      const targets = installationsNeedingMemberSync(this.store, now, { checkAll, bypassBackoff: checkAll });
      if (targets.length && this.rateLimitedUntil <= now) {
        const progress = { checked: 0, total: targets.length };
        this.progress.set(principal, progress);
        await this.syncMemberCache({
          refs: targets.map(s => String(s.ref)),
          checkAll,
          bypassBackoff: checkAll,
          onProgress: (checked, total) => { progress.checked = checked; progress.total = total; },
        });
      }
      return this.commitPrincipalReconcile(principal, {
        login: String(current.login),
        verifiedAt: Date.now(),
        fromUserCheck: true,
        expectedRevision: startRevision,
        expectedIdentityId: String(identity.id),
      });
    } catch (error) {
      let committed = false;
      this.store.transaction(() => {
        if (revision(this.store, principal) !== startRevision || !this.store.get("SELECT 1 FROM external_identities WHERE id=? AND status='active'", identity.id)) return;
        if (errorCode(error) === 'github_rate_limited') {
          this.store.run('UPDATE external_identities SET verification_issues=? WHERE id=?', issues([{ installation: null, code: errorCode(error) }]), identity.id);
          committed = true; return;
        }
        const before = activeScopes(this.store, principal), failed = Date.now();
        this.store.run("UPDATE external_identities SET status='pending_verification',verification_issues=? WHERE id=?", issues([{ installation: null, code: errorCode(error) }]), identity.id);
        this.store.run("UPDATE scoped_grants SET expires_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)", failed, principal, failed);
        invalidateIfLost(this.store, principal, before, 'github.verification_pending');
        committed = true;
      });
      return committed ? 'done' : 'retry';
    }
  }

  private commitPrincipalReconcile(principal: string, options: {
    login?: string;
    verifiedAt?: number;
    fromUserCheck: boolean;
    expectedRevision?: number;
    expectedIdentityId?: string;
  }): 'done' | 'retry' {
    try {
      this.store.transaction(() => {
        if (options.fromUserCheck) this.assertConfiguration();
        if (options.expectedRevision !== undefined && revision(this.store, principal) !== options.expectedRevision) fail(409, 'authorization_changed');
        if (options.expectedIdentityId && !this.store.get("SELECT 1 FROM external_identities WHERE id=? AND status='active'", options.expectedIdentityId)) fail(409, 'authorization_changed');
        this.reconcilePrincipalInTransaction(principal, options);
      });
      return 'done';
    } catch (error) {
      if (error instanceof HttpError && error.code === 'authorization_changed') return 'retry';
      throw error;
    }
  }

  private reconcilePrincipalInTransaction(principal: string, options: { login?: string; verifiedAt?: number; fromUserCheck: boolean }): void {
    const now = Date.now();
    if (verificationExempt(this.store, principal)) {
      const before = activeScopes(this.store, principal);
      this.store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", now, principal);
      if (options.login) this.store.run("UPDATE external_identities SET display_name=?,verification_issues=NULL WHERE principal_id=? AND provider='github' AND status<>'revoked'", options.login, principal);
      invalidateIfLost(this.store, principal, before, 'github.verification_exempt');
      return;
    }

    const identity = this.store.get(`SELECT * FROM external_identities
      WHERE principal_id=? AND provider='github' AND host='github.com'
      ORDER BY status='revoked',verified_at DESC LIMIT 1`, principal);
    if (!identity) {
      const before = activeScopes(this.store, principal);
      this.store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", now, principal);
      invalidateIfLost(this.store, principal, before, 'github.permissions_changed');
      return;
    }
    if (identity.status === 'revoked') {
      const before = activeScopes(this.store, principal);
      this.store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", now, principal);
      invalidateIfLost(this.store, principal, before, 'github.authorization_revoked');
      return;
    }
    if (!identity.credentials) {
      const before = activeScopes(this.store, principal);
      this.store.run("UPDATE scoped_grants SET expires_at=0 WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", principal);
      invalidateIfLost(this.store, principal, before, 'github.login_configuration_changed');
      return;
    }

    const prevIssues = (() => {
      try { return JSON.parse(identity.verification_issues ?? '[]') as { installation: string | null; code: string }[]; }
      catch { return []; }
    })();
    const identityLevelPending = !options.fromUserCheck && identity.status === 'pending_verification' &&
      (!prevIssues.length || prevIssues.some(item => item.installation === null));

    const userId = String(identity.external_actor);
    let detectedLogin: string | undefined;
    const desired: { id: string; tenant: string; project: string | null; role: string; capabilities: string[]; installation: Row; evidence: string; checkedAt: number }[] = [];
    const uncertainInstallations = new Map<string, string>();
    const preservedInstallations = new Set<string>();
    const uncertainRepos = new Map<string, string>();
    const preservedRepos = new Set<string>();
    const diagnosticIssues: { installation: string | null; code: string }[] = [];
    let rateLimitedSeen = false;

    const addIssue = (installation: string | null, code: string) => {
      if (!diagnosticIssues.some(item => item.installation === installation && item.code === code)) {
        diagnosticIssues.push({ installation, code });
      }
    };

    const snapshots = this.store.all("SELECT * FROM github_installations WHERE github_host='github.com'");
    for (const snapshot of snapshots) {
      const ref = String(snapshot.ref);
      if (snapshot.status === 'deleted' || snapshot.status === 'suspended') continue;
      const pending = snapshot.status !== 'active' ? `installation_${snapshot.status}` : snapshot.scope_pending ? 'installation_scope_pending'
        : snapshot.completeness !== 'complete' ? 'installation_incomplete' : null;
      if (pending) {
        uncertainInstallations.set(ref, pending);
        addIssue(ref, pending);
        continue;
      }

      const instCache = this.store.get('SELECT * FROM github_installation_member_cache WHERE installation_ref=?', ref);
      const instHardError = instCache?.last_error && !isTransientGitHubError(String(instCache.last_error)) ? String(instCache.last_error) : null;
      const instConfirmed = Boolean(
        instCache && instCache.synced_at !== null &&
        instCache.target_id === snapshot.target_id && instCache.repository_selection === snapshot.repository_selection &&
        instCache.installation_revision === snapshot.revision && !instHardError,
      );

      if (!instConfirmed || !instCache) {
        // If only installation_revision advanced (before member-cache sync caught up), keep existing grant expiry untouched
        // so listEffectiveScopes reports `installation_pending`.
        const revisionMovedOnly = Boolean(
          instCache && instCache.synced_at !== null && !instHardError &&
          instCache.target_id === snapshot.target_id && instCache.repository_selection === snapshot.repository_selection &&
          instCache.installation_revision !== snapshot.revision,
        );
        const code = instHardError || (instCache?.last_error ? String(instCache.last_error) : revisionMovedOnly ? 'installation_pending' : 'member_cache_pending');
        uncertainInstallations.set(ref, code);
        addIssue(ref, code);
        if (revisionMovedOnly || instCache?.last_error && isTransientGitHubError(String(instCache.last_error))) {
          preservedInstallations.add(ref);
        }
        if (instCache?.last_error === 'github_rate_limited') rateLimitedSeen = true;
        continue;
      }

      if (instCache.last_error && isTransientGitHubError(String(instCache.last_error))) {
        addIssue(ref, String(instCache.last_error));
        if (instCache.last_error === 'github_rate_limited') rateLimitedSeen = true;
      }
      if (instCache.owners_uncertain) {
        addIssue(ref, String(instCache.owners_uncertain));
      }

      const ownerRow = this.store.get('SELECT login FROM github_installation_owners WHERE installation_ref=? AND github_user_id=?', ref, userId);
      const isOwner = !!ownerRow;
      if (ownerRow?.login && !detectedLogin) detectedLogin = String(ownerRow.login);

      const knownRepos = this.store.all(`SELECT ir.repository_id,EXISTS(SELECT 1 FROM repositories r WHERE r.id=ir.repository_id) AS started
        FROM installation_repositories ir WHERE ir.installation_ref=? AND ir.present=1`, ref);
      const repoCaches = new Map<string, Row>(
        this.store.all('SELECT * FROM github_repository_member_cache WHERE installation_ref=?', ref).map(r => [String(r.repository_id), r]),
      );
      const tenant = tenantId(String(snapshot.target_id));
      const ownerEvidence = snapshot.target_type === 'User' ? 'personal_owner' : 'organization_owner';

      if (isOwner) {
        if (snapshot.repository_selection === 'all' && snapshot.target_type === 'Organization') {
          desired.push({ id: `github:${principal}:${ref}:tenant`, tenant, project: null, role: 'org_admin', capabilities: projectCapabilities, installation: snapshot, evidence: ownerEvidence, checkedAt: Number(instCache.checked_at ?? 0) });
        }
        for (const repo of knownRepos) {
          const repoId = String(repo.repository_id), rc = repoCaches.get(repoId);
          if (rc && Number(rc.in_installation) === 0) continue;
          desired.push({ id: `github:${principal}:${ref}:${repoId}`, tenant, project: repoId, role: 'project_admin', capabilities: projectCapabilities, installation: snapshot, evidence: ownerEvidence, checkedAt: Math.max(Number(instCache.checked_at ?? 0), Number(rc?.checked_at ?? 0)) });
        }
        continue;
      }

      const userCollabs = new Map<string, Row>(
        this.store.all('SELECT repository_id,login,role FROM github_repository_collaborators WHERE installation_ref=? AND github_user_id=?', ref, userId)
          .map(r => [String(r.repository_id), r]),
      );

      const singleUser = [{ id: userId, login: String(identity.display_name) }];
      for (const repo of knownRepos) {
        const repoId = String(repo.repository_id), rc = repoCaches.get(repoId);
        const neededTier = repo.started ? 'full' : 'admin';
        const repoHardError = rc?.last_error && !isTransientGitHubError(String(rc.last_error)) ? String(rc.last_error) : null;
        const userRolePending = Boolean(rc && rc.synced_at !== null && !repoHardError && repositoryNeedsBoundUserRole(this.store, ref, repoId, rc, singleUser));
        const repoReady = Boolean(rc && rc.synced_at !== null && (rc.tier === 'full' || neededTier === 'admin') && !repoHardError && !userRolePending);
        if (!repoReady) {
          const code = repoHardError ? `repository_permission:${repoHardError}` : (rc?.last_error ? String(rc.last_error) : 'repository_member_cache_pending');
          uncertainRepos.set(`${ref}:${repoId}`, code);
          addIssue(ref, code);
          if (rc?.last_error && isTransientGitHubError(String(rc.last_error))) {
            preservedRepos.add(`${ref}:${repoId}`);
            if (rc.last_error === 'github_rate_limited') rateLimitedSeen = true;
          }
          continue;
        }
        if (rc?.last_error && isTransientGitHubError(String(rc.last_error))) {
          addIssue(ref, String(rc.last_error));
          if (rc.last_error === 'github_rate_limited') rateLimitedSeen = true;
        }
        if (rc && Number(rc.in_installation) === 0) continue;
        const collab = userCollabs.get(repoId);
        if (!collab) continue;
        const role = String(collab.role);
        if (role === 'ambiguous_public_read') {
          uncertainRepos.set(`${ref}:${repoId}`, 'membership_unreadable');
          addIssue(ref, 'membership_unreadable');
          continue;
        }
        if (role === 'none' || !repo.started && role !== 'admin') continue;
        if (collab.login && !detectedLogin) detectedLogin = String(collab.login);
        const grant = role === 'admin' ? { role: 'project_admin', capabilities: projectCapabilities, evidence: 'repository_admin' }
          : role === 'write' || role === 'maintain' ? { role: 'project_member', capabilities: memberCapabilities, evidence: 'repository_write' }
          : role === 'read' || role === 'triage' ? { role: 'project_reader', capabilities: readerCapabilities, evidence: 'repository_read' } : null;
        if (grant) desired.push({ id: `github:${principal}:${ref}:${repoId}`, tenant, project: repoId, ...grant, installation: snapshot, checkedAt: Number(rc?.checked_at ?? 0) });
      }
    }

    identityProjection(this.store);
    const before = activeScopes(this.store, principal);
    const desiredIds = new Set(desired.map(item => item.id));
    const snapshotSet = new Set(snapshots.map(s => String(s.ref)));

    for (const grant of this.store.all("SELECT id,installation_ref,project_id,evidence,expires_at FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", principal)) {
      if (desiredIds.has(String(grant.id))) continue;
      const ref = String(grant.installation_ref || '');
      const missingSnapshot = ref && !snapshotSet.has(ref);
      const repoKey = grant.project_id ? `${ref}:${grant.project_id}` : null;
      const ownersUnreadableKeep = !uncertainInstallations.has(ref) &&
        diagnosticIssues.some(item => item.installation === ref && item.code === 'membership_unreadable') &&
        grant.evidence === 'organization_owner';
      if (missingSnapshot || uncertainInstallations.has(ref) || (repoKey !== null && uncertainRepos.has(repoKey)) || ownersUnreadableKeep) {
        const preserved = preservedInstallations.has(ref) || (repoKey !== null && preservedRepos.has(repoKey)) || missingSnapshot;
        if (!preserved && (grant.expires_at === null || grant.expires_at > now)) {
          this.store.run('UPDATE scoped_grants SET expires_at=? WHERE id=?', now, grant.id);
        }
      } else {
        this.store.run('UPDATE scoped_grants SET revoked_at=? WHERE id=?', now, grant.id);
      }
    }

    // Only write new active grants when the identity itself is verified; an identity waiting on re-verification keeps
    // existing rows until `/user` is checked again, while confirmed revocations above still take effect immediately.
    if (!identityLevelPending) {
      const transientSeen = rateLimitedSeen || diagnosticIssues.some(item => isTransientGitHubError(item.code));
      for (const item of desired) {
        const existing = this.store.get('SELECT verified_at,expires_at,revoked_at FROM scoped_grants WHERE id=?', item.id);
        const keepPendingExpiry = !options.fromUserCheck && existing && existing.revoked_at === null &&
          existing.expires_at !== null && Number(existing.expires_at) <= now &&
          (Number(existing.expires_at) === 0 || item.checkedAt < Number(existing.expires_at));
        const nextExpiresAt = keepPendingExpiry ? Number(existing.expires_at) : null;
        const nextGrantVerifiedAt = existing && existing.revoked_at === null && transientSeen
          ? Number(existing.verified_at)
          : (options.fromUserCheck ? (options.verifiedAt ?? now) : (item.checkedAt || now));
        this.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at,expires_at,installation_ref,installation_revision)
          VALUES(?,?,?,?,?,?,?,'github_derived','current_github',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET verified_at=excluded.verified_at,
          tenant_id=excluded.tenant_id,project_id=excluded.project_id,scope=excluded.scope,role=excluded.role,capabilities=excluded.capabilities,
          expires_at=excluded.expires_at,revoked_at=NULL,evidence=excluded.evidence,installation_revision=excluded.installation_revision`,
          item.id, principal, item.tenant, item.project, item.project ? 'project' : 'tenant', item.role,
          JSON.stringify(item.capabilities), item.evidence, nextGrantVerifiedAt, nextExpiresAt, item.installation.ref, item.installation.revision);
      }
      const hasPendingDerivedGrant = !!this.store.get(
        "SELECT 1 FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at<=? LIMIT 1",
        principal, now,
      );
      const hasHardBlockingIssue = diagnosticIssues.some(item => !isTransientGitHubError(item.code) && item.code !== 'membership_unreadable');
      const nextStatus = (hasHardBlockingIssue || hasPendingDerivedGrant) && !desired.length ? 'pending_verification' : 'active';
      const nextVerifiedAt = options.fromUserCheck ? (rateLimitedSeen ? identity.verified_at : (options.verifiedAt ?? now)) : identity.verified_at;
      this.store.run('UPDATE external_identities SET display_name=?,status=?,verified_at=?,verification_issues=? WHERE id=?',
        options.login ?? detectedLogin ?? String(identity.display_name), nextStatus, nextVerifiedAt, issues(diagnosticIssues), identity.id);
    }

    invalidateIfLost(this.store, principal, before, 'github.permissions_changed');
  }

  private dropDerived(principal: string): void {
    if (!this.store.get("SELECT 1 FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL LIMIT 1", principal)) return;
    this.store.transaction(() => {
      const before = activeScopes(this.store, principal);
      this.store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", Date.now(), principal);
      invalidateIfLost(this.store, principal, before, 'github.verification_exempt');
    });
  }

  async reverify(principal: string): Promise<string | undefined> {
    const status = () => this.store.get("SELECT status FROM external_identities WHERE principal_id=? AND provider='github' ORDER BY verified_at DESC", principal)?.status as string | undefined;
    // Never sent to GitHub: the check only drops leftover derived grants.
    if (verificationExempt(this.store, principal)) { this.dropDerived(principal); return status(); }
    this.store.run("UPDATE external_identities SET status='active' WHERE principal_id=? AND provider='github' AND status='pending_verification' AND credentials IS NOT NULL", principal);
    const identity = this.store.get("SELECT * FROM external_identities WHERE principal_id=? AND provider='github' AND status='active' AND credentials IS NOT NULL", principal);
    if (!identity) return status();

    // Check the person's own OAuth `/user` credential first, then single-flight refresh the installation/repository member caches (#1158).
    let login = String(identity.display_name);
    try {
      const token = await this.token(identity);
      const current = await this.api(token, '/user');
      if (numericId(current.id) !== identity.external_actor || typeof current.login !== 'string' || !current.login) {
        return fail(403, 'github_identity_mismatch');
      }
      login = current.login;
    } catch (error) {
      const http = error instanceof HttpError ? error : new HttpError(502, 'github_verification_unavailable');
      this.store.transaction(() => {
        if (!this.store.get("SELECT 1 FROM external_identities WHERE id=? AND credentials IS NOT NULL AND status<>'revoked'", identity.id)) return;
        if (http.code === 'github_rate_limited') {
          this.store.run('UPDATE external_identities SET verification_issues=? WHERE id=?', issues([{ installation: null, code: http.code }]), identity.id);
          return;
        }
        const before = activeScopes(this.store, principal), failed = Date.now();
        this.store.run("UPDATE external_identities SET status='pending_verification',verification_issues=? WHERE id=?", issues([{ installation: null, code: http.code }]), identity.id);
        this.store.run("UPDATE scoped_grants SET expires_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)", failed, principal, failed);
        invalidateIfLost(this.store, principal, before, 'github.verification_pending');
      });
      if (http.code === 'github_reauthorization_required' || http.code === 'github_verification_unavailable' ||
        http.code === 'github_oauth_unavailable' || http.code === 'github_oauth_failed') throw http;
      return status();
    }

    await this.syncMemberCache({ checkAll: true, bypassBackoff: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.commitPrincipalReconcile(principal, { login, verifiedAt: Date.now(), fromUserCheck: true }) === 'done') break;
    }
    return status();
  }

  async verifyInstallation(sessionRef: string, ref: InstallationRef): Promise<VerifiedInstallationAccess | null> {
    if (ref.github_host !== 'github.com') return null;
    installationRef(ref);
    if (sessionRef.includes('.')) {
      try { sessionRef = String(this.store.secrets.open(sessionRef, 'installation-identity-session').session_ref); }
      catch { return null; }
    }
    const actor = resolveActor(this.store, sessionRef);
    const identity = this.store.get("SELECT * FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", actor.principal_id);
    if (!identity?.credentials) return null;
    try {
      const token = await this.token(identity), user = await this.api(token, '/user');
      const userId = String(identity.external_actor);
      if (numericId(user.id) !== userId || typeof user.login !== 'string') return null;

      const access = await new GitHubPermissions(this.store, this.config.apiUrl, this.limited).readInstallationAccess(ref, userId, user.login);
      const targetId = access.target_id;
      const owner = access.owner;
      const repositoryIds = access.repository_ids;
      const canManage = access.owner || access.admin_ids.length > 0;

      if (actor.tenant_id && actor.tenant_id !== tenantId(targetId) || !owner && !repositoryIds.length) return null;
      // The proof must still belong to this session's identity and organization. A revision raised meanwhile for some
      // other loss does not void it (#521); a revoked binding or ended session does.
      const current = resolveActor(this.store, sessionRef);
      if (current.principal_id !== actor.principal_id || current.tenant_id !== actor.tenant_id ||
        !this.store.get("SELECT 1 FROM external_identities WHERE id=? AND status='active'", identity.id)) return null;
      return {
        github_user_id: userId,
        target_id: targetId,
        repository_ids: owner ? null : repositoryIds,
        can_manage: canManage,
        authorization_revision: String(current.authorization_revision),
      };
    } catch { return null; }
  }
}

export { markInstallationMemberCacheDirty, markRepositoryMemberCacheDirty };
