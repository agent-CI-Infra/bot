import { createPrivateKey } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Store } from '../storage/database.js';
import { type Actor, superAdmin } from '../app/auth.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';
import { publicOrigin, probeGet } from './public-url.js';
import { appJwt, appPermissions } from '../github/client.js';
import { defaults } from '../rules/service.js';
import { installationAccount, accountInstallUrl } from './installation-target.js';
import { tunnelToken } from './tunnel-token.js';

interface Options { tunnelFile?: string; tunnelMetrics?: string; githubUrl?: string; fetcher?: typeof fetch; probe?: typeof probeGet; }
export class Onboarding {
  readonly challenges = new Map<string, { proof: string; until: number }>();
  constructor(readonly store: Store, readonly options: Options = {}) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS app_manifest_states(state TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);`);
  }
  saved(key: string): any { const value = this.store.get('SELECT value FROM settings WHERE key=?', 'onboarding.' + key)?.value; return value ? JSON.parse(value) : null; }
  save(key: string, value: unknown) { this.store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'onboarding.' + key, JSON.stringify(value)); }
  probe(nonce: string, listener: string): Json {
    for (const [id, value] of this.challenges) if (value.until < Date.now()) this.challenges.delete(id);
    const value = this.challenges.get(nonce);
    if (!value) return fail(404, 'probe_expired');
    return { listener, proof: listener === 'webhook' ? value.proof : 'management_listener' };
  }
  async check(origin: string) {
    const nonce = randomId(), proof = randomId(); this.challenges.set(nonce, { proof, until: Date.now() + 60000 });
    try {
      const get = this.options.probe || probeGet, result = await get(origin + '/.well-known/bot-webhook-probe?nonce=' + nonce);
      let value: any; try { value = JSON.parse(result.body); } catch { return fail(400, 'webhook_probe_failed'); }
      if (result.status !== 200 || value.listener !== 'webhook' || value.proof !== proof) return fail(400, value.listener === 'admin' ? 'management_port_exposed' : 'webhook_probe_failed');
      // Also reject split routing that sends the probe to webhook but the console/API to admin.
      for (const path of ['/', '/api/setup', '/app.js']) if ((await get(origin + path)).status !== 404) return fail(400, 'management_or_other_service_exposed');
    } catch (error) { if ((error as any)?.status) throw error; return fail(400, 'public_webhook_unreachable'); }
    finally { this.challenges.delete(nonce); }
    this.save('public', { origin, checked_at: new Date().toISOString() }); return this.saved('public');
  }
  async tunnelStatus(): Promise<Json> {
    const result: Json = { available: !!this.options.tunnelFile, token_configured: !!this.saved('tunnel'), origin: 'http://webhook:8791', state: 'waiting_token', routes: [] };
    if (!result.token_configured || !this.options.tunnelMetrics) return result;
    result.state = 'not_running';
    try {
      const fetcher = this.options.fetcher || fetch, base = this.options.tunnelMetrics.replace(/\/$/, '');
      result.state = (await fetcher(base + '/ready', { signal: AbortSignal.timeout(3000) })).ok ? 'connected' : 'connecting';
      const config: any = await (await fetcher(base + '/config', { signal: AbortSignal.timeout(3000) })).json();
      result.routes = (config.config?.ingress || []).filter((r: any) => typeof r.hostname === 'string').map((r: any) => ({ hostname: r.hostname, service: r.service, webhook_route: r.service === 'http://webhook:8791' }));
    } catch { /* No token or disconnected tunnel is a visible state, never readiness. */ }
    return result;
  }
  async writeTunnel(value: string | null) {
    if (!this.options.tunnelFile) return fail(503, 'tunnel_service_not_configured');
    const file = this.options.tunnelFile;
    if (value === null) { await unlink(file).catch(() => {}); this.save('tunnel', null); return; }
    const tmp = file + '.' + randomId(); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, value, { mode: 0o600 }); await rename(tmp, file);
    this.save('tunnel', this.store.secrets.seal({ value }, 'onboarding:tunnel'));
  }
  async installationTarget(target:unknown):Promise<Json>{
    const name=installationAccount(target),app=this.saved('app');
    const account=app&&this.store.get("SELECT * FROM accounts WHERE id=? AND type='github_app'",app.account_id);
    if(!account||!app.slug)return fail(409,'github_app_not_selected');
    const get=async(path:string,authorization?:string):Promise<any>=>{
      let response:Response;
      try{response=await(this.options.fetcher||fetch)((this.options.githubUrl||'https://api.github.com')+path,{redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(authorization?{Authorization:authorization}:{})}});}
      catch{return fail(502,'installation_target_lookup_failed');}
      if(response.status===404)return null;
      if(!response.ok)return fail(response.status===403||response.status===429?503:502,'installation_target_lookup_failed');
      try{return await response.json();}catch{return fail(502,'installation_target_lookup_failed');}
    };
    const targetAccount=await get('/users/'+encodeURIComponent(name));
    if(!targetAccount)return fail(404,'installation_target_not_found');
    if(!['Organization','User'].includes(targetAccount.type))return fail(400,'installation_target_not_installable');
    if(!Number.isSafeInteger(targetAccount.id)||targetAccount.id<=0||typeof targetAccount.login!=='string'||installationAccount(targetAccount.login)!==targetAccount.login)return fail(502,'installation_target_lookup_failed');
    let jwt:string;
    try{const secrets=this.store.secrets.open(account.credentials,'account:'+account.id);jwt=appJwt(String(account.app_id),String(secrets.private_key||''));}
    catch{return fail(502,'github_app_check_failed');}
    const organization=targetAccount.type==='Organization';
    const installed=await get((organization?'/orgs/':'/users/')+encodeURIComponent(targetAccount.login)+'/installation','Bearer '+jwt);
    if(installed&&(!Number.isSafeInteger(installed.id)||installed.id<=0||String(installed.account?.id)!==String(targetAccount.id)||String(installed.app_id)!==String(account.app_id)))return fail(502,'installation_target_lookup_failed');
    return {account:{id:String(targetAccount.id),login:targetAccount.login,type:targetAccount.type,html_url:'https://github.com/'+targetAccount.login},installed:!!installed,
      install_url:installed?(organization?`https://github.com/organizations/${encodeURIComponent(targetAccount.login)}/settings/installations/${installed.id}`:`https://github.com/settings/installations/${installed.id}`):accountInstallUrl(app.slug,targetAccount.id)};
  }
  async api(user: Actor, method: string, url: URL, input: Json, adminOrigin: string): Promise<Json | undefined> {
    if (!url.pathname.startsWith('/api/onboarding')) return undefined; superAdmin(user);
    if (method === 'GET' && url.pathname === '/api/onboarding') return { public_address: this.saved('public'), tunnel: await this.tunnelStatus(), app: this.saved('app'), model_id: this.saved('model'), defaults, installation_skipped: !!this.saved('installation_skipped'), complete: !!this.saved('complete') };
    if(method==='POST'&&url.pathname==='/api/onboarding/installation-target'){fields(input,['target']);return this.installationTarget(input.target);}
    if (method === 'POST' && url.pathname === '/api/onboarding/model') {
      fields(input, ['model_id']); const model = this.store.get('SELECT id FROM models WHERE id=? AND repository_id IS NULL AND api_key IS NOT NULL', text(input.model_id));
      if (!model) fail(400, 'shared_model_required'); this.save('model', model!.id); return { model_id: model!.id };
    }
    if (method === 'POST' && url.pathname === '/api/onboarding/use-app') {
      fields(input, ['account_id','update_webhook']); const account = this.store.get("SELECT * FROM accounts WHERE id=? AND type='github_app'", text(input.account_id));
      if (!account) fail(404, 'github_app_not_found');
      const secrets = this.store.secrets.open(account!.credentials, 'account:' + account!.id), jwt = appJwt(account!.app_id, String(secrets.private_key || ''));
      let app: any, installations: any,webhookUrl:string|undefined;
      try {
        const get = async (path: string) => { const r = await (this.options.fetcher || fetch)((this.options.githubUrl || 'https://api.github.com') + path, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/vnd.github+json' } }); if (!r.ok) throw new Error(); return r.json(); };
        app = await get('/app'); installations = await get('/app/installations?per_page=100'); if (!app.slug || !Array.isArray(installations)) throw new Error();
        if(input.update_webhook===true){
          const address=this.saved('public'),endpoint=this.store.get('SELECT id FROM endpoints WHERE account_id=? ORDER BY rowid LIMIT 1',account!.id);
          if(!address?.origin||!endpoint)fail(409,'public_address_not_verified');
          webhookUrl=address.origin+`/hooks/github/${account!.id}/${endpoint!.id}`;
          const r=await(this.options.fetcher||fetch)((this.options.githubUrl||'https://api.github.com')+'/app/hook/config',{method:'PATCH',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json',Accept:'application/vnd.github+json'},body:JSON.stringify({url:webhookUrl,content_type:'json'})});
          if(!r.ok)throw new Error();const confirmed:any=await get('/app/hook/config');if(confirmed.url!==webhookUrl)throw new Error();
        }
      } catch { return fail(502, 'github_app_check_failed'); }
      const value = { account_id: account!.id, app_id: String(app.id), slug: app.slug, installations: installations.length, ...(webhookUrl?{webhook_url:webhookUrl}:{}), install_url: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new` };
      this.save('app', value); this.save('installation_skipped', false); return { app: value };
    }
    if (method === 'POST' && url.pathname === '/api/onboarding/address') {
      fields(input, ['origin']); const result = await this.check(publicOrigin(input.origin)); this.store.audit(user.id, 'onboarding.public_address', result.origin); return { public_address: result };
    }
    if (method === 'POST' && url.pathname === '/api/onboarding/tunnel') {
      fields(input, ['token', 'revoke']);
      if (input.revoke === true) await this.writeTunnel(null);
      else if (typeof input.token === 'string' && input.token.trim()) {
        const token = tunnelToken(text(input.token, 128 * 1024));
        await this.writeTunnel(token);
      }
      this.store.audit(user.id, 'onboarding.tunnel_updated', 'tunnel'); return { tunnel: await this.tunnelStatus() };
    }
    if (method === 'POST' && url.pathname === '/api/onboarding/manifest') {
      fields(input, ['organization', 'name','public']); const org = text(input.organization, 100), name = text(input.name, 100), address = this.saved('public');
      if(input.public!==undefined&&typeof input.public!=='boolean')fail(400,'invalid_app_visibility');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(org)) fail(400, 'invalid_organization');
      if (!address?.origin) fail(409, 'public_address_not_verified');
      const state = randomId(), account = randomId(), endpoint = randomId();
      this.store.run("INSERT INTO app_manifest_states VALUES(?,?,?,?,?,'pending')", state, user.id, account, endpoint, Date.now() + 15 * 60000);
      const manifest = { name, url: address.origin, redirect_url: adminOrigin + '/onboarding/github/callback', public: input.public===true,
        hook_attributes: { url: address.origin + `/hooks/github/${account}/${endpoint}`, active: true },
        default_permissions: appPermissions, default_events: ['issues', 'pull_request', 'issue_comment'] };
      return { manifest, create_url: `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`, expires_in: 900 };
    }
    if (method === 'POST' && url.pathname === '/api/onboarding/installation') { fields(input, ['skip']); if (typeof input.skip !== 'boolean') fail(400, 'invalid_skip'); this.save('installation_skipped', input.skip); return { skipped: input.skip }; }
    if (method === 'POST' && url.pathname === '/api/onboarding/complete') { fields(input, []); this.save('complete', true); this.store.audit(user.id, 'onboarding.completed', 'system'); return { complete: true }; }
    return fail(404, 'not_found');
  }
  async callback(code: string, state: string): Promise<void> {
    if (!/^[a-f0-9]{48}$/.test(state) || !/^[a-zA-Z0-9_\-]{1,200}$/.test(code)) fail(400, 'invalid_manifest_callback');
    const pending = this.store.get("SELECT s.* FROM app_manifest_states s JOIN users u ON u.id=s.user_id WHERE s.state=? AND s.status='pending' AND s.expires_at>? AND u.role='super_admin' AND u.active=1", state, Date.now());
    if (!pending) fail(409, 'manifest_state_invalid_or_used');
    this.store.run("UPDATE app_manifest_states SET status='exchanging' WHERE state=?", state);
    let value: any;
    try {
      // GitHub's manifest-code conversion is deliberately unauthenticated: do not attach a PAT.
      const response = await (this.options.fetcher || fetch)((this.options.githubUrl || 'https://api.github.com') + '/app-manifests/' + code + '/conversions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (!response.ok) throw new Error(); value = await response.json();
      if (!value.id || !value.slug || !value.webhook_secret || createPrivateKey(value.pem).asymmetricKeyType !== 'rsa') throw new Error();
    } catch { this.store.run("UPDATE app_manifest_states SET status='failed' WHERE state=?", state); return fail(502, 'manifest_conversion_failed'); }
    this.store.transaction(() => {
      this.store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', pending!.account_id, value.name || value.slug, 'github_app', String(value.id), this.store.secrets.seal({ private_key: value.pem }, 'account:' + pending!.account_id), new Date().toISOString());
      this.store.run('INSERT INTO endpoints VALUES(?,?,?)', pending!.endpoint_id, pending!.account_id, this.store.secrets.seal({ value: value.webhook_secret }, 'endpoint:' + pending!.endpoint_id));
      this.save('app', { account_id: pending!.account_id, app_id: String(value.id), slug: value.slug, install_url: `https://github.com/apps/${encodeURIComponent(value.slug)}/installations/new` });
      this.store.run("UPDATE app_manifest_states SET status='completed' WHERE state=?", state); this.store.audit(pending!.user_id, 'onboarding.app_created', pending!.account_id);
    });
  }
}
