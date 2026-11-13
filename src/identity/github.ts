import { createHash, randomBytes } from 'node:crypto';
import type { Store, Row } from '../storage/database.js';
import { digest, fail, randomId, HttpError, type Json } from '../core/security.js';
import { installationRef, numericId, type InstallationIdentity, type InstallationRef, type VerifiedInstallationAccess } from '../installations/archive.js';
import { resolveActor, invalidate, revision } from './authorization.js';
import { identityProjection, projectCapabilities, tenantId } from './storage.js';
import { GitHubPermissions } from './github-permissions.js';

export interface GitHubOAuthConfig { clientId: string; clientSecret: string; redirectUri: string; apiUrl?: string; webUrl?: string; applicationType?: 'oauth_app' | 'github_app' }
export class GitHubIdentity implements InstallationIdentity {
  private refreshing = new Map<string, Promise<void>>();
  private tokens = new Map<string, Promise<string>>();
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
    if (!response.ok) return fail(response.status === 401 ? 401 : 403, response.status === 401 ? 'github_reauthorization_required' : 'github_permission_pending');
    try { return await response.json() as Json; } catch { return fail(502, 'github_verification_unavailable'); }
  }
  private saveToken(id: string, token: Json): void {
    const now = Date.now();
    this.store.run(`UPDATE external_identities SET credentials=?,expires_at=?,refresh_expires_at=?,status='active',verified_at=? WHERE id=?`,
      this.store.secrets.seal(token, `identity:${id}`), Number.isFinite(Number(token.expires_in)) ? now + Number(token.expires_in) * 1000 : null,
      Number.isFinite(Number(token.refresh_token_expires_in)) ? now + Number(token.refresh_token_expires_in) * 1000 : null, now, id);
  }
  async callback(browser: string, state: string, code: string, sessionRef = ''): Promise<{ principal_id: string; identity_id: string; setup_state: string | null }> {
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
    const login = user.login;
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
        VALUES(?,?,'github','github.com','','',?,?,'active',?)`, id, principal, userId, login, Date.now());
      else this.store.run('UPDATE external_identities SET display_name=? WHERE id=?', login, id);
      this.saveToken(id, token); invalidate(this.store, principal, 'github.authorized'); this.store.audit(principal, 'github.authorized', id);
      return { principal_id: principal, identity_id: id, setup_state: row.setup_state as string | null };
    });
    await this.refresh(result.principal_id); this.assertConfiguration(); return result;
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
  refresh(principal: string): Promise<void> {
    const previous = this.refreshing.get(principal); if (previous) return previous;
    const promise = this.verifyPermissions(principal).finally(() => this.refreshing.delete(principal)); this.refreshing.set(principal, promise); return promise;
  }
  private async verifyPermissions(principal: string): Promise<void> {
    const identity = this.store.get("SELECT * FROM external_identities WHERE principal_id=? AND provider='github' AND status='active'", principal);
    if (!identity?.credentials) return;
    const startRevision = revision(this.store, principal), now = Date.now(); let uncertain = false;
    if (!startRevision) return;
    const desired: { id: string; tenant: string; project: string | null; role: string; installation: Row; evidence: string }[] = [];
    try {
      const token = await this.token(identity), current = await this.api(token, '/user');
      if (numericId(current.id) !== identity.external_actor || typeof current.login !== 'string' || !current.login) return fail(403, 'github_identity_mismatch');
      const permissions = new GitHubPermissions(this.store, this.config.apiUrl);
      for (const snapshot of this.store.all("SELECT * FROM github_installations WHERE github_host='github.com'")) {
        const ref = snapshot.ref;
        if (snapshot.status === 'deleted' || snapshot.status === 'suspended') continue;
        if (snapshot.status !== 'active' || snapshot.scope_pending || snapshot.completeness !== 'complete') { uncertain = true; continue; }
        try {
          const access = await permissions.read({ github_host: snapshot.github_host, app_id: snapshot.app_id, installation_id: snapshot.installation_id },
            { id: identity.external_actor, login: String(current.login) });
          if (access.target_id !== snapshot.target_id || access.repository_selection !== snapshot.repository_selection) { uncertain = true; continue; }
          uncertain ||= access.uncertain;
          const known = this.store.all('SELECT repository_id FROM installation_repositories WHERE installation_ref=? AND present=1', ref).map(r => r.repository_id);
          const evidence = access.owner ? snapshot.target_type === 'User' ? 'personal_owner' : 'organization_owner' : 'repository_admin';
          const tenant = tenantId(snapshot.target_id);
          if (access.owner && snapshot.repository_selection === 'all' && snapshot.target_type === 'Organization' && known.every(id => access.repository_ids.includes(id)))
            desired.push({ id: `github:${principal}:${ref}:tenant`, tenant, project: null, role: 'org_admin', installation: snapshot, evidence });
          for (const id of known) if (access.admin_ids.includes(id))
            desired.push({ id: `github:${principal}:${ref}:${id}`, tenant, project: id, role: 'project_admin', installation: snapshot, evidence });
        } catch { uncertain = true; }
      }
      this.store.transaction(() => {
        this.assertConfiguration();
        if (revision(this.store, principal) !== startRevision || !this.store.get("SELECT 1 FROM external_identities WHERE id=? AND status='active'", identity.id)) return fail(409, 'authorization_changed');
        for (const item of desired) if (this.store.get('SELECT revision FROM github_installations WHERE ref=?', item.installation.ref)?.revision !== item.installation.revision) return fail(409, 'authorization_changed');
        identityProjection(this.store);
        const old = this.store.all("SELECT id FROM scoped_grants WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", principal).map(g => g.id).sort();
        this.store.run(`UPDATE scoped_grants SET ${uncertain ? 'expires_at' : 'revoked_at'}=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL`, now, principal);
        for (const item of desired) this.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at,expires_at,installation_ref,installation_revision)
          VALUES(?,?,?,?,?,?,?,'github_derived','current_github',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET verified_at=excluded.verified_at,
          tenant_id=excluded.tenant_id,project_id=excluded.project_id,scope=excluded.scope,role=excluded.role,capabilities=excluded.capabilities,
          expires_at=excluded.expires_at,revoked_at=NULL,evidence=excluded.evidence,installation_revision=excluded.installation_revision`, item.id, principal, item.tenant,
          item.project, item.project ? 'project' : 'tenant', item.role, JSON.stringify(projectCapabilities), item.evidence, now, now + 5 * 60_000, item.installation.ref, item.installation.revision);
        this.store.run('UPDATE external_identities SET display_name=?,status=?,verified_at=? WHERE id=?', String(current.login), uncertain && !desired.length ? 'pending_verification' : 'active', now, identity.id);
        if (JSON.stringify(old) !== JSON.stringify(desired.map(g => g.id).sort())) invalidate(this.store, principal, 'github.permissions_changed');
      });
    } catch (error) {
      // A transport/SSO failure is uncertainty, never evidence that someone left an organization.
      this.store.transaction(() => {
        if (revision(this.store, principal) !== startRevision || !this.store.get("SELECT 1 FROM external_identities WHERE id=? AND status='active'", identity.id)) return;
        this.store.run("UPDATE external_identities SET status='pending_verification' WHERE id=?", identity.id);
        this.store.run("UPDATE scoped_grants SET expires_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", Date.now(), principal);
        invalidate(this.store, principal, 'github.verification_pending');
      });
    }
  }
  async reverify(principal: string): Promise<void> {
    this.store.run("UPDATE external_identities SET status='active' WHERE principal_id=? AND provider='github' AND status='pending_verification' AND credentials IS NOT NULL", principal);
    const identity = this.store.get("SELECT * FROM external_identities WHERE principal_id=? AND provider='github' AND status='active' AND credentials IS NOT NULL", principal);
    // Login and the minute job still call refresh(), which records pending state and does not fail the caller.
    // The user-facing button must hear when GitHub requires a new authorization or did not answer.
    let surface: HttpError | undefined;
    if (identity) {
      try {
        const token = await this.token(identity);
        await this.api(token, '/user');
      } catch (error) {
        const http = error instanceof HttpError ? error : new HttpError(502, 'github_verification_unavailable');
        // 403 permission-pending stays a silent pending state: the person can retry, and existing
        // callers of reverify() still observe the recorded status without catching.
        if (http.code === 'github_reauthorization_required' || http.code === 'github_verification_unavailable' ||
          http.code === 'github_oauth_unavailable' || http.code === 'github_oauth_failed') surface = http;
      }
    }
    await this.refresh(principal);
    if (surface) throw surface;
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
      if (numericId(user.id) !== identity.external_actor || typeof user.login !== 'string') return null;
      const access = await new GitHubPermissions(this.store, this.config.apiUrl).read(ref, { id: identity.external_actor, login: user.login });
      if (actor.tenant_id && actor.tenant_id !== tenantId(access.target_id) || !access.owner && !access.repository_ids.length) return null;
      const current = resolveActor(this.store, sessionRef);
      if (current.authorization_revision !== actor.authorization_revision) return null;
      return { github_user_id: identity.external_actor, target_id: access.target_id, repository_ids: access.owner ? null : access.repository_ids,
        can_manage: access.owner || access.admin_ids.length > 0, authorization_revision: String(current.authorization_revision) };
    } catch { return null; }
  }
}
