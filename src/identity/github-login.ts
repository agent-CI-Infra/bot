import type { Store } from '../storage/database.js';
import { superAdmin, type Actor } from '../app/auth.js';
import { fail, fields, text, type Json } from '../core/security.js';
import { activeScopes, invalidateIfLost } from './authorization.js';
import { GitHubIdentity, type GitHubOAuthConfig } from './github.js';
import { loginCallbackPath, verifiedOrigin } from '../onboarding/public-url.js';

const key = 'identity.github_login';
// admin_origin is the origin a configuration was saved for. The live callback follows the single public entry; the saved copy
// only serves a deployment without one (loopback testing) and keeps a console address saved before the single entry writable.
interface Configuration { enabled: boolean; client_id: string; client_secret: string; admin_origin: string; account_id: string | null; application_type?: 'oauth_app' | 'github_app' }
interface Options {
  environment?: () => GitHubOAuthConfig | undefined; identity?: GitHubIdentity;
  /** BOT_PUBLIC_ORIGIN, used until the wizard verifies a public address. */
  defaultOrigin?: string; apiUrl?: string; webUrl?: string;
}
const originOf = (uri: string | undefined) => { try { return uri ? new URL(uri).origin : undefined; } catch { return undefined; } };
export function loginOrigin(value: unknown): string {
  let url: URL;
  try { url = new URL(text(value, 2048)); } catch { return fail(400, 'invalid_admin_origin'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return fail(400, 'invalid_admin_origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return fail(400, 'github_login_https_required');
  return url.origin;
}
const usableOrigin = (value: string) => { try { return loginOrigin(value); } catch { return undefined; } };

/** Wizard configuration overrides deployment defaults without writing files or exposing secrets. */
export class GitHubLogin {
  private environmentRead = false;
  private environmentConfig?: GitHubOAuthConfig;
  private cached?: { revision: string; identity: GitHubIdentity };
  constructor(readonly store: Store, readonly options: Options = {}) {}
  private stored(): { value: string; config: Configuration } | undefined {
    const row = this.store.get('SELECT value FROM settings WHERE key=?', key);
    return row ? { value: row.value, config: this.store.secrets.open(row.value, key) as unknown as Configuration } : undefined;
  }
  private environment(): GitHubOAuthConfig | undefined {
    if (this.options.identity) return this.options.identity.config;
    if (!this.environmentRead) { this.environmentConfig = this.options.environment?.(); this.environmentRead = true; }
    return this.environmentConfig;
  }
  private applicationType(config: Configuration): 'oauth_app' | 'github_app' {
    return config.application_type || (config.account_id || /^Iv/.test(config.client_id) ? 'github_app' : 'oauth_app');
  }
  private configuration(origin = ''): { config: Configuration; source: string } {
    const stored = this.stored(), environment = stored ? undefined : this.environment();
    return { config: stored?.config || { enabled: !!environment, client_id: environment?.clientId || '',
      client_secret: environment?.clientSecret || '', account_id: null,
      application_type: environment?.applicationType || (/^Iv/.test(environment?.clientId || '') ? 'github_app' : 'oauth_app'),
      admin_origin: this.entry || originOf(environment?.redirectUri) || origin }, source: stored ? 'wizard' : environment ? 'deployment' : 'empty' };
  }
  /** The single public entry: the address the wizard verified, else the deployment's BOT_PUBLIC_ORIGIN. */
  get entry(): string | undefined { return verifiedOrigin(this.store) || this.options.defaultOrigin || undefined; }
  /** The origin saved with the wizard configuration; before the single entry it could be a separate console address. */
  get savedOrigin(): string | undefined { return this.stored()?.config.admin_origin || undefined; }
  /** Where GitHub returns users after they authorize, and where links to the console point. */
  get origin(): string | undefined {
    return this.entry || this.savedOrigin || (this.stored() ? undefined : originOf(this.environment()?.redirectUri));
  }
  get identity(): GitHubIdentity | undefined {
    const stored = this.stored();
    if (!stored) {
      if (this.options.identity) return this.options.identity;
      const config = this.environment(); if (!config) return undefined;
      const origin = this.entry || originOf(config.redirectUri), revision = 'environment\n' + origin;
      if (this.cached?.revision !== revision) this.cached = { revision, identity: new GitHubIdentity(this.store, { ...config, applicationType: config.applicationType || (/^Iv/.test(config.clientId) ? 'github_app' : 'oauth_app'), redirectUri: (origin || '') + loginCallbackPath }, () => {
        if (this.store.get('SELECT 1 FROM settings WHERE key=?', key)) fail(409, 'github_login_configuration_changed');
      }) };
      return this.cached.identity;
    }
    if (!stored.config.enabled) return undefined;
    // A newly verified public address moves the callback with it; the saved configuration itself is unchanged.
    const origin = this.entry || stored.config.admin_origin, revision = stored.value + '\n' + origin;
    if (this.cached?.revision !== revision) {
      const c = stored.config;
      this.cached = { revision, identity: new GitHubIdentity(this.store, {
        clientId: c.client_id, clientSecret: c.client_secret, applicationType: this.applicationType(c), redirectUri: origin + loginCallbackPath,
        apiUrl: this.options.apiUrl || this.options.identity?.config.apiUrl,
        webUrl: this.options.webUrl || this.options.identity?.config.webUrl,
      }, () => {
        if (this.store.get('SELECT value FROM settings WHERE key=?', key)?.value !== stored.value) fail(409, 'github_login_configuration_changed');
      }) };
    }
    return this.cached.identity;
  }
  /** requestOrigin is where the administrator reached the console; it only counts when there is no public entry. */
  view(requestOrigin: string): Json {
    const { config, source } = this.configuration(requestOrigin), saved = this.savedOrigin;
    const origin = this.entry || saved || config.admin_origin || requestOrigin;
    return { enabled: config.enabled, client_id: config.client_id, secret_configured: !!config.client_secret,
      origin, origin_source: verifiedOrigin(this.store) ? 'public_address' : this.options.defaultOrigin ? 'deployment' : 'local',
      callback_url: origin ? origin + loginCallbackPath : '',
      // A configuration saved for another address (such as a former separate console domain) still has that callback at GitHub.
      ...(saved && saved !== origin ? { previous_callback_url: saved + loginCallbackPath } : {}),
      account_id: null, application_type: this.applicationType(config), migration_required: config.enabled && this.applicationType(config) === 'github_app', source };
  }
  update(user: Actor, input: Json, requestOrigin: string): Json {
    superAdmin(user);
    fields(input, ['enabled', 'client_id', 'client_secret', 'revoke_secret']);
    if (typeof input.enabled !== 'boolean' || input.revoke_secret !== undefined && typeof input.revoke_secret !== 'boolean') return fail(400, 'invalid_github_login_configuration');
    const { config: old } = this.configuration(requestOrigin);
    const id = input.client_id === undefined ? old.client_id : typeof input.client_id === 'string' ? input.client_id.trim() : fail(400, 'invalid_github_client_id');
    if (id && !/^[a-zA-Z0-9._-]{1,200}$/.test(id)) return fail(400, 'invalid_github_client_id');
    if (input.client_secret !== undefined && (typeof input.client_secret !== 'string' || input.client_secret.length > 32768)) return fail(400, 'invalid_github_client_secret');
    const supplied = typeof input.client_secret === 'string' ? input.client_secret.trim() : '';
    if (input.revoke_secret && supplied) return fail(400, 'conflicting_credentials');
    const secret = input.revoke_secret ? '' : supplied || (id === old.client_id ? old.client_secret : '');
    if (input.enabled && (/^Iv/.test(id) || this.store.all("SELECT id,credentials FROM accounts WHERE type='github_app'").some(row =>
      this.store.secrets.open(row.credentials, `account:${row.id}`).oauth_client_id === id))) return fail(400, 'github_login_oauth_app_required');
    // GitHub login needs an HTTPS (or loopback) callback; saving a disabled configuration never fails on the address.
    const callback = this.entry || requestOrigin;
    const config: Configuration = { enabled: input.enabled, client_id: id, client_secret: secret, account_id: null, application_type: 'oauth_app',
      admin_origin: input.enabled ? loginOrigin(callback) : usableOrigin(callback) || this.savedOrigin || '' };
    if (config.enabled && (!id || !secret)) return fail(400, !id ? 'github_client_id_required' : 'github_login_secret_required');
    this.store.transaction(() => {
      this.store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, this.store.secrets.seal(config, key));
      // Neither outstanding nor in-flight callbacks may commit under a newly configured OAuth App.
      this.store.run('DELETE FROM github_oauth_states');
      const credentialsChanged = old.client_id !== id || this.applicationType(old) !== 'oauth_app' || !config.enabled;
      for (const identity of this.store.all("SELECT id,principal_id FROM external_identities WHERE provider='github' AND status<>'revoked'")) {
        const before = activeScopes(this.store, identity.principal_id);
        if (credentialsChanged) {
          this.store.run("UPDATE external_identities SET credentials=NULL,status='pending_verification' WHERE id=?", identity.id);
          this.store.run('DELETE FROM sessions WHERE identity_id=?', identity.id);
        }
        this.store.run("UPDATE scoped_grants SET expires_at=0 WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", identity.principal_id);
        invalidateIfLost(this.store, identity.principal_id, before, 'github.login_configuration_changed');
      }
      this.store.audit(user.id, config.enabled ? 'github_login.configured' : 'github_login.disabled', 'system');
    });
    return this.view(requestOrigin);
  }
}
