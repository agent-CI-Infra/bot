import type { Store } from '../storage/database.js';
import { superAdmin, type Actor } from '../app/auth.js';
import { fail, fields, text, type Json } from '../core/security.js';
import { invalidate } from './authorization.js';
import { GitHubIdentity, type GitHubOAuthConfig } from './github.js';

const key = 'identity.github_login';
interface Configuration { enabled: boolean; client_id: string; client_secret: string; admin_origin: string; account_id: string | null }
interface Options {
  environment?: () => GitHubOAuthConfig | undefined; identity?: GitHubIdentity;
  defaultOrigin?: string; apiUrl?: string; webUrl?: string;
}
export function loginOrigin(value: unknown): string {
  let url: URL;
  try { url = new URL(text(value, 2048)); } catch { return fail(400, 'invalid_admin_origin'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return fail(400, 'invalid_admin_origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return fail(400, 'github_login_https_required');
  return url.origin;
}

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
  private selectedApp(): { id: string | null; client_id: string; client_secret: string } {
    const selected = this.store.get("SELECT value FROM settings WHERE key='onboarding.app'");
    const id = selected ? JSON.parse(selected.value)?.account_id : null;
    const row = id && this.store.get("SELECT credentials FROM accounts WHERE id=? AND type='github_app'", id);
    const credentials = row ? this.store.secrets.open(row.credentials, `account:${id}`) : {};
    return { id: row ? id : null, client_id: String(credentials.oauth_client_id || ''), client_secret: String(credentials.oauth_client_secret || '') };
  }
  private configuration(origin = ''): { config: Configuration; previous: Configuration; source: string } {
    const stored = this.stored(), environment = stored ? undefined : this.environment(), app = this.selectedApp();
    const previous = stored?.config || { enabled: !!environment, client_id: environment?.clientId || app.client_id,
      client_secret: environment?.clientSecret || app.client_secret, account_id: app.id,
      admin_origin: environment ? new URL(environment.redirectUri).origin : this.options.defaultOrigin || origin };
    // Selecting an App prepares a draft; the active login changes only when an administrator saves it.
    if (app.id && (stored ? previous.account_id !== app.id : environment && environment.clientId !== app.client_id))
      return { previous, source: 'app', config: { ...previous, enabled: false, account_id: app.id,
        client_id: app.client_id, client_secret: app.client_secret } };
    return { config: previous, previous, source: stored ? 'wizard' : environment ? 'deployment' : 'app' };
  }
  get adminOrigin(): string | undefined { return this.stored()?.config.admin_origin || this.options.defaultOrigin || (this.environment() ? new URL(this.environment()!.redirectUri).origin : undefined); }
  get identity(): GitHubIdentity | undefined {
    const stored = this.stored();
    if (!stored) {
      if (this.options.identity) return this.options.identity;
      const config = this.environment(); if (!config) return undefined;
      if (!this.cached || this.cached.revision !== 'environment') this.cached = { revision: 'environment', identity: new GitHubIdentity(this.store, config, () => {
        if (this.store.get('SELECT 1 FROM settings WHERE key=?', key)) fail(409, 'github_login_configuration_changed');
      }) };
      return this.cached.identity;
    }
    if (!stored.config.enabled) return undefined;
    if (this.cached?.revision !== stored.value) {
      const c = stored.config;
      this.cached = { revision: stored.value, identity: new GitHubIdentity(this.store, {
        clientId: c.client_id, clientSecret: c.client_secret, redirectUri: c.admin_origin + '/auth/github/callback',
        apiUrl: this.options.apiUrl || this.options.identity?.config.apiUrl,
        webUrl: this.options.webUrl || this.options.identity?.config.webUrl,
      }, () => {
        if (this.store.get('SELECT value FROM settings WHERE key=?', key)?.value !== stored.value) fail(409, 'github_login_configuration_changed');
      }) };
    }
    return this.cached.identity;
  }
  view(origin: string): Json {
    const { config, source } = this.configuration(origin);
    return { enabled: config.enabled, client_id: config.client_id, secret_configured: !!config.client_secret,
      admin_origin: config.admin_origin, callback_url: config.admin_origin ? config.admin_origin + '/auth/github/callback' : '',
      account_id: config.account_id, source };
  }
  update(user: Actor, input: Json, origin: string): Json {
    superAdmin(user);
    fields(input, ['enabled', 'client_id', 'client_secret', 'admin_origin', 'revoke_secret']);
    if (typeof input.enabled !== 'boolean' || input.revoke_secret !== undefined && typeof input.revoke_secret !== 'boolean') return fail(400, 'invalid_github_login_configuration');
    const { config: draft, previous: old } = this.configuration(origin), app = this.selectedApp();
    const id = input.client_id === undefined ? draft.client_id : typeof input.client_id === 'string' ? input.client_id.trim() : fail(400, 'invalid_github_client_id');
    if (id && !/^[a-zA-Z0-9._-]{1,200}$/.test(id)) return fail(400, 'invalid_github_client_id');
    if (draft.account_id !== old.account_id && draft.client_id && id !== draft.client_id) return fail(409, 'github_login_app_changed');
    if (input.client_secret !== undefined && (typeof input.client_secret !== 'string' || input.client_secret.length > 32768)) return fail(400, 'invalid_github_client_secret');
    const supplied = typeof input.client_secret === 'string' ? input.client_secret.trim() : '';
    if (input.revoke_secret && supplied) return fail(400, 'conflicting_credentials');
    const secret = input.revoke_secret ? '' : supplied || (id === draft.client_id ? draft.client_secret : id === app.client_id ? app.client_secret : '');
    const config: Configuration = { enabled: input.enabled, client_id: id, client_secret: secret, account_id: app.id,
      admin_origin: loginOrigin(input.admin_origin === undefined ? old.admin_origin || origin : input.admin_origin) };
    if (config.enabled && (!id || !secret)) return fail(400, !id ? 'github_client_id_required' : 'github_login_secret_required');
    this.store.transaction(() => {
      this.store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, this.store.secrets.seal(config, key));
      if (input.revoke_secret) for (const accountId of new Set([old.account_id, app.id].filter(Boolean))) {
        const account = this.store.get('SELECT credentials FROM accounts WHERE id=?', accountId!);
        if (!account) continue;
        const credentials = this.store.secrets.open(account.credentials, `account:${accountId}`);
        delete credentials.oauth_client_secret;
        this.store.run('UPDATE accounts SET credentials=? WHERE id=?', this.store.secrets.seal(credentials, `account:${accountId}`), accountId!);
      }
      // Neither outstanding nor in-flight callbacks may commit under a newly selected App.
      this.store.run('DELETE FROM github_oauth_states');
      const credentialsChanged = old.client_id !== id || !config.enabled;
      for (const identity of this.store.all("SELECT id,principal_id FROM external_identities WHERE provider='github' AND status<>'revoked'")) {
        if (credentialsChanged) {
          this.store.run("UPDATE external_identities SET credentials=NULL,status='pending_verification' WHERE id=?", identity.id);
          this.store.run('DELETE FROM sessions WHERE identity_id=?', identity.id);
        }
        this.store.run("UPDATE scoped_grants SET expires_at=0 WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL", identity.principal_id);
        invalidate(this.store, identity.principal_id, 'github.login_configuration_changed');
      }
      this.store.audit(user.id, config.enabled ? 'github_login.configured' : 'github_login.disabled', 'system');
    });
    return this.view(config.admin_origin);
  }
}
